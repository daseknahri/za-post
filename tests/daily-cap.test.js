// tests/daily-cap.test.js
// M2-05: the per-account daily cap must be immune to clock changes. A DST shift or a clock that
// is set backward must NOT reset the count — otherwise an account silently posts past its cap and
// risks a Facebook block. Also pins the numeric coercion that keeps NaN out of the cap math.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');

test('todayKey uses the LOCAL calendar date (aligns the daily cap with local-day pacing + the daily schedule)', () => {
  // Local date, not UTC — so the cap window matches _localDayKey (pacing) and the operator's local schedule,
  // removing the ~1h near-midnight straddle where the two used different calendar days. Backward-clock abuse is
  // still blocked by the MONOTONIC dailyRolledOver (forward-only — tested below); a DST shift changes the hour,
  // not the calendar date, so the key is stable across DST.
  const d = new Date(2026, 5, 20, 12, 0, 0); // local 2026-06-20 midday → same date in any timezone
  assert.equal(store.todayKey(d), '2026-06-20');
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  assert.equal(store.todayKey(), `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`, 'defaults to the local calendar date');
});

test('dailyRolledOver: only a genuinely LATER day rolls the window over', () => {
  const daily = { date: '2026-06-20', count: 5 };
  assert.equal(store.dailyRolledOver(daily, '2026-06-21'), true,  'next day → rollover');
  assert.equal(store.dailyRolledOver(daily, '2026-06-20'), false, 'same day → no rollover');
  assert.equal(store.dailyRolledOver(daily, '2026-06-19'), false, 'clock rewound → NO rollover');
  assert.equal(store.dailyRolledOver(null, '2026-06-20'), true,   'no prior daily → fresh window');
});

test('dailyUsed: rewinding the clock keeps the used count (cap cannot be cleared by rewinding)', () => {
  const daily = { date: '2026-06-20', count: 7 };
  assert.equal(store.dailyUsed(daily, '2026-06-20'), 7, 'same day → keep count');
  assert.equal(store.dailyUsed(daily, '2026-06-19'), 7, 'rewound → still counts → no over-posting');
  assert.equal(store.dailyUsed(daily, '2026-06-21'), 0, 'next day → reset to 0');
  assert.equal(store.dailyUsed({ date: '2026-06-20', count: 'x' }, '2026-06-20'), 0, 'garbage count → 0');
});

test('load() coerces account numeric fields so strings/NaN never reach the cap/cooldown math', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-store-'));
  store.init(tmp);
  // Use a VALID FUTURE cool-down so we test string→number coercion AND that DI-4 preserves a sane
  // future value. (A past/absurd value is correctly reset to 0 — covered in humanize.test.js.)
  const futureRl = Date.now() + 2 * 3600 * 1000;
  store.save({
    posts: [], groups: [],
    accounts: [{ name: 'a', daily: { date: '2026-06-20', count: '5' }, rlStrikes: '2', rateLimitedUntil: String(futureRl) }],
    settings: {}, proxies: [], useProxies: false,
  });
  const a = store.load().accounts[0];
  assert.strictEqual(a.daily.count, 5);
  assert.strictEqual(a.rlStrikes, 2);
  assert.strictEqual(a.rateLimitedUntil, futureRl, 'coerced to a number and preserved (valid future cool-down)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('#16: a hand-edited STRING dailyCap is coerced/clamped on LOAD so the ban-safety cap can never silently switch off', () => {
  // A stopped-app hand-edit / import can put "dailyCap":"5" (a JSON string) into data.json. Before the fix normalize()
  // passed it through untouched and the engine's Number.isFinite(dailyCap) gate saw false → cap=0 → cap OFF, no warning.
  assert.strictEqual(store.normalize({ settings: { dailyCap: '5' } }).settings.dailyCap, 5, 'string "5" → number 5 on load');
  const s = store.normalize({ settings: { dailyCap: '5' } }).settings;
  assert.ok(Number.isFinite(s.dailyCap) && s.dailyCap > 0, 'the cap gate (Number.isFinite && >0) now stays active');
  assert.strictEqual(store.normalize({ settings: { dailyCap: 'abc' } }).settings.dailyCap, 0, 'garbage → default 0 (no NaN into the cap math)');
  assert.strictEqual(store.normalize({ settings: { dailyCap: -5 } }).settings.dailyCap, 0, 'negative → clamped to the 0 floor');
});
