# Codex Micro

This default-off feature enables the OpenAI x Work Louder Codex Micro over USB
and Bluetooth on Linux. It reuses the service and device kit bundled with the
upstream app; it does not reimplement the device protocol.

## Enable

Add the feature to the gitignored `linux-features/features.json`:

```json
{
  "enabled": ["codex-micro"]
}
```

Then rebuild or package the app through the normal project workflow. Do not run
the app as root.

Debian, RPM, pacman, and NixOS packages install the included udev rule. Replug
the USB cable or reconnect Bluetooth after the first install. Source builds,
AppImage, Home Manager, and direct `nix build` installs cannot change host udev
policy; install the tracked rule once on those systems:

```bash
sudo install -Dm0644 \
  linux-features/codex-micro/resources/70-codex-micro.rules \
  /etc/udev/rules.d/70-codex-micro.rules
sudo udevadm control --reload-rules
```

The packaged AppImage copy is under
`.codex-linux/features/codex-micro/70-codex-micro.rules`.

## Bluetooth

Pair the Micro through the desktop Bluetooth settings before opening Codex.
Channel selection and pairing mode are device operations; see the
[Work Louder setup guide](https://worklouder.cc/micro-setup).

## Implementation notes

The upstream app currently includes `node-hid` 3.3.0 with only its macOS native
binding. This feature verifies that exact package and stages the matching x64
or arm64 Linux binding. Package builds also provide its `libudev` and `libusb`
runtime dependencies.

The udev rules are limited to the observed Work Louder VID/PID `303a:8360`, the
USB HID interface used by the device, and the corresponding Bluetooth HID bus
identity. They grant the active desktop user access through `uaccess` and do
not make HID devices world-writable.

Upstream package drift, a mismatched native artifact, or an unsupported
architecture causes the enabled feature to reject candidate promotion. Nix
builds require the pinned prebuilt binding; other builds can fall back to an
Electron source build when the supported prebuild is unavailable.

## Verify

After connecting the device, confirm that the Codex Micro settings surface
reports it as connected and test the buttons, dial, joystick, and lighting.
For permission failures, identify the matching `/dev/hidraw*` node with
`udevadm info` and confirm that the logged-in user has read/write access.

Run the automated checks with:

```bash
node --test linux-features/codex-micro/test.js
node --test scripts/lib/linux-features.test.js
```
