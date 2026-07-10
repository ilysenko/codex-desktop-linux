#!/bin/bash
set -Eeuo pipefail

# ============================================================================
# ChatGPT Desktop for Linux — Installer
# Converts the official macOS ChatGPT Desktop app to run on Linux
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_APP_ID="${CODEX_APP_ID:-codex-desktop}"
CODEX_APP_DISPLAY_NAME="${CODEX_APP_DISPLAY_NAME:-ChatGPT}"
INSTALL_ROOT="${CODEX_INSTALL_ROOT:-$SCRIPT_DIR}"
DEFAULT_INSTALL_DIR_NAME="codex-app"
DEFAULT_CODEX_WEBVIEW_PORT=5175
if [ "$CODEX_APP_ID" != "codex-desktop" ]; then
    DEFAULT_INSTALL_DIR_NAME="$CODEX_APP_ID-app"
    DEFAULT_CODEX_WEBVIEW_PORT=5176
fi
INSTALL_DIR="${CODEX_INSTALL_DIR:-$INSTALL_ROOT/$DEFAULT_INSTALL_DIR_NAME}"
CODEX_WEBVIEW_PORT="${CODEX_WEBVIEW_PORT:-$DEFAULT_CODEX_WEBVIEW_PORT}"
ELECTRON_VERSION="41.3.0"
ELECTRON_HEADERS_URL="${ELECTRON_HEADERS_URL:-${npm_config_disturl:-${NPM_CONFIG_DISTURL:-https://artifacts.electronjs.org/headers/dist}}}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-}"
MIN_BETTER_SQLITE3_VERSION_FOR_ELECTRON_41="12.9.0"
WORK_DIR="$(mktemp -d)"
ARCH="$(uname -m)"
ICON_SOURCE="$SCRIPT_DIR/assets/codex.png"
LINUX_ICON_SOURCE="${CODEX_LINUX_ICON_SOURCE:-}"

# ---- Source library helpers ----
. "$SCRIPT_DIR/scripts/lib/install-helpers.sh"
. "$SCRIPT_DIR/scripts/lib/node-runtime.sh"
. "$SCRIPT_DIR/scripts/lib/process-detection.sh"
. "$SCRIPT_DIR/scripts/lib/dmg.sh"
. "$SCRIPT_DIR/scripts/lib/native-modules.sh"
. "$SCRIPT_DIR/scripts/lib/asar-patch.sh"
. "$SCRIPT_DIR/scripts/lib/webview-install.sh"
. "$SCRIPT_DIR/scripts/lib/bundled-plugins.sh"
. "$SCRIPT_DIR/scripts/lib/linux-features.sh"
. "$SCRIPT_DIR/scripts/lib/rebuild-report.sh"
. "$SCRIPT_DIR/scripts/lib/build-info.sh"

# ---- Create start script ----
create_start_script() {
    local quoted_app_id
    local quoted_app_display_name
    local quoted_webview_port
    quoted_app_id="$(shell_quote "$CODEX_APP_ID")"
    quoted_app_display_name="$(shell_quote "$CODEX_APP_DISPLAY_NAME")"
    quoted_webview_port="$(shell_quote "$CODEX_WEBVIEW_PORT")"

    cat > "$INSTALL_DIR/start.sh" << SCRIPT
#!/bin/bash
set -euo pipefail

CODEX_LINUX_APP_ID=$quoted_app_id
CODEX_LINUX_APP_DISPLAY_NAME=$quoted_app_display_name
CODEX_LINUX_WEBVIEW_PORT=\${CODEX_WEBVIEW_PORT:-$quoted_webview_port}
SCRIPT

    cat "$SCRIPT_DIR/launcher/start.sh.template" >> "$INSTALL_DIR/start.sh"

    chmod +x "$INSTALL_DIR/start.sh"
    mkdir -p "$INSTALL_DIR/.codex-linux"
    cp "$SCRIPT_DIR/launcher/webview-server.py" "$INSTALL_DIR/.codex-linux/webview-server.py"
    local linux_icon_source="$LINUX_ICON_SOURCE"
    [ -f "$linux_icon_source" ] || linux_icon_source="$ICON_SOURCE"
    if [ -f "$linux_icon_source" ]; then
        cp "$linux_icon_source" "$INSTALL_DIR/.codex-linux/$CODEX_APP_ID.png"
    else
        warn "Notification icon not found at $linux_icon_source"
    fi
    info "Start script created"
}

select_linux_icon_source() {
    if [ -n "$LINUX_ICON_SOURCE" ]; then
        if is_x11_safe_png_icon "$LINUX_ICON_SOURCE"; then
            return 0
        fi
        warn "Configured Linux icon is missing, invalid, or larger than 512x512; using automatic icon selection"
        LINUX_ICON_SOURCE=""
    fi

    local assets_dir="$WORK_DIR/app-extracted/webview/assets"
    local -a chatgpt_icon_candidates=()
    if [ -d "$assets_dir" ]; then
        mapfile -t chatgpt_icon_candidates < <(
            find "$assets_dir" -maxdepth 1 -type f \
                -name 'referral-modal-chatgpt-blossom-*.png' -print | LC_ALL=C sort
        )
    fi

    if [ "${#chatgpt_icon_candidates[@]}" -eq 1 ] &&
       is_x11_safe_png_icon "${chatgpt_icon_candidates[0]}"; then
        LINUX_ICON_SOURCE="${chatgpt_icon_candidates[0]}"
        info "Using upstream ChatGPT icon"
        return 0
    fi

    LINUX_ICON_SOURCE="$SCRIPT_DIR/assets/codex-linux.png"
    if [ "${#chatgpt_icon_candidates[@]}" -gt 1 ]; then
        warn "Found multiple compact upstream ChatGPT icons; using the bundled Linux icon"
    elif [ "${#chatgpt_icon_candidates[@]}" -eq 1 ]; then
        warn "Upstream ChatGPT icon is invalid or larger than 512x512; using the bundled Linux icon"
    else
        warn "Compact upstream ChatGPT icon not found; using the bundled Linux icon"
    fi
}

is_x11_safe_png_icon() {
    local icon_path="$1"
    [ -f "$icon_path" ] || return 1

    python3 - "$icon_path" <<'PY'
import struct
import sys

try:
    with open(sys.argv[1], "rb") as icon_file:
        header = icon_file.read(24)
except OSError:
    raise SystemExit(1)

if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
    raise SystemExit(1)

width, height = struct.unpack(">II", header[16:24])
raise SystemExit(0 if 0 < width <= 512 and 0 < height <= 512 else 1)
PY
}

# ---- Main ----
main() {
    echo "============================================" >&2
    echo "  ChatGPT Desktop for Linux — Installer"     >&2
    echo "============================================" >&2
    echo ""                                             >&2

    parse_args "$@"
    validate_app_identity
    check_deps
    if [ "$INSPECT_ONLY" -ne 1 ]; then
        assert_install_target_not_running
        prepare_install
        ensure_managed_node_runtime "$INSTALL_DIR/resources/node-runtime"
    else
        ensure_managed_node_runtime "$WORK_DIR/node-runtime"
    fi

    local dmg_path=""
    if [ -n "$PROVIDED_DMG_PATH" ]; then
        [ -f "$PROVIDED_DMG_PATH" ] || error "Provided DMG not found: $PROVIDED_DMG_PATH"
        dmg_path="$(realpath "$PROVIDED_DMG_PATH")"
        info "Using provided DMG: $dmg_path"
    else
        dmg_path=$(get_dmg)
    fi

    local app_dir
    app_dir=$(extract_dmg "$dmg_path")

    detect_electron_version "$app_dir"
    if [ "$INSPECT_ONLY" -eq 1 ]; then
        inspect_rebuild_candidate "$app_dir" "$dmg_path"
        return 0
    fi

    patch_asar "$app_dir"
    select_linux_icon_source
    download_electron
    extract_webview "$app_dir"
    install_app
    install_bundled_plugin_resources "$app_dir"
    run_linux_feature_stage_hooks "$app_dir"
    create_start_script
    if [ -n "${CODEX_PATCH_REPORT_RESOLVED:-}" ] && [ -f "$CODEX_PATCH_REPORT_RESOLVED" ]; then
        cp "$CODEX_PATCH_REPORT_RESOLVED" "$INSTALL_DIR/.codex-linux/patch-report.json"
        info "Patch report: $INSTALL_DIR/.codex-linux/patch-report.json"
    fi
    write_build_info "$dmg_path" "$app_dir"

    if [ -n "${CODEX_REBUILD_REPORT_JSON:-}" ] && [ -n "${CODEX_PATCH_REPORT_JSON:-}" ]; then
        write_rebuild_report_json \
            "$CODEX_REBUILD_REPORT_JSON" \
            "$dmg_path" \
            "$ELECTRON_VERSION" \
            "$CODEX_PATCH_REPORT_JSON" \
            "$INSTALL_DIR"
        info "Rebuild report: $CODEX_REBUILD_REPORT_JSON"
    fi

    if ! command -v codex &>/dev/null; then
        warn "Codex CLI not found. Install it with: npm i -g @openai/codex or npm i -g --prefix ~/.local @openai/codex"
    fi

    echo ""                                             >&2
    echo "============================================" >&2
    info "Installation complete!"
    echo "  Run:  $INSTALL_DIR/start.sh"                >&2
    echo "============================================" >&2
}

if [ "${CODEX_INSTALLER_SOURCE_ONLY:-0}" != "1" ]; then
    main "$@"
fi
