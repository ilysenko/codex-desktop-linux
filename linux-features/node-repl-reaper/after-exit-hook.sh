#!/bin/bash
# Launcher after-exit hook: reap immediately on app exit instead of waiting
# for the watchdog's next interval. The watchdog itself is left running — it
# serves all instances of this install and self-terminates once no electron
# from the install remains.
set -euo pipefail

app_dir="${1:?usage: after-exit hook <app-dir> <state-dir> <log-dir> <status>}"
reaper="$app_dir/.codex-linux/node-repl-reaper.sh"

[ -x "$reaper" ] || exit 0
"$reaper" "$app_dir" once
