#!/bin/bash
set -Eeuo pipefail

# Build the custom codex-desktop distribution from OpenAI's official Linux
# package. The unattended source of trust is the signed stable APT index.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_APP_ID="${CODEX_APP_ID:-codex-desktop}"
CODEX_APP_DISPLAY_NAME="${CODEX_APP_DISPLAY_NAME:-ChatGPT Community}"
INSTALL_ROOT="${CODEX_INSTALL_ROOT:-$SCRIPT_DIR}"
DEFAULT_INSTALL_DIR_NAME="codex-app"
if [ "$CODEX_APP_ID" != "codex-desktop" ]; then
    DEFAULT_INSTALL_DIR_NAME="$CODEX_APP_ID-app"
fi
INSTALL_DIR="${CODEX_INSTALL_DIR:-$INSTALL_ROOT/$DEFAULT_INSTALL_DIR_NAME}"
WORK_DIR="$(mktemp -d)"
ARCH="${CODEX_TARGET_ARCH:-$(uname -m)}"
ICON_SOURCE="$SCRIPT_DIR/assets/codex-linux.png"

. "$SCRIPT_DIR/scripts/lib/install-helpers.sh"
. "$SCRIPT_DIR/scripts/lib/process-detection.sh"
. "$SCRIPT_DIR/scripts/lib/upstream-linux-package.sh"
. "$SCRIPT_DIR/scripts/lib/asar-patch.sh"
. "$SCRIPT_DIR/scripts/lib/linux-features.sh"
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

transactional_install() {
    local -a original_args=("$@")
    local final_dir="$INSTALL_DIR"
    local final_parent
    local final_name
    local candidate_dir
    local report_base
    local transaction_id
    local transaction_dir

    final_parent="$(dirname "$final_dir")"
    final_name="$(basename "$final_dir")"
    mkdir -p "$final_parent"
    recover_pending_candidate_promotion "$final_dir"
    candidate_dir="$final_parent/.${final_name}.candidate-$$"
    assert_distinct_candidate_paths "$candidate_dir" "$final_dir"
    remove_tree_safely "$candidate_dir"

    report_base="$(transaction_report_base)"
    transaction_id="${CODEX_ACCEPTANCE_TRANSACTION_ID:-$(date -u +%Y%m%dT%H%M%S)-$$-${RANDOM:-0}}"
    transaction_dir="$report_base/transactions/$transaction_id"
    mkdir -p "$transaction_dir"

    info "Building transactional candidate: $candidate_dir"
    if ! CODEX_INSTALL_TRANSACTION_ACTIVE=1 \
        CODEX_INSTALL_DIR="$candidate_dir" \
        CODEX_PATCH_REPORT_JSON="$transaction_dir/patch-report.json" \
        CODEX_UPSTREAM_LINUX_METADATA_JSON="$transaction_dir/upstream-linux-package.json" \
        "$BASH" "$SCRIPT_DIR/install.sh" "${original_args[@]}"; then
        if [ "${CODEX_KEEP_REJECTED_CANDIDATE:-0}" != "1" ]; then
            remove_tree_safely "$candidate_dir"
        else
            warn "Failed candidate retained for diagnostics: $candidate_dir"
        fi
        error "Official Linux package candidate failed; existing installation was not changed"
    fi

    mkdir -p "$report_base"
    cp "$transaction_dir/patch-report.json" "$report_base/patch-report.json"
    cp "$transaction_dir/upstream-linux-package.json" "$report_base/upstream-linux-package.json"
    if ! promote_candidate_install "$candidate_dir" "$final_dir"; then
        remove_tree_safely "$candidate_dir"
        error "Candidate could not be promoted; existing installation was not changed"
    fi
    info "Transaction reports: $transaction_dir"
    [ -z "${PROMOTED_BACKUP_APP_DIR:-}" ] || info "Previous app backup: $PROMOTED_BACKUP_APP_DIR"
}

create_start_script() {
    sed \
        -e "s/__CODEX_LINUX_APP_ID__/$CODEX_APP_ID/g" \
        -e "s/__CODEX_LINUX_APP_DISPLAY_NAME__/$CODEX_APP_DISPLAY_NAME/g" \
        "$SCRIPT_DIR/launcher/start.sh.template" > "$INSTALL_DIR/start.sh"
    chmod 0755 "$INSTALL_DIR/start.sh"
}

stage_community_branding() {
    mkdir -p "$INSTALL_DIR/.codex-linux"
    if [ -f "$ICON_SOURCE" ]; then
        cp "$ICON_SOURCE" "$INSTALL_DIR/.codex-linux/$CODEX_APP_ID.png"
        cp "$ICON_SOURCE" "$INSTALL_DIR/resources/icon-chatgpt.png"
    fi
}

verify_clean_asar_preserved() {
    local upstream_asar="$1"
    local output_asar="$2"
    local feature_descriptor_count
    feature_descriptor_count="$(node "$SCRIPT_DIR/scripts/lib/linux-features.js" --patch-descriptor-count)"
    [ "$feature_descriptor_count" -eq 0 ] || return 0
    cmp -s "$upstream_asar" "$output_asar" && return 0
    [ -n "${CODEX_PATCH_REPORT_RESOLVED:-}" ] &&
        patch_report_has_only_required_core_changes "$CODEX_PATCH_REPORT_RESOLVED" && return 0
    error "Default build changed resources/app.asar outside a required core patch; refusing candidate"
}

build_from_upstream_package() {
    local metadata_path="${CODEX_UPSTREAM_LINUX_METADATA_JSON:-$WORK_DIR/upstream-linux-package.json}"
    resolve_upstream_linux_package "$metadata_path"
    extract_upstream_linux_package "$UPSTREAM_DEB_PATH"

    if [ "$INSPECT_ONLY" -eq 1 ]; then
        CODEX_PATCH_REPORT_JSON="${REPORT_DIR:-${REBUILD_REPORT_DIR:-$SCRIPT_DIR/dist-next/rebuild}}/patch-report.json"
        patch_asar "$UPSTREAM_APP_DIR"
        info "Inspection report: $CODEX_PATCH_REPORT_JSON"
        return 0
    fi

    stage_official_linux_payload "$UPSTREAM_APP_DIR"
    patch_asar "$INSTALL_DIR"
    verify_clean_asar_preserved \
        "$UPSTREAM_APP_DIR/resources/app.asar" \
        "$INSTALL_DIR/resources/app.asar"
    run_linux_feature_stage_hooks "$UPSTREAM_APP_DIR"
    create_start_script
    stage_community_branding

    if [ -n "${CODEX_PATCH_REPORT_RESOLVED:-}" ] && [ -f "$CODEX_PATCH_REPORT_RESOLVED" ]; then
        cp "$CODEX_PATCH_REPORT_RESOLVED" "$INSTALL_DIR/.codex-linux/patch-report.json"
    fi
    write_build_info "$UPSTREAM_DEB_PATH" "$metadata_path"
}

main() {
    echo "============================================" >&2
    echo "  codex-desktop — official Linux upstream" >&2
    echo "============================================" >&2

    parse_args "$@"
    validate_app_identity
    check_deps

    if [ "$INSPECT_ONLY" -ne 1 ] && [ "${CODEX_INSTALL_TRANSACTION_ACTIVE:-0}" != "1" ]; then
        assert_install_target_not_running
        transactional_install "$@"
        info "Installation complete: $INSTALL_DIR/start.sh"
        return 0
    fi

    if [ "$INSPECT_ONLY" -ne 1 ]; then
        prepare_install
    fi
    build_from_upstream_package
}

if [ "${CODEX_INSTALLER_SOURCE_ONLY:-0}" != "1" ]; then
    main "$@"
fi
