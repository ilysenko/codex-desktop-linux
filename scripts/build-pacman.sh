#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$REPO_DIR/scripts/lib/package-common.sh"
APP_DIR="${APP_DIR_OVERRIDE:-$REPO_DIR/codex-app}"
DIST_DIR="${DIST_DIR_OVERRIDE:-$REPO_DIR/dist}"
PKGBUILD_TEMPLATE="$REPO_DIR/packaging/linux/PKGBUILD.template"
INSTALL_HOOKS="$REPO_DIR/packaging/linux/codex-desktop.install"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/codex-desktop.desktop"
SERVICE_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.service"
USER_SERVICE_HELPER_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager-user-service.sh"
ICON_SOURCE="$REPO_DIR/assets/codex.png"
PACKAGED_RUNTIME_TEMPLATE="$REPO_DIR/packaging/linux/codex-packaged-runtime.sh"

PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"
UPDATER_BINARY_SOURCE="${UPDATER_BINARY_SOURCE:-$REPO_DIR/target/release/codex-update-manager}"
UPDATER_SERVICE_SOURCE="${UPDATER_SERVICE_SOURCE:-$SERVICE_TEMPLATE}"
PACKAGED_RUNTIME_SOURCE="${PACKAGED_RUNTIME_SOURCE:-$PACKAGED_RUNTIME_TEMPLATE}"

map_arch() {
	case "$(uname -m)" in
	x86_64) echo "x86_64" ;;
	aarch64) echo "aarch64" ;;
	*) error "Unsupported architecture: $(uname -m)" ;;
	esac
}

# Arch pkgver must not contain '+' or '-'; split on '+' and use the base as pkgver.
pacman_version_parts() {
	PACMAN_PKGVER="${PACKAGE_VERSION%%+*}"
	PACMAN_PKGREL="1"
}

main() {
	ensure_app_layout
	ensure_file_exists "$PKGBUILD_TEMPLATE" "PKGBUILD template"
	ensure_file_exists "$INSTALL_HOOKS" "install hooks"
	ensure_file_exists "$DESKTOP_TEMPLATE" "desktop template"
	ensure_file_exists "$UPDATER_SERVICE_SOURCE" "updater service template"
	ensure_file_exists "$USER_SERVICE_HELPER_TEMPLATE" "updater user service helper"
	ensure_file_exists "$ICON_SOURCE" "icon"
	ensure_file_exists "$PACKAGED_RUNTIME_SOURCE" "packaged launcher runtime helper"
	command -v makepkg >/dev/null 2>&1 || error "makepkg is required (part of pacman)"

	if [ "$(id -u)" -eq 0 ]; then
		error "makepkg cannot run as root. Run this script as a regular user."
	fi

	ensure_updater_binary

	local arch
	arch="$(map_arch)"
	pacman_version_parts

	local build_root
	build_root="$(mktemp -d)"
	# shellcheck disable=SC2064
	trap "rm -rf '$build_root'" EXIT

	local staging_root="$build_root/staging"

	stage_common_package_files "$staging_root"
	stage_update_builder_bundle "$staging_root"
	write_launcher_stub "$staging_root"
	normalize_package_permissions "$staging_root"

	sed \
		-e "s/__PACKAGE_NAME__/$PACKAGE_NAME/g" \
		-e "s/__PKGVER__/$PACMAN_PKGVER/g" \
		-e "s/__PKGREL__/$PACMAN_PKGREL/g" \
		-e "s|__STAGING_DIR__|$staging_root|g" \
		-e "s/__ARCH__/$arch/g" \
		"$PKGBUILD_TEMPLATE" >"$build_root/PKGBUILD"
	cp "$INSTALL_HOOKS" "$build_root/${PACKAGE_NAME}.install"

	mkdir -p "$DIST_DIR"
	info "Building ${PACKAGE_NAME}-${PACMAN_PKGVER}-${PACMAN_PKGREL}-${arch}.pkg.tar.zst"

	# Build the package; --nodeps skips dependency checks at build time (they
	# are enforced by pacman at install time), and --skipinteg is needed
	# because we have no remote sources to verify.
	(cd "$build_root" && PKGDEST="$DIST_DIR" makepkg -f --nodeps --skipinteg 2>&1) >&2

	local pkg_file=""
	pkg_file="$(find "$DIST_DIR" \( -name "${PACKAGE_NAME}-${PACMAN_PKGVER}-*.pkg.tar.zst" \
		-o -name "${PACKAGE_NAME}-${PACMAN_PKGVER}-*.pkg.tar.xz" \) \
		-print -quit 2>/dev/null || true)"
	[ -f "$pkg_file" ] || error "makepkg did not produce a package"

	info "Built package: $pkg_file"
}

main "$@"
