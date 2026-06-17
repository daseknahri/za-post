// scripts/test-profile-auth.js
// Decisive auth test: launch from an EXISTING Chromium profile (no setCookie),
// handle the "Continue as <name>" account picker, and report whether we reach a
// logged-in feed + a member composer in the target group. CAPTURE ONLY.
//
//   node scripts/test-profile-auth.js "<absolute profile dir>" <groupId>

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());

const PROFILE = process.argv[2];
const GROUP_ID = process.argv[3] || '1748733925593266';
const OUT = path.join(__dirname, 'fb-recon');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let browser;
  const rep = {};
  try {
    browser = await puppeteer.launch({
      headless: false, userDataDir: PROFILE, defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--window-size=1300,950'],
    });
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);

    // Handle "Continue as <name>" profile picker if present.
    const picker = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a,div[role="button"],button'))
        .find((e) => /^continue$|continue as/i.test((e.textContent || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    rep.pickerClicked = picker;
    if (picker) { await sleep(5000); }
    await page.screenshot({ path: path.join(OUT, 'A-home.png') }).catch(() => {});

    rep.homeUrl = page.url();
    rep.loggedIn = await page.evaluate(() =>
      !!document.querySelector('[aria-label="Create a post"], [aria-label*="What\'s on your mind"], [role="navigation"] [aria-label*="Profile"], a[href*="/me/"]')
      && !/login|checkpoint/.test(location.href));

    // Group composer presence
    await page.goto(`https://www.facebook.com/groups/${GROUP_ID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    await page.screenshot({ path: path.join(OUT, 'B-group.png') }).catch(() => {});
    rep.group = await page.evaluate(() => {
      const has = (re) => Array.from(document.querySelectorAll('[role="button"],span,div'))
        .some((e) => re.test((e.textContent || '')));
      return {
        url: location.href,
        hasWriteSomething: has(/write something|what'?s on your mind/i),
        hasJoinGroup: has(/^join group$/i),
        hasLogIn: has(/^log in$/i),
        isMemberLikely: has(/write something/i) && !has(/^join group$/i),
      };
    });
  } catch (e) { rep.error = e.message; }
  finally { if (browser) await browser.close().catch(() => {}); }

  fs.writeFileSync(path.join(OUT, 'profile-auth.json'), JSON.stringify(rep, null, 2));
  console.log(JSON.stringify(rep, null, 2));
})();
