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
  const lo = Number.isFinite(settings[minKey]) ? settings[minKey] : defMin;
  const hi = Number.isFinite(settings[maxKey]) ? settings[maxKey] : defMax;
  return rand(Math.max(floorUnit, Math.min(lo, hi)) * unitMs, Math.max(floorUnit, Math.max(lo, hi)) * unitMs);
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
    };
    return MAP[order] || order;
  }

  async start(getData) {
    if (this.running) return { success: false, error: 'Automation already running' };
    this._stop = false; this._paused = false; this._finish = false; this.running = true;
    this._aborters.clear();
    this._progress = { running: true, paused: false, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0, offline: false };
    this._runStartedAt = Date.now();
    this._runStats = {}; // per-account totals across the whole run (for the end-of-run summary)
    this._runFlags = {}; // accountName -> flag set THIS run (rate_limited/checkpoint/etc.)
    this._claimed = new Set(); // post ids claimed by an account this cycle (reset each cycle)
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
              store.saveModeration(ms);
              this.log(`📥 [${account.name}] ${r.heldRecords.length} post(s) held in "Spam potentiel" — queued for moderator approval (then the comment is added once they're public)`);
            } catch (e) { this.log(`⚠️ could not persist held-post state: ${e.message}`); }
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
              store.saveComments(cs);
              if (added) this.log(`📌 [${account.name}] ${added} post(s) live but uncommented — queued for comment-rescue by a healthy account`);
            } catch (e) { this.log(`⚠️ could not persist comment-rescue queue: ${e.message}`); }
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
    if (store.saveRotation({ dealt: merged, roundOffset: this._roundOffset || 0, staggerRotation: this._staggerRotation || 0 })) {
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
    this._proxyWarned = false;    // one-time per-run "proxies off / shared IP" warning
    this._auditWarned = false;    // one-time per-run "audit-log write failed" warning
    this._roundOffset = _st.roundOffset || 0; // rotates account↔post mapping across Loop-campaign recycles
    this._staggerRotation = _st.staggerRotation || 0; // E-N3: rotates account START order each cycle (fairness)
    this._retryCount = {}; // E-N4: per-account consecutive rate-limit retries → stagger decay (in-memory)
    try { this._proxyHealth.load(this._proxyHealthFile()); } catch {} // E-X3: restore proxy health (prunes >1h)
    let cycle = 0;
    while (!this._shouldStop()) {
      this._data = getData(); // re-read each cycle so mid-run edits take effect
      const { posts, accounts, settings } = this._data;
      if (!posts.length) { this.log('⚠️ No posts configured — stopping.'); break; }
      const allPosters = accounts.filter((a) => a.enabled !== false && !a.isModerator); // MOD: the moderator only approves, never posts
      if (!allPosters.length) { this.log('⚠️ No enabled accounts — stopping.'); break; }
      // RESERVE POOL: never run the whole fleet. Hold back `reserveAccounts` healthy accounts (rotating
      // each cycle so every account is used over time) — they stay available to RESCUE orphaned link-
      // comments (a post whose own account got blocked before commenting) and to take over a cooled-down
      // account's slot. Always leaves ≥1 account posting.
      const reserveN = Math.max(0, Math.min(Math.round(Number(settings.reserveAccounts) || 0), allPosters.length - 1));
      let active = allPosters, reserve = [];
      if (reserveN > 0) {
        const rot = (this._reserveRot = (this._reserveRot || 0) + 1) % allPosters.length;
        const rotated = allPosters.slice(rot).concat(allPosters.slice(0, rot));
        reserve = rotated.slice(0, reserveN);
        const rset = new Set(reserve.map((a) => a.name));
        active = allPosters.filter((a) => !rset.has(a.name));
        const rkey = reserve.map((a) => a.name).sort().join(',');
        if (rkey !== this._lastReserveKey) { this._lastReserveKey = rkey; this.log(`🧰 Reserve this cycle: ${reserve.map((a) => a.alias || a.name).join(', ')} held back from posting (kept healthy to rescue orphaned comments); ${active.length} posting.`); }
      }
      this._active = active;
      this._reserve = reserve;
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
      if (active.reduce((s, a) => s + this._postsForAccount(a, cycle).length, 0) === 0) {
        if (settings.loopCampaign) {
          // Loop campaign: re-distribute the whole library, rotating content across accounts.
          this.log('🔁 All posts distributed — looping (recycling, rotating content across accounts)...');
          this._dealt.clear();
          this._roundOffset = (this._roundOffset || 0) + 1;
          try { store.saveRotation({ dealt: [], roundOffset: this._roundOffset }); } catch {}
          // fall through: this cycle now re-deals the full library
        } else {
          this.log('✅ All posts have been distributed — campaign complete.');
          this._dealt.clear(); try { store.saveRotation({ dealt: [], roundOffset: 0 }); } catch {}
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
      // Use first active account's mode as the representative label (mixed-mode is rare).
      const cycleOrder = (active[0] && active[0].postingOrder) || 'post-centric';
      const cycleModeLabel = this._modeLabel(cycleOrder);
      if (anyUnique) {
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
        cyclePostedIds.push(...res.postedIds); cycleDealtIds.push(...res.dealtIds); if (res.flag) cycleFlags.push(res.flag);
        // Persist dealt-ids the MOMENT this account finishes so a crash can't re-deal (re-post) an
        // already-published post. _persistDealt halts the run (sets _stop) on a write failure.
        if (res.dealtIds.length && !this._persistDealt(res.dealtIds)) { stopPool = true; return; }
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
      if (settings.moderationEnabled && !this._shouldStop()) {
        try {
          const heldNow = (store.loadModeration().held || []).filter((h) => h.status === 'held');
          const moderators = (data.accounts || []).filter((a) => a.isModerator);
          if (heldNow.length && !moderators.length) {
            this.log('⚠️ Moderation is ON but NO moderator account is set — held posts will NOT be approved. Designate one in the Groups tab → 🛡️ Group Moderator.');
          } else if (heldNow.length) {
            // Route each held post to the moderator that covers ITS group. group.moderatedBy names the
            // moderator account; if a group has none and there's exactly one moderator, that one covers
            // it (backward-compatible single-moderator default). Supports N moderators, each its groups.
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
            for (const { mod, held } of byMod.values()) {
              if (this._shouldStop()) break;
              const gids = new Set(held.map((h) => h.gid));
              const modGroups = (data.groups || []).filter((g) => gids.has(g.groupId || g.id));
              await runModerator({ account: mod, groups: modGroups, settings, held, posterNames, log: (m) => this.log(m), shouldStop: () => this._shouldStop() });
            }
          }
        } catch (e) { this.log(`⚠️ moderator phase error: ${e.message}`); }
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
      // All-sessions-invalid guard: if a whole cycle published/queued NOTHING and at least one
      // account reported it was logged out, looping again would just relaunch browsers that all
      // bail. Stop with a clear reason instead of spinning forever unattended.
      if (cycleDealtIds.length === 0 && (cycleFlags.includes('needs_login') || cycleFlags.includes('account_disabled') || cycleFlags.includes('needs_verification') || cycleFlags.includes('proxy_invalid'))) {
        this.log('🛑 No account could post this cycle — accounts need attention (logged out, disabled, or identity-verification required). Stopping. Fix the flagged accounts, then Start again.');
        break;
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
        let cause;
        if (active.length && rl === active.length) cause = `all ${active.length} active account(s) are rate-limited and cooling down — wait for the cool-down to elapse, then Start again`;
        else if (active.length && noGroups === active.length) cause = 'no active account has any groups assigned — assign groups in the Accounts tab';
        else if (flagged) cause = `${flagged} account(s) need attention (logged out, checkpoint, or blocked) — fix the flagged accounts, then Start again`;
        else cause = 'check your accounts/groups (rate-limited, blocked, logged out, or no groups assigned)';
        this.log(`🛑 3 cycles in a row posted nothing — stopping so the app doesn't spin unattended. Likely cause: ${cause}.`);
        break;
      }
      if ((settings.maxCycles || 0) > 0 && cycle >= settings.maxCycles) {
        this.log(`🏁 Reached maxCycles (${settings.maxCycles}) — finishing.`); break;
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
}

module.exports = { Orchestrator, _test: { jitter } };
