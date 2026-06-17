# Codex Desktop Quick Recovery

## 1. Repair the package

Close Codex Desktop, then run:

```bash
sudo /usr/bin/codex-update-manager install-deb --path '/home/trev/.cache/codex-update-manager/workspaces/2026.06.16.213654+1fddf7d0/dist/codex-desktop_2026.06.16.213654+1fddf7d0_amd64.deb'
```

## 2. Confirm it is fixed

```bash
dpkg -s codex-desktop | sed -n '1,12p'
```

You want:

```text
Status: install ok installed
```

## 3. If apt still says the install is broken

```bash
sudo apt --fix-broken install
dpkg -s codex-desktop | sed -n '1,12p'
```

## 4. If Codex Desktop still will not start

Check the launcher log:

```bash
sed -n '1,160p' ~/.cache/codex-desktop/launcher.log
```

Check the updater state:

```bash
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
codex-update-manager status --json
```

Check whether the webview port is already in use:

```bash
ss -tlnp | grep -E '5175|5176'
```

Check Python:

```bash
python3 --version
```

## 5. If the window opens but looks broken

Try:

```bash
CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 /usr/bin/codex-desktop
```

If needed:

```bash
/usr/bin/codex-desktop --disable-gpu
```

## 6. Last resort

Reinstall from the local package in this checkout:

```bash
cd /home/trev/Desktop/comuse/codex-desktop-linux
sudo apt install ./dist/codex-desktop_2026.06.14.165959_amd64.deb
```
