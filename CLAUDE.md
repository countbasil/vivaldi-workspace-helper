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

## Second feature: toast + jump for auto-routed background tabs

Separate from the CDP-based jump feature above, and **deliberately not
built the same way** — see the planning doc's 2026-08-08 section for the
full rationale. Detects when Vivaldi's "open websites in workspaces
automatically" rule (Settings → workspace rules) routes an incoming URL into
a window that isn't currently focused. A tab that was opened by an external
app (foreground intent — see the fifth-case note below) jumps there
automatically, creating and assigning a window first if the destination
workspace doesn't have one yet; other background routes (e.g. cmd+click)
instead show a toast naming the destination workspace/tab with
click-to-jump, plus an external-hotkey fallback that works for either case.

This is split across **two** injection points, because the document that can
detect the route (`main.html`) isn't the document that can draw anything
on screen (`window.html`, one instance per open window):

- `injected/workspace-route-watcher.js` — plain JS injected into `main.html`
  via `injected/install.sh`, following the same technique as the sibling
  `vivaldi-theme-switcher` project's `custom.js`. Runs inside Vivaldi's own
  process for the lifetime of the browser; does the detection and
  workspace-name resolution — no CDP involved at all for this feature. Three
  detection paths, each covering a different way Vivaldi actually delivers a
  routed tab (confirmed by watching real events live over CDP, not assumed):
  `chrome.tabs.onCreated` (URL opened from another app, or pasted into the
  address bar, lands directly in the destination window), `chrome.tabs.onAttached`
  (cmd+click instead opens the tab in the *current* window first, and
  Vivaldi's rule engine moves it to the destination window a moment later —
  a cross-window move fires `onAttached`, not another `onCreated`), and
  `chrome.tabs.onUpdated` gated on `changeInfo.vivExtData` (when the target
  workspace has **no window at all**, Vivaldi doesn't move the tab anywhere
  to wait for — it just tags the tab in place, still sitting wherever it was
  created, via a `vivExtData` update moments after creation; neither of the
  other two listeners ever fires for this case since the tab never actually
  changes windows). Since it has no viewport, it can't show anything itself
  — it broadcasts a `vwh-show-toast` runtime message instead. Workspace name
  (and its emoji, for the toast icon) is resolved from the *tab's own*
  `vivExtData.workspaceId` (present on every `chrome.tabs.Tab`), not from
  `workspaceStore.getActiveWorkspaces()` (which only says what a *window* is
  currently displaying) — a tab can belong to a workspace with no window of
  its own at all, parked hidden inside some other window's tab strip, and
  those two things disagree exactly in that case. "Is this really a
  background tab" (for the onCreated/onAttached paths) is decided by a fresh
  `chrome.windows.getLastFocused()` query after a short
  (`BACKGROUND_CHECK_DELAY_MS`) settle delay, rather than a self-maintained
  cache of the last focus event — the cache had a real race (a brand-new
  window's own initial tab, e.g. Cmd+N, could be misjudged as background if
  its own focus event hadn't been processed yet by the time its tab's
  `onCreated` fired).

  A fourth, distinct case: an **externally-opened** URL (see below for how
  that's recognized) routed to a workspace with no window doesn't get a new
  window from Vivaldi itself — confirmed live, Vivaldi instead reassigns the
  *current foreground window's* displayed workspace in place and loads the
  tab there. This is invisible to all three paths above (the tab's own
  workspace and its window's displayed workspace already agree by the time
  any of them would check), so it needs its own signal:
  `workspaceStore.addListener` (the same subscription mechanism
  `vivaldi-theme-switcher` uses, but never previously used in this project),
  watching for the *focused* window's displayed workspace changing,
  correlated against a tab created with `active: true` in that same window
  within the last `FOREGROUND_TAB_CORRELATION_MS` — without that
  correlation this would also fire for the user's own manual workspace
  switches, which aren't routed tabs and shouldn't get a route-related
  toast. This case gets different wording entirely ("Vivaldi changed window
  to `<emoji>` `<name>`", click just dismisses — the window is already what's
  on screen, there's nothing to jump to), and there's a real race against
  the third (`onUpdated`/`vivExtData`) path worth knowing about: that path
  fires the moment the tab is tagged, which can be *before* Vivaldi finishes
  the in-place switch, making the workspace look temporarily windowless —
  fixed by having it skip firing only when the tab is *both* sitting in the
  currently-focused window *and* is the specific `active:true` tab
  `onWorkspaceStoreChanged`'s own correlation is tracking there (checked via
  `recentActiveTabWindows`), deferring to this fourth path only for that
  exact case. A broader "skip whenever sitting in the focused window"
  version of this check was tried first and was a real regression: a
  background (`active:false`) cmd+click tab routed to a windowless workspace
  *also* never leaves the focused window (same mechanism, different
  origin), so it hit that skip too and then had no path left to notify
  through at all — a silent, total drop, confirmed live after closing a
  window this feature had created and cmd+clicking back to that same
  now-windowless workspace. **As of 2026-08-12, this skip only ever applies
  to background (`wasOriginallyActive === false`) tabs** — see the
  "Externally-opened routes jump automatically" note below for why
  foreground-intent tabs now bypass it entirely, and for a second,
  independent race this same fourth path caused once that change landed.

  A fifth case, layered on top of the first three rather than a separate
  detection path: an externally-opened tab that lands in an *existing*
  different window (not windowless) doesn't get raised to the front by
  Vivaldi either — confirmed live, it just sits there unfocused, same as a
  cmd+click route would. "Externally opened"/foreground-intent is recognized
  by `tab.active === true` **at creation time specifically** — confirmed
  live (both a synthetic `chrome.tabs.move` and a genuine external open)
  that Vivaldi resets a tab's `active` flag to `false` the instant it lands
  via a cross-window move, regardless of how it started, so checking
  `active` on the settled tab (after the move) always reads `false` and
  can't distinguish anything. `tabOriginalActiveState` (tabId → `active` at
  `onCreated`, captured before any move can touch it) is the fix; `active`
  read anywhere later is unreliable. This same signal is what distinguishes
  cmd+click (`active: false`, always) from external opens, confirmed
  empirically. Address-bar entry into an *already-loaded* tab doesn't create
  a new tab and doesn't get routed at all (navigates in place, confirmed
  live) — but typing a URL into a **fresh, blank** Cmd+T tab is different
  and *does* get routed (confirmed live 2026-08-12): the tab already exists
  (from Cmd+T) but starts blank, so it's indistinguishable from a genuine
  external open by every signal available here (`active: true` at creation,
  no `openerTabId`) — it hits the exact same foreground-intent code path.

  **Externally-opened routes jump automatically (changed 2026-08-10, see the
  planning doc's 2026-08-10 section for the full history)**: rather than
  showing a toast the user has to click, `handleBackgroundTab`'s
  foreground-intent branch calls `jumpToTab` directly and immediately — the
  same function used for a toast click and the relay's `jumpLastRouted` —
  which re-derives the real target window fresh via
  `findWindowDisplayingWorkspace(workspaceId)` (found → focus it; none →
  create a blank window and assign it via the relay, exactly mirroring
  `bridge/workspace-jump.js`'s own two-branch decision) and moves/activates
  the tab there. Deriving the target fresh rather than trusting
  `routedTab.windowId` (wherever the tab happened to land) also subsumes a
  bug fixed 2026-08-09 under the old raise-or-fallback design: when the
  *frontmost* window had no workspace binding of its own and the target
  workspace also had no window, Vivaldi doesn't do the fourth case's usual
  in-place reassignment — it drops the tab into some other, unrelated,
  already-open window instead (tagging it via `vivExtData` without ever
  making that window display it), which the old code could mistake for the
  right window to raise (symptom: a toast reading "Raised window with Devel"
  while the window actually raised was displaying Work). `jumpToTab` never
  makes that assumption, so there's no special case needed for it anymore.
  The resulting toast is still purely informational (click just dismisses —
  the jump already happened): `"raised-window"` when an existing window was
  focused, or `"created-window"` when one had to be created and assigned.
  If `jumpToTab` itself fails (e.g. the relay is down and a new
  window/assignment was needed), falls back to the ordinary interactive
  click-to-jump toast. Cmd+click and other genuinely-background routes
  (`wasOriginallyActive === false`) are unchanged — still the interactive
  click-to-jump toast, since an unrequested automatic jump for a
  deliberately-backgrounded tab would be a real regression, not a fix.

  **Two races fixed 2026-08-12** (found via a scripted, repeatable live-test
  harness — see the planning doc's 2026-08-12 section for full methodology
  and evidence): making the foreground-intent branch call `jumpToTab`
  directly and unconditionally (above) broke an assumption the *existing*
  fourth-case logic depended on, in two different ways.
  1. **Total silent drop.** `checkWorkspaceTagThenHandle`'s skip (see the
     fourth-case comment above) was written back when the foreground-intent
     branch only ever passively waited for a possible native reassignment —
     deferring "just in case" was harmless. Once that branch started acting
     deterministically via `jumpToTab`, deferring stopped being safe: when
     the target workspace already has a window elsewhere, `jumpToTab` just
     focuses it without ever touching the workspace store, so
     `onWorkspaceStoreChanged` was never going to fire and pick up the
     slack — the routed tab was silently abandoned wherever it had been
     created, no toast, no jump, no log line. Reproduced live via repeated
     scripted trials against the same already-windowed target. Fixed by
     having `checkWorkspaceTagThenHandle` call `handleBackgroundTab`
     directly for foreground-intent tabs every time, never deferring — the
     skip now only ever applies to background tabs, where the scenario it
     was originally added for is still real.
  2. **Spurious duplicate toast.** `jumpToTab`'s "create window" branch
     (`chrome.windows.create({})`) gives the new window a default blank tab,
     itself created `active: true` — satisfying `onWorkspaceStoreChanged`'s
     own `recentActiveTabWindows` correlation just as well as a genuine
     routed tab would. When `jumpToTab` then assigns the target workspace to
     that same window moments later, `onWorkspaceStoreChanged` can't tell
     that apart from a native in-place reassignment, and fires its own
     (wrong, and duplicate) `"foreground-switch"` toast on top of
     `jumpToTab`'s already-correct `"created-window"` one — confirmed live,
     `window-toast.js` always calls `dismissToast()` before showing a new
     one, so the second silently overwrote the first. Fixed with a new
     `windowsCreatedByJumpToTab` set (bounded cleanup, same pattern as
     `recentlyHandledTabIds`), populated the instant `jumpToTab` creates a
     window and checked by `onWorkspaceStoreChanged` before it fires
     anything — a store change on a window we just created ourselves is
     `jumpToTab` finishing its own job, not something to report on.
- `injected/window-toast.js` — plain JS injected into `window.html` (the
  visible per-window chrome document; every open window loads its own
  instance of the same file), also via `injected/install.sh`. Listens for
  that broadcast and — only in the instance whose window id matches
  `displayWindowId` (i.e. whichever window the user is actually looking at)
  — renders the actual toast: a fixed-position div, positioned relative to
  the actual web content viewport (`.webpageview`/`webview`'s own bounding
  rect via `getContentViewportRect()`), not the window as a whole — a
  window-relative position landed the toast partly *underneath* Vivaldi's
  own toolbar/tab-strip chrome, which silently ate clicks on that portion
  (confirmed live via `document.elementFromPoint` hit-testing at several
  points across the toast). Background opacity is `TOAST_OPACITY` (a
  constant at the top, currently `0.6`); auto-dismisses after
  `TOAST_DURATION_MS` (also freely tweakable). Four `variant`s share this
  renderer: `"route"` (default) is interactive — click sends a
  `vwh-jump-request` back to `main.html`; `"foreground-switch"`,
  `"raised-window"`, and `"created-window"` are informational — click just
  dismisses, nothing to jump to (the jump, if any, already happened
  automatically by the time the toast appears — see the "Externally-opened
  routes jump automatically" note above).

  **No in-page keyboard shortcut here anymore (removed 2026-08-09).** This
  used to also listen for ⌥⌘J directly (`document.addEventListener`,
  checked via `e.code` since Option remaps `e.key` to a dead-key character
  on macOS) as a global, always-on fallback, sending a
  `vwh-jump-last-routed` message to `main.html`. **Real ceiling, confirmed
  live, not fixable in JS**: it only ever worked while keyboard focus was on
  Vivaldi's own chrome, not on the actual page (`<webview>` runs in a
  separate process; its keydowns never reach `window.html`'s own `document`,
  unlike Vivaldi's own native shortcuts, which are intercepted at a
  privileged level no injected page JS can reach) — meaning it never fired
  in the single most common moment you'd want it, right after clicking a
  link on a page. Once "Triggering a jump from outside Vivaldi" below
  existed, that narrow, unreliable coverage became a strict subset of what
  the relay already provides from anywhere regardless of focus — and worse
  than merely redundant: binding the same key in an external tool meant both
  paths could fire for one keypress, which could race and create two
  windows for a windowless target workspace. Removed rather than kept as a
  "best-effort" extra; see the planning doc's 2026-08-09 section.
- `relay/server.js` — small local Node process (WebSocket + a one-route HTTP
  server) that lets an external hotkey ask `main.html`'s script to run
  `jumpToLastRoutedTab()` (jumps to whatever was routed most recently, even
  after its toast has already disappeared), without needing
  `--remote-debugging-port`/CDP. The injected script connects *out* to it.
  Needs to always be running — install
  `relay/com.aaron.vivaldi-workspace-relay.plist` as a LaunchAgent (`cp` to
  `~/Library/LaunchAgents/`, then `launchctl load`). Also handles the
  reverse direction: `jumpToTab` mirrors `bridge/workspace-jump.js`'s own
  two-branch decision exactly — if the routed tab's workspace already has a
  window, just focus it (moving the tab there if it's parked somewhere
  else); if not, create a **new blank window** and ask the relay to run the
  *same* Window-menu-click AppleScript `workspace-jump.js` uses to assign
  it, then move the tab in. It deliberately never force-switches some
  unrelated existing window's displayed workspace — that's the exact
  silent-reassignment behavior this whole project exists to avoid (see the
  planning doc's "Rejected approach"). This means every jump — a toast
  click, or an external trigger via any of the options below — depends on
  the relay being up whenever the target workspace needs a brand-new window
  created and assigned.

### Triggering a jump from outside Vivaldi (no Keyboard Maestro required)

Three ways to reach the relay's `GET /jump-last-routed` endpoint from an
OS-level hotkey, in the order this project recommends trying them — all
three are purely additive (nothing about the relay or the injected scripts
changes based on which one you use), so it's fine to have more than one set
up at once. There's no in-page keyboard shortcut anymore (⌥⌘J used to be
handled directly inside `window.html` — see `window-toast.js`'s entry above
for why that was removed rather than kept as a "best-effort" extra):

1. **macOS Shortcuts.app (recommended)** — create a shortcut with a single
   "Get Contents of URL" action pointed at
   `http://127.0.0.1:8877/jump-last-routed` (GET; no need to show the
   result), then give it a keyboard shortcut via its own Details pane ("Add
   Keyboard Shortcut"). This registers a real OS-level global hotkey — works
   even when Vivaldi isn't the frontmost app — without touching Vivaldi's
   own extension/keybinding system at all, so the Vivaldi bug described in
   option 2 below is irrelevant to this path entirely. Not yet confirmed:
   whether triggering it via the assigned keyboard shortcut (as opposed to
   the `shortcuts://` URL-scheme path) briefly flashes open the Shortcuts
   app or runs fully silently — very likely silent, but unverified on this
   machine.
2. **`extension/` (optional, in-browser alternative)** — a small, separate
   Chrome/Vivaldi extension (`manifest.json` + `background.js`; not part of
   the injected scripts above and not installed the same way): declares a
   `chrome.commands` shortcut (suggested to ⌥⌘J), and its background service
   worker just `fetch()`es the relay endpoint on trigger. Install via
   `vivaldi://extensions` → enable Developer Mode → Load unpacked → select
   `extension/`. **Unverified as of 2026-08-09**: Vivaldi has a
   long-standing, still-open bug (see the planning doc's 2026-08-09 section
   for forum links) where extension-declared shortcuts in the default ("In
   Vivaldi") scope often don't fire at all; the documented workaround is
   switching the command's scope to "Global" in `vivaldi://extensions` →
   Keyboard Shortcuts, though it's unknown without live testing whether that
   accepts ⌥⌘J as typed or forces it down to a `Ctrl+Shift+[0-9]`-style combo
   the way Chrome's own native global-command restriction does. Also: any
   unpacked/developer-mode extension makes Chromium show a "Disable
   Developer Mode Extensions" warning on every browser startup — a
   recurring cost the Shortcuts.app path above doesn't have.
3. **Keyboard Maestro (still works, no longer required)** — hotkey →
   "Execute Shell Script" → `curl -s http://127.0.0.1:8877/jump-last-routed`.
   Kept working for anyone who already has it set up; no longer the
   recommended path for a fresh install, since it's a paid tool and options
   1–2 cover the same need for free.

**Finding a routed tab without setting up any of the above**: Vivaldi's own
Quick Commands (⌘E, optionally prefixed with `tab:` to search only open
tabs) can already find and switch to any open tab, including one currently
sitting in a workspace with no window displaying it — confirmed in
Vivaldi's own help docs, not yet re-verified live on this exact build. The
History menu does *not* do this — double-clicking an entry reloads the
*current* tab fresh rather than finding/focusing an existing one — worth
knowing since it looks like it should work and doesn't.

Both injected files must be reinstalled (`injected/install.sh`) after every
Vivaldi update, same caveat as the theme-switcher, and Vivaldi must be fully
restarted after installing/updating either one — `main.html` and every open
window's `window.html` are only read at their own startup.

This intentionally leaves `bridge/`, `wrapper-app/`, and the existing
per-workspace Keyboard Maestro macros untouched. If the relay proves
reliable, migrating the *original* per-workspace jump onto it too (retiring
CDP/the wrapper app/the debug port entirely) is a natural follow-up, not yet
done — see the planning doc.

## Third feature: move the current tab(s) to a workspace (2026-08-13, works around a Vivaldi bug)

Confirmed live: Vivaldi's own "Move Active Tab to Workspace N" keyboard
shortcuts and the tab's right-click → Move → *[workspace]* menu both
silently no-op — no `vivExtData` change, no window move, nothing —
reproduced with this project's injected scripts completely removed, so it's
purely an upstream Vivaldi bug (see the planning doc's 2026-08-13 section
for the full repro and forum research). `moveSelectedTabsToWorkspace`
(`injected/workspace-route-watcher.js`) reimplements the action via the
extension API as a working replacement, reachable only through the relay
(there's no in-page trigger for this — it exists specifically to be bound
to an external hotkey in place of Vivaldi's broken one):

- `relay/server.js` — new endpoint, `GET /move-selected-tabs-to-workspace?workspace=<name>`,
  same request/response plumbing as `/jump-last-routed` (factored out into
  a shared `sendBrowserRequest` helper). `REQUEST_TIMEOUT_MS` bumped from
  3000ms to 8000ms while adding this — it was already too short relative to
  the *injected* script's own 5000ms `RELAY_REQUEST_TIMEOUT_MS` budget for
  the `activateWorkspace` round-trip when a window needs to be created, a
  latent bug this new endpoint's "create a window" path would have hit
  immediately (spurious `TIMEOUT` while the browser side was still working
  and about to succeed) — applies equally to the pre-existing
  `/jump-last-routed` endpoint's create-window case.
- `moveSelectedTabsToWorkspace(workspaceName)` — looks the workspace up by
  name, reads `chrome.tabs.query({windowId, highlighted:true})` on the
  currently focused window (this is `true` for the lone active tab when
  nothing else is multi-selected, and for every tab in a cmd+click
  multi-selection — so it naturally covers both "move the current tab" and
  "move several selected tabs" with the same code), resolves/creates the
  target window via a new shared helper `resolveOrCreateWindowForWorkspace`
  (extracted from `jumpToTab`, which now calls it too instead of duplicating
  the window-resolution logic), moves every selected tab there in one
  `chrome.tabs.move` call, and re-activates whichever one was already
  active. Shows a `"moved-tabs"` toast (`window-toast.js`) on success:
  "Moved N tab(s) to `<emoji>` `<name>`" (see "Focus stays on the source
  window" below for how this toast behaves as of 2026-08-14).
- Setup mirrors Feature 3's per-workspace Keyboard Maestro macros exactly,
  just hitting the relay instead of running the CDP bridge script — see the
  README's Feature 4 section for the full macro setup.

**Bugs found via Aaron's own live trials, fixed same day**: moving real tab
stacks surfaced that `{"ok":true}` was being returned for moves that hadn't
actually happened — every `chrome.*` callback in this path was ignoring
`chrome.runtime.lastError`, so a failed `chrome.tabs.move` (which Chrome's
API can do for a still-grouped tab moving cross-window — there's no
cross-window equivalent of `chrome.tabGroups.move`) silently read as
success. Fixed with a `callChrome(obj, method, ...args)` helper that
actually checks `lastError`, used for every write in
`moveSelectedTabsToWorkspace` and `jumpToTab`'s own tab move; paired with an
explicit `chrome.tabs.ungroup` step before moving any tab whose `groupId`
isn't -1. Also added a 500ms settle delay in
`resolveOrCreateWindowForWorkspace` after a newly-created window's workspace
assignment returns, before anything touches that window — theory (not yet
independently re-confirmed live) is a race against Vivaldi's own
tab-relocation side effect of assigning a workspace to a window; see the
planning doc's 2026-08-13 "Feature 4 live-testing" section for the full
trial-by-trial evidence and the "ghost tab" symptom (content reachable, no
tab-strip entry at all) this was chasing.

**The leftover-default-tab fix above was real but incomplete** — a retest
with a single never-grouped tab (ruling out stacks) reproduced the exact
same symptom afterward, plus a worse detail: Ctrl+Tab could move focus away
from the ghost tab with no way back. `resolveOrCreateWindowForWorkspace`'s
`chrome.windows.create({})` does always give the new window a default
blank/startpage tab that needed cleaning up (now handled via
`closeDefaultTabIfSafe(windowId, defaultTabId)`, guarded to only fire once
the window has more than one tab), and that fix stayed — but it wasn't the
actual cause of the ghost tab.

**Root cause, confirmed live via CDP + screenshots, not guessed**:
`chrome.tabs.move` to a different window is itself unreliable in this
Vivaldi build. Moved tabs were confirmed correct at the data level
(`chrome.windows.get({populate:true})` showed accurate titles, correct
`active`/`highlighted` state, `groupId:-1`) but permanently absent from the
tab strip — not a rendering lag; re-activating via the API, waiting, and
forcing a window resize (layout reflow) all failed to fix it, and Ctrl+Tab
cycling didn't include the tab either. Fix: a new
`recreateTabInWindow(tab, windowId, active)` helper that does
`chrome.tabs.create({windowId, url: tab.url, active, pinned: tab.pinned})`
followed by `chrome.tabs.remove()` on the original, instead of
`chrome.tabs.move` — going through Vivaldi's ordinary tab-creation path
(the one a real Cmd+T uses) sidesteps the bug entirely, confirmed
repeatedly live including through the real `/move-selected-tabs-to-workspace`
endpoint end-to-end. Used by both `jumpToTab` and
`moveSelectedTabsToWorkspace` (each selected tab keeps its own original
`active` state when recreated, so whichever one was focused stays focused).
This also obsoletes the `chrome.tabs.ungroup` step from the tab-stacks fix
above — recreating never touches the original tab's group membership, so
there's nothing left to ungroup — and the 500ms settle-delay theory,
which turned out not to be the actual mechanism (kept anyway; harmless and
still plausibly relevant to the workspace-assignment step itself, just not
what was causing the ghost tab).

**Deliberate, disclosed trade-off**: recreating a tab loses its own
back/forward navigation history and any in-page JS state (unsaved form
input, etc.) — accepted as clearly the lesser cost against a tab that's
permanently unreachable through any UI interaction. See the README's
Feature 4 section and the planning doc's 2026-08-13 "chrome.tabs.move
itself is what's broken" section for the full live-diagnosis trail.

**Not a bug: a destination window ending up with a new tab stack.**
Vivaldi's tab-stack membership lives in a `group` UUID inside `vivExtData`
— a proprietary field entirely separate from Chrome's `groupId`/
`tabGroups` API (which stays `-1` for real Vivaldi stacks; this is why the
earlier `chrome.tabs.ungroup` step from the tab-stacks fix never actually
did anything for genuine Vivaldi stacks). No extension API can touch it —
`chrome.tabs.update()` silently ignores an attempt to overwrite
`vivExtData`. Confirmed live that a plain `Cmd+T` into a window with one
existing tab produces the identical stack `recreateTabInWindow` does, with
zero involvement from this project's code — it's Aaron's own Vivaldi
"automatically create tab stacks" setting reacting to any new tab, not
something Feature 4 causes or can suppress per-move. See the planning
doc's 2026-08-14 section.

**Focus stays on the source window (2026-08-14).** Originally
`moveSelectedTabsToWorkspace` left the *destination* window focused after a
move (a side effect of `resolveOrCreateWindowForWorkspace` always focusing
whichever window it resolves, since `jumpToTab` — its other caller — wants
exactly that). Per Aaron's feedback, that was disorienting for a move
triggered from an external hotkey: you're working in window A, you move a
tab to workspace B, and suddenly you're looking at window B instead of
still being in A. Fixed:

- `resolveOrCreateWindowForWorkspace(workspaceId, workspaceName, {
  focusExisting })` — new third parameter, default `true`. When an existing
  target window is reused, `focusExisting: false` skips the
  `chrome.windows.update(..., {focused:true})` call entirely (moving tabs
  into a window via `chrome.tabs.create`/`recreateTabInWindow` doesn't
  require it to be focused). `jumpToTab` still passes the default (it wants
  to end up looking at the target); `moveSelectedTabsToWorkspace` passes
  `false`. A brand-new window is unavoidably left focused either way —
  `chrome.windows.create({})` always makes it frontmost, and
  `activateWorkspaceViaMenu`'s AppleScript needs it that way (`tell
  application "Vivaldi" to activate` acts on the frontmost window) — so
  `moveSelectedTabsToWorkspace` explicitly reclaims focus for the *source*
  window itself afterward whenever `targetWindowId !== sourceWin.id`.
- The `"moved-tabs"` toast is now shown on the *source* window
  (`displayWindowId: result.sourceWindowId`, not `result.windowId`) and is
  now **interactive**, unlike `"foreground-switch"`/`"raised-window"`/
  `"created-window"` — those three are purely informational because the
  jump they describe already happened and put you *at* the destination;
  `"moved-tabs"` is different precisely because focus deliberately stayed
  behind, so there's still somewhere real to go. Clicking it (or triggering
  the new relay endpoint below) focuses the destination window — never
  needs to touch a tab, since the move itself already landed the tab(s)
  there synchronously; it's a pure `chrome.windows.update(..., {focused:
  true})`. Text changed from `"Moved N tab(s) to X"` to `"Moved N tab(s) to
  X\n\nClick to switch"` to match, and it now gets the same `TOAST_DURATION_MS`
  (8s) as `"route"` instead of the short informational duration, since the
  user may actually need to read and act on it.
- `window-toast.js`'s `activeTarget` gained a `kind` field (`"route"` vs.
  `"moved-tabs"`) so `jumpToActiveTarget` can send the right follow-up
  message on click — `"route"` sends `vwh-jump-request` (tabId +
  workspaceId, handled by `jumpToTab`); `"moved-tabs"` sends the new
  `vwh-focus-workspace-request` (workspaceId only, handled by the new
  `focusWorkspaceWindow(workspaceId)` in `workspace-route-watcher.js`, which
  re-derives the target window fresh via `findWindowDisplayingWorkspace`
  rather than trusting a stored id — same reasoning as `jumpToTab`: the
  window could have been closed, or the workspace reassigned, since the
  move happened).
- New module-level `lastMovedTabs` (workspaceId/workspaceName/emoji,
  analogous to `lastRoutedTab`) plus `jumpToLastMovedTabs()`, reachable
  externally the same way `jumpToLastRoutedTab()` already is: a
  `jumpLastMovedTabs` relay message type and a new
  `GET /jump-last-moved-tabs` endpoint in `relay/server.js`. This is the
  "separate trigger" half of the feature — bind it to its own hotkey
  alongside the per-workspace move macros, for jumping to wherever the last
  move landed without having to still see its toast.

## Fourth feature: add a workspace routing rule from inside the browser (2026-08-24)

A dialog for adding a new "open in workspace" routing rule (Settings →
Workspace Rules) for the current tab's domain, without ever opening
Settings — reachable via a page right-click context-menu item or an
external hotkey through the relay. Unlike workspace *assignment* (the
Third feature above, and `bridge/workspace-jump.js`'s whole reason for
existing), this one turned out to have a real API — no AppleScript/menu-
click automation needed at all.

**Where rules actually live, confirmed by reading the real `Preferences`
file, not guessed.** `vivaldi.workspaces.link_routes` is an array of
`{id, type, expression, workspaceId}` entries — `type` is `"CONTAINS"` for
every rule Aaron had already configured through Settings (the enum also
supports `"STARTSWITH"`/`"EQUALS"`, per the rules-matching module's own
`findMatch` switch, but this dialog only ever writes `"CONTAINS"`).

**A real live API for this, found the same way `workspaceStore` was
found.** Same webpack-module-scanning technique as `resolveWorkspaceStore`
(push a no-op chunk onto `window.webpackChunkgapp_browser_react` to
harvest `__webpack_require__`, then scan `req.m` for a signature) —
`resolveLinkRoutesController` in `workspace-route-watcher.js` searches for
`"addLinkRoutingRule("` and verifies the resolved module exports that
method. Confirmed live via a scripted add/remove/re-read of the actual
`Preferences` file on disk (2026-08-24): calling
`linkRoutesController.addLinkRoutingRule(type, expression, workspaceId)`
dispatches the identical Redux action (`"CREATE_WORKSPACE_LINK_ROUTE"`)
Vivaldi's own Settings page uses — it updates live rule state immediately
(no restart needed) and persists to `Preferences` on Chromium's own
debounced pref-write schedule (observed roughly 10-20s after the last
change in that session, not immediate — a plain add-then-read-the-file
check can appear to fail if it doesn't wait long enough).
`removeLinkRoutingRules(ids)` is the mirror, used only for this project's
own live-testing cleanup, not by the dialog itself.

**Two files, same split as the toast (Second feature above), for the same
reason** — `main.html` can detect/decide but can't draw anything;
`window.html` has the viewport:

- `injected/workspace-route-watcher.js` — `showAddRuleDialog(windowId,
  tab)` resolves the tab's domain (`getDomain`, already used elsewhere in
  this file) and the full workspace list
  (`workspaceStore.getWorkspaces()`), then broadcasts
  `vwh-show-add-rule-dialog` (displayWindowId-gated, same pattern as
  `vwh-show-toast`). Two triggers, both funneling into this same function:
  a `chrome.contextMenus` item (`"vwh-add-rule"`, contexts `["all"]` --
  changed from `["page"]` 2026-08-25 after confirming live that right-clicking
  directly on text puts Chrome into a `"selection"` context, which a
  `"page"`-only item never appears in; since most of a real page *is* text,
  that meant the item was effectively invisible except on genuinely blank
  background), and `openAddRuleDialogForFocusedWindow()` (reachable via the relay's new
  `openAddRuleDialog` message type / `GET /open-add-rule-dialog`), which
  resolves the focused window's active tab itself, same "what am I looking
  at right now" semantics as `jumpToLastRoutedTab`/
  `moveSelectedTabsToWorkspace`. The dialog's submission comes back as a
  `vwh-add-rule-request` message (`ruleType`/`expression`/`workspaceId`,
  plus `displayWindowId`/`workspaceName`/`workspaceEmoji` echoed purely for
  the confirmation toast), handled by `addWorkspaceRule`, which shows a new
  `"rule-added"` toast variant on success.
- `injected/window-toast.js` — `showAddRuleDialog(message)` renders the
  actual dialog: an editable text input (pre-filled with the domain) plus a
  list of workspace buttons (emoji + name). Clicking a workspace both
  selects it and submits in one action — no separate "Add" button, since
  the workspace list *is* the set of choices. Centered on the window
  (changed 2026-08-25 from the toast's top-right-of-viewport anchor, per
  Aaron's feedback that top-right is also where macOS notifications land
  and one had partly covered the dialog there).
  A full-viewport transparent backdrop (`vwh-rule-dialog-backdrop`, click
  dismisses) gives click-outside-to-cancel without needing a real modal
  API; `stopPropagation` on the dialog itself keeps clicks inside it from
  reaching that backdrop. **No Escape-to-dismiss** — an `input`
  `keydown` listener for it was tried and removed 2026-08-25 after
  confirming live (a diagnostic `document`-level, capture-phase `keydown`
  listener that never fired at all) that Escape doesn't reach this
  document's JS in this context, the same class of finding as the removed
  in-page ⌥⌘J toast shortcut (see the Second feature section) — just
  discovered the hard way this time, since the code silently did nothing
  rather than erroring. The backdrop click is the only reliable dismiss
  path.

**A one-time Vivaldi-internal race, confirmed via a tight external polling
test, not assumed.** `chrome.contextMenus` isn't necessarily available the
instant `init()` runs (`waitForReady` only gates on `chrome.tabs` and
`window.webpackChunkgapp_browser_react`), but the real surprise went
further: even after `chrome.contextMenus.create()` succeeds with no
`lastError`, the item can still get silently wiped moments later.
Reproduced by polling `chrome.contextMenus.update("vwh-add-rule", {}, …)`
externally via CDP every ~300ms immediately after a cold Vivaldi launch:
the item existed at t+1.3s, was gone by t+1.8s, and never came back on its
own for the rest of a 13-second observation window — some part of
Vivaldi's own startup sequence (still finishing subsystem init well after
this script's own, very early `init()` has already run and logged
`"Ready"` — confirmed via `main.html`'s own startup console log, which
shows things like `WorkspaceLinkRoutingActions` and `Menu` resolving
*after* `[VWH] Ready`) appears to clear extension-registered context menu
items once, but doesn't keep re-clearing them afterward. Fixed with
`registerContextMenu`/`verifyContextMenuItem`/`createContextMenuItem`: the
`onClicked` listener is added exactly once
(`registerContextMenuListener`'s own guard), but the menu item itself is
created, then re-verified and re-created on a short retry schedule
(`CONTEXT_MENU_RETRY_DELAYS_MS`, chosen to comfortably straddle the
observed ~300-500ms wipe window) until it survives a check — confirmed to
self-heal correctly by rerunning the same tight polling test against the
fixed code (item survived the same early wipe and stayed present for the
rest of the observation window).

**Not on the tab itself, confirmed live not to be possible via this
API.** Aaron asked (2026-08-25) for the entry on the tab (right-click a tab
in the tab strip) rather than the page background, since that's the more
natural place to reach for "route this site." Tested directly:
`chrome.contextMenus.create({..., contexts: ["tab"]})` is accepted with no
`lastError` at all, but a real right-click on a tab (verified with a
screenshot after a scripted `cliclick` right-click at the tab's actual
screen coordinates) shows Vivaldi's own fully native tab context menu (New
Tab, Reload, Mute, Duplicate, Move, Stack, …) with no trace of the item —
`"tab"` is silently accepted but not actually wired to anything. Vivaldi's
tab-strip menu isn't extension-augmentable the way the page context menu
is; `contexts: ["all"]` (see above) is the closest available fix, since it
at least makes the item appear reliably no matter what part of the page
you right-click.

**The `tab` argument `onClicked` is documented to pass isn't reliable
here, confirmed live with a throwaway diagnostic listener.** Even after
fixing the contexts above, clicking the real menu item still did nothing —
no dialog, no error. Added a second `chrome.contextMenus.onClicked`
listener purely to log its raw arguments: `menuItemId`/`pageUrl`/
`selectionText` all came through correctly, but the second (`tab`)
argument was `undefined`. `registerContextMenuListener`'s original code
had `if (info.menuItemId === "vwh-add-rule" && tab) showAddRuleDialog(tab.windowId, tab)`
— that `tab &&` guard was silently swallowing every real click. Fixed by
not depending on that argument at all: the handler now just calls
`openAddRuleDialogForFocusedWindow()` (the exact same focused-window/
active-tab resolution the relay path already used successfully), which
sidesteps the question of why `tab` is missing here entirely.

**Keyboard navigation inside the dialog uses j/k/e/a, not arrows/Enter/
Escape — confirmed live those aren't deliverable at all (2026-08-25).** A
diagnostic `document`-level, capture-phase `keydown` listener (the same
technique used to discover Escape's fate above) never fired even once for
Arrow-Up/Down, Enter, or Space, sent via real OS-level key events
(`cliclick`) with the dialog open and focus anywhere (including nothing
focused) — Vivaldi's own chrome consumes all of them before page JS ever
sees them, presumably because it always checks those specific keys first
for its own omnibox-autocomplete navigation. Ordinary letter keys, by
contrast, were confirmed to reach the same listener reliably regardless of
focus (typing into the domain field also confirmed to work normally, since
that's standard `<input>` behavior, not dependent on this). So the
in-dialog keyboard scheme (per Aaron's request, 2026-08-25) uses letters
instead: `j`/`k` move the highlighted workspace down/up (wrapping), `e`
focuses the domain field for editing, `a` accepts the highlighted workspace
(equivalent to clicking it) — Enter was the first choice but is one of the
confirmed-undeliverable keys, so a mnemonic letter substitutes for it. A
visible legend renders in the dialog itself, since none of this is
otherwise discoverable. The `document`-level keydown listener is added only
while the dialog is open and removed in `dismissRuleDialog` (a permanent
global letter-key listener would otherwise break normal typing everywhere
else); it no-ops whenever `document.activeElement === input`, so typing a
domain that happens to contain "j"/"k"/"e"/"a" is never intercepted as a
command. Hovering a workspace with the mouse also moves the keyboard
selection (`selectedIndex`), so there's only one "current" concept
regardless of input device.

**"Move this tab now" / "...and switch to that workspace" checkboxes
(2026-08-25).** Below the workspace list, sticky via `chrome.storage.local`
(confirmed available in `window.html`'s context; keys `vwhMoveTabNow`/
`vwhSwitchToWorkspace`) so they persist across dialog opens and Vivaldi
restarts, read on dialog open and written on `change`. The second
checkbox is indented and `disabled` unless the first is checked. On submit
(click, or `a` on the highlighted item), `workspace-route-watcher.js`
always adds the rule first, then — only if "move now" was checked — calls
the new `moveTabForRuleDialog(tabId, workspaceId, workspaceName, switchTo)`,
which moves the *specific* tab the dialog was opened for (its id threaded
through `showAddRuleDialog` → the `vwh-show-add-rule-dialog` broadcast →
the dialog's submit message), not "whatever's currently selected" — the
dialog can stay open long enough for the active tab/selection to have
drifted, unlike an instant hotkey trigger. `switchTo` maps directly to
`moveTabsToWorkspace`'s `focusDestination`: checked behaves like
`jumpToTab` (follow the tab to its new window); unchecked behaves like
`moveSelectedTabsToWorkspace` (stay on the source window). Both now share
a `moveTabsToWorkspace(tabs, sourceWindowId, workspaceId, workspaceName,
{focusDestination})` helper, factored out of what was previously
`moveSelectedTabsToWorkspace`'s own body — same "resolve/create window,
recreate tabs there, clean up the leftover default tab, decide whose focus
wins" logic, just parameterized over which tab(s) and whether to follow.
The confirmation toast combines both outcomes in one variant
(`"rule-added"` with `moved`/`switched` flags) rather than stacking two
separate toasts: no move → unchanged "Routing added: …" text; moved without
switching → adds "Tab moved — click to switch" and becomes interactive
(reuses the `"moved-tabs"` `activeTarget` kind, so clicking sends the same
`vwh-focus-workspace-request`); moved and switched → adds "Tab moved" with
no click action (and is shown on the *destination* window, not the
original `displayWindowId`, mirroring `showJumpedToast`'s reasoning — the
source window isn't what's on screen anymore).

**The context-menu wipe isn't just a one-time startup thing after all,
confirmed by real use (2026-08-25).** Aaron reported the item worked once,
then never appeared again on later right-clicks -- the bounded
`CONTEXT_MENU_RETRY_DELAYS_MS` retry chain (built for the ~300-500ms
startup wipe) only ever runs for ~12s after Vivaldi launches, so if
something wipes the item well after that window has closed, nothing was
left to notice or fix it. Confirmed live: `chrome.contextMenus.update`
genuinely reported "Cannot find menu item" long after startup, well past
when the bounded retries had already given up. Fixed with a shared
`ensureContextMenuItem()` (verify, recreate if missing) called again
~500ms after every real click, on the theory that use itself is the wipe
trigger -- the only concrete evidence available points there (it broke
*after being used*), so that's what the fix targets, rather than adding an
always-on periodic timer to guard against a wipe with no actual evidence
it happens independent of a click. Aaron pushed back on an earlier version
of this fix that also polled every 60s regardless of activity -- fair
cost/benefit call: `onClicked` only ever fires for an actual click of this
specific menu item (never for ordinary page clicks), so the click-triggered
recheck is cheap and rare by construction, while a permanent timer running
for the entire life of every window is a real ongoing cost paid whether or
not the bug it guards against ever recurs. If a wipe independent of any
click ever turns up, that would be the moment to reconsider.

**Menu position and icon, investigated the same session.** Same-section
extension context-menu items are ordered alphabetically by title, not by
extension id or install order -- confirmed by Aaron's own screenshot: with
the plain title "Route this site...", the item landed exactly where
alphabetical order predicts, between "Rich URL" and "Save Page to Reader".
`CONTEXT_MENU_TITLE` now leads with `"! "` (ASCII 0x21, sorts before every
digit and letter) to push it to the top of that section. There is no way
to place it *before* the separator alongside Vivaldi's own native items
(e.g. "Copy Page Address") -- that boundary between native and
extension-added items is drawn by the browser itself, not something the
contextMenus API can influence at all, so "top of the extensions group" is
the ceiling here. A per-item custom icon isn't achievable either: passing
`icons: {...}` to `chrome.contextMenus.create` throws
`TypeError: ... Unexpected property: 'icons'` outright in this Vivaldi
build -- confirmed live, not merely undocumented.

**A second, distinct wipe trigger found by real use (2026-08-25): creating
a new window.** After the post-click recheck above shipped, Aaron still
lost the item once -- but only on a run where "move this tab now" needed
to create a brand-new window for the destination workspace; a run that
targeted an already-open window, and a later run after a full restart,
didn't reproduce it. `resolveOrCreateWindowForWorkspace`'s
`chrome.windows.create` branch now also schedules an `ensureContextMenuItem`
check ~500ms later, the same delay used for the startup wipe and the
post-click recheck, on the theory that window creation is a second,
independent trigger, plausible given the already-confirmed startup wipe
also happens amid a wave of window/subsystem initialization.

**Two dialog bugs found by real use the same session, both now fixed.**
1. Pressing "u" (then "e") to focus the URL field also *typed* the letter
   into it, replacing the selected text. Root cause: `input.focus()` ran
   synchronously inside the keydown handler, but the same keydown event
   still continued to its default action afterward (nothing had called
   `preventDefault()`) -- by then focus had already moved to the input, so
   the browser's default "insert this character" action fired against the
   newly-focused field instead of wherever focus was before. Every letter
   handler now starts with `e.preventDefault()` once the key is confirmed
   to be one of this dialog's own shortcuts.
2. j/k did nothing at all until Aaron clicked a checkbox first. Root
   cause: the dialog usually opens while keyboard focus is still on the
   actual page content, rendered in a `<webview>` that runs in a separate
   process -- its focus is invisible to this document's own keydown
   listener entirely (the same cross-process boundary that already killed
   the in-page toast shortcut, see the Second feature section). A checkbox
   is a genuinely focusable native element, so clicking one pulled
   keyboard focus into this document as a side effect; the workspace
   buttons were plain unstyled `<div>`s, not focusable by default, so
   clicking one wouldn't have helped. Fixed by giving the dialog container
   itself `tabIndex = -1` and calling `.focus()` on it the instant it's
   created, reproducing the same fix without requiring a checkbox click.

**Checkboxes redesigned as fully custom widgets, not styled native ones,
after two failed rounds of native styling.** Neither the browser's default
checkbox rendering nor an explicit `accent-color` (tried first) was
distinguishable checked-vs-unchecked against this dialog's dark background,
per Aaron's testing both times. `createCheckboxRow` now keeps a real (but
visually hidden, `opacity:0`/1px) `<input type=checkbox>` purely for
state/events/tabIndex/disabled -- everything else in the file still reads
`.checked`/`.disabled` and dispatches synthetic `"change"` events exactly
as before -- paired with a separate sibling "box" div that renders the
actual checkmark and background color from scratch, updated by a `syncBox`
function on every `"change"` event. Setting `.checked` directly (loading
the sticky value from `chrome.storage.local`) doesn't fire `"change"`, so
that load path calls `syncBox()` explicitly too.

**Tab-order added, but unverified whether Tab even reaches this document.**
Per Aaron's request, explicit ascending `tabIndex` values (workspace
buttons 1..n, then the two checkboxes at 1000/1001, then the URL field at
1002 despite sitting first in the DOM) now define a specific cycle order
independent of DOM position. Unlike the letter shortcuts, this needs no
keydown handling at all -- per-element focus-cycling on Tab is native
browser behavior, the same category as the input's own left/right-arrow
text-cursor movement (see the keyboard-navigation comment above), so it
should work despite Tab being a plausible candidate for the same kind of
global interception that already claimed Escape/Enter/Space/arrows. This
hasn't been confirmed live yet either way.

**A visible Cancel/Save row, and an "s" naming collision it created
(2026-08-25).** Aaron asked for a bottom-right "(C)ancel  (S)ave new Rule"
row as a discoverable, clickable stand-in for the missing Escape/Enter --
but "s" already belonged to the switch-to-workspace checkbox. Resolved by
renaming that checkbox to "...and (O)pen that workspace" (freeing "s" for
Save) rather than picking a different letter for Save, since Aaron chose
that resolution directly when asked. `submitAccepted()` was initially
shared by "a" (the original per-item accept shortcut) and "s"/the Save
button, kept as two bindings to the same function rather than picking
one -- but Aaron asked moments later to just remove "a" once "s" existed,
so it's gone; "s" (and a click, and Tab+`submitAccepted` via the Save
button) are the only ways to accept now. The rest of the same round was
pure visual polish, not
worth a full writeup: the old separate "j/k navigate · a accept" legend
line was folded into "(W)orkspace:    [j/k navigates]"; the two section
headers ("(U)RL for rule:", "(W)orkspace:") were made larger than the
workspace-list items below them rather than smaller; the workspace list
gained subtle top/bottom border lines; and the checkboxes' text and box
size were both reduced.

## Debugging

- `vivaldi://inspect/#apps` → find the `main.html` entry (for the watcher) or
  a specific window's entry (for its toast) → **inspect**. Watch for
  `[VWH]`-prefixed console lines (the watcher, in `main.html`),
  `[VWH-toast]`-prefixed ones (the toast, per-window in `window.html`), and
  `[WTS]`-prefixed ones (the sibling theme-switcher, if also installed).
- `window.__vwh` is exposed at runtime in `main.html` for live inspection:
  `__vwh.workspaceStore`, `__vwh.lastRoutedTab`, `__vwh.jumpToLastRoutedTab()`,
  `__vwh.lastMovedTabs`, `__vwh.jumpToLastMovedTabs()`, `__vwh.linkRoutesController`
  (Fourth feature's rules API — `.getRules()` lives on a sibling module, not
  this one, but `.addLinkRoutingRule(type, expression, workspaceId)`/
  `.removeLinkRoutingRules(ids)` are here), `__vwh.addWorkspaceRule(...)`,
  `__vwh.openAddRuleDialogForFocusedWindow()`.
- Relay logs: `~/Library/Logs/vivaldi-workspace-relay.log`.
