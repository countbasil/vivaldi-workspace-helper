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
  `__vwh.workspaceStore`, `__vwh.lastRoutedTab`, `__vwh.jumpToLastRoutedTab()`,
  `__vwh.linkRoutesController` (Feature 5's rules API, `.getRules()`/
  `.addLinkRoutingRule(type, expression, workspaceId)`/
  `.removeLinkRoutingRules(ids)`), `__vwh.addWorkspaceRule(...)`,
  `__vwh.openAddRuleDialogForFocusedWindow()`, `__vwh.jumpToWorkspace(name)`
  (Feature 3's relay-based path).
- Relay connection state/errors: `~/Library/Logs/vivaldi-workspace-relay.log`.

---

## Feature 3: jump-to-workspace hotkeys, triggered from outside Vivaldi

Unlike Features 1 & 2, this isn't reacting to a routed tab — it's a hotkey
you trigger yourself, for a specific workspace you name in advance, from
anywhere. Example: bind a global hotkey to jump to "Claude" so you always
land in your Claude workspace's window (creating and assigning it if it
doesn't currently have one) with a single keypress, whether or not it
happened to already be open.

There are two ways to do this — pick one:

- **Relay-based (recommended)** — same mechanism as Features 2, 4 & 5: no
  CDP, no debug port, no special launcher app. Needs the same install as
  those (`injected/install.sh` + the relay running).
- **CDP-based (original method)** — the first version of this feature,
  predating the relay/injected-script approach entirely. Needs Vivaldi
  always running with `--remote-debugging-port`, via the special
  `Vivaldi Debug.app` launcher. Kept working for anyone already relying on
  it; not the recommended path for a fresh install.

### Relay-based (recommended)

Hits a new relay endpoint:

```
GET http://127.0.0.1:8877/jump-to-workspace?workspace=<name>
```

— focuses the window currently showing the named workspace, or creates a
new blank window and assigns it there if none exists yet, exactly mirroring
what the CDP script below does. Response: `{"ok":true, "windowId":…,
"created":…, "workspaceId":…, "workspaceName":…}`, or `{"ok":false,
"reason":…}` — `"MISSING_WORKSPACE_PARAM"` (400, query param absent),
`"UNKNOWN_WORKSPACE"` (name didn't match any configured workspace), plus the
usual `"NOT_CONNECTED"`/`"TIMEOUT"`.

Wire up a Keyboard Maestro macro per workspace (or any hotkey tool), each
bound to a hotkey and running:

```
curl -s -G --data-urlencode "workspace=Claude" \
  http://127.0.0.1:8877/jump-to-workspace
```

— replace `Claude` with the actual name of the workspace that macro targets
(no placeholder brackets — `--data-urlencode` handles names containing
spaces correctly, so don't paste the name straight into the URL). Same
mirrored pattern as Feature 4's per-workspace move macros.

First use that needs to *create* a window will prompt for an
Accessibility/Automation permission, same as Feature 4 — the relay drives
Vivaldi's Window menu via System Events. Allow it once.

### CDP-based (original method)

This works over the Chrome DevTools Protocol rather than injected page JS,
so it needs Vivaldi running with `--remote-debugging-port` enabled at all
times.

#### 1. Build and install the debug launcher

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

#### 2. Install the bridge script's dependencies

```
cd bridge
npm install
```

#### 3. Wire up a Keyboard Maestro macro per workspace

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
in that window gets disturbed. Focus deliberately stays on the window you
triggered the move from — the moved tab(s) aren't followed there
automatically. Instead, a "Moved N tab(s) to `<emoji>` `<name>`" toast
appears with a click-to-switch action, and the same jump is reachable from
outside Vivaldi too:

```
GET http://127.0.0.1:8877/jump-last-moved-tabs
```

— focuses whichever window the most recent move landed in, whether or not
its toast is still on screen. Bind this to its own hotkey alongside the
per-workspace move macros below if you want a keyboard-only way to follow
a move without reaching for the mouse.

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

Response is JSON: `{"ok":true, "windowId":…, "sourceWindowId":…, "tabCount":…,
"workspaceId":…, "workspaceName":…, "created":…}` on success (`windowId` is
the destination the tabs moved to; `sourceWindowId` is the window focus
stayed on), or `{"ok":false, "reason":…}` — `"UNKNOWN_WORKSPACE"` (name
didn't match any configured workspace), `"NO_SELECTED_TABS"` (shouldn't
normally happen — the active tab is always at least itself), `"NOT_CONNECTED"`
(relay is up but nothing's connected from the browser side — reinstall/
restart Vivaldi), or `"TIMEOUT"`.

`GET /jump-last-moved-tabs` responds `{"ok":true, "windowId":…}` (the window
it just focused) or `{"ok":false, "reason":…}` — `"NO_RECENT_MOVE"` (nothing
moved yet this session), `"TARGET_WINDOW_GONE"` (that window was closed
since), plus the same `"NOT_CONNECTED"`/`"TIMEOUT"` as above.

**How a "move" actually works, and what that costs.** Rather than moving a
tab to its destination window, this closes the original and creates a new
one there with the same URL. That's not the obvious choice — it's a
deliberate workaround: Chrome's own cross-window `chrome.tabs.move` turned
out to be unreliable in this Vivaldi build, confirmed live via CDP —
"moved" tabs were correct in every API-visible way (title, active state)
but permanently missing from the tab strip itself, unreachable by clicking
or Ctrl+Tab, even after waiting or forcing a UI redraw. Recreating the tab
avoids that bug entirely (going through the same code path a normal Cmd+T
uses), but it means **a moved tab loses its own back/forward navigation
history and any unsaved in-page state** (form input, scroll position beyond
what the URL encodes). A stray tab from a tab stack also arrives at the
destination as a standalone tab, not still stacked with its former
neighbors — there's no way to preserve a stack across a window boundary at
all. See the planning doc's 2026-08-13 sections for the full live-diagnosis
trail (this took two rounds of fixes to actually nail down).

**If your destination window ends up with a new tab stack you didn't ask
for**, that's Vivaldi's own "automatically create tab stacks" setting, not
something this project is doing — confirmed live: creating a tab via a
genuine `Cmd+T` in a window that already has exactly one tab produces the
*exact same* stack, with no Feature 4 involvement at all. There's no
extension API this project can use to prevent it (Vivaldi's tab-stack
membership lives in a proprietary field not exposed to `chrome.tabs`, and
directly overwriting it is silently ignored). If you don't want this,
disable that Vivaldi setting; it's not something Feature 4 can control on
a per-move basis.

---

## Feature 5: create a workspace rule from inside the browser

Lets you add a workspace rule (Settings → Workspace Rules' "open websites
in workspaces automatically" list) for the current domain without ever
opening Settings. Two ways to bring up the dialog:

- **Right-click any page** → "Create workspace rule for this site…" (works
  right-clicking on text, links, images, etc., not just blank background —
  see the note below on why that needed a fix. Not available by
  right-clicking the *tab* itself — confirmed live that Vivaldi's tab-strip
  menu isn't extension-augmentable at all, see `CLAUDE.md`)
- **An external hotkey**, same relay pattern as the other features:
  ```
  GET http://127.0.0.1:8877/open-add-rule-dialog
  ```
  (opens the dialog for the active tab in Vivaldi's currently focused
  window — bind it the same way as Feature 2's external hotkey above, e.g.
  via macOS Shortcuts.app)

Either way, a "Create workspace rule" dialog appears **centered on the
window**, pre-filled with the current tab's domain (a leading `www.` is
stripped, so the rule also matches the site without that prefix) and a
list of your workspaces below it. Click a workspace to create the rule
immediately — no separate "Add" button, since picking the workspace *is*
the submission. Clicking outside the dialog cancels without creating
anything (Escape does *not* dismiss it — confirmed live that Vivaldi
doesn't deliver Escape, Enter, Space, or the arrow keys to this dialog's JS
at all, so click-away is the only way).

**Keyboard shortcuts** (letters only, since the keys above are all
off-limits — each hinted inline via a "(X)" in its own label or, for j/k,
next to the "(W)orkspace:" header): `j`/`k` move the highlighted workspace
down/up (the first workspace is pre-selected when the dialog opens),
`(U)RL` (or the ✎ button) focuses the domain field, `(W)orkspace` returns
focus to the list and re-selects the first entry, `(M)ove`/`(O)pen` toggle
the two checkboxes below, and `(C)ancel`/`(S)ave new Rule` — a row at the
bottom of the dialog — back out or finish, the closest available
equivalent to Escape/Enter (which don't reach this dialog at all). Tab also
cycles focus through the list, the two checkboxes, and the URL field in
that order — though whether Tab actually reaches this dialog at all hasn't
been confirmed yet, unlike the letter keys (see `CLAUDE.md`). All of the
letter shortcuts are inert while you're actively typing in the domain
field, so a domain containing one of these letters is never mistaken for a
shortcut.

**"Also (M)ove this tab now"** — checkbox below the workspace list. When
checked, submitting also moves the current tab to the chosen workspace
immediately (not just future navigations). A second, indented checkbox —
**"...and (O)pen that workspace"** — only enabled when the first is
checked, controls whether you follow the tab there or stay put (same "stay
on the source window" behavior as Feature 4's move). Both checkboxes are
sticky — they remember their last state across dialog opens and even
Vivaldi restarts.

A confirmation toast ("Rule created: `<domain>` → `<emoji>` `<name>`",
plus "Tab moved" if applicable) appears on success — interactive
(click-to-switch) if the tab moved but you didn't switch to it, otherwise
just informational.

Needs the same install as Features 1 & 2 (`injected/install.sh` + the
relay) — nothing extra to install.

**How it works, and why it doesn't need any UI automation.** Unlike
workspace *assignment* (Feature 3/4's territory, which genuinely has no
extension API and has to drive Vivaldi's own Window menu via AppleScript),
routing rules turned out to have a real one: reading the actual
`Preferences` file on disk shows rules live at
`vivaldi.workspaces.link_routes` as `{id, type, expression, workspaceId}`
entries, and the same webpack-module-scanning technique this project
already uses for `workspaceStore` (see `CLAUDE.md`) finds a sibling
"link-routes controller" module exposing `addLinkRoutingRule(type,
expression, workspaceId)`. Calling it dispatches the identical Redux action
Vivaldi's own Settings page uses, which updates the live rule state
immediately and persists to `Preferences` on Chromium's normal (debounced)
schedule — confirmed via a scripted add/remove/re-read of the real
`Preferences` file. `type` is always `"CONTAINS"` for rules added through
this dialog (matching what a plain domain-only rule looks like when added
through Settings); `STARTSWITH`/`EQUALS` aren't exposed in the UI.

**Why the right-click item needed to cover more than "page".** Right-clicking
directly on text (rather than blank background) puts Chrome into a
`"selection"` context rather than `"page"` — confirmed live that a
`"page"`-only menu item simply doesn't appear there, which in practice made
it show up only when right-clicking genuinely empty space on a page (rare,
since most pages are mostly text). Fixed by registering the item for `"all"`
contexts instead.

**Two Vivaldi quirks, worked around automatically.** The context-menu item
can get silently wiped moments after this script first creates it —
confirmed live via a tight polling test: present ~1.5s after launch, gone
by ~1.8s, seemingly cleared by some part of Vivaldi's own startup sequence
finishing after this script's own (very early) init runs. A short retry
schedule re-verifies and re-creates the item until it sticks. Separately,
it can also disappear again well after startup — confirmed live after a
single real use — so every click of the item is also followed by one more
quiet re-check shortly after, just in case using it is (part of) what
triggers that. Neither needs any configuration or should be noticeable.

---

## Feature 6: per-workspace new-tab-page override

Vivaldi only has one global "New Tab Page" setting (Settings → Tabs → New
Tab Page) — no way to give an individual workspace its own. This lets one or
two specific workspaces override it: e.g. Cmd+T inside the "Claude"
workspace opens `claude.ai` directly instead of the global Speed
Dial/blank page/whatever else is configured. Everywhere else, Vivaldi's own
setting is untouched.

Needs the same install as Features 1, 2, 4 & 5 (`injected/install.sh` +
Vivaldi restart) — nothing extra to install, but **this one is configured
by editing the source file directly**, not through any in-browser UI:

```js
// injected/workspace-route-watcher.js
const NEW_TAB_OVERRIDES = {
  Claude: "https://claude.ai",
};
```

Add one entry per workspace name (must match the real workspace name
exactly) → URL you want Cmd+T to open there, then re-run
`injected/install.sh` and restart Vivaldi. There's deliberately no dialog or
settings UI for this, unlike the other features — it's meant for the couple
of workspaces you'd actually want it for, not general configuration.

**How it works.** A brand-new tab reports one of two placeholder URLs the
instant it's created, depending on how it was opened — a real Cmd+T settles
permanently on `about:blank` (confirmed with an actual keystroke, not just
simulated), while a programmatically-created blank tab uses Chromium's
`chrome://newtab/` instead. A listener on tab creation matches either one
and redirects immediately if the window it landed in is currently
displaying a workspace with an entry above — but skips any tab that has an
`openerTabId` set (i.e. opened by a page's own JavaScript, like an OAuth
popup), so a legitimate blank popup a site opens for itself is never
hijacked.

**Known gap.** A workspace's *brand-new* window — the one created the first
time you jump to a workspace that doesn't have one yet (Features 3/4/5) —
leaves its own default blank tab on Vivaldi's regular New Tab Page, not the
override. Confirmed live: at the moment that particular tab is created, the
window doesn't have a workspace assigned yet, so there's nothing yet to
match against. Only affects that one leftover tab in a freshly-created
window; every subsequent Cmd+T in that same window works normally.

---

## Uninstalling

- Features 1, 2, 4, 5 & 6, and Feature 3's relay-based path: delete the
  `<script>` tags injected into `main.html`/`window.html` (re-running
  `install.sh` after removing the source files will fail — easiest is to
  reinstall/repair Vivaldi, or manually edit those two HTML files; this also
  removes Feature 5's context menu item, since it's registered by the same
  script), `launchctl unload` + remove the LaunchAgent plist, remove the
  extension via `vivaldi://extensions` if installed, remove any Feature 3/4
  Keyboard Maestro macros.
- Feature 3's CDP-based path (if you set it up instead of, or alongside, the
  relay-based one): remove those Keyboard Maestro macros, delete
  `/Applications/Vivaldi Debug.app`, go back to launching Vivaldi normally.
