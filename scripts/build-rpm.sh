#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="${APP_DIR_OVERRIDE:-$REPO_DIR/codex-app}"
DIST_DIR="${DIST_DIR_OVERRIDE:-$REPO_DIR/dist}"
SPEC_TEMPLATE="$REPO_DIR/packaging/linux/codex-desktop.spec"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/codex-desktop.desktop"
SERVICE_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager.service"
USER_SERVICE_HELPER_TEMPLATE="$REPO_DIR/packaging/linux/codex-update-manager-user-service.sh"
PACKAGED_RUNTIME_TEMPLATE="$REPO_DIR/packaging/linux/codex-packaged-runtime.sh"

PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"
MAX_BUILD_THREADS="${MAX_BUILD_THREADS:-0}"
RPM_BINARY_PAYLOAD="${RPM_BINARY_PAYLOAD:-}"
UPDATER_BINARY_SOURCE="${UPDATER_BINARY_SOURCE:-$REPO_DIR/target/release/codex-update-manager}"
UPDATER_SERVICE_SOURCE="${UPDATER_SERVICE_SOURCE:-$SERVICE_TEMPLATE}"
PACKAGED_RUNTIME_SOURCE="${PACKAGED_RUNTIME_SOURCE:-$PACKAGED_RUNTIME_TEMPLATE}"
UPDATE_BUILDER_ROOT_PLACEHOLDER="__UPDATE_BUILDER_ROOT__"

# Keep the installed update-builder payload aligned with the other package formats.
# shellcheck source=scripts/lib/package-common.sh
. "$REPO_DIR/scripts/lib/package-common.sh"

ICON_SOURCE="$(resolve_package_icon_source)"

info()  { echo "[INFO] $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

validate_max_build_threads() {
    case "$MAX_BUILD_THREADS" in
        ""|*[!0-9]*)
            error "MAX_BUILD_THREADS must be 0 or a positive integer"
            ;;
    esac
}

map_arch() {
    case "$(uname -m)" in
        x86_64)  echo "x86_64" ;;
        aarch64) echo "aarch64" ;;
        armv7l)  echo "armv7hl" ;;
        *)       error "Unsupported architecture: $(uname -m)" ;;
    esac
}

# RPM version must not contain '+'; split PACKAGE_VERSION on '+' into version and release
rpm_version_parts() {
    local base
    base="${PACKAGE_VERSION%%+*}"
    local hash
    hash="${PACKAGE_VERSION#*+}"
    if [ "$base" = "$PACKAGE_VERSION" ]; then
        hash="1"
    fi
    RPM_VERSION="$base"
    RPM_RELEASE="$hash"
}

main() {
    validate_max_build_threads
    if [ -z "$RPM_BINARY_PAYLOAD" ] && [ "$MAX_BUILD_THREADS" != "0" ]; then
        RPM_BINARY_PAYLOAD="w19T${MAX_BUILD_THREADS}.zstdio"
    fi

    ensure_app_layout
    [ -f "$SPEC_TEMPLATE" ] || error "Missing spec template: $SPEC_TEMPLATE"
    [ -f "$DESKTOP_TEMPLATE" ] || error "Missing desktop template: $DESKTOP_TEMPLATE"
    [ -f "$ICON_SOURCE" ] || error "Missing icon: $ICON_SOURCE"
    if package_with_updater_enabled; then
        [ -f "$UPDATER_SERVICE_SOURCE" ] || error "Missing updater service template: $UPDATER_SERVICE_SOURCE"
        [ -f "$USER_SERVICE_HELPER_TEMPLATE" ] || error "Missing updater user service helper: $USER_SERVICE_HELPER_TEMPLATE"
        [ -f "$PACKAGED_RUNTIME_SOURCE" ] || error "Missing packaged launcher runtime helper: $PACKAGED_RUNTIME_SOURCE"
    else
        info "Building package without codex-update-manager (PACKAGE_WITH_UPDATER=0)"
    fi
    command -v rpmbuild >/dev/null 2>&1 || error "rpmbuild is required (install rpm-build)"

    ensure_updater_binary

    local arch
    arch="$(map_arch)"
    rpm_version_parts
    local rpm_ver="$RPM_VERSION"
    local rpm_rel="$RPM_RELEASE"

    local build_root
    build_root="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$build_root'" EXIT

    local staging_root="$build_root/STAGING"

    stage_common_package_files "$staging_root"
    stage_optional_update_builder_bundle "$staging_root"

    cat > "$staging_root/usr/bin/$PACKAGE_NAME" <<SCRIPT
#!/usr/bin/env bash
exec /opt/$PACKAGE_NAME/start.sh "\$@"
SCRIPT
    chmod 0755 "$staging_root/usr/bin/$PACKAGE_NAME"
    run_linux_feature_package_hooks "$staging_root" "rpm"
    normalize_package_payload_permissions "$staging_root"
    restore_linux_feature_payload_permissions "$staging_root"

    local spec_file="$build_root/codex-desktop.spec"
    sed \
        -e "s/__PACKAGE_NAME__/$PACKAGE_NAME/g" \
        -e "s/__RPM_VERSION__/$rpm_ver/g" \
        -e "s/__RPM_RELEASE__/$rpm_rel/g" \
        -e "s|__RPM_STAGING_DIR__|$staging_root|g" \
        -e "s/__ARCH__/$arch/g" \
        -e "s/__PACKAGE_WITH_UPDATER__/$(package_with_updater_enabled && echo 1 || echo 0)/g" \
        "$SPEC_TEMPLATE" > "$spec_file"

    local rpmbuild_dir="$build_root/rpmbuild"
    mkdir -p \
        "$rpmbuild_dir/RPMS" \
        "$rpmbuild_dir/SRPMS" \
        "$rpmbuild_dir/BUILD" \
        "$rpmbuild_dir/SOURCES" \
        "$rpmbuild_dir/SPECS"

    mkdir -p "$DIST_DIR"
    info "Building $PACKAGE_NAME-${rpm_ver}-${rpm_rel}.${arch}.rpm"
    local -a rpmbuild_args=(
        -bb
        --define "_rpmdir $rpmbuild_dir/RPMS" \
        --define "_srcrpmdir $rpmbuild_dir/SRPMS" \
        --define "_builddir $rpmbuild_dir/BUILD" \
        --define "_sourcedir $rpmbuild_dir/SOURCES" \
        --define "_specdir $build_root" \
        --define "_build_name_fmt %%{NAME}-%%{VERSION}-%%{RELEASE}.%%{ARCH}.rpm" \
    )
    if [ -n "$RPM_BINARY_PAYLOAD" ]; then
        info "RPM binary payload compression: $RPM_BINARY_PAYLOAD"
        rpmbuild_args+=(--define "_binary_payload $RPM_BINARY_PAYLOAD")
    else
        info "RPM binary payload compression: tool default"
    fi
    rpmbuild_args+=("$spec_file")
    rpmbuild "${rpmbuild_args[@]}" >&2

    local rpm_file
    rpm_file="$(find "$rpmbuild_dir/RPMS" -name "*.rpm" | head -n 1)"
    [ -f "$rpm_file" ] || error "rpmbuild did not produce an RPM"

    local output_file="$DIST_DIR/${PACKAGE_NAME}-${rpm_ver}-${rpm_rel}.${arch}.rpm"
    cp "$rpm_file" "$output_file"
    info "Built package: $output_file"
}

main "$@"
