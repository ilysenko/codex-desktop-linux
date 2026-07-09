# Troubleshooting

| Problem | Solution |
|---|---|
| `Error: write EPIPE` | Run `start.sh` directly instead of piping output |
| Blank window | Check whether the configured webview port is already in use: `ss -tlnp \| grep -E '5175\|5176'` |
| `ERR_CONNECTION_REFUSED` on the webview port | Ensure `python3` works and the configured port is free |
| Stuck on Codex logo splash | Check `~/.cache/codex-desktop/launcher.log`; another process may be serving the webview port |
| `CODEX_CLI_PATH` error | Reopen the app to retry automatic CLI install, or install manually with `npm i -g @openai/codex` / `npm i -g --prefix ~/.local @openai/codex` |
| `codex-update-manager status --json` shows `cli_status: "update_required"` for `/usr/bin/codex` on Arch | Pacman itself has a newer package for the installed CLI. Update through pacman instead of npm, for example `sudo pacman -Syu`; pacman-managed CLI installs are intentionally not auto-updated through npm |
| `codex-update-manager status --json` shows `/usr/bin/codex` with `cli_status: "up_to_date"` but `cli_official_latest_version` is newer than `cli_package_manager_latest_version` | The distro package is behind the official npm release, but pacman does not currently offer a newer package. Codex Desktop will not auto-switch channels; read `cli_error_message` and decide whether to stay on the distro-managed CLI or replace it with another install method |
| `nix run` exits with no window or terminal output | Check `~/.cache/codex-desktop/launcher.log`; the Nix package still requires a user-provided `codex` CLI |
| `gh auth status` works in terminal but fails inside Codex Desktop | See [GitHub CLI auth in app-launched shells](github-cli-auth.md) |
| Electron hangs while CLI is outdated | Re-run the launcher and check `~/.cache/codex-desktop/launcher.log` plus `~/.local/state/codex-update-manager/service.log` |
| GPU / Vulkan / Wayland errors | Try `CODEX_LINUX_RENDERING_MODE=wayland-gpu ./codex-app/start.sh` or persistent launch flags below |
| UI massively oversized, tiny, or blurry | See [Oversized or blurry UI](#oversized-or-blurry-ui-hidpi--fractional-scaling); quick fix: `CODEX_FORCE_DEVICE_SCALE_FACTOR=1 ./codex-app/start.sh` |
| Window flickering, resize ghosting, or stale frame trails | Try `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 ./codex-app/start.sh`, then `./codex-app/start.sh --disable-gpu` if needed |
| Right-clicking the title bar leaves GNOME/X11 input stuck | Press `Esc` first, or use `Alt+Space` for the window menu. If the lockup is repeatable, test the optional `frameless-titlebar` feature below and include your distro, GNOME version, X11/Wayland session, package method, and `.codex-linux/linux-features-staged.json` when reporting it |
| Transparent or dark left sidebar | Check whether the Linux opaque-window patch was applied, then rebuild with a current checkout |
| Sandbox errors | The launcher already sets `--no-sandbox` |
| Renderer crashes in containers with a tiny `/dev/shm` | The launcher keeps `--disable-dev-shm-usage` automatically when `/dev/shm` is missing or below 1 GiB; force it with `CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=1` |
| Screen reader does not read the app UI | Renderer accessibility is forced automatically when Orca, brltty, the GNOME screen-reader setting, AT-SPI accessibility state (`org.a11y.Status IsEnabled` or `toolkit-accessibility`, e.g. after `codex-computer-use-linux setup`), or accessibility env markers are detected; force it with `CODEX_FORCE_RENDERER_ACCESSIBILITY=1` |
| Stale install / cached DMG | `make build-app-fresh` removes the generated app and cached DMG, then downloads current upstream |
| Computer Use plugin invisible in UI | Enable the Computer Use UI opt-in; upstream server/account rollout can still hide some controls |
| Computer Use `doctor` reports no input backend | Grant `/dev/uinput`, enable XDG RemoteDesktop portal, or start `ydotoold` / `ydotool.service` |
| Computer Use `doctor` reports `ydotool_socket: Permission denied` | Adjust the daemon socket so users in the `input` group can use it |
| `ConnectTimeoutError` for Electron headers | Re-run `make build-app`; the installer uses `https://artifacts.electronjs.org/headers/dist` by default |
| Computer Use AT-SPI tree empty | Run `codex-computer-use-linux setup`, then restart the target app |
| `ERR_NO_SUPPORTED_PROXIES` with an authenticated proxy | Do not pass credentials inside Chromium's `--proxy-server` URL; enable the optional `authenticated-proxy` Linux feature |
| `codex-update-manager` keeps running after package removal | Run `systemctl --user disable --now codex-update-manager.service` and confirm `/opt/codex-desktop` is gone |

## Persistent Launch Flags

The launcher creates `~/.config/codex-desktop/electron-flags.conf` on first
cold start. Uncomment one flag per line; blank lines and lines starting with
`#` are ignored. Existing files are never overwritten.

For KDE/Wayland rendering issues, try:

```text
--ozone-platform=x11
```

For resize ghosting, stale frame trails, or compositor artifacts after dragging
window borders, try:

```text
--disable-gpu-compositing
```

For native Wayland IME setups, try:

```text
--wayland
--enable-wayland-ime
--wayland-text-input-version=1
```

Restart Codex Desktop after changing this file. Warm-start launches reuse the
running Electron process and will not pick up new flags.

## Oversized Or Blurry UI (HiDPI / Fractional Scaling)

If the whole Codex UI renders far too large (or too small/blurry) inside its
window while other apps scale normally, Electron picked a wrong device scale
factor for your display setup. Chromium computes the scale differently per
backend: under native Wayland it uses the compositor's monitor scale, while
under X11/XWayland it derives the scale from `Xft.dpi` (dpi / 96), `GDK_SCALE`,
and `GDK_DPI_SCALE`. On GNOME Wayland sessions with fractional scaling or
XWayland native scaling enabled, those two views can disagree — the compositor
scales the window buffer and Chromium applies its own scale on top, so the UI
ends up double-scaled (oversized) or unscaled (tiny/blurry).

First inspect what the launcher and your session report:

```bash
./codex-app/start.sh --diagnose-scaling          # local build
/opt/codex-desktop/start.sh --diagnose-scaling   # native package install
```

It prints the session type, scaling-related environment variables, GNOME
`scaling-factor` / `text-scaling-factor`, `Xft.dpi`, monitor layout, and the
exact Electron flags a launch would use.

One-line workarounds (quit the app fully first — warm starts reuse the
running process and ignore new flags):

```bash
# Force a specific device scale factor (1 = unscaled; 1.5, 2, ... also work)
CODEX_FORCE_DEVICE_SCALE_FACTOR=1 codex-desktop

# Force the X11/XWayland backend instead of native Wayland
CODEX_OZONE_PLATFORM=x11 codex-desktop

# Force native Wayland (best for fractional scaling on current GNOME)
CODEX_OZONE_PLATFORM=wayland codex-desktop
```

On GNOME Wayland with more than one monitor, the default `auto` rendering
profile detects connected displays through `/sys/class/drm` and forces the
X11/XWayland backend. This avoids Electron resizing or rescaling the maximized
window when pointer focus crosses to another display. To opt back in to native
Wayland, set `CODEX_OZONE_PLATFORM=wayland` or
`CODEX_LINUX_RENDERING_MODE=default`.

For a local self-build, replace `codex-desktop` with `./codex-app/start.sh`.
Explicit launcher flags (`--x11`, `--wayland`, `--ozone-platform=*`,
`--force-device-scale-factor=*`) always win over these environment variables.

To make the fix persistent, uncomment the matching flag in
`~/.config/codex-desktop/electron-flags.conf`:

```text
--force-device-scale-factor=1
```

or edit the desktop launcher: copy
`/usr/share/applications/codex-desktop.desktop` to
`~/.local/share/applications/` and prepend the variable to the `Exec` line:

```text
Exec=env CODEX_FORCE_DEVICE_SCALE_FACTOR=1 BAMF_DESKTOP_FILE_HINT=... /usr/bin/codex-desktop %u
```

Ubuntu GNOME notes:

- With plain 100% or 200% scaling in Settings → Displays, the defaults work;
  do not force anything.
- Fractional scaling (125%/150%/175%) is a Mutter experimental feature
  (`scale-monitor-framebuffer`). If the UI is oversized there, try
  `CODEX_OZONE_PLATFORM=wayland` first; if it is blurry instead, try
  `CODEX_FORCE_DEVICE_SCALE_FACTOR` matching your monitor scale (e.g. `1.5`).
- On GNOME 47+ the `xwayland-native-scaling` experimental feature changes how
  XWayland apps are scaled; if you enabled it and Codex looks double-scaled
  under `CODEX_OZONE_PLATFORM=x11`, either disable that feature or run the
  app on native Wayland.
- "Large Text" (accessibility) only sets `text-scaling-factor` and affects
  fonts, not the window scale; `--diagnose-scaling` shows both values.

## GNOME/X11 Title Bar Right-click Lockups

On some GNOME/X11 setups, right-clicking the Codex title bar can leave the
desktop input focused on the window-manager menu. Try `Esc` first. `Alt+Space`
opens the same window menu through the keyboard path and can be a safer
workaround while debugging.

If the issue is repeatable, verify whether the installed app is using optional
Linux features:

```bash
if [ -f /opt/codex-desktop/.codex-linux/linux-features-staged.json ]; then
  cat /opt/codex-desktop/.codex-linux/linux-features-staged.json
else
  echo "No staged Linux feature manifest found for this install"
fi
```

Then test the disabled-by-default `frameless-titlebar` feature in a local
checkout:

```bash
cp linux-features/features.example.json linux-features/features.json
python3 - <<'PY'
import json
from pathlib import Path

path = Path("linux-features/features.json")
data = json.loads(path.read_text())
enabled = set(data.get("enabled", []))
enabled.add("frameless-titlebar")
data["enabled"] = sorted(enabled)
path.write_text(json.dumps(data, indent=2) + "\n")
PY
make install-native
```

When opening an issue, include the distro/version, GNOME Shell version,
`XDG_SESSION_TYPE`, package method, Codex Desktop build information, and whether
the lockup happens with `frameless-titlebar` enabled. This path changes the
window controls contract, so it is kept opt-in rather than enabled for all
Linux users.

## Authenticated HTTP Proxies

Chromium does not accept `user:password@` credentials inside the proxy list
passed through `--proxy-server`. Authenticated proxy support is available as
the disabled-by-default `linux-features/authenticated-proxy/` feature; enable
that feature and follow its README for `CODEX_LINUX_PROXY_*`, standard proxy
environment variable, and Flatpak override examples.

## Transparent Or Dark Sidebar

If the left sidebar looks black, translucent, or shows the desktop through it,
first confirm whether the Linux opaque-window patch was applied. This is
usually patch drift rather than a GPU flag issue.

For a native package built by the updater, inspect the latest report:

```bash
python3 - <<'PY'
import json
from pathlib import Path

reports = sorted(Path("~/.cache/codex-update-manager/workspaces").expanduser().glob("*/reports/patch-report.json"))
report = reports[-1]
data = json.loads(report.read_text())
print(report)
for patch in data.get("patches", []):
    if patch.get("name") == "linux-opaque-background":
        print(patch.get("status"), patch.get("reason", ""))
PY
```

If `linux-opaque-background` is `skipped-*`, update this checkout and rebuild
from the same DMG or a fresh one:

```bash
git pull --ff-only
make build-app DMG=~/.cache/codex-update-manager/downloads/Codex.dmg
make package
make install
```

## `/tmp` Mounted `noexec`

Some hardened systems mount `/tmp` with `noexec`, which can prevent the Rust
installer or bundled Node.js runtime from executing.

```bash
mkdir -p ~/tmp/codex-work ~/tmp/codex-cache

export TMPDIR=~/tmp/codex-work
export XDG_CACHE_HOME=~/tmp/codex-cache

# run install steps in this shell
```

## Useful Logs

```bash
sed -n '1,160p' ~/.cache/codex-desktop/launcher.log
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
codex-update-manager status --json
systemctl --user status codex-update-manager.service
```
