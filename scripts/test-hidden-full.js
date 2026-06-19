// Full hidden-mode proof: mirrors automation/worker.js EXACTLY (profile placement pin +
// launch args + CDP focus emulation + visibility override + force-off-screen) and verifies
// (a) the window is parked off-screen and (b) the page believes it is FOCUSED + VISIBLE —
// the combination that lets Facebook actually publish from an invisible window.
// Uses a throwaway profile; never touches a logged-in account. Run: node scripts/test-hidden-full.js
const os = require('os');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { chromiumPath } = require('../lib/chromium');
const store = require('../lib/store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = path.join(os.tmpdir(), 'za-hidden-full-' + Date.now());
  store.init(tmp);
  const name = 'verify';
  let browser, pass = true;
  const ok = (cond, label, got) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? `  (got: ${got})` : ''}`); if (!cond) pass = false; };
  try {
    // 1) pin placement off-screen (what the worker does pre-launch when hidden). Seed an
    // EXISTING Preferences with ON-SCREEN bounds first (a real account that was logged in /
    // ran visible) so we prove the pin actually overwrites them. (A brand-new profile has no
    // Preferences yet, so the pin is a correct no-op there — the launch arg handles that case.)
    const defDir = path.join(store.profileDir(name), 'Default');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(path.join(defDir, 'Preferences'), JSON.stringify({
      browser: { window_placement: { left: 100, top: 60, right: 1380, bottom: 960, maximized: false, work_area_right: 1366, work_area_bottom: 768 } },
    }));
    store.sanitizeProfile(name, true);
    const wpPinned = JSON.parse(fs.readFileSync(path.join(defDir, 'Preferences'), 'utf8')).browser.window_placement;

    // 2) launch with the worker's exact args + hidden window-position
    const launchArgs = [
      '--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900',
      '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble',
      '--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage', '--disable-extensions',
      '--disable-background-networking', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--mute-audio',
      '--disk-cache-size=52428800', '--media-cache-size=10485760',
      '--window-position=-32000,-32000',
    ];
    browser = await puppeteer.launch({
      headless: false, executablePath: chromiumPath(), userDataDir: store.profileDir(name),
      args: launchArgs, defaultViewport: { width: 1280, height: 900 }, protocolTimeout: 90000,
    });
    const page = (await browser.pages())[0] || (await browser.newPage());

    // 3) CDP focus emulation + force off-screen (exactly the worker's block)
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: 1280, height: 900 } });

    // 4) visibility override (applied on new document)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.hasFocus = () => true;
    });
    await page.goto('about:blank');
    await sleep(300);

    // ---- verify ----
    console.log('Hidden-mode full path verification:');
    const b = (await cdp.send('Browser.getWindowBounds', { windowId })).bounds;
    ok(b.left <= -2000 && b.top <= -2000, 'window parked OFF-SCREEN', `${b.left},${b.top}`);

    const vis = await page.evaluate(() => ({ hidden: document.hidden, vs: document.visibilityState, focus: document.hasFocus() }));
    ok(vis.hidden === false, 'document.hidden === false', vis.hidden);
    ok(vis.vs === 'visible', "document.visibilityState === 'visible'", vis.vs);
    ok(vis.focus === true, 'document.hasFocus() === true', vis.focus);

    // confirm sanitizeProfile pinned the (existing) profile's placement off-screen pre-launch
    ok(wpPinned && wpPinned.left === -32000, 'sanitizeProfile pinned existing profile off-screen', wpPinned && wpPinned.left);

    console.log('\nRESULT: ' + (pass
      ? 'HIDDEN MODE PERFECT — window invisible, page reports focused+visible (FB will publish), placement pinned.'
      : 'One or more checks FAILED — see above.'));
  } catch (e) {
    console.log('ERROR:', e.message); pass = false;
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  process.exit(pass ? 0 : 1);
})();
