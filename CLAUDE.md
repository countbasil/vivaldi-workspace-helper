# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Working implementation. See
[Vivaldi workspace helper planning.md](Vivaldi%20workspace%20helper%20planning.md)
for the full history (including a rejected first approach) and rationale —
this file just orients you to the pieces.

## Goal and architecture

Keyboard shortcuts that jump directly to a specific Vivaldi workspace,
activating Vivaldi and creating a new window bound to that workspace if none
exists yet, without ever silently reassigning an unrelated existing window
(Vivaldi's built-in per-workspace shortcut alone will do that — see the
planning doc's "Rejected approach" section for why this isn't just a
Keyboard Maestro macro sending `Control-N`).

The real design queries Vivaldi's internal workspace store live over the
Chrome DevTools Protocol to know, before acting, whether the target
workspace is already open in some window — then either focuses that window
directly or creates a fresh blank one and assigns it via the safe built-in
shortcut. Requires Vivaldi to always run with `--remote-debugging-port`
enabled.

- `bridge/workspace-jump.js` — Node/CDP bridge; the actual decision logic.
  Run `npm install` in `bridge/` once before first use.
- `wrapper-app/VivaldiDebugLauncher.applescript` — source for the compiled
  `/Applications/Vivaldi Debug.app`, which is how Vivaldi must always be
  launched (Dock/Login Items) so the debug flag is never missing.
- Keyboard Maestro (external) — one macro per workspace, calling the bridge
  script and sending a keystroke if it signals `SEND_DIGIT:<n>`.

If you're picking this project back up, read the planning doc's "Decided
approach" section before changing the bridge script or wrapper app — the
constraints there (no workspace-assignment API, module IDs unstable across
builds, the AppleScript-applet default-browser limitation) came from
extensive empirical testing, not assumptions.
