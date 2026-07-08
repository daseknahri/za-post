let appData = {
  posts: [],
  groups: [],
  accounts: [],
  settings: {
    parallelAccounts: 3,
    postsPerGroup: 1,
    maxCycles: 0,
    commentWithImage: false,
    autoDeletePosted: false,
    hideBrowser: true,
    useProxies: false,
    enableTunnel: false,
  }
};

let selectedImages = [];
let isAutomationRunning = false;
let isPaused = false;
let localStartInFlight = false;
let isStopping = false;
let isFinishing = false; // M2-03: "finish after the current batch" requested
let _pauseBusy = false; // in-flight guard: a pause/resume IPC round-trip is underway → ignore re-clicks, hold the button
let _stopBusy = false;  // in-flight guard: the Stop confirm dialog is open → ignore re-clicks so a 2nd dialog can't open
let _resetOnStop = false; // user clicked Stop and chose "start over" → reset the rotation once the run fully halts
let currentLoginAccount = null;
let appLimits = { maxGroups: Infinity, maxAccounts: Infinity }; // unlimited until the license says otherwise (null from main = unlimited)

// 🕒 Current local time as HH:MM (same clock the daily schedule/auto-start uses) — for comparing against the laptop.
// Live sidebar clock: shows the app's local date + time (ticking) so the operator can confirm it matches the
// laptop's clock — the daily schedule and the Windows auto-start both fire on THIS time.
let _appClockTimer = null;
function startAppClock() {
  const el = document.getElementById('app-clock');
  if (!el) return;
  let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  const tick = () => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    let day = ''; try { day = d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }); } catch { day = d.toDateString(); }
    const off = -d.getTimezoneOffset(); const gmt = `GMT${off >= 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}`;
    el.textContent = `🕒 ${day} · ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    el.title = `App clock — local time${tz ? ' (' + tz + ', ' + gmt + ')' : ' (' + gmt + ')'}. It should match your laptop's clock; the daily schedule + auto-start fire on this time.`;
  };
  tick();
  if (_appClockTimer) clearInterval(_appClockTimer);
  _appClockTimer = setInterval(tick, 1000);
}

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
  startAppClock(); // 🕒 live clock so the operator can confirm the app's time matches the laptop (the schedule fires on it)
  await loadData();
  initializeEventListeners();
  updateDashboard();
  checkAutomationStatus();
  checkRdpKeepalive(); // one-time: if viewing over RDP and the disconnect-keepalive isn't set up, remind

  // Remote Access Logic
  const urlDisplay = document.getElementById('remote-url-display');
  const btnCopy = document.getElementById('btn-copy-url');

  if (urlDisplay && btnCopy) {
    // 1. Check if URL is already available
    const existingUrl = await window.electronAPI.invoke('get-remote-url');
    if (existingUrl) urlDisplay.value = existingUrl;

    // 2. Listen for updates
    if (window.electronAPI.onRemoteUrlUpdate) {
      window.electronAPI.onRemoteUrlUpdate((url) => {
        urlDisplay.value = url;
      });
    }

    // 3. Copy button
    btnCopy.addEventListener('click', () => {
      const url = urlDisplay.value;
      if (url && url !== 'Initializing...') {
        navigator.clipboard.writeText(url);
        const originalText = btnCopy.textContent;
        btnCopy.textContent = 'Copied!';
        setTimeout(() => btnCopy.textContent = originalText, 2000);
      }
    });
  }

  // 4. Listen for data updates (Instant Sync) — always active, not gated on remote-URL elements.
  // DEBOUNCE: a run emits data-updated on every account status write — hundreds/minute at 400 accounts. Each one
  // reloads the whole data.json (MB-scale) + re-renders the active view; unthrottled, that freezes the tab. Coalesce
  // bursts to at most ~one reload+render per 400ms, with a guaranteed TRAILING run so the final state is never missed.
  if (window.electronAPI.onDataUpdated) {
    let _duTimer = null, _duPending = false, _duRunning = false;
    const _doDataUpdate = async () => {
      _duRunning = true;
      try {
        await loadData();
        updateDashboard();
        const isActive = (id) => { const el = document.getElementById(id); return el && el.classList.contains('active'); };
        if (isActive('posts-view') && typeof renderPosts === 'function') renderPosts();
        if (isActive('accounts-view') && typeof renderAccounts === 'function') renderAccounts();
        if (isActive('groups-view') && typeof renderGroups === 'function') renderGroups();
      } finally { _duRunning = false; if (_duPending) { _duPending = false; _duTimer = setTimeout(() => { _duTimer = null; _doDataUpdate(); }, 400); } }
    };
    window.electronAPI.onDataUpdated(() => {
      if (_duRunning) { _duPending = true; return; }   // a reload is in flight → queue exactly one trailing run
      if (_duTimer) return;                            // already scheduled in this window → coalesce
      _duTimer = setTimeout(() => { _duTimer = null; _doDataUpdate(); }, 400);
    });
  }

  // 5. Listen for Automation Status Changes (Sync with Remote)
  if (window.electronAPI.onAutomationStarted) {
    window.electronAPI.onAutomationStarted(() => {
      console.log('Automation started externally, syncing UI...');
      isAutomationRunning = true;
      isPaused = false;
      isStopping = false;
      isFinishing = false;
      _resetOnStop = false; // a fresh run clears any stale stop-choice
      updateAutomationControls();
      if (!localStartInFlight) {
      showNotification('Automation started externally', 'success');
      addLog('🚀 Automation started externally\n');
      }
    });
  }

  // Live Run progress updates from orchestrator
  if (window.electronAPI.onAutomationProgress) {
    window.electronAPI.onAutomationProgress((data) => {
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      const runEl = document.getElementById('dash-running');
      if (runEl) {
        runEl.textContent = data.running ? (data.paused ? 'Paused' : 'Running') : 'Idle';
        runEl.style.color = data.running ? (data.paused ? '#f59e0b' : '#34d399') : '#9ca3af';
      }
      set('dash-cycle', data.cycle > 0 ? data.cycle : '—');
      set('dash-posted', data.posted);
      set('dash-errors', data.errors);
      set('dash-pending', data.pending);
      const totalStr = data.accountsTotal > 0 ? `${data.accountsDone}/${data.accountsTotal}` : '—';
      set('dash-accounts', totalStr);
      // Sync running + paused state from backend
      isAutomationRunning = !!data.running;
      isPaused = !!data.paused;
      updateAutomationControls();
      // Offline indicator
      const offlineEl = document.getElementById('offline-indicator');
      if (offlineEl) offlineEl.style.display = data.offline ? 'inline-block' : 'none';
      // Live per-account operations panel — show EVERY account's state (running/queued/done/…), not just the few in parallel.
      if (Array.isArray(data.accounts)) renderLiveOps(data.accounts);
      // Refresh the campaign-plan "done" overlay live during a run — throttled (the ledger updates as posts land).
      planLiveRefresh();
    });
  }

  // Paused / Resumed events
  if (window.electronAPI.onAutomationPaused) {
    window.electronAPI.onAutomationPaused(() => {
      isPaused = true;
      updateAutomationControls();
    });
  }
  if (window.electronAPI.onAutomationResumed) {
    window.electronAPI.onAutomationResumed(() => {
      isPaused = false;
      updateAutomationControls();
    });
  }

  // Load License Info — wrapped so the ~6h re-validation push ('license-updated') refreshes the badge + soft add-caps
  // WITHOUT a restart (they were previously frozen at boot-time values even though main already sends the signal).
  async function refreshLicenseInfo() {
  try {
    const info = await window.electronAPI.invoke('get-license-info');
    if (info) {
      // Update Limits
      appLimits.maxGroups = (info.maxGroups == null) ? Infinity : info.maxGroups; // null = unlimited (owner/pro)
      appLimits.maxAccounts = (info.maxAccounts == null) ? Infinity : info.maxAccounts;

      const expiryDisplay = document.getElementById('license-expiry-display');
      const logo = document.querySelector('.logo');

      if (expiryDisplay) {
        if (info.expiry) {
          const date = new Date(info.expiry).toLocaleDateString();
          expiryDisplay.textContent = `🛡️ Valid Until: ${date}`;
          expiryDisplay.style.color = '#40c057';
          expiryDisplay.style.fontWeight = 'bold';
        } else {
          expiryDisplay.textContent = 'Lifetime License';
          expiryDisplay.style.color = '#fab005';
        }
      }

      // Append Limits if not already there (helper function might be better, but inline is fine)
      const limitsId = 'license-limits-info';
      let limitsDiv = document.getElementById(limitsId);

      if (!limitsDiv && logo) {
        limitsDiv = document.createElement('div');
        limitsDiv.id = limitsId;
        limitsDiv.style.cssText = 'font-size: 10px; color: #aaa; margin-top: 4px; border-top: 1px solid #ddd; padding-top: 4px;';
        logo.appendChild(limitsDiv);
      }

      if (limitsDiv) {
        const fmtLimit = (n) => (Number.isFinite(n) ? n : 'Unlimited');
        limitsDiv.innerHTML = `
          <div>👥 Max Groups: ${fmtLimit(appLimits.maxGroups)}</div>
          <div>🔐 Max Accounts: ${fmtLimit(appLimits.maxAccounts)}</div>
        `;
      }
    }
  } catch (e) { console.error('License info error', e); }
  }
  await refreshLicenseInfo();
  if (window.electronAPI.onLicenseUpdate) window.electronAPI.onLicenseUpdate(() => refreshLicenseInfo());

  // Set up event listeners from main process
  window.electronAPI.onAutomationLog((log) => {
    addLog(log);
    // Auto-delete of posted items is handled in the backend (orchestrator), per cycle.
  });

  window.electronAPI.onAutomationStopped(async (reason) => {
    isAutomationRunning = false;
    isPaused = false;
    isStopping = false;
    isFinishing = false;
    updateAutomationControls();
    addLog(`\n✅ Automation ${reason || 'stopped'}.\n`);
    await loadData(); // refresh — the backend may have auto-deleted posted items during the run
    // The keep-vs-start-over choice is made UP FRONT on the Stop click (see stopAutomation). If the operator
    // chose "start over", apply the rotation reset now that the run has fully halted (reset can't run mid-cycle).
    if (_resetOnStop) {
      _resetOnStop = false;
      await doStartOverReset();
    }
  });

  // M2-03: live attention — when the run flags an account (rate-limited, checkpoint, needs login,
  // etc.), notify the operator and refresh so the account's status badge updates without a reload.
  if (window.electronAPI.onAccountAttention) {
    window.electronAPI.onAccountAttention(async (info) => {
      const name = (info && info.name) || 'An account';
      const flag = (info && info.flag) || 'attention';
      const MSG = {
        rate_limited: 'rate-limited by Facebook — cooling down',
        needs_login: 'logged out — auto-login couldn\'t recover it; a reserve is covering its groups. Re-login it, or set its password (Edit account) for auto-login.',
        needs_verification: 'Facebook wants a human check — solve it and it resumes; a reserve covers meanwhile',
        account_disabled: 'disabled/restricted by Facebook',
        likely_blocked: 'posted nothing (likely blocked) — check it',
        proxy_invalid: 'proxy is invalid — fix it in Accounts',
      };
      // A logout is HANDLED (auto-login was tried, a reserve covers) → inform, don't alarm with a red error.
      const handled = (flag === 'needs_login' || flag === 'needs_verification');
      showNotification(`${handled ? '🔑' : '⚠️'} ${name}: ${MSG[flag] || flag}`, handled ? 'info' : 'error');
      try { await loadData(); } catch {}
      try { highlightAccountCard(name); } catch {}
    });
  }

  // End-of-run summary: render a persistent roll-up the operator can read at a glance.
  window.electronAPI.onAutomationSummary((summary) => {
    renderRunSummary(summary);
  });

  window.electronAPI.onLoginBrowserOpened((accountName) => {
    console.log('=== LOGIN BROWSER OPENED EVENT RECEIVED ===');
    console.log('Account name:', accountName);

    // Show login instructions modal
    document.getElementById('login-account-name').textContent = accountName;
    console.log('Opening modal...');
    openModal('modal-login-instructions');
    currentLoginAccount = accountName;
    console.log('Modal should be visible now');
  });

  window.electronAPI.onLoginBrowserClosed((accountName) => {
    if (typeof currentLoginAccount !== 'undefined' && accountName === currentLoginAccount) {
      closeModal('modal-login-instructions');
      currentLoginAccount = null;
      if (typeof showNotification === 'function') showNotification('Login browser closed — status updated', 'info');
    }
  });
});

// Load data from main process
async function loadData() {
  const data = await window.electronAPI.getData();
  if (data) {
    appData = data;
    try { const wc = await window.electronAPI.getWarmupCounts(); _warmupCounts = (wc && wc.success !== false) ? (wc.data || wc) : {}; } catch { _warmupCounts = {}; }
    renderPosts();
    renderGroups();
    renderAccounts();
    loadSettings();
    await loadProxies(); // Load proxies
    updateDashboard();
  }
}

// Save data to main process. Surface a SKIPPED save (E_SAVE_SKIPPED — data.json was transiently locked on load, so the
// write was skipped to protect the good-but-locked file) instead of letting the caller show a false "saved!": notify
// and THROW so a caller's success path (e.g. "Account updated successfully!") can't run on an edit that never persisted.
async function saveData() {
  const res = await window.electronAPI.saveData(appData);
  if (res && res.success === false) {
    showNotification('⚠️ Not saved — the data file was briefly locked (antivirus/sync). Your change was NOT written. Try again in a moment.', 'error');
    throw new Error(res.error || 'save skipped');
  }
  return res;
}

// Bulk import posts — accepts a JSON array OR pipe-separated lines "caption | comment | imageUrl".
async function bulkImportPosts() {
  const raw = (document.getElementById('bulk-posts-input').value || '').trim();
  if (!raw) { showNotification('Paste some posts first', 'error'); return; }
  let arr = [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not array');
    arr = parsed.map(p => ({ caption: String(p.caption || ''), comment: String(p.comment || ''), imageUrl: String(p.imageUrl || ''), commentImageUrl: String(p.commentImageUrl || '') }));
  } catch {
    arr = raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const parts = line.split('|').map(s => s.trim());
      return { caption: parts[0] || '', comment: parts[1] || '', imageUrl: parts[2] || '', commentImageUrl: '' };
    });
  }
  arr = arr.filter(p => p.caption);
  if (!arr.length) { showNotification('No valid posts found (each needs a caption)', 'error'); return; }
  const res = await window.electronAPI.addPostsBulk(arr);
  if (res && res.success) {
    showNotification(`Imported ${res.added} post(s)${res.skipped ? `, ${res.skipped} skipped` : ''}`, 'success');
    document.getElementById('bulk-posts-input').value = '';
    closeModal('modal-bulk-posts');
    await loadData();
  } else showNotification('Import failed: ' + ((res && res.error) || 'unknown'), 'error');
}

// Bulk import groups — one group URL or ID per line.
async function bulkImportGroups() {
  const raw = (document.getElementById('bulk-groups-input').value || '').trim();
  if (!raw) { showNotification('Paste some group URLs/IDs first', 'error'); return; }
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) { showNotification('No groups found', 'error'); return; }
  const res = await window.electronAPI.addGroupsBulk(lines);
  if (res && res.success) {
    showNotification(`Imported ${res.added} group(s)${res.skipped ? `, ${res.skipped} skipped/duplicate` : ''}`, 'success');
    document.getElementById('bulk-groups-input').value = '';
    closeModal('modal-bulk-groups');
    await loadData();
  } else showNotification('Import failed: ' + ((res && res.error) || 'unknown'), 'error');
}

// Bulk import accounts — one per line: "name | alias | proxy | email | password" (pipe, tab, or comma separated).
// The #1 lever for a large fleet: 400 accounts become one paste instead of ~800 modal clicks. Optional cookies folder
// (<name>.json per account) is passed through so the app seeds each session; no browser opens (verified on first run).
let _bulkAccountsCookiesDir = null;
async function pickBulkAccountsCookiesFolder() {
  try {
    const r = await window.electronAPI.pickCookiesFolder();
    if (r && r.success && r.dir) {
      _bulkAccountsCookiesDir = r.dir;
      const el = document.getElementById('bulk-accounts-cookies-path');
      if (el) { el.textContent = r.dir; el.title = r.dir; }
    }
  } catch { showNotification('Could not open the folder picker', 'error'); }
}
async function bulkImportAccounts() {
  const raw = (document.getElementById('bulk-accounts-input').value || '').trim();
  if (!raw) { showNotification('Paste some accounts first', 'error'); return; }
  const seen = new Set();
  const accounts = [];
  let invalid = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sep = t.includes('|') ? '|' : (t.includes('\t') ? '\t' : ','); // per-line: pipe > tab > comma (a lone name = one field)
    const parts = t.split(sep).map((s) => s.trim());
    const name = parts[0];
    if (!name || /^name$/i.test(name)) continue;           // skip blanks + a header row
    if (!/^[a-zA-Z0-9_]+$/.test(name)) { invalid++; continue; } // account.name is an identifier (profile dir + DOM ids) — reject non-[A-Za-z0-9_] like single-add, so a pasted name can't corrupt a profile path or inject into a card's id=""
    if (seen.has(name.toLowerCase())) continue;            // de-dupe within the paste
    seen.add(name.toLowerCase());
    accounts.push({ name, alias: parts[1] || '', proxy: parts[2] || '', email: parts[3] || '', password: parts[4] || '' });
  }
  if (!accounts.length) { showNotification('No valid accounts found (each line needs a name using only letters, numbers, underscores)' + (invalid ? ` — ${invalid} line(s) had invalid name characters` : ''), 'error'); return; }
  const opts = _bulkAccountsCookiesDir ? { cookiesDir: _bulkAccountsCookiesDir } : {};
  const res = await window.electronAPI.addAccountsBulk(accounts, opts);
  if (res && res.success) {
    let msg = `Imported ${res.added} account(s)`;
    if (res.skipped) msg += `, ${res.skipped} skipped/duplicate`;
    if (invalid) msg += ` · ${invalid} skipped (invalid name)`;
    if (res.withProxy) msg += ` · ${res.withProxy} with proxy`;
    if (res.withCreds) msg += ` · ${res.withCreds} with login`;
    if (res.cookiesLoaded) msg += ` · ${res.cookiesLoaded} cookie jar(s)`;
    if (res.cookiesMissing) msg += ` · ${res.cookiesMissing} no cookies found`;
    if (res.cookiesWriteFailed) msg += ` · ${res.cookiesWriteFailed} cookie save FAILED`;
    if (res.limited) msg += ` · ${res.limited} over license limit`;
    showNotification(msg, (res.cookiesNoDatr || res.cookiesWriteFailed) ? 'warning' : 'success');
    // A cookie jar that couldn't be written (disk full / file locked) strands that account logged-out — surface it loudly.
    if (res.cookiesWriteFailed) showNotification(`⚠️ ${res.cookiesWriteFailed} account(s) imported but their cookie jar could NOT be saved (disk full or a locked file). Re-import those accounts — otherwise they arrive logged-out.`, 'error');
    // datr = Facebook's device cookie. Imports without it log in but look like a NEW device → far more checkpoints.
    // Surface it loudly + separately so a thin export gets caught before these accounts run.
    if (res.cookiesNoDatr) showNotification(`⚠️ ${res.cookiesNoDatr} account(s) imported WITHOUT the "datr" device cookie — Facebook will treat them as a brand-new device (more checkpoints). Re-export the FULL cookie set (including datr) for those accounts.`, 'error');
    document.getElementById('bulk-accounts-input').value = '';
    _bulkAccountsCookiesDir = null;
    closeModal('modal-bulk-accounts');
    await loadData();
  } else showNotification('Import failed: ' + ((res && res.error) || 'unknown'), 'error');
}

// ── Import from Chrome (companion-extension session bridge) ──────────────────────────────────────────
let _chromeImportPoll = null;
async function openChromeImport() {
  openModal('modal-chrome-import');
  await refreshChromeImportCount();
  // Live-poll while the modal is open so accounts appear as the operator opens each Chrome profile.
  if (_chromeImportPoll) clearInterval(_chromeImportPoll);
  _chromeImportPoll = setInterval(() => {
    const m = document.getElementById('modal-chrome-import');
    if (!m || !m.classList.contains('active')) { clearInterval(_chromeImportPoll); _chromeImportPoll = null; return; }
    refreshChromeImportCount();
  }, 2500);
}
async function generateChromeHelper() {
  const btn = document.getElementById('btn-gen-chrome-ext');
  const pathEl = document.getElementById('chrome-ext-path');
  try {
    if (btn) { btn.disabled = true; btn.textContent = '⚙️ Generating…'; }
    const r = await window.electronAPI.invoke('setup-chrome-import');
    if (r && r.success) {
      await window.electronAPI.invoke('open-chrome-import-folder');
      if (pathEl) pathEl.textContent = 'Folder: ' + r.extensionDir + (r.profiles && r.profiles.length ? `  ·  ${r.profiles.length} Chrome profiles detected` : '');
      showNotification('Helper generated — it opened in your file manager. Load it in chrome://extensions (Developer mode → Load unpacked).', 'success');
      if (r.tokenStable === false) showNotification('⚠️ The bridge token could not be saved — the helper will stop working after you restart the app (you would need to re-generate + re-load it). Check the data folder permissions / antivirus.', 'error');
      updateChromeImportCount(r.imported, r.profiles);
    } else showNotification('Could not generate the helper: ' + ((r && r.error) || 'unknown'), 'error');
  } catch (e) { showNotification('Error: ' + (e.message || e), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '⚙️ Generate helper + open folder'; } }
}
async function refreshChromeImportCount() {
  try { const r = await window.electronAPI.invoke('chrome-import-info'); if (r && r.success) { updateChromeImportCount(r.imported); renderChromeHealth(r); } } catch {}
}
async function assignChromeGroups() {
  if (!(await themedConfirm('Assign each Chrome-imported account to the target groups the helper confirmed it\'s a member of?\n\nThis ADDS those groups (it never removes any). Accounts the helper hasn\'t reported groups for yet are skipped — open them on Facebook in Chrome first.', { title: 'Auto-assign groups from Chrome', confirmText: 'Assign' }))) return;
  try {
    const r = await window.electronAPI.invoke('assign-chrome-groups', { mode: 'add' });
    if (r && r.success) {
      showNotification(`Assigned confirmed groups to ${r.updated} account(s) (${r.totalMemberships} membership${r.totalMemberships === 1 ? '' : 's'})${r.skippedNoData ? ` · ${r.skippedNoData} skipped (no Chrome group data yet)` : ''}.`, r.updated ? 'success' : 'info');
      await loadData(); refreshChromeImportCount();
    } else showNotification('Could not auto-assign: ' + ((r && r.error) || 'unknown'), 'error');
  } catch (e) { showNotification('Error: ' + (e.message || e), 'error'); }
}
function updateChromeImportCount(n, profiles) {
  const c = document.getElementById('chrome-import-count'); if (c) c.textContent = String(n || 0);
  if (profiles && profiles.length) { const note = document.getElementById('chrome-profiles-note'); if (note) note.textContent = ` of ~${profiles.length} Chrome profiles`; }
}
function renderChromeHealth(r) {
  const el = document.getElementById('chrome-health-summary'); if (!el) return;
  const h = (r && r.health) || {};
  if (!r || !r.imported) { el.textContent = ''; return; }
  const parts = [];
  if (h.healthy) parts.push(`🟢 ${h.healthy} healthy`);
  if (h.checkpoint) parts.push(`🔴 ${h.checkpoint} need attention (checkpoint)`);
  if (h.logged_out) parts.push(`⚪ ${h.logged_out} logged out`);
  if (h.unknown) parts.push(`⚫ ${h.unknown} not yet reported`);
  el.innerHTML = parts.length
    ? parts.join(' &nbsp;·&nbsp; ') + `<span class="text-gray-600"> &nbsp;(${r.seenRecently || 0} seen in the last 24h)</span>`
    : '';
}

// Navigation
function initializeEventListeners() {
  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      switchView(view);
    });
  });

  // Quick actions
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      handleQuickAction(action);
    });
  });

  // Posts
  document.getElementById('btn-add-post').addEventListener('click', openAddPostModal);
  document.getElementById('btn-save-post').addEventListener('click', savePost);
  document.getElementById('post-comment-enabled').addEventListener('change', (e) => {
    document.getElementById('comment-group').style.display = e.target.checked ? 'block' : 'none';
    // Show comment image section only when: comment enabled AND no post images selected
    updateCommentImageVisibility();
  });

  // Image upload
  const imageUploadArea = document.getElementById('image-upload-area');
  const imageInput = document.getElementById('image-input');

  imageUploadArea.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', (e) => {
    handleImageSelect(e);
    // When images are added, hide the comment image section
    setTimeout(updateCommentImageVisibility, 100);
  });

  // Drag & drop
  imageUploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    imageUploadArea.style.borderColor = 'var(--primary-color)';
  });

  imageUploadArea.addEventListener('dragleave', () => {
    imageUploadArea.style.borderColor = 'var(--border-color)';
  });

  imageUploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    imageUploadArea.style.borderColor = 'var(--border-color)';

    // Check for files first (local file drop)
    const files = e.dataTransfer.files;
    let hasFiles = false;
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) {
        handleImageFile(files[i]);
        hasFiles = true;
      }
    }

    // If no files, check for URL (dragged from web page)
    if (!hasFiles) {
      const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        const urlInput = document.getElementById('image-url-input');
        if (urlInput) {
          urlInput.value = url.split('\n')[0].trim(); // Take first URL if multiple
          urlInput.style.borderColor = '#22c55e';
          setTimeout(() => { urlInput.style.borderColor = ''; }, 2000);
        }
      }
    }
    setTimeout(updateCommentImageVisibility, 100);
  });

  // --- Comment Image Upload (for text-only posts) ---
  const commentImageUploadArea = document.getElementById('comment-image-upload-area');
  const commentImageInput = document.getElementById('comment-image-input');

  commentImageUploadArea.addEventListener('click', () => commentImageInput.click());

  // Drag & drop for comment image (supports files AND URLs from web pages)
  commentImageUploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    commentImageUploadArea.style.borderColor = 'var(--primary-color, #6366f1)';
  });
  commentImageUploadArea.addEventListener('dragleave', () => {
    commentImageUploadArea.style.borderColor = '';
  });
  commentImageUploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    commentImageUploadArea.style.borderColor = '';

    // Check for files first (local file drop)
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      const file = files[0];
      const reader = new FileReader();
      reader.onload = (ev) => {
        selectedCommentImage = {
          data: ev.target.result.split(',')[1],
          ext: file.name.split('.').pop(),
          preview: ev.target.result
        };
        document.getElementById('comment-image-preview-img').src = ev.target.result;
        document.getElementById('comment-image-preview').style.display = 'block';
        document.querySelector('.comment-upload-placeholder').style.display = 'none';
      };
      reader.readAsDataURL(file);
      return;
    }

    // If no files, check for URL (dragged from web page)
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      const urlInput = document.getElementById('comment-image-url-input');
      if (urlInput) {
        urlInput.value = url.split('\n')[0].trim();
        urlInput.style.borderColor = '#22c55e';
        setTimeout(() => { urlInput.style.borderColor = ''; }, 2000);
        // Show a preview of the URL image
        document.getElementById('comment-image-preview-img').src = urlInput.value;
        document.getElementById('comment-image-preview').style.display = 'block';
        document.querySelector('.comment-upload-placeholder').style.display = 'none';
      }
    }
  });

  commentImageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        selectedCommentImage = {
          data: ev.target.result.split(',')[1],
          ext: file.name.split('.').pop(),
          preview: ev.target.result
        };
        document.getElementById('comment-image-preview-img').src = ev.target.result;
        document.getElementById('comment-image-preview').style.display = 'block';
        document.querySelector('.comment-upload-placeholder').style.display = 'none';
      };
      reader.readAsDataURL(file);
    }
  });

  document.getElementById('comment-image-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    selectedCommentImage = null;
    document.getElementById('comment-image-preview').style.display = 'none';
    document.querySelector('.comment-upload-placeholder').style.display = 'block';
    commentImageInput.value = '';
    // Also clear URL input if present
    const urlInput = document.getElementById('comment-image-url-input');
    if (urlInput) urlInput.value = '';
  });

  // Bulk import buttons
  document.getElementById('btn-bulk-import-posts').addEventListener('click', () => {
    document.getElementById('bulk-posts-input').value = '';
    openModal('modal-bulk-posts');
  });
  document.getElementById('btn-bulk-import-groups').addEventListener('click', () => {
    document.getElementById('bulk-groups-input').value = '';
    openModal('modal-bulk-groups');
  });
  { const ba = document.getElementById('btn-bulk-import-accounts'); if (ba) ba.addEventListener('click', () => {
    document.getElementById('bulk-accounts-input').value = '';
    _bulkAccountsCookiesDir = null;
    const p = document.getElementById('bulk-accounts-cookies-path'); if (p) p.textContent = 'No folder — accounts with a login auto-sign-in; the rest start logged out.';
    openModal('modal-bulk-accounts');
  }); }
  { const cb = document.getElementById('btn-bulk-accounts-cookies'); if (cb) cb.addEventListener('click', pickBulkAccountsCookiesFolder); }
  { const ci = document.getElementById('btn-chrome-import'); if (ci) ci.addEventListener('click', openChromeImport); }
  { const g = document.getElementById('btn-gen-chrome-ext'); if (g) g.addEventListener('click', generateChromeHelper); }
  { const r = document.getElementById('btn-refresh-chrome-import'); if (r) r.addEventListener('click', refreshChromeImportCount); }
  { const ag = document.getElementById('btn-assign-chrome-groups'); if (ag) ag.addEventListener('click', assignChromeGroups); }

  // Groups
  document.getElementById('btn-add-group').addEventListener('click', openAddGroupModal);
  document.getElementById('btn-save-group').addEventListener('click', saveGroup);

  // Accounts
  document.getElementById('btn-add-account').addEventListener('click', openAddAccountModal);
  document.getElementById('btn-save-account').addEventListener('click', saveAccount);
  document.getElementById('btn-check-login').addEventListener('click', checkLoginStatus);
  document.getElementById('btn-login-done').addEventListener('click', closeLoginAndSave);
  document.getElementById('btn-cancel-login').addEventListener('click', cancelLogin);

  // Edit Account
  document.getElementById('btn-save-edit-account').addEventListener('click', saveEditAccount);

  // Automation
  document.getElementById('btn-start-automation').addEventListener('click', () => startAutomation({ runNow: true })); // Start = run NOW; the daily time only drives the unattended next-day auto-start, not this manual click
  document.getElementById('btn-stop-automation').addEventListener('click', stopAutomation);
  { const rb = document.getElementById('btn-reset-rotation'); if (rb) rb.addEventListener('click', startOverCampaign); } // unified: same "Start over" action as the Posts button
  document.getElementById('btn-pause-automation').addEventListener('click', togglePauseAutomation);
  const finishBtn = document.getElementById('btn-finish-automation');
  if (finishBtn) finishBtn.addEventListener('click', finishAutomation);

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-save-proxies').addEventListener('click', saveProxies);
  { const bb = document.getElementById('btn-proxies-bulk-add'); if (bb) bb.addEventListener('click', addProxiesBulk); }
  { const so = document.getElementById('btn-start-over-posts'); if (so) so.addEventListener('click', startOverCampaign); }

  // Add Proxy Row Logic
  const addProxyBtn = document.getElementById('btn-add-proxy-row');
  if (addProxyBtn) {
    addProxyBtn.addEventListener('click', () => {
      const id = document.getElementById('proxy-id').value.trim();
      const ip = document.getElementById('proxy-ip').value.trim();
      const port = document.getElementById('proxy-port').value.trim();
      const user = document.getElementById('proxy-user').value.trim();
      const pass = document.getElementById('proxy-pass').value.trim();

      if (!ip || !port) {
        showNotification('IP and Port are required.', 'error');
        return;
      }
      // Validate the port at add-time (same rule as saveProxies) so a bad value never becomes a
      // table row that looks saved but is silently skipped on Save Proxies.
      const portNum = parseInt(port, 10);
      if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
        showNotification('Port must be a number between 1 and 65535.', 'error');
        return;
      }

      addProxyRow(id || 'Auto', ip, String(portNum), user, pass);

      // Clear inputs
      document.getElementById('proxy-id').value = '';
      document.getElementById('proxy-ip').value = '';
      document.getElementById('proxy-port').value = '';
      document.getElementById('proxy-user').value = '';
      document.getElementById('proxy-pass').value = '';
    });
  }

  // Closing the login modal must also CANCEL the login (close its browser + reset state), not just hide it.
  const dismissModal = (id) => { if (id === 'modal-login-instructions') { try { cancelLogin(); return; } catch {} } closeModal(id); };

  // Modal close buttons
  document.querySelectorAll('.modal-close, [data-dismiss="modal"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal) dismissModal(modal.id);
    });
  });

  // Close modal on outside click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        dismissModal(modal.id);
      }
    });
  });
}

function switchView(viewName) {
  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewName);
  });

  // Update view visibility
  document.querySelectorAll('.view').forEach(view => {
    view.classList.toggle('active', view.id === `${viewName}-view`);
  });
}

function handleQuickAction(action) {
  switch (action) {
    case 'add-post':
      switchView('posts');
      openAddPostModal();
      break;
    case 'add-group':
      switchView('groups');
      openAddGroupModal();
      break;
    case 'add-account':
      switchView('accounts');
      openAddAccountModal();
      break;
    case 'start-automation':
      switchView('automation');
      startAutomation();
      break;
    case 'quick-setup':
      switchView('accounts');
      openQuickSetup();
      break;
  }
}

// Dashboard
function updateDashboard() {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-posts', appData.posts.length);
  set('stat-groups', appData.groups.length);
  set('stat-accounts', appData.accounts.filter(a => !a.isModerator).length);

  const statusEl = document.getElementById('stat-status');
  const statusIconEl = document.getElementById('stat-status-icon');

  if (isAutomationRunning) {
    if (statusEl) statusEl.textContent = 'Running';
    if (statusIconEl) statusIconEl.textContent = '▶️';
  } else {
    if (statusEl) statusEl.textContent = 'Stopped';
    if (statusIconEl) statusIconEl.textContent = '⏸️';
  }

  renderHealth();
  renderCampaignPlan();
}

// Render account health card from appData.accounts
function renderHealth() {
  // Moderators are not part of the posting fleet — keep them out of the health counts/chips.
  const accounts = (appData.accounts || []).filter(a => !a.isModerator);
  let loggedIn = 0, needsLogin = 0, rateLimited = 0, other = 0;
  for (const a of accounts) {
    if (a.status === 'logged_in') loggedIn++;
    else if (a.status === 'not_logged_in') needsLogin++;
    else if (a.status === 'rate_limited') rateLimited++;
    else other++;
  }
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('health-loggedin', loggedIn);
  set('health-needslogin', needsLogin);
  set('health-ratelimited', rateLimited);
  set('health-other', other);

  const container = document.getElementById('health-accounts');
  if (!container) return;
  container.innerHTML = accounts.map(a => {
    const dot = a.status === 'logged_in' ? '#34d399'
      : a.status === 'not_logged_in' ? '#f87171'
      : a.status === 'rate_limited' ? '#fbbf24'
      : '#9ca3af';
    const label = escapeHtml(a.alias || a.name);
    const tip = escapeAttr(a.lastMessage || a.status || ''); // ATTRIBUTE context (title="") — escapeAttr escapes " so an unvalidated lastMessage can't break out
    return `<span title="${tip}" style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.05);border-radius:8px;padding:3px 8px;font-size:11px;color:#d1d5db;white-space:nowrap;">
      <span style="width:7px;height:7px;border-radius:50%;background:${dot};flex-shrink:0;"></span>${label}
    </span>`;
  }).join('');
}

// LIVE OPERATIONS — render EVERY active account's real-time state from the orchestrator's per-account
// snapshot (shipped in automation-progress.accounts). Shows all accounts at once, not just the parallel few.
const LIVE_OPS_META = {
  running:            { c: '#34d399', bg: 'rgba(16,185,129,0.12)', label: 'RUNNING', pulse: true },
  queued:             { c: '#94a3b8', bg: 'rgba(148,163,184,0.10)', label: 'QUEUED' },
  done:               { c: '#60a5fa', bg: 'rgba(96,165,250,0.12)', label: 'DONE' },
  error:              { c: '#f87171', bg: 'rgba(248,113,113,0.12)', label: 'ERROR' },
  rate_limited:       { c: '#fbbf24', bg: 'rgba(251,191,36,0.12)', label: 'RATE-LIMITED' },
  needs_login:        { c: '#f87171', bg: 'rgba(248,113,113,0.12)', label: 'NEEDS LOGIN' },
  needs_verification: { c: '#f87171', bg: 'rgba(248,113,113,0.12)', label: 'VERIFY' },
  cooldown:           { c: '#fbbf24', bg: 'rgba(251,191,36,0.12)', label: 'COOLING DOWN' },
  capped:             { c: '#94a3b8', bg: 'rgba(148,163,184,0.10)', label: 'DAILY CAP' },
  off:                { c: '#6b7280', bg: 'rgba(107,114,128,0.10)', label: 'OFF' },
  skipped:            { c: '#94a3b8', bg: 'rgba(148,163,184,0.10)', label: 'SKIPPED' },
  account_disabled:   { c: '#f87171', bg: 'rgba(248,113,113,0.12)', label: 'DISABLED' },
  likely_blocked:     { c: '#f87171', bg: 'rgba(248,113,113,0.12)', label: 'BLOCKED' },
  proxy_invalid:      { c: '#f87171', bg: 'rgba(248,113,113,0.12)', label: 'PROXY BAD' },
};
function renderLiveOps(accounts) {
  const body = document.getElementById('live-ops-body');
  const summary = document.getElementById('live-ops-summary');
  if (!body) return;
  if (!accounts || !accounts.length) {
    body.innerHTML = '<p class="text-xs text-gray-500 py-2">Idle — start a run to see every account working live.</p>';
    if (summary) summary.textContent = '';
    return;
  }
  const counts = {};
  for (const a of accounts) counts[a.state] = (counts[a.state] || 0) + 1;
  const rank = { running: 0, queued: 1, done: 2 }; // running first, queued next, done after, issues last
  const sorted = accounts.slice().sort((a, b) =>
    ((rank[a.state] != null ? rank[a.state] : 3) - (rank[b.state] != null ? rank[b.state] : 3))
    || String(a.alias || a.name).localeCompare(String(b.alias || b.name)));
  body.innerHTML = sorted.map((a) => {
    const m = LIVE_OPS_META[a.state] || LIVE_OPS_META.queued;
    const role = a.role === 'reserve' ? '<span style="font-size:9px;color:#fbbf24;font-weight:700;margin-left:4px;flex-shrink:0;">RESV</span>' : '';
    const dot = `<span style="width:9px;height:9px;border-radius:50%;background:${m.c};flex-shrink:0;${m.pulse ? 'animation:lopulse 1.4s ease-in-out infinite;' : ''}"></span>`;
    const badge = `<span style="font-size:9px;font-weight:700;color:${m.c};background:${m.bg};border-radius:5px;padding:2px 6px;white-space:nowrap;flex-shrink:0;">${m.label}</span>`;
    const action = a.action ? `<span style="font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.action)}</span>` : '';
    const posted = a.posted ? `<span style="font-size:10px;color:#34d399;white-space:nowrap;flex-shrink:0;">✓${a.posted}</span>` : '';
    const ipChip = a.ip ? `<span title="exit IP — only different IPs run at the same time" style="font-size:9px;color:${a.ip === 'real IP' ? '#fb923c' : '#7dd3fc'};white-space:nowrap;flex-shrink:0;">🌐${escapeHtml(a.ip)}</span>` : '';
    return `<div style="display:flex;align-items:center;gap:8px;background:rgba(15,23,42,0.5);border-radius:8px;padding:6px 10px;">
        ${dot}
        <span style="font-size:12px;color:#e2e8f0;font-weight:600;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;">${escapeHtml(a.alias || a.name)}</span>${role}
        <span style="font-size:10px;color:#64748b;white-space:nowrap;flex-shrink:0;">${a.groups}g</span>
        ${ipChip}
        ${badge}
        <span style="flex:1;min-width:0;overflow:hidden;">${action}</span>
        ${posted}
      </div>`;
  }).join('');
  if (summary) {
    const r = counts.running || 0, q = counts.queued || 0, d = counts.done || 0;
    const issues = accounts.length - r - q - d;
    summary.textContent = `${r} running · ${d} done · ${q} queued${issues > 0 ? ` · ${issues} need attention` : ''} of ${accounts.length}`;
  }
}

// ===========================================================================
// CAMPAIGN PLAN + PROGRESS (dashboard) — the persistent day-by-day plan the engine drives to completion.
// Reads the normalized plan from main (get-plan: forecast from rotation + the durable "done" ledger overlaid).
// The operator navigates days (◀ ▶ / Today) to see the plan and what's been delivered. Selected day is kept by
// OFFSET across refreshes so a live progress update doesn't yank the view back to today.
// ===========================================================================
let _planData = null;
let _planSelOffset = 0; // selected day offset (0 = today); preserved across refreshes
let _planFetching = false;
async function renderCampaignPlan() {
  const body = document.getElementById('plan-body');
  if (!body) return;
  if (_planFetching) return; _planFetching = true;
  try {
    const res = await window.electronAPI.getPlan();
    _planData = (res && res.success !== false) ? (res.data || res) : null;
  } catch { _planData = null; }
  _planFetching = false;
  drawCampaignPlan();
}
function _planStatusBadge(st) {
  const map = {
    done: ['✅', '#34d399', 'Done'], today: ['▶', '#818cf8', 'Today'], upcoming: ['○', '#64748b', 'Upcoming'],
    held: ['⏳', '#fbbf24', 'Held'], partial: ['◐', '#38bdf8', 'Partial'], error: ['✗', '#f87171', 'Error'],
  };
  const [icon, color, label] = map[st] || map.upcoming;
  return `<span style="display:inline-flex;align-items:center;gap:4px;color:${color};font-size:11px;font-weight:600;"><span>${icon}</span>${label}</span>`;
}
function drawCampaignPlan() {
  const body = document.getElementById('plan-body');
  const overall = document.getElementById('plan-overall');
  if (!body) return;
  const p = _planData;
  if (!p || p.method === 'none' || !(p.days && p.days.length)) {
    if (overall) overall.textContent = '';
    body.innerHTML = `<p class="text-xs text-gray-500 py-3">${escapeHtml((p && p.message) || 'No plan yet — set up a campaign (Quick Setup), then it appears here.')}</p>`;
    return;
  }
  const methodLabel = { 'daily-rotation': 'Daily Rotation', 'campaign-plan': 'Campaign Plan', 'sequence': 'Sequential', 'post-centric': 'Post to All' }[p.method] || p.method;
  // Overall progress line.
  if (overall) {
    const t = p.totals || {};
    const bits = [`<b style="color:#cbd5e1;">${escapeHtml(methodLabel)}</b>`];
    if (p.cycleDays) bits.push(`${p.cycleDays}-cycle plan`);
    if (t.posted) bits.push(`<span style="color:#34d399;">${t.posted} delivered</span>`);
    if (t.held) bits.push(`<span style="color:#fbbf24;">${t.held} held</span>`);
    bits.push(p.ongoing ? 'loops' : 'completes then stops');
    overall.innerHTML = bits.join(' · ');
  }
  if (p.method === 'post-centric') { body.innerHTML = `<p class="text-xs text-gray-400 py-3">${escapeHtml(p.message)}</p>`; return; }

  // Clamp the selected offset to an available day; prefer the same offset across refreshes, else today.
  let idx = p.days.findIndex((d) => d.offset === _planSelOffset);
  if (idx < 0) { idx = p.todayIndex >= 0 ? p.todayIndex : 0; _planSelOffset = p.days[idx].offset; }
  const day = p.days[idx];
  const whenBadge = day.when === 'past' ? '<span style="color:#64748b;">✓ done</span>' : day.when === 'today' ? '<span style="color:#818cf8;font-weight:700;">▶ current</span>' : '<span style="color:#94a3b8;">upcoming</span>';
  const atStart = idx <= 0, atEnd = idx >= p.days.length - 1;
  const navBtn = (dir, disabled, label) => `<button onclick="planNav(${dir})" ${disabled ? 'disabled' : ''} style="background:${disabled ? 'rgba(255,255,255,0.03)' : 'rgba(99,102,241,0.15)'};border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:${disabled ? '#475569' : '#c7d2fe'};font-size:13px;padding:4px 10px;cursor:${disabled ? 'default' : 'pointer'};">${label}</button>`;

  const rows = (day.rows || []).map((r) => {
    const postCell = r.postNum ? `<b style="color:#e2e8f0;">#${r.postNum}</b> <span style="color:#94a3b8;">${escapeHtml(r.caption || '')}</span>` : `<span style="color:#64748b;">${escapeHtml(r.caption || '—')}</span>`;
    const grpDot = (g) => { const c = g.status === 'done' ? '#34d399' : g.status === 'held' ? '#fbbf24' : g.status === 'error' ? '#f87171' : '#475569'; return `<span title="${escapeAttr(g.name)} — ${g.status}" style="width:7px;height:7px;border-radius:50%;background:${c};display:inline-block;"></span>`; };
    const grpSummary = r.groupsTotal ? `<span style="display:inline-flex;align-items:center;gap:3px;">${(r.groups || []).map(grpDot).join('')}</span> <span style="color:#94a3b8;font-size:10px;">${r.groupsDone}/${r.groupsTotal}</span>` : '<span style="color:#475569;font-size:10px;">no groups</span>';
    return `<tr style="border-top:1px solid rgba(255,255,255,0.05);">
      <td style="padding:6px 8px;font-size:12px;color:#e2e8f0;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.alias || r.account)}</td>
      <td style="padding:6px 8px;font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${postCell}</td>
      <td style="padding:6px 8px;">${grpSummary}</td>
      <td style="padding:6px 8px;text-align:right;">${_planStatusBadge(r.status)}</td>
    </tr>`;
  }).join('');

  // Per-day delivery summary + progress bar (the heart of "better tracking").
  const dn = day.rows || [];
  const pT = dn.length, pD = dn.filter((r) => r.status === 'done').length;
  const gT = dn.reduce((s, r) => s + (r.groupsTotal || 0), 0), gD = dn.reduce((s, r) => s + (r.groupsDone || 0), 0);
  const heldN = dn.filter((r) => r.status === 'held').length;
  const pct = gT ? Math.round((gD / gT) * 100) : 0;
  const summaryBar = !pT ? '' : (day.when === 'future'
    ? `<div style="font-size:11px;color:#94a3b8;margin:0 0 10px;">🗓️ Planned: <b style="color:#cbd5e1;">${pT}</b> post${pT === 1 ? '' : 's'} to <b style="color:#cbd5e1;">${gT}</b> group-post${gT === 1 ? '' : 's'}.</div>`
    : `<div style="margin:0 0 10px;">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-bottom:4px;">
          <span>📊 Delivered <b style="color:#cbd5e1;">${pD}/${pT}</b> posts · <b style="color:#cbd5e1;">${gD}/${gT}</b> group-posts${heldN ? ` · <span style="color:#fbbf24;">${heldN} held</span>` : ''}</span>
          <span style="color:${pct === 100 ? '#34d399' : '#818cf8'};font-weight:700;">${pct}%</span>
        </div>
        <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#34d399);border-radius:99px;transition:width .3s;"></div></div>
      </div>`);

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin:2px 0 10px;">
      ${navBtn(-1, atStart, '◀')}
      <div style="flex:1;text-align:center;font-size:13px;color:#e2e8f0;font-weight:600;">${day.offset >= 0 ? `Cycle ${day.offset + 1}` : escapeHtml(day.label || 'Past')} &nbsp;<span style="font-size:11px;">${whenBadge}</span></div>
      ${navBtn(1, atEnd, '▶')}
      <button onclick="planToday()" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#cbd5e1;font-size:11px;padding:4px 10px;cursor:pointer;">Current</button>
    </div>
    ${summaryBar}
    ${rows ? `<div style="max-height:34vh;overflow:auto;border:1px solid rgba(255,255,255,0.06);border-radius:10px;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="position:sticky;top:0;background:rgba(9,13,28,0.96);">
          <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Account</th>
          <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Post</th>
          <th style="padding:6px 8px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Groups</th>
          <th style="padding:6px 8px;text-align:right;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
      : `<p class="text-xs text-gray-500 py-3">Nothing scheduled for this cycle.</p>`}
    <p style="font-size:10px;color:#475569;margin-top:8px;">Past cycles show what was actually delivered; the current &amp; upcoming cycles are the forecast. The app keeps running this plan (and resumes after a close) unless you Stop.</p>`;
}
function planNav(dir) {
  if (!_planData || !_planData.days) return;
  let idx = _planData.days.findIndex((d) => d.offset === _planSelOffset);
  if (idx < 0) idx = _planData.todayIndex;
  idx = Math.max(0, Math.min(_planData.days.length - 1, idx + dir));
  _planSelOffset = _planData.days[idx].offset;
  drawCampaignPlan();
}
function planToday() { _planSelOffset = 0; drawCampaignPlan(); }
// Throttled live refresh (called from frequent automation-progress events): re-fetch the plan at most every 8s.
let _planLiveAt = 0;
function planLiveRefresh() { const now = Date.now(); if (now - _planLiveAt < 8000) return; _planLiveAt = now; renderCampaignPlan(); }

// Posts Management
let postSearch = '';
let selectedPostIds = new Set(); // Posts-page multi-select → bulk remove
function setPostSearch(v, sel0, sel1) { postSearch = v || ''; renderPosts(); const el = document.getElementById('post-search'); if (el) { try { el.focus(); const p = (sel0 == null ? el.value.length : sel0); el.setSelectionRange(p, sel1 == null ? p : sel1); } catch {} } }

// --- Posts multi-select ---------------------------------------------------
function togglePostSelect(id, ev) { if (ev) ev.stopPropagation(); id = String(id); if (selectedPostIds.has(id)) selectedPostIds.delete(id); else selectedPostIds.add(id); renderPosts(); }
// Select-all toggles over the CURRENTLY VISIBLE (filtered) posts only, so it does what the user sees.
let _postsVisibleIds = []; // set by renderPosts to the ids of the filtered cards on screen
function toggleSelectAllPosts() {
  const ids = (_postsVisibleIds || []).map(String);
  const allOn = ids.length && ids.every((i) => selectedPostIds.has(i));
  if (allOn) ids.forEach((i) => selectedPostIds.delete(i)); else ids.forEach((i) => selectedPostIds.add(i));
  renderPosts();
}
function clearPostSelection() { selectedPostIds.clear(); renderPosts(); }
async function bulkDeletePosts() {
  const ids = [...selectedPostIds];
  if (!ids.length) return;
  if (!(await themedConfirm(`${ids.length} post${ids.length > 1 ? 's' : ''} will be removed from your library.`, { title: 'Delete selected posts', confirmText: `Delete ${ids.length}`, danger: true }))) return;
  const result = await window.electronAPI.deletePosts(ids);
  if (result && result.success) {
    selectedPostIds.clear();
    const n = result.removed != null ? result.removed : ids.length;
    showNotification(`Deleted ${n} post${n > 1 ? 's' : ''}.`, 'success');
    await loadData();
  } else {
    showNotification('Failed to delete posts: ' + ((result && result.error) || 'unknown error'), 'error');
  }
}

function renderPosts() {
  const container = document.getElementById('posts-container');

  if (appData.posts.length === 0) {
    postSearch = ''; // don't let a stale search hide the first post re-added after a clear-all
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">📝</div>
        <h3>No posts yet</h3>
        <p>Add your first post to get started</p>
        <button class="btn-primary" onclick="openAddPostModal()">
          <span>➕</span> Add Post
        </button>
      </div>
    `;
    return;
  }

  const q = (postSearch || '').toLowerCase();
  const fposts = q ? appData.posts.filter((p) => ((p.caption || '') + ' ' + (p.comment || '')).toLowerCase().includes(q)) : appData.posts;

  // Prune selection to posts that still exist (survives re-renders; drops deleted/imported-away ids).
  const existing = new Set(appData.posts.map((p) => String(p.id)));
  for (const id of [...selectedPostIds]) if (!existing.has(id)) selectedPostIds.delete(id);
  _postsVisibleIds = fposts.map((p) => String(p.id));
  const allVisibleSelected = _postsVisibleIds.length && _postsVisibleIds.every((i) => selectedPostIds.has(i));
  const selCount = selectedPostIds.size;

  const searchRow = `<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;"><input id="post-search" value="${escapeHtml(postSearch)}" oninput="setPostSearch(this.value, this.selectionStart, this.selectionEnd)" placeholder="🔍 Search posts by caption or comment…" style="flex:1;min-width:170px;padding:7px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e5e7eb;font-size:13px;outline:none;">${q ? `<span style="font-size:11px;color:#64748b;white-space:nowrap;">showing ${fposts.length}/${appData.posts.length}</span>` : ''}</div>`;
  const selectRow = `<div style="margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;cursor:pointer;user-select:none;">
        <input type="checkbox" ${allVisibleSelected ? 'checked' : ''} onclick="toggleSelectAllPosts()" style="width:16px;height:16px;cursor:pointer;accent-color:#6366f1;">
        Select all${q ? ' shown' : ''}
      </label>
      ${selCount ? `<span style="font-size:12px;color:#94a3b8;">${selCount} selected</span>
      <button onclick="bulkDeletePosts()" style="padding:6px 13px;font-size:13px;font-weight:600;color:#fff;background:linear-gradient(135deg,#ef4444,#dc2626);border:none;border-radius:8px;cursor:pointer;">🗑️ Delete selected (${selCount})</button>
      <button onclick="clearPostSelection()" title="Clear selection" style="padding:6px 12px;font-size:13px;color:#cbd5e1;background:#1e293b;border:1px solid #334155;border-radius:8px;cursor:pointer;">✕ Clear</button>` : ''}
    </div>`;
  // POST SETS bar: manage named sets + (when posts are selected) bulk-assign them to a set.
  const sets = ((appData.settings || {}).postSets) || [];
  const setChips = sets.map((s) => {
    const cnt = appData.posts.filter((p) => p.postSetId === s.id).length;
    return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;background:rgba(99,102,241,0.14);color:#c7d2fe;border:1px solid rgba(99,102,241,0.35);border-radius:999px;padding:3px 10px;">📦 ${escapeHtml(s.name)} <span style="color:#94a3b8;">(${cnt})</span><span onclick="deletePostSet('${escapeAttr(s.id)}')" title="Delete set (posts revert to default)" style="cursor:pointer;color:#f87171;font-weight:700;margin-left:2px;">✕</span></span>`;
  }).join('');
  const assignDropdown = selCount ? `<select onchange="if(this.value!==''){assignSelectedToSet(this.value==='__none__'?'':this.value);this.value='';}" style="font-size:12px;padding:5px 8px;background:#0f172a;border:1px solid #6366f1;border-radius:8px;color:#e5e7eb;cursor:pointer;">
      <option value="">📦 Assign ${selCount} selected to…</option>
      <option value="__none__">— default (all) —</option>
      ${sets.map((s) => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.name)}</option>`).join('')}
    </select>` : '';
  const postSetsBar = `<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 11px;background:rgba(30,41,59,0.5);border:1px solid #334155;border-radius:10px;">
      <span style="font-size:12px;font-weight:700;color:#cbd5e1;" title="Tag posts into a set, then assign one set per batch in Quick Setup so each batch posts different content.">📦 Post sets:</span>
      ${sets.length ? setChips : '<span style="font-size:12px;color:#64748b;">none yet — create sets to give each batch its own posts</span>'}
      <input id="new-postset-name" placeholder="new set name" maxlength="40" onkeydown="if(event.key==='Enter'){addPostSetFromInput();}" style="font-size:12px;padding:5px 9px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e5e7eb;outline:none;width:120px;">
      <button onclick="addPostSetFromInput()" style="font-size:12px;padding:5px 11px;font-weight:600;color:#fff;background:linear-gradient(135deg,#6366f1,#4f46e5);border:none;border-radius:8px;cursor:pointer;">+ Add set</button>
      ${assignDropdown}
    </div>`;
  const postToolbar = searchRow + postSetsBar + selectRow;
  container.innerHTML = postToolbar + (fposts.length ? fposts.map(post => {
    const pid = String(post.id);
    const selected = selectedPostIds.has(pid);
    // Support both old single imagePath and new imagePaths array
    const allPaths = post.imagePaths || (post.imagePath ? [post.imagePath] : []);
    const _rawFirst = allPaths[0] || post.imageUrl || ''; // fall back to a remote image URL so URL-only posts don't show "Text Only"
    const firstImage = _rawFirst ? (/^https?:/i.test(_rawFirst) ? _rawFirst : 'file:///' + _rawFirst.replace(/\\/g, '/')) : '';
    const imageCount = allPaths.length || (post.imageUrl ? 1 : 0);
    const hasImages = !!firstImage;
    const countBadge = imageCount > 1 ? `<span style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.7);color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;">📷 ${imageCount}</span>` : '';
    
    // Build image section or text-only placeholder
    const imageSection = hasImages
      ? `<div style="position:relative;">
          <img src="${escapeAttr(firstImage)}" alt="Post" class="post-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22200%22><rect fill=%22%23e5e7eb%22 width=%22300%22 height=%22200%22/><text x=%2250%%22 y=%2250%%22 font-family=%22Arial%22 font-size=%2218%22 fill=%22%236b7280%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22>Image</text></svg>'">
          ${countBadge}
        </div>`
      : `<div style="background:linear-gradient(135deg,#1e293b,#334155);padding:24px 16px;display:flex;align-items:center;justify-content:center;min-height:100px;border-radius:12px 12px 0 0;">
          <span style="font-size:28px;">📝</span>
          <span style="color:#94a3b8;font-size:13px;margin-left:10px;font-weight:500;">Text Only</span>
        </div>`;

    const commentImageBadge = (post.commentImagePath || post.commentImageUrl) ? '<span class="post-badge">🖼️ Comment Image</span>' : '';
    const _setName = post.postSetId && (sets.find((s) => s.id === post.postSetId) || {}).name;
    const setBadge = _setName ? `<span class="post-badge" style="background:rgba(99,102,241,0.18);color:#a5b4fc;">📦 ${escapeHtml(_setName)}</span>` : '';

    return `
    <div class="post-card" style="position:relative;${selected ? 'outline:2px solid #6366f1;outline-offset:-2px;' : ''}">
      <label onclick="event.stopPropagation()" title="Select for bulk delete" style="position:absolute;top:6px;left:6px;z-index:3;background:rgba(15,23,42,0.78);border-radius:6px;padding:3px 4px;display:flex;cursor:pointer;">
        <input type="checkbox" ${selected ? 'checked' : ''} onclick="togglePostSelect('${pid}', event)" style="width:17px;height:17px;cursor:pointer;accent-color:#6366f1;margin:0;">
      </label>
      ${imageSection}
      <div class="post-content">
        <p class="post-caption">${escapeHtml(post.caption)}</p>
        <div class="post-meta">
          ${post.comment ? '<span class="post-badge">💬 Has Comment</span>' : ''}
          ${commentImageBadge}
          ${setBadge}
          <div class="post-actions">
            <button class="icon-btn" onclick="openEditPostModal('${post.id}')" title="Edit">✏️</button>
            <button class="icon-btn" onclick="deletePost('${post.id}')" title="Delete">🗑️</button>
          </div>
        </div>
      </div>
    </div>
  `}).join('') : `<div class="empty-state" style="padding:24px;"><div class="icon">🔍</div><h3>No posts match</h3><p>Clear the search to see all posts.</p></div>`);
}

// ---- POST SETS (post-groups) -----------------------------------------------------------------------
// Named sets of posts. Tag posts into a set, then in Quick Setup assign ONE set per BATCH of agents so each
// batch posts different content. Untagged posts (and batches with no set) use the whole library (default).
async function addPostSetFromInput() {
  const el = document.getElementById('new-postset-name');
  const name = ((el && el.value) || '').trim();
  if (!name) { showNotification('Type a set name first', 'error'); return; }
  const sets = (((appData.settings || {}).postSets) || []).slice();
  if (sets.some((s) => (s.name || '').toLowerCase() === name.toLowerCase())) { showNotification('A set with that name already exists', 'error'); return; }
  sets.push({ id: 'set_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name });
  appData.settings.postSets = sets;
  await window.electronAPI.saveSettings({ ...appData.settings, postSets: sets });
  showNotification(`Post set "${name}" created`, 'success');
  renderPosts();
}
async function deletePostSet(id) {
  const sets = ((appData.settings || {}).postSets) || [];
  const target = sets.find((s) => s.id === id);
  const nPosts = appData.posts.filter((p) => p.postSetId === id).length;
  const nAccts = (appData.accounts || []).filter((a) => a.postSetId === id).length;
  const detail = [nPosts ? `${nPosts} post(s)` : '', nAccts ? `${nAccts} account(s)` : ''].filter(Boolean).join(' + ');
  const okGo = await themedConfirm(detail ? `${detail} will revert to the default (all) — nothing is deleted.` : 'Nothing is tagged to this set.', { title: `Delete set "${(target && target.name) || ''}"?`, confirmText: 'Delete set', danger: true });
  if (!okGo) return;
  // ONE atomic write clears the set from settings + every post + every account (no dangling refs → no silent no-post).
  const r = await window.electronAPI.deletePostSet(id);
  if (!r || r.ok === false) { showNotification('Could not delete the set', 'error'); return; }
  appData.settings.postSets = sets.filter((s) => s.id !== id);
  appData.posts.forEach((p) => { if (p.postSetId === id) p.postSetId = null; });
  (appData.accounts || []).forEach((a) => { if (a.postSetId === id) a.postSetId = null; });
  // clear any stale Quick-Setup batch assignment pointing at the deleted set
  if (typeof qsState !== 'undefined' && qsState && qsState.batchPostSet) Object.keys(qsState.batchPostSet).forEach((sig) => { if (qsState.batchPostSet[sig] === id) qsState.batchPostSet[sig] = ''; });
  showNotification('Post set deleted', 'success');
  renderPosts();
}
async function assignSelectedToSet(setId) {
  const ids = [...selectedPostIds];
  if (!ids.length) return;
  await window.electronAPI.bulkAssignPostSet(ids, setId || '');
  for (const id of ids) { const p = appData.posts.find((x) => String(x.id) === String(id)); if (p) p.postSetId = setId || null; }
  showNotification(`Assigned ${ids.length} post(s)` + (setId ? '' : ' to default (all)'), 'success');
  renderPosts();
}

// Show/hide comment image section based on: comment enabled
function updateCommentImageVisibility() {
  const commentEnabled = document.getElementById('post-comment-enabled').checked;
  const commentImageGroup = document.getElementById('comment-image-group');
  
  if (commentEnabled) {
    commentImageGroup.style.display = 'block';
  } else {
    commentImageGroup.style.display = 'none';
  }
}

let selectedCommentImage = null; // For text-only posts with comment image

// Populate a post-set <select> in the add/edit-post modal from settings.postSets, pre-selecting currentId.
function fillPostSetSelect(selectId, currentId) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const sets = ((appData.settings || {}).postSets) || [];
  el.innerHTML = '<option value="">— default (all posts) —</option>' + sets.map((s) => `<option value="${escapeAttr(s.id)}" ${s.id === currentId ? 'selected' : ''}>📦 ${escapeHtml(s.name)}</option>`).join('');
}

function openAddPostModal() {
  selectedImages = [];
  selectedCommentImage = null;
  fillPostSetSelect('post-set', ''); // new posts default to "all posts" unless the operator picks a set
  document.getElementById('post-caption').value = '';
  document.getElementById('post-comment').value = '';
  document.getElementById('post-comment-enabled').checked = false;
  document.getElementById('comment-group').style.display = 'none';
  document.getElementById('images-preview-container').style.display = 'none';
  document.getElementById('images-preview-container').innerHTML = '';
  document.querySelector('.upload-placeholder').style.display = 'block';

  // Reset comment image
  document.getElementById('comment-image-group').style.display = 'none';
  document.getElementById('comment-image-preview').style.display = 'none';
  document.querySelector('.comment-upload-placeholder').style.display = 'block';

  // Reset URL inputs
  const imageUrlInput = document.getElementById('image-url-input');
  if (imageUrlInput) imageUrlInput.value = '';
  const commentImageUrlInput = document.getElementById('comment-image-url-input');
  if (commentImageUrlInput) commentImageUrlInput.value = '';

  openModal('modal-add-post');
}

async function handleImageSelect(e) {
  const files = e.target.files;
  for (let i = 0; i < files.length; i++) {
    if (files[i].type.startsWith('image/')) {
      await handleImageFile(files[i]);
    }
  }
}

async function handleImageFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    selectedImages.push({
      data: e.target.result.split(',')[1], // base64 without prefix
      ext: file.name.split('.').pop(),
      preview: e.target.result
    });

    // Update preview container
    const container = document.getElementById('images-preview-container');
    container.style.display = 'flex';
    document.querySelector('.upload-placeholder').style.display = 'none';

    // Add thumbnail
    const thumb = document.createElement('div');
    thumb.style.cssText = 'position:relative; display:inline-block;';
    const img = document.createElement('img');
    img.src = e.target.result;
    img.style.cssText = 'max-height:100px; border-radius:8px; object-fit:cover;';
    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.style.cssText = 'position:absolute; top:-6px; right:-6px; background:#ef4444; color:white; border:none; border-radius:50%; width:20px; height:20px; font-size:11px; cursor:pointer; display:flex; align-items:center; justify-content:center;';
    const imgRef = selectedImages[selectedImages.length - 1];
    removeBtn.onclick = (ev) => {
      ev.stopPropagation();
      const currentIdx = selectedImages.indexOf(imgRef);
      if (currentIdx !== -1) selectedImages.splice(currentIdx, 1);
      thumb.remove();
      if (selectedImages.length === 0) {
        container.style.display = 'none';
        document.querySelector('.upload-placeholder').style.display = 'block';
      }
      updateCommentImageVisibility();
    };
    thumb.appendChild(img);
    thumb.appendChild(removeBtn);
    container.appendChild(thumb);
  };
  reader.readAsDataURL(file);
}

// Mirror of automation/worker.js isSafeImageUrl — reject local/private/non-http image URLs in the UI so the
// operator gets immediate feedback instead of a silent "blocked by SSRF guard" at run time. The engine guard
// is still the real enforcement (defense-in-depth); this is fail-fast UX.
function isSafeImageUrlClient(url) {
  let u; try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) { const a = +m[1], b = +m[2]; if (a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a >= 224) return false; }
  if (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) return false;
  return true;
}

async function savePost() {
  const caption = document.getElementById('post-caption').value.trim();
  const commentEnabled = document.getElementById('post-comment-enabled').checked;
  const comment = commentEnabled ? document.getElementById('post-comment').value.trim() : '';

  if (!caption) {
    showNotification('Please enter a caption', 'error');
    return;
  }

  // Images are now optional — text-only posts are allowed

  const post = {
    caption,
    comment,
    images: selectedImages.map(img => ({ data: img.data, ext: img.ext })),
    postSetId: ((document.getElementById('post-set') || {}).value || '') || null, // post-groups tag chosen in the dialog
  };

  // Include image URL if no local images selected
  const imageUrlInput = document.getElementById('image-url-input');
  const imageUrl = imageUrlInput ? imageUrlInput.value.trim() : '';
  if (imageUrl && selectedImages.length === 0) {
    if (!isSafeImageUrlClient(imageUrl)) { showNotification('That image URL isn\'t allowed — use a public http/https image link (not a local or private address).', 'error'); return; }
    post.imageUrl = imageUrl;
  }

  // Include comment image URL if no local comment image selected
  const commentImageUrlInput = document.getElementById('comment-image-url-input');
  const commentImageUrl = commentImageUrlInput ? commentImageUrlInput.value.trim() : '';

  // Include comment image if set
  if (selectedCommentImage) {
    post.commentImage = { data: selectedCommentImage.data, ext: selectedCommentImage.ext };
  } else if (commentImageUrl) {
    if (!isSafeImageUrlClient(commentImageUrl)) { showNotification('That comment image URL isn\'t allowed — use a public http/https image link.', 'error'); return; }
    post.commentImageUrl = commentImageUrl;
  }

  const result = await window.electronAPI.addPost(post);

  if (result.success) {
    showNotification('Post added successfully!', 'success');
    closeModal('modal-add-post');
    await loadData();
  } else {
    showNotification('Failed to add post: ' + result.error, 'error');
  }
}

async function deletePost(postId) {
  if (!(await themedConfirm('This post will be removed from your library.', { title: 'Delete post', confirmText: 'Delete', danger: true }))) return;

  const result = await window.electronAPI.deletePost(postId);

  if (result.success) {
    showNotification('Post deleted successfully!', 'success');
    await loadData();
  } else {
    showNotification('Failed to delete post: ' + result.error, 'error');
  }
}

// Edit Post
let editingPostId = null;

function openEditPostModal(postId) {
  const post = appData.posts.find(p => String(p.id) === String(postId));
  if (!post) return;

  editingPostId = postId;
  fillPostSetSelect('edit-post-set', post.postSetId || '');
  document.getElementById('edit-post-caption').value = post.caption || '';
  document.getElementById('edit-post-comment').value = post.comment || '';
  { const el = document.getElementById('edit-post-image-url'); if (el) el.value = post.imageUrl || ''; }
  { const el = document.getElementById('edit-post-comment-image-url'); if (el) el.value = post.commentImageUrl || ''; }
  openModal('modal-edit-post');
}

async function saveEditPost() {
  if (!editingPostId) return;

  const caption = document.getElementById('edit-post-caption').value.trim();
  const comment = document.getElementById('edit-post-comment').value.trim();
  const imageUrl = ((document.getElementById('edit-post-image-url') || {}).value || '').trim();
  const commentImageUrl = ((document.getElementById('edit-post-comment-image-url') || {}).value || '').trim();

  if (!caption) {
    showNotification('Caption cannot be empty', 'error');
    return;
  }

  const postSetId = ((document.getElementById('edit-post-set') || {}).value || '') || null; // re-tag the post's set from the dialog
  const result = await window.electronAPI.editPost(editingPostId, { caption, comment, imageUrl, commentImageUrl, postSetId });

  if (result.success) {
    showNotification('Post updated!', 'success');
    closeModal('modal-edit-post');
    editingPostId = null;
    await loadData();
  } else {
    showNotification('Failed to update post: ' + result.error, 'error');
  }
}

// (auto-delete of posted items is handled in the backend orchestrator, per cycle)

// Groups Management
// --- Groups multi-select → bulk remove (mirrors the Posts-page pattern) -----------------
let selectedGroupIds = new Set();
function toggleGroupSelect(id, ev) { if (ev) ev.stopPropagation(); id = String(id); if (selectedGroupIds.has(id)) selectedGroupIds.delete(id); else selectedGroupIds.add(id); renderGroups(); }
function toggleSelectAllGroups() {
  const ids = (appData.groups || []).map((g) => String(g.id));
  const allOn = ids.length && ids.every((i) => selectedGroupIds.has(i));
  if (allOn) ids.forEach((i) => selectedGroupIds.delete(i)); else ids.forEach((i) => selectedGroupIds.add(i));
  renderGroups();
}
function clearGroupSelection() { selectedGroupIds.clear(); renderGroups(); }
async function bulkDeleteGroups() {
  const ids = [...selectedGroupIds];
  if (!ids.length) return;
  if (!(await themedConfirm(`${ids.length} group${ids.length > 1 ? 's' : ''} will be removed from your list.`, { title: 'Delete selected groups', confirmText: `Delete ${ids.length}`, danger: true }))) return;
  const result = await window.electronAPI.deleteGroups(ids);
  if (result && result.success) {
    selectedGroupIds.clear();
    const n = result.removed != null ? result.removed : ids.length;
    showNotification(`Deleted ${n} group${n > 1 ? 's' : ''}.`, 'success');
    await loadData();
  } else {
    showNotification('Failed to delete groups: ' + ((result && result.error) || 'unknown error'), 'error');
  }
}

function renderGroups() {
  try { renderModeratorPanel(); } catch {}
  const container = document.getElementById('groups-container');

  if (appData.groups.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">👥</div>
        <h3>No groups yet</h3>
        <p>Add Facebook groups to post to</p>
        <button class="btn-primary" onclick="openAddGroupModal()">
          <span>➕</span> Add Group
        </button>
      </div>
    `;
    return;
  }

  // When there are 2+ moderators, let each group pick which one approves its held posts.
  const mods = (appData.accounts || []).filter((a) => a.isModerator);
  const modSelect = (group) => {
    if (mods.length < 2) return '';
    const opts = ['<option value="">Mod: Auto</option>']
      .concat(mods.map((m) => `<option value="${escapeHtml(m.name)}" ${group.moderatedBy === m.name ? 'selected' : ''}>🛡️ ${escapeHtml(m.alias || m.name)}</option>`)).join('');
    return `<select title="Which moderator approves this group's held posts" onchange="updateGroupModerator('${group.id}', this.value)" style="margin-right:8px; padding:5px 8px; background:#1f2937; border:1px solid #374151; border-radius:6px; color:#e5e7eb; font-size:12px;">${opts}</select>`;
  };
  // Prune selection to groups that still exist, then build the bulk-select toolbar (mirrors Posts).
  const existing = new Set(appData.groups.map((g) => String(g.id)));
  for (const id of [...selectedGroupIds]) if (!existing.has(id)) selectedGroupIds.delete(id);
  const allSelected = appData.groups.length && appData.groups.every((g) => selectedGroupIds.has(String(g.id)));
  const selCount = selectedGroupIds.size;
  const selectRow = `<div style="margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#cbd5e1;cursor:pointer;user-select:none;">
        <input type="checkbox" ${allSelected ? 'checked' : ''} onclick="toggleSelectAllGroups()" style="width:16px;height:16px;cursor:pointer;accent-color:#6366f1;">
        Select all
      </label>
      ${selCount ? `<span style="font-size:12px;color:#94a3b8;">${selCount} selected</span>
      <button onclick="bulkDeleteGroups()" style="padding:6px 13px;font-size:13px;font-weight:600;color:#fff;background:linear-gradient(135deg,#ef4444,#dc2626);border:none;border-radius:8px;cursor:pointer;">🗑️ Delete selected (${selCount})</button>
      ${mods.length >= 2 ? `<select onchange="bulkSetModerator(this.value); this.selectedIndex=0;" title="Assign which moderator approves held posts in the ${selCount} selected group(s)" style="padding:6px 10px;font-size:13px;color:#e5e7eb;background:#1f2937;border:1px solid #374151;border-radius:8px;cursor:pointer;">
        <option value="__none__">🛡️ Set moderator…</option>
        <option value="">Auto / lone moderator</option>
        ${mods.map((m) => `<option value="${escapeHtml(m.name)}">🛡️ ${escapeHtml(m.alias || m.name)}</option>`).join('')}
      </select>` : ''}
      <button onclick="clearGroupSelection()" title="Clear selection" style="padding:6px 12px;font-size:13px;color:#cbd5e1;background:#1e293b;border:1px solid #334155;border-radius:8px;cursor:pointer;">✕ Clear</button>` : ''}
    </div>`;

  container.innerHTML = selectRow + appData.groups.map(group => {
    const selected = selectedGroupIds.has(String(group.id));
    return `
    <div class="group-item" style="${selected ? 'outline:2px solid #6366f1;outline-offset:-2px;' : ''}">
      <label onclick="event.stopPropagation()" title="Select for bulk delete" style="display:flex;align-items:center;margin-right:6px;cursor:pointer;">
        <input type="checkbox" ${selected ? 'checked' : ''} onclick="toggleGroupSelect('${group.id}', event)" style="width:17px;height:17px;cursor:pointer;accent-color:#6366f1;margin:0;">
      </label>
      <div class="group-icon">👥</div>
      <div class="group-info">
        <div class="group-name">${escapeHtml(group.name || 'Unnamed Group')}</div>
        <div class="group-id">ID: ${escapeHtml(group.groupId)}</div>
      </div>
      <div class="group-actions">
        ${modSelect(group)}
        <button class="icon-btn" onclick="openGroupPage('${escapeHtml(group.groupId)}','members')" title="Open this group's Members / admin tools (in your browser, as admin) — approve the member or allow them to post without review">👥</button>
        <button class="icon-btn" onclick="renameGroup('${group.id}')" title="Rename">✏️</button>
        <button class="icon-btn" onclick="deleteGroup('${group.id}')" title="Delete">🗑️</button>
      </div>
    </div>
  `;
  }).join('');
}

// Open a group's Facebook page (sub='' ) or its Members/admin tools (sub='members') in the operator's browser —
// the manual fix for a "held in Spam potentiel" post: re-join as the member, or as admin allow the member to post.
function openGroupPage(groupId, sub) {
  const id = String(groupId || '').trim();
  if (!id) { showNotification('This group has no Facebook ID saved — re-add it from the group link.', 'error'); return; }
  const url = `https://www.facebook.com/groups/${encodeURIComponent(id)}${sub ? '/' + sub : ''}`;
  window.electronAPI.invoke('open-external', url)
    .then((r) => { if (!(r && r.success)) showNotification('Could not open the group: ' + ((r && r.error) || 'unknown'), 'error'); })
    .catch((e) => showNotification('Could not open the group: ' + (e.message || e), 'error'));
}

// Membership check: ask main to open a hidden browser AS this account and report member/pending/not-member per assigned
// group (read-only). Shows live progress in the automation log; renders a per-group status panel when done.
async function checkMemberships(accountName, btn) {
  if (btn && btn.disabled) return;
  const hint = document.getElementById(`mem-hint-${accountName}`);
  const box = document.getElementById(`mem-status-${accountName}`);
  if (btn) { btn.disabled = true; btn.textContent = '🔎 Checking…'; }
  if (hint) hint.textContent = 'opening a hidden browser as this account — watch the log…';
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  try {
    const res = await window.electronAPI.invoke('check-account-memberships', accountName);
    if (res && Array.isArray(res.results) && res.results.length && box) renderMembershipResults(box, res.results);
    if (!res || !res.success) { showNotification((res && res.error) || 'Membership check failed', 'error'); if (hint) hint.textContent = ''; return; }
    const memberN = (res.results || []).filter((x) => x.status === 'member').length;
    if (hint) hint.textContent = `${memberN}/${(res.results || []).length} member`;
  } catch (e) {
    showNotification('Membership check failed: ' + (e.message || e), 'error');
    if (hint) hint.textContent = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔎 Check membership'; }
  }
}
function renderMembershipResults(box, results) {
  const M = {
    member:      { i: '✅', t: 'Member',        c: '#22c55e' },
    pending:     { i: '⏳', t: 'Pending',       c: '#f59e0b' },
    not_member:  { i: '❌', t: 'Not a member',  c: '#ef4444' },
    logged_out:  { i: '🔒', t: 'Logged out',    c: '#ef4444' },
    unavailable: { i: '🚫', t: 'Unavailable',   c: '#9ca3af' },
    unknown:     { i: '❓', t: 'Unknown',        c: '#9ca3af' },
    error:       { i: '⚠️', t: 'Error',          c: '#9ca3af' },
  };
  const rows = results.map((r) => {
    const m = M[r.status] || M.unknown;
    return `<div style="display:flex; align-items:center; gap:6px; padding:3px 0; border-bottom:1px solid #273244;">
      <span title="${escapeHtml(r.status)}">${m.i}</span>
      <span style="flex:1; color:#e5e7eb;">${escapeHtml(r.name || r.groupId)}</span>
      <span style="color:${m.c}; font-weight:600; white-space:nowrap;">${m.t}</span>
    </div>`;
  }).join('');
  const cantPost = results.filter((r) => r.status === 'not_member' || r.status === 'pending' || r.status === 'logged_out').length;
  const summary = cantPost
    ? `<div style="margin-top:5px; color:#f59e0b;">⚠️ ${cantPost} group(s) this account can't post to yet — not a member / pending / logged out.</div>`
    : `<div style="margin-top:5px; color:#22c55e;">All assigned groups are joinable ✓</div>`;
  box.innerHTML = rows + summary;
  box.style.display = 'block';
}

function openAddGroupModal() {
  document.getElementById('group-id').value = '';
  document.getElementById('group-name').value = '';
  openModal('modal-add-group');
}

// Rename a group's display name (the groupId is fixed). Race-safe: fetch fresh → set → save.
async function renameGroup(groupId) {
  const cur = (appData.groups || []).find((x) => x.id === groupId);
  if (!cur) return;
  const name = await themedPrompt('Group name:', { title: 'Rename group', confirmText: 'Rename', defaultValue: cur.name || '', allowEmpty: false });
  if (name == null) return; // cancelled
  const fresh = await window.electronAPI.getData();
  const g = (fresh.groups || []).find((x) => x.id === groupId);
  if (!g) return;
  g.name = name.trim() || g.name;
  const res = await window.electronAPI.saveData(fresh);
  if (res && res.success === false) { showNotification('Failed to save: ' + (res.error || 'unknown error'), 'error'); return; }
  appData = fresh; renderGroups();
  showNotification('Group renamed', 'success');
}

async function saveGroup() {
  if (Number.isFinite(appLimits.maxGroups) && appData.groups.length >= appLimits.maxGroups) {
    showNotification(`License Limit Reached! Max Groups: ${appLimits.maxGroups}`, 'error');
    return;
  }

  let groupId = document.getElementById('group-id').value.trim();
  const groupName = document.getElementById('group-name').value.trim();

  if (!groupId) {
    showNotification('Please enter a group ID or URL', 'error');
    return;
  }

  // Extract ID from URL if provided
  if (groupId.includes('facebook.com/groups/')) {
    const match = groupId.match(/groups\/(\d+)/);
    if (match) {
      groupId = match[1];
    }
  }

  const group = {
    groupId,
    name: groupName || `Group ${appData.groups.length + 1}`
  };

  const result = await window.electronAPI.addGroup(group);

  if (result.success) {
    showNotification('Group added successfully!', 'success');
    closeModal('modal-add-group');
    await loadData();
  } else {
    showNotification('Failed to add group: ' + result.error, 'error');
  }
}

async function deleteGroup(groupId) {
  if (!(await themedConfirm('This group will be removed from your list.', { title: 'Delete group', confirmText: 'Delete', danger: true }))) return;

  const result = await window.electronAPI.deleteGroup(groupId);

  if (result.success) {
    showNotification('Group deleted successfully!', 'success');
    await loadData();
  } else {
    showNotification('Failed to delete group: ' + result.error, 'error');
  }
}

// Accounts Management
// ---- Account multi-select + bulk actions + search/filter (batch account management) -----------------
let accountSelectMode = false;
const selectedAccounts = new Set();
let accountFilter = '';
let accountStatusFilter = 'all';
const expandedProxySections = new Set();
const expandedFbNameSections = new Set();

function setAccountFilter(v, sel0, sel1) { accountFilter = v || ''; renderAccounts(); const el = document.getElementById('acct-search'); if (el) { try { el.focus(); const p = (sel0 == null ? el.value.length : sel0); el.setSelectionRange(p, sel1 == null ? p : sel1); } catch {} } }
function setAccountStatusFilter(v) { accountStatusFilter = v || 'all'; renderAccounts(); }
function toggleSelectMode() { accountSelectMode = !accountSelectMode; if (!accountSelectMode) selectedAccounts.clear(); renderAccounts(); }
function toggleAccountSelect(name) { if (selectedAccounts.has(name)) selectedAccounts.delete(name); else selectedAccounts.add(name); renderAccounts(); }
function selectAllFiltered(names) { (names || []).forEach((n) => selectedAccounts.add(n)); renderAccounts(); }
function clearAccountSelection() { selectedAccounts.clear(); renderAccounts(); }

// Stable per-account key for element IDs (account names can contain spaces / punctuation that
// break querySelector + raw IDs — hash to a safe token instead).
function acctKey(name) {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return 'a' + (h >>> 0).toString(36);
}

function toggleProxySection(name) {
  if (expandedProxySections.has(name)) expandedProxySections.delete(name);
  else expandedProxySections.add(name);
  const open = expandedProxySections.has(name);
  const k = acctKey(name);
  const body = document.getElementById(`acc-proxy-body-${k}`);
  const arrow = document.getElementById(`acc-proxy-arrow-${k}`);
  if (body) body.style.display = open ? 'block' : 'none';
  if (arrow) arrow.textContent = open ? '▾' : '▸';
}

function toggleFbNameSection(name) {
  if (expandedFbNameSections.has(name)) expandedFbNameSections.delete(name);
  else expandedFbNameSections.add(name);
  const open = expandedFbNameSections.has(name);
  const k = acctKey(name);
  const body = document.getElementById(`acc-fbname-body-${k}`);
  const arrow = document.getElementById(`acc-fbname-arrow-${k}`);
  if (body) body.style.display = open ? 'block' : 'none';
  if (arrow) arrow.textContent = open ? '▾' : '▸';
}

function accountsToolbarHtml(posters, filtered, filteredNames, s) {
  const chip = (label, val, color) => `<button onclick="setAccountStatusFilter('${val}')" style="background:${accountStatusFilter === val ? color : '#1e293b'};color:${accountStatusFilter === val ? '#fff' : '#94a3b8'};border:1px solid ${color}44;border-radius:999px;padding:4px 11px;font-size:11px;font-weight:600;cursor:pointer;">${label}</button>`;
  const btn = (label, onclick, bg, fg) => `<button onclick="${onclick}" style="background:${bg};color:${fg};border:none;border-radius:7px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;">${label}</button>`;
  const filterOpts = ['all:All posts', 'with-comments:With comments', 'without-comments:Without comments'].map((o) => { const [v, l] = o.split(':'); return `<option value="${v}">${l}</option>`; }).join('');
  const selStyle = 'background:#0f172a;border:1px solid #334155;border-radius:7px;color:#cbd5e1;font-size:12px;padding:6px 8px;cursor:pointer;';
  const bulkBar = accountSelectMode ? `
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:100%;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:8px 10px;margin-top:8px;">
      <span style="font-size:12px;color:#c7d2fe;font-weight:700;">${selectedAccounts.size} selected</span>
      ${btn(`Select all (${filteredNames.length})`, `selectAllFiltered(${escapeAttr(JSON.stringify(filteredNames))})`, '#334155', '#e5e7eb')}
      ${btn('None', 'clearAccountSelection()', '#334155', '#e5e7eb')}
      <span style="flex:1;"></span>
      ${btn('Active', "bulkAccountAction('enable')", '#334155', '#e5e7eb')}
      ${btn('⛔ Exclude', "bulkAccountAction('disable')", '#b91c1c', '#fff')}
      ${btn('🟡 Standby', "bulkAccountAction('standby')", '#d97706', '#fff')}
      ${btn('Primary', "bulkAccountAction('primary')", '#334155', '#e5e7eb')}
      ${btn('📁 Groups', 'bulkAssignGroups()', '#4f46e5', '#fff')}
      <select onchange="if(this.value){bulkAccountAction('postFilter',this.value);this.selectedIndex=0;}" style="${selStyle}"><option value="">Set filter ▾</option>${filterOpts}</select>
      ${btn('🌐 Proxy', "bulkAccountAction('proxy')", '#334155', '#e5e7eb')}
      ${btn('🔄 Check', "bulkAccountAction('check')", '#334155', '#e5e7eb')}
      ${btn('🗑️ Delete', "bulkAccountAction('delete')", '#b91c1c', '#fff')}
    </div>` : '';
  return `<div style="margin-bottom:14px;">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <input id="acct-search" value="${escapeHtml(accountFilter)}" oninput="setAccountFilter(this.value, this.selectionStart, this.selectionEnd)" placeholder="🔍 Search accounts by name or alias…" style="flex:1;min-width:170px;padding:7px 12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e5e7eb;font-size:13px;outline:none;">
      <button onclick="toggleSelectMode()" style="background:${accountSelectMode ? '#6366f1' : '#1e293b'};color:${accountSelectMode ? '#fff' : '#cbd5e1'};border:1px solid #6366f155;border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;">${accountSelectMode ? '✓ Selecting' : '☑ Select'}</button>
      <button id="btn-quick-setup" onclick="openQuickSetup()" ${isAutomationRunning ? 'disabled' : ''} title="Guided setup for your monthly workflow: define group batches, split each batch's accounts into active posters + auto-reserves, pick a daily time — it configures Campaign Plan + all settings for you in one go." style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:700;cursor:${isAutomationRunning ? 'not-allowed' : 'pointer'};opacity:${isAutomationRunning ? '0.5' : '1'};box-shadow:0 2px 10px rgba(99,102,241,0.3);">⚡ Quick Setup</button>
    </div>
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;">
      ${chip(`All ${posters.length}`, 'all', '#475569')}
      ${chip(`✅ ${s.logged}`, 'logged_in', '#22c55e')}
      ${chip(`⚠️ ${s.needs} need login`, 'needs_login', '#f59e0b')}
      ${chip(`🟡 ${s.standby} standby`, 'standby', '#f59e0b')}
      ${chip(`⛔ ${s.disabled} excluded`, 'disabled', '#6b7280')}
      ${(accountFilter || accountStatusFilter !== 'all') ? `<span style="font-size:11px;color:#64748b;margin-left:4px;">showing ${filtered.length}</span>` : ''}
    </div>
    ${bulkBar}
  </div>`;
}

async function bulkAccountAction(action, value) {
  const names = [...selectedAccounts];
  if (!names.length) { showNotification('Select at least one account first.', 'info'); return; }
  if (action === 'check') {
    showNotification(`Checking ${names.length} account(s)…`, 'info');
    for (const n of names) { try { await window.electronAPI.checkAccountStatus(n); } catch {} }
    await loadData(); showNotification('Status check complete', 'success'); return;
  }
  if (action === 'proxy') {
    const v = await themedPrompt(`Set proxy for ${names.length} selected account(s) (host:port or host:port:user:pass — leave blank to CLEAR):`, { title: 'Set proxy', confirmText: 'Apply', placeholder: 'host:port:user:pass', allowEmpty: true });
    if (v == null) return; value = v.trim();
    // Mirror the single-account set: warn on a malformed proxy (still saves — operator can fix before posting).
    if (value) { const pv = validateProxyStr(value); if (!pv.ok) showNotification(`Proxy format looks invalid — ${pv.reason}. Saved anyway; fix it before these accounts post.`, 'error'); }
  }
  if (action === 'delete' && !(await themedConfirm(`Delete ${names.length} selected account(s)?\n\nThis removes their Chromium profiles + cookies and cannot be undone.\n\nType DELETE to confirm.`, { title: 'Delete accounts', confirmText: 'Delete', danger: true, requireText: 'DELETE' }))) return;
  const res = await window.electronAPI.invoke('batch-account-action', { names, action, value });
  if (res && res.success === false) { showNotification('Batch action failed: ' + (res.error || 'unknown error'), 'error'); return; }
  if (action === 'delete') selectedAccounts.clear();
  await loadData();
  // Use the backend's ACTUAL count when it reports one — count 0 means nothing changed (selection was all moderators,
  // or the names were pruned/renamed away). The old `|| names.length` masked that as a green success.
  const _applied = (res && typeof res.count === 'number') ? res.count : names.length;
  if (_applied === 0) showNotification('0 accounts changed — nothing was applied (the selection may be all moderators or no longer exist).', 'error');
  else showNotification(`Applied to ${_applied} account(s)`, 'success');
}

// Bulk-assign GROUPS to the selected accounts. Opens a group picker (search + All/None), pre-checking the groups
// ALL selected accounts already share, then Add (union) or Replace (set exactly) onto every selected account.
function bulkAssignGroups() {
  const names = [...selectedAccounts];
  if (!names.length) { showNotification('Select at least one account first.', 'info'); return; }
  const groups = (appData.groups || []);
  if (!groups.length) { showNotification('Add groups first (Groups tab), then assign them here.', 'error'); return; }
  const sel = (appData.accounts || []).filter((a) => selectedAccounts.has(a.name) && !a.isModerator);
  const common = new Set(groups.filter((g) => sel.length && sel.every((a) => (a.assignedGroups || []).includes(g.id))).map((g) => g.id));
  const ov = document.createElement('div');
  ov.className = 'tc-overlay';
  const rowHtml = (g) => `<label class="bag-row" data-name="${escapeAttr(String(g.name || g.id).toLowerCase())}" style="display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:13px;color:#e5e7eb;"><input type="checkbox" class="bag-cb" value="${escapeAttr(g.id)}" ${common.has(g.id) ? 'checked' : ''} style="width:15px;height:15px;accent-color:#6366f1;cursor:pointer;"><span>${escapeHtml(g.name || g.id)}</span></label>`;
  ov.innerHTML = `<div class="tc-modal" style="max-width:480px;width:92%;">
      <div class="tc-title">📁 Assign groups to ${names.length} account${names.length === 1 ? '' : 's'}</div>
      <div style="display:flex;gap:7px;margin:8px 0;">
        <input id="bag-search" placeholder="🔍 filter groups…" autocomplete="off" spellcheck="false" style="flex:1;padding:7px 10px;background:#0f172a;border:1px solid #334155;border-radius:7px;color:#e5e7eb;font-size:12px;outline:none;">
        <button id="bag-all" type="button" style="font-size:12px;padding:6px 11px;border-radius:7px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">All shown</button>
        <button id="bag-none" type="button" style="font-size:12px;padding:6px 11px;border-radius:7px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;cursor:pointer;">None</button>
      </div>
      <div id="bag-list" style="max-height:46vh;overflow:auto;border:1px solid rgba(255,255,255,0.08);border-radius:9px;padding:4px;">${groups.map(rowHtml).join('')}</div>
      <div style="font-size:11px;color:#64748b;margin:9px 0 4px;line-height:1.5;"><b style="color:#94a3b8;">Add</b> keeps each account's current groups and adds the checked ones · <b style="color:#94a3b8;">Replace</b> sets them to exactly the checked ones.</div>
      <div class="tc-actions" style="margin-top:12px;">
        <button class="tc-btn" data-k="cancel" type="button" style="background:#334155;color:#e5e7eb;">Cancel</button>
        <button class="tc-btn tc-confirm" data-k="add" type="button">➕ Add</button>
        <button class="tc-btn tc-danger" data-k="replace" type="button">⇄ Replace</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => { try { document.body.removeChild(ov); } catch {} };
  const checkedIds = () => [...ov.querySelectorAll('.bag-cb')].filter((c) => c.checked).map((c) => c.value);
  ov.querySelector('#bag-search').addEventListener('input', (e) => { const q = e.target.value.trim().toLowerCase(); ov.querySelectorAll('.bag-row').forEach((r) => { r.style.display = (!q || r.dataset.name.includes(q)) ? 'flex' : 'none'; }); });
  ov.querySelector('#bag-all').addEventListener('click', () => ov.querySelectorAll('.bag-row').forEach((r) => { if (r.style.display !== 'none') r.querySelector('.bag-cb').checked = true; }));
  ov.querySelector('#bag-none').addEventListener('click', () => ov.querySelectorAll('.bag-cb').forEach((c) => { c.checked = false; }));
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelectorAll('.tc-btn').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.k;
    if (k === 'cancel') return close();
    const groupIds = checkedIds();
    if (k === 'replace' && !groupIds.length) {
      const okEmpty = await themedConfirm('No groups are checked — Replace will REMOVE every group from the selected accounts (they will not post until reassigned). Continue?', { title: 'Remove all groups?', confirmText: 'Remove all', danger: true });
      if (!okEmpty) return;
    }
    close();
    const res = await window.electronAPI.invoke('batch-account-action', { names, action: 'assignGroups', value: { groupIds, mode: k } });
    if (res && res.success === false) { showNotification('Failed: ' + (res.error || 'unknown error'), 'error'); return; }
    await loadData();
    const _n = (res && typeof res.count === 'number') ? res.count : names.length;
    if (_n === 0) showNotification('0 accounts updated — no groups were assigned. Try again, or reselect the accounts.', 'error');
    else showNotification(`${k === 'replace' ? 'Set' : 'Added'} ${groupIds.length} group(s) on ${_n} account(s)`, 'success');
  }));
  setTimeout(() => { const s = ov.querySelector('#bag-search'); if (s) s.focus(); }, 30);
}

let _warmupCounts = {}; // {accountName: priorRuns} — fetched in loadData() for the warm-up badge
// Cooling-down (rate-limit) + warm-up progress badges for an account card (so the operator can SEE both states).
function accountStatusBadges(account) {
  const out = [];
  const until = Number(account.rateLimitedUntil) || 0;
  if (until > Date.now()) {
    const mins = Math.ceil((until - Date.now()) / 60000);
    const txt = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    const strikes = Number(account.rlStrikes) || 0;
    out.push(`<div style="color:#60a5fa;font-size:11px;font-weight:600;margin-top:2px;">🧊 Cooling down — ${txt} left${strikes > 1 ? ` (strike ${strikes})` : ''} · auto-resumes</div>`);
  }
  const s = appData.settings || {};
  const wr = Number.isFinite(s.warmupRuns) ? s.warmupRuns : 5;
  const wu = _warmupCounts[account.name];
  if (s.enableWarmup && typeof wu === 'number' && wu < wr && !account.isModerator && account.standby !== true && account.enabled !== false) {
    out.push(`<div style="color:#34d399;font-size:11px;font-weight:600;margin-top:2px;">🌱 Warming up — ${wu}/${wr} runs done (browses, then posts)</div>`);
  }
  return out.join('');
}
function renderAccounts() {
  const container = document.getElementById('accounts-container');
  try { refreshProxyHealth(); } catch {} // fetch per-account proxy health in the background; re-renders if it changed
  // Prune the multi-select set to accounts that still EXIST (mirrors renderPosts/renderGroups) — else a deleted
  // account's name lingers in selectedAccounts → inflated "N selected" + dead names sent to a bulk action.
  { const _live = new Set((appData.accounts || []).map((a) => a.name)); for (const n of [...selectedAccounts]) if (!_live.has(n)) selectedAccounts.delete(n); }

  if (appData.accounts.length === 0) {
    accountFilter = ''; accountStatusFilter = 'all'; selectedAccounts.clear(); accountSelectMode = false; // reset stale filter/selection
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔐</div>
        <h3>No accounts yet</h3>
        <p>Add Facebook accounts to automate posting</p>
        <button class="btn-primary" onclick="openAddAccountModal()">
          <span>➕</span> Add Account
        </button>
      </div>
    `;
    return;
  }

  const posters = appData.accounts.filter((a) => !a.isModerator);
  const s = { logged: 0, needs: 0, disabled: 0, standby: 0 };
  for (const a of posters) { if (a.enabled === false) s.disabled++; else if (a.standby) s.standby++; if (a.status === 'logged_in') s.logged++; else if (a.enabled !== false) s.needs++; }
  const q = (accountFilter || '').toLowerCase();
  const filtered = posters.filter((a) => {
    if (q && !((a.name || '').toLowerCase().includes(q) || (a.alias || '').toLowerCase().includes(q))) return false;
    if (accountStatusFilter === 'logged_in') return a.status === 'logged_in';
    if (accountStatusFilter === 'needs_login') return a.status !== 'logged_in' && a.enabled !== false;
    if (accountStatusFilter === 'disabled') return a.enabled === false;
    if (accountStatusFilter === 'standby') return a.standby === true && a.enabled !== false;
    return true;
  });
  const filteredNames = filtered.map((a) => a.name);
  // VIRTUALIZE large fleets: rebuilding every card's innerHTML on every status tick (onDataUpdated fires on each
  // status write during a run) freezes the tab at hundreds of accounts. Cap the CARDS actually built to RENDER_CAP;
  // the toolbar counts + select-all still use the FULL filtered set, so Start/Stop/bulk-actions cover everyone.
  // Above the cap, show a notice prompting search/filter. (Pairs with the debounced re-render in onDataUpdated.)
  const RENDER_CAP = 80;
  const _over = Math.max(0, filtered.length - RENDER_CAP);
  const _visible = _over ? filtered.slice(0, RENDER_CAP) : filtered;
  const cardsHtml = filtered.length ? (_visible.map(account => {
    const isEnabled = account.enabled !== false; // treat missing/undefined as true

    let statusClass = '';
    let statusText = 'Not Logged In';

    if (account.status === 'logged_in') {
      statusClass = 'logged-in';
      statusText = 'Logged In';
    } else if (account.status === 'error') {
      statusClass = 'error';
      statusText = 'Error';
    } else if (account.status === 'checking') {
      statusClass = 'checking';
      statusText = 'Checking…';
    } else if (account.status === 'logging_in') {
      statusClass = 'logging-in';
      statusText = 'Logging In…';
    } else if (account.status === 'rate_limited') {
      statusClass = 'rate-limited';
      statusText = 'Rate-limited';
    } else if (account.status === 'checkpoint') {
      statusClass = 'error';
      statusText = '🔐 Needs verification';
    }

    // Show lastMessage for ALL statuses (not just error/not_logged_in)
    let statusMessageHtml = '';
    if (account.lastMessage) {
      const msg = account.lastMessage.length > 80 ? account.lastMessage.substring(0, 80) + '...' : account.lastMessage;
      const msgColor = (account.status === 'error' || account.status === 'not_logged_in' || account.status === 'checkpoint') ? '#dc2626'
        : (account.status === 'logged_in') ? '#22c55e'
        : (account.status === 'rate_limited') ? '#f59e0b'
        : (account.status === 'checking' || account.status === 'logging_in') ? '#f59e0b'
        : '#9ca3af';
      const msgIcon = (account.status === 'error' || account.status === 'not_logged_in') ? '⚠️'
        : (account.status === 'logged_in') ? '✅'
        : (account.status === 'rate_limited') ? '⏸'
        : (account.status === 'checkpoint') ? '🔐'
        : (account.status === 'checking') ? '🔍'
        : (account.status === 'logging_in') ? '🔐'
        : 'ℹ️';
      statusMessageHtml = `<div title="${escapeHtml(account.lastMessage)}" style="color: ${msgColor}; font-size: 11px; margin-top: 4px; font-weight: 500;">${msgIcon} ${escapeHtml(msg)}</div>`;
    }

    // Show relative "checked X min ago" if lastChecked is set
    let lastCheckedHtml = '';
    if (account.lastChecked) {
      const diffMs = Date.now() - account.lastChecked;
      const diffMin = Math.round(diffMs / 60000);
      const checkedText = diffMin < 1 ? 'just now' : diffMin === 1 ? '1m ago' : `${diffMin}m ago`;
      lastCheckedHtml = `<div style="color: #6b7280; font-size: 10px; margin-top: 2px;">checked ${escapeHtml(checkedText)}</div>`;
    }

    // LIVE from the Chrome helper (session sync / health beacon): the account's REAL state in your Chrome profile.
    let chromeStatusHtml = '';
    if (account.chromeSeen) {
      const st = (account.chromeHealth && account.chromeHealth.state) || 'unknown';
      const ageMs = Date.now() - account.chromeSeen;
      const mins = Math.round(ageMs / 60000);
      const seenTxt = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
      // If Chrome hasn't beaconed this profile in 24h (Chrome closed), the stored state may be stale — show it gray as
      // "last seen", never a confident green 'healthy', so the operator doesn't trust an outdated all-clear.
      const stale = ageMs > 24 * 3600 * 1000;
      const meta = stale ? { c: '#9ca3af', i: '⚫', t: 'Chrome: last seen' }
        : st === 'healthy' ? { c: '#22c55e', i: '🟢', t: 'Chrome: healthy' }
        : st === 'checkpoint' ? { c: '#ef4444', i: '🔴', t: 'Chrome: needs verification' }
        : st === 'logged_out' ? { c: '#9ca3af', i: '⚪', t: 'Chrome: logged out' }
        : { c: '#9ca3af', i: '⚫', t: 'Chrome: seen' };
      const gTxt = (account.chromeGroups && account.chromeGroups.length) ? ` · ${account.chromeGroups.length} groups` : '';
      chromeStatusHtml = `<div title="Live from your Chrome profile${stale ? ' (stale — Chrome not open recently)' : ''}" style="color:${meta.c};font-size:10px;margin-top:2px;">${meta.i} ${escapeHtml(meta.t)} · ${escapeHtml(seenTxt)}${escapeHtml(gTxt)}</div>`;
    }

    // Display alias if exists
    const displayName = account.alias ? account.alias : account.name;
    const subName = account.alias ? account.name : '';

    // Get assigned groups for this account
    const assignedGroups = account.assignedGroups || [];
    const assignedCount = assignedGroups.length;
    const assignedText = assignedCount === 0 ? 'No groups assigned' : `${assignedCount} group${assignedCount > 1 ? 's' : ''} assigned`;

    // Build group options for dropdown
    let groupOptionsHtml = '';
    if (appData.groups.length === 0) {
      groupOptionsHtml = '<div style="padding: 10px; color: #9ca3af; text-align: center;">No groups available. Add groups first.</div>';
    } else {
      groupOptionsHtml = appData.groups.map(group => {
        const isChecked = assignedGroups.includes(group.id) ? 'checked' : '';
        return `
          <label class="group-checkbox-item" style="display: flex; align-items: center; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #374151; color: #e5e7eb;">
            <input type="checkbox" ${isChecked} onchange="toggleGroupAssignment('${account.name}', '${group.id}')" style="margin-right: 10px; accent-color: #3b82f6;">
            <span style="flex: 1; color: #ffffff;">${escapeHtml(group.name || 'Group ' + group.groupId)}</span>
            <span style="color: #60a5fa; font-size: 11px;">${group.groupId}</span>
          </label>
        `;
      }).join('');
    }

    // ACTIVE / EXCLUDED (account.enabled): the rare "park this account entirely" control — an Excluded
    // account neither posts NOR serves as a reserve/backup. Day-to-day "should it post?" is the Standby
    // toggle below; resting after a limit is automatic (rate-limit cooldown). Styled as a SQUARED chip so
    // it never reads as the rounded Primary/Standby pill next to it.
    const enabledPill = isEnabled
      ? `<button onclick="toggleAccountEnabled('${account.name}')" title="Active in automation. Click to EXCLUDE — parks this account entirely: it won't post and won't be used as a reserve/backup. (To rest a tired account, leave it Active — limits are handled automatically.)" style="background:#0f172a;color:#94a3b8;border:1px solid #334155;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600;cursor:pointer;line-height:1.4;">⏻ Active</button>`
      : `<button onclick="toggleAccountEnabled('${account.name}')" title="Excluded from automation — won't post and won't be used as a reserve/backup. Click to make it Active again." style="background:rgba(220,38,38,0.18);color:#fca5a5;border:1px solid rgba(220,38,38,0.5);border-radius:6px;padding:3px 9px;font-size:11px;font-weight:700;cursor:pointer;line-height:1.4;">⛔ Excluded</button>`;
    // STANDBY (backup): an extra account for these groups that posts ONLY when needed (a working account drops,
    // a post stays held, or a comment needs placing). Off = a normal Primary poster.
    const isStandby = account.standby === true;
    const standbyPill = isStandby
      ? `<button onclick="toggleAccountStandby('${account.name}')" title="Standby (backup): idle until a working account in its groups drops, a post stays held, or a comment needs placing. Click to make it a normal Primary poster." style="background:#f59e0b;color:#1f2937;border:none;border-radius:12px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer;line-height:1.4;">🟡 Standby</button>`
      : `<button onclick="toggleAccountStandby('${account.name}')" title="Primary poster. Click to make it a Standby (backup) account that only works when its groups need it." style="background:#1e293b;color:#94a3b8;border:1px solid #374151;border-radius:12px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;line-height:1.4;">Primary</button>`;

    const isSelected = selectedAccounts.has(account.name);
    const proxyExpanded = expandedProxySections.has(account.name);
    const fbNameExpanded = expandedFbNameSections.has(account.name);
    const proxyHasValue = !!(account.proxy || '').trim();
    // Auto-login readiness: BOTH email + password set (encrypted) → the worker can re-login this account itself
    // after a logout (before falling back to a reserve). Email/password are ciphertext here, so just test presence.
    const autoLoginReady = !!String(account.email || '').trim() && !!String(account.password || '').trim();
    const fbNameHasValue = !!(account.fbDisplayName || '').trim();
    const ak = acctKey(account.name);
    return `
      <div class="account-card" data-account-name="${escapeHtml(account.name)}" style="${isEnabled ? '' : 'opacity:0.5;'}${isSelected ? 'outline:2px solid #6366f1;outline-offset:1px;' : ''}">
        <div class="account-header">
          ${accountSelectMode ? `<input type="checkbox" ${isSelected ? 'checked' : ''} onclick="toggleAccountSelect(${escapeAttr(JSON.stringify(account.name))})" title="Select for bulk action" style="width:18px;height:18px;margin-right:8px;accent-color:#6366f1;cursor:pointer;flex:0 0 auto;align-self:flex-start;margin-top:4px;">` : ''}
          <div class="account-avatar">${displayName.charAt(0).toUpperCase()}</div>
          <div class="account-info">
            <h3 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${escapeHtml(displayName)} ${enabledPill} ${isEnabled ? standbyPill : ''}</h3>
            ${subName ? `<div style="color: #9ca3af; font-size: 12px; margin-top: 2px;">${escapeHtml(subName)}</div>` : ''}
            ${!isEnabled ? `<div style="color:#fca5a5;font-size:11px;font-weight:600;margin-top:2px;">⛔ Excluded — parked: won't post and won't be used as a backup</div>` : ''}
            ${isEnabled && isStandby ? `<div style="color:#f59e0b;font-size:11px;font-weight:600;margin-top:2px;">🟡 Standby (backup) — idle until a working account in its groups needs help</div>` : ''}
            <div class="account-status">
              <span class="status-dot ${statusClass}" style="${account.status === 'error' ? 'background-color: #dc2626;' : account.status === 'checking' ? 'background-color: #f59e0b;' : account.status === 'logging_in' ? 'background-color: #3b82f6;' : account.status === 'rate_limited' ? 'background-color: #f59e0b;' : ''}"></span>
              <span>${statusText}</span>
            </div>
            ${statusMessageHtml}
            ${accountStatusBadges(account)}
            ${lastCheckedHtml}
            ${chromeStatusHtml}
          </div>
        </div>

        <!-- Group Assignment Section -->
        <div class="account-groups" style="margin: 7px 0; padding: 8px; background: #1e293b; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 12px; color: #94a3b8;">📋 Assigned Groups:</span>
            <span style="font-size: 11px; color: ${assignedCount > 0 ? '#22c55e' : '#f59e0b'}; font-weight: 500;">${assignedText}</span>
          </div>
          <div class="groups-dropdown" style="position: relative;">
            <button class="btn-secondary" onclick="toggleGroupDropdown('${account.name}')" style="width: 100%; text-align: left; display: flex; justify-content: space-between; align-items: center;">
              <span>Select Groups</span>
              <span>▼</span>
            </button>
            <div id="group-dropdown-${escapeAttr(account.name)}" class="group-dropdown-menu" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: #1f2937; border: 1px solid #374151; border-radius: 6px; max-height: 200px; overflow-y: auto; z-index: 100; margin-top: 4px;">
              ${groupOptionsHtml}
            </div>
          </div>
          <div style="display:flex; gap:6px; margin-top:6px; align-items:center;">
            <button class="btn-secondary" onclick="checkMemberships('${account.name}', this)" title="Open a hidden browser AS this account and check whether it is a MEMBER of each assigned group (member / pending / not a member / logged out). Read-only — never posts. Stop the campaign first (one browser per profile)." style="font-size:11px; padding:5px 9px; white-space:nowrap;">🔎 Check membership</button>
            <span id="mem-hint-${escapeAttr(account.name)}" style="font-size:10px; color:#94a3b8;"></span>
          </div>
          <div id="mem-status-${escapeAttr(account.name)}" style="display:none; margin-top:6px; font-size:11px;"></div>
        </div>

        <!-- Posting options (compact): method (read-only) · speed · post-filter · auto-login -->
        <div class="account-posting-method" style="margin:7px 0;padding:8px 10px;background:#1e293b;border-radius:8px;display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            ${(() => { const ML = { 'campaign-plan': '🗓️ Campaign Plan', 'daily-rotation': '📅 Daily Rotation', 'post-centric': '🎯 Post to All', 'post-centric-unique': '🎯🔒 Unique', 'random': '🔀 Random', 'random-unique': '🔀🔒 Random', 'sequence': '📋 Sequence' }; const lbl = ML[account.postingOrder] || (account.postingOrder || '🗓️ Campaign Plan'); return `<span title="Posting method — set in Quick Setup" style="background:#1f2937;border:1px solid #374151;border-radius:6px;padding:4px 9px;color:#e5e7eb;font-size:12px;white-space:nowrap;">${lbl}</span>`; })()}
            <span style="font-size:11px;color:#94a3b8;margin-left:auto;">🐢 Speed</span>
            <select onchange="updateAccountPace(${escapeAttr(JSON.stringify(account.name))}, this.value)" title="How fast/human THIS account posts (Inherit follows the global default)" style="padding:5px 8px;background:#1f2937;border:1px solid #374151;border-radius:6px;color:#e5e7eb;font-size:12px;cursor:pointer;">
              <option value="" ${!account.pace ? 'selected' : ''}>⚙️ Inherit</option>
              <option value="safe" ${account.pace === 'safe' ? 'selected' : ''}>🐢 Safe</option>
              <option value="normal" ${account.pace === 'normal' ? 'selected' : ''}>⚖️ Normal</option>
              <option value="fast" ${account.pace === 'fast' ? 'selected' : ''}>⚡ Fast</option>
              <option value="turbo" ${account.pace === 'turbo' ? 'selected' : ''}>🚀 Turbo</option>
              <option value="instant" ${account.pace === 'instant' ? 'selected' : ''}>⚡ Instant (max)</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;">
            <span style="color:#94a3b8;white-space:nowrap;">📝 Filter</span>
            <select id="post-filter-${escapeAttr(account.name)}" onchange="updatePostFilter('${account.name}', this.value)" title="Which posts this account sends" style="min-width:130px;padding:5px 8px;background:#1f2937;border:1px solid #374151;border-radius:6px;color:#e5e7eb;font-size:12px;cursor:pointer;">
              <option value="all" ${(account.postFilter || 'all') === 'all' ? 'selected' : ''}>📋 All Posts</option>
              <option value="with-comments" ${account.postFilter === 'with-comments' ? 'selected' : ''}>💬 With Comments</option>
              <option value="without-comments" ${account.postFilter === 'without-comments' ? 'selected' : ''}>📄 Without Comments</option>
            </select>
            <span style="margin-left:auto;white-space:nowrap;">${autoLoginReady ? '🔑 <span style="color:#34d399;">auto-login ✓</span>' : `🔑 <a href="#" onclick="editAccount(${escapeAttr(JSON.stringify(account.name))});return false;" style="color:#fbbf24;">add password</a>`}</span>
          </div>
        </div>

        <!-- Per-Account Proxy (collapsible) -->
        <div class="acc-section">
          <button class="acc-toggle-btn${proxyExpanded ? ' open' : ''}" onclick="toggleProxySection(${escapeAttr(JSON.stringify(account.name))})">
            <span>🌐 Account Proxy${proxyHasValue ? ` <span class="acc-badge-set">● set</span> ${proxyHealthChip(account.proxy)}` : ' <span class="acc-badge-opt">(optional)</span>'}</span>
            <span id="acc-proxy-arrow-${ak}" class="acc-toggle-arrow">${proxyExpanded ? '▾' : '▸'}</span>
          </button>
          <div id="acc-proxy-body-${ak}" class="acc-section-body" style="display:${proxyExpanded ? 'block' : 'none'};">
            ${accountProxyDropdown(account)}
            <div style="margin-top:6px;font-size:11px;color:#6b7280;">Pick a proxy from your <b>Proxies</b> tab. “none” = global pool / your real IP.</div>
          </div>
        </div>

        <!-- FB Display Name (collapsible) -->
        <div class="acc-section">
          <button class="acc-toggle-btn${fbNameExpanded ? ' open' : ''}" onclick="toggleFbNameSection(${escapeAttr(JSON.stringify(account.name))})">
            <span>🪪 FB Display Name${fbNameHasValue ? ' <span class="acc-badge-set">● set</span>' : ' <span class="acc-badge-opt">(optional)</span>'}</span>
            <span id="acc-fbname-arrow-${ak}" class="acc-toggle-arrow">${fbNameExpanded ? '▾' : '▸'}</span>
          </button>
          <div id="acc-fbname-body-${ak}" class="acc-section-body" style="display:${fbNameExpanded ? 'block' : 'none'};">
            <input type="text" value="${escapeAttr(account.fbDisplayName || '')}" placeholder="e.g. Abdo Abdo — how this account appears as post author" onchange="updateFbDisplayName(${escapeAttr(JSON.stringify(account.name))}, this.value)" style="width:100%;padding:8px 12px;background:#0f172a;border:1px solid #374151;border-radius:8px;color:#e5e7eb;font-size:13px;box-sizing:border-box;outline:none;">
            <div style="margin-top:6px;font-size:11px;color:#6b7280;">Auto-captured at login; set manually if moderator approval can't match this account's posts.</div>
          </div>
        </div>

        <div class="account-actions" style="display: flex; gap: 6px;">
          <button class="btn-primary" onclick="loginAccount('${account.name}')">
            🔐 Login
          </button>
          <button class="btn-secondary" onclick="checkAccountStatusCard('${account.name}')" title="Check this account's Facebook login status now" style="padding: 8px 12px; font-size: 13px;">
            🔄 Check
          </button>
          <button class="btn-secondary" onclick="openAccountBrowser('${account.name}')" title="Open Facebook (feed) in THIS account's own browser — through its proxy, as this account" style="padding: 8px 12px; font-size: 13px;">
            🌐 Open
          </button>
          <div class="acct-group-picker" style="position: relative; display:inline-block;">
            <button class="btn-secondary" onclick="toggleAccountGroupPicker('${account.name}')" title="Open one of THIS account's assigned groups in its own browser (through its proxy) — confirm membership / re-join as this account" style="padding: 8px 12px; font-size: 13px;">
              👥 Group ▾
            </button>
            <div id="acct-group-menu-${ak}" class="acct-group-menu" style="display:none; position:absolute; top:100%; left:0; background:#1f2937; border:1px solid #374151; border-radius:6px; min-width:220px; max-height:240px; overflow-y:auto; z-index:100; margin-top:4px; box-shadow:0 6px 18px rgba(0,0,0,0.4);">
              ${(() => {
                const rows = (account.assignedGroups || []).map((gid) => (appData.groups || []).find((x) => x.id === gid)).filter((g) => g && (g.groupId || g.id));
                if (!rows.length) return '<div style="padding:10px 12px;color:#9ca3af;font-size:12px;">No groups assigned to this account.</div>';
                return rows.map((g) => {
                  const fbid = String(g.groupId || g.id);
                  return `<button class="acct-group-row" onclick="openAccountGroup('${account.name}', ${escapeAttr(JSON.stringify(fbid))})" title="Open as this account, through its proxy — confirm membership / re-join" style="display:flex;justify-content:space-between;gap:10px;width:100%;text-align:left;background:transparent;border:none;border-bottom:1px solid #374151;color:#e5e7eb;padding:8px 12px;cursor:pointer;font-size:12px;">
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(g.name || 'Group ' + fbid)}</span>
                    <span style="color:#60a5fa;flex:0 0 auto;">${escapeHtml(fbid)}</span>
                  </button>`;
                }).join('');
              })()}
            </div>
          </div>
          <button class="btn-secondary" onclick="openImportCookiesModal('${account.name}')" title="Import Cookies" style="padding: 8px 12px; font-size: 13px;">
            🍪 Cookies
          </button>
          <button class="btn-secondary icon-btn" onclick="editAccount('${account.name}')" title="Edit Name/Alias" style="padding: 8px 12px; font-size: 13px;">
            ✏️
          </button>
          <button class="btn-danger icon-btn" onclick="deleteAccount('${account.name}')" title="Delete">
            🗑️
          </button>
        </div>
      </div>
    `;
  }).join('') + (_over ? `<div class="empty-state" style="padding:20px;grid-column:1 / -1;"><div class="icon">📋</div><h3>Showing ${RENDER_CAP} of ${filtered.length} accounts</h3><p>Use the search box or a status filter above to narrow the list. Start / Stop, bulk actions and select-all still apply to all ${filtered.length}.</p></div>` : '')) : `<div class="empty-state" style="padding:28px;"><div class="icon">🔍</div><h3>No accounts match</h3><p>Adjust the search or status filter above.</p></div>`;
  container.innerHTML = accountsToolbarHtml(posters, filtered, filteredNames, s) + cardsHtml;
}

// Toggle Active / Excluded (account.enabled). Excluded = parked entirely: won't post, won't be a reserve.
async function toggleAccountEnabled(accountName) {
  await window.electronAPI.toggleAccount(accountName);
  await loadData();
  const a = (appData.accounts || []).find((x) => x.name === accountName);
  if (a) showNotification(a.enabled === false
    ? `⛔ ${accountName} is now Excluded — it won't post and won't be used as a backup`
    : `${accountName} is now Active in automation`, 'success');
}

// Toggle Standby (backup) — a Standby account never posts in normal cycles; it only steps in for ITS groups
// when a working account there drops, a post stays held, or a comment needs placing. Persists via saveData
// (the account's `standby` field rides along; the orchestrator reads it to keep it out of the posting pool).
async function toggleAccountStandby(accountName) {
  const a = await patchAccount(accountName, (acc) => { acc.standby = !acc.standby; });
  if (!a) return;
  showNotification(a.standby
    ? `🟡 ${accountName} is now Standby (backup) — it won't post normally; it steps in only when its groups need it`
    : `${accountName} is now a Primary poster again`, 'success');
  renderAccounts();
}

// Standalone account-card "Check" — probe this account's Facebook login status without opening the login modal.
// Probe an account's FB login status and refresh the UI from the result. Shared by the account-card
// "Check" and the login-modal "Check Login Status".
async function probeLogin(name) {
  const result = await window.electronAPI.checkAccountStatus(name);
  await loadData();
  return result;
}

const _checkInFlight = new Set(); // debounce: a rapid double-click must not fire two probes / two auto-login launches
async function checkAccountStatusCard(name) {
  if (_checkInFlight.has(name)) return;
  _checkInFlight.add(name);
  showNotification(`Checking ${name}…`, 'info');
  try {
    const result = await probeLogin(name);
    if (result && result.status === 'logged_in') { showNotification(`✅ ${name}: logged in`, 'success'); return; }
    // Logged out → if this account has stored credentials, let the agent auto-login (human-like). It opens a
    // visible window and fills the form; if it hits a captcha/2FA it stops and you finish in that same window.
    const acc = (appData.accounts || []).find((a) => a.name === name);
    const hasCreds = !!(acc && acc.email && acc.password);
    if (hasCreds) {
      showNotification(`🤖 ${name}: logged out — trying human-like auto-login…`, 'info');
      try { await window.electronAPI.invoke('auto-login-account', name); }
      catch (e) { showNotification(`Auto-login failed for ${name}: ${(e && e.message) || e}`, 'error'); }
    } else {
      showNotification(`⚠️ ${name}: ${(result && result.message) || 'not logged in'} — add a password (Edit) or click Login`, 'error');
    }
  } catch (e) { showNotification(`Check failed for ${name}: ${(e && e.message) || e}`, 'error'); }
  finally { _checkInFlight.delete(name); }
}

// RDP keepalive reminder: if the app is being viewed over Remote Desktop AND the one-time disconnect-keepalive
// task isn't installed, show a dismissible corner banner. Only nags actual RDP users (never a console-only
// machine), only until it's set up or dismissed — so a fresh laptop can't silently miss the step that keeps
// runs alive after you disconnect.
async function checkRdpKeepalive() {
  try {
    if (localStorage.getItem('rdpKeepaliveDismissed') === '1') return;
    const s = await window.electronAPI.invoke('rdp-status');
    if (!s || !s.supported || s.keepaliveInstalled || !s.remoteSession) return;
    if (document.getElementById('rdp-keepalive-banner')) return;
    const el = document.createElement('div');
    el.id = 'rdp-keepalive-banner';
    el.style.cssText = 'position:fixed;bottom:16px;right:16px;max-width:430px;z-index:99999;background:#1f2937;border:1px solid #f59e0b;border-radius:12px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,0.45);font-size:13px;color:#e5e7eb;';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;font-weight:700;color:#fbbf24;margin-bottom:6px;">⚠️ Remote Desktop detected</div>
      <div style="color:#cbd5e1;line-height:1.45;margin-bottom:10px;">The disconnect-keepalive isn't set up on this laptop. When you disconnect RDP, posting can stall (the hidden browsers stop drawing). Run the one-time setup as admin so runs survive a disconnect.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="rdp-dismiss" style="background:#374151;color:#e5e7eb;border:none;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;">Dismiss</button>
        <button id="rdp-setup" style="background:#f59e0b;color:#1f2937;border:none;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;">Open setup folder</button>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('rdp-dismiss').addEventListener('click', () => { try { localStorage.setItem('rdpKeepaliveDismissed', '1'); } catch {} el.remove(); });
    document.getElementById('rdp-setup').addEventListener('click', async () => {
      try { await window.electronAPI.invoke('open-rdp-setup'); showNotification('Right-click rdp-keepalive-setup.ps1 → Run with PowerShell (as admin). See SETUP-RDP.md.', 'info'); } catch {}
    });
  } catch {}
}

// Toggle group dropdown visibility
function toggleGroupDropdown(accountName) {
  const dropdown = document.getElementById(`group-dropdown-${accountName}`);
  const isVisible = dropdown.style.display === 'block';

  // Close all dropdowns first
  document.querySelectorAll('.group-dropdown-menu').forEach(d => d.style.display = 'none');

  // Toggle this one
  dropdown.style.display = isVisible ? 'none' : 'block';
}

// Toggle group assignment for an account
// Serialize renderer structural account writes (assignedGroups / pace / filter) through ONE chain: each does
// getData→mutate→saveData, so two rapid overlapping toggles would otherwise each carry a full snapshot and the later
// save clobbers the earlier's edit (a lost update). The chain makes each read-modify-write finish before the next starts.
let _acctWriteChain = Promise.resolve();
function queueAcctWrite(fn) { const run = _acctWriteChain.then(fn, fn); _acctWriteChain = run.then(() => {}, () => {}); return run; }
async function toggleGroupAssignment(accountName, groupId) {
 return queueAcctWrite(async () => {
  // Work against FRESH backend data so we don't overwrite backend changes (e.g. auto-delete
  // during a running campaign) with a stale local appData.
  const fresh = await window.electronAPI.getData();
  if (!fresh || !Array.isArray(fresh.accounts)) return;
  const account = fresh.accounts.find(a => a.name === accountName);
  if (!account) return;

  if (!account.assignedGroups) account.assignedGroups = [];
  const index = account.assignedGroups.indexOf(groupId);
  if (index === -1) account.assignedGroups.push(groupId);
  else account.assignedGroups.splice(index, 1);

  // Save to backend, then sync local state
  const res = await window.electronAPI.saveData(fresh);
  if (res && res.success === false) { showNotification('Failed to save assignment: ' + res.error, 'error'); return; }
  appData = fresh;

  // Update just the count display without re-rendering (keeps dropdown open)
  const assignedCount = account.assignedGroups.length;
  const assignedText = assignedCount === 0 ? 'No groups assigned' : `${assignedCount} group${assignedCount > 1 ? 's' : ''} assigned`;

  // Find and update the count display for this account
  const accountCards = document.querySelectorAll('.account-card');
  accountCards.forEach(card => {
    const dropdownBtn = card.querySelector(`[onclick*="toggleGroupDropdown('${accountName}')"]`);
    if (dropdownBtn) {
      const countSpan = card.querySelector('.account-groups > div > span:last-child');
      if (countSpan) {
        countSpan.textContent = assignedText;
        countSpan.style.color = assignedCount > 0 ? '#22c55e' : '#f59e0b';
      }
    }
  });
 });
}


// ─────────────────────────────────────────────────────────────────────────────
// QUICK SETUP (Campaign) — a guided onboarding that CONFIGURES the existing
// Campaign Plan engine for the operator's monthly workflow; it adds NO new posting
// logic. Steps: (1) define group batches, (2) auto-split accounts evenly across
// them, (3) pick a daily run time. On Apply it writes each batch's groups onto its
// accounts' assignedGroups (forming the Campaign Plan clusters), sets every involved
// account to postingOrder='campaign-plan', and turns on Loop Campaign + the Daily
// schedule. Excluded accounts (enabled===false) are skipped entirely — never shown,
// never assigned, never re-enabled. All inline handlers call FUNCTIONS only (never reference the
// `qsState` let-binding directly) so they resolve in classic inline-handler scope.
// ─────────────────────────────────────────────────────────────────────────────
let qsState = null;

// WORK PATTERNS — how a batch's shared library is delivered. Chosen on the Plan step. `order` = the engine
// postingOrder it maps to; `ready` gates the ones still being built (added one by one).
const WORK_PATTERNS = {
  split:    { label: '🧩 Split across agents', tag: 'fastest', order: 'campaign-plan', extra: { loopCampaign: true, completionMode: false, shuffleCampaign: false }, ready: true,
    desc: 'Agents in a batch divide the list — agent 1 posts #1, agent 2 posts #2, … to the shared groups. No two agents post the same post in a cycle; finishes in posts÷agents cycles.' },
  random:   { label: '🔀 Random order', tag: 'shuffled', order: 'campaign-plan', extra: { loopCampaign: true, completionMode: false, shuffleCampaign: true }, ready: true,
    desc: 'Same batch split, but the list is shuffled before it\'s divided (and reshuffled each round) — agents don\'t post in a predictable #1,#2,#3 order. More human.' },
};

// Launch ORDER across batches (how the agents fire within a cycle). Start-order only — what each agent posts is
// unchanged. All three are always available.
const FIRE_ORDERS = {
  batch:      { label: '📋 Grouped by batch', desc: 'All of batch 1 fire, then batch 2 … (A1 A2 A3, then B1 B2 B3).' },
  interleave: { label: '🔀 Interleaved', desc: 'Round-robin across batches (A1 B1 A2 B2 A3 B3) — spreads each post across different groups.' },
  random:     { label: '🎲 Random', desc: 'Shuffle the launch order every cycle — hardest to fingerprint.' },
};

// Posting accounts for Quick Setup (exclude moderators + disabled accounts).
function qsPosters() { return ((appData && appData.accounts) || []).filter((a) => !a.isModerator && a.enabled !== false); }
// Parallel accounts = number of distinct usable proxies (one per batch); falls back to a per-account count.
function qsProxyCount(data) {
  const pool = ((data.proxies || []).filter((p) => p && String(p).trim())).length;
  const perAcct = (data.accounts || []).filter((a) => a && !a.isModerator && a.enabled !== false && a.proxy && String(a.proxy).trim()).length;
  return pool || perAcct;
}

// Speed preset to merge into settings from the QS speed selector (turbo/fast/normal/slow).
function qsSpeedSettings() {
  const s = qsState.speed || 'normal';
  return (s !== 'normal' && typeof SPEED_PRESETS !== 'undefined' && SPEED_PRESETS[s]) ? { speedMode: s, ...SPEED_PRESETS[s] } : { speedMode: 'normal' };
}

function openQuickSetup() {
  if (isAutomationRunning) { showNotification('Stop the automation before running Quick Setup.', 'error'); return; }
  const groups = (appData && appData.groups) || [];
  const posters = qsPosters();
  if (!groups.length) { switchView('groups'); showNotification('Add some groups first, then run Quick Setup.', 'error'); return; }
  if (!posters.length) {
    const anyPoster = ((appData && appData.accounts) || []).some((a) => !a.isModerator);
    switchView('accounts');
    showNotification(anyPoster ? 'All your accounts are Excluded — set at least one to Active first.' : 'Add posting accounts first, then run Quick Setup.', 'error');
    return;
  }
  const s = (appData && appData.settings) || {};
  const time = s.dailyPostTime || '09:00';
  // Per-method parameters (the operator controls these in the wizard): shuffle order, loop-vs-stop for unique,
  // posts/group cap for post-to-all, and continuous-vs-daily schedule.
  qsState = { step: 1, time, method: 'daily-rotation', loadedDR: false, scheduleContinuous: false,
    moderationEnabled: !!s.moderationEnabled, moderationDryRun: (s.moderationDryRun === undefined ? true : !!s.moderationDryRun), // first-ever run defaults dry-run ON, but RESPECT a stored false (don't silently re-enable it every time the wizard opens)
    autoStartDaily: !!s.autoStartDaily, // 🕒 Windows clock-hook: auto-launch + post daily even if the app is closed
    speed: s.speedMode || 'normal', // global speed selector (instant/turbo/fast/normal/slow), applied on finish
    accountsPerBatch: Math.max(1, parseInt(s.accountsPerBatch, 10) || 1), // contiguous-block assignment knobs
    groupsPerBlock: Math.max(1, parseInt(s.groupsPerBlock, 10) || 4),
    // Advanced options (collapsed panel on the Review step) — all plain settings, applied via saveSettings.
    hideBrowser: s.hideBrowser !== false, // default ON (off-screen)
    enableWarmup: !!s.enableWarmup,
    warmupRuns: Number.isFinite(s.warmupRuns) ? s.warmupRuns : 5,
    rateLimitCooldownHours: Number.isFinite(s.rateLimitCooldownHours) ? s.rateLimitCooldownHours : 4,
    dailyCap: Number.isFinite(s.dailyCap) ? s.dailyCap : 0,
    autoDeletePosted: !!s.autoDeletePosted,
    resumeOnStartup: s.resumeOnStartup === true,
    enableTunnel: !!s.enableTunnel,
    launchOnStartup: !!s.launchOnStartup,
    pace: {} }; // per-account pacing profile (safe|normal|fast), set on the Review step
  // Seed each account's groups from its existing assignedGroups (filtered to current groups). No method
  // reconstruction, no auto-splitting — Quick Setup just reads + preserves what each account already has.
  qsState.drGroups = {};
  posters.forEach((a) => { qsState.drGroups[a.name] = (a.assignedGroups || []).filter((gid) => groups.some((g) => g.id === gid)); });
  // Per-account RESERVE (standby) for the per-account methods — a reserve waits and takes over in its groups
  // when an active account there drops. Loads from each account's current standby flag.
  qsState.drReserve = {};
  posters.forEach((a) => { qsState.drReserve[a.name] = a.standby === true; });
  // Per-account pace profile. Keep the "unset" sentinel (undefined) distinct from an explicit 'normal' so an
  // untouched account keeps INHERITING settings.defaultPace instead of being pinned. The dropdown shows 'Normal'
  // for undefined (display-only); only an explicit pick is written back.
  posters.forEach((a) => { qsState.pace[a.name] = QS_PACES.includes(a.pace) ? a.pace : undefined; }); // seed from stored pace (incl. turbo/instant) so re-opening QS preserves it
  // Campaign Plan is the main method: a batch (agents sharing a group-set) SPLITS the library across its agents.
  // The WORK PATTERN (chosen on the Plan step) picks how that split runs; 'split' (the proven engine campaign-plan)
  // is the default. Each account's existing groups are preserved via drGroups (seeded from its assignedGroups).
  qsState.method = 'campaign-plan';
  qsState.scheduleContinuous = false;
  qsState.workPattern = WORK_PATTERNS[qsState.workPattern] ? qsState.workPattern : (s.workPattern && WORK_PATTERNS[s.workPattern] ? s.workPattern : 'split');
  qsState.fireOrder = FIRE_ORDERS[qsState.fireOrder] ? qsState.fireOrder : (s.fireOrder && FIRE_ORDERS[s.fireOrder] ? s.fireOrder : 'batch');
  // Per-BATCH proxy: every account in a batch shares ONE proxy/IP → batches with DIFFERENT IPs run in parallel,
  // accounts within a batch serialize (anti-link). Seed each batch from the proxy its accounts already carry.
  qsState.batchProxy = {};
  posters.forEach((a) => { const sig = (qsState.drGroups[a.name] || []).slice().sort().join('|'); if (sig && a.proxy && String(a.proxy).trim() && qsState.batchProxy[sig] === undefined) qsState.batchProxy[sig] = a.proxy; });
  // Seed per-batch post-set from existing account assignments so re-opening Quick Setup preserves the operator's choices.
  qsState.batchPostSet = {};
  posters.forEach((a) => { const sig = (qsState.drGroups[a.name] || []).slice().sort().join('|'); if (sig && a.postSetId && qsState.batchPostSet[sig] === undefined) qsState.batchPostSet[sig] = a.postSetId; });
  qsRenderModal();
}

function qsSetModeration(v) { qsState.moderationEnabled = !!v; qsRenderModal(); }
function qsSetModerationDry(v) { qsState.moderationDryRun = !!v; qsRenderModal(); }

// Moderator section — shown in every method's final step so the wizard configures the held-post safety net too.
// If a moderator account exists, lets the operator turn approval ON (+ dry-run first); else explains how to add one.
function qsModeratorSectionHtml() {
  const on = !!qsState.moderationEnabled;
  // OFF → NO admin shown. Held ("Spam potentiel") posts are instead re-posted by a healthy reserve to get them live.
  if (!on) {
    return `
    <div style="border:1px solid rgba(255,255,255,0.1);background:rgba(15,23,42,0.5);border-radius:10px;padding:10px 12px;margin-bottom:10px;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#cbd5e1;font-weight:700;"><input type="checkbox" onchange="qsSetModeration(this.checked)"> 🛡️ Enable moderator approval (your own groups)</label>
      <div style="font-size:11px;color:#94a3b8;margin-top:6px;line-height:1.5;">Off → if Facebook holds a post in "Spam potentiel", a healthy <b style="color:#cbd5e1;">reserve</b> re-posts it so it still goes live (no admin needed). Check this to approve held posts with an admin account instead.</div>
    </div>`;
  }
  // ON → show the admin account + dry-run.
  const mod = ((appData && appData.accounts) || []).find((a) => a.isModerator);
  if (!mod) {
    return `
    <div style="border:1px solid rgba(16,185,129,0.35);background:rgba(16,185,129,0.06);border-radius:10px;padding:10px 12px;margin-bottom:10px;">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#cbd5e1;font-weight:700;"><input type="checkbox" checked onchange="qsSetModeration(this.checked)"> 🛡️ Approve held posts with an admin</label>
      <div style="font-size:11px;color:#fbbf24;margin-top:6px;line-height:1.5;">⚠️ No moderator account set — add one on the Accounts tab (mark it Moderator) and log it in, or uncheck this to let a reserve re-post held posts.</div>
    </div>`;
  }
  const ready = mod.status === 'logged_in';
  const hasProxy = !!(mod.proxy && String(mod.proxy).trim());
  return `
    <div style="border:1px solid rgba(16,185,129,0.35);background:rgba(16,185,129,0.06);border-radius:10px;padding:10px 12px;margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:13px;color:#e2e8f0;font-weight:700;">🛡️ Moderator: ${escapeHtml(mod.alias || mod.name)}</span>
        <span style="font-size:10px;color:${ready ? '#34d399' : '#fbbf24'};">${ready ? '✓ logged in' : '⚠️ log in'}</span>
        <span style="font-size:10px;color:${hasProxy ? '#34d399' : '#fbbf24'};" title="A moderator should have its own IP too.">${hasProxy ? '✓ own IP' : '⚠️ no proxy'}</span>
        <label style="margin-left:auto;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#cbd5e1;font-weight:600;"><input type="checkbox" checked onchange="qsSetModeration(this.checked)"> Approve held posts</label>
      </div>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:#94a3b8;margin-top:8px;line-height:1.4;"><input type="checkbox" ${qsState.moderationDryRun ? 'checked' : ''} onchange="qsSetModerationDry(this.checked)"> <span><b style="color:#cbd5e1;">Dry run first</b> — log what it WOULD approve without approving (recommended for the first run; turn off once you've confirmed it finds the buttons).</span></label>
      ${!ready ? `<div style="font-size:11px;color:#fbbf24;margin-top:7px;">⚠️ Log the moderator in (Accounts tab) or it can't approve.</div>` : ''}
    </div>`;
}

const QS_PACES = ['safe', 'normal', 'fast', 'turbo', 'instant'];
function qsSetPace(name, val) { if (QS_PACES.includes(val)) qsState.pace[name] = val; qsRenderModal(); }
// Bulk speed controls (Review step): set EVERY account (active + reserve) to one pace, or assign each a RANDOM
// pace (varied speeds read more human across a fleet). Operates on the same rows the Review table shows.
function qsSetAllPace(val) { if (!QS_PACES.includes(val)) return; for (const r of qsReviewAccounts()) qsState.pace[r.acct.name] = val; qsRenderModal(); }
// Global speed for the WHOLE run (like the Settings-tab preset): sets every timing param at once on finish via
// qsSpeedSettings. Instant is treated identically to the other tiers here. Per-account pace still overrides.
function qsSetSpeed(val) { if (typeof SPEED_PRESETS !== 'undefined' && SPEED_PRESETS[val]) { qsState.speed = val; qsRenderModal(); } }
// Randomize WITHIN a tempo band: clicking 🎲 reveals 4 bands; each gives every account a random pace from that
// band's set (varied speeds read more human, but all in the tempo you picked).
const QS_RANDOM_BANDS = {
  superfast: { label: '🚀 Super fast', set: ['turbo', 'fast'] },
  fast:      { label: '⚡ Fast', set: ['turbo', 'fast', 'normal'] },
  normal:    { label: '⚖️ Normal', set: ['safe', 'normal', 'fast'] },
  slow:      { label: '🐢 Slow', set: ['safe', 'normal'] },
};
function qsToggleRandomize() { qsState.randomizeOpen = !qsState.randomizeOpen; qsRenderModal(); }
function qsRandomizePace(band) {
  const set = (QS_RANDOM_BANDS[band] && QS_RANDOM_BANDS[band].set) || QS_PACES;
  for (const r of qsReviewAccounts()) qsState.pace[r.acct.name] = set[Math.floor(Math.random() * set.length)];
  qsState.randomizeOpen = false; qsRenderModal();
}
// Full per-account plan: which posts each ACTIVE agent publishes (its slice of the batch split, 1 per cycle, in
// order). Mirrors the engine campaign split (agent j in a K-agent batch gets posts where idx%K===j).
// Posts a batch (group-signature) draws from in the PREVIEW — its assigned post-set, else the whole library.
// Mirrors the engine's per-cluster split so Quick Setup shows the REAL per-batch counts, not the full library.
function qsPostsForSig(sig) {
  const posts = appData.posts || [];
  const setId = (qsState.batchPostSet || {})[sig] || '';
  return setId ? posts.filter((p) => (p.postSetId || null) === setId) : posts;
}
function qsBatchSetName(sig) {
  const sid = (qsState.batchPostSet || {})[sig];
  if (!sid) return '';
  const s = (((appData.settings || {}).postSets) || []).find((x) => x.id === sid);
  return s ? s.name : '';
}
function qsAccountPlan() {
  const clusters = {};
  for (const a of qsDRActive()) { const sig = (qsState.drGroups[a.name] || []).slice().sort().join('|'); if (!sig) continue; (clusters[sig] = clusters[sig] || []).push(a); }
  const out = [];
  for (const sig in clusters) {
    const members = clusters[sig]; const K = members.length;
    const cPosts = qsPostsForSig(sig); // per-batch set (or whole library when no set assigned)
    members.forEach((a, j) => { out.push({ name: a.name, alias: a.alias || a.name, groups: (qsState.drGroups[a.name] || []).length, nums: cPosts.map((_, idx) => idx).filter((idx) => idx % K === j).map((idx) => idx + 1) }); });
  }
  return out;
}
function qsMethodLabel() { return qsState.method === 'campaign-plan' ? 'Campaign Plan' : qsState.method === 'daily-rotation' ? 'Daily Rotation' : qsState.method === 'sequence' ? 'Sequential' : 'Post to All'; }
function qsScheduleLabel() { return (qsState.method === 'campaign-plan' || qsState.method === 'daily-rotation') ? `daily at ${qsState.time}` : (qsState.scheduleContinuous ? 'continuous (paced)' : `daily at ${qsState.time}`); }

// All participating accounts for the current method, each tagged active/reserve + its group count. Campaign
// flattens the per-batch active/reserve lists; the per-account methods use drGroups + drReserve.
function qsReviewAccounts() {
  return qsPosters().filter((a) => (qsState.drGroups[a.name] || []).length)
    .map((a) => ({ acct: a, role: qsState.drReserve[a.name] ? 'reserve' : 'active', groups: (qsState.drGroups[a.name] || []).length }));
}

// FINAL STEP (every method): Review & Start readiness — a global summary + a per-account table showing
// login/proxy readiness AND a per-account PACE control, so the operator confirms (and tunes) the whole run
// in one place before Apply / Save & Start.
// The FULL posting plan — a clear, method-aware "exactly what will happen" so the operator confirms the run
// without guessing (and without opening Settings — the wizard configures everything).
function qsPlanHtml() {
  const posts = (appData.posts || []); const P = posts.length;
  const num = (n) => `#${n}`;
  const wrap = (inner) => `<div style="border:1px solid rgba(99,102,241,0.28);background:rgba(99,102,241,0.06);border-radius:10px;padding:11px 13px;margin-bottom:12px;">
      <div style="font-size:12px;color:#a5b4fc;font-weight:700;margin-bottom:8px;">🗓️ The plan — exactly what will happen</div>${inner}</div>`;
  if (!P) return wrap('<div style="font-size:12px;color:#fbbf24;">No posts yet — add posts on the Posts tab; the plan fills in once you do.</div>');

  const batches = qsDeriveBatches();
  if (!batches.length) return wrap('<div style="font-size:12px;color:#fbbf24;">Assign groups to your accounts first — they cluster into batches here.</div>');
  const wp = WORK_PATTERNS[qsState.workPattern] || WORK_PATTERNS.split;
  const blocks = batches.map((b, i) => {
    const bP = qsPostsForSig(b.sig).length; // THIS batch's post-set size (or the whole library when none assigned)
    const K = b.accounts.length, cycles = bP ? Math.ceil(bP / K) : 0;
    const sn = qsBatchSetName(b.sig);
    const setTag = sn ? ` <span style="color:#a5b4fc;font-weight:600;">· 📦 ${escapeHtml(sn)}</span>` : '';
    const body = bP
      ? `its ${K} agent${K === 1 ? '' : 's'} <b>split</b> ${bP} post${bP === 1 ? '' : 's'}${sn ? ` from set <b style="color:#c7d2fe;">“${escapeHtml(sn)}”</b>` : ''} (no two post the same in a cycle) → delivered in <b style="color:#c7d2fe;">${cycles} cycle${cycles === 1 ? '' : 's'}</b>, then repeats.`
      : `<span style="color:#fbbf24;">⚠️ set “${escapeHtml(sn)}” has no posts yet — tag posts to it on the Posts tab, or this batch won't post.</span>`;
    return `<div style="margin-bottom:8px;">
        <div style="font-size:12px;color:#e2e8f0;font-weight:600;">Batch ${i + 1}: ${K} agent${K === 1 ? '' : 's'} <span style="color:#94a3b8;font-weight:400;">(${escapeHtml(b.accounts.slice(0, 5).join(', '))}${b.accounts.length > 5 ? ` +${b.accounts.length - 5}` : ''})</span> → ${b.groupNames.length} group${b.groupNames.length === 1 ? '' : 's'}${setTag}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:2px;">${body}</div>
      </div>`;
  }).join('');
  return wrap(`<div style="font-size:11px;color:#94a3b8;margin-bottom:7px;"><b style="color:#cbd5e1;">${escapeHtml(wp.label.replace(/^[^ ]+ /, ''))}</b> · one cycle per day at <b style="color:#c7d2fe;">${escapeHtml(qsState.time)}</b>:</div>${blocks}`);
}
// 🕒 Daily auto-start (Windows clock hook) — the toggle on the Review step. ON = create a Task Scheduler entry
// that launches the app + posts every day at the set time even when it's CLOSED (wakes the laptop; catches up
// if the PC was off). OFF = a scheduled time only fires while the app is already open.
// Advanced-options setters (Review-step panel).
// The 8 advanced settings as one object, merged into BOTH writers (operator choices; speed preset still wins after).
function qsAdvancedSettings() {
  return {
    hideBrowser: !!qsState.hideBrowser,
    enableWarmup: !!qsState.enableWarmup,
    warmupRuns: Math.max(0, Math.min(1000, parseInt(qsState.warmupRuns, 10) || 0)),
    rateLimitCooldownHours: Math.max(0, Math.min(168, parseInt(qsState.rateLimitCooldownHours, 10) || 0)),
    dailyCap: Math.max(0, parseInt(qsState.dailyCap, 10) || 0),
    autoDeletePosted: !!qsState.autoDeletePosted,
    resumeOnStartup: !!qsState.resumeOnStartup,
    enableTunnel: !!qsState.enableTunnel,
    launchOnStartup: !!qsState.launchOnStartup,
  };
}
// Collapsed "Advanced options" panel on the Review step — puts the last setup knobs in Quick Setup so the
// operator never needs the Settings tab to get running.
function qsStepReviewHtml() {
  const rows = qsReviewAccounts();
  const P = (appData.posts || []).length;
  const useProxies = !!(appData && appData.useProxies);
  const poolSize = ((appData && appData.proxies) || []).filter((p) => p && String(p).trim()).length;
  const issuesFor = (r) => { const a = r.acct, out = []; if (a.status !== 'logged_in') out.push('login'); if (useProxies && !(a.proxy && String(a.proxy).trim()) && poolSize === 0) out.push('proxy'); return out; };
  const activeRows = rows.filter((r) => r.role === 'active');
  const reserveRows = rows.filter((r) => r.role === 'reserve');
  const blockingActives = activeRows.filter((r) => issuesFor(r).length);
  const paceSelect = (name) => { const v = qsState.pace[name] || 'normal'; const o = (val, label) => `<option value="${val}" ${v === val ? 'selected' : ''}>${label}</option>`; return `<select class="qs-select" data-acct="${escapeAttr(name)}" onchange="qsSetPace(this.getAttribute('data-acct'), this.value)" style="font-size:11px;padding:3px 6px;">${o('safe', '🐢 Safe')}${o('normal', '⚖️ Normal')}${o('fast', '⚡ Fast')}${o('turbo', '🚀 Turbo')}${o('instant', '⚡ Instant')}</select>`; };
  const sBtn = (p) => `<button onclick="qsSetAllPace('${p}')" style="font-size:11px;padding:3px 9px;border-radius:7px;border:1px solid rgba(255,255,255,0.12);background:rgba(99,102,241,0.12);color:#c7d2fe;cursor:pointer;">${({ safe: '🐢 Safe', normal: '⚖️ Normal', fast: '⚡ Fast', turbo: '🚀 Turbo', instant: '⚡ Instant' })[p]}</button>`;
  const rBtn = (k) => `<button onclick="qsRandomizePace('${k}')" style="font-size:11px;padding:3px 9px;border-radius:7px;border:1px solid rgba(52,211,153,0.4);background:rgba(16,185,129,0.16);color:#34d399;cursor:pointer;">${QS_RANDOM_BANDS[k].label}</button>`;
  const paceBar = !rows.length ? '' : `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:#94a3b8;">
      <span style="font-weight:700;color:#cbd5e1;">Set all:</span>${['safe', 'normal', 'fast', 'turbo', 'instant'].map(sBtn).join('')}
      <span style="width:8px;display:inline-block;"></span>
      ${qsState.randomizeOpen
        ? `<span style="font-weight:700;color:#34d399;">🎲 Random within:</span>${Object.keys(QS_RANDOM_BANDS).map(rBtn).join('')}<button onclick="qsToggleRandomize()" title="cancel" style="font-size:11px;padding:3px 7px;border-radius:7px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:#94a3b8;cursor:pointer;">✕</button>`
        : `<button onclick="qsToggleRandomize()" title="Give each account a random speed within a tempo band you choose" style="font-size:11px;padding:3px 9px;border-radius:7px;border:1px solid rgba(52,211,153,0.4);background:rgba(16,185,129,0.12);color:#34d399;cursor:pointer;">🎲 Randomize…</button>`}
    </div>`;
  // GLOBAL speed for the whole run (fills every timing param at once, exactly like the Settings-tab preset).
  // Instant is a first-class tier here. Per-account pace (below) still overrides individual accounts.
  const curSpeed = qsState.speed || 'normal';
  const speedBtn = (v, label) => { const on = curSpeed === v; const danger = v === 'instant'; return `<button onclick="qsSetSpeed('${v}')" title="${danger ? 'MAX speed — everything pasted, 0–7s between actions (warmed accounts + proxies only)' : ''}" style="font-size:11px;padding:3px 11px;border-radius:7px;cursor:pointer;font-weight:${on ? '700' : '500'};border:1px solid ${on ? (danger ? '#ef4444' : '#6366f1') : 'rgba(255,255,255,0.12)'};background:${on ? (danger ? 'rgba(239,68,68,0.2)' : 'rgba(99,102,241,0.28)') : 'rgba(99,102,241,0.08)'};color:${danger ? '#fca5a5' : '#c7d2fe'};">${label}</button>`; };
  const speedBar = !rows.length ? '' : `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;font-size:11px;color:#94a3b8;">
      <span style="font-weight:700;color:#cbd5e1;">⚡ Speed (whole run):</span>${speedBtn('slow', '🐢 Slow')}${speedBtn('normal', '⚖️ Normal')}${speedBtn('fast', '⚡ Fast')}${speedBtn('turbo', '🚀 Turbo')}${speedBtn('instant', '⚡ Instant')}
    </div>`;
  const tableRows = rows.map((r) => {
    const a = r.acct, iss = issuesFor(r);
    const login = a.status === 'logged_in' ? '<span style="color:#34d399;">✓</span>' : '<span style="color:#fbbf24;">⚠</span>';
    const hasProxy = a.proxy && String(a.proxy).trim();
    const proxy = !useProxies ? '<span style="color:#475569;">—</span>' : hasProxy ? '<span style="color:#34d399;">✓</span>' : poolSize ? '<span style="color:#94a3b8;">pool</span>' : '<span style="color:#f87171;">✗</span>';
    const roleBadge = r.role === 'reserve' ? '<span style="color:#fbbf24;font-size:9px;font-weight:700;">RESV</span>' : '<span style="color:#34d399;font-size:9px;font-weight:700;">ACTV</span>';
    const status = r.role === 'reserve' ? '<span style="color:#94a3b8;font-size:11px;">waits</span>' : iss.length ? `<span style="color:#fbbf24;font-size:11px;">needs ${iss.join('+')}</span>` : '<span style="color:#34d399;font-size:11px;">ready</span>';
    return `<tr>
      <td style="padding:5px 7px;font-size:12px;color:#e2e8f0;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(a.alias || a.name)}${r.batch ? ` <span style="color:#64748b;font-size:9px;">${escapeHtml(String(r.batch))}</span>` : ''}</td>
      <td style="padding:5px 6px;text-align:center;">${roleBadge}</td>
      <td style="padding:5px 6px;font-size:11px;color:#94a3b8;text-align:center;">${r.groups}</td>
      <td style="padding:5px 6px;text-align:center;">${login}</td>
      <td style="padding:5px 6px;text-align:center;">${proxy}</td>
      <td style="padding:5px 6px;text-align:center;">${paceSelect(a.name)}</td>
      <td style="padding:5px 7px;">${status}</td>
    </tr>`;
  }).join('');
  const empty = !rows.length;
  const summary = `<div style="border:1px solid rgba(99,102,241,0.3);background:rgba(99,102,241,0.08);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#c7d2fe;line-height:1.6;">
      <div style="font-size:14px;color:#e0e7ff;font-weight:800;margin-bottom:4px;">${qsMethodLabel()}</div>
      <span style="color:#cbd5e1;">📋 ${P} post${P === 1 ? '' : 's'}</span> &nbsp;·&nbsp; <span style="color:#cbd5e1;">🕘 ${escapeHtml(qsScheduleLabel())}</span> &nbsp;·&nbsp; <span style="color:#34d399;">${activeRows.length} active</span>${reserveRows.length ? ` &nbsp;·&nbsp; <span style="color:#fbbf24;">${reserveRows.length} reserve</span>` : ''} &nbsp;·&nbsp; <span style="color:#cbd5e1;">🛡️ ${qsState.moderationEnabled ? `moderator ${qsState.moderationDryRun ? '(dry-run)' : 'ON'}` : 'no approval'}</span> &nbsp;·&nbsp; <span style="color:#cbd5e1;">🌐 ${(() => { const n = new Set(Object.values(qsResolvedBatchProxies()).filter(Boolean)).size; return n ? `${n} batch IP${n === 1 ? '' : 's'}` : (useProxies ? 'proxies ON' : 'no proxies'); })()}</span> &nbsp;·&nbsp; <span style="color:#cbd5e1;">🧩 ${escapeHtml((WORK_PATTERNS[qsState.workPattern] || WORK_PATTERNS.split).label.replace(/^[^ ]+ /, ''))}</span> &nbsp;·&nbsp; <span style="color:#cbd5e1;">🚀 ${escapeHtml((FIRE_ORDERS[qsState.fireOrder] || FIRE_ORDERS.batch).label.replace(/^[^ ]+ /, ''))}</span>
    </div>`;
  const table = empty ? `<div style="border:1px solid rgba(245,158,11,0.4);background:rgba(245,158,11,0.08);border-radius:10px;padding:12px;font-size:12px;color:#fbbf24;">⚠️ No accounts have groups yet — go Back and assign groups.</div>` : `
    <div style="max-height:34vh;overflow:auto;border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
      <table class="qs-table">
        <thead><tr>
          <th>ACCOUNT</th>
          <th style="text-align:center;">ROLE</th>
          <th style="text-align:center;">GRP</th>
          <th style="text-align:center;">LOGIN</th>
          <th style="text-align:center;">PROXY</th>
          <th style="text-align:center;">PACE</th>
          <th>STATUS</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
  const paceLegend = `<div style="font-size:11px;color:#64748b;margin-top:8px;line-height:1.5;"><b style="color:#94a3b8;">⚡ Speed (whole run)</b> sets every timing at once · <b style="color:#94a3b8;">Pace</b> (per account) overrides one account: <b style="color:#cbd5e1;">🐢 Safe</b> = most human (new accounts) · <b style="color:#cbd5e1;">⚖️ Normal</b> = global tempo · <b style="color:#cbd5e1;">⚡ Fast</b> = quick, skips reading-pauses · <b style="color:#cbd5e1;">🚀 Turbo</b> = ¼ the gaps · <b style="color:#fca5a5;">⚡ Instant</b> = MAX (all pasted, 0–7s gaps — warmed accounts + proxies only). The post→comment anti-spam gap always stays randomized.</div>`;
  const wpSel = WORK_PATTERNS[qsState.workPattern] || WORK_PATTERNS.split;
  const shuffled = !!(wpSel.extra && wpSel.extra.shuffleCampaign);
  const planList = qsAccountPlan();
  const fullPlan = (!rows.length || !planList.length) ? '' : `<details open style="margin-top:10px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:8px 12px;">
      <summary style="font-size:12px;color:#cbd5e1;font-weight:700;cursor:pointer;">📋 Full plan — what each account posts${shuffled ? ' <span style="font-weight:400;color:#fbbf24;">(🔀 order reshuffled each round)</span>' : ''}</summary>
      <div style="max-height:30vh;overflow:auto;margin-top:8px;">${planList.map((p) => `<div style="font-size:11px;color:#cbd5e1;margin-bottom:4px;line-height:1.5;">• <b style="color:#e2e8f0;">${escapeHtml(p.alias)}</b> <span style="color:#64748b;">(${p.groups}g)</span> → ${p.nums.length ? `<span style="color:#94a3b8;">1/cycle:</span> ${p.nums.map((n) => `<span style="color:#c7d2fe;">#${n}</span>`).join(' → ')} <span style="color:#64748b;">(${p.nums.length} cycle${p.nums.length === 1 ? '' : 's'})</span>` : '<span style="color:#fbbf24;">no posts yet</span>'}</div>`).join('')}</div>
      <div style="font-size:10px;color:#64748b;margin-top:6px;">Reserves aren't listed — they wait and take over in their groups only if an active account there drops.</div>
    </details>`;
  const rollup = empty ? '' : (!activeRows.length && reserveRows.length
    ? `<div style="border:1px solid rgba(245,158,11,0.5);background:rgba(245,158,11,0.12);border-radius:10px;padding:9px 12px;margin-top:10px;font-size:12px;color:#fbbf24;line-height:1.5;">⚠️ Every account with groups is a <b>RESERVE</b> — no one will post. Go Back and tap a pill to make at least one <b>ACTIVE</b>.</div>`
    : blockingActives.length
    ? `<div style="border:1px solid rgba(245,158,11,0.45);background:rgba(245,158,11,0.1);border-radius:10px;padding:9px 12px;margin-top:10px;font-size:12px;color:#fbbf24;line-height:1.5;">⚠️ ${blockingActives.length} active account${blockingActives.length === 1 ? '' : 's'} not fully ready (${escapeHtml(blockingActives.map((r) => r.acct.alias || r.acct.name).join(', '))}). You can still Apply — fix the flagged items so they post.</div>`
    : `<div style="border:1px solid rgba(16,185,129,0.4);background:rgba(16,185,129,0.08);border-radius:10px;padding:9px 12px;margin-top:10px;font-size:12px;color:#34d399;line-height:1.5;">✅ All ${activeRows.length} active account${activeRows.length === 1 ? '' : 's'} ready. This sets up <b>everything</b> — you won't need the Settings tab. <b>🚀 Save &amp; Start</b> saves and posts now; <b>✅ Apply</b> just saves the setup for your next campaign (start it later with ▶ Start).</div>`);
  // Simplified Review: the whole-content CYCLE plan + readiness + Save & Start. Speed, per-account pace,
  // auto-start and the advanced options now live on the Settings tab (off the launch screen).
  return `${summary}${qsPlanHtml()}${fullPlan}${speedBar}${paceBar}${table}${paceLegend}${rollup}`;
}

// Global speed selector (turbo/fast/normal/slow) for the whole run — Turbo is the new "very fast" tier.

// The ACTIVE posting accounts for the current method (campaign uses the per-batch active accounts).
function qsActivePosterAccts() {
  return qsDRActive();
}
// Proxy-readiness warning — fail-closed means an active account with NO proxy (and an empty pool) is SILENTLY
// skipped when proxies are ON. Surface that in the wizard so the operator isn't surprised by a no-post.
function qsProxyReadinessHtml() {
  if (!(appData && appData.useProxies)) return '';
  const noProxy = qsActivePosterAccts().filter((a) => !(a.proxy && String(a.proxy).trim()));
  if (!noProxy.length) return '';
  const poolSize = ((appData && appData.proxies) || []).filter((p) => p && String(p).trim()).length;
  const names = escapeHtml(noProxy.map((a) => a.alias || a.name).join(', '));
  const isOne = noProxy.length === 1;
  if (poolSize === 0) {
    return `<div style="border:1px solid rgba(239,68,68,0.5);background:rgba(239,68,68,0.1);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fca5a5;line-height:1.5;">🚫 <b>Proxies are ON</b> but ${noProxy.length} active account${isOne ? '' : 's'} ${isOne ? 'has' : 'have'} no proxy and the pool is empty (${names}) — ${isOne ? 'it' : 'they'} will be <b>SKIPPED</b> (won't post, to protect your real IP). Give ${isOne ? 'it' : 'each'} a proxy on the Accounts tab, or turn the Proxy Pool off.</div>`;
  }
  return `<div style="border:1px solid rgba(245,158,11,0.45);background:rgba(245,158,11,0.1);border-radius:10px;padding:9px 12px;margin-bottom:10px;font-size:12px;color:#fbbf24;line-height:1.5;">🌐 ${noProxy.length} active account${isOne ? '' : 's'} without ${isOne ? 'its' : 'their'} own proxy (${names}) will draw from the shared pool. Best practice is <b>one IP per account</b> — assign each its own on the Accounts tab.</div>`;
}

// The wizard supports multiple posting methods, picked on step 1; the later steps + Apply adapt to it.
// The LAST step is always the Review & Start readiness screen (campaign: 5 steps, others: 4).
function qsMaxStep() { return 3; } // Daily-Rotation-only: 1 Accounts & Groups · 2 Plan · 3 Review & Start

// DAILY ROTATION ("each account posts its OWN groups, the full library, 1/day"). Reconstruct from accounts
// already in this mode so re-opening edits the setup. Returns { name: [gids] } or null for a first-time setup.
function qsToggleDRGroup(acctName, gid) {
  const arr = qsState.drGroups[acctName] || (qsState.drGroups[acctName] = []);
  const i = arr.indexOf(gid); if (i >= 0) arr.splice(i, 1); else arr.push(gid);
  qsRenderModal();
}
function qsToggleDRReserve(acctName) { qsState.drReserve[acctName] = !qsState.drReserve[acctName]; qsRenderModal(); }
// Active (posters) vs reserve (standby) accounts in the current non-campaign setup — counts those with groups.
function qsDRActive() { return qsPosters().filter((a) => (qsState.drGroups[a.name] || []).length && !qsState.drReserve[a.name]); }
function qsDRReserves() { return qsPosters().filter((a) => (qsState.drGroups[a.name] || []).length && qsState.drReserve[a.name]); }

// Step 1 (all methods): pick the posting method.

// Daily-Rotation step 2: assign each account its OWN groups (chips toggle).
function qsStepDRGroupsHtml() {
  const groups = appData.groups || [];
  const posters = qsPosters();
  const notReady = [];
  const rows = posters.map((a) => {
    const sel = qsState.drGroups[a.name] || [];
    const notLogged = a.status !== 'logged_in';
    const isReserve = !!qsState.drReserve[a.name];
    if (sel.length && !isReserve && notLogged) notReady.push(a.alias || a.name); // only ACTIVE accounts must be logged in to post
    const chips = groups.map((g) => { const on = sel.includes(g.id); return `<button class="qs-chip${on ? ' on' : ''}" data-acct="${escapeAttr(a.name)}" data-gid="${escapeAttr(g.id)}" onclick="qsToggleDRGroup(this.getAttribute('data-acct'), this.getAttribute('data-gid'))">${on ? '✓ ' : ''}${escapeHtml(g.name || g.id)}</button>`; }).join('');
    const pill = `<button class="qs-rpill ${isReserve ? 'resv' : 'actv'}" data-acct="${escapeAttr(a.name)}" onclick="qsToggleDRReserve(this.getAttribute('data-acct'))" title="Active = posts on its own. Reserve = waits and automatically takes over in its groups if an active account there drops.">${isReserve ? 'RESERVE' : 'ACTIVE'}</button>`;
    return `<div style="border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-bottom:10px;overflow:hidden;">
        <div style="display:flex;align-items:center;gap:7px;background:rgba(99,102,241,0.08);padding:8px 12px;"><span style="width:7px;height:7px;border-radius:50%;background:${notLogged ? '#f59e0b' : '#22c55e'};flex-shrink:0;"></span><span style="font-size:13px;color:#e2e8f0;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.alias || a.name)}</span>${notLogged ? ' <span style="font-size:10px;color:#fbbf24;white-space:nowrap;">⚠️</span>' : ''} <span style="margin-left:auto;display:flex;align-items:center;gap:8px;flex-shrink:0;">${pill}<span style="font-size:11px;color:#64748b;">${sel.length} grp</span></span></div>
        <div style="padding:5px 9px;">${chips || '<span style="font-size:12px;color:#64748b;">no groups</span>'}</div>
      </div>`;
  }).join('');
  const loginWarn = notReady.length ? `<div style="border:1px solid rgba(245,158,11,0.45);background:rgba(245,158,11,0.1);border-radius:10px;padding:9px 12px;margin-bottom:10px;font-size:12px;color:#fbbf24;line-height:1.5;">⚠️ ${notReady.length} active account${notReady.length === 1 ? '' : 's'} not logged in (${escapeHtml(notReady.join(', '))}) — log ${notReady.length === 1 ? 'it' : 'them'} in or ${notReady.length === 1 ? 'it' : 'they'} won't post.</div>` : '';
  const intro = 'Accounts that share the same groups form a <b style="color:#c7d2fe;">batch</b>. The batch <b>splits</b> your post list across its agents — each posts its slice to the shared groups, so every group gets the whole library across the team (no two agents post the same post in a cycle).';
  return `
    <div style="font-size:13px;color:#94a3b8;margin-bottom:10px;line-height:1.55;">Tap the groups each account posts to. ${intro}</div>
    <div style="font-size:12px;color:#94a3b8;margin-bottom:12px;line-height:1.5;">Tap a <b style="color:#34d399;">ACTIVE</b> / <b style="color:#fbbf24;">RESERVE</b> pill to make an account a backup — a reserve waits and auto-takes-over in <b>its groups</b> if an active account there drops.</div>
    ${loginWarn}
    <div style="max-height:44vh;overflow:auto;">${rows}</div>`;
}

// Daily-Rotation step 3: schedule + per-account preview.
// Group active accounts by the EXACT set of groups they share → "batches" (auto-derived from the per-account
// assignments the operator made in step 1). Pure display: in Daily Rotation each account still posts on its own.
function qsDeriveBatches() {
  const gAll = (appData && appData.groups) || [];
  const gname = (id) => { const g = gAll.find((x) => x.id === id); return g ? (g.name || g.id) : id; };
  const map = {};
  for (const a of qsDRActive()) {
    const ids = (qsState.drGroups[a.name] || []);
    const sig = ids.slice().sort().join('|');
    if (!sig) continue;
    (map[sig] = map[sig] || { ids, accounts: [] }).accounts.push(a.alias || a.name);
  }
  return Object.entries(map).map(([sig, b]) => ({ sig, groupNames: b.ids.map(gname), accounts: b.accounts }));
}
// Resolve the proxy each batch will use: explicit pick (qsState.batchProxy[sig]) else a round-robin default from
// the pool (batch i → pool[i]) so distinct batches land on distinct IPs out of the box. Returns { sig → proxyStr }.
function qsResolvedBatchProxies() {
  const pool = ((appData && appData.proxies) || []).filter((p) => p && String(p).trim());
  const out = {};
  qsDeriveBatches().forEach((b, i) => {
    const v = qsState.batchProxy[b.sig];
    out[b.sig] = (v !== undefined && v !== null) ? v : (pool.length ? pool[i % pool.length] : '');
  });
  return out;
}
function qsSetBatchProxy(idx, val) { const b = qsDeriveBatches()[idx]; if (b) { qsState.batchProxy[b.sig] = val; qsRenderModal(); } }
// Per-batch post-set: which named set this batch of agents draws from ('' = all posts / default).
function qsSetBatchPostSet(idx, val) { const b = qsDeriveBatches()[idx]; if (b) { (qsState.batchPostSet || (qsState.batchPostSet = {}))[b.sig] = val; qsRenderModal(); } }
// The work-pattern selector (Plan step) — how a batch's shared library is delivered. Only 'ready' patterns pick.
function qsWorkPatternSelectorHtml() {
  return `<div style="border:1px solid rgba(99,102,241,0.3);background:rgba(99,102,241,0.06);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-size:12px;color:#cbd5e1;font-weight:700;margin-bottom:8px;">⚙️ How should the work run?</div>
      ${Object.keys(WORK_PATTERNS).map((key) => {
        const p = WORK_PATTERNS[key]; const on = (qsState.workPattern || 'split') === key; const dis = !p.ready;
        return `<label style="display:flex;gap:9px;align-items:flex-start;padding:7px 9px;margin-bottom:6px;border-radius:8px;border:1px solid ${on ? '#6366f1' : 'rgba(255,255,255,0.08)'};background:${on ? 'rgba(99,102,241,0.15)' : 'rgba(15,23,42,0.5)'};cursor:${dis ? 'not-allowed' : 'pointer'};opacity:${dis ? '0.55' : '1'};" ${dis ? '' : `onclick="qsSetWorkPattern('${key}')"`}>
            <input type="radio" ${on ? 'checked' : ''} ${dis ? 'disabled' : ''} style="margin-top:2px;accent-color:#6366f1;flex-shrink:0;">
            <span><span style="font-size:13px;color:#e2e8f0;font-weight:600;">${p.label}</span> <span style="font-size:10px;color:${dis ? '#fbbf24' : '#34d399'};font-weight:600;">${dis ? p.tag : '✓ ready'}</span><br><span style="font-size:11px;color:#8a99ad;line-height:1.45;">${p.desc}</span></span>
          </label>`;
      }).join('')}
    </div>`;
}
function qsFireOrderSelectorHtml() {
  return `<div style="border:1px solid rgba(99,102,241,0.3);background:rgba(99,102,241,0.06);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-size:12px;color:#cbd5e1;font-weight:700;margin-bottom:8px;">🚀 In what order should the agents fire?</div>
      ${Object.keys(FIRE_ORDERS).map((key) => {
        const p = FIRE_ORDERS[key]; const on = (qsState.fireOrder || 'batch') === key;
        return `<label style="display:flex;gap:9px;align-items:flex-start;padding:7px 9px;margin-bottom:6px;border-radius:8px;border:1px solid ${on ? '#6366f1' : 'rgba(255,255,255,0.08)'};background:${on ? 'rgba(99,102,241,0.15)' : 'rgba(15,23,42,0.5)'};cursor:pointer;" onclick="qsSetFireOrder('${key}')">
            <input type="radio" ${on ? 'checked' : ''} style="margin-top:2px;accent-color:#6366f1;flex-shrink:0;">
            <span><span style="font-size:13px;color:#e2e8f0;font-weight:600;">${p.label}</span><br><span style="font-size:11px;color:#8a99ad;line-height:1.45;">${p.desc}</span></span>
          </label>`;
      }).join('')}
    </div>`;
}
// Step 2 (Plan): work-pattern selector + auto-derived batches + the daily time + a per-account preview.
function qsStepDRScheduleHtml() {
  const active = qsDRActive();
  const P = (appData.posts || []).length;
  const noPosts = !P;
  const batches = qsDeriveBatches();
  if (!active.length && qsDRReserves().length) return `<div style="border:1px solid rgba(245,158,11,0.5);background:rgba(245,158,11,0.12);border-radius:10px;padding:14px;font-size:13px;color:#fbbf24;line-height:1.6;">⚠️ All ${qsDRReserves().length} account${qsDRReserves().length === 1 ? '' : 's'} with groups are set to <b>RESERVE</b> — no one will post. Go <b>Back</b> and tap a pill to make at least one <b>ACTIVE</b>.</div>`;
  const pool = ((appData && appData.proxies) || []).filter((p) => p && String(p).trim());
  const resolved = qsResolvedBatchProxies();
  const plabel = (s) => { const m = String(s || '').replace(/^\w+:\/\//, ''); const seg = m.split(':'); return seg[0] + (seg[1] ? ':' + seg[1] : ''); };
  const distinctIPs = new Set(batches.map((b) => resolved[b.sig]).filter(Boolean)).size;
  const proxySummary = !pool.length
    ? `<div style="font-size:11px;color:#fbbf24;margin:2px 0 8px;line-height:1.5;">🌐 No proxies yet — add them on the <b>Proxies</b> tab, then give each batch its <b>own IP</b> below. Batches on different IPs post in parallel; same IP runs one at a time.</div>`
    : (distinctIPs < batches.length
        ? `<div style="font-size:11px;color:#fbbf24;margin:2px 0 8px;line-height:1.5;">⚠️ ${distinctIPs} IP${distinctIPs === 1 ? '' : 's'} across ${batches.length} batches — batches sharing an IP post <b>one at a time</b>. Add more proxies for full parallelism.</div>`
        : `<div style="font-size:11px;color:#34d399;margin:2px 0 8px;line-height:1.5;">✅ Each batch on its own IP — up to <b>${batches.length}</b> batch${batches.length === 1 ? '' : 'es'} post in parallel, and only different IPs ever run at the same time.</div>`);
  const batchHtml = batches.length ? `<div style="border:1px solid rgba(99,102,241,0.25);background:rgba(99,102,241,0.06);border-radius:10px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-size:12px;color:#cbd5e1;font-weight:700;margin-bottom:7px;">📦 ${batches.length} batch${batches.length === 1 ? '' : 'es'} <span style="font-weight:400;color:#64748b;font-size:11px;">— accounts auto-grouped by the groups they share · one proxy/IP each</span></div>
      ${proxySummary}
      ${batches.map((b, i) => {
        const cur = resolved[b.sig] || '';
        const opts = `<option value="">— shared pool / no fixed IP —</option>` + pool.map((p) => `<option value="${escapeAttr(p)}" ${p === cur ? 'selected' : ''}>${escapeHtml(plabel(p))}</option>`).join('');
        return `<div style="margin-bottom:8px;line-height:1.5;">
            <div style="font-size:11px;color:#cbd5e1;"><b style="color:#c7d2fe;">Batch ${i + 1}</b>: ${b.accounts.length} account${b.accounts.length === 1 ? '' : 's'} <span style="color:#94a3b8;">(${escapeHtml(b.accounts.slice(0, 6).join(', '))}${b.accounts.length > 6 ? ` +${b.accounts.length - 6}` : ''})</span> → ${b.groupNames.length} group${b.groupNames.length === 1 ? '' : 's'} <span style="color:#94a3b8;">(${b.groupNames.slice(0, 4).map(escapeHtml).join(', ')}${b.groupNames.length > 4 ? '…' : ''})</span></div>
            <div style="display:flex;align-items:center;gap:7px;margin-top:3px;"><span style="font-size:11px;color:#94a3b8;white-space:nowrap;">🌐 IP:</span><select onchange="qsSetBatchProxy(${i}, this.value)" style="flex:1;font-size:11px;padding:4px 8px;background:#0f172a;border:1px solid #374151;border-radius:6px;color:#e5e7eb;outline:none;">${opts}</select></div>
            ${(((appData.settings || {}).postSets) || []).length ? `<div style="display:flex;align-items:center;gap:7px;margin-top:3px;"><span style="font-size:11px;color:#94a3b8;white-space:nowrap;">📦 Posts:</span><select onchange="qsSetBatchPostSet(${i}, this.value)" style="flex:1;font-size:11px;padding:4px 8px;background:#0f172a;border:1px solid #374151;border-radius:6px;color:#e5e7eb;outline:none;"><option value="">— all posts (default) —</option>${(((appData.settings || {}).postSets) || []).map((s) => `<option value="${escapeAttr(s.id)}" ${((qsState.batchPostSet || {})[b.sig] || '') === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select></div>` : ''}
          </div>`;
      }).join('')}
    </div>` : '';
  const cards = active.map((a) => {
    const sel = qsState.drGroups[a.name] || [];
    const gNames = sel.map((gid) => { const g = (appData.groups || []).find((x) => x.id === gid); return escapeHtml(g ? (g.name || g.id) : gid); }).join(', ');
    return `<div style="border:1px solid rgba(255,255,255,0.08);background:rgba(15,23,42,0.6);border-radius:10px;padding:10px 12px;margin-bottom:8px;">
        <div style="font-size:13px;color:#e2e8f0;font-weight:700;">${escapeHtml(a.alias || a.name)}</div>
        <div style="font-size:11px;color:#94a3b8;margin:3px 0;line-height:1.5;"><b style="color:#cbd5e1;">Groups:</b> ${gNames}</div>
        <div style="font-size:11px;color:#94a3b8;line-height:1.45;">shares the ${P}-post list with its batch — posts its slice (≈1/cycle) to these groups.</div>
      </div>`;
  }).join('');
  const notReady = active.filter((a) => a.status !== 'logged_in').map((a) => a.alias || a.name);
  const loginWarn = notReady.length ? `<div style="border:1px solid rgba(245,158,11,0.45);background:rgba(245,158,11,0.1);border-radius:10px;padding:9px 12px;margin-bottom:10px;font-size:12px;color:#fbbf24;line-height:1.5;">⚠️ ${notReady.length} account${notReady.length === 1 ? '' : 's'} not logged in (${escapeHtml(notReady.join(', '))}) — log ${notReady.length === 1 ? 'it' : 'them'} in or the post${notReady.length === 1 ? '' : 's'} won't go out.</div>` : '';
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <label style="font-size:13px;color:#cbd5e1;font-weight:600;">Run one cycle each day at</label>
      <input type="time" class="qs-input" value="${escapeAttr(qsState.time)}" onchange="qsSetTime(this.value)">
    </div>
    ${qsWorkPatternSelectorHtml()}
    ${qsFireOrderSelectorHtml()}
    ${batchHtml}
    <div style="border:1px solid rgba(99,102,241,0.3);background:rgba(99,102,241,0.08);border-radius:10px;padding:9px 12px;margin-bottom:10px;font-size:12px;color:#c7d2fe;line-height:1.5;"><b style="color:#e0e7ff;">This plan:</b> ${batches.length} batch${batches.length === 1 ? '' : 'es'}, ${active.length} agent${active.length === 1 ? '' : 's'}${qsDRReserves().length ? ` + ${qsDRReserves().length} reserve` : ''} — each batch <b>splits</b> your ${P} post${P === 1 ? '' : 's'} across its agents (no two post the same in a cycle), once a day at ${escapeHtml(qsState.time)}.</div>
    ${qsModeratorSectionHtml()}
    ${qsProxyReadinessHtml()}
    ${loginWarn}
    ${noPosts ? `<div style="border:1px solid rgba(245,158,11,0.4);background:rgba(245,158,11,0.08);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#fbbf24;">⚠️ You have no posts yet — add posts on the Posts tab. You can still apply now.</div>` : ''}
    <div style="font-size:12px;color:#cbd5e1;font-weight:600;margin:6px 0 6px;">Per-account preview</div>
    <div style="max-height:36vh;overflow:auto;">${cards}</div>`;
}

// Shared pieces for the non-campaign settings steps.
const qsTimeInput = () => `<input type="time" class="qs-input" value="${escapeAttr(qsState.time)}" onchange="qsSetTime(this.value)">`;

// Sequential (unique) settings: order, stop-vs-loop, schedule + preview.

// Post to All settings: order, per-cycle cap, schedule + preview.

// Per-batch active/reserve sizing. Each batch's ACTIVE agents drive the daily schedule (K posts/day); the
// rest are auto-RESERVES (standby) that wait and take over in the same groups if an active agent drops. The
// active count is PER batch (qsState.activeByBatch[b]); active accounts are the first K of the batch, reserves
// the remainder.

// Spread the account pool evenly across batches: A, B, C, A, B, C, … (the user's "split evenly" rule).


// ── Per-batch WEIGHT: an easy way to make UNEVEN batches (bigger weight = more groups & accounts) ──────────
// Hamilton / largest-remainder apportionment: split `n` items across the batches proportional to `weights`,
// returning integer counts that sum EXACTLY to n (no item lost or double-counted to rounding).
// Re-split groups AND accounts across batches proportional to the weights (then the operator can fine-tune any
// single group/account below). Active counts default to the new batch sizes.

function qsSetTime(v) { qsState.time = v; }
function qsNext() { qsState.step++; qsRenderModal(); }
function qsBack() { qsState.step--; qsRenderModal(); }
function qsClose() { try { document.removeEventListener('keydown', qsKeyHandler); } catch {} const o = document.getElementById('quick-setup-overlay'); if (o) o.remove(); }

// Per-batch day-by-day plan, mirroring orchestrator._computeCampaignPlan striping (idx % K === slot):
// account j gets posts[j], posts[j+K], … so on day d the batch publishes the block [d*K .. d*K+K-1],
// one post per account, all to that batch's shared groups. Finishes the whole library in ceil(P/K) days.

function qsStepperHtml() {
  const labels = ['Accounts & Groups', 'Plan', 'Review & Start'];
  return labels.map((label, i) => {
    const n = i + 1;
    const cls = qsState.step === n ? 'current' : qsState.step > n ? 'done' : 'todo';
    const click = cls === 'done' ? ` onclick="qsGoStep(${n})" title="Back to ${escapeAttr(label)}"` : '';
    const line = i < labels.length - 1 ? `<div class="qs-step-line${qsState.step > n ? ' filled' : ''}"></div>` : '';
    return `<div class="qs-step ${cls}"><span class="qs-step-dot"${click}>${cls === 'done' ? '✓' : n}</span><span class="qs-step-label"${click}>${escapeHtml(label)}</span></div>${line}`;
  }).join('');
}
// Click a completed step dot to jump BACK to it (forward only via Next, so per-step validation still runs).
function qsGoStep(n) { if (n >= 1 && n < qsState.step) { qsState.step = n; qsRenderModal(); } }





function qsFooterHtml() {
  const back = qsState.step > 1 ? `<button class="qs-btn qs-btn-back" onclick="qsBack()">← Back</button>` : '<span></span>';
  const next = qsState.step < qsMaxStep()
    ? `<button class="qs-btn qs-btn-next" onclick="qsNext()">Next →</button>`
    : `<span style="display:flex;gap:10px;">
         <button class="qs-btn qs-btn-apply" onclick="qsApply(false)" title="Save these settings for your NEXT campaign — does NOT start. Run it later with ▶ Start or 🚀 Save & Start.">✅ Apply (save only)</button>
         <button class="qs-btn qs-btn-start" onclick="qsApply(true)" title="Save AND start posting right now (then continues on the daily schedule)">🚀 Save &amp; Start</button>
       </span>`;
  return `${back}${next}`;
}

function qsBodyHtml() {
  // Daily-Rotation-only flow (simplified): 1 = Accounts & Groups · 2 = Plan (batches + cycles) · 3 = Review & Start.
  // The other methods' step functions remain in the codebase (engine intact) but are no longer routed to.
  if (qsState.step === 1) return qsStepDRGroupsHtml();
  if (qsState.step === 2) return qsStepDRScheduleHtml();
  return qsStepReviewHtml();
}
// Keyboard nav for the wizard: Esc closes; Enter advances to the next step (but not while typing in a field,
// and never auto-applies/starts on the final step — that stays an explicit click).
function qsKeyHandler(e) {
  if (!document.getElementById('quick-setup-overlay')) return;
  if (e.key === 'Escape') { e.preventDefault(); qsClose(); return; }
  if (e.key === 'Enter') {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (qsState.step < qsMaxStep()) { e.preventDefault(); qsNext(); }
  }
}
function qsSubtitleHint() { return `${qsMethodLabel()} · Step ${qsState.step} of ${qsMaxStep()}`; }
function qsRenderModal() {
  const old = document.getElementById('quick-setup-overlay'); if (old) old.remove(); // re-render in place; keep the key handler attached
  const body = qsBodyHtml();
  const ov = document.createElement('div');
  ov.id = 'quick-setup-overlay';
  ov.innerHTML = `
    <div class="qs-modal" role="dialog" aria-modal="true" aria-label="Quick Setup">
      <div class="qs-head">
        <div>
          <div class="qs-title"><span class="qs-spark">⚡</span> Quick Setup</div>
          <div class="qs-sub">${escapeHtml(qsSubtitleHint())}</div>
        </div>
        <button class="qs-x" onclick="qsClose()" title="Close (Esc)" aria-label="Close">×</button>
      </div>
      <div class="qs-steps">${qsStepperHtml()}</div>
      <div id="qs-body" class="qs-body qs-anim">${body}</div>
      <div class="qs-foot">${qsFooterHtml()}</div>
    </div>`;
  document.body.appendChild(ov);
  document.removeEventListener('keydown', qsKeyHandler);
  document.addEventListener('keydown', qsKeyHandler); // attach once (idempotent across re-renders)
}

function qsSetWorkPattern(wp) { if (WORK_PATTERNS[wp] && WORK_PATTERNS[wp].ready) { qsState.workPattern = wp; qsRenderModal(); } }
function qsSetFireOrder(v) { if (FIRE_ORDERS[v]) { qsState.fireOrder = v; qsRenderModal(); } }
async function qsApply(thenStart) {
  if (isAutomationRunning) { showNotification('Stop the automation before applying Quick Setup.', 'error'); return; }
  const wp = (WORK_PATTERNS[qsState.workPattern] && WORK_PATTERNS[qsState.workPattern].ready) ? qsState.workPattern : 'split';
  const p = WORK_PATTERNS[wp];
  return qsApplyAccountGroups(thenStart, p.order, p.extra, (active, reserve) =>
    `${qsAR(active, reserve)} on Campaign Plan (${p.label.replace(/^[^ ]+ /, '')}) — daily at ${qsState.time}.`);
}

// Shared finalize: persist data + settings, refresh, close, toast, and (Save & Start) run the Start preflight.
async function qsSaveAndFinish(fresh, summary, immediate) {
  // 🕒 Capture the auto-start choice + time BEFORE qsClose() nulls qsState. Register/remove the Windows clock-hook
  // FIRST, then persist the ACTUAL resulting state — so a registration failure can't leave autoStartDaily:true
  // with no task (the flag always reflects what's really installed).
  const autoWanted = !!(qsState && qsState.autoStartDaily);
  const autoTime = (qsState && qsState.time) || (fresh.settings && fresh.settings.dailyPostTime) || '09:00';
  let autoApplied = autoWanted;
  try {
    const ar = await window.electronAPI.setAutostart(autoWanted, autoTime);
    if (ar && ar.success === false) { autoApplied = false; if (autoWanted) showNotification('Couldn\'t set the daily auto-start task: ' + (ar.error || 'unknown'), 'error'); }
  } catch (e) { autoApplied = false; if (autoWanted) showNotification('Couldn\'t set the daily auto-start task: ' + ((e && e.message) || e), 'error'); }
  if (fresh.settings) { fresh.settings.autoStartDaily = autoApplied; if (!fresh.settings.dailyPostTime) fresh.settings.dailyPostTime = autoTime; }
  const res = await window.electronAPI.saveData(fresh);
  if (res && res.success === false) { showNotification('Save failed: ' + res.error, 'error'); return false; }
  const sres = await window.electronAPI.saveSettings(fresh.settings);
  if (sres && sres.success === false) { showNotification('Settings save failed: ' + sres.error, 'error'); return false; }
  try { appData = await window.electronAPI.getData(); } catch { appData = fresh; } // canonical post-normalize disk copy
  try { loadSettings(); } catch {}
  try { renderAccounts(); } catch {}
  qsClose();
  // ✅ Apply = SAVE ONLY — it configures the NEXT campaign (per-account groups, proxies, work pattern, schedule,
  // speeds) and does NOT start anything. 🚀 Save & Start is what runs it. The saved config (incl. the daily
  // schedule) takes effect the next time you press Start / Save & Start (or via the Windows auto-start task if set).
  if (!immediate) {
    showNotification(`✅ Quick Setup saved — ${summary} Settings are ready for your next campaign — press ▶ Start (or 🚀 Save & Start) to run.`, 'success');
    return true;
  }
  // 🚀 Save & Start = save + run NOW. Switch to Automation FIRST so any startAutomation preflight (logged-out /
  // no-groups confirm, or a hard block) shows on that view — and only claim "started" AFTER it actually launches.
  try { switchView('automation'); } catch {}
  let started = false;
  try { started = await startAutomation({ runNow: true }); }
  catch (e) { showNotification('Saved, but couldn\'t start: ' + ((e && e.message) || e), 'error'); }
  if (started) showNotification(`✅ Quick Setup applied — ${summary} Posting now…`, 'success');
  else showNotification(`✅ Quick Setup saved — ${summary} Not started (see the message above) — fix it, then click Start.`, 'info');
  return true;
}


async function qsApplyDailyRotation(thenStart) {
  // daily-rotation cycles the whole library 1/day per account; loopCampaign/completionMode are no-ops for it.
  await qsApplyAccountGroups(thenStart, 'daily-rotation', { loopCampaign: false, completionMode: false }, (active, reserve) =>
    `${qsAR(active, reserve)} on Daily Rotation — each posts its OWN groups, one post/day at ${qsState.time}.`);
}

// Shared writer for the per-account-groups methods (sequence / post-centric): assign groups + postingOrder,
// then the per-method settings block. `extraSettings` carries the method's specific knobs.
async function qsApplyAccountGroups(thenStart, order, extraSettings, summaryFn) {
  const participating = qsPosters().filter((a) => (qsState.drGroups[a.name] || []).length);
  const activeList = participating.filter((a) => !qsState.drReserve[a.name]);
  if (!activeList.length) { showNotification('At least one ACTIVE account needs groups (a setup of only reserves can\'t post).', 'error'); return; }
  const fresh = await window.electronAPI.getData();
  if (!fresh || !Array.isArray(fresh.accounts)) { showNotification('Could not read data.', 'error'); return; }
  const batchProx = qsResolvedBatchProxies(); // per-batch proxy/IP: every account in a batch shares one IP
  let activeN = 0, reserveN = 0;
  for (const a of participating) {
    const acc = fresh.accounts.find((x) => x.name === a.name);
    if (!acc || acc.isModerator || acc.enabled === false) continue;
    acc.assignedGroups = (qsState.drGroups[a.name] || []).slice();
    acc.postingOrder = order;
    if (!acc.postFilter) acc.postFilter = 'all'; // PRESERVE a per-account post filter (with/without comments) the operator set on the card; only default brand-new accounts
    acc.standby = !!qsState.drReserve[a.name]; // RESERVE → standby: waits + takes over in its groups when an active drops
    acc.pace = qsState.pace[a.name]; // per-account timing profile (Review step); undefined = inherit settings.defaultPace
    const _sig = (qsState.drGroups[a.name] || []).slice().sort().join('|');
    const bp = batchProx[_sig]; // its batch's proxy
    if (bp) acc.proxy = bp; // share the batch IP (engine serializes same-IP). Only SET when the batch has a proxy — never WIPE a manually-set per-account proxy when no batch proxy is configured.
    acc.postSetId = ((qsState.batchPostSet || {})[_sig]) || null; // POST-SETS: this batch draws only from its assigned set ('' / none → whole library)
    if (acc.standby) reserveN++; else activeN++;
  }
  // An account whose groups were DESELECTED in Quick Setup is excluded from `participating`, so the loop above never
  // rewrites it — it would keep its OLD assignedGroups + campaign-plan order and silently keep posting, contradicting
  // the previewed plan. Reset the EXCLUDED posters the wizard actually showed so deselecting an account removes it.
  const _participatingNames = new Set(participating.map((a) => a.name));
  for (const a of qsPosters()) {
    if (_participatingNames.has(a.name)) continue;
    const acc = fresh.accounts.find((x) => x.name === a.name);
    if (!acc || acc.isModerator || acc.enabled === false) continue;
    if ((acc.assignedGroups || []).length || acc.postingOrder === 'campaign-plan') { acc.assignedGroups = []; acc.postingOrder = 'post-centric-unique'; acc.standby = false; }
  }
  // If batches were given proxies, turn the global proxy toggle ON so the engine enforces the different-IP rule
  // (per-account proxies are honored regardless, but this also makes readiness + the pool fallback consistent).
  if (Object.values(batchProx).some(Boolean)) fresh.useProxies = true;
  fresh.settings = {
    ...(fresh.settings || {}),
    scheduleMode: qsState.scheduleContinuous ? 'continuous' : 'daily', dailyPostTime: qsState.time,
    fireOrder: FIRE_ORDERS[qsState.fireOrder] ? qsState.fireOrder : 'batch', // launch order across batches
    workPattern: (WORK_PATTERNS[qsState.workPattern] && WORK_PATTERNS[qsState.workPattern].ready) ? qsState.workPattern : 'split', // persist so re-open restores it + a re-Apply keeps the right extra (shuffleCampaign)
    reserveAccounts: 0, maxCycles: 0,
    parallelAccounts: Math.max(1, Math.min(20, qsProxyCount(fresh) || activeN || 1)), // = number of proxies (one per batch); else active count
    groupsPerBlock: Math.max(1, qsState.groupsPerBlock || 4), accountsPerBatch: Math.max(1, qsState.accountsPerBatch || 1),
    moderationEnabled: !!qsState.moderationEnabled, moderationDryRun: !!qsState.moderationDryRun,
    repostEnabled: !qsState.moderationEnabled, // moderation OFF → a reserve RE-POSTS held posts to get them live (no admin); ON → the admin approves instead
    ...extraSettings,
    ...qsAdvancedSettings(), // hideBrowser, warm-up, daily cap, cool-down, auto-delete, resume/launch/tunnel
    ...qsSpeedSettings(), // global speed (turbo/fast/normal/slow) — its timing ranges win
  };
  if (fresh.settings.loopCampaign) fresh.settings.autoDeletePosted = false; // never auto-delete a looping library (it would empty the list it re-posts)
  const excluded = ((appData && appData.accounts) || []).filter((a) => !a.isModerator && a.enabled === false).length;
  const mTag = qsState.moderationEnabled ? ` Moderator ${qsState.moderationDryRun ? '(dry-run)' : 'ON'}.` : '';
  await qsSaveAndFinish(fresh, summaryFn(activeN, reserveN) + mTag + (excluded ? ` ${excluded} Excluded left out.` : ''), thenStart);
}
const qsAR = (active, reserve) => `${active} active${reserve ? ` + ${reserve} reserve` : ''}`;



// "Start over" — THE single campaign-reset action, shared by the Posts tab button AND the Automation tab button
// (they used to be two differently-worded buttons doing the same reset-rotation, which was confusing). Clears
// each account's campaign memory + the dashboard progress so the next Start begins fresh from post #1. Honest
// about the two cases (replaced posts = safe; unchanged posts = may re-post). Stopped-only. The permanent
// run-report audit is preserved.
async function startOverCampaign() {
  if (isAutomationRunning) { showNotification('Stop the automation first, then Start over.', 'error'); return; }
  const ok = await themedConfirm(
    'The next Start begins fresh from post #1 — every account forgets what it already posted, and the dashboard plan progress resets.\n\n• If you REPLACED your posts, this is exactly what you want.\n• If your posts are UNCHANGED, already-published posts may be sent to their groups again.\n\nIt does NOT delete any posts. Make sure automation is stopped.',
    { title: 'Start over from post #1?', confirmText: 'Start over', danger: true });
  if (!ok) return;
  await doStartOverReset();
}
// The reset core (no confirm) — shared by the explicit "Start over" buttons and the post-Stop prompt.
async function doStartOverReset() {
  // Never reset while a run is live (a fast Stop→Start-over→Start race): the engine refuses anyway, but skip here
  // so the operator doesn't see a confusing "start over failed" — the fresh run keeps its rotation intact.
  if (isAutomationRunning) { showNotification('A new run is active — start-over was skipped to protect it.', 'info'); return false; }
  try {
    const r = await window.electronAPI.invoke('reset-rotation');
    if (r && r.ok) {
      showNotification('✅ Started over — the next Start posts your current list from #1.', 'success');
      addLog('🔄 Start over: campaign rotation + dashboard progress reset.\n');
      try { renderCampaignPlan(); } catch {} // reflect the fresh plan on the dashboard immediately
      return true;
    }
    showNotification('Start over failed: ' + ((r && r.error) || 'unknown') + ' — ensure the app can write to the data folder.', 'error');
  } catch (e) { showNotification('Start over failed: ' + (e.message || e), 'error'); }
  return false;
}

// Race-safe single-account field update: fetch FRESH backend data, mutate ONE account, save the whole fresh
// object — so a per-field change can't clobber a concurrent backend write (e.g. the running orchestrator
// updating an account's status). Returns the mutated account, or null if not found / save failed.
async function patchAccount(accountName, mutate) {
 return queueAcctWrite(async () => {
  const fresh = await window.electronAPI.getData();
  if (!fresh || !Array.isArray(fresh.accounts)) return null;
  const a = fresh.accounts.find((x) => x.name === accountName);
  if (!a) return null;
  mutate(a);
  const res = await window.electronAPI.saveData(fresh);
  if (res && res.success === false) { showNotification('Failed to save: ' + (res.error || 'unknown error'), 'error'); return null; }
  appData = fresh;
  return a;
 });
}

// Update post filter for an account
async function updatePostFilter(accountName, filterValue) {
  const account = await patchAccount(accountName, (a) => { a.postFilter = filterValue; });
  if (!account) return;
  const filterLabels = {
    'all': 'All Posts',
    'with-comments': 'Only with Comments',
    'without-comments': 'Only without Comments'
  };
  showNotification(`Post filter set to: ${filterLabels[filterValue]}`, 'success');
}

// Update posting order for an account

// Update per-account PACE profile. '' (Inherit) DELETES the field so the account follows settings.defaultPace;
// 'safe'|'normal'|'fast' store an explicit override (worker.applyPace scales that account's timing accordingly).
async function updateAccountPace(accountName, paceValue) {
  const valid = ['safe', 'normal', 'fast', 'turbo', 'instant'].includes(paceValue);
  const account = await patchAccount(accountName, (a) => { if (valid) a.pace = paceValue; else delete a.pace; });
  if (!account) return;
  const labels = { safe: '🐢 Safe (slower, most human)', normal: '⚖️ Normal (global tempo)', fast: '⚡ Fast (quick)', turbo: '🚀 Turbo (fastest, ¼ gaps)', instant: '⚡ Instant (max speed, 0–7s gaps)' };
  showNotification(valid ? `Pace for ${accountName}: ${labels[paceValue]}` : `Pace for ${accountName}: inherit global default`, 'success');
  try { renderAccounts(); } catch {}
}

// Per-account proxy DROPDOWN — choose one from the Proxies-tab pool (not free-typed). Keeps an existing
// off-pool value as a "(custom)" option so it's never silently lost; '' = none (global pool / real IP).
function accountProxyDropdown(account) {
  const pool = ((appData && appData.proxies) || []).filter((p) => p && String(p).trim());
  const cur = (account.proxy || '').trim();
  const plab = (s) => { const m = String(s).replace(/^\w+:\/\//, ''); const seg = m.split(':'); return seg[0] + (seg[1] ? ':' + seg[1] : ''); };
  const inPool = !cur || pool.includes(cur);
  const opts = `<option value="">— none (global pool / real IP) —</option>`
    + pool.map((p) => `<option value="${escapeAttr(p)}" ${p === cur ? 'selected' : ''}>🌐 ${escapeHtml(plab(p))}</option>`).join('')
    + (cur && !inPool ? `<option value="${escapeAttr(cur)}" selected>${escapeHtml(plab(cur))} (custom)</option>` : '');
  const sel = `<select id="account-proxy-${escapeHtml(account.name)}" onchange="updateAccountProxy(${escapeAttr(JSON.stringify(account.name))}, this.value)" style="width:100%;padding:8px 12px;background:#0f172a;border:1px solid #374151;border-radius:8px;color:#e5e7eb;font-size:13px;box-sizing:border-box;outline:none;cursor:pointer;">${opts}</select>`;
  return sel + (pool.length ? '' : `<div style="margin-top:6px;font-size:11px;color:#fbbf24;">No proxies yet — add them on the <b>Proxies</b> tab, then pick one here.</div>`);
}

// Update per-account proxy
async function updateAccountProxy(accountName, proxyValue) {
  const v = validateProxyStr(proxyValue);
  if (!v.ok) { showNotification(`Proxy for ${accountName} looks invalid — ${v.reason}. Saved anyway; fix it before the account posts.`, 'error'); }
  const account = await patchAccount(accountName, (a) => { a.proxy = (proxyValue || '').trim(); });
  if (!account) return;
  showNotification(account.proxy ? `Proxy ${v.ok ? 'set' : 'saved (check format)'} for ${accountName}` : `Proxy cleared for ${accountName}`, v.ok ? 'success' : 'info');
}

// Renderer-side proxy format check (mirrors lib/parseProxy): scheme://ip:port[:user:pass] OR scheme://user:pass@ip:port.
function validateProxyStr(str) {
  const s = String(str || '').trim();
  if (!s) return { ok: true, empty: true };
  const schemes = ['http', 'https', 'socks', 'socks4', 'socks5', 'socks5h']; // mirrors PROXY_SCHEMES in worker.js
  let scheme, port, m = s.match(/^(\w+):\/\/([^:@/\s]+):([^@/\s]+)@([^:/@\s]+):(\d+)$/);
  if (m) { scheme = m[1]; port = m[5]; }
  else { m = s.match(/^(\w+):\/\/([^:\s]+):(\d+)(?::([^:]+):(.+))?$/); if (m) { scheme = m[1]; port = m[3]; } }
  if (!m) return { ok: false, reason: 'use scheme://ip:port  or  scheme://ip:port:user:pass' };
  scheme = String(scheme).toLowerCase(); const portN = Number(port);
  if (!schemes.includes(scheme)) return { ok: false, reason: `unknown scheme "${scheme}" — use ${schemes.join('/')}` };
  if (!(Number.isInteger(portN) && portN >= 1 && portN <= 65535)) return { ok: false, reason: 'port must be 1-65535' };
  return { ok: true, scheme };
}

// Per-account proxy health (alive / cooling / failing), fetched from the orchestrator's ProxyHealthManager.
// Populated during/after a run; empty before the first run. Re-renders Accounts only when the data changed.
let proxyHealthByUrl = {};
let _phFetching = false;
async function refreshProxyHealth() {
  if (_phFetching) return; _phFetching = true;
  try {
    const r = await window.electronAPI.invoke('get-proxy-health');
    const next = {}; for (const p of (r && r.proxies) || []) next[p.url] = p;
    const changed = JSON.stringify(next) !== JSON.stringify(proxyHealthByUrl);
    proxyHealthByUrl = next;
    const onAcc = document.getElementById('accounts-view') && document.getElementById('accounts-view').classList.contains('active');
    if (changed && onAcc) renderAccounts();
  } catch {} finally { _phFetching = false; }
}
function proxyHealthChip(proxyStr) {
  const ph = proxyStr && proxyHealthByUrl[String(proxyStr).trim()];
  if (!ph) return '';
  if (ph.onCooldownUntil > Date.now()) { const m = Math.max(1, Math.round((ph.onCooldownUntil - Date.now()) / 60000)); return `<span title="On health cooldown — recent failures" style="font-size:10px;color:#fbbf24;">⚠ cooling ${m}m</span>`; }
  if (ph.consecutiveFailCount > 0) return `<span title="${escapeAttr(ph.lastReason || 'recent failures')}" style="font-size:10px;color:#f87171;">✗ failing (${ph.consecutiveFailCount})</span>`;
  return `<span title="Reachable on the last run" style="font-size:10px;color:#34d399;">● healthy</span>`;
}

// MOD: toggle an account's moderator role. MULTIPLE moderators are allowed (each covers its groups);
// a moderator never posts. Each group is routed to its moderator via group.moderatedBy (or, with one
// moderator, automatically).
async function toggleModerator(name, makeMod) {
  const a0 = (appData.accounts || []).find((x) => x.name === name);
  if (!a0) return;
  const becomingMod = (makeMod === undefined) ? !a0.isModerator : !!makeMod;
  // Demotion guard: a moderator carries a trusted admin session and was never meant to post. If we just
  // cleared the flag it would resurrect as an ENABLED poster. Confirm + disable it so it can't post
  // unattended from the admin account; the operator re-enables it on the Accounts tab if they really want.
  if (!becomingMod && a0.isModerator) {
    if (!(await themedConfirm(`It becomes a normal account and will be DISABLED (so it can't post from your admin session). Re-enable it on the Accounts tab if you want it to post.`, { title: `Remove "${name}" as moderator?`, confirmText: 'Remove' }))) {
      try { renderModeratorPanel(); } catch {}
      return;
    }
  }
  const a = await patchAccount(name, (acc) => { const wasMod = acc.isModerator; acc.isModerator = becomingMod; if (!becomingMod && wasMod) acc.enabled = false; });
  if (!a) return;
  showNotification(a.isModerator ? `🛡️ ${name} is now a group moderator (it won't post)` : `${name} removed as moderator (disabled — re-enable on Accounts to post)`, 'success');
  try { renderModeratorPanel(); renderGroups(); renderAccounts(); } catch {}
}
// MOD: assign which moderator account covers a group's held posts ('' = auto / the only moderator).
async function updateGroupModerator(groupId, accountName) {
  const fresh = await window.electronAPI.getData();
  if (!fresh || !Array.isArray(fresh.groups)) return;
  const g = fresh.groups.find((x) => (x.id === groupId) || (x.groupId === groupId));
  if (!g) return;
  g.moderatedBy = (accountName || '').trim() || undefined;
  const res = await window.electronAPI.saveData(fresh);
  if (res && res.success === false) { showNotification('Failed to save: ' + (res.error || 'unknown error'), 'error'); return; }
  appData = fresh;
  showNotification(g.moderatedBy ? `Moderator for "${g.name || groupId}" set to ${g.moderatedBy}` : `Moderator for "${g.name || groupId}" set to auto`, 'success');
}
// MOD: bulk-assign a moderator (or Auto) to ALL selected groups at once. '' = Auto/lone-moderator routing; the
// '__none__' placeholder is a no-op. Race-safe (fetch fresh → patch → save), mirrors updateGroupModerator. Only
// surfaced in the Groups bulk toolbar when 2+ moderators exist — with one moderator, routing is automatic.
async function bulkSetModerator(name) {
  if (name === '__none__') return;
  const ids = [...selectedGroupIds];
  if (!ids.length) { showNotification('Select at least one group first.', 'info'); return; }
  const fresh = await window.electronAPI.getData();
  if (!fresh || !Array.isArray(fresh.groups)) return;
  const set = new Set(ids.map(String));
  let n = 0;
  for (const g of fresh.groups) { if (set.has(String(g.id)) || set.has(String(g.groupId))) { g.moderatedBy = (name || '').trim() || undefined; n++; } }
  const res = await window.electronAPI.saveData(fresh);
  if (res && res.success === false) { showNotification('Failed to save: ' + (res.error || 'unknown error'), 'error'); return; }
  appData = fresh;
  const who = name ? (((fresh.accounts || []).find((a) => a.name === name) || {}).alias || name) : 'Auto';
  showNotification(`Moderator set to ${who} for ${n} group(s)`, 'success');
  renderGroups();
}
// MOD: the FB display name used to recognise this account's posts in the moderation queue.
async function updateFbDisplayName(name, value) {
  const a = await patchAccount(name, (acc) => { acc.fbDisplayName = (value || '').trim(); });
  if (!a) return;
  showNotification(`FB display name ${a.fbDisplayName ? 'set' : 'cleared'} for ${name}`, 'success');
}
// MOD: the dedicated moderator section in the Groups view — designate the admin account, log it in,
// set its display name. It approves held posts in all groups you admin and never posts itself.
function renderModeratorPanel() {
  const el = document.getElementById('moderator-panel');
  if (!el) return;
  const accts = appData.accounts || [];
  const mods = accts.filter((a) => a.isModerator);
  const enabled = appData.settings && appData.settings.moderationEnabled === true;
  // Moderator approval OFF → no admin shown; held posts are re-posted by a reserve instead.
  if (!enabled) {
    el.innerHTML = `<div style="padding:12px 16px; background:rgba(15,23,42,0.4); border:1px dashed rgba(148,163,184,0.25); border-radius:12px; font-size:12px; color:#94a3b8; line-height:1.5;">🛡️ <b style="color:#cbd5e1;">Moderator approval is off.</b> Posts Facebook holds in "Spam potentiel" are re-posted by a healthy <b>reserve</b> to get them live — no admin needed. Turn on <b>Enable moderator approval</b> in Settings (or Quick Setup) to approve held posts with a dedicated admin account instead.</div>`;
    return;
  }
  const rows = mods.map((a) => {
    const badge = a.status === 'logged_in' ? '<span style="color:#34d399;">● logged in</span>' : `<span style="color:#fbbf24;">● ${escapeHtml(a.status || 'not logged in')}</span>`;
    return `<div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
      <span style="min-width:120px; font-size:13px; color:#e5e7eb; font-weight:600;">🛡️ ${escapeHtml(a.alias || a.name)}</span>
      <span style="font-size:12px;">${badge}</span>
      <a href="#" onclick="loginAccount('${escapeHtml(a.name)}');return false;" style="color:#818cf8; font-size:12px;">🔐 log in</a>
      <a href="#" onclick="openImportCookiesModal('${escapeHtml(a.name)}');return false;" style="color:#818cf8; font-size:12px;">🍪 cookies</a>
      <input type="text" value="${escapeAttr(a.fbDisplayName || '')}" placeholder="FB display name (to skip its own posts)" onchange="updateFbDisplayName('${escapeHtml(a.name)}', this.value)" style="flex:1; min-width:140px; padding:6px 8px; background:#1f2937; border:1px solid #374151; border-radius:6px; color:#e5e7eb; font-size:12px;">
      <button onclick="toggleModerator('${escapeHtml(a.name)}', false)" title="Remove as moderator" style="background:none; border:none; color:#f87171; cursor:pointer; font-size:14px;">✕</button>
    </div>`;
  }).join('');
  el.innerHTML = `
    <div style="padding:16px; background:linear-gradient(135deg, rgba(99,102,241,0.10), rgba(21,27,48,0.55)); border:1px solid rgba(99,102,241,0.28); border-radius:16px;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:700; color:#e2e8f0;">🛡️ Group Moderators (admins)</div>
          <div style="font-size:12px; color:#94a3b8; margin-top:2px; max-width:560px;">Admin accounts that approve held ("Spam potentiel"/pending) posts so they go live and their comments can land. They only need a login + which groups — they <b>never post</b>, and don't appear in the posting Accounts tab. ${mods.length >= 2 ? 'Assign each group to a moderator in its row below.' : 'One moderator covers all your groups automatically.'}</div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
          <div style="display:flex; gap:6px;">
            <button onclick="approveHeldNowUI(this)" title="Run the moderator now to approve any posts currently held in Spam potentiel (normally automatic; this forces it immediately)" style="background:#0f766e; color:#fff; border:none; border-radius:8px; padding:7px 12px; font-size:13px; font-weight:600; cursor:pointer;">🛡️ Approve held now</button>
            <button onclick="addModeratorAccount()" style="background:#6366f1; color:#fff; border:none; border-radius:8px; padding:7px 12px; font-size:13px; font-weight:600; cursor:pointer;">➕ Add admin</button>
          </div>
          <span style="font-size:11px; color:${enabled ? '#34d399' : '#fbbf24'};">${enabled ? '✓ approval ON (also runs automatically during a run)' : '⚠ enable in Settings'}</span>
        </div>
      </div>
      <div style="margin-top:10px;">${rows || '<div style="font-size:12px; color:#6b7280;">No moderators yet — click “➕ Add admin”, log it in, and (if 2+) assign groups below.</div>'}</div>
    </div>`;
}
// MOD: force a moderator-approval pass NOW on whatever's currently held in Spam potentiel (normally this
// runs automatically during a run; this lets you trigger it on demand — also handy for testing).
async function approveHeldNowUI(btn) {
  try {
    if (btn) { btn.disabled = true; btn.textContent = '🛡️ Approving…'; }
    showNotification('🛡️ Running moderator approval on held posts… watch the log.', 'info');
    const r = await window.electronAPI.invoke('approve-held-now');
    if (!r || r.ok === false) showNotification('Moderator: ' + ((r && (r.reason || r.error)) || 'could not run') + ' — see the log.', 'error');
    else showNotification(`🛡️ Moderator pass done — ${r.held || 0} held reviewed${r.queued ? `, ${r.queued} comment(s) queued` : ''}. See the log.`, 'success');
  } catch (e) { showNotification('Moderator error: ' + e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🛡️ Approve held now'; } }
}
// MOD: add an admin/moderator account straight from the Groups page. Opens a modal (Electron's
// renderer does NOT support window.prompt — it returns null — so a modal is required).
function addModeratorAccount() {
  const input = document.getElementById('admin-name');
  if (input) input.value = '';
  openModal('modal-add-admin');
  setTimeout(() => { try { document.getElementById('admin-name').focus(); } catch {} }, 120);
}
// MOD: create the moderator from the modal — create account + flag as moderator (so it never posts and
// never shows in the posting Accounts list) + open its login window.
async function submitAddModerator() {
  const accountName = ((document.getElementById('admin-name') || {}).value || '').trim();
  if (!accountName) { showNotification('Please enter a name', 'error'); return; }
  if (!/^[a-zA-Z0-9_]+$/.test(accountName)) { showNotification('Name can only contain letters, numbers, and underscores', 'error'); return; }
  if ((appData.accounts || []).some((a) => a.name === accountName)) { showNotification('An account with that name already exists', 'error'); return; }
  closeModal('modal-add-admin');
  showNotification('Creating moderator account…', 'info');
  // Born flagged (isModerator) + disabled-as-poster in the backend, so it is never eligible to post.
  const result = await window.electronAPI.createAccount(accountName, '', { isModerator: true });
  if (!result || !result.success) { showNotification('Failed to create: ' + ((result && result.error) || 'unknown'), 'error'); return; }
  await loadData();
  try { renderModeratorPanel(); renderAccounts(); } catch {}
  showNotification(`🛡️ ${accountName} added as moderator — authenticate it with “🔐 log in” or “🍪 cookies” in its row.`, 'success');
}

// Edit account name and alias
let editingAccountName = null;

async function editAccount(accountName) {
  const account = appData.accounts.find(a => a.name === accountName);
  if (!account) return;

  editingAccountName = accountName;

  // Populate modal fields
  document.getElementById('edit-account-alias').value = account.alias || '';
  document.getElementById('edit-account-name').value = accountName;

  // Credential section: clear first, then fetch the DECRYPTED email from main (M3-01 — creds are
  // encrypted at rest, so appData.email is ciphertext and must not be shown directly).
  document.getElementById('edit-account-email').value = '';
  document.getElementById('edit-account-password').value = '';
  const badge = document.getElementById('edit-account-cred-badge');
  if (badge) badge.style.display = 'none';
  openModal('modal-edit-account');
  try {
    const cred = await window.electronAPI.getAccountCredentials(accountName);
    if (cred && cred.success) {
      document.getElementById('edit-account-email').value = cred.email || '';
      // Operator asked to SEE the FB password here — pre-fill it (decrypted, local only).
      document.getElementById('edit-account-password').value = cred.password || '';
      if (badge) badge.style.display = cred.hasPassword ? 'block' : 'none';
    }
  } catch {}
}

// Toggle a password input between visible text and masked dots (the eye button next to it).
function togglePasswordVisibility(inputId, btn) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  if (btn) btn.textContent = show ? '🙈' : '👁️';
}

async function saveAccountCredentials() {
  if (!editingAccountName) return;
  const emailVal = document.getElementById('edit-account-email').value.trim();
  const passVal = document.getElementById('edit-account-password').value;
  // Blank password field = "leave unchanged" → pass null so the backend KEEPS the existing encrypted password.
  // (The old code passed account.password — already ENCRYPTED — which the backend then re-encrypted, corrupting
  // the saved password on every email/alias edit. The backend now ignores null and keeps the existing value.)
  const account = appData.accounts.find(a => a.name === editingAccountName);
  const finalPass = passVal !== '' ? passVal : null;
  const result = await window.electronAPI.setAccountCredentials(editingAccountName, emailVal, finalPass);
  if (result && result.success) {
    // Update local cache so the badge reflects the new state without a full reload (mark "set", never cache plaintext).
    if (account) { account.email = emailVal; if (finalPass != null) account.password = finalPass ? 'set' : ''; }
    const hasPass = (finalPass != null) ? !!finalPass : !!(account && account.password);
    const badge = document.getElementById('edit-account-cred-badge');
    if (badge) badge.style.display = hasPass ? 'block' : 'none';
    document.getElementById('edit-account-password').value = '';
    showNotification('Auto-login credentials saved!', 'success');
  } else {
    showNotification('Failed to save credentials: ' + (result && result.error ? result.error : 'unknown error'), 'error');
  }
}

async function saveEditAccount() {
  if (!editingAccountName) return;

  const accountName = editingAccountName;
  const trimmedAlias = document.getElementById('edit-account-alias').value.trim();
  const newName = document.getElementById('edit-account-name').value.trim();

  if (!newName) {
    showNotification('Account name cannot be empty', 'error');
    return;
  }

  // If name changed, use IPC to rename folder
  if (newName !== accountName) {
    // Check for duplicate names
    const duplicate = appData.accounts.find(a => a.name === newName && a.name !== accountName);
    if (duplicate) {
      showNotification(`Account name "${newName}" already exists!`, 'error');
      return;
    }

    const result = await window.electronAPI.invoke('rename-account', accountName, newName);
    if (!result.success) {
      showNotification('Failed to rename account: ' + result.error, 'error');
      return;
    }
  }

  // Reload data from disk (rename-account IPC already updated data.json)
  await loadData();

  // Update alias in data
  const acc = appData.accounts.find(a => a.name === newName);
  if (acc) {
    acc.alias = trimmedAlias || undefined;
    try { await saveData(); }
    catch { return; } // save was skipped (data.json briefly locked) — saveData() already warned; leave the modal open so the operator can retry instead of seeing a false "updated!"
  }

  closeModal('modal-edit-account');
  editingAccountName = null;
  showNotification('Account updated successfully!', 'success');
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.groups-dropdown')) {
    document.querySelectorAll('.group-dropdown-menu').forEach(d => d.style.display = 'none');
  }
  if (!e.target.closest('.acct-group-picker')) {
    document.querySelectorAll('.acct-group-menu').forEach(d => d.style.display = 'none'); // account-card "👥 Group ▾" picker
  }
});

// Cookie Import
let cookieImportAccount = null;

function openImportCookiesModal(accountName) {
  cookieImportAccount = accountName;
  document.getElementById('cookie-import-account-name').textContent = accountName;
  document.getElementById('cookie-json-input').value = '';
  document.getElementById('cookie-import-status').textContent = '';
  document.getElementById('cookie-import-status').style.display = 'none';
  openModal('modal-import-cookies');
}

async function submitCookieImport() {
  if (!cookieImportAccount) return;

  const jsonText = document.getElementById('cookie-json-input').value.trim();
  const statusEl = document.getElementById('cookie-import-status');

  if (!jsonText) {
    statusEl.textContent = '❌ Please paste your cookies JSON.';
    statusEl.style.display = 'block';
    statusEl.style.color = '#dc2626';
    return;
  }

  // Parse the JSON
  let cookiesArray;
  try {
    cookiesArray = JSON.parse(jsonText);
    if (!Array.isArray(cookiesArray)) {
      throw new Error('Not an array');
    }
    // No per-cookie pre-validation here: a single empty-value entry in an otherwise-good export must NOT
    // block the whole import. The backend (import-cookies) filters junk entries and warns if c_user/xs are
    // missing — that's the right place to validate.
  } catch (e) {
    statusEl.textContent = '❌ Invalid JSON format: ' + e.message;
    statusEl.style.display = 'block';
    statusEl.style.color = '#dc2626';
    return;
  }

  // Show progress
  statusEl.textContent = '⏳ Importing cookies and validating login... This may take a minute.';
  statusEl.style.display = 'block';
  statusEl.style.color = '#f59e0b';
  document.getElementById('btn-submit-cookies').disabled = true;
  document.getElementById('btn-submit-cookies').textContent = '⏳ Importing...';

  try {
    const result = await window.electronAPI.importCookies(cookieImportAccount, cookiesArray);

    if (result.success) {
      if (result.status === 'logged_in') {
        statusEl.textContent = '✅ Cookies imported successfully! Account is logged in.';
        statusEl.style.color = '#16a34a';
        showNotification(`✅ ${cookieImportAccount} logged in via cookies!`, 'success');
        setTimeout(() => {
          closeModal('modal-import-cookies');
          cookieImportAccount = null;
        }, 1500);
      } else {
        // Prefer the backend's SPECIFIC diagnosis (e.g. "missing c_user & xs — re-export while logged in") over the
        // generic "expired" guess — main.js already computes which auth cookies were absent and returns result.warning.
        statusEl.textContent = '⚠️ ' + (result.warning || 'Cookies imported but login could not be verified. The cookies might be expired.');
        statusEl.style.color = '#f59e0b';
        showNotification(`⚠️ ${cookieImportAccount}: ${result.warning || 'cookies may be expired.'}`, 'error');
      }
    } else {
      statusEl.textContent = '❌ Import failed: ' + result.error;
      statusEl.style.color = '#dc2626';
    }
  } catch (e) {
    statusEl.textContent = '❌ Error: ' + e.message;
    statusEl.style.color = '#dc2626';
  }

  document.getElementById('btn-submit-cookies').disabled = false;
  document.getElementById('btn-submit-cookies').textContent = '🍪 Import & Validate';
  await loadData();
}

function openAddAccountModal() {
  console.log('Opening Add Account Modal - paranoia check');

  // Close all other modals first - FORCE HIDDEN
  document.querySelectorAll('.modal').forEach(modal => {
    modal.classList.remove('active');
    modal.style.display = 'none'; // Force hide
  });

  const input = document.getElementById('account-name');
  const aliasInput = document.getElementById('account-alias');

  // Reset input state
  input.value = '';
  if (aliasInput) aliasInput.value = '';
  input.disabled = false;
  input.readOnly = false;
  input.removeAttribute('disabled');
  input.removeAttribute('readonly');
  input.style.pointerEvents = 'auto';
  input.style.zIndex = '9999'; // Boost z-index just in case
  input.style.position = 'relative';

  const modal = document.getElementById('modal-add-account');
  modal.style.display = 'flex'; // Force show
  // Small delay to allow display:flex to apply before adding active class
  setTimeout(() => modal.classList.add('active'), 10);

  // Debug what's on top
  setTimeout(() => {
    input.focus();
    const rect = input.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topElement = document.elementFromPoint(centerX, centerY);
    console.log('Element at input center:', topElement);
    console.log('Is input focused?', document.activeElement === input);
  }, 200);
}

async function saveAccount() {
  // Moderators are free — only posting accounts count against the seat limit.
  if (Number.isFinite(appLimits.maxAccounts) && appData.accounts.filter(a => !a.isModerator).length >= appLimits.maxAccounts) {
    showNotification(`License Limit Reached! Max Accounts: ${appLimits.maxAccounts}`, 'error');
    return;
  }

  const accountName = document.getElementById('account-name').value.trim();
  const accountAlias = document.getElementById('account-alias').value.trim();

  if (!accountName) {
    showNotification('Please enter an account name', 'error');
    return;
  }

  // Validate account name (alphanumeric and underscore only)
  if (!/^[a-zA-Z0-9_]+$/.test(accountName)) {
    showNotification('Account name can only contain letters, numbers, and underscores', 'error');
    return;
  }

  closeModal('modal-add-account');
  showNotification('Creating account folder...', 'info');

  const result = await window.electronAPI.createAccount(accountName, accountAlias);

  if (result.success) {
    showNotification('Account created! Use Login or Cookies to authenticate.', 'success');
    await loadData();
  } else {
    showNotification('Failed to create account: ' + result.error, 'error');
  }
}

// Account-card "🌐 Open": open Facebook in THIS account's own logged-in browser, so the operator can re-join a
// group (the held-post fix) or check the account as that account.
function openAccountBrowser(accountName) {
  showNotification(`Opening Facebook as ${accountName}…`, 'info');
  window.electronAPI.invoke('open-account-browser', accountName)
    .then((r) => { if (!(r && r.success)) showNotification(`Could not open ${accountName}: ` + ((r && r.error) || 'unknown'), 'error'); })
    .catch((e) => showNotification(`Could not open ${accountName}: ` + (e.message || e), 'error'));
}
// Toggle THIS account's group picker; close any other open picker first (one menu at a time).
function toggleAccountGroupPicker(accountName) {
  const menu = document.getElementById('acct-group-menu-' + acctKey(accountName));
  const open = menu && menu.style.display === 'block';
  document.querySelectorAll('.acct-group-menu').forEach((m) => { m.style.display = 'none'; });
  if (menu && !open) menu.style.display = 'block';
}
// Open a specific assigned group AS this account (its own browser + proxy + geo, via open-account-browser + a group id).
function openAccountGroup(accountName, fbGroupId) {
  document.querySelectorAll('.acct-group-menu').forEach((m) => { m.style.display = 'none'; });
  if (!fbGroupId) { showNotification('That group has no saved Facebook id — use 🌐 Open and search Groups instead.', 'error'); return; }
  showNotification(`Opening group ${fbGroupId} as ${accountName}…`, 'info');
  window.electronAPI.invoke('open-account-browser', accountName, fbGroupId)
    .then((r) => { if (!(r && r.success)) showNotification(`Could not open ${accountName}: ` + ((r && r.error) || 'unknown'), 'error'); })
    .catch((e) => showNotification(`Could not open ${accountName}: ` + (e.message || e), 'error'));
}

async function loginAccount(accountName) {
  console.log('=== LOGIN ACCOUNT CLICKED ===');
  console.log('Account:', accountName);

  showNotification(`Opening login browser for ${accountName}...`, 'info');

  const result = await window.electronAPI.loginAccount(accountName);

  console.log('Login result:', result);

  if (!result.success) {
    showNotification('Failed to open login browser: ' + result.error, 'error');
  }
}

async function deleteAccount(accountName) {
  if (!(await themedConfirm(`This permanently deletes "${accountName}" and all its data (Chromium profile + cookies). This cannot be undone.\n\nType the account name to confirm.`, { title: 'Delete account', confirmText: 'Delete', danger: true, requireText: accountName }))) return;

  const result = await window.electronAPI.deleteAccount(accountName);

  if (result.success) {
    await loadData();
    showNotification('Account deleted successfully', 'success');
  } else {
    showNotification('Failed to delete account: ' + result.error, 'error');
  }
}

async function checkLoginStatus() {
  if (!currentLoginAccount) return;

  showNotification('Checking login status...', 'info');
  document.getElementById('btn-check-login').disabled = true;
  document.getElementById('btn-check-login').textContent = '⏳ Checking...';

  const result = await probeLogin(currentLoginAccount);

  if (result.status === 'logged_in') {
    showNotification(`✅ ${currentLoginAccount} is logged in successfully!`, 'success');
    // Switch buttons
    document.getElementById('btn-check-login').style.display = 'none';
    document.getElementById('btn-login-done').style.display = 'inline-block';
  } else {
    showNotification(`⚠️ ${currentLoginAccount} is not logged in yet. Please complete the login.`, 'error');
    document.getElementById('btn-check-login').disabled = false;
    document.getElementById('btn-check-login').textContent = '🔍 Check Login Status';
  }
}

function closeLoginAndSave() {
  closeModal('modal-login-instructions');
  showNotification('Login saved successfully!', 'success');
  currentLoginAccount = null;
  // Reset button states
  document.getElementById('btn-check-login').style.display = 'inline-block';
  document.getElementById('btn-check-login').disabled = false;
  document.getElementById('btn-check-login').textContent = '🔍 Check Login Status';
  document.getElementById('btn-login-done').style.display = 'none';
}

function cancelLogin() {
  if (typeof currentLoginAccount !== 'undefined' && currentLoginAccount) {
    window.electronAPI.closeLoginBrowser(currentLoginAccount).catch(() => {});
  }

  closeModal('modal-login-instructions');
  currentLoginAccount = null;
  // Reset button states
  document.getElementById('btn-check-login').style.display = 'inline-block';
  document.getElementById('btn-check-login').disabled = false;
  document.getElementById('btn-check-login').textContent = '🔍 Check Login Status';
  document.getElementById('btn-login-done').style.display = 'none';
}

// Automation Control
async function checkAutomationStatus() {
  const result = await window.electronAPI.getAutomationStatus();
  if (result.success) {
    isAutomationRunning = result.isRunning;
    isPaused = result.isPaused || false;
    updateAutomationControls();
  }
}

function updateAutomationControls() {
  const startBtn   = document.getElementById('btn-start-automation');
  const pauseBtn   = document.getElementById('btn-pause-automation');
  const stopBtn    = document.getElementById('btn-stop-automation');
  const finishBtn  = document.getElementById('btn-finish-automation');
  const pausedInd  = document.getElementById('paused-indicator');

  const setEnabled = (btn, enabled) => {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.classList.toggle('opacity-50', !enabled);
    btn.classList.toggle('cursor-not-allowed', !enabled);
  };
  const show = (btn, visible) => { if (btn) btn.style.display = visible ? '' : 'none'; };
  // F4: Reset Rotation is destructive to dealt-state — enabled ONLY when fully stopped (double-post-safe).
  setEnabled(document.getElementById('btn-reset-rotation'), !isAutomationRunning);
  // Same stopped-only contract for the campaign-altering wizard and the "Start over" reset.
  setEnabled(document.getElementById('btn-start-over-posts'), !isAutomationRunning);
  setEnabled(document.getElementById('btn-quick-setup'), !isAutomationRunning);
  // Finish is available while a run is active (running or paused), disabled once requested or stopping.
  const applyFinish = () => {
    show(finishBtn, true);
    setEnabled(finishBtn, !isStopping && !isFinishing);
    if (finishBtn) finishBtn.innerHTML = isFinishing ? '<span>🏁</span> Finishing…' : '<span>🏁</span> Finish after batch';
  };

  if (!isAutomationRunning) {
    // IDLE: only Start visible; disabled while a Start is already in flight (so a 2nd click can't double-start)
    show(startBtn,  true);  setEnabled(startBtn,  !localStartInFlight);
    show(pauseBtn,  false);
    show(stopBtn,   false);
    show(finishBtn, false);
    if (pausedInd) pausedInd.style.display = 'none';
  } else if (isPaused) {
    // PAUSED: the Pause button becomes Resume. Stop remains a hard interrupt.
    show(startBtn,  false);
    show(pauseBtn,  true);  setEnabled(pauseBtn, !isStopping && !_pauseBusy);
    show(stopBtn,   true);  setEnabled(stopBtn, !isStopping && !_stopBusy);
    applyFinish();
    if (pauseBtn && !_pauseBusy) pauseBtn.innerHTML = '<span>▶️</span> Resume';
    if (stopBtn) stopBtn.innerHTML = isStopping ? '<span>⏹️</span> Stopping…' : '<span>⏹️</span> Stop';
    if (pausedInd) pausedInd.style.display = '';
  } else {
    // RUNNING: Pause toggle + graceful Finish + hard Stop.
    show(startBtn,  false);
    show(pauseBtn,  true);  setEnabled(pauseBtn,  !isStopping && !_pauseBusy);
    show(stopBtn,   true);  setEnabled(stopBtn,   !isStopping && !_stopBusy);
    applyFinish();
    if (pauseBtn && !_pauseBusy) pauseBtn.innerHTML = '<span>⏸</span> Pause';
    if (stopBtn) stopBtn.innerHTML = isStopping ? '<span>⏹️</span> Stopping…' : '<span>⏹️</span> Stop';
    if (pausedInd) pausedInd.style.display = 'none';
  }

  updateDashboard();
}

// Render a persistent end-of-run summary into the log pane + notify the operator.
function renderRunSummary(s) {
  if (!s) return;
  const mins = Math.floor((s.durationMs || 0) / 60000), secs = Math.round(((s.durationMs || 0) % 60000) / 1000);
  const lines = ['', '📋 ═══════ RUN SUMMARY ═══════'];
  lines.push(`   Result: ${s.reason}`);
  lines.push(`   Posted: ${s.posted}   Pending approval: ${s.pending}   Errors: ${s.errors}`);
  lines.push(`   Cycles: ${s.cycles}   Duration: ${mins}m ${secs}s`);
  const byAcc = s.byAccount || {};
  const names = Object.keys(byAcc);
  if (names.length) {
    lines.push('   Per account:');
    for (const n of names) { const a = byAcc[n]; lines.push(`     • ${n}: posted=${a.posted} pending=${a.pending} errors=${a.errors}`); }
  }
  const flagged = s.flagged || [];
  if (flagged.length) {
    lines.push('   ⚠️ ACCOUNTS NEEDING ATTENTION:');
    for (const f of flagged) lines.push(`     • ${f.name} → ${f.action}`);
  }
  lines.push('   Full audit trail → Logs folder → run-report.csv');
  lines.push('═══════════════════════════════');
  addLog(lines.join('\n') + '\n');
  try { showNotification(`Run ${s.reason}: ${s.posted} posted, ${s.pending} pending, ${s.errors} errors`, s.errors ? 'error' : 'success'); } catch {}
  // Desktop notification so an operator who walked away still sees the result.
  try { if (window.Notification && Notification.permission === 'granted') new Notification('Za Post — run ' + s.reason, { body: `${s.posted} posted, ${s.pending} pending, ${s.errors} errors` }); } catch {}
}

async function startAutomation(opts = {}) {
  if (isAutomationRunning) { showNotification('Automation is already running', 'info'); return; }
  if (localStartInFlight) return; // M4-07: guard against a double-click starting two runs
  if (appData.posts.length === 0) {
    showNotification('Please add some posts first', 'error');
    return;
  }

  if (appData.groups.length === 0) {
    showNotification('Please add some groups first', 'error');
    return;
  }

  if (appData.accounts.length === 0) {
    showNotification('Please add some accounts first', 'error');
    return;
  }

  // Effective-campaign preflight: an account can only post if it is ENABLED + LOGGED IN +
  // has ≥1 assigned group. If none qualify, the run would post nothing for hours while
  // showing "Running" — hard-block with a clear, actionable reason instead.
  // Moderators approve held posts; they never post — exclude them from every posting preflight check
  // (otherwise a correctly-configured moderator with no groups trips these warnings on every Start).
  const posters = appData.accounts.filter(a => !a.isModerator);
  // A Standby (backup) account doesn't post on its own — Start needs at least one PRIMARY (non-standby) poster.
  const eligible = posters.filter(a => a.enabled !== false && !a.standby && a.status === 'logged_in' && (a.assignedGroups || []).length > 0);
  if (eligible.length === 0) {
    const standbyReady = posters.some(a => a.enabled !== false && a.standby && a.status === 'logged_in' && (a.assignedGroups || []).length > 0);
    showNotification(standbyReady
      ? 'Only Standby (backup) accounts are ready — they don\'t post on their own. Make at least one a Primary (toggle Standby off), then Start.'
      : 'No account can post yet — each needs to be enabled, logged in, and assigned at least 1 group. Fix accounts, then Start.', 'error');
    addLog('🛑 Start blocked: no eligible PRIMARY account (need enabled + not-standby + logged-in + ≥1 assigned group).\n');
    return;
  }

  // From here on there are AWAIT points (the preflight dialogs below) — claim the in-flight guard NOW so a 2nd Start
  // click while a dialog is open can't launch a second run; the top guard + the greyed-out Start button both honor it.
  localStartInFlight = true; updateAutomationControls();

  // Pre-flight: warn if the post library is EMPTY — the run idles and posts nothing until posts are added. NON-blocking
  // (not a hard stop) because the remote API can fill the library after Start (an operator may launch then feed it).
  if (!appData.posts || appData.posts.length === 0) {
    if (!(await themedConfirm('Your post library is EMPTY — the run will idle and post nothing until you add posts (Posts tab, or the remote API).', { title: 'No posts to publish', confirmText: 'Start anyway' }))) { localStartInFlight = false; updateAutomationControls(); return; }
  }

  // Pre-flight: warn if any poster is not logged in
  const notLoggedIn = posters.filter(a => a.status !== 'logged_in');
  if (notLoggedIn.length > 0) {
    const total = posters.length;
    if (!(await themedConfirm(`${notLoggedIn.length} of ${total} account(s) are not logged in and will be skipped.`, { title: 'Some accounts not logged in', confirmText: 'Start anyway' }))) { localStartInFlight = false; updateAutomationControls(); return; }
  }

  // Pre-flight: the Chrome helper (live agent) reports the REAL session state. Warn about accounts the APP still thinks
  // are fine (status logged_in) but Chrome flags as logged-out/checkpointed — the app's own status only updates AFTER a
  // failed post, so this catches dead accounts a whole cycle earlier. Only counts recent (<24h) Chrome telemetry. Non-blocking.
  {
    const now = Date.now();
    const chromeDead = posters.filter(a => a.enabled !== false && a.status === 'logged_in' && a.chromeHealth && a.chromeSeen && (now - a.chromeSeen < 24 * 3600 * 1000) && (a.chromeHealth.state === 'logged_out' || a.chromeHealth.state === 'checkpoint'));
    if (chromeDead.length > 0) {
      const cp = chromeDead.filter(a => a.chromeHealth.state === 'checkpoint').length;
      const lo = chromeDead.length - cp;
      const bits = [lo ? `⚪ ${lo} logged out` : '', cp ? `🔴 ${cp} need verification` : ''].filter(Boolean).join(' · ');
      if (!(await themedConfirm(`Your Chrome helper reports ${chromeDead.length} account(s) that likely won't post right now (${bits}):\n${chromeDead.map(a => a.name).join(', ')}\n\nOpen those profiles in Chrome (or solve the checkpoint) — the app auto-recovers them on the next sync.`, { title: 'Accounts flagged by Chrome', confirmText: 'Start anyway' }))) { localStartInFlight = false; updateAutomationControls(); return; }
    }
  }

  // Pre-flight: warn if any ENABLED poster has no assigned groups (it will post nothing)
  const noGroups = posters.filter(a => a.enabled !== false && (!a.assignedGroups || a.assignedGroups.length === 0));
  if (noGroups.length > 0) {
    if (!(await themedConfirm(`${noGroups.length} enabled account(s) have NO assigned groups and will post nothing:\n${noGroups.map(a => a.name).join(', ')}`, { title: 'Accounts with no groups', confirmText: 'Start anyway' }))) { localStartInFlight = false; updateAutomationControls(); return; }
  }

  // Pre-flight: warn if any ENABLED poster that HAS groups is assigned a post-set with NO posts (it will post nothing).
  // Mirrors the no-groups warning; non-blocking. The assignedGroups>0 guard means it can never double-warn with it.
  const emptySet = posters.filter(a => a.enabled !== false && (a.assignedGroups || []).length > 0 && a.postSetId && appData.posts.filter(p => p.postSetId === a.postSetId).length === 0);
  if (emptySet.length > 0) {
    if (!(await themedConfirm(`${emptySet.length} enabled account(s) are assigned a post-set that has NO posts and will post nothing:\n${emptySet.map(a => a.name).join(', ')}\n\nTag posts to that set (Posts tab) or clear the account's post-set.`, { title: 'Accounts with an empty post-set', confirmText: 'Start anyway' }))) { localStartInFlight = false; updateAutomationControls(); return; }
  }

  // Pre-flight: warn if moderator approval is ON but no moderator is READY — held posts ("Spam potentiel") would pile
  // up unapproved for the whole run. The orchestrator also warns mid-run, but catching it at Start saves a wasted run.
  if (appData.settings && appData.settings.moderationEnabled) {
    const mods = appData.accounts.filter(a => a.isModerator);
    if (!mods.some(a => a.status === 'logged_in')) {
      const msg = mods.length === 0
        ? 'Moderator approval is ON but NO moderator account is set — held posts ("Spam potentiel") will never be approved.\n\nDesignate one in the Groups tab → 🛡️ Group Moderator (and log it in).'
        : 'Moderator approval is ON but the moderator account is NOT logged in — held posts will pile up unapproved until it is.';
      if (!(await themedConfirm(msg, { title: 'Moderator not ready', confirmText: 'Start anyway' }))) { localStartInFlight = false; updateAutomationControls(); return; }
    }
  }

  // Pre-flight: warn if any PROXIED account is missing its timezone/locale. applyProxyGeo only aligns the browser
  // clock/language to the proxy IP region when those are set — an empty field silently leaks THIS computer's clock/
  // language (host is Morocco / French here), mismatching the proxy IP (a link signal). Same proxied predicate as
  // lib/browser.applyProxyGeo + scripts/readiness.js. Real-IP accounts are correctly left on the host values.
  {
    const useProx = !!appData.useProxies, pool = appData.proxies || [], st = appData.settings || {};
    const isProxied = (a) => !!(a.proxy || (useProx && pool.length));
    const geoActive = appData.accounts.filter(a => (a.isModerator || a.standby || a.enabled !== false) && isProxied(a));
    const noTz = geoActive.filter(a => !String(a.timezone || st.proxyTimezone || '').trim());
    const noLoc = geoActive.filter(a => !String(a.locale || st.proxyLocale || '').trim());
    if (noTz.length || noLoc.length) {
      const lines = [];
      if (noTz.length) lines.push(`• ${noTz.length} missing TIMEZONE: ${noTz.map(a => a.name).join(', ')}`);
      if (noLoc.length) lines.push(`• ${noLoc.length} missing LOCALE: ${noLoc.map(a => a.name).join(', ')}`);
      const msg = `Some PROXIED accounts have no timezone/locale set, so their browser reports THIS computer's clock/language instead of the proxy's region — a mismatch Facebook can use to link them:\n\n${lines.join('\n')}\n\nSet proxyTimezone + proxyLocale in Settings (or per account) to your proxies' region/language.`;
      if (!(await themedConfirm(msg, { title: 'Proxied accounts missing timezone/locale', confirmText: 'Start anyway' }))) { localStartInFlight = false; updateAutomationControls(); return; }
    }
  }

  clearLogs();
  addLog('🚀 Starting automation...\n');

  // Ask once for desktop-notification permission so the end-of-run summary can alert an
  // operator who walked away during the (potentially hours-long) run.
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}

  localStartInFlight = true;
  let started = false; // report back so callers (the wizard) only claim success when it actually launched
  try {
    const result = await window.electronAPI.startAutomation(!!opts.runNow);
    if (result && result.success) {
      isAutomationRunning = true;
      isPaused = false;
      isStopping = false;
      updateAutomationControls();
      showNotification('Automation started!', 'success');
      started = true;
    } else {
      showNotification('Failed to start automation: ' + ((result && result.error) || 'unknown error'), 'error');
    }
  } catch (e) {
    showNotification('Failed to start automation: ' + e.message, 'error');
  } finally {
    setTimeout(() => { localStartInFlight = false; }, 500);
  }
  return started;
}


async function stopAutomation() {
  if (isStopping || _stopBusy) return; // already stopping, or the confirm dialog is already open (no 2nd dialog)
  _stopBusy = true; updateAutomationControls(); // hold the Stop button while the dialog is open
  // Ask UP FRONT how to stop (your progress is saved either way): resume later, start over, or cancel.
  let choice;
  try {
    choice = await themedChoice(
      'The run will stop safely after the current post finishes — your progress is saved either way.\n\n• Resume later — the next Start continues exactly where it stopped.\n• Start over — clears what each account has already posted so the next Start begins from post #1 (this does NOT delete any posts).',
      { title: '⏹️ Stop the run?', choices: [
          { key: 'keep', label: '▶ Stop — resume later' },
          { key: 'over', label: '🔄 Stop & start over', danger: true },
        ], cancelText: 'Cancel (keep running)' });
  } finally { _stopBusy = false; }
  if (!choice) { updateAutomationControls(); return; } // cancelled — keep running
  // The run may have FINISHED NATURALLY while the dialog sat open — there's nothing to stop, but still honor the
  // operator's "start over" choice (otherwise it would be silently lost behind a confusing "failed to stop").
  if (!isAutomationRunning) {
    updateAutomationControls();
    if (choice === 'over') { await doStartOverReset(); }
    else showNotification('Run already finished — progress saved.', 'info');
    return;
  }
  addLog('\n⏹️ Stopping automation...\n');
  isStopping = true;
  isPaused = false; // while Stopping, don't keep showing the yellow "Paused" indicator (Stop overrides a paused run)
  updateAutomationControls();
  try {
    const result = await window.electronAPI.stopAutomation();
    if (result && result.success) {
      _resetOnStop = (choice === 'over'); // apply the "start over" reset once the run fully halts (onAutomationStopped)
      showNotification(choice === 'over' ? 'Stopping… it will start over from #1 once it halts.' : 'Stopping… progress saved — resume anytime with Start.', 'info');
    } else {
      isStopping = false;
      updateAutomationControls();
      // The run likely just ended between the dialog and the IPC — still honor "start over".
      if (!isAutomationRunning && choice === 'over') { await doStartOverReset(); }
      else showNotification('Failed to stop automation: ' + ((result && result.error) || 'unknown error'), 'error');
    }
  } catch (e) {
    isStopping = false;
    updateAutomationControls();
    showNotification('Failed to stop automation: ' + e.message, 'error');
  }
}

// M2-03: graceful finish — let the current batch complete, then end the run (no new work starts).
async function finishAutomation() {
  if (!isAutomationRunning || isFinishing) return;
  isFinishing = true;
  updateAutomationControls();
  try {
    const result = await window.electronAPI.finishAutomation();
    if (result && result.success !== false) {
      addLog('\n🏁 Will finish after the current batch — no new work will start.\n');
      showNotification('Finishing after the current batch…', 'info');
    } else {
      isFinishing = false; updateAutomationControls();
      showNotification('Failed to finish: ' + ((result && result.error) || 'unknown error'), 'error');
    }
  } catch (e) {
    isFinishing = false; updateAutomationControls();
    showNotification('Failed to finish: ' + (e && e.message || e), 'error');
  }
}

// M2-03: briefly pulse an account's card so a live attention flag is easy to spot. Best-effort —
// finds the card by the account name and is a no-op if the layout doesn't expose one.
function highlightAccountCard(name) {
  const container = document.getElementById('accounts-container');
  if (!container || !name) return;
  let card = container.querySelector(`[data-account-name="${(window.CSS && CSS.escape) ? CSS.escape(name) : name}"]`);
  if (!card) {
    // Fallback: match a card whose text contains the account name.
    card = Array.from(container.children).find((c) => (c.textContent || '').includes(name));
  }
  if (!card) return;
  card.classList.add('ring-2', 'ring-red-500/70');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => { try { card.classList.remove('ring-2', 'ring-red-500/70'); } catch {} }, 6000);
}

async function pauseAutomation() {
  try {
    const result = await window.electronAPI.pauseAutomation();
    if (result && result.success) {
      isPaused = true;
      updateAutomationControls();
      addLog('\n⏸ Automation paused. Click Resume to continue.\n');
      showNotification('Automation paused', 'info');
    } else {
      showNotification('Failed to pause: ' + ((result && result.error) || 'unknown error'), 'error');
    }
  } catch (e) {
    showNotification('Failed to pause: ' + e.message, 'error');
  }
}

async function togglePauseAutomation() {
  // Robustness: ignore rapid re-clicks / invalid states, and HOLD the button (disabled + transient label)
  // for the whole IPC round-trip so a double-click can't fire pause+resume back-to-back or desync the label.
  if (_pauseBusy || isStopping || !isAutomationRunning) return;
  _pauseBusy = true;
  const goingToPause = !isPaused;
  const btn = document.getElementById('btn-pause-automation');
  if (btn) { btn.disabled = true; btn.classList.add('opacity-50', 'cursor-not-allowed'); btn.innerHTML = goingToPause ? '<span>⏸</span> Pausing…' : '<span>▶️</span> Resuming…'; }
  try {
    if (goingToPause) await pauseAutomation(); else await resumeAutomation();
  } finally {
    _pauseBusy = false;
    updateAutomationControls(); // reconcile the button to the authoritative state (isPaused is also synced by events)
  }
}

async function resumeAutomation() {
  try {
    const result = await window.electronAPI.resumeAutomation();
    if (result && result.success) {
      isPaused = false;
      updateAutomationControls();
      addLog('\n▶️ Automation resumed.\n');
      showNotification('Automation resumed!', 'success');
    } else {
      showNotification('Failed to resume: ' + ((result && result.error) || 'unknown error'), 'error');
    }
  } catch (e) {
    showNotification('Failed to resume: ' + e.message, 'error');
  }
}

function clearLogs() {
  document.getElementById('logs-container').innerHTML = '';
  _resetGroupedLogs(); // also clear the per-agent grouped view (fresh per run = per day for a daily run)
}

// ───────────── PER-AGENT GROUPED LOGS (collapsible) ─────────────
// Logs are tagged "[agent] …", "[agent] [group] NN …", "💬 [rescue:agent] …" or "🛡️ [moderator:agent] …".
// We mirror the flat stream into a collapsible section PER AGENT so the operator can read each agent's day
// in isolation, with its action count + per-assigned-group tally. Renderer-only; no backend cost.
const _agentEls = new Map(); // agent -> { details, body, countEl, actions, groups: Map }
let _logGroupedView = false;

function parseLogAgent(text) {
  const m = String(text).match(/\[([^\]]+)\]/);
  if (!m) return { agent: null, group: null };
  let tok = m[1].trim();
  const role = tok.match(/^(?:rescue|moderator)\s*:\s*(.+)$/i);
  const agent = role ? role[1].trim() : tok;
  const m2 = String(text).match(/\][^\[]*\[([^\]]+)\]/); // second bracket = group on step logs
  return { agent, group: m2 ? m2[1].trim() : null };
}

function _agentSection(agent) {
  let e = _agentEls.get(agent);
  if (e) return e;
  const container = document.getElementById('logs-by-account');
  if (!container) return null;
  const details = document.createElement('details');
  details.style.cssText = 'margin-bottom:6px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;background:rgba(0,0,0,0.25);';
  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;padding:7px 10px;font-weight:600;color:#e5e7eb;';
  const nameSpan = document.createElement('span'); nameSpan.textContent = '🧑 ' + agent + ' ';
  const countEl = document.createElement('span'); countEl.style.cssText = 'color:#9ca3af;font-weight:400;font-size:11px;';
  summary.appendChild(nameSpan); summary.appendChild(countEl);
  const body = document.createElement('div'); body.style.cssText = 'padding:4px 10px 8px 18px;border-top:1px solid rgba(255,255,255,0.05);max-height:280px;overflow-y:auto;';
  details.appendChild(summary); details.appendChild(body);
  container.appendChild(details);
  e = { details, body, countEl, actions: 0, groups: new Map() };
  _agentEls.set(agent, e);
  return e;
}

function _recordGrouped(text) {
  const { agent, group } = parseLogAgent(text);
  if (!agent) return; // system line (cycle header, pool stats) — only in the raw stream
  const sec = _agentSection(agent);
  if (!sec) return;
  sec.actions += 1;
  if (group) sec.groups.set(group, (sec.groups.get(group) || 0) + 1);
  const line = document.createElement('div'); line.className = 'log-entry'; line.style.fontSize = '11px';
  line.textContent = text;
  sec.body.appendChild(line);
  while (sec.body.childElementCount > 200) sec.body.removeChild(sec.body.firstChild); // per-agent cap
  const gt = Array.from(sec.groups.entries()).slice(0, 8).map(([g, c]) => `${g}:${c}`).join('  ');
  sec.countEl.textContent = `— ${sec.actions} action${sec.actions === 1 ? '' : 's'}` + (gt ? `  ·  ${gt}` : '');
  if (_logGroupedView) sec.body.scrollTop = sec.body.scrollHeight;
}

function _resetGroupedLogs() {
  _agentEls.clear();
  const c = document.getElementById('logs-by-account');
  if (c) c.innerHTML = '';
}

function toggleLogGrouping() {
  _logGroupedView = !_logGroupedView;
  const flat = document.getElementById('logs-container');
  const grouped = document.getElementById('logs-by-account');
  const btn = document.getElementById('btn-log-group');
  if (flat) flat.style.display = _logGroupedView ? 'none' : '';
  if (grouped) grouped.style.display = _logGroupedView ? '' : 'none';
  if (btn) btn.textContent = _logGroupedView ? '📜 Raw stream' : '🧑 By agent';
}

// Classify a log line into an event TYPE (drives both its colour and the live filter bar). Order = priority:
// errors first, then the specific operator-relevant events (moderator/held/reserve/rate-limit), then success.
// Never flag a "errors=0 / Errors: 0" success summary as an error.
function classifyLog(text) {
  const low = String(text || '').toLowerCase();
  const zeroErr = /errors?\s*[:=]\s*0\b/.test(low);
  if (/❌|🚫|🛑/.test(text) || ((low.includes('error') || low.includes('failed')) && !zeroErr)) return 'error';
  if (/🛡️/.test(text) || low.includes('moderator') || /\bapprov(e|es|ed|ing)\b/.test(low)) return 'moderator'; // verb only — "pending approval" is a HELD state, not a moderator action
  if (/⏳|⌛/.test(text) || low.includes('held') || low.includes('pending approval') || low.includes('spam potentiel') || low.includes('en attente')) return 'held';
  if (/♻️/.test(text) || low.includes('takeover') || low.includes('take over') || low.includes('reserve') || low.includes('stand-in') || low.includes('re-post')) return 'reserve';
  if (/⏸/.test(text) || low.includes('rate-limit') || low.includes('rate limit') || low.includes('cool-down') || low.includes('cooldown') || low.includes('checkpoint')) return 'ratelimit';
  if (/✅|🎉|🏁/.test(text) || low.includes('posted successfully') || low.includes('success') || low.includes('completed')) return 'success';
  return 'info';
}
let _logFilter = 'all';
// Filter the live stream to one event type (or 'all'). Re-applies to every existing entry + new ones.
function setLogFilter(t) {
  _logFilter = t;
  document.querySelectorAll('#log-filter-bar .log-filter-btn').forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-lf') === t));
  const c = document.getElementById('logs-container');
  if (c) c.querySelectorAll('.log-entry').forEach((e) => { e.style.display = (t === 'all' || e.dataset.logtype === t) ? '' : 'none'; });
}

function addLog(text) {
  const container = document.getElementById('logs-container');
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const type = classifyLog(text);
  entry.classList.add(type);
  entry.dataset.logtype = type;
  if (_logFilter !== 'all' && type !== _logFilter) entry.style.display = 'none'; // honour the active filter for new lines

  // Monospace HH:MM:SS timestamp prefix in muted colour — does not change message text
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8); // HH:MM:SS
  const tsSpan = document.createElement('span');
  tsSpan.textContent = ts + ' ';
  tsSpan.style.cssText = 'color:#4b5563;font-size:10px;user-select:none;margin-right:4px;';
  entry.appendChild(tsSpan);

  const msgSpan = document.createElement('span');
  msgSpan.textContent = text;
  entry.appendChild(msgSpan);

  container.appendChild(entry);

  // DOM cap: keep at most ~1000 entries; trim to ~800 when exceeded
  const MAX_ENTRIES = 1000;
  const TRIM_TO = 800;
  if (container.childElementCount > MAX_ENTRIES) {
    const toRemove = container.childElementCount - TRIM_TO;
    for (let i = 0; i < toRemove; i++) {
      if (container.firstChild) container.removeChild(container.firstChild);
    }
  }

  container.scrollTop = container.scrollHeight;
  try { _recordGrouped(text); } catch {} // mirror into the per-agent collapsible view
}

function openLogsFolder() {
  if (window.electronAPI && window.electronAPI.openLogsFolder) {
    window.electronAPI.openLogsFolder().catch(() => {});
  }
}

// Settings
function loadSettings() {
  // ROBUST: every control access is GUARDED (via setChecked/setValue). Previously many were raw
  // document.getElementById('setting-x').checked = … with NO null-check, so a single missing/renamed
  // element threw and blanked the WHOLE Settings page. Now a missing control is skipped, not fatal.
  const S = (appData && appData.settings) || {};
  const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
  const setValue = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setChecked('setting-comment-with-image', S.commentWithImage || false);
  setChecked('setting-hide-browser', S.hideBrowser !== false);
  setChecked('setting-enable-tunnel', S.enableTunnel || false);
  setChecked('setting-moderation-enabled', S.moderationEnabled === true);
  setChecked('setting-moderation-dry-run', S.moderationDryRun === true);
  setChecked('setting-resume-on-startup', S.resumeOnStartup === true);
  setChecked('setting-launch-on-startup', S.launchOnStartup || false);
  { const el = document.getElementById('setting-auto-start-daily'); if (el) { el.checked = S.autoStartDaily === true;
    // Reconcile against the LIVE Windows Task Scheduler state so the toggle + tooltip reflect whether the daily task
    // is actually registered — not just the saved flag.
    try { if (window.electronAPI.getAutostartStatus) window.electronAPI.getAutostartStatus().then((r) => { const st = (r && r.data) || r; if (st && typeof st.registered === 'boolean') { el.checked = st.registered; el.title = st.registered ? ('✅ Windows daily task armed' + (st.nextRun ? ' — next run: ' + st.nextRun : '')) : '⚠️ Windows daily task is NOT registered'; } }).catch(() => {}); } catch {} } }
  setValue('setting-daily-cap', S.dailyCap !== undefined ? S.dailyCap : 0);
  setValue('setting-reserve-accounts', S.reserveAccounts !== undefined ? S.reserveAccounts : 0);
  setValue('setting-reserve-max-jobs', S.reserveMaxJobsPerCycle !== undefined ? S.reserveMaxJobsPerCycle : 1);
  setValue('setting-daily-post-time', S.dailyPostTime || '09:00');
  setValue('setting-cycles-per-day', S.cyclesPerDay !== undefined ? S.cyclesPerDay : 1);
  setValue('setting-tabs-per-browser', S.tabsPerBrowser !== undefined ? S.tabsPerBrowser : 1);
  setChecked('setting-post-then-comment', S.postThenComment === true); // two-phase: post all groups, then comment all
  setValue('setting-cycle-gap-min', (Number(S.cycleGapMin) > 0) ? S.cycleGapMin : ''); // "time between cycles" override (blank = use the speed preset's timing)
  setValue('setting-proxy-timezone', S.proxyTimezone || '');
  setValue('setting-proxy-locale', S.proxyLocale || '');
  setChecked('setting-repost-enabled', S.repostEnabled === true);
  setValue('setting-repost-grace-sec', S.repostGraceSec !== undefined ? S.repostGraceSec : 180);
  setChecked('setting-vary-content', S.varyContent !== false);
  setChecked('setting-vary-images', S.varyImages !== false);
  setChecked('setting-randomize-links', S.randomizeLinks !== false);
  setChecked('setting-enable-warmup', S.enableWarmup || false);
  setValue('setting-warmup-runs', S.warmupRuns !== undefined ? S.warmupRuns : 5);
  setValue('setting-cooldown-hours', S.rateLimitCooldownHours !== undefined ? S.rateLimitCooldownHours : 4);
  { const el = document.getElementById('setting-default-pace'); if (el) el.value = ['safe', 'normal', 'fast', 'turbo', 'instant'].includes(S.defaultPace) ? S.defaultPace : 'normal'; }
  try { highlightSpeed(S.speedMode || 'normal'); } catch {}
}

// Attach a hover "?" help badge to every Settings label explaining what the control does and how to
// use it. Data-driven (one place to edit), idempotent, and runs once on load. Matching is by a unique
// substring of each label's text, in order, skipping labels that already have a badge.
// NOTE: entries are matched by a substring of each Settings label's text; labels removed in the speed-preset
// refactor (Parallel, Wait Between Cycles, Stagger, Max posts/cycle, Delay Between Groups, Humanized timing,
// Feed-browse, Re-read, Pause-before-comment, Max Cycles, Auto-Delete, Loop Campaign, First-comment delay,
// Stagger account start) were pruned — they no longer exist in index.html, so their help entries were dead no-ops.
const SETTINGS_HELP = [
  ['Comment with Post Image', '<b>Comment with Post Image.</b> Also attaches the post\'s image to its first comment. Only affects posts that have a comment configured.'],
  ['Hide Browser', '<b>Hide Browser.</b> Runs the automation browser off-screen (default) — invisible to you, but Facebook still treats it as active so posting works. Turn OFF to watch it run (it opens in the background and won\'t steal focus).'],
  ['Enable Remote Access', '<b>Remote Access / Dashboard Tunnel.</b> Starts a Cloudflare tunnel so you can monitor and control the app from another device. Takes effect on the next app restart.'],
  ['Resume interrupted run', '<b>Resume on startup.</b> If the app closed mid-run (crash or shutdown), it automatically continues the campaign the next time it launches.'],
  ['Launch app automatically', '<b>Launch on Windows startup.</b> Registers the app as a Windows login item so it opens automatically when you sign in.'],
  ['Daily post cap', '<b>Daily cap per account.</b> Maximum posts per account per day. 0 = no cap. Use a low number (5–10) for new or sensitive accounts to stay under Facebook\'s radar.'],
  ['Vary captions', '<b>Spintax variation.</b> Resolves {option1|option2|option3} blocks in captions/comments randomly per post, so every group gets slightly different text. The #1 defense against duplicate-content flags.'],
  ['Vary image per group', '<b>Vary image per group.</b> Applies an invisible per-group pixel tweak so each uploaded image has a unique fingerprint, reducing duplicate-media detection.'],
  ['Randomize links', '<b>Randomize links.</b> Appends a unique tracking parameter to links in the first comment, so the same URL isn\'t posted identically everywhere (harder to flag as repetitive spam).'],
  ['Warm up new accounts', '<b>Warm up new accounts.</b> For its first few runs a new account browses and scrolls the home feed, visits 1–2 of its own groups, and <b>likes a couple of posts</b> before it posts — so it builds a real-user engagement fingerprint instead of only ever opening composers and posting.'],
  ['Warm-up runs', '<b>Warm-up runs.</b> How many successful runs an account is treated as "new" and warmed up before posting. Only used when "Warm up new accounts" is on.'],
  ['Rate-limit cool-down', '<b>Rate-limit cool-down.</b> Base hours a rate-limited account rests before being retried. It doubles with each repeat strike (capped at 48h) to back off safely.'],
  ['Default account pace', '<b>Default account pace.</b> The fleet fallback for any account that has no individual pace set (you can override per account on the Accounts tab or in Quick Setup). <b>🐢 Safe</b> = 2× the per-post gaps + full human typing/dwells (best for new accounts); <b>⚖️ Normal</b> = the tempo from the timings above; <b>⚡ Fast</b> = half the gaps + instant typing (trusted accounts); <b>🚀 Turbo</b> = quarter the gaps + power-user typing; <b>⚡ Instant</b> = max speed, everything pasted with 0–7s gaps (warmed accounts + proxies only — highest ban risk). <b>Turbo/Instant here apply to your WHOLE fleet.</b> The post→comment anti-spam gap always stays randomized.'],
];

function injectSettingsHelp() {
  const form = document.querySelector('.settings-form');
  if (!form || form.dataset.helpInjected) return;
  const labels = Array.from(form.querySelectorAll('label'));
  const makeIcon = (html) => {
    const w = document.createElement('span'); w.className = 'help';
    const q = document.createElement('span'); q.className = 'help-q'; q.textContent = '?';
    q.tabIndex = 0; q.setAttribute('role', 'button'); q.setAttribute('aria-label', 'Help');
    const tip = document.createElement('span'); tip.className = 'help-tip'; tip.innerHTML = html;
    w.appendChild(q); w.appendChild(tip);
    // Decide open-up vs open-down at hover time (the panel scrolls / may be hidden at load): if the
    // badge is in the lower part of the viewport, flip the tooltip above so it never clips.
    const setDir = () => { const r = w.getBoundingClientRect(); w.classList.toggle('help-up', r.top > window.innerHeight * 0.55); };
    w.addEventListener('mouseenter', setDir); q.addEventListener('focus', setDir);
    return w;
  };
  for (const [key, html] of SETTINGS_HELP) {
    const lab = labels.find((l) => !l.querySelector('.help') && (l.textContent || '').includes(key));
    if (lab) lab.appendChild(makeIcon(html));
  }
  form.dataset.helpInjected = '1';
}

// ---- One-click pacing presets (Fast / Normal / Slow) -------------------------------------------
// Each preset fills EVERY timing range at once so the operator never tunes numbers by hand. Normal =
// the verified defaults; Slow = safest (most human, lowest spam risk); Fast = quickest STILL-SAFE
// pacing (group delay never goes below the engine's 120s floor). The operator can fine-tune after.
const SPEED_PRESETS = {
  // INSTANT = max speed: everything PASTED + 0–7s between actions (the worker hard-clamps the gaps to rand(0,7000)
  // with a ~1.5s/4s anti-spam floor regardless of these numbers). For warmed accounts on good proxies only — fast
  // post→link is a spam tell.
  instant: { waitIntervalMin: 0, waitIntervalMax: 3, accountDelayMin: 0, accountDelayMax: 0, groupDelayMin: 0, groupDelayMax: 7, commentDelayMin: 0, commentDelayMax: 7, pageScrollDwellSecMin: 0, pageScrollDwellSecMax: 0, prePublishDwellSecMin: 0, prePublishDwellSecMax: 0, commentDwellSecMin: 0, commentDwellSecMax: 0, composerOpenInitialDelayMs: 800 },
  // TURBO = power-user / "super experienced user": instant typing + skipped reading dwells (speedMode triggers
  // the fast path in the worker) + the smallest still-nonzero gaps (a real fast human, not a 0ms bot).
  turbo:  { waitIntervalMin: 10,  waitIntervalMax: 20,  accountDelayMin: 0, accountDelayMax: 1, groupDelayMin: 20,  groupDelayMax: 45,  commentDelayMin: 8,   commentDelayMax: 20,  pageScrollDwellSecMin: 0, pageScrollDwellSecMax: 0,  prePublishDwellSecMin: 0, prePublishDwellSecMax: 1, commentDwellSecMin: 0, commentDwellSecMax: 1, composerOpenInitialDelayMs: 800 },
  fast:   { waitIntervalMin: 45,  waitIntervalMax: 90,  accountDelayMin: 1, accountDelayMax: 2, groupDelayMin: 120, groupDelayMax: 180, commentDelayMin: 45,  commentDelayMax: 90,  pageScrollDwellSecMin: 2, pageScrollDwellSecMax: 6,  prePublishDwellSecMin: 1, prePublishDwellSecMax: 4,  commentDwellSecMin: 1, commentDwellSecMax: 3, composerOpenInitialDelayMs: 1000 },
  normal: { waitIntervalMin: 90,  waitIntervalMax: 180, accountDelayMin: 1, accountDelayMax: 4, groupDelayMin: 120, groupDelayMax: 300, commentDelayMin: 60,  commentDelayMax: 180, pageScrollDwellSecMin: 3, pageScrollDwellSecMax: 15, prePublishDwellSecMin: 3, prePublishDwellSecMax: 8,  commentDwellSecMin: 1, commentDwellSecMax: 4, composerOpenInitialDelayMs: 1500 },
  slow:   { waitIntervalMin: 180, waitIntervalMax: 360, accountDelayMin: 3, accountDelayMax: 8, groupDelayMin: 300, groupDelayMax: 600, commentDelayMin: 120, commentDelayMax: 300, pageScrollDwellSecMin: 8, pageScrollDwellSecMax: 25, prePublishDwellSecMin: 5, prePublishDwellSecMax: 12, commentDwellSecMin: 3, commentDwellSecMax: 8, composerOpenInitialDelayMs: 2500 },
};
function highlightSpeed(mode) {
  document.querySelectorAll('.speed-btn').forEach((b) => b.classList.toggle('active', b.dataset.speed === mode));
}
function applySpeedPreset(mode) {
  const p = SPEED_PRESETS[mode];
  if (!p) return;
  // Write the preset's timing ranges + speed mode DIRECTLY to settings — the raw per-number inputs are gone now,
  // so the preset IS the timing control. saveSettings preserves these via its `...appData.settings` spread.
  if (appData && appData.settings) { Object.assign(appData.settings, p); appData.settings.speedMode = mode; }
  highlightSpeed(mode);
  saveSettings(); // one-click: apply the preset immediately
}
function wireSpeedButtons() {
  document.querySelectorAll('.speed-btn').forEach((b) => {
    if (b.dataset.wired) return; b.dataset.wired = '1';
    b.addEventListener('click', () => applySpeedPreset(b.dataset.speed));
  });
  highlightSpeed((appData && appData.settings && appData.settings.speedMode) || 'normal');
}
async function autoDetectProxyGeo(btn) {
  const orig = btn && btn.textContent;
  try {
    if (btn) { btn.disabled = true; btn.textContent = '🌍 Detecting…'; }
    showNotification('Detecting each proxy\'s region (routing through them — a few seconds each)…', 'info');
    const r = await window.electronAPI.invoke('detect-proxy-geo');
    if (r && r.success) {
      showNotification(`Proxy geo: ${r.detected} detected → applied to ${r.applied} account(s)${r.failed ? `, ${r.failed} failed` : ''}.`, (r.failed && !r.detected) ? 'error' : 'success');
      await loadData(); // refresh accounts (per-account tz/locale) + settings
      { const el = document.getElementById('setting-proxy-timezone'); if (el) el.value = (appData.settings || {}).proxyTimezone || ''; }
      { const el = document.getElementById('setting-proxy-locale'); if (el) el.value = (appData.settings || {}).proxyLocale || ''; }
    } else {
      showNotification('Auto-detect failed: ' + ((r && r.error) || 'unknown'), 'error');
    }
  } catch (e) { showNotification('Auto-detect failed: ' + ((e && e.message) || e), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig || '🌍 Auto-detect from my proxies'; } }
}
function initSettingsUI() {
  try { injectSettingsHelp(); } catch {}
  try { wireSpeedButtons(); } catch {}
  // Dynamic up/down flip for ALL help badges (Settings + dynamically-rendered account cards) so a
  // tooltip low in a scroll area opens upward instead of clipping. One delegated listener.
  try {
    if (!document.body.dataset.helpFlipWired) {
      document.body.dataset.helpFlipWired = '1';
      document.addEventListener('mouseover', (e) => {
        const w = e.target && e.target.closest && e.target.closest('.help');
        if (!w) return;
        const r = w.getBoundingClientRect();
        w.classList.toggle('help-up', r.top > window.innerHeight * 0.55);
      });
    }
  } catch {}
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSettingsUI);
  else initSettingsUI();
}

async function saveSettings() {
  // Blank/invalid numeric inputs parse to NaN; fall back to sane defaults so a stray
  // NaN can't, e.g., silently disable the inter-group delay and trigger rate-limits.
  // GUARDED readers: a missing/renamed control must NOT throw (a raw getElementById(id).value/.checked would abort
  // the WHOLE save so NOTHING persists) and must NOT silently reset its setting — so each falls back to the CURRENT
  // saved value (S0), and a blank/NaN number falls back to its default. Robust even if the form markup drifts.
  const S0 = (appData && appData.settings) || {};
  const chk = (id, key) => { const el = document.getElementById(id); return el ? !!el.checked : !!S0[key]; };
  const intOr = (id, key, def) => { const el = document.getElementById(id); const v = el ? parseInt(el.value, 10) : NaN; return Number.isFinite(v) ? v : (S0[key] !== undefined ? S0[key] : def); };
  const valOr = (id, key, def) => { const el = document.getElementById(id); return el ? el.value : (S0[key] !== undefined ? S0[key] : def); };
  const settings = {
    ...appData.settings, // preserve settings that have no form input
    commentWithImage: chk('setting-comment-with-image', 'commentWithImage'),
    hideBrowser: chk('setting-hide-browser', 'hideBrowser'),
    enableTunnel: chk('setting-enable-tunnel', 'enableTunnel'),
    moderationEnabled: chk('setting-moderation-enabled', 'moderationEnabled'),
    moderationDryRun: chk('setting-moderation-dry-run', 'moderationDryRun'),
    resumeOnStartup: chk('setting-resume-on-startup', 'resumeOnStartup'),
    launchOnStartup: chk('setting-launch-on-startup', 'launchOnStartup'),
    autoStartDaily: chk('setting-auto-start-daily', 'autoStartDaily'), // applied as a Windows task below

    dailyCap: intOr('setting-daily-cap', 'dailyCap', 0),
    reserveAccounts: intOr('setting-reserve-accounts', 'reserveAccounts', 0), // engine clamps 0..(posters-1); 0 = standby-only reserves
    reserveMaxJobsPerCycle: Math.max(1, Math.min(5, intOr('setting-reserve-max-jobs', 'reserveMaxJobsPerCycle', 1))), // #5: drops one reserve may cover per cycle
    scheduleMode: S0.scheduleMode || 'daily', // preserve the engine's actual mode (don't clobber 'continuous')
    dailyPostTime: valOr('setting-daily-post-time', 'dailyPostTime', '09:00') || '09:00',
    cyclesPerDay: Math.max(1, Math.min(8, intOr('setting-cycles-per-day', 'cyclesPerDay', 1))), // cycles per run (engine clamps 1..8 too)
    tabsPerBrowser: Math.max(1, Math.min(4, intOr('setting-tabs-per-browser', 'tabsPerBrowser', 1))), // paced multi-tab: pre-load the next group(s) while posting (1 = classic; engine clamps 1..4 too)
    postThenComment: chk('setting-post-then-comment', 'postThenComment'), // two-phase: post every group first, then comment all (absorbs the post→comment wait; posts land before any comment)
    // "Time between cycles" — an explicit override of the inter-cycle wait (minutes). 0/blank = use the speed preset's
    // timing. Kept SEPARATE from waitIntervalMin/Max so a speed preset and this control never clobber each other.
    cycleGapMin: (() => { const el = document.getElementById('setting-cycle-gap-min'); return (el && el.value !== '') ? Math.max(5, Math.min(720, parseInt(el.value, 10) || 0)) : 0; })(),
    proxyTimezone: (valOr('setting-proxy-timezone', 'proxyTimezone', '') || '').trim(), // IANA tz for PROXIED accounts (applyProxyGeo); '' = no override
    proxyLocale: (valOr('setting-proxy-locale', 'proxyLocale', '') || '').trim(),       // BCP-47 locale for PROXIED accounts; '' = no override
    defaultPace: (['safe', 'normal', 'fast', 'turbo', 'instant'].includes(valOr('setting-default-pace', 'defaultPace', 'normal')) ? valOr('setting-default-pace', 'defaultPace', 'normal') : 'normal'),
    repostEnabled: chk('setting-repost-enabled', 'repostEnabled'),
    repostGraceSec: intOr('setting-repost-grace-sec', 'repostGraceSec', 180),
    varyContent: chk('setting-vary-content', 'varyContent'),
    varyImages: chk('setting-vary-images', 'varyImages'),
    randomizeLinks: chk('setting-randomize-links', 'randomizeLinks'),
    enableWarmup: chk('setting-enable-warmup', 'enableWarmup'),
    warmupRuns: intOr('setting-warmup-runs', 'warmupRuns', 5),
    rateLimitCooldownHours: intOr('setting-cooldown-hours', 'rateLimitCooldownHours', 4),
  };
  // Purge the DEAD legacy single-value timing keys (superseded by the *Min/*Max ranges the loop actually
  // reads). They could otherwise ride along via the spread above + a stale data.json and clutter the config.
  delete settings.waitInterval; delete settings.accountDelay; delete settings.groupDelay;

  // 🕒 autoStartDaily is a Windows scheduled-task side-effect — register/remove it FIRST, then persist the
  // ACTUAL applied state so a failed registration can't leave the flag true with no task installed. Only touch
  // the task when ENABLING, or CLEARING a previously-set one — so unrelated saves (incl. one-click speed presets)
  // never spawn a process or surface a spurious error toast.
  const autoWanted = !!settings.autoStartDaily;
  const autoPrev = !!(appData.settings && appData.settings.autoStartDaily);
  if (autoWanted || autoPrev) {
    try {
      const ar = await window.electronAPI.setAutostart(autoWanted, settings.dailyPostTime || '09:00');
      if (ar && ar.success === false) { settings.autoStartDaily = false; if (autoWanted) showNotification('Couldn\'t set the daily auto-start task: ' + (ar.error || 'unknown'), 'error'); }
    } catch (e) { settings.autoStartDaily = false; if (autoWanted) showNotification('Couldn\'t set the daily auto-start task: ' + ((e && e.message) || e), 'error'); }
  }

  const result = await window.electronAPI.saveSettings(settings);

  if (result.success) {
    appData.settings = settings;
    showNotification('Settings saved successfully!', 'success');
  } else {
    showNotification('Failed to save settings: ' + result.error, 'error');
  }
}

// Proxies
// Parse ONE pasted proxy line in any common format → { scheme, host, port, user, pass } (or null if unparseable).
// Accepts: host:port | host:port:user:pass | user:pass@host:port | scheme://<any of those>. Scheme defaults to http.
function normalizeProxyLine(line) {
  let s = String(line || '').trim();
  if (!s) return null;
  let scheme = 'http';
  const m = s.match(/^([a-z0-9]+):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  let user = '', pass = '', host = '', port = '';
  if (s.includes('@')) {                       // user:pass@host:port
    const at = s.split('@'); const cred = (at[0] || '').split(':'); const hp = (at[1] || '').split(':');
    user = cred[0] || ''; pass = cred[1] || ''; host = hp[0] || ''; port = hp[1] || '';
  } else {                                     // host:port[:user:pass]
    const p = s.split(':'); host = p[0] || ''; port = p[1] || ''; user = p[2] || ''; pass = p[3] || '';
  }
  const portNum = parseInt(port, 10);
  if (!host || !Number.isFinite(portNum) || portNum < 1 || portNum > 65535) return null;
  return { scheme, host, port: String(portNum), user, pass };
}

// "Add all to table" — paste a whole list, parse each line, append rows (scheme preserved). Still needs 💾 Save Proxies.
function addProxiesBulk() {
  const ta = document.getElementById('proxies-bulk');
  if (!ta) return;
  let added = 0, bad = 0;
  for (const line of (ta.value || '').split('\n')) {
    if (!line.trim()) continue;
    const p = normalizeProxyLine(line);
    if (!p) { bad++; continue; }
    addProxyRow(document.querySelectorAll('#proxies-table-body tr').length + 1, p.host, p.port, p.user, p.pass, p.scheme);
    added++;
  }
  ta.value = '';
  if (added) { const es = document.getElementById('proxies-empty-state'); if (es) es.style.display = 'none'; }
  showNotification(`${added} proxy(ies) added to the table${bad ? ` — ${bad} unreadable line(s) skipped` : ''}. Tick Enable + click 💾 Save Proxies to keep them.`, added ? 'success' : 'error');
}

function parseProxyStringTable(proxyStr) {
  if (!proxyStr) return {};

  let remainder = proxyStr, scheme = 'http';
  if (proxyStr.includes('://')) {
    scheme = (proxyStr.split('://')[0] || 'http').toLowerCase();
    remainder = proxyStr.split('://')[1];
  }

  const parts = remainder.split(':');
  return {
    scheme,
    ip: parts[0] || '',
    port: parts[1] || '',
    user: parts[2] || '',
    pass: parts.slice(3).join(':') // password may contain ':' — keep the whole remainder (matches the backend's greedy parseProxy) so the load→edit→save round-trip is lossless
  };
}

function addProxyRow(id, ip, port, user, pass, scheme) {
  const tbody = document.getElementById('proxies-table-body');
  const emptyState = document.getElementById('proxies-empty-state');

  if (emptyState) emptyState.style.display = 'none';

  const tr = document.createElement('tr');
  tr.style.borderBottom = '1px solid #e5e7eb';
  tr.dataset.scheme = (scheme && String(scheme).trim().toLowerCase()) || 'http'; // PRESERVE the proxy scheme (your proxies are http) — Save uses this instead of force-converting to socks5

  tr.innerHTML = `
    <td style="padding: 12px 15px;">${escapeHtml(id)}</td>
    <td style="padding: 12px 15px;">${escapeHtml(ip)}</td>
    <td style="padding: 12px 15px;">${escapeHtml(port)}</td>
    <td style="padding: 12px 15px;">${escapeHtml(user)}</td>
    <td style="padding: 12px 15px;">${escapeHtml(pass)}</td>
    <td style="padding: 12px 15px;">
      <button class="icon-btn" onclick="removeProxyRow(this)" style="color: #ef4444; border-color: #ef4444;">🗑️</button>
    </td>
  `;

  tbody.appendChild(tr);
}

// Remove a proxy row safely: confirm for populated rows (changes only persist on Save Proxies, so a
// mis-click + Save would silently drop it), and restore the empty-state when the last row is removed.
async function removeProxyRow(btn) {
  const tr = btn && btn.closest('tr');
  if (!tr) return;
  const cols = tr.querySelectorAll('td');
  const populated = cols[1] && (cols[1].textContent || '').trim();
  if (populated && !(await themedConfirm('Remove this proxy from the list? It takes effect when you click Save Proxies.', { title: 'Remove proxy', confirmText: 'Remove', danger: true }))) return;
  tr.remove();
  const tbody = document.getElementById('proxies-table-body');
  const empty = document.getElementById('proxies-empty-state');
  if (empty && tbody && tbody.querySelectorAll('tr').length === 0) empty.style.display = 'block';
}

async function loadProxies() {
  const result = await window.electronAPI.invoke('get-proxies');
  if (result.success) {
    document.getElementById('proxies-enabled').checked = result.useProxies;

    // Clear existing
    document.getElementById('proxies-table-body').innerHTML = '';

    // Populate
    if (result.proxies && result.proxies.length > 0) {
      result.proxies.forEach((p, index) => {
        const parts = parseProxyStringTable(p);
        // Backend stores proxies as plain 'scheme://ip:port:user:pass' strings (no custom ID), so the row # is just the 1-based index.
        addProxyRow(index + 1, parts.ip, parts.port, parts.user, parts.pass, parts.scheme);
      });
    } else {
      document.getElementById('proxies-empty-state').style.display = 'block';
    }
  }
}

async function saveProxies() {
  const enabled = document.getElementById('proxies-enabled').checked;
  const rows = document.querySelectorAll('#proxies-table-body tr');
  const proxies = [];

  let invalid = 0;
  rows.forEach(row => {
    const cols = row.querySelectorAll('td');
    // 0: ID, 1: IP, 2: Port, 3: User, 4: Pass
    const ip = (cols[1].textContent || '').trim();
    const port = (cols[2].textContent || '').trim();
    const user = (cols[3].textContent || '').trim();
    const pass = (cols[4].textContent || '').trim();

    if (!ip && !port && !user && !pass) return; // blank row — skip
    const portNum = parseInt(port, 10);
    if (!ip || !Number.isFinite(portNum) || portNum < 1 || portNum > 65535) { invalid++; return; }
    // Reconstruct with the row's OWN scheme (http/https/socks5) — NOT a hardcoded socks5, which used to silently
    // break http proxies on every save. New manual rows default to http (the common case).
    const scheme = (row.dataset && row.dataset.scheme) || 'http';
    let str = `${scheme}://${ip}:${portNum}`;
    if (user && pass) str += `:${user}:${pass}`;
    proxies.push(str);
  });
  if (invalid > 0) showNotification(`${invalid} proxy row(s) invalid (need host + port 1-65535) — skipped`, 'error');

  // Save list
  const saveList = await window.electronAPI.invoke('save-proxies', proxies);
  // Save toggle
  const saveToggle = await window.electronAPI.invoke('toggle-proxies', enabled);

  if (saveList.success && saveToggle.success) {
    showNotification('Proxies saved successfully!', 'success');
    appData.useProxies = enabled; // canonical top-level field (what the wizard's Review/proxy-readiness reads)
    appData.proxies = proxies;
  } else {
    showNotification('Failed to save proxies.', 'error');
  }
}

// Modal Helpers
function openModal(modalId) {
  console.log('=== OPENING MODAL ===');
  console.log('Modal ID:', modalId);
  const modal = document.getElementById(modalId);
  console.log('Modal element:', modal);
  if (modal) {
    // FORCE RESET any inline styles that might have been hiding it
    modal.style.display = 'flex';
    modal.style.removeProperty('display'); // Or just remove it to let CSS take over if 'flex' causes issues, but 'flex' is safer given the previous fix
    modal.style.display = 'flex'; // Explicitly set it

    // Add active class
    modal.classList.add('active');
    console.log('Modal classList after adding active:', modal.classList);
  } else {
    console.error('Modal not found!');
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    setTimeout(() => {
      if (!modal.classList.contains('active')) {
        modal.style.display = 'none';
      }
    }, 200); // Wait for transition
  }
}

// Notification Helper
// Themed replacement for the native confirm() — returns a Promise<boolean>. On-theme, keyboard-friendly
// (Enter = confirm, Esc/backdrop = cancel), with an optional danger style for destructive actions.
function themedConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const { title = 'Please confirm', confirmText = 'Confirm', cancelText = 'Cancel', danger = false, requireText = null } = opts;
    const needType = requireText != null && String(requireText).length > 0;
    const ov = document.createElement('div');
    ov.className = 'tc-overlay';
    const safe = escapeHtml(String(message == null ? '' : message)).replace(/\n/g, '<br>');
    const inputHtml = needType ? `<input class="tc-input" type="text" autocomplete="off" spellcheck="false" placeholder="Type ${escapeAttr(String(requireText))} to confirm">` : '';
    ov.innerHTML = `<div class="tc-modal" role="alertdialog" aria-modal="true">
        <div class="tc-title">${danger ? '⚠️ ' : ''}${escapeHtml(title)}</div>
        <div class="tc-msg">${safe}</div>
        ${inputHtml}
        <div class="tc-actions">
          <button class="tc-btn tc-cancel">${escapeHtml(cancelText)}</button>
          <button class="tc-btn ${danger ? 'tc-danger' : 'tc-confirm'}"${needType ? ' disabled' : ''}>${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    const okBtn = ov.querySelector('.tc-danger, .tc-confirm');
    const input = ov.querySelector('.tc-input');
    const matched = () => !needType || (input && input.value.trim().toLowerCase() === String(requireText).trim().toLowerCase());
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter') { e.preventDefault(); if (matched()) done(true); } };
    const done = (v) => { try { document.removeEventListener('keydown', onKey, true); } catch {} ov.remove(); resolve(v); };
    ov.querySelector('.tc-cancel').onclick = () => done(false);
    okBtn.onclick = () => { if (matched()) done(true); };
    if (input) input.addEventListener('input', () => { okBtn.disabled = !matched(); });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    setTimeout(() => { (input || okBtn).focus(); }, 30);
  });
}

// Themed multi-choice dialog (reuses the tc-* styling). Returns the chosen option's `key`, or null on cancel /
// Esc / backdrop. `choices` = [{ key, label, danger? }]. Used by Stop ("resume later / start over / cancel").
function themedChoice(message, opts = {}) {
  return new Promise((resolve) => {
    const { title = 'Choose', choices = [], cancelText = 'Cancel' } = opts;
    const ov = document.createElement('div');
    ov.className = 'tc-overlay';
    const safe = escapeHtml(String(message == null ? '' : message)).replace(/\n/g, '<br>');
    const btns = choices.map((c) => `<button class="tc-btn ${c.danger ? 'tc-danger' : 'tc-confirm'}" data-k="${escapeAttr(c.key)}">${escapeHtml(c.label)}</button>`).join('');
    ov.innerHTML = `<div class="tc-modal" role="alertdialog" aria-modal="true">
        <div class="tc-title">${escapeHtml(title)}</div>
        <div class="tc-msg">${safe}</div>
        <div class="tc-actions" style="flex-wrap:wrap;">
          <button class="tc-btn tc-cancel" data-k="">${escapeHtml(cancelText)}</button>
          ${btns}
        </div>
      </div>`;
    const done = (v) => { try { document.removeEventListener('keydown', onKey, true); } catch {} ov.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    ov.querySelectorAll('.tc-btn').forEach((b) => { b.onclick = () => { const k = b.getAttribute('data-k'); done(k || null); }; });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    setTimeout(() => { const f = ov.querySelector('.tc-confirm, .tc-danger'); if (f) f.focus(); }, 30);
  });
}

// Themed TEXT-INPUT dialog (reuses tc-* styling). Returns the typed string (possibly empty) on confirm, or null on
// cancel / Esc / backdrop. window.prompt() returns null in this Electron renderer (contextIsolation), so EVERY
// text-entry must route through this. opts: { title, confirmText, cancelText, placeholder, defaultValue, allowEmpty }.
function themedPrompt(message, opts = {}) {
  return new Promise((resolve) => {
    const { title = 'Enter a value', confirmText = 'OK', cancelText = 'Cancel', placeholder = '', defaultValue = '', allowEmpty = true } = opts;
    const ov = document.createElement('div');
    ov.className = 'tc-overlay';
    const safe = escapeHtml(String(message == null ? '' : message)).replace(/\n/g, '<br>');
    ov.innerHTML = `<div class="tc-modal" role="alertdialog" aria-modal="true">
        <div class="tc-title">${escapeHtml(title)}</div>
        <div class="tc-msg">${safe}</div>
        <input class="tc-input" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeAttr(String(placeholder))}" value="${escapeAttr(String(defaultValue))}">
        <div class="tc-actions">
          <button class="tc-btn tc-cancel">${escapeHtml(cancelText)}</button>
          <button class="tc-btn tc-confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    const input = ov.querySelector('.tc-input');
    const okBtn = ov.querySelector('.tc-confirm');
    const ok = () => { const v = input ? input.value : ''; if (!allowEmpty && !v.trim()) return; done(v); };
    const done = (v) => { try { document.removeEventListener('keydown', onKey, true); } catch {} ov.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } else if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    ov.querySelector('.tc-cancel').onclick = () => done(null);
    okBtn.onclick = ok;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    setTimeout(() => { if (input) { input.focus(); input.select(); } }, 30);
  });
}

function showNotification(message, type = 'info') {
  // Check if notification container exists, create if not
  let container = document.getElementById('notification-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'notification-container';
    document.body.appendChild(container);
  }

  // Create notification element
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  notification.title = 'Click to dismiss';
  notification.style.cursor = 'pointer';

  // Add to container
  container.appendChild(notification);

  // Trigger animation
  setTimeout(() => notification.classList.add('show'), 10);

  // M4-07: errors stay long enough to actually read (10s) — a critical failure must not vanish in
  // 3s — and ANY notification can be dismissed early by clicking it.
  const dismiss = () => {
    if (notification._dismissed) return;
    notification._dismissed = true;
    notification.classList.remove('show');
    setTimeout(() => { notification.remove(); if (container.childNodes.length === 0) container.remove(); }, 300);
  };
  notification.addEventListener('click', dismiss);
  setTimeout(dismiss, type === 'error' ? 10000 : 3000);

  // Also log if automation view is active
  if (document.getElementById('automation-view').classList.contains('active')) {
    addLog(`[${type.toUpperCase()}] ${message}\n`);
  }
}

// Utility Functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Escape a value for use INSIDE a double-quoted HTML attribute (e.g. onclick="fn(...)").
// escapeHtml() does NOT escape double quotes, so escapeHtml(JSON.stringify(name)) leaves the
// JSON quotes literal and they terminate the attribute early — breaking the handler. This one
// escapes " → &quot; so an inline onclick built from JSON.stringify(name) parses correctly.
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
