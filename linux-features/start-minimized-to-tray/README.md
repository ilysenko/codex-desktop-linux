# Start Minimized to Tray

Adds two separate switches to **Settings → General** within one build feature:

- **Start minimized to tray** hides the main window on ordinary cold launches.
- **Start minimized to tray only on boot** hides it only when launched by login
  autostart. Manual launches open normally. This switch works independently
  and takes priority if both switches are enabled.

The build feature and both saved preferences are disabled by default. Changes
take effect after fully quitting and restarting ChatGPT Community. “Only on
boot” refers to login autostart, not the first manual launch after a reboot.

## Enable

Select **Start Minimized to Tray** with `make setup-native`, or add
`start-minimized-to-tray` to the `enabled` array in the gitignored
`linux-features/features.json`. Preserve any other enabled IDs.
Then rebuild with `./install.sh` or `make install-native`, launch the rebuilt
app, and enable the desired switch in **Settings → General**. `make setup-native`
still exposes only the single **Start Minimized to Tray** build feature.

An ordinary cold launch creates the main window hidden and uses the official
tray. Clicking the tray icon, choosing its Open action, or launching the app
again reveals the window through upstream's existing handlers. Launches with
file paths or deep-link arguments open normally. Startup activation requests
cancel the hidden-start decision. No separate tray, window manager, login
autostart entry, or launcher lifecycle is added.

### Login-only startup

Keep your existing desktop autostart entry. A feature-local launcher hook
recognizes the launcher's systemd XDG autostart service
(`app-…@autostart.service`, as used by current KDE Plasma) or the session
manager's `DESKTOP_AUTOSTART_ID` marker before starting Electron. It forwards
the login classification as a launch argument, so Electron/Chromium moving
to its own systemd scope cannot lose it. The argument is not inherited by
child applications. No flag needs to be added to a normal XDG autostart entry.
It does not infer autostart from uptime, background mode, or the presence of a
desktop session. If neither signal is available, it opens normally.

For a custom startup script or a desktop that supplies neither signal, add
`--codex-autostart` only to its login command, for example:

```ini
Exec=codex-desktop --codex-autostart
```

Leave the regular application shortcut unchanged. The marker identifies the
launch; the saved preference still controls whether the window is hidden.
Enabling this switch does not enable login autostart itself. Existing scripts
that independently minimize windows should be replaced with a direct app
autostart command if they would otherwise affect manual launches.

Detection follows [systemd's XDG autostart service naming](https://github.com/systemd/systemd/blob/main/src/xdg-autostart-generator/xdg-autostart-service.c)
and [GNOME's session launch marker](https://wiki.gnome.org/Projects%282f%29SessionManagement%282f%29GnomeSession.html).

The current upstream background-window creation and progress-window guards
keep hidden startup from showing a delayed startup dialog. Upstream restores
saved maximization when the window is revealed, so it cannot make the initial
hidden window visible. Tray Open and second-instance activation
also work while upstream host initialization is still pending.
The renderer's delayed app/onboarding window-mode requests are deferred until
the hidden window is revealed. Only the latest mode is applied, including its
geometry, maximization, and fullscreen state. This prevents the authenticated
renderer from showing the main window a few seconds after a hidden launch.

The feature waits at most three seconds for upstream tray setup. If the tray
fails, times out, or is not ready, the window opens normally. A shell that
supports upstream's system tray is required; an Electron tray-ready signal
does not guarantee that a particular shell displays its icon.
Startup logs tagged `[start-minimized-to-tray]` report the preference, launch
decision, and tray readiness without logging arguments or profile contents.

## Compatibility and removal

Targets the current signed stable official Linux bundle on amd64 and arm64,
using the same JavaScript patch for X11 and Wayland. Desktop-shell behavior
still needs session-specific runtime verification. The preferences are saved
through the existing global-state API under
`codex-linux-start-minimized-to-tray` and
`codex-linux-start-minimized-to-tray-only-on-boot` in the active app profile.
They are shared with other launches using that profile;
`community-profile-isolation` gives the Community app a separate profile.

Turn both switches off to restore visible startup. Turning the login-only
switch off restores the behavior selected by **Start minimized to tray**.
Removing the feature ID and rebuilding removes both switches and the startup
patch. Their saved booleans are inert while the feature is absent and are reused
if the feature is enabled again.
The short-lived launcher hook adds no background helper processes, extra
package dependencies, or files to clean up in the user home directory.

The patch uses unique semantic anchors and rejects an enabled-feature build
if upstream settings or startup contracts drift. Disabled builds do not probe
or patch these surfaces and continue to preserve the official ASAR.

## Testing

```bash
node --test linux-features/start-minimized-to-tray/test.js
```

Tests cover both preferences' persistence and save failures, login-only priority,
manual launches, explicit/session/systemd autostart markers and unavailable
cgroup information, launcher-to-Chromium scope transitions, enabled/disabled
hook staging, hidden and visible cold starts, tray failure/timeout,
file/deep-link activation, tray reopening,
saved maximization, delayed renderer window modes and their geometry,
activation before host readiness, idempotence, and missing
or duplicate anchors. Also build with this feature
alone against the verified official package. For runtime acceptance, quit the
app, enable the setting, relaunch, verify no main window/taskbar entry appears,
and verify tray Open, a second launch, and a deep link reveal the window. Repeat
with the setting disabled and with no available system tray.
For login-only acceptance, enable **Start minimized to tray only on boot**,
launch through desktop autostart (or with `--codex-autostart`), and verify that
the window stays hidden. Quit fully and launch from the regular shortcut;
verify that the window opens even with **Start minimized to tray** also enabled.

The current startup contracts and settings patch build against signed stable
`26.1007.21434`. Tests exercise upstream background guards and interactive
activation alongside the feature preferences.

The login-only extension previously built with this feature enabled alone on
amd64 and arm64. A temporary
systemd autostart service verified the actual cgroup detection; an ordinary
manual process was correctly rejected. A real KDE/Wayland login subsequently
showed that Chromium moves the native app into a separate scope before the
main bundle reads its cgroup. The launcher hook captures the original
autostart service before that move. The corrected amd64 build included that
hook. An isolated test using the standard launcher, a real systemd autostart service, and a second systemd
scope verified that the startup decision survives this move; manual startup
stays visible and the explicit fallback still works. This test substitutes a
small decision probe for Electron. The contributor subsequently confirmed
that both startup modes work in their real EndeavourOS amd64 desktop session
with KDE Plasma 6.7.5 and Wayland, including the login-autostart-only option.

The shared hidden-window path was previously validated in isolated amd64
X11/Xvfb runs with a simulated
StatusNotifier watcher confirmed hidden native startup, tray activation,
close-to-tray followed by a second launch, deep-link activation, and saved
maximization. Without a watcher, startup fell back to a visible native window.
These checks do not establish behavior in a real KDE/Wayland session.

An isolated amd64 KWin/Wayland session with a fresh profile and simulated
StatusNotifier watcher reproduced the delayed-mode regression in the previous
patch: the native main window appeared after an `electron-set-window-mode`
request. The corrected build kept the native window unmapped through app and
onboarding mode transitions, including saved maximization, then revealed it
on tray activation, a second launch, or a deep link. Turning the preference off
preserved visible startup. This checks the actual Electron/Wayland window
behavior; it does not use an authenticated profile or the user's live desktop
session.
