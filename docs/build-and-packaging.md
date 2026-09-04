# Build and packaging

## Prerequisites

Baseline builds require Bash, curl, `gpgv`, `dpkg-deb`, Node.js 20+, npm,
Python 3, SHA-256 utilities, tar, make, and a C/C++ toolchain. Rust is needed
for updater/native helper release builds. Install common dependencies with:

```bash
bash scripts/install-deps.sh
```

The dependency installer supports apt, dnf/dnf5, zypper, and pacman. On
rpm-ostree systems, build inside Toolbox or Distrobox and copy the resulting
AppImage or native package out. Debian-derived systems use the pinned
NodeSource keyring when a newer Node.js is required; the script never pipes a
remote installer directly to a shell.

Native packages built with the update manager declare Node.js 24 or newer as a
runtime dependency. On Debian-derived systems, the dependency bootstrap uses
the signed NodeSource repository to install the latest available 24.x LTS
release when the distro package is too old.

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

Use an explicit already-downloaded package that you trust:

```bash
./install.sh /path/to/chatgpt_<version>_<arch>.deb
UPSTREAM_DEB=/path/to/chatgpt_<version>_<arch>.deb make build-app
```

The explicit package is validated for package name, version, architecture, and
required payload, and its SHA-256 is recorded in build metadata. Supplying a
local file deliberately skips signed repository discovery, so the caller is
responsible for its provenance. Source package formats from the retired build
architecture are rejected with a clear error and have no compatibility
fallback.

Inspection writes reports without promoting an app:

```bash
make inspect-upstream
```

Generated metadata under `.codex-linux/build-info.json` uses schema v2 and
records `upstreamLinuxPackage` version, architecture, repository path, and
SHA-256.

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
configuration, the installer copies `resources/app.asar` directly and compares
its SHA-256 with the package payload. No ASAR extraction tool runs.

If a selected feature contains patch descriptors, the installer patches a
temporary extraction, repacks deterministically, and writes a feature-aware
patch report. An enabled feature drift blocks candidate acceptance.

## Package formats

First build `codex-app/`, then choose an output:

```bash
make deb
make rpm
make pacman
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

`make package` detects deb, RPM, or pacman from `/etc/os-release` and available
tools. `make install` selects the newest matching artifact from `dist/` and
uses the distribution package manager. Build and install can also be split:

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
| `make deb\|rpm\|pacman\|appimage` | Build a specific artifact |
| `make clean-dist` | Remove generated package outputs |
| `make clean-state` | Remove updater config/state/cache; rollback is lost |

## Build variables and parallelism

| Variable | Default | Effect |
|---|---|---|
| `UPSTREAM_DEB` | signed stable discovery | Use an explicitly trusted local official package |
| `APP_DIR` | `./codex-app` | Generated active app directory |
| `NEXT_APP_DIR` | `./codex-app-next` | Side-by-side candidate directory |
| `PACKAGE_WITH_UPDATER` | `1` | Include the native updater when supported |
| `PACKAGE_VERSION` | upstream-derived | Override wrapper package version for release work |
| `MAX_BUILD_THREADS` | `0` | Limit Cargo and package-compression jobs; `0` uses tool defaults |
| `CODEX_LINUX_FEATURES_CONFIG` | local or example config | Select the feature configuration |

Example:

```bash
MAX_BUILD_THREADS=4 PACKAGE_WITH_UPDATER=0 make install-native
```

## Update-builder payload

`packaging/update-builder/` contains only source verification/extraction,
feature selection/descriptors/resources, the ASAR toolchain, package templates,
required build helpers, and already staged release executables for enabled
native features. It excludes the full repository, Cargo workspaces, and
disabled features, and never contains an app-runtime Node installation.
The update manager executes the host's packaged Node.js 24+ runtime.

## Cross-format validation

Payload, launcher, updater, feature framework, or package-common changes affect
all formats unless explicitly scoped. Run:

```bash
bash tests/scripts_smoke.sh
./scripts/ci-local.sh pr
./scripts/ci-local.sh all
```

Inspect the final packages for the `ChatGPT` ELF, byte identity of clean
`app.asar`, bundled commands, desktop files, AppArmor policy, update-builder,
and absence of upstream package-manager configuration.

Package inspection should also confirm the payload architecture matches the
builder (`amd64` or `arm64`), the desktop entry says **ChatGPT Community**, and
the package neither installs nor depends on OpenAI's APT source or maintainer
scripts.
