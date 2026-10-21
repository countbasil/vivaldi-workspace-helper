// Vivaldi Workspace Helper -- background-route watcher (VWH)
//
// Loaded from main.html (the invisible host document where bundle.js runs),
// via injected/install.sh -- same injection point and technique as the
// sibling vivaldi-theme-switcher project's custom.js.
//
// WHAT THIS DOES
// --------------
// Vivaldi's "open websites in workspaces automatically" rule (Settings ->
// workspace rules) can route an incoming URL -- opened from another app, or
// clicked while browsing -- into a window that isn't currently focused, or
// even into a workspace that has no window of its own at all (the tab just
// gets parked, hidden, inside some other window until that workspace is
// displayed there). This watches for that happening and shows an in-page
// toast (rendered by the sibling script window-toast.js, since this
// document has no viewport of its own) naming the destination workspace and
// the tab, with click-to-jump. It also exposes a "jump to the last routed
// tab" action, reachable from an external hotkey via a small local relay
// process (relay/server.js) over a plain WebSocket -- deliberately NOT
// chrome-remote-interface/CDP, so this feature has no dependency on
// --remote-debugging-port at all. Jumping to a tab whose workspace has no
// window of its own mirrors bridge/workspace-jump.js's own logic exactly:
// create a new blank window and assign it there (via the relay, since
// bringing a workspace on screen has no JS API and needs the Window-menu
// click via System Events, which only a real OS process can do) -- never
// force-switch some unrelated existing window away from whatever it's
// showing, which is the exact silent-reassignment problem this whole
// project exists to avoid (see the planning doc's "Rejected approach").
//
// Also exposes the reverse direction (Feature 5): a dialog for adding a new
// "open in workspace" routing rule for the current tab's domain, reachable
// via a page context-menu item or an external hotkey through the relay. See
// the "add-a-routing-rule dialog" section below and resolveLinkRoutesController.
//
// And a fourth external-hotkey action, jumpToWorkspace (GET
// /jump-to-workspace on the relay): jump straight to a named workspace,
// same as any of the above but with no tab/route context at all -- this is
// bridge/workspace-jump.js's entire job, reimplemented here so a
// per-workspace hotkey macro no longer needs --remote-debugging-port or the
// Vivaldi Debug.app launcher at all. Reuses resolveOrCreateWindowForWorkspace,
// the exact same "find or create the one window for this workspace" step
// jumpToTab and moveTabsToWorkspace already share.
//
// A sixth, unrelated capability lives here too: NEW_TAB_OVERRIDES lets one
// or two specific workspaces get their own Cmd+T destination (e.g. the
// "Claude" workspace always opening claude.ai) instead of Vivaldi's single
// global New Tab Page setting -- see redirectNewTabIfConfigured below. It
// can also focus a CSS selector on that page once loaded (focusSelector),
// via chrome.scripting.executeScript -- unlike everything else in this
// file, that reaches into the *loaded page's own content*, not Vivaldi's
// internal UI, so its availability in this context is unconfirmed; see the
// comment on NEW_TAB_OVERRIDES itself.
//
// HOW MODULE DISCOVERY WORKS
// --------------------------
// Same technique as custom.js and bridge/workspace-jump.js: push a no-op
// chunk onto window.webpackChunkgapp_browser_react to harvest
// __webpack_require__, then scan the module factory registry (req.m) for a
// unique source-code signature string. Module IDs are never hardcoded --
// they're unstable across Vivaldi builds, but the signature (unminified
// Vivaldi source text embedded in the bundle) is stable.
//
// A TAB'S OWN WORKSPACE VS. A WINDOW'S DISPLAYED WORKSPACE
// ----------------------------------------------------------
// workspaceStore.getActiveWorkspaces() only says which workspace each
// window is currently *displaying* -- a window can hold tabs from other
// workspaces too, hidden until that workspace becomes the displayed one
// (this is how Vivaldi's built-in "go to workspace" shortcut can silently
// hide tabs -- see the planning doc's "Rejected approach" section). A
// routed tab's *own* workspace membership is separate, and is only
// discoverable via chrome.tabs' vivExtData field (a JSON string on every
// Tab object containing {..., workspaceId}), not via the store at all.
// Confirmed live: a tab already existed whose vivExtData.workspaceId named
// a workspace with no active window, sitting inside a window displaying a
// completely different workspace -- exactly the case a naive
// window-based lookup gets wrong.
//
// Debugging: vivaldi://inspect/#apps -> main.html -> inspect. Watch for
// [VWH]-prefixed console lines. window.__vwh is exposed at runtime for live
// inspection (__vwh.workspaceStore, __vwh.lastRoutedTab, __vwh.jumpToLastRoutedTab()).

(function () {
  const TAG = "[VWH]";
  const SIG_WORKSPACE_STORE = "getActiveWorkspaceId(e){return this.getState().activeWorkspaces.get";
  // Unique to the module exporting addLinkRoutingRule/removeLinkRoutingRules
  // (several other modules reference the surrounding CREATE_WORKSPACE_LINK_ROUTE
  // action-type string too, so this needs to be specific to the method name
  // itself, not just the feature name).
  const SIG_LINK_ROUTES_CONTROLLER = "addLinkRoutingRule(";
  const RELAY_PORT = 8877; // must match relay/server.js's PORT
  // Extra settle time before deciding a tab is "background", so a
  // brand-new window's own onFocusChanged (which can lag its onCreated
  // event) has time to land before we compare against stale focus state.
  const BACKGROUND_CHECK_DELAY_MS = 200;
  const RELAY_REQUEST_TIMEOUT_MS = 5000;
  // Per-workspace new-tab-page override (Sixth feature, 2026-08-29) --
  // Vivaldi only has one global "New Tab Page" setting (Settings -> Tabs),
  // no per-workspace equivalent. Keyed by workspace *name* (like
  // findWorkspaceByName elsewhere in this file), not id -- names are this
  // codebase's existing identifier for "which workspace do you mean" in
  // every hand-configured spot. Only workspaces listed here are affected;
  // everywhere else, Vivaldi's own New Tab Page setting is untouched. Edit
  // this map and re-run injected/install.sh + restart Vivaldi to apply.
  //
  // A value can be a plain url string, or {url, focusSelector} -- the
  // latter also focuses the matching element (via CSS selector) once the
  // page loads, so e.g. Cmd+T in the Claude workspace lands the cursor in
  // the chat input instead of the URL bar (2026-09-02). focusSelector is
  // UNCONFIRMED as a mechanism -- everywhere else in this file reaches into
  // Vivaldi's own privileged UI via the webpack-scanning trick, but
  // focusing an element on the *loaded page itself* (claude.ai, a separate
  // process) needs chrome.scripting.executeScript, which nothing in this
  // project has used before and which may not even be exposed to this
  // unmanifested main.html context -- see focusSelectorWhenLoaded below.
  // Needs a real Cmd+T live test before trusting it; check the console for
  // [VWH] warnings if the cursor doesn't land where expected. The selector
  // below is a guess (claude.ai's chat box is a ProseMirror contenteditable
  // div) -- if wrong, open claude.ai, right-click the input box -> Inspect,
  // right-click the highlighted element in DevTools -> Copy -> Copy selector.
  const NEW_TAB_OVERRIDES = {
    Claude: { url: "https://claude.ai", focusSelector: '[data-testid="chat-input"]' },
  };
  function getNewTabOverride(workspaceName) {
    const entry = NEW_TAB_OVERRIDES[workspaceName];
    if (!entry) return null;
    return typeof entry === "string" ? { url: entry, focusSelector: null } : entry;
  }

  let workspaceStore = null;
  let linkRoutesController = null;
  let lastRoutedTab = null;
  let lastMovedTabs = null;
  let relaySocket = null;
  let relayRetryDelay = 1000;
  let nextRelayRequestId = 1;
  const pendingRelayRequests = new Map(); // requestId -> resolve(msg)

  // ---------- webpack harvest (same pattern as custom.js) ----------
  function harvestWebpackRequire() {
    return new Promise((resolve, reject) => {
      const chunk = window.webpackChunkgapp_browser_react;
      if (!chunk || typeof chunk.push !== "function") {
        return reject(new Error("webpackChunkgapp_browser_react not available"));
      }
      try {
        chunk.push([[Symbol("vwh-harvest")], {}, (req) => resolve(req)]);
      } catch (e) {
        reject(e);
      }
    });
  }

  function findModuleIdsBySignature(req, signature) {
    const out = [];
    const factories = req.m;
    if (!factories) return out;
    for (const id in factories) {
      const fn = factories[id];
      if (typeof fn !== "function") continue;
      let src;
      try {
        src = Function.prototype.toString.call(fn);
      } catch (_) {
        continue;
      }
      if (src.indexOf(signature) !== -1) out.push(id);
    }
    return out;
  }

  function resolveWorkspaceStore(req) {
    const ids = findModuleIdsBySignature(req, SIG_WORKSPACE_STORE);
    for (const id of ids) {
      try {
        const mod = req(id);
        const store = mod && (mod.Z || mod.ZP || mod);
        if (store && typeof store.getActiveWorkspaceId === "function" && typeof store.addListener === "function") {
          workspaceStore = store;
          console.log(TAG, "Found workspace store in module", id);
          return true;
        }
      } catch (e) {
        console.warn(TAG, "req(", id, ") for workspace store threw:", e);
      }
    }
    return false;
  }

  // Sibling to resolveWorkspaceStore -- same webpack-scan technique, same
  // module registry, different signature. Confirmed live (2026-08-24) that
  // this module's addLinkRoutingRule(type, expression, workspaceId) dispatches
  // the identical Redux action ("CREATE_WORKSPACE_LINK_ROUTE") Vivaldi's own
  // Settings -> Workspace Rules UI uses, which both updates live rule state
  // (takes effect immediately) and persists to vivaldi.workspaces.link_routes
  // in Preferences (verified via a scripted add/remove/re-read of the actual
  // Preferences file on disk) -- unlike workspace assignment, there's a real
  // API for this, no AppleScript/menu-click needed.
  function resolveLinkRoutesController(req) {
    const ids = findModuleIdsBySignature(req, SIG_LINK_ROUTES_CONTROLLER);
    for (const id of ids) {
      try {
        const mod = req(id);
        const controller = mod && (mod.Z || mod.ZP || mod);
        if (controller && typeof controller.addLinkRoutingRule === "function") {
          linkRoutesController = controller;
          console.log(TAG, "Found link-routes controller in module", id);
          return true;
        }
      } catch (e) {
        console.warn(TAG, "req(", id, ") for link-routes controller threw:", e);
      }
    }
    return false;
  }

  // A tab's OWN workspace -- see the big comment at the top of this file for
  // why this is not the same as "the workspace its window is displaying".
  function resolveWorkspaceForTab(tab) {
    if (!workspaceStore || !tab || !tab.vivExtData) return null;
    try {
      const ext = JSON.parse(tab.vivExtData);
      if (ext.workspaceId == null) return null;
      const ws = workspaceStore.getWorkspaceById(ext.workspaceId);
      return ws ? { id: ext.workspaceId, name: ws.name, emoji: ws.emoji } : null;
    } catch (e) {
      console.warn(TAG, "resolveWorkspaceForTab error:", e);
      return null;
    }
  }

  // The window currently displaying the given workspace id, if any.
  function findWindowDisplayingWorkspace(workspaceId) {
    if (!workspaceStore || workspaceId == null) return null;
    try {
      const active = workspaceStore.getActiveWorkspaces();
      for (const [wsId, winId] of active) {
        if (wsId === workspaceId) return winId;
      }
    } catch (e) {
      console.warn(TAG, "findWindowDisplayingWorkspace error:", e);
    }
    return null;
  }

  // The workspace a given window is currently displaying, if any (reverse
  // of findWindowDisplayingWorkspace -- used for the in-place-reassignment
  // detection below, which needs "what does this window show" rather than
  // "which window shows this workspace").
  function findWorkspaceIdForWindow(windowId) {
    if (!workspaceStore || windowId == null) return null;
    try {
      const active = workspaceStore.getActiveWorkspaces();
      for (const [wsId, winId] of active) {
        if (winId === windowId) return wsId;
      }
    } catch (e) {
      console.warn(TAG, "findWorkspaceIdForWindow error:", e);
    }
    return null;
  }

  // ---------- per-workspace new-tab-page override ----------
  //
  // Redirects a brand-new blank tab to NEW_TAB_OVERRIDES[workspaceName], if
  // one is configured for whichever workspace the tab's window is currently
  // displaying. "Blank" needs TWO signatures, not one -- confirmed live
  // (2026-08-29) that a synthetic chrome.tabs.create({}) via CDP (what the
  // first version of this feature was tested against) and a genuine Cmd+T
  // keystroke are NOT the same underlying call in this Vivaldi build, despite
  // looking like they should be: the synthetic one reports
  // pendingUrl:"chrome://newtab/", settling to url:"chrome://newtab/"
  // (Chromium's own extension-API default when no url is given); a real
  // keystroke instead reports pendingUrl:"about:blank", settling to a
  // permanent url:"about:blank", status:"complete" -- Vivaldi renders its
  // Speed Dial as an in-page overlay on top of that without ever navigating
  // the tab's actual url. The first version of this feature only matched
  // "chrome://newtab/" and so silently never fired for a real Cmd+T at all --
  // caught only because Aaron tried it live and it didn't work; the CDP test
  // that "confirmed" it during development was testing the wrong trigger.
  // Both URL strings are matched now, on both pendingUrl and url (covers the
  // listener firing at either point in either path). Uses the *window's*
  // currently displayed workspace (findWorkspaceIdForWindow), not the new
  // tab's own vivExtData -- what matters here is "what workspace was I
  // looking at when I pressed Cmd+T", the same question
  // onWorkspaceStoreChanged already answers elsewhere in this file, not the
  // tab-vs-window distinction the big header comment warns about for
  // *routed* tabs (which is about a tab's own membership possibly disagreeing
  // with its window -- not applicable to a tab that was just born in this
  // window and has no membership of its own yet).
  const BLANK_NEW_TAB_URLS = new Set(["chrome://newtab/", "about:blank"]);
  async function redirectNewTabIfConfigured(tab) {
    // "about:blank" is a much more generic signal than "chrome://newtab/"
    // was on its own -- a page's own window.open() call (no URL yet,
    // navigated moments later by that page's own JS, e.g. an OAuth popup)
    // also starts as about:blank, and this redirect would otherwise race
    // that and hijack it. chrome.tabs.Tab.openerTabId is standard,
    // documented Chromium extension-API behavior (not a Vivaldi-specific
    // quirk needing live reverse-engineering, unlike most of this file): set
    // whenever a tab was opened by another tab's script, absent for a
    // genuine Cmd+T/New Tab click. Excluding anything with an opener keeps
    // this scoped to tabs the *user* opened blank, not a page opening one
    // for its own purposes.
    if (tab.openerTabId != null) return;
    if (!BLANK_NEW_TAB_URLS.has(tab.pendingUrl) && !BLANK_NEW_TAB_URLS.has(tab.url)) return;
    const workspaceId = findWorkspaceIdForWindow(tab.windowId);
    if (workspaceId == null) return;
    const ws = workspaceStore.getWorkspaceById(workspaceId);
    if (!ws) return;
    const override = getNewTabOverride(ws.name);
    if (!override) return;

    // NOT chrome.tabs.update(tab.id, {url}) -- confirmed live (2026-09-03)
    // that it leaves real keyboard focus in the address bar no matter what,
    // even though the focusSelector injection below successfully found and
    // .focus()'d the actual chat input inside the page (proving this is a
    // browser-chrome focus layer tabs.update can't reach, not a
    // selector/script problem). Matches Mozilla bug 1411465 (marked
    // wontfix/by-design for Firefox: "no API parameter allows developers to
    // specify whether focus should go to content or the address bar" after
    // tabs.update with a url). Their documented workaround, used by the real
    // "New Tab Override" extension: recreate the tab via tabs.create()
    // instead -- a freshly created tab's content gets real focus, an
    // address-bar update never does. Same create+remove technique this file
    // already uses for a different tabs.move() bug -- see
    // recreateTabInWindow's own comment. index:tab.index keeps it in the
    // same tab-strip position rather than jumping to the end.
    //
    // Not yet independently confirmed live whether the new tabs.create()
    // call here (a *second* onCreated event, for the replacement tab) could
    // interact with the background-tab-routing detector further down this
    // same onCreated listener -- reasoning says no (this window is
    // necessarily focused, since Cmd+T always happens in the focused
    // window, so the detector's own focus check should see it as
    // foreground), but flag to Aaron if a spurious toast/jump ever appears
    // right after a redirected new tab.
    const newTab = await callChrome(chrome.tabs, "create", {
      windowId: tab.windowId,
      index: tab.index,
      url: override.url,
      active: true,
    });
    await callChrome(chrome.tabs, "remove", tab.id);
    if (override.focusSelector) focusSelectorWhenLoaded(newTab.id, override.focusSelector);
  }

  // Focuses override.focusSelector inside the tab once it finishes loading.
  // Polls rather than firing once at "complete", since a single-page app
  // (claude.ai) is typically still hydrating at that point -- the element
  // this targets often doesn't exist in the DOM yet even once Chromium
  // considers the navigation itself "complete".
  const FOCUS_SELECTOR_TIMEOUT_MS = 8000;
  const FOCUS_SELECTOR_POLL_MS = 150;
  function focusSelectorWhenLoaded(tabId, selector) {
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      injectFocusSelector(tabId, selector);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  }

  function injectFocusSelector(tabId, selector) {
    if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
      console.warn(TAG, "chrome.scripting.executeScript unavailable in this context -- cannot focus", selector);
      return;
    }
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: (sel, timeoutMs, pollMs) => {
          const start = Date.now();
          (function tryFocus() {
            const el = document.querySelector(sel);
            if (el) {
              el.focus();
              console.log("[VWH-focus] focused", sel);
              return;
            }
            if (Date.now() - start < timeoutMs) {
              setTimeout(tryFocus, pollMs);
            } else {
              console.warn("[VWH-focus] gave up looking for", sel, "after", timeoutMs, "ms");
            }
          })();
        },
        args: [selector, FOCUS_SELECTOR_TIMEOUT_MS, FOCUS_SELECTOR_POLL_MS],
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(TAG, "focus-selector injection failed:", chrome.runtime.lastError.message);
        }
      }
    );
  }

  function getDomain(url) {
    try {
      return new URL(url).hostname || url;
    } catch (e) {
      return url || "(page)";
    }
  }

  // Resolves as soon as the tab has a real URL -- usually immediately,
  // since it's typically already set by the time this is called; the
  // timeout is only a bounded fallback for the rarer case where it isn't
  // yet. Not a wait-for-page-load: the toast doesn't need the title, only
  // the URL (for the domain), and url is set as soon as navigation starts.
  function waitForUrl(tabId, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      function onUpdated(updatedTabId, changeInfo, tab) {
        if (updatedTabId === tabId && tab.url) finish(tab);
      }
      function finish(tab) {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        if (timer) clearTimeout(timer);
        resolve(tab);
      }
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return finish(null);
        if (tab.url) return finish(tab);
        chrome.tabs.onUpdated.addListener(onUpdated);
        timer = setTimeout(() => {
          chrome.tabs.get(tabId, (t) => finish(chrome.runtime.lastError ? null : t));
        }, timeoutMs);
      });
    });
  }

  // Broadcasts to every window.html instance; only the one matching
  // displayWindowId (the window the user is actually looking at) renders
  // anything -- see window-toast.js, which owns the actual UI/timing/keybind.
  function showToast(routedTab) {
    chrome.runtime.sendMessage({
      type: "vwh-show-toast",
      displayWindowId: routedTab.displayWindowId,
      targetTabId: routedTab.tabId,
      workspaceId: routedTab.workspaceId,
      // May be null (unresolved) -- window-toast.js applies a display-only
      // fallback for that case. Don't fake a name here: it gets echoed back
      // in the jump request, and jumpToTab would try to create/activate a
      // workspace literally named "(unknown workspace)".
      workspaceName: routedTab.workspaceName,
      workspaceEmoji: routedTab.workspaceEmoji,
      domain: getDomain(routedTab.url),
    });
  }

  // Tells the destination window's own toast instance (wherever jumpToTab
  // actually landed the tab -- result.windowId, NOT routedTab.windowId,
  // which is only where the tab originally happened to land before being
  // moved) that the jump already happened, informationally.
  function showJumpedToast(routedTab, result) {
    chrome.runtime.sendMessage({
      type: "vwh-show-toast",
      variant: result.created ? "created-window" : "raised-window",
      displayWindowId: result.windowId,
      workspaceName: routedTab.workspaceName,
      workspaceEmoji: routedTab.workspaceEmoji,
    });
  }

  // De-dupes a tab that satisfies "landed in a background window" via more
  // than one event (e.g. onCreated then immediately onAttached -- see the
  // onAttached comment below) so it doesn't toast twice.
  const recentlyHandledTabIds = new Set();

  // tabId -> the tab's own active flag *at creation time*, captured in
  // chrome.tabs.onCreated (see that listener below) before anything can
  // move or mutate it. Bounded cleanup, not tied to any particular tab's
  // lifetime -- just needs to outlive the settle window in
  // handleBackgroundTab, which is well under this.
  const tabOriginalActiveState = new Map();

  // A tab's *own* active flag at creation time is the real "was this
  // meant to be seen immediately" signal -- confirmed live (both via a
  // synthetic chrome.tabs.move and a genuine external open) that Vivaldi
  // resets active to false the moment a tab lands in a window via a
  // cross-window move, regardless of how it started, so it must be looked
  // up from tabOriginalActiveState (captured back at onCreated) rather than
  // read off the tab object here -- by this point that's already stale.
  // Only ever called when displayWindowId !== the tab's own window (both
  // call sites gate on that already) -- i.e. always "landed in some other,
  // real, already-existing window" (Vivaldi never auto-creates one; see the
  // header comment and onWorkspaceStoreChanged for the windowless case).
  async function handleBackgroundTab(tab, displayWindowId) {
    if (recentlyHandledTabIds.has(tab.id)) return;
    recentlyHandledTabIds.add(tab.id);
    setTimeout(() => recentlyHandledTabIds.delete(tab.id), 10000);

    // Only waits for a real URL, not a fully-loaded page -- the toast
    // doesn't show the title anymore, so there's no reason to wait for
    // that. Usually resolves immediately (the URL is often already there by
    // the time this runs); the timeout is just a bounded safety net for the
    // rarer case where it isn't yet (confirmed live: url can genuinely
    // still be empty at this exact instant).
    const freshTab = (await waitForUrl(tab.id, 1000)) || tab;
    const ws = resolveWorkspaceForTab(freshTab);
    const routedTab = {
      windowId: freshTab.windowId,
      tabId: freshTab.id,
      workspaceId: ws ? ws.id : null,
      workspaceName: ws ? ws.name : null,
      workspaceEmoji: ws ? ws.emoji : null,
      url: freshTab.url,
      displayWindowId,
    };
    lastRoutedTab = routedTab;

    // Falls back to the (likely-stale, but better than nothing) current
    // value if this tab's creation was never observed -- shouldn't happen
    // in practice since every tab we ever handle came through onCreated
    // first, but avoids a hard failure if it somehow did.
    const wasOriginallyActive = tabOriginalActiveState.has(tab.id) ? tabOriginalActiveState.get(tab.id) : freshTab.active;

    if (wasOriginallyActive) {
      // Externally-opened (or otherwise explicitly-foreground) tabs carry
      // clear intent to be seen right away -- jump there automatically
      // instead of making the user click a toast first. jumpToTab (below,
      // shared with the toast-click and relay paths) re-derives the real
      // target window itself via findWindowDisplayingWorkspace(workspaceId)
      // rather than trusting routedTab.windowId (which is only wherever the
      // tab happened to land, not necessarily a window displaying its
      // workspace -- confirmed live, a windowless target can land in some
      // unrelated already-open window without that window ever displaying
      // it), and creates + assigns a brand-new window when no window
      // displays the target workspace at all. That sidesteps needing the
      // old "is this really the right window" special case entirely: if it
      // doesn't already exist, it doesn't have a display mismatch either.
      if (routedTab.workspaceId == null) {
        // Workspace couldn't be resolved (e.g. vivExtData missing/stale) --
        // jumpToTab has nothing to target and would just no-op-refocus the
        // tab's current window under an "(unknown workspace)" label. Fall
        // back to the interactive toast, same as the unresolved case always
        // behaved before this change.
        console.log(TAG, "Foreground-intent route with unresolved workspace -- falling back to click-to-jump:", routedTab);
        showToast(routedTab);
      } else {
        console.log(TAG, "Foreground-intent route -- jumping automatically:", routedTab);
        const result = await jumpToTab(routedTab.tabId, routedTab.workspaceId, routedTab.workspaceName);
        if (result.ok) {
          showJumpedToast(routedTab, result);
        } else {
          // e.g. the relay is down and a new window/workspace assignment was
          // needed -- fall back to the interactive toast so the user still
          // has a way to jump once the underlying problem is fixed.
          console.error(TAG, "Automatic jump failed, falling back to click-to-jump:", result.reason);
          showToast(routedTab);
        }
      }
    } else {
      console.log(TAG, "Background-routed tab detected:", routedTab);
      showToast(routedTab);
    }
  }

  // Fresh, live check rather than trusting a cached "last focused window" --
  // avoids races like a brand-new window's own initial tab (e.g. Cmd+N)
  // being misjudged as background before that window's own focus event has
  // been processed. A small delay lets Chromium's own focus bookkeeping
  // settle first, which is more reliable than any ordering we could impose
  // on our own event listeners.
  function checkIfBackgroundThenHandle(windowId, getTab) {
    setTimeout(() => {
      chrome.windows.getLastFocused({}, (focusedWin) => {
        const displayWindowId = focusedWin ? focusedWin.id : null;
        if (displayWindowId != null && displayWindowId === windowId) return; // not background
        getTab((tab) => {
          if (!tab) return;
          handleBackgroundTab(tab, displayWindowId);
        });
      });
    }, BACKGROUND_CHECK_DELAY_MS);
  }

  // Catches the case neither onCreated nor onAttached can: when a rule
  // targets a workspace with no window at all, Vivaldi doesn't move the tab
  // anywhere to wait for -- it just tags the tab in place (still sitting in
  // whatever window it was created in, often the focused one) via
  // vivExtData, moments after creation. Confirmed live: chrome.tabs.onUpdated
  // fires with changeInfo.vivExtData set at exactly that moment, so this
  // checks directly for "this tab's own workspace isn't the one its window
  // is displaying" whenever that field changes, independent of whether the
  // tab ever moved windows at all.
  function checkWorkspaceTagThenHandle(tab) {
    const ws = resolveWorkspaceForTab(tab);
    if (!ws) return;
    if (findWindowDisplayingWorkspace(ws.id) === tab.windowId) return; // already correctly displayed
    chrome.windows.getLastFocused({}, (focusedWin) => {
      const displayWindowId = focusedWin ? focusedWin.id : null;
      // This skip exists ONLY for background (cmd+click) tabs -- see the big
      // comment below for why. Foreground-intent tabs (wasOriginallyActive)
      // must never defer here: handleBackgroundTab's own jumpToTab call now
      // resolves the correct outcome deterministically every time (raise an
      // existing window, or create one), regardless of whether Vivaldi ever
      // does a native in-place reassignment at all -- and when the target
      // workspace already has a window elsewhere, jumpToTab just focuses it
      // without ever touching the workspace store, so onWorkspaceStoreChanged
      // would never fire to pick up the slack. Confirmed live (2026-08-12):
      // deferring foreground-intent tabs here caused a total silent drop --
      // no toast, no jump, tab left sitting wherever it was created -- for
      // exactly that "target already has a window" case, reproduced via a
      // scripted repeated-test harness (see the planning doc's 2026-08-12
      // section).
      const wasOriginallyActive = tabOriginalActiveState.has(tab.id) ? tabOriginalActiveState.get(tab.id) : tab.active;
      if (wasOriginallyActive) {
        handleBackgroundTab(tab, displayWindowId);
        return;
      }
      // Only skip if onWorkspaceStoreChanged's own correlation will actually
      // catch this tab -- i.e. it's sitting in the focused window *and* it's
      // the specific active:true tab that path is watching for there. A
      // regression, caught live: this used to skip for *any* tab sitting in
      // the focused window with a mismatch, on the theory that it was always
      // a race against the in-place foreground-switch. But that path's
      // correlation (recentActiveTabWindows) only ever tracks active:true
      // tabs -- a background (active:false) cmd+click tab routed to a
      // windowless workspace also never leaves the focused window (same as
      // the foreground case), so it hit this same skip and then had *no*
      // path left to notify through at all. Confirmed live: after closing a
      // window this feature had created for a workspace, a subsequent
      // cmd+click back to that now-windowless workspace produced no
      // notification whatsoever, exactly this silent-drop case.
      if (displayWindowId != null && displayWindowId === tab.windowId && recentActiveTabWindows.get(tab.windowId) === tab.id) {
        return;
      }
      handleBackgroundTab(tab, displayWindowId);
    });
  }

  function getTab(tabId) {
    return new Promise((resolve) => chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime.lastError ? null : tab)));
  }

  // ---------- in-place foreground-window reassignment ----------
  //
  // A different case from everything above: an externally-opened URL (see
  // FOREGROUND_TAB_CORRELATION_MS below for how "externally-opened" is
  // recognized) routed to a workspace with *no window at all* doesn't get a
  // new window from Vivaldi itself -- confirmed live, Vivaldi instead
  // switches the *current foreground window's* displayed workspace in place
  // and loads the tab there. This is invisible to every check above (the
  // tab's own workspace and its window's displayed workspace already agree
  // by the time we'd look), so it needs its own signal: watching the
  // workspace store directly for the focused window's displayed workspace
  // changing, correlated against a just-created foreground tab so this
  // doesn't also fire for the user's own manual workspace switches (which
  // are not routed tabs at all and shouldn't get a route-related toast).
  const FOREGROUND_TAB_CORRELATION_MS = 3000;
  const recentActiveTabWindows = new Map(); // windowId -> tabId

  // windowIds jumpToTab itself just created (see jumpToTab below). A brand
  // new window's own default tab is created active:true, which satisfies
  // recentActiveTabWindows' correlation just as well as a genuine routed
  // tab would -- so without this, jumpToTab assigning a workspace to a
  // window it just created (the "no window existed yet" branch) reads to
  // onWorkspaceStoreChanged as indistinguishable from Vivaldi natively
  // reassigning some *other*, pre-existing foreground window in place.
  // Confirmed live (2026-08-12): this produced a second, spurious
  // "foreground-switch" toast moments after jumpToTab's own correct
  // "created-window" toast, silently overwriting it (window-toast.js
  // replaces whatever's showing on each new message) -- see the planning
  // doc's 2026-08-12 section.
  const windowsCreatedByJumpToTab = new Set();

  // windowId -> count of recreateTabInWindow calls currently in flight for
  // that window. recreateTabInWindow (below) does chrome.tabs.create() to
  // move a tab into a window -- a deliberate workaround for chrome.tabs.move
  // being unreliable here (see that function's own comment) -- but create()
  // fires chrome.tabs.onCreated, the exact same event the background-tab
  // auto-routing detector below listens for. Confirmed live (2026-08-26):
  // when the destination window was already open (not newly created by this
  // same operation, which stays transiently focused and so reads as "not
  // background"), moveTabsToWorkspace's recreated tab got misread as an
  // externally-opened foreground-intent tab, triggering an automatic
  // jumpToTab straight back to the window this was supposed to leave
  // unfocused -- undoing moveTabsToWorkspace's whole "stay on the source
  // window" design and firing a spurious "raised-window" toast, every time
  // (not racy) once the target window already existed. Marked *before*
  // calling chrome.tabs.create, not after from the resolved tab id, so
  // there's no window where onCreated could fire before the mark exists --
  // chrome.tabs.create's own callback isn't guaranteed to resolve strictly
  // before the onCreated event reaches this listener.
  const windowsReceivingOwnRecreatedTabs = new Map();

  function markWindowReceivingOwnTab(windowId) {
    windowsReceivingOwnRecreatedTabs.set(windowId, (windowsReceivingOwnRecreatedTabs.get(windowId) || 0) + 1);
  }
  function unmarkWindowReceivingOwnTab(windowId) {
    const remaining = (windowsReceivingOwnRecreatedTabs.get(windowId) || 1) - 1;
    if (remaining <= 0) windowsReceivingOwnRecreatedTabs.delete(windowId);
    else windowsReceivingOwnRecreatedTabs.set(windowId, remaining);
  }

  let lastKnownFocusedWorkspaceId; // undefined until first computed in init()

  function refreshFocusedWorkspaceBaseline() {
    chrome.windows.getLastFocused({}, (win) => {
      lastKnownFocusedWorkspaceId = win ? findWorkspaceIdForWindow(win.id) : null;
    });
  }

  function onWorkspaceStoreChanged() {
    chrome.windows.getLastFocused({}, (focusedWin) => {
      if (!focusedWin) return;
      const newWsId = findWorkspaceIdForWindow(focusedWin.id);
      const recentTabId = recentActiveTabWindows.get(focusedWin.id);
      if (windowsCreatedByJumpToTab.has(focusedWin.id)) {
        // This store change is jumpToTab assigning a workspace to a window
        // it just created itself -- not a native Vivaldi reassignment.
        // jumpToTab already shows its own correct toast for this; don't
        // also fire ours on top of it.
        lastKnownFocusedWorkspaceId = newWsId;
        return;
      }
      if (newWsId != null && newWsId !== lastKnownFocusedWorkspaceId && recentTabId != null) {
        recentActiveTabWindows.delete(focusedWin.id);
        const ws = workspaceStore.getWorkspaceById(newWsId);
        console.log(TAG, "Foreground window's workspace changed in place:", focusedWin.id, ws && ws.name);
        chrome.runtime.sendMessage({
          type: "vwh-show-toast",
          variant: "foreground-switch",
          displayWindowId: focusedWin.id,
          workspaceName: ws ? ws.name : null,
          workspaceEmoji: ws ? ws.emoji : null,
        });
      }
      lastKnownFocusedWorkspaceId = newWsId;
    });
  }

  // ---------- jump action (shared by toast click, in-toast keybind, and relay) ----------
  //
  // Promise wrapper for chrome.* callback APIs that actually checks
  // chrome.runtime.lastError. Every plain `new Promise((resolve) =>
  // chrome.foo(..., resolve))` pattern elsewhere in this file silently
  // swallows API errors -- the callback still fires, so the promise still
  // resolves, and calling code has no way to tell success from failure.
  // That turned out to matter a lot for moveSelectedTabsToWorkspace
  // specifically (confirmed live, 2026-08-13): chrome.tabs.move on a tab
  // that's part of a tab stack/group can fail outright, but without this,
  // the failure was invisible -- the function still returned {ok:true} with
  // a tab that never actually moved. Takes the owning object and method
  // name separately (chrome.tabs, "move", ...) rather than a bare function
  // reference -- detaching e.g. chrome.tabs.move from chrome.tabs and
  // invoking it later loses its `this` binding, which these APIs rely on
  // internally.
  function callChrome(obj, method, ...args) {
    return new Promise((resolve, reject) => {
      obj[method](...args, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
  }

  // Mirrors bridge/workspace-jump.js's own two-branch decision exactly:
  // if the workspace already has a window, focus *that* one; if not, create
  // a brand-new blank window and assign it, rather than force-switching
  // some unrelated existing window away from whatever it's currently
  // showing (the exact silent-reassignment problem this whole project
  // exists to avoid -- see the planning doc's "Rejected approach" section).
  // Shared by jumpToTab and moveSelectedTabsToWorkspace below -- both need
  // exactly this "find or create the one window for this workspace" step,
  // just followed by different things (moving one specific tab vs. moving
  // whatever's currently selected).
  // focusExisting controls whether an already-open target window is raised
  // as part of resolving it. jumpToTab wants that (the whole point is to end
  // up looking at the target); moveSelectedTabsToWorkspace passes false --
  // moving tabs into a window doesn't require it to be focused, and that
  // caller wants to stay on the source window instead (see its own comment).
  // A brand-new window is always left focused regardless -- unavoidable,
  // since activateWorkspaceViaMenu's AppleScript acts on the frontmost
  // window -- callers that don't want that (moveSelectedTabsToWorkspace)
  // reclaim focus themselves afterward.
  async function resolveOrCreateWindowForWorkspace(workspaceId, workspaceName, { focusExisting = true } = {}) {
    let targetWindowId = findWindowDisplayingWorkspace(workspaceId);
    let created = false;
    // Set only when we create a brand-new window: its own default blank/
    // startpage tab, which chrome.windows.create({}) always adds and which
    // is never otherwise cleaned up. Left in place, the destination window
    // ends up with two tabs -- the real moved one, plus this placeholder --
    // which turned out to be the actual explanation for the "no tab
    // indicator" reports during testing (2026-08-13): what looked like a
    // moved tab arriving with no tab-strip entry was this leftover default
    // tab sitting there generically labeled, while the real moved tab (with
    // its own real title) was the one actually missing/misrendered. Callers
    // close this once their own move has landed -- see jumpToTab and
    // moveSelectedTabsToWorkspace below.
    let defaultTabId = null;

    if (targetWindowId != null) {
      if (focusExisting) await chrome.windows.update(targetWindowId, { focused: true });
    } else if (workspaceName) {
      const newWin = await new Promise((resolve) => chrome.windows.create({}, resolve));
      targetWindowId = newWin.id;
      created = true;
      windowsCreatedByJumpToTab.add(targetWindowId);
      setTimeout(() => windowsCreatedByJumpToTab.delete(targetWindowId), 10000);
      // Aaron reported (2026-08-25) the add-rule context menu item going
      // missing again specifically after a "move this tab now" that needed
      // a brand-new window -- a run that didn't need one (existing window,
      // or a later run after restart) didn't reproduce it. Consistent with
      // the already-confirmed startup wipe (which also happens amid a wave
      // of window/subsystem initialization), so window creation itself is
      // a plausible second trigger -- recheck here too, not just after a
      // menu click (a click doesn't always lead to this path). Delayed the
      // same ~500ms as the post-click recheck, since the startup wipe's own
      // observed timing (present at 1.5s, gone by 1.8s) suggests checking
      // immediately after the triggering event would be too early to catch it.
      setTimeout(ensureContextMenuItem, 500);
      const defaultTabs = await new Promise((resolve) => chrome.tabs.query({ windowId: targetWindowId }, resolve));
      if (defaultTabs.length === 1) defaultTabId = defaultTabs[0].id;
      // No extra focus call needed here -- a freshly created window is
      // already the focused one, and activateWorkspaceViaMenu's own
      // "tell application Vivaldi to activate" acts on it directly, same
      // as bridge/workspace-jump.js's own ASSIGNED branch.
      const activated = await requestActivateWorkspace(workspaceName);
      if (!activated.ok) {
        throw new Error("ACTIVATE_FAILED: " + activated.reason);
      }
      // Settle delay. Assigning a workspace to a window isn't just a label
      // change -- per the one-window-per-workspace exclusivity (see the top
      // of this file), Vivaldi itself moves that workspace's own
      // already-tagged tabs into this window as a side effect, and that
      // reconciliation is still in flight immediately after the menu click
      // returns. Racing our own tab move against it produced real breakage
      // in testing (2026-08-13): tabs reported as moved that never
      // appeared, and tabs that landed with visible content but no
      // tab-strip entry at all. Not a guaranteed fix -- likely the same
      // underlying Vivaldi flakiness as the already-reported "move tab to
      // workspace" bug -- but gives Vivaldi's own side effect a beat to
      // finish first.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      throw new Error("NO_TARGET_WORKSPACE");
    }

    return { windowId: targetWindowId, created, defaultTabId };
  }

  // Closes the destination window's own leftover default tab (see
  // resolveOrCreateWindowForWorkspace) -- but only once it's no longer the
  // window's only tab, so a failed move never leaves the window empty/closed.
  async function closeDefaultTabIfSafe(windowId, defaultTabId) {
    if (defaultTabId == null) return;
    try {
      const tabs = await new Promise((resolve) => chrome.tabs.query({ windowId }, resolve));
      if (tabs.length > 1 && tabs.some((t) => t.id === defaultTabId)) {
        await callChrome(chrome.tabs, "remove", defaultTabId);
      }
    } catch (e) {
      console.warn(TAG, "closeDefaultTabIfSafe failed:", e);
    }
  }

  // Recreates a tab in the destination window instead of cross-window
  // moving it there, then closes the original -- returns the new tab's id.
  // Confirmed live (2026-08-13, with CDP + screenshots, not just reasoning):
  // a plain chrome.tabs.move to a different window can leave the moved tab
  // with NO tab-strip entry at all in Vivaldi -- fully functional (content
  // renders correctly, chrome.tabs.query reports it accurately, activating
  // it via the API works) but permanently unreachable through any tab-strip
  // interaction (clicking, Ctrl+Tab cycling), even after a settle delay,
  // re-activating it, or forcing a window resize to trigger a layout
  // reflow. Recreating the tab via chrome.tabs.create instead goes through
  // Vivaldi's ordinary tab-creation path (the same one regular Cmd+T tabs
  // use, which was never in question), and was confirmed live to render
  // correctly every time in the same reproduction that broke with `move`.
  // Deliberate trade-off, not a caveat that slipped through: this loses the
  // tab's own back/forward history and any in-page JS state (e.g. unsaved
  // form input) -- real costs, but far smaller than landing a tab you can
  // never get back to.
  // appendToEnd is optional -- when falsy, Vivaldi's own "open new tabs"
  // setting decides placement (e.g. next to the active tab), which is what
  // jumpToTab wants (a single routed tab, no ordering complaint).
  // moveTabsToWorkspace passes true to force append-at-the-end regardless of
  // that setting -- see its own call site for why.
  //
  // 2026-09-14: originally this passed an explicit `index` (the destination
  // window's current tab count) straight to chrome.tabs.create, but Aaron
  // found live that this didn't land at the bottom reliably -- landed in
  // different places across repeated trials. A same-window chrome.tabs.move
  // to index -1 (tabs.move's own documented "end of window" sentinel) after
  // creation was tried next, on the theory that Vivaldi's own placement
  // logic was silently overriding tabs.create's index request at creation
  // time (the same class of bug already found here for chrome.tabs.move
  // cross-window and tabs.update(url)'s focus). That's kept below, but
  // Aaron identified a second, independent mechanism it doesn't cover:
  // Settings -> Tabs has a separate "open tabs in current tab stack" option
  // (distinct from "new tab position: as tab stack with related tab", which
  // Aaron confirmed is off) -- if the destination window's currently *active*
  // tab happens to be part of a stack, a plain chrome.tabs.create joins the
  // new tab into that stack, wherever the stack sits in the tab strip, which
  // would explain landing in different places across trials depending on
  // which tab was active there. Fixed per Aaron's own suggested workaround:
  // explicitly select the window's actual last tab *before* creating, so
  // that whatever stack-join behavior fires is at least anchored to the end
  // of the tab strip -- if that last tab is itself stacked, the moved tab
  // predictably joins that end stack (an accepted, understood outcome, not
  // a bug) rather than landing in an arbitrary stack elsewhere; if it isn't
  // stacked, the moved tab simply lands right after it with no stack
  // involvement at all. Selecting a tab via chrome.tabs.update({active:true})
  // only changes which tab is selected *within* that window, not window
  // focus (chrome.windows.update's job) -- doesn't disturb
  // moveTabsToWorkspace's "stay on the source window" design.
  // Not yet reconfirmed live after this change -- see the CLAUDE.md note.
  //
  // ignoreLinkRouting: true (2026-10-07): without it, chrome.tabs.create runs
  // the new tab's URL through Vivaldi's own workspace rules, so a tab whose
  // URL matches a rule for some *other* workspace gets yanked straight back
  // out of the destination window. Aaron hit this moving two doximity.com
  // tabs from Work to Home with a "doximity.com -> Work" rule in place: the
  // recreated tabs were routed right back into the Work window, and the
  // background-tab detector then saw an active tab "routed" into an
  // unfocused window and auto-jumped there, popping Work back to the front.
  // Reproducible every time for those specific tabs, not a race. Not an
  // undocumented hack: ignoreLinkRouting is a declared optional property of
  // tabs.create in Vivaldi's own tabs API schema (in the Vivaldi Framework
  // binary), and bundle.js's own "open link in workspace X" context menu
  // passes exactly this flag for the same reason -- the destination
  // workspace was chosen explicitly, so rules must not override it.
  async function recreateTabInWindow(tab, windowId, active, appendToEnd) {
    markWindowReceivingOwnTab(windowId);
    try {
      if (appendToEnd) {
        const existingTabs = await callChrome(chrome.tabs, "query", { windowId });
        if (existingTabs.length) {
          const lastTab = existingTabs.reduce((a, b) => (b.index > a.index ? b : a));
          await callChrome(chrome.tabs, "update", lastTab.id, { active: true });
        }
      }
      const newTab = await callChrome(chrome.tabs, "create", {
        windowId,
        url: tab.url,
        active: !!active,
        pinned: tab.pinned,
        ignoreLinkRouting: true,
      });
      if (appendToEnd) {
        await callChrome(chrome.tabs, "move", newTab.id, { index: -1 });
      }
      await callChrome(chrome.tabs, "remove", tab.id);
      return newTab.id;
    } finally {
      // The onCreated listener's check is synchronous at the top of its own
      // callback, so the mark really only needs to outlive that one event --
      // this delay is generous insurance, not a measured requirement.
      setTimeout(() => unmarkWindowReceivingOwnTab(windowId), 1000);
    }
  }

  // The routed tab is then moved into whichever window that resolves to.
  async function jumpToTab(tabId, workspaceId, workspaceName) {
    try {
      let targetWindowId;
      let created = false;
      let defaultTabId = null;

      if (workspaceId != null || workspaceName) {
        const resolved = await resolveOrCreateWindowForWorkspace(workspaceId, workspaceName);
        targetWindowId = resolved.windowId;
        created = resolved.created;
        defaultTabId = resolved.defaultTabId;
      } else {
        const tab = await getTab(tabId);
        targetWindowId = tab ? tab.windowId : null;
      }

      if (targetWindowId == null) return { ok: false, reason: "NO_TARGET_WINDOW" };

      const currentTab = await getTab(tabId);
      if (currentTab && currentTab.windowId !== targetWindowId) {
        tabId = await recreateTabInWindow(currentTab, targetWindowId, true);
      } else {
        await chrome.tabs.update(tabId, { active: true });
      }
      await closeDefaultTabIfSafe(targetWindowId, defaultTabId);

      return { ok: true, windowId: targetWindowId, tabId, workspaceName, created };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  async function jumpToLastRoutedTab() {
    if (!lastRoutedTab) return { ok: false, reason: "NO_RECENT_ROUTE" };
    const { tabId, workspaceId, workspaceName } = lastRoutedTab;
    return jumpToTab(tabId, workspaceId, workspaceName);
  }

  function findWorkspaceByName(name) {
    if (!workspaceStore) return null;
    const workspaces = workspaceStore.getWorkspaces();
    return workspaces.find((w) => w.name === name) || null;
  }

  // Mirrors bridge/workspace-jump.js's entire job (the CDP-based
  // per-workspace hotkey, requiring --remote-debugging-port) via the relay
  // instead -- no tab is involved at all here, unlike jumpToTab, so this is
  // just resolveOrCreateWindowForWorkspace on its own. A brand-new window's
  // own default blank tab is deliberately left in place rather than cleaned
  // up (unlike jumpToTab/moveTabsToWorkspace, which close it once a real tab
  // has landed) -- that leftover blank tab is exactly what
  // bridge/workspace-jump.js's own ASSIGNED branch already produces
  // (chrome.windows.create({}) then just assigning the workspace, nothing
  // loaded into it). Reachable only via the relay (see connectRelay below)
  // -- there's no in-page trigger for "just go to workspace N", same as
  // moveSelectedTabsToWorkspace.
  async function jumpToWorkspace(workspaceName) {
    try {
      const ws = findWorkspaceByName(workspaceName);
      if (!ws) return { ok: false, reason: "UNKNOWN_WORKSPACE" };
      const { windowId, created } = await resolveOrCreateWindowForWorkspace(ws.id, ws.name);
      return { ok: true, windowId, created, workspaceId: ws.id, workspaceName: ws.name };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  // Shared by moveSelectedTabsToWorkspace (external hotkey, "whatever's
  // selected") and moveTabForRuleDialog (the add-rule dialog's "move this
  // tab now" checkbox, one specific tab) -- both need exactly "recreate
  // these tabs in the resolved/created window for this workspace, clean up
  // any leftover default tab, then decide whose focus wins." focusDestination
  // mirrors resolveOrCreateWindowForWorkspace's own focusExisting for an
  // *existing* target window; a brand-new window is always left focused
  // regardless (see that function's own comment on why), so this reclaims
  // focus for the source afterward when the caller doesn't want to follow.
  async function moveTabsToWorkspace(tabs, sourceWindowId, workspaceId, workspaceName, { focusDestination } = {}) {
    const { windowId: targetWindowId, created, defaultTabId } = await resolveOrCreateWindowForWorkspace(workspaceId, workspaceName, {
      focusExisting: focusDestination,
    });

    if (targetWindowId !== sourceWindowId) {
      // Recreate each tab in the destination rather than cross-window
      // moving it -- see recreateTabInWindow's own comment for why
      // chrome.tabs.move turned out to be unreliable here (it also
      // sidesteps a related, now-moot problem: chrome.tabs.move doesn't
      // reliably support moving a tab still part of a tab stack/group
      // across windows either, and recreating never touches the original
      // tab's group membership at all). Each tab keeps its own original
      // `active` state, so whichever one was already active ends up the
      // only one active in the new window too.
      //
      // appendToEnd: true (2026-09-14, per Aaron's feedback): without it,
      // chrome.tabs.create falls back to Vivaldi's own "open new tabs" setting,
      // which lands the recreated tab next to the destination's active tab
      // rather than at the end -- surprising for a tab the user is deliberately
      // moving to sit alongside that workspace's existing tabs. See
      // recreateTabInWindow's own comment for why this is a post-creation
      // chrome.tabs.move rather than an index passed to chrome.tabs.create.
      for (const tab of tabs) {
        await recreateTabInWindow(tab, targetWindowId, tab.active, true);
      }
    }
    await closeDefaultTabIfSafe(targetWindowId, defaultTabId);

    if (!focusDestination && targetWindowId !== sourceWindowId) {
      await chrome.windows.update(sourceWindowId, { focused: true });
    }

    return { ok: true, windowId: targetWindowId, sourceWindowId, tabCount: tabs.length, created };
  }

  // Workaround for a Vivaldi bug (confirmed live, both the "Move Active Tab
  // to Workspace N" keyboard shortcuts and the tab's own right-click "Move"
  // submenu currently do nothing at all, silently -- reproduces with this
  // extension completely uninstalled, so it isn't us): moves whatever tab(s)
  // are currently selected (chrome.tabs' own `highlighted` flag -- true for
  // the lone active tab when nothing else is multi-selected, true for every
  // tab in a cmd+click multi-selection) in the focused window to the named
  // workspace, creating and assigning a window for it first if none exists
  // yet -- same underlying mechanism as jumpToTab, just operating on
  // "whatever's selected right now" instead of one specific routed tab.
  // Reachable only via the relay (see connectRelay below), since there's no
  // in-page trigger for this at all -- it exists specifically to be bound to
  // an external hotkey (e.g. Keyboard Maestro) in place of Vivaldi's own
  // broken shortcut.
  async function moveSelectedTabsToWorkspace(workspaceName) {
    try {
      const ws = findWorkspaceByName(workspaceName);
      if (!ws) return { ok: false, reason: "UNKNOWN_WORKSPACE" };

      const sourceWin = await new Promise((resolve) => chrome.windows.getLastFocused({}, resolve));
      if (!sourceWin) return { ok: false, reason: "NO_FOCUSED_WINDOW" };

      const selectedTabs = await new Promise((resolve) =>
        chrome.tabs.query({ windowId: sourceWin.id, highlighted: true }, resolve)
      );
      if (!selectedTabs.length) return { ok: false, reason: "NO_SELECTED_TABS" };

      // focusDestination: false -- unlike jumpToTab, this caller doesn't
      // want to end up looking at the destination. Per Aaron's feedback
      // (2026-08-14), the old behavior of ending up on the destination
      // workspace was disorienting for a background move triggered by an
      // external hotkey. The destination is reachable via the toast below
      // (or jumpToLastMovedTabs) instead.
      const moveResult = await moveTabsToWorkspace(selectedTabs, sourceWin.id, ws.id, ws.name, { focusDestination: false });

      const result = {
        ...moveResult,
        workspaceId: ws.id,
        workspaceName: ws.name,
        workspaceEmoji: ws.emoji,
      };
      lastMovedTabs = { workspaceId: ws.id, workspaceName: ws.name, workspaceEmoji: ws.emoji };
      return result;
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  // The add-rule dialog's "move this tab now" checkbox (Feature 5) -- moves
  // one specific tab (the one the dialog was opened for, captured at
  // showAddRuleDialog time) rather than "whatever's currently selected",
  // since the dialog can stay open long enough for focus/selection to have
  // drifted by the time it's submitted. switchTo controls focusDestination
  // directly: checked means behave like jumpToTab (follow the tab to its
  // new window); unchecked means behave like moveSelectedTabsToWorkspace
  // (stay put, same as the external-hotkey move).
  async function moveTabForRuleDialog(tabId, workspaceId, workspaceName, switchTo) {
    try {
      const tab = await getTab(tabId);
      if (!tab) return { ok: false, reason: "TAB_GONE" };
      return await moveTabsToWorkspace([tab], tab.windowId, workspaceId, workspaceName, { focusDestination: switchTo });
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  // Shows on the SOURCE window (see moveSelectedTabsToWorkspace's own
  // comment on why focus stays there) -- interactive, unlike the other
  // informational variants: there's a real destination to jump to, the user
  // just isn't looking at it yet. Click (or jumpToLastMovedTabs via the
  // relay) focuses it.
  function showMovedTabsToast(result) {
    chrome.runtime.sendMessage({
      type: "vwh-show-toast",
      variant: "moved-tabs",
      displayWindowId: result.sourceWindowId,
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
      workspaceEmoji: result.workspaceEmoji,
      tabCount: result.tabCount,
    });
  }

  // Brings the destination of the most recent moveSelectedTabsToWorkspace
  // call to the front. Unlike jumpToTab there's never anything left to move
  // -- the tabs already landed there synchronously as part of the move
  // itself -- so this only ever needs to focus a window. Re-derives it fresh
  // via findWindowDisplayingWorkspace rather than trusting a stored window
  // id, same reasoning as jumpToTab: the window could have been closed (or
  // the workspace reassigned elsewhere) since the move happened.
  async function focusWorkspaceWindow(workspaceId) {
    try {
      const targetWindowId = findWindowDisplayingWorkspace(workspaceId);
      if (targetWindowId == null) return { ok: false, reason: "TARGET_WINDOW_GONE" };
      await chrome.windows.update(targetWindowId, { focused: true });
      return { ok: true, windowId: targetWindowId };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  async function jumpToLastMovedTabs() {
    if (!lastMovedTabs) return { ok: false, reason: "NO_RECENT_MOVE" };
    return focusWorkspaceWindow(lastMovedTabs.workspaceId);
  }

  // ---------- add-a-routing-rule dialog (Feature 5) ----------
  //
  // Lets a rule be added for the current tab's domain without ever opening
  // Settings -> Workspace Rules. Two trigger paths, both funneling into
  // showAddRuleDialog below: a page context-menu item (click, contexts:
  // ["all"] -- see createContextMenuItem's own comment for why not "page"),
  // and a relay endpoint for an external hotkey (keystroke) -- see
  // connectRelay's "openAddRuleDialog" handler and init()'s contextMenus
  // setup. The dialog
  // itself is rendered by window-toast.js (this document has no viewport);
  // its submission comes back here as a "vwh-add-rule-request" message (see
  // the runtime.onMessage listener in init()).
  function getWorkspaceListForDialog() {
    if (!workspaceStore) return [];
    return workspaceStore.getWorkspaces().map((w) => ({ id: w.id, name: w.name, emoji: w.emoji }));
  }

  // Strips a leading "www." from the domain used to pre-fill the rule's
  // expression -- per Aaron's request (2026-08-25): a CONTAINS rule for
  // "example.com" also matches "www.example.com", but not the reverse, so
  // defaulting to the bare domain makes the rule work regardless of
  // whether the site is later reached with or without that prefix. Scoped
  // to just this dialog's pre-fill, not getDomain itself -- the toast's own
  // display use of getDomain is purely informational, not a matching
  // expression, so it has no reason to share this.
  function stripWwwPrefix(domain) {
    return domain.replace(/^www\./i, "");
  }

  function showAddRuleDialog(windowId, tab) {
    chrome.runtime.sendMessage({
      type: "vwh-show-add-rule-dialog",
      displayWindowId: windowId,
      domain: stripWwwPrefix(getDomain(tab.url)),
      workspaces: getWorkspaceListForDialog(),
      tabId: tab.id,
    });
  }

  // Only ever called with type "CONTAINS" today (the dialog doesn't expose
  // STARTSWITH/EQUALS) -- kept as a parameter rather than hardcoded since
  // linkRoutesController.findMatch already supports all three and a future
  // dialog revision may want to expose the choice.
  async function addWorkspaceRule(type, expression, workspaceId) {
    if (!linkRoutesController) return { ok: false, reason: "CONTROLLER_UNAVAILABLE" };
    if (!expression) return { ok: false, reason: "EMPTY_EXPRESSION" };
    try {
      const id = await linkRoutesController.addLinkRoutingRule(type, expression, workspaceId);
      return { ok: true, id };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  // chrome.contextMenus isn't necessarily available yet the instant init()
  // runs -- confirmed live (2026-08-24): waitForReady only gates on
  // chrome.tabs and window.webpackChunkgapp_browser_react, and
  // chrome.contextMenus can still lag behind those by the time this code
  // runs. Worse, confirmed live via a tight external poll (2026-08-24):
  // even once create() succeeds with no lastError, the item can still get
  // silently wiped moments later (observed: present ~1.5s after Vivaldi
  // launch, gone by ~1.8s, never coming back on its own) -- some part of
  // Vivaldi's own startup sequence clears extension-registered context menu
  // items shortly after this script runs, a one-time event rather than an
  // ongoing block (nothing re-wipes it once re-created after that window
  // has passed). CONTEXT_MENU_RETRY_DELAYS_MS re-creates on a schedule
  // chosen to comfortably straddle that observed ~300ms wipe window, then
  // gives up -- registerContextMenuListener (added exactly once, separate
  // from the item itself) keeps working across every recreation.
  let contextMenuListenerAdded = false;
  const CONTEXT_MENU_ID = "vwh-add-rule";
  // Leading "+" (ASCII 0x2B, sorts before digits and letters -- chosen
  // over "!" per Aaron's request for something less alarm-looking, still
  // low enough to sort first, and thematically fitting since the action
  // creates something new) pushes this item to the top of the extensions
  // section of the menu -- confirmed live (2026-08-25) that same-section
  // extension menu items are ordered alphabetically by title, not by
  // extension id or install order: with the plain title "Route this
  // site...", it landed exactly where alphabetical order predicts (between
  // "Rich URL" and "Save Page to Reader"), per Aaron's screenshot. A
  // fancier prefix like "🔀" was considered and rejected -- its Unicode
  // code point is far higher than any Latin letter, so it would sort to
  // the *bottom* of the extensions group instead, undoing this fix. There's
  // no way to place the item *before* the separator alongside Vivaldi's
  // own native items (e.g. "Copy Page Address") either -- that boundary
  // between native and extension-added items is drawn by the browser
  // itself and isn't something the contextMenus API can override. A
  // per-item custom icon isn't achievable at all -- create() rejects an
  // `icons` property outright ("Unexpected property: 'icons'") in this
  // Vivaldi build, confirmed live the same session.
  // "Create workspace rule" (not "Route to workspace") matches Vivaldi's
  // own Settings terminology ("Workspace Rules") -- adopted throughout
  // this feature's user-facing text per Aaron's request.
  const CONTEXT_MENU_TITLE = "+ Create workspace rule for this site…";
  const CONTEXT_MENU_RETRY_DELAYS_MS = [300, 800, 1500, 3000, 6000];

  function createContextMenuItem() {
    // "all" (not "page") -- confirmed live (2026-08-25) that right-clicking
    // directly on text puts Chrome into a "selection" context, which a
    // "page"-only item does not appear in. Most of a real page IS text, so
    // "page"-only meant the item was effectively hidden for the common case
    // of right-clicking near/on content -- only a genuinely blank-background
    // right-click ever showed it. "all" covers selection/link/image/etc. too.
    chrome.contextMenus.create(
      { id: CONTEXT_MENU_ID, title: CONTEXT_MENU_TITLE, contexts: ["all"] },
      () => {
        // "duplicate id" just means a previous attempt's item is still
        // there -- not an error worth logging.
        const err = chrome.runtime.lastError;
        if (err && !/duplicate id/i.test(err.message)) console.warn(TAG, "contextMenus.create:", err.message);
      }
    );
  }

  // Re-verifies the item exists and recreates it if not -- shared by the
  // bounded startup retries and the post-click recheck below, both of
  // which just want "make sure it's actually there right now" without
  // caring which of the (possibly several) wipe triggers caused it to go
  // missing.
  function ensureContextMenuItem() {
    chrome.contextMenus.update(CONTEXT_MENU_ID, {}, () => {
      if (chrome.runtime.lastError) createContextMenuItem();
    });
  }

  function registerContextMenuListener() {
    if (contextMenuListenerAdded) return;
    contextMenuListenerAdded = true;
    // Doesn't use the `tab` argument onClicked is documented to pass --
    // confirmed live (2026-08-25) that it comes through as undefined for a
    // real click in this context (menuItemId/info are fine; only the
    // second argument is missing), silently dropping every click under the
    // old `tab &&` guard. Falls back to the exact same focused-window/
    // active-tab resolution the relay path already uses successfully.
    chrome.contextMenus.onClicked.addListener((info) => {
      if (info.menuItemId !== CONTEXT_MENU_ID) return;
      openAddRuleDialogForFocusedWindow();
      // Confirmed live (2026-08-25, reported by Aaron): the item can go
      // missing after being used once -- re-verify shortly after every
      // click in case USE itself is the wipe trigger. This only ever fires
      // on an actual click of this specific item (onClicked doesn't fire
      // for ordinary page clicks at all), so it's cheap and rare by
      // construction -- deliberately not paired with an always-on
      // periodic timer, since there's no evidence yet of a wipe that
      // happens independent of a click to justify that ongoing cost.
      setTimeout(ensureContextMenuItem, 500);
    });
  }

  function verifyContextMenuItem(retryIndex) {
    chrome.contextMenus.update(CONTEXT_MENU_ID, {}, () => {
      if (!chrome.runtime.lastError) return; // still there, nothing to do
      if (retryIndex >= CONTEXT_MENU_RETRY_DELAYS_MS.length) return; // out of retries -- the post-click recheck is what's left to catch a later wipe
      setTimeout(() => {
        createContextMenuItem();
        verifyContextMenuItem(retryIndex + 1);
      }, CONTEXT_MENU_RETRY_DELAYS_MS[retryIndex]);
    });
  }

  function registerContextMenu(pollAttempt) {
    pollAttempt = pollAttempt || 0;
    if (typeof chrome === "undefined" || !chrome.contextMenus) {
      if (pollAttempt > 50) {
        console.error(TAG, "chrome.contextMenus never became available -- add-rule context menu item unavailable.");
        return;
      }
      setTimeout(() => registerContextMenu(pollAttempt + 1), 100);
      return;
    }
    registerContextMenuListener();
    createContextMenuItem();
    setTimeout(() => verifyContextMenuItem(0), CONTEXT_MENU_RETRY_DELAYS_MS[0]);
  }

  // Relay path (external hotkey): shows the dialog for whichever tab is
  // active in the currently focused window, same "what am I looking at right
  // now" semantics as jumpToLastRoutedTab/moveSelectedTabsToWorkspace.
  async function openAddRuleDialogForFocusedWindow() {
    const win = await new Promise((resolve) => chrome.windows.getLastFocused({ populate: true }, resolve));
    if (!win) return { ok: false, reason: "NO_FOCUSED_WINDOW" };
    const activeTab = (win.tabs || []).find((t) => t.active);
    if (!activeTab) return { ok: false, reason: "NO_ACTIVE_TAB" };
    showAddRuleDialog(win.id, activeTab);
    return { ok: true };
  }

  function requestActivateWorkspace(workspaceName) {
    return new Promise((resolve) => {
      if (!relaySocket || relaySocket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, reason: "RELAY_NOT_CONNECTED" });
        return;
      }
      const requestId = "act-" + nextRelayRequestId++;
      const timer = setTimeout(() => {
        pendingRelayRequests.delete(requestId);
        resolve({ ok: false, reason: "TIMEOUT" });
      }, RELAY_REQUEST_TIMEOUT_MS);
      pendingRelayRequests.set(requestId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      relaySocket.send(JSON.stringify({ type: "activateWorkspace", requestId, workspaceName }));
    });
  }

  // ---------- relay link (external hotkey -> jumpToLastRoutedTab /
  // moveSelectedTabsToWorkspace / jumpToLastMovedTabs / openAddRuleDialog /
  // jumpToWorkspace; also used in the other direction for
  // requestActivateWorkspace above) ----------
  function connectRelay() {
    let socket;
    try {
      socket = new WebSocket("ws://127.0.0.1:" + RELAY_PORT + "/bridge");
    } catch (e) {
      scheduleRelayRetry();
      return;
    }
    relaySocket = socket;
    socket.addEventListener("open", () => {
      console.log(TAG, "Connected to relay on port", RELAY_PORT);
      relayRetryDelay = 1000;
      sendRelayHello(socket);
    });
    socket.addEventListener("message", async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (!msg) return;
      if (msg.type === "jumpLastRouted") {
        const result = await jumpToLastRoutedTab();
        socket.send(JSON.stringify(Object.assign({ requestId: msg.requestId }, result)));
        return;
      }
      if (msg.type === "moveSelectedTabsToWorkspace") {
        const result = await moveSelectedTabsToWorkspace(msg.workspaceName);
        if (result.ok) showMovedTabsToast(result);
        socket.send(JSON.stringify(Object.assign({ requestId: msg.requestId }, result)));
        return;
      }
      if (msg.type === "jumpLastMovedTabs") {
        const result = await jumpToLastMovedTabs();
        socket.send(JSON.stringify(Object.assign({ requestId: msg.requestId }, result)));
        return;
      }
      if (msg.type === "openAddRuleDialog") {
        const result = await openAddRuleDialogForFocusedWindow();
        socket.send(JSON.stringify(Object.assign({ requestId: msg.requestId }, result)));
        return;
      }
      if (msg.type === "jumpToWorkspace") {
        const result = await jumpToWorkspace(msg.workspaceName);
        socket.send(JSON.stringify(Object.assign({ requestId: msg.requestId }, result)));
        return;
      }
      if (msg.requestId != null && pendingRelayRequests.has(msg.requestId)) {
        const resolve = pendingRelayRequests.get(msg.requestId);
        pendingRelayRequests.delete(msg.requestId);
        resolve(msg);
      }
    });
    socket.addEventListener("close", scheduleRelayRetry);
    socket.addEventListener("error", () => {
      /* "close" fires right after and drives the retry */
    });
  }

  // Tells the relay which copy of this script it's talking to. Opening a
  // private window makes Vivaldi load a second main.html (with this script)
  // for the incognito profile, confirmed live 2026-10-17. That copy only
  // sees private windows. The relay logs this hello and uses
  // incognito/startedAt to route HTTP requests to the regular copy (see
  // pickBrowserSocket in relay/server.js).
  function sendRelayHello(socket) {
    chrome.windows.getAll({}, (wins) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: "hello",
          incognito: !!(chrome.extension && chrome.extension.inIncognitoContext),
          startedAt: Math.round(performance.timeOrigin),
          href: location.href,
          windows: (wins || []).map((w) => ({ incognito: w.incognito, type: w.type })),
        })
      );
    });
  }

  function scheduleRelayRetry() {
    relaySocket = null;
    setTimeout(connectRelay, relayRetryDelay);
    relayRetryDelay = Math.min(relayRetryDelay * 2, 30000);
  }

  // ---------- init ----------
  async function init() {
    let req;
    try {
      req = await harvestWebpackRequire();
    } catch (e) {
      console.error(TAG, "Webpack harvest failed:", e);
      return;
    }
    if (!resolveWorkspaceStore(req)) {
      console.error(TAG, "Workspace store module resolution failed.");
      window.__vwh_req = req; // expose for manual inspection
      return;
    }
    // Non-fatal if this one fails -- the rest of the feature set (jump,
    // move-to-workspace) doesn't depend on it. Only the add-rule dialog does
    // (addWorkspaceRule checks linkRoutesController itself and reports
    // CONTROLLER_UNAVAILABLE rather than throwing).
    if (!resolveLinkRoutesController(req)) {
      console.error(TAG, "Link-routes controller module resolution failed -- add-rule dialog will be unavailable.");
    }

    registerContextMenu();

    chrome.tabs.onCreated.addListener((tab) => {
      // Independent of everything below -- runs for every new tab
      // regardless of the recreated-tab marker (that marker exists to avoid
      // *background-routing* misdetection specifically, not relevant here).
      redirectNewTabIfConfigured(tab).catch((e) => console.warn(TAG, "redirectNewTabIfConfigured failed:", e));

      // Our own recreateTabInWindow (jumpToTab, moveTabsToWorkspace) landing
      // a tab it created itself -- not a real external/background route. See
      // windowsReceivingOwnRecreatedTabs's own comment for the bug this
      // avoids re-triggering.
      if (windowsReceivingOwnRecreatedTabs.has(tab.windowId)) return;
      tabOriginalActiveState.set(tab.id, tab.active);
      setTimeout(() => tabOriginalActiveState.delete(tab.id), 15000);

      if (tab.active) {
        // Candidate for the in-place foreground-reassignment case -- see
        // onWorkspaceStoreChanged. Expires on its own; only meant to
        // correlate with a store change landing within a few seconds.
        recentActiveTabWindows.set(tab.windowId, tab.id);
        setTimeout(() => {
          if (recentActiveTabWindows.get(tab.windowId) === tab.id) recentActiveTabWindows.delete(tab.windowId);
        }, FOREGROUND_TAB_CORRELATION_MS);
      }
      checkIfBackgroundThenHandle(tab.windowId, (cb) => cb(tab));
    });
    // A workspace rule often doesn't create the tab directly in the
    // destination window: e.g. cmd+click opens it as a background tab in
    // the *current* window first (onCreated sees it as same-window, so the
    // check above correctly no-ops), and Vivaldi's rule engine then moves
    // it into the destination workspace's window a moment later. A
    // cross-window move fires onAttached, not another onCreated -- so this
    // is the actual signal for that case. (A URL opened from another app,
    // or pasted into the address bar, may create the tab directly in the
    // destination window in one step, which onCreated alone already
    // catches -- onAttached is what covers the two-step case.)
    chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
      checkIfBackgroundThenHandle(attachInfo.newWindowId, (cb) => {
        chrome.tabs.get(tabId, (tab) => cb(chrome.runtime.lastError ? null : tab));
      });
    });
    // Covers the "no window exists for the target workspace at all" case --
    // see checkWorkspaceTagThenHandle's comment.
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!changeInfo.vivExtData) return;
      checkWorkspaceTagThenHandle(tab);
    });
    // window-toast.js (running in window.html, the only place with a
    // viewport) sends this on a toast click, naming the specific tab it
    // pointed at. (There used to be a second message type here,
    // "vwh-jump-last-routed", sent by an in-page ⌥⌘J keydown listener in
    // window-toast.js -- removed 2026-08-09. It only ever worked while
    // keyboard focus happened to be on Vivaldi's own chrome, never while a
    // webview had focus, and that coverage is now a strict subset of what
    // the relay's own jumpLastRouted already provides from anywhere,
    // regardless of focus -- see connectRelay's message handler above and
    // CLAUDE.md's "Triggering a jump from outside Vivaldi" section. Keeping
    // both around meant a real risk, not just redundancy: bind the same
    // key in an external tool and the two paths could both fire for one
    // keypress, and if the target workspace was windowless, two
    // near-simultaneous jumpToLastRoutedTab() calls could race and create
    // two windows for it.)
    chrome.runtime.onMessage.addListener((message) => {
      if (!message) return;
      // Nothing round-trips either result back to window.html (the toast,
      // if any, already dismissed itself by the time this runs) -- log
      // failures so they're at least visible in this console instead of
      // just looking like "nothing happened" with no trace at all.
      if (message.type === "vwh-jump-request") {
        jumpToTab(message.tabId, message.workspaceId, message.workspaceName).then((result) => {
          if (!result.ok) console.error(TAG, "jumpToTab failed:", result.reason, message);
        });
      }
      // Sent by window-toast.js on a "moved-tabs" toast click -- see
      // showMovedTabsToast above for why that toast is interactive.
      if (message.type === "vwh-focus-workspace-request") {
        focusWorkspaceWindow(message.workspaceId).then((result) => {
          if (!result.ok) console.error(TAG, "focusWorkspaceWindow failed:", result.reason, message);
        });
      }
      // Sent by window-toast.js's add-rule dialog on submit (see
      // showAddRuleDialog above). Echoes back displayWindowId/workspaceName/
      // workspaceEmoji purely for the confirmation toast below -- the actual
      // rule creation only needs ruleType/expression/workspaceId.
      // moveNow/switchTo/tabId drive the dialog's "move this tab now" and
      // "...and switch to that workspace" checkboxes -- the rule is always
      // added regardless of those; the move is additional behavior on top.
      if (message.type === "vwh-add-rule-request") {
        (async () => {
          const result = await addWorkspaceRule(message.ruleType || "CONTAINS", message.expression, message.workspaceId);
          if (!result.ok) {
            console.error(TAG, "addWorkspaceRule failed:", result.reason, message);
            return;
          }
          let moveResult = null;
          if (message.moveNow && message.tabId != null) {
            moveResult = await moveTabForRuleDialog(message.tabId, message.workspaceId, message.workspaceName, !!message.switchTo);
            if (!moveResult.ok) console.error(TAG, "moveTabForRuleDialog failed:", moveResult.reason, message);
          }
          const moved = !!(moveResult && moveResult.ok);
          const switched = moved && !!message.switchTo;
          // If the move switched to the destination, that window is what's
          // now on screen -- show the confirmation there (mirrors
          // showJumpedToast's use of result.windowId over the original
          // window), not on the source window the dialog was opened from.
          const toastWindowId = switched ? moveResult.windowId : message.displayWindowId;
          chrome.runtime.sendMessage({
            type: "vwh-show-toast",
            variant: "rule-added",
            displayWindowId: toastWindowId,
            workspaceId: message.workspaceId,
            workspaceName: message.workspaceName,
            workspaceEmoji: message.workspaceEmoji,
            domain: message.expression,
            moved,
            switched,
          });
        })();
      }
    });

    refreshFocusedWorkspaceBaseline();
    workspaceStore.addListener(onWorkspaceStoreChanged);

    connectRelay();

    window.__vwh = {
      req,
      workspaceStore,
      jumpToLastRoutedTab,
      get lastRoutedTab() {
        return lastRoutedTab;
      },
      jumpToLastMovedTabs,
      get lastMovedTabs() {
        return lastMovedTabs;
      },
      linkRoutesController,
      addWorkspaceRule,
      openAddRuleDialogForFocusedWindow,
      jumpToWorkspace,
      NEW_TAB_OVERRIDES,
      injectFocusSelector,
    };
    console.log(TAG, "Ready");
  }

  function waitForReady() {
    if (typeof chrome !== "undefined" && chrome.tabs && window.webpackChunkgapp_browser_react) {
      init();
    } else {
      setTimeout(waitForReady, 100);
    }
  }
  waitForReady();
})();
