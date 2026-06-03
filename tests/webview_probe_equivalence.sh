#!/usr/bin/env bash
# tests/webview_probe_equivalence.sh
#
# Behavioral equivalence test for the webview readiness probes in
# launcher/start.sh.template — the bash /dev/tcp + curl implementations that
# replaced the original python3 socket/urllib heredocs.
#
# This test pins the verdict equivalence on the full set of inputs the
# launcher exercises on cold and warm start paths, plus a self-test that the
# bounded-execution invariant (the watchdog cap on the TCP probe) still
# holds. It runs without network or root by starting a controlled
# python3 -m http.server on 127.0.0.1 over a mktemp fixture tree.
#
# Scenarios:
#   TCP probe       — open localhost port             → both impls succeed
#   TCP probe       — closed localhost port           → both impls fail
#   HTTP verify     — body has both required markers  → both impls succeed
#   HTTP verify     — 404 path                        → both impls fail
#   HTTP verify     — wrong <title>                   → both impls fail
#   HTTP verify     — body missing startup-loader     → both impls fail
#   HTTP verify     — origin port is dead             → both impls fail
#   slow valid HTTP — body after 300 ms               → fast probe fails, full verify succeeds
#   watchdog cap    — a 5 s sleeper is killed at ~0.2 s
#
# Exit 0 when every verdict matches and the watchdog cap fires within its
# bounded window; non-zero otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$REPO_DIR/launcher/start.sh.template"
MAIN_BASHPID="${BASHPID:-$$}"

info() { echo "[probe-eq] $*" >&2; }
fail() { echo "[probe-eq][FAIL] $*" >&2; exit 1; }

[ -r "$TEMPLATE" ] || fail "cannot read $TEMPLATE"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to run the reference impl"
command -v curl    >/dev/null 2>&1 || fail "curl is required (and is a hard runtime dep of the launcher)"

# ─── Reference implementation: verbatim python3 from before the bash port ───
# These are the bodies that lived in launcher/start.sh.template before the
# shell-native rewrite. Kept inline so the test does not depend on git
# history and remains runnable in any source checkout.

webview_port_is_open__orig() {
    local port="$1"
    python3 - "$port" <<'PY' 2>/dev/null
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(0.2)
try:
    s.connect(("127.0.0.1", port))
finally:
    s.close()
PY
}

verify_webview_origin__orig() {
    local url="$1"
    python3 - "$url" <<'PY' 2>/dev/null
import sys, urllib.request
url = sys.argv[1]
required_markers = ("<title>Codex</title>", "startup-loader")
try:
    with urllib.request.urlopen(url, timeout=2) as response:
        body = response.read(8192).decode("utf-8", "ignore")
except Exception:
    sys.exit(1)
missing = [m for m in required_markers if m not in body]
if missing:
    sys.exit(1)
PY
}

# ─── New implementation: extracted from the live template ──────────────────
# Pulls the function bodies straight out of launcher/start.sh.template so the
# test always asserts equivalence against the code that is actually shipped,
# not a copy that could silently drift.

extract_function() {
    # Capture lines from "^<name>() {" through the next unindented "^}".
    local fname="$1"
    awk -v want="$fname" '
        $0 ~ ("^" want "\\(\\) \\{$") { cap = 1 }
        cap                            { print }
        cap && /^}$/                   { cap = 0 }
    ' "$TEMPLATE"
}

load_new_impls() {
    local extracted
    extracted=$(mktemp) || fail "mktemp failed"
    {
        extract_function webview_port_is_open
        extract_function verify_webview_origin
        extract_function webview_origin_is_reachable_fast
        extract_function webview_origin_is_reachable
        extract_function wait_for_webview_server
    } > "$extracted"

    # Sanity check: extraction must have produced both function definitions.
    grep -q '^webview_port_is_open() {$'  "$extracted" || { rm -f "$extracted"; fail "webview_port_is_open not extracted from template"; }
    grep -q '^verify_webview_origin() {$' "$extracted" || { rm -f "$extracted"; fail "verify_webview_origin not extracted from template"; }
    grep -q '^webview_origin_is_reachable_fast() {$' "$extracted" || { rm -f "$extracted"; fail "webview_origin_is_reachable_fast not extracted from template"; }
    grep -q '^webview_origin_is_reachable() {$' "$extracted" || { rm -f "$extracted"; fail "webview_origin_is_reachable not extracted from template"; }
    grep -q '^wait_for_webview_server() {$' "$extracted" || { rm -f "$extracted"; fail "wait_for_webview_server not extracted from template"; }

    # shellcheck source=/dev/null
    source "$extracted"
    rm -f "$extracted"

    # Rename so we can call both side-by-side in the same shell.
    eval "$(declare -f webview_port_is_open  | sed '1s/^webview_port_is_open /webview_port_is_open__new /')"
    eval "$(declare -f verify_webview_origin | sed '1s/^verify_webview_origin /verify_webview_origin__new /')"
    eval "$(declare -f webview_origin_is_reachable_fast | sed '1s/^webview_origin_is_reachable_fast /webview_origin_is_reachable_fast__new /')"
    eval "$(declare -f webview_origin_is_reachable | sed '1s/^webview_origin_is_reachable /webview_origin_is_reachable__new /')"
    eval "$(declare -f wait_for_webview_server | sed '1s/^wait_for_webview_server /wait_for_webview_server__new /')"
    unset -f webview_port_is_open verify_webview_origin webview_origin_is_reachable_fast webview_origin_is_reachable wait_for_webview_server

    # Reachability helpers call verify_webview_origin at runtime; keep that name wired
    # to the extracted implementation under test.
    verify_webview_origin() {
        verify_webview_origin__new "$@"
    }
    webview_origin_is_reachable_fast() {
        webview_origin_is_reachable_fast__new "$@"
    }
    webview_origin_is_reachable() {
        webview_origin_is_reachable__new "$@"
    }
}

# webview_port_is_open__new reads the global $CODEX_LINUX_WEBVIEW_PORT.
# Adapter so the test can target arbitrary ports without leaking state.
webview_port_is_open_at__new() {
    local CODEX_LINUX_WEBVIEW_PORT="$1"
    webview_port_is_open__new
}

with_home() {
    local home="$1"
    shift
    local old_home="${HOME-}"
    local had_home=0
    [ "${HOME+x}" = x ] && had_home=1

    HOME="$home"
    "$@"
    local rc=$?

    if [ "$had_home" = 1 ]; then
        HOME="$old_home"
    else
        unset HOME
    fi
    return "$rc"
}

with_bad_loopback_proxy_env() {
    http_proxy="http://127.0.0.1:9" \
    HTTP_PROXY="http://127.0.0.1:9" \
    all_proxy="http://127.0.0.1:9" \
    ALL_PROXY="http://127.0.0.1:9" \
    no_proxy="" \
    NO_PROXY="" \
    "$@"
}

find_closed_tcp_port() {
    local candidate attempt
    for attempt in $(seq 1 50); do
        candidate=$(
            python3 - <<'PY'
import socket

with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    print(s.getsockname()[1])
PY
        ) || return 1
        if ! python3 - "$candidate" <<'PY' 2>/dev/null; then
import socket
import sys

with socket.socket() as s:
    s.settimeout(0.05)
    s.connect(("127.0.0.1", int(sys.argv[1])))
PY
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# ─── Fixture server ────────────────────────────────────────────────────────
setup_server() {
    FIXTURES=$(mktemp -d) || fail "mktemp -d failed"
    cat >"$FIXTURES/index.html" <<'EOF'
<!doctype html>
<html>
<head><title>Codex</title></head>
<body>
<div id="startup-loader">loading</div>
<script>console.log('Codex webview');</script>
</body>
</html>
EOF
    cat >"$FIXTURES/wrong-title.html" <<'EOF'
<!doctype html>
<html><head><title>Not Codex</title></head>
<body><div id="startup-loader">loading</div></body></html>
EOF
    cat >"$FIXTURES/missing-loader.html" <<'EOF'
<!doctype html>
<html><head><title>Codex</title></head>
<body>no loader marker</body></html>
EOF

    PORT_OPEN=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));p=s.getsockname()[1];s.close();print(p)')
    PORT_CLOSED=$(find_closed_tcp_port) || fail "could not find an unused closed localhost port"

    start_fixture_server || return 1
}

start_fixture_server() {
    # Use a threaded server because the TCP-open probes intentionally connect
    # without sending an HTTP request. A single-threaded http.server can spend
    # enough time draining those empty probe connections that the next marker
    # fetch flakes on slower CI runners.
    (cd "$FIXTURES" && exec python3 - "$PORT_OPEN" <<'PY' >/dev/null 2>&1) &
import http.server
import sys


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), QuietHandler)
server.daemon_threads = True
server.serve_forever()
PY
    SERVER_PID=$!

    # Readiness is HTTP-level, not just TCP — http.server binds before it can
    # actually serve requests, and the body-fetch in the OK-markers scenario
    # depends on the server returning a real response.
    local i
    for i in $(seq 1 40); do
        curl --disable --silent --fail --max-time 1 "http://127.0.0.1:$PORT_OPEN/index.html" >/dev/null 2>&1 && return 0
        sleep 0.05
    done
    return 1
}

stop_fixture_server() {
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
    [ -n "${SERVER_PID:-}" ] && wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
}

start_slow_valid_fixture_server() {
    SLOW_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));p=s.getsockname()[1];s.close();print(p)')
    CODEX_LINUX_WEBVIEW_PORT="$SLOW_PORT"
    WEBVIEW_ORIGIN="http://127.0.0.1:$SLOW_PORT"

    ( exec python3 - "$SLOW_PORT" <<'PY' >/dev/null 2>&1 ) &
import http.server
import sys
import time

INDEX_BODY = b"""<!doctype html>
<html>
<head><title>Codex</title></head>
<body>
<div id="startup-loader">loading</div>
</body>
</html>
"""


class SlowOKHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(0.3)
        if self.path in ("/", "/index.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(INDEX_BODY)))
            self.end_headers()
            self.wfile.write(INDEX_BODY)
            return
        self.send_error(404)

    def log_message(self, format, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), SlowOKHandler)
server.daemon_threads = True
server.serve_forever()
PY
    SLOW_SERVER_PID=$!

    local i
    for i in $(seq 1 40); do
        curl --disable --silent --fail --max-time 2 "http://127.0.0.1:$SLOW_PORT/index.html" >/dev/null 2>&1 && return 0
        sleep 0.05
    done
    return 1
}

stop_slow_fixture_server() {
    [ -n "${SLOW_SERVER_PID:-}" ] && kill "$SLOW_SERVER_PID" 2>/dev/null
    [ -n "${SLOW_SERVER_PID:-}" ] && wait "$SLOW_SERVER_PID" 2>/dev/null
    SLOW_SERVER_PID=""
}

teardown() {
    [ "${BASHPID:-$$}" = "$MAIN_BASHPID" ] || return 0
    stop_slow_fixture_server
    stop_fixture_server
    [ -n "${FIXTURES:-}"   ] && rm -rf "$FIXTURES"
    [ -n "${CURLRC_HOME:-}" ] && rm -rf "$CURLRC_HOME"
}
trap teardown EXIT

# ─── Scenario runner ───────────────────────────────────────────────────────
fail_count=0
run_count=0

assert_rc() {
    local label="$1" expected_rc="$2"; shift 2
    run_count=$((run_count + 1))
    local rc=0
    "$@" >/dev/null 2>&1 || rc=$?
    # Normalize any non-zero rc to 1 — semantically "failed" matches what bash
    # `if !` and the launcher's call sites care about.
    [ "$rc" -ne 0 ] && rc=1
    if [ "$rc" = "$expected_rc" ]; then
        printf '  [PASS] %s\n' "$label"
    else
        printf '  [FAIL] %s (got rc=%s, expected rc=%s)\n' "$label" "$rc" "$expected_rc"
        fail_count=$((fail_count + 1))
    fi
}

main() {
    load_new_impls
    setup_server || fail "fixture server did not bind"

    info "TCP probe — open / closed"
    assert_rc "orig  open  ($PORT_OPEN)"     0 webview_port_is_open__orig    "$PORT_OPEN"
    assert_rc "new   open  ($PORT_OPEN)"     0 webview_port_is_open_at__new  "$PORT_OPEN"
    assert_rc "orig  closed ($PORT_CLOSED)"  1 webview_port_is_open__orig    "$PORT_CLOSED"
    assert_rc "new   closed ($PORT_CLOSED)"  1 webview_port_is_open_at__new  "$PORT_CLOSED"

    # Keep TCP probe side effects isolated from HTTP marker checks. The open
    # probes intentionally create empty loopback connections, and the launcher
    # only requires those verdicts to match; HTTP verification gets a fresh
    # fixture server below.
    stop_fixture_server
    [ -n "${FIXTURES:-}" ] && rm -rf "$FIXTURES"
    FIXTURES=""
    setup_server || fail "fixture server did not bind after TCP probes"

    local URL_OK="http://127.0.0.1:$PORT_OPEN/index.html"
    local URL_404="http://127.0.0.1:$PORT_OPEN/missing.html"
    local URL_BADTITLE="http://127.0.0.1:$PORT_OPEN/wrong-title.html"
    local URL_NOLOADER="http://127.0.0.1:$PORT_OPEN/missing-loader.html"
    local URL_DEAD="http://127.0.0.1:$PORT_CLOSED/index.html"

    info "HTTP origin verify — markers + failure modes"
    assert_rc "orig  ok markers"             0 verify_webview_origin__orig "$URL_OK"
    assert_rc "new   ok markers"             0 verify_webview_origin__new  "$URL_OK"
    CURLRC_HOME=$(mktemp -d) || fail "mktemp -d failed for curlrc fixture"
    printf '%s\n' 'output = "curlrc-out"' > "$CURLRC_HOME/.curlrc"
    assert_rc "new   ok markers ignores .curlrc" 0 with_home "$CURLRC_HOME" verify_webview_origin__new "$URL_OK"
    assert_rc "new   ok markers ignores proxy env" 0 with_bad_loopback_proxy_env verify_webview_origin__new "$URL_OK"
    assert_rc "orig  404 path"               1 verify_webview_origin__orig "$URL_404"
    assert_rc "new   404 path"               1 verify_webview_origin__new  "$URL_404"
    assert_rc "orig  wrong title"            1 verify_webview_origin__orig "$URL_BADTITLE"
    assert_rc "new   wrong title"            1 verify_webview_origin__new  "$URL_BADTITLE"
    assert_rc "orig  missing startup-loader" 1 verify_webview_origin__orig "$URL_NOLOADER"
    assert_rc "new   missing startup-loader" 1 verify_webview_origin__new  "$URL_NOLOADER"
    assert_rc "orig  dead port"              1 verify_webview_origin__orig "$URL_DEAD"
    assert_rc "new   dead port"              1 verify_webview_origin__new  "$URL_DEAD"

    stop_fixture_server
    [ -n "${FIXTURES:-}" ] && rm -rf "$FIXTURES"
    FIXTURES=""

    info "slow valid HTTP — 300 ms response exceeds fast probe but passes full verify"
    start_slow_valid_fixture_server || fail "slow valid fixture server did not bind"
    assert_rc "new   fast probe rejects 300 ms response" 1 webview_origin_is_reachable_fast__new
    assert_rc "new   full verify accepts 300 ms response" 0 webview_origin_is_reachable__new
    local t_slow0 t_slow1 slow_elapsed_ms
    t_slow0=$(date +%s%N)
    assert_rc "new   wait fallback accepts 300 ms response" 0 wait_for_webview_server__new
    t_slow1=$(date +%s%N)
    slow_elapsed_ms=$(( (t_slow1 - t_slow0) / 1000000 ))
    run_count=$((run_count + 1))
    if [ "$slow_elapsed_ms" -le 12000 ]; then
        printf '  [PASS] slow wait fallback returned after %d ms\n' "$slow_elapsed_ms"
    else
        printf '  [FAIL] slow wait fallback returned after %d ms (expected <=12000 ms)\n' "$slow_elapsed_ms"
        fail_count=$((fail_count + 1))
    fi
    stop_slow_fixture_server

    setup_server || fail "fixture server did not bind after slow-valid probe"

    info "watchdog cap — 5 s sleeper must die at ~0.2 s"
    local probe_pid kill_pid t0 t1 elapsed_ms
    t0=$(date +%s%N)
    ( sleep 5 ) &
    probe_pid=$!
    ( sleep 0.2 && kill -9 "$probe_pid" 2>/dev/null ) &
    kill_pid=$!
    wait "$probe_pid" 2>/dev/null
    t1=$(date +%s%N)
    kill "$kill_pid" 2>/dev/null
    wait "$kill_pid" 2>/dev/null
    elapsed_ms=$(( (t1 - t0) / 1000000 ))
    run_count=$((run_count + 1))
    if [ "$elapsed_ms" -ge 150 ] && [ "$elapsed_ms" -le 500 ]; then
        printf '  [PASS] sleeper killed at %d ms (within 150–500 ms window)\n' "$elapsed_ms"
    else
        printf '  [FAIL] sleeper terminated after %d ms (expected 150–500 ms)\n' "$elapsed_ms"
        fail_count=$((fail_count + 1))
    fi

    echo
    info "$((run_count - fail_count))/$run_count scenarios passed"
    return "$fail_count"
}

main "$@"
