# Vivaldi Workspace Helper

Vivaldi's workspaces are great, but nothing built-in gets you *to* the right
one quickly and safely — its own per-workspace shortcut can silently
reassign whatever window is currently focused, hiding tabs you didn't mean
to touch (see the planning doc's "Rejected approach" section for why that
ruled out the obvious Keyboard Maestro + built-in-shortcut approach). This
project is three features that each solve a different piece of "get me to
the right workspace window without that happening":

- **Feature 1 — auto-jump for externally-opened routed tabs.** A link opened
  from another app (or similar) that Vivaldi's "open websites in workspaces
  automatically" rule (Settings → Workspace Rules) routes to a workspace
  takes you there immediately: switches to the window already showing that
  workspace, or creates a new window and assigns it if none exists yet. No
  toast, no click — it just happens.
- **Feature 2 — toast + jump for routed tabs opened from inside Vivaldi.**
  Cmd+clicking a link (or opening a new tab and entering a URL) that gets
  routed to a workspace shows a toast naming where it went. Click the toast
  to jump there — creating and assigning a window first if one doesn't
  exist yet, so the tabs already in the foreground window aren't disturbed.
  You can also trigger that same jump *without* clicking, via an external
  hotkey utility (see below for why that has to be external rather than a
  keybinding inside Vivaldi's own page JS).
- **Feature 3 — jump-to-workspace hotkeys, triggered from outside Vivaldi.**
  A hotkey (via Keyboard Maestro or similar) that activates Vivaldi and
  switches to whichever window is showing a *specific, named* workspace —
  creating and assigning a new window for it if none exists yet. Useful for
  e.g. a global hotkey that always takes you to wherever your Claude
  conversations are routed, whenever you want to use Claude, regardless of
  whether that window already happens to be open.
- **Feature 4 — move the current tab(s) to a named workspace, triggered from
  outside Vivaldi.** A workaround for a confirmed Vivaldi bug (still present
  as of 8.1.4087.64): its own "Move Active Tab to Workspace" keyboard
  shortcuts and the tab's right-click → Move → *[workspace]* menu both
  silently do nothing at all. This reimplements that action from outside
  Vivaldi — bind `Ctrl+Shift+<N>` (or whatever) via Keyboard Maestro to move
  whatever tab(s) are currently selected to a named workspace, creating and
  assigning a window for it first if none exists yet.

Features 1 and 2 are two branches of the same underlying detection code and
share one install step. Feature 4 reuses that same install (just a different
relay endpoint) — see its own section below for the Keyboard Maestro setup.
Feature 3 is a separate, older mechanism (CDP instead of injected page JS)
with its own install step. All four can be installed independently of each
other.

For the full design rationale (including a rejected first approach and every
bug found along the way), see
[`Vivaldi workspace helper planning.md`](Vivaldi%20workspace%20helper%20planning.md).
[`CLAUDE.md`](CLAUDE.md) orients an AI assistant to the codebase; this file
is just the human install guide.

## Prerequisites

- macOS (uses AppleScript/System Events throughout — Vivaldi has no
  workspace-assignment API of its own).
- [Node.js](https://nodejs.org/) (tested with the Homebrew build,
  `/opt/homebrew/bin/node`).
- Vivaldi, obviously.

---

## Features 1 & 2: routed-tab auto-jump and toast+jump (recommended)

Both live in `injected/workspace-route-watcher.js` (detection logic,
injected into `main.html`) and `injected/window-toast.js` (the toast itself,
injected into every window's `window.html`) — one install covers both
features. Which one you get for a given tab depends entirely on how Vivaldi
routed it, not on any setting: tabs Vivaldi treats as foreground-intent
(external opens) get Feature 1's automatic jump; everything else Vivaldi
treats as background (cmd+click, etc.) gets Feature 2's toast.

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

The relay (`relay/server.js`) is what lets an external hotkey ask Vivaldi to
jump to the last routed tab (Feature 2, without clicking the toast), and is
also how the injected script asks a real OS process to assign a workspace to
a brand-new window — page JS can't drive System Events itself, so both
features depend on this being up whenever a target workspace needs a
brand-new window created and assigned.

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

Once the two steps above are done, both features are live with no further
setup:

- **Feature 1**: a tab opened by another app that Vivaldi routes to a
  workspace jumps you straight there — creating and assigning a window
  first if that workspace doesn't have one yet.
- **Feature 2**: a tab backgrounded by the user themself from inside
  Vivaldi (cmd+click, or opening a new tab and typing a URL) instead shows a
  toast naming the destination; click it to jump — again creating and
  assigning a window first if needed, so nothing already in the current
  window gets disturbed.

### 4. (Optional) External hotkey for Feature 2's jump, without clicking the toast

Useful for reaching a toast that already disappeared, or for jumping to a
background-routed tab without touching it at all. This is external by
necessity, not by choice: an injected script running inside `window.html`
*can* listen for keydowns, but only while keyboard focus happens to be on
Vivaldi's own chrome — a `<webview>` (i.e. the actual page you're looking
at) runs in a separate process, and its keydowns never reach `window.html`'s
own `document`. That's a real ceiling confirmed live, not something fixable
in JS — Vivaldi's own native shortcuts are intercepted at a privileged level
no injected page script can reach. (An earlier version of this project did
try an in-page ⌥⌘J listener anyway; it was removed once this external path
existed and made that partial, focus-dependent coverage fully redundant —
see the planning doc's 2026-08-09 section.)

Pick one of the options below — all three just hit the same relay endpoint,
`GET http://127.0.0.1:8877/jump-last-routed`, so it's fine to set up more
than one:

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
  logs (the watcher/detection logic, both features).
- `vivaldi://inspect/#apps` → a specific open window → inspect, for
  `[VWH-toast]`-prefixed logs (Feature 2's toast itself).
- `window.__vwh` is exposed at runtime in `main.html`'s console:
  `__vwh.workspaceStore`, `__vwh.lastRoutedTab`, `__vwh.jumpToLastRoutedTab()`.
- Relay connection state/errors: `~/Library/Logs/vivaldi-workspace-relay.log`.

---

## Feature 3: jump-to-workspace hotkeys, triggered from outside Vivaldi (CDP-based)

Unlike Features 1 & 2, this isn't reacting to a routed tab — it's a hotkey
you trigger yourself, for a specific workspace you name in advance, from
anywhere. Example: bind a global hotkey to `workspace-jump.js "Claude"` so
you always land in your Claude workspace's window (creating and assigning it
if it doesn't currently have one) with a single keypress, whether or not it
happened to already be open.

This works over the Chrome DevTools Protocol rather than injected page JS,
so it needs Vivaldi running with `--remote-debugging-port` enabled at all
times.

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
node /path/to/vivaldi-workspace-helper/bridge/workspace-jump.js "Claude"
```

— replace `Claude` with the actual name of the workspace that macro targets
(don't leave in any placeholder brackets/angle brackets; the exact string
here is what gets matched against your real workspace names). Bound to
whatever hotkey you want for that workspace. First run may prompt
for Accessibility/Automation permission for Keyboard Maestro Engine to
control Vivaldi via System Events — allow it once.

The script prints `FOCUSED`, `ASSIGNED`, `NOT_DEBUG_MODE` (Vivaldi isn't
running with the debug port — relaunch via `Vivaldi Debug.app`), or
`ERROR:<message>`; wire Keyboard Maestro's action up to react to that if you
want feedback beyond the window switch itself.

---

## Feature 4: move the current tab(s) to a named workspace (works around a Vivaldi bug)

Confirmed live (2026-08-13): Vivaldi's own "Move Active Tab to Workspace N"
keyboard shortcuts (`Ctrl+Shift+0`–`9` by default) and the tab's right-click
→ **Move** → *[workspace name]* menu both silently do nothing — no error, no
tab movement, no indication anything was attempted. Reproduced with this
project's own scripts completely uninstalled, so it isn't caused by
anything here; it's an upstream Vivaldi bug (see the planning doc's
2026-08-13 section for the full repro, and consider filing/upvoting a bug
report on the [Vivaldi forum](https://forum.vivaldi.net/)). This feature
reimplements the action ourselves via the extension API, triggered
externally, as a working replacement.

Needs the same install as Features 1 & 2 above (`injected/install.sh` +
the relay) — nothing extra to install, just a different relay endpoint:

```
GET http://127.0.0.1:8877/move-selected-tabs-to-workspace?workspace=<name>
```

Moves whatever tab(s) are currently selected (the active tab, or a
cmd+click multi-selection across several tabs) in Vivaldi's focused window
to the named workspace — creating and assigning a window for it first if
none exists yet, exactly like Features 1–3 already do, so nothing already
in that window gets disturbed. Shows a small "Moved N tab(s) to `<emoji>`
`<name>`" toast when it's done.

**First use will prompt for an Accessibility/Automation permission** — the
relay drives Vivaldi's Window menu via System Events (same as Feature 3's
bridge script) whenever it needs to create and assign a new workspace
window, so macOS asks you to approve Node controlling System Events/Vivaldi
the first time that actually happens. Allow it once; it won't ask again.

### Wire up a Keyboard Maestro macro per workspace

One macro per workspace, each bound to a hotkey (e.g. `Ctrl+Shift+2`, in
place of Vivaldi's own broken shortcut for that slot) running:

```
curl -s -G --data-urlencode "workspace=Claude" \
  http://127.0.0.1:8877/move-selected-tabs-to-workspace
```

— replace `Claude` with the actual name of the workspace that macro targets
(no placeholder brackets — that's a real, exact workspace name, matched
literally against what's configured in Vivaldi). `--data-urlencode` handles
workspace names containing spaces correctly — don't just paste the name
straight into the URL. Same mirrored pattern as Feature 3's per-workspace
macros, just hitting the relay instead of running the CDP bridge script.

Response is JSON: `{"ok":true, "windowId":…, "tabCount":…, "workspaceName":…, "created":…}`
on success, or `{"ok":false, "reason":…}` — `"UNKNOWN_WORKSPACE"` (name
didn't match any configured workspace), `"NO_SELECTED_TABS"` (shouldn't
normally happen — the active tab is always at least itself), `"NOT_CONNECTED"`
(relay is up but nothing's connected from the browser side — reinstall/
restart Vivaldi), or `"TIMEOUT"`.

**Known limitation — tab stacks.** A selected tab that's part of a Vivaldi
tab stack/group gets ungrouped as part of the move (there's no Chrome
extension API for moving a group across windows, only within one) — so it
arrives at the destination as a standalone tab, not still stacked with its
former neighbors. Moving a *lot* of stacked tabs to a brand-new window in
one go may still be less reliable than moving one or two at a time; if a
move ever reports `"ok":true` but a tab doesn't visibly land anywhere, that
was empirically the case even after the 2026-08-13 fixes for this exact
scenario — likely the same underlying Vivaldi flakiness as the broken
native shortcut this feature works around, not something fixable from the
extension side. See the planning doc's 2026-08-13 section for the full
investigation.

---

## Uninstalling

- Features 1, 2 & 4: delete the `<script>` tags injected into `main.html`/
  `window.html` (re-running `install.sh` after removing the source files
  will fail — easiest is to reinstall/repair Vivaldi, or manually edit those
  two HTML files), `launchctl unload` + remove the LaunchAgent plist, remove
  the extension via `vivaldi://extensions` if installed, remove any Feature 4
  Keyboard Maestro macros.
- Feature 3: remove the Keyboard Maestro macros, delete
  `/Applications/Vivaldi Debug.app`, go back to launching Vivaldi normally.
