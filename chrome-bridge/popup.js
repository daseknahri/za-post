const $ = (id) => document.getElementById(id);
chrome.storage.local.get(["label", "email", "password", "lastResult", "lastSent"], (s) => {
  if (s && s.label) $("label").value = s.label;
  if (s && s.email) $("email").value = s.email;
  if (s && s.password) $("password").value = s.password;
  if (s && s.lastSent) {
    const r = s.lastResult || {};
    $("status").textContent = "Last sent " + new Date(s.lastSent).toLocaleTimeString() + (r.name ? " → " + r.name : "");
  }
});
const persist = () => chrome.storage.local.set({ label: $("label").value.trim(), email: $("email").value.trim(), password: $("password").value });
$("label").addEventListener("change", persist);
$("email").addEventListener("change", persist);
$("password").addEventListener("change", persist);
$("send").addEventListener("click", () => {
  persist();
  $("status").textContent = "Sending…";
  chrome.runtime.sendMessage({ type: "sendNow" }, (r) => {
    if (r && r.name) {
      let s = "✓ Sent → " + r.name;
      if (r.hasXs === false) s += " — ⚠️ NO xs (arrives LOGGED OUT — re-send while logged in)";
      else if (r.hasDatr === false) s += " — ⚠️ no datr (new-device checks)";
      else s += " ✓";
      $("status").textContent = s;
    } else if (r && r.skipped) $("status").textContent = "Skipped: " + ((r && r.reason) || "not logged in to Facebook in this profile");
    else $("status").textContent = "Error: " + ((r && r.error) || "unknown");
  });
});
