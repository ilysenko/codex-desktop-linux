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

remove_dock_icon_payload() {
    rm -rf -- "$temp_dir" "$target_dir"
}

dock_icon_enabled="$(node - "$SCRIPT_DIR" <<'NODE'
const path = require("node:path");

const scriptDir = process.argv[2];
const { loadEnabledLinuxFeatures } = require(path.join(scriptDir, "scripts/lib/linux-features.js"));
const { dockIconEnabled } = require(path.join(
  scriptDir,
  "linux-features/ui-tweaks/patches/dock-icon.js",
));
const feature = loadEnabledLinuxFeatures().find(({ id }) => id === "ui-tweaks");
process.stdout.write(feature != null && dockIconEnabled({ feature }) ? "true" : "false");
NODE
)"

if [ "$dock_icon_enabled" != "true" ]; then
    remove_dock_icon_payload
    exit 0
fi

for icon in "${icons[@]}"; do
    source_path="$source_dir/$icon"
    if [ ! -f "$source_path" ] || [ -L "$source_path" ]; then
        echo "WARN: Upstream Dock icon resource is unavailable; skipping Dock icon resources: $source_path" >&2
        remove_dock_icon_payload
        exit 0
    fi
done

if [ -L "$target_dir" ]; then
    echo "WARN: Removing symbolic link instead of staging Dock icon resources through it: $target_dir" >&2
    rm -f -- "$target_dir"
fi

mkdir -p "$resources_dir"
rm -rf -- "$temp_dir"
mkdir -m 0755 "$temp_dir"
trap 'rm -rf -- "$temp_dir"' EXIT
for icon in "${icons[@]}"; do
    install -m 0644 "$source_dir/$icon" "$temp_dir/$icon"
done
rm -rf -- "$target_dir"
mv "$temp_dir" "$target_dir"
trap - EXIT
