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

async function isOnline() {
  if (!axios) return true;
  const urls = ['https://connectivitycheck.gstatic.com/generate_204', 'https://www.facebook.com'];
  for (const url of urls) {
    try {
      await axios.get(url, { timeout: 8000, validateStatus: () => true, maxRedirects: 1 });
      return true;
    } catch {}
  }
  return false;
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
    this._progress = { running: true, cycle: 0, posted: 0, errors: 0, pending: 0, accountsDone: 0, accountsTotal: 0, offline: false };
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

    if (!unique) {
      // post-centric / random -> account posts ALL its eligible posts each cycle.
      return order.includes('random') ? seededShuffle(filtered, (cycle + 1) * 7919) : filtered;
    }

    // UNIQUE / SEQUENCE -> deal each post exactly ONCE across the active accounts, round-robin.
    // `remaining` = posts not yet dealt; the account at active-index k takes remaining[k].
    // No wrap: if fewer posts remain than accounts, the higher-index accounts post nothing
    // (so when posts < accounts, only that many accounts post and the campaign then completes).
    let remaining = filtered.filter((p) => !this._dealt.has(p.id));
    if (!remaining.length) return [];
    if (order.includes('random')) remaining = seededShuffle(remaining, (cycle + 1) * 7919); // randomized deal order (consistent within the cycle)
    const activeList = this._active || data.accounts.filter((a) => a.enabled !== false);
    const i = activeList.findIndex((a) => a.name === account.name);
    if (i < 0) return [];
    // roundOffset rotates which account gets which post across Loop-campaign recycles, so an
    // account posts different content over time. It's a rotation (permutation) -> no wrap/dup.
    const k = (i + (this._roundOffset || 0)) % activeList.length;
    if (k >= remaining.length) return []; // this account's turn hasn't come up this cycle
    return [remaining[k]];
  }

  // Returns { progressed, posted, pendingApproval, errors }. Rotation only advances
  // when progressed, so a fully-crashed account retries the SAME post next cycle.
  async _runAccount(account, cycle) {
    const data = this._data;
    const posts = this._postsForAccount(account, cycle);
    if (!posts.length) { this.log(`↪️ [${account.name}] no eligible posts`); return { progressed: false, posted: 0, pendingApproval: 0, errors: 0, postedIds: [] }; }
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
    this.log(`[${account.name}] ✅ Done: ${posted} posts`);
    this.log(`📊 [${account.name}] posted=${posted} pending=${pendingApproval} errors=${errors}`);
    return { progressed, posted, pendingApproval, errors, postedIds };
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
      this.emit('automation-progress', { ...this._progress, paused: this._paused });

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
      const cyclePostedIds = [];
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
            .catch((e) => { this.log(`❌ [${account.name}] supervisor caught: ${e.message}`); return { progressed: false, posted: 0, pendingApproval: 0, errors: 1, postedIds: [] }; });
          this.log(`✓ [${account.name}] Completed`);
          const res = { account, progressed: !!(r && r.progressed), posted: (r && r.posted) || 0, pendingApproval: (r && r.pendingApproval) || 0, errors: (r && r.errors) || 0, postedIds: (r && r.postedIds) || [] };
          this._progress.accountsDone++;
          this._progress.posted += res.posted;
          this._progress.errors += res.errors;
          this._progress.pending += res.pendingApproval;
          this.emit('automation-progress', { ...this._progress, paused: this._paused });
          return res;
        }));
        const batchOk = results.filter((r) => r.progressed).length;
        this.log(`--- Batch ${b + 1} done (${batchOk}/${batch.length} OK) --- Waiting ${settings.accountDelay || 1} minute(s) before next batch...`);
        for (const r of results) cyclePostedIds.push(...r.postedIds);
        if (this._finish) break;
        if (b < batches.length - 1 && !this._shouldStop()) {
          await this._waitWithCountdown((settings.accountDelay || 1) * 60000, 'Next batch');
        }
      }
      // Mark this cycle's published posts as DEALT (drives the round-robin: each post once;
      // a failed account's post stays un-dealt and is re-dealt next cycle). Persisted for resume.
      if (cyclePostedIds.length) {
        for (const id of cyclePostedIds) this._dealt.add(id);
        try { store.saveRotation({ dealt: [...this._dealt], roundOffset: this._roundOffset || 0 }); } catch {}
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
      await this._waitWithCountdown((settings.waitInterval || 60) * 60000, 'Next cycle');
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
    const end = Date.now() + ms;
    let lastLog = 0;
    const fmt = (sec) => { const m = Math.floor(sec / 60), s = sec % 60; return (m > 0 ? m + 'm ' : '') + s + 's'; };
    while (Date.now() < end && !this._shouldStop()) {
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
