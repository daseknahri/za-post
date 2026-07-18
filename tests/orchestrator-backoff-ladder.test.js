// tests/orchestrator-backoff-ladder.test.js
// Locks the rate-limit + attention-rest EXPONENTIAL BACKOFF ladder in Orchestrator._recordAccountOutcome. This is
// the single most ban-critical piece of bookkeeping with (previously) no direct test: a regression to a FLAT rest
// (e.g. dropping the `Math.pow(2, strike-1)`) would re-submit the FB login form / re-navigate a dead account on the
// ONE shared residential IP every window forever (ban-escalation, invariant #3) — and no existing test would fail.
// Also locks the clean-delivery RECOVERY clear (a recovered account must rejoin, not stay 'resting' forever).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = 3600000; // ms per hour
const near = (actual, expectedMs, msg) => assert.ok(Math.abs(actual - expectedMs) < 15000, `${msg}: expected ≈${Math.round(expectedMs / H)}h, got ${(actual / H).toFixed(2)}h`);

test('_recordAccountOutcome: rate-limit + attention-rest backoff ladder (exponential, tiered, clamped) + recovery clear', async () => {
  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-backoff-'));
  store.init(tmp);
  const today = store.todayKey();
  store.save({
    posts: [], groups: [], proxies: [], useProxies: false, settings: {},
    accounts: [
      { name: 'rl', daily: { date: today, count: 0 } },        // rate-limit ladder (2 consecutive → strike 1 then 2)
      { name: 'acct', daily: { date: today, count: 0 } },       // account-level rate-limit (3× a posting-limit)
      { name: 'clamp', rlStrikes: 9, daily: { date: today, count: 0 } }, // high strike → 48h clamp
      { name: 'attn', daily: { date: today, count: 0 } },       // needs_login attention ladder (3h then 6h)
      { name: 'attnclamp', attnStrikes: 4, daily: { date: today, count: 0 } }, // high strike → 24h clamp
      { name: 'ver', daily: { date: today, count: 0 } },        // needs_verification base = 6h
      { name: 'rec', status: 'error', rlStrikes: 2, rateLimitedUntil: Date.now() + 10 * H, attnStrikes: 2, nextAttnRetry: Date.now() + 10 * H, daily: { date: today, count: 0 } }, // recovery
    ],
  });

  const o = Object.create(Orchestrator.prototype);
  o.log = () => {};
  const acc = (name) => store.load().accounts.find((a) => a.name === name);

  // ── RATE-LIMIT LADDER: baseHours 4 × early(posted 0 → 2×) × 2^(strike-1) ──
  let t0 = Date.now();
  await o._recordAccountOutcome('rl', { posted: 0, targetCount: 5, flag: 'rate_limited', rlKind: 'post' }, {});
  assert.equal(acc('rl').rlStrikes, 1, 'first rate-limit → strike 1');
  near(acc('rl').rateLimitedUntil, t0 + 8 * H, 'strike 1: 4h × 2(early) × 2^0 = 8h');

  t0 = Date.now();
  await o._recordAccountOutcome('rl', { posted: 0, targetCount: 5, flag: 'rate_limited', rlKind: 'post' }, {});
  assert.equal(acc('rl').rlStrikes, 2, 'second consecutive rate-limit → strike 2');
  near(acc('rl').rateLimitedUntil, t0 + 16 * H, 'strike 2: window doubles → 16h');

  // ── TIER: an ACCOUNT-level block rests 3× a posting limit (mult 3 vs 1) at the same strike/early ──
  t0 = Date.now();
  await o._recordAccountOutcome('acct', { posted: 0, targetCount: 5, flag: 'rate_limited', rlKind: 'account' }, {});
  near(acc('acct').rateLimitedUntil, t0 + 24 * H, 'account-level: 4h × 3(kind) × 2(early) × 2^0 = 24h (= 3× the posting 8h)');

  // ── CLAMP: a high strike is capped at 48h ──
  t0 = Date.now();
  await o._recordAccountOutcome('clamp', { posted: 0, targetCount: 5, flag: 'rate_limited', rlKind: 'post' }, {});
  assert.equal(acc('clamp').rlStrikes, 10, 'strike incremented to 10');
  near(acc('clamp').rateLimitedUntil, t0 + 48 * H, 'huge strike clamps at 48h');

  // ── ATTENTION-REST LADDER: needs_login base 3h × 2^(strike-1) ──
  t0 = Date.now();
  await o._recordAccountOutcome('attn', { posted: 0, flag: 'needs_login' }, {});
  assert.equal(acc('attn').attnStrikes, 1, 'first needs_login → attn strike 1');
  near(acc('attn').nextAttnRetry, t0 + 3 * H, 'needs_login strike 1: 3h');

  t0 = Date.now();
  await o._recordAccountOutcome('attn', { posted: 0, flag: 'needs_login' }, {});
  assert.equal(acc('attn').attnStrikes, 2, 'second → attn strike 2');
  near(acc('attn').nextAttnRetry, t0 + 6 * H, 'needs_login strike 2: 6h (doubles)');

  // ── ATTENTION CLAMP: 24h cap ──
  t0 = Date.now();
  await o._recordAccountOutcome('attnclamp', { posted: 0, flag: 'needs_login' }, {}); // strike 4→5 → 3×2^4=48h → clamp 24h
  near(acc('attnclamp').nextAttnRetry, t0 + 24 * H, 'high attn strike clamps at 24h');

  // ── needs_verification rests longer at base (6h vs needs_login's 3h) ──
  t0 = Date.now();
  await o._recordAccountOutcome('ver', { posted: 0, flag: 'needs_verification' }, {});
  near(acc('ver').nextAttnRetry, t0 + 6 * H, 'needs_verification base 6h');

  // ── RECOVERY: a clean delivery (posted>0, no flag) clears the WHOLE rest ladder + un-sticks a stale status ──
  await o._recordAccountOutcome('rec', { posted: 1, pendingApproval: 0, errors: 0, flag: null }, {});
  const rec = acc('rec');
  assert.equal(rec.rlStrikes, 0, 'recovery clears rlStrikes');
  assert.equal(rec.rateLimitedUntil, 0, 'recovery clears rateLimitedUntil');
  assert.equal(rec.attnStrikes, 0, 'recovery clears attnStrikes (backoff ladder resets)');
  assert.equal(rec.nextAttnRetry, 0, 'recovery clears nextAttnRetry (rejoins next cycle)');
  assert.equal(rec.status, 'logged_in', 'recovery un-sticks a stale error status so it can take reserve roles');

  fs.rmSync(tmp, { recursive: true, force: true });
});
