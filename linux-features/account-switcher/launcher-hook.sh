#!/usr/bin/env bash
set -Eeuo pipefail

feature_root="${CODEX_LINUX_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/.codex-linux/features/account-switcher"
[[ -r "$feature_root/shared-state.sh" ]] || feature_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$feature_root/shared-state.sh"

config_home="${XDG_CONFIG_HOME:-${HOME:-}/.config}"
state_file="$config_home/codex-desktop/account-switcher.active"
base_codex_home="${CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME:-${CODEX_HOME:-${HOME:-}/.codex}}"
# These values are emitted for Electron, but a desktop launcher can inherit
# them. Durable state and a live handoff record are the only routing authority.
profile_id=""
profile_mode="isolated"
context_id="default"

profile_has_live_process() {
    local user_data_dir="$1" cmdline argument
    for cmdline in /proc/[0-9]*/cmdline; do
        [[ -r "$cmdline" ]] || continue
        while IFS= read -r -d '' argument; do
            [[ "$argument" == "--user-data-dir=$user_data_dir" ]] && return 0
        done < "$cmdline"
    done
    return 1
}

singleton_socket_is_live() {
    local socket_path="$1" line
    [[ -r /proc/net/unix ]] || return 1
    while IFS= read -r line; do
        [[ "$line" == *" $socket_path" ]] && return 0
    done < /proc/net/unix
    return 1
}

clear_stale_singletons() {
    local user_data_dir="$1" lock_target="" socket_target=""
    [[ -L "$user_data_dir/SingletonLock" ]] || return 0
    profile_has_live_process "$user_data_dir" && return 0
    lock_target="$(readlink "$user_data_dir/SingletonLock")"
    if [[ ! "$lock_target" =~ ^(.+)-([0-9]+)$ ]]; then
        return 0
    fi
    if [[ -L "$user_data_dir/SingletonSocket" ]]; then
        socket_target="$(readlink "$user_data_dir/SingletonSocket")"
        [[ "$socket_target" == /* ]] || socket_target="$user_data_dir/$socket_target"
        [[ -S "$socket_target" ]] && singleton_socket_is_live "$socket_target" && return 0
    fi
    local name
    for name in SingletonLock SingletonSocket SingletonCookie; do
        [[ -L "$user_data_dir/$name" ]] && unlink "$user_data_dir/$name"
    done
    return 0
}

recover_interrupted_handoff() {
    local handoff_file="$config_home/codex-desktop/account-switcher.handoff" key value phase owner data_home
    local source_home target_home source_user_data target_user_data context mode index lock shared_root active_tmp handoff_tmp
    local migration_count migration_context migration_name migration_journal remove_id
    local -A record=()
    local -A recovered_contexts=()
    local -a recovery_modes=()
    local -a recovery_contexts=()
    [[ -r "$handoff_file" ]] || return 0
    while IFS='=' read -r key value; do
        [[ "$key" =~ ^[a-z_][a-z0-9_]*$ ]] || continue
        record["$key"]="$value"
    done < "$handoff_file"
    [[ "${record[version]:-}" == 1 ]] || return 1
    phase="${record[phase]:-}"
    [[ "$phase" == requested || "$phase" == cleanup || "$phase" == preparing || "$phase" == launching || "$phase" == commit-pending || "$phase" == failed ]] || return 0
    for key in from_id from_context target_id target_context; do
        account_switcher_validate_id "${record[$key]:-}" || return 1
    done
    [[ "${record[from_mode]:-}" == isolated || "${record[from_mode]:-}" == shared-local ]] || return 1
    [[ "${record[target_mode]:-}" == isolated || "${record[target_mode]:-}" == shared-local ]] || return 1
    owner="${record[owner_pid]:-}"
    if account_switcher_recorded_process_live "$owner" "${record[owner_start]:-}" "${record[owner_boot]:-}"; then
        if [[ "$owner" == "$PPID" && "$phase" == launching ]]; then
            profile_id="${record[target_id]}"
            profile_mode="${record[target_mode]}"
            context_id="${record[target_context]}"
            return 0
        fi
        if [[ "$phase" == requested || "$phase" == commit-pending ]]; then
            # Route concurrent desktop/deep-link launches to whichever side
            # owns this lifecycle phase so upstream single-instance handling
            # can deliver them without starting another migration.
            if [[ "$phase" == requested ]]; then
                profile_id="${record[from_id]}"
                profile_mode="${record[from_mode]}"
                context_id="${record[from_context]}"
            else
                profile_id="${record[target_id]}"
                profile_mode="${record[target_mode]}"
                context_id="${record[target_context]}"
            fi
            return 0
        fi
        printf 'account-switcher: account handoff is still active under pid %s\n' "$owner" >&2
        return 1
    fi

    data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
    source_home="$base_codex_home"
    source_user_data="$config_home/Codex"
    if [[ "${record[from_id]}" != default ]]; then
        source_home="$(account_switcher_profile_home "${record[from_id]}")"
        source_user_data="$data_home/codex-desktop/account-profiles/${record[from_id]}/electron"
    fi
    target_home="$base_codex_home"
    target_user_data="$config_home/Codex"
    if [[ "${record[target_id]}" != default ]]; then
        target_home="$(account_switcher_profile_home "${record[target_id]}")"
        target_user_data="$data_home/codex-desktop/account-profiles/${record[target_id]}/electron"
    fi
    account_switcher_assert_offline "$source_home" "$source_user_data"
    [[ "$target_home|$target_user_data" == "$source_home|$source_user_data" ]] || account_switcher_assert_offline "$target_home" "$target_user_data"

    if [[ "$phase" == commit-pending ]]; then
        migration_count="${record[migration_count]:-}"
        [[ "$migration_count" =~ ^[0-9]+$ ]] && (( migration_count <= 4 )) || return 1
        for ((index=0; index<migration_count; index++)); do
            migration_context="${record[migration_${index}_context]:-}"
            migration_name="${record[migration_${index}_journal]:-}"
            account_switcher_validate_id "$migration_context" || return 1
            [[ "$migration_name" == .account-switcher-migration-* && "$migration_name" != */* ]] || return 1
            shared_root="$(account_switcher_shared_root "$migration_context")" || return 1
            migration_journal="$shared_root/$migration_name"
            account_switcher_validate_journal "$migration_context" "$migration_journal" || return 1
            account_switcher_commit_prepared "$migration_context" "$migration_journal" || return 1
        done
        remove_id="${record[remove_id]:-}"
        if [[ -n "$remove_id" ]]; then
            account_switcher_validate_id "$remove_id" || return 1
            [[ "$remove_id" != default && "$remove_id" == "${record[from_id]}" ]] || return 1
            account_switcher_delete_profile "$remove_id" || return 1
            printf '%s\n' "$remove_id" > "$config_home/codex-desktop/account-switcher.remove-complete.tmp"
            chmod 600 "$config_home/codex-desktop/account-switcher.remove-complete.tmp"
            account_switcher_durable_replace \
                "$config_home/codex-desktop/account-switcher.remove-complete.tmp" \
                "$config_home/codex-desktop/account-switcher.remove-complete"
        fi
        account_switcher_durable_remove "$handoff_file"
        return 0
    fi
    recovery_modes=("${record[from_mode]}" "${record[target_mode]}")
    recovery_contexts=("${record[from_context]}" "${record[target_context]}")
    for index in 0 1; do
        mode="${recovery_modes[index]}"
        context="${recovery_contexts[index]}"
        [[ "$mode" != isolated || "$context" != default ]] || continue
        [[ -z "${recovered_contexts[$context]:-}" ]] || continue
        recovered_contexts["$context"]=1
        shared_root="$(account_switcher_shared_root "$context")"
        lock="$(account_switcher_context_lock_acquire "$shared_root")"
        if ! account_switcher_recover_context "$shared_root"; then
            account_switcher_context_lock_release "$lock" || true
            return 1
        fi
        account_switcher_context_lock_release "$lock"
    done

    mkdir -p -- "$(dirname -- "$state_file")"
    active_tmp="$state_file.tmp.$$"
    printf '%s\n%s\n%s\n' "${record[from_id]}" "${record[from_mode]}" "${record[from_context]}" > "$active_tmp"
    chmod 600 "$active_tmp"
    account_switcher_durable_replace "$active_tmp" "$state_file"
    handoff_tmp="$handoff_file.tmp.$$"
    sed -e 's/^phase=.*/phase=failed/' -e '/^owner_pid=/d' "$handoff_file" > "$handoff_tmp"
    chmod 600 "$handoff_tmp"
    account_switcher_durable_replace "$handoff_tmp" "$handoff_file"
}

recover_interrupted_handoff

if [[ -z "$profile_id" && -r "$state_file" ]]; then
    IFS= read -r profile_id < "$state_file" || true
    IFS= read -r profile_mode < <(sed -n '2p' "$state_file") || true
    IFS= read -r context_id < <(sed -n '3p' "$state_file") || true
fi

profile_id="${profile_id//[$'\r\n']/}"
profile_id="${profile_id:-default}"
profile_mode="${profile_mode:-isolated}"
context_id="${context_id:-default}"

if ! account_switcher_validate_id "$profile_id"; then
    printf 'account-switcher: refusing invalid profile id: %s\n' "$profile_id" >&2
    exit 1
fi
if [[ "$profile_mode" != "isolated" && "$profile_mode" != "shared-local" ]]; then
    printf 'account-switcher: refusing invalid profile context: %s\n' "$profile_mode" >&2
    exit 1
fi
if ! account_switcher_validate_id "$context_id"; then
    printf 'account-switcher: refusing invalid context id: %s\n' "$context_id" >&2
    exit 1
fi

for argument in "$@"; do
    case "$argument" in
        --user-data-dir|--user-data-dir=*)
            printf 'account-switcher: refusing caller-supplied --user-data-dir for profile %s\n' "$profile_id" >&2
            exit 1
            ;;
    esac
done

if [[ "$profile_id" == default ]]; then
    # Preserve Electron's real upstream default profile path. We do not pass a
    # replacement --user-data-dir for the default account, but still recover
    # its exact stale singleton links after a crash or container cold restart.
    clear_stale_singletons "$config_home/Codex"
    printf 'unset-env CODEX_ELECTRON_USER_DATA_PATH\n'
    printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_LAUNCH_GUARD=1\n'
    printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=default\n'
    printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=%s\n' "$profile_mode"
    printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=%s\n' "$context_id"
    exit 0
fi

data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
profile_root="$data_home/codex-desktop/account-profiles/$profile_id"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_LAUNCH_GUARD=1\n'
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME=%s\n' "$base_codex_home"
clear_stale_singletons "$profile_root/electron"
printf 'env CODEX_HOME=%s\n' "$profile_root/codex"
printf 'env CODEX_ELECTRON_USER_DATA_PATH=%s\n' "$profile_root/electron"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=%s\n' "$profile_id"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=%s\n' "$profile_mode"
printf 'env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=%s\n' "$context_id"
printf 'electron-arg --user-data-dir=%s\n' "$profile_root/electron"
