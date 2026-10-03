#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/linux-target-detect.sh"

OS_RELEASE_ID="$(os_release_field ID 2>/dev/null || true)"
OS_RELEASE_ID_LIKE="$(os_release_field ID_LIKE 2>/dev/null || true)"
OS_RELEASE_VERSION_ID="$(os_release_field VERSION_ID 2>/dev/null || true)"
export OS_RELEASE_ID OS_RELEASE_ID_LIKE OS_RELEASE_VERSION_ID

detect_package_format
