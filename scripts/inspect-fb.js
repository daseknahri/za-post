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
    // E-P2: the "share to / select groups / post-to destination" UI — what we need to detect so a
    // post can never be sprayed to the wrong group(s). Match destination/audience/group-select text.
    shareTargets: collect('[role="button"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="listitem"], div[aria-label]').filter((e) =>
      /post to|share to|share now|select group|choose group|your groups|audience|anyone|public|members|where do you want|more places|publier dans|partager dans|publicar en|compartir en|gruppen|teilen in/i.test(e.text || e.ariaLabel)),
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
      // E-P2 recon: ON-SCREEN so you can manually open the "Post to / share to groups" picker and the
      // final dump captures it. This script NEVER clicks the final Post — it is capture-only.
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=60,40', '--window-size=1300,950'],
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

      // 5) E-P2: type a caption to enable Post and surface the "Post to / share to" destination
      //    selector, then capture it. NEVER clicks Post — capture-only.
      try {
        const ed = await page.$('div[role="dialog"] [contenteditable="true"], div[role="dialog"] [role="textbox"]');
        if (ed) { await ed.click({ delay: 30 }).catch(() => {}); await page.keyboard.type('recon test — do not post', { delay: 20 }); await sleep(2500); }
      } catch {}
      await page.screenshot({ path: path.join(OUT_DIR, '4-with-caption.png') }).catch(() => {});
      report.steps.withCaptionProbe = await page.evaluate(probe);
      fs.writeFileSync(path.join(OUT_DIR, 'composer-with-caption.html'),
        await page.evaluate(() => { const d = document.querySelector('div[role="dialog"]'); return d ? d.outerHTML.slice(0, 120000) : '(no dialog)'; }));

      // 6) Interactive window: MANUALLY open the "Post to" / audience / share-to-groups picker now.
      //    Held for 90s, screenshotting + dumping every 15s so whatever you reveal is captured.
      console.log('\n>>> A browser window is open. If you see a "Post to"/audience/destination control, CLICK it');
      console.log('    to reveal the group-selection list. Do NOT click the final Post. Capturing for 90s...\n');
      for (let k = 1; k <= 6; k++) {
        await sleep(15000);
        await page.screenshot({ path: path.join(OUT_DIR, `5-interactive-${k}.png`) }).catch(() => {});
        try {
          const html = await page.evaluate(() => Array.from(document.querySelectorAll('div[role="dialog"]')).map((d) => d.outerHTML.slice(0, 80000)).join('\n<!-- ===== next dialog ===== -->\n'));
          fs.writeFileSync(path.join(OUT_DIR, `interactive-${k}.html`), html || '(no dialog)');
          report.steps[`interactiveProbe${k}`] = await page.evaluate(probe);
        } catch {}
      }
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
