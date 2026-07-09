SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

APP_DIR := $(CURDIR)/codex-app
NEXT_APP_DIR := $(CURDIR)/codex-app-next
REBUILD_REPORT_DIR := $(CURDIR)/dist-next/rebuild
UPSTREAM_INTEL_CANDIDATE ?= $(strip $(DMG))
UPSTREAM_INTEL_HOST_CANDIDATE := $(if $(strip $(UPSTREAM_INTEL_CANDIDATE)),$(UPSTREAM_INTEL_CANDIDATE),$(CURDIR)/Codex.dmg)
UPSTREAM_INTEL_BASELINE ?=
UPSTREAM_INTEL_PATCH_REPORT ?= $(REBUILD_REPORT_DIR)/patch-report.json
UPSTREAM_INTEL_IMAGE ?= codex-desktop-linux-devcontainer:local
PACKAGE_NAME := codex-desktop
PACKAGE_WITH_UPDATER ?= 1
MAX_BUILD_THREADS ?= 0
MAX_BUILD_THREADS_VALUE := $(strip $(MAX_BUILD_THREADS))
MAX_BUILD_THREADS_ENABLED := $(filter-out 0,$(MAX_BUILD_THREADS_VALUE))
ifneq ($(MAX_BUILD_THREADS_ENABLED),)
RPM_BINARY_PAYLOAD ?= w19T$(MAX_BUILD_THREADS_VALUE).zstdio
else
RPM_BINARY_PAYLOAD ?=
endif
CARGO_JOBS_ARG = $(if $(MAX_BUILD_THREADS_ENABLED),--jobs $(MAX_BUILD_THREADS_VALUE),)
DEV_APP_ID ?= codex-cua-lab
DEV_APP_NAME ?= Codex CUA Lab
DEV_APP_DIR ?= $(CURDIR)/$(DEV_APP_ID)-app
DEV_APP_BIN ?= $(CURDIR)/bin/$(DEV_APP_ID)
DEB_GLOB := $(CURDIR)/dist/$(PACKAGE_NAME)_*.deb
RPM_GLOB := $(CURDIR)/dist/$(PACKAGE_NAME)-*.rpm
PACMAN_GLOB := $(CURDIR)/dist/$(PACKAGE_NAME)-[0-9]*.pkg.tar.*
.DEFAULT_GOAL := help

NATIVE_PKG_FORMAT_CMD = format=""; \
os_release_token_match() { \
	local expected token; \
	for token in $${ID:-} $${ID_LIKE:-}; do \
		for expected in "$$@"; do \
			if [ "$$token" = "$$expected" ]; then \
				return 0; \
			fi; \
		done; \
	done; \
	return 1; \
}; \
if [ -r /etc/os-release ]; then . /etc/os-release; \
	if os_release_token_match arch archlinux manjaro endeavouros artix; then \
		format="pacman"; \
	elif os_release_token_match fedora rhel centos rocky almalinux ol sles suse opensuse; then \
		format="rpm"; \
	elif os_release_token_match debian ubuntu linuxmint pop elementary zorin; then \
		format="deb"; \
	fi; \
fi; \
if [ -z "$$format" ]; then \
	if command -v pacman >/dev/null 2>&1 && ! command -v dpkg-deb >/dev/null 2>&1; then \
		format="pacman"; \
	elif command -v rpmbuild >/dev/null 2>&1 && ! command -v dpkg-deb >/dev/null 2>&1; then \
		format="rpm"; \
	elif command -v dpkg-deb >/dev/null 2>&1; then \
		format="deb"; \
	elif command -v rpmbuild >/dev/null 2>&1; then \
		format="rpm"; \
	elif command -v pacman >/dev/null 2>&1; then \
		format="pacman"; \
	fi; \
fi; \
printf '%s\n' "$$format"

.PHONY: help check test build-updater maybe-build-updater update rebuild rebuild-install inspect-upstream inspect-upstream-intel inspect-upstream-intel-devcontainer build-app build-app-fresh setup-native bootstrap-native install-native update-native rebuild-next run-app build-dev-app run-dev-app deb rpm pacman appimage package install service-enable service-status clean-dist clean-state

help:
	@printf '\nCodex Desktop Linux Make Targets\n\n'
	@printf '  %-18s %s\n' "make check" "Run cargo check for codex-update-manager"
	@printf '  %-18s %s\n' "make test" "Run updater test suite"
	@printf '  %-18s %s\n' "make build-updater" "Build codex-update-manager in release mode"
	@printf '  %-18s %s\n' "make update" "Find a DMG, rebuild, and replace codex-app/ with backup"
	@printf '  %-18s %s\n' "make rebuild" "Inspect a DMG and build a side-by-side candidate"
	@printf '  %-18s %s\n' "make rebuild-install" "Find a DMG, rebuild, and install into codex-app/"
	@printf '  %-18s %s\n' "make inspect-upstream" "Inspect a DMG and write rebuild reports without changing codex-app/"
	@printf '  %-18s %s\n' "make inspect-upstream-intel" "Inventory protected upstream DMG surfaces and write drift reports"
	@printf '  %-18s %s\n' "make inspect-upstream-intel-devcontainer" "Run upstream DMG intelligence inside the devcontainer image"
	@printf '  %-18s %s\n' "make build-app" "Run install.sh and regenerate codex-app/ (reuses cached Codex.dmg)"
	@printf '  %-18s %s\n' "make build-app-fresh" "Remove generated app and refresh cached Codex.dmg by default"
	@printf '  %-18s %s\n' "make setup-native" "Guided setup summary and Linux feature config helper"
	@printf '  %-18s %s\n' "make bootstrap-native" "Install deps, validate/reuse DMG, package, and install"
	@printf '  %-18s %s\n' "make install-native" "Clean-build, validate/reuse DMG, package, and install"
	@printf '  %-18s %s\n' "make update-native" "Pull trusted checkout, validate/reuse DMG, package, and install"
	@printf '  %-18s %s\n' "make rebuild-next" "Build a side-by-side candidate in codex-app-next/"
	@printf '  %-18s %s\n' "make run-app" "Launch the local generated Electron app from codex-app/"
	@printf '  %-18s %s\n' "make build-dev-app" "Build a side-by-side test app with a distinct app id/bin"
	@printf '  %-18s %s\n' "make run-dev-app" "Launch the side-by-side test app"
	@printf '  %-18s %s\n' "make deb" "Build the Debian package into dist/"
	@printf '  %-18s %s\n' "make rpm" "Build the RPM package into dist/ (Fedora/openSUSE)"
	@printf '  %-18s %s\n' "make pacman" "Build the pacman package into dist/ (Arch)"
	@printf '  %-18s %s\n' "make appimage" "Build the AppImage into dist/ (local self-build)"
	@printf '  %-18s %s\n' "make package" "Build native package (auto-detects deb, rpm, or pacman)"
	@printf '  %-18s %s\n' "make install" "Install the latest generated native package"
	@printf '  %-18s %s\n' "make service-enable" "Enable and start codex-update-manager.service for the current user"
	@printf '  %-18s %s\n' "make service-status" "Show codex-update-manager.service status for the current user"
	@printf '  %-18s %s\n' "make clean-dist" "Remove generated dist/ artifacts"
	@printf '  %-18s %s\n' "make clean-state" "Remove updater runtime state from XDG directories"
	@printf '\nVariables:\n\n'
	@printf '  %-18s %s\n' "DMG=/path/file.dmg" "Override the DMG; devcontainer intel downloads latest when omitted"
	@printf '  %-18s %s\n' "UPSTREAM_INTEL_BASELINE=..." "Optional known-good DMG/.app; defaults to ./Codex.dmg when different"
	@printf '  %-18s %s\n' "UPSTREAM_INTEL_PATCH_REPORT=..." "Optional patch-report.json folded into upstream intelligence drift"
	@printf '  %-18s %s\n' "UPSTREAM_INTEL_IMAGE=..." "Docker image for make inspect-upstream-intel-devcontainer"
	@printf '  %-18s %s\n' "NEXT_APP_DIR=..." "Override side-by-side rebuild candidate directory"
	@printf '  %-18s %s\n' "APP_DIR=..." "Override final app directory for make rebuild-install"
	@printf '  %-18s %s\n' "REBUILD_REPORT_DIR=..." "Override inspect/rebuild report output directory"
	@printf '  %-18s %s\n' "DEV_APP_ID=..." "Override side-by-side test app id/bin (default: codex-cua-lab)"
	@printf '  %-18s %s\n' "DEV_APP_NAME=..." "Override side-by-side test app display name"
	@printf '  %-18s %s\n' "PACKAGE_VERSION=..." "Override the package version for make deb / make rpm / make pacman / make appimage"
	@printf '  %-18s %s\n' "PACKAGE_WITH_UPDATER=0" "Build packages without codex-update-manager or the updater service"
	@printf '  %-18s %s\n' "MAX_BUILD_THREADS=8" "Set supported build jobs/compression threads (default: 0, tool/user defaults)"
	@printf '  %-18s %s\n' "RPM_BINARY_PAYLOAD=..." "Advanced RPM payload flags override (default follows MAX_BUILD_THREADS)"
	@printf '  %-18s %s\n' "APPIMAGETOOL=..." "Override the appimagetool executable for make appimage"
	@printf '  %-18s %s\n' "DEB=/path/file.deb" "Override the .deb used by make install"
	@printf '  %-18s %s\n' "RPM=/path/file.rpm" "Override the .rpm used by make install"
	@printf '  %-18s %s\n' "PKG=/path/file.pkg.tar.zst" "Override the pacman package used by make install"
	@printf '\nExamples:\n\n'
	@printf '  %s\n' "make update"
	@printf '  %s\n' "make rebuild-install"
	@printf '  %s\n' "make rebuild DMG=/tmp/Codex.dmg"
	@printf '  %s\n' "make build-app DMG=/tmp/Codex.dmg"
	@printf '  %s\n' "make build-app-fresh"
	@printf '  %s\n' "make setup-native"
	@printf '  %s\n' "make bootstrap-native"
	@printf '  %s\n' "make install-native"
	@printf '  %s\n' "PACKAGE_WITH_UPDATER=0 make update-native"
	@printf '  %s\n' "make inspect-upstream DMG=/tmp/Codex.dmg"
	@printf '  %s\n' "make inspect-upstream-intel DMG=/tmp/Codex-new.dmg"
	@printf '  %s\n' "make inspect-upstream-intel-devcontainer"
	@printf '  %s\n' "make inspect-upstream-intel-devcontainer DMG=/tmp/Codex-new.dmg"
	@printf '  %s\n' "make rebuild-next DMG=/tmp/Codex.dmg"
	@printf '  %s\n' "make run-app"
	@printf '  %s\n' "make build-dev-app"
	@printf '  %s\n' "./bin/codex-cua-lab"
	@printf '  %s\n' "make deb PACKAGE_VERSION=2026.03.24.220723+88f07cd3"
	@printf '  %s\n' "make rpm PACKAGE_VERSION=2026.03.24.220723+88f07cd3"
	@printf '  %s\n' "MAX_BUILD_THREADS=8 make install-native"
	@printf '  %s\n' "MAX_BUILD_THREADS=8 make rpm"
	@printf '  %s\n' "make pacman PACKAGE_VERSION=2026.03.24.220723+88f07cd3"
	@printf '  %s\n' "make appimage PACKAGE_VERSION=2026.03.24.220723+88f07cd3"
	@printf '  %s\n' "make install"
	@printf '  %s\n\n' "make service-enable"

check:
	@echo "[make] Running cargo check"
	cargo check $(CARGO_JOBS_ARG) -p codex-update-manager

test:
	@echo "[make] Running cargo test"
	cargo test $(CARGO_JOBS_ARG) -p codex-update-manager

build-updater:
	@echo "[make] Building codex-update-manager (release)"
	cargo build $(CARGO_JOBS_ARG) --release -p codex-update-manager

maybe-build-updater:
	@case "$(PACKAGE_WITH_UPDATER)" in \
		0|false|False|FALSE|no|No|NO|off|Off|OFF) \
			echo "[make] Skipping codex-update-manager build (PACKAGE_WITH_UPDATER=0)" ;; \
		*) \
			$(MAKE) build-updater ;; \
	esac

update: rebuild-install

rebuild:
	@echo "[make] Running safe rebuild flow"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" \
	REBUILD_REPORT_DIR="$(REBUILD_REPORT_DIR)" \
	CODEX_NEXT_APP_DIR="$(NEXT_APP_DIR)" \
		./scripts/rebuild-candidate.sh "$(DMG)"

rebuild-install:
	@echo "[make] Running rebuild and local install flow"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" \
	REBUILD_REPORT_DIR="$(REBUILD_REPORT_DIR)" \
	CODEX_NEXT_APP_DIR="$(NEXT_APP_DIR)" \
	CODEX_FINAL_APP_DIR="$(APP_DIR)" \
		./scripts/rebuild-candidate.sh --install "$(DMG)"

inspect-upstream:
	@echo "[make] Inspecting upstream DMG"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" ./install.sh --inspect --report-dir "$(REBUILD_REPORT_DIR)" "$(DMG)"

inspect-upstream-intel:
	@echo "[make] Building upstream DMG intelligence report"
	@args=(--candidate "$(UPSTREAM_INTEL_HOST_CANDIDATE)"); \
	if [ -n "$(UPSTREAM_INTEL_BASELINE)" ]; then \
		args+=("--baseline" "$(UPSTREAM_INTEL_BASELINE)"); \
	fi; \
	if [ -f "$(UPSTREAM_INTEL_PATCH_REPORT)" ]; then \
		args+=("--patch-report" "$(UPSTREAM_INTEL_PATCH_REPORT)"); \
	fi; \
	node scripts/dev/upstream-dmg-intel.js "$${args[@]}"

inspect-upstream-intel-devcontainer:
	@echo "[make] Building upstream DMG intelligence report in devcontainer"
	@args=(--image "$(UPSTREAM_INTEL_IMAGE)"); \
	if [ -n "$(UPSTREAM_INTEL_CANDIDATE)" ]; then \
		args+=("--candidate" "$(UPSTREAM_INTEL_CANDIDATE)"); \
	fi; \
	if [ -n "$(UPSTREAM_INTEL_BASELINE)" ]; then \
		args+=("--baseline" "$(UPSTREAM_INTEL_BASELINE)"); \
	fi; \
	if [ -f "$(UPSTREAM_INTEL_PATCH_REPORT)" ]; then \
		args+=("--patch-report" "$(UPSTREAM_INTEL_PATCH_REPORT)"); \
	fi; \
	scripts/dev/upstream-dmg-intel-devcontainer "$${args[@]}"

build-app:
	@echo "[make] Regenerating codex-app from DMG"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" ./install.sh "$(DMG)"

build-app-fresh:
	@echo "[make] Regenerating codex-app from fresh DMG"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" ./install.sh --fresh "$(DMG)"

setup-native:
	@echo "[make] Running guided native setup"
	bash scripts/bootstrap-wizard.sh

bootstrap-native:
	@echo "[make] Installing native build dependencies"
	bash scripts/install-deps.sh
	PATH="$$HOME/.cargo/bin:$$PATH" $(MAKE) install-native

install-native:
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" ./install.sh --fresh --reuse-dmg "$(DMG)"
	$(MAKE) package
	$(MAKE) install
	@echo "[make] Native package install complete"

update-native:
	@echo "[make] Updating trusted checkout"
	git pull --ff-only
	$(MAKE) install-native

rebuild-next:
	@echo "[make] Building side-by-side rebuild candidate"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" \
	CODEX_INSTALL_DIR="$(NEXT_APP_DIR)" \
	CODEX_PATCH_REPORT_JSON="$(REBUILD_REPORT_DIR)/patch-report.json" \
	CODEX_REBUILD_REPORT_JSON="$(REBUILD_REPORT_DIR)/rebuild-report.json" \
	REBUILD_REPORT_DIR="$(REBUILD_REPORT_DIR)" \
		./install.sh "$(DMG)"
	@echo "[make] Candidate app: $(NEXT_APP_DIR)"
	@echo "[make] Rebuild report: $(REBUILD_REPORT_DIR)/rebuild-report.json"

run-app:
	@echo "[make] Launching local Electron app"
	@[ -x "$(APP_DIR)/start.sh" ] || { echo "[make] Missing launcher: $(APP_DIR)/start.sh. Run make build-app first." >&2; exit 1; }
	"$(APP_DIR)/start.sh"

build-dev-app:
	@echo "[make] Building side-by-side Electron app as $(DEV_APP_ID)"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" \
	CODEX_APP_ID="$(DEV_APP_ID)" \
	CODEX_APP_DISPLAY_NAME="$(DEV_APP_NAME)" \
	CODEX_INSTALL_DIR="$(DEV_APP_DIR)" \
		./install.sh "$(DMG)"
	@mkdir -p "$(CURDIR)/bin"
	@ln -sfn "$$(realpath --relative-to="$$(dirname "$(DEV_APP_BIN)")" "$(DEV_APP_DIR)/start.sh")" "$(DEV_APP_BIN)"
	@echo "[make] Side-by-side launcher: $(DEV_APP_BIN)"

run-dev-app:
	@echo "[make] Launching side-by-side Electron app"
	"$(DEV_APP_BIN)"

deb: maybe-build-updater
	@echo "[make] Building Debian package"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ./scripts/build-deb.sh

rpm: maybe-build-updater
	@echo "[make] Building RPM package"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" RPM_BINARY_PAYLOAD="$(RPM_BINARY_PAYLOAD)" ./scripts/build-rpm.sh

pacman: maybe-build-updater
	@echo "[make] Building pacman package"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ./scripts/build-pacman.sh

appimage:
	@echo "[make] Building AppImage"
	MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" ./scripts/build-appimage.sh

package: maybe-build-updater
	@echo "[make] Building native package (auto-detecting distro)"
	@format="$$( $(NATIVE_PKG_FORMAT_CMD) )"; \
	if [ "$$format" = "pacman" ]; then \
		MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ./scripts/build-pacman.sh; \
	elif [ "$$format" = "rpm" ]; then \
		MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" RPM_BINARY_PAYLOAD="$(RPM_BINARY_PAYLOAD)" ./scripts/build-rpm.sh; \
	elif [ "$$format" = "deb" ]; then \
		MAX_BUILD_THREADS="$(MAX_BUILD_THREADS)" PACKAGE_VERSION="$(or $(PACKAGE_VERSION),)" PACKAGE_WITH_UPDATER="$(PACKAGE_WITH_UPDATER)" ./scripts/build-deb.sh; \
	else \
		echo "[make] No supported packaging tool found. Install dpkg-dev (Debian), rpm-build (Fedora), or pacman (Arch)." >&2; \
		exit 1; \
	fi

install:
	@echo "[make] Installing latest native package"
	@latest_matching_file() { \
		local pattern="$$1"; \
		local matches; \
		matches="$$(compgen -G "$$pattern" || true)"; \
		[ -n "$$matches" ] || return 0; \
		printf '%s\n' "$$matches" | sort -V | tail -n 1; \
	}; \
	format="$$( $(NATIVE_PKG_FORMAT_CMD) )"; \
	if [ "$$format" = "pacman" ]; then \
		pkg="$${PKG:-$$(latest_matching_file "$(PACMAN_GLOB)")}"; \
		if [ -z "$$pkg" ]; then \
			echo "[make] No pacman package found. Run 'make pacman' first." >&2; exit 1; \
		fi; \
		echo "[make] Installing $$pkg"; \
		sudo pacman -U --noconfirm "$$pkg"; \
	elif [ "$$format" = "rpm" ] && command -v dnf >/dev/null 2>&1; then \
		rpm="$${RPM:-$$(latest_matching_file "$(RPM_GLOB)")}"; \
		if [ -z "$$rpm" ]; then \
			echo "[make] No RPM package found. Run 'make rpm' first." >&2; exit 1; \
		fi; \
		echo "[make] Installing $$rpm"; \
		sudo dnf install -y "$$rpm"; \
	elif [ "$$format" = "rpm" ] && command -v zypper >/dev/null 2>&1; then \
		rpm="$${RPM:-$$(latest_matching_file "$(RPM_GLOB)")}"; \
		if [ -z "$$rpm" ]; then \
			echo "[make] No RPM package found. Run 'make rpm' first." >&2; exit 1; \
		fi; \
		echo "[make] Installing $$rpm"; \
		sudo zypper --non-interactive --no-gpg-checks install -y "$$rpm"; \
	elif [ "$$format" = "rpm" ]; then \
		rpm="$${RPM:-$$(latest_matching_file "$(RPM_GLOB)")}"; \
		if [ -z "$$rpm" ]; then \
			echo "[make] No RPM package found. Run 'make rpm' first." >&2; exit 1; \
		fi; \
		echo "[make] Installing $$rpm"; \
		sudo rpm -Uvh "$$rpm"; \
	elif [ "$$format" = "deb" ]; then \
		deb="$${DEB:-$$(latest_matching_file "$(DEB_GLOB)")}"; \
		if [ -z "$$deb" ]; then \
			echo "[make] No Debian package found. Run 'make deb' first." >&2; exit 1; \
		fi; \
		echo "[make] Installing $$deb"; \
		sudo dpkg -i "$$deb"; \
	else \
		echo "[make] No supported package manager found (dpkg, rpm, zypper, or pacman)." >&2; exit 1; \
	fi

service-enable:
	@echo "[make] Enabling and starting codex-update-manager.service"
	systemctl --user daemon-reload
	systemctl --user enable --now codex-update-manager.service

service-status:
	@echo "[make] Showing codex-update-manager.service status"
	systemctl --user status codex-update-manager.service --no-pager

clean-dist:
	@echo "[make] Removing dist/"
	rm -rf "$(CURDIR)/dist"

clean-state:
	@echo "[make] Removing updater runtime state"
	rm -rf \
		"$$HOME/.config/codex-update-manager" \
		"$$HOME/.local/state/codex-update-manager" \
		"$$HOME/.cache/codex-update-manager"
