// automation/worker.js
// Drives ONE Facebook account through its assigned groups for a single post.
// Uses puppeteer-extra + stealth, a persistent per-account Chromium profile, and
// optional SOCKS5 proxy. Best-effort, defensive selectors with verbose logging.

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
let axios; try { axios = require('axios'); } catch {}
let proxyChain; try { proxyChain = require('proxy-chain'); } catch {}

const store = require('../lib/store');
const { chromiumPath } = require('../lib/chromium');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Download a remote image to a temp file; return its path (or null).
async function downloadImage(url) {
  if (!axios || !url) return null;
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const ext = (String(url).match(/\.(jpg|jpeg|png|gif|webp)/i) || [, 'jpg'])[1];
    const file = path.join(os.tmpdir(), `za-img-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
    fs.writeFileSync(file, Buffer.from(res.data));
    return file;
  } catch { return null; }
}

// Selector banks — FB changes these often, so we try several and take the first hit.
const SEL = {
  composerOpen: [
    '[role="button"][aria-label*="Write"]',
    '[aria-placeholder*="Write something"]',
    'div[role="button"]:has-text("Write something")', // ignored by puppeteer; kept for reference
    'span:has-text("Write something")',
  ],
  fileInput: 'input[type="file"][accept*="image"], input[type="file"]',
  postButton: ['[aria-label="Post"]', 'div[role="button"][aria-label="Post"]'],
  commentBox: [
    '[aria-label*="Write a comment"]',
    '[aria-label*="Comment"]',
    'div[contenteditable="true"][aria-label*="omment"]',
  ],
};

// Parse a stored proxy string "scheme://ip:port[:user:pass]" -> parts + upstream URL.
function parseProxy(str) {
  if (!str) return null;
  const m = String(str).match(/^(\w+):\/\/([^:]+):(\d+)(?::([^:]+):(.+))?$/);
  if (!m) return null;
  const [, scheme, ip, port, user, pass] = m;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : '';
  return { scheme, server: `${scheme}://${ip}:${port}`, username: user || null, password: pass || null,
    upstream: `${scheme}://${auth}${ip}:${port}` };
}

// Locate the first visible matching selector IN-PAGE (fast, no hang), then click it
// with a REAL mouse event at its coordinates. Facebook's React triggers (esp. the
// composer "Write something…") ignore synthetic el.click(); page.mouse.click sends a
// genuine event AND avoids the ElementHandle.click() protocolTimeout hang.
async function clickPoint(page, selectors, timeout = 8000) {
  const sels = selectors.filter((s) => !s.includes(':has-text'));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pt = await page.evaluate((ss) => {
      for (const s of ss) {
        const el = document.querySelector(s);
        if (el) {
          const r0 = el.getBoundingClientRect();
          if (r0.width && r0.height) { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
        }
      }
      return null;
    }, sels).catch(() => null);
    if (pt) { await page.mouse.click(pt.x, pt.y, { delay: 40 }).catch(() => {}); return true; }
    await sleep(400);
  }
  return false;
}
const clickFirst = clickPoint; // back-compat alias

// Find a "Write something" entry by visible text when aria selectors miss.
async function openComposerByText(page) {
  // Real mouse click at the trigger's coordinates (synthetic click won't open FB's composer).
  const pt = await page.evaluate(() => {
    const wanted = ['write something', 'write a public', 'create a public post', 'start a discussion'];
    const els = Array.from(document.querySelectorAll('div[role="button"], span, div'));
    const el = els.find((e) => wanted.some((w) => (e.textContent || '').toLowerCase().includes(w)));
    if (el) { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    return null;
  }).catch(() => null);
  if (pt) { await page.mouse.click(pt.x, pt.y, { delay: 40 }).catch(() => {}); return true; }
  return false;
}

// Robust composer opener: the FB group "Write something…" trigger has NO aria-label
// (the text lives in a placeholder span), so target the SHORT-text placeholder, walk
// up to its clickable [role=button], real-mouse-click it, and WAIT for the composer
// dialog's editable to actually appear. Retries — returns true only when it opened.
async function openComposer(page, log, name) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    // The composer lives at the TOP of the feed — make sure we're there and nothing covers it.
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(600);
    await dismissPopups(page);
    const pt = await page.evaluate(() => {
      const wanted = ['write something', "what's on your mind", 'start a discussion', 'create a public post', 'write a public'];
      const all = Array.from(document.querySelectorAll('span, div, [role="button"]'));
      const el = all.find((e) => { const t = (e.textContent || '').trim().toLowerCase(); return wanted.some((w) => t.includes(w)) && t.length < 45; });
      if (!el) return null;
      const btn = el.closest('[role="button"]') || el;
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (pt) await page.mouse.click(pt.x, pt.y, { delay: 50 }).catch(() => {});
    const ok = await page.waitForSelector('div[role="dialog"] [contenteditable="true"], div[role="dialog"] [role="textbox"]', { timeout: 6000 }).then(() => true).catch(() => false);
    if (ok) { if (attempt > 1 && log) log(`📝 [${name}] composer opened (attempt ${attempt})`); return true; }
    await sleep(1500);
  }
  return false;
}

async function clickPostButton(page) {
  // Find the enabled "Post" button (prefer one inside an open dialog), return its
  // coordinates, and click with a REAL mouse event — synthetic .click() doesn't submit
  // on web.facebook.com (same reason the composer trigger needs a real click).
  const pt = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const scope = dialogs.length ? dialogs : [document];
    for (const root of scope) {
      const btn = Array.from(root.querySelectorAll('[role="button"]')).find((b) => {
        const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
        return label === 'post' && b.getAttribute('aria-disabled') !== 'true';
      });
      if (btn) { btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
    return null;
  }).catch(() => null);
  if (pt) { await page.mouse.click(pt.x, pt.y, { delay: 40 }).catch(() => {}); return true; }
  return false;
}

// Confirm the post actually published: the composer dialog closes OR the enabled
// "Post" button disappears. Returns 'published' or 'timeout'.
async function waitForPublish(page, dialogCountBefore, timeout = 30000) {
  await sleep(1500); // let the click take effect before the first check (avoid false positive)
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const dialogCount = await page.evaluate(() => document.querySelectorAll('div[role="dialog"]').length).catch(() => -1);
    if (dialogCount >= 0 && dialogCountBefore > 0 && dialogCount < dialogCountBefore) return 'published';
    const sig = await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      if (/pending|in review|will be reviewed|shared once approved|post is pending|posted to the group/.test(t)) return 'submitted';
      const hasEnabledPost = Array.from(document.querySelectorAll('div[role="dialog"] [role="button"]'))
        .some((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase() === 'post' && b.getAttribute('aria-disabled') !== 'true');
      return hasEnabledPost ? 'open' : 'gone';
    }).catch(() => 'open');
    if (sig === 'gone' || sig === 'submitted') return 'published';
    await sleep(2000);
  }
  return 'timeout';
}

// Detect the "pending admin approval" state moderated groups show after posting.
async function checkPendingApproval(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return /post (is |will be |has been )?(pending|in review|reviewed|shared once approved)|waiting for (admin|moderator) approval|pending approval|your post is pending/i.test(t);
    });
  } catch { return false; }
}

// Human-like typing: type in chunks with a per-char delay and small randomized pauses
// between chunks. Tuned for speed while staying human-plausible (FB doesn't scrutinize
// keystroke timing in the composer the way it does navigation/IP/account signals).
async function humanType(page, text) {
  if (!text) return;
  const chunks = String(text).match(/.{1,12}/gs) || [];
  for (const c of chunks) {
    // Cap each chunk at 15s: a hung CDP connection otherwise blocks for the full
    // protocolTimeout (90s) PER chunk, stalling the worker slot for many minutes. On
    // timeout the group-level catch skips this group instead of freezing the queue.
    // The timer is always cleared so it can't fire a stray rejection after success.
    let timer;
    const cap = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('keyboard.type timeout')), 15000); });
    try {
      await Promise.race([page.keyboard.type(c, { delay: 5 + Math.floor(Math.random() * 12) }), cap]);
    } finally { clearTimeout(timer); }
    await sleep(30 + Math.floor(Math.random() * 90));
  }
}

// Dismiss the modals Facebook throws up (cookie banner, "Turn on notifications",
// "Your post might be reviewed", generic dialogs). Best-effort, never throws.
async function dismissPopups(page) {
  try {
    await page.evaluate(() => {
      const wants = ['allow all cookies', 'decline optional cookies', 'only allow essential', 'not now', 'ok', 'close', 'cancel', 'maybe later', 'got it'];
      const clickable = Array.from(document.querySelectorAll('[role="button"], button, [aria-label]'));
      for (const el of clickable) {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        if (label === 'close' || wants.includes(label)) {
          const r = el.getBoundingClientRect();
          if (r.width && r.height) { el.click(); }
        }
      }
    });
  } catch {}
  await sleep(500);
}

// Detect a rate-limit / temporary block wall so we can back off instead of failing silently.
async function checkRateLimit(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return /you're temporarily blocked|temporarily restricted|doing this too (often|quickly)|try again later|action blocked/.test(t);
    });
  } catch { return false; }
}

// Run a page.evaluate that can NEVER hang to the protocolTimeout — bail after `ms`.
// FB feed scans (over many article nodes) can otherwise block for the full 90s and
// fail the whole comment step (the "Runtime.callFunctionOn timed out" symptom).
async function evalTimed(page, fn, arg, ms = 12000) {
  let t;
  const p = page.evaluate(fn, arg);
  p.catch(() => {}); // swallow a late rejection if the cap wins the race
  const cap = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('evaluate timeout')), ms); });
  try { return await Promise.race([p, cap]); }
  finally { clearTimeout(t); }
}

// Add the "first comment" (the link) to the JUST-published post. Reloads the group
// so the new post renders, finds the article containing our caption, and types into
// ITS "Write a public comment…" box. Returns true on success.
async function addFirstComment(page, gid, post, commentImg, name, log) {
  try {
    // Plain group URL (the chronological param renders a feed WITHOUT inline comment
    // affordances). Let the feed render; do NOT scroll (FB virtualizes the top post).
    await page.goto(`https://www.facebook.com/groups/${gid}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(5000);
    await dismissPopups(page);

    const commentBoxes = async () => {
      const all = (await page.$$('[contenteditable="true"], [role="textbox"]')).slice(0, 30);
      const out = [];
      for (const h of all) {
        const isC = await h.evaluate((el) => /comment/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-placeholder') || ''))).catch(() => false);
        if (isC) out.push(h);
      }
      return out;
    };
    const snip = (post.caption || '').replace(/\s+/g, ' ').trim().slice(0, 25);

    let boxes = await commentBoxes();
    if (!boxes.length) {
      // State 2: click the "Leave a comment" button — prefer the one in OUR post's article.
      const clicked = await evalTimed(page, (s) => {
        const arts = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 15);
        const mine = s && arts.find((a) => (a.textContent || '').includes(s));
        const scope = mine || arts[0] || document;
        const b = Array.from(scope.querySelectorAll('[role="button"]'))
          .find((e) => /leave a comment|^comment$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()));
        if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
        return false;
      }, snip, 12000).catch(() => false);
      if (clicked) { await sleep(3500); boxes = await commentBoxes(); }
    }
    log(`🔎 [${name}] ${boxes.length} comment box(es) found`);
    if (!boxes.length) return false;

    const target = boxes[0];
    // Focus via in-page scroll+focus (ElementHandle.click can hang on re-rendering feeds).
    await target.evaluate((el) => { el.scrollIntoView({ block: 'center' }); el.focus(); }).catch(() => {});
    await sleep(1000);
    if (commentImg) {
      // Scope the file input to the comment box's container ONLY (the document-level
      // input is the feed composer — never fall back to it or we'd mis-attach).
      const cInput = await target.evaluateHandle((el) => {
        const c = el.closest('[role="article"], form, [data-pagelet]') || document;
        return c.querySelector('input[type="file"]');
      }).then((h) => h.asElement()).catch(() => null);
      if (cInput) { try { await cInput.uploadFile(commentImg); log(`🖼 [${name}] comment image attached`); await sleep(2500); } catch (imgErr) { log(`⚠️ [${name}] comment image upload failed: ${imgErr.message}`); } }
      else log(`ℹ️ [${name}] comment image input not found — skipping comment image`);
    }
    await humanType(page, post.comment);
    await sleep(800);
    await page.keyboard.press('Enter');
    // Confirm submission: OUR post's comment box (scoped to the article with our caption,
    // not every box on the feed) should empty once the text is consumed.
    // Confirm by watching the box we ACTUALLY typed into: FB clears it (or re-renders it
    // away) once it accepts the comment. Tracking the real target box is far more reliable
    // than re-scanning the feed by caption (which gave false "not confirmed" negatives).
    let confirmed = false;
    const cdl = Date.now() + 6000;
    while (Date.now() < cdl) {
      await sleep(1000);
      const state = await target.evaluate((el) => (el.textContent || '').trim()).catch(() => 'GONE');
      if (state === '' || state === 'GONE') { confirmed = true; break; } // emptied or re-rendered = submitted
    }
    log(confirmed ? `💬 [${name}] comment posted` : `⚠️ [${name}] comment sent (could not auto-verify)`);
    await sleep(1000);
    return true;
  } catch (e) { log(`⚠️ [${name}] comment error: ${e.message}`); return false; }
}

// Click into the composer's editable textbox so keystrokes land in the right place
// (mirrors the original's distinct focusCaptionBox / focusCommentBox steps).
async function focusEditable(page) {
  try {
    // Target the MAIN post-body editable (by aria-label) inside the dialog — there can be
    // several contenteditables (search, etc.); clicking the wrong one loses the caption.
    const pt = await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]') || document;
      const cands = Array.from(dlg.querySelectorAll('[contenteditable="true"], [role="textbox"]'));
      const labeled = cands.find((e) => /create (a )?public post|what'?s on your mind|write something|start a discussion|^post$/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('aria-placeholder') || '')));
      const el = labeled || cands.find((e) => { const r = e.getBoundingClientRect(); return r.width > 120 && r.height > 20; }) || cands[0];
      if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 20) }; }
      return null;
    }).catch(() => null);
    if (pt) { await page.mouse.click(pt.x, pt.y, { delay: 40 }).catch(() => {}); await sleep(400); return true; }
  } catch {}
  return false;
}

// Attempt a real email+password login using the account's EXISTING page (profile is locked,
// so we cannot launch a new browser). OPT-IN: only called when account.email && account.password.
// Returns true (session recovered) or false (checkpoint/2FA/wrong-password/error).
// Never throws; relies on timeouts so it can never hang the caller indefinitely.
async function credentialLogin(page, email, password, log, name) {
  try {
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(1500);

    // Type email
    const emailSel = 'input[name="email"], #email';
    const emailFound = await page.waitForSelector(emailSel, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!emailFound) { log(`⚠️ [${name}] login form not found`); return false; }
    await page.type(emailSel, email, { delay: 30 }).catch(() => {});

    // Type password
    const passSel = 'input[name="pass"], #pass';
    const passFound = await page.waitForSelector(passSel, { timeout: 8000 }).then(() => true).catch(() => false);
    if (!passFound) { log(`⚠️ [${name}] login form not found`); return false; }
    await page.type(passSel, password, { delay: 30 }).catch(() => {});

    // Submit: try selectors in order, use the first found
    const submitSels = ['button[name="login"]', 'button[type="submit"][name="login"]', '[data-testid="royal_login_button"]'];
    let submitted = false;
    for (const sel of submitSels) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) { await btn.click().catch(() => {}); submitted = true; break; }
    }
    if (!submitted) {
      // fallback: press Enter
      await page.keyboard.press('Enter').catch(() => {});
    }
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(2000);

    const url = page.url();

    // Checkpoint / 2FA detection
    if (/checkpoint|two_step|two_factor|login\/device-based/i.test(url)) {
      log(`🚧 [${name}] hit a Facebook security check (2FA/checkpoint) — needs manual login`);
      return false;
    }
    const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
    if (/two.factor|two.step|confirm it.?s you|enter the code/i.test(bodyText)) {
      log(`🚧 [${name}] hit a Facebook security check (2FA/checkpoint) — needs manual login`);
      return false;
    }

    // Success: check for c_user cookie
    const pageCookies = await page.cookies().catch(() => []);
    if (pageCookies.some((c) => c.name === 'c_user' && c.value)) {
      log(`✅ [${name}] logged in with stored credentials`);
      store.writeCookies(name, pageCookies);
      return true;
    }

    log(`❌ [${name}] credential login failed (wrong password or blocked)`);
    return false;
  } catch (e) {
    log(`⚠️ [${name}] credential login error: ${e.message}`);
    return false;
  }
}

/**
 * @param {object}   o
 * @param {object}   o.account   account entity { name, assignedGroups, ... }
 * @param {object}   o.post      post entity { caption, comment, imagePaths[], commentImagePath, imageUrl }
 * @param {object[]} o.groups    full groups list (we filter by account.assignedGroups)
 * @param {object}   o.settings  app settings
 * @param {boolean}  o.useProxies
 * @param {string[]} o.proxies
 * @param {(msg:string)=>void} o.log
 * @param {()=>boolean} o.shouldStop
 */
async function runAccount(o) {
  const { account, post, groups, settings, useProxies, proxies, log, shouldStop, isLoginOpen } = o;
  const name = account.name;

  // Fix #4: profile-lock guard — two Chromium instances can't share a userDataDir.
  if (isLoginOpen && isLoginOpen(name)) {
    log(`🚫 [${name}] login browser is open for this account — skipping`);
    return { posted: 0, errors: 1, pendingApproval: 0, noRetry: false, flag: null, postedIds: [] };
  }

  // An account with NO assigned groups is SKIPPED (it must NOT fall back to posting to
  // every group — that would spam all groups from unconfigured accounts).
  const assigned = (account.assignedGroups && account.assignedGroups.length)
    ? groups.filter((g) => account.assignedGroups.includes(g.id) || account.assignedGroups.includes(g.groupId))
    : [];
  const targetGroups = assigned.slice(0, settings.postsPerGroup || 15);

  if (!targetGroups.length) { log(`⏭️ [${name}] no assigned groups — skipping`); return { posted: 0, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: [] }; }

  const launchArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-position=-32000,-32000',
    '--window-size=1280,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
  ];
  store.sanitizeProfile(name); // don't let Chromium reopen the previous session's tabs
  // Proxy: Chrome can't do authenticated SOCKS5 directly, so we wrap the upstream
  // through proxy-chain (a local anonymized HTTP proxy) when credentials are present.
  let proxyAuth = null, anonLocal = null, watchdog = null;
  const tempImages = []; // downloaded remote images to clean up at the end
  if (useProxies && proxies && proxies.length) {
    const p = parseProxy(proxies[Math.floor(Math.random() * proxies.length)]);
    if (p) {
      proxyAuth = p;
      if (p.username && proxyChain) {
        try { anonLocal = await proxyChain.anonymizeProxy(p.upstream); launchArgs.push(`--proxy-server=${anonLocal}`); log(`🌐 [${name}] proxy ${p.server} (auth via proxy-chain)`); }
        catch (e) { launchArgs.push(`--proxy-server=${p.server}`); log(`⚠️ [${name}] proxy-chain failed (${e.message}) — auth credentials may be dropped, expect 407s`); }
      } else { launchArgs.push(`--proxy-server=${p.server}`); log(`🌐 [${name}] proxy ${p.server}`); }
    } else {
      log(`⚠️ [${name}] proxies enabled but the proxy string is invalid — running WITHOUT proxy`);
    }
  }

  let browser;
  let posted = 0, errors = 0, pendingApproval = 0, noRetry = false, flag = null;
  try {
    browser = await puppeteer.launch({
      headless: true, // new headless (Chrome 148): renders like real Chrome but NO visible window / taskbar entry
      executablePath: chromiumPath(),
      userDataDir: store.profileDir(name),
      args: launchArgs,
      defaultViewport: { width: 1280, height: 900 },
      protocolTimeout: 90000, // cap CDP op hangs (90s allows slow www->web redirects; still << default 180s)
    });
    const _pages = await browser.pages();
    for (let i = 1; i < _pages.length; i++) { try { await _pages[i].close(); } catch {} }
    const page = _pages[0] || (await browser.newPage());
    // Allow clipboard access so captions can be PASTED (fast + reliable, like the original agent).
    try { await browser.defaultBrowserContext().overridePermissions('https://www.facebook.com', ['clipboard-read', 'clipboard-write']); } catch {}
    // Watchdog: hard cap on this account's run so one stuck account can never block the
    // whole queue. Generous (a full post+comment is ~3-4 min) so it only fires on a real
    // hang, not normal slow posts. Closing the browser makes in-flight ops reject → cleanup.
    const accountBudget = Math.max(420000, targetGroups.length * 300000);
    watchdog = setTimeout(() => { log(`⏰ [${name}] time budget exceeded — aborting account`); try { if (browser) browser.close(); } catch {} watchdog = null; }, accountBudget);
    // Fallback auth path if proxy-chain wasn't used.
    if (proxyAuth && proxyAuth.username && !anonLocal) {
      await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password }).catch(() => {});
    }

    // Auth bootstrap: PREFER the profile's own logged-in session (from an in-app
    // Login). Only inject the stored cookies.json as a fallback — injecting stale
    // cookies over a fresh session is what was logging accounts back out.
    const cookies = store.readCookies(name);
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const profileAuthed = await page.evaluate(() =>
      !/login|checkpoint/.test(location.href) && !/continue as|use another profile/i.test(document.body.innerText || '')
    ).catch(() => false);
    if (!profileAuthed && cookies.length) {
      // A2: resilient injection — batch first, fall back to one-by-one so one bad
      // cookie can't prevent all cookies from being set.
      const normalized = cookies.map(normalizeCookie);
      try {
        await page.setCookie(...normalized);
      } catch (batchErr) {
        log(`⚠️ [${name}] batch cookie set failed (${batchErr.message}) — retrying one-by-one`);
        for (const ck of normalized) { try { await page.setCookie(ck); } catch {} }
      }
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(2000);
      // Re-verify: confirm the cookie injection actually recovered the session.
      const cookieAuthed = await page.evaluate(() =>
        !/login|checkpoint/.test(location.href) && !/continue as|use another profile/i.test(document.body.innerText || '')
      ).catch(() => false);
      const hasCUser = cookieAuthed && (await page.cookies().catch(() => [])).some((c) => c.name === 'c_user' && c.value);
      if (cookieAuthed && hasCUser) {
        log(`🔄 [${name}] session recovered with saved cookies`);
      } else {
        // Cookie recovery failed — try stored credentials (OPT-IN) before flagging for manual login.
        if (account.email && account.password) {
          log(`🔐 [${name}] cookies failed — trying stored credentials...`);
          const credOk = await credentialLogin(page, account.email, account.password, log, name);
          if (credOk) {
            log(`🔄 [${name}] session recovered via credential login`);
            // fall through to the normal posting loop
          } else {
            log(`❌ [${name}] re-login with saved cookies failed — flagging for manual login`);
            flag = 'needs_login'; noRetry = true;
            return { posted: 0, errors: 1, pendingApproval: 0, noRetry, flag, postedIds: [] };
          }
        } else {
          log(`❌ [${name}] re-login with saved cookies failed — flagging for manual login`);
          flag = 'needs_login'; noRetry = true;
          return { posted: 0, errors: 1, pendingApproval: 0, noRetry, flag, postedIds: [] };
        }
      }
    } else if (profileAuthed) {
      log(`🔑 [${name}] using existing profile session`);
    }

    // Resolve images once: local files, or download remote URLs to temp.
    let resolvedImages = (post.imagePaths && post.imagePaths.length ? post.imagePaths : (post.imagePath ? [post.imagePath] : []))
      .filter((p) => p && fs.existsSync(p));
    if (!resolvedImages.length && post.imageUrl) {
      const dl = await downloadImage(post.imageUrl);
      if (dl) { resolvedImages = [dl]; tempImages.push(dl); log(`⬇️ [${name}] image downloaded from URL`); }
      else log(`⚠️ [${name}] image URL set but download failed — posting without image`);
    }
    // Comment image: explicit comment image, remote URL, or the post image when commentWithImage is on.
    let commentImg = null;
    if (post.commentImagePath && fs.existsSync(post.commentImagePath)) commentImg = post.commentImagePath;
    else if (post.commentImageUrl) { const dl = await downloadImage(post.commentImageUrl); if (dl) { commentImg = dl; tempImages.push(dl); } }
    else if (settings.commentWithImage && resolvedImages.length) commentImg = resolvedImages[0];

    for (let i = 0; i < targetGroups.length; i++) {
      if (shouldStop()) { log(`⏹ [${name}] stop requested`); break; }
      const g = targetGroups[i];
      const gid = g.groupId || g.id;
      try {
        log(`➡️ [${name}] navigating to group ${g.name || gid} (${i + 1}/${targetGroups.length})`);
        const gotoGroup = () => page.goto(`https://www.facebook.com/groups/${gid}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => true).catch(() => false);
        let navOk = await gotoGroup();
        if (!navOk) { log(`⚠️ [${name}] first navigation attempt failed — retrying…`); await sleep(3000); navOk = await gotoGroup(); }
        if (!navOk) { log(`❌ [${name}] navigation failed for ${g.name || gid} — skipping group`); errors++; continue; }
        await sleep(3000);

        // Per-group START banner — fired only after nav succeeds and before the auth checks.
        log(`📂 [${name}] GROUP: ${g.name || gid}`);

        if (/login|checkpoint/.test(page.url())) { log(`🚫 [${name}] not logged in / checkpoint`); errors++; noRetry = true; flag = 'needs_login'; break; }
        // Expired sessions don't redirect — they show the "Continue as <name>" picker
        // or a non-member "Join Group / Log in" wall. Detect and abort early & clearly.
        const authBad = await page.evaluate(() => {
          const t = document.body.innerText || '';
          const hasBtn = (re) => Array.from(document.querySelectorAll('[role="button"],span,a,button')).some((e) => re.test((e.textContent || '').trim()));
          if (/continue as|use another profile/i.test(t)) return 'session-expired';
          if (hasBtn(/^join group$/i) && hasBtn(/^log in$/i)) return 'not-authenticated';
          return null;
        });
        if (authBad) { log(`🚫 [${name}] ${authBad === 'session-expired' ? 'session expired — re-login required' : 'not logged in / not a member'} (${g.name || gid})`); errors++; noRetry = true; flag = 'needs_login'; break; }

        // Clear cookie/notification banners, then bail out of this account if rate-limited.
        await dismissPopups(page);
        if (await checkRateLimit(page)) { log(`⏸ [${name}] rate-limited by Facebook — backing off this account`); errors++; noRetry = true; flag = 'rate_limited'; break; }

        // Open the composer and CONFIRM the dialog actually opened (the FB trigger has
        // no aria-label — match the placeholder text — and the click must be verified).
        const opened = await openComposer(page, log, name);
        if (!opened) { log(`❌ [${name}] could not open the post composer in ${g.name || gid}`); errors++; continue; }
        await sleep(1500);
        await dismissPopups(page);

        const captionLen = () => page.evaluate(() => { const d = document.querySelector('div[role="dialog"]'); const e = d && d.querySelector('[contenteditable="true"]'); return e ? (e.textContent || '').trim().length : 0; }).catch(() => 0);

        // Image FIRST, then caption — mirrors the original agent. Paste is atomic so the
        // image's re-render can't clobber the caption. Scope the file input to the DIALOG.
        if (resolvedImages.length) {
          log(`📷 [${name}] uploading ${resolvedImages.length} image(s)...`);
          const input = (await page.$('div[role="dialog"] input[type="file"]')) || (await page.$(SEL.fileInput));
          if (input) { await input.uploadFile(...resolvedImages); log(`✅ [${name}] image attached`); await sleep(3500); }
          else log(`⚠️ [${name}] image input not found in composer`);
        }

        // Caption — PASTE it (clipboard + Ctrl+V, like the original "Caption pasted"); fast and
        // reliable. Verify it landed; if not, fall back to typing so the post still goes out.
        if (post.caption) {
          log(`✍️ [${name}] entering caption...`);
          await focusEditable(page);
          try {
            await page.evaluate((t) => navigator.clipboard.writeText(t), post.caption);
            await page.keyboard.down('Control'); await page.keyboard.press('v'); await page.keyboard.up('Control');
            await sleep(600);
          } catch {}
          if (!(await captionLen())) { // paste blocked → clear + type
            log(`⌨️ [${name}] paste blocked — typing caption instead`);
            await focusEditable(page);
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
            await page.keyboard.press('Backspace'); await sleep(150);
            await humanType(page, post.caption); await sleep(600);
          }
          log((await captionLen()) ? `✅ [${name}] caption pasted` : `⚠️ [${name}] caption could not be entered (posting anyway)`);
        }

        // Publish — then CONFIRM it actually published (dialog closed / Post button gone).
        await sleep(1500);
        log(`⏳ [${name}] waiting for Post button…`);
        const dialogCountBefore = await page.evaluate(() => document.querySelectorAll('div[role="dialog"]').length).catch(() => 1);
        // Log what the Post-button scan sees (dialogs open, found label) — mirrors original's "🔍 Dialogs: N".
        const postBtnInfo = await page.evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
          const scope = dialogs.length ? dialogs : [document];
          for (const root of scope) {
            const btn = Array.from(root.querySelectorAll('[role="button"]')).find((b) => {
              const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
              return label === 'post' && b.getAttribute('aria-disabled') !== 'true';
            });
            if (btn) return { found: true, dialogs: dialogs.length, label: (btn.getAttribute('aria-label') || btn.textContent || '').trim() };
          }
          return { found: false, dialogs: dialogs.length };
        }).catch(() => null);
        if (postBtnInfo) {
          if (postBtnInfo.found) log(`🔍 [${name}] Post button: found (dialogs=${postBtnInfo.dialogs}, label="${postBtnInfo.label}")`);
          else log(`🔍 [${name}] Post button NOT found (${postBtnInfo.dialogs} dialog(s) scanned)`);
        }
        const clicked = await clickPostButton(page);
        if (!clicked) { log(`⚠️ [${name}] Post button not found in ${g.name || gid}`); errors++; continue; }
        const publishResult = await waitForPublish(page, dialogCountBefore);
        if (publishResult !== 'published') { log(`⚠️ [${name}] Post clicked but publish NOT confirmed in ${g.name || gid} — skipping`); errors++; continue; }
        await sleep(3000);
        // Check pending-approval BEFORE dismissing popups (a dismissible notice could be cleared).
        const isPending = await checkPendingApproval(page);
        await dismissPopups(page); // clear "Your post might be reviewed" etc.

        // Moderated groups queue posts for admin approval — don't count as posted and
        // skip the comment (the post isn't in the feed yet).
        if (isPending) {
          log(`⏳ [${name}] Post submitted but PENDING ADMIN APPROVAL in ${g.name || gid} — not counted, comment skipped`);
          pendingApproval++;
          if (i < targetGroups.length - 1) { let w = 0, d = Math.max(15000, (Number.isFinite(settings.groupDelay) ? settings.groupDelay : 60) * 1000); while (w < d && !shouldStop()) { await sleep(Math.min(1000, d - w)); w += 1000; } }
          continue;
        }

        // Success log includes the caption so the renderer's auto-delete tracker matches it.
        log(`✅ [${name}] Posted! → ${g.name || gid}: ${(post.caption || '').slice(0, 50)}`);
        posted++;

        // First comment (the link) — reload, find OUR post, comment in its box.
        if (post.comment) {
          log(`💬 [${name}] adding comment...`);
          const done = await addFirstComment(page, gid, post, commentImg, name, log);
          if (!done) log(`ℹ️ [${name}] comment box not found (post still published)`);
        }
      } catch (e) {
        errors++;
        log(`❌ [${name}] error in ${gid}: ${e.message}`);
        try { await page.screenshot({ path: require('path').join(store.accountDir(name), 'last-failure.png') }); } catch {}
      }

      // Interruptible delay between groups (respects Stop + configurable groupDelay).
      if (i < targetGroups.length - 1) {
        let w = 0; const d = Math.max(15000, (Number.isFinite(settings.groupDelay) ? settings.groupDelay : 60) * 1000);
        log(`⏱️ [${name}] waiting ${Math.round(d / 1000)}s before next group`);
        while (w < d && !shouldStop()) { await sleep(Math.min(1000, d - w)); w += 1000; }
      }
    }
    log(`✅ [${name}] done — ${posted} posted, ${pendingApproval} pending, ${errors} errors`);

    // Persist refreshed cookies for next run.
    try { store.writeCookies(name, await page.cookies()); } catch {}
    fs.writeFileSync(require('path').join(store.accountDir(name), 'last-run-success.txt'),
      `${errors === 0 ? 'SUCCESS' : 'PARTIAL'}\nPosts: ${posted}\nPending: ${pendingApproval}\nTime: ${new Date().toISOString()}\n`);
  } catch (e) {
    errors++;
    log(`❌ [${name}] fatal: ${e.message}`);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
    if (anonLocal && proxyChain) { try { await proxyChain.closeAnonymizedProxy(anonLocal, true); } catch {} }
    for (const t of tempImages) { try { fs.unlinkSync(t); } catch {} }
  }
  return { posted, errors, pendingApproval, noRetry, flag };
}

// Strip fields Puppeteer's setCookie rejects; coerce sameSite.
// A1: default domain to .facebook.com if missing; wrap so one bad cookie can't throw.
function normalizeCookie(c) {
  try {
    const out = {
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
    };
    if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
    if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') out.secure = c.secure;
    const ss = String(c.sameSite || '').toLowerCase();
    out.sameSite = ss === 'lax' ? 'Lax' : ss === 'strict' ? 'Strict' : 'None';
    return out;
  } catch {
    return { name: String(c && c.name || '__bad__'), value: '', domain: '.facebook.com', path: '/' };
  }
}

module.exports = {
  runAccount, parseProxy, normalizeCookie, addFirstComment,
  // exported for diagnostics — use the EXACT worker logic
  clickFirst, openComposerByText, openComposer, focusEditable, humanType, dismissPopups, clickPostButton, waitForPublish,
};
