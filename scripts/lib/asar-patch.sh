#!/bin/bash
# Driver for the Linux ASAR patcher (scripts/patch-linux-window-ui.js).
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

# ---- Extract and patch app.asar ----
patch_asar() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"
    local -a patch_args=()

    [ -f "$resources_dir/app.asar" ] || error "app.asar not found in $resources_dir"

    info "Extracting app.asar..."
    cd "$WORK_DIR"
    npx --yes asar extract "$resources_dir/app.asar" app-extracted

    # Copy unpacked native modules if they exist
    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        cp -r "$resources_dir/app.asar.unpacked/"* app-extracted/ 2>/dev/null || true
    fi

    # Remove macOS-only modules
    rm -rf "$WORK_DIR/app-extracted/node_modules/sparkle-darwin" 2>/dev/null || true
    find "$WORK_DIR/app-extracted" -name "sparkle.node" -delete 2>/dev/null || true

    # Build native modules in clean environment and copy back
    build_native_modules "$WORK_DIR/app-extracted"

    info "Patching Linux window and shell behavior..."
    if [ -n "${CODEX_PATCH_REPORT_JSON:-}" ]; then
        mkdir -p "$(dirname "$CODEX_PATCH_REPORT_JSON")"
        patch_args+=(--report-json "$CODEX_PATCH_REPORT_JSON")
    fi
    node "$SCRIPT_DIR/scripts/patch-linux-window-ui.js" "${patch_args[@]}" "$WORK_DIR/app-extracted"
    if [ -n "${CODEX_PATCH_REPORT_JSON:-}" ] && [ -f "$SCRIPT_DIR/scripts/ci/validate-patch-report.js" ]; then
        node "$SCRIPT_DIR/scripts/ci/validate-patch-report.js" "$CODEX_PATCH_REPORT_JSON" --profile upstream-build
    fi

    # Repack
    info "Repacking app.asar..."
    cd "$WORK_DIR"
    (cd app-extracted && find . -type f | LC_ALL=C sort | sed 's#^\./##') > "$WORK_DIR/app.asar.ordering"
    npx asar pack app-extracted app.asar --ordering "$WORK_DIR/app.asar.ordering" --unpack "{*.node,*.so,*.dylib}" 2>/dev/null

    info "app.asar patched"
}

inspect_rebuild_candidate() {
    local app_dir="$1"
    local dmg_path="$2"
    local resources_dir="$app_dir/Contents/Resources"
    local inspect_dir="$WORK_DIR/inspect-app-extracted"
    local report_dir="${REPORT_DIR:-$(default_rebuild_report_dir)}"
    local patch_report
    local rebuild_report

    [ -f "$resources_dir/app.asar" ] || error "app.asar not found in $resources_dir"

    report_dir="$(prepare_rebuild_report_dir "$report_dir")"
    patch_report="$report_dir/patch-report.json"
    rebuild_report="$report_dir/rebuild-report.json"

    info "Inspecting app.asar without changing the active app..."
    cd "$WORK_DIR"
    npx --yes asar extract "$resources_dir/app.asar" "$inspect_dir"

    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        cp -r "$resources_dir/app.asar.unpacked/"* "$inspect_dir/" 2>/dev/null || true
    fi

    node "$SCRIPT_DIR/scripts/patch-linux-window-ui.js" --report-json "$patch_report" "$inspect_dir"
    if [ -f "$SCRIPT_DIR/scripts/ci/validate-patch-report.js" ]; then
        node "$SCRIPT_DIR/scripts/ci/validate-patch-report.js" "$patch_report" --profile upstream-build
    fi
    write_rebuild_report_json "$rebuild_report" "$dmg_path" "$ELECTRON_VERSION" "$patch_report" ""

    info "Patch report: $patch_report"
    info "Rebuild report: $rebuild_report"
}
