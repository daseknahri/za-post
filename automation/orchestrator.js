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
  constructor(emit) {
    this.emit = emit;
    this.running = false;
    this._stop = false;
  }
  isRunning() { return this.running; }
  stop() { this._stop = true; }
  _shouldStop() { return this._stop; }
  log(msg) { this.emit('automation-log', msg); }

  async start(getData) {
    if (this.running) return { success: false, error: 'Automation already running' };
    this._stop = false; this.running = true;
    this.emit('automation-started');
    this.log(`▶️ Automation started — ${new Date().toLocaleString()}`);
    this._loop(getData).catch((e) => this.log(`❌ Orchestrator crashed: ${e.message}`))
      .finally(() => {
        this.running = false;
        this.emit('automation-stopped', this._stop ? 'stopped' : 'completed');
        this.log(`⏹ Automation ${this._stop ? 'stopped' : 'finished'}.`);
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
    let progressed = false, posted = 0, pendingApproval = 0, errors = 0;
    const postedIds = [];
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
          });
          posted += (r && r.posted) || 0; pendingApproval += (r && r.pendingApproval) || 0; errors += (r && r.errors) || 0;
          if (r && ((r.posted || 0) > 0 || (r.pendingApproval || 0) > 0)) { progressed = true; if (post.id) postedIds.push(post.id); }
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
      this.log(`🔄 Cycle ${cycle}: ${active.length} account(s), ${settings.parallelAccounts || 3} in parallel`);

      const batches = chunk(active, settings.parallelAccounts || 3);
      const cyclePostedIds = [];
      for (let b = 0; b < batches.length; b++) {
        if (this._shouldStop()) break;
        const batch = batches[b];
        this.log(`👥 Batch ${b + 1}/${batches.length}: ${batch.map((a) => a.name).join(', ')}`);
        const results = await Promise.all(batch.map(async (account) => {
          const r = await this._runAccount(account, cycle)
            .catch((e) => { this.log(`❌ [${account.name}] supervisor caught: ${e.message}`); return { progressed: false, postedIds: [] }; });
          return { account, progressed: !!(r && r.progressed), postedIds: (r && r.postedIds) || [] };
        }));
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
        if (b < batches.length - 1 && !this._shouldStop()) {
          this.log(`⏳ Waiting ${settings.accountDelay || 1} min before next batch…`);
          await this._interruptibleSleep((settings.accountDelay || 1) * 60000);
        }
      }

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

      if (this._shouldStop()) break;
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
