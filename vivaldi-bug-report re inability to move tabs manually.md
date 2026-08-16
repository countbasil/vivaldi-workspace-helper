**Title:** "Move tab to workspace" (keyboard shortcut and right-click menu) does nothing at all

**Version:** Vivaldi 8.1.4087.64
**OS:** macOS 26.5.2 (build 25F84)

**Steps to reproduce:**
1. Have at least one workspace configured with an assigned keyboard shortcut (Settings → Keyboard → the "Move Active Tab to Workspace N" commands), or just use the tab's right-click context menu.
2. With any tab active/selected, either:
   - Press the keyboard shortcut for a specific workspace, or
   - Right-click the tab → **Move** → select a workspace by name from the submenu.
3. Observe the result.

**Expected:** The tab moves to the selected workspace (whether or not the current window then follows/switches to it — I'm aware that follow-behavior is a separate, already-reported issue).

**Actual:** Nothing happens [the vast majority of the time--sometimes seems to work on a given app launch]. The tab stays exactly where it was — same window, same position, not tagged to the new workspace in any way. No error, no visual feedback, no indication the action was attempted at all. 

**Notes:**
- Reproduces identically via both the keyboard shortcut and the right-click context menu, so it isn't specific to one input path.
- Reproduces regardless of whether the target workspace already has an existing window open elsewhere, or has no window open at all — same silent no-op either way.
- Reproduces on a completely fresh tab in a brand-new window with no extensions, history, or special setup involved — not specific to any particular tab, profile customization, or third-party extension.

Happy to provide more detail or test a fix if useful.
