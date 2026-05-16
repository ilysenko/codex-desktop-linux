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
  sudo apt install python3 p7zip-full curl unzip build-essential                   # Debian/Ubuntu
  sudo dnf install python3 7zip curl unzip @development-tools                       # Fedora 41+ (dnf5)
  sudo dnf install nodejs npm python3 p7zip p7zip-plugins curl unzip                # Fedora <41 (dnf)
    && sudo dnf groupinstall 'Development Tools'
  sudo pacman -S python p7zip curl unzip zstd base-devel                            # Arch
  sudo zypper install python3 p7zip-full curl unzip                                 # openSUSE
    && sudo zypper install -t pattern devel_basis
EOF
}

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'error "Failed at line $LINENO (exit code $?)"' ERR

CACHED_DMG_PATH="$SCRIPT_DIR/Codex.dmg"
FRESH_INSTALL=0
REUSE_CACHED_DMG=1
PROVIDED_DMG_PATH=""
INSPECT_ONLY=0
REPORT_DIR=""

usage() {
    cat <<'HELP'
Usage: ./install.sh [OPTIONS] [path/to/Codex.dmg]

Converts the official macOS Codex Desktop app to run on Linux.

Options:
  -h, --help     Show this help message and exit
  --fresh        Remove existing install directory and cached DMG before building
  --reuse-dmg    Reuse cached Codex.dmg if present (default)
  --inspect      Inspect the DMG and write patch/rebuild reports without installing
  --report-dir DIR
                 Directory for --inspect reports (default: ./dist-next/rebuild)

Environment variables:
  CODEX_INSTALL_DIR   Override the install directory (default: ./codex-app)
  CODEX_INSTALL_ALLOW_RUNNING=1
                      Allow overwriting INSTALL_DIR while Codex is running
  CODEX_APP_ID        Override Linux app id/bin identity (default: codex-desktop)
  CODEX_APP_DISPLAY_NAME
                      Override display name (default: Codex Desktop)
  CODEX_WEBVIEW_PORT  Override webview HTTP port (default: 5175, or 5176 for non-default app ids)
  ELECTRON_HEADERS_URL
                      Override the Electron headers URL used by @electron/rebuild
                      (default: https://artifacts.electronjs.org/headers/dist)
  ELECTRON_MIRROR     Override the Electron runtime download mirror root
                      (example: https://npmmirror.com/mirrors/electron/)
  REBUILD_REPORT_DIR  Default report directory for --inspect and rebuild reports

After install, launch with:
  ./codex-app/start.sh
HELP
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --fresh)
                FRESH_INSTALL=1
                REUSE_CACHED_DMG=0
                ;;
            --reuse-dmg)
                REUSE_CACHED_DMG=1
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
                [ -z "$PROVIDED_DMG_PATH" ] || error "Only one DMG path may be provided"
                PROVIDED_DMG_PATH="$1"
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
    if [ "$CODEX_WEBVIEW_PORT" -lt 1 ] || [ "$CODEX_WEBVIEW_PORT" -gt 65535 ]; then
        error "CODEX_WEBVIEW_PORT must be between 1 and 65535"
    fi
}

shell_quote() {
    printf '%q' "$1"
}

prepare_install() {
    if [ "$FRESH_INSTALL" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then
        info "Removing existing install directory: $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi

    if [ "$FRESH_INSTALL" -eq 1 ] && [ "$REUSE_CACHED_DMG" -ne 1 ] && [ -f "$CACHED_DMG_PATH" ]; then
        info "Removing cached DMG: $CACHED_DMG_PATH"
        rm -f "$CACHED_DMG_PATH"
    fi
}

# ---- Check dependencies ----
check_deps() {
    local missing=()
    for cmd in python3 curl unzip tar; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if ! command -v 7zz &>/dev/null && ! command -v 7z &>/dev/null; then
        missing+=("7z or 7zz")
    fi
    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing dependencies: ${missing[*]}
$(dependency_help)"
    fi

    if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
        error "Build tools (make, g++) required:
$(dependency_help)"
    fi

    # Prefer modern 7-zip if available (required for APFS DMG)
    if command -v 7zz &>/dev/null; then
        SEVEN_ZIP_CMD="7zz"
    else
        SEVEN_ZIP_CMD="7z"
    fi

    local seven_zip_banner
    seven_zip_banner="$("$SEVEN_ZIP_CMD" 2>&1 | head -n 3 || true)"
    if [[ "$seven_zip_banner" == *"16.02"* || "$seven_zip_banner" == *"p7zip Version"* ]]; then
        error "System 7-zip is too old for modern APFS DMGs or lacks APFS support.
Install a newer 7zz first by running:
  bash scripts/install-deps.sh

That helper bootstraps a current 7zz into ~/.local/bin by default.
If ~/.local/bin is not on your PATH, add it before re-running this script:
  export PATH=\"$HOME/.local/bin:$PATH\"
Set SEVENZIP_SYSTEM_INSTALL=1 to install into /usr/local/bin instead."
    fi

    info "All system dependencies found (using $SEVEN_ZIP_CMD)"
}
