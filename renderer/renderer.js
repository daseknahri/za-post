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
    updateAutomationControls();
    addLog(`\n✅ Automation ${reason || 'stopped'}.\n`);
    await loadData(); // refresh — the backend may have auto-deleted posted items during the run
  });

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
  document.getElementById('btn-pause-automation').addEventListener('click', togglePauseAutomation);
  document.getElementById('btn-resume-automation').addEventListener('click', resumeAutomation);
  document.getElementById('btn-finish-automation').addEventListener('click', finishAutomation);

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
  set('stat-accounts', appData.accounts.length);

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
  const accounts = appData.accounts || [];
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

  container.innerHTML = appData.groups.map(group => `
    <div class="group-item">
      <div class="group-icon">👥</div>
      <div class="group-info">
        <div class="group-name">${escapeHtml(group.name || 'Unnamed Group')}</div>
        <div class="group-id">ID: ${escapeHtml(group.groupId)}</div>
      </div>
      <div class="group-actions">
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

  container.innerHTML = appData.accounts.map(account => {
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
    }

    // Show lastMessage for ALL statuses (not just error/not_logged_in)
    let statusMessageHtml = '';
    if (account.lastMessage) {
      const msg = account.lastMessage.length > 80 ? account.lastMessage.substring(0, 80) + '...' : account.lastMessage;
      const msgColor = (account.status === 'error' || account.status === 'not_logged_in') ? '#dc2626'
        : (account.status === 'logged_in') ? '#22c55e'
        : (account.status === 'rate_limited') ? '#f59e0b'
        : (account.status === 'checking' || account.status === 'logging_in') ? '#f59e0b'
        : '#9ca3af';
      const msgIcon = (account.status === 'error' || account.status === 'not_logged_in') ? '⚠️'
        : (account.status === 'logged_in') ? '✅'
        : (account.status === 'rate_limited') ? '⏸'
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
      <div class="account-card" style="${isEnabled ? '' : 'opacity:0.5;'}">
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
            <span style="font-size: 12px; color: #94a3b8;">🔄 Posting Method:</span>
          </div>
          <select id="posting-order-${account.name}" onchange="updatePostingOrder('${account.name}', this.value)" style="width: 100%; padding: 8px 12px; background: #1f2937; border: 1px solid #374151; border-radius: 6px; color: #e5e7eb; font-size: 13px; cursor: pointer;">
            <option value="post-centric" ${(account.postingOrder || 'post-centric') === 'post-centric' ? 'selected' : ''}>🎯 Post to All Groups (One Post at a Time)</option>
            <option value="post-centric-unique" ${account.postingOrder === 'post-centric-unique' ? 'selected' : ''}>🎯🔒 One Post Per Account (Unique, All Groups)</option>
            <option value="random" ${account.postingOrder === 'random' ? 'selected' : ''}>🔀 Random (Shuffle)</option>
            <option value="random-unique" ${account.postingOrder === 'random-unique' ? 'selected' : ''}>🔀🔒 Random (No Repeat Across Accounts)</option>
            <option value="sequence" ${account.postingOrder === 'sequence' ? 'selected' : ''}>📋 Progressive (Sequential)</option>
          </select>
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
    'sequence': 'Progressive (Sequential)'
  };
  showNotification(`Posting method set to: ${orderLabels[orderValue]}`, 'success');
}

// Edit account name and alias
let editingAccountName = null;

function editAccount(accountName) {
  const account = appData.accounts.find(a => a.name === accountName);
  if (!account) return;

  editingAccountName = accountName;

  // Populate modal fields
  document.getElementById('edit-account-alias').value = account.alias || '';
  document.getElementById('edit-account-name').value = accountName;

  // Credential section: pre-fill email (not password), show badge if password is set
  document.getElementById('edit-account-email').value = account.email || '';
  document.getElementById('edit-account-password').value = ''; // never pre-fill password
  const badge = document.getElementById('edit-account-cred-badge');
  if (badge) badge.style.display = account.password ? 'block' : 'none';

  openModal('modal-edit-account');
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
  if (appData.accounts.length >= appLimits.maxAccounts) {
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
  const resumeBtn  = document.getElementById('btn-resume-automation');
  const finishBtn  = document.getElementById('btn-finish-automation');
  const stopBtn    = document.getElementById('btn-stop-automation');
  const pausedInd  = document.getElementById('paused-indicator');

  const setEnabled = (btn, enabled) => {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.classList.toggle('opacity-50', !enabled);
    btn.classList.toggle('cursor-not-allowed', !enabled);
  };
  const show = (btn, visible) => { if (btn) btn.style.display = visible ? '' : 'none'; };

  if (!isAutomationRunning) {
    // IDLE: only Start visible & enabled
    show(startBtn,  true);  setEnabled(startBtn,  true);
    show(pauseBtn,  false);
    show(resumeBtn, false);
    show(finishBtn, false);
    show(stopBtn,   false);
    if (pausedInd) pausedInd.style.display = 'none';
  } else if (isPaused) {
    // PAUSED: Pause becomes Resume. Stop remains a hard interrupt.
    show(startBtn,  false);
    show(pauseBtn,  true);  setEnabled(pauseBtn, !isStopping);
    show(resumeBtn, false);
    show(finishBtn, false);
    show(stopBtn,   true);  setEnabled(stopBtn, !isStopping);
    if (pauseBtn) pauseBtn.innerHTML = '<span>▶️</span> Resume';
    if (stopBtn) stopBtn.innerHTML = isStopping ? '<span>⏹️</span> Stopping…' : '<span>⏹️</span> Stop';
    if (pausedInd) pausedInd.style.display = '';
  } else {
    // RUNNING: Pause toggle + hard Stop.
    show(startBtn,  false);
    show(pauseBtn,  true);  setEnabled(pauseBtn,  !isStopping);
    show(resumeBtn, false);
    show(finishBtn, false);
    show(stopBtn,   true);  setEnabled(stopBtn,   !isStopping);
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
  lines.push('   Full audit trail → Logs folder → run-report.csv');
  lines.push('═══════════════════════════════');
  addLog(lines.join('\n') + '\n');
  try { showNotification(`Run ${s.reason}: ${s.posted} posted, ${s.pending} pending, ${s.errors} errors`, s.errors ? 'error' : 'success'); } catch {}
  // Desktop notification so an operator who walked away still sees the result.
  try { if (window.Notification && Notification.permission === 'granted') new Notification('Za Post — run ' + s.reason, { body: `${s.posted} posted, ${s.pending} pending, ${s.errors} errors` }); } catch {}
}

async function startAutomation() {
  if (isAutomationRunning) { showNotification('Automation is already running', 'info'); return; }
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
  const eligible = appData.accounts.filter(a => a.enabled !== false && a.status === 'logged_in' && (a.assignedGroups || []).length > 0);
  if (eligible.length === 0) {
    showNotification('No account can post yet — each needs to be enabled, logged in, and assigned at least 1 group. Fix accounts, then Start.', 'error');
    addLog('🛑 Start blocked: no eligible account (need enabled + logged-in + ≥1 assigned group).\n');
    return;
  }

  // Pre-flight: warn if any account is not logged in
  const notLoggedIn = appData.accounts.filter(a => a.status !== 'logged_in');
  if (notLoggedIn.length > 0) {
    const total = appData.accounts.length;
    if (!confirm(`${notLoggedIn.length} of ${total} account(s) are not logged in and will be skipped. Continue?`)) return;
  }

  // Pre-flight: warn if any ENABLED account has no assigned groups (it will post nothing)
  const noGroups = appData.accounts.filter(a => a.enabled !== false && (!a.assignedGroups || a.assignedGroups.length === 0));
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

async function finishAutomation() {
  try {
    const result = await window.electronAPI.finishAutomation();
    if (result && result.success) {
      addLog('\n🏁 Finish requested — current batch will complete, then automation ends.\n');
      showNotification('Automation will finish after current batch.', 'info');
      // Show "finishing…" state: disable Pause/Resume/Finish, keep Stop active
      const pauseBtn  = document.getElementById('btn-pause-automation');
      const resumeBtn = document.getElementById('btn-resume-automation');
      const finishBtn = document.getElementById('btn-finish-automation');
      const stopBtn   = document.getElementById('btn-stop-automation');
      if (pauseBtn)  { pauseBtn.disabled  = true;  pauseBtn.classList.add('opacity-50', 'cursor-not-allowed'); }
      if (resumeBtn) { resumeBtn.disabled = true;  resumeBtn.classList.add('opacity-50', 'cursor-not-allowed'); }
      if (finishBtn) { finishBtn.disabled = true;  finishBtn.textContent = '🏁 Finishing…'; finishBtn.classList.add('opacity-50', 'cursor-not-allowed'); }
      if (stopBtn)   { stopBtn.disabled   = false; stopBtn.classList.remove('opacity-50', 'cursor-not-allowed'); }
    } else {
      showNotification('Failed to finish: ' + ((result && result.error) || 'unknown error'), 'error');
    }
  } catch (e) {
    showNotification('Failed to finish: ' + e.message, 'error');
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
  document.getElementById('setting-wait-interval').value = appData.settings.waitInterval;
  document.getElementById('setting-account-delay').value = appData.settings.accountDelay || 1;
  document.getElementById('setting-posts-per-group').value = appData.settings.postsPerGroup;
  document.getElementById('setting-comment-with-image').checked = appData.settings.commentWithImage || false;
  document.getElementById('setting-auto-delete-posted').checked = appData.settings.autoDeletePosted || false;
  document.getElementById('setting-hide-browser').checked = appData.settings.hideBrowser !== false;
  document.getElementById('setting-group-delay').value = appData.settings.groupDelay !== undefined ? appData.settings.groupDelay : 60;
  document.getElementById('setting-max-cycles').value = appData.settings.maxCycles !== undefined ? appData.settings.maxCycles : 0;
  document.getElementById('setting-enable-tunnel').checked = appData.settings.enableTunnel || false;
  document.getElementById('setting-loop-campaign').checked = appData.settings.loopCampaign || false;
  document.getElementById('setting-resume-on-startup').checked = appData.settings.resumeOnStartup === true;
  document.getElementById('setting-launch-on-startup').checked = appData.settings.launchOnStartup || false;
}

async function saveSettings() {
  // Blank/invalid numeric inputs parse to NaN; fall back to sane defaults so a stray
  // NaN can't, e.g., silently disable the inter-group delay and trigger rate-limits.
  const intOr = (id, def) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : def; };
  const settings = {
    parallelAccounts: intOr('setting-parallel-accounts', 3),
    waitInterval: intOr('setting-wait-interval', 60),
    accountDelay: intOr('setting-account-delay', 1),
    postsPerGroup: intOr('setting-posts-per-group', 1),
    commentWithImage: document.getElementById('setting-comment-with-image').checked,
    autoDeletePosted: document.getElementById('setting-auto-delete-posted').checked,
    hideBrowser: document.getElementById('setting-hide-browser').checked,
    groupDelay: intOr('setting-group-delay', 60),
    maxCycles: intOr('setting-max-cycles', 0),
    enableTunnel: document.getElementById('setting-enable-tunnel').checked,
    loopCampaign: document.getElementById('setting-loop-campaign').checked,
    resumeOnStartup: document.getElementById('setting-resume-on-startup').checked,
    launchOnStartup: document.getElementById('setting-launch-on-startup').checked,
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

  // Add to container
  container.appendChild(notification);

  // Trigger animation
  setTimeout(() => notification.classList.add('show'), 10);

  // Remove after 3 seconds
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => {
      notification.remove();
      if (container.childNodes.length === 0) {
        container.remove();
      }
    }, 300);
  }, 3000);

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
