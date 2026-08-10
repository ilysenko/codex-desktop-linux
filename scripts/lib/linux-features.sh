#!/bin/bash
# Opt-in Linux feature staging hooks.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

run_linux_feature_stage_hooks() {
    local app_dir="${1:-}"
    local feature_helper="$SCRIPT_DIR/scripts/lib/linux-features.js"
    local feature_id
    local hook_path

    [ -f "$feature_helper" ] || {
        warn "Linux feature helper not found at $feature_helper"
        return 0
    }

    while IFS=$'\t' read -r feature_id hook_path; do
        [ -n "$feature_id" ] || continue
        [ -n "$hook_path" ] || continue
        info "Running disabled Linux feature cleanup hook: $feature_id"
        if ! SCRIPT_DIR="$SCRIPT_DIR" INSTALL_DIR="$INSTALL_DIR" WORK_DIR="$WORK_DIR" ARCH="$ARCH" CODEX_UPSTREAM_APP_DIR="$app_dir" bash "$hook_path"; then
            warn "Linux feature cleanup hook failed: $feature_id"
            return 1
        fi
    done < <(node "$feature_helper" --cleanup-hooks)

    info "Staging declarative Linux feature resources and runtime hooks"
    if ! SCRIPT_DIR="$SCRIPT_DIR" INSTALL_DIR="$INSTALL_DIR" WORK_DIR="$WORK_DIR" ARCH="$ARCH" CODEX_UPSTREAM_APP_DIR="$app_dir" node "$feature_helper" --stage-install "$INSTALL_DIR"; then
        warn "Linux feature declarative staging failed"
        return 1
    fi

    while IFS=$'\t' read -r feature_id hook_path; do
        [ -n "$feature_id" ] || continue
        [ -n "$hook_path" ] || continue
        info "Running Linux feature stage hook: $feature_id"
        if ! SCRIPT_DIR="$SCRIPT_DIR" INSTALL_DIR="$INSTALL_DIR" WORK_DIR="$WORK_DIR" ARCH="$ARCH" CODEX_UPSTREAM_APP_DIR="$app_dir" bash "$hook_path"; then
            warn "Linux feature stage hook failed: $feature_id"
            return 1
        fi
    done < <(node "$feature_helper" --stage-hooks)
}

run_linux_feature_promotion_hooks() {
    local candidate_dir="$1"
    local current_dir="$2"
    local feature_helper="$SCRIPT_DIR/scripts/lib/linux-features.js"
    local feature_id
    local hook_path
    local hooks_output

    [ -f "$feature_helper" ] || {
        warn "Linux feature helper not found at $feature_helper"
        return 1
    }
    if ! hooks_output="$(node "$feature_helper" --promotion-hooks "$candidate_dir")"; then
        warn "Could not discover enabled Linux feature promotion hooks"
        return 1
    fi

    while IFS=$'\t' read -r feature_id hook_path; do
        [ -n "$feature_id" ] || continue
        [ -f "$hook_path" ] || {
            warn "Missing Linux feature promotion hook for $feature_id: $hook_path"
            return 1
        }
        info "Running Linux feature promotion compatibility hook: $feature_id"
        if ! CODEX_CANDIDATE_APP_DIR="$candidate_dir" \
            CODEX_CURRENT_APP_DIR="$current_dir" \
            CODEX_LINUX_FEATURE_HOOK_PHASE=promotion \
            SCRIPT_DIR="$SCRIPT_DIR" \
            bash "$hook_path"; then
            warn "Linux feature promotion compatibility refused the candidate: $feature_id"
            return 1
        fi
    done <<<"$hooks_output"
}
