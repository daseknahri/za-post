// Confirm Windows toast notifications work for the captcha/login alerts.
// Run: node_modules/electron/dist/electron.exe scripts/test-notif.js
const { app, Notification } = require('electron');
app.setAppUserModelId('com.zapost.commenttool');
app.whenReady().then(() => {
  console.log('Notification.isSupported():', Notification.isSupported());
  try {
    const n = new Notification({ title: 'Za Post — test alert', body: 'If you see this, captcha/login alerts will work.' });
    n.show();
  } catch (e) { console.log('notification error:', e.message); }
  setTimeout(() => app.quit(), 2000);
});
