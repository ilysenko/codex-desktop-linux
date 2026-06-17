# Codex Desktop Recovery Notes

This note is for the package-repair problem found on June 17, 2026.

## Main Repair

Close Codex Desktop first, then run:

```bash
sudo /usr/bin/codex-update-manager install-deb --path '/home/trev/.cache/codex-update-manager/workspaces/2026.06.16.213654+1fddf7d0/dist/codex-desktop_2026.06.16.213654+1fddf7d0_amd64.deb'
```

If that succeeds, verify the package state:

```bash
dpkg -s codex-desktop | sed -n '1,12p'
```

Expected result:

```text
Status: install ok installed
```

If the package manager still reports a broken install, run:

```bash
sudo apt --fix-broken install
```

Then check again:

```bash
dpkg -s codex-desktop | sed -n '1,12p'
```

## If Codex Desktop Still Does Not Start

First try opening it again normally after the package repair.

If it still does not open, check these four things.

### 1. Check the launcher log

```bash
sed -n '1,160p' ~/.cache/codex-desktop/launcher.log
```

This is the first place to look for:

- splash screen stuck
- blank window
- webview port problems
- Python startup problems

### 2. Check the updater log

```bash
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
codex-update-manager status --json
```

This helps if the app repaired correctly but the updater is still confused
about a pending install.

### 3. Check whether the webview port is already busy

```bash
ss -tlnp | grep -E '5175|5176'
```

If something else is already using that port, Codex Desktop may hang on the
logo splash or fail to load its internal page.

### 4. Try launching again after confirming Python is available

```bash
python3 --version
```

The launcher depends on `python3` for the local webview server.

## If The Window Opens But Looks Broken

If the app opens but you get rendering glitches, try one of these:

```bash
CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 /usr/bin/codex-desktop
```

If that is not enough:

```bash
/usr/bin/codex-desktop --disable-gpu
```

## Last Resort

If the repair command succeeds but the app still behaves badly, reinstall from
the package already present in this checkout:

```bash
sudo apt install ./dist/codex-desktop_2026.06.14.165959_amd64.deb
```

After that, re-check:

```bash
dpkg -s codex-desktop | sed -n '1,12p'
```

## Useful Files

- `~/.cache/codex-desktop/launcher.log`
- `~/.local/state/codex-update-manager/service.log`
- `~/.local/state/codex-update-manager/state.json`
- `/home/trev/Desktop/comuse/codex-desktop-linux/dist/`
