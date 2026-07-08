// automation/worker.js
// Drives ONE Facebook account through its assigned groups for a single post.
// Uses puppeteer-extra + stealth, a persistent per-account Chromium profile, and
// optional SOCKS5 proxy. Best-effort, defensive selectors with verbose logging.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchStealth, viewportFor, applyProxyGeo, attachGeoToNewTargets } = require('../lib/browser'); // ONE hardened launch path (real Chrome + no automation flag + stealth)
let axios; try { axios = require('axios'); } catch {}
let proxyChain; try { proxyChain = require('proxy-chain'); } catch {}

const store = require('../lib/store');

// One-time sweep of orphaned comment-image temps (zpv-*) in the OS temp dir. A temp handed off to the rescue/moderator
// queue is intentionally kept past runAccount's cleanup so its consumer can upload it; if that consumer never runs
// (crash/abort between persist and the rescue phase), the file would leak. Reclaim any older than 24h at module load.
try {
  const _tmp = os.tmpdir(), _cut = Date.now() - 24 * 3600 * 1000;
  for (const f of fs.readdirSync(_tmp)) {
    if (!/^(zpv-|za-img-)/.test(f)) continue; // zpv- = varied images; za-img- = downloaded (URL) images that were handed off un-varied
    try { const p = path.join(_tmp, f); if (fs.statSync(p).mtimeMs < _cut) fs.unlinkSync(p); } catch {}
  }
} catch {}
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

// Stop- AND Pause-aware sleep. isPaused/onPause are OPTIONAL + trailing so the dozens of existing
// 3-arg callers are unchanged. When paused, it HOLDS (paused time does NOT count against the wait) and
// invokes onPause() — the caller passes a hold that suspends+re-arms the time-budget watchdog so a long
// pause can't make the watchdog abort the browser (the mid-cycle "Pause keeps going" fix).
async function sleepInterruptible(ms, shouldStop = () => false, step = 500, isPaused = null, onPause = null) {
  let waited = 0;
  while (waited < ms && !shouldStop()) {
    if (isPaused && isPaused()) {
      if (onPause) await onPause(); else await sleep(step);
      if (shouldStop()) break;
      continue; // re-check; do NOT advance `waited` while paused
    }
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

// A random integer in [min, max] — the primitive for making EVERY human-facing pause a fresh value
// in a range (never a constant), so the posting cadence is never metronomic (a top spam signal).
// Order-tolerant and non-negative; if max<min they're swapped. Pure (exported for tests).
function rand(min, max) {
  let lo = Math.max(0, Math.floor(Number(min) || 0));
  let hi = Math.max(0, Math.floor(Number(max) || 0));
  if (hi < lo) { const t = lo; lo = hi; hi = t; }
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

const _VARIANCE = { interact: 0.4, settle: 0.35, pause: 0.3, wait: 0.25 };
// Pull a settings min/max range (in SECONDS) and return a random ms value in it, with a hard floor
// so a mis-set/low value can never produce a sub-safe (burst-signal) gap. Falls back to defaults.
function rangeMs(settings, minKey, maxKey, defMin, defMax, floorSec = 0) {
  settings = settings || {};
  const hasLo = Number.isFinite(settings[minKey]);
  const hasHi = Number.isFinite(settings[maxKey]);
  const lo = hasLo ? settings[minKey] : defMin;
  const hi = hasHi ? settings[maxKey] : defMax;
  // Honor an EXPLICIT operator setting down to a 1s absolute floor, so deliberately-fast values actually
  // take effect (e.g. "post like a fast real user"). The larger safety floor only guards the built-in
  // DEFAULTS (when the value was left unset) so a fresh install can't accidentally burst-post.
  const eff = (hasLo || hasHi) ? 1 : floorSec;
  return rand(Math.max(eff, Math.min(lo, hi)) * 1000, Math.max(eff, Math.max(lo, hi)) * 1000);
}
// HARD anti-spam floors — a safety net that the FASTEST mode / lowest operator setting / 'fast' pace can never
// undercut, so the app can't burst-post no matter how it's configured. Randomized (never a fixed cadence). These
// guard the two strongest spam signals: posting to the next group, and the post→link-comment gap. Operator
// settings only ever make the gap LONGER than the floor — never shorter. `withFloor(ms, minMs)` = the bigger of
// the configured (already-random) gap and a jittered floor, so even a 0/1s config yields a safe ~minMs±jitter.
const ANTI_SPAM_MIN_GROUP_MS = 20000;   // ≥ ~20s between posts to different groups (per account)
const ANTI_SPAM_MIN_COMMENT_MS = 30000; // ≥ ~30s after a post before its link-comment (post→instant-link = spam)
// TURBO mode uses SMALLER (but never zero) anti-spam floors so the operator's fast gaps actually take effect.
// Never 0: an instant post→link or back-to-back group post is FB's top ban trigger AND can fire before the
// post is permalink-resolvable (lost comment). Non-turbo modes keep the full 20s/30s floors.
function antiSpamFloors(settings) {
  const m = settings && settings.speedMode;
  // INSTANT = operator's "extra speed" tier: aggressively small but NON-ZERO floors. The comment (link) floor must
  // never go truly instant — post→link in <~3s is FB's strongest single ban trigger — so 4s is the hard minimum here.
  if (m === 'instant') return { group: 1500, comment: 4000 };
  if (m === 'turbo') return { group: 8000, comment: 12000 };
  return { group: ANTI_SPAM_MIN_GROUP_MS, comment: ANTI_SPAM_MIN_COMMENT_MS };
}
function isTurboMode(settings) { return !!(settings && (settings.speedMode === 'turbo' || settings.speedMode === 'instant')); }
function withFloor(ms, minMs, pct = 0.25) { return Math.max(jitter(Math.max(0, Number(minMs) || 0), pct), Math.round(Math.max(0, Number(ms) || 0))); }

// Stable per-account BEHAVIORAL personality (seeded by the account-name hash, like viewportFor). Gives every account a
// CONSISTENT-but-DISTINCT typing speed, reading pace, gap tempo, and typo-proneness — so many accounts on ONE host don't
// all share the SAME timing distribution (a cross-account behavioral cluster the fingerprint work doesn't cover). Gentle
// + bounded; the anti-spam FLOORS still cap every gap, so a "fast" personality can never post below the hard minimums.
function behaviorFor(name) {
  let h = 2166136261 >>> 0; const s = String(name || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } // FNV-1a seed
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; }; // deterministic per-name stream
  const pick = (lo, hi) => lo + rnd() * (hi - lo);
  return {
    typeMult: pick(0.72, 1.45),   // slow ↔ fast typist (scales the per-key delay)
    dwellMult: pick(0.7, 1.4),    // skims ↔ reads (scales the browse dwell)
    gapMult: pick(0.85, 1.3),     // eager ↔ deliberate (scales inter-group / post→comment gaps — still FLOORED)
    fumbleRate: pick(0.05, 0.14), // how typo-prone this account is
  };
}
// Jitter a base delay by the per-class variance (interact/settle/pause/wait). Honors humanizeMaster:
// when explicitly false (tests/deterministic), returns the exact base. The post->comment anti-spam
// window is NOT routed through here — it stays randomized regardless of the master switch.
function humanDelay(base, settings = {}, variant = 'settle') {
  if (settings && settings.humanizeMaster === false) return Math.max(0, Math.floor(Number(base) || 0));
  const tv = (settings && settings.timingVariance) || _VARIANCE;
  const pct = Number.isFinite(tv[variant]) ? tv[variant] : _VARIANCE[variant];
  return jitter(base, pct);
}

// Per-account PACE profile → an effective settings overlay. Returns settings UNCHANGED for 'normal'/absent
// (so the global tempo is inherited and any caller/test that doesn't set a pace is unaffected). 'safe' DOUBLES
// every per-post timing window (and forces human dwell on, even if the global preset was fast); 'fast' HALVES
// them (and switches on the fast typing/dwell-skip path). We scale the SETTINGS OBJECT — not each call-site —
// so the per-account watchdog budget (groupDelayMax/commentDelayMax) and humanDwell, which read these same
// keys, scale automatically with no extra wiring. Pool-topology gaps (waitInterval/accountDelay) are
// deliberately excluded: they're orchestrator-level, so a per-account pace never alters cycle/stagger cadence.
const _PACE_MULT = { safe: 2.0, normal: 1.0, fast: 0.5, turbo: 0.25, instant: 0.1 };
const _PACE_KEYS = ['groupDelayMin', 'groupDelayMax', 'commentDelayMin', 'commentDelayMax', 'pageScrollDwellSecMin', 'pageScrollDwellSecMax', 'commentDwellSecMin', 'commentDwellSecMax', 'prePublishDwellSecMin', 'prePublishDwellSecMax', 'composerOpenInitialDelayMs'];
function applyPace(settings, pace) {
  settings = settings || {};
  const key = (pace === 'safe' || pace === 'normal' || pace === 'fast' || pace === 'turbo' || pace === 'instant') ? pace : (settings.defaultPace || 'normal');
  const mult = _PACE_MULT[key] || 1.0;
  if (key === 'normal' || mult === 1.0) return settings; // inherit the global tempo unchanged
  const s = { ...settings };
  for (const k of _PACE_KEYS) if (Number.isFinite(s[k])) s[k] = Math.max(0, Math.round(s[k] * mult));
  // composerOpenInitialDelayMs has a documented 800ms render floor (store.clampSettings) — a 0.5× scale must not undercut it.
  if (Number.isFinite(s.composerOpenInitialDelayMs)) s.composerOpenInitialDelayMs = Math.max(800, s.composerOpenInitialDelayMs);
  if (key === 'safe') { s.humanizeMaster = true; if (s.speedMode === 'fast' || s.speedMode === 'turbo' || s.speedMode === 'instant') s.speedMode = 'normal'; } // a 'safe'-pace account must NOT inherit a fast/turbo/INSTANT global speedMode — it would paste + skip all human dwell, contradicting the whole point of 'safe'
  // 'fast' takes the instant typing/dwell-skip path — but must NOT override a deliberately conservative global 'slow' preset
  // (the gaps still halve via _PACE_MULT; only the human-behavior switch is withheld so the operator's max-caution intent holds).
  else if (key === 'fast') { if (s.speedMode !== 'slow') s.speedMode = 'fast'; }
  // 'turbo' = the very-fast tier: quarter the gaps (×0.25) + the global turbo speed (still respects a deliberate global 'slow').
  else if (key === 'turbo') { if (s.speedMode !== 'slow') s.speedMode = 'turbo'; }
  // 'instant' = the operator's max-speed tier: paste everything + 0–7s gaps (still respects a deliberate global 'slow').
  else if (key === 'instant') { if (s.speedMode !== 'slow') s.speedMode = 'instant'; }
  return s;
}

// Move the cursor to (x,y) along a short multi-step path instead of teleport-clicking. FB's
// integrity JS expects a real mouse trajectory before a click; a click with no preceding
// mousemove is non-human. Best-effort — never throws into the caller.
async function moveMouseTo(page, x, y) {
  try {
    const tx = x + (Math.random() * 6 - 3), ty = y + (Math.random() * 6 - 3); // endpoint jitter — never land pixel-perfect
    // Seed a plausible prior cursor position so even the FIRST move on a page ARCS — a straight teleport-line to the
    // composer / publish button (the most-scrutinized click, right after a nav) is itself a bot tell.
    const from = page.__zpMouse || { x: 200 + Math.random() * 700, y: 150 + Math.random() * 500 };
    const dx = tx - from.x, dy = ty - from.y, dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist, ny = dx / dist; // unit perpendicular to the travel direction
    // A human hand draws a CONTINUOUS ARC — not a straight line, and not the two-segment polyline a single bowed midpoint
    // gives. Emit 2–3 waypoints bowed along a SINE arc (0 at the ends, max in the middle) so the linear interpolation
    // between them approximates a smooth curve, each with a small beat so the motion spans real time (not one CDP burst).
    const bowMag = Math.min(62, dist * 0.16) * (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.9);
    const wpN = 2 + Math.floor(Math.random() * 2);
    for (let i = 1; i <= wpN; i++) {
      const t = i / (wpN + 1), bow = Math.sin(t * Math.PI) * bowMag;
      const wx = from.x + dx * t + nx * bow + (Math.random() * 4 - 2), wy = from.y + dy * t + ny * bow + (Math.random() * 4 - 2);
      await page.mouse.move(wx, wy, { steps: 3 + Math.floor(Math.random() * 5) });
      await sleep(5 + Math.floor(Math.random() * 20));
    }
    if (dist > 45 && Math.random() < 0.18) { // overshoot-and-correct on longer moves — a strong human micro-motion
      await page.mouse.move(tx + (Math.random() * 12 - 6), ty + (Math.random() * 9 - 4.5), { steps: 3 + Math.floor(Math.random() * 4) });
      await sleep(12 + Math.floor(Math.random() * 30));
    }
    await page.mouse.move(tx, ty, { steps: 4 + Math.floor(Math.random() * 7) }); // always END exactly on target so the click lands
    page.__zpMouse = { x: tx, y: ty };
    await sleep(30 + Math.floor(Math.random() * 120));
  } catch {}
}

// "Fast path": instant typing + skipped human-reading dwells. True when humanization is OFF, or the operator
// chose a FAST or TURBO ("super experienced user") speed preset. The anti-spam GAPS (group/comment/cycle
// delays) still apply from their ranges — only the cosmetic dwells/typing speed collapse here.
function isFastMode(settings) {
  settings = settings || {};
  return settings.humanizeMaster === false || settings.speedMode === 'fast' || settings.speedMode === 'turbo' || settings.speedMode === 'instant';
}

// Land on a group and behave like a human reading before composing: a little mouse drift and a
// few wheel scrolls with pauses, total ~5-13s. Reduces the "instant composer open" bot pattern.
// WARM-UP engagement: react to up to `max` posts on the CURRENT page with REAL mouse clicks (FB ignores a
// synthetic .click() on the Like control). Matches the English + French quick-Like aria-labels, skips an
// already-liked post, and dwells like a human between reactions. Best-effort — never throws, never blocks posting.
async function warmLikePosts(page, max, shouldStop, log, name) {
  let liked = 0;
  try {
    for (let i = 0; i < max && !shouldStop(); i++) {
      const pt = await page.evaluate(() => {
        const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isLike = (b) => {
          const l = norm(b.getAttribute('aria-label') || '');
          return (l === 'like' || l === 'jaime' || l === 'j aime' || l === 'react' || l === 'reagir') &&
            b.getAttribute('aria-pressed') !== 'true' && !b.hasAttribute('data-zp-liked');
        };
        const btn = Array.from(document.querySelectorAll('[role="button"]')).find((b) => {
          if (!isLike(b)) return false;
          const r = b.getBoundingClientRect();
          return r.width > 20 && r.height > 10 && r.top > 80 && r.top < (window.innerHeight - 80); // visible, in viewport
        });
        if (!btn) return null;
        btn.setAttribute('data-zp-liked', '1'); // don't pick the same control twice
        btn.scrollIntoView({ block: 'center' });
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) };
      }).catch(() => null);
      if (!pt) break;
      await sleep(900 + Math.floor(Math.random() * 1600)); // "read" the post before reacting
      if (shouldStop()) break;
      await page.mouse.move(pt.x, pt.y, { steps: 6 + Math.floor(Math.random() * 8) }).catch(() => {});
      await page.mouse.click(pt.x, pt.y, { delay: 40 + Math.floor(Math.random() * 70) }).catch(() => {});
      liked++;
      await sleep(1500 + Math.floor(Math.random() * 2500)); // dwell after reacting (don't machine-gun reactions)
    }
  } catch {}
  if (liked && log) { try { log(`🌱 [${name}] warm-up: reacted to ${liked} post(s)`); } catch {} }
  return liked;
}

async function humanDwell(page, shouldStop = () => false, settings = {}) {
  try {
    // humanizeMaster off / fast / turbo → skip the human-reading dwell entirely (deterministic + fast).
    if (isFastMode(settings)) return;
    // T5: total browse time is a random draw from the configurable pageScrollDwell range (0/0 = skip).
    const _dm = (settings._behavior && Number.isFinite(settings._behavior.dwellMult)) ? settings._behavior.dwellMult : 1;
    const dwellMs = Math.round(rangeMs(settings, 'pageScrollDwellSecMin', 'pageScrollDwellSecMax', 3, 15, 0) * _dm); // × per-account reading pace
    if (dwellMs <= 0) return;
    // timingVariance.pause governs dwell jitter (was a hardcoded 0.4); store clamps it to 0–0.6.
    const vpct = (settings.timingVariance && Number.isFinite(settings.timingVariance.pause)) ? settings.timingVariance.pause : 0.3;
    await moveMouseTo(page, 380 + Math.random() * 240, 280 + Math.random() * 160);
    const scrolls = 2 + Math.floor(Math.random() * 3);
    const perStep = Math.max(300, Math.floor(dwellMs / (scrolls + 1)));
    for (let s = 0; s < scrolls && !shouldStop(); s++) {
      try { await page.mouse.wheel({ deltaY: 200 + Math.random() * 320 }); } catch {}
      // Drift the cursor to a random feed coord between scrolls — a static cursor during scrolling is a
      // bot tell. Fold the move's latency INTO the per-step wait so total dwell stays within range.
      const _t0 = Date.now();
      try { await moveMouseTo(page, 340 + Math.random() * 320, 240 + Math.random() * 260); } catch {}
      await sleepInterruptible(Math.max(0, jitter(perStep, vpct) - (Date.now() - _t0)), shouldStop, 500);
    }
    if (!shouldStop()) { try { await page.mouse.wheel({ deltaY: -(150 + Math.random() * 200) }); } catch {} }
    await sleepInterruptible(jitter(perStep, vpct), shouldStop, 500);
  } catch {}
}

// Give each link in the text a unique query param so the SAME url isn't posted verbatim to every
// group (FB dedups exact URLs across groups) — WITHOUT changing where the link goes.
// We use `utm_content`, a standard analytics param that site routing/CMS universally IGNORE, so the
// link resolves to the exact same article. We must NOT reuse 's' or 'ref': '?s=' is WordPress's SEARCH
// query (recipe blogs are nearly all WordPress) — appending it turns the article URL into a search
// page, and the comment's link preview then shows a DIFFERENT article. We also never overwrite the
// user's own query params or fragment.
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
    // Keep any #fragment after the query untouched.
    const hashAt = clean.indexOf('#');
    const frag = hashAt >= 0 ? clean.slice(hashAt) : '';
    let u = hashAt >= 0 ? clean.slice(0, hashAt) : clean;
    // Replace only OUR own previous utm_content (idempotent across groups); never the user's params.
    if (/[?&]utm_content=[^&]*/.test(u)) u = u.replace(/([?&])utm_content=[^&]*/, `$1utm_content=${tag()}`);
    else u += (u.includes('?') ? '&' : '?') + `utm_content=${tag()}`;
    return `${u}${frag}${trail}`;
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

async function downloadImage(url, log) {
  // OBS-1: say WHY a download failed instead of returning a bare null that surfaces as a generic
  // "could not resolve image". Optional logger; SSRF rejection is marked non-retryable.
  const note = (m) => { try { if (typeof log === 'function') log(`⚠️ image download failed — ${m} (${String(url).slice(0, 90)})`); } catch {} };
  if (!url) return null;
  if (!axios) { note('axios unavailable'); return null; }
  if (!isSafeImageUrl(url)) { note('blocked by SSRF guard (internal/private/non-http URL) — not retried'); return null; } // SSRF guard
  const r = await retryAsync(() => axios.get(url, {
    responseType: 'arraybuffer', timeout: 30000,
    maxRedirects: 2,                       // allow a couple of legit CDN redirects…
    beforeRedirect: (opts) => {            // …but RE-RUN the SSRF guard on each hop: a 30x to an internal/private host
      const tgt = opts.href || `${opts.protocol || 'https:'}//${opts.hostname || opts.host || ''}${opts.path || ''}`; // would otherwise bypass the initial check above (the guard only saw the ORIGINAL url).
      if (!isSafeImageUrl(tgt)) throw new Error('SSRF guard: redirect to a blocked/internal host');
    },
    maxContentLength: 15 * 1024 * 1024,    // cap the download so a giant/streaming URL can't exhaust memory
    maxBodyLength: 15 * 1024 * 1024,
  }), { attempts: 3, timeoutMs: 35000, baseDelayMs: 1500, label: 'image download' });
  if (!r.ok) { const st = r.error && r.error.response && r.error.response.status; note(`request failed after retries${st ? ` (HTTP ${st})` : ''}: ${r.error && r.error.message}`); return null; }
  // Reject non-image responses (an HTML error page / unexpected content type isn't an image).
  const ct = String((r.result.headers && (r.result.headers['content-type'] || r.result.headers['Content-Type'])) || '').toLowerCase();
  const looksImg = /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(String(url));
  // Reject a present-but-non-image content-type, OR a MISSING content-type when the URL doesn't even look like
  // an image (likely an HTML error/redirect page) — but allow a header-less response from an image-URL (some
  // hosts omit Content-Type), letting FB's own byte-sniff validate it.
  if ((ct && !ct.startsWith('image/')) || (!ct && !looksImg)) { note(`response is not an image (content-type: ${ct || 'none'})`); return null; }
  try {
    const ext = (String(url).match(/\.(jpg|jpeg|png|gif|webp)/i) || [, 'jpg'])[1];
    // hrtime.bigint() is nanosecond + monotonic → two parallel accounts in the same millisecond get DISTINCT
    // names (Date.now()+random alone collided at high parallelism, silently overwriting/unlinking a file in use).
    const file = path.join(os.tmpdir(), `za-img-${Date.now()}-${process.hrtime.bigint()}-${Math.floor(Math.random() * 1e9)}.${ext}`);
    fs.writeFileSync(file, Buffer.from(r.result.data));
    return file;
  } catch (e) { note(`could not write temp file: ${e.message}`); return null; }
}

// Selector bank — the live composer/post/comment matching keys off TEXT (FB.* banks), not CSS;
// the only fixed selector still used is the image file input.
const SEL = {
  fileInput: 'input[type="file"][accept*="image"], input[type="file"]',
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
    // AR (Arabic) — FALLBACK for any account whose Facebook UI is Arabic (the app does NOT force a UI language; the
    // recommended setup is to set accounts to English, and this is the safety net for ones that aren't). HAMZA-FREE
    // substrings only: the in-page normalize does NFD which decomposes أ/إ/ؤ/ئ into base+U+0654 (NOT stripped), so a
    // phrase with those would never match — these use plain letters that normalize to themselves. These run only AFTER
    // a publish FAILURE (not the healthy path), so a rare false hit just cools the account down (conservative). Spot-check.
    'حظرك', 'محظور', 'لا يمكنك استخدام هذه الميزة', 'بشكل متكرر', 'بسرعة كبيرة',                 // AR
  ],
  // SEVERE subset of rateLimit — an ACCOUNT-LEVEL temporary block ("the big one"), distinct from a
  // per-action posting/comment rate-limit. Matching one of these → a much longer cooldown.
  blockSevere: [
    "you're temporarily blocked", 'temporarily blocked', 'temporarily restricted',
    "you can't use this feature right now", 'you cant use this feature right now', 'this feature for a while',
    'temporairement bloque', 'temporalmente bloqueado', 'bloqueado temporalmente',
    'estas bloqueado temporalmente', 'has estado bloqueado', 'voruebergehend gesperrt', 'vorubergehend gesperrt',
    'temporaneamente bloccato', 'bloccato temporaneamente', 'bloqueado temporariamente',
    'voce esta temporariamente bloqueado', 'atmenetileg letiltottuk',
    'حظرك', 'محظور', 'لا يمكنك استخدام هذه الميزة',                                             // AR (hamza-free; spot-check)
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
    'التحقق من هويتك', 'شخص حقيقي',                                                            // AR — FULL identity phrases ONLY (hamza-free). A bare 'التحقق من' would false-match benign Arabic UI ('صفحة تم التحقق منها' verified-page badge, verify-email nudges) since checkVerification scans the WHOLE page on the healthy path. URL + captcha structural cues remain the primary, locale-independent check.
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
    'بانتظار الموافقة', 'قيد المراجعة', 'موافقة المشرف',                                        // AR (hamza-free; multi-word to avoid false matches)
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
    'نشر', 'مشاركة', 'شارك', 'نشر في المجموعة',        // AR (EXACT label; 'نشر' = Post, 'مشاركة' = Share — hamza-free)
  ],
  // Comment-box aria hints across locales.
  commentBox: ['comment', 'commentaire', 'comentario', 'comentar', 'kommentar', 'commento', 'hozzaszolas', 'تعليق', 'علق'],
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
  // Chrome's --proxy-server treats `https://` as a proxy reached over TLS — almost no residential/ISP provider
  // (iProyal included) works that way; they are plain HTTP proxies. A user who writes https:// nearly always means
  // an HTTP proxy, so normalise it silently — otherwise Chrome opens a TLS handshake the proxy never answers.
  if (scheme === 'https') scheme = 'http';
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
  if (/^transient:/.test(m)) return 'transient'; // caller-tagged transient (e.g. a recoverable image-upload failure)
  if (/rate.?limit|temporarily blocked|action blocked|checkpoint|verification|too fast|too often/.test(m)) return 'block';
  if (/target closed|session closed|protocol error|detached|timeout|timed out|econnreset|socket hang up|net::err|navigation failed|cdp|page crashed|execution context was destroyed|requesting main frame too early/.test(m)) return 'transient'; // a pre-publish renderer crash / context-destroy is recoverable by the next gotoGroup reload — take the safe single retry, don't discard the group
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

// Classify WHY a proxy connection failed from a Chromium/Node error string (or the chrome-error page URL),
// so the per-account log tells the operator the ACTUAL cause instead of a generic "couldn't load". This is the
// key to diagnosing "works on my laptop, not the client's": AUTH = wrong creds OR an IP-whitelist locked to the
// first machine; CONN = the proxy host/port is down/blocked; SOCKS = scheme mismatch; DNS = bad host. Pure.
function classifyProxyError(errMsg) {
  const m = String(errMsg || '').toLowerCase();
  if (/407|proxy authentication|unauthorized|auth.?required/.test(m)) return 'AUTH_407';
  if (/err_socks|socks.*(unsupported|fail|version)|wrong.?version/.test(m)) return 'SOCKS_MISMATCH';
  if (/getaddrinfo|err_name_not_resolved|err_proxy_certificate|dns|enotfound/.test(m)) return 'DNS_FAIL';
  if (/econnrefused|connection refused|err_proxy_connection_failed|err_tunnel_connection_failed|err_empty_response|err_connection|timed?.?out|etimedout/.test(m)) return 'CONN_REFUSED';
  return 'UNKNOWN';
}
// Operator-facing one-liner for each classified proxy failure (what to actually DO about it). Pure.
function proxyErrorHint(reason) {
  switch (reason) {
    case 'AUTH_407': return 'proxy rejected the login (407). Check the username/password — or, most likely on a 2nd machine, your iProyal IP-whitelist is locked to the first laptop. Remove the whitelist (use username/password auth) or add this machine\'s IP in the iProyal dashboard';
    case 'CONN_REFUSED': return 'could not reach the proxy (down, wrong port, or blocked by this network). Try a different proxy or check the host:port';
    case 'SOCKS_MISMATCH': return 'scheme mismatch — iProyal ISP proxies are HTTP. Use http://… not socks5://…';
    case 'DNS_FAIL': return 'the proxy host did not resolve — check the host in the proxy string';
    default: return 'proxy connection failed';
  }
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
          if (r0.width && r0.height) { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) }; }
        }
      }
      return null;
    }, sels).catch(() => null);
    if (pt) { await moveMouseTo(page, pt.x, pt.y); await page.mouse.click(pt.x, pt.y, { delay: 30 + Math.floor(Math.random() * 70) }).catch(() => {}); return true; }
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
      // FRENCH — both accented (this fn doesn't strip accents) and de-accented forms
      'écrivez quelque chose', 'ecrivez quelque chose',
      'créer une publication', 'creer une publication',
      'écrire une publication', 'ecrire une publication',
      'quoi de neuf', 'exprimez-vous', 'publiez quelque chose',
    ];
    const els = Array.from(document.querySelectorAll('div[role="button"], span, div'));
    const el = els.find((e) => wanted.some((w) => (e.textContent || '').toLowerCase().includes(w)));
    if (el) { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) }; }
    return null;
  }).catch(() => null);
  if (pt) { await moveMouseTo(page, pt.x, pt.y); await page.mouse.click(pt.x, pt.y, { delay: 30 + Math.floor(Math.random() * 70) }).catch(() => {}); return true; }
  return false;
}

// Robust composer opener: the FB group "Write something…" trigger has NO aria-label
// (the text lives in a placeholder span), so target the SHORT-text placeholder, walk
// up to its clickable [role=button], real-mouse-click it, and WAIT for the composer
// dialog's editable to actually appear. Retries — returns true only when it opened.
async function openComposer(page, log, name, settings = {}) {
  // R1: a focused search/"type ahead" box (the "Exit typeahead" seen in failures) steals keyboard
  // focus and obscures the composer trigger — blur it + Escape. R2: scroll to top, clear popups, and
  // WAIT for the feed to actually render (an article or the "Write something" placeholder) ONCE before
  // the attempt loop — scanning a half-rendered page was the cause of the "Could not open composer"
  // skips. All pre-publish + read-only (no double-post path).
  try {
    const hadSearch = await page.evaluate(() => {
      const el = document.activeElement; if (!el) return false;
      const tag = (el.tagName || '').toLowerCase();
      const lbl = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || el.getAttribute('placeholder'))) || '').toLowerCase();
      if ((tag === 'input' || tag === 'textarea' || el.getAttribute('contenteditable') === 'true') && /search|type ?ahead|rechercher|buscar|suchen|keres/.test(lbl)) { try { el.blur(); } catch {} return true; }
      return false;
    }).catch(() => false);
    if (hadSearch) { if (log) log('Composer: blurred a focused search/type-ahead box first'); await page.keyboard.press('Escape').catch(() => {}); await sleep(humanDelay(500, settings, 'pause')); }
  } catch {}
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await dismissPopups(page);
  await page.waitForFunction(() => {
    if (document.querySelectorAll('[aria-posinset], div[role="article"]').length > 0) return true;
    return Array.from(document.querySelectorAll('[role="button"], span, div')).some((e) => /write something|what'?s on your mind|irj valamit|mi jar a fejedben|quoi de neuf|écrivez quelque chose|ecrivez quelque chose|créer une publication|creer une publication|que estas pensando|was machst du/i.test(e.textContent || ''));
  }, { timeout: 20000 }).catch(() => {}); // R2: feed-render gate (slow internet)

  for (let attempt = 1; attempt <= 4; attempt++) {
    if (log) log(`Opening composer (attempt ${attempt}/4)`);
    // The composer lives at the TOP of the feed — make sure we're there and nothing covers it.
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(attempt === 1 ? humanDelay(Number.isFinite(settings.composerOpenInitialDelayMs) ? settings.composerOpenInitialDelayMs : 1500, settings, 'settle') : humanDelay(1500, settings, 'settle'));
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
        // FRENCH (accent-stripped — matches the de-accented scan): the FR group composer entry points
        'ecrivez quelque chose',     // "Écrivez quelque chose..."
        'creer une publication',     // "Créer une publication"
        'ecrire une publication',    // "Écrire une publication"
        'quoi de neuf',              // "Quoi de neuf ?"
        'publiez quelque chose',
        'exprimez-vous',
      ];
      const reject = ['search', 'comment', 'message', 'photo/video', 'live video', 'reels', 'rechercher', 'commenter', 'photo/video'];
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
      return { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) };
    }).catch(() => null);
    if (pt) { await moveMouseTo(page, pt.x, pt.y); await page.mouse.click(pt.x, pt.y, { delay: rand(35, 75) }).catch(() => {}); }
    else await openComposerByText(page).catch(() => false);
    const ok = await page.waitForSelector('div[role="dialog"] [contenteditable="true"], div[role="dialog"] [role="textbox"]', { timeout: attempt === 1 ? 6000 : 9000 }).then(() => true).catch(() => false); // R4: more patience on slow-net retries
    if (ok) { if (attempt > 1 && log) log(`Composer opened (attempt ${attempt})`); return true; }
    if (log) {
      // R3: a read-only readiness probe so a not-yet-rendered feed isn't misdiagnosed as selector drift.
      const hint = await page.evaluate(() => {
        const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const body = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
        const buttons = Array.from(document.querySelectorAll('[role="button"], button, a')).slice(0, 12)
          .map((b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 8);
        const articles = document.querySelectorAll('[aria-posinset], div[role="article"]').length;
        const ae = document.activeElement;
        const focused = ae ? `${(ae.tagName || '').toLowerCase()}${ae.getAttribute && ae.getAttribute('aria-label') ? '[' + ae.getAttribute('aria-label').slice(0, 30) + ']' : ''}` : '(none)';
        const composerHits = Array.from(document.querySelectorAll('[role="button"], span, div')).filter((e) => /write something|what.s on your mind|irj valamit|mi jar a fejedben|quoi de neuf|que estas pensando|was machst du/i.test(norm(e.textContent || ''))).length;
        return { buttons, body: body.slice(0, 180), articles, focused, composerHits };
      }).catch(() => null);
      if (hint) log(`Composer not open yet (feed readiness: ${hint.articles} articles, focused=${hint.focused}, ${hint.composerHits} composer-text matches); visible buttons: ${hint.buttons.join(' | ') || '(none)'}`);
    }
    await sleep(humanDelay(1500, settings, 'settle'));
  }
  // Distinguish "page never rendered" from genuine selector drift using the last readiness read.
  const ready = await page.evaluate(() => document.querySelectorAll('[aria-posinset], div[role="article"]').length).catch(() => 0);
  if (log) {
    if (!ready) log('⚠️ Composer never opened after 4 attempts and the group FEED never rendered — likely a slow/blocked network or this account can\'t view this group. Not selector drift.');
    else log('⚠️ SELECTOR DRIFT? The feed rendered but the "Write something" trigger was not found after 4 attempts — Facebook may have changed it or the page is in an unexpected locale/state. Run scripts/inspect-fb.js to capture the current DOM.');
  }
  return false;
}

// Capture OUR just-published post's id/permalink from Facebook's OWN create-story GraphQL response — far
// faster + more reliable than reloading the feed and scraping the (now usually id-less) [aria-posinset] DOM
// with a hover-for-href dance. ARM this right before clicking Post; read .get() after the publish confirms;
// always .dispose(). WRONG-POST-SAFE: the captured id is only a CANDIDATE — the comment step re-verifies the
// post's caption+author on its own page before commenting (forceContentVerify), so a mis-parse self-heals to
// the feed-scan fallback and can NEVER comment on the wrong post. Best-effort: if FB renames the mutation or
// changes the response shape and nothing matches, .get() stays null → the feed-scan runs (no regression).
function armPostIdCapture(page, gid) {
  let hit = null; // { postId, url }
  const gidStr = String(gid || '');
  const onResp = async (resp) => {
    try {
      if (hit) return;
      let req, u;
      try { req = resp.request(); u = resp.url(); } catch { return; }
      if (!/\/api\/graphql\/?/.test(u || '')) return;            // FB mutations POST to /api/graphql/
      let pd = ''; try { pd = req.postData() || ''; } catch {}
      // Only OUR create-post mutation's response (not a background feed/typeahead graphql call) so the parsed
      // id is definitively ours. Match a broad set of known create-story friendly names; a miss just means
      // no capture (feed-scan fallback), never a wrong capture.
      const friendly = decodeURIComponent((pd.match(/fb_api_req_friendly_name=([^&]+)/) || [])[1] || '');
      if (!/StoryCreate|CreateMutation|Composer.*Create|CreatePost|GroupsCometFeedStoryCreate|useComet.*Create|ComposerStore/i.test(friendly)) return;
      let body = ''; try { body = await resp.text(); } catch { return; }
      if (!body || body.length > 3000000) return;
      const clean = body.replace(/\\\//g, '/');                  // FB escapes URL slashes as \/ in JSON
      // Prefer a post URL under OUR group ONLY (exact gid — NOT a wildcard \d+ that could match a foreign/suggested
      // group's permalink embedded ahead of ours in the response); else a clearly-labelled post-id field in the
      // created story. Either way the id is only a CANDIDATE — the comment step re-verifies caption+author on the
      // post's own page (forceContentVerify) before commenting, so even a mis-grab self-heals to the feed-scan.
      let m = clean.match(new RegExp('/groups/' + gidStr + '/(?:posts|permalink)/(\\d{6,})'));
      if (!m) m = clean.match(/"(?:post_id|top_level_post_id|story_fbid)"\s*:\s*"?(\d{8,})/);
      if (m && m[1]) hit = { postId: m[1], url: 'https://www.facebook.com/groups/' + gidStr + '/posts/' + m[1] + '/' };
    } catch { /* never let a response probe throw into the publish path */ }
  };
  page.on('response', onResp);
  return { get: () => hit, dispose: () => { try { page.off('response', onResp); } catch {} } };
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
      if (btn) { btn.scrollIntoView({ block: 'center' }); const r = btn.getBoundingClientRect(); if (r.width && r.height) return { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) }; }
    }
    return null;
  }, FB.postButton).catch(() => null);
  // Move the cursor to the button along a path (and a brief hover) before clicking, like a human —
  // a click with no preceding mousemove is a bot tell FB's integrity JS looks for.
  if (pt) { await moveMouseTo(page, pt.x, pt.y); await page.mouse.click(pt.x, pt.y, { delay: 30 + Math.floor(Math.random() * 70) }).catch(() => {}); return true; }
  return false;
}

// Confirm the post actually published: the composer dialog closes OR the enabled
// "Post" button disappears. Returns 'published' or 'timeout'.
async function waitForPublish(page, dialogCountBefore, timeout = 45000, shouldStop = () => false, fast = false) {
  await sleep(jitter(fast ? 200 : 1500, 0.3)); // let the click take effect before the first check — jittered; fast/instant polls sooner (the dialog-count-drop check below is authoritative + idempotent, so a too-early first poll just harmlessly loops — no false positive)
  const deadline = Date.now() + timeout;
  let timeouts = 0;
  while (Date.now() < deadline) {
    if (shouldStop()) return 'stopped'; // halt promptly on Stop instead of polling for 30s
    // Count ONLY composer dialogs (a contenteditable / file-input / textbox inside). A Messenger/notification
    // popup opening as the composer closes would keep the RAW dialog count flat and mask the close → false timeout.
    const dialogCount = await evalTimed(page, () => Array.from(document.querySelectorAll('div[role="dialog"]')).filter((d) => d.querySelector('[contenteditable="true"], input[type="file"], [role="textbox"]')).length, null, 8000).catch(() => -1);
    if (dialogCount >= 0 && dialogCountBefore > 0 && dialogCount < dialogCountBefore) return 'published';
    const sig = await evalTimed(page, () => {
      // Scope success/error/pending detection to NOTICE surfaces (alert/status/dialog), NEVER feed articles:
      // a moderated group's feed is full of old "pending"/"posted to the group" text that would otherwise
      // FALSE-POSITIVE 'submitted' on the very first poll (before our post even transmitted) → a lost post.
      const nt = Array.from(document.querySelectorAll('[role="alert"], [role="status"], div[role="dialog"]'))
        .filter((n) => !n.closest('[role="article"]')).map((n) => n.innerText || '').join(' \n ').toLowerCase();
      if (/pending|in review|will be reviewed|shared once approved|post is pending|posted to the group|en attente|en cours d.examen|sera examine|publié dans le groupe|publie dans le groupe|partagé dans le groupe|partage dans le groupe|votre publication a été|votre publication a ete/.test(nt)) return 'submitted';
      // Explicit Facebook failure — never count it as published (so the post is retried, not lost).
      if (/couldn.t post|can.t share|something went wrong|unable to post|failed to post|couldn.t share|impossible de publier|impossible de partager|une erreur s.est produite|un problème est survenu|un probleme est survenu/.test(nt)) return 'error';
      // While the composer DIALOG is still open, a DISABLED Post button = still SUBMITTING (loading spinner),
      // NOT published — keep polling. The dialog CLOSING (the count drop checked above) is the authoritative
      // 'published' signal. Only treat a vanished button as 'gone' when there's NO dialog (inline composer).
      if (document.querySelector('div[role="dialog"] [contenteditable="true"], div[role="dialog"] input[type="file"], div[role="dialog"] [role="textbox"]')) return 'open';
      const hasEnabledPost = Array.from(document.querySelectorAll('[role="button"]'))
        .some((b) => { const t = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase(); return (t === 'post' || t === 'publier') && b.getAttribute('aria-disabled') !== 'true'; });
      return hasEnabledPost ? 'open' : 'gone';
    }, null, 8000).catch(() => 'timeout');
    // POST-1: each probe is capped at 8s (a hung CDP would otherwise block up to protocolTimeout ~90s
    // and blow the group budget). 3 consecutive dead probes (both evaluates failed) → bail as 'timeout'.
    if (sig === 'timeout' && dialogCount === -1) { if (++timeouts >= 3) return 'timeout'; }
    else timeouts = 0;
    if (sig === 'error') return 'error';
    if (sig === 'gone' || sig === 'submitted') return 'published';
    await sleep(fast ? 500 : 2000); // poll cadence — fast/instant detects the composer-close (the authoritative publish confirm) sooner; the timeout CEILING is unchanged (never shorten it → false 'timeout' → re-post → duplicate)
  }
  return 'timeout';
}

// POST-SPECIFIC pending signal: a genuinely moderated group shows a "will be reviewed / pending
// approval" notice for OUR just-submitted post in a TOAST / ALERT / open DIALOG — NEVER inside a feed
// article. We scan ONLY those notice surfaces (excluding [role="article"]) so this can't false-match
// the OLD pending posts already sitting in the group's feed (the cause of the false "PENDING" verdict).
// Must be called on the post-click page, right after publish, before navigating away.
async function pendingNoticeForOurPost(page) {
  try {
    return await page.evaluate((pats) => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const nodes = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"]'));
      for (const n of nodes) {
        if (n.closest('[role="article"]')) continue; // never trust feed-post text
        const t = norm(n.innerText || '');
        if (t && pats.some((p) => t.includes(p))) return true;
      }
      return false;
    }, FB.pending);
  } catch { return false; }
}

// Human-like typing: type in chunks with a per-char delay and small randomized pauses
// between chunks. Tuned for speed while staying human-plausible (FB doesn't scrutinize
// keystroke timing in the composer the way it does navigation/IP/account signals).
async function humanType(page, text, settings = {}) {
  if (!text) return;
  // FAST mode: when humanization is off (humanizeMaster===false) OR the operator set a very fast cadence
  // (speedMode==='fast'), type near-instantly with no inter-chunk pause — so a deliberately-fast setting
  // applies on the typed-caption fallback too (not just the paste path). Otherwise model a real typist.
  const fast = isFastMode(settings);
  const _b = settings._behavior || {};
  const _typeMult = Number.isFinite(_b.typeMult) ? _b.typeMult : 1;     // per-account typing speed (slow ↔ fast typist)
  const _fumble = Number.isFinite(_b.fumbleRate) ? _b.fumbleRate : 0.1; // per-account typo-proneness
  // Chunk by CODE POINT, never by UTF-16 code unit. A /.{1,12}/ code-unit split can land INSIDE an emoji surrogate
  // pair (or split a base char from its combining mark), sending a LONE surrogate to page.keyboard.type — which CDP
  // Input.insertText serializes as U+FFFD (�). Result: a GARBLED published Arabic/emoji caption AND a capSnip that no
  // longer matches, so the two-phase permalink capture + the comment feed-scan can't find the post → the comment is
  // lost too. Array.from() iterates by code point, keeping every surrogate pair whole, so a boundary is never inside one.
  const _cps = Array.from(String(text));
  const chunks = [];
  for (let i = 0; i < _cps.length; i += 12) chunks.push(_cps.slice(i, i + 12).join(''));
  for (const c of chunks) {
    // Re-sample per-key delay EACH chunk so one entry isn't a single constant cadence (a human's inter-key
    // interval varies keystroke-to-keystroke). ~25-115ms/key when humanizing; 0 = machine-fast (fast/turbo).
    const perKey = fast ? 0 : Math.round((25 + Math.floor(Math.random() * 90)) * _typeMult);
    // ~10% of chunks: fumble a stray letter then correct it (Backspace) before typing the real chunk — a
    // strong human tell. Only when NOT fast; exactly 1 stray + 1 Backspace so the final text is unchanged
    // (a mismatch would trigger a needless caption clear+retype). Never on the paste path (this is the
    // typed fallback only).
    if (!fast && Math.random() < _fumble) {
      try {
        const stray = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
        await page.keyboard.type(stray, { delay: perKey });
        await sleep(120 + Math.floor(Math.random() * 240));
        await page.keyboard.press('Backspace');
        await sleep(80 + Math.floor(Math.random() * 160));
      } catch {}
    }
    // Cap each chunk at 15s so a hung CDP connection can't block for the full protocolTimeout (90s) per
    // chunk; the group-level catch then skips this group instead of freezing the queue. Timer always cleared.
    let timer;
    const cap = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('keyboard.type timeout')), 15000); });
    try { await Promise.race([page.keyboard.type(c, { delay: perKey }), cap]); }
    finally { clearTimeout(timer); }
    if (!fast) await sleep(60 + Math.floor(Math.random() * 160) + (Math.random() < 0.1 ? 300 + Math.floor(Math.random() * 700) : 0)); // inter-chunk "thinking" beat
  }
}

// Dismiss the modals Facebook throws up (cookie banner, "Turn on notifications",
// "Your post might be reviewed", generic dialogs). Best-effort, never throws.
async function dismissPopups(page) {
  let _clicked = false;
  try {
    _clicked = await page.evaluate(() => {
      const wants = ['allow all cookies', 'decline optional cookies', 'only allow essential', 'not now', 'ok', 'close', 'cancel', 'maybe later', 'got it',
        // FRENCH popup/cookie/dialog buttons
        'tout accepter', 'autoriser tous les cookies', 'refuser les cookies optionnels', 'uniquement les cookies essentiels', 'autoriser les cookies essentiels',
        'pas maintenant', "d'accord", 'fermer', 'annuler', 'plus tard', 'compris', 'continuer', 'accepter'];
      const clickable = Array.from(document.querySelectorAll('[role="button"], button, [aria-label]'));
      let hit = false;
      for (const el of clickable) {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        if (label === 'close' || wants.includes(label)) {
          const r = el.getBoundingClientRect();
          if (r.width && r.height) { el.click(); hit = true; }
        }
      }
      return hit;
    });
  } catch {}
  if (_clicked) await sleep(jitter(300, 0.4)); // settle ONLY when something was actually clicked (let the click register) — the common NO-popup path pays nothing (was a flat 500ms every call)
}

// Classify a rate-limit / block wall by SEVERITY so the caller picks a proportionate cooldown:
//   'severe' = an ACCOUNT-LEVEL temporary block ("the big one"); 'limit' = a per-action rate-limit
//   (posting/commenting too often); null = no wall. The caller adds the action (post vs comment) from
//   WHERE it was detected, yielding the three tiers: account-block / posting-limit / comment-limit.
async function classifyRateLimit(page) {
  try {
    return await page.evaluate((arg) => {
      const t = (document.body.innerText || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (arg.severe.some((p) => t.includes(p))) return 'severe';
      if (arg.all.some((p) => t.includes(p))) return 'limit';
      return null;
    }, { severe: FB.blockSevere, all: FB.rateLimit });
  } catch { return null; }
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
async function addFirstComment(page, gid, post, commentImg, step, permalink, settings = {}, expectedPostId = null, expectedAuthor = '', preNavigated = false, forceContentVerify = false) {
  // WRONG-POST GUARD inputs: a real FB post id is a long digit string; reject a LOCAL library id (e.g.
  // "post-1718…") passed as expectedPostId so it can't poison the id check (and silently degrade to
  // caption-only). expectedAuthor = the poster's FB display name → used to confirm a same-caption article
  // is actually OURS (or the right account's), so a comment never lands on another account's/stranger's
  // identical-caption post when no FB post id is available.
  const fbId = /^\d{8,}$/.test(String(expectedPostId || '')) ? String(expectedPostId) : null;
  const expAuthor = String(expectedAuthor || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  expectedPostId = fbId; // from here on, only a verified FB id counts as a post-id anchor
  let submitted = false; // once the submitting Enter is pressed, NEVER return false — the caller
                         // retries on false and would post a DUPLICATE comment.
  // RES-1: never start/continue the comment flow on a dead browser — it would just burn a retry.
  // Pre-submit → 'failed' (safely retryable on a live browser); post-submit → 'unconfirmed' (never
  // re-typed → no double-comment). Cheap liveness check reused at each navigation below.
  const connected = () => { try { return page.browser().isConnected(); } catch { return false; } };
  try {
    if (!connected()) { step('Comment: browser is disconnected — not commenting'); return submitted ? 'unconfirmed' : 'failed'; }
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
          const arts = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]'));
          return arts.length > 0 && arts.some((a) => a.querySelector('[contenteditable="true"], [role="textbox"]'));
        }, null, 4000).catch(() => false);
        if (ready) return true;
        await sleep(1000);
      }
      return false;
    };
    // Return the "Leave a comment" button's coordinates from the page, then click it with a REAL mouse
    // (move + click) from Node — a synthetic in-page el.click() is isTrusted=false, which FB can distinguish.
    const clickLeaveComment = async () => {
      const rect = await evalTimed(page, () => {
        const b = Array.from(document.querySelectorAll('[role="button"]')).find((e) => {
          const norm = (e.getAttribute('aria-label') || e.textContent || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
          return /leave a comment|^comment$|hozzaszolas|commenter|comentar|kommentar|commenta/.test(norm);
        });
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) };
      }, null, 12000).catch(() => null);
      if (!rect) return false;
      try { await moveMouseTo(page, rect.x, rect.y); await page.mouse.click(rect.x, rect.y, { delay: 30 + Math.floor(Math.random() * 70) }); return true; }
      catch { return false; }
    };

    const snip = (post.caption || '').replace(/\s+/g, ' ').trim();
    // C6: can't prove which post is ours (no link + nothing to match on) → SKIP, never guess.
    if (snip.length < 12 && !permalink && !expectedPostId) { step('Comment: caption too short, no post link, no post-id — skipping to avoid a wrong-post comment'); return 'skipped'; }

    let boxes = [];
    let permalinkFailed = false;
    let postMissing = false; // set when our published post is NOT in the public feed → likely HELD in Spam potentiel

    // PRIMARY: comment on the post's OWN page (it's the only article there → unambiguous = right post).
    if (permalink) {
      let navOk;
      if (preNavigated) {
        // TWO-PHASE Phase 2: this tab was already PRE-LOADED on the post's permalink (pipelined while the previous
        // comment was placed), so skip the goto. Everything after — the OUR-post id/caption/author verification and the
        // comment-box find/type/submit — runs UNCHANGED, so the wrong-post + double-comment guards are fully preserved.
        navOk = true;
        step('Comment: post already pre-loaded (pipelined) — verifying + commenting on it directly');
      } else {
        step(`Comment: opening the post directly via its link (primary — id=${expectedPostId || '?'} — guarantees the right post)`);
        navOk = await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => true).catch(() => false);
        if (!navOk) { // one retry — this goto is READ-ONLY (no comment posted yet), so a transient nav blip must not force the weaker feed-scan fallback (which can mis-report a live post as nomatch)
          await sleep(2000 + Math.floor(Math.random() * 1500));
          navOk = await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => true).catch(() => false);
        }
      }
      if (!navOk) { permalinkFailed = true; step('Comment: could not open the post link — falling back to the group feed'); }
      else {
        await page.waitForSelector('[aria-posinset], div[role="article"], [aria-label*="omment"], [role="textbox"]', { timeout: 25000 }).catch(() => {});
        const ready = await waitInteractive(4000); // permalink branch: the waitForSelector above (incl. [role=textbox]) + the commentBoxes/clickLeaveComment retry below are the REAL box gate, so this early-returns fast on a normal post page — a 4s budget is enough (the 10s stays on the busy-feed fallback where it's needed)
        step(ready ? 'Comment: post page ready' : 'Comment: post page not fully interactive (timeout) — trying anyway');
        await dismissPopups(page);
        const authBad = await withTimeout(page.evaluate(() => /continue as|use another profile|log in to facebook/i.test(document.body.innerText || '')), 8000, false);
        if (authBad) { step('Comment: session expired after posting — skipped (re-login needed)'); return 'failed'; }
        // CT-3 identity guard: confirm the page actually resolved to OUR post before commenting here
        // (a captured link can be stale or redirect). Mismatch → demote to the id-checked feed fallback,
        // never a blind comment on the wrong post.
        const urlId = (page.url().match(/\/(?:posts|permalink)\/(\d+)/) || [])[1] || null;
        if (expectedPostId && urlId && urlId !== expectedPostId) {
          permalinkFailed = true; step('Comment: post link did not resolve to OUR post (id mismatch) — falling back to the group feed');
        } else if (forceContentVerify && expectedPostId) {
          // NETWORK-CAPTURED id — provenance is Facebook's publish response, NOT a caption-verified feed article. So
          // NOTHING about the id proves the page is OURS: a mis-parsed/foreign id builds a self-consistent link
          // (urlId===expectedPostId but it's a STRANGER's post), AND a bad id can REDIRECT the page to the group root
          // (nulling urlId). Therefore the ONLY thing that authorizes commenting here is a POSITIVE caption OR author
          // match on the post's own page — checked for BOTH urlId===expectedPostId and urlId===null (closing the
          // redirect gap the id-only branch below would otherwise leave open). Anything less demotes to the
          // article-scoped, caption-matched feed-scan fallback → a network mis-grab can NEVER blind-comment.
          const chk = await evalTimed(page, (arg) => {
            const { s, author } = arg;
            const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const a = document.querySelector('[aria-posinset], div[role="article"]');
            if (!a) return { found: false };
            const capOk = (s && s.length >= 12) ? norm(a.textContent).includes(norm(s)) : null;
            const c = a.querySelector('h2 a, h3 a, h4 a, strong a, a strong, a[aria-label][href*="/user/"], a[aria-label][role="link"]');
            const auth = norm(c ? (c.getAttribute('aria-label') || c.textContent) : '').slice(0, 60);
            return { found: true, capOk, auth };
          }, { s: snip.slice(0, 40), author: expAuthor }, 5000).catch(() => ({ found: false }));
          const positiveCaption = chk.capOk === true;
          const positiveAuthor = !!(expAuthor && chk.auth && chk.auth === expAuthor);
          const authMismatch = !!(expAuthor && chk.auth && chk.auth !== expAuthor);
          if (!chk.found || authMismatch || !(positiveCaption || positiveAuthor)) {
            permalinkFailed = true;
            step(`Comment: the captured link did not positively confirm OUR post (${!chk.found ? 'unreadable' : authMismatch ? 'author mismatch' : 'no caption/author match'}) — falling back to the group feed`);
          }
        } else if (expectedPostId && !urlId) {
          const domId = await evalTimed(page, () => { const a = document.querySelector('[aria-posinset], div[role="article"]'); const l = a && a.querySelector('a[href*="/posts/"], a[href*="/permalink/"]'); const m = l && (l.href || '').match(/\/(?:posts|permalink)\/(\d+)/); return m ? m[1] : null; }, null, 5000).catch(() => null);
          if (domId && domId !== expectedPostId) { permalinkFailed = true; step('Comment: post link did not resolve to OUR post (id mismatch) — falling back to the group feed'); }
        } else if (!expectedPostId) {
          // No FB post-id to verify against → confirm by caption AND author on the post's own page. The
          // loose 20-char prefix is dropped (it passed for DIFFERENT posts), and an inconclusive read
          // (timeout / no article) now DEMOTES to the author+ambiguity-checked feed fallback instead of
          // commenting blind (capOk no longer defaults to true). Author mismatch = a same-caption stranger.
          const chk = await evalTimed(page, (arg) => {
            const { s, author } = arg;
            const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const a = document.querySelector('[aria-posinset], div[role="article"]');
            if (!a) return { found: false };
            const sn = norm(s);
            const capOk = (s && s.length >= 12) ? norm(a.textContent).includes(sn) : null; // null = nothing to check
            const c = a.querySelector('h2 a, h3 a, h4 a, strong a, a strong, a[aria-label][href*="/user/"], a[aria-label][role="link"]');
            const auth = norm(c ? (c.getAttribute('aria-label') || c.textContent) : '').slice(0, 60);
            return { found: true, capOk, auth };
          }, { s: snip.slice(0, 40), author: expAuthor }, 5000).catch(() => ({ found: false }));
          const authMismatch = !!(expAuthor && chk.auth && chk.auth !== expAuthor);
          if (!chk.found || authMismatch || chk.capOk === false) {
            permalinkFailed = true;
            step(`Comment: post page does not confirm OUR post (${!chk.found ? 'unreadable' : authMismatch ? 'author mismatch' : 'caption mismatch'}) — falling back to the group feed`);
          }
        }
        if (!permalinkFailed) {
          boxes = await withTimeout(commentBoxes(), 15000, []);
          if (!boxes.length) {
            step('Comment: no inline box on the post page — clicking "Leave a comment"');
            if (await clickLeaveComment()) { step('Comment: comment box opened (post page)'); await sleep(jitter(2300, 0.3)); boxes = await withTimeout(commentBoxes(), 15000, []); }
          }
        }
      }
    }

    // FALLBACK: feed-scan. Runs whenever the permalink path didn't yield a comment box — INCLUDING the
    // case where the post's OWN page loaded but exposed no inline box (observed live on some groups),
    // not only when navigation failed. Wrong-post-safe: it comments ONLY after a caption match in the
    // TOP-3 most-recent posts, and skips entirely if it can't confidently match (never guesses).
    if (!boxes.length) {
      step(permalink && !permalinkFailed
        ? 'Comment: post page had no usable comment box — falling back to the group feed (top-3 + caption match)'
        : 'Comment: locating the post in the group feed (fallback)');
      await page.goto(`https://www.facebook.com/groups/${gid}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await page.waitForSelector('[aria-posinset], div[role="article"], [aria-label*="omment"], [aria-label*="ommentaire"], [role="textbox"]', { timeout: 25000 }).catch(() => {});
      await waitInteractive(10000);
      await dismissPopups(page);
      const authBad = await withTimeout(page.evaluate(() => /continue as|use another profile/i.test(document.body.innerText || '')), 8000, false);
      if (authBad) { step('Comment: session expired after posting — skipped (re-login needed)'); return 'failed'; }
      { // VER-3 (hardened): on the FEED, NEVER use a bare comment box — boxes[0] could be a DIFFERENT,
        // topmost post. ALWAYS identify OUR post (id/caption-checked) and use the box inside ITS article.
        step('Comment: locating OUR post in the feed (top-8, caption + post-id check)');
        // Find OUR post and open its comment box. Window widened to TOP-8 because other users posting
        // during the 60-180s wait can push ours down — but kept safe: FIRST (topmost = newest) caption
        // match wins (never an older duplicate), and when expectedPostId is known a same-caption article
        // whose id differs is REFUSED. A 40-char normalized snippet keeps the wider window strict.
        const _scanFeedRaw = () => evalTimed(page, (arg) => {
          const { s, want, author, idTrusted } = arg;
          const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          const sn = (s && s.length >= 12) ? norm(s) : null;
          if (!sn && !want) return { clicked: false, reason: 'short' }; // nothing to match on
          const idOf = (a) => { const l = a.querySelector('a[href*="/posts/"], a[href*="/permalink/"]'); const m = l && (l.href || '').match(/\/(?:posts|permalink)\/(\d+)/); return m ? m[1] : null; };
          // The post's AUTHOR (actor) from the article header — the disambiguator when no FB post-id renders.
          const authorOf = (a) => { const c = a.querySelector('h2 a, h3 a, h4 a, strong a, a strong, a[aria-label][href*="/user/"], a[aria-label][role="link"]'); return norm(c ? (c.getAttribute('aria-label') || c.textContent) : '').slice(0, 60); };
          try { document.querySelectorAll('[data-zp-ctarget]').forEach((e) => e.removeAttribute('data-zp-ctarget')); } catch {}
          const arts = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]')).slice(0, 15)
            .filter((a) => !/pinned|épingl|rögzít/.test((a.innerText || '').slice(0, 200).toLowerCase()));
          // Collect ALL candidate articles (full-caption contain — the loose 20-char prefix is dropped, it
          // matched different posts), so we can disambiguate by author/id instead of blindly taking topmost.
          const cands = [];
          for (let i = 0; i < arts.length; i++) {
            const a = arts[i]; const id = idOf(a);
            const capHit = sn ? norm(a.textContent).includes(sn) : false;
            const idHit = !!(want && id && id === want);
            if (capHit || idHit) cands.push({ a, i, id, capHit, idHit, auth: authorOf(a) });
          }
          if (!cands.length) return { clicked: false, reason: 'nomatch' };
          // Pick OUR post safely WITHOUT over-blocking the normal case:
          //  (1) an exact FB post-id match is definitive — but ONLY when the id is TRUSTED (a caption+author-verified
          //      feed capture). A NETWORK-captured id (idTrusted=false) is unverified, so an id-match alone must NOT
          //      authorize the pick (a foreign post's id embedded in our create-story response could match a real
          //      article in our group); require caption corroboration (idHit && capHit) so a stranger's post is never
          //      chosen. Short-caption network posts thus fall through to a safe nomatch → moderator, never a wrong-post.
          //  (2) else a SINGLE caption match is unambiguous → it's ours (don't let a flaky author read block it);
          //  (3) else MULTIPLE same-caption posts → the article authored by US (author disambiguates the bug case);
          //  (4) else REFUSE (idmismatch / ambiguous) — never guess between indistinguishable same-caption posts.
          let pick = idTrusted ? cands.find((m) => m.idHit) : cands.find((m) => m.idHit && m.capHit);
          if (!pick) {
            const idmis = cands.find((m) => m.capHit && want && m.id && m.id !== want);
            const caps = cands.filter((m) => m.capHit && !(want && m.id && m.id !== want)); // caption hits not contradicted by a differing id
            if (caps.length === 1) pick = caps[0];
            else if (caps.length > 1 && author) { const ours = caps.filter((m) => m.auth && m.auth === author); if (ours.length) pick = ours[0]; }
            if (!pick) {
              if (idmis && !caps.length) return { clicked: false, reason: 'idmismatch', postId: idmis.id, pos: idmis.i };
              return { clicked: false, reason: 'ambiguous', count: caps.length || cands.length };
            }
          }
          const a = pick.a;
          a.setAttribute('data-zp-ctarget', '1'); // VER-3: mark so we take the box INSIDE this exact article
          const b = Array.from(a.querySelectorAll('[role="button"]')).find((e) => {
            const n = (e.getAttribute('aria-label') || e.textContent || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
            return /leave a comment|^comment$|hozzaszolas|commenter|comentar|kommentar|commenta/.test(n);
          });
          if (b) { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); const rect = (r.width && r.height) ? { x: r.x + r.width * (0.35 + Math.random() * 0.3), y: r.y + r.height * (0.35 + Math.random() * 0.3) } : null; return { clicked: true, rect, postId: pick.id, pos: pick.i, auth: pick.auth }; }
          return { clicked: false, reason: 'nobtn', postId: pick.id, pos: pick.i };
        }, { s: snip.slice(0, 40), want: expectedPostId, author: expAuthor, idTrusted: !forceContentVerify }, 12000).catch(() => ({ clicked: false, reason: 'err' }));
        // scanFeed marks OUR article (data-zp-ctarget) in-page and returns the comment button's RECT; we click it
        // here with a REAL mouse (move + click) instead of an in-page el.click() (which would be isTrusted=false).
        const scanFeed = async () => {
          const r = await _scanFeedRaw();
          if (r && r.clicked) {
            // Found OUR post's comment button. If it had no geometry (zero-bounds: lazy/collapsed render), we CAN'T
            // real-mouse-click it — report NOT clicked (the caller's nobtn/re-scan path handles it) instead of
            // falsely claiming success (which would then wait on a comment box that never opened).
            if (!r.rect) return { ...r, clicked: false, reason: 'zerobounds' };
            try { await moveMouseTo(page, r.rect.x, r.rect.y); await page.mouse.click(r.rect.x, r.rect.y, { delay: 30 + Math.floor(Math.random() * 70) }); }
            catch { return { ...r, clicked: false, reason: 'clickfail' }; }
          }
          return r;
        };

        let res = await scanFeed();
        // FB renders the top posts as EMPTY [aria-posinset] shells until the page scrolls (lazy content)
        // — the SAME reason the verify needed render-nudges. The old single scroll wasn't enough (the
        // verify confirmed LIVE but the comment then couldn't find the post). Nudge a few times so OUR
        // post's content renders, re-scanning each time, before giving up.
        let _cs = 0;
        while (!res.clicked && res.reason === 'nomatch' && _cs < 6) {
          // A feed NOT sorted newest-first (FB can ignore ?sorting_setting=CHRONOLOGICAL) leaves OUR fresh post
          // below the visible window → 'nomatch' → a FALSE held. Scroll deeper + wait for more articles to lazy-
          // render across more passes (the scan window above is now 15) so a post at position 9-15 is still found.
          step(`Comment: our post not matched yet — nudging the feed to render (try ${_cs + 1}/6)`);
          await page.evaluate((y) => window.scrollBy(0, y), 800 + _cs * 300).catch(() => {});
          await page.waitForFunction((minN) => document.querySelectorAll('[aria-posinset], div[role="article"]').length >= minN, { timeout: 8000 }, Math.min(6 + _cs * 2, 15)).catch(() => {});
          await sleep(settings.speedMode === 'instant' ? 1200 : 2000); // feed-nudge render wait — tightened for instant (loop continues to the deadline until our post is found, so the post is still located)
          res = await scanFeed();
          _cs++;
        }
        // SECOND FULL FEED CHECK: if our post is STILL not found after the first load + nudges, a full RELOAD often
        // surfaces it — FB may not paint a fresh post on the first feed render (slow proxy / empty lazy shells), and a
        // reload rebuilds the DOM + re-applies chronological sort so a post that scrolling alone missed now appears.
        // Do one more COMPLETE pass (reload + scan + nudge) before concluding the post is HELD → this turns a lot of
        // FALSE "held in Spam potentiel" (which needlessly routes to moderator approval) back into a normal comment.
        // Only for a genuine 'nomatch' — a wrong-post refusal (idmismatch/ambiguous) won't be helped by a reload.
        if (!res.clicked && res.reason === 'nomatch') {
          step('Comment: our post not found on the 1st feed check — reloading for a 2nd full feed check');
          await page.goto(`https://www.facebook.com/groups/${gid}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
          await page.waitForSelector('[aria-posinset], div[role="article"], [aria-label*="omment"], [aria-label*="ommentaire"], [role="textbox"]', { timeout: 25000 }).catch(() => {});
          await waitInteractive(10000);
          await dismissPopups(page);
          const authBad2 = await withTimeout(page.evaluate(() => /continue as|use another profile/i.test(document.body.innerText || '')), 8000, false);
          if (authBad2) { step('Comment: session expired after posting — skipped (re-login needed)'); return 'failed'; }
          step('Comment: 2nd feed check — re-locating OUR post (top-8, caption + post-id check)');
          res = await scanFeed();
          let _cs2 = 0;
          while (!res.clicked && res.reason === 'nomatch' && _cs2 < 6) {
            step(`Comment: 2nd check — nudging the feed to render (try ${_cs2 + 1}/6)`);
            await page.evaluate((y) => window.scrollBy(0, y), 800 + _cs2 * 300).catch(() => {});
            await page.waitForFunction((minN) => document.querySelectorAll('[aria-posinset], div[role="article"]').length >= minN, { timeout: 8000 }, Math.min(6 + _cs2 * 2, 15)).catch(() => {});
            await sleep(settings.speedMode === 'instant' ? 1200 : 2000);
            res = await scanFeed();
            _cs2++;
          }
        }
        if (res.reason === 'idmismatch') { step(`Comment: a same-caption post in feed is NOT ours (found id=${res.postId}, expected=${expectedPostId}) — NOT commenting (avoids a wrong-post)`); return 'skipped'; }
        if (res.reason === 'ambiguous') { step(`Comment: ${res.count} same-caption post(s) in the feed and can't confirm which is OURS (no post-id, author not matched) — NOT commenting (avoids landing the link on another account's/stranger's post)`); return 'skipped'; }
        // We matched OUR article (scanFeed marked it via data-zp-ctarget) — either it clicked the
        // "comment" button, or the box was already open (reason 'nobtn'). EITHER WAY take the box that
        // lives INSIDE our marked article; never an unscoped feed box (which could be a different post).
        // Our post WAS found + marked (data-zp-ctarget). Reasons the box may open: clicked (we clicked its comment
        // button), nobtn (box already open, no button), zerobounds/clickfail (button found but not clickable — the box
        // often still opens). Poll for ITS scoped box to render (fast POLL, else the animate wait) for ALL of these
        // (not just clicked — nobtn fell straight to a single flaky read at instant); if it didn't render, RE-SCAN
        // once (re-confirms author+caption + re-marks OUR post → wrong-post-safe) and re-poll — for ANY position.
        // Previously only the topmost pos===0 got the rescue, so a match at pos 2-8 or a zerobounds click was silently
        // dropped even though we knew exactly where our post was.
        if (res.clicked || res.reason === 'nobtn' || res.reason === 'zerobounds' || res.reason === 'clickfail') {
          const SBOX = '[data-zp-ctarget="1"] [contenteditable="true"], [data-zp-ctarget="1"] [role="textbox"]';
          const pollBox = async () => {
            if (isFastMode(settings)) { await page.waitForFunction((s) => { const b = document.querySelector(s); return !!(b && b.offsetHeight > 0); }, { timeout: 2500, polling: 150 }, SBOX).catch(() => {}); await sleep(250); }
            else await sleep(jitter(2300, 0.3));
            return page.$(SBOX).catch(() => null);
          };
          let scoped = await pollBox();
          if (!scoped) {
            const res2 = await scanFeed(); // re-confirm + re-mark OUR post, then re-poll its box (any position)
            if (res2.clicked || res2.reason === 'nobtn' || res2.reason === 'zerobounds' || res2.reason === 'clickfail') scoped = await pollBox();
          }
          if (scoped) { boxes = [scoped]; step(`Comment: our post found in feed (id=${res.postId || '?'}, pos=${(res.pos || 0) + 1}) — using its comment box`); }
          else step('Comment: found OUR post but its scoped comment box did not render after a rescan — not commenting (avoids a wrong-post)');
        } else {
          // 'nomatch' = our post is genuinely NOT in the public feed. After publish confirmed, that means
          // FB held it in the "Spam potentiel"/pending queue (a delayed hold, ~10s after posting). Flag it
          // so the caller routes it to MODERATOR APPROVAL (a held post isn't public, so no account can
          // comment on it — only approval makes it public).
          if (res.reason === 'nomatch') postMissing = true;
          step('Comment: could not confidently find OUR post in the feed — not commenting (avoids a wrong-post)');
        }
      }
    }

    if (!boxes.length) {
      // The comment box often fails to render because FB threw a comment-side rate-limit / "action
      // blocked" wall. Detect + classify it so the caller cools the account down instead of retrying.
      { const _rl = await classifyRateLimit(page); if (_rl) { step(_rl === 'severe' ? 'Comment: ⛔ Facebook TEMPORARILY BLOCKED this account — stopping it (long cooldown)' : 'Comment: ⛔ commenting rate-limited ("You can\'t use this feature right now") — cooling this account down'); return _rl === 'severe' ? 'blocked_account' : 'blocked_comment'; } }
      // Post published but not in the public feed (not a rate-limit) → it's HELD in Spam potentiel.
      if (postMissing) { step('Comment: our post is NOT in the public feed — likely HELD in "Spam potentiel" (needs moderator approval)'); return 'notfound'; }
      step('Comment: no comment box found — comment not sent'); return 'failed';
    }
    step(`Comment: ${boxes.length} comment box(es) found`);

    const target = boxes[0];
    // H1 / commentDwell: a human reads the post before commenting — a randomized, configurable pause
    // with an occasional micro-scroll. Pre-focus and pre-keystroke (the focus step below re-centers the
    // box, correcting any scroll drift), so this never moves the box off-screen or touches the text.
    if (!isFastMode(settings)) { // fast/turbo/humanize-off → no reading dwell
      await sleep(rangeMs(settings, 'commentDwellSecMin', 'commentDwellSecMax', 1, 4, 0));
      if (Math.random() < 0.4) { try { await page.mouse.wheel({ deltaY: 50 + Math.random() * 90 }); await sleep(humanDelay(500, settings, 'pause')); await page.mouse.wheel({ deltaY: -(50 + Math.random() * 90) }); } catch {} }
    }
    // Focus via in-page scroll+focus (ElementHandle.click can hang on re-rendering feeds).
    step('Comment: focusing the comment box');
    await withTimeout(target.evaluate((el) => { el.scrollIntoView({ block: 'center' }); el.focus(); }), 5000, null);
    if (!isFastMode(settings)) await sleep(jitter(600, 0.4)); // fast tiers rely on the box-render waitForFunction below as the real gate — skip this cosmetic settle
    // FUNCTIONAL: confirm the box is actually rendered before entering text — at instant speed it may not have
    // hydrated when we reach here, so a paste/type would go into nothing. Best-effort (falls through after 4s).
    await page.waitForFunction((el) => !!el && el.offsetHeight > 0, { timeout: 4000, polling: 150 }, target).catch(() => {});
    let commentImgOk = false; // did the comment image actually upload? image-only comments must not "submit" an empty box
    if (commentImg) {
      // Scope the file input to the comment box's container ONLY (the document-level
      // input is the feed composer — never fall back to it or we'd mis-attach).
      const cInput = await target.evaluateHandle((el) => {
        const c = el.closest('[aria-posinset], [role="article"], form, [data-pagelet]') || document;
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
          // Wait for the image PREVIEW to render IN OUR comment box's container before submitting (a blind
          // delay was unreliable). SCOPED to the box's own container — a document-wide blob-img check would
          // false-match a pre-existing image in another feed post and submit before OUR image attached.
          let previewed = false;
          { const _pdl = Date.now() + 15000;
            while (Date.now() < _pdl) {
              const ok = await target.evaluate((el) => { const c = el.closest('[aria-posinset], [role="article"], [role="dialog"], form, [data-pagelet]') || document; return !!c.querySelector('img[src^="blob:"]'); }).catch(() => false);
              if (ok) { previewed = true; break; }
              await sleep(700);
            } }
          // ONLY claim the image is real content if its PREVIEW actually rendered. uploadFile resolving means only the
          // CDP transfer completed — FB can SILENTLY reject the file (corrupt/oversize/unsupported) and render no
          // preview. For an image-ONLY comment (no text) that must NOT false-confirm an empty submit as 'sent'; with
          // commentImgOk=false the empty-comment guard below routes it to a reserve rescue instead. A text+image
          // comment still submits its text regardless (its guard is text-gated). A slow (>15s) genuine preview just
          // gets a safe re-try — nothing was submitted, so there is no double-comment.
          commentImgOk = previewed;
          step(previewed ? 'Comment: image attached (preview rendered)' : 'Comment: image upload resolved but NO preview — treating the image as NOT attached (an image-only comment routes to rescue; a text comment still posts its text)');
          await sleep(settings.speedMode === 'instant' ? 300 : 1500); // preview already confirmed above — trim the post-attach settle for instant
        } else { step(`Comment: image upload failed after retries (${cu.error && cu.error.message}) — posting text only`); }
      }
      else step('Comment: image input not found — posting text only');
      // RE-FOCUS: uploadFile dispatches to the file <input> (a sibling), stealing focus from the
      // contenteditable — so the keystrokes + Enter below would type into nothing / the wrong element.
      // Re-focus the actual comment box (the attached image stays attached).
      await withTimeout(target.evaluate((el) => { el.scrollIntoView({ block: 'center' }); el.focus(); }), 5000, null);
      await sleep(300);
    }
    // Enter the comment. In a FB comment box ENTER SUBMITS, so insert newlines as Shift+Enter
    // and enter the rest per-line — otherwise a multi-line comment would submit at the first line.
    // FAST/TURBO → PASTE the text (instant, no robotic char-by-char keystroke stream); NORMAL/SAFE → human typing.
    const commentText = String(post.comment || '');
    if (commentText.trim()) {
      const lines = commentText.split('\n');
      const fastComment = isFastMode(settings);
      step(`Comment: ${fastComment ? 'pasting' : 'typing'} text (${commentText.length} chars${lines.length > 1 ? `, ${lines.length} lines` : ''})`);
      for (let li = 0; li < lines.length; li++) {
        if (lines[li]) {
          if (fastComment) {
            // Paste the line into the focused comment box via execCommand insertText. This fires real beforeinput/
            // input events (FB can't tell it from typing — it is NOT a clipboard paste, so no cross-account race)
            // and lands instantly, so fast mode does ZERO keystroke-stream typing. Fall back to typing only if it
            // genuinely doesn't take (editor still empty for this line).
            const ok = await withTimeout(target.evaluate((el, t) => { try { el.focus(); return document.execCommand('insertText', false, t); } catch { return false; } }, lines[li]), 5000, false);
            if (!ok) await humanType(page, lines[li], settings);
          } else {
            await humanType(page, lines[li], settings); // a real person writing the comment
          }
        }
        if (li < lines.length - 1) { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); }
      }
      if (fastComment) {
        // VERIFY the paste actually LANDED: execCommand('insertText') returns true on DISPATCH even when the text
        // never landed (a half-focused / not-yet-hydrated box at instant speed) — so the Enter below would submit
        // an EMPTY comment. If the box is fully empty, retype once. Gated on _cLen===0 so a partial paste is never doubled.
        await sleep(250);
        const _cLen = await withTimeout(target.evaluate((el) => (el.textContent || '').trim().length), 3000, -1).catch(() => -1);
        if (_cLen === 0) {
          // Re-focus the EXACT box (the resolved target handle — wrong-post-safe) + settle, then RE-PASTE once
          // (a slow char-by-char retype only as a last resort). Keeps the comment "pasted once", not typed.
          step('Comment: paste did not land — re-focusing + re-pasting once');
          try { await target.evaluate((el) => { el.scrollIntoView({ block: 'center' }); el.focus(); }); } catch {}
          await sleep(200);
          for (let li = 0; li < lines.length; li++) {
            if (lines[li]) { const ok2 = await withTimeout(target.evaluate((el, t) => { try { el.focus(); return document.execCommand('insertText', false, t); } catch { return false; } }, lines[li]), 5000, false); if (!ok2) await humanType(page, lines[li], settings); }
            if (li < lines.length - 1) { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); }
          }
        }
      }
      if (settings.speedMode !== 'instant') await sleep(500); // pre-Enter settle — the paste-landed verify above is the real gate, so instant fires straight through
    } else if (commentImg) {
      step('Comment: image-only (no text)');
    }
    // Never "submit" a genuinely EMPTY comment: an image-only comment whose upload FAILED would press Enter on an empty
    // box, and watchEmptied (which only checks the box went empty) would FALSE-confirm it as sent. No text AND no image
    // uploaded → nothing to post → report failed (drives the bounded comment rescue) instead of a phantom "sent".
    if (!commentText.trim() && commentImg && !commentImgOk) { step('Comment: image did not attach and no text — nothing to submit'); return 'failed'; }
    step('Comment: submitting (Enter)');
    try { await target.evaluate((el) => el.focus()); } catch {} // ensure Enter lands ON our comment box — a lost focus = Enter goes nowhere = "sent but not visible"
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
      step('Comment: not confirmed yet — re-focusing + re-pressing Enter once');
      try { await target.evaluate((el) => el.focus()); } catch {}
      try { await page.keyboard.press('Enter'); } catch {} // no-op on an already-empty box (FB rejects empty) — can't double-post
      confirmed = await watchEmptied(3000);
    }
    if (!confirmed) {
      // Enter STILL didn't submit — the box kept our text the whole time (watchEmptied never saw it empty), so nothing
      // posted. Some FB comment boxes don't submit on Enter (multiline mode / a focus blip). Click FB's comment SEND
      // control (the paper-plane / bare "Comment"/"Publier" button) instead. Double-post-SAFE: we only reach here when
      // the box is provably NON-empty (no prior Enter submitted), and the search is SCOPED to OUR box's own composer
      // (form → our marked article) so it can never submit into a different post.
      step('Comment: Enter did not submit — clicking the comment send button');
      const _sendPt = await target.evaluate((box) => {
        const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const scope = box.closest('form') || box.closest('[aria-posinset]') || box.closest('[role="article"]') || document.querySelector('[data-zp-ctarget="1"]') || document;
        const re = /^(comment|commenter|publier|post|send|envoyer|répondre|repondre)$/; // BARE submit verbs only — not "Leave a comment"/"N Comments"
        const b = Array.from(scope.querySelectorAll('div[role="button"], button, [aria-label]'))
          .find((e) => re.test(norm(e.getAttribute('aria-label') || '')) || re.test(norm(e.textContent || '')));
        if (b) { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
        return null;
      }).catch(() => null);
      if (_sendPt) { try { await moveMouseTo(page, _sendPt.x, _sendPt.y); await page.mouse.click(_sendPt.x, _sendPt.y, { delay: 30 + Math.floor(Math.random() * 60) }); } catch {} confirmed = await watchEmptied(3000); }
      else step('Comment: no send button found near our box — leaving as unverified (spot-check this group)');
    }
    // A comment-side rate-limit / "You can't use this feature right now" wall (post→link is FB's most
    // throttled action). Detect it AFTER submit so we COOL THE ACCOUNT DOWN instead of mislabeling a
    // refused comment as sent and then posting+commenting into more groups (which deepens the block and
    // gets the account flagged). The comment was NOT delivered when this wall is up.
    { const _rl = await classifyRateLimit(page); if (_rl) {
      if (!confirmed) { step(_rl === 'severe' ? 'Comment: ⛔ Facebook TEMPORARILY BLOCKED this account — stopping it (long cooldown)' : 'Comment: ⛔ commenting rate-limited ("You can\'t use this feature right now") — cooling this account down'); return _rl === 'severe' ? 'blocked_account' : 'blocked_comment'; }
      // The comment LANDED (box emptied = FB accepted it), but FB then popped the wall on the action that tipped the
      // account over its limit. Do NOT re-queue a landed comment (a reserve would re-place it = DOUBLE-COMMENT). Still
      // surface the account block so it's cooled/stopped — return a LANDED variant the caller maps to "no re-queue + cool down".
      step(_rl === 'severe' ? 'Comment: landed, but Facebook then blocked the account — cooling it down (comment NOT re-queued)' : 'Comment: landed, but Facebook then comment-limited the account — cooling it down (comment NOT re-queued)');
      return _rl === 'severe' ? 'blocked_account_landed' : 'blocked_comment_landed';
    } }
    // C9: landing verification (READ-ONLY) — did our comment text actually appear under the post?
    // We never re-type or re-submit here; this only LABELS the outcome so the operator can tell a
    // confirmed comment from an at-risk one. Outcome: posted / not_visible / unconfirmed.
    let outcome = confirmed ? 'unconfirmed' : 'not_visible'; // start from the box-empty signal
    const commentSnip = String(post.comment || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    // INSTANT: skip the up-to-6s feed re-scan — it ONLY LABELS the outcome for the operator; ALL of its results
    // (posted / unconfirmed / not_visible) map to _commentLanded=true (worker.js ~2784), so it never drives a rescue,
    // so skipping it CANNOT cause a double-comment. The report just shows 'unconfirmed' instead of a verified 'posted ✅'.
    if (settings.speedMode !== 'instant' && commentSnip.length >= 6) {
      const seen = await evalTimed(page, (s) => {
        // SCOPE to OUR post (the data-zp-ctarget article we commented under) so the snippet can't
        // false-match another post's body/comment in the top-3. Permalink page → no marker → its single
        // article is ours, so the top-article fallback is still correct.
        const tgt = document.querySelector('[data-zp-ctarget="1"]');
        if (tgt) return (tgt.innerText || '').includes(s);
        const arts = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]')).slice(0, 3);
        return arts.some((a) => (a.innerText || '').includes(s));
      }, commentSnip, 6000).catch(() => null);
      if (seen === true) outcome = 'posted';
      else if (seen === false && confirmed) outcome = 'not_visible';
      // seen === null (timeout): keep the box-empty result (unconfirmed/not_visible)
    }
    // image-only / very short comment: box-empty is the BEST available signal but NOT a confirmed landing
    // (FB also empties the box on a silent reject) — leave it 'unconfirmed' (still blocks rescue) rather
    // than falsely claim 'posted ✅'.
    step(outcome === 'posted' ? 'Comment: posted and verified ✅ (visible under the post)'
       : outcome === 'not_visible' ? 'Comment: sent but NOT visible under the post — verify this group manually'
       : 'Comment: sent (delivery not auto-verified) — likely OK, spot-check if unsure');
    if (settings.speedMode !== 'instant') await sleep(jitter(600, 0.4));
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
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 120 && r.height > 20; };
      // ALWAYS follow an existing data-zp-editor mark wherever it is in the document (we already chose it, and it may
      // have lost its aria-label once it got text — re-matching by label would drift to a DIFFERENT box). If there's a
      // modal composer dialog, look for the body editable INSIDE it (avoids the background feed's "What's on your mind"
      // box); otherwise search the whole document (the group composer can render INLINE, no dialog). Scoping ONLY to the
      // first div[role="dialog"] focused the WRONG box when the composer was inline or a stray dialog shadowed it —
      // the paste then landed nowhere / the read missed it, and the caller re-typed then skipped the group.
      const marked = document.querySelector('[data-zp-editor="1"]');
      const editSel = '[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]';
      // Prefer editables INSIDE a modal composer dialog (avoids the background feed's "What's on your mind" box), but
      // search ALL dialogs — a stray notification/cookie dialog can be FIRST in the DOM and shadow the composer's, and
      // scoping to only that first dialog focused the wrong box / nothing. If no dialog has an editable, the composer
      // rendered INLINE → search the whole document.
      let cands = [];
      for (const d of document.querySelectorAll('div[role="dialog"]')) cands.push(...d.querySelectorAll(editSel));
      if (!cands.length) cands = Array.from(document.querySelectorAll(editSel));
      const labeled = cands.find((e) => /create (a )?public post|what'?s on your mind|write something|start a discussion|^post$/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('aria-placeholder') || '')));
      // Largest visible editable = the composer body (robust when the aria-label drifts after text is entered).
      const bySize = cands.filter(vis).sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return (rb.width * rb.height) - (ra.width * ra.height); });
      const el = (marked && vis(marked)) ? marked : (labeled || bySize[0] || cands.find(vis) || cands[0]);
      if (el) {
        // Mark the EXACT element we focus/paste into so verification reads the SAME element later.
        try { document.querySelectorAll('[data-zp-editor]').forEach((e) => { if (e !== el) e.removeAttribute('data-zp-editor'); }); } catch {}
        el.setAttribute('data-zp-editor', '1');
        el.scrollIntoView({ block: 'center' }); el.focus(); const r = el.getBoundingClientRect(); return { x: r.x + r.width * (0.3 + Math.random() * 0.4), y: r.y + Math.min(r.height / 2, 20) };
      }
      return null;
    }).catch(() => null);
    if (pt) { await moveMouseTo(page, pt.x, pt.y); await page.mouse.click(pt.x, pt.y, { delay: 30 + Math.floor(Math.random() * 70) }).catch(() => {}); await sleep(400); return true; }
  } catch {}
  return false;
}

// Normalized length of the MAIN composer editor's text (0 = empty). Reads the SAME element we focused/pasted
// into (marked data-zp-editor) via textContent — which is LAYOUT-INDEPENDENT, so it returns the real text even
// in an off-screen window (innerText would be '' there). Used to decide whether a paste landed and to confirm
// the editor is empty before typing — so a re-type can never DOUBLE the text.
async function editableLen(page) {
  return page.evaluate(() => {
    const strip = (s) => String(s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, '');
    // Read the EXACT editor we marked (data-zp-editor) when it exists — do NOT race it by text length against every
    // contenteditable in the document, or a stray box (an open Messenger chat, a background feed composer) with MORE
    // text would spoof a non-empty/landed caption. Only when the mark is ABSENT (inline composer, or the mark was
    // dropped on a re-mount) fall back to the most-text editable variant anywhere — the whole-doc recovery that fixed
    // the dialog-scoped "read 0 while the caption was visibly present → destructive retype" bug.
    const marked = document.querySelector('[data-zp-editor="1"]');
    if (marked) return strip(marked.textContent || marked.innerText || '').length;
    const seen = new Set(); const cands = [];
    const add = (e) => { if (e && !seen.has(e)) { seen.add(e); cands.push(e); } };
    const a = document.activeElement; if (a && (a.isContentEditable || (a.getAttribute && a.getAttribute('role') === 'textbox'))) add(a);
    document.querySelectorAll('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]').forEach(add);
    let best = 0; for (const e of cands) { const n = strip(e.textContent || e.innerText || '').length; if (n > best) best = n; }
    return best;
  }).catch(() => 0);
}

// VERIFY THE CAPTION LANDED after a paste (the operator's "add a step to verify"): poll the EXACT marked
// editor's textContent until it contains the caption (or, fallback, has substantial text), so a slow paste
// isn't read too early and a successful paste is NEVER cleared+retyped. Returns { landed, len }.
async function verifyCaptionLanded(page, caption, ms = 6000) {
  const want = String(caption || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toLowerCase();
  const probe = want.slice(0, 24); // a prefix match is enough; pastes can normalize punctuation/emoji slightly
  const need = Math.min(probe.length || 1, 12); // "substantial text present" fallback when the prefix can't match
  const deadline = Date.now() + ms;
  let len = 0;
  while (Date.now() < deadline) {
    const r = await page.evaluate(() => {
      // Read the EXACT marked editor when present (never race by length against a stray box that could hold OUR-caption-
      // length text — e.g. a draft or a Messenger chat — and falsely satisfy the length fallback → publishing the wrong
      // body). Only fall back to the most-text editable anywhere when the mark is absent (inline / re-mounted composer).
      const marked = document.querySelector('[data-zp-editor="1"]');
      if (marked) return { got: String(marked.textContent || marked.innerText || ''), marked: true };
      const seen = new Set(); const cands = [];
      const add = (e) => { if (e && !seen.has(e)) { seen.add(e); cands.push(e); } };
      const a = document.activeElement; if (a && (a.isContentEditable || (a.getAttribute && a.getAttribute('role') === 'textbox'))) add(a);
      document.querySelectorAll('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]').forEach(add);
      let best = ''; for (const e of cands) { const t = String(e.textContent || e.innerText || ''); if (t.length > best.length) best = t; }
      return { got: best, marked: false };
    }).catch(() => ({ got: '', marked: false }));
    const norm = String(r.got).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toLowerCase();
    len = norm.length;
    // PREFIX match is the real "this is OUR caption" signal. The length-only fallback is allowed ONLY when there was no
    // marked editor to read exactly — so a DRAFT sitting in the marked editor can't spoof "landed" by length alone (which
    // would let the survival loop skip its re-paste and publish the draft). When marked, the loop's _stale re-paste handles a
    // caption that didn't prefix-match (normalization) by re-entering ours — harmless.
    if (probe && norm.includes(probe)) return { landed: true, len };
    if (!r.marked && len >= need) return { landed: true, len };
    await sleep(150); // poll granularity only (the landed test above + the caller's deadline are unchanged) — 400→150ms so a caption that commits late is detected a tick sooner, not after a full slice
  }
  return { landed: false, len };
}

// Robustly EMPTY the focused composer editor and CONFIRM it's empty before any typing — so typing can
// never append to (and thus DOUBLE) text that's already there (e.g. a paste that landed but couldn't be
// verified). Loops select-all + Delete/Backspace until the editor reads empty (or attempts run out).
async function clearEditable(page, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    await focusEditable(page);
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.press('Delete').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await sleep(120);
    if ((await editableLen(page)) === 0) return true;
    // DOM-level fallback: select the marked editor's whole contents and delete via execCommand, which fires the
    // native input event FB's React composer listens to — clears drafts that resist keyboard Ctrl+A+Delete.
    await page.evaluate(() => {
      // Whole-document (not the first dialog only) — match the marked editor focusEditable set, wherever it lives
      // (inline / re-mounted / shadowed by a stray dialog); a dialog-scoped fallback missed it and cleared nothing.
      const el = document.querySelector('[data-zp-editor="1"]')
        || Array.from(document.querySelectorAll('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]')).find((e) => { const r = e.getBoundingClientRect(); return r.width > 120 && r.height > 20; });
      if (!el) return;
      try { el.focus(); const sel = window.getSelection(); const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range); document.execCommand('delete'); } catch {}
    }).catch(() => {});
    await sleep(100);
    if ((await editableLen(page)) === 0) return true;
  }
  return (await editableLen(page)) === 0;
}

// Attempt a real email+password login using the account's EXISTING page (profile is locked,
// so we cannot launch a new browser). OPT-IN: only called when account.email && account.password.
// Returns true (session recovered) or false (checkpoint/2FA/wrong-password/error).
// Never throws; relies on timeouts so it can never hang the caller indefinitely.
// Robust auto-login: retry the single-attempt flow ONCE (covers a transient slow page / nav timeout / brief FB
// hiccup) and hard-cap each attempt so a wedged page.type / navigation can't hang the run. A 'checkpoint' (human
// needed) or success returns immediately — only a plain failure is retried. Returns true | 'checkpoint' | false.
async function credentialLogin(page, email, password, log, name) {
  const MAX = 2;
  let last = false;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const r = await withTimeout(_credentialLoginOnce(page, email, password, log, name), 75000, false); // cap a wedged attempt
    if (r === 'checkpoint' || r === true) return r;
    last = r;
    if (attempt < MAX) { log(`🔁 [${name}] auto-login attempt ${attempt} didn't take — retrying once…`); await sleep(3000 + Math.floor(Math.random() * 2000)); }
  }
  return last;
}
async function _credentialLoginOnce(page, email, password, log, name) {
  try {
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(1400 + Math.floor(Math.random() * 1600));
    try { await dismissPopups(page); } catch {} // clear the EN/FR cookie banner so it can't sit over the form

    // Fill a field like a person: move the mouse to it, click to focus, then type with a human rhythm
    // (variable per-key delays + the occasional fumble+Backspace from humanType). NO page.type() flat-delay
    // robo-typing and NO blind .click() — FB's login page scans for exactly that mechanical signature.
    const humanFill = async (selectors, value, label) => {
      const found = await page.waitForSelector(selectors.join(', '), { timeout: 8000 }).then(() => true).catch(() => false);
      if (!found) { log(`⚠️ [${name}] login form not found`); return false; }
      const pt = await page.evaluate((sels) => {
        const el = sels.map((s) => document.querySelector(s)).find(Boolean);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        // aim at a random point inside the field (not dead-center) — humans don't click the exact middle
        return { x: Math.round(r.x + r.width * (0.3 + Math.random() * 0.4)), y: Math.round(r.y + r.height / 2) };
      }, selectors).catch(() => null);
      if (!pt) { log(`⚠️ [${name}] ${label} field not visible`); return false; }
      try { await moveMouseTo(page, pt.x, pt.y); } catch {}
      await sleep(120 + Math.floor(Math.random() * 240));
      try { await page.mouse.click(pt.x, pt.y, { delay: 40 + Math.floor(Math.random() * 90) }); } catch {}
      await sleep(180 + Math.floor(Math.random() * 360));
      await humanType(page, String(value), { humanizeMaster: true });
      return true;
    };

    if (!(await humanFill(['input[name="email"]', '#email'], email, 'email'))) return false;
    await sleep(550 + Math.floor(Math.random() * 900)); // human beat before moving to the password
    if (!(await humanFill(['input[name="pass"]', '#pass'], password, 'password'))) return false;
    await sleep(650 + Math.floor(Math.random() * 1100)); // "glance over what I typed" before submitting

    // Submit with a real mouse click on the button (move there first); fall back to Enter only if not found.
    const btnPt = await page.evaluate(() => {
      const b = ['button[name="login"]', 'button[type="submit"][name="login"]', '[data-testid="royal_login_button"]', 'button[type="submit"]']
        .map((s) => document.querySelector(s)).find(Boolean);
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }).catch(() => null);
    if (btnPt) {
      try { await moveMouseTo(page, btnPt.x, btnPt.y); } catch {}
      await sleep(90 + Math.floor(Math.random() * 200));
      try { await page.mouse.click(btnPt.x, btnPt.y, { delay: 50 + Math.floor(Math.random() * 90) }); } catch {}
    } else {
      await page.keyboard.press('Enter').catch(() => {});
    }
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
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
// Per-document stealth spoofs applied to EVERY posting tab (the main one AND each paced-multi-tab prefetch tab) via
// evaluateOnNewDocument BEFORE it navigates: report the page as visible/focused and on-screen (the window is parked at
// -32000) and keep navigator.webdriver false. sx/sy = the account's stable per-name screen offset.
function stealthSpoof(sx, sy, hwc) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  try { Object.defineProperty(Document.prototype, 'hasFocus', { configurable: true, value: () => true }); } catch { try { document.hasFocus = () => true; } catch {} }
  const proto = Object.getPrototypeOf(window) || window;
  for (const pv of [['screenX', sx], ['screenY', sy], ['screenLeft', sx], ['screenTop', sy]]) {
    try { Object.defineProperty(proto, pv[0], { configurable: true, get: () => pv[1] }); }
    catch { try { Object.defineProperty(window, pv[0], { configurable: true, get: () => pv[1] }); } catch {} }
  }
  try { Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => undefined }); } catch {}
  // Per-account, COHERENT fingerprint de-clustering (real-IP fleet safety): all accounts run real Chrome on ONE host, so
  // without this ~1/6 of the fleet shares one device fingerprint — a linked-account cluster from the one IP. Vary ONLY
  // navigator.hardwareConcurrency — a JS-only axis with NO Sec-CH-* HTTP-header twin, so a JS override stays self-consistent.
  // deviceMemory is DELIBERATELY NOT spoofed: it has a Sec-CH-Device-Memory header the network stack computes from the REAL
  // host RAM (evaluateOnNewDocument can't touch it), so a JS override would CONTRADICT the header — the exact self-inconsistent
  // fingerprint ADR-0001's captcha loop came from. Same reason UA/canvas/WebGL are not forged.
  try { if (hwc) Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => hwc }); } catch {}
}

async function runAccount(o) {
  const { account, post: basePost, groups, useProxies, proxies, assignedProxy, log, shouldStop, isLoginOpen, isCheckOpen, registerAborter, onResult, isOnline, waitIfPaused, isPaused, isDisabled, maxThisRun } = o;
  const reportProxy = typeof o.reportProxy === 'function' ? o.reportProxy : () => {}; // E-X3: proxy health (no-op if absent)
  const isOnCooldown = typeof o.isOnCooldown === 'function' ? o.isOnCooldown : () => false; // E-X3: skip a cooling POOL proxy
  // Per-(post,group) dedup ledger — the orchestrator passes these ONLY in deal-once modes (campaign-plan/unique/
  // sequence) + reserve stand-ins, where a post must reach each group at most once per cycle. So a reserve covering
  // a partial drop SKIPS groups that already got the post (never a double-post). No-ops in broadcast modes.
  const markDelivered = typeof o.markDelivered === 'function' ? o.markDelivered : () => {};
  const alreadyDelivered = typeof o.alreadyDelivered === 'function' ? o.alreadyDelivered : () => false;
  const onlyGroups = Array.isArray(o.onlyGroups) ? new Set(o.onlyGroups) : null; // owed-group allow-list: a stand-in covers ONLY a dropped account's un-reached groups
  const name = account.name;
  // Per-account settings COPY (applyPace returns the SHARED settings object by reference for 'normal' pace, so we must
  // never mutate it) carrying this account's seeded behavioral personality (typing speed / reading dwell / gap tempo /
  // typo-proneness) — so many accounts on one host don't all share the SAME timing distribution.
  const settings = { ...(o.settings || {}), _behavior: behaviorFor(name) };
  const vp = viewportFor(name); // per-account viewport (seeded) — used for --window-size, defaultViewport AND the off-screen park bounds so they all agree
  // Per-account successful-run counter (file-based) — drives the new-account WARM-UP gate below.
  let priorRuns = store.loadRunCount(name); // floor at 0 so a corrupt/negative file can't break the gate
  let ranThisCycle = false; // set once the account passes auth — gates the warm-up counter bump (in finally) so it covers ALL post-auth exits, not just the happy path

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

  // Fix #4: profile-lock guard — two Chromium instances can't share a userDataDir. Also covers a read-only membership
  // check in flight (isCheckOpen): SKIP the account this cycle rather than let the launch below force-kill the check's
  // live Chromium + delete its Singleton lock files (which could corrupt the profile).
  if ((isLoginOpen && isLoginOpen(name)) || (isCheckOpen && isCheckOpen(name))) {
    const _why = (isCheckOpen && isCheckOpen(name)) ? 'membership check is running for this account' : 'login browser is open for this account';
    log(`🚫 [${name}] ${_why} — skipping`);
    report('', '', 'skipped', _why, '');
    return { posted: 0, errors: 1, pendingApproval: 0, noRetry: false, flag: null, postedIds: [] };
  }

  // An account with NO assigned groups is SKIPPED (it must NOT fall back to posting to
  // every group — that would spam all groups from unconfigured accounts).
  const assigned = (account.assignedGroups && account.assignedGroups.length)
    ? groups.filter((g) => account.assignedGroups.includes(g.id) || account.assignedGroups.includes(g.groupId))
    : [];
  let targetGroups = assigned; // post to ALL the account's assigned groups (the user selects them per account)
  if (onlyGroups) targetGroups = assigned.filter((g) => onlyGroups.has(g.groupId || g.id)); // reserve stand-in: cover ONLY the dropped account's un-reached groups
  // Shuffle the visit ORDER per run (Fisher-Yates) so an account doesn't walk its groups in the SAME fixed sequence
  // every cycle (a repeatable traversal signature). Computed once → stable for this whole run; order-safe because dedup
  // (markDelivered/alreadyDelivered) and the reserve onlyGroups filter both key off gid, not position.
  for (let i = targetGroups.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = targetGroups[i]; targetGroups[i] = targetGroups[j]; targetGroups[j] = t; }

  if (!targetGroups.length) { log(`⏭️ [${name}] no assigned groups — skipping`); report('', '', 'skipped', 'no assigned groups', ''); return { posted: 0, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: [] }; }

  const launchArgs = [
    // (--no-sandbox + --disable-blink-features are centralized in lib/browser BASE_ARGS)
    // WebRTC IP-leak guard: force ALL WebRTC/STUN traffic through the proxy and suppress host LAN/WAN IP in ICE
    // candidates — otherwise a proxied browser still leaks the operator's REAL IP via RTCPeerConnection (any FB
    // fingerprinting script can trigger it), silently linking accounts. Harmless when no proxy is set.
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--window-size=${vp.width},${vp.height}`,
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
    // CRITICAL for posting while the laptop is IN USE: on Windows, native occlusion detection marks a
    // window "not visible" when the user's apps cover it (or it's parked off-screen) and throttles its
    // rendering/timers — Facebook then won't process the post. Disabling it (in addition to the flags
    // above) keeps the hidden/background window rendering at full speed so posting works either way.
    '--disable-features=CalculateNativeWinOcclusion',
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
  // Belt-and-suspenders: the PowerShell CommandLine match in killChromiumForProfile can truncate on long arg
  // lists and miss the lock holder — a stale Singleton* marker then refuses the launch. After the kill, delete
  // the markers best-effort (Chromium recreates them; no live holder remains at this point).
  try { const pdir = store.profileDir(name); for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) { try { fs.rmSync(path.join(pdir, f), { force: true }); } catch {} } } catch {}
  try { store.sanitizeProfile(name, settings.hideBrowser !== false); } // pin off-screen placement when hidden
  catch (e) { log(`⚠️ [${name}] profile prep failed (${e.message}) — skipping account`); return { posted: 0, errors: 1, pendingApproval: 0, noRetry: false, flag: null, postedIds: [] }; }
  // Proxy: Chrome can't do authenticated SOCKS5 directly, so we wrap the upstream
  // through proxy-chain (a local anonymized HTTP proxy) when credentials are present.
  let proxyAuth = null, anonLocal = null, watchdog = null;
  const tempImages = []; // downloaded remote images to clean up at the end
  {
    // Per-account STABLE proxy: an account's OWN assigned proxy is ALWAYS honored — even when the global
    // proxy toggle is OFF — because the operator set it deliberately. The global `useProxies` only enables the
    // shared POOL fallback for accounts without their own proxy. (FB trusts a consistent per-account IP and
    // links accounts that share/hop IPs, so the pool pick is a stable hash of the account name.)
    let proxyStr = (account.proxy && String(account.proxy).trim()) || '';
    if (!proxyStr && useProxies && proxies && proxies.length) {
      // Use the proxy the ORCHESTRATOR pinned for this cycle (assignedProxy) — it serialized the anti-link gate on it,
      // so picking a DIFFERENT pool proxy here would let two accounts exit one live IP at once. Fall back to the stable
      // name-hash only when no assignedProxy was supplied (older call path). If ALL are cooling, still pick (post).
      if (assignedProxy) { proxyStr = String(assignedProxy).trim(); }
      else { const live = proxies.filter((p) => !isOnCooldown(p)); const pool = live.length ? live : proxies; let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; proxyStr = pool[h % pool.length]; }
    }
    if (proxyStr) {
      const p = parseProxy(proxyStr);
      if (p) {
        // Authenticated proxies use page.authenticate (applied to every page below) on a BARE --proxy-server,
        // NOT proxy-chain: proxy-chain's local-forwarder tunnel proved unreliable with these proxies
        // (ERR_TUNNEL_CONNECTION_FAILED) while page.authenticate connects cleanly. A down proxy still fails
        // CLOSED (requests error out — Chromium never bypasses --proxy-server to the real IP).
        proxyAuth = p;
        launchArgs.push(`--proxy-server=${p.server}`);
        log(`✅ [${name}] proxy ${p.server}${p.username ? ' (auth via page.authenticate)' : ''}`); reportProxy(proxyStr, true);
      } else {
        // A configured-but-malformed proxy is a real misconfig. Do NOT silently post from the bare
        // IP (that defeats the point and can burn the account) — skip it and tell the operator.
        const hint = proxyFormatHint(proxyStr);
        log(`🚫 [${name}] proxy string is invalid ("${shortText(proxyStr, 40)}")${hint ? ' — ' + hint : ''}. Skipping this account so it does NOT post from your real IP. Fix the proxy in the Accounts tab.`);
        report('', '', 'error', 'invalid proxy — account skipped', '');
        return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: 'proxy_invalid', postedIds: [] };
      }
    } else if (useProxies) {
      // Proxies are ON but this account has no proxy of its own AND the shared pool is empty → FAIL CLOSED.
      // The operator turned proxies on to avoid shared-IP account linking; silently posting from the real IP
      // would defeat that and can burn the account. Skip it — turn the proxy toggle off for bare-IP accounts.
      log(`🚫 [${name}] proxies are ON but this account has NO proxy (and the pool is empty) — skipping so it does NOT post from your real IP. Assign a proxy (Accounts tab), or turn the global proxy toggle off.`);
      report('', '', 'error', 'no proxy (proxies enabled) — account skipped', '');
      return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: 'proxy_invalid', postedIds: [] };
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
  let posted = 0, errors = 0, pendingApproval = 0, noRetry = false, flag = null, offline = false, rlKind = null, consecPubTimeouts = 0, consecNoPostBtn = 0;
  const heldRecords = []; // MOD: posts FB held in the moderation queue this run (for the moderator phase)
  const commentQueue = []; // posts that went LIVE but whose link-comment couldn't be placed (for a healthy reserve account to rescue)
  try {
    const hidden = settings.hideBrowser !== false; // default: hidden
    // ALWAYS headful — Facebook's composer (clipboard, typing focus, publish) misbehaves in true
    // headless even with stealth. "Hidden" just parks the real window OFF-SCREEN so it's invisible
    // but still a normal browser FB treats correctly; "visible" puts it on-screen for watching.
    launchArgs.push(hidden ? '--window-position=-32000,-32000' : '--window-position=80,40');
    log(`🖥️ [${name}] launching browser (${hidden ? 'hidden (off-screen)' : 'visible'})`);
    browser = await launchStealth({
      headless: false,
      userDataDir: store.profileDir(name),
      args: launchArgs,
      defaultViewport: { width: vp.width, height: vp.height },
      protocolTimeout: 90000, // cap CDP op hangs (90s allows slow www->web redirects; still << default 180s)
    });
    if (typeof registerAborter === 'function') {
      unregisterAborter = registerAborter(() => { closeBrowserOnce(); });
    }
    const _pages = await browser.pages();
    for (let i = 1; i < _pages.length; i++) { try { await _pages[i].close(); } catch {} }
    let page = _pages[0] || (await browser.newPage()); // `let`: the paced-multi-tab pipeline swaps this to a pre-loaded tab per group (opt-in via tabsPerBrowser). With tabsPerBrowser=1 it is never reassigned → identical to before.
    // (the main page's proxy page.authenticate runs below at the existing fallback, before the first FB nav)
    // ── beforeunload guard ────────────────────────────────────────────────────────────────────────
    // Facebook attaches a `beforeunload` handler to the post composer while a post is still uploading /
    // has "unsaved changes". When we then reload the group to verify, or navigate to comment, Chrome
    // pops its NATIVE "Quitter le site Web ?" dialog and BLOCKS the navigation. Puppeteer never answers
    // it on its own, so in a VISIBLE browser the run hangs until a human clicks "Quitter". Auto-accept
    // beforeunload (= "Quitter" → navigation proceeds) and dismiss any other stray native dialog, on the
    // main page AND on any popup/tab FB opens. THIS is the recurring "I had to click Quitter" hang.
    const attachDialogGuard = (pg) => {
      try {
        pg.on('dialog', async (d) => {
          try { if (d.type() === 'beforeunload') await d.accept(); else await d.dismiss(); } catch {}
        });
      } catch {}
    };
    attachDialogGuard(page);
    try { browser.on('targetcreated', async (t) => { try { if (t.type() === 'page') { const np = await t.page(); if (np) { if (proxyAuth && proxyAuth.username) { try { await np.authenticate({ username: proxyAuth.username, password: proxyAuth.password }); } catch {} } attachDialogGuard(np); } } } catch {} }); } catch {}
    // Make Facebook treat the page as FOCUSED + VISIBLE even when the window is off-screen, and
    // force the window off-screen. Each CDP step has its OWN try/catch + log so a failure in one
    // (e.g. a CDP attach race) can't silently skip the others — the force-off-screen MUST run when
    // hidden even if focus-emulation throws, or a clamped window would stay visible undiagnosed.
    // Per-account stable screen offset (name hash) — hoisted so the main tab AND every paced-multi-tab prefetch tab
    // present the SAME plausible on-screen position (not the -32000 off-screen truth). Distinct between accounts.
    let _scrH = 0; for (let _i = 0; _i < name.length; _i++) _scrH = (_scrH * 31 + name.charCodeAt(_i)) >>> 0;
    const _scrX = 60 + (_scrH % 900), _scrY = 30 + (_scrH % 500);
    // Per-account, STABLE (name-seeded), PLAUSIBLE hardwareConcurrency — so 400 accounts on one host+IP don't share one
    // device fingerprint. Capped at the REAL core count so it never over-reports cores (a mild tell). deviceMemory is NOT
    // spoofed (Sec-CH-Device-Memory header would contradict it — see stealthSpoof / ADR-0001). Passed to every page.
    const _cores = (os.cpus() && os.cpus().length) || 4;
    const _hwPool = [2, 4, 6, 8, 12].filter((n) => n <= _cores);
    const _acctHwc = _hwPool.length ? _hwPool[_scrH % _hwPool.length] : _cores;
    let cdpSession = null, hiddenWindowId = null; // H-1: keep the windowId so we can re-park later (H-2)
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
          hiddenWindowId = windowId; // H-1: cache for the periodic re-park check
          await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
          await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: vp.width, height: vp.height } });
          const back = await cdpSession.send('Browser.getWindowBounds', { windowId });
          const off = back && back.bounds && (back.bounds.left <= -2000 || back.bounds.top <= -2000);
          log(`🙈 [${name}] window parked off-screen (${off ? 'confirmed' : `still at ${back && back.bounds ? back.bounds.left + ',' + back.bounds.top : '?'} — Windows clamped it`})`);
        } catch (e) { log(`⚠️ [${name}] could not force-hide window (${e.message}) — it may be visible`); }
      }
      try { await cdpSession.send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
      catch (e) { log(`⚠️ [${name}] focus emulation failed (${e.message}) — publish may be slower`); }
      // Per-account/proxy TIMEZONE + LOCALE — a PROXIED account reporting the HOST clock/locale mismatches its proxy IP
      // geo (a strong FB correlation/bot signal). Centralized in lib/browser.applyProxyGeo so every browser instance
      // (worker / moderator / rescue / repost / login / status-check) applies it identically. Unset → no override (host
      // value, correct for a real-IP account).
      await applyProxyGeo(page, account, settings, useProxies, proxies, (m) => log(`[${name}] ${m}`));
      // …and cover any popup / new tab FB spawns later in this long-lived posting session (so it can't report the host clock/locale).
      attachGeoToNewTargets(browser, account, settings, useProxies, proxies);
    }
    // The per-document spoofs (visible/focused + plausible on-screen screenX/Y + webdriver=false) — see stealthSpoof.
    // Applied here to the main tab; the paced-multi-tab path applies the SAME to each prefetch tab before it navigates.
    try { await page.evaluateOnNewDocument(stealthSpoof, _scrX, _scrY, _acctHwc); } catch {}
    // NOTE: we deliberately do NOT overridePermissions(clipboard) anymore. Caption/comment insertion uses CDP
    // Input.insertText + execCommand('insertText') — neither touches the OS clipboard — so the grant was unused, and
    // a pre-approved clipboard permission is itself a bot tell (navigator.permissions.query would read 'granted'
    // where a real first-time visitor reads 'prompt').
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
    const _gd = (Number.isFinite(settings.groupDelayMax) ? settings.groupDelayMax : 300) * 1.3; // watchdog tracks the MAX-end group draw
    const _cd = Number.isFinite(settings.commentDelayMax) ? settings.commentDelayMax : 180;
    const perGroupMs = (_gd + _cd + 250) * 1000; // +250s work headroom (dwell + slow-typing fallback + upload + publish)
    const accountBudget = Math.max(600000, Math.round(targetGroups.length * perGroupMs));
    // The watchdog must fire ONLY when the account is genuinely wedged. setTimeout counts wall-clock,
    // which includes laptop sleep — so on resume the timer can fire immediately on a perfectly healthy
    // run. Before aborting, probe liveness: if the browser still answers a trivial evaluate it just
    // resumed from sleep → re-arm; only abort if it's truly unresponsive.
    const _log = (m) => { try { log(m); } catch {} }; // never let a logger error leave the account un-watched
    const onWatchdogTick = async () => {
      try {
        let alive = false;
        try {
          if (browser && browser.isConnected()) {
            await Promise.race([page.evaluate(() => 1), new Promise((_, r) => setTimeout(() => r(new Error('probe timeout')), 8000))]);
            alive = true;
          }
        } catch { alive = false; }
        if (alive) { _log(`⏰ [${name}] budget elapsed but browser is alive (likely resumed from sleep) — extending`); armWatchdog(); return; }
        _log(`⏰ [${name}] time budget exceeded and browser unresponsive — aborting account`);
        aborted = true;
        await closeBrowserOnce();
        watchdog = null;
      } catch (e) { _log(`⏰ [${name}] watchdog tick error (${e && e.message}) — re-arming`); armWatchdog(); } // a throw must never silently stop the guard
    };
    function armWatchdog() { watchdog = setTimeout(onWatchdogTick, accountBudget); }
    armWatchdog();
    // Pause hold usable INSIDE waits (passed as sleepInterruptible's onPause): suspend the time-budget
    // watchdog, hold while paused, re-arm on resume — so a pause during a long wait can't let the
    // watchdog abort the browser. Mirrors the between-groups idiom so the whole run honors Pause.
    const pauseHold = async () => {
      if (typeof isPaused !== 'function' || !isPaused()) return;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (typeof waitIfPaused === 'function') await waitIfPaused();
      armWatchdog();
    };
    // The user turned THIS account OFF mid-run. isDisabled() reads disk fresh (so a UI toggle is seen
    // mid-cycle); THROTTLE to one check per 4s so a per-second wait loop doesn't re-read the file constantly.
    let _disChk = { t: 0, v: false };
    const isDisabledNow = () => {
      try {
        const now = Date.now();
        if (now - _disChk.t < 4000) return _disChk.v;
        _disChk = { t: now, v: typeof isDisabled === 'function' && !!isDisabled() };
        return _disChk.v;
      } catch { return false; }
    };
    // Soft stop = hard Stop OR just-disabled. Ends mid-cycle WAITS early so a disabled/paused account
    // doesn't sit idle; the clean break happens at the next group boundary (a just-published post still
    // gets its comment attempt → no orphan).
    const softStop = () => shouldStop() || isDisabledNow();
    // PRIMARY proxy auth for the main page (answers the proxy's 407 before the first FB navigation). This is
    // now the standard path — proxy-chain is no longer used (anonLocal stays null) because its tunnel was
    // unreliable with these proxies; page.authenticate connects cleanly. Popups are authed in targetcreated.
    if (proxyAuth && proxyAuth.username && !anonLocal) {
      try { await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password }); log(`✅ [${name}] proxy auth via page.authenticate`); }
      catch (e) { log(`⚠️ [${name}] proxy auth (page.authenticate) failed (${e.message}) — 407s expected`); }
    }

    // Auth bootstrap — 3 fail-safe tiers: (1) the profile's OWN logged-in session; (2) inject saved
    // cookies.json; (3) AUTO-LOGIN with stored credentials. Tier 3 now fires whenever the session is still
    // invalid AND credentials exist — COOKIES OR NOT — so a credentialed account always tries to log itself in
    // (the old code only reached Tier 3 from inside the cookie branch, so a creds-only account fell through
    // unauthenticated). Credentials are encrypted at rest (safeStorage); decrypt is transparent for legacy plaintext.
    const cookies = store.readCookies(name);
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    // PROXY HEALTH PROBE (best-effort): a configured proxy that's dead lands the first nav on a chrome-error
    // page (ERR_PROXY/ERR_TUNNEL/ERR_SOCKS) or a 407 wall. Say WHY and skip — otherwise authCheck below misreads
    // "no Facebook connection" as "logged out" and burns the cookie/credential recovery for nothing. Never throws.
    if (proxyAuth) {
      try {
        const u = page.url() || '';
        let proxyErr = '';
        if (/^chrome-error:/i.test(u) || /err_proxy|err_tunnel|err_socks|err_empty_response/i.test(u)) proxyErr = u;
        else if (!/facebook\.com/i.test(u)) {
          const body = await withTimeout(page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 400)), 4000, '').catch(() => '');
          if (/proxy authentication|407|tunnel connection failed|err_proxy/i.test(body)) proxyErr = '407 proxy authentication';
        }
        if (proxyErr) {
          const reason = classifyProxyError(proxyErr);
          reportProxy(proxyStr, false, reason);
          log(`🚫 [${name}] proxy failure (${reason}) — ${proxyErrorHint(reason)}. Skipping this account so it does NOT post from your real IP.`);
          return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: 'proxy_invalid', postedIds: [] };
        }
      } catch {}
    }
    const authCheck = () => withTimeout(page.evaluate(() =>
      !/login|checkpoint/.test(location.href) && !/continue as|use another profile/i.test(document.body.innerText || '')
    ), 8000, false).catch(() => false);
    let authed = await authCheck();
    if (authed) {
      // Tier 1 must ALSO have the c_user cookie: a silently-expired session can still render the home feed (passing
      // the text check above) with NO c_user — without this it skips cookie/credential recovery then fails mid-run.
      const cks1 = await withTimeout(page.cookies(), 8000, []);
      if (!(Array.isArray(cks1) && cks1.some((c) => c && c.name === 'c_user' && c.value))) { authed = false; log(`🔓 [${name}] profile session has no c_user cookie — treating as logged-out (will recover via cookies/credentials)`); }
    }
    if (authed) {
      log(`🔑 [${name}] using existing profile session`);
    } else {
      // Tier 2 — inject saved cookies (resilient: batch, then one-by-one) and re-verify.
      if (cookies.length) {
        const normalized = cookies.map(normalizeCookie);
        try { await page.setCookie(...normalized); }
        catch (batchErr) { log(`⚠️ [${name}] batch cookie set failed (${batchErr.message}) — retrying one-by-one`); for (const ck of normalized) { try { await page.setCookie(ck); } catch {} } }
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(2000);
        const cookieAuthed = await authCheck();
        authed = cookieAuthed && (await withTimeout(page.cookies(), 8000, [])).some((c) => c.name === 'c_user' && c.value);
        if (authed) log(`🔄 [${name}] session recovered with saved cookies`);
      }
      // Tier 3 — AUTO-LOGIN with stored credentials (cookies-or-not). credentialLogin fills the FB form + persists cookies.
      if (!authed) {
        const credEmail = secret.decrypt(account.email);
        const credPass = secret.decrypt(account.password);
        if (credEmail && credPass) {
          log(`🔐 [${name}] not logged in — auto-login with stored credentials...`);
          const credResult = await credentialLogin(page, credEmail, credPass, log, name);
          if (credResult === true) {
            log(`🔄 [${name}] session recovered via credential auto-login`);
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
          // Account HAS credentials but they can't be decrypted on this machine (OS crypto changed) — make it diagnosable (either field).
          if ((account.email && !credEmail) || (account.password && !credPass)) log(`⚠️ [${name}] stored credentials can't be decrypted on this machine — re-save them in the account editor`);
          log(`❌ [${name}] not logged in and no usable credentials — flagging for manual login`);
          flag = 'needs_login'; noRetry = true;
          return { posted: 0, errors: 1, pendingApproval: 0, noRetry, flag, postedIds: [] };
        }
      }
    }

    // MOD: capture this account's FB DISPLAY NAME once (the author-match key the moderator uses to
    // recognise OUR held posts in the queue). Best-effort, non-blocking; on failure stay silent and
    // leave it empty (approval is fail-closed on an empty name — the operator can set it in the UI).
    // Mutates the in-memory account so THIS run's held records carry the name, and persists for next.
    if (!(account.fbDisplayName && String(account.fbDisplayName).trim())) { // ALWAYS capture: the comment author-gate (wrong-post guard) needs it, not just moderation
      try {
        const fbName = await evalTimed(page, () => {
          const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          // Reject UI chrome that loose selectors used to grab (e.g. "Share", "Home").
          const BAD = new Set(['share', 'home', 'menu', 'profile', 'profil', 'friends', 'amis', 'watch', 'video',
            'marketplace', 'groups', 'groupes', 'notifications', 'messenger', 'settings', 'paramètres', 'see more',
            'voir plus', 'like', 'comment', 'commenter', 'facebook', 'reels', 'pages', 'events']);
          const ok = (n) => n && n.length >= 2 && n.length <= 80 && !BAD.has(n.toLowerCase()) && /[a-zA-ZÀ-ɏ؀-ۿ]/.test(n) && !/^https?:/.test(n);
          // PRIMARY: FB embeds the logged-in viewer's full name in CurrentUserInitialData.NAME — the
          // authoritative source, and exactly the name shown as the post author in the moderation queue.
          try {
            const html = document.documentElement.innerHTML;
            const m = html.match(/CurrentUserInitialData"[\s\S]{0,400}?"NAME":"([^"]{2,80})"/) || html.match(/"USER":\{"[^}]*?"NAME":"([^"]{2,80})"/);
            if (m) { let n = clean(m[1]); try { n = JSON.parse('"' + n + '"'); } catch {} if (ok(n)) return n.slice(0, 80); }
          } catch {}
          // FALLBACK: an accessible profile link in the nav/left rail.
          for (const s of ['a[href*="/me/"][aria-label]', 'a[aria-current="page"][aria-label]', '[role="navigation"] a[aria-label]']) {
            const el = document.querySelector(s); const n = clean(el && el.getAttribute('aria-label'));
            if (ok(n)) return n.slice(0, 80);
          }
          return '';
        }, null, 6000).catch(() => '');
        if (fbName && fbName.length >= 2) {
          account.fbDisplayName = fbName;
          await store.update((d) => { const a = (d.accounts || []).find((x) => x.name === name); if (a && !(a.fbDisplayName && String(a.fbDisplayName).trim())) a.fbDisplayName = fbName; }).catch(() => {});
          log(`🪪 [${name}] captured FB display name: "${fbName}"`);
        } else { log(`🪪 [${name}] could not read FB display name — set it on the account card for moderator approval`); }
      } catch {}
    }

    // New-account WARM-UP (opt-in): before its first few posts, an account browses the feed like a
    // human (scroll + pauses) so it isn't a brand-new identity that ONLY ever opens group composers
    // and posts promos — a strong new-account spam signal.
    ranThisCycle = true; // past auth — this counts as a run for warm-up aging (bumped in finally on every exit path)
    if (settings.enableWarmup && priorRuns < (Number.isFinite(settings.warmupRuns) ? settings.warmupRuns : 5) && !shouldStop()) {
      log(`🌱 [${name}] warm-up (prior posting runs: ${priorRuns}) — browsing the feed + a group before posting`);
      try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
        await dismissPopups(page);
        // FORCE the human browse even under a fast/turbo global preset — warming is account-trust behavior,
        // not cosmetic pacing, so it must actually scroll/dwell (humanDwell self-skips when isFastMode).
        const warmSettings = { ...settings, humanizeMaster: true, speedMode: 'normal' };
        await humanDwell(page, shouldStop, warmSettings);
        await warmLikePosts(page, 1 + Math.floor(Math.random() * 2), shouldStop, log, name); // react to 1–2 home-feed posts (a real engagement fingerprint, not just scrolling)
        await humanDwell(page, shouldStop, warmSettings);
        // Also browse 1–2 of the account's OWN groups — builds a real engagement fingerprint on the groups FB
        // will see it post to (far better than home-feed-only scrolling). Best-effort; never blocks posting.
        const warmGroups = targetGroups.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(2, targetGroups.length));
        for (const g of warmGroups) {
          if (shouldStop()) break;
          try {
            await page.goto(`https://www.facebook.com/groups/${g.groupId || g.id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(1500 + Math.floor(Math.random() * 1500));
            await dismissPopups(page);
            await humanDwell(page, shouldStop, warmSettings);
            await warmLikePosts(page, 1, shouldStop, log, name); // react to a post in this group too — builds engagement where it'll post
          } catch {}
        }
      } catch (e) { log(`⚠️ [${name}] warm-up skipped (${e.message})`); }
    }

    // Resolve images once: local files, or download remote URLs to temp.
    const _srcImgPaths = (basePost.imagePaths && basePost.imagePaths.length ? basePost.imagePaths : (basePost.imagePath ? [basePost.imagePath] : []));
    let resolvedImages = _srcImgPaths.filter((p) => {
      const ok = p && fs.existsSync(p);
      if (p && !ok) log(`⚠️ [${name}] image file not found, dropping: ${p}`); // was SILENT for a MULTI-image post → it published fewer images than intended yet still reported fullyPosted → auto-delete could permanently lose the content
      return ok;
    });
    let droppedImage = _srcImgPaths.length > resolvedImages.length; // ≥1 intended local image was missing → publish the survivors, but keep the library post (fullyPosted=false blocks auto-delete so the operator can fix the asset + re-run)
    if (!resolvedImages.length && basePost.imageUrl) {
      const dl = await downloadImage(basePost.imageUrl, (m) => log(`[${name}] ${m}`));
      if (dl) { resolvedImages = [dl]; tempImages.push(dl); droppedImage = false; log(`⬇️ [${name}] image downloaded from URL`); } // the URL image fully satisfies the requirement (stale local paths + a working imageUrl) → the post is COMPLETE, clear droppedImage so auto-delete is allowed
      else log(`⚠️ [${name}] image URL set but download failed — posting without image`);
    }
    // Comment image: explicit comment image, remote URL, or the post image when commentWithImage is on.
    let commentImg = null;
    if (basePost.commentImagePath) {
      if (fs.existsSync(basePost.commentImagePath)) { commentImg = basePost.commentImagePath; log(`🖼 [${name}] comment image: uploaded file`); }
      else log(`⚠️ [${name}] comment image file not found (${basePost.commentImagePath}) — comment will have no image`);
    } else if (basePost.commentImageUrl) {
      const dl = await downloadImage(basePost.commentImageUrl, (m) => log(`[${name}] ${m}`));
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
    // Degenerate post: NO caption AND NO image — there's nothing to publish. Bail ONCE with a clear account-
    // level error instead of opening the composer N times and reporting a misleading "Post button not found"
    // per group.
    if (!resolvedImages.length && !((basePost.caption || '').trim())) {
      log(`❌ [${name}] this post has no caption AND no image — nothing to publish; skipping.`);
      report('', '', 'error', 'empty post — no caption and no image', '');
      return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: null, postedIds: [], dealtIds: [], fullyPosted: false, offline: false };
    }

    // Per-RUN salt for image variation: stable within this run (retries of a group reuse the same temp file,
    // no churn) but fresh each daily cycle — so a recurring campaign doesn't re-post the identical image hash
    // to the same group every day (a cross-cycle dedup signal).
    const runSalt = Date.now().toString(36);
    const groupRetries = {}; // E-P1: per-group transient-retry counter (max 1 retry, pre-publish only)
    let midRunLoginTried = false; // mid-run session-expiry: try credential auto-login ONCE per run, then give up
    let commentLimited = false; // COMMENT rate-limit hit this run → keep POSTING but route every link-comment to a reserve (Phase-3 rescue) instead of re-hitting the wall
    // ── PACED MULTI-TAB (opt-in: tabsPerBrowser 2..4) ─────────────────────────────────────────────────────────────
    // Pipelines the SLOW part: while a group is being posted, the NEXT group's page pre-loads in a background tab, so
    // navigation overlaps posting. Publishing stays SEQUENTIAL and paced (the inter-group gap is unchanged) → real
    // wall-clock speedup with NO extra posting velocity (ban-neutral) and EVERY double-post trap intact — we replace
    // ONLY the navigation step; the whole post/publish/comment flow below is untouched. tabsPerBrowser=1 → no prefetch
    // (byte-identical to before). New tabs inherit the account's proxy/auth/geo automatically (attachGeoToNewTargets).
    const _tabsWanted = Math.max(1, Math.min(4, parseInt(settings.tabsPerBrowser, 10) || 1));
    const _prefetch = new Map(); // groupIndex → Promise<{ entry, ok } | null>
    // Harden a pool tab EXACTLY like the main tab BEFORE it navigates: the per-document spoofs, its OWN CDP session,
    // off-screen parking (hidden) + focus emulation. Otherwise a swapped-in posting tab leaks the off-screen/unfocused
    // state, and the CDP paste + periodic re-park (which target a SESSION, not `page`) break once the original tab closes.
    // Returns the tab's cdp + windowId so the adopt step can rebind cdpSession/hiddenWindowId to the live tab. Done ONCE
    // per tab — evaluateOnNewDocument re-applies on every navigation, and the CDP session + off-screen window persist —
    // so a REUSED pool tab stays hardened without re-hardening.
    // Bind a fresh CDP session to a tab + off-screen park + focus emulation. Split out of _hardenTab so the adopt step
    // can RE-bind a session to an adopted tab whose original harden failed (cdp:null) — without re-registering the spoof.
    const _bindCdp = async (tab) => {
      let cdp = null, winId = null;
      try { cdp = await tab.target().createCDPSession(); } catch {}
      if (cdp) {
        if (hidden) { try { const { windowId } = await cdp.send('Browser.getWindowForTarget'); winId = windowId; await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: vp.width, height: vp.height } }); } catch {} }
        try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
      }
      return { cdp, winId };
    };
    const _hardenTab = async (tab) => {
      try { await tab.evaluateOnNewDocument(stealthSpoof, _scrX, _scrY, _acctHwc); } catch {}
      return _bindCdp(tab);
    };
    // ADR-0018 — PERSISTENT ROTATING TAB POOL. The old pipeline opened a FRESH tab per group and CLOSED it right after
    // adopting it (per-group churn: resets in-tab history/referrer continuity, and a constantly-churning set of FB tabs
    // is itself a weak automation signal). Instead we keep a small pool of up to tabsPerBrowser hardened tabs OPEN and
    // REUSE them by re-navigation: while posting group i on the active tab, an idle pool tab pre-loads group i+1; on
    // advance the pre-loaded tab becomes active and the just-finished tab returns to the pool (NOT closed) for a later
    // group. Bounded to <= tabsPerBrowser tabs; publishing stays sequential; a tab is recycled after _RECYCLE_EVERY
    // navigations to dodge Facebook SPA memory creep. Every double-post/comment trap is keyed by (post,gid) and the
    // target group is set by the pre-nav/goto before posting, so pool reuse cannot post to the wrong group or double-post.
    // With tabsPerBrowser=1 the pool is never grown or rotated (byte-identical to the pre-pool behaviour).
    const _RECYCLE_EVERY = 12;
    const _pool = { free: [], live: 1, activeNavs: 1, epoch: 0 }; // 'live' counts open tabs we own (starts at the main page); 'free' = idle reusable entries {tab,cdp,winId,navs}; 'epoch' bumps at each phase-boundary reset
    const _makeTab = async () => {
      try {
        const tab = await browser.newPage();
        const h = await _hardenTab(tab); // spoofs + own cdp + off-screen park BEFORE any FB nav (persists across re-nav)
        try { await applyProxyGeo(tab, account, settings, useProxies, proxies, () => {}); } catch {}
        return { tab, cdp: h.cdp, winId: h.winId, navs: 0 };
      } catch { return null; }
    };
    // Take an idle pool tab (recycling any past the nav ceiling), else grow the pool up to tabsPerBrowser, else null
    // (pool momentarily saturated → the caller falls back to navigating the active tab — graceful, never blocks).
    const _acquireTab = async () => {
      while (_pool.free.length) {
        const e = _pool.free.shift();
        if (!e || !e.tab) { _pool.live = Math.max(0, _pool.live - 1); continue; }
        if (e.navs >= _RECYCLE_EVERY) { try { e.tab.close().catch(() => {}); } catch {} _pool.live = Math.max(0, _pool.live - 1); continue; }
        return e;
      }
      if (_pool.live < _tabsWanted && browser && browser.isConnected()) { const e = await _makeTab(); if (e) { _pool.live++; return e; } }
      return null;
    };
    const _releaseTab = (e) => { if (e && e.tab) _pool.free.push(e); }; // return a tab to the pool for REUSE (never closed mid-run)
    const _prefetchGroup = (idx) => {
      if (_tabsWanted <= 1 || idx >= targetGroups.length || _prefetch.has(idx) || !browser || !browser.isConnected()) return;
      const gg = targetGroups[idx]; const gid2 = gg.groupId || gg.id;
      _prefetch.set(idx, (async () => {
        const e = await _acquireTab();
        if (!e) return null; // pool saturated → group i will navigate on the active tab instead
        e.navs++;
        const ok = await e.tab.goto(`https://www.facebook.com/groups/${gid2}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => true).catch(() => false);
        return { entry: e, ok };
      })().catch(() => null));
    };
    const _dropPrefetch = (idx) => { const p = _prefetch.get(idx); if (!p) return; _prefetch.delete(idx); const ep = _pool.epoch; p.then((x) => { if (!x || !x.entry) return; if (_pool.epoch !== ep) { try { if (x.entry.tab) x.entry.tab.close().catch(() => {}); } catch {} } else _releaseTab(x.entry); }).catch(() => {}); }; // don't need this group's tab → reuse it; but if a phase boundary passed while its nav was still in-flight, CLOSE it instead so a stale-phase tab can't leak into the next pool
    const _closePrefetch = () => { for (const e of _pool.free) { try { if (e && e.tab) e.tab.close().catch(() => {}); } catch {} } _pool.free.length = 0; for (const p of _prefetch.values()) p.then((x) => { if (x && x.entry && x.entry.tab) x.entry.tab.close().catch(() => {}); }).catch(() => {}); _prefetch.clear(); _pool.live = 1; _pool.activeNavs = 0; _pool.epoch++; }; // phase/account end: close idle + in-flight tabs (the active page is torn down with the browser); reset accounting + bump epoch so a following phase re-grows the pool cleanly
    // TWO-PHASE posting (opt-in): when on, the per-group loop below POSTS every group but DEFERS each post's comment
    // into _deferredComments; a second pass (after the loop) places them all. The post is already published +
    // markDelivered'd BEFORE the comment step, so deferring the comment changes NOTHING about double-post safety.
    const _twoPhase = !!settings.postThenComment;
    const _deferredComments = [];
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
      // No-double-post net: if THIS post already reached THIS group this cycle (e.g. the dropped account posted it
      // here before it fell over, and we're the reserve covering its un-reached groups), SKIP — never re-post a group.
      // Placed before any navigation so a skip costs nothing. Only ever fires in deal-once modes / stand-ins.
      if (alreadyDelivered(gid)) { _dropPrefetch(i); step('↩️ this post already reached this group this cycle — skipping (no double-post)'); report(groupName, gid, 'skipped', 'already delivered this cycle', ''); continue; }
      // Per-group content variation: expand {a|b|c} spintax so THIS group gets a different caption
      // and comment than the others, and give any link in the comment a unique tracking param. This
      // is the #1 fix for "identical content to many groups" — FB's strongest content-spam signal.
      let captionText = basePost.caption || '', commentText = basePost.comment || '';
      if (settings.varyContent !== false) { captionText = spintax.expand(captionText); commentText = spintax.expand(commentText); }
      // Vary links in BOTH the caption and the comment (distinct seeds) — a link in the CAPTION was previously
      // posted byte-identical to every group/account, the exact cross-post dedup signal varyLinks defeats.
      if (settings.randomizeLinks !== false) { captionText = varyLinks(captionText, `${name}|${gid}|cap`); commentText = varyLinks(commentText, `${name}|${gid}`); }
      // A spintax template with an EMPTY option (e.g. "{صباح الخير|}") can expand to '' for THIS group. Re-roll a few
      // times to recover a non-empty variant (the post is rebuilt from the final text below).
      if (settings.varyContent !== false && !String(captionText).trim() && spintax.hasSpintax(basePost.caption || '')) {
        for (let _rr = 0; _rr < 4 && !String(captionText).trim(); _rr++) { captionText = spintax.expand(basePost.caption || ''); if (settings.randomizeLinks !== false) captionText = varyLinks(captionText, `${name}|${gid}|cap|r${_rr}`); }
      }
      const post = { ...basePost, caption: captionText, comment: commentText };
      let groupImages = resolvedImages, groupCommentImg = commentImg; // per-group (optionally perturbed) images
      // If the caption STILL expanded to empty AND there's no image, this group can't get a valid post → skip with an
      // ACCURATE reason (a caption-template config issue) instead of opening an EMPTY composer — which would leave Post
      // disabled, fail clickPostButton, and wrongly trip the "unsupported UI language" heuristic → stop a HEALTHY account.
      if (!String(captionText).trim() && !((resolvedImages || []).length)) {
        _dropPrefetch(i);
        step('⚠️ Caption expanded to EMPTY for this group (a spintax "{…|}" branch with an empty option) and there is no image — skipping this group. Remove the empty option from your caption template.');
        errors++; report(groupName, gid, 'error', 'caption expanded to empty (fix the caption template — an empty "{…|}" option)', '');
        continue;
      }
      try {
        step(`Navigate to group (${i + 1}/${targetGroups.length})`);
        let navOk = false;
        // PACED MULTI-TAB: adopt the tab that pre-loaded this group during the previous group's posting (skips the slow
        // nav). Everything after this runs on `page` unchanged. Falls back to a normal navigation if the prefetch is
        // missing/failed. Only the navigation is pipelined — publishing stays sequential + paced.
        if (_prefetch.has(i)) {
          const pre = await _prefetch.get(i); _prefetch.delete(i);
          if (pre && pre.entry && pre.ok) {
            // ROTATE (ADR-0018): the just-finished active tab returns to the pool for REUSE (not closed); the pre-loaded
            // tab becomes active. Rebind cdpSession + windowId to it (its OWN, made in _hardenTab) so the CDP paste +
            // off-screen re-park keep working. Identical control flow to the old churn adopt, minus the _old.close().
            _releaseTab({ tab: page, cdp: cdpSession, winId: hiddenWindowId, navs: _pool.activeNavs });
            page = pre.entry.tab;
            // Rebind cdpSession + hiddenWindowId to the ADOPTED tab. If the prefetch tab never got its own CDP session
            // (_hardenTab's createCDPSession failed → cdp:null), bind one NOW — never leave cdpSession pointing at the
            // just-released old tab, or the caption CDP-paste would land in that (pooled) tab and the off-screen re-park
            // would target the wrong window. If binding still fails, cdpSession becomes null → enterCaptionOnce's
            // `if (!cdpSession)` forces the execCommand-on-`page` fallback into the ACTIVE tab (never a stale insert).
            if (pre.entry.cdp) { cdpSession = pre.entry.cdp; if (pre.entry.winId != null) hiddenWindowId = pre.entry.winId; }
            else { const _rb = await _bindCdp(pre.entry.tab); cdpSession = _rb.cdp; if (_rb.winId != null) hiddenWindowId = _rb.winId; pre.entry.cdp = _rb.cdp; pre.entry.winId = _rb.winId; }
            _pool.activeNavs = pre.entry.navs;
            navOk = true; step('Group pre-loaded (pipelined, pooled)');
          } else if (pre && pre.entry) { _releaseTab(pre.entry); } // nav failed but the tab is fine → back to the pool; fall through to nav the active tab
        }
        const gotoGroup = () => page.goto(`https://www.facebook.com/groups/${gid}`, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => { _pool.activeNavs++; return true; }).catch(() => false);
        if (!navOk) navOk = await gotoGroup();
        // Up to 3 nav attempts (was 2) with growing backoff — a slow-proxy nav timeout is a recoverable "small error",
        // and skipping the group here permanently misses that (post,group) in campaign-plan. Still offline-aware: if the
        // link is actually down we bail immediately (no burning 90s timeouts) so the orchestrator can hold for reconnect.
        for (let navAtt = 0; !navOk && navAtt < 2 && !shouldStop(); navAtt++) {
          if (typeof isOnline === 'function' && !(await isOnline())) {
            step('🌐 Offline — pausing this account; the run resumes when the connection returns');
            offline = true; break;
          }
          step(`Navigation attempt failed; retrying (${navAtt + 1}/2)`); await sleepInterruptible(3000 + navAtt * 2500, shouldStop); navOk = await gotoGroup();
        }
        if (offline) break;
        if (!navOk) { step('Navigation failed; skipping group'); errors++; report(groupName, gid, 'error', 'navigation failed', ''); continue; }
        for (let k = 1; k < _tabsWanted; k++) _prefetchGroup(i + k); // paced multi-tab: pre-load the next group(s) DURING this group's posting so their nav overlaps (no-op when tabsPerBrowser=1)
        await sleep(settings.speedMode === 'instant' ? jitter(400, 0.3) : isFastMode(settings) ? jitter(500, 0.3) : jitter(1500, 0.3)); // post-nav settle (OVERHEAD, not an anti-spam gap — the inter-group gap is applied at loop end): gotoGroup already resolved on domcontentloaded and the auth/rate-limit checks below re-read the live DOM with their own waits; keep ~500ms React-hydration margin (fast trimmed 1000→500; instant already 400; normal 1500) so the auth read doesn't false-flag on a bare pre-paint body

        // Per-group START banner — fired only after nav succeeds and before the auth checks.
        step('Group loaded');

        // Identity / "confirm you're a real person" checkpoint — flag distinctly so the
        // operator knows to VERIFY this account (re-login won't fix it).
        if (await checkVerification(page)) { step('🔐 Facebook wants identity/human verification — flagging account'); errors++; noRetry = true; flag = 'needs_verification'; report(groupName, gid, 'error', 'identity verification required', ''); break; }

        // Detect a logged-out / expired / disabled state. A /login redirect OR a "Continue as <name>" picker /
        // "Join Group + Log in" wall all mean the session lapsed. (Disabled/restricted needs a human.)
        const loginRedirect = /^https?:\/\/[^/]*\/login/.test(page.url());
        const authBad = loginRedirect ? 'session-expired' : await page.evaluate(() => {
          const t = document.body.innerText || '';
          // LOCALE-INDEPENDENT logged-out tell. The English-only button checks below MISS a non-English login wall —
          // a French "Se connecter" wall on a group preview was being mis-diagnosed as composer "selector drift",
          // making the account burn every group with "composer did not open" (0 posted). A real login FORM
          // (email+password) on a GROUP page, or a QR-login / "forgotten account / forgotten password" prompt, only
          // appear once the session lapsed and Facebook serves the public group preview behind a login wall.
          const _norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          const _e = document.querySelector('input[name="email"], #email'), _p = document.querySelector('input[name="pass"], #pass');
          const _r = _e && _e.getBoundingClientRect();
          const _loginFormVisible = !!(_e && _p && _r && _r.width > 0 && _r.height > 0); // VISIBLE form only — a hidden pre-rendered form on a logged-in page must not false-flag
          // Form-less wall: require BOTH a multi-locale "Log in" control AND a login-page tell (forgotten/QR/create
          // account), scanning ONLY buttons/links/headings (NOT post body text, so a post that merely mentions
          // "forgotten password" can't false-flag a logged-in account).
          const _ui = Array.from(document.querySelectorAll('[role="button"],a,button,h1,h2')).map((e) => _norm(e.textContent));
          const _hasLoginBtn = _ui.some((b) => /^(log ?in|log into facebook|se connecter|connectez-vous|connecte-toi|iniciar sesion|inicia sesion|anmelden|accedi|entrar)$/.test(b));
          const _hasLoginTell = _ui.some((b) => /forgotten|compte oubli|mot de passe oubli|code qr|qr code|create new account|creer un compte|crea una cuenta|criar conta|konto erstellen/.test(b));
          if (_loginFormVisible || (_hasLoginBtn && _hasLoginTell)) return 'session-expired';
          const hasBtn = (re) => Array.from(document.querySelectorAll('[role="button"],span,a,button')).some((e) => re.test((e.textContent || '').trim()));
          if (/your account has been disabled|we suspended your account|your account is restricted|confirm your identity/i.test(t)) return 'account-disabled';
          if (/continue as|use another profile/i.test(t)) return 'session-expired';
          if (hasBtn(/^join group$/i) && hasBtn(/^log in$/i)) return 'not-authenticated';
          return null;
        });
        if (authBad === 'account-disabled') { step('🚫 Account disabled/restricted by Facebook — needs manual attention'); errors++; noRetry = true; flag = 'account_disabled'; report(groupName, gid, 'error', 'account disabled/restricted', ''); break; }
        if (authBad) {
          // MID-RUN AUTO-LOGIN: the session lapsed during the run. Try stored credentials ONCE, re-navigate to
          // this group, and continue — so a mid-run logout doesn't abandon the account (and stall the run).
          let recovered = false;
          if (!midRunLoginTried) {
            midRunLoginTried = true;
            const ce = secret.decrypt(account.email), cp = secret.decrypt(account.password);
            if (ce && cp) {
              step('Session expired mid-run — auto-login with stored credentials...');
              const cr = await credentialLogin(page, ce, cp, log, name);
              if (cr === 'checkpoint') { step('🔐 verification needed — flagging account'); errors++; noRetry = true; flag = 'needs_verification'; report(groupName, gid, 'error', 'identity verification required', ''); break; }
              if (cr === true && await gotoGroup()) {
                await sleep(2500);
                const stillBad = await withTimeout(page.evaluate(() => /login|checkpoint/.test(location.href) || /continue as|use another profile/i.test(document.body.innerText || '')), 8000, true).catch(() => true);
                if (!stillBad) { step('✅ re-logged in mid-run — continuing this group'); recovered = true; }
              }
            }
          }
          if (!recovered) { step(authBad === 'session-expired' ? 'Session expired - re-login required' : 'Not logged in / not a member'); errors++; noRetry = true; flag = 'needs_login'; report(groupName, gid, 'error', authBad, ''); break; }
        }

        // Clear cookie/notification banners, then bail out of this account if rate-limited.
        await dismissPopups(page);
        { const _rl = await classifyRateLimit(page); if (_rl) { const _k = _rl === 'severe' ? 'account' : 'post'; step(_k === 'account' ? '🛑 Facebook TEMPORARILY BLOCKED this account — stopping it (long cooldown)' : '🛑 Posting rate-limited by Facebook — cooling this account down'); errors++; noRetry = true; flag = 'rate_limited'; rlKind = _k; report(groupName, gid, 'error', _k === 'account' ? 'account temporarily blocked' : 'posting rate-limited', ''); break; } }

        // Dwell like a human reading the group feed (mouse drift + a few scrolls with pauses)
        // before composing, instead of opening the composer instantly on every visit (a bot tell).
        await humanDwell(page, shouldStop, settings);

        // Open the composer and CONFIRM the dialog actually opened (the FB trigger has
        // no aria-label — match the placeholder text — and the click must be verified).
        const opened = await openComposer(page, step, name, settings);
        if (!opened) {
          // An account-level block can be WHY the composer won't open — confirm it and skip the
          // WHOLE account immediately rather than trying every remaining group.
          { const _rl = await classifyRateLimit(page); if (_rl) { const _k = _rl === 'severe' ? 'account' : 'post'; step(_k === 'account' ? '🛑 Facebook TEMPORARILY BLOCKED this account (composer) — stopping it (long cooldown)' : '🛑 Posting rate-limited by Facebook (composer blocked) — cooling this account down'); errors++; noRetry = true; flag = 'rate_limited'; rlKind = _k; report(groupName, gid, 'error', _k === 'account' ? 'account temporarily blocked' : 'rate-limited — composer blocked', ''); break; } }
          if (await checkVerification(page)) { step('🔐 Facebook wants identity/human verification — skipping this account immediately'); errors++; noRetry = true; flag = 'needs_verification'; report(groupName, gid, 'error', 'identity verification required', ''); break; }
          // LATE AUTH RE-CHECK: the per-group authBad probe runs ~6-7s after nav, but a silently-expired session's
          // FB login wall (esp. the FR "Se connecter / code QR / Informations de compte oubliées") hydrates a few
          // seconds LATER — after openComposer already failed. Re-test HERE so a logout isn't mislabeled "SELECTOR
          // DRIFT / composer did not open" (which wrongly errors the group instead of re-logging in).
          const lateAuthBad = await withTimeout(page.evaluate(() => {
            if (/login|checkpoint/.test(location.href)) return true;
            const t = (document.body.innerText || '').toLowerCase();
            return /continue as|use another profile|log in to facebook|connecter avec un code qr|informations de compte oubli/.test(t);
          }), 8000, false).catch(() => false);
          if (lateAuthBad) {
            let recovered = false;
            if (!midRunLoginTried) {
              midRunLoginTried = true;
              const ce = secret.decrypt(account.email), cp = secret.decrypt(account.password);
              if (ce && cp) {
                step('Composer never opened — the session had actually expired (login wall hydrated late) — auto-login with stored credentials...');
                const cr = await credentialLogin(page, ce, cp, log, name);
                if (cr === 'checkpoint') { step('🔐 verification needed — flagging account'); errors++; noRetry = true; flag = 'needs_verification'; report(groupName, gid, 'error', 'identity verification required', ''); break; }
                if (cr === true && await gotoGroup()) { await sleep(2500); recovered = true; }
              }
            }
            if (!recovered) { step('Session expired (login wall appeared after the composer step) — re-login required'); errors++; noRetry = true; flag = 'needs_login'; report(groupName, gid, 'error', 'session-expired', ''); break; }
            step('✅ re-logged in mid-run — resuming on the next group'); continue; // skip this group; the next one reuses the restored session
          }
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
        await sleep(settings.speedMode === 'instant' ? jitter(200, 0.3) : isFastMode(settings) ? jitter(500, 0.3) : jitter(1500, 0.3)); // post-composer-open settle (the composer is already CONFIRMED open by the waitForSelector above) — trimmed for the fast tiers
        await dismissPopups(page);
        // Drift guard: if a popup-dismiss click followed a link, or FB redirected to the home feed / login,
        // we must NOT compose+publish here (it would post to the wrong place / the user's own feed). We check
        // we're still in the /groups/ section (tolerant of vanity-vs-numeric group URLs), not the exact id.
        if (!/\/groups\//.test(String(page.url()))) {
          step(`Page drifted off the group (now ${String(page.url()).slice(0, 80)}) — skipping to avoid posting to the wrong place`);
          errors++; report(groupName, gid, 'error', 'page drifted off the group before posting', ''); continue;
        }
        step('Composer opened; preparing post');

        // Perturb the image per (account, group) so the SAME picture doesn't upload with an
        // IDENTICAL perceptual hash to every group — FB dedups images across groups, a strong
        // spam signal. Visually identical; best-effort (falls back to the original if jimp is off).
        if (settings.varyImages !== false && imageVary.available() && resolvedImages.length) {
          const vi = []; let _anyVaried = false;
          for (const im of resolvedImages) {
            const v = await imageVary.varyImage(im, `${name}|${gid}|${im}|${runSalt}`);
            if (v) { vi.push(v); tempImages.push(v); _anyVaried = true; } else vi.push(im);
          }
          groupImages = vi;
          if (groupCommentImg) { const cv = await imageVary.varyImage(groupCommentImg, `${name}|${gid}|c|${groupCommentImg}|${runSalt}`); if (cv) { groupCommentImg = cv; tempImages.push(cv); _anyVaried = true; } }
          // Truthful log: varyImage returns null for a format jimp can't read (notably WEBP) → the ORIGINAL uploads,
          // identically to every group (image-dedup risk). Say so instead of a misleading "Image varied".
          step(_anyVaried ? 'Image varied (unique hash for this group)' : '⚠️ Image NOT varied (jimp can\'t read this format, e.g. webp) — uploading the ORIGINAL, which is identical for every group (image-dedup risk). Use JPG/PNG for per-group variation.');
        }

        // CAPTION single-entry helper — declared at composer scope so BOTH the caption-first entry AND the post-image
        // survival re-entry can call it. ONE CDP insertText into a known-EMPTY editor (cleared first → can't append to
        // a persisted draft) lands first try; the caller does at most ONE clean re-entry on a genuinely-empty miss —
        // never the old 3× repaste loop, never a slow retype after a paste. FAST/TURBO/INSTANT paste (Input.insertText
        // targets the focused editor, no OS clipboard → race-free across parallel accounts); NORMAL/SAFE human-TYPE
        // (a real person — anti-bot for cold accounts).
        const enterCaptionOnce = async (settleMs) => {
          await focusEditable(page);  // focus + MARK the exact editor (data-zp-editor)
          await clearEditable(page);  // GUARANTEE empty first → entry can never append to / double a persisted draft
          await focusEditable(page);  // re-focus: clearEditable's execCommand('delete') can re-mount Lexical + drop focus (insertText targets the ACTIVE element)
          if (isFastMode(settings)) {
            await sleep(settleMs);
            try { if (!cdpSession) throw new Error('no cdp session'); await cdpSession.send('Input.insertText', { text: String(post.caption) }); }
            catch { try { await page.evaluate((t) => { const el = document.querySelector('[data-zp-editor="1"]') || document.activeElement; if (el) { el.focus(); document.execCommand('insertText', false, t); } }, post.caption); } catch {} }
            await sleep(settings.speedMode === 'instant' ? 60 : 300); // let FB's React commit the inserted text before we read it (instant 120→60ms — verifyCaptionLanded polls at 150ms right after, so an under-committed read just re-polls, never mis-verifies)
            return verifyCaptionLanded(page, post.caption, settings.speedMode === 'instant' ? 1000 : 3000);
          }
          await humanType(page, post.caption, settings);
          return verifyCaptionLanded(page, post.caption, 3000);
        };

        // ── CAPTION vs IMAGE ORDER ──────────────────────────────────────────────────────────────────────────
        // NORMAL/SAFE (human TYPE) + ANY text-only post → caption FIRST: the composer's Lexical editor opens freshly
        // mounted/empty (the cleanest state) and typing before the image reads like a person. But a FAST/PASTE mode
        // WITH an image is different: attaching the image re-mounts the editor and reliably CLEARS a pre-pasted caption
        // (the operator saw it "retype every time"), so entering it first is pure waste. In THAT case we attach the
        // IMAGE FIRST, wait for the preview to CONFIRM the editor re-mounted, then paste the caption ONCE below (with a
        // retry). Pasting after a CONFIRMED re-mount + a re-focus is exactly what the old naive image-first lacked
        // (→ its ~88% stale-box miss) — so this is image-first done the reliable way, not the old broken way.
        const _captionAfterImage = isFastMode(settings) && groupImages.length && !!(post.caption && String(post.caption).trim());
        if (post.caption && !_captionAfterImage) {
          step(isFastMode(settings) ? 'Inserting caption' : 'Typing caption');
          let landed = await enterCaptionOnce(settings.speedMode === 'instant' ? 80 : 300);
          if (!landed.landed) {
            const len = await editableLen(page);
            if (len > 0) {
              // Text IS present, textContent just couldn't be prefix-matched (emoji / FB normalization / off-screen
              // read). Re-entering is exactly what historically doubled it → ACCEPT; the publish-confirm is the final check.
              step(`Caption present (${len} chars) but not text-verified — accepting (no re-entry → no double)`);
              landed = { landed: true, len };
            } else {
              step('Caption did not take — one clean re-entry'); // genuinely empty → ONE re-entry (clears first → can't double)
              landed = await enterCaptionOnce(settings.speedMode === 'instant' ? 240 : 500);
            }
          }
          step(landed.landed ? `Caption entered (${landed.len} chars) ✅`
            : `Caption entered but not directly readable (${landed.len} chars) — survival + publish checks will verify`);
        }

        // ── IMAGE (attached AFTER the caption) ──────────────────────────────────────────────────────────────
        if (groupImages.length) {
          step(`Uploading ${groupImages.length} image(s)`);
          const input = (await page.$('div[role="dialog"] input[type="file"]')) || (await page.$(SEL.fileInput));
          if (!input) {
            // The post is meant to carry an image — never publish it image-less. Skip the group (un-dealt, retried next cycle).
            step('Image input not found in composer — skipping group to avoid an image-less post');
            errors++; report(groupName, gid, 'error', 'image input not found in composer', ''); continue;
          }
          // Retry the upload (a stalled CDP file transfer / slow disk is often transient) with a per-attempt timeout.
          const up = await retryAsync(() => input.uploadFile(...groupImages), {
            attempts: 3, timeoutMs: 30000, baseDelayMs: 1500, label: 'image upload',
            onAttempt: (a, n, e) => step(`Image upload attempt ${a}/${n} failed (${e.message})${a < n ? ' — retrying' : ''}`),
          });
          // Retries exhausted → do NOT click Post (image-less = silent data loss). Throw TRANSIENT → the pre-publish
          // retry gate re-attempts the group THIS cycle (publishClicked still false → re-running re-opens a FRESH
          // composer and re-enters the caption from scratch → double-post-safe AND no double-caption).
          if (!up.ok) throw new Error('transient: image upload failed after retries');
          // Verify FB actually ATTACHED the image (uploadFile only resolves the CDP transfer; FB can silently reject it
          // and every downstream publish check matches caption text only). Verify ALL N previews, not just one.
          const _imgN = groupImages.length;
          const imgPreviewed = await page.waitForFunction(
            (n) => {
              // Count blob previews / per-image Remove controls INSIDE composer dialogs; if there is NO dialog the
              // composer rendered INLINE (the file-input find above already has a document-wide fallback, so the upload
              // can succeed while a dialog-ONLY check false-fails → a needless 3× retry then group skip). Sum across
              // ALL dialogs (a stray notification dialog can be first). Remove label is multi-locale (EN + FR).
              const REM = '[aria-label*="Remove" i], [aria-label*="Supprimer" i], [aria-label*="Retirer" i], [aria-label*="Enlever" i]';
              const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
              let blobs = 0, removes = 0;
              if (dialogs.length) { for (const d of dialogs) { blobs += d.querySelectorAll('img[src^="blob:"]').length; removes += d.querySelectorAll(REM).length; } }
              else { blobs = document.querySelectorAll('img[src^="blob:"]').length; removes = document.querySelectorAll(REM).length; }
              return blobs >= n || removes >= n;
            },
            { timeout: 20000 }, _imgN
          ).then(() => true).catch(() => false);
          if (!imgPreviewed) {
            step(`Image preview shows fewer than the ${_imgN} uploaded image(s) — re-attempting the group to avoid a deficient/image-less post`);
            throw new Error('transient: image attach not confirmed (preview count < N)');
          }
          step(`Image attached (${_imgN} preview${_imgN > 1 ? 's' : ''} rendered)`);
          // SURVIVAL: attaching media re-mounts the Lexical editor; on some FB builds it can briefly drop the caption.
          // Re-read ONCE (a tiny settle first so a MID-re-mount editor isn't misread as empty — kept even at instant so
          // the survival read is reliable, C-4) and re-enter ONLY if genuinely empty. Invisible — not the retype churn.
          if (post.caption && String(post.caption).trim()) {
            // The image re-mount + a slow proxy's React commit make the caption LAND but render/read late. So VERIFY
            // PATIENTLY, and only CLEAR + re-paste when the editor is GENUINELY empty — NEVER wipe a caption that is
            // present-but-still-rendering. That destructive re-clear was the "retype N× then skip" the operator saw even
            // though the first paste was fine. Each enterCaptionOnce clears-first, so a real re-paste can't double.
            step(_captionAfterImage ? 'Pasting caption (after image)' : 'Ensuring caption survived the image attach');
            // IMAGE-FIRST path: the caption was NEVER entered before the image, so enter it ONCE now. This also MARKS the
            // exact composer editor (data-zp-editor), so the survival verify + the caption-less guard below read THAT
            // element. Without this seed the loop's first verifyCaptionLanded runs with NO marked editor and can satisfy
            // its length-only fallback off a STRAY editable (an open Messenger draft, the background feed composer) →
            // falsely "landed" → the loop breaks without ever typing our caption → an image-only post publishes and
            // counts as success (silent caption drop). Idempotent: enterCaptionOnce clears-first, so it can't double.
            const _capSeed = _captionAfterImage ? await enterCaptionOnce(settings.speedMode === 'instant' ? 250 : 400) : null; // enterCaptionOnce ends by returning verifyCaptionLanded — capture it to skip a duplicate first poll below
            const _capDeadline = Date.now() + (isFastMode(settings) ? 9000 : 11000);
            let _capOk = false, _stale = 0;
            while (!_capOk && Date.now() < _capDeadline && !shouldStop()) {
              // Reuse the seed's verify ONLY when it already reports landed=true — that's DEFINITIVE (the caption IS present on
              // the same unmutated editor, so the loop's first patient read would land too), skipping a redundant ~1.5s poll.
              // A NOT-landed seed is NOT reused (its internal timeout 1000/3000 ≠ this loop's 1500/2500) → fall through to the
              // full patient verify so a slow-rendering caption still gets its longer read — no premature re-paste.
              const _v = (_capSeed && _capSeed.landed) ? _capSeed : await verifyCaptionLanded(page, post.caption, isFastMode(settings) ? 1500 : 2500); // patient read (slow renders lag)
              if (_v.landed) { _capOk = true; break; }
              if ((await editableLen(page)) === 0) { await enterCaptionOnce(settings.speedMode === 'instant' ? 250 : 400); _stale = 0; } // truly empty → (re)paste
              else if (++_stale >= 2) { await enterCaptionOnce(settings.speedMode === 'instant' ? 250 : 400); _stale = 0; } // text present but NOT our caption after 2 patient checks → a persisted FB DRAFT (not our caption still rendering) → enterCaptionOnce CLEARS-first then re-enters OURS. Without this the editor keeps the draft, the final editableLen>0 guard passes, and we PUBLISH THE DRAFT (wrong caption). Re-pasting our own slow-rendering caption is idempotent, so a false trigger is harmless.
              else await sleepInterruptible(settings.speedMode === 'instant' ? 300 : 400, shouldStop); // maybe still rendering → one more patient check before deciding it's a draft
            }
            step(_capOk ? 'Caption present ✅' : 'Caption not confirmed after retries — will re-attempt the group');
          }
        }

        // FINAL caption-less guard — never publish an image-only post when a caption was intended (an attached image
        // alone enables FB's Post button, so an empty caption would publish image-only and count as success). Only
        // when there ARE images (a text-only empty composer keeps Post disabled anyway). publishClicked still false →
        // the transient throw routes to the pre-publish i-- retry (re-opens a fresh composer; no double-post).
        if (post.caption && String(post.caption).trim() && groupImages.length && (await editableLen(page)) === 0) {
          step('Caption never landed in the composer — re-attempting the group to avoid a caption-less post');
          throw new Error('transient: caption did not land (editor empty)');
        }

        // Publish — then CONFIRM it actually published (dialog closed / Post button gone).
        // Variable human "re-read before posting" pause (2-8s), not a fixed 1.5s on every post.
        // humanizeMaster off / fast speed → skip the dwell (deterministic). Pause/disable honored mid-dwell.
        const _ppDwell = isFastMode(settings) ? 0 : rangeMs(settings, 'prePublishDwellSecMin', 'prePublishDwellSecMax', 3, 8, 2);
        await sleepInterruptible(_ppDwell, softStop, 500, isPaused, pauseHold); // T1: randomized "re-read before posting"
        step('Waiting for Post button to enable');
        // FUNCTIONAL WAIT: after a paste (instant/fast mode) the Post button stays aria-disabled while
        // FB's React composer validates the content — clicking while disabled returns null from
        // clickPostButton and falsely skips the group as "post button not found". Poll until the button
        // is actually enabled (aria-disabled removed), or fall through after 8s (selector drift / no dialog).
        // This is NOT a cosmetic/anti-spam gap — it is the gate that prevents clicking a disabled button.
        await page.waitForFunction((labels) => {
          const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
          const scope = dialogs.length ? dialogs : [document];
          for (const root of scope) {
            const btn = Array.from(root.querySelectorAll('[role="button"], button')).find((b) =>
              b.getAttribute('aria-disabled') !== 'true' && !b.disabled && labels.includes(norm(b.getAttribute('aria-label') || b.textContent)));
            if (btn) return true;
          }
          return false;
        }, { timeout: 8000, polling: 200 }, FB.postButton).catch(() => {}); // swallow timeout — clickPostButton will report 'not found' with diagnostics
        const dialogCountBefore = await withTimeout(page.evaluate(() => Array.from(document.querySelectorAll('div[role="dialog"]')).filter((d) => d.querySelector('[contenteditable="true"], input[type="file"], [role="textbox"]')).length), 8000, 1).catch(() => 1);
        // Diagnostic Post-button scan (dialogs open, found label + drift breadcrumb) — a REDUNDANT 3rd scan of what the
        // waitForFunction gate above already gated and clickPostButton below re-scans; it gates nothing (only logs). SKIP
        // it in INSTANT (fire-fast) — the `if (postBtnInfo)` guard below no-ops on null; slow modes keep the diagnostic.
        const postBtnInfo = settings.speedMode === 'instant' ? null : await page.evaluate((labels) => {
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
        // Arm the publish-response capture RIGHT BEFORE the click (so we don't miss the create-story mutation's
        // response) — only for a two-phase comment post (that's the sole consumer of the captured link) and only
        // when the operator enabled it. See armPostIdCapture: the id is a candidate, re-verified before commenting.
        let _netPost = null;
        const _armNet = !!(settings.capturePostLinkFromNetwork && _twoPhase && ((post.comment && post.comment.trim()) || groupCommentImg));
        const _netCapture = _armNet ? armPostIdCapture(page, gid) : null;
        const clicked = await clickPostButton(page);
        if (!clicked) {
          if (_netCapture) _netCapture.dispose();
          // TWO IN A ROW = the composer opened but the submit button matched NO known label → this account's FB UI is
          // almost certainly in an UNSUPPORTED LANGUAGE (e.g. Arabic not in FB.postButton). A single miss can be a slow
          // render (the transient-retry path recovers it), but a genuine can't-find every group would SILENTLY deliver
          // ZERO posts with no reserve coverage (a plain skip isn't a drop flag). Flag it so (a) the operator is told to
          // set it to English, and (b) reserves cover its groups instead of the whole account posting nothing.
          if (++consecNoPostBtn >= 2) {
            step('🛑 Post button not found on 2 groups in a row — this account\'s Facebook is likely in a language the app doesn\'t recognize (set it to English). Stopping it so reserves cover its groups.');
            errors++; noRetry = true; flag = 'likely_blocked';
            report(groupName, gid, 'error', 'post button not found (unsupported UI language? set the account to English)', '');
            break;
          }
          step('Post button not found; skipping group'); errors++; report(groupName, gid, 'error', 'post button not found', ''); continue;
        }
        // E-P1: set ONLY after the click actually fired (clickPostButton returns true post-mouse-click). If it
        // had thrown BEFORE clicking (e.g. mouse-move on a dead page), no click went out → a retry is safe.
        publishClicked = true; // from here this group must NOT be retried (would double-post)
        consecNoPostBtn = 0;   // a successful click clears the "unsupported-language" streak
        step('Post button clicked');
        let publishResult = await waitForPublish(page, dialogCountBefore, 70000, shouldStop, settings.speedMode === 'instant'); // 70s CEILING kept (a slow/hidden/proxied window can take 35-45s+; too-short → false "timeout" → re-post → duplicate); instant only tightens the POLL granularity
        if (_netCapture) {
          // The create-story mutation's response usually landed by the time the composer closed; give it a brief
          // grace (~1.8s max) only if it hasn't — normally get() is already set so this returns instantly.
          for (let i = 0; i < 12 && !_netCapture.get(); i++) await sleep(150);
          _netPost = _netCapture.get();
          _netCapture.dispose();
          if (_netPost) step(`🔗 Captured the post's link from Facebook's publish response (id=${_netPost.postId}) — the feed re-scan can be skipped`);
        }
        if (publishResult === 'stopped') {
          // Stop hit DURING the publish wait — the Post button was ALREADY clicked (publishClicked), so the
          // post most likely went out. COUNT it so the orchestrator marks it dealt; a bare break would leave
          // it un-dealt → re-posted on the next Start = a visible DUPLICATE. (Missing one post on a manual
          // Stop is far better than duplicating one.)
          if (publishClicked) { posted++; markDelivered(gid); report(groupName, gid, 'posted', 'stopped mid-publish — counted to avoid a duplicate next run', ''); }
          step('Stop requested during publish wait — halting'); break;
        }
        if (publishResult === 'timeout') {
          // E-P5/E-P11: a genuine publish can take 35-40s on a slow connection or a hidden/occluded
          // window and trip the wait. Do a READ-ONLY feed rescan (NEVER re-click Post — that would
          // double-post): if OUR caption is already in the feed, the post landed → treat as published.
          const _landSnip = (post.caption || '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().slice(0, 40);
          // (a) Cheap, caption-independent: did the composer dialog CLOSE just after the wait expired? That's
          // a published signal that works for SHORT/no-caption posts too (the caption rescan below can't help
          // them) — without it a slow-publish short-caption post is a FALSE failure → re-posted next cycle = a DOUBLE-POST.
          {
            // POLL the dialog-closed cue for ~12s (was a single read). A genuine slow publish under 200-400 browsers
            // on ONE home IP can take that long to tear the composer down; a single read at the wrong instant leaves a
            // LANDED short/no-caption post as a FALSE failure, which the owed-reserve path then RE-POSTS = a double-post.
            // This is the ONLY liveness signal for a no-caption post (the caption rescan below can't help it).
            const _dlg = Date.now() + 12000;
            for (;;) {
              const dcNow = await evalTimed(page, () => Array.from(document.querySelectorAll('div[role="dialog"]')).filter((d) => d.querySelector('[contenteditable="true"], input[type="file"], [role="textbox"]')).length, null, 5000).catch(() => -1);
              if (dcNow >= 0 && dialogCountBefore > 0 && dcNow < dialogCountBefore) { step('Publish wait timed out but the composer dialog CLOSED — treating as published (slow publish).'); publishResult = 'published'; break; }
              if (Date.now() >= _dlg || shouldStop()) break;
              await sleep(1500);
            }
          }
          // Feed rescan gate lowered 12→6 chars: a short (6-11 char) caption is still a usable anchor because the scan
          // REQUIRES an author match when we know our display name (below), so it won't false-confirm on a stranger.
          if (publishResult === 'timeout' && _landSnip.length >= 6) {
            step('Publish wait timed out — rescanning the feed (read-only) to see if it landed anyway…');
            await page.goto(`https://www.facebook.com/groups/${gid}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
            await page.waitForSelector('[aria-posinset], div[role="article"]', { timeout: 20000 }).catch(() => {});
            // AUTHOR-aware (wrong-post guard). Our publish TIMED OUT, so we must NOT assume the newest caption match is
            // ours — at 400-account scale another account posts the SAME campaign caption to the SAME group. When we know
            // our FB display name, require an article AUTHORED BY US; only fall back to caption-only when the author is
            // unknown (single-operator case). Without this a genuinely-failed post is falsely confirmed by a stranger's
            // identical caption → counted delivered + never retried = a silently missed post.
            const _meAuthor = String(account.fbDisplayName || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const landed = await evalTimed(page, ({ s, author }) => {
              const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
              const authorOf = (a) => { const c = a.querySelector('h2 a, h3 a, h4 a, strong a, a strong, a[aria-label][href*="/user/"], a[aria-label][role="link"]'); return norm(c ? (c.getAttribute('aria-label') || c.textContent) : '').slice(0, 60); };
              const caps = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]')).slice(0, 8)
                .filter((a) => { const b = norm(a.textContent); return b.includes(s) || b.startsWith(s.slice(0, 20)); });
              if (!caps.length) return false;
              if (author) return caps.some((a) => authorOf(a) === author); // known author → require OUR post, not a same-caption stranger
              return true; // author unknown → caption-only (best-effort; unchanged for single-operator use)
            }, { s: _landSnip, author: _meAuthor }, 8000).catch(() => false);
            if (landed) { step('Publish confirmed via feed rescan — the post landed (slow publish, not a failure)'); publishResult = 'published'; }
          }
        }
        if (publishResult !== 'published') {
          // The post failed — find out WHY so the account can be flagged for the operator.
          // Facebook's spam/rate-limit message appears in the composer right after clicking Post.
          { const _rl = await classifyRateLimit(page); if (_rl) { const _k = _rl === 'severe' ? 'account' : 'post'; step(_k === 'account' ? '🛑 Facebook TEMPORARILY BLOCKED this account (post) — stopping it (long cooldown)' : '🛑 Posting rate-limited by Facebook — cooling this account down'); errors++; noRetry = true; flag = 'rate_limited'; rlKind = _k; report(groupName, gid, 'error', _k === 'account' ? 'account temporarily blocked' : 'rate-limited — Facebook blocked the post', ''); break; } }
          if (await checkVerification(page)) { step('🔐 Facebook wants identity/human verification — skipping this account immediately'); errors++; noRetry = true; flag = 'needs_verification'; report(groupName, gid, 'error', 'identity verification required', ''); break; }
          // Otherwise it's an unexplained failure — snapshot the dialog so it's diagnosable.
          const snap = await page.evaluate(() => { const d = document.querySelector('div[role="dialog"]'); return ((d && d.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 120); }).catch(() => '');
          step(`Post clicked but publish NOT confirmed (${publishResult})${snap ? ` — "${snap}"` : ''}; skipping group`);
          errors++; report(groupName, gid, 'error', `publish not confirmed (${publishResult})`, '');
          // Soft-throttle breaker: Facebook can silently stop confirming posts after a burst (NO explicit "posting
          // too fast" text — just a stuck composer, which is exactly what classifyRateLimit above can't catch). ONLY
          // a silent TIMEOUT counts toward it — an explicit 'error' (FB "couldn't post" dialog) is a different
          // failure (e.g. a momentary FB outage) and must NOT trip the hours-long backoff, so it RESETS the streak.
          // ONE timeout may be a genuinely slow publish, but TWO IN A ROW means this account is throttled NOW — stop
          // hammering its remaining groups (each is a 70s wait + another error + a botty rapid-fail pattern) and back
          // it off so the reserve / next cycle takes over. Reset to 0 on any confirmed publish (below).
          if (publishResult === 'timeout') {
            if (++consecPubTimeouts >= 2) { step('🛑 2 posts in a row went unconfirmed — likely a silent Facebook throttle after a burst. Backing this account off now (its reserve / next cycle continues).'); noRetry = true; flag = 'rate_limited'; rlKind = 'post'; break; }
          } else { consecPubTimeouts = 0; }
          continue;
        }
        consecPubTimeouts = 0; // a confirmed publish breaks any unconfirmed-publish streak
        // FUNCTIONAL WAIT: after publish, FB needs time to commit the post server-side and for the
        // pending-approval toast to appear in the DOM before pendingNoticeForOurPost reads it.
        // The old 600ms turbo/instant settle ran AFTER pendingNoticeForOurPost (wrong order) — a
        // moderated group's "pending" toast that takes >600ms to hydrate was missed, so a held post
        // fell through to the slow 40-56s feed-scan path and ended as 'notfound' (no comment placed).
        // instant → 1800ms, turbo → 1200ms, normal → humanDelay(3000ms). NOT a cosmetic anti-spam
        // gap — this is the gate that lets the pending toast render before we read it.
        const _postPublishSettle = settings.speedMode === 'instant' ? 1800 : isTurboMode(settings) ? 1200 : isFastMode(settings) ? 1500 : humanDelay(3000, settings, 'settle'); // plain 'fast' was falling through to the full ~3s (treated like normal); give it an intermediate settle — still ≥1200ms so the held-post/"Spam potentiel" toast has hydrated (load-bearing for dedup + reserve)
        await sleepInterruptible(_postPublishSettle, softStop, 500, isPaused, pauseHold);
        // POST-SPECIFIC pending capture: on THIS post-click page, BEFORE any navigation, scanning only
        // toast/alert/dialog surfaces (never feed articles). A genuinely moderated group shows the
        // "will be reviewed / pending" notice here for OUR post; the OLD pending posts the operator
        // sees in the feed are ARTICLES and are excluded — so this can't false-positive. This is now
        // the ONLY determinant of "pending" (the post-reload whole-page scan was the false-positive).
        const pendingAtPublish = await pendingNoticeForOurPost(page);
        if (pendingAtPublish) step('A pending/review notice appeared for this post — this group looks moderated (will confirm against the feed).');
        await dismissPopups(page);

        // E-P3: emerging block/checkpoint check on the post-publish page (BEFORE we navigate away — the
        // notice appears in the composer/page right after Post). If present, the account is throttled
        // NOW: the post landed (count it) but cool down + skip its comment + the account's remaining groups.
        let emergingBlock = false;
        try {
          const suspect = await evalTimed(page, (cfg) => {
            const t = (document.body.innerText || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
            return [...cfg.rate, ...cfg.cp].find((p) => t.includes(p)) || null;
          }, { rate: FB.rateLimit, cp: FB.checkpoint }, 6000);
          if (suspect) { emergingBlock = true; step(`🛑 Posted, but an EMERGING block/checkpoint phrase is present ("${suspect}") — cooling down this account immediately`); }
        } catch {}
        if (emergingBlock) {
          posted++; markDelivered(gid); flag = 'rate_limited'; noRetry = true;
          // The post is LIVE but its link-comment was never placed (we break before the comment step). QUEUE it so a
          // healthy in-group reserve completes it in Phase-3 — a post is NEVER left without its link (mirrors line ~2753).
          // Without this the comment was silently dropped even when a reserve was available (the markDelivered above
          // also excludes this group from the owed/re-post path, so nothing else would recover it).
          if ((post.comment && post.comment.trim()) || groupCommentImg) {
            const _cap = (post.caption || '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().slice(0, 40);
            commentQueue.push({ gid, groupName, postPermalink: null, postId: (basePost && basePost.id) || null, captionSnip: _cap, postCaption: (post.caption || '').slice(0, 220), comment: post.comment || '', commentImg: groupCommentImg || null, posterAccount: name, fbDisplayName: (account.fbDisplayName || '').trim(), reason: 'emerging_block' });
          }
          report(groupName, gid, 'posted', 'emerging block after publish — comment routed to a reserve (rescue)', 'skipped');
          break;
        }

        // Caption key (normalized 40-char) — the held-record match key AND the feed caption-match key below.
        const capSnip = (post.caption || '').replace(/\s+/g, ' ').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().slice(0, 40);

        // FAST HELD-EXIT: a POST-SPECIFIC pending/review notice appeared at publish time → the post is HELD
        // (Spam potentiel / pending approval) and will NOT be in the public feed. Skip the whole group reload +
        // feed scan (≈40-56s of guaranteed-useless work) and route STRAIGHT to the moderator/held path. Works
        // for ANY caption length — the old path's capSnip>=12 gate let short/image held posts fall through and
        // burn the 60-180s comment delay + scan before giving up. The held record carries the comment so it is
        // placed after approval. This is the single biggest "wasting time every run" fix for moderated groups.
        if (pendingAtPublish) {
          step('Post HELD for admin approval (pending notice at publish) — skipping the feed scan, routing to the moderator queue.');
          pendingApproval++; markDelivered(gid); // the post DID reach this group (held for review) — don't let a reserve re-post it
          consecPubTimeouts = 0; // a HELD post is a CONFIRMED publish (FB accepted it, just gated) — it must NOT count toward the silent-throttle streak
          heldRecords.push({ postId: basePost.id || null, gid, posterAccount: name, fbDisplayName: (account.fbDisplayName || '').trim(), captionSnip: capSnip, postCaption: (post.caption || '').slice(0, 220), groupName, comment: post.comment || '', commentImg: groupCommentImg || null, postPermalink: null, source: 'pending_at_publish' });
          report(groupName, gid, 'pending', 'awaiting admin approval (immediate signal)', 'skipped');
          if (i < targetGroups.length - 1) await sleepInterruptible(settings.speedMode === 'instant' ? rand(1000, 3000) : withFloor(rangeMs(settings, 'groupDelayMin', 'groupDelayMax', 120, 300, 120) * ((settings._behavior && settings._behavior.gapMult) || 1), antiSpamFloors(settings).group), softStop, 1000, isPaused, pauseHold);
          continue;
        }

        // GROUND TRUTH (non-held path): reload the group and find OUR post — right after publishing it isn't
        // in the feed DOM yet; after a reload it's at the TOP, so we confirm it's live AND grab its verified
        // permalink. (A delayed server-side hold with NO composer notice is caught later by the comment
        // 'notfound' path, which routes it to the moderator queue.)
        let postPermalink = null;
        let expectedPostId = null; // OUR post's stable id — the trust anchor for commenting (CT-4)
        let _idFromNetwork = false; // id came from FB's publish response (not a caption-verified feed match) → Phase 2 MUST content-verify before commenting
        // A comment that follows means addFirstComment will reload the group ONCE, find OUR post
        // (caption+author wrong-post guarded) and comment — so a standalone verify-reload here would be a
        // redundant SECOND reload of the same feed. Only no-comment posts need this reload as their sole check.
        const wantComment = !!((post.comment && post.comment.trim()) || groupCommentImg);
        // In TWO-PHASE we CAPTURE the permalink now (even for a comment-bearing post — single-phase skips this to save a
        // reload since it comments inline right after). The captured permalink lets Phase 2 navigate DIRECTLY to each
        // post (no per-comment feed re-scan) AND lets it PRE-LOAD the next post's page while commenting the current.
        const _captureForTwoPhase = wantComment && _twoPhase;
        let feedConfirmed = wantComment && !_captureForTwoPhase; // a two-phase capture DOES do a real feed match below → it may set feedConfirmed true; otherwise unchanged.
        if (_captureForTwoPhase && _netPost && _netPost.postId) {
          // FAST PATH — we already captured OUR post's link from Facebook's publish response, so the whole verify-
          // reload (feed goto + scroll + caption-match + hover-for-href) is UNNECESSARY: skip it. Phase 2 navigates
          // STRAIGHT to this permalink and re-verifies the post's caption+author on its own page before commenting
          // (idFromNetwork → forceContentVerify), so a mis-parsed id self-heals to the feed-scan — the wrong-post
          // guard is fully intact. A silent server-side hold is still caught at comment time (permalink 'notfound').
          expectedPostId = _netPost.postId;
          postPermalink = _netPost.url;
          _idFromNetwork = true;
          feedConfirmed = true; // FB confirmed the create + gave us the id — a genuine confirmed delivery
          step(`Confirmed via the publish response (id=${expectedPostId}) — commenting via the direct link; skipped the feed re-scan`);
        } else if (!wantComment || _captureForTwoPhase) {
        step(_captureForTwoPhase ? 'Verifying the post landed + capturing its link for the comment pass…' : 'Verifying the post landed (reloading the group)…');
        await page.goto(`https://www.facebook.com/groups/${gid}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        await page.waitForSelector('[aria-posinset], div[role="article"]', { timeout: 25000 }).catch(() => {});
        // Small render margin so the find-poll below has content (the waitForSelector above already gated the first article).
        // Capped at 5s (was 15s): the find-poll loop that follows IS the real landed-verify — it scrolls + re-scans + caption+author
        // matches OUR post on its own deadline, so this pre-wait only needs to give the feed a head start, not fully render it.
        await page.waitForFunction(() => document.querySelectorAll('[aria-posinset], div[role="article"]').length >= 3, { timeout: 1500 }).catch(() => {}); // pre-wait HEAD-START only (waitForSelector above already gated ≥1 article; the find-poll below is the real landed-verify) — trimmed 5s→1.5s so a sparse chronological feed doesn't burn fixed time before the poll
        await dismissPopups(page);
        // Find OUR post and capture its verified permalink. Caption-match the TOP-3 ONLY (a match further
        // down is an OLD duplicate, never our just-published post); scan top-8 for the newest-link
        // fallback. Tolerate "See more" truncation. Poll up to ~12s so a slow render isn't read as "gone".
        let find = null;
        // Our FB display name (normalized) — the capture binds the permalink of OUR post, not a same-caption stranger's.
        const _capAuthor = String(account.fbDisplayName || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const findDeadline = Date.now() + 16000;
        let _renderScrolls = 0;
        do {
          find = await evalTimed(page, (arg) => {
            const { s, author } = arg;
            const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const linkOf = (a) => { const l = a.querySelector('a[href*="/posts/"], a[href*="/permalink/"]'); return (l && /\/(posts|permalink)\//.test(l.href || '')) ? l.href.split('?')[0] : null; };
            const atobSafe = (x) => { try { return atob(x); } catch { return x || ''; } };
            // Extract a stable numeric post id even when the timestamp <a> hasn't rendered yet:
            // rendered href → data-feedback-id (base64 contains it) → embedded React props JSON.
            const idOf = (a) => {
              const href = linkOf(a); let m = href && href.match(/\/(?:posts|permalink)\/(\d+)/); if (m) return m[1];
              const fb = a.querySelector('[data-feedback-id]');
              if (fb) { const raw = atobSafe(fb.getAttribute('data-feedback-id')); m = raw && raw.match(/(\d{8,})/); if (m) return m[1]; }
              m = (a.innerHTML || '').match(/"(?:post_id|story_fbid|top_level_post_id)":"?(\d{8,})/); return m ? m[1] : null;
            };
            const arts = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]')).slice(0, 8)
              .filter((a) => !/pinned|épingl|rögzít/.test((a.innerText || '').slice(0, 200).toLowerCase()));
            try { document.querySelectorAll('[data-zp-target]').forEach((e) => e.removeAttribute('data-zp-target')); } catch {}
            // Caption-match TOP-8, TOPMOST (newest) match wins (E-R7). Right after publishing OUR post
            // is newest → at the top, so the first match is ours; the wider window only matters when
            // other users posted in the seconds before this reload and pushed ours to pos 3-7 (without
            // it those live posts were mislabeled "pending"). An older duplicate, if any, is lower than
            // our fresh post, so first-match-wins never picks it. Caption stays the gate (no stranger).
            // AUTHOR-aware capture (wrong-post guard): collect full-caption matches (drop the loose 20-char
            // prefix that matched DIFFERENT posts), then bind the permalink of the article authored by US —
            // not a stranger's / another account's same-caption post. Only accept a caption-only match when
            // there's exactly ONE and its author can't be read (unambiguous); otherwise return null → the
            // (author+ambiguity-checked) feed-scan fallback handles it. Never claim someone else's post.
            const authorOf = (a) => { const c = a.querySelector('h2 a, h3 a, h4 a, strong a, a strong, a[aria-label][href*="/user/"], a[aria-label][role="link"]'); return norm(c ? (c.getAttribute('aria-label') || c.textContent) : '').slice(0, 60); };
            if (s && s.length >= 12) {
              const caps = [];
              for (let i = 0; i < Math.min(8, arts.length); i++) { const a = arts[i]; if (norm(a.textContent).includes(s)) caps.push({ a, i, auth: authorOf(a) }); }
              // SINGLE caption match → ours (unambiguous); MULTIPLE → bind only the one authored by us.
              let pick = null;
              if (caps.length === 1) pick = caps[0];
              else if (caps.length > 1 && author) { const ours = caps.filter((c) => c.auth && c.auth === author); if (ours.length) pick = ours[0]; }
              if (pick) { pick.a.setAttribute('data-zp-target', '1'); return { href: linkOf(pick.a), postId: idOf(pick.a), matched: true, pos: pick.i }; }
            }
            return null; // ambiguous / not-ours → don't bind a permalink; the feed fallback decides
          }, { s: capSnip, author: _capAuthor }, 8000).catch(() => null);
          // If matched but the timestamp <a href> hasn't lazily rendered, hover it FROM NODE (synthetic
          // in-page events don't trigger FB's hover-render) to force the real href, then re-read.
          if (find && find.matched && !find.href) {
            const box = await page.$('[data-zp-target="1"]').catch(() => null);
            if (box) {
              try {
                await box.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
                const ts = await box.$('a[href*="/posts/"], a[href*="/permalink/"], abbr, time, a[role="link"]').catch(() => null);
                if (ts) await ts.hover().catch(() => {}); else await box.hover().catch(() => {});
              } catch {}
              await sleep(700);
              const rh = await evalTimed(page, () => {
                const a = document.querySelector('[data-zp-target="1"]'); if (!a) return null;
                const l = a.querySelector('a[href*="/posts/"], a[href*="/permalink/"]');
                return (l && /\/(posts|permalink)\//.test(l.href || '')) ? l.href.split('?')[0] : null;
              }, null, 4000).catch(() => null);
              if (rh) { find.href = rh; const m = rh.match(/\/(?:posts|permalink)\/(\d+)/); if (m) find.postId = m[1]; }
            }
          }
          // A caption match = our post is LIVE in the public feed — that's the confirmation. We do NOT
          // keep looping for a numeric post-id: FB's current [aria-posinset] DOM rarely exposes one, and
          // the comment targets our post by caption regardless. (One hover attempt above tries for the
          // permalink; if it doesn't render, id stays null and the comment uses the caption-matched box.)
          if (find && find.matched) break;
          // Right after a reload FB renders the top posts as EMPTY [aria-posinset] shells until the page
          // scrolls (lazy content) — that's why the post can be invisible to the scan. Nudge the feed a
          // couple of times so our post's caption renders, then re-scan.
          if (_renderScrolls < 3) { try { await page.evaluate((y) => window.scrollBy(0, y), 500 + _renderScrolls * 200); } catch {} _renderScrolls++; }
          await sleep(_renderScrolls < 2 ? 500 : 900); // inter-MISS re-scan gap (break-on-match above fires first) — shortened from a fixed 1500ms so a freshly-hydrated post is SEEN sooner; the 16s deadline + caption+author guard are unchanged
        } while (Date.now() < findDeadline);

        if (find && find.matched) {
          // LIVE OVERRIDE: our caption is in the PUBLIC feed → the post is approved/live (wins over any
          // pending notice). The post-id is the trust anchor for commenting on exactly this post.
          expectedPostId = find.postId || null;
          postPermalink = find.href || (find.postId ? `https://www.facebook.com/groups/${gid}/posts/${find.postId}/` : null);
          feedConfirmed = true; // our caption IS in the public feed → a genuine confirmed delivery
          step(`Confirmed LIVE — our post is in the feed (id=${expectedPostId || '?'}). Commenting on it directly.`);
        } else {
          // pendingAtPublish was false (the FAST HELD-EXIT above already handled the held case). Post is
          // confirmed submitted but not matched in the feed: short/image caption or slow feed. Do NOT borrow
          // the newest post's link — it could be a STRANGER'S. The comment flow's id/caption-checked feed
          // fallback finds OURS or skips; a delayed server-side hold (no notice) is caught by the comment
          // 'notfound' path, which routes it to the moderator queue.
          postPermalink = null;
          step('Posted (publish confirmed) — caption not matched in feed yet; comment will use the id/caption-checked feed fallback');
        }
        } else {
          // COMMENT path: standalone verify-reload SKIPPED (one reload total). addFirstComment reloads the
          // group once, finds OUR post (caption+author guarded) and comments; if it can't find our post
          // public it returns 'notfound' → moderator queue (post-live check preserved). permalink/postId stay
          // null → the comment and any rescue use the captionSnip fallback, exactly as in the no-permalink case.
          step('Posted (publish confirmed) — the comment step will reload once, find our post, and comment');
        }

        // Success log — keep caption snippet for the renderer's auto-delete tracker.
        step(feedConfirmed ? 'Posted successfully' : 'Posted (publish confirmed) — NOT yet feed-confirmed in this group; if the group holds posts for review it may be in "Spam potentiel" (a no-comment post has nothing to auto-detect it). Worth checking this group.');
        posted++; markDelivered(gid);

        // First comment (often a link) — reload, find OUR post, comment in its box.
        // addFirstComment logs every stage itself (via the same step() logger). wantComment computed above
        // (an image-only comment is valid). When set, the verify-reload above was skipped to avoid a 2nd reload.
        let commentResult = wantComment ? 'failed' : 'none';
        if (wantComment && _twoPhase) {
          // TWO-PHASE: the post is already published + markDelivered'd (above). DEFER its first comment to the
          // after-all-posts pass (Phase 2) — the natural aging between passes IS the anti-spam post→comment gap, so
          // there's no per-group settle wait. postPermalink/expectedPostId were CAPTURED just above (_captureForTwoPhase
          // ran the verify-reload), so Phase 2 navigates STRAIGHT to this post (and pre-loads it) instead of re-scanning
          // the feed. If the capture came up empty (short caption / slow feed) they're null → Phase 2 falls back to the
          // feed-scan for this one post, exactly as before.
          _deferredComments.push({ gid, groupName, post, groupCommentImg, postPermalink, expectedPostId, capSnip, basePostId: (basePost && basePost.id) || null, idFromNetwork: _idFromNetwork });
          commentResult = 'deferred';
          step('Post published — comment DEFERRED to the post-then-comment pass (Phase 2)');
        } else if (wantComment) {
          // CRITICAL anti-spam: do NOT comment seconds after the post — post-then-instant-link is a
          // textbook spam pattern. Wait a randomized human gap first. The permalink was already
          // captured above, so OUR post is still found reliably even after the wait.
          // Use rangeMs (same as the inter-group gap + rescue.js): a random value in [min,max] with a 30s
          // floor on the defaults. Then jitter ±12% so even a min===max config isn't a metronomic post→link gap.
          const lo = Number.isFinite(settings.commentDelayMin) ? settings.commentDelayMin : 60;
          const hi = Number.isFinite(settings.commentDelayMax) ? settings.commentDelayMax : 180;
          // INSTANT mode: operator-requested 1–5s post→comment gap. The operator validates spam by posting the first
          // post manually + runs warmed accounts/proxies, so the old ~4s anti-spam floor is intentionally lowered here
          // (1s post→link IS aggressive — that's the operator's call). Otherwise the normal randomized comment window.
          const cd = settings.speedMode === 'instant' ? rand(1000, 3000) : withFloor(jitter(rangeMs(settings, 'commentDelayMin', 'commentDelayMax', 60, 180, 30), 0.12) * ((settings._behavior && settings._behavior.gapMult) || 1), antiSpamFloors(settings).comment);
          if (!commentLimited && cd > 0 && !softStop()) { step(`Comment: waiting ${Math.round(cd / 1000)}s before commenting (avoids the instant post→link spam pattern)`); await sleepInterruptible(cd, softStop, 1000, isPaused, pauseHold); }
          // PAUSE/DISABLE BOUNDARY: the post is already published (safe), the comment is a SEPARATE action.
          // If paused now, HOLD here (watchdog-safe) so Pause stops BEFORE the comment fires even when the
          // wait already elapsed; this is the load-bearing "Pause keeps going" fix for the comment step.
          if (isPaused && isPaused()) { if (watchdog) { clearTimeout(watchdog); watchdog = null; } if (waitIfPaused) await waitIfPaused(); armWatchdog(); }
          // Retry up to 3× — addFirstComment only returns the retryable 'failed' BEFORE it presses
          // Enter (no box found, stalled renderer; 'skipped' for short-caption-no-link), so a retry
          // (it re-navigates each time) can NEVER duplicate an already-sent comment. C2: keep a per-
          // attempt human gap so retries don't collapse into an instant burst.
          // If this account already hit a COMMENT limit earlier this run, DON'T re-hit the wall — hand this
          // post's link-comment straight to a reserve (Phase-3 rescue) and keep posting. 'comment_limited' is a
          // non-landed result, so the rescue-queue branch below picks it up.
          let cres = commentLimited ? 'comment_limited' : 'failed';
          let cAttemptsActual = 0; // count REAL addFirstComment calls — the loop can run 0× (paused/suspended/stop) so the failure message isn't a misleading "3 attempts"
          if (commentLimited) step('Comment: account is comment-limited this run — routing this post\'s link-comment to a reserve (account keeps posting)');
          // Retry ONLY on 'failed' (a transient pre-Enter miss — re-navigating can recover it). 'notfound'
          // means the post is HELD in Spam-potentiel (not public) → retrying can't make it public, and a late
          // flicker to 'failed' would misroute a held post to the comment-rescue queue (which can't reach a
          // non-public post). So a 'notfound' breaks immediately and is routed to MODERATOR approval below.
          for (let cAttempt = 1; cAttempt <= 3 && cres === 'failed' && !shouldStop() && !aborted && browser && browser.isConnected(); cAttempt++) {
            if (cAttempt > 1) {
              // ~25% of the min comment delay, floored at 2.5s normally but only 0.3s when the operator
              // chose fast (humanize off or speedMode fast) — so fast settings apply to retries too.
              const _fast = isFastMode(settings);
              const gap = Math.max(_fast ? 300 : 2500, Math.round(Math.min(lo, hi) * 1000 * 0.25));
              step(`Comment: retry ${cAttempt}/3 (waiting ${Math.round(gap / 1000)}s — keeping the human cadence)`);
              await sleepInterruptible(gap, softStop, 500, isPaused, pauseHold);
            }
            cAttemptsActual++;
            cres = await addFirstComment(page, gid, post, groupCommentImg, step, postPermalink, settings, expectedPostId, account.fbDisplayName);
          }
          commentResult = cres;
          // Did the comment actually land (or get submitted)? 'unconfirmed'/'not_visible' = Enter WAS
          // pressed (re-commenting would double-post), so those are NOT rescued. Only the pre-Enter
          // outcomes (failed/skipped/blocked_*) leave a live post with no comment → rescue-eligible.
          // 'blocked_*_landed' = the comment DID land but FB then walled the account — treat as LANDED (never
          // re-queue = never double-comment) while still cooling/stopping the account below.
          const _commentLanded = (cres === 'posted' || cres === 'unconfirmed' || cres === 'not_visible' || cres === 'none' || cres === 'blocked_account_landed' || cres === 'blocked_comment_landed');
          if (cres === 'failed') step(`Comment: could not place the comment after ${cAttemptsActual} attempt(s) — left uncommented`);
          else if (cres === 'skipped') step('Comment: skipped (could not safely identify our post)');
          else if (cres === 'blocked_account' || cres === 'blocked_account_landed') {
            // FULL block (account-level): the account can do NOTHING — STOP it now (posting+commenting more
            // only deepens the block) and flag it so the orchestrator rests it long (3×) + a reserve takes over.
            step(cres === 'blocked_account_landed' ? '🛑 Comment landed, then Facebook blocked this account — stopping it (long cooldown); a reserve takes over (comment NOT re-queued)' : '🛑 Facebook temporarily blocked this account — stopping it (long cooldown); a reserve takes over its groups');
            flag = 'rate_limited'; rlKind = 'account'; noRetry = true;
          } else if (cres === 'blocked_comment' || cres === 'blocked_comment_landed') {
            // COMMENT-ONLY limit: the account can still POST. Do NOT sideline it from posting — switch to
            // comment-limited mode for the REST of this run: keep posting every group, and route each post's
            // link-comment to a RESERVE (Phase-3 rescue). A pre-Enter blocked_comment IS queued below (non-landed);
            // a blocked_comment_landed is NOT (the comment already landed — _commentLanded above excludes it).
            commentLimited = true;
            step(cres === 'blocked_comment_landed' ? '🛡️ Comment landed, then Facebook comment-limited this account — it KEEPS POSTING; later link-comments route to a reserve (this one NOT re-queued)' : '🛡️ Commenting rate-limited — account KEEPS POSTING; its link-comments are routed to a reserve this run');
          }
          if (cres === 'notfound') {
            // Published but NEVER in the public feed after every retry → FB HELD it in "Spam potentiel".
            // A held post isn't public, so NO account (not even a healthy reserve) can comment on it — the
            // ONLY fix is MODERATOR APPROVAL. Re-count it as PENDING (not posted), record it as held (with
            // its comment payload) so the moderator phase approves it and the comment is placed once it's
            // public. (NOT the comment-rescue queue, which can't reach a non-public post.)
            posted = Math.max(0, posted - 1); pendingApproval++;
            step('Comment: ⚠️ post is HELD in "Spam potentiel" (published but not public) → routing to MODERATOR APPROVAL (a held post can\'t be commented by any account until it\'s approved)');
            heldRecords.push({ postId: (basePost && basePost.id) || expectedPostId || null, gid, posterAccount: name, fbDisplayName: (account.fbDisplayName || '').trim(), captionSnip: capSnip || '', postCaption: (post.caption || '').slice(0, 220), groupName, comment: post.comment || '', commentImg: groupCommentImg || null, postPermalink: postPermalink || null, source: 'comment_notfound' });
            report(groupName, gid, 'pending', 'held in Spam potentiel — awaiting moderator approval', 'skipped');
          } else if (!_commentLanded) {
            // The post is LIVE but its link-comment did not land. Queue it so a healthy reserve account
            // that is a member of this group places the comment later — a post is NEVER left without its
            // link. (postPermalink locates it directly; captionSnip is the feed-scan fallback.)
            commentQueue.push({ gid, groupName, postPermalink: postPermalink || null, postId: (basePost && basePost.id) || expectedPostId || null, captionSnip: capSnip || '', postCaption: (post.caption || '').slice(0, 220), comment: post.comment || '', commentImg: groupCommentImg || null, posterAccount: name, fbDisplayName: (account.fbDisplayName || '').trim(), reason: cres });
            step('Comment: 📌 queued for rescue by a healthy account — this post will NOT be left without its link');
          }
          if (cres === 'blocked_account' || cres === 'blocked_account_landed') {
            report(groupName, gid, 'posted', 'account temporarily blocked', commentResult);
            break; // FULL block → stop the account; comment-limit does NOT break (keeps posting, comments go to a reserve)
          }
        }
        // 'notfound' (held in Spam potentiel) already reported itself as 'pending' above — don't also
        // report it as 'posted'.
        if (commentResult !== 'notfound') report(groupName, gid, 'posted', '', commentResult);
      } catch (e) {
        // E-P1: retry the SAME group ONCE on a TRANSIENT failure that happened BEFORE the publish
        // click — so we reclaim groups lost to a CDP blip / nav timeout without any double-post risk.
        // Block errors (rate-limit/checkpoint) and post-publish errors are never retried here.
        const cls = classifyGroupError(e.message);
        if (cls === 'transient' && !publishClicked && (groupRetries[gid] || 0) < 3 && !shouldStop() && browser && browser.isConnected()) {
          groupRetries[gid] = (groupRetries[gid] || 0) + 1;
          // Up to 3 pre-publish retries (was 1): a transient blip (CDP hiccup, slow-proxy nav timeout, a caption that
          // needed the composer re-opened) is recoverable, and in campaign-plan a skipped group means that (post,group)
          // is PERMANENTLY missed — the account advances to the next post next cycle. publishClicked is still false, so
          // each retry re-opens a FRESH composer with ZERO double-post risk. Back off a little more each attempt.
          step(`Transient error before publish (${e.message}) — retrying this group (${groupRetries[gid]}/3)`);
          await sleepInterruptible(Math.min(2000 + (groupRetries[gid] - 1) * 1500, 6000), shouldStop);
          i--; continue; // re-attempt the same group (nothing was published)
        }
        errors++;
        step(`Error: ${e.message}`);
        report(groupName, gid, 'error', e.message, '');
        try { await page.screenshot({ path: require('path').join(store.accountDir(name), 'last-failure.png') }); } catch {}
        // If the browser/page died, every remaining group would just throw the same way —
        // abort this account cleanly instead of churning one error per remaining group. NOTE: a 'detached Frame'
        // error is NOT in this list — it's usually a transient per-element/per-frame hiccup while the BROWSER is
        // still connected, so aborting the whole account on it needlessly skipped that account's remaining groups.
        // It now falls through to the normal error+continue (next group), while a genuinely dead browser/session
        // still aborts via !isConnected() / target-closed / session-closed / protocol-error.
        if (!browser || !browser.isConnected() || /target closed|session closed|protocol error/i.test(e.message || '')) {
          step('Browser lost — aborting remaining groups for this account');
          break;
        }
      }

      // Daily-cap budget: stop this account once it has used its remaining posts for today, so a
      // single run can't overshoot the cap by (groups - 1). maxThisRun is the orchestrator's
      // remaining-budget for this account today (Infinity / undefined when the cap is off).
      if (Number.isFinite(maxThisRun) && (posted + pendingApproval) >= maxThisRun) { log(`📵 [${name}] reached today's remaining post budget (${posted + pendingApproval}, incl. held) — stopping this account`); break; }

      // Interruptible delay between groups (respects Stop + configurable groupDelay), jittered ±30%
      // so the cadence is never metronomic (a fixed gap is itself a bot signal).
      if (i < targetGroups.length - 1) {
        const d = settings.speedMode === 'instant' ? rand(1000, 3000) : withFloor(rangeMs(settings, 'groupDelayMin', 'groupDelayMax', 120, 300, 120) * ((settings._behavior && settings._behavior.gapMult) || 1), antiSpamFloors(settings).group); // T2: randomized inter-group gap (instant=1–10s; turbo ~8s floor)
        if (d > 0) {
          step(`Wait ${d >= 60000 ? Math.round(d / 60000) + 'min' : Math.round(d / 1000) + 's'} before next group`);
          await sleepInterruptible(d, softStop, 1000, isPaused, pauseHold);
        }
        // H-2: over a long run on a laptop in use, a hidden window can drift on-screen (Windows re-clamp
        // / heavy window activity). Every 3rd group, cheaply check its position and re-park it off-screen
        // if it drifted. HIDDEN-only and move-only (never touches publish state) → safe, no-op in VISIBLE.
        if (hidden && cdpSession && hiddenWindowId && i % 3 === 2 && !shouldStop()) {
          try {
            const b = await cdpSession.send('Browser.getWindowBounds', { windowId: hiddenWindowId });
            if (b && b.bounds && (b.bounds.left > -2000 || b.bounds.top > -2000)) {
              await cdpSession.send('Browser.setWindowBounds', { windowId: hiddenWindowId, bounds: { windowState: 'normal' } });
              await cdpSession.send('Browser.setWindowBounds', { windowId: hiddenWindowId, bounds: { left: -32000, top: -32000, width: vp.width, height: vp.height } });
              log(`🙈 [${name}] hidden window had drifted on-screen — re-parked off-screen`);
            }
          } catch {}
        }
      }
    }
    _closePrefetch(); // close any still-loading pre-fetch tabs (account finished/broke out of the loop)

    // ===== PHASE 2 (two-phase / post-then-comment): every group now has its POST up — go back and place each
    // deferred first comment. SAFETY: every double-post trap already fired in Phase 1 (markDelivered at publish); a
    // comment is a separate non-post action and addFirstComment NEVER re-types after pressing Enter (the retry loop
    // only re-runs on the pre-Enter 'failed'), so this pass can neither double-post nor double-comment. Result routing
    // MIRRORS the inline per-group path: blocked_account → stop + rescue the rest; blocked_comment/failed/skipped →
    // reserve rescue queue; notfound → held → moderator approval. Anything left unplaced routes to a reserve so a post
    // is NEVER left without its link.
    if (_twoPhase && _deferredComments.length) {
      const routeToRescue = (dc, reason) => commentQueue.push({ gid: dc.gid, groupName: dc.groupName, postPermalink: dc.postPermalink || null, postId: dc.basePostId || dc.expectedPostId || null, captionSnip: dc.capSnip || '', postCaption: (dc.post.caption || '').slice(0, 220), comment: dc.post.comment || '', commentImg: dc.groupCommentImg || null, posterAccount: name, fbDisplayName: (account.fbDisplayName || '').trim(), reason });
      const acctDown = () => aborted || !browser || !browser.isConnected() || flag === 'rate_limited' || flag === 'needs_verification' || flag === 'needs_login' || flag === 'account_disabled' || flag === 'likely_blocked';
      if (acctDown()) {
        // The account fell over during the POST pass (block / checkpoint / dead browser) — it can't comment now, so
        // hand EVERY deferred comment to a healthy reserve (a post is never left without its link).
        for (const dc of _deferredComments) routeToRescue(dc, 'account_unavailable');
        log(`✍️ [${name}] account unavailable for the comment pass — ${_deferredComments.length} comment(s) routed to reserves`);
      } else {
        log(`✍️ [${name}] post pass done — placing ${_deferredComments.length} deferred comment(s)`);
        // PHASE-2 PREFETCH PIPELINE (mirrors the posting-pass prefetch): while a comment is being placed, PRE-LOAD the
        // NEXT deferred post's OWN permalink page in a hidden, hardened background tab — so navigation overlaps commenting
        // and each comment goes STRAIGHT to its post (no per-comment feed re-scan). Gated on the SAME tabsPerBrowser
        // setting as the posting pass. Only posts whose permalink was captured in Phase 1 are prefetched; the rest fall
        // back to addFirstComment's own navigation. addFirstComment(preNavigated=true) skips its goto but keeps every
        // wrong-post + double-comment guard (the id/caption/author verify + the retry-only-on-pre-Enter-'failed' rule).
        const _cpf = new Map(); // deferredIndex → Promise<{ entry, ok } | null>  (shares the ADR-0018 tab pool)
        const _prefetchComment = (idx) => {
          if (_tabsWanted <= 1 || idx >= _deferredComments.length || _cpf.has(idx) || !browser || !browser.isConnected()) return;
          const pdc = _deferredComments[idx];
          if (!pdc || !pdc.postPermalink) return; // no captured permalink → addFirstComment navigates it itself
          _cpf.set(idx, (async () => {
            const e = await _acquireTab();
            if (!e) return null; // pool saturated → this comment navigates on the active tab (addFirstComment does its own goto)
            e.navs++;
            const ok = await e.tab.goto(pdc.postPermalink, { waitUntil: 'domcontentloaded', timeout: 90000 }).then(() => true).catch(() => false);
            return { entry: e, ok };
          })().catch(() => null));
        };
        const _closeCpf = () => { for (const e of _pool.free) { try { if (e && e.tab) e.tab.close().catch(() => {}); } catch {} } _pool.free.length = 0; for (const p of _cpf.values()) p.then((x) => { if (x && x.entry && x.entry.tab) x.entry.tab.close().catch(() => {}); }).catch(() => {}); _cpf.clear(); };
        let d = 0;
        for (; d < _deferredComments.length; d++) {
          if (shouldStop() || acctDown()) break;
          if (isPaused && isPaused()) { if (watchdog) { clearTimeout(watchdog); watchdog = null; } if (waitIfPaused) await waitIfPaused(); armWatchdog(); if (shouldStop()) break; }
          const dc = _deferredComments[d];
          const cstep = createStepLogger(log, name, dc.groupName);
          // Adopt the tab pre-loaded on THIS post's permalink (if any): rebind the CDP session to it, close the old tab
          // (mirrors the posting-pass adopt). _preNav=true → addFirstComment skips its goto and comments on it directly.
          let _preNav = false;
          if (_cpf.has(d)) {
            const pre = await _cpf.get(d); _cpf.delete(d);
            if (pre && pre.entry && pre.ok) {
              _releaseTab({ tab: page, cdp: cdpSession, winId: hiddenWindowId, navs: _pool.activeNavs }); // rotate: old active tab back to the pool (ADR-0018), don't close
              page = pre.entry.tab;
              // Rebind to the adopted tab (re-bind a CDP session if the prefetch tab lacked one) so cdpSession never
              // points at the released tab — mirrors the Phase-1 adopt fix.
              if (pre.entry.cdp) { cdpSession = pre.entry.cdp; if (pre.entry.winId != null) hiddenWindowId = pre.entry.winId; }
              else { const _rb = await _bindCdp(pre.entry.tab); cdpSession = _rb.cdp; if (_rb.winId != null) hiddenWindowId = _rb.winId; pre.entry.cdp = _rb.cdp; pre.entry.winId = _rb.winId; }
              _pool.activeNavs = pre.entry.navs;
              _preNav = true;
            } else if (pre && pre.entry) { _releaseTab(pre.entry); }
          }
          // Pre-load the NEXT deferred post(s) so they render DURING this comment's cadence gap + placement.
          for (let k = 1; k < _tabsWanted; k++) _prefetchComment(d + k);
          // Comment-to-comment cadence ONLY (no post→comment settle wait — the post already aged during Phase 1).
          if (d > 0 && !softStop()) {
            const g = settings.speedMode === 'instant' ? rand(800, 2500) : withFloor(Math.round(rangeMs(settings, 'commentDelayMin', 'commentDelayMax', 60, 180, 30) * 0.4) * ((settings._behavior && settings._behavior.gapMult) || 1), antiSpamFloors(settings).comment);
            if (g > 0) await sleepInterruptible(g, softStop, 1000, isPaused, pauseHold);
          }
          let cres = commentLimited ? 'comment_limited' : 'failed';
          if (commentLimited) cstep('Comment: account is comment-limited this run — routing this post\'s link-comment to a reserve');
          // Retry only on 'failed' (pre-Enter miss) — addFirstComment re-navigates each attempt and can NEVER
          // duplicate an already-sent comment (post-Enter it returns 'unconfirmed', which is NOT 'failed').
          for (let cAttempt = 1; cAttempt <= 3 && cres === 'failed' && !shouldStop() && !aborted && browser && browser.isConnected(); cAttempt++) {
            if (cAttempt > 1) {
              const gap = Math.max(isFastMode(settings) ? 300 : 2500, Math.round(Math.min(Number.isFinite(settings.commentDelayMin) ? settings.commentDelayMin : 60, Number.isFinite(settings.commentDelayMax) ? settings.commentDelayMax : 180) * 1000 * 0.25));
              cstep(`Comment: retry ${cAttempt}/3 (waiting ${Math.round(gap / 1000)}s)`);
              await sleepInterruptible(gap, softStop, 500, isPaused, pauseHold);
            }
            cres = await addFirstComment(page, dc.gid, dc.post, dc.groupCommentImg, cstep, dc.postPermalink, settings, dc.expectedPostId, account.fbDisplayName, _preNav && cAttempt === 1, dc.idFromNetwork); // pre-loaded tab only on the FIRST attempt; a retry lets addFirstComment re-navigate to the permalink. idFromNetwork → content-verify the post on its page before commenting (network id is a candidate)
          }
          // 'blocked_*_landed' = the comment landed but FB then walled the account → treat as landed (do NOT route to
          // a reserve = no double-comment), while still stopping/cooling the account.
          const landed = (cres === 'posted' || cres === 'unconfirmed' || cres === 'not_visible' || cres === 'none' || cres === 'blocked_account_landed' || cres === 'blocked_comment_landed');
          if (cres === 'blocked_account') { flag = 'rate_limited'; rlKind = 'account'; noRetry = true; cstep('🛑 Facebook blocked this account during the comment pass — stopping it; the rest route to reserves'); routeToRescue(dc, 'blocked_account'); report(dc.groupName, dc.gid, 'posted', 'account temporarily blocked', cres); d++; break; }
          if (cres === 'blocked_account_landed') { flag = 'rate_limited'; rlKind = 'account'; noRetry = true; cstep('🛑 Comment landed, then Facebook blocked this account — stopping it; the rest route to reserves (this comment NOT re-queued)'); report(dc.groupName, dc.gid, 'posted', 'account temporarily blocked', cres); d++; break; }
          if (cres === 'blocked_comment') { commentLimited = true; cstep('🛡️ Commenting rate-limited — this and the remaining comments route to reserves (account is done posting)'); routeToRescue(dc, 'blocked_comment'); report(dc.groupName, dc.gid, 'posted', '', cres); continue; }
          if (cres === 'blocked_comment_landed') { commentLimited = true; cstep('🛡️ Comment landed, then Facebook comment-limited this account — later comments route to reserves (this one NOT re-queued)'); report(dc.groupName, dc.gid, 'posted', '', cres); continue; }
          if (cres === 'notfound') {
            // Published but never public after every retry → FB held it in "Spam potentiel". No account can comment a
            // non-public post — re-count it as PENDING and record it (with its comment) for MODERATOR approval.
            pendingApproval++; posted = Math.max(0, posted - 1);
            heldRecords.push({ postId: dc.basePostId || dc.expectedPostId || null, gid: dc.gid, posterAccount: name, fbDisplayName: (account.fbDisplayName || '').trim(), captionSnip: dc.capSnip || '', postCaption: (dc.post.caption || '').slice(0, 220), groupName: dc.groupName, comment: dc.post.comment || '', commentImg: dc.groupCommentImg || null, postPermalink: dc.postPermalink || null, source: 'comment_notfound' });
            cstep('Comment: ⚠️ post is HELD in "Spam potentiel" (published but not public) → routing to MODERATOR APPROVAL');
            report(dc.groupName, dc.gid, 'pending', 'held in Spam potentiel — awaiting moderator approval', 'skipped');
            continue;
          }
          if (!landed) { routeToRescue(dc, cres); cstep('Comment: 📌 queued for rescue by a healthy account — this post will NOT be left without its link'); report(dc.groupName, dc.gid, 'posted', '', cres); continue; }
          cstep('Comment: placed');
          report(dc.groupName, dc.gid, 'posted', '', cres); // update the group's comment status from 'deferred' to its real outcome (mirrors the inline path's final report)
        }
        // Anything left unprocessed (Stop or a block broke the pass early) → rescue so no post is left without its link.
        for (; d < _deferredComments.length; d++) routeToRescue(_deferredComments[d], 'comment_pass_interrupted');
        _closeCpf(); // close any still-loading prefetch comment tabs (pass finished or broke out early)
      }
    }

    // Posted NOTHING across all its groups (errors, no specific reason) → flag the account so the
    // operator checks it, but we did NOT skip any group (avoids the per-group false positive).
    if (posted === 0 && pendingApproval === 0 && errors > 0 && !flag && !offline && !shouldStop()) {
      // Failed every group with errors but no classified reason: distinguish a NETWORK OUTAGE from an account
      // problem. If we're OFFLINE, mark offline (the orchestrator HOLDS + re-runs next cycle, account untouched)
      // instead of 'likely_blocked' — which would wrongly drop it + trigger a needless reserve takeover / alert.
      if (typeof isOnline === 'function' && !(await isOnline())) offline = true;
      else flag = 'likely_blocked';
    }
    // Persist refreshed cookies for next run — but ONLY if the session is still valid. If the run ended
    // on a logged-out/checkpoint wall (needs_login/needs_verification/account_disabled, or the jar lost
    // its c_user), writing would overwrite the good cookies.json with a dead jar and the account couldn't
    // recover next run. In that case leave the existing good cookies untouched.
    try {
      const authBroke = flag === 'needs_login' || flag === 'needs_verification' || flag === 'account_disabled';
      const cks = await withTimeout(page.cookies(), 8000, null);
      const stillAuthed = Array.isArray(cks) && cks.some((c) => c && c.name === 'c_user' && c.value) && cks.some((c) => c && c.name === 'xs' && c.value); // require the xs SESSION cookie too — a soft-logout (c_user present, xs gone) is a DEAD session; writing it would clobber the good stored jar (incl. a fresher Chrome-bridge-synced one)
      if (cks && stillAuthed && !authBroke) store.writeCookies(name, cks);
      else if (cks && !stillAuthed) log(`🔒 [${name}] session not valid at run end — keeping the existing saved cookies (not overwriting with a logged-out jar)`);
    } catch {}
    try { fs.writeFileSync(require('path').join(store.accountDir(name), 'last-run-success.txt'),
      `${errors === 0 ? 'SUCCESS' : 'PARTIAL'}\nPosts: ${posted}\nPending: ${pendingApproval}\nTime: ${new Date().toISOString()}\n`); } catch {} // purely diagnostic — a disk-full here must NOT throw into the outer catch (false fatal + blocks auto-delete + warm-up bump)
  } catch (e) {
    errors++;
    log(`❌ [${name}] fatal: ${e.message}`);
  } finally {
    // Bump the warm-up run counter on EVERY post-auth exit (normal, early-return, or fatal crash) so a new
    // account that keeps failing to post still ages out of warm-up instead of repeating the browse forever.
    // Gated on ranThisCycle so an auth-failure (never authed) account doesn't burn its warm-up budget.
    if (ranThisCycle) { try { store.saveRunCount(name, priorRuns + 1); } catch {} } // atomic — a torn write can't restart warm-up
    unregisterAborter();
    if (watchdog) clearTimeout(watchdog);
    if (browser) await closeBrowserOnce();
    // Bound the proxy-chain close: its socket drain (the `true` flag) can hang forever on a Windows CLOSE_WAIT
    // socket after an abrupt browser kill — which would never let runAccount return and would wedge the whole
    // pool (the orchestrator awaits each slot). Race it against an 8s cap.
    if (anonLocal && proxyChain) { try { await Promise.race([proxyChain.closeAnonymizedProxy(anonLocal, true).catch(() => {}), sleep(8000)]); } catch {} }
    // Do NOT delete a comment image that was handed off to a persisted rescue/moderator queue — those are consumed
    // LATER (after the orchestrator persists the queue + a later rescue/moderator phase), so unlinking them here (the
    // old behaviour) makes their uploadFile ENOENT → image-only comments lost, text+image comments lose their image
    // (fires under the default config, varyImages on). Derive the keep-set from the ACTUAL queued records so no push
    // site can be missed; a startup sweep (below) reclaims any kept temp whose consumer never ran (crash/abort).
    const _handedOff = new Set();
    for (const q of commentQueue) if (q && q.commentImg) _handedOff.add(q.commentImg);
    for (const h of heldRecords) if (h && h.commentImg) _handedOff.add(h.commentImg);
    for (const t of tempImages) { if (_handedOff.has(t)) continue; try { fs.unlinkSync(t); } catch {} }
  }
  // fullyPosted = the post landed in EVERY targeted group, none pending, no errors — only then is it
  // safe to auto-delete from the library (a partial publish must be kept). See orchestrator deal gate.
  return { posted, errors, pendingApproval, noRetry, flag, rlKind, offline, heldRecords, commentQueue, fullyPosted: errors === 0 && pendingApproval === 0 && posted === targetGroups.length && !droppedImage };
}

// Cookie normalizer — consolidated into lib/store (SINGLE source, shared with main.js). Re-exported below so
// scripts/prep-accounts.js + scripts/sync-memberships.js keep importing `normalizeCookie` from here unchanged.
const normalizeCookie = store.normalizeCookie;

module.exports = {
  runAccount, parseProxy, normalizeCookie, addFirstComment, killChromiumForProfile,
  // exported for diagnostics — use the EXACT worker logic
  clickFirst, openComposerByText, openComposer, focusEditable, humanType, dismissPopups, clickPostButton, waitForPublish, credentialLogin, moveMouseTo, behaviorFor,
  // exported for tests (no runtime effect)
  jitter, rand, rangeMs, withFloor, ANTI_SPAM_MIN_GROUP_MS, ANTI_SPAM_MIN_COMMENT_MS, antiSpamFloors, isTurboMode, humanDelay, isFastMode, applyPace, varyLinks, retryAsync, downloadImage, isSafeImageUrl, proxyFormatHint, classifyProxyError, proxyErrorHint, classifyGroupError,
  FB, isRateLimitText, isCheckpointText, isPendingText, isPostButtonLabel, isCommentBoxLabel,
};
