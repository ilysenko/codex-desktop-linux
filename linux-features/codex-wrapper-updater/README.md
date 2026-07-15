# codex-wrapper-updater

Optional Linux feature that adds a **separate** in-app update path for the
ChatGPT Desktop for Linux wrapper: this repository's Linux patches, bundled features,
packaging glue, launcher, and `codex-update-manager`.

This is intentionally distinct from the upstream ChatGPT app update path. The
upstream path tracks the official macOS DMG. This feature tracks newer builds of
`codex-desktop-linux` itself.

## User-facing behavior

- Settings -> Linux desktop shows **Check for ChatGPT Desktop for Linux updates**.
- Settings -> Linux desktop also shows **Ask which features to enable on update**.
- Both settings are off/on independently: wrapper update checks are off by
  default, and the feature picker prompt defaults on when this feature is built.
- When wrapper update checks are on, `codex-update-manager` may check the
  wrapper repository for a newer Linux wrapper commit.
- If a newer wrapper build is available, a small top-right **Update and reopen**
  button is shown inside Codex.
- The button stays hidden when no wrapper update candidate is recorded.
- The button tooltip includes the recorded wrapper changelog when available.
- Clicking the button may show the feature picker, then writes a pending marker
  and quits Codex. The feature hook applies the wrapper update while the app is
  stopped.

## Feature picker on update

Before writing the marker, the button can run:

```text
codex-update-manager pick-features
```

This happens while the display session is still alive. The actual apply step
runs headless after the app exits.

The picker shows a `zenity` or `kdialog` checklist of optional Linux features,
pre-checked with the currently enabled set, so the user can choose which
features the rebuild stages.

- The chosen set is written to:

  ```text
  ~/.config/<app-id>/linux-features.json
  ```

- The rebuild points `CODEX_LINUX_FEATURES_CONFIG` at that file.
- The checklist is loaded from the recorded candidate wrapper source when one is
  available, so it matches the code that will be rebuilt.
- Feature ids that are currently enabled but absent from the candidate catalog
  are preserved.
- The special **(Don't ask again on future updates)** row, or turning off
  **Settings -> Linux desktop -> Ask which features to enable on update**, suppresses
  future prompts.
- Cancelling the dialog keeps the current feature set and still proceeds with
  the update.
- No display, no dialog tool, no recorded candidate catalog, or a dialog launch
  failure skips the prompt and leaves the current feature set unchanged.

## Toolbar states

- A **SHA chip** shows the installed short commit when build metadata is
  available (a git-ref-style pill, e.g. `5fcfea9`), so you can see which build
  is running.
- The action chip is color-coded:
  - **green Update** means a genuinely newer upstream build is available.
  - **amber dev mode** (non-clickable) means the installed build appears to be
    ahead of the tracked remote, so updating would be a downgrade; the update
    action is suppressed and the apply path refuses.
- "Ahead of upstream" is decided by fetching the tracked branch and checking
  whether the candidate descends from the installed commit. Offline or
  non-git/frozen bundles clear stale candidates and show no update action.

## Why this is a Linux feature

The wrapper updater is opt-in and lives under `linux-features/` because it is
not a required compatibility patch for every Linux build. Core only provides the
generic Linux feature loader and hook runner. This feature owns:

- the in-app wrapper update button;
- the Settings -> Linux desktop runtime opt-ins;
- the main-process bridge handler;
- the pending-update marker;
- the retry/apply hook;
- the updater command integration for wrapper checks, feature selection, and
  applies.

## Build-time opt-in

Add the feature id to the local feature config:

```json
{
  "enabled": ["codex-wrapper-updater"]
}
```

The file is `linux-features/features.json`, and it is intentionally gitignored.
After changing it, rebuild the app or package.

When enabled, the feature contributes three patch descriptors:

- `main-handler`: patches the Electron main bundle with the
  `codex-linux-wrapper-updater` bridge handler.
- `webview-runtime`: injects the webview runtime that creates and refreshes the
  top-right **Update** button.
- `settings-toggle`: patches the current Linux desktop settings asset,
  `linux-desktop-settings-linux.js`.

The feature also stages the same runtime hook twice:

- `.codex-linux/prelaunch.d/codex-wrapper-updater-apply-pending.sh`
- `.codex-linux/after-exit.d/codex-wrapper-updater-apply-pending.sh`

Both staged hooks call `apply-pending.sh`. A successful after-exit apply returns
the generic restart-request status `85`; the launcher waits for every
after-exit cleanup hook to finish before honoring that request.

## Runtime opt-in

The Settings toggles persist these keys:

```text
codex-linux-wrapper-updates-enabled
codex-linux-feature-picker-on-update
```

The settings are stored in the normal Linux app settings file:

```text
~/.config/<app-id>/settings.json
```

For the default app id, that is:

```text
~/.config/codex-desktop/settings.json
```

The settings are persisted through the app's `get-global-state` /
`set-global-state` path, not through the upstream typed settings schema. This is
important because these Linux-only keys do not exist in upstream's settings
schema.

`codex-update-manager` reads the same settings and treats
`codex-linux-wrapper-updates-enabled` as the runtime opt-in for wrapper update
tracking. The static updater config still defaults wrapper tracking to disabled,
so existing installs keep their current DMG-only behavior.

## Detection flow

When wrapper updates are enabled, the app starts a best-effort background check:

```text
codex-update-manager check-wrapper
```

The command compares the installed wrapper metadata with the configured wrapper
remote/branch and records the result in:

```text
~/.local/state/codex-update-manager/state.json
```

The webview button is shown only when this state contains a non-empty
`candidate_wrapper_commit`.

Relevant state fields:

- `installed_wrapper_commit`
- `installed_wrapper_version`
- `candidate_wrapper_commit`
- `candidate_wrapper_version`
- `wrapper_changelog`

`check-wrapper --json` is useful for local inspection.

## Install/apply flow

Clicking the in-app **Update and reopen** button calls the main-process bridge action
`install`. The bridge:

1. optionally runs `codex-update-manager pick-features`;
2. resolves the current app state directory;
3. writes the candidate commit to both the pending marker and a matching
   `restart-intent` file;
4. exits Electron.

For the default app id, the marker path is:

```text
~/.local/state/codex-desktop/codex-wrapper-updater/pending
```

The feature hook then runs:

```text
codex-update-manager apply-wrapper-update --expected-generation <commit>
```

Apply behavior depends on the install type:

- **User-local install**: prefers `~/.local/bin/codex-desktop-update`, so it can
  update in place without privilege escalation.
- **Packaged install**: fetches the wrapper source, rebuilds a fresh native
  package from the cached/current DMG, and installs it with `pkexec`.

After a successful apply, both markers are removed and wrapper candidate fields
are cleared. The app is relaunched only when the after-exit hook sees a clean
Electron exit plus matching generation-bound restart intent. The launcher does
that relaunch after every other after-exit hook has completed. A normal close,
a crash, a prelaunch retry, and a failed apply never relaunch the app.

## Failure and retry behavior

The hook is fail-closed:

- if `codex-update-manager` is missing, the marker is kept;
- if rebuild/install fails or the candidate generation changes, the marker is
  moved under `codex-wrapper-updater/quarantine/` and restart intent is cleared;
- invalid or legacy timestamp-only markers are quarantined without invoking the
  updater;
- a lock directory prevents concurrent apply attempts;
- a bounded prelaunch timeout keeps the valid pending marker but clears restart
  intent, so a later retry cannot unexpectedly reopen an intentionally closed
  app.

This means a failed update does not leave the app half-updated or trap it in a
close/relaunch loop. Clicking **Update and reopen** again creates a fresh intent for the
currently advertised candidate.

## Local testing

Run the feature tests:

```bash
node --test linux-features/codex-wrapper-updater/test.js
```

Build and package with the feature enabled:

```bash
MAX_BUILD_THREADS=8 make build-app
MAX_BUILD_THREADS=8 make deb
```

Verify the installed build has the feature:

```bash
sed -n '1,160p' /opt/codex-desktop/resources/codex-linux-build-info.json
```

Verify the settings patch landed in the installed webview bundle:

```bash
rg "CodexLinuxWrapperUpdatesSetting|CodexLinuxFeaturePickerOnUpdateSetting|get-global-state|set-global-state" \
  /opt/codex-desktop/content/webview/assets/linux-desktop-settings-linux.js
```

Toggle the settings in Settings -> Linux desktop, then verify:

```bash
rg "codex-linux-wrapper-updates-enabled|codex-linux-feature-picker-on-update" \
  ~/.config/codex-desktop/settings.json
```

Inspect wrapper detection state and the picker command:

```bash
codex-update-manager check-wrapper --json
codex-update-manager status --json
codex-update-manager pick-features --json
```

## Troubleshooting

If either row appears but the toggle immediately reverts, confirm the installed
settings bundle uses `get-global-state` and `set-global-state`. If it uses the
upstream typed settings API, the app will reject the Linux-only keys.

If the **Update** button does not appear, check:

- the Settings -> Linux desktop wrapper update toggle is on;
- `check-wrapper --json` records `candidate_wrapper_commit`;
- `~/.local/state/codex-update-manager/state.json` contains the candidate;
- the installed build includes `codex-wrapper-updater` in
  `codex-linux-build-info.json`.

If the feature picker does not appear before the update:

- the Settings -> Linux desktop feature picker toggle may be off;
- the app may not have a graphical display session;
- neither `zenity` nor `kdialog` may be installed;
- the recorded wrapper candidate may not include a readable feature catalog;
- the dialog may have been cancelled, in which case the update still proceeds
  with the existing feature selection.

If the app keeps retrying an update, inspect the pending marker and updater log:

```bash
ls -la ~/.local/state/codex-desktop/codex-wrapper-updater/
tail -n 200 ~/.local/state/codex-update-manager/service.log
```

Quarantined markers are diagnostic receipts and are never retried
automatically. A valid pending marker without restart intent may be retried at
the next prelaunch, but it cannot reopen the app after an ordinary close.

## Known costs and risks

- Packaged wrapper updates are heavier than DMG checks because they rebuild a
  native Linux package locally.
- Packaged applies require `pkexec` and a graphical polkit authentication agent.
- Detection needs network access to inspect the configured wrapper remote.
- Missing build tools are reported as an apply failure and quarantine the
  candidate; click **Update** again after installing the tools.
