// scripts/inspect-fb.js
// LIVE Facebook DOM reconnaissance for selector tuning. CAPTURE ONLY — never posts.
// Logs in with a migrated account's cookies, opens a real assigned group's composer,
// and dumps candidate selectors + screenshots so the worker selectors can be hardened.
//
//   node scripts/inspect-fb.js [accountName]      (default: account1)

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const ACC = process.argv[2] || 'account1';
const ROOT = path.join(process.env.APPDATA, 'za-post-restored');
const OUT_DIR = path.join(__dirname, 'fb-recon');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeCookie(c) {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' };
  if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
  if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
  if (typeof c.secure === 'boolean') out.secure = c.secure;
  const ss = String(c.sameSite || '').toLowerCase();
  out.sameSite = ss === 'lax' ? 'Lax' : ss === 'strict' ? 'Strict' : 'None';
  return out;
}

// Serializable DOM probe run inside the page.
function probe() {
  const txt = (e) => (e.getAttribute('aria-label') || e.getAttribute('aria-placeholder') || (e.textContent || '').trim()).slice(0, 80);
  const css = (e) => {
    const parts = [];
    let n = e;
    for (let i = 0; n && i < 4; i++, n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      const role = n.getAttribute && n.getAttribute('role');
      if (role) s += `[role="${role}"]`;
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const collect = (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 25).map((e) => ({
    tag: e.tagName.toLowerCase(),
    role: e.getAttribute('role') || '',
    ariaLabel: e.getAttribute('aria-label') || '',
    ariaPlaceholder: e.getAttribute('aria-placeholder') || '',
    editable: e.getAttribute('contenteditable') || '',
    accept: e.getAttribute('accept') || '',
    type: e.getAttribute('type') || '',
    text: txt(e),
    path: css(e),
  }));
  return {
    url: location.href,
    dialogs: document.querySelectorAll('div[role="dialog"]').length,
    buttons: collect('[role="button"]').filter((b) => b.ariaLabel || b.text),
    fileInputs: collect('input[type="file"]'),
    editables: collect('[contenteditable="true"], [role="textbox"]'),
    composerTriggers: collect('[role="button"], span, div[role="button"]').filter((e) =>
      /write something|discussion|create.*post|photo\/video|what'?s on your mind/i.test(e.text)),
  };
}

(async () => {
  const report = { account: ACC, ts: new Date().toISOString(), steps: {} };
  const cookiesPath = path.join(ROOT, 'accounts', ACC, 'cookies.json');
  if (!fs.existsSync(cookiesPath)) { console.error('No cookies for', ACC); process.exit(1); }
  const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));

  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const acct = data.accounts.find((a) => a.name === ACC) || {};
  const gid0 = (acct.assignedGroups || [])[0];
  const group = data.groups.find((g) => g.id === gid0 || g.groupId === gid0) || data.groups[0];
  const groupId = group && (group.groupId || group.id);
  report.group = group;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: path.join(ROOT, 'accounts', ACC, 'chrome-profile'),
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--window-size=1300,950'],
    });
    const page = (await browser.pages())[0] || (await browser.newPage());
    try { await page.setCookie(...cookies.map(normalizeCookie)); } catch (e) { console.error('cookie load:', e.message); }

    // 1) login check
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);
    report.steps.loginUrl = page.url();
    report.steps.loggedIn = !/login|checkpoint/.test(page.url());
    await page.screenshot({ path: path.join(OUT_DIR, '1-home.png') }).catch(() => {});
    if (!report.steps.loggedIn) { console.log('NOT LOGGED IN ->', page.url()); }

    // 2) group page
    if (groupId) {
      await page.goto(`https://www.facebook.com/groups/${groupId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);
      report.steps.groupUrl = page.url();
      await page.screenshot({ path: path.join(OUT_DIR, '2-group.png') }).catch(() => {});
      report.steps.groupProbe = await page.evaluate(probe);

      // 3) try opening composer via the most likely trigger
      const trig = (report.steps.groupProbe.composerTriggers || [])[0];
      report.steps.triggerUsed = trig || null;
      const opened = await page.evaluate(() => {
        const cand = Array.from(document.querySelectorAll('[role="button"], div[role="button"], span'))
          .find((e) => /write something|discussion|what'?s on your mind/i.test((e.textContent || '')));
        if (cand) { cand.click(); return true; }
        return false;
      });
      report.steps.composerOpened = opened;
      await sleep(4000);
      await page.screenshot({ path: path.join(OUT_DIR, '3-composer.png') }).catch(() => {});
      report.steps.composerProbe = await page.evaluate(probe);

      // 4) dump the dialog HTML for offline analysis
      const dialogHtml = await page.evaluate(() => {
        const d = document.querySelector('div[role="dialog"]');
        return d ? d.outerHTML.slice(0, 60000) : '';
      });
      fs.writeFileSync(path.join(OUT_DIR, 'composer-dialog.html'), dialogHtml || '(no dialog)');
    }
  } catch (e) {
    report.error = e.message;
    console.error('ERROR:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('LOGGED IN:', report.steps.loggedIn, '| group:', report.group && report.group.name);
  console.log('composer opened:', report.steps.composerOpened, '| dialogs:', report.steps.composerProbe && report.steps.composerProbe.dialogs);
  console.log('report ->', path.join(OUT_DIR, 'report.json'));
})();
