#!/bin/bash
set -u

command_name="${1:-start}"
package_name="${2:-codex-desktop}"
launcher="${3:-/usr/bin/$package_name}"
app_root="${CODEX_DESKTOP_SERVICE_APP_ROOT:-/opt/$package_name}"
electron_path="$app_root/electron"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}"
pid_file="$state_root/$package_name/app.pid"

canonical_path() {
    realpath -m "$1"
}

proc_root() {
    printf '%s\n' "${CODEX_PROCESS_PROC_ROOT:-/proc}"
}

pid_is_current_user() {
    local pid="$1"
    local root
    local uid

    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    root="$(proc_root)"
    [ -d "$root/$pid" ] || return 1
    uid="$(awk '/^Uid:/ {print $2}' "$root/$pid/status" 2>/dev/null || true)"
    [ "$uid" = "$(id -u)" ]
}

pid_is_electron_helper() {
    local pid="$1"
    local root

    root="$(proc_root)"
    [ -r "$root/$pid/cmdline" ] || return 1
    tr '\0' '\n' < "$root/$pid/cmdline" 2>/dev/null | grep -Eq '(^|[[:space:]])--type='
}

pid_matches_app() {
    local pid="$1"
    local actual
    local deleted_suffix=" (deleted)"
    local root

    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    root="$(proc_root)"
    [ -d "$root/$pid" ] || return 1
    pid_is_current_user "$pid" || return 1
    actual="$(readlink -f "$root/$pid/exe" 2>/dev/null || true)"
    [ -n "$actual" ] || return 1
    actual="${actual%"$deleted_suffix"}"
    [ "$(canonical_path "$actual")" = "$(canonical_path "$electron_path")" ] || return 1
    ! pid_is_electron_helper "$pid"
}

find_running_app_pid() {
    local pid
    local proc_exe
    local root

    [ -e "$electron_path" ] || return 1
    root="$(proc_root)"

    if [ -f "$pid_file" ]; then
        pid="$(cat "$pid_file" 2>/dev/null || true)"
        if pid_matches_app "$pid"; then
            printf '%s\n' "$pid"
            return 0
        fi
    fi

    for proc_exe in "$root"/[0-9]*/exe; do
        [ -e "$proc_exe" ] || continue
        pid="${proc_exe#"$root"/}"
        pid="${pid%/exe}"
        if pid_matches_app "$pid"; then
            printf '%s\n' "$pid"
            return 0
        fi
    done

    return 1
}

start_service() {
    local status=0
    local pid=""

    "$launcher" || status=$?
    if [ "$status" -ne 0 ]; then
        return "$status"
    fi

    for _ in $(seq 1 40); do
        if pid="$(find_running_app_pid)"; then
            break
        fi
        sleep 0.25
    done

    [ -n "$pid" ] || return 0
    while kill -0 "$pid" 2>/dev/null; do
        sleep 2
        if ! pid_matches_app "$pid"; then
            break
        fi
    done
}

stop_service() {
    local pid

    if ! pid="$(find_running_app_pid)"; then
        return 0
    fi

    if [ "${CODEX_DESKTOP_SERVICE_DRY_RUN:-0}" = "1" ]; then
        printf 'terminate %s\n' "$pid"
        return 0
    fi

    kill -TERM "$pid" 2>/dev/null || return 0
    for _ in $(seq 1 30); do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.25
    done
    kill -KILL "$pid" 2>/dev/null || true
}

case "$command_name" in
    start)
        start_service
        ;;
    stop)
        stop_service
        ;;
    *)
        echo "Usage: $0 {start|stop} [package-name] [launcher]" >&2
        exit 64
        ;;
esac
