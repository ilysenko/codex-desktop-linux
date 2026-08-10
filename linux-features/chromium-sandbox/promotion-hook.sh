#!/usr/bin/env bash
set -Eeuo pipefail

: "${CODEX_CANDIDATE_APP_DIR:?CODEX_CANDIDATE_APP_DIR is required}"
: "${CODEX_CURRENT_APP_DIR:?CODEX_CURRENT_APP_DIR is required}"

# A first install has no working app to invalidate. The user can promote it,
# install the preserved helper, and then launch through the runtime gate.
[ -e "$CODEX_CURRENT_APP_DIR" ] || exit 0

fail_promotion() {
    printf 'ERROR: chromium-sandbox promotion compatibility: %s\n' "$1" >&2
    exit 1
}

helper="${CHROME_DEVEL_SANDBOX:-}"
candidate="$CODEX_CANDIDATE_APP_DIR"
generated_helper="$candidate/.codex-linux/features/chromium-sandbox/generated-chrome-sandbox"
bundled_helper="$candidate/chrome-sandbox"
electron="$candidate/electron"
metadata=""

case "$helper" in
    /*) ;;
    *) fail_promotion "CHROME_DEVEL_SANDBOX must name the absolute external helper qualified for this candidate" ;;
esac
case "$helper" in
    *$'\n'*|*$'\r'*) fail_promotion "CHROME_DEVEL_SANDBOX must not contain CR or LF" ;;
esac
if [ -L "$helper" ] || [ ! -f "$helper" ] || [ ! -x "$helper" ]; then
    fail_promotion "helper must be a non-symlink executable regular file: $helper"
fi
if ! metadata="$(stat -Lc '%u:%g:%a' -- "$helper" 2>/dev/null)" || [ "$metadata" != "0:0:4755" ]; then
    fail_promotion "helper must be root:root mode 4755: $helper"
fi
if [ -L "$generated_helper" ] || [ ! -f "$generated_helper" ] || [ ! -x "$generated_helper" ]; then
    fail_promotion "candidate generated helper reference is missing or invalid: $generated_helper"
fi
if ! cmp -s -- "$helper" "$generated_helper"; then
    fail_promotion "external helper does not match the candidate Electron helper; the working app was not replaced"
fi
if [ -L "$electron" ] || [ ! -f "$electron" ] || [ ! -x "$electron" ] || [ ! -O "$electron" ]; then
    fail_promotion "candidate Electron must be a non-symlink executable owned by the promoting user: $electron"
fi
if [ -e "$bundled_helper" ] || [ -L "$bundled_helper" ]; then
    fail_promotion "candidate chrome-sandbox path must remain absent: $bundled_helper"
fi
