# Linux Features

`linux-features/` contains opt-in Linux integration modules for this wrapper.
These are not upstream Codex plugins; they are Linux-side extensions that can
add ASAR patches, staged resources, runtime hooks, package hooks, or custom
build/install hooks. The full architecture contract is documented in
[`docs/linux-features-architecture.md`](../docs/linux-features-architecture.md).

By default, no optional Linux features are enabled. Copy
`features.example.json` to `features.json` before running `./install.sh` or
building packages, then list the feature ids you want:

```json
{
  "enabled": [
    "example-feature"
  ]
}
```

`features.json` is ignored by git so local choices do not leak into commits.
Feature choices are read during the install/build pipeline; if you change this
file after an app has already been generated, rerun the install/build step.
Native packages preserve the enabled feature id list and settings in the
packaged update-builder bundle, so `codex-update-manager` rebuilds keep the
same opt-in features across auto-updates.

Feature-specific local settings can live in the same gitignored file under
`settings.<feature-id>`. Keep tracked `feature.json` files as shipped defaults;
do not edit them for personal preferences. Feature patch descriptors receive
this object as `context.feature.settings`:

```json
{
  "enabled": [
    "ui-tweaks"
  ],
  "settings": {
    "ui-tweaks": {
      "tweaks": {
        "sidebar": {
          "projectName": {
            "style": "font-weight: 700 !important; padding-top: 0.25rem;"
          }
        }
      }
    }
  }
}
```

Feature directories can be tracked repository features at `linux-features/<id>/`
or private user-local features at `linux-features/local/<id>/`. The
`linux-features/local/` directory is ignored by git. Local features use the same
`feature.json` contract and are enabled by adding their id to `features.json`.
Repository and local features share one id namespace; local features cannot
shadow tracked features.

You can also let the guided native setup helper discover feature manifests and
write `features.json`:

```bash
make setup-native

# non-interactive feature edits:
CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
CODEX_LINUX_FEATURES=remote-mobile-control,read-aloud \
CODEX_LINUX_DISABLE_FEATURES=conversation-mode \
make setup-native
```

Disabling a feature in `features.json` only affects the next rebuild. The helper
does not delete local device keys, Read Aloud model files, plugin caches, Python
runtimes, or ydotool services. Feature-owned cleanup is a separate interactive
action:

```bash
CODEX_BOOTSTRAP_CLEANUP_FEATURES=remote-mobile-control,read-aloud make setup-native
```

The helper lists exact paths and deletes only paths confirmed with
`DELETE <exact path>`. Add `CODEX_BOOTSTRAP_DRY_RUN=1` to preview cleanup
targets without deleting them.

Each feature directory must include:

- `feature.json` — metadata and entrypoints
- `README.md` — what it does, how to test it, and known risks
- optional `patch.js` — descriptor patches when `feature.json` uses
  `entrypoints.patchDescriptors`
- optional declarative `resources`, `runtimeHooks`, and `packageHooks`
- optional `stage.sh` — legacy install/build staging hook
- optional `test.js` — self-contained tests for the feature

`stage.sh` hooks run with `SCRIPT_DIR`, `INSTALL_DIR`, `WORK_DIR`, `ARCH`, and
`CODEX_UPSTREAM_APP_DIR` in the environment.

Declarative runtime hooks are staged under `codex-app/.codex-linux/`:

- `runtimeHooks.env` writes literal `KEY=VALUE` files consumed by the launcher
- `runtimeHooks.prelaunch` runs synchronously before webview setup
- `runtimeHooks.electronArgs` appends one Electron argument per line
- `runtimeHooks.launcher` runs before final Electron args are built; executable
  hooks receive current Electron args as argv and can print `env KEY=VALUE` or
  `electron-arg VALUE` lines
- `runtimeHooks.coldStart` runs background hooks after bundled plugin cache sync
- `runtimeHooks.afterExit` runs after Electron exits while preserving the
  original Electron exit status

Declarative resource targets must point to a file or subdirectory inside the app
directory, not to the app root itself. Declarative `mode` fields must be quoted
octal strings, for example `"0644"` or `"0755"`. Numeric JSON modes are
rejected so `755` cannot be interpreted as the wrong permission bits. Declared
modes are preserved in native packages.
Declarative resources and runtime hooks are tracked in
`.codex-linux/linux-features-staged.json` and removed on the next install when
the owning feature is disabled. Legacy `stage.sh` hooks own their own cleanup.

Runtime hooks receive `CODEX_HOME`, `CODEX_LINUX_APP_DIR`,
`CODEX_LINUX_APP_STATE_DIR`, `CODEX_LINUX_FEATURES_DIR`, and
`CODEX_LINUX_LAUNCHER_LOG`. Executable hooks also receive
`CODEX_LINUX_FEATURE_HOOK_PHASE`; after-exit hooks receive
`CODEX_LINUX_ELECTRON_EXIT_STATUS`. If a feature needs to install a Codex skill
or other user-home artifact, stage the source with `resources` and copy it from
`$CODEX_LINUX_FEATURES_DIR/<feature-id>/...` in `runtimeHooks.prelaunch`.
Avoid writing user-home files from `stage.sh`, because install/package/update
rebuilds may run outside the real user's session.

`packageHooks` run during native package staging and receive `PACKAGE_FORMAT`,
`PACKAGE_ROOT`, `PACKAGE_NAME`, `PACKAGE_VERSION`, and `APP_DIR`.

Feature patching uses only `entrypoints.patchDescriptors`. Descriptor modules
may export an array directly or `{ descriptors: [...] }`; `.patches`,
`.default`, and `mainBundlePatch` feature entrypoint aliases are intentionally
not supported.

Descriptor patches use the same shape as `scripts/patches/core/**/patch.js`.
They can target `main-bundle`, `extracted-app:pre-webview`, `webview-asset`, or
`extracted-app:post-webview`. Feature descriptor ids are namespaced as
`feature:<feature-id>:<descriptor-id>` in patch reports and are optional by
default.

Feature self-tests live inside each feature directory. Run them with:

```bash
node --test linux-features/*/test.js
```

Core Linux compatibility patches should stay in `scripts/patches/` until they
are deliberately migrated. Use `linux-features/` for additions that are useful
for some users but not mandatory for every Linux build.
