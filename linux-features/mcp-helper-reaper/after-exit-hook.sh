#!/usr/bin/env bash
set -euo pipefail

app_dir="${CODEX_LINUX_APP_DIR:?after-exit hook requires CODEX_LINUX_APP_DIR}"
reaper="$app_dir/.codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper"

[ "${CODEX_MCP_HELPER_REAPER_DISABLE:-}" = "1" ] && exit 0
[ -x "$reaper" ] || exit 0

"$reaper" \
    --all-codex-parents \
    --include-orphans \
    --app-dir "$app_dir" \
    --passes 1 \
    --term-timeout "${CODEX_MCP_HELPER_REAPER_TERM_TIMEOUT:-2}" \
    --quiet
