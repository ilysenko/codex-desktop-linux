SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

APP_DIR ?= $(CURDIR)/codex-app
NEXT_APP_DIR ?= $(CURDIR)/codex-app-next
REBUILD_REPORT_DIR ?= $(CURDIR)/dist-next/rebuild
UPSTREAM_DEB ?=
PACKAGE_NAME := codex-desktop
PACKAGE_WITH_UPDATER ?= 1
MAX_BUILD_THREADS ?= 0
MAX_BUILD_THREADS_VALUE := $(strip $(MAX_BUILD_THREADS))
MAX_BUILD_THREADS_ENABLED := $(filter-out 0,$(MAX_BUILD_THREADS_VALUE))
CARGO_JOBS_ARG = $(if $(MAX_BUILD_THREADS_ENABLED),--jobs $(MAX_BUILD_THREADS_VALUE),)
RPM_BINARY_PAYLOAD ?= $(if $(MAX_BUILD_THREADS_ENABLED),w19T$(MAX_BUILD_THREADS_VALUE).zstdio,)
DEB_GLOB := $(CURDIR)/dist/$(PACKAGE_NAME)_*.deb
RPM_GLOB := $(CURDIR)/dist/$(PACKAGE_NAME)-*.rpm
PACMAN_GLOB := $(CURDIR)/dist/$(PACKAGE_NAME)-[0-9]*.pkg.tar.*
.DEFAULT_GOAL := help

UPSTREAM_ARG = $(if $(strip $(UPSTREAM_DEB)),"$(UPSTREAM_DEB)",)

define detect_package_format
format=""; \
if [ -r /etc/os-release ]; then . /etc/os-release; fi; \
tokens="$${ID:-} $${ID_LIKE:-}"; \
case " $$tokens " in \
  *" arch "*|*" manjaro "*|*" endeavouros "*) format=pacman ;; \
  *" fedora "*|*" rhel "*|*" centos "*|*" suse "*|*" opensuse "*) format=rpm ;; \
  *" debian "*|*" ubuntu "*|*" linuxmint "*|*" pop "*) format=deb ;; \
esac; \
[ -n "$$format" ] || { command -v dpkg-deb >/dev/null 2>&1 && format=deb; }; \
[ -n "$$format" ] || { command -v rpmbuild >/dev/null 2>&1 && format=rpm; }; \
[ -n "$$format" ] || { command -v makepkg >/dev/null 2>&1 && format=pacman; }; \
printf '%s\n' "$$format"
endef

.PHONY: help check test ci-pr ci-all build-updater maybe-build-updater build-native-feature-helpers update rebuild rebuild-install inspect-upstream build-app build-app-fresh setup-native bootstrap-native install-native update-native rebuild-next run-app deb rpm pacman appimage package install service-enable service-status clean-dist clean-state

help:
	@printf '\nChatGPT Community from the official OpenAI Linux package\n\n'
	@printf '  %-20s %s\n' 'make build-app' 'Build codex-app/ from the signed stable index'
	@printf '  %-20s %s\n' 'make rebuild' 'Build a side-by-side candidate'
	@printf '  %-20s %s\n' 'make rebuild-install' 'Build and transactionally replace codex-app/'
	@printf '  %-20s %s\n' 'make inspect-upstream' 'Verify and inspect without promoting an app'
	@printf '  %-20s %s\n' 'make setup-native' 'Configure optional Linux features'
	@printf '  %-20s %s\n' 'make bootstrap-native' 'Install build dependencies, build, package, install'
	@printf '  %-20s %s\n' 'make install-native' 'Build, package, and install for this distro'
	@printf '  %-20s %s\n' 'make deb|rpm|pacman' 'Build a native package in dist/'
	@printf '  %-20s %s\n' 'make appimage' 'Build the AppImage in dist/'
	@printf '  %-20s %s\n' 'make ci-all' 'Run the complete local CI suite'
	@printf '\nVariables:\n  UPSTREAM_DEB=/path/to/chatgpt_<version>_<arch>.deb\n  PACKAGE_WITH_UPDATER=0\n  MAX_BUILD_THREADS=8\n\n'

check:
	cargo check $(CARGO_JOBS_ARG) -p codex-update-manager

test:
	cargo test $(CARGO_JOBS_ARG) -p codex-update-manager

ci-pr:
	./scripts/ci-local.sh pr

ci-all:
	./scripts/ci-local.sh all

build-updater:
	cargo build $(CARGO_JOBS_ARG) --release -p codex-update-manager

maybe-build-updater:
	@case "$(PACKAGE_WITH_UPDATER)" in 0|false|no|off) echo '[make] updater omitted' ;; *) $(MAKE) build-updater ;; esac

build-native-feature-helpers:
	@set -e; config="$${CODEX_LINUX_FEATURES_CONFIG:-linux-features/features.json}"; \
	[ -f "$$config" ] || config=linux-features/features.example.json; \
	enabled="$$(CODEX_LINUX_FEATURES_CONFIG="$$config" node scripts/lib/linux-features.js --enabled)"; \
	has() { printf '%s\n' "$$enabled" | grep -Fxq "$$1"; }; \
	if has computer-use-linux; then cargo build $(CARGO_JOBS_ARG) --release -p codex-computer-use-linux --bin codex-computer-use-linux --bin codex-computer-use-cosmic; fi; \
	if has global-dictation; then cargo build $(CARGO_JOBS_ARG) --release --manifest-path global-dictation-linux/Cargo.toml --target-dir global-dictation-linux/target; fi; \
	if has read-aloud-mcp; then cargo build $(CARGO_JOBS_ARG) --release -p codex-read-aloud-linux; fi; \
	if has chronicle-skysight || has record-and-replay; then cargo build $(CARGO_JOBS_ARG) --release -p codex-record-replay-linux; fi; \
	if has mcp-helper-reaper; then cargo build $(CARGO_JOBS_ARG) --release --manifest-path linux-features/mcp-helper-reaper/reaper/Cargo.toml; fi

update: rebuild-install

rebuild:
	REBUILD_REPORT_DIR="$(REBUILD_REPORT_DIR)" CODEX_NEXT_APP_DIR="$(NEXT_APP_DIR)" \
		./scripts/rebuild-candidate.sh $(UPSTREAM_ARG)

rebuild-install:
	REBUILD_REPORT_DIR="$(REBUILD_REPORT_DIR)" CODEX_FINAL_APP_DIR="$(APP_DIR)" \
		./scripts/rebuild-candidate.sh --install $(UPSTREAM_ARG)

inspect-upstream:
	./install.sh --inspect --report-dir "$(REBUILD_REPORT_DIR)" $(UPSTREAM_ARG)

build-app build-app-fresh:
	CODEX_INSTALL_DIR="$(APP_DIR)" ./install.sh $(UPSTREAM_ARG)

setup-native:
	bash scripts/bootstrap-wizard.sh

bootstrap-native:
	bash scripts/install-deps.sh
	PATH="$$HOME/.cargo/bin:$$PATH" $(MAKE) install-native

install-native:
	$(MAKE) build-native-feature-helpers
	$(MAKE) build-app
	$(MAKE) package
	$(MAKE) install

update-native:
	git pull --ff-only
	$(MAKE) install-native

rebuild-next:
	CODEX_INSTALL_DIR="$(NEXT_APP_DIR)" REBUILD_REPORT_DIR="$(REBUILD_REPORT_DIR)" ./install.sh $(UPSTREAM_ARG)

run-app:
	@[ -x "$(APP_DIR)/start.sh" ] || { echo 'Run make build-app first.' >&2; exit 1; }
	"$(APP_DIR)/start.sh"

deb: maybe-build-updater
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ./scripts/build-deb.sh

rpm: maybe-build-updater
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" RPM_BINARY_PAYLOAD="$(RPM_BINARY_PAYLOAD)" ./scripts/build-rpm.sh

pacman: maybe-build-updater
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ./scripts/build-pacman.sh

appimage:
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" ./scripts/build-appimage.sh

package:
	@format="$$( $(detect_package_format) )"; \
	case "$$format" in \
	  deb) $(MAKE) deb PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ;; \
	  rpm) $(MAKE) rpm PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ;; \
	  pacman) $(MAKE) pacman PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ;; \
	  *) echo 'No supported package builder found.' >&2; exit 1 ;; \
	esac

install:
	@latest() { "$(CURDIR)/scripts/select-latest-package.sh" "$$1"; }; \
	format="$$( $(detect_package_format) )"; \
	case "$$format" in \
	  deb) artifact="$${DEB:-$$(latest '$(DEB_GLOB)')}"; [ -n "$$artifact" ]; "$(CURDIR)/scripts/sudo-with-alert.sh" dpkg -i "$$artifact" ;; \
	  rpm) artifact="$${RPM:-$$(latest '$(RPM_GLOB)')}"; [ -n "$$artifact" ]; if command -v dnf >/dev/null; then "$(CURDIR)/scripts/sudo-with-alert.sh" dnf install -y "$$artifact"; else "$(CURDIR)/scripts/sudo-with-alert.sh" rpm -Uvh "$$artifact"; fi ;; \
	  pacman) artifact="$${PKG:-$$(latest '$(PACMAN_GLOB)')}"; [ -n "$$artifact" ]; "$(CURDIR)/scripts/sudo-with-alert.sh" pacman -U --noconfirm "$$artifact" ;; \
	  *) echo 'No supported package manager found.' >&2; exit 1 ;; \
	esac

service-enable:
	systemctl --user daemon-reload
	systemctl --user enable --now codex-update-manager.service

service-status:
	systemctl --user status codex-update-manager.service --no-pager

clean-dist:
	rm -rf "$(CURDIR)/dist"

clean-state:
	rm -rf "$$HOME/.config/codex-update-manager" "$$HOME/.local/state/codex-update-manager" "$$HOME/.cache/codex-update-manager"
