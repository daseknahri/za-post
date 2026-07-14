'use strict';
// HELD-POST RE-POST RESCUE — last-resort fallback for a post FB HELD in "Spam potentiel" that the moderator
// could not approve. A healthy RESERVE account re-posts the SAME content to that group so it goes live 100%.
//
// CRITICAL anti-duplicate guard: FB often AUTO-RELEASES a held post after a while (so the moderator finds no
// card, and the post is actually public). Before re-posting we therefore CHECK the group's public feed for
// the original content. If it's already LIVE we do NOT re-post (that would duplicate) — we signal alreadyLive
// so the caller re-homes the missing link-comment onto the now-live original instead. Only when the content
// is confirmed ABSENT do we actually re-post (reusing worker.runAccount, scoped to the one group).
const fs = require('fs');
const { launchStealth, viewportFor, applyProxyGeo } = require('../lib/browser'); // ONE hardened launch path (real Chrome + no automation flag + stealth)
const store = require('../lib/store');
const { chromiumPath } = require('../lib/chromium');
const { runAccount, killChromiumForProfile, applyPace, isFastMode, parseProxy } = require('./worker');
let proxyChain = null; try { proxyChain = require('proxy-chain'); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
// R6 author-matching (pure, exported for tests). A crash-re-armed Phase-4 re-post is "live" if EITHER the ORIGINAL
// poster OR the RESERVE reposter is present, so isContentLive matches ANY of OUR authors — never a stranger.
// authorsList normalizes + 60-slices each expected author EXACTLY as authorOf slices the on-page author (so a >60-char
// display name still matches). isOurAuthor is the per-article predicate the in-browser feed scan + permalink gate
// replicate: an UNREADABLE author ('') is treated as possibly-ours (never risk a duplicate); a readable author is ours
// iff it is in the set.
const authorsList = (expectedAuthors) => (Array.isArray(expectedAuthors) ? expectedAuthors : [expectedAuthors]).map((a) => norm(a).slice(0, 60)).filter(Boolean);
const isOurAuthor = (authors, articleAuthor) => !articleAuthor || authors.includes(articleAuthor);

// Is `captionSnip` already LIVE in the group's public feed (FB auto-released the held original)?
// Fail-SAFE: on any error/timeout returns false so a genuine hold still gets re-posted (a rare duplicate is
// less bad than never delivering); but a short/non-distinctive caption returns false too (can't confirm).
// Returns 'live' (original is public — don't re-post), 'absent' (not public — safe to re-post),
// 'no_proxy' (proxies are ON but this reserve has no usable proxy — bail, leave the held post for retry), or
// 'session_expired' (the reserve is logged out — bail, leave the held post for retry).
async function isContentLive(account, gid, captionSnip, settings, log, shouldStop, useProxies = false, proxies = [], permalink = null, expectedPostId = null, expectedAuthors = []) {
  const snip = norm(captionSnip).slice(0, 40);
  const fbId = /^\d{8,}$/.test(String(expectedPostId || '')) ? String(expectedPostId) : null; // trust anchor for the permalink-direct check
  const authors = authorsList(expectedAuthors); // R6: the ORIGINAL poster + (if a crash re-armed a re-post) the RESERVE reposter — 'live' if EITHER of OUR authors is present (see authorsList / isOurAuthor)
  if (snip.length < 12 && !permalink && !fbId) return 'absent'; // nothing to confirm with → allow the (cap-1-bounded) re-post
  const hidden = (settings.hideBrowser !== false);
  // Route the dedup presence-check through a proxy so we never read the group from the real IP: the account's
  // OWN proxy, else a STABLE shared-pool pick (hash of the name, same as worker.js), else FAIL CLOSED. authed
  // proxies are wrapped via proxy-chain (Chrome can't auth SOCKS5 directly).
  let proxyArg = '', anonLocal = null, proxyAuth = null;
  try {
    let pstr = (account.proxy && String(account.proxy).trim()) || '';
    if (!pstr && useProxies && proxies && proxies.length) { let h = 0; const nm = account.name || ''; for (let i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) >>> 0; pstr = proxies[h % proxies.length]; }
    if (!pstr && useProxies) { log(`♻️ [repost:${account.name}] proxies ON but no proxy for this account — NOT reading the feed from the real IP; leaving held for retry.`); return 'no_proxy'; }
    if (pstr) {
      const pp = parseProxy(pstr);
      if (pp) {
        if (pp.username && proxyChain) { anonLocal = await proxyChain.anonymizeProxy(pp.upstream).catch(() => null); if (anonLocal) proxyArg = `--proxy-server=${anonLocal}`; else { proxyArg = `--proxy-server=${pp.server}`; proxyAuth = pp; } }
        else { proxyArg = `--proxy-server=${pp.server}`; if (pp.username) proxyAuth = pp; }
      }
    }
  } catch {}
  let browser = null;
  try {
    const _vp = viewportFor(account.name); // per-account viewport — match this account's posting/login browser on the SAME profile (a hardcoded size off the pool, with mismatched inner/outer dims, is itself a fingerprint)
    browser = await launchStealth({
      headless: false, userDataDir: store.profileDir(account.name),
      args: ['--mute-audio', `--window-size=${_vp.width},${_vp.height}`,
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', // WebRTC IP-leak guard (same as worker.js)
        ...(proxyArg ? [proxyArg] : []), // route the dedup presence-check through the account's own proxy too (don't read the group from the real IP)
        ...(hidden ? ['--window-position=-32000,-32000', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] : [])],
      defaultViewport: _vp, protocolTimeout: 90000,
    });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    if (proxyAuth && proxyAuth.username) { try { await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password || '' }); } catch {} } // HTTP-proxy auth fallback when not proxy-chain-wrapped
    await applyProxyGeo(page, account, settings, useProxies, proxies, log); // proxied presence-check must use the account's proxy clock/locale, not the host's
    page.on('dialog', async (d) => { try { if (d.type() === 'beforeunload') await d.accept(); else await d.dismiss(); } catch {} });
    // Stop-aware navigation helper: a CDP hang must not hold the caller for the full 90s after Stop.
    const _goto = (url) => {
      let iv;
      return Promise.race([
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }),
        new Promise((_, rej) => { iv = setInterval(() => { if (shouldStop()) { clearInterval(iv); rej(new Error('stopped')); } }, 500); }),
      ]).catch(() => {}).finally(() => clearInterval(iv)); // clear the stop-poll interval whichever side wins the race — goto usually wins, and the interval would otherwise run for the browser's whole lifetime (leak)
    };
    // Session check: a logged-out reserve redirects to /login or shows the account picker — any presence verdict is
    // then meaningless. Surface it so the caller leaves the post for retry.
    const _gate = () => page.evaluate(() => {
      const t = (document.body.innerText || '').slice(0, 600).toLowerCase();
      return /log in to facebook|continue as|use another profile|create new account/.test(t) || /\/login|checkpoint/.test(location.href);
    }).catch(() => false);

    // PRIMARY (fixes the systematic DOUBLE-POST): when we captured the original's OWN permalink, confirm liveness
    // DIRECTLY there. This reaches the post no matter how deep the feed has scrolled — the shallow top-of-feed scan
    // below CANNOT reach a ~90-min-old auto-released post in a busy group, so it false-returned 'absent' → a DUPLICATE
    // re-post. A held (not-yet-public) post's permalink shows "content not available" → 'absent' (re-post is correct).
    if (permalink) {
      await _goto(permalink);
      if (shouldStop()) return 'absent';
      if (await _gate()) return 'session_expired';
      await page.waitForSelector('[aria-posinset], div[role="article"]', { timeout: 15000 }).catch(() => {});
      const pv = await page.evaluate(({ sn, fbId, authors }) => {
        const n = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const unavail = /isn't available|isnt available|no longer available|content isn't|contenu.*introuvable|n'est pas disponible|nest pas disponible/i.test(document.body.innerText || '');
        const arts = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]'));
        const a = arts[0]; // the permalink page's primary article = the post
        const authorOf = (x) => { const c = x && x.querySelector('h2 a, h3 a, h4 a, strong a, a strong, a[aria-label][href*="/user/"], a[aria-label][role="link"]'); return n(c ? (c.getAttribute('aria-label') || c.textContent) : '').slice(0, 60); };
        const idOk = (a && fbId) ? ((location.href.match(/\/(?:posts|permalink)\/(\d+)/) || [])[1] === fbId || (a.innerHTML || '').includes('"' + fbId)) : null;
        const capOk = (a && sn && sn.length >= 12) ? n(a.textContent).includes(sn) : null;
        const au = a ? authorOf(a) : '';
        // CONFIRM OUR post FIRST — a genuinely LIVE post can embed a since-deleted reshare rendering "…isn't available",
        // so we must NOT let the whole-page unavailable text short-circuit to 'absent' before checking our article.
        if (authors.length && au && !authors.includes(au)) return 'inconclusive'; // the page's author is NOT one of OURS (e.g. FB redirected a held/removed post's link to the group feed) → DEFER to the author-aware feed scan; never a false 'absent'
        if (idOk || capOk) return 'live';                          // OUR post is public on its own page
        // OUR post is NOT confirmed on this page → 'absent' ONLY if the page ITSELF is unavailable (held/removed/private); else defer.
        return unavail ? 'absent' : 'inconclusive';
      }, { sn: snip, fbId, authors });
      if (pv === 'live') return 'live';
      // R6: an 'absent' on the ORIGINAL poster's permalink is authoritative ONLY when there's no reserve reposter. When a
      // reserve re-armed a re-post (authors.length > 1), the original permalink can be gone (held/removed) while the
      // RESERVE's OWN live copy sits in the feed under a DIFFERENT permalink → fall through to the author-aware feed scan
      // (which matches ANY of our authors) so we don't miss it and re-post a duplicate.
      if (pv === 'absent' && authors.length <= 1) return 'absent';
      // inconclusive, OR absent-with-a-reserve-author → fall through to the group-feed scan below
    }

    // FALLBACK (no permalink, or the permalink was inconclusive): group-feed scan — now AUTHOR-AWARE and DEEPER. A
    // same-caption STRANGER's post no longer counts as 'live' (that stranded our held post AND re-homed its comment
    // onto the wrong post); an UNREADABLE author is treated as possibly-ours (conservative — never risk a duplicate).
    await _goto(`https://www.facebook.com/groups/${gid}?sorting_setting=CHRONOLOGICAL`);
    if (shouldStop()) return 'absent';
    if (await _gate()) return 'session_expired';
    await page.waitForSelector('[aria-posinset], div[role="article"]', { timeout: 20000 }).catch(() => {});
    const _fast = isFastMode(applyPace(settings, account && account.pace)); // honor the reserve account's pace for the dedup-scan dwell
    for (let s = 0; s < 12 && !shouldStop(); s++) { await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await sleep(_fast ? 250 + Math.floor(Math.random() * 250) : 700 + Math.floor(Math.random() * 700)); } // DEEPER (12 scrolls, was 5): a ~90-min-old auto-released post sits far below the top in a busy group; missing it → a DUPLICATE re-post
    const found = await page.evaluate(({ sn, authors }) => {
      const n = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const authorOf = (x) => { const c = x.querySelector('h2 a, h3 a, h4 a, strong a, a strong, a[aria-label][href*="/user/"], a[aria-label][role="link"]'); return n(c ? (c.getAttribute('aria-label') || c.textContent) : '').slice(0, 60); };
      const caps = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]')).slice(0, 60).filter((a) => n(a.textContent).includes(sn)); // scan up to 60 (was 25)
      if (!caps.length) return false;
      if (!authors.length) return true; // no author to check → any same-caption match = live (prior behaviour)
      // ANY of OUR authors (original OR reserve), OR an unreadable author (could be ours → don't risk a dup). A readable STRANGER's post is NOT ours.
      return caps.some((a) => { const au = authorOf(a); return !au || authors.includes(au); });
    }, { sn: snip, authors }).catch(() => false);
    return found ? 'live' : 'absent';
  } catch { return 'absent'; } // best-effort: an error shouldn't permanently block delivery (cap-1 bounds any dup)
  finally {
    try { if (browser) await Promise.race([browser.close().catch(() => {}), sleep(8000)]); } catch {} // BOUNDED — browser.close() is an OS process-shutdown that bypasses protocolTimeout; a proxied Chromium can hang on a CLOSE_WAIT socket forever and wedge the whole re-post phase (matches worker.js/rescue.js/moderator.js)
    try { const proc = browser && browser.process && browser.process(); if (proc && !proc.killed) proc.kill('SIGKILL'); } catch {} // HARD-KILL if the bounded close hung — else the Chromium orphans on the reserve's profile (holds the lock + RAM until next launch); mirrors worker.js's proc.kill fallback
    if (anonLocal && proxyChain) { try { await Promise.race([proxyChain.closeAnonymizedProxy(anonLocal, true).catch(() => {}), sleep(8000)]); } catch {} } // free the local proxy port (bounded)
  }
}

// o: { account (reserve), post (full library post), gid, groupName, captionSnip, group (the group object),
//      settings, useProxies, proxies, log, shouldStop, isLoginOpen, registerAborter, onResult, isOnline,
//      waitIfPaused, isPaused }
// Returns { alreadyLive:true } if the original is already public (do NOT re-post), else worker.runAccount's
// result shape { posted, heldRecords, commentQueue, ... }.
async function runRepost(o) {
  const { account, post, gid, groupName, captionSnip, settings = {}, log } = o;
  const shouldStop = o.shouldStop || (() => false);
  const where = `[repost:${account.name}] [${groupName || gid}]`;
  log(`♻️ ${where} held post un-approvable — checking the public feed before re-posting (avoids duplicating an auto-released post)…`);
  const presence = await isContentLive(account, gid, captionSnip, settings, log, shouldStop, !!o.useProxies, o.proxies || [], o.permalink || null, o.expectedPostId || null, o.expectedAuthors || []);
  if (presence === 'session_expired') {
    log(`♻️ ${where} this reserve is LOGGED OUT — not re-posting; leaving the held post for retry next cycle (re-login the account).`);
    return { posted: 0, heldRecords: [], flag: 'needs_login' };
  }
  if (presence === 'no_proxy') {
    log(`♻️ ${where} no usable proxy (proxies are ON) — not re-posting; leaving the held post for retry (assign a proxy to this account).`);
    return { posted: 0, heldRecords: [], flag: 'proxy_invalid' };
  }
  if (presence === 'live') {
    log(`♻️ ${where} original is ALREADY LIVE (FB released it) — NOT re-posting; its link-comment will be placed on the live post instead.`);
    return { alreadyLive: true };
  }
  if (shouldStop()) return { posted: 0, heldRecords: [] };
  // Wait for the presence-check browser to RELEASE the profile lock before runAccount opens the SAME profile
  // (a fixed sleep can be too short → 'profile in use' → a false {posted:0} → wrong failed_held). Poll the
  // Singleton* lock files in the profile dir (up to ~10s), then a short settle.
  try {
    const profDir = store.profileDir(account.name);
    for (let i = 0; i < 20; i++) {
      if (shouldStop()) return { posted: 0, heldRecords: [] };
      let locked = false;
      try { locked = fs.readdirSync(profDir).some((f) => /^Singleton/i.test(f)); } catch { locked = false; }
      if (!locked) break;
      await sleep(500);
    }
  } catch {}
  if (shouldStop()) return { posted: 0, heldRecords: [] };
  await sleep(800);
  // Clear any STALE lock from a previously-crashed browser on this profile (runAccount does this internally,
  // but the presence-check browser above could have left one if it was killed) so the re-post launch can't fail silently.
  try { const c = await killChromiumForProfile(store.profileDir(account.name), log); if (c) await sleep(800); } catch {}
  log(`♻️ ${where} not public — re-posting the content via this reserve account (1 group only).`);
  // runAccount launches its OWN browser on this profile (presence-check browser is closed) and posts the
  // post to ONLY this group (groups:[group] ∩ assignedGroups = this group; eligibility guaranteed membership).
  const r = await runAccount({
    account, post, groups: o.group ? [o.group] : [], settings: applyPace(settings, account.pace),
    useProxies: !!o.useProxies, proxies: o.proxies || [],
    log, shouldStop,
    isLoginOpen: o.isLoginOpen || (() => false),
    registerAborter: o.registerAborter || (() => () => {}),
    onResult: o.onResult || (() => {}),
    isOnline: o.isOnline || (() => true),
    waitIfPaused: o.waitIfPaused || (() => {}),
    isPaused: o.isPaused || (() => false),
    isDisabled: o.isDisabled || (() => false),
    maxThisRun: 1,
  }).catch((e) => { log(`♻️ ${where} re-post error: ${e.message}`); return { posted: 0, heldRecords: [], commentQueue: [], errors: 1 }; });
  return r || { posted: 0, heldRecords: [], commentQueue: [] };
}

module.exports = { runRepost, isContentLive, authorsList, isOurAuthor };
