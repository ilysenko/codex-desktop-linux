#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$REPO_DIR/scripts/lib/package-common.sh"
APP_DIR="${APP_DIR_OVERRIDE:-$REPO_DIR/codex-app}"
PKG_ROOT="${PKG_ROOT_OVERRIDE:-$REPO_DIR/dist/deb-root}"
DIST_DIR="${DIST_DIR_OVERRIDE:-$REPO_DIR/dist}"
CONTROL_TEMPLATE="$REPO_DIR/packaging/linux/control"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/codex-desktop.desktop"
SERVICE_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.service"
USER_SERVICE_HELPER_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager-user-service.sh"
ICON_SOURCE="$REPO_DIR/assets/codex.png"
PRERM_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.prerm"
POSTRM_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.postrm"
POSTINST_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.postinst"
PACKAGED_RUNTIME_TEMPLATE="$REPO_DIR/packaging/linux/codex-packaged-runtime.sh"

PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"
UPDATER_BINARY_SOURCE="${UPDATER_BINARY_SOURCE:-$REPO_DIR/target/release/codex-update-manager}"
UPDATER_SERVICE_SOURCE="${UPDATER_SERVICE_SOURCE:-$SERVICE_TEMPLATE}"
PACKAGED_RUNTIME_SOURCE="${PACKAGED_RUNTIME_SOURCE:-$PACKAGED_RUNTIME_TEMPLATE}"

map_arch() {
    case "$(dpkg --print-architecture)" in
        amd64|arm64|armhf)
            dpkg --print-architecture
            ;;
        *)
            error "Unsupported Debian architecture: $(dpkg --print-architecture)"
            ;;
    esac
}

main() {
    ensure_app_layout
    ensure_file_exists "$CONTROL_TEMPLATE" "control template"
    ensure_file_exists "$DESKTOP_TEMPLATE" "desktop template"
    ensure_file_exists "$UPDATER_SERVICE_SOURCE" "updater service template"
    ensure_file_exists "$USER_SERVICE_HELPER_TEMPLATE" "updater user service helper"
    ensure_file_exists "$ICON_SOURCE" "icon"
    ensure_file_exists "$PRERM_TEMPLATE" "Debian prerm template"
    ensure_file_exists "$POSTRM_TEMPLATE" "Debian postrm template"
    ensure_file_exists "$POSTINST_TEMPLATE" "Debian postinst template"
    ensure_file_exists "$PACKAGED_RUNTIME_SOURCE" "packaged launcher runtime helper"
    command -v dpkg-deb >/dev/null 2>&1 || error "dpkg-deb is required"
    command -v dpkg >/dev/null 2>&1 || error "dpkg is required"

    ensure_updater_binary

    local arch output_file
    arch="$(map_arch)"
    output_file="$DIST_DIR/${PACKAGE_NAME}_${PACKAGE_VERSION}_${arch}.deb"

    info "Preparing package root at $PKG_ROOT"
    rm -rf "$PKG_ROOT"
    mkdir -p \
        "$PKG_ROOT/DEBIAN" \
        "$PKG_ROOT/opt"

    stage_common_package_files "$PKG_ROOT"
    stage_update_builder_bundle "$PKG_ROOT"
    write_launcher_stub "$PKG_ROOT"
    normalize_package_permissions "$PKG_ROOT"

    sed \
        -e "s/__VERSION__/$PACKAGE_VERSION/g" \
        -e "s/__ARCH__/$arch/g" \
        "$CONTROL_TEMPLATE" > "$PKG_ROOT/DEBIAN/control"
    chmod 0644 "$PKG_ROOT/DEBIAN/control"
    cp "$POSTINST_TEMPLATE" "$PKG_ROOT/DEBIAN/postinst"
    cp "$PRERM_TEMPLATE" "$PKG_ROOT/DEBIAN/prerm"
    cp "$POSTRM_TEMPLATE" "$PKG_ROOT/DEBIAN/postrm"
    chmod 0755 "$PKG_ROOT/DEBIAN/postinst" "$PKG_ROOT/DEBIAN/prerm" "$PKG_ROOT/DEBIAN/postrm"

    mkdir -p "$DIST_DIR"
    info "Building $output_file"
    dpkg-deb --root-owner-group --build "$PKG_ROOT" "$output_file" >&2
    info "Built package: $output_file"
}

main "$@"
