'use strict';
// lib/geo.js — detect a proxy's real-world GEO (IANA timezone + BCP-47 locale) by routing a lookup THROUGH the proxy
// to a geo-IP service. This is what lets applyProxyGeo align each PROXIED account's browser clock+language to its
// proxy IP region (a mismatch is a strong FB correlation signal) WITHOUT the operator knowing each proxy's region.
// One lookup per proxy; results are cached on the account (timezone/locale) + a settings.proxyGeo map.
const axios = (() => { try { return require('axios'); } catch { return null; } })();
let proxyChain = null; try { proxyChain = require('proxy-chain'); } catch {}
const { parseProxy } = require('../automation/worker'); // ONE proxy parser (scheme/auth/socks) shared with the engine

// ISO-3166 country code → a reasonable PRIMARY BCP-47 locale. Covers the common proxy countries; an unknown code
// falls back to 'en-US' (a neutral default that still beats leaking the HOST language). Override per account if needed.
const CC_LOCALE = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', IE: 'en-IE', NZ: 'en-NZ', ZA: 'en-ZA', IN: 'en-IN', PK: 'en-PK', PH: 'en-PH', NG: 'en-NG', SG: 'en-SG',
  FR: 'fr-FR', BE: 'fr-BE', LU: 'fr-LU', DE: 'de-DE', AT: 'de-AT', CH: 'de-CH', ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', CO: 'es-CO', CL: 'es-CL', PE: 'es-PE',
  IT: 'it-IT', NL: 'nl-NL', PT: 'pt-PT', BR: 'pt-BR', RU: 'ru-RU', UA: 'uk-UA', PL: 'pl-PL', RO: 'ro-RO', CZ: 'cs-CZ', HU: 'hu-HU', GR: 'el-GR', BG: 'bg-BG',
  SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', TR: 'tr-TR', IL: 'he-IL', SA: 'ar-SA', AE: 'ar-AE', EG: 'ar-EG', MA: 'ar-MA', DZ: 'ar-DZ', TN: 'ar-TN',
  ID: 'id-ID', MY: 'ms-MY', TH: 'th-TH', VN: 'vi-VN', JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK',
};

// Look up ONE proxy's geo. Returns { ok:true, timezone, locale, countryCode, ip } or { ok:false, error }.
// Fail-safe: any parse/network/tunnel error returns { ok:false } (never throws) so the caller can skip that proxy.
async function detectProxyGeo(proxyStr) {
  if (!axios) return { ok: false, error: 'axios unavailable' };
  const pp = parseProxy(proxyStr);
  if (!pp) return { ok: false, error: 'unparseable proxy string' };
  let anon = null, proxyOpt = null;
  try {
    // Tunnel via proxy-chain so http, socks5 AND authenticated proxies all work through one local HTTP hop.
    if (proxyChain) anon = await proxyChain.anonymizeProxy(pp.upstream).catch(() => null);
    if (anon) { const u = new URL(anon); proxyOpt = { host: u.hostname, port: Number(u.port), protocol: 'http' }; }
    else { // fallback: a plain (non-socks) HTTP proxy, auth via axios.proxy.auth
      const u = new URL(pp.server);
      proxyOpt = { host: u.hostname, port: Number(u.port), protocol: 'http' };
      if (pp.username) proxyOpt.auth = { username: pp.username, password: pp.password || '' };
    }
    // ip-api's free endpoint is HTTP-only (no key) and returns the IANA timezone + ISO country for the request's
    // EXIT IP — which, routed through the proxy, is the PROXY's IP. 15s cap so a dead proxy can't hang the sweep.
    const r = await axios.get('http://ip-api.com/json/?fields=status,message,timezone,countryCode,query', { proxy: proxyOpt, timeout: 15000 });
    const d = (r && r.data) || {};
    if (d.status !== 'success' || !d.timezone) return { ok: false, error: d.message || 'geo lookup failed' };
    const cc = String(d.countryCode || '').toUpperCase();
    return { ok: true, timezone: d.timezone, countryCode: cc, locale: CC_LOCALE[cc] || 'en-US', ip: d.query || '' };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  finally { if (anon && proxyChain) { try { await proxyChain.closeAnonymizedProxy(anon, true).catch(() => {}); } catch {} } } // free the local port (bounded)
}

module.exports = { detectProxyGeo, CC_LOCALE };
