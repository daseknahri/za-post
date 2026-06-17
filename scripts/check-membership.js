// scripts/check-membership.js  —  node scripts/check-membership.js [account]
// For the given account, checks membership/postability of each ASSIGNED group.
// CAPTURE ONLY (no posting). Fast (no inter-group delays).

const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const ACC = process.argv[2] || 'account17';
const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (c) => { const o = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }; if (c.expires > 0) o.expires = c.expires; if (typeof c.secure === 'boolean') o.secure = c.secure; const s = String(c.sameSite || '').toLowerCase(); o.sameSite = s === 'lax' ? 'Lax' : s === 'strict' ? 'Strict' : 'None'; return o; };

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const acct = data.accounts.find(a => a.name === ACC) || {};
  const groups = (acct.assignedGroups || []).map(id => data.groups.find(g => g.id === id || g.groupId === id)).filter(Boolean);
  const cookies = JSON.parse(fs.readFileSync(path.join(ROOT, 'accounts', ACC, 'cookies.json'), 'utf8'));
  const browser = await puppeteer.launch({ headless: true, userDataDir: path.join(ROOT, 'accounts', ACC, 'chrome-profile'),
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = (await browser.pages())[0];
  try { await page.setCookie(...cookies.map(norm)); } catch {}
  console.log(`${ACC} (${acct.alias}) — ${groups.length} assigned group(s):`);
  for (const g of groups) {
    try {
      await page.goto(`https://www.facebook.com/groups/${g.groupId || g.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(4000);
      const r = await page.evaluate(() => {
        const has = (re) => Array.from(document.querySelectorAll('[role="button"],span,div,a')).some(e => re.test((e.textContent || '').trim()));
        return { write: has(/write something|what'?s on your mind|start a discussion/i), join: has(/^join group$/i), login: has(/^log in$/i) };
      });
      const member = r.write && !r.join;
      console.log(`  ${member ? '✅ MEMBER ' : '❌ not-member'} | ${g.name}  (write=${r.write} join=${r.join} login=${r.login})  id=${g.groupId || g.id}`);
    } catch (e) { console.log(`  ⚠️ error | ${g.name}: ${e.message}`); }
  }
  await browser.close();
})();
