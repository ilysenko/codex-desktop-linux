#!/bin/bash
# Build provenance metadata written into generated Linux app directories.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

write_build_info() {
    local dmg_path="$1"
    local app_dir="$2"

    mkdir -p "$INSTALL_DIR/resources" "$INSTALL_DIR/.codex-linux"
    CODEX_UPSTREAM_DMG_RESOLVED_SOURCE="${DMG_SOURCE:-}" \
    CODEX_UPSTREAM_DMG_RESOLVED_SOURCE_NAME="${DMG_SOURCE_DISPLAY_NAME:-}" \
    CODEX_UPSTREAM_DMG_RESOLVED_URL="${DMG_URL:-}" \
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
