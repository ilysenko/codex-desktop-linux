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

# Arch pkgver may contain '+', so keep the caller-provided commitish suffix in
# pkgver. pkgrel is reserved for distro/package rebuilds of the same upstream
# app version.
pacman_version_parts() {
	PACMAN_PKGVER="$PACKAGE_VERSION"
	PACMAN_PKGREL="1"
}

main() {
	ensure_app_layout
	ensure_file_exists "$PKGBUILD_TEMPLATE" "PKGBUILD template"
	ensure_file_exists "$DESKTOP_TEMPLATE" "desktop template"
	ensure_file_exists "$ICON_SOURCE" "icon"
	if package_with_updater_enabled; then
		ensure_file_exists "$INSTALL_HOOKS" "install hooks"
		ensure_file_exists "$UPDATER_SERVICE_SOURCE" "updater service template"
		ensure_file_exists "$USER_SERVICE_HELPER_TEMPLATE" "updater user service helper"
		ensure_file_exists "$PACKAGED_RUNTIME_SOURCE" "packaged launcher runtime helper"
	else
		info "Building package without codex-update-manager (PACKAGE_WITH_UPDATER=0)"
	fi
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
	stage_optional_update_builder_bundle "$staging_root"
	write_launcher_stub "$staging_root"

	local package_name
	local pacman_pkgver
	local pacman_pkgrel
	local staging_dir
	local arch_replacement
	package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
	pacman_pkgver="$(sed_escape_replacement "$PACMAN_PKGVER")"
	pacman_pkgrel="$(sed_escape_replacement "$PACMAN_PKGREL")"
	staging_dir="$(sed_escape_replacement "$staging_root")"
	arch_replacement="$(sed_escape_replacement "$arch")"

	sed \
		-e "s/__PACKAGE_NAME__/$package_name/g" \
		-e "s/__PKGVER__/$pacman_pkgver/g" \
		-e "s/__PKGREL__/$pacman_pkgrel/g" \
		-e "s|__STAGING_DIR__|$staging_dir|g" \
		-e "s/__ARCH__/$arch_replacement/g" \
		"$PKGBUILD_TEMPLATE" >"$build_root/PKGBUILD"
	if package_with_updater_enabled; then
		sed -e "s|/opt/codex-desktop|/opt/$PACKAGE_NAME|g" \
			"$INSTALL_HOOKS" >"$build_root/${PACKAGE_NAME}.install"
	else
		write_no_updater_pacman_install_hooks "$build_root/${PACKAGE_NAME}.install"
		sed -i \
			-e "/'polkit'/d" \
			"$build_root/PKGBUILD"
	fi

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

	ln -sfn "$(basename "$pkg_file")" "$DIST_DIR/${PACKAGE_NAME}-latest.pkg.tar.zst"

	info "Built package: $pkg_file"
	printf '%s\n' "$pkg_file"
}

main "$@"
