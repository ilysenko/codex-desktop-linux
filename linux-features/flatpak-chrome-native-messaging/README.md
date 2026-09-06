# Flatpak Chrome native messaging

This disabled-by-default feature connects the official bundled Chrome
extension to ChatGPT Community when Google Chrome runs as the
`com.google.Chrome` Flatpak.

Flatpak Chrome can open `codex-browser-sidebar` links through the desktop
portal, but its sandbox cannot execute the official native host from the
ChatGPT Community plugin cache. When enabled, this feature installs a private
native-host manifest and a small Bash wrapper in the Flatpak Chrome profile.
The wrapper forwards the binary native-messaging stream over an authenticated
loopback connection. The relay runs the exact official native host outside the
sandbox, where its signed runtime registry and plugin files are available.

The feature does not add a Flatpak override. It relies on the network namespace
already shared by the published Google Chrome Flatpak and binds only to
`127.0.0.1`. A random token is stored in user-only files. The relay validates
the Chrome extension origin and the registered official host path before it
starts a host process.

Enable the feature before building:

```json
{
  "enabled": ["flatpak-chrome-native-messaging"]
}
```

Then rebuild the AppImage, fully exit ChatGPT Community and Chrome, start
ChatGPT Community, and reopen Chrome. The launcher points the upstream Chrome
diagnostics at the Flatpak profile, so Settings can inspect the same extension
and native-host manifest used by the sandbox.

Runtime files are stored under:

- `~/.var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts/`
- `${XDG_STATE_HOME:-~/.local/state}/codex-desktop/flatpak-chrome-native-messaging/`

If an unrelated native-host manifest already owns
`com.openai.codexextension`, startup fails closed and leaves that manifest
untouched. A recognized official manifest is restored when the owning desktop
process exits.
