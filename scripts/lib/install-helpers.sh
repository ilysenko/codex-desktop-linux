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
  sudo apt install nodejs npm curl dpkg-dev gnupg                                    # Debian/Ubuntu
  sudo dnf install nodejs npm curl dpkg-dev gnupg2                                   # Fedora
  sudo pacman -S nodejs curl dpkg gnupg                                              # Arch
  sudo zypper install nodejs npm curl dpkg gpg2                                      # openSUSE
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

FRESH_INSTALL=0
PROVIDED_UPSTREAM_DEB_PATH="${UPSTREAM_DEB:-}"
INSPECT_ONLY=0
REPORT_DIR=""

usage() {
    cat <<'HELP'
Usage: ./install.sh [OPTIONS] [path/to/chatgpt_*.deb]

Builds the custom distribution from OpenAI's official Linux package. With no
path, the package is resolved through signed stable APT metadata.

Options:
  -h, --help     Show this help message and exit
  --fresh        Remove the existing install directory before building
  --inspect      Inspect the package and write reports without installing
  --report-dir DIR
                 Directory for --inspect reports (default: ./dist-next/rebuild)

Environment variables:
  CODEX_INSTALL_DIR   Override the install directory (default: ./codex-app)
  CODEX_INSTALL_ALLOW_RUNNING=1
                      Allow overwriting INSTALL_DIR while Codex is running
  CODEX_APP_ID        Override Linux app id/bin identity (default: codex-desktop)
  CODEX_APP_DISPLAY_NAME
                      Override display name (default: ChatGPT Community)
  UPSTREAM_DEB        Equivalent to the optional positional .deb path
  CODEX_UPSTREAM_LINUX_REPOSITORY
                      Override the official repository URL for fixture testing
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
                if [ -n "$PROVIDED_UPSTREAM_DEB_PATH" ] && [ "$1" != "$PROVIDED_UPSTREAM_DEB_PATH" ]; then
                    error "Conflicting upstream .deb paths: $PROVIDED_UPSTREAM_DEB_PATH and $1"
                fi
                case "$1" in
                    *.dmg|*.DMG) error "macOS DMG inputs are no longer supported; provide the official Linux chatgpt_*.deb" ;;
                    *.deb) ;;
                    *) error "Upstream input must be an official chatgpt_*.deb package: $1" ;;
                esac
                PROVIDED_UPSTREAM_DEB_PATH="$1"
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

    local retired_name
    for retired_name in DMG CODEX_DMG_URL CODEX_DMG_REFRESH_MODE CODEX_DMG_SHA256 CODEX_DMG_ETAG; do
        if [ -n "${!retired_name+x}" ]; then
            error "$retired_name is no longer supported; use UPSTREAM_DEB or signed stable APT metadata"
        fi
    done
}

prepare_install() {
    if [ "$FRESH_INSTALL" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then
        info "Removing existing install directory: $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi

}

# ---- Check dependencies ----
check_deps() {
    local missing=()
    for cmd in node curl dpkg-deb gpg gpgv sha256sum flock; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing dependencies: ${missing[*]}
$(dependency_help)"
    fi

    # ASAR patching needs npx unless a packaged ASAR executable was supplied.
    # Warn before downloading upstream; patch_asar() validates the tool again.
    if [ -z "${CODEX_ASAR_BIN:-}" ] && ! command -v npx &>/dev/null; then
        warn "npx not found on PATH: the required ASAR patch will fail." \
            "Install npm (Debian/Ubuntu: sudo apt install npm) or ensure the version-manager" \
            "Node bin directory is on PATH for this shell/service."
    fi

    info "All system dependencies found"
}
