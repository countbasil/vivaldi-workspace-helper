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
  "Moved N tab(s) to `<emoji>` `<name>`".
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

## Debugging

- `vivaldi://inspect/#apps` → find the `main.html` entry (for the watcher) or
  a specific window's entry (for its toast) → **inspect**. Watch for
  `[VWH]`-prefixed console lines (the watcher, in `main.html`),
  `[VWH-toast]`-prefixed ones (the toast, per-window in `window.html`), and
  `[WTS]`-prefixed ones (the sibling theme-switcher, if also installed).
- `window.__vwh` is exposed at runtime in `main.html` for live inspection:
  `__vwh.workspaceStore`, `__vwh.lastRoutedTab`, `__vwh.jumpToLastRoutedTab()`.
- Relay logs: `~/Library/Logs/vivaldi-workspace-relay.log`.
