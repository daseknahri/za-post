// tests/browser-hardening.test.js
// Locks the ANTI-DETECTION / anti-leak invariants so a future refactor can never silently drop them:
//   - the WebRTC IP-leak guard lives in BASE_ARGS (so EVERY launch gets it),
//   - launchStealth keeps the real-Chrome path + removes the automation flag + dedups args,
//   - applyProxyGeo overrides timezone+locale for PROXIED accounts only, never forges, honors account-over-global.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const browser = require('../lib/browser');
const { BASE_ARGS, applyProxyGeo, attachGeoToNewTargets } = browser;

const WEBRTC = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';

test('BASE_ARGS pins the anti-detection invariants', () => {
  assert.ok(BASE_ARGS.includes(WEBRTC), 'WebRTC IP-leak guard is CENTRALIZED in BASE_ARGS (so login/check/worker/etc all get it)');
  assert.ok(BASE_ARGS.includes('--disable-blink-features=AutomationControlled'), 'navigator.webdriver stays hidden');
  assert.ok(!BASE_ARGS.includes('--no-sandbox'), 'NEVER add --no-sandbox (a CI/automation tell a real desktop Chrome lacks)');
});

test('launchStealth enforces real-Chrome + no automation flag + merged/deduped args', async () => {
  const orig = browser.puppeteer.launch;
  let opts = null;
  browser.puppeteer.launch = async (o) => { opts = o; return { _mock: true }; };
  try {
    await browser.launchStealth({ args: ['--mute-audio', WEBRTC] }); // caller ALSO passes the guard
    assert.deepEqual(opts.ignoreDefaultArgs, ['--enable-automation'], 'removes the "controlled by automated software" flag FB bot-flags');
    assert.ok('executablePath' in opts, 'launches the REAL Chrome/Edge path (not Puppeteer Chrome-for-Testing)');
    assert.ok(opts.args.includes(WEBRTC), 'WebRTC guard present');
    assert.equal(opts.args.filter((a) => a === WEBRTC).length, 1, 'deduped — the BASE_ARGS copy + the caller copy collapse to ONE (Set merge)');
    assert.ok(opts.args.includes('--mute-audio'), 'caller args are merged in');
  } finally { browser.puppeteer.launch = orig; }
});

// Mock page that records the CDP commands applyProxyGeo would send. The locale path also reads the REAL UA via
// page.browser().userAgent() (it passes that same UA back with acceptLanguage — not forging it), so the mock supplies one.
const MOCK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
function mockPage() {
  const calls = [];
  const page = {
    target: () => ({ createCDPSession: async () => ({ send: async (method, params) => { calls.push({ method, params }); } }) }),
    browser: () => ({ userAgent: async () => MOCK_UA }),
  };
  return { calls, page };
}

test('applyProxyGeo: a PROXIED account with tz+locale set gets timezone + locale overrides (locale via setUserAgentOverride)', async () => {
  const { calls, page } = mockPage();
  await applyProxyGeo(page, { name: 'A', proxy: 'http://1.2.3.4:8080' }, { proxyTimezone: 'America/New_York', proxyLocale: 'en-US' }, false, []);
  assert.deepEqual(calls.map((c) => c.method), ['Emulation.setTimezoneOverride', 'Emulation.setUserAgentOverride', 'Emulation.setLocaleOverride']);
  assert.equal(calls[0].params.timezoneId, 'America/New_York');
  assert.equal(calls[1].params.acceptLanguage, 'en-US', 'acceptLanguage drives navigator.language/languages + the header');
  assert.equal(calls[1].params.userAgent, MOCK_UA, 'the REAL UA is passed back UNCHANGED (not forged — just attaching acceptLanguage)');
  assert.equal(calls[2].params.locale, 'en-US', 'setLocaleOverride aligns Intl date/number formatting');
});

test('applyProxyGeo: a NON-proxied account gets NO override (host clock/locale is correct for a real IP)', async () => {
  const { calls, page } = mockPage();
  await applyProxyGeo(page, { name: 'A' }, { proxyTimezone: 'America/New_York', proxyLocale: 'en-US' }, false, []);
  assert.equal(calls.length, 0);
});

test('applyProxyGeo: PROXIED but tz+locale UNSET → NO override (never forge) BUT a loud warning', async () => {
  const { calls, page } = mockPage();
  const logs = [];
  await applyProxyGeo(page, { name: 'A', proxy: 'http://1.2.3.4:8080' }, {}, false, [], (m) => logs.push(m));
  assert.equal(calls.length, 0, 'no override applied — never forge a value');
  assert.ok(logs.some((m) => /no timezone\/locale|proxied but no/i.test(m)), 'warns loudly instead of silently leaking host geo');
});

test('applyProxyGeo: per-account timezone/locale override the global proxy* settings', async () => {
  const { calls, page } = mockPage();
  await applyProxyGeo(page, { name: 'A', proxy: 'http://x', timezone: 'Europe/Paris', locale: 'fr-FR' }, { proxyTimezone: 'America/New_York', proxyLocale: 'en-US' }, false, []);
  assert.equal(calls.find((c) => c.method === 'Emulation.setTimezoneOverride').params.timezoneId, 'Europe/Paris');
  assert.equal(calls.find((c) => c.method === 'Emulation.setUserAgentOverride').params.acceptLanguage, 'fr-FR');
  assert.equal(calls.find((c) => c.method === 'Emulation.setLocaleOverride').params.locale, 'fr-FR');
});

test('applyProxyGeo: a POOL-proxied account (useProxies + proxies, no own proxy) still gets the override', async () => {
  const { calls, page } = mockPage();
  await applyProxyGeo(page, { name: 'A' }, { proxyTimezone: 'Asia/Tokyo' }, true, ['http://pool:8080']);
  assert.equal(calls[0].params.timezoneId, 'Asia/Tokyo');
});

test('attachGeoToNewTargets: a popup / new tab also receives the proxy geo override', async () => {
  const calls = [];
  const newPage = {
    target: () => ({ createCDPSession: async () => ({ send: async (method, params) => { calls.push({ method, params }); } }) }),
    browser: () => ({ userAgent: async () => MOCK_UA }),
  };
  let captured = null;
  const fakeBrowser = { on: (evt, cb) => { if (evt === 'targetcreated') captured = cb; } };
  attachGeoToNewTargets(fakeBrowser, { name: 'A', proxy: 'http://x' }, { proxyTimezone: 'America/New_York', proxyLocale: 'en-US' }, false, []);
  assert.ok(typeof captured === 'function', 'registers a targetcreated listener');
  await captured({ type: () => 'page', page: async () => newPage }); // simulate FB opening a popup
  assert.ok(calls.some((c) => c.method === 'Emulation.setTimezoneOverride' && c.params.timezoneId === 'America/New_York'), 'the new page gets the timezone override');
  assert.ok(calls.some((c) => c.method === 'Emulation.setUserAgentOverride' && c.params.acceptLanguage === 'en-US'), 'the new page gets the locale override');
});
