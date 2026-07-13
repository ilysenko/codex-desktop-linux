#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
skill_dir="$codex_home/skills/upstream-dmg-watchdog"

rm -rf -- "$skill_dir/scripts"
mkdir -p "$skill_dir/scripts"
install -m 0644 "$script_dir/local-skill-adapter.md" "$skill_dir/SKILL.md"
ln -sfn "$repo_root/scripts/automation/upstream-dmg-watchdog/watchdog.py" "$skill_dir/scripts/watchdog.py"
ln -sfn "$repo_root/scripts/automation/upstream-dmg-watchdog/feature-snapshot.js" "$skill_dir/scripts/feature-snapshot.js"

printf 'Installed repository-backed upstream-dmg-watchdog skill at %s\n' "$skill_dir"
