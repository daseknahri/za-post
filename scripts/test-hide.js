// Verify the off-screen window hide works on THIS machine (does Windows clamp -32000?).
// Mirrors worker.js launch + the CDP force-off-screen move. Uses a throwaway profile so it
// never touches a logged-in account. Run: node scripts/test-hide.js
const os = require('os');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { chromiumPath } = require('../lib/chromium');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onScreen = (b) => b && b.left > -2000 && b.top > -2000;

(async () => {
  const tmp = path.join(os.tmpdir(), 'za-hide-test-' + Date.now());
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromiumPath(),
      userDataDir: tmp,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--window-size=1280,900'],
      defaultViewport: { width: 1280, height: 900 },
      protocolTimeout: 90000,
    });
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.goto('about:blank');
    const cdp = await page.target().createCDPSession();
    const { windowId } = await cdp.send('Browser.getWindowForTarget');

    const read = async () => (await cdp.send('Browser.getWindowBounds', { windowId })).bounds;

    let b = await read();
    console.log(`1) after launch with --window-position=-32000: left=${b.left} top=${b.top}  -> ${onScreen(b) ? 'ON-SCREEN (Chrome ignored the flag / clamped)' : 'off-screen'}`);

    // Simulate the bug: a prior visible run left on-screen bounds Chrome restored.
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 40, width: 1280, height: 900 } });
    b = await read();
    console.log(`2) forced ON-SCREEN (simulating restore): left=${b.left} top=${b.top}  -> ${onScreen(b) ? 'on-screen (as expected)' : 'unexpected'}`);

    // The fix: force it off-screen via CDP.
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: 1280, height: 900 } });
    await sleep(500);
    b = await read();
    const fixed = !onScreen(b);
    console.log(`3) after CDP force-off-screen (the fix): left=${b.left} top=${b.top}  -> ${fixed ? 'OFF-SCREEN ✅ (Windows did NOT clamp it)' : 'STILL ON-SCREEN ❌ (Windows clamped -32000)'}`);

    console.log('\nRESULT: ' + (fixed
      ? 'The fix works on this machine — hidden runs will stay invisible.'
      : 'Windows clamps -32000 here — need a different hide strategy (will iterate).'));
  } catch (e) {
    console.log('ERROR:', e.message);
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
})();
