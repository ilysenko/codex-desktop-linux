# New Window desktop action

Enable `desktop-new-window` in `make setup-native`, then rebuild and install
the package. On NixOS and Home Manager, add `"desktop-new-window"` to
`programs.codexDesktopLinux.linuxFeatures`. For a direct flake package
override, pass `linuxFeatureIds = [ "desktop-new-window" ];`.

Choose **New Window** from the ChatGPT Community launcher menu on desktops
that expose desktop actions. The action starts ChatGPT Community when it is
closed and adds a window to the running app otherwise. An explicit cold
launch through the action opens a visible window even with
`start-minimized-to-tray` enabled.

The feature uses Electron's existing single-instance handoff and the window
callback behind **File → New Window**. It is disabled by default. If an
upstream release changes the handoff, the build records a warning in
`.codex-linux/patch-report.json` and omits the launcher action. The app's
**File → New Window** command is available separately.

Run `node --test linux-features/desktop-new-window/test.js` and
`bash tests/scripts_smoke.sh` for the patch and packaging checks.
