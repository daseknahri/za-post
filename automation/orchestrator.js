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

const path = require('path');
const store = require('../lib/store');
const { runAccount } = require('./worker');
const { ProxyHealthManager } = require('../lib/proxy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jitter a delay by ±pct so batch/cycle gaps are never metronomic (a fixed cadence is a bot signal).
const jitter = (ms, pct = 0.25) => Math.round(Math.max(0, Number(ms) || 0) * (1 - pct + Math.random() * pct * 2));
// A random integer in [min,max] — the primitive for unpredictable, never-constant cadence.
const rand = (min, max) => { let lo = Math.max(0, Math.floor(Number(min) || 0)), hi = Math.max(0, Math.floor(Number(max) || 0)); if (hi < lo) { const t = lo; lo = hi; hi = t; } return lo + Math.floor(Math.random() * (hi - lo + 1)); };
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
  const urls = ['https://connectivitycheck.gstatic.com/generate_204', 'https://www.facebook.com'];
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
    this.running = false;
    this._stop = false;
    this._paused = false;
    this._finish = false;
    this._aborters = new Set();
    this._progress = { running: false, paused: false, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0 };
  }
  isRunning() { return this.running; }
  // F4: operator "start fresh" — clear the dealt-state + rotation so the next Start re-deals every post
  // from #1. Guarded to the STOPPED state (so it can't race a live cycle) and routes through the same
  // checked saveRotation; if the write fails we report it and the next Start re-reads disk (no silent
  // re-post across restart). Does NOT delete posts.
  resetRotation() {
    if (this.isRunning()) return { ok: false, error: 'Stop the automation before resetting the rotation.' };
    this._dealt = new Set();
    this._roundOffset = 0;
    const wrote = store.saveRotation({ dealt: [], roundOffset: 0, staggerRotation: this._staggerRotation || 0 });
    if (!wrote) return { ok: false, error: 'Could not write rotation state (disk full / permissions).' };
    this.log('🔄 Campaign rotation reset — the next Start re-deals all posts from #1.');
    return { ok: true };
  }
  stop() {
    this._stop = true;
    this._paused = false;
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
  }
  isPaused() { return this._paused; }
  async _waitWhilePaused() { while (this._paused && !this._stop) await sleep(500); }

  async _waitForConnectivity() {
    let offlineLogged = false;
    while (!this._shouldStop()) {
      if (await isOnline(() => this._shouldStop())) {
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

  log(msg) { this.emit('automation-log', msg); }

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

  async start(getData) {
    if (this.running) return { success: false, error: 'Automation already running' };
    this._stop = false; this._paused = false; this._finish = false; this.running = true;
    this._modLoop = false; // reset so a quick Stop→Start re-arms the concurrent moderator loop (a still-draining prior loop must not block the new one)
    this._approving = false; // never start a run with a stuck approval guard
    this._aborters.clear();
    this._progress = { running: true, paused: false, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0, offline: false };
    this._runStartedAt = Date.now();
    this._runStats = {}; // per-account totals across the whole run (for the end-of-run summary)
    this._runFlags = {}; // accountName -> flag set THIS run (rate_limited/checkpoint/etc.)
    this._claimed = new Set(); // post ids claimed by an account this cycle (reset each cycle)
    this._lastReserveKey = null; // force this run's first cycle to log its reserve set + uncovered-group warning
    this.emit('automation-started');
    this.emit('automation-progress', { ...this._progress });
    this.log(`▶️ Automation started — ${new Date().toLocaleString()}`);
    this._loop(getData).catch((e) => this.log(`❌ Orchestrator crashed: ${e.message}`))
      .finally(() => {
        this.running = false;
        this._aborters.clear();
        this._progress.running = false;
        this._progress.paused = false;
        this.emit('automation-progress', { ...this._progress });
        const reason = this._stop ? 'stopped' : (this._finish ? 'finished' : 'completed');
        this._emitSummary(reason);
        this.emit('automation-stopped', reason);
        this.log(`⏹ Automation ${reason}.`);
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
    const summary = {
      reason,
      posted: this._progress.posted || 0,
      pending: this._progress.pending || 0,
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

  // Choose the posts a given account publishes this cycle. `claim`=true (at run time) reserves
  // the post for this account so a parallel account can't grab the same one; failed claims are
  // released so another account picks them up (see _runAccount).
  _postsForAccount(account, cycle, claim = false, claimedSet = this._claimed) {
    const data = this._data;
    const filtered = data.posts.filter((p) => matchesFilter(p, account.postFilter || 'all'));
    if (!filtered.length) return [];
    // An account with NO assigned groups can't post anywhere — never assign it a post. Otherwise, in
    // unique mode, it would "claim" a post it can't deliver and the campaign-complete probe could never
    // reach zero, looping the run forever with zero progress.
    if (!(account.assignedGroups && account.assignedGroups.length)) return [];
    const order = account.postingOrder || 'post-centric';
    const unique = order.includes('unique') || order === 'sequence';

    // DAILY ROTATION (per-agent): this account posts ONE post per LOCAL DAY to its groups, advancing its
    // OWN pointer one step each day (independent of other agents and of the shared dealt-set). Anti-repeat:
    // the next pick is never the same post id it used yesterday. If the operator edits/reorders the library
    // the agent simply continues from its last post (or restarts if that post is gone). The pointer +
    // last-posted-date live in this._perAccountRotation (persisted), keyed by account name — so swapping an
    // account in/out never disturbs the others. Returns [] once the agent has already posted today (1/day).
    if (order === 'daily-rotation') {
      const list = filtered; // stable library order = the rotation order
      const rec = (this._perAccountRotation && this._perAccountRotation[account.name]) || {};
      if (rec.lastPostedDate === this._localDayKey()) return []; // already posted today → one per day
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
      const plan = this._campaignPlan;
      const listIds = (plan && plan.agentLists && plan.agentLists[account.name]) || [];
      if (!listIds.length) return [];
      if (((this._perAccountRotation || {})[account.name] || {}).lastPostedDate === this._localDayKey()) return []; // 1/day
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
    // `remaining` = posts not yet dealt AND not already claimed by another account this cycle.
    let remaining = filtered.filter((p) => !this._dealt.has(p.id) && !(claimedSet && claimedSet.has(p.id)));
    if (!remaining.length) return [];
    if (order.includes('random')) remaining = seededShuffle(remaining, (cycle + 1) * 7919); // randomized deal order (consistent within the cycle)
    const activeList = this._active || data.accounts.filter((a) => a.enabled !== false && !a.isModerator);
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
    if (!posts.length) { this.log(`↪️ [${account.name}] no eligible posts`); return { progressed: false, posted: 0, pendingApproval: 0, errors: 0, postedIds: [], dealtIds: [] }; }
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
    this.log(`[${account.name}] 🚀 Starting...`);
    let progressed = false, posted = 0, pendingApproval = 0, errors = 0, accountFlag = null, accountOffline = false;
    let accountCrashes = 0; // M3-09: consecutive posts that crashed out for this account
    const postedIds = []; // posts confirmed PUBLISHED — safe to auto-delete
    const dealtIds = [];  // posts dealt this cycle (published OR pending) — don't re-deal
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
            account, maxThisRun, post, groups: data.groups, settings: data.settings,
            useProxies: !!data.useProxies, proxies: data.proxies || [],
            log: (m) => this.log(m),
            shouldStop: () => this._shouldStop(),
            isLoginOpen: this.isLoginOpen,
            registerAborter: (abort) => this._registerAborter(abort),
            isOnline: () => isOnline(), // lets the worker bail fast when offline instead of burning nav timeouts
            reportProxy: (p, ok, reason) => this.reportProxy(p, ok, reason), // E-X3: per-proxy health from the worker
            waitIfPaused: () => this._waitWhilePaused(), // Pause holds between groups, mid-account
            isPaused: () => this._paused,                // so the worker can suspend its watchdog while paused
            isDisabled: () => { try { const a = store.load().accounts.find((x) => x.name === account.name); return !!(a && a.enabled === false); } catch { return false; } }, // user turned this account OFF mid-run (read DISK fresh — this._data is frozen per cycle) → end its waits early

            // Per-(account,group,post) outcome → append to the persistent audit trail.
            onResult: (rec) => { try { if (!store.appendReport(rec) && !this._auditWarned) { this._auditWarned = true; this.log('⚠️ Could not write an audit-log row (disk full / permissions?) — the run continues but run-report.jsonl/.csv may be incomplete. Fix disk/permissions to restore the audit trail.'); } } catch {} },
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
          // MOD: persist held posts (deduped) so the moderator phase can approve them. Gated on the
          // opt-in flag — when off, this is a no-op and behavior is identical to before.
          if (data.settings.moderationEnabled && r && r.heldRecords && r.heldRecords.length) {
            try {
              const ms = store.loadModeration();
              for (const h of r.heldRecords) {
                if (!ms.held.some((x) => x.postId === h.postId && x.gid === h.gid && x.status === 'held')) {
                  ms.held.push({ ...h, status: 'held', permalink: null, heldAt: Date.now(), approvedAt: null, commentedAt: null });
                }
              }
              if (store.saveModeration(ms)) {
                this.log(`📥 [${account.name}] ${r.heldRecords.length} post(s) held in "Spam potentiel" — queued for moderator approval (then the comment is added once they're public)`);
                // EVENT TRIGGER: don't wait for the periodic loop — kick an approval pass NOW (guarded).
                this._kickApproval(data);
              } else {
                // saveModeration returned false → the post is already counted dealt but its held record is
                // NOT on disk; warn LOUDLY so it isn't silently lost (don't pretend it's queued).
                this.log(`🛑 [${account.name}] could NOT persist ${r.heldRecords.length} held-post record(s) (disk full/locked?) — they risk staying held in "Spam potentiel" uncommented. Check disk/permissions.`);
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
              const cs = store.loadComments();
              let added = 0;
              for (const c of r.commentQueue) {
                if (!cs.pending.some((x) => x.gid === c.gid && (x.postId && c.postId ? x.postId === c.postId : x.captionSnip === c.captionSnip) && x.status !== 'done')) {
                  cs.pending.push({ ...c, status: 'pending', queuedAt: Date.now(), attempts: 0, commentedAt: null }); added++;
                }
              }
              if (added && store.saveComments(cs)) this.log(`📌 [${account.name}] ${added} post(s) live but uncommented — queued for comment-rescue by a healthy account`);
              else if (added) this.log(`🛑 [${account.name}] could NOT persist ${added} orphaned-comment record(s) (disk full/locked?) — those posts risk staying without their link. Check disk/permissions.`);
            } catch (e) { this.log(`🛑 [${account.name}] could not persist comment-rescue queue: ${e.message} — orphaned comment(s) at risk`); }
          }
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
      // Release claims for posts this account did NOT publish (blocked/failed), so a healthy
      // account can pick them up this same run. In a finally so it runs even if the body throws.
      if (this._claimed) for (const pp of posts) { if (!dealtIds.includes(pp.id)) this._claimed.delete(pp.id); }
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
      const STALE = 30 * 60 * 1000, PRUNE = 24 * 3600 * 1000;
      const before = ms0.held.length;
      for (const h of ms0.held) { if (h.status === 'held' && h.heldAt && (now0 - h.heldAt) > STALE) { h.status = 'failed'; h.note = 'not approvable within 30min (removed/auto-approved/unmatchable)'; changed0 = true; } }
      ms0.held = ms0.held.filter((h) => h.status === 'held' || ((h.approvedAt || h.heldAt || 0) > now0 - PRUNE));
      if (changed0 || ms0.held.length !== before) store.saveModeration(ms0);
    } catch {}
  }

  async _runModeratorApproval(data, shouldStop) {
    shouldStop = shouldStop || (() => false);
    const settings = data.settings || {};
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
      const r = await runModerator({ account: mod, groups: modGroups, settings, held, posterNames, log: (m) => this.log(m), shouldStop });
      // APPROVE → COMMENT HANDOFF: for every post the moderator actually APPROVED (now public), mark its
      // moderation record approved (so it's never re-approved) and move its comment payload into the
      // pending-comments queue so the existing Phase-3 rescue runner adds the link-comment via a healthy
      // in-group account. Gated on !dryRun (a "would approve" must NOT queue anything).
      if (r && r.dryRun === false && Array.isArray(r.approvedRecords) && r.approvedRecords.length) {
        try { queued += this._handoffApprovedToComments(r.approvedRecords); }
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
  _handoffApprovedToComments(approvedRecords) {
    const recs = (approvedRecords || []).filter((h) => h && h.gid);
    if (!recs.length) return 0;
    // A record with NEITHER a captionSnip NOR a postId can't be deduped (every same() check would be
    // false → repeated double-comments + a held record that never marks approved). Drop those up front.
    const safe = recs.filter((h) => (h.captionSnip && String(h.captionSnip).trim()) || h.postId);
    const same = (x, h) => x.gid === h.gid && (
      (h.captionSnip && x.captionSnip) ? x.captionSnip === h.captionSnip
      : (!!x.postId && !!h.postId) ? x.postId === h.postId
      : (!!(h.postPermalink || h.permalink) && !!(x.postPermalink || x.permalink)) ? (h.postPermalink || h.permalink) === (x.postPermalink || x.permalink)
      : false);
    try {
      const ms = store.loadModeration(); let changed = false;
      for (const h of safe) { const rec = (ms.held || []).find((x) => x.status === 'held' && same(x, h)); if (rec) { rec.status = 'approved'; rec.approvedAt = Date.now(); changed = true; } }
      if (changed) store.saveModeration(ms);
    } catch (e) { this.log(`⚠️ could not mark approved held record(s): ${e.message}`); }
    let added = 0;
    try {
      const cs = store.loadComments();
      for (const h of safe) {
        if (!(h.comment && String(h.comment).trim())) continue; // nothing to comment (caption-only post) — skip
        if (cs.pending.some((x) => x.status !== 'done' && same(x, h))) continue; // already queued (orphan or earlier approve) — no double-comment
        cs.pending.push({ gid: h.gid, postId: h.postId || null, posterAccount: h.posterAccount || null, fbDisplayName: h.fbDisplayName || null, groupName: h.groupName || null, captionSnip: h.captionSnip || null, postCaption: h.postCaption || h.captionSnip || null, comment: h.comment, commentImg: h.commentImg || null, postPermalink: h.permalink || h.postPermalink || null, status: 'pending', queuedAt: Date.now(), attempts: 0, commentedAt: null, source: 'approved' });
        added++;
      }
      if (added) store.saveComments(cs);
    } catch (e) { this.log(`⚠️ could not queue approved post comment(s): ${e.message}`); }
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
  _startModeratorLoop(getData) {
    if (this._modLoop) return;
    this._modLoop = true;
    const CHECK_MS = 75000;
    (async () => {
      await this._modSleep(8000); // brief settle, then approve early — also catches posts held on a PRIOR run before this one even produces a hold
      while (this.running && !this._stop) {
        try {
          const data = (typeof getData === 'function') ? getData() : (this._data || {});
          const on = !!(data.settings && data.settings.moderationEnabled);
          const held = on ? (store.loadModeration().held || []).filter((h) => h.status === 'held') : [];
          if (on && held.length && !this._approving && !this._paused) {
            this._approving = true;
            this.log(`🛡️ Concurrent moderator: ${held.length} held post(s) detected — approving in the background (posting continues)…`);
            try { await this._runModeratorApproval(data, () => this._stop); }
            catch (e) { this.log(`⚠️ moderator loop error: ${e.message}`); }
            finally { this._approving = false; }
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
  async _recordAccountOutcome(name, res, settings) {
    const today = store.todayKey();
    const baseHours = Number.isFinite(settings.rateLimitCooldownHours) ? settings.rateLimitCooldownHours : 4;
    let note = null;
    try {
      await store.update((d) => {
        const acc = d.accounts.find((a) => a.name === name);
        if (!acc) return;
        // Monotonic daily-cap reset (see store.dailyRolledOver): only a genuinely later UTC day
        // resets the count; a clock moved backward keeps counting, so the cap can't be cleared
        // by rewinding the clock.
        if (store.dailyRolledOver(acc.daily, today)) acc.daily = { date: today, count: 0 };
        acc.daily.count = (Number(acc.daily.count) || 0) + (res.posted || 0);
        if (res.flag === 'rate_limited') {
          acc.rlStrikes = (acc.rlStrikes || 0) + 1;
          // THREE tiers, proportionate to what Facebook actually blocked (× the exponential per-strike
          // backoff, capped 48h): an ACCOUNT-LEVEL temporary block ("the big one") rests longest; a
          // POSTING limit rests at the base; a COMMENT limit (mildest, account can still post) rests
          // shortest. The worker classifies which via res.rlKind.
          const kind = res.rlKind || 'post';
          const mult = kind === 'account' ? 3 : kind === 'comment' ? 0.5 : 1;
          const hours = Math.min(48, Math.max(0.5, baseHours * mult) * Math.pow(2, acc.rlStrikes - 1));
          acc.rateLimitedUntil = Date.now() + Math.round(hours * 3600000);
          const human = hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(hours * 60)}min`;
          note = `⏸️ ${name}: ${kind === 'account' ? 'ACCOUNT temporarily blocked by Facebook (the big one)' : kind === 'comment' ? 'COMMENT rate-limit' : 'POSTING rate-limit'} — resting it ${human} (strike ${acc.rlStrikes}); skipped until then, others keep working.`;
        } else if (((res.posted || 0) + (res.pendingApproval || 0)) > 0 && !res.flag && (acc.rateLimitedUntil || acc.rlStrikes)) {
          // Recovered (posted OR queued for approval with no flag) — clear the cool-down.
          acc.rateLimitedUntil = 0; acc.rlStrikes = 0;
        }
      });
      if (note) this.log(note);
    } catch {}
  }

  // Persist this cycle's dealt post-ids to disk, THEN mirror them into the in-memory _dealt set.
  // Returns false — and halts the run — if the write fails: a post that was published but whose
  // dealt-state couldn't be saved would be re-dealt and RE-POSTED after a crash/restart, so we
  // stop loudly rather than let duplicate-post risk compound batch after batch.
  _persistDealt(cycleDealtIds) {
    if (!cycleDealtIds || !cycleDealtIds.length) return true;
    const merged = [...new Set([...this._dealt, ...cycleDealtIds])];
    if (store.saveRotation({ dealt: merged, roundOffset: this._roundOffset || 0, staggerRotation: this._staggerRotation || 0, lastDailyRunDate: this._lastDailyRunDate || null, perAccountRotation: this._perAccountRotation || {}, campaignPlan: this._campaignPlan || null })) {
      this._dealt = new Set(merged);
      return true;
    }
    this.log('🚨 CRITICAL: could not save rotation state (disk full / file locked / no write permission). Posts published this batch are NOT recorded as done — continuing would risk RE-POSTING them after a crash or restart. STOPPING the run now. Free disk space or fix the data-folder permissions, then Start again.');
    this._stop = true;
    this.emit('automation-progress', { ...this._progress });
    return false;
  }

  async _loop(getData) {
    const _st = store.loadRotation();
    this._dealt = new Set(Array.isArray(_st.dealt) ? _st.dealt : []); // post-ids already dealt (unique modes)
    this._zeroProgressCycles = 0; // consecutive cycles that dealt nothing -> stall breaker
    this._lastOutstanding = null; this._noDrain = 0; // completion engine: detect when drain stops progressing -> undeliverable
    this._proxyWarned = false;    // one-time per-run "proxies off / shared IP" warning
    this._auditWarned = false;    // one-time per-run "audit-log write failed" warning
    this._roundOffset = _st.roundOffset || 0; // rotates account↔post mapping across Loop-campaign recycles
    this._staggerRotation = _st.staggerRotation || 0; // E-N3: rotates account START order each cycle (fairness)
    this._lastDailyRunDate = _st.lastDailyRunDate || null; // 'daily' schedule: local day-key of the last run (same-day-restart dedupe)
    this._perAccountRotation = (_st.perAccountRotation && typeof _st.perAccountRotation === 'object') ? _st.perAccountRotation : {}; // daily-rotation + campaign-plan: per-agent { lastPostId, lastPostedDate }
    this._campaignPlan = (_st.campaignPlan && typeof _st.campaignPlan === 'object') ? _st.campaignPlan : null; // campaign-plan: { batchId, agentLists{}, clusters[] }
    this._retryCount = {}; // E-N4: per-account consecutive rate-limit retries → stagger decay (in-memory)
    try { this._proxyHealth.load(this._proxyHealthFile()); } catch {} // E-X3: restore proxy health (prunes >1h)
    let cycle = 0;
    while (!this._shouldStop()) {
      this._data = getData(); // re-read each cycle so mid-run edits take effect
      const data = this._data; // the moderator/rescue phases below reference `data` — bind it (was a latent ReferenceError swallowed by their try/catch, silently disabling rescue + the end-of-cycle approval sweep)
      const { posts, accounts, settings } = this._data;
      if (!posts.length) { this.log('⚠️ No posts configured — stopping.'); break; }
      const allPosters = accounts.filter((a) => a.enabled !== false && !a.isModerator); // MOD: the moderator only approves, never posts
      if (!allPosters.length) { this.log('⚠️ No enabled accounts — stopping.'); break; }
      // DAILY SCHEDULE: run exactly ONE cycle/day at the local dailyPostTime (the operator's "1 post/day
      // per account into its groups; next day the next post" model — pair with sequence mode + Loop). Wait
      // until the fire time; if today's run already happened, wait until tomorrow. Survives a same-day
      // restart via the persisted lastDailyRunDate. continuous mode is unchanged (no gate).
      if (settings.scheduleMode === 'daily') {
        const waitMs = this._msUntilDailyFire(settings.dailyPostTime, this._lastDailyRunDate);
        if (waitMs > 0) {
          this.log(`📅 Daily mode — next run at ${settings.dailyPostTime} (in ~${Math.round(waitMs / 360000) / 10}h).`);
          await this._waitWithCountdown(waitMs, `Daily run at ${settings.dailyPostTime}`);
          if (this._shouldStop() || this._finish) break;
          continue; // re-enter: now it's fire time → falls through and runs one cycle
        }
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
        const healthy = (a) => a.enabled !== false && a.status === 'logged_in' && (Number(a.rateLimitedUntil) || 0) <= nowR;
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
        const uncovered = activeGroups.filter((g) => !reserve.some((a) => isMember(a, g) && healthy(a)));
        const rkey = reserve.map((a) => a.name).sort().join(',');
        if (rkey !== this._lastReserveKey) {
          this._lastReserveKey = rkey;
          this.log(`🧰 Reserve this cycle: ${reserve.map((a) => a.alias || a.name).join(', ') || '(none)'} held back from posting (kept healthy to rescue held/orphaned posts); ${active.length} posting.`);
          if (uncovered.length) this.log(`⚠️ No healthy reserve member for group(s): ${uncovered.map((g) => g.name || g.groupId || g.id).join(', ')} — a rescuer there may have to wait (assign more accounts to those groups, or raise Reserve Accounts).`);
        }
      }
      this._active = active;
      this._reserve = reserve;
      // CAMPAIGN PLAN: (re)compute the per-cluster day-by-day split when there are campaign-plan agents and
      // either no plan yet OR the library/agent-set changed (batchId mismatch). Recompute preserves each
      // agent's delivered pointer (perAccountRotation) — only future slots change — so edits don't re-post.
      {
        const planAgents = active.filter((a) => (a.postingOrder || '') === 'campaign-plan');
        if (planAgents.length) {
          const planPosts = (this._data.posts || []).filter((p) => matchesFilter(p, (planAgents[0].postFilter) || 'all'));
          const fresh = this._computeCampaignPlan(planPosts, planAgents, this._roundOffset || 0);
          if (!this._campaignPlan || this._campaignPlan.batchId !== fresh.batchId) {
            // A CHANGED plan (content/roster edited) → reset the per-agent slice pointers so distribution
            // restarts cleanly with the new content. An UNCHANGED restart keeps the same batchId → no
            // recompute → pointers preserved → it resumes mid-campaign. (Edit content between rounds, or
            // Stop→edit→Start, to avoid re-posting mid-round.)
            const wasExisting = !!this._campaignPlan;
            this._campaignPlan = fresh;
            if (wasExisting) for (const a of planAgents) delete (this._perAccountRotation || (this._perAccountRotation = {}))[a.name];
            try { const _r = store.loadRotation(); _r.campaignPlan = this._campaignPlan; _r.perAccountRotation = this._perAccountRotation || {}; store.saveRotation(_r); } catch {}
            const totalDays = Math.max(0, ...fresh.clusters.map((c) => c.days));
            this.log(`🗓️ Campaign Plan: ${planPosts.length} post(s) split across ${planAgents.length} agent(s) in ${fresh.clusters.length} group-set(s) → ~${totalDays} day(s); each group-set receives the whole library.`);
          }
        } else if (this._campaignPlan) {
          this._campaignPlan = null; // no campaign-plan agents this cycle
        }
      }
      // Shared-IP warning (once per run): many accounts from ONE IP is a top coordinated-spam signal.
      if (!this._proxyWarned && active.length > 1) {
        this._proxyWarned = true;
        if (!settings.useProxies) {
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
      // Unique modes deal each post once across accounts. When every active account is unique
      // and no un-dealt posts remain, the campaign is complete — stop and reset for the next run.
      // Only FINITE modes (unique/sequence) can "complete"; daily-rotation and post-centric are ongoing
      // (they loop by design), so they're excluded — a pure daily-rotation fleet never declares complete.
      const finiteActive = active.filter((a) => { const o = a.postingOrder || 'post-centric'; return o.includes('unique') || o === 'sequence'; });
      // In completion mode we do NOT stop/recycle at "all posts dealt" — we keep cycling to DRAIN the
      // comment-rescue + moderator-approval queues; the completion check at the cycle's end decides the stop.
      if (!settings.completionMode && finiteActive.length && finiteActive.reduce((s, a) => s + this._postsForAccount(a, cycle).length, 0) === 0) {
        if (settings.loopCampaign) {
          // Loop campaign: re-distribute the whole library, rotating content across accounts.
          this.log('🔁 All posts distributed — looping (recycling, rotating content across accounts)...');
          this._dealt.clear();
          this._roundOffset = (this._roundOffset || 0) + 1;
          try { store.saveRotation({ dealt: [], roundOffset: this._roundOffset, staggerRotation: this._staggerRotation || 0, lastDailyRunDate: this._lastDailyRunDate || null, perAccountRotation: this._perAccountRotation || {}, campaignPlan: this._campaignPlan || null }); } catch {} // keep the daily + per-agent + campaign markers so a same-day restart can't double-run
          // fall through: this cycle now re-deals the full library
        } else {
          this.log('✅ All posts have been distributed — campaign complete.');
          this._dealt.clear(); try { store.saveRotation({ dealt: [], roundOffset: 0, staggerRotation: this._staggerRotation || 0, lastDailyRunDate: this._lastDailyRunDate || null, perAccountRotation: this._perAccountRotation || {}, campaignPlan: this._campaignPlan || null }); } catch {}
          break;
        }
      }
      this._progress.cycle = cycle;
      this._progress.accountsTotal = active.length;
      this._progress.accountsDone = 0;
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
      const queue = active.slice(rot).concat(active.slice(0, rot));
      const cyclePostedIds = []; // published this cycle (auto-deletable)
      const cycleDealtIds = [];  // dealt this cycle (published OR pending — rotation)
      const cycleFlags = [];     // per-account flags (needs_login / rate_limited) seen this cycle

      // E-N5: DYNAMIC CONCURRENCY POOL — run all active accounts through `poolSize` slots, launching
      // the next the INSTANT a slot frees (no batch barrier wasting the fast accounts' idle time).
      // Invariants preserved: per-account gates (enabled / cool-down / daily-cap) run BEFORE each
      // account; dealt-ids are persisted PER COMPLETION (halt-on-write-failure intact); stagger
      // spaces the initial fill to avoid a coordinated burst; offline drains + holds; Finish drains
      // the in-flight set then exits.
      const poolSize = Math.max(1, Number(settings.parallelAccounts) || 2);
      this.log(`🧵 Pool: ${queue.length} account(s), up to ${poolSize} at a time (${new Date().toLocaleTimeString()})`);
      let launchIdx = 0, stopPool = false, sawOffline = false;
      let firstStart = 0, lastEnd = 0, cpuMs = 0, ranCount = 0;

      const runOne = async (account) => {
        const myLaunch = launchIdx++;
        // Stagger only the INITIAL fill (the first poolSize launches start near-simultaneously); later
        // launches are completion-triggered and already spread out in time. E-N4: halve per retry.
        if (settings.staggerAccounts !== false && myLaunch > 0 && myLaunch < poolSize && !this._shouldStop() && !stopPool) {
          const retries = (this._retryCount && this._retryCount[account.name]) || 0;
          // T4: stagger the initial fill by a randomized per-launch gap from the accountDelay range
          // (cumulative across launches, capped at accountDelayMax, decayed on retries) so concurrent
          // accounts never start in a synchronized burst.
          const staggerBase = rangeMs(settings, 'accountDelayMin', 'accountDelayMax', 1, 4, 60000, 0);
          const capMs = (Number.isFinite(settings.accountDelayMax) ? settings.accountDelayMax : 4) * 60000;
          const base = Math.round(Math.min(staggerBase * myLaunch, capMs) * Math.pow(0.5, retries));
          if (base > 0) await this._interruptibleSleep(base);
        }
        if (this._shouldStop() || stopPool || this._finish) return;
        // Mid-run toggle: if the user turned this account OFF since the cycle began, skip it now.
        const live = (getData().accounts || []).find((a) => a.name === account.name);
        const idle = (msg) => { this.log(msg); this._progress.accountsDone++; this.emit('automation-progress', { ...this._progress }); };
        if (live && live.enabled === false) return idle(`⏸️ [${account.name}] turned OFF — skipping for the rest of this run`);
        // Rate-limit COOL-DOWN: a recently rate-limited account rests for hours instead of re-hammering FB.
        if (live && live.rateLimitedUntil && live.rateLimitedUntil > Date.now()) {
          const mins = Math.ceil((live.rateLimitedUntil - Date.now()) / 60000);
          return idle(`🧊 [${account.name}] cooling down after a rate-limit — ${mins} min left; skipping this cycle`);
        }
        // Per-account DAILY CAP on group-posts (0 = off).
        const cap = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
        const usedToday = (cap > 0 && live) ? store.dailyUsed(live.daily) : 0;
        if (cap > 0 && usedToday >= cap) return idle(`📵 [${account.name}] daily cap reached (${usedToday}/${cap} group-posts today) — skipping until tomorrow`);
        const maxThisRun = cap > 0 ? (cap - usedToday) : Infinity;
        // Advisory (once/account/run): dailyCap counts GROUP-POSTS, not distinct posts — so a cap below the
        // account's assigned-group count silently leaves some groups un-posted each day. Warn so it's not a footgun.
        const _grp = (account.assignedGroups || []).length;
        if (cap > 0 && _grp > cap) { this._capWarned = this._capWarned || {}; if (!this._capWarned[account.name]) { this._capWarned[account.name] = 1; this.log(`⚠️ [${account.name}] daily cap ${cap} < its ${_grp} assigned groups — it won't reach all groups in a day (the cap counts group-posts, not distinct posts). Raise the cap to ≥${_grp} to cover all groups daily.`); } }

        const t0 = Date.now(); if (!firstStart) firstStart = t0;
        this.log(`[${account.name}] Starting with ${(account.assignedGroups || []).length} groups`);
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
        const st = (this._runStats[account.name] = this._runStats[account.name] || { posted: 0, pending: 0, errors: 0 });
        st.posted += res.posted; st.pending += res.pendingApproval; st.errors += res.errors;
        this.emit('automation-progress', { ...this._progress });
        // DAILY ROTATION: advance + persist this agent's pointer ONLY on a successful post (dealtIds = the
        // single pick if it published OR pended). A failure leaves the pointer so it retries the SAME post
        // next day. Strip postedIds so rotation content is never auto-deleted (it recycles). Keep dealtIds
        // for the cycle's progress/stall bookkeeping but do NOT let it pollute the shared dealt-set.
        if ((account.postingOrder || '') === 'daily-rotation' || (account.postingOrder || '') === 'campaign-plan') {
          // Both modes track per-agent progress by a daily pointer (perAccountRotation) and own their own
          // persistence (the shared _persistDealt is skipped below). Advance ONLY on a successful post
          // (dealtIds = the single pick) so a failure retries the SAME slot next day. Strip postedIds so the
          // content is never auto-deleted. Keep dealtIds for cycle progress/stall bookkeeping only.
          if (res.dealtIds.length) {
            this._perAccountRotation = this._perAccountRotation || {};
            this._perAccountRotation[account.name] = { lastPostId: res.dealtIds[0], lastPostedDate: this._localDayKey() };
            try { const _r = store.loadRotation(); _r.perAccountRotation = this._perAccountRotation; if (!store.saveRotation(_r)) throw new Error('saveRotation returned false'); }
            catch (e) { this.log(`⚠️ [${account.name}] could not persist its rotation pointer (${e.message}) — it may re-post today's post tomorrow. Free disk space / fix data-folder permissions.`); }
          }
          cyclePostedIds.push(...[]); cycleDealtIds.push(...res.dealtIds); if (res.flag) cycleFlags.push(res.flag);
        } else {
          cyclePostedIds.push(...res.postedIds); cycleDealtIds.push(...res.dealtIds); if (res.flag) cycleFlags.push(res.flag);
        }
        // Persist dealt-ids the MOMENT this account finishes so a crash can't re-deal (re-post) an
        // already-published post. _persistDealt halts the run (sets _stop) on a write failure. SKIP for
        // daily-rotation: it owns its per-agent pointer (persisted above) and must NOT grow the shared
        // dealt-set (which is for finite unique/sequence distribution only).
        if ((account.postingOrder || '') !== 'daily-rotation' && (account.postingOrder || '') !== 'campaign-plan' && res.dealtIds.length && !this._persistDealt(res.dealtIds)) { stopPool = true; return; }
        if (res.offline) { sawOffline = true; stopPool = true; } // connection lost mid-flight → drain + hold
      };

      const inFlight = new Set();
      const launchNext = () => {
        if (stopPool || this._shouldStop() || this._finish || !queue.length) return;
        const account = queue.shift();
        const p = runOne(account).catch((e) => { this.log(`❌ pool error: ${e.message}`); }).finally(() => inFlight.delete(p));
        inFlight.add(p);
      };
      while ((queue.length || inFlight.size) && !this._shouldStop()) {
        await this._waitWhilePaused(); if (this._shouldStop()) break;
        while (inFlight.size < poolSize && queue.length && !stopPool && !this._finish && !this._shouldStop()) launchNext();
        if (!inFlight.size) break; // nothing running and nothing launchable (finish / stop / drained)
        await Promise.race([...inFlight]); // wake as soon as ONE slot frees, then top the pool back up
      }
      await Promise.allSettled([...inFlight]); // drain whatever is still running before the cycle ends

      // RESERVE TAKEOVER (unique/sequence modes only): if an active account DROPPED this cycle
      // (rate-limit, logout, checkpoint, block, disabled, bad proxy), its post(s) were released and are
      // still UNDEALT — coverage would otherwise be lost until the next cycle/day. Pull idle HEALTHY
      // reserve members that (a) have daily headroom and (b) actually have an undealt post to deliver,
      // and run a BOUNDED second pass through the SAME pool machinery (so claims, dealt-persist, daily-cap
      // and stagger all apply unchanged). Reused reserves are removed from this._reserve so Phase-3 rescue
      // can't double-use them. Continuous/non-unique modes have no dealt-set, so this is a no-op there.
      const _dropFlags = new Set(['rate_limited', 'needs_login', 'needs_verification', 'account_disabled', 'likely_blocked', 'proxy_invalid']);
      const _uniqueMode = active.some((a) => { const o = a.postingOrder || 'post-centric'; return o.includes('unique') || o === 'sequence'; });
      if (!sawOffline && !stopPool && !this._shouldStop() && !this._finish && _uniqueMode && cycleFlags.some((f) => _dropFlags.has(f)) && (this._reserve || []).length) {
        const nowT = Date.now();
        const capT = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
        // Bound promotions to roughly the number of accounts that DROPPED (each released ~1 post), capped at 3.
        const maxTakeover = Math.min(3, Math.max(1, cycleFlags.filter((f) => _dropFlags.has(f)).length));
        // Healthy, in-headroom reserve candidates.
        const cand = (this._reserve || []).filter((a) =>
          a.enabled !== false && !a.isModerator && a.status === 'logged_in' && (Number(a.rateLimitedUntil) || 0) <= nowT &&
          (capT <= 0 || store.dailyUsed(((getData().accounts || []).find((x) => x.name === a.name) || a).daily) < capT));
        // CRITICAL: _postsForAccount finds an account's index in this._active and returns [] otherwise — so a
        // reserve must be IN this._active to be probed/claimed for. Temporarily include all candidates, probe,
        // then narrow this._active to the chosen takeovers (their appended index falls back to remaining[0]).
        this._active = active.concat(cand);
        const takeovers = [];
        for (const a of cand) {
          if (takeovers.length >= maxTakeover) break;
          if (this._postsForAccount(a, cycle, false).length > 0) takeovers.push(a); // an undealt post exists for it to deliver
        }
        this._active = active.concat(takeovers);
        if (takeovers.length) {
          const tnames = new Set(takeovers.map((a) => a.name));
          this._reserve = (this._reserve || []).filter((a) => !tnames.has(a.name)); // don't also use them for Phase-3 rescue
          this._progress.accountsTotal += takeovers.length; this.emit('automation-progress', { ...this._progress });
          this.log(`🔁 Reserve takeover: ${takeovers.length} healthy reserve account(s) delivering posts a dropped account left undealt — ${takeovers.map((a) => a.alias || a.name).join(', ')}`);
          for (const a of takeovers) queue.push(a);
          while ((queue.length || inFlight.size) && !this._shouldStop()) {
            await this._waitWhilePaused(); if (this._shouldStop()) break;
            while (inFlight.size < poolSize && queue.length && !stopPool && !this._finish && !this._shouldStop()) launchNext();
            if (!inFlight.size) break;
            await Promise.race([...inFlight]);
          }
          await Promise.allSettled([...inFlight]);
        } else {
          this._active = active; // no takeover → restore the unmodified active set
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
      if (sawOffline && !this._shouldStop()) {
        this.log('🌐 Connection lost mid-cycle — holding until it returns...');
        await this._waitForConnectivity();
      }
      // Dealt-ids were already persisted incrementally per batch by _persistDealt (above), which
      // mirrors them into this._dealt and halts the run on a write failure — so there is nothing
      // left to mark or save here. (Round-robin invariant, for reference: each post is dealt once;
      // a failed account's post stays un-dealt and is re-dealt next cycle.)
      if (this._shouldStop()) break;

      // ── PHASE 2: MODERATOR APPROVAL (opt-in, behind settings.moderationEnabled) ──────────────────
      // FB holds poster accounts' posts in the group "Spam potentiel" / pending queue (not the public
      // feed), so the first comment can't attach. A designated MODERATOR account (admin of the groups)
      // approves OUR held posts so they go live. DRY-RUN for now: it scans the queues and LOGS what it
      // would approve (no clicks) so we refine the queue DOM live, then enable the click. No-op when off.
      this._pruneModeration(); // hygiene runs EVERY cycle, even when moderation is OFF (no frozen residue)
      if (settings.moderationEnabled && !this._shouldStop() && !this._approving) {
        this._approving = true;
        try { await this._runModeratorApproval(data, () => this._shouldStop()); }
        catch (e) { this.log(`⚠️ moderator phase error: ${e.message}`); }
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
            const eligibleFor = (c) => (data.accounts || []).filter((a) =>
              a.enabled !== false && !a.isModerator && a.status === 'logged_in' &&
              (Number(a.rateLimitedUntil) || 0) <= now && a.name !== c.posterAccount && inGroup(a, c.gid))
              .sort((a, b) => (reserveNames.has(b.name) ? 1 : 0) - (reserveNames.has(a.name) ? 1 : 0)); // reserve first
            const PER_RESCUER = 5; // cap per rescuer per cycle so it doesn't burst-comment links and get itself blocked
            const byAccount = new Map(); const unassigned = [];
            for (const c of pending) {
              const pick = eligibleFor(c).find((a) => ((byAccount.get(a.name) || { tasks: [] }).tasks.length) < PER_RESCUER);
              if (!pick) { unassigned.push(c); continue; }
              if (!byAccount.has(pick.name)) byAccount.set(pick.name, { account: pick, tasks: [] });
              byAccount.get(pick.name).tasks.push(c);
            }
            if (unassigned.length) this.log(`⚠️ ${unassigned.length} orphaned comment(s) have no free healthy in-group account this cycle — they stay queued (assign a reserve account to those groups, or they retry next cycle).`);
            if (byAccount.size) {
              const { runRescue } = require('./rescue');
              const hidden = settings.hideBrowser !== false;
              const markResult = (task, outcome) => {
                try {
                  const d2 = store.loadComments();
                  const rec = d2.pending.find((x) => x.gid === task.gid && (x.postId && task.postId ? x.postId === task.postId : x.captionSnip === task.captionSnip) && x.status === 'pending');
                  if (rec) {
                    rec.attempts = (rec.attempts || 0) + 1;
                    if (outcome === 'done') { rec.status = 'done'; rec.commentedAt = Date.now(); }
                    else if (outcome === 'notfound') {
                      // Live-but-not-in-public-feed → actually HELD in Spam potentiel. RE-HOME it into the
                      // moderator queue (so the moderator approves it → the comment is re-queued), and close
                      // this comment record so it can never sit in a status no phase ever reads.
                      rec.status = 'rehomed'; rec.note = 're-homed to moderator approval (held in Spam potentiel)';
                      if (task.captionSnip || task.postId) {
                        try {
                          const ms = store.loadModeration();
                          const dup = (ms.held || []).some((x) => x.gid === task.gid && ((task.captionSnip && x.captionSnip) ? x.captionSnip === task.captionSnip : (!!x.postId && !!task.postId && x.postId === task.postId)) && (x.status === 'held' || x.status === 'approved'));
                          if (!dup) { ms.held.push({ postId: task.postId || null, gid: task.gid, posterAccount: task.posterAccount || null, fbDisplayName: '', captionSnip: task.captionSnip || '', postCaption: task.postCaption || null, groupName: task.groupName || null, comment: task.comment || '', commentImg: task.commentImg || null, postPermalink: task.postPermalink || null, status: 'held', heldAt: Date.now(), approvedAt: null, source: 'rescue_notfound' }); store.saveModeration(ms); this.log(`🔁 [${task.groupName || task.gid}] orphaned comment looks HELD — re-homed to moderator approval`); }
                        } catch {}
                      }
                    }
                    else if (rec.attempts >= 3) { rec.status = 'failed'; }
                  }
                  store.saveComments(d2);
                } catch {}
              };
              this.log(`💬 Comment rescue: ${pending.length - unassigned.length} orphaned comment(s) across ${byAccount.size} healthy account(s)…`);
              for (const { account, tasks } of byAccount.values()) {
                if (this._shouldStop()) break;
                await runRescue({ account, tasks, settings, hidden, log: (m) => this.log(m), shouldStop: () => this._shouldStop(), onResult: markResult });
              }
            }
            // Prune resolved records (done/failed/rehomed) so the queue keeps ONLY retryable 'pending'.
            // OUTSIDE the byAccount block → done/failed records are reaped even on cycles where no rescuer
            // was assigned (else pending-comments.json grows unbounded across days).
            try { const d3 = store.loadComments(); d3.pending = (d3.pending || []).filter((c) => c.status === 'pending'); store.saveComments(d3); } catch {}
          }
        } catch (e) { this.log(`⚠️ comment-rescue phase error: ${e.message}`); }
      }

      // One-time campaign: remove the posts PUBLISHED this cycle so each post is used
      // exactly once (and the run ends when the library empties). Pending-approval posts
      // are NOT in cyclePostedIds, so they survive. Serialized via store.update so a
      // concurrent UI/remote edit can't be clobbered.
      if (settings.autoDeletePosted && cyclePostedIds.length) {
        const del = new Set(cyclePostedIds);
        const { removed, remaining } = await store.update((d) => {
          const before = d.posts.length;
          d.posts = d.posts.filter((p) => !del.has(p.id));
          return { removed: before - d.posts.length, remaining: d.posts.length };
        });
        this.emit('data-updated');
        this.log(`🗑️ Auto-deleted ${removed} posted post(s) — ${remaining} remaining`);
      }

      if (this._shouldStop() || this._finish) break;

      // CAMPAIGN PLAN big-cycle: every group-set has received the WHOLE library (all agents finished their
      // slices). If Loop Campaign is ON, start a fresh round (rotate who-posts-what; pace from the next day).
      // If OFF, the completion engine just below drains any last comments/held, then reports + stops.
      if (this._campaignPlan && settings.loopCampaign && this._campaignAllFinished()) {
        this._roundOffset = (this._roundOffset || 0) + 1;
        const planAgents = (this._active || []).filter((a) => (a.postingOrder || '') === 'campaign-plan');
        for (const a of planAgents) (this._perAccountRotation || (this._perAccountRotation = {}))[a.name] = { lastPostId: null, lastPostedDate: this._localDayKey() }; // reset slice; pace round 2 to next day
        const planPosts = (this._data.posts || []).filter((p) => matchesFilter(p, (planAgents[0] && planAgents[0].postFilter) || 'all'));
        this._campaignPlan = this._computeCampaignPlan(planPosts, planAgents, this._roundOffset);
        try { const _r = store.loadRotation(); _r.campaignPlan = this._campaignPlan; _r.perAccountRotation = this._perAccountRotation; _r.roundOffset = this._roundOffset; store.saveRotation(_r); } catch {}
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
            if (this._noDrain >= 12) { this._emitCompletionReport('undeliverable', out); break; }
            this.log(`⏳ Completion mode: all posts published — placing ${out.pending} comment(s) + approving ${out.held} held post(s)…`);
            await this._waitWithCountdown(Math.min(rangeMs(settings, 'waitIntervalMin', 'waitIntervalMax', 90, 180, 60000, 1), 180000), 'Completing campaign');
            if (this._shouldStop() || this._finish) break;
            continue; // drain phase governs the loop — skip the stall-breaker (which would misread 0 posts as a stall)
          }
          this._noDrain = 0; this._lastOutstanding = out.total; // still posting → reset drain tracker, use normal guards/wait below
        }
      }

      // All-sessions-invalid guard: if a whole cycle published/queued NOTHING and at least one
      // account reported it was logged out, looping again would just relaunch browsers that all
      // bail. Stop with a clear reason instead of spinning forever unattended.
      if (cycleDealtIds.length === 0 && (cycleFlags.includes('needs_login') || cycleFlags.includes('account_disabled') || cycleFlags.includes('needs_verification') || cycleFlags.includes('proxy_invalid'))) {
        this.log('🛑 No account could post this cycle — accounts need attention (logged out, disabled, or identity-verification required). Stopping. Fix the flagged accounts, then Start again.');
        break;
      }
      // DAILY-CAP HOLD: if every active poster simply hit today's cap (not cooling, not flagged), the run
      // is DONE FOR TODAY — wait for the UTC day to roll over and resume, instead of tripping the stall-
      // breaker and STOPPING (which would leave the app dead hours before tomorrow). A rate-limited or
      // flagged fleet is NOT a cap-hold (those still fall through to the real stop below).
      const _cap = Number.isFinite(settings.dailyCap) ? settings.dailyCap : 0;
      if (cycleDealtIds.length === 0 && _cap > 0 && settings.scheduleMode !== 'daily') { // daily mode's gate already waits a day
        const _now = Date.now();
        const _liveAccts = (getData().accounts || []);
        const _activePosters = (this._active || []).filter((a) => a.enabled !== false && !a.isModerator);
        const _allCapped = _activePosters.length > 0 && _activePosters.every((a) => {
          const live = _liveAccts.find((x) => x.name === a.name) || a;
          if ((Number(live.rateLimitedUntil) || 0) > _now) return false; // cooling down → not a cap-only stall
          if (this._runFlags && this._runFlags[a.name]) return false;     // flagged → not a cap-only stall
          return store.dailyUsed(live.daily) >= _cap;
        });
        if (_allCapped) {
          const d = new Date(_now);
          const nextMidnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 30); // +30s past the UTC rollover
          const waitMs = Math.max(60000, nextMidnightUtc - _now);
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
        const _allRotatedToday = (this._active || []).every((a) => {
          const o = a.postingOrder || '';
          if (o !== 'daily-rotation' && o !== 'campaign-plan') return false;
          const rec = (this._perAccountRotation || {})[a.name] || {};
          return rec.lastPostedDate === _today;
        });
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
      // Dead-fleet / stall breaker: if the run dealt NOTHING for several cycles in a row (every account
      // rate-limited, likely-blocked, group-less, or disabled), STOP instead of relaunching browsers
      // forever unattended. This catches the zero-progress cases the flag-specific guard above doesn't
      // (especially an all-rate-limited fleet, which would otherwise loop and keep burning the accounts).
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
        if (active.length && capped === active.length) cause = `all ${active.length} active account(s) have hit today's daily cap (${capN}/day) — they will resume automatically after midnight UTC (no action needed)`;
        else if (active.length && rl === active.length) cause = `all ${active.length} active account(s) are rate-limited and cooling down — wait for the cool-down to elapse, then Start again`;
        else if (active.length && noGroups === active.length) cause = 'no active account has any groups assigned — assign groups in the Accounts tab';
        else if (flagged) cause = `${flagged} account(s) need attention (logged out, checkpoint, or blocked) — fix the flagged accounts, then Start again`;
        else cause = 'check your accounts/groups (rate-limited, blocked, logged out, or no groups assigned)';
        this.log(`🛑 3 cycles in a row posted nothing — stopping so the app doesn't spin unattended. Likely cause: ${cause}.`);
        break;
      }
      if ((settings.maxCycles || 0) > 0 && cycle >= settings.maxCycles) {
        this.log(`🏁 Reached maxCycles (${settings.maxCycles}) — finishing.`); break;
      }
      if (settings.scheduleMode === 'daily') {
        // Mark today's run done + persist (survives a same-day restart) so the top-of-loop daily gate now
        // waits until TOMORROW's fire time. The continuous inter-cycle wait below is skipped in daily mode.
        this._lastDailyRunDate = this._localDayKey();
        try { const _r = store.loadRotation(); _r.lastDailyRunDate = this._lastDailyRunDate; store.saveRotation(_r); } catch {}
        this.log(`📅 Daily run complete — next run tomorrow at ${settings.dailyPostTime}.`);
        continue; // the top-of-loop daily gate performs the ~24h wait until the next fire
      }
      const cycleWaitMs = rangeMs(settings, 'waitIntervalMin', 'waitIntervalMax', 90, 180, 60000, 1); // T3: randomized inter-cycle wait
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
  async _waitWithCountdown(ms, label) {
    if (!(ms > 0)) return;
    let end = Date.now() + ms;
    let lastLog = 0;
    const fmt = (sec) => { const m = Math.floor(sec / 60), s = sec % 60; return (m > 0 ? m + 'm ' : '') + s + 's'; };
    while (Date.now() < end && !this._shouldStop()) {
      if (this._paused) {
        const pausedAt = Date.now();
        await this._waitWhilePaused();
        end += Date.now() - pausedAt;
        if (this._shouldStop()) break;
        continue;
      }
      if (lastLog === 0 || Date.now() - lastLog >= 30000) {
        lastLog = Date.now();
        const remaining = Math.ceil((end - Date.now()) / 1000);
        this.log(`⏳ ${label} in ${fmt(remaining)}…`);
        if (this._progress) { this._progress.waitingLabel = label; this._progress.waitRemainingSec = remaining; this.emit('automation-progress', { ...this._progress }); }
      }
      await sleep(1000);
    }
    if (this._progress) { this._progress.waitingLabel = null; this._progress.waitRemainingSec = 0; this.emit('automation-progress', { ...this._progress }); }
  }

  // LOCAL calendar-day key (the 'daily' schedule fires at a LOCAL wall-clock time, so the de-dupe key
  // must be local too — UTC would be off-by-one near midnight).
  _localDayKey(d = new Date()) { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
  // ms until the next 'daily' fire for dailyPostTime ('HH:MM' local). 0 = fire NOW (today's time has
  // arrived and we haven't run today). If we already ran today, returns ms until tomorrow's time.
  _msUntilDailyFire(timeStr, lastRunDateKey) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(timeStr || '09:00')) || [null, '9', '0'];
    const hh = parseInt(m[1], 10) || 0, mm = parseInt(m[2], 10) || 0;
    const now = new Date();
    const fireToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (lastRunDateKey === this._localDayKey(now)) { const t = new Date(fireToday.getTime()); t.setDate(t.getDate() + 1); return t.getTime() - now.getTime(); }
    return Math.max(0, fireToday.getTime() - now.getTime());
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
      for (const a of finite) for (const p of (data.posts || []).filter((p) => matchesFilter(p, a.postFilter || 'all'))) if (!this._dealt.has(p.id)) seen.add(p.id);
      undealt = seen.size;
    }
    // Campaign-plan posts not yet delivered (tracked by per-agent pointers, not the shared dealt-set).
    const campaignAgents = (active || []).filter((a) => (a.postingOrder || '') === 'campaign-plan');
    const campaignRemaining = campaignAgents.length ? this._campaignRemaining() : 0;
    undealt += campaignRemaining;
    let pending = 0, held = 0;
    try { pending = (store.loadComments().pending || []).filter((c) => c.status === 'pending' && (c.attempts || 0) < 3).length; } catch {}
    try { held = (store.loadModeration().held || []).filter((h) => h.status === 'held').length; } catch {}
    return { undealt, pending, held, total: undealt + pending + held, hasFinite: finite.length > 0 || campaignAgents.length > 0 };
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
    if (reason === 'completed') this.log('🎉 Campaign complete — every post published and every comment delivered. Stopping.');
    else this.log(`🏁 Stopping: ${out ? out.total : '?'} item(s) could not be delivered (${out ? `${out.undealt} unposted, ${out.pending} comments, ${out.held} held` : ''}) — see below.`);
    this.log(`📊 Delivered this run: ${posted} published, ${pending} pending-approval, ${errors} error(s).`);
    if (bad.length) this.log(`🔧 Accounts to REPLACE/check (went bad this run): ${bad.map((a) => `${a.alias || a.name}${(Number(a.rateLimitedUntil) || 0) > now ? ' (rate-limited)' : (this._runFlags && this._runFlags[a.name] ? ` (${this._runFlags[a.name]})` : '')}`).join(', ')}`);
    else this.log('✅ No accounts went bad this run.');
  }

  // ── CAMPAIGN PLAN (campaign-plan mode) ───────────────────────────────────────────────────────────
  // Cluster agents by their SHARED group-set, then WITHIN each cluster partition the WHOLE post library
  // across the cluster's agents (round-robin) — so every group-set receives the entire campaign, split
  // across its team of agents, 1 post/agent/day. Returns per-agent ordered lists (each agent walks its
  // own list via the daily pointer) plus a cluster preview. Pure + deterministic (agent order preserved).
  _computeCampaignPlan(posts, agents, roundOffset = 0) {
    const sig = (a) => (a.assignedGroups || []).slice().sort().join('|');
    const clusters = new Map(); // group signature -> [agents] (insertion order = deterministic)
    for (const a of agents) { const k = sig(a); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(a); }
    const agentLists = {};
    const preview = [];
    for (const [k, cAgents] of clusters) {
      const K = cAgents.length;
      // roundOffset rotates WHICH agent in the cluster starts the partition, so a new big-cycle reshuffles.
      cAgents.forEach((a, j) => {
        const slot = (j + roundOffset) % K;
        agentLists[a.name] = posts.filter((_, idx) => idx % K === slot).map((p) => p.id);
      });
      const maxLen = Math.max(0, ...cAgents.map((a) => agentLists[a.name].length));
      const days = [];
      for (let d = 0; d < maxLen; d++) days.push(cAgents.map((a) => ({ agentName: a.name, postId: agentLists[a.name][d] || null })).filter((s) => s.postId));
      preview.push({ groupKey: k, agents: cAgents.map((a) => a.name), totalPosts: posts.length, days: days.length, grid: days });
    }
    const fp = posts.map((p) => p.id).join(',') + '::' + agents.map((a) => a.name + ':' + sig(a)).join(',');
    let h = 5381; for (let i = 0; i < fp.length; i++) h = ((h * 33) ^ fp.charCodeAt(i)) >>> 0; // djb2 change-detection hash
    return { batchId: String(h), planStartDate: this._localDayKey(), roundOffset, agentLists, clusters: preview };
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
  _campaignAllFinished() {
    const agents = (this._active || []).filter((a) => (a.postingOrder || '') === 'campaign-plan');
    if (!agents.length) return false;
    return agents.every((a) => { const n = this._campaignNextIdx(a.name); return n.idx >= n.len; });
  }

  // Posts still to deliver across all active campaign-plan agents (for completionMode / outstanding work).
  _campaignRemaining() {
    let r = 0; for (const a of (this._active || []).filter((x) => (x.postingOrder || '') === 'campaign-plan')) { const n = this._campaignNextIdx(a.name); r += Math.max(0, n.len - n.idx); }
    return r;
  }
}

module.exports = { Orchestrator, _test: { jitter } };
