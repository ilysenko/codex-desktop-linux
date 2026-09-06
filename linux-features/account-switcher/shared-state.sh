#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ACCOUNT_SWITCHER_ID_RE='^[a-z0-9][a-z0-9._-]{0,63}$'
ACCOUNT_SWITCHER_CATALOGS=(codex.db codex-dev.db codex-thread-summaries.db codex-thread-summaries-dev.db)
ACCOUNT_SWITCHER_SESSION_PATHS=(sessions session_index.jsonl)

account_switcher_boot_id() {
    local boot_id
    IFS= read -r boot_id < /proc/sys/kernel/random/boot_id || return 1
    [[ "$boot_id" =~ ^[0-9a-f-]+$ ]] || return 1
    printf '%s\n' "$boot_id"
}

account_switcher_process_start_time() {
    local pid="$1" stat rest
    local -a fields=()
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
    IFS= read -r stat < "/proc/$pid/stat" || return 1
    rest="${stat##*) }"
    read -r -a fields <<< "$rest"
    [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "${fields[19]}"
}

account_switcher_process_identity_matches() {
    local pid="$1" expected_start="$2" expected_boot="$3" actual_start actual_boot
    [[ "$expected_start" =~ ^[0-9]+$ && "$expected_boot" =~ ^[0-9a-f-]+$ ]] || return 1
    actual_start="$(account_switcher_process_start_time "$pid")" || return 1
    actual_boot="$(account_switcher_boot_id)" || return 1
    [[ "$actual_start" == "$expected_start" && "$actual_boot" == "$expected_boot" ]]
}

account_switcher_recorded_process_live() {
    local pid="$1" expected_start="$2" expected_boot="$3"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
    account_switcher_process_identity_matches "$pid" "$expected_start" "$expected_boot"
}

account_switcher_write_process_identity() {
    local file="$1" pid="${2:-$$}" start boot
    start="$(account_switcher_process_start_time "$pid")" || return 1
    boot="$(account_switcher_boot_id)" || return 1
    printf '%s\n%s\n%s\n' "$pid" "$start" "$boot" > "$file"
}

account_switcher_read_process_identity() {
    local file="$1"
    ACCOUNT_SWITCHER_OWNER_PID=""
    ACCOUNT_SWITCHER_OWNER_START=""
    ACCOUNT_SWITCHER_OWNER_BOOT=""
    [[ -r "$file" ]] || return 1
    IFS= read -r ACCOUNT_SWITCHER_OWNER_PID < "$file" || true
    IFS= read -r ACCOUNT_SWITCHER_OWNER_START < <(sed -n '2p' "$file") || true
    IFS= read -r ACCOUNT_SWITCHER_OWNER_BOOT < <(sed -n '3p' "$file") || true
}

account_switcher_validate_id() {
    [[ "${1:-}" != . && "${1:-}" != .. && "${1:-}" =~ $ACCOUNT_SWITCHER_ID_RE ]]
}

account_switcher_durable_replace() {
    local temporary="$1" target="$2" parent
    parent="$(dirname -- "$target")"
    sync -d "$temporary"
    mv -- "$temporary" "$target"
    sync -d "$parent"
}

account_switcher_durable_remove() {
    local target="$1" parent
    parent="$(dirname -- "$target")"
    [[ -e "$target" || -L "$target" ]] || return 0
    rm -rf -- "$target"
    sync -d "$parent"
}

account_switcher_profile_home() {
    local id="$1" data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
    account_switcher_validate_id "$id" || return 1
    printf '%s\n' "$data_home/codex-desktop/account-profiles/$id/codex"
}

account_switcher_profile_root() {
    local id="$1" data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
    account_switcher_validate_id "$id" || return 1
    [[ "$id" != default ]] || return 1
    printf '%s\n' "$data_home/codex-desktop/account-profiles/$id"
}

account_switcher_shared_root() {
    local context_id="$1" data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
    account_switcher_validate_id "$context_id" || return 1
    printf '%s\n' "$data_home/codex-desktop/account-contexts/$context_id"
}

account_switcher_context_lock_acquire() {
    local shared_root="$1" lock="$1/.account-switcher.lock" claim deadline owner reclaim_fd acquired
    mkdir -p -- "$shared_root"
    chmod 0700 -- "$shared_root"
    claim="$shared_root/.account-switcher.lock.claim.$$.$RANDOM"
    account_switcher_write_process_identity "$claim"
    chmod 0600 -- "$claim"
    sync -d "$claim" 2>/dev/null || true
    deadline=$((SECONDS + 5))
    while ! ln -T -- "$claim" "$lock" 2>/dev/null; do
        owner=""
        if [[ -f "$lock" && ! -L "$lock" ]]; then
            account_switcher_read_process_identity "$lock" || true
            owner="$ACCOUNT_SWITCHER_OWNER_PID"
            if [[ "$owner" =~ ^[1-9][0-9]*$ ]] &&
               ! account_switcher_recorded_process_live "$owner" "$ACCOUNT_SWITCHER_OWNER_START" "$ACCOUNT_SWITCHER_OWNER_BOOT"; then
                acquired=0
                exec {reclaim_fd}> "$lock.reclaim"
                if flock -w 0.25 "$reclaim_fd"; then
                    owner=""
                    account_switcher_read_process_identity "$lock" || true
                    owner="$ACCOUNT_SWITCHER_OWNER_PID"
                    if [[ -f "$lock" && ! -L "$lock" && "$owner" =~ ^[1-9][0-9]*$ ]] &&
                       ! account_switcher_recorded_process_live "$owner" "$ACCOUNT_SWITCHER_OWNER_START" "$ACCOUNT_SWITCHER_OWNER_BOOT"; then
                        unlink -- "$lock"
                        ln -T -- "$claim" "$lock" 2>/dev/null && acquired=1
                    fi
                    flock -u "$reclaim_fd" || true
                fi
                exec {reclaim_fd}>&-
                if (( acquired == 1 )); then
                    rm -f -- "$claim"
                    printf '%s\n' "$lock"
                    return 0
                fi
                continue
            fi
        elif [[ -d "$lock" && ! -L "$lock" ]]; then
            account_switcher_read_process_identity "$lock/pid" || true
            owner="$ACCOUNT_SWITCHER_OWNER_PID"
            if [[ ! "$owner" =~ ^[1-9][0-9]*$ ]] ||
               ! account_switcher_recorded_process_live "$owner" "$ACCOUNT_SWITCHER_OWNER_START" "$ACCOUNT_SWITCHER_OWNER_BOOT"; then
                acquired=0
                exec {reclaim_fd}> "$lock.reclaim"
                if flock -w 0.25 "$reclaim_fd"; then
                    owner=""
                    account_switcher_read_process_identity "$lock/pid" || true
                    owner="$ACCOUNT_SWITCHER_OWNER_PID"
                    if [[ -d "$lock" && ! -L "$lock" ]] &&
                       { [[ ! "$owner" =~ ^[1-9][0-9]*$ ]] ||
                         ! account_switcher_recorded_process_live "$owner" "$ACCOUNT_SWITCHER_OWNER_START" "$ACCOUNT_SWITCHER_OWNER_BOOT"; }; then
                        rm -rf -- "$lock"
                        ln -T -- "$claim" "$lock" 2>/dev/null && acquired=1
                    fi
                    flock -u "$reclaim_fd" || true
                fi
                exec {reclaim_fd}>&-
                if (( acquired == 1 )); then
                    rm -f -- "$claim"
                    printf '%s\n' "$lock"
                    return 0
                fi
                continue
            fi
        fi
        if (( SECONDS >= deadline )); then
            rm -f -- "$claim"
            printf 'account-switcher: shared context is busy: %s\n' "$shared_root" >&2
            return 1
        fi
        sleep 0.05
    done
    rm -f -- "$claim"
    printf '%s\n' "$lock"
}

account_switcher_context_lock_release() {
    local lock="$1" owner=""
    [[ -f "$lock" && ! -L "$lock" ]] || return 0
    account_switcher_read_process_identity "$lock" || true
    owner="$ACCOUNT_SWITCHER_OWNER_PID"
    [[ "$owner" == "$$" ]] || {
        printf 'account-switcher: refusing to release another process lock: %s\n' "$lock" >&2
        return 1
    }
    unlink -- "$lock"
}

account_switcher_profile_owns_process() {
    local user_data_dir="$1" cmdline argument process exe exe_name app_binary environment app_id_match app_dir_match appimage_match
    # The upstream default profile deliberately has no --user-data-dir flag.
    # In that case only the installed application's live executable is a
    # valid owner; never infer ownership from an arbitrary Electron process.
    if [[ "$user_data_dir" == "${XDG_CONFIG_HOME:-${HOME:-}/.config}/Codex" ]]; then
        app_binary="${CODEX_LINUX_APP_DIR:-}/ChatGPT"
        [[ -n "${CODEX_LINUX_APP_DIR:-}" && -x "$app_binary" ]] &&
        for process in /proc/[0-9]*; do
            exe="$(readlink -- "$process/exe" 2>/dev/null || true)"
            [[ "$exe" == "$(readlink -f -- "$app_binary")" ]] && return 0
            exe_name="${exe##*/}"
            if [[ ( "$exe_name" == ChatGPT || "$exe_name" == "ChatGPT (deleted)" ) && -r "$process/environ" ]]; then
                app_id_match=0
                app_dir_match=0
                appimage_match=0
                while IFS= read -r -d '' environment; do
                    [[ "$environment" == "CODEX_LINUX_APP_ID=${CODEX_LINUX_APP_ID:-codex-desktop}" ]] && app_id_match=1
                    [[ "$environment" == CODEX_LINUX_APP_DIR=*/opt/codex-desktop ]] && app_dir_match=1
                    [[ "$environment" == APPIMAGE=* ]] && appimage_match=1
                done < "$process/environ"
                (( app_id_match == 1 && app_dir_match == 1 && appimage_match == 1 )) && return 0
            fi
        done
    fi
    for cmdline in /proc/[0-9]*/cmdline; do
        [[ -r "$cmdline" ]] || continue
        while IFS= read -r -d '' argument; do
            [[ "$argument" == "--user-data-dir=$user_data_dir" ]] && return 0
        done < "$cmdline"
    done
    return 1
}

account_switcher_path_has_open_fd() {
    local target="$1" fd link
    [[ -e "$target" || -L "$target" ]] || return 1
    target="$(readlink -f -- "$target")" || return 1
    if command -v lsof >/dev/null 2>&1; then
        lsof -t -- "$target" 2>/dev/null | grep -q . && return 0
        return 1
    fi
    for fd in /proc/[0-9]*/fd/*; do
        link="$(readlink -f -- "$fd" 2>/dev/null || true)"
        [[ "$link" == "$target" ]] && return 0
    done
    return 1
}

account_switcher_tree_has_open_fd() {
    local target="$1" fd link
    [[ -e "$target" || -L "$target" ]] || return 1
    target="$(readlink -f -- "$target")" || return 1
    if command -v lsof >/dev/null 2>&1; then
        lsof -t +D "$target" 2>/dev/null | grep -q . && return 0
        return 1
    fi
    for fd in /proc/[0-9]*/fd/*; do
        link="$(readlink -f -- "$fd" 2>/dev/null || true)"
        [[ "$link" == "$target" || "$link" == "$target/"* ]] && return 0
    done
    return 1
}

account_switcher_delete_profile() {
    local id="$1" root codex_home user_data_dir
    root="$(account_switcher_profile_root "$id")" || {
        printf 'account-switcher: refusing to delete invalid or default profile: %s\n' "$id" >&2
        return 1
    }
    codex_home="$root/codex"
    user_data_dir="$root/electron"
    account_switcher_assert_offline "$codex_home" "$user_data_dir" || return 1
    if account_switcher_tree_has_open_fd "$root"; then
        printf 'account-switcher: refusing to delete profile with open files: %s\n' "$root" >&2
        return 1
    fi
    rm -rf -- "$root"
}

account_switcher_assert_offline() {
    local codex_home="$1" user_data_dir="${2:-}" name suffix relative database
    [[ -z "$user_data_dir" ]] || ! account_switcher_profile_owns_process "$user_data_dir" || {
        printf 'account-switcher: profile is still owned by a live Electron process: %s\n' "$user_data_dir" >&2
        return 1
    }
    for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
        if [[ -e "$codex_home/sqlite/$name-journal" || -L "$codex_home/sqlite/$name-journal" ]]; then
            printf 'account-switcher: refusing migration while a SQLite rollback journal exists: %s\n' "$codex_home/sqlite/$name-journal" >&2
            return 1
        fi
        for suffix in "" -wal -shm -journal; do
            if account_switcher_path_has_open_fd "$codex_home/sqlite/$name$suffix"; then
                printf 'account-switcher: refusing migration while SQLite path is open: %s\n' "$codex_home/sqlite/$name$suffix" >&2
                return 1
            fi
        done
    done
    shopt -s nullglob
    for database in "$codex_home"/state_*.sqlite; do
        if [[ -e "$database-journal" || -L "$database-journal" ]]; then
            printf 'account-switcher: refusing migration while a state SQLite rollback journal exists: %s\n' "$database-journal" >&2
            shopt -u nullglob
            return 1
        fi
        for suffix in "" -wal -shm -journal; do
            if account_switcher_path_has_open_fd "$database$suffix"; then
                printf 'account-switcher: refusing migration while state SQLite path is open: %s\n' "$database$suffix" >&2
                shopt -u nullglob
                return 1
            fi
        done
    done
    shopt -u nullglob
    for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
        if [[ -d "$codex_home/$relative" ]]; then
            account_switcher_tree_has_open_fd "$codex_home/$relative" && {
                printf 'account-switcher: refusing migration while session path is open: %s\n' "$codex_home/$relative" >&2
                return 1
            }
        elif account_switcher_path_has_open_fd "$codex_home/$relative"; then
            printf 'account-switcher: refusing migration while session path is open: %s\n' "$codex_home/$relative" >&2
            return 1
        fi
    done
}

account_switcher_committed_journal_path() {
    local journal="$1" parent base suffix
    parent="$(dirname -- "$journal")"
    base="$(basename -- "$journal")"
    [[ "$base" == .account-switcher-migration-* && "$base" != */* ]] || return 1
    suffix="${base#.account-switcher-migration-}"
    printf '%s\n' "$parent/.account-switcher-committed-$suffix"
}

account_switcher_discard_committed_journal() {
    local journal="$1" cleanup
    cleanup="$(account_switcher_committed_journal_path "$journal")" || return 1
    if [[ -d "$journal" ]]; then
        [[ ! -e "$cleanup" && ! -L "$cleanup" ]] || return 1
        mv -T -- "$journal" "$cleanup"
        sync -d "$(dirname -- "$journal")" 2>/dev/null || true
    fi
    [[ ! -e "$cleanup" && ! -L "$cleanup" ]] || rm -rf -- "$cleanup"
}

account_switcher_restore_journal() {
    local journal="$1" record record_name target shared backup action temporary
    local -a fields=()
    local -a records=()
    [[ -d "$journal" ]] || return 0
    if [[ -f "$journal/committed" ]]; then
        account_switcher_discard_committed_journal "$journal"
        return 0
    fi
    mapfile -d '' -t records < <(find "$journal" -maxdepth 1 -type f -name '[0-9]*' -printf '%f\0' | sort -zrn)
    for record_name in "${records[@]}"; do
        record="$journal/$record_name"
        fields=()
        mapfile -d '' -t fields < "$record"
        (( ${#fields[@]} == 4 )) || {
            printf 'account-switcher: refusing malformed migration record: %s\n' "$record" >&2
            return 1
        }
        target="${fields[0]}"
        shared="${fields[1]}"
        backup="${fields[2]}"
        action="${fields[3]}"
        case "$action" in
            backup)
                [[ -L "$target" ]] && unlink -- "$target"
                [[ -e "$backup" || -L "$backup" ]] && mv -- "$backup" "$target"
                ;;
            move)
                [[ -L "$target" ]] && unlink -- "$target"
                [[ -e "$shared" || -L "$shared" ]] && mv -- "$shared" "$target"
                ;;
            promote)
                [[ -L "$target" ]] && unlink -- "$target"
                if [[ ! -e "$target" && ! -L "$target" && ( -e "$shared" || -L "$shared" ) ]]; then
                    mv -- "$shared" "$target"
                fi
                [[ -e "$backup" || -L "$backup" ]] && mv -- "$backup" "$shared"
                ;;
            remove-shared)
                [[ -L "$target" ]] && unlink -- "$target"
                [[ -e "$backup" || -L "$backup" ]] && mv -- "$backup" "$shared"
                ;;
            link) [[ -L "$target" ]] && unlink -- "$target" ;;
            detach)
                if [[ -e "$target" && ! -L "$target" && ! -e "$backup" && ! -L "$backup" ]]; then
                    mv -- "$target" "$backup"
                else
                    [[ -L "$target" ]] && unlink -- "$target"
                fi
                [[ -e "$shared" || -L "$shared" ]] && ln -s -- "$shared" "$target"
                ;;
            detach-copy)
                if [[ -d "$target" && ! -L "$target" ]]; then
                    rm -rf -- "$target"
                elif [[ -e "$target" || -L "$target" ]]; then
                    rm -f -- "$target"
                fi
                [[ -e "$shared" || -L "$shared" ]] && ln -s -- "$shared" "$target"
                ;;
            detach-empty)
                if [[ -e "$target" || -L "$target" ]]; then rm -f -- "$target"; fi
                [[ -e "$shared" || -L "$shared" ]] && ln -s -- "$shared" "$target"
                ;;
            detach-new)
                if [[ -e "$target" || -L "$target" ]]; then rm -f -- "$target"; fi
                ;;
            restore-pending)
                # The durable intent precedes the backup copy. If no complete
                # backup exists, the original target has not been removed and
                # rollback must leave it untouched. If the copy completed just
                # before a crash, restore it using a same-filesystem rename.
                if [[ -e "$backup" || -L "$backup" ]]; then
                    temporary="$target.account-switcher-restore.$(basename -- "$journal").$record_name"
                    if [[ -d "$temporary" && ! -L "$temporary" ]]; then
                        rm -rf -- "$temporary"
                    elif [[ -e "$temporary" || -L "$temporary" ]]; then
                        rm -f -- "$temporary"
                    fi
                    mkdir -p -- "$(dirname -- "$target")"
                    if ! cp -al -- "$backup" "$temporary" 2>/dev/null; then
                        cp -a -- "$backup" "$temporary"
                    fi
                    sync -f "$temporary" 2>/dev/null || true
                    if [[ -d "$target" && ! -L "$target" ]]; then
                        rm -rf -- "$target"
                    elif [[ -e "$target" || -L "$target" ]]; then
                        rm -f -- "$target"
                    fi
                    mv -- "$temporary" "$target"
                    sync -d "$(dirname -- "$target")" 2>/dev/null || true
                fi
                ;;
            restore)
                if [[ -e "$backup" || -L "$backup" ]]; then
                    temporary="$target.account-switcher-restore.$(basename -- "$journal").$record_name"
                    if [[ -d "$temporary" && ! -L "$temporary" ]]; then
                        rm -rf -- "$temporary"
                    elif [[ -e "$temporary" || -L "$temporary" ]]; then
                        rm -f -- "$temporary"
                    fi
                    mkdir -p -- "$(dirname -- "$target")"
                    if ! cp -al -- "$backup" "$temporary" 2>/dev/null; then
                        cp -a -- "$backup" "$temporary"
                    fi
                    sync -f "$temporary" 2>/dev/null || true
                    if [[ -d "$target" && ! -L "$target" ]]; then
                        rm -rf -- "$target"
                    elif [[ -e "$target" || -L "$target" ]]; then
                        rm -f -- "$target"
                    fi
                    mv -- "$temporary" "$target"
                    sync -d "$(dirname -- "$target")" 2>/dev/null || true
                else
                    # A completed backup record without a backup means the
                    # original path did not exist, so remove anything created
                    # later in the transaction.
                    if [[ -d "$target" && ! -L "$target" ]]; then
                        rm -rf -- "$target"
                    elif [[ -e "$target" || -L "$target" ]]; then
                        rm -f -- "$target"
                    fi
                fi
                ;;
            session-move)
                [[ -e "$shared" || -L "$shared" ]] && {
                    mkdir -p -- "$(dirname -- "$target")"
                    mv -- "$shared" "$target"
                }
                ;;
            session-link)
                [[ -e "$target" || -L "$target" ]] && rm -f -- "$target"
                ;;
            session-dir)
                [[ -d "$target" && ! -L "$target" ]] && rmdir -- "$target" 2>/dev/null || true
                ;;
        esac
    done
    rm -rf -- "$journal"
}

account_switcher_write_record() {
    local journal="$1" index="$2" target="$3" shared="$4" backup="$5" action="$6" temporary
    temporary="$journal/.record-$index.tmp.$$"
    printf '%s\0%s\0%s\0%s\0' "$target" "$shared" "$backup" "$action" > "$temporary"
    sync -d "$temporary" 2>/dev/null || true
    mv -- "$temporary" "$journal/$index"
    sync -d "$journal" 2>/dev/null || true
}

account_switcher_node_binary() {
    local node="${CODEX_LINUX_APP_DIR:-}/resources/cua_node/bin/node"
    if [[ -x "$node" ]]; then
        printf '%s\n' "$node"
    else
        command -v node
    fi
}

account_switcher_backup_file() {
    local target="$1" journal="$2" index="$3" backup temporary
    backup="$journal/state-$index.backup"
    temporary="$backup.pending"
    account_switcher_write_record "$journal" "$index" "$target" "" "$backup" restore-pending
    if [[ -e "$target" || -L "$target" ]]; then
        if [[ -d "$temporary" && ! -L "$temporary" ]]; then
            rm -rf -- "$temporary"
        elif [[ -e "$temporary" || -L "$temporary" ]]; then
            rm -f -- "$temporary"
        fi
        if ! cp -al -- "$target" "$temporary" 2>/dev/null; then
            cp -a -- "$target" "$temporary"
        fi
        sync -f "$temporary" 2>/dev/null || true
        mv -- "$temporary" "$backup"
        sync -d "$journal" 2>/dev/null || true
    fi
    # Only a completed record permits the original path to be removed. This
    # makes both sides of the copy durable before rollback can replace data.
    account_switcher_write_record "$journal" "$index" "$target" "" "$backup" restore
    if [[ -d "$target" && ! -L "$target" ]]; then
        rm -rf -- "$target"
    elif [[ -e "$target" || -L "$target" ]]; then
        rm -f -- "$target"
    fi
}

account_switcher_preserve_target_file() {
    local target="$1" journal="$2" index="$3" backup historical temporary
    [[ -e "$target" || -L "$target" ]] || return 0
    backup="$target.isolated-backup"
    if [[ -e "$backup" || -L "$backup" ]]; then
        historical="$backup.preserved.$$.${index}"
        cp -a -- "$backup" "$historical" || return 1
    fi
    temporary="$backup.pending"
    account_switcher_write_record "$journal" "$index" "$target" "" "$backup" restore-pending
    if ! cp -a -- "$target" "$temporary"; then
        return 1
    fi
    mv -- "$temporary" "$backup"
    account_switcher_write_record "$journal" "$index" "$target" "" "$backup" restore
    rm -f -- "$target"
}

account_switcher_merge_catalog_family() {
    local incoming="$1" shared="$2" journal="$3" index="$4" suffix backup helper node
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -f "$incoming" && ! -L "$incoming" && -f "$shared" && ! -L "$shared" ]] || return 0
    # Snapshot and restore the whole destination family before opening it.
    # Rollback can therefore restore a coherent pre-merge generation.
    for suffix in "" -wal -shm; do
        [[ -e "$shared$suffix" || -L "$shared$suffix" ]] || continue
        index=$((index + 1))
        account_switcher_backup_file "$shared$suffix" "$journal" "$index" || return 1
        backup="$journal/state-$index.backup"
        cp -p -- "$backup" "$shared$suffix" || return 1
    done
    helper="$(dirname -- "${BASH_SOURCE[0]}")/shared-state-sqlite.js"
    node="$(account_switcher_node_binary)"
    "$node" "$helper" merge-catalog "$incoming" "$shared" || return 1
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_prepare_local_state() {
    local source_home="$1" target_home="$2" shared_root="$3" journal="$4" index="$5"
    local source_state="$source_home/.codex-global-state.json"
    local target_state="$target_home/.codex-global-state.json"
    local shared_state="$shared_root/local-project-state.json"
    local source_snapshot="$journal/source-global-state.json"
    local helper node target_backup shared_backup

    # The default profile is both source and target during its first shared
    # launch. Snapshot before backing up the target so the source remains
    # readable to the JSON merger while the transaction is prepared.
    if [[ "$source_state" == "$target_state" && -f "$source_state" ]]; then
        cp -- "$source_state" "$source_snapshot"
        source_state="$source_snapshot"
    fi
    account_switcher_backup_file "$target_state" "$journal" "$index"
    target_backup="$journal/state-$index.backup"
    if [[ -e "$target_backup" || -L "$target_backup" ]]; then
        cp -p -- "$target_backup" "$target_state"
    fi
    account_switcher_backup_file "$shared_state" "$journal" "$((index + 1))"
    shared_backup="$journal/state-$((index + 1)).backup"
    # account_switcher_backup_file removes the live path as part of its
    # durable transaction. Restore a readable copy before the JSON helper
    # runs; otherwise a missing shared path is indistinguishable from an
    # empty shared catalog and sparse source state can erase it.
    if [[ -e "$shared_backup" || -L "$shared_backup" ]]; then
        cp -p -- "$shared_backup" "$shared_state"
    fi
    helper="$(dirname -- "${BASH_SOURCE[0]}")/shared-state-json.js"
    node="$(account_switcher_node_binary)"
    "$node" "$helper" prepare "$source_state" "$target_state" "$shared_state"
}

account_switcher_recover_context() {
    local shared_root="$1" journal owner cleanup
    [[ -d "$shared_root" ]] || return 0
    # Committed journals are atomically moved out of the rollback namespace
    # before deletion. A crash during cleanup can therefore only leave inert
    # committed residue, which is safe to remove on the next recovery.
    while IFS= read -r -d '' cleanup; do
        rm -rf -- "$cleanup"
    done < <(find "$shared_root" -maxdepth 1 -type d -name '.account-switcher-committed-*' -print0)
    while IFS= read -r -d '' journal; do
        account_switcher_read_process_identity "$journal/pid" || true
        owner="$ACCOUNT_SWITCHER_OWNER_PID"
        account_switcher_recorded_process_live "$owner" "$ACCOUNT_SWITCHER_OWNER_START" "$ACCOUNT_SWITCHER_OWNER_BOOT" && continue
        account_switcher_restore_journal "$journal"
    done < <(find "$shared_root" -maxdepth 1 -type d -name '.account-switcher-migration-*' -print0)
}

account_switcher_link_catalog() {
    local target="$1" shared="$2" journal="$3" index="$4" promote="${5:-0}" clear_missing="${6:-0}" preserve_target="${7:-0}" backup action link_root
    mkdir -p -- "$(dirname "$target")" "$(dirname "$shared")"
    if [[ -L "$target" ]]; then
        link_root="$(readlink -m -- "$target")"
        [[ "$link_root" == "$shared" ]] && return 0
        case "$link_root" in
            "$(dirname "$shared")"/*) unlink -- "$target" ;;
            *) printf 'account-switcher: refusing unmanaged catalog symlink: %s\n' "$target" >&2; return 1 ;;
        esac
    elif [[ -e "$target" ]]; then
        if (( preserve_target == 1 )); then
            account_switcher_preserve_target_file "$target" "$journal" "$index" || return 1
            [[ -e "$shared" || -L "$shared" ]] && ln -s -- "$shared" "$target"
            return 0
        fi
        backup="$target.isolated-backup"
        [[ -e "$backup" || -L "$backup" ]] && backup="$backup.$$.${index}"
        if [[ -e "$shared" || -L "$shared" ]] && (( promote == 1 )); then
            backup="$journal/catalog-$index.shared-backup"
            action=promote
            account_switcher_write_record "$journal" "$index" "$target" "$shared" "$backup" "$action"
            mv -- "$shared" "$backup" || return 1
            mv -- "$target" "$shared" || return 1
        elif [[ -e "$shared" || -L "$shared" ]]; then
            action=backup
            account_switcher_write_record "$journal" "$index" "$target" "$shared" "$backup" "$action"
            mv -- "$target" "$backup"
        else
            action=move
            account_switcher_write_record "$journal" "$index" "$target" "$shared" "$backup" "$action"
            mv -- "$target" "$shared"
        fi
    else
        if (( promote == 1 && clear_missing == 1 )) && [[ -e "$shared" || -L "$shared" ]]; then
            backup="$journal/catalog-$index.shared-backup"
            account_switcher_write_record "$journal" "$index" "$target" "$shared" "$backup" remove-shared
            mv -- "$shared" "$backup" || return 1
            return 0
        fi
        action="link"
        account_switcher_write_record "$journal" "$index" "$target" "$shared" "" "$action"
    fi
    [[ -e "$shared" || -L "$shared" ]] || return 0
    ln -s -- "$shared" "$target"
}

account_switcher_preserve_catalog_family() {
    local shared_root="$1" name="$2" preservation suffix found=0
    for suffix in "" -wal -shm; do
        [[ -e "$shared_root/$name$suffix" || -L "$shared_root/$name$suffix" ]] || continue
        found=1
    done
    (( found == 1 )) || return 0
    preservation="$shared_root/.account-switcher-preserved-$$-$RANDOM/$name"
    mkdir -p -- "$(dirname -- "$preservation")"
    for suffix in "" -wal -shm; do
        [[ -e "$shared_root/$name$suffix" || -L "$shared_root/$name$suffix" ]] || continue
        cp -a -- "$shared_root/$name$suffix" "$preservation$suffix"
    done
    sync -d "$(dirname -- "$preservation")" 2>/dev/null || true
}

account_switcher_merge_session_tree() {
    local source="$1" shared="$2" journal="$3" index="$4" replace_existing="${5:-0}" file relative target source_inode target_inode
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    if [[ -L "$source" ]]; then
        [[ "$(readlink -m -- "$source")" == "$(readlink -m -- "$shared")" ]] && return 0
        printf 'account-switcher: refusing unmanaged session tree symlink: %s\n' "$source" >&2
        return 1
    fi
    [[ -d "$source" ]] || return 0
    mkdir -p -- "$shared"
    [[ ! -L "$shared" ]] || {
        printf 'account-switcher: refusing unmanaged shared session tree symlink: %s\n' "$shared" >&2
        return 1
    }
    if find "$source" -type l -print -quit | grep -q .; then
        printf 'account-switcher: refusing session tree containing symlinks: %s\n' "$source" >&2
        return 1
    fi
    while IFS= read -r -d '' file; do
        relative="${file#"$source"/}"
        target="$shared/$relative"
        if [[ -e "$target" || -L "$target" ]]; then
            (( replace_existing == 1 )) || continue
            source_inode="$(stat -c '%d:%i' -- "$file" 2>/dev/null || true)"
            target_inode="$(stat -c '%d:%i' -- "$target" 2>/dev/null || true)"
            [[ -n "$source_inode" && "$source_inode" == "$target_inode" ]] && continue
            cmp -s -- "$file" "$target" && continue
            index=$((index + 1))
            account_switcher_backup_file "$target" "$journal" "$index"
        else
            index=$((index + 1))
            account_switcher_write_record "$journal" "$index" "$target" "" "" session-link
        fi
        mkdir -p -- "$(dirname -- "$target")"
        if ! ln -- "$file" "$target" 2>/dev/null; then
            cp -p -- "$file" "$target" || return 1
        fi
    done < <(find "$source" -type f -print0)
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_merge_session_index() {
    local source="$1" shared="$2" journal="$3" index="$4" temporary backup
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    if [[ -L "$source" ]]; then
        [[ "$(readlink -m -- "$source")" == "$(readlink -m -- "$shared")" ]] && return 0
        printf 'account-switcher: refusing unmanaged session index symlink: %s\n' "$source" >&2
        return 1
    fi
    [[ -f "$source" ]] || return 0
    mkdir -p -- "$(dirname -- "$shared")"
    if [[ ! -e "$shared" ]]; then
        index=$((index + 1))
        account_switcher_write_record "$journal" "$index" "$shared" "" "" session-link
        if ! ln -- "$source" "$shared" 2>/dev/null; then
            cp -p -- "$source" "$shared" || return 1
        fi
        ACCOUNT_SWITCHER_MERGE_INDEX="$index"
        return 0
    fi
    [[ ! -L "$shared" ]] || {
        printf 'account-switcher: refusing unmanaged shared session index symlink: %s\n' "$shared" >&2
        return 1
    }
    index=$((index + 1))
    account_switcher_backup_file "$shared" "$journal" "$index"
    backup="$journal/state-$index.backup"
    temporary="$shared.tmp.$$.$index"
    if ! awk 'NF && !seen[$0]++ { print }' "$backup" "$source" > "$temporary"; then
        rm -f -- "$temporary"
        return 1
    fi
    if ! mv -- "$temporary" "$shared"; then
        rm -f -- "$temporary"
        return 1
    fi
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_materialize_session_tree() {
    local target="$1" shared="$2" journal="$3" index="$4" replace_existing="${5:-1}" file relative destination target_inode shared_inode
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -d "$shared" && ! -L "$shared" ]] || return 0
    if [[ -L "$target" ]]; then
        [[ "$(readlink -m -- "$target")" == "$(readlink -m -- "$shared")" ]] || {
            printf 'account-switcher: refusing unmanaged session tree symlink: %s\n' "$target" >&2
            return 1
        }
        index=$((index + 1))
        account_switcher_backup_file "$target" "$journal" "$index"
        mkdir -p -- "$target"
    elif [[ -e "$target" ]]; then
        [[ -d "$target" ]] || {
            printf 'account-switcher: refusing session path that is not a directory: %s\n' "$target" >&2
            return 1
        }
        if find "$target" -type l -print -quit | grep -q .; then
            printf 'account-switcher: refusing session tree containing symlinks: %s\n' "$target" >&2
            return 1
        fi
    else
        index=$((index + 1))
        account_switcher_write_record "$journal" "$index" "$target" "" "" session-dir
        mkdir -p -- "$target"
    fi
    while IFS= read -r -d '' file; do
        relative="${file#"$shared"/}"
        destination="$target/$relative"
        mkdir -p -- "$(dirname -- "$destination")"
        if [[ -e "$destination" || -L "$destination" ]]; then
            target_inode="$(stat -c '%d:%i' -- "$destination" 2>/dev/null || true)"
            shared_inode="$(stat -c '%d:%i' -- "$file" 2>/dev/null || true)"
            [[ -n "$target_inode" && "$target_inode" == "$shared_inode" ]] && continue
            # A target-only or divergent continuation must survive a
            # committed migration. Leave it in the target profile; the
            # shared copy remains available to other profiles and the next
            # merge can reconcile both trees without a journal backup.
            (( replace_existing == 1 )) || continue
            index=$((index + 1))
            account_switcher_backup_file "$destination" "$journal" "$index"
        else
            index=$((index + 1))
            account_switcher_write_record "$journal" "$index" "$destination" "" "" session-link
        fi
        if ! ln -- "$file" "$destination" 2>/dev/null; then
            cp -p -- "$file" "$destination" || return 1
        fi
    done < <(find "$shared" -type f -print0)
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_materialize_session_index() {
    local target="$1" shared="$2" journal="$3" index="$4" target_inode shared_inode
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -f "$shared" && ! -L "$shared" ]] || return 0
    if [[ -e "$target" || -L "$target" ]]; then
        target_inode="$(stat -c '%d:%i' -- "$target" 2>/dev/null || true)"
        shared_inode="$(stat -c '%d:%i' -- "$shared" 2>/dev/null || true)"
        [[ -n "$target_inode" && "$target_inode" == "$shared_inode" ]] && return 0
        if [[ -L "$target" ]]; then
            [[ "$(readlink -m -- "$target")" == "$(readlink -m -- "$shared")" ]] || {
                printf 'account-switcher: refusing unmanaged session index symlink: %s\n' "$target" >&2
                return 1
            }
        fi
        index=$((index + 1))
        account_switcher_backup_file "$target" "$journal" "$index"
    else
        mkdir -p -- "$(dirname -- "$target")"
        index=$((index + 1))
        account_switcher_write_record "$journal" "$index" "$target" "" "" session-link
    fi
    if ! ln -- "$shared" "$target" 2>/dev/null; then
        cp -p -- "$shared" "$target" || return 1
    fi
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_rewrite_state_rollout_paths() {
    local target_home="$1" shared_root="$2" journal="$3" index="$4" database suffix backup helper node found=0
    helper="$(dirname -- "${BASH_SOURCE[0]}")/shared-state-sqlite.js"
    node="$(account_switcher_node_binary)"
    shopt -s nullglob
    for database in "$target_home"/state_*.sqlite; do
        [[ -f "$database" && ! -L "$database" ]] || continue
        found=1
        for suffix in "" -wal -shm; do
            [[ -e "$database$suffix" || -L "$database$suffix" ]] || continue
            index=$((index + 1))
            account_switcher_backup_file "$database$suffix" "$journal" "$index"
            backup="$journal/state-$index.backup"
            cp -- "$backup" "$database$suffix"
        done
    done
    (( found == 0 )) || "$node" "$helper" rewrite-rollout-paths "$target_home" "$shared_root" || return 1
    shopt -u nullglob
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_detach_session_tree() {
    local target="$1" shared="$2" journal="$3" index="$4" file relative shared_file target_inode shared_inode has_shared=0 backup
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -e "$target" || -L "$target" ]] || return 0
    if [[ -L "$target" ]]; then
        [[ "$(readlink -m -- "$target")" == "$(readlink -m -- "$shared")" ]] || return 0
        has_shared=1
    elif [[ -d "$target" && -d "$shared" ]]; then
        while IFS= read -r -d '' file; do
            relative="${file#"$target"/}"
            shared_file="$shared/$relative"
            [[ -f "$shared_file" ]] || continue
            target_inode="$(stat -c '%d:%i' -- "$file" 2>/dev/null || true)"
            shared_inode="$(stat -c '%d:%i' -- "$shared_file" 2>/dev/null || true)"
            if [[ -n "$target_inode" && "$target_inode" == "$shared_inode" ]]; then has_shared=1; break; fi
        done < <(find "$target" -type f -print0)
    fi
    (( has_shared == 1 )) || return 0
    backup="$target.isolated-backup"
    if [[ -e "$backup" || -L "$backup" ]]; then
        index=$((index + 1))
        account_switcher_write_record "$journal" "$index" "$target" "$shared" "$backup" detach
        if [[ -d "$target" && ! -L "$target" ]]; then
            rm -rf -- "$target"
        else
            unlink -- "$target"
        fi
        mv -- "$backup" "$target"
        ACCOUNT_SWITCHER_MERGE_INDEX="$index"
        return 0
    fi
    index=$((index + 1))
    account_switcher_backup_file "$target" "$journal" "$index"
    backup="$journal/state-$index.backup"
    if [[ -d "$backup" ]]; then
        # Keep profile-private rollout files while breaking hardlinks to the
        # shared context. Copying the shared tree would silently discard files
        # created only by this profile.
        cp -a -- "$backup" "$target"
    else
        mkdir -p -- "$target"
    fi
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_detach_session_index() {
    local target="$1" shared="$2" journal="$3" index="$4" target_inode shared_inode backup
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
    [[ -e "$target" || -L "$target" ]] || return 0
    [[ -f "$shared" ]] || return 0
    target_inode="$(stat -c '%d:%i' -- "$target" 2>/dev/null || true)"
    shared_inode="$(stat -c '%d:%i' -- "$shared" 2>/dev/null || true)"
    if [[ -L "$target" ]]; then
        [[ "$(readlink -f -- "$target")" == "$(readlink -f -- "$shared")" ]] || return 0
    elif [[ "$target_inode" != "$shared_inode" ]]; then
        return 0
    fi
    backup="$target.isolated-backup"
    if [[ -e "$backup" || -L "$backup" ]]; then
        index=$((index + 1))
        account_switcher_write_record "$journal" "$index" "$target" "$shared" "$backup" detach
        unlink -- "$target"
        mv -- "$backup" "$target"
        ACCOUNT_SWITCHER_MERGE_INDEX="$index"
        return 0
    fi
    index=$((index + 1))
    account_switcher_backup_file "$target" "$journal" "$index"
    cp -p -- "$shared" "$target"
    ACCOUNT_SWITCHER_MERGE_INDEX="$index"
}

account_switcher_validate_journal() {
    local context_id="$1" journal="$2" shared_root
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    [[ "$(dirname -- "$journal")" == "$shared_root" && "$(basename -- "$journal")" == .account-switcher-migration-* ]]
}

account_switcher_commit_prepared() {
    local context_id="$1" journal="$2" shared_root lock cleanup
    account_switcher_validate_journal "$context_id" "$journal" || return 1
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    lock="$(account_switcher_context_lock_acquire "$shared_root")" || return 1
    # A prior commit attempt may have removed this journal before a later
    # context failed. Treat that context as already committed so the durable
    # handoff intent can be retried safely.
    if [[ ! -d "$journal" ]]; then
        cleanup="$(account_switcher_committed_journal_path "$journal")" || {
            account_switcher_context_lock_release "$lock" || true
            return 1
        }
        if [[ -e "$cleanup" || -L "$cleanup" ]] && ! rm -rf -- "$cleanup"; then
            account_switcher_context_lock_release "$lock" || true
            return 1
        fi
        account_switcher_context_lock_release "$lock"
        return 0
    fi
    if ! touch "$journal/committed"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    sync -d "$journal/committed" 2>/dev/null || true
    sync -d "$journal" 2>/dev/null || true
    if ! account_switcher_discard_committed_journal "$journal"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    account_switcher_context_lock_release "$lock"
}

account_switcher_rollback_prepared() {
    local context_id="$1" journal="$2" shared_root lock
    account_switcher_validate_journal "$context_id" "$journal" || return 1
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    lock="$(account_switcher_context_lock_acquire "$shared_root")" || return 1
    account_switcher_restore_journal "$journal"
    account_switcher_context_lock_release "$lock"
}

account_switcher_prepare_shared() {
    local source_home="$1" target_home="$2" context_id="$3" shared_root lock journal index name suffix relative target_promote=0 promote_family clear_missing preserve_target shared_family
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    lock="$(account_switcher_context_lock_acquire "$shared_root")" || return 1
    if ! account_switcher_assert_offline "$source_home" ||
       { [[ "$target_home" != "$source_home" ]] && ! account_switcher_assert_offline "$target_home"; }; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    if ! account_switcher_recover_context "$shared_root"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    journal="$shared_root/.account-switcher-migration-$$-$RANDOM"
    if ! mkdir -m 0700 -- "$journal"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    account_switcher_write_process_identity "$journal/pid"
    index=0
    if [[ "$source_home" != "$target_home" ]]; then
        for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
            [[ -f "$source_home/sqlite/$name" && ! -L "$source_home/sqlite/$name" ]] || continue
            promote_family=0
            promote_family=1
            [[ -f "$shared_root/$name" || -L "$shared_root/$name" ]] && account_switcher_preserve_catalog_family "$shared_root" "$name"
            for suffix in "" -wal -shm; do
                index=$((index + 1))
                clear_missing=0
                [[ -z "$suffix" || "$promote_family" == 0 ]] || clear_missing=1
                if ! account_switcher_link_catalog "$source_home/sqlite/$name$suffix" "$shared_root/$name$suffix" "$journal" "$index" "$promote_family" "$clear_missing"; then
                    account_switcher_restore_journal "$journal" || true
                    account_switcher_context_lock_release "$lock" || true
                    return 1
                fi
            done
        done
    fi
    [[ "$source_home" != "$target_home" ]] || target_promote=1
    for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
        [[ -f "$target_home/sqlite/$name" && ! -L "$target_home/sqlite/$name" ]] || continue
        promote_family=0
        [[ "$target_promote" == 0 ]] || promote_family=1
        shared_family=0
        [[ -f "$shared_root/$name" || -L "$shared_root/$name" ]] && shared_family=1
        if [[ "$promote_family" == 1 && ( -f "$shared_root/$name" || -L "$shared_root/$name" ) ]]; then
            account_switcher_preserve_catalog_family "$shared_root" "$name"
        fi
        if [[ "$promote_family" == 0 && "$shared_family" == 1 ]]; then
            if ! account_switcher_merge_catalog_family "$target_home/sqlite/$name" "$shared_root/$name" "$journal" "$index"; then
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            fi
            index="$ACCOUNT_SWITCHER_MERGE_INDEX"
        fi
        for suffix in "" -wal -shm; do
            index=$((index + 1))
            clear_missing=0
            preserve_target=0
            [[ -z "$suffix" || "$promote_family" == 0 ]] || clear_missing=1
            [[ -z "$suffix" || "$promote_family" == 1 || "$shared_family" == 0 ]] || preserve_target=1
            if ! account_switcher_link_catalog "$target_home/sqlite/$name$suffix" "$shared_root/$name$suffix" "$journal" "$index" "$promote_family" "$clear_missing" "$preserve_target"; then
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            fi
        done
    done
    # Rollout files must remain lexically inside the active CODEX_HOME. Keep
    # the shared context as the merge source, but materialize active session
    # paths with hardlinks instead of symlinks. Existing files still share
    # writes; newly-created files are merged on the next handoff.
    for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
        if [[ "$relative" == sessions ]]; then
            account_switcher_merge_session_tree "$source_home/$relative" "$shared_root/$relative" "$journal" "$index" 0 || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
            index="$ACCOUNT_SWITCHER_MERGE_INDEX"
        else
            account_switcher_merge_session_index "$source_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
            index="$ACCOUNT_SWITCHER_MERGE_INDEX"
        fi
    done
    if [[ "$source_home" != "$target_home" ]]; then
        for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
            if [[ "$relative" == sessions ]]; then
                account_switcher_merge_session_tree "$target_home/$relative" "$shared_root/$relative" "$journal" "$index" 0 || {
                    account_switcher_restore_journal "$journal" || true
                    account_switcher_context_lock_release "$lock" || true
                    return 1
                }
            else
                account_switcher_merge_session_index "$target_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                    account_switcher_restore_journal "$journal" || true
                    account_switcher_context_lock_release "$lock" || true
                    return 1
                }
            fi
            index="$ACCOUNT_SWITCHER_MERGE_INDEX"
        done
    fi
    account_switcher_rewrite_state_rollout_paths "$target_home" "$shared_root" "$journal" "$index" || {
        account_switcher_restore_journal "$journal" || true
        account_switcher_context_lock_release "$lock" || true
        return 1
    }
    index="$ACCOUNT_SWITCHER_MERGE_INDEX"
    for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
        if [[ "$relative" == sessions ]]; then
            account_switcher_materialize_session_tree "$target_home/$relative" "$shared_root/$relative" "$journal" "$index" 0 || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
        else
            account_switcher_materialize_session_index "$target_home/$relative" "$shared_root/$relative" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
        fi
        index="$ACCOUNT_SWITCHER_MERGE_INDEX"
    done
    index=$((index + 1))
    if ! account_switcher_prepare_local_state "$source_home" "$target_home" "$shared_root" "$journal" "$index"; then
        account_switcher_restore_journal "$journal" || true
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    account_switcher_context_lock_release "$lock"
    printf '%s\n' "$journal"
}

account_switcher_migrate_shared() {
    local source_home="$1" target_home="$2" context_id="$3" journal
    journal="$(account_switcher_prepare_shared "$source_home" "$target_home" "$context_id")" || return 1
    account_switcher_commit_prepared "$context_id" "$journal"
}

account_switcher_prepare_isolated() {
    local codex_home="$1" context_id="$2" shared_root lock journal index name suffix relative target shared backup base_target base_shared restore_family
    shared_root="$(account_switcher_shared_root "$context_id")" || return 1
    lock="$(account_switcher_context_lock_acquire "$shared_root")" || return 1
    if ! account_switcher_assert_offline "$codex_home"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    if ! account_switcher_recover_context "$shared_root"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    journal="$shared_root/.account-switcher-migration-$$-$RANDOM"
    if ! mkdir -m 0700 -- "$journal"; then
        account_switcher_context_lock_release "$lock" || true
        return 1
    fi
    account_switcher_write_process_identity "$journal/pid"
    index=0
    for name in "${ACCOUNT_SWITCHER_CATALOGS[@]}"; do
        base_target="$codex_home/sqlite/$name"
        base_shared="$shared_root/$name"
        [[ -L "$base_target" && "$(readlink -m -- "$base_target")" == "$(readlink -m -- "$base_shared")" ]] || continue
        restore_family=0
        [[ -e "$base_target.isolated-backup" || -L "$base_target.isolated-backup" ]] && restore_family=1
        for suffix in "" -wal -shm; do
            target="$codex_home/sqlite/$name$suffix"; shared="$shared_root/$name$suffix"; backup="$target.isolated-backup"
            index=$((index + 1))
            if (( restore_family == 1 )); then
                if [[ -e "$backup" || -L "$backup" ]]; then
                    if [[ -L "$target" ]]; then
                        [[ "$(readlink -m -- "$target")" == "$(readlink -m -- "$shared")" ]] || {
                            account_switcher_restore_journal "$journal" || true
                            account_switcher_context_lock_release "$lock" || true
                            return 1
                        }
                    elif [[ -e "$target" ]]; then
                        account_switcher_restore_journal "$journal" || true
                        account_switcher_context_lock_release "$lock" || true
                        return 1
                    fi
                    account_switcher_write_record "$journal" "$index" "$target" "$shared" "$backup" detach
                    if { [[ ! -L "$target" ]] || unlink -- "$target"; } && mv -- "$backup" "$target"; then :; else
                        account_switcher_restore_journal "$journal" || true
                        account_switcher_context_lock_release "$lock" || true
                        return 1
                    fi
                else
                    if [[ -L "$target" ]]; then
                        [[ "$(readlink -m -- "$target")" == "$(readlink -m -- "$shared")" ]] || {
                            account_switcher_restore_journal "$journal" || true
                            account_switcher_context_lock_release "$lock" || true
                            return 1
                        }
                        account_switcher_write_record "$journal" "$index" "$target" "$shared" "" detach-empty
                        if ! unlink -- "$target"; then
                            account_switcher_restore_journal "$journal" || true
                            account_switcher_context_lock_release "$lock" || true
                            return 1
                        fi
                    elif [[ -e "$target" ]]; then
                        if ! account_switcher_backup_file "$target" "$journal" "$index"; then
                            account_switcher_restore_journal "$journal" || true
                            account_switcher_context_lock_release "$lock" || true
                            return 1
                        fi
                    fi
                fi
            else
                if [[ -L "$target" ]]; then
                    [[ "$(readlink -m -- "$target")" == "$(readlink -m -- "$shared")" ]] || {
                        account_switcher_restore_journal "$journal" || true
                        account_switcher_context_lock_release "$lock" || true
                        return 1
                    }
                    account_switcher_write_record "$journal" "$index" "$target" "$shared" "" detach-copy
                    if ! unlink -- "$target"; then
                        account_switcher_restore_journal "$journal" || true
                        account_switcher_context_lock_release "$lock" || true
                        return 1
                    fi
                    if [[ -e "$shared" || -L "$shared" ]] && ! cp -p -- "$shared" "$target"; then
                        account_switcher_restore_journal "$journal" || true
                        account_switcher_context_lock_release "$lock" || true
                        return 1
                    fi
                elif [[ ! -e "$target" && ( -e "$shared" || -L "$shared" ) ]]; then
                    account_switcher_write_record "$journal" "$index" "$target" "$shared" "" detach-new
                    if ! cp -p -- "$shared" "$target"; then
                        account_switcher_restore_journal "$journal" || true
                        account_switcher_context_lock_release "$lock" || true
                        return 1
                    fi
                fi
            fi
        done
    done
    for relative in "${ACCOUNT_SWITCHER_SESSION_PATHS[@]}"; do
        target="$codex_home/$relative"; shared="$shared_root/$relative"
        if [[ "$relative" == sessions ]]; then
            account_switcher_detach_session_tree "$target" "$shared" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
        else
            account_switcher_detach_session_index "$target" "$shared" "$journal" "$index" || {
                account_switcher_restore_journal "$journal" || true
                account_switcher_context_lock_release "$lock" || true
                return 1
            }
        fi
        index="$ACCOUNT_SWITCHER_MERGE_INDEX"
    done
    account_switcher_context_lock_release "$lock"
    printf '%s\n' "$journal"
}

account_switcher_detach_isolated() {
    local codex_home="$1" context_id="$2" journal
    journal="$(account_switcher_prepare_isolated "$codex_home" "$context_id")" || return 1
    account_switcher_commit_prepared "$context_id" "$journal"
}
