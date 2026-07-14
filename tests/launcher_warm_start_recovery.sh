#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
APP_DIR="$TMP_DIR/app"
HOME_DIR="$TMP_DIR/home"
RUNTIME_DIR="$TMP_DIR/runtime"
STATE_DIR="$HOME_DIR/.local/state/codex-desktop"
SOCKET_PATH="$RUNTIME_DIR/codex-desktop/launch-action.sock"
FIRST_LOG="$TMP_DIR/first-launch.log"
SECOND_LOG="$TMP_DIR/second-launch.log"
APP_LOG="$HOME_DIR/.cache/codex-desktop/launcher.log"
LAUNCHER_PID=""
SOCKET_PID=""
HOOK_PID=""

cleanup() {
    local pid
    if [ -f "$STATE_DIR/app.pid" ]; then
        pid="$(cat "$STATE_DIR/app.pid" 2>/dev/null || true)"
        [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
    fi
    [ -z "$LAUNCHER_PID" ] || kill "$LAUNCHER_PID" 2>/dev/null || true
    [ -z "$SOCKET_PID" ] || kill "$SOCKET_PID" 2>/dev/null || true
    [ -z "$HOOK_PID" ] || kill "$HOOK_PID" 2>/dev/null || true
    for cmdline in /proc/[0-9]*/cmdline; do
        [ -r "$cmdline" ] || continue
        pid="${cmdline#/proc/}"
        pid="${pid%/cmdline}"
        IFS= read -r -d '' arg0 < "$cmdline" 2>/dev/null || true
        if [ "${arg0:-}" = "$APP_DIR/electron" ]; then
            kill "$pid" 2>/dev/null || true
        fi
        arg0=""
    done
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
    printf 'launcher warm-start recovery test failed: %s\n' "$*" >&2
    printf '%s\n' '--- first launch ---' >&2
    sed -n '1,240p' "$FIRST_LOG" >&2 2>/dev/null || true
    printf '%s\n' '--- second launch ---' >&2
    sed -n '1,280p' "$SECOND_LOG" >&2 2>/dev/null || true
    printf '%s\n' '--- app launcher log ---' >&2
    sed -n '1,360p' "$APP_LOG" >&2 2>/dev/null || true
    exit 1
}

wait_for() {
    local description="$1"
    shift
    local attempt
    for attempt in $(seq 1 100); do
        "$@" && return 0
        sleep 0.05
    done
    fail "timed out waiting for $description"
}

read_live_app_pid() {
    local pid
    pid="$(cat "$STATE_DIR/app.pid" 2>/dev/null || true)"
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
    printf '%s\n' "$pid"
}

pid_file_is_live() {
    read_live_app_pid >/dev/null
}

webview_is_ready() {
    curl --disable --noproxy 127.0.0.1,localhost --silent --fail --max-time 0.2 \
        "http://127.0.0.1:$PORT/index.html" | grep -q 'startup-loader'
}

webview_is_down() {
    ! curl --disable --noproxy 127.0.0.1,localhost --silent --fail --max-time 0.2 \
        "http://127.0.0.1:$PORT/index.html" >/dev/null 2>&1
}

mkdir -p \
    "$APP_DIR/.codex-linux/cold-start.d" \
    "$APP_DIR/.codex-linux/env.d" \
    "$APP_DIR/.codex-linux/features" \
    "$APP_DIR/.codex-linux/prelaunch.d" \
    "$APP_DIR/.codex-linux/electron-args.d" \
    "$APP_DIR/.codex-linux/launcher.d" \
    "$APP_DIR/.codex-linux/after-exit.d" \
    "$APP_DIR/content/webview" \
    "$APP_DIR/resources/node-runtime/bin" \
    "$HOME_DIR/.config/codex-desktop" \
    "$HOME_DIR" \
    "$RUNTIME_DIR/codex-desktop"

if [ "${CODEX_TEST_DISABLE_WARM_START:-0}" = "1" ]; then
    printf '%s\n' '{"codex-linux-warm-start-enabled":false}' \
        > "$HOME_DIR/.config/codex-desktop/settings.json"
fi

PORT="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"

{
    printf '%s\n' \
        '#!/usr/bin/env bash' \
        'set -Eeuo pipefail' \
        'CODEX_LINUX_APP_ID=codex-desktop' \
        'CODEX_LINUX_APP_DISPLAY_NAME="ChatGPT Desktop"' \
        'CODEX_LINUX_WEBVIEW_PORT="${CODEX_WEBVIEW_PORT:-5175}"'
    cat "$REPO_DIR/launcher/start.sh.template"
} > "$APP_DIR/start.sh"
chmod +x "$APP_DIR/start.sh"
cp "$REPO_DIR/launcher/webview-server.py" "$APP_DIR/.codex-linux/webview-server.py"
cp "$REPO_DIR/launcher/cli-launch-path.py" "$APP_DIR/.codex-linux/cli-launch-path.py"
ln -s "$(command -v node)" "$APP_DIR/resources/node-runtime/bin/node"
printf '%s\n' '<!doctype html><title>Codex</title><div id="startup-loader"></div>' \
    > "$APP_DIR/content/webview/index.html"

g++ -x c++ -O2 -o "$APP_DIR/electron" - <<'CPP'
#include <csignal>
#include <unistd.h>

static volatile sig_atomic_t running = 1;
static void stop(int) { running = 0; }

int main() {
    std::signal(SIGTERM, stop);
    std::signal(SIGINT, stop);
    while (running) pause();
    return 0;
}
CPP

if [ "${CODEX_TEST_KILL_DURING_PRELAUNCH:-0}" = "1" ]; then
    cat > "$APP_DIR/.codex-linux/prelaunch.d/blocking-test-hook" <<'HOOK'
#!/usr/bin/env bash
printf '%s\n' "$$" > "$CODEX_TEST_HOOK_PID_FILE"
exec sleep 30
HOOK
    chmod +x "$APP_DIR/.codex-linux/prelaunch.d/blocking-test-hook"
fi

python3 - "$SOCKET_PATH" <<'PY' &
import os
import socket
import sys

path = sys.argv[1]
os.makedirs(os.path.dirname(path), exist_ok=True)
try:
    os.unlink(path)
except FileNotFoundError:
    pass
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
    server.bind(path)
    server.listen()
    while True:
        client, _ = server.accept()
        with client:
            client.recv(65536)
            client.sendall(b"ok\n")
PY
SOCKET_PID=$!
wait_for "launch-action socket" test -S "$SOCKET_PATH"

COMMON_ENV=(
    env -i
    "PATH=$PATH"
    "HOME=$HOME_DIR"
    "XDG_RUNTIME_DIR=$RUNTIME_DIR"
    "CODEX_CLI_PATH=$(command -v true)"
    "CODEX_WEBVIEW_PORT=$PORT"
    "CODEX_TEST_HOOK_PID_FILE=$TMP_DIR/hook.pid"
)

"${COMMON_ENV[@]}" "$APP_DIR/start.sh" > "$FIRST_LOG" 2>&1 &
LAUNCHER_PID=$!

if [ "${CODEX_TEST_KILL_DURING_PRELAUNCH:-0}" = "1" ]; then
    wait_for "blocking prelaunch hook" test -s "$TMP_DIR/hook.pid"
    HOOK_PID="$(cat "$TMP_DIR/hook.pid")"
    kill -KILL "$LAUNCHER_PID"
    wait "$LAUNCHER_PID" 2>/dev/null || true
    LAUNCHER_PID=""
    rm -f "$APP_DIR/.codex-linux/prelaunch.d/blocking-test-hook"

    SECONDS=0
    "${COMMON_ENV[@]}" "$APP_DIR/start.sh" > "$SECOND_LOG" 2>&1 &
    LAUNCHER_PID=$!
    replacement_is_ready() {
        pid_file_is_live && webview_is_ready
    }
    wait_for "replacement launch after parent-death lock release" replacement_is_ready
    [ "$SECONDS" -lt 5 ] || fail "replacement launcher waited for the stale lock timeout"

    SECOND_ELECTRON_PID="$(read_live_app_pid)"
    kill "$SECOND_ELECTRON_PID"
    wait "$LAUNCHER_PID"
    LAUNCHER_PID=""
    kill "$HOOK_PID" 2>/dev/null || true
    HOOK_PID=""
    printf '%s\n' "launcher parent-death lock release test passed"
    exit 0
fi

wait_for "first Electron" pid_file_is_live
wait_for "first packaged webview" webview_is_ready
FIRST_ELECTRON_PID="$(read_live_app_pid)"

kill -KILL "$LAUNCHER_PID"
wait "$LAUNCHER_PID" 2>/dev/null || true
LAUNCHER_PID=""
wait_for "webview parent-death cleanup" webview_is_down
kill -0 "$FIRST_ELECTRON_PID" 2>/dev/null \
    || fail "Electron should survive the launcher SIGKILL"

"${COMMON_ENV[@]}" "$APP_DIR/start.sh" > "$SECOND_LOG" 2>&1 &
LAUNCHER_PID=$!

new_electron_is_ready() {
    local pid
    pid="$(read_live_app_pid)" || return 1
    [ "$pid" != "$FIRST_ELECTRON_PID" ] || return 1
    webview_is_ready
}
wait_for "cold-start recovery" new_electron_is_ready

if kill -0 "$FIRST_ELECTRON_PID" 2>/dev/null; then
    fail "identity-verified stale Electron was not terminated"
fi
grep -q "Stopped identity-verified stale Electron pid=$FIRST_ELECTRON_PID" "$APP_LOG" \
    || fail "launcher did not report stale Electron recovery"

SECOND_ELECTRON_PID="$(read_live_app_pid)"
kill "$SECOND_ELECTRON_PID"
wait "$LAUNCHER_PID"
LAUNCHER_PID=""

printf '%s\n' "launcher recovery test passed (warm-start disabled=${CODEX_TEST_DISABLE_WARM_START:-0})"
