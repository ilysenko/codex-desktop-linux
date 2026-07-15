#!/usr/bin/env bash
set -Eeuo pipefail

install_dir="${INSTALL_DIR:?INSTALL_DIR is required}"
target_dir="$install_dir/resources/dock-icon"

if [ -L "$target_dir" ]; then
    echo "Dock icon resource directory must not be a symbolic link: $target_dir" >&2
    exit 1
fi

rm -rf "$target_dir"
