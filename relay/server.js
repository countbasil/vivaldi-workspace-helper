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
//   GET  http://127.0.0.1:<port>/open-add-rule-dialog
//        -- opens the "route this domain to a workspace" dialog (Feature 5)
//        for the active tab in Vivaldi's currently focused window. Same
//        response shape as /jump-last-routed, plus
//        {reason:"NO_FOCUSED_WINDOW"}/{reason:"NO_ACTIVE_TAB"} from the page
//        side. Bind to an external hotkey the same way as the other
//        endpoints above -- see CLAUDE.md's "Triggering a jump from outside
//        Vivaldi" section for the recommended macOS Shortcuts.app setup.
//   GET  http://127.0.0.1:<port>/jump-to-workspace?workspace=<name>
//        -- focuses the window currently showing the named workspace, or
//        creates a new blank window and assigns it there if none exists yet.
//        This is bridge/workspace-jump.js's entire job (CDP + the
//        --remote-debugging-port-only Debug launcher), reimplemented on this
//        relay instead: same {ok:false, reason:"MISSING_WORKSPACE_PARAM"}
//        (400) if the query param is absent, {reason:"UNKNOWN_WORKSPACE"}
//        from the page side if the name doesn't match any configured
//        workspace, plus the usual NOT_CONNECTED/TIMEOUT. Response on
//        success: {ok:true, windowId:…, created:…, workspaceId:…,
//        workspaceName:…}. Lets a per-workspace hotkey macro (e.g. Keyboard
//        Maestro) drop the CDP bridge script entirely -- Vivaldi no longer
//        needs to run with the debug port at all for this.
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
  execFile("osascript", ["-e", script], (error, stdout, stderr) => {
    // Logged here because the only other place this error surfaces is the
    // HTTP response, which hotkey callers (`curl -s` in Keyboard Maestro)
    // discard. Most likely cause when it fails: macOS Accessibility
    // permission for the node binary running this process. That grant is
    // tied to the versioned Cellar path, so every `brew upgrade node`
    // silently revokes it (found 2026-10-16).
    if (error) {
      console.log(new Date().toISOString(), `activateWorkspace "${workspaceName}" failed:`, (stderr || String(error)).trim());
    }
    callback(error);
  });
}

// Every connected copy of the injected script, socket -> info. There can be
// more than one at a time: every private window session loads its own
// main.html with the script in it (confirmed 2026-10-17). This used to be a single
// `browserSocket` where each new connection terminated the previous one.
// With two live clients that turned into a ping-pong: the kicked client
// reconnects 1s later (its retry delay resets on every successful open) and
// kicks the other, which does the same. Result: ~1 reconnect/sec for hours,
// a 21MB log, and any request or activateWorkspace reply in flight when a
// socket was killed got silently lost. Now every client keeps its own stable
// connection, and pickBrowserSocket chooses which one gets HTTP requests.
// Dead sockets (e.g. a half-open connection after sleep, the case the old
// terminate-on-new rule handled implicitly) are reaped by the heartbeat
// below instead.
const clients = new Map();
let nextClientNumber = 1;
let lastPickedSocket = null;
let nextRequestId = 1;
const pending = new Map(); // requestId -> resolve(result)
const HEARTBEAT_MS = 30000;

function describeClient(info) {
  const h = info.hello;
  if (!h) return `#${info.number} (no hello yet)`;
  const wins = Array.isArray(h.windows) ? h.windows.map((w) => (w.incognito ? "private" : "normal") + ":" + w.type).join(",") : "?";
  return `#${info.number} incognito=${h.incognito} startedAt=${h.startedAt} windows=[${wins}] href=${h.href}`;
}

// Prefer a client that isn't running in a private-window (incognito)
// context: there, the chrome.* APIs only see private windows, so a "move the
// focused window's tabs" request would act on the wrong set of windows.
// Among the rest, prefer the longest-running page (earliest startedAt): the
// regular profile's main.html loads at browser startup and lives for the
// whole session, while extra copies come and go. Clients that haven't sent a
// hello yet (an old injected script that predates it) fall back to their
// connection time.
function pickBrowserSocket() {
  let best = null;
  for (const [socket, info] of clients) {
    if (socket.readyState !== socket.OPEN) continue;
    const incognito = info.hello ? !!info.hello.incognito : false;
    const started = info.hello && info.hello.startedAt ? info.hello.startedAt : info.connectedAt;
    const rank = [incognito ? 1 : 0, started];
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) {
      best = { socket, info, rank };
    }
  }
  const socket = best ? best.socket : null;
  if (socket && socket !== lastPickedSocket && clients.size > 1) {
    console.log(new Date().toISOString(), "Routing requests to client", describeClient(best.info));
  }
  lastPickedSocket = socket;
  return socket;
}

// Shared by every endpoint that forwards a request to the browser side and
// waits for its response -- handleJumpLastRouted and
// handleMoveSelectedTabsToWorkspace below just supply the message.
function sendBrowserRequest(res, message) {
  const browserSocket = pickBrowserSocket();
  if (!browserSocket) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "NOT_CONNECTED" }));
    return;
  }
  const requestId = String(nextRequestId++);
  const timer = setTimeout(() => {
    pending.delete(requestId);
    console.log(new Date().toISOString(), `${message.type} timed out`);
    res.writeHead(504, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "TIMEOUT" }));
  }, REQUEST_TIMEOUT_MS);

  pending.set(requestId, (result) => {
    clearTimeout(timer);
    if (!result.ok) console.log(new Date().toISOString(), `${message.type} failed:`, JSON.stringify(result));
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

function handleOpenAddRuleDialog(res) {
  sendBrowserRequest(res, { type: "openAddRuleDialog" });
}

function handleJumpToWorkspace(res, workspaceName) {
  if (!workspaceName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "MISSING_WORKSPACE_PARAM" }));
    return;
  }
  sendBrowserRequest(res, { type: "jumpToWorkspace", workspaceName });
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
  if (req.method === "GET" && parsed.pathname === "/open-add-rule-dialog") {
    return handleOpenAddRuleDialog(res);
  }
  if (req.method === "GET" && parsed.pathname === "/jump-to-workspace") {
    return handleJumpToWorkspace(res, parsed.searchParams.get("workspace"));
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/bridge" });

wss.on("connection", (socket) => {
  const info = { number: nextClientNumber++, connectedAt: Date.now(), hello: null, alive: true };
  clients.set(socket, info);
  console.log(new Date().toISOString(), `Vivaldi connected (client #${info.number}, ${clients.size} connected)`);
  socket.on("pong", () => {
    info.alive = true;
  });

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }
    if (msg.type === "hello") {
      info.hello = msg;
      console.log(new Date().toISOString(), "Client identified:", describeClient(info));
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
    clients.delete(socket);
    if (lastPickedSocket === socket) lastPickedSocket = null;
    console.log(new Date().toISOString(), `Vivaldi disconnected (client #${info.number}, ${clients.size} connected)`);
  });
  socket.on("error", () => {});
});

// Reaps connections that died without a clean close (e.g. across sleep), so
// pickBrowserSocket never routes a request into a dead socket.
setInterval(() => {
  for (const [socket, info] of clients) {
    if (!info.alive) {
      console.log(new Date().toISOString(), `Client #${info.number} missed heartbeat, terminating`);
      socket.terminate();
      continue;
    }
    info.alive = false;
    try {
      socket.ping();
    } catch (e) {}
  }
}, HEARTBEAT_MS);

server.listen(PORT, "127.0.0.1", () => {
  console.log(new Date().toISOString(), `Relay listening on http://127.0.0.1:${PORT} (WS path /bridge)`);
});
