#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="${CODEX_UPSTREAM_APP_DIR:?CODEX_UPSTREAM_APP_DIR is required}"
install_dir="${INSTALL_DIR:?INSTALL_DIR is required}"
source_dir="$app_dir/Contents/Resources"
resources_dir="$install_dir/resources"
target_dir="$resources_dir/dock-icon"
temp_dir="$resources_dir/.dock-icon.tmp.$$"
icons=(
    icon-chatgpt.png
    icon-codex-dark-color.png
    icon-codex-light.png
)

for icon in "${icons[@]}"; do
    source_path="$source_dir/$icon"
    if [ ! -f "$source_path" ] || [ -L "$source_path" ]; then
        echo "Required upstream Dock icon resource is unavailable: $source_path" >&2
        exit 1
    fi
done

if [ -L "$target_dir" ]; then
    echo "Dock icon resource directory must not be a symbolic link: $target_dir" >&2
    exit 1
fi

mkdir -p "$resources_dir"
rm -rf "$temp_dir"
mkdir -m 0755 "$temp_dir"
trap 'rm -rf "$temp_dir"' EXIT
for icon in "${icons[@]}"; do
    install -m 0644 "$source_dir/$icon" "$temp_dir/$icon"
done
rm -rf "$target_dir"
mv "$temp_dir" "$target_dir"
trap - EXIT
