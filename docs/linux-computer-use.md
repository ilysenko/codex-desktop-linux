# Linux Computer Use

Linux Computer Use is an opt-in UI surface backed by a native Rust MCP backend,
`codex-computer-use-linux`. The official Linux package is the baseline, and the
community integration is disabled until the `computer-use-linux` feature is
explicitly enabled. Enabling it stages the native backend and feature-owned UI
patches; none are default core patches. In Settings → Computer use, **Any App**
controls native access independently of browser access. Use that row to install
or enable native access on a fresh profile.

The backend's capabilities are listed below. The in-app API exposes a subset;
see [supported operations](../linux-features/computer-use-linux/README.md#supported-operations)
for its limitations.

It supports:

- app listing and accessibility trees through AT-SPI
- screenshots through GNOME Shell DBus, the Codex GNOME Shell extension, or XDG Desktop Portal
- window listing and focusing on GNOME, KWin/Plasma 5 and 6, Hyprland, Niri,
  COSMIC, i3, and generic X11/EWMH window managers; GNOME extension and X11
  windows can also be moved and resized
- keyboard, text, click, scroll, and drag input through `/dev/uinput`, XDG
  RemoteDesktop portal, `xdotool` on X11, or `ydotool`
- pointer-direction feedback for the built-in V2 pet after successful click,
  scroll, and drag actions

## Runtime Dependencies

Install `ydotool` 1.0.3 or newer when you need the fallback input path. The
backend probes the exact absolute move, wheel move, click, delayed key, and
stdin typing command shapes it emits. Earlier or incompatible CLIs are rejected
even if `ydotoold` and its socket are present.

```bash
# Debian / Ubuntu
sudo apt install ydotool
sudo apt install ydotoold   # on Ubuntu releases that split the daemon

# Fedora
sudo dnf install ydotool

# Arch / Manjaro
sudo pacman -S ydotool

# openSUSE
sudo zypper install ydotool
```

The preferred coordinate input path opens `/dev/uinput` directly, but that
device provides pointer input only. Keyboard readiness still requires an XDG
RemoteDesktop portal with keyboard support, `xdotool` on X11, or a compatible
`ydotool` daemon and socket. Portal pointer support also requires the
RemoteDesktop pointer methods, a monitor-capable ScreenCast source, and the
matching advertised device types. ScreenCast v2 and newer must also advertise
the hidden cursor mode that the runtime requests; v1 uses that mode by default.

For `ydotool`, run a daemon and make sure your user can access the socket:

```bash
sudo systemctl enable --now ydotoold
sudo usermod -a -G input "$USER"
```

Then log out and back in.

On X11, install `xdotool` for layout-correct XTEST keyboard/text input and
coordinate clicks, and `wmctrl` plus `xprop` for generic EWMH window listing,
focus, move, and resize. `xdotool` is preferred only with a nonempty `DISPLAY`;
ydotool is used when it cannot be launched. Once xdotool starts, a failure or
timeout is returned and input is never replayed through ydotool. Override
keyboard selection with `COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD=1` or
`CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD=1`; the corresponding
`*_FORCE_XDOTOOL_KEYBOARD=1` names force XTEST when available. Set
`COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER=1` or
`CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER=1` to skip native-X11 xdotool clicks.

Some distros name the unit `ydotool.service` instead of `ydotoold.service`, and
some install `/usr/bin/ydotoold` without a service unit. If the system unit path
is awkward, a user-session service that binds `%t/.ydotool_socket` is also
valid.

Portal packages are needed when your desktop relies on XDG Desktop Portal input
or screenshots:

- KDE Plasma: `xdg-desktop-portal-kde`
- sway/wlroots: `xdg-desktop-portal-wlr`
- Hyprland: `xdg-desktop-portal-hyprland`
- GNOME: usually available by default

`doctor` evaluates pointer and keyboard portal capability independently. A
keyboard-only or pointer-only RemoteDesktop implementation remains useful when
its supported modality is complete, but pointer-only support does not make
keyboard readiness green.

Niri window listing and exact focus use the `niri` command and the active
session's `NIRI_SOCKET`. The Computer Use backend hydrates `NIRI_SOCKET` for GUI
starts, but the socket must still belong to the active Niri session and be
reachable by the desktop user.

The former `x11-ewmh-computer-use` alternative has been retired. The retained
`computer-use-linux` backend owns generic X11/EWMH support on both official
architectures, so the x86-only duplicate no longer belongs in package builds.

## Verify Readiness

After enabling `computer-use-linux`, rebuilding, and reinstalling ChatGPT
Community, ask Codex:

> Check whether Linux Computer Use is ready

You can also run the backend directly:

```bash
./codex-app/resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux doctor
./codex-app/resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux setup
./codex-app/resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux apps
./codex-app/resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux windows
./codex-app/resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux screenshot
```

## Enable The In-App UI

Use the optional-feature wizard and enable `computer-use-linux`:

```bash
make setup-native
make install-native
```

Or edit the gitignored feature configuration directly:

```bash
cp -n linux-features/features.example.json linux-features/features.json
# Add "computer-use-linux" to the enabled array, then:
make install-native
```

`make install-native` builds the required `codex-computer-use-linux` and
`codex-computer-use-cosmic` release helpers once before staging the app.
Updater rebuilds consume those retained prebuilt helpers rather than compiling
Rust for every OpenAI package update. To opt out, remove the feature ID and
rebuild/reinstall.

Nix:

```bash
nix run github:ilysenko/codex-desktop-linux#codex-desktop-computer-use-ui
```

Combined with a Linux feature output:

```bash
nix run github:ilysenko/codex-desktop-linux#codex-desktop-computer-use-ui-remote-mobile-control
```
