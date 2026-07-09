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

prelaunch_timeout_seconds() {
    local value="${CODEX_WRAPPER_UPDATER_PRELAUNCH_TIMEOUT_SECONDS:-5}"

    case "$value" in
        ""|*[!0-9]*)
            log "invalid CODEX_WRAPPER_UPDATER_PRELAUNCH_TIMEOUT_SECONDS='${CODEX_WRAPPER_UPDATER_PRELAUNCH_TIMEOUT_SECONDS:-}'; using 5" >&2
            echo 5
            return 0
            ;;
    esac

    if [ "$value" -gt 300 ]; then
        log "CODEX_WRAPPER_UPDATER_PRELAUNCH_TIMEOUT_SECONDS=$value is too high; using 300" >&2
        echo 300
        return 0
    fi

    echo "$value"
}

run_prelaunch_apply_with_watchdog() {
    local timeout_seconds="$1"
    local manager="$2"
    local limit_ticks=$((timeout_seconds * 10))
    local ticks=0
    local apply_pid
    local output_file="${TMPDIR:-/tmp}/codex-wrapper-updater-apply-$$-${RANDOM:-0}.log"
    local status
    local use_setsid=0
    local line

    if command -v setsid >/dev/null 2>&1; then
        setsid "$manager" apply-wrapper-update >"$output_file" 2>&1 &
        use_setsid=1
    else
        "$manager" apply-wrapper-update >"$output_file" 2>&1 &
    fi
    apply_pid=$!

    while kill -0 "$apply_pid" 2>/dev/null; do
        if [ "$ticks" -ge "$limit_ticks" ]; then
            if [ "$use_setsid" -eq 1 ]; then
                kill -- "-$apply_pid" 2>/dev/null || true
                kill -9 -- "-$apply_pid" 2>/dev/null || true
            else
                kill "$apply_pid" 2>/dev/null || true
                kill -9 "$apply_pid" 2>/dev/null || true
            fi
            while IFS= read -r line || [ -n "$line" ]; do
                printf '%s\n' "$line"
            done < "$output_file" 2>/dev/null || true
            rm -f "$output_file"
            return 124
        fi
        sleep 0.1
        ticks=$((ticks + 1))
    done

    wait "$apply_pid" 2>/dev/null
    status=$?
    while IFS= read -r line || [ -n "$line" ]; do
        printf '%s\n' "$line"
    done < "$output_file" 2>/dev/null || true
    rm -f "$output_file"
    return "$status"
}

resolve_app_id() {
    local candidate="${CODEX_LINUX_APP_ID:-${CODEX_APP_ID:-chatgpt-desktop}}"
    case "$candidate" in
        ""|*[!A-Za-z0-9._-]*) echo "chatgpt-desktop" ;;
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
apply_status=0
if [ "$phase" = "prelaunch" ]; then
    timeout_seconds="$(prelaunch_timeout_seconds)"
    if [ "$timeout_seconds" -eq 0 ]; then
        log "prelaunch wrapper update apply disabled; leaving marker for after-exit retry"
        exit 0
    fi
    run_prelaunch_apply_with_watchdog "$timeout_seconds" "$manager"
    apply_status=$?
else
    "$manager" apply-wrapper-update
    apply_status=$?
fi

if [ "$apply_status" -eq 0 ]; then
    rm -f "$marker"
    log "wrapper update applied"
    [ "$phase" = "after-exit" ] && relaunch_app success
else
    if [ "$phase" = "prelaunch" ] && [ "$apply_status" -eq 124 ]; then
        log "prelaunch wrapper update apply timed out after ${timeout_seconds}s; leaving marker for after-exit retry"
    else
        log "wrapper update apply failed with status $apply_status; leaving marker for retry"
    fi
    [ "$phase" = "after-exit" ] && relaunch_app failed
fi

exit 0
