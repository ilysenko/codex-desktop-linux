#!/bin/bash
# Webview asset extraction and patched app.asar install into the codex-app/ tree.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

# ---- Extract webview files ----
extract_webview() {
    local app_dir="$1"
    mkdir -p "$INSTALL_DIR/content/webview"

    # Webview files are inside the extracted asar at webview/
    local asar_extracted="$WORK_DIR/app-extracted"
    if [ -d "$asar_extracted/webview" ]; then
        cp -r "$asar_extracted/webview/"* "$INSTALL_DIR/content/webview/"
        # Replace transparent startup background with an opaque color for Linux.
        # The upstream app relies on macOS vibrancy for the transparent effect;
        # on Linux the transparent background causes flickering.
        local webview_index="$INSTALL_DIR/content/webview/index.html"
        if [ -f "$webview_index" ]; then
            python3 - "$webview_index" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
source = source.replace("--startup-background: transparent", "--startup-background: #1e1e1e", 1)
path.write_text(source, encoding="utf-8")
PY
        fi
        info "Webview files copied"
    else
        warn "Webview directory not found in asar — app may not work"
    fi
}

# ---- Install app.asar ----
install_app() {
    cp "$WORK_DIR/app.asar" "$INSTALL_DIR/resources/"
    if [ -d "$WORK_DIR/app.asar.unpacked" ]; then
        cp -r "$WORK_DIR/app.asar.unpacked" "$INSTALL_DIR/resources/"
    fi
    info "app.asar installed"
}
