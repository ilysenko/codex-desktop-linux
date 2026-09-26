# Native setup

This guide covers a native `codex-desktop` installation built from OpenAI's
official signed Linux package. The installed desktop entry is **ChatGPT
Community**; the package, command, and installation directory remain
`codex-desktop` and `/opt/codex-desktop`.

## Fast native install

On a supported Debian/Ubuntu, Fedora, openSUSE, Arch-derived, or compatible
distribution:

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
make bootstrap-native
```

`bootstrap-native` runs the dependency installer, builds any release helpers
needed by enabled features, verifies and stages the official application,
builds the package format detected for the distribution, and installs the
newest artifact from `dist/`.

If dependencies are already present:

```bash
make install-native
```

`install-native` does not open the feature wizard. With no local feature file,
it uses the committed empty configuration and preserves the official ASAR.

## Guided feature setup

Run the wizard before installation when you want optional features:

```bash
make setup-native
make install-native
```

The wizard:

1. checks the supported architecture and available tools;
2. lists repository and user-local feature manifests;
3. shows feature requirements, conflicts, and warnings;
4. writes the gitignored `linux-features/features.json`;
5. selects whether native packages include the updater;
6. optionally previews narrowly scoped feature-data cleanup.

It never enables a feature implicitly, and setup alone does not build or
install anything. Read the README inside each selected feature directory.

## Non-interactive setup

CI, repeatable local installs, and scripted test machines can configure the
wizard through environment variables:

```bash
CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
CODEX_LINUX_FEATURES=read-aloud,ui-tweaks \
CODEX_LINUX_DISABLE_FEATURES=pet-overlay \
PACKAGE_WITH_UPDATER=1 \
make setup-native

make install-native
```

Useful controls:

| Variable | Meaning |
|---|---|
| `CODEX_BOOTSTRAP_NONINTERACTIVE=1` | Never prompt |
| `CODEX_BOOTSTRAP_DRY_RUN=1` | Preview install and cleanup actions |
| `CODEX_BOOTSTRAP_INSTALL_DEPS=1` | Run `scripts/install-deps.sh` after checks |
| `CODEX_BOOTSTRAP_INSTALL_NATIVE=1` | Run `make install-native` after checks |
| `CODEX_LINUX_FEATURES=a,b` | Enable the listed feature IDs |
| `CODEX_LINUX_DISABLE_FEATURES=a,b` | Disable the listed IDs |
| `CODEX_LINUX_FEATURES_CONFIG=/path/file.json` | Use another local config path |
| `CODEX_BOOTSTRAP_COLOR=auto\|1\|0` | Auto-detect, force, or disable ANSI color |
| `PACKAGE_WITH_UPDATER=0` | Build a manual-update native package |

A combined non-interactive run is possible:

```bash
CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
CODEX_BOOTSTRAP_INSTALL_DEPS=1 \
CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
CODEX_LINUX_FEATURES=read-aloud \
bash scripts/bootstrap-wizard.sh
```

## Build from a local package

For an official package already downloaded from a source you trust:

```bash
UPSTREAM_DEB=/absolute/path/chatgpt_<version>_<arch>.deb make install-native
```

The build checks control metadata, architecture, required payload, and records
the computed SHA-256. It does not independently prove the file's provenance,
because signed repository discovery is intentionally skipped for explicit
local input.

## Native helper builds

Most optional features are JavaScript descriptors or declarative resources.
When an enabled feature needs a Rust helper, `make install-native` builds it
once in release mode before staging the application. The packaged update-builder
reuses these executables during future official-package updates and never ships
or runs the full Cargo workspace.

To limit local build concurrency:

```bash
MAX_BUILD_THREADS=4 make install-native
```

## Feature cleanup

Disabling a feature controls the next build but does not automatically delete
feature-owned user data. Preview a supported cleanup first:

```bash
CODEX_BOOTSTRAP_DRY_RUN=1 \
CODEX_BOOTSTRAP_CLEANUP_FEATURES=remote-mobile-control,read-aloud \
make setup-native
```

Then rerun without `CODEX_BOOTSTRAP_DRY_RUN=1` and confirm the exact paths.
The wizard refuses paths outside known feature-owned locations. Remote Mobile
Control device keys should be revoked before deletion. Read Aloud models,
Python environments, and plugin caches are removed only when their exact paths
are explicitly confirmed.

## Verify the installation

```bash
command -v codex-desktop
codex-desktop --diagnose
systemctl --user status codex-update-manager.service --no-pager
```

The official `chatgpt` and Community `codex-desktop` packages can coexist. By
default both retain the upstream `Codex` user profile, so fully exit one before
starting the other. Enable `community-profile-isolation` when Community needs a
separate Codex state directory, Electron profile, and bundled-CLI child path.

## Uninstall

Use the commands in the main [Uninstall guide](../README.md#uninstall). Native
package removal preserves user data and should disable the update service. Do
not delete `~/.codex` unless you intend to delete shared Codex state.
