#Requires -RunAsAdministrator
# ZaPost — one-time setup for a home laptop that runs the app 24/7 and is managed over RDP.
# Run ONCE as Administrator:
#   Right-click this file -> "Run with PowerShell" (as admin), OR from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File rdp-keepalive-setup.ps1
#
# It does three things so a run NEVER stalls while you're disconnected:
#   1) Stops the laptop sleeping / turning off the display (machine-level backstop; the app also blocks
#      sleep while a run is active).
#   2) Stops the screensaver locking.
#   3) On RDP disconnect, re-attaches your session to the console so the off-screen browsers keep painting.
$ErrorActionPreference = 'Stop'
Write-Host '== ZaPost RDP / unattended setup ==' -ForegroundColor Cyan

# 1) Never sleep / never turn off display or disk (AC + battery), no hibernate, lid-close does nothing.
Write-Host '1) Disabling sleep / display-off / hibernate...'
powercfg /change standby-timeout-ac 0   ; powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0   ; powercfg /change monitor-timeout-dc 0
powercfg /change disk-timeout-ac 0      ; powercfg /change disk-timeout-dc 0
powercfg /change hibernate-timeout-ac 0 ; powercfg /change hibernate-timeout-dc 0
powercfg /hibernate off 2>$null
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 2>$null
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 2>$null
powercfg /setactive SCHEME_CURRENT 2>$null

# 2) Don't lock via screensaver.
Write-Host '2) Disabling screensaver lock...'
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f | Out-Null

# 3) Re-attach the session to the console on RDP disconnect (the real fix for "works until I disconnect").
Write-Host '3) Registering the RDP-disconnect keepalive task (runs as SYSTEM on Event ID 24)...'
$keep = Join-Path $PSScriptRoot 'rdp-keepalive.ps1'
if (-not (Test-Path $keep)) { throw "rdp-keepalive.ps1 was not found next to this script ($keep)" }
$tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $keep + '"'
schtasks /Create /TN "ZaPost RDP Keepalive" /SC ONEVENT /EC "Microsoft-Windows-TerminalServices-LocalSessionManager/Operational" /MO "*[System[(EventID=24)]]" /TR $tr /RU "SYSTEM" /RL HIGHEST /F | Out-Null

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'The laptop will not sleep, and disconnecting RDP will no longer freeze the posting browsers.'
Write-Host 'Test it: start a run, disconnect RDP, wait ~5 min, reconnect — the run should have kept going.'
Write-Host 'To undo the keepalive task later:  schtasks /Delete /TN "ZaPost RDP Keepalive" /F'
