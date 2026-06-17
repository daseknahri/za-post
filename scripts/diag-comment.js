// scripts/diag-comment.js — deep diagnostic of the comment UI. Screenshots + dumps.
const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const store = require('../lib/store');
const ACC = process.argv[2] || 'account17';
const GID = process.argv[3] || '1805238113111247';
const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
store.init(ROOT);
const OUT = path.join(__dirname, 'fb-recon'); fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (c) => { const o = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }; if (c.expires > 0) o.expires = c.expires; if (typeof c.secure === 'boolean') o.secure = c.secure; const s = String(c.sameSite || '').toLowerCase(); o.sameSite = s === 'lax' ? 'Lax' : s === 'strict' ? 'Strict' : 'None'; return o; };

const dump = () => {
  const ed = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]')).map(e => ({ role: e.getAttribute('role') || '', al: (e.getAttribute('aria-label') || '').slice(0, 50), ph: (e.getAttribute('aria-placeholder') || '').slice(0, 50) }));
  const cbtn = Array.from(document.querySelectorAll('[role="button"]')).filter(e => /comment/i.test(e.getAttribute('aria-label') || e.textContent || '')).map(e => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40));
  return { editables: ed, commentButtons: [...new Set(cbtn)].slice(0, 12), articles: document.querySelectorAll('div[role="article"]').length };
};

(async () => {
  const cookies = store.readCookies(ACC);
  const browser = await puppeteer.launch({ headless: true, userDataDir: store.profileDir(ACC), defaultViewport: { width: 1300, height: 1200 }, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = (await browser.pages())[0];
  try { await page.setCookie(...cookies.map(norm)); } catch {}
  await page.goto(`https://www.facebook.com/groups/${GID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(8000);
  await page.screenshot({ path: path.join(OUT, 'C-feed.png') });
  console.log('BEFORE:', JSON.stringify(await page.evaluate(dump)));
  const clicked = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('[role="button"]')).find(e => /comment/i.test(e.getAttribute('aria-label') || e.textContent || '')); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return (b.getAttribute('aria-label') || b.textContent || '').trim(); } return null; });
  console.log('clicked button:', clicked);
  await sleep(3500);
  await page.screenshot({ path: path.join(OUT, 'C-after.png') });
  console.log('AFTER:', JSON.stringify(await page.evaluate(dump)));
  await browser.close();
})();
