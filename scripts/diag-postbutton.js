// scripts/diag-postbutton.js  —  node scripts/diag-postbutton.js <account> <groupId> <postIndex>
// Replicates the worker's exact flow up to (NOT including) clicking Post, then dumps
// every button in the composer dialog + a screenshot, so we can see why "Post" isn't found.

const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const store = require('../lib/store');
const W = require('../automation/worker');

const ACC = process.argv[2] || 'account1';
const GID = process.argv[3] || '1748733925593266';
const IDX = parseInt(process.argv[4] || '0', 10);
const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
store.init(ROOT);
const OUT = path.join(__dirname, 'fb-recon'); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const post = data.posts[IDX] || { caption: 'test', imagePaths: [] };

(async () => {
  const cookies = store.readCookies(ACC);
  const browser = await puppeteer.launch({ headless: false, userDataDir: store.profileDir(ACC),
    defaultViewport: { width: 1300, height: 1100 }, protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--window-size=1320,1120'] });
  const page = (await browser.pages())[0];

  // auth bootstrap (profile or cookies)
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(2500);
  let authed = await page.evaluate(() => !/login|checkpoint/.test(location.href) && !/continue as|use another profile/i.test(document.body.innerText || '')).catch(() => false);
  if (!authed && cookies.length) { try { await page.setCookie(...cookies.map(W.normalizeCookie)); } catch {} await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' }).catch(() => {}); await sleep(2000); }

  await page.goto(`https://www.facebook.com/groups/${GID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  const member = await page.evaluate(() => {
    const has = (re) => Array.from(document.querySelectorAll('[role="button"],span,a')).some(e => re.test((e.textContent || '').trim()));
    return { write: has(/write something|what'?s on your mind/i), join: has(/^join group$/i), login: has(/^log in$/i) };
  });
  console.log('MEMBERSHIP:', JSON.stringify(member));

  await W.dismissPopups(page);
  let opened = await W.clickFirst(page, ['[role="button"][aria-label*="Write"]', '[aria-placeholder*="Write something"]'], 6000);
  if (!opened) opened = await W.openComposerByText(page);
  console.log('composer opened:', opened);
  await sleep(2500);
  await W.dismissPopups(page);

  // attach image + caption (same as worker)
  const img = (post.imagePaths || [])[0];
  if (img && fs.existsSync(img)) { const inp = await page.$('input[type="file"]'); if (inp) { await inp.uploadFile(img); await sleep(3500); } }
  if (post.caption) { await W.focusEditable(page); await W.humanType(page, post.caption); await sleep(1500); }

  await page.screenshot({ path: path.join(OUT, 'E-composer.png') });
  const dump = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
    const out = { dialogCount: dialogs.length, buttons: [] };
    const scope = dialogs.length ? dialogs : [document];
    for (const d of scope) {
      for (const b of Array.from(d.querySelectorAll('[role="button"]'))) {
        const label = (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30);
        if (label) out.buttons.push({ label, disabled: b.getAttribute('aria-disabled') || 'false' });
      }
    }
    out.buttons = out.buttons.slice(0, 40);
    out.hasEditableWithText = Array.from(document.querySelectorAll('div[role="dialog"] [contenteditable="true"]')).map(e => (e.textContent || '').trim().slice(0, 25));
    return out;
  });
  console.log('DIALOGS:', dump.dialogCount);
  console.log('EDITABLE TEXT:', JSON.stringify(dump.hasEditableWithText));
  console.log('BUTTONS:', JSON.stringify(dump.buttons));
  await browser.close();
  process.exit(0);
})();
