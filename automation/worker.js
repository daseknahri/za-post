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

async function sleepInterruptible(ms, shouldStop = () => false, step = 500) {
  let waited = 0;
  while (waited < ms && !shouldStop()) {
    const chunk = Math.min(step, ms - waited);
    await sleep(chunk);
    waited += chunk;
  }
  return !shouldStop();
}

function shortText(text, max = 90) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createStepLogger(log, accountName, groupName) {
  let n = 0;
  return (message) => {
    n += 1;
    log(`[${accountName}] [${displayName(groupName)}] ${String(n).padStart(2, '0')} ${message}`);
  };
}

function displayName(value) {
  const text = String(value || '');
  if (!/[ÃÂ]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    return repaired && !repaired.includes('\uFFFD') ? repaired : text;
  } catch {
    return text;
  }
}

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
    const wanted = [
      'write something',
      "what's on your mind",
      'write a public',
      'create a public post',
      'start a discussion',
      'write post',
      'irj valamit',
      'írj valamit',
      'mi jar a fejedben',
      'mi jár a fejedben',
      'bejegyzes letrehozasa',
      'bejegyzés létrehozása',
      'beszelgetes inditasa',
      'beszélgetés indítása',
    ];
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
    if (log) log(`Opening composer (attempt ${attempt}/4)`);
    // The composer lives at the TOP of the feed — make sure we're there and nothing covers it.
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(600);
    await dismissPopups(page);
    const pt = await page.evaluate(() => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const wanted = [
        'write something',
        "what's on your mind",
        'start a discussion',
        'create a public post',
        'write a public',
        'write post',
        'irj valamit',
        'mi jar a fejedben',
        'bejegyzes letrehozasa',
        'beszelgetes inditasa',
      ];
      const reject = ['search', 'comment', 'message', 'photo/video', 'live video', 'reels'];
      const all = Array.from(document.querySelectorAll('[role="button"], span, div'));
      const matches = [];
      for (const el of all) {
        const raw = [
          el.getAttribute('aria-label'),
          el.getAttribute('aria-placeholder'),
          el.textContent,
        ].filter(Boolean).join(' ');
        const t = norm(raw).replace(/\s+/g, ' ').trim();
        if (!t || t.length > 100) continue;
        if (!wanted.some((w) => t.includes(w))) continue;
        if (reject.some((w) => t.includes(w))) continue;
        const btn = el.closest('[role="button"]') || el;
        const r = btn.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        matches.push({
          btn,
          score: (r.top < innerHeight * 0.75 ? 2 : 0) + (btn.getAttribute('role') === 'button' ? 1 : 0),
        });
      }
      matches.sort((a, b) => b.score - a.score);
      const btn = matches[0] && matches[0].btn;
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (pt) await page.mouse.click(pt.x, pt.y, { delay: 50 }).catch(() => {});
    else await openComposerByText(page).catch(() => false);
    const ok = await page.waitForSelector('div[role="dialog"] [contenteditable="true"], div[role="dialog"] [role="textbox"]', { timeout: 6000 }).then(() => true).catch(() => false);
    if (ok) { if (attempt > 1 && log) log(`Composer opened (attempt ${attempt})`); return true; }
    if (log) {
      const hint = await page.evaluate(() => {
        const body = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
        const buttons = Array.from(document.querySelectorAll('[role="button"], button, a')).slice(0, 12)
          .map((b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 8);
        return { buttons, body: body.slice(0, 180) };
      }).catch(() => null);
      if (hint) log(`Composer not open yet; visible buttons: ${hint.buttons.join(' | ') || '(none)'}`);
    }
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
async function waitForPublish(page, dialogCountBefore, timeout = 30000, shouldStop = () => false) {
  await sleep(1500); // let the click take effect before the first check (avoid false positive)
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (shouldStop()) return 'stopped'; // halt promptly on Stop instead of polling for 30s
    const dialogCount = await page.evaluate(() => document.querySelectorAll('div[role="dialog"]').length).catch(() => -1);
    if (dialogCount >= 0 && dialogCountBefore > 0 && dialogCount < dialogCountBefore) return 'published';
    const sig = await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      if (/pending|in review|will be reviewed|shared once approved|post is pending|posted to the group/.test(t)) return 'submitted';
      // Explicit Facebook failure — return early instead of polling the full 30s, and never
      // count it as published (so the post is retried, not lost).
      if (/couldn.t post|can.t share|something went wrong|unable to post|failed to post|couldn.t share/.test(t)) return 'error';
      const hasEnabledPost = Array.from(document.querySelectorAll('div[role="dialog"] [role="button"]'))
        .some((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase() === 'post' && b.getAttribute('aria-disabled') !== 'true');
      return hasEnabledPost ? 'open' : 'gone';
    }).catch(() => 'open');
    if (sig === 'error') return 'error';
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
      return /you're temporarily blocked|temporarily restricted|doing this too (often|quickly)|try again later|action blocked|we limit how often|protect the community from spam|you can try again later|going too fast|posting too (often|quickly)|nous limitons|réessayer plus tard|temporairement bloqué/.test(t);
    });
  } catch { return false; }
}

// Detect Facebook's "confirm you are a real person" / identity checkpoint, which blocks the
// account from posting until the user completes it. Multilingual (EN/FR seen on these accounts).
async function checkVerification(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body.innerText || '').toLowerCase();
      if (/\/checkpoint\//.test(location.href.toLowerCase())) return true;
      return /confirm (that )?(you'?re|you are) a real person|confirm your identity|we need to confirm|we'?ll need you to confirm|confirmez que vous êtes une personne réelle|confirmer votre identité|confirme que tu es une personne réelle/.test(t);
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
async function addFirstComment(page, gid, post, commentImg, step) {
  try {
    // Header: state the comment configuration so each group's comment is self-explanatory.
    const hasText = !!(post.comment && post.comment.trim());
    const mode = hasText && commentImg ? 'text + image' : hasText ? 'text-only' : 'image-only';
    step(`Comment: starting (${mode})${hasText ? ` — "${shortText(post.comment, 50)}"` : ''}`);
    // Plain group URL (the chronological param renders a feed WITHOUT inline comment
    // affordances). Let the feed render; do NOT scroll (FB virtualizes the top post).
    step('Comment: reloading group to locate the post');
    await page.goto(`https://www.facebook.com/groups/${gid}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3000);
    await dismissPopups(page);

    // If the session died between publishing and commenting, our post won't be in the
    // feed — name that explicitly instead of reporting a vague "no comment box".
    const authBad = await page.evaluate(() => /continue as|use another profile/i.test(document.body.innerText || '')).catch(() => false);
    if (authBad) { step('Comment: session expired after posting — skipped (re-login needed)'); return false; }

    const commentBoxes = async () => {
      const all = (await page.$$('[contenteditable="true"], [role="textbox"]')).slice(0, 30);
      const out = [];
      for (const h of all) {
        const isC = await h.evaluate((el) => {
          const raw = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-placeholder') || '');
          const norm = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
          return /comment|hozzaszolas/.test(norm); // English + Hungarian "hozzaszolas" (accent-stripped)
        }).catch(() => false);
        if (isC) out.push(h);
      }
      return out;
    };
    const snip = (post.caption || '').replace(/\s+/g, ' ').trim().slice(0, 25);

    let boxes = await commentBoxes();
    if (!boxes.length) {
      // State 2: click the "Leave a comment" button — prefer the one in OUR post's article.
      step('Comment: no inline box yet — clicking "Leave a comment"');
      const clicked = await evalTimed(page, (s) => {
        const arts = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 15);
        // For short/common captions the snippet match is unreliable (could hit a pinned/banner
        // post) — prefer the NEWEST article (arts[0]), which is almost always the one we just posted.
        const mine = (s && s.length >= 12) ? arts.find((a) => (a.textContent || '').includes(s)) : null;
        const scope = mine || arts[0] || document;
        const b = Array.from(scope.querySelectorAll('[role="button"]'))
          .find((e) => {
            const norm = (e.getAttribute('aria-label') || e.textContent || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
            return /leave a comment|^comment$|hozzaszolas/.test(norm); // English + Hungarian
          });
        if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
        return false;
      }, snip, 12000).catch(() => false);
      if (clicked) { step('Comment: comment box opened'); await sleep(3500); boxes = await commentBoxes(); }
      else step('Comment: "Leave a comment" button not found');
    }
    if (!boxes.length) { step('Comment: no comment box found — comment skipped'); return false; }
    step(`Comment: ${boxes.length} comment box(es) found`);

    const target = boxes[0];
    // Focus via in-page scroll+focus (ElementHandle.click can hang on re-rendering feeds).
    step('Comment: focusing the comment box');
    await target.evaluate((el) => { el.scrollIntoView({ block: 'center' }); el.focus(); }).catch(() => {});
    await sleep(600);
    if (commentImg) {
      // Scope the file input to the comment box's container ONLY (the document-level
      // input is the feed composer — never fall back to it or we'd mis-attach).
      const cInput = await target.evaluateHandle((el) => {
        const c = el.closest('[role="article"], form, [data-pagelet]') || document;
        return c.querySelector('input[type="file"]');
      }).then((h) => h.asElement()).catch(() => null);
      if (cInput) {
        try {
          await cInput.uploadFile(commentImg);
          // Wait for the image PREVIEW to actually render before submitting, so a slow CDN
          // upload can't be dropped when Enter fires (a blind fixed delay was unreliable).
          const previewed = await page.waitForFunction(() => !!document.querySelector('[role="article"] img[src^="blob:"], [role="dialog"] img[src^="blob:"]'), { timeout: 8000 }).then(() => true).catch(() => false);
          step(previewed ? 'Comment: image attached (preview rendered)' : 'Comment: image uploaded (preview not detected — submitting anyway)');
          await sleep(1500);
        } catch (imgErr) { step(`Comment: image upload failed (${imgErr.message}) — posting text only`); }
      }
      else step('Comment: image input not found — posting text only');
    }
    // Type the comment. In a FB comment box ENTER SUBMITS, so insert newlines as Shift+Enter
    // and type the rest — otherwise a multi-line comment would submit at the first line.
    const commentText = String(post.comment || '');
    if (commentText.trim()) {
      const lines = commentText.split('\n');
      step(`Comment: typing text (${commentText.length} chars${lines.length > 1 ? `, ${lines.length} lines` : ''})`);
      for (let li = 0; li < lines.length; li++) {
        if (lines[li]) await humanType(page, lines[li]);
        if (li < lines.length - 1) { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); }
      }
      await sleep(500);
    } else if (commentImg) {
      step('Comment: image-only (no text)');
    }
    step('Comment: submitting (Enter)');
    await page.keyboard.press('Enter');
    // Confirm by watching the box we ACTUALLY typed into: FB clears it (or re-renders it
    // away) once it accepts the comment. Tracking the real target box is far more reliable
    // than re-scanning the feed by caption (which gave false "not confirmed" negatives).
    let confirmed = false;
    const cdl = Date.now() + 4000;
    while (Date.now() < cdl) {
      await sleep(1000);
      const state = await target.evaluate((el) => (el.textContent || '').trim()).catch(() => 'GONE');
      if (state === '' || state === 'GONE') { confirmed = true; break; } // emptied or re-rendered = submitted
    }
    step(confirmed ? 'Comment: posted and verified ✅' : 'Comment: sent (could not auto-verify)');
    await sleep(600);
    return true;
  } catch (e) { step(`Comment: error — ${e.message}`); return false; }
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

function normalizeForCompare(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

async function composerCaptionState(page, caption) {
  const expected = normalizeForCompare(caption).slice(0, 20);
  return page.evaluate((expectedPrefix) => {
    const normalize = (text) => String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();
    const dialog = document.querySelector('div[role="dialog"]') || document;
    const nodes = Array.from(dialog.querySelectorAll('[contenteditable="true"], [role="textbox"]'));
    const candidates = nodes.map((node, index) => {
      const raw = [
        node.innerText,
        node.textContent,
        node.getAttribute('aria-label'),
        node.getAttribute('aria-placeholder'),
      ].filter(Boolean).join('\n');
      const text = raw.replace(/\s+/g, ' ').trim();
      return {
        index,
        len: normalize(text).length,
        matched: !!expectedPrefix && normalize(text).includes(expectedPrefix),
        sample: text.slice(0, 120),
      };
    });
    const dialogText = (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
    candidates.push({
      index: -1,
      len: normalize(dialogText).length,
      matched: !!expectedPrefix && normalize(dialogText).includes(expectedPrefix),
      sample: dialogText.slice(0, 120),
    });
    candidates.sort((a, b) => Number(b.matched) - Number(a.matched) || b.len - a.len);
    return candidates[0] || { index: null, len: 0, matched: false, sample: '' };
  }, expected).catch(() => ({ index: null, len: 0, matched: false, sample: '' }));
}

async function waitForCaptionState(page, caption, timeout = 5000) {
  const end = Date.now() + timeout;
  let last = { index: null, len: 0, matched: false, sample: '' };
  while (Date.now() < end) {
    last = await composerCaptionState(page, caption);
    if (last.matched) return last;
    await sleep(350);
  }
  return last;
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

// Strip a window's taskbar button via WS_EX_TOOLWINDOW so a hidden run shows NO taskbar icon,
// while leaving it a real composited window (Facebook still publishes). Best-effort, Windows-only.
function hideFromTaskbar(pid) {
  if (process.platform !== 'win32' || !pid) return Promise.resolve();
  const ps = [
    `$tp=${pid}`,
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class W{',
    '[DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc cb,IntPtr l);',
    '[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);',
    '[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);',
    '[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);',
    '[DllImport("user32.dll")]public static extern int SetWindowLong(IntPtr h,int i,int v);',
    '[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int n);',
    'public delegate bool EnumProc(IntPtr h,IntPtr l);}',
    '"@',
    '$cb=[W+EnumProc]{param($h,$l)',
    '$wp=0;[W]::GetWindowThreadProcessId($h,[ref]$wp)|Out-Null',
    'if($wp -eq $tp -and [W]::IsWindowVisible($h)){',
    '$ex=[W]::GetWindowLong($h,-20)',
    '[W]::ShowWindow($h,0)|Out-Null',
    '[W]::SetWindowLong($h,-20,($ex -bor 0x80) -band (-bnot 0x40000))|Out-Null',
    '[W]::ShowWindow($h,8)|Out-Null}',
    'return $true}',
    '[W]::EnumWindows($cb,[IntPtr]::Zero)|Out-Null',
  ].join("\n");
  return new Promise((resolve) => {
    try {
      const cp = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      const done = () => resolve();
      cp.on('close', done); cp.on('error', done);
      setTimeout(() => { try { cp.kill(); } catch {} resolve(); }, 8000);
    } catch { resolve(); }
  });
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
  const { account, post, groups, settings, useProxies, proxies, log, shouldStop, isLoginOpen, registerAborter, onResult, isOnline, waitIfPaused, isPaused } = o;
  const name = account.name;

  // Emit one audit record per (account, group, post) outcome for the persistent run report.
  const report = (groupName, gid, result, detail, commentResult) => {
    if (typeof onResult !== 'function') return;
    try {
      onResult({
        ts: new Date().toISOString(), account: name, group: displayName(groupName), groupId: gid,
        postId: post && post.id, caption: shortText((post && post.caption) || '', 60),
        result, comment: commentResult || '', detail: detail || '',
      });
    } catch {}
  };

  // Fix #4: profile-lock guard — two Chromium instances can't share a userDataDir.
  if (isLoginOpen && isLoginOpen(name)) {
    log(`🚫 [${name}] login browser is open for this account — skipping`);
    report('', '', 'skipped', 'login browser open for this account', '');
    return { posted: 0, errors: 1, pendingApproval: 0, noRetry: false, flag: null, postedIds: [] };
  }

  // An account with NO assigned groups is SKIPPED (it must NOT fall back to posting to
  // every group — that would spam all groups from unconfigured accounts).
  const assigned = (account.assignedGroups && account.assignedGroups.length)
    ? groups.filter((g) => account.assignedGroups.includes(g.id) || account.assignedGroups.includes(g.groupId))
    : [];
  const targetGroups = assigned; // post to ALL the account's assigned groups (the user selects them per account)

  if (!targetGroups.length) { log(`⏭️ [${name}] no assigned groups — skipping`); report('', '', 'skipped', 'no assigned groups', ''); return { posted: 0, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: [] }; }

  const launchArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    // ---- resource efficiency (headless automation needs none of this) ----
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    // ---- bound the on-disk caches so per-account profiles don't grow forever ----
    '--disk-cache-size=52428800',   // 50 MB
    '--media-cache-size=10485760',  // 10 MB
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
  let unregisterAborter = () => {};
  let posted = 0, errors = 0, pendingApproval = 0, noRetry = false, flag = null, offline = false;
  try {
    const hidden = settings.hideBrowser !== false; // default: hidden
    // ALWAYS headful — Facebook's composer (clipboard, typing focus, publish) misbehaves in true
    // headless even with stealth. "Hidden" just parks the real window OFF-SCREEN so it's invisible
    // but still a normal browser FB treats correctly; "visible" puts it on-screen for watching.
    launchArgs.push(hidden ? '--window-position=-32000,-32000' : '--window-position=80,40');
    log(`🖥️ [${name}] launching browser (${hidden ? 'hidden (off-screen)' : 'visible'})`);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromiumPath(),
      userDataDir: store.profileDir(name),
      args: launchArgs,
      defaultViewport: { width: 1280, height: 900 },
      protocolTimeout: 90000, // cap CDP op hangs (90s allows slow www->web redirects; still << default 180s)
    });
    if (typeof registerAborter === 'function') {
      unregisterAborter = registerAborter(() => {
        try { if (browser) browser.close(); } catch {}
      });
    }
    const _pages = await browser.pages();
    for (let i = 1; i < _pages.length; i++) { try { await _pages[i].close(); } catch {} }
    const page = _pages[0] || (await browser.newPage());
    // Make Facebook treat the page as FOCUSED + VISIBLE even when the window is off-screen.
    // Without this, an off-screen/hidden window won't publish (FB defers work on a page it
    // thinks is hidden) and the clipboard stays blocked. This is what lets "hidden" actually post.
    try { const cdp = await page.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.hasFocus = () => true;
      });
    } catch {}
    // Allow clipboard access so captions can be PASTED (fast + reliable, like the original agent).
    try { await browser.defaultBrowserContext().overridePermissions('https://www.facebook.com', ['clipboard-read', 'clipboard-write']); } catch {}
    // Completely hidden: drop the off-screen window's taskbar button (best-effort; it stays a
    // real composited window so Facebook still posts). Small delay so the window exists first.
    if (hidden) { try { await sleep(700); await hideFromTaskbar(browser.process() && browser.process().pid); } catch {} }
    // Watchdog: hard cap on this account's run so one stuck account can never block the
    // whole queue. Generous (a full post+comment is ~3-4 min) so it only fires on a real
    // hang, not normal slow posts. Closing the browser makes in-flight ops reject → cleanup.
    const accountBudget = Math.max(420000, targetGroups.length * 300000);
    const armWatchdog = () => { watchdog = setTimeout(() => { log(`⏰ [${name}] time budget exceeded — aborting account`); try { if (browser) browser.close(); } catch {} watchdog = null; }, accountBudget); };
    armWatchdog();
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
    if (post.commentImagePath) {
      if (fs.existsSync(post.commentImagePath)) { commentImg = post.commentImagePath; log(`🖼 [${name}] comment image: uploaded file`); }
      else log(`⚠️ [${name}] comment image file not found (${post.commentImagePath}) — comment will have no image`);
    } else if (post.commentImageUrl) {
      const dl = await downloadImage(post.commentImageUrl);
      if (dl) { commentImg = dl; tempImages.push(dl); log(`🖼 [${name}] comment image: downloaded from URL`); }
      else log(`⚠️ [${name}] comment image URL set but download failed — comment will have no image`);
    } else if (settings.commentWithImage && resolvedImages.length) {
      commentImg = resolvedImages[0]; log(`🖼 [${name}] comment image: reusing the post image (commentWithImage)`);
    }

    for (let i = 0; i < targetGroups.length; i++) {
      if (shouldStop()) { log(`⏹ [${name}] stop requested`); break; }
      // Pause holds here, between groups, so Pause takes effect mid-account. A deliberate
      // pause is NOT a hang: suspend the time-budget watchdog while held, then re-arm it on
      // resume so a long pause can't make the watchdog kill this account's browser.
      if (isPaused && isPaused()) {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (waitIfPaused) await waitIfPaused();
        if (shouldStop()) { log(`⏹ [${name}] stop requested`); break; }
        armWatchdog();
      }
      // Likely-blocked guard: if we've attempted ≥2 groups with ZERO posts, this account
      // probably can't post at all (silent block / restriction). Skip the rest immediately
      // instead of grinding through every group (mirrors the old app passing a blocked account).
      if (i >= 2 && posted === 0) {
        if (await checkRateLimit(page)) flag = 'rate_limited';
        else if (await checkVerification(page)) flag = 'needs_verification';
        else if (!flag) flag = 'likely_blocked';
        log(`🛑 [${name}] no posts after ${i} group(s) — skipping the rest (account looks blocked/restricted)`);
        noRetry = true; break;
      }
      const g = targetGroups[i];
      const gid = g.groupId || g.id;
      const groupName = g.name || gid;
      const step = createStepLogger(log, name, groupName);
      try {
        step(`Navigate to group (${i + 1}/${targetGroups.length})`);
        const gotoGroup = () => page.goto(`https://www.facebook.com/groups/${gid}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => true).catch(() => false);
        let navOk = await gotoGroup();
        if (!navOk) {
          // Distinguish a network outage from a Facebook issue: if we're OFFLINE, bail fast
          // (don't burn 90s timeouts per group) so the orchestrator can hold for reconnect.
          if (typeof isOnline === 'function' && !(await isOnline())) {
            step('🌐 Offline — pausing this account; the run resumes when the connection returns');
            offline = true; break;
          }
          step('Navigation attempt failed; retrying'); await sleepInterruptible(3000, shouldStop); navOk = await gotoGroup();
        }
        if (!navOk) { step('Navigation failed; skipping group'); errors++; report(groupName, gid, 'error', 'navigation failed', ''); continue; }
        await sleep(3000);

        // Per-group START banner — fired only after nav succeeds and before the auth checks.
        step('Group loaded');

        // Identity / "confirm you're a real person" checkpoint — flag distinctly so the
        // operator knows to VERIFY this account (re-login won't fix it).
        if (await checkVerification(page)) { step('🔐 Facebook wants identity/human verification — flagging account'); errors++; noRetry = true; flag = 'needs_verification'; report(groupName, gid, 'error', 'identity verification required', ''); break; }

        if (/^https?:\/\/[^/]*\/login/.test(page.url())) { step('Not logged in — aborting account'); errors++; noRetry = true; flag = 'needs_login'; report(groupName, gid, 'error', 'not logged in', ''); break; }
        // Expired sessions don't redirect — they show the "Continue as <name>" picker
        // or a non-member "Join Group / Log in" wall. Detect and abort early & clearly.
        const authBad = await page.evaluate(() => {
          const t = document.body.innerText || '';
          const hasBtn = (re) => Array.from(document.querySelectorAll('[role="button"],span,a,button')).some((e) => re.test((e.textContent || '').trim()));
          if (/your account has been disabled|we suspended your account|your account is restricted|confirm your identity/i.test(t)) return 'account-disabled';
          if (/continue as|use another profile/i.test(t)) return 'session-expired';
          if (hasBtn(/^join group$/i) && hasBtn(/^log in$/i)) return 'not-authenticated';
          return null;
        });
        if (authBad === 'account-disabled') { step('🚫 Account disabled/restricted by Facebook — needs manual attention'); errors++; noRetry = true; flag = 'account_disabled'; report(groupName, gid, 'error', 'account disabled/restricted', ''); break; }
        if (authBad) { step(authBad === 'session-expired' ? 'Session expired - re-login required' : 'Not logged in / not a member'); errors++; noRetry = true; flag = 'needs_login'; report(groupName, gid, 'error', authBad, ''); break; }

        // Clear cookie/notification banners, then bail out of this account if rate-limited.
        await dismissPopups(page);
        if (await checkRateLimit(page)) { step('🛑 Rate-limited by Facebook — skipping this account immediately'); errors++; noRetry = true; flag = 'rate_limited'; report(groupName, gid, 'error', 'rate-limited by Facebook', ''); break; }

        // Open the composer and CONFIRM the dialog actually opened (the FB trigger has
        // no aria-label — match the placeholder text — and the click must be verified).
        const opened = await openComposer(page, step, name);
        if (!opened) {
          // An account-level block can be WHY the composer won't open — confirm it and skip the
          // WHOLE account immediately rather than trying every remaining group.
          if (await checkRateLimit(page)) { step('🛑 Rate-limited by Facebook (composer blocked) — skipping this account immediately'); errors++; noRetry = true; flag = 'rate_limited'; report(groupName, gid, 'error', 'rate-limited — composer blocked', ''); break; }
          if (await checkVerification(page)) { step('🔐 Facebook wants identity/human verification — skipping this account immediately'); errors++; noRetry = true; flag = 'needs_verification'; report(groupName, gid, 'error', 'identity verification required', ''); break; }
          // Name the likely cause so the operator can act (and knows it's not a generic bug).
          const why = await page.evaluate(() => {
            const t = (document.body.innerText || '').toLowerCase();
            if (/you can.t post|you.re not allowed to post|only members can post|membership request|^join group/.test(t)) return 'account not a member / lacks posting rights / pending approval';
            if (/this content isn.t available|group isn.t available|content not found/.test(t)) return 'group unavailable or archived';
            return null;
          }).catch(() => null);
          step(`Could not open composer — ${why || 'no composer trigger found (account may lack post rights, or Facebook changed the layout)'}; skipping group`);
          errors++; report(groupName, gid, 'error', why || 'composer did not open', ''); continue;
        }
        await sleep(1500);
        await dismissPopups(page);
        step('Composer opened; preparing post');

        // Read the composer editable text length, with a settle delay for robustness.
        const captionLen = (extraDelay = 0) => sleep(extraDelay).then(() =>
          composerCaptionState(page, post.caption).then((state) => state.len || 0)
        );
        // Verify caption was entered: accept if the editable has meaningful length (> 0)
        // and contains at least the first ~15 non-space chars of the caption (handles emoji,
        // newline, and auto-formatting differences that break exact-match checks).
        const captionOk = async () => {
          const state = await sleep(500).then(() => composerCaptionState(page, post.caption));
          return !!state.matched || (!post.caption.trim() && state.len > 0);
        };

        // Image FIRST, then caption — mirrors the original agent. Paste is atomic so the
        // image's re-render can't clobber the caption. Scope the file input to the DIALOG.
        if (resolvedImages.length) {
          step(`Uploading ${resolvedImages.length} image(s)`);
          const input = (await page.$('div[role="dialog"] input[type="file"]')) || (await page.$(SEL.fileInput));
          if (input) {
            // Cap the upload: a stalled CDP file transfer (big image / slow disk) must not
            // hang the account for the full protocolTimeout and trip the watchdog.
            let upTimer;
            const upCap = new Promise((_, rej) => { upTimer = setTimeout(() => rej(new Error('uploadFile timeout')), 30000); });
            try { await Promise.race([input.uploadFile(...resolvedImages), upCap]); step('Image attached'); await sleepInterruptible(3500, shouldStop); }
            catch (upErr) { step(`Image upload stalled (${upErr.message}) — posting without image`); }
            finally { clearTimeout(upTimer); }
          }
          else step('Image input not found in composer; posting without local image attach');
        }

        // Caption — PASTE it (clipboard + Ctrl+V, like the original "Caption pasted"); fast and
        // reliable. Verify it landed; if not, fall back to typing so the post still goes out.
        if (post.caption) {
          step('Entering caption');
          await focusEditable(page);
          let captionState = { matched: false, len: 0, sample: '' };
          try {
            await page.evaluate((t) => navigator.clipboard.writeText(t), post.caption);
            await page.keyboard.down('Control'); await page.keyboard.press('v'); await page.keyboard.up('Control');
            captionState = await waitForCaptionState(page, post.caption, 5000);
          } catch (e) {
            step('Clipboard paste unavailable; typing caption');
          }
          if (captionState.matched) {
            step(`Caption pasted and verified (${captionState.len} chars)`);
          } else { // paste blocked or not detected → clear + type
            step(`Caption paste not verified${captionState.len ? ` (${captionState.len} chars detected)` : ''}; typing caption`);
            await focusEditable(page);
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
            await page.keyboard.press('Backspace'); await sleep(150);
            await humanType(page, post.caption);
            captionState = await waitForCaptionState(page, post.caption, 2500);
            // Only RE-TYPE if nothing landed (editor still empty). If text IS present but our
            // readability check can't match it (common — FB hides the editor's text), accept it
            // and let the publish confirmation verify. Avoids a pointless ~10s full re-type.
            if (!captionState.matched && (captionState.len || 0) === 0) {
              step('Caption did not land — retyping once');
              await focusEditable(page);
              await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
              await page.keyboard.press('Backspace'); await sleep(150);
              await humanType(page, post.caption);
              captionState = await waitForCaptionState(page, post.caption, 2500);
            }
          }
          if (captionState.matched || await captionOk()) {
            const finalState = captionState.matched ? captionState : await composerCaptionState(page, post.caption);
            step(`Caption verified in composer (${finalState.len} chars)`);
          } else {
            const finalState = await composerCaptionState(page, post.caption);
            step(`Caption typed; Facebook editor text not directly readable (${finalState.len} chars detected). Publish confirmation will verify the post`);
          }
        }

        // Publish — then CONFIRM it actually published (dialog closed / Post button gone).
        await sleepInterruptible(1500, shouldStop);
        step('Waiting for Post button to enable');
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
          if (postBtnInfo.found) step(`Post button found (label="${postBtnInfo.label}")`);
          else step(`Post button NOT found (${postBtnInfo.dialogs} dialog(s) scanned)`);
        }
        const clicked = await clickPostButton(page);
        if (!clicked) { step('Post button not found; skipping group'); errors++; report(groupName, gid, 'error', 'post button not found', ''); continue; }
        step('Post button clicked');
        const publishResult = await waitForPublish(page, dialogCountBefore, 30000, shouldStop);
        if (publishResult === 'stopped') { step('Stop requested during publish wait — halting'); break; }
        if (publishResult !== 'published') {
          // The post failed — find out WHY so the account can be flagged for the operator.
          // Facebook's spam/rate-limit message appears in the composer right after clicking Post.
          if (await checkRateLimit(page)) { step('🛑 Facebook is rate-limiting this account ("you can try again later") — skipping this account immediately'); errors++; noRetry = true; flag = 'rate_limited'; report(groupName, gid, 'error', 'rate-limited — Facebook blocked the post', ''); break; }
          if (await checkVerification(page)) { step('🔐 Facebook wants identity/human verification — skipping this account immediately'); errors++; noRetry = true; flag = 'needs_verification'; report(groupName, gid, 'error', 'identity verification required', ''); break; }
          // Otherwise it's an unexplained failure — snapshot the dialog so it's diagnosable.
          const snap = await page.evaluate(() => { const d = document.querySelector('div[role="dialog"]'); return ((d && d.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 120); }).catch(() => '');
          step(`Post clicked but publish NOT confirmed (${publishResult})${snap ? ` — "${snap}"` : ''}; skipping group`);
          errors++; report(groupName, gid, 'error', `publish not confirmed (${publishResult})`, ''); continue;
        }
        await sleepInterruptible(3000, shouldStop);
        // Check pending-approval BEFORE dismissing popups (a dismissible notice could be cleared).
        const isPending = await checkPendingApproval(page);
        await dismissPopups(page); // clear "Your post might be reviewed" etc.

        // Moderated groups queue posts for admin approval — don't count as posted and
        // skip the comment (the post isn't in the feed yet).
        if (isPending) {
          step('Post submitted but PENDING ADMIN APPROVAL - not counted, comment skipped');
          pendingApproval++;
          report(groupName, gid, 'pending', 'awaiting admin approval', 'skipped');
          if (i < targetGroups.length - 1) await sleepInterruptible((Number.isFinite(settings.groupDelay) ? settings.groupDelay : 60) * 1000, shouldStop, 1000);
          continue;
        }

        // Success log — keep caption snippet for the renderer's auto-delete tracker.
        step('Posted successfully');
        posted++;

        // First comment (the link) — reload, find OUR post, comment in its box.
        // addFirstComment logs every stage itself (via the same step() logger).
        // Fire when there is comment TEXT or a comment IMAGE — an image-only comment is valid.
        const wantComment = !!((post.comment && post.comment.trim()) || commentImg);
        let commentResult = wantComment ? 'failed' : 'none';
        if (wantComment) {
          const cok = await addFirstComment(page, gid, post, commentImg, step);
          commentResult = cok ? 'posted' : 'failed';
        }
        report(groupName, gid, 'posted', '', commentResult);
      } catch (e) {
        errors++;
        step(`Error: ${e.message}`);
        report(groupName, gid, 'error', e.message, '');
        try { await page.screenshot({ path: require('path').join(store.accountDir(name), 'last-failure.png') }); } catch {}
        // If the browser/page died, every remaining group would just throw the same way —
        // abort this account cleanly instead of churning one error per remaining group.
        if (!browser || !browser.isConnected() || /target closed|session closed|protocol error|detached/i.test(e.message || '')) {
          step('Browser lost — aborting remaining groups for this account');
          break;
        }
      }

      // Interruptible delay between groups (respects Stop + configurable groupDelay).
      if (i < targetGroups.length - 1) {
        const d = (Number.isFinite(settings.groupDelay) ? settings.groupDelay : 60) * 1000;
        if (d > 0) {
          const dMin = Math.round(d / 60000);
          step(`Wait ${dMin > 0 ? dMin + 'min' : Math.round(d / 1000) + 's'} before next group`);
          await sleepInterruptible(d, shouldStop, 1000);
        }
      }
    }
    // Persist refreshed cookies for next run.
    try { store.writeCookies(name, await page.cookies()); } catch {}
    fs.writeFileSync(require('path').join(store.accountDir(name), 'last-run-success.txt'),
      `${errors === 0 ? 'SUCCESS' : 'PARTIAL'}\nPosts: ${posted}\nPending: ${pendingApproval}\nTime: ${new Date().toISOString()}\n`);
  } catch (e) {
    errors++;
    log(`❌ [${name}] fatal: ${e.message}`);
  } finally {
    unregisterAborter();
    if (watchdog) clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
    if (anonLocal && proxyChain) { try { await proxyChain.closeAnonymizedProxy(anonLocal, true); } catch {} }
    for (const t of tempImages) { try { fs.unlinkSync(t); } catch {} }
  }
  return { posted, errors, pendingApproval, noRetry, flag, offline };
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
