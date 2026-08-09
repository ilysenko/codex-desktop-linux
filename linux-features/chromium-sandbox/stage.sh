#!/usr/bin/env bash
set -Eeuo pipefail

: "${INSTALL_DIR:?INSTALL_DIR is required}"

bundled_helper="$INSTALL_DIR/chrome-sandbox"
feature_dir="$INSTALL_DIR/.codex-linux/features/chromium-sandbox"
generated_helper="$feature_dir/generated-chrome-sandbox"

mkdir -p "$feature_dir"

if [ ! -e "$bundled_helper" ] && [ ! -L "$bundled_helper" ]; then
    if [ -L "$generated_helper" ] || [ ! -f "$generated_helper" ] || [ ! -x "$generated_helper" ]; then
        echo "ERROR: Chromium sandbox feature could not find the generated Electron helper: $bundled_helper" >&2
        exit 1
    fi
    exit 0
fi

if [ -L "$bundled_helper" ] || [ ! -f "$bundled_helper" ] || [ ! -x "$bundled_helper" ]; then
    echo "ERROR: Chromium sandbox feature requires a non-symlink generated Electron helper: $bundled_helper" >&2
    exit 1
fi

mv -fT -- "$bundled_helper" "$generated_helper"
chmod 0755 "$generated_helper"

if [ -e "$bundled_helper" ] || [ -L "$bundled_helper" ] ||
   [ -L "$generated_helper" ] || [ ! -f "$generated_helper" ] || [ ! -x "$generated_helper" ]; then
    echo "ERROR: Chromium sandbox feature could not preserve the generated helper while clearing Electron's sibling helper path" >&2
    exit 1
fi

echo "Chromium sandbox feature preserved generated helper: $generated_helper" >&2
