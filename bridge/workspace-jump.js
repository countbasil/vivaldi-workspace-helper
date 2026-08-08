#!/usr/bin/env node
// Focuses the window currently showing the named Vivaldi workspace, or
// creates a new blank window and assigns it to that workspace itself (via
// the Window > Other Workspaces and Tabs > <name> > Activate menu item,
// through System Events -- Vivaldi has no JS API to assign a workspace to
// a window directly, only this native menu action can; safe here since
// it's always a brand-new blank window being assigned, never a possibly-
// unrelated one).
//
// Requires Vivaldi to be running with --remote-debugging-port=<PORT>.
// First run may prompt for Accessibility/Automation permission for the
// calling process (Terminal / Keyboard Maestro Engine) to control Vivaldi
// via System Events -- one-time, click Allow.
//
// Usage: node workspace-jump.js <workspaceName>
// Prints one of:
//   FOCUSED <name> (window <id>)
//   ASSIGNED <name> (created window <id>)
//   NOT_DEBUG_MODE          -- can't reach Vivaldi's CDP port
//   ERROR:<message>         -- anything else

const CDP = require("chrome-remote-interface");
const { execFileSync } = require("child_process");

const PORT = process.env.VIVALDI_CDP_PORT ? Number(process.env.VIVALDI_CDP_PORT) : 9222;

// Harvests the internal workspace store the same way vivaldi-theme-switcher
// does (see /Users/aaron/Developer/vivaldi-tools/vivaldi-theme-switcher/custom.js):
// push a no-op chunk to harvest __webpack_require__, then scan the module
// factory registry for the unique source signature of the workspace store.
const HARVEST_EXPR = `
(async function() {
  const chunk = window.webpackChunkgapp_browser_react;
  if (!chunk || typeof chunk.push !== "function") {
    throw new Error("webpackChunkgapp_browser_react not available");
  }
  const req = await new Promise((resolve, reject) => {
    try { chunk.push([[Symbol("probe")], {}, (r) => resolve(r)]); }
    catch (e) { reject(e); }
  });
  const SIG = "getActiveWorkspaceId(e){return this.getState().activeWorkspaces.get";
  const factories = req.m || {};
  let store = null;
  for (const id in factories) {
    const fn = factories[id];
    if (typeof fn !== "function") continue;
    let src;
    try { src = Function.prototype.toString.call(fn); } catch (_) { continue; }
    if (src.indexOf(SIG) === -1) continue;
    try {
      const mod = req(id);
      const candidate = mod && (mod.Z || mod.ZP || mod);
      if (candidate && typeof candidate.getActiveWorkspaceId === "function" && typeof candidate.addListener === "function") {
        store = candidate;
        break;
      }
    } catch (e) {}
  }
  if (!store) throw new Error("workspace store not found");
  const workspaces = store.getWorkspaces();
  const active = [...store.getActiveWorkspaces()];
  return JSON.stringify({ workspaces, active });
})()
`;

async function findMainTarget(port) {
  const targets = await CDP.List({ port });
  return targets.find(
    (t) => t.url && t.url.startsWith("chrome-extension://") && t.url.endsWith("/main.html")
  );
}

// Assigns the given workspace to Vivaldi's current window via its native
// Window menu (System Events UI scripting -- confirmed more reliable than
// synthesizing the Control-N keystroke, which raced against window-focus
// timing). Only ever called against a freshly-created blank window.
function activateWorkspaceViaMenu(workspaceName) {
  const script = `
tell application "Vivaldi" to activate
tell application "System Events"
	tell process "Vivaldi"
		click menu item "Activate" of menu 1 of menu item "${workspaceName}" of menu 1 of menu item "Other Workspaces and Tabs" of menu 1 of menu bar item "Window" of menu bar 1
	end tell
end tell
`;
  execFileSync("osascript", ["-e", script]);
}

async function main() {
  const workspaceName = process.argv[2];
  if (!workspaceName) {
    console.error("Usage: node workspace-jump.js <workspaceName>");
    process.exit(1);
  }

  const target = await findMainTarget(PORT).catch(() => null);
  if (!target) {
    console.error(
      `Could not find Vivaldi's main.html target on port ${PORT}. ` +
      `Is Vivaldi running with --remote-debugging-port=${PORT}?`
    );
    console.log("NOT_DEBUG_MODE");
    process.exit(1);
  }

  const client = await CDP({ port: PORT, target: target.id });
  try {
    const { Runtime } = client;
    await Runtime.enable();

    const harvestResult = await Runtime.evaluate({
      expression: HARVEST_EXPR,
      awaitPromise: true,
      returnByValue: true,
    });
    if (harvestResult.exceptionDetails) {
      throw new Error(
        "Harvest failed: " +
        (harvestResult.exceptionDetails.exception?.description || JSON.stringify(harvestResult.exceptionDetails))
      );
    }

    const { workspaces, active } = JSON.parse(harvestResult.result.value);
    const idx = workspaces.findIndex((w) => w.name === workspaceName);
    if (idx === -1) {
      const msg = `Workspace "${workspaceName}" not found. Known workspaces: ${workspaces.map((w) => w.name).join(", ")}`;
      console.error(msg);
      console.log("ERROR:" + msg);
      process.exit(1);
    }
    const targetId = workspaces[idx].id;

    const activeEntry = active.find(([wsId]) => wsId === targetId);
    if (activeEntry) {
      const winId = activeEntry[1];
      const focusResult = await Runtime.evaluate({
        expression: `chrome.windows.update(${winId}, {focused: true})`,
        awaitPromise: true,
      });
      if (focusResult.exceptionDetails) {
        throw new Error(
          "Focus failed: " +
          (focusResult.exceptionDetails.exception?.description || JSON.stringify(focusResult.exceptionDetails))
        );
      }
      console.log(`FOCUSED ${workspaceName} (window ${winId})`);
    } else {
      const createResult = await Runtime.evaluate({
        expression: `chrome.windows.create({})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (createResult.exceptionDetails) {
        throw new Error(
          "Create failed: " +
          (createResult.exceptionDetails.exception?.description || JSON.stringify(createResult.exceptionDetails))
        );
      }
      const newWinId = createResult.result.value?.id;
      // No delay needed here -- activateWorkspaceViaMenu's own
      // "tell application Vivaldi to activate" handles re-focusing
      // reliably by itself (confirmed: works immediately, unlike the
      // keystroke approach this replaced).
      activateWorkspaceViaMenu(workspaceName);
      console.log(`ASSIGNED ${workspaceName} (created window ${newWinId})`);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  console.log("ERROR:" + (e.message || e));
  process.exit(1);
});
