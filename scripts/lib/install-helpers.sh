#!/bin/bash
# Generic installer helpers — logging, args, cleanup, deps, identity validation.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

dependency_help() {
    cat <<'EOF'
Run the helper to install them automatically:
  bash scripts/install-deps.sh

Or install manually:
  sudo apt install python3 curl unzip tar binutils build-essential                  # Debian/Ubuntu
  sudo dnf install python3 curl unzip tar binutils rpm-build make gcc-c++ @development-tools       # Fedora 41+
  sudo dnf install python3 curl unzip tar binutils rpm-build make gcc-c++            # Fedora <41
    && sudo dnf groupinstall 'Development Tools'
  sudo pacman -S python curl unzip tar binutils zstd base-devel                      # Arch
  sudo zypper install python3 curl unzip tar binutils                                # openSUSE
    && sudo zypper install -t pattern devel_basis
EOF
}

remove_tree_safely() {
    local path="$1"
    [ -e "$path" ] || [ -L "$path" ] || return 0
    # Sources copied from immutable stores can preserve read-only directory
    # modes. Make only the local copy writable before removing it.
    chmod -R u+w "$path" 2>/dev/null || true
    rm -rf -- "$path"
}

cleanup() {
    remove_tree_safely "$WORK_DIR"
}
trap cleanup EXIT
trap 'error "Failed at line $LINENO (exit code $?)"' ERR

CACHED_UPSTREAM_ARTIFACT_PATH="$SCRIPT_DIR/ChatGPT.deb"
CACHED_UPSTREAM_ARTIFACT_METADATA_PATH="$CACHED_UPSTREAM_ARTIFACT_PATH.metadata"
FRESH_INSTALL=0
REUSE_CACHED_UPSTREAM_ARTIFACT=1
PROVIDED_UPSTREAM_ARTIFACT_PATH=""
INSPECT_ONLY=0
REPORT_DIR=""

usage() {
    cat <<'HELP'
Usage: ./install.sh [OPTIONS] [path/to/chatgpt.deb]

Builds the repository's packages and optional features on OpenAI's official Linux app.

Options:
  -h, --help     Show this help message and exit
  --fresh        Remove the existing install directory and cached upstream package
  --reuse-artifact
                 Reuse cached ChatGPT.deb when upstream metadata still matches (default)
  --inspect      Inspect the official Linux package without installing
  --report-dir DIR
                 Directory for --inspect reports (default: ./dist-next/rebuild)

Environment variables:
  CODEX_INSTALL_DIR   Override the install directory (default: ./codex-app)
  CODEX_INSTALL_ALLOW_RUNNING=1
                      Allow overwriting INSTALL_DIR while Codex is running
  CODEX_APP_ID        Override Linux app id/bin identity (default: codex-desktop)
  CODEX_APP_DISPLAY_NAME
                      Override display name (default: ChatGPT)
  CODEX_WEBVIEW_PORT  Override webview HTTP port (default: 5175, or 5176 for non-default app ids)
  CODEX_UPSTREAM_ARTIFACT_URL
                      Override the official Linux .deb URL
  CODEX_UPSTREAM_ARTIFACT_REFRESH_MODE=pinned
                      Reuse an existing cached ChatGPT.deb verbatim and refuse
                      network refresh/download when no explicit package is passed
  REBUILD_REPORT_DIR  Default report directory for --inspect and rebuild reports
  CODEX_ACCEPTANCE_OVERRIDE=1
                      Developer-only promotion override for a completely built
                      candidate rejected by the shared acceptance profile
  CODEX_KEEP_REJECTED_CANDIDATE=1
                      Keep a rejected or safely unpromoted sibling candidate
                      for diagnostics

After install, launch with:
  ./codex-app/start.sh
HELP
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --fresh)
                FRESH_INSTALL=1
                REUSE_CACHED_UPSTREAM_ARTIFACT=0
                ;;
            --reuse-artifact)
                REUSE_CACHED_UPSTREAM_ARTIFACT=1
                ;;
            --inspect)
                INSPECT_ONLY=1
                ;;
            --report-dir)
                shift
                [ $# -gt 0 ] || error "--report-dir requires a directory"
                REPORT_DIR="$1"
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            -*)
                error "Unknown option: $1 (see --help)"
                ;;
            *)
                [ -z "$PROVIDED_UPSTREAM_ARTIFACT_PATH" ] || error "Only one upstream package path may be provided"
                PROVIDED_UPSTREAM_ARTIFACT_PATH="$1"
                ;;
        esac
        shift
    done
}

validate_app_identity() {
    case "$CODEX_APP_ID" in
        ""|*[^A-Za-z0-9._-]*)
            error "CODEX_APP_ID must contain only letters, numbers, dots, underscores, and hyphens"
            ;;
    esac

    [ -n "$CODEX_APP_DISPLAY_NAME" ] || error "CODEX_APP_DISPLAY_NAME must not be empty"

    case "$CODEX_WEBVIEW_PORT" in
        ""|*[!0-9]*)
            error "CODEX_WEBVIEW_PORT must be a TCP port number"
            ;;
    esac
    local port_number
    port_number="$CODEX_WEBVIEW_PORT"
    while [ "${port_number#0}" != "$port_number" ]; do
        port_number="${port_number#0}"
    done
    [ -n "$port_number" ] || port_number=0
    if [ "${#port_number}" -gt 5 ] || [ "$port_number" -lt 1 ] || [ "$port_number" -gt 65535 ]; then
        error "CODEX_WEBVIEW_PORT must be between 1 and 65535"
    fi
    CODEX_WEBVIEW_PORT="$port_number"
}

shell_quote() {
    printf '%q' "$1"
}

upstream_artifact_refresh_mode_is_pinned() {
    case "${CODEX_UPSTREAM_ARTIFACT_REFRESH_MODE:-auto}" in
        ""|auto)
            return 1
            ;;
        pinned|pin|1|true|yes)
            return 0
            ;;
        *)
            error "CODEX_UPSTREAM_ARTIFACT_REFRESH_MODE must be 'auto' or 'pinned'"
            ;;
    esac
}

prepare_install() {
    if [ "$FRESH_INSTALL" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then
        info "Removing existing install directory: $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi

    if [ "$FRESH_INSTALL" -eq 1 ] && [ "$REUSE_CACHED_UPSTREAM_ARTIFACT" -ne 1 ] \
            && ! upstream_artifact_refresh_mode_is_pinned \
            && { [ -e "$CACHED_UPSTREAM_ARTIFACT_PATH" ] || [ -e "$CACHED_UPSTREAM_ARTIFACT_METADATA_PATH" ]; }; then
        info "Removing cached upstream package and metadata: $CACHED_UPSTREAM_ARTIFACT_PATH"
        rm -f "$CACHED_UPSTREAM_ARTIFACT_PATH"
        rm -f "$CACHED_UPSTREAM_ARTIFACT_METADATA_PATH"
    fi
}

# ---- Check dependencies ----
check_deps() {
    local missing=()
    for cmd in python3 curl unzip tar ar flock; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing dependencies: ${missing[*]}
$(dependency_help)"
    fi

    if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
        error "Build tools (make, g++) required:
$(dependency_help)"
    fi

    info "All system dependencies found"
}
