// lib/browser.js
// THE single Puppeteer launch path for the entire app. EVERY browser must be launched via launchStealth so
// anti-automation hardening is applied UNIFORMLY and can never be forgotten in a new call site. Do NOT call
// puppeteer.launch directly anywhere else.
//
// What it guarantees on every launch:
//   - REAL Chrome/Edge (lib/chromium.chromiumPath) — never Puppeteer's detectable "Chrome for Testing".
//   - ignoreDefaultArgs ['--enable-automation'] — removes the "Chrome is controlled by automated test
//     software" banner AND the flag Facebook uses to bot-flag the login (→ captcha loop / "incorrect").
//   - the anti-detection arg set (BASE_ARGS) + the puppeteer-extra stealth plugin (navigator.webdriver, etc).
//
// Callers pass ONLY what varies: headless, userDataDir, defaultViewport, protocolTimeout, and any extra args
// (proxy --proxy-server, --window-position, --mute-audio, WebRTC guard, …). Those merge with BASE_ARGS.
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// We launch REAL, headful Chrome — which already emits its OWN coherent User-Agent, UA Client Hints, and
// locale. The stealth plugin's 'user-agent-override' evasion (built for OLD headless Chromium) FORGES those:
// it pins Accept-Language + navigator.languages to 'en-US,en' and synthesizes 2022-era UA-CH onto Chrome 149,
// producing an INCONSISTENT fingerprint Facebook flags (endless captcha) — even on the real IP. Dropping that
// one evasion lets Chrome be itself (real locale/UA-CH); the rest of stealth (webdriver, etc.) stays on.
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('user-agent-override');
puppeteer.use(stealth);
const { chromiumPath } = require('./chromium');

// The ONE source of truth for "look like a normal Chrome". Applied to every launch.
// NOTE: no --no-sandbox — a normal desktop Chrome never runs with it (it's a CI/Docker artifact + shows a
// banner + is an automation-correlated tell). Chrome sandboxes fine on a normal Windows desktop without it.
const BASE_ARGS = [
  '--disable-blink-features=AutomationControlled', // hide navigator.webdriver
  // WebRTC IP-leak guard, CENTRALIZED here so EVERY launchStealth caller gets it (login, status-check, browse, worker,
  // moderator, rescue, repost) — it was previously a per-call-site arg the login/check/browse paths forgot, leaking the
  // REAL host IP via ICE candidates at the most anti-bot-sensitive moment. Forces WebRTC/STUN through the proxy + drops
  // host LAN/WAN candidates. Harmless with no proxy. (launchStealth dedups, so the worker/moderator/etc copies are fine.)
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-crash-restore-bubble',
  // Cap on-disk cache per browser so hundreds of long-lived profiles don't grow to tens of GB and exhaust a client
  // laptop's SSD (→ writeFileAtomic ENOSPC → posting dies fleet-wide). Cache is regenerated at runtime, never identity.
  // The worker already set these in its own args; centralizing here also covers login/moderator/rescue/repost/status.
  '--disk-cache-size=52428800',  // 50 MB
  '--media-cache-size=10485760', // 10 MB
];

// Per-account viewport — a STABLE pick (seeded by the account name) from a pool of common real-world desktop
// resolutions. Use the SAME value for --window-size, defaultViewport, AND the off-screen park bounds so a window's
// inner/outer dimensions stay consistent (a mismatch is itself a fingerprint). Stable per account (never looks
// anomalous across runs), distinct between accounts (so many accounts hitting the same groups don't all report the
// IDENTICAL 1280x900 — a cross-account link). Posting/login click coords are computed live (getBoundingClientRect),
// so they adapt to whatever size this returns.
const _VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
];
function viewportFor(name) {
  const s = String(name || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return _VIEWPORTS[h % _VIEWPORTS.length];
}

async function launchStealth(opts = {}) {
  const { args = [], ...rest } = opts;
  return puppeteer.launch({
    ...rest, // headless, userDataDir, defaultViewport, protocolTimeout, …
    // These three are ALWAYS enforced here (a caller can't override or forget them):
    executablePath: chromiumPath(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: [...new Set([...BASE_ARGS, ...args])],
  });
}

// Apply per-account/proxy GEO consistency (timezone + locale) so a PROXIED browser's clock + locale match its proxy IP
// region — a mismatch is a strong FB correlation/bot signal. These are CDP overrides, NOT forging: the values come from
// the operator's per-account / per-proxy config (account.timezone || settings.proxyTimezone, account.locale ||
// settings.proxyLocale); unset = NO override (the host value, which is correct for a real-IP account). Centralized here
// so EVERY launch path (worker / moderator / rescue / repost / login / status-check) applies it identically — no leaks.
async function applyProxyGeo(page, account, settings, useProxies, proxies, log) {
  try {
    const proxied = !!((account && account.proxy) || (useProxies && proxies && proxies.length));
    if (!page || !proxied) return;
    const tz = String((account && account.timezone) || (settings && settings.proxyTimezone) || '').trim();
    const loc = String((account && account.locale) || (settings && settings.proxyLocale) || '').trim();
    if (!tz && !loc) {
      // LOUD, do NOT silently leak: a proxied browser with no timezone/locale reports the HOST clock+language over a
      // foreign proxy IP — an incoherent context FB can use to force a re-login. We never INVENT one (that would forge
      // and could mismatch the IP further); we warn so the operator sets it. (readiness.js + the Start preflight flag it too.)
      if (log) log(`⚠️ proxied but no timezone/locale set → browser reports the HOST clock/language over the proxy IP (a mismatch that can trigger re-login). Set proxyTimezone + proxyLocale (Settings), or per account.`);
      return;
    }
    const cdp = await page.target().createCDPSession();
    if (tz) { try { await cdp.send('Emulation.setTimezoneOverride', { timezoneId: tz }); if (log) log(`🕒 timezone → ${tz}`); } catch (e) { if (log) log(`⚠️ timezone override failed (${e.message})`); } }
    if (loc) {
      // navigator.language + navigator.languages + the Accept-Language header must ALL match the proxy locale. CDP
      // Emulation.setLocaleOverride alone does NOT change navigator.language (verified empirically — it only touches
      // navigator.languages), leaving language=host: a WORSE inconsistency than no override. setUserAgentOverride with
      // the page's OWN real UA (passed back UNCHANGED — not forging it, just attaching acceptLanguage; Chrome then
      // derives matching UA-CH from that same real UA) sets language+languages+header together; setLocaleOverride then
      // aligns Intl date/number formatting. Applied BEFORE the caller navigates, so it's in effect when FB loads.
      try {
        const realUA = await page.browser().userAgent();
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: realUA, acceptLanguage: loc });
        await cdp.send('Emulation.setLocaleOverride', { locale: loc });
        if (log) log(`🌐 locale → ${loc}`);
      } catch (e) { if (log) log(`⚠️ locale override failed (${e.message})`); }
    }
  } catch {}
}

// Cover POPUPS / new tabs too. applyProxyGeo only overrides the page it is handed, so if Facebook spawns a NEW target
// (a popup, a checkpoint tab, a target=_blank link) mid-session it would report the HOST timezone/locale. This attaches
// a listener that applies the SAME proxy geo to every new page the browser opens. Best-effort (a popup may navigate
// before the async override lands) and only worth attaching on long-lived browsers (the worker); short single-page
// flows (login / status-check / moderator / rescue / repost) rarely spawn extra targets.
function attachGeoToNewTargets(browser, account, settings, useProxies, proxies, log) {
  try {
    browser.on('targetcreated', async (target) => {
      try {
        if (target && target.type && target.type() !== 'page') return;
        const p = await target.page();
        if (p) await applyProxyGeo(p, account, settings, useProxies, proxies, log);
      } catch {}
    });
  } catch {}
}

module.exports = { launchStealth, BASE_ARGS, puppeteer, viewportFor, applyProxyGeo, attachGeoToNewTargets };
