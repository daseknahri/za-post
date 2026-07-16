'use strict';
// COMMENT RESCUE — place orphaned link-comments using a HEALTHY account that is a member of the group.
// When a post goes LIVE but its own account couldn't add the first comment (a comment rate-limit, or a
// transient feed miss), that post is queued (pending-comments.json). Here a different, healthy account
// (preferably a reserve) opens the post and drops the comment, so a post is NEVER left without its link.
//
// It reuses the worker's addFirstComment, which: self-navigates (the post's permalink → group-feed
// fallback), is wrong-post-safe (caption/post-id checked, never guesses), and returns the same outcome
// vocabulary used below. Held-in-spam posts are NOT here — those go to the moderator-approval queue,
// because a non-public post can't be commented by ANY account.
const { launchStealth, viewportFor, applyProxyGeo } = require('../lib/browser'); // ONE hardened launch path (real Chrome + no automation flag + stealth)
const store = require('../lib/store');
const { chromiumPath } = require('../lib/chromium');
const { addFirstComment, killChromiumForProfile, applyPace, withFloor, antiSpamFloors, parseProxy, commentFailureDecision, commentOutcomeClass } = require('./worker');
let proxyChain = null; try { proxyChain = require('proxy-chain'); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * Math.max(0, b - a + 1));

// o: { account, tasks, settings, hidden, log, shouldStop, onResult(task, outcome) }
//   outcome: 'done' | 'failed' | 'skipped' | 'notfound' | 'blocked' | 'error'
// Returns { placed, failed, blocked, needsLogin }.
async function runRescue(o) {
  const { account, tasks, settings: rawSettings = {}, useProxies = false, proxies = [], log } = o;
  const settings = applyPace(rawSettings, account && account.pace); // honor the rescuer's per-account pace (safe/normal/fast/turbo/instant) for its comment dwells + gaps
  const shouldStop = o.shouldStop || (() => false);
  const isPaused = o.isPaused || (() => false);
  const waitIfPaused = o.waitIfPaused || (async () => {});
  const hidden = o.hidden !== false; // default hidden, mirrors the worker
  const name = account.name;
  const out = { placed: 0, failed: 0, blocked: false, needsLogin: false, rlKind: null }; // rlKind: WHICH wall — 'account' (FB blocked the whole account: the serious one) vs 'comment' (commenting only). Collapsing them into `blocked` alone made the orchestrator rest an ACCOUNT-level block on the MILD comment ladder and re-launch it into the same wall — ban-escalation.
  // Rescue had NO consecutive-failure breaker. A rescuer whose comments never land (silently dropped / no comment box /
  // shadow-suppressed — i.e. anything short of an explicitly DETECTED wall) walked its ENTIRE task list, burning one of
  // every orphan post's 3 attempts per cycle. Three such cycles and every one of those posts is TERMINALLY failed —
  // permanently abandoned, live without its link — because one broken rescuer spent everyone else's retries. Same shape
  // as the poster-side report ("keeps posting, never comments"), and it destroys the rescue queue rather than just
  // wasting time. Reuses the poster's helpers so the two can never drift apart.
  let consecFails = 0, anyLanded = false;
  // R3: persist the outcome and CONFIRM it reached disk before moving on. onResult (markResult) now returns the
  // store.updateComments promise → { ok }. A landed 'done' write that fails (disk busy) is RETRIED (idempotent: the
  // mutator flips exactly one matching pending record), so a transient lock can't leave the record 'pending' → a
  // next-cycle re-dispatch → a DOUBLE-COMMENT. Non-'done' outcomes are awaited but NOT retried (they touch the
  // moderation reopenCount, which must not be double-incremented).
  const record = async (task, outcome) => {
    if (!o.onResult) return;
    for (let a = 0; a < 3; a++) {
      let r; try { r = await o.onResult(task, outcome); } catch { r = null; }
      if (!r || r.ok !== false) return; // persisted (or an old-style void return) → done
      if (outcome !== 'done') return; // only the landed 'done' write is safe to retry
      log(`⚠️ [rescue:${name}] could not persist 'done' for a "${task.groupName || task.gid}" comment (disk busy) — retry ${a + 1}/3`);
      await sleep(400 + a * 400);
    }
    log(`❌ [rescue:${name}] FAILED to persist 'done' after retries — record stays pending; a next-cycle re-dispatch may re-place it. Fix disk/permissions.`);
  };
  const PER_TASK_MS = 300000; // per-task hang ceiling (normal nav timeouts are ~90s, so 300s is safe)
  let browser = null, sessionWatchdog = null, anonLocal = null;
  try {
    log(`💬 [rescue:${name}] placing ${tasks.length} orphaned link-comment(s) on live posts…`);
    try { const c = await killChromiumForProfile(store.profileDir(name), log); if (c) await sleep(800); } catch {} // clear a stale lock from a crashed prior session
    // Route the rescuer through a proxy — NEVER place a comment from the operator's real IP (would expose it +
    // bypass the IP-serialization). Use the account's OWN proxy; else, if the global pool is ON, a STABLE pool
    // pick (hash of the name, same as worker.js); else FAIL CLOSED. Authenticated proxies wrapped via proxy-chain
    // (Chrome can't auth SOCKS5 directly), mirroring repost.js. Fail CLOSED on a malformed/missing proxy.
    let proxyArg = '', proxyAuth = null;
    let pstr = (account.proxy && String(account.proxy).trim()) || '';
    if (!pstr && useProxies && proxies && proxies.length) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; pstr = proxies[h % proxies.length]; } // no own proxy → stable shared-pool pick
    if (!pstr && useProxies) { log(`🚫 [rescue:${name}] proxies are ON but this account has no proxy (pool empty) — skipping so it does NOT comment from your real IP (tasks stay pending).`); return out; }
    if (pstr) {
      const pp = parseProxy(pstr);
      if (!pp) { log(`🚫 [rescue:${name}] proxy string is invalid — skipping so it does NOT comment from your real IP (its tasks stay pending).`); return out; }
      if (pp.username && proxyChain) { anonLocal = await proxyChain.anonymizeProxy(pp.upstream).catch(() => null); if (anonLocal) proxyArg = `--proxy-server=${anonLocal}`; else { proxyArg = `--proxy-server=${pp.server}`; proxyAuth = pp; } }
      else { proxyArg = `--proxy-server=${pp.server}`; if (pp.username) proxyAuth = pp; }
    }
    const _vp = viewportFor(name); // per-account viewport — match this account's posting/login browser on the SAME profile (a hardcoded off-pool size + mismatched inner/outer dims is a fingerprint)
    browser = await launchStealth({
      headless: false,
      userDataDir: store.profileDir(name),
      args: ['--mute-audio', `--window-size=${_vp.width},${_vp.height}`,
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // WebRTC IP-leak guard (same as worker.js)
        ...(proxyArg ? [proxyArg] : []), // the rescuer comments through the account's own proxy, not the real IP
        ...(hidden ? ['--window-position=-32000,-32000', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] : [])],
      defaultViewport: _vp,
      protocolTimeout: 90000,
    });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    if (proxyAuth && proxyAuth.username) { try { await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password || '' }); } catch {} } // HTTP-proxy auth fallback when not proxy-chain-wrapped
    await applyProxyGeo(page, account, settings, useProxies, proxies, log); // proxied rescuer must use the account's proxy clock/locale, not the host's
    // beforeunload guard (same as the worker) so navigation never hangs on the native dialog.
    page.on('dialog', async (d) => { try { if (d.type() === 'beforeunload') await d.accept(); else await d.dismiss(); } catch {} });

    // Probe the session — NEVER auto-login. If it's logged out, leave its tasks pending for next cycle.
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2500);
    // Positive session check via the c_user cookie (same as worker.js auth) — robust against a partially-rendered
    // logout page. Default to LOGGED-OUT on error so we skip + retry next cycle rather than waste a browser slot.
    const loggedIn = await page.cookies().then((cks) => (cks || []).some((c) => c.name === 'c_user' && c.value)).catch(() => false);
    if (!loggedIn) { log(`⚠️ [rescue:${name}] not logged in — skipping (its queued comments stay pending)`); out.needsLogin = true; return out; }

    // Session watchdog: a fully-hung session can't occupy the sequential loop indefinitely — force-close past the budget.
    sessionWatchdog = setTimeout(() => { try { log(`💬 [rescue:${name}] session exceeded its time budget — closing the browser`); if (browser) browser.close().catch(() => {}); } catch {} }, tasks.length * PER_TASK_MS + 60000);

    for (let i = 0; i < tasks.length; i++) {
      if (shouldStop()) break;
      const t = tasks[i];
      const label = t.groupName || t.gid;
      try {
        const post = { comment: t.comment || '', caption: t.postCaption || '' };
        // Pass the original POSTER's display name as the expected author — the rescue account is different,
        // but the post was authored by the poster, so the author-gate confirms we comment on the right post
        // (and addFirstComment ignores a non-FB local postId). Fail-closed: it skips if it can't confirm.
        const res = await Promise.race([
          addFirstComment(page, t.gid, post, t.commentImg || null,
            (m) => log(`💬 [rescue:${name}] [${label}] ${m}`),
            t.postPermalink || null, settings, t.postId || null, t.fbDisplayName || '', false, false, true).catch(() => 'error'), // checkExisting=true (last arg): if the ORIGINAL account's comment already landed (mis-reported), skip → never a cross-account DOUBLE-comment. R9: swallow a LATE rejection (after the timeout already won the race) so it can't surface as an unhandledRejection
          new Promise((r) => setTimeout(() => r('timeout'), PER_TASK_MS)), // per-task hang ceiling → treated as failure
        ]);
        // Feed the breaker BEFORE the routing dispatch, so every outcome is classified uniformly. Note the routing
        // below deliberately treats 'unconfirmed'/'not_visible' as PLACED (Enter was pressed → never re-queue → no
        // double-comment); commentOutcomeClass answers the OTHER question ("did a comment become VISIBLE?") and counts
        // 'not_visible' as a loss. Same split as the poster path — do not collapse them.
        { const _k = commentOutcomeClass(res); if (_k === 'landed') { consecFails = 0; anyLanded = true; } else if (_k === 'lost') consecFails++; }
        if (res === 'posted' || res === 'unconfirmed' || res === 'not_visible' || res === 'already_present') {
          out.placed++; await record(t, 'done');
          log(res === 'already_present'
            ? `💬 [rescue:${name}] ✅ link already present on the "${label}" post (original landed after all) — marked done, NOT re-commented (no double)`
            : `💬 [rescue:${name}] ✅ link-comment placed on a "${label}" post (${res})`);
        } else if (res === 'blocked_account_landed' || res === 'blocked_comment_landed') {
          // The rescuer's comment LANDED, but Facebook then walled the rescuer on the next action. Mark THIS task
          // DONE (never re-attempt a landed comment = no double-comment) AND stop the rescuer.
          out.placed++; await record(t, 'done'); out.blocked = true; out.rlKind = (res === 'blocked_account_landed') ? 'account' : 'comment'; // carry the KIND: an ACCOUNT-level block is the serious one (mult 3) and must not rest on the mild COMMENT ladder
          log(`💬 [rescue:${name}] ✅ placed, then this rescuer hit a rate-limit — stopping it; remaining comments stay pending for next cycle`);
          break;
        } else if (res === 'blocked_account' || res === 'blocked_comment') {
          out.blocked = true; out.rlKind = (res === 'blocked_account') ? 'account' : 'comment'; await record(t, 'blocked');
          log(`💬 [rescue:${name}] ⛔ this rescuer hit a rate-limit — stopping it; remaining comments stay pending for next cycle`);
          break; // never keep hammering with a blocked rescuer
        } else if (res === 'blocked_login' || res === 'blocked_checkpoint') {
          // The rescuer's SESSION died mid-run (logged out / checkpoint) — the failure is the rescuer's, NOT the post's.
          // Do NOT record() (that would burn one of this post's 3 attempts on the dead session); leave the comment
          // 'pending' with attempts UNCHANGED. Flag needsLogin so the orchestrator _markLoggedOut's the account (2880)
          // and STOP immediately — driving a logged-out browser through the remaining tasks just consumes attempts and
          // never flags the logout. Mirrors the poster path, which classifies a login wall as needs_login and stops.
          out.needsLogin = true;
          log(`💬 [rescue:${name}] 🔒 rescuer is logged out / checkpointed — stopping it and flagging for re-login; remaining comments stay pending`);
          break;
        } else {
          out.failed++; await record(t, res);
          log(`💬 [rescue:${name}] ⚠️ could not place the comment on a "${label}" post (${res})`);
          // R9: a per-task timeout means addFirstComment is still HUNG on THIS shared page. Advancing to the next task
          // would let that orphaned call keep driving the page (→ its Enter lands on the NEXT task's post = wrong-post /
          // double-comment). Stop this rescuer instead; the remaining comments stay pending for a fresh rescuer next cycle.
          if (res === 'timeout') { log(`💬 [rescue:${name}] ⏱️ a task exceeded ${Math.round(PER_TASK_MS / 1000)}s — stopping this rescuer so a hung call can't drive the shared page into the next task (remaining comments retry next cycle)`); break; }
          // BREAKER: stop a rescuer that cannot place comments, BEFORE it spends the rest of the queue's attempts. The
          // remaining tasks keep attempts UNCHANGED and stay pending, so a healthy rescuer (or the next cycle) still
          // gets them — which is the entire point: one broken account must not terminally fail everyone else's posts.
          const _cfd = commentFailureDecision(consecFails, anyLanded);
          if (_cfd) {
            if (_cfd === 'block') { out.blocked = true; out.rlKind = 'comment'; log(`💬 [rescue:${name}] 🛑 3 comment failures in a row and NOT ONE landed — this rescuer cannot place comments (Facebook is suppressing it). Stopping it and resting it; the remaining ${tasks.length - i - 1} comment(s) keep their attempts and go to a healthy account next cycle.`); }
            else log(`💬 [rescue:${name}] ⚠️ 3 comment failures in a row, but it DID land one earlier — treating as transient. Stopping this rescuer; the remaining ${tasks.length - i - 1} comment(s) keep their attempts and retry next cycle.`);
            break;
          }
        }
      } catch (e) { out.failed++; await record(t, 'error'); log(`💬 [rescue:${name}] error on a "${label}" post: ${e.message}`); }
      // Human gap between rescue comments so the rescuer doesn't burst-comment links (its own anti-spam).
      // Interruptible so Stop wakes the rescuer within ~1s instead of after the full (up to 180s) gap.
      if (i < tasks.length - 1 && !shouldStop() && !out.blocked) {
        const lo = Number.isFinite(settings.commentDelayMin) ? settings.commentDelayMin : 60;
        const hi = Number.isFinite(settings.commentDelayMax) ? settings.commentDelayMax : 180;
        const ms = withFloor(rand(Math.min(lo, hi), Math.max(lo, hi)) * 1000, antiSpamFloors(settings).comment); // floor: never burst rescue comments (turbo uses a smaller ~12s floor)
        let waited = 0;
        while (waited < ms && !shouldStop() && !out.blocked) { if (isPaused()) { await waitIfPaused(); continue; } const chunk = Math.min(1000, ms - waited); await sleep(chunk); waited += chunk; }
      }
    }
    log(`💬 [rescue:${name}] done — placed=${out.placed} failed=${out.failed}${out.blocked ? ' (stopped: rate-limited)' : ''}`);
    return out;
  } catch (e) { log(`❌ [rescue:${name}] ${e.message}`); return out; }
  finally { try { if (sessionWatchdog) clearTimeout(sessionWatchdog); } catch {} try { if (browser) await Promise.race([browser.close().catch(() => {}), sleep(8000)]); } catch {} try { const proc = browser && browser.process && browser.process(); if (proc && !proc.killed) proc.kill('SIGKILL'); } catch {} try { if (anonLocal && proxyChain) await Promise.race([proxyChain.closeAnonymizedProxy(anonLocal, true).catch(() => {}), sleep(8000)]); } catch {} }
}

module.exports = { runRescue };
