// scripts/test-open.js — does worker.openComposer open the dialog? + dump Post button.
const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const store = require('../lib/store');
const W = require('../automation/worker');
const ACC = process.argv[2] || 'account1', GID = process.argv[3] || '1748733925593266';
const ROOT = path.join(process.env.APPDATA, 'za-post-restored'); store.init(ROOT);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
const post = data.posts[0] || { caption: 'hello', imagePaths: [] };

(async () => {
  const cookies = store.readCookies(ACC);
  const browser = await puppeteer.launch({ headless: false, userDataDir: store.profileDir(ACC), defaultViewport: { width: 1300, height: 1100 }, protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--window-size=1320,1120'] });
  const page = (await browser.pages())[0];
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(2000);
  let authed = await page.evaluate(() => !/continue as|use another profile|login|checkpoint/i.test(document.body.innerText + location.href)).catch(() => false);
  if (!authed && cookies.length) { try { await page.setCookie(...cookies.map(W.normalizeCookie)); } catch {} }
  await page.goto(`https://www.facebook.com/groups/${GID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000); await W.dismissPopups(page);

  const opened = await W.openComposer(page, (m) => console.log(' ', m), ACC);
  console.log('openComposer ->', opened);
  if (opened) {
    const img = (post.imagePaths || [])[0];
    if (img && fs.existsSync(img)) { const inp = await page.$('div[role="dialog"] input[type="file"]'); if (inp) { await inp.uploadFile(img); await sleep(3500); } }
    await W.focusEditable(page); await W.humanType(page, post.caption || 'test'); await sleep(1500);
    const state = await page.evaluate(() => {
      const d = document.querySelector('div[role="dialog"]');
      const btns = d ? Array.from(d.querySelectorAll('[role="button"]')).map(b => ({ l: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 20), dis: b.getAttribute('aria-disabled') || 'false' })) : [];
      return { editableText: d ? Array.from(d.querySelectorAll('[contenteditable="true"]')).map(e => (e.textContent || '').slice(0, 25)) : [], postBtn: btns.filter(b => /^post$/i.test(b.l)) };
    });
    console.log('caption in box:', JSON.stringify(state.editableText));
    console.log('POST BUTTON:', JSON.stringify(state.postBtn));
    const clicked = await W.clickPostButton(page);
    console.log('clickPostButton ->', clicked);
  }
  await browser.close(); process.exit(0);
})();
