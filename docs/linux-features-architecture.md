# Linux features architecture

`linux-features/` is the only extension boundary for optional integrations.
Repository features live in `linux-features/<id>/`; private local features live
in the gitignored `linux-features/local/<id>/`. Every feature requires adjacent
`feature.json` and `README.md` files.

Features are always disabled by default. Enable them only in the gitignored
configuration:

```json
{
  "enabled": ["read-aloud"],
  "settings": {
    "read-aloud": { "example": "value" }
  }
}
```

`make setup-native` is the interactive editor for this configuration;
`make install-native` is the separate build/package/install step. A feature
remains enabled for updater rebuilds because its validated snapshot is included
in the custom package's minimal update-builder.

Known retired IDs are discarded during config loading. Other unknown IDs,
duplicate IDs, malformed settings, default-enabled manifests, unmet
requirements, and conflicts are errors.

## Manifest

```json
{
  "id": "my-feature",
  "title": "My Feature",
  "description": "Optional Linux integration.",
  "defaultEnabled": false,
  "entrypoints": {
    "patchDescriptors": "./patch.js",
    "stageHook": "./stage.sh"
  },
  "resources": [],
  "runtimeHooks": {},
  "packageResources": [],
  "packageDependencies": {},
  "packageHooks": [],
  "requires": [],
  "conflicts": []
}
```

Use `stageHook` only when the operation cannot be represented declaratively.
Feature patching supports only `entrypoints.patchDescriptors`; removed legacy
entrypoint aliases are rejected.

Manifest fields:

| Field | Purpose |
|---|---|
| `id` | Stable configuration ID matching the directory name |
| `title`, `description` | User-facing wizard and documentation text |
| `defaultEnabled` | Must be `false` for every repository and local feature |
| `internal` | Optional boolean for build-owned plumbing hidden from public feature selection |
| `entrypoints.patchDescriptors` | Optional ASAR descriptor module |
| `entrypoints.stageHook` | Last-resort app staging script |
| `resources` | Declarative files copied into the app tree |
| `runtimeHooks` | Launcher environment and lifecycle extensions |
| `packageResources` | Declarative files outside the app tree in native packages |
| `packageDependencies` | deb/RPM/pacman runtime dependency mapping |
| `packageHooks` | Narrow native-package staging operations |
| `requires` | Other feature IDs that must be enabled |
| `conflicts` | Feature IDs that cannot be enabled together |

Unknown keys and unsafe paths fail validation. A manifest title or description
does not replace the adjacent README; document setup, settings, side effects,
cleanup, supported sessions/architectures, and tests there.

## Lifecycle

1. The installer validates enabled manifests and relationships.
2. If any enabled feature has ASAR descriptors, a temporary ASAR copy is
   extracted, patched, deterministically repacked, and reported. Otherwise ASAR
   is never opened.
3. Declarative app resources and launcher hooks are staged.
4. Remaining legacy stage hooks run.
5. Native package resources/dependencies/hooks are applied to package staging.
6. The launcher loads env, prelaunch, Electron-argument, launcher, cold-start,
   and after-exit hooks.

The enabled feature snapshot is recorded in build metadata and must match at
package time. The update-builder includes only enabled descriptors/resources
and repeats the same validation. Drift in an enabled feature rejects the
candidate; disabled features are not probed.

## Local features

User-private modules can be placed under the gitignored
`linux-features/local/<id>/` directory:

```text
linux-features/local/my-feature/
├── feature.json
├── README.md
├── patch.js
└── test.js
```

They use the same validation and disabled-by-default contract as repository
features. Keep source and resources inside the feature directory, use a unique
ID, and do not rely on generated `codex-app/` paths. Local features are included
in the installed package/update-builder only when enabled.

## ASAR descriptors

Descriptor modules export an array or `{ descriptors: [] }`. IDs are reported
as `feature:<feature-id>:<descriptor-id>`. Supported phases are
`main-bundle`, `extracted-app:pre-webview`, `webview-asset`, and
`extracted-app:post-webview`. Descriptors must be idempotent and fail softly
unless the feature deliberately declares a required acceptance surface.

The baseline core registry is empty, so features must be self-contained and
must not compose with deleted core IDs. A generic core extension point may be
added only when unavoidable and must remain feature-agnostic.

## Declarative app resources

```json
{
  "resources": [{
    "source": "assets/tool.json",
    "target": ".codex-linux/features/my-feature/tool.json",
    "mode": "0644"
  }]
}
```

Sources stay inside the feature. Targets stay inside the app and cannot be the
app root. Modes are quoted octal strings. Staged files are tracked so disabling
a feature removes framework-owned files on the next rebuild.

## Runtime hooks

```json
{
  "runtimeHooks": {
    "env": "env",
    "prelaunch": "prelaunch.sh",
    "electronArgs": "electron-args",
    "launcher": "launcher.sh",
    "coldStart": "cold-start.sh",
    "afterExit": "after-exit.sh"
  }
}
```

- `env`: sourced as environment assignments.
- `prelaunch`: synchronous executable before runtime start.
- `electronArgs`: one argument per non-comment line.
- `launcher`: may emit `env KEY=VALUE` or `electron-arg VALUE`.
- `coldStart`: background hook at launch.
- `afterExit`: requires the wrapper to wait, then runs after process exit.

Launcher hooks receive the Electron arguments already loaded from user and
feature configuration followed by the original launcher arguments. Other
executable hooks receive the original arguments. All hooks receive the
feature/app directory environment. Keep them bounded; the compact launcher
does not supervise helper processes or provide a second application lifecycle.

## Native package extensions

`packageResources` place feature-owned files outside the app directory;
`packageDependencies` map runtime dependencies for deb/RPM/pacman; package hooks
perform the remaining narrowly scoped staging work. Targets must stay inside
the package root and cannot overlap the packaged app tree. Special permission
bits are rejected.

Native Rust helpers are built once as project release components. They must not
be rebuilt merely because a new official application package appeared. Delete
an orphan helper crate when its last feature consumer is removed.

## Testing and drift

A retained feature should have:

1. manifest validation tests;
2. idempotent descriptor/resource staging tests;
3. byte-identical failure tests for missing or ambiguous semantic anchors;
4. a build with that feature enabled alone against the current official ASAR;
5. runtime acceptance for the Linux sessions, compositors, services, or devices
   it claims to support.

Run the framework and all adjacent Node tests with:

```bash
node --test scripts/lib/linux-features.test.js linux-features/*/test.js
```

An `applied-with-warnings` or optional skip is not evidence that a feature
works. Required feature surfaces must apply cleanly before the candidate is
accepted.

## Retirement policy

Remove a feature only when the official Linux runtime demonstrably replaces its
behavior or the project intentionally drops the product surface. Delete its
descriptors, helpers, tests, package/Nix/watchdog references, and documentation
together. Add the exact old ID to the retired registry so existing local
configs migrate silently; do not make arbitrary unknown IDs valid.

## Design rule

The official Linux application is the baseline. A default core patch is allowed
only for a reproduced mandatory launch/work failure with a regression test.
Everything optional, distro/editor/browser/workflow-specific, experimental, or
minority-use belongs here and stays disabled by default.
