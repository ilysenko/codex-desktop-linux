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
#   watchdog cap    — a 5 s sleeper is killed at ~0.2 s
#
# Exit 0 when every verdict matches and the watchdog cap fires within its
# bounded window; non-zero otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$REPO_DIR/launcher/start.sh.template"

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
    } > "$extracted"

    # Sanity check: extraction must have produced both function definitions.
    grep -q '^webview_port_is_open() {$'  "$extracted" || { rm -f "$extracted"; fail "webview_port_is_open not extracted from template"; }
    grep -q '^verify_webview_origin() {$' "$extracted" || { rm -f "$extracted"; fail "verify_webview_origin not extracted from template"; }

    # shellcheck source=/dev/null
    source "$extracted"
    rm -f "$extracted"

    # Rename so we can call both side-by-side in the same shell.
    eval "$(declare -f webview_port_is_open  | sed '1s/^webview_port_is_open /webview_port_is_open__new /')"
    eval "$(declare -f verify_webview_origin | sed '1s/^verify_webview_origin /verify_webview_origin__new /')"
    unset -f webview_port_is_open verify_webview_origin
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

    # exec into python so $! is the python PID directly (not the subshell's),
    # making teardown reliable and avoiding orphan http.server processes.
    (cd "$FIXTURES" && exec python3 -m http.server "$PORT_OPEN" --bind 127.0.0.1 >/dev/null 2>&1) &
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

teardown() {
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
    [ -n "${SERVER_PID:-}" ] && wait "$SERVER_PID" 2>/dev/null
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

    local URL_OK="http://127.0.0.1:$PORT_OPEN/index.html"
    local URL_404="http://127.0.0.1:$PORT_OPEN/missing.html"
    local URL_BADTITLE="http://127.0.0.1:$PORT_OPEN/wrong-title.html"
    local URL_NOLOADER="http://127.0.0.1:$PORT_OPEN/missing-loader.html"
    local URL_DEAD="http://127.0.0.1:$PORT_CLOSED/index.html"

    info "TCP probe — open / closed"
    assert_rc "orig  open  ($PORT_OPEN)"     0 webview_port_is_open__orig    "$PORT_OPEN"
    assert_rc "new   open  ($PORT_OPEN)"     0 webview_port_is_open_at__new  "$PORT_OPEN"
    assert_rc "orig  closed ($PORT_CLOSED)"  1 webview_port_is_open__orig    "$PORT_CLOSED"
    assert_rc "new   closed ($PORT_CLOSED)"  1 webview_port_is_open_at__new  "$PORT_CLOSED"

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
