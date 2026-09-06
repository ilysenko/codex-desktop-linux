#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="${CODEX_LINUX_APP_DIR:?account-switcher: CODEX_LINUX_APP_DIR is required}"
# shellcheck source=/dev/null
source "$app_dir/.codex-linux/features/account-switcher/shared-state.sh"

config_home="${XDG_CONFIG_HOME:-${HOME:-}/.config}"
state_dir="$config_home/codex-desktop"
active_file="$state_dir/account-switcher.active"
handoff_file="$state_dir/account-switcher.handoff"
remove_complete_file="$state_dir/account-switcher.remove-complete"
ready_file="$state_dir/account-switcher.ready.$$"
launch_gate=""
declare -A handoff=()
declare -a migration_contexts=()
declare -a migration_journals=()

[[ -r "$handoff_file" ]] || exit 0
while IFS='=' read -r key value; do
    [[ "$key" =~ ^[a-z_][a-z0-9_]*$ ]] || continue
    handoff["$key"]="$value"
done < "$handoff_file"
[[ "${handoff[version]:-}" == 1 ]] || exit 1
[[ "${handoff[phase]:-}" == cleanup ]] || exit 0
account_switcher_validate_id "${handoff[from_id]:-}" || exit 1
account_switcher_validate_id "${handoff[from_context]:-}" || exit 1
[[ "${handoff[from_mode]:-}" == isolated || "${handoff[from_mode]:-}" == shared-local ]] || exit 1
account_switcher_validate_id "${handoff[target_id]:-}" || exit 1
account_switcher_validate_id "${handoff[target_context]:-}" || exit 1
[[ "${handoff[target_mode]:-}" == isolated || "${handoff[target_mode]:-}" == shared-local ]] || exit 1
target_previous_mode="${handoff[target_previous_mode]:-${handoff[target_mode]}}"
target_previous_context="${handoff[target_previous_context]:-${handoff[target_context]}}"
[[ "$target_previous_mode" == isolated || "$target_previous_mode" == shared-local ]] || exit 1
account_switcher_validate_id "$target_previous_context" || exit 1
if [[ -n "${handoff[remove_id]:-}" ]]; then
    account_switcher_validate_id "${handoff[remove_id]}" || exit 1
    [[ "${handoff[remove_id]}" != default && "${handoff[remove_id]}" == "${handoff[from_id]}" ]] || exit 1
fi

# Secondary launchers run the same installed final hook. Only the launcher that
# owned the original Electron process and claimed the cleanup phase may begin
# offline migration or start the replacement.
account_switcher_process_identity_matches \
    "$PPID" "${handoff[owner_start]:-}" "${handoff[owner_boot]:-}" || exit 0
[[ "${handoff[owner_pid]:-}" == "$PPID" ]] || exit 0

# Claim the lifecycle before touching shared state. A concurrent launcher can
# now distinguish a live handoff from crash residue without guessing from age.
owner_start="$(account_switcher_process_start_time "$$")"
owner_boot="$(account_switcher_boot_id)"
claim_temporary="$handoff_file.tmp.$$"
sed -e 's/^phase=.*/phase=preparing/' -e '/^owner_pid=/d' -e '/^owner_start=/d' -e '/^owner_boot=/d' "$handoff_file" > "$claim_temporary"
printf 'owner_pid=%s\nowner_start=%s\nowner_boot=%s\n' "$$" "$owner_start" "$owner_boot" >> "$claim_temporary"
chmod 600 "$claim_temporary"
account_switcher_durable_replace "$claim_temporary" "$handoff_file"
handoff[phase]=preparing
handoff[owner_pid]="$$"
handoff[owner_start]="$owner_start"
handoff[owner_boot]="$owner_boot"

base_codex_home="${CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME:-${CODEX_HOME:-${HOME:-}/.codex}}"
source_home="$base_codex_home"
[[ "${handoff[from_id]}" == default ]] || source_home="$(account_switcher_profile_home "${handoff[from_id]}")"
target_home="$base_codex_home"
[[ "${handoff[target_id]}" == default ]] || target_home="$(account_switcher_profile_home "${handoff[target_id]}")"

restore_source_selection() {
    mkdir -p -- "$state_dir"
    {
        printf '%s\n' "${handoff[from_id]}"
        printf '%s\n' "${handoff[from_mode]}"
        printf '%s\n' "${handoff[from_context]}"
    } > "$active_file.tmp.$$"
    chmod 600 "$active_file.tmp.$$"
    account_switcher_durable_replace "$active_file.tmp.$$" "$active_file"
}

rollback_prepared_migrations() {
    local index
    for ((index=${#migration_journals[@]} - 1; index >= 0; index--)); do
        account_switcher_rollback_prepared "${migration_contexts[index]}" "${migration_journals[index]}" || true
    done
}

commit_prepared_migrations() {
    local index
    for ((index=0; index<${#migration_journals[@]}; index++)); do
        account_switcher_commit_prepared "${migration_contexts[index]}" "${migration_journals[index]}" || return 1
    done
}

persist_migration_phase() {
    local phase="$1" owner_pid="${2:-$$}" owner_start owner_boot index temporary
    owner_start="$(account_switcher_process_start_time "$owner_pid")" || return 1
    owner_boot="$(account_switcher_boot_id)" || return 1
    temporary="$handoff_file.tmp.$$"
    sed -e '/^phase=/d' -e '/^owner_pid=/d' -e '/^owner_start=/d' -e '/^owner_boot=/d' \
        -e '/^migration_count=/d' -e '/^migration_[0-9][0-9]*_context=/d' -e '/^migration_[0-9][0-9]*_journal=/d' \
        "$handoff_file" > "$temporary"
    printf 'phase=%s\nowner_pid=%s\nowner_start=%s\nowner_boot=%s\nmigration_count=%s\n' \
        "$phase" "$owner_pid" "$owner_start" "$owner_boot" "${#migration_journals[@]}" >> "$temporary"
    for ((index=0; index<${#migration_journals[@]}; index++)); do
        printf 'migration_%s_context=%s\nmigration_%s_journal=%s\n' \
            "$index" "${migration_contexts[index]}" "$index" "$(basename -- "${migration_journals[index]}")" >> "$temporary"
    done
    chmod 600 "$temporary"
    account_switcher_durable_replace "$temporary" "$handoff_file"
}

fail_handoff() {
    local message="$1" rollback="${2:-1}"
    [[ "$rollback" == 1 ]] && rollback_prepared_migrations
    restore_source_selection
    if [[ -f "$handoff_file" ]]; then
        sed 's/^phase=.*/phase=failed/' "$handoff_file" > "$handoff_file.tmp.$$"
        chmod 600 "$handoff_file.tmp.$$"
        account_switcher_durable_replace "$handoff_file.tmp.$$" "$handoff_file"
    fi
    rm -f -- "$ready_file"
    [[ -z "$launch_gate" ]] || rm -f -- "$launch_gate"
    printf 'account-switcher: %s; restored %s\n' "$message" "${handoff[from_id]}" >&2
    exit 1
}

if [[ "${handoff[target_mode]}" == shared-local ]]; then
    journal="$(account_switcher_prepare_shared "$source_home" "$target_home" "${handoff[target_context]}")" ||
        fail_handoff "shared catalog migration failed"
    migration_contexts+=("${handoff[target_context]}")
    migration_journals+=("$journal")
else
    if [[ "${handoff[from_mode]}" == shared-local || "${handoff[from_context]}" != default ]]; then
        journal="$(account_switcher_prepare_shared "$source_home" "$source_home" "${handoff[from_context]}")" ||
            fail_handoff "source shared-state flush failed"
        migration_contexts+=("${handoff[from_context]}")
        migration_journals+=("$journal")
    fi
    if [[ "$target_previous_mode" == shared-local || "$target_previous_context" != default ]] &&
       [[ "$target_home|$target_previous_context" != "$source_home|${handoff[from_context]}" ]]; then
        journal="$(account_switcher_prepare_isolated "$target_home" "$target_previous_context")" ||
            fail_handoff "target catalog isolation failed"
        migration_contexts+=("$target_previous_context")
        migration_journals+=("$journal")
    fi
    if [[ "${handoff[from_mode]}" == shared-local || "${handoff[from_context]}" != default ]]; then
        journal="$(account_switcher_prepare_isolated "$source_home" "${handoff[from_context]}")" ||
            fail_handoff "source catalog isolation failed"
        migration_contexts+=("${handoff[from_context]}")
        migration_journals+=("$journal")
    fi
fi

rm -f -- "$ready_file"

launcher="$app_dir/start.sh"
if [[ -n "${APPDIR:-}" && -x "$APPDIR/AppRun" ]]; then
    resolved_appdir="$(readlink -f -- "$APPDIR" 2>/dev/null || true)"
    resolved_install="$(readlink -f -- "$APPDIR/opt/codex-desktop" 2>/dev/null || true)"
    resolved_app="$(readlink -f -- "$app_dir" 2>/dev/null || true)"
    if [[ -n "$resolved_appdir" && -n "$resolved_install" && "$resolved_install" == "$resolved_app" ]]; then
        launcher="$APPDIR/AppRun"
    fi
fi

set +e
launch_gate="$state_dir/account-switcher.launch-gate.$$"
rm -f -- "$launch_gate"
handoff_parent_pid="$$"
if [[ "${handoff[target_id]}" == default ]]; then
    (
        for _ in {1..500}; do
            [[ -f "$launch_gate" ]] && break
            kill -0 "$handoff_parent_pid" 2>/dev/null || exit 1
            sleep 0.01
        done
        [[ -f "$launch_gate" ]] || exit 1
        CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE="$ready_file" \
            CODEX_LINUX_ACCOUNT_SWITCHER_MIGRATION_PREPARED=1 \
            CODEX_HOME="$base_codex_home" \
            exec env -u CODEX_ELECTRON_USER_DATA_PATH \
                -u CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE \
                -u CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT \
                -u CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID \
                -u CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME \
                "$launcher"
    ) &
else
    (
        for _ in {1..500}; do
            [[ -f "$launch_gate" ]] && break
            kill -0 "$handoff_parent_pid" 2>/dev/null || exit 1
            sleep 0.01
        done
        [[ -f "$launch_gate" ]] || exit 1
        CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE="$ready_file" \
            CODEX_LINUX_ACCOUNT_SWITCHER_MIGRATION_PREPARED=1 \
            CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE="${handoff[target_id]}" \
            CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT="${handoff[target_mode]}" \
            CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID="${handoff[target_context]}" \
            exec "$launcher"
    ) &
fi
replacement_pid=$!
set -e
if ! persist_migration_phase launching "$replacement_pid"; then
    fail_handoff "replacement ownership could not be persisted"
fi
touch "$launch_gate"
sync -d "$launch_gate" 2>/dev/null || true

for _ in {1..300}; do
    if [[ -f "$ready_file" ]]; then
        ready_pid=""
        IFS= read -r ready_pid < "$ready_file" || true
        if ! [[ "$ready_pid" =~ ^[1-9][0-9]*$ ]] || ! persist_migration_phase commit-pending "$ready_pid"; then
            persist_migration_phase commit-pending
        fi
        if ! commit_prepared_migrations; then
            rm -f -- "$ready_file" "$launch_gate"
            printf 'account-switcher: replacement is ready but migration commit failed; preserved commit-pending recovery metadata\n' >&2
            exit 1
        fi
        if [[ -n "${handoff[remove_id]:-}" ]]; then
            if ! account_switcher_delete_profile "${handoff[remove_id]}"; then
                rm -f -- "$ready_file" "$launch_gate"
                printf 'account-switcher: replacement is ready but profile removal failed; preserved commit-pending recovery metadata: %s\n' "${handoff[remove_id]}" >&2
                exit 1
            fi
            printf '%s\n' "${handoff[remove_id]}" > "$remove_complete_file.tmp.$$"
            chmod 600 "$remove_complete_file.tmp.$$"
            account_switcher_durable_replace "$remove_complete_file.tmp.$$" "$remove_complete_file"
        fi
        rm -f -- "$ready_file" "$launch_gate"
        account_switcher_durable_remove "$handoff_file"
        exit 0
    fi
    if ! kill -0 "$replacement_pid" 2>/dev/null; then
        break
    fi
    sleep 0.1
done

# Leave a failed replacement untouched for normal process cleanup.
if kill -0 "$replacement_pid" 2>/dev/null; then
    rm -f -- "$launch_gate"
    fail_handoff "replacement did not become ready; deferred catalog rollback until it exits" 0
fi
rm -f -- "$launch_gate"
fail_handoff "replacement did not become ready"
