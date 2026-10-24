# Linux Computer Use

Linux Computer Use is an opt-in UI surface backed by a native Rust MCP backend,
`codex-computer-use-linux`. The official Linux package is the baseline, and the
community integration is disabled until the `computer-use-linux` feature is
explicitly enabled. Enabling it stages the Linux backend/plugin and the
feature-owned UI descriptors; none of them are default core patches.

In Settings → Computer use, **Any App**
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

The in-app adapter returns a compact accessibility projection and suppresses an
unchanged compact projection on repeated reads. Use `disableDiffing: true` for a
fresh compact tree, or `compact: false` for complete backend metadata.
`maxNodes`/`maxDepth` bound accessibility traversal; screenshot calls accept
`maxWidth`, `maxHeight`, `maxBytes`, `scale`, `format`, and `quality`. Screenshot
methods already emit the image and should not be emitted a second time.

X11 xdotool text dispatch warns that non-US XKB layouts (reported with Brazilian `br`/ABNT2) or changing keymap state can silently substitute symbols even with `ok: true`. The backend monitors XKB layout replacements, persistent mapping/group changes, keyboard grabs, and focus transitions across each dispatch. A detected change returns an error after text may already have been sent; input is never replayed. If monitoring cannot start, dispatch still proceeds with an explicit warning that layout and interception detection are unavailable. These guards do not prove field contents or detect every stable-map loss. Inspect the actual text before pressing Enter, submitting it, or treating it as delivered. Use `include_tree: true` when AT-SPI exposes the text, or `screenshot_after: true`; neither automatically compares the field with the request. Do not retry blindly.

PointerRoot focus cannot be monitored because pointer motion can redirect
keyboard input without a focus event. It follows the same single-dispatch path
with an explicit monitoring warning. A no-fixed-focus session can still dispatch
without that PointerRoot warning.

The embedded backend tracks Computer Use 0.7.24. WebKitGTK AT-SPI socket children are resolved through their well-known bus names, and bounded indexed action reads avoid stalled `GetActions` calls. Native action matching uses stable machine-readable `GetName` values, including for Qt controls. Failed desktop actions and intentional refusals map to MCP `isError: true`; a successful action remains successful when only its post-action observation fails.

MCP discovery probes are supported before initialization, including metadata-bearing discovery requests. Agent activity appears through the native GNOME indicator or the Wayland overlay helper. Captures hide the indicator before reading the screen. Portal captures clean new Pictures files and preserve existing images. Set `CODEX_COMPUTER_USE_INDICATOR=0` to disable action indicators; capture exclusion remains active. GNOME extension version 3 supports Shell 45 through 51. Existing Shell sessions need a logout and login to load refreshed extension files.

## Runtime Dependencies

After semantic target recovery, cached indices are invalidated. Observe a fresh
`get_app_state` result before using `element_index` again. Recovery retains the
original process identity or verifies an observed exact window against its PID;
name-only matches cannot rebind an app after its owner disappears.

The embedded backend supports scoped AT-SPI trees and native actions, compositor
window targeting, keyboard and pointer input backends, and bounded screenshots. Setup verifies
GNOME's saved toolkit-accessibility key even when
runtime AT-SPI is ready, and warns when the saved key cannot be verified.
Other accessibility tools can change the key later; setup does not hold it on.

`get_app_state` returns screenshots as a structured image content block followed
by the JSON report. The JSON `screenshot` value contains dimensions, scale,
format, and byte counts without an inline base64 `data_url`; callers should read
the image block for pixels. Mutating tools (`click`, `type_text`, `press_key`,
`scroll`, `drag`, `perform_action`, `set_value`, `activate_window`,
`move_window`, and `resize_window`) also accept optional `screenshot_after`
(`true`, `"screen"`, or `"window"`) and `include_tree=true` to return
post-action observation in the same result.

`doctor` reports an XDG portal interface only when the portal exports its
methods: Screenshot needs `Screenshot`, ScreenCast needs `CreateSession`,
`SelectSources`, and `Start`, and InputCapture needs `GetZones`, `Enable`, and
`ConnectToEIS`. `busctl introspect` exits 0 with only a header line for a
missing interface, so exit status alone was a false positive. Readiness reports
`can_capture_screenshots` and a blocker when no screenshot route is detected;
that is detection, not a test capture.

On a native X11 session (never XWayland), screenshots can use one root-window
`GetImage` after GNOME Shell, the Codex GNOME Shell extension, and the portal,
and before `gnome-screenshot`. Pixels are device pixels, the space xdotool input
uses. `doctor` reports it as `platform.x11_display` and the `x11`
screenshot capability; `CODEX_COMPUTER_USE_SCREENSHOT_BACKEND=x11` pins it.
X11/EWMH window origins come from the X server instead of `wmctrl -lG`, which
counts the frame offset twice, so window crops and relative clicks line up
with the client area.

Native X11 connections and replies share a transport deadline; a stalled server
closes the query connection instead of leaving a blocked worker behind. Unix
sockets, literal IP addresses, and `localhost` need no resolver helper. A remote
hostname in `DISPLAY` requires `getent ahosts` for bounded name resolution;
missing or failed resolution reports the X11 route as unavailable.

Element-targeted `click` and `scroll` refuse an `element_index` from another
app's `get_app_state` snapshot and ask for a snapshot of the target. On GNOME
Wayland with a scaled monitor, portal pointer input multiplies the stream point
by the monitor scale, matching mutter's logical layout mode. After targeted
typing, focus feedback reports an incomplete search or an app without an AT-SPI
tree instead of a false "no focused element" warning.

On Wayland, portal `press_key` sends modifiers and named keys as keysyms
resolved by the compositor's active keymap, so Ctrl shortcuts still work when
Caps Lock and Control are swapped. Letters and digits retain physical US
keycodes so shortcuts also work under non-Latin layouts. KDE Plasma retains
physical keycodes for all portal chords.

On X11, `type_text` keeps xdotool's 12 ms per-character delay so XTEST events
stay ordered. `CODEX_COMPUTER_USE_XDOTOOL_TYPE_DELAY_MS` overrides it; the
standalone `COMPUTER_USE_LINUX_XDOTOOL_TYPE_DELAY_MS` name remains an alias.

For an explicit foreground hold-open, run `codex-computer-use-linux guard-accessibility`.
It holds a passive AT-SPI listener and watches/reasserts the saved toolkit setting
for the current user. It is never started by MCP, setup, or observation. Stop
with Ctrl-C or SIGTERM before disabling accessibility. Stop cancels pending
work and releases the listener without disabling other clients or restoring
an old setting. Applications launched during a reset/reassertion interval may
still need restarting.

Scope `get_app_state` with `app_name_or_bundle_identifier` or a window target
(`window_id`, `pid`, `app_id`, `wm_class`, `title`). Without one it returns the
whole desktop AT-SPI tree, reports `tree_scoped=false`, and appends a warning to
`message`, which can exhaust a small context window. `app_id` matching is
case-insensitive and accepts a full reverse-DNS desktop ID or its final
dot-separated segment. Exact matches take precedence, ambiguous aliases are
rejected, and an unresolved explicit `app_id` returns an empty scoped tree
rather than falling back to the desktop. `accessibility_tree_truncated=true`
means the node, depth, or read budget stopped traversal with unread elements
left; recover by scoping to a narrower target and raising `max_nodes` or
`max_depth` (hard caps 2000 and 64), not by lowering `max_nodes`.

Plain left element/selector clicks prefer a native AT-SPI `click`, `press`, or
`toggle` action, resolved by name against the live action list. Entry `activate`
and slider `jump` actions are not substituted for pointer clicks. This avoids guessing a
GTK toolkit-to-pointer scale. Explicit coordinates, right clicks, and multiple
clicks retain pointer semantics. Relative coordinates use the clipped screenshot
crop origin in coordinate pixels: divide preview pixels by the returned scale.
Raw GDK surface coordinates and widget-local coordinates are not that origin.
This does not qualify every GNOME X11 EWMH move/resize or mixed-monitor mapping.

On KDE Wayland, element clicks that need pointer dispatch match their AT-SPI
frame to a unique same-PID KWin window using frame and client geometry. Input
uses physical capture pixels for uinput and global logical coordinates for the
portal. Verified uniform fractional scaling, actual decoration offsets, and
negative output origins are supported. Ambiguous ownership, unknown desktop
visibility, overlapping outputs, mixed or unknown output scales, and stale
pointer dimensions fail before input. Explicit coordinates and relative clicks
retain their coordinate contract. Real KDE desktop validation remains pending;
the geometry and failure paths have fixture coverage. Successful dispatch does
not verify UI activation.

A semantic `perform_action` whose cached AT-SPI owner disappears during query or
revalidation can refresh the original scoped snapshot once. Recovery must prove
the same app scope and resolve a new object identity. Numeric indexes, explicit
identifiers, unscoped snapshots, and actions already dispatched are never
retried automatically.

For editable text, `set_value` reads the complete contents back within a bounded
deadline. `verified: true` means an exact match; mismatches and readback errors
or timeouts return `ok: false` without replaying the mutation. Password fields
return `verified: false` because masked contents cannot prove the write. Numeric
writes and failures before editable-text verification omit `verified`. Re-observe
after any mismatch because the contents may have changed.

Set `CODEX_COMPUTER_USE_NOTIFY_ON_COMPLETE=1` in the MCP server environment
to expose `complete_interaction`, a parameter-free completion notification.
The standalone `COMPUTER_USE_LINUX_NOTIFY_ON_COMPLETE` alias is accepted only
when the Codex variable is unset; an explicit Codex value of `0` disables it.
The tool uses `notify-send` with bounded execution and cleanup. Missing services,
failures, and timeouts skip the cue without failing the task. It does not grant
exclusive desktop ownership and is disabled by default.

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
`CODEX_COMPUTER_USE_FORCE_YDOTOOL_POINTER=1` to skip native-X11 xdotool clicks
and scroll. Native X11 scroll sends XTEST wheel buttons (4 up, 5 down, 6 left,
7 right) through xdotool, because GTK 3 drops the single wheel event that
follows ydotool's absolute move.

The Wayland RemoteDesktop portal asks for consent on every new process by
default. Set `CODEX_COMPUTER_USE_PERSIST_REMOTE_DESKTOP=1` (standalone alias
`COMPUTER_USE_LINUX_PERSIST_REMOTE_DESKTOP=1`) to request `persist_mode=2` on
`SelectDevices` and reuse the single-use restore token that `Start` returns.
Tokens are stored per device kind, mode `0600`, under
`$XDG_STATE_HOME/codex-computer-use-linux/` or
`~/.local/state/codex-computer-use-linux/`. The first grant still shows the
dialog; later processes restore until the desktop revokes the grant. This needs
RemoteDesktop interface version 2.

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

Niri window listing and exact focus prefer `niri msg` and fall back to direct
JSON IPC over the active session socket. The Computer Use backend hydrates
`NIRI_SOCKET` for GUI starts. If it is unset, socket discovery requires a
unique socket matching `WAYLAND_DISPLAY`; ambiguous or stale sockets are
refused. The `niri` binary is optional when the direct socket is reachable.
Window positions account for output origin, window offsets and a uniform known
scale. If niri omits a position or output scaling is unknown or mixed, bounds
are absent or keep null coordinates rather than guessing. Listing and exact
focus remain available in those cases; use fresh full-screen screenshot
coordinates for input.

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

The direct MCP server also exposes `run_shell` only when explicitly started
with `CODEX_COMPUTER_USE_ENABLE_SHELL=1`. The standalone
`COMPUTER_USE_LINUX_ENABLE_SHELL=1` alias is used only when the Codex variable
is unset; an explicit Codex value of `0` keeps it disabled. The in-app native
adapter does not expose this tool. It runs `/bin/sh -c` with the current user's
host permissions, without a sandbox or login profiles. The host must approve
the requested command. Ambient credentials and agent sockets are removed from
the environment; additional variables must be supplied explicitly. Execution
defaults to 30 seconds (maximum 120), and returned output is bounded. An audit
digest is written to backend stderr without logging command text.

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
`codex-computer-use-cosmic` and `codex-computer-use-indicator` release helpers once before staging the app.
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

COSMIC window queries wait for compositor focus state and verify activation.
Native X11 text input sends LF and CRLF as Return. Focused terminals are valid
keyboard targets without an EditableText interface.

## Manual isolated X11 regression

The opt-in typing guard regression runs in its own Xvfb display and private
D-Bus session. It requires Python 3, Xvfb, xterm, xdotool, xkbcomp, setxkbmap,
libX11 and dbus-run-session. It checks stable text delivery, restored layout
and focus changes, keyboard grabs, no fixed focus and PointerRoot monitoring.

```bash
cargo build --locked -p codex-computer-use-linux
python3 computer-use-linux/scripts/x11_type_guard_test.py \
  target/debug/codex-computer-use-linux
```

This is a manual check; the script is not run by the default CI jobs.
