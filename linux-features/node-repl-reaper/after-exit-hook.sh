#!/bin/bash
# Launcher after-exit hook: reap immediately on app exit instead of waiting
# for the watchdog's next interval. The watchdog itself is left running — it
# serves all instances of this install and self-terminates once no ChatGPT process
# from the install remains.
set -euo pipefail

app_dir="${CODEX_LINUX_APP_DIR:?after-exit hook requires CODEX_LINUX_APP_DIR}"
reaper="$app_dir/.codex-linux/node-repl-reaper.sh"

[ -x "$reaper" ] || exit 0
"$reaper" "$app_dir" once
