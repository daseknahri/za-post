#!/usr/bin/env node
// scripts/readiness.js — BIG-TEST readiness audit (READ-ONLY).
// Run before a large run to get a go/no-go on config: accounts logged in + have groups + a proxy, posts loaded
// and correctly tagged to the sets accounts reference, proxy spread (same-IP correlation), moderation/warmup/schedule.
// No writes. Reads the live data.json for the current brand (or pass an explicit path).
//
//   node scripts/readiness.js
//   node scripts/readiness.js "C:\\Users\\me\\AppData\\Roaming\\za-post-restored\\data.json"
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

function brandName() { try { return require('../lib/brand').brand().name || 'za-post'; } catch { return 'za-post'; } }
function dataPath() {
  if (process.argv[2]) return process.argv[2];
  const appData = process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE || '.', 'AppData', 'Roaming');
  return path.join(appData, brandName(), 'data.json');
}
const DATA = dataPath();
try { store.init(path.dirname(DATA)); } catch {} // enables store.loadRunCount — per-account warm-up progress lives in accounts/<name>/run-count.txt, NOT on the account object
let d;
try { d = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
catch (e) { console.error(`Could not read data.json (${e.code || e.message})\n  at ${DATA}\n  Pass the path explicitly: node scripts/readiness.js "<path-to-data.json>"`); process.exit(1); }

const accounts = d.accounts || [], groups = d.groups || [], posts = d.posts || [], settings = d.settings || {};
const proxies = d.proxies || [], useProxies = !!d.useProxies;
const posters = accounts.filter((a) => !a.isModerator && a.standby !== true);
const enabledPosters = posters.filter((a) => a.enabled !== false);
const moderators = accounts.filter((a) => a.isModerator);
const reserves = accounts.filter((a) => a.standby === true);
const loggedIn = (a) => a.status === 'logged_in';
const ipOf = (s) => { const m = String(s || '').match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/); return m ? m[1] : (String(s || '').split(/[@:]/).pop() || ''); };

const warns = [], blocks = [];
const W = (m) => warns.push(m), B = (m) => blocks.push(m);
const nameList = (arr) => arr.map((a) => a.name).join(', ');

console.log('================  BIG-TEST READINESS  ================');
console.log(`data.json: ${DATA}`);
console.log(`Accounts ${accounts.length} (enabled posters ${enabledPosters.length}, moderators ${moderators.length}, reserves ${reserves.length}) | Posts ${posts.length} | Groups ${groups.length} | Proxies ${proxies.length} | useProxies ${useProxies}`);

if (!enabledPosters.length) B('No enabled posting accounts.');
if (!posts.length) W('Post library is EMPTY — the run idles until posts are added (or fed via the remote API).');
if (!groups.length) B('No groups defined.');

// Logged in?
const notIn = enabledPosters.filter((a) => !loggedIn(a));
if (notIn.length) W(`${notIn.length} enabled poster(s) NOT logged in (will be skipped): ${nameList(notIn)}`);
// Of the not-logged-in accounts, which can NEVER auto-recover: no saved cookies AND no stored credentials, so
// Tier-2 (cookie inject) and Tier-3 (credential auto-login) both have nothing to use → permanently skipped, not just
// "log in once". Check the cookies.json FILE presence (a plain-node script can't decrypt Electron-safeStorage cookies,
// so readCookies would false-report empty — a raw file+size check is reliable). Credentials = both email + password set.
const stuck = notIn.filter((a) => {
  let hasCookieFile = false;
  try { const cf = store.cookiesFile(a.name); hasCookieFile = fs.existsSync(cf) && fs.statSync(cf).size > 2; } catch {}
  return !hasCookieFile && !(a.email && a.password);
});
if (stuck.length) W(`${stuck.length} not-logged-in account(s) have NEITHER saved cookies NOR stored credentials — they CANNOT auto-recover (permanently skipped until you log them in or add a password): ${nameList(stuck)}.`);

// Groups assigned + valid (assignedGroups may hold group.id OR group.groupId — match either)
const noGroups = enabledPosters.filter((a) => !(a.assignedGroups || []).length);
if (noGroups.length) W(`${noGroups.length} enabled poster(s) have NO assigned groups (post nothing): ${nameList(noGroups)}`);
const validKey = new Set(); groups.forEach((g) => { if (g.id) validKey.add(g.id); if (g.groupId) validKey.add(g.groupId); });
const danglers = enabledPosters.filter((a) => (a.assignedGroups || []).length && (a.assignedGroups || []).every((x) => !validKey.has(x)));
if (danglers.length) W(`${danglers.length} poster(s) reference group ids that no longer exist: ${nameList(danglers)}`);

// Post-sets: an account drawing from a set that has 0 matching posts will post nothing
const setCount = {}; posts.forEach((p) => { if (p.postSetId) setCount[p.postSetId] = (setCount[p.postSetId] || 0) + 1; });
const emptySet = enabledPosters.filter((a) => a.postSetId && !setCount[a.postSetId]);
if (emptySet.length) W(`${emptySet.length} enabled poster(s) are assigned a post-set with 0 posts (post nothing): ${nameList(emptySet)} — tag posts to the set (Posts tab) or clear the account's post-set.`);
const emptyCap = posts.filter((p) => !String(p.caption || '').trim());
if (emptyCap.length) W(`${emptyCap.length} post(s) have an EMPTY caption.`);

// Proxy spread / same-IP correlation
if (useProxies) {
  const withP = enabledPosters.filter((a) => a.proxy), noP = enabledPosters.filter((a) => !a.proxy);
  if (noP.length) W(`${noP.length} enabled poster(s) have NO proxy (post from the real host IP): ${nameList(noP)}`);
  const byIp = {}; withP.forEach((a) => { const ip = ipOf(a.proxy); (byIp[ip] = byIp[ip] || []).push(a.name); });
  const ipCount = Object.keys(byIp).length;
  console.log(`Proxy spread: ${withP.length} posters across ${ipCount} distinct IP(s)` + (ipCount ? ` (~${(withP.length / ipCount).toFixed(1)}/IP)` : ''));
  const heavy = Object.entries(byIp).filter(([, n]) => n.length >= 4);
  if (heavy.length) W(`${heavy.length} IP(s) carry ≥4 accounts — high same-IP correlation. Best mitigation is MORE proxies / fewer accounts per shared IP:` + heavy.map(([ip, n]) => `\n     • …${String(ip).slice(-6)}: ${n.length} (${n.join(', ')})`).join(''));
} else {
  W('useProxies is OFF — every account posts from this one machine IP (high correlation for a big test).');
}

// Moderation / warmup / schedule / timezone
if (settings.moderationEnabled) {
  if (!moderators.length) W('Moderator approval is ON but NO moderator account is set — held posts never get approved.');
  else if (!moderators.some(loggedIn)) W('Moderator approval is ON but the moderator is NOT logged in — held posts pile up.');
  if (settings.moderationDryRun) W('moderationDryRun is ON (test mode — approvals are simulated, not live).');
}
if (settings.enableWarmup) {
  const wr = Number(settings.warmupRuns || 0);
  const warming = enabledPosters.filter((a) => { try { return store.loadRunCount(a.name) < wr; } catch { return false; } });
  if (warming.length) W(`${warming.length} account(s) still WARMING (browse, don't post, until ${wr} runs done): ${nameList(warming)}`);
}
// Geo alignment (timezone + locale). applyProxyGeo (lib/browser.js) overrides a PROXIED browser's clock + language to
// match its proxy IP region — but ONLY when the value is set (account.timezone||proxyTimezone, account.locale||
// proxyLocale). An empty field is a SILENT leak: the proxied browser reports THIS machine's clock/language (host is
// Africa/Casablanca / fr-FR here), mismatching the proxy IP geo. A real-IP account is correctly left on the host
// values, so ONLY proxied accounts are flagged. The proxied test mirrors applyProxyGeo exactly, so this predicts
// whether the override will actually fire for each account.
{
  const isProxied = (a) => !!(a.proxy || (useProxies && proxies.length));
  const proxied = [...enabledPosters, ...moderators, ...reserves].filter(isProxied);
  const tzOf = (a) => String(a.timezone || settings.proxyTimezone || '').trim();
  const locOf = (a) => String(a.locale || settings.proxyLocale || '').trim();
  const noTz = proxied.filter((a) => !tzOf(a));
  const noLoc = proxied.filter((a) => !locOf(a));
  if (proxied.length) console.log(`Geo alignment: ${proxied.length - noTz.length}/${proxied.length} proxied account(s) have a timezone set, ${proxied.length - noLoc.length}/${proxied.length} have a locale set`);
  if (noTz.length) W(`${noTz.length} PROXIED account(s) have NO timezone (account.timezone or the global proxyTimezone) — their browser reports this machine's clock, mismatching the proxy IP geo: ${nameList(noTz)}. Set proxyTimezone (Settings) to your proxies' region.`);
  if (noLoc.length) W(`${noLoc.length} PROXIED account(s) have NO locale (account.locale or the global proxyLocale) — their browser reports this machine's language (host is French here), mismatching the proxy IP: ${nameList(noLoc)}. Set proxyLocale (Settings) to your proxies' language.`);
}
if (!reserves.length) W('No reserve (standby) accounts — a dropped account has no auto-takeover.');
// Per-GROUP reserve COVERAGE (campaign-plan failover): the orchestrator can only auto-cover a dropped agent's group
// with a reserve that is a MEMBER of that group (via a single in-cluster stand-in or split-cover). A reserve pool that
// exists but isn't assigned to a given group leaves a limit/logout there UNCOVERED until the account itself recovers —
// the exact "owed groups, no reserve" gap the run surfaces mid-cycle (better to know before the run). Campaign-plan
// only (unique/sequence/post-centric cover via the general undealt-post takeover, not group membership).
{
  const campaignAgents = enabledPosters.filter((a) => (a.postingOrder || '') === 'campaign-plan' && (a.assignedGroups || []).length);
  const healthyReserves = reserves.filter((r) => r.enabled !== false && (r.assignedGroups || []).length);
  if (campaignAgents.length && healthyReserves.length) {
    const reserveGroups = new Set(); healthyReserves.forEach((r) => (r.assignedGroups || []).forEach((g) => reserveGroups.add(g)));
    const activeGroups = new Set(); campaignAgents.forEach((a) => (a.assignedGroups || []).forEach((g) => activeGroups.add(g)));
    const gname = (gid) => { const g = groups.find((x) => x.id === gid || x.groupId === gid); return (g && g.name) || gid; };
    const uncovered = [...activeGroups].filter((g) => !reserveGroups.has(g));
    if (uncovered.length) W(`${uncovered.length} active group(s) have NO reserve assigned — a limit/logout of the account posting there is NOT auto-covered until it recovers: ${uncovered.map(gname).join(', ')}. Assign a reserve to these groups (Accounts tab).`);
  }
}

console.log('\n--- VERDICT ---');
if (blocks.length) { console.log('🛑 NOT READY:'); blocks.forEach((m) => console.log('   • ' + m)); }
if (warns.length) { console.log('⚠️  WARNINGS (non-blocking — the run can proceed):'); warns.forEach((m) => console.log('   • ' + m)); }
if (!blocks.length && !warns.length) console.log('✅ GO — no issues found.');
else if (!blocks.length) console.log('\n✅ No hard blockers — review the warnings above, then you are clear to run.');
console.log('=====================================================');
process.exit(blocks.length ? 2 : 0);
