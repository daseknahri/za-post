// automation/orchestrator.js
// Account-centric posting engine. Each cycle, eligible accounts run in parallel
// batches (parallelAccounts). Per account we apply its own postFilter + postingOrder
// to choose which post(s) to publish this cycle, with a persisted rotation index so
// "sequence"/"unique" modes advance across runs (mirrors the original .pcu-state.json).
//
// postingOrder semantics:
//   post-centric         -> account posts ALL its eligible posts this cycle (declared order)
//   random               -> account posts ALL its eligible posts, shuffled
//   sequence             -> account posts the NEXT single post (rotates +1 each cycle)
//   post-centric-unique  -> account posts ONE post, offset by account index so accounts
//                           post DIFFERENT content in the same cycle (rotates each cycle)
//   random-unique        -> like post-centric-unique but the per-account pick is shuffled
//   daily-rotation       -> account posts ONE post PER LOCAL DAY, advancing its OWN persisted pointer
//                           (independent of other agents + the shared dealt-set); self-paces to 1/day
//   campaign-plan        -> agents sharing the SAME groups split the whole library (per-cluster), each
//                           walking its pre-assigned slice 1 post/local-day until the finite batch is done
//
// Which SETTINGS apply to which method:
//   postsPerGroup   -> ONLY post-centric/random (caps distinct posts per cycle); others always post 1.
//   loopCampaign    -> ONLY the finite methods (unique/sequence recycle; campaign-plan reshuffles a round).
//   completionMode  -> ONLY the finite methods (drain to 100% then stop+report); no-op for ongoing modes.
//   scheduleMode    -> daily-rotation/campaign-plan self-pace to 1/day regardless; daily gate adds a once/day
//                      cap for the others. maxCycles caps cycles but is ignored while completion is draining.

const path = require('path');
const os = require('os');
const store = require('../lib/store');
const { runAccount, applyPace, parseProxy, sweepOrphanTemps } = require('./worker');
const { normalizeSpeedMode } = require('../lib/speed'); // to recognize the 'max' tier in the orchestrator's own fleet-level pacing (fleet settings.speedMode is the USER tier safe/fast/max)
const { ProxyHealthManager } = require('../lib/proxy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jitter a delay by ±pct so batch/cycle gaps are never metronomic (a fixed cadence is a bot signal).
const jitter = (ms, pct = 0.25) => Math.round(Math.max(0, Number(ms) || 0) * (1 - pct + Math.random() * pct * 2));
// A random integer in [min,max] — the primitive for unpredictable, never-constant cadence.
const rand = (min, max) => { let lo = Math.max(0, Math.floor(Number(min) || 0)), hi = Math.max(0, Math.floor(Number(max) || 0)); if (hi < lo) { const t = lo; lo = hi; hi = t; } return lo + Math.floor(Math.random() * (hi - lo + 1)); };
// Per-account flags that mean the account DROPPED this cycle (delivered nothing): rate-limit, logout,
// checkpoint/verification, disabled, block, or an unusable proxy. Drives the reserve-takeover pass.
const DROP_FLAGS = new Set(['rate_limited', 'needs_login', 'needs_verification', 'account_disabled', 'likely_blocked', 'proxy_invalid']);
// Random ms drawn from a settings min/max range (in the given unit ms-per-unit; floor keeps it safe).
const rangeMs = (settings, minKey, maxKey, defMin, defMax, unitMs = 1000, floorUnit = 0) => {
  settings = settings || {};
  const hasLo = Number.isFinite(settings[minKey]);
  const hasHi = Number.isFinite(settings[maxKey]);
  const lo = hasLo ? settings[minKey] : defMin;
  const hi = hasHi ? settings[maxKey] : defMax;
  // Honor an EXPLICIT operator value (collapse the safety floor to a near-zero unit so a deliberately-fast
  // setting actually applies); the larger safety floor only guards the built-in DEFAULTS. Mirrors worker.js.
  const eff = (hasLo || hasHi) ? 0 : floorUnit;
  return rand(Math.max(eff, Math.min(lo, hi)) * unitMs, Math.max(eff, Math.max(lo, hi)) * unitMs);
};

let axios; try { axios = require('axios'); } catch {}
const https = require('https');

// Probe one URL with a hard timeout; resolve true on ANY HTTP response, false on error/timeout.
function probe(url, ms) {
  if (axios) return axios.get(url, { timeout: ms, validateStatus: () => true, maxRedirects: 1 }).then(() => true).catch(() => false);
  // Fallback when axios is missing — never silently assume "online".
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = https.get(url, { timeout: ms }, (res) => { res.destroy(); fin(true); });
      req.on('error', () => fin(false));
      req.on('timeout', () => { req.destroy(); fin(false); });
    } catch { fin(false); }
  });
}

// Online if EITHER probe responds (only declare offline when BOTH fail). M3-10: the per-probe
// window is raised to 12s so a slow-but-real network (VPN, congested link) isn't misread as offline,
// and the cap is INTERRUPTIBLE — a graceful Stop resolves it within ~250ms instead of blocking for
// the full window on a dead network.
async function isOnline(shouldStop = () => false, timeoutMs = 12000) {
  const urls = ['https://connectivitycheck.gstatic.com/generate_204', 'https://www.google.com/generate_204']; // NEUTRAL connectivity endpoints only — never ping facebook.com from the operator's REAL IP (this probe runs un-proxied via Node axios, so it would touch FB directly + be correlatable). General internet reachability is all we need here.
  const all = Promise.all(urls.map((u) => probe(u, timeoutMs))).then((r) => r.some(Boolean));
  let iv;
  const cap = new Promise((resolve) => {
    const start = Date.now();
    iv = setInterval(() => { if (shouldStop() || Date.now() - start >= timeoutMs) resolve(false); }, 250);
  });
  try { return await Promise.race([all, cap]); }
  finally { clearInterval(iv); }
}

function matchesFilter(post, filter) {
  if (filter === 'with-comments') return !!(post.comment && post.comment.trim());
  if (filter === 'without-comments') return !(post.comment && post.comment.trim());
  return true;
}

// POST-SETS gate: an account assigned to a post-set draws ONLY from that set; no set (null/absent) = the whole
// library (backward-compatible default). The single choke-point so every post-selection path honors the set.
function postsForSet(allPosts, account) {
  const sid = account && account.postSetId;
  if (!sid) return allPosts;
  return allPosts.filter((p) => (p.postSetId || null) === sid);
}

// Deterministic shuffle seeded by a number (so a given cycle/account is reproducible).
function seededShuffle(arr, seed) {
  const a = arr.slice();
  let s = seed || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += Math.max(1, size)) out.push(arr.slice(i, i + size));
  return out;
}

class Orchestrator {
  // Fix #4: accept options object with isLoginOpen predicate.
  constructor(emit, options) {
    this.emit = emit;
    this.options = options || {};
    this._proxyHealth = new ProxyHealthManager(); // E-X3: per-proxy failure tracking + cool-down
    this.isLoginOpen = (this.options && typeof this.options.isLoginOpen === 'function') ? this.options.isLoginOpen : () => false;
    this.isCheckOpen = (this.options && typeof this.options.isCheckOpen === 'function') ? this.options.isCheckOpen : () => false; // a read-only membership check holds this account's profile → skip it (don't profile-kill a live check)
    this.running = false;
    this._stop = false;
    this._paused = false;
    this._finish = false;
    this._aborters = new Set();
    this._progress = { running: false, paused: false, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0, accounts: [] };
    this._owed = {};          // PERSISTENT partial-delivery ledger { agentName -> { postId, gids[] } }: a daily-rotation / campaign-plan agent that delivered its post to SOME but not all of its groups still owes the un-reached groups the SAME post; carried across cycles/days (loaded from rotation.json owedLedger) so the un-reached groups are never silently skipped and a delivered group is never re-posted. [7][8]
    this._inflightDelivered = new Set(); // R5 (UNIQUE/SEQUENCE ONLY): durable per-(post,group) delivered-guard reconstructed from the crash journal by _recoverInflightJournal. A unique/sequence delivery is NEVER re-delivered, so this guard can safely make a resumed PARTIAL post skip the groups it already reached (no double-post) — NEVER used for daily-rotation/campaign-plan, which legitimately RE-DELIVER (a durable guard there would permanently suppress the re-delivery). Purged per-post on full delivery; rebuilt from the journal each fold. Not persisted — derived from the journal.
    this._acctLive = {};      // name → { state, action, posted } live per-account view for the dashboard
    this._cycleAccts = [];    // the active accounts of the current cycle (snapshot source)
    this._lastAcctEmit = 0;   // throttle for high-frequency per-account action updates
  }
  isRunning() { return this.running; }
  // F4: operator "start fresh" — clear the dealt-state + rotation so the next Start re-deals every post
  // from #1. Guarded to the STOPPED state (so it can't race a live cycle) and routes through the same
  // checked saveRotation; if the write fails we report it and the next Start re-reads disk (no silent
  // re-post across restart). Does NOT delete posts.
  resetRotation() {
    if (this.isRunning()) return { ok: false, error: 'Stop the automation before resetting the rotation.' };
    // FULL reset (the button says "start fresh"): clear ALL rotation state in memory AND on disk — the shared
    // unique/sequence dealt-set + round offset, the per-agent daily-rotation/campaign-plan pointers, the
    // campaign plan, and the daily-run marker. A partial write (dealt only) used to silently WIPE the per-agent
    // + campaign state from disk while memory kept it → an inconsistent restart. Now everything restarts at #1.
    this._dealt = new Set();
    this._roundOffset = 0;
    this._staggerRotation = 0;
    this._perAccountRotation = {};
    this._campaignPlan = null;
    this._pendingPlanBatchId = null; // #2: no plan → no deferred edit pending
    this._lastDailyRunDate = null;
    this._nextCycleAt = 0; // absolute fire time (ms) for the NEXT subsequent daily cycle in a multi-cycle run; 0 = not armed
    this._owed = {}; // Start Fresh clears the partial-delivery owed ledger too (a new run starts every post at #1 to ALL groups)
    this._inflightSeq = {}; this._journalHigh = 0; // R5: drop the per-agent inflight watermarks — a fresh campaign supersedes nothing
    this._inflightDelivered = new Set(); // R5: drop the unique/sequence crash-durable delivered-guard too — Start Fresh re-deals every post to ALL groups from #1
    const wrote = store.saveRotation({ dealt: [], roundOffset: 0, staggerRotation: 0, lastDailyRunDate: null, perAccountRotation: {}, campaignPlan: null, owedLedger: {}, inflightSeq: {} });
    if (!wrote) return { ok: false, error: 'Could not write rotation state (disk full / permissions).' };
    // Also reset the DASHBOARD progress ledger so the plan view restarts clean (the permanent run-report.jsonl
    // audit is preserved). Best-effort — a ledger-clear failure must not fail the rotation reset.
    try { store.clearProgress(); } catch {}
    // ALSO clear the HELD (moderation) + pending-comment RECOVERY queues — a "Start Fresh" must NOT carry over
    // un-recovered held posts from a previous run, which a reserve would otherwise re-post DURING the new run
    // (the "a different/old post just appeared" surprise). Best-effort: a clear failure must not fail the reset.
    try { store.saveModeration({ held: [] }); } catch {}
    try { store.saveComments({ pending: [] }); } catch {}
    // R5: drop the crash-durability inflight journal too — else the next Start's fold would replay stale committed lines
    // back into the just-cleared dealt-set / pointers (silently skipping those posts in the fresh campaign).
    try { store.compactInflight(() => false); } catch {}
    try { store.compactObligations(() => false); } catch {} // v1.0.72: drop the crash-durability obligation journal too — a fresh campaign owes no held/comment recovery
    this.log('🔄 Campaign rotation reset — all modes restart from #1 on the next Start (shared deal + per-agent daily/campaign pointers cleared; held/comment recovery queues cleared; dashboard progress reset).');
    return { ok: true };
  }
  stop() {
    this._stop = true;
    this._paused = false;
    this._stopNetMonitor();
    if (this._progressTimer) { try { clearTimeout(this._progressTimer); } catch {} this._progressTimer = null; } // cancel any pending coalesced live-ops emit
    this._progress.paused = false;
    for (const abort of [...this._aborters]) {
      try { abort(); } catch {}
    }
    this.emit('automation-progress', { ...this._progress });
  }
  _registerAborter(abort) {
    if (typeof abort !== 'function') return () => {};
    this._aborters.add(abort);
    return () => this._aborters.delete(abort);
  }
  _shouldStop() { return this._stop; }
  // #5 multi-drop-per-reserve. _jobbedThisCycle is a Map(accountName → #browser jobs this cycle). An account may do up
  // to reserveMaxJobsPerCycle jobs (default 1 = today's one-job/account/cycle). Re-clamped 1..5 here so a hand-edited
  // data.json can't yield 0 or unbounded. _jobbedOut also tolerates a legacy Set (some tests set one) → binary.
  _reserveMaxJobs() { const v = Math.round(Number((this._data && this._data.settings && this._data.settings.reserveMaxJobsPerCycle)) || 1); return Math.min(5, Math.max(1, v || 1)); }
  _jobbedOut(name) { const j = this._jobbedThisCycle; if (!j) return false; const c = (typeof j.get === 'function') ? (j.get(name) || 0) : (j.has && j.has(name) ? 1 : 0); return c >= this._reserveMaxJobs(); }
  _markJob(name) { if (!(this._jobbedThisCycle instanceof Map)) this._jobbedThisCycle = new Map(); this._jobbedThisCycle.set(name, (this._jobbedThisCycle.get(name) || 0) + 1); }
  pause() {
    if (!this.running || this._paused) return;
    this._paused = true;
    this._progress.paused = true;
    this.log('⏸ Paused — holding before the next action');
    this.emit('automation-paused');
    this.emit('automation-progress', { ...this._progress });
  }
  resume() {
    if (!this.running || !this._paused) return; // never "resume" a dead run (UI desync guard)
    this._paused = false;
    this._progress.paused = false;
    this.log('▶️ Resumed');
    this.emit('automation-resumed');
    this.emit('automation-progress', { ...this._progress });
  }
  finish() {
    if (!this.running) return;
    this._finish = true;
    this.log('🏁 Finishing after the current batch — no new work will start');
    // If the run is PAUSED, Finish would otherwise deadlock: the loop is parked in _waitWhilePaused (which only exits
    // on resume or stop), so the "current batch" can never complete and the run hangs forever showing "Finishing…".
    // Resume so the in-flight batch drains, then the _finish flag ends the run cleanly. resume() self-guards.
    if (this._paused) this.resume();
  }
  isPaused() { return this._paused; }
  // Is this account posting RIGHT NOW (its profile browser is open)? Used to allow logging in any OTHER account
  // mid-run without a profile conflict — only the actively-posting account is off-limits.
  isAccountInFlight(name) { const l = this._acctLive && this._acctLive[name]; return !!(l && l.state === 'running'); }
  async _waitWhilePaused() { while ((this._paused || this._diskHalt) && !this._stop && !this._finish) { if (this._diskHalt) this._evalDiskHalt(); await sleep(500); } } // B1: also HOLD while disk is critically low (a SEPARATE flag from operator-pause), re-evaluating each tick so it auto-resumes the instant space is freed. Honor _finish too (like _waitForConnectivity): finish() can't clear _diskHalt (only _evalDiskHalt does, >2GB), so without this a Finish during a <1GB disk-halt would PARK the pool forever at "Finishing…" — only a hard Stop escaped. Draining is safe: the launch guards (!this._finish) already block new work on a full disk.

  async _waitForConnectivity() {
    let offlineLogged = false;
    while (!this._shouldStop() && !this._finish) { // honor Finish too — an offline Finish must DRAIN + end, not park here forever
      if (await isOnline(() => this._shouldStop() || this._finish)) {
        if (offlineLogged) {
          this.log('🌐 Connection restored — continuing');
          if (this._progress) { this._progress.offline = false; this.emit('automation-progress', { ...this._progress }); }
        }
        return true;
      }
      if (!offlineLogged) {
        offlineLogged = true;
        this.log('🌐 No internet connection — holding until it returns...');
        if (this._progress) { this._progress.offline = true; this.emit('automation-progress', { ...this._progress }); }
      }
      await this._interruptibleSleep(jitter(15000, 0.4)); // T15: re-check ~9-21s (jittered), break instantly on Stop
    }
    return false;
  }
  // CONTINUOUS connectivity monitor: while a run is active, probe every ~15s (faster while down). Going offline
  // flags `_netOnline=false` (the pool stops launching new accounts) + shows "offline" in the dashboard; coming
  // back clears it + the run resumes. This is the PROACTIVE companion to the per-account fast-bail and the
  // cycle-top _waitForConnectivity hold (which remain the authoritative resume gates / re-probe directly).
  _startNetMonitor() {
    this._netOnline = true;
    const tick = async () => {
      this._netTimer = null;
      if (!this.running) return;
      let up = true;
      try { up = await isOnline(() => this._shouldStop() || !this.running, 8000); } catch { up = false; }
      if (!this.running) return;
      if (!up && this._netOnline !== false) {
        this._netOnline = false;
        this.log('🌐 Connection lost — auto-pausing; the run resumes on its own when you\'re back online.');
        if (this._progress) { this._progress.offline = true; this.emit('automation-progress', { ...this._progress }); }
      } else if (up && this._netOnline === false) {
        this._netOnline = true;
        this.log('🌐 Connection restored — resuming.');
        if (this._progress) { this._progress.offline = false; this.emit('automation-progress', { ...this._progress }); }
      }
      this._netTimer = setTimeout(tick, this._netOnline === false ? 5000 : 15000); // poll faster while down
    };
    this._netTimer = setTimeout(tick, 15000);
  }
  _stopNetMonitor() { if (this._netTimer) { try { clearTimeout(this._netTimer); } catch {} this._netTimer = null; } this._netOnline = true; }

  log(msg) { this.emit('automation-log', msg); }

  // ── LIVE PER-ACCOUNT SNAPSHOT ──────────────────────────────────────────────
  // Powers the dashboard "Live Operations" panel: every active account of the current cycle with its live
  // state (queued → running → done/error/...) and current action. Shipped inside each automation-progress
  // event so the UI shows ALL accounts at once, not just the few running in parallel.
  _buildAcctSnapshot() {
    const useProx = !!(this._data && this._data.useProxies);
    const poolN = ((this._data && this._data.proxies) || []).filter((p) => p && String(p).trim()).length;
    const proxyHost = (s) => { const m = String(s || '').replace(/^\w+:\/\//, ''); return m.split(':')[0] || ''; };
    // SOURCE = the cycle's active pool PLUS any account that has LIVE state this cycle — i.e. reserves / stand-ins that
    // stepped in via takeover, held-repost, or comment-rescue. Without this, those reserves work but never show in Live
    // Operations. _acctLive is reset per cycle (start of cycle), so a stepped-in reserve is always current, never stale.
    const byName = {};
    for (const a of (this._cycleAccts || [])) byName[a.name] = a;
    for (const a of ((this._data && this._data.accounts) || [])) if (!byName[a.name]) byName[a.name] = a; // display fields for reserves not in the pool
    const poolNames = new Set((this._cycleAccts || []).map((a) => a.name));
    const names = new Set([...poolNames, ...Object.keys(this._acctLive || {})]);
    return [...names].map((name) => {
      const a = byName[name] || { name };
      const l = (this._acctLive && this._acctLive[name]) || {};
      const ip = a.proxy && String(a.proxy).trim() ? proxyHost(a.proxy) : (useProx && poolN ? 'pool' : 'real IP');
      // A standby account, OR any account that acted but was NOT in the starting pool, is a reserve/stand-in.
      const role = (a.standby || !poolNames.has(name)) ? 'reserve' : 'active';
      return { name, alias: a.alias || name, role, groups: (a.assignedGroups || []).length, state: l.state || 'queued', action: l.action || '', posted: l.posted || 0, ip };
    });
  }
  // Coalesced live-ops emit (leading + trailing throttle, ~400ms). At 400 accounts the snapshot is a 400-element
  // array; emitting it on EVERY per-account state/action tick serialized it over IPC hundreds of times per cycle
  // (renderer churn that steals CPU from the posting pool on the one client laptop). The _acctLive map is updated
  // SYNCHRONOUSLY by the callers, so no state is lost — only the EMIT is rate-limited. The leading edge fires
  // immediately when idle (snappy for a small fleet); a trailing timer guarantees the FINAL state is delivered.
  _emitLiveOps() {
    // Keep _progress.accounts CURRENT synchronously (building the JS array is cheap; the expensive part we throttle is
    // the cross-process IPC serialization + renderer re-render). This guarantees the always-fired end-of-run emit
    // carries the final states even if a pending throttled emit is cancelled by stop().
    this._progress.accounts = this._buildAcctSnapshot();
    if (this._progressTimer) return; // an emit is already scheduled → it will ship the latest snapshot on fire
    const now = Date.now();
    const MIN = 400;
    const doEmit = () => { this._lastLiveEmit = Date.now(); this._progress.accounts = this._buildAcctSnapshot(); this.emit('automation-progress', Object.assign({}, this._progress)); };
    const since = now - (this._lastLiveEmit || 0);
    if (since >= MIN) doEmit();
    else this._progressTimer = setTimeout(() => { this._progressTimer = null; doEmit(); }, MIN - since);
  }
  // ── DISK-SPACE SAFETY (400-account fleets) ────────────────────────────────
  // Each account keeps a persistent Chrome profile (+ caches) under userData/accounts/<name>/. 400 profiles are tens
  // of GB; if the drive fills, writeFileAtomic throws ENOSPC and posting dies FLEET-WIDE (data.json/cookies/rotation
  // can't save). These give the operator warning before that happens. Best-effort + non-blocking (never stop a run
  // the operator wants) — fs.statfsSync is Node 18.15+/20+ (Electron 35); older/edge → null → silently skipped.
  _freeDiskBytes() {
    try {
      const fsx = require('fs');
      if (typeof fsx.statfsSync !== 'function') return null;
      const dir = (store.paths && store.paths.USER_DATA) || process.cwd();
      const s = fsx.statfsSync(dir);
      return (Number(s.bavail) || 0) * (Number(s.bsize) || 0);
    } catch { return null; }
  }
  // Warn if free space looks insufficient. Called once at Start and periodically per cycle (throttled ~15min).
  _diskPreflight(getData) {
    try {
      const free = this._freeDiskBytes();
      if (free == null) return;
      const now = Date.now();
      if (this._lastDiskWarn && now - this._lastDiskWarn < 15 * 60 * 1000) return; // don't spam
      const data = (typeof getData === 'function' ? getData() : this._data) || {};
      const nAcc = (data.accounts || []).filter((a) => a && a.enabled !== false && !a.isModerator).length;
      const GB = 1024 * 1024 * 1024;
      const PER = 200 * 1024 * 1024; // ~200 MB per persistent Chrome profile (profile + capped caches + images)
      const need = nAcc * PER;
      const freeGB = (free / GB).toFixed(1);
      if (free < 2 * GB) { this._lastDiskWarn = now; this.log(`⚠️ LOW DISK: only ${freeGB} GB free on the data drive. A FULL disk stops ALL accounts mid-run (posts/cookies can't save → ENOSPC). Free up space now.`); }
      else if (nAcc >= 20 && free < need) { this._lastDiskWarn = now; this.log(`⚠️ DISK: ${freeGB} GB free may not hold ${nAcc} account profiles (~${Math.round(need / GB)} GB at ~200 MB each). If it fills mid-run, posting halts fleet-wide — add space or reduce accounts.`); }
    } catch {}
  }
  // B1: HARD disk floor BELOW the advisory _diskPreflight warn tier. Sets a SEPARATE `_diskHalt` flag (never the
  // operator's `_paused`) that gates every browser launch through _waitWhilePaused: auto-PAUSE the fleet under 1 GB so a
  // filling drive can't hit ENOSPC and halt everything mid-post, auto-RESUME over 2 GB (hysteresis so it can't flap).
  // Logs ONLY on a transition. Between-launch hold only — never aborts a live post (data stays consistent).
  _evalDiskHalt() {
    try {
      const free = this._freeDiskBytes();
      if (free == null) return;
      const GB = 1024 * 1024 * 1024;
      if (!this._diskHalt && free < 1 * GB) {
        this._diskHalt = true;
        this.log(`🛑 DISK CRITICAL: only ${(free / GB).toFixed(2)} GB free — auto-PAUSING all posting to prevent an ENOSPC halt (your data stays safe). Free some space; posting resumes automatically above 2 GB.`);
      } else if (this._diskHalt && free > 2 * GB) {
        this._diskHalt = false;
        this.log(`✅ DISK recovered: ${(free / GB).toFixed(2)} GB free — resuming posting.`);
      }
    } catch {}
  }
  // B2: reclaim Chrome's UNBOUNDED cache growers BETWEEN cycles (called before the inter-cycle wait, when the pool +
  // rescue + repost have all drained). Deletes ONLY ephemeral cache dirs — NEVER Cookies/Network, Local Storage,
  // IndexedDB, Service-Worker CacheStorage, or Preferences (that would log the account out / lose identity; the durable
  // login is the SEPARATE accounts/<name>/cookies.json regardless, never inside chrome-profile). Skips the moderator
  // (its background approval browser may still be open). SAFE against a stray open browser: Windows locks in-use cache
  // files so rmSync skips them. Best-effort; a locked/missing dir is silently ignored. Complements B1's auto-pause: this
  // keeps the disk from filling in the first place so the pause rarely has to fire.
  _pruneProfileCaches(getData) {
    try {
      const fs = require('fs'), path = require('path');
      const data = (typeof getData === 'function' ? getData() : this._data) || {};
      const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad'];
      let n = 0;
      for (const a of (data.accounts || [])) {
        if (!a || a.isModerator || !a.name) continue;
        let prof; try { prof = store.profileDir(a.name); } catch { continue; }
        for (const base of [prof, path.join(prof, 'Default')]) { // cache dirs live at the profile root AND under its Default profile folder
          for (const d of CACHE_DIRS) {
            const p = path.join(base, d);
            try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); n++; } } catch {} // a locked (in-use) or missing dir is skipped — never corrupts a live browser
          }
        }
      }
      if (n) this.log(`🧹 Reclaimed ${n} Chrome cache folder(s) between cycles (cookies/identity untouched) — keeps the disk from filling on a long run.`);
    } catch {}
  }
  // E (observability): write a machine-readable status.json for an away operator polling remotely, and log a HEALTH line
  // hourly, so a slowly-degrading run (accounts benching one by one, disk-halted, stuck with no recent post) is visible
  // from afar instead of only on physical return. Read-only over EXISTING counters; driven by a 5-min timer, never the
  // per-post critical path — a slow/failed status write can't perturb pacing or the single-IP loop.
  _emitHealth() {
    try {
      const p = this._progress || {};
      const benched = Object.entries(this._runFlags || {}).map(([name, flag]) => ({ name, flag }));
      const now = Date.now();
      const lastAgo = this._lastPostAt ? Math.round((now - this._lastPostAt) / 1000) : null;
      const status = {
        running: !!this.running, paused: !!this._paused, diskHalt: !!this._diskHalt, offline: !!p.offline,
        cycle: p.cycle || 0, posted: p.posted || 0, errors: p.errors || 0, pending: p.pending || 0,
        accountsDone: p.accountsDone || 0, accountsTotal: p.accountsTotal || 0,
        benchedCount: benched.length, benched,
        lastPostAgoSec: lastAgo, uptimeSec: this._runStartedAt ? Math.round((now - this._runStartedAt) / 1000) : 0,
        ts: now,
      };
      try { store.writeStatus(status); } catch {}
      if (!this._lastHealthLog || now - this._lastHealthLog >= 60 * 60 * 1000) {
        this._lastHealthLog = now;
        const ago = lastAgo == null ? 'never' : ((lastAgo < 90 ? lastAgo + 's' : Math.round(lastAgo / 60) + 'm') + ' ago');
        this.log(`💓 HEALTH — cycle ${status.cycle} · ${status.posted} posted · ${status.errors} err · ${status.benchedCount} benched · last post ${ago}${status.paused ? ' · PAUSED' : ''}${status.diskHalt ? ' · DISK-LOW-PAUSE' : ''}${status.offline ? ' · OFFLINE' : ''}`);
      }
    } catch {}
  }
  // State change (queued/running/done/error/...). Map updated now; emit is coalesced (see _emitLiveOps).
  _setAcctState(name, state, extra) {
    if (!this._acctLive) this._acctLive = {};
    this._acctLive[name] = Object.assign({}, this._acctLive[name] || {}, { state }, extra || {});
    this._emitLiveOps();
  }
  // Current action (one per worker log line) — high frequency, coalesced like state changes.
  _setAcctAction(name, msg) {
    if (!this._acctLive) this._acctLive = {};
    const a = String(msg || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim().slice(0, 140);
    if (!a) return;
    this._acctLive[name] = Object.assign({}, this._acctLive[name] || {}, { action: a });
    this._emitLiveOps();
  }

  // E-X3/E-X4: proxy health tracking. reportProxy is handed to the worker; getProxyHealth feeds the
  // /api/proxies/health endpoint + the diagnostics. Health tracking never blocks a post.
  _proxyHealthFile() { return path.join((store.paths && store.paths.USER_DATA) || '', 'proxy-health.json'); }
  reportProxy(proxyStr, ok, reason) { if (!proxyStr) return; try { ok ? this._proxyHealth.markOk(proxyStr) : this._proxyHealth.markFail(proxyStr, reason); } catch {} }
  getProxyHealth() { try { return this._proxyHealth.getStats(); } catch { return { proxies: [], summary: { total: 0, healthy: 0, failing: 0, onCooldown: 0 } }; } }

  // Human-readable label for a postingOrder value.
  _modeLabel(order) {
    const MAP = {
      'post-centric': 'Post-Centric',
      'random': 'Random',
      'sequence': 'Sequence',
      'post-centric-unique': 'Post-Centric-Unique',
      'random-unique': 'Random-Unique',
      'daily-rotation': 'Daily Rotation (1 new post/day per agent)',
      'campaign-plan': 'Campaign Plan (each group-set gets the whole library, split across its agents, 1/day)',
    };
    return MAP[order] || order;
  }

  async start(getData, opts = {}) {
    if (this.running) return { success: false, error: 'Automation already running' };
    // A manual operator Start (opts.manual — the dashboard Start button AND "Save & Start") is a fresh "run NOW":
    // runNow fires the first cycle immediately AND we reset the in-memory daily-cycle counter + bypass today's
    // per-account pacing quota (_dailyQuotaBlocks) so clicking Start actually posts even if today's scheduled run
    // already happened. The daily fire-time then only governs the UNATTENDED next-day auto-start (the scheduled-task
    // path passes runNow WITHOUT manual → it still respects the schedule + quota). Consumed on the first gate pass.
    this._runNow = !!(opts.runNow || opts.manual);
    this._manualRun = !!opts.manual;
    this._manualBypassUsed = new Set(); // per-account ONE-SHOT quota bypass for a manual Start (reset each Start) — see _dailyQuotaBlocks
    if (this._manualRun) { this._dailyCycleDate = this._localDayKey(); this._dailyCycleCount = 0; this._nextCycleAt = 0; }
    this._stop = false; this._paused = false; this._finish = false; this._recordLossHalt = false; this._crashed = false; this._diskHalt = false; this.running = true; // _recordLossHalt reset so a Stop→Start AFTER fixing the disk/lock actually recovers (the sticky R2 halt would otherwise re-fire after the first account). _crashed (A1) + _diskHalt (B1) reset per run.
    this._modLoop = false; // reset so a quick Stop→Start re-arms the concurrent moderator loop (a still-draining prior loop must not block the new one)
    this._runGen = (this._runGen || 0) + 1; // generation token: a moderator loop from a PRIOR Start self-terminates when this bumps — the _modLoop flag alone can't tear it down because start() flips running/_stop back before the old loop re-checks them (it would otherwise survive a quick Stop→Start that landed mid-approval, accumulating duplicate loops over a multi-day run)
    this._approving = false; // never start a run with a stuck approval guard
    this._modBackoffUntil = 0; this._modLoggedOutWarned = null; // moderator logged-out back-off (so a dead admin doesn't re-launch every 75s)
    this._aborters.clear();
    this._progress = { running: true, paused: false, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0, offline: false, accounts: [] };
    this._acctLive = {}; this._cycleAccts = []; this._lastLiveEmit = 0;
    if (this._progressTimer) { try { clearTimeout(this._progressTimer); } catch {} this._progressTimer = null; }
    this._lastDiskWarn = 0;
    this._runStartedAt = Date.now();
    this._runStats = {}; // per-account totals across the whole run (for the end-of-run summary)
    this._runFlags = {}; // accountName -> flag set THIS run (rate_limited/checkpoint/etc.)
    this._owedUncoveredWarned = new Set(); // M1: campaign agents already warned this run about owed groups with no reserve coverage
    this._claimed = new Set(); // post ids claimed by an account this cycle (reset each cycle)
    this._lastReserveKey = null; // force this run's first cycle to log its reserve set + uncovered-group warning
    this._heldCount = {}; this._warmWarned = {}; // per-run held-post tallies → "account needs warming" alert
    this.emit('automation-started');
    this.emit('automation-progress', { ...this._progress });
    this.log(`▶️ Automation started — ${new Date().toLocaleString()}`);
    this._diskPreflight(getData); // warn BEFORE a long run if the drive can't hold the fleet's profiles (a full disk halts all accounts)
    this._startNetMonitor(); // watch connectivity for the whole run (auto-pause offline / auto-resume online)
    this._runStartedAt = Date.now(); this._lastPostAt = 0; this._lastHealthLog = 0; // E: run-health tracking for an away operator
    this._emitHealth(); // write an initial status.json immediately
    this._healthTimer = setInterval(() => { try { this._emitHealth(); } catch {} }, 5 * 60 * 1000); // E: refresh status.json every 5 min (+ a HEALTH log line hourly)
    // #1 (stall breaker): a throw ANYWHERE in the ~1440-line cycle body used to unwind the WHOLE run — a night crash then
    // sat DEAD until a human relaunched (A1 only recovers on the next LAUNCH). Auto-restart the loop IN-PROCESS instead:
    // re-entering _loop reloads durable state from disk + re-folds the crash journal (a relaunch, minus the human) so no
    // progress is lost. crashRestartDecision runs the breaker — only RAPID consecutive crashes count (max 3) with a growing
    // backoff so a deterministic crash-loop can't hammer the shared IP; only then is it tagged 'crashed' (A1 keeps run-active
    // for the next launch to resume). A clean return (Stop / Finish / Completed / give-up) exits normally.
    (async () => {
      let restarts = 0;
      for (;;) {
        const startedAt = Date.now();
        try { await this._loop(getData); return; } // clean end
        catch (e) {
          const d = crashRestartDecision(restarts, Date.now() - startedAt);
          restarts = d.restarts;
          if (this._shouldStop()) { this.log(`⏹ Orchestrator error during stop: ${e && e.message}`); return; } // Stop wins → reason 'stopped', not 'crashed'
          if (!d.restart) { this._crashed = true; this.log(`❌ Orchestrator crashed: ${e && e.message} (${restarts} rapid crashes in a row) — stopping; the next launch will resume from disk.`); return; } // A1: 'crashed' keeps run-active
          this.log(`⚠️ Orchestrator cycle crashed: ${e && e.message} — auto-restarting the loop in ${Math.round(d.backoffMs / 1000)}s (attempt ${restarts}/3; durable state reloaded from disk, no progress lost).`);
          // #6 (healthy-uptime fix): CLEAR the healthy timer at the crash MOMENT — BEFORE the backoff — so a stale
          // pre-crash timer can't fire _markHealthy during the backoff. A cycle crashing in [healthyMs-backoff, healthyMs)
          // (e.g. ~9m40s with a 30s backoff) would otherwise let the T=0 timer cross 10 min mid-backoff and reset BOTH
          // relaunch caps during an active crash sequence → unbounded relaunch. Re-armed by 'automation-restarted' below.
          this.emit('automation-crashed');
          try { await this._interruptibleSleep(d.backoffMs); } catch {}
          if (this._shouldStop()) return;
          // #6 (healthy-uptime fix): an in-process restart re-enters _loop WITHOUT re-emitting 'automation-started', so the
          // main-process 'healthy' timer kept measuring wall-clock-since-START, not crash-free uptime — during a
          // deterministic thrash where each doomed cycle outlives 10 min it fired _markHealthy and reset BOTH watchdog caps
          // → unbounded relaunch on the shared IP. Signal each restart so main.js re-arms the timer from NOW (it then fires
          // only after 10 CONTINUOUS crash-free minutes).
          this.emit('automation-restarted');
        }
      }
    })()
      .finally(() => {
        this._stopNetMonitor();
        if (this._healthTimer) { try { clearInterval(this._healthTimer); } catch {} this._healthTimer = null; } // E: stop the health timer
        this.running = false;
        this._aborters.clear();
        this._progress.running = false;
        this._progress.paused = false;
        this.emit('automation-progress', { ...this._progress });
        const reason = this._crashed ? 'crashed' : (this._stop ? 'stopped' : (this._finish ? 'finished' : 'completed')); // A1: 'crashed' preserves run-active for auto-resume
        this._emitSummary(reason);
        this.emit('automation-stopped', reason);
        this.log(`⏹ Automation ${reason}.`);
        try { this._emitHealth(); } catch {} // E: final status.json write reflecting the terminal state (running:false)
      });
    // Concurrent moderator: a SECOND browser approves held "Spam potentiel" posts in the BACKGROUND while
    // the posting pool keeps running — the operator never has to stop. Self-gates on moderationEnabled.
    this._startModeratorLoop(getData);
    return { success: true };
  }

  // End-of-run roll-up: a single clear summary for the operator (logged + emitted as a
  // structured event the UI can render + appended to the persistent run report).
  _emitSummary(reason) {
    const durationMs = Date.now() - (this._runStartedAt || Date.now());
    const byAccount = this._runStats || {};
    // "Pending" = work still OUTSTANDING at run end — posts held for moderator approval + link-comments
    // not yet placed — read from the authoritative stores. NOT the cumulative tally of everything ever sent
    // to approval (which never decremented as items got approved/delivered, so it over-reported).
    let pendingNow = 0;
    try { pendingNow += (store.loadModeration().held || []).filter((h) => h.status === 'held').length; } catch {}
    try { pendingNow += (store.loadComments().pending || []).filter((c) => c.status === 'pending' && (c.attempts || 0) < 3).length; } catch {}
    const summary = {
      reason,
      posted: this._progress.posted || 0,
      pending: pendingNow,
      errors: this._progress.errors || 0,
      cycles: this._progress.cycle || 0,
      durationMs,
      byAccount,
      finishedAt: new Date().toISOString(),
    };
    // Accounts that hit a Facebook limit this run — list them with the EXACT action to take.
    const ACTION = {
      rate_limited: 'wait — Facebook is rate-limiting it (it retries automatically next cycle)',
      checkpoint: 'OPEN this account and complete Facebook’s identity / “real person” check',
      needs_verification: 'OPEN this account and complete Facebook’s identity / “real person” check',
      not_logged_in: 'log in again (its session expired)',
      needs_login: 'log in again (its session expired)',
      account_disabled: 'check it on Facebook — the account is disabled/restricted',
      likely_blocked: 'check it on Facebook — it posted nothing (likely blocked/restricted)',
      proxy_invalid: 'fix this account’s proxy in the Accounts tab — it was skipped so it never posts from your real IP',
    };
    const flagged = Object.entries(this._runFlags || {}).map(([name, flag]) => ({ name, flag, action: ACTION[flag] || 'check this account on Facebook' }));
    summary.flagged = flagged;

    const m = Math.floor(durationMs / 60000), s = Math.round((durationMs % 60000) / 1000);
    this.log('📋 ═══ RUN SUMMARY ═══');
    this.log(`📋 Posted: ${summary.posted}  |  Pending: ${summary.pending}  |  Errors: ${summary.errors}  |  Cycles: ${summary.cycles}  |  Duration: ${m}m ${s}s`);
    for (const [acc, st] of Object.entries(byAccount)) {
      this.log(`📋 [${acc}] posted=${st.posted} pending=${st.pending} errors=${st.errors}`);
    }
    if (flagged.length) {
      this.log('📋 ⚠️ ACCOUNTS NEEDING ATTENTION:');
      for (const f of flagged) this.log(`📋   • ${f.name} → ${f.action}`);
    }
    this.emit('automation-summary', summary);
    try { store.appendReport({ ts: summary.finishedAt, account: '(run summary)', group: '', groupId: '', postId: '', result: `summary:${reason}`, comment: '', detail: `posted=${summary.posted} pending=${summary.pending} errors=${summary.errors} cycles=${summary.cycles} duration=${m}m${s}s` }); } catch {}
  }

  // Cycle position (1-based) of `postId` within the delivering account's CURRENT-round campaign slice — stamped
  // onto each delivery record so the dashboard can group the Campaign plan BY CYCLE (not by calendar day). A
  // reserve/stand-in that covered another agent's slice-post resolves via ANY agent's slice. 0 = unknown / not a
  // campaign slice. Cheap indexOf, called once per delivered group-record. Display-only — never gates posting.
  _slicePosOf(name, postId) {
    try {
      if (!postId) return 0;
      const acc = ((this._active || []).find((a) => a && a.name === name)) || (((this._data && this._data.accounts) || []).find((a) => a && a.name === name));
      const lists = (this._campaignPlan && this._campaignPlan.agentLists) || null;
      if (lists) {
        const own = lists[name] || [];
        const i = own.indexOf(postId); if (i >= 0) return i + 1;
        for (const n2 of Object.keys(lists)) { const j = (lists[n2] || []).indexOf(postId); if (j >= 0) return j + 1; } // reserve/stand-in covered another agent's slice
      }
      if ((acc && acc.postingOrder) === 'daily-rotation') {
        const list = ((this._data && this._data.posts) || []).filter((p) => matchesFilter(p, (acc && acc.postFilter) || 'all'));
        const i = list.findIndex((p) => p && p.id === postId); return i >= 0 ? i + 1 : 0;
      }
    } catch {}
    return 0;
  }

  // Choose the posts a given account publishes this cycle. `claim`=true (at run time) reserves
  // the post for this account so a parallel account can't grab the same one; failed claims are
  // released so another account picks them up (see _runAccount).
  // DAILY PACING for daily-rotation / campaign-plan: an account posts up to settings.cyclesPerDay posts per LOCAL day,
  // spaced so they can't cluster. Returns TRUE when the account must NOT post yet. For N=1 this is BYTE-IDENTICAL to the
  // original "posted today (1/day)" + "~20h midnight-straddle floor". N>1 only relaxes the daily PACING — the SAME post
  // is never re-delivered (the caller advances the per-agent pointer; dealt-set + _cycleDelivered still block duplicates).
  _dailyQuotaBlocks(rec, name, claim) {
    // Manual Start = a fresh "run now": let EACH account bypass the daily pacing cap ONCE (post immediately even if it
    // already posted today), then fall through to the normal cap on every LATER cycle — a ONE-SHOT per account, NOT a
    // persistent bypass (a persistent one would defeat the 1/day-or-cyclesPerDay cap for the whole run → real
    // over-posting on any Stop→Start or long unattended run). The dealt-set + pointer-advance still prevent any
    // same-post→same-group duplicate; only this account's per-day COUNT/spacing cap is skipped for its first cycle.
    if (this._manualRun && name && this._manualBypassUsed && !this._manualBypassUsed.has(name)) { if (claim) this._manualBypassUsed.add(name); return false; } // consume the one-shot ONLY on the REAL run (claim=true). A read-only plan-preview probe (claim=false, the daily/campaign planning header) must NOT burn it — otherwise the actual run finds the name already "used", falls through to the normal cap, and a daily-rotation/campaign account that already posted today posts NOTHING on a manual Start (defeating the whole feature).
    const s = (this._data && this._data.settings) || {};
    const N = Math.max(1, Math.min(20, parseInt(s.cyclesPerDay, 10) || 1));
    const today = this._localDayKey();
    // posts-today count. A pre-cyclesPerDay (or externally-stamped) record has lastPostedDate but no postsToday — treat
    // its "posted today" as 1 so N=1 stays BYTE-IDENTICAL to the old lastPostedDate===today guard and legacy jars are safe.
    const done = (rec && rec.postsTodayDate === today) ? (Number(rec.postsToday) || 0)
      : ((rec && rec.lastPostedDate === today) ? 1 : 0);
    if (done >= N) return true; // hit today's N-post quota
    // spacing floor: N=1 → the original ~20h straddle trap (unchanged). N>1 → smaller (< the inter-cycle gap so each
    // cycle can post, but ≥25min so posts never cluster); the gate's rest-until-tomorrow prevents a midnight straddle.
    const gapMin = (Number(s.cycleGapMin) > 0) ? Number(s.cycleGapMin) : (Number(s.waitIntervalMin) || 90); // the inter-cycle gap the floor scales off
    const floorMs = (N <= 1) ? (20 * 60 * 60 * 1000) : Math.max(30 * 1000, Math.floor(gapMin * 60000 * 0.5)); // N>1: a small anti-glitch floor (≥30s, ~half the cycle gap) — the cycle STRUCTURE spaces the posts, so "time between cycles" is yours to set (30s floor lets sub-minute cycle gaps take effect; the per-action anti-spam floors still gate each post/comment)
    if ((Date.now() - (Number((rec && rec.lastPostedAt)) || 0)) < floorMs) return true;
    return false;
  }

  // The wait BETWEEN cycles: an explicit cycleGapMin (minutes, +up to 30% jitter so the cadence isn't a fixed spam
  // tell) if the operator set one, else the speed preset's waitInterval range. Floored at 5min. Used by BOTH the
  // daily-run inter-cycle gap and the continuous-mode "next cycle" wait.
  _interCycleMs(settings) {
    const g = Number(settings && settings.cycleGapMin) || 0;
    // cycleGapMin (store-clamped ≥0.5min = 30s) + up to 30% jitter, else the speed preset's waitInterval range VERBATIM —
    // which may be 0 (instant / back-to-back cycles). NO floor here: continuous + daily-N=1 must honor 0; only the
    // multi-cycle DAILY gate applies its own ≥30s floor (where cycles must not fire faster than the per-account spacing).
    return (g > 0) ? Math.floor(g * 60000 * (1 + Math.random() * 0.3)) : rangeMs(settings, 'waitIntervalMin', 'waitIntervalMax', 90, 180, 60000, 1);
  }

  // The daily-schedule wait decision, extracted so the multi-cycle firing SEQUENCE is unit-testable. The v1.0.78
  // infinite-re-wait bug lived here: a SUBSEQUENT cycle must arm an ABSOLUTE fire time (this._nextCycleAt) ONCE and
  // count DOWN to it — re-deriving a fresh gap on every loop re-entry never reaches 0, so the cycle would wait forever
  // and never fire. Returns ms to wait before the next cycle (0 = fire NOW); mutates this._nextCycleAt. Pure given
  // (settings, N, doneToday, runNow, nowMs) + this.{_lastDailyRunDate, _nextCycleAt}.
  _dailyCycleWaitMs(settings, N, doneToday, runNow, nowMs) {
    if (doneToday >= N) { this._nextCycleAt = 0; return this._msUntilDailyFire(settings.dailyPostTime, this._localDayKey(new Date(nowMs)), nowMs); } // all N done today → rest until TOMORROW's fire time (nowMs threaded so the "did we run today?" day-key + the wait are computed at the SAME instant → deterministic)
    if (doneToday === 0) { this._nextCycleAt = 0; return runNow ? 0 : this._msUntilDailyFire(settings.dailyPostTime, this._lastDailyRunDate, nowMs); } // first cycle of the day → wait for dailyPostTime
    if (runNow) { this._nextCycleAt = 0; return 0; } // "Save & Start" fires the next cycle immediately
    if (!this._nextCycleAt) this._nextCycleAt = nowMs + Math.max(30 * 1000, this._interCycleMs(settings)); // subsequent cycle: arm the fire time ONCE (floored 30s; per-action anti-spam floors still pace each post within a cycle)
    return Math.max(0, this._nextCycleAt - nowMs);
  }

  _postsForAccount(account, cycle, claim = false, claimedSet = this._claimed) {
    const data = this._data;
    // Reserve STAND-IN (campaign takeover) — handled FIRST, before any set/filter/group gate: a reserve covering a
    // dropped campaign-plan agent must deliver that agent's EXACT pre-assigned post regardless of the reserve's OWN
    // postSetId or postFilter (otherwise a reserve in a different set would filter the stand-in post out → no takeover).
    const _stand = (this._campaignTakeover || {})[account.name];
    if (_stand) { const sp = data.posts.find((p) => p.id === _stand.postId); return sp ? [sp] : []; }
    const filtered = postsForSet(data.posts, account).filter((p) => matchesFilter(p, account.postFilter || 'all'));
    if (!filtered.length) return [];
    // An account with NO assigned groups can't post anywhere — never assign it a post. Otherwise, in
    // unique mode, it would "claim" a post it can't deliver and the campaign-complete probe could never
    // reach zero, looping the run forever with zero progress.
    if (!(account.assignedGroups && account.assignedGroups.length)) return [];
    const order = account.postingOrder || 'post-centric';
    const unique = order.includes('unique') || order === 'sequence';
    // (Reserve stand-in is resolved at the TOP of this method now — before the set/filter gate — so a takeover
    // reserve delivers the dropped agent's exact post even when its own postSetId points to a different set.)

    // DAILY ROTATION (per-agent): this account posts ONE post per LOCAL DAY to its groups, advancing its
    // OWN pointer one step each day (independent of other agents and of the shared dealt-set). Anti-repeat:
    // the next pick is never the same post id it used yesterday. If the operator edits/reorders the library
    // the agent simply continues from its last post (or restarts if that post is gone). The pointer +
    // last-posted-date live in this._perAccountRotation (persisted), keyed by account name — so swapping an
    // account in/out never disturbs the others. Returns [] once the agent has already posted today (1/day).
    if (order === 'daily-rotation') {
      const list = filtered; // stable library order = the rotation order
      const rec = (this._perAccountRotation && this._perAccountRotation[account.name]) || {};
      if (this._dailyQuotaBlocks(rec, account.name, claim)) return []; // daily PACING: up to cyclesPerDay posts/day (N=1 = the original 1/day + ~20h midnight-straddle floor). Never re-posts the SAME post (pointer advances below). Pass `claim` so the manual one-shot bypass is spent by the real run, not the read-only plan preview.
      // PERSISTENT OWED (partial-delivery carry-over, [7]): if a prior cycle/day left groups un-reached for a post,
      // finish THAT post FIRST — return it (its delivery is scoped to ONLY the owed groups in _runAccount's onlyGroups)
      // instead of advancing to the next post, so the un-reached groups are never skipped and no delivered group is
      // ever re-posted. Advancing waits until the owed post is fully covered (then the pointer moves on normally).
      const owedDR = this._owed && this._owed[account.name];
      if (owedDR && owedDR.postId && (owedDR.gids || []).length) {
        const _asg = this._groupIdsOf(account); // prune owed groups the operator has since UN-assigned — otherwise a removed group keeps re-picking an undeliverable owed post forever (targetGroups empties → nothing lands → owed never clears → the rotation livelocks)
        const _live = owedDR.gids.filter((gid) => _asg.has(gid));
        const op = _live.length ? list.find((p) => p.id === owedDR.postId) : null;
        if (op) { if (claim && _live.length !== owedDR.gids.length) this._owed[account.name] = { postId: owedDR.postId, gids: _live }; return [op]; }
        if (claim) { try { delete this._owed[account.name]; } catch {} } // owed post gone from the library OR all owed groups un-assigned → drop the stale obligation, fall through to the normal next pick
      }
      const li = rec.lastPostId ? list.findIndex((p) => p.id === rec.lastPostId) : -1;
      let nextIdx = li < 0 ? 0 : (li + 1) % list.length;
      let pick = list[nextIdx];
      if (list.length > 1 && pick && pick.id === rec.lastPostId) pick = list[(nextIdx + 1) % list.length]; // anti-repeat
      return pick ? [pick] : [];
    }

    // CAMPAIGN PLAN (per-cluster split): this agent walks ITS pre-assigned slice of the library (computed by
    // _computeCampaignPlan so its group-set collectively covers the whole library), 1 post/LOCAL-day, in
    // order, until its slice is done. The slice + daily pacing are tracked exactly like daily-rotation
    // (perAccountRotation pointer). Returns [] once the agent finished its slice OR already posted today.
    if (order === 'campaign-plan') {
      // (Reserve stand-in is handled above, before the order dispatch, so it covers any reserve postingOrder.)
      const plan = this._campaignPlan;
      const listIds = (plan && plan.agentLists && plan.agentLists[account.name]) || [];
      if (!listIds.length) return [];
      const crec = (this._perAccountRotation || {})[account.name] || {};
      if (this._dailyQuotaBlocks(crec, account.name, claim)) return []; // daily PACING: up to cyclesPerDay posts/day (N=1 = the original 1/day + ~20h floor). The per-agent slice pointer (below) still advances → never the same post twice. Pass `claim` so the manual one-shot bypass is spent by the real run, not the read-only plan preview.
      // PERSISTENT OWED (partial-delivery carry-over, [8]): finish an earlier slice-post's un-reached groups FIRST
      // (scoped to only those groups in _runAccount) before advancing the slice pointer, so a campaign agent that
      // dropped mid-slice never permanently skips groups and never re-posts a delivered one. Looked up in the full
      // library (not the slice) so a reshuffled plan still finds it.
      const owedCP = this._owed && this._owed[account.name];
      if (owedCP && owedCP.postId && (owedCP.gids || []).length) {
        const _asg = this._groupIdsOf(account); // prune un-assigned owed groups (see daily-rotation above) so a removed group can't livelock the slice on an undeliverable owed post
        const _live = owedCP.gids.filter((gid) => _asg.has(gid));
        const op = _live.length ? (data.posts || []).find((p) => p.id === owedCP.postId) : null;
        if (op) { if (claim && _live.length !== owedCP.gids.length) this._owed[account.name] = { postId: owedCP.postId, gids: _live }; return [op]; }
        if (claim) { try { delete this._owed[account.name]; } catch {} } // owed post gone from the library OR all owed groups un-assigned → drop the stale obligation, fall through to the slice pointer
      }
      const n = this._campaignNextIdx(account.name);
      if (n.idx >= n.len) return []; // this agent finished its slice (batch done for it)
      const post = data.posts.find((p) => p.id === listIds[n.idx]);
      return post ? [post] : [];
    }

    if (!unique) {
      // post-centric / random -> account posts ALL its eligible posts each cycle.
      // "Posts Per Group" caps how many posts an account makes per cycle (each post goes to
      // all of the account's groups). 0/blank = no cap (post all eligible).
      const ppg = Number.isFinite(data.settings.postsPerGroup) && data.settings.postsPerGroup > 0 ? data.settings.postsPerGroup : filtered.length;
      const list = order.includes('random') ? seededShuffle(filtered, (cycle + 1) * 7919) : filtered;
      return list.slice(0, ppg);
    }

    // UNIQUE / SEQUENCE -> deal each post exactly ONCE across the active accounts, round-robin.
    //
    // [NO OWED PICK-OVERRIDE HERE — DELIBERATE. See ADR-0021 (SUPERSEDED/REJECTED).]
    // v1.0.110 added one so a unique/sequence PARTIAL could re-pick its dealt post and finish the un-reached groups.
    // An adversarial audit of that machinery returned FIVE recurring double-posts on the ban axis: a delivered
    // (post,group) re-posted EVERY cycle on the ONE shared IP. Root cause is architectural and PRE-DATES [9]: the owed
    // ledger's CONSUMERS (_hasPersistentOwed / the persistent-owed synthesis / _owedStandins / _owedSelf) are
    // MODE-AGNOSTIC, while the producer of its discharge record (the _cycleObligation gate) is mode-restricted — so an
    // entry whose owner cannot discharge it becomes IMMORTAL and is re-dispatched to a reserve forever. Extending the
    // ledger to unique/sequence multiplied that blast radius from "a pointer agent someone switched modes" to "every
    // unique agent on a unique fleet". The full suite stayed GREEN throughout, because the crash-fold reconciles the
    // ledger on every process start: any test modelling the next cycle as a NEW PROCESS self-heals, and only a HEALTHY
    // days-unattended run accumulates the duplicates (crashes self-heal; health accumulates).
    //
    // The trade is deliberately ASYMMETRIC. Without an override an un-reached group STRANDS — recoverable, and bounded:
    // measured 17/1491 pairs (1.1%) on the operator's own finished campaign, all in the shared-IP throttle tail, and the
    // SAME-CYCLE reserve cover (_cycleOwed, recorded below — unchanged and dry-verified) already recovers most of that.
    // WITH an override we risk a ban, which ends the entire fleet. A strand costs ~1%; a ban costs everything.
    // The real lever for that tail is PROXIES (87% of the campaign's errors were shared-IP throttle), not cross-cycle
    // re-delivery. Do NOT re-add this without: (a) live validation, and (b) a test that runs N cycles in ONE process
    // with NO fold in between (the blind spot that hid all five double-posts).
    //
    // `remaining` = posts not yet dealt AND not already claimed by another account this cycle.
    let remaining = filtered.filter((p) => !this._dealt.has(p.id) && !(claimedSet && claimedSet.has(p.id)));
    if (!remaining.length) return [];
    if (order.includes('random')) remaining = seededShuffle(remaining, (cycle + 1) * 7919); // randomized deal order (consistent within the cycle)
    const activeList = this._active || data.accounts.filter((a) => a.enabled !== false && !a.isModerator && a.standby !== true);
    const i = activeList.findIndex((a) => a.name === account.name);
    if (i < 0) return [];
    // roundOffset rotates which account gets which post across Loop-campaign recycles.
    const k = (i + (this._roundOffset || 0)) % activeList.length;
    // Positional deal; if this slot is past the posts left (earlier accounts claimed/freed theirs),
    // pick up the FIRST still-available post so a healthy account is never idle while content waits.
    // Genuine surplus — MORE accounts than undealt posts — idles naturally: once the pool is claimed,
    // `remaining` empties and the `!remaining.length` guard above returns [] for the rest. (This is why
    // the fix for the "all → Post #10" plan is purely the dry-run-CLAIM in the display, not the picker:
    // a claimless display let every account see the same single remaining post.)
    const pick = remaining[k < remaining.length ? k : 0];
    if (claim && claimedSet) claimedSet.add(pick.id);
    return [pick];
  }

  // Returns { progressed, posted, pendingApproval, errors }. Rotation only advances
  // when progressed, so a fully-crashed account retries the SAME post next cycle.
  async _runAccount(account, cycle, maxThisRun) {
    const data = this._data;
    const accountStart = Date.now();
    const posts = this._postsForAccount(account, cycle, true); // claim at run time so parallel accounts don't collide
    // #5: did THIS account actually CLAIM its posts? Claims are added (_postsForAccount ~762) ONLY on the unique/sequence
    // pick path — a stand-in returns earlier (~666) and campaign-plan/daily-rotation/post-centric never claim. Capture the
    // discriminator NOW (same synchronous instant _postsForAccount read _campaignTakeover) so the finally releases ONLY
    // self-made claims; deleting a DIFFERENT unique account's live claim from the shared _claimed set = deal-once/double-post.
    const _madeClaims = !(this._campaignTakeover && this._campaignTakeover[account.name]) && ((account.postingOrder || '').includes('unique') || account.postingOrder === 'sequence');
    if (!posts.length) {
      // Surface WHY this account posted nothing. Otherwise a MISCONFIGURED account (no groups / empty post-set /
      // filter excludes everything) idles all run, reading as a healthy 'done' on the dashboard with no stated reason.
      // Read-only, using the SAME gate helpers as _postsForAccount so the label is accurate. Only the misconfig
      // branches set lastMessage; the legitimate cases (already posted today / pool exhausted) get the soft else
      // string and persist nothing, so the dashboard is untouched for them. Additive — the [] return is unchanged.
      const _inSet = postsForSet(data.posts, account);
      const _eligible = _inSet.filter((p) => matchesFilter(p, account.postFilter || 'all'));
      let _why = '';
      if (!(account.assignedGroups && account.assignedGroups.length)) _why = 'no assigned groups — assign groups in the Accounts tab';
      else if (account.postSetId && _inSet.length === 0) _why = "its post-set has 0 posts — tag posts to that set (Posts tab) or clear the account's post-set";
      else if (_eligible.length === 0) _why = `the '${account.postFilter || 'all'}' filter excludes every post`;
      this.log(`↪️ [${account.name}] no eligible posts${_why ? ' — ' + _why : ' (its content for this cycle is already dealt / posted today — nothing to do)'}`);
      if (_why) { try { await store.update((d) => { const a = d.accounts.find((x) => x.name === account.name); if (a) a.lastMessage = '⏭️ Posted nothing — ' + _why; }); this.emit('data-updated'); } catch {} }
      return { progressed: false, posted: 0, pendingApproval: 0, errors: 0, postedIds: [], dealtIds: [] };
    }
    const order = account.postingOrder || 'post-centric';
    const isUnique = order.includes('unique') || order === 'sequence';
    const modeLabel = this._modeLabel(order);
    const kGroups = (account.assignedGroups || []).length;
    const filterVal = account.postFilter || 'all';
    const filterLabel = filterVal === 'with-comments' ? 'With comments' : filterVal === 'without-comments' ? 'Without comments' : 'All posts';
    const allFiltered = data.posts.filter((p) => matchesFilter(p, filterVal));

    // Per-account intro lines (mirrors original format)
    if (isUnique) {
      this.log(`[${account.name}] 🔒 Pre-assigned 1 unique post`);
    }
    this.log(`[${account.name}] [FILTER] ${filterLabel} (${allFiltered.length})`);
    if (isUnique && posts.length === 1) {
      const postNum = data.posts.findIndex((p) => p.id === posts[0].id) + 1;
      this.log(`[${account.name}] 📋 Mode: ${modeLabel} → Post #${postNum} to all ${kGroups} groups`);
    } else {
      this.log(`[${account.name}] 📋 Mode: ${modeLabel} → all ${kGroups} groups`);
    }
    // Log only an EXPLICIT per-account override (safe/fast/max) so the run log never understates how aggressively an
    // account is running (matters for ban/rate-limit triage). No override → the account inherits the fleet speed (no line).
    const _PACE_LABELS = { safe: '🛡️ Safe (full human)', fast: '⚡ Fast (paste, full gaps)', max: '🚀 Max (aggressive)' };
    const _effPace = (account.pace === 'safe' || account.pace === 'fast' || account.pace === 'max') ? account.pace : null;
    if (_effPace) this.log(`[${account.name}] ⏱ Pace: ${_PACE_LABELS[_effPace] || _effPace}`);
    this.log(`[${account.name}] 🚀 Starting...`);
    let progressed = false, posted = 0, pendingApproval = 0, errors = 0, accountFlag = null, accountOffline = false;
    let accountCrashes = 0; // M3-09: consecutive posts that crashed out for this account
    const postedIds = []; // posts confirmed PUBLISHED — safe to auto-delete
    const dealtIds = [];  // posts dealt this cycle (published OR pending) — don't re-deal
    // Per-(post,group) dedup applies in deal-once modes (campaign-plan/unique/sequence), the per-agent daily-rotation
    // (so a partial delivery's delivered groups are TRACKED for the owed ledger AND a crash-retry never re-posts a
    // group it already reached), OR when this account is a reserve STAND-IN — NEVER in broadcast modes
    // (post-centric/random). _onlyGroups routes an OWED cover to ONLY the un-reached groups.
    const _ord = account.postingOrder || 'post-centric';
    const _stand = (this._campaignTakeover || {})[account.name] || null;
    const _dedup = (_ord === 'campaign-plan' || _ord.includes('unique') || _ord === 'sequence' || _ord === 'daily-rotation' || !!_stand);
    // R5 [HOLE 1]: only a GENUINE unique/sequence self-delivery (not a stand-in) consults the crash-durable
    // _inflightDelivered guard. It must be UNIQUE/SEQUENCE ONLY: daily-rotation/campaign-plan RE-DELIVER, and a
    // durable delivered-guard there would permanently suppress the legit re-delivery. A stand-in only ever covers a
    // rotation/campaign agent (unique/sequence never spawn owed/stand-ins), so exclude _stand. This gate ALSO avoids
    // any key collision: campaign-plan uses the same empty _dkScope prefix as unique/sequence, so without it a
    // campaign-plan lookup of a shared post id could match a unique post's guard key.
    const _uniqueSeqGuard = !_stand && (_ord.includes('unique') || _ord === 'sequence');
    // Ledger-key scope of the RESPONSIBLE agent (the covered agent when this run is a reserve stand-in, else this
    // account). Per-agent for daily-rotation, fleet-wide otherwise — see _dkScope. Keeps two daily-rotation accounts
    // that share a group from clobbering each other's delivery, while a stand-in's deliveries still count for the
    // covered agent's owed reconcile.
    const _dkPrefix = this._dkScope(_stand ? _stand.forAgent : account.name);
    // R5 crash-durability: the RESPONSIBLE agent (covered agent when this is a reserve stand-in, else this account) —
    // the key under which the delivery journal, the icommit/inflightSeq watermark and the pointer/owed/dealt fold all
    // agree. A per-account-run monotonic run-sequence: strictly greater than this agent's last clean-commit watermark
    // (icommit for rotation/campaign, inflightSeq for unique/sequence) AND any q already in the journal (journalHigh),
    // so a line committed this run is always superseded (fold no-op) and a line lost to a hard kill always survives.
    // journalHigh only grows (pool-wide + reseeded from the journal's max q at init), so even the shared-field write
    // race between parallel accounts is safe: at commit time this._runSeq is monotonically ≥ every q this run appended.
    const _respAgent = _stand ? _stand.forAgent : account.name;
    this._runSeq = Math.max(((this._perAccountRotation[_respAgent] || {}).icommit) || 0, (this._inflightSeq && this._inflightSeq[_respAgent]) || 0, this._journalHigh || 0) + 1;
    this._journalHigh = this._runSeq;
    // An agent DISCHARGING its own PERSISTENT owed post (daily-rotation / campaign-plan, from a prior cycle) covers
    // ONLY its still-owed groups — tied to the actually-picked post so a stale/deleted owed entry can't mis-scope a
    // different post. A reserve STAND-IN's onlyGroups (the dropped agent's un-reached groups) takes precedence. [7][8]
    // [LEDGER COHERENCE] owedScopableMode — the SCOPING predicate, deliberately NOT owedDischargeableMode (see both).
    // _owedSelf only ever REMOVES groups from this run's target set, so it can never cause a double-post — only its
    // ABSENCE can. It therefore covers the whole DEDUP family (incl. unique/sequence, where a mode-flipped agent may
    // still re-pick a pointer-accrued owed post off `remaining` and MUST stay scoped to the un-reached groups), and
    // excludes only the BROADCAST modes, where a stale entry matching a normally-picked post would starve the account's
    // other groups. Tied to the actually-picked post so a stale/deleted entry can't mis-scope a different one.
    const _owedSelf = (!_stand && this._owed && this._owed[account.name] && owedScopableMode(_ord)
      && posts.length === 1 && posts[0] && posts[0].id === this._owed[account.name].postId
      && Array.isArray(this._owed[account.name].gids) && this._owed[account.name].gids.length)
      ? this._owed[account.name] : null;
    const _onlyGroups = (_stand && Array.isArray(_stand.gids)) ? _stand.gids
      : (_owedSelf ? _owedSelf.gids : null);
    try {
    postsLoop:
    for (const post of posts) {
      if (this._shouldStop()) break;
      // Per-account crash isolation + restart (approximates the old supervisor that
      // could relaunch a crashed account worker independently).
      const MAX = 2;
      let crashedOut = false; // M3-09: did this post exhaust all retries with a CRASH?
      for (let attempt = 1; attempt <= MAX; attempt++) {
        try {
          const r = await runAccount({
            // Per-account PACE: applyPace → resolveEffectiveSettings SELECTS the effective tier (account.pace override
            // else the fleet baseline) per-post timing — NO multiplier / compounding. Only the WORKER gets this resolved
            // copy; orchestrator-level gaps (cycle/stagger) keep reading the unscaled data.settings, so a per-account pace
            // never changes pool cadence. Canonical tiers are safe|fast|max (legacy migrated at load). See lib/speed.js.
            account, maxThisRun, post, groups: data.groups, settings: applyPace(data.settings, account.pace),
            useProxies: !!data.useProxies, proxies: data.proxies || [], assignedProxy: (this._proxyForAccount ? this._proxyForAccount(account) : null), // cycle-pinned pool proxy the anti-link gate serialized on — worker must use the SAME one
            log: (m) => { this.log(m); this._setAcctAction(account.name, m); }, // mirror each worker step into the live dashboard panel
            shouldStop: () => this._shouldStop(),
            isLoginOpen: this.isLoginOpen, isCheckOpen: this.isCheckOpen,
            registerAborter: (abort) => this._registerAborter(abort),
            isOnline: () => isOnline(), // lets the worker bail fast when offline instead of burning nav timeouts
            ipPostGate: (projectedDelayMs) => this._ipPostGate(projectedDelayMs, !!(this._proxyForAccount && this._proxyForAccount(account))), // OPT-IN per-IP aggregate post spacing → ms to wait; pass the caller's inter-group gap so the shared clock reserves the REAL post instant (#13); pass THIS account's proxied status (#E) so a self-proxied account (distinct IP) is a no-op and doesn't pollute the shared real-IP clock; 0 = off / proxied
            reportProxy: (p, ok, reason) => this.reportProxy(p, ok, reason), // E-X3: per-proxy health from the worker
            isOnCooldown: (p) => { try { return this._proxyHealth.isOnCooldown(p); } catch { return false; } }, // skip a dead POOL proxy at pick time
            waitIfPaused: () => this._waitWhilePaused(), // Pause holds between groups, mid-account
            isPaused: () => this._paused,                // so the worker can suspend its watchdog while paused
            isDisabled: () => { try { const a = store.load().accounts.find((x) => x.name === account.name); return !!(a && a.enabled === false); } catch { return false; } }, // user turned this account OFF mid-run (read DISK fresh — this._data is frozen per cycle) → end its waits early

            // Per-(post,group) delivery ledger (deal-once / stand-in only): record a confirmed/held delivery and let
            // the worker skip a group already delivered this cycle. onlyGroups restricts a stand-in to the owed groups.
            markDelivered: _dedup ? (gid) => { try { if (post.id) { this._cycleDelivered.add(_dkPrefix + post.id + '::' + gid); store.appendInflight({ q: this._runSeq, a: _respAgent, o: _ord, s: _dkPrefix, p: post.id, g: gid, d: this._localDayKey(), t: Date.now() }); } } catch {} } : undefined, // t = REAL delivery instant (H1): lets the crash-fold measure true elapsed-since-post for the 20h anti-straddle floor instead of the restart instant. Additive/opaque field — loadInflight ignores unknowns, old lines simply carry no t.
            alreadyDelivered: _dedup ? (gid) => { try { if (!post.id) return false; const k = _dkPrefix + post.id + '::' + gid; return this._cycleDelivered.has(k) || (_uniqueSeqGuard && this._inflightDelivered && this._inflightDelivered.has(k)); } catch { return false; } } : undefined, // R5 [HOLE 1]: a resumed unique/sequence partial post ALSO skips the crash-surviving delivered groups (durable guard) — never for rotation/campaign (they re-deliver)
            journalObligation: (kind, rec) => { try { store.appendObligation({ k: kind, a: _respAgent, ...rec }); } catch {} }, // v1.0.72 crash-durability: durably record a held/comment obligation at CREATION → folded on the next Start if this account crashes before its return-persist (see _foldObligationJournal)
            onlyGroups: _onlyGroups,

            // Per-(account,group,post) outcome → append to the persistent audit trail.
            onResult: (rec) => { try { rec.round = this._roundOffset || 0; rec.cycle = this._slicePosOf(rec.account, rec.postId); if (!store.appendReport(rec) && !this._auditWarned) { this._auditWarned = true; this.log('⚠️ Could not write an audit-log row (disk full / permissions?) — the run continues but run-report.jsonl/.csv may be incomplete. Fix disk/permissions to restore the audit trail.'); } } catch {} },
          });
          if (r && r.offline) accountOffline = true;
          posted += (r && r.posted) || 0; pendingApproval += (r && r.pendingApproval) || 0; errors += (r && r.errors) || 0;
          // A post is "dealt" (rotation advances, not re-posted next cycle) if it published OR went
          // pending in ANY group — we never re-post to avoid duplicates. But it is only auto-DELETABLE
          // when it FULLY published to EVERY targeted group with no errors (r.fullyPosted); a partial
          // publish (landed in some groups, errored in others) must STAY in the library so it is never
          // lost. A pending post (admin may reject) also stays (never enters postedIds).
          if (r && (r.posted || 0) > 0) { progressed = true; if (post.id) { if (r.fullyPosted) postedIds.push(post.id); dealtIds.push(post.id); } }
          else if (r && (r.pendingApproval || 0) > 0) { progressed = true; if (post.id) dealtIds.push(post.id); }
          // Persist held posts (deduped) so a consumer can act on them: the MODERATOR approves, the Phase-4
          // RE-POST replaces, and the COMPLETION engine counts them (so it can't prematurely report success
          // while a post is held). Gated on those opt-ins — when all are off this is a no-op (behavior as before).
          if ((data.settings.moderationEnabled || data.settings.repostEnabled || data.settings.completionMode) && r && r.heldRecords && r.heldRecords.length) {
            try {
              // Serialized so two parallel accounts can't lost-update the held list (clobbering each other's appends).
              let _msOk = false;
              for (let _t = 0; _t < 3 && !_msOk; _t++) { // R2: retry a TRANSIENT persist failure (AV/OneDrive/indexer lock) — the mutator dedups (below) so a retry can never double-append
                if (_t) await this._interruptibleSleep(200); // SHORT backoff (kept small so the retry doesn't widen the crash-before-dealt-commit window)
                ({ ok: _msOk } = await store.updateModeration((ms) => {
                for (const h of r.heldRecords) {
                  // Skip if an ACTIVE or already-HANDLED record exists for this (post,group) — held (awaiting),
                  // superseded (a re-post was dispatched), or failed_held (re-post also held, capped). This stops
                  // a replacement's own hold (or a re-hold of the same post) from spawning a phantom fresh 'held'.
                  // Scope by posterAccount too: postId is the LIBRARY id (not a unique FB id), so two DIFFERENT accounts
                  // holding the SAME post in the SAME shared group are two genuinely distinct FB cards — without this the
                  // second is deduped away and its card is never approved + its comment lost. (Same-account re-hold still
                  // collapses.) Mirrors the poster-scoped handoff dedup. No double-post risk: two real cards, two accounts.
                  if (!ms.held.some((x) => x.postId === h.postId && x.gid === h.gid && (x.posterAccount || '') === (h.posterAccount || '') && (x.status === 'held' || x.status === 'superseded' || x.status === 'failed_held'))) {
                    ms.held.push({ ...h, status: 'held', permalink: null, heldAt: Date.now(), approvedAt: null, commentedAt: null });
                  }
                }
                }));
              }
              if (_msOk) {
                this.log(`📥 [${account.name}] ${r.heldRecords.length} post(s) held in "Spam potentiel" — moderator will try to approve (fallback; the comment lands once they're public)`);
                // A hold is a TRUST signal, not the routine path: FB's Spam-potentiel is account-signal-driven
                // (admin role does NOT bypass it), so the durable fix is account trust, not the scrape. Track
                // per-account holds and, once an account is held repeatedly this run, surface a clear, actionable alert.
                this._heldCount = this._heldCount || {};
                this._heldCount[account.name] = (this._heldCount[account.name] || 0) + r.heldRecords.length;
                if (this._heldCount[account.name] >= 2) {
                  this._warmWarned = this._warmWarned || {};
                  if (!this._warmWarned[account.name]) {
                    this._warmWarned[account.name] = 1;
                    this.log(`⚠️ [${account.name}] held ${this._heldCount[account.name]}× this run → FB doesn't trust it yet. Fix at the SOURCE (don't rely on the moderator): give it a DEDICATED proxy, ENABLE Warm-up, slow its cadence, and lead with your trusted accounts. Holds should be the exception, not the norm.`);
                  }
                }
                // EVENT TRIGGER: don't wait for the periodic loop — kick an approval pass NOW (guarded).
                this._kickApproval(data);
              } else {
                // saveModeration STILL failed after retries → the post is already counted dealt but its held record is
                // NOT on disk. Re-owning a held FB card would DOUBLE-POST, so keep it dealt (no double-post) and set the
                // sticky halt: the pool STOPS after this account commits its dealt set (below) so the operator fixes the
                // disk/lock before more records are lost. Warn LOUDLY (don't pretend it's queued).
                this._recordLossHalt = true;
                this.log(`🛑 [${account.name}] could NOT persist ${r.heldRecords.length} held-post record(s) after retries (disk full/locked?) — HALTING after this account (the post stays dealt, no double-post, but needs manual approval/comment). Check disk/permissions.`);
              }
            } catch (e) { this.log(`🛑 [${account.name}] could not persist held-post state: ${e.message} — held post(s) at risk of being uncommented`); }
          } else if (r && r.heldRecords && r.heldRecords.length) {
            // Posts are held in spam but moderator approval is OFF — a held post is not public, so NO
            // account can comment on it. Tell the operator the only fix (enable approval).
            this.log(`⚠️ [${account.name}] ${r.heldRecords.length} post(s) HELD in "Spam potentiel" but Moderator Approval is OFF — they stay held + uncommented. Turn on 🛡️ Moderator Approval (Groups tab) so the app approves them and adds the comment.`);
          }
          // Orphaned link-comments: posts that went LIVE but couldn't get their comment. Persist them
          // (deduped) so a healthy reserve account that's a member of the group can place the comment in
          // the rescue phase — a post is never left without its link.
          if (r && r.commentQueue && r.commentQueue.length) {
            try {
              // Serialized so parallel accounts can't lost-update the pending-comments list.
              let _csOk = false, added = 0;
              for (let _t = 0; _t < 3 && !_csOk; _t++) { // R2: retry a TRANSIENT persist failure — the mutator dedups (below) so a retry can never double-append
                if (_t) await this._interruptibleSleep(200);
                ({ ok: _csOk, result: added } = await store.updateComments((cs) => {
                let n = 0;
                for (const c of r.commentQueue) {
                  // Dedup key, strongest-available identifier first: postId, else the post PERMALINK, else
                  // captionSnip SCOPED BY the posting account. At scale many distinct posts share a templated
                  // caption lead (and FB held-cards rarely carry a postId), so a bare gid+captionSnip key collapses
                  // DIFFERENT posts and silently drops a real orphaned comment — scope by posterAccount to avoid that.
                  if (!cs.pending.some((x) => x.gid === c.gid && x.status !== 'done' && (
                    (x.postId && c.postId) ? x.postId === c.postId
                    : (x.postPermalink && c.postPermalink) ? x.postPermalink === c.postPermalink
                    : (x.captionSnip === c.captionSnip && (x.posterAccount || '') === (c.posterAccount || ''))
                  ))) {
                    cs.pending.push({ ...c, status: 'pending', queuedAt: Date.now(), attempts: 0, commentedAt: null }); n++;
                  }
                }
                return n;
                }));
              }
              if (added && _csOk) this.log(`📌 [${account.name}] ${added} post(s) live but uncommented — queued for comment-rescue by a healthy account`);
              else if (added) { this._recordLossHalt = true; this.log(`🛑 [${account.name}] could NOT persist ${added} orphaned-comment record(s) after retries (disk full/locked?) — HALTING after this account (posts stay dealt, no double-post, but their link-comments need manual rescue). Check disk/permissions.`); }
            } catch (e) { this.log(`🛑 [${account.name}] could not persist comment-rescue queue: ${e.message} — orphaned comment(s) at risk`); }
          }
          // v1.0.72 CRASH-DURABILITY: this account's held/comment obligations are now durably in moderation/comments (or a
          // deferred comment was placed in Phase 2) → compact them out of the crash-journal so a CLEAN run leaves it empty
          // (no phantom re-fold on the next Start). A hard-kill BEFORE this point leaves them in the journal → recovered by
          // the fold. Keyed on posterAccount (= the account that ran, reserve or not). Best-effort.
          try { store.compactObligations((e) => (e && e.posterAccount) !== account.name); } catch {}
          // Persist flag to account status so the UI shows it (serialized via store.update).
          if (r && r.flag) {
            accountFlag = r.flag;
            this._runFlags[account.name] = r.flag; // remember for the end-of-run "needs attention" list
            try {
              await store.update((d) => {
                const acc = d.accounts.find(a => a.name === account.name);
                if (!acc) return;
                if (r.flag === 'needs_login') { acc.status = 'not_logged_in'; acc.lastMessage = '⚠️ Logged out during run — re-login required'; }
                else if (r.flag === 'rate_limited') { acc.status = 'rate_limited'; acc.lastMessage = '⏸ Rate-limited by Facebook (posting too often) — wait, then it retries automatically'; }
                else if (r.flag === 'needs_verification') { acc.status = 'checkpoint'; acc.lastMessage = '🔐 Facebook wants identity/human verification — open this account and complete the check'; }
                else if (r.flag === 'account_disabled') { acc.status = 'error'; acc.lastMessage = '🚫 Account disabled/restricted by Facebook — needs manual attention'; }
                else if (r.flag === 'likely_blocked') { acc.status = 'error'; acc.lastMessage = '⚠️ Posted nothing across its groups — likely blocked/restricted; check this account on Facebook'; }
                else if (r.flag === 'proxy_invalid') { acc.status = 'error'; acc.lastMessage = '🚫 Invalid proxy — account skipped (it won’t post from your real IP). Fix its proxy in the Accounts tab.'; }
              });
              this.emit('data-updated');
            } catch {}
            // Ping the user with a desktop notification when an account needs THEM (captcha /
            // verification, a re-login, a disabled account, or a likely block). main.js dedupes so
            // it won't spam across cycles. rate_limited is excluded — it auto-retries.
            if (['needs_verification', 'needs_login', 'account_disabled', 'likely_blocked', 'proxy_invalid'].includes(r.flag)) {
              this.emit('account-attention', { name: account.name, flag: r.flag });
            }
          }
          // Logged-out / rate-limited — don't launch a browser for this account's remaining posts this cycle.
          if (r && r.noRetry) { this.log(`⏭️ [${account.name}] skipping remaining posts this cycle (session/rate-limit)`); break postsLoop; }
          break;
        }
        catch (e) {
          errors++;
          this.log(`❌ [${account.name}] crashed (attempt ${attempt}/${MAX}): ${e.message}`);
          if (attempt >= MAX) crashedOut = true;
          if (attempt >= MAX || this._shouldStop()) break;
          await this._interruptibleSleep(jitter(5000, 0.5)); // T16: ~2.5-7.5s jittered crash-retry backoff
        }
      }
      // M3-09: if this post exhausted its retries with a CRASH, count it. After 2 crashed posts in a
      // row the account is likely broken (dead browser, corrupt profile, OOM) — stop burning the run
      // on it: skip its remaining posts this cycle and flag it for attention. Any non-crash resets.
      if (crashedOut) {
        if (++accountCrashes >= 2) {
          this.log(`🛑 [${account.name}] ${accountCrashes} posts crashed in a row — skipping its remaining posts this cycle (likely a broken profile/browser). Flagged for attention.`);
          accountFlag = accountFlag || 'likely_blocked';
          this._runFlags[account.name] = accountFlag;
          try { await store.update((d) => { const acc = d.accounts.find((a) => a.name === account.name); if (acc) { acc.status = 'error'; acc.lastMessage = '⚠️ The browser crashed repeatedly for this account — check its profile/proxy or recreate it.'; } }); this.emit('data-updated'); } catch {}
          this.emit('account-attention', { name: account.name, flag: accountFlag });
          break postsLoop;
        }
      } else accountCrashes = 0;
    }
    // Surface the outcome so the operator sees pending/error counts in the log pane.
    this.log(`[${account.name}] ✅ Done in ${Math.round((Date.now() - accountStart) / 1000)}s`);
    this.log(`📊 [${account.name}] posted=${posted} pending=${pendingApproval} errors=${errors}`);
    return { progressed, posted, pendingApproval, errors, postedIds, dealtIds, flag: accountFlag, offline: accountOffline };
    } finally {
      // Release claims for posts this account did NOT publish (blocked/failed), so a healthy account can pick them up
      // this same run. In a finally so it runs even if the body throws. #5: gate on _madeClaims — release ONLY claims
      // THIS account actually made (unique/sequence, non-stand-in); a campaign/daily/post-centric/stand-in run never
      // populated _claimed, so deleting `posts` ids here would release ANOTHER unique account's live claim (double-deal).
      if (this._claimed && _madeClaims) for (const pp of posts) { if (!dealtIds.includes(pp.id)) this._claimed.delete(pp.id); }
    }
  }

  // MODERATOR APPROVAL pass — approve OUR posts that FB held in the "Spam potentiel"/pending queue, so
  // they go public and their comment can land. Routes each held post to the moderator that covers its
  // group (group.moderatedBy, or the lone moderator). Runs both inside the cycle (end of pool) and ON
  // DEMAND via approveHeldNow(). shouldStop lets the cycle version abort on a Stop.
  // Lifecycle hygiene for the held queue so it can't wedge/grow forever: expire held posts we've never
  // been able to approve (FB removed/auto-approved them, or they're unmatchable) so the concurrent loop
  // stops relaunching a browser for them every cycle; prune old approved/failed records so the file stays
  // small. Runs UNCONDITIONALLY each _loop cycle (even when moderation is OFF) so toggling moderation off
  // doesn't freeze stale residue forever. Early-returns when the queue is empty (no needless load+save).
  _pruneModeration() {
    try {
      const ms0 = store.loadModeration();
      if (!ms0.held || !ms0.held.length) return;
      const now0 = Date.now(); let changed0 = false;
      const STALE = 90 * 60 * 1000, PRUNE = 24 * 3600 * 1000; // 90min so the moderator gets many more approval passes (it loops ~75s) before a held post is given up
      const repostOn = !!(this._data && this._data.settings && this._data.settings.repostEnabled);
      const FAILED_PRUNE = repostOn ? 7 * 24 * 3600 * 1000 : PRUNE; // with repost ON a 'failed' record is STILL a Phase-4 re-post candidate — keep it ~7d so a multi-run campaign keeps re-attempting it (it may simply never have had a free in-group reserve), instead of silently giving up at 24h
      const before = ms0.held.length;
      for (const h of ms0.held) { if (h.status === 'held' && h.heldAt && (now0 - h.heldAt) > STALE) { h.status = 'failed'; h.heldFailedAt = now0; h.note = 'not approvable within 90min (removed/auto-approved/unmatchable)'; changed0 = true; } } // heldFailedAt = repost-grace reference
      // Recover an INTERRUPTED Phase-4 re-post. A record is flipped to 'superseded' + persisted BEFORE runRepost is
      // awaited (~1707). A HARD process kill mid-re-post (Electron quit / power loss / OOM) skips every in-process
      // resolution path (→approved/failed_held/failed), leaving the record durably stuck as 'superseded' — INVISIBLE
      // to the Phase-4 'failed' candidate filter AND to _outstandingWork (so completion mode falsely reports
      // 'completed') AND silently pruned at 24h: a fully silent undelivered drop. A 'superseded' record can ONLY
      // survive to here when NO re-post is in flight (_approving blocks every prune during a genuine re-post), so a
      // stale one IS an interrupted re-post → revert to 'failed' to re-queue it. 30min ≫ any real re-post.
      for (const h of ms0.held) { if (h.status === 'superseded' && (now0 - (h.repostAt || h.heldFailedAt || h.heldAt || 0)) > 30 * 60 * 1000) { h.status = 'failed'; h.note = 're-post interrupted before completion (process killed mid-re-post) — re-queued'; changed0 = true; } } // R6: do NOT null repostedBy/repostedByDisplay — the re-armed re-post needs the reserve's identity so isContentLive can find the reserve's own live copy
      const _ageRef = (h) => (h.heldFailedAt || h.approvedAt || h.heldAt || 0);
      const _keep = (h) => h.status === 'held' || (_ageRef(h) > now0 - (h.status === 'failed' ? FAILED_PRUNE : PRUNE)); // 'failed' gets the longer ceiling so Phase-4 isn't cut off; approved/failed_held prune at 24h
      const _givenUp = ms0.held.filter((h) => h.status === 'failed' && !_keep(h)).length;
      ms0.held = ms0.held.filter(_keep);
      if (_givenUp) this.log(`⚠️ ${_givenUp} held post(s) GIVEN UP undelivered (held past the recovery window, never re-posted). Lead with warmed/trusted accounts + a moderator so Facebook doesn't hold them.`);
      if (changed0 || ms0.held.length !== before) store.saveModeration(ms0);
    } catch {}
  }

  async _runModeratorApproval(data, shouldStop) {
    shouldStop = shouldStop || (() => false);
    const settings = data.settings || {};
    // HARD CHOKEPOINT: every moderator-approval path goes through here, so this single gate GUARANTEES the moderator
    // account NEVER launches or acts when "Moderator Approval" is unchecked — re-read live each call, so toggling it
    // off (even mid-run) stops the very next pass. (The callers also gate, but this makes it impossible to bypass.)
    if (!settings.moderationEnabled) return { held: 0, moderators: 0, disabled: true };
    this._pruneModeration(); // hygiene FIRST so the queue can't wedge/grow
    const heldNow = (store.loadModeration().held || []).filter((h) => h.status === 'held');
    const moderators = (data.accounts || []).filter((a) => a.isModerator);
    if (!heldNow.length) { return { held: 0, moderators: moderators.length }; } // quiet — callers decide whether to announce
    if (!moderators.length) { this.log('⚠️ Posts are HELD in "Spam potentiel" but NO moderator is set — designate one in the Groups tab → 🛡️ Group Moderator (and log it in).'); return { held: heldNow.length, moderators: 0 }; }
    const modByName = new Map(moderators.map((m) => [m.name, m]));
    const groupModerator = (gid) => {
      const g = (data.groups || []).find((x) => (x.groupId || x.id) === gid);
      const named = g && g.moderatedBy ? modByName.get(g.moderatedBy) : null;
      return named || (moderators.length === 1 ? moderators[0] : null);
    };
    const byMod = new Map(); const unassigned = [];
    for (const h of heldNow) { const m = groupModerator(h.gid); if (!m) { unassigned.push(h); continue; } if (!byMod.has(m.name)) byMod.set(m.name, { mod: m, held: [] }); byMod.get(m.name).held.push(h); }
    if (unassigned.length) this.log(`⚠️ ${unassigned.length} held post(s) are in groups with no assigned moderator — set each group's moderator in the Groups tab.`);
    const posterNames = [...new Set((data.accounts || []).filter((a) => !a.isModerator && a.fbDisplayName && String(a.fbDisplayName).trim()).map((a) => String(a.fbDisplayName).trim()))];
    const { runModerator } = require('./moderator');
    let queued = 0;
    for (const { mod, held } of byMod.values()) {
      if (shouldStop()) break;
      const gids = new Set(held.map((h) => h.gid));
      const modGroups = (data.groups || []).filter((g) => gids.has(g.groupId || g.id));
      const r = await runModerator({ account: mod, groups: modGroups, settings, held, posterNames, useProxies: !!data.useProxies, proxies: data.proxies || [], log: (m) => this.log(m), shouldStop });
      // Moderator logged out → back off (stop re-launching it every cycle) + flag it for the operator. Otherwise a
      // usable moderator run clears any prior back-off so approvals resume the moment it's logged back in.
      if (r && r.flag === 'needs_login') { this._noteModeratorLoggedOut(mod.name); }
      else if (r && r.flag === 'proxy_invalid') { this._noteModeratorProxyInvalid(mod.name); } // else this fell into the clear below → re-launched a doomed browser every ~75s with no operator notice
      else if (r) { this._modBackoffUntil = 0; this._modLoggedOutWarned = null; this._modProxyWarned = null; }
      // APPROVE → COMMENT HANDOFF: for every post the moderator actually APPROVED (now public), mark its
      // moderation record approved (so it's never re-approved) and move its comment payload into the
      // pending-comments queue so the existing Phase-3 rescue runner adds the link-comment via a healthy
      // in-group account. Gated on !dryRun (a "would approve" must NOT queue anything).
      if (r && r.dryRun === false && Array.isArray(r.approvedRecords) && r.approvedRecords.length) {
        try { queued += await this._handoffApprovedToComments(r.approvedRecords); }
        catch (e) { this.log(`⚠️ approve→comment handoff failed: ${e.message}`); }
      }
    }
    if (queued) this.log(`✅ ${queued} approved post(s) handed to comment-rescue — a healthy account will add their link-comment.`);
    return { held: heldNow.length, moderators: moderators.length, queued };
  }

  // APPROVE → COMMENT HANDOFF. Given the held records the moderator just APPROVED (now public): (1) flip
  // each moderation record to 'approved' (so it's never re-approved — Phase-2/the picker only act on
  // status:'held'), and (2) enqueue its comment payload into the pending-comments queue so the existing
  // Phase-3 rescue runner places the link-comment via a healthy in-group account. Dedup is captionSnip-
  // PRIMARY (held cards usually have no postId, while an orphan-path entry may carry one — keying on
  // postId-first could miss a cross-path duplicate and double-comment). Returns the # of NEW comment tasks.
  async _handoffApprovedToComments(approvedRecords) {
    const recs = (approvedRecords || []).filter((h) => h && h.gid);
    if (!recs.length) return 0;
    // A record with NEITHER a captionSnip NOR a postId can't be deduped (every same() check would be
    // false → repeated double-comments + a held record that never marks approved). Drop those up front.
    const safe = recs.filter((h) => (h.captionSnip && String(h.captionSnip).trim()) || h.postId);
    const same = (x, h) => x.gid === h.gid && (
      (h.captionSnip && x.captionSnip) ? (x.captionSnip === h.captionSnip && (x.posterAccount || '') === (h.posterAccount || '')) // scope by poster: two DIFFERENT accounts' same-caption held posts in one group are distinct payloads — collapsing them silently drops the 2nd account's comment. Same post+account still dedups (and the postId branch also still catches them).
      : (!!x.postId && !!h.postId) ? x.postId === h.postId
      : (!!(h.postPermalink || h.permalink) && !!(x.postPermalink || x.permalink)) ? (h.postPermalink || h.permalink) === (x.postPermalink || x.permalink)
      : false);
    // ORDER + DURABILITY: queue the comment FIRST (serialized via _comChain), and flip the held record to
    // 'approved' ONLY after that save succeeded. The old order flipped approved first, so a failed comment-save
    // left an 'approved' record with NO comment and no recovery path (a silently lost link). Leaving it 'held'
    // on failure means the next moderator cycle retries + the 90-min prune escalates it to 'failed' for Phase-4.
    let added = 0;
    try {
      await store.updateComments((cs) => {
        for (const h of safe) {
          if (!(String(h.comment || '').trim() || h.commentImg)) continue; // review-fix: keep IMAGE-ONLY comments (text blank, image set) — a valid wanted comment (worker addFirstComment supports image-only); the old text-only guard silently dropped them, marking the post approved with its link-comment never placed
          if (cs.pending.some((x) => x.status !== 'done' && same(x, h))) continue; // already queued — no double-comment
          cs.pending.push({ gid: h.gid, postId: h.postId || null, posterAccount: h.posterAccount || null, fbDisplayName: h.fbDisplayName || null, groupName: h.groupName || null, captionSnip: h.captionSnip || null, postCaption: h.postCaption || h.captionSnip || null, comment: h.comment, commentImg: h.commentImg || null, postPermalink: h.permalink || h.postPermalink || null, status: 'pending', queuedAt: Date.now(), attempts: 0, commentedAt: null, source: 'approved' });
          added++;
        }
      });
    } catch (e) { this.log(`⚠️ could not queue approved post comment(s): ${e.message}`); return 0; } // do NOT approve if the comment couldn't be saved
    try {
      await store.updateModeration((ms) => {
        for (const h of safe) { const rec = (ms.held || []).find((x) => x.status === 'held' && same(x, h)); if (rec) { rec.status = 'approved'; rec.approvedAt = Date.now(); } }
      });
    } catch (e) { this.log(`⚠️ could not mark approved held record(s): ${e.message}`); }
    return added;
  }

  // Interruptible wait that wakes early when the run stops (used by the concurrent moderator loop).
  _modSleep(ms) {
    return new Promise((resolve) => {
      let waited = 0; const step = 1000;
      const id = setInterval(() => { waited += step; if (!this.running || this._stop || waited >= ms) { clearInterval(id); resolve(); } }, step);
    });
  }

  // Concurrent moderator loop — runs alongside the posting pool. Every ~2 min it checks the held queue
  // and, if there are held posts (and moderation is on + a moderator is set), runs an approval pass in a
  // SEPARATE browser. So spam-held posts get approved automatically, in the background, without the
  // operator ever stopping the run. Self-gates each tick (moderationEnabled can be toggled mid-run);
  // shares the _approving guard with the end-of-cycle sweep + manual trigger so passes never overlap.
  // Are moderator-approval passes currently BACKED OFF because the moderator account is logged out? (Set by
  // _noteModeratorLoggedOut after a probe returns needs_login.) Resumes EARLY the moment the operator re-logs the
  // moderator in (its status flips back to 'logged_in'); otherwise stays off for ~20 min so a dead admin browser
  // isn't re-launched every 75s (which competes with the posting browsers and slows the whole run).
  _modBackedOff(data) {
    if (!this._modBackoffUntil || Date.now() >= this._modBackoffUntil) return false;
    const reLoggedIn = ((data && data.accounts) || []).some((a) => a.isModerator && a.status === 'logged_in');
    if (reLoggedIn) { this._modBackoffUntil = 0; this._modLoggedOutWarned = null; this._modProxyWarned = null; return false; }
    return true;
  }
  // Unlink the LOCAL image files of auto-deleted posts — ONLY those UNDER the app's images dir (path containment:
  // imagePaths can come from the remote bulk API or a hand-edited data.json, so an outside/traversal/URL path must
  // NEVER be removed). Pure + best-effort; extracted so the containment guard is unit-testable.
  _unlinkDeletedImages(files, dir) {
    const _fs = require('fs');
    const base = dir ? path.resolve(dir) + path.sep : ''; // trailing sep so a SIBLING like "<images>-evil/" can't prefix-match
    for (const f of (files || [])) {
      try { if (f && base && path.resolve(f).startsWith(base)) _fs.unlinkSync(f); } catch {}
    }
  }
  // A moderator probe came back PROXY-INVALID — same back-off + operator alert as logged-out (else it re-launched a
  // doomed browser every ~75s with no UI signal). Held posts aren't lost: _pruneModeration graduates them to Phase-4 after 90 min.
  _noteModeratorProxyInvalid(name) {
    this._modBackoffUntil = Date.now() + 20 * 60 * 1000;
    try { store.update((d) => { const a = (d.accounts || []).find((x) => x.name === name); if (a) { a.status = 'error'; a.lastMessage = '🚫 Invalid proxy — fix it to approve held posts'; } }); } catch {}
    if (this._modProxyWarned !== name) {
      this._modProxyWarned = name;
      this.log(`🚫 Moderator "${name}" has an INVALID/UNREACHABLE proxy — held "Spam potentiel" posts can't be approved until you fix it (Accounts → ${name} → proxy). Pausing moderator checks ~20 min so it stops re-launching a dead browser.`);
      try { this.emit('account-attention', { name, flag: 'proxy_invalid', message: 'Moderator proxy is invalid — held posts are waiting for approval' }); } catch {}
    }
  }
  // A moderator probe came back LOGGED OUT — stop hammering it, mark it logged-out in the UI, and tell the operator
  // ONCE. Held posts aren't lost: _pruneModeration graduates them to the Phase-4 reserve re-post after 90 min.
  _noteModeratorLoggedOut(name) {
    this._modBackoffUntil = Date.now() + 20 * 60 * 1000;
    try { store.update((d) => { const a = (d.accounts || []).find((x) => x.name === name); if (a) { a.status = 'not_logged_in'; a.lastMessage = '🔐 Logged out — log in to approve held posts'; } }); } catch {}
    if (this._modLoggedOutWarned !== name) {
      this._modLoggedOutWarned = name;
      this.log(`🔐 Moderator "${name}" is LOGGED OUT — held "Spam potentiel" posts can't be approved until you log it back in (Accounts → ${name} → 🔄 Check, or 🔐 Login). Pausing moderator checks ~20 min so it stops re-launching a dead browser.`);
      try { this.emit('account-attention', { name, flag: 'needs_login', message: 'Moderator logged out — held posts are waiting for approval' }); } catch {}
    }
  }

  _startModeratorLoop(getData) {
    if (this._modLoop) return;
    this._modLoop = true;
    const CHECK_MS = 75000;
    const myGen = this._runGen; // own THIS run only — a Stop→Start parked inside _runModeratorApproval must not survive into the next run
    (async () => {
      await this._modSleep(8000); // brief settle, then approve early — also catches posts held on a PRIOR run before this one even produces a hold
      while (this.running && !this._stop && this._runGen === myGen) {
        try {
          const data = (typeof getData === 'function') ? getData() : (this._data || {});
          const on = !!(data.settings && data.settings.moderationEnabled);
          const held = on ? (store.loadModeration().held || []).filter((h) => h.status === 'held') : [];
          if (on && held.length && !this._approving && !this._paused && !this._modBackedOff(data)) {
            this._approving = true;
            this.log(`🛡️ Concurrent moderator: ${held.length} held post(s) detected — approving in the background (posting continues)…`);
            // #9: the abort signal is GENERATION-scoped — a quick Stop→Start bumps _runGen, so this in-flight pass aborts
            // PROMPTLY (tearing down its moderator Chromium) instead of running on un-aborted after start() reset _stop=false.
            try { await this._runModeratorApproval(data, () => this._stop || this._runGen !== myGen); }
            catch (e) { this.log(`⚠️ moderator loop error: ${e.message}`); }
            finally { if (this._runGen === myGen) this._approving = false; } // #9: release the single-flight guard ONLY for THIS generation — a stale prior-gen pass must not clear a guard the CURRENT run's pass now holds

          }
        } catch (e) { this.log(`⚠️ moderator loop: ${e.message}`); }
        await this._modSleep(CHECK_MS);
      }
      this._modLoop = false;
    })();
  }

  // EVENT-DRIVEN KICK — fire an approval pass the MOMENT new posts are held, instead of waiting for the
  // periodic _startModeratorLoop tick (~2 min). Non-blocking; the posting flow is never delayed. Fully
  // guarded against double-approve: shares the _approving flag with the periodic loop, the end-of-cycle
  // sweep, and approveHeldNow (set SYNCHRONOUSLY before any await, so two near-simultaneous kicks can't
  // both pass), self-gates on moderationEnabled + a moderator existing + run live/not-paused, and can
  // never throw an unhandled rejection.
  _kickApproval(data) {
    data = data || this._data || {};
    if (this._approving || this._paused || this._stop || !this.running) return;
    if (!(data.settings && data.settings.moderationEnabled)) return;
    if (!(data.accounts || []).some((a) => a.isModerator)) return;
    if (this._modBackedOff(data)) return; // moderator logged out → don't re-launch its dead browser on every new hold
    this._approving = true; // claim the guard synchronously so the periodic loop / a 2nd kick can't overlap
    (async () => {
      this.log('🛡️ Held post(s) just detected — kicking a moderator-approval pass now (posting continues)…');
      try { await this._runModeratorApproval(data, () => this._stop); }
      catch (e) { this.log(`⚠️ moderator kick error: ${e.message}`); }
      finally { this._approving = false; }
    })().catch(() => { this._approving = false; });
  }

  // On-demand moderator approval (force a pass now). Callable from the UI/IPC; guarded so two passes
  // can't overlap. The concurrent loop above is the primary, automatic mechanism.
  async approveHeldNow(data) {
    if (this._approving) { this.log('🛡️ A moderator-approval pass is already running.'); return { ok: false, reason: 'busy' }; }
    data = data || this._data || {};
    if (!(data.settings && data.settings.moderationEnabled)) { this.log('🛡️ Turn on "Moderator Approval" (Groups tab) before approving held posts.'); return { ok: false, reason: 'disabled' }; }
    this._approving = true;
    try {
      this.log('🛡️ Manual moderator-approval pass requested…');
      const r = await this._runModeratorApproval(data, () => false);
      if (r && r.held === 0) this.log('🛡️ No posts are currently held for approval.');
      return { ok: true, ...r };
    } catch (e) { this.log(`⚠️ moderator approval error: ${e.message}`); return { ok: false, error: e.message }; }
    finally { this._approving = false; }
  }

  // Persist per-account daily volume + rate-limit cool-down after a run (serialized via store.update
  // so it can't clobber a concurrent UI/remote edit). Daily count drives the dailyCap gate; the
  // cool-down timestamp drives the skip above. A clean post clears any prior cool-down/strikes.
  // OPT-IN per-IP AGGREGATE post gate (settings.realIpMinPostGapSec > 0, no-proxy fleets only). Reserves the next real-IP
  // post slot on a SHARED timestamp (synchronous read-modify-write — identical idiom to the launch throttle _lastRealIpLaunchAt,
  // so concurrent workers serialize with no race) and returns the ms the caller must wait, so no two INTER-GROUP posts across
  // the fleet land closer than the configured minimum on the one shared line (each account's FIRST post is spaced by the launch
  // throttle instead — ~15-45s — so a gap up to that is fully covered; larger values bound the sustained rate). Off (0) or a
  // proxied fleet → returns 0 (no-op). Only ever RAISES a gap; never touches any double-post/coverage guard. Awaited at each inter-group boundary.
  // #13: reserve the slot on the PROJECTED post instant (now + the caller's own inter-group gap), NOT the boundary — the
  // worker sleeps _cfgGap (120–300s) AFTER this call, so reserving `now` made the shared-IP clock reflect the wrong time
  // and the worker's max(_cfgGap, gateWait) then ignored the (moot) reservation, so two concurrent accounts' real posts
  // could drift sub-floor. Reserving on now+projectedDelayMs makes the returned wait ≥ projectedDelayMs and correctly
  // serializes REAL post instants across the fleet. ONE reservation per post (never double-advance). Only ever RAISES.
  _ipPostGate(projectedDelayMs = 0, accountIsProxied = false) {
    if (accountIsProxied || (this._data && this._data.useProxies)) return 0; // #E: a genuinely proxied account (its OWN proxy, even with the global useProxies toggle OFF) posts from a DISTINCT IP → it must NOT enter or advance the shared real-IP clock. proxyForAccount (per-account) is the discriminator, matching the launch throttle's _isProxied — the fleet-wide useProxies flag alone let a self-proxied account slow the real-IP fleet.
    const minGapSec = Math.max(0, Number((this._data && this._data.settings && this._data.settings.realIpMinPostGapSec)) || 0);
    if (!minGapSec) return 0;
    const now = Date.now(); // review-fix: capture ONCE and use for both the clamp and the return — two Date.now() calls let the no-arg free-slot path return a sub-ms NEGATIVE (flaking the antispam w1===0 check) and the with-arg return dip below projectedDelayMs
    const projected = now + Math.max(0, Number(projectedDelayMs) || 0); // when this post will ACTUALLY land (after the caller's gap sleep)
    this._lastRealIpPostAt = Math.max(projected, (this._lastRealIpPostAt || 0) + minGapSec * 1000);
    return this._lastRealIpPostAt - now; // total wait from NOW (≥ projectedDelayMs when active) — the caller uses this directly
  }

  async _recordAccountOutcome(name, res, settings) {
    const today = store.todayKey();
    const baseHours = Number.isFinite(settings.rateLimitCooldownHours) ? settings.rateLimitCooldownHours : 4;
    let note = null;
    // 400-SCALE WRITE ELISION: most per-cycle outcomes are pure no-ops (reserves, already-posted-today, no-groups,
    // skipped) — posted nothing AND carry no flag → there is NOTHING to persist, yet each still triggered a full
    // data.json rewrite (+fsync +.bak) = the bulk of the per-cycle write amplification at 400 accounts. Skip those:
    // a new-day count reset is applied LAZILY on READ (dailyUsed/dailyRolledOver), and every state that DOES need
    // persisting — a delivery (daily.count), a flag (rate-limit cooldown / warm-up reset), or a recovery/un-stick
    // (both require a delivery) — still writes immediately, UNCHANGED. Zero durability loss; only wasted writes removed.
    if (((res.posted || 0) + (res.pendingApproval || 0)) === 0 && !res.flag) return;
    try {
      await store.update((d) => {
        const acc = d.accounts.find((a) => a.name === name);
        if (!acc) return;
        // Monotonic daily-cap reset (see store.dailyRolledOver): only a genuinely later LOCAL day (todayKey is
        // now the local calendar date, matching the pacing/schedule day) resets the count; a clock moved backward
        // keeps counting, so the cap can't be cleared by rewinding the clock.
        if (store.dailyRolledOver(acc.daily, today)) acc.daily = { date: today, count: 0 };
        acc.daily.count = (Number(acc.daily.count) || 0) + (res.posted || 0) + (res.pendingApproval || 0); // held posts DID reach FB (gated for review) — count them so tomorrow's cap reflects real volume
        if (res.flag === 'rate_limited') {
          acc.rlStrikes = (acc.rlStrikes || 0) + 1;
          // THREE tiers, proportionate to what Facebook actually blocked (× the exponential per-strike
          // backoff, capped 48h): an ACCOUNT-LEVEL temporary block ("the big one") rests longest; a
          // POSTING limit rests at the base; a COMMENT limit (mildest, account can still post) rests
          // shortest. The worker classifies which via res.rlKind.
          const kind = res.rlKind || 'post';
          // SPEED RELATION: a limit that hits EARLY in the run is a strong signal the pace is too aggressive on this one IP
          // → rest longer. 1st action blocked → 2×; within the first quarter of the account's groups → 1.5×; later → 1×.
          // A COMMENT limit now STOPS the whole account (operator policy), so it rests like a posting-limit (mult 1), not
          // the old keep-posting 0.5. Still × the exponential per-strike backoff, still capped 48h.
          const _done = res.posted || 0, _tgt = res.targetCount || 1;
          const _early = _done === 0 ? 2 : (_done / _tgt) < 0.25 ? 1.5 : 1;
          const mult = (kind === 'account' ? 3 : 1) * _early;
          const hours = Math.min(48, Math.max(0.5, baseHours * mult) * Math.pow(2, acc.rlStrikes - 1));
          acc.rateLimitedUntil = Date.now() + Math.round(hours * 3600000);
          const human = hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(hours * 60)}min`;
          note = `⏸️ ${name}: ${kind === 'account' ? 'ACCOUNT temporarily blocked by Facebook (the big one)' : kind === 'comment' ? 'COMMENT rate-limit' : 'POSTING rate-limit'} — resting it ${human} (strike ${acc.rlStrikes}); skipped until then, others keep working.`;
        } else if (res.flag === 'needs_login' || res.flag === 'needs_verification' || res.flag === 'account_disabled' || res.flag === 'likely_blocked') {
          // NON-rate-limit block (logged-out / checkpoint / disabled / posted-nothing). REST it so it is NOT re-launched
          // EVERY cycle: re-navigating a CHECKPOINTED account into the wall, or re-submitting the FB login form on a dead
          // session, is a ban-escalation (invariant #3) and burns a browser slot the healthy fleet needs. A reserve
          // covers its groups (the runOne rest guard), and it AUTO-RETRIES after the window — so a logged-out account can
          // recover unattended (Tier-3 auto-login) without hammering. Manual states (checkpoint/disabled) rest longer
          // since only the operator/FB can truly clear them; a clean delivery clears the rest immediately (below).
          // EXPONENTIAL BACKOFF (mirrors the rate-limit rlStrikes ladder): a FLAT rest re-launched a permanently-dead
          // account into Tier-3 auto-login every window forever → re-submitting the FB login form on the ONE shared IP
          // (ban-escalation, invariant #3). Grow the rest per consecutive strike so a genuinely-broken account backs off
          // to ~once/day (24h cap) instead of hammering, while a TRANSIENT logout still auto-recovers unattended after
          // its (short, first-strike) window. attnStrikes persists ACROSS rest-window expiries (that is what makes it
          // escalate) and is cleared ONLY by a clean delivery (below) — never by mere expiry. Base = the old per-flag rest.
          acc.attnStrikes = (acc.attnStrikes || 0) + 1;
          const baseRestH = res.flag === 'needs_login' ? 3 : res.flag === 'likely_blocked' ? 3 : res.flag === 'needs_verification' ? 6 : 12;
          const restH = Math.min(24, baseRestH * Math.pow(2, acc.attnStrikes - 1));
          acc.nextAttnRetry = Date.now() + Math.round(restH * 3600000);
          acc.attnFlag = res.flag; // H2/H3: persist the bench REASON. A manual re-login clears this rest ONLY when reason === 'needs_login' — a cookie-probe reading logged_in does NOT prove FB lifted a checkpoint/block, so the churnable status field can't be the discriminator.
          const _restHuman = restH >= 1 ? `${Math.round(restH)}h` : `${Math.round(restH * 60)}min`;
          const _reCheck = res.flag === 'needs_login' ? ', or sooner once you log it back in' : ' after the rest'; // only a logged-OUT account is un-benched by a re-login; checkpoint/blocked/disabled must wait out the rest (re-checking can't prove FB cleared them)
          note = `⛔ ${name}: ${res.flag === 'needs_login' ? 'logged out' : res.flag === 'needs_verification' ? 'needs a checkpoint/verification' : res.flag === 'account_disabled' ? 'disabled/restricted by Facebook' : 'posted nothing (likely blocked)'} — resting it ${_restHuman} (strike ${acc.attnStrikes}; a reserve covers its groups; it retries automatically${_reCheck}).`;
        } else if (((res.posted || 0) + (res.pendingApproval || 0)) > 0 && !res.flag && (acc.rateLimitedUntil || acc.rlStrikes)) {
          // Recovered (posted OR queued for approval with no flag) — clear the cool-down.
          acc.rateLimitedUntil = 0; acc.rlStrikes = 0;
        }
        // A clean delivery clears any attention-rest so a RECOVERED account rejoins the very next cycle (never a
        // permanent skip). Covers the logged-out-then-recovered case, which sets no rateLimitedUntil/rlStrikes.
        if (((res.posted || 0) + (res.pendingApproval || 0)) > 0 && !res.flag) { if (Number(acc.nextAttnRetry)) acc.nextAttnRetry = 0; if (acc.attnStrikes) acc.attnStrikes = 0; acc.attnFlag = ''; } // clear the attention-rest AND its backoff-strike ladder AND the persisted reason on a clean delivery (a re-checked/recovered account starts fresh)
        // Un-stick a STALE attention status after a clean outcome so a RECOVERED account is not barred from reserve
        // roles (takeover / Phase-4 re-post / Phase-3 comment-rescue all require status==='logged_in') for the rest of
        // the run. OUTSIDE the cooldown guard on purpose: a status:'error' case has NO rateLimitedUntil/rlStrikes set,
        // so it would otherwise stick permanently even though the account is posting fine. Guarded on a real delivery +
        // no NEW flag this call + not actually still cooling → never un-sticks a genuinely rate-limited account, and only
        // WIDENS eligibility (dealt-set + markDelivered still govern actual posting → no re-post / double-post).
        if (((res.posted || 0) + (res.pendingApproval || 0)) > 0 && !res.flag && acc.status && acc.status !== 'logged_in' && (Number(acc.rateLimitedUntil) || 0) <= Date.now()) {
          acc.status = 'logged_in';
          if (acc.lastMessage) acc.lastMessage = '';
        }
      });
      if (note) this.log(note);
      // Account got FLAGGED (rate-limit / checkpoint / logout / block) → RESET its warm-up counter so it
      // EASES BACK IN (browses + reacts before posting) over its next runs instead of immediately resuming
      // full posting — reduces re-flagging. Skips proxy_invalid (a config issue, not the account's health).
      if (settings.enableWarmup && res.flag && res.flag !== 'proxy_invalid' && DROP_FLAGS.has(res.flag)) {
        try { if (store.loadRunCount(name) > 0) { store.saveRunCount(name, 0); this.log(`🌱 ${name}: flagged (${res.flag}) — warm-up reset; it'll ease back in (browse + react) before posting again.`); } } catch {}
      }
    } catch (e) {
      // This is the ONLY place the rate-limit COOL-DOWN (rateLimitedUntil/rlStrikes) + the DAILY-CAP count are
      // persisted after a run. A silently-swallowed write here means next cycle reads a STALE cooldown → the account
      // re-launches straight into the rate-limited group (deepening the block) and posts past its cap. Surface it —
      // the sibling rotation-pointer / held-record / comment-queue writes all log on a failed save too.
      this.log(`⚠️ [${name}] could NOT persist its rate-limit cool-down / daily count (${e.message}) — it may re-post while blocked or exceed its daily cap. Free disk space / fix data-folder permissions.`);
    }
  }

  // Persist this cycle's dealt post-ids to disk, THEN mirror them into the in-memory _dealt set.
  // Returns false — and halts the run — if the write fails: a post that was published but whose
  // dealt-state couldn't be saved would be re-dealt and RE-POSTED after a crash/restart, so we
  // stop loudly rather than let duplicate-post risk compound batch after batch.
  // Write the FULL current in-memory rotation state (every field) — used by the mid-cycle saves so a
  // load-then-patch can never drop a sibling field (dealt / staggerRotation / lastDailyRunDate / etc.).
  _saveRotationState() {
    try { return store.saveRotation({ dealt: [...(this._dealt || [])], roundOffset: this._roundOffset || 0, staggerRotation: this._staggerRotation || 0, lastDailyRunDate: this._lastDailyRunDate || null, perAccountRotation: this._perAccountRotation || {}, campaignPlan: this._campaignPlan || null, owedLedger: this._owed || {}, inflightSeq: this._inflightSeq || {} }); } catch { return false; }
  }

  // R5 [HOLE 1]: remove every crash-durable unique/sequence delivered-guard key for a post that has reached full
  // delivery. Keys are '' + postId + '::' + gid (unique/sequence use an EMPTY _dkScope prefix — daily-rotation keys are
  // never added here), so all of a post's keys share the exact prefix `postId + '::'`; the `::` delimiter makes this
  // unambiguous even when one post id is a textual prefix of another (e.g. '1' vs '12'). Idempotent / crash-safe: a
  // post with no keys is a no-op.
  _clearInflightDelivered(postId) {
    if (!this._inflightDelivered || postId == null) return;
    const pfx = String(postId) + '::';
    for (const k of this._inflightDelivered) if (k.slice(0, pfx.length) === pfx) this._inflightDelivered.delete(k);
  }

  // R5 CRASH-DURABILITY FOLD (Hardened Approach A). Called ONCE at _loop start, BEFORE any posting. A HARD kill
  // (OS crash / power loss / force-kill) mid-account loses the in-memory _cycleDelivered + the un-persisted pointer;
  // the durable per-(agent,post,group) journal (store.appendInflight at markDelivered) is what survives. Here we fold
  // the SURVIVING lines back into the SAME durable structures a clean account-return writes — perAccountRotation
  // pointer + icommit, the _owed partial-delivery ledger, the fleet-wide _dealt set, and the _inflightSeq watermark —
  // then let the normal machinery (daily-quota gate, owed pick-override, dealt-skip) do the rest. NO per-cycle seed,
  // NO parallel skip-set: a single-post daily-rotation delivery folds to a pointer whose lastPostedDate is the
  // delivery day, so the NEXT day's _dailyQuotaBlocks lets it advance to the next post normally (never re-posting the
  // delivered one). Supersession is the per-agent icommit/inflightSeq WATERMARK (an atomic pointer-side counter, not a
  // physical delete), so a failed compaction can never resurrect a committed line and a fresh line is never dropped.
  //
  // IDEMPOTENT (the fold may re-run if its persist failed): postsToday is SET to 1 (never ++), and only lines with
  // e.q > watermark(e.a) are folded — so re-folding already-committed lines is a no-op. Operates on the `data`
  // snapshot (getData()) so it NEVER depends on this._data, which isn't bound until the cycle loop starts. Wrapped in
  // try/catch: any failure degrades to today's behavior (a delivered group could at worst be re-posted once) — never worse.
  // OBLIGATION crash-fold (v1.0.72): before this run, fold held/comment obligations that SURVIVED a hard kill (the worker
  // journaled them at creation via store.appendObligation, but crashed before its account-return persisted them) into
  // moderation.json / comments.json — deduped EXACTLY as the account-return persist does (held 776-key, comment 828-key),
  // so a survivor is recovered once and never doubled. Only opt-in consumers act on held records (moderator/repost/
  // completion); orphaned comments always rescue (Phase-3 addFirstComment is idempotent → a re-queued already-placed
  // comment is a no-op). Best-effort — never throws into _loop. CLEARS the journal after folding: a clean prior run
  // already cleared it at run-end, so this only fires after a crash, and clearing the re-persisted survivors prevents a
  // phantom on the NEXT Start (e.g. after the moderator resolves + removes a card).
  async _foldObligationJournal(data) {
    try {
      const obs = store.loadObligations();
      if (!obs.length) return;
      const held = obs.filter((o) => o && o.k === 'held');
      const comments = obs.filter((o) => o && o.k === 'comment');
      const modOn = !!(data && data.settings && (data.settings.moderationEnabled || data.settings.repostEnabled || data.settings.completionMode));
      let fH = 0, fC = 0;
      if (held.length && modOn) {
        await store.updateModeration((ms) => {
          ms.held = ms.held || [];
          for (const h of held) {
            if (!ms.held.some((x) => x.postId === h.postId && x.gid === h.gid && (x.posterAccount || '') === (h.posterAccount || '') && (x.status === 'held' || x.status === 'superseded' || x.status === 'failed_held'))) {
              ms.held.push({ postId: h.postId || null, gid: h.gid, posterAccount: h.posterAccount || null, fbDisplayName: h.fbDisplayName || '', captionSnip: h.captionSnip || '', postCaption: h.postCaption || null, groupName: h.groupName || null, comment: h.comment || '', commentImg: h.commentImg || null, postPermalink: h.postPermalink || null, status: 'held', heldAt: Date.now(), approvedAt: null, commentedAt: null, source: h.source || 'crash_recover' });
              fH++;
            }
          }
        });
      }
      if (comments.length) {
        await store.updateComments((cs) => {
          cs.pending = cs.pending || [];
          for (const c of comments) {
            if (!cs.pending.some((x) => x.gid === c.gid && x.status !== 'done' && (
              (x.postId && c.postId) ? x.postId === c.postId
                : (x.postPermalink && c.postPermalink) ? x.postPermalink === c.postPermalink
                  : (x.captionSnip === c.captionSnip && (x.posterAccount || '') === (c.posterAccount || ''))
            ))) {
              cs.pending.push({ gid: c.gid, groupName: c.groupName || null, postPermalink: c.postPermalink || null, postId: c.postId || null, captionSnip: c.captionSnip || '', postCaption: c.postCaption || null, comment: c.comment || '', commentImg: c.commentImg || null, posterAccount: c.posterAccount || null, fbDisplayName: c.fbDisplayName || '', reason: c.reason || 'crash_recover', status: 'pending', queuedAt: Date.now(), attempts: 0, commentedAt: null });
              fC++;
            }
          }
        });
      }
      if (fH || fC) this.log(`♻️ Crash recovery: restored ${fH} held post(s) + ${fC} pending link-comment(s) from the previous run's interrupted session (they'd otherwise be lost).`);
      store.compactObligations(() => false); // survivors now durable in moderation/comments → clear so the next Start can't re-fold a phantom
    } catch (e) { try { this.log(`obligation-fold skipped: ${e.message}`); } catch {} }
  }

  // #4 (mid-crash daily-cap under-count → over-post): a hard kill BETWEEN a delivery and _recordAccountOutcome (which
  // increments acc.daily.count — the CAP) loses that cycle's count, so on resume the account's remaining budget is too
  // high and it can over-post past its daily cap (a Facebook spam signal). The rotation-pointer fold (#3) covers
  // postsToday but NOT the separate acc.daily.count. Reconstruct it from the PER-DELIVERY run-report (appendReport writes
  // each row synchronously via fs.appendFileSync BEFORE the account returns, so it captures crashed-cycle deliveries):
  // count TODAY's deliveries per account (deduped by account|postId|groupId so a commented post's two 'posted' rows count
  // once) and take MAX(persisted, reconstructed). MAX only ever RAISES the count → fails safe toward UNDER-posting, never
  // over; a correct persisted count is preserved. Runs once at run start, right after the inflight fold.
  async _reconstructDailyCounts() {
    try {
      const fs = require('fs');
      const today = store.todayKey();
      const counts = {}, seen = new Set();
      for (const f of [store.reportFile(), store.reportFile() + '.1']) {
        let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
        for (const line of raw.split(/\n/)) {
          if (!line) continue;
          let r; try { r = JSON.parse(line); } catch { continue; }
          if (!r || !r.account || r.account === '(run summary)') continue;
          if (r.result !== 'posted' && r.result !== 'pending') continue;               // posted + held (pendingApproval) = what daily.count counts
          if (!r.ts || store.todayKey(new Date(r.ts)) !== today) continue;             // LOCAL day, matching acc.daily's key
          const key = r.account + '|' + (r.postId || '') + '|' + (r.groupId || '');     // dedup: count the DELIVERY once (two-phase writes two 'posted' rows)
          if (seen.has(key)) continue;
          seen.add(key);
          counts[r.account] = (counts[r.account] || 0) + 1;
        }
      }
      if (!Object.keys(counts).length) return;
      let raised = 0;
      await store.update((d) => {
        for (const acc of (d.accounts || [])) {
          const rec = counts[acc.name]; if (!rec) continue;
          if (store.dailyRolledOver(acc.daily, today)) acc.daily = { date: today, count: 0 };
          if (rec > (Number(acc.daily.count) || 0)) { acc.daily.count = rec; raised++; } // MAX: only raise, never lower
        }
      });
      if (raised) this.log(`🧮 Daily-cap reconstruct: raised ${raised} account(s)' today-count from the per-delivery run-report (a mid-crash cycle had under-counted them) — prevents over-posting past the cap.`);
    } catch {}
  }

  _recoverInflightJournal(data) {
    try {
      const entries = store.loadInflight();
      if (!entries.length) return;
      let safeToCompact = true; // gate: only drop journal lines once the fold they encode is durably persisted (see below)
      data = data || { accounts: [], groups: [], posts: [], settings: {} };
      const accounts = data.accounts || [];
      const accOf = (name) => accounts.find((x) => x.name === name) || null;
      // assignedGroups(agent): the agent's currently-targeted group ids. MIRRORS _groupIdsOf EXACTLY (assignedGroups
      // may hold either g.id or g.groupId; the canonical id is g.groupId||g.id) but reads the passed snapshot, because
      // this._data / this._groupIdsOf / this._dkScope are all unbound at this point in _loop.
      const groupIdsOf = (acc) => new Set((data.groups || []).filter((g) => (acc.assignedGroups || []).includes(g.id) || (acc.assignedGroups || []).includes(g.groupId)).map((g) => g.groupId || g.id));
      // Where an agent's clean-commit watermark lives: daily-rotation / campaign-plan (AND any stand-in's forAgent,
      // which is always one of those — a stand-in advances the covered agent's perAccountRotation pointer) supersede
      // via perAccountRotation[a].icommit; unique / sequence supersede via inflightSeq[a]. Classify by the agent's
      // CURRENT postingOrder in the snapshot (the responsible agent e.a, not the reserve that may have delivered for it).
      const isRotAgent = (name) => { const a = accOf(name); const o = (a && a.postingOrder) || ''; return o === 'daily-rotation' || o === 'campaign-plan'; };
      const watermark = (name) => isRotAgent(name) ? (((this._perAccountRotation[name] || {}).icommit) || 0) : ((this._inflightSeq[name]) || 0);
      // SURVIVORS: lines not yet superseded by their agent's watermark, whose agent still exists in the library
      // (a deleted agent's lines are skipped — nothing to reconstruct — and left for a later compaction).
      const survivors = entries.filter((e) => e && e.a && e.p && (e.g != null) && accOf(e.a) && ((Number(e.q) || 0) > watermark(e.a)));
      if (survivors.length) {
        const today = this._localDayKey();
        const N = Math.max(1, Math.min(20, parseInt((data.settings && data.settings.cyclesPerDay), 10) || 1));
        this._manualBypassUsed = this._manualBypassUsed || new Set();
        // Group survivors: agent -> post -> { gids:Set, maxQ, d(of the latest delivery) }.
        const byAgent = new Map();
        for (const e of survivors) {
          const q = Number(e.q) || 0;
          let posts = byAgent.get(e.a); if (!posts) { posts = new Map(); byAgent.set(e.a, posts); }
          let rec = posts.get(e.p); if (!rec) { rec = { gids: new Set(), maxQ: 0, d: e.d || today, s: (e.s || ''), t: (Number.isFinite(Number(e.t)) ? Number(e.t) : null) }; posts.set(e.p, rec); } // s = the exact key-prefix the worker stored (== _dkScope(agent)); constant per (agent,post). t = real delivery ts (H1); non-finite/absent → null (defensive: a corrupt t must NOT bypass the floor).
          rec.gids.add(e.g);
          if (q > rec.maxQ) { rec.maxQ = q; rec.d = e.d || today; rec.t = (Number.isFinite(Number(e.t)) ? Number(e.t) : rec.t); } // the highest-q (pointer-owning) delivery's real timestamp wins
        }
        for (const [agent, posts] of byAgent) {
          const acc = accOf(agent); if (!acc) continue;
          const assigned = groupIdsOf(acc);
          if (isRotAgent(agent)) {
            // Reconstruct the per-agent pointer + owed EXACTLY as a clean daily-rotation / campaign-plan return would.
            // In practice ONE post survives per agent (the fold runs before any posting, and each cycle's clean commit
            // supersedes the prior post) — but if several somehow survive, the HIGHEST-q (latest) delivery owns the
            // single pointer, and its icommit supersedes every earlier line for the agent.
            let best = null;
            for (const [p, rec] of posts) if (!best || rec.maxQ > best.rec.maxQ) best = { p, rec };
            if (!best) continue;
            const p = best.p, delivered = best.rec.gids, d = best.rec.d, maxQ = best.rec.maxQ;
            // H1: stamp the REAL post timestamp (from the journal) so _dailyQuotaBlocks's 20h anti-straddle floor measures
            // true elapsed-since-post, not the restart instant. t ≤ now always (the post happened before the restart), so
            // it can NEVER fabricate a gap larger than reality → never posts before 20h-since-real-post (cross-midnight
            // straddle stays blocked). Legacy lines / missing t → Date.now() = today's conservative bench (no regression).
            const foldTs = (Number.isFinite(best.rec.t) && best.rec.t > 0 && best.rec.t <= Date.now()) ? best.rec.t : Date.now(); // defensive: only a plausible past timestamp is trusted; NaN/0/negative/future all fall back to Date.now() (conservative bench, never a floor bypass)
            // #3 (cyclesPerDay>1 over-post fix): a survivor never clean-committed, so this recovered cycle is +1 ON TOP of
            // the same-day cycles already persisted before the crash — NOT a reset to 1, which discarded them and let the
            // agent post up to N-1 MORE past its daily cap on resume. min(N,…) is defensive; SET (not ++) stays idempotent
            // (a later clean persist bumps icommit so the survivor is no longer a survivor). N=1 → priorToday 0 → 1 (byte-identical).
            const _prevRot = this._perAccountRotation[agent] || {};
            const _priorToday = (_prevRot.postsTodayDate === d) ? (Number(_prevRot.postsToday) || 0) : 0;
            const _foldedPostsToday = Math.min(N, _priorToday + 1);
            this._perAccountRotation[agent] = { lastPostId: p, lastPostedDate: d, lastPostedAt: foldTs, postsToday: _foldedPostsToday, postsTodayDate: d, icommit: maxQ };
            // HOLE 2 FIX: baseline the owed set on the PRE-EXISTING persisted _owed for THIS post (mirrors the clean path
            // ~1895-1896), NOT the full assigned set. If a PRIOR cleanly-committed cycle already delivered some of this
            // post's groups (so they're no longer journal survivors), recomputing owed from the full assigned set would
            // RE-OWE them → re-post to a group already delivered. A standing owed for THIS post already lists exactly the
            // still-un-reached groups; if there is none (fresh post), fall back to the full assigned set.
            const prevOwed = (this._owed[agent] && this._owed[agent].postId === p && Array.isArray(this._owed[agent].gids)) ? this._owed[agent].gids : [...assigned];
            const owedGids = prevOwed.filter((g) => !delivered.has(g));
            if (owedGids.length) this._owed[agent] = { postId: p, gids: owedGids };          // partial → re-deliver ONLY the un-reached groups (owed pick-override), never the delivered ones
            else if (this._owed[agent] && this._owed[agent].postId === p) delete this._owed[agent]; // full delivery of THIS post → nothing owed (guard the postId so a standing owed for a DIFFERENT post survives)
            // H-A2: an agent recovered as fully quota-satisfied for TODAY must NOT also spend the manual-Start one-shot
            // quota bypass (which would let it wrap past the pointer and re-post the NEXT post today). Pre-spend it so
            // the normal _dailyQuotaBlocks cap gates it. #3: gate on the FOLDED same-day count (≥N), not a hardcoded 1,
            // so an N>1 agent that already used its full quota before the crash also pre-spends the bypass.
            if (d === today && _foldedPostsToday >= N) this._manualBypassUsed.add(agent);
          } else {
            // unique / sequence: the FLEET-WIDE dealt-set is the supersession. Add a post to _dealt ONLY on a FULL
            // delivery (every assigned group reached); a PARTIAL stays UN-dealt so the resume re-picks + finishes it.
            // HOLE 1 FIX: a partial post left un-dealt used to be re-posted to its ALREADY-DELIVERED groups on resume
            // (only the in-memory _cycleDelivered — empty after a crash — guarded it). Reconstruct a DURABLE
            // per-(post,group) delivered-guard (_inflightDelivered) for each surviving group of a partial post, so the
            // resumed pick SKIPS the crash-surviving delivered groups (worker.alreadyDelivered consults it). This is
            // SAFE only for unique/sequence, which NEVER re-deliver (no cross-midnight re-delivery trap — that trap is
            // daily-rotation/loop only), so a permanent delivered-guard can't suppress a legit re-delivery.
            // WATERMARK: only FULLY-delivered posts advance inflightSeq[a]; a partial post's q must NOT bump it, so its
            // lines stay SURVIVORS on the next fold too (re-seeding _inflightDelivered — second-crash safe). The partial
            // lines are also KEPT by the compaction below (gated on p ∉ _dealt), and are dropped once p reaches full
            // delivery (added to _dealt by the resumed run's _persistDealt, which also purges its _inflightDelivered keys).
            let fullMaxQ = 0;
            for (const [p, rec] of posts) {
              if (assigned.size > 0 && [...assigned].every((g) => rec.gids.has(g))) {
                this._dealt.add(p);                                              // FULL delivery → dealt (never re-picked)
                this._clearInflightDelivered(p);                                 // full → no crash-durable guard needed (purge any prior partial keys)
                if (rec.maxQ > fullMaxQ) fullMaxQ = rec.maxQ;                     // only FULL posts advance the watermark
              } else {
                for (const g of rec.gids) this._inflightDelivered.add(p + '::' + g); // PARTIAL → durable delivered-guard. #10: normalize to the ''-scope key (drop rec.s) — matches how the unique/sequence worker's alreadyDelivered looks it up (_dkScope returns '' for unique/sequence). No-op on the normal path (rec.s already ''); fixes ONLY the daily-rotation→unique operator-switch case, where a stale 'name::' scope made the key never match → re-post to already-delivered groups.
              }
              // [9] Keep the PERSISTENT owed ledger honest about what this fold just proved delivered. A unique/sequence
              // partial is now DEALT + carried in this._owed, so a crash DURING an owed re-pick leaves an entry that
              // still lists the groups the dead run actually reached. _inflightDelivered stops the agent itself from
              // re-posting them, but the persistent-owed synthesis (~line 2530) hands the RAW ledger gids to a reserve
              // stand-in, which does NOT consult that guard → it would re-post them. Subtract them here, in the SAME
              // fold that seeds the guard, so ledger and guard agree the moment the run resumes. Mirrors the
              // rotation branch above; only ever SHRINKS the entry (no un-reached group can be dropped).
              const _ow = this._owed[agent];
              if (_ow && _ow.postId === p && Array.isArray(_ow.gids)) {
                const _left = _ow.gids.filter((g) => !rec.gids.has(g));
                if (_left.length) this._owed[agent] = { postId: p, gids: _left };
                else delete this._owed[agent];                                   // every owed group reached before the crash → the post is fully delivered, nothing carries
              }
            }
            if (fullMaxQ) this._inflightSeq[agent] = Math.max((this._inflightSeq[agent]) || 0, fullMaxQ);
          }
        }
        // Persist the folded state ONCE (pointer + icommit + owed + dealt + inflightSeq, atomically). A failed persist
        // leaves the journal intact so the NEXT run re-folds the SAME lines to the SAME result (SET, not ++ → idempotent).
        safeToCompact = this._saveRotationState();
      }
      // Best-effort: drop journal lines now superseded by their (post-fold) watermark. GATED on the fold having been
      // durably persisted: if the fold produced survivors but _saveRotationState FAILED, compacting would delete the
      // journal lines that the next-run re-fold depends on → the delivery would be lost (a re-post / stuck pointer).
      // When there were no survivors, safeToCompact stays true so committed-line cleanup still runs on the clean path.
      // A compaction failure is itself harmless — the lines remain and are re-filtered by the survivor test next fold.
      // Keep a line if it is not yet superseded by its agent's watermark (existing rule), OR it is a unique/sequence
      // line whose post is still UN-dealt (a partial that _inflightDelivered guards) — those must survive to re-seed the
      // durable delivered-guard on the next fold (second-crash safe). Once the post reaches full delivery (added to
      // _dealt), the unique/sequence clause goes false and the line is dropped on a later fold. [HOLE 1]
      // Classify the unique/sequence keep-clause by the RESPONSIBLE agent e.a (isRotAgent), NOT the stored e.o (the
      // DELIVERING account's own mode): a reserve whose OWN mode is unique/sequence writes o:'unique' while standing in
      // for a rotation/campaign agent e.a, so an e.o-based test kept that line forever (its campaign post never enters
      // _dealt) even after e.a's icommit superseded it → unbounded pcu-inflight.jsonl growth. Keep the unique-partial
      // clause ONLY when e.a is itself unique/sequence, mirroring the survivor/watermark classifier above.
      if (safeToCompact) { try { store.compactInflight((e) => e && e.a && (((Number(e.q) || 0) > watermark(e.a)) || (!isRotAgent(e.a) && !this._dealt.has(e.p)))); } catch {} }
    } catch (err) {
      try { this.log(`⚠️ R5 inflight-journal recovery skipped (${(err && err.message) || err}) — a delivered group could at worst be re-posted once on this run; no data lost. Free disk / fix data-folder permissions if this repeats.`); } catch {}
    }
  }

  // #3 (hardening): compact the crash-durability inflight journal BETWEEN cycles. appendInflight adds a line per dedup-mode
  // delivery, but compaction ran ONLY at Start/fold — so a run that never restarts grew pcu-inflight.jsonl unbounded (and
  // the eventual restart fold then read+parsed the whole thing). Reuses the EXACT fold keepFn (see ~_recoverInflightJournal):
  // KEEP a line only if it is NOT yet durably superseded — its q is above its agent's committed watermark (icommit for
  // rotation/campaign, inflightSeq for unique/sequence — both persisted WITH the pointer via saveRotation) OR it is a
  // partial unique/sequence line whose post isn't fully dealt yet. Dropping only durably-superseded lines can't weaken
  // crash recovery. Safe here: the run only reaches a new cycle if the prior cycle's pointer/dealt/inflightSeq saves
  // succeeded (_persistDealt STOPS the run on a persist failure), so the in-memory watermark reflects durable disk state.
  _compactInflightJournal() {
    try {
      const accOf = (name) => ((this._data && this._data.accounts) || []).find((a) => a && a.name === name);
      const isRot = (name) => { const a = accOf(name); const o = (a && a.postingOrder) || ''; return o === 'daily-rotation' || o === 'campaign-plan'; };
      const wm = (name) => isRot(name) ? (((this._perAccountRotation[name] || {}).icommit) || 0) : ((this._inflightSeq[name]) || 0);
      // Classify by the RESPONSIBLE agent e.a (isRot), NOT the delivering account's stored e.o — a unique/sequence
      // reserve standing in for a rotation/campaign agent writes o:'unique' on a campaign post that never enters _dealt,
      // so an e.o-based keep-clause retained the line forever (unbounded growth) even after e.a's icommit superseded it.
      store.compactInflight((e) => e && e.a && (((Number(e.q) || 0) > wm(e.a)) || (!isRot(e.a) && !this._dealt.has(e.p))));
    } catch {}
  }

  // Does ANY agent still owe un-reached groups for this post? Gates the _inflightDelivered purge: a dealt post that is
  // still owed keeps its durable delivered-guard (see _persistDealt). [9]
  _owedRefsPost(postId) {
    try { return Object.values(this._owed || {}).some((ow) => ow && ow.postId === postId && ((ow.gids) || []).length); }
    catch { return false; }
  }

  async _persistDealt(cycleDealtIds) {
    if (!cycleDealtIds || !cycleDealtIds.length) return true;
    const merged = [...new Set([...this._dealt, ...cycleDealtIds])];
    // #hardening: RETRY a transient file-lock (AV / OneDrive / Search-indexer momentarily holding run-state.json) ×3 with a
    // short backoff before giving up — this is the MOST critical persist path (a failure STOPS the whole run), yet it was
    // the only one with no retry while held/comment persists already retry ×3. The write is atomic + idempotent (full-state
    // temp→fsync→rename), so a retry can NEVER corrupt or double-post; a ~200ms lock must not end a days-long run. Only a
    // PERSISTENT failure (all 3 tries) stops the run.
    for (let _t = 0; _t < 3; _t++) {
      if (store.saveRotation({ dealt: merged, roundOffset: this._roundOffset || 0, staggerRotation: this._staggerRotation || 0, lastDailyRunDate: this._lastDailyRunDate || null, perAccountRotation: this._perAccountRotation || {}, campaignPlan: this._campaignPlan || null, owedLedger: this._owed || {}, inflightSeq: this._inflightSeq || {} })) {
        this._dealt = new Set(merged);
        // R5 [HOLE 1]: each unique/sequence post that just reached full delivery no longer needs its crash-durable
        // delivered-guard — purge its keys so _inflightDelivered stays bounded (no-op for rotation/campaign ids, which
        // never have keys). Only after the save succeeds: a failed save keeps _dealt (and the guard) so a retry re-skips.
        // [9] STILL-OWED posts are EXEMPT: a dealt id no longer implies full delivery now that a PARTIAL is dealt +
        // carried in the owed ledger. Purging a still-owed post's guard would drop the only durable proof of which
        // groups a pre-crash run already reached → the next owed re-pick (and any reserve stand-in, which never
        // consults the guard) would re-post them. The guard is purged on the cycle that finally discharges the owed.
        for (const id of cycleDealtIds) if (!this._owedRefsPost(id)) this._clearInflightDelivered(id);
        return true;
      }
      if (_t < 2) await this._interruptibleSleep(200); // SHORT backoff between tries (matches the held/comment persist retries)
    }
    this.log('🚨 CRITICAL: could not save rotation state after 3 tries (disk full / file locked / no write permission). Posts published this batch are NOT recorded as done — continuing would risk RE-POSTING them after a crash or restart. STOPPING the run now. Free disk space or fix the data-folder permissions, then Start again.');
    this._stop = true;
    this.emit('automation-progress', { ...this._progress });
    return false;
  }

  async _loop(getData) {
    const _st = store.loadRotation();
    this._dealt = new Set(Array.isArray(_st.dealt) ? _st.dealt : []); // post-ids already dealt (unique modes)
    this._zeroProgressCycles = 0; // consecutive cycles that dealt nothing -> stall breaker
    this._emptyConfigCycles = 0;  // consecutive cycles with no posts / no posting accounts -> give-up threshold (reset per run so a prior run's count can't carry over and false-stop)
    this._lastOutstanding = null; this._noDrain = 0; // completion engine: detect when drain stops progressing -> undeliverable
    this._drainingCompletion = false; // true while the completion engine is fast-draining queues — bypasses the daily-schedule 24h gate
    this._proxyWarned = false;    // one-time per-run "proxies off / shared IP" warning
    this._profileWarned = false;  // one-time per-run "two account names map to the same Chromium profile" warning
    this._auditWarned = false;    // one-time per-run "audit-log write failed" warning
    this._completionWarned = false; // one-time per-run completion-mode advisory (else suppressed forever after a Stop/Start)
    this._loopNoopWarned = false;   // one-time per-run "Loop Campaign has no finite fleet" advisory
    this._finiteDoneLogged = false; // one-time per-run "finite content done, ongoing accounts keep running" log
    this._roundOffset = _st.roundOffset || 0; // rotates account↔post mapping across Loop-campaign recycles
    this._staggerRotation = _st.staggerRotation || 0; // E-N3: rotates account START order each cycle (fairness)
    this._lastDailyRunDate = _st.lastDailyRunDate || null; // 'daily' schedule: local day-key of the last run (same-day-restart dedupe)
    this._perAccountRotation = (_st.perAccountRotation && typeof _st.perAccountRotation === 'object') ? _st.perAccountRotation : {}; // daily-rotation + campaign-plan: per-agent { lastPostId, lastPostedDate }
    this._campaignPlan = (_st.campaignPlan && typeof _st.campaignPlan === 'object') ? _st.campaignPlan : null; // campaign-plan: { batchId, agentLists{}, clusters[] }
    this._owed = (_st.owedLedger && typeof _st.owedLedger === 'object') ? _st.owedLedger : {}; // PERSISTENT partial-delivery ledger { agent -> { postId, gids[] } } — un-reached groups of a partial delivery, carried across cycles/days so they get the SAME post next time (never re-posting a delivered group). [7][8]
    this._retryCount = {}; // E-N4: per-account consecutive rate-limit retries → stagger decay (in-memory)
    this._inflightSeq = (_st.inflightSeq && typeof _st.inflightSeq === 'object') ? _st.inflightSeq : {}; // R5: per-agent clean-commit watermark for unique/sequence (rotation/campaign use perAccountRotation[a].icommit)
    // R5: journalHigh = the highest q ever written to the inflight journal, so a fresh _runSeq stays monotonic across
    // restarts even after the pointer/inflightSeq watermarks were compacted away (a torn final line is tolerated).
    this._journalHigh = 0; try { for (const e of store.loadInflight()) { const q = Number(e && e.q) || 0; if (q > this._journalHigh) this._journalHigh = q; } } catch {}
    try { this._proxyHealth.load(this._proxyHealthFile()); } catch {} // E-X3: restore proxy health (prunes >1h)
    // R5 CRASH-DURABILITY FOLD: before any posting this run, fold journal lines that SURVIVED a hard kill back into the
    // durable {perAccountRotation, _owed, _dealt, _inflightSeq} exactly as a clean account-return would — so no delivered
    // group is re-posted and no un-reached group is silently skipped. Uses the getData() snapshot (this._data isn't bound
    // until the cycle loop below). Best-effort — it never throws into _loop.
    this._recoverInflightJournal(getData());
    await this._reconstructDailyCounts(); // #4: rebuild the daily CAP count from the per-delivery run-report so a mid-crash cycle can't let an account over-post past its cap (fail-safe: only ever raises the count)
    // OBLIGATION crash-fold: recover held/comment obligations a hard-kill left in the journal (see _foldObligationJournal).
    await this._foldObligationJournal(getData());
    let cycle = 0;
    while (!this._shouldStop()) {
      // #hardening: clear the loss-halt at the TOP of each cycle so a TRANSIENT persist-lock (which sets it mid-pool at
      // ~:2347) that has since CLEARED lets the run self-recover — the affected post is already dealt (no double-post), so
      // the flag's only job is to pause; a lock that persists just re-sets it next cycle (bounds loss to one cycle instead
      // of wedging the run until a manual restart). Mirrors _diskHalt's self-healing (Start-only reset was the wedge).
      this._recordLossHalt = false;
      this._data = getData(); // re-read each cycle so mid-run edits take effect
      this._compactInflightJournal(); // #3: keep the crash-durability inflight journal bounded on a run that never restarts (drops only durably-superseded lines; best-effort)
      const data = this._data; // the moderator/rescue phases below reference `data` — bind it (was a latent ReferenceError swallowed by their try/catch, silently disabling rescue + the end-of-cycle approval sweep)
      const { posts, accounts, settings } = this._data;
      if (!posts.length) {
        // Don't kill a 24/7 run on a transient empty read or a mid-edit moment — wait + re-check; only give
        // up after several consecutive empty cycles (a genuinely-empty library).
        this._emptyConfigCycles = (this._emptyConfigCycles || 0) + 1;
        if (this._emptyConfigCycles >= 5) { this.log('⚠️ No posts configured for several cycles — stopping. Add posts, then Start again.'); break; }
        this.log('⚠️ No posts configured — waiting 60s and re-checking (add posts on the Posts tab). The run will not stop yet.');
        await this._waitWithCountdown(60000, 'Waiting for posts');
        if (this._shouldStop() || this._finish) break;
        continue;
      }
      const enabledNonMod = accounts.filter((a) => a.enabled !== false && !a.isModerator); // MOD: the moderator only approves, never posts
      // Profile-folder collision warning: two account names that sanitize to the SAME folder share ONE Chromium
      // profile → they fight over the login/lock and can corrupt each other in parallel. Warn once (we don't
      // change the path scheme — that would log existing accounts out — the operator renames one of each pair).
      if (!this._profileWarned) {
        this._profileWarned = true;
        try {
          const seen = {}; for (const a of accounts.filter((x) => !x.isModerator)) { const d = store.sanitizeName(a.name); (seen[d] = seen[d] || []).push(a.name); }
          const col = Object.values(seen).filter((n) => n.length > 1);
          if (col.length) this.log(`⚠️ Account-name COLLISION — ${col.map((n) => n.join(' / ')).join('; ')} map to the SAME Chromium profile folder, so they share one login/lock and can corrupt each other in parallel. Rename one of each pair (avoid names that differ only in spaces/underscores/special characters).`);
        } catch {}
      }
      // STANDBY (backup) accounts NEVER post in normal cycles — they're held as on-demand reserves for THEIR
      // groups (added to this._reserve below). So the posting fleet is the enabled, non-moderator, non-standby set.
      const standbyAccounts = enabledNonMod.filter((a) => a.standby === true);
      const allPosters = enabledNonMod.filter((a) => a.standby !== true);
      if (!allPosters.length) {
        // Wait + re-check rather than hard-stop (an account toggled off mid-run, or a transient empty read,
        // shouldn't kill the run); only give up after several consecutive empty cycles.
        this._emptyConfigCycles = (this._emptyConfigCycles || 0) + 1;
        const _msg = standbyAccounts.length
          ? 'Every enabled account is set to Standby — turn Standby OFF on at least one account so there is a primary to post'
          : 'No enabled posting accounts';
        if (this._emptyConfigCycles >= 5) { this.log(`⚠️ ${_msg} (several cycles) — stopping. Fix, then Start again.`); break; }
        this.log(`⚠️ ${_msg} — waiting 60s and re-checking. The run will not stop yet.`);
        await this._waitWithCountdown(60000, 'Waiting for a posting account');
        if (this._shouldStop() || this._finish) break;
        continue;
      }
      this._emptyConfigCycles = 0; // valid config this cycle — reset the transient-empty counter
      // DAILY SCHEDULE: run exactly ONE cycle/day at the local dailyPostTime (the operator's "1 post/day
      // per account into its groups; next day the next post" model — pair with sequence mode + Loop). Wait
      // until the fire time; if today's run already happened, wait until tomorrow. Survives a same-day
      // restart via the persisted lastDailyRunDate. continuous mode is unchanged (no gate).
      // DAILY SCHEDULE: run settings.cyclesPerDay cycles per LOCAL day — the FIRST at dailyPostTime, the rest SPACED by
      // the inter-cycle interval — then rest until tomorrow. cyclesPerDay=1 (default) is the classic one-cycle/day, byte-
      // identical. Each account still posts at most cyclesPerDay of ITS posts/day (enforced in _postsForAccount) and never
      // re-posts the same post. _dailyCycleCount is IN-MEMORY (a crash re-derives it; the persisted per-account postsToday
      // is the real cap, so a lost gate counter only costs harmless empty cycles, never an over-post).
      if (settings.scheduleMode === 'daily' && !this._drainingCompletion) { // skip the 24h gate while fast-draining the completion queues
        const N = Math.max(1, Math.min(20, parseInt(settings.cyclesPerDay, 10) || 1));
        const today = this._localDayKey();
        if (this._dailyCycleDate !== today) { this._dailyCycleDate = today; this._dailyCycleCount = 0; this._nextCycleAt = 0; } // new local day → reset the day's cycle counter
        const doneToday = this._dailyCycleCount || 0;
        const runNow = this._runNow; this._runNow = false; // consume — "Save & Start" runs the NEXT cycle immediately
        const waitMs = this._dailyCycleWaitMs(settings, N, doneToday, runNow, Date.now()); // extracted for unit-testability — see _dailyCycleWaitMs (v1.0.78 infinite-re-wait guard)
        if (runNow && waitMs === 0 && doneToday === 0) this.log(`▶️ Running the first cycle now; the daily schedule (${settings.dailyPostTime}) applies from the next cycle.`);
        if (waitMs > 0) {
          this._pruneProfileCaches(getData); // B2: reclaim Chrome caches now that this cycle's browsers are closed — before the rest AND before the next cycle's disk check, so freed space can avert a pause
          try { if (typeof sweepOrphanTemps === 'function') sweepOrphanTemps(); } catch {} // #11: reclaim CONSUMED comment-image temps (>24h, not referenced by a persisted queue) so a days-long no-restart run doesn't leak tmpdir
          // Overnight wait (all cycles done → waiting for TOMORROW) may sleep the laptop. Waiting for a TODAY cycle must stay awake.
          const overnight = (doneToday >= N);
          const hrs = Math.round(waitMs / 360000) / 10;
          this.log(N > 1
            ? (overnight
              ? `✅ Run complete — ${N} cycle(s) delivered this run; next run auto-starts at ${settings.dailyPostTime} tomorrow (in ~${hrs}h, may sleep).`
              : `📅 Run (${N} cycles) — ${doneToday === 0 ? `starting at ${settings.dailyPostTime}` : `cycle ${doneToday + 1}/${N}`} (in ~${hrs}h) — staying awake.`)
            : `📅 Daily mode — next run at ${settings.dailyPostTime} (in ~${hrs}h)${overnight ? ' — resting until tomorrow (laptop may sleep)' : ' — staying awake to post on time'}.`);
          await this._waitWithCountdown(waitMs, N > 1 ? `Daily cycle ${Math.min(doneToday + 1, N)}/${N}` : `Daily run at ${settings.dailyPostTime}`, overnight);
          if (this._shouldStop() || this._finish) break;
          continue; // re-enter: now it's fire time → falls through and runs one cycle
        }
        // Fire time → count this cycle toward today's quota; persist lastDailyRunDate (resume dedupe) as before.
        this._dailyCycleCount = doneToday + 1;
        this._nextCycleAt = 0; // this cycle fired → re-arm a fresh gap before the next subsequent cycle
        if (this._lastDailyRunDate !== today) { this._lastDailyRunDate = today; try { this._saveRotationState(); } catch {} }
      }
      // RESERVE POOL: never run the whole fleet. Hold back `reserveAccounts` healthy accounts — they stay
      // available to RESCUE orphaned link-comments (a post whose own account got blocked before commenting)
      // and to take over a cooled-down account's slot. Always leaves ≥1 account posting.
      //
      // GROUP-AWARE selection: a group-BLIND rotating window can hold back accounts that aren't members of
      // the group that ends up needing a rescuer, so rescue then finds NO free in-group account. Instead we
      // first try to keep, for EACH active group, at least one HEALTHY (enabled, logged-in, not rate-limited)
      // member in reserve — rotating WHICH member is held back across cycles so coverage stays fair. Any
      // reserve slots left over are filled by the same rotating window as before. Coverage is best-effort:
      // the reserve count and the “≥1 posting” floor always win, so a group whose only healthy member is the
      // last poster is left posting (not reserved).
      const reserveN = Math.max(0, Math.min(Math.round(Number(settings.reserveAccounts) || 0), allPosters.length - 1));
      let active = allPosters, reserve = [];
      if (reserveN > 0) {
        const nowR = Date.now();
        const healthy = (a) => a.enabled !== false && a.status === 'logged_in' && (Number(a.rateLimitedUntil) || 0) <= nowR && (Number(a.nextAttnRetry) || 0) <= nowR;
        const isMember = (a, g) => (a.assignedGroups || []).some((x) => x === g.id || x === g.groupId);
        const assignedIds = new Set();
        for (const a of allPosters) for (const gid of (a.assignedGroups || [])) assignedIds.add(gid);
        const activeGroups = (data.groups || []).filter((g) => assignedIds.has(g.id) || assignedIds.has(g.groupId));
        const rot = (this._reserveRot = (this._reserveRot || 0) + 1);
        const reserveSet = new Set();
        // Pass 1 — group coverage: reserve ONE healthy member per active group (rotating the pick), while
        // leaving ≥1 healthy account posting overall and not exceeding reserveN.
        for (const g of activeGroups) {
          if (reserveSet.size >= reserveN) break;
          const members = allPosters.filter((a) => healthy(a) && isMember(a, g) && !reserveSet.has(a.name));
          if (!members.length) continue;
          if (allPosters.filter((a) => healthy(a) && !reserveSet.has(a.name)).length <= 1) break; // keep ≥1 healthy poster
          reserveSet.add(members[rot % members.length].name);
        }
        // Pass 2 — fill any remaining reserve slots with the original fair rotating window.
        const baseRot = rot % allPosters.length;
        const rotated = allPosters.slice(baseRot).concat(allPosters.slice(0, baseRot));
        for (const a of rotated) {
          if (reserveSet.size >= reserveN) break;
          if (reserveSet.has(a.name)) continue;
          if (allPosters.filter((x) => !reserveSet.has(x.name)).length <= 1) break; // keep ≥1 posting
          reserveSet.add(a.name);
        }
        reserve = allPosters.filter((a) => reserveSet.has(a.name));
        active = allPosters.filter((a) => !reserveSet.has(a.name));
        // Coverage counts BOTH the held-back actives AND the Standby (backup) accounts (added to reserve
        // below) — a group whose only backup is a Standby account is NOT uncovered.
        const coverPool = reserve.concat(standbyAccounts);
        const uncovered = activeGroups.filter((g) => !coverPool.some((a) => isMember(a, g) && healthy(a)));
        const rkey = reserve.map((a) => a.name).sort().join(',');
        if (rkey !== this._lastReserveKey) {
          this._lastReserveKey = rkey;
          this.log(`🧰 Reserve this cycle: ${reserve.map((a) => a.alias || a.name).join(', ') || '(none)'} held back from posting (kept healthy to rescue held/orphaned posts); ${active.length} posting.`);
          if (uncovered.length) this.log(`⚠️ No healthy reserve member for group(s): ${uncovered.map((g) => g.name || g.groupId || g.id).join(', ')} — a rescuer there may have to wait (assign more accounts to those groups, or raise Reserve Accounts).`);
        }
      }
      this._active = active;
      // Standby (backup) accounts are ALWAYS reserve (regardless of the reserveAccounts number) — available for
      // their groups' takeover / held re-post / comment-rescue, but never the normal posting pool.
      this._reserve = reserve.concat(standbyAccounts);
      if (standbyAccounts.length) {
        const skey = standbyAccounts.map((a) => a.name).sort().join(',');
        if (skey !== this._lastStandbyKey) {
          this._lastStandbyKey = skey;
          this.log(`🟡 Standby (backup) accounts ready: ${standbyAccounts.map((a) => a.alias || a.name).join(', ')} — they post ONLY when a working account in their groups drops, a post stays held, or a comment needs placing.`);
        }
      }
      // CAMPAIGN PLAN: build the per-cluster day-by-day split ONCE per round, then FREEZE it. #2 (defer-to-next-round):
      // a mid-round library/roster EDIT changes batchId, but recomputing now would repartition the slices AND wipe every
      // agent's delivered pointer → the campaign re-posts already-delivered content to the shared IP (a whole-library
      // re-burst = the ban-risk axis). So an existing plan is held for the rest of the round; the edit applies cleanly at
      // the next round boundary (the loop-wrap recompute with the fresh roster/posts, ~line 2863) or on Stop→edit→Start.
      {
        const planAgents = this._campaignRoster(); // CP1: the STABLE full roster (not the per-cycle `active` set) → batchId doesn't churn under reserve rotation, so the plan advances instead of re-posting slice[0] every cycle. Excludes group-less agents (can't deliver a slice → would block completion forever).
        if (planAgents.length) {
          // ⚠️ SAFETY (ban-footgun): the NUMERIC "Reserve Accounts" hold-back rotates WHICH accounts are active each
          // cycle (Pass 1/2 above), so the campaign plan's roster — and thus its batchId — would change every cycle.
          // Before the freeze below this tripped the batchId-mismatch RESET every cycle → re-posted early posts forever →
          // silent over-delivery on the shared IP. Campaign-plan backup belongs to STANDBY accounts instead: they never
          // churn the active set, and _campaignStandins already covers a DROPPED campaign agent from the standby pool.
          if (reserveN > 0 && !this._reserveCampaignWarned) {
            this._reserveCampaignWarned = true;
            this.log('⚠️ "Reserve Accounts" (numeric) + Campaign Plan don\'t mix: the per-cycle reserve rotation restarts the campaign plan every cycle, so it re-posts early posts and never advances the campaign. Set Reserve Accounts to 0 and mark backup accounts as STANDBY instead (Accounts tab) — Standby covers a dropped campaign agent without restarting the plan.');
          }
          const planPosts = (this._data.posts || []); // full library — _computeCampaignPlan applies EACH cluster's own postFilter (+ post-set) so clusters with different filters aren't all gated by the first agent's
          const fresh = this._computeCampaignPlan(planPosts, planAgents, this._roundOffset || 0);
          this._reconcileCampaignPlan(fresh, planAgents, planPosts.length); // #2: build once, then FREEZE — never re-partition/wipe pointers mid-round
        } else if (this._campaignPlan) {
          this._campaignPlan = null; // no campaign-plan agents this cycle
          this._pendingPlanBatchId = null;
        }
      }
      // Shared-IP warning (once per run): many accounts from ONE IP is a top coordinated-spam signal.
      if (!this._proxyWarned && active.length > 1) {
        this._proxyWarned = true;
        if (!data.useProxies) { // useProxies is a TOP-LEVEL data field, not a setting (settings.useProxies was always undefined → this warned even when proxies were ON)
          this.log(`⚠️ Proxies are OFF and ${active.length} accounts are active — they will all post from the SAME IP. Facebook links accounts that share an IP and can flag them together. Strongly consider assigning a proxy per account (Accounts tab), or run fewer accounts at once.`);
        } else {
          const poolN = ((this._data && this._data.proxies) || []).length;
          const onPool = active.filter((a) => !(a.proxy && String(a.proxy).trim())).length; // accounts relying on the shared pool
          if (onPool > 0 && poolN === 0) {
            this.log(`⚠️ Proxies are ON but ${onPool} account(s) have NO proxy assigned and the pool is empty — they will post from your real IP. Assign a proxy per account in the Accounts tab.`);
          } else if (onPool > poolN && poolN > 0) {
            this.log(`⚠️ ${onPool} accounts share a pool of only ${poolN} prox${poolN === 1 ? 'y' : 'ies'} — some will exit from the SAME IP (Facebook links accounts that share an IP). Add more proxies, or assign a unique proxy per account.`);
          }
        }
      }
      // loopCampaign + autoDeletePosted contradict each other: the loop recycles the library forever,
      // but auto-delete removes each fully-posted post — so after one pass the library empties and the
      // "forever" loop ends. Warn once so the operator disables one of them.
      if (!this._loopDelWarned && settings.loopCampaign && settings.autoDeletePosted) {
        this._loopDelWarned = true;
        this.log('⚠️ "Loop Campaign" + "Auto-delete posted" are BOTH on — they conflict: auto-delete removes each fully-posted post, so the loop recycles an emptying library and the campaign ends after one pass. Turn OFF one (keep Loop to run forever; keep Auto-delete to use each post once).');
      }

      cycle++;
      this._claimed = new Set(); // fresh per-cycle claim ledger (released claims free a post for another account)
      this._jobbedThisCycle = new Map(); // accountName → #browser jobs this cycle (poster / takeover / Phase-4 / Phase-3); _jobbedOut caps at reserveMaxJobsPerCycle (default 1) — anti-spam (#5)
      this._cycleDrops = new Set(); // accounts that DROPPED (delivered nothing) THIS cycle — drives the reserve-takeover pass
      this._immediateCovered = new Set(); // campaign-plan agents an immediate takeover was DISPATCHED for this cycle (so the end-of-pool backstop never double-covers them)
      this._immediateDelivered = new Set(); // campaign agents whose slice a stand-in (immediate OR end-of-pool) ACTUALLY delivered this cycle — vs merely dispatched; gates the "deferred" warning so a FAILED cover still warns
      this._cycleDelivered = new Set(); // "postId::gid" delivered (published OR held) THIS cycle — the no-double-post net + the source for OWED-groups
      this._cycleOwed = {}; // { agentName -> { postId, gids[] } }: an account that delivered its post to SOME but not all groups → a reserve covers the un-reached groups
      this._cycleObligation = {}; // { agentName -> { postId, expectedGids[] } }: what each daily-rotation/campaign-plan agent (or the agent a stand-in covered) TRIED to deliver this cycle → reconciled against the FINAL delivered set at end-of-pool into the PERSISTENT this._owed ledger (carry a partial delivery across cycles/days). [7][8]
      this._postCountedThisCycle = new Set(); // agents whose postsToday was already incremented THIS cycle — a partial delivery + N split reserves all advance the SAME forAgent pointer for ONE logical daily post, so count it once (else _dailyQuotaBlocks under-delivers cyclesPerDay).
      this._pruneUndischargeableOwed(); // [LEDGER COHERENCE] reap _owed entries whose owner can neither discharge NOR scope them (a broadcast/deleted owner). Unconditional + per-cycle: the old drop-and-log sat behind _hasPersistentOwed, whose gate is the exact NEGATION of its own trigger, so it could never reach its own patients on a healthy run.
      this._campaignTakeover = {}; // { reserveName -> { postId, forAgent, gids? } }: reserve stand-ins covering a dropped/partial agent's slice this cycle (gids = the owed subset, absent = whole group set)
      // Unique modes deal each post once across accounts. When every active account is unique
      // and no un-dealt posts remain, the campaign is complete — stop and reset for the next run.
      // Only FINITE modes (unique/sequence) can "complete"; daily-rotation and post-centric are ongoing
      // (they loop by design), so they're excluded — a pure daily-rotation fleet never declares complete.
      const finiteActive = active.filter((a) => { const o = a.postingOrder || 'post-centric'; return o.includes('unique') || o === 'sequence'; });
      // In completion mode we do NOT stop/recycle at "all posts dealt" — we keep cycling to DRAIN the
      // comment-rescue + moderator-approval queues; the completion check at the cycle's end decides the stop.
      // Also require campaign-plan agents (excluded from finiteActive) to have finished their slices, so a
      // mixed unique+campaign fleet doesn't stop/recycle (and reset campaign pointers) mid-campaign.
      const campaignDone = !this._campaignPlan || this._campaignAllFinished();
      // One-time advisory: completionMode only does something for a FINITE campaign. Tell the operator when it
      // can't take effect — Loop Campaign on (never ends), or an all-ongoing fleet (post-centric/daily-rotation).
      if (settings.completionMode && !this._completionWarned) {
        this._completionWarned = true;
        const hasCampaign = active.some((a) => (a.postingOrder || '') === 'campaign-plan');
        if (settings.loopCampaign) this.log('ℹ️ Completion mode is ON but so is Loop Campaign — a looping campaign never "completes", so completion mode won\'t auto-stop. Turn Loop Campaign OFF for a finite campaign that reports + stops.');
        else if (!finiteActive.length && !hasCampaign) this.log('ℹ️ Completion mode is ON but no account uses a FINITE method (Unique / Sequential / Campaign Plan) — it has no effect on post-centric / daily-rotation fleets (they run continuously).');
      }
      // One-time advisory: Loop Campaign also only applies to a finite fleet.
      if (settings.loopCampaign && !this._loopNoopWarned) {
        this._loopNoopWarned = true;
        const hasCampaign2 = active.some((a) => (a.postingOrder || '') === 'campaign-plan');
        if (!finiteActive.length && !hasCampaign2) this.log('ℹ️ Loop Campaign is ON but no account uses a finite method (Unique / Sequential / Campaign Plan) — it has no effect on post-centric / random / daily-rotation (they already run continuously).');
      }
      if (!settings.completionMode && finiteActive.length && campaignDone && finiteActive.reduce((s, a) => s + this._postsForAccount(a, cycle).length, 0) === 0) {
        if (settings.loopCampaign) {
          // Loop campaign: re-distribute the whole library, rotating content across accounts.
          this.log('🔁 All posts distributed — looping (recycling, rotating content across accounts)...');
          this._dealt.clear();
          this._roundOffset = (this._roundOffset || 0) + 1;
          try { store.saveRotation({ dealt: [], roundOffset: this._roundOffset, staggerRotation: this._staggerRotation || 0, lastDailyRunDate: this._lastDailyRunDate || null, perAccountRotation: this._perAccountRotation || {}, campaignPlan: this._campaignPlan || null, owedLedger: this._owed || {}, inflightSeq: this._inflightSeq || {} }); } catch {} // keep the daily + per-agent + campaign + owed markers so a same-day restart can't double-run; keep inflightSeq so already-committed unique/sequence journal lines stay superseded (else the next-start fold would re-add them to the just-cleared dealt-set → the looped library would skip those posts)
          // fall through: this cycle now re-deals the full library
        } else {
          // Finite content is fully distributed. Only STOP THE WHOLE RUN when there are no ONGOING-mode accounts
          // (post-centric / random / daily-rotation) still working — otherwise stopping would kill them too. In a
          // mixed fleet the finite accounts simply idle now (their _postsForAccount returns []) while the ongoing
          // ones keep posting.
          const ongoingActive = active.filter((a) => { const o = a.postingOrder || 'post-centric'; return !o.includes('unique') && o !== 'sequence' && o !== 'campaign-plan'; });
          if (!ongoingActive.length) {
            this.log('✅ All posts have been distributed — campaign complete.');
            this._dealt.clear(); try { store.saveRotation({ dealt: [], roundOffset: 0, staggerRotation: this._staggerRotation || 0, lastDailyRunDate: this._lastDailyRunDate || null, perAccountRotation: this._perAccountRotation || {}, campaignPlan: this._campaignPlan || null, owedLedger: this._owed || {}, inflightSeq: this._inflightSeq || {} }); } catch {}
            break;
          } else if (!this._finiteDoneLogged) {
            this._finiteDoneLogged = true;
            this.log(`✅ Finite content fully distributed — the ${ongoingActive.length} ongoing account(s) (Post-to-all / Random / Daily-rotation) keep running.`);
          }
        }
      }
      this._progress.cycle = cycle;
      this._progress.accountsTotal = active.length;
      this._progress.accountsDone = 0;
      this._diskPreflight(getData); // periodic (self-throttled ~15min): catch a disk filling up DURING a multi-day run, before ENOSPC halts the fleet
      // Seed the live per-account snapshot: every active account starts 'queued' so the dashboard shows them ALL
      // immediately, then each flips to running → done/error as the pool works through them.
      this._cycleAccts = active;
      this._acctLive = {};
      for (const a of active) this._acctLive[a.name] = { state: 'queued', action: '', posted: 0 };
      this._progress.accounts = this._buildAcctSnapshot();
      this.emit('automation-progress', { ...this._progress });

      // ── PLANNING HEADER ──────────────────────────────────────────────────────
      // Determine whether any account uses a unique/sequence mode (drives header style).
      const anyUnique = active.some((a) => { const o = a.postingOrder || 'post-centric'; return o.includes('unique') || o === 'sequence'; });
      const anyDaily = active.some((a) => (a.postingOrder || '') === 'daily-rotation');
      const anyPlan = active.some((a) => (a.postingOrder || '') === 'campaign-plan');
      // Use first active account's mode as the representative label (mixed-mode is rare).
      const cycleOrder = (active[0] && active[0].postingOrder) || 'post-centric';
      const cycleModeLabel = this._modeLabel(cycleOrder);
      if (anyPlan && this._campaignPlan) {
        // Campaign Plan: show each group-set's batch length + today's per-agent assignment (truthful).
        this.log(`🗓️ Campaign Plan — each group-set receives the whole library, split across its agents (1/agent/day):`);
        for (const c of (this._campaignPlan.clusters || [])) this.log(`   • group-set [${c.groupKey || '(no groups)'}]: ${c.agents.length} agent(s) deliver ${c.totalPosts} post(s) over ${c.days} day(s)`);
        const tParts = active.filter((a) => (a.postingOrder || '') === 'campaign-plan').map((a) => {
          const ap = this._postsForAccount(a, cycle, false);
          if (!ap.length) { const n = this._campaignNextIdx(a.name); return `[${a.name}] → ${n.idx >= n.len ? '✓ slice complete' : 'already posted today'}`; }
          const idx = this._data.posts.findIndex((p) => p.id === ap[0].id);
          return `[${a.name}] → Post #${idx + 1}`;
        });
        for (let pi = 0; pi < tParts.length; pi += 3) this.log('   ' + tParts.slice(pi, pi + 3).join('   '));
      } else if (anyDaily) {
        // Daily Rotation: print each agent's next post (truthful — the same selection the run will use).
        this.log(`📅 ${cycleModeLabel}: ${active.length} agent(s) — each posts 1 new post/day to its groups`);
        const dParts = active.map((a) => {
          if ((a.postingOrder || '') !== 'daily-rotation') return `[${a.name}] → ${this._modeLabel(a.postingOrder || 'post-centric')}`;
          const ap = this._postsForAccount(a, cycle, false);
          if (!ap.length) return `[${a.name}] → ✓ already posted today`;
          const idx = this._data.posts.findIndex((p) => p.id === ap[0].id);
          return `[${a.name}] → Post #${idx + 1}`;
        });
        for (let pi = 0; pi < dParts.length; pi += 3) this.log(dParts.slice(pi, pi + 3).join('   '));
      } else if (anyUnique) {
        // F3: in unique modes each post is dealt ONCE — if undealt posts < active accounts, the
        // surplus accounts idle this cycle. Warn LOUDLY so the operator knows why (and how to fix it).
        const filtered0 = this._data.posts.filter((p) => matchesFilter(p, (active[0] && active[0].postFilter) || 'all'));
        const undealtCount = filtered0.filter((p) => !this._dealt.has(p.id)).length;
        if (undealtCount > 0 && undealtCount < active.length) {
          const idle = active.length - undealtCount;
          this.log(`⚠️ EXHAUSTION: only ${undealtCount} undealt post(s) remain for ${active.length} active account(s) — ${idle} account(s) will idle this cycle. Enable "Loop Campaign" (Settings) to recycle the library, reduce active accounts, or click "Reset Campaign Rotation" to re-deal all posts from the start.`);
        }
        this.log(`🎯🔒 ${cycleModeLabel}: ${active.length} accounts, cycle ${cycle}`);
        // F2: TRUTHFUL plan — dry-run the claim into a THROWAWAY set so the printed plan equals what the
        // run will actually do (distinct posts; "(waits — pool exhausted)" for surplus accounts). The
        // temp set is discarded at scope exit — this._claimed and disk are NEVER touched (read-only).
        const tempClaimed = new Set();
        const planParts = active.map((a) => {
          const ap = this._postsForAccount(a, cycle, true, tempClaimed);
          if (!ap.length) return `[${a.name}] → (waits — pool exhausted)`;
          const idx = this._data.posts.findIndex((p) => p.id === ap[0].id);
          return `[${a.name}] → Post #${idx + 1}`;
        });
        // Print ~3 per line so the plan is readable but not excessively long.
        for (let pi = 0; pi < planParts.length; pi += 3) {
          this.log(planParts.slice(pi, pi + 3).join('   '));
        }
      } else {
        this.log(`🎯 ${cycleModeLabel}: ${active.length} accounts — each posts all its eligible posts (same set; per-group variation only)`);
      }

      await this._waitWhilePaused(); if (this._shouldStop()) break;
      await this._waitForConnectivity(); if (this._shouldStop()) break;

      // E-N3: rotate the LAUNCH order each cycle for fairness (so account 0 isn't perpetually the
      // freshest/first). Rotation affects START ORDER ONLY — this._active stays unrotated so unique-
      // mode post assignment (which keys off positional index + roundOffset) is unchanged.
      const rot = active.length ? (this._staggerRotation || 0) % active.length : 0;
      const queue = this._orderLaunchQueue(active.slice(rot).concat(active.slice(0, rot)), settings.fireOrder, (this._staggerRotation || 0) + 1);
      const cyclePostedIds = []; // published this cycle (auto-deletable)
      const cycleDealtIds = [];  // dealt this cycle (published OR pending — rotation)
      const cycleFlags = [];     // per-account flags (needs_login / rate_limited) seen this cycle

      // E-N5: DYNAMIC CONCURRENCY POOL — run all active accounts through `poolSize` slots, launching
      // the next the INSTANT a slot frees (no batch barrier wasting the fast accounts' idle time).
      // Invariants preserved: per-account gates (enabled / cool-down / daily-cap) run BEFORE each
      // account; dealt-ids are persisted PER COMPLETION (halt-on-write-failure intact); stagger
      // spaces the initial fill to avoid a coordinated burst; offline drains + holds; Finish drains
      // the in-flight set then exits.
      // PER-IP CONCURRENCY (BATCH-PER-IP): run up to realIpMaxConcurrent accounts per exit IP at once — a proxy IP
      // behaves like the real IP (a batch), NOT the old strict one-per-proxy-IP (set realIpMaxConcurrent=1 to restore
      // that). FB can link accounts seen simultaneously on one IP, so this is a speed⇄correlation lever (operator-tuned).
      // ipKey = the account's own proxy, else the LIVE (non-cooldown) shared-pool proxy it hashes to, else the shared real-IP key.
      const _poolProx = (this._data && this._data.proxies) || [];
      const _useProx = !!(this._data && this._data.useProxies); // useProxies is a TOP-LEVEL data field, NOT in settings (normalize never copies it) — reading settings.useProxies was always undefined, forcing all pool-proxy accounts to serialize on the 'real-ip' sentinel
      // PIN the live (non-cooldown) pool ONCE for the whole cycle. Re-filtering cooldown on every ipKey() call let a
      // proxy flapping cooldown mid-cycle RE-BUCKET an account onto a proxy another account is already posting on —
      // defeating the anti-link gate (two accounts on one live IP at once). A fixed cycle snapshot keeps the gate
      // stable, and proxyForAccount is also handed to the WORKER (assignedProxy) so its pick can't diverge from the gate.
      const _liveSnap = _poolProx.filter((p) => { try { return !this._proxyHealth.isOnCooldown(p); } catch { return true; } });
      const _cyclePool = _liveSnap.length ? _liveSnap : _poolProx;
      const proxyForAccount = (a) => {
        const px = a.proxy && String(a.proxy).trim();
        if (px) return px;
        if (_useProx && _cyclePool.length) { let h = 0; const n = a.name || ''; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return _cyclePool[h % _cyclePool.length]; }
        return null; // real IP — not IP-gated
      };
      this._proxyForAccount = proxyForAccount; // so _runAccount (a method, not this closure) hands the SAME proxy to the worker
      // PER-IP KEY keyed on the EXIT HOST/IP, NOT the full proxy string: entries sharing one exit IP (different port/auth,
      // or a provider's rotating ports on one IP) map to the SAME key so the per-IP BATCH cap counts them together — FB
      // links by the IP it sees, not the port. A domain host keys on the domain (each a distinct exit). Real-IP accounts
      // share ONE key ('ip:__real__') so the one home line is batch-capped like any proxy IP. Malformed → the raw string.
      const ipKey = (a) => {
        const p = proxyForAccount(a);
        if (!p) return 'ip:__real__'; // real IP (no proxy) — a SHARED key so real-IP accounts batch up to _realIpMax on the one line
        let host = p; try { const pp = parseProxy(p); if (pp && pp.host) host = String(pp.host).toLowerCase(); } catch {}
        return 'ip:' + host;
      };
      // BATCH-PER-IP (unified, operator-chosen 2026-07-12): every distinct exit IP — real OR proxy — runs up to _realIpMax
      // accounts CONCURRENTLY (the per-IP count gate in launchNext enforces it). So max concurrency = (# distinct IPs) ×
      // _realIpMax, min'd below with parallelAccounts + the hardware ceiling. A proxy IP now behaves like the real IP (a
      // batch of _realIpMax) instead of the old strict one-account-per-proxy-IP. Set realIpMaxConcurrent=1 for strict anti-link.
      const _distinctIps = new Set();
      for (const a of queue) { const k = ipKey(a); if (k) _distinctIps.add(k); }
      // PER-IP CONCURRENCY CAP (the "batch" size): each IP runs up to this many accounts at once. hwCeil (RAM/CPU) scales
      // the WRONG way for one shared line (a beefier box posts MORE aggressively), so this small, IP-plausible number
      // (default 3 — "a home line runs a few browsers", not 16) governs per-IP concurrency. Tunable 1..8 via realIpMaxConcurrent.
      const _realIpMax = Math.max(1, Math.min(8, Number(settings.realIpMaxConcurrent) || 3));
      const _proxyCeil = Math.max(1, _distinctIps.size * _realIpMax); // distinct IPs × per-IP batch = max concurrency (floor 1 → never deadlocks)
      // HARDWARE CEILING (400-account safety): each concurrent account is a headful Chrome + FB tabs (~450MB). On a
      // client laptop an operator can set parallelAccounts high and swap-thrash the machine into cascading 'transient'
      // failures. Cap the pool by free RAM (~450MB per headful Chrome, 60% of free) and ~2×cores. Min is 1 for deadlock
      // safety ONLY — never floor above that, so a genuine low-memory moment CAN drop the ceiling (even to 1); an earlier
      // floor-at-4 re-inflated the ceiling and defeated this very protection. Only ever LOWERS concurrency (can't affect
      // the anti-link/double-post guarantees) and re-computes each cycle so it adapts to live memory.
      const _wanted = Math.max(1, Number(settings.parallelAccounts) || 2);
      const _cores = (os.cpus() && os.cpus().length) || 4;
      // Memory-based ceiling, read LIVE at each top-up rather than frozen once per cycle. Each concurrent headful Chrome
      // (~450MB) is capped by 60% of free RAM and ~2×cores; floor 1 for deadlock safety ONLY (never floor above that —
      // an earlier static floor re-inflated the ceiling and defeated this very protection). Re-reading os.freemem() on
      // every top-up (in the launch loops below) is the key: a single unlucky LOW snapshot at cycle start no longer
      // serializes the WHOLE 400-account cycle — as browsers close and RAM frees the pool re-expands, while genuinely
      // tight RAM still throttles it DOWN (even to 1). It only ever LOWERS concurrency vs _wanted/_proxyCeil, so it
      // can't affect the anti-link/double-post guarantees.
      const _liveHwCeil = () => Math.min(Math.max(1, Math.floor((os.freemem() * 0.6) / (450 * 1024 * 1024))), _cores * 2);
      const _livePoolTarget = () => Math.min(_wanted, _proxyCeil, _liveHwCeil()); // re-evaluated per top-up
      const poolSize = _livePoolTarget(); // nominal (initial) size — used for the stagger window, logs, and pool-util stats
      if (poolSize < Math.min(_wanted, _proxyCeil)) this.log(`⚠️ Pool capped to ${poolSize} by this machine's free RAM/CPU (you asked for ${_wanted}). Close other apps or lower "parallel accounts" — running more browsers than the laptop can hold causes slow, failing runs.`);
      this.log(`🧵 Pool: ${queue.length} account(s), up to ${poolSize} at a time (≤${_proxyCeil} distinct prox${_proxyCeil === 1 ? 'y' : 'ies'}) (${new Date().toLocaleTimeString()})`);
      let launchIdx = 0, stopPool = false, sawOffline = false;
      let firstStart = 0, lastEnd = 0, cpuMs = 0, ranCount = 0;

      // IMMEDIATE TAKEOVER (operator-requested): the MOMENT a campaign-plan account drops (logout / rate-limit /
      // crash / turned-off / cooling-down), pull a healthy covering reserve straight into the LIVE `queue` so the
      // pool launches it on the next freed slot — concurrently with the still-running actives — instead of waiting
      // for the whole pool to drain and the end-of-pool pass. ADDITIVE + safe: it's SYNCHRONOUS (the reserve pick +
      // state mutation is atomic, so two near-simultaneous drops can't grab the same reserve), it only APPENDS to
      // this._active (existing indices preserved; the reserve's post is resolved by the _campaignTakeover stand-in,
      // index-independent), and anything it can't cover right now (no free reserve, partial deliveries, non-campaign
      // modes) still falls to the end-of-pool takeover pass. Reserve health is read FRESH from disk, so a just-re-
      // logged-in account is eligible again and a rate-limited one stays excluded until its cool-down expires.
      const coverDrop = (A) => {
        if (this._finish || stopPool || this._shouldStop()) return;
        const nowT = Date.now();
        const _cap = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
        const healthy = (r) => { const live = (getData().accounts || []).find((x) => x.name === r.name) || r; return live.enabled !== false && live.status === 'logged_in' && (Number(live.rateLimitedUntil) || 0) <= nowT && (Number(live.nextAttnRetry) || 0) <= nowT && (_cap <= 0 || store.dailyUsed(live.daily) < _cap); };
        const pick = this._immediateStandin(A, healthy);
        if (!pick) return; // not a coverable campaign drop, or no free covering reserve this instant → end-of-pool backstop handles it
        const R = pick.reserve;
        if (this._campaignTakeover && this._campaignTakeover[R.name]) return; // defensive: R is already covering another drop this cycle — never overwrite its stand-in (guards a future await between pick + the _jobbedThisCycle add)
        this._immediateCovered.add(A.name);
        this._campaignTakeover = this._campaignTakeover || {};
        this._campaignTakeover[R.name] = { postId: pick.postId, forAgent: A.name }; // route A's exact slice to R (index-independent)
        this._reserve = (this._reserve || []).filter((x) => x.name !== R.name);     // don't also use R for the backstop / Phase-3 rescue
        this._active = (this._active || active).concat([R]);                        // APPEND-only (existing indices preserved)
        this._markJob(R.name);                                                      // R does a job this cycle (#5: up to reserveMaxJobsPerCycle)
        this._progress.accountsTotal += 1; this.emit('automation-progress', { ...this._progress });
        queue.push(R);                                                              // LIVE queue → the pool launches R on the next freed slot
        this.log(`🔁 Immediate takeover: ${R.alias || R.name} stepping in for ${A.alias || A.name} (dropped) — same post, same groups, now.`);
      };

      const runOne = async (account) => {
        const myLaunch = launchIdx++;
        const _isProxied = !!proxyForAccount(account); // real-IP (no proxy) vs proxied — picks the pacing path. ipKey now returns a key for BOTH (proxy IPs AND the shared real IP), so it can no longer be the real/proxy discriminator.
        // Stagger the INITIAL fill for PROXY accounts (the first poolSize launches would otherwise start near-
        // simultaneously); later launches are completion-triggered and already spread out. E-N4: halve per retry.
        // #3: REAL-IP (no-proxy) accounts SKIP this and go through the unified _lastRealIpLaunchAt throttle below (which
        // now covers the initial fill too), so their onsets space evenly by the same gap instead of a tighter 1-5s cluster.
        if (settings.staggerAccounts !== false && _isProxied && myLaunch > 0 && myLaunch < poolSize && !this._shouldStop() && !stopPool) {
          const retries = (this._retryCount && this._retryCount[account.name]) || 0;
          // T4: stagger the initial fill by a randomized per-launch gap from the accountDelay range
          // (cumulative across launches, capped at accountDelayMax, decayed on retries) so concurrent
          // accounts never start in a synchronized burst.
          const staggerBase = rangeMs(settings, 'accountDelayMin', 'accountDelayMax', 1, 4, 60000, 0);
          const capMs = (Number.isFinite(settings.accountDelayMax) ? settings.accountDelayMax : 4) * 60000;
          // INSTANT: operator wants a small 1–10s gap between accounts, not the minute-scale stagger.
          const base = normalizeSpeedMode(settings.speedMode) === 'max'
            ? (1000 + Math.round(Math.random() * 4000))
            : Math.round(Math.min(staggerBase * myLaunch, capMs) * Math.pow(0.5, retries));
          if (base > 0) await this._interruptibleSleep(base);
        }
        if (this._shouldStop() || stopPool || this._finish) return;
        // Mid-run toggle: if the user turned this account OFF since the cycle began, skip it now.
        // `|| account`: on a transient data.json read-lock (OneDrive/AV/indexer — the documented hazard this box runs on)
        // getData()=store.load() can return blank()/stale, making the lookup undefined; without a fallback EVERY `if (live
        // && …)` health guard below would be SKIPPED and a rate-limited / logged-out / disabled account would post on the
        // shared IP (fail-OPEN = ban-escalation). Falling back to the cycle-start snapshot keeps the guards rest-biased
        // (they compare to Date.now(), so an already-expired cooldown still passes → no false over-rest). Matches :1929/:2224.
        const live = (getData().accounts || []).find((a) => a.name === account.name) || account;
        const idle = (msg, state) => { this.log(msg); this._progress.accountsDone++; this._setAcctState(account.name, state || 'skipped', { action: String(msg || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim().slice(0, 140) }); };
        if (live && live.enabled === false) { this._cycleDrops.add(account.name); coverDrop(account); return idle(`⏸️ [${account.name}] turned OFF — skipping for the rest of this run (a reserve steps in immediately)`, 'off'); }
        // Rate-limit COOL-DOWN: a recently rate-limited account rests for hours instead of re-hammering FB.
        if (live && live.rateLimitedUntil && live.rateLimitedUntil > Date.now()) {
          const mins = Math.ceil((live.rateLimitedUntil - Date.now()) / 60000);
          this._cycleDrops.add(account.name); // cooling down → a healthy reserve covers its groups (it itself stays idle through the cool-down)
          coverDrop(account); // operator spec: a rate-limited account becomes reserve AND stops for its cool-down; a healthy reserve takes over now
          return idle(`🧊 [${account.name}] cooling down after a rate-limit — ${mins} min left; skipping this cycle (a reserve steps in)`, 'cooldown');
        }
        // ATTENTION REST (logged-out / checkpoint / disabled / posted-nothing): don't re-launch a browser into the SAME
        // block every cycle (ban-escalation + a wasted slot). Skip while resting and let a reserve cover its groups; it
        // auto-rejoins after the window (Tier-3 auto-login can recover a logout unattended) or immediately once a clean
        // run / re-check clears the rest. Keyed on nextAttnRetry, which _recordAccountOutcome clears on any delivery.
        if (live && Number(live.nextAttnRetry) > Date.now()) {
          const mins = Math.ceil((Number(live.nextAttnRetry) - Date.now()) / 60000);
          const st = live.status;
          this._cycleDrops.add(account.name);
          coverDrop(account);
          return idle(`⛔ [${account.name}] ${st === 'checkpoint' ? 'awaiting checkpoint/verification' : st === 'not_logged_in' ? 'logged out — waiting before the next auto-login attempt' : 'needs attention (blocked/disabled)'} — resting ${mins >= 60 ? Math.round(mins / 60) + 'h' : mins + 'min'}; a reserve covers its groups`, st === 'checkpoint' ? 'checkpoint' : st === 'not_logged_in' ? 'not_logged_in' : 'error');
        }
        // Per-account DAILY CAP on group-posts (0 = off).
        const cap = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
        const usedToday = (cap > 0 && live) ? store.dailyUsed(live.daily) : 0;
        if (cap > 0 && usedToday >= cap) return idle(`📵 [${account.name}] daily cap reached (${usedToday}/${cap} group-posts today) — skipping until tomorrow`, 'capped');
        const maxThisRun = cap > 0 ? (cap - usedToday) : Infinity;
        // Advisory (once/account/run): dailyCap counts GROUP-POSTS, not distinct posts — so a cap below the
        // account's assigned-group count silently leaves some groups un-posted each day. Warn so it's not a footgun.
        const _grp = (account.assignedGroups || []).length;
        if (cap > 0 && _grp > cap) { this._capWarned = this._capWarned || {}; if (!this._capWarned[account.name]) { this._capWarned[account.name] = 1; this.log(`⚠️ [${account.name}] daily cap ${cap} < its ${_grp} assigned groups — it won't reach all groups in a day (the cap counts group-posts, not distinct posts). Raise the cap to ≥${_grp} to cover all groups daily.`); } }

        // REAL-IP PACING: with NO proxy the whole fleet posts from ONE shared IP, so EVERY real-IP launch — the initial fill
        // AND completion-triggered top-ups — must be spaced so sessions never start back-to-back into that one line. Space
        // each real-IP post-start by a jittered gap on the SHARED _lastRealIpLaunchAt. #3: this now covers the initial fill
        // too (the per-account stagger above is proxy-only), so myLaunch=0 still starts immediately (stale prev-cycle
        // timestamp) while #1,#2… space by the gap. Placed AFTER the skip-checks so a cooling/rested account isn't paced for nothing.
        // #12/#15: enforce a per-launch floor of AT LEAST realIpMinPostGapSec even when staggerAccounts is OFF — the
        // stagger toggle governs cadence, not the ban-safety floor — AND so the Max-tier launch gap (5–13s) can't land an
        // account's FIRST post (spaced ONLY by this launch throttle; ipPostGate covers only inter-group posts) below a
        // configured realIpMinPostGapSec. Only ever RAISES the gap; never lowers it.
        const _ipFloorMs = _isProxied ? 0 : Math.max(0, Number(settings.realIpMinPostGapSec) || 0) * 1000;
        const _wantStagger = settings.staggerAccounts !== false;
        if (!_isProxied && (_wantStagger || _ipFloorMs > 0) && !this._shouldStop() && !stopPool && !this._finish) {
          const _baseGap = _wantStagger ? (normalizeSpeedMode(settings.speedMode) === 'max' ? (5000 + Math.round(Math.random() * 8000)) : (15000 + Math.round(Math.random() * 30000))) : 0; // stagger off → no cadence gap, only the floor
          const _gap = Math.max(_baseGap, _ipFloorMs); // never below the configured per-IP floor
          this._lastRealIpLaunchAt = Math.max(Date.now(), (this._lastRealIpLaunchAt || 0) + _gap);
          const _w = this._lastRealIpLaunchAt - Date.now();
          if (_w > 0) await this._interruptibleSleep(_w);
          if (this._shouldStop() || stopPool || this._finish) return;
        }
        const t0 = Date.now(); if (!firstStart) firstStart = t0;
        this.log(`[${account.name}] Starting with ${(account.assignedGroups || []).length} groups`);
        this._setAcctState(account.name, 'running', { action: 'starting…' }); // flip the dashboard row to live
        const r = await this._runAccount(account, cycle, maxThisRun)
          .catch((e) => { this.log(`❌ [${account.name}] supervisor caught: ${e.message}`); return { progressed: false, posted: 0, pendingApproval: 0, errors: 1, postedIds: [], dealtIds: [], offline: false }; });
        const dur = Date.now() - t0; lastEnd = Date.now(); cpuMs += dur; ranCount++;
        this.log(`✓ [${account.name}] Completed in ${Math.round(dur / 1000)}s`);
        const res = { account, progressed: !!(r && r.progressed), posted: (r && r.posted) || 0, pendingApproval: (r && r.pendingApproval) || 0, errors: (r && r.errors) || 0, postedIds: (r && r.postedIds) || [], dealtIds: (r && r.dealtIds) || [], flag: (r && r.flag) || null, offline: (r && r.offline) || false, durationMs: dur };
        // Persist this account's daily count + rate-limit cool-down.
        await this._recordAccountOutcome(account.name, res, settings);
        // E-N4: track per-account rate-limit retries for stagger decay (reset on a clean post).
        this._retryCount = this._retryCount || {};
        if (res.flag === 'rate_limited') this._retryCount[account.name] = (this._retryCount[account.name] || 0) + 1;
        else if (res.progressed) this._retryCount[account.name] = 0;
        this._progress.accountsDone++; this._progress.posted += res.posted; this._progress.errors += res.errors; this._progress.pending += res.pendingApproval;
        if (res.posted > 0) this._lastPostAt = Date.now(); // E: stamp last-delivery time so the health status shows "last post Nm ago" (a stalled fleet is then visible remotely)
        // Final live state for this account's row: rate-limited / needs-login / dropped flag / error / done.
        let _finalState = 'done';
        if (res.flag === 'rate_limited') _finalState = 'rate_limited';
        else if (res.flag === 'needs_login' || res.flag === 'needs_verification') _finalState = 'needs_login';
        else if (res.flag && DROP_FLAGS.has(res.flag)) _finalState = res.flag;
        else if (!res.progressed && res.errors > 0) _finalState = 'error';
        this._setAcctState(account.name, _finalState, { posted: res.posted, action: res.posted ? `✓ posted to ${res.posted} group${res.posted === 1 ? '' : 's'}${res.errors ? ` · ⚠️ ${res.errors} failed` : ''}` : (res.pendingApproval ? `⏳ ${res.pendingApproval} pending approval` : (res.errors ? '⚠️ no posts (error)' : 'done')) });
        // Dropped, delivered nothing → reserve-takeover candidate this cycle. Covers BOTH a flagged drop AND a
        // silent CRASH (supervisor catch returns flag:null, errors≥1) — a crashed account must not leave its post uncovered.
        if ((res.flag && DROP_FLAGS.has(res.flag) && !res.progressed) || (!res.progressed && res.posted === 0 && res.errors > 0)) this._cycleDrops.add(account.name);
        this._markJob(account.name); // it opened a browser this cycle → counts toward its per-cycle job cap (Phase-3 rescue gated by _jobbedOut) — anti-spam (#5)
        const st = (this._runStats[account.name] = this._runStats[account.name] || { posted: 0, pending: 0, errors: 0 });
        st.posted += res.posted; st.pending += res.pendingApproval; st.errors += res.errors;
        this.emit('automation-progress', { ...this._progress });
        // DAILY ROTATION: advance + persist this agent's pointer ONLY on a successful post (dealtIds = the
        // single pick if it published OR pended). A failure leaves the pointer so it retries the SAME post
        // next day. Strip postedIds so rotation content is never auto-deleted (it recycles). Keep dealtIds
        // for the cycle's progress/stall bookkeeping but do NOT let it pollute the shared dealt-set.
        const isStandin = !!((this._campaignTakeover || {})[account.name]); // a reserve (any postingOrder) covering a dropped campaign agent
        // PARTIAL-DELIVERY coverage: a deal-once / campaign agent that delivered its post to SOME but not all of its
        // groups (it PROGRESSED → it's NOT a _cycleDrops full-drop) leaves the un-reached groups OWED. Record them,
        // keyed by the post it dealt, so the takeover pass below can have a healthy in-set reserve finish those EXACT
        // groups; the worker's per-(post,group) ledger then guarantees the reserve skips already-delivered groups (no
        // double-post). NORMAL-pass runs only — a stand-in that partially covers is the bounded cascade edge (deferred).
        if (!isStandin && res.dealtIds.length && !this._cycleDrops.has(account.name)) {
          const _po = account.postingOrder || 'post-centric';
          if (_po === 'campaign-plan' || _po.includes('unique') || _po === 'sequence' || _po === 'daily-rotation') {
            const _pid = res.dealtIds[0];
            // Groups this run was RESPONSIBLE for: if it was discharging an existing owed obligation for THIS post,
            // just those owed groups (it only targeted them); otherwise its whole assigned group set (a fresh post).
            // MIRROR of _owedSelf (~890) — the two MUST agree on the same predicate. _owedSelf decided what this run
            // actually TARGETED; _prevOwed decides what it was RESPONSIBLE for. If _owedSelf scoped the run to the owed
            // subset but _prevOwed fell back to the full assigned set (or vice-versa), _owedNow is computed against the
            // wrong baseline → either a bogus same-cycle reserve cover for groups this run never targeted, or a silently
            // suppressed one. Same predicate, same argument (owedScopableMode, keyed on this run's own mode).
            const _prevOwed = (this._owed && this._owed[account.name] && owedScopableMode(_po) && this._owed[account.name].postId === _pid && Array.isArray(this._owed[account.name].gids)) ? this._owed[account.name].gids : null;
            const _expected = _prevOwed ? _prevOwed.slice() : [...this._groupIdsOf(account)];
            const _owedNow = _expected.filter((gid) => !this._owedDelivered(account.name, _pid, gid));
            if (_owedNow.length) this._cycleOwed[account.name] = { postId: _pid, gids: _owedNow }; // same-cycle: a healthy reserve finishes these un-reached groups (unchanged for unique/sequence/campaign)
            // PERSISTENT carry-over ([7][8]) — record the obligation so end-of-pool reconciliation writes what is STILL
            // un-reached (after any same-cycle reserve cover) into this._owed. ONLY the per-agent-pointer modes
            // (daily-rotation / campaign-plan) are recorded: they are the ONLY modes with an owed pick-override that can
            // DISCHARGE a carried entry. INVARIANT — never create an _owed entry an owner cannot discharge: the ledger's
            // consumers dispatch a reserve for it, so an undischargeable entry is immortal and re-posts every cycle.
            // [9] briefly recorded this for unique/sequence too (with a matching override); that combination produced
            // five recurring double-posts and was reverted — see the note at the unique/sequence pick (~line 756).
            if (owedDischargeableMode(_po)) this._cycleObligation[account.name] = { postId: _pid, expectedGids: _expected };
          }
        }
        if ((account.postingOrder || '') === 'daily-rotation' || (account.postingOrder || '') === 'campaign-plan' || isStandin) {
          if (res.dealtIds.length) {
            this._perAccountRotation = this._perAccountRotation || {};
            // Reserve stand-in: advance the DROPPED agent's slice pointer (the slice it just covered), not the
            // reserve's own (the reserve has no slice). Normal agents advance their own pointer.
            const stand = (this._campaignTakeover || {})[account.name];
            const ptrName = stand ? stand.forAgent : account.name;
            { const _dk = this._localDayKey(); const _pr = this._perAccountRotation[ptrName] || {}; const _pt = (_pr.postsTodayDate === _dk) ? (Number(_pr.postsToday) || 0) : 0; // count today's posts for the cyclesPerDay quota (persisted → survives a restart, so resume can't over-post)
              // Increment postsToday ONCE per (agent, cycle): a partial delivery + N split reserves all advance the SAME
              // forAgent pointer for ONE logical daily post; re-bumping would trip _dailyQuotaBlocks early and make the
              // covered agent silently under-deliver its cyclesPerDay. Always refresh the pointer/lastPostedAt.
              const _counted = (this._postCountedThisCycle || (this._postCountedThisCycle = new Set())).has(ptrName);
              this._perAccountRotation[ptrName] = { lastPostId: res.dealtIds[0], lastPostedDate: _dk, lastPostedAt: Date.now(), postsToday: _counted ? _pt : _pt + 1, postsTodayDate: _dk, icommit: this._runSeq }; // lastPostedAt + postsToday feed _dailyQuotaBlocks (daily pacing / midnight-straddle guard); icommit = R5 clean-commit watermark, persisted ATOMICALLY with the pointer in the saveRotation below so this run's journal lines are superseded (fold no-op) — this._runSeq is monotonically ≥ every q this agent appended this run
              this._postCountedThisCycle.add(ptrName); }
            if (stand) {
              // Only suppress the "deferred" warning if the stand-in covered ALL of forAgent's slice groups. A PARTIAL
              // takeover (posted to some groups, then hit an emerging block) must STILL warn + OWE the un-reached groups,
              // or they are silently uncovered by anyone. The pointer was already advanced above (stops the COVERED
              // groups being re-posted → no double-post); recording _cycleOwed routes ONLY the un-reached groups to the
              // same-cycle _owedStandins pass (exactly like a non-stand-in partial delivery).
              const _P = stand.postId || res.dealtIds[0];
              // stand.forAgent is a NAME string, but _groupIdsOf expects an account OBJECT (reads .assignedGroups) — so
              // resolve it. Prefer stand.gids (the specific groups a split-cover / owed stand-in was asked to cover);
              // fall back to forAgent's full group set for a whole-set immediate takeover. (Passing the name yielded an
              // empty set → _unreached always [] → the owed-routing below was dead code and partial delivery stranded.)
              const _faObj = (this._active || []).find((x) => x.name === stand.forAgent);
              const _target = (stand.gids && stand.gids.length) ? stand.gids : [...this._groupIdsOf(_faObj || {})];
              const _unreached = _target.filter((gid) => !this._cycleDelivered.has(this._dkScope(stand.forAgent) + _P + '::' + gid));
              if (!_unreached.length) (this._immediateDelivered || (this._immediateDelivered = new Set())).add(stand.forAgent); // fully covered → suppress the (now-correct) "deferred" warning
              else this._cycleOwed[stand.forAgent] = { postId: _P, gids: _unreached }; // partial → cover ONLY the missing groups + let the deferred warning fire as a backstop
              // PERSISTENT carry-over ([8]): if the agent a stand-in covered is a daily-rotation/campaign-plan agent whose
              // pointer just advanced (so it will NOT itself re-pick this post), record its obligation so end-of-pool
              // reconciliation carries any still-un-reached groups into this._owed → the agent (or a later reserve)
              // finishes them next cycle/day. (unique/sequence forAgents keep the same-cycle-only _cycleOwed path.)
              // Record forAgent's FULL responsibility (its prior-owed groups, or its whole assigned set) — NOT this
              // stand-in's _target subset: with SPLIT coverage several reserves each cover a subset, so keying the
              // obligation off one subset would drop the groups the OTHER reserves were meant to reach. And only when
              // forAgent didn't already record it via its OWN partial run this cycle (that record is authoritative).
              // [DISABLED-AGENT FIX] Resolve the covered agent's mode from the FULL account list, not just _active: a
              // stand-in can cover an agent DISABLED (enabled=false) between cycles via the persistent-owed synthesis.
              // A disabled agent is absent from _active → _faObj is undefined → _faOrd was '' → this guard never fired →
              // _cycleObligation was never recorded → _reconcileOwedFor could neither CLEAR nor CARRY this._owed[forAgent]
              // → the reserve re-posted the SAME owed groups to the SAME FB groups EVERY cycle (recurring per-(post,group)
              // double-post on the shared IP). We resolve ONLY the mode here (NOT _faObj itself) so the _target/_unreached
              // math above is untouched — expectedGids below still comes from _prevFa (the owed SUBSET, never the whole
              // assigned set), so already-delivered groups from the original partial are not re-owed and re-posted.
              const _faOrd = (_faObj && _faObj.postingOrder)
                || (((this._data && this._data.accounts) || []).find((x) => x.name === stand.forAgent) || {}).postingOrder
                || '';
              const _prevFa = (this._owed && this._owed[stand.forAgent] && this._owed[stand.forAgent].postId === _P && Array.isArray(this._owed[stand.forAgent].gids)) ? this._owed[stand.forAgent].gids : null;
              // [9/UNIQUE-COVER FIX] ADMIT unique/sequence too — but ONLY with a _prevFa baseline. [9] gave unique/sequence
              // a persistent owed ledger (the ~773 pick-override + the obligation at ~2379), and _hasPersistentOwed (2544)
              // + the synthesis/_owedStandins (2565) are MODE-AGNOSTIC — so a reserve now covers a UNIQUE agent's owed.
              // But this gate still admitted only the pointer modes, so that cover recorded NO obligation →
              // _reconcileOwedFor early-returns (!ob) → this._owed[forAgent] SURVIVES A SUCCESSFUL COVER → the synthesis
              // re-dispatches the IDENTICAL gids next cycle, and a stand-in's _uniqueSeqGuard is false so its ONLY defense
              // is _cycleDelivered — which resets each cycle. Result: the reserve re-posts the SAME (post,group) EVERY
              // cycle on the shared IP — verbatim the failure the [DISABLED-AGENT FIX] above closed for the pointer modes.
              // The crash-fold's [9] block clears the stale entry on RESTART, so only a HEALTHY days-unattended run
              // accumulates duplicates (a crash-looping one self-heals) — which is why a whole green suite never caught it.
              // The `_prevFa &&` conjunct is LOAD-BEARING: expectedGids must be the owed SUBSET, never the full assigned
              // set (else the original partial's already-delivered groups are re-owed → re-posted), and for an absent
              // _faObj the fallback yields an EMPTY set → expectedGids=[] → still=[] → delete _owed = a silent STRAND. No
              // baseline → record nothing → today's behavior (a strand: recoverable) instead of a double-post (a ban).
              if (standinObligationAdmits(_faOrd, !!_prevFa) && !this._cycleObligation[stand.forAgent]) {
                this._cycleObligation[stand.forAgent] = { postId: _P, expectedGids: _prevFa ? _prevFa.slice() : [...this._groupIdsOf(_faObj || {})] };
              }
            }
            // CRASH-SAFE OWED: reconcile THIS agent's owed entry (expected − delivered-so-far) into this._owed NOW, so
            // the save below persists the ledger ATOMICALLY with the pointer advance. Without this the pointer would be
            // persisted (and, on failure, HALT) while this._owed still held its stale pre-cycle value → a hard crash
            // before the end-of-pool reconcile would re-post an already-delivered group (discharge) or drop an
            // un-reached one (fresh partial). ptrName is the agent whose pointer just moved (the stand-in's forAgent, or
            // this account) — exactly the one whose obligation was recorded above. [7][8]
            this._reconcileOwedFor(ptrName);
            // Write the FULL current in-memory rotation state (not a load-then-patch) so a concurrent
            // _persistDealt from a unique-mode account in the same pool can't clobber dealt/perAccountRotation
            // — every writer writes the complete, authoritative in-memory truth.
            try { if (!store.saveRotation({ dealt: [...this._dealt], roundOffset: this._roundOffset || 0, staggerRotation: this._staggerRotation || 0, lastDailyRunDate: this._lastDailyRunDate || null, perAccountRotation: this._perAccountRotation, campaignPlan: this._campaignPlan || null, owedLedger: this._owed || {}, inflightSeq: this._inflightSeq || {} })) throw new Error('saveRotation returned false'); }
            catch (e) {
              // FATAL, like _persistDealt: we advanced the pointer in memory but couldn't persist it — a crash+restart
              // would reload the STALE pointer and RE-POST this exact (already-live) post. Halt + drain rather than risk
              // a double-post. Do NOT roll the pointer back: the post is already live, so a rollback would make THIS run
              // re-pick + re-post it (a same-run double-post).
              this.log(`🛑 [${account.name}] could not persist its rotation pointer (${e.message}) — STOPPING to avoid re-posting after a restart. Free disk / fix data-folder permissions, then restart.`);
              this._stop = true; stopPool = true; return;
            }
          }
          // Never push postedIds (rotation content recycles, is never auto-deleted); keep dealtIds for cycle bookkeeping only.
          cycleDealtIds.push(...res.dealtIds); if (res.flag) cycleFlags.push(res.flag);
        } else {
          cyclePostedIds.push(...res.postedIds); cycleDealtIds.push(...res.dealtIds); if (res.flag) cycleFlags.push(res.flag);
        }
        // Persist dealt-ids the MOMENT this account finishes so a crash can't re-deal (re-post) an
        // already-published post. _persistDealt halts the run (sets _stop) on a write failure. SKIP for
        // daily-rotation: it owns its per-agent pointer (persisted above) and must NOT grow the shared
        // dealt-set (which is for finite unique/sequence distribution only).
        // R5: stamp this unique/sequence account's inflight watermark BEFORE the persist, so its just-appended journal
        // lines are superseded ATOMICALLY in the SAME _persistDealt saveRotation (the next-run fold drops them, no
        // re-post). this._runSeq is monotonically ≥ every q this account appended this run. Rotation/campaign/stand-in
        // use perAccountRotation[ptrName].icommit (above); this is the unique/sequence dealt-set analogue.
        if ((account.postingOrder || '') !== 'daily-rotation' && (account.postingOrder || '') !== 'campaign-plan' && !isStandin && res.dealtIds.length) { this._inflightSeq = this._inflightSeq || {}; this._inflightSeq[account.name] = this._runSeq; }
        // CRASH-SAFE OWED (unique/sequence analogue of the rotation lock-step reconcile ~line 2415): reconcile THIS
        // account's owed entry INLINE so the _persistDealt below writes the ledger ATOMICALLY with the dealt-set that
        // supersedes the post. For unique/sequence the dealt-set IS the pointer, so ADR-0008's rule applies verbatim: a
        // hard kill must never leave the post dealt while the ledger still omits its un-reached groups (silent skip) or
        // still lists an already-delivered one (double-post). [9]
        if ((account.postingOrder || '') !== 'daily-rotation' && (account.postingOrder || '') !== 'campaign-plan' && !isStandin && res.dealtIds.length) this._reconcileOwedFor(account.name);
        if ((account.postingOrder || '') !== 'daily-rotation' && (account.postingOrder || '') !== 'campaign-plan' && !isStandin && res.dealtIds.length && !(await this._persistDealt(res.dealtIds))) { stopPool = true; return; }
        // R2 halt: a held/comment record failed to persist after retries (above). The post is ALREADY dealt (durable via
        // saveRotation ~1829 for rotation/campaign accounts, or _persistDealt just above for unique/sequence), so re-owning
        // it would DOUBLE-POST. Keep it dealt (no double-post) and STOP the pool so the operator fixes the disk/lock before
        // more secondary records are lost. Honored AFTER the dealt commit so the ordering can never manufacture a duplicate.
        if (this._recordLossHalt) { this.log(`🛑 Halting the pool: a held/comment record could not be persisted after retries (disk full/locked?). The affected post is already marked dealt (no double-post) but needs manual approval/comment. Fix disk/permissions and restart.`); stopPool = true; return; }
        if (res.offline) { sawOffline = true; stopPool = true; } // connection lost mid-flight → drain + hold
        // IMMEDIATE TAKEOVER: this account just dropped at RUNTIME (logout / rate-limit / crash) → pull a covering
        // reserve into the LIVE queue NOW instead of waiting for the pool to drain. No-op if it didn't drop or no
        // free reserve covers it (the end-of-pool pass remains the backstop).
        if (this._cycleDrops.has(account.name)) coverDrop(account);
      };

      // (ipKey + the distinct-proxy poolSize were computed above, before the pool launched.)
      // The pool launches the next account whose IP is FREE; same-IP accounts run sequentially, different-IP
      // accounts run in parallel.
      const inFlight = new Set();
      // Per-IP in-flight COUNT — caps how many accounts post from each exit IP at once (real or proxy) at realIpMaxConcurrent
      // (the "batch"). A real home line legitimately runs a few browsers, and — operator's choice — a proxy IP now does the
      // same (a batch) rather than one-at-a-time; overall concurrency is still bounded by parallelAccounts + the hardware
      // ceiling. Set realIpMaxConcurrent=1 to restore strict one-account-per-IP (no two accounts ever on one IP together).
      const inFlightIps = new Map(); // ipKey → # accounts currently posting on that IP (BATCH-PER-IP cap = _realIpMax)
      let _ipDeferLogged = false;
      const launchNext = () => {
        if (stopPool || this._shouldStop() || this._finish || !queue.length) return false;
        if (this._netOnline === false) return false; // offline (per the connectivity monitor) → don't launch doomed accounts; the cycle holds + resumes when back online
        const idx = queue.findIndex((a) => (inFlightIps.get(ipKey(a)) || 0) < _realIpMax); // each exit IP (real or proxy) runs up to _realIpMax accounts at once
        if (idx === -1) { // every queued account's IP is already at its per-IP batch cap → hold until one frees a slot
          if (!_ipDeferLogged && inFlight.size) { _ipDeferLogged = true; this.log(`⏳ ${queue.length} account(s) waiting — each IP runs up to ${_realIpMax} account(s) at once; they start as slots free.`); }
          return false;
        }
        const account = queue.splice(idx, 1)[0];
        const key = ipKey(account);
        inFlightIps.set(key, (inFlightIps.get(key) || 0) + 1); // reserve a per-IP slot
        const p = runOne(account).catch((e) => { this.log(`❌ pool error: ${e.message}`); }).finally(() => { inFlight.delete(p); const c = (inFlightIps.get(key) || 1) - 1; if (c > 0) inFlightIps.set(key, c); else inFlightIps.delete(key); }); // release the per-IP slot
        inFlight.add(p);
        return true;
      };
      while ((queue.length || inFlight.size) && !this._shouldStop()) {
        this._evalDiskHalt(); await this._waitWhilePaused(); if (this._shouldStop()) break; // B1: check disk before topping up the pool → a filling drive auto-pauses new launches (holds in _waitWhilePaused) instead of hitting ENOSPC mid-cycle
        while (inFlight.size < _livePoolTarget() && queue.length && !stopPool && !this._finish && !this._shouldStop()) { if (!launchNext()) break; } // live RAM-aware target: re-expands as memory frees so a low snapshot at cycle start can't serialize the whole cycle
        if (!inFlight.size) break; // nothing running and nothing launchable (finish / stop / drained / all IPs busy)
        await Promise.race([...inFlight]); // wake as soon as ONE slot frees, then top the pool back up
      }
      await Promise.allSettled([...inFlight]); // drain whatever is still running before the cycle ends
      // IMMEDIATE-TAKEOVER cleanup: coverDrop() may have APPENDED reserves to this._active during the pool. Restore it
      // to the clean per-cycle `active` UNCONDITIONALLY now (the pool has drained; those reserves already ran and were
      // read out of _campaignTakeover at launch). The end-of-pool backstop below re-derives from `active` and re-appends
      // as needed — but it's GATED on (this._reserve.length && !sawOffline && !stopPool), so if coverDrop consumed the
      // LAST reserve (or the pool bailed) that block is skipped, and a leaked reserve left in this._active would pollute
      // the campaign replan (line ~1845: planAgents = this._active.filter(campaign-plan) → batchId change → next-cycle
      // pointer wipe → duplicate posting) and _campaignAllFinished/_campaignRemaining. So restore it here, always.
      this._active = active;

      // RESERVE TAKEOVER (unique/sequence modes only): if an active account DROPPED this cycle
      // (rate-limit, logout, checkpoint, block, disabled, bad proxy), its post(s) were released and are
      // still UNDEALT — coverage would otherwise be lost until the next cycle/day. Pull idle HEALTHY
      // reserve members that (a) have daily headroom and (b) actually have an undealt post to deliver,
      // and run a BOUNDED second pass through the SAME pool machinery (so claims, dealt-persist, daily-cap
      // and stagger all apply unchanged). Reused reserves are removed from this._reserve so Phase-3 rescue
      // can't double-use them. Continuous/non-unique modes have no dealt-set, so this is a no-op there.
      const _dropFlags = DROP_FLAGS;
      const _uniqueMode = active.some((a) => { const o = a.postingOrder || 'post-centric'; return o.includes('unique') || o === 'sequence' || o === 'daily-rotation' || o === 'campaign-plan'; });
      // PERSISTENT-OWED can need coverage even with NO same-cycle drop/owed: a DISABLED or permanently-blocked agent
      // never runs again to discharge its carried-over owed groups, so without this the takeover block (which HOUSES the
      // persistent-owed synthesis below) would never open for it → those groups strand forever. Enter when a still-
      // deliverable, not-yet-covered persistent-owed entry exists; the synthesis + _owedStandins + the per-(post,group)
      // ledger do the rest (a reserve lands ONLY the un-reached groups, never a double-post).
      // [LEDGER COHERENCE] _owedDischargeable(n): only open the takeover block for an owner whose CURRENT mode can
      // actually discharge its entry. Without it an immortal entry (owner switched to a mode with no pick-override, so
      // nothing ever prunes or reconciles it) re-opened this block every cycle and re-dispatched the SAME gids to a
      // reserve forever = a recurring double-post on the shared IP. See _owedDischargeable.
      const _hasPersistentOwed = Object.entries(this._owed || {}).some(([n, ow]) => ow && ow.postId && ((ow.gids) || []).length && !(this._cycleOwed || {})[n] && this._owedDischargeable(n) && ((this._data && this._data.posts) || []).some((p) => p.id === ow.postId));
      if (!sawOffline && !stopPool && !this._shouldStop() && !this._finish && _uniqueMode && (this._cycleDrops.size > 0 || Object.keys(this._cycleOwed || {}).length > 0 || _hasPersistentOwed) && (this._reserve || []).length) {
        const nowT = Date.now();
        const capT = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
        // Cover EVERY dropped account this cycle (flagged drop, silent crash, or cool-down skip — all in
        // _cycleDrops), bounded only by how many healthy reserves actually have an undealt post to deliver.
        // (The takeover pool runs at poolSize concurrency, so a large count just queues — it can't burst.)
        const maxTakeover = Math.max(1, this._cycleDrops.size + Object.keys(this._cycleOwed || {}).length); // cover BOTH full drops AND partial-delivery owed agents
        // CAMPAIGN-PLAN same-day takeover: pair each dropped campaign-plan agent with a healthy in-cluster
        // reserve so it delivers that agent's slice-for-today into the same groups (the reserve has no
        // agentLists of its own — _postsForAccount routes its pick through this map; the dropped agent's
        // pointer is what advances). Built BEFORE the probe so those reserves return a post and get promoted.
        const _isHealthyReserve = (r) => {
          const live = (getData().accounts || []).find((x) => x.name === r.name) || r; // FRESH disk state, not the stale cycle snapshot
          return live.enabled !== false && live.status === 'logged_in' && (Number(live.rateLimitedUntil) || 0) <= nowT && (Number(live.nextAttnRetry) || 0) <= nowT && (capT <= 0 || store.dailyUsed(live.daily) < capT);
        };
        this._campaignTakeover = this._campaignStandins(active, this._reserve, _isHealthyReserve, maxTakeover);
        // PERSISTENT-OWED coverage ([7][8] × drop/rest): an agent that FULL-dropped (delivered nothing, e.g. an
        // unsupported-language block → dealtIds=0) or was REST-skipped this cycle records no same-cycle _cycleOwed, yet
        // may still carry an UNFINISHED partial-delivery owed post in the persistent ledger. Without this, its owed
        // groups are stranded forever (an unsupported-language/disabled account NEVER self-recovers to discharge them).
        // Synthesize a _cycleOwed entry from the persistent ledger (still-assigned groups only) so _owedStandins
        // dispatches an in-set reserve to deliver ONLY the un-reached groups. The stand-in pickers SKIP these agents
        // (above), so there is exactly ONE coverage path — no over-delivery, and the per-(post,group) ledger blocks any
        // double-post if the agent later self-recovers.
        for (const [name, ow] of Object.entries(this._owed || {})) {
          if ((this._cycleOwed || {})[name] || !ow || !ow.postId || !((ow.gids) || []).length) continue; // a same-cycle partial already recorded it authoritatively
          if (!((this._data && this._data.posts) || []).some((p) => p.id === ow.postId)) continue; // owed post gone from the library → the agent's own owed pick will drop it
          // Undischargeable entries never reach here (_hasPersistentOwed gates this block on _owedDischargeable), so the
          // drop-and-log lives in _pruneUndischargeableOwed(), swept unconditionally at the cycle top instead.
          const acc = ((this._data && this._data.accounts) || []).find((a) => a.name === name);
          const asg = acc ? this._groupIdsOf(acc) : new Set();
          const live = ow.gids.filter((g) => asg.has(g)); // prune groups the operator has since un-assigned
          if (live.length) this._cycleOwed[name] = { postId: ow.postId, gids: live };
        }
        // PARTIAL-DELIVERY covers: pair each OWED agent (delivered its post to some-but-not-all of its groups) with a
        // healthy reserve that covers ALL its owed groups, targeting ONLY those groups. The worker's per-(post,group)
        // ledger guarantees the reserve skips any already-delivered group → it lands only the un-reached ones.
        {
          const _owedCov = this._owedStandins(this._cycleOwed, this._reserve, _isHealthyReserve, new Set(Object.keys(this._campaignTakeover)));
          for (const [rName, t] of Object.entries(_owedCov.assigned)) { this._campaignTakeover[rName] = t; const _R = (this._reserve || []).find((x) => x.name === rName); this.log(`🧩 Reserve finishing a partial post: ${(_R && (_R.alias || _R.name)) || rName} delivers it to ${t.gids.length} group(s) that ${t.forAgent} couldn't reach this cycle.`); }
          for (const d of _owedCov.deferred) this.log(`⚠️ ${d.owner} partially delivered — ${d.count} group(s) un-reached and no healthy in-set reserve could finish them; deferred (add another account to that group-set).`);
        }
        // Healthy, in-headroom reserve candidates.
        // Reuse the FRESH-read predicate (status + rateLimitedUntil + daily-cap from disk) the campaign/owed paths use,
        // instead of reading status/rateLimitedUntil off the stale cycle snapshot — else a reserve whose session expired
        // or got rate-limited mid-cycle (e.g. an operator 'Check') would be promoted, wasting the takeover slot.
        const cand = (this._reserve || []).filter((a) => !a.isModerator && _isHealthyReserve(a));
        // CRITICAL: _postsForAccount finds an account's index in this._active and returns [] otherwise — so a
        // reserve must be IN this._active to be probed/claimed for. Temporarily include all candidates, probe,
        // then narrow this._active to the chosen takeovers (their appended index falls back to remaining[0]).
        this._active = active.concat(cand);
        // R3: a partial-delivery owed agent counts as maxTakeover=1, but when no single reserve is a member of ALL its
        // un-reached groups, _owedStandins→_splitCover pairs TWO+ reserves for it (each covering a disjoint subset). Those
        // reserves are already in this._campaignTakeover; the maxTakeover break would drop the 2nd+ and its groups slip a
        // cycle. Admit at least as many probe reserves as were actually ASSIGNED — disjoint onlyGroups → no double-post,
        // and in campaign-plan a non-assigned reserve returns [] from _postsForAccount so this can't over-take.
        const _probeCap = Math.max(maxTakeover, Object.keys(this._campaignTakeover || {}).length);
        const takeovers = [];
        // #F: probe ASSIGNED stand-ins (already paired to a dropped agent's exact owed groups via _campaignTakeover /
        // _splitCover) BEFORE classic-takeover candidates. Many classic unique/sequence reserves probe-positive on the SAME
        // one released post (claim=false), so if they preceded the stand-ins in reserve order they'd fill _probeCap and a
        // real split-cover stand-in would be dropped — slipping its un-reached groups a full cycle. _probeCap ≥ #stand-ins,
        // so all assigned stand-ins are admitted first, then classic candidates fill any remaining slots.
        const _standinNames = new Set(Object.keys(this._campaignTakeover || {}));
        const _probeOrder = cand.slice().sort((x, y) => (_standinNames.has(y.name) ? 1 : 0) - (_standinNames.has(x.name) ? 1 : 0));
        for (const a of _probeOrder) {
          if (takeovers.length >= _probeCap) break;
          if (this._postsForAccount(a, cycle, false).length > 0) takeovers.push(a); // an undealt post exists for it to deliver
        }
        this._active = active.concat(takeovers);
        if (takeovers.length) {
          const tnames = new Set(takeovers.map((a) => a.name));
          this._reserve = (this._reserve || []).filter((a) => !tnames.has(a.name)); // don't also use them for Phase-3 rescue
          tnames.forEach((n) => this._markJob(n)); // promoted reserves did a posting job this cycle → counts toward their per-cycle cap (Phase 3/4 gated by _jobbedOut)
          this._progress.accountsTotal += takeovers.length; this.emit('automation-progress', { ...this._progress });
          this.log(`🔁 Reserve takeover: ${takeovers.length} healthy reserve account(s) delivering posts a dropped account left undealt — ${takeovers.map((a) => a.alias || a.name).join(', ')}`);
          for (const a of takeovers) queue.push(a);
          while ((queue.length || inFlight.size) && !this._shouldStop()) {
            await this._waitWhilePaused(); if (this._shouldStop()) break;
            while (inFlight.size < _livePoolTarget() && queue.length && !stopPool && !this._finish && !this._shouldStop()) { if (!launchNext()) break; } // MUST break when launchNext can't place a queued account (all its proxy IPs busy = the anti-link gate holding) — else this synchronous loop spins forever at 100% CPU, the event loop never yields, and no in-flight promise, Stop, or _finish can ever resolve. Mirrors the main pool at ~1702. (live RAM-aware target — same as the main pool.)
            if (!inFlight.size) break;
            await Promise.race([...inFlight]);
          }
          await Promise.allSettled([...inFlight]);
        } else {
          this._active = active; // no takeover → restore the unmodified active set
          if (active.some((a) => (a.postingOrder || '') === 'daily-rotation')) this.log('ℹ️ A daily-rotation agent dropped this cycle — a FULL drop retries the same post next cycle/day (its pointer only advanced on a successful post); a PARTIAL delivery carries its un-reached groups in the owed ledger, so nothing is permanently skipped.');
        }
        // Campaign agents that dropped with NO healthy in-cluster reserve to cover them: surface the deferral.
        const _covered = new Set(Object.values(this._campaignTakeover || {}).map((t) => t.forAgent));
        for (const a of active) {
          if ((a.postingOrder || '') === 'campaign-plan' && this._cycleDrops.has(a.name) && !_covered.has(a.name) && !(this._immediateDelivered && this._immediateDelivered.has(a.name))) {
            const n = this._campaignNextIdx(a.name);
            if (n.idx < n.len) this.log(`⚠️ [${a.alias || a.name}] campaign agent dropped and no healthy reserve in its group-set could cover it — today's post is deferred (resumes when it recovers, or add another account to that batch).`);
          }
        }
        this._campaignTakeover = {}; // clear the per-cycle stand-in map so it never leaks into Phase 3/4 _postsForAccount
      } else if (!sawOffline && !stopPool && !this._shouldStop() && !this._finish && _uniqueMode && this._cycleDrops && this._cycleDrops.size && !(this._reserve || []).length) {
        // No reserve remained (the IMMEDIATE path may have consumed the last one) — the gated block above is skipped
        // because it REQUIRES a reserve, so a later same-cycle drop would get ZERO signal. Surface any campaign drop
        // whose slice was NOT actually delivered so it's never silent (gated on _immediateDelivered, not mere dispatch).
        for (const a of active) {
          if ((a.postingOrder || '') === 'campaign-plan' && this._cycleDrops.has(a.name) && !(this._immediateDelivered && this._immediateDelivered.has(a.name))) {
            const n = this._campaignNextIdx(a.name);
            if (n.idx < n.len) this.log(`⚠️ [${a.alias || a.name}] campaign agent dropped and no free reserve remained to cover it this cycle — today's post is deferred (resumes when it recovers, or add another account to that batch).`);
          }
        }
        this._campaignTakeover = {};
      }

      // PERSISTENT OWED-LEDGER: reconcile AFTER all delivery this cycle (primary + reserve takeover) so a partial
      // daily-rotation / campaign-plan delivery carries its un-reached groups to the next cycle/day and a fully-
      // covered one clears (no double-post). Unconditional — a partial delivery with no reserve skips both takeover
      // branches above, so this must run outside them. No-op when nothing was obligated this cycle. [7][8]
      this._reconcileOwedLedger();

      // M1: surface an active campaign agent whose owed groups STILL stand after this cycle's takeover + reconcile — the
      // post never reached them AND no reserve finished them this cycle. The owed ledger carries them safely to the next
      // cycle (no lost work), but silently; this makes the coverage gap visible so the operator can add/warm a reserve in
      // that group-set. Throttled once per agent per run (re-armed when the owed clears), so it can't spam a fast completion loop.
      if (_uniqueMode) {
        this._owedUncoveredWarned = this._owedUncoveredWarned || new Set();
        for (const a of active) {
          if ((a.postingOrder || '') !== 'campaign-plan') continue;
          const ow = (this._owed || {})[a.name];
          if (ow && (ow.gids || []).length) {
            if (!this._owedUncoveredWarned.has(a.name)) { this._owedUncoveredWarned.add(a.name); this.log(`⚠️ [${a.alias || a.name}] ${ow.gids.length} group(s) its post hasn't reached, and no reserve finished them this cycle — carried to the next cycle (add or warm a reserve account in that group-set to cover them sooner).`); }
          } else if (this._owedUncoveredWarned.has(a.name)) { this._owedUncoveredWarned.delete(a.name); }
        }
      }

      // E-N2: pool-utilization metric — how busy the slots were kept (cpu busy time vs the wall-clock
      // span × slots). Low util ⇒ the pool was starved (few eligible accounts) or accounts were uneven.
      if (ranCount > 0) {
        const span = Math.max(1, lastEnd - firstStart);
        const util = Math.min(100, Math.round((cpuMs / (span * poolSize)) * 100));
        this.log(`[pool-stats] ran=${ranCount} wall=${Math.round(span / 1000)}s busy=${Math.round(cpuMs / 1000)}s util=${util}% (pool=${poolSize})`);
      }
      // E-N3: advance the start-order rotation for next cycle's fairness (persisted via _persistDealt).
      if (active.length) this._staggerRotation = ((this._staggerRotation || 0) + 1) % active.length;
      try { this._proxyHealth.save(this._proxyHealthFile()); } catch {} // E-X3: persist proxy health each cycle
      // Connection lost mid-cycle (a worker bailed fast on offline): HOLD until it returns, then the
      // un-posted posts stay un-dealt and are re-run next cycle.
      if ((sawOffline || this._netOnline === false) && !this._shouldStop()) { // also hold on the MONITOR signal — covers the start-of-pool race where launchNext refused everyone without setting sawOffline
        this.log('🌐 Connection lost mid-cycle — holding until it returns...');
        await this._waitForConnectivity();
        this._zeroProgressCycles = 0; // an offline hold is NOT a stall — don't let offline-empty cycles trip the dead-fleet STOP (mirrors the rotation/cool-down hold resets)
      }
      // Dealt-ids were already persisted incrementally per batch by _persistDealt (above), which
      // mirrors them into this._dealt and halts the run on a write failure — so there is nothing
      // left to mark or save here. (Round-robin invariant, for reference: each post is dealt once;
      // a failed account's post stays un-dealt and is re-dealt next cycle.)
      if (this._shouldStop()) break;

      // ── PHASE 2: MODERATOR APPROVAL (opt-in, behind settings.moderationEnabled) ──────────────────
      // FB holds poster accounts' posts in the group "Spam potentiel" / pending queue (not the public
      // feed), so the first comment can't attach. A designated MODERATOR account (admin of the groups)
      // approves OUR held posts so they go live (caption + author matched; never a stranger's post). It
      // approves LIVE by default; settings.moderationDryRun = true makes it scan + log only (test mode). Off → no-op.
      this._pruneModeration(); // hygiene runs EVERY cycle, even when moderation is OFF (no frozen residue)
      if (settings.moderationEnabled && !this._shouldStop() && !this._approving) {
        this._approving = true;
        try { await this._runModeratorApproval(data, () => this._shouldStop()); }
        catch (e) { this.log(`⚠️ moderator phase error: ${e.message}`); }
        finally { this._approving = false; }
      }

      // ── PHASE 4: HELD-POST RE-POST RESCUE (opt-in, settings.repostEnabled) ─────────────────────────
      // A post FB held in "Spam potentiel" that the moderator could NOT approve (status flipped to 'failed'
      // by _pruneModeration after the 30-min window) is RE-POSTED by a healthy RESERVE account so the content
      // reaches the group 100%. runRepost FIRST checks the public feed — if FB auto-released the original it
      // does NOT re-post (no duplicate) and we re-home the link-comment instead. Capped at ONE replacement per
      // (post,group); a replacement that's also held → failed_held + reported. Holds the _approving guard so
      // its moderation-state writes can't race the concurrent moderator loop. No-op when repostEnabled is off.
      if (settings.repostEnabled && !this._shouldStop() && !this._approving) {
        this._approving = true;
        try {
          const graceMs = (Number.isFinite(settings.repostGraceSec) ? settings.repostGraceSec : 180) * 1000;
          const candidates = (store.loadModeration().held || []).filter((h) => h && h.status === 'failed' && !(h.repostAttempts > 0) && (Date.now() - (h.heldFailedAt || h.heldAt || 0)) > graceMs);
          if (candidates.length) {
            const { runRepost } = require('./repost');
            const inGroup = (a, gid) => (data.groups || []).some((g) => (g.groupId || g.id) === gid && (a.assignedGroups || []).some((x) => x === g.id || x === g.groupId));
            const cap = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
            for (const rec of candidates) {
              if (this._shouldStop()) break;
              const grpObj = (data.groups || []).find((g) => (g.groupId || g.id) === rec.gid);
              const post = (data.posts || []).find((p) => p.id === rec.postId);
              if (!grpObj || !post) { this.log(`♻️ held re-post: skip "${rec.groupName || rec.gid}" — ${!post ? 'post no longer in the library' : 'group not found'}.`); continue; }
              const nowR = Date.now();
              // RESERVES ONLY (never an active poster), and never an account that already ran a job this cycle
              // (takeover / a prior Phase-4 re-post) — so no account opens a 2nd browser on its profile/cycle.
              // Read LIVE disk state (enabled toggle + daily count + cool-down) — the cycle-start snapshot is
              // stale (a takeover reserve just posted; the operator may have toggled an account off mid-run).
              const liveAccts = store.load().accounts || [];
              const reserve = (this._reserve || [])
                .filter((a) => { const la = liveAccts.find((x) => x.name === a.name) || a;
                  return la.enabled !== false && !a.isModerator && la.status === 'logged_in' && (Number(la.rateLimitedUntil) || 0) <= nowR && (Number(la.nextAttnRetry) || 0) <= nowR
                    && a.name !== rec.posterAccount && !this._jobbedOut(a.name) && inGroup(a, rec.gid)
                    && (cap <= 0 || store.dailyUsed(la.daily) < cap); })
                .sort((x, y) => (((this._heldCount || {})[x.name]) || 0) - (((this._heldCount || {})[y.name]) || 0))[0]; // prefer the least-held reserve
              if (!reserve) { this.log(`♻️ held re-post: no idle healthy in-group reserve for "${rec.groupName || rec.gid}" — left undeliverable (raise Reserve Accounts / assign+warm an account in that group).`); continue; }
              // Re-read under the guard; if it changed (moderator approved it, or another pass took it), skip. Claim it as
              // superseded BEFORE launching. Disambiguate by captionSnip so a null-postId record can't match the wrong row.
              // Require at least ONE non-null identifier to match — a null-postId AND null-captionSnip record
              // must NOT match every other unidentified record at the same gid (that could mark the wrong row).
              // Match by ALL present identifiers (postId AND captionSnip when both exist) so a reserve can never
              // claim a SIBLING held record — e.g. the same account holding a different post in the same group
              // (a reused/blank postId after a library edit could otherwise match the wrong row). Narrows only.
              const recMatch = (x) => x.gid === rec.gid
                && ((rec.postId && x.postId) ? x.postId === rec.postId : true)
                && ((rec.captionSnip && x.captionSnip) ? x.captionSnip === rec.captionSnip : true)
                && (!!(rec.postId && x.postId) || !!(rec.captionSnip && x.captionSnip)); // require ≥1 real identifier
              const ms2 = store.loadModeration();
              const live = (ms2.held || []).find(recMatch);
              if (!live || live.status !== 'failed') continue;
              live.status = 'superseded'; live.repostedBy = reserve.name; live.repostedByDisplay = reserve.fbDisplayName || ''; live.repostAt = Date.now(); // R6: keep the reserve's DISPLAY name so a crash-re-armed re-post can recognize the reserve's OWN live copy, not just the original poster's
              if (!store.saveModeration(ms2)) { this.log(`⚠️ couldn't claim the held record for "${rec.groupName || rec.gid}" (disk full/locked?) — skipping this cycle to avoid double-dispatch.`); continue; }
              this._markJob(reserve.name); // it's now doing a re-post job this cycle (counts toward its per-cycle cap)
              this._reserve = (this._reserve || []).filter((a) => a.name !== reserve.name); // don't reuse this account for Phase-3 rescue this cycle
              // On a resolved re-post, advance the record OFF 'superseded' to terminal 'approved' so the Phase-1 dedup
              // (which blocks held/superseded/failed_held) doesn't permanently block a FUTURE re-hold of the same post.
              const markResolved = () => { try { const msR = store.loadModeration(); const rR = (msR.held || []).find(recMatch); if (rR && rR.status === 'superseded') { rR.status = 'approved'; rR.approvedAt = Date.now(); rR.repostAttempts = 1; store.saveModeration(msR); } } catch {} }; // #1: mark repostAttempts=1 on a SUCCESS/already-live terminal — the candidate filter (~2522 `!(repostAttempts>0)`) then PERMANENTLY excludes this record, so a later comment-rescue reopen→'failed' can't re-post an already-live held post (duplicate). No other reader of repostAttempts; Phase-1 re-hold dedup keys on status, so a fresh future hold is unaffected.
              this.log(`♻️ [${reserve.name}] re-posting held content to "${rec.groupName || rec.gid}" (original by ${rec.posterAccount} stayed in Spam potentiel)…`);
              this._setAcctState(reserve.name, 'running', { action: `♻️ re-posting held → ${rec.groupName || rec.gid}` }); // show the reserve working in Live Operations
              const result = await runRepost({
                account: reserve, post, gid: rec.gid, groupName: rec.groupName, captionSnip: rec.captionSnip, group: grpObj,
                permalink: rec.postPermalink || null, expectedPostId: rec.postId || null, expectedAuthors: [rec.fbDisplayName, rec.repostedByDisplay].filter(Boolean), // R6: BOTH the original poster AND the reserve reposter → isContentLive can find EITHER of OUR live copies (author-aware, never a stranger). permalink-direct + author-aware liveness → no duplicate re-post of an auto-released post
                settings, useProxies: !!data.useProxies, proxies: data.proxies || [],
                log: (m) => this.log(m), shouldStop: () => this._shouldStop(),
                isLoginOpen: this.isLoginOpen, isCheckOpen: this.isCheckOpen, registerAborter: (ab) => this._registerAborter(ab),
                onResult: (rc) => { try { rc.round = this._roundOffset || 0; rc.cycle = this._slicePosOf(rc.account, rc.postId); store.appendReport(rc); } catch {} },
                isOnline: () => isOnline(), waitIfPaused: () => this._waitWhilePaused(), isPaused: () => this._paused,
              }).catch((e) => { this.log(`♻️ re-post error: ${e.message}`); return { posted: 0, heldRecords: [], commentQueue: [] }; });
              if (result && result.alreadyLive) {
                // FB auto-released the original → re-home the link-comment onto the now-live post (no duplicate).
                try {
                  await store.updateComments((cs) => { // serialized via _comChain so a concurrent moderator-loop/Phase-3 write can't clobber it
                    const dup = (cs.pending || []).some((c) => c.gid === rec.gid && ((rec.captionSnip && c.captionSnip === rec.captionSnip) || (rec.postId && c.postId === rec.postId)) && c.status !== 'failed'); // pending/done/rehomed all count as already-covered
                    if (!dup && (rec.comment || rec.commentImg)) { cs.pending.push({ gid: rec.gid, postId: rec.postId || null, posterAccount: rec.posterAccount || null, fbDisplayName: rec.fbDisplayName || null, groupName: rec.groupName || null, captionSnip: rec.captionSnip || null, postCaption: rec.postCaption || null, comment: rec.comment || '', commentImg: rec.commentImg || null, postPermalink: null, status: 'pending', queuedAt: Date.now(), attempts: 0, source: 'repost_alreadylive' }); }
                  });
                  this.log(`♻️ "${rec.groupName || rec.gid}" was already live (FB released it) — link-comment queued for rescue; no duplicate post.`);
                } catch {}
                markResolved();
              } else if (result && (result.posted || 0) >= 1) {
                this.log(`✅ [${reserve.name}] re-posted the held content LIVE to "${rec.groupName || rec.gid}" — delivered (100%).`);
                // Count this delivery against the reserve's daily cap (it went through runRepost→runAccount,
                // NOT the pool, so the pool's _recordAccountOutcome never ran) — keeps the cap accurate so
                // it isn't re-picked past its limit next cycle.
                try { await this._recordAccountOutcome(reserve.name, { posted: result.posted || 0, pendingApproval: result.pendingApproval || 0, errors: result.errors || 0, flag: null, postedIds: [], dealtIds: [] }, settings); } catch {}
                // Count the LIVE re-post in the run totals: it went via runRepost (NOT the pool), so the pool's posted
                // counters never saw it → the run summary + completion report were UNDER-counting real deliveries. Gated
                // on the confirmed delivery above (result.posted>=1) → pure reporting, no re-dispatch / double-post.
                try { if (this._progress) { this._progress.posted = (this._progress.posted || 0) + (result.posted || 0); this.emit('automation-progress', { ...this._progress }); } if (this._runStats) { const _st = (this._runStats[reserve.name] = this._runStats[reserve.name] || { posted: 0, pending: 0, errors: 0 }); _st.posted = (_st.posted || 0) + (result.posted || 0); } } catch {}
                try { const cq = (result.commentQueue || []); if (cq.length) { await store.updateComments((cs) => { for (const c of cq) { const dup = (cs.pending || []).some((x) => x.gid === c.gid && ((c.captionSnip && x.captionSnip === c.captionSnip) || (c.postId && x.postId === c.postId)) && x.status !== 'failed'); if (!dup) cs.pending.push({ ...c, status: 'pending', queuedAt: Date.now(), attempts: 0 }); } }); } } catch {}
                markResolved();
              } else if (result && (result.heldRecords || []).length > 0) {
                // Replacement was ALSO HELD → a group-level spam gate (2 accounts held). Cap at 1, mark
                // failed_held, surface in the completion report. (Discard the replacement's held record — not
                // routed through the pool, so it isn't independently persisted.)
                const ms3 = store.loadModeration();
                const r3 = (ms3.held || []).find(recMatch);
                if (r3) { r3.status = 'failed_held'; r3.repostAttempts = 1; r3.note = 'replacement re-post was also held — no further attempts (group-level spam gate)'; store.saveModeration(ms3); }
                this.log(`⚠️ [${reserve.name}] replacement re-post to "${rec.groupName || rec.gid}" was ALSO held → reported undeliverable (2 accounts held = group-level spam gate). Warm/replace accounts for this group.`);
              } else {
                // Session/infra/transient failure (logged out, profile lock, crash, no composer) — NOT a
                // confirmed spam gate. REVERT to 'failed' so the held post retries next cycle with a healthy
                // reserve; do NOT consume the cap (repostAttempts stays 0).
                const msF = store.loadModeration();
                const rF = (msF.held || []).find(recMatch);
                if (rF && rF.status === 'superseded') {
                  // Cap transient re-post failures: a broken reserve (logged out / profile-lock / crash) never
                  // produces heldRecords, so without a counter it would re-attempt the SAME post every cycle
                  // forever. After 3 transient failures, mark terminal failed_held + alert the operator.
                  rF.transientFailures = (rF.transientFailures || 0) + 1;
                  if (rF.transientFailures >= 3) { rF.status = 'failed_held'; rF.repostAttempts = 1; rF.note = `re-post failed ${rF.transientFailures}× (reserve broken: logged out / profile-lock / crash) — no further attempts`; this.log(`🚧 [${reserve.name}] re-post to "${rec.groupName || rec.gid}" failed ${rF.transientFailures}× → reported UNDELIVERABLE; check/replace the reserve account for this group.`); }
                  else { rF.status = 'failed'; } // revert for one more retry next cycle (cap not consumed). R6: keep repostedBy/repostedByDisplay so the re-armed re-post recognizes the reserve's own live copy
                  store.saveModeration(msF);
                }
                const why = (result && result.flag) ? result.flag : 'transient failure';
                // Surface a logged-out reserve so the operator can re-login it (its status was otherwise stale).
                if (result && (result.flag === 'needs_login' || result.flag === 'needs_verification')) await this._markLoggedOut(reserve.name, result.flag === 'needs_verification' ? '🔐 Needs verification — re-posting skipped' : '⚠️ Logged out — re-posting skipped; re-login required');
                // A rate-limit / block WALL on the reserve's re-post must PERSIST its cool-down (mirrors the pool at :2019
                // and the Phase-3 rescue at ~:2618). Without it the reserve's rateLimitedUntil/rlStrikes are NEVER written
                // (a rate_limited outcome changes no status field, so rateLimitedUntil is the only gating residue) → every
                // reserve health gate reads it as 0 → the reserve is re-picked next cycle and re-launches on the shared IP
                // while FB still has it walled = reserve burn + ban-escalation. Reuses the LOCKED ladder unchanged; only TIGHTENS.
                else if (result && (result.flag === 'rate_limited' || result.flag === 'likely_blocked' || result.flag === 'account_disabled')) {
                  try { await this._recordAccountOutcome(reserve.name, { posted: 0, pendingApproval: 0, errors: result.errors || 0, flag: result.flag, rlKind: result.rlKind || 'post', postedIds: [], dealtIds: [] }, settings); } catch {}
                }
                this.log(`↩️ [${reserve.name}] could NOT re-post "${rec.groupName || rec.gid}" (${why}) — left for retry next cycle (re-login/replace the reserve). Cap not consumed.`);
              }
              this._setAcctState(reserve.name, (result && (result.posted || 0) > 0) ? 'done' : 'error', { posted: (result && result.posted) || 0, action: (result && (result.posted || 0) > 0) ? '✓ re-posted held content' : `re-post ${(result && result.flag) || 'not live'}` });
              // Space consecutive re-posts so a batch of held records doesn't fan out as a coordinated burst. Phase-4
              // re-posts are REAL group posts on the shared IP but bypass the pool's launch throttle, so ALSO honor the
              // opt-in realIpMinPostGapSec floor AND advance/reserve the shared _lastRealIpPostAt clock via _ipPostGate —
              // keeping re-posts coordinated with the pool's real-IP pacing (a no-op for a proxied reserve). Math.max only
              // ever RAISES the existing 30-90s guard, never lowers it.
              if (!this._shouldStop()) {
                const _reserveProxied = !!(this._proxyForAccount && this._proxyForAccount(reserve));
                await this._interruptibleSleep(Math.max(30000 + Math.floor(Math.random() * 60000), this._ipPostGate(0, _reserveProxied)));
              }
            }
          }
        } catch (e) { this.log(`⚠️ held re-post phase error: ${e.message}`); }
        finally { this._approving = false; }
      }

      // ── PHASE 3: COMMENT RESCUE ───────────────────────────────────────────────────────────────────
      // Place orphaned link-comments — posts that went LIVE but couldn't get their comment from their own
      // account (a comment rate-limit, or a transient feed miss) — using a HEALTHY account that is a
      // member of the group (preferably a reserve). So a post is NEVER left without its link. No-op when
      // the queue is empty. (Held-in-spam posts are handled by the moderator phase above, not here.)
      if (!this._shouldStop()) {
        try {
          const cs = store.loadComments();
          const pending = (cs.pending || []).filter((c) => c.status === 'pending' && (c.attempts || 0) < 3);
          if (pending.length) {
            const now = Date.now();
            const inGroup = (a, gid) => (data.groups || []).some((g) => (g.groupId || g.id) === gid && (a.assignedGroups || []).some((x) => x === g.id || x === g.groupId));
            const reserveNames = new Set((this._reserve || []).map((a) => a.name));
            // Read LIVE account state (enabled toggle / status / cool-down updated mid-cycle), not the
            // cycle-start snapshot — so a reserve turned OFF or cooled-down since the cycle began isn't dispatched.
            const liveAccts3 = (getData().accounts) || [];
            const eligibleFor = (c) => liveAccts3.filter((a) =>
              a.enabled !== false && !a.isModerator && a.status === 'logged_in' &&
              (Number(a.rateLimitedUntil) || 0) <= now && (Number(a.nextAttnRetry) || 0) <= now && a.name !== c.posterAccount && inGroup(a, c.gid) &&
              !this._jobbedOut(a.name)) // not an account that already used up its per-cycle job cap (takeover/re-post)
              .sort((a, b) => (reserveNames.has(b.name) ? 1 : 0) - (reserveNames.has(a.name) ? 1 : 0)); // reserve first
            const PER_RESCUER = 5; // cap per rescuer per cycle so it doesn't burst-comment links and get itself blocked
            // BIG-RUN SAFETY: also cap a rescuer's TOTAL rescue comments per LOCAL day. PER_RESCUER only bounds per
            // cycle, but a long completion-mode drain (≤3-min cycles) re-selects the same healthy in-group reserve
            // every cycle → dozens of link-comments/day from ONE account → it earns a comment block. Per-run day
            // counter (a fresh run resets it — fine; comments don't otherwise go through the dailyCap gate at all).
            const RESCUE_PER_DAY = 15;
            const _rday = this._localDayKey();
            if (!this._rescueDay || this._rescueDay.day !== _rday) this._rescueDay = { day: _rday, count: {} };
            const _rescuedToday = (nm) => this._rescueDay.count[nm] || 0;
            const byAccount = new Map(); const unassigned = [];
            for (const c of pending) {
              const pick = eligibleFor(c).find((a) => { const cur = (byAccount.get(a.name) || { tasks: [] }).tasks.length; return cur < PER_RESCUER && (_rescuedToday(a.name) + cur) < RESCUE_PER_DAY; });
              if (!pick) { unassigned.push(c); continue; }
              if (!byAccount.has(pick.name)) byAccount.set(pick.name, { account: pick, tasks: [] });
              byAccount.get(pick.name).tasks.push(c);
              this._rescueDay.count[pick.name] = (this._rescueDay.count[pick.name] || 0) + 1; // count toward the per-day rescue ceiling
            }
            if (unassigned.length) this.log(`⚠️ ${unassigned.length} orphaned comment(s) have no free healthy in-group account this cycle — they stay queued (assign a reserve account to those groups, or they retry next cycle).`);
            if (byAccount.size) {
              const { runRescue } = require('./rescue');
              const hidden = settings.hideBrowser !== false;
              const markResult = (task, outcome) => {
                // Serialized via _comChain. R3: RETURN the promise so the rescuer AWAITS it and confirms ok before it
                // advances/closes the browser — shrinking the crash-window between FB-placing a comment and its 'done'
                // marker reaching disk (which otherwise re-dispatches next cycle → a DOUBLE-COMMENT). The chain preserves
                // order so a concurrent moderator-loop/handoff write can't clobber this update.
                return store.updateComments(async (d2) => { // async: the notfound re-home AWAITS its moderator-queue write before flipping the record (queue-first/flip-after)
                  // Scope by posterAccount too (as the enqueue-dedup does): two DIFFERENT accounts can each hold a live
                  // pending record in the SAME group with an empty captionSnip + null postId (comment_notfound path), so
                  // an account-agnostic match could mark the WRONG account's record done/failed.
                  const rec = d2.pending.find((x) => x.gid === task.gid && x.posterAccount === task.posterAccount && (x.postId && task.postId ? x.postId === task.postId : x.captionSnip === task.captionSnip) && x.status === 'pending');
                  if (!rec) return;
                  if (outcome === 'blocked') return; // the RESCUER hit its OWN rate-limit — the comment never landed (rescue.js returns 'blocked' only when nothing was placed). Leave the record 'pending' with attempts UNCHANGED so a rested/different rescuer retries next cycle, instead of burning one of the post's 3 attempts on the rescuer's fault. No double-comment risk.
                  rec.attempts = (rec.attempts || 0) + 1;
                  if (outcome === 'done') { rec.status = 'done'; rec.commentedAt = Date.now(); }
                  else if (outcome === 'notfound') {
                    if (settings.moderationEnabled) {
                      // MODERATION ON: live-but-not-in-public-feed → actually HELD in Spam potentiel. RE-HOME it into the
                      // moderator queue (so the moderator approves it → the comment re-queues), then close THIS record.
                      if (task.captionSnip || task.postId) {
                        const _mod = await store.updateModeration((ms) => { // serialized moderation write — AWAITED so we flip the record only after the held card durably lands (independent chain, no deadlock)
                          ms.held = ms.held || [];
                          const match = (x) => x.gid === task.gid && ((task.captionSnip && x.captionSnip) ? x.captionSnip === task.captionSnip : (!!x.postId && !!task.postId && x.postId === task.postId));
                          // RE-OPEN a stale 'approved' record (set when this comment was handed off) back to 'held' so the
                          // moderator releases it AGAIN → the comment re-queues. Previously that 'approved' record VETOED the
                          // re-home push while rec was already 'rehomed' → the link vanished with a false "100% delivered".
                          const approved = ms.held.find((x) => match(x) && x.status === 'approved');
                          if (approved) {
                            approved.reopenCount = (approved.reopenCount || 0) + 1;
                            if (approved.reopenCount > 3) {
                              // BOUNDED: after 3 re-opens the post is permanently un-placeable (FB keeps re-holding it) — stop
                              // re-approving it forever (the moderator only re-approves 'held'). Mark it terminally failed +
                              // surface it, instead of an unbounded re-home → re-approve → re-queue → notfound loop.
                              approved.status = 'failed'; approved.heldFailedAt = Date.now(); approved.repostAttempts = 1; approved.note = 'approved but its comment could never be placed after 3 re-opens — live WITHOUT its comment'; // #1: this record was moderator-approved OUTSIDE markResolved (repostAttempts still 0); mark it 1 so the failed-status candidate filter (~2522) doesn't hand this ALREADY-LIVE post to Phase-4 re-post → duplicate
                              this.log(`❌ [${task.groupName || task.gid}] post repeatedly held after approval — giving up re-homing (live without its comment); place it manually.`);
                            } else {
                              approved.status = 'held'; approved.approvedAt = null; approved.note = 're-opened: approved but its comment could not be placed (still held in Spam potentiel)'; // keep the ORIGINAL heldAt so the 90-min STALE prune can still fire as a backstop
                              this.log(`🔁 [${task.groupName || task.gid}] approved post's comment couldn't be placed — re-opened for the moderator to release again (${approved.reopenCount}/3)`);
                            }
                            return;
                          }
                          // Else push a fresh card, vetoed only by a genuinely LIVE owner (held = awaiting, superseded = a
                          // re-post is mid-flight, failed_held = capped undeliverable) so a live/dead owner isn't duplicated.
                          const dup = ms.held.some((x) => match(x) && (x.status === 'held' || x.status === 'failed_held' || x.status === 'superseded'));
                          if (!dup) { ms.held.push({ postId: task.postId || null, gid: task.gid, posterAccount: task.posterAccount || null, fbDisplayName: '', captionSnip: task.captionSnip || '', postCaption: task.postCaption || null, groupName: task.groupName || null, comment: task.comment || '', commentImg: task.commentImg || null, postPermalink: task.postPermalink || null, status: 'held', heldAt: Date.now(), approvedAt: null, source: 'rescue_notfound' }); this.log(`🔁 [${task.groupName || task.gid}] orphaned comment looks HELD — re-homed to moderator approval`); }
                        });
                        // Flip to 'rehomed' ONLY if the held-card write durably landed. A failed moderation save (file
                        // lock / disk full) that still flipped the record durably lost the orphaned comment (no card, no
                        // pending record, no journal entry) → the post stayed live WITHOUT its link and the run falsely
                        // reported it delivered. On a transient failure, retry the re-home next cycle (leave 'pending') —
                        // but BOUND it exactly like every sibling terminal branch: once the 3 attempts are exhausted,
                        // SURFACE it as 'failed'. A naked 'pending' at attempts>=3 wedges INVISIBLY — _outstandingWork
                        // stops counting it (→ completionMode can declare 100% + STOP), it's excluded from re-dispatch,
                        // and the no-link report never lists it; worse, while attempts<3 a re-dispatch re-PLACES a HELD
                        // comment. 'failed' is terminal + surfaced in the completion no-link report.
                        if (_mod && _mod.ok !== false) { rec.status = 'rehomed'; rec.note = 're-homed to moderator approval (held in Spam potentiel)'; }
                        else if (rec.attempts >= 3) { rec.status = 'failed'; rec.note = 'post held in "Spam potentiel" but its moderator-queue re-home write kept failing (disk full/locked?) — live WITHOUT its comment; approve/place it manually and free disk.'; this.log(`❌ [${task.groupName || task.gid}] could NOT re-home the held comment (moderation store write failed) — live without its comment; fix disk/permissions.`); }
                        else this.log(`⚠️ [${task.groupName || task.gid}] re-home moderation save failed — left the comment PENDING to retry (not dropped).`);
                      } else if (rec.attempts >= 3) {
                        // No id/caption to re-home to a specific card → surface after 3 attempts instead of a silent 'rehomed' drop.
                        rec.status = 'failed'; rec.note = 'post held in "Spam potentiel" but has no id/caption to re-home to the moderator — live WITHOUT its comment';
                        this.log(`❌ [${task.groupName || task.gid}] link-comment could not be re-homed (no post id/caption) — live without its comment.`);
                      }
                      // else (no identity, attempts < 3): leave rec 'pending' → retry next cycle.
                    } else if (rec.attempts >= 3) {
                      // MODERATION OFF (the owner's config): there is NO moderator to release a re-home, AND re-homing can
                      // be VETOED by a stale 'approved' held record left by an alreadyLive re-post → the link-comment would
                      // vanish with no record + a false "100% delivered". So keep it RETRYABLE (attempts already incremented
                      // above), and once the 3 attempts are exhausted SURFACE it as failed instead of silently dropping it.
                      rec.status = 'failed'; rec.note = 'post looks HELD in "Spam potentiel" and there is no moderator to release it — live WITHOUT its comment';
                      this.log(`❌ [${task.groupName || task.gid}] link-comment could NOT be placed — post held with no moderator to release it (live without its comment); place it manually.`);
                    }
                    // else (moderation OFF, attempts < 3): leave rec 'pending' → a rested/different rescuer retries next cycle (still counted as outstanding, so completion won't falsely report 100% while it's owed).
                  }
                  else if (outcome === 'skipped') {
                    // The rescuer can NEVER safely identify the post — retrying won't help. Mark terminal + surface.
                    rec.status = 'skipped'; rec.note = 'cannot identify the post safely (no permalink / short caption / ambiguous feed)';
                    this.log(`⚠️ [${task.groupName || task.gid}] orphaned comment could NOT be placed safely (ambiguous post) — left for manual handling (will not retry).`);
                  }
                  else if (rec.attempts >= 3) {
                    // Exhausted 3 placement attempts — surface it so the operator knows this post is LIVE without its link.
                    rec.status = 'failed'; rec.note = rec.note || 'link-comment could not be placed after 3 attempts — post is live WITHOUT its comment';
                    this.log(`❌ [${task.groupName || task.gid}] link-comment FAILED after 3 attempts — post is live without its comment; place it manually.`);
                  }
                });
              };
              this.log(`💬 Comment rescue: ${pending.length - unassigned.length} orphaned comment(s) across ${byAccount.size} healthy account(s)…`);
              const _rescuers = [...byAccount.values()];
              for (let _ri = 0; _ri < _rescuers.length; _ri++) {
                const { account, tasks } = _rescuers[_ri];
                if (this._shouldStop()) break;
                this._setAcctState(account.name, 'running', { action: `💬 placing ${tasks.length} link-comment${tasks.length === 1 ? '' : 's'}` }); // show the rescuer working in Live Operations
                const rres = await runRescue({ account, tasks, settings, hidden, useProxies: !!data.useProxies, proxies: data.proxies || [], log: (m) => this.log(m), shouldStop: () => this._shouldStop(), isPaused: () => this._paused, waitIfPaused: () => this._waitWhilePaused(), onResult: markResult });
                // A logged-out rescuer leaves its comments pending; mark it so the operator re-logs it in.
                if (rres && rres.needsLogin) await this._markLoggedOut(account.name, '⚠️ Logged out — comment rescue skipped; re-login required');
                // A rescuer that hit a rate-limit/block wall (incl. a comment that LANDED then walled → blocked_*_landed)
                // must REST too — else it's re-picked as a rescuer next cycle and immediately re-walled (reserve burn).
                // Mirror the poster path with a short COMMENT-level cooldown so it's excluded until it settles.
                else if (rres && rres.blocked) { try { await this._recordAccountOutcome(account.name, { posted: 0, pendingApproval: 0, errors: 0, flag: 'rate_limited', rlKind: 'comment', postedIds: [], dealtIds: [] }, settings); } catch {} }
                this._setAcctState(account.name, (rres && (rres.blocked || rres.needsLogin)) ? 'error' : 'done', { action: `✓ rescued ${tasks.length} comment${tasks.length === 1 ? '' : 's'}` }); // final rescuer state in Live Operations
                // Space consecutive RESCUERS so a batch of orphan link-comments — FB's strongest single spam signal —
                // doesn't fan out as a coordinated burst from multiple accounts on the ONE shared IP. The within-
                // rescuer floor (rescue.js) paces an account's OWN comments; this paces ACROSS accounts (the IP-level
                // coordination gap the sibling Phase-4 re-post loop already enforces at ~:2486). Interruptible so
                // Stop/Pause stay responsive; only between rescuers (no trailing sleep after the last).
                if (_ri < _rescuers.length - 1 && !this._shouldStop()) await this._interruptibleSleep(30000 + Math.floor(Math.random() * 60000));
              }
            }
          }
          // Prune resolved records (done/failed/rehomed) so the queue keeps ONLY retryable 'pending'. OUTSIDE
          // `if (pending.length)` → resolved records are reaped even on cycles with zero pending (else
          // pending-comments.json grows unbounded once everything resolves). Only writes when it changed.
          try { const _cCut = Date.now() - 24 * 3600 * 1000; await store.updateComments((d3) => { d3.pending = (d3.pending || []).filter((c) => c.status === 'pending' || ((c.status === 'failed' || c.status === 'skipped') && (Number(c.commentedAt || c.queuedAt) || 0) > _cCut)); }); } catch {} // KEEP recent terminally-failed comments (a LIVE post without its link) 24h so the completion report can surface them (and the enqueue-dedup won't futilely re-queue them); done/rehomed + old failed are pruned
        } catch (e) { this.log(`⚠️ comment-rescue phase error: ${e.message}`); }
      }

      // One-time campaign: remove the posts PUBLISHED this cycle so each post is used
      // exactly once (and the run ends when the library empties). Pending-approval posts
      // are NOT in cyclePostedIds, so they survive. Serialized via store.update so a
      // concurrent UI/remote edit can't be clobbered.
      if (settings.autoDeletePosted && cyclePostedIds.length) {
        const del = new Set(cyclePostedIds);
        const { removed, remaining, files } = await store.update((d) => {
          const before = d.posts.length;
          const removedFiles = [];
          for (const p of d.posts) if (del.has(p.id)) { for (const f of (p.imagePaths || [])) if (f) removedFiles.push(f); if (p.commentImagePath) removedFiles.push(p.commentImagePath); }
          d.posts = d.posts.filter((p) => !del.has(p.id));
          return { removed: before - d.posts.length, remaining: d.posts.length, files: removedFiles };
        });
        // Unlink the deleted posts' LOCAL image files (only ones under the app's images dir — never a path outside it).
        // Without this, auto-delete orphans every posted image forever → unbounded disk growth → eventually the atomic
        // data.json/cookies writes fail. (imageUrl/commentImageUrl are remote → no local file to remove.)
        try { this._unlinkDeletedImages(files, (store.paths && store.paths.IMAGES_DIR) || ''); } catch {}
        this.emit('data-updated');
        this.log(`🗑️ Auto-deleted ${removed} posted post(s) — ${remaining} remaining`);
      }

      if (this._shouldStop() || this._finish) break;

      // CAMPAIGN PLAN big-cycle: every group-set has received the WHOLE library (all agents finished their
      // slices). If Loop Campaign is ON, start a fresh round (rotate who-posts-what; pace from the next day).
      // If OFF, the completion engine just below drains any last comments/held, then reports + stops.
      if (this._campaignPlan && settings.loopCampaign && this._campaignAllFinished()) {
        this._roundOffset = (this._roundOffset || 0) + 1;
        const planAgents = this._campaignRoster(); // CP1: reloop over the STABLE roster too, so the new round's batchId matches the in-cycle plan build (line ~1694) and the reserve rotation can't desync them
        { const _dk = this._localDayKey(); const _N = Math.max(1, Math.min(20, parseInt(settings.cyclesPerDay, 10) || 1));
          for (const a of planAgents) (this._perAccountRotation || (this._perAccountRotation = {}))[a.name] = { lastPostId: null, lastPostedDate: _dk, postsToday: _N, postsTodayDate: _dk }; } // reset slice; mark today's quota FULL so a new round paces to next day (matches "resumes next day")
        const planPosts = (this._data.posts || []); // full library — per-cluster postFilter applied inside _computeCampaignPlan
        this._campaignPlan = this._computeCampaignPlan(planPosts, planAgents, this._roundOffset);
        this._pendingPlanBatchId = null; // #2: the new round IS the recompute — any edit held during the last round is now applied, so clear the pending marker
        this._saveRotationState();
        this.log('🔁 Campaign Plan: every group-set received the full library — new round started (reshuffled who posts what); resumes next day.');
      }

      // ── COMPLETION ENGINE ────────────────────────────────────────────────────────────────────────
      // Engages for completionMode OR a finishing campaign-plan (Loop OFF). Keep self-healing (reserve
      // takeover, retries, comment rescue, moderator approval all ran this cycle) until EVERYTHING is
      // delivered, then auto-stop + report. Two phases:
      //  • POSTING (undealt>0): fall through to the NORMAL guards below so a dead fleet is caught fast by the
      //    stall-breaker (with its named cause); we only suppress the premature "all dealt → stop" (guarded above).
      //  • DRAINING (undealt===0): posts are all out, only comments/held remain — loop FAST (≤3min) to place
      //    them. Stuck items self-resolve (comment retry ×3, held→failed after 30min); backstop stops + reports
      //    if NOTHING drains for ~12 cycles.
      const _campaignFinishing = !!(this._campaignPlan && !settings.loopCampaign && (this._active || []).some((a) => (a.postingOrder || '') === 'campaign-plan'));
      if (settings.completionMode || _campaignFinishing) {
        const out = this._outstandingWork(active); // computed ONCE per cycle
        if (out.hasFinite) {
          if (out.total === 0) { this._emitCompletionReport('completed'); break; }
          if (out.undealt === 0 && (out.pending || out.held)) {
            if (this._lastOutstanding != null && out.total >= this._lastOutstanding) this._noDrain = (this._noDrain || 0) + 1; else this._noDrain = 0;
            this._lastOutstanding = out.total;
            if (this._noDrain >= 12) { this._drainingCompletion = false; this._emitCompletionReport('undeliverable', out); break; }
            this._drainingCompletion = true; // bypass the daily 24h gate so the drain cycles every ≤3min, not once/day
            this.log(`⏳ Completion mode: all posts published — placing ${out.pending} comment(s) + approving ${out.held} held post(s)…`);
            await this._waitWithCountdown(Math.min(rangeMs(settings, 'waitIntervalMin', 'waitIntervalMax', 90, 180, 60000, 1), 180000), 'Completing campaign');
            if (this._shouldStop() || this._finish) break;
            continue; // drain phase governs the loop — skip the stall-breaker (which would misread 0 posts as a stall)
          }
          this._drainingCompletion = false; // still posting (undealt>0) → normal daily cadence applies
          this._noDrain = 0; this._lastOutstanding = out.total; // still posting → reset drain tracker, use normal guards/wait below
        }
      }

      // All-sessions-invalid guard: if a whole cycle published/queued NOTHING and at least one
      // account reported it was logged out, looping again would just relaunch browsers that all
      // bail. Stop with a clear reason instead of spinning forever unattended.
      if (cycleDealtIds.length === 0 && (cycleFlags.includes('needs_login') || cycleFlags.includes('account_disabled') || cycleFlags.includes('needs_verification') || cycleFlags.includes('proxy_invalid'))) {
        // Don't hard-stop if any active account is merely COOLING DOWN — those self-recover, so defer to the
        // rate-limit hold below (a mixed fleet of one logged-out + others cooling must not kill the whole run).
        const _n = Date.now();
        const _liveA = getData().accounts || [];
        const anyCooling = (this._active || []).some((a) => { const live = _liveA.find((x) => x.name === a.name) || a; return (Number(live.rateLimitedUntil) || 0) > _n; });
        if (!anyCooling) {
          this.log('🛑 No account could post this cycle — accounts need attention (logged out, disabled, or identity-verification required) and auto-login could not recover them. Stopping. Fix the flagged accounts, then Start again.');
          break;
        }
      }
      // DAILY-CAP HOLD: if every active poster simply hit today's cap (not cooling, not flagged), the run
      // is DONE FOR TODAY — wait for the UTC day to roll over and resume, instead of tripping the stall-
      // breaker and STOPPING (which would leave the app dead hours before tomorrow). A rate-limited or
      // flagged fleet is NOT a cap-hold (those still fall through to the real stop below).
      const _cap = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
      if (cycleDealtIds.length === 0 && _cap > 0) { // #4: applies in DAILY mode too — the daily gate waits on the cyclesPerDay COUNT, not the per-account daily CAP, so a fleet that hits its cap before the day's cycles are used up would otherwise fall through to the stall-breaker and STOP mid-day (with a self-contradicting "resumes after midnight" message)
        const _now = Date.now();
        const _liveAccts = (getData().accounts || []);
        const _activePosters = (this._active || []).filter((a) => a.enabled !== false && !a.isModerator);
        const _allCapped = _activePosters.length > 0 && _activePosters.every((a) => {
          const live = _liveAccts.find((x) => x.name === a.name) || a;
          if ((Number(live.rateLimitedUntil) || 0) > _now) return false; // cooling down → not a cap-only stall
          if (live.status && live.status !== 'logged_in' && live.status !== 'idle') return false; // review-fix: gate on LIVE status (matches line 2987 + the "bad account" definition ~3193), NOT the sticky run-lifetime _runFlags — a single EARLIER rate-limit that has since RECOVERED otherwise poisons _allCapped forever, so a capped fleet skips the midnight hold and the stall-breaker STOPS the run mid-day (defeating days-unattended)
          return store.dailyUsed(live.daily) >= _cap;
        });
        if (_allCapped) {
          const d = new Date(_now);
          // #3: wait to the next LOCAL midnight (+30s) — store.dailyUsed/todayKey roll the cap window at LOCAL midnight
          // (store.js), not UTC. The old Date.UTC(...) idled the whole timezone offset every capped day (e.g. ~2h in
          // UTC+2) and could re-hold ~24h in negative-offset zones. Mirrors the sibling daily-rotation hold just below.
          const nextLocalMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 30).getTime();
          const waitMs = Math.max(60000, nextLocalMidnight - _now);
          this._zeroProgressCycles = 0; // a deliberate cap hold is NOT a stall
          this.log(`📵 All active accounts hit today's daily cap (${_cap}/day) — waiting ~${Math.round(waitMs / 360000) / 10}h for the next day, then resuming automatically.`);
          await this._waitWithCountdown(waitMs, 'Next day (daily cap)');
          if (this._shouldStop() || this._finish) break;
          continue; // resume next day with fresh daily counts
        }
      }
      // DAILY-ROTATION HOLD: in continuous schedule (no daily gate), once every active daily-rotation agent
      // has posted its one-per-day, wait for the next LOCAL day instead of looping idle (which would trip the
      // stall-breaker). Lets daily-rotation self-pace to 1/day even without the Daily schedule. (In Daily
      // schedule mode the top-of-loop gate already does the waiting, so this is skipped there.)
      if (cycleDealtIds.length === 0 && settings.scheduleMode !== 'daily' && (this._active || []).length > 0) {
        const _today = this._localDayKey();
        // Fire when every DAILY-ROTATION / CAMPAIGN-PLAN agent has posted today. We filter to THOSE agents
        // first (the old code used .every() over ALL active accounts, so any non-DR account — e.g. a finished
        // unique agent still in the active set — made it return false, so the hold never fired in a mixed
        // fleet and the stall-breaker wrongly STOPPED the run, killing the daily-rotation agents). The
        // cycleDealtIds===0 guard above already means nothing else produced this cycle, so holding to the next
        // day is safe — everyone retries tomorrow.
        const drAgents = (this._active || []).filter((a) => {
          const o = a.postingOrder || '';
          if (o === 'daily-rotation') return true;
          // campaign-plan: EXCLUDE surplus-idle agents (empty slice from the spread pass) — they never post, so
          // requiring them to have "posted today" would block the hold forever and trip the stall-breaker.
          if (o === 'campaign-plan') return this._campaignNextIdx(a.name).len > 0;
          return false;
        });
        const _allRotatedToday = drAgents.length > 0 && drAgents.every((a) => ((this._perAccountRotation || {})[a.name] || {}).lastPostedDate === _today);
        if (_allRotatedToday) {
          const d = new Date();
          const nextLocalMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 30).getTime();
          const waitMs = Math.max(60000, nextLocalMidnight - Date.now());
          this._zeroProgressCycles = 0; // a deliberate rotation hold is NOT a stall
          this.log(`🔁 All daily-rotation agents have posted today — waiting ~${Math.round(waitMs / 360000) / 10}h for the next day, then each posts its next post.`);
          await this._waitWithCountdown(waitMs, 'Next day (daily rotation)');
          if (this._shouldStop() || this._finish) break;
          continue;
        }
      }
      // ALL-RATE-LIMITED HOLD: if nothing posted (reserves included) and EVERY active poster is cooling down
      // from a rate-limit, the fleet isn't dead — it just needs to wait out the cool-down. Sleep until the
      // earliest expiry, then resume — instead of burning cycles into the stall-breaker and STOPPING (which
      // would leave the app dead for hours when it would have recovered on its own). The single wait is capped
      // at ~1h so it re-checks periodically (an account may re-login or the operator may intervene sooner).
      if (cycleDealtIds.length === 0 && (this._active || []).length > 0) {
        const _now = Date.now();
        const _live = (getData().accounts || []);
        const _posters = (this._active || []).filter((a) => a.enabled !== false && !a.isModerator);
        const _until = _posters.map((a) => Number((_live.find((x) => x.name === a.name) || a).rateLimitedUntil) || 0);
        if (_posters.length > 0 && _until.every((t) => t > _now)) {
          const waitMs = Math.max(60000, Math.min(Math.min(..._until) - _now + 30000, 3600000)); // earliest expiry +30s, capped at 1h
          this._zeroProgressCycles = 0; // a deliberate cool-down hold is NOT a stall
          this.log(`🧊 All active accounts are cooling down from rate-limits — waiting ~${Math.round(waitMs / 60000)} min for the earliest to recover, then resuming automatically (the run does not stop).`);
          await this._waitWithCountdown(waitMs, 'Rate-limit cool-down');
          if (this._shouldStop() || this._finish) break;
          continue;
        }
      }
      // Dead-fleet / stall breaker: if the run dealt NOTHING for several cycles in a row (every account
      // likely-blocked, group-less, or disabled — NOT merely cooling, which the hold above now handles), STOP
      // instead of relaunching browsers forever unattended.
      this._zeroProgressCycles = (cycleDealtIds.length === 0) ? (this._zeroProgressCycles || 0) + 1 : 0;
      if (this._zeroProgressCycles >= 3) {
        // M4-09: name the most likely root cause so the operator knows whether to WAIT (cool-down)
        // or ACT (assign groups / fix flagged accounts), instead of a generic "check your accounts".
        const active = this._active || [];
        const now = Date.now();
        const rl = active.filter((a) => (Number(a.rateLimitedUntil) || 0) > now).length;
        const noGroups = active.filter((a) => !(a.assignedGroups && a.assignedGroups.length)).length;
        const flagged = Object.keys(this._runFlags || {}).length;
        const capN = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
        const capped = capN > 0 ? active.filter((a) => { const live = (getData().accounts || []).find((x) => x.name === a.name) || a; return store.dailyUsed(live.daily) >= capN; }).length : 0;
        let cause;
        if (active.length && capped === active.length) cause = `all ${active.length} active account(s) have hit today's daily cap (${capN}/day) — they will resume automatically after local midnight (no action needed)`;
        else if (active.length && rl === active.length) cause = `all ${active.length} active account(s) are rate-limited and cooling down — wait for the cool-down to elapse, then Start again`;
        else if (active.length && noGroups === active.length) cause = 'no active account has any groups assigned — assign groups in the Accounts tab';
        else if (flagged) cause = `${flagged} account(s) need attention (logged out, checkpoint, or blocked) — fix the flagged accounts, then Start again`;
        else cause = 'check your accounts/groups (rate-limited, blocked, logged out, or no groups assigned)';
        this.log(`🛑 3 cycles in a row posted nothing — stopping so the app doesn't spin unattended. Likely cause: ${cause}.`);
        break;
      }
      // maxCycles is a hard cycle cap — but DON'T let it cut a "deliver everything then stop" campaign short:
      // Completion mode and a finishing (Loop-OFF) campaign-plan have their OWN stop condition (100% delivered),
      // so maxCycles is ignored while those are draining (it would otherwise abort mid-distribution).
      const _completionDriven = settings.completionMode || (this._campaignPlan && !settings.loopCampaign && (this._active || []).some((a) => (a.postingOrder || '') === 'campaign-plan'));
      if (!_completionDriven && (settings.maxCycles || 0) > 0 && cycle >= settings.maxCycles) {
        this.log(`🏁 Reached maxCycles (${settings.maxCycles}) — finishing.`); break;
      }
      if (settings.scheduleMode === 'daily') {
        // Mark today's run done + persist (survives a same-day restart) so the top-of-loop daily gate now
        // waits until TOMORROW's fire time. The continuous inter-cycle wait below is skipped in daily mode.
        this._drainingCompletion = false; // a normal daily cycle finished → resume the 24h gate
        // Do NOT re-derive _lastDailyRunDate from the wall clock here — it was already set to the FIRE-day at the top
        // of this cycle (line ~1073) and persisted. If this cycle crossed LOCAL midnight, _localDayKey() now returns
        // D+1; marking D+1 as "already ran" would SKIP D+1's scheduled fire entirely (a dropped day every time a long
        // or late cycle runs past midnight). The top-of-loop gate already waits ~24h from the fire-day.
        this.log(`📅 Cycle complete.`); // the top-of-loop daily gate logs the real next step (another cycle this run, or "run complete → next run tomorrow")
        continue; // the top-of-loop daily gate decides: another cycle (cyclesPerRun not reached) or wait until tomorrow's fire
      }
      const cycleWaitMs = this._interCycleMs(settings); // T3: randomized inter-cycle wait ("time between cycles" — cycleGapMin override, else waitInterval)
      this.log(`✅ Cycle ${cycle} complete. Waiting ~${Math.round(cycleWaitMs / 60000)} min (randomized) before next cycle…`);
      await this._waitWithCountdown(cycleWaitMs, 'Next cycle');
    }
  }

  async _interruptibleSleep(ms) {
    const step = 1000; let waited = 0;
    while (waited < ms && !this._shouldStop()) {
      if (this._paused) { await this._waitWhilePaused(); if (this._shouldStop()) break; continue; } // honor Pause (e.g. mid-stagger)
      await sleep(Math.min(step, ms - waited)); waited += step;
    }
  }

  // Sleep with a live countdown so the log keeps updating during long waits (between
  // cycles/batches) instead of going silent. Logs every 30s; interruptible by Stop.
  async _waitWithCountdown(ms, label, allowSleep = true) {
    if (!(ms > 0)) return;
    // Long REST (daily wait until TOMORROW, or a long cool-down): release the keep-awake sleep-block so the
    // operator CAN let the laptop sleep; it re-acquires when this wait ends and posting resumes. Short
    // inter-cycle pauses (<5 min) keep the laptop awake (no point sleeping that briefly).
    // allowSleep=false → KEEP AWAKE even on a long wait: used while waiting for TODAY's still-pending scheduled
    // post (e.g. set 20:00 at 15:00) so the laptop can't doze off and miss the fire. Overnight rests pass true.
    const restMode = ms > 5 * 60 * 1000 && allowSleep;
    if (restMode) { try { this.emit('keep-awake', false); } catch {} this.log('😴 At rest until the next scheduled run — the laptop may sleep now; it resumes automatically (no posts lost).'); }
    let end = Date.now() + ms;
    let lastLog = 0, lastEmit = 0;
    const _logEveryMs = ms > 5 * 60 * 1000 ? 300000 : 30000; // #1: on a LONG wait (>5min) LOG the countdown only every 5min (was every 30s → ~270 noise lines/day); short waits keep 30s. The UI progress emit stays at 30s for liveness.
    const fmt = (sec) => { const m = Math.floor(sec / 60), s = sec % 60; return (m > 0 ? m + 'm ' : '') + s + 's'; };
    while (Date.now() < end && !this._shouldStop() && !this._finish) { // Finish wakes a long daily-schedule wait
      if (this._paused) {
        const pausedAt = Date.now();
        await this._waitWhilePaused();
        end += Math.max(0, Date.now() - pausedAt); // clamp: a backward clock step must not shrink the wait
        if (this._shouldStop()) break;
        continue;
      }
      if (lastEmit === 0 || Date.now() - lastEmit >= 30000) {
        lastEmit = Date.now();
        const remaining = Math.ceil((end - Date.now()) / 1000);
        if (lastLog === 0 || Date.now() - lastLog >= _logEveryMs) { lastLog = Date.now(); this.log(`⏳ ${label} in ${fmt(remaining)}…`); } // #1: log throttled; emit below stays 30s
        if (this._progress) { this._progress.waitingLabel = label; this._progress.waitRemainingSec = remaining; this.emit('automation-progress', { ...this._progress }); }
      }
      await sleep(1000);
    }
    if (restMode) { try { this.emit('keep-awake', true); } catch {} } // rest over → re-block sleep so the resuming posts render reliably
    if (this._progress) { this._progress.waitingLabel = null; this._progress.waitRemainingSec = 0; this.emit('automation-progress', { ...this._progress }); }
  }

  // LOCAL calendar-day key (the 'daily' schedule fires at a LOCAL wall-clock time, so the de-dupe key
  // must be local too — UTC would be off-by-one near midnight).
  _localDayKey(d = new Date()) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
  // ms until the next 'daily' fire for dailyPostTime ('HH:MM' local). 0 = fire NOW (today's time has
  // arrived and we haven't run today). If we already ran today, returns ms until tomorrow's time.
  // nowMs is injectable (defaults to the real clock) SOLELY so the scheduling decision is unit-testable
  // at a fixed instant — production passes no argument, so behavior is byte-identical to `new Date()`.
  _msUntilDailyFire(timeStr, lastRunDateKey, nowMs = Date.now()) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(timeStr || '09:00')) || [null, '9', '0'];
    const hh = parseInt(m[1], 10) || 0, mm = parseInt(m[2], 10) || 0;
    const now = new Date(nowMs);
    const fireToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (lastRunDateKey === this._localDayKey(now)) { const t = new Date(fireToday.getTime()); t.setDate(t.getDate() + 1); return t.getTime() - now.getTime(); }
    return Math.max(0, fireToday.getTime() - now.getTime());
  }

  // Mark a reserve/rescue account logged-out on disk + refresh the UI, so a backup that turned out to be
  // logged out during its job surfaces in the Accounts tab (was previously left showing a stale status).
  async _markLoggedOut(name, msg) {
    try {
      await store.update((d) => { const a = (d.accounts || []).find((x) => x.name === name); if (a) { a.status = 'not_logged_in'; a.lastMessage = msg || '⚠️ Logged out — re-login required'; } });
      this.emit('data-updated');
    } catch {}
  }

  // Completion engine: how much of a FINITE campaign is still outstanding — posts not yet published
  // (unique/sequence undealt), link-comments still queued for rescue, and posts still held awaiting a
  // moderator. total===0 ⇒ everything's delivered. Returns 0 undealt when there are no finite accounts
  // (daily-rotation/post-centric are ongoing, not a finite campaign).
  _outstandingWork(active) {
    const data = this._data || {};
    const finite = (active || []).filter((a) => { const o = a.postingOrder || 'post-centric'; return o.includes('unique') || o === 'sequence'; });
    let undealt = 0;
    if (finite.length) {
      const seen = new Set();
      // Per account, count only undealt posts IN THAT ACCOUNT'S SET (postsForSet) — otherwise a set-restricted
      // unique/sequence agent inflates the outstanding count with posts it can never deliver, so the run never completes.
      for (const a of finite) for (const p of postsForSet(data.posts || [], a).filter((p) => matchesFilter(p, a.postFilter || 'all'))) if (!this._dealt.has(p.id)) seen.add(p.id);
      undealt = seen.size;
    }
    // Campaign-plan posts not yet delivered (tracked by per-agent pointers, not the shared dealt-set). #1: tally over the
    // PLAN ROSTER (agentLists keys), NEVER the per-cycle `active` set — a cycle that RESERVES all campaign agents (the
    // reserve pass can hold a whole cluster) would else see no active campaign agents → skip _campaignRemaining + the owed
    // loop → collapse undealt to 0 → a FALSE 100%-complete that STOPS the run with campaign posts still owed (the CP1
    // active-vs-roster anti-pattern — fixed for _campaignAllFinished/_campaignRemaining — had been reintroduced here).
    // _campaignRemaining() self-gates to 0 when there is no campaign plan; adding it can only RAISE outstanding work.
    const _campRosterNames = (this._campaignPlan && this._campaignPlan.agentLists) ? Object.keys(this._campaignPlan.agentLists) : [];
    undealt += this._campaignRemaining();
    // PARTIAL-DELIVERY owed ([8]): un-reached (post,group) pairs the ROSTER still owes are outstanding — count over the
    // roster (not `active`), so completionMode can't declare "100% delivered" before those groups get the post.
    for (const name of _campRosterNames) { const o = (this._owed || {})[name]; if (o && (o.gids || []).length) undealt += o.gids.length; }
    // [9-REVERTED] There is deliberately NO unique/sequence owed tally here. [9] added one to catch the strand its own
    // pick-override created; the override was reverted (see the note at the unique/sequence pick), and this tally was
    // residue. Post-revert its gate was exactly INVERTED against the producer: the obligation gate can only create
    // daily-rotation/campaign-plan entries (for which _isUniqueSeqAgent is FALSE, so the loop was dead for its stated
    // purpose), while the ONLY reachable unique/sequence-owned entry is a STALE mode-flipped one (for which it is TRUE)
    // — so it counted as outstanding precisely the entries nothing can discharge → completionMode wedged at total>0
    // FOREVER (a livelock). Its own rationale ("the owed pick-override drops that stale entry on the agent's next real
    // pick") described a safety net that no longer exists.
    // KNOWN GAP, tracked in ADR-0022: a stranded unique/sequence partial is therefore NOT counted, so completion can
    // imply 100% for it. The fix is a READ-ONLY strand report — never an _owed entry, because anything a consumer can
    // turn back into a post needs the whole coherence invariant again.
    let pending = 0, held = 0, failed = 0, failedHeld = 0, superseded = 0;
    try { pending = (store.loadComments().pending || []).filter((c) => c.status === 'pending' && (c.attempts || 0) < 3).length; } catch {}
    try { const hh = (store.loadModeration().held || []); held = hh.filter((h) => h.status === 'held').length; failed = hh.filter((h) => h.status === 'failed').length; failedHeld = hh.filter((h) => h.status === 'failed_held').length; superseded = hh.filter((h) => h.status === 'superseded').length; } catch {}
    // 'failed' = a held post escalated past the 90-min approval window. With repost ON it's a Phase-4 re-post
    // candidate → STILL OUTSTANDING (counted, so completion waits for the re-post). With repost OFF it has NO
    // recovery path → NOT counted (else a held-heavy run could never complete) BUT it is UNDELIVERED, so
    // _emitCompletionReport surfaces it loudly instead of a silent drop + a false "100% delivered". (Before this
    // fix a held post that aged to 'failed' with repost off was dropped from `total` → completion lied at scale.)
    // failedHeld = terminal undeliverable (surfaced, never counted).
    // 'superseded' = a Phase-4 re-post is mid-flight (status persisted BEFORE awaiting runRepost). A hard-kill mid-re-post
    // leaves it durably 'superseded'; count it as outstanding (repost ON) so a stop-and-report can't fire a false "100%
    // delivered" before _pruneModeration reverts it (30-min window) → 'failed' → a re-post. Only DELAYS completion; the
    // Phase-1 re-hold dedup already excludes superseded, so counting it can never cause a double-post.
    const repostOn = !!(this._data && this._data.settings && this._data.settings.repostEnabled);
    return { undealt, pending, held, failed, failedHeld, superseded, total: undealt + pending + held + (repostOn ? failed + superseded : 0), hasFinite: finite.length > 0 || _campRosterNames.length > 0 }; // #1: hasFinite's campaign term is roster-based so it never flips based on which agents were reserved this cycle
  }

  // Final report when a completion-mode run ends: what got delivered, what's left (if undeliverable), and
  // which accounts went bad so the operator knows exactly which to replace.
  _emitCompletionReport(reason, out) {
    const data = this._data || {};
    const stats = this._runStats || {};
    let posted = 0, pending = 0, errors = 0;
    for (const k of Object.keys(stats)) { posted += stats[k].posted || 0; pending += stats[k].pending || 0; errors += stats[k].errors || 0; }
    const now = Date.now();
    const bad = (data.accounts || []).filter((a) => !a.isModerator && (
      (this._runFlags && this._runFlags[a.name]) || (Number(a.rateLimitedUntil) || 0) > now ||
      (a.status && a.status !== 'logged_in' && a.status !== 'idle')));
    let undeliv = 0; try { const hh = store.loadModeration().held || []; undeliv = hh.filter((h) => h.status === 'held' || h.status === 'failed' || h.status === 'superseded').length; } catch {}
    // Posts that are LIVE but whose link-comment terminally FAILED (3 attempts / held with no moderator) — a silent
    // "live without its comment" gap the held-only count above misses. Surface them so 'every comment delivered' never
    // fires while a live post lacks its link.
    let noLink = []; try { noLink = (store.loadComments().pending || []).filter((c) => c.status === 'failed' || c.status === 'skipped'); } catch {}
    if (reason === 'completed' && !undeliv && !noLink.length) this.log('🎉 Campaign complete — every post published and every comment delivered. Stopping.');
    else if (reason === 'completed') this.log(`🏁 Campaign delivered its posting work${undeliv ? `, but ${undeliv} post(s) are still HELD / undelivered — Facebook held them and there's no moderator or reserve to recover them (turn on 🛡️ Moderator Approval, or Reserve Re-post)` : ''}${noLink.length ? `${undeliv ? '; also ' : ', but '}${noLink.length} live post(s) are WITHOUT their link-comment (place manually): ${[...new Set(noLink.map((c) => c.groupName || c.gid))].slice(0, 20).join(', ')}` : ''}. Stopping.`);
    else this.log(`🏁 Stopping: ${out ? out.total : '?'} item(s) could not be delivered (${out ? `${out.undealt} unposted, ${out.pending} comments, ${out.held} held` : ''}) — see below.`);
    this.log(`📊 Delivered this run: ${posted} published, ${pending} pending-approval, ${errors} error(s).`);
    if (bad.length) this.log(`🔧 Accounts to REPLACE/check (went bad this run): ${bad.map((a) => `${a.alias || a.name}${(Number(a.rateLimitedUntil) || 0) > now ? ' (rate-limited)' : (this._runFlags && this._runFlags[a.name] ? ` (${this._runFlags[a.name]})` : '')}`).join(', ')}`);
    else this.log('✅ No accounts went bad this run.');
    // Posts that stayed held even after a replacement re-post (group-level spam gate) — the only undelivered gap.
    try { const fh = (store.loadModeration().held || []).filter((h) => h.status === 'failed_held'); if (fh.length) this.log(`🚧 ${fh.length} (post,group) pair(s) UNDELIVERABLE — held even after a replacement re-post: ${fh.map((h) => h.groupName || h.gid).join(', ')}. Warm/replace accounts for those groups, or post different content there.`); } catch {}
  }

  // ── CAMPAIGN PLAN (campaign-plan mode) ───────────────────────────────────────────────────────────
  // Cluster agents by their SHARED group-set, then WITHIN each cluster partition the WHOLE post library
  // across the cluster's agents (round-robin) — so every group-set receives the entire campaign, split
  // across its team of agents, 1 post/agent/day. Returns per-agent ordered lists (each agent walks its
  // own list via the daily pointer) plus a cluster preview. Pure + deterministic (agent order preserved).
  // Launch ORDER across batches (start-order only — post assignment keys off this._active, untouched). A "batch"
  // = accounts sharing an identical group-set. 'batch' keeps the natural grouped order (A1 A2 A3 B1 B2 B3);
  // 'interleave' round-robins across batches (A1 B1 A2 B2 …) so consecutive launches hit DIFFERENT groups;
  // 'random' shuffles (seeded by the cycle so it stays reproducible for tests/resume).
  _orderLaunchQueue(queue, mode, seed) {
    if (!Array.isArray(queue) || queue.length < 2) return queue || [];
    if (mode === 'random') return seededShuffle(queue, seed);
    if (mode === 'interleave') {
      const byBatch = new Map();
      for (const a of queue) { const k = (a.assignedGroups || []).slice().sort().join('|'); if (!byBatch.has(k)) byBatch.set(k, []); byBatch.get(k).push(a); }
      const lists = [...byBatch.values()]; const out = [];
      for (let i = 0, more = true; more; i++) { more = false; for (const l of lists) { if (i < l.length) { out.push(l[i]); more = true; } } }
      return out;
    }
    return queue; // 'batch' (default) — natural grouped order, unchanged
  }

  _computeCampaignPlan(posts, agents, roundOffset = 0) {
    // 🔀 Random work-pattern: shuffle the library before partitioning (seeded by the round → reproducible, and
    // reshuffles on each reloop). Keeps the batch-split model; just removes the predictable #1,#2,#3 order.
    if (this._data && this._data.settings && this._data.settings.shuffleCampaign) posts = seededShuffle(posts, (roundOffset || 0) + 1);
    // Cluster signature = shared groups + assigned post-set. Including the set means two agents with the SAME groups
    // but DIFFERENT post-sets land in SEPARATE clusters (each draws its own set) instead of colliding into one where
    // only cAgents[0]'s set would win. No set assigned → '::' suffix is uniform, so behavior is unchanged.
    const sig = (a) => (a.assignedGroups || []).slice().sort().join('|') + '::' + (a.postSetId || '');
    const clusters = new Map(); // group signature -> [agents] (insertion order = deterministic)
    for (const a of agents) { const k = sig(a); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(a); }
    // POST-SETS: each cluster (group-signature) draws ONLY from its assigned post-set (cAgents[0].postSetId) so
    // different batches deliver different content. No set assigned (null) → the whole library, so existing
    // single-library campaigns are 100% unchanged. Resolve each cluster's post list ONCE here.
    const _setOf = (cAgents) => (cAgents[0] && cAgents[0].postSetId) || null;
    const _postsForCluster = (cAgents) => { const sid = _setOf(cAgents); const pf = (cAgents[0] && cAgents[0].postFilter) || 'all'; return (sid ? posts.filter((p) => (p.postSetId || null) === sid) : posts).filter((p) => matchesFilter(p, pf)); };
    const clusterPosts = new Map();
    for (const [k, cAgents] of clusters) clusterPosts.set(k, _postsForCluster(cAgents));
    // CP2 (warn, don't split): each cluster is gated by cAgents[0].postFilter (above). If agents in ONE cluster
    // DISAGREE on postFilter, the others' filters are silently ignored → wrong content + a whole filter's posts
    // undelivered. We do NOT add postFilter to the cluster signature: filters OVERLAP (all ⊇ with-comments), so
    // splitting would re-deliver the shared posts on a later day (the per-(post,group) ledger dedups only WITHIN a
    // cycle) = over-delivery on the shared IP. Safer to keep one cluster (under-deliver) and warn the operator once.
    if (!this._clusterFilterWarned) {
      for (const [, cAgents] of clusters) {
        const filters = new Set(cAgents.map((a) => (a.postFilter || 'all')));
        if (filters.size > 1) {
          this._clusterFilterWarned = true;
          this.log(`⚠️ Campaign Plan: ${cAgents.map((a) => a.name).join(', ')} share the same groups/post-set but have DIFFERENT post filters (${[...filters].join(' vs ')}). They're gated by ONE filter (the first account's), so the other filter's posts go undelivered. Give same-group campaign accounts the SAME post filter, or put them on different post-sets.`);
          break;
        }
      }
    }
    const agentLists = {};
    // Pass 1: each cluster of K agents round-robin-partitions ITS post-set → ~ceil(P/K) posts/agent, 1/day.
    // roundOffset rotates WHICH agent starts the partition so a new big-cycle reshuffles who posts what.
    for (const [k, cAgents] of clusters) {
      const K = cAgents.length;
      const cPosts = clusterPosts.get(k);
      cAgents.forEach((a, j) => { const slot = (j + roundOffset) % K; agentLists[a.name] = cPosts.filter((_, idx) => idx % K === slot).map((p) => p.id); });
    }
    // Pass 2 — SPREAD TO MAX DURATION: a bigger cluster finishes in fewer days and would then IDLE while a slower
    // cluster keeps posting (and _campaignAllFinished can't reloop until ALL agents are done). Instead make every
    // cluster span the SLOWEST cluster's day-count: a faster cluster uses only as many agents (Keff) as needed to
    // pace the library over those days, at an even daily volume. The active subset ROTATES by roundOffset, so no
    // agent idles forever — across rounds every agent takes a turn. Net: no idle gap (all clusters finish together
    // → the existing reloop restarts the campaign), and the fast cluster's groups aren't flooded in one day.
    const globalMaxLen = Math.max(0, ...Object.values(agentLists).map((l) => l.length));
    if (globalMaxLen > 0) {
      for (const [k, cAgents] of clusters) {
        const K = cAgents.length;
        const cPosts = clusterPosts.get(k);
        const curLen = Math.max(0, ...cAgents.map((a) => agentLists[a.name].length));
        if (curLen >= globalMaxLen) continue; // the pace-setting (slowest) cluster — already spans max days
        const Keff = Math.max(1, Math.min(K, Math.ceil(cPosts.length / globalMaxLen))); // agents needed to span max days (this set's count)
        const shift = ((roundOffset % K) + K) % K; // rotate WHICH agents are active this round
        cAgents.forEach((a, j) => {
          const rank = (((j - shift) % K) + K) % K; // ranks 0..Keff-1 are the active posters this round
          agentLists[a.name] = rank < Keff ? cPosts.filter((_, idx) => idx % Keff === rank).map((p) => p.id) : [];
        });
      }
    }
    const preview = [];
    for (const [k, cAgents] of clusters) {
      const cPosts = clusterPosts.get(k);
      const maxLen = Math.max(0, ...cAgents.map((a) => agentLists[a.name].length));
      const days = [];
      for (let d = 0; d < maxLen; d++) days.push(cAgents.map((a) => ({ agentName: a.name, postId: agentLists[a.name][d] || null })).filter((s) => s.postId));
      preview.push({ groupKey: k, agents: cAgents.map((a) => a.name), totalPosts: cPosts.length, days: days.length, grid: days });
    }
    // Hash includes each POST's set tag and each agent's sig (which already carries the agent's set) → re-tagging a
    // post to a different set, reassigning an agent's set/groups, or adding/removing/reordering posts changes the
    // batchId. A change is DETECTED mid-round (see _reconcileCampaignPlan) but the reshuffle is DEFERRED to the next
    // round — recomputing mid-round would wipe pointers and re-post already-delivered content (#2).
    const fp = posts.map((p) => p.id + ':' + (p.postSetId || '')).join(',') + '::' + agents.map((a) => a.name + ':' + sig(a)).join(',');
    let h = 5381; for (let i = 0; i < fp.length; i++) h = ((h * 33) ^ fp.charCodeAt(i)) >>> 0; // djb2 change-detection hash
    return { batchId: String(h), planStartDate: this._localDayKey(), roundOffset, agentLists, clusters: preview };
  }

  // #2 (defer-to-next-round): reconcile the campaign plan against the latest roster/library WITHOUT re-bursting. Called
  // once per cycle from _loop. The FIRST call builds the plan; every later call FREEZES it — a mid-round edit (added
  // agent, changed groups/sets, added/removed/reordered posts) is held for the next round boundary, because recomputing
  // now would repartition slices AND wipe every agent's delivered pointer → the whole library re-posts to the shared IP
  // (a re-burst = the ban-risk axis). The one consistency step that is safe to apply immediately is a ROSTER SHRINK:
  // prune slices of agents that LEFT the campaign (operator turned them OFF, cleared their groups, or switched them off
  // campaign-plan → gone from _campaignRoster()). Their pointer can never advance (they never run), so leaving them in
  // agentLists would wedge _campaignAllFinished/_campaignRemaining forever (loop never wraps, completion never fires).
  // Pruning leaves every SURVIVING agent's slice untouched (no re-partition → no re-burst); the freed posts redistribute
  // at the next round. _owed is left intact so standby coverage of a removed agent's partial delivery still runs. A
  // benched or reserve-HELD agent stays enabled in _campaignRoster() → NOT pruned → CP1's no-premature-reloop holds.
  _reconcileCampaignPlan(fresh, planAgents, planPostsLen) {
    if (!this._campaignPlan) {
      // FIRST plan of the run — build it. No pointers exist yet, so nothing is wiped.
      this._campaignPlan = fresh;
      this._pendingPlanBatchId = null;
      this._saveRotationState();
      const totalDays = Math.max(0, ...fresh.clusters.map((c) => c.days));
      const _setsUsed = planAgents.some((a) => a.postSetId);
      this.log(`🗓️ Campaign Plan: ${planPostsLen} post(s) split across ${planAgents.length} agent(s) in ${fresh.clusters.length} group-set(s) → ~${totalDays} day(s); ${_setsUsed ? 'each batch delivers its assigned post-set' : 'each group-set receives the whole library'}.`);
      // Empty-set trap: an agent assigned to a post-set with zero matching posts would idle silently every cycle.
      const _emptySets = fresh.clusters.filter((c) => c.totalPosts === 0);
      if (_emptySets.length) this.log(`⚠️ ${_emptySets.length} batch(es) have an assigned post-set with NO posts — those accounts will post NOTHING. Tag posts to that set (Posts tab) or clear the batch's set in Quick Setup.`);
      return;
    }
    // Plan exists → FREEZE. Roster shrink: prune departed agents so a stuck pointer can't wedge completion.
    const liveNames = new Set(planAgents.map((a) => a.name));
    let prunedAgents = false;
    for (const n of Object.keys(this._campaignPlan.agentLists || {})) if (!liveNames.has(n)) { delete this._campaignPlan.agentLists[n]; prunedAgents = true; }
    if (prunedAgents) this._saveRotationState();
    // Edit notice: any other batchId change is held for the next round; tell the operator once per distinct edit.
    if (this._campaignPlan.batchId !== fresh.batchId && this._pendingPlanBatchId !== fresh.batchId) {
      this._pendingPlanBatchId = fresh.batchId;
      this.log('📝 Campaign edited while running — the change is held for the NEXT round (the current round finishes on the existing plan so already-delivered posts are not re-posted). To apply it now: Stop → edit → Start.');
    }
  }

  // The next index into an agent's campaign list (after its last-delivered post), skipping deleted posts.
  _campaignNextIdx(name) {
    const plan = this._campaignPlan; if (!plan || !plan.agentLists) return { idx: 0, len: 0 };
    const list = plan.agentLists[name] || [];
    const rec = (this._perAccountRotation || {})[name] || {};
    let idx = rec.lastPostId ? list.indexOf(rec.lastPostId) + 1 : 0;
    if (idx < 1) idx = 0;
    while (idx < list.length && !(this._data.posts || []).some((p) => p.id === list[idx])) idx++; // skip deleted
    return { idx, len: list.length };
  }

  // Every active campaign-plan agent has reached the end of its list → the whole library has been
  // delivered to every group-set (the batch is complete).
  // CP1: the STABLE campaign-plan roster — enabled, non-moderator, NON-STANDBY accounts posting campaign-plan WITH
  // groups, straight from this._data (NOT the per-cycle `active` set, which the numeric "Reserve Accounts" hold-back
  // rotates each cycle). Deriving the plan roster from `active` made the plan's batchId churn every cycle → the
  // mismatch branch wiped every agent's slice pointer → the campaign re-posted slice[0] forever = silent over-delivery
  // on the shared IP. A stable roster keeps batchId constant so the campaign advances. No-op at reserveAccounts:0
  // (active === allPosters === this roster), so the operator's live config is byte-identical.
  _campaignRoster() {
    return (((this._data && this._data.accounts) || [])).filter((a) => a && a.enabled !== false && !a.isModerator && a.standby !== true && (a.postingOrder || '') === 'campaign-plan' && (a.assignedGroups || []).length);
  }

  // CP1: roster-aware — tally over the PLAN's own roster (agentLists keys = the stable full campaign roster), NOT the
  // per-cycle `active` set. Using `active` let a campaign agent HELD IN RESERVE this cycle (its remaining slices
  // excluded) make this return true PREMATURELY → a loopCampaign reloop that re-posts the WHOLE library early (a large
  // over-delivery burst) or a premature completion stop. The plan roster counts every agent's slice.
  _campaignAllFinished() {
    const agentLists = (this._campaignPlan && this._campaignPlan.agentLists) || null;
    const names = agentLists ? Object.keys(agentLists) : [];
    if (!names.length) return false;
    // An agent assigned an EMPTY post-set has len=0, so idx>=len is trivially true. If EVERY agent is empty the
    // campaign is MISCONFIGURED, not "finished" — returning true would loop-restart it forever delivering nothing.
    if (names.every((n) => this._campaignNextIdx(n).len === 0)) return false;
    // A partial-delivery obligation (un-reached groups owe an earlier post) means the campaign is NOT finished — else
    // a loopCampaign reshuffle / completionMode stop would fire while a group still permanently misses that post. [8]
    if (names.some((n) => { const o = (this._owed || {})[n]; return o && (o.gids || []).length; })) return false;
    return names.every((n) => { const x = this._campaignNextIdx(n); return x.idx >= x.len; });
  }

  // Posts still to deliver across the campaign-plan roster (for completionMode / outstanding work). Roster-aware (CP1).
  _campaignRemaining() {
    const agentLists = (this._campaignPlan && this._campaignPlan.agentLists) || null;
    let r = 0; for (const n of (agentLists ? Object.keys(agentLists) : [])) { const x = this._campaignNextIdx(n); r += Math.max(0, x.len - x.idx); }
    return r;
  }

  // Same-day reserve takeover for Campaign Plan: pair each campaign-plan agent that DROPPED this cycle
  // (delivered nothing) with a healthy campaign-plan reserve in the SAME cluster (identical assignedGroups),
  // so the reserve delivers that agent's slice-for-today into the same groups. The reserve has no agentLists
  // of its own, so its pick is routed through this map by _postsForAccount; the post-bookkeeping then advances
  // the DROPPED agent's pointer (not the reserve's). Returns { [reserveName]: { postId, forAgent } }. One
  // reserve covers one agent/cycle; bounded by `limit` (the cycle's takeover cap). `isHealthy` gates the
  // reserve (logged-in, off cooldown, daily headroom).
  _campaignStandins(active, reserve, isHealthy, limit = 3) {
    const out = {};
    const plan = this._campaignPlan;
    if (!plan || !plan.agentLists || !this._cycleDrops || !this._cycleDrops.size) return out;
    const dropped = (active || []).filter((a) => (a.postingOrder || '') === 'campaign-plan' && this._cycleDrops.has(a.name));
    const used = new Set();
    let n = 0;
    for (const A of dropped) {
      if (n >= limit) break;
      // OWED-FIRST: A owes an EARLIER partial post → the owed-standins path (fed from _cycleOwed, synthesized from the
      // persistent ledger) finishes THAT post to only its un-reached groups. Do NOT advance A to its next slice here
      // (that would strand the owed groups and, on reconcile, silently drop them). One coverage path, no over-delivery.
      if (this._owed && this._owed[A.name] && this._owed[A.name].postId && ((this._owed[A.name].gids) || []).length) continue;
      if (((this._perAccountRotation || {})[A.name] || {}).lastPostedDate === this._localDayKey()) continue; // A already posted today → slice covered; don't double-post
      const idx = this._campaignNextIdx(A.name);
      if (idx.idx >= idx.len) continue; // A's slice is already complete — nothing to cover
      const postId = (plan.agentLists[A.name] || [])[idx.idx];
      if (!postId || !(this._data.posts || []).some((p) => p.id === postId)) continue; // post gone from library
      // A reserve that is a MEMBER of every group A targets (its assignedGroups ⊇ A's) can stand in — exact
      // set-equality was too strict (a catch-all Standby with extra groups was wrongly rejected). A's groups are
      // fully covered; any extra groups on the reserve also receive the post (acceptable). Standby of ANY order OK.
      const covers = (r) => { const rg = r.assignedGroups || []; return (A.assignedGroups || []).length > 0 && (A.assignedGroups || []).every((g) => rg.includes(g)); };
      const R = this._bestReserve((reserve || []).filter((r) => !used.has(r.name) && !r.isModerator && covers(r) && isHealthy(r)), (A.assignedGroups || []).length);
      if (R) { used.add(R.name); out[R.name] = { postId, forAgent: A.name }; n++; }
      else { // #1 no single superset reserve → SPLIT A's groups across multiple in-group reserves (each delivers A's slice to ONLY its subset)
        for (const s of this._splitCover([...this._groupIdsOf(A)], reserve, used, isHealthy)) {
          if (n >= limit) break;
          out[s.reserve.name] = { postId, forAgent: A.name, gids: s.gids }; n++;
        }
      }
    }
    return out;
  }

  // RESERVE RANKING (#2 smarter selection): among equally-eligible covering reserves, pick the BEST instead of the
  // first-found. Order: (1) least OVER-EXPOSURE — fewest groups beyond what the cover needs (a superset reserve posts
  // the slice to ALL its groups, so extras get the post too; `exposureBaseline` = the count of groups the cover should
  // reach, or 0/null for a gids-restricted cover that can't over-expose); (2) fewest recent rate-limit STRIKES (safer);
  // (3) WARMEST (more prior runs = more established). Deterministic tiebreak by name. Returns the best reserve or null.
  _bestReserve(candidates, exposureBaseline) {
    if (!candidates || !candidates.length) return null;
    const base = Number(exposureBaseline) || 0;
    const scored = candidates.map((r) => ({
      r,
      extra: base ? Math.max(0, (r.assignedGroups || []).length - base) : 0,
      strikes: Number(r.rlStrikes) || 0,
      runs: (() => { try { return store.loadRunCount(r.name); } catch { return 0; } })(),
    }));
    scored.sort((a, b) => (a.extra - b.extra) || (a.strikes - b.strikes) || (b.runs - a.runs) || (a.r.name < b.r.name ? -1 : 1));
    return scored[0].r;
  }

  // Resolve an account's assigned groups to their canonical ids (groupId||id) — the form used by onlyGroups / the
  // per-(post,group) ledger / the worker's gid. (assignedGroups may hold either g.id or g.groupId.)
  _groupIdsOf(acc) {
    return new Set((this._data.groups || []).filter((g) => (acc.assignedGroups || []).includes(g.id) || (acc.assignedGroups || []).includes(g.groupId)).map((g) => g.groupId || g.id));
  }

  // #1 SPLIT COVERAGE: when NO single reserve is a full superset of the groups that need covering, assign a SET of
  // reserves whose union covers them — each routed (via gids/onlyGroups) to only its subset. Greedy set-cover: each
  // step takes the reserve covering the MOST still-needed groups (ties broken by _bestReserve: fewest strikes / warmest),
  // routes it to that subset, removes those groups, repeats. Returns [{reserve, gids:[...]}] (partial if some group has
  // no member reserve — the caller reports the shortfall). `used` is mutated so a reserve isn't double-assigned.
  _splitCover(neededGids, reserves, used, isHealthy) {
    const out = [];
    const need = new Set(neededGids);
    while (need.size) {
      const cand = (reserves || [])
        .filter((r) => !used.has(r.name) && !r.isModerator && isHealthy(r))
        .map((r) => { const rg = this._groupIdsOf(r); return { r, cover: [...need].filter((G) => rg.has(G)) }; })
        .filter((x) => x.cover.length);
      if (!cand.length) break; // remaining groups have no eligible member reserve
      const maxCover = Math.max(...cand.map((x) => x.cover.length));
      const top = cand.filter((x) => x.cover.length === maxCover);
      const best = this._bestReserve(top.map((x) => x.r), 0) || top[0].r; // gids-restricted → no over-exposure term
      const chosen = top.find((x) => x.r.name === best.name) || top[0];
      out.push({ reserve: chosen.r, gids: chosen.cover.slice() });
      used.add(chosen.r.name);
      chosen.cover.forEach((G) => need.delete(G));
    }
    return out;
  }

  // IMMEDIATE-TAKEOVER pairing: pick a healthy reserve to stand in for a SINGLE dropped campaign-plan agent A the
  // INSTANT it fails (vs the end-of-pool _campaignStandins batch). The reserve must be a MEMBER of every group A
  // targets, fresh-logged-in + past any rate-limit cool-down + within daily headroom (all via the caller's isHealthy),
  // not a moderator, and not already jobbed this cycle. Returns { reserve, postId } or null (→ caller leaves it for
  // the end-of-pool backstop). Pure given A + this._campaignPlan / _campaignNextIdx / _perAccountRotation / _data / _reserve.
  _immediateStandin(A, isHealthy) {
    if (!A || (A.postingOrder || '') !== 'campaign-plan') return null;
    if (this._immediateCovered && this._immediateCovered.has(A.name)) return null;
    // OWED-FIRST ([7][8] × drop/rest × stand-in): if A carries an UNFINISHED partial-delivery owed post, do NOT advance
    // it to the next slice — the end-of-pool owed-standins path finishes that owed post to ONLY its un-reached groups.
    // Advancing here would strand the owed groups AND (once the new post's obligation reconciles) silently drop them.
    if (this._owed && this._owed[A.name] && this._owed[A.name].postId && ((this._owed[A.name].gids) || []).length) return null;
    const plan = this._campaignPlan;
    if (!plan || !plan.agentLists) return null;
    if (((this._perAccountRotation || {})[A.name] || {}).lastPostedDate === this._localDayKey()) return null; // A already delivered today
    const idx = this._campaignNextIdx(A.name);
    if (idx.idx >= idx.len) return null; // A's slice already complete
    const postId = (plan.agentLists[A.name] || [])[idx.idx];
    if (!postId || !((this._data && this._data.posts) || []).some((p) => p.id === postId)) return null; // post gone from library
    const covers = (r) => { const rg = r.assignedGroups || []; return (A.assignedGroups || []).length > 0 && (A.assignedGroups || []).every((g) => rg.includes(g)); };
    const R = this._bestReserve((this._reserve || []).filter((r) => !r.isModerator && !this._jobbedOut(r.name) && covers(r) && isHealthy(r)), (A.assignedGroups || []).length);
    return R ? { reserve: R, postId } : null;
  }

  // PARTIAL-DELIVERY pairing: for each OWED agent (delivered its post to some-but-not-all of its groups this cycle),
  // find a healthy reserve that is a member of ALL its owed groups and assign it to cover ONLY those groups (gids).
  // `cycleOwed` = { ownerName: { postId, gids[] } }; `exclude` = reserve names already taken (full-drop stand-ins).
  // Returns { assigned: { reserveName: { postId, forAgent, gids } }, deferred: [{ owner, count }] }. Pure given inputs.
  _owedStandins(cycleOwed, reserve, isHealthy, exclude = new Set()) {
    const assigned = {}, deferred = [];
    const used = new Set(exclude);
    const resolveGids = (acc) => new Set((this._data.groups || []).filter((g) => (acc.assignedGroups || []).includes(g.id) || (acc.assignedGroups || []).includes(g.groupId)).map((g) => g.groupId || g.id));
    for (const [owner, owed] of Object.entries(cycleOwed || {})) {
      if (!owed || !(owed.gids || []).length) continue;
      const R = this._bestReserve((reserve || []).filter((r) => !used.has(r.name) && !r.isModerator && isHealthy(r) && (() => { const rg = resolveGids(r); return owed.gids.every((G) => rg.has(G)); })()), 0);
      if (R) { used.add(R.name); assigned[R.name] = { postId: owed.postId, forAgent: owner, gids: owed.gids.slice() }; }
      else { // #1 no single reserve covers ALL owed groups → SPLIT them across multiple reserves
        const split = this._splitCover(owed.gids, reserve, used, isHealthy);
        for (const s of split) assigned[s.reserve.name] = { postId: owed.postId, forAgent: owner, gids: s.gids };
        const coveredCount = split.reduce((a, s) => a + s.gids.length, 0);
        if (coveredCount < owed.gids.length) deferred.push({ owner, count: owed.gids.length - coveredCount }); // groups with no member reserve
      }
    }
    return { assigned, deferred };
  }

  // PERSISTENT OWED-LEDGER reconciliation — run ONCE at the end of each pool, AFTER all delivery this cycle (the
  // primary pass AND any reserve takeover). For every daily-rotation / campaign-plan agent that TRIED to deliver a
  // post this cycle (recorded in _cycleObligation with the groups it was responsible for), recompute its still-
  // un-reached groups from the FINAL delivered set (_cycleDelivered). Any remainder is written to the persistent
  // this._owed ledger so the SAME post is re-delivered to ONLY those groups next cycle/day (the owed pick-override);
  // a fully-covered obligation CLEARS the entry so no delivered group is ever re-posted. Persists on any change.
  // Invariants: (a) a group in _cycleDelivered is never owed (no double-post); (b) a responsible-but-un-reached
  // group is always carried (no silent skip). [7][8]
  // Delivery-ledger key SCOPE for the responsible agent. daily-rotation is PER-AGENT: two accounts each independently
  // walk the SAME post library and can share an assigned group, so both legitimately post the SAME post P to a SHARED
  // group G — its dedup/owed key MUST be scoped by the responsible agent, else A's delivery of P::G makes B skip G
  // forever (a permanent silent under-delivery). Every other dedup mode (unique/sequence/campaign) is FLEET-WIDE (a
  // post reaches each group ONCE across the whole fleet), so no agent scope. markDelivered/alreadyDelivered AND every
  // owed-reconciliation filter route through this so they AGREE — a mismatch would re-owe a delivered group
  // (double-post) or drop an un-reached one. A reserve stand-in passes the COVERED agent's name (it delivers on that
  // agent's behalf), so its deliveries land under the same scope the covered daily-rotation agent's reconcile reads. [7][8]
  _dkScope(agentName) {
    try { const a = ((this._data && this._data.accounts) || []).find((x) => x.name === agentName); return (a && a.postingOrder === 'daily-rotation') ? (agentName + '::') : ''; }
    catch { return ''; }
  }

  // Is this agent a unique/sequence agent (fleet-wide dealt-set, NEVER re-delivers a (post,group))? Resolved from the
  // FULL account list, not this._active — a stand-in can cover an agent disabled between cycles, and its owed ledger
  // must still reconcile under the same rules. [9]
  // [LEDGER COHERENCE] Can this owner's CURRENT postingOrder actually DISCHARGE a persistent _owed entry — i.e. does a
  // pick-override exist that re-picks the owed post scoped to only its un-reached groups? Only the per-agent-pointer
  // modes have one (daily-rotation ~703, campaign-plan ~733).
  //
  // WHY THIS EXISTS. The ledger's CONSUMERS (_hasPersistentOwed, the persistent-owed synthesis, _owedStandins,
  // _owedSelf) were MODE-AGNOSTIC while the PRODUCER of the discharge record (the _cycleObligation gate) was
  // mode-restricted. An entry whose owner cannot discharge it therefore became IMMORTAL: no override ran to prune it, no
  // obligation was recorded, _reconcileOwedFor early-returned on !ob, and the synthesis re-dispatched the IDENTICAL gids
  // to a reserve EVERY cycle — and a stand-in has _uniqueSeqGuard=false (~870), so only the per-cycle _cycleDelivered
  // guarded it. Net: a recurring per-(post,group) double-post on the ONE shared IP. Reachable WITHOUT [9] (a pointer
  // agent whose mode the operator flips to post-centric/unique keeps its entry; the !unique branch ~747 returns before
  // any cleanup), so this predates [9] and survived the confirm-dry sweep — no lens modelled a mid-run MODE SWITCH
  // across cycles in ONE process, and the crash-fold masks it on restart (health accumulates; crashes self-heal).
  //
  // INVARIANT: an _owed entry may only be CONSUMED by an owner that can discharge it. An entry that fails this test is
  // dropped-and-logged at the synthesis (self-healing) rather than dispatched. Never widen this to a mode with no
  // pick-override — that re-opens the double-post.
  _owedDischargeable(agentName) {
    const a = ((this._data && this._data.accounts) || []).find((x) => x && x.name === agentName);
    return owedDischargeableMode(a && a.postingOrder);
  }

  // [LEDGER COHERENCE] Sweep _owed entries that are DEAD — the owner can neither DISCHARGE (no pick-override → no
  // obligation → _reconcileOwedFor early-returns) nor SCOPE (never re-picks the post, so _owedSelf can't use it) them.
  // In practice: a BROADCAST owner (post-centric/random), or an account deleted from the library.
  //
  // WHY UNCONDITIONALLY, AT THE CYCLE TOP: the drop-and-log used to live inside the reserve-takeover block, whose entry
  // condition (_hasPersistentOwed) requires _owedDischargeable === TRUE — the exact NEGATION of the drop-and-log's own
  // trigger. The heal could never reach its own patients: it fired only by coincidence, when some UNRELATED condition
  // opened the block (another agent's drop/owed) AND a reserve existed AND _uniqueMode was true. On the healthy
  // days-unattended path an entry could outlive the mode change indefinitely, and every saveRotation re-persisted it.
  //
  // WHY NOT !_owedDischargeable (THE SUBTLE PART — do not "simplify" this): once an operator flips a pointer agent to
  // unique/sequence, its entry is NOT dead. The agent can still re-pick that post off `remaining` (2491 keeps
  // pointer-mode posts OUT of _dealt), and _owedSelf/owedScopableMode then scopes that ONE re-pick to the un-reached
  // groups — which is the ONLY thing stopping a full-assigned-set re-post of the already-delivered ones. Pruning on
  // !_owedDischargeable would delete exactly that entry and re-open the double-post. So prune only when the owner can do
  // NEITHER. After that scoped re-pick the post is dealt and the entry is inert; it is then reaped by the next sweep
  // once the owner is broadcast/absent, or harmlessly ignored (no consumer can reach it, and no tally counts it).
  _pruneUndischargeableOwed() {
    let changed = false;
    for (const [name, ow] of Object.entries(this._owed || {})) {
      if (!ow || !ow.postId) continue;
      const a = ((this._data && this._data.accounts) || []).find((x) => x && x.name === name);
      const ord = a && a.postingOrder;
      if (owedDischargeableMode(ord) || owedScopableMode(ord)) continue; // still usable for a discharge OR a scoped re-pick
      this.log(`⚠️ [${name}] carried ${((ow.gids) || []).length} un-reached group(s) for a post, but its posting method can no longer finish them — dropping the obligation (those groups stay undelivered; re-post them manually if they matter).`);
      try { delete this._owed[name]; changed = true; } catch {}
    }
    if (changed) { try { this._saveRotationState(); } catch {} }
    return changed;
  }

  _isUniqueSeqAgent(agentName) {
    try { const a = ((this._data && this._data.accounts) || []).find((x) => x.name === agentName); const o = (a && a.postingOrder) || ''; return o.includes('unique') || o === 'sequence'; }
    catch { return false; }
  }

  // THE owed-ledger delivered-predicate: has (postId → gid) been delivered on `agent`'s behalf? Every owed filter routes
  // through this so the ledger AGREES with the worker's alreadyDelivered (ADR-0008's load-bearing invariant) — a
  // mismatch either re-owes a delivered group (→ a reserve stand-in re-posts it = double-post) or drops an un-reached
  // one (silent skip).
  // For unique/sequence it must ALSO honor _inflightDelivered, the crash-fold's durable per-(post,group) guard: those
  // groups were genuinely delivered before a crash, the worker skips them, and a reserve stand-in — which does NOT
  // consult the guard — would re-post them if they stayed in the ledger. Rotation/campaign legitimately RE-deliver, so
  // the guard is never consulted for them (it would suppress a real delivery).
  // SIDE EFFECT (deliberate): a guard hit is promoted into _cycleDelivered. _inflightDelivered is PURGED the moment its
  // post is no longer owed (_persistDealt), while _cycleDelivered only ever grows within a cycle — so promoting makes
  // _reconcileOwedFor IDEMPOTENT across that purge. Without it the end-of-pool sweep would recompute a just-cleared
  // obligation against a purged guard and RESURRECT already-delivered groups into the ledger. [9]
  _owedDelivered(agent, postId, gid) {
    try {
      const k = this._dkScope(agent) + postId + '::' + gid;
      this._cycleDelivered = this._cycleDelivered || new Set(); // _loop seeds this per cycle; never let an unset ledger throw into the catch below — "not delivered" is the DOUBLE-POST direction
      if (this._cycleDelivered.has(k)) return true;
      if (this._isUniqueSeqAgent(agent) && this._inflightDelivered && this._inflightDelivered.has(postId + '::' + gid)) { this._cycleDelivered.add(k); return true; }
      return false;
    } catch { return false; }
  }

  // Reconcile ONE agent's persistent owed entry from its obligation this cycle (expectedGids) minus what has ACTUALLY
  // been delivered so far this cycle (_cycleDelivered). In-memory only — the caller persists. Returns true if it
  // changed. CRASH-SAFETY: called INLINE right before each per-account rotation save (the one that advances the
  // pointer), so this._owed is always written in lock-step with the pointer it depends on — a hard kill can never
  // leave the pointer advanced past a post while the ledger still lists an already-delivered group (double-post) or
  // omits an un-reached one (silent skip). No obligation for this agent → its owed is left untouched (a full drop
  // that delivered nothing keeps any prior owed). [7][8]
  _reconcileOwedFor(agent) {
    if (!agent) return false;
    this._owed = this._owed || {};
    const ob = (this._cycleObligation || {})[agent];
    if (!ob || !ob.postId) return false;
    const still = (ob.expectedGids || []).filter((gid) => !this._owedDelivered(agent, ob.postId, gid)); // _owedDelivered (not a raw _cycleDelivered probe): for unique/sequence it also subtracts the crash-fold's durable delivered-guard, so a crash-proven delivery is never re-owed → never re-posted by a reserve stand-in [9]
    const prev = this._owed[agent];
    if (still.length) {
      if (!prev || prev.postId !== ob.postId || (prev.gids || []).join(',') !== still.join(',')) { this._owed[agent] = { postId: ob.postId, gids: still }; return true; }
      return false;
    }
    // CLEAR only the owed entry this obligation actually discharged. Without the postId guard, an obligation
    // reconciled for post Q (e.g. a stand-in that advanced a rested agent to its NEXT slice) would silently DELETE a
    // standing owed entry for a DIFFERENT earlier post P → those P groups are never delivered by anyone (invariant #2).
    if (prev && prev.postId === ob.postId) { delete this._owed[agent]; return true; }
    return false;
  }

  // End-of-pool sweep: reconcile EVERY obligated agent (belt-and-suspenders after the inline per-account reconciles —
  // covers an agent whose own save was skipped, e.g. a stand-in that itself delivered nothing) and persist once.
  _reconcileOwedLedger() {
    let changed = false;
    for (const agent of Object.keys(this._cycleObligation || {})) { if (this._reconcileOwedFor(agent)) changed = true; }
    if (changed && !this._saveRotationState()) this.log('⚠️ Could not persist the owed-groups ledger (disk full/locked?) — a partial delivery may not carry across a restart. Free disk / fix data-folder permissions.');
    return changed;
  }
}

// #1 (stall breaker): after the loop throws, decide whether to AUTO-RESTART it IN-PROCESS or give up (breaker). Re-entering
// _loop reloads durable state from disk + re-folds the crash journal, so a restart loses NO progress — it is what a relaunch
// does, minus the human. A crash after a long HEALTHY run (ranMs ≥ healthyMs) is a transient fault → reset the streak so
// isolated faults days apart never accumulate; only RAPID consecutive crashes count toward maxRestarts, which stops a
// DETERMINISTIC crash-loop from hammering the shared IP. Pure → unit-tested. Returns { restart, restarts, backoffMs }.
function crashRestartDecision(restarts, ranMs, opts = {}) {
  const { maxRestarts = 3, healthyMs = 600000, baseBackoffMs = 30000, maxBackoffMs = 300000 } = opts;
  let r = (Number(ranMs) || 0) >= healthyMs ? 0 : (Number(restarts) || 0);
  if (r >= maxRestarts) return { restart: false, restarts: r, backoffMs: 0 };
  r += 1;
  return { restart: true, restarts: r, backoffMs: Math.min(maxBackoffMs, baseBackoffMs * r) };
}

// [LEDGER COHERENCE — THE ONE SOURCE OF TRUTH] Can a posting mode DISCHARGE a persistent this._owed entry — i.e. does
// it have an owed pick-override that re-picks the owed post scoped to only its un-reached groups? Only the per-agent-
// pointer modes do (daily-rotation ~703, campaign-plan ~733).
//
// BOTH SIDES OF THE LEDGER GATE ON THIS, DELIBERATELY:
//   • PRODUCER — the _cycleObligation gate on the return path: never CREATE an entry a mode cannot discharge.
//   • CONSUMERS — _owedDischargeable() wraps this for _hasPersistentOwed / the synthesis / _owedSelf: never CONSUME one.
// They disagreed before: consumers were mode-agnostic while the producer was mode-restricted, so an entry whose owner
// could not discharge it became IMMORTAL (no override pruned it, no obligation was recorded, _reconcileOwedFor
// early-returned on !ob) and the synthesis re-dispatched the IDENTICAL gids to a reserve EVERY cycle — and a stand-in
// has _uniqueSeqGuard=false, so only the per-cycle _cycleDelivered guarded it = a recurring per-(post,group)
// double-post on the ONE shared IP. That mismatch produced five distinct double-posts and predates [9].
// Widening this to a mode with no pick-override re-opens all of them. Pure → unit-tested + mutation-verified.
function owedDischargeableMode(postingOrder) {
  const o = String(postingOrder || '');
  return o === 'daily-rotation' || o === 'campaign-plan';
}

// [LEDGER COHERENCE — THE SCOPING PREDICATE. NOT the same question as owedDischargeableMode. Do not merge them.]
// May a run that HAPPENS to pick the owed post be NARROWED to only its still-owed groups (via _owedSelf → onlyGroups)?
//
// THE ASYMMETRY THAT MAKES THIS A SEPARATE PREDICATE — read before touching either:
//   • The DISPATCHING consumers (_hasPersistentOwed / the persistent-owed synthesis / _owedStandins) turn a ledger entry
//     into a NEW delivery. Gating them PREVENTS a re-post → they gate on owedDischargeableMode (dispatch only for a mode
//     that can actually discharge, else the entry is immortal and a reserve re-posts it every cycle).
//   • _owedSelf does the OPPOSITE: it REMOVES groups from a run's target set. It is a GUARD, not an action. Narrowing a
//     target set can NEVER cause a double-post — only its ABSENCE can. So gating it on the DISPATCH predicate deleted the
//     one guard protecting already-delivered groups: a daily-rotation agent with _owed{P,[g1,g2]} that the operator flips
//     to unique re-picks P off `remaining` (2491 keeps pointer-mode posts OUT of _dealt, so P is still re-pickable),
//     _owedSelf went null, onlyGroups went null, and the run re-posted the already-delivered g3,g4. _uniqueSeqGuard is
//     true post-flip but consults _inflightDelivered, which ONLY the crash-fold seeds → empty in a healthy run. (v1.0.113)
//
// So: scope for the whole DEDUP family (one post per run, where narrowing is always correct), and exclude only the
// BROADCAST modes (post-centric/random), where a stale entry that merely matched one of the normally-picked posts would
// silently starve the account's other groups. Widening this to broadcast causes starvation; NARROWING it causes a
// double-post — err toward including a mode, not excluding it. Pure → unit-tested + mutation-verified.
function owedScopableMode(postingOrder) {
  const o = String(postingOrder || '');
  return o === 'campaign-plan' || o === 'daily-rotation' || o.includes('unique') || o === 'sequence';
}

// [9/UNIQUE-COVER FIX] Should a reserve stand-in's cover record a _cycleObligation for the agent it COVERED? The
// obligation is what lets _reconcileOwedFor clear (full cover) or carry (partial) this._owed[forAgent]. Without it the
// ledger NEVER moves, and the mode-agnostic persistent-owed synthesis re-dispatches the IDENTICAL gids every cycle → a
// reserve re-posts the SAME (post,group) forever on the shared IP (a stand-in's _uniqueSeqGuard is false, so only the
// per-cycle _cycleDelivered guarded it). Admit:
//   • daily-rotation / campaign-plan — always (the pointer modes; expectedGids falls back to the full assigned set).
//   • unique / sequence — ONLY with a prior-owed baseline (hasBaseline). expectedGids MUST be the owed SUBSET: the
//     full-assigned-set fallback would re-owe the original partial's already-delivered groups (→ re-post), and for an
//     absent/disabled forAgent that fallback is EMPTY → expectedGids=[] → still=[] → delete _owed = a silent STRAND.
//     No baseline → record nothing → the pre-[9] behavior (a strand: recoverable) instead of a double-post (a ban).
// Pure → unit-tested. Every live unique cover comes from _owedStandins seeded off _cycleOwed/_owed, so a baseline is
// always present on the real path; the conjunct is a free fail-safe, not a functional restriction.
function standinObligationAdmits(faOrd, hasBaseline) {
  const o = String(faOrd || '');
  if (o === 'daily-rotation' || o === 'campaign-plan') return true;
  if ((o.includes('unique') || o === 'sequence') && hasBaseline) return true;
  return false;
}

module.exports = { Orchestrator, crashRestartDecision, standinObligationAdmits, owedDischargeableMode, owedScopableMode };
