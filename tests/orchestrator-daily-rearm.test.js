// tests/orchestrator-daily-rearm.test.js
// FULL-BATCH-DAILY daily auto-re-arm (v1.0.138). The operator swaps accounts EVERY DAY. Under loopCampaign=false, a
// completed one-shot plan from yesterday re-loads and delivers 0 on the next day's Start (swapped-in accounts benched,
// no round boundary). _dailyRearmIfNeeded rebuilds for today's roster — but ONLY if the LIBRARY changed (re-dealing the
// same posts to the same groups is cross-day spam; campaign-plan has no durable per-(post,group) guard).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

const acct = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'campaign-plan', postFilter: 'all', enabled: true, status: 'logged_in', standby: false });
const yesterday = () => { const d = new Date(Date.now() - 26 * 3600 * 1000); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };

// Build an orchestrator with a FINISHED plan dated yesterday, for the given roster + posts.
function finishedYesterday(roster, posts) {
  const o = new Orchestrator(() => {}, {});
  o._saveRotationState = () => {}; // don't touch disk
  o._data = { posts, groups: [], accounts: roster, settings: { loopCampaign: false } };
  const plan = o._computeCampaignPlan(posts, roster, 0);
  plan.planStartDate = yesterday();
  o._campaignPlan = plan;
  // mark every agent FINISHED: pointer at the last post of its slice
  o._perAccountRotation = {};
  for (const name of Object.keys(plan.agentLists)) { const l = plan.agentLists[name]; if (l.length) o._perAccountRotation[name] = { lastPostId: l[l.length - 1], lastPostedAt: Date.now() - 26 * 3600 * 1000, icommit: 5 }; }
  return o;
}

const POSTS = (ids) => ids.map((i) => ({ id: 'P' + i }));

test('[daily-rearm] SAME posts next day → does NOT re-deal (no cross-day re-spam)', () => {
  const roster = [acct('a', ['g1']), acct('b', ['g1'])];
  const posts = POSTS([1, 2, 3, 4]);
  const o = finishedYesterday(roster, posts);
  assert.equal(o._campaignAllFinished(), true, 'precondition: yesterday finished');
  const r = o._dailyRearmIfNeeded({ loopCampaign: false });
  assert.equal(r, 'same-library', 'unchanged library must NOT re-deal');
  assert.equal(o._campaignPlan.planStartDate, yesterday(), 'the plan is left as-is (still yesterday, still finished)');
});

test('[daily-rearm] NEW content next day → rebuilds for today, delivers again', () => {
  const roster = [acct('a', ['g1']), acct('b', ['g1'])];
  const o = finishedYesterday(roster, POSTS([1, 2, 3, 4]));
  o._data.posts = POSTS([5, 6, 7, 8]); // operator loaded fresh posts
  const r = o._dailyRearmIfNeeded({ loopCampaign: false });
  assert.equal(r, 'rearmed', 'changed library → rebuild');
  assert.notEqual(o._campaignPlan.planStartDate, yesterday(), 'plan is now dated today');
  assert.equal(o._campaignAllFinished(), false, 'the fresh plan has work to do (not finished)');
  const dealt = Object.values(o._campaignPlan.agentLists).flat();
  assert.deepEqual([...new Set(dealt)].sort(), ['P5', 'P6', 'P7', 'P8'], 'the NEW library is dealt');
});

test('[daily-rearm] SWAPPED-IN account gets a slice; removed account is gone', () => {
  const o = finishedYesterday([acct('a', ['g1']), acct('b', ['g1'])], POSTS([1, 2, 3, 4]));
  // operator swaps: remove b, add c — and loads new posts (else the same-library gate blocks)
  o._data.accounts = [acct('a', ['g1']), acct('c', ['g1'])];
  o._data.posts = POSTS([5, 6, 7, 8]);
  const r = o._dailyRearmIfNeeded({ loopCampaign: false });
  assert.equal(r, 'rearmed');
  const names = Object.keys(o._campaignPlan.agentLists);
  assert.ok(names.includes('c'), 'the swapped-IN account c gets a slice');
  assert.ok(!names.includes('b'), 'the removed account b is not in the new plan');
  assert.ok((o._campaignPlan.agentLists.c || []).length > 0, 'c actually has posts to deliver');
});

test('[daily-rearm] atomicity: after re-arm no agent has a pointer OUTSIDE its new slice (no re-deliver)', () => {
  const o = finishedYesterday([acct('a', ['g1']), acct('b', ['g1'])], POSTS([1, 2, 3, 4]));
  o._data.posts = POSTS([5, 6, 7, 8]);
  o._dailyRearmIfNeeded({ loopCampaign: false });
  for (const name of Object.keys(o._campaignPlan.agentLists)) {
    const rec = o._perAccountRotation[name] || {};
    assert.equal(rec.lastPostId, null, `${name}'s pointer is nulled with the rebuild (fresh slice from #1, no stale pointer that re-delivers)`);
  }
});

test('[daily-rearm] SAME day (not a new day) → not-applicable (delivers once, as before)', () => {
  const o = finishedYesterday([acct('a', ['g1'])], POSTS([1, 2]));
  o._campaignPlan.planStartDate = o._localDayKey(); // plan is from TODAY
  assert.equal(o._dailyRearmIfNeeded({ loopCampaign: false }), 'not-applicable', 'no re-arm within the same day');
});

test('[daily-rearm] loopCampaign ON → not-applicable (the reloop owns it, not this)', () => {
  const o = finishedYesterday([acct('a', ['g1'])], POSTS([1, 2]));
  o._data.posts = POSTS([3, 4]);
  assert.equal(o._dailyRearmIfNeeded({ loopCampaign: true }), 'not-applicable');
});

test('[daily-rearm] empty roster on a new day → no-roster (keep the plan, never "day over")', () => {
  const o = finishedYesterday([acct('a', ['g1'])], POSTS([1, 2]));
  o._data.accounts = []; // all accounts gone
  o._data.posts = POSTS([3, 4]);
  assert.equal(o._dailyRearmIfNeeded({ loopCampaign: false }), 'no-roster');
});
