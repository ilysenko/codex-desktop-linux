#!/usr/bin/env bash
set -euo pipefail

feature_dir="$SCRIPT_DIR/linux-features/node-repl-reaper"
codex_linux_dir="$INSTALL_DIR/.codex-linux"

mkdir -p "$codex_linux_dir/cold-start.d" "$codex_linux_dir/after-exit.d"
install -m 0755 "$feature_dir/reaper.sh" "$codex_linux_dir/node-repl-reaper.sh"
install -m 0755 "$feature_dir/cold-start-hook.sh" "$codex_linux_dir/cold-start.d/node-repl-reaper"
install -m 0755 "$feature_dir/after-exit-hook.sh" "$codex_linux_dir/after-exit.d/node-repl-reaper"

echo "node-repl-reaper staged: launch-time, periodic, and exit-time reaping installed" >&2
