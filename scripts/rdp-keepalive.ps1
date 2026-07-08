# ZaPost RDP keepalive — re-attach a DISCONNECTED RDP session to the physical console so the desktop keeps
# rendering. The app's posting browsers are real (headed) Chromium windows positioned off-screen; when an RDP
# session disconnects, Windows removes the virtual display and those windows STOP PAINTING — clicks compute
# zero-size rectangles and reads come back empty. Re-attaching the session to the console restores a live
# display so automation keeps working while you're away.
#
# This runs automatically as SYSTEM (no password needed) via the scheduled task that
# rdp-keepalive-setup.ps1 registers — triggered on RDP-disconnect (Event ID 24). You normally never run it
# by hand.
$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Seconds 2  # let the disconnect settle before re-attaching

# qwinsta columns: SESSIONNAME  USERNAME  ID  STATE  TYPE  DEVICE   (a leading '>' marks the current session)
$rows = qwinsta 2>$null
foreach ($row in $rows) {
  $line = $row -replace '^[>\s]+', ''        # strip the leading marker / indentation
  $cols = $line -split '\s+'
  for ($i = 0; $i -lt $cols.Count - 1; $i++) {
    if ($cols[$i] -match '^\d+$') {           # first purely-numeric column = session ID
      $id = $cols[$i]; $state = $cols[$i + 1]
      if ($state -match '^Disc') { tscon $id /dest:console 2>$null }  # reattach the disconnected one to console
      break
    }
  }
}
