#!/bin/bash
# Bundled-plugin staging — Browser Use, Chrome, Linux Computer Use, manifests, marketplace.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

# ---- Install Linux-safe bundled plugin resources ----
find_cargo_for_linux_computer_use() {
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

build_linux_computer_use_backend() {
    local crate_dir="$SCRIPT_DIR/computer-use-linux"
    local backend_binary="$SCRIPT_DIR/target/release/codex-computer-use-linux"
    local cosmic_helper_binary="$SCRIPT_DIR/target/release/codex-computer-use-cosmic"
    local cargo_cmd=""

    if [ ! -d "$crate_dir" ]; then
        warn "Linux Computer Use backend source not found at $crate_dir"
        return 1
    fi

    if ! cargo_cmd="$(find_cargo_for_linux_computer_use)"; then
        warn "cargo not found; Linux Computer Use plugin will be unavailable"
        return 1
    fi

    info "Building Linux Computer Use backend..."
    if ! (cd "$SCRIPT_DIR" && "$cargo_cmd" build --release -p codex-computer-use-linux >&2); then
        warn "Failed to build Linux Computer Use backend"
        return 1
    fi

    [ -x "$backend_binary" ] || {
        warn "Linux Computer Use backend binary missing after build: $backend_binary"
        return 1
    }

    [ -x "$cosmic_helper_binary" ] || {
        warn "Linux Computer Use COSMIC helper binary missing after build: $cosmic_helper_binary"
        return 1
    }

    printf '%s\n%s\n' "$backend_binary" "$cosmic_helper_binary"
}

stage_linux_computer_use_plugin() {
    local target_plugins="$1"
    local plugin_template="$SCRIPT_DIR/plugins/openai-bundled/plugins/computer-use"
    local build_outputs=""
    local backend_binary=""
    local cosmic_helper_binary=""
    local target_plugin="$target_plugins/computer-use"

    if [ ! -d "$plugin_template" ]; then
        warn "Linux Computer Use plugin template not found at $plugin_template"
        return 1
    fi

    if ! build_outputs="$(build_linux_computer_use_backend)"; then
        return 1
    fi
    backend_binary="$(printf '%s\n' "$build_outputs" | sed -n '1p')"
    cosmic_helper_binary="$(printf '%s\n' "$build_outputs" | sed -n '2p')"

    rm -rf "$target_plugin"
    mkdir -p "$target_plugin"
    cp -R "$plugin_template/." "$target_plugin/"
    mkdir -p "$target_plugin/bin"
    cp "$backend_binary" "$target_plugin/bin/codex-computer-use-linux"
    cp "$cosmic_helper_binary" "$target_plugin/bin/codex-computer-use-cosmic"
    chmod 0755 "$target_plugin/bin/codex-computer-use-linux"
    chmod 0755 "$target_plugin/bin/codex-computer-use-cosmic"

    if [ -f "$ICON_SOURCE" ]; then
        mkdir -p "$target_plugin/assets"
        cp "$ICON_SOURCE" "$target_plugin/assets/app-icon.png"
    fi

    find "$target_plugin" \( -name '*:com.apple.*' -o -name '.gitkeep' \) -delete
    return 0
}

is_host_linux_elf_executable() {
    local file="$1"
    python3 - "$file" "$ARCH" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
arch = sys.argv[2]
expected_machine = {
    "x86_64": 62,
    "aarch64": 183,
    "armv7l": 40,
    "armv6l": 40,
    "armhf": 40,
}.get(arch)
if expected_machine is None:
    sys.exit(1)

try:
    header = path.read_bytes()[:20]
except OSError:
    sys.exit(1)

if len(header) < 20 or header[:4] != b"\x7fELF":
    sys.exit(1)

is_little_endian = header[5] == 1
if not is_little_endian:
    sys.exit(1)

machine = int.from_bytes(header[18:20], "little")
sys.exit(0 if machine == expected_machine else 1)
PY
}

install_linux_executable_resource() {
    local source="$1"
    local destination="$2"
    local label="$3"
    local log_level="${4:-warn}"

    if [ ! -f "$source" ]; then
        if [ "$log_level" = "info" ]; then
            info "Browser Use $label not found in upstream resources; skipping"
        else
            warn "Browser Use $label not found in upstream resources; skipping"
        fi
        return 1
    fi

    if ! is_host_linux_elf_executable "$source"; then
        if [ "$log_level" = "info" ]; then
            info "Browser Use $label is not a Linux executable for $ARCH; skipping"
        else
            warn "Browser Use $label is not a Linux executable for $ARCH; skipping"
        fi
        return 1
    fi

    install -m 0755 "$source" "$destination"
}

browser_use_node_repl_runtime_url() {
    case "$ARCH" in
        x86_64)
            echo "${CODEX_BROWSER_USE_NODE_REPL_RUNTIME_URL:-https://persistent.oaistatic.com/codex-primary-runtime/26.426.12240/codex-primary-runtime-linux-x64-26.426.12240.tar.xz}"
            ;;
        *)
            return 1
            ;;
    esac
}

browser_use_node_repl_runtime_sha256() {
    case "$ARCH" in
        x86_64)
            echo "${CODEX_BROWSER_USE_NODE_REPL_RUNTIME_SHA256:-db5624eb6efa36b66ec6f6dd0488cefb966e49636862aab6209a4336c1ca90c4}"
            ;;
        *)
            return 1
            ;;
    esac
}

install_node_repl_from_primary_runtime_archive() {
    local destination="$1"
    local url
    local expected_sha
    local cache_dir
    local archive
    local extract_dir
    local source

    if ! url="$(browser_use_node_repl_runtime_url)"; then
        warn "Browser Use node_repl primary-runtime fallback is unavailable for $ARCH"
        return 1
    fi
    expected_sha="$(browser_use_node_repl_runtime_sha256)"

    cache_dir="${CODEX_BROWSER_USE_RUNTIME_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop/browser-use}"
    archive="$cache_dir/$(basename "$url")"
    extract_dir="$WORK_DIR/browser-use-node-repl-runtime"
    source="$extract_dir/codex-primary-runtime/dependencies/bin/node_repl"

    mkdir -p "$cache_dir" "$extract_dir"
    if [ ! -f "$archive" ]; then
        info "Downloading Browser Use node_repl fallback runtime..."
        if ! curl -L --fail --progress-bar -o "$archive.part" "$url"; then
            rm -f "$archive.part"
            warn "Failed to download Browser Use node_repl fallback runtime"
            return 1
        fi
        mv "$archive.part" "$archive"
    else
        info "Using cached Browser Use node_repl fallback runtime: $archive"
    fi

    if ! printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c - >/dev/null 2>&1; then
        rm -f "$archive"
        warn "Browser Use node_repl fallback runtime checksum mismatch; removed cached archive"
        return 1
    fi

    if ! tar -xJf "$archive" -C "$extract_dir" codex-primary-runtime/dependencies/bin/node_repl; then
        warn "Failed to extract Browser Use node_repl from fallback runtime"
        return 1
    fi

    install_linux_executable_resource "$source" "$destination" "node_repl fallback runtime"
}

install_browser_use_node_repl_resource() {
    local upstream_source="$1"
    local destination="$2"
    local source

    for source in \
        "${CODEX_LINUX_NODE_REPL_SOURCE:-}" \
        "${CODEX_NODE_REPL_PATH:-}"
    do
        [ -n "$source" ] || continue
        if install_linux_executable_resource "$source" "$destination" "node_repl runtime"; then
            return 0
        fi
    done

    source="${XDG_CACHE_HOME:-$HOME/.cache}/codex-runtimes/codex-primary-runtime/dependencies/bin/node_repl"
    if [ -f "$source" ] && install_linux_executable_resource "$source" "$destination" "node_repl runtime"; then
        return 0
    fi

    if [ -n "$upstream_source" ] && install_linux_executable_resource "$upstream_source" "$destination" "node_repl runtime" "info"; then
        return 0
    fi

    install_node_repl_from_primary_runtime_archive "$destination"
}

remove_macos_sidecar_files() {
    local root="$1"
    find "$root" -type f -name '*:com.apple.*' -delete
}

chrome_extension_host_arch() {
    case "$ARCH" in
        x86_64) echo "x64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) return 1 ;;
    esac
}

build_chrome_extension_host() {
    local source_binary="$SCRIPT_DIR/target/release/codex-chrome-extension-host"
    local cargo_cmd=""

    if ! cargo_cmd="$(find_cargo_for_linux_computer_use)"; then
        warn "cargo not found; Chrome extension host will be unavailable"
        return 1
    fi

    info "Building Chrome extension host..."
    if ! (cd "$SCRIPT_DIR" && "$cargo_cmd" build --release -p codex-computer-use-linux --bin codex-chrome-extension-host >&2); then
        warn "Failed to build Chrome extension host"
        return 1
    fi

    if [ ! -x "$source_binary" ]; then
        warn "Chrome extension host binary missing after build: $source_binary"
        return 1
    fi

    printf '%s\n' "$source_binary"
}

install_chrome_extension_host_resource() {
    local target_plugin="$1"
    local source_host=""
    local extension_arch
    local target_host

    if ! extension_arch="$(chrome_extension_host_arch)"; then
        warn "Chrome extension host is unavailable for $ARCH; skipping Chrome plugin"
        return 1
    fi

    if ! source_host="$(build_chrome_extension_host)"; then
        return 1
    fi

    target_host="$target_plugin/extension-host/linux/$extension_arch/extension-host"
    mkdir -p "$(dirname "$target_host")"
    install -m 0755 "$source_host" "$target_host"
}

patch_chrome_plugin_for_linux() {
    local target_plugin="$1"
    local patcher="$SCRIPT_DIR/scripts/lib/patch-chrome-plugin.js"

    if [ ! -f "$patcher" ]; then
        warn "Chrome plugin patch helper not found at $patcher; leaving upstream scripts unchanged"
        return 0
    fi

    if ! node "$patcher" "$target_plugin" >&2; then
        warn "Chrome plugin Linux patch helper failed; leaving upstream scripts as-is"
    fi
}

stage_chrome_plugin_from_upstream() {
    local source_plugin="$1"
    local target_plugins="$2"
    local target_plugin="$target_plugins/chrome"
    local source_manifest="$source_plugin/.codex-plugin/plugin.json"
    local source_client="$source_plugin/scripts/browser-client.mjs"
    local source_install_manifest="$source_plugin/scripts/installManifest.mjs"

    if [ ! -d "$source_plugin" ]; then
        warn "Chrome bundled plugin resources not found in upstream app; skipping Chrome"
        return 1
    fi

    if [ ! -f "$source_manifest" ]; then
        warn "Chrome plugin manifest not found in upstream app; skipping Chrome"
        return 1
    fi

    if [ ! -f "$source_client" ] || [ ! -f "$source_install_manifest" ]; then
        warn "Chrome plugin scripts not found in upstream app; skipping Chrome"
        return 1
    fi

    rm -rf "$target_plugin"
    cp -R "$source_plugin" "$target_plugin"
    remove_macos_sidecar_files "$target_plugin"
    patch_chrome_plugin_for_linux "$target_plugin"
    patch_browser_use_site_status_allowlist_fallback "$target_plugin/scripts/browser-client.mjs"
    if ! install_chrome_extension_host_resource "$target_plugin"; then
        rm -rf "$target_plugin"
        return 1
    fi

    info "Chrome plugin staged from upstream DMG"
    return 0
}

patch_browser_use_site_status_allowlist_fallback() {
    local client="$1"

    if grep -q "codexLinuxSiteStatusAllowlistFallback" "$client"; then
        return 0
    fi

    python3 - "$client" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
pattern = re.compile(
    r'async fetchBlocked\((?P<url>[A-Za-z_$][\w$]*)\)\{'
    r'let (?P<response>[A-Za-z_$][\w$]*)=await (?P<fetch>[A-Za-z_$][\w$]*)'
    r'\((?P=url)\.endpoint,\{method:"GET"\}\);'
    r'if\(!(?P=response)\.ok\)throw new Error\((?P<format>[A-Za-z_$][\w$]*)'
    r'\(`Browser Use cannot determine if \$\{(?P=url)\.displayUrl\} is allowed\. '
    r'Please try again later or use another source\.`\)\);'
    r'let (?P<json>[A-Za-z_$][\w$]*)=await (?P=response)\.json\(\);'
    r'return (?P<status>[A-Za-z_$][\w$]*)\((?P=json)\)\}'
)
match = pattern.search(source)
if match is None:
    print(
        "WARN: Could not find Browser Use site_status allowlist fallback insertion point — leaving browser-client.mjs unchanged",
        file=sys.stderr,
    )
    raise SystemExit(0)

url = match.group("url")
response = match.group("response")
fetch = match.group("fetch")
formatter = match.group("format")
json_value = match.group("json")
status = match.group("status")
error = "__codexLinuxErr"
replacement = (
    f'async fetchBlocked({url}){{let {response};try{{{response}=await {fetch}({url}.endpoint,{{method:"GET"}})}}'
    f'catch({error}){{if(String({url}?.endpoint??"").includes("/aura/site_status")&&'
    f'String({error}?.message??{error}).toLowerCase().includes("allowlist"))return console.warn'
    f'("codexLinuxSiteStatusAllowlistFallback",{url}.endpoint),!1;throw {error}}}'
    f'if(!{response}.ok)throw new Error({formatter}(`Browser Use cannot determine if ${{{url}.displayUrl}} is allowed. '
    f'Please try again later or use another source.`));let {json_value}=await {response}.json();return {status}({json_value})}}'
)
path.write_text(source[:match.start()] + replacement + source[match.end():], encoding="utf-8")
PY
}

stage_browser_use_plugin_from_upstream() {
    local source_plugin="$1"
    local target_plugins="$2"
    local target_plugin="$target_plugins/browser-use"
    local source_client="$source_plugin/scripts/browser-client.mjs"
    local target_client="$target_plugin/scripts/browser-client.mjs"

    if [ ! -d "$source_plugin" ]; then
        warn "Browser Use bundled plugin resources not found in upstream app; skipping Browser Use"
        return 1
    fi

    if [ ! -f "$source_plugin/.codex-plugin/plugin.json" ]; then
        warn "Browser Use plugin manifest not found in upstream app; skipping Browser Use"
        return 1
    fi

    if [ ! -f "$source_client" ]; then
        warn "Browser Use browser-client.mjs not found in upstream app; skipping Browser Use"
        return 1
    fi

    rm -rf "$target_plugin"
    cp -R "$source_plugin" "$target_plugin"
    remove_macos_sidecar_files "$target_plugin"
    patch_browser_use_site_status_allowlist_fallback "$target_client"

    info "Browser Use plugin staged from upstream DMG"
    return 0
}

find_upstream_bundled_plugins_dir() {
    local upstream_resources="$1"
    local candidate

    for candidate in \
        "$upstream_resources/plugins/openai-bundled" \
        "$upstream_resources/plugins/openai-bundled-beta"
    do
        if [ -f "$candidate/.agents/plugins/marketplace.json" ]; then
            echo "$candidate"
            return 0
        fi
    done

    for candidate in "$upstream_resources/plugins"/openai-bundled*; do
        [ -d "$candidate" ] || continue
        if [ -f "$candidate/.agents/plugins/marketplace.json" ]; then
            echo "$candidate"
            return 0
        fi
    done

    return 1
}

write_bundled_plugins_marketplace() {
    local source="$1"
    local destination="$2"
    local include_browser="$3"
    local include_chrome="$4"
    local include_computer_use="$5"

    node - "$source" "$destination" "$include_browser" "$include_chrome" "$include_computer_use" <<'NODE'
const fs = require("fs");
const path = require("path");

const sourcePath = process.argv[2];
const destinationPath = process.argv[3];
const includeBrowser = process.argv[4] === "1";
const includeChrome = process.argv[5] === "1";
const includeComputerUse = process.argv[6] === "1";
const marketplace = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const sourcePlugins = marketplace.plugins || [];
const plugins = [];

if (includeBrowser) {
  const browserUse = sourcePlugins.find((plugin) => plugin.name === "browser-use");
  if (browserUse == null) {
    throw new Error("Bundled marketplace does not contain browser-use plugin");
  }
  plugins.push(browserUse);
}

if (includeChrome) {
  const chrome = sourcePlugins.find((plugin) => plugin.name === "chrome");
  if (chrome == null) {
    throw new Error("Bundled marketplace does not contain chrome plugin");
  }
  plugins.push(chrome);
}

if (includeComputerUse) {
  plugins.push({
    name: "computer-use",
    source: {
      source: "local",
      path: "./plugins/computer-use",
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  });
}

marketplace.plugins = plugins;
fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
fs.writeFileSync(destinationPath, `${JSON.stringify(marketplace, null, 2)}\n`);
NODE
}

install_bundled_plugin_resources() {
    local app_dir="$1"
    local upstream_resources="$app_dir/Contents/Resources"
    local source_bundled_plugins_dir=""
    local source_marketplace=""
    local source_browser_plugin=""
    local source_chrome_plugin=""
    local resources_dir="$INSTALL_DIR/resources"
    local marketplace_name=""
    local bundled_plugins_dir=""
    local include_browser=0
    local include_chrome=0
    local include_computer_use=0

    if ! source_bundled_plugins_dir="$(find_upstream_bundled_plugins_dir "$upstream_resources")"; then
        warn "Bundled plugin marketplace not found in upstream app; skipping bundled plugins"
        return 0
    fi
    marketplace_name="$(basename "$source_bundled_plugins_dir")"
    source_marketplace="$source_bundled_plugins_dir/.agents/plugins/marketplace.json"
    source_browser_plugin="$source_bundled_plugins_dir/plugins/browser-use"
    source_chrome_plugin="$source_bundled_plugins_dir/plugins/chrome"
    bundled_plugins_dir="$resources_dir/plugins/$marketplace_name"

    mkdir -p "$bundled_plugins_dir/plugins" "$bundled_plugins_dir/.agents/plugins"

    if stage_browser_use_plugin_from_upstream "$source_browser_plugin" "$bundled_plugins_dir/plugins"; then
        include_browser=1
    fi

    if stage_chrome_plugin_from_upstream "$source_chrome_plugin" "$bundled_plugins_dir/plugins"; then
        include_chrome=1
    fi

    if stage_linux_computer_use_plugin "$bundled_plugins_dir/plugins"; then
        include_computer_use=1
    else
        warn "Linux Computer Use plugin will be unavailable"
    fi

    if [ "$include_browser" -eq 0 ] && [ "$include_chrome" -eq 0 ] && [ "$include_computer_use" -eq 0 ]; then
        warn "No Linux-safe bundled plugins were staged"
        return 0
    fi

    write_bundled_plugins_marketplace "$source_marketplace" "$bundled_plugins_dir/.agents/plugins/marketplace.json" "$include_browser" "$include_chrome" "$include_computer_use"

    install_linux_executable_resource "$upstream_resources/node" "$resources_dir/node" "node runtime" "info" || true
    install_browser_use_node_repl_resource "$upstream_resources/node_repl" "$resources_dir/node_repl" || true

    info "Linux-safe bundled plugins installed"
}
