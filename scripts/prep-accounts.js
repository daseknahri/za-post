// scripts/prep-accounts.js  —  batch account readiness check + membership sync.
//   node scripts/prep-accounts.js                 # all accounts
//   node scripts/prep-accounts.js account1 account5 account17   # a subset
//   node scripts/prep-accounts.js enabled         # only enabled accounts
//
// For each account: auth-check (profile session or cookies), then for each assigned
// group check membership and PRUNE assignedGroups to only postable groups. Writes the
// updated statuses + assignments to data.json and prints a readiness summary.
// Sequential (one browser at a time) to avoid profile locks / resource exhaustion.

const fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const store = require('../lib/store');
const { normalizeCookie } = require('../automation/worker');

const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
store.init(ROOT);
const DATA = path.join(ROOT, 'data.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const args = process.argv.slice(2);
  let targets = data.accounts;
  if (args.length && args[0] === 'enabled') targets = data.accounts.filter(a => a.enabled !== false);
  else if (args.length) targets = data.accounts.filter(a => args.includes(a.name));

  console.log(`Preparing ${targets.length} account(s)…\n`);
  const summary = { ready: [], needLogin: [], noGroups: [], error: [] };

  for (const acct of targets) {
    const name = acct.name;
    const assigned = (acct.assignedGroups || []).map(id => data.groups.find(g => g.id === id || g.groupId === id)).filter(Boolean);
    let browser;
    try {
      try { fs.rmSync(path.join(store.profileDir(name), 'lockfile'), { force: true }); } catch {}
      browser = await puppeteer.launch({ headless: true, userDataDir: store.profileDir(name), defaultViewport: { width: 1200, height: 900 }, protocolTimeout: 60000,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
      const page = (await browser.pages())[0];
      const cookies = store.readCookies(name);
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(2500);
      let authed = await page.evaluate(() => !/login|checkpoint/.test(location.href) && !/continue as|use another profile/i.test(document.body.innerText || '')).catch(() => false);
      if (!authed && cookies.length) {
        try { await page.setCookie(...cookies.map(normalizeCookie)); } catch {}
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(2000);
        authed = await page.evaluate(() => !/continue as|use another profile/i.test(document.body.innerText || '') && !/login|checkpoint/.test(location.href)).catch(() => false);
      }
      if (!authed) {
        acct.status = 'not_logged_in'; acct.lastMessage = 'Session expired — re-login required';
        summary.needLogin.push(`${name}(${acct.alias || ''})`);
        console.log(`  ⚠️  ${name} — NOT logged in`);
        await browser.close(); continue;
      }
      acct.status = 'logged_in'; acct.lastMessage = 'Active';
      const member = [];
      for (const g of assigned) {
        await page.goto(`https://www.facebook.com/groups/${g.groupId || g.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(3500);
        const r = await page.evaluate(() => {
          const has = (re) => Array.from(document.querySelectorAll('[role="button"],span,a')).some(e => re.test((e.textContent || '').trim()));
          return { write: has(/write something|what'?s on your mind/i), join: has(/^join group$/i) };
        }).catch(() => ({ write: false, join: true }));
        if (r.write && !r.join) member.push(g.id);
      }
      acct.assignedGroups = member;
      await browser.close();
      if (member.length) { summary.ready.push(`${name}(${acct.alias || ''}):${member.length}grp`); console.log(`  ✅ ${name} — READY (${member.length} postable group(s))`); }
      else { summary.noGroups.push(`${name}(${acct.alias || ''})`); console.log(`  🟡 ${name} — logged in but 0 postable groups`); }
    } catch (e) {
      summary.error.push(`${name}: ${e.message}`); console.log(`  ❌ ${name} — ${e.message}`);
      try { if (browser) await browser.close(); } catch {}
    }
    // persist after each account so progress survives interruption
    fs.writeFileSync(DATA + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(DATA + '.tmp', DATA);
    await sleep(800);
  }

  console.log('\n=== READINESS SUMMARY ===');
  console.log(`READY (post now):    ${summary.ready.length}  ${summary.ready.join(', ')}`);
  console.log(`NEEDS LOGIN:         ${summary.needLogin.length}  ${summary.needLogin.join(', ')}`);
  console.log(`LOGGED IN, NO GROUPS:${summary.noGroups.length}  ${summary.noGroups.join(', ')}`);
  console.log(`ERRORS:              ${summary.error.length}  ${summary.error.join(', ')}`);
  process.exit(0);
})();
