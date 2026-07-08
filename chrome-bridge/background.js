// Za Post — Chrome Session Bridge (background service worker).
// A LIVE AGENT inside each logged-in Chrome profile. Reads THIS profile's Facebook session (chrome.cookies — works
// under App-Bound Encryption because we run inside the real Chrome) and reports it to the local Za Post app:
//   • SESSION SYNC   — re-sends cookies WHEN THE SESSION CHANGES (not on every cookie rotation), so the app's stored
//                      session for this account stays fresh without a write-storm.
//   • HEALTH BEACON  — reports healthy / checkpointed / logged-out, derived from the SESSION (xs cookie) — not just
//                      open tabs — so the dashboard shows which accounts are actually alive.
//   • GROUP SYNC     — best-effort joined group ids (throttled to ~6h), so the app can target/prune accurately.
//   • CHECKPOINT     — a logged-out profile reports ONCE (via the remembered c_user) then stops; fix it in Chrome and
//                      the next real session change auto-restores the fresh session.
// __PORT__/__TOKEN__ are baked in when the app generates this extension. Localhost only — nothing leaves this PC.
const PORT = __PORT__;
const TOKEN = "__TOKEN__";
const ENDPOINT = `http://127.0.0.1:${PORT}/bridge`;
const GROUPS_EVERY_MS = 6 * 60 * 60 * 1000; // refresh joined groups at most this often (the heavy call)

function setBadge(text, color) { try { chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color }); } catch (e) {} }
async function post(payload) {
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  return res.json().catch(() => ({}));
}

// Checkpoint from open tabs — ONLY an escalation signal on top of the xs-based liveness (below). Boundary-anchored so
// it matches genuine /checkpoint//recover//confirmemail?//disabled/ flows, not benign help/settings pages.
async function detectCheckpoint() {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
    const bad = tabs.find((t) => /\/(checkpoint|confirmemail|recover|disabled)(\/|\?|#|$)/i.test(t.url || ""));
    if (bad) return { state: "checkpoint", url: bad.url };
  } catch (e) {}
  return { state: "healthy" };
}

// Best-effort joined-group ids: authenticated same-origin fetch (with a hard 8s timeout + body cap) then regex the
// /groups/<id> links. FB is JS-heavy so this may be partial/empty — a HINT for the app, never authoritative.
async function fetchGroupIds() {
  const urls = ["https://www.facebook.com/groups/joins/", "https://www.facebook.com/groups/feed/"];
  const found = new Set();
  for (const u of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(u, { credentials: "include", signal: ctrl.signal });
      const txt = (await res.text()).slice(0, 4 * 1024 * 1024);
      clearTimeout(t);
      (txt.match(/\/groups\/(\d{5,})/g) || []).forEach((m) => { const id = m.split("/")[2]; if (id) found.add(id); });
      if (found.size) break;
    } catch (e) {}
  }
  return [...found].slice(0, 1000);
}

async function collectAndSend(trigger) {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "facebook.com" });
    const cUser = (cookies.find((c) => c.name === "c_user") || {}).value || "";
    const xs = (cookies.find((c) => c.name === "xs") || {}).value || "";
    const st = await chrome.storage.local.get(["label", "email", "password", "lastCUser", "lastGroupsAt", "lastSig"]);
    const force = trigger === "popup";

    // LOGGED OUT (no c_user): report ONCE for the last-known account, then CLEAR lastCUser so a stale/abandoned profile
    // can't keep re-flagging an account another profile now keeps alive.
    if (!cUser) {
      if (!st.lastCUser) { setBadge("—", "#9ca3af"); return { skipped: true, reason: "not logged in" }; }
      const sig = st.lastCUser + "|out";
      if (!force && sig === st.lastSig) { setBadge("!", "#f59e0b"); return { skipped: "nochange" }; }
      setBadge("!", "#f59e0b");
      const r = await post({ token: TOKEN, c_user: st.lastCUser, label: st.label || "", beacon: true, health: { state: "logged_out" } });
      await chrome.storage.local.set({ lastSig: sig, lastCUser: null });
      return r;
    }
    await chrome.storage.local.set({ lastCUser: cUser });

    // Liveness from the SESSION: c_user + xs = healthy (then check for a checkpoint tab); c_user but NO xs = soft
    // logged-out (session cookie gone) — do NOT report healthy just because a c_user cookie lingers.
    const health = xs ? await detectCheckpoint() : { state: "logged_out" };

    // SESSION SIGNATURE — only actually SEND when the session or health CHANGED. FB rotates datr/fr/sb constantly but
    // xs/health rarely, so this collapses the cookie-rotation storm to a handful of real sends per account.
    const sig = cUser + "|" + xs + "|" + health.state;
    if (!force && sig === st.lastSig) { setBadge(health.state === "healthy" ? "✓" : "!", health.state === "healthy" ? "#16a34a" : "#f59e0b"); return { skipped: "nochange" }; }

    const payload = {
      token: TOKEN, c_user: cUser, label: st.label || "", email: st.email || "", password: st.password || "",
      trigger: trigger || "manual", health,
      cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate })),
    };
    // Groups: heavy — at most every GROUPS_EVERY_MS on ALL triggers (popup forces), so the 30-min alarm can't crawl FB.
    if (force || !st.lastGroupsAt || (Date.now() - st.lastGroupsAt > GROUPS_EVERY_MS)) {
      const g = await fetchGroupIds();
      if (g.length) { payload.groups = g; await chrome.storage.local.set({ lastGroupsAt: Date.now() }); }
    }
    const r = await post(payload);
    if (r && (r.name || r.beacon)) { await chrome.storage.local.set({ lastSig: sig, lastSent: Date.now(), lastResult: r }); setBadge(health.state === "checkpoint" ? "!" : (r.hasXs === false ? "!" : "✓"), health.state === "checkpoint" ? "#dc2626" : (r.hasXs === false ? "#f59e0b" : "#16a34a")); }
    else if (r && r.skipped) setBadge("!", "#f59e0b"); // transient (data busy) → amber, retried on the next trigger
    else setBadge("!", "#dc2626"); // do NOT store lastSig on failure → retried on the next trigger
    return r;
  } catch (e) { setBadge("!", "#dc2626"); return { error: String((e && e.message) || e) }; }
}

// Triggers (all funnel through the signature gate, so a no-change trigger sends nothing):
let lastTab = 0;
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab && tab.url && /:\/\/([^/]*\.)?facebook\.com\//.test(tab.url)) {
    if (Date.now() - lastTab < 4000) return;
    lastTab = Date.now();
    collectAndSend("tab");
  }
});
let cookieTimer = null;
chrome.cookies.onChanged.addListener((info) => {
  const d = info && info.cookie && info.cookie.domain;
  if (!d || !/facebook\.com$/.test(String(d).replace(/^\./, ""))) return;
  if (cookieTimer) return;
  cookieTimer = setTimeout(() => { cookieTimer = null; collectAndSend("cookie"); }, 8000);
});
chrome.alarms.create("zaSync", { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === "zaSync") collectAndSend("alarm"); });
chrome.runtime.onMessage.addListener((msg, sender, reply) => { if (msg && msg.type === "sendNow") { collectAndSend("popup").then(reply); return true; } });
