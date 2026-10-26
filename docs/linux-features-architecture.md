# Linux features architecture

`linux-features/` is the only extension boundary for optional integrations.
Repository features live in `linux-features/<id>/`; private local features live
in the gitignored `linux-features/local/<id>/`. Every feature requires adjacent
`feature.json` and `README.md` files.

The manifest `id` must equal the declaring feature directory's final name:
`<id>` in both repository and `local/<id>` paths, including alternate feature
roots. Discovery checks the declaration path, not a symlink target's name, and
reports mismatches without renaming directories or migrating private features.

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

Known retired IDs and their aliases are discarded during config loading. Other
unknown enabled IDs, default-enabled manifests, unmet requirements, and
conflicts are errors. Strict configuration reads (`strictConfig: true`),
including native package plans, also reject duplicate enabled IDs and malformed
settings. Non-strict reads warn and ignore malformed settings entries (or the
whole malformed settings container) and deduplicate enabled IDs.

The entire `settings` field may be omitted or `null`. Otherwise it must be an
object keyed by syntactically valid feature IDs, with non-null, non-array
objects as values. Nested business fields remain feature-owned. Retired IDs
are filtered before validating their values. Settings for disabled features
are retained; the package/update-builder snapshot exports only enabled feature
settings.

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
entrypoint aliases are rejected. `entrypoints` may be omitted, `null`, or an
empty object. Otherwise it must be an object containing only `patchDescriptors`,
`stageHook`, and `cleanupHook`; unknown keys fail during manifest discovery in
both the build loader and setup picker, without executing modules or hooks.
Entrypoint paths remain relative to and inside the owning feature directory.

Manifest fields:

| Field | Purpose |
|---|---|
| `id` | Stable configuration ID matching the directory name |
| `title`, `description` | User-facing wizard and documentation text |
| `defaultEnabled` | Omitted means `false`; an explicit value must be boolean `false`, including local and internal features |
| `internal` | Optional boolean for build-owned plumbing hidden from public feature selection; omission means `false`, and explicit `null` or non-boolean values are rejected |
| `entrypoints.patchDescriptors` | Optional ASAR descriptor module |
| `entrypoints.stageHook` | Last-resort app staging script |
| `entrypoints.cleanupHook` | Cleanup script discovered for disabled features |
| `resources` | Declarative files copied into the app tree |
| `runtimeHooks` | Launcher environment and lifecycle extensions |
| `packageResources` | Declarative files outside the app tree in native packages |
| `packageDependencies` | deb/RPM/pacman/ebuild runtime dependency mapping |
| `packageHooks` | Narrow native-package staging operations |
| `gentoo` | Audited Gentoo support and phase-specific dependency mapping |
| `requires` | Other feature IDs that must be enabled |
| `conflicts` | Feature IDs that cannot be enabled together |

The table describes framework fields, not a whitelist of top-level keys.
Manifest normalization preserves feature-owned top-level extensions for both
repository and private features. Their consumers own semantic validation when
using them; retaining a field does not mean its value has been validated.
Existing examples include:

| Extension field | Consumer and handling |
|---|---|
| `presets` | `model-picker-default-presets/patch.js` validates model/effort preset entries |
| `petOverlay` | `pet-overlay/patch.js` normalizes overlay defaults and user overrides |
| `catalogSubfeatures` | `community-features-in-gui-settings/catalog.js` validates subfeature metadata |
| `officialBundleAuditScenarios` | `scripts/ci/verify-official-linux-features.js` validates audit scenario names and settings containers |

Framework-defined structures have their own constrained keys: `entrypoints`
rejects unknown entrypoint types during discovery, `runtimeHooks` rejects
unsupported hook names when planning app resources, and `packageDependencies`
rejects unsupported package formats when planning dependencies. A top-level
extension does not register an executable entrypoint or make a misspelled key
inside `entrypoints` valid. Unsafe paths fail their corresponding resource or
entrypoint checks.

A manifest title or description does not replace the adjacent README; document
setup, settings, side effects, cleanup, supported sessions/architectures, and
tests there.

## Lifecycle

1. The installer validates enabled manifests and relationships.
2. If required core or enabled feature ASAR descriptors exist, a temporary ASAR
   copy is extracted and patched. The patch report explains both sets of
   outcomes; only reported changes trigger deterministic repacking. With no
   descriptors in either set, ASAR is never extracted and stays byte-identical
   to the verified official input. Empty feature selection alone is insufficient.
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
`extracted-app:post-webview`. Descriptors must be idempotent. Execution policy
and candidate acceptance are separate: `ciPolicy` defaults to `optional`, so
ordinary execution errors may be recorded as warnings or optional skips;
`enforceWhenEnabled` defaults to `true`, so those outcomes still reject a
candidate when the owning feature is explicitly enabled. The standard build
runs `patch-linux-window-ui.js --enforce-critical`, which checks both
`criticalFailuresFromReport` and `enabledFeatureFailuresFromReport`.

| Report status | Default acceptance for an enabled feature |
|---|---|
| `applied`, `already-applied` | Successful |
| `applied-with-warnings`, `skipped-optional` | Rejected; execution continued but the enabled surface was not validated |
| `skipped-target`, `skipped-disabled` | Not applicable to this target or descriptor enable gate; not an acceptance failure |
| `failed-required`, `failed-integrity` | Rejected by the independent critical-failure check |

A descriptor may explicitly set `enforceWhenEnabled: false` only with
`ciPolicy: "optional"`. This exempts that descriptor from enabled-feature
acceptance, but cannot bypass required core or integrity failures. Use this
only for intentionally best-effort behavior, never to conceal enabled-feature
drift. Required core policy remains independent of feature selection.

An enabled patch entrypoint with an invalid export or descriptor aborts loading
before patch execution: every descriptor must be an object with a nonempty
string `id` (or `name`) and an `apply` function. Diagnostics identify the
feature, module path, and offending item. These input errors cannot become an
empty successful patch report. Empty descriptor arrays and resource-only
features are valid; disabled feature modules are not loaded. Execution warnings
from valid descriptors are reported separately and remain subject to candidate
acceptance checks.

Features may share ordinary patch libraries in `scripts/patches/lib/`. For
example, `global-dictation` and `wayland-global-shortcuts` each install an
idempotent portal backend from that directory and select their own command IDs.
Either feature stages the same prebuilt helper through its staging hook. The
update-builder carries the shared patch libraries and staging utility together
with the selected feature directories.

The core registry contains only required compatibility patches. Features must
be self-contained and must not compose with deleted core IDs. A generic core extension point may be
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
executable hooks receive the original arguments and use
`CODEX_LINUX_APP_DIR`, `CODEX_LINUX_APP_STATE_DIR`, and
`CODEX_LINUX_APP_CACHE_DIR` for lifecycle paths. Feature-owned runtime resources
are available under `CODEX_LINUX_FEATURES_DIR`, and
`CODEX_LINUX_LAUNCHER_LOG` names the canonical launcher log path. After-exit
hooks receive the process status in `CODEX_LINUX_ELECTRON_EXIT_STATUS`. Keep
hooks bounded; the compact launcher does not supervise helper processes or
provide a second application lifecycle. The launcher exports lifecycle paths
but does not create their directories; hooks must create a directory before
writing into it.

## Native package extensions

`packageResources` place feature-owned files outside the app directory;
`packageDependencies` map runtime dependencies for deb/RPM/pacman/ebuild; package hooks
perform the remaining narrowly scoped staging work. Targets must stay inside
the package root and cannot overlap the packaged app tree. Special permission
bits are rejected.

### Gentoo feature contract

Gentoo support is opt-in per feature and separate from the disabled-by-default
user configuration. Do not mark a feature supported without its adjacent tests,
an official-bundle build, and acceptance for the environments it claims.
`ui-tweaks`, `remote-mobile-control` and `community-features-in-gui-settings`
currently declare Gentoo support; other repository features require their own
audit and declaration. This framework adds
no systemd-specific integration. Native validation uses amd64 OpenRC; Gentoo
ARM64 and systemd runtime environments have not been tested.

```json
{
  "gentoo": {
    "supported": true,
    "dependencies": {
      "bootstrap": ["dev-lang/rust"],
      "BDEPEND": [],
      "DEPEND": [],
      "RDEPEND": [">=net-libs/nodejs-22.12.0[npm]"],
      "IDEPEND": []
    }
  },
  "packageResources": [{
    "source": "assets/70-example.rules",
    "target": "usr/lib/udev/rules.d/70-example.rules",
    "mode": "0644",
    "formats": ["ebuild"]
  }],
  "packageHooks": [{"source": "package.sh", "formats": ["ebuild"]}]
}
```

| Phase | Consumer |
|---|---|
| `bootstrap` | `make bootstrap-native`, before regular-user helper/app/package builds; omitted from ebuild metadata |
| `BDEPEND` | Portage build-host tools needed for the local payload's `src_*` phases |
| `DEPEND` | Portage target build libraries/headers for `src_*` phases |
| `RDEPEND` | Installed application/feature runtime dependencies |
| `IDEPEND` | Portage merge/unmerge tools, not persistent runtime dependencies |

Helpers are compiled outside Portage. Put their build tools in `bootstrap`, not
only in `BDEPEND`; the binary-payload ebuild does not rebuild helpers. Do not
invent an install dependency for a build-time staging hook. Extra Portage
phases are available for audited packaging needs, not an implicit compile or
root hook extension.

Each phase is an array of individual EAPI 8 atoms. Supported constraints include
version comparisons, `=` version prefixes, slot/subslot and slot operators, and
fixed positive/negative USE requirements with defaults. Bootstrap atoms do not
accept slot rebuild operators. Dependency expression groups, blockers,
repository selectors, conditional USE, whitespace and shell expansion are
not accepted. Unknown phases and malformed atoms fail closed; the Gentoo host
also checks atoms with Portage's parser. Lists are enabled-only, sorted and
deduplicated within each phase. The array shorthand `gentoo.dependencies: [...]`
and `packageDependencies.ebuild: [...]` both contribute to `RDEPEND` only.

The existing package resource/hook engine handles `ebuild` alongside other
native formats. Gentoo external resources must be below `usr/` or `etc/`;
app-internal files belong in `resources`. Hook scripts run under the builder's
user with `PACKAGE_FORMAT=ebuild`, `PACKAGE_VERSION`, `PACKAGE_ROOT`,
`PACKAGE_STAGING_ROOT`, `PACKAGE_NAME`, `APP_DIR` and `PACKAGE_APP_DIR`. They run
after declarative resources and are never installed as Portage lifecycle code.
Files in the app snapshot must match the enabled resources/hooks and declared
modes; changed selections, stale ownership and failed enabled patches require
a rebuild. Disabling a feature removes its external resources from the next
payload, leaving Portage to unmerge the obsolete owned files.

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
works. Enabled descriptors must apply cleanly before the candidate is accepted,
unless they carry the explicit optional exemption described above; target and
descriptor-gate skips retain their not-applicable semantics.

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
