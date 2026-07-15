#!/usr/bin/env bash
set -Eeuo pipefail

install_dir="${INSTALL_DIR:?INSTALL_DIR is required}"
target_dir="$install_dir/resources/dock-icon"

rm -rf -- "$target_dir"
