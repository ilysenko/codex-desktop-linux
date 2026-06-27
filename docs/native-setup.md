# Native Setup

This project has two native install entrypoints:

- `make bootstrap-native` for the fastest non-interactive first install.
- `make setup-native` for a guided checklist and optional Linux feature picker.

## Fast Native Install

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
make bootstrap-native
```

`make bootstrap-native` installs build dependencies, regenerates `codex-app/`,
validates the cached upstream `Codex.dmg` and downloads it only when missing or
stale, builds the matching native package, and installs the newest artifact
from `dist/`.

If dependencies are already installed:

```bash
make install-native
```

## Guided Setup

```bash
make setup-native
```

The wizard detects your distro, package manager, native package format, desktop
session, GUI prompt helpers, `pkexec`, portal status, installed package state,
updater state, and optional Linux feature manifests.

It can write the git-ignored `linux-features/features.json` file for the next
build. You can choose features by id, number, or range in the prompt.

The wizard is intentionally separate from `make bootstrap-native`,
`make install-native`, `make package`, and `make install`, which stay
non-interactive for scripts and CI.

## Non-Interactive Feature Selection

```bash
CODEX_LINUX_FEATURES=remote-mobile-control,read-aloud \
CODEX_LINUX_DISABLE_FEATURES=conversation-mode \
PACKAGE_WITH_UPDATER=0 \
CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
make setup-native
```

To have the wizard orchestrate existing install commands, opt in explicitly:

```bash
CODEX_BOOTSTRAP_DRY_RUN=1 \
CODEX_BOOTSTRAP_INSTALL_DEPS=1 \
CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
make setup-native
```

```bash
CODEX_BOOTSTRAP_INSTALL_DEPS=1 \
CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
make setup-native
```

Build-time feature changes only apply after rebuilding and reinstalling:

```bash
make install-native
```

For manual-update packages:

```bash
PACKAGE_WITH_UPDATER=0 make install-native
```

## Feature Cleanup

Disabling a feature in `features.json` affects the next rebuild. It does not
delete local device keys, Read Aloud model files, plugin caches, Python
runtimes, or services.

Feature cleanup is separate and interactive:

```bash
CODEX_BOOTSTRAP_CLEANUP_FEATURES=remote-mobile-control,read-aloud make setup-native
```

Each deletion requires typing `DELETE <exact path>`. Preview cleanup targets:

```bash
CODEX_BOOTSTRAP_DRY_RUN=1 \
CODEX_BOOTSTRAP_CLEANUP_FEATURES=remote-mobile-control,read-aloud \
make setup-native
```

## Color Output

The wizard uses ANSI color when the terminal supports it.

```bash
CODEX_BOOTSTRAP_COLOR=0 make setup-native  # disable
CODEX_BOOTSTRAP_COLOR=1 make setup-native  # force
```
