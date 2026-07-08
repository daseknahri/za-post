# Running ZaPost on a home laptop over RDP (24/7, unattended)

This is the setup for: **the app is installed on a laptop that stays on forever; you connect with Remote
Desktop only to Start/Stop runs and add posts, then disconnect.**

## Why a plain RDP disconnect can break a run

The posting accounts each run a **real Chromium window** (not headless — that's deliberate, it's far less
detectable). Those windows are positioned off-screen so they don't clutter the desktop. When you **disconnect**
an RDP session, Windows tears down the session's virtual display. With no display, off-screen Chromium **stops
painting**: button clicks compute zero-size coordinates and page reads come back empty — so posts/comments can
fail. (While you're *connected*, everything is fine.)

## The fix — run the setup script once

On the laptop, in an **Administrator** PowerShell:

```powershell
cd "<install folder>\scripts"
powershell -ExecutionPolicy Bypass -File rdp-keepalive-setup.ps1
```

It does three things:

1. **No sleep / no display-off / no hibernate / lid-close = nothing** — so the machine never powers down a run.
2. **No screensaver lock.**
3. **Re-attaches your session to the console on disconnect** — a scheduled task (runs as SYSTEM, triggered on
   the RDP-disconnect event) runs `rdp-keepalive.ps1`, which uses `tscon` to move the disconnected session back
   to the physical console. That keeps a live display attached, so the browsers keep painting after you leave.

**Test:** Start a run → disconnect RDP → wait ~5 minutes → reconnect. The run should have kept going.

To remove the keepalive task later: `schtasks /Delete /TN "ZaPost RDP Keepalive" /F`

## What the app already does for you (no setup needed)

- **Blocks system + display sleep while a run is active** (`powerSaveBlocker`) — released the moment you Stop.
- **Auto-pauses on system suspend and resumes on wake** — a hard sleep won't corrupt a run.
- **Crash-resume** — if the laptop reboots mid-run, the app offers to resume where it left off.
- Caption/landing checks read the editor in a **layout-independent** way, so a brief display hiccup can't make
  it lose or double a caption.

## Recommended

- Use a wired connection or stable Wi-Fi on the laptop.
- One stable proxy per account (Accounts tab) so all traffic for an account is consistent.
- Leave the laptop logged in to Windows (the keepalive keeps that session live).
