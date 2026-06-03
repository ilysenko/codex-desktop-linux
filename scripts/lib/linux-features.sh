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
