#!/bin/bash
# Build provenance metadata written into generated Linux app directories.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

record_upstream_app_version() {
    local app_dir="$1"
    local metadata_path="${CODEX_UPSTREAM_DMG_METADATA_JSON:-}"
    [ -n "$metadata_path" ] || return 0

    "${CODEX_ACCEPTANCE_NODE:-node}" -e \
        'require(process.argv[1]).recordAppVersionMetadata(process.argv[2], process.argv[3])' \
        "$SCRIPT_DIR/scripts/lib/build-info.js" \
        "$metadata_path" \
        "$app_dir"
}

write_build_info() {
    local dmg_path="$1"
    local app_dir="$2"

    mkdir -p "$INSTALL_DIR/resources" "$INSTALL_DIR/.codex-linux"
    node "$SCRIPT_DIR/scripts/lib/build-info.js" \
        "$SCRIPT_DIR" \
        "$INSTALL_DIR" \
        "$dmg_path" \
        "$app_dir" \
        "$ELECTRON_VERSION" \
        "$CODEX_APP_ID" \
        "$CODEX_APP_DISPLAY_NAME"
    info "Build info written"
}
