#!/usr/bin/env bash
set -Eeuo pipefail

: "${INSTALL_DIR:?INSTALL_DIR is required}"

bundled_helper="$INSTALL_DIR/chrome-sandbox"
feature_dir="$INSTALL_DIR/.codex-linux/features/chromium-sandbox"
generated_helper="$feature_dir/generated-chrome-sandbox"

if [ -L "$generated_helper" ] || { [ -e "$generated_helper" ] && [ ! -f "$generated_helper" ]; }; then
    echo "ERROR: Chromium sandbox cleanup refused an invalid generated helper reference: $generated_helper" >&2
    exit 1
fi
[ -f "$generated_helper" ] || exit 0

if [ -L "$bundled_helper" ] || [ ! -e "$bundled_helper" ]; then
    mv -fT -- "$generated_helper" "$bundled_helper"
    chmod 0755 "$bundled_helper"
else
    rm -f -- "$generated_helper"
fi

rmdir "$feature_dir" 2>/dev/null || true
