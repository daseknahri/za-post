// tests/orchestrator-campaign-takeover.test.js
// SAME-DAY reserve takeover for Campaign Plan: when an active campaign-plan agent DROPS (rate-limit, logout,
// etc.) and delivers nothing, a healthy campaign-plan reserve in the SAME cluster (identical assignedGroups)
// delivers that agent's slice-for-today into the same groups THAT cycle — and the DROPPED agent's pointer
// advances (so the slice progresses), not the reserve's. This closes the gap where a pinned slice was
// otherwise lost for the day.
//
// NOTE: the worker stub MUST be installed BEFORE requiring the orchestrator, because the orchestrator
// destructures runAccount at module load. A swappable handler lets the integration test drive it.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const worker = require('../automation/worker');
let runAccountHandler = null;
worker.runAccount = async (o) => (runAccountHandler
  ? runAccountHandler(o)
  : { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: [], dealtIds: [], fullyPosted: true, offline: false, progressed: true });
const { Orchestrator } = require('../automation/orchestrator'); // captures the stubbed runAccount

const mk = () => new Orchestrator(() => {}, {});
const agent = (name, groups, standby = false) => ({ name, assignedGroups: groups, postingOrder: 'campaign-plan', postFilter: 'all', enabled: true, status: 'logged_in', standby });

// ---- unit: the picker routes a reserve stand-in to the dropped agent's slice-post -----------------------
test('campaign takeover: _postsForAccount routes a stand-in reserve to the dropped agent\'s slice-post', () => {
  const o = mk();
  o._data = { posts: [1, 2, 3, 4].map((n) => ({ id: 'P' + n })), settings: {}, accounts: [] };
  const A = agent('A', ['g1']), B = agent('B', ['g1']);
  o._active = [A, B];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A, B], 0); // A=[P1,P3] B=[P2,P4]
  o._perAccountRotation = {};
  const R = agent('R', ['g1'], true);
  o._campaignTakeover = { R: { postId: 'P1', forAgent: 'A' } };
  assert.deepEqual(o._postsForAccount(R, 1).map((p) => p.id), ['P1'], 'reserve delivers the dropped agent\'s slice-post');
  o._campaignTakeover = {};
  assert.deepEqual(o._postsForAccount(R, 1), [], 'a plain campaign reserve has no slice → nothing');
});

// ---- unit: pairing a dropped agent with a healthy in-cluster reserve ------------------------------------
test('campaign takeover: _campaignStandins pairs a dropped agent with a healthy SAME-cluster reserve only', () => {
  const o = mk();
  o._data = { posts: [1, 2, 3, 4].map((n) => ({ id: 'P' + n })), settings: {}, accounts: [] };
  const A = agent('A', ['g1', 'g2']), B = agent('B', ['g1', 'g2']);
  o._active = [A, B];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A, B], 0); // A=[P1,P3]
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const R = agent('R', ['g1', 'g2'], true); // SAME cluster
  const X = agent('X', ['g9'], true);       // different cluster
  assert.deepEqual(o._campaignStandins([A, B], [X, R], () => true, 3), { R: { postId: 'P1', forAgent: 'A' } },
    'only the in-cluster reserve R covers A\'s slice P1; X (wrong groups) is ignored');
});

test('campaign takeover: a SUPERSET reserve (covers all of A\'s groups + extras) is accepted; a missing-group one is not', () => {
  const o = mk();
  o._data = { posts: [1, 2, 3, 4].map((n) => ({ id: 'P' + n })), settings: {}, accounts: [] };
  const A = agent('A', ['g1', 'g2']), B = agent('B', ['g1', 'g2']);
  o._active = [A, B];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A, B], 0); // A=[P1,P3]
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const SUP = agent('SUP', ['g1', 'g2', 'g3'], true); // member of all A's groups + an extra → valid cover
  const MISS = agent('MISS', ['g1', 'g9'], true);     // missing g2 → cannot cover A
  assert.deepEqual(o._campaignStandins([A, B], [MISS, SUP], () => true, 3), { SUP: { postId: 'P1', forAgent: 'A' } },
    'superset reserve covers A; a reserve missing one of A\'s groups is rejected');
});

test('campaign takeover: a dropped agent that already posted today is NOT double-covered', () => {
  const o = mk();
  o._data = { posts: [1, 2].map((n) => ({ id: 'P' + n })), settings: {}, accounts: [] };
  const A = agent('A', ['g1']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0);
  o._perAccountRotation = { A: { lastPostId: null, lastPostedDate: o._localDayKey() } }; // already posted today
  o._cycleDrops = new Set(['A']);
  const R = agent('R', ['g1'], true);
  assert.deepEqual(o._campaignStandins([A], [R], () => true, 3), {}, 'already posted today → no stand-in (no double-post)');
});

test('campaign takeover: unhealthy reserve skipped; completed slice not covered; non-dropped agent ignored', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: {}, accounts: [] };
  const A = agent('A', ['g1']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0); // A=[P1,P2]
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const R = agent('R', ['g1'], true);
  assert.deepEqual(o._campaignStandins([A], [R], () => false, 3), {}, 'unhealthy reserve → no stand-in');
  o._perAccountRotation = { A: { lastPostId: 'P2', lastPostedDate: '2000-01-01' } };
  assert.deepEqual(o._campaignStandins([A], [R], () => true, 3), {}, 'finished slice → nothing to cover');
  o._perAccountRotation = {};
  o._cycleDrops = new Set();
  assert.deepEqual(o._campaignStandins([A], [R], () => true, 3), {}, 'no drop → no stand-in');
});

// ---- integration: full cycle, mocked worker — drop → reserve delivers → dropped pointer advances --------
test('campaign takeover (integration): an in-cluster reserve delivers a dropped agent\'s slice same-day', async () => {
  const calls = [];
  runAccountHandler = async (o) => {
    const name = o.account.name;
    const postId = o.post && o.post.id;
    calls.push({ name, postId, groups: (o.account.assignedGroups || []).slice() });
    if (name === 'A') { // A DROPS: rate-limited, delivers nothing
      return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: 'rate_limited', postedIds: [], dealtIds: [], fullyPosted: false, offline: false, progressed: false };
    }
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: [postId], dealtIds: [postId], fullyPosted: true, offline: false, progressed: true };
  };

  const store = require('../lib/store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-camptake-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'P1', caption: 'a', comment: '', imagePaths: [] }, { id: 'P2', caption: 'b', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: [
      { name: 'A', enabled: true, status: 'logged_in', assignedGroups: ['g1'], postingOrder: 'campaign-plan', postFilter: 'all', standby: false },
      { name: 'R', enabled: true, status: 'logged_in', assignedGroups: ['g1'], postingOrder: 'campaign-plan', postFilter: 'all', standby: true },
    ],
    settings: { parallelAccounts: 2, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });

  const orch = new Orchestrator(() => {}, {});
  orch.start(() => store.load());
  // The takeover fires within the first cycle; poll until the dropped agent's pointer is persisted (campaign
  // self-pacing then holds to "next day", which is why we stop on the outcome rather than awaiting run-end).
  for (let i = 0; i < 200; i++) {
    if (((store.loadRotation().perAccountRotation || {}).A || {}).lastPostId === 'P1') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  try { orch.stop(); } catch {}
  runAccountHandler = null;

  // A is the only active campaign agent → its slice = [P1, P2]; day-1 slice-post = P1. A drops, so the
  // in-cluster reserve R must deliver P1 into g1 the SAME cycle.
  assert.ok(calls.some((c) => c.name === 'R' && c.postId === 'P1' && c.groups.includes('g1')),
    'reserve R delivered the dropped agent\'s day-1 slice-post P1 into its group');
  // And the DROPPED agent A's pointer advanced (P1 marked delivered) — not the reserve's.
  const rot = store.loadRotation();
  assert.equal((rot.perAccountRotation.A || {}).lastPostId, 'P1', 'the dropped agent A\'s pointer advanced to P1');
  assert.ok(!rot.perAccountRotation.R, 'the reserve R did NOT get a campaign pointer of its own');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- #2 smarter selection: among covering reserves, pick the BEST (least over-exposure, fewest strikes, warmest) ----
test('reserve ranking: the closest group-match (least over-exposure) is chosen over a wider reserve', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: {}, accounts: [] };
  const A = agent('A', ['g1']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0);
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const RWIDE = agent('RWIDE', ['g1', 'g2', 'g3'], true); // covers g1 but the slice would also hit g2,g3 (over-exposure)
  const RCLOSE = agent('RCLOSE', ['g1'], true);           // exact match — no over-exposure
  // RWIDE is listed first → the old first-found pick would take it; the ranker must pick RCLOSE.
  assert.deepEqual(Object.keys(o._campaignStandins([A], [RWIDE, RCLOSE], () => true, 3)), ['RCLOSE'],
    'exact-match reserve preferred over a wider one (least over-exposure)');
});

test('reserve ranking: among equal-match reserves, fewer recent rate-limit strikes wins', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: {}, accounts: [] };
  const A = agent('A', ['g1']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0);
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const RSTRIKED = { ...agent('RSTRIKED', ['g1'], true), rlStrikes: 3 };
  const RCLEAN = { ...agent('RCLEAN', ['g1'], true), rlStrikes: 0 };
  assert.deepEqual(Object.keys(o._campaignStandins([A], [RSTRIKED, RCLEAN], () => true, 3)), ['RCLEAN'],
    'the reserve with fewer rate-limit strikes is preferred (safer takeover)');
});

// ---- #1 split coverage: multiple reserves jointly cover a drop when no single reserve is a superset ----
test('#1 split coverage: two partial reserves jointly cover A\'s groups, each gids-routed to its subset', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: {}, groups: [{ id: 'g1', groupId: '1' }, { id: 'g2', groupId: '2' }], accounts: [] };
  const A = agent('A', ['g1', 'g2']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0); // A day-1 slice = P1
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const R1 = agent('R1', ['g1'], true); // covers only g1
  const R2 = agent('R2', ['g2'], true); // covers only g2 — NO single reserve covers {g1,g2}
  const out = o._campaignStandins([A], [R1, R2], () => true, 3);
  assert.equal(out.R1 && out.R1.postId, 'P1'); assert.deepEqual(out.R1 && out.R1.gids, ['1'], 'R1 routed to g1 only');
  assert.equal(out.R2 && out.R2.postId, 'P1'); assert.deepEqual(out.R2 && out.R2.gids, ['2'], 'R2 routed to g2 only');
  assert.equal(out.R1.forAgent, 'A'); assert.equal(out.R2.forAgent, 'A');
});

test('#1 split coverage: partial — delivers what it can when one group has no member reserve', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: {}, groups: [{ id: 'g1', groupId: '1' }, { id: 'g2', groupId: '2' }, { id: 'g3', groupId: '3' }], accounts: [] };
  const A = agent('A', ['g1', 'g2', 'g3']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0);
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const R1 = agent('R1', ['g1', 'g2'], true); // covers g1,g2; NO reserve covers g3
  const out = o._campaignStandins([A], [R1], () => true, 3);
  assert.equal(out.R1 && out.R1.postId, 'P1');
  assert.deepEqual((out.R1 && out.R1.gids || []).slice().sort(), ['1', '2'], 'R1 delivers g1+g2; g3 stays uncovered but the rest still ships');
});

test('#1 split coverage: a single SUPERSET reserve still uses the whole-cover path (no gids) — unchanged', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: {}, groups: [{ id: 'g1', groupId: '1' }, { id: 'g2', groupId: '2' }], accounts: [] };
  const A = agent('A', ['g1', 'g2']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0);
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const SUP = agent('SUP', ['g1', 'g2', 'g9'], true); // full superset → single-cover path, NOT split
  assert.deepEqual(o._campaignStandins([A], [SUP], () => true, 3), { SUP: { postId: 'P1', forAgent: 'A' } },
    'a superset reserve takes the whole slice via the unchanged single-cover path (no gids field)');
});
