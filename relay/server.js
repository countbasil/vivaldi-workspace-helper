#!/usr/bin/env node
// Local relay between an external hotkey trigger and the
// workspace-route-watcher script injected into Vivaldi's main.html
// (../injected/workspace-route-watcher.js).
//
// Deliberately has no dependency on chrome-remote-interface/CDP or
// --remote-debugging-port, unlike bridge/workspace-jump.js -- the injected
// script reaches this process itself via an outbound WebSocket, so this
// small always-running process is the only thing an external hotkey needs
// to trigger "jump to the last auto-routed tab".
//
// Endpoints:
//   ws://127.0.0.1:<port>/bridge        -- the injected page script connects here
//   GET  http://127.0.0.1:<port>/jump-last-routed
//        -> 503 {ok:false, reason:"NOT_CONNECTED"} if no page is connected
//        -> 200 with the page's jumpToLastRoutedTab() result otherwise
//        -> 504 {ok:false, reason:"TIMEOUT"} if the page doesn't reply in time
//   GET  http://127.0.0.1:<port>/move-selected-tabs-to-workspace?workspace=<name>
//        -- moves whatever tab(s) are currently selected in Vivaldi's
//        focused window to the named workspace. Added as a workaround for a
//        confirmed Vivaldi bug where its own "Move Active Tab to Workspace"
//        keyboard shortcuts and right-click menu both silently do nothing;
//        bind this to Ctrl+Shift+<N> via Keyboard Maestro (or similar) in
//        place of Vivaldi's own broken shortcut. Same response shape as
//        above, plus {ok:false, reason:"MISSING_WORKSPACE_PARAM"} (400) if
//        the query param is absent, or {reason:"UNKNOWN_WORKSPACE"} /
//        {reason:"NO_SELECTED_TABS"} from the page side. Deliberately
//        leaves focus on the window the request came from rather than
//        following the tab(s) to their destination -- see
//        /jump-last-moved-tabs below for how to actually get there.
//   GET  http://127.0.0.1:<port>/jump-last-moved-tabs
//        -- focuses whichever window the most recent
//        /move-selected-tabs-to-workspace call moved tabs into. Same
//        response shape as /jump-last-routed, plus
//        {reason:"NO_RECENT_MOVE"} (nothing moved yet this session) or
//        {reason:"TARGET_WINDOW_GONE"} (that window was closed since).
//
// Also handles a message *from* the browser side, {type:"activateWorkspace",
// requestId, workspaceName}: bringing a workspace on screen has no JS API
// (same finding as bridge/workspace-jump.js), so when a jump lands on a tab
// whose own workspace isn't the one its window is currently displaying, the
// injected script asks this real OS process to do the same Window-menu
// click bridge/workspace-jump.js uses, since only a real process (not page
// JS) can drive System Events.
//
// Usage: node server.js
// Env:   VIVALDI_RELAY_PORT (default 8877; must match the injected script's RELAY_PORT)

const http = require("http");
const { URL } = require("url");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = process.env.VIVALDI_RELAY_PORT ? Number(process.env.VIVALDI_RELAY_PORT) : 8877;
// Must comfortably exceed the injected script's own RELAY_REQUEST_TIMEOUT_MS
// (5000ms, for its activateWorkspace round-trip back to this same process)
// plus the window-creation step before that -- otherwise this outer timeout
// could fire and report failure while the browser side is still genuinely
// working and about to succeed.
const REQUEST_TIMEOUT_MS = 8000;

// Same technique as bridge/workspace-jump.js's activateWorkspaceViaMenu --
// see that file for why this menu click (not the Control-N keystroke) is
// the reliable way to bring a workspace on screen.
function activateWorkspaceViaMenu(workspaceName, callback) {
  const script = `
tell application "Vivaldi" to activate
tell application "System Events"
	tell process "Vivaldi"
		click menu item "Activate" of menu 1 of menu item "${workspaceName}" of menu 1 of menu item "Other Workspaces and Tabs" of menu 1 of menu bar item "Window" of menu bar 1
	end tell
end tell
`;
  execFile("osascript", ["-e", script], (error) => callback(error));
}

let browserSocket = null;
let nextRequestId = 1;
const pending = new Map(); // requestId -> resolve(result)

// Shared by every endpoint that forwards a request to the browser side and
// waits for its response -- handleJumpLastRouted and
// handleMoveSelectedTabsToWorkspace below just supply the message.
function sendBrowserRequest(res, message) {
  if (!browserSocket) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "NOT_CONNECTED" }));
    return;
  }
  const requestId = String(nextRequestId++);
  const timer = setTimeout(() => {
    pending.delete(requestId);
    res.writeHead(504, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "TIMEOUT" }));
  }, REQUEST_TIMEOUT_MS);

  pending.set(requestId, (result) => {
    clearTimeout(timer);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });

  browserSocket.send(JSON.stringify(Object.assign({ requestId }, message)));
}

function handleJumpLastRouted(res) {
  sendBrowserRequest(res, { type: "jumpLastRouted" });
}

function handleMoveSelectedTabsToWorkspace(res, workspaceName) {
  if (!workspaceName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "MISSING_WORKSPACE_PARAM" }));
    return;
  }
  sendBrowserRequest(res, { type: "moveSelectedTabsToWorkspace", workspaceName });
}

function handleJumpLastMovedTabs(res) {
  sendBrowserRequest(res, { type: "jumpLastMovedTabs" });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "GET" && parsed.pathname === "/jump-last-routed") {
    return handleJumpLastRouted(res);
  }
  if (req.method === "GET" && parsed.pathname === "/move-selected-tabs-to-workspace") {
    return handleMoveSelectedTabsToWorkspace(res, parsed.searchParams.get("workspace"));
  }
  if (req.method === "GET" && parsed.pathname === "/jump-last-moved-tabs") {
    return handleJumpLastMovedTabs(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/bridge" });

wss.on("connection", (socket) => {
  if (browserSocket && browserSocket !== socket) {
    try {
      browserSocket.terminate();
    } catch (e) {}
  }
  browserSocket = socket;
  console.log(new Date().toISOString(), "Vivaldi connected");

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (msg.type === "activateWorkspace") {
      activateWorkspaceViaMenu(msg.workspaceName, (error) => {
        socket.send(
          JSON.stringify({
            requestId: msg.requestId,
            ok: !error,
            reason: error ? String(error.message || error) : undefined,
          })
        );
      });
      return;
    }
    if (msg.requestId == null) return;
    const resolve = pending.get(String(msg.requestId));
    if (!resolve) return;
    pending.delete(String(msg.requestId));
    const { requestId, ...result } = msg;
    resolve(result);
  });

  socket.on("close", () => {
    if (browserSocket === socket) {
      browserSocket = null;
      console.log(new Date().toISOString(), "Vivaldi disconnected");
    }
  });
  socket.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(new Date().toISOString(), `Relay listening on http://127.0.0.1:${PORT} (WS path /bridge)`);
});
