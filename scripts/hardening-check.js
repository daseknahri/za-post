#!/usr/bin/env node
// Browser-hardening SELF-CHECK (read-only, no Facebook, no network beyond launching Chrome).
// Launches the REAL stealth browser the app uses (lib/browser.launchStealth) and reports what a bot-detector would
// see — so you can VERIFY the anti-detection is actually working on THIS machine, and catch a regression the unit
// tests can't (a Chrome/puppeteer update, a driver quirk). It checks: navigator.webdriver is hidden, the UA is a real
// Chrome (not HeadlessChrome), the WebRTC guard is present, and the per-proxy timezone/locale override takes effect
// (and is correctly SKIPPED for a non-proxied account). Exit 0 = all pass, 1 = something regressed.
//
//   node scripts/hardening-check.js
'use strict';
const { launchStealth, applyProxyGeo, BASE_ARGS } = require('../lib/browser');

const TEST_TZ = 'America/New_York';
const TEST_LOCALE = 'en-US';
const WEBRTC = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';

(async () => {
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });
  let browser;
  try {
    // --- static invariants (no browser needed) ---
    check('WebRTC IP-leak guard is in BASE_ARGS', BASE_ARGS.includes(WEBRTC));
    check('No --no-sandbox tell in BASE_ARGS', !BASE_ARGS.includes('--no-sandbox'));
    check('Automation-controlled blink feature disabled', BASE_ARGS.includes('--disable-blink-features=AutomationControlled'));

    // --- live browser: the REAL posting browser is HEADFUL (a headless Chrome leaks a "HeadlessChrome" UA), so launch
    //     headful but PARKED OFF-SCREEN so no window appears — this verifies exactly what FB sees while this app posts. ---
    browser = await launchStealth({
      headless: false,
      args: ['--window-position=-32000,-32000', '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      defaultViewport: { width: 1366, height: 768 },
    });
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.goto('about:blank').catch(() => {});

    const webdriver = await page.evaluate(() => navigator.webdriver);
    check('navigator.webdriver is NOT true (stealth active)', webdriver !== true, 'value=' + JSON.stringify(webdriver));

    const ua = await page.evaluate(() => navigator.userAgent);
    check('User-Agent is real Chrome, not HeadlessChrome', !/Headless/i.test(ua) && /Chrome\/\d+/.test(ua), ua);

    // geo override on a PROXIED account → timezone + locale should change to the configured region
    const hostTz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await applyProxyGeo(page, { name: 'selfcheck', proxy: 'http://test:8080' }, { proxyTimezone: TEST_TZ, proxyLocale: TEST_LOCALE }, false, []);
    await page.goto('about:blank?applied').catch(() => {}); // overrides apply on the NEXT navigation (matches the real flow: applyProxyGeo runs BEFORE goto(facebook))
    const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    check('Proxy TIMEZONE override takes effect', tz === TEST_TZ, 'host=' + hostTz + ' → override=' + tz + ' (want ' + TEST_TZ + ')');
    const langInfo = await page.evaluate(() => navigator.language + ' | languages=' + navigator.languages.join(','));
    check('Proxy LOCALE override takes effect (navigator.language + languages)', String(langInfo).split(' ')[0].toLowerCase() === TEST_LOCALE.toLowerCase(), 'navigator.language=' + langInfo + ' (want ' + TEST_LOCALE + ')');

    // a NON-proxied account must keep the HOST values (we never forge a real-IP account's clock)
    const page2 = await browser.newPage();
    await page2.goto('about:blank').catch(() => {});
    const host2 = await page2.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await applyProxyGeo(page2, { name: 'realip' }, { proxyTimezone: TEST_TZ, proxyLocale: TEST_LOCALE }, false, []); // not proxied → must SKIP
    await page2.goto('about:blank?applied').catch(() => {});
    const tz2 = await page2.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    check('Non-proxied account KEEPS host timezone (no forging)', tz2 === host2, 'host=' + host2 + ' after=' + tz2);
  } catch (e) {
    check('browser launch / evaluation', false, e && e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  let allPass = true;
  console.log('\n  Browser-hardening self-check\n  ' + '-'.repeat(40));
  for (const r of results) {
    if (!r.pass) allPass = false;
    console.log('  ' + (r.pass ? '✅ PASS' : '❌ FAIL') + '  ' + r.name + (r.detail ? '\n           ' + r.detail : ''));
  }
  console.log('  ' + '-'.repeat(40));
  console.log('  ' + (allPass ? '✅ All hardening checks passed.' : '❌ Some checks FAILED — review above before a real run.') + '\n');
  process.exit(allPass ? 0 : 1);
})();
