#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
    cat <<'HELP'
Usage: scripts/rebuild-candidate.sh [--install] [path/to/ChatGPT.dmg]

Runs the safe rebuild flow:
  1. Use the installer-managed ChatGPT.dmg cache, unless a DMG path is given.
  2. Inspect the DMG and write reports.
  3. Build a side-by-side candidate in chatgpt-app-next/.
  4. With --install, move the candidate into chatgpt-app/ and keep a backup.

Environment:
  CODEX_NEXT_APP_DIR   Candidate app directory (default: ./chatgpt-app-next)
  CODEX_FINAL_APP_DIR  Final app directory for --install (default: ./chatgpt-app)
  REBUILD_REPORT_DIR   Report directory (default: ./dist-next/rebuild)
HELP
}

info() {
    echo "[rebuild] $*" >&2
}

error() {
    echo "[rebuild][ERROR] $*" >&2
    exit 1
}

INSTALL_AFTER_BUILD=0
DMG_PATH=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --install)
            INSTALL_AFTER_BUILD=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            usage >&2
            exit 2
            ;;
        *)
            if [ -n "$DMG_PATH" ]; then
                usage >&2
                exit 2
            fi
            DMG_PATH="$1"
            ;;
    esac
    shift
done

NEXT_APP_DIR="${CODEX_NEXT_APP_DIR:-$REPO_DIR/chatgpt-app-next}"
FINAL_APP_DIR="${CODEX_FINAL_APP_DIR:-$REPO_DIR/chatgpt-app}"
REPORT_DIR="${REBUILD_REPORT_DIR:-$REPO_DIR/dist-next/rebuild}"
PATCH_REPORT="$REPORT_DIR/patch-report.json"
REBUILD_REPORT="$REPORT_DIR/rebuild-report.json"

resolve_dmg_path() {
    local explicit_path="$1"

    if [ -n "$explicit_path" ]; then
        [ -f "$explicit_path" ] || error "DMG not found: $explicit_path"
        realpath "$explicit_path"
        return 0
    fi

    echo ""
}

unique_backup_path() {
    local target="$1"
    local backup_base="$target.backup-$(date +%Y%m%d%H%M%S)"
    local backup="$backup_base"
    local index=1

    while [ -e "$backup" ]; do
        backup="$backup_base-$index"
        index=$((index + 1))
    done

    echo "$backup"
}

canonical_path() {
    readlink -f "$1" 2>/dev/null || realpath "$1"
}

find_running_app_pid() {
    local electron_path="$1"
    local expected
    local proc_exe
    local pid
    local actual

    [ -e "$electron_path" ] || return 1
    expected="$(canonical_path "$electron_path")"

    for proc_exe in /proc/[0-9]*/exe; do
        [ -e "$proc_exe" ] || continue
        pid="${proc_exe#/proc/}"
        pid="${pid%/exe}"
        actual="$(readlink -f "$proc_exe" 2>/dev/null || true)"
        if [ "$actual" = "$expected" ]; then
            echo "$pid"
            return 0
        fi
    done

    return 1
}

install_candidate() {
    local backup=""
    local pid

    [ -d "$NEXT_APP_DIR" ] || error "Candidate app was not created: $NEXT_APP_DIR"
    [ "$NEXT_APP_DIR" != "$FINAL_APP_DIR" ] || error "Candidate and final app paths must differ"

    if pid="$(find_running_app_pid "$FINAL_APP_DIR/electron")"; then
        error "ChatGPT Desktop is running from $FINAL_APP_DIR (pid $pid). Close it before installing."
    fi

    if [ -e "$FINAL_APP_DIR" ]; then
        backup="$(unique_backup_path "$FINAL_APP_DIR")"
        info "Moving existing app to backup: $backup"
        mv "$FINAL_APP_DIR" "$backup"
    fi

    info "Installing candidate: $FINAL_APP_DIR"
    mv "$NEXT_APP_DIR" "$FINAL_APP_DIR"

    echo "$backup"
}

DMG_PATH="$(resolve_dmg_path "$DMG_PATH")"
dmg_args=()
if [ -n "$DMG_PATH" ]; then
    dmg_args=("$DMG_PATH")
    info "Using DMG: $DMG_PATH"
else
    info "No explicit DMG given; installer will validate, reuse, or download ChatGPT.dmg"
fi

info "1/2 Inspecting upstream DMG"
"$REPO_DIR/install.sh" --inspect --report-dir "$REPORT_DIR" "${dmg_args[@]}"

if [ -z "$DMG_PATH" ]; then
    DMG_PATH="$REPO_DIR/ChatGPT.dmg"
    [ -f "$DMG_PATH" ] || error "Installer did not produce cached DMG: $DMG_PATH"
    dmg_args=("$DMG_PATH")
    info "Using validated DMG for build: $DMG_PATH"
fi

info "2/2 Building side-by-side candidate"
CODEX_INSTALL_DIR="$NEXT_APP_DIR" \
CODEX_PATCH_REPORT_JSON="$PATCH_REPORT" \
CODEX_REBUILD_REPORT_JSON="$REBUILD_REPORT" \
REBUILD_REPORT_DIR="$REPORT_DIR" \
    "$REPO_DIR/install.sh" "${dmg_args[@]}"

BACKUP_APP_DIR=""
if [ "$INSTALL_AFTER_BUILD" -eq 1 ]; then
    BACKUP_APP_DIR="$(install_candidate)"
fi

cat <<EOF

[rebuild] Complete
  App:            $([ "$INSTALL_AFTER_BUILD" -eq 1 ] && echo "$FINAL_APP_DIR" || echo "$NEXT_APP_DIR")
  Run:            $([ "$INSTALL_AFTER_BUILD" -eq 1 ] && echo "$FINAL_APP_DIR/start.sh" || echo "$NEXT_APP_DIR/start.sh")
  Patch report:   $PATCH_REPORT
  Rebuild report: $REBUILD_REPORT
  Backup:         ${BACKUP_APP_DIR:-none}

EOF
