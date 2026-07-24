#!/usr/bin/env bash
set -Eeuo pipefail

find_cargo_for_record_replay() {
    if command -v cargo >/dev/null 2>&1; then
        command -v cargo
        return 0
    fi

    if [ -x "$HOME/.cargo/bin/cargo" ]; then
        echo "$HOME/.cargo/bin/cargo"
        return 0
    fi

    return 1
}

write_record_replay_marketplace_entry() {
    local marketplace="$1"
    node - "$marketplace" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const marketplacePath = process.argv[2];
let marketplace = { plugins: [] };
try {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
} catch (_error) {
  marketplace = { plugins: [] };
}
if (!Array.isArray(marketplace.plugins)) {
  marketplace.plugins = [];
}
marketplace.plugins = marketplace.plugins.filter((plugin) => plugin?.name !== "record-and-replay");
marketplace.plugins.push({
  name: "record-and-replay",
  source: {
    source: "local",
    path: "./plugins/record-and-replay",
  },
  policy: {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  },
  category: "Productivity",
});
fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
NODE
}

find_upstream_record_replay_icon() {
    local assets_dir
    local candidate
    for assets_dir in \
        "$target_plugin/assets" \
        "$INSTALL_DIR/content/webview/assets" \
        "$INSTALL_DIR/app/content/webview/assets" \
        "$INSTALL_DIR/resources/app/content/webview/assets"; do
        [ -d "$assets_dir" ] || continue
        candidate="$(find "$assets_dir" -maxdepth 1 -type f \( -name 'app-icon.png' -o -name 'record-and-replay-plugin-icon-*.png' \) | sort | head -n 1)"
        [ -n "$candidate" ] || continue
        printf '%s\n' "$candidate"
        return 0
    done
}

use_upstream_record_replay_icon() {
    local plugin_dir="$1"
    local source_icon
    source_icon="$(find_upstream_record_replay_icon)"
    [ -n "$source_icon" ] || return 0

    local target_icon="$plugin_dir/assets/record-and-replay-plugin-icon.png"
    mkdir -p "$(dirname "$target_icon")"
    cp "$source_icon" "$target_icon"

    node - "$plugin_dir/.codex-plugin/plugin.json" <<'NODE'
const fs = require("node:fs");

const pluginPath = process.argv[2];
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
plugin.interface = plugin.interface ?? {};
plugin.interface.logo = "./assets/record-and-replay-plugin-icon.png";
plugin.interface.composerIcon = "./assets/record-and-replay-plugin-icon.png";
fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
NODE
}

find_upstream_record_replay_plugin() {
    local app_dir="${CODEX_UPSTREAM_APP_DIR:-}"
    local candidate=""

    [ -n "$app_dir" ] || return 1
    candidate="$app_dir/Contents/Resources/plugins/openai-bundled/plugins/record-and-replay"
    [ -f "$candidate/.codex-plugin/plugin.json" ] || return 1
    [ -f "$candidate/.mcp.json" ] || return 1
    [ -d "$candidate/skills/record-and-replay" ] || return 1
    [ -x "$candidate/bin/computer-use-client-launcher" ] || return 1
    [ ! -e "$candidate/Codex Computer Use.app" ] && [ ! -L "$candidate/Codex Computer Use.app" ] || return 1

    printf '%s\n' "$candidate"
}

stage_record_replay_plugin_base() {
    local target_plugin="$1"
    local plugin_template="$2"
    local source_plugin=""

    rm -rf "$target_plugin"
    mkdir -p "$target_plugin"

    if source_plugin="$(find_upstream_record_replay_plugin)"; then
        cp -R "$source_plugin/." "$target_plugin/"
        find "$target_plugin" \( -name '*:com.apple.*' -o -name '.gitkeep' -o -name '.DS_Store' \) -delete
        echo "Record & Replay plugin base staged from upstream DMG" >&2
        return 0
    fi

    cp -R "$plugin_template/." "$target_plugin/"
    find "$target_plugin" \( -name '*:com.apple.*' -o -name '.gitkeep' -o -name '.DS_Store' \) -delete
    echo "Record & Replay plugin base staged from Linux template" >&2
}

patch_record_replay_plugin_for_linux() {
    local plugin_dir="$1"

    mkdir -p "$plugin_dir/bin" "$plugin_dir/skills/record-and-replay"
    cp "$SCRIPT_DIR/linux-features/record-and-replay/plugin-template/skills/record-and-replay/SKILL.md" \
        "$plugin_dir/skills/record-and-replay/SKILL.md"

    cat > "$plugin_dir/.mcp.json" <<'JSON'
{
  "mcpServers": {
    "event-stream": {
      "command": "./bin/SkyLinuxComputerUseClient",
      "args": ["event-stream", "mcp"],
      "cwd": "."
    }
  }
}
JSON

    node - "$plugin_dir/.codex-plugin/plugin.json" "$plugin_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const pluginPath = process.argv[2];
const pluginDir = process.argv[3];
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
const interfaceConfig = plugin.interface ?? {};
const hasPngIcon = fs.existsSync(path.join(pluginDir, "assets", "app-icon.png"));
const hasSvgIcon = fs.existsSync(path.join(pluginDir, "assets", "app-icon.svg"));
const iconPath = hasPngIcon
  ? "./assets/app-icon.png"
  : hasSvgIcon
    ? "./assets/app-icon.svg"
    : interfaceConfig.logo;

plugin.name = "record-and-replay";
plugin.description = "Record what I'm doing on Linux";
plugin.keywords = Array.from(
  new Set(
    [
      ...(Array.isArray(plugin.keywords) ? plugin.keywords : []),
      "linux",
      "computer-use",
      "demo-to-skill",
    ].filter((keyword) => keyword !== "macos"),
  ),
);
plugin.mcpServers = "./.mcp.json";
plugin.skills = "./skills/";
plugin.interface = {
  ...interfaceConfig,
  displayName: "Record & Replay",
  shortDescription: "Record what I'm doing on Linux and turn it into a Skill",
  longDescription:
    "Record & Replay lets Codex record your actions on Linux to create skills for more automated workflows. When you choose to start a recording, Codex records desktop and browser context, screenshots, accessibility data, user markers, and spoken transcript context until you stop it (up to 30 minutes). You can stop or cancel recording at any time, and cancelling should discard the recording. Avoid recording sensitive workflows.",
  category: interfaceConfig.category || "Productivity",
  privacyPolicyURL:
    interfaceConfig.privacyPolicyURL || "https://openai.com/policies/row-privacy-policy/",
  termsOfServiceURL:
    interfaceConfig.termsOfServiceURL || "https://openai.com/policies/row-terms-of-use/",
  logo: iconPath,
  composerIcon: iconPath,
  defaultPrompt: [
    "Record my workflow and turn it into a reusable skill",
    "Watch me do this task and create a skill from it",
    "Record what I'm doing and make a skill called 'File Expense'",
  ],
  brandColor: interfaceConfig.brandColor || "#0F172A",
  screenshots: Array.isArray(interfaceConfig.screenshots) ? interfaceConfig.screenshots : [],
};

fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
NODE
}

build_record_replay_backend() {
    local source_binary="$SCRIPT_DIR/target/release/codex-record-replay-linux"
    local cargo_cmd=""

    if [ -n "${CODEX_RECORD_REPLAY_LINUX_SOURCE:-}" ]; then
        [ -x "$CODEX_RECORD_REPLAY_LINUX_SOURCE" ] || {
            echo "Record & Replay source is not executable: $CODEX_RECORD_REPLAY_LINUX_SOURCE" >&2
            return 1
        }
        echo "Using prebuilt Record & Replay backend" >&2
        printf '%s\n' "$CODEX_RECORD_REPLAY_LINUX_SOURCE"
        return 0
    fi

    if ! cargo_cmd="$(find_cargo_for_record_replay)"; then
        echo "cargo not found; Record & Replay backend cannot be built" >&2
        echo "Install/use a Rust toolchain for this build, or set CODEX_RECORD_REPLAY_LINUX_SOURCE to an executable codex-record-replay-linux binary." >&2
        return 1
    fi

    echo "Building Record & Replay backend..." >&2
    if ! (cd "$SCRIPT_DIR" && "$cargo_cmd" build --release -p codex-record-replay-linux >&2); then
        echo "Failed to build Record & Replay backend" >&2
        return 1
    fi

    [ -x "$source_binary" ] || {
        echo "Record & Replay backend missing after build: $source_binary" >&2
        return 1
    }
    printf '%s\n' "$source_binary"
}

backend_binary="$(build_record_replay_backend)"
native_target_dir="$INSTALL_DIR/resources/native"
plugin_template="$SCRIPT_DIR/linux-features/record-and-replay/plugin-template"
target_plugin="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/record-and-replay"
target_marketplace="$INSTALL_DIR/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"

[ -d "$plugin_template" ] || {
    echo "Record & Replay plugin template not found at $plugin_template" >&2
    exit 1
}

mkdir -p "$native_target_dir"
cp "$backend_binary" "$native_target_dir/codex-record-replay-linux"
chmod 0755 "$native_target_dir/codex-record-replay-linux"

stage_record_replay_plugin_base "$target_plugin" "$plugin_template"
patch_record_replay_plugin_for_linux "$target_plugin"
cp "$backend_binary" "$target_plugin/bin/codex-record-replay-linux"
chmod 0755 "$target_plugin/bin/codex-record-replay-linux"
cp "$backend_binary" "$target_plugin/bin/SkyLinuxComputerUseClient"
chmod 0755 "$target_plugin/bin/SkyLinuxComputerUseClient"
use_upstream_record_replay_icon "$target_plugin"
write_record_replay_marketplace_entry "$target_marketplace"

echo "Record & Replay plugin and backend staged" >&2
