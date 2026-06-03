#!/usr/bin/env bash
# Applies a pending wrapper update marker. This hook is intentionally fail-closed:
# failed applies leave the marker in place so a later launch/exit can retry.
set -uo pipefail

log() {
    echo "[codex-wrapper-updater] $*"
}

truthy() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

resolve_app_id() {
    local candidate="${CODEX_LINUX_APP_ID:-${CODEX_APP_ID:-codex-desktop}}"
    case "$candidate" in
        ""|*[!A-Za-z0-9._-]*) echo "codex-desktop" ;;
        *) echo "$candidate" ;;
    esac
}

resolve_state_dir() {
    if [ -n "${CODEX_LINUX_APP_STATE_DIR:-}" ]; then
        echo "$CODEX_LINUX_APP_STATE_DIR"
        return 0
    fi

    local state_root
    if [ -n "${XDG_STATE_HOME:-}" ]; then
        state_root="$XDG_STATE_HOME"
    elif [ -n "${HOME:-}" ]; then
        state_root="$HOME/.local/state"
    else
        return 1
    fi
    echo "$state_root/$(resolve_app_id)"
}

resolve_update_manager() {
    if [ -n "${CODEX_UPDATE_MANAGER_PATH:-}" ] && [ -x "$CODEX_UPDATE_MANAGER_PATH" ]; then
        echo "$CODEX_UPDATE_MANAGER_PATH"
        return 0
    fi
    command -v codex-update-manager 2>/dev/null
}

relaunch_app() {
    local launcher="${CODEX_LINUX_LAUNCHER_CMD:-}"
    [ -n "$launcher" ] || return 0
    [ -x "$launcher" ] || return 0

    if [ "${1:-success}" = "failed" ]; then
        ( sleep 1; CODEX_WRAPPER_UPDATER_SKIP_PRELAUNCH_ONCE=1 "$launcher" >/dev/null 2>&1 ) &
    else
        ( sleep 1; "$launcher" >/dev/null 2>&1 ) &
    fi
}

state_dir="$(resolve_state_dir)" || {
    log "could not resolve app state directory"
    exit 0
}
marker_dir="$state_dir/codex-wrapper-updater"
marker="$marker_dir/pending"
phase="${CODEX_LINUX_FEATURE_HOOK_PHASE:-manual}"

[ -f "$marker" ] || exit 0

if [ "$phase" = "prelaunch" ] && truthy "${CODEX_WRAPPER_UPDATER_SKIP_PRELAUNCH_ONCE:-0}"; then
    log "skipping one prelaunch retry after a failed after-exit apply"
    exit 0
fi

lock_dir="$marker_dir/apply.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
    log "another wrapper update apply is already running"
    exit 0
fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

manager="$(resolve_update_manager)" || {
    log "codex-update-manager is not available; leaving marker for retry"
    [ "$phase" = "after-exit" ] && relaunch_app failed
    exit 0
}

log "applying pending wrapper update via $manager"
if "$manager" apply-wrapper-update; then
    rm -f "$marker"
    log "wrapper update applied"
    [ "$phase" = "after-exit" ] && relaunch_app success
else
    log "wrapper update apply failed; leaving marker for retry"
    [ "$phase" = "after-exit" ] && relaunch_app failed
fi

exit 0
