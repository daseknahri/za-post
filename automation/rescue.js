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
const { addFirstComment, killChromiumForProfile, applyPace, withFloor, antiSpamFloors, parseProxy } = require('./worker');
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
  const out = { placed: 0, failed: 0, blocked: false, needsLogin: false };
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
            t.postPermalink || null, settings, t.postId || null, t.fbDisplayName || ''),
          new Promise((r) => setTimeout(() => r('timeout'), PER_TASK_MS)), // per-task hang ceiling → treated as failure
        ]);
        if (res === 'posted' || res === 'unconfirmed' || res === 'not_visible') {
          out.placed++; o.onResult && o.onResult(t, 'done');
          log(`💬 [rescue:${name}] ✅ link-comment placed on a "${label}" post (${res})`);
        } else if (res === 'blocked_account_landed' || res === 'blocked_comment_landed') {
          // The rescuer's comment LANDED, but Facebook then walled the rescuer on the next action. Mark THIS task
          // DONE (never re-attempt a landed comment = no double-comment) AND stop the rescuer.
          out.placed++; o.onResult && o.onResult(t, 'done'); out.blocked = true;
          log(`💬 [rescue:${name}] ✅ placed, then this rescuer hit a rate-limit — stopping it; remaining comments stay pending for next cycle`);
          break;
        } else if (res === 'blocked_account' || res === 'blocked_comment') {
          out.blocked = true; o.onResult && o.onResult(t, 'blocked');
          log(`💬 [rescue:${name}] ⛔ this rescuer hit a rate-limit — stopping it; remaining comments stay pending for next cycle`);
          break; // never keep hammering with a blocked rescuer
        } else {
          out.failed++; o.onResult && o.onResult(t, res);
          log(`💬 [rescue:${name}] ⚠️ could not place the comment on a "${label}" post (${res})`);
        }
      } catch (e) { out.failed++; o.onResult && o.onResult(t, 'error'); log(`💬 [rescue:${name}] error on a "${label}" post: ${e.message}`); }
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
  finally { try { if (sessionWatchdog) clearTimeout(sessionWatchdog); } catch {} try { if (browser) await Promise.race([browser.close().catch(() => {}), sleep(8000)]); } catch {} try { if (anonLocal && proxyChain) await Promise.race([proxyChain.closeAnonymizedProxy(anonLocal, true).catch(() => {}), sleep(8000)]); } catch {} }
}

module.exports = { runRescue };
