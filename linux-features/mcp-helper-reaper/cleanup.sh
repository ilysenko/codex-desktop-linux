#!/usr/bin/env bash
set -Eeuo pipefail

: "${INSTALL_DIR:?INSTALL_DIR is required}"

codex_linux_dir="$INSTALL_DIR/.codex-linux"
resources_dir="$INSTALL_DIR/resources"
node_repl="$resources_dir/node_repl"
original_node_repl="$resources_dir/node_repl.codex-linux-original"

restore_node_repl() {
    [ -e "$original_node_repl" ] || return 0

    if [ ! -e "$node_repl" ]; then
        mv "$original_node_repl" "$node_repl"
        return 0
    fi

    if grep -q "mcp-helper-reaper-node-repl-wrapper" "$node_repl" 2>/dev/null; then
        rm -f "$node_repl"
        mv "$original_node_repl" "$node_repl"
        return 0
    fi

    echo "mcp-helper-reaper cleanup: leaving node_repl backup in place because current entrypoint is not this feature's wrapper" >&2
}

remove_session_hook() {
    local codex_home hooks_file
    codex_home="${CODEX_HOME:-${HOME:-}/.codex}"
    [ -n "$codex_home" ] || return 0
    hooks_file="$codex_home/hooks.json"
    [ -f "$hooks_file" ] || return 0
    command -v python3 >/dev/null 2>&1 || return 0

    CODEX_MCP_HELPER_REAPER_HOOKS_FILE="$hooks_file" python3 - <<'PY'
import json
import os
from pathlib import Path

marker = "codex-mcp-helper-reaper-session"
hooks_file = Path(os.environ["CODEX_MCP_HELPER_REAPER_HOOKS_FILE"])

try:
    data = json.loads(hooks_file.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    raise SystemExit(0)

hooks = data.get("hooks")
if not isinstance(hooks, dict):
    raise SystemExit(0)

session_start = hooks.get("SessionStart")
if not isinstance(session_start, list):
    raise SystemExit(0)

cleaned_entries = []
changed = False
for entry in session_start:
    if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
        cleaned_entries.append(entry)
        continue
    filtered_hooks = [
        hook for hook in entry["hooks"]
        if not (
            isinstance(hook, dict)
            and isinstance(hook.get("command"), str)
            and marker in hook["command"]
        )
    ]
    if len(filtered_hooks) != len(entry["hooks"]):
        changed = True
    if filtered_hooks:
        next_entry = dict(entry)
        next_entry["hooks"] = filtered_hooks
        cleaned_entries.append(next_entry)

if not changed:
    raise SystemExit(0)

if cleaned_entries:
    hooks["SessionStart"] = cleaned_entries
else:
    hooks.pop("SessionStart", None)

hooks_file.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
}

restore_node_repl
rm -rf "$codex_linux_dir/mcp-helper-reaper"
rm -f "$codex_linux_dir/cold-start.d/mcp-helper-reaper"
rm -f "$codex_linux_dir/after-exit.d/mcp-helper-reaper"
remove_session_hook
