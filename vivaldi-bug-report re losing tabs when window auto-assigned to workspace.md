**Title:** Tabs in a workspace-unassigned window are orphaned (invisible in every window, but still running) when that window gets silently auto-assigned to a workspace

**Version:** Vivaldi 8.1.4087.64
**OS:** macOS 26.5.2 (build 25F84)

**Steps to reproduce:**
1. Have at least one workspace configured with a "open websites in workspaces automatically" routing rule (Settings → Workspaces → rules), for a workspace that currently has **no window** displaying it.
2. Open a **new window** and leave it unassigned to any workspace (don't switch it to any workspace).
3. In that window, open at least two ordinary tabs that aren't going to match any routing rule — e.g. duckduckgo.com and google.com.
4. In that same window, open a **new tab** (Cmd+T) and enter/navigate to a URL that matches the routing rule from step 1. (Alternatively, you can see the same thing by launching that same URL from outside Vivaldi — another app, or `open <url>` from a terminal.)
5. Observe what happens to the window and to the duckduckgo.com/google.com tabs.

**Expected:** The routed URL opens in (or creates) a window for its target workspace, without disturbing the other tabs already open in the window it was typed/launched from.

**Actual:** Vivaldi reassigns the *current* window in place to the routed URL's target workspace (rather than opening a separate window for it), and the tabs that were previously open in that window — duckduckgo.com and google.com in this repro — disappear from the tab bar entirely. They are not closed: they're still running (confirmed via Task Manager/memory usage, and they're still findable and switchable-to via Quick Commands, `Cmd+E` → `tab:` prefix), but after this happens they are not visible or reachable from **any** window's tab bar — the window they were in now only shows the newly-routed workspace's tabs, and no other window will show them either, since they were never tagged to any workspace to begin with.

**Notes:**
- If the target workspace *already* has an existing window displaying it, this doesn't happen — Vivaldi correctly opens/moves the tab there instead. However, a notable issue is that this happens completely silently, with no visual indication anything occurred, so from the user's perspective in the originating window it can look like the URL entry/launch simply did nothing.
- **Workaround for recovering "lost" tabs**: opening one of the orphaned tabs via Quick Commands (`Cmd+E`, `tab:` prefix, select the tab) brings back the *entire* orphaned set together in a window that is (again) not assigned to any workspace — so the tabs aren't just individually recoverable, the whole original unassigned-window tab set comes back as a group.
- Related, less consistently reproducible symptoms observed around the same underlying state, which may be manifestations of the same bug:
  - Closing all tabs in a *workspace-assigned* window can cause a previously-orphaned tab to reappear unexpectedly — sometimes into that same still-assigned window, other times the window's workspace assignment itself reverts to unassigned as part of this.
  - Sometimes after one of these reversions to unassigned, the tab bar can get out of sync with reality: repeatedly opening new tabs (Cmd+T) and navigating them all show their pages correctly, but the tab bar displays only a single "blank page" entry throughout. Closing tabs with Cmd+W reveals the next page underneath as expected, but the tab bar still only ever shows "blank page" — the tab bar's displayed tab count/list appears decoupled from the window's actual open tabs in this state.
  - A second, distinct way to trigger tab loss from an unassigned window: using the keyboard shortcut to switch to a tab group/tile-group. Not yet isolated to a clean repro on its own.
  - The workspace indicator/label can become detached from the actual tab list: switched between multiple workspaces using their keyboard shortcuts, and the visible tab list didn't change at all across the switches, despite the workspaces involved having different tabs. The label showing which workspace was "active" changed as expected; the tab bar just didn't follow it.
- Reproduces consistently for the primary steps above; the "related symptoms" are real but haven't been pinned to a reliable standalone repro yet.

Happy to provide more detail, a screen recording, or test a fix if useful.
