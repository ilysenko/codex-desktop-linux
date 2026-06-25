# Core Linux Patch Descriptors

Core patch modules live under `scripts/patches/core/**/patch.js` and are loaded
automatically by `scripts/patches/engine.js`.

Use this tree only for shipped Linux compatibility patches. Optional user-facing
extras still belong in `linux-features/`.

Current namespaces:

- `all-linux/` for patches that should ship in every Linux build.
- `distro/<id>/` for patches tied to one distro or distro family.
- `package/<format>/` for package-format-specific behavior (`deb`, `rpm`, `pacman`).
- `desktop/<name>/` for session or desktop-environment-specific behavior.

Each module exports one descriptor or an array of descriptors:

```js
"use strict";

module.exports = {
  id: "linux-example",
  phase: "main-bundle",
  ciPolicy: "optional",
  order: 30000,
  appliesTo: (context) => context.linuxTarget.matchesId("gentoo"),
  apply: (source, context) => source,
};
```

Supported phases:

- `main-bundle`: patches the Electron main-process bundle source.
- `webview-asset`: scans `webview/assets/` with `pattern` or `assetPattern`.
- `extracted-app`: receives the extracted app directory and can patch multiple files.

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
