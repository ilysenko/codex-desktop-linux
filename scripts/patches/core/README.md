# Core Linux Patch Descriptors

Core patch modules live under `scripts/patches/core/**/patch.js` and are
collected by `scripts/patches/runner.js`.

Use this tree only for shipped Linux compatibility patches. Optional user-facing
extras still belong in `linux-features/`.

The patch contract is fresh-DMG-only. Descriptors should target the current
upstream app layout, stay idempotent, and report drift when a current upstream
needle is missing. Do not add old-DMG fallback branches, compatibility barrels,
or legacy import surfaces for removed internal patch APIs.

Current namespaces:

- `all-linux/` for patches that should ship in every Linux build.
- `distro/<id>/` for patches tied to one distro or distro family.
- `package/<format>/` for package-format-specific behavior (`deb`, `rpm`, `pacman`).
- `desktop/<name>/` for session or desktop-environment-specific behavior.

Each module exports one descriptor factory result or an array of factory
results. Import factories and constants from `scripts/patches/descriptor.js`:

```js
"use strict";

const {
  CI_POLICY_OPTIONAL,
  mainBundlePatch,
} = require("../../../../descriptor.js");

module.exports = mainBundlePatch({
  id: "linux-example",
  ciPolicy: CI_POLICY_OPTIONAL,
  order: 30000,
  appliesTo: (context) => context.linuxTarget.matchesId("gentoo"),
  apply: (source, context) => source,
});
```

The runner executes four explicit phases. `order` is sorted only within each
phase:

- `main-bundle`: patches the Electron main-process bundle source.
- `extracted-app:pre-webview`: patches extracted files before webview asset
  descriptors run.
- `webview-asset`: scans `webview/assets/` with `pattern` or `assetPattern`.
- `extracted-app:post-webview`: patches extracted files after webview asset
  descriptors run.

Use `mainBundlePatch(...)`, `webviewAssetPatch(...)`, or
`extractedAppPatch(...)` for new descriptors. Extracted app descriptors must
choose `extracted-app:pre-webview` or `extracted-app:post-webview` explicitly.

Omit `appliesTo` for all Linux builds. Use build-time target filters only when
the patch should not be present in every Linux artifact; prefer runtime checks
inside injected code for desktop/session details that can change after install.

Supported `ciPolicy` values:

- `required-upstream`: upstream-build CI fails when the patch drifts.
- `optional`: drift is reported but does not fail upstream-build CI.
- `opt-in`: same non-failing CI behavior as `optional`, for descriptors behind
  an explicit local enable gate.

Common filters:

```js
appliesTo: (context) => context.linuxTarget.matchesId("nixos")
appliesTo: (context) => context.linuxTarget.packageFormatIs("deb")
appliesTo: (context) => context.linuxTarget.desktopMatches(["i3", "sway"])
appliesTo: (context) => context.linuxTarget.versionAtLeast("24.04")
```

Keep descriptor files declarative. Shared patch implementations live under
`scripts/patches/impl/` by domain (`main-process/`, `webview/`, keybinds,
computer-use, chrome-plugin, launch-actions, automation-schedule, bootstrap,
package-json, avatar-overlay, and projectless-documents). Generic helpers live
under `scripts/patches/lib/`. Do not recreate the deleted compatibility
barrels (`scripts/patches/main-process.js`, `webview-assets.js`, or
`shared.js`).
