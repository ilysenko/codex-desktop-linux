#!/bin/bash
# Webview asset extraction and patched app.asar install into the codex-app/ tree.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

replace_linux_webview_icon_assets() {
    local assets_dir="$INSTALL_DIR/content/webview/assets"
    local -a icon_assets=()
    local icon_asset linux_icon_source

    linux_icon_source="${LINUX_ICON_SOURCE:-${CODEX_LINUX_ICON_SOURCE:-$SCRIPT_DIR/assets/codex-linux.png}}"
    [ -f "$linux_icon_source" ] || linux_icon_source="$ICON_SOURCE"

    [ -f "$linux_icon_source" ] || {
        warn "Linux icon not found at $linux_icon_source; leaving upstream webview icon assets unchanged"
        return 0
    }
    [ -d "$assets_dir" ] || return 0

    while IFS= read -r -d '' icon_asset; do
        icon_assets+=("$icon_asset")
    done < <(find "$assets_dir" -maxdepth 1 -type f -name 'app-*.png' -print0 | sort -z)

    if [ "${#icon_assets[@]}" -eq 0 ]; then
        warn "Could not find webview app icon assets in $assets_dir; leaving upstream icon unchanged"
        return 0
    fi

    for icon_asset in "${icon_assets[@]}"; do
        cp "$linux_icon_source" "$icon_asset"
    done
    info "Linux app icon applied to ${#icon_assets[@]} webview asset(s)"
}

require_webview_entrypoint() {
    local webview_index="$INSTALL_DIR/content/webview/index.html"

    [ -f "$webview_index" ] || error "Missing webview entrypoint: $webview_index. Upstream ASAR layout may have changed."
}

# ---- Extract webview files ----
extract_webview() {
    local app_dir="$1"
    mkdir -p "$INSTALL_DIR/content/webview"

    # Webview files are inside the extracted asar at webview/
    local asar_extracted="$WORK_DIR/app-extracted"
    [ -d "$asar_extracted/webview" ] || error "Webview directory not found in extracted asar: $asar_extracted/webview"

    cp -a "$asar_extracted/webview/." "$INSTALL_DIR/content/webview/"
    require_webview_entrypoint

    # Replace transparent startup background with an opaque color for Linux.
    # The upstream app relies on macOS vibrancy for the transparent effect;
    # on Linux the transparent background causes flickering.
    sed -i 's/--startup-background: transparent/--startup-background: #1e1e1e/' "$INSTALL_DIR/content/webview/index.html"
    replace_linux_webview_icon_assets
    info "Webview files copied"
}

# ---- Install app.asar ----
install_app() {
    cp "$WORK_DIR/app.asar" "$INSTALL_DIR/resources/"
    if [ -d "$WORK_DIR/app.asar.unpacked" ]; then
        cp -r "$WORK_DIR/app.asar.unpacked" "$INSTALL_DIR/resources/"
    fi
    info "app.asar installed"
}
