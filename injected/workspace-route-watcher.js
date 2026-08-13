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
  const RELAY_PORT = 8877; // must match relay/server.js's PORT
  // Extra settle time before deciding a tab is "background", so a
  // brand-new window's own onFocusChanged (which can lag its onCreated
  // event) has time to land before we compare against stale focus state.
  const BACKGROUND_CHECK_DELAY_MS = 200;
  const RELAY_REQUEST_TIMEOUT_MS = 5000;

  let workspaceStore = null;
  let lastRoutedTab = null;
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
  // Mirrors bridge/workspace-jump.js's own two-branch decision exactly:
  // if the workspace already has a window, focus *that* one; if not, create
  // a brand-new blank window and assign it, rather than force-switching
  // some unrelated existing window away from whatever it's currently
  // showing (the exact silent-reassignment problem this whole project
  // exists to avoid -- see the planning doc's "Rejected approach" section).
  // The routed tab is then moved into whichever window that resolves to.
  async function jumpToTab(tabId, workspaceId, workspaceName) {
    try {
      let targetWindowId = findWindowDisplayingWorkspace(workspaceId);
      let created = false;

      if (targetWindowId != null) {
        await chrome.windows.update(targetWindowId, { focused: true });
      } else if (workspaceName) {
        const newWin = await new Promise((resolve) => chrome.windows.create({}, resolve));
        targetWindowId = newWin.id;
        created = true;
        windowsCreatedByJumpToTab.add(targetWindowId);
        setTimeout(() => windowsCreatedByJumpToTab.delete(targetWindowId), 10000);
        // No extra focus call needed here -- a freshly created window is
        // already the focused one, and activateWorkspaceViaMenu's own
        // "tell application Vivaldi to activate" acts on it directly, same
        // as bridge/workspace-jump.js's own ASSIGNED branch.
        const activated = await requestActivateWorkspace(workspaceName);
        if (!activated.ok) {
          return { ok: false, reason: "ACTIVATE_FAILED: " + activated.reason };
        }
      } else {
        const tab = await getTab(tabId);
        targetWindowId = tab ? tab.windowId : null;
      }

      if (targetWindowId == null) return { ok: false, reason: "NO_TARGET_WINDOW" };

      const currentTab = await getTab(tabId);
      if (currentTab && currentTab.windowId !== targetWindowId) {
        await new Promise((resolve) => chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 }, resolve));
      }
      await chrome.tabs.update(tabId, { active: true });

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

  // ---------- relay link (external hotkey -> jumpToLastRoutedTab; also used
  // in the other direction for requestActivateWorkspace above) ----------
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

    chrome.tabs.onCreated.addListener((tab) => {
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
