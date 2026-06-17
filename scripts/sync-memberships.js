// scripts/sync-memberships.js — node scripts/sync-memberships.js <account>
// For a LOGGED-IN account, checks each assigned group and prunes assignedGroups in
// data.json to only the groups the account can actually post in (is a member of).
// Skips (without changing data) if the account isn't authenticated.

const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const store = require('../lib/store');
const { normalizeCookie } = require('../automation/worker');

const ACC = process.argv[2] || 'account17';
const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
store.init(ROOT);
const DATA = path.join(ROOT, 'data.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const acct = data.accounts.find(a => a.name === ACC);
  if (!acct) { console.log('no such account:', ACC); process.exit(1); }
  const assigned = (acct.assignedGroups || []).map(id => data.groups.find(g => g.id === id || g.groupId === id)).filter(Boolean);
  if (!assigned.length) { console.log(`${ACC} has no assigned groups`); process.exit(0); }
  const cookies = store.readCookies(ACC);

  const browser = await puppeteer.launch({ headless: true, userDataDir: store.profileDir(ACC), defaultViewport: { width: 1280, height: 1000 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = (await browser.pages())[0];

  // auth bootstrap: prefer profile session, fall back to cookies
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(2500);
  let authed = await page.evaluate(() => !/login|checkpoint/.test(location.href) && !/continue as|use another profile/i.test(document.body.innerText || '')).catch(() => false);
  if (!authed && cookies.length) {
    try { await page.setCookie(...cookies.map(normalizeCookie)); } catch {}
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2000);
    authed = await page.evaluate(() => !/continue as|use another profile/i.test(document.body.innerText || '') && !/login|checkpoint/.test(location.href)).catch(() => false);
  }
  if (!authed) { console.log(`⚠️ ${ACC} not authenticated — log it in first; data unchanged.`); await browser.close(); process.exit(0); }

  console.log(`${ACC} (${acct.alias}) — checking ${assigned.length} assigned group(s):`);
  const member = [];
  for (const g of assigned) {
    try {
      await page.goto(`https://www.facebook.com/groups/${g.groupId || g.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(4000);
      const r = await page.evaluate(() => {
        const has = (re) => Array.from(document.querySelectorAll('[role="button"],span,a')).some(e => re.test((e.textContent || '').trim()));
        return { write: has(/write something|what'?s on your mind/i), join: has(/^join group$/i) };
      });
      const isM = r.write && !r.join;
      console.log(`  ${isM ? '✅ member ' : '❌ not-member'} | ${g.name}`);
      if (isM) member.push(g.id);
    } catch (e) { console.log(`  ⚠️ error | ${g.name}: ${e.message}`); member.push(g.id); /* keep on error */ }
  }
  await browser.close();

  acct.assignedGroups = member;
  fs.writeFileSync(DATA + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(DATA + '.tmp', DATA);
  console.log(`✔ Synced ${ACC}: assignedGroups now ${member.length} group(s) it can post in.`);
  process.exit(0);
})();
