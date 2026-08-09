#!/usr/bin/env bash
set -Eeuo pipefail

echo "ERROR: chromium-sandbox supports user-managed app builds only; Chromium does not honor CHROME_DEVEL_SANDBOX for a root-owned packaged Electron executable" >&2
exit 1
