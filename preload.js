const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Data operations
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  getData: () => ipcRenderer.invoke('get-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),

  // Post operations
  addPost: (post) => ipcRenderer.invoke('add-post', post),
  deletePost: (postId) => ipcRenderer.invoke('delete-post', postId),
  editPost: (postId, updates) => ipcRenderer.invoke('edit-post', postId, updates),

  // Group operations
  addGroup: (group) => ipcRenderer.invoke('add-group', group),
  deleteGroup: (groupId) => ipcRenderer.invoke('delete-group', groupId),
  addPostsBulk: (posts) => ipcRenderer.invoke('add-posts-bulk', posts),
  addGroupsBulk: (items) => ipcRenderer.invoke('add-groups-bulk', items),

  // Account operations
  createAccount: (accountName, alias) => ipcRenderer.invoke('create-account', accountName, alias),
  loginAccount: (accountName) => ipcRenderer.invoke('login-account', accountName),
  checkAccountStatus: (accountName) => ipcRenderer.invoke('check-account-status', accountName),
  deleteAccount: (accountName) => ipcRenderer.invoke('delete-account', accountName),
  importCookies: (accountName, cookies) => ipcRenderer.invoke('import-cookies', accountName, cookies),
  closeLoginBrowser: (name) => ipcRenderer.invoke('close-login-browser', name),
  toggleAccount: (name, enabled) => ipcRenderer.invoke('toggle-account', name, enabled),
  setAccountCredentials: (name, email, password) => ipcRenderer.invoke('set-account-credentials', name, email, password),

  // Automation operations
  startAutomation: () => ipcRenderer.invoke('start-automation'),
  stopAutomation: () => ipcRenderer.invoke('stop-automation'),
  pauseAutomation: () => ipcRenderer.invoke('pause-automation'),
  resumeAutomation: () => ipcRenderer.invoke('resume-automation'),
  finishAutomation: () => ipcRenderer.invoke('finish-automation'),
  getAutomationStatus: () => ipcRenderer.invoke('get-automation-status'),

  // File operations
  selectImage: () => ipcRenderer.invoke('select-image'),

  // Settings
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Event listeners
  onAutomationLog: (callback) => {
    ipcRenderer.on('automation-log', (event, log) => callback(log));
  },
  onAutomationStopped: (callback) => {
    ipcRenderer.on('automation-stopped', (event, code) => callback(code));
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

  // Open the logs folder in the OS file explorer
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
});
