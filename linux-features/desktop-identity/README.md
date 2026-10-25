# Community Desktop Identity

This opt-in feature makes the app identify itself to the Linux desktop as
ChatGPT Community instead of the official ChatGPT entry.

The signed official `app.asar` sets `desktopName` to `chatgpt.desktop` in its
`package.json`. During startup Electron copies that value into
`CHROME_DESKTOP`, replacing the `codex-desktop.desktop` value set by the
launcher and desktop entry. Everything that reads the desktop name afterwards
then points at the official `chatgpt` entry, including:

- the `desktop-entry` hint of native notifications, which notification servers
  use to find the application name and icon;
- `CHROME_DESKTOP` inherited by child processes such as `codex` and the
  code-mode host;
- the default `codex://` handler, which the app registers on every launch with
  `setAsDefaultProtocolClient`. Today Community writes
  `x-scheme-handler/codex=chatgpt.desktop` to `~/.config/mimeapps.list`.

When ChatGPT Community is installed without the official package, there is no
`chatgpt.desktop`, so notification servers that resolve icons from
`desktop-entry` show these notifications without an icon. When both packages
are installed, Community notifications are attributed to the official app.

The feature rewrites only that `desktopName` value to `<CODEX_APP_ID>.desktop`
(`codex-desktop.desktop` by default), matching the installed Community desktop
entry. The rest of `package.json` keeps its exact bytes. Window classes are not
affected: the launcher already passes `--class=<CODEX_APP_ID>`.

With the feature enabled, each Community launch registers `codex://` for the
Community entry instead. On a Community-only system this points deep links at
an entry that exists. When the official package is also installed, `codex://`
belongs to whichever app was launched last, because both apps register it at
startup.

The patch accepts only the current upstream contract: valid JSON with exactly
one `desktopName` field whose value is `chatgpt.desktop`. Any other shape
fails the build while the feature is enabled, so a changed upstream identity
cannot be silently overwritten.

## Enable

Add the feature to the local, gitignored feature selection before rebuilding:

```json
{
  "enabled": ["desktop-identity"]
}
```

The desktop name is `<CODEX_APP_ID>.desktop`, the same value the launcher
exports as `CHROME_DESKTOP`. The value is fixed when `install.sh` patches the
app, not when a package is built. For a package with a custom `PACKAGE_NAME`,
run `install.sh` with the same `CODEX_APP_ID` and point the package build at
that app with `APP_DIR_OVERRIDE`, so the name matches the packaged
`<PACKAGE_NAME>.desktop` entry. Rebuild and restart ChatGPT Community after
changing the selection.

To check the result, send a test notification from the app and inspect it with
`dbus-monitor "interface='org.freedesktop.Notifications'"`: the
`desktop-entry` hint should be `codex-desktop`.

## Validate

```bash
node --test linux-features/desktop-identity/test.js
```
