#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MUTATION_DETECTED_EXIT=86
PIDFD_UNAVAILABLE_EXIT=77

pidfd_cleanup_probe() {
    [ "${CODEX_TEST_FORCE_NO_PIDFD:-0}" != "1" ] || return "$PIDFD_UNAVAILABLE_EXIT"
    python3 - <<'PY'
import errno
import os
import signal
import sys

if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
    raise SystemExit(77)

try:
    pidfd = os.pidfd_open(os.getpid(), 0)
except OSError as error:
    if error.errno in {errno.EACCES, errno.EINVAL, errno.ENOSYS, errno.EPERM}:
        raise SystemExit(77)
    print(f"pidfd capability probe failed: {error}", file=sys.stderr)
    raise SystemExit(1)

try:
    signal.pidfd_send_signal(pidfd, 0, None, 0)
except OSError as error:
    if error.errno in {errno.EACCES, errno.EINVAL, errno.ENOSYS, errno.EPERM}:
        raise SystemExit(77)
    print(f"pidfd signal probe failed: {error}", file=sys.stderr)
    raise SystemExit(1)
finally:
    os.close(pidfd)
PY
}

set +e
pidfd_cleanup_probe
pidfd_probe_status=$?
set -e
if [ "$pidfd_probe_status" -eq "$PIDFD_UNAVAILABLE_EXIT" ]; then
    printf '%s\n' '{"outcome":"skipped","reason":"pidfd-cleanup-unavailable"}'
    printf '%s\n' 'launcher window-reopen behavior test skipped: pidfd cleanup unavailable'
    exit "$PIDFD_UNAVAILABLE_EXIT"
fi
if [ "$pidfd_probe_status" -ne 0 ]; then
    printf '%s\n' 'launcher window-reopen behavior test failed: pidfd capability probe failed' >&2
    exit 1
fi

TMP_DIR="$(mktemp -d)"
APP_DIR="$TMP_DIR/app"
HOME_DIR="$TMP_DIR/home"
RUNTIME_DIR="$TMP_DIR/runtime"
STATE_DIR="$HOME_DIR/.local/state/codex-desktop"
SOCKET_PATH="$RUNTIME_DIR/codex-desktop/launch-action.sock"
HANDOFF_RESULT="$TMP_DIR/handoff.json"
FIRST_LOG="$TMP_DIR/first-launch.log"
SECOND_LOG="$TMP_DIR/second-launch.log"
APP_LOG="$HOME_DIR/.cache/codex-desktop/launcher.log"
LAUNCHER_PID=""
SECOND_LAUNCHER_PID=""
SOCKET_PID=""
DECOY_PID=""
FIRST_ELECTRON_PID=""
FINAL_ELECTRON_PID=""
HANDOFF_STATUS="not-attempted"
TIMEOUT_STATUS="false"
ERROR_STATUS="false"

count_test_main_processes() {
    local count=0
    local cmdline
    local pid

    for cmdline in /proc/[0-9]*/cmdline; do
        [ -r "$cmdline" ] || continue
        pid="${cmdline#/proc/}"
        pid="${pid%/cmdline}"
        IFS= read -r -d '' arg0 < "$cmdline" 2>/dev/null || true
        if [ "${arg0:-}" = "$APP_DIR/electron" ]; then
            count=$((count + 1))
        fi
        arg0=""
    done
    printf '%s\n' "$count"
}

record_result() {
    local outcome="$1"
    local main_process_count
    local marker_pid=""

    marker_pid="$(cat "$STATE_DIR/app.pid" 2>/dev/null || true)"
    main_process_count="$(count_test_main_processes)"

    printf '{"outcome":"%s","initialPid":"%s","finalPid":"%s","mainProcessCount":%s,"handoff":"%s","markerPid":"%s","webviewMarkerPresent":%s,"socketPresent":%s,"timedOut":%s,"userVisibleError":%s}\n' \
        "$outcome" \
        "$FIRST_ELECTRON_PID" \
        "$FINAL_ELECTRON_PID" \
        "$main_process_count" \
        "$HANDOFF_STATUS" \
        "$marker_pid" \
        "$([ -s "$STATE_DIR/webview.pid" ] && printf true || printf false)" \
        "$([ -S "$SOCKET_PATH" ] && printf true || printf false)" \
        "$TIMEOUT_STATUS" \
        "$ERROR_STATUS"
}

stop_owned_process_bounded() {
    local pid="$1"
    local match_mode="$2"
    local expected="$3"

    [[ "$pid" =~ ^[0-9]+$ ]] || return 0
    python3 - "$pid" "$match_mode" "$expected" <<'PY'
import os
import select
import signal
import sys

pid = int(sys.argv[1])
match_mode = sys.argv[2]
expected = sys.argv[3]

try:
    pidfd = os.pidfd_open(pid, 0)
except ProcessLookupError:
    raise SystemExit(0)
except OSError as error:
    print(f"failed to open pidfd for {pid}: {error}", file=sys.stderr)
    raise SystemExit(1)

try:
    try:
        raw_cmdline = open(f"/proc/{pid}/cmdline", "rb").read()
    except FileNotFoundError:
        raise SystemExit(0)
    except OSError as error:
        print(f"failed to read process identity for {pid}: {error}", file=sys.stderr)
        raise SystemExit(1)
    argv = [part.decode(errors="surrogateescape") for part in raw_cmdline.split(b"\0") if part]
    matches = bool(argv) and (
        (match_mode == "arg0" and argv[0] == expected)
        or (match_mode == "argv" and expected in argv)
    )
    if not matches:
        raise SystemExit(0)

    try:
        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
    except ProcessLookupError:
        raise SystemExit(0)
    poller = select.poll()
    poller.register(pidfd, select.POLLIN)
    if not poller.poll(1000):
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
        except ProcessLookupError:
            raise SystemExit(0)
        if not poller.poll(1000):
            print(f"process {pid} did not exit after bounded TERM/KILL", file=sys.stderr)
            raise SystemExit(1)
finally:
    os.close(pidfd)
PY
}

cleanup() {
    local original_status=$?
    local cleanup_failed=0
    local cmdline
    local pid
    local webview_pid

    trap - EXIT
    set +e
    webview_pid="$(cat "$STATE_DIR/webview.pid" 2>/dev/null || true)"
    stop_owned_process_bounded "$LAUNCHER_PID" argv "$APP_DIR/start.sh" || cleanup_failed=1
    stop_owned_process_bounded "$SECOND_LAUNCHER_PID" argv "$APP_DIR/start.sh" || cleanup_failed=1
    stop_owned_process_bounded "$SOCKET_PID" argv "$SOCKET_PATH" || cleanup_failed=1
    stop_owned_process_bounded "$webview_pid" argv "$APP_DIR/.codex-linux/webview-server.py" || cleanup_failed=1
    stop_owned_process_bounded "$DECOY_PID" arg0 "$TMP_DIR/decoy-electron" || cleanup_failed=1
    for cmdline in /proc/[0-9]*/cmdline; do
        [ -r "$cmdline" ] || continue
        pid="${cmdline#/proc/}"
        pid="${pid%/cmdline}"
        IFS= read -r -d '' arg0 < "$cmdline" 2>/dev/null || true
        if [ "${arg0:-}" = "$APP_DIR/electron" ]; then
            IFS= read -r -d '' revalidated_arg0 < "$cmdline" 2>/dev/null || true
            if [ "${revalidated_arg0:-}" = "$APP_DIR/electron" ]; then
                stop_owned_process_bounded "$pid" arg0 "$APP_DIR/electron" || cleanup_failed=1
            fi
        fi
        arg0=""
        revalidated_arg0=""
    done
    rm -rf "$TMP_DIR" || cleanup_failed=1
    if [ "$cleanup_failed" -ne 0 ]; then
        printf '%s\n' 'launcher window-reopen behavior cleanup failed' >&2
        exit 1
    fi
    exit "$original_status"
}
trap cleanup EXIT

fail() {
    local message="$*"
    if grep -Eqi 'notify-send|zenity|could not safely|failed to' "$SECOND_LOG" "$APP_LOG" 2>/dev/null; then
        ERROR_STATUS="true"
    fi
    printf 'launcher window-reopen behavior test failed: %s\n' "$message" >&2
    record_result "failed" >&2
    printf '%s\n' '--- first launch ---' >&2
    sed -n '1,200p' "$FIRST_LOG" >&2 2>/dev/null || true
    printf '%s\n' '--- second launch ---' >&2
    sed -n '1,240p' "$SECOND_LOG" >&2 2>/dev/null || true
    printf '%s\n' '--- app launcher log ---' >&2
    sed -n '1,300p' "$APP_LOG" >&2 2>/dev/null || true
    exit 1
}

mutation_detected() {
    FINAL_ELECTRON_PID="$(read_live_app_pid 2>/dev/null || true)"
    printf '%s\n' 'launcher window-reopen behavior mutation detected: healthy resident replacement' >&2
    record_result "resident-replacement-detected" >&2
    exit "$MUTATION_DETECTED_EXIT"
}

wait_for() {
    local description="$1"
    shift
    local attempt

    for attempt in $(seq 1 100); do
        "$@" && return 0
        sleep 0.05
    done
    TIMEOUT_STATUS="true"
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

handoff_was_recorded() {
    [ -s "$HANDOFF_RESULT" ]
}

launcher_lock_is_available() {
    flock -n "$STATE_DIR/launcher.lock" true
}

resident_policy_regressed() {
    local marker_pid

    marker_pid="$(read_live_app_pid 2>/dev/null || true)"
    if [ -n "$marker_pid" ] && [ "$marker_pid" != "$FIRST_ELECTRON_PID" ]; then
        return 0
    fi
    [ "$(count_test_main_processes)" -ne 1 ]
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
    "$RUNTIME_DIR/codex-desktop"

printf '%s\n' '{"codex-linux-warm-start-enabled":true}' \
    > "$HOME_DIR/.config/codex-desktop/settings.json"
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
if [ "${CODEX_TEST_FORCE_RESIDENT_REPLACEMENT:-0}" = "1" ] \
    && [ "${CODEX_TEST_MUTATION_CONTROL_ONLY:-0}" != "1" ]; then
    python3 - "$APP_DIR/start.sh" <<'PY'
import sys

path = sys.argv[1]
source = open(path, encoding="utf-8").read()
needle = "\nprepare_launch_state_under_lock\n"
mutation = r'''
prepare_launch_state_under_lock
if running_app_is_active; then
    controlled_resident_pid="$RUNNING_APP_PID"
    kill "$controlled_resident_pid"
    for _ in $(seq 1 100); do
        kill -0 "$controlled_resident_pid" 2>/dev/null || break
        sleep 0.05
    done
    rm -f "$APP_PID_FILE" "$LAUNCH_ACTION_SOCKET"
    refresh_launch_state_quick
fi
'''
if source.count(needle) != 1:
    raise SystemExit("unable to install controlled resident-replacement mutation")
open(path, "w", encoding="utf-8").write(source.replace(needle, "\n" + mutation, 1))
PY
fi
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
cp "$APP_DIR/electron" "$TMP_DIR/decoy-electron"
"$TMP_DIR/decoy-electron" --app-id=codex-desktop &
DECOY_PID=$!

COMMON_ENV=(
    env -i
    "PATH=$PATH"
    "HOME=$HOME_DIR"
    "XDG_RUNTIME_DIR=$RUNTIME_DIR"
    "CODEX_CLI_PATH=$(command -v true)"
    "CODEX_WEBVIEW_PORT=$PORT"
)

"${COMMON_ENV[@]}" "$APP_DIR/start.sh" > "$FIRST_LOG" 2>&1 &
LAUNCHER_PID=$!
wait_for "first Electron marker" pid_file_is_live
wait_for "first launcher lock release" launcher_lock_is_available
FIRST_ELECTRON_PID="$(read_live_app_pid)"

python3 - "$SOCKET_PATH" "$HANDOFF_RESULT" <<'PY' &
import json
import os
import socket
import sys

socket_path, result_path = sys.argv[1:]
os.makedirs(os.path.dirname(socket_path), exist_ok=True)
try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
    server.bind(socket_path)
    server.listen()
    server.settimeout(10)
    client, _ = server.accept()
    with client:
        client.settimeout(2)
        payload = client.recv(65536)
        request = json.loads(payload.decode("utf-8").strip())
        with open(result_path, "w", encoding="utf-8") as result:
            json.dump({"argv": request.get("argv", []), "status": "acknowledged"}, result)
        client.sendall(b"ok\n")
PY
SOCKET_PID=$!
wait_for "controlled handoff socket" test -S "$SOCKET_PATH"

if [ "${CODEX_TEST_FORCE_RESIDENT_REPLACEMENT:-0}" = "1" ]; then
    "${COMMON_ENV[@]}" "$APP_DIR/start.sh" --new-chat > "$SECOND_LOG" 2>&1 &
    SECOND_LAUNCHER_PID=$!
    if [ "${CODEX_TEST_MUTATION_CONTROL_ONLY:-0}" = "1" ]; then
        set +e
        wait "$SECOND_LAUNCHER_PID"
        rc=$?
        set -e
        SECOND_LAUNCHER_PID=""
        [ "$rc" -eq 0 ] \
            || fail "mutation control launcher invocation failed (status $rc)"
        wait_for "mutation control handoff acknowledgement" handoff_was_recorded
        HANDOFF_STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$HANDOFF_RESULT")"
        FINAL_ELECTRON_PID="$(read_live_app_pid)"
        [ "$FINAL_ELECTRON_PID" = "$FIRST_ELECTRON_PID" ] \
            || fail "mutation control changed the healthy resident PID"
        [ "$(count_test_main_processes)" -eq 1 ] \
            || fail "mutation control did not preserve exactly one controlled Electron process"
        [ "$HANDOFF_STATUS" = "acknowledged" ] \
            || fail "mutation control handoff was not acknowledged"
        record_result "mutation-control-preserved"
        printf '%s\n' 'launcher window-reopen behavior mutation control passed'
        exit 0
    fi
    wait_for "unconditional resident replacement regression" resident_policy_regressed
    mutation_detected
fi

set +e
timeout 8s "${COMMON_ENV[@]}" "$APP_DIR/start.sh" --new-chat > "$SECOND_LOG" 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ]; then
        TIMEOUT_STATUS="true"
    fi
    fail "second launcher invocation did not complete successfully (status $rc)"
fi

wait_for "reopen handoff acknowledgement" handoff_was_recorded
HANDOFF_STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$HANDOFF_RESULT")"
FINAL_ELECTRON_PID="$(read_live_app_pid)"

[ "$FINAL_ELECTRON_PID" = "$FIRST_ELECTRON_PID" ] \
    || fail "healthy resident PID changed from $FIRST_ELECTRON_PID to $FINAL_ELECTRON_PID"
kill -0 "$FIRST_ELECTRON_PID" 2>/dev/null \
    || fail "healthy resident Electron did not survive reopen handoff"
[ "$(cat "$STATE_DIR/app.pid")" = "$FIRST_ELECTRON_PID" ] \
    || fail "runtime marker no longer identifies the healthy resident"
[ "$HANDOFF_STATUS" = "acknowledged" ] \
    || fail "controlled resident did not acknowledge the reopen handoff"
python3 - "$HANDOFF_RESULT" <<'PY' \
    || fail "reopen handoff did not preserve the --new-chat argument"
import json
import sys

with open(sys.argv[1], encoding="utf-8") as result:
    assert json.load(result)["argv"] == ["--new-chat"]
PY
[ "$(count_test_main_processes)" -eq 1 ] \
    || fail "reopen handoff left more than one controlled Electron process"
[ -s "$STATE_DIR/webview.pid" ] \
    || fail "webview runtime marker disappeared during reopen handoff"
kill -0 "$DECOY_PID" 2>/dev/null \
    || fail "launcher signalled a decoy process outside the isolated app identity"
if grep -Eqi 'notify-send|zenity|could not safely|failed to' "$SECOND_LOG" "$APP_LOG" 2>/dev/null; then
    ERROR_STATUS="true"
    fail "reopen handoff emitted a user-visible error"
fi

record_result "preserved"
printf '%s\n' "launcher window-reopen behavior test passed"
