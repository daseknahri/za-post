// scripts/experiment-composer-preopen.js
//
// EXPERIMENT ONLY — does NOT change the app or the posting flow, and NEVER clicks Post/publish.
// Question it answers (before we invest in the composer-preopen feature):
//   1. Does Facebook render a composer in a BACKGROUND tab (visibilityState=hidden) with our
//      anti-throttle flags, and how fast vs the ACTIVE tab (on the same account/groups)?
//   2. Is that composer actually SUBMITTABLE (Post button enabled + file <input> present),
//      not just a mounted shell?
//   3. How long does an idle background composer SURVIVE before FB collapses it?
//   4. Would the pipeline's dismissPopups() close it (is a composer "Close" button present)?
//
// Usage:  node scripts/experiment-composer-preopen.js [accountName]
// Reuses the REAL launchStealth + the real account profile/session; pre-publish only.

const fs = require('fs');
const path = require('path');
const { launchStealth, viewportFor } = require('../lib/browser');

const USER_DATA = path.join(process.env.APPDATA || '', 'za-post-restored');
const sanitize = (n) => String(n || '').replace(/[^A-Za-z0-9_-]/g, '_');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

// Faithful replica of openComposer's trigger-find (worker.js:722-773): locate the "Write something…"
// composer entry point by its localized placeholder/label and return click coords. No app import.
async function findComposerTrigger(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const wanted = ['write something', "what's on your mind", 'start a discussion', 'create a public post',
      'write a public', 'write post', 'irj valamit', 'mi jar a fejedben', 'bejegyzes letrehozasa',
      'beszelgetes inditasa', 'ecrivez quelque chose', 'creer une publication', 'ecrire une publication',
      'quoi de neuf', 'publiez quelque chose', 'exprimez-vous'];
    const reject = ['search', 'comment', 'message', 'photo/video', 'live video', 'reels', 'rechercher', 'commenter'];
    const all = Array.from(document.querySelectorAll('[role="button"], span, div'));
    const matches = [];
    for (const el of all) {
      const raw = [el.getAttribute('aria-label'), el.getAttribute('aria-placeholder'), el.textContent].filter(Boolean).join(' ');
      const t = norm(raw).replace(/\s+/g, ' ').trim();
      if (!t || t.length > 100) continue;
      if (!wanted.some((w) => t.includes(w))) continue;
      if (reject.some((w) => t.includes(w))) continue;
      const btn = el.closest('[role="button"]') || el;
      const r = btn.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      matches.push({ btn, score: (r.top < innerHeight * 0.75 ? 2 : 0) + (btn.getAttribute('role') === 'button' ? 1 : 0) });
    }
    matches.sort((a, b) => b.score - a.score);
    const btn = matches[0] && matches[0].btn;
    if (!btn) return null;
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width * 0.5, y: r.y + r.height * 0.5 };
  }).catch(() => null);
}

// Is the composer OPEN, and is it SUBMITTABLE (Post button enabled + file input present)?
async function probeComposer(page) {
  return page.evaluate(() => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const dlg = document.querySelector('div[role="dialog"]');
    if (!dlg) return { open: false };
    const editor = dlg.querySelector('[contenteditable="true"], [role="textbox"]');
    // Post button enabled?
    const postLabels = ['post', 'publish', 'share', 'publier', 'partager', 'compartir', 'teilen', 'kozzetetel', 'condividi'];
    const btns = Array.from(dlg.querySelectorAll('[role="button"], button'));
    let postBtn = null;
    for (const b of btns) {
      const t = norm(b.getAttribute('aria-label') || b.textContent || '');
      if (postLabels.some((w) => t === w || t === w + '!' )) { postBtn = b; break; }
    }
    const postEnabled = !!postBtn && postBtn.getAttribute('aria-disabled') !== 'true' && !postBtn.disabled;
    const fileInput = !!dlg.querySelector('input[type="file"]');
    // Close button present (what dismissPopups would click)?
    const closeLabels = ['close', 'fermer', 'schliessen', 'cerrar', 'chiudi', 'bezaras', 'fechar'];
    const closeBtn = btns.find((b) => { const t = norm(b.getAttribute('aria-label') || ''); return closeLabels.some((w) => t.includes(w)); });
    return {
      open: !!editor,
      postBtnFound: !!postBtn,
      postEnabled,
      fileInput,
      closeBtnLabel: closeBtn ? (closeBtn.getAttribute('aria-label') || '').slice(0, 30) : null,
      visibility: document.visibilityState,
    };
  }).catch(() => ({ open: false, err: true }));
}

async function openComposerTimed(page, label, log) {
  const vis = await page.evaluate(() => document.visibilityState).catch(() => '?');
  log(`[${label}] tab visibilityState = ${vis}  |  url = ${page.url().slice(0, 60)}`);
  // Stale-session / logged-out wall (the URL may not redirect but the body shows a login prompt).
  const pre = await page.evaluate(() => {
    const b = (document.body.innerText || '').toLowerCase();
    return { loggedOut: /log in to facebook|continue as|use another profile|create new account/.test(b),
      articles: document.querySelectorAll('[aria-posinset], div[role="article"]').length,
      snippet: b.replace(/\s+/g, ' ').slice(0, 140) };
  }).catch(() => ({}));
  if (pre.loggedOut) { log(`[${label}] ❌ session LOGGED OUT (body: "${pre.snippet}")`); return { ok: false, vis }; }
  // FEED-RENDER GATE — mirrors openComposer (worker.js:711-714): wait up to 20s for the feed OR the
  // composer text to actually render (FB loads the feed async AFTER domcontentloaded; searching before
  // this gate is why the first pass found nothing).
  await page.waitForFunction(() => {
    if (document.querySelectorAll('[aria-posinset], div[role="article"]').length > 0) return true;
    return Array.from(document.querySelectorAll('[role="button"], span, div')).some((e) => /write something|what'?s on your mind|quoi de neuf|ecrivez quelque chose|écrivez quelque chose|que estas pensando/i.test(e.textContent || ''));
  }, { timeout: 20000 }).catch(() => {});
  const t0 = Date.now();
  let openedAt = null;
  for (let attempt = 1; attempt <= 4 && openedAt === null; attempt++) {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {}); // clear a focused type-ahead that can hide the trigger
    await sleep(1500);
    const pt = await findComposerTrigger(page);
    if (pt) { await page.mouse.move(pt.x, pt.y).catch(() => {}); await page.mouse.click(pt.x, pt.y, { delay: 50 }).catch(() => {}); }
    const ok = await page.waitForSelector('div[role="dialog"] [contenteditable="true"], div[role="dialog"] [role="textbox"]', { timeout: attempt === 1 ? 6000 : 9000 }).then(() => true).catch(() => false);
    if (ok) { openedAt = Date.now(); break; }
    const hint = await page.evaluate(() => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      return { articles: document.querySelectorAll('[aria-posinset], div[role="article"]').length,
        composerHits: Array.from(document.querySelectorAll('[role="button"], span, div')).filter((e) => /write something|what.s on your mind|quoi de neuf|ecrivez quelque chose/i.test(norm(e.textContent || ''))).length };
    }).catch(() => ({}));
    log(`[${label}]   attempt ${attempt}/4 miss (articles=${hint.articles}, composer-text=${hint.composerHits})`);
  }
  if (openedAt === null) { log(`[${label}] ❌ composer NOT opened after 4 attempts`); return { ok: false, vis }; }
  const openMs = openedAt - t0;
  // After the dialog mounts, poll up to 8s for it to become SUBMITTABLE (Post enabled + file input).
  let submittableAt = null, last = null;
  const dl = Date.now() + 8000;
  while (Date.now() < dl) {
    const p = await probeComposer(page); last = p;
    if (p.open && p.postBtnFound && p.fileInput && submittableAt === null) { submittableAt = Date.now(); break; }
    await sleep(250);
  }
  const submitMs = submittableAt ? submittableAt - t0 : null;
  log(`[${label}] composer OPENED in ${secs(openMs)} | submittable ${submittableAt ? 'in ' + secs(submitMs) : 'NO (postBtnFound=' + (last && last.postBtnFound) + ' enabled=' + (last && last.postEnabled) + ' fileInput=' + (last && last.fileInput) + ')'}${last && last.closeBtnLabel ? ' | close-btn: "' + last.closeBtnLabel + '"' : ''}`);
  return { ok: true, openMs, submitMs, submittable: !!submittableAt, closeBtn: last && last.closeBtnLabel, vis, last };
}

(async () => {
  const log = (m) => console.log(m);
  const acctName = process.argv[2] || 'simo4';
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'data.json'), 'utf8')); }
  catch (e) { log('❌ cannot read data.json: ' + e.message); process.exit(1); }
  const acct = (data.accounts || []).find((a) => a.name === acctName);
  if (!acct) { log(`❌ account "${acctName}" not found`); process.exit(1); }
  const gids = (acct.assignedGroups || []).slice(0, 2);
  if (gids.length < 2) { log(`❌ account "${acctName}" needs ≥2 assigned groups (has ${gids.length})`); process.exit(1); }
  const gname = (id) => { const g = (data.groups || []).find((x) => x.id === id); return (g && g.name) || id; };
  const realGid = (id) => { const g = (data.groups || []).find((x) => x.id === id); return (g && (g.groupId || g.id)) || id; }; // internal id → real FB group id (worker.js:2358)
  const profileDir = path.join(USER_DATA, 'accounts', sanitize(acctName), 'chrome-profile');
  const vp = viewportFor(acctName);

  log(`\n=== Composer pre-open experiment — account "${acctName}" ===`);
  log(`groups: A="${gname(gids[0])}" (fb ${realGid(gids[0])})  B="${gname(gids[1])}" (fb ${realGid(gids[1])})`);
  log(`profile: ${profileDir}\n`);

  let browser;
  try {
    browser = await launchStealth({
      headless: false, userDataDir: profileDir, defaultViewport: vp, protocolTimeout: 90000,
      args: ['--mute-audio', `--window-size=${vp.width},${vp.height}`,
        // faithful to worker.js hidden mode: off-screen + the anti-throttle flags whose whole point is to
        // keep a backgrounded renderer alive — this is exactly what we're testing.
        '--window-position=-32000,-32000', '--disable-features=CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    });
  } catch (e) { log('❌ launch failed (profile locked? close the app or pick an unused account): ' + e.message); process.exit(1); }

  try {
    const pages = await browser.pages();
    const pageA = pages[0] || await browser.newPage();
    const pageB = await browser.newPage();

    // ---- BASELINE: composer on the ACTIVE tab (foreground within the browser) ----
    await pageB.bringToFront().catch(() => {}); await pageA.bringToFront().catch(() => {}); // A active
    log(`Navigating ACTIVE tab → group A …`);
    await pageA.goto(`https://www.facebook.com/groups/${realGid(gids[0])}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await pageA.waitForSelector('[aria-posinset], div[role="article"], [role="banner"]', { timeout: 20000 }).catch(() => {});
    if (/login|checkpoint/.test(pageA.url())) { log('❌ account not logged in (redirected to login/checkpoint) — re-login it and retry'); await browser.close().catch(() => {}); process.exit(1); }
    const active = await openComposerTimed(pageA, 'ACTIVE', log);

    // ---- KEY TEST: composer on a BACKGROUND tab (pageB stays behind pageA) ----
    log(`\nNavigating BACKGROUND tab → group B (kept behind the active tab) …`);
    await pageB.goto(`https://www.facebook.com/groups/${realGid(gids[1])}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await pageA.bringToFront().catch(() => {}); // ensure A is foreground → B is a TRUE background tab (visibility hidden)
    await sleep(500);
    const background = await openComposerTimed(pageB, 'BACKGROUND', log);

    // ---- SURVIVAL: how long does the idle background composer stay open? ----
    if (background.ok) {
      log(`\nSurvival check (background composer left idle) …`);
      let collapsedAt = null;
      for (let s = 15; s <= 90 && collapsedAt === null; s += 15) {
        await sleep(15000);
        const p = await probeComposer(pageB);
        log(`  +${s}s: composer ${p.open ? 'still OPEN' : 'CLOSED (collapsed)'}`);
        if (!p.open) collapsedAt = s;
      }
      log(collapsedAt ? `  → background composer collapsed after ~${collapsedAt}s idle` : `  → survived ≥90s idle`);
    }

    // ---- VERDICT ----
    log(`\n=== VERDICT ===`);
    log(`background tab was hidden:   ${background.vis === 'hidden' ? 'YES (valid test)' : 'NO (vis=' + background.vis + ' — test not representative!)'}`);
    log(`background composer opened:  ${background.ok ? 'YES in ' + secs(background.openMs) : 'NO'}   (active baseline: ${active.ok ? secs(active.openMs) : 'failed'})`);
    log(`background SUBMITTABLE:       ${background.submittable ? 'YES in ' + secs(background.submitMs) : 'NO — mount≠submittable (F7 confirmed)'}`);
    log(`dismissPopups would close it: ${background.closeBtn ? 'YES — "' + background.closeBtn + '" (F1 confirmed)' : 'no close-btn in dialog'}`);
    const faster = background.ok && active.ok && background.openMs <= active.openMs * 1.25;
    log(`\n>>> Feature viable? ${background.ok && background.submittable && faster && background.vis === 'hidden' ? 'MAYBE — background render works & is submittable' : 'LIKELY NO — ' + (!background.ok ? 'background never rendered' : !background.submittable ? 'not submittable' : background.vis !== 'hidden' ? 'test invalid (tab not hidden)' : 'not faster than active')}`);
  } catch (e) {
    log('❌ experiment error: ' + (e && e.message));
  } finally {
    await browser.close().catch(() => {});
    log('\n(experiment done — no posts made, browser closed)');
  }
})();
