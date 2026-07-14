'use strict';
// lib/plan.js — builds the NORMALIZED day-by-day campaign plan + progress overlay that the dashboard shows.
//
// Computed in the MAIN process (not the renderer) from PERSISTED state only — so it survives the wizard closing,
// matches what the engine actually does, and reflects real delivered progress:
//   • posts/accounts/groups/settings   → the configured campaign
//   • rotation (pcu-state.json)         → each agent's pointer (which post it posts next / posted today)
//   • progress ledger (daily-progress)  → what was actually delivered, per LOCAL day (the "done" truth)
//
// Output is a flat, render-ready list of DAYS (past → today → future). Past days come from the ledger (what truly
// happened); today + future are FORECAST from the rotation pointers, with today's forecast overlaid with the
// ledger so half-done days show correctly. The renderer just navigates `days` and draws the selected one.

const PAST_WINDOW = 14;   // how many past days (from the ledger) to expose for back-navigation
const FUTURE_CAP = 999;   // effectively unlimited — show the WHOLE campaign forecast (naturally bounded by library size)

function pad(n) { return String(n).padStart(2, '0'); }
// LOCAL calendar-day key — MUST match orchestrator._localDayKey (the engine's "one per day" boundary is local).
function localDayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// dayKey (YYYY-MM-DD) → a friendly label relative to today.
function dayLabel(dayKey, todayKey) {
  const [y, m, dd] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, dd);
  const diff = Math.round((date - new Date(todayKey.split('-')[0], todayKey.split('-')[1] - 1, todayKey.split('-')[2])) / 86400000);
  let rel = '';
  if (diff === 0) rel = 'Today'; else if (diff === 1) rel = 'Tomorrow'; else if (diff === -1) rel = 'Yesterday';
  let nice = dayKey;
  try { nice = date.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }); } catch {}
  return rel ? `${rel} · ${nice}` : nice;
}
function addDays(dayKey, n) {
  const [y, m, dd] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, dd + n);
  return localDayKey(date);
}

function buildPlan(input) {
  const posts = (input.posts || []);
  const accounts = (input.accounts || []);
  const groups = (input.groups || []);
  const settings = (input.settings || {});
  const rotation = (input.rotation || {});
  const progress = (input.progress && input.progress.days) || {};
  const todayKey = input.todayKey || localDayKey(new Date());

  const groupName = (id) => { const g = groups.find((x) => x && x.id === id); return (g && (g.name || g.id)) || id; };
  // assignedGroups holds the APP id (group-…); the ledger + engine key by the FACEBOOK id (groupId). Map app→FB
  // so the progress overlay matches. `grp(appId)` → { id (app), gid (FB, for ledger matching), name }.
  const groupGid = (id) => { const g = groups.find((x) => x && x.id === id); return (g && (g.groupId || g.id)) || id; };
  const grp = (id) => ({ id, gid: groupGid(id), name: groupName(id) });
  const snippet = (p) => { const c = String((p && p.caption) || '').replace(/\s+/g, ' ').trim(); return c.length > 48 ? c.slice(0, 48) + '…' : (c || '(no caption)'); };
  const posters = accounts.filter((a) => a && !a.isModerator);
  const method = pickMethod(posters, settings);

  // CAMPAIGN-PLAN → a CYCLE-indexed view (not calendar-day): each account posts its next slice-post once per cycle,
  // so "Cycle 1" = every account's 1st slice-post, "Cycle 2" the 2nd, etc. Delivered cycles come straight from the
  // ledger (tagged with the round + slice position at delivery), so they persist across restarts and don't collapse
  // when several cycles run in one day or the pointer resets after a round. Reset each round (only the CURRENT
  // round's deliveries fill in; a new round starts fresh). Other methods keep the calendar-day view below.
  if (method === 'campaign-plan') {
    const cyc = campaignCycleDays(posters, posts, rotation, progress, grp, snippet);
    return {
      method, ongoing: !settings.completionMode, todayKey,
      cycleDays: cyc.cycleDays, daysWithProgress: Object.keys(progress).length,
      totals: lifetimeTotals(progress), todayIndex: cyc.todayIndex, days: cyc.days,
      message: cyc.days.length ? '' : 'No campaign plan yet — assign groups to your campaign-plan accounts and add posts, then run.',
    };
  }

  // ---- PAST days: straight from the ledger (what actually happened) ----------------------------------------
  const numById = new Map(posts.map((p, i) => [p.id, i + 1])); // resolve the post # the ledger doesn't store
  const pastKeys = Object.keys(progress).filter((k) => k < todayKey).sort().slice(-PAST_WINDOW);
  const pastDays = pastKeys.map((k) => ({ dayKey: k, offset: dayOffset(k, todayKey), label: dayLabel(k, todayKey), when: 'past', ...ledgerDay(progress[k], groupName, numById) }));

  // ---- TODAY + FUTURE: forecast from rotation pointers ------------------------------------------------------
  let cycleDays = 0, forecast = [];
  if (method === 'daily-rotation') ({ cycleDays, forecast } = forecastDailyRotation(posters, posts, rotation, todayKey, grp, snippet));
  else if (method === 'campaign-plan') ({ cycleDays, forecast } = forecastCampaign(posters, posts, rotation, todayKey, grp, snippet));
  else if (method === 'sequence') ({ cycleDays, forecast } = forecastSequence(posters, posts, rotation, todayKey, grp, snippet));
  // post-centric / none → no finite forecast (handled by `message` below)

  // TODAY: the LEDGER is the delivered truth. Rendering today from the forecast (the pointer's NEXT post) overlaid
  // with the ledger breaks under cyclesPerDay>1: an account delivers SEVERAL posts in one calendar day, and a campaign
  // round that finishes same-day RESETS the pointer (lastPostId→null) for the next round — so the forecast shows a
  // fresh post #1 the ledger (holding the delivered posts) can't match, and today's delivered progress "disappears".
  // Fix: build today's rows from the ledger (every post actually delivered today), expanded to each account's FULL
  // assigned groups so partial/held/owed cells still render; append the forecast ONLY for accounts that have not posted
  // today yet (genuinely pending). Future days (offset ≥1) stay pure forecast; the forecast→offset mapping is unchanged.
  const acctByName = new Map(posters.map((a) => [a.name, a]));
  const expandDelivered = (r) => {
    const acct = acctByName.get(r.account);
    const assigned = (acct && acct.assignedGroups) || [];
    if (!assigned.length) return r; // no config to expand against → show the ledger row as-is
    const ledStatus = new Map((r.groups || []).map((g) => [String(g.id), g.status])); // ledgerDay keys group.id by FB gid
    const groups = assigned.map((appId) => { const gg = grp(appId); return { ...gg, status: ledStatus.get(String(gg.gid)) || 'today' }; }); // undelivered group on TODAY's row = pending NOW ('today'), matching overlayRow's convention (not 'upcoming', which means a future day)
    const groupsDone = groups.filter((g) => g.status === 'done').length;
    const anyHeld = groups.some((g) => g.status === 'held');
    const status = groupsDone === groups.length ? 'done' : anyHeld ? 'held' : groupsDone > 0 ? 'partial' : 'today';
    return { ...r, groups, groupsDone, groupsTotal: groups.length, status };
  };
  const todayLedger = progress[todayKey] ? ledgerIndex(progress[todayKey]) : null;
  const todayLedgerRows = progress[todayKey] ? ledgerDay(progress[todayKey], groupName, numById).rows.map(expandDelivered) : [];
  const postedAccts = new Set(todayLedgerRows.map((r) => r.account));
  const todayPending = (forecast[0] ? forecast[0].rows : []).filter((r) => !postedAccts.has(r.account)).map((r) => (todayLedger ? overlayRow(r, todayLedger) : r));
  const futureDays = [];
  const todayRows = [...todayLedgerRows, ...todayPending];
  if (todayRows.length) futureDays.push({ dayKey: todayKey, offset: 0, label: dayLabel(todayKey, todayKey), when: 'today', rows: todayRows, plannedPosts: todayRows.length });
  for (let i = 1; i < forecast.length; i++) {
    futureDays.push({ dayKey: addDays(todayKey, i), offset: i, label: dayLabel(addDays(todayKey, i), todayKey), when: 'future', rows: forecast[i].rows, plannedPosts: forecast[i].rows.length });
  }

  const days = [...pastDays, ...futureDays];
  // Totals across the whole ledger (lifetime delivered).
  const totals = lifetimeTotals(progress);

  return {
    method,
    ongoing: !settings.completionMode, // completionMode → stops+reports when done; else loops/continues
    todayKey,
    cycleDays,
    daysWithProgress: Object.keys(progress).length,
    totals,
    todayIndex: days.findIndex((d) => d.offset === 0), // where the renderer should default
    days,
    message: method === 'post-centric'
      ? 'Post-to-All mode posts every post to every group each cycle — it runs continuously, with no fixed day-by-day plan.'
      : (!days.length ? 'No plan yet — add posts and assign groups to your accounts, then run.' : ''),
  };
}

function dayOffset(dayKey, todayKey) {
  const a = new Date(...dayKey.split('-').map((n, i) => i === 1 ? n - 1 : +n));
  const b = new Date(...todayKey.split('-').map((n, i) => i === 1 ? n - 1 : +n));
  return Math.round((a - b) / 86400000);
}

// Mirror orchestrator.matchesFilter — an account's postFilter narrows which library posts it actually uses.
function matchesFilter(post, filter) {
  if (filter === 'with-comments') return !!(post && post.comment && String(post.comment).trim());
  if (filter === 'without-comments') return !(post && post.comment && String(post.comment).trim());
  return true;
}

function pickMethod(posters, settings) {
  const active = posters.filter((a) => a.enabled !== false && !a.standby);
  const orders = new Set(active.map((a) => a.postingOrder || 'post-centric'));
  if (orders.has('campaign-plan')) return 'campaign-plan';
  if (orders.has('daily-rotation')) return 'daily-rotation';
  if ([...orders].some((o) => o === 'sequence' || String(o).includes('unique'))) return 'sequence';
  if (active.length) return 'post-centric';
  return 'none';
}

// Active, group-bearing posters for the day-based methods (mirror the engine's eligibility, minus live health).
function activePosters(posters, order) {
  return posters.filter((a) => a.enabled !== false && !a.standby && (a.postingOrder === order || (order === 'sequence' && (a.postingOrder === 'sequence' || String(a.postingOrder || '').includes('unique')))) && (a.assignedGroups || []).length);
}

function rowFor(a, post, grp) {
  const gids = a.assignedGroups || [];
  return {
    account: a.name, alias: a.alias || a.name,
    postId: post ? post.id : null, postNum: post ? post._num : null, caption: post ? post._snip : '(idle)',
    groups: gids.map((id) => ({ ...grp(id), status: 'planned' })), // { id(app), gid(FB), name }
    groupsTotal: gids.length, groupsDone: 0, status: 'upcoming',
  };
}

function forecastDailyRotation(posters, posts, rotation, todayKey, grp, snippet) {
  const active = activePosters(posters, 'daily-rotation');
  const per = rotation.perAccountRotation || {};
  if (!posts.length || !active.length) return { cycleDays: 0, forecast: [] };
  const numById = new Map(posts.map((p, i) => [p.id, i + 1]));
  // Each account rotates its OWN postFilter-narrowed list (mirror engine matchesFilter), so lengths can differ.
  const listByAcct = {}, todayIdxByAcct = {};
  let maxP = 0;
  for (const a of active) {
    const list = posts.filter((p) => matchesFilter(p, a.postFilter)).map((p) => ({ id: p.id, _num: numById.get(p.id), _snip: snippet(p) }));
    listByAcct[a.name] = list;
    const Pa = list.length;
    if (!Pa) { todayIdxByAcct[a.name] = -1; continue; }
    const rot = per[a.name] || {};
    const cur = rot.lastPostId ? list.findIndex((p) => p.id === rot.lastPostId) : -1;
    const postedToday = rot.lastPostedDate === todayKey;
    todayIdxByAcct[a.name] = postedToday ? (cur < 0 ? 0 : cur) : (cur < 0 ? 0 : (cur + 1) % Pa);
    maxP = Math.max(maxP, Pa);
  }
  const days = Math.min(maxP, FUTURE_CAP);
  const forecast = [];
  for (let d = 0; d < days; d++) {
    const rows = active.map((a) => {
      const list = listByAcct[a.name], ti = todayIdxByAcct[a.name];
      return rowFor(a, (ti >= 0 && list.length) ? list[(ti + d) % list.length] : null, grp);
    });
    forecast.push({ rows });
  }
  return { cycleDays: maxP, forecast };
}

// Mirror orchestrator._computeCampaignPlan: cluster agents by identical sorted assignedGroups, then within each
// cluster of K agents, agent j takes the posts at idx%K === (j+roundOffset)%K. Lets the dashboard PREVIEW the
// campaign plan from config BEFORE the first run has persisted an agentLists.
function computeCampaignAgentLists(active, posts, roundOffset = 0) {
  const clusters = new Map();
  for (const a of active) { const k = (a.assignedGroups || []).slice().sort().join('|'); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(a); }
  const out = {};
  for (const [, ag] of clusters) { const K = ag.length; ag.forEach((a, j) => { const slot = (j + roundOffset) % K; out[a.name] = posts.filter((_, idx) => idx % K === slot).map((p) => p.id); }); }
  // SPREAD TO MAX DURATION (mirror of orchestrator._computeCampaignPlan): faster clusters span the slowest
  // cluster's day-count using only Keff agents (active subset rotates by roundOffset) so no cluster idles.
  const globalMaxLen = Math.max(0, ...Object.values(out).map((l) => l.length));
  if (globalMaxLen > 0) {
    for (const [, ag] of clusters) {
      const K = ag.length;
      const curLen = Math.max(0, ...ag.map((a) => out[a.name].length));
      if (curLen >= globalMaxLen) continue;
      const Keff = Math.max(1, Math.min(K, Math.ceil(posts.length / globalMaxLen)));
      const shift = ((roundOffset % K) + K) % K;
      ag.forEach((a, j) => { const rank = (((j - shift) % K) + K) % K; out[a.name] = rank < Keff ? posts.filter((_, idx) => idx % Keff === rank).map((p) => p.id) : []; });
    }
  }
  return out;
}
function forecastCampaign(posters, posts, rotation, todayKey, grp, snippet) {
  const cp = rotation.campaignPlan;
  const per = rotation.perAccountRotation || {};
  const byId = new Map(posts.map((p, i) => [p.id, { id: p.id, _num: i + 1, _snip: snippet(p) }]));
  const acctByName = new Map(posters.map((a) => [a.name, a]));
  // Prefer the engine's persisted plan (carries live pointers); else compute the same interleave from config.
  const agentLists = (cp && cp.agentLists) ? cp.agentLists : computeCampaignAgentLists(activePosters(posters, 'campaign-plan'), posts, (cp && cp.roundOffset) || 0);
  if (!agentLists || !Object.keys(agentLists).length) return { cycleDays: 0, forecast: [] };
  const names = Object.keys(agentLists).filter((n) => acctByName.has(n));
  if (!names.length) return { cycleDays: 0, forecast: [] };
  // Mirror engine _campaignNextIdx: SKIP OVER deleted ids (advance the index, don't waste a day). Work on a
  // DENSE list of still-existing ids per agent so a mid-list deletion doesn't desync the day→post mapping.
  const denseByName = {}, startPos = {};
  for (const n of names) {
    const orig = agentLists[n] || [];
    const dense = orig.filter((id) => byId.has(id));
    denseByName[n] = dense;
    const rot = per[n] || {};
    let pos;
    if (rot.lastPostId && byId.has(rot.lastPostId)) { const cur = dense.indexOf(rot.lastPostId); pos = (rot.lastPostedDate === todayKey) ? cur : cur + 1; }
    else if (rot.lastPostId) { const oi = orig.indexOf(rot.lastPostId); pos = oi < 0 ? 0 : orig.slice(0, oi + 1).filter((id) => byId.has(id)).length; } // deleted lastPostId → next existing
    else pos = 0; // never posted
    startPos[n] = pos;
  }
  const days = Math.min(Math.max(0, ...names.map((n) => denseByName[n].length - startPos[n])), FUTURE_CAP);
  const forecast = [];
  for (let d = 0; d < days; d++) {
    const rows = [];
    for (const n of names) {
      const dense = denseByName[n]; const pos = startPos[n] + d;
      if (pos < 0 || pos >= dense.length) continue; // this agent is done
      const post = byId.get(dense[pos]); if (!post) continue;
      rows.push(rowFor(acctByName.get(n), post, grp));
    }
    if (rows.length) forecast.push({ rows });
  }
  return { cycleDays: forecast.length, forecast };
}

function forecastSequence(posters, posts, rotation, todayKey, grp, snippet) {
  const active = activePosters(posters, 'sequence');
  const M = active.length;
  if (!M) return { cycleDays: 0, forecast: [] };
  const dealt = new Set(rotation.dealt || []);
  const numById = new Map(posts.map((p, i) => [p.id, i + 1]));
  // Apply the (typically uniform) post filter to the shared pool. Mixed per-account filters in sequence are a
  // documented best-effort gap (the row account→post pairing is already approximate vs the engine's deal).
  const filt = active[0].postFilter || 'all';
  const remaining = posts.filter((p) => matchesFilter(p, filt) && !dealt.has(p.id)).map((p) => ({ id: p.id, _num: numById.get(p.id), _snip: snippet(p) }));
  if (!remaining.length) return { cycleDays: 0, forecast: [] };
  const days = Math.min(Math.ceil(remaining.length / M), FUTURE_CAP);
  const forecast = [];
  for (let d = 0; d < days; d++) {
    const rows = [];
    for (let i = 0; i < M; i++) { const post = remaining[d * M + i]; if (post) rows.push(rowFor(active[i], post, grp)); }
    if (rows.length) forecast.push({ rows });
  }
  return { cycleDays: Math.ceil(remaining.length / M), forecast };
}

// CAMPAIGN CYCLE view: one entry per posting CYCLE, not per calendar day. Delivered cells come from the ledger items
// tagged { round, cycle } at delivery, grouped by their recorded CYCLE (so they survive the pointer reset + agentList
// reshuffle when a round completes). A just-completed round STAYS visible until the NEXT round actually starts posting
// — the view follows the most-recently-delivered round, and only flips forward when the new round's first post lands
// ("keep the record until it resets"). Forecast (upcoming cycles) is drawn from the live agentLists only while the
// round being shown IS the current one. Reset happens per round; Start Over clears the ledger entirely.
function campaignCycleDays(posters, posts, rotation, progress, grp, snippet) {
  const cp = rotation.campaignPlan;
  const roundOffset = Number(rotation.roundOffset != null ? rotation.roundOffset : (cp && cp.roundOffset)) || 0;
  const numById = new Map(posts.map((p, i) => [p.id, i + 1]));
  const byId = new Map(posts.map((p, i) => [p.id, { id: p.id, _num: i + 1, _snip: snippet(p) }]));
  const acctByName = new Map(posters.map((a) => [a.name, a]));

  // PASS 1 (scan only, no per-item allocation): find the highest delivered round + whether the current round has any
  // delivery. Avoids building maps for rounds we'll never show, so a long-lived ledger stays cheap.
  let maxLedgerRound = -1, roundOffsetDelivered = false;
  for (const dk of Object.keys(progress)) {
    const items = (progress[dk] && progress[dk].items) || {};
    for (const k of Object.keys(items)) {
      const it = items[k]; if (!Number(it.cycle)) continue; // untagged legacy delivery → can't place in a cycle (lifetime totals still count it)
      const r = Number(it.round) || 0;
      if (r > maxLedgerRound) maxLedgerRound = r;
      if (r === roundOffset) roundOffsetDelivered = true;
    }
  }
  // View the current round if it already has deliveries; else the most recent delivered round (so a just-completed
  // round lingers until the new round's first post). Forecast only when the viewed round is the live one.
  const viewRound = roundOffsetDelivered ? roundOffset : (maxLedgerRound >= 0 ? maxLedgerRound : roundOffset);
  const isCurrent = viewRound === roundOffset;
  // PASS 2: build the cycle map for ONLY the viewed round → memory bounded to one round, not the whole history.
  const delivered = {}; // cycle -> { "account|postId" -> Map(FB gid -> status) }
  for (const dk of Object.keys(progress)) {
    const items = (progress[dk] && progress[dk].items) || {};
    for (const k of Object.keys(items)) {
      const it = items[k]; const c = Number(it.cycle) || 0;
      if (!c || (Number(it.round) || 0) !== viewRound) continue;
      const cy = (delivered[c] || (delivered[c] = {}));
      const rk = `${it.account}|${it.postId}`;
      (cy[rk] || (cy[rk] = new Map())).set(String(it.groupId), it.status);
    }
  }

  // A delivered row, expanded to the account's full assigned groups (undelivered ones pending 'today').
  const deliveredRow = (rk, gmap) => {
    const [account, postId] = rk.split('|');
    const acct = acctByName.get(account) || { assignedGroups: [] };
    const groups = (acct.assignedGroups || []).map((appId) => { const gg = grp(appId); return { ...gg, status: gmap.get(String(gg.gid)) || 'today' }; });
    const gd = groups.filter((g) => g.status === 'done').length, hh = groups.some((g) => g.status === 'held');
    const status = groups.length && gd === groups.length ? 'done' : hh ? 'held' : gd > 0 ? 'partial' : 'today';
    return { account, alias: acct.alias || account, postId, postNum: numById.get(postId), caption: (byId.get(postId) || {})._snip || '', groups, groupsTotal: groups.length, groupsDone: gd, status };
  };

  let maxCycle = Object.keys(delivered).reduce((m, c) => Math.max(m, Number(c)), 0);
  const forecastByCycle = {};
  if (isCurrent) { // draw upcoming cycles for the LIVE round from the agentLists + pointer
    const active = activePosters(posters, 'campaign-plan');
    const agentLists = (cp && cp.agentLists) ? cp.agentLists : computeCampaignAgentLists(active, posts, roundOffset);
    const per = rotation.perAccountRotation || {};
    for (const n of Object.keys(agentLists || {}).filter((x) => acctByName.has(x))) {
      const dense = (agentLists[n] || []).filter((id) => byId.has(id));
      const rot = per[n] || {};
      const delCount = (rot.lastPostId && dense.indexOf(rot.lastPostId) >= 0) ? dense.indexOf(rot.lastPostId) + 1 : 0;
      const acct = acctByName.get(n), assigned = acct.assignedGroups || [];
      for (let d = 0; d < dense.length; d++) {
        const cyc = d + 1, postId = dense[d];
        if (delivered[cyc] && delivered[cyc][`${n}|${postId}`]) continue; // already in the ledger → the delivered row wins
        const past = d < delCount; // pointer advanced past it (delivered, no per-group ledger detail)
        const groups = assigned.map((appId) => ({ ...grp(appId), status: past ? 'done' : 'upcoming' }));
        (forecastByCycle[cyc] || (forecastByCycle[cyc] = [])).push({ account: n, alias: acct.alias || n, postId, postNum: numById.get(postId), caption: (byId.get(postId) || {})._snip || '', groups, groupsTotal: groups.length, groupsDone: past ? groups.length : 0, status: past ? 'done' : 'upcoming' });
        maxCycle = Math.max(maxCycle, cyc);
      }
    }
  }
  if (!maxCycle) return { days: [], cycleDays: 0, todayIndex: 0 };

  const days = [];
  for (let c = 1; c <= maxCycle; c++) {
    const rows = [];
    const del = delivered[c] || {};
    for (const rk of Object.keys(del)) rows.push(deliveredRow(rk, del[rk]));
    for (const r of (forecastByCycle[c] || [])) rows.push(r);
    days.push({ dayKey: `r${viewRound}c${c}`, offset: c - 1, cycle: c, rows, plannedPosts: rows.length });
  }
  // when: fully done/held cycles = past; the FIRST not-fully-delivered = today (current); the rest = future.
  let currentSet = false, todayIndex = 0;
  days.forEach((dd, i) => {
    const full = dd.rows.length > 0 && dd.rows.every((r) => r.status === 'done' || r.status === 'held');
    if (full && !currentSet) dd.when = 'past';
    else if (!currentSet) { dd.when = 'today'; todayIndex = i; currentSet = true; }
    else dd.when = 'future';
  });
  if (!currentSet) todayIndex = days.length - 1; // whole round delivered → default the view to the last cycle
  return { days, cycleDays: maxCycle, todayIndex };
}

// ---- Ledger (the "done" truth) ----------------------------------------------------------------------------
// A ledger day = { posted, held, errors, items: { "acct|postId|groupId": {account,postId,caption,groupId,group,status,comment} } }
function ledgerDay(day, groupName, numById) {
  const items = (day && day.items) || {};
  const byRow = new Map(); // group ledger items into account+post rows, with per-group status
  for (const k of Object.keys(items)) {
    const it = items[k];
    const rk = `${it.account}|${it.postId}`;
    if (!byRow.has(rk)) byRow.set(rk, { account: it.account, alias: it.account, postId: it.postId, postNum: (numById && numById.get(it.postId)) || it.postNum || null, caption: it.caption || '', groups: [], groupsDone: 0, groupsTotal: 0, status: 'done' });
    const r = byRow.get(rk);
    r.groups.push({ id: it.groupId, name: it.group || groupName(it.groupId), status: it.status });
    r.groupsTotal++;
    if (it.status === 'done') r.groupsDone++;
  }
  const rows = [...byRow.values()].map((r) => ({ ...r, status: r.groupsDone === r.groupsTotal ? 'done' : (r.groups.some((g) => g.status === 'held') ? 'held' : 'partial') }));
  return { rows, posted: (day && day.posted) || 0, held: (day && day.held) || 0, errors: (day && day.errors) || 0 };
}
// Index today's ledger by account|postId|groupId for fast overlay onto the forecast.
function ledgerIndex(day) {
  const idx = {}; const items = (day && day.items) || {};
  for (const k of Object.keys(items)) idx[k] = items[k].status;
  return idx;
}
function overlayRow(r, todayLedger) {
  if (!r.postId) return r;
  let done = 0; let anyHeld = false;
  const groups = r.groups.map((g) => {
    const st = todayLedger[`${r.account}|${r.postId}|${g.gid || g.id}`]; // ledger keys by FB group id (gid)
    if (st === 'done') done++; if (st === 'held') anyHeld = true;
    return { ...g, status: st || 'today' };
  });
  const status = done === 0 && !anyHeld ? 'today' : done === groups.length ? 'done' : anyHeld ? 'held' : 'partial';
  return { ...r, groups, groupsDone: done, status };
}
function lifetimeTotals(progress) {
  let posted = 0, held = 0, errors = 0, days = 0;
  for (const k of Object.keys(progress)) { const d = progress[k]; posted += d.posted || 0; held += d.held || 0; errors += d.errors || 0; days++; }
  return { posted, held, errors, days };
}

module.exports = { buildPlan, localDayKey, dayLabel };
