'use strict';
// MOD — the MODERATOR phase. A designated admin account approves OUR poster accounts' posts that
// Facebook held in the group "Spam potentiel" / pending queue, so the post goes live and the first
// comment can land. Fail-closed: it only ever acts on a card whose AUTHOR matches one of our accounts'
// FB display names AND whose CAPTION matches a held post from THIS cycle.
//
// THIS VERSION CLICKS (MOD-4): it navigates the queues, decides the (author AND caption) match, then for a
// matched card finds + clicks the card's approve control (Approve/Approuver/Publier/Allow/…) and CONFIRMS
// the card left the queue. Fail-closed: it only clicks a card whose author is one of OUR names AND whose
// caption matches a held snippet AND that contains an approve button — never anything else. The held
// records it actually approved are returned in out.approvedRecords so the orchestrator hands their
// comment to the rescue runner. Set settings.moderationDryRun=true to fall back to scan+log (NO clicks).
// Gated by settings.moderationEnabled upstream.
const { launchStealth, viewportFor, applyProxyGeo } = require('../lib/browser'); // ONE hardened launch path (real Chrome + no automation flag + stealth)
const store = require('../lib/store');
const { chromiumPath } = require('../lib/chromium');
const { killChromiumForProfile, parseProxy, moveMouseTo, applyPace, isFastMode } = require('./worker');
let proxyChain = null; try { proxyChain = require('proxy-chain'); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Jitter a base delay ±pct so a trusted admin account doesn't browse the spam queue on a metronomic cadence.
const jitter = (base, pct = 0.3) => Math.max(0, Math.round(base * (1 + (Math.random() * 2 - 1) * pct)));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
async function evalTimed(page, fn, arg, ms = 8000) {
  let t; const p = page.evaluate(fn, arg); p.catch(() => {});
  const cap = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('evaluate timeout')), ms); });
  try { return await Promise.race([p, cap]); } finally { clearTimeout(t); }
}

// o: { account (the moderator), groups, settings, held (records), posterNames (FB display names of our
// poster accounts), log, shouldStop }. Returns { approved, scanned, notMine, errors, noRetry, flag }.
async function runModerator(o) {
  const { account, groups, held, log, useProxies, proxies } = o; // useProxies/proxies feed applyProxyGeo below
  // Honor the moderator account's OWN pace (like rescue.js) — the moderator previously ignored speed entirely and spent
  // ~15-25s/group on fixed settles/scrolls even under a fast/instant fleet. (settings also feeds applyProxyGeo below;
  // omitting it earlier threw a ReferenceError under 'use strict' that silently disabled ALL held-post approval.)
  const settings = applyPace(o.settings, account && account.pace);
  const shouldStop = o.shouldStop || (() => false);
  const name = account.name;
  const dryRun = !!((o.settings || {}).moderationDryRun); // default OFF → REAL approval; set moderationDryRun=true to test without clicking
  const out = { approved: 0, scanned: 0, notMine: 0, errors: 0, unmatched: 0, clicked: 0, confirmFailed: 0, approvedRecords: [], noRetry: false, flag: null, dryRun };
  const ourNames = [...new Set((o.posterNames || []).map(norm).filter((n) => n && n.length >= 2))];
  const groupName = (gid) => { const g = (groups || []).find((x) => (x.groupId || x.id) === gid); return (g && g.name) || gid; };
  let browser = null, anonLocal = null;
  try {
    log(`🛡️ [moderator:${name}] approval phase starting — ${dryRun ? 'DRY-RUN (scan + log, NO clicks)' : 'LIVE (will click Approve/Publier on matched cards)'}. our names: [${ourNames.join(', ') || '(none captured — set fbDisplayName on the accounts)'}]`);
    // Off-screen by default; but when the operator turns OFF "hide browser" (Settings) the moderator window
    // is shown ON-screen too, so they can SEE which account is approving + watch the Spam-potentiel pass.
    const hideMod = ((o.settings && o.settings.hideBrowser) !== false);
    if (!hideMod) log(`🛡️ [moderator:${name}] running VISIBLE (hide-browser is off) — watch this window approve the held posts.`);
    try { const c = await killChromiumForProfile(store.profileDir(name), log); if (c) await sleep(800); } catch {} // clear a stale lock from a crashed prior session
    // Apply the moderator account's OWN proxy so it browses the queues from its own IP — never the operator's
    // real IP (which would tie the trusted admin account to every poster's content). Same logic as worker.js.
    const launchArgs = [ // base anti-detection args are in lib/browser BASE_ARGS
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // WebRTC IP-leak guard (same as worker.js) — the admin must not leak the real IP
      (hideMod ? '--window-position=-32000,-32000' : '--window-position=60,60'),
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
      '--disable-background-networking']; // stop Chrome's background service pings (update/safe-browsing) bypassing the proxy from the admin's browser
    let proxyAuth = null;
    if (account.proxy && String(account.proxy).trim()) {
      const p = parseProxy(account.proxy);
      if (!p) { log(`🚫 [moderator:${name}] proxy is set but malformed ("${String(account.proxy).slice(0, 40)}") — SKIPPING this cycle so the admin never browses from the real IP. Fix the proxy format.`); out.flag = 'proxy_invalid'; return out; }
      else if (p.username && proxyChain) {
        try { anonLocal = await proxyChain.anonymizeProxy(p.upstream); launchArgs.push(`--proxy-server=${anonLocal}`); log(`🛡️ [moderator:${name}] own proxy ${p.server} (auth via proxy-chain)`); }
        catch (e) {
          // proxy-chain wrap failed. For an HTTP proxy, page.authenticate CAN auth it → fall back (don't lose the
          // moderator to a transient proxy-chain error — its queues never get worked). For SOCKS, page.authenticate
          // can't auth → fail CLOSED (never browse from the real IP).
          if (!/^socks/.test(p.scheme)) { launchArgs.push(`--proxy-server=${p.server}`); proxyAuth = p; log(`🛡️ [moderator:${name}] own proxy ${p.server} (proxy-chain failed; auth via page.authenticate)`); }
          else { log(`🚫 [moderator:${name}] proxy-chain could not wrap the authenticated SOCKS proxy ${p.server} (${e.message}) — SKIPPING (page.authenticate can't auth SOCKS; won't browse un-proxied). Retries next cycle.`); out.flag = 'proxy_invalid'; return out; }
        }
      }
      else { launchArgs.push(`--proxy-server=${p.server}`); if (p.username) proxyAuth = p; log(`🛡️ [moderator:${name}] own proxy ${p.server}`); }
    } else if (o.useProxies) {
      // No own proxy but the pool is ON → use a STABLE shared-pool proxy (hash of the name, same as worker.js)
      // so the admin still has a non-real IP; fail CLOSED if the pool is empty (never browse from the real IP).
      const pool = (o.proxies || []).filter((px) => px && String(px).trim());
      if (!pool.length) { log(`🚫 [moderator:${name}] proxies are ON but this moderator has no proxy and the pool is empty — SKIPPING so the admin never browses from the real IP. Assign it a proxy (Accounts tab).`); out.flag = 'proxy_invalid'; return out; }
      let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
      const p = parseProxy(pool[h % pool.length]);
      if (!p) { log(`🚫 [moderator:${name}] shared-pool proxy is malformed — SKIPPING (won't browse from the real IP).`); out.flag = 'proxy_invalid'; return out; }
      else if (p.username && proxyChain) {
        try { anonLocal = await proxyChain.anonymizeProxy(p.upstream); launchArgs.push(`--proxy-server=${anonLocal}`); log(`🛡️ [moderator:${name}] shared-pool proxy ${p.server} (auth via proxy-chain)`); }
        catch (e) {
          if (!/^socks/.test(p.scheme)) { launchArgs.push(`--proxy-server=${p.server}`); proxyAuth = p; log(`🛡️ [moderator:${name}] shared-pool proxy ${p.server} (proxy-chain failed; auth via page.authenticate)`); }
          else { log(`🚫 [moderator:${name}] pool SOCKS proxy wrap failed (${e.message}) — SKIPPING (won't browse un-proxied).`); out.flag = 'proxy_invalid'; return out; }
        }
      } else { launchArgs.push(`--proxy-server=${p.server}`); if (p.username) proxyAuth = p; log(`🛡️ [moderator:${name}] shared-pool proxy ${p.server}`); }
    } else { log(`ℹ️ [moderator:${name}] no proxy set + proxy pool OFF — browsing from the real IP. Turn on proxies + assign one for the admin's own IP.`); }
    browser = await launchStealth({
      headless: false,
      userDataDir: store.profileDir(name),
      args: launchArgs,
      defaultViewport: viewportFor(name), // per-account viewport (consistent with this account's posting browser on the same profile)
      protocolTimeout: 90000,
    });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    if (proxyAuth && proxyAuth.username) { try { await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password || '' }); } catch {} }
    await applyProxyGeo(page, account, settings, useProxies, proxies, (m) => log(`[moderator:${name}] ${m}`)); // proxied admin must not report the host clock/locale

    // Probe the moderator session — NEVER auto-login (it's the operator's trusted admin account).
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(jitter(isFastMode(settings) ? 800 : 2500, 0.3));
    // c_user cookie is the AUTHORITATIVE, locale-independent "logged in" signal — a text-only EN/FR probe reads a
    // non-EN/FR login wall as "logged in" and silently SKIPS approval. Require c_user AND no visible login wall.
    const hasCUser = await page.cookies().then((cks) => (cks || []).some((c) => c.name === 'c_user' && c.value)).catch(() => false);
    const noLoginWall = await evalTimed(page, () => {
      const t = (document.body.innerText || '').slice(0, 500).toLowerCase();
      const loginGate = /log in to facebook|connexion|create new account|cr[ée]er un compte/.test(t) && document.querySelector('input[name="email"], input[name="pass"]');
      return !loginGate;
    }, null, 6000).catch(() => true);
    const loggedIn = hasCUser && noLoginWall;
    if (!loggedIn) { log(`⚠️ [moderator:${name}] not logged in — approval skipped this cycle (log this account in from the Accounts tab)`); out.flag = 'needs_login'; out.noRetry = true; return out; }

    // Only scan groups that actually have held posts this cycle.
    const heldByGid = {};
    for (const h of (held || [])) { if (h && h.gid) (heldByGid[h.gid] = heldByGid[h.gid] || []).push(h); }
    const targetGids = Object.keys(heldByGid);
    log(`🛡️ [moderator:${name}] ${targetGids.length} group(s) have held posts to review`);

    for (const gid of targetGids) {
      if (shouldStop()) break;
      // ENFORCE length ≥12 here (not all sources gate it — the comment_notfound held path can carry a
      // short snippet). A short snippet would substring-match a STRANGER's pending post and wrong-approve
      // it, so anything under 12 chars is dropped: we never approve on a weak/ambiguous caption key.
      const capSnips = heldByGid[gid].map((h) => norm(h.captionSnip)).filter((s) => s && s.length >= 12);
      // Our account display names for this group's held posts → a VETO so we never approve a STRANGER's held
      // post that merely shares our caption. Empty (no fbDisplayName set) → can't veto → caption-only (as before).
      const ourNames = [...new Set((heldByGid[gid] || []).map((h) => norm(h.fbDisplayName)).filter((s) => s && s.length >= 2))];
      const gname = groupName(gid);
      if (!capSnips.length) { log(`🛡️ [moderator] [${gname}] ${heldByGid[gid].length} held record(s) but no caption snippet ≥12 chars — skipping (cannot match safely; would risk approving the wrong post)`); out.errors++; continue; }
      // The held "Spam potentiel" post lives in the group's SPAM queue, NOT pending_posts — and it could be
      // in either, so we DON'T stop at the first queue-looking page. We try each candidate admin queue,
      // scroll to render lazy content, and PICK the URL that actually CONTAINS one of our held captions.
      // (Live diagnostic showed the caption was absent from /pending_posts → it's in the spam queue.)
      // ORDER MATTERS: the plain /pending_posts + /spam queues are the ones that actually render OUR card text,
      // so try them FIRST — the /admin/* variants can silently redirect to the FB homepage (whose notification
      // bell contains our caption verbatim) and trigger a false "queue found". web.facebook.com forces the SPA
      // renderer that exposes card text via innerText (www redirects here anyway).
      const urls = [
        `https://web.facebook.com/groups/${gid}/pending_posts`,
        `https://web.facebook.com/groups/${gid}/spam`,
        `https://web.facebook.com/groups/${gid}/spam?sorting_setting=SPAM_POTENTIAL`,
        `https://web.facebook.com/groups/${gid}/moderation_tasks`,   // FR "Outils du modérateur → Publications en attente"
        `https://web.facebook.com/groups/${gid}/admin/pending_posts`,
        `https://web.facebook.com/groups/${gid}/admin/spam`,
        `https://web.facebook.com/groups/${gid}/admin/moderation_tasks`,
      ];
      let onQueue = false, fallbackUrl = null;
      for (const url of urls) {
        if (shouldStop()) break;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(jitter(isFastMode(settings) ? 800 : 2500, 0.3));
        await sleep(jitter(isFastMode(settings) ? 1500 : 3500, 0.25)); // extra settle for the React/SPA spam queue to hydrate before scanning — SHORTENED (not removed) under fast; hydration is functional
        for (let s = 0; s < 10; s++) { await page.evaluate((y) => window.scrollBy(0, y), 500 + Math.floor(Math.random() * 400)).catch(() => {}); await sleep(jitter(isFastMode(settings) ? 600 : 1100, 0.35)); } // nudge lazy render before testing for our caption (FR queue lazy-loads each card). KEEP the 10-scroll COUNT (coverage — fewer scrolls could MISS a held card); only the per-scroll settle shortens under fast
        const info = await evalTimed(page, (snips) => {
          const norm = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          const t = norm(document.body.innerText || ''); // accent-stripped so FR "à vérifier"/"filtrés"/"modérateur" match
          // URL path is the PRIMARY signal (a real queue URL); body keywords only count when TWO strong queue
          // terms co-occur — so the FB homepage (whose notification bell can contain "spam"/"en attente") never
          // passes on body text alone.
          const isQ = /\/spam(\?|$)|moderation_tasks|pending_posts/.test(location.href || '') ||
            (/publications en attente|outils du moderateur|contenu signale|a verifier|to review/.test(t) &&
             /spam|potentiel|filtr|awaiting|declined|en attente/.test(t));
          const body = norm(document.body.innerText || '');
          const capPresent = snips.some((s) => s && (body.includes(s) || (s.length >= 28 && body.includes(s.slice(0, 28)))));
          return { isQ, capPresent, title: (document.title || '').slice(0, 70), url: (location.href || '').slice(0, 95) };
        }, capSnips, 8000).catch(() => null);
        // Require isQ too: a capPresent hit on a NON-queue page (the homepage notification bell shows our caption)
        // would otherwise break the loop here and skip the real queue. Only accept "found" on an actual queue page.
        if (info && info.capPresent && info.isQ) { onQueue = true; log(`🛡️ [moderator] [${gname}] queue WITH our post — ${info.url}`); break; }
        if (info && info.isQ && !fallbackUrl) fallbackUrl = info.url;
        log(`🛡️ [moderator] [${gname}] ${info ? (info.isQ ? 'queue but our post not present' : 'not a queue') : 'no info'} (${info ? info.url : url}) — trying next`);
      }
      if (!onQueue) { log(`🛡️ [moderator] [${gname}] our held post was NOT found on any known queue URL${fallbackUrl ? ` (last queue-looking: ${fallbackUrl})` : ''} — skipping (tell me the Spam-potentiel page URL from your browser if this persists)`); out.errors++; continue; }

      // BUTTON-ANCHORED scan. The Spam-potentiel queue shows a per-post "Publier" (approve) + "Refuser"
      // (decline) button, but those buttons are NOT in the post-caption's ancestor chain (the caption sits
      // in a separate <a role=link> preview). So we anchor on the APPROVE button instead: for each Publier/
      // approve button, climb to the row that ALSO contains one of our held captions — that's our post —
      // and tag THAT button (data-zp-mod) to click. Refuser/decline/delete is explicitly excluded.
      const scan = await evalTimed(page, (arg) => {
        const { snips, ourNames } = arg;
        const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const APPROVE = /\b(publier|publish|approve|approuver|approuve|allow|autoriser|valider|accepter|accept|admettre|confirmer)\b|approuv|approv/; // includes FR "Publier"/"Approuver"/"Valider"
        // CRITICAL: 'spam' must NOT be a decline token — the whole "Spam potentiel" queue page is saturated with
        // the word, which would exclude EVERY approve button. Use word-anchored, unambiguous decline verbs only.
        const DECLINE = /\b(refuser|refus|decline|reject|rejeter|supprimer|delete|supprim|remove|masquer|hide|signaler|report)\b/;
        const isApprove = (b) => { const l = nm((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || ''); return !!l && APPROVE.test(l) && !DECLINE.test(l); };
        const allBtns = Array.from(document.querySelectorAll('[role="button"], button'));
        const approveBtns = allBtns.filter(isApprove);
        const results = []; let tag = 0;
        for (const btn of approveBtns) {
          if (btn.getAttribute('data-zp-mod')) continue;
          // climb from the approve button to the row that contains one of our held captions
          let matched = null, rowText = '', n = btn;
          for (let i = 0; i < 16 && n && n.tagName; i++) {
            const t = nm(n.textContent || '');
            const hit = snips.find((s) => s && (t.includes(s) || (s.length >= 28 && t.includes(s.slice(0, 28)))));
            if (hit) { matched = hit; rowText = t; break; }
            n = n.parentElement;
          }
          if (!matched) continue;
          // AMBIGUITY GUARD (wrong-approve): the caption-bearing ancestor n must contain THIS approve button as its ONLY
          // approve button. If n spans MULTIPLE queue cards (≥2 approve buttons), the matched caption may belong to a
          // DIFFERENT card than btn — so clicking btn could approve a STRANGER's held post whose card merely shares an
          // ancestor with ours. The author read below (over the same shared n) would find OUR name and pass. Reject it.
          // Count DISTINCT clickable approve controls in n. Use isApprove (which already excludes decline verbs) and
          // ONLY real buttons (not bare [aria-label] wrappers), then collapse a wrapper+inner double-labeled control to
          // ONE (an approve node nested inside another counted approve node) — so a LEGITIMATE single card whose approve
          // control is double-marked isn't false-counted as 2 and wrongly skipped; two SIBLING cards still count as 2.
          const _apBtns = Array.from(n.querySelectorAll('[role="button"], button')).filter(isApprove);
          const _apCount = _apBtns.filter((b) => !_apBtns.some((o2) => o2 !== b && o2.contains(b))).length;
          if (_apCount > 1) continue; // shared ancestor over 2+ distinct cards → can't safely bind this button to our caption (skip; the post stays 'held' → recovered via re-post / next cycle)
          // Best-effort poster-name read from the matched row → a VETO for a confident STRANGER (fail-open).
          // Names are short links/headings; the caption preview is long → length-filtered out. If we can't
          // read a name (obfuscated DOM) OR no ourNames configured, authorOurs stays true (caption-only).
          let author = '', authorOurs = true;
          try {
            const cand = Array.from(n.querySelectorAll('a[role="link"], strong, h2, h3, h4'))
              .map((e) => nm(e.textContent || ''))
              .filter((s) => s && s.length >= 2 && s.length <= 50 && !APPROVE.test(s) && !snips.some((sn) => sn && s.includes(sn.slice(0, 20)))); // DECLINE not applied to author names (a name may contain 'remove'/'hide'/etc.)
            if (ourNames && ourNames.length) {
              const hit = cand.find((c) => ourNames.some((on) => c.includes(on) || (on.includes(c) && c.length >= Math.max(5, Math.floor(on.length * 0.6))))); // S3: length-gate the reverse-substring direction so a short stranger token (e.g. "ali") can't pass the veto as our "ali baba store" → wrong-approve. A truncated real display-name still matches; a missed truly-ours card falls to Phase-4 (never worse for the wrong-approve guard).
              if (hit) { author = hit; authorOurs = true; }
              else if (cand.length) { author = cand[0]; authorOurs = false; } // a readable, non-matching name → veto
            } else if (cand.length) { author = cand[0]; }
          } catch {}
          const zpTag = String(tag++); btn.setAttribute('data-zp-mod', zpTag);
          results.push({ author, authorOurs, capMatch: true, capSnipMatched: matched, hasApprove: true, zpTag, snippet: rowText.slice(0, 70) });
        }
        // diagnostics: distinct labels of the approve-looking buttons we considered
        const nearbyBtns = [...new Set(approveBtns.map((b) => nm((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || '')).filter(Boolean))].slice(0, 12);
        return { count: results.length, results, approveBtnCount: approveBtns.length, nearbyBtns };
      }, { snips: capSnips, ourNames }, 14000).catch(() => null);

      if (!scan) { log(`🛡️ [moderator] [${gname}] scan failed (selector/timeout) — dumping nothing; refine selectors`); out.errors++; continue; }
      out.scanned += scan.count;
      log(`🛡️ [moderator] [${gname}] ${scan.approveBtnCount || 0} approve-button(s) on page, ${scan.count} matched OUR caption(s); approve labels: [${(scan.nearbyBtns || []).join(' | ') || 'none'}]`);
      let matchedThisGroup = 0;
      const handledSnips = new Set(); // snippets already acted on this group — never approve/queue one held post twice
      for (let i = 0; i < scan.results.length; i++) {
        if (shouldStop()) break;
        const r = scan.results[i];
        // VETO: caption matched + an approve button, but we confidently read an author that is NOT one of our
        // accounts → it's a stranger's held post → never approve it (you're the admin; don't approve spam).
        // Fail-open: when the author is unreadable or no fbDisplayName is set, authorOurs is true (caption-only).
        if (r.capMatch && r.hasApprove && r.zpTag != null && !r.authorOurs) {
          log(`🛡️ [moderator] [${gname}] card ${i + 1}: caption matched but author "${r.author}" is NOT one of our accounts — NOT approving (avoids approving a stranger's post). If wrong, set this account's FB display name on the Accounts tab.`);
          continue;
        }
        const fullMatch = r.capMatch && r.hasApprove && r.zpTag != null && r.authorOurs; // caption + (author-ours OR author-unknown)
        if (fullMatch && handledSnips.has(r.capSnipMatched)) {
          log(`🛡️ [moderator] [${gname}] card ${i + 1}: duplicate of an already-handled held post — skipping (no double-approve)`);
          continue;
        }
        if (fullMatch) {
          handledSnips.add(r.capSnipMatched);
          const rec = (heldByGid[gid] || []).find((h) => norm(h.captionSnip) === r.capSnipMatched) || null;
          if (dryRun) {
            matchedThisGroup++; out.approved++;
            log(`🛡️ [moderator] [${gname}] card ${i + 1}: caption=✓ approveBtn=✓ author="${r.author}"(ours=${r.authorOurs}) → WOULD APPROVE (dry-run): "${r.snippet}"`);
            continue;
          }
          out.clicked++;
          log(`🛡️ [moderator] [${gname}] card ${i + 1}: caption=✓ approveBtn=✓ author="${r.author}"(ours=${r.authorOurs}) → APPROVING: "${r.snippet}"`);
          const res = await approveCard(page, r.zpTag);
          if (res.ok) {
            matchedThisGroup++; out.approved++;
            if (rec) out.approvedRecords.push(rec); // CONFIRMED approval → hand the comment off to rescue (orchestrator)
            log(`✅ [moderator] [${gname}] card ${i + 1}: APPROVED & confirmed (${res.detail}) — "${r.snippet}"`);
          } else {
            out.confirmFailed++;
            log(`⚠️ [moderator] [${gname}] card ${i + 1}: approve ${res.clicked ? 'clicked but NOT confirmed' : 'could not be clicked'} (${res.detail}) — left HELD for retry: "${r.snippet}"`);
          }
        } else {
          out.notMine++;
          log(`🛡️ [moderator] [${gname}] card ${i + 1}: author="${r.author}" ours=${r.authorOurs} caption=${r.capMatch} approveBtn=${r.hasApprove} → skip: "${r.snippet}"`);
        }
      }
      // Reconcile against the held records we were handed: surface any held post we could NOT find a card
      // for (FB already approved/removed it, it's past the first 25 scanned, or it never rendered) so a
      // dropped held post is visible, not silent.
      const heldCount = heldByGid[gid].length;
      if (matchedThisGroup < heldCount) {
        const miss = heldCount - matchedThisGroup; out.unmatched += miss;
        log(`⚠️ [moderator] [${gname}] ${miss} of ${heldCount} held post(s) had NO matching card in the queue (already approved/removed, beyond the first 25 scanned, or not rendered) — they remain 'held'.`);
        // DIAGNOSTIC: matched 0 while a held post IS in the queue → the pending-queue DOM differs from the
        // public feed (cards/author aren't [aria-posinset]/article). Find the element actually holding OUR
        // caption and dump its ancestor chain + author candidates so we can fix the selectors from real data.
        try {
          const diag = await evalTimed(page, (snips) => {
            const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const counts = { checkbox: document.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length, posinset: document.querySelectorAll('[aria-posinset]').length };
            // ALL distinct actionable labels on the page — reveals the approve mechanism (per-post "Publier"/
            // "Approve"/"Allow", a bulk-action bar, a "···" menu, etc.).
            const labels = [];
            Array.from(document.querySelectorAll('[role="button"], button, [role="menuitem"], [role="tab"]')).forEach((b) => { const l = norm((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || ''); if (l && l.length >= 2 && l.length <= 30) labels.push(l); });
            const pageButtons = [...new Set(labels)].slice(0, 40);
            // locate our caption + describe whether it's wrapped in a clickable post link
            const all = Array.from(document.querySelectorAll('div, span, a, li'));
            for (const snip of snips) {
              if (!snip || snip.length < 8) continue;
              let el = null, best = Infinity;
              for (const e of all) { const t = norm(e.textContent || ''); if (t.includes(snip) && t.length < best) { el = e; best = t.length; } }
              if (!el) continue;
              let linkHref = null, n = el; const chain = [];
              for (let i = 0; i < 8 && n && n.tagName; i++) { if (n.tagName === 'A' && n.getAttribute('role') === 'link' && !linkHref) linkHref = (n.getAttribute('href') || '').slice(0, 60); const cls = String(n.className || '').split(' ').filter(Boolean)[0] || ''; chain.push(`${n.tagName.toLowerCase()}${n.getAttribute('role') ? '[' + n.getAttribute('role') + ']' : ''}${cls ? '.' + cls.slice(0, 10) : ''}`); n = n.parentElement; }
              return { counts, pageButtons, captionInLink: linkHref, chain, text: norm(el.textContent).slice(0, 80) };
            }
            return { counts, pageButtons, note: 'caption not found' };
          }, capSnips, 10000).catch((e) => ({ err: e && e.message }));
          log(`🔬 [moderator] [${gname}] DIAG ${JSON.stringify(diag).slice(0, 700)}`);
        } catch (e) { log(`🔬 [moderator] [${gname}] DIAG failed: ${e.message}`); }
      }
    }
    if (dryRun) log(`🛡️ [moderator:${name}] DRY-RUN complete — scanned=${out.scanned} would-approve=${out.approved} skipped=${out.notMine} unmatched=${out.unmatched} errors=${out.errors}. (No posts were approved — dry run.)`);
    else log(`🛡️ [moderator:${name}] LIVE pass complete — scanned=${out.scanned} approved=${out.approved} clicked=${out.clicked} confirmFailed=${out.confirmFailed} skipped=${out.notMine} unmatched=${out.unmatched} errors=${out.errors}.`);
    return out;
  } catch (e) {
    log(`❌ [moderator:${name}] ${e.message}`); out.errors++; return out;
  } finally {
    try { if (browser) await Promise.race([browser.close().catch(() => {}), sleep(8000)]); } catch {}
    try { const proc = browser && browser.process && browser.process(); if (proc && !proc.killed) proc.kill('SIGKILL'); } catch {} // HARD-KILL if the bounded close hung — else the moderator Chromium orphans on the profile; mirrors worker.js's proc.kill fallback
    if (anonLocal && proxyChain) { try { await Promise.race([proxyChain.closeAnonymizedProxy(anonLocal, true).catch(() => {}), sleep(8000)]); } catch {} } // free the per-run local proxy port — BOUNDED (a Windows CLOSE_WAIT socket drain from the `true` flag can hang forever, which would wedge the whole moderation phase + every later cycle; matches worker.js/repost.js/rescue.js)
  }
}

// Re-select the EXACT card the scan tagged data-zp-mod="<idx>" (only full-gate cards were tagged), find
// the approve control INSIDE that card, click it, then CONFIRM the card left the queue. Returns
// { ok, clicked, detail }. Fail-safe: never clicks outside the tagged card; re-validates the approve
// button exists inside the exact tagged element before clicking (so a re-render can't redirect the click);
// counts success ONLY on confirmation (card detached / its approve button gone).
async function approveCard(page, zpTag) {
  const click = await evalTimed(page, (tag) => {
    const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const APPROVE = /\b(publier|publish|approve|approuver|approuve|allow|autoriser|valider|accepter|accept|admettre|confirmer)\b|approuv|approv/;
    const DECLINE = /\b(refuser|refus|decline|reject|rejeter|supprimer|delete|supprim|remove|masquer|hide|signaler|report)\b/; // 'spam' deliberately excluded
    const isApprove = (b) => { const l = nm((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || ''); return !!l && APPROVE.test(l) && !DECLINE.test(l); };
    const node = document.querySelector(`[data-zp-mod="${tag}"]`);
    if (!node) return { clicked: false, reason: 'tag-gone-before-click' };
    // The tagged element IS the approve (Publier) button (button-anchored scan); fall back to one inside it.
    const btn = isApprove(node) ? node : Array.from(node.querySelectorAll('[role="button"], button')).find(isApprove);
    if (!btn) return { clicked: false, reason: 'approve-btn-not-found' };
    const label = (btn.getAttribute('aria-label') || btn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    if (r.width && r.height) return { clicked: true, reason: `clicked "${label}"`, rect: { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) } };
    // Zero-bounds (lazy/collapsed card) → no geometry to hand a real mouse; click in-page as a best-effort fallback so
    // the approval STILL fires instead of silently no-op'ing. rect:null tells the Node side NOT to click again.
    btn.click();
    return { clicked: true, reason: `clicked "${label}" (in-page fallback — zero-bounds)`, rect: null };
  }, zpTag, 8000).catch((e) => ({ clicked: false, reason: 'click-eval-error:' + (e && e.message) }));
  if (!click || !click.clicked) return { ok: false, clicked: false, detail: (click && click.reason) || 'no-click' };
  // Real-mouse click of the approve button (move + click) instead of the in-page el.click() above (isTrusted=false).
  if (click.rect) { try { await moveMouseTo(page, click.rect.x, click.rect.y); await page.mouse.click(click.rect.x, click.rect.y, { delay: 40 + Math.floor(Math.random() * 90) }); } catch {} }
  // Confirm: the tagged button detaches once the post leaves the queue. A confirmation dialog may appear
  // first ("Publier ?") — accept it. Poll until the tagged button is gone.
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(jitter(1200, 0.3));
    const confirmRect = await evalTimed(page, () => {
      const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const dlg = document.querySelector('[role="dialog"]'); if (!dlg) return null;
      const DECLINE = /\b(refuser|refus|decline|reject|rejeter|supprimer|delete|supprim|remove|masquer|hide|signaler|report|annuler|cancel)\b/; // 'spam' excluded; keep annuler/cancel for the confirm dialog
      const b = Array.from(dlg.querySelectorAll('[role="button"], button')).find((x) => { const l = nm((x.getAttribute && x.getAttribute('aria-label')) || x.textContent || ''); return /\b(publier|approve|approuver|approuve|valider|confirmer|confirm|autoriser|oui|yes)\b/.test(l) && !DECLINE.test(l); });
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return (r.width && r.height) ? { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) } : null;
    }, null, 3000).catch(() => null);
    if (confirmRect) { try { await moveMouseTo(page, confirmRect.x, confirmRect.y); await page.mouse.click(confirmRect.x, confirmRect.y, { delay: 40 + Math.floor(Math.random() * 90) }); } catch {} }
    const gone = await evalTimed(page, (tag) => { const node = document.querySelector(`[data-zp-mod="${tag}"]`); return { gone: !node || !node.isConnected }; }, zpTag, 5000).catch(() => null);
    if (gone && gone.gone) return { ok: true, clicked: true, detail: `${click.reason}; button-detached` };
  }
  return { ok: false, clicked: true, detail: `${click.reason}; not-confirmed-within-timeout` };
}

module.exports = { runModerator };
