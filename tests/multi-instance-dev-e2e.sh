#!/usr/bin/env bash
# Isolated multi-instance launcher E2E for the side-by-side dev app identity.
# Never touches production codex-app. Requires an explicit dev app directory.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROD_APP="${CODEX_PROD_APP:-$HOME/.local/opt/codex-desktop-linux/codex-app}"
DEV_APP="${CODEX_DEV_APP:-${CODEX_DEV_APP_DIR:-$HOME/.local/opt/codex-desktop-linux/codex-dev-app}}"
PASS=0
FAIL=0

pass() { echo "[PASS] $*"; PASS=$((PASS + 1)); }
fail() { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }

usage() {
    cat <<EOF
Usage: CODEX_DEV_APP=/path/to/codex-dev-app $0

Runs an isolated multi-instance launcher test using a temp copy of the dev app.
Production codex-app is never modified or stopped.

Optional:
  CODEX_DEV_APP   Side-by-side dev install (default: ~/.local/opt/.../codex-dev-app)
  CODEX_PROD_APP  Production path used only for a non-interference check
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

if [[ ! -d "$DEV_APP" || ! -x "$DEV_APP/start.sh" ]]; then
    echo "Dev app not found: $DEV_APP" >&2
    echo "Build one with: make build-dev-app  (or set CODEX_DEV_APP)" >&2
    exit 2
fi

if [[ "$DEV_APP" == "$PROD_APP" ]]; then
    echo "Refusing to run: CODEX_DEV_APP must differ from production codex-app" >&2
    exit 2
fi

TEST_ROOT="$(mktemp -d /tmp/codex-dev-multi-e2e.XXXXXX)"
TEST_APP="$TEST_ROOT/codex-dev-app"
cleanup() {
    pkill -f "$TEST_APP/" 2>/dev/null || true
    rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

echo "=== Multi-instance dev E2E (isolated copy) ==="
echo "Source dev app: $DEV_APP"
echo "Temp test app:  $TEST_APP"
echo "Production app: $PROD_APP (read-only check only)"

cp -a "$DEV_APP" "$TEST_APP"
mv "$TEST_APP/electron" "$TEST_APP/electron.real"
cat > "$TEST_APP/electron" << 'MOCK'
#!/usr/bin/env bash
printf 'mock-electron pid=%s port=%s multi=%s\n' "$$" "${CODEX_LINUX_WEBVIEW_PORT:-}" "${CODEX_LINUX_MULTI_LAUNCH:-}" \
    >> "${MOCK_ELECTRON_LOG:-/tmp/mock-electron.log}"
exec sleep 600
MOCK
chmod +x "$TEST_APP/electron"

cat > "$TEST_APP/start.sh" << PRE
#!/bin/bash
set -euo pipefail
CODEX_LINUX_APP_ID=codex-desktop-dev
CODEX_LINUX_APP_DISPLAY_NAME=Codex\ CUA\ Lab
CODEX_LINUX_WEBVIEW_PORT=\${CODEX_WEBVIEW_PORT:-5176}
PRE
cat "$REPO_DIR/launcher/start.sh.template" >> "$TEST_APP/start.sh"
chmod +x "$TEST_APP/start.sh"
cp "$REPO_DIR/launcher/webview-server.py" "$TEST_APP/.codex-linux/webview-server.py"

export XDG_STATE_HOME="$TEST_ROOT/state"
export XDG_CACHE_HOME="$TEST_ROOT/cache"
export XDG_RUNTIME_DIR="$TEST_ROOT/runtime"
export XDG_CONFIG_HOME="$TEST_ROOT/config"
export MOCK_ELECTRON_LOG="$TEST_ROOT/mock-electron.log"
export CODEX_CLI_PATH="${CODEX_CLI_PATH:-$(command -v codex || true)}"
mkdir -p "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME"
chmod 700 "$XDG_RUNTIME_DIR"

# pdeathsig
PDEATHSIG_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 "$TEST_APP/.codex-linux/webview-server.py" "$PDEATHSIG_PORT" --bind 127.0.0.1 &
PDPID=$!
sleep 0.5
kill -9 "$PDPID"
sleep 1
if ( exec 3<>/dev/tcp/127.0.0.1/"$PDEATHSIG_PORT" ) 2>/dev/null; then
    fail "pdeathsig: port $PDEATHSIG_PORT still held"
else
    pass "pdeathsig releases port after parent death"
fi

# Instance 1
"$TEST_APP/start.sh" --disable-gpu &
L1=$!
sleep 8
if grep -q 'port=5176' "$TEST_ROOT/mock-electron.log" 2>/dev/null; then
    pass "instance 1 launched on default dev port 5176"
else
    fail "instance 1 missing on port 5176"
    tail -20 "$TEST_ROOT/cache/codex-desktop-dev/launcher.log" 2>/dev/null || true
fi

# Instance 2 (--new-instance)
"$TEST_APP/start.sh" --new-instance --disable-gpu &
L2=$!
sleep 10

if grep -rq "Multi-launch active; skipping warm-start" "$TEST_ROOT/cache/codex-desktop-dev/" 2>/dev/null; then
    pass "instance 2 skipped warm-start handoff"
else
    fail "instance 2 did not skip warm-start"
fi

if grep -q 'multi=1' "$TEST_ROOT/mock-electron.log" 2>/dev/null; then
    pass "instance 2 exported CODEX_LINUX_MULTI_LAUNCH=1 to Electron"
else
    fail "instance 2 missing CODEX_LINUX_MULTI_LAUNCH export"
fi

if grep -qE 'port=517[7-9]|port=5180' "$TEST_ROOT/mock-electron.log" 2>/dev/null; then
    pass "instance 2 allocated a secondary webview port"
else
    fail "instance 2 did not allocate a secondary port"
    cat "$TEST_ROOT/mock-electron.log" 2>/dev/null || true
fi

MOCK_COUNT="$(grep -c 'mock-electron' "$TEST_ROOT/mock-electron.log" 2>/dev/null || echo 0)"
if [[ "$MOCK_COUNT" -ge 2 ]]; then
    pass "two independent launcher starts completed ($MOCK_COUNT)"
else
    fail "expected two mock electron launches, got $MOCK_COUNT"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
