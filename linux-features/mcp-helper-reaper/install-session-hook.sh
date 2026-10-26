#!/usr/bin/env bash
set -euo pipefail

app_dir="${CODEX_LINUX_APP_DIR:?install-session-hook requires CODEX_LINUX_APP_DIR}"
reaper="$app_dir/.codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper"

[ "${CODEX_MCP_HELPER_REAPER_DISABLE_HOOK:-}" = "1" ] && exit 0
[ -x "$reaper" ] || exit 0

codex_home="${CODEX_HOME:-${HOME:-}/.codex}"
[ -n "$codex_home" ] || exit 0
hooks_file="$codex_home/hooks.json"

mkdir -p "$codex_home"

# The persisted command must not change between launches, or Codex treats the
# hook as modified and asks for review again. The running app exports its
# current location as CODEX_LINUX_APP_DIR, so the hook resolves it at run time.
# A native install keeps its stable directory as the fallback for sessions
# started outside the app. An AppImage mount changes on every launch and a Nix
# store path on every rebuild, so those get none.
fallback_app_dir="$app_dir"
appimage_dir="${APPDIR:-}"
appimage_dir="${appimage_dir%/}"
if [ -n "$appimage_dir" ]; then
    case "$app_dir" in
        "$appimage_dir"|"$appimage_dir"/*) fallback_app_dir="" ;;
    esac
fi
case "$app_dir" in
    /nix/store/*) fallback_app_dir="" ;;
esac

CODEX_MCP_HELPER_REAPER_FALLBACK_APP_DIR="$fallback_app_dir" \
CODEX_MCP_HELPER_REAPER_HOOKS_FILE="$hooks_file" \
python3 - <<'PY'
import json
import os
import shlex
from pathlib import Path

marker = "codex-mcp-helper-reaper-session"
hooks_file = Path(os.environ["CODEX_MCP_HELPER_REAPER_HOOKS_FILE"])
fallback_app_dir = os.environ.get("CODEX_MCP_HELPER_REAPER_FALLBACK_APP_DIR", "")
reaper_rel = ".codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper"

command = (
    f'codex_mcp_reaper_app="${{CODEX_LINUX_APP_DIR:-}}"; '
    f'[ -n "$codex_mcp_reaper_app" ] '
    f'|| codex_mcp_reaper_app={shlex.quote(fallback_app_dir)}; '
    f'codex_mcp_reaper="$codex_mcp_reaper_app/{reaper_rel}"; '
    f'if [ "${{CODEX_MCP_HELPER_REAPER_DISABLE:-}}" != "1" ] '
    f'&& [ -n "$codex_mcp_reaper_app" ] '
    f'&& [ -x "$codex_mcp_reaper" ]; then '
    f'"$codex_mcp_reaper" '
    f'--codex-parent "$PPID" '
    f'--include-orphans '
    f'--app-dir "$codex_mcp_reaper_app" '
    f'--delay "${{CODEX_MCP_HELPER_REAPER_DELAY:-3}}" '
    f'--passes "${{CODEX_MCP_HELPER_REAPER_PASSES:-3}}" '
    f'--interval "${{CODEX_MCP_HELPER_REAPER_INTERVAL:-2}}" '
    f'--term-timeout "${{CODEX_MCP_HELPER_REAPER_TERM_TIMEOUT:-2}}" '
    f'--quiet >/dev/null 2>&1 & '
    f'fi # {marker}'
)

if hooks_file.exists():
    try:
        data = json.loads(hooks_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        data = {}
else:
    data = {}

if not isinstance(data, dict):
    data = {}
hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    hooks = {}
    data["hooks"] = hooks
session_start = hooks.setdefault("SessionStart", [])
if not isinstance(session_start, list):
    session_start = []
    hooks["SessionStart"] = session_start

cleaned_entries = []
for entry in session_start:
    if not isinstance(entry, dict):
        cleaned_entries.append(entry)
        continue
    entry_hooks = entry.get("hooks")
    if not isinstance(entry_hooks, list):
        cleaned_entries.append(entry)
        continue
    filtered_hooks = [
        hook for hook in entry_hooks
        if not (
            isinstance(hook, dict)
            and isinstance(hook.get("command"), str)
            and marker in hook["command"]
        )
    ]
    if filtered_hooks:
        next_entry = dict(entry)
        next_entry["hooks"] = filtered_hooks
        cleaned_entries.append(next_entry)

cleaned_entries.append({
    "matcher": "startup|resume",
    "hooks": [
        {
            "type": "command",
            "command": command,
            "timeout": 1,
            "statusMessage": "MCP Helper Reaper",
        }
    ],
})
hooks["SessionStart"] = cleaned_entries
hooks_file.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
