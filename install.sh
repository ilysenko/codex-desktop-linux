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
. "$SCRIPT_DIR/scripts/lib/notification-actions.sh"
. "$SCRIPT_DIR/scripts/lib/linux-features.sh"
. "$SCRIPT_DIR/scripts/lib/rebuild-report.sh"
. "$SCRIPT_DIR/scripts/lib/build-info.sh"
. "$SCRIPT_DIR/scripts/lib/candidate-install.sh"

transaction_report_base() {
    if [ -n "${REBUILD_REPORT_DIR:-}" ]; then
        printf '%s\n' "$REBUILD_REPORT_DIR"
    elif [ -n "${CODEX_PATCH_REPORT_JSON:-}" ]; then
        dirname "$CODEX_PATCH_REPORT_JSON"
    else
        printf '%s\n' "$SCRIPT_DIR/dist-next/rebuild"
    fi
}

publish_transaction_report() {
    local source_path="$1"
    local destination_path="$2"
    local temporary_path
    [ -f "$source_path" ] || return 0
    mkdir -p "$(dirname "$destination_path")"
    temporary_path="${destination_path}.tmp.$$"
    cp "$source_path" "$temporary_path"
    mv -f "$temporary_path" "$destination_path"
}

write_transaction_dmg_metadata() {
    local output_path="$1"
    local dmg_path="$2"
    local cached_metadata="$3"
    "${CODEX_ACCEPTANCE_NODE:-node}" - "$output_path" "$dmg_path" "$cached_metadata" "$DMG_URL" <<'NODE'
const fs = require("node:fs");
const [outputPath, dmgPath, metadataPath, url] = process.argv.slice(2);
const metadata = { url, path: dmgPath };
if (metadataPath && fs.existsSync(metadataPath)) {
  for (const line of fs.readFileSync(metadataPath, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) metadata[line.slice(0, separator)] = line.slice(separator + 1);
  }
}
fs.mkdirSync(require("node:path").dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
NODE
}

transactional_install() {
    local -a original_args=("$@")
    local final_dir="$INSTALL_DIR"
    local final_parent
    local final_name
    local candidate_dir
    local report_base
    local report_dir
    local transaction_id
    local core_report
    local published_core_report
    local rebuild_report
    local published_rebuild_report
    local decision_path
    local published_decision_path
    local metadata_path
    local build_info_path
    local dmg_path
    local build_status="failure"
    local verdict
    local -a acceptance_args=()

    final_parent="$(dirname "$final_dir")"
    final_name="$(basename "$final_dir")"
    mkdir -p "$final_parent"
    # Recover a completed exchange before the standard candidate path can be
    # reused or cleaned by a new transaction.
    recover_pending_candidate_promotion "$final_dir"
    candidate_dir="$final_parent/.${final_name}.candidate-$$"
    assert_distinct_candidate_paths "$candidate_dir" "$final_dir"
    remove_tree_safely "$candidate_dir"

    report_base="$(transaction_report_base)"
    transaction_id="${CODEX_ACCEPTANCE_TRANSACTION_ID:-$(date -u +%Y%m%dT%H%M%S)-$$-${RANDOM:-0}}"
    report_dir="$report_base/transactions/$transaction_id"
    mkdir -p "$report_dir"
    core_report="$report_dir/patch-report.json"
    published_core_report="${CODEX_PATCH_REPORT_JSON:-$report_base/patch-report.json}"
    rebuild_report="$report_dir/rebuild-report.json"
    published_rebuild_report="${CODEX_REBUILD_REPORT_JSON:-$report_base/rebuild-report.json}"
    decision_path="$report_dir/upstream-dmg-decision.json"
    published_decision_path="${CODEX_ACCEPTANCE_DECISION_JSON:-$report_base/upstream-dmg-decision.json}"
    metadata_path="${CODEX_UPSTREAM_DMG_METADATA_JSON:-$report_dir/upstream-dmg-metadata.json}"
    rm -f "$core_report" "$rebuild_report" "$decision_path"

    info "Building a transactional candidate: $candidate_dir"
    # Re-enter through the current Bash binary. Nix builds intentionally do not
    # expose /bin/bash, so executing this script through its shebang is unsafe.
    if CODEX_INSTALL_TRANSACTION_ACTIVE=1 \
        CODEX_INSTALL_DIR="$candidate_dir" \
        CODEX_PATCH_REPORT_JSON="$core_report" \
        CODEX_REBUILD_REPORT_JSON="$rebuild_report" \
        "$BASH" "$SCRIPT_DIR/install.sh" "${original_args[@]}"; then
        build_status="success"
    fi

    if [ -n "$PROVIDED_DMG_PATH" ]; then
        dmg_path="$(realpath "$PROVIDED_DMG_PATH")"
    else
        dmg_path="$CACHED_DMG_PATH"
    fi
    build_info_path="$candidate_dir/.codex-linux/build-info.json"

    if [ -z "${CODEX_UPSTREAM_DMG_METADATA_JSON:-}" ] || [ ! -f "$metadata_path" ]; then
        write_transaction_dmg_metadata "$metadata_path" "$dmg_path" "$CACHED_DMG_METADATA_PATH"
    fi

    acceptance_args=(
        --repo-root "$SCRIPT_DIR"
        --dmg "$dmg_path"
        --core-report "$core_report"
        --build-info "$build_info_path"
        --metadata "$metadata_path"
        --build-status "$build_status"
        --output "$decision_path"
        --source "${CODEX_ACCEPTANCE_SOURCE:-local}"
    )
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && acceptance_args+=(--summary "$GITHUB_STEP_SUMMARY")
    [ -n "${GITHUB_RUN_ID:-}" ] && acceptance_args+=(--run-id "$GITHUB_RUN_ID")
    [ -n "${GITHUB_RUN_ATTEMPT:-}" ] && acceptance_args+=(--run-attempt "$GITHUB_RUN_ATTEMPT")
    if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
        acceptance_args+=(--run-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID")
    fi
    "$CODEX_ACCEPTANCE_NODE" "$SCRIPT_DIR/scripts/validate-upstream-dmg.js" "${acceptance_args[@]}"

    publish_transaction_report "$core_report" "$published_core_report"
    publish_transaction_report "$rebuild_report" "$published_rebuild_report"
    publish_transaction_report "$decision_path" "$published_decision_path"

    verdict="$("$CODEX_ACCEPTANCE_NODE" -e 'console.log(require(process.argv[1]).verdict)' "$decision_path")"
    info "Upstream DMG acceptance verdict: $verdict"
    if [ "$verdict" != "accepted" ] && [ "$verdict" != "accepted_with_warnings" ]; then
        if [ "${CODEX_ACCEPTANCE_OVERRIDE:-0}" = "1" ] && [ "$build_status" = "success" ]; then
            warn "CODEX_ACCEPTANCE_OVERRIDE=1 set; promoting a candidate with verdict $verdict"
        else
            if [ "${CODEX_KEEP_REJECTED_CANDIDATE:-0}" != "1" ]; then
                remove_tree_safely "$candidate_dir"
            else
                warn "Rejected candidate retained for diagnostics: $candidate_dir"
            fi
            error "Candidate was not installed (verdict: $verdict). Decision: $published_decision_path"
        fi
    fi

    mkdir -p "$candidate_dir/.codex-linux"
    cp "$decision_path" "$candidate_dir/.codex-linux/upstream-dmg-decision.json"
    if ! promote_candidate_install "$candidate_dir" "$final_dir"; then
        if [ "${CODEX_KEEP_REJECTED_CANDIDATE:-0}" != "1" ]; then
            remove_tree_safely "$candidate_dir"
        else
            warn "Unpromoted candidate retained for diagnostics: $candidate_dir"
        fi
        error "Accepted candidate could not be promoted; the existing app was not changed"
    fi
    info "Acceptance transaction reports: $report_dir"
    info "Acceptance decision: $published_decision_path"
    if [ -n "${PROMOTED_BACKUP_APP_DIR:-}" ]; then
        info "Previous app backup: $PROMOTED_BACKUP_APP_DIR"
    fi
}

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
    cp "$SCRIPT_DIR/launcher/cli-launch-path.py" "$INSTALL_DIR/.codex-linux/cli-launch-path.py"
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
    if [ "$INSPECT_ONLY" -ne 1 ] && [ "${CODEX_INSTALL_TRANSACTION_ACTIVE:-0}" != "1" ]; then
        check_deps
        ensure_managed_node_runtime "$WORK_DIR/node-runtime"
        CODEX_ACCEPTANCE_NODE="$CODEX_MANAGED_NODE_RUNTIME_DIR/bin/node"
        export CODEX_ACCEPTANCE_NODE
        transactional_install "$@"
        return 0
    fi
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
    stage_linux_notification_actions_bridge
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
