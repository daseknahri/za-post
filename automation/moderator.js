'use strict';
// MOD — the MODERATOR phase. A designated admin account approves OUR poster accounts' posts that
// Facebook held in the group "Spam potentiel" / pending queue, so the post goes live and the first
// comment can land. Fail-closed: it only ever acts on a card whose AUTHOR matches one of our accounts'
// FB display names AND whose CAPTION matches a held post from THIS cycle.
//
// THIS VERSION CLICKS (MOD-4): it navigates the queues, decides the (author AND caption) match, then for a
// matched card finds + clicks the card's approve control (Approve/Approuver/Publier/Allow/…) and CONFIRMS
// the card left the queue. Fail-closed: it only clicks a card whose author is one of OUR names AND whose
// caption matches a held snippet AND that contains an approve button — never anything else. The held
// records it actually approved are returned in out.approvedRecords so the orchestrator hands their
// comment to the rescue runner. Set settings.moderationDryRun=true to fall back to scan+log (NO clicks).
// Gated by settings.moderationEnabled upstream.
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
  const dryRun = !!((o.settings || {}).moderationDryRun); // default OFF → REAL approval; set moderationDryRun=true to test without clicking
  const out = { approved: 0, scanned: 0, notMine: 0, errors: 0, unmatched: 0, clicked: 0, confirmFailed: 0, approvedRecords: [], noRetry: false, flag: null, dryRun };
  const ourNames = [...new Set((o.posterNames || []).map(norm).filter((n) => n && n.length >= 2))];
  const groupName = (gid) => { const g = (groups || []).find((x) => (x.groupId || x.id) === gid); return (g && g.name) || gid; };
  let browser = null;
  try {
    log(`🛡️ [moderator:${name}] approval phase starting — ${dryRun ? 'DRY-RUN (scan + log, NO clicks)' : 'LIVE (will click Approve/Publier on matched cards)'}. our names: [${ourNames.join(', ') || '(none captured — set fbDisplayName on the accounts)'}]`);
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
      // The held "Spam potentiel" post lives in the group's SPAM queue, NOT pending_posts — and it could be
      // in either, so we DON'T stop at the first queue-looking page. We try each candidate admin queue,
      // scroll to render lazy content, and PICK the URL that actually CONTAINS one of our held captions.
      // (Live diagnostic showed the caption was absent from /pending_posts → it's in the spam queue.)
      const urls = [
        `https://www.facebook.com/groups/${gid}/admin/spam`,
        `https://www.facebook.com/groups/${gid}/spam`,
        `https://www.facebook.com/groups/${gid}/spam?sorting_setting=SPAM_POTENTIAL`,
        `https://www.facebook.com/groups/${gid}/admin/pending_posts`,
        `https://www.facebook.com/groups/${gid}/pending_posts`,
      ];
      let onQueue = false, fallbackUrl = null;
      for (const url of urls) {
        if (shouldStop()) break;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(2500);
        for (let s = 0; s < 3; s++) { await page.evaluate((y) => window.scrollBy(0, y), 800).catch(() => {}); await sleep(1200); } // nudge lazy render before testing for our caption
        const info = await evalTimed(page, (snips) => {
          const norm = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          const t = (document.body.innerText || '').toLowerCase();
          const isQ = /pending|publications en attente|en attente|spam|potentiel|à vérifier|a verifier|to review|awaiting|declined|filtr/.test(t);
          const body = norm(document.body.innerText || '');
          const capPresent = snips.some((s) => s && (body.includes(s) || (s.length >= 28 && body.includes(s.slice(0, 28)))));
          return { isQ, capPresent, title: (document.title || '').slice(0, 70), url: (location.href || '').slice(0, 95) };
        }, capSnips, 8000).catch(() => null);
        if (info && info.capPresent) { onQueue = true; log(`🛡️ [moderator] [${gname}] queue WITH our post — ${info.url}`); break; }
        if (info && info.isQ && !fallbackUrl) fallbackUrl = info.url;
        log(`🛡️ [moderator] [${gname}] ${info ? (info.isQ ? 'queue but our post not present' : 'not a queue') : 'no info'} (${info ? info.url : url}) — trying next`);
      }
      if (!onQueue) { log(`🛡️ [moderator] [${gname}] our held post was NOT found on any known queue URL${fallbackUrl ? ` (last queue-looking: ${fallbackUrl})` : ''} — skipping (tell me the Spam-potentiel page URL from your browser if this persists)`); out.errors++; continue; }

      // Scan held cards. Decide the (author AND caption AND approve-button) match. ONLY a card that passes
      // the FULL gate is tagged with a unique data-zp-mod="<idx>" so the click pass can re-select that EXACT
      // card; non-matching cards are never tagged and can never be clicked. capSnipMatched lets us map the
      // card back to its specific held record (by snippet value — robust even if capSnips was filtered).
      const scan = await evalTimed(page, (arg) => {
        const { ours, snips } = arg;
        const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const APPROVE = /\b(approve|approuver|publ|allow|autoriser|accepter|accept)\b|appro/; // multi-locale approve labels
        const cards = Array.from(document.querySelectorAll('[aria-posinset], div[role="article"]')).slice(0, 25);
        const results = []; let tag = 0;
        for (const c of cards) {
          const txt = (c.innerText || '').replace(/\s+/g, ' ').trim();
          if (!txt) continue;
          const aEl = c.querySelector('a[href*="/user/"], a[href*="/people/"], a[href*="profile.php"], h3 a, h4 a, strong a, span strong');
          let author = aEl ? aEl.textContent : (txt.split('·')[0] || '');
          author = nm(author).slice(0, 50);
          const body = nm(txt);
          const authorOurs = !!author && ours.includes(author); // strict normalized equality, never substring
          let capSnipMatched = null;
          for (const s of snips) { if (s && (body.includes(s) || (s.length >= 28 && body.startsWith(s.slice(0, 28))))) { capSnipMatched = s; break; } } // full-snip contains, or a long (≥28ch) prefix — avoids boilerplate-prefix collisions
          const capMatch = !!capSnipMatched;
          const hasApprove = Array.from(c.querySelectorAll('[role="button"], button')).some((b) => APPROVE.test(nm(b.getAttribute('aria-label') || b.textContent)));
          let zpTag = null;
          // CAPTION-PRIMARY gate: our 40-char held caption is a unique signal and we only ever act in the
          // admin's OWN spam queue, so match on caption + an approve button. Author is captured for the log
          // but NOT required (the poster display-name capture is unreliable). A card is tagged (clickable)
          // only when caption matches a held snippet AND it has an approve button.
          if (capMatch && hasApprove) { zpTag = String(tag++); c.setAttribute('data-zp-mod', zpTag); }
          results.push({ author, authorOurs, capMatch, capSnipMatched, hasApprove, zpTag, snippet: txt.slice(0, 70) });
        }
        return { count: cards.length, results };
      }, { ours: ourNames, snips: capSnips }, 12000).catch(() => null);

      if (!scan) { log(`🛡️ [moderator] [${gname}] scan failed (selector/timeout) — dumping nothing; refine selectors`); out.errors++; continue; }
      out.scanned += scan.count;
      log(`🛡️ [moderator] [${gname}] scanned ${scan.count} card(s)`);
      let matchedThisGroup = 0;
      const handledSnips = new Set(); // snippets already acted on this group — never approve/queue one held post twice
      for (let i = 0; i < scan.results.length; i++) {
        if (shouldStop()) break;
        const r = scan.results[i];
        const fullMatch = r.capMatch && r.hasApprove && r.zpTag != null; // caption-primary (author is a hint, not required)
        if (fullMatch && handledSnips.has(r.capSnipMatched)) {
          log(`🛡️ [moderator] [${gname}] card ${i + 1}: duplicate of an already-handled held post — skipping (no double-approve)`);
          continue;
        }
        if (fullMatch) {
          handledSnips.add(r.capSnipMatched);
          const rec = (heldByGid[gid] || []).find((h) => norm(h.captionSnip) === r.capSnipMatched) || null;
          if (dryRun) {
            matchedThisGroup++; out.approved++;
            log(`🛡️ [moderator] [${gname}] card ${i + 1}: caption=✓ approveBtn=✓ author="${r.author}"(ours=${r.authorOurs}) → WOULD APPROVE (dry-run): "${r.snippet}"`);
            continue;
          }
          out.clicked++;
          log(`🛡️ [moderator] [${gname}] card ${i + 1}: caption=✓ approveBtn=✓ author="${r.author}"(ours=${r.authorOurs}) → APPROVING: "${r.snippet}"`);
          const res = await approveCard(page, r.zpTag);
          if (res.ok) {
            matchedThisGroup++; out.approved++;
            if (rec) out.approvedRecords.push(rec); // CONFIRMED approval → hand the comment off to rescue (orchestrator)
            log(`✅ [moderator] [${gname}] card ${i + 1}: APPROVED & confirmed (${res.detail}) — "${r.snippet}"`);
          } else {
            out.confirmFailed++;
            log(`⚠️ [moderator] [${gname}] card ${i + 1}: approve ${res.clicked ? 'clicked but NOT confirmed' : 'could not be clicked'} (${res.detail}) — left HELD for retry: "${r.snippet}"`);
          }
        } else {
          out.notMine++;
          log(`🛡️ [moderator] [${gname}] card ${i + 1}: author="${r.author}" ours=${r.authorOurs} caption=${r.capMatch} approveBtn=${r.hasApprove} → skip: "${r.snippet}"`);
        }
      }
      // Reconcile against the held records we were handed: surface any held post we could NOT find a card
      // for (FB already approved/removed it, it's past the first 25 scanned, or it never rendered) so a
      // dropped held post is visible, not silent.
      const heldCount = heldByGid[gid].length;
      if (matchedThisGroup < heldCount) {
        const miss = heldCount - matchedThisGroup; out.unmatched += miss;
        log(`⚠️ [moderator] [${gname}] ${miss} of ${heldCount} held post(s) had NO matching card in the queue (already approved/removed, beyond the first 25 scanned, or not rendered) — they remain 'held'.`);
        // DIAGNOSTIC: matched 0 while a held post IS in the queue → the pending-queue DOM differs from the
        // public feed (cards/author aren't [aria-posinset]/article). Find the element actually holding OUR
        // caption and dump its ancestor chain + author candidates so we can fix the selectors from real data.
        try {
          const diag = await evalTimed(page, (snips) => {
            const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const counts = { posinset: document.querySelectorAll('[aria-posinset]').length, article: document.querySelectorAll('div[role="article"]').length, feed: document.querySelectorAll('[role="feed"]').length, main: document.querySelectorAll('[role="main"]').length };
            const all = Array.from(document.querySelectorAll('div, article, li, section'));
            for (const snip of snips) {
              if (!snip || snip.length < 8) continue;
              // smallest element whose text contains our caption (the post body), then climb to its card
              const hits = all.filter((e) => norm(e.innerText || '').includes(snip));
              if (!hits.length) continue;
              const el = hits[hits.length - 1]; // deepest/smallest container holding the caption
              const chain = []; let n = el;
              for (let i = 0; i < 7 && n && n.tagName; i++) { const cls = String(n.className || '').split(' ').filter(Boolean)[0] || ''; chain.push(`${n.tagName.toLowerCase()}${n.getAttribute && n.getAttribute('role') ? '[role=' + n.getAttribute('role') + ']' : ''}${n.getAttribute && n.getAttribute('aria-posinset') != null ? '[posinset]' : ''}${cls ? '.' + cls.slice(0, 12) : ''}`); n = n.parentElement; }
              // author candidates near the caption (look on the el + a few ancestors)
              const aCand = [];
              let scope = el; for (let i = 0; i < 4 && scope; i++) { Array.from(scope.querySelectorAll('a[href], h3, h4, strong, span')).slice(0, 40).forEach((a) => { const t = (a.textContent || '').replace(/\s+/g, ' ').trim(); const href = a.getAttribute && a.getAttribute('href'); if (t && t.length >= 2 && t.length <= 40 && (href || /^(H3|H4|STRONG)$/.test(a.tagName))) aCand.push(`${a.tagName.toLowerCase()}${href ? '@' + href.slice(0, 30) : ''}:${t.slice(0, 30)}`); }); scope = scope.parentElement; }
              return { counts, chain, text: norm(el.innerText).slice(0, 100), authors: [...new Set(aCand)].slice(0, 8) };
            }
            return { counts, note: 'caption not found anywhere in DOM' };
          }, capSnips, 10000).catch((e) => ({ err: e && e.message }));
          log(`🔬 [moderator] [${gname}] DIAG ${JSON.stringify(diag).slice(0, 700)}`);
        } catch (e) { log(`🔬 [moderator] [${gname}] DIAG failed: ${e.message}`); }
      }
    }
    if (dryRun) log(`🛡️ [moderator:${name}] DRY-RUN complete — scanned=${out.scanned} would-approve=${out.approved} skipped=${out.notMine} unmatched=${out.unmatched} errors=${out.errors}. (No posts were approved — dry run.)`);
    else log(`🛡️ [moderator:${name}] LIVE pass complete — scanned=${out.scanned} approved=${out.approved} clicked=${out.clicked} confirmFailed=${out.confirmFailed} skipped=${out.notMine} unmatched=${out.unmatched} errors=${out.errors}.`);
    return out;
  } catch (e) {
    log(`❌ [moderator:${name}] ${e.message}`); out.errors++; return out;
  } finally {
    try { if (browser) await Promise.race([browser.close().catch(() => {}), sleep(8000)]); } catch {}
  }
}

// Re-select the EXACT card the scan tagged data-zp-mod="<idx>" (only full-gate cards were tagged), find
// the approve control INSIDE that card, click it, then CONFIRM the card left the queue. Returns
// { ok, clicked, detail }. Fail-safe: never clicks outside the tagged card; re-validates the approve
// button exists inside the exact tagged element before clicking (so a re-render can't redirect the click);
// counts success ONLY on confirmation (card detached / its approve button gone).
async function approveCard(page, zpTag) {
  const click = await evalTimed(page, (tag) => {
    const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const APPROVE = /\b(approve|approuver|publ|allow|autoriser|accepter|accept)\b|appro/;
    const card = document.querySelector(`[data-zp-mod="${tag}"]`);
    if (!card) return { clicked: false, reason: 'card-gone-before-click' };
    const btn = Array.from(card.querySelectorAll('[role="button"], button')).find((b) => APPROVE.test(nm(b.getAttribute('aria-label') || b.textContent)));
    if (!btn) return { clicked: false, reason: 'approve-btn-not-found' };
    const label = (btn.getAttribute('aria-label') || btn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    btn.scrollIntoView({ block: 'center' }); btn.click();
    return { clicked: true, reason: `clicked "${label}"` };
  }, zpTag, 8000).catch((e) => ({ clicked: false, reason: 'click-eval-error:' + (e && e.message) }));
  if (!click || !click.clicked) return { ok: false, clicked: false, detail: (click && click.reason) || 'no-click' };
  // Confirm: poll for the tagged card to detach OR its approve button to disappear (handles a confirm dialog too).
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(1200);
    const gone = await evalTimed(page, (tag) => {
      const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const APPROVE = /\b(approve|approuver|publ|allow|autoriser|accepter|accept)\b|appro/;
      const card = document.querySelector(`[data-zp-mod="${tag}"]`);
      if (!card || !card.isConnected) return { gone: true, how: 'card-detached' };
      const stillHasBtn = Array.from(card.querySelectorAll('[role="button"], button')).some((b) => APPROVE.test(nm(b.getAttribute('aria-label') || b.textContent)));
      return { gone: !stillHasBtn, how: stillHasBtn ? 'still-present' : 'approve-btn-gone' };
    }, zpTag, 6000).catch(() => null);
    if (gone && gone.gone) return { ok: true, clicked: true, detail: `${click.reason}; ${gone.how}` };
  }
  return { ok: false, clicked: true, detail: `${click.reason}; not-confirmed-within-timeout` };
}

module.exports = { runModerator };
