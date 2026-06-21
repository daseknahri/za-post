'use strict';
// MOD — the MODERATOR phase. A designated admin account approves OUR poster accounts' posts that
// Facebook held in the group "Spam potentiel" / pending queue, so the post goes live and the first
// comment can land. Fail-closed: it only ever acts on a card whose AUTHOR matches one of our accounts'
// FB display names AND whose CAPTION matches a held post from THIS cycle.
//
// THIS VERSION IS DRY-RUN: it navigates the queues, decides the match, and LOGS what it WOULD approve,
// but never clicks. It's the instrumentation gate — we refine the queue URLs/DOM from these logs, then
// enable the real "Publier" click in MOD-4. Gated by settings.moderationEnabled upstream.
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const store = require('../lib/store');
const { chromiumPath } = require('../lib/chromium');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
async function evalTimed(page, fn, arg, ms = 8000) {
  let t; const p = page.evaluate(fn, arg); p.catch(() => {});
  const cap = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('evaluate timeout')), ms); });
  try { return await Promise.race([p, cap]); } finally { clearTimeout(t); }
}

// o: { account (the moderator), groups, settings, held (records), posterNames (FB display names of our
// poster accounts), log, shouldStop }. Returns { approved, scanned, notMine, errors, noRetry, flag }.
async function runModerator(o) {
  const { account, groups, held, log } = o;
  const shouldStop = o.shouldStop || (() => false);
  const name = account.name;
  const out = { approved: 0, scanned: 0, notMine: 0, errors: 0, unmatched: 0, noRetry: false, flag: null, dryRun: true };
  const ourNames = [...new Set((o.posterNames || []).map(norm).filter((n) => n && n.length >= 2))];
  const groupName = (gid) => { const g = (groups || []).find((x) => (x.groupId || x.id) === gid); return (g && g.name) || gid; };
  let browser = null;
  try {
    log(`🛡️ [moderator:${name}] approval phase starting — DRY-RUN (scan + log, NO clicks). our names: [${ourNames.join(', ') || '(none captured — set fbDisplayName on the accounts)'}]`);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromiumPath(),
      userDataDir: store.profileDir(name),
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000',
        '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--mute-audio'],
      defaultViewport: { width: 1280, height: 900 },
      protocolTimeout: 90000,
    });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    // Probe the moderator session — NEVER auto-login (it's the operator's trusted admin account).
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2500);
    const loggedIn = await evalTimed(page, () => {
      const t = (document.body.innerText || '').slice(0, 500).toLowerCase();
      const loginGate = /log in to facebook|connexion|create new account|cr[ée]er un compte/.test(t) && document.querySelector('input[name="email"], input[name="pass"]');
      return !loginGate;
    }, null, 6000).catch(() => false);
    if (!loggedIn) { log(`⚠️ [moderator:${name}] not logged in — approval skipped this cycle (log this account in from the Accounts tab)`); out.flag = 'needs_login'; out.noRetry = true; return out; }

    // Only scan groups that actually have held posts this cycle.
    const heldByGid = {};
    for (const h of (held || [])) { if (h && h.gid) (heldByGid[h.gid] = heldByGid[h.gid] || []).push(h); }
    const targetGids = Object.keys(heldByGid);
    log(`🛡️ [moderator:${name}] ${targetGids.length} group(s) have held posts to review`);

    for (const gid of targetGids) {
      if (shouldStop()) break;
      const capSnips = heldByGid[gid].map((h) => norm(h.captionSnip)).filter(Boolean); // worker already gated length≥12
      const gname = groupName(gid);
      if (!capSnips.length) { log(`🛡️ [moderator] [${gname}] ${heldByGid[gid].length} held record(s) but no usable caption snippet — skipping (cannot match safely)`); out.errors++; continue; }
      // Best-effort queue URLs (refine from the logs). Validate a queue indicator before scanning so
      // we NEVER fall through to the public feed and approve there.
      const urls = [
        `https://www.facebook.com/groups/${gid}/pending_posts`,
        `https://www.facebook.com/groups/${gid}/spam?sorting_setting=SPAM_POTENTIAL`,
        `https://www.facebook.com/groups/${gid}/spam`,
      ];
      let onQueue = false;
      for (const url of urls) {
        if (shouldStop()) break;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(3000);
        const info = await evalTimed(page, () => {
          const t = (document.body.innerText || '').toLowerCase();
          const isQ = /pending|publications en attente|en attente|spam|potentiel|à vérifier|a verifier|to review|awaiting/.test(t);
          return { isQ, title: (document.title || '').slice(0, 70), url: (location.href || '').slice(0, 95) };
        }, null, 6000).catch(() => null);
        if (info && info.isQ) { onQueue = true; log(`🛡️ [moderator] [${gname}] queue OK — ${info.url}`); break; }
        log(`🛡️ [moderator] [${gname}] not a queue (${info ? info.url : url} · title="${info ? info.title : '?'}") — trying next URL`);
      }
      if (!onQueue) { log(`🛡️ [moderator] [${gname}] no queue page found — skipping (refine queue URLs from this log)`); out.errors++; continue; }

      // Scan held cards. DRY-RUN: decide the (author AND caption) match, log it, DO NOT click.
      const scan = await evalTimed(page, (arg) => {
        const { ours, snips } = arg;
        const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const cards = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]')).slice(0, 25);
        const results = [];
        for (const c of cards) {
          const txt = (c.innerText || '').replace(/\s+/g, ' ').trim();
          if (!txt) continue;
          const aEl = c.querySelector('a[href*="/user/"], a[href*="/people/"], a[href*="profile.php"], h3 a, h4 a, strong a, span strong');
          let author = aEl ? aEl.textContent : (txt.split('·')[0] || '');
          author = nm(author).slice(0, 50);
          const body = nm(txt);
          const authorOurs = !!author && ours.includes(author); // strict normalized equality, never substring
          const capMatch = snips.some((s) => s && (body.includes(s) || (s.length >= 28 && body.startsWith(s.slice(0, 28))))); // full-snip contains, or a long (≥28ch) prefix — avoids boilerplate-prefix collisions
          const hasApprove = Array.from(c.querySelectorAll('[role="button"], button')).some((b) => /publ|appro/.test(nm(b.getAttribute('aria-label') || b.textContent)));
          results.push({ author, authorOurs, capMatch, hasApprove, snippet: txt.slice(0, 70) });
        }
        return { count: cards.length, results };
      }, { ours: ourNames, snips: capSnips }, 12000).catch(() => null);

      if (!scan) { log(`🛡️ [moderator] [${gname}] scan failed (selector/timeout) — dumping nothing; refine selectors`); out.errors++; continue; }
      out.scanned += scan.count;
      log(`🛡️ [moderator] [${gname}] scanned ${scan.count} card(s)`);
      let matchedThisGroup = 0;
      for (let i = 0; i < scan.results.length; i++) {
        const r = scan.results[i];
        if (r.authorOurs && r.capMatch) { out.approved++; matchedThisGroup++; log(`🛡️ [moderator] [${gname}] card ${i + 1}: author="${r.author}" ours=✓ caption=✓ approveBtn=${r.hasApprove} → WOULD APPROVE (dry-run): "${r.snippet}"`); }
        else { out.notMine++; log(`🛡️ [moderator] [${gname}] card ${i + 1}: author="${r.author}" ours=${r.authorOurs} caption=${r.capMatch} → skip: "${r.snippet}"`); }
      }
      // Reconcile against the held records we were handed: surface any held post we could NOT find a card
      // for (FB already approved/removed it, it's past the first 25 scanned, or it never rendered) so a
      // dropped held post is visible, not silent.
      const heldCount = heldByGid[gid].length;
      if (matchedThisGroup < heldCount) {
        const miss = heldCount - matchedThisGroup; out.unmatched += miss;
        log(`⚠️ [moderator] [${gname}] ${miss} of ${heldCount} held post(s) had NO matching card in the queue (already approved/removed, beyond the first 25 scanned, or not rendered) — they remain 'held'.`);
      }
    }
    log(`🛡️ [moderator:${name}] DRY-RUN complete — scanned=${out.scanned} would-approve=${out.approved} skipped=${out.notMine} unmatched=${out.unmatched} errors=${out.errors}. (No posts were approved — this is the dry run; review the lines above, then we enable the click.)`);
    return out;
  } catch (e) {
    log(`❌ [moderator:${name}] ${e.message}`); out.errors++; return out;
  } finally {
    try { if (browser) await Promise.race([browser.close().catch(() => {}), sleep(8000)]); } catch {}
  }
}

module.exports = { runModerator };
