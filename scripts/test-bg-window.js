// Verify the "send window to background" mechanism (visible-mode focus-no-steal) on this machine.
// Launches a real visible Chromium window, pushes it BEHIND other windows via the same encoded
// PowerShell SetWindowPos call worker.js uses, and reports the window handle it moved.
// Run: node scripts/test-bg-window.js
const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');

function sendWindowToBackground(pid) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class ZaBg{[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);}',
    '"@',
    `for($i=0;$i -lt 20;$i++){$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if(-not $p){break}; $p.Refresh(); $h=$p.MainWindowHandle; if($h -ne [IntPtr]::Zero){$r=[ZaBg]::SetWindowPos($h,[IntPtr]1,0,0,0,0,0x13); Write-Output ('OK handle='+$h+' result='+$r); break}; Start-Sleep -Milliseconds 200}`,
  ].join('\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((res) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
    { timeout: 15000, windowsHide: true }, (e, so) => res((so || '').trim() || '(no stdout — handle not found)')));
}

const chrome = path.join(__dirname, '..', 'chrome-bin', 'chrome.exe');
const prof = path.join(os.tmpdir(), 'za-bg-' + Date.now());
const c = spawn(chrome, ['--no-first-run', '--no-default-browser-check', '--new-window', 'about:blank',
  '--window-position=300,300', '--window-size=700,500', '--user-data-dir=' + prof], { detached: true });
c.on('error', (e) => { console.log('spawn error:', e.message); process.exit(1); });
setTimeout(async () => {
  const out = await sendWindowToBackground(c.pid);
  console.log('chrome pid', c.pid, '->', out);
  console.log(out.startsWith('OK') ? 'RESULT: send-to-background WORKS on this machine.' : 'RESULT: could not move the window — needs a different approach.');
  try { process.kill(c.pid); } catch {}
  setTimeout(() => process.exit(0), 800);
}, 3000);
