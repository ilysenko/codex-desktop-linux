# Chromium SUID Sandbox

This disabled-by-default Linux Feature removes the launcher's compatibility
`--no-sandbox` and `--disable-gpu-sandbox` defaults after validating a
host-installed Chromium SUID helper. It supports user-managed generated apps;
native `.deb`, RPM, and pacman packaging fails closed while this feature is
enabled. It contains renderer-process containment policy only; it does not
change Codex permissions, approvals, filesystem, or network authority.

Enable `chromium-sandbox` in the gitignored `linux-features/features.json` and
build the app. The feature staging hook relocates the generated helper to a
provenance reference, leaving Electron's sibling `chrome-sandbox` path absent.
Install that exact reference as the privileged helper:

```bash
sudo install -D -o root -g root -m 4755 \
  codex-app/.codex-linux/features/chromium-sandbox/generated-chrome-sandbox \
  /usr/local/lib/codex-desktop-linux/chrome-sandbox
```

Launch with the caller-selected absolute path:

```bash
CHROME_DEVEL_SANDBOX=/usr/local/lib/codex-desktop-linux/chrome-sandbox \
  ./codex-app/start.sh
```

Chromium checks for a sibling `chrome-sandbox` before consulting
`CHROME_DEVEL_SANDBOX`. The feature therefore fails unless that sibling stays
absent and the generated Electron executable is owned by the launching user.
This makes the caller-selected environment path authoritative without placing
a machine-specific path in the build. The selected helper must be an absolute,
non-symlink executable regular file, owned by root:root with mode 4755, and
byte-identical to the preserved generated helper. Reinstall it after every
Electron rebuild. Any explicit `--no-sandbox` or `--disable-*-sandbox` argument
is rejected.

The native package builders reject this feature because installed Electron
payloads are root-owned, so Chromium will not use the development-helper
environment fallback. Build the ordinary user-managed app for this
host-qualified mode. The Nix feature selector does not expose this feature for
the same root-owned-store constraint.

Because the launcher has no authoritative, race-safe evidence of a resident
primary's Chromium mode, this feature rejects every launch while a resident app
process is active. Quit the running app before requesting a sandboxed launch.
Compatibility-mode launches and warm starts are unchanged when this feature is
disabled.

Run `node --test linux-features/chromium-sandbox/test.js` to exercise staging,
helper validation, argument rejection, and both resident handoff paths.
