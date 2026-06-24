#!/bin/bash
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

refresh_lockfile() {
    local source_dir="$1"
    local temp_dir="$TMP_DIR/$(basename "$source_dir")"

    mkdir -p "$temp_dir"
    cp "$source_dir/package.json" "$temp_dir/package.json"
    (
        cd "$temp_dir"
        npm install --package-lock-only --ignore-scripts --no-audit --fund=false
    )
    mv "$temp_dir/package-lock.json" "$source_dir/package-lock.json"
}

refresh_lockfile "$REPO_DIR/packaging/flatpak/asar"
refresh_lockfile "$REPO_DIR/packaging/flatpak/codex-cli"
refresh_lockfile "$REPO_DIR/packaging/flatpak/native-modules"
refresh_lockfile "$REPO_DIR/packaging/flatpak/tools"

node "$REPO_DIR/scripts/flatpak/generate-npm-cache-sources.mjs" \
    "$REPO_DIR/packaging/flatpak/asar/package-lock.json" \
    "$REPO_DIR/packaging/flatpak/asar-sources.json"
node "$REPO_DIR/scripts/flatpak/generate-npm-cache-sources.mjs" \
    "$REPO_DIR/packaging/flatpak/codex-cli/package-lock.json" \
    "$REPO_DIR/packaging/flatpak/codex-cli-sources.json" \
    --allow-os=linux
node "$REPO_DIR/scripts/flatpak/generate-npm-cache-sources.mjs" \
    "$REPO_DIR/packaging/flatpak/native-modules/package-lock.json" \
    "$REPO_DIR/packaging/flatpak/native-modules-sources.json"
node "$REPO_DIR/scripts/flatpak/generate-npm-cache-sources.mjs" \
    "$REPO_DIR/packaging/flatpak/tools/package-lock.json" \
    "$REPO_DIR/packaging/flatpak/tools-sources.json" \
    --allow-os=linux
node "$REPO_DIR/packaging/flatpak/render-manifest.mjs"
