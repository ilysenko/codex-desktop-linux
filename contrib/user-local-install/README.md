# User-Local Desktop Integration

This folder packages a user-local install layout for `codex-desktop-linux`.

It adds:

- a stable install root under `~/.local/opt/codex-desktop-linux`
- self-contained maintenance scripts under `~/.local/opt/codex-desktop-linux/bin`
- thin launch/check/update/version wrappers under `~/.local/bin`
- a desktop entry under `~/.local/share/applications`
- an icon extracted from the selected local app installer
- metadata tracking for the wrapper repo and selected app installer
- an optional weekly `systemd --user` timer for unattended update checks and rebuilds (opt-in)

## Files

The package is laid out as reusable payload files. The installer copies them into:

- `~/.local/opt/codex-desktop-linux/bin/`
- `~/.local/opt/codex-desktop-linux/lib/codex-desktop-linux/`
- `~/.local/bin/` wrappers
- `files/.local/share/applications/codex-desktop.desktop`
- `files/.config/systemd/user/codex-desktop-update.service`
- `files/.config/systemd/user/codex-desktop-update.timer`

## Expected Placement

If installing manually, copy the files to:

- `~/.local/opt/codex-desktop-linux/bin/`
- `~/.local/opt/codex-desktop-linux/lib/codex-desktop-linux/`
- `~/.local/bin/` wrappers that exec into `~/.local/opt/codex-desktop-linux/bin/`
- `~/.local/share/applications/`
- `~/.config/systemd/user/`

The preferred git checkout location is:

- `~/workspace/codex-desktop-linux`

The installed maintenance scripts record the repo path in user state and use that checkout for `git pull`, while rebuilding runtime assets into `~/.local/opt/codex-desktop-linux` via `CODEX_INSTALL_ROOT` / `CODEX_INSTALL_DIR`.

## Install

From the repository root:

```bash
./contrib/user-local-install/install-user-local.sh
```

To opt into preview:

```bash
./contrib/user-local-install/install-user-local.sh --track preview
```

`preview` uses the public Codex Desktop beta appcast and records the preview release track for CLI-aware update flows.

To also enable the weekly auto-update timer, pass `--enable-timer`:

```bash
./contrib/user-local-install/install-user-local.sh --enable-timer
```

The installer:

1. copies standalone helper scripts into `~/.local/opt/codex-desktop-linux`
2. installs thin wrappers into `~/.local/bin`
3. copies systemd unit files to `~/.config/systemd/user/`
4. makes the scripts executable
5. reloads the user `systemd` daemon if available
6. enables the weekly timer only if `--enable-timer` was passed
7. refreshes desktop metadata if available
8. records local metadata and extracts the icon if the selected installer cache exists

## Commands

After installation:

```bash
codex-desktop
codex-desktop-check-update
codex-desktop-update
codex-desktop-version
```

## Notes

- The icon is not committed as a binary asset here. It is generated locally from the selected app installer.
- The selected track is recorded in `~/.local/state/codex-desktop-linux/install.env` as `CODEX_RELEASE_TRACK=stable` or `CODEX_RELEASE_TRACK=preview`.
- The helper scripts track both upstream wrapper changes and selected upstream app metadata.
- The helper scripts are copied into `~/.local/opt` and do not run from the git checkout directly.
- The weekly timer runs `codex-desktop-update --quiet`. It is opt-in: pass `--enable-timer` to `install-user-local.sh` to activate it, or run `systemctl --user enable --now codex-desktop-update.timer` manually after install.
