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
  let ruleDialogEl = null;
  let ruleDialogBackdropEl = null;
  // { kind: "route", tabId, workspaceId, workspaceName } for a routed tab
  // still sitting wherever it landed, or { kind: "moved-tabs", workspaceId,
  // workspaceName } for tabs moveSelectedTabsToWorkspace already moved --
  // the two need different follow-up messages (see jumpToActiveTarget).
  let activeTarget = null;
  let toastKeydownHandler = null;

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
    if (toastKeydownHandler) {
      document.removeEventListener("keydown", toastKeydownHandler);
      toastKeydownHandler = null;
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
    // "rule-added" is also interactive, but only when the add-rule dialog's
    // "move this tab now" moved the tab without also switching to it (see
    // showAddRuleDialog's checkboxes in the dialog code below) -- same
    // reasoning as "moved-tabs": there's still somewhere real to jump to.
    // When switchTo was also checked, the destination is already on screen
    // by the time this toast shows, so it's purely informational instead.
    const ruleAddedWithUnswitchedMove = variant === "rule-added" && message.moved && !message.switched;
    const interactive = variant === "route" || variant === "moved-tabs" || ruleAddedWithUnswitchedMove;
    if (interactive) {
      activeTarget =
        variant === "route"
          ? { kind: "route", tabId: message.targetTabId, workspaceId: message.workspaceId, workspaceName: message.workspaceName }
          : { kind: "moved-tabs", workspaceId: message.workspaceId, workspaceName: message.workspaceName };
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
      el.textContent = `Moved ${n} tab${n === 1 ? "" : "s"} to ${emoji} ${workspaceLabel}\n\nClick or press Tab to switch`;
    } else if (variant === "rule-added") {
      let text = `Rule created: ${message.domain} → ${emoji} ${workspaceLabel}`;
      if (message.moved) text += message.switched ? "\nTab moved" : "\n\nTab moved — click to switch";
      el.textContent = text;
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

    // Keyboard shortcut for this toast -- scoped to "moved-tabs" only, not
    // every interactive variant. "route" fires for genuinely background
    // routes (cmd+click, or an external open landing in a windowless
    // workspace) that can happen while Aaron is doing something completely
    // unrelated in another tab -- stealing keyboard focus there would be
    // exactly the kind of surprise this project exists to avoid (see
    // CLAUDE.md's "notify before touching the screen" spirit, applied here
    // to an unsolicited focus steal instead of an explicit action). A
    // "moved-tabs" toast, by contrast, only ever appears as the direct
    // result of Aaron's own explicit move-to-workspace hotkey, so focus is
    // already in a deliberate, expected place.
    //
    // The mechanism reuses the add-rule dialog's own discovery (2026-08-25,
    // see showAddRuleDialog below): giving an element tabIndex=-1 and
    // calling .focus() on it pulls keyboard focus into this window.html
    // document even when it was previously on the page content rendered
    // inside <webview> (a separate process whose focus is otherwise
    // invisible to this document entirely). That dialog testing confirmed
    // plain letter keys reach a document-level keydown listener once focus
    // is forced this way, while Escape/Enter/Space/arrows still never do
    // (Vivaldi's own chrome intercepts those first).
    //
    // Tab is the only binding here (2026-08-26) -- an earlier version also
    // bound ⌥⌘J (the same combo the old, removed in-page shortcut used) and
    // confirmed live that it does reach this listener once focus is forced
    // this way, disproving the old assumption that modifier combos were
    // specially blocked (see the project_keyboard_delivery_in_injected_ui
    // memory for that correction). Removed anyway per Aaron's request: Tab
    // alone already covers the need, and a fixed global combo risks
    // colliding with shortcuts other people already have bound to ⌥⌘J.
    if (variant === "moved-tabs") {
      el.tabIndex = -1;
      el.focus();
      toastKeydownHandler = (e) => {
        if (e.key !== "Tab") return;
        e.preventDefault();
        jumpToActiveTarget();
      };
      document.addEventListener("keydown", toastKeydownHandler);
    }

    dismissTimer = setTimeout(dismissToast, interactive ? TOAST_DURATION_MS : INFORMATIONAL_TOAST_DURATION_MS);
  }

  // ---------- add-rule dialog (Feature 5) ----------
  //
  // Broadcast by workspace-route-watcher.js's showAddRuleDialog, same
  // displayWindowId-gated pattern as the toast above. Centered on the
  // window (unlike the toast's top-right-of-viewport anchor) -- top-right
  // is also where macOS notifications land, and they partly covered this
  // dialog there per Aaron's feedback (2026-08-25). A full-viewport
  // transparent backdrop provides click-outside-to-dismiss without needing
  // a real modal API.
  //
  // KEYBOARD NAVIGATION -- j/k/u/w/m/o/c/s, not arrows/Enter/Escape
  // ---------------------------------------------------------
  // Confirmed live (2026-08-25) via a diagnostic keydown listener: Vivaldi
  // never delivers Escape, Enter, Space, or the arrow keys to this
  // document's JS at all (a capture-phase document-level listener never
  // fires for them, regardless of what has focus) -- almost certainly
  // because Vivaldi's own chrome always checks those keys first for its own
  // purposes (e.g. omnibox-suggestion navigation) before any page script
  // could see them, the same class of limitation that already killed the
  // in-page ⌥⌘J toast shortcut (see the Second feature section). Ordinary
  // letter keys, though, were confirmed to reach this document's keydown
  // listener reliably even with nothing focused -- so the actual keyboard
  // scheme uses letters instead: j/k move the highlighted workspace
  // down/up (wrapping), u focuses the domain field for editing (the label
  // above it originally read "(E)dit", but Aaron asked it be relabeled
  // "(U)RL for rule:" -- the key followed the label), w returns to the
  // workspace list and selects its first entry, m toggles "move this tab
  // now", o toggles "...and open that workspace" (originally labeled
  // "(S)witch", renamed to free up "s" once Aaron asked for a Cancel/Save
  // row -- see below), s accepts/submits the highlighted workspace (the
  // visibly-labeled "(S)ave new Rule" action; an earlier "a" binding for
  // the same thing was removed once "s" existed -- Aaron asked for one
  // shortcut here, not two), c cancels (same as clicking outside). Each
  // letter is hinted inline via a "(X)" prefix on its own associated
  // label/checkbox/button text; j/k aren't tied to any single label, so
  // those get a small inline hint next to the "(W)orkspace:" header
  // instead. The domain input's own left/right-arrow cursor movement while
  // typing still works fine despite arrows being undeliverable here --
  // that's the browser's native text-field editing, handled below the JS
  // event layer entirely, not something a page keydown listener needs to
  // implement.
  //
  // Letter keys only act as commands while the domain input does NOT have
  // focus (checked per-key below) -- otherwise typing a domain containing
  // one of these letters (i.e. nearly any real domain) would get eaten as
  // a shortcut instead of typed. The one exception is a plain click/focus
  // change, which always works regardless, so there's no way to get stuck
  // in edit mode.
  let ruleDialogKeydownHandler = null;

  function dismissRuleDialog() {
    if (ruleDialogEl) {
      ruleDialogEl.remove();
      ruleDialogEl = null;
    }
    if (ruleDialogBackdropEl) {
      ruleDialogBackdropEl.remove();
      ruleDialogBackdropEl = null;
    }
    if (ruleDialogKeydownHandler) {
      document.removeEventListener("keydown", ruleDialogKeydownHandler);
      ruleDialogKeydownHandler = null;
    }
  }

  // One click (or pressing "s" for Save, or the item's own highlighted
  // Tab/j/k selection) both picks the workspace and submits -- no separate
  // "Add" button needed, since the workspace list *is* the set of choices.
  // moveNow/switchTo are read at submit time from the checkboxes (see
  // showAddRuleDialog) rather than passed in, since they can change while
  // the dialog is open.
  function submitRuleDialog(workspace, input, moveNow, switchTo, tabId) {
    const expression = input.value.trim();
    if (!expression) return;
    chrome.runtime.sendMessage({
      type: "vwh-add-rule-request",
      displayWindowId: myWindowId,
      ruleType: "CONTAINS",
      expression,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceEmoji: workspace.emoji,
      tabId,
      moveNow,
      switchTo,
    });
    dismissRuleDialog();
  }

  // Sticky checkbox state -- chrome.storage.local (confirmed available in
  // this context) rather than a module-level variable, so it survives
  // across dialog opens/closes *and* Vivaldi restarts, matching what
  // "sticky" means for an ordinary app preference.
  const STICKY_KEYS = { moveNow: "vwhMoveTabNow", switchTo: "vwhSwitchToWorkspace" };

  function showAddRuleDialog(message) {
    dismissToast();
    dismissRuleDialog();

    const backdrop = document.createElement("div");
    backdrop.id = "vwh-rule-dialog-backdrop";
    backdrop.style.cssText = ["position: fixed", "inset: 0", "z-index: 2147483646", "background: transparent"].join(";");
    backdrop.addEventListener("click", dismissRuleDialog);
    document.body.appendChild(backdrop);
    ruleDialogBackdropEl = backdrop;

    const el = document.createElement("div");
    el.id = "vwh-rule-dialog";
    el.style.cssText = [
      "position: fixed",
      // Centered on the window, not anchored to the content viewport's
      // top-right like the toast -- per Aaron's feedback (2026-08-25), the
      // top-right corner is where macOS notifications land too, and they
      // partly covered the dialog there.
      "top: 50%",
      "left: 50%",
      "transform: translate(-50%, -50%)",
      "z-index: 2147483647",
      "background: rgba(32, 32, 36, 0.95)",
      "color: #fff",
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "font-size: 13px",
      "line-height: 1.45",
      "padding: 14px 16px",
      "border-radius: 10px",
      "box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35)",
      "width: 260px",
      "user-select: none",
    ].join(";");
    el.addEventListener("click", (e) => e.stopPropagation());

    const label = document.createElement("div");
    label.textContent = "Create workspace rule";
    label.style.cssText = "font-weight: 600; margin-bottom: 8px;";
    el.appendChild(label);

    // Section labels are deliberately larger than the workspace-list items
    // below them, per Aaron's request (2026-08-25) -- they read as headers
    // for their section, not as fine print about it.
    const SECTION_LABEL_STYLE = "font-size: 15px; font-weight: 600; margin-bottom: 4px;";

    const editLabel = document.createElement("div");
    editLabel.textContent = "(U)RL for rule:";
    editLabel.style.cssText = SECTION_LABEL_STYLE;
    el.appendChild(editLabel);

    // Looks inert (transparent, borderless) until focused -- clicking it
    // directly or pressing "u" both focus it; a small pencil button gives
    // mouse users an explicit, discoverable affordance for the same thing
    // rather than relying on them to guess a plain click works.
    const inputRow = document.createElement("div");
    inputRow.style.cssText = "display: flex; gap: 6px; align-items: center; margin-bottom: 14px;";

    const input = document.createElement("input");
    input.type = "text";
    input.value = message.domain || "";
    // Explicit tabIndex values (not DOM order) drive Tab-cycling order --
    // per Aaron's request (2026-08-25): list, then move-now checkbox, then
    // switch-to checkbox, then the URL field, even though the URL field
    // sits first in the DOM (it's shown first visually). Positive tabIndex
    // values are visited in ascending order before any tabIndex=0 element,
    // regardless of DOM position -- 1000+ here just leaves comfortable
    // headroom above however many workspace buttons exist (see their own
    // tabIndex assignment below). Confirmed live (2026-08-25, Aaron tested)
    // that Tab actually cycles through exactly this order -- unlike
    // Escape/Enter/Space/arrows (see the big keyboard-navigation comment
    // above), Tab is handled as native per-element focus order below the
    // JS layer, not globally intercepted the same way.
    input.tabIndex = 1002;
    input.style.cssText = [
      "flex: 1",
      "min-width: 0",
      "box-sizing: border-box",
      "padding: 6px 8px",
      "border-radius: 6px",
      "border: 1px solid transparent",
      "background: transparent",
      "color: #fff",
      "font-size: 13px",
      "transition: background 0.1s, border-color 0.1s",
    ].join(";");
    input.addEventListener("focus", () => {
      input.style.background = "rgba(255,255,255,0.08)";
      input.style.borderColor = "rgba(255,255,255,0.25)";
    });
    input.addEventListener("blur", () => {
      input.style.background = "transparent";
      input.style.borderColor = "transparent";
    });
    inputRow.appendChild(input);

    const editBtn = document.createElement("div");
    editBtn.textContent = "✎";
    editBtn.title = "Edit domain (or press u)";
    editBtn.style.cssText = [
      "cursor: pointer",
      "padding: 4px 6px",
      "border-radius: 6px",
      "opacity: 0.7",
      "flex-shrink: 0",
    ].join(";");
    editBtn.addEventListener("mouseenter", () => (editBtn.style.opacity = "1"));
    editBtn.addEventListener("mouseleave", () => (editBtn.style.opacity = "0.7"));
    editBtn.addEventListener("click", () => {
      input.focus();
      input.select();
    });
    inputRow.appendChild(editBtn);

    el.appendChild(inputRow);

    const workspaceLabel = document.createElement("div");
    workspaceLabel.style.cssText = SECTION_LABEL_STYLE;
    workspaceLabel.appendChild(document.createTextNode("(W)orkspace:"));
    const workspaceHint = document.createElement("span");
    workspaceHint.textContent = "    [j/k navigates]";
    workspaceHint.style.cssText = "font-size: 11px; font-weight: 400; opacity: 0.55;";
    workspaceLabel.appendChild(workspaceHint);
    el.appendChild(workspaceLabel);

    const workspaces = message.workspaces || [];
    const buttons = [];
    // Pre-selected on open (per Aaron's request, 2026-08-25) -- also
    // ensures j/k/a have something to act on immediately without first
    // requiring a mouse hover.
    let selectedIndex = workspaces.length ? 0 : -1;

    function renderSelection() {
      buttons.forEach((btn, i) => {
        btn.style.background = i === selectedIndex ? "rgba(255,255,255,0.16)" : "transparent";
      });
    }

    const list = document.createElement("div");
    list.style.cssText = [
      "display: flex",
      "flex-direction: column",
      "gap: 4px",
      "max-height: 240px",
      "overflow-y: auto",
      "border-top: 1px solid rgba(255,255,255,0.15)",
      "border-bottom: 1px solid rgba(255,255,255,0.15)",
      "padding: 6px 0",
    ].join(";");
    workspaces.forEach((ws, i) => {
      const btn = document.createElement("div");
      btn.textContent = `${ws.emoji || FALLBACK_EMOJI} ${ws.name}`;
      btn.style.cssText = ["padding: 6px 8px", "border-radius: 6px", "cursor: pointer"].join(";");
      // tabIndex makes each button an actual Tab stop, ordered ahead of the
      // checkboxes/URL field below (see input's own tabIndex comment) --
      // 1-based since a real DOM position (which 0 usually behaves like in
      // this ascending-tabIndex-first scheme) isn't what's wanted here.
      btn.tabIndex = i + 1;
      // Hovering also moves the keyboard selection, so there's only ever
      // one "current" concept regardless of input device.
      btn.addEventListener("mouseenter", () => {
        selectedIndex = i;
        renderSelection();
      });
      btn.addEventListener("click", () => submitRuleDialog(ws, input, moveNowCheckbox.checked, switchToCheckbox.checked, message.tabId));
      list.appendChild(btn);
      buttons.push(btn);
    });
    renderSelection();
    el.appendChild(list);

    // ---- move-now / switch-to checkboxes (sticky) ----
    // A real (but visually hidden) <input type=checkbox> drives state,
    // events, tabIndex, and disabled -- everything below keeps working
    // against .checked/.disabled/.dispatchEvent(new Event("change"))
    // unchanged. A separate sibling "box" div renders the actual visible
    // checkmark, fully custom rather than relying on native rendering --
    // built after two failed rounds of trying to fix a native checkbox's
    // dark-mode contrast (default rendering, then an explicit accent-color)
    // that Aaron still couldn't visually distinguish checked from
    // unchecked. Label-wrapping still makes the whole row clickable and
    // toggles the real (hidden) checkbox via the browser's own native
    // label/control association, regardless of the checkbox being
    // invisible -- nothing extra needed for that part.
    function createCheckboxRow(labelText, indentPx, tabIndexValue) {
      const row = document.createElement("label");
      row.style.cssText = `display: flex; align-items: center; gap: 6px; margin-top: ${indentPx ? "3px" : "10px"}; margin-left: ${indentPx || 0}px; cursor: pointer; font-size: 11px;`;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.tabIndex = tabIndexValue;
      checkbox.style.cssText = "position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0;";

      const box = document.createElement("div");
      box.style.cssText = [
        "width: 11px",
        "height: 11px",
        "border-radius: 3px",
        "border: 1px solid rgba(255,255,255,0.5)",
        "flex-shrink: 0",
        "display: flex",
        "align-items: center",
        "justify-content: center",
        "font-size: 8px",
        "line-height: 1",
        "box-sizing: border-box",
      ].join(";");

      function syncBox() {
        box.style.background = checkbox.checked ? "#5b9dff" : "transparent";
        box.style.borderColor = checkbox.checked ? "#5b9dff" : "rgba(255,255,255,0.5)";
        box.textContent = checkbox.checked ? "✓" : "";
      }
      checkbox.addEventListener("change", syncBox);
      // Native focus ring doesn't render on a zero-size element -- fake one
      // on the visible box instead, so Tab-cycling here is still visible.
      checkbox.addEventListener("focus", () => (box.style.boxShadow = "0 0 0 2px rgba(91,157,255,0.6)"));
      checkbox.addEventListener("blur", () => (box.style.boxShadow = "none"));
      syncBox();

      row.appendChild(checkbox);
      row.appendChild(box);
      row.appendChild(document.createTextNode(labelText));
      return { row, checkbox, syncBox };
    }

    const { row: moveRow, checkbox: moveNowCheckbox, syncBox: syncMoveBox } = createCheckboxRow("Also (M)ove this tab now", 0, 1000);
    el.appendChild(moveRow);

    const { row: switchRow, checkbox: switchToCheckbox, syncBox: syncSwitchBox } = createCheckboxRow(
      "...and (O)pen that workspace",
      20,
      1001
    );
    el.appendChild(switchRow);

    function applyMoveNowEnabledState() {
      switchToCheckbox.disabled = !moveNowCheckbox.checked;
      switchRow.style.opacity = moveNowCheckbox.checked ? "1" : "0.5";
    }

    chrome.storage.local.get([STICKY_KEYS.moveNow, STICKY_KEYS.switchTo], (stored) => {
      moveNowCheckbox.checked = !!stored[STICKY_KEYS.moveNow];
      switchToCheckbox.checked = !!stored[STICKY_KEYS.switchTo];
      // Setting .checked directly doesn't fire "change", so the custom
      // visual box needs an explicit sync here (createCheckboxRow's own
      // "change" listener only covers user interaction, e.g. a click).
      syncMoveBox();
      syncSwitchBox();
      applyMoveNowEnabledState();
    });
    moveNowCheckbox.addEventListener("change", () => {
      applyMoveNowEnabledState();
      chrome.storage.local.set({ [STICKY_KEYS.moveNow]: moveNowCheckbox.checked });
    });
    switchToCheckbox.addEventListener("change", () => {
      chrome.storage.local.set({ [STICKY_KEYS.switchTo]: switchToCheckbox.checked });
    });

    // ---- (C)ancel / (S)ave new Rule -- the Esc/Enter replacement ----
    // Since neither Escape nor Enter reaches this dialog at all (see the
    // big keyboard-navigation comment above), this row gives both a
    // visible, clickable equivalent and dedicated letter shortcuts for
    // "back out" and "finish", rather than requiring click-away or an
    // undiscoverable shortcut to be found on their own.
    function submitAccepted() {
      if (selectedIndex >= 0) submitRuleDialog(workspaces[selectedIndex], input, moveNowCheckbox.checked, switchToCheckbox.checked, message.tabId);
    }

    const actionsRow = document.createElement("div");
    actionsRow.style.cssText = "display: flex; justify-content: flex-end; gap: 16px; margin-top: 12px; font-size: 12px;";

    const cancelBtn = document.createElement("span");
    cancelBtn.textContent = "(C)ancel";
    cancelBtn.style.cssText = "cursor: pointer; opacity: 0.7;";
    cancelBtn.addEventListener("mouseenter", () => (cancelBtn.style.opacity = "1"));
    cancelBtn.addEventListener("mouseleave", () => (cancelBtn.style.opacity = "0.7"));
    cancelBtn.addEventListener("click", dismissRuleDialog);
    actionsRow.appendChild(cancelBtn);

    const saveBtn = document.createElement("span");
    saveBtn.textContent = "(S)ave new Rule";
    saveBtn.style.cssText = "cursor: pointer; opacity: 0.9; font-weight: 600;";
    saveBtn.addEventListener("mouseenter", () => (saveBtn.style.opacity = "1"));
    saveBtn.addEventListener("mouseleave", () => (saveBtn.style.opacity = "0.9"));
    saveBtn.addEventListener("click", submitAccepted);
    actionsRow.appendChild(saveBtn);

    el.appendChild(actionsRow);

    document.body.appendChild(el);
    ruleDialogEl = el;

    // Confirmed live (2026-08-25, reported by Aaron): j/k did nothing at
    // all until he'd clicked a checkbox first. Root cause: the dialog
    // opens (typically) while keyboard focus is still on the actual page
    // content, which renders in a <webview> running in a separate process
    // -- its focus is invisible to this document's own keydown listener
    // entirely, the same cross-process boundary documented elsewhere in
    // this project (see window-toast.js's own file-header comment on why
    // an in-page toast shortcut could never work reliably). A checkbox is
    // a genuinely focusable native element, so clicking one pulled
    // keyboard focus into this document and fixed it as a side effect;
    // the workspace buttons are plain unstyled `<div>`s, not focusable by
    // default, so clicking one wouldn't have had the same effect.
    // tabIndex=-1 makes the dialog container itself focusable via script
    // (without adding it to the tab order), and focusing it immediately
    // here reproduces the same fix without requiring a checkbox click.
    el.tabIndex = -1;
    el.focus();

    // "s" means Save here, not Switch -- per Aaron's request (2026-08-25),
    // the switch-to-workspace checkbox was relabeled to "(O)pen" specifically
    // to free up "s" for the new Cancel/Save row below.
    const NAV_KEYS = new Set(["w", "j", "k", "u", "m", "o", "c", "s"]);
    ruleDialogKeydownHandler = (e) => {
      // Gated the same as every other letter shortcut -- "w" is common in
      // real domains ("www...."), so like the rest it must never fire
      // while the input has focus, or typing a domain would get eaten
      // mid-word. That does mean there's no keyboard-only way to leave
      // edit mode without submitting or clicking -- an accepted gap, not
      // an oversight, given the alternative is corrupting normal typing.
      if (document.activeElement === input) return; // typing -- not a nav command
      if (!NAV_KEYS.has(e.key)) return;
      // Confirmed live (2026-08-25, reported by Aaron): without this,
      // pressing "u" to focus the URL field also typed a literal "u" into
      // it, replacing the pre-selected text. Root cause: input.focus() runs
      // synchronously inside this handler, but the *same* keydown event
      // still continues to its default action afterward (this handler
      // never called preventDefault) -- by then focus has already moved to
      // the input, so the browser's default "insert this character"
      // action fires against the newly-focused field instead of wherever
      // focus was before. Same risk existed for every other letter here
      // too, just less visible since they don't call .focus()/.select().
      e.preventDefault();
      if (e.key === "w") {
        selectedIndex = buttons.length ? 0 : -1;
        renderSelection();
      } else if (e.key === "j") {
        selectedIndex = buttons.length ? (selectedIndex + 1) % buttons.length : -1;
        renderSelection();
      } else if (e.key === "k") {
        selectedIndex = buttons.length ? (selectedIndex - 1 + buttons.length) % buttons.length : -1;
        renderSelection();
      } else if (e.key === "u") {
        input.focus();
        input.select();
      } else if (e.key === "s") {
        submitAccepted();
      } else if (e.key === "c") {
        dismissRuleDialog();
      } else if (e.key === "m") {
        moveNowCheckbox.checked = !moveNowCheckbox.checked;
        moveNowCheckbox.dispatchEvent(new Event("change"));
      } else if (e.key === "o") {
        if (!switchToCheckbox.disabled) {
          switchToCheckbox.checked = !switchToCheckbox.checked;
          switchToCheckbox.dispatchEvent(new Event("change"));
        }
      }
    };
    document.addEventListener("keydown", ruleDialogKeydownHandler);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "vwh-show-toast") {
      if (myWindowId == null || message.displayWindowId !== myWindowId) return;
      console.log(TAG, "Showing toast:", message);
      showToast(message);
    } else if (message.type === "vwh-show-add-rule-dialog") {
      if (myWindowId == null || message.displayWindowId !== myWindowId) return;
      console.log(TAG, "Showing add-rule dialog:", message);
      showAddRuleDialog(message);
    }
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
