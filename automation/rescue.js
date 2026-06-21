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
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const store = require('../lib/store');
const { chromiumPath } = require('../lib/chromium');
const { addFirstComment } = require('./worker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * Math.max(0, b - a + 1));

// o: { account, tasks, settings, hidden, log, shouldStop, onResult(task, outcome) }
//   outcome: 'done' | 'failed' | 'skipped' | 'notfound' | 'blocked' | 'error'
// Returns { placed, failed, blocked, needsLogin }.
async function runRescue(o) {
  const { account, tasks, settings = {}, log } = o;
  const shouldStop = o.shouldStop || (() => false);
  const hidden = o.hidden !== false; // default hidden, mirrors the worker
  const name = account.name;
  const out = { placed: 0, failed: 0, blocked: false, needsLogin: false };
  let browser = null;
  try {
    log(`💬 [rescue:${name}] placing ${tasks.length} orphaned link-comment(s) on live posts…`);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromiumPath(),
      userDataDir: store.profileDir(name),
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio',
        ...(hidden ? ['--window-position=-32000,-32000', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] : [])],
      defaultViewport: { width: 1280, height: 900 },
      protocolTimeout: 90000,
    });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    // beforeunload guard (same as the worker) so navigation never hangs on the native dialog.
    page.on('dialog', async (d) => { try { if (d.type() === 'beforeunload') await d.accept(); else await d.dismiss(); } catch {} });

    // Probe the session — NEVER auto-login. If it's logged out, leave its tasks pending for next cycle.
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2500);
    const loggedIn = await page.evaluate(() => {
      const t = (document.body.innerText || '').slice(0, 600).toLowerCase();
      return !(/log in to facebook|create new account|connexion|cr[ée]er un compte/.test(t) && document.querySelector('input[name="email"], input[name="pass"]'));
    }).catch(() => true);
    if (!loggedIn) { log(`⚠️ [rescue:${name}] not logged in — skipping (its queued comments stay pending)`); out.needsLogin = true; return out; }

    for (let i = 0; i < tasks.length; i++) {
      if (shouldStop()) break;
      const t = tasks[i];
      const label = t.groupName || t.gid;
      try {
        const post = { comment: t.comment || '', caption: t.postCaption || '' };
        // Pass the original POSTER's display name as the expected author — the rescue account is different,
        // but the post was authored by the poster, so the author-gate confirms we comment on the right post
        // (and addFirstComment ignores a non-FB local postId). Fail-closed: it skips if it can't confirm.
        const res = await addFirstComment(page, t.gid, post, t.commentImg || null,
          (m) => log(`💬 [rescue:${name}] [${label}] ${m}`),
          t.postPermalink || null, settings, t.postId || null, t.fbDisplayName || '');
        if (res === 'posted' || res === 'unconfirmed' || res === 'not_visible') {
          out.placed++; o.onResult && o.onResult(t, 'done');
          log(`💬 [rescue:${name}] ✅ link-comment placed on a "${label}" post (${res})`);
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
      if (i < tasks.length - 1 && !shouldStop() && !out.blocked) {
        const lo = Number.isFinite(settings.commentDelayMin) ? settings.commentDelayMin : 60;
        const hi = Number.isFinite(settings.commentDelayMax) ? settings.commentDelayMax : 180;
        await sleep(rand(Math.min(lo, hi), Math.max(lo, hi)) * 1000);
      }
    }
    log(`💬 [rescue:${name}] done — placed=${out.placed} failed=${out.failed}${out.blocked ? ' (stopped: rate-limited)' : ''}`);
    return out;
  } catch (e) { log(`❌ [rescue:${name}] ${e.message}`); return out; }
  finally { try { if (browser) await Promise.race([browser.close().catch(() => {}), sleep(8000)]); } catch {} }
}

module.exports = { runRescue };
