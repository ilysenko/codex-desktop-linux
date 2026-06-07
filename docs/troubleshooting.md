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
| Window flickering | Try `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 ./codex-app/start.sh`, then `./codex-app/start.sh --disable-gpu` if needed |
| Sandbox errors | The launcher already sets `--no-sandbox` |
| Stale install / cached DMG | `make build-app-fresh` removes the generated app and cached DMG, then downloads current upstream |
| Computer Use plugin invisible in UI | Enable the Computer Use UI opt-in; upstream server/account rollout can still hide some controls |
| Computer Use `doctor` reports no input backend | Grant `/dev/uinput`, enable XDG RemoteDesktop portal, or start `ydotoold` / `ydotool.service` |
| Computer Use `doctor` reports `ydotool_socket: Permission denied` | Adjust the daemon socket so users in the `input` group can use it |
| `ConnectTimeoutError` for Electron headers | Re-run `make build-app`; the installer uses `https://artifacts.electronjs.org/headers/dist` by default |
| Computer Use AT-SPI tree empty | Run `codex-computer-use-linux setup`, then restart the target app |
| `codex-update-manager` keeps running after package removal | Run `systemctl --user disable --now codex-update-manager.service` and confirm `/opt/codex-desktop` is gone |

## Persistent Launch Flags

The launcher creates `~/.config/codex-desktop/electron-flags.conf` on first
cold start. Uncomment one flag per line; blank lines and lines starting with
`#` are ignored. Existing files are never overwritten.

For KDE/Wayland rendering issues, try:

```text
--ozone-platform=x11
```

For native Wayland IME setups, try:

```text
--wayland
--enable-wayland-ime
--wayland-text-input-version=1
```

Restart Codex Desktop after changing this file. Warm-start launches reuse the
running Electron process and will not pick up new flags.

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
