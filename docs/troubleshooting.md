# Troubleshooting

| Problem | Solution |
|---|---|
| `Error: write EPIPE` | Run `start.sh` directly instead of piping output |
| Blank window | Check whether the configured webview port is already in use: `ss -tlnp \| grep -E '5175\|5176'` |
| `ERR_CONNECTION_REFUSED` on the webview port | Ensure `python3` works and the configured port is free |
| Stuck on Codex logo splash | Check `~/.cache/codex-desktop/launcher.log`; another process may be serving the webview port |
| `CODEX_CLI_PATH` error | Reopen the app to retry automatic CLI install, or install manually with `npm i -g @openai/codex` / `npm i -g --prefix ~/.local @openai/codex` |
| `nix run` exits with no window or terminal output | Check `~/.cache/codex-desktop/launcher.log`; the Nix package still requires a user-provided `codex` CLI |
| `gh auth status` works in terminal but fails inside Codex Desktop | See [GitHub CLI auth in app-launched shells](github-cli-auth.md) |
| Electron hangs while CLI is outdated | Re-run the launcher and check `~/.cache/codex-desktop/launcher.log` plus `~/.local/state/codex-update-manager/service.log` |
| GPU / Vulkan / Wayland errors | Try `CODEX_LINUX_RENDERING_MODE=wayland-gpu ./codex-app/start.sh` or persistent launch flags below |
| Window flickering, resize ghosting, or stale frame trails | Try `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 ./codex-app/start.sh`, then `./codex-app/start.sh --disable-gpu` if needed |
| Transparent or dark left sidebar | Check whether the Linux opaque-window patch was applied, then rebuild with a current checkout |
| Sandbox errors | The launcher already sets `--no-sandbox` |
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
