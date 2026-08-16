// Vivaldi Workspace Helper -- in-window toast (VWH-toast)
//
// Loaded from window.html (Vivaldi's visible *per-window* browser chrome
// document) -- NOT main.html, which is the invisible host where the actual
// detection logic in workspace-route-watcher.js runs and has no viewport of
// its own to draw into. That script broadcasts a "vwh-show-toast" runtime
// message to every open window; only the instance of this script whose own
// window id matches displayWindowId actually shows anything.
//
// Injected via injected/install.sh, alongside workspace-route-watcher.js.
//
// Debugging: vivaldi://inspect/#apps -> the window's own entry -> inspect.
// Watch for [VWH-toast]-prefixed console lines.

(function () {
  const TAG = "[VWH-toast]";
  // "route" is the only variant you have to actually read and act on before
  // it goes away, so it gets the long duration. Every other variant is
  // purely informational -- it's telling you about something that already
  // happened, not asking you to do anything -- so it doesn't need to
  // linger; shortened per Aaron's feedback (2026-08-14), especially since
  // "foreground-switch" fires even for the user's own manual Ctrl+<N>
  // workspace switch (see onWorkspaceStoreChanged's correlation heuristic,
  // which can't fully distinguish that from a routed tab's in-place
  // reassignment), where an 8s lingering toast for your own deliberate
  // action was actively annoying.
  const TOAST_DURATION_MS = 8000;
  const INFORMATIONAL_TOAST_DURATION_MS = 2500;
  // Background opacity, 0 (fully see-through) to 1 (fully solid). Text stays
  // solid either way -- this only affects how much of the page behind shows
  // through the toast's background.
  const TOAST_OPACITY = 0.6;
  const FALLBACK_EMOJI = "❓"; // used only if the workspace's own emoji can't be resolved ( ❓ )

  let myWindowId = null;
  let toastEl = null;
  let dismissTimer = null;
  // { kind: "route", tabId, workspaceId, workspaceName } for a routed tab
  // still sitting wherever it landed, or { kind: "moved-tabs", workspaceId,
  // workspaceName } for tabs moveSelectedTabsToWorkspace already moved --
  // the two need different follow-up messages (see jumpToActiveTarget).
  let activeTarget = null;

  function jumpToActiveTarget() {
    if (!activeTarget) return;
    if (activeTarget.kind === "moved-tabs") {
      // The tab(s) already landed at their destination -- nothing left to
      // move, just bring that window to the front.
      chrome.runtime.sendMessage({
        type: "vwh-focus-workspace-request",
        workspaceId: activeTarget.workspaceId,
        workspaceName: activeTarget.workspaceName,
      });
    } else {
      chrome.runtime.sendMessage({
        type: "vwh-jump-request",
        tabId: activeTarget.tabId,
        workspaceId: activeTarget.workspaceId,
        workspaceName: activeTarget.workspaceName,
      });
    }
    dismissToast();
  }

  // Positioning against the window as a whole (e.g. a fixed top:16px) can
  // land the toast partly underneath Vivaldi's own toolbar/tab-strip chrome
  // -- confirmed live: the web content viewport (.webpageview/webview) can
  // start well below the window's own top edge (e.g. y:54 with a visible
  // tab strip), and whatever chrome occupies that gap sits in front of a
  // window-relative toast, silently eating clicks meant for it (only the
  // portion of the toast actually over the content viewport was
  // clickable). Anchoring to the content viewport's own rect instead --
  // matching what was actually asked for, "upper right of the web content
  // viewport" -- fixes this regardless of tab-strip/panel configuration.
  // Falls back to the window's own top-right if no viewport is found.
  function getContentViewportRect() {
    const views = document.querySelectorAll(".webpageview, webview");
    for (const el of views) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    return { top: 0, right: window.innerWidth };
  }

  function dismissToast() {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    if (toastEl) {
      toastEl.remove();
      toastEl = null;
    }
    activeTarget = null;
  }

  function showToast(message) {
    dismissToast(); // replace anything already showing

    // "route" (default, undefined variant) and "moved-tabs" are the
    // interactive ones -- each has a real destination window to jump to.
    // "foreground-switch" (Vivaldi reassigned the *current* window's own
    // workspace in place -- see workspace-route-watcher.js's
    // onWorkspaceStoreChanged), "raised-window" (an existing window already
    // displaying the target workspace was focused automatically), and
    // "created-window" (no window displayed the target workspace, so one
    // was created and assigned automatically) -- see handleBackgroundTab's
    // active-tab branch for all three -- are purely informational: whatever
    // they're telling you about already happened, so clicking just
    // dismisses instead of jumping. "moved-tabs" is different from those
    // three: moveSelectedTabsToWorkspace deliberately leaves focus on the
    // *source* window (see its own comment) rather than following the
    // tab(s) to their destination, so unlike the others there's still
    // somewhere real to jump to when this toast is clicked.
    const variant = message.variant || "route";
    const interactive = variant === "route" || variant === "moved-tabs";
    if (interactive) {
      activeTarget =
        variant === "moved-tabs"
          ? { kind: "moved-tabs", workspaceId: message.workspaceId, workspaceName: message.workspaceName }
          : { kind: "route", tabId: message.targetTabId, workspaceId: message.workspaceId, workspaceName: message.workspaceName };
    }

    const viewport = getContentViewportRect();
    const top = Math.round(viewport.top) + 8;
    const right = Math.round(window.innerWidth - viewport.right) + 8;

    const el = document.createElement("div");
    el.id = "vwh-toast";
    el.style.cssText = [
      "position: fixed",
      `top: ${top}px`,
      `right: ${right}px`,
      "z-index: 2147483647",
      `background: rgba(32, 32, 36, ${TOAST_OPACITY})`,
      "color: #fff",
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "font-size: 13px",
      "line-height: 1.45",
      "padding: 12px 16px",
      "border-radius: 10px",
      "box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35)",
      "cursor: pointer",
      "max-width: 320px",
      "white-space: pre-line",
      "user-select: none",
    ].join(";");
    const workspaceLabel = message.workspaceName || "(unknown workspace)";
    const emoji = message.workspaceEmoji || FALLBACK_EMOJI;
    if (variant === "foreground-switch") {
      el.textContent = `Vivaldi changed window to ${emoji} ${workspaceLabel}`;
    } else if (variant === "raised-window") {
      el.textContent = `Raised window with ${emoji} ${workspaceLabel}`;
    } else if (variant === "created-window") {
      el.textContent = `Created window for ${emoji} ${workspaceLabel}`;
    } else if (variant === "moved-tabs") {
      const n = message.tabCount || 1;
      el.textContent = `Moved ${n} tab${n === 1 ? "" : "s"} to ${emoji} ${workspaceLabel}\n\nClick to switch`;
    } else {
      el.textContent = `${message.domain} tab opened in ${emoji} ${workspaceLabel}\n\nClick to switch`;
    }

    if (interactive) {
      el.addEventListener("click", jumpToActiveTarget);
    } else {
      el.addEventListener("click", dismissToast);
    }

    document.body.appendChild(el);
    toastEl = el;

    dismissTimer = setTimeout(dismissToast, interactive ? TOAST_DURATION_MS : INFORMATIONAL_TOAST_DURATION_MS);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "vwh-show-toast") return;
    if (myWindowId == null || message.displayWindowId !== myWindowId) return;
    console.log(TAG, "Showing toast:", message);
    showToast(message);
  });

  function init() {
    chrome.windows.getCurrent({}, (win) => {
      if (win) myWindowId = win.id;
      console.log(TAG, "Ready in window", myWindowId);
    });
  }

  function waitForReady() {
    if (typeof chrome !== "undefined" && chrome.windows && chrome.runtime && document.body) {
      init();
    } else {
      setTimeout(waitForReady, 100);
    }
  }
  waitForReady();
})();
