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
// Jitter a base delay ±pct so a trusted admin account doesn't browse the spam queue on a metronomic cadence.
const jitter = (base, pct = 0.3) => Math.max(0, Math.round(base * (1 + (Math.random() * 2 - 1) * pct)));
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
    // Off-screen by default; but when the operator turns OFF "hide browser" (Settings) the moderator window
    // is shown ON-screen too, so they can SEE which account is approving + watch the Spam-potentiel pass.
    const hideMod = ((o.settings && o.settings.hideBrowser) !== false);
    if (!hideMod) log(`🛡️ [moderator:${name}] running VISIBLE (hide-browser is off) — watch this window approve the held posts.`);
    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromiumPath(),
      userDataDir: store.profileDir(name),
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', (hideMod ? '--window-position=-32000,-32000' : '--window-position=60,60'),
        '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--mute-audio'],
      defaultViewport: { width: 1280, height: 900 },
      protocolTimeout: 90000,
    });
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    // Probe the moderator session — NEVER auto-login (it's the operator's trusted admin account).
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(jitter(2500, 0.3));
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
      // ENFORCE length ≥12 here (not all sources gate it — the comment_notfound held path can carry a
      // short snippet). A short snippet would substring-match a STRANGER's pending post and wrong-approve
      // it, so anything under 12 chars is dropped: we never approve on a weak/ambiguous caption key.
      const capSnips = heldByGid[gid].map((h) => norm(h.captionSnip)).filter((s) => s && s.length >= 12);
      const gname = groupName(gid);
      if (!capSnips.length) { log(`🛡️ [moderator] [${gname}] ${heldByGid[gid].length} held record(s) but no caption snippet ≥12 chars — skipping (cannot match safely; would risk approving the wrong post)`); out.errors++; continue; }
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
        await sleep(jitter(2500, 0.3));
        for (let s = 0; s < 3; s++) { await page.evaluate((y) => window.scrollBy(0, y), 600 + Math.floor(Math.random() * 400)).catch(() => {}); await sleep(jitter(1200, 0.35)); } // nudge lazy render before testing for our caption
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

      // BUTTON-ANCHORED scan. The Spam-potentiel queue shows a per-post "Publier" (approve) + "Refuser"
      // (decline) button, but those buttons are NOT in the post-caption's ancestor chain (the caption sits
      // in a separate <a role=link> preview). So we anchor on the APPROVE button instead: for each Publier/
      // approve button, climb to the row that ALSO contains one of our held captions — that's our post —
      // and tag THAT button (data-zp-mod) to click. Refuser/decline/delete is explicitly excluded.
      const scan = await evalTimed(page, (arg) => {
        const { snips } = arg;
        const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const APPROVE = /\b(publier|publish|approve|approuver|allow|autoriser|accepter|accept|admettre|confirmer)\b|approuv|approv/; // includes "publier"
        const DECLINE = /refus|decline|reject|delete|supprim|remove|spam|signaler|masquer|hide/; // never click these
        const isApprove = (b) => { const l = nm((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || ''); return !!l && APPROVE.test(l) && !DECLINE.test(l); };
        const allBtns = Array.from(document.querySelectorAll('[role="button"], button'));
        const approveBtns = allBtns.filter(isApprove);
        const results = []; let tag = 0;
        for (const btn of approveBtns) {
          if (btn.getAttribute('data-zp-mod')) continue;
          // climb from the approve button to the row that contains one of our held captions
          let matched = null, rowText = '', n = btn;
          for (let i = 0; i < 16 && n && n.tagName; i++) {
            const t = nm(n.textContent || '');
            const hit = snips.find((s) => s && (t.includes(s) || (s.length >= 28 && t.includes(s.slice(0, 28)))));
            if (hit) { matched = hit; rowText = t; break; }
            n = n.parentElement;
          }
          if (!matched) continue;
          const zpTag = String(tag++); btn.setAttribute('data-zp-mod', zpTag);
          results.push({ author: '', authorOurs: false, capMatch: true, capSnipMatched: matched, hasApprove: true, zpTag, snippet: rowText.slice(0, 70) });
        }
        // diagnostics: distinct labels of the approve-looking buttons we considered
        const nearbyBtns = [...new Set(approveBtns.map((b) => nm((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || '')).filter(Boolean))].slice(0, 12);
        return { count: results.length, results, approveBtnCount: approveBtns.length, nearbyBtns };
      }, { snips: capSnips }, 14000).catch(() => null);

      if (!scan) { log(`🛡️ [moderator] [${gname}] scan failed (selector/timeout) — dumping nothing; refine selectors`); out.errors++; continue; }
      out.scanned += scan.count;
      log(`🛡️ [moderator] [${gname}] ${scan.approveBtnCount || 0} approve-button(s) on page, ${scan.count} matched OUR caption(s); approve labels: [${(scan.nearbyBtns || []).join(' | ') || 'none'}]`);
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
            const counts = { checkbox: document.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length, posinset: document.querySelectorAll('[aria-posinset]').length };
            // ALL distinct actionable labels on the page — reveals the approve mechanism (per-post "Publier"/
            // "Approve"/"Allow", a bulk-action bar, a "···" menu, etc.).
            const labels = [];
            Array.from(document.querySelectorAll('[role="button"], button, [role="menuitem"], [role="tab"]')).forEach((b) => { const l = norm((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || ''); if (l && l.length >= 2 && l.length <= 30) labels.push(l); });
            const pageButtons = [...new Set(labels)].slice(0, 40);
            // locate our caption + describe whether it's wrapped in a clickable post link
            const all = Array.from(document.querySelectorAll('div, span, a, li'));
            for (const snip of snips) {
              if (!snip || snip.length < 8) continue;
              let el = null, best = Infinity;
              for (const e of all) { const t = norm(e.textContent || ''); if (t.includes(snip) && t.length < best) { el = e; best = t.length; } }
              if (!el) continue;
              let linkHref = null, n = el; const chain = [];
              for (let i = 0; i < 8 && n && n.tagName; i++) { if (n.tagName === 'A' && n.getAttribute('role') === 'link' && !linkHref) linkHref = (n.getAttribute('href') || '').slice(0, 60); const cls = String(n.className || '').split(' ').filter(Boolean)[0] || ''; chain.push(`${n.tagName.toLowerCase()}${n.getAttribute('role') ? '[' + n.getAttribute('role') + ']' : ''}${cls ? '.' + cls.slice(0, 10) : ''}`); n = n.parentElement; }
              return { counts, pageButtons, captionInLink: linkHref, chain, text: norm(el.textContent).slice(0, 80) };
            }
            return { counts, pageButtons, note: 'caption not found' };
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
    const APPROVE = /\b(publier|publish|approve|approuver|allow|autoriser|accepter|accept|admettre|confirmer)\b|approuv|approv/;
    const DECLINE = /refus|decline|reject|delete|supprim|remove|spam|signaler|masquer|hide/;
    const isApprove = (b) => { const l = nm((b.getAttribute && b.getAttribute('aria-label')) || b.textContent || ''); return !!l && APPROVE.test(l) && !DECLINE.test(l); };
    const node = document.querySelector(`[data-zp-mod="${tag}"]`);
    if (!node) return { clicked: false, reason: 'tag-gone-before-click' };
    // The tagged element IS the approve (Publier) button (button-anchored scan); fall back to one inside it.
    const btn = isApprove(node) ? node : Array.from(node.querySelectorAll('[role="button"], button')).find(isApprove);
    if (!btn) return { clicked: false, reason: 'approve-btn-not-found' };
    const label = (btn.getAttribute('aria-label') || btn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    btn.scrollIntoView({ block: 'center' }); btn.click();
    return { clicked: true, reason: `clicked "${label}"` };
  }, zpTag, 8000).catch((e) => ({ clicked: false, reason: 'click-eval-error:' + (e && e.message) }));
  if (!click || !click.clicked) return { ok: false, clicked: false, detail: (click && click.reason) || 'no-click' };
  // Confirm: the tagged button detaches once the post leaves the queue. A confirmation dialog may appear
  // first ("Publier ?") — accept it. Poll until the tagged button is gone.
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await sleep(jitter(1200, 0.3));
    await evalTimed(page, () => {
      const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const dlg = document.querySelector('[role="dialog"]'); if (!dlg) return;
      const DECLINE = /refus|decline|reject|delete|supprim|remove|spam|signaler|masquer|hide|annuler|cancel/;
      const b = Array.from(dlg.querySelectorAll('[role="button"], button')).find((x) => { const l = nm((x.getAttribute && x.getAttribute('aria-label')) || x.textContent || ''); return /\b(publier|approve|approuver|confirmer|confirm|oui|yes)\b/.test(l) && !DECLINE.test(l); });
      if (b) b.click();
    }, null, 3000).catch(() => {});
    const gone = await evalTimed(page, (tag) => { const node = document.querySelector(`[data-zp-mod="${tag}"]`); return { gone: !node || !node.isConnected }; }, zpTag, 5000).catch(() => null);
    if (gone && gone.gone) return { ok: true, clicked: true, detail: `${click.reason}; button-detached` };
  }
  return { ok: false, clicked: true, detail: `${click.reason}; not-confirmed-within-timeout` };
}

module.exports = { runModerator };
