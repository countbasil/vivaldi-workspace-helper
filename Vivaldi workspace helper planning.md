# Vivaldi workspace helper 

I would like to implement a scheme in which I have keyboard shortcuts that will jump immediately to a specified workspace in Vivaldi, and create a new window with the workspace if that workspace is not already open in an existing window. So if I create a shortcut ^⌘c for the Claude workspace, the following would happen when i press ^⌘c:
    - Vivaldi activates
    - if there's a window bound to the workspace "Claude", that window activates
    - otherwise, a new window is opened and assigned to that workspace.  

Tools that could be used include Keyboard Maestro, AppleScript, Vivaldi/chrome extension, whatever else you recommend.

## Rejected approach: pure Keyboard Maestro + built-in shortcut (2026-08-04)

First attempt: just send Vivaldi's built-in `Control-N` "Go to Workspace N"
shortcut (already bound `^1`-`^9` in Settings → Keyboard) after ensuring a
window exists. **Rejected as destructive**: if the current frontmost window
isn't already on the target workspace, and no *other* window has that
workspace either, the shortcut reassigns the *current* frontmost window to
the target workspace — silently hiding whatever tabs were showing (they
don't close, but become invisible except via `^⇧A` tab search or
most-recent-tab navigation). A naive macro can't tell those two cases apart
without knowing which workspace every open window currently has — Vivaldi
exposes no such thing via window titles, the macOS Window menu, or the
accessibility tree (confirmed empirically: an `entire contents` walk of a
window's UI element tree bottoms out through the page's own web content,
never branching into the toolbar/workspace-switcher at all).

## Decided approach (validated 2026-08-04)

Vivaldi's internal React/Redux workspace store *does* expose exactly the
needed state — `Map<workspaceId, windowId>` for every open window, keyed by
workspace (so a given workspace can only be active in one window at a time)
— but it's not a public API. It's reached via the Chrome DevTools Protocol
(CDP), using the same technique validated in the sibling project
`vivaldi-theme-switcher`: harvest `__webpack_require__` by pushing a no-op
chunk onto `window.webpackChunkgapp_browser_react`, then scan the module
factory registry for a unique source-code signature
(`getActiveWorkspaceId(e){return this.getState().activeWorkspaces.get`) to
find and instantiate the workspace store module. Module IDs aren't stable
across Vivaldi builds; the signature string is, since it's unminified
Vivaldi source text embedded in the bundle.

This lives in Vivaldi's `main.html` (a single shared invisible host document
for the whole browser — not per-window `window.html`, which is just the
visible chrome). Confirmed store methods:
`getWorkspaces()` (all workspaces), `getActiveWorkspaces()` (live
`Map<workspaceId, windowId>`), `getWorkspaceById(id)` (→ name). No
setter/assignment method exists — the store is read-only, confirmed via
`Object.getOwnPropertyNames(Object.getPrototypeOf(store))`. So assignment
still goes through a native Vivaldi UI action, but only ever against a
**brand-new blank window** (safe — nothing to lose), never the possibly-
unrelated frontmost one.

Assignment mechanism, final version: **not** the `Control-N` keystroke
(first attempt — unreliable, raced against the new window's focus timing
even with generous delays and an explicit re-focus). Instead, System Events
clicks the native menu path **Window → Other Workspaces and Tabs →
`<name>` → Activate** (confirmed reliable). This is a true native NSMenu
(unlike Vivaldi's web-rendered browser chrome), addressable by workspace
*name* directly — no need to derive/track a slot-position digit at all.
Menu traversal in System Events: a menu bar item's dropdown, and a menu
item's own submenu, are both reached via `menu 1 of <element>` (singular);
`menus of <element>` (plural) silently returns nothing. Also: querying/
clicking another app's menu structure via System Events requires that app
to be frontmost first — a backgrounded app's menu bar reports its top-level
items but not their contents.

This collapses the original 4 cases to 2 branches, queried live via CDP
before acting:
- **Workspace found in the map** → `chrome.windows.update(windowId, {focused: true})` directly (works even across macOS Spaces — confirmed).
- **Workspace not found** → `chrome.windows.create()` (blank window) → click the workspace's `Activate` menu item to assign it.

### Components (this repo)

- **`bridge/workspace-jump.js`** — Node script, `node workspace-jump.js
  "<WorkspaceName>"`. Connects to Vivaldi's `main.html` CDP target, runs the
  harvest, and either focuses the right window directly or creates a blank
  one and assigns it via the Window-menu click, all in one call — nothing
  further needed from the caller. Requires `npm install` in `bridge/` first
  (dependency: `chrome-remote-interface`).
- **`wrapper-app/VivaldiDebugLauncher.applescript`** — source for the
  compiled `/Applications/Vivaldi Debug.app`. Always launches/activates
  Vivaldi with `--remote-debugging-port=9222` (Chromium can't add the flag
  to an already-running process, so this must be the *only* way Vivaldi
  ever gets cold-started). Also handles `on open location` so it can forward
  URLs if ever pointed at by something else — registered with LaunchServices
  as an http/https handler, though it turned out **not** eligible to appear
  in System Settings' "Default web browser" picker (likely because it's a
  compiled AppleScript applet — Apple probably excludes that category from
  the picker specifically as an anti-hijacking measure; a real fix would
  mean rebuilding it as a compiled native app, not worth it for what's a
  narrow edge case — see below).
- Keyboard Maestro (external, not in this repo) — one macro per workspace.

### Accepted tradeoffs

- **Security**: `--remote-debugging-port` has no built-in auth; any local
  process running as the same user could read/control Vivaldi (sessions,
  cookies, everything) via it. It's loopback-only (not network-reachable),
  and ordinary webpages are blocked from reaching it too (Chromium validates
  the WebSocket `Host` header against DNS-rebinding). Risk is specifically
  "something with local code execution as you decides to look" — accepted
  as reasonable for a personal single-user machine.
- **Default browser**: `Vivaldi Debug.app` is *not* the system default
  browser (couldn't get it listed as a candidate). This only matters for a
  narrow edge case — a stray link click from another app cold-starting
  Vivaldi without the flag before any workspace hotkey has run that
  session, breaking the *next* hotkey press until Vivaldi is quit and
  relaunched via the wrapper. Regular `Vivaldi.app` remains the default
  browser for normal link-opening; the debug flag is only needed at the
  moment a workspace hotkey actually fires, and the Keyboard Maestro macros
  already launch via the wrapper themselves regardless of system
  default-browser status. Mitigate the residual edge case, if desired, by
  adding `Vivaldi Debug.app` to Login Items so it's always the first thing
  running each session.

### Keyboard Maestro macro (one per workspace)

`workspace-jump.js` handles everything itself, including assigning the
workspace (via the Window-menu click through `osascript`/System Events)
when it creates a new window — KM doesn't need to send any keystroke or
click anything itself. It always prints one distinct stdout token as its
last line, so KM can still branch on outcome for alerting on failure (its
Execute Shell Script action only captures stdout by default, not stderr —
the more detailed diagnostic text is still on stderr for manual/Terminal
use):

| Output starts with | Meaning | KM should |
|---|---|---|
| `FOCUSED` | Existing window focused | Nothing more |
| `ASSIGNED` | Blank window created and assigned | Nothing more |
| `NOT_DEBUG_MODE` | Can't reach CDP port — likely a non-debug Vivaldi is already running (see "Accepted tradeoffs" above) | Alert: quit Vivaldi, relaunch via "Vivaldi Debug" |
| `ERROR:<message>` | Some other failure | Alert with the message |

**Note**: the menu-click needs macOS **Accessibility** permission for the
calling process (distinct from the **Automation** permission used for
reading state) — Keyboard Maestro Engine needs this for its own native
keystroke/UI-scripting features anyway, so it's very likely already
granted; if not, System Settings → Privacy & Security → Accessibility will
prompt/need it added the first time.

1. Trigger: Hot Key (e.g. `^⌘C` for "Claude")
2. Action: "Execute Shell Script", **save result to a variable** (not "to
   Nothing" — needed for step 3 to test it). Use `node`'s absolute path —
   KM's Execute Shell Script doesn't load `.zshrc`/`.zprofile`, so a
   Homebrew-installed `node` won't be on its PATH otherwise (confirm your
   own path with `which node` — this was `/opt/homebrew/bin/node` when
   validated):
   ```
   open -a "/Applications/Vivaldi Debug.app"
   /opt/homebrew/bin/node ~/Developer/vivaldi-tools/vivaldi-workspace-helper/bridge/workspace-jump.js "Claude"
   ```
3. "If/Then" on that variable's text: starts with `NOT_DEBUG_MODE` or
   `ERROR:` → "Display Text Briefly" / notification with the variable's
   contents, so a failure is visible instead of the hotkey silently doing
   nothing. (No action needed for `FOCUSED`/`ASSIGNED`.)

Build one macro by hand, then duplicate per workspace, changing only the
trigger key and the workspace name in step 2 — no digit/slot-position
tracking anywhere, in KM or the script, since assignment now targets the
workspace by name via the Window menu.
