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
    this._progress = { running: false, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0 };
  }
  isRunning() { return this.running; }
  stop() { this._stop = true; this._paused = false; }
  _shouldStop() { return this._stop; }
  pause() {
    if (!this.running || this._paused) return;
    this._paused = true;
    this.log('⏸ Paused — holding after the current batch');
    this.emit('automation-paused');
    this.emit('automation-progress', { ...this._progress, paused: this._paused });
  }
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this.log('▶️ Resumed');
    this.emit('automation-resumed');
    this.emit('automation-progress', { ...this._progress, paused: this._paused });
  }
  finish() {
    if (!this.running) return;
    this._finish = true;
    this.log('🏁 Finishing after the current batch — no new work will start');
  }
  isPaused() { return this._paused; }
  async _waitWhilePaused() { while (this._paused && !this._stop) await sleep(500); }
  log(msg) { this.emit('automation-log', msg); }

  async start(getData) {
    if (this.running) return { success: false, error: 'Automation already running' };
    this._stop = false; this._paused = false; this._finish = false; this.running = true;
    this._progress = { running: true, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0 };
    this.emit('automation-started');
    this.emit('automation-progress', { ...this._progress });
    this.log(`▶️ Automation started — ${new Date().toLocaleString()}`);
    this._loop(getData).catch((e) => this.log(`❌ Orchestrator crashed: ${e.message}`))
      .finally(() => {
        this.running = false;
        this._progress.running = false;
        this.emit('automation-progress', { ...this._progress });
        const reason = this._stop ? 'stopped' : (this._finish ? 'finished' : 'completed');
        this.emit('automation-stopped', reason);
        this.log(`⏹ Automation ${reason}.`);
      });
    return { success: true };
  }

  // Choose the posts a given account publishes this cycle.
  _postsForAccount(account, cycle) {
    const data = this._data;
    const filtered = data.posts.filter((p) => matchesFilter(p, account.postFilter || 'all'));
    if (!filtered.length) return [];
    const order = account.postingOrder || 'post-centric';
    const unique = order.includes('unique') || order === 'sequence';

    // Stable per-account offset (its position in the account list) so unique-mode
    // accounts pick DIFFERENT posts in the same cycle regardless of which accounts are
    // enabled — independent of the volatile active-list index.
    const offset = Math.max(0, data.accounts.findIndex((a) => a.name === account.name));

    let list = filtered;
    if (order.includes('random')) list = seededShuffle(filtered, (cycle + 1) * 7919 + offset * 31);

    if (!unique) return list; // post-centric / random -> all eligible posts

    // unique / sequence -> one post: base (this account's own rotation) advances each
    // cycle; offset gives cross-account diversity within a cycle.
    const base = (this._rotation[account.name] || 0);
    const pick = list[(((base + offset) % list.length) + list.length) % list.length];
    return pick ? [pick] : [];
  }

  // Returns { progressed, posted, pendingApproval, errors }. Rotation only advances
  // when progressed, so a fully-crashed account retries the SAME post next cycle.
  async _runAccount(account, cycle) {
    const data = this._data;
    const posts = this._postsForAccount(account, cycle);
    if (!posts.length) { this.log(`↪️ [${account.name}] no eligible posts`); return { progressed: false, posted: 0, pendingApproval: 0, errors: 0, postedIds: [] }; }
    const order = account.postingOrder || 'post-centric';
    const label = posts.length === 1 ? `Post #${data.posts.findIndex((p) => p.id === posts[0].id) + 1}` : `${posts.length} posts`;
    this.log(`📋 [${account.name}] ${order} → ${label} to ${(account.assignedGroups || []).length} group(s)`);
    let progressed = false, posted = 0, pendingApproval = 0, errors = 0;
    const postedIds = [];
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
          });
          posted += (r && r.posted) || 0; pendingApproval += (r && r.pendingApproval) || 0; errors += (r && r.errors) || 0;
          if (r && ((r.posted || 0) > 0 || (r.pendingApproval || 0) > 0)) { progressed = true; if (post.id) postedIds.push(post.id); }
          // Persist flag to account status so the UI shows it.
          if (r && r.flag) {
            try {
              const d = store.load(); const acc = d.accounts.find(a => a.name === account.name);
              if (acc) {
                if (r.flag === 'needs_login') { acc.status = 'not_logged_in'; acc.lastMessage = '⚠️ Logged out during run — re-login required'; }
                else if (r.flag === 'rate_limited') { acc.status = 'rate_limited'; acc.lastMessage = '⏸ Rate-limited by Facebook — backed off this cycle'; }
                store.save(d); this.emit('data-updated');
              }
            } catch {}
          }
          // Logged-out / rate-limited — don't launch a browser for this account's remaining posts this cycle.
          if (r && r.noRetry) { this.log(`⏭️ [${account.name}] skipping remaining posts this cycle (session/rate-limit)`); break postsLoop; }
          break;
        }
        catch (e) {
          errors++;
          this.log(`❌ [${account.name}] crashed (attempt ${attempt}/${MAX}): ${e.message}`);
          if (attempt >= MAX || this._shouldStop()) break;
          await sleep(5000);
        }
      }
    }
    // Surface the outcome so the operator sees pending/error counts in the log pane.
    this.log(`📊 [${account.name}] posted=${posted} pending=${pendingApproval} errors=${errors}`);
    return { progressed, posted, pendingApproval, errors, postedIds };
  }

  async _loop(getData) {
    this._rotation = store.loadRotation();
    let cycle = 0;
    while (!this._shouldStop()) {
      this._data = getData(); // re-read each cycle so mid-run edits take effect
      const { posts, accounts, settings } = this._data;
      if (!posts.length) { this.log('⚠️ No posts configured — stopping.'); break; }
      const active = accounts.filter((a) => a.enabled !== false);
      if (!active.length) { this.log('⚠️ No enabled accounts — stopping.'); break; }

      cycle++;
      this._progress.cycle = cycle;
      this._progress.accountsTotal = active.length;
      this._progress.accountsDone = 0;
      this.emit('automation-progress', { ...this._progress, paused: this._paused });
      this.log(`🔄 Cycle ${cycle}: ${active.length} account(s), ${settings.parallelAccounts || 3} in parallel`);

      await this._waitWhilePaused(); if (this._shouldStop()) break;

      const batches = chunk(active, settings.parallelAccounts || 3);
      const cyclePostedIds = [];
      for (let b = 0; b < batches.length; b++) {
        if (this._shouldStop()) break;
        await this._waitWhilePaused(); if (this._shouldStop()) break;
        const batch = batches[b];
        this.log(`═══ Batch ${b + 1}/${batches.length} — ${new Date().toLocaleTimeString()} — ${batch.map((a) => a.name).join(', ')} ═══`);
        const results = await Promise.all(batch.map(async (account) => {
          const r = await this._runAccount(account, cycle)
            .catch((e) => { this.log(`❌ [${account.name}] supervisor caught: ${e.message}`); return { progressed: false, posted: 0, pendingApproval: 0, errors: 1, postedIds: [] }; });
          this.log(`✓ [${account.name}] completed`);
          const res = { account, progressed: !!(r && r.progressed), posted: (r && r.posted) || 0, pendingApproval: (r && r.pendingApproval) || 0, errors: (r && r.errors) || 0, postedIds: (r && r.postedIds) || [] };
          this._progress.accountsDone++;
          this._progress.posted += res.posted;
          this._progress.errors += res.errors;
          this._progress.pending += res.pendingApproval;
          this.emit('automation-progress', { ...this._progress, paused: this._paused });
          return res;
        }));
        const batchOk = results.filter((r) => r.progressed).length;
        this.log(`--- Batch ${b + 1} done (${batchOk}/${batch.length} OK) ---`);
        for (const r of results) cyclePostedIds.push(...r.postedIds);
        // Advance + persist rotation for THIS batch's unique/sequence accounts that made
        // progress (mid-cycle durable). SKIPPED when autoDeletePosted is on: deletion shrinks
        // the library each cycle, which already advances the window — advancing the base too
        // would skip posts. Non-unique accounts don't consume rotation slots.
        if (!settings.autoDeletePosted) {
          let rotationDirty = false;
          for (const { account, progressed } of results) {
            const ord = account.postingOrder || 'post-centric';
            if (progressed && (ord.includes('unique') || ord === 'sequence')) {
              this._rotation[account.name] = (this._rotation[account.name] || 0) + 1;
              rotationDirty = true;
            }
          }
          if (rotationDirty) store.saveRotation(this._rotation);
        }
        if (this._finish) break;
        if (b < batches.length - 1 && !this._shouldStop()) {
          this.log(`⏳ Waiting ${settings.accountDelay || 1} min before next batch…`);
          await this._interruptibleSleep((settings.accountDelay || 1) * 60000);
        }
      }
      if (this._shouldStop()) break;

      // One-time campaign: remove the posts published this cycle so each post is used
      // exactly once (and the run ends when the library empties). Backend-owned so it's
      // reliable regardless of the UI; replaces the old renderer log-parsing on stop.
      if (settings.autoDeletePosted && cyclePostedIds.length) {
        const del = new Set(cyclePostedIds);
        const data = getData();
        const before = data.posts.length;
        data.posts = data.posts.filter((p) => !del.has(p.id));
        store.save(data);
        this.emit('data-updated');
        this.log(`🗑️ Auto-deleted ${before - data.posts.length} posted post(s) — ${data.posts.length} remaining`);
      }

      if (this._shouldStop() || this._finish) break;
      if ((settings.maxCycles || 0) > 0 && cycle >= settings.maxCycles) {
        this.log(`🏁 Reached maxCycles (${settings.maxCycles}) — finishing.`); break;
      }
      this.log(`✅ Cycle ${cycle} complete. Waiting ${settings.waitInterval || 60} min before next cycle…`);
      await this._interruptibleSleep((settings.waitInterval || 60) * 60000);
    }
  }

  async _interruptibleSleep(ms) {
    const step = 1000; let waited = 0;
    while (waited < ms && !this._shouldStop()) { await sleep(Math.min(step, ms - waited)); waited += step; }
  }
}

module.exports = { Orchestrator };
