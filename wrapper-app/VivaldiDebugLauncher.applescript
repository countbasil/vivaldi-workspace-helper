-- Vivaldi Debug Launcher
--
-- Always launches/activates Vivaldi with --remote-debugging-port enabled,
-- so the workspace-jump bridge script can always reach it via CDP.
--
-- Use this in place of launching Vivaldi.app directly (Dock icon, Login
-- Items, default-browser handler) so Vivaldi is NEVER started without the
-- debug flag in the first place -- avoids ever needing to quit+relaunch it.
--
-- Compile with:
--   osacompile -o "Vivaldi Debug.app" VivaldiDebugLauncher.applescript

property debugPort : 9222

on run
	launchVivaldiWithDebug()
end run

-- Called automatically by macOS when this app is the target for opening a
-- URL (e.g. if set as default browser, or targeted by a tool like Choosy).
on open location this_URL
	launchVivaldiWithDebug()
	try
		do shell script "open -a Vivaldi " & quoted form of this_URL
	end try
end open location

on launchVivaldiWithDebug()
	do shell script "open -a Vivaldi --args --remote-debugging-port=" & debugPort
end launchVivaldiWithDebug
