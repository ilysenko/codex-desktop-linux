# Wayland Global Shortcuts

Routes the application's existing Popout, Mini/Pet, Appshots, voice and meeting
global shortcuts through the native Wayland GlobalShortcuts portal. The app
continues to own each action, its availability and its preferred key combination.
KDE shows descriptive action names when requesting approval.

The five portal actions keep their native Popout ownership, Pet availability,
Appshots trigger policy, voice lock-screen check and Meetings access, window and
keymap checks. Region Screenshot and Spotlight retain their native registrations.
The build validates the complete main-process chunk inventory before committing
the five action tags together. Repeated builds validate the complete feature
state, including its native owners and shared portal dependency. Incomplete or
ambiguous adaptation leaves the input files intact and reports the refusal.

Enable `wayland-global-shortcuts` in `linux-features/features.json` and rebuild.
Global dictation is independently selected with `global-dictation`; either
feature can be enabled alone or both can share one helper.

`make install-native` builds the native helper before packaging. Direct
`./install.sh` builds require a prebuilt
`global-dictation-linux/target/release/codex-global-dictation-linux` or
`CODEX_GLOBAL_DICTATION_LINUX_SOURCE` pointing to that executable. Updater rebuilds
reuse the packaged helper. Its binary name is shared with the dictation feature
and the GNOME paste companion.

The desktop portal backend must implement GlobalShortcuts. X11 and other
platforms retain the application's existing shortcut path. Application-local
commands such as New chat and Quick Chat retain their existing handling.

The portal may request approval on first registration of an action. Requests are
queued; later actions wait for the current dialog. Existing action IDs preserve
system choices across app restarts. Startup waits for account-access discovery
before binding the initial action set. Accepted native quit preserves its
pending-turn read and synchronous save attempt, then disables Portal registration
and initiates helper stop before native window and action-owner cleanup. Both
will-quit drains join the stop Promise settlement before timeout-bound context
cleanup and final application disposal. Settlement includes failed stop results.
The native macOS privacy veto keeps the backend running, and upstream retains its
Windows forced-exit policy. This keeps KDE's saved action set stable across
ordinary restarts and update exits.
On KDE, edit actual bindings under
**System Settings > Keyboard > Shortcuts > ChatGPT Community**. A changed
preferred combination in the app may leave that saved system binding unchanged.

Shortcut capture temporarily releases the app's global bindings and restores
them when capture ends. Capture starts once the helper has exited; the portal closes
a session together with the helper's D-Bus connection, so an exit forced by a
signal also releases the bindings. Partial approval leaves accepted actions usable. A
failed reconfiguration attempts one recovery of still-requested working actions;
session replacement can briefly interrupt shortcuts. Requests time out after
30 seconds. Supported portal shortcuts contain a modifier and one key.

Disable the feature and rebuild to restore the original global-shortcut path.
KDE's saved bindings can be edited or removed in its shortcut settings.

Validation:

```bash
node --test linux-features/wayland-global-shortcuts/test.js scripts/patches/lib/global-shortcuts-portal.test.js
cargo test --manifest-path global-dictation-linux/Cargo.toml
```
