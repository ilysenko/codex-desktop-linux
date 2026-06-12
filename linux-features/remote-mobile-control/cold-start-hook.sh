#!/usr/bin/env bash
set -euo pipefail

truthy_env_value() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

cleanup_remote_mobile_control_interactive_symlink() {
    local codex_home="$1"
    local home_dir="${HOME:-}"
    local user_codex=""
    local resolved_user_codex=""
    local active_cli_path=""
    local resolved_active_cli_path=""
    local standalone_root=""

    [ -n "$home_dir" ] || return 0
    user_codex="$home_dir/.local/bin/codex"
    [ -L "$user_codex" ] || return 0
    resolved_user_codex="$(readlink -f "$user_codex" 2>/dev/null || true)"
    [ -n "$resolved_user_codex" ] || return 0
    standalone_root="$(readlink -f "$codex_home/packages/standalone" 2>/dev/null || true)"
    [ -n "$standalone_root" ] || standalone_root="$codex_home/packages/standalone"

    case "$resolved_user_codex" in
        "$standalone_root"/*)
            active_cli_path="${CODEX_CLI_PATH:-}"
            if [ -n "$active_cli_path" ]; then
                resolved_active_cli_path="$(readlink -f "$active_cli_path" 2>/dev/null || true)"
                if [ "$active_cli_path" = "$user_codex" ] ||
                    { [ -n "$resolved_active_cli_path" ] && [ "$resolved_active_cli_path" = "$resolved_user_codex" ]; }; then
                    echo "Preserved active CODEX_CLI_PATH symlink: $user_codex -> $resolved_user_codex"
                    return 0
                fi
            fi
            if rm -f "$user_codex"; then
                echo "Removed remote mobile control standalone symlink from interactive PATH: $user_codex -> $resolved_user_codex"
            fi
            ;;
    esac
}

install_remote_mobile_control_runtime() {
    local codex_home="$1"
    local private_bin="$codex_home/packages/standalone/.bin"
    local system_path="/run/current-system/sw/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    local installer_path="$private_bin:$system_path"
    local setsid_path=""
    local fetch_cmd=""
    local installer_args=()

    mkdir -p "$private_bin"
    if [ -n "${CODEX_REMOTE_CONTROL_CODEX_RELEASE:-}" ]; then
        installer_args+=(--release "$CODEX_REMOTE_CONTROL_CODEX_RELEASE")
    fi

    if ! setsid_path="$(PATH="$system_path" command -v setsid 2>/dev/null)"; then
        echo "Remote mobile control runtime install requires setsid"
        return 1
    fi
    if fetch_cmd="$(PATH="$installer_path" command -v curl 2>/dev/null)"; then
        :
    elif fetch_cmd="$(PATH="$installer_path" command -v wget 2>/dev/null)"; then
        :
    else
        echo "Remote mobile control runtime install requires curl or wget on the system PATH"
        return 1
    fi
    if ! PATH="$installer_path" command -v tar >/dev/null 2>&1; then
        echo "Remote mobile control runtime install requires tar on the system PATH"
        return 1
    fi

    echo "Installing remote mobile control standalone runtime into $codex_home/packages/standalone"
    # CODEX_INSTALL_DIR points the official installer at a private bin dir under
    # CODEX_HOME. Running it through setsid and a system-only PATH prevents TTY
    # prompts, user-managed CLI conflict prompts, ~/.local/bin/codex writes, and
    # shell profile PATH blocks.
    if [ "${fetch_cmd##*/}" = "curl" ]; then
        ( set -o pipefail
          "$fetch_cmd" -fsSL https://chatgpt.com/codex/install.sh | \
              CODEX_HOME="$codex_home" CODEX_INSTALL_DIR="$private_bin" PATH="$installer_path" "$setsid_path" sh -s -- "${installer_args[@]}"
        )
    else
        ( set -o pipefail
          "$fetch_cmd" -q -O - https://chatgpt.com/codex/install.sh | \
              CODEX_HOME="$codex_home" CODEX_INSTALL_DIR="$private_bin" PATH="$installer_path" "$setsid_path" sh -s -- "${installer_args[@]}"
        )
    fi
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

    for pid_file in \
        "$codex_home/app-server-daemon/app-server.pid" \
        "$codex_home/app-server-daemon/app-server-updater.pid"
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

    if truthy_env_value "${CODEX_REMOTE_CONTROL_FORCE_COLD_START_DAEMON:-}"; then
        return 1
    fi

    [ -n "$app_dir" ] || return 1
    marker="$app_dir/.codex-linux/desktop-app-server-remote-control-enabled"
    [ -f "$marker" ]
}

remote_mobile_control_main() {
    local codex_home="${CODEX_HOME:-$HOME/.codex}"

    cleanup_remote_mobile_control_interactive_symlink "$codex_home"

    if truthy_env_value "${CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED:-}"; then
        echo "Remote mobile control daemon autostart disabled by CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED"
        return 0
    fi
    if command -v systemctl >/dev/null 2>&1 &&
        systemctl --user is-active --quiet codex-remote-control.service 2>/dev/null; then
        echo "Remote mobile control daemon autostart skipped; codex-remote-control.service is already active"
        return 0
    fi
    if desktop_app_server_remote_control_enabled; then
        cleanup_stale_remote_mobile_daemon_state "$codex_home"
        echo "Remote mobile control daemon autostart skipped; Desktop app-server launches with remote-control enabled"
        return 0
    fi

    local standalone_codex="${CODEX_REMOTE_CONTROL_CODEX_PATH:-$codex_home/packages/standalone/current/codex}"

    if [ ! -x "$standalone_codex" ]; then
        if [ -n "${CODEX_REMOTE_CONTROL_CODEX_PATH:-}" ]; then
            echo "Remote mobile control daemon runtime override is not executable: $CODEX_REMOTE_CONTROL_CODEX_PATH"
            return 0
        fi
        if truthy_env_value "${CODEX_REMOTE_CONTROL_RUNTIME_AUTO_INSTALL_DISABLED:-}"; then
            echo "Remote mobile control standalone runtime auto-install disabled by CODEX_REMOTE_CONTROL_RUNTIME_AUTO_INSTALL_DISABLED"
            return 0
        fi
        if ! install_remote_mobile_control_runtime "$codex_home"; then
            echo "Remote mobile control is enabled, but the standalone Codex daemon runtime could not be installed at $standalone_codex"
            echo "Brew or another CLI can remain the interactive Codex CLI; remote mobile control uses CODEX_REMOTE_CONTROL_CODEX_PATH separately."
            return 0
        fi
        if [ ! -x "$standalone_codex" ]; then
            echo "Remote mobile control standalone runtime installer completed but $standalone_codex is still missing"
            return 0
        fi
    fi

    if "$standalone_codex" remote-control start; then
        echo "Remote mobile control daemon is ready via $standalone_codex"
    else
        echo "Remote mobile control daemon start failed via $standalone_codex; Android remote hosts may remain disconnected."
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
