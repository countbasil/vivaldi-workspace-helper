// Vivaldi Workspace Helper -- chrome.commands trigger.
//
// An OPTIONAL alternative to the recommended Shortcuts.app path (see
// CLAUDE.md's "Triggering a jump from outside Vivaldi" section) for people
// who'd rather stay entirely in-browser. This is a genuinely separate, real
// Chrome/Vivaldi extension -- not part of injected/, and not installed the
// same way. Install by enabling Developer Mode in vivaldi://extensions,
// then "Load unpacked" -> select this extension/ directory.
//
// UNVERIFIED as of 2026-08-09, unlike the rest of this project's docs, which
// only ever claim things confirmed live: Vivaldi has a long-standing bug
// where extension-declared keyboard commands in the default ("In Vivaldi")
// scope often don't fire at all -- see the planning doc's 2026-08-09 section
// for the forum threads this was found in. If the shortcut below doesn't
// fire, try switching its scope to "Global" in vivaldi://extensions ->
// Keyboard Shortcuts, and note whether that UI still accepts Alt+Command+J
// or forces a Ctrl+Shift+[0-9]-style combo instead -- either result belongs
// back in the planning doc, not just in your own head.
const RELAY_URL = "http://127.0.0.1:8877/jump-last-routed";

chrome.commands.onCommand.addListener((command) => {
  if (command !== "jump-last-routed") return;
  fetch(RELAY_URL).catch((e) => console.error("[VWH-ext] relay request failed:", e));
});
