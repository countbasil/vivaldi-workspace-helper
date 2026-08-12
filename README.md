# Vivaldi Workspace Helper

Keyboard-driven jumping to a specific Vivaldi workspace — activating Vivaldi
and creating/assigning a new window if the workspace isn't open yet, without
ever silently reassigning an unrelated existing window — plus a toast+jump
system for tabs that Vivaldi's "open websites in workspaces automatically"
rule routes into the background.

For the full design rationale (including a rejected first approach and every
bug found along the way), see
[`Vivaldi workspace helper planning.md`](Vivaldi%20workspace%20helper%20planning.md).
[`CLAUDE.md`](CLAUDE.md) orients an AI assistant to the codebase; this file
is just the human install guide.

Two independent features live here — install only the one(s) you want:

- **Feature 1 — jump-to-workspace hotkeys**: `bridge/` + `wrapper-app/` +
  Keyboard Maestro. Requires Vivaldi to always run with
  `--remote-debugging-port` enabled.
- **Feature 2 — toast + auto-jump for routed tabs**: `injected/` + `relay/`
  (+ optional `extension/`). No debug port required.

They don't depend on each other. Feature 2 is the actively-developed one and
the recommended starting point.

## Prerequisites

- macOS (uses AppleScript/System Events throughout — Vivaldi has no
  workspace-assignment API of its own).
- [Node.js](https://nodejs.org/) (tested with the Homebrew build,
  `/opt/homebrew/bin/node`).
- Vivaldi, obviously.

---

## Feature 2: toast + auto-jump for routed tabs (recommended)

### 1. Install the injected scripts

```
cd injected
./install.sh
```

This patches `main.html` and every window's `window.html` inside the
**currently installed** Vivaldi version to load
`workspace-route-watcher.js` and `window-toast.js`. It auto-detects the
newest version folder under
`/Applications/Vivaldi.app/Contents/Frameworks/Vivaldi Framework.framework/Versions/`.

Quit and fully relaunch Vivaldi afterward — `main.html`/`window.html` are
only read at their own startup.

**You must re-run this after every Vivaldi update.** An update installs a
new version folder, and the patch only lives in the one it was applied to —
the new one starts unpatched. There's no way around re-running it; this
project doesn't hook the update process itself.

### 2. Install and run the relay

The relay is what lets an external hotkey (or the optional extension) ask
Vivaldi to jump to the last auto-routed tab, and is also how the injected
script asks a real OS process to assign a workspace to a brand-new window
(page JS can't drive System Events itself).

```
cd relay
npm install
```

Keep it always running via a LaunchAgent:

```
cp com.aaron.vivaldi-workspace-relay.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.aaron.vivaldi-workspace-relay.plist
```

The bundled plist points at `/opt/homebrew/bin/node` and this repo's
absolute path — edit both if your setup differs. Logs go to
`~/Library/Logs/vivaldi-workspace-relay.log`.

After editing `server.js` or the plist:

```
launchctl unload ~/Library/LaunchAgents/com.aaron.vivaldi-workspace-relay.plist
launchctl load ~/Library/LaunchAgents/com.aaron.vivaldi-workspace-relay.plist
```

### 3. What you get automatically, with nothing further to configure

Once the two steps above are done:

- A tab opened by another app (or pasted URL, etc.) that Vivaldi routes to a
  different workspace jumps you straight there — creating and assigning a
  window first if that workspace doesn't have one yet.
- A tab backgrounded by the user themself (e.g. cmd+click) instead shows a
  toast naming the destination; click it (or press the hotkey below) to jump.

### 4. (Optional) External hotkey for "jump to last routed tab"

Useful for reaching a toast that already disappeared, or for cmd+click
routes without touching the toast. Pick one — all three just hit the same
relay endpoint, `GET http://127.0.0.1:8877/jump-last-routed`, so it's fine
to set up more than one:

1. **macOS Shortcuts.app (recommended)** — new shortcut with a single "Get
   Contents of URL" action pointed at
   `http://127.0.0.1:8877/jump-last-routed` (GET), then give it a keyboard
   shortcut via the shortcut's own Details pane → "Add Keyboard Shortcut".
   Works as a real OS-level global hotkey, even when Vivaldi isn't
   frontmost.
2. **`extension/`** — a small unpacked extension
   (`manifest.json` + `background.js`) with a `chrome.commands` shortcut
   (suggested ⌥⌘J) whose service worker `fetch()`es the relay endpoint.
   Install via `vivaldi://extensions` → enable Developer Mode → Load
   unpacked → select `extension/`. Vivaldi has a known bug where
   extension-declared shortcuts in the default scope often don't fire; if
   so, switch the command's scope to "Global" under `vivaldi://extensions` →
   Keyboard Shortcuts. Also note: any unpacked extension makes Chromium show
   a "Disable Developer Mode Extensions" warning on every startup.
3. **Keyboard Maestro** — hotkey → "Execute Shell Script" →
   `curl -s http://127.0.0.1:8877/jump-last-routed`. Only worth it if you
   already have Keyboard Maestro for other things.

You can also just use Vivaldi's own Quick Commands (`⌘E`, or `tab:` to
search only open tabs) to find a routed tab manually, without any of the
above — it can find tabs sitting in a workspace with no window open, unlike
the History menu.

### Debugging

- `vivaldi://inspect/#apps` → **main.html** → inspect, for `[VWH]`-prefixed
  logs (the watcher/detection logic).
- `vivaldi://inspect/#apps` → a specific open window → inspect, for
  `[VWH-toast]`-prefixed logs (the toast itself).
- `window.__vwh` is exposed at runtime in `main.html`'s console:
  `__vwh.workspaceStore`, `__vwh.lastRoutedTab`, `__vwh.jumpToLastRoutedTab()`.
- Relay connection state/errors: `~/Library/Logs/vivaldi-workspace-relay.log`.

---

## Feature 1: jump-to-workspace hotkeys (CDP-based)

### 1. Build and install the debug launcher

```
cd wrapper-app
osacompile -o "Vivaldi Debug.app" VivaldiDebugLauncher.applescript
mv "Vivaldi Debug.app" /Applications/
```

From now on, **always launch Vivaldi via `Vivaldi Debug.app`** — Dock icon,
Login Items, default-browser handler, all of it — instead of Vivaldi.app
directly, so it's never accidentally started without
`--remote-debugging-port` (which would break the bridge script below until
you quit and relaunch it correctly).

### 2. Install the bridge script's dependencies

```
cd bridge
npm install
```

### 3. Wire up a Keyboard Maestro macro per workspace

One macro per workspace, each running:

```
node /path/to/vivaldi-workspace-helper/bridge/workspace-jump.js "<workspace name>"
```

bound to whatever hotkey you want for that workspace. First run may prompt
for Accessibility/Automation permission for Keyboard Maestro Engine to
control Vivaldi via System Events — allow it once.

The script prints `FOCUSED`, `ASSIGNED`, `NOT_DEBUG_MODE` (Vivaldi isn't
running with the debug port — relaunch via `Vivaldi Debug.app`), or
`ERROR:<message>`; wire Keyboard Maestro's action up to react to that if you
want feedback beyond the window switch itself.

---

## Uninstalling

- Feature 2: delete the `<script>` tags injected into `main.html`/
  `window.html` (re-running `install.sh` after removing the source files
  will fail — easiest is to reinstall/repair Vivaldi, or manually edit those
  two HTML files), `launchctl unload` + remove the LaunchAgent plist, remove
  the extension via `vivaldi://extensions` if installed.
- Feature 1: remove the Keyboard Maestro macros, delete
  `/Applications/Vivaldi Debug.app`, go back to launching Vivaldi normally.
