# Linux Features Architecture

`linux-features/` is the extension boundary for optional Linux integrations.
Core keeps a small generic loader; feature-specific behavior lives in feature
directories and is disabled by default.

## Layout

Repository features live directly under `linux-features/<feature-id>/`.

User-local features live under `linux-features/local/<feature-id>/`. The
`linux-features/local/` directory is ignored by git, so a user can keep private
or experimental integrations in the checkout without accidentally committing
them.

Every feature needs a `feature.json` manifest and a neighboring `README.md`.
The README is required for both repository features and git-ignored local
features, and should describe what the feature does, how to test it, and known
support risks.

```json
{
  "id": "my-feature",
  "title": "My Feature",
  "description": "Optional Linux integration.",
  "defaultEnabled": false
}
```

Feature ids must match `^[a-z0-9][a-z0-9-]*$`. Repository and local features
share one id namespace; local features cannot shadow repository features.
`defaultEnabled: true` is rejected. Enabling always happens through the
git-ignored `linux-features/features.json` file:

```json
{
  "enabled": ["my-feature"]
}
```

## Lifecycle

The build pipeline loads enabled features in these phases:

1. ASAR patching: patch descriptors modify extracted upstream app files.
2. App staging: declarative resources and runtime hooks are copied into
   `codex-app/`.
3. Legacy staging: optional `stage.sh` hooks run for features that still need
   custom install-time logic.
4. Native packaging: optional package hooks can mutate the `.deb`, `.rpm`, or
   pacman staging root.
5. Runtime: the launcher consumes staged environment files, prelaunch hooks,
   Electron args, and cold-start hooks.

Native packages copy the configured feature root into the packaged
`update-builder` bundle, including `linux-features/local/`, and write a
sanitized `features.json` containing only the enabled ids. Local auto-updates
therefore rebuild with the same opt-in features.

Declarative staged files are tracked in
`.codex-linux/linux-features-staged.json`. On the next install, the framework
removes the previously tracked declarative resources and runtime hooks before
staging the currently enabled set, so disabling a feature removes its
framework-owned runtime hooks. Legacy `stage.sh` hooks are not tracked by this
manifest and must clean up any feature-owned files themselves.

## Manifest Keys

`entrypoints` keeps the existing patch and staging API:

```json
{
  "entrypoints": {
    "patchDescriptors": "./patch.js",
    "patches": "./patch.js",
    "mainBundlePatch": "./patch.js",
    "stageHook": "./stage.sh"
  }
}
```

Prefer `patchDescriptors` for new patches. Feature descriptor ids are reported
as `feature:<feature-id>:<descriptor-id>` and are optional in CI by default.
`mainBundlePatch` is the compatibility path for older features that export
`applyMainBundlePatch(source, context)`.

Use `requires` and `conflicts` to declare feature relationships:

```json
{
  "requires": ["read-aloud"],
  "conflicts": ["other-voice-loop"]
}
```

The setup wizard, installer, patcher, and package builders validate these
relationships before applying enabled features.

## Declarative App Staging

Use `resources` to copy files into the generated app directory:

```json
{
  "resources": [
    {
      "source": "assets/tool.json",
      "target": ".codex-linux/features/my-feature/tool.json",
      "mode": "0644"
    }
  ]
}
```

`source` stays inside the feature directory. `target` is relative to the app
directory and must point to a file or subdirectory, not the app root itself.
File modes are optional, but when present they must be quoted octal strings
such as `"0644"` or `"0755"`; numeric JSON modes are rejected. Declared modes
are recorded in the staged manifest and restored after native package
permission normalization, so restrictive resource modes survive `.deb`, `.rpm`,
and pacman packaging.

Use `runtimeHooks` for launcher-visible hooks:

```json
{
  "runtimeHooks": {
    "env": "env",
    "prelaunch": "prelaunch.sh",
    "electronArgs": "electron-args",
    "coldStart": "cold-start.sh",
    "afterExit": "after-exit.sh"
  }
}
```

The runtime hook types map to:

- `env`: copied to `.codex-linux/env.d/`; each non-comment line is exported as
  literal `KEY=VALUE` with no shell evaluation.
- `prelaunch`: copied to `.codex-linux/prelaunch.d/`; executable hooks run
  synchronously before the packaged runtime prelaunch and webview setup.
- `electronArgs`: copied to `.codex-linux/electron-args.d/`; each non-comment
  line is appended as one Electron argument.
- `coldStart`: copied to `.codex-linux/cold-start.d/`; executable hooks run in
  the background during cold start, after bundled plugin cache sync.
- `afterExit`: copied to `.codex-linux/after-exit.d/`; executable hooks run
  after Electron exits. Hook failures are logged and the launcher preserves
  Electron's original exit status.

Runtime hooks receive `CODEX_HOME`, `CODEX_LINUX_APP_DIR`,
`CODEX_LINUX_APP_STATE_DIR`, `CODEX_LINUX_FEATURES_DIR`, and
`CODEX_LINUX_LAUNCHER_LOG`. Executable hooks also receive
`CODEX_LINUX_FEATURE_HOOK_PHASE`; `afterExit` additionally receives
`CODEX_LINUX_ELECTRON_EXIT_STATUS`. Use this pattern for user-home artifacts
such as Codex skills: stage the source file with `resources` under
`.codex-linux/features/<feature-id>/...`, then copy it from
`$CODEX_LINUX_FEATURES_DIR/<feature-id>/...` to `$CODEX_HOME/skills/...` in a
`runtimeHooks.prelaunch` script. Do not write user-home files from `stage.sh`;
install, package, and updater rebuilds may run outside the real user's session.

## Package Hooks

Use `packageHooks` only when a feature must mutate native package staging:

```json
{
  "packageHooks": [
    {
      "path": "package.sh",
      "formats": ["deb", "rpm", "pacman"]
    }
  ]
}
```

Hooks run with:

- `PACKAGE_FORMAT`
- `PACKAGE_NAME`
- `PACKAGE_VERSION`
- `PACKAGE_ROOT` / `PACKAGE_STAGING_ROOT`
- `APP_DIR` / `PACKAGE_APP_DIR`
- `REPO_DIR`

Package hooks should be idempotent and narrowly scoped.

## Local Feature Example

Create a private feature without touching tracked files:

```bash
mkdir -p linux-features/local/my-feature
$EDITOR linux-features/local/my-feature/feature.json
```

Then enable it:

```bash
cp linux-features/features.example.json linux-features/features.json
$EDITOR linux-features/features.json
make install-native
```

`make setup-native` also discovers local features, marks them as `[local]`,
and can enable them by id or list number.

## Design Rule

If a change is required for the basic Linux app to launch and behave correctly
for most users, it belongs in core patches under `scripts/patches/`.

If a change is optional, distro-specific, editor-specific, browser-specific,
workflow-specific, or likely to add future support burden for a minority of
users, put it in `linux-features/` and keep it disabled by default.
