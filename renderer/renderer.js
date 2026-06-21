let appData = {
  posts: [],
  groups: [],
  accounts: [],
  settings: {
    parallelAccounts: 3,
    waitInterval: 60,
    accountDelay: 1,
    postsPerGroup: 15,
    groupDelay: 60,
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
let currentLoginAccount = null;
let appLimits = { maxGroups: 10, maxAccounts: 5 }; // Default limits

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  initializeEventListeners();
  updateDashboard();
  checkAutomationStatus();

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

  // 4. Listen for data updates (Instant Sync) — always active, not gated on remote-URL elements
  if (window.electronAPI.onDataUpdated) {
    window.electronAPI.onDataUpdated(async () => {
      console.log('Data updated externally, refreshing UI...');
      await loadData();
      updateDashboard(); // Update counters
      const isActive = (id) => { const el = document.getElementById(id); return el && el.classList.contains('active'); };
      if (isActive('posts-view') && typeof renderPosts === 'function') renderPosts();
      if (isActive('accounts-view') && typeof renderAccounts === 'function') renderAccounts();
      if (isActive('groups-view') && typeof renderGroups === 'function') renderGroups();
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

  // Load License Info
  try {
    const info = await window.electronAPI.invoke('get-license-info');
    if (info) {
      // Update Limits
      if (info.maxGroups) appLimits.maxGroups = info.maxGroups;
      if (info.maxAccounts) appLimits.maxAccounts = info.maxAccounts;

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
        limitsDiv.innerHTML = `
          <div>👥 Max Groups: ${appLimits.maxGroups}</div>
          <div>🔐 Max Accounts: ${appLimits.maxAccounts}</div>
        `;
      }
    }
  } catch (e) { console.error('License info error', e); }

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
  });

  // M2-03: live attention — when the run flags an account (rate-limited, checkpoint, needs login,
  // etc.), notify the operator and refresh so the account's status badge updates without a reload.
  if (window.electronAPI.onAccountAttention) {
    window.electronAPI.onAccountAttention(async (info) => {
      const name = (info && info.name) || 'An account';
      const flag = (info && info.flag) || 'attention';
      const MSG = {
        rate_limited: 'rate-limited by Facebook — cooling down',
        needs_login: 'session expired — needs re-login',
        needs_verification: 'Facebook wants a human/identity check',
        account_disabled: 'disabled/restricted by Facebook',
        likely_blocked: 'posted nothing (likely blocked) — check it',
        proxy_invalid: 'proxy is invalid — fix it in Accounts',
      };
      showNotification(`⚠️ ${name}: ${MSG[flag] || flag}`, 'error');
      try { await loadData(); } catch {}
      try { highlightAccountCard(name); } catch {}
    });
  }

  // End-of-run summary: render a persistent roll-up the operator can read at a glance.
  window.electronAPI.onAutomationSummary((summary) => {
    lastRunSummary = summary;
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
    renderPosts();
    renderGroups();
    renderAccounts();
    loadSettings();
    await loadProxies(); // Load proxies
    updateDashboard();
  }
}

// Save data to main process
async function saveData() {
  await window.electronAPI.saveData(appData);
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
  document.getElementById('btn-start-automation').addEventListener('click', startAutomation);
  document.getElementById('btn-stop-automation').addEventListener('click', stopAutomation);
  { const rb = document.getElementById('btn-reset-rotation'); if (rb) rb.addEventListener('click', resetRotation); }
  document.getElementById('btn-pause-automation').addEventListener('click', togglePauseAutomation);
  const finishBtn = document.getElementById('btn-finish-automation');
  if (finishBtn) finishBtn.addEventListener('click', finishAutomation);

  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-save-proxies').addEventListener('click', saveProxies);

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

      addProxyRow(id || 'Auto', ip, port, user, pass);

      // Clear inputs
      document.getElementById('proxy-id').value = '';
      document.getElementById('proxy-ip').value = '';
      document.getElementById('proxy-port').value = '';
      document.getElementById('proxy-user').value = '';
      document.getElementById('proxy-pass').value = '';
    });
  }

  // Modal close buttons
  document.querySelectorAll('.modal-close, [data-dismiss="modal"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal) closeModal(modal.id);
    });
  });

  // Close modal on outside click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal.id);
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
    const tip = escapeHtml(a.lastMessage || a.status || '');
    return `<span title="${tip}" style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.05);border-radius:8px;padding:3px 8px;font-size:11px;color:#d1d5db;white-space:nowrap;">
      <span style="width:7px;height:7px;border-radius:50%;background:${dot};flex-shrink:0;"></span>${label}
    </span>`;
  }).join('');
}

// Posts Management
function renderPosts() {
  const container = document.getElementById('posts-container');

  if (appData.posts.length === 0) {
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

  container.innerHTML = appData.posts.map(post => {
    // Support both old single imagePath and new imagePaths array
    const allPaths = post.imagePaths || (post.imagePath ? [post.imagePath] : []);
    const _rawFirst = allPaths[0] || '';
    const firstImage = _rawFirst ? (/^https?:/i.test(_rawFirst) ? _rawFirst : 'file:///' + _rawFirst.replace(/\\/g, '/')) : '';
    const imageCount = allPaths.length;
    const hasImages = imageCount > 0;
    const countBadge = imageCount > 1 ? `<span style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.7);color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;">📷 ${imageCount}</span>` : '';
    
    // Build image section or text-only placeholder
    const imageSection = hasImages
      ? `<div style="position:relative;">
          <img src="${firstImage}" alt="Post" class="post-image" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22300%22 height=%22200%22><rect fill=%22%23e5e7eb%22 width=%22300%22 height=%22200%22/><text x=%2250%%22 y=%2250%%22 font-family=%22Arial%22 font-size=%2218%22 fill=%22%236b7280%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22>Image</text></svg>'">
          ${countBadge}
        </div>`
      : `<div style="background:linear-gradient(135deg,#1e293b,#334155);padding:24px 16px;display:flex;align-items:center;justify-content:center;min-height:100px;border-radius:12px 12px 0 0;">
          <span style="font-size:28px;">📝</span>
          <span style="color:#94a3b8;font-size:13px;margin-left:10px;font-weight:500;">Text Only</span>
        </div>`;

    const commentImageBadge = post.commentImagePath ? '<span class="post-badge">🖼️ Comment Image</span>' : '';

    return `
    <div class="post-card">
      ${imageSection}
      <div class="post-content">
        <p class="post-caption">${escapeHtml(post.caption)}</p>
        <div class="post-meta">
          ${post.comment ? '<span class="post-badge">💬 Has Comment</span>' : ''}
          ${commentImageBadge}
          <div class="post-actions">
            <button class="icon-btn" onclick="openEditPostModal('${post.id}')" title="Edit">✏️</button>
            <button class="icon-btn" onclick="deletePost('${post.id}')" title="Delete">🗑️</button>
          </div>
        </div>
      </div>
    </div>
  `}).join('');
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

function openAddPostModal() {
  selectedImages = [];
  selectedCommentImage = null;
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
    images: selectedImages.map(img => ({ data: img.data, ext: img.ext }))
  };

  // Include image URL if no local images selected
  const imageUrlInput = document.getElementById('image-url-input');
  const imageUrl = imageUrlInput ? imageUrlInput.value.trim() : '';
  if (imageUrl && selectedImages.length === 0) {
    post.imageUrl = imageUrl;
  }

  // Include comment image URL if no local comment image selected
  const commentImageUrlInput = document.getElementById('comment-image-url-input');
  const commentImageUrl = commentImageUrlInput ? commentImageUrlInput.value.trim() : '';

  // Include comment image if set
  if (selectedCommentImage) {
    post.commentImage = { data: selectedCommentImage.data, ext: selectedCommentImage.ext };
  } else if (commentImageUrl) {
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
  if (!confirm('Are you sure you want to delete this post?')) return;

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
  document.getElementById('edit-post-caption').value = post.caption || '';
  document.getElementById('edit-post-comment').value = post.comment || '';
  openModal('modal-edit-post');
}

async function saveEditPost() {
  if (!editingPostId) return;

  const caption = document.getElementById('edit-post-caption').value.trim();
  const comment = document.getElementById('edit-post-comment').value.trim();

  if (!caption) {
    showNotification('Caption cannot be empty', 'error');
    return;
  }

  const result = await window.electronAPI.editPost(editingPostId, { caption, comment });

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
  container.innerHTML = appData.groups.map(group => `
    <div class="group-item">
      <div class="group-icon">👥</div>
      <div class="group-info">
        <div class="group-name">${escapeHtml(group.name || 'Unnamed Group')}</div>
        <div class="group-id">ID: ${escapeHtml(group.groupId)}</div>
      </div>
      <div class="group-actions">
        ${modSelect(group)}
        <button class="icon-btn" onclick="deleteGroup('${group.id}')" title="Delete">🗑️</button>
      </div>
    </div>
  `).join('');
}

function openAddGroupModal() {
  document.getElementById('group-id').value = '';
  document.getElementById('group-name').value = '';
  openModal('modal-add-group');
}

async function saveGroup() {
  if (appData.groups.length >= appLimits.maxGroups) {
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
  if (!confirm('Are you sure you want to delete this group?')) return;

  const result = await window.electronAPI.deleteGroup(groupId);

  if (result.success) {
    showNotification('Group deleted successfully!', 'success');
    await loadData();
  } else {
    showNotification('Failed to delete group: ' + result.error, 'error');
  }
}

// Accounts Management
function renderAccounts() {
  const container = document.getElementById('accounts-container');

  if (appData.accounts.length === 0) {
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

  container.innerHTML = appData.accounts.filter((a) => !a.isModerator).map(account => {
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

    // Backward-compat: keep errorMessageHtml alias pointing to new var
    const errorMessageHtml = statusMessageHtml;

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

    const enabledPill = isEnabled
      ? `<button onclick="toggleAccountEnabled('${account.name}')" title="Click to disable this account" style="background:#22c55e;color:#fff;border:none;border-radius:12px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;line-height:1.4;">On</button>`
      : `<button onclick="toggleAccountEnabled('${account.name}')" title="Click to enable this account" style="background:#6b7280;color:#fff;border:none;border-radius:12px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;line-height:1.4;">Off</button>`;

    return `
      <div class="account-card" data-account-name="${escapeHtml(account.name)}" style="${isEnabled ? '' : 'opacity:0.5;'}">
        <div class="account-header">
          <div class="account-avatar">${displayName.charAt(0).toUpperCase()}</div>
          <div class="account-info">
            <h3 style="display:flex;align-items:center;gap:8px;">${escapeHtml(displayName)} ${enabledPill}</h3>
            ${subName ? `<div style="color: #9ca3af; font-size: 12px; margin-top: 2px;">${escapeHtml(subName)}</div>` : ''}
            ${!isEnabled ? `<div style="color:#f59e0b;font-size:11px;font-weight:600;margin-top:2px;">Disabled — will be skipped by automation</div>` : ''}
            <div class="account-status">
              <span class="status-dot ${statusClass}" style="${account.status === 'error' ? 'background-color: #dc2626;' : account.status === 'checking' ? 'background-color: #f59e0b;' : account.status === 'logging_in' ? 'background-color: #3b82f6;' : account.status === 'rate_limited' ? 'background-color: #f59e0b;' : ''}"></span>
              <span>${statusText}</span>
            </div>
            ${errorMessageHtml}
            ${lastCheckedHtml}
          </div>
        </div>
        
        <!-- Group Assignment Section -->
        <div class="account-groups" style="margin: 12px 0; padding: 10px; background: #1e293b; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 12px; color: #94a3b8;">📋 Assigned Groups:</span>
            <span style="font-size: 11px; color: ${assignedCount > 0 ? '#22c55e' : '#f59e0b'}; font-weight: 500;">${assignedText}</span>
          </div>
          <div class="groups-dropdown" style="position: relative;">
            <button class="btn-secondary" onclick="toggleGroupDropdown('${account.name}')" style="width: 100%; text-align: left; display: flex; justify-content: space-between; align-items: center;">
              <span>Select Groups</span>
              <span>▼</span>
            </button>
            <div id="group-dropdown-${account.name}" class="group-dropdown-menu" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: #1f2937; border: 1px solid #374151; border-radius: 6px; max-height: 200px; overflow-y: auto; z-index: 100; margin-top: 4px;">
              ${groupOptionsHtml}
            </div>
          </div>
        </div>
        
        <!-- Post Filter Section -->
        <div class="account-post-filter" style="margin: 12px 0; padding: 10px; background: #1e293b; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 12px; color: #94a3b8;">📝 Post Filter:</span>

          </div>
          <select id="post-filter-${account.name}" onchange="updatePostFilter('${account.name}', this.value)" style="width: 100%; padding: 8px 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #e5e7eb; font-size: 13px; cursor: pointer;">
            <option value="all" ${(account.postFilter || 'all') === 'all' ? 'selected' : ''}>📋 All Posts</option>
            <option value="with-comments" ${account.postFilter === 'with-comments' ? 'selected' : ''}>💬 Only with Comments</option>
            <option value="without-comments" ${account.postFilter === 'without-comments' ? 'selected' : ''}>📄 Only without Comments</option>
          </select>
        </div>
        
        <!-- Posting Method Section -->
        <div class="account-posting-method" style="margin: 12px 0; padding: 10px; background: #1e293b; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 12px; color: #94a3b8;">🔄 Posting Method:
              <span class="help"><span class="help-q" tabindex="0" role="button" aria-label="Help">?</span><span class="help-tip"><b>Posting Method — how posts are assigned to this account each cycle.</b><br><b>🎯 Post to All Groups:</b> posts EVERY eligible post (capped by Posts Per Group) to all its groups. All accounts post the same set — use to blanket many groups from each account.<br><b>🔀 Random (Shuffle):</b> same, but post order is shuffled (same shuffle for all accounts that cycle).<br><b>🎯🔒 One Post Per Account (Unique):</b> exactly ONE post per cycle, dealt round-robin so each post is published once across all accounts. Spreads a library across accounts with no repeats. If undealt posts are fewer than active accounts, the surplus accounts wait that cycle (the plan shows "waits — pool exhausted") — enable Loop Campaign to recycle, or click Reset Campaign Rotation.<br><b>🔀🔒 Random (No Repeat):</b> like Unique, but the deal order is shuffled.<br><b>📋 Progressive (Sequential):</b> one post per cycle in declared order, rotating which account gets which across loops.<br><i>Distinct content per account only happens when posts ≥ accounts (the 🔒 modes).</i></span></span>
            </span>
          </div>
          <select id="posting-order-${account.name}" onchange="updatePostingOrder('${account.name}', this.value)" style="width: 100%; padding: 8px 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #e5e7eb; font-size: 13px; cursor: pointer;">
            <option value="post-centric" ${(account.postingOrder || 'post-centric') === 'post-centric' ? 'selected' : ''}>🎯 Post to All Groups (One Post at a Time)</option>
            <option value="post-centric-unique" ${account.postingOrder === 'post-centric-unique' ? 'selected' : ''}>🎯🔒 One Post Per Account (Unique, All Groups)</option>
            <option value="random" ${account.postingOrder === 'random' ? 'selected' : ''}>🔀 Random (Shuffle)</option>
            <option value="random-unique" ${account.postingOrder === 'random-unique' ? 'selected' : ''}>🔀🔒 Random (No Repeat Across Accounts)</option>
            <option value="sequence" ${account.postingOrder === 'sequence' ? 'selected' : ''}>📋 Progressive (Sequential)</option>
            <option value="daily-rotation" ${account.postingOrder === 'daily-rotation' ? 'selected' : ''}>📅 Daily Rotation — 1 new post/day, this agent advances on its own</option>
          </select>
        </div>

        <!-- Per-Account Proxy Section -->
        <div class="account-proxy" style="margin: 12px 0; padding: 10px; background: #1e293b; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-size: 12px; color: #94a3b8;">🌐 Account Proxy:</span>
          </div>
          <input type="text" id="account-proxy-${account.name}" value="${escapeHtml(account.proxy || '')}" placeholder="scheme://ip:port[:user:pass] — e.g. socks5://1.2.3.4:1080:user:pass" onchange="updateAccountProxy('${account.name}', this.value)" style="width: 100%; padding: 8px 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #e5e7eb; font-size: 13px; box-sizing: border-box;">
          <small style="display: block; margin-top: 6px; font-size: 11px; color: #6b7280;">One stable proxy per account (recommended). Leave blank to use the global pool / your IP.</small>
        </div>

        <!-- FB display name — how this account appears as a post author, so the moderator can recognise
             its held posts in the queue. Auto-captured at login; the moderator itself is set in the Groups tab. -->
        <div class="account-fbname" style="margin: 12px 0; padding: 10px; background: #1e293b; border-radius: 8px;">
          <div style="font-size:12px; color:#94a3b8; margin-bottom:6px;">🪪 FB display name</div>
          <input type="text" value="${escapeHtml(account.fbDisplayName || '')}" placeholder="e.g. Abdo Abdo — how this account appears as a post author" onchange="updateFbDisplayName('${account.name}', this.value)" style="width:100%; padding:8px 12px; background:#1f2937; border:1px solid #374151; border-radius:6px; color:#e5e7eb; font-size:13px; box-sizing:border-box;">
          <small style="display:block; margin-top:6px; font-size:11px; color:#6b7280;">Auto-captured at login; set manually if moderator approval can't match this account's posts.</small>
        </div>

        <div class="account-actions" style="display: flex; gap: 6px;">
          <button class="btn-primary" onclick="loginAccount('${account.name}')">
            🔐 Login
          </button>
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
  }).join('');
}

// Toggle account enabled/disabled state
async function toggleAccountEnabled(accountName) {
  await window.electronAPI.toggleAccount(accountName);
  await loadData();
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
async function toggleGroupAssignment(accountName, groupId) {
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
}

// Update post filter for an account
async function updatePostFilter(accountName, filterValue) {
  const account = appData.accounts.find(a => a.name === accountName);
  if (!account) return;

  account.postFilter = filterValue;

  // Save to backend
  await saveData();

  // Show confirmation
  const filterLabels = {
    'all': 'All Posts',
    'with-comments': 'Only with Comments',
    'without-comments': 'Only without Comments'
  };
  showNotification(`Post filter set to: ${filterLabels[filterValue]}`, 'success');
}

// Update posting order for an account
async function updatePostingOrder(accountName, orderValue) {
  const account = appData.accounts.find(a => a.name === accountName);
  if (!account) return;

  account.postingOrder = orderValue;

  // Save to backend
  await saveData();

  // Show confirmation
  const orderLabels = {
    'post-centric': 'Post to All Groups',
    'post-centric-unique': 'One Post Per Account (Unique, All Groups)',
    'random': 'Random (Shuffle)',
    'random-unique': 'Random (No Repeat Across Accounts)',
    'sequence': 'Progressive (Sequential)',
    'daily-rotation': 'Daily Rotation (1 new post/day per agent)'
  };
  showNotification(`Posting method set to: ${orderLabels[orderValue]}`, 'success');
}

// Update per-account proxy
async function updateAccountProxy(accountName, proxyValue) {
  const account = appData.accounts.find(a => a.name === accountName);
  if (!account) return;
  account.proxy = (proxyValue || '').trim();
  await saveData();
  showNotification(account.proxy ? `Proxy set for ${accountName}` : `Proxy cleared for ${accountName}`, 'success');
}

// MOD: toggle an account's moderator role. MULTIPLE moderators are allowed (each covers its groups);
// a moderator never posts. Each group is routed to its moderator via group.moderatedBy (or, with one
// moderator, automatically).
async function toggleModerator(name, makeMod) {
  const a = (appData.accounts || []).find((x) => x.name === name);
  if (!a) return;
  const becomingMod = (makeMod === undefined) ? !a.isModerator : !!makeMod;
  // Demotion guard: a moderator carries a trusted admin session and was never meant to post. If we just
  // cleared the flag it would resurrect as an ENABLED poster. Confirm + disable it so it can't post
  // unattended from the admin account; the operator re-enables it on the Accounts tab if they really want.
  if (!becomingMod && a.isModerator) {
    if (!confirm(`Remove "${a.name}" as moderator?\n\nIt becomes a normal account and will be DISABLED (so it can't post from your admin session). Re-enable it on the Accounts tab if you want it to post.`)) {
      try { renderModeratorPanel(); } catch {}
      return;
    }
    a.enabled = false;
  }
  a.isModerator = becomingMod;
  await saveData();
  showNotification(a.isModerator ? `🛡️ ${a.name} is now a group moderator (it won't post)` : `${a.name} removed as moderator (disabled — re-enable on Accounts to post)`, 'success');
  try { renderModeratorPanel(); renderGroups(); renderAccounts(); } catch {}
}
// MOD: assign which moderator account covers a group's held posts ('' = auto / the only moderator).
async function updateGroupModerator(groupId, accountName) {
  const g = (appData.groups || []).find((x) => (x.id === groupId) || (x.groupId === groupId));
  if (!g) return;
  g.moderatedBy = (accountName || '').trim() || undefined;
  await saveData();
  showNotification(g.moderatedBy ? `Moderator for "${g.name || groupId}" set to ${g.moderatedBy}` : `Moderator for "${g.name || groupId}" set to auto`, 'success');
}
// MOD: the FB display name used to recognise this account's posts in the moderation queue.
async function updateFbDisplayName(name, value) {
  const a = (appData.accounts || []).find((x) => x.name === name);
  if (!a) return;
  a.fbDisplayName = (value || '').trim();
  await saveData();
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
  const rows = mods.map((a) => {
    const badge = a.status === 'logged_in' ? '<span style="color:#34d399;">● logged in</span>' : `<span style="color:#fbbf24;">● ${escapeHtml(a.status || 'not logged in')}</span>`;
    return `<div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
      <span style="min-width:120px; font-size:13px; color:#e5e7eb; font-weight:600;">🛡️ ${escapeHtml(a.alias || a.name)}</span>
      <span style="font-size:12px;">${badge}</span>
      <a href="#" onclick="loginAccount('${escapeHtml(a.name)}');return false;" style="color:#818cf8; font-size:12px;">🔐 log in</a>
      <a href="#" onclick="openImportCookiesModal('${escapeHtml(a.name)}');return false;" style="color:#818cf8; font-size:12px;">🍪 cookies</a>
      <input type="text" value="${escapeHtml(a.fbDisplayName || '')}" placeholder="FB display name (to skip its own posts)" onchange="updateFbDisplayName('${escapeHtml(a.name)}', this.value)" style="flex:1; min-width:140px; padding:6px 8px; background:#1f2937; border:1px solid #374151; border-radius:6px; color:#e5e7eb; font-size:12px;">
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
  document.getElementById('edit-account-password').value = ''; // never pre-fill password
  const badge = document.getElementById('edit-account-cred-badge');
  if (badge) badge.style.display = 'none';
  openModal('modal-edit-account');
  try {
    const cred = await window.electronAPI.getAccountCredentials(accountName);
    if (cred && cred.success) {
      document.getElementById('edit-account-email').value = cred.email || '';
      if (badge) badge.style.display = cred.hasPassword ? 'block' : 'none';
    }
  } catch {}
}

async function saveAccountCredentials() {
  if (!editingAccountName) return;
  const emailVal = document.getElementById('edit-account-email').value.trim();
  const passVal = document.getElementById('edit-account-password').value;
  // If password field is blank, preserve the existing stored password (pass empty string
  // signals "clear it"; blank input means "don't change" — we read existing from appData).
  const account = appData.accounts.find(a => a.name === editingAccountName);
  const finalPass = passVal !== '' ? passVal : (account ? (account.password || '') : '');
  const result = await window.electronAPI.setAccountCredentials(editingAccountName, emailVal, finalPass);
  if (result && result.success) {
    // Update local cache so badge reflects new state without a full reload
    if (account) { account.email = emailVal; account.password = finalPass; }
    const badge = document.getElementById('edit-account-cred-badge');
    if (badge) badge.style.display = finalPass ? 'block' : 'none';
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
    await saveData();
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
    // Basic validation
    if (!cookiesArray.every(c => c.name && c.value)) {
      throw new Error('Some cookies are missing name or value');
    }
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
        statusEl.textContent = '⚠️ Cookies imported but login could not be verified. The cookies might be expired.';
        statusEl.style.color = '#f59e0b';
        showNotification(`⚠️ ${cookieImportAccount}: cookies may be expired.`, 'error');
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
  if (appData.accounts.filter(a => !a.isModerator).length >= appLimits.maxAccounts) {
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
  if (!confirm(`Are you sure you want to delete account "${accountName}"? This will delete all account data.`)) return;

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

  const result = await window.electronAPI.checkAccountStatus(currentLoginAccount);

  await loadData();

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

async function checkLoginComplete() {
  if (!currentLoginAccount) return;

  closeModal('modal-login-instructions');
  showNotification('Checking login status...', 'info');

  await checkAccountLoginStatus(currentLoginAccount);
  currentLoginAccount = null;
}

async function checkAccountLoginStatus(accountName) {
  const result = await window.electronAPI.checkAccountStatus(accountName);

  await loadData();

  if (result.status === 'logged_in') {
    showNotification(`✅ ${accountName} is logged in successfully!`, 'success');
  } else {
    showNotification(`⚠️ ${accountName} may not be logged in. Try logging in again.`, 'error');
  }
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
  // Finish is available while a run is active (running or paused), disabled once requested or stopping.
  const applyFinish = () => {
    show(finishBtn, true);
    setEnabled(finishBtn, !isStopping && !isFinishing);
    if (finishBtn) finishBtn.innerHTML = isFinishing ? '<span>🏁</span> Finishing…' : '<span>🏁</span> Finish after batch';
  };

  if (!isAutomationRunning) {
    // IDLE: only Start visible & enabled
    show(startBtn,  true);  setEnabled(startBtn,  true);
    show(pauseBtn,  false);
    show(stopBtn,   false);
    show(finishBtn, false);
    if (pausedInd) pausedInd.style.display = 'none';
  } else if (isPaused) {
    // PAUSED: the Pause button becomes Resume. Stop remains a hard interrupt.
    show(startBtn,  false);
    show(pauseBtn,  true);  setEnabled(pauseBtn, !isStopping);
    show(stopBtn,   true);  setEnabled(stopBtn, !isStopping);
    applyFinish();
    if (pauseBtn) pauseBtn.innerHTML = '<span>▶️</span> Resume';
    if (stopBtn) stopBtn.innerHTML = isStopping ? '<span>⏹️</span> Stopping…' : '<span>⏹️</span> Stop';
    if (pausedInd) pausedInd.style.display = '';
  } else {
    // RUNNING: Pause toggle + graceful Finish + hard Stop.
    show(startBtn,  false);
    show(pauseBtn,  true);  setEnabled(pauseBtn,  !isStopping);
    show(stopBtn,   true);  setEnabled(stopBtn,   !isStopping);
    applyFinish();
    if (pauseBtn) pauseBtn.innerHTML = '<span>⏸</span> Pause';
    if (stopBtn) stopBtn.innerHTML = isStopping ? '<span>⏹️</span> Stopping…' : '<span>⏹️</span> Stop';
    if (pausedInd) pausedInd.style.display = 'none';
  }

  updateDashboard();
}

let lastRunSummary = null;

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

async function startAutomation() {
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
  const eligible = posters.filter(a => a.enabled !== false && a.status === 'logged_in' && (a.assignedGroups || []).length > 0);
  if (eligible.length === 0) {
    showNotification('No account can post yet — each needs to be enabled, logged in, and assigned at least 1 group. Fix accounts, then Start.', 'error');
    addLog('🛑 Start blocked: no eligible account (need enabled + logged-in + ≥1 assigned group).\n');
    return;
  }

  // Pre-flight: warn if any poster is not logged in
  const notLoggedIn = posters.filter(a => a.status !== 'logged_in');
  if (notLoggedIn.length > 0) {
    const total = posters.length;
    if (!confirm(`${notLoggedIn.length} of ${total} account(s) are not logged in and will be skipped. Continue?`)) return;
  }

  // Pre-flight: warn if any ENABLED poster has no assigned groups (it will post nothing)
  const noGroups = posters.filter(a => a.enabled !== false && (!a.assignedGroups || a.assignedGroups.length === 0));
  if (noGroups.length > 0) {
    if (!confirm(`${noGroups.length} enabled account(s) have NO assigned groups and will post nothing:\n${noGroups.map(a => a.name).join(', ')}\n\nContinue anyway?`)) return;
  }

  clearLogs();
  addLog('🚀 Starting automation...\n');

  // Ask once for desktop-notification permission so the end-of-run summary can alert an
  // operator who walked away during the (potentially hours-long) run.
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}

  localStartInFlight = true;
  try {
    const result = await window.electronAPI.startAutomation();
    if (result && result.success) {
      isAutomationRunning = true;
      isPaused = false;
      isStopping = false;
      updateAutomationControls();
      showNotification('Automation started!', 'success');
    } else {
      showNotification('Failed to start automation: ' + ((result && result.error) || 'unknown error'), 'error');
    }
  } catch (e) {
    showNotification('Failed to start automation: ' + e.message, 'error');
  } finally {
    setTimeout(() => { localStartInFlight = false; }, 500);
  }
}

// F4: clear the dealt-state/rotation so the next Start re-deals every post from #1. Stopped-only.
async function resetRotation() {
  if (isAutomationRunning) { showNotification('Stop the automation before resetting the rotation.', 'error'); return; }
  if (!confirm('Reset campaign rotation?\n\nThis re-deals EVERY post from the start (#1) on the next Start. Posts already published this campaign may be posted again to their groups. It does NOT delete any posts.\n\nMake sure automation is stopped.')) return;
  try {
    const r = await window.electronAPI.invoke('reset-rotation');
    if (r && r.ok) { showNotification('Campaign rotation reset — next Start re-deals all posts from #1.', 'success'); addLog('🔄 Campaign rotation reset.\n'); }
    else showNotification('Reset failed: ' + ((r && r.error) || 'unknown') + ' — ensure the app can write to the data folder.', 'error');
  } catch (e) { showNotification('Reset failed: ' + (e.message || e), 'error'); }
}

async function stopAutomation() {
  addLog('\n⏹️ Stopping automation...\n');

  isStopping = true;
  updateAutomationControls();
  try {
    const result = await window.electronAPI.stopAutomation();
    if (result && result.success) {
      showNotification('Stopping automation now...', 'info');
    } else {
      isStopping = false;
      updateAutomationControls();
      showNotification('Failed to stop automation: ' + ((result && result.error) || 'unknown error'), 'error');
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
  if (isPaused) return resumeAutomation();
  return pauseAutomation();
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
}

function addLog(text) {
  const container = document.getElementById('logs-container');
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  // Colour by explicit emoji markers first (reliable), then words — but never let
  // "errors=0" / "Errors: 0" (a success summary) get flagged red.
  const low = text.toLowerCase();
  const zeroErr = /errors?\s*[:=]\s*0\b/.test(low);
  if (/❌|🚫|🛑/.test(text) || ((low.includes('error') || low.includes('failed')) && !zeroErr)) {
    entry.classList.add('error');
  } else if (/✅|🎉|🏁/.test(text) || low.includes('success') || low.includes('completed') || low.includes('posted successfully')) {
    entry.classList.add('success');
  }

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
}

function openLogsFolder() {
  if (window.electronAPI && window.electronAPI.openLogsFolder) {
    window.electronAPI.openLogsFolder().catch(() => {});
  }
}

// Settings
function loadSettings() {
  document.getElementById('setting-parallel-accounts').value = appData.settings.parallelAccounts;
  document.getElementById('setting-wait-interval-min').value = appData.settings.waitIntervalMin !== undefined ? appData.settings.waitIntervalMin : 90;
  document.getElementById('setting-wait-interval-max').value = appData.settings.waitIntervalMax !== undefined ? appData.settings.waitIntervalMax : 180;
  document.getElementById('setting-account-delay-min').value = appData.settings.accountDelayMin !== undefined ? appData.settings.accountDelayMin : 1;
  document.getElementById('setting-account-delay-max').value = appData.settings.accountDelayMax !== undefined ? appData.settings.accountDelayMax : 4;
  document.getElementById('setting-posts-per-group').value = appData.settings.postsPerGroup;
  document.getElementById('setting-comment-with-image').checked = appData.settings.commentWithImage || false;
  document.getElementById('setting-auto-delete-posted').checked = appData.settings.autoDeletePosted || false;
  document.getElementById('setting-hide-browser').checked = appData.settings.hideBrowser !== false;
  document.getElementById('setting-group-delay-min').value = appData.settings.groupDelayMin !== undefined ? appData.settings.groupDelayMin : 120;
  document.getElementById('setting-group-delay-max').value = appData.settings.groupDelayMax !== undefined ? appData.settings.groupDelayMax : 300;
  document.getElementById('setting-max-cycles').value = appData.settings.maxCycles !== undefined ? appData.settings.maxCycles : 0;
  document.getElementById('setting-enable-tunnel').checked = appData.settings.enableTunnel || false;
  { const el = document.getElementById('setting-moderation-enabled'); if (el) el.checked = appData.settings.moderationEnabled === true; }
  { const el = document.getElementById('setting-reserve-accounts'); if (el) el.value = (appData.settings.reserveAccounts != null ? appData.settings.reserveAccounts : 0); }
  document.getElementById('setting-loop-campaign').checked = appData.settings.loopCampaign || false;
  document.getElementById('setting-resume-on-startup').checked = appData.settings.resumeOnStartup === true;
  document.getElementById('setting-launch-on-startup').checked = appData.settings.launchOnStartup || false;
  document.getElementById('setting-comment-delay-min').value = appData.settings.commentDelayMin !== undefined ? appData.settings.commentDelayMin : 60;
  document.getElementById('setting-comment-delay-max').value = appData.settings.commentDelayMax !== undefined ? appData.settings.commentDelayMax : 180;
  document.getElementById('setting-daily-cap').value = appData.settings.dailyCap !== undefined ? appData.settings.dailyCap : 0;
  { const el = document.getElementById('setting-schedule-mode'); if (el) el.value = appData.settings.scheduleMode === 'daily' ? 'daily' : 'continuous'; }
  { const el = document.getElementById('setting-daily-post-time'); if (el) el.value = appData.settings.dailyPostTime || '09:00'; }
  { const el = document.getElementById('setting-completion-mode'); if (el) el.checked = appData.settings.completionMode === true; }
  document.getElementById('setting-vary-content').checked = appData.settings.varyContent !== false;
  document.getElementById('setting-vary-images').checked = appData.settings.varyImages !== false;
  document.getElementById('setting-randomize-links').checked = appData.settings.randomizeLinks !== false;
  document.getElementById('setting-stagger-accounts').checked = appData.settings.staggerAccounts !== false;
  document.getElementById('setting-enable-warmup').checked = appData.settings.enableWarmup || false;
  document.getElementById('setting-warmup-runs').value = appData.settings.warmupRuns !== undefined ? appData.settings.warmupRuns : 5;
  document.getElementById('setting-cooldown-hours').value = appData.settings.rateLimitCooldownHours !== undefined ? appData.settings.rateLimitCooldownHours : 4;
  // Humanization (anti-detection) controls
  document.getElementById('setting-humanize-master').checked = appData.settings.humanizeMaster !== false;
  document.getElementById('setting-page-dwell-min').value = appData.settings.pageScrollDwellSecMin !== undefined ? appData.settings.pageScrollDwellSecMin : 3;
  document.getElementById('setting-page-dwell-max').value = appData.settings.pageScrollDwellSecMax !== undefined ? appData.settings.pageScrollDwellSecMax : 15;
  document.getElementById('setting-prepublish-dwell-min').value = appData.settings.prePublishDwellSecMin !== undefined ? appData.settings.prePublishDwellSecMin : 3;
  document.getElementById('setting-prepublish-dwell-max').value = appData.settings.prePublishDwellSecMax !== undefined ? appData.settings.prePublishDwellSecMax : 8;
  document.getElementById('setting-comment-dwell-min').value = appData.settings.commentDwellSecMin !== undefined ? appData.settings.commentDwellSecMin : 1;
  document.getElementById('setting-comment-dwell-max').value = appData.settings.commentDwellSecMax !== undefined ? appData.settings.commentDwellSecMax : 4;
  try { highlightSpeed(appData.settings.speedMode || 'normal'); } catch {}
}

// Attach a hover "?" help badge to every Settings label explaining what the control does and how to
// use it. Data-driven (one place to edit), idempotent, and runs once on load. Matching is by a unique
// substring of each label's text, in order, skipping labels that already have a badge.
const SETTINGS_HELP = [
  ['Parallel', '<b>Parallel Accounts.</b> How many accounts post at the same time. More is faster but heavier, and a stronger shared-IP footprint. Keep it at 1–3 unless each account has its own proxy (Accounts tab).'],
  ['Wait Between Cycles', '<b>Wait Between Cycles.</b> After an account finishes all its groups, it sleeps a <b>random</b> number of minutes in this range before the next full cycle. A wide gap (e.g. 90–180) looks human; a fixed interval is a spam signal.'],
  ['Stagger Between Accounts', '<b>Stagger Between Accounts.</b> When several accounts run together, each new one waits a random number of minutes (in this range) before starting — so they never hit Facebook in the same instant.'],
  ['Posts Per Group', '<b>Posts Per Group (non-unique modes only).</b> How many posts to publish in EACH group, per cycle — not posts-per-cycle (e.g. 2 posts × 3 groups = 6 group-posts). 0 = no cap (all eligible). The unique modes (One Post Per Account, Random No-Repeat, Progressive) always post exactly 1 and ignore this.'],
  ['Delay Between Groups', '<b>Delay Between Groups.</b> A <b>random</b> wait (seconds) between posting to one group and the next, within the same account. The engine enforces a 120s floor — going faster is high spam-risk.'],
  ['Humanized timing', '<b>Humanized timing (master switch).</b> When ON, every pause in the process is a fresh random value so the rhythm is never mechanical. Leave it ON; turn off only for debugging. (The post→comment delay below stays randomized regardless.)'],
  ['Feed browse before posting', '<b>Feed browse before posting.</b> Seconds the bot scrolls and "reads" the group feed before opening the composer — like a real visitor landing on the page. Set both to 0 to skip browsing.'],
  ['Re-read before posting', '<b>Re-read before posting.</b> Seconds it pauses after writing the caption, before clicking Post — a human re-reads what they wrote. A random value in this range.'],
  ['Pause on post before comment', '<b>Pause on post before comment.</b> Seconds it waits on the post page before typing the first comment (a brief human "reading" pause). Separate from the longer anti-spam comment delay below.'],
  ['Max Cycles', '<b>Max Cycles.</b> Stop automatically after this many full posting cycles. 0 = run indefinitely until you press Stop.'],
  ['Comment with Post Image', '<b>Comment with Post Image.</b> Also attaches the post\'s image to its first comment. Only affects posts that have a comment configured.'],
  ['Auto-Delete Posted', '<b>Auto-Delete Posted.</b> Removes a post from the app\'s library once it has posted successfully. Don\'t combine with Loop Campaign (which needs the library to recycle).'],
  ['Hide Browser', '<b>Hide Browser.</b> Runs the automation browser off-screen (default) — invisible to you, but Facebook still treats it as active so posting works. Turn OFF to watch it run (it opens in the background and won\'t steal focus).'],
  ['Enable Remote Access', '<b>Remote Access / Dashboard Tunnel.</b> Starts a Cloudflare tunnel so you can monitor and control the app from another device. Takes effect on the next app restart.'],
  ['Loop Campaign', '<b>Loop Campaign (unique modes).</b> OFF = the campaign ends after each post has been sent once. ON = it recycles forever, re-distributing the library and rotating which account posts which content.'],
  ['Resume interrupted run', '<b>Resume on startup.</b> If the app closed mid-run (crash or shutdown), it automatically continues the campaign the next time it launches.'],
  ['Launch app automatically', '<b>Launch on Windows startup.</b> Registers the app as a Windows login item so it opens automatically when you sign in.'],
  ['First-comment delay min', '<b>First-comment delay (min).</b> The shortest wait, in seconds, before the first comment (usually your link) is added after the post. Posting a link instantly is a top spam trigger — keep this at 60s+.'],
  ['First-comment delay max', '<b>First-comment delay (max).</b> The longest wait, in seconds, before the first comment. The actual wait is random between min and max each time, so the post→link timing is never predictable.'],
  ['Daily post cap', '<b>Daily cap per account.</b> Maximum posts per account per day. 0 = no cap. Use a low number (5–10) for new or sensitive accounts to stay under Facebook\'s radar.'],
  ['Vary captions', '<b>Spintax variation.</b> Resolves {option1|option2|option3} blocks in captions/comments randomly per post, so every group gets slightly different text. The #1 defense against duplicate-content flags.'],
  ['Vary image per group', '<b>Vary image per group.</b> Applies an invisible per-group pixel tweak so each uploaded image has a unique fingerprint, reducing duplicate-media detection.'],
  ['Randomize links', '<b>Randomize links.</b> Appends a unique tracking parameter to links in the first comment, so the same URL isn\'t posted identically everywhere (harder to flag as repetitive spam).'],
  ['Stagger account start', '<b>Stagger account starts.</b> Master toggle for the random gap between accounts beginning a cycle (the range is set in "Stagger Between Accounts" above). Keep it on.'],
  ['Warm up new accounts', '<b>Warm up new accounts.</b> New accounts browse and scroll the feed for a while before their first post, so they look like real users instead of posting immediately.'],
  ['Warm-up runs', '<b>Warm-up runs.</b> How many successful runs an account is treated as "new" and warmed up before posting. Only used when "Warm up new accounts" is on.'],
  ['Rate-limit cool-down', '<b>Rate-limit cool-down.</b> Base hours a rate-limited account rests before being retried. It doubles with each repeat strike (capped at 48h) to back off safely.'],
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
  fast:   { waitIntervalMin: 45,  waitIntervalMax: 90,  accountDelayMin: 1, accountDelayMax: 2, groupDelayMin: 120, groupDelayMax: 180, commentDelayMin: 45,  commentDelayMax: 90,  pageScrollDwellSecMin: 2, pageScrollDwellSecMax: 6,  prePublishDwellSecMin: 1, prePublishDwellSecMax: 4,  commentDwellSecMin: 1, commentDwellSecMax: 3, composerOpenInitialDelayMs: 1000 },
  normal: { waitIntervalMin: 90,  waitIntervalMax: 180, accountDelayMin: 1, accountDelayMax: 4, groupDelayMin: 120, groupDelayMax: 300, commentDelayMin: 60,  commentDelayMax: 180, pageScrollDwellSecMin: 3, pageScrollDwellSecMax: 15, prePublishDwellSecMin: 3, prePublishDwellSecMax: 8,  commentDwellSecMin: 1, commentDwellSecMax: 4, composerOpenInitialDelayMs: 1500 },
  slow:   { waitIntervalMin: 180, waitIntervalMax: 360, accountDelayMin: 3, accountDelayMax: 8, groupDelayMin: 300, groupDelayMax: 600, commentDelayMin: 120, commentDelayMax: 300, pageScrollDwellSecMin: 8, pageScrollDwellSecMax: 25, prePublishDwellSecMin: 5, prePublishDwellSecMax: 12, commentDwellSecMin: 3, commentDwellSecMax: 8, composerOpenInitialDelayMs: 2500 },
};
const SPEED_INPUT_IDS = {
  waitIntervalMin: 'setting-wait-interval-min', waitIntervalMax: 'setting-wait-interval-max',
  accountDelayMin: 'setting-account-delay-min', accountDelayMax: 'setting-account-delay-max',
  groupDelayMin: 'setting-group-delay-min', groupDelayMax: 'setting-group-delay-max',
  commentDelayMin: 'setting-comment-delay-min', commentDelayMax: 'setting-comment-delay-max',
  pageScrollDwellSecMin: 'setting-page-dwell-min', pageScrollDwellSecMax: 'setting-page-dwell-max',
  prePublishDwellSecMin: 'setting-prepublish-dwell-min', prePublishDwellSecMax: 'setting-prepublish-dwell-max',
  commentDwellSecMin: 'setting-comment-dwell-min', commentDwellSecMax: 'setting-comment-dwell-max',
};
function highlightSpeed(mode) {
  document.querySelectorAll('.speed-btn').forEach((b) => b.classList.toggle('active', b.dataset.speed === mode));
}
function applySpeedPreset(mode) {
  const p = SPEED_PRESETS[mode];
  if (!p) return;
  for (const [key, id] of Object.entries(SPEED_INPUT_IDS)) {
    const el = document.getElementById(id);
    if (el && p[key] !== undefined) el.value = p[key];
  }
  // composerOpenInitialDelayMs has no dedicated input — set it directly so saveSettings preserves it.
  if (appData && appData.settings) { appData.settings.composerOpenInitialDelayMs = p.composerOpenInitialDelayMs; appData.settings.speedMode = mode; }
  highlightSpeed(mode);
  saveSettings(); // one-click: fill the ranges AND apply immediately
}
function wireSpeedButtons() {
  document.querySelectorAll('.speed-btn').forEach((b) => {
    if (b.dataset.wired) return; b.dataset.wired = '1';
    b.addEventListener('click', () => applySpeedPreset(b.dataset.speed));
  });
  highlightSpeed((appData && appData.settings && appData.settings.speedMode) || 'normal');
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
  const intOr = (id, def) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : def; };
  const settings = {
    ...appData.settings, // preserve settings that have no form input
    parallelAccounts: intOr('setting-parallel-accounts', 2),
    waitIntervalMin: intOr('setting-wait-interval-min', 90),
    waitIntervalMax: intOr('setting-wait-interval-max', 180),
    accountDelayMin: intOr('setting-account-delay-min', 1),
    accountDelayMax: intOr('setting-account-delay-max', 4),
    postsPerGroup: intOr('setting-posts-per-group', 1),
    commentWithImage: document.getElementById('setting-comment-with-image').checked,
    autoDeletePosted: document.getElementById('setting-auto-delete-posted').checked,
    hideBrowser: document.getElementById('setting-hide-browser').checked,
    groupDelayMin: intOr('setting-group-delay-min', 120),
    groupDelayMax: intOr('setting-group-delay-max', 300),
    maxCycles: intOr('setting-max-cycles', 0),
    enableTunnel: document.getElementById('setting-enable-tunnel').checked,
    moderationEnabled: (document.getElementById('setting-moderation-enabled') || {}).checked || false,
    reserveAccounts: Math.max(0, Math.round(Number((document.getElementById('setting-reserve-accounts') || {}).value) || 0)),
    loopCampaign: document.getElementById('setting-loop-campaign').checked,
    resumeOnStartup: document.getElementById('setting-resume-on-startup').checked,
    launchOnStartup: document.getElementById('setting-launch-on-startup').checked,
    commentDelayMin: intOr('setting-comment-delay-min', 60),
    commentDelayMax: intOr('setting-comment-delay-max', 180),
    dailyCap: intOr('setting-daily-cap', 0),
    scheduleMode: ((document.getElementById('setting-schedule-mode') || {}).value === 'daily') ? 'daily' : 'continuous',
    dailyPostTime: (document.getElementById('setting-daily-post-time') || {}).value || '09:00',
    completionMode: (document.getElementById('setting-completion-mode') || {}).checked || false,
    varyContent: document.getElementById('setting-vary-content').checked,
    varyImages: document.getElementById('setting-vary-images').checked,
    randomizeLinks: document.getElementById('setting-randomize-links').checked,
    staggerAccounts: document.getElementById('setting-stagger-accounts').checked,
    enableWarmup: document.getElementById('setting-enable-warmup').checked,
    warmupRuns: intOr('setting-warmup-runs', 5),
    rateLimitCooldownHours: intOr('setting-cooldown-hours', 4),
    humanizeMaster: document.getElementById('setting-humanize-master').checked,
    pageScrollDwellSecMin: intOr('setting-page-dwell-min', 3),
    pageScrollDwellSecMax: intOr('setting-page-dwell-max', 15),
    prePublishDwellSecMin: intOr('setting-prepublish-dwell-min', 3),
    prePublishDwellSecMax: intOr('setting-prepublish-dwell-max', 8),
    commentDwellSecMin: intOr('setting-comment-dwell-min', 1),
    commentDwellSecMax: intOr('setting-comment-dwell-max', 4),
  };

  const result = await window.electronAPI.saveSettings(settings);

  if (result.success) {
    appData.settings = settings;
    showNotification('Settings saved successfully!', 'success');
  } else {
    showNotification('Failed to save settings: ' + result.error, 'error');
  }
}

// Proxies
// Proxies
function parseProxyStringTable(proxyStr) {
  if (!proxyStr) return {};

  let remainder = proxyStr;
  if (proxyStr.includes('://')) {
    remainder = proxyStr.split('://')[1];
  }

  const parts = remainder.split(':');
  return {
    ip: parts[0] || '',
    port: parts[1] || '',
    user: parts[2] || '',
    pass: parts[3] || ''
  };
}

function addProxyRow(id, ip, port, user, pass) {
  const tbody = document.getElementById('proxies-table-body');
  const emptyState = document.getElementById('proxies-empty-state');

  if (emptyState) emptyState.style.display = 'none';

  const tr = document.createElement('tr');
  tr.style.borderBottom = '1px solid #e5e7eb';

  tr.innerHTML = `
    <td style="padding: 12px 15px;">${escapeHtml(id)}</td>
    <td style="padding: 12px 15px;">${escapeHtml(ip)}</td>
    <td style="padding: 12px 15px;">${escapeHtml(port)}</td>
    <td style="padding: 12px 15px;">${escapeHtml(user)}</td>
    <td style="padding: 12px 15px;">${escapeHtml(pass)}</td>
    <td style="padding: 12px 15px;">
      <button class="icon-btn" onclick="this.closest('tr').remove()" style="color: #ef4444; border-color: #ef4444;">🗑️</button>
    </td>
  `;

  tbody.appendChild(tr);
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
        // If we want a separate ID, we either assume it's index+1 or parse it if we stored it
        // User asked for "Proxy Number" entry. 
        // Since backend stores strings, we lose "Proxy Number" unless we encode it.
        // For now, let's just use index+1 as default display if parsing fails, or try to infer.
        // Actually, user wants to INPUT it. 
        // To persist it in the simple string format 'socks5://ip:port:user:pass', we lose the ID.
        // COMPROMISE: We will lose the custom ID on save/reload and just auto-increment.
        // OR we change backend. But user said "I will only use socks 5... add proxy should have 5 entries".
        // They didn't explicitly say "save my custom ID". They said "Input it".
        // I will display auto-index for loaded proxies.
        addProxyRow(index + 1, parts.ip, parts.port, parts.user, parts.pass);
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
    // Reconstruct SOCKS5 string
    let str = `socks5://${ip}:${portNum}`;
    if (user && pass) str += `:${user}:${pass}`;
    proxies.push(str);
  });
  if (invalid > 0) showNotification(`${invalid} proxy row(s) invalid (need host + port 1-65535) — skipped`, 'error');

  // Save list
  const saveList = await window.electronAPI.invoke('save-proxies', proxies);
  // Save toggle
  const saveToggle = await window.electronAPI.invoke('toggle-proxies', enabled);

  if (saveList.success && saveToggle.success) {
    showNotification('SOCKS5 Proxies saved successfully!', 'success');
    appData.settings.useProxies = enabled;
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
