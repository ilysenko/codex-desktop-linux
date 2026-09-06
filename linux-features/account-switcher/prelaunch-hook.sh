#!/usr/bin/env bash
set -Eeuo pipefail

feature_root="${CODEX_LINUX_APP_DIR:?}/.codex-linux/features/account-switcher"
source "$feature_root/shared-state.sh"

config_home="${XDG_CONFIG_HOME:-${HOME:-}/.config}"

account_switcher_app_is_running() {
    local user_data_dir="${1:-}" app_binary="$CODEX_LINUX_APP_DIR/ChatGPT" process exe exe_name cmdline argument environment portable_layout=0 appimage_match
    case "$app_binary" in
        */opt/codex-desktop/ChatGPT) portable_layout=1 ;;
    esac
    for process in /proc/[0-9]*; do
        [[ -d "$process" ]] || continue
        exe="$(readlink -f -- "$process/exe" 2>/dev/null || true)"
        case "$exe" in
            "$app_binary") return 0 ;;
            */opt/codex-desktop/ChatGPT) (( portable_layout == 1 )) && return 0 ;;
        esac
        exe_name="${exe##*/}"
        if [[ -n "${APPIMAGE:-}" && ( "$exe_name" == ChatGPT || "$exe_name" == "ChatGPT (deleted)" ) && -r "$process/environ" ]]; then
            appimage_match=0
            while IFS= read -r -d '' environment; do
                [[ "$environment" == "APPIMAGE=$APPIMAGE" ]] && appimage_match=1
            done < "$process/environ"
            (( appimage_match == 1 )) && return 0
        fi
    done
    for cmdline in /proc/[0-9]*/cmdline; do
        [[ -r "$cmdline" ]] || continue
        while IFS= read -r -d '' argument; do
            case "$argument" in
                "$app_binary") return 0 ;;
                */opt/codex-desktop/ChatGPT) (( portable_layout == 1 )) && return 0 ;;
                "--user-data-dir=$user_data_dir") [[ -n "$user_data_dir" ]] && return 0 ;;
            esac
        done < "$cmdline"
    done
    return 1
}

state_file="$config_home/codex-desktop/account-switcher.active"
handoff_file="$config_home/codex-desktop/account-switcher.handoff"
profile_id=""
profile_mode=""
context_id=""
declare -A live_handoff=()
handoff_is_live=0

# The launcher and prelaunch hook run in separate shells, so route from the
# same authenticated durable record instead of trusting exported variables.
if [[ -r "$handoff_file" ]]; then
    while IFS='=' read -r key value; do
        [[ "$key" =~ ^[a-z_][a-z0-9_]*$ ]] || continue
        live_handoff["$key"]="$value"
    done < "$handoff_file"
    if [[ "${live_handoff[version]:-}" == 1 ]] &&
       account_switcher_validate_id "${live_handoff[from_id]:-}" &&
       account_switcher_validate_id "${live_handoff[from_context]:-}" &&
       account_switcher_validate_id "${live_handoff[target_id]:-}" &&
       account_switcher_validate_id "${live_handoff[target_context]:-}" &&
       [[ "${live_handoff[from_mode]:-}" == isolated || "${live_handoff[from_mode]:-}" == shared-local ]] &&
       [[ "${live_handoff[target_mode]:-}" == isolated || "${live_handoff[target_mode]:-}" == shared-local ]] &&
       account_switcher_recorded_process_live "${live_handoff[owner_pid]:-}" "${live_handoff[owner_start]:-}" "${live_handoff[owner_boot]:-}"; then
        handoff_is_live=1
        case "${live_handoff[phase]:-}" in
            requested)
                profile_id="${live_handoff[from_id]}"
                profile_mode="${live_handoff[from_mode]}"
                context_id="${live_handoff[from_context]}"
                ;;
            commit-pending)
                profile_id="${live_handoff[target_id]}"
                profile_mode="${live_handoff[target_mode]}"
                context_id="${live_handoff[target_context]}"
                ;;
            launching)
                if [[ "${live_handoff[owner_pid]:-}" == "$PPID" ]]; then
                    profile_id="${live_handoff[target_id]}"
                    profile_mode="${live_handoff[target_mode]}"
                    context_id="${live_handoff[target_context]}"
                fi
                ;;
        esac
    fi
fi

# A prepared migration may only bypass prelaunch work for the replacement
# launcher named by the live handoff record. An inherited flag is ignored.
if [[ "${CODEX_LINUX_ACCOUNT_SWITCHER_MIGRATION_PREPARED:-0}" == 1 && "$handoff_is_live" == 1 ]]; then
    if [[ "${live_handoff[phase]:-}" == launching && "${live_handoff[owner_pid]:-}" == "$PPID" ]]; then
        exit 0
    fi
fi
if [[ -z "$profile_id" && -r "$state_file" ]]; then
    IFS= read -r profile_id < "$state_file" || true
    IFS= read -r profile_mode < <(sed -n '2p' "$state_file") || true
    IFS= read -r context_id < <(sed -n '3p' "$state_file") || true
fi
profile_id="${profile_id:-default}"
profile_mode="${profile_mode:-isolated}"
context_id="${context_id:-default}"
account_switcher_validate_id "$profile_id" || { printf 'account-switcher: refusing invalid persisted profile id: %s\n' "$profile_id" >&2; exit 1; }
[[ "$profile_mode" == isolated || "$profile_mode" == shared-local ]] || { printf 'account-switcher: refusing invalid persisted context: %s\n' "$profile_mode" >&2; exit 1; }
account_switcher_validate_id "$context_id" || { printf 'account-switcher: refusing invalid persisted context id: %s\n' "$context_id" >&2; exit 1; }

data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
if [[ "$profile_id" == default ]]; then
    codex_home="${CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME:-${CODEX_HOME:-${HOME:-}/.codex}}"
    user_data_dir="${CODEX_ELECTRON_USER_DATA_PATH:-$config_home/Codex}"
else
    codex_home="$data_home/codex-desktop/account-profiles/$profile_id/codex"
    user_data_dir="$data_home/codex-desktop/account-profiles/$profile_id/electron"
fi

# A launcher-enabled guard closes the gap between the final offline check and
# Electron opening its databases. The first hook hands this flock to a short
# watcher; a concurrent cold launch cannot migrate until Electron is visible,
# then takes the normal upstream single-instance path.
launch_guard_fd=""
if [[ "${CODEX_LINUX_ACCOUNT_SWITCHER_LAUNCH_GUARD:-0}" == 1 ]]; then
    mkdir -p -- "$config_home/codex-desktop"
    chmod 0700 -- "$config_home/codex-desktop"
    exec {launch_guard_fd}> "$config_home/codex-desktop/account-switcher.launch.lock"
    if ! flock -w 30 "$launch_guard_fd"; then
        printf 'account-switcher: timed out waiting for the launch guard\n' >&2
        exit 1
    fi
fi

# Any second invocation belongs to Electron's upstream single-instance
# lifecycle. Recheck only after acquiring the launch guard so two cold starts
# cannot both pass this test before either process is visible.
if account_switcher_app_is_running "$user_data_dir"; then
    exit 0
fi
if [[ "$profile_mode" == shared-local ]]; then
    account_switcher_migrate_shared "$codex_home" "$codex_home" "$context_id"
else
    if [[ "$context_id" != default ]]; then
        account_switcher_migrate_shared "$codex_home" "$codex_home" "$context_id"
        account_switcher_detach_isolated "$codex_home" "$context_id"
    fi
fi

if [[ -n "$launch_guard_fd" ]]; then
    launcher_pid="$PPID"
    (
        for _ in {1..600}; do
            account_switcher_app_is_running "$user_data_dir" && break
            kill -0 "$launcher_pid" 2>/dev/null || break
            sleep 0.05
        done
        flock -u "$launch_guard_fd" || true
        exec {launch_guard_fd}>&-
    ) </dev/null >/dev/null 2>&1 &
    disown "$!" 2>/dev/null || true
    exec {launch_guard_fd}>&-
fi
