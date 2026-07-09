#!/usr/bin/env bash
set -euo pipefail

app_dir="${1:?usage: install-session-hook <app-dir> <state-dir> <log-dir>}"
state_dir="${2:-}"
log_dir="${3:-}"
reaper="$app_dir/.codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper"

[ "${CODEX_MCP_HELPER_REAPER_DISABLE_HOOK:-}" = "1" ] && exit 0
[ -x "$reaper" ] || exit 0

codex_home="${CODEX_HOME:-${HOME:-}/.codex}"
[ -n "$codex_home" ] || exit 0
hooks_file="$codex_home/hooks.json"

mkdir -p "$codex_home"

CODEX_MCP_HELPER_REAPER_APP_DIR="$app_dir" \
CODEX_MCP_HELPER_REAPER_BINARY="$reaper" \
CODEX_MCP_HELPER_REAPER_HOOKS_FILE="$hooks_file" \
python3 - <<'PY'
import json
import os
import shlex
from pathlib import Path

marker = "codex-mcp-helper-reaper-session"
hooks_file = Path(os.environ["CODEX_MCP_HELPER_REAPER_HOOKS_FILE"])
reaper = Path(os.environ["CODEX_MCP_HELPER_REAPER_BINARY"])
app_dir = Path(os.environ["CODEX_MCP_HELPER_REAPER_APP_DIR"])

command = (
    f'if [ "${{CODEX_MCP_HELPER_REAPER_DISABLE:-}}" != "1" ] '
    f'&& [ -x {shlex.quote(str(reaper))} ]; then '
    f'{shlex.quote(str(reaper))} '
    f'--codex-parent "$PPID" '
    f'--include-orphans '
    f'--app-dir {shlex.quote(str(app_dir))} '
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
        }
    ],
})
hooks["SessionStart"] = cleaned_entries
hooks_file.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
