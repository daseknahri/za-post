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

  // Overlay today's ledger onto today's forecast row-statuses (so a half-finished day shows done/pending cells).
  const todayLedger = progress[todayKey] ? ledgerIndex(progress[todayKey]) : null;
  const futureDays = forecast.map((day, i) => {
    const when = i === 0 ? 'today' : 'future';
    const rows = day.rows.map((r) => (when === 'today' && todayLedger) ? overlayRow(r, todayLedger) : r);
    return { dayKey: addDays(todayKey, i), offset: i, label: dayLabel(addDays(todayKey, i), todayKey), when, rows, plannedPosts: rows.length };
  });

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
