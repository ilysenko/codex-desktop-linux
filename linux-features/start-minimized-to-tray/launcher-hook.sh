#!/usr/bin/env bash
set -Eeuo pipefail

codex_start_minimized_login_hook() {
    local cgroup_file="$1"
    shift
    local arg hierarchy _controllers group

    # The explicit fallback is already forwarded by the launcher.
    for arg in "$@"; do
        if [ "$arg" = --codex-autostart ]; then
            return 0
        fi
    done

    if [[ "${DESKTOP_AUTOSTART_ID:-}" =~ [^[:space:]] ]]; then
        printf 'electron-arg --codex-autostart\n'
        return 0
    fi

    # Capture the launcher's service before Electron/Chromium moves the app
    # into its own systemd scope. Arguments survive that move without leaking
    # a login marker into the environment of terminals or child applications.
    if [ -r "$cgroup_file" ]; then
        while IFS=: read -r hierarchy _controllers group || [ -n "${group:-}" ]; do
            if [[ "$hierarchy" =~ ^[0-9]+$ && "$group" =~ /app-[^/]+@autostart\.service(/|$) ]]; then
                printf 'electron-arg --codex-autostart\n'
                return 0
            fi
        done 2>/dev/null < "$cgroup_file" || return 0
    fi
    return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    codex_start_minimized_login_hook "/proc/${CODEX_LINUX_LAUNCHER_PID:-self}/cgroup" "$@"
fi
