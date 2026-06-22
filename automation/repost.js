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
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const store = require('../lib/store');
const { chromiumPath } = require('../lib/chromium');
const { runAccount, killChromiumForProfile } = require('./worker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Is `captionSnip` already LIVE in the group's public feed (FB auto-released the held original)?
// Fail-SAFE: on any error/timeout returns false so a genuine hold still gets re-posted (a rare duplicate is
// less bad than never delivering); but a short/non-distinctive caption returns false too (can't confirm).
// Returns 'live' (original is public — don't re-post), 'absent' (not public — safe to re-post), or
// 'session_expired' (the reserve is logged out — bail, leave the held post for retry).
async function isContentLive(account, gid, captionSnip, settings, log, shouldStop) {
  const snip = norm(captionSnip).slice(0, 40);
  if (snip.length < 12) return 'absent'; // too short to confirm presence — allow the (cap-1-bounded) re-post
  const hidden = (settings.hideBrowser !== false);
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: false, executablePath: chromiumPath(), userDataDir: store.profileDir(account.name),
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio',
        ...(hidden ? ['--window-position=-32000,-32000', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] : [])],
      defaultViewport: { width: 1280, height: 900 }, protocolTimeout: 90000,
    });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    page.on('dialog', async (d) => { try { if (d.type() === 'beforeunload') await d.accept(); else await d.dismiss(); } catch {} });
    // Stop-aware navigation: a CDP hang must not hold the caller for the full 90s after Stop.
    await Promise.race([
      page.goto(`https://www.facebook.com/groups/${gid}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 90000 }),
      new Promise((_, rej) => { const iv = setInterval(() => { if (shouldStop()) { clearInterval(iv); rej(new Error('stopped')); } }, 500); }),
    ]).catch(() => {});
    if (shouldStop()) return 'absent';
    // Session check FIRST: a logged-out reserve redirects to /login or shows the account picker — the feed
    // (and any presence verdict) is then meaningless. Surface it so the caller leaves the post for retry.
    const gate = await page.evaluate(() => {
      const t = (document.body.innerText || '').slice(0, 600).toLowerCase();
      return /log in to facebook|continue as|use another profile|create new account/.test(t) || /\/login|checkpoint/.test(location.href);
    }).catch(() => false);
    if (gate) return 'session_expired';
    await page.waitForSelector('[aria-posinset], div[role="article"]', { timeout: 20000 }).catch(() => {});
    for (let s = 0; s < 3 && !shouldStop(); s++) { await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {}); await sleep(800 + Math.floor(Math.random() * 800)); } // nudge lazy render (jittered, not metronomic)
    const found = await page.evaluate((sn) => {
      const n = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      return Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]')).slice(0, 10).some((a) => n(a.textContent).includes(sn));
    }, snip).catch(() => false);
    return found ? 'live' : 'absent';
  } catch { return 'absent'; } // best-effort: an error shouldn't permanently block delivery (cap-1 bounds any dup)
  finally { try { if (browser) await browser.close(); } catch {} }
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
  const presence = await isContentLive(account, gid, captionSnip, settings, log, shouldStop);
  if (presence === 'session_expired') {
    log(`♻️ ${where} this reserve is LOGGED OUT — not re-posting; leaving the held post for retry next cycle (re-login the account).`);
    return { posted: 0, heldRecords: [], flag: 'needs_login' };
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
    account, post, groups: o.group ? [o.group] : [], settings,
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

module.exports = { runRepost, isContentLive };
