#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="${CODEX_LINUX_APP_DIR:?account-switcher: CODEX_LINUX_APP_DIR is required}"
# shellcheck source=/dev/null
source "$app_dir/.codex-linux/features/account-switcher/shared-state.sh"

config_home="${XDG_CONFIG_HOME:-${HOME:-}/.config}"
handoff_file="$config_home/codex-desktop/account-switcher.handoff"
declare -A handoff=()

[[ -r "$handoff_file" ]] || exit 0
while IFS='=' read -r key value; do
    [[ "$key" =~ ^[a-z_][a-z0-9_]*$ ]] || continue
    handoff["$key"]="$value"
done < "$handoff_file"

[[ "${handoff[version]:-}" == 1 ]] || exit 1
[[ "${handoff[phase]:-}" == requested ]] || exit 0

# Only the launcher that parented the quitting Electron instance may close the
# launchable requested phase. Secondary single-instance launchers also execute
# exit hooks, but their parent identity does not match this handoff owner.
account_switcher_process_identity_matches \
    "$PPID" "${handoff[owner_start]:-}" "${handoff[owner_boot]:-}" || exit 0
[[ "${handoff[owner_pid]:-}" == "$PPID" ]] || exit 0

temporary="$handoff_file.tmp.$$"
sed 's/^phase=.*/phase=cleanup/' "$handoff_file" > "$temporary"
chmod 0600 "$temporary"
account_switcher_durable_replace "$temporary" "$handoff_file"
