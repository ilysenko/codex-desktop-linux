# Troubleshooting

## Source verification fails

Run the verifier test suite and inspect the generated metadata:

```bash
node --test scripts/lib/upstream-linux-package.test.js
./install.sh --inspect --report-dir /tmp/codex-inspect
```

Do not bypass a signature or hash failure. Confirm system time, HTTPS access to
`persistent.oaistatic.com`, `gpgv`, the pinned key fingerprint, and sufficient
disk space. An explicit package must match host architecture and be named
`chatgpt` in control metadata.

## The app does not launch

```bash
/opt/codex-desktop/start.sh --diagnose
/opt/codex-desktop/ChatGPT --version
journalctl --user -u codex-update-manager.service --no-pager
```

The diagnostic checks the official executable, ASAR, bundled `codex`, `rg`, and
code-mode host. It also warns when Chromium sandbox prerequisites are missing.

Also confirm that the installed package architecture matches the machine and
that no official ChatGPT process is already holding the shared profile lock:

```bash
uname -m
pgrep -a -f '(/ChatGPT|/chatgpt)' || true
```

Do not start the underlying `ChatGPT` binary directly for normal use. The
`codex-desktop` wrapper supplies the correct desktop identity and enabled
feature hooks.

## Persistent Electron flags and native Wayland

The launcher reads shared Electron flags from
`${XDG_CONFIG_HOME:-$HOME/.config}/electron-flags.conf` and Community-specific
flags from
`${XDG_CONFIG_HOME:-$HOME/.config}/codex-desktop/electron-flags.conf`, in that
order. Put one complete argument on each line; blank lines and lines beginning
with `#` are ignored. App-specific flags are followed by enabled feature flags
and explicit command-line arguments, so a later explicit argument can override
an earlier setting.

The official Electron runtime defaults to the X11 Ozone backend, so without a
flag a Wayland session runs the app through XWayland, and a compositor whose
XWayland does not scale clients draws the window at 1x on a HiDPI output. The
launcher therefore appends `--ozone-platform=wayland` when `WAYLAND_DISPLAY`
names a compositor socket with a listener (checked through `ss` where iproute2
is available) and the session is not X11. That switch has no
fallback, which is why the socket is confirmed first, and sessions known to
misbehave on the Wayland backend keep the X11 default: ChromeOS Crostini
(Sommelier, read from the environment or the systemd user manager), GNOME
Wayland with more than one connected monitor, and WSLg. Any explicit selection
wins: a command-line argument, either flag file, a feature argument, or a
launcher hook. This runtime does not accept `--ozone-platform-hint` or
`ELECTRON_OZONE_PLATFORM_HINT`.

`CODEX_OZONE_PLATFORM=x11` or `CODEX_OZONE_PLATFORM=wayland` pins a backend
ahead of that detection while still yielding to an explicit flag; the Nix
wrapper sets `x11` so its `NIXOS_OZONE_WL` opt-in stays authoritative. To pin a
backend for every launch without editing a generated desktop entry:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/codex-desktop"
printf '%s\n' '--ozone-platform=x11' > \
  "${XDG_CONFIG_HOME:-$HOME/.config}/codex-desktop/electron-flags.conf"
```

Restart every running official and Community process after changing the file.
The launcher does not evaluate shell quoting or split a line into multiple
arguments.

## Chromium sandbox or AppArmor

Prefer a native package, which installs an AppArmor profile adapted to
`/opt/codex-desktop/ChatGPT`. AppImage intentionally refuses to disable the
sandbox automatically. Enable unprivileged user namespaces according to your
distribution policy or use the native package.

If a native package was copied between systems, verify its adapted profile and
reload AppArmor according to the distribution's tooling. Never solve a
packaging error by globally disabling Chromium sandboxing.

## Duplicate or stale desktop entries

The official package should appear as **ChatGPT**. This project should appear
as **ChatGPT Community** with a blue `C` mark. Confirm the selected entry:

```bash
grep -H '^Name=' \
  /usr/share/applications/chatgpt.desktop \
  /usr/share/applications/codex-desktop.desktop 2>/dev/null || true
```

After upgrading from an older package, refresh the desktop database or log out
and in if your shell keeps stale names or icons. Do not rename the official
desktop file to work around a shell cache.

## Official and custom apps interfere

Both use the upstream `Codex` profile. Fully exit the official `chatgpt` process
before starting `codex-desktop`, and vice versa. Their packages and desktop
entries can coexist, but upstream single-instance locking prevents reliable
parallel sessions.

In the desktop menu, the custom build is **ChatGPT Community** with a blue `C`;
the unqualified **ChatGPT** entry is OpenAI's package.

## AppImage opens from Flatpak Chrome but the extension cannot connect

The optional `flatpak-chrome-native-messaging` feature supports the
**AppImage + Flatpak Google Chrome (`com.google.Chrome`)** combination. Enable
it before building the AppImage:

```json
{
  "enabled": ["flatpak-chrome-native-messaging"]
}
```

Fully exit ChatGPT Community and Chrome after installing the rebuilt AppImage.
Start ChatGPT Community first, then reopen Chrome.

In [issue #1434](https://github.com/ilysenko/codex-desktop-linux/issues/1434),
**Open the app** launches Community, while the extension reports **Native
transport disconnected** and Settings > Computer use > Google Chrome shows
**Not installed**. Opening a URI only verifies the desktop link handler; it
does not verify the extension's native-messaging handshake.

Flatpak isolates the browser's configuration and host access. Its ability to
open a URI through a portal does not establish access to a native host; see the
[Flatpak sandbox documentation](https://docs.flatpak.org/en/latest/sandbox-permissions.html).
The feature installs a private native-host manifest and Bash wrapper under
`~/.var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts/`.
The wrapper forwards the binary native-messaging stream to an authenticated
`127.0.0.1` relay. The relay runs the exact official host selected by the
upstream runtime registry outside the sandbox. It does not add a Flatpak
override or copy the official host into the sandbox.

To identify this case, open `chrome://version` in the browser that has the
extension and inspect **Executable Path** and **Profile Path**. Check the
Flatpak installation with:

```bash
flatpak info com.google.Chrome
```

An installed Flatpak does not prove that the current browser is using it; check
the browser paths as well, especially when native Chrome is also installed.

The launcher also points the upstream Chrome diagnostics at the Flatpak profile
and manifest. If Settings still shows **Not installed**, verify that the
extension is installed in the same Flatpak profile shown by `chrome://version`,
then restart both applications in that order. If the problem persists, include
both application and browser versions, the enabled feature list, and the
extension error in the issue. Redact personal directory names from paths before
sharing them.

The legacy plugin-cache repair below addresses a different migration problem.

## Browser or Chrome plugin is visible but cannot connect

The first Community launch after migrating from the legacy pre-official build
refreshes cached Browser and Chrome plugins only when their bundled manifests
match the official Linux plugins and they contain a known retired Linux-port
marker. This one-time migration replaces the old custom Chrome extension host
and fixes the old `/tmp/codex-browser-use-<uid>` discovery path; the official
Linux runtime uses `/tmp/codex-browser-use`. It also removes legacy group-write
permission from the private `.plugin-appserver` runtime directory, which the
Chrome host rejects as an untrusted parent path.

If Browser was already loaded before that migration ran, fully exit every
ChatGPT process, fully exit Chrome/Chromium, start **ChatGPT Community**, and
then reopen the browser. Arbitrary plugin caches and user-authored plugins are
never rewritten.

Clearing the entire browser profile or all Codex plugin caches is not a normal
repair step. The official Browser/Chrome integration is already present in the
Linux payload; this migration only replaces known snapshots created by the old
community port.

If the legacy snapshot predates the recognized migration markers, remove only
the two re-creatable upstream-bundled caches, then restart Community followed
by Chrome:

```bash
pkill -TERM -x ChatGPT 2>/dev/null || true
rm -rf -- \
  "${CODEX_HOME:-$HOME/.codex}/plugins/cache/openai-bundled/browser" \
  "${CODEX_HOME:-$HOME/.codex}/plugins/cache/openai-bundled/chrome"
chmod go-w "${CODEX_HOME:-$HOME/.codex}/plugins/.plugin-appserver" 2>/dev/null || true
```

Do not delete the whole `plugins` directory: it may contain user plugins and
unrelated cached integrations.

## A feature build fails after an upstream release

Disable the feature in `linux-features/features.json` and rebuild to confirm the
official baseline. Enabled feature drift deliberately blocks candidate
promotion. Report the feature ID, package version/architecture, and patch report.

Known retired feature IDs are ignored. A misspelled or arbitrary unknown ID is
an error; correct the config rather than adding a compatibility alias.

## Updater is waiting

```bash
codex-update-manager status
systemctl --user status codex-update-manager.service
```

`WaitingForAppExit` is expected: close all ChatGPT/Codex desktop processes. For
a failed privileged install, run `codex-update-manager install-ready` after
fixing the reported package-manager issue. Roll back with
`codex-update-manager rollback`.

Collect a useful updater report with:

```bash
codex-update-manager diagnose --json
journalctl --user -u codex-update-manager.service -n 200 --no-pager
```

## Native package build or install fails

Start by separating staging from packaging:

```bash
make build-app
make package
```

If staging passes but packaging fails, confirm the distribution builder is
installed and inspect the final lines for the selected deb/RPM/pacman command.
If `sudo`-created files from an old checkout block cleanup, use the exact backup
procedure below; do not rerun the whole build as root.

For constrained systems, limit parallel compilation and compression:

```bash
MAX_BUILD_THREADS=2 make install-native
```

## Clean rebuild

Generated state may be removed and rebuilt:

```bash
make clean-dist
make build-app
make package
```

Do not delete the updater rollback artifact unless you intentionally give up
the recovery path.

To remove only package artifacts, use `make clean-dist`. `make clean-state` is
more destructive: it removes updater config/state/cache and therefore its
managed rollback information.

## Old app backup cannot be removed

`codex-app.backup-*` directories are generated transactional backups, not
source files or additional installed applications. A backup created by an old
root-run build may be owned by root. Current builds collapse that cleanup
failure to one warning and continue with the accepted candidate.

Inspect the exact stale directories before changing or deleting anything:

```bash
find "$PWD" -maxdepth 1 -type d -name 'codex-app.backup-*' -print
```

For a confirmed stale path, replace `/absolute/path/to/backup` below with one
exact path printed above:

```bash
sudo chown -R -- "$(id -u):$(id -g)" /absolute/path/to/backup
rm -rf -- /absolute/path/to/backup
```

Never run the cleanup against the repository root, `codex-app/`, the active
updater rollback artifact, `$HOME`, or a wildcard you have not inspected.
