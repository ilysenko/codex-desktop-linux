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
PRERM_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.prerm"
POSTRM_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.postrm"
POSTINST_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.postinst"
PACKAGED_RUNTIME_TEMPLATE="$REPO_DIR/packaging/linux/codex-packaged-runtime.sh"

PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"
ICON_SOURCE="$(resolve_package_icon_source)"
MAX_BUILD_THREADS="${MAX_BUILD_THREADS:-0}"
UPDATER_BINARY_SOURCE="${UPDATER_BINARY_SOURCE:-$REPO_DIR/target/release/codex-update-manager}"
UPDATER_SERVICE_SOURCE="${UPDATER_SERVICE_SOURCE:-$SERVICE_TEMPLATE}"
PACKAGED_RUNTIME_SOURCE="${PACKAGED_RUNTIME_SOURCE:-$PACKAGED_RUNTIME_TEMPLATE}"

validate_max_build_threads() {
    case "$MAX_BUILD_THREADS" in
        ""|*[!0-9]*)
            error "MAX_BUILD_THREADS must be 0 or a positive integer"
            ;;
    esac
}

map_arch() {
    local architecture
    architecture="$(dpkg --print-architecture)"
    case "$architecture" in
        amd64|arm64)
            assert_official_payload_architecture "$architecture"
            printf '%s\n' "$architecture"
            ;;
        *)
            error "Unsupported Debian architecture: $architecture (official packages support amd64 and arm64 only)"
            ;;
    esac
}

main() {
    validate_max_build_threads

    ensure_app_layout
    ensure_file_exists "$CONTROL_TEMPLATE" "control template"
    ensure_file_exists "$DESKTOP_TEMPLATE" "desktop template"
    ensure_file_exists "$ICON_SOURCE" "icon"
    if package_with_updater_enabled; then
        ensure_file_exists "$UPDATER_SERVICE_SOURCE" "updater service template"
        ensure_file_exists "$USER_SERVICE_HELPER_TEMPLATE" "updater user service helper"
        ensure_file_exists "$PRERM_TEMPLATE" "Debian prerm template"
        ensure_file_exists "$POSTRM_TEMPLATE" "Debian postrm template"
        ensure_file_exists "$POSTINST_TEMPLATE" "Debian postinst template"
        ensure_file_exists "$PACKAGED_RUNTIME_SOURCE" "packaged launcher runtime helper"
    else
        info "Building package without codex-update-manager (PACKAGE_WITH_UPDATER=0)"
    fi
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
    stage_optional_update_builder_bundle "$PKG_ROOT"
    write_launcher_stub "$PKG_ROOT"
    stage_linux_feature_package_resources "$PKG_ROOT" "deb"
    run_linux_feature_package_hooks "$PKG_ROOT" "deb"
    normalize_package_payload_permissions "$PKG_ROOT"
    restore_linux_feature_payload_permissions "$PKG_ROOT"
    restore_linux_feature_package_resource_permissions "$PKG_ROOT" "deb"

    local upstream_depends upstream_recommends upstream_suggests
    upstream_depends="$(upstream_linux_control_field Depends)"
    upstream_recommends="$(upstream_linux_control_field Recommends)"
    upstream_suggests="$(upstream_linux_control_field Suggests)"
    [ -n "$upstream_depends" ] || error "Official Linux package control metadata has no Depends field"

    sed \
        -e "s/__PACKAGE_NAME__/$PACKAGE_NAME/g" \
        -e "s/__VERSION__/$PACKAGE_VERSION/g" \
        -e "s/__ARCH__/$arch/g" \
        "$CONTROL_TEMPLATE" > "$PKG_ROOT/DEBIAN/control"
    replace_literal_file_token "$PKG_ROOT/DEBIAN/control" "__UPSTREAM_DEPENDENCIES__" "$upstream_depends"
    if [ -n "$upstream_recommends" ]; then
        replace_literal_file_token "$PKG_ROOT/DEBIAN/control" "__UPSTREAM_RECOMMENDS__" "$upstream_recommends"
    else
        sed -i '/^Recommends: __UPSTREAM_RECOMMENDS__$/d' "$PKG_ROOT/DEBIAN/control"
    fi
    if [ -n "$upstream_suggests" ]; then
        replace_literal_file_token "$PKG_ROOT/DEBIAN/control" "__UPSTREAM_SUGGESTS__" "$upstream_suggests"
    else
        sed -i '/^Suggests: __UPSTREAM_SUGGESTS__$/d' "$PKG_ROOT/DEBIAN/control"
    fi
    if package_with_updater_enabled; then
        replace_literal_file_token \
            "$PKG_ROOT/DEBIAN/control" \
            "__UPDATER_DEPENDENCIES__" \
            "curl, dpkg, gnupg, nodejs, pkexec | policykit-1, polkitd | policykit-1, "
    else
        replace_literal_file_token "$PKG_ROOT/DEBIAN/control" "__UPDATER_DEPENDENCIES__" ""
    fi
    local feature_dependency_suffix
    if ! feature_dependency_suffix="$(
        linux_feature_package_dependency_suffix deb "$PKG_ROOT/opt/$PACKAGE_NAME"
    )"; then
        error "Failed to render Linux feature dependencies for deb"
    fi
    replace_literal_file_token \
        "$PKG_ROOT/DEBIAN/control" \
        ", __LINUX_FEATURE_DEPENDENCIES__" \
        "$feature_dependency_suffix"
    if ! package_with_updater_enabled; then
        cat >> "$PKG_ROOT/DEBIAN/control" <<'CONTROL'
 This package was built without codex-update-manager. Update manually from a trusted checkout.
CONTROL
    fi
    chmod 0644 "$PKG_ROOT/DEBIAN/control"
    if package_with_updater_enabled; then
        stage_deb_maintainer_scripts \
            "$PKG_ROOT" \
            "$PACKAGE_NAME" \
            "$POSTINST_TEMPLATE" \
            "$PRERM_TEMPLATE" \
            "$POSTRM_TEMPLATE"
    else
        write_no_updater_deb_postinst "$PKG_ROOT/DEBIAN/postinst"
        write_no_updater_deb_prerm "$PKG_ROOT/DEBIAN/prerm"
    fi
    append_deb_apparmor_postinst "$PKG_ROOT/DEBIAN/postinst"

    mkdir -p "$DIST_DIR"
    info "Building $output_file"
    if [ "$MAX_BUILD_THREADS" != "0" ]; then
        info "Debian package compression threads: $MAX_BUILD_THREADS"
        DPKG_DEB_THREADS_MAX="$MAX_BUILD_THREADS" dpkg-deb --root-owner-group --build "$PKG_ROOT" "$output_file" >&2
    else
        dpkg-deb --root-owner-group --build "$PKG_ROOT" "$output_file" >&2
    fi
    info "Built package: $output_file"
}

main "$@"
