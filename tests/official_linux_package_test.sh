#!/bin/bash
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

ARCH=x86_64
WORK_DIR="$TEST_ROOT/work"
mkdir -p "$WORK_DIR"

info() { :; }
warn() { :; }
error() { printf 'error: %s\n' "$*" >&2; exit 1; }
upstream_artifact_refresh_mode_is_pinned() { return 1; }

. "$REPO_DIR/scripts/lib/official-linux-package.sh"

PACKAGE_ROOT="$TEST_ROOT/package"
mkdir -p "$PACKAGE_ROOT/control" "$PACKAGE_ROOT/data/usr/lib/chatgpt/resources"
cat > "$PACKAGE_ROOT/control/control" <<'EOF'
Package: chatgpt
Version: 26.803.81509
Architecture: amd64
Maintainer: OpenAI <support@openai.com>
Description: fixture
EOF
printf '#!/bin/sh\n' > "$PACKAGE_ROOT/data/usr/lib/chatgpt/ChatGPT"
chmod +x "$PACKAGE_ROOT/data/usr/lib/chatgpt/ChatGPT"
printf 'asar fixture\n' > "$PACKAGE_ROOT/data/usr/lib/chatgpt/resources/app.asar"
printf '2.0\n' > "$PACKAGE_ROOT/debian-binary"
tar -cJf "$PACKAGE_ROOT/control.tar.xz" -C "$PACKAGE_ROOT/control" .
tar -cJf "$PACKAGE_ROOT/data.tar.xz" -C "$PACKAGE_ROOT/data" .
(cd "$PACKAGE_ROOT" && ar r "$TEST_ROOT/chatgpt_amd64.deb" debian-binary control.tar.xz data.tar.xz >/dev/null)

extract_official_linux_package "$TEST_ROOT/chatgpt_amd64.deb"

test "$CODEX_UPSTREAM_APP_VERSION" = "26.803.81509"
test -x "$OFFICIAL_LINUX_RUNTIME_DIR/ChatGPT"
test -f "$OFFICIAL_LINUX_RUNTIME_DIR/resources/app.asar"
test "$DEFAULT_UPSTREAM_ARTIFACT_URL" = \
    "https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb"

printf 'official Linux package helper test passed\n'
