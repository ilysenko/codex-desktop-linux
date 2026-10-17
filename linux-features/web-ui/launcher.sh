#!/bin/bash
set -Eeuo pipefail
[ "${CODEX_WEB_UI:-0}" = 1 ] || exit 0
# The official Owl/Electron runtime and its Chromium sandbox remain in use.
printf '%s\n' 'electron-arg --headless' 'electron-arg --ozone-platform=headless' 'electron-arg --disable-gpu'
