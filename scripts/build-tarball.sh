#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/package-common.sh
. "$REPO_DIR/scripts/lib/package-common.sh"

APP_DIR="${APP_DIR_OVERRIDE:-$REPO_DIR/codex-app}"
DIST_DIR="${DIST_DIR_OVERRIDE:-$REPO_DIR/dist}"
PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"

map_arch() {
    case "$(uname -m)" in
        x86_64) echo "x86_64" ;;
        aarch64|arm64) echo "aarch64" ;;
        armv7l|armhf) echo "armhf" ;;
        *) error "Unsupported tarball architecture: $(uname -m)" ;;
    esac
}

validate_package_version() {
    case "$PACKAGE_VERSION" in
        ""|*[!A-Za-z0-9._+-]*)
            error "PACKAGE_VERSION contains unsupported characters: $PACKAGE_VERSION"
            ;;
    esac
}

main() {
    ensure_app_layout
    validate_package_version

    local arch archive_root output_file staging_dir source_date_epoch
    arch="$(map_arch)"
    archive_root="$PACKAGE_NAME-$PACKAGE_VERSION-linux-$arch"
    output_file="$DIST_DIR/$archive_root.tar.gz"
    staging_dir="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$staging_dir'" EXIT

    mkdir -p "$staging_dir/$archive_root"
    cp -aT "$APP_DIR" "$staging_dir/$archive_root"

    source_date_epoch="${SOURCE_DATE_EPOCH:-}"
    if [ -z "$source_date_epoch" ]; then
        source_date_epoch="$(date -u +%s)"
    fi
    case "$source_date_epoch" in
        ''|*[!0-9]*) error "SOURCE_DATE_EPOCH must be a Unix timestamp" ;;
    esac

    mkdir -p "$DIST_DIR"
    rm -f "$output_file"
    info "Building portable tarball: $output_file"
    tar \
        --sort=name \
        --mtime="@$source_date_epoch" \
        --owner=0 \
        --group=0 \
        --numeric-owner \
        -czf "$output_file" \
        -C "$staging_dir" \
        "$archive_root"
    chmod 0644 "$output_file"
    info "Built tarball: $output_file"
}

main "$@"
