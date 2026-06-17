// scripts/inspect-comment.js  —  node scripts/inspect-comment.js <account> <groupId>
// Read-only: open the group, find the top post, and dump its comment UI (Comment
// button + comment textbox) before and after clicking Comment. No posting.

const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const store = require('../lib/store');
const ACC = process.argv[2] || 'account17';
const GID = process.argv[3] || '1805238113111247';
const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
store.init(ROOT);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (c) => { const o = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }; if (c.expires > 0) o.expires = c.expires; if (typeof c.secure === 'boolean') o.secure = c.secure; const s = String(c.sameSite || '').toLowerCase(); o.sameSite = s === 'lax' ? 'Lax' : s === 'strict' ? 'Strict' : 'None'; return o; };

const probe = () => {
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const labels = (re) => uniq(Array.from(document.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label')).filter(l => re.test(l))).slice(0, 25);
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]')).slice(0, 10)
    .map(e => ({ role: e.getAttribute('role') || '', ariaLabel: (e.getAttribute('aria-label') || '').slice(0, 60), ph: (e.getAttribute('aria-placeholder') || '').slice(0, 60) }));
  const arts = Array.from(document.querySelectorAll('div[role="article"]')).slice(0, 5).map(a => (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').slice(0, 70));
  return {
    articles: document.querySelectorAll('div[role="article"]').length,
    articleTexts: arts,
    commentLabels: labels(/comment/i),
    writeLabels: labels(/write|leave a/i),
    editables,
  };
};

(async () => {
  const cookies = JSON.parse(fs.readFileSync(store.cookiesFile(ACC), 'utf8'));
  const browser = await puppeteer.launch({ headless: true, userDataDir: store.profileDir(ACC), args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = (await browser.pages())[0];
  try { await page.setCookie(...cookies.map(norm)); } catch {}
  await page.goto(`https://www.facebook.com/groups/${GID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  console.log('BEFORE click:', JSON.stringify(await page.evaluate(probe), null, 1));
  // Try clicking the first post's Comment button
  const clicked = await page.evaluate(() => {
    const art = document.querySelector('div[role="article"]') || document;
    const btn = Array.from(art.querySelectorAll('[role="button"]')).find(e => /^comment$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()));
    if (btn) { btn.click(); return true; } return false;
  });
  console.log('clicked Comment button:', clicked);
  await sleep(3000);
  console.log('AFTER click:', JSON.stringify(await page.evaluate(probe), null, 1));
  await browser.close();
})();
