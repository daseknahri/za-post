// Minimal preload for the license + revoked windows so they can run with contextIsolation:true /
// nodeIntegration:false (no full Node/require exposed to their HTML). Exposes ONLY the few channels those
// windows need, on window.licenseAPI.
const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
  validate: (key) => ipcRenderer.send('validate-license-async', key),
  onResult: (cb) => ipcRenderer.on('license-validation-result', (_e, result) => cb(result)),
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  updateServerUrl: (url) => ipcRenderer.invoke('update-server-url', url),
  retry: () => ipcRenderer.send('retry-license'),
  // https-only external open (the revoked window's contact link) — never opens arbitrary schemes.
  openExternal: (url) => { try { if (/^https:\/\//i.test(String(url))) shell.openExternal(String(url)); } catch {} },
});
