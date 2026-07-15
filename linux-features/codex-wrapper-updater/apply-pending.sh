#!/usr/bin/env bash
# Applies a generation-bound wrapper update marker. Failed or incompatible
# candidates are quarantined and never cause an automatic relaunch loop.
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

prepare_apply_command() {
    local manager="$1"
    local generation="$2"

    APPLY_COMMAND=()
    if truthy "${CODEX_LINUX_SYSTEMD_SERVICE:-0}" \
        && command -v systemd-run >/dev/null 2>&1 \
        && systemctl --user show-environment >/dev/null 2>&1; then
        APPLY_COMMAND=(
            systemd-run --user
            --unit=codex-wrapper-update-apply
            --scope
            --collect
            --quiet
            --slice=codex-maintenance.slice
            --nice=10
            --setenv=CARGO_BUILD_JOBS=2
            --
        )
    else
        APPLY_COMMAND=(env CARGO_BUILD_JOBS=2)
        if command -v nice >/dev/null 2>&1; then
            APPLY_COMMAND+=(nice -n 10)
        fi
    fi
    APPLY_COMMAND+=("$manager" apply-wrapper-update --expected-generation "$generation")
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
    local generation="$3"
    local limit_ticks=$((timeout_seconds * 10))
    local ticks=0
    local apply_pid
    local output_file="${TMPDIR:-/tmp}/codex-wrapper-updater-apply-$$-${RANDOM:-0}.log"
    local status
    local use_setsid=0
    local line

    prepare_apply_command "$manager" "$generation"
    if command -v setsid >/dev/null 2>&1; then
        setsid "${APPLY_COMMAND[@]}" >"$output_file" 2>&1 &
        use_setsid=1
    else
        "${APPLY_COMMAND[@]}" >"$output_file" 2>&1 &
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

valid_generation() {
    case "${1:-}" in
        ""|*[!0-9a-fA-F]*) return 1 ;;
    esac
    [ "${#1}" -eq 40 ]
}

read_generation() {
    local path="$1"
    local value=""
    [ -f "$path" ] || return 1
    IFS= read -r value < "$path" || true
    valid_generation "$value" || return 1
    printf '%s\n' "$value"
}

quarantine_marker() {
    local reason="$1"
    local generation="${2:-unknown}"
    local quarantine_dir="$marker_dir/quarantine"
    local target

    mkdir -p "$quarantine_dir" 2>/dev/null || {
        rm -f "$marker"
        log "removed unusable pending marker after $reason"
        return 0
    }
    target="$quarantine_dir/${generation}-$(date +%s)-${reason}.pending"
    if mv "$marker" "$target" 2>/dev/null; then
        log "quarantined pending marker after $reason"
    else
        rm -f "$marker"
        log "removed unusable pending marker after $reason"
    fi
}

state_dir="$(resolve_state_dir)" || {
    log "could not resolve app state directory"
    exit 0
}
marker_dir="$state_dir/codex-wrapper-updater"
marker="$marker_dir/pending"
restart_intent="$marker_dir/restart-intent"
phase="${CODEX_LINUX_FEATURE_HOOK_PHASE:-manual}"

[ -f "$marker" ] || exit 0

lock_dir="$marker_dir/apply.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
    log "another wrapper update apply is already running"
    exit 0
fi
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

generation="$(read_generation "$marker")" || {
    rm -f "$restart_intent"
    quarantine_marker "invalid-generation"
    exit 0
}
restart_generation="$(read_generation "$restart_intent" 2>/dev/null || true)"
restart_requested=0
if [ "$phase" = "after-exit" ] \
    && [ "${CODEX_LINUX_ELECTRON_EXIT_STATUS:-1}" = "0" ] \
    && [ "$restart_generation" = "$generation" ]; then
    restart_requested=1
fi

manager="$(resolve_update_manager)" || {
    log "codex-update-manager is not available; leaving marker for retry"
    rm -f "$restart_intent"
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
    run_prelaunch_apply_with_watchdog "$timeout_seconds" "$manager" "$generation"
    apply_status=$?
else
    prepare_apply_command "$manager" "$generation"
    "${APPLY_COMMAND[@]}"
    apply_status=$?
fi

if [ "$apply_status" -eq 0 ]; then
    rm -f "$marker" "$restart_intent"
    log "wrapper update applied"
    if [ "$restart_requested" -eq 1 ]; then
        log "requesting relaunch after all after-exit hooks complete"
        exit 85
    fi
else
    if [ "$phase" = "prelaunch" ] && [ "$apply_status" -eq 124 ]; then
        log "prelaunch wrapper update apply timed out after ${timeout_seconds}s; leaving marker for after-exit retry"
    else
        log "wrapper update apply failed with status $apply_status"
        quarantine_marker "apply-failed-${apply_status}" "$generation"
    fi
    rm -f "$restart_intent"
fi

exit 0
