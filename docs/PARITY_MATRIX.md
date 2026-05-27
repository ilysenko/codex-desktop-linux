# Codex Desktop Linux Parity Matrix

This project is an unofficial Linux build of Codex Desktop. The goal is
closest-possible daily-driver parity with the upstream desktop app while staying
honest about official platform, account, and operating-system boundaries.

Last reviewed: 2026-05-26.

## Official Boundaries

- OpenAI documents `codex app` as the desktop app launcher for official desktop
  platforms, and `codex app-server` as the local protocol surface for rich
  clients.
- OpenAI's mobile setup docs currently say mobile access requires Codex App for
  macOS. The same page says the connected host supplies repo files, shell,
  plugins, MCP servers, skills, browser access, and Computer Use.
- OpenAI's locked Computer Use path is macOS-specific. It uses an Apple
  authorization plug-in in the macOS unlock flow, so Linux cannot claim the
  same implementation.

Primary references:

- <https://developers.openai.com/codex/cli/reference#command-overview>
- <https://developers.openai.com/codex/app-server>
- <https://developers.openai.com/codex/remote-connections>
- <https://developers.openai.com/codex/app/computer-use#locked-use>
- <https://developers.openai.com/codex/config-reference>

## Validation Commands

Run the local checks from the repo root:

```bash
make doctor
make parity-schema
make parity-browser-matrix
make parity-browser-live
make parity-services
make parity-smoke
make parity-full
```

For an enrolled remote-control host, require connected remote status:

```bash
CODEX_PARITY_REQUIRE_REMOTE_CONNECTED=1 make parity-full
```

For strict installed parity, require a local Electron CDP origin and fail on
skipped components:

```bash
CODEX_DESKTOP_CDP_ORIGIN=http://127.0.0.1:9334 make parity-strict
```

For optional Electron UI presence checks, launch a local debug-port instance
yourself and pass only the local CDP origin:

```bash
CODEX_DESKTOP_CDP_ORIGIN=http://127.0.0.1:9334 make parity-full
```

Do not save or paste QR codes, device keys, cookies, browser tab titles/URLs,
screenshots, or private conversation text into parity artifacts.

## Matrix

| Area | Mac baseline | Linux status | Validation | Gap / next step |
|---|---|---|---|---|
| Desktop UI | Official Codex Desktop app | Repackaged Electron app from upstream DMG | `make doctor`, optional CDP path in `make parity-full`, required CDP path in `make parity-strict` | Not official Linux support |
| CLI bridge | `codex app` launches app | Launcher wraps Linux Electron app and discovers CLI | `make doctor` | Keep CLI path/preflight covered during updates |
| App-server protocol | Local app protocol | `codex app-server` used directly by smoke tests | `make parity-schema`, `make parity-smoke` | Track schema drift on each upstream refresh |
| Thread history | Native app reads local sessions | App-server thread list/read surface is present | `make parity-smoke` | Avoid printing thread names/content in logs |
| Plugins and marketplace | Built-in app support | Plugin list and bundled marketplace cache present, plus isolated install/uninstall coverage against a temporary `CODEX_HOME` and synthetic local marketplace | `make parity-smoke`, `make doctor` | Keep mutating plugin checks isolated from real user state |
| Apps/connectors | Built-in app support | App list surface present | `make parity-smoke` | Account/workspace gating remains server-side |
| MCP servers | Built-in app support | MCP status API plus session-scoped live MCP fixture, no-op tool-call coverage, and non-mutating text/blob resource-read coverage through an ephemeral thread | `make parity-smoke`, `make parity-schema` | Add broader MCP coverage only when it stays fixture-only and non-mutating |
| Skills | Built-in app support | Skills list API plus repo-scoped fixture discovery present | `make parity-smoke` | Add skill enable/disable fixture later |
| Config and requirements | User, repo, and managed config | Config/read validates a repo-scoped project config fixture; requirements/read surface plus isolated `/etc/codex/requirements.toml` fixture when `bwrap` is available | `make parity-smoke`, `make parity-schema` | Expand policy-shape coverage as upstream requirements fields change |
| External agent import | Detect/import agent artifacts | Detect surface plus temporary CLAUDE.md and MCP config fixture detection present; import remains untouched by smoke | `make parity-smoke`, `make parity-schema` | Add safe no-op import validation only if upstream exposes a dry-run mode |
| Browser Use | Browser bridge and extension | Chrome/Brave/Chromium native messaging plus Flatpak wrapper, opt-in redacted live browser/profile validation, and isolated native-host bridge loopback | `make doctor`, `make parity-full`, `make parity-browser-matrix`, `make parity-browser-live` | Add deeper live extension request/turn-completion checks only if they stay redacted |
| Chrome Flatpak | macOS not applicable | Flatpak host wrapper via `flatpak-spawn --host` | `make doctor` | Keep manifest/path regression tests |
| Computer Use backend | Native Computer Use | Linux MCP backend with AT-SPI, screenshots, window targeting, and input synthesis, including fixture-covered Sway `swaymsg` window support | `make parity-full`, Rust windowing tests | Add live desktop-environment matrix validation |
| Computer Use UI | Native UI | Opt-in Linux UI gate | `make doctor`, manual UI check | Keep opt-in; do not force Statsig-like UI gates globally |
| Locked Computer Use | Apple authorization plug-in on macOS | Not equivalent | `docs/LOCKED_COMPUTER_USE_RESEARCH.md` | Research only; do not fake remote unlock |
| Mobile remote-control host | Official macOS setup | Experimental Linux feature removes local macOS-only blockers | `CODEX_PARITY_REQUIRE_REMOTE_CONNECTED=1 make parity-full` checks explicit status read plus status notification | Server-side rejection can still happen |
| Remote-control key storage | macOS keychain/Secure Enclave-style boundary | App-id scoped Secret Service via `secret-tool` when available, with `0600` file fallback and sanitized locked/provider/headless doctor classifications | `make doctor` reports helper availability, coarse canary issue kind, and metadata/fallback counts only; `make parity-secret-service-live` runs an opt-in redacted live keyring canary | Exercise the live canary across more desktop keyring implementations |
| Services | App/update lifecycle integrated with OS | `systemd --user` app and updater units with static lifecycle marker coverage | `make doctor`, `make parity-services`, `make parity-full` | Add live suspend/resume and network-change regression tests |
| Auto-update | Upstream desktop updates | Local updater rebuilds native package from newer DMG | `make doctor`, CI package builds | Update-builder runs the app-server schema guard during local rebuilds; keep failure logs actionable |
| Native packages | Official platform installers | `.deb`, `.rpm`, pacman, AppImage, Nix | GitHub CI, `make package` | Keep distro matrix green |
| Nix | Not a primary Mac path | Flake outputs and feature variants | GitHub CI Nix job | Keep upstream hash refresh bot green |
| AppImage | Not a Mac path | Manual self-build | `make appimage` | No resident updater by design |
| Enterprise controls | Config/requirements support | Requirements API surface plus isolated `/etc/codex/requirements.toml` fixture when `bwrap` is available | `make parity-smoke`, `make parity-schema` | Skip safely when mount namespaces are unavailable |
| Security posture | Official app trust model | Local wrapper, updater, scripts, and experimental features | `make doctor`, code review | Threat-model remote/mobile and key handling before deeper unlock work |

## Reusable Prior Art

- OpenAI app-server schemas and TypeScript bindings:
  `codex app-server generate-json-schema` and `codex app-server generate-ts`.
- Linux Computer Use primitives:
  <https://github.com/agent-sh/computer-use-linux>.
- Other Linux desktop wrapper prior art:
  <https://github.com/better-slop/codex-app-linux>.
- App-server bridge prior art:
  <https://github.com/siddheshkothadi/codex-app-server> and
  <https://github.com/mideco-tech/codex-tg>.
- ACP adapter prior art:
  <https://github.com/beyond5959/acp-adapter> and <https://zed.dev/acp>.
- Chrome native messaging:
  <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>.
- Flatpak host spawning:
  <https://docs.flatpak.org/en/latest/flatpak-command-reference.html>.
- XDG Desktop Portal RemoteDesktop:
  <https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html>.
- ydotool/uinput:
  <https://github.com/ReimuNotMoe/ydotool>.
- Linux Secret Service:
  <https://specifications.freedesktop.org/secret-service/latest-single/>.

## Work Queue

1. Keep `make parity-full` passing on the installed app.
2. Keep safe fixture tests for managed requirements and MCP server behavior
   aligned with upstream app-server behavior.
3. Extend the phone/remote-control E2E check beyond host connected state only
   when it can still record only connected/disconnected state and redacted
   booleans.
4. Run `make parity-secret-service-live` across GNOME Keyring, KWallet, locked
   keyrings, and headless sessions, and capture only the redacted pass/warn
   matrix.
5. Add opt-in live service lifecycle checks for suspend/resume and network
   changes once they can run without disrupting an active desktop session.
6. Expand live desktop-environment validation for GNOME, KDE Plasma, Hyprland,
   Sway, COSMIC, X11, and browser combinations.
7. Research locked-use equivalents separately and require a threat model before
   writing any unlock/session-control code.
