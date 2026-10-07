# Native setup

This guide covers a native `codex-desktop` installation built from OpenAI's
official signed Linux package. The installed desktop entry is **ChatGPT
Community**; the package, command, and installation directory remain
`codex-desktop` and `/opt/codex-desktop`.

## Fast native install

On a supported Debian/Ubuntu, Fedora, openSUSE, Arch-derived, Gentoo, or compatible
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

## Guided installer

After cloning the repository, launch the standalone installer:

```bash
./install-community
```

`make guided-install` is an alias for the same flow. The installer is not a
Linux feature and never appears in the feature list.

On graphical desktops with GTK4/PyGObject, the installer runs a multi-step
flow:

1. choose optional features; requirements are selected automatically and
   conflicting rows are disabled with a visible explanation;
2. choose updater/dependency options while the native package identity remains fixed;
3. review the resolved configuration;
4. build, package, and install while a stage progress bar and live log remain
   visible.

The graphical installer does not change feature implementation files or feature
settings. It updates the enabled-feature list and its own installer preferences
in the gitignored `linux-features/features.json`, preserving any existing
feature settings unchanged.

Native output always keeps the repository package identity
`codex-desktop` under `/opt/codex-desktop`. The updater choice controls only
whether the update manager is included; it never changes the package name,
executable identity, or installation root.

On systems without the GTK picker, `./install-community` falls back to the
existing terminal guided setup.

To configure features without installing yet, use:

```bash
make setup-native
make install-native
```

Setup alone does not build or install anything. Read the README inside each
selected feature directory.

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

## Gentoo local ebuild

The canonical entry remains `make bootstrap-native`. On Gentoo it selects a
Portage-managed local ebuild rather than `.deb`, even if `dpkg-deb` is present:

```bash
mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop-dev/tmp"
export TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop-dev/tmp"
make bootstrap-native UPSTREAM_DEB=/absolute/path/chatgpt_<version>_amd64.deb
```

The Gentoo implementation supports glibc hosts and defaults to
`PACKAGE_WITH_UPDATER=0`. Only features explicitly audited with
`gentoo.supported: true` are accepted; none of the repository features has this
declaration yet, so the supported repository configuration remains empty.
Unsupported features or an explicitly enabled updater are rejected before
building the application. The updater-mode check precedes dependency
installation; feature checks run after Node is available.
On Gentoo, `./install-community` uses this canonical terminal bootstrap instead
of the graphical feature wizard. Gentoo requires Node.js 22.12.0 or newer with
npm for the default ASAR tooling. Portage owns the files in
`/opt/codex-desktop`, `/usr/bin/codex-desktop`, and the community desktop entry
and icon. It does not install the official `chatgpt` identity or maintainer
scripts. The application is selected in Portage's world set so depclean does
not remove it. The application merge ignores `EMERGE_DEFAULT_OPTS` and disables
binary-package reuse/fetching so it installs the verified local payload through
the generated ebuild; this does not change global Portage configuration.
Update by rerunning the same Make command with the latest signed
stable package.

The regular-user builder stages the existing shared native layout, revalidates
its input provenance against the pinned signed stable index (including explicit
local deb input), and generates `dist/gentoo/repository/`. `make gentoo` performs
this packaging step alone after `make build-app`. The generated ebuild unpacks
its Manifest-checked local DISTDIR payload into Portage's image directory; it does not
run `make`, download upstream sources, invoke sudo, or bypass Portage.
Binary-payload extraction explicitly preserves modes rather than using the
source-oriented default `unpack` permission normalization; archive ownership
is not restored.

The [Gentoo feature contract](linux-features-architecture.md#gentoo-feature-contract)
separates regular-user `bootstrap` dependencies from the generated ebuild's
`BDEPEND`, `DEPEND`, `RDEPEND`, and `IDEPEND`. Bootstrap resolves enabled feature
build tools before `make install-native` compiles helpers or stages the app;
these tools do not become package runtime dependencies. Version, slot/subslot,
and unconditional USE constraints are supported, and the host's EAPI 8 Portage
parser validates all declared atoms. Masks, keywords, licenses, and USE policy
for feature dependencies are not automatically relaxed. Direct
`make install-native` assumes bootstrap tools are already installed.
Gentoo packaging requires Python with Portage, as supplied on a Gentoo host.

Audited features may use `packageResources` and ordinary user-space
`packageHooks` with `formats: ["ebuild"]`. External resources must be below
`usr/` or `etc/`, outside `/opt/codex-desktop`; their modes survive packaging
and Portage's image copy. Hooks run after resource staging and before permission
normalization, not as root during merge. A hook failure or unsupported staging
root rejects packaging. No feature hook is embedded in `pkg_*`, and this
framework does not add updater services or systemd-dependent integration.

Dependency installation and repository deployment use the same
`scripts/sudo-with-alert.sh` mechanism as other native formats. Installation
deploys a dedicated generated repository to `/var/db/repos/codex-desktop-local`
and registers `/etc/portage/repos.conf/codex-desktop-local.conf`. It creates
package-scoped keyword/license files named `codex-desktop-local` under
`package.accept_keywords` and `package.license`; global Portage policy is not
changed. Unmanaged files at these exact paths are never overwritten.
All protected targets are checked before deployment begins. Repository,
configuration, and newly introduced distfiles are staged beside their targets;
a failed deployment or Portage invocation restores the previous generation.
Concurrent installers are serialized, and recovery copies are retained if
restoration itself fails.

The repository's scripts and ebuild template are MIT-licensed. This does not
relicense OpenAI's application payload or its third-party components. Their
license files are preserved. The generated ebuild declares `MIT` plus
`all-rights-reserved` conservatively for the application, and restricts binary
redistribution/mirroring. These are local build artifacts, not published
community binary releases.

To verify or remove the native package:

```bash
portageq match / app-misc/codex-desktop
/usr/bin/codex-desktop --diagnose
sudo emerge --unmerge app-misc/codex-desktop
```

A user-local AppImage command or desktop entry may still shadow the native
entry. The package installer preserves these user files; use the explicit
`/usr/bin/codex-desktop` path to test the native installation. User profiles,
proxy settings, and a `CODEX_CLI_PATH` override are independent of package
ownership. Both installations normally share the upstream profile, so exit
one before launching the other.

After unmerging, the dedicated local repository and its three generated
Portage configuration files can be removed if no longer needed. Existing
repositories and global Portage configuration are not part of this cleanup.

For a stable-only dependency audit, after generating the local repository:

```bash
bash scripts/sudo-with-alert.sh env TMPDIR="$TMPDIR" \
  bash tests/gentoo_stable_dependencies.sh dist/gentoo/repository
```

This read-only emerge plan runs in a transient mount namespace/chroot with a
separate Portage configuration and no host VDB. It allows only stable `::gentoo`
dependencies; only the local application gets a scoped testing keyword. A
stable-version stage3/toolchain baseline is recorded as `package.provided` to
avoid trying to bootstrap Gentoo from zero. Documentation tooling uses the
temporary `dev-python/pillow -truetype` source-bootstrap setting in this isolated
configuration; no host USE settings change. It tests dependency visibility and
resolution, not compilation of the stable libraries or runtime on a separately
installed stable Gentoo system. Scratch is removed when the audit exits.

The stable-only audit was run once on 2026-10-03 for official package
`26.930.31730` against that day's Gentoo tree and machine state, before the
subsequent `emerge -uvDN @world`; it has not been rerun for the updated host or
newer official packages. Local install/launch testing uses OpenRC and KDE Plasma
Wayland; a Gentoo systemd environment has not been tested.

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
