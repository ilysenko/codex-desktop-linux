# Build and packaging

## Prerequisites

Baseline builds require Bash, curl, `gpgv`, `dpkg-deb`, Node.js 20+, npm,
Python 3, SHA-256 utilities, tar, make, and a C/C++ toolchain. Rust is needed
for updater/native helper release builds. Install common dependencies with:

```bash
bash scripts/install-deps.sh
```

The dependency installer supports apt, dnf/dnf5, zypper, pacman, and Gentoo
Portage. On
rpm-ostree systems, build inside Toolbox or Distrobox and copy the resulting
AppImage or native package out. Debian-derived systems use the pinned
NodeSource keyring when a newer Node.js is required; the script never pipes a
remote installer directly to a shell.

If you install dependencies manually, use `scripts/install-deps.sh` as the
authoritative package list. At minimum, the source verifier needs Bash, curl,
GnuPG, `dpkg-deb`, Node.js 20+, Python 3, SHA-256 tools, tar, and `xz`; native
packaging additionally needs the target format's package builder.

## Build the application tree

Resolve and verify the latest signed stable package for the host architecture:

```bash
./install.sh
```

This is a Linux `.deb`-only source pipeline. Retired source inputs and
compatibility variables are rejected rather than emulated; the official
Electron runtime and native modules are preserved directly.

Use an already-downloaded package to avoid downloading the package body again:

```bash
./install.sh /path/to/chatgpt_<version>_<arch>.deb
UPSTREAM_DEB=/path/to/chatgpt_<version>_<arch>.deb make build-app
```

Local packages are verified against the same signed stable metadata by default:
the pinned key authenticates `InRelease`, its digest authenticates `Packages`,
and the indexed size/SHA-256 and package control fields must match the local
file. Only metadata is fetched; the package body is reused.

All builds verify without prompting or reading user input, whether or not a
terminal is attached. Only this explicit flag selects the local exception for
this invocation:

```bash
./install.sh --skip-oai-official-sig-verification /path/to/chatgpt_<version>_<arch>.deb
```

The flag requires a local path (positional or `UPSTREAM_DEB`). It skips official
metadata discovery and its signature/version/digest comparison, while retaining
package-name, version-format, architecture, payload-completeness checks, and
SHA-256 recording. The caller owns provenance in that mode. A verification
failure never automatically chooses the exception, and the choice is not saved
to feature or updater settings. The supported compatibility baseline remains
the latest signed stable package. `scripts/rebuild-candidate.sh` accepts the
same flag.

Local verification failures distinguish an unavailable or invalid signed index
from a package that does not match the current signed stable release. They
retain the technical cause and name the explicit skip flag for an intentional
unverified local build; the failure still stops the build.

Source package formats from the retired build architecture are rejected with a
clear error and have no compatibility fallback.

Inspection writes reports without promoting an app:

```bash
make inspect-upstream
```

Generated metadata under `.codex-linux/build-info.json` uses schema v2 and
records `upstreamLinuxPackage` version, architecture, repository path, and
SHA-256.
`upstreamLinuxPackage.signatureVerification` records `verified` for successful
signed-repository verification and `skipped` for the explicit local exception;
metadata without a recorded result is `unknown`. Nix's hash-verified fixed
input uses the explicit exception during offline builds; see [Nix](nix.md).

## Running the generated app

Run the staged application without installing it:

```bash
make run-app
```

This executes `codex-app/start.sh`. The wrapper sets the Community desktop
identity, loads enabled feature hooks, and forwards arguments and URIs to the
official `ChatGPT` executable. It does not provide a second single-instance,
tray, window, or lifecycle implementation.

Useful diagnostics:

```bash
./codex-app/start.sh --help
./codex-app/start.sh --diagnose
```

## Baseline ASAR invariant

`linux-features/features.example.json` contains no enabled features. For that
configuration, enabled-feature descriptors are empty; required core descriptors
are still discovered independently. The installer skips ASAR extraction only
when both sets are empty:

| Required core descriptors | Enabled feature descriptors | ASAR handling |
|---|---|---|
| None | None | No extraction; preserve the official input ASAR byte-for-byte |
| Present | None | Extract a temporary copy and run core descriptors |
| None | Present | Extract a temporary copy and run feature descriptors |
| Present | Present | Extract a temporary copy and run both sets |

Entering the patch flow does not necessarily change bytes. The patch report
records core and feature outcomes and the official-input/staged ASAR hashes.
If no descriptor reports a change, the installer keeps the original archive;
otherwise it repacks deterministically. An enabled feature drift blocks
candidate acceptance. Do not infer a permanently empty core registry from an
empty feature configuration.

Compare `resources/app.asar` in the verified official `.deb` with the staged
app's copy to audit patching. Separately, the copy inside a custom output
package must match that output's staged ASAR; this packaging comparison does
not imply equality with the official input when patches changed it.

## Package formats

First build `codex-app/`, then choose an output:

```bash
make deb
make rpm
make pacman
make gentoo
make appimage
```

For an installed native build, `make setup-native` is only the optional-feature
wizard, `make install-native` performs build/package/install, and
`make bootstrap-native` first installs build dependencies and then performs the
same installation flow.

Shared payload logic lives in `scripts/lib/package-common.sh`. Native packages
install to `/opt/codex-desktop`, provide `/usr/bin/codex-desktop`, install a
separate **ChatGPT Community** desktop entry and community-marked icon, and may
include the updater service/update-builder.
Their dependency declarations correspond to libraries required by the official
ELF runtime. They do not install OpenAI's repository configuration.

The deb package uses the upstream dependency baseline. RPM and pacman templates
map those library capabilities to their distribution names. Native packages
adapt the upstream AppArmor policy to `/opt/codex-desktop/ChatGPT`.

AppImage uses the official bundled `codex` and does not add `--no-sandbox`.
Systems that prohibit unprivileged user namespaces receive a diagnostic instead
of an insecure automatic fallback.

### Package selection and installation

`make package` detects deb, RPM, pacman, or a Gentoo local ebuild from
`/etc/os-release` and available
tools. `make install` selects the newest matching artifact from `dist/` and
uses the distribution package manager. Gentoo defaults to a manual-update local
ebuild with no enabled features; its payload is independently checked against
signed stable metadata before Portage installation. See
[Gentoo local ebuild](native-setup.md#gentoo-local-ebuild) for restrictions and
validation scope. Build and install can also be split:

```bash
make build-app
make package
make install
```

For manual-update packages that omit the service and update-builder:

```bash
PACKAGE_WITH_UPDATER=0 make package
```

### AppImage local self-build

```bash
make build-app
make appimage
```

The result is written under `dist/`. It is not system-installed and does not
include the native-package update manager. Delete the AppImage to uninstall it.
The official runtime libraries and bundled CLI remain inside the payload; the
launcher still enforces the sandbox policy.

## Make target reference

| Target | Purpose |
|---|---|
| `make build-app` | Build `codex-app/` from signed stable metadata or `UPSTREAM_DEB` |
| `make inspect-upstream` | Verify and report without promoting an app tree |
| `make rebuild` | Build a side-by-side candidate |
| `make rebuild-install` | Build and transactionally replace the generated app |
| `make setup-native` | Configure optional features only |
| `make bootstrap-native` | Install dependencies, build, package, and install |
| `make install-native` | Build helpers/app/package and install for this distro |
| `make update-native` | Fast-forward the checkout and perform a native reinstall |
| `make run-app` | Run the generated app tree |
| `make deb\|rpm\|pacman\|gentoo\|appimage` | Build a specific artifact |
| `make clean-dist` | Remove generated package outputs |
| `make clean-state` | Remove updater config/state/cache; rollback is lost |

## Build variables and parallelism

| Variable | Default | Effect |
|---|---|---|
| `UPSTREAM_DEB` | signed stable discovery | Reuse a local package body; signed verification remains the default |
| `APP_DIR` | `./codex-app` | Generated active app directory |
| `NEXT_APP_DIR` | `./codex-app-next` | Side-by-side candidate directory |
| `PACKAGE_WITH_UPDATER` | `1` (`0` on Gentoo) | Include the native updater when supported |
| `PACKAGE_VERSION` | upstream-derived | Override wrapper package version for release work |
| `MAX_BUILD_THREADS` | `0` | Limit Cargo and package-compression jobs; `0` uses tool defaults |
| `CODEX_LINUX_FEATURES_CONFIG` | local or example config | Select the feature configuration |

Example:

```bash
MAX_BUILD_THREADS=4 PACKAGE_WITH_UPDATER=0 make install-native
```

## Update-builder payload

`stage_update_builder_bundle()` in
[`scripts/lib/package-common.sh`](../scripts/lib/package-common.sh) assembles
the minimal rebuild payload under `/opt/codex-desktop/update-builder/` in native
package staging. It contains only source verification/extraction,
feature selection/descriptors/resources, the ASAR toolchain, package templates,
required build helpers, and already staged release executables for enabled
native features. It excludes the full repository, Cargo workspaces, and
disabled features, and never contains an app-runtime Node installation.

## Cross-format validation

Payload, launcher, updater, feature framework, or package-common changes affect
all formats unless explicitly scoped. Run:

```bash
bash tests/scripts_smoke.sh
./scripts/ci-local.sh pr
./scripts/ci-local.sh all
```

Inspect the final packages for the `ChatGPT` ELF, the ASAR identity/report
contract above, bundled commands, desktop files, AppArmor policy, update-builder,
and absence of upstream package-manager configuration.

Package inspection should also confirm the payload architecture matches the
builder (`amd64` or `arm64`), the desktop entry says **ChatGPT Community**, and
the package neither installs nor depends on OpenAI's APT source or maintainer
scripts.
