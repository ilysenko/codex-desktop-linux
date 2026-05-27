# Live Validation Matrix

This matrix defines the redacted evidence format for live Linux validation.
It covers desktop-environment behavior and Secret Service/keyring behavior
without recording private windows, browser state, session contents, key
material, or filesystem details.

Live results are not committed by default. A maintainer may add a dated,
redacted result only after checking it against the allowed fields below.

## Status Vocabulary

| Status | Meaning |
|---|---|
| `pass` | Live check succeeded on that host profile. |
| `warn` | Live check ran but a non-blocking backend or setup issue remains. |
| `fail` | Live check ran and found a blocking issue. |
| `skip` | Live check was intentionally not run on that host profile. |
| `pending` | No redacted live evidence has been captured yet. |

## Desktop Environment Matrix

| Desktop family | Session target | Window backend evidence | Input evidence | Current live evidence |
|---|---|---|---|---|
| GNOME | Wayland/X11 | backend family, exact-focus capability, blocker count | abs-pointer/portal/ydotool booleans | pending |
| KDE Plasma / KWin | Wayland/X11 | backend family, exact-focus capability, blocker count | abs-pointer/portal/ydotool booleans | pending |
| COSMIC | Wayland | backend family, exact-focus capability, blocker count | abs-pointer/portal/ydotool booleans | pending |
| Hyprland | Wayland | backend family, exact-focus capability, blocker count | abs-pointer/portal/ydotool booleans | pending |
| Sway | Wayland | backend family, exact-focus capability, blocker count | abs-pointer/portal/ydotool booleans | fixture-covered; live pending |
| i3 | X11 | backend family, exact-focus capability, blocker count | ydotool boolean | pending |
| Generic X11 | X11 | global-input-only marker, blocker count | ydotool boolean | unsupported for targeted window input |

## Secret Service / Keyring Matrix

| Provider family | Desktop target | Evidence allowed | Current live evidence |
|---|---|---|---|
| GNOME Keyring | GNOME or compatible sessions | provider hint booleans, canary status, issue kind, round-trip booleans | pending |
| KWallet | KDE Plasma or compatible sessions | provider hint booleans, canary status, issue kind, round-trip booleans | pending |
| KeePassXC Secret Service | Any compatible session | provider hint booleans, canary status, issue kind, round-trip booleans | pending |
| Headless or no session bus | Any | session-bus boolean and sanitized issue kind only | pending |
| Locked or prompt-cancelled keyring | Any | sanitized `locked_or_cancelled` issue kind only | pending |

## Allowed Evidence Fields

Desktop evidence may include only:

- `date`
- `distroFamily`
- `desktopFamily`
- `sessionType`
- `windowBackend`
- `exactFocusSupported`
- `screenshotPathAvailable`
- `inputBackends`: boolean flags for `absPointer`, `portal`, and `ydotool`
- `blockerCount`
- `status`
- `notes`: short setup notes without names, paths, screenshots, or app content

Secret Service evidence may include only:

- `date`
- `desktopFamily`
- `sessionBus`
- `providerHints`: boolean flags for `gnomeKeyring`, `kwallet`, and `keepassxc`
- `secretToolAvailable`
- `canaryStatus`
- `issueKind`
- `storeAttempted`
- `lookupMatched`
- `clearAttempted`
- `clearSucceeded`
- `status`

## Forbidden Evidence

Do not record:

- window titles, application names, accessibility trees, screenshots, or OCR text
- browser profile names, tab titles, URLs, cookies, tokens, or extension payloads
- QR codes, pairing codes, private keys, key IDs, raw keyring attributes, or raw
  `secret-tool` output
- raw doctor JSON, raw app-server output, private conversation content, thread
  IDs, plugin IDs, MCP resource text/blob payloads, model names, feature names,
  permission profile IDs, or collaboration mode names
- absolute user filesystem paths or file contents

## Commands

Run these checks locally and summarize only the allowed fields:

```bash
codex-desktop-doctor --readiness --json
codex-desktop-doctor --capability-gaps --json
make parity-full
make parity-secret-service-live
```

For Secret Service/keyring-only validation, use:

```bash
CODEX_DESKTOP_LIVE_SECRET_SERVICE_MATRIX=1 \
python3 scripts/secret-service-matrix-smoke.py --live --json
```

## Redacted Result Template

```json
{
  "date": "YYYY-MM-DD",
  "desktop": {
    "distroFamily": "debian|fedora|arch|nixos|opensuse|other|unknown",
    "desktopFamily": "gnome|kde|cosmic|hyprland|sway|i3|x11|other|unknown",
    "sessionType": "wayland|x11|unknown",
    "windowBackend": "gnome|kwin|cosmic|hyprland|sway|i3|global-input-only|unknown",
    "exactFocusSupported": false,
    "screenshotPathAvailable": false,
    "inputBackends": {
      "absPointer": false,
      "portal": false,
      "ydotool": false
    },
    "blockerCount": 0,
    "status": "pass|warn|fail|skip|pending",
    "notes": "No private app, window, browser, file, or session content."
  },
  "secretService": {
    "desktopFamily": "gnome|kde|cosmic|hyprland|sway|i3|other|unknown",
    "sessionBus": false,
    "providerHints": {
      "gnomeKeyring": false,
      "kwallet": false,
      "keepassxc": false
    },
    "secretToolAvailable": false,
    "canaryStatus": "pass|warn|fail|skip|pending",
    "issueKind": "none|tool_missing|provider_unavailable|locked_or_cancelled|headless|timeout|lookup_mismatch|unknown",
    "storeAttempted": false,
    "lookupMatched": false,
    "clearAttempted": false,
    "clearSucceeded": false,
    "status": "pass|warn|fail|skip|pending"
  }
}
```
