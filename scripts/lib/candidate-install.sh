#!/bin/bash
# Transactional candidate promotion shared by direct installs and rebuild flows.
# shellcheck shell=bash

CANDIDATE_PROMOTION_HELPER="${CODEX_CANDIDATE_PROMOTION_HELPER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/candidate-promotion.py}"

candidate_backup_path() {
    local final_dir="$1"
    local base="${final_dir}.backup-$(date +%Y%m%d%H%M%S)"
    local candidate="$base"
    local suffix=1
    while [ -e "$candidate" ]; do
        candidate="$base-$suffix"
        suffix=$((suffix + 1))
    done
    printf '%s\n' "$candidate"
}

assert_distinct_candidate_paths() {
    local candidate_dir="$1"
    local final_dir="$2"
    [ "$(realpath -m "$candidate_dir")" != "$(realpath -m "$final_dir")" ] || \
        error "Candidate and final app paths must differ: $final_dir"
    [ "$(dirname "$(realpath -m "$candidate_dir")")" = "$(dirname "$(realpath -m "$final_dir")")" ] || \
        error "Candidate must be a sibling of the final app so promotion stays on one filesystem"
}

candidate_promotion_journal_path() {
    local final_dir="$1"
    printf '%s/.%s.promotion.json\n' "$(dirname "$final_dir")" "$(basename "$final_dir")"
}

remove_managed_candidate_backup() {
    local path="$1"
    [ -d "$path" ] && [ ! -L "$path" ] || return 0
    # Nix/store-derived app copies may retain read-only directory modes.
    # `find -P` also avoids dereferencing a path replaced with a symlink.
    find -P "$path" -type d -exec chmod u+w {} + 2>/dev/null || true
    [ -d "$path" ] && [ ! -L "$path" ] || return 0
    rm -rf -- "$path"
}

cleanup_managed_candidate_backups_locked() {
    local final_dir="$1"
    local protected_backup="${2:-}"
    local keep_latest="${3:-0}"
    local stale_backups=""
    local stale_backup
    local args=(list-stale-backups --final "$final_dir")

    if [ -n "$protected_backup" ]; then
        args+=(--protect "$protected_backup")
    elif [ "$keep_latest" = "1" ]; then
        args+=(--keep-latest)
    fi
    if [ "${CODEX_PROMOTION_TEST_FAIL_BACKUP_CLEANUP:-0}" = "1" ]; then
        warn "Could not prune old app backups (simulated failure); cleanup will be retried"
        return 0
    fi
    if ! stale_backups="$(python3 "$CANDIDATE_PROMOTION_HELPER" "${args[@]}")"; then
        warn "Could not enumerate old app backups; cleanup will be retried"
        return 0
    fi
    while IFS= read -r stale_backup; do
        [ -n "$stale_backup" ] || continue
        if ! remove_managed_candidate_backup "$stale_backup"; then
            warn "Could not remove old app backup; cleanup will be retried: $stale_backup"
        fi
    done <<<"$stale_backups"
}

recover_pending_candidate_promotion_locked() {
    local final_dir="$1"
    local journal_file
    local recovered_backup=""
    journal_file="$(candidate_promotion_journal_path "$final_dir")"
    if ! recovered_backup="$(python3 "$CANDIDATE_PROMOTION_HELPER" recover \
        --journal "$journal_file" --final "$final_dir")"; then
        error "Could not safely recover the interrupted app promotion: $journal_file"
        return 1
    fi
    if [ -n "$recovered_backup" ]; then
        PROMOTED_BACKUP_APP_DIR="$recovered_backup"
        export PROMOTED_BACKUP_APP_DIR
        info "Recovered previous app backup: $recovered_backup"
    fi
    cleanup_managed_candidate_backups_locked "$final_dir" "$recovered_backup" 1
}

recover_pending_candidate_promotion() {
    local final_dir="$1"
    local lock_file
    local promotion_lock_fd
    mkdir -p "$(dirname "$final_dir")"
    lock_file="$(dirname "$final_dir")/.$(basename "$final_dir").promotion.lock"
    exec {promotion_lock_fd}>"$lock_file"
    if ! flock -w "${CODEX_PROMOTION_LOCK_TIMEOUT_SECONDS:-60}" "$promotion_lock_fd"; then
        error "Timed out waiting to recover an interrupted promotion: $final_dir"
        return 1
    fi
    recover_pending_candidate_promotion_locked "$final_dir"
    flock -u "$promotion_lock_fd"
    exec {promotion_lock_fd}>&-
}

promote_candidate_install() {
    local candidate_dir="$1"
    local final_dir="$2"
    local backup=""
    local journal_file
    local lock_file
    local promotion_lock_fd
    local previous_install_dir="${INSTALL_DIR:-}"
    local transaction_id

    assert_distinct_candidate_paths "$candidate_dir" "$final_dir"

    lock_file="$(dirname "$final_dir")/.$(basename "$final_dir").promotion.lock"
    exec {promotion_lock_fd}>"$lock_file"
    if ! flock -w "${CODEX_PROMOTION_LOCK_TIMEOUT_SECONDS:-60}" "$promotion_lock_fd"; then
        error "Timed out waiting to promote an accepted candidate: $final_dir"
    fi

    recover_pending_candidate_promotion_locked "$final_dir"
    [ -d "$candidate_dir" ] || error "Candidate app was not created: $candidate_dir"

    # The long build is allowed while the app runs. Only the short atomic
    # promotion window requires the installed executable to be stopped.
    INSTALL_DIR="$final_dir"
    if declare -F install_target_is_stopped >/dev/null 2>&1; then
        if ! install_target_is_stopped; then
            warn "ChatGPT Desktop is still running from $final_dir (pid $RUNNING_INSTALL_TARGET_PID); accepted candidate was not promoted"
            INSTALL_DIR="$previous_install_dir"
            flock -u "$promotion_lock_fd"
            exec {promotion_lock_fd}>&-
            return 1
        fi
    else
        assert_install_target_not_running
    fi
    INSTALL_DIR="$previous_install_dir"

    if [ -e "$final_dir" ]; then
        backup="$(candidate_backup_path "$final_dir")"
        journal_file="$(candidate_promotion_journal_path "$final_dir")"
        transaction_id="$(date -u +%Y%m%dT%H%M%S)-$$-${RANDOM:-0}"
        if ! python3 "$CANDIDATE_PROMOTION_HELPER" prepare \
            --candidate "$candidate_dir" \
            --final "$final_dir" \
            --backup "$backup" \
            --journal "$journal_file" \
            --transaction "$transaction_id"; then
            warn "Could not prepare the candidate promotion journal; the current app was not changed"
            flock -u "$promotion_lock_fd"
            exec {promotion_lock_fd}>&-
            return 1
        fi
        info "Atomically exchanging accepted candidate with the current app"
        if ! python3 "$CANDIDATE_PROMOTION_HELPER" exchange \
            --left "$candidate_dir" --right "$final_dir"; then
            python3 "$CANDIDATE_PROMOTION_HELPER" abort --journal "$journal_file" || true
            warn "Atomic candidate promotion failed; the current app was not changed"
            flock -u "$promotion_lock_fd"
            exec {promotion_lock_fd}>&-
            return 1
        fi

        # Regression tests pause here to prove SIGKILL cannot remove the
        # canonical install path. Availability relies on atomic exchange, not
        # on this process receiving a cleanup signal.
        if [ -n "${CODEX_PROMOTION_TEST_PAUSE_FILE:-}" ]; then
            : >"$CODEX_PROMOTION_TEST_PAUSE_FILE"
            while [ ! -e "${CODEX_PROMOTION_TEST_PAUSE_FILE}.release" ]; do
                sleep 0.05
            done
        fi

        if ! python3 "$CANDIDATE_PROMOTION_HELPER" finalize --journal "$journal_file" >/dev/null; then
            warn "Could not create the previous-app backup; rolling back the atomic exchange"
            if python3 "$CANDIDATE_PROMOTION_HELPER" exchange \
                --left "$candidate_dir" --right "$final_dir"; then
                python3 "$CANDIDATE_PROMOTION_HELPER" abort --journal "$journal_file" || true
            else
                error "Could not roll back the accepted candidate exchange; recovery journal: $journal_file"
            fi
            flock -u "$promotion_lock_fd"
            exec {promotion_lock_fd}>&-
            return 1
        fi
        cleanup_managed_candidate_backups_locked "$final_dir" "$backup"
    else
        info "Promoting accepted candidate: $final_dir"
        if ! mv "$candidate_dir" "$final_dir"; then
            warn "Could not promote the accepted candidate; the app was not installed"
            flock -u "$promotion_lock_fd"
            exec {promotion_lock_fd}>&-
            return 1
        fi
        backup=""
        cleanup_managed_candidate_backups_locked "$final_dir"
    fi

    if [ -n "$backup" ] && [ ! -d "$backup" ]; then
        error "Candidate promotion completed without the expected backup: $backup"
        return 1
    fi

    PROMOTED_BACKUP_APP_DIR="$backup"
    export PROMOTED_BACKUP_APP_DIR
    if [ -n "$backup" ]; then
        info "Moved previous app to backup: $backup"
    fi
    flock -u "$promotion_lock_fd"
    exec {promotion_lock_fd}>&-
}
