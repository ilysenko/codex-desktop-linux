#!/usr/bin/env bash
set -Eeo pipefail

fail_launch() {
    printf 'launch-error Chromium sandbox: %s\n' "$1"
    exit 0
}

helper="${CHROME_DEVEL_SANDBOX:-}"
app_dir="${CODEX_LINUX_APP_DIR:-}"
bundled_helper="$app_dir/chrome-sandbox"
generated_helper="${CODEX_LINUX_FEATURES_DIR:-}/chromium-sandbox/generated-chrome-sandbox"
electron="$app_dir/electron"
metadata=""

if [ "${CODEX_LINUX_RESIDENT_PROCESS_ACTIVE:-0}" = "1" ]; then
    fail_launch "a resident app process is already running and its sandbox mode cannot be authoritatively verified; quit it and retry"
fi

case "$helper" in
    /*) ;;
    *) fail_launch "CHROME_DEVEL_SANDBOX must name an absolute helper path" ;;
esac

if [ -L "$helper" ] || [ ! -f "$helper" ] || [ ! -x "$helper" ]; then
    fail_launch "helper must be a non-symlink executable regular file: $helper"
fi
if ! metadata="$(stat -Lc '%u:%g:%a' -- "$helper" 2>/dev/null)" || [ "$metadata" != "0:0:4755" ]; then
    fail_launch "helper must be root:root mode 4755: $helper"
fi
if [ -L "$generated_helper" ] || [ ! -f "$generated_helper" ] || [ ! -x "$generated_helper" ]; then
    fail_launch "generated helper reference is missing or invalid; rebuild with the chromium-sandbox feature enabled"
fi
if ! cmp -s -- "$helper" "$generated_helper"; then
    fail_launch "helper does not match the generated Electron app helper"
fi
if [ -L "$electron" ] || [ ! -f "$electron" ] || [ ! -x "$electron" ] || [ ! -O "$electron" ]; then
    fail_launch "Electron must be a non-symlink executable owned by the launching user so it can honor CHROME_DEVEL_SANDBOX: $electron"
fi
if [ -e "$bundled_helper" ] || [ -L "$bundled_helper" ]; then
    fail_launch "the generated app chrome-sandbox path must remain absent so Chromium cannot supersede CHROME_DEVEL_SANDBOX; rebuild with the feature enabled"
fi

for arg in "$@"; do
    case "${arg%%=*}" in
        --no-sandbox|--disable-*-sandbox)
            fail_launch "conflicting Electron argument is not allowed: $arg"
            ;;
    esac
done

printf 'env CHROME_DEVEL_SANDBOX=%s\n' "$helper"
printf '%s\n' \
    'env-lock CHROME_DEVEL_SANDBOX' \
    'electron-default-arg-remove --no-sandbox' \
    'electron-default-arg-remove --disable-gpu-sandbox' \
    'electron-arg-deny --no-sandbox' \
    'electron-arg-deny --disable-*-sandbox'
