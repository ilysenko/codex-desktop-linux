# Global Dictation

This optional feature enables the global dictation controls already present in the desktop app.

`wayland-global-shortcuts` independently enables Popout, Mini/Pet and the app's
other global commands. Selecting both features shares one queued portal backend.

X11 uses Electron for shortcut registration and a short-lived modifier-state
watcher while hold-to-talk is active. Wayland uses the XDG GlobalShortcuts
portal so both activation and release come from the compositor. The helper does
not read `/dev/input` or require elevated permissions.

X11 requires `xinput`, `xmodmap`, and `xdotool` at runtime. Wayland requires a
desktop portal backend that implements `org.freedesktop.portal.GlobalShortcuts`
and, by default, `org.freedesktop.portal.RemoteDesktop`. On GNOME Wayland,
the separately selected [`global-dictation-gnome`](../global-dictation-gnome/README.md)
companion replaces RemoteDesktop paste with an explicitly enabled Shell
extension. GlobalShortcuts is still required for hotkey registration.

Enable the feature in `linux-features/features.json` before rebuilding:

```json
{
  "enabled": ["global-dictation"]
}
```

`make install-native` builds `codex-global-dictation-linux` once before staging
the package. Direct `./install.sh` builds must provide it at
`global-dictation-linux/target/release/codex-global-dictation-linux` or set
`CODEX_GLOBAL_DICTATION_LINUX_SOURCE`. Updater rebuilds reuse the packaged
artifact and never invoke Cargo.

The desktop portal may ask for shortcut approval on first use and keyboard
access when the first result is pasted into another application. The helper
reuses that keyboard session until the hotkey registration is stopped. If the
required portal interfaces are unavailable, the feature fails without changing
the macOS or Windows paths. At startup the helper automatically probes the
GNOME companion's D-Bus API with a two-second timeout. Version 1 selects GNOME;
a missing, disabled, incompatible, failed or timed-out companion selects
RemoteDesktop, without opening an input session during discovery. The choice
stays fixed until the helper restarts. Each GNOME paste rechecks the current
unique owner's version and submits Ctrl+V through that authorized extension;
subsequent errors never fall back to RemoteDesktop or automatically retry.
No RemoteDesktop session is opened in GNOME mode; GlobalShortcuts may still
request shortcut approval. The optional `global-dictation-gnome` feature only
ships/installs the companion, not selects the backend: manually installed
compatible companions are detected too. Restart the app/helper after enabling
the extension. X11 paste is unchanged.

Portal shortcut IDs key the compositor's saved bindings and never change.
Hold-to-talk keeps `global-dictation`, the ID used before the shared backend, so
existing approvals and bindings survive upgrades. Start/stop uses
`global-dictation-single-tap`.

Wayland shortcuts must contain at least one modifier and one key. Modifier-only
shortcuts cannot be represented by the XDG shortcut format and are rejected
before registration.

The backend uses the application's shortcut registry, including suspension
during shortcut capture and cancellation of held gestures. Approval requests
are serialized. Partial approval affects the corresponding actions; a failed
reconfiguration attempts one recovery of still-requested working actions.
Startup binds after account-access discovery. Once application quit is accepted,
the backend stops before windows and action owners are disposed, preserving KDE's
saved choices across ordinary restarts and update exits.
Session replacement can briefly interrupt global shortcuts. The helper's
registration timeout is 30 seconds.

The compositor controls the actual global bindings. On KDE, edit saved bindings
under **System Settings > Keyboard > Shortcuts > ChatGPT Community**. A preferred
combination changed in the app may leave the saved system binding unchanged.
The helper tracks the portal's binding descriptions and subsequent changes.
Escape cancellation uses the application's Electron path; global Escape delivery
on native Wayland is outside this feature's modifier-plus-key portal support.

```bash
node --test linux-features/global-dictation/test.js
node --test scripts/patches/lib/global-shortcuts-portal.test.js
cargo test --manifest-path global-dictation-linux/Cargo.toml
```
