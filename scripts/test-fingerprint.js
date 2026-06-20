// scripts/test-fingerprint.js
// LIVE fingerprint test. Launches the REAL bundled Chromium with the SAME launch args, stealth
// plugin, off-screen hide, and evaluateOnNewDocument overrides that automation/worker.js uses, then
// measures the bot-tells Facebook reads. Proves the anti-spam fingerprint fixes actually take effect.
//   node scripts/test-fingerprint.js          (hidden/off-screen, like a real run)
//   node scripts/test-fingerprint.js --visible (on-screen, to compare)
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { chromiumPath } = require('../lib/chromium');

const hidden = !process.argv.includes('--visible');

// Mirrors worker.js launchArgs (minus proxy) — note: NO --disable-gpu / --disable-software-rasterizer.
const launchArgs = [
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--window-size=1280,900',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-crash-restore-bubble',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--mute-audio',
  '--disk-cache-size=52428800',
  '--media-cache-size=10485760',
  hidden ? '--window-position=-32000,-32000' : '--window-position=80,40',
];

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromiumPath(),
    args: launchArgs,
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 90000,
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  const cdp = await page.target().createCDPSession();
  if (hidden) {
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: 1280, height: 900 } });
    } catch {}
  }
  try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.hasFocus = () => true;
    for (const pv of [['screenX', 80], ['screenY', 40], ['screenLeft', 80], ['screenTop', 40]]) {
      try { Object.defineProperty(window, pv[0], { configurable: true, get: () => pv[1] }); } catch {}
    }
  });
  await page.goto('about:blank');
  const fp = await page.evaluate(() => {
    let webglVendor = '', webglRenderer = '';
    try {
      const gl = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      webglVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
      webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    } catch (e) { webglRenderer = 'ERR:' + e.message; }
    return {
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      webglVendor, webglRenderer,
      screenX: window.screenX, screenY: window.screenY,
      hidden: document.hidden, visibility: document.visibilityState, hasFocus: document.hasFocus(),
      hasChrome: !!window.chrome, plugins: navigator.plugins.length, platform: navigator.platform,
    };
  });
  await browser.close();

  const checks = [
    ['navigator.webdriver is false/undefined', fp.webdriver === false || fp.webdriver === undefined],
    ['UA has no "HeadlessChrome"', !/Headless/i.test(fp.userAgent)],
    ['WebGL renderer is NOT SwiftShader/llvmpipe', !/swiftshader|llvmpipe/i.test(fp.webglRenderer)],
    ['WebGL renderer present (GPU active)', !!fp.webglRenderer && !/^ERR/.test(fp.webglRenderer)],
    ['screenX patched (== 80, not -32000)', fp.screenX === 80],
    ['document.hidden == false', fp.hidden === false],
    ['visibilityState == visible', fp.visibility === 'visible'],
    ['document.hasFocus() == true', fp.hasFocus === true],
    ['window.chrome present', fp.hasChrome === true],
    ['navigator.plugins present', fp.plugins > 0],
  ];
  console.log('mode:', hidden ? 'HIDDEN (off-screen)' : 'VISIBLE');
  console.log(JSON.stringify(fp, null, 2));
  let pass = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (ok) pass++; }
  console.log(`\n${pass}/${checks.length} fingerprint checks passed`);
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(2); });
