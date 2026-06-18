// scripts/test-comment.js — add the first-comment to an already-published post.
// node scripts/test-comment.js <account> <groupId> <postIndex>
const fs = require('fs'), path = require('path');
const store = require('../lib/store');
const { addFirstComment, normalizeCookie } = require('../automation/worker');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());

const ACC = process.argv[2] || 'account17';
const GID = process.argv[3] || '1805238113111247';
const IDX = parseInt(process.argv[4] || '1', 10);
const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
store.init(ROOT);
const post = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8')).posts[IDX];

(async () => {
  const cookies = store.readCookies(ACC);
  const HEADLESS = process.argv[5] !== 'headful';
  const browser = await puppeteer.launch({ headless: HEADLESS, userDataDir: store.profileDir(ACC),
    defaultViewport: { width: 1300, height: 950 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--window-size=1300,950'] });
  const page = (await browser.pages())[0];
  try { await page.setCookie(...cookies.map(normalizeCookie)); } catch {}
  await page.goto(`https://www.facebook.com/groups/${GID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));
  // step(message) logger — addFirstComment tags every stage itself.
  const step = (m) => console.log(new Date().toISOString().slice(11, 19), `[${ACC}]`, m);
  const ok = await addFirstComment(page, GID, post, null, step);
  console.log('comment result:', ok);
  await browser.close();
  process.exit(0);
})();
