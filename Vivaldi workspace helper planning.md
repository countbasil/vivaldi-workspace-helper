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

## Second feature: toast + jump for auto-routed background tabs (2026-08-08)

Vivaldi's "open websites in workspaces automatically" rule (Settings →
workspace rules) can route an incoming URL — opened from another app, or
clicked while browsing — into a window/workspace that isn't currently
focused, with nothing telling the user it happened. This adds a visible
toast naming the destination, with click-to-jump and a keyboard-shortcut
fallback.

**Key decision: this does *not* extend `bridge/workspace-jump.js`'s CDP
model.** The sibling `vivaldi-theme-switcher` project already solves "react
immediately to Vivaldi workspace/tab events" a different way: it patches
Vivaldi's own `main.html` to load a plain JS file (`custom.js`) that runs
*inside* Vivaldi's process and calls `workspaceStore.addListener(...)`
directly — no external process, no CDP connection to keep alive. Given the
stated intent to eventually merge this feature's functionality with the
theme-switcher, this feature follows that same injected-script pattern
instead.

That still leaves one gap the theme-switcher's pattern doesn't need to
solve: getting an *external* hotkey press into the already-running injected
script, for the "jump to last routed tab" fallback. The options considered:

- **CDP one-shot** (matching `workspace-jump.js`'s existing style) — works,
  but reintroduces the `--remote-debugging-port` dependency this feature
  otherwise wouldn't need at all.
- **Native messaging** (`chrome.runtime.connectNative`) — would let Chromium
  itself manage the external process, but whether that API even works from
  this privileged non-extension `main.html` context is unconfirmed, and
  didn't seem worth the risk to validate over the simpler option below.
- **A tiny local WebSocket relay** (chosen) — the injected script opens an
  *outbound* `WebSocket` to a small local Node process (`relay/server.js`,
  just the `ws` package); an external hotkey hits that process over plain
  HTTP (`curl`), which relays the request over the existing WebSocket and
  returns the reply. No CDP, no debug port, no bespoke client needed for the
  hotkey side at all — just `curl`.

This also opened a bigger question: could the *same* relay approach replace
CDP for the original per-workspace jump feature too, removing the
`--remote-debugging-port` requirement (and `wrapper-app/`) entirely, making
the whole tool shareable as a plain GitHub repo? Yes, in principle — but
that means rewriting already-relied-upon Keyboard Maestro macros and
retiring the debug launcher, which is a materially bigger and riskier change
than adding a new feature. **Explicit decision: scope the relay to this new
feature only.** `bridge/workspace-jump.js`, `wrapper-app/`, and the existing
per-workspace macros are untouched. If the relay proves reliable in daily
use, migrating the original feature onto it — and retiring CDP/the debug
port/wrapper app entirely, opening the door to open-sourcing the tool — is a
natural follow-up, not started here.

### Design

`injected/workspace-route-watcher.js` (loaded via `injected/install.sh`,
same technique as `install-vivaldi-mods.sh`):

- Resolves the workspace store the same way as `custom.js` (same signature
  string). Tracks the last real focused window id via
  `chrome.windows.onFocusChanged` (ignoring `WINDOW_ID_NONE`, which fires
  when Vivaldi itself loses focus to another app, so a rule firing while the
  user is elsewhere still compares against the right window).
- On `chrome.tabs.onCreated`, if the tab's window isn't the last-focused one,
  waits for `chrome.tabs.onUpdated` (`status: complete`) or a 2s timeout to
  get a real title, resolves the destination workspace name by
  reverse-looking-up `getActiveWorkspaces()`, and shows a
  `chrome.notifications` toast. `chrome.notifications.onClicked` jumps
  straight to the tab.
- Also opens a `WebSocket` to `relay/server.js` and handles
  `{type:"jumpLastRouted"}` requests from it the same way notification
  clicks are handled — this is the *only* thing the relay can trigger, a
  much narrower surface than CDP's general remote-eval.

`relay/server.js` — WebSocket server (page connects in) + a single HTTP
route, `GET /jump-last-routed` (hotkey calls in via `curl`), correlated by a
per-request id with a 3s timeout. Kept alive via
`relay/com.aaron.vivaldi-workspace-relay.plist` (LaunchAgent).

### Verified 2026-08-08

Confirmed end-to-end against the live app (Vivaldi 8.1.4087.62), without
using an actual configured workspace rule — instead simulated the trigger
condition directly (`chrome.windows.create({focused:false})` +
`chrome.tabs.create` in that window), which exercises the same
`chrome.tabs.onCreated`-in-a-non-focused-window path a real rule match
would:

- Webpack harvest + workspace store resolution succeeded on first try
  (returned all 7 real workspace names).
- Detection fired, `chrome.notifications.create` succeeded (visible in
  `chrome.notifications.getAll()`; not visually screenshotted).
- The injected script connected to the relay automatically after a Vivaldi
  restart; `curl http://127.0.0.1:8877/jump-last-routed` round-tripped
  correctly both when nothing had been routed yet (`NO_RECENT_ROUTE`) and
  after a synthetic route (correctly focused the exact window and selected
  the exact tab, confirmed via a follow-up CDP query).
- Confirmed the relay recovers: reports `NOT_CONNECTED` immediately when the
  page disconnects.

**Not yet verified** (needs the user's own follow-up): a *real* configured
workspace rule with an actual link click/external-app open; whether the
macOS notification banner is visually granted/visible (API calls succeeded
without error, but this wasn't screenshotted); the relay running as an
actual loaded LaunchAgent rather than a plain background process (loading
it was blocked by an automated permission check during this session, since
installing a persistent auto-starting service is the kind of action worth a
human's explicit go-ahead rather than doing it silently).

### Real-world testing found two bugs and prompted a UI redesign (2026-08-08, later same day)

Testing against a real, already-configured workspace rule (github.com →
"Devel") surfaced two bugs the synthetic test above didn't:

1. **cmd+click was only sometimes detected.** Root cause found by installing
   a temporary debug listener via CDP and watching real events: cmd+click
   doesn't create the tab directly in the destination window. It creates it
   as a background tab in the *current* window first (matching normal
   cmd+click semantics), and Vivaldi's rule engine then *moves* it to the
   destination window a moment later. `chrome.tabs.onCreated` only ever saw
   the first step (same-window, correctly not flagged), and the actual
   cross-window move fires `chrome.tabs.onAttached`, which nothing was
   listening for. Confirmed the fix by scripting the exact same two-step
   sequence via CDP (`chrome.tabs.create` in the focused window, then
   `chrome.tabs.move` to another window) and watching `onAttached` catch it.
   Opening a URL from another app (confirmed via Spotlight) or the address
   bar apparently *does* create the tab directly in the destination window in
   one step, so `onCreated` alone already covered that path — both listeners
   are needed, not just one.
2. **A brand-new window's own initial tab was misdetected as a background
   route** (e.g. cmd+N showed a spurious toast for its own about:blank tab;
   cmd+T, a same-window new tab, correctly did not). Cause: `onCreated` for
   that first tab can fire before the corresponding `onFocusChanged` event
   for the new window itself catches up, so the tracked "last focused
   window" was still stale at the instant of the comparison. Fixed by also
   listening to `chrome.windows.onCreated` and trusting its `focused` flag
   immediately, rather than waiting on `onFocusChanged`.

Separately, once the feature was working, the user asked to drop
`chrome.notifications` entirely in favor of a custom in-page toast: shown in
the upper-right of the *current* (i.e. currently-focused) window's viewport,
configurable display duration, exact wording `"<domain> tab opened in 🤓
<workspace>\nClick or ⌥⌘J to switch"`, and an in-page keyboard shortcut so
jumping doesn't require Keyboard Maestro at all while the toast is visible.

This forced a second injection point. `workspace-route-watcher.js` runs in
`main.html`, which is invisible and has no viewport — it cannot draw
anything on screen itself. The toast is drawn by a new sibling script,
`injected/window-toast.js`, injected into `window.html` (Vivaldi's visible
*per-window* chrome document; confirmed via CDP that `chrome.windows`/
`chrome.runtime` are reachable there too, same as `main.html`). `main.html`
broadcasts a `vwh-show-toast` runtime message (`chrome.runtime.sendMessage`,
no target ID — delivered to every extension page); every open window's
`window-toast.js` instance receives it, but only the one whose own window id
matches the message's `displayWindowId` actually renders anything. Clicking
the toast, or pressing ⌥⌘J while it's showing (listener only attached while
visible, not global), sends a `vwh-jump-request` message back to
`main.html`, which does the actual focus/activate — reusing the same
`jumpToTab(windowId, tabId)` helper the relay path already used.
`injected/install.sh` was generalized to patch both `main.html` and
`window.html` (each script only checks for/inserts its own tag, so this
still coexists with `vivaldi-theme-switcher`'s tag in `main.html`).

Verified end-to-end again after this rewrite (simulating the real
create-in-current-window-then-move-to-destination sequence via CDP): the
toast rendered with the exact requested text in the focused window's
`window.html` only (confirmed the *other* window's instance rendered
nothing), and both the click path and the ⌥⌘J path correctly focused the
destination window, activated the correct tab, and dismissed the toast. One
inconclusive data point: in one synthetic-click test the tab-activation half
of the jump worked but the window-focus half didn't visibly stick — the
*identical* code path (`jumpToTab`) fully succeeded moments later via the
keyboard-shortcut test, so this looks like an artifact of triggering a
"click" via CDP script while the real OS focus was on Terminal (not
something to expect in normal use, where Vivaldi already has focus when the
user actually clicks or presses the shortcut) rather than a real bug — worth
a quick sanity check with a genuine mouse click, but not blocking.

**Still not yet verified**: the actual visual appearance/styling of the
toast (never screenshotted, only checked via DOM inspection over CDP); the
`⌥⌘J` shortcut against a genuine hardware key-press (only synthetic
`KeyboardEvent` dispatch was tested) and whether it collides with any
existing Vivaldi shortcut binding.

### More real-world bugs found and fixed (2026-08-08, still later same day)

Live use against real workspace rules surfaced a deeper issue than either
prior round, plus three smaller ones. All fixed and re-verified via CDP
(again against the live app, not a sandbox).

**A tab's own workspace is not the same thing as its window's displayed
workspace, and the difference is exactly where this feature was wrong.**
`workspaceStore.getActiveWorkspaces()` (what every workspace-name lookup so
far had used) only reports which workspace each *window* is currently
*displaying* — but per the planning doc's very first "Rejected approach"
section, a window can hold tabs from other workspaces too, hidden until that
workspace becomes the displayed one. When a rule routes a tab to a workspace
that has no window of its own, Vivaldi doesn't necessarily create one — it
can park the tab, hidden, inside whatever window it lands in, which keeps
displaying its own, different, already-open workspace. Confirmed this isn't
even a rare edge case: a live check found over a dozen tabs from tonight's
own earlier testing already in exactly this state (tagged as the "Devel"
workspace internally, physically sitting in a window displaying "Tech",
because "Devel" never had its own open window all evening). The fix,
confirmed by inspecting a live `chrome.tabs.Tab` object over CDP: every tab
carries its own workspace id directly, in a JSON string on
`tab.vivExtData.workspaceId` — completely independent of
`getActiveWorkspaces()`. `resolveWorkspaceForTab(tab)` now reads that
instead, fixing both the toast's reported name and, transitively, the jump
target.

Reading the correct workspace name was only half of it — **jumping to a tab
whose workspace isn't currently displayed doesn't bring it on screen either.**
Confirmed live: calling `chrome.tabs.update(tabId, {active:true})` on such a
tab does mark it internally active, but the window's displayed workspace
(per `getActiveWorkspaces()`) doesn't change, so nothing new becomes visible
— exactly matching the original "no setter/assignment method exists" finding
for the workspace store itself. The fix reuses the *existing* mechanism:
`jumpToTab` now checks whether the destination window is already displaying
the tab's workspace, and if not, asks `relay/server.js` (a real OS process,
unlike page JS) to run the identical Window-menu-click AppleScript
`bridge/workspace-jump.js`'s `activateWorkspaceViaMenu` already uses. This
required extending the relay's WebSocket protocol to be bidirectional: it
already relayed hotkey-triggered requests *into* the page; now the page can
also send a request *out* (`{type:"activateWorkspace", requestId,
workspaceName}`), correlated by the same requestId pattern, just with the
roles reversed. Confirmed live: activating "Devel" this way not only
switched the display but pulled the routed tab along into whichever window
the activation actually landed in — Vivaldi keeps a workspace's tabs
together on activation, so the end result (the user can actually see and
reach the tab) holds even though the specific window differed from the one
`chrome.windows.update` had targeted moments earlier (see the small
unresolved item on that below).

Three smaller bugs, all fixed in the same pass:

- **Cmd+N regression.** The previous fix (trusting `chrome.windows.onCreated`'s
  `focused` flag) still wasn't reliable enough on its own — event ordering
  between a new window's `onCreated` and its first tab's `onCreated` isn't
  something to depend on. Replaced the whole cached-focus-tracking approach
  (`lastKnownFocusedWindowId` plus its `onFocusChanged`/`onCreated`
  listeners) with a simpler, more robust check: on any candidate tab, wait
  `BACKGROUND_CHECK_DELAY_MS` (200ms) and then query
  `chrome.windows.getLastFocused()` fresh, live, at decision time, rather
  than trusting anything cached from earlier events. Confirmed live: a real
  `chrome.windows.create({})` (focused, like Cmd+N) no longer produces a
  toast for its own initial tab.
- **⌥⌘J silently never fired.** Root cause: the handler checked `e.key ===
  "j"`, but holding Option on macOS remaps `e.key` to whatever
  dead-key/special character that modifier produces on the current layout
  (e.g. "∆" for Option+J on a US layout) — never the literal letter. Fixed
  by checking `e.code === "KeyJ"` instead, which identifies the physical key
  independent of modifiers/layout. Worth flagging for future-self: the
  *first* "verified working" claim for this shortcut, earlier the same day,
  wasn't actually valid — that test fed a synthetic `KeyboardEvent` with
  `key: 'j'` directly, which is exactly the value a real Option-held
  keypress never produces, so it could never have caught this bug. Retested
  properly this time with `key: '∆', code: 'KeyJ'` (what a real press
  actually produces), confirming the fix.
- **Missing blank line in the toast text.** `\n` with `white-space:
  pre-line` renders as a single line break, not a blank line between the two
  requested lines. Changed to `\n\n`.

**Unresolved, minor**: in one test, `chrome.windows.update(windowId,
{focused:true})` didn't durably change `chrome.windows.getLastFocused()`'s
answer when driven from a CDP script while real OS focus was on Terminal —
consistent with the same flakiness noted in the very first round of testing
today, and still believed to be specific to driving focus changes from a
script rather than a real user session (where Vivaldi already has focus when
the user actually acts), not a bug in normal use. As noted above, Vivaldi's
own tab-follows-workspace-activation behavior papers over this anyway for
the hidden-workspace jump case. Not reproduced or investigated further
given it hasn't affected any real (non-scripted) interaction tonight.

### Jumping to a windowless workspace was silently reassigning an existing window (2026-08-08, still later)

The previous round's fix for "jump to a tab whose workspace has no window"
worked (it correctly brought the tab on screen), but *how* it did so was
wrong: it activated the workspace via whatever window the AppleScript menu
click happened to land on, force-switching that window away from whatever
*it* was already displaying. That's exactly the silent-reassignment problem
described in this doc's very first "Rejected approach" section — the entire
reason this project doesn't just use Vivaldi's built-in per-workspace
shortcut. Reintroducing it, even only for this one code path, broke the
project's own founding principle.

Fixed by making `jumpToTab` mirror `bridge/workspace-jump.js`'s own
two-branch decision exactly instead of inventing a different one:

- Workspace already has a window → focus *that* window (moving the routed
  tab into it first, if it's parked somewhere else — the "consolidate into
  the correct existing window" case).
- Workspace has no window → create a **new blank window**
  (`chrome.windows.create({})`), ask the relay to run the same
  `activateWorkspaceViaMenu` assignment `workspace-jump.js` uses (no extra
  focus call needed first — a freshly created window is already the focused
  one, same as `workspace-jump.js`'s own comment about this), then move the
  routed tab into it.

This needed `jumpToTab`'s signature to change from `(windowId, tabId,
workspaceName)` to `(tabId, workspaceId, workspaceName)` — the tab's
*current* window at detection time is no longer a meaningful input at all,
since the target window is now always resolved fresh from the workspace,
never from wherever the tab happened to land. `workspaceId` (already
captured from `vivExtData` at detection time) is what's used to look up an
existing display window via `getActiveWorkspaces()`, since matching by id
rather than name-string is more precise anyway.

One related bug caught while wiring this up before it ever shipped: the
toast's display-only fallback text, `"(unknown workspace)"`, was being
echoed straight back through the jump-request message as if it were a real
workspace name — `jumpToTab` would have tried to create/activate a
workspace literally named `"(unknown workspace)"` for any tab whose
workspace couldn't be resolved. Fixed by keeping the raw (possibly `null`)
`workspaceName`/`workspaceId` in the message data used for the actual jump,
and applying the `"(unknown workspace)"` fallback only in `window-toast.js`'s
displayed text, never in the data forwarded onward.

Verified live: moved a real, pre-existing tab (tagged via `vivExtData` for
the "Work" workspace, which had no window open all session) into another
window to trigger detection, then called the fixed `jumpToLastRoutedTab()`.
Confirmed a brand-new window was created (window count went from 3 to 4, not
just reshuffled), "Work" became displayed there, the tab moved in and became
active, and — critically — the two other already-open windows' displayed
workspaces were completely unchanged before and after.

### The real windowless-workspace case still didn't detect at all, plus a wrong icon (2026-08-08, still later)

Real usage (Claude Code links, workspace "Claude") surfaced that the
previous fix's test wasn't actually representative of the true "no window
at all" case, plus a separate, simpler icon bug.

**Root cause, found by installing a temporary debug listener and watching
every event live over CDP**: when a rule targets a workspace with *no window
open anywhere*, Vivaldi doesn't move the tab cross-window at all — it just
tags the tab in place, in whatever window it was created in (typically the
focused one, since that's where a new background tab from cmd+click always
starts), via a `vivExtData` update roughly 300ms after creation. Confirmed
directly: `tab.windowId` never changed through the tab's entire observed
lifecycle, and `onAttached` never fired once. This means the *previous*
"windowless workspace" fix and its "Work" test weren't actually testing this
scenario — that test used `chrome.tabs.move` to relocate the tab to a
different existing window, which does fire `onAttached` and isn't what
Vivaldi does when there's truly no window to move to. Since our only two
detection paths (`onCreated`, gated on "is this a different window than
focused", and `onAttached`, gated on "did this tab just arrive via a
cross-window move") both require the tab to either start in, or move to, a
window other than the focused one, and this case does neither, detection
had a real, total blind spot for exactly the scenario the toast/jump feature
most needs to cover — a routed tab silently invisible, hidden in a window
displaying something else, with no signal at all that it happened.

Fixed with a third, independent detection path:
`chrome.tabs.onUpdated`, gated on `changeInfo.vivExtData` being present
(fires precisely when Vivaldi tags a tab's workspace, confirmed live it's a
distinguishable field, not something to infer from a broader "any update"
check). On that signal, `checkWorkspaceTagThenHandle` checks directly
whether the tab's own workspace (via `resolveWorkspaceForTab`) differs from
whatever its *current* window is displaying — regardless of whether the tab
ever changed windows at all — and routes into the same `handleBackgroundTab`
used by the other two paths. This is a fundamentally different check than
the other two (workspace-tag mismatch vs. background-window membership),
covering a case they structurally cannot.

Separately, **the toast's emoji was wrong for every workspace except one**:
`window-toast.js` had a single hardcoded `WORKSPACE_EMOJI` constant ("🤓"),
copied from the user's own example text in the original request — which
turned out to unknowingly be "Tech"'s actual configured emoji from Vivaldi's
own workspace settings (each workspace has a real, user-configurable `emoji`
field, confirmed via `getWorkspaces()`). So every toast, regardless of
destination, showed Tech's icon. Fixed by resolving the emoji the same way
as the name — from the tab's own workspace via `vivExtData` — and passing it
through `routedTab.workspaceEmoji` end to end, with a generic `❓` fallback
only for the rare unresolved case, replacing the static constant entirely.

Verified live, all three fixes together in one pass: created a claude.ai tab
directly in the focused window (the exact real-world repro, Claude workspace
had no window), confirmed `lastRoutedTab` populated correctly
(`workspaceEmoji: "🤖"`, Claude's real emoji), confirmed the toast text
showed 🤖 instead of 🤓, and confirmed `jumpToLastRoutedTab()` created a
genuine new window for Claude without disturbing the two other already-open
windows.

### Removed the settle delay, and confirmed the new-window path via a real click (2026-08-08, still later)

A further "new window not created" report turned out, on inspection of live
window/tab state, to most likely be a timing/sequencing artifact from
testing (an earlier test's leftover Claude window had already been closed
and replaced by a fresh one from the user's own real clicks, which is
actually the fix working correctly) rather than a fresh bug — but this was
also the first time the *real* click path got tested end-to-end (previous
verifications called `jumpToLastRoutedTab()` directly, skipping
`window.html`'s actual `chrome.runtime.sendMessage`). Confirmed live with an
actual DOM `.click()` on the toast element: detection, message delivery, and
new-window creation all worked identically to the direct-call tests. Added
`console.error` logging on jump failure in the `vwh-jump-request` handler
regardless, since nothing currently round-trips a failure back to the toast
(it already dismissed itself) — a silent failure there would otherwise leave
no trace at all.

Separately, acted on a good catch: `waitForTabInfo`'s up-to-2-second wait
for `status: "complete"` existed only to get a real page *title* for the
toast — which no longer displays a title at all (the redesigned toast text
is `"<domain> tab opened in <emoji> <workspace>"`). Removed the wait
entirely at first, but a live re-test caught a real regression before
shipping it: `url` (needed for the domain) isn't always populated
immediately either — one test showed a genuinely empty `url` at the instant
of detection. Landed on a middle ground, `waitForUrl`: resolve immediately
if the tab already has a URL (the common case, confirmed most of the time),
otherwise fall back to a much shorter bounded wait (1000ms, down from
2000ms) for `chrome.tabs.onUpdated` to report one. Re-verified: detection
now completes in under a second end-to-end with a correctly-populated
domain, instead of only after however long the page took to finish loading.

### The toast's own top edge was hidden behind Vivaldi's toolbar chrome (2026-08-08, still later)

A further "new window still not created" report, plus a very concrete
companion clue -- "clicking works only if you click the second line" --
pointed at something more specific than a logic bug: a portion of the toast
itself wasn't actually clickable. Inspected `window.html`'s live DOM
structure over CDP and found the cause directly: the toast was positioned
`top: 16px` relative to the *whole window*, but the actual web content
viewport (`.webpageview`/`webview`) started well below that (`y: 54` in the
inspected window, with a visible tab strip) -- meaning the toast's top
portion (roughly its first line) was rendered *underneath* whatever
toolbar/tab-strip chrome occupies that gap. `document.elementFromPoint()`
hit-testing at the toast's top edge confirmed it directly: something else
was receiving the click there, not the toast div. Since most users
naturally click near the top/center of a two-line toast, this silently
swallowed the majority of click attempts -- fully explaining both the
"only the second line works" report and, very plausibly, the *previous*
"new window not created" report too (a click that never registered looks
identical to a jump that silently failed).

Fixed by positioning the toast relative to the content viewport's own
`getBoundingClientRect()` instead of the window's -- `getContentViewportRect()`
finds the first `.webpageview`/`webview` element with non-zero size and
anchors `top`/`right` to its edges (falling back to the window's own edges
if no viewport element is found), which is also a more literal match for
what was originally asked for: "upper right of the web content viewport for
the current window," not the window as a whole. Verified live: hit-tested
four points spanning the toast's full height (top edge, first-line area,
middle, bottom edge) and confirmed all four now resolve to the toast div
itself, then confirmed clicking specifically at the former dead zone (the
top edge) correctly creates a new window end-to-end.

### Distinguishing how a tab was opened, and a fourth detection path for in-place foreground reassignment (2026-08-08, still later)

A natural follow-up question -- can a tab's origin (click, cmd+click,
address-bar entry, external app) be determined -- turned into real design
input once tested live, using the same debug-hook technique as always
(installed temporary listeners, asked for one real action at a time,
compared results):

| Action                     | `onCreated` fires? | `tab.active` | `openerTabId` |
|----------------------------|---------------------|--------------|---------------|
| cmd+click                  | yes                 | `false`      | set           |
| Address bar + Enter        | **no** (navigates in place) | --    | --            |
| External open (`open <url>`) | yes               | **`true`**   | absent        |

`tab.active` at creation time turned out to be exactly the signal needed --
already present on every tab object, no new instrumentation required. It
captures the real intent directly: cmd+click deliberately backgrounds the
tab, while an external open (and by the same logic, anything else meant to
be seen immediately) is `active: true`. Address-bar entry turned out to be a
non-issue for this feature entirely -- it never creates a new tab at all, so
it can never hit any of this code, and (matching what was found much
earlier) Vivaldi doesn't apply workspace rules to in-place navigation
either.

This fed into two real behavior refinements from live testing an actual
external link:

1. **External link routed to a workspace with an existing window
   elsewhere**: the tab goes there, but Vivaldi does *not* raise that window
   automatically -- so the existing passive click-to-jump toast needs to
   keep firing here (it already does; `tab.active` doesn't change anything
   about this path).
2. **External link routed to a workspace with *no* window at all**:
   confirmed live, Vivaldi does *not* create a new window for this case --
   it reassigns the *current foreground window's own displayed workspace*
   in place and loads the tab there. This is exactly the silent-reassignment
   behavior the whole project has always tried to avoid, just happening
   natively, entirely outside this tool's control, and invisible to every
   detection path built so far -- by the time any of them would check, the
   tab's workspace and its window's displayed workspace already agree, so
   nothing looks mismatched at all.

Added a fourth, independent detection path for case 2:
`workspaceStore.addListener` (the exact subscription mechanism
`vivaldi-theme-switcher` already uses for its own workspace-change
reactions, but never previously used in this project, which had only ever
called the store's one-shot getters). On each store change, compares the
*currently-focused* window's displayed workspace against a continuously
maintained baseline (`lastKnownFocusedWorkspaceId`), and -- critically --
only fires if there's a matching entry in `recentActiveTabWindows` (a
tab created with `active: true` in that same window within the last
`FOREGROUND_TAB_CORRELATION_MS`). That correlation is the whole point: without
it, this would also fire for the user's own manual workspace switches via
Vivaldi's own UI, which aren't routed tabs at all and shouldn't get a
route-related toast. This case gets its own distinct wording end to end --
`window-toast.js` now handles a `variant: "foreground-switch"` message with
"Foreground window switched to `<emoji>` `<name>`," no click/keyboard
target at all (the window is already on screen; there's nothing to jump
to).

First live test surfaced a genuine race between this new path and the third
(`onUpdated`/`vivExtData`) one: that path fires the instant a tab gets
tagged with its workspace, which can land *before* Vivaldi finishes the
in-place reassignment -- so at that instant the workspace still looks
windowless, and the old click-to-jump toast fired incorrectly (with correct
text, just the wrong toast entirely, moments before the real switch landed).
Fixed by having `checkWorkspaceTagThenHandle` skip firing whenever the tab
is already sitting in the currently-focused window -- that specific
situation is now understood to mean "either this resolves via the fourth
path, or nothing will ever change it," neither of which the click-to-jump
toast is the right response to. Re-verified live after the fix: the exact
same repro (an `active:true` tab routed to a windowless workspace, in the
focused window) now correctly produces only the new "Foreground window
switched" toast, with no spurious click-to-jump toast beforehand.

### Raising existing background windows, wording/opacity polish, and a global ⌥⌘J (2026-08-08, still later)

Four more refinements from continued live use, the first three
straightforward, the fourth (raising an existing background window)
surfacing a genuinely important discovery.

**Wording, dismiss-on-click, and opacity.** The "foreground-switch" toast
text changed to "Vivaldi changed window to `<emoji>` `<name>`", and both it
and (the not-yet-existing) informational toasts needed click-to-dismiss
rather than doing nothing on click. Generalized `window-toast.js`'s
`showToast` around a `variant` field: `"route"` (default) stays fully
interactive (click/⌥⌘J → jump); anything else is informational (click →
dismiss only). Also added `TOAST_OPACITY` (a background-alpha constant,
`0.6` by default) so the toast is translucent rather than solid, per
request -- text stays fully opaque either way, only the background fades.

**Raising an existing background window.** The user's own further testing
found one more gap: an externally-opened URL routed to a workspace that
*does* already have a window (just not the focused one) doesn't get raised
either -- Vivaldi just leaves the tab sitting there unfocused, exactly like
a cmd+click route would. Added a fifth behavior (not a new detection path --
it layers onto the existing three): if the tab landing in that other window
was originally foreground-intent, `handleBackgroundTab` raises the window
itself (`chrome.windows.update(..., {focused:true})`) and shows "Raised
window with `<emoji>` `<name>`" instead of the click-to-jump toast.

Implementing this exposed a real bug, caught by testing with **genuine**
external-open data rather than trusting a synthetic reproduction --
something this project has repeatedly needed to do, and here again the
synthetic version turned out to be misleading. The first version checked
`tab.active` on the *settled* tab (after `waitForUrl`), matching the
already-established `freshTab` pattern used everywhere else in
`handleBackgroundTab`. It never triggered. Installing a debug hook and
watching a real `open https://github.com/anthropics` from Terminal (routed
to a workspace with an existing, unfocused window) showed exactly why:
Vivaldi's own routing resets `tab.active` to `false` the moment the tab
lands via a cross-window move, *regardless of whether it started as
`active: true` or `active: false`*. A synthetic `chrome.tabs.move()` test
showed the identical reset, confirming it's a genuine, general Chromium/
Vivaldi tab-move behavior, not an artifact of either test. This means
`active` read on the tab at any point *after* a cross-window move is
useless for this purpose -- both cmd+click and external-open converge to
the same `false` value once landed, so they become indistinguishable
exactly when it matters. The fix: capture `tab.active` in
`chrome.tabs.onCreated` itself, before anything can move or mutate it, into
`tabOriginalActiveState` (a bounded `tabId -> boolean` map), and have
`handleBackgroundTab` look *that* up instead of trusting the settled tab's
current value. Re-verified live with the corrected logic: the same
create-then-move repro now correctly shows "Raised window with `<emoji>`
`<name>`" in the right window.

**Global ⌥⌘J.** Real-world use surfaced that the shortcut being scoped to
"only while a toast is visible" was a real problem in practice:
`TOAST_DURATION_MS` (8s) is easy to miss if attention is elsewhere for a
moment, and once the toast auto-dismissed, its keydown listener was removed
right along with it -- so the shortcut would appear to "just not work" for
completely mundane timing reasons, confirmed live via a debug hook logging
every keydown reaching `window.html` (nothing matching ⌥⌘J was ever
captured; the toast had already dismissed by the time it was pressed).
Changed to a single global listener attached once at `init()`, decoupled
from any toast's lifecycle entirely -- pressing it always asks `main.html`
to jump to whatever was most recently routed (a new `vwh-jump-last-routed`
message, handled by the existing `jumpToLastRoutedTab()`), the same
"whatever's most recent" semantics the relay's `jumpLastRouted` already
has, just reachable directly in-page. A toast's own click-to-jump
(`jumpToActiveTarget`) still targets that specific toast's tab and is
unchanged. Re-verified live: routed a tab, waited past `TOAST_DURATION_MS`
so the toast fully auto-dismissed, then dispatched ⌥⌘J with none visible --
correctly jumped anyway.

**Aside, unrelated to this feature's own code but worth recording:** this
session's restart-warning notifications (`PushNotification`, used before
every Vivaldi restart during testing) turned out to rarely fire as an
actual out-of-band alert -- it consistently reported "not sent, terminal is
active," meaning the chat text was the only real signal most of the night.
Aaron already has a working, always-fires local notification mechanism for
this machine: global `~/.claude/settings.json` hooks (`Stop` -> `"[DONE] —
<dir> — <time>"`, `Notification` -> `"[REQ] <message> — <time>"`) that both
call `osascript -e 'display notification ...'` directly, independent of
Claude Code's own terminal-activity suppression. Adopted the same direct
`osascript` call (tag `"[CAUTION]"`, matching the bracket-tag convention)
for future mid-task pre-action warnings in this project instead of relying
on the `PushNotification` tool.

### ⌥⌘J's real ceiling, and a skip-condition regression that silently dropped notifications (2026-08-08, still later)

**⌥⌘J cannot work while the page has keyboard focus, confirmed live and
architectural, not fixable in JS.** Real repro (cmd+click, click into the
actual page content, press ⌥⌘J for real) against a debug hook logging
*every* keydown reaching `window.html` -- not just ⌥⌘J -- captured zero
events, twice. `<webview>` content runs in a separate process from
`window.html`; keydowns occurring there don't bubble to our
`document.addEventListener`. Vivaldi's own shortcuts (Cmd+T, Cmd+W, etc.)
work everywhere because Vivaldi intercepts them at a native, privileged
level no amount of injected page JS can reach. Since the page having focus
is the normal state right after clicking a link -- exactly when ⌥⌘J would
be reached for -- this is a real ceiling on the in-page shortcut, not a bug
to chase further. The relay's curl endpoint, bound to a real OS-level
hotkey via Keyboard Maestro, has no such limitation (global hotkeys aren't
gated on DOM focus at all) and remains the reliable path for a shortcut
that always works. Left ⌥⌘J as best-effort (works when focus happens to be
on Vivaldi's own chrome) rather than removing it.

**Separately, a real regression, found and fixed:** the skip-condition
added earlier (see "Distinguishing how a tab was opened, and a fourth
detection path for in-place foreground reassignment" above) to fix the
click-to-jump-vs-foreground-switch race was too broad. It skipped
`checkWorkspaceTagThenHandle`
firing for *any* tab sitting in the focused window with a workspace
mismatch, on the assumption that `onWorkspaceStoreChanged` would always
pick it up instead. But that path's correlation (`recentActiveTabWindows`)
only ever tracks `active: true` tabs. A background (`active: false`)
cmd+click tab routed to a windowless workspace *also* never leaves the
focused window (identical to the foreground case, just via a different
mechanism -- Vivaldi tags it in place either way), so it hit the same skip
and then had no path left to notify through at all -- a silent, total drop.
Confirmed live via the user's own real repro: after closing a window this
feature had created for a workspace, a subsequent cmd+click back to that
now-windowless workspace produced no notification whatsoever. Fixed by
tightening the skip condition to require the *exact* match
`onWorkspaceStoreChanged` itself checks for
(`recentActiveTabWindows.get(tab.windowId) === tab.id`), not just "sitting
in the focused window." Re-verified live: the precise repro (an
`active:false` tab created directly in the focused window, never moved,
targeting a windowless workspace) now correctly fires the click-to-jump
toast again.

### A wrong-window raise bug, a native fallback that already existed, and reconsidering the Keyboard-Maestro-free approach (2026-08-09)

**Bug: raised the wrong window under the right label.** Real-world testing
found a new combination the fifth case (see above) hadn't been exercised
against: a *workspace-less* frontmost window, plus a target workspace with
no window of its own. Repro: with a window that has no workspace binding at
all in front, and no window bound to "Devel," externally launch a URL a rule
maps to Devel. Observed: the toast read "Raised window with Devel," but the
window actually raised was displaying "Work." Contrast: the identical action
with a Devel-bound window already open correctly raises *that* window, with
an accurate label.

Root cause, worked out from the existing code without needing a fresh debug
hook (though the fix below still needs live re-verification, not yet done):
the fourth case's in-place reassignment of the frontmost window (see
"Distinguishing how a tab was opened..." above) apparently only applies when
the frontmost window is *already* workspace-bound. With no workspace binding
on the frontmost window at all, Vivaldi instead drops the new `active:true`
tab into some other, unrelated, already-open window (Work) -- tagging the
tab with the target workspace (Devel) via `vivExtData` without ever making
that window actually display it. `handleBackgroundTab`'s raise branch used
`routedTab.windowId` (the window the tab happens to be sitting in) to raise,
but `routedTab.workspaceName` (the tab's *own* workspace) to label -- and
had implicitly assumed these always describe the same window. They don't
here. Same underlying category of bug this project keeps running into (a
tab's own workspace vs. the workspace its containing window displays), just
newly surfaced in the raise branch specifically.

Fix: only take the raise branch once `findWindowDisplayingWorkspace` (already
used elsewhere in this file for exactly this purpose) confirms
`routedTab.windowId` really is displaying `routedTab.workspaceId`. Otherwise
fall through to the ordinary click-to-jump toast -- which turns out to be
exactly the right behavior already, not a new special case: it correctly
announces "opened in Devel, click to switch," and `jumpToTab` already moves
the tab into the real target window if it isn't sitting there, so nothing
downstream needed to change at all. Applied and reinstalled the same night;
**not yet re-verified live**, since it landed after Aaron had gone to bed --
next thing to confirm is the exact repro above once he's back at the
keyboard.

**A native fallback that already existed.** Separately, Aaron asked whether
some existing macOS or Vivaldi menu item -- a History menu, maybe -- could
already get you to a routed tab without any of this custom machinery.
Researched rather than guessed: the History menu specifically does *not* do
this (double-clicking an entry reloads the *current* tab fresh; it doesn't
find or focus an existing open/hidden tab, so it'd create a duplicate rather
than jump to the original). But Vivaldi's **Quick Commands** (F2 / ⌘E) does
exactly what was being asked for: type part of a title or URL (optionally
prefixed with the `tab:` filter to search only open tabs), select it, and
Vivaldi switches straight to it -- including a tab currently parked in a
workspace with no window displaying it. Built-in, zero install, per
Vivaldi's own help docs -- not yet re-verified live on this exact build, but
worth documenting prominently regardless of anything else in this section:
it's a real, already-working fallback for anyone who doesn't want to
install anything at all. `Window → Other Workspaces and Tabs` and the Window
Panel are two more already-existing native paths to the same place.

**Reconsidering the Keyboard-Maestro-free approach.** The original plan for
tonight was narrower: research whether `chrome.commands` (a real Chrome/
Vivaldi extension's manifest-declared keyboard shortcut, intercepted at the
privileged browser-process level rather than routed through
`window.html`'s DOM -- the same precedence class as reserved shortcuts like
Cmd+T) could sidestep ⌥⌘J's confirmed `<webview>`-focus ceiling, in service
of Aaron's goal of open-sourcing this project without a paid tool as a hard
dependency. Research (Chrome's own `chrome.commands` docs, plus several
Vivaldi forum threads --
[77054](https://forum.vivaldi.net/topic/77054/keyboard-shortcuts-from-an-extension),
[31027](https://forum.vivaldi.net/topic/31027/keyboard-shortcuts-not-working-with-extensions),
[75247](https://forum.vivaldi.net/topic/75247/extensions-keyboard-shortcuts-don-t-work),
[69541](https://forum.vivaldi.net/topic/69541/guide-make-extension-keyboard-shortcuts-work-windows-10-11))
found two real constraints layered on top of each other: Chrome's own native
restriction that manifest-`"global": true` commands are limited to
`Ctrl+Shift+[0-9]`, *and* a long-standing, still-open Vivaldi-specific bug
(years of reports, Mac and Windows both) where extension commands in the
default ("In Vivaldi") scope often don't fire at all, with "switch to
Global scope in `vivaldi://extensions`" as the documented workaround --
leaving genuinely unknown (not documented anywhere found) whether Vivaldi's
own Global-scope toggle inherits Chrome's digit-only restriction or is more
permissive. Also confirmed by directly inspecting the installed app
(Vivaldi 8.1.4087.62): there's no editable `manifest.json` alongside
`main.html`/`window.html` the way this project's own injected scripts sit
there -- `main.html` is addressed via a `chrome-extension://` URL (a
component extension baked into the binary), but `strings` against
`resources.pak` found no plaintext manifest content, so "patch Vivaldi's own
internal manifest to add a `commands` key" was never actually an option,
just one that could be ruled out for certain rather than assumed.

Presented that research as a plan (build a small `extension/` to spike this
empirically). Aaron pushed back, and the pushback held up under scrutiny:
weighed properly, a custom unpacked extension is probably *more* adoption
friction than it first looked, not less. It needs Developer Mode enabled in
`vivaldi://extensions`, and Chromium then shows a "Disable Developer Mode
Extensions" warning on *every* browser startup, forever -- not a one-time
cost, and not suppressible short of an enterprise policy file. Layered on
top of the Vivaldi bug above, the actual payoff was genuinely uncertain even
before writing a line of code.

macOS's own **Shortcuts.app** sidesteps all of it, for free: a single "Get
Contents of URL" action against the same relay endpoint
(`http://127.0.0.1:8877/jump-last-routed`) the current Keyboard Maestro
macro already calls, with a keyboard shortcut assigned via the shortcut's
own Details pane. Because it hits the relay over plain HTTP, it never
touches Vivaldi's extension/keybinding stack at all -- the Vivaldi bug above
simply doesn't apply, and there's no `Ctrl+Shift+[0-9]`-style restriction,
since this was never a Chrome/Vivaldi "global command" in the API sense to
begin with. It registers as a genuine OS-level global hotkey, so it keeps
today's systemwide reach (works even when Vivaldi isn't frontmost) for free,
rather than as a fallback-only mode the way a non-global `chrome.commands`
shortcut would be. `relay/server.js` and `workspace-route-watcher.js` need
zero changes either way -- confirmed by re-reading `relay/server.js` in
full: it has no auth of any kind today (loopback-only binding is its entire
security boundary), so a `fetch()` from anywhere is exactly as privileged as
the `curl` call it replaces.

Revised recommendation, now reflected in `CLAUDE.md`'s "Triggering a jump
from outside Vivaldi" section: Shortcuts.app is the primary recommended
Keyboard-Maestro-free path; the `chrome.commands` extension (scaffolded at
`extension/manifest.json` + `extension/background.js`, still worth having
for anyone who'd rather stay entirely in-browser) is a documented
alternative with its empirical uncertainties stated plainly rather than
smoothed over; Keyboard Maestro keeps working unchanged for anyone who
already has it set up. Not yet done: actually verifying any of Shortcuts.app
(does the keyboard-triggered path flash the app open, or run silently?),
the extension (does it fire at all in either scope, and what does Vivaldi's
Global-scope UI actually accept?), or Quick Commands on this exact build --
all deferred until Aaron is back at the keyboard, consistent with this
project's standing rule of confirming live rather than assuming.

### Removed the in-page ⌥⌘J listener entirely (2026-08-09)

Setting up the Keyboard Maestro macro for the relay path (hotkey → curl
`/jump-last-routed`) raised an immediate question: `window-toast.js` still
had its own separate, in-page ⌥⌘J listener from earlier in the session (see
"Global ⌥⌘J" above). Binding the same combo in an external tool meant both
could now fire for a single keypress whenever Vivaldi's own chrome (not a
webview) had focus -- the one condition the in-page listener could ever
actually fire under. Flagged this as a real, if edge-case, risk rather than
just noise: two near-simultaneous `jumpToLastRoutedTab()` calls racing
against each other could both decide the target workspace has no window yet
and each create one, rather than one call creating it and the second
correctly finding what the first just made.

Aaron asked the sharper question directly: given the finding earlier this
session was that the in-page listener *never* fires in the one moment it's
actually needed (right after clicking a link, when a webview has focus),
and the relay-based triggers now cover every case unconditionally (including
that one), what was the remaining case for keeping it at all? None, on
reflection -- its "sometimes works" coverage (only while focus happens to be
on Vivaldi's own chrome, e.g. right after opening a tab or using the address
bar) was already a strict subset of what Shortcuts.app/the extension/
Keyboard Maestro now provide unconditionally. The one asymmetry worth
naming and then setting aside: the in-page listener didn't depend on the
relay process being up, since it messaged `main.html` directly via
`chrome.runtime.sendMessage` rather than going out over the network at all.
That's a real but narrow resilience margin -- covering only the already-rare
"relay happens to be down AND focus happens to be on Vivaldi's chrome, not a
page" intersection -- and not worth keeping the double-trigger race for.

Removed: `onKeydown` and its `keydown` listener registration from
`window-toast.js` (along with the now-unused `SHORTCUT_LABEL` constant and
the toast's "Click or ⌥⌘J to switch" wording, which becomes misleading once
the actual key binding lives entirely in user-chosen external configuration
rather than this project's own code), and the now-dead
`"vwh-jump-last-routed"` branch of `workspace-route-watcher.js`'s
`chrome.runtime.onMessage` listener that only that removed sender ever
targeted. The toast's click-to-jump behavior and the relay's own
`jumpLastRouted` path are both completely unaffected -- this only removed
the one redundant, narrowly-scoped, race-prone path to the same action.
