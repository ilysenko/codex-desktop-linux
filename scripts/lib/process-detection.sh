#!/bin/bash
# Install-time detection of an already-running ChatGPT Community instance.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

canonical_path() {
    realpath -m "$1"
}

pid_is_current_user() {
    local pid="$1"
    local uid

    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    [ -d "/proc/$pid" ] || return 1
    uid="$(awk '/^Uid:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)"
    [ "$uid" = "$(id -u)" ]
}

# Electron helper processes (renderer, gpu-process, utility, zygote, ...)
# all carry their role as a `--type=...` argv entry. Only the main app
# process omits it, so we use this to skip orphaned helpers that survive
# their parent and re-attach to systemd.
cmdline_has_electron_helper_type() {
    local cmdline_path="$1"
    [ -r "$cmdline_path" ] || return 1
    tr '\000' '\n' < "$cmdline_path" 2>/dev/null | grep -q '^--type=' && return 0
    LC_ALL=C grep -a -q -- ' --type=' "$cmdline_path" 2>/dev/null
}

pid_is_electron_helper() {
    local pid="$1"
    cmdline_has_electron_helper_type "/proc/$pid/cmdline"
}

pid_matches_install_target() {
    local pid="$1"
    local expected="$2"
    local actual

    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    [ -d "/proc/$pid" ] || return 1
    pid_is_current_user "$pid" || return 1
    actual="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
    [ -n "$actual" ] || return 1
    [ "$actual" = "$(canonical_path "$expected")" ] || return 1
    ! pid_is_electron_helper "$pid"
}

find_running_install_target_pid() {
    local electron_path="$INSTALL_DIR/ChatGPT"
    local pid
    local proc_exe

    [ -e "$electron_path" ] || return 1

    for proc_exe in /proc/[0-9]*/exe; do
        [ -e "$proc_exe" ] || continue
        pid="${proc_exe#/proc/}"
        pid="${pid%/exe}"
        if pid_matches_install_target "$pid" "$electron_path"; then
            echo "$pid"
            return 0
        fi
    done

    return 1
}

assert_install_target_not_running() {
    if ! install_target_is_stopped; then
        error "ChatGPT Community is currently running from $INSTALL_DIR (pid $RUNNING_INSTALL_TARGET_PID).
Close that app before rebuilding this install directory, or build into a
separate path with disk-backed temporary files.
  mkdir -p \"\${XDG_CACHE_HOME:-\$HOME/.cache}/codex-desktop-dev/tmp\"
  TMPDIR=\"\${XDG_CACHE_HOME:-\$HOME/.cache}/codex-desktop-dev/tmp\" \\
    CODEX_INSTALL_DIR=\"\${XDG_CACHE_HOME:-\$HOME/.cache}/codex-desktop-dev/codex-app-build\" ./install.sh

Set CODEX_INSTALL_ALLOW_RUNNING=1 only if you intentionally want to overwrite a running app."
    fi
}

install_target_is_stopped() {
    local pid
    RUNNING_INSTALL_TARGET_PID=""

    if [ "${CODEX_INSTALL_ALLOW_RUNNING:-0}" = "1" ]; then
        warn "CODEX_INSTALL_ALLOW_RUNNING=1 set; installer may overwrite a running ChatGPT app"
        return 0
    fi

    if pid="$(find_running_install_target_pid)"; then
        RUNNING_INSTALL_TARGET_PID="$pid"
        export RUNNING_INSTALL_TARGET_PID
        return 1
    fi

    return 0
}
