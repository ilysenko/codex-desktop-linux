# GNOME Global Dictation companion

Disabled-by-default feature ID: `global-dictation-gnome`. Requires
`global-dictation` in the enabled set. This companion adds no ASAR patch and
changes neither the clipboard nor the official application's lifecycle.

## Compatibility and activation

Targets GNOME Shell **45–50**, using the GNOME 45+ ES-module extension API,
`Gio.DBusExportedObject`, and Clutter virtual keyboard devices. Older shells
and future majors are rejected, not silently accepted. These are API-targeted
versions, not a claim of hardware/session acceptance testing on every release.
Wayland is the intended use; the same Shell APIs are used under GNOME X11.
Other compositors, login/greeter sessions and root launches are unsupported.
Before version probing or writes, the installer requires an exact `GNOME`
component in colon-separated `XDG_CURRENT_DESKTOP` (for example `ubuntu:GNOME`).
When nonempty, `XDG_SESSION_CLASS` must be `user`; an unset/empty class is
accepted for environments that do not export it. Having GNOME installed while
running another desktop is not sufficient.

1. Select both `global-dictation` and `global-dictation-gnome` in the local
   feature configuration using `make setup-native`, then rebuild/install with
   `make install-native`. Do not change committed defaults.
2. Launch ChatGPT Community as your normal desktop user. Its prelaunch hook
   synchronizes sources to
   `${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/global-dictation-gnome@chatgpt-community.local/`.
   It checks `gnome-shell --version` with a bounded timeout, and requires the
   installed `resources/native/codex-global-dictation-linux` to be executable.
3. **Log out and back in** so Shell discovers the extension, then explicitly run:
   ```sh
   gnome-extensions enable global-dictation-gnome@chatgpt-community.local
   ```
   Alternatively enable that UUID in GNOME's Extensions application. There is
   no automatic enable, network fetch, `sudo`, or system-wide installation.
   Restart the app/helper after enabling the extension so startup detection can
   discover it; an already-running helper does not change its chosen backend.
4. After a JavaScript source update, log out/in again to replace Shell's cached
   code. Helper-path changes alone do not require a relog: authorization reads
   the current installer configuration for every Paste, including changing
   AppImage mount paths. A single install/update message reminds you about
   source activation; unchanged launches stay quiet.

The manifest stages `extension/` at
`.codex-linux/features/global-dictation-gnome/extension` and installs
`install-extension.sh` as its sole prelaunch hook. This feature controls only
shipping/installing the companion, **not backend selection**. A manually
installed, enabled compatible companion is detected regardless of whether this
build feature is selected.

The Rust native helper automatically probes the companion **once at startup**:
`GetNameOwner` without autostart followed by `GetVersion`, with a two-second
probe timeout. A compatible extension (version `1`) selects GNOME; an absent or
incompatible extension, probe failure or timeout selects RemoteDesktop.
The choice stays fixed for the helper's lifetime. Enabling the extension after
startup requires restarting the app/helper to rediscover it.

Once GNOME is chosen, each Paste still resolves the unique owner and checks its
version before calling `Paste` on that **same unique owner** with `NoAutoStart`.
The per-paste owner/version probe and Paste each have a two-second timeout.
All subsequent probe/Paste errors, timeouts, incompatibility or disappearance
fail closed: **no RemoteDesktop fallback and no retry**. An error or timeout
can occur after input submission. Success acknowledges submission, not delivery.
Startup selection of RemoteDesktop is distinct from fallback after GNOME has
already been selected.

## Narrow D-Bus API and security

| Item | Fixed value |
| --- | --- |
| Service | `org.chatgpt.Community.Dictation` |
| Object | `/org/chatgpt/Community/Dictation` |
| Interface | `org.chatgpt.Community.Dictation1` |
| `GetVersion()` | Unsigned integer `u`, currently `1` |
| `Paste()` | No input or output arguments |

`PasteAsync(params, invocation)` obtains the invocation's unique sender and
asks `org.freedesktop.DBus.GetConnectionUnixProcessID` on the existing session
bus (1-second timeout, no autostart). It compares
`GLib.file_read_link('/proc/<pid>/exe')` **exactly** with installer-generated
`config.json`'s canonical `helperPath`. The configuration is validated at enable
and read/validated again after each asynchronous PID lookup, at the exact path
comparison; no helper path is cached and no basename or wildcard matching is
used. Installer updates to an AppImage mount path therefore take effect without
re-enabling the extension. Missing/malformed configuration, missing/deleted
executables, failed lookups, and any different path are denied. There is no token, text argument,
arbitrary-key API, or unrestricted injection endpoint.

Before any events, and again after asynchronous authorization, Shell must be
unlocked, have windows, be in `Shell.ActionMode.NORMAL`, have no modal Shell UI
or focused Shell actor, and have a focused application window. Physical Shift,
Control, Alt, Super/Meta/Hyper and other non-lock modifier masks must be clear;
Caps Lock and conventional Num Lock (MOD2) are not treated as held shortcuts.
A changed focused window is rejected. Concurrent paste is rejected as busy.
The operation submits only physical Left Ctrl down, V down, V up, Left Ctrl up,
using Linux evdev codes `29` and `47` with `notify_key` and microsecond timestamps.
It does not look up Latin `v` in the current layout or switch the layout. This
avoids `notify_keyval` silently dropping the key under Russian/non-Latin layouts;
custom key remapping and application shortcut handling still affect delivery.
It attempts reverse-order releases even after partial submission failure. Failures return a D-Bus error; **validation failures have
no key-event side effects**. A device failure after submission can have partial
side effects, and release failures cannot be guaranteed recoverable.

Success acknowledges **key submission only, not a delivery receipt**. The
focused app can intercept/ignore Ctrl+V, use another shortcut, or lose focus
after submission. Clipboard content is prepared by the existing upstream app;
the extension never reads, writes, stores, or verifies that content. Avoid
sensitive dictation unless you trust the focused destination. Physical input
can race with event submission after the final check.

Disable cancels pending authorization, invalidates its generation, unowns the
bus name, unexports the object and disposes the virtual device. Pending work
cannot inject after disable or after disable/re-enable. A bus-name collision
leaves Paste unavailable; the extension does not replace the other owner.

This is a same-user trust boundary, **not protection against a compromised
user account**. A same-user process can change extension/config/helper files,
and executable-path authorization is not a signature check or a PID-reuse-proof
kernel capability. Keep the installation and user session trustworthy.

## Ownership, updates, failures and removal

The installer uses a fixed-inventory SHA-256 ownership manifest
`.chatgpt-community-owned.sha256` covering `config.json`, `extension.js`, and
`metadata.json`. It refuses unmanaged directories, edited files/marker,
additional entries, and symlinks in the destination or its ancestors. Absolute,
non-control-bearing data paths are required; unsafe HOME/XDG paths are rejected.
Existing ancestors must belong to root or the launching UID and must not allow
group/other writes. The installed UUID directory and all four inventory files
must belong to the launching UID and must not allow group/other writes; these
checks also apply when revalidating backups. Unsafe owners or permissions are
refused without automatically changing ownership or modes. An unchanged manifest
keeps the existing directory intact. Modified installs
must be reviewed/backed up by the user before reinstalling; the hook does not
repair them or claim their contents.

A per-UUID lock directory excludes concurrent launcher syncs. Next and backup
directories are created beside the destination on disk, never in `/tmp`.
Replacement uses same-filesystem renames and revalidates the renamed backup
immediately before promotion. A changed backup aborts promotion and is restored,
including its detected edits. The previous directory is also restored if
promotion fails or a handled signal interrupts it. After successful promotion,
the backup is checked again and deleted only if still managed; a changed backup
is retained with a warning naming its path for review. Normal successful updates
leave no unchanged scratch or backups and release the lock.

These ownership/checksum checks protect against detected changes, not against
same-user concurrent adversarial writes. Validation and rename/deletion are
not an atomic filesystem transaction with other writers; the lock coordinates
launcher syncs only. Back up important edits independently. All installer
failures warn and exit **0**, so
they never block application launch. The helper uses RemoteDesktop if its
startup probe cannot find a compatible companion; after GNOME is chosen,
companion disappearance or Paste failure still fails closed without fallback.
Like other rename-based installers, SIGKILL/power loss can leave a lock or
`.previous.*`/`.next.*` directory. Inspect and restore a preserved previous
version first, then remove only this UUID's stale scratch/lock while no sync is
running. No automatic recovery guesses or deletion of unmanaged state.

Disabling the build feature removes framework-owned app resources and hooks
on the next rebuild, **not the per-user extension**. Explicit removal:

```sh
gnome-extensions disable global-dictation-gnome@chatgpt-community.local
gnome-extensions uninstall global-dictation-gnome@chatgpt-community.local
```

If GNOME's uninstall command cannot remove the manually synchronized directory,
inspect/back up any edits and remove **only** the UUID directory shown above.
Log out/in afterward. Never delete the whole `gnome-shell/extensions` tree.
Leaving the feature selected will reinstall missing sources on the next app
launch, so deselect/rebuild before removal. No auto-deletion is performed.
Restart the app/helper after removal to choose RemoteDesktop at startup; an
already-running helper that chose GNOME does not fall back.

## Validation

From the repository root:

```sh
node --test linux-features/global-dictation-gnome/test.js
bash -n linux-features/global-dictation-gnome/install-extension.sh
git --no-pager diff --check -- linux-features/global-dictation-gnome
```

Tests strip GJS imports and stub GNOME/Gio APIs while executing the actual
extension class: exact authorization, bounded lookup, guards before/after
await, live helper-path changes, missing/malformed configuration, busy requests,
partial key failures and release attempts, name loss, and pending work across
disable/re-enable. Installer tests use PATH stubs and
isolated home-cache directories, including active-desktop/session-class guards
that reject non-GNOME and greeter sessions before probes or writes,
root/version/timeout guards,
symlinks/edits, unchanged/update behavior, lock contention, failed promotion
rollback, backup edits during rename/promotion, path escaping, and scratch cleanup. They do not enable or install an
extension in your real profile. Framework tests call
`stageEnabledLinuxFeatureInstall` for resource staging and disabled cleanup,
and `stage_update_builder_linux_features_tree` /
`stage_update_builder_linux_features_config` for enabled snapshots and omitted
disabled manifests. Test scratch lives in
`~/.cache/codex-desktop-dev/` and is cleaned after each test.

The virtual device is created with
`seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE)`.
[Mutter's `notify_key` API](https://mutter.gnome.org/clutter/method.VirtualInputDevice.notify_key.html)
accepts timestamps in microseconds, matching `GLib.get_monotonic_time()` here.
The [GNOME 45 native implementation](https://github.com/GNOME/mutter/blob/gnome-45/src/backends/native/meta-virtual-input-device-native.c)
passes these physical Linux evdev codes directly to the seat. Unlike
`notify_keyval`, it does not require a matching keysym in the current layout.
Mutter formats the missing-keyval warning with `%x`: `keyval 76` means Latin
`v` (`0x76`), not decimal 76. The regression test makes keysym lookup unavailable
and verifies physical press/release order and unchanged authorization behavior.
This source/API inspection does not load the extension or submit key events.

Real GNOME acceptance is still required: verify normal app paste, lock/overview/
modifier rejection, explicit activation, updating/relogin and removal, as well
as the native helper's startup selection with the extension enabled, absent,
incompatible or failing its probe. Verify the lifetime-stable choice, restart
requirement after enabling, and no fallback/retry if a chosen GNOME companion
disappears or later rejects/times out on Paste. Do not interpret mocked tests as proof
of delivery, end-to-end native-helper behavior, or a real Shell run. Real GNOME
acceptance has not been performed.
