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
const spintax = require('../lib/spintax');
const imageVary = require('../lib/imageVary');
const secret = require('../lib/secret');
const { execFile } = require('child_process');

// Push a browser window BEHIND other windows WITHOUT activating it, so a VISIBLE run doesn't steal
// focus or sit on top of the user's work. The --disable-backgrounding-occluded-windows launch flag
// keeps the window rendering normally while it's in the background. Windows-only (no-op elsewhere).
function sendWindowToBackground(pid) {
  if (process.platform !== 'win32' || !pid) return Promise.resolve();
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class ZaBg{[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);}',
    '"@',
    // HWND_BOTTOM=1; flags 0x13 = NOSIZE|NOMOVE|NOACTIVATE. Wait up to ~2.4s for the window handle.
    `for($i=0;$i -lt 12;$i++){$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if(-not $p){break}; $p.Refresh(); $h=$p.MainWindowHandle; if($h -ne [IntPtr]::Zero){[ZaBg]::SetWindowPos($h,[IntPtr]1,0,0,0,0,0x13)|Out-Null; break}; Start-Sleep -Milliseconds 200}`,
  ].join('\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64'); // -EncodedCommand avoids all quoting
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: 12000, windowsHide: true }, () => resolve());
  });
}

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

// Jitter a base delay by ±pct (default ±30%) so no two waits are identical — a fixed cadence
// is itself a bot signal. Always returns a non-negative integer ms.
function jitter(ms, pct = 0.3) {
  const base = Math.max(0, Number(ms) || 0);
  return Math.round(base * (1 - pct + Math.random() * pct * 2));
}

// Move the cursor to (x,y) along a short multi-step path instead of teleport-clicking. FB's
// integrity JS expects a real mouse trajectory before a click; a click with no preceding
// mousemove is non-human. Best-effort — never throws into the caller.
async function moveMouseTo(page, x, y) {
  try {
    const steps = 8 + Math.floor(Math.random() * 10);
    await page.mouse.move(x + (Math.random() * 6 - 3), y + (Math.random() * 6 - 3), { steps });
    await sleep(40 + Math.floor(Math.random() * 120));
  } catch {}
}

// Land on a group and behave like a human reading before composing: a little mouse drift and a
// few wheel scrolls with pauses, total ~5-13s. Reduces the "instant composer open" bot pattern.
async function humanDwell(page, shouldStop = () => false) {
  try {
    await moveMouseTo(page, 380 + Math.random() * 240, 280 + Math.random() * 160);
    const scrolls = 2 + Math.floor(Math.random() * 3);
    for (let s = 0; s < scrolls && !shouldStop(); s++) {
      try { await page.mouse.wheel({ deltaY: 200 + Math.random() * 320 }); } catch {}
      await sleep(700 + Math.floor(Math.random() * 1500));
    }
    if (!shouldStop()) { try { await page.mouse.wheel({ deltaY: -(150 + Math.random() * 200) }); } catch {} }
    await sleepInterruptible(1500 + Math.floor(Math.random() * 3000), shouldStop, 500);
  } catch {}
}

// Give each link in the text a unique query param so the SAME url isn't posted verbatim to every
// group (FB dedups exact URLs across groups). Adds ?ref=/&ref=<short per-account+group hash>.
function varyLinks(text, seedStr) {
  if (!text) return text;
  let n = 0;
  const tag = () => {
    const base = `${seedStr}|${n++}|${Date.now()}`;
    let h = 5381; for (let i = 0; i < base.length; i++) h = ((h << 5) + h + base.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 8);
  };
  return String(text).replace(/https?:\/\/[^\s]+/g, (url) => {
    const clean = url.replace(/[).,]+$/, ''); // don't swallow trailing punctuation
    const trail = url.slice(clean.length);
    // Use a neutral key 's' (NOT 'ref', which collides with Facebook's own ?ref= params), and
    // REPLACE an existing s=/ref= rather than appending a second one.
    let u = clean;
    if (/[?&](?:s|ref)=[^&]*/.test(u)) u = u.replace(/([?&])(?:s|ref)=[^&]*/, `$1s=${tag()}`);
    else u += (u.includes('?') ? '&' : '?') + `s=${tag()}`;
    return `${u}${trail}`;
  });
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

// Retry an async operation with a per-attempt timeout and exponential backoff. Returns
// { ok:true, result } on the first success, or { ok:false, error } after exhausting attempts.
// Pure and dependency-free so the upload/download reliability path is unit-testable without a
// real browser. `fn` receives the 1-based attempt number.
async function retryAsync(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts || 3);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000;
  const baseDelayMs = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : 1500;
  const label = opts.label || 'operation';
  const onAttempt = typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => fn(attempt)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs); }),
      ]);
      clearTimeout(timer);
      return { ok: true, result };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (onAttempt) { try { onAttempt(attempt, attempts, e); } catch {} }
      if (attempt < attempts) await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
    }
  }
  return { ok: false, error: lastErr };
}

// Download a remote image to a temp file; return its path (or null). Retries transient
// network failures (with a per-attempt timeout) so a single blip doesn't silently drop the
// post's image and leave it publishing a bare caption.
// M3-03: SSRF / resource guard. A post's image URL is fetched by the APP process (full network
// access), so a malicious URL could hit internal services (169.254.169.254 metadata, localhost
// admin panels, private LAN hosts) or non-image schemes. Allow only http/https to PUBLIC hosts.
// Literal-IP based (no DNS resolution) — a pragmatic guard for a desktop tool. PURE / unit-tested.
function isSafeImageUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a >= 224) return false;
  }
  if (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return false; // IPv6 loopback / link-local / ULA
  return true;
}

async function downloadImage(url) {
  if (!axios || !url) return null;
  if (!isSafeImageUrl(url)) return null; // SSRF guard — reject internal/private/non-http(s) targets
  const r = await retryAsync(() => axios.get(url, {
    responseType: 'arraybuffer', timeout: 30000,
    maxRedirects: 1,                       // a redirect can't bounce us to an internal host past the guard
    maxContentLength: 15 * 1024 * 1024,    // cap the download so a giant/streaming URL can't exhaust memory
    maxBodyLength: 15 * 1024 * 1024,
  }), { attempts: 3, timeoutMs: 35000, baseDelayMs: 1500, label: 'image download' });
  if (!r.ok) return null;
  // Reject non-image responses (an HTML error page / unexpected content type isn't an image).
  const ct = String((r.result.headers && (r.result.headers['content-type'] || r.result.headers['Content-Type'])) || '').toLowerCase();
  if (ct && !ct.startsWith('image/')) return null;
  try {
    const ext = (String(url).match(/\.(jpg|jpeg|png|gif|webp)/i) || [, 'jpg'])[1];
    const file = path.join(os.tmpdir(), `za-img-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
    fs.writeFileSync(file, Buffer.from(r.result.data));
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

// ---- Facebook state-detection patterns (single source of truth) --------------------------------
// Facebook localizes every string and A/B-tests its DOM, so detection keys off TEXT across many
// locales plus URL/structure cues. These arrays are passed INTO page.evaluate() so the browser
// context and the Node-side unit tests share ONE list. All matching is accent-insensitive and
// lowercase (see normText / the in-page norm()). Add a locale's phrases here and every detector
// + its test picks them up. (M1-03 / M1-04.)
const FB = {
  // Rate-limit / temporary-block WALL phrasing ONLY. Generic "try again later" / "réessayer plus
  // tard" are transient network/CDN errors — deliberately NOT here, so they never trip a no-retry
  // account abort.
  rateLimit: [
    "you're temporarily blocked", 'temporarily blocked', 'temporarily restricted',
    'doing this too often', 'doing this too quickly', 'action blocked', 'we limit how often',
    'protect our community from spam', 'protect the community from spam', 'going too fast',
    'posting too often', 'posting too quickly', "you can't use this feature right now",
    'you cant use this feature right now', 'this feature for a while',
    'nous limitons', 'temporairement bloque', 'vous allez trop vite', 'action bloquee',     // FR
    'temporalmente bloqueado', 'bloqueado temporalmente', 'lo haces con demasiada frecuencia', // ES
    'estas bloqueado temporalmente', 'has estado bloqueado',
    'voruebergehend gesperrt', 'vorubergehend gesperrt', 'du machst das zu oft',             // DE
    'temporaneamente bloccato', 'bloccato temporaneamente',                                  // IT
    'bloqueado temporariamente', 'voce esta temporariamente bloqueado',                      // PT
    'atmenetileg letiltottuk', 'tul gyakran', 'tul gyorsan',                                 // HU
  ],
  // Identity / human checkpoint text.
  checkpoint: [
    'confirm that you are a real person', "confirm that you're a real person",
    'confirm you are a real person', 'confirm your identity', 'we need to confirm',
    "we'll need you to confirm", 'help us confirm', 'security check', 'please confirm your identity',
    'confirmez que vous etes une personne reelle', 'confirmer votre identite',               // FR
    'confirma que eres una persona real', 'confirma tu identidad', 'verifica tu identidad',  // ES
    'bestatige, dass du eine echte person bist', 'bestatige deine identitat',                // DE
    'conferma di essere una persona reale', 'conferma la tua identita',                      // IT
    'confirme que voce e uma pessoa real', 'confirme sua identidade',                        // PT
    'erositsd meg, hogy valodi szemely vagy', 'biztonsagi ellenorzes',                       // HU
  ],
  // URL fragments that ALWAYS mean an identity/human gate (conservative — these don't appear in a
  // normal group-posting URL).
  checkpointUrl: ['/checkpoint/', '/confirmidentity', '/verify', '/challenge'],
  // Pending-admin-approval phrasing (moderated groups). Multi-word ONLY — a bare "pending" would
  // false-match unrelated UI ("pending friend requests").
  pending: [
    'will be reviewed', 'shared once approved', 'post is pending', 'pending approval',
    'pending admin approval', 'waiting for admin approval', 'waiting for moderator approval',
    'your post is pending', 'awaiting approval', 'needs to be approved', 'in review by',
    'sera examinee', 'doit etre approuve', 'approbation',                                    // FR ("en attente d'approbation" — apostrophe-safe)
    'pendiente de aprobacion', 'sera revisada', 'debe ser aprobada',                         // ES
    'wird uberpruft', 'muss genehmigt werden', 'ausstehende genehmigung',                    // DE
    'in attesa di approvazione',                                                             // IT
    'aguardando aprovacao', 'sera analisada',                                                // PT
    'jovahagyasra var',                                                                      // HU
  ],
  // Submit/"Post" button label text across locales (matched against the FULL trimmed label so we
  // never grab a longer label that merely contains the word, e.g. "Post to your story").
  postButton: [
    'post', 'publish', 'share', 'send', 'post to group',
    'publier', 'partager', 'envoyer',                 // FR
    'publicar', 'compartir', 'enviar',                // ES / PT
    'posten', 'teilen', 'senden', 'veroffentlichen',  // DE
    'pubblica', 'condividi', 'invia',                 // IT
    'kozzetetel', 'megosztas', 'kuldes',              // HU
  ],
  // Comment-box aria hints across locales.
  commentBox: ['comment', 'commentaire', 'comentario', 'comentar', 'kommentar', 'commento', 'hozzaszolas'],
};

// Accent-insensitive lowercase normalize — mirrors the in-page norm() so Node tests and the
// browser context agree on what matches.
function normText(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function matchesAny(text, patterns) { const t = normText(text); return (patterns || []).some((p) => t.includes(p)); }
// Block-WALL only (transient errors are excluded from FB.rateLimit by construction).
function isRateLimitText(text) { return matchesAny(text, FB.rateLimit); }
function isCheckpointText(text, url) {
  const u = normText(url);
  if (u && FB.checkpointUrl.some((frag) => u.includes(frag))) return true;
  return matchesAny(text, FB.checkpoint);
}
function isPendingText(text) { return matchesAny(text, FB.pending); }
// Full-label (not substring) match so we click the composer's Post, not a label that contains it.
function isPostButtonLabel(label) { return FB.postButton.includes(normText(label).replace(/\s+/g, ' ').trim()); }
function isCommentBoxLabel(label) { return matchesAny(label, FB.commentBox); }

// Kill any lingering Chromium still holding THIS account's profile lock — e.g. a browser that was
// force-killed mid-run and left a SingletonLock, which would otherwise make the next launch fail
// with "profile prep failed". Windows-only, best-effort, and SCOPED to the exact profile path
// (ends in \chrome-profile) so it can never touch another account's browser or the user's real
// Chrome. Mirrors main.js killOrphanChromium but per-account and safe to run mid-session. (M2-06)
function killChromiumForProfile(profilePath, log) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !profilePath) return resolve(0);
    const psPath = String(profilePath).replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${psPath}*' } | Select-Object -ExpandProperty ProcessId`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 12000 }, (_err, stdout) => {
      const pids = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
      if (!pids.length) return resolve(0);
      if (log) log(`🧹 clearing ${pids.length} stale browser process(es) holding the profile lock`);
      let pending = pids.length, killed = 0;
      for (const pid of pids) {
        execFile('taskkill', ['/F', '/T', '/PID', pid], { windowsHide: true, timeout: 8000 }, (e) => { if (!e) killed++; if (--pending === 0) resolve(killed); });
      }
    });
  });
}

// Parse a stored proxy string -> parts + upstream URL. Accepts BOTH common formats:
//   scheme://user:pass@host:port   (standard URL form — what most provider dashboards give)
//   scheme://host:port[:user:pass] (compact colon form)
const PROXY_SCHEMES = new Set(['http', 'https', 'socks', 'socks4', 'socks5', 'socks5h']);
function parseProxy(str) {
  if (!str) return null;
  let scheme, ip, port, user, pass;
  let m = String(str).trim().match(/^(\w+):\/\/([^:@/\s]+):([^@/\s]+)@([^:/@\s]+):(\d+)$/);
  if (m) { [, scheme, user, pass, ip, port] = m; }
  else {
    m = String(str).trim().match(/^(\w+):\/\/([^:\s]+):(\d+)(?::([^:]+):(.+))?$/);
    if (!m) return null;
    [, scheme, ip, port, user, pass] = m;
  }
  // M3-06: validate scheme + port so a malformed proxy fails HERE (caller logs a clear message and
  // skips the account) instead of silently at Chrome launch (407s / posting from the bare IP).
  scheme = String(scheme).toLowerCase();
  const portN = Number(port);
  if (!PROXY_SCHEMES.has(scheme) || !(Number.isInteger(portN) && portN >= 1 && portN <= 65535)) return null;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : '';
  return { scheme, server: `${scheme}://${ip}:${port}`, username: user || null, password: pass || null,
    upstream: `${scheme}://${auth}${ip}:${port}` };
}

// E-P1: classify a per-group error to decide retry policy. 'block' (rate-limit / checkpoint /
// verification) must NEVER be retried — retrying would hammer Facebook and escalate a soft limit.
// 'transient' (CDP drop / timeout / network) is safe to retry, but ONLY before the publish click.
// 'permanent' (missing group / no post button) means skip the group. Pure / unit-tested.
function classifyGroupError(message) {
  const m = String(message || '').toLowerCase();
  if (/rate.?limit|temporarily blocked|action blocked|checkpoint|verification|too fast|too often/.test(m)) return 'block';
  if (/target closed|session closed|protocol error|detached|timeout|timed out|econnreset|socket hang up|net::err|navigation failed|cdp/.test(m)) return 'transient';
  return 'permanent';
}

// E-X2: when a proxy string won't parse, suggest the likely-correct schemed form so the operator can
// fix the format without guessing. Returns a hint string ('' if none / already schemed). Pure.
function proxyFormatHint(str) {
  const s = String(str || '').trim();
  if (!s) return '';
  if (/^\w+:\/\//.test(s)) return ''; // already has a scheme — the problem is elsewhere
  const parts = s.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return `add a scheme, e.g. "socks5://${s}" or "http://${s}"`;
  if (parts.length === 4 && /^\d+$/.test(parts[1])) return `add a scheme, e.g. "socks5://${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}" (host:port:user:pass) or "http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}"`;
  return 'expected scheme://host:port or scheme://user:pass@host:port';
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
    if (pt) { await moveMouseTo(page, pt.x, pt.y); await page.mouse.click(pt.x, pt.y, { delay: 40 }).catch(() => {}); return true; }
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
  if (log) log('⚠️ SELECTOR DRIFT? Composer never opened after 4 attempts — Facebook may have changed the "Write something" trigger, or the page is in an unexpected locale/state. Run scripts/inspect-fb.js on this account to capture the current DOM.');
  return false;
}

async function clickPostButton(page) {
  // Find the enabled submit button (prefer one inside an open dialog), return its coordinates, and
  // click with a REAL mouse event — synthetic .click() doesn't submit on web.facebook.com. Matches
  // the full label against FB.postButton (post/publish/share/send + locales) so a FB UI/locale
  // change doesn't silently break posting. Full-label (not substring) match avoids grabbing a
  // longer button like "Post to your story".
  const pt = await page.evaluate((labels) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const scope = dialogs.length ? dialogs : [document];
    for (const root of scope) {
      const btn = Array.from(root.querySelectorAll('[role="button"], button')).find((b) =>
        b.getAttribute('aria-disabled') !== 'true' && !b.disabled && labels.includes(norm(b.getAttribute('aria-label') || b.textContent)));
      if (btn) { btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect(); if (r.width && r.height) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
    return null;
  }, FB.postButton).catch(() => null);
  // Move the cursor to the button along a path (and a brief hover) before clicking, like a human —
  // a click with no preceding mousemove is a bot tell FB's integrity JS looks for.
  if (pt) { await moveMouseTo(page, pt.x, pt.y); await page.mouse.click(pt.x, pt.y, { delay: 40 }).catch(() => {}); return true; }
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

// Detect the "pending admin approval" state moderated groups show after posting. Phrase list is
// FB.pending (multi-locale, single source of truth — also unit-tested).
async function checkPendingApproval(page) {
  try {
    return await page.evaluate((pats) => {
      const t = (document.body.innerText || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      return pats.some((p) => t.includes(p));
    }, FB.pending);
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
      // ~35-105 ms/keystroke models a real typist (~50 WPM). The old 5-17 ms was machine-fast.
      await Promise.race([page.keyboard.type(c, { delay: 35 + Math.floor(Math.random() * 70) }), cap]);
    } finally { clearTimeout(timer); }
    // Inter-chunk pause, with an occasional longer "thinking" beat.
    await sleep(60 + Math.floor(Math.random() * 160) + (Math.random() < 0.1 ? 300 + Math.floor(Math.random() * 700) : 0));
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
// Phrase list is FB.rateLimit (block-WALL phrasing only — generic transient "try again later"
// is deliberately excluded; multi-locale; unit-tested).
async function checkRateLimit(page) {
  try {
    return await page.evaluate((pats) => {
      const t = (document.body.innerText || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      return pats.some((p) => t.includes(p));
    }, FB.rateLimit);
  } catch { return false; }
}

// Detect Facebook's "confirm you are a real person" / identity checkpoint, which blocks the
// account from posting until the user completes it. Text (FB.checkpoint, multi-locale) OR a
// checkpoint URL OR a captcha/challenge structure in the DOM — any one is enough.
async function checkVerification(page) {
  try {
    return await page.evaluate((cfg) => {
      const url = (location.href || '').toLowerCase();
      if (cfg.urls.some((u) => url.includes(u))) return true;
      const t = (document.body.innerText || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (cfg.texts.some((p) => t.includes(p))) return true;
      // Structural cue: a captcha/challenge vendor frame or an explicit checkpoint form/input.
      if (document.querySelector('iframe[src*="captcha" i], iframe[title*="captcha" i], form[action*="checkpoint" i], input[name*="captcha" i]')) return true;
      return false;
    }, { urls: FB.checkpointUrl, texts: FB.checkpoint });
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

// Resolve to `fallback` if a promise (any CDP op: $$, h.evaluate, target.evaluate…) doesn't
// settle in `ms`, so a busy renderer can't hang a step to the 90s protocolTimeout. The original
// op keeps running in the background harmlessly.
function withTimeout(promise, ms, fallback) {
  let t;
  const safe = Promise.resolve(promise).catch(() => fallback);
  const cap = new Promise((res) => { t = setTimeout(() => res(fallback), ms); });
  return Promise.race([safe, cap]).finally(() => clearTimeout(t));
}

// Add the "first comment" (the link) to the JUST-published post. Reloads the group
// so the new post renders, finds the article containing our caption, and types into
// ITS "Write a public comment…" box. Returns true on success.
async function addFirstComment(page, gid, post, commentImg, step, permalink) {
  let submitted = false; // once the submitting Enter is pressed, NEVER return false — the caller
                         // retries on false and would post a DUPLICATE comment.
  try {
    // Header: state the comment configuration so each group's comment is self-explanatory.
    const hasText = !!(post.comment && post.comment.trim());
    const mode = hasText && commentImg ? 'text + image' : hasText ? 'text-only' : 'image-only';
    step(`Comment: starting (${mode})${hasText ? ` — "${shortText(post.comment, 50)}"` : ''}`);
    // The first comment must land on OUR just-published post. After the anti-spam wait the feed may
    // have shifted (others posted), so the ONLY reliable anchor is the post's OWN page (permalink),
    // captured right after publishing. Strategy: permalink-direct PRIMARY → feed-scan (caption-matched,
    // top-3 only) FALLBACK → skip rather than guess.
    const commentBoxes = async () => {
      const all = (await withTimeout(page.$$('[contenteditable="true"], [role="textbox"]'), 8000, [])).slice(0, 30);
      const out = [];
      for (const h of all) {
        const isC = await withTimeout(h.evaluate((el, hints) => {
          const raw = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-placeholder') || '');
          const norm = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
          return hints.some((w) => norm.includes(w)); // FB.commentBox: EN/FR/ES/PT/DE/IT/HU
        }, FB.commentBox), 3000, false);
        if (isC) out.push(h);
      }
      return out;
    };
    // Slow-internet readiness gate: wait until an article AND a candidate comment box exist before
    // scanning. Bounded by `ms`; each check is capped (never hangs).
    const waitInteractive = async (ms) => {
      const dl = Date.now() + ms;
      while (Date.now() < dl) {
        const ready = await evalTimed(page, () => {
          const arts = Array.from(document.querySelectorAll('div[role="article"]'));
          return arts.length > 0 && arts.some((a) => a.querySelector('[contenteditable="true"], [role="textbox"]'));
        }, null, 4000).catch(() => false);
        if (ready) return true;
        await sleep(1000);
      }
      return false;
    };
    const clickLeaveComment = () => evalTimed(page, () => {
      const b = Array.from(document.querySelectorAll('[role="button"]')).find((e) => {
        const norm = (e.getAttribute('aria-label') || e.textContent || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        return /leave a comment|^comment$|hozzaszolas|commenter|comentar|kommentar|commenta/.test(norm);
      });
      if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
      return false;
    }, null, 12000).catch(() => false);

    const snip = (post.caption || '').replace(/\s+/g, ' ').trim();
    // C6: can't prove which post is ours (no link + nothing to match on) → SKIP, never guess.
    if (snip.length < 12 && !permalink) { step('Comment: caption too short and no post link — skipping to avoid a wrong-post comment'); return 'skipped'; }

    let boxes = [];
    let permalinkFailed = false;

    // PRIMARY: comment on the post's OWN page (it's the only article there → unambiguous = right post).
    if (permalink) {
      step('Comment: opening the post directly via its link (primary — guarantees the right post)');
      const navOk = await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => true).catch(() => false);
      if (!navOk) { permalinkFailed = true; step('Comment: could not open the post link — falling back to the group feed'); }
      else {
        await page.waitForSelector('div[role="article"], [aria-label*="omment"], [role="textbox"]', { timeout: 25000 }).catch(() => {});
        const ready = await waitInteractive(10000);
        step(ready ? 'Comment: post page ready' : 'Comment: post page not fully interactive (timeout) — trying anyway');
        await dismissPopups(page);
        const authBad = await withTimeout(page.evaluate(() => /continue as|use another profile|log in to facebook/i.test(document.body.innerText || '')), 8000, false);
        if (authBad) { step('Comment: session expired after posting — skipped (re-login needed)'); return 'failed'; }
        boxes = await withTimeout(commentBoxes(), 15000, []);
        if (!boxes.length) {
          step('Comment: no inline box on the post page — clicking "Leave a comment"');
          if (await clickLeaveComment()) { step('Comment: comment box opened (post page)'); await sleep(2500); boxes = await withTimeout(commentBoxes(), 15000, []); }
        }
      }
    }

    // FALLBACK: feed-scan — ONLY when there's no usable permalink. Requires a caption match AND top-3
    // recency so we never comment on the wrong (older) post after the anti-spam wait pushed ours down.
    if (!boxes.length && (!permalink || permalinkFailed)) {
      step('Comment: locating the post in the group feed (fallback)');
      await page.goto(`https://www.facebook.com/groups/${gid}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await page.waitForSelector('div[role="article"], [aria-label*="omment"], [aria-label*="ommentaire"], [role="textbox"]', { timeout: 25000 }).catch(() => {});
      await waitInteractive(10000);
      await dismissPopups(page);
      const authBad = await withTimeout(page.evaluate(() => /continue as|use another profile/i.test(document.body.innerText || '')), 8000, false);
      if (authBad) { step('Comment: session expired after posting — skipped (re-login needed)'); return 'failed'; }
      boxes = await withTimeout(commentBoxes(), 15000, []);
      if (!boxes.length) {
        step('Comment: no inline box — clicking "Leave a comment" on OUR post (top-3 + caption match)');
        const clicked = await evalTimed(page, (s) => {
          // A just-published post is at the TOP — only the top 3 articles can be ours. A snippet match
          // further down is almost certainly a different (older) post — never comment there.
          const top = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 3);
          const mine = (s && s.length >= 12) ? top.find((a) => (a.textContent || '').includes(s)) : null;
          if (!mine) return false;
          const b = Array.from(mine.querySelectorAll('[role="button"]')).find((e) => {
            const norm = (e.getAttribute('aria-label') || e.textContent || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
            return /leave a comment|^comment$|hozzaszolas|commenter|comentar|kommentar/.test(norm);
          });
          if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
          return false;
        }, snip.slice(0, 25), 12000).catch(() => false);
        if (clicked) { step('Comment: comment box opened'); await sleep(2500); boxes = await withTimeout(commentBoxes(), 15000, []); }
        else step('Comment: could not confidently find OUR post in the feed — not commenting (avoids a wrong-post)');
      }
    }

    if (!boxes.length) { step('Comment: no comment box found — comment not sent'); return 'failed'; }
    step(`Comment: ${boxes.length} comment box(es) found`);

    const target = boxes[0];
    // Focus via in-page scroll+focus (ElementHandle.click can hang on re-rendering feeds).
    step('Comment: focusing the comment box');
    await withTimeout(target.evaluate((el) => { el.scrollIntoView({ block: 'center' }); el.focus(); }), 5000, null);
    await sleep(600);
    if (commentImg) {
      // Scope the file input to the comment box's container ONLY (the document-level
      // input is the feed composer — never fall back to it or we'd mis-attach).
      const cInput = await target.evaluateHandle((el) => {
        const c = el.closest('[role="article"], form, [data-pagelet]') || document;
        return c.querySelector('input[type="file"]');
      }).then((h) => h.asElement()).catch(() => null);
      if (cInput) {
        // Bound the upload with a per-attempt timeout (the comment image input had NONE — a
        // stalled CDP transfer could hang ~90s) and retry once before falling back to text-only.
        const cu = await retryAsync(() => cInput.uploadFile(commentImg), {
          attempts: 2, timeoutMs: 30000, baseDelayMs: 1500, label: 'comment image upload',
          onAttempt: (a, n, e) => step(`Comment: image upload attempt ${a}/${n} failed (${e.message})${a < n ? ' — retrying' : ''}`),
        });
        if (cu.ok) {
          // Wait for the image PREVIEW to actually render before submitting, so a slow CDN
          // upload can't be dropped when Enter fires (a blind fixed delay was unreliable).
          const previewed = await page.waitForFunction(() => !!document.querySelector('[role="article"] img[src^="blob:"], [role="dialog"] img[src^="blob:"]'), { timeout: 15000 }).then(() => true).catch(() => false);
          step(previewed ? 'Comment: image attached (preview rendered)' : 'Comment: image uploaded (preview not detected — submitting anyway)');
          await sleep(1500);
        } else { step(`Comment: image upload failed after retries (${cu.error && cu.error.message}) — posting text only`); }
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
    submitted = true; // past this point the comment IS sent — any error below is verify-only
    // Confirm by watching the box we ACTUALLY typed into: FB clears it (or re-renders it
    // away) once it accepts the comment. Tracking the real target box is far more reliable
    // than re-scanning the feed by caption (which gave false "not confirmed" negatives).
    // E-P4: confirm delivery by watching the box we ACTUALLY typed into — FB empties it (or
    // re-renders it away) once it accepts the comment. If it doesn't empty, re-press Enter ONCE and
    // watch again. This can't double-post: pressing Enter on an already-empty box is a no-op (FB
    // won't submit an empty comment), and we never re-run the whole comment flow after submit.
    const watchEmptied = async (ms) => {
      const dl = Date.now() + ms;
      while (Date.now() < dl) {
        await sleep(1000);
        const state = await withTimeout(target.evaluate((el) => (el.textContent || '').trim()), 3000, 'GONE').catch(() => 'GONE');
        if (state === '' || state === 'GONE') return true; // emptied or re-rendered = submitted
      }
      return false;
    };
    let confirmed = await watchEmptied(4000);
    if (!confirmed) {
      step('Comment: not confirmed yet — re-pressing Enter once');
      try { await page.keyboard.press('Enter'); } catch {} // no-op on an already-empty box (FB rejects empty) — can't double-post
      confirmed = await watchEmptied(3000);
    }
    // C9: landing verification (READ-ONLY) — did our comment text actually appear under the post?
    // We never re-type or re-submit here; this only LABELS the outcome so the operator can tell a
    // confirmed comment from an at-risk one. Outcome: posted / not_visible / unconfirmed.
    let outcome = confirmed ? 'unconfirmed' : 'not_visible'; // start from the box-empty signal
    const commentSnip = String(post.comment || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (commentSnip.length >= 6) {
      const seen = await evalTimed(page, (s) => {
        const arts = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 3);
        return arts.some((a) => (a.innerText || '').includes(s));
      }, commentSnip, 6000).catch(() => null);
      if (seen === true) outcome = 'posted';
      else if (seen === false && confirmed) outcome = 'not_visible';
      // seen === null (timeout): keep the box-empty result (unconfirmed/not_visible)
    } else if (confirmed) {
      outcome = 'posted'; // image-only / very short comment: an emptied box is our best available signal
    }
    step(outcome === 'posted' ? 'Comment: posted and verified ✅ (visible under the post)'
       : outcome === 'not_visible' ? 'Comment: sent but NOT visible under the post — verify this group manually'
       : 'Comment: sent (delivery not auto-verified) — likely OK, spot-check if unsure');
    await sleep(600);
    return outcome;
  } catch (e) {
    // If Enter was already pressed, the comment is (probably) sent — returning a retryable 'failed'
    // would make the caller re-run and DOUBLE-post. Report it but treat as sent (unconfirmed).
    if (submitted) { step(`Comment: post-submit issue (${e.message}) — already sent, not retrying`); return 'unconfirmed'; }
    step(`Comment: error — ${e.message}`); return 'failed';
  }
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

    // Checkpoint / 2FA / captcha — needs a HUMAN, so signal 'checkpoint' (NOT a plain login
    // failure) so the account is flagged needs_verification and you get a desktop notification.
    if (/checkpoint|two_step|two_factor|login\/device-based|captcha/i.test(url)) {
      log(`🚧 [${name}] hit a Facebook security check (2FA/checkpoint/captcha) — needs you`);
      return 'checkpoint';
    }
    const bodyText = await page.evaluate(() => (document.body.innerText || '').toLowerCase()).catch(() => '');
    if (/two.factor|two.step|confirm it.?s you|enter the code|captcha|are you a robot|security check|real person/i.test(bodyText)) {
      log(`🚧 [${name}] hit a Facebook security check (captcha/verification) — needs you`);
      return 'checkpoint';
    }

    // Success: check for c_user cookie (capped — a wedged renderer must not hang auth for 90s)
    const pageCookies = await withTimeout(page.cookies(), 8000, []);
    if (pageCookies.some((c) => c.name === 'c_user' && c.value)) {
      log(`✅ [${name}] logged in with stored credentials`);
      // Persisting cookies must NOT flip a confirmed login into a failure — a transient FS error here
      // would otherwise make the caller flag needs_login and skip a genuinely logged-in account.
      try { store.writeCookies(name, pageCookies); } catch (we) { log(`⚠️ [${name}] logged in but failed to persist cookies: ${we.message}`); }
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
  const { account, post: basePost, groups, settings, useProxies, proxies, log, shouldStop, isLoginOpen, registerAborter, onResult, isOnline, waitIfPaused, isPaused, maxThisRun } = o;
  const reportProxy = typeof o.reportProxy === 'function' ? o.reportProxy : () => {}; // E-X3: proxy health (no-op if absent)
  const name = account.name;
  // Per-account successful-run counter (file-based) — drives the new-account WARM-UP gate below.
  const runCountFile = path.join(store.accountDir(name), 'run-count.txt');
  let priorRuns = 0; try { priorRuns = parseInt(fs.readFileSync(runCountFile, 'utf8'), 10) || 0; } catch {}

  // Emit one audit record per (account, group, post) outcome for the persistent run report.
  const report = (groupName, gid, result, detail, commentResult) => {
    if (typeof onResult !== 'function') return;
    try {
      onResult({
        ts: new Date().toISOString(), account: name, group: displayName(groupName), groupId: gid,
        postId: basePost && basePost.id, caption: shortText((basePost && basePost.caption) || '', 60),
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
    // ---- resource efficiency ----
    // NOTE: --disable-gpu / --disable-software-rasterizer were REMOVED on purpose. They force
    // Chromium's WebGL onto the SwiftShader CPU renderer, and navigator WebGL RENDERER then
    // reports "Google SwiftShader" — a near-unique headless/bot fingerprint FB reads on every
    // page load. Keeping the GPU on lets WebGL report a real renderer (the run is headful).
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
  // Guard the pre-launch profile prep: ensureDir/mkdirSync can throw EPERM/EACCES (profile dir locked
  // by a crashed Chromium, antivirus, or a disconnected drive). Fail this account cleanly with a
  // per-account error instead of throwing opaquely out of the worker.
  // M2-06: clear any zombie Chromium still holding THIS profile's lock (a browser force-killed
  // mid-run) BEFORE prepping/launching, so the account doesn't fail with "profile prep failed".
  // The isLoginOpen guard above already returned if a login browser is open, so this can't kill it.
  try { const cleared = await killChromiumForProfile(store.profileDir(name), (m) => log(`[${name}] ${m}`)); if (cleared) await sleep(800); } catch {}
  try { store.sanitizeProfile(name, settings.hideBrowser !== false); } // pin off-screen placement when hidden
  catch (e) { log(`⚠️ [${name}] profile prep failed (${e.message}) — skipping account`); return { posted: 0, errors: 1, pendingApproval: 0, noRetry: false, flag: null, postedIds: [] }; }
  // Proxy: Chrome can't do authenticated SOCKS5 directly, so we wrap the upstream
  // through proxy-chain (a local anonymized HTTP proxy) when credentials are present.
  let proxyAuth = null, anonLocal = null, watchdog = null;
  const tempImages = []; // downloaded remote images to clean up at the end
  if (useProxies) {
    // Per-account STABLE proxy: prefer the account's OWN assigned proxy; else pick from the shared
    // pool by a stable hash of the account name, so an account keeps the SAME exit IP every run.
    // (FB trusts a consistent per-account IP and links accounts that share/hop IPs — the old code
    // picked a RANDOM pool entry each launch, making every account look like it changed IP each run.)
    let proxyStr = (account.proxy && String(account.proxy).trim()) || '';
    if (!proxyStr && proxies && proxies.length) {
      let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
      proxyStr = proxies[h % proxies.length];
    }
    if (proxyStr) {
      const p = parseProxy(proxyStr);
      if (p) {
        proxyAuth = p;
        if (p.username && proxyChain) {
          try { anonLocal = await proxyChain.anonymizeProxy(p.upstream); launchArgs.push(`--proxy-server=${anonLocal}`); log(`✅ [${name}] proxy ${p.server} (auth via proxy-chain)`); reportProxy(proxyStr, true); }
          catch (e) { launchArgs.push(`--proxy-server=${p.server}`); log(`⚠️ [${name}] proxy-chain failed (${e.message}) — auth credentials may be dropped, expect 407s`); reportProxy(proxyStr, false, 'proxy-chain: ' + e.message); }
        } else { launchArgs.push(`--proxy-server=${p.server}`); log(`🌐 [${name}] proxy ${p.server}`); }
      } else {
        // A configured-but-malformed proxy is a real misconfig. Do NOT silently post from the bare
        // IP (that defeats the point and can burn the account) — skip it and tell the operator.
        const hint = proxyFormatHint(proxyStr);
        log(`🚫 [${name}] proxy string is invalid ("${shortText(proxyStr, 40)}")${hint ? ' — ' + hint : ''}. Skipping this account so it does NOT post from your real IP. Fix the proxy in the Accounts tab.`);
        report('', '', 'error', 'invalid proxy — account skipped', '');
        return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: 'proxy_invalid', postedIds: [] };
      }
    } else {
      log(`⚠️ [${name}] proxies are ON but this account has NO proxy assigned (pool empty) — it will post from your real IP. Assign a proxy in the Accounts tab.`);
    }
  }

  let browser;
  let unregisterAborter = () => {};
  let aborted = false;       // set by the watchdog so the group loop stops touching a dead browser
  let browserClosed = false; // single-shot guard: aborter + watchdog + finally must not double-close
  const closeBrowserOnce = async () => {
    if (browserClosed) return; browserClosed = true;
    // Bound the close so a wedged CDP socket can't block the worker slot, then hard-kill as fallback.
    try { await Promise.race([browser.close().catch(() => {}), sleep(10000)]); } catch {}
    try { const proc = browser && browser.process && browser.process(); if (proc) proc.kill(); } catch {}
  };
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
      unregisterAborter = registerAborter(() => { closeBrowserOnce(); });
    }
    const _pages = await browser.pages();
    for (let i = 1; i < _pages.length; i++) { try { await _pages[i].close(); } catch {} }
    const page = _pages[0] || (await browser.newPage());
    // Make Facebook treat the page as FOCUSED + VISIBLE even when the window is off-screen, and
    // force the window off-screen. Each CDP step has its OWN try/catch + log so a failure in one
    // (e.g. a CDP attach race) can't silently skip the others — the force-off-screen MUST run when
    // hidden even if focus-emulation throws, or a clamped window would stay visible undiagnosed.
    let cdpSession = null;
    try { cdpSession = await page.target().createCDPSession(); }
    catch (e) { log(`⚠️ [${name}] CDP attach failed (${e.message}) — focus/hide setup skipped, window may be visible`); }
    if (cdpSession) {
      if (hidden) {
        // Force the window OFF-SCREEN as the FIRST post-launch CDP call (minimises the on-screen
        // flash on machines that clamp -32000). --window-position is only the initial hint; Chrome
        // re-applies saved placement and Windows can re-clamp, so setWindowBounds — a direct command
        // the restore logic can't override — is what actually guarantees it. Normalize first (bounds
        // are ignored while maximized), then shove it far off the top-left corner.
        try {
          const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
          await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: 1280, height: 900 } });
          const back = await cdpSession.send('Browser.getWindowBounds', { windowId });
          const off = back && back.bounds && (back.bounds.left <= -2000 || back.bounds.top <= -2000);
          log(`🙈 [${name}] window parked off-screen (${off ? 'confirmed' : `still at ${back && back.bounds ? back.bounds.left + ',' + back.bounds.top : '?'} — Windows clamped it`})`);
        } catch (e) { log(`⚠️ [${name}] could not force-hide window (${e.message}) — it may be visible`); }
      }
      try { await cdpSession.send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
      catch (e) { log(`⚠️ [${name}] focus emulation failed (${e.message}) — publish may be slower`); }
    }
    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.hasFocus = () => true;
        // The hidden window is parked at -32000,-32000 (impossible on a real desktop). Report a
        // plausible on-screen position so screenX/Y/Left/Top don't expose the off-screen trick —
        // this leak is present even in "visible" mode's initial frame, matching the user's symptom.
        // Define on Window.prototype (where real browsers expose these) so a probe of
        // Object.getOwnPropertyDescriptor(window,'screenX') sees no own-property override.
        const proto = Object.getPrototypeOf(window) || window;
        for (const pv of [['screenX', 80], ['screenY', 40], ['screenLeft', 80], ['screenTop', 40]]) {
          try { Object.defineProperty(proto, pv[0], { configurable: true, get: () => pv[1] }); }
          catch { try { Object.defineProperty(window, pv[0], { configurable: true, get: () => pv[1] }); } catch {} }
        }
      });
    } catch {}
    // Allow clipboard access so captions can be PASTED (fast + reliable, like the original agent).
    try { await browser.defaultBrowserContext().overridePermissions('https://www.facebook.com', ['clipboard-read', 'clipboard-write']); } catch {}
    // VISIBLE mode: keep the window on-screen (better compositing/flow) but shove it to the BACK so
    // it never steals focus or sits on top of your work. Hidden mode is already off-screen above.
    if (!hidden && browser.process()) {
      log(`🪟 [${name}] visible mode — parking the browser in the background (won't steal focus)`);
      sendWindowToBackground(browser.process().pid).catch(() => {});
    }
    // Watchdog: hard cap on this account's run so one stuck account can never block the
    // whole queue. Generous (a full post+comment is ~3-4 min) so it only fires on a real
    // hang, not normal slow posts. Closing the browser makes in-flight ops reject → cleanup.
    // Budget scales with the CONFIGURED per-group pacing (group delay + comment delay + ~150s of
    // work, +30% jitter headroom) so the new, intentionally-slower human timing never trips the
    // watchdog. The watchdog still probes liveness before aborting, so a generous budget is safe.
    const _gd = (Number.isFinite(settings.groupDelay) ? settings.groupDelay : 180) * 1.3;
    const _cd = Number.isFinite(settings.commentDelayMax) ? settings.commentDelayMax : 180;
    const perGroupMs = (_gd + _cd + 250) * 1000; // +250s work headroom (dwell + slow-typing fallback + upload + publish)
    const accountBudget = Math.max(600000, Math.round(targetGroups.length * perGroupMs));
    // The watchdog must fire ONLY when the account is genuinely wedged. setTimeout counts wall-clock,
    // which includes laptop sleep — so on resume the timer can fire immediately on a perfectly healthy
    // run. Before aborting, probe liveness: if the browser still answers a trivial evaluate it just
    // resumed from sleep → re-arm; only abort if it's truly unresponsive.
    const onWatchdogTick = async () => {
      let alive = false;
      try {
        if (browser && browser.isConnected()) {
          await Promise.race([page.evaluate(() => 1), new Promise((_, r) => setTimeout(() => r(new Error('probe timeout')), 8000))]);
          alive = true;
        }
      } catch { alive = false; }
      if (alive) { log(`⏰ [${name}] budget elapsed but browser is alive (likely resumed from sleep) — extending`); armWatchdog(); return; }
      log(`⏰ [${name}] time budget exceeded and browser unresponsive — aborting account`);
      aborted = true;
      await closeBrowserOnce();
      watchdog = null;
    };
    function armWatchdog() { watchdog = setTimeout(onWatchdogTick, accountBudget); }
    armWatchdog();
    // Fallback auth path if proxy-chain wasn't used. E-X1: log the outcome (it was silently
    // swallowed before) so a 407 storm is diagnosable. We still continue either way.
    if (proxyAuth && proxyAuth.username && !anonLocal) {
      try { await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password }); log(`✅ [${name}] proxy auth via page.authenticate`); }
      catch (e) { log(`⚠️ [${name}] proxy auth (page.authenticate) failed (${e.message}) — 407s expected`); }
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
      const hasCUser = cookieAuthed && (await withTimeout(page.cookies(), 8000, [])).some((c) => c.name === 'c_user' && c.value);
      if (cookieAuthed && hasCUser) {
        log(`🔄 [${name}] session recovered with saved cookies`);
      } else {
        // Cookie recovery failed — try stored credentials (OPT-IN) before flagging for manual login.
        // M3-01: credentials are encrypted at rest (safeStorage); decrypt is transparent (legacy
        // plaintext passes through). Decrypt may yield '' if this machine can't unlock them.
        const credEmail = secret.decrypt(account.email);
        const credPass = secret.decrypt(account.password);
        if (credEmail && credPass) {
          log(`🔐 [${name}] cookies failed — trying stored credentials...`);
          const credResult = await credentialLogin(page, credEmail, credPass, log, name);
          if (credResult === true) {
            log(`🔄 [${name}] session recovered via credential login`);
            // fall through to the normal posting loop
          } else if (credResult === 'checkpoint') {
            log(`🔐 [${name}] auto-login blocked by a captcha/verification — flagging for you to solve`);
            flag = 'needs_verification'; noRetry = true;
            return { posted: 0, errors: 1, pendingApproval: 0, noRetry, flag, postedIds: [] };
          } else {
            log(`❌ [${name}] auto-login failed (wrong password or blocked) — flagging for manual login`);
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

    // New-account WARM-UP (opt-in): before its first few posts, an account browses the feed like a
    // human (scroll + pauses) so it isn't a brand-new identity that ONLY ever opens group composers
    // and posts promos — a strong new-account spam signal.
    if (settings.enableWarmup && priorRuns < (Number.isFinite(settings.warmupRuns) ? settings.warmupRuns : 5) && !shouldStop()) {
      log(`🌱 [${name}] warm-up (prior posting runs: ${priorRuns}) — browsing the feed before posting`);
      try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(2000);
        await dismissPopups(page);
        await humanDwell(page, shouldStop);
        await humanDwell(page, shouldStop);
      } catch (e) { log(`⚠️ [${name}] warm-up skipped (${e.message})`); }
    }

    // Resolve images once: local files, or download remote URLs to temp.
    let resolvedImages = (basePost.imagePaths && basePost.imagePaths.length ? basePost.imagePaths : (basePost.imagePath ? [basePost.imagePath] : []))
      .filter((p) => p && fs.existsSync(p));
    if (!resolvedImages.length && basePost.imageUrl) {
      const dl = await downloadImage(basePost.imageUrl);
      if (dl) { resolvedImages = [dl]; tempImages.push(dl); log(`⬇️ [${name}] image downloaded from URL`); }
      else log(`⚠️ [${name}] image URL set but download failed — posting without image`);
    }
    // Comment image: explicit comment image, remote URL, or the post image when commentWithImage is on.
    let commentImg = null;
    if (basePost.commentImagePath) {
      if (fs.existsSync(basePost.commentImagePath)) { commentImg = basePost.commentImagePath; log(`🖼 [${name}] comment image: uploaded file`); }
      else log(`⚠️ [${name}] comment image file not found (${basePost.commentImagePath}) — comment will have no image`);
    } else if (basePost.commentImageUrl) {
      const dl = await downloadImage(basePost.commentImageUrl);
      if (dl) { commentImg = dl; tempImages.push(dl); log(`🖼 [${name}] comment image: downloaded from URL`); }
      else log(`⚠️ [${name}] comment image URL set but download failed — comment will have no image`);
    } else if (settings.commentWithImage && resolvedImages.length) {
      commentImg = resolvedImages[0]; log(`🖼 [${name}] comment image: reusing the post image (commentWithImage)`);
    }

    // The post is meant to carry an image but none could be resolved (missing local file, or a
    // URL that wouldn't download even after retries). Do NOT fall through to the group loop —
    // groupImages would be empty and every group would publish a bare caption (silent data loss).
    // Bail for this post; it stays un-dealt and is retried next cycle.
    const wantsImage = !!((basePost.imagePaths && basePost.imagePaths.length) || basePost.imagePath || basePost.imageUrl);
    if (wantsImage && !resolvedImages.length) {
      log(`❌ [${name}] post requires an image but none could be resolved — not posting (would be image-less). Will retry next cycle.`);
      report('', '', 'error', 'post image could not be resolved', '');
      return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: null, postedIds: [], dealtIds: [], fullyPosted: false, offline: false };
    }

    const groupRetries = {}; // E-P1: per-group transient-retry counter (max 1 retry, pre-publish only)
    for (let i = 0; i < targetGroups.length; i++) {
      let publishClicked = false; // E-P1: once true, NEVER retry this group (would risk a double-post)
      if (aborted) { log(`⏹ [${name}] watchdog aborted this account — not touching the dead browser`); break; }
      if (shouldStop()) { log(`⏹ [${name}] stop requested`); break; }
      // Mid-run toggle: stop between groups if the user turned this account OFF during the run.
      try { const me = store.load().accounts.find((a) => a.name === name); if (me && me.enabled === false) { log(`⏸ [${name}] turned OFF — stopping this account`); break; } } catch {}
      // Pause holds here, between groups, so Pause takes effect mid-account. A deliberate
      // pause is NOT a hang: suspend the time-budget watchdog while held, then re-arm it on
      // resume so a long pause can't make the watchdog kill this account's browser.
      if (isPaused && isPaused()) {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (waitIfPaused) await waitIfPaused();
        if (shouldStop()) { log(`⏹ [${name}] stop requested`); break; }
        armWatchdog();
      }
      // (A previous "i>=2 re-check the block" scan lived here. It ran BEFORE navigating to group i,
      // so it read the PREVIOUS group's STALE page and could false-flag a healthy account as
      // rate-limited off a generic transient error — abandoning the rest of its groups. Removed: the
      // real block checks already run per-group AFTER the group loads, below.)
      const g = targetGroups[i];
      const gid = g.groupId || g.id;
      const groupName = g.name || gid;
      const step = createStepLogger(log, name, groupName);
      // Per-group content variation: expand {a|b|c} spintax so THIS group gets a different caption
      // and comment than the others, and give any link in the comment a unique tracking param. This
      // is the #1 fix for "identical content to many groups" — FB's strongest content-spam signal.
      let captionText = basePost.caption || '', commentText = basePost.comment || '';
      if (settings.varyContent !== false) { captionText = spintax.expand(captionText); commentText = spintax.expand(commentText); }
      if (settings.randomizeLinks !== false) commentText = varyLinks(commentText, `${name}|${gid}`);
      const post = { ...basePost, caption: captionText, comment: commentText };
      let groupImages = resolvedImages, groupCommentImg = commentImg; // per-group (optionally perturbed) images
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

        // Dwell like a human reading the group feed (mouse drift + a few scrolls with pauses)
        // before composing, instead of opening the composer instantly on every visit (a bot tell).
        await humanDwell(page, shouldStop);

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

        // Perturb the image per (account, group) so the SAME picture doesn't upload with an
        // IDENTICAL perceptual hash to every group — FB dedups images across groups, a strong
        // spam signal. Visually identical; best-effort (falls back to the original if jimp is off).
        if (settings.varyImages !== false && imageVary.available() && resolvedImages.length) {
          const vi = [];
          for (const im of resolvedImages) {
            const v = await imageVary.varyImage(im, `${name}|${gid}|${im}`);
            if (v) { vi.push(v); tempImages.push(v); } else vi.push(im);
          }
          groupImages = vi;
          if (groupCommentImg) { const cv = await imageVary.varyImage(groupCommentImg, `${name}|${gid}|c|${groupCommentImg}`); if (cv) { groupCommentImg = cv; tempImages.push(cv); } }
          step('Image varied (unique hash for this group)');
        }

        // Image FIRST, then caption — mirrors the original agent. Paste is atomic so the
        // image's re-render can't clobber the caption. Scope the file input to the DIALOG.
        if (groupImages.length) {
          step(`Uploading ${groupImages.length} image(s)`);
          const input = (await page.$('div[role="dialog"] input[type="file"]')) || (await page.$(SEL.fileInput));
          if (!input) {
            // The post is meant to carry an image — never publish it image-less. Skip the group
            // (it stays un-dealt and is retried next cycle) instead of posting a bare caption.
            step('Image input not found in composer — skipping group to avoid an image-less post');
            errors++; report(groupName, gid, 'error', 'image input not found in composer', ''); continue;
          }
          // Retry the upload (a stalled CDP file transfer / slow disk is often transient) with a
          // per-attempt timeout so it can't hang the account for the full protocolTimeout.
          const up = await retryAsync(() => input.uploadFile(...groupImages), {
            attempts: 3, timeoutMs: 30000, baseDelayMs: 1500, label: 'image upload',
            onAttempt: (a, n, e) => step(`Image upload attempt ${a}/${n} failed (${e.message})${a < n ? ' — retrying' : ''}`),
          });
          if (!up.ok) {
            // Retries exhausted. Do NOT click Post — a post without its intended image is silent
            // data loss. Skip the group; it stays un-dealt and is retried next cycle.
            step('Image upload failed after retries — skipping group (will retry next cycle)');
            errors++; report(groupName, gid, 'error', 'image upload failed after retries', ''); continue;
          }
          step('Image attached');
          await sleepInterruptible(3500, shouldStop);
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
        // Variable human "re-read before posting" pause (2-8s), not a fixed 1.5s on every post.
        await sleepInterruptible(2000 + Math.floor(Math.random() * 6000), shouldStop, 500);
        step('Waiting for Post button to enable');
        const dialogCountBefore = await page.evaluate(() => document.querySelectorAll('div[role="dialog"]').length).catch(() => 1);
        // Log what the Post-button scan sees (dialogs open, found label) — mirrors original's "🔍 Dialogs: N".
        const postBtnInfo = await page.evaluate((labels) => {
          const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
          const scope = dialogs.length ? dialogs : [document];
          for (const root of scope) {
            const btn = Array.from(root.querySelectorAll('[role="button"], button')).find((b) =>
              b.getAttribute('aria-disabled') !== 'true' && !b.disabled && labels.includes(norm(b.getAttribute('aria-label') || b.textContent)));
            if (btn) return { found: true, dialogs: dialogs.length, label: (btn.getAttribute('aria-label') || btn.textContent || '').trim() };
          }
          // None matched — collect the enabled button labels we DID see so drift is diagnosable.
          const seen = [];
          for (const root of scope) for (const b of root.querySelectorAll('[role="button"], button')) {
            const l = (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim();
            if (l && b.getAttribute('aria-disabled') !== 'true') seen.push(l);
          }
          return { found: false, dialogs: dialogs.length, seen: seen.slice(0, 10) };
        }, FB.postButton).catch(() => null);
        if (postBtnInfo) {
          if (postBtnInfo.found) step(`Post button found (label="${postBtnInfo.label}")`);
          else step(`⚠️ Post button NOT found (${postBtnInfo.dialogs} dialog(s)) — possible selector drift. Buttons seen: ${(postBtnInfo.seen || []).join(' | ') || '(none)'}. If this recurs, run scripts/inspect-fb.js.`);
        }
        publishClicked = true; // E-P1: from here on this group must NOT be retried (would double-post)
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
        // Pending-approval detection (BEFORE dismissing popups — a dismissible notice could be cleared).
        // BUG FIX: a moderated group's RULE text ("all posts will be reviewed by admins") was
        // false-positiving the body-text scan and skipping posts that actually LANDED. Corroborate
        // with FACT: if our post is verifiably LIVE in the feed (the newest non-pinned article
        // contains our caption and isn't itself pending-badged), it did NOT go pending — never skip a
        // post that's visible. Only fall back to the text scan when we can't confirm (short/image-only
        // captions, where we can't reliably match our article).
        const pendingSnip = (post.caption || '').replace(/\s+/g, ' ').trim().slice(0, 25);
        const postIsLive = pendingSnip.length >= 12 ? await evalTimed(page, (s) => {
          const arts = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 4);
          return arts.some((a) => {
            const head = (a.innerText || '').slice(0, 200).toLowerCase();
            if (/pending|en attente|ausstehend|in attesa|pendiente|aguardando|jovahagyas/.test(head)) return false; // this article IS pending-badged
            return (a.textContent || '').includes(s);
          });
        }, pendingSnip, 6000).catch(() => false) : false;
        const isPending = !postIsLive && await checkPendingApproval(page);
        await dismissPopups(page); // clear "Your post might be reviewed" etc.

        // Moderated groups queue posts for admin approval — don't count as posted and skip the comment.
        if (isPending) {
          step('Post submitted but PENDING ADMIN APPROVAL — not counted, comment skipped');
          pendingApproval++;
          report(groupName, gid, 'pending', 'awaiting admin approval', 'skipped');
          if (i < targetGroups.length - 1) await sleepInterruptible(jitter((Number.isFinite(settings.groupDelay) ? settings.groupDelay : 180) * 1000), shouldStop, 1000);
          continue;
        }
        if (postIsLive) step('Confirmed live in the feed (a moderated-group "will be reviewed" notice, if any, was a false positive)');

        // Success log — keep caption snippet for the renderer's auto-delete tracker.
        step('Posted successfully');
        posted++;
        // E-P3: even when publish "succeeded", scan once for a block/checkpoint phrase the
        // pre-publish detectors didn't catch. If present, the account is being throttled NOW — cool
        // it down IMMEDIATELY (skip this post's comment + the account's remaining groups) instead of
        // only warning. The post itself already landed, so it's still recorded as 'posted'.
        let emergingBlock = false;
        try {
          const suspect = await evalTimed(page, (cfg) => {
            const t = (document.body.innerText || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
            return [...cfg.rate, ...cfg.cp].find((p) => t.includes(p)) || null;
          }, { rate: FB.rateLimit, cp: FB.checkpoint }, 6000);
          if (suspect) { emergingBlock = true; step(`🛑 Posted, but an EMERGING block/checkpoint phrase is present ("${suspect}") — cooling down this account immediately (emerging limit, distinct from an explicit block)`); }
        } catch {}
        if (emergingBlock) {
          flag = 'rate_limited'; noRetry = true;
          report(groupName, gid, 'posted', 'emerging block detected after publish — cooling down (comment skipped)', 'skipped');
          break;
        }

        // Capture the just-published post's permalink WHILE it's the newest post (BEFORE the anti-spam
        // wait shuffles the feed). The comment step opens the post DIRECTLY via this link — the only
        // reliable way to find OUR post after a 1-3 min wait. Verify the link is OURS by matching the
        // caption (when long enough); image-only/short trusts the newest-non-pinned position. Retry ≤2×.
        const capSnip = (post.caption || '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().slice(0, 25);
        let postPermalink = null;
        for (let pA = 1; pA <= 2 && !postPermalink && !shouldStop(); pA++) {
          const cap = await withTimeout(page.evaluate((s) => {
            const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
            const arts = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 6);
            for (const a of arts) {
              if (/pinned|épinglé|rögzített/.test((a.innerText || '').slice(0, 200).toLowerCase())) continue; // skip pinned
              const link = a.querySelector('a[href*="/posts/"], a[href*="/permalink/"]');
              if (link && link.href && /\/(posts|permalink)\//.test(link.href)) return { href: link.href.split('?')[0], matched: !s || norm(a.textContent).includes(s) };
            }
            return null;
          }, capSnip), 6000, null).catch(() => null);
          if (cap && (cap.matched || capSnip.length < 12)) { postPermalink = cap.href; step(`Comment: captured the post link (${cap.matched ? 'caption verified ✓' : 'by position'}) for a direct comment`); }
          else { if (cap) step(`Comment: newest post link didn't match our caption (attempt ${pA}/2)`); if (pA < 2) await sleepInterruptible(2000, shouldStop); }
        }
        if (!postPermalink) step('Comment: no verified post link — the comment step will use the caption/feed fallback');

        // First comment (often a link) — reload, find OUR post, comment in its box.
        // addFirstComment logs every stage itself (via the same step() logger).
        // Fire when there is comment TEXT or a comment IMAGE — an image-only comment is valid.
        const wantComment = !!((post.comment && post.comment.trim()) || groupCommentImg);
        let commentResult = wantComment ? 'failed' : 'none';
        if (wantComment) {
          // CRITICAL anti-spam: do NOT comment seconds after the post — post-then-instant-link is a
          // textbook spam pattern. Wait a randomized human gap first. The permalink was already
          // captured above, so OUR post is still found reliably even after the wait.
          const lo = Number.isFinite(settings.commentDelayMin) ? settings.commentDelayMin : 60;
          const hi = Number.isFinite(settings.commentDelayMax) ? settings.commentDelayMax : 180;
          const cd = Math.round((Math.min(lo, hi) + Math.random() * Math.abs(hi - lo)) * 1000);
          if (cd > 0 && !shouldStop()) { step(`Comment: waiting ${Math.round(cd / 1000)}s before commenting (avoids the instant post→link spam pattern)`); await sleepInterruptible(cd, shouldStop, 1000); }
          // Retry up to 3× — addFirstComment only returns the retryable 'failed' BEFORE it presses
          // Enter (no box found, stalled renderer; 'skipped' for short-caption-no-link), so a retry
          // (it re-navigates each time) can NEVER duplicate an already-sent comment. C2: keep a per-
          // attempt human gap so retries don't collapse into an instant burst.
          let cres = 'failed';
          for (let cAttempt = 1; cAttempt <= 3 && cres === 'failed' && !shouldStop() && !aborted && browser && browser.isConnected(); cAttempt++) {
            if (cAttempt > 1) {
              const gap = Math.max(2500, Math.round(Math.min(lo, hi) * 1000 * 0.25)); // ~25% of the min delay
              step(`Comment: retry ${cAttempt}/3 (waiting ${Math.round(gap / 1000)}s — keeping the human cadence)`);
              await sleepInterruptible(gap, shouldStop);
            }
            cres = await addFirstComment(page, gid, post, groupCommentImg, step, postPermalink);
          }
          commentResult = cres;
          if (cres === 'failed') step('Comment: could not place the comment after 3 attempts — left uncommented');
          else if (cres === 'skipped') step('Comment: skipped (could not safely identify our post)');
        }
        report(groupName, gid, 'posted', '', commentResult);
      } catch (e) {
        // E-P1: retry the SAME group ONCE on a TRANSIENT failure that happened BEFORE the publish
        // click — so we reclaim groups lost to a CDP blip / nav timeout without any double-post risk.
        // Block errors (rate-limit/checkpoint) and post-publish errors are never retried here.
        const cls = classifyGroupError(e.message);
        if (cls === 'transient' && !publishClicked && (groupRetries[gid] || 0) < 1 && !shouldStop() && browser && browser.isConnected()) {
          groupRetries[gid] = (groupRetries[gid] || 0) + 1;
          step(`Transient error before publish (${e.message}) — retrying this group once`);
          await sleepInterruptible(2500, shouldStop);
          i--; continue; // re-attempt the same group (nothing was published)
        }
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

      // Daily-cap budget: stop this account once it has used its remaining posts for today, so a
      // single run can't overshoot the cap by (groups - 1). maxThisRun is the orchestrator's
      // remaining-budget for this account today (Infinity / undefined when the cap is off).
      if (Number.isFinite(maxThisRun) && posted >= maxThisRun) { log(`📵 [${name}] reached today's remaining post budget (${posted}) — stopping this account`); break; }

      // Interruptible delay between groups (respects Stop + configurable groupDelay), jittered ±30%
      // so the cadence is never metronomic (a fixed gap is itself a bot signal).
      if (i < targetGroups.length - 1) {
        const d = jitter((Number.isFinite(settings.groupDelay) ? settings.groupDelay : 180) * 1000);
        if (d > 0) {
          step(`Wait ${d >= 60000 ? Math.round(d / 60000) + 'min' : Math.round(d / 1000) + 's'} before next group`);
          await sleepInterruptible(d, shouldStop, 1000);
        }
      }
    }
    // Posted NOTHING across all its groups (errors, no specific reason) → flag the account so the
    // operator checks it, but we did NOT skip any group (avoids the per-group false positive).
    if (posted === 0 && pendingApproval === 0 && errors > 0 && !flag && !offline && !shouldStop()) flag = 'likely_blocked';
    // Persist refreshed cookies for next run.
    try { const cks = await withTimeout(page.cookies(), 8000, null); if (cks) store.writeCookies(name, cks); } catch {}
    fs.writeFileSync(require('path').join(store.accountDir(name), 'last-run-success.txt'),
      `${errors === 0 ? 'SUCCESS' : 'PARTIAL'}\nPosts: ${posted}\nPending: ${pendingApproval}\nTime: ${new Date().toISOString()}\n`);
    // Bump the warm-up run counter for any completed run (not only posted>0) so a new account that
    // keeps failing to post still ages out of warm-up instead of repeating the warm-up browse forever.
    try { fs.writeFileSync(runCountFile, String(priorRuns + 1)); } catch {}
  } catch (e) {
    errors++;
    log(`❌ [${name}] fatal: ${e.message}`);
  } finally {
    unregisterAborter();
    if (watchdog) clearTimeout(watchdog);
    if (browser) await closeBrowserOnce();
    if (anonLocal && proxyChain) { try { await proxyChain.closeAnonymizedProxy(anonLocal, true); } catch {} }
    for (const t of tempImages) { try { fs.unlinkSync(t); } catch {} }
  }
  // fullyPosted = the post landed in EVERY targeted group, none pending, no errors — only then is it
  // safe to auto-delete from the library (a partial publish must be kept). See orchestrator deal gate.
  return { posted, errors, pendingApproval, noRetry, flag, offline, fullyPosted: errors === 0 && pendingApproval === 0 && posted === targetGroups.length };
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
  // exported for tests (no runtime effect)
  jitter, varyLinks, retryAsync, downloadImage, isSafeImageUrl, proxyFormatHint, classifyGroupError,
  FB, isRateLimitText, isCheckpointText, isPendingText, isPostButtonLabel, isCommentBoxLabel,
};
