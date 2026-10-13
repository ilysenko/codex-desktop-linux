#!/usr/bin/env bash
set -euo pipefail

truthy_env_value() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

remote_mobile_control_daemon_pid() {
    local pid_file="$1"

    [ -f "$pid_file" ] || return 1
    sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$pid_file" | head -n 1
}

cleanup_stale_remote_mobile_daemon_state() {
    local codex_home="$1"
    local pid_file=""
    local pid=""

    # Upstream selects PID names by the managed installation path; both
    # namespaces remain valid, so a cold start must consider both sets.
    for pid_file in \
        "$codex_home/app-server-daemon/app-server.pid" \
        "$codex_home/app-server-daemon/app-server-updater.pid" \
        "$codex_home/app-server-daemon/daemon.pid" \
        "$codex_home/app-server-daemon/daemon-updater.pid"
    do
        [ -e "$pid_file" ] || continue
        pid="$(remote_mobile_control_daemon_pid "$pid_file" || true)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            continue
        fi
        if rm -f "$pid_file"; then
            echo "Removed stale remote mobile control daemon pid file: $pid_file"
        fi
    done
}

desktop_app_server_remote_control_enabled() {
    local app_dir="${CODEX_LINUX_APP_DIR:-}"
    local marker=""
    local marker_value=""

    if truthy_env_value "${CODEX_REMOTE_CONTROL_FORCE_COLD_START_DAEMON:-}"; then
        return 1
    fi

    [ -n "$app_dir" ] || return 1
    marker="$app_dir/.codex-linux/desktop-app-server-remote-control-enabled"
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
    marker_value="$(cat "$marker" 2>/dev/null || true)"
    if [ "$marker_value" = "version=1
owner=desktop" ]; then
        return 0
    fi
    echo "Ignoring invalid remote mobile control Desktop owner marker: $marker" >&2
    return 1
}

remote_mobile_control_systemd_state() {
    command -v systemctl >/dev/null 2>&1 || return 1
    if systemctl --user is-active --quiet codex-remote-control.service 2>/dev/null; then
        printf '%s\n' "active"
    elif systemctl --user is-enabled --quiet codex-remote-control.service 2>/dev/null ||
        systemctl --user cat codex-remote-control.service >/dev/null 2>&1; then
        printf '%s\n' "configured"
    else
        return 1
    fi
}

remote_mobile_control_owner() {
    local systemd_state=""

    if systemd_state="$(remote_mobile_control_systemd_state)"; then
        printf '%s:%s\n' "systemd" "$systemd_state"
    elif truthy_env_value "${CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED:-}"; then
        printf '%s\n' "disabled"
    elif desktop_app_server_remote_control_enabled; then
        printf '%s\n' "desktop"
    else
        printf '%s\n' "bundled"
    fi
}

remote_mobile_control_main() {
    local codex_home="${CODEX_HOME:-$HOME/.codex}"
    local owner=""

    owner="$(remote_mobile_control_owner)"

    case "$owner" in
        systemd:active)
            echo "Remote mobile control owner: systemd (codex-remote-control.service is active)"
            return 0
            ;;
        systemd:configured)
            echo "Remote mobile control owner: systemd (codex-remote-control.service is configured but inactive)"
            return 0
            ;;
        disabled)
            echo "Remote mobile control owner: disabled by CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED"
            return 0
            ;;
        desktop)
            cleanup_stale_remote_mobile_daemon_state "$codex_home"
            echo "Remote mobile control owner: desktop (app-server launches with remote-control enabled)"
            return 0
            ;;
        bundled)
            echo "Remote mobile control owner: bundled official Codex fallback"
            ;;
    esac

    local app_dir="${CODEX_LINUX_APP_DIR:-}"
    local bundled_codex="${CODEX_REMOTE_CONTROL_CODEX_PATH:-${app_dir:+$app_dir/resources/codex}}"

    if [ -z "$bundled_codex" ] || [ ! -x "$bundled_codex" ]; then
        echo "Remote mobile control Codex runtime is not executable: ${bundled_codex:-<unset>}"
        echo "The feature uses the official Codex bundled in ChatGPT Community; set CODEX_REMOTE_CONTROL_CODEX_PATH only for an explicit override."
        return 0
    fi

    if "$bundled_codex" remote-control start; then
        echo "Remote mobile control daemon is ready via $bundled_codex"
    else
        echo "Remote mobile control daemon start failed via $bundled_codex; Android remote hosts may remain disconnected."
    fi
}

run_with_timeout() {
    local timeout_seconds="${CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_TIMEOUT_SECONDS:-30}"
    if command -v timeout >/dev/null 2>&1; then
        timeout "$timeout_seconds" "$0" --run-main || \
            echo "Remote mobile control hook timed out or failed after ${timeout_seconds}s"
    else
        echo "Remote mobile control hook running without timeout; continuing best-effort in the background"
        remote_mobile_control_main &
    fi
}

if [ "${1:-}" = "--run-main" ]; then
    remote_mobile_control_main
    exit $?
fi

echo "Remote mobile control cold-start hook started at $(date -Is 2>/dev/null || date)"
run_with_timeout
