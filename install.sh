#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${CODEX_INSTALL_DIR:-$SCRIPT_DIR/codex-app}"
DMG_CACHE_PATH="$SCRIPT_DIR/Codex.dmg"
STATE_DIR="$INSTALL_DIR/.updater"
STATE_FILE="$STATE_DIR/state.env"
PENDING_FILE="$STATE_DIR/pending"
LOG_FILE="$STATE_DIR/update.log"
RUNTIME_LIBRARY_SOURCE="$SCRIPT_DIR/lib/install-common.sh"

# shellcheck disable=SC1091
source "$RUNTIME_LIBRARY_SOURCE"

trap cleanup_work_dir EXIT
trap 'error "Failed at line $LINENO (exit code $?)"' ERR

usage() {
    cat <<EOF
Usage:
  ./install.sh
  ./install.sh /path/to/Codex.dmg

Environment:
  CODEX_INSTALL_DIR   Custom install directory (must be user-writable for auto-updates)
  CODEX_AUTO_UPDATE   Set to 0 to skip enabling the timer and launch-time updater
  CODEX_UPDATE_URL    Override the upstream DMG URL (mainly for testing)
EOF
}

main() {
    local dmg_path=""
    local stage_dir=""

    if [ $# -gt 1 ]; then
        usage
        exit 1
    fi

    case "${1:-}" in
        -h|--help)
            usage
            exit 0
            ;;
    esac

    print_install_banner
    check_deps

    if [ $# -eq 1 ]; then
        [ -f "$1" ] || error "Provided DMG not found: $1"
        dmg_path="$(realpath "$1")"
        info "Using provided DMG: $dmg_path"
    else
        dmg_path="$(get_dmg_for_install "$DMG_CACHE_PATH")"
    fi

    stage_dir="${INSTALL_DIR}.install.$$"
    perform_install_pipeline "$dmg_path" "$stage_dir"
    write_initial_state "$stage_dir"
    promote_stage_install "$stage_dir" "$INSTALL_DIR"

    if [ "${CODEX_AUTO_UPDATE:-1}" != "0" ]; then
        install_systemd_user_units
    else
        warn "Auto-update disabled via CODEX_AUTO_UPDATE=0; skipping timer setup"
    fi

    if ! command -v codex >/dev/null 2>&1; then
        warn "Codex CLI not found. Install it: npm i -g @openai/codex"
    fi

    echo "" >&2
    echo "============================================" >&2
    info "Installation complete!"
    echo "  Run:  $INSTALL_DIR/start.sh" >&2
    echo "============================================" >&2
}

main "$@"
