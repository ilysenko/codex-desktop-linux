# Global Dictation

This optional feature enables the global dictation controls already present in the desktop app.

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

Wayland shortcuts must contain at least one modifier and one key. Modifier-only
shortcuts cannot be represented by the XDG shortcut format and are rejected
before registration.

```bash
node --test linux-features/global-dictation/test.js
```
