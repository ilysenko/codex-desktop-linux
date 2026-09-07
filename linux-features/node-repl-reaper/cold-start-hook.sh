#!/bin/bash
# Launcher cold-start hook: start one reaper watchdog per install. The
# watchdog self-terminates after the last ChatGPT process from this install exits,
# so a stale pid file is the only restart blocker — clear it when the
# recorded pid is dead or no longer the reaper.
set -euo pipefail

app_dir="${CODEX_LINUX_APP_DIR:?cold-start hook requires CODEX_LINUX_APP_DIR}"
state_dir="${CODEX_LINUX_APP_STATE_DIR:?cold-start hook requires CODEX_LINUX_APP_STATE_DIR}"
pid_file="$state_dir/node-repl-reaper.pid"
reaper="$app_dir/.codex-linux/node-repl-reaper.sh"

[ -x "$reaper" ] || exit 0
mkdir -p "$state_dir"

if [ -f "$pid_file" ]; then
    existing="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$existing" ] && [ -d "/proc/$existing" ]; then
        existing_cmdline="$(tr '\0' ' ' < "/proc/$existing/cmdline" 2>/dev/null || true)"
        case "$existing_cmdline" in
            *node-repl-reaper*) exit 0 ;;
        esac
    fi
    rm -f "$pid_file"
fi

"$reaper" "$app_dir" watch &
echo $! > "$pid_file"
