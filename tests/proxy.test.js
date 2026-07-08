// tests/proxy.test.js
// E-X3: the ProxyHealthManager — failure tracking, exponential cool-down, stats, and persistence
// with stale-entry pruning. All pure/deterministic (time is injected).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProxyHealthManager } = require('../lib/proxy');

test('markFail sets a cool-down that grows; markOk clears it', () => {
  const m = new ProxyHealthManager();
  const now = 1_000_000;
  m.markFail('socks5://1.2.3.4:1080', 'timeout', now);
  assert.equal(m.isOnCooldown('socks5://1.2.3.4:1080', now + 1000), true);
  let s = m.getStats(now + 1000).proxies[0];
  assert.equal(s.consecutiveFailCount, 1);
  assert.equal(s.lastReason, 'timeout');
  const cd1 = s.onCooldownUntil;
  m.markFail('socks5://1.2.3.4:1080', '407', now + 2000); // second consecutive fail → longer cool-down
  s = m.getStats(now + 2000).proxies[0];
  assert.equal(s.consecutiveFailCount, 2);
  assert.ok(s.onCooldownUntil - (now + 2000) > cd1 - (now + 1000), 'cool-down grows on repeated failure');
  m.markOk('socks5://1.2.3.4:1080', now + 3000);
  assert.equal(m.isOnCooldown('socks5://1.2.3.4:1080', now + 3000), false);
  assert.equal(m.getStats(now + 3000).proxies[0].alive, true);
});

test('getStats summary counts healthy / failing / on-cooldown', () => {
  const m = new ProxyHealthManager();
  const now = 1_000_000;
  m.markOk('p-ok', now);
  m.markFail('p-bad', 'connection refused', now);
  const { summary } = m.getStats(now + 1000);
  assert.equal(summary.total, 2);
  assert.equal(summary.healthy, 1);
  assert.equal(summary.onCooldown, 1);
  assert.equal(summary.failing, 1);
});

test('save/load round-trips and prunes entries older than 1h', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-px-'));
  const file = path.join(tmp, 'proxy-health.json');
  const m = new ProxyHealthManager();
  const now = Date.now();
  m.markFail('fresh', 'timeout', now);
  m.markFail('stale', 'timeout', now - 2 * 3600000); // 2h ago
  assert.equal(m.save(file), true);
  const m2 = new ProxyHealthManager();
  m2.load(file, now);
  const urls = m2.getStats(now).proxies.map((p) => p.url);
  assert.ok(urls.includes('fresh'), 'fresh entry survives a restart');
  assert.ok(!urls.includes('stale'), 'stale (>1h) entry is pruned on load');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('load() on a missing/corrupt file is a no-op (returns false, empty manager)', () => {
  const m = new ProxyHealthManager();
  assert.equal(m.load(path.join(os.tmpdir(), 'does-not-exist-zpost.json')), false);
  assert.equal(m.getStats().summary.total, 0);
});
