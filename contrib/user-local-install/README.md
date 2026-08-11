# User-Local Desktop Integration

This folder packages a user-local install layout for `codex-desktop-linux`.

It adds:

- a stable install root under `~/.local/opt/codex-desktop-linux`
- self-contained maintenance scripts under `~/.local/opt/codex-desktop-linux/bin`
- thin launch/check/update/version wrappers under `~/.local/bin`
- a desktop entry under `~/.local/share/applications`
- the icon staged by the official Linux package build
- metadata tracking for the wrapper repo and cached official package
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

To also enable the weekly auto-update timer, pass `--enable-timer`:

```bash
./contrib/user-local-install/install-user-local.sh --enable-timer
```

To persistently force the user-local launcher through X11/XWayland, pass `--force-x11`:

```bash
./contrib/user-local-install/install-user-local.sh --force-x11
```

To return to the default generated launcher behavior, pass `--no-force-x11`:

```bash
./contrib/user-local-install/install-user-local.sh --no-force-x11
```

The installer:

1. copies standalone helper scripts into `~/.local/opt/codex-desktop-linux`
2. installs thin wrappers into `~/.local/bin`
3. copies systemd unit files to `~/.config/systemd/user/`
4. makes the scripts executable
5. reloads the user `systemd` daemon if available
6. enables the weekly timer only if `--enable-timer` was passed
7. refreshes desktop metadata if available
8. records local metadata and refreshes the staged icon when available

## Commands

After installation:

```bash
codex-desktop
codex-desktop-check-update
codex-desktop-update
codex-desktop-version
```

## Notes

- The icon is taken from the generated app, with the repository Linux icon as a fallback.
- The helper scripts track both wrapper changes and official Linux package headers.
- The helper scripts are copied into `~/.local/opt` and do not run from the git checkout directly.
- The X11/XWayland preference is stored in `~/.config/codex-desktop-linux/user-local.env` and is preserved across updater refreshes.
- The weekly timer runs `codex-desktop-update --quiet`. It is opt-in: pass `--enable-timer` to `install-user-local.sh` to activate it, or run `systemctl --user enable --now codex-desktop-update.timer` manually after install.
- Automated rebuilds never bypass the running-app or upstream-package acceptance gates. They may build a candidate while ChatGPT Desktop is open, but promotion waits for the in-app after-exit flow or fails safely for a manual/timer run. Retry after closing the app.
- A successful transactional update retains only the immediately previous app backup. Older exact managed backups are pruned; manually named paths, files, and symlinks are left alone.
