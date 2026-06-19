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

const store = require('../lib/store');
const { runAccount } = require('./worker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Online if EITHER probe responds within 5s. Parallel (a single dead host can't add 8s) and
// hard-capped so a graceful Stop is never blocked for long.
async function isOnline() {
  const urls = ['https://connectivitycheck.gstatic.com/generate_204', 'https://www.facebook.com'];
  const all = Promise.all(urls.map((u) => probe(u, 5000))).then((r) => r.some(Boolean));
  const cap = new Promise((r) => setTimeout(() => r(false), 5000));
  return Promise.race([all, cap]);
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
    this.isLoginOpen = (this.options && typeof this.options.isLoginOpen === 'function') ? this.options.isLoginOpen : () => false;
    this.running = false;
    this._stop = false;
    this._paused = false;
    this._finish = false;
    this._aborters = new Set();
    this._progress = { running: false, paused: false, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0 };
  }
  isRunning() { return this.running; }
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
      if (await isOnline()) {
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
      await this._interruptibleSleep(15000); // re-check every 15s, but break instantly on Stop
    }
    return false;
  }

  log(msg) { this.emit('automation-log', msg); }

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
  _postsForAccount(account, cycle, claim = false) {
    const data = this._data;
    const filtered = data.posts.filter((p) => matchesFilter(p, account.postFilter || 'all'));
    if (!filtered.length) return [];
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
    let remaining = filtered.filter((p) => !this._dealt.has(p.id) && !(this._claimed && this._claimed.has(p.id)));
    if (!remaining.length) return [];
    if (order.includes('random')) remaining = seededShuffle(remaining, (cycle + 1) * 7919); // randomized deal order (consistent within the cycle)
    const activeList = this._active || data.accounts.filter((a) => a.enabled !== false);
    const i = activeList.findIndex((a) => a.name === account.name);
    if (i < 0) return [];
    // roundOffset rotates which account gets which post across Loop-campaign recycles.
    const k = (i + (this._roundOffset || 0)) % activeList.length;
    // Take the positional post; if this account's slot is past the posts left (e.g. earlier
    // accounts were BLOCKED and freed their post), pick up the FIRST still-available post so a
    // healthy account is never idle while un-posted content waits.
    const pick = remaining[k < remaining.length ? k : 0];
    if (claim && this._claimed) this._claimed.add(pick.id);
    return [pick];
  }

  // Returns { progressed, posted, pendingApproval, errors }. Rotation only advances
  // when progressed, so a fully-crashed account retries the SAME post next cycle.
  async _runAccount(account, cycle) {
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
    const postedIds = []; // posts confirmed PUBLISHED — safe to auto-delete
    const dealtIds = [];  // posts dealt this cycle (published OR pending) — don't re-deal
    try {
    postsLoop:
    for (const post of posts) {
      if (this._shouldStop()) break;
      // Per-account crash isolation + restart (approximates the old supervisor that
      // could relaunch a crashed account worker independently).
      const MAX = 2;
      for (let attempt = 1; attempt <= MAX; attempt++) {
        try {
          const r = await runAccount({
            account, post, groups: data.groups, settings: data.settings,
            useProxies: !!data.useProxies, proxies: data.proxies || [],
            log: (m) => this.log(m),
            shouldStop: () => this._shouldStop(),
            isLoginOpen: this.isLoginOpen,
            registerAborter: (abort) => this._registerAborter(abort),
            isOnline: () => isOnline(), // lets the worker bail fast when offline instead of burning nav timeouts
            waitIfPaused: () => this._waitWhilePaused(), // Pause holds between groups, mid-account
            isPaused: () => this._paused,                // so the worker can suspend its watchdog while paused
            // Per-(account,group,post) outcome → append to the persistent audit trail.
            onResult: (rec) => { try { store.appendReport(rec); } catch {} },
          });
          if (r && r.offline) accountOffline = true;
          posted += (r && r.posted) || 0; pendingApproval += (r && r.pendingApproval) || 0; errors += (r && r.errors) || 0;
          // A post is "dealt" (rotation advances, not re-posted next cycle) if it published OR
          // went pending. But ONLY a confirmed publish is auto-deletable — a pending post an
          // admin may later reject must stay in the library, so pending ids never enter postedIds.
          if (r && (r.posted || 0) > 0) { progressed = true; if (post.id) { postedIds.push(post.id); dealtIds.push(post.id); } }
          else if (r && (r.pendingApproval || 0) > 0) { progressed = true; if (post.id) dealtIds.push(post.id); }
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
              });
              this.emit('data-updated');
            } catch {}
            // Ping the user with a desktop notification when an account needs THEM (captcha /
            // verification, or a re-login). main.js dedupes so it won't spam across cycles.
            if (r.flag === 'needs_verification' || r.flag === 'needs_login') {
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
          if (attempt >= MAX || this._shouldStop()) break;
          await this._interruptibleSleep(5000); // observe Stop during the retry backoff
        }
      }
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

  async _loop(getData) {
    const _st = store.loadRotation();
    this._dealt = new Set(Array.isArray(_st.dealt) ? _st.dealt : []); // post-ids already dealt (unique modes)
    this._roundOffset = _st.roundOffset || 0; // rotates account↔post mapping across Loop-campaign recycles
    let cycle = 0;
    while (!this._shouldStop()) {
      this._data = getData(); // re-read each cycle so mid-run edits take effect
      const { posts, accounts, settings } = this._data;
      if (!posts.length) { this.log('⚠️ No posts configured — stopping.'); break; }
      const active = accounts.filter((a) => a.enabled !== false);
      if (!active.length) { this.log('⚠️ No enabled accounts — stopping.'); break; }
      this._active = active;

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
        this.log(`🎯🔒 ${cycleModeLabel}: ${active.length} accounts, cycle ${cycle}`);
        // Print the plan: one line listing all account → post assignments.
        const planParts = active.map((a) => {
          const ap = this._postsForAccount(a, cycle);
          if (!ap.length) return `[${a.name}] → (waits this cycle)`;
          const idx = this._data.posts.findIndex((p) => p.id === ap[0].id);
          return `[${a.name}] → Post #${idx + 1}`;
        });
        // Print ~3 per line so the plan is readable but not excessively long.
        for (let pi = 0; pi < planParts.length; pi += 3) {
          this.log(planParts.slice(pi, pi + 3).join('   '));
        }
      } else {
        this.log(`🎯 ${cycleModeLabel}: ${active.length} accounts — each posts all eligible posts`);
      }

      await this._waitWhilePaused(); if (this._shouldStop()) break;
      await this._waitForConnectivity(); if (this._shouldStop()) break;

      const batches = chunk(active, settings.parallelAccounts || 3);
      const cyclePostedIds = []; // published this cycle (auto-deletable)
      const cycleDealtIds = [];  // dealt this cycle (published OR pending — rotation)
      const cycleFlags = [];     // per-account flags (needs_login / rate_limited) seen this cycle
      for (let b = 0; b < batches.length; b++) {
        if (this._shouldStop()) break;
        await this._waitWhilePaused(); if (this._shouldStop()) break;
        await this._waitForConnectivity(); if (this._shouldStop()) break;
        const batch = batches[b];
        this.log(`═══ BATCH ${b + 1}: ${batch.map((a) => a.name).join(', ')} (${new Date().toLocaleTimeString()}) ═══`);
        for (const ba of batch) {
          this.log(`[${ba.name}] Starting with ${(ba.assignedGroups || []).length} groups`);
        }
        const results = await Promise.all(batch.map(async (account) => {
          const r = await this._runAccount(account, cycle)
            .catch((e) => { this.log(`❌ [${account.name}] supervisor caught: ${e.message}`); return { progressed: false, posted: 0, pendingApproval: 0, errors: 1, postedIds: [], dealtIds: [], offline: false }; });
          this.log(`✓ [${account.name}] Completed`);
          const res = { account, progressed: !!(r && r.progressed), posted: (r && r.posted) || 0, pendingApproval: (r && r.pendingApproval) || 0, errors: (r && r.errors) || 0, postedIds: (r && r.postedIds) || [], dealtIds: (r && r.dealtIds) || [], flag: (r && r.flag) || null, offline: (r && r.offline) || false };
          this._progress.accountsDone++;
          this._progress.posted += res.posted;
          this._progress.errors += res.errors;
          this._progress.pending += res.pendingApproval;
          // Per-account run totals for the end-of-run summary.
          const st = (this._runStats[account.name] = this._runStats[account.name] || { posted: 0, pending: 0, errors: 0 });
          st.posted += res.posted; st.pending += res.pendingApproval; st.errors += res.errors;
          this.emit('automation-progress', { ...this._progress });
          return res;
        }));
        const batchOk = results.filter((r) => r.progressed).length;
        this.log(`--- Batch ${b + 1} done (${batchOk}/${batch.length} OK) --- Waiting ${Number.isFinite(settings.accountDelay) ? settings.accountDelay : 1} minute(s) before next batch...`);
        for (const r of results) { cyclePostedIds.push(...r.postedIds); cycleDealtIds.push(...r.dealtIds); if (r.flag) cycleFlags.push(r.flag); }
        // Persist dealt-ids incrementally (after each batch) so a crash mid-cycle can't
        // re-deal — and thus potentially re-post — the batches already completed.
        if (cycleDealtIds.length) { try { store.saveRotation({ dealt: [...new Set([...this._dealt, ...cycleDealtIds])], roundOffset: this._roundOffset || 0 }); } catch {} }
        // Connection lost mid-batch (a worker bailed fast on offline): HOLD the whole run
        // until the connection returns, then continue. Un-posted posts stay un-dealt → re-run.
        if (results.some((r) => r.offline) && !this._shouldStop()) {
          this.log('🌐 Connection lost mid-batch — holding until it returns...');
          await this._waitForConnectivity();
        }
        if (this._finish) break;
        if (b < batches.length - 1 && !this._shouldStop()) {
          await this._waitWithCountdown((Number.isFinite(settings.accountDelay) ? settings.accountDelay : 1) * 60000, 'Next batch');
        }
      }
      // Mark this cycle's published posts as DEALT (drives the round-robin: each post once;
      // a failed account's post stays un-dealt and is re-dealt next cycle). Persisted for resume.
      if (cycleDealtIds.length) {
        for (const id of cycleDealtIds) this._dealt.add(id);
        try { store.saveRotation({ dealt: [...this._dealt], roundOffset: this._roundOffset || 0 }); } catch {}
      }
      if (this._shouldStop()) break;

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
      if (cycleDealtIds.length === 0 && (cycleFlags.includes('needs_login') || cycleFlags.includes('account_disabled') || cycleFlags.includes('needs_verification'))) {
        this.log('🛑 No account could post this cycle — accounts need attention (logged out, disabled, or identity-verification required). Stopping. Fix the flagged accounts, then Start again.');
        break;
      }
      if ((settings.maxCycles || 0) > 0 && cycle >= settings.maxCycles) {
        this.log(`🏁 Reached maxCycles (${settings.maxCycles}) — finishing.`); break;
      }
      this.log(`✅ Cycle ${cycle} complete. Waiting ${Number.isFinite(settings.waitInterval) ? settings.waitInterval : 60} min before next cycle…`);
      await this._waitWithCountdown((Number.isFinite(settings.waitInterval) ? settings.waitInterval : 60) * 60000, 'Next cycle');
    }
  }

  async _interruptibleSleep(ms) {
    const step = 1000; let waited = 0;
    while (waited < ms && !this._shouldStop()) { await sleep(Math.min(step, ms - waited)); waited += step; }
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

module.exports = { Orchestrator };
