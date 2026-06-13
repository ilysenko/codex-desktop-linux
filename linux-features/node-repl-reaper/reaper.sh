#!/bin/bash
# Reap Browser Use node_repl helper processes leaked by the upstream codex
# app-server. A helper counts as leaked when its parent is no longer a live
# codex app-server process — its owner exited without cleaning it up. Helpers
# whose app-server parent is alive are never touched, so active Browser Use
# sessions are unaffected. Matching is scoped to this install's node_repl
# binary path, so side-by-side installs reap independently.
#
# Usage: node-repl-reaper.sh <app-dir> [once|watch]
#   once   (default) one reap pass
#   watch  reap every CODEX_NODE_REPL_REAPER_INTERVAL seconds (default 300)
#          after the first electron from <app-dir> appears, then exit with a
#          final pass once no matching electron remains
set -u

APP_DIR="${1:?usage: node-repl-reaper.sh <app-dir> [once|watch]}"
MODE="${2:-once}"
NODE_REPL_BIN="$APP_DIR/resources/node_repl"
WATCH_INTERVAL_SECONDS="${CODEX_NODE_REPL_REAPER_INTERVAL:-300}"
STARTUP_GRACE_SECONDS="${CODEX_NODE_REPL_REAPER_STARTUP_GRACE:-120}"
KILL_GRACE_SECONDS="${CODEX_NODE_REPL_REAPER_KILL_GRACE:-5}"

# True when the process's argv[0] is exactly <bin>. Chromium/Electron
# processes rewrite their argv area, leaving /proc/<pid>/cmdline space-joined
# instead of NUL-separated, so the first NUL field can be the entire command
# line — accept "<bin>" and "<bin> <args...>" alike.
proc_cmdline_starts_with() {
    local pid="$1" bin="$2" cmdline=""
    IFS= read -r -d '' cmdline < "/proc/$pid/cmdline" 2>/dev/null || true
    case "$cmdline" in
        "$bin"|"$bin "*) return 0 ;;
    esac
    return 1
}

proc_ppid() {
    # /proc/<pid>/stat: "<pid> (comm) <state> <ppid> ..." — comm can contain
    # spaces/parens, so strip up to the last ") " before splitting fields.
    local stat_line rest
    stat_line="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
    rest="${stat_line##*) }"
    # shellcheck disable=SC2086
    set -- $rest
    [ -n "${2:-}" ] || return 1
    printf '%s' "$2"
}

parent_is_live_app_server() {
    local ppid="$1"
    [ -n "$ppid" ] && [ -d "/proc/$ppid" ] || return 1
    local args
    args="$(tr '\0' ' ' < "/proc/$ppid/cmdline" 2>/dev/null)" || return 1
    case "$args" in
        *codex*app-server*) return 0 ;;
    esac
    return 1
}

leaked_node_repl_pids() {
    local proc pid ppid
    for proc in /proc/[0-9]*/cmdline; do
        [ -e "$proc" ] || continue
        pid="${proc#/proc/}"
        pid="${pid%/cmdline}"
        proc_cmdline_starts_with "$pid" "$NODE_REPL_BIN" || continue
        ppid="$(proc_ppid "$pid")" || continue
        parent_is_live_app_server "$ppid" && continue
        printf '%s\n' "$pid"
    done
}

reap_leaked_node_repls() {
    local pid termed=""
    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        echo "node-repl-reaper: reaping leaked node_repl pid=$pid"
        kill "$pid" 2>/dev/null || continue
        termed="$termed $pid"
    done < <(leaked_node_repl_pids)

    [ -n "$termed" ] || return 0
    sleep "$KILL_GRACE_SECONDS"
    for pid in $termed; do
        # Re-check identity before SIGKILL in case the pid was recycled.
        proc_cmdline_starts_with "$pid" "$NODE_REPL_BIN" || continue
        echo "node-repl-reaper: escalating to SIGKILL for node_repl pid=$pid"
        kill -9 "$pid" 2>/dev/null || true
    done
}

install_app_is_running() {
    local proc pid
    for proc in /proc/[0-9]*/cmdline; do
        [ -e "$proc" ] || continue
        pid="${proc#/proc/}"
        pid="${pid%/cmdline}"
        if proc_cmdline_starts_with "$pid" "$APP_DIR/electron"; then
            return 0
        fi
    done
    return 1
}

wait_for_initial_electron() {
    local waited=0
    while ! install_app_is_running; do
        if [ "$waited" -ge "$STARTUP_GRACE_SECONDS" ]; then
            echo "node-repl-reaper: no $APP_DIR/electron appeared within ${STARTUP_GRACE_SECONDS}s; final pass and exit"
            return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    return 0
}

if [ "$MODE" = "watch" ]; then
    if ! wait_for_initial_electron; then
        reap_leaked_node_repls
        exit 0
    fi

    while :; do
        reap_leaked_node_repls
        if ! install_app_is_running; then
            echo "node-repl-reaper: no $APP_DIR/electron running; final pass and exit"
            reap_leaked_node_repls
            exit 0
        fi
        sleep "$WATCH_INTERVAL_SECONDS"
    done
fi

reap_leaked_node_repls
