const { contextBridge, ipcRenderer } = require('electron');

// ALLOWLIST for the generic invoke() bridge. Without it, ANY renderer-side JS (incl. injected/XSS) could call
// SENSITIVE main handlers — e.g. get-account-credentials (decrypts FB passwords) or batch-account-action
// (bulk-delete accounts + wipe profiles). Only these explicitly-known channels are reachable.
const ALLOWED_CHANNELS = new Set([
  'get-data', 'save-data',
  'add-post', 'delete-post', 'delete-posts', 'edit-post', 'add-posts-bulk', 'add-groups-bulk', 'bulk-assign-post-set', 'delete-post-set',
  'add-group', 'delete-group', 'delete-groups',
  'create-account', 'login-account', 'auto-login-account', 'open-account-browser', 'check-account-status', 'check-account-memberships', 'delete-account', 'import-cookies',
  'close-login-browser', 'toggle-account', 'set-account-credentials', 'get-account-credentials',
  'rename-account', 'batch-account-action', 'add-accounts-bulk', 'pick-cookies-folder',
  'setup-chrome-import', 'open-chrome-import-folder', 'chrome-import-info', 'assign-chrome-groups',
  'start-automation', 'stop-automation', 'pause-automation', 'resume-automation', 'finish-automation',
  'get-automation-status', 'reset-rotation', 'approve-held-now', 'open-external',
  'set-autostart', 'get-autostart-status', 'get-plan', 'get-warmup-counts',
  'select-image', 'save-settings',
  'get-proxies', 'save-proxies', 'toggle-proxies',
  'get-remote-url', 'get-license-info', 'get-server-url', 'update-server-url', 'get-proxy-health', 'detect-proxy-geo',
  'open-logs-folder', 'rdp-status', 'open-rdp-setup',
]);

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Data operations — the generic invoke is GATED to ALLOWED_CHANNELS (no arbitrary-channel passthrough).
  invoke: (channel, ...args) => {
    if (!ALLOWED_CHANNELS.has(channel)) return Promise.reject(new Error('IPC channel not allowed: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  getData: () => ipcRenderer.invoke('get-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),

  // Post operations
  addPost: (post) => ipcRenderer.invoke('add-post', post),
  deletePost: (postId) => ipcRenderer.invoke('delete-post', postId),
  deletePosts: (ids) => ipcRenderer.invoke('delete-posts', ids),
  editPost: (postId, updates) => ipcRenderer.invoke('edit-post', postId, updates),
  bulkAssignPostSet: (postIds, setId) => ipcRenderer.invoke('bulk-assign-post-set', postIds, setId),
  deletePostSet: (setId) => ipcRenderer.invoke('delete-post-set', setId),

  // Group operations
  addGroup: (group) => ipcRenderer.invoke('add-group', group),
  deleteGroup: (groupId) => ipcRenderer.invoke('delete-group', groupId),
  deleteGroups: (ids) => ipcRenderer.invoke('delete-groups', ids),
  addPostsBulk: (posts) => ipcRenderer.invoke('add-posts-bulk', posts),
  addGroupsBulk: (items) => ipcRenderer.invoke('add-groups-bulk', items),

  // Account operations
  createAccount: (accountName, alias, opts) => ipcRenderer.invoke('create-account', accountName, alias, opts),
  loginAccount: (accountName) => ipcRenderer.invoke('login-account', accountName),
  checkAccountStatus: (accountName) => ipcRenderer.invoke('check-account-status', accountName),
  checkAccountMemberships: (accountName) => ipcRenderer.invoke('check-account-memberships', accountName),
  deleteAccount: (accountName) => ipcRenderer.invoke('delete-account', accountName),
  importCookies: (accountName, cookies) => ipcRenderer.invoke('import-cookies', accountName, cookies),
  addAccountsBulk: (accounts, opts) => ipcRenderer.invoke('add-accounts-bulk', accounts, opts),
  pickCookiesFolder: () => ipcRenderer.invoke('pick-cookies-folder'),
  closeLoginBrowser: (name) => ipcRenderer.invoke('close-login-browser', name),
  toggleAccount: (name, enabled) => ipcRenderer.invoke('toggle-account', name, enabled),
  setAccountCredentials: (name, email, password) => ipcRenderer.invoke('set-account-credentials', name, email, password),
  getAccountCredentials: (name) => ipcRenderer.invoke('get-account-credentials', name),

  // Automation operations
  startAutomation: (runNow) => ipcRenderer.invoke('start-automation', runNow),
  stopAutomation: () => ipcRenderer.invoke('stop-automation'),
  pauseAutomation: () => ipcRenderer.invoke('pause-automation'),
  resumeAutomation: () => ipcRenderer.invoke('resume-automation'),
  finishAutomation: () => ipcRenderer.invoke('finish-automation'),
  getAutomationStatus: () => ipcRenderer.invoke('get-automation-status'),
  setAutostart: (enabled, time) => ipcRenderer.invoke('set-autostart', { enabled, time }),
  getAutostartStatus: () => ipcRenderer.invoke('get-autostart-status'),
  getPlan: () => ipcRenderer.invoke('get-plan'),
  getWarmupCounts: () => ipcRenderer.invoke('get-warmup-counts'),

  // File operations
  selectImage: () => ipcRenderer.invoke('select-image'),

  renameAccount: (oldName, newName) => ipcRenderer.invoke('rename-account', oldName, newName),

  // Settings
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Remote dashboard + licensing (proxies + remote-url + license-info are reached via the gated invoke()).
  // get-server-url / update-server-url are used by the separate license window's renderer.
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  updateServerUrl: (url) => ipcRenderer.invoke('update-server-url', url),

  // Event listeners
  onAutomationLog: (callback) => {
    ipcRenderer.on('automation-log', (event, log) => callback(log));
  },
  onAutomationStopped: (callback) => {
    ipcRenderer.on('automation-stopped', (event, code) => callback(code));
  },
  onAutomationSummary: (callback) => {
    ipcRenderer.on('automation-summary', (_e, summary) => callback(summary));
  },
  onAutomationStarted: (callback) => {
    ipcRenderer.on('automation-started', () => callback());
  },
  onLoginBrowserOpened: (callback) => {
    ipcRenderer.on('login-browser-opened', (event, accountName) => callback(accountName));
  },
  onLoginBrowserClosed: (callback) => {
    ipcRenderer.on('login-browser-closed', (event, accountName) => callback(accountName));
  },
  onRemoteUrlUpdate: (callback) => {
    ipcRenderer.on('remote-url-update', (event, url) => callback(url));
  },
  onDataUpdated: (callback) => {
    ipcRenderer.on('data-updated', () => callback());
  },
  onAutomationProgress: (callback) => {
    ipcRenderer.on('automation-progress', (_e, data) => callback(data));
  },
  onAutomationPaused: (callback) => {
    ipcRenderer.on('automation-paused', () => callback());
  },
  onAutomationResumed: (callback) => {
    ipcRenderer.on('automation-resumed', () => callback());
  },
  onAccountAttention: (callback) => {
    ipcRenderer.on('account-attention', (_e, info) => callback(info));
  },
  onLicenseUpdate: (callback) => {
    ipcRenderer.on('license-updated', () => callback()); // main pushes this on the ~6h re-validation so the badge/limits refresh without a restart
  },

  // Open the logs folder in the OS file explorer
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
});
