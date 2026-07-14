#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

normalize_host_tool_path() {
    local entry
    local normalized=""
    local -a entries=()

    IFS=: read -r -a entries <<< "${PATH-}"
    for entry in "${entries[@]}"; do
        [[ "$entry" == /* ]] || continue
        case ":$normalized:" in
            *":$entry:"*) continue ;;
        esac
        normalized="${normalized:+$normalized:}$entry"
    done

    [ -n "$normalized" ] || {
        printf '%s\n' "No absolute tool directories found in PATH" >&2
        return 1
    }
    printf '%s\n' "$normalized"
}

# Keep host tools available to portable fixtures without inheriting empty or
# relative PATH entries that could resolve executables from the worktree.
HOST_TOOL_PATH="$(normalize_host_tool_path)"
BASH_BIN="$(PATH="$HOST_TOOL_PATH" type -P bash)"
TRUE_BIN="$(PATH="$HOST_TOOL_PATH" type -P true)"
[ -x "$BASH_BIN" ] || {
    printf '%s\n' "Could not resolve executable Bash from absolute PATH entries" >&2
    exit 1
}
[ -x "$TRUE_BIN" ] || {
    printf '%s\n' "Could not resolve executable true from absolute PATH entries" >&2
    exit 1
}
TMP_DIR="$(mktemp -d)"

export CODEX_LINUX_FEATURES_CONFIG="$REPO_DIR/linux-features/features.example.json"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

info() {
    echo "[smoke] $*" >&2
}

fail() {
    echo "[smoke][FAIL] $*" >&2
    exit 1
}

assert_file_exists() {
    local path="$1"
    [ -f "$path" ] || fail "Expected file to exist: $path"
}

assert_file_not_exists() {
    local path="$1"
    [ ! -e "$path" ] || fail "Expected file not to exist: $path"
}

assert_mode() {
    local path="$1"
    local expected="$2"
    local actual
    actual="$(python3 - "$path" <<'PY'
import os
import sys

print(format(os.lstat(sys.argv[1]).st_mode & 0o777, "o"))
PY
)"
    [ "$actual" = "$expected" ] || fail "Expected mode $expected for $path, got $actual"
}

assert_contains() {
    local path="$1"
    local pattern="$2"
    grep -q -- "$pattern" "$path" || fail "Expected '$pattern' in $path"
}

assert_not_contains() {
    local path="$1"
    local pattern="$2"
    if grep -q -- "$pattern" "$path"; then
        fail "Did not expect '$pattern' in $path"
    fi
}

assert_occurrence_count() {
    local path="$1"
    local pattern="$2"
    local expected="$3"
    local actual
    actual="$(grep -o -- "$pattern" "$path" | wc -l | tr -d ' ')"
    [ "$actual" = "$expected" ] || fail "Expected '$pattern' to appear $expected times in $path, found $actual"
}

assert_json_enabled_equals() {
    local path="$1"
    local expected_json="$2"
    node - "$path" "$expected_json" <<'NODE' || fail "Expected $path enabled list to equal $expected_json"
const fs = require("node:fs");
const path = process.argv[2];
const expected = JSON.parse(process.argv[3]);
const actual = JSON.parse(fs.readFileSync(path, "utf8")).enabled;
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  process.exit(1);
}
NODE
}

make_wizard_feature_root() {
    local features_root="$1"
    mkdir -p \
        "$features_root/conversation-mode" \
        "$features_root/example-feature" \
        "$features_root/read-aloud" \
        "$features_root/read-aloud-mcp" \
        "$features_root/remote-mobile-control"
    printf '%s\n' '{"enabled":[]}' > "$features_root/features.example.json"
    cat > "$features_root/conversation-mode/feature.json" <<'JSON'
{"id":"conversation-mode","name":"Conversation mode","description":"Voice conversation loop."}
JSON
    printf '%s\n' '# Conversation Mode' > "$features_root/conversation-mode/README.md"
    cat > "$features_root/example-feature/feature.json" <<'JSON'
{"id":"example-feature","title":"Example Linux Feature","description":"Developer sample."}
JSON
    printf '%s\n' '# Example Linux Feature' > "$features_root/example-feature/README.md"
    cat > "$features_root/read-aloud/feature.json" <<'JSON'
{"id":"read-aloud","name":"Read aloud","description":"Read assistant responses aloud."}
JSON
    printf '%s\n' '# Read Aloud' > "$features_root/read-aloud/README.md"
    cat > "$features_root/read-aloud-mcp/feature.json" <<'JSON'
{"id":"read-aloud-mcp","title":"Read Aloud MCP","description":"Read Aloud MCP plugin staging."}
JSON
    printf '%s\n' '# Read Aloud MCP' > "$features_root/read-aloud-mcp/README.md"
    cat > "$features_root/remote-mobile-control/feature.json" <<'JSON'
{"id":"remote-mobile-control","title":"Experimental Remote Mobile Control","description":"Mobile host enrollment patches."}
JSON
    printf '%s\n' '# Remote Mobile Control' > "$features_root/remote-mobile-control/README.md"
}

make_fake_browser_upstream_app() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"
    mkdir -p \
        "$resources_dir/plugins/openai-bundled/.agents/plugins" \
        "$resources_dir/plugins/openai-bundled/plugins/browser/.codex-plugin" \
        "$resources_dir/plugins/openai-bundled/plugins/browser/scripts"
    cat > "$resources_dir/plugins/openai-bundled/.agents/plugins/marketplace.json" <<'JSON'
{"plugins":[{"name":"browser","source":{"source":"local","path":"./plugins/browser"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Engineering"}]}
JSON
    cat > "$resources_dir/plugins/openai-bundled/plugins/browser/.codex-plugin/plugin.json" <<'JSON'
{"name":"browser","version":"0.1.0-alpha2","interface":{"category":"Engineering"}}
JSON
    cat > "$resources_dir/plugins/openai-bundled/plugins/browser/scripts/browser-client.mjs" <<'JS'
function lu(e){let t=globalThis.nodeRepl?.env[e];return typeof t=="string"?t:void 0}function th(){let e=import.meta.__codexNativePipe;return e==null||typeof e.createConnection!="function"?null:e}var I2=new Set(["about:blank"]);function Gb(e){if(I2.has(e))return!0;let t;try{t=new URL(e)}catch{return!1}return t.protocol==="http:"||t.protocol==="https:"}class Uf{async fetchBlocked(e){let r=await bS(e.endpoint,{method:"GET"});if(!r.ok)throw new Error(ae(`Browser Use cannot determine if ${e.displayUrl} is allowed. Please try again later or use another source.`));let n=await r.json();return TF(n)}}var Cb=kE(hV.platform()),EV=()=>_P()==="win32"?TV():CV(),CV=async()=>(await yP(Cb)).map(e=>wP.resolve(Cb,e)),TV=async()=>[];export function setupAtlasRuntime() {}
JS
}

make_fake_portable_plugins_upstream_app() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"
    local plugins_dir="$resources_dir/plugins/openai-bundled/plugins"

    mkdir -p \
        "$resources_dir/plugins/openai-bundled/.agents/plugins" \
        "$plugins_dir/sites/.codex-plugin" \
        "$plugins_dir/sites/scripts" \
        "$plugins_dir/sites/mcp" \
        "$plugins_dir/deep-research/.codex-plugin" \
        "$plugins_dir/deep-research/skills/deep-research" \
        "$plugins_dir/visualize/.codex-plugin" \
        "$plugins_dir/visualize/skills/visualize/scripts" \
        "$plugins_dir/latex/.codex-plugin" \
        "$plugins_dir/latex/bin" \
        "$plugins_dir/record-and-replay/.codex-plugin" \
        "$plugins_dir/record-and-replay/Codex Computer Use.app"

    cat > "$resources_dir/plugins/openai-bundled/.agents/plugins/marketplace.json" <<'JSON'
{"plugins":[{"name":"sites","source":{"source":"local","path":"./plugins/sites"},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"},{"name":"record-and-replay","source":{"source":"local","path":"./plugins/record-and-replay"},"policy":{"installation":"AVAILABLE"}},{"name":"latex","source":{"source":"local","path":"./plugins/latex"},"policy":{"installation":"AVAILABLE"}},{"name":"deep-research","source":{"source":"local","path":"./plugins/deep-research"},"policy":{"installation":"AVAILABLE"},"category":"Research"},{"name":"visualize","source":{"source":"local","path":"./plugins/visualize"},"policy":{"installation":"AVAILABLE"},"category":"Productivity"}]}
JSON
    printf '%s\n' '{"name":"sites","version":"1.0.0","mcpServers":"./.mcp.json"}' > "$plugins_dir/sites/.codex-plugin/plugin.json"
    printf '%s\n' "#!$BASH_BIN" 'set -euo pipefail' > "$plugins_dir/sites/scripts/init-site.sh"
    chmod 0755 "$plugins_dir/sites/scripts/init-site.sh"
    printf '%s\n' 'console.log("sites");' > "$plugins_dir/sites/mcp/server.mjs"
    printf '%s\n' '{"name":"deep-research","version":"1.0.0"}' > "$plugins_dir/deep-research/.codex-plugin/plugin.json"
    printf '%s\n' '# Deep Research' > "$plugins_dir/deep-research/skills/deep-research/SKILL.md"
    printf '%s\n' '{"name":"visualize","version":"1.0.0"}' > "$plugins_dir/visualize/.codex-plugin/plugin.json"
    printf '%s\n' 'print("visualize")' > "$plugins_dir/visualize/skills/visualize/scripts/render.py"
    printf '%s\n' '{"name":"latex","version":"1.0.0"}' > "$plugins_dir/latex/.codex-plugin/plugin.json"
    printf '\xcf\xfa\xed\xfe' > "$plugins_dir/latex/bin/tectonic"
    chmod 0755 "$plugins_dir/latex/bin/tectonic"
    printf '%s\n' '{"name":"record-and-replay","version":"1.0.0"}' > "$plugins_dir/record-and-replay/.codex-plugin/plugin.json"
}

make_fake_app() {
    local app_dir="$1"
    bash "$REPO_DIR/tests/fixtures/create-packaged-app-fixture.sh" "$app_dir"
}

make_stub_bin_dir() {
    local bin_dir="$1"
    mkdir -p "$bin_dir"
}

test_extract_webview_replaces_linux_icon_assets() {
    info "Checking webview extraction applies the Linux icon asset"
    local workspace="$TMP_DIR/webview-icon"
    local install_dir="$workspace/install"
    local work_dir="$workspace/work"
    local icon_source="$workspace/codex-linux.png"
    local assets_dir="$install_dir/content/webview/assets"
    local output_log="$workspace/output.log"

    mkdir -p "$work_dir/app-extracted/webview/assets" "$install_dir"
    printf '%s\n' 'linux-icon' > "$icon_source"
    printf '%s\n' 'upstream-main' > "$work_dir/app-extracted/webview/assets/app-main.png"
    printf '%s\n' 'upstream-alt' > "$work_dir/app-extracted/webview/assets/app-alt.png"
    printf '%s\n' '<style>--startup-background: transparent</style>' > "$work_dir/app-extracted/webview/index.html"

    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        WORK_DIR="$work_dir"
        ICON_SOURCE="$icon_source"
        CODEX_LINUX_ICON_SOURCE="$icon_source"
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/webview-install.sh"
        extract_webview "$workspace/Codex.app"
    ) >"$output_log" 2>&1

    assert_file_exists "$assets_dir/app-main.png"
    assert_file_exists "$assets_dir/app-alt.png"
    cmp -s "$icon_source" "$assets_dir/app-main.png" \
        || fail "Expected extracted app-main.png to be replaced with the Linux icon"
    cmp -s "$icon_source" "$assets_dir/app-alt.png" \
        || fail "Expected extracted app-alt.png to be replaced with the Linux icon"
    assert_contains "$install_dir/content/webview/index.html" "--startup-background: #1e1e1e"
    assert_contains "$output_log" "Linux app icon applied to 2 webview asset(s)"
}

test_installer_prefers_compact_upstream_chatgpt_icon() {
    info "Checking installer prefers the compact upstream ChatGPT icon"
    local workspace="$TMP_DIR/chatgpt-icon-selection"
    local work_dir="$workspace/work"
    local app_dir="$workspace/ChatGPT.app"
    local compact_icon="$work_dir/app-extracted/webview/assets/referral-modal-chatgpt-blossom-test.png"
    local full_size_icon="$app_dir/Contents/Resources/icon-chatgpt.png"
    local selection_file="$workspace/selection.txt"

    mkdir -p "$(dirname "$compact_icon")" "$(dirname "$full_size_icon")"
    cp "$REPO_DIR/assets/codex-linux.png" "$compact_icon"
    printf '%s\n' full-size > "$full_size_icon"

    (
        export CODEX_INSTALLER_SOURCE_ONLY=1
        # shellcheck disable=SC1091
        source "$REPO_DIR/install.sh"
        WORK_DIR="$work_dir"
        LINUX_ICON_SOURCE=""
        select_linux_icon_source
        printf '%s\n' "$LINUX_ICON_SOURCE" > "$selection_file"
    )

    [ "$(cat "$selection_file")" = "$compact_icon" ] \
        || fail "Expected compact upstream ChatGPT icon to win over the full-size resource icon"

    rm -f "$compact_icon"
    (
        export CODEX_INSTALLER_SOURCE_ONLY=1
        # shellcheck disable=SC1091
        source "$REPO_DIR/install.sh"
        WORK_DIR="$work_dir"
        LINUX_ICON_SOURCE=""
        select_linux_icon_source
        printf '%s\n' "$LINUX_ICON_SOURCE" > "$selection_file"
    )

    [ "$(cat "$selection_file")" = "$REPO_DIR/assets/codex-linux.png" ] \
        || fail "Expected a missing compact ChatGPT icon to avoid the oversized upstream app icon"

    mkdir -p "$(dirname "$compact_icon")"
    cp "$REPO_DIR/assets/codex-linux.png" "$compact_icon"
    python3 - "$compact_icon" <<'PY'
import struct
import sys

with open(sys.argv[1], "r+b") as icon_file:
    icon_file.seek(16)
    icon_file.write(struct.pack(">II", 2048, 2048))
PY
    (
        export CODEX_INSTALLER_SOURCE_ONLY=1
        # shellcheck disable=SC1091
        source "$REPO_DIR/install.sh"
        WORK_DIR="$work_dir"
        LINUX_ICON_SOURCE=""
        select_linux_icon_source
        printf '%s\n' "$LINUX_ICON_SOURCE" > "$selection_file"
    )

    [ "$(cat "$selection_file")" = "$REPO_DIR/assets/codex-linux.png" ] \
        || fail "Expected an oversized upstream ChatGPT icon to fall back safely"
}

test_user_local_icon_prefers_generated_app_icon() {
    info "Checking user-local integration reuses the generated ChatGPT icon"
    local workspace="$TMP_DIR/user-local-chatgpt-icon"
    local home_dir="$workspace/home"
    local generated_icon="$home_dir/.local/opt/codex-desktop-linux/codex-app/.codex-linux/codex-desktop.png"

    mkdir -p "$(dirname "$generated_icon")"
    printf '%s\n' 'generated-chatgpt-icon' > "$generated_icon"

    (
        HOME="$home_dir"
        XDG_DATA_HOME="$home_dir/.local/share"
        XDG_STATE_HOME="$home_dir/.local/state"
        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"
        extract_icon
        cmp -s "$generated_icon" "$ICON_PATH"
    ) || fail "Expected user-local integration to reuse the generated ChatGPT icon"
}

test_extract_webview_requires_entrypoint() {
    info "Checking webview extraction rejects incomplete upstream assets"
    local workspace="$TMP_DIR/webview-required-entrypoint"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace/missing-dir/work/app-extracted" \
        "$workspace/missing-dir/install" \
        "$workspace/missing-index/work/app-extracted/webview/assets" \
        "$workspace/missing-index/install"
    printf '%s\n' 'asset' > "$workspace/missing-index/work/app-extracted/webview/assets/app-main.png"

    set +e
    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$workspace/missing-dir/install"
        WORK_DIR="$workspace/missing-dir/work"
        ICON_SOURCE="$workspace/icon.png"
        CODEX_LINUX_ICON_SOURCE="$workspace/icon.png"
        error() { echo "[ERROR] $*" >&2; exit 1; }
        warn() { echo "[WARN] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/webview-install.sh"
        extract_webview "$workspace/Codex.app"
    ) >"$output_log" 2>&1
    local rc=$?
    set -e
    [ "$rc" -ne 0 ] || fail "extract_webview should fail when upstream webview directory is missing"
    assert_contains "$output_log" "Webview directory not found"

    set +e
    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$workspace/missing-index/install"
        WORK_DIR="$workspace/missing-index/work"
        ICON_SOURCE="$workspace/icon.png"
        CODEX_LINUX_ICON_SOURCE="$workspace/icon.png"
        error() { echo "[ERROR] $*" >&2; exit 1; }
        warn() { echo "[WARN] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/webview-install.sh"
        extract_webview "$workspace/Codex.app"
    ) >"$output_log" 2>&1
    rc=$?
    set -e
    [ "$rc" -ne 0 ] || fail "extract_webview should fail when upstream webview/index.html is missing"
    assert_contains "$output_log" "Missing webview entrypoint"
}

test_common_helper_sourcing() {
    info "Checking shared packaging helpers"
    local probe_file="$TMP_DIR/probe.txt"
    touch "$probe_file"

    # shellcheck disable=SC1091
    source "$REPO_DIR/scripts/lib/package-common.sh"
    ensure_file_exists "$probe_file" "probe file"
}

test_package_icon_source_resolution() {
    info "Checking shared package icon source resolution"
    local workspace="$TMP_DIR/package-icon-source"
    local app_dir="$workspace/app"
    local generated_icon="$app_dir/.codex-linux/codex-desktop.png"
    local explicit_icon="$workspace/explicit.png"

    mkdir -p "$(dirname "$generated_icon")"
    printf '%s\n' 'generated-chatgpt-icon' > "$generated_icon"
    printf '%s\n' 'explicit-chatgpt-icon' > "$explicit_icon"

    # shellcheck disable=SC1091
    source "$REPO_DIR/scripts/lib/package-common.sh"
    APP_DIR="$app_dir"
    PACKAGE_NAME="side-by-side-chatgpt"
    PACKAGE_ICON_SOURCE=""
    [ "$(resolve_package_icon_source)" = "$generated_icon" ] \
        || fail "Expected a unique generated app icon to survive a custom package name"

    PACKAGE_ICON_SOURCE="$explicit_icon"
    [ "$(resolve_package_icon_source)" = "$explicit_icon" ] \
        || fail "Expected PACKAGE_ICON_SOURCE to take precedence"
}

test_package_layout_requires_webview_entrypoint() {
    info "Checking package helpers reject an app without webview/index.html"
    local workspace="$TMP_DIR/package-webview-entrypoint"
    local app_dir="$workspace/app"
    local output_log="$workspace/output.log"

    mkdir -p "$app_dir/content/webview"
    printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$app_dir/start.sh"
    chmod +x "$app_dir/start.sh"

    set +e
    (
        APP_DIR="$app_dir"
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/package-common.sh"
        ensure_app_layout
    ) >"$output_log" 2>&1
    local rc=$?
    set -e

    [ "$rc" -ne 0 ] || fail "ensure_app_layout should fail when webview/index.html is missing"
    assert_contains "$output_log" "Missing webview entrypoint"
}

test_package_payload_permission_normalization() {
    info "Checking package payload permission normalization"
    local root="$TMP_DIR/package-permissions"
    local app_root="$root/opt/codex-desktop"
    local private_file="$app_root/.codex-linux/features/private/secret.txt"

    mkdir -p "$app_root/content/webview" "$root/usr/bin" "$(dirname "$private_file")"
    printf '%s\n' "#!$BASH_BIN" 'echo start' > "$app_root/start.sh"
    printf '%s\n' '<!doctype html>' > "$app_root/content/webview/index.html"
    printf '%s\n' "#!$BASH_BIN" 'exec /opt/codex-desktop/start.sh "$@"' > "$root/usr/bin/codex-desktop"
    printf '%s\n' 'secret' > "$private_file"
    cat > "$app_root/.codex-linux/linux-features-staged.json" <<'JSON'
{
  "version": 1,
  "resources": [
    {
      "id": "private",
      "type": "resource",
      "target": ".codex-linux/features/private/secret.txt",
      "mode": "0600"
    }
  ],
  "runtimeHooks": []
}
JSON
    chmod 0700 "$root/opt" "$app_root" "$app_root/content" "$app_root/content/webview"
    chmod 0700 "$app_root/start.sh" "$root/usr/bin/codex-desktop"
    chmod 0600 "$app_root/content/webview/index.html" "$private_file"

    # shellcheck disable=SC1091
    source "$REPO_DIR/scripts/lib/package-common.sh"
    normalize_package_payload_permissions "$root"
    PACKAGE_NAME="codex-desktop" restore_linux_feature_payload_permissions "$root"

    assert_mode "$app_root" "755"
    assert_mode "$app_root/content/webview" "755"
    assert_mode "$app_root/start.sh" "755"
    assert_mode "$root/usr/bin/codex-desktop" "755"
    assert_mode "$app_root/content/webview/index.html" "644"
    assert_mode "$private_file" "600"
}

test_stage_common_package_files_resolves_tray_icon_deterministically() {
    info "Checking stage_common_package_files tray icon resolution"
    local workspace="$TMP_DIR/package-common-tray"
    local app_dir="$workspace/app"
    local root="$workspace/root"
    local output_log="$workspace/output.log"
    local icon_source="$workspace/icon-source.png"
    local tray_output="$root/opt/codex-desktop/.codex-linux/codex-desktop-tray.png"
    local package_icon="$root/opt/codex-desktop/.codex-linux/codex-desktop.png"

    mkdir -p "$workspace" "$root"
    make_fake_app "$app_dir"
    mkdir -p "$app_dir/content/webview/assets"
    printf '%s\n' 'package-icon' > "$icon_source"
    printf '%s\n' 'upstream-tray' > "$app_dir/content/webview/assets/app-main.png"

    (
        export APP_DIR="$app_dir"
        export PACKAGE_NAME="codex-desktop"
        export PACKAGE_WITH_UPDATER=0
        export ICON_SOURCE="$icon_source"
        export DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/codex-desktop.desktop"
        export PACKAGED_RUNTIME_SOURCE="$REPO_DIR/packaging/linux/codex-packaged-runtime.sh"
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/package-common.sh"
        stage_common_package_files "$root"
    ) >"$output_log" 2>&1

    assert_file_exists "$package_icon"
    assert_file_exists "$tray_output"
    cmp -s "$icon_source" "$package_icon" || fail "Expected package icon copy to come from ICON_SOURCE"
    cmp -s "$app_dir/content/webview/assets/app-main.png" "$tray_output" \
        || fail "Expected tray icon copy to come from the unique upstream asset"
    assert_not_contains "$output_log" "falling back to package icon"
}

test_stage_common_package_files_tray_icon_fallbacks_when_ambiguous_or_missing() {
    info "Checking stage_common_package_files tray icon fallback behavior"
    local workspace="$TMP_DIR/package-common-tray-fallback"
    local icon_source="$workspace/icon-source.png"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    printf '%s\n' 'package-icon' > "$icon_source"

    for scenario in ambiguous missing; do
        local app_dir="$workspace/$scenario-app"
        local root="$workspace/$scenario-root"
        local tray_output="$root/opt/codex-desktop/.codex-linux/codex-desktop-tray.png"

        mkdir -p "$root"
        make_fake_app "$app_dir"
        mkdir -p "$app_dir/content/webview/assets"
        if [ "$scenario" = "ambiguous" ]; then
            printf '%s\n' 'upstream-a' > "$app_dir/content/webview/assets/app-alpha.png"
            printf '%s\n' 'upstream-b' > "$app_dir/content/webview/assets/app-beta.png"
        fi

        (
            export APP_DIR="$app_dir"
            export PACKAGE_NAME="codex-desktop"
            export PACKAGE_WITH_UPDATER=0
            export ICON_SOURCE="$icon_source"
            export DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/codex-desktop.desktop"
            export PACKAGED_RUNTIME_SOURCE="$REPO_DIR/packaging/linux/codex-packaged-runtime.sh"
            # shellcheck disable=SC1091
            source "$REPO_DIR/scripts/lib/package-common.sh"
            stage_common_package_files "$root"
        ) >>"$output_log" 2>&1

        assert_file_exists "$tray_output"
        cmp -s "$icon_source" "$tray_output" \
            || fail "Expected tray icon fallback to come from ICON_SOURCE for $scenario"
    done

    assert_contains "$output_log" "Multiple tray icon candidates found"
    assert_contains "$output_log" "Could not resolve a unique tray icon"
}

test_deb_builder_smoke() {
    info "Running Debian packaging smoke test"
    local workspace="$TMP_DIR/deb"
    local bin_dir="$workspace/bin"
    local app_dir="$workspace/app"
    local dist_dir="$workspace/dist"
    local pkg_root="$workspace/deb-root"
    local updater_bin="$workspace/codex-update-manager"
    local capture_dir="$workspace/capture"

    mkdir -p "$workspace" "$dist_dir" "$capture_dir"
    make_stub_bin_dir "$bin_dir"
    make_fake_app "$app_dir"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$updater_bin"
    chmod +x "$updater_bin"

    cat > "$bin_dir/dpkg" <<'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "--print-architecture" ]; then
    echo amd64
    exit 0
fi
exit 0
SCRIPT
    cat > "$bin_dir/dpkg-deb" <<'SCRIPT'
#!/usr/bin/env bash
output="${@: -1}"
printf '%s\n' "$*" > "$CAPTURE_DIR/dpkg-deb-args"
printf '%s\n' "${DPKG_DEB_THREADS_MAX:-}" > "$CAPTURE_DIR/dpkg-deb-threads"
mkdir -p "$(dirname "$output")"
touch "$output"
SCRIPT
    cat > "$bin_dir/cargo" <<'SCRIPT'
#!/usr/bin/env bash
echo "cargo should not be called when UPDATER_BINARY_SOURCE exists" >&2
exit 99
SCRIPT
    chmod +x "$bin_dir/dpkg" "$bin_dir/dpkg-deb" "$bin_dir/cargo"

    PATH="$bin_dir:$PATH" \
    APP_DIR_OVERRIDE="$app_dir" \
    PKG_ROOT_OVERRIDE="$pkg_root" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    CAPTURE_DIR="$capture_dir" \
    UPDATER_BINARY_SOURCE="$updater_bin" \
    MAX_BUILD_THREADS=6 \
    PACKAGE_VERSION="2026.03.24.120000+deadbeef" \
    bash "$REPO_DIR/scripts/build-deb.sh"

    assert_file_exists "$dist_dir/codex-desktop_2026.03.24.120000+deadbeef_amd64.deb"
    [ "$(cat "$capture_dir/dpkg-deb-threads")" = "6" ] \
        || fail "Expected MAX_BUILD_THREADS to reach dpkg-deb"
    assert_file_exists "$pkg_root/DEBIAN/postinst"
    assert_file_exists "$pkg_root/DEBIAN/prerm"
    assert_contains "$pkg_root/DEBIAN/postinst" "codex_ensure_user_service_running"
    assert_contains "$pkg_root/DEBIAN/postinst" "codex_start_enabled_user_service"
    assert_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "Name=New Window"
    assert_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "Name=Check for Updates"
    assert_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "Name=Install Ready Update"
    assert_file_exists "$pkg_root/DEBIAN/postrm"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/package-common.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/patch-chrome-plugin.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/patch-browser-client-iab-socket-scope.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/node-runtime.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/upstream-dmg-intel.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/upstream-dmg-acceptance.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/candidate-promotion.py"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/validate-upstream-dmg.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/linux-update-bridge-patch.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/patch-report.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/rebuild-report.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/build-info.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/build-info.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/linux-features.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/linux-features.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/notification-actions.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/lib/linux-target-context.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/descriptor.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/engine.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/runner.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/lib/assets.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/lib/minified-js.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/lib/settings-keys.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/impl/webview/index.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/core/all-linux/main-process/lifecycle/patch.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/core/all-linux/webview/theme-and-sunset/patch.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/core/distro/nixos/README.md"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/core/desktop/i3/README.md"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/scripts/patches/core/package/deb/README.md"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/linux-features/README.md"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/linux-features/example-feature/feature.json"
    assert_file_not_exists "$pkg_root/opt/codex-desktop/update-builder/linux-features/features.json"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/node-runtime/bin/node"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/Cargo.toml"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/CHANGELOG.md"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/launcher/cli-launch-path.py"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/computer-use-linux/Cargo.toml"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/notification-actions-linux/Cargo.toml"
    assert_file_not_exists "$pkg_root/opt/codex-desktop/update-builder/global-dictation-linux/Cargo.toml"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/read-aloud-linux/Cargo.toml"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/updater/Cargo.toml"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/plugins/openai-bundled/plugins/computer-use/.mcp.json"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/plugins/openai-bundled/plugins/read-aloud/.mcp.json"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/.codex-linux/source-info.json"
    node "$pkg_root/opt/codex-desktop/update-builder/scripts/patch-linux-window-ui.js" --help \
        >"$workspace/update-builder-patcher-help.txt"
    assert_contains "$workspace/update-builder-patcher-help.txt" "Usage: patch-linux-window-ui.js"
    assert_file_exists "$pkg_root/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/.codex-linux/cli-launch-path.py"
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh" "is-enabled codex-update-manager.service"
    assert_not_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh" "enable --now codex-update-manager.service"
    assert_file_exists "$pkg_root/opt/codex-desktop/.codex-linux/codex-desktop-entry-doctor.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/update-builder/packaging/linux/codex-desktop-entry-doctor.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/resources/node-runtime/bin/node"
}

test_deb_builder_rebuilds_deleted_updater_source() {
    info "Checking package builder recovers from deleted updater binary source"
    local workspace="$TMP_DIR/deb-deleted-updater-source"
    local bin_dir="$workspace/bin"
    local app_dir="$workspace/app"
    local dist_dir="$workspace/dist"
    local pkg_root="$workspace/deb-root"
    local cargo_target_dir="$workspace/cargo-target"

    mkdir -p "$workspace" "$dist_dir"
    make_stub_bin_dir "$bin_dir"
    make_fake_app "$app_dir"

    cat > "$bin_dir/dpkg" <<'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "--print-architecture" ]; then
    echo amd64
    exit 0
fi
exit 0
SCRIPT
    cat > "$bin_dir/dpkg-deb" <<'SCRIPT'
#!/usr/bin/env bash
output="${@: -1}"
mkdir -p "$(dirname "$output")"
touch "$output"
SCRIPT
    cat > "$bin_dir/cargo" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
target_dir="${CARGO_TARGET_DIR:-target}"
mkdir -p "$target_dir/release"
cat > "$target_dir/release/codex-update-manager" <<'BIN'
#!/usr/bin/env bash
echo rebuilt updater
BIN
chmod +x "$target_dir/release/codex-update-manager"
SCRIPT
    chmod +x "$bin_dir/dpkg" "$bin_dir/dpkg-deb" "$bin_dir/cargo"

    PATH="$bin_dir:$PATH" \
    APP_DIR_OVERRIDE="$app_dir" \
    PKG_ROOT_OVERRIDE="$pkg_root" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    CARGO_TARGET_DIR="$cargo_target_dir" \
    UPDATER_BINARY_SOURCE="$workspace/codex-update-manager (deleted)" \
    PACKAGE_VERSION="2026.03.24.120000+rebuilt" \
    bash "$REPO_DIR/scripts/build-deb.sh"

    assert_file_exists "$dist_dir/codex-desktop_2026.03.24.120000+rebuilt_amd64.deb"
    assert_file_exists "$pkg_root/usr/bin/codex-update-manager"
    assert_contains "$pkg_root/usr/bin/codex-update-manager" "rebuilt updater"
}

test_update_builder_preserves_enabled_linux_features_config() {
    info "Checking update-builder preserves sanitized enabled Linux feature config"
    local workspace="$TMP_DIR/update-builder-linux-features"
    local root="$workspace/root"
    local app_dir="$workspace/app"
    local features_root="$workspace/linux-features"
    local feature_config="$workspace/features.json"
    local staged_config="$root/opt/codex-desktop/update-builder/linux-features/features.json"
    local staged_local_manifest="$root/opt/codex-desktop/update-builder/linux-features/local/local-tool/feature.json"
    local source_info="$root/opt/codex-desktop/update-builder/.codex-linux/source-info.json"
    local update_builder_manifest="$root/opt/codex-desktop/update-builder/.codex-linux/update-builder-manifest.txt"
    local global_dictation_target_marker="$REPO_DIR/global-dictation-linux/target/codex-smoke-should-not-stage.txt"

    mkdir -p "$workspace"
    make_fake_app "$app_dir"
    mkdir -p "$features_root/example-feature" "$features_root/global-dictation" "$features_root/local/local-tool"
    mkdir -p "$(dirname "$global_dictation_target_marker")"
    printf '%s\n' "generated build output" > "$global_dictation_target_marker"
    printf '%s\n' '# Linux Features' > "$features_root/README.md"
    printf '%s\n' '{"enabled":[]}' > "$features_root/features.example.json"
    printf '%s\n' '{"id":"example-feature","title":"Example Linux Feature"}' \
        > "$features_root/example-feature/feature.json"
    printf '%s\n' '# Example Linux Feature' > "$features_root/example-feature/README.md"
    printf '%s\n' '{"id":"global-dictation","title":"Global Dictation"}' \
        > "$features_root/global-dictation/feature.json"
    printf '%s\n' '# Global Dictation' > "$features_root/global-dictation/README.md"
    printf '%s\n' '{"id":"local-tool","title":"Local Tool"}' \
        > "$features_root/local/local-tool/feature.json"
    printf '%s\n' '# Local Tool' > "$features_root/local/local-tool/README.md"
    cat > "$feature_config" <<'JSON'
{
  "enabled": [
    "example-feature",
    "global-dictation",
    "local-tool"
  ],
  "settings": {
    "example-feature": {
      "tweaks": {
        "enabled": true
      }
    },
    "disabled-feature": {
      "should": "not be packaged"
    },
    "local-tool": {
      "mode": "local"
    }
  },
  "localComment": "should not be packaged"
}
JSON

    (
        export APP_DIR="$app_dir"
        export PACKAGE_NAME="codex-desktop"
        export UPDATER_SERVICE_SOURCE="$REPO_DIR/packaging/linux/codex-update-manager.service"
        export CODEX_LINUX_FEATURES_ROOT="$features_root"
        export CODEX_LINUX_FEATURES_CONFIG="$feature_config"
        export CODEX_LINUX_SOURCE_REMOTE="https://builder:secret-token@example.com/org/repo.git"
        export SOURCE_DATE_EPOCH="1710000000"

        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/package-common.sh"
        stage_update_builder_bundle "$root"
    )

    assert_file_exists "$staged_config"
    assert_file_exists "$staged_local_manifest"
    assert_file_exists "$update_builder_manifest"
    assert_contains "$staged_config" "example-feature"
    assert_contains "$staged_config" "global-dictation"
    assert_contains "$staged_config" "local-tool"
    assert_contains "$staged_config" "tweaks"
    assert_contains "$staged_config" "mode"
    assert_not_contains "$staged_config" "localComment"
    assert_not_contains "$staged_config" "disabled-feature"
    assert_contains "$update_builder_manifest" "record-replay-linux/Cargo.toml"
    assert_contains "$update_builder_manifest" "notification-actions-linux/Cargo.toml"
    assert_contains "$update_builder_manifest" "global-dictation-linux/Cargo.toml"
    assert_contains "$update_builder_manifest" "assets/codex-linux.png"
    assert_not_contains "$update_builder_manifest" "^node-runtime/"
    assert_not_contains "$update_builder_manifest" "global-dictation-linux/target/"
    assert_file_exists "$root/opt/codex-desktop/update-builder/global-dictation-linux/Cargo.toml"
    assert_file_not_exists "$root/opt/codex-desktop/update-builder/global-dictation-linux/target/codex-smoke-should-not-stage.txt"
    rm -f "$global_dictation_target_marker"

    node - "$staged_config" <<'NODE' || fail "Expected staged Linux features config to be sanitized"
const fs = require("node:fs");
const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const expected = {
  enabled: ["example-feature", "global-dictation", "local-tool"],
  settings: {
    "example-feature": {
      tweaks: {
        enabled: true,
      },
    },
    "local-tool": {
      mode: "local",
    },
  },
};
if (JSON.stringify(config) !== JSON.stringify(expected)) {
  process.exit(1);
}
NODE

    node - "$source_info" <<'NODE' || fail "Expected staged source info to be sanitized and reproducible"
const fs = require("node:fs");
const sourceInfoPath = process.argv[2];
const info = JSON.parse(fs.readFileSync(sourceInfoPath, "utf8"));
if (info.remote !== "https://example.com/org/repo.git") {
  throw new Error(`unexpected remote: ${info.remote}`);
}
if (info.capturedAt !== new Date(1710000000 * 1000).toISOString()) {
  throw new Error(`unexpected capturedAt: ${info.capturedAt}`);
}
NODE
}

test_update_builder_source_info_survives_without_git_checkout() {
    info "Checking update-builder source info survives packaged no-git rebuild layout"
    local workspace="$TMP_DIR/update-builder-source-info"
    local update_builder="$workspace/update-builder"
    local source_info="$update_builder/.codex-linux/source-info.json"

    mkdir -p "$update_builder/.codex-linux" "$update_builder/updater"
    cat > "$update_builder/updater/Cargo.toml" <<'TOML'
[package]
name = "codex-update-manager"
version = "0.8.1"
TOML
    cat > "$source_info" <<'JSON'
{
  "commit": "0123456789012345678901234567890123456789",
  "branch": "main",
  "remote": "https://builder:secret-token@example.com/org/repo.git",
  "provenance": "packaged-update-builder",
  "capturedAt": "2026-05-29T00:00:00.000Z"
}
JSON

    (
        export REPO_DIR="$update_builder"
        export SOURCE_DATE_EPOCH="1710000000"

        # shellcheck disable=SC1091
        source "$SCRIPT_DIR/../scripts/lib/package-common.sh"
        stage_update_builder_source_info "$update_builder"
    )

    node - "$source_info" <<'NODE' || fail "Expected staged source info to preserve installed metadata"
const fs = require("node:fs");
const info = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (info.commit !== "0123456789012345678901234567890123456789") {
  throw new Error(`unexpected commit: ${info.commit}`);
}
if (info.version !== "0.8.1") {
  throw new Error(`unexpected version: ${info.version}`);
}
if (info.remote !== "https://example.com/org/repo.git") {
  throw new Error(`unexpected remote: ${info.remote}`);
}
if (info.recapturedAt !== new Date(1710000000 * 1000).toISOString()) {
  throw new Error(`unexpected recapturedAt: ${info.recapturedAt}`);
}
NODE
}

test_linux_feature_package_hook_discovery_failure_blocks_build() {
    info "Checking Linux feature package hook discovery failure blocks package staging"
    local workspace="$TMP_DIR/package-hook-discovery-failure"
    local root="$workspace/root"
    local app_dir="$workspace/app"
    local features_root="$workspace/linux-features"
    local feature_config="$features_root/features.json"
    local output_log="$workspace/output.log"

    mkdir -p "$root" "$features_root/bad-package-hook"
    make_fake_app "$app_dir"
    printf '%s\n' '{"enabled":[]}' > "$features_root/features.example.json"
    cat > "$features_root/bad-package-hook/feature.json" <<'JSON'
{
  "id": "bad-package-hook",
  "title": "Bad Package Hook",
  "packageHooks": [
    {
      "path": "missing.sh",
      "formats": ["deb"]
    }
  ]
}
JSON
    printf '%s\n' '# Bad Package Hook' > "$features_root/bad-package-hook/README.md"
    printf '%s\n' '{"enabled":["bad-package-hook"]}' > "$feature_config"

    if (
        export APP_DIR="$app_dir"
        export PACKAGE_NAME="codex-desktop"
        export PACKAGE_VERSION="2026.03.24.120000+hookfailure"
        export CODEX_LINUX_FEATURES_ROOT="$features_root"
        export CODEX_LINUX_FEATURES_CONFIG="$feature_config"

        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/package-common.sh"
        run_linux_feature_package_hooks "$root" "deb"
    ) >"$output_log" 2>&1; then
        fail "Expected package hook discovery failure to stop package staging"
    fi

    assert_contains "$output_log" "Failed to discover Linux feature package hooks for deb"
    assert_contains "$output_log" "packageHook 1 not found"
}

test_deb_builder_respects_package_identity() {
    info "Running side-by-side Debian packaging smoke test"
    local workspace="$TMP_DIR/deb-identity"
    local bin_dir="$workspace/bin"
    local app_dir="$workspace/app"
    local dist_dir="$workspace/dist"
    local pkg_root="$workspace/deb-root"
    local updater_bin="$workspace/codex-update-manager"

    mkdir -p "$workspace" "$dist_dir"
    make_stub_bin_dir "$bin_dir"
    make_fake_app "$app_dir"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$updater_bin"
    chmod +x "$updater_bin"

    cat > "$bin_dir/dpkg" <<'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "--print-architecture" ]; then
    echo amd64
    exit 0
fi
exit 0
SCRIPT
    cat > "$bin_dir/dpkg-deb" <<'SCRIPT'
#!/usr/bin/env bash
output="${@: -1}"
mkdir -p "$(dirname "$output")"
touch "$output"
SCRIPT
    cat > "$bin_dir/cargo" <<'SCRIPT'
#!/usr/bin/env bash
echo "cargo should not be called when UPDATER_BINARY_SOURCE exists" >&2
exit 99
SCRIPT
    chmod +x "$bin_dir/dpkg" "$bin_dir/dpkg-deb" "$bin_dir/cargo"

    PATH="$bin_dir:$PATH" \
    APP_DIR_OVERRIDE="$app_dir" \
    PKG_ROOT_OVERRIDE="$pkg_root" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    UPDATER_BINARY_SOURCE="$updater_bin" \
    PACKAGE_NAME="codex-cua-lab" \
    PACKAGE_DISPLAY_NAME="Codex CUA Lab" \
    PACKAGE_VERSION="2026.03.24.120000+deadbeef" \
    bash "$REPO_DIR/scripts/build-deb.sh"

    assert_file_exists "$dist_dir/codex-cua-lab_2026.03.24.120000+deadbeef_amd64.deb"
    assert_file_exists "$pkg_root/usr/bin/codex-cua-lab"
    assert_file_exists "$pkg_root/opt/codex-cua-lab/start.sh"
    assert_contains "$pkg_root/DEBIAN/control" "Package: codex-cua-lab"
    assert_contains "$pkg_root/usr/share/applications/codex-cua-lab.desktop" "Name=Codex CUA Lab"
    assert_contains "$pkg_root/usr/share/applications/codex-cua-lab.desktop" "CHROME_DESKTOP=codex-cua-lab.desktop"
    assert_contains "$pkg_root/usr/share/applications/codex-cua-lab.desktop" "/usr/bin/codex-cua-lab %u"
    assert_contains "$pkg_root/usr/share/applications/codex-cua-lab.desktop" "MimeType=x-scheme-handler/codex;x-scheme-handler/codex-browser-sidebar;"
    assert_contains "$pkg_root/usr/share/applications/codex-cua-lab.desktop" "StartupWMClass=codex-cua-lab"
    assert_contains "$pkg_root/usr/share/applications/codex-cua-lab.desktop" "X-GNOME-WMClass=codex-cua-lab"
    assert_contains "$pkg_root/opt/codex-cua-lab/.codex-linux/codex-packaged-runtime.sh" 'CHROME_DESKTOP="codex-cua-lab.desktop"'
}

test_deb_builder_without_updater() {
    info "Running no-updater Debian packaging smoke test"
    local workspace="$TMP_DIR/deb-no-updater"
    local bin_dir="$workspace/bin"
    local app_dir="$workspace/app"
    local dist_dir="$workspace/dist"
    local pkg_root="$workspace/deb-root"

    mkdir -p "$workspace" "$dist_dir"
    make_stub_bin_dir "$bin_dir"
    make_fake_app "$app_dir"

    cat > "$bin_dir/dpkg" <<'SCRIPT'
#!/usr/bin/env bash
if [ "$1" = "--print-architecture" ]; then
    echo amd64
    exit 0
fi
exit 0
SCRIPT
    cat > "$bin_dir/dpkg-deb" <<'SCRIPT'
#!/usr/bin/env bash
output="${@: -1}"
mkdir -p "$(dirname "$output")"
touch "$output"
SCRIPT
    cat > "$bin_dir/cargo" <<'SCRIPT'
#!/usr/bin/env bash
echo "cargo should not be called when PACKAGE_WITH_UPDATER=0" >&2
exit 99
SCRIPT
    chmod +x "$bin_dir/dpkg" "$bin_dir/dpkg-deb" "$bin_dir/cargo"

    PATH="$bin_dir:$PATH" \
    APP_DIR_OVERRIDE="$app_dir" \
    PKG_ROOT_OVERRIDE="$pkg_root" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    PACKAGE_WITH_UPDATER=0 \
    PACKAGE_VERSION="2026.03.24.120000+manual" \
    bash "$REPO_DIR/scripts/build-deb.sh"

    assert_file_exists "$dist_dir/codex-desktop_2026.03.24.120000+manual_amd64.deb"
    assert_file_exists "$pkg_root/usr/bin/codex-desktop"
    assert_file_exists "$pkg_root/DEBIAN/postinst"
    assert_file_exists "$pkg_root/DEBIAN/prerm"
    assert_file_exists "$pkg_root/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh"
    assert_file_exists "$pkg_root/opt/codex-desktop/.codex-linux/cli-launch-path.py"
    assert_file_exists "$pkg_root/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh"
    assert_file_not_exists "$pkg_root/usr/bin/codex-update-manager"
    assert_file_not_exists "$pkg_root/usr/lib/systemd/user/codex-update-manager.service"
    assert_file_not_exists "$pkg_root/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy"
    assert_file_not_exists "$pkg_root/opt/codex-desktop/update-builder"
    assert_file_not_exists "$pkg_root/DEBIAN/postrm"
    assert_not_contains "$pkg_root/DEBIAN/control" "pkexec"
    assert_not_contains "$pkg_root/DEBIAN/control" "polkit"
    assert_not_contains "$pkg_root/DEBIAN/control" "Local auto-updates"
    assert_contains "$pkg_root/DEBIAN/control" "without codex-update-manager"
    assert_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "Actions=new-window;"
    assert_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "Desktop Action new-window"
    assert_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "CODEX_MULTI_LAUNCH=1 /usr/bin/codex-desktop --new-instance"
    assert_not_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "Desktop Action CheckForUpdates"
    assert_not_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "InstallReadyUpdate"
    assert_not_contains "$pkg_root/usr/share/applications/codex-desktop.desktop" "codex-update-manager"
    assert_not_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh" "systemctl"
    assert_not_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh" "codex-update-manager"
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh" 'CHROME_DESKTOP="codex-desktop.desktop"'
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-desktop-entry-doctor.sh" "codex_desktop_repair_system_package_shadow_entries"
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh" "codex_no_updater_cleanup_update_manager_service"
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh" "stop \"\$SERVICE_NAME\""
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh" "disable \"\$SERVICE_NAME\""
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh" "daemon-reload"
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh" "codex_no_updater_cleanup_user_enablement_links"
    assert_contains "$pkg_root/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh" "default.target.wants"
    assert_contains "$pkg_root/DEBIAN/postinst" "codex_no_updater_cleanup_update_manager_service"
    assert_contains "$pkg_root/DEBIAN/postinst" "codex_desktop_repair_system_package_shadow_entries"
    assert_contains "$pkg_root/DEBIAN/prerm" "codex_no_updater_cleanup_update_manager_service"
    assert_not_contains "$pkg_root/DEBIAN/postinst" "update-builder"
    assert_not_contains "$pkg_root/DEBIAN/prerm" "update-builder"
}

test_no_updater_cleanup_helper_removes_inactive_user_enablement() {
    info "Checking no-updater inactive user service cleanup"
    local workspace="$TMP_DIR/no-updater-cleanup"
    local bin_dir="$workspace/bin"
    local helper="$workspace/codex-no-updater-transition-cleanup.sh"
    local fake_home="$workspace/home/codexuser"
    local service_link="$fake_home/.config/systemd/user/default.target.wants/codex-update-manager.service"

    mkdir -p "$bin_dir" "$(dirname "$service_link")"
    ln -s /usr/lib/systemd/user/codex-update-manager.service "$service_link"

    render_no_updater_transition_cleanup_helper "$helper"

    cat > "$bin_dir/getent" <<'SCRIPT'
#!/usr/bin/env bash
if [ "${1:-}" = "passwd" ]; then
    printf 'codexuser:x:1000:1000::%s:/bin/sh\n' "$FAKE_HOME"
fi
SCRIPT
    cat > "$bin_dir/runuser" <<'SCRIPT'
#!/usr/bin/env bash
if [ "${1:-}" = "-u" ]; then
    shift 2
fi
if [ "${1:-}" = "--" ]; then
    shift
fi
exec "$@"
SCRIPT
    cat > "$bin_dir/systemctl" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
    chmod +x "$bin_dir/getent" "$bin_dir/runuser" "$bin_dir/systemctl"

    PATH="$bin_dir:$PATH" FAKE_HOME="$fake_home" sh -c \
        '. "$1"; codex_no_updater_cleanup_update_manager_service' \
        _ "$helper"

    assert_file_not_exists "$service_link"
}

test_update_manager_service_helper_respects_disabled_service() {
    info "Checking updater service helper respects disabled user service state"
    local helper_log="$TMP_DIR/updater-service-helper.log"
    local helper_state=""

    # shellcheck source=packaging/linux/codex-update-manager-user-service.sh
    . "$REPO_DIR/packaging/linux/codex-update-manager-user-service.sh"

    codex_run_systemctl_user() {
        local user_name="$1"
        local runtime_dir="$2"
        local bus="$3"
        shift 3
        printf '%s|%s|%s|%s\n' "$helper_state" "$user_name" "$runtime_dir" "$*" >> "$helper_log"

        case "$*" in
            "daemon-reload")
                return 0
                ;;
            "is-active $SERVICE_NAME")
                [ "$helper_state" = "active" ]
                return
                ;;
            "is-enabled $SERVICE_NAME")
                [ "$helper_state" = "enabled" ] || [ "$helper_state" = "active" ]
                return
                ;;
            "start $SERVICE_NAME")
                return 0
                ;;
            "enable --now $SERVICE_NAME")
                return 0
                ;;
        esac

        return 1
    }

    helper_state="disabled"
    : > "$helper_log"
    codex_start_one_enabled_user_service codexuser /run/user/1000 /run/user/1000/bus
    assert_not_contains "$helper_log" "start $SERVICE_NAME"
    assert_not_contains "$helper_log" "enable --now $SERVICE_NAME"

    helper_state="enabled"
    : > "$helper_log"
    codex_start_one_enabled_user_service codexuser /run/user/1000 /run/user/1000/bus
    assert_contains "$helper_log" "start $SERVICE_NAME"
    assert_not_contains "$helper_log" "enable --now $SERVICE_NAME"

    helper_state="disabled"
    : > "$helper_log"
    codex_ensure_one_user_service_running codexuser /run/user/1000 /run/user/1000/bus
    assert_contains "$helper_log" "enable --now $SERVICE_NAME"
}

test_rpm_builder_smoke() {
    info "Running RPM packaging smoke test"
    local workspace="$TMP_DIR/rpm"
    local bin_dir="$workspace/bin"
    local app_dir="$workspace/app"
    local dist_dir="$workspace/dist"
    local updater_bin="$workspace/codex-update-manager"
    local capture_dir="$workspace/capture"

    mkdir -p "$workspace" "$dist_dir" "$capture_dir"
    make_stub_bin_dir "$bin_dir"
    make_fake_app "$app_dir"
    chmod 0700 "$app_dir" "$app_dir/content" "$app_dir/content/webview"
    chmod 0700 "$app_dir/start.sh"
    chmod 0600 "$app_dir/content/webview/index.html"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$updater_bin"
    chmod +x "$updater_bin"

    cat > "$bin_dir/rpmbuild" <<'SCRIPT'
#!/usr/bin/env bash
rpmdir=""
binary_payload=""
spec_file="${@: -1}"
while [ $# -gt 0 ]; do
    if [ "$1" = "--define" ]; then
        case "$2" in
            _rpmdir\ *) rpmdir="${2#_rpmdir }" ;;
            _binary_payload\ *) binary_payload="${2#_binary_payload }" ;;
        esac
        shift 2
        continue
    fi
    shift
done
[ -n "$rpmdir" ] || exit 1
if [ -n "${CAPTURE_DIR:-}" ]; then
    cp "$spec_file" "$CAPTURE_DIR/codex-desktop.spec"
    printf '%s\n' "$binary_payload" > "$CAPTURE_DIR/rpm-binary-payload"
    staging_dir="$(sed -n 's|cp -a "\(.*\)/\." "%{buildroot}/"|\1|p' "$spec_file" | head -n 1)"
    if [ -n "$staging_dir" ] && [ -d "$staging_dir" ]; then
        cp -a "$staging_dir" "$CAPTURE_DIR/staging"
    fi
fi
mkdir -p "$rpmdir/x86_64"
touch "$rpmdir/x86_64/codex-desktop-2026.03.24.120000-deadbeef.x86_64.rpm"
SCRIPT
    cat > "$bin_dir/cargo" <<'SCRIPT'
#!/usr/bin/env bash
echo "cargo should not be called when UPDATER_BINARY_SOURCE exists" >&2
exit 99
SCRIPT
    chmod +x "$bin_dir/rpmbuild" "$bin_dir/cargo"

    PATH="$bin_dir:$PATH" \
    CAPTURE_DIR="$capture_dir" \
    APP_DIR_OVERRIDE="$app_dir" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    UPDATER_BINARY_SOURCE="$updater_bin" \
    PACKAGE_VERSION="2026.03.24.120000+deadbeef" \
    bash "$REPO_DIR/scripts/build-rpm.sh"

    assert_file_exists "$dist_dir/codex-desktop-2026.03.24.120000-deadbeef.x86_64.rpm"
    [ "$(cat "$capture_dir/rpm-binary-payload")" = "" ] \
        || fail "Expected default RPM binary payload to use tool default"

    rm -rf "$dist_dir" "$capture_dir"
    mkdir -p "$dist_dir" "$capture_dir"

    PATH="$bin_dir:$PATH" \
    CAPTURE_DIR="$capture_dir" \
    APP_DIR_OVERRIDE="$app_dir" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    PACKAGE_WITH_UPDATER=0 \
    PACKAGE_VERSION="2026.03.24.120000+manual" \
    MAX_BUILD_THREADS=8 \
    bash "$REPO_DIR/scripts/build-rpm.sh"

    assert_file_exists "$dist_dir/codex-desktop-2026.03.24.120000-manual.x86_64.rpm"
    assert_file_exists "$capture_dir/codex-desktop.spec"
    [ "$(cat "$capture_dir/rpm-binary-payload")" = "w19T8.zstdio" ] \
        || fail "Expected MAX_BUILD_THREADS to reach rpmbuild payload compression"
    assert_file_exists "$capture_dir/staging/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh"
    assert_file_not_exists "$capture_dir/staging/usr/bin/codex-update-manager"
    assert_file_not_exists "$capture_dir/staging/usr/lib/systemd/user/codex-update-manager.service"
    assert_file_not_exists "$capture_dir/staging/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy"
    assert_file_not_exists "$capture_dir/staging/opt/codex-desktop/update-builder"
    assert_mode "$capture_dir/staging/opt/codex-desktop" "755"
    assert_mode "$capture_dir/staging/opt/codex-desktop/content/webview" "755"
    assert_mode "$capture_dir/staging/opt/codex-desktop/start.sh" "755"
    assert_mode "$capture_dir/staging/opt/codex-desktop/content/webview/index.html" "644"
    assert_contains "$capture_dir/codex-desktop.spec" "%if 0"
    assert_contains "$capture_dir/codex-desktop.spec" "codex_elf_suffix ()(64bit)"
    assert_contains "$capture_dir/codex-desktop.spec" "libatk-bridge-2.0.so.0"
    assert_contains "$capture_dir/codex-desktop.spec" "libgbm.so.1"
    assert_not_contains "$capture_dir/codex-desktop.spec" "at-spi2-atk"
    assert_not_contains "$capture_dir/codex-desktop.spec" "mesa-libgbm"
    assert_contains "$capture_dir/codex-desktop.spec" "codex_no_updater_cleanup_update_manager_service"
    assert_contains "$capture_dir/staging/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh" "codex_no_updater_cleanup_user_enablement_links"

    rm -rf "$dist_dir" "$capture_dir"
    mkdir -p "$dist_dir" "$capture_dir"

    PATH="$bin_dir:$PATH" \
    CAPTURE_DIR="$capture_dir" \
    APP_DIR_OVERRIDE="$app_dir" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    UPDATER_BINARY_SOURCE="$updater_bin" \
    PACKAGE_VERSION="2026.03.24.120000+payload" \
    RPM_BINARY_PAYLOAD="w19.zstdio" \
    bash "$REPO_DIR/scripts/build-rpm.sh"

    [ "$(cat "$capture_dir/rpm-binary-payload")" = "w19.zstdio" ] \
        || fail "Expected RPM_BINARY_PAYLOAD to override tool default"
}

test_pacman_builder_without_updater_transition_hook() {
    info "Running no-updater pacman packaging hook smoke test"
    if [ "$(id -u)" -eq 0 ]; then
        info "Skipping pacman no-updater hook smoke test as root"
        return
    fi

    local workspace="$TMP_DIR/pacman-no-updater"
    local bin_dir="$workspace/bin"
    local app_dir="$workspace/app"
    local dist_dir="$workspace/dist"
    local capture_dir="$workspace/capture"
    local ampersand_tmpdir="$workspace/ampersand&tmp"
    local base_makepkg_conf="$workspace/base-makepkg.conf"

    mkdir -p "$workspace" "$dist_dir" "$capture_dir" "$ampersand_tmpdir"
    make_stub_bin_dir "$bin_dir"
    make_fake_app "$app_dir"
    printf 'MAKEFLAGS="-j12"\n' > "$base_makepkg_conf"

    cat > "$bin_dir/makepkg" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cp PKGBUILD "$CAPTURE_DIR/PKGBUILD"
cp codex-desktop.install "$CAPTURE_DIR/codex-desktop.install"
printf '%s\n' "${MAKEPKG_CONF:-}" > "$CAPTURE_DIR/makepkg-conf-path"
if [ -n "${MAKEPKG_CONF:-}" ]; then
    cp "$MAKEPKG_CONF" "$CAPTURE_DIR/makepkg.conf"
    bash -c 'set -euo pipefail; . "$1"; printf "%s\n" "$MAKEFLAGS"' _ "$MAKEPKG_CONF" > "$CAPTURE_DIR/makepkg-evaluated-makeflags"
fi
pkgname="$(sed -n 's/^pkgname=//p' PKGBUILD)"
pkgver="$(sed -n 's/^pkgver=//p' PKGBUILD)"
pkgrel="$(sed -n 's/^pkgrel=//p' PKGBUILD)"
arch="$(sed -n "s/^arch=('\([^']*\)').*/\1/p" PKGBUILD)"
mkdir -p "$PKGDEST"
touch "$PKGDEST/${pkgname}-${pkgver}-${pkgrel}-${arch}.pkg.tar.zst"
SCRIPT
    cat > "$bin_dir/cargo" <<'SCRIPT'
#!/usr/bin/env bash
echo "cargo should not be called when PACKAGE_WITH_UPDATER=0" >&2
exit 99
SCRIPT
    chmod +x "$bin_dir/makepkg" "$bin_dir/cargo"

    local package_path
    package_path="$(
        TMPDIR="$ampersand_tmpdir" \
        PATH="$bin_dir:$PATH" \
        CAPTURE_DIR="$capture_dir" \
        APP_DIR_OVERRIDE="$app_dir" \
        DIST_DIR_OVERRIDE="$dist_dir" \
        MAKEPKG_CONF="$base_makepkg_conf" \
        PACKAGE_WITH_UPDATER=0 \
        MAX_BUILD_THREADS=5 \
        PACKAGE_VERSION="2026.03.24.120000+manual" \
        bash "$REPO_DIR/scripts/build-pacman.sh"
    )"

    assert_file_exists "$dist_dir/codex-desktop-2026.03.24.120000+manual-1-x86_64.pkg.tar.zst"
    [ "$package_path" = "$dist_dir/codex-desktop-2026.03.24.120000+manual-1-x86_64.pkg.tar.zst" ] || fail "Expected build-pacman.sh to print built package path, got: $package_path"
    assert_file_exists "$dist_dir/codex-desktop-latest.pkg.tar.zst"
    [ "$(readlink "$dist_dir/codex-desktop-latest.pkg.tar.zst")" = "codex-desktop-2026.03.24.120000+manual-1-x86_64.pkg.tar.zst" ] || fail "Expected latest pacman symlink to point at built package"
    assert_file_exists "$capture_dir/PKGBUILD"
    assert_file_exists "$capture_dir/codex-desktop.install"
    assert_file_exists "$capture_dir/makepkg.conf"
    assert_contains "$capture_dir/makepkg.conf" "MAKEFLAGS=\"\${MAKEFLAGS:+\$MAKEFLAGS }-j5\""
    [ "$(cat "$capture_dir/makepkg-evaluated-makeflags")" = "-j12 -j5" ] \
        || fail "Expected generated makepkg config to make MAX_BUILD_THREADS win over existing MAKEFLAGS"
    assert_contains "$capture_dir/makepkg.conf" "COMPRESSZST=(zstd -c -z -T5 -)"
    assert_contains "$capture_dir/PKGBUILD" "pkgver=2026.03.24.120000+manual"
    assert_contains "$capture_dir/PKGBUILD" "pkgrel=1"
    assert_contains "$capture_dir/PKGBUILD" "ampersand&tmp"
    assert_not_contains "$capture_dir/PKGBUILD" "__STAGING_DIR__"
    assert_contains "$capture_dir/PKGBUILD" "install=codex-desktop.install"
    assert_not_contains "$capture_dir/PKGBUILD" "'polkit'"
    assert_contains "$capture_dir/codex-desktop.install" "codex_no_updater_cleanup_update_manager_service"
    assert_contains "$capture_dir/codex-desktop.install" "post_upgrade"
    assert_contains "$capture_dir/codex-desktop.install" "pre_remove"
    assert_contains "$capture_dir/codex-desktop.install" "codex-no-updater-transition-cleanup.sh"
    assert_not_contains "$capture_dir/codex-desktop.install" "update-builder"
}

test_appimage_builder_smoke() {
    info "Running AppImage packaging smoke test"
    local workspace="$TMP_DIR/appimage"
    local bin_dir="$workspace/bin"
    local app_dir="$workspace/app"
    local dist_dir="$workspace/dist"
    local appdir="$workspace/codex-desktop.AppDir"
    local capture_dir="$workspace/capture"
    local cli_root="$workspace/cli/node_modules/@openai"
    local cli_source="$cli_root/codex"
    local platform_source
    local platform_package
    local target_triple
    local platform_version_suffix
    local arch

    case "$(uname -m)" in
        x86_64)
            arch="x86_64"
            platform_package="codex-linux-x64"
            target_triple="x86_64-unknown-linux-musl"
            platform_version_suffix="linux-x64"
            ;;
        aarch64|arm64)
            arch="aarch64"
            platform_package="codex-linux-arm64"
            target_triple="aarch64-unknown-linux-musl"
            platform_version_suffix="linux-arm64"
            ;;
        armv7l|armhf) arch="armhf" ;;
        *) fail "Unsupported AppImage smoke-test architecture: $(uname -m)" ;;
    esac

    mkdir -p "$workspace" "$dist_dir" "$capture_dir"
    make_stub_bin_dir "$bin_dir"
    make_fake_app "$app_dir"
    mkdir -p "$app_dir/resources/codex-cli"
    printf '%s\n' 'upstream-payload' > "$app_dir/resources/codex-cli/preserve.txt"

    cat > "$bin_dir/appimagetool" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

saw_no_appstream=0
previous=""
last=""
for arg in "$@"; do
    [ "$arg" = "--no-appstream" ] && saw_no_appstream=1
    previous="$last"
    last="$arg"
done

[ "$saw_no_appstream" -eq 1 ] || exit 2
[ -n "$previous" ] || exit 3
[ -d "$previous" ] || exit 4
[ -n "${ARCH:-}" ] || exit 5
[ -n "${VERSION:-}" ] || exit 6

mkdir -p "$(dirname "$last")" "$CAPTURE_DIR"
cp -a "$previous" "$CAPTURE_DIR/AppDir"
printf '%s\n' "$ARCH" > "$CAPTURE_DIR/arch"
printf '%s\n' "$VERSION" > "$CAPTURE_DIR/version"
touch "$last"
SCRIPT
    chmod +x "$bin_dir/appimagetool"

    PATH="$bin_dir:$PATH" \
    CAPTURE_DIR="$capture_dir" \
    APP_DIR_OVERRIDE="$app_dir" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    APPIMAGE_APPDIR_OVERRIDE="$appdir" \
    PACKAGE_VERSION="2026.03.24.120000+appimage" \
    bash "$REPO_DIR/scripts/build-appimage.sh"

    assert_file_exists "$dist_dir/codex-desktop-2026.03.24.120000+appimage-$arch.AppImage"
    assert_file_exists "$capture_dir/AppDir/AppRun"
    [ -x "$capture_dir/AppDir/AppRun" ] || fail "Expected AppRun to be executable"
    assert_file_exists "$capture_dir/AppDir/codex-desktop.desktop"
    assert_file_exists "$capture_dir/AppDir/codex-desktop.png"
    assert_file_exists "$capture_dir/AppDir/.DirIcon"
    assert_file_exists "$capture_dir/AppDir/usr/share/applications/codex-desktop.desktop"
    assert_file_exists "$capture_dir/AppDir/usr/share/icons/hicolor/256x256/apps/codex-desktop.png"
    assert_file_exists "$capture_dir/AppDir/opt/codex-desktop/start.sh"
    assert_file_exists "$capture_dir/AppDir/opt/codex-desktop/.codex-linux/codex-desktop.png"
    assert_file_exists "$capture_dir/AppDir/opt/codex-desktop/.codex-linux/cli-launch-path.py"
    assert_file_exists "$capture_dir/AppDir/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh"
    assert_file_exists "$capture_dir/AppDir/opt/codex-desktop/resources/node-runtime/bin/node"
    assert_file_exists "$capture_dir/AppDir/opt/codex-desktop/resources/codex-cli/preserve.txt"
    assert_file_not_exists "$capture_dir/AppDir/opt/codex-desktop/resources/codex-cli/bin/codex"
    assert_file_not_exists "$capture_dir/AppDir/usr/bin/codex-update-manager"
    assert_file_not_exists "$capture_dir/AppDir/usr/lib/systemd/user/codex-update-manager.service"
    assert_file_not_exists "$capture_dir/AppDir/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy"
    assert_file_not_exists "$capture_dir/AppDir/opt/codex-desktop/update-builder"
    assert_contains "$capture_dir/AppDir/codex-desktop.desktop" "Exec=AppRun %u"
    assert_contains "$capture_dir/AppDir/codex-desktop.desktop" "Icon=codex-desktop"
    assert_contains "$capture_dir/AppDir/codex-desktop.desktop" "X-AppImage-Version=2026.03.24.120000+appimage"
    assert_contains "$capture_dir/AppDir/codex-desktop.desktop" "Actions=new-window;"
    assert_contains "$capture_dir/AppDir/codex-desktop.desktop" "[Desktop Action new-window]"
    assert_not_contains "$capture_dir/AppDir/codex-desktop.desktop" "codex-update-manager"
    assert_contains "$capture_dir/AppDir/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh" 'CHROME_DESKTOP="codex-desktop.desktop"'
    assert_not_contains "$capture_dir/AppDir/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh" "/usr/share/applications"
    [ "$(cat "$capture_dir/arch")" = "$arch" ] || fail "Expected appimagetool ARCH=$arch"
    [ "$(cat "$capture_dir/version")" = "2026.03.24.120000+appimage" ] || fail "Expected appimagetool VERSION override"

    if [ "$arch" = "armhf" ]; then
        return 0
    fi

    platform_source="$cli_root/$platform_package"
    mkdir -p \
        "$cli_source/bin" \
        "$platform_source/vendor/$target_triple/bin"
    printf '%s\n' \
        '{' \
        '  "name": "@openai/codex",' \
        '  "version": "0.144.1",' \
        '  "bin": {"codex": "bin/codex.js"},' \
        "  \"optionalDependencies\": {\"@openai/$platform_package\": \"npm:@openai/codex@0.144.1-$platform_version_suffix\"}" \
        '}' > "$cli_source/package.json"
    printf '%s\n' '#!/usr/bin/env node' 'console.log("fixture");' > "$cli_source/bin/codex.js"
    printf '%s\n' \
        '{' \
        '  "name": "@openai/codex",' \
        "  \"version\": \"0.144.1-$platform_version_suffix\"" \
        '}' > "$platform_source/package.json"
    printf '%s\n' '#!/usr/bin/env bash' 'echo fixture-native-codex' > "$platform_source/vendor/$target_triple/bin/codex"
    chmod 0755 "$platform_source/vendor/$target_triple/bin/codex"

    rm -rf "$capture_dir"
    mkdir -p "$capture_dir"
    PATH="$bin_dir:$PATH" \
    CAPTURE_DIR="$capture_dir" \
    APP_DIR_OVERRIDE="$app_dir" \
    DIST_DIR_OVERRIDE="$dist_dir" \
    APPIMAGE_APPDIR_OVERRIDE="$appdir" \
    CODEX_CLI_BUNDLE_SOURCE="$cli_source" \
    PACKAGE_VERSION="2026.03.24.120000+appimage-cli" \
    bash "$REPO_DIR/scripts/build-appimage.sh"

    local bundled_cli="$capture_dir/AppDir/opt/codex-desktop/resources/codex-cli/bin/codex"
    assert_file_exists "$bundled_cli"
    assert_file_not_exists "$capture_dir/AppDir/opt/codex-desktop/resources/codex-cli/preserve.txt"
    [ -x "$bundled_cli" ] || fail "Expected bundled Codex CLI wrapper to be executable"
    assert_file_exists "$capture_dir/AppDir/opt/codex-desktop/resources/codex-cli/node_modules/@openai/codex/bin/codex.js"
    assert_file_exists "$capture_dir/AppDir/opt/codex-desktop/resources/codex-cli/node_modules/@openai/$platform_package/vendor/$target_triple/bin/codex"
    assert_contains "$capture_dir/AppDir/AppRun" "resources/codex-cli/bin/codex"
    assert_contains "$capture_dir/AppDir/AppRun" "export CODEX_CLI_PATH"

    printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "${CODEX_CLI_PATH:-}"' > "$capture_dir/AppDir/opt/codex-desktop/start.sh"
    chmod 0755 "$capture_dir/AppDir/opt/codex-desktop/start.sh"
    local app_run_output
    local app_run_path
    app_run_path="$(dirname "$BASH_BIN")"
    app_run_output="$(env -i PATH="$app_run_path" HOME="$workspace/home" APPDIR="$capture_dir/AppDir" "$BASH_BIN" "$capture_dir/AppDir/AppRun")"
    [ "$app_run_output" = "$bundled_cli" ] || fail "Expected AppRun to select bundled Codex CLI: $app_run_output"
    app_run_output="$(env -i PATH="$app_run_path" HOME="$workspace/home" APPDIR="$capture_dir/AppDir" CODEX_CLI_PATH=/custom/codex "$BASH_BIN" "$capture_dir/AppDir/AppRun")"
    [ "$app_run_output" = "/custom/codex" ] || fail "Expected explicit CODEX_CLI_PATH to override bundled CLI: $app_run_output"
    [ "$("$BASH_BIN" "$bundled_cli" --version)" = "v22.22.2" ] || fail "Expected bundled CLI wrapper to use the managed Node runtime"

    rm -rf "$platform_source" "$capture_dir"
    mkdir -p "$capture_dir"
    local missing_platform_log="$workspace/missing-platform.log"
    if PATH="$bin_dir:$PATH" \
        CAPTURE_DIR="$capture_dir" \
        APP_DIR_OVERRIDE="$app_dir" \
        DIST_DIR_OVERRIDE="$dist_dir" \
        APPIMAGE_APPDIR_OVERRIDE="$appdir" \
        CODEX_CLI_BUNDLE_SOURCE="$cli_source" \
        PACKAGE_VERSION="2026.03.24.120000+appimage-cli-missing" \
        bash "$REPO_DIR/scripts/build-appimage.sh" >"$missing_platform_log" 2>&1; then
        fail "AppImage build should reject a Codex CLI bundle without its Linux platform package"
    fi
    assert_contains "$missing_platform_log" "Missing bundled Codex CLI platform package"

    mkdir -p "$platform_source/vendor/$target_triple/bin"
    printf '%s\n' \
        '{' \
        '  "name": "@openai/codex",' \
        "  \"version\": \"0.144.1-$platform_version_suffix\"" \
        '}' > "$platform_source/package.json"
    printf '%s\n' '#!/usr/bin/env bash' 'echo fixture-native-codex' > "$platform_source/vendor/$target_triple/bin/codex"
    chmod 0755 "$platform_source/vendor/$target_triple/bin/codex"
    ln -s package.json "$cli_source/package-link.json"

    local symlink_log="$workspace/symlink.log"
    if PATH="$bin_dir:$PATH" \
        CAPTURE_DIR="$capture_dir" \
        APP_DIR_OVERRIDE="$app_dir" \
        DIST_DIR_OVERRIDE="$dist_dir" \
        APPIMAGE_APPDIR_OVERRIDE="$appdir" \
        CODEX_CLI_BUNDLE_SOURCE="$cli_source" \
        PACKAGE_VERSION="2026.03.24.120000+appimage-cli-symlink" \
        bash "$REPO_DIR/scripts/build-appimage.sh" >"$symlink_log" 2>&1; then
        fail "AppImage build should reject symlinks inside a bundled Codex CLI package"
    fi
    assert_contains "$symlink_log" "Bundled Codex CLI package contains a symlink"
    rm "$cli_source/package-link.json"

    mkfifo "$cli_source/unsupported.pipe"
    local unsupported_entry_log="$workspace/unsupported-entry.log"
    if PATH="$bin_dir:$PATH" \
        CAPTURE_DIR="$capture_dir" \
        APP_DIR_OVERRIDE="$app_dir" \
        DIST_DIR_OVERRIDE="$dist_dir" \
        APPIMAGE_APPDIR_OVERRIDE="$appdir" \
        CODEX_CLI_BUNDLE_SOURCE="$cli_source" \
        PACKAGE_VERSION="2026.03.24.120000+appimage-cli-fifo" \
        bash "$REPO_DIR/scripts/build-appimage.sh" >"$unsupported_entry_log" 2>&1; then
        fail "AppImage build should reject unsupported filesystem entries in a bundled Codex CLI package"
    fi
    assert_contains "$unsupported_entry_log" "Bundled Codex CLI package contains an unsupported filesystem entry"
    rm "$cli_source/unsupported.pipe"

    printf '%s\n' \
        '{' \
        '  "name": "@openai/codex",' \
        "  \"version\": \"0.143.0-$platform_version_suffix\"" \
        '}' > "$platform_source/package.json"
    local version_log="$workspace/version.log"
    if PATH="$bin_dir:$PATH" \
        CAPTURE_DIR="$capture_dir" \
        APP_DIR_OVERRIDE="$app_dir" \
        DIST_DIR_OVERRIDE="$dist_dir" \
        APPIMAGE_APPDIR_OVERRIDE="$appdir" \
        CODEX_CLI_BUNDLE_SOURCE="$cli_source" \
        PACKAGE_VERSION="2026.03.24.120000+appimage-cli-version" \
        bash "$REPO_DIR/scripts/build-appimage.sh" >"$version_log" 2>&1; then
        fail "AppImage build should reject mismatched Codex CLI package versions"
    fi
    assert_contains "$version_log" "Bundled Codex CLI platform package version does not match"
}

test_missing_input_failure() {
    info "Checking missing-input failure path"
    local workspace="$TMP_DIR/missing"
    local bin_dir="$workspace/bin"
    local rpm_app_dir="$workspace/rpm-app"
    local rpm_no_webview_app_dir="$workspace/rpm-no-webview-app"
    local rpm_log="$workspace/rpm-missing-runtime.log"
    local rpm_no_webview_log="$workspace/rpm-missing-webview.log"

    mkdir -p "$workspace"
    make_stub_bin_dir "$bin_dir"
    make_fake_app "$rpm_app_dir"
    mkdir -p "$rpm_no_webview_app_dir/content/webview"
    printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$rpm_no_webview_app_dir/start.sh"
    chmod +x "$rpm_no_webview_app_dir/start.sh"
    cat > "$bin_dir/dpkg" <<'SCRIPT'
#!/usr/bin/env bash
echo amd64
SCRIPT
    cat > "$bin_dir/dpkg-deb" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
    chmod +x "$bin_dir/dpkg" "$bin_dir/dpkg-deb"

    if PATH="$bin_dir:$PATH" APP_DIR_OVERRIDE="$workspace/does-not-exist" PKG_ROOT_OVERRIDE="$workspace/deb-root" bash "$REPO_DIR/scripts/build-deb.sh" >/dev/null 2>&1; then
        fail "build-deb.sh should fail when APP_DIR is missing"
    fi

    if APP_DIR_OVERRIDE="$rpm_no_webview_app_dir" PACKAGE_WITH_UPDATER=0 bash "$REPO_DIR/scripts/build-rpm.sh" >"$rpm_no_webview_log" 2>&1; then
        fail "build-rpm.sh should fail when webview/index.html is missing"
    fi
    assert_contains "$rpm_no_webview_log" "Missing webview entrypoint"

    if APP_DIR_OVERRIDE="$rpm_app_dir" PACKAGED_RUNTIME_SOURCE="$workspace/does-not-exist.sh" bash "$REPO_DIR/scripts/build-rpm.sh" >"$rpm_log" 2>&1; then
        fail "build-rpm.sh should fail when PACKAGED_RUNTIME_SOURCE is missing"
    fi
    assert_contains "$rpm_log" "Missing packaged launcher runtime helper"
}

test_make_install_reports_missing_native_packages() {
    info "Checking make install missing-package diagnostics"
    local workspace="$TMP_DIR/make-install-missing"
    local output_log
    local format
    local expected

    mkdir -p "$workspace/dist"

    for format in pacman rpm deb; do
        output_log="$workspace/$format.log"
        case "$format" in
            pacman) expected="No pacman package found. Run 'make pacman' first." ;;
            rpm) expected="No RPM package found. Run 'make rpm' first." ;;
            deb) expected="No Debian package found. Run 'make deb' first." ;;
        esac

        if make -f "$REPO_DIR/Makefile" -C "$workspace" install \
            NATIVE_PKG_FORMAT_CMD="printf $format" >"$output_log" 2>&1
        then
            fail "make install should fail when no $format package exists"
        fi

        assert_contains "$output_log" "$expected"
    done
}

test_make_run_app_reports_missing_launcher() {
    info "Checking make run-app missing-launcher diagnostics"
    local workspace="$TMP_DIR/make-run-app-missing"
    local output_log="$workspace/run-app.log"

    mkdir -p "$workspace"

    if make -f "$REPO_DIR/Makefile" -C "$workspace" run-app >"$output_log" 2>&1; then
        fail "make run-app should fail when codex-app/start.sh is missing"
    fi

    assert_contains "$output_log" "Missing launcher: $workspace/codex-app/start.sh. Run make build-app first."
    assert_not_contains "$output_log" "No such file or directory"
}

test_make_build_app_uses_installer_download_flow_by_default() {
    info "Checking make build-app default DMG behavior"
    local workspace="$TMP_DIR/make-build-app"
    local install_log="$workspace/install-args.log"
    local first_line

    mkdir -p "$workspace"

    cat > "$workspace/install.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$#" > "$TEST_INSTALL_LOG"
if [ "$#" -gt 0 ]; then
    printf '%s\n' "$1" >> "$TEST_INSTALL_LOG"
fi
SCRIPT
    chmod +x "$workspace/install.sh"

    TEST_INSTALL_LOG="$install_log" make -f "$REPO_DIR/Makefile" -C "$workspace" build-app >/dev/null

    assert_file_exists "$install_log"
    first_line="$(sed -n '1p' "$install_log")"
    second_line="$(sed -n '2p' "$install_log")"
    [ "$first_line" = "1" ] || fail "Expected make build-app to call install.sh with a single default argument slot, got: $(cat "$install_log")"
    [ -z "$second_line" ] || fail "Expected make build-app default DMG argument to be empty so install.sh falls back to reuse/download, got: $(cat "$install_log")"
}

test_make_build_app_fresh_uses_installer_fresh_flow() {
    info "Checking make build-app-fresh DMG behavior"
    local workspace="$TMP_DIR/make-build-app-fresh"
    local install_log="$workspace/install-args.log"
    local first_line
    local second_line
    local third_line

    mkdir -p "$workspace"

    cat > "$workspace/install.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$#" > "$TEST_INSTALL_LOG"
for arg in "$@"; do
    printf '%s\n' "$arg" >> "$TEST_INSTALL_LOG"
done
SCRIPT
    chmod +x "$workspace/install.sh"

    TEST_INSTALL_LOG="$install_log" make -f "$REPO_DIR/Makefile" -C "$workspace" build-app-fresh >/dev/null

    assert_file_exists "$install_log"
    first_line="$(sed -n '1p' "$install_log")"
    second_line="$(sed -n '2p' "$install_log")"
    third_line="$(sed -n '3p' "$install_log")"
    [ "$first_line" = "2" ] || fail "Expected make build-app-fresh to pass --fresh plus the default argument slot, got: $(cat "$install_log")"
    [ "$second_line" = "--fresh" ] || fail "Expected make build-app-fresh to pass --fresh first, got: $(cat "$install_log")"
    [ -z "$third_line" ] || fail "Expected make build-app-fresh default DMG argument to be empty, got: $(cat "$install_log")"
}

test_make_build_dev_app_writes_host_portable_launcher_symlink() {
    info "Checking make build-dev-app writes a host-portable launcher symlink"
    local workspace="$TMP_DIR/make-build-dev-app"
    local install_log="$workspace/install-env.log"
    local launcher="$workspace/bin/codex-cua-lab"
    local target

    mkdir -p "$workspace"

    cat > "$workspace/install.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$CODEX_APP_ID" > "$TEST_INSTALL_LOG"
printf '%s\n' "$CODEX_APP_DISPLAY_NAME" >> "$TEST_INSTALL_LOG"
printf '%s\n' "$CODEX_INSTALL_DIR" >> "$TEST_INSTALL_LOG"
mkdir -p "$CODEX_INSTALL_DIR"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$CODEX_INSTALL_DIR/start.sh"
chmod +x "$CODEX_INSTALL_DIR/start.sh"
SCRIPT
    chmod +x "$workspace/install.sh"

    TEST_INSTALL_LOG="$install_log" make -f "$REPO_DIR/Makefile" -C "$workspace" build-dev-app >/dev/null

    assert_file_exists "$launcher"
    target="$(readlink "$launcher")"
    [ "$target" = "../codex-cua-lab-app/start.sh" ] \
        || fail "Expected dev app launcher to use a relative symlink, got: $target"
    [ -x "$launcher" ] || fail "Expected dev app launcher symlink to resolve on the host"
    assert_contains "$install_log" "codex-cua-lab"
    assert_contains "$install_log" "Codex CUA Lab"
    assert_contains "$install_log" "$workspace/codex-cua-lab-app"
}

test_installer_refreshes_stale_cached_dmg_metadata() {
    info "Checking installer DMG cache freshness metadata branches"
    local workspace="$TMP_DIR/dmg-cache-refresh"
    local bin_dir="$workspace/bin"
    local url="https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg"
    local url_sha256

    url_sha256="$(printf '%s' "$url" | sha256sum | awk '{print $1}')"

    mkdir -p "$bin_dir"

    cat >"$bin_dir/curl" <<'SCRIPT'
#!/usr/bin/env bash
set -eu

is_head=0
for arg in "$@"; do
    if [ "$arg" = "-fsSLI" ]; then
        is_head=1
    fi
done

if [ "$is_head" -eq 1 ]; then
    printf '%s\n' "HEAD" >> "$TEST_CURL_LOG"
    if [ "${TEST_HEAD_FAIL:-0}" = "1" ]; then
        exit 22
    fi
    printf 'HTTP/2 200\r\n'
    [ -z "${TEST_ETAG:-}" ] || printf 'ETag: %s\r\n' "$TEST_ETAG"
    [ -z "${TEST_LAST_MODIFIED:-}" ] || printf 'Last-Modified: %s\r\n' "$TEST_LAST_MODIFIED"
    [ -z "${TEST_CONTENT_LENGTH:-}" ] || printf 'Content-Length: %s\r\n' "$TEST_CONTENT_LENGTH"
    printf '\r\n'
    exit 0
fi

printf '%s\n' "GET" >> "$TEST_CURL_LOG"
if [ "${TEST_GET_FAIL:-0}" = "1" ]; then
    exit 23
fi

out=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
        shift
        out="$1"
    fi
    shift || true
done

[ -n "$out" ] || exit 2
printf '%s' "${TEST_DOWNLOAD_CONTENT:-new}" >"$out"
SCRIPT
    chmod +x "$bin_dir/curl"

    cat >"$bin_dir/aria2c" <<'SCRIPT'
#!/usr/bin/env bash
exit 127
SCRIPT
    chmod +x "$bin_dir/aria2c"

    run_dmg_cache_case() {
        local source_dir="$1"
        local output_log="$2"
        shift 2

        mkdir -p "$source_dir"
        : >"$source_dir/curl.log"
        env "$@" \
            PATH="$bin_dir:$PATH" \
            TEST_SOURCE_DIR="$source_dir" \
            TEST_CURL_LOG="$source_dir/curl.log" \
            REPO_DIR="$REPO_DIR" \
            bash <<'SCRIPT' >"$output_log" 2>&1
set -Eeuo pipefail

SCRIPT_DIR="$TEST_SOURCE_DIR"
WORK_DIR="$(mktemp -d)"
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/install-helpers.sh"
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/dmg.sh"

dmg_path="$(get_dmg)"
[ "$dmg_path" = "$TEST_SOURCE_DIR/Codex.dmg" ]
SCRIPT
    }

    local no_metadata="$workspace/no-metadata"
    mkdir -p "$no_metadata"
    printf '%s' "old" >"$no_metadata/Codex.dmg"
    run_dmg_cache_case "$no_metadata" "$no_metadata/output.log" \
        TEST_ETAG=fresh-etag \
        TEST_LAST_MODIFIED="Thu, 04 Jun 2026 00:00:00 GMT" \
        TEST_CONTENT_LENGTH=3 \
        TEST_DOWNLOAD_CONTENT=new
    [ "$(cat "$no_metadata/Codex.dmg")" = "new" ] || fail "Expected missing-metadata cache to refresh"
    assert_contains "$no_metadata/Codex.dmg.metadata" "etag=fresh-etag"
    assert_contains "$no_metadata/Codex.dmg.metadata" "url_sha256=$url_sha256"
    assert_contains "$no_metadata/output.log" "Cached DMG has no upstream metadata"
    assert_contains "$no_metadata/output.log" "Refreshing stale cached DMG"

    local matching="$workspace/matching"
    mkdir -p "$matching"
    printf '%s' "old" >"$matching/Codex.dmg"
    cat >"$matching/Codex.dmg.metadata" <<EOF
url_sha256=$url_sha256
etag=same-etag
last_modified=Thu, 04 Jun 2026 00:00:00 GMT
content_length=3
EOF
    run_dmg_cache_case "$matching" "$matching/output.log" \
        TEST_ETAG=same-etag \
        TEST_LAST_MODIFIED="Thu, 04 Jun 2026 00:00:00 GMT" \
        TEST_CONTENT_LENGTH=3 \
        TEST_DOWNLOAD_CONTENT=downloaded
    [ "$(cat "$matching/Codex.dmg")" = "old" ] || fail "Expected matching metadata to reuse cache"
    assert_not_contains "$matching/curl.log" "GET"
    assert_contains "$matching/output.log" "Using cached DMG"

    local differing="$workspace/differing"
    mkdir -p "$differing"
    printf '%s' "old" >"$differing/Codex.dmg"
    cat >"$differing/Codex.dmg.metadata" <<EOF
url_sha256=$url_sha256
etag=old-etag
last_modified=Thu, 04 Jun 2026 00:00:00 GMT
content_length=3
EOF
    run_dmg_cache_case "$differing" "$differing/output.log" \
        TEST_ETAG=fresh-etag \
        TEST_LAST_MODIFIED="Thu, 04 Jun 2026 00:00:00 GMT" \
        TEST_CONTENT_LENGTH=3 \
        TEST_DOWNLOAD_CONTENT=new
    [ "$(cat "$differing/Codex.dmg")" = "new" ] || fail "Expected differing metadata to refresh cache"
    assert_contains "$differing/curl.log" "GET"

    local differing_pinned="$workspace/differing-pinned"
    mkdir -p "$differing_pinned"
    printf '%s' "old" >"$differing_pinned/Codex.dmg"
    cat >"$differing_pinned/Codex.dmg.metadata" <<EOF
url_sha256=$url_sha256
etag=old-etag
last_modified=Thu, 04 Jun 2026 00:00:00 GMT
content_length=3
EOF
    run_dmg_cache_case "$differing_pinned" "$differing_pinned/output.log" \
        CODEX_DMG_REFRESH_MODE=pinned \
        TEST_ETAG=fresh-etag \
        TEST_LAST_MODIFIED="Thu, 04 Jun 2026 00:00:00 GMT" \
        TEST_CONTENT_LENGTH=3 \
        TEST_DOWNLOAD_CONTENT=new
    [ "$(cat "$differing_pinned/Codex.dmg")" = "old" ] || fail "Expected pinned stale cache to keep old DMG"
    assert_not_contains "$differing_pinned/curl.log" "HEAD"
    assert_not_contains "$differing_pinned/curl.log" "GET"
    assert_contains "$differing_pinned/output.log" "CODEX_DMG_REFRESH_MODE=pinned"

    local no_metadata_pinned="$workspace/no-metadata-pinned"
    mkdir -p "$no_metadata_pinned"
    printf '%s' "old" >"$no_metadata_pinned/Codex.dmg"
    run_dmg_cache_case "$no_metadata_pinned" "$no_metadata_pinned/output.log" \
        CODEX_DMG_REFRESH_MODE=pinned \
        TEST_ETAG=fresh-etag \
        TEST_LAST_MODIFIED="Thu, 04 Jun 2026 00:00:00 GMT" \
        TEST_CONTENT_LENGTH=3 \
        TEST_DOWNLOAD_CONTENT=new
    [ "$(cat "$no_metadata_pinned/Codex.dmg")" = "old" ] || fail "Expected pinned missing metadata cache to keep old DMG"
    assert_not_contains "$no_metadata_pinned/curl.log" "HEAD"
    assert_not_contains "$no_metadata_pinned/curl.log" "GET"

    local missing_pinned="$workspace/missing-pinned"
    mkdir -p "$missing_pinned"
    if run_dmg_cache_case "$missing_pinned" "$missing_pinned/output.log" \
        CODEX_DMG_REFRESH_MODE=pinned
    then
        fail "Expected pinned mode without cached DMG to fail"
    fi
    assert_not_contains "$missing_pinned/curl.log" "HEAD"
    assert_not_contains "$missing_pinned/curl.log" "GET"
    assert_contains "$missing_pinned/output.log" "requires an existing cached DMG"

    local failed_get="$workspace/failed-get"
    mkdir -p "$failed_get"
    printf '%s' "old" >"$failed_get/Codex.dmg"
    cat >"$failed_get/Codex.dmg.metadata" <<EOF
url_sha256=$url_sha256
etag=old-etag
last_modified=Thu, 04 Jun 2026 00:00:00 GMT
content_length=3
EOF
    if run_dmg_cache_case "$failed_get" "$failed_get/output.log" \
        TEST_ETAG=fresh-etag \
        TEST_LAST_MODIFIED="Thu, 04 Jun 2026 00:00:00 GMT" \
        TEST_CONTENT_LENGTH=3 \
        TEST_GET_FAIL=1
    then
        fail "Expected failed replacement download to fail the refresh"
    fi
    [ "$(cat "$failed_get/Codex.dmg")" = "old" ] || fail "Expected failed refresh to preserve old DMG"
    assert_contains "$failed_get/Codex.dmg.metadata" "etag=old-etag"
    assert_file_not_exists "$failed_get/Codex.dmg.part"

    local head_failure="$workspace/head-failure"
    mkdir -p "$head_failure"
    printf '%s' "old" >"$head_failure/Codex.dmg"
    cat >"$head_failure/Codex.dmg.metadata" <<EOF
url_sha256=$url_sha256
etag=old-etag
last_modified=Thu, 04 Jun 2026 00:00:00 GMT
content_length=3
EOF
    run_dmg_cache_case "$head_failure" "$head_failure/output.log" TEST_HEAD_FAIL=1
    [ "$(cat "$head_failure/Codex.dmg")" = "old" ] || fail "Expected HEAD failure to preserve cache"
    assert_not_contains "$head_failure/curl.log" "GET"
    assert_contains "$head_failure/output.log" "Could not check upstream DMG metadata"

    local head_failure_mismatched_url="$workspace/head-failure-mismatched-url"
    mkdir -p "$head_failure_mismatched_url"
    printf '%s' "old" >"$head_failure_mismatched_url/Codex.dmg"
    cat >"$head_failure_mismatched_url/Codex.dmg.metadata" <<EOF
url_sha256=$url_sha256
etag=old-etag
last_modified=Thu, 04 Jun 2026 00:00:00 GMT
content_length=3
EOF
    if run_dmg_cache_case "$head_failure_mismatched_url" "$head_failure_mismatched_url/output.log" \
        CODEX_UPSTREAM_DMG_URL="https://example.com/Codex.dmg" \
        TEST_HEAD_FAIL=1 \
        TEST_GET_FAIL=1
    then
        fail "Expected HEAD failure with mismatched cached URL metadata to attempt refresh and fail"
    fi
    [ "$(cat "$head_failure_mismatched_url/Codex.dmg")" = "old" ] || fail "Expected failed mismatched-URL refresh to preserve old DMG"
    assert_contains "$head_failure_mismatched_url/Codex.dmg.metadata" "etag=old-etag"
    assert_contains "$head_failure_mismatched_url/curl.log" "GET"
    assert_contains "$head_failure_mismatched_url/output.log" "cached DMG URL metadata does not match current URL"

    local secret_url="$workspace/secret-url"
    mkdir -p "$secret_url"
    run_dmg_cache_case "$secret_url" "$secret_url/output.log" \
        CODEX_UPSTREAM_DMG_URL="https://user:secret@example.com/Codex.dmg?token=topsecret#fragsecret" \
        TEST_ETAG=opaque-etag \
        TEST_CONTENT_LENGTH=3 \
        TEST_DOWNLOAD_CONTENT=new
    [ "$(cat "$secret_url/Codex.dmg")" = "new" ] || fail "Expected HTTPS override URL to download"
    assert_contains "$secret_url/output.log" "URL: https://redacted@example.com/Codex.dmg?REDACTED"
    assert_not_contains "$secret_url/output.log" "topsecret"
    assert_not_contains "$secret_url/output.log" "fragsecret"
    assert_not_contains "$secret_url/Codex.dmg.metadata" "topsecret"
    assert_not_contains "$secret_url/Codex.dmg.metadata" "fragsecret"

    cat >"$bin_dir/aria2c" <<'SCRIPT'
#!/usr/bin/env bash
set -eu

download_dir=""
download_name=""
for arg in "$@"; do
    printf '%s\n' "$arg" >>"$TEST_ARIA2_LOG"
    case "$arg" in
        --dir=*)
            download_dir="${arg#--dir=}"
            ;;
        --out=*)
            download_name="${arg#--out=}"
            ;;
    esac
done

[ -n "$download_dir" ] || exit 2
[ -n "$download_name" ] || exit 2

if [ "${TEST_ARIA2_MODE:-success}" = "fail" ]; then
    printf '%s' "partial" >"$download_dir/$download_name"
    printf '%s' "control" >"$download_dir/$download_name.aria2"
    exit 1
fi

printf '%s' "aria2-download" >"$download_dir/$download_name"
SCRIPT
    chmod +x "$bin_dir/aria2c"

    local aria2_success="$workspace/aria2-success"
    mkdir -p "$aria2_success"
    : >"$aria2_success/aria2.log"
    run_dmg_cache_case "$aria2_success" "$aria2_success/output.log" \
        TEST_ARIA2_LOG="$aria2_success/aria2.log" \
        TEST_ETAG=aria2-etag \
        TEST_CONTENT_LENGTH=14
    [ "$(cat "$aria2_success/Codex.dmg")" = "aria2-download" ] || fail "Expected aria2c to download the DMG"
    assert_not_contains "$aria2_success/curl.log" "GET"
    assert_contains "$aria2_success/aria2.log" "--max-connection-per-server=16"
    assert_contains "$aria2_success/aria2.log" "--split=16"
    assert_contains "$aria2_success/aria2.log" "--dir=$aria2_success"
    assert_contains "$aria2_success/aria2.log" "--out=Codex.dmg.part"
    assert_contains "$aria2_success/output.log" "Using aria2c for parallel DMG download"

    local aria2_fallback="$workspace/aria2-fallback"
    mkdir -p "$aria2_fallback"
    : >"$aria2_fallback/aria2.log"
    run_dmg_cache_case "$aria2_fallback" "$aria2_fallback/output.log" \
        TEST_ARIA2_LOG="$aria2_fallback/aria2.log" \
        TEST_ARIA2_MODE=fail \
        TEST_ETAG=fallback-etag \
        TEST_CONTENT_LENGTH=13 \
        TEST_DOWNLOAD_CONTENT=curl-fallback
    [ "$(cat "$aria2_fallback/Codex.dmg")" = "curl-fallback" ] || fail "Expected curl fallback after aria2c failure"
    assert_contains "$aria2_fallback/curl.log" "GET"
    assert_contains "$aria2_fallback/output.log" "aria2c download failed; falling back to curl"
    assert_file_not_exists "$aria2_fallback/Codex.dmg.part"
    assert_file_not_exists "$aria2_fallback/Codex.dmg.part.aria2"

    local invalid_url="$workspace/invalid-url"
    mkdir -p "$invalid_url"
    if run_dmg_cache_case "$invalid_url" "$invalid_url/output.log" \
        CODEX_UPSTREAM_DMG_URL="file:///tmp/Codex.dmg"
    then
        fail "Expected non-HTTPS upstream DMG URL to fail"
    fi
    assert_contains "$invalid_url/output.log" "Upstream DMG URL must be an HTTPS URL"
}

test_extract_dmg_repairs_safe_7z_link_warnings() {
    info "Checking DMG extraction repairs safe 7z package symlink warnings"
    local workspace="$TMP_DIR/dmg-dangerous-link-paths"
    local bin_dir="$workspace/bin"
    local work_dir="$workspace/work"
    local output_log="$workspace/output.log"
    local app_dir="$work_dir/dmg-extract/ChatGPT Installer/ChatGPT.app"
    local node_modules="$app_dir/Contents/Resources/cua_node/lib/node_modules"
    local actual

    mkdir -p "$bin_dir" "$work_dir"
    printf '%s' "fake dmg payload" >"$workspace/Codex.dmg"

    cat >"$bin_dir/7z" <<'SCRIPT'
#!/usr/bin/env bash
set -eu

out=""
for arg in "$@"; do
    case "$arg" in
        -o*)
            out="${arg#-o}"
            ;;
    esac
done
[ -n "$out" ] || exit 2

app="$out/ChatGPT Installer/ChatGPT.app"
node_modules="$app/Contents/Resources/cua_node/lib/node_modules"
mkdir -p \
    "$node_modules/.bin" \
    "$node_modules/@oai/sky/bin/linux" \
    "$node_modules/opencollective-postinstall" \
    "$node_modules/pixelmatch/bin" \
    "$node_modules/playwright" \
    "$node_modules/playwright-core" \
    "$node_modules/semver/bin" \
    "$node_modules/sharp/node_modules/.bin" \
    "$node_modules/tesseract.js/node_modules/.bin"

printf '%s\n' "target" >"$node_modules/opencollective-postinstall/index.js"
printf '%s\n' "target" >"$node_modules/pixelmatch/bin/pixelmatch"
printf '%s\n' "target" >"$node_modules/playwright/cli.js"
printf '%s\n' "target" >"$node_modules/playwright-core/cli.js"
printf '%s\n' "target" >"$node_modules/semver/bin/semver.js"
printf '%s\n' "target" >"$node_modules/@oai/sky/bin/linux/sky_linux_arm64"
printf '%s\n' "target" >"$node_modules/@oai/sky/bin/linux/sky_linux_x64"

: >"$node_modules/.bin/opencollective-postinstall"
: >"$node_modules/.bin/pixelmatch"
: >"$node_modules/.bin/playwright"
: >"$node_modules/.bin/playwright-core"
: >"$node_modules/.bin/semver"
: >"$node_modules/.bin/sky_linux_arm64"
: >"$node_modules/.bin/sky_linux_x64"
: >"$node_modules/tesseract.js/node_modules/.bin/opencollective-postinstall"
: >"$node_modules/sharp/node_modules/.bin/semver"

cat <<'LOG'
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/.bin/opencollective-postinstall : ../opencollective-postinstall/index.js
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/.bin/pixelmatch : ../pixelmatch/bin/pixelmatch
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/.bin/playwright : ../playwright/cli.js
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/.bin/playwright-core : ../playwright-core/cli.js
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/.bin/semver : ../semver/bin/semver.js
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/.bin/sky_linux_arm64 : ../@oai/sky/bin/linux/sky_linux_arm64
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/.bin/sky_linux_x64 : ../@oai/sky/bin/linux/sky_linux_x64
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/tesseract.js/node_modules/.bin/opencollective-postinstall : ../../../opencollective-postinstall/index.js
ERROR: Dangerous link path was ignored : ChatGPT Installer/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/sharp/node_modules/.bin/semver : ../../../semver/bin/semver.js

Sub items Errors: 9

Archives with Errors: 1

Sub items Errors: 9
LOG
exit 2
SCRIPT
    chmod +x "$bin_dir/7z"

    REPO_DIR="$REPO_DIR" \
    WORK_DIR="$work_dir" \
    SEVEN_ZIP_CMD="$bin_dir/7z" \
    TEST_DMG_PATH="$workspace/Codex.dmg" \
        bash <<'SCRIPT' >"$output_log" 2>&1
set -Eeuo pipefail

info() { echo "[INFO] $*" >&2; }
warn() { echo "[WARN] $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/dmg.sh"

app_dir="$(extract_dmg "$TEST_DMG_PATH")"
[ "$(basename "$app_dir")" = "ChatGPT.app" ]
SCRIPT

    assert_contains "$output_log" "7z reported 9 safe package symlink warnings; repaired and continuing"
    assert_not_contains "$output_log" "7z exited with code"
    assert_not_contains "$output_log" "Sub items Errors"

    [ -L "$node_modules/.bin/opencollective-postinstall" ] || fail "Expected repaired opencollective-postinstall symlink"
    [ "$(readlink "$node_modules/.bin/opencollective-postinstall")" = "../opencollective-postinstall/index.js" ] \
        || fail "Unexpected opencollective-postinstall symlink target"
    [ -L "$node_modules/.bin/pixelmatch" ] || fail "Expected repaired pixelmatch symlink"
    [ "$(readlink "$node_modules/.bin/pixelmatch")" = "../pixelmatch/bin/pixelmatch" ] \
        || fail "Unexpected pixelmatch symlink target"
    [ -L "$node_modules/.bin/playwright" ] || fail "Expected repaired playwright symlink"
    [ "$(readlink "$node_modules/.bin/playwright")" = "../playwright/cli.js" ] \
        || fail "Unexpected playwright symlink target"
    [ -L "$node_modules/.bin/playwright-core" ] || fail "Expected repaired playwright-core symlink"
    [ "$(readlink "$node_modules/.bin/playwright-core")" = "../playwright-core/cli.js" ] \
        || fail "Unexpected playwright-core symlink target"
    [ -L "$node_modules/.bin/semver" ] || fail "Expected repaired semver symlink"
    [ "$(readlink "$node_modules/.bin/semver")" = "../semver/bin/semver.js" ] \
        || fail "Unexpected semver symlink target"
    [ -L "$node_modules/.bin/sky_linux_arm64" ] || fail "Expected repaired sky_linux_arm64 symlink"
    [ "$(readlink "$node_modules/.bin/sky_linux_arm64")" = "../@oai/sky/bin/linux/sky_linux_arm64" ] \
        || fail "Unexpected sky_linux_arm64 symlink target"
    [ -L "$node_modules/.bin/sky_linux_x64" ] || fail "Expected repaired sky_linux_x64 symlink"
    [ "$(readlink "$node_modules/.bin/sky_linux_x64")" = "../@oai/sky/bin/linux/sky_linux_x64" ] \
        || fail "Unexpected sky_linux_x64 symlink target"
    [ -L "$node_modules/tesseract.js/node_modules/.bin/opencollective-postinstall" ] \
        || fail "Expected repaired nested opencollective-postinstall symlink"
    [ "$(readlink "$node_modules/tesseract.js/node_modules/.bin/opencollective-postinstall")" = "../../../opencollective-postinstall/index.js" ] \
        || fail "Unexpected nested opencollective-postinstall symlink target"
    [ -L "$node_modules/sharp/node_modules/.bin/semver" ] || fail "Expected repaired nested semver symlink"
    [ "$(readlink "$node_modules/sharp/node_modules/.bin/semver")" = "../../../semver/bin/semver.js" ] \
        || fail "Unexpected nested semver symlink target"

    actual="$(find "$node_modules" -path '*/.bin/*' -type l | wc -l | tr -d ' ')"
    [ "$actual" = "9" ] || fail "Expected 9 repaired symlinks, found $actual"
}

test_fresh_install_removes_cached_dmg_metadata() {
    info "Checking --fresh removes cached DMG metadata"
    local workspace="$TMP_DIR/fresh-dmg-metadata"
    local source_dir="$workspace/source"

    mkdir -p "$source_dir"
    printf '%s' "cached" >"$source_dir/Codex.dmg"
    printf '%s' "metadata" >"$source_dir/Codex.dmg.metadata"

    TEST_SOURCE_DIR="$source_dir" REPO_DIR="$REPO_DIR" bash <<'SCRIPT'
set -Eeuo pipefail

SCRIPT_DIR="$TEST_SOURCE_DIR"
WORK_DIR="$(mktemp -d)"
INSTALL_DIR="$TEST_SOURCE_DIR/codex-app"
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/install-helpers.sh"

FRESH_INSTALL=1
REUSE_CACHED_DMG=0
prepare_install
SCRIPT

    assert_file_not_exists "$source_dir/Codex.dmg"
    assert_file_not_exists "$source_dir/Codex.dmg.metadata"
}

test_fresh_pinned_dmg_preserves_cached_dmg_metadata() {
    info "Checking --fresh preserves cached DMG metadata in pinned refresh mode"
    local workspace="$TMP_DIR/fresh-pinned-dmg-metadata"
    local source_dir="$workspace/source"

    mkdir -p "$source_dir"
    printf '%s' "cached" >"$source_dir/Codex.dmg"
    printf '%s' "metadata" >"$source_dir/Codex.dmg.metadata"

    TEST_SOURCE_DIR="$source_dir" REPO_DIR="$REPO_DIR" bash <<'SCRIPT'
set -Eeuo pipefail

SCRIPT_DIR="$TEST_SOURCE_DIR"
WORK_DIR="$(mktemp -d)"
INSTALL_DIR="$TEST_SOURCE_DIR/codex-app"
CODEX_DMG_REFRESH_MODE=pinned
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/install-helpers.sh"

FRESH_INSTALL=1
REUSE_CACHED_DMG=0
prepare_install
SCRIPT

    assert_file_exists "$source_dir/Codex.dmg"
    assert_file_exists "$source_dir/Codex.dmg.metadata"
}

test_fresh_reuse_dmg_uses_cache_when_metadata_matches() {
    info "Checking --fresh --reuse-dmg reuses cached DMG when metadata matches"
    local workspace="$TMP_DIR/fresh-reuse-dmg-metadata"
    local bin_dir="$workspace/bin"
    local source_dir="$workspace/source"
    local output_log="$workspace/output.log"
    local url="https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg"
    local url_sha256

    url_sha256="$(printf '%s' "$url" | sha256sum | awk '{print $1}')"

    mkdir -p "$bin_dir" "$source_dir"
    printf '%s' "cached" >"$source_dir/Codex.dmg"
    cat >"$source_dir/Codex.dmg.metadata" <<EOF
url_sha256=$url_sha256
etag=same-etag
last_modified=Thu, 04 Jun 2026 00:00:00 GMT
content_length=6
EOF

    cat >"$bin_dir/curl" <<'SCRIPT'
#!/usr/bin/env bash
set -eu

is_head=0
for arg in "$@"; do
    if [ "$arg" = "-fsSLI" ]; then
        is_head=1
    fi
done

if [ "$is_head" -eq 1 ]; then
    printf '%s\n' "HEAD" >> "$TEST_CURL_LOG"
    printf 'HTTP/2 200\r\n'
    printf 'ETag: same-etag\r\n'
    printf 'Last-Modified: Thu, 04 Jun 2026 00:00:00 GMT\r\n'
    printf 'Content-Length: 6\r\n'
    printf '\r\n'
    exit 0
fi

printf '%s\n' "GET" >> "$TEST_CURL_LOG"
out=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
        shift
        out="$1"
    fi
    shift || true
done

[ -n "$out" ] || exit 2
printf '%s' "downloaded" >"$out"
SCRIPT
    chmod +x "$bin_dir/curl"
    : >"$source_dir/curl.log"

    PATH="$bin_dir:$PATH" \
    TEST_CURL_LOG="$source_dir/curl.log" \
    TEST_SOURCE_DIR="$source_dir" \
    REPO_DIR="$REPO_DIR" \
        bash <<'SCRIPT' >"$output_log" 2>&1
set -Eeuo pipefail

SCRIPT_DIR="$TEST_SOURCE_DIR"
WORK_DIR="$(mktemp -d)"
INSTALL_DIR="$TEST_SOURCE_DIR/codex-app"
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/install-helpers.sh"
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/dmg.sh"

FRESH_INSTALL=1
REUSE_CACHED_DMG=1
prepare_install

dmg_path="$(get_dmg)"
[ "$dmg_path" = "$TEST_SOURCE_DIR/Codex.dmg" ]
SCRIPT

    assert_file_exists "$source_dir/Codex.dmg"
    assert_file_exists "$source_dir/Codex.dmg.metadata"
    [ "$(cat "$source_dir/Codex.dmg")" = "cached" ] || fail "Expected matching metadata to keep cached DMG"
    assert_contains "$source_dir/curl.log" "HEAD"
    assert_not_contains "$source_dir/curl.log" "GET"
    assert_contains "$output_log" "Using cached DMG"
}

test_rebuild_candidate_uses_validated_default_dmg() {
    info "Checking rebuild-candidate default DMG validation flow"
    local workspace="$TMP_DIR/rebuild-candidate-dmg"
    local repo="$workspace/repo"
    local explicit_dmg="$workspace/explicit.dmg"
    local explicit_realpath
    local first_line
    local second_line

    mkdir -p "$repo/scripts"
    cp "$REPO_DIR/scripts/rebuild-candidate.sh" "$repo/scripts/rebuild-candidate.sh"
    printf '%s' "cached" >"$repo/Codex.dmg"
    printf '%s' "explicit" >"$explicit_dmg"
    explicit_realpath="$(realpath "$explicit_dmg")"

    cat >"$repo/install.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -eu
{
    printf 'CALL:'
    for arg in "$@"; do
        printf '<%s>' "$arg"
    done
    printf '\n'
} >> "$TEST_REBUILD_LOG"
SCRIPT
    chmod +x "$repo/install.sh"

    TEST_REBUILD_LOG="$workspace/default.log" \
    CODEX_NEXT_APP_DIR="$workspace/next" \
    REBUILD_REPORT_DIR="$workspace/report" \
        bash "$repo/scripts/rebuild-candidate.sh" >"$workspace/default.out" 2>&1
    first_line="$(sed -n '1p' "$workspace/default.log")"
    [ "$first_line" = "CALL:" ] || fail "Default rebuild should let the transactional installer validate its cache: $first_line"

    TEST_REBUILD_LOG="$workspace/explicit.log" \
    CODEX_NEXT_APP_DIR="$workspace/next-explicit" \
    REBUILD_REPORT_DIR="$workspace/report-explicit" \
        bash "$repo/scripts/rebuild-candidate.sh" "$explicit_dmg" >"$workspace/explicit.out" 2>&1
    first_line="$(sed -n '1p' "$workspace/explicit.log")"
    [[ "$first_line" == *"<$explicit_realpath>"* ]] || fail "Explicit transactional build should receive explicit DMG: $first_line"
}

test_make_rebuild_targets_omit_empty_dmg_argument() {
    info "Checking make rebuild targets omit an unset DMG argument"
    local workspace="$TMP_DIR/make-rebuild-dmg"
    local repo="$workspace/repo"
    local explicit_dmg="$workspace/explicit.dmg"

    mkdir -p "$repo/scripts"
    cp "$REPO_DIR/Makefile" "$repo/Makefile"
    printf '%s' "explicit" >"$explicit_dmg"

    cat >"$repo/scripts/rebuild-candidate.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -eu
printf 'CALL:'
for arg in "$@"; do
    printf '<%s>' "$arg"
done
printf '\n'
SCRIPT
    chmod +x "$repo/scripts/rebuild-candidate.sh"

    make -C "$repo" rebuild >"$workspace/rebuild-default.out"
    assert_contains "$workspace/rebuild-default.out" "CALL:"
    assert_not_contains "$workspace/rebuild-default.out" "CALL:< >"
    assert_not_contains "$workspace/rebuild-default.out" "CALL:<"

    make -C "$repo" rebuild-install >"$workspace/install-default.out"
    assert_contains "$workspace/install-default.out" "CALL:<--install>"
    assert_not_contains "$workspace/install-default.out" "CALL:<--install><"

    make -C "$repo" rebuild DMG="$explicit_dmg" >"$workspace/rebuild-explicit.out"
    assert_contains "$workspace/rebuild-explicit.out" "CALL:<$explicit_dmg>"

    make -C "$repo" rebuild-install DMG="$explicit_dmg" >"$workspace/install-explicit.out"
    assert_contains "$workspace/install-explicit.out" "CALL:<--install><$explicit_dmg>"
}

test_candidate_install_is_transactional() {
    info "Checking atomic candidate promotion, first install, and rollback"
    local workspace="$TMP_DIR/candidate-install"
    mkdir -p "$workspace/final" "$workspace/candidate"
    printf '%s' "old" >"$workspace/final/version"
    printf '%s' "new" >"$workspace/candidate/version"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        assert_install_target_not_running() { :; }
        INSTALL_DIR="$workspace/final"
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        promote_candidate_install "$workspace/candidate" "$workspace/final"
        [ "$(cat "$workspace/final/version")" = "new" ] || fail "Expected accepted candidate to be promoted"
        [ -n "$PROMOTED_BACKUP_APP_DIR" ] || fail "Expected previous app backup"
        [ "$(cat "$PROMOTED_BACKUP_APP_DIR/version")" = "old" ] || fail "Expected backup to preserve previous app"
    )

    rm -rf "$workspace/final" "$workspace/candidate" "$workspace"/final.backup-* "$workspace"/.final.promotion.json
    mkdir -p "$workspace/final" "$workspace/candidate"
    printf '%s' "old" >"$workspace/final/version"
    printf '%s' "new" >"$workspace/candidate/version"
    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        assert_install_target_not_running() { :; }
        INSTALL_DIR="$workspace/final"
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        if CODEX_PROMOTION_TEST_FAIL_BACKUP_MOVE=1 \
            promote_candidate_install "$workspace/candidate" "$workspace/final"; then
            fail "Expected simulated backup move failure"
        fi
        [ "$(cat "$workspace/final/version")" = "old" ] || fail "Expected failed backup move to atomically restore previous app"
        [ "$(cat "$workspace/candidate/version")" = "new" ] || fail "Expected rollback to preserve the accepted candidate"
        [ ! -e "$workspace/.final.promotion.json" ] || fail "Expected rollback to remove the promotion journal"
    )

    rm -rf "$workspace/final" "$workspace/candidate" "$workspace"/final.backup-* "$workspace"/.final.promotion.json
    mkdir -p "$workspace/final" "$workspace/candidate"
    printf '%s' "old" >"$workspace/final/version"
    printf '%s' "new" >"$workspace/candidate/version"
    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; return 1; }
        assert_install_target_not_running() { :; }
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        if CODEX_PROMOTION_TEST_FAIL_EXCHANGE=1 \
            promote_candidate_install "$workspace/candidate" "$workspace/final"; then
            fail "Expected simulated unsupported atomic exchange"
        fi
        [ "$(cat "$workspace/final/version")" = "old" ] || fail "Unsupported exchange changed the current app"
        [ "$(cat "$workspace/candidate/version")" = "new" ] || fail "Unsupported exchange changed the candidate"
    )

    rm -rf "$workspace/final" "$workspace/candidate" "$workspace"/final.backup-* "$workspace"/.final.promotion.json
    mkdir -p "$workspace/candidate"
    printf '%s' "new" >"$workspace/candidate/version"
    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; return 1; }
        assert_install_target_not_running() { :; }
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        promote_candidate_install "$workspace/candidate" "$workspace/final"
        [ "$(cat "$workspace/final/version")" = "new" ] || fail "Expected first install to use an atomic rename"
        [ -z "$PROMOTED_BACKUP_APP_DIR" ] || fail "First install must not report a backup"
    )
}

test_candidate_promotion_stops_when_journal_prepare_fails() {
    info "Checking journal preparation failure cannot reach atomic exchange"
    local workspace="$TMP_DIR/candidate-prepare-failure"
    local helper="$workspace/promotion-helper"
    local helper_log="$workspace/promotion-helper.log"
    mkdir -p "$workspace/final" "$workspace/candidate"
    printf '%s' "old" >"$workspace/final/version"
    printf '%s' "new" >"$workspace/candidate/version"
    cat >"$helper" <<'PY'
#!/usr/bin/env python3
import os
import sys

with open(os.environ["CODEX_PROMOTION_TEST_HELPER_LOG"], "a", encoding="utf-8") as handle:
    handle.write(f"{sys.argv[1]}\n")
if sys.argv[1] == "prepare":
    raise SystemExit(1)
PY
    chmod +x "$helper"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; return 1; }
        assert_install_target_not_running() { :; }
        export CODEX_CANDIDATE_PROMOTION_HELPER="$helper"
        export CODEX_PROMOTION_TEST_HELPER_LOG="$helper_log"
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        if promote_candidate_install "$workspace/candidate" "$workspace/final"; then
            fail "Expected journal preparation failure to stop promotion"
        fi
    )
    assert_contains "$helper_log" "prepare"
    assert_not_contains "$helper_log" "exchange"
    [ "$(cat "$workspace/final/version")" = "old" ] || fail "Journal preparation failure changed the current app"
    [ "$(cat "$workspace/candidate/version")" = "new" ] || fail "Journal preparation failure changed the candidate"
}

test_candidate_prepare_failure_cleans_transaction_metadata() {
    info "Checking failed journal preparation cleans its transaction metadata"
    local workspace="$TMP_DIR/candidate-prepare-cleanup"
    local journal="$workspace/.final.promotion.json"
    mkdir -p "$workspace/final" "$workspace/candidate"
    printf '%s' "old" >"$workspace/final/version"
    printf '%s' "new" >"$workspace/candidate/version"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; return 1; }
        assert_install_target_not_running() { :; }
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        if CODEX_PROMOTION_TEST_FAIL_PREPARE_AFTER_JOURNAL=1 \
            promote_candidate_install "$workspace/candidate" "$workspace/final"; then
            fail "Expected simulated post-journal preparation failure"
        fi
    )
    [ ! -e "$journal" ] || fail "Failed preparation left a promotion journal"
    [ ! -e "$workspace/candidate/.codex-promotion-transaction" ] \
        || fail "Failed preparation left a candidate transaction marker"
    [ "$(cat "$workspace/final/version")" = "old" ] || fail "Failed preparation changed the current app"
    [ "$(cat "$workspace/candidate/version")" = "new" ] || fail "Failed preparation changed the candidate"

    python3 "$REPO_DIR/scripts/lib/candidate-promotion.py" prepare \
        --candidate "$workspace/candidate" \
        --final "$workspace/final" \
        --backup "$workspace/final.backup-retry" \
        --journal "$journal" \
        --transaction retry
    python3 "$REPO_DIR/scripts/lib/candidate-promotion.py" abort --journal "$journal"
}

test_candidate_first_install_rename_failure_propagates() {
    info "Checking first-install rename failure fails promotion"
    local workspace="$TMP_DIR/candidate-rename-failure"
    mkdir -p "$workspace/candidate"
    printf '%s' "new" >"$workspace/candidate/version"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; return 1; }
        assert_install_target_not_running() { :; }
        mv() { return 1; }
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        if promote_candidate_install "$workspace/candidate" "$workspace/final"; then
            fail "Expected first-install rename failure to fail promotion"
        fi
    )
    [ "$(cat "$workspace/candidate/version")" = "new" ] || fail "Rename failure changed the candidate"
    [ ! -e "$workspace/final" ] || fail "Rename failure unexpectedly created the final app"
}

test_candidate_promotion_refuses_a_running_final_app() {
    info "Checking user-local promotion cannot replace a running app"
    local workspace="$TMP_DIR/candidate-running-app"
    local electron_pid
    mkdir -p "$workspace/final" "$workspace/candidate"
    cp "$BASH" "$workspace/final/electron"
    printf '%s' "old" >"$workspace/final/version"
    printf '%s' "new" >"$workspace/candidate/version"
    "$workspace/final/electron" --noprofile --norc -c \
        'trap "exit 0" TERM INT; while :; do sleep 0.1; done' &
    electron_pid=$!
    while [ ! -e "/proc/$electron_pid/exe" ]; do sleep 0.01; done

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; return 1; }
        CODEX_APP_ID="codex-desktop-test"
        INSTALL_DIR="$workspace/final"
        # shellcheck source=scripts/lib/process-detection.sh
        . "$REPO_DIR/scripts/lib/process-detection.sh"
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        if promote_candidate_install "$workspace/candidate" "$workspace/final"; then
            fail "Promotion unexpectedly replaced a running app"
        fi
    )
    [ "$(cat "$workspace/final/version")" = "old" ] || fail "Running app promotion changed the final directory"
    [ "$(cat "$workspace/candidate/version")" = "new" ] || fail "Running app promotion changed the candidate"
    [ ! -e "$workspace/.final.promotion.json" ] || fail "Running app refusal must happen before journal creation"

    kill "$electron_pid"
    wait "$electron_pid" 2>/dev/null || true
    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        CODEX_APP_ID="codex-desktop-test"
        INSTALL_DIR="$workspace/final"
        . "$REPO_DIR/scripts/lib/process-detection.sh"
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        promote_candidate_install "$workspace/candidate" "$workspace/final"
    )
    [ "$(cat "$workspace/final/version")" = "new" ] || fail "Promotion did not succeed after the app exited"
}

test_candidate_backup_retention_is_bounded() {
    info "Checking promotion retains only the immediate previous app backup"
    local workspace="$TMP_DIR/candidate-backup-retention"
    local managed_count=0
    local path name suffix
    mkdir -p "$workspace/final" "$workspace/candidate"
    printf '%s' "v1" >"$workspace/final/version"
    printf '%s' "v2" >"$workspace/candidate/version"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        assert_install_target_not_running() { :; }
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        promote_candidate_install "$workspace/candidate" "$workspace/final"
    )

    mkdir -p "$workspace/final.backup-20200101010101/nested" "$workspace/final.backup-manual"
    printf '%s' "stale" >"$workspace/final.backup-20200101010101/version"
    chmod 0555 "$workspace/final.backup-20200101010101" "$workspace/final.backup-20200101010101/nested"
    printf '%s' "manual" >"$workspace/final.backup-20200101010103"
    mkdir -p "$workspace/symlink-target"
    ln -s "$workspace/symlink-target" "$workspace/final.backup-20200101010102"
    mkdir -p "$workspace/candidate"
    printf '%s' "v3" >"$workspace/candidate/version"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        assert_install_target_not_running() { :; }
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        promote_candidate_install "$workspace/candidate" "$workspace/final"
    )

    for path in "$workspace"/final.backup-*; do
        [ -d "$path" ] || continue
        [ ! -L "$path" ] || continue
        name="$(basename "$path")"
        suffix="${name#final.backup-}"
        [[ "$suffix" =~ ^[0-9]{14}(-[1-9][0-9]*)?$ ]] || continue
        managed_count=$((managed_count + 1))
        [ "$(cat "$path/version")" = "v2" ] || fail "Retention kept a backup other than the immediate previous app"
    done
    [ "$managed_count" -eq 1 ] || fail "Expected exactly one managed app backup, found $managed_count"
    [ -L "$workspace/final.backup-20200101010102" ] || fail "Managed cleanup removed an exact-name symlink"
    [ -f "$workspace/final.backup-20200101010103" ] || fail "Managed cleanup removed an exact-name file"
    [ -d "$workspace/final.backup-manual" ] || fail "Managed cleanup removed a manually named directory"
}

test_candidate_promotion_recovers_after_sigkill() {
    info "Checking interrupted candidate promotion keeps the app available and recovers its backup"
    local workspace="$TMP_DIR/candidate-promotion-interruption"
    local pause_file="$workspace/exchanged"
    local promotion_pid
    local recovered_backup
    mkdir -p "$workspace/final" "$workspace/candidate"
    mkdir -p "$workspace/final.backup-20200101010101"
    printf '%s' "stale" >"$workspace/final.backup-20200101010101/version"
    printf '%s' "old" >"$workspace/final/version"
    printf '%s' "new" >"$workspace/candidate/version"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        assert_install_target_not_running() { :; }
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        CODEX_PROMOTION_TEST_PAUSE_FILE="$pause_file" \
            promote_candidate_install "$workspace/candidate" "$workspace/final"
    ) &
    promotion_pid=$!
    while [ ! -e "$pause_file" ]; do
        kill -0 "$promotion_pid" 2>/dev/null || fail "Promotion exited before the post-exchange pause"
        sleep 0.01
    done

    [ "$(cat "$workspace/final/version")" = "new" ] || fail "Canonical app path disappeared or did not contain the accepted app"
    kill -KILL "$promotion_pid"
    wait "$promotion_pid" 2>/dev/null || true
    [ "$(cat "$workspace/final/version")" = "new" ] || fail "SIGKILL left the canonical app unavailable"
    [ -f "$workspace/.final.promotion.json" ] || fail "Expected durable recovery journal after SIGKILL"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        recover_pending_candidate_promotion "$workspace/final"
    )
    recovered_backup="$(find "$workspace" -maxdepth 1 -type d -name 'final.backup-*' -print -quit)"
    [ -n "$recovered_backup" ] || fail "Expected interrupted promotion recovery to create the backup"
    [ "$(cat "$recovered_backup/version")" = "old" ] || fail "Recovered backup did not preserve the previous app"
    [ ! -e "$workspace/.final.promotion.json" ] || fail "Expected recovery to clear the promotion journal"
    [ ! -e "$workspace/final/.codex-promotion-transaction" ] || fail "Expected recovery to clear the transaction marker"
    [ "$(find "$workspace" -maxdepth 1 -type d -name 'final.backup-*' | wc -l)" -eq 1 ] \
        || fail "Interrupted recovery must retain only the recovered previous app"
}

test_candidate_backup_cleanup_retries_after_failure() {
    info "Checking backup cleanup failure is fail-soft and retried"
    local workspace="$TMP_DIR/candidate-backup-cleanup-retry"
    mkdir -p "$workspace/final" "$workspace/candidate" "$workspace/final.backup-20200101010101"
    printf '%s' "v1" >"$workspace/final/version"
    printf '%s' "v2" >"$workspace/candidate/version"
    printf '%s' "stale" >"$workspace/final.backup-20200101010101/version"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        assert_install_target_not_running() { :; }
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        CODEX_PROMOTION_TEST_FAIL_BACKUP_CLEANUP=1 \
            promote_candidate_install "$workspace/candidate" "$workspace/final"
    )
    [ "$(cat "$workspace/final/version")" = "v2" ] || fail "Cleanup failure rolled back the accepted app"
    [ "$(find "$workspace" -maxdepth 1 -type d -name 'final.backup-*' | wc -l)" -gt 1 ] \
        || fail "Simulated cleanup failure did not leave work for retry"

    (
        info() { :; }
        warn() { :; }
        error() { echo "$*" >&2; exit 1; }
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        recover_pending_candidate_promotion "$workspace/final"
    )
    [ "$(find "$workspace" -maxdepth 1 -type d -name 'final.backup-*' | wc -l)" -eq 1 ] \
        || fail "Next recovery did not retry managed backup cleanup"
}

test_user_local_updates_preserve_the_running_app_gate() {
    info "Checking automated user-local updates cannot inherit the running-app override"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/bin/codex-desktop-update" "CODEX_INSTALL_ALLOW_RUNNING=0"
    assert_not_contains "$REPO_DIR/contrib/user-local-install/files/.local/bin/codex-desktop-update" "CODEX_INSTALL_ALLOW_RUNNING=1"
    assert_contains "$REPO_DIR/updater/src/wrapper_apply.rs" '.env("CODEX_INSTALL_ALLOW_RUNNING", "0")'
    assert_not_contains "$REPO_DIR/updater/src/wrapper_apply.rs" '.env("CODEX_INSTALL_ALLOW_RUNNING", "1")'
}

test_candidate_promotion_is_serialized() {
    info "Checking accepted candidate promotion is serialized per target"
    local workspace="$TMP_DIR/candidate-promotion-lock"
    local candidate="$workspace/candidate"
    local final="$workspace/final"
    local lock_file="$workspace/.final.promotion.lock"
    local release_fifo="$workspace/release"
    mkdir -p "$candidate"
    printf '%s\n' "new" >"$candidate/version"
    mkfifo "$release_fifo"

    (
        exec 8>"$lock_file"
        flock 8
        touch "$workspace/locked"
        read -r _ <"$release_fifo"
    ) &
    local holder_pid=$!
    while [ ! -f "$workspace/locked" ]; do sleep 0.01; done

    (
        error() { echo "[test][ERROR] $*" >&2; return 1; }
        info() { :; }
        warn() { :; }
        assert_install_target_not_running() { :; }
        # shellcheck source=scripts/lib/candidate-install.sh
        . "$REPO_DIR/scripts/lib/candidate-install.sh"
        promote_candidate_install "$candidate" "$final"
    ) &
    local promotion_pid=$!
    sleep 0.1
    [ -d "$candidate" ] || fail "Promotion advanced while another process held the target lock"
    printf '%s\n' "release" >"$release_fifo"
    wait "$holder_pid"
    wait "$promotion_pid"
    [ "$(cat "$final/version")" = "new" ] || fail "Serialized promotion did not install the candidate"
}

test_transactional_install_reenters_with_current_bash() {
    info "Checking transactional install re-entry uses the active Bash binary"
    assert_contains "$REPO_DIR/install.sh" '"\$BASH" "\$SCRIPT_DIR/install.sh" "\${original_args\[@\]}"'
}

test_transactional_install_uses_managed_node_and_isolated_reports() {
    info "Checking transactional acceptance uses managed Node and isolated reports"
    assert_contains "$REPO_DIR/install.sh" 'CODEX_ACCEPTANCE_NODE="\$CODEX_MANAGED_NODE_RUNTIME_DIR/bin/node"'
    assert_contains "$REPO_DIR/install.sh" 'report_dir="\$report_base/transactions/\$transaction_id"'
    assert_contains "$REPO_DIR/install.sh" '"\$CODEX_ACCEPTANCE_NODE" "\$SCRIPT_DIR/scripts/validate-upstream-dmg.js"'
}

test_installer_cleanup_handles_readonly_trees() {
    info "Checking installer cleanup handles immutable-source directory modes"
    local workspace="$TMP_DIR/readonly-installer-cleanup"
    local work_dir="$workspace/work"
    mkdir -p "$work_dir/runtime/lib"
    printf '%s\n' "runtime" >"$work_dir/runtime/lib/node"
    chmod 0555 "$work_dir" "$work_dir/runtime" "$work_dir/runtime/lib"
    (
        WORK_DIR="$work_dir"
        # shellcheck source=scripts/lib/install-helpers.sh
        . "$REPO_DIR/scripts/lib/install-helpers.sh"
        cleanup
        trap - EXIT ERR
    )
    [ ! -e "$work_dir" ] || fail "Expected cleanup to remove a read-only copied tree"
}

test_native_shortcut_targets_compose_existing_flows() {
    info "Checking native install/update shortcut targets"
    local install_log="$TMP_DIR/make-install-native.log"
    local bootstrap_log="$TMP_DIR/make-bootstrap-native.log"
    local update_log="$TMP_DIR/make-update-native.log"
    local setup_log="$TMP_DIR/make-setup-native.log"

    make -n -C "$REPO_DIR" install-native >"$install_log"
    assert_contains "$install_log" './install.sh --fresh --reuse-dmg'
    assert_contains "$install_log" 'Building native package'
    assert_contains "$install_log" 'Installing latest native package'

    make -n -C "$REPO_DIR" bootstrap-native >"$bootstrap_log"
    assert_contains "$bootstrap_log" 'bash scripts/install-deps.sh'
    assert_contains "$bootstrap_log" 'PATH="$HOME/.cargo/bin:$PATH"'
    assert_contains "$bootstrap_log" 'install-native'
    assert_not_contains "$bootstrap_log" 'bootstrap-wizard.sh'

    make -n -C "$REPO_DIR" update-native >"$update_log"
    assert_contains "$update_log" 'git pull --ff-only'
    assert_contains "$update_log" 'install-native'

    make -n -C "$REPO_DIR" setup-native >"$setup_log"
    assert_contains "$setup_log" 'bash scripts/bootstrap-wizard.sh'
}

test_sudo_alert_wrapper() {
    info "Checking opt-in sudo password alerts"
    local workspace="$TMP_DIR/sudo-alert"
    local bin_dir="$workspace/bin"
    local log_file="$workspace/events.log"
    local sound_file="$workspace/dialog-warning.oga"
    local wrapper="$REPO_DIR/scripts/sudo-with-alert.sh"
    mkdir -p "$bin_dir"
    : > "$sound_file"

    cat > "$bin_dir/sudo" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'sudo:%s\n' "$*" >> "$SUDO_ALERT_TEST_LOG"
if [ "${1-}" = "-n" ] && [ "${2-}" = "-v" ]; then
    exit "${SUDO_ALERT_TEST_CACHE_STATUS:-0}"
fi
if [ "${1-}" = "-v" ]; then
    exit "${SUDO_ALERT_TEST_AUTH_STATUS:-0}"
fi
exit "${SUDO_ALERT_TEST_COMMAND_STATUS:-0}"
EOF
    chmod +x "$bin_dir/sudo"

    cat > "$bin_dir/pw-play" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'alert:%s\n' "$*" >> "$SUDO_ALERT_TEST_LOG"
exit "${SUDO_ALERT_TEST_SOUND_STATUS:-0}"
EOF
    chmod +x "$bin_dir/pw-play"

    : > "$log_file"
    PATH="$bin_dir:$HOST_TOOL_PATH" SUDO_ALERT_TEST_LOG="$log_file" \
        "$wrapper" true
    assert_occurrence_count "$log_file" '^sudo:true$' 1
    assert_not_contains "$log_file" 'sudo:-n -v'
    assert_not_contains "$log_file" 'alert:'

    : > "$log_file"
    CODEX_SUDO_ALERT=1 PATH="$bin_dir:$HOST_TOOL_PATH" SUDO_ALERT_TEST_LOG="$log_file" \
        "$wrapper" true
    assert_contains "$log_file" 'sudo:-n -v'
    assert_not_contains "$log_file" 'alert:'
    assert_contains "$log_file" 'sudo:true'

    : > "$log_file"
    CODEX_SUDO_ALERT=1 CODEX_SUDO_ALERT_SOUND_FILE="$sound_file" SUDO_ALERT_TEST_CACHE_STATUS=1 \
        PATH="$bin_dir:$HOST_TOOL_PATH" SUDO_ALERT_TEST_LOG="$log_file" \
        "$wrapper" true
    [ "$(sed -n '1p' "$log_file")" = 'sudo:-n -v' ] || fail "Expected cached sudo check first"
    [ "$(sed -n '2p' "$log_file")" = "alert:$sound_file" ] \
        || fail "Expected alert before authentication"
    [ "$(sed -n '3p' "$log_file")" = 'sudo:-v' ] || fail "Expected sudo authentication after alert"
    [ "$(sed -n '4p' "$log_file")" = 'sudo:true' ] || fail "Expected command after authentication"

    : > "$log_file"
    CODEX_SUDO_ALERT=1 CODEX_SUDO_ALERT_SOUND_FILE="$sound_file" SUDO_ALERT_TEST_CACHE_STATUS=1 SUDO_ALERT_TEST_SOUND_STATUS=1 \
        PATH="$bin_dir:$HOST_TOOL_PATH" SUDO_ALERT_TEST_LOG="$log_file" \
        "$wrapper" true 2>/dev/null
    assert_contains "$log_file" 'sudo:-v'
    assert_contains "$log_file" 'sudo:true'

    : > "$log_file"
    local status=0
    CODEX_SUDO_ALERT=1 SUDO_ALERT_TEST_CACHE_STATUS=1 SUDO_ALERT_TEST_AUTH_STATUS=23 \
        PATH="$bin_dir:$HOST_TOOL_PATH" SUDO_ALERT_TEST_LOG="$log_file" \
        "$wrapper" true 2>/dev/null || status=$?
    [ "$status" -eq 23 ] || fail "Expected sudo authentication failure status, got $status"
    assert_not_contains "$log_file" 'sudo:true'

    : > "$log_file"
    status=0
    CODEX_SUDO_ALERT=1 SUDO_ALERT_TEST_COMMAND_STATUS=17 \
        PATH="$bin_dir:$HOST_TOOL_PATH" SUDO_ALERT_TEST_LOG="$log_file" \
        "$wrapper" true || status=$?
    [ "$status" -eq 17 ] || fail "Expected privileged command status, got $status"
}

test_native_sudo_alert_wiring() {
    info "Checking native targets route sudo through the alert wrapper"
    local install_log="$TMP_DIR/make-install-sudo-alert.log"
    local bootstrap_log="$TMP_DIR/make-bootstrap-sudo-alert.log"
    local update_log="$TMP_DIR/make-update-sudo-alert.log"

    CODEX_SUDO_ALERT=1 make -n -C "$REPO_DIR" install >"$install_log"
    assert_occurrence_count "$install_log" 'scripts/sudo-with-alert.sh' 5

    CODEX_SUDO_ALERT=1 make -n -C "$REPO_DIR" bootstrap-native >"$bootstrap_log"
    assert_contains "$bootstrap_log" 'bash scripts/install-deps.sh'
    assert_contains "$bootstrap_log" 'install-native'

    CODEX_SUDO_ALERT=1 make -n -C "$REPO_DIR" update-native >"$update_log"
    assert_contains "$update_log" 'git pull --ff-only'
    assert_contains "$update_log" 'install-native'

    assert_contains "$REPO_DIR/scripts/install-deps.sh" 'sudo-with-alert.sh'
    assert_contains "$REPO_DIR/Makefile" 'CODEX_SUDO_ALERT=1'
}

test_fedora_dependency_bootstrap_installs_rpmbuild() {
    info "Checking Fedora dependency bootstrap includes rpmbuild and C++ build tools"
    local install_deps="$REPO_DIR/scripts/install-deps.sh"
    local helper="$REPO_DIR/scripts/lib/install-helpers.sh"
    local readme="$REPO_DIR/README.md"

    awk '/^install_dnf5\(\) \{/,/^}/' "$install_deps" | grep -q -- "rpm-build" \
        || fail "install_dnf5 must install rpm-build for rpmbuild"
    awk '/^install_dnf\(\) \{/,/^}/' "$install_deps" | grep -q -- "rpm-build" \
        || fail "install_dnf must install rpm-build for rpmbuild"
    awk '/^install_dnf5\(\) \{/,/^}/' "$install_deps" | grep -q -- "gcc-c++" \
        || fail "install_dnf5 must install gcc-c++ for g++"
    awk '/^install_dnf\(\) \{/,/^}/' "$install_deps" | grep -q -- "gcc-c++" \
        || fail "install_dnf must install gcc-c++ for g++"

    assert_contains "$install_deps" "sudo dnf install python3 7zip curl unzip rpm-build make gcc-c++ @development-tools"
    assert_contains "$install_deps" "sudo dnf install nodejs npm python3 p7zip p7zip-plugins curl unzip rpm-build make gcc-c++"
    assert_contains "$helper" "sudo dnf install python3 7zip curl unzip rpm-build make gcc-c++ @development-tools"
    assert_contains "$helper" "sudo dnf install nodejs npm python3 p7zip p7zip-plugins curl unzip rpm-build make gcc-c++"
    assert_contains "$readme" "sudo dnf install python3 7zip curl unzip rpm-build make gcc-c++ @development-tools"
    assert_contains "$readme" "sudo dnf install python3 p7zip p7zip-plugins curl unzip rpm-build make gcc-c++"
}

test_fedora_atomic_rpm_ostree_target_detection() {
    info "Checking Fedora Atomic rpm-ostree target detection"
    local workspace="$TMP_DIR/fedora-atomic-target"
    local fake_bin="$workspace/bin"
    local os_release="$workspace/os-release"
    local ostree_booted="$workspace/ostree-booted"
    local install_log="$workspace/install-deps.log"
    local wizard_log="$workspace/bootstrap-wizard.log"
    local helper_output="$workspace/helper-output.log"

    mkdir -p "$fake_bin"
    printf '%s\n' "#!$BASH_BIN" 'exit 0' > "$fake_bin/rpm-ostree"
    printf '%s\n' "#!$BASH_BIN" 'exit 0' > "$fake_bin/rpmbuild"
    chmod +x "$fake_bin/rpm-ostree" "$fake_bin/rpmbuild"
    cat > "$os_release" <<'EOF'
ID=fedora
ID_LIKE=
VERSION_ID="44"
PRETTY_NAME="Fedora Linux 44 (KDE Plasma Desktop Edition)"
VARIANT_ID=kde
EOF
    : > "$ostree_booted"

    PATH="$fake_bin:$PATH" \
    OS_RELEASE_FILE="$os_release" \
    OSTREE_BOOTED_FILE="$ostree_booted" \
    DETECT_ONLY=1 \
        "$BASH_BIN" "$REPO_DIR/scripts/install-deps.sh" >"$install_log"
    assert_contains "$install_log" "Detected dependency profile: rpm-ostree"
    assert_contains "$install_log" "ID=fedora"
    assert_not_contains "$install_log" "ID_LIKE=ubuntu"

    local missing_bin="$workspace/missing-bin"
    local missing_log="$workspace/install-deps-missing.log"
    mkdir -p "$missing_bin"
    for command in dirname pwd uname; do
        ln -s "$(command -v "$command")" "$missing_bin/$command"
    done
    printf '%s\n' "#!$BASH_BIN" 'exit 0' > "$missing_bin/rpm-ostree"
    chmod +x "$missing_bin/rpm-ostree"

    local status=0
    PATH="$missing_bin" \
    OS_RELEASE_FILE="$os_release" \
    OSTREE_BOOTED_FILE="$ostree_booted" \
    HOME="$workspace/home-missing" \
        "$BASH_BIN" "$REPO_DIR/scripts/install-deps.sh" >"$missing_log" 2>&1 || status=$?
    [ "$status" -ne 0 ] || fail "Expected rpm-ostree install-deps to stop before packages are layered"
    assert_contains "$missing_log" "sudo rpm-ostree install python3 7zip curl unzip rpm-build make gcc-c++"
    assert_contains "$missing_log" "Still missing:"
    assert_not_contains "$missing_log" "nodejs npm"

    local layered_bin="$workspace/layered-bin"
    local layered_log="$workspace/install-deps-layered.log"
    mkdir -p "$layered_bin"
    for command in dirname pwd uname grep; do
        ln -s "$(command -v "$command")" "$layered_bin/$command"
    done
    for command in rpm-ostree python3 7zz curl unzip rpmbuild make g++ cargo; do
        printf '%s\n' "#!$BASH_BIN" > "$layered_bin/$command"
        cat >> "$layered_bin/$command" <<'SCRIPT'
command_name="${0##*/}"
case "$command_name" in
    7zz) echo "7-Zip 26.00" ;;
    cargo) echo "cargo 1.96.0" ;;
    *) exit 0 ;;
esac
SCRIPT
        chmod +x "$layered_bin/$command"
    done

    PATH="$layered_bin" \
    OS_RELEASE_FILE="$os_release" \
    OSTREE_BOOTED_FILE="$ostree_booted" \
    HOME="$workspace/home-layered" \
        "$BASH_BIN" "$REPO_DIR/scripts/install-deps.sh" >"$layered_log" 2>&1
    assert_contains "$layered_log" "rpm-ostree layered build dependencies are already available"
    assert_contains "$layered_log" "Skipping system Node.js check; install.sh provides the managed Node.js runtime"
    assert_contains "$layered_log" "All dependencies installed"
    assert_not_contains "$layered_log" "Node.js 20+ with npm and npx is required"

    PATH="$fake_bin:$PATH" \
    OS_RELEASE_FILE="$os_release" \
    OSTREE_BOOTED_FILE="$ostree_booted" \
    CODEX_BOOTSTRAP_DRY_RUN=1 \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$REPO_DIR/linux-features" \
    CODEX_LINUX_FEATURES_CONFIG="$workspace/features.json" \
        "$BASH_BIN" "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$wizard_log"
    assert_contains "$wizard_log" "Package manager: rpm-ostree"
    assert_contains "$wizard_log" "Native package format: rpm"
    assert_contains "$wizard_log" "Atomic host: yes"

    CODEX_LINUX_TARGET_ATOMIC=maybe \
    PATH="$fake_bin" \
    OS_RELEASE_FILE="$os_release" \
    OSTREE_BOOTED_FILE="$ostree_booted" \
    "$BASH_BIN" -c '
        # shellcheck disable=SC1091
        source "$1"
        OS_RELEASE_ID="$(os_release_field ID)"
        OS_RELEASE_ID_LIKE="$(os_release_field ID_LIKE 2>/dev/null || true)"
        OS_RELEASE_VERSION_ID="$(os_release_field VERSION_ID)"
        printf "manager=%s\natomic=%s\n" \
            "$(detect_package_manager)" \
            "$(linux_target_is_atomic && echo yes || echo no)"
    ' _ "$REPO_DIR/scripts/lib/linux-target-detect.sh" >"$helper_output"
    assert_contains "$helper_output" "manager=rpm-ostree"
    assert_contains "$helper_output" "atomic=yes"

    CODEX_LINUX_TARGET_ATOMIC=0 \
    PATH="$fake_bin" \
    OS_RELEASE_FILE="$os_release" \
    OSTREE_BOOTED_FILE="$ostree_booted" \
    "$BASH_BIN" -c '
        # shellcheck disable=SC1091
        source "$1"
        OS_RELEASE_ID="$(os_release_field ID)"
        OS_RELEASE_ID_LIKE="$(os_release_field ID_LIKE 2>/dev/null || true)"
        OS_RELEASE_VERSION_ID="$(os_release_field VERSION_ID)"
        printf "manager=%s\natomic=%s\n" \
            "$(detect_package_manager)" \
            "$(linux_target_is_atomic && echo yes || echo no)"
    ' _ "$REPO_DIR/scripts/lib/linux-target-detect.sh" >"$helper_output"
    assert_contains "$helper_output" "manager=unknown"
    assert_contains "$helper_output" "atomic=no"

    rm -f "$ostree_booted"
    PATH="$fake_bin" \
    OS_RELEASE_FILE="$os_release" \
    OSTREE_BOOTED_FILE="$ostree_booted" \
    "$BASH_BIN" -c '
        # shellcheck disable=SC1091
        source "$1"
        OS_RELEASE_ID="$(os_release_field ID)"
        OS_RELEASE_ID_LIKE="$(os_release_field ID_LIKE 2>/dev/null || true)"
        OS_RELEASE_VERSION_ID="$(os_release_field VERSION_ID)"
        printf "manager=%s\nformat=%s\natomic=%s\n" \
            "$(detect_package_manager)" \
            "$(detect_package_format)" \
            "$(linux_target_is_atomic && echo yes || echo no)"
    ' _ "$REPO_DIR/scripts/lib/linux-target-detect.sh" >"$helper_output"
    assert_contains "$helper_output" "manager=unknown"
    assert_contains "$helper_output" "format=rpm"
    assert_contains "$helper_output" "atomic=no"
}

test_setup_native_wizard_noninteractive_feature_writer() {
    info "Checking setup-native wizard non-interactive feature writer"
    local workspace="$TMP_DIR/setup-native-writer"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    cat > "$config" <<'JSON'
{
  "enabled": [
    "conversation-mode"
  ],
  "settings": {
    "ui-tweaks": {
      "tweaks": {
        "sidebar": {
          "projectName": {
            "style": "font-weight: 700 !important; padding-top: 0.25rem;"
          }
        }
      }
    }
  }
}
JSON

    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
    CODEX_LINUX_FEATURES="remote-mobile-control,read-aloud" \
    CODEX_LINUX_DISABLE_FEATURES="conversation-mode" \
    PACKAGE_WITH_UPDATER=0 \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_json_enabled_equals "$config" '["remote-mobile-control","read-aloud"]'
    node - "$config" <<'NODE' || fail "Expected setup-native wizard to preserve Linux feature settings"
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (config.settings?.["ui-tweaks"]?.tweaks?.sidebar?.projectName?.style !== "font-weight: 700 !important; padding-top: 0.25rem;") {
  process.exit(1);
}
NODE
    assert_contains "$output_log" "remote-mobile-control"
    assert_contains "$output_log" "read-aloud"
    assert_contains "$output_log" "Manual-update native package mode selected"
    assert_contains "$output_log" "PACKAGE_WITH_UPDATER=0 make install-native"
    assert_contains "$output_log" "Feature changes apply after rebuilding and reinstalling"
}

test_setup_native_wizard_rejects_invalid_feature_ids() {
    info "Checking setup-native wizard invalid feature validation"
    local workspace="$TMP_DIR/setup-native-invalid-feature"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":[]}' > "$config"

    if CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
        CODEX_LINUX_FEATURES_ROOT="$features_root" \
        CODEX_LINUX_FEATURES_CONFIG="$config" \
        CODEX_LINUX_FEATURES="missing-feature" \
            bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log" 2>&1; then
        fail "setup wizard should reject unknown feature ids"
    fi

    assert_contains "$output_log" "Unknown Linux feature id: missing-feature"
    assert_json_enabled_equals "$config" '[]'
}

test_setup_native_wizard_rejects_features_without_readme() {
    info "Checking setup-native wizard rejects undocumented Linux features"
    local workspace="$TMP_DIR/setup-native-missing-readme"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    rm -f "$features_root/read-aloud/README.md"
    printf '%s\n' '{"enabled":[]}' > "$config"

    if CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
        CODEX_LINUX_FEATURES_ROOT="$features_root" \
        CODEX_LINUX_FEATURES_CONFIG="$config" \
        CODEX_LINUX_FEATURES="read-aloud" \
            bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log" 2>&1; then
        fail "setup wizard should reject Linux features without README.md"
    fi

    assert_contains "$output_log" "must include README.md next to feature.json"
    assert_json_enabled_equals "$config" '[]'
}

test_setup_native_wizard_rejects_conflicting_feature_ids() {
    info "Checking setup-native wizard conflicting feature validation"
    local workspace="$TMP_DIR/setup-native-conflicting-feature"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":[]}' > "$config"

    if CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
        CODEX_LINUX_FEATURES_ROOT="$features_root" \
        CODEX_LINUX_FEATURES_CONFIG="$config" \
        CODEX_LINUX_FEATURES="read-aloud" \
        CODEX_LINUX_DISABLE_FEATURES="read-aloud" \
            bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log" 2>&1; then
        fail "setup wizard should reject conflicting feature ids"
    fi

    assert_contains "$output_log" "Linux feature ids cannot be both enabled and disabled: read-aloud"
    assert_json_enabled_equals "$config" '[]'
}

test_setup_native_wizard_disable_is_non_destructive() {
    info "Checking setup-native wizard opt-out guidance is non-destructive"
    local workspace="$TMP_DIR/setup-native-disable-safe"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"
    local key_file="$fake_home/.config/codex-desktop/remote-control-device-keys/remote-control-device-keys-v1.json"
    local model_file="$fake_home/.local/share/codex-desktop/read-aloud/kokoro-venv/bin/python"
    local plugin_cache="$fake_home/.codex/plugins/cache/openai-bundled/read-aloud"

    make_wizard_feature_root "$features_root"
    cat > "$config" <<'JSON'
{"enabled":["remote-mobile-control","read-aloud","read-aloud-mcp"]}
JSON
    mkdir -p "$(dirname "$key_file")" "$(dirname "$model_file")" "$plugin_cache"
    printf '%s\n' '{"deviceKeys":[]}' > "$key_file"
    printf '%s\n' '#!/usr/bin/env python3' > "$model_file"
    printf '%s\n' 'cache marker' > "$plugin_cache/marker"

    HOME="$fake_home" \
    XDG_CONFIG_HOME="$fake_home/.config" \
    XDG_DATA_HOME="$fake_home/.local/share" \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
    CODEX_LINUX_DISABLE_FEATURES="remote-mobile-control,read-aloud,read-aloud-mcp" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_json_enabled_equals "$config" '[]'
    assert_file_exists "$key_file"
    assert_file_exists "$model_file"
    assert_file_exists "$plugin_cache/marker"
    assert_contains "$output_log" "Not deleting $key_file"
    assert_contains "$output_log" "Not removing Read Aloud model files, Python runtimes, or plugin caches"
    assert_contains "$output_log" "$fake_home/.local/share/codex-desktop/read-aloud"
    assert_contains "$output_log" "$plugin_cache"
}

test_setup_native_wizard_accepts_numbered_feature_selection() {
    info "Checking setup-native wizard accepts numbered feature selections"
    local workspace="$TMP_DIR/setup-native-numbered-features"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["remote-mobile-control"]}' > "$config"

    if ! command -v script >/dev/null 2>&1; then
        info "Skipping numbered feature selection smoke test because script(1) is unavailable"
        return
    fi

    (
        export HOME="$fake_home"
        export XDG_CONFIG_HOME="$fake_home/.config"
        export CODEX_LINUX_FEATURES_ROOT="$features_root"
        export CODEX_LINUX_FEATURES_CONFIG="$config"
        {
            printf '1,3-4\n'
            printf '5\n'
            printf '\n'
            printf '\n'
            printf '\n'
            printf '\n'
        } | script -qefc "CODEX_BOOTSTRAP_NO_GUI=1 bash $REPO_DIR/scripts/bootstrap-wizard.sh" /dev/null >"$output_log"
    )

    assert_json_enabled_equals "$config" '["conversation-mode","read-aloud","read-aloud-mcp"]'
    assert_contains "$output_log" "1\\. \\[available\\] conversation-mode - Conversation mode"
    assert_contains "$output_log" "5\\. \\[enabled\\] remote-mobile-control - Experimental Remote Mobile Control"
    assert_contains "$output_log" "Enable feature ids or numbers for the next build"
    assert_contains "$output_log" "Disable feature ids or numbers for the next build"
}

test_setup_native_wizard_rejects_out_of_range_feature_numbers() {
    info "Checking setup-native wizard explains out-of-range feature numbers"
    local workspace="$TMP_DIR/setup-native-feature-number-range"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":[]}' > "$config"

    if CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
        CODEX_LINUX_FEATURES_ROOT="$features_root" \
        CODEX_LINUX_FEATURES_CONFIG="$config" \
        CODEX_LINUX_FEATURES="99" \
            bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log" 2>&1; then
        fail "setup wizard should reject out-of-range feature numbers"
    fi

    assert_contains "$output_log" "Feature number 99 is out of range for enable"
    assert_contains "$output_log" "Use feature ids, numbers, or ranges like 1,3-4."
    assert_json_enabled_equals "$config" '[]'
}

test_setup_native_wizard_summary_keeps_existing_config() {
    info "Checking setup-native wizard read-only summary keeps existing feature config"
    local workspace="$TMP_DIR/setup-native-summary"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    cat > "$config" <<'JSON'
{"enabled":["remote-mobile-control"]}
JSON

    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_json_enabled_equals "$config" '["remote-mobile-control"]'
    assert_contains "$output_log" "Enabled Linux features: remote-mobile-control"
    assert_contains "$output_log" "Default native package mode includes codex-update-manager"
    assert_contains "$output_log" "make install-native"
}

test_setup_native_wizard_lists_local_features() {
    info "Checking setup-native wizard discovers user-local Linux features"
    local workspace="$TMP_DIR/setup-native-local-feature"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    mkdir -p "$features_root/local/local-tool"
    printf '%s\n' '{"id":"local-tool","title":"Local Tool","description":"User-local integration."}' \
        > "$features_root/local/local-tool/feature.json"
    printf '%s\n' '# Local Tool' > "$features_root/local/local-tool/README.md"
    printf '%s\n' '{"enabled":[]}' > "$config"

    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
    CODEX_LINUX_FEATURES="local-tool" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_json_enabled_equals "$config" '["local-tool"]'
    assert_contains "$output_log" "local-tool \\[local\\] - Local Tool"
    assert_contains "$output_log" "Enabled Linux features: local-tool"
}

test_setup_native_wizard_uses_package_name_for_installed_state() {
    info "Checking setup-native wizard package-name-aware installed state"
    local workspace="$TMP_DIR/setup-native-package-name"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local bin_dir="$workspace/bin"
    local dpkg_args="$workspace/dpkg-query.args"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":[]}' > "$config"
    mkdir -p "$bin_dir"
    cat > "$bin_dir/dpkg-query" <<SCRIPT
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$dpkg_args"
if [[ "\$*" != *codex-cua-lab* ]]; then
    exit 1
fi
case "\$*" in
    *"deb "*)
        printf 'deb 1.2.3'
        exit 0
        ;;
    *)
        printf '1.2.3'
        exit 0
        ;;
esac
SCRIPT
    chmod +x "$bin_dir/dpkg-query"

    PATH="$bin_dir:$PATH" \
    PACKAGE_NAME="codex-cua-lab" \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_contains "$output_log" "Installed package: deb 1.2.3"
    assert_contains "$output_log" "ydotoold.service(system)="
    assert_contains "$output_log" "ydotoold.service(user)="
    assert_contains "$dpkg_args" "codex-cua-lab"
    assert_not_contains "$dpkg_args" "codex-desktop"
}

test_setup_native_wizard_portal_summary_survives_busctl_sigpipe() {
    info "Checking setup-native wizard portal summary avoids pipefail SIGPIPE false negatives"
    local workspace="$TMP_DIR/setup-native-portal-sigpipe"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local bin_dir="$workspace/bin"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":[]}' > "$config"
    mkdir -p "$bin_dir"
    cat > "$bin_dir/pgrep" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
    cat > "$bin_dir/busctl" <<'SCRIPT'
#!/usr/bin/env bash
if [ "${1:-}" = "--user" ] && [ "${2:-}" = "--list" ]; then
    printf '%s\n' 'org.freedesktop.portal.Desktop 1234 xdg-desktop-portal'
    exit 141
fi
exit 1
SCRIPT
    chmod +x "$bin_dir/pgrep" "$bin_dir/busctl"

    PATH="$bin_dir:$PATH" \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log" 2>&1

    assert_contains "$output_log" "portal=available on session bus"
}

test_setup_native_wizard_warns_when_conversation_mode_lacks_read_aloud() {
    info "Checking setup-native wizard warns about conversation-mode without Read Aloud"
    local workspace="$TMP_DIR/setup-native-conversation-warning"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["conversation-mode"]}' > "$config"

    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log" 2>&1

    assert_contains "$output_log" "conversation-mode is enabled without read-aloud"
}

test_setup_native_wizard_dry_runs_deps_and_install_native() {
    info "Checking setup-native wizard dry-run dependency and native install orchestration"
    local workspace="$TMP_DIR/setup-native-dry-run-install"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":[]}' > "$config"

    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_BOOTSTRAP_DRY_RUN=1 \
    CODEX_BOOTSTRAP_INSTALL_DEPS=1 \
    CODEX_BOOTSTRAP_INSTALL_NATIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
    PACKAGE_WITH_UPDATER=0 \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_contains "$output_log" "Would run: bash scripts/install-deps.sh"
    assert_contains "$output_log" 'Would run: PATH="$HOME/.cargo/bin:$PATH" PACKAGE_WITH_UPDATER=0 make install-native'
    assert_contains "$output_log" "Dry-run mode: no dependency install or native package install command was executed."
}

test_setup_native_wizard_prints_deep_readiness_guidance() {
    info "Checking setup-native wizard detailed Computer Use and Read Aloud readiness"
    local workspace="$TMP_DIR/setup-native-readiness"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["read-aloud","read-aloud-mcp"]}' > "$config"
    mkdir -p "$fake_home/.config/codex-desktop" "$fake_home/.local/share/codex-desktop/read-aloud"

    HOME="$fake_home" \
    XDG_CONFIG_HOME="$fake_home/.config" \
    XDG_DATA_HOME="$fake_home/.local/share" \
    XDG_CURRENT_DESKTOP=KDE \
    DESKTOP_SESSION=plasma \
    XDG_SESSION_DESKTOP=plasma \
    XDG_SESSION_TYPE=wayland \
    CODEX_LINUX_SETTINGS_FILE="$fake_home/.config/codex-desktop/settings.json" \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_contains "$output_log" "Computer Use details:"
    assert_contains "$output_log" "uinput="
    assert_contains "$output_log" "current user in input group="
    assert_contains "$output_log" "Window backend hint: KDE/Plasma -> KWin"
    assert_contains "$output_log" "Suggested ydotool command:"
    assert_contains "$output_log" "Suggested portal package:"
    assert_contains "$output_log" "Read Aloud readiness:"
    assert_contains "$output_log" "Kokoro python:"
    assert_contains "$output_log" "Read Aloud plugin cache:"
}

test_setup_native_wizard_uinput_stat_is_bounded() {
    info "Checking setup-native wizard bounds slow uinput metadata reads"
    local workspace="$TMP_DIR/setup-native-uinput-stat"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local bin_dir="$workspace/bin"
    local fake_uinput="$workspace/uinput"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":[]}' > "$config"
    mkdir -p "$bin_dir"
    printf '%s\n' 'fake uinput' > "$fake_uinput"
    cat > "$bin_dir/stat" <<'SCRIPT'
#!/usr/bin/env bash
sleep 5
printf '%s\n' 'unexpected stat output'
SCRIPT
    chmod +x "$bin_dir/stat"

    PATH="$bin_dir:$PATH" \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_BOOTSTRAP_UINPUT_PATH="$fake_uinput" \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        timeout 3 bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_contains "$output_log" "uinput=read/write access"
    assert_not_contains "$output_log" "unexpected stat output"
}

test_setup_native_wizard_read_aloud_paths_match_runtime_defaults() {
    info "Checking setup-native wizard Read Aloud default paths and Linux app id"
    local workspace="$TMP_DIR/setup-native-read-aloud-defaults"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["read-aloud"]}' > "$config"
    mkdir -p "$fake_home/.config/codex-cua-lab" "$fake_home/.local/share/kokoro"
    printf '%s\n' '{"codex-linux-read-aloud-kokoro-python":"/custom/python"}' > "$fake_home/.config/codex-cua-lab/settings.json"
    printf '%s\n' 'model marker' > "$fake_home/.local/share/kokoro/kokoro-v1.0.onnx"
    printf '%s\n' 'voices marker' > "$fake_home/.local/share/kokoro/voices-v1.0.bin"

    HOME="$fake_home" \
    XDG_CONFIG_HOME="$fake_home/.config" \
    XDG_DATA_HOME="$fake_home/.local/share" \
    CODEX_LINUX_APP_ID="codex-cua-lab" \
    CODEX_APP_ID="codex-desktop" \
    CODEX_LINUX_SETTINGS_FILE="$fake_home/.config/codex-cua-lab/settings.json" \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_contains "$output_log" "Settings file: $fake_home/.config/codex-cua-lab/settings.json (file)"
    assert_contains "$output_log" "Kokoro python: /custom/python (missing)"
    assert_contains "$output_log" "Kokoro model: $fake_home/.local/share/kokoro/kokoro-v1.0.onnx (file)"
    assert_contains "$output_log" "Kokoro voices: $fake_home/.local/share/kokoro/voices-v1.0.bin (file)"
    assert_not_contains "$output_log" "$fake_home/.local/share/codex-desktop/read-aloud/kokoro/kokoro-v1.0.onnx"
}

test_setup_native_wizard_sway_hint_is_conservative() {
    info "Checking setup-native wizard Sway backend hint stays conservative"
    local workspace="$TMP_DIR/setup-native-sway-hint"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":[]}' > "$config"

    XDG_CURRENT_DESKTOP=sway \
    DESKTOP_SESSION=sway \
    XDG_SESSION_DESKTOP=sway \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_contains "$output_log" "Sway -> not explicitly supported by the current i3 backend"
    assert_not_contains "$output_log" "Sway -> i3 IPC backend through swaymsg"
}

test_setup_native_wizard_cleanup_requires_interactive_confirmation() {
    info "Checking setup-native wizard cleanup refuses non-interactive deletion"
    local workspace="$TMP_DIR/setup-native-cleanup-noninteractive"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"
    local key_file="$fake_home/.config/codex-desktop/remote-control-device-keys/remote-control-device-keys-v1.json"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["remote-mobile-control"]}' > "$config"
    mkdir -p "$(dirname "$key_file")"
    printf '%s\n' '{"deviceKeys":[]}' > "$key_file"

    if HOME="$fake_home" \
        XDG_CONFIG_HOME="$fake_home/.config" \
        CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
        CODEX_BOOTSTRAP_CLEANUP_FEATURES="remote-mobile-control" \
        CODEX_LINUX_FEATURES_ROOT="$features_root" \
        CODEX_LINUX_FEATURES_CONFIG="$config" \
            bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log" 2>&1; then
        fail "setup wizard should refuse non-interactive cleanup"
    fi

    assert_file_exists "$key_file"
    assert_contains "$output_log" "Cleanup requires an interactive terminal and exact path confirmation."
}

test_setup_native_wizard_dry_run_cleanup_allows_noninteractive_preview() {
    info "Checking setup-native wizard non-interactive dry-run cleanup preview"
    local workspace="$TMP_DIR/setup-native-cleanup-dry-run-noninteractive"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"
    local key_file="$fake_home/.config/codex-desktop/remote-control-device-keys/remote-control-device-keys-v1.json"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["remote-mobile-control"]}' > "$config"
    mkdir -p "$(dirname "$key_file")"
    printf '%s\n' '{"deviceKeys":[]}' > "$key_file"

    HOME="$fake_home" \
    XDG_CONFIG_HOME="$fake_home/.config" \
    CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
    CODEX_BOOTSTRAP_DRY_RUN=1 \
    CODEX_BOOTSTRAP_CLEANUP_FEATURES="remote-mobile-control" \
    CODEX_LINUX_FEATURES_ROOT="$features_root" \
    CODEX_LINUX_FEATURES_CONFIG="$config" \
        bash "$REPO_DIR/scripts/bootstrap-wizard.sh" >"$output_log"

    assert_file_exists "$key_file"
    assert_contains "$output_log" "Would delete: $key_file"
    assert_not_contains "$output_log" "Cleanup requires an interactive terminal"
}

test_setup_native_wizard_blank_interactive_cleanup_ids_skip_cleanup() {
    info "Checking setup-native wizard skips cleanup when interactive feature ids are blank"
    local workspace="$TMP_DIR/setup-native-cleanup-blank"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["remote-mobile-control"]}' > "$config"

    if ! command -v script >/dev/null 2>&1; then
        info "Skipping blank cleanup smoke test because script(1) is unavailable"
        return
    fi

    (
        export HOME="$fake_home"
        export XDG_CONFIG_HOME="$fake_home/.config"
        export CODEX_LINUX_FEATURES_ROOT="$features_root"
        export CODEX_LINUX_FEATURES_CONFIG="$config"
        {
            printf '\n'
            printf '\n'
            printf '\n'
            printf 'y\n'
            printf '\n'
            printf '\n'
            printf '\n'
        } | script -qefc "CODEX_BOOTSTRAP_NO_GUI=1 bash $REPO_DIR/scripts/bootstrap-wizard.sh" /dev/null >"$output_log"
    )

    assert_json_enabled_equals "$config" '["remote-mobile-control"]'
    assert_contains "$output_log" "No cleanup feature ids provided; skipping feature cleanup."
    assert_contains "$output_log" "Default native package mode includes codex-update-manager"
}

test_setup_native_wizard_dry_run_cleanup_does_not_delete_confirmed_paths() {
    info "Checking setup-native wizard dry-run cleanup is non-destructive"
    local workspace="$TMP_DIR/setup-native-cleanup-dry-run"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"
    local key_file="$fake_home/.config/codex-desktop/remote-control-device-keys/remote-control-device-keys-v1.json"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["remote-mobile-control"]}' > "$config"
    mkdir -p "$(dirname "$key_file")"
    printf '%s\n' '{"deviceKeys":[]}' > "$key_file"

    if ! command -v script >/dev/null 2>&1; then
        info "Skipping dry-run cleanup smoke test because script(1) is unavailable"
        return
    fi

    (
        export HOME="$fake_home"
        export XDG_CONFIG_HOME="$fake_home/.config"
        export CODEX_BOOTSTRAP_DRY_RUN=1
        export CODEX_BOOTSTRAP_CLEANUP_FEATURES="remote-mobile-control"
        export CODEX_LINUX_FEATURES_ROOT="$features_root"
        export CODEX_LINUX_FEATURES_CONFIG="$config"
        {
            printf '\n'
            printf '\n'
            printf '\n'
            printf 'DELETE %s\n' "$key_file"
        } | script -qefc "CODEX_BOOTSTRAP_NO_GUI=1 bash $REPO_DIR/scripts/bootstrap-wizard.sh" /dev/null >"$output_log"
    )

    assert_file_exists "$key_file"
    assert_contains "$output_log" "Would delete: $key_file"
    assert_not_contains "$output_log" "Deleted $key_file"
}

test_setup_native_wizard_cleanup_deletes_only_confirmed_paths() {
    info "Checking setup-native wizard deletes only explicitly confirmed cleanup paths"
    local workspace="$TMP_DIR/setup-native-cleanup-confirmed"
    local features_root="$workspace/linux-features"
    local config="$workspace/features.json"
    local output_log="$workspace/output.log"
    local fake_home="$workspace/home"
    local key_file="$fake_home/.config/codex-desktop/remote-control-device-keys/remote-control-device-keys-v1.json"
    local read_aloud_data="$fake_home/.local/share/codex-desktop/read-aloud"
    local plugin_cache="$fake_home/.codex/plugins/cache/openai-bundled/read-aloud"

    make_wizard_feature_root "$features_root"
    printf '%s\n' '{"enabled":["remote-mobile-control","read-aloud"]}' > "$config"
    mkdir -p "$(dirname "$key_file")" "$read_aloud_data" "$plugin_cache"
    printf '%s\n' '{"deviceKeys":[]}' > "$key_file"
    printf '%s\n' 'model marker' > "$read_aloud_data/model"
    printf '%s\n' 'cache marker' > "$plugin_cache/marker"

    if ! command -v script >/dev/null 2>&1; then
        info "Skipping interactive cleanup smoke test because script(1) is unavailable"
        return
    fi

    (
        export HOME="$fake_home"
        export XDG_CONFIG_HOME="$fake_home/.config"
        export XDG_DATA_HOME="$fake_home/.local/share"
        export CODEX_BOOTSTRAP_CLEANUP_FEATURES="remote-mobile-control,read-aloud"
        export CODEX_LINUX_FEATURES_ROOT="$features_root"
        export CODEX_LINUX_FEATURES_CONFIG="$config"
        {
            printf '\n'
            printf '\n'
            printf '\n'
            printf 'DELETE %s\n' "$key_file"
            printf 'DELETE %s\n' "$read_aloud_data"
            printf '\n'
            printf '\n'
            printf '\n'
        } | script -qefc "CODEX_BOOTSTRAP_NO_GUI=1 bash $REPO_DIR/scripts/bootstrap-wizard.sh" /dev/null >"$output_log"
    )

    assert_file_not_exists "$key_file"
    [ ! -e "$read_aloud_data" ] || fail "Expected confirmed Read Aloud data path to be deleted"
    assert_file_exists "$plugin_cache/marker"
    assert_contains "$output_log" "Deleted $key_file"
    assert_contains "$output_log" "Deleted $read_aloud_data"
    assert_contains "$output_log" "Skipped $plugin_cache"
}

make_update_nix_hash_fixture() {
    local fixture="$1"
    local hash_a="sha256-VVQNu/E7Wuyxfsy93Gorknr0t7H7wy9kxMOiBZYOo/o="

    mkdir -p "$fixture/scripts/ci" "$fixture/nix/native-modules" "$fixture/bin"
    cp "$REPO_DIR/scripts/ci/update-nix-hashes.sh" "$fixture/scripts/ci/update-nix-hashes.sh"
    chmod +x "$fixture/scripts/ci/update-nix-hashes.sh"

    cat > "$fixture/flake.nix" <<EOF
{
  codexVersion = "26.623.81905";
  electronVersion = "42.1.0";

  codexDmg = pkgs.fetchurl {
    url = "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg";
    hash = "$hash_a";
  };

  x86_64-linux = {
    hash = "$hash_a";
  };

  aarch64-linux = {
    hash = "$hash_a";
  };

  electronHeaders = pkgs.fetchurl {
    hash = "$hash_a";
  };
}
EOF
    printf '%s\n' '{"dependencies":{"electron":"42.1.0","better-sqlite3":"12.9.0","node-pty":"1.1.0"}}' \
        > "$fixture/nix/native-modules/package.json"
    printf '%s\n' '{"name":"native-modules","lockfileVersion":3,"packages":{}}' \
        > "$fixture/nix/native-modules/package-lock.json"

    cat > "$fixture/scripts/ci/validate-nix-pins.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "validate stub invoked"
if [ "${VALIDATE_PIN_CHANGE:-0}" = "1" ]; then
    python3 - "$REPO_DIR/flake.nix" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = re.sub(r'(codexVersion\s*=\s*")[^"]+(";)', r'\g<1>99.0.0\2', text, count=1)
path.write_text(text)
PY
fi
EOF
    chmod +x "$fixture/scripts/ci/validate-nix-pins.sh"

    cat > "$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o)
            shift
            out="${1:-}"
            ;;
    esac
    shift || true
done
if [ -n "$out" ]; then
    printf 'fake dmg\n' > "$out"
    exit 0
fi
version="26.623.81905"
if [ "${VALIDATE_PIN_CHANGE:-0}" = "1" ]; then
    version="99.0.0"
fi
printf '<rss><channel><item><sparkle:shortVersionString>%s</sparkle:shortVersionString></item></channel></rss>\n' "$version"
EOF
    chmod +x "$fixture/bin/curl"

    cat > "$fixture/bin/nix" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
    hash)
        printf '%s\n' "${NIX_HASH:-sha256-VVQNu/E7Wuyxfsy93Gorknr0t7H7wy9kxMOiBZYOo/o=}"
        ;;
    store)
        printf '{"hash":"%s"}\n' "${NIX_HASH:-sha256-VVQNu/E7Wuyxfsy93Gorknr0t7H7wy9kxMOiBZYOo/o=}"
        ;;
    build)
        printf 'nix %s\n' "$*" >> "$CALL_LOG"
        printf 'fake nix build ok\n'
        ;;
    *)
        echo "unexpected nix call: $*" >&2
        exit 2
        ;;
esac
EOF
    chmod +x "$fixture/bin/nix"

    cat > "$fixture/bin/nix-store" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'nix-store %s\n' "$*" >> "$CALL_LOG"
EOF
    chmod +x "$fixture/bin/nix-store"

    cat > "$fixture/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >> "$CALL_LOG"
EOF
    chmod +x "$fixture/bin/npm"

    git -C "$fixture" init -q
    git -C "$fixture" config user.name "Test"
    git -C "$fixture" config user.email "test@example.invalid"
    git -C "$fixture" add flake.nix nix/native-modules/package.json nix/native-modules/package-lock.json
    git -C "$fixture" commit -q -m "fixture"
}

run_update_nix_hash_fixture() {
    local label="$1"
    local validate_pin_change="$2"
    local nix_hash="$3"
    local fixture="$TMP_DIR/$label"

    make_update_nix_hash_fixture "$fixture"
    : > "$fixture/calls.log"
    PATH="$fixture/bin:$PATH" \
        REPO_DIR="$fixture" \
        FLAKE_FILE="$fixture/flake.nix" \
        UPSTREAM_DMG_PATH="$fixture/Codex.dmg" \
        VERIFY_LOG="$fixture/verify.log" \
        CALL_LOG="$fixture/calls.log" \
        VALIDATE_PIN_CHANGE="$validate_pin_change" \
        NIX_HASH="$nix_hash" \
        NIX_VERIFY_OUTPUTS="${NIX_VERIFY_OUTPUTS:-}" \
        bash "$fixture/scripts/ci/update-nix-hashes.sh" > "$fixture/output.log" 2>&1
}

test_update_nix_hashes_skips_unchanged_package_verification() {
    info "Checking Nix hash refresh skips package verification when pins are unchanged"
    local fixture="$TMP_DIR/nix-hash-refresh-unchanged"
    local hash_a="sha256-VVQNu/E7Wuyxfsy93Gorknr0t7H7wy9kxMOiBZYOo/o="

    run_update_nix_hash_fixture "$(basename "$fixture")" 0 "$hash_a"

    assert_contains "$fixture/output.log" "Nix pins unchanged; skipping package-output verification."
    assert_not_contains "$fixture/calls.log" "nix-store"
    assert_not_contains "$fixture/calls.log" "nix build"
}

test_update_nix_hashes_verifies_changed_pins() {
    info "Checking Nix hash refresh still verifies changed pins"
    local fixture="$TMP_DIR/nix-hash-refresh-version-change"
    local hash_a="sha256-VVQNu/E7Wuyxfsy93Gorknr0t7H7wy9kxMOiBZYOo/o="

    run_update_nix_hash_fixture "$(basename "$fixture")" 1 "$hash_a"

    assert_contains "$fixture/output.log" "Nix builds succeeded after refreshing the upstream pins and Codex.dmg hash."
    assert_contains "$fixture/calls.log" "nix-store --add-fixed"
    assert_contains "$fixture/calls.log" "nix build"
}

test_update_nix_hashes_verifies_changed_dmg_hash() {
    info "Checking Nix hash refresh still verifies changed DMG hashes"
    local fixture="$TMP_DIR/nix-hash-refresh-dmg-hash-change"
    local hash_b="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

    run_update_nix_hash_fixture "$(basename "$fixture")" 0 "$hash_b"

    assert_contains "$fixture/output.log" "Nix builds succeeded after refreshing the upstream pins and Codex.dmg hash."
    assert_contains "$fixture/calls.log" "nix-store --add-fixed"
    assert_contains "$fixture/calls.log" "nix build"
}

test_update_nix_hashes_supports_focused_verification_output() {
    info "Checking Nix hash refresh can verify one focused feature output"
    local fixture="$TMP_DIR/nix-hash-refresh-focused-output"
    local hash_b="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

    NIX_VERIFY_OUTPUTS=".#checks.x86_64-linux.nix-linux-features-multi-feature" \
        run_update_nix_hash_fixture "$(basename "$fixture")" 0 "$hash_b"

    assert_contains "$fixture/calls.log" "nix build .#checks.x86_64-linux.nix-linux-features-multi-feature"
    assert_not_contains "$fixture/calls.log" ".#codex-desktop-computer-use-ui"
}

test_update_nix_hashes_skips_output_build_when_refresh_ref_already_matches() {
    info "Checking a serialized duplicate Nix refresh adopts matching pin files"
    local fixture="$TMP_DIR/nix-hash-refresh-matching-ref"
    local hash_b="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    local initial_branch

    make_update_nix_hash_fixture "$fixture"
    initial_branch="$(git -C "$fixture" branch --show-current)"
    git -C "$fixture" checkout -q -b existing-refresh
    python3 - "$fixture/flake.nix" "$hash_b" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = re.sub(
    r'(codexDmg = pkgs\.fetchurl \{.*?hash = ")[^"]+(";)',
    rf'\g<1>{sys.argv[2]}\2',
    text,
    count=1,
    flags=re.DOTALL,
)
path.write_text(text)
PY
    git -C "$fixture" add flake.nix
    git -C "$fixture" commit -q -m "existing refresh"
    git -C "$fixture" checkout -q "$initial_branch"
    : > "$fixture/calls.log"

    PATH="$fixture/bin:$PATH" \
        REPO_DIR="$fixture" \
        FLAKE_FILE="$fixture/flake.nix" \
        UPSTREAM_DMG_PATH="$fixture/Codex.dmg" \
        VERIFY_LOG="$fixture/verify.log" \
        CALL_LOG="$fixture/calls.log" \
        NIX_HASH="$hash_b" \
        NIX_COMPARE_REF=existing-refresh \
        bash "$fixture/scripts/ci/update-nix-hashes.sh" > "$fixture/output.log" 2>&1

    assert_contains "$fixture/output.log" "Nix pins already match existing-refresh"
    assert_not_contains "$fixture/calls.log" "nix-store"
    assert_not_contains "$fixture/calls.log" "nix build"
}

test_ci_local_mounts_shared_git_metadata_for_linked_worktrees() {
    info "Checking ci-local supports linked Git worktrees"
    assert_contains "$REPO_DIR/scripts/ci-local.sh" 'rev-parse --path-format=absolute --git-common-dir'
    assert_contains "$REPO_DIR/scripts/ci-local.sh" 'git_common_dir:$git_common_dir:ro'
}

test_installer_detects_electron_version_from_plist() {
    info "Checking Electron version detection from app metadata"
    local workspace="$TMP_DIR/electron-version"
    local app_dir="$workspace/Codex.app"
    local plist_dir="$app_dir/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
    local output_log="$workspace/output.log"

    mkdir -p "$plist_dir"
    cat > "$plist_dir/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleVersion</key>
    <string>42.5.7</string>
</dict>
</plist>
PLIST

    CODEX_INSTALLER_SOURCE_ONLY=1 bash -c \
        'source "$1"; detect_electron_version "$2"; printf "%s\n" "$ELECTRON_VERSION"' \
        _ "$REPO_DIR/install.sh" "$app_dir" >"$output_log" 2>&1

    assert_contains "$output_log" "Detected Electron version from DMG: 42.5.7"
    [ "$(tail -n 1 "$output_log")" = "42.5.7" ] || fail "Expected detected Electron version 42.5.7, got: $(cat "$output_log")"
}

test_installer_keeps_electron_fallback_for_bad_metadata() {
    info "Checking Electron version fallback for malformed metadata"
    local workspace="$TMP_DIR/electron-version-fallback"
    local app_dir="$workspace/Codex.app"
    local plist_dir="$app_dir/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
    local output_log="$workspace/output.log"

    mkdir -p "$plist_dir"
    cat > "$plist_dir/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleVersion</key>
    <string>not-a-version</string>
</dict>
</plist>
PLIST

    CODEX_INSTALLER_SOURCE_ONLY=1 bash -c \
        'source "$1"; detect_electron_version "$2"; printf "%s\n" "$ELECTRON_VERSION"' \
        _ "$REPO_DIR/install.sh" "$app_dir" >"$output_log" 2>&1

    assert_contains "$output_log" "Ignoring invalid Electron version from DMG: not-a-version"
    assert_contains "$output_log" "Could not auto-detect Electron version; using fallback 41.3.0"
    [ "$(tail -n 1 "$output_log")" = "41.3.0" ] || fail "Expected fallback Electron version 41.3.0, got: $(cat "$output_log")"
}

test_port_validation_rejects_oversized_numeric_values() {
    info "Checking oversized numeric webview port validation"
    local workspace="$TMP_DIR/port-validation"
    local install_stdout="$workspace/install.stdout"
    local install_stderr="$workspace/install.stderr"
    local launcher_stdout="$workspace/launcher.stdout"
    local launcher_stderr="$workspace/launcher.stderr"
    local canonical_stdout="$workspace/canonical.stdout"
    local canonical_stderr="$workspace/canonical.stderr"
    local launcher_probe_script="$workspace/launcher-port-probe.sh"
    local start_script="$workspace/start.sh"
    local huge_port="999999999999999999999999"
    local rc

    mkdir -p "$workspace"

    set +e
    CODEX_INSTALLER_SOURCE_ONLY=1 CODEX_WEBVIEW_PORT="$huge_port" bash -c \
        'source "$1"; validate_app_identity' \
        _ "$REPO_DIR/install.sh" >"$install_stdout" 2>"$install_stderr"
    rc=$?
    set -e
    [ "$rc" -ne 0 ] || fail "Expected installer validation to reject oversized CODEX_WEBVIEW_PORT"
    assert_contains "$install_stderr" "CODEX_WEBVIEW_PORT must be between 1 and 65535"
    assert_not_contains "$install_stderr" "integer expected"

    CODEX_INSTALLER_SOURCE_ONLY=1 CODEX_WEBVIEW_PORT=00080 bash -c \
        'source "$1"; validate_app_identity; printf "%s\n" "$CODEX_WEBVIEW_PORT"' \
        _ "$REPO_DIR/install.sh" >"$canonical_stdout" 2>"$canonical_stderr"
    [ "$(cat "$canonical_stdout")" = "80" ] || fail "Expected installer validation to canonicalize leading-zero CODEX_WEBVIEW_PORT"
    [ ! -s "$canonical_stderr" ] || fail "Expected installer leading-zero canonicalization to be quiet, got: $(cat "$canonical_stderr")"

    printf '%s\n' \
        "#!$BASH_BIN" \
        'set -euo pipefail' \
        'CODEX_LINUX_APP_ID=codex-desktop' \
        'CODEX_LINUX_APP_DISPLAY_NAME=Codex' \
        'CODEX_LINUX_WEBVIEW_PORT=${CODEX_WEBVIEW_PORT:-5175}' \
        > "$start_script"
    cat "$REPO_DIR/launcher/start.sh.template" >> "$start_script"
    chmod +x "$start_script"

    set +e
    CODEX_WEBVIEW_PORT="$huge_port" bash "$start_script" --help >"$launcher_stdout" 2>"$launcher_stderr"
    rc=$?
    set -e
    [ "$rc" -ne 0 ] || fail "Expected launcher validation to reject oversized CODEX_WEBVIEW_PORT"
    assert_contains "$launcher_stderr" "CODEX_WEBVIEW_PORT must be between 1 and 65535"
    assert_not_contains "$launcher_stderr" "integer expected"

    XDG_CONFIG_HOME="$workspace/help-config" bash "$start_script" --help >"$launcher_stdout" 2>"$launcher_stderr"
    assert_contains "$launcher_stdout" "electron-flags.conf"
    assert_file_not_exists "$workspace/help-config/codex-desktop/electron-flags.conf"

    printf '%s\n' \
        "#!$BASH_BIN" \
        'set -euo pipefail' \
        'CODEX_LINUX_WEBVIEW_PORT=${CODEX_WEBVIEW_PORT:-5175}' \
        > "$launcher_probe_script"
    awk '
        /^normalize_tcp_port\(\) \{/ { emit = 1 }
        /^launcher_port_is_open\(\) \{/ { exit }
        emit { print }
    ' "$REPO_DIR/launcher/start.sh.template" >> "$launcher_probe_script"
    cat >> "$launcher_probe_script" <<'SCRIPT'
printf '%s\n' "$CODEX_LINUX_WEBVIEW_PORT"
SCRIPT
    chmod +x "$launcher_probe_script"
    CODEX_WEBVIEW_PORT=00080 bash "$launcher_probe_script" >"$launcher_stdout" 2>"$launcher_stderr"
    [ "$(tail -n 1 "$launcher_stdout")" = "80" ] || fail "Expected launcher validation to canonicalize leading-zero CODEX_WEBVIEW_PORT"
    [ ! -s "$launcher_stderr" ] || fail "Expected launcher leading-zero canonicalization to be quiet, got: $(cat "$launcher_stderr")"
}

test_managed_node_runtime_source_install() {
    info "Checking managed Node.js runtime source install"
    local workspace="$TMP_DIR/managed-node-runtime"
    local source_dir="$workspace/source"
    local install_dir="$workspace/install"

    mkdir -p "$source_dir/bin" "$install_dir/resources"
    for binary in node npm npx; do
        cat > "$source_dir/bin/$binary" <<'SCRIPT'
#!/usr/bin/env bash
case "$(basename "$0")" in
    node)
        case "${1:-}" in
            -e) printf '%s' 'codex-node-runtime-ok:22.22.2' ;;
            -v) echo v22.22.2 ;;
            *) echo v22.22.2 ;;
        esac
        ;;
    *) echo 10.9.7 ;;
esac
SCRIPT
        chmod +x "$source_dir/bin/$binary"
    done

    (
        SCRIPT_DIR="$REPO_DIR"
        WORK_DIR="$workspace/work"
        ARCH="x86_64"
        CODEX_MANAGED_NODE_SOURCE="$source_dir"
        mkdir -p "$WORK_DIR"
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/node-runtime.sh"
        ensure_managed_node_runtime "$install_dir/resources/node-runtime"
        command -v node
        node -v
    ) > "$workspace/output.log" 2>&1

    assert_file_exists "$install_dir/resources/node-runtime/bin/node"
    assert_contains "$workspace/output.log" "$install_dir/resources/node-runtime/bin/node"
    assert_contains "$workspace/output.log" "v22.22.2"
}

test_managed_node_runtime_rejects_version_only_stub() {
    info "Checking managed Node.js runtime rejects version-only stubs"
    local workspace="$TMP_DIR/managed-node-runtime-stub"
    local source_dir="$workspace/source"
    local install_dir="$workspace/install"

    mkdir -p "$source_dir/bin" "$install_dir/resources/node-runtime/bin"
    for binary in node npm npx; do
        cat > "$install_dir/resources/node-runtime/bin/$binary" <<'SCRIPT'
#!/usr/bin/env bash
case "$(basename "$0")" in
    node) echo v22.22.2 ;;
    *) echo 10.9.7 ;;
esac
SCRIPT
        chmod +x "$install_dir/resources/node-runtime/bin/$binary"
    done

    for binary in node npm npx; do
        cat > "$source_dir/bin/$binary" <<'SCRIPT'
#!/usr/bin/env bash
case "$(basename "$0")" in
    node)
        case "${1:-}" in
            -e) printf '%s' 'codex-node-runtime-ok:22.22.2' ;;
            -v) echo v22.22.2 ;;
            *) echo v22.22.2 ;;
        esac
        ;;
    *) echo 10.9.7 ;;
esac
SCRIPT
        chmod +x "$source_dir/bin/$binary"
    done

    (
        SCRIPT_DIR="$REPO_DIR"
        WORK_DIR="$workspace/work"
        ARCH="x86_64"
        CODEX_MANAGED_NODE_SOURCE="$source_dir"
        mkdir -p "$WORK_DIR"
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/node-runtime.sh"
        ensure_managed_node_runtime "$install_dir/resources/node-runtime"
        command -v node
        node -v
    ) > "$workspace/output.log" 2>&1

    assert_contains "$workspace/output.log" "Managed Node.js runtime copied from $source_dir"
    assert_contains "$workspace/output.log" "$install_dir/resources/node-runtime/bin/node"
    assert_contains "$workspace/output.log" "v22.22.2"
}

test_better_sqlite3_electron_42_source_patch() {
    info "Checking better-sqlite3 Electron 42 source patch"
    local workspace="$TMP_DIR/better-sqlite3-electron-42"
    local module_dir="$workspace/node_modules/better-sqlite3"
    local output_log="$workspace/output.log"

    mkdir -p "$module_dir/src/util"
    cat > "$module_dir/src/better_sqlite3.cpp" <<'CPP'
void init(v8::Isolate* isolate, Addon* addon) {
	v8::Local<v8::External> data = v8::External::New(isolate, addon);
}
CPP
    cat > "$module_dir/src/util/macros.cpp" <<'CPP'
#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()
#define OnlyIsolate info.GetIsolate()
#define OnlyContext isolate->GetCurrentContext()
#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())
CPP
    cat > "$module_dir/src/util/helpers.cpp" <<'CPP'
void SetPrototypeGetter() {
	recv->InstanceTemplate()->SetNativeDataProperty(
		InternalizedFromLatin1(isolate, name),
		func,
		0,
		data
	);
}
CPP

    (
        ELECTRON_VERSION="42.0.1"
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/native-modules.sh"
        patch_better_sqlite3_for_v8_external_pointer_api "$module_dir"
        patch_better_sqlite3_for_v8_external_pointer_api "$module_dir"
    ) > "$output_log" 2>&1

    assert_contains "$module_dir/src/better_sqlite3.cpp" "BETTER_SQLITE3_EXTERNAL_NEW(isolate, addon)"
    assert_contains "$module_dir/src/util/macros.cpp" "BETTER_SQLITE3_EXTERNAL_POINTER_TAG"
    assert_contains "$module_dir/src/util/macros.cpp" "BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>())"
    assert_contains "$module_dir/src/util/helpers.cpp" "nullptr"
    assert_contains "$output_log" "Patched better-sqlite3 source for V8 external pointer API"
    assert_contains "$output_log" "already applied"
}

test_v8_nullptr_workaround_skips_when_included_probe_succeeds() {
    info "Checking V8 nullptr_t workaround probe stays inactive when not needed"
    local workspace="$TMP_DIR/v8-nullptr-workaround-skip"
    local fake_bin="$workspace/bin"
    local cxx_log="$workspace/cxx.log"
    local cxx_state="$workspace/cxx-state.log"
    local output_log="$workspace/output.log"

    mkdir -p "$fake_bin" "$workspace/work"
    cat > "$fake_bin/c++" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf 'argv:%s\n' "$*" >> "$NATIVE_CXX_LOG"
for arg in "$@"; do
    if [ -f "$arg" ]; then
        cat "$arg" >> "$NATIVE_CXX_LOG"
    fi
done
exit 0
SCRIPT
    chmod +x "$fake_bin/c++"

    (
        CXX="$fake_bin/c++"
        NATIVE_CXX_LOG="$cxx_log"
        export CXX NATIVE_CXX_LOG
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/native-modules.sh"
        apply_v8_nullptr_t_workaround_if_needed "$workspace/work"
        printf 'CXX=%s\n' "$CXX" > "$cxx_state"
    ) > "$output_log" 2>&1

    assert_contains "$cxx_log" "#include <cstddef>"
    assert_contains "$cxx_log" "nullptr_t x = nullptr;"
    assert_contains "$cxx_state" "CXX=$fake_bin/c++"
    assert_not_contains "$output_log" "Applied GCC 16+ nullptr_t compatibility workaround"
}

test_v8_nullptr_workaround_wraps_when_included_probe_fails() {
    info "Checking V8 nullptr_t workaround wraps CXX only when needed"
    local workspace="$TMP_DIR/v8-nullptr-workaround-wrap"
    local fake_bin="$workspace/bin"
    local cxx_log="$workspace/cxx.log"
    local cxx_state="$workspace/cxx-state.log"
    local output_log="$workspace/output.log"

    mkdir -p "$fake_bin" "$workspace/work"
    cat > "$fake_bin/c++" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf 'argv:%s\n' "$*" >> "$NATIVE_CXX_LOG"
for arg in "$@"; do
    if [ -f "$arg" ]; then
        cat "$arg" >> "$NATIVE_CXX_LOG"
    fi
    case "$arg" in
        *.v8-nullptr-probe.cc) exit 1 ;;
    esac
done
exit 0
SCRIPT
    chmod +x "$fake_bin/c++"
    printf '%s\n' 'int main() { return 0; }' > "$workspace/dummy.cc"

    (
        CXX="$fake_bin/c++"
        NATIVE_CXX_LOG="$cxx_log"
        export CXX NATIVE_CXX_LOG
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/native-modules.sh"
        apply_v8_nullptr_t_workaround_if_needed "$workspace/work"
        "$CXX" -x c++ -fsyntax-only "$workspace/dummy.cc"
        printf 'CXX=%s\n' "$CXX" > "$cxx_state"
    ) > "$output_log" 2>&1

    assert_file_exists "$workspace/work/.v8-nullptr-fix.h"
    assert_file_exists "$workspace/work/.cxx-v8-nullptr"
    assert_contains "$workspace/work/.cxx-v8-nullptr" "#!/usr/bin/env bash"
    assert_contains "$workspace/work/.v8-nullptr-fix.h" "using std::nullptr_t;"
    assert_contains "$cxx_state" "CXX=$workspace/work/.cxx-v8-nullptr"
    assert_contains "$cxx_log" "-include"
    assert_contains "$cxx_log" ".v8-nullptr-fix.h"
    assert_contains "$output_log" "Applied GCC 16+ nullptr_t compatibility workaround"
}

test_native_module_rebuild_uses_local_electron_rebuild_toolchain() {
    info "Checking native module rebuild uses local Electron rebuild toolchain"
    local workspace="$TMP_DIR/native-module-rebuild-toolchain"
    local app_dir="$workspace/app-extracted"
    local fake_bin="$workspace/bin"
    local toolchain_log="$workspace/toolchain.log"
    local output_log="$workspace/output.log"

    mkdir -p "$app_dir/node_modules/better-sqlite3" "$app_dir/node_modules/node-pty" "$fake_bin"
    printf '%s\n' '{"version":"12.9.0"}' > "$app_dir/node_modules/better-sqlite3/package.json"
    printf '%s\n' '{"version":"1.1.0"}' > "$app_dir/node_modules/node-pty/package.json"

    cat > "$fake_bin/npm" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

printf 'npm %s\n' "$*" >> "$NATIVE_TOOLCHAIN_LOG"
args=" $* "

case "$args" in
    *" @electron/rebuild@4.0.4 "*)
        mkdir -p node_modules/@electron/rebuild/lib
        cat > node_modules/@electron/rebuild/lib/cli.js <<'REBUILD'
#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(process.env.NATIVE_TOOLCHAIN_LOG, `electron-rebuild ${process.argv.slice(2).join(" ")}\n`);
fs.appendFileSync(process.env.NATIVE_TOOLCHAIN_LOG, `electron-rebuild-env jobs=${process.env.npm_config_jobs || ""} makeflags=${process.env.MAKEFLAGS || ""}\n`);
fs.mkdirSync("node_modules/better-sqlite3/build/Release", { recursive: true });
fs.mkdirSync("node_modules/node-pty/build/Release", { recursive: true });
fs.closeSync(fs.openSync("node_modules/better-sqlite3/build/Release/better_sqlite3.node", "w"));
fs.closeSync(fs.openSync("node_modules/node-pty/build/Release/pty.node", "w"));
REBUILD
        ;;
esac

case "$args" in
    *" better-sqlite3@12.9.0 "*)
        mkdir -p node_modules/better-sqlite3/src/util
        printf '%s\n' '{"version":"12.9.0"}' > node_modules/better-sqlite3/package.json
        cat > node_modules/better-sqlite3/src/better_sqlite3.cpp <<'CPP'
void init(v8::Isolate* isolate, Addon* addon) {
	v8::Local<v8::External> data = v8::External::New(isolate, addon);
}
CPP
        cat > node_modules/better-sqlite3/src/util/macros.cpp <<'CPP'
#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()
#define OnlyIsolate info.GetIsolate()
#define OnlyContext isolate->GetCurrentContext()
#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())
CPP
        cat > node_modules/better-sqlite3/src/util/helpers.cpp <<'CPP'
void SetPrototypeGetter() {
	recv->InstanceTemplate()->SetNativeDataProperty(
		InternalizedFromLatin1(isolate, name),
		func,
		0,
		data
	);
}
CPP
        ;;
esac

case "$args" in
    *" node-pty@1.1.0 "*)
        mkdir -p node_modules/node-pty
        printf '%s\n' '{"version":"1.1.0"}' > node_modules/node-pty/package.json
        ;;
esac
SCRIPT
    chmod +x "$fake_bin/npm"

    cat > "$fake_bin/c++" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
    chmod +x "$fake_bin/c++"

    cat > "$fake_bin/npx" <<'SCRIPT'
#!/usr/bin/env bash
echo "npx should not be used for electron-rebuild" >&2
exit 99
SCRIPT
    chmod +x "$fake_bin/npx"

    (
        PATH="$fake_bin:$PATH"
        export PATH
        NATIVE_TOOLCHAIN_LOG="$toolchain_log"
        export NATIVE_TOOLCHAIN_LOG
        MAX_BUILD_THREADS=4
        MAKEFLAGS="-j12 -l8"
        export MAX_BUILD_THREADS
        export MAKEFLAGS
        WORK_DIR="$workspace/work"
        ELECTRON_VERSION="42.0.1"
        ELECTRON_HEADERS_URL="https://example.invalid/electron"
        mkdir -p "$WORK_DIR"
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/native-modules.sh"
        build_native_modules "$app_dir"
    ) > "$output_log" 2>&1

    assert_contains "$toolchain_log" "@electron/rebuild@4.0.4"
    assert_contains "$toolchain_log" "node-abi@^4.31.0"
    assert_contains "$toolchain_log" "electron-rebuild -v 42.0.1 --force --dist-url https://example.invalid/electron --sequential"
    assert_contains "$toolchain_log" "electron-rebuild-env jobs=4 makeflags=-j4"
    assert_contains "$output_log" "Native modules built successfully"
    assert_file_exists "$app_dir/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    assert_file_exists "$app_dir/node_modules/node-pty/build/Release/pty.node"
}

test_native_module_rebuild_accepts_prebuilt_source() {
    info "Checking native module rebuild accepts prebuilt source"
    local workspace="$TMP_DIR/native-module-prebuilt-source"
    local app_dir="$workspace/app-extracted"
    local source_dir="$workspace/prebuilt"
    local output_log="$workspace/output.log"

    mkdir -p \
        "$app_dir/node_modules/better-sqlite3" \
        "$app_dir/node_modules/node-pty" \
        "$source_dir/better-sqlite3/build/Release" \
        "$source_dir/node-pty/build/Release"
    printf '%s\n' '{"version":"12.9.0"}' > "$app_dir/node_modules/better-sqlite3/package.json"
    printf '%s\n' '{"version":"1.1.0"}' > "$app_dir/node_modules/node-pty/package.json"
    printf '%s\n' stale > "$app_dir/node_modules/better-sqlite3/old.txt"

    printf '%s\n' '{"version":"12.9.0"}' > "$source_dir/better-sqlite3/package.json"
    printf '%s\n' '{"version":"1.1.0"}' > "$source_dir/node-pty/package.json"
    : > "$source_dir/better-sqlite3/build/Release/better_sqlite3.node"
    : > "$source_dir/better-sqlite3/build/Release/junk.o"
    : > "$source_dir/node-pty/build/Release/pty.node"
    : > "$source_dir/node-pty/build/Release/junk.o"

    (
        WORK_DIR="$workspace/work"
        ELECTRON_VERSION="42.0.1"
        CODEX_NATIVE_MODULES_SOURCE="$source_dir"
        mkdir -p "$WORK_DIR"
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/native-modules.sh"
        build_native_modules "$app_dir"
    ) > "$output_log" 2>&1

    assert_contains "$output_log" "Using prebuilt native modules from $source_dir"
    assert_file_exists "$app_dir/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    assert_file_exists "$app_dir/node_modules/node-pty/build/Release/pty.node"
    [ ! -f "$app_dir/node_modules/better-sqlite3/old.txt" ] || fail "Expected stale better-sqlite3 module to be replaced"
    [ ! -f "$app_dir/node_modules/better-sqlite3/build/Release/junk.o" ] || fail "Expected better-sqlite3 build junk to be pruned"
    [ ! -f "$app_dir/node_modules/node-pty/build/Release/junk.o" ] || fail "Expected node-pty build junk to be pruned"
}

test_bundled_plugin_builders_accept_prebuilt_binaries() {
    info "Checking bundled plugin builders accept prebuilt binaries"
    local workspace="$TMP_DIR/bundled-plugin-prebuilt-binaries"
    local backend="$workspace/codex-computer-use-linux"
    local cosmic="$workspace/codex-computer-use-cosmic"
    local host="$workspace/codex-chrome-extension-host"
    local chatgpt_icon="$workspace/chatgpt.png"
    local staged_plugins="$workspace/plugins"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    printf '#!/usr/bin/env bash\n' > "$backend"
    printf '#!/usr/bin/env bash\n' > "$cosmic"
    printf '#!/usr/bin/env bash\n' > "$host"
    printf '%s\n' 'chatgpt-icon' > "$chatgpt_icon"
    chmod +x "$backend" "$cosmic" "$host"

    (
        SCRIPT_DIR="$REPO_DIR"
        CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE="$backend"
        CODEX_LINUX_COMPUTER_USE_COSMIC_SOURCE="$cosmic"
        CODEX_CHROME_EXTENSION_HOST_SOURCE="$host"
        LINUX_ICON_SOURCE="$chatgpt_icon"
        ICON_SOURCE="$REPO_DIR/assets/codex.png"
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        build_linux_computer_use_backend
        build_chrome_extension_host
        stage_linux_computer_use_plugin "$staged_plugins"
    ) > "$output_log" 2>&1

    assert_contains "$output_log" "Using prebuilt Linux Computer Use backend"
    assert_contains "$output_log" "Using prebuilt Chrome extension host"
    assert_contains "$output_log" "$backend"
    assert_contains "$output_log" "$cosmic"
    assert_contains "$output_log" "$host"
    cmp -s "$chatgpt_icon" "$staged_plugins/computer-use/assets/app-icon.png" \
        || fail "Expected the bundled Computer Use plugin to use the selected ChatGPT icon"
    [ ! -e "$staged_plugins/computer-use/bin/computer-use-linux-cosmic" ] \
        || fail "Vendored/prebuilt Computer Use staging must not add the external helper alias"
}

test_bundled_plugin_system_computer_use_preserves_cosmic_helper_name() {
    info "Checking opt-in system Computer Use staging preserves its helper contract"
    local workspace="$TMP_DIR/bundled-plugin-system-computer-use"
    local fake_home="$workspace/home"
    local system_bin="$fake_home/.cargo/bin"
    local backend="$system_bin/computer-use-linux"
    local cosmic="$system_bin/computer-use-linux-cosmic"
    local staged_plugins="$workspace/plugins"
    local output_log="$workspace/output.log"

    mkdir -p "$system_bin"
    printf '%s\n' \
        '#!/usr/bin/env bash' \
        'helper="$(dirname "$0")/computer-use-linux-cosmic"' \
        '[ -x "$helper" ] || { echo "missing COSMIC helper: $helper" >&2; exit 9; }' \
        '"$helper"' > "$backend"
    printf '%s\n' '#!/usr/bin/env bash' 'echo cosmic-ok' > "$cosmic"
    chmod +x "$backend" "$cosmic"

    (
        SCRIPT_DIR="$REPO_DIR"
        HOME="$fake_home"
        CODEX_LINUX_COMPUTER_USE_SYSTEM_INSTALL=1
        ICON_SOURCE="$REPO_DIR/assets/codex.png"
        info() { echo "[INFO] $*" >&2; }
        warn() { echo "[WARN] $*" >&2; }
        error() { echo "[ERROR] $*" >&2; exit 1; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_linux_computer_use_plugin "$staged_plugins"
        "$staged_plugins/computer-use/bin/codex-computer-use-linux"
    ) > "$output_log" 2>&1

    assert_contains "$output_log" "Using system computer-use-linux MCP binaries"
    assert_contains "$output_log" "cosmic-ok"
    assert_file_exists "$staged_plugins/computer-use/bin/computer-use-linux-cosmic"
}

test_launcher_managed_node_handles_unset_path() {
    info "Checking managed Node PATH setup without an inherited PATH"
    local workspace="$TMP_DIR/launcher-unset-path"
    local probe="$workspace/probe.sh"
    local managed_node_bin_dir="$workspace/managed-node/bin"

    mkdir -p "$managed_node_bin_dir"
    printf '#!/bin/sh\nexit 0\n' > "$managed_node_bin_dir/node"
    chmod +x "$managed_node_bin_dir/node"

    cat > "$probe" <<EOF
#!/usr/bin/env bash
set -u
SCRIPT_DIR=$(printf '%q' "$workspace")
MANAGED_NODE_BIN_DIR=$(printf '%q' "$managed_node_bin_dir")
BASH_BIN=$(printf '%q' "$BASH_BIN")
EOF
    awk '
        /^path_without_entry\(\) \{/ { capture = 1 }
        capture { print }
        capture && /^}/ { exit }
    ' "$REPO_DIR/launcher/start.sh.template" >> "$probe"
    awk '
        /^prepend_managed_node_runtime_to_path\(\) \{/ { capture = 1 }
        capture { print }
        capture && /^}/ { exit }
    ' "$REPO_DIR/launcher/start.sh.template" >> "$probe"
    cat >> "$probe" <<'EOF'
unset CODEX_LINUX_USER_PATH
unset PATH
prepend_managed_node_runtime_to_path
[ "$PATH" = "$MANAGED_NODE_BIN_DIR" ] || exit 2
[ "${CODEX_LINUX_USER_PATH+x}" = x ] || exit 3
[ -z "$CODEX_LINUX_USER_PATH" ] || exit 4
[ "$CODEX_MANAGED_NODE_RUNTIME_DIR" = "$SCRIPT_DIR/resources/node-runtime" ] || exit 5

PATH="/tmp/untrusted:$MANAGED_NODE_BIN_DIR:/usr/bin"
unset CODEX_LINUX_USER_PATH
prepend_managed_node_runtime_to_path
case "$PATH" in
    "$MANAGED_NODE_BIN_DIR":*) ;;
    *) exit 6 ;;
esac
[ "$CODEX_LINUX_USER_PATH" = "/tmp/untrusted:/usr/bin" ] || exit 7

PATH="$MANAGED_NODE_BIN_DIR:/usr/bin"
CODEX_LINUX_USER_PATH=":/tmp/tools::$MANAGED_NODE_BIN_DIR:/usr/bin:"
prepend_managed_node_runtime_to_path
[ "$CODEX_LINUX_USER_PATH" = ":/tmp/tools::/usr/bin:" ] || exit 8
"$BASH_BIN" -c '[ "$CODEX_LINUX_USER_PATH" = ":/tmp/tools::/usr/bin:" ]' || exit 9
EOF

    "$BASH_BIN" "$probe" || fail "Expected managed Node PATH setup to tolerate an unset PATH"
}

test_launcher_captures_original_ld_library_path_state() {
    info "Checking launcher LD_LIBRARY_PATH snapshot semantics"
    local probe="$TMP_DIR/launcher-ld-library-path-probe.sh"

    awk '
        /^codex_capture_original_ld_library_path\(\) \{/ { capture = 1 }
        capture { print }
        capture && /^# Capture before package-specific launcher patches/ { exit }
    ' "$REPO_DIR/launcher/start.sh.template" > "$probe"
    cat >> "$probe" <<'EOF'
CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE=value
CODEX_LINUX_HOST_LD_LIBRARY_PATH_VALUE=/stale/host/lib
unset LD_LIBRARY_PATH
codex_capture_original_ld_library_path
[ "$CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE" = unset ] || exit 2
[ -z "$CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE" ] || exit 3
[ "${CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE+x}" != x ] || exit 8
[ "${CODEX_LINUX_HOST_LD_LIBRARY_PATH_VALUE+x}" != x ] || exit 9
LD_LIBRARY_PATH=/nix/app
export LD_LIBRARY_PATH
codex_run_host_command "$BASH" -c '
    [ "${LD_LIBRARY_PATH+x}" != x ] &&
    [ "${CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE+x}" != x ] &&
    [ "${CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE+x}" != x ]
' || exit 10

LD_LIBRARY_PATH=""
codex_capture_original_ld_library_path
[ "$CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE" = empty ] || exit 4
[ -z "$CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE" ] || exit 5
LD_LIBRARY_PATH=/nix/app
codex_run_host_command "$BASH" -c '[ "${LD_LIBRARY_PATH+x}" = x ] && [ -z "$LD_LIBRARY_PATH" ]' || exit 11

LD_LIBRARY_PATH="/home/user/lib:/opt/vendor/lib"
codex_capture_original_ld_library_path
[ "$CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE" = value ] || exit 6
[ "$CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE" = "/home/user/lib:/opt/vendor/lib" ] || exit 7
LD_LIBRARY_PATH=/nix/app
codex_run_host_command "$BASH" -c '[ "$LD_LIBRARY_PATH" = "/home/user/lib:/opt/vendor/lib" ]' || exit 12
EOF

    "$BASH_BIN" "$probe" || fail "Expected launcher to preserve all LD_LIBRARY_PATH states"
}

test_packaged_runtime_keeps_managed_node_out_of_user_service_path() {
    info "Checking packaged runtime exports the user PATH to user services"
    local workspace="$TMP_DIR/packaged-runtime-user-path"
    local fake_bin="$workspace/bin"
    local runtime_dir="$workspace/runtime"
    local capture_log="$workspace/path-captures"
    local managed_node_bin="$workspace/managed-node/bin"
    local user_path="$fake_bin:/usr/bin"
    local fallback_path="$fake_bin:/fallback/bin"
    local import_args="PATH DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS XAUTHORITY XDG_RUNTIME_DIR HYPRLAND_INSTANCE_SIGNATURE YDOTOOL_SOCKET"
    local -a captures

    mkdir -p "$fake_bin" "$runtime_dir" "$managed_node_bin"
    printf '%s\n' "#!$BASH_BIN" > "$fake_bin/systemctl"
    cat >> "$fake_bin/systemctl" <<'EOF'
case "$*" in
    "--user show-environment") exit 0 ;;
    "--user import-environment "*) printf 'systemctl|%s|%s\n' "${PATH-}" "$*" >> "$CAPTURE_LOG"; exit 0 ;;
    "--user is-enabled "*) exit 1 ;;
    *) exit 0 ;;
esac
EOF
    printf '%s\n' "#!$BASH_BIN" > "$fake_bin/dbus-update-activation-environment"
    cat >> "$fake_bin/dbus-update-activation-environment" <<'EOF'
printf 'dbus|%s|%s\n' "${PATH-}" "$*" >> "$CAPTURE_LOG"
EOF
    chmod +x "$fake_bin/systemctl" "$fake_bin/dbus-update-activation-environment"

    (
        export CAPTURE_LOG="$capture_log"
        export XDG_RUNTIME_DIR="$runtime_dir"
        export CODEX_LINUX_USER_PATH="$user_path"
        export PATH="$managed_node_bin:$user_path"
        # shellcheck disable=SC1091
        source "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh"

        codex_packaged_runtime_prelaunch_background
        [ "$PATH" = "$managed_node_bin:$user_path" ] \
            || fail "Expected the packaged runtime to preserve the app PATH"
        mapfile -t captures < "$capture_log"
        [ "${captures[0]:-}" = "systemctl|$user_path|--user import-environment $import_args" ] \
            || fail "Expected systemd to import the user PATH"
        [ "${captures[1]:-}" = "dbus|$user_path|--systemd $import_args" ] \
            || fail "Expected D-Bus activation to import the user PATH"
        [ "${#captures[@]}" -eq 2 ] \
            || fail "Expected one PATH export for systemd and D-Bus"

        : > "$capture_log"
        unset CODEX_LINUX_USER_PATH
        export PATH="$fallback_path"
        codex_packaged_runtime_prelaunch_background
        [ "$PATH" = "$fallback_path" ] \
            || fail "Expected the packaged runtime to preserve the fallback PATH"
        mapfile -t captures < "$capture_log"
        [ "${captures[0]:-}" = "systemctl|$fallback_path|--user import-environment $import_args" ] \
            || fail "Expected systemd to import PATH when CODEX_LINUX_USER_PATH is unset"
        [ "${captures[1]:-}" = "dbus|$fallback_path|--systemd $import_args" ] \
            || fail "Expected D-Bus activation to import PATH when CODEX_LINUX_USER_PATH is unset"
        [ "${#captures[@]}" -eq 2 ] \
            || fail "Expected fallback PATH exports only for systemd and D-Bus"
    )
}

test_launcher_rejects_missing_webview_entrypoint() {
    info "Checking launcher rejects an app without webview/index.html"
    local workspace="$TMP_DIR/launcher-webview-entrypoint"
    local app_dir="$workspace/app"
    local home_dir="$workspace/home"
    local runtime_dir="$workspace/runtime"
    local electron_marker="$workspace/electron-called"
    local launcher_log="$home_dir/.cache/codex-desktop/launcher.log"

    mkdir -p \
        "$app_dir/.codex-linux/cold-start.d" \
        "$app_dir/.codex-linux/env.d" \
        "$app_dir/.codex-linux/features" \
        "$app_dir/.codex-linux/prelaunch.d" \
        "$app_dir/.codex-linux/electron-args.d" \
        "$app_dir/.codex-linux/launcher.d" \
        "$app_dir/.codex-linux/after-exit.d" \
        "$app_dir/content/webview" \
        "$app_dir/resources/node-runtime/bin" \
        "$app_dir/resources/plugins/openai-bundled/.agents/plugins" \
        "$app_dir/resources/plugins/openai-bundled/plugins" \
        "$home_dir" \
        "$runtime_dir"

    {
        printf '%s\n' \
            '#!/usr/bin/env bash' \
            'set -Eeuo pipefail' \
            'CODEX_LINUX_APP_ID=codex-desktop' \
            'CODEX_LINUX_APP_DISPLAY_NAME="Codex Desktop"' \
            'CODEX_LINUX_WEBVIEW_PORT="${CODEX_WEBVIEW_PORT:-5175}"'
        cat "$REPO_DIR/launcher/start.sh.template"
    } > "$app_dir/start.sh"
    chmod +x "$app_dir/start.sh"
    cp "$REPO_DIR/launcher/webview-server.py" "$app_dir/.codex-linux/webview-server.py"
    cp "$REPO_DIR/launcher/cli-launch-path.py" "$app_dir/.codex-linux/cli-launch-path.py"
    ln -s "$(command -v node)" "$app_dir/resources/node-runtime/bin/node"

    cat > "$app_dir/electron" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "${ELECTRON_RENDERER_URL:-}" > "$ELECTRON_MARKER"
exit 0
SCRIPT
    chmod +x "$app_dir/electron"

    set +e
    timeout 20 env -i \
        PATH="$HOST_TOOL_PATH" \
        HOME="$home_dir" \
        XDG_RUNTIME_DIR="$runtime_dir" \
        CODEX_CLI_PATH="$TRUE_BIN" \
        CODEX_WEBVIEW_PORT=45675 \
        ELECTRON_RENDERER_URL="http://127.0.0.1:9999/" \
        ELECTRON_MARKER="$electron_marker" \
        "$app_dir/start.sh" >/dev/null 2>&1
    local rc=$?
    set -e

    [ "$rc" -ne 124 ] || fail "Launcher hung while handling a missing webview entrypoint"
    [ "$rc" -ne 0 ] || fail "Launcher should fail when webview/index.html is missing"
    [ ! -e "$electron_marker" ] || fail "Launcher should not reach Electron when webview/index.html is missing"
    assert_contains "$launcher_log" "webview bundle is incomplete"

    rm -f "$electron_marker"
    set +e
    timeout 20 env -i \
        PATH="$HOST_TOOL_PATH" \
        HOME="$home_dir" \
        XDG_RUNTIME_DIR="$runtime_dir" \
        CODEX_CLI_PATH="$TRUE_BIN" \
        CODEX_WEBVIEW_PORT=45675 \
        CODEX_LINUX_ALLOW_RENDERER_URL_OVERRIDE=1 \
        ELECTRON_RENDERER_URL="http://127.0.0.1:9999/" \
        ELECTRON_MARKER="$electron_marker" \
        "$app_dir/start.sh" >/dev/null 2>&1
    rc=$?
    set -e

    [ "$rc" -ne 124 ] || fail "Launcher hung while using an explicit renderer URL override"
    [ "$rc" -eq 0 ] || fail "Launcher should allow an explicit renderer URL override without local webview assets"
    assert_file_exists "$electron_marker"
    [ "$(cat "$electron_marker")" = "http://127.0.0.1:9999/" ] \
        || fail "Launcher should preserve explicit renderer URL override"
    assert_contains "$launcher_log" "Skipping packaged webview setup because ELECTRON_RENDERER_URL override is enabled"
}

test_launcher_extra_bundled_plugin_cache_rollback() {
    info "Checking extra bundled plugin cache rollback"
    local workspace="$TMP_DIR/extra-bundled-plugin-cache-rollback"
    local app_dir="$workspace/app"
    local fake_home="$workspace/home"
    local source_plugin="$app_dir/resources/plugins/openai-bundled/plugins/sites"
    local cache_root="$fake_home/.codex/plugins/cache/openai-bundled/sites"
    local cache_plugin="$cache_root/1.2.3"
    local launcher_defs="$workspace/launcher-defs.sh"
    local initial_log="$workspace/initial.log"
    local failure_log="$workspace/failure.log"
    local no_cache_log="$workspace/no-cache.log"
    local visualize_source="$app_dir/resources/plugins/openai-bundled/plugins/visualize"
    local visualize_cache="$fake_home/.codex/plugins/cache/openai-bundled/visualize/2.0.0"

    mkdir -p "$source_plugin/.codex-plugin" "$fake_home"
    printf '%s\n' '{"name":"sites","version":"1.2.3"}' > "$source_plugin/.codex-plugin/plugin.json"
    printf '%s\n' "initial" > "$source_plugin/content.txt"
    sed '/^hydrate_graphical_session_env$/,$d' "$REPO_DIR/launcher/start.sh.template" > "$launcher_defs"

    (
        export HOME="$fake_home"
        export CODEX_HOME="$fake_home/.codex"
        export CODEX_LINUX_APP_ID="codex-desktop"
        export CODEX_LINUX_APP_DISPLAY_NAME="Codex Desktop"
        export CODEX_LINUX_WEBVIEW_PORT="5175"
        exec 7>&1 8>&2
        # shellcheck disable=SC1090
        source "$launcher_defs"
        exec 1>&7 2>&8
        SCRIPT_DIR="$app_dir"

        sync_extra_bundled_plugin_cache > "$initial_log" 2>&1
        printf '%s\n' "replacement" > "$source_plugin/content.txt"

        mv() {
            local args=("$@")
            local argc="${#args[@]}"
            local source="${args[$((argc - 2))]}"
            local destination="${args[$((argc - 1))]}"
            if [[ "$source" == *".tmp."* ]] && [ "$destination" = "$cache_plugin" ]; then
                return 73
            fi
            command mv "$@"
        }

        sync_extra_bundled_plugin_cache > "$failure_log" 2>&1

        rm -rf "$source_plugin"
        mkdir -p "$visualize_source/.codex-plugin"
        printf '%s\n' '{"name":"visualize","version":"2.0.0"}' > "$visualize_source/.codex-plugin/plugin.json"
        printf '%s\n' "visualize" > "$visualize_source/content.txt"
        sync_extra_bundled_plugin_cache > "$no_cache_log" 2>&1
    )

    assert_contains "$initial_log" "Extra bundled plugin cache synced from bundled resources"
    assert_contains "$failure_log" "previous cache was restored"
    assert_contains "$cache_plugin/content.txt" "initial"
    assert_not_contains "$cache_plugin/content.txt" "replacement"
    [ "$(readlink "$cache_root/latest")" = "1.2.3" ] || fail "Expected latest to keep the restored plugin version"
    [ -L "$fake_home/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/sites" ] \
        || fail "Expected marketplace plugin link to remain available"
    [ -z "$(find "$cache_root" -mindepth 1 -maxdepth 1 -type d \( -name '*.tmp.*' -o -name '*.backup.*' \) -print -quit)" ] \
        || fail "Expected failed extra plugin sync to clean temporary and backup directories"
    assert_contains "$no_cache_log" "continuing without a new cache"
    [ ! -e "$visualize_cache" ] || fail "Expected failed first cache install to leave no plugin payload"
    [ ! -L "${visualize_cache%/*}/latest" ] || fail "Expected failed first cache install to leave no latest link"
    [ ! -L "$fake_home/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/visualize" ] \
        || fail "Expected failed first cache install to leave no marketplace link"
    [ -z "$(find "${visualize_cache%/*}" -mindepth 1 -maxdepth 1 -type d \( -name '*.tmp.*' -o -name '*.backup.*' \) -print -quit)" ] \
        || fail "Expected failed first cache install to clean temporary and backup directories"
}

test_launcher_extra_bundled_plugin_cache_concurrent_destination() {
    info "Checking extra bundled plugin cache concurrent destination handling"
    local workspace="$TMP_DIR/extra-bundled-plugin-cache-concurrent-destination"
    local app_dir="$workspace/app"
    local fake_home="$workspace/home"
    local source_plugin="$app_dir/resources/plugins/openai-bundled/plugins/sites"
    local cache_root="$fake_home/.codex/plugins/cache/openai-bundled/sites"
    local cache_plugin="$cache_root/1.2.3"
    local launcher_defs="$workspace/launcher-defs.sh"
    local race_log="$workspace/race.log"
    local backup_plugin=""

    mkdir -p "$source_plugin/.codex-plugin" "$fake_home"
    printf '%s\n' '{"name":"sites","version":"1.2.3"}' > "$source_plugin/.codex-plugin/plugin.json"
    printf '%s\n' "initial" > "$source_plugin/content.txt"
    sed '/^hydrate_graphical_session_env$/,$d' "$REPO_DIR/launcher/start.sh.template" > "$launcher_defs"

    (
        export HOME="$fake_home"
        export CODEX_HOME="$fake_home/.codex"
        export CODEX_LINUX_APP_ID="codex-desktop"
        export CODEX_LINUX_APP_DISPLAY_NAME="ChatGPT Desktop"
        export CODEX_LINUX_WEBVIEW_PORT="5175"
        exec 7>&1 8>&2
        # shellcheck disable=SC1090
        source "$launcher_defs"
        exec 1>&7 2>&8
        SCRIPT_DIR="$app_dir"

        sync_extra_bundled_plugin_cache >/dev/null 2>&1
        printf '%s\n' "replacement" > "$source_plugin/content.txt"

        concurrent_destination_injected=0
        mv() {
            local args=("$@")
            local argc="${#args[@]}"
            local source="${args[$((argc - 2))]}"
            local destination="${args[$((argc - 1))]}"
            if [[ "$source" == *".tmp."* ]] && \
               [ "$destination" = "$cache_plugin" ] && \
               [ "$concurrent_destination_injected" -eq 0 ]; then
                mkdir -p "$cache_plugin"
                printf '%s\n' "concurrent" > "$cache_plugin/content.txt"
                concurrent_destination_injected=1
            fi
            command mv "$@"
        }

        sync_extra_bundled_plugin_cache > "$race_log" 2>&1
    )

    assert_contains "$race_log" "previous cache could not be restored"
    assert_not_contains "$race_log" "Extra bundled plugin cache synced from bundled resources"
    assert_contains "$cache_plugin/content.txt" "concurrent"
    assert_not_contains "$cache_plugin/content.txt" "replacement"
    [ -z "$(find "$cache_plugin" -mindepth 1 -maxdepth 1 -type d -name '*.tmp.*' -print -quit)" ] \
        || fail "Expected collision-safe move to avoid nesting the temporary payload"
    [ -z "$(find "$cache_root" -mindepth 1 -maxdepth 1 -type d -name '*.tmp.*' -print -quit)" ] \
        || fail "Expected failed concurrent cache install to clean its temporary directory"
    backup_plugin="$(find "$cache_root" -mindepth 1 -maxdepth 1 -type d -name '*.backup.*' -print -quit)"
    [ -n "$backup_plugin" ] || fail "Expected concurrent cache collision to preserve the previous cache backup"
    assert_contains "$backup_plugin/content.txt" "initial"
}

test_launcher_marketplace_metadata_atomic_staging() (
    info "Checking atomic bundled marketplace metadata staging"
    local workspace="$TMP_DIR/launcher-marketplace-metadata"
    local app_dir="$workspace/app"
    local codex_home="$workspace/codex-home"
    local source_marketplace="$app_dir/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"
    local target_dir="$codex_home/.tmp/bundled-marketplaces/openai-bundled/.agents/plugins"
    local target_marketplace="$target_dir/marketplace.json"
    local function_file="$workspace/stage-function.sh"
    local failing_command
    local observed_temp
    local observed_target

    mkdir -p "$(dirname "$source_marketplace")" "$target_dir"
    printf '%s\n' 'new metadata' > "$source_marketplace"
    awk '/^stage_bundled_marketplace_metadata\(\) \{/{copy=1} copy{print} copy && /^}/{exit}' \
        "$REPO_DIR/launcher/start.sh.template" > "$function_file"
    # shellcheck source=/dev/null
    source "$function_file"
    SCRIPT_DIR="$app_dir"
    CODEX_HOME="$codex_home"

    for failing_command in cp chmod mv; do
        printf '%s\n' 'existing metadata' > "$target_marketplace"
        observed_temp=""
        observed_target=""
        cp() {
            observed_temp="$2"
            [ "$failing_command" != "cp" ] || return 1
            command cp "$@"
        }
        chmod() {
            [ "$failing_command" != "chmod" ] || return 1
            command chmod "$@"
        }
        mv() {
            observed_temp="${@: -2:1}"
            observed_target="${@: -1}"
            [ "$failing_command" != "mv" ] || return 1
            command mv "$@"
        }

        stage_bundled_marketplace_metadata

        assert_contains "$target_marketplace" "existing metadata"
        [ "$(dirname "$observed_temp")" = "$target_dir" ] \
            || fail "Marketplace metadata temp must be created beside the destination"
        [ -z "$(find "$target_dir" -maxdepth 1 -type f -name '.marketplace.json.tmp.*' -print -quit)" ] \
            || fail "Failed marketplace metadata staging must clean its temporary file"
        if [ "$failing_command" = "mv" ]; then
            [ "$observed_target" = "$target_marketplace" ] \
                || fail "Marketplace metadata staging must atomically replace the final target"
        fi
        unset -f cp chmod mv
    done

    stage_bundled_marketplace_metadata
    assert_contains "$target_marketplace" "new metadata"
    [ -z "$(find "$target_dir" -maxdepth 1 -type f -name '.marketplace.json.tmp.*' -print -quit)" ] \
        || fail "Successful marketplace metadata staging must leave no temporary file"

    rm -f "$target_marketplace"
    mkdir -p "$workspace/symlink-target"
    ln -s "$workspace/symlink-target" "$target_marketplace"
    stage_bundled_marketplace_metadata
    [ ! -L "$target_marketplace" ] \
        || fail "Marketplace metadata staging must replace a destination symlink"
    assert_contains "$target_marketplace" "new metadata"
    [ -z "$(find "$workspace/symlink-target" -mindepth 1 -print -quit)" ] \
        || fail "Marketplace metadata staging must not follow a destination directory symlink"
)

test_launcher_template_sanity() {
    info "Checking launcher template markers"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "codex_capture_original_ld_library_path"
    assert_contains "$REPO_DIR/flake.nix" 'export LD_LIBRARY_PATH="${electronLibPath}:${runtimeLibPath}'
    assert_not_contains "$REPO_DIR/flake.nix" '--prefix LD_LIBRARY_PATH'
    assert_contains "$REPO_DIR/flake.nix" 'export CODEX_LINUX_SOURCE_REMOTE="${flakeSourceRemote}"'
    assert_contains "$REPO_DIR/install.sh" 'DEFAULT_CODEX_WEBVIEW_PORT=5175'
    assert_contains "$REPO_DIR/install.sh" "inspect_rebuild_candidate"
    assert_contains "$REPO_DIR/scripts/lib/install-helpers.sh" "--inspect"
    assert_contains "$REPO_DIR/scripts/lib/install-helpers.sh" "--report-dir"
    assert_contains "$REPO_DIR/scripts/lib/asar-patch.sh" "CODEX_PATCH_REPORT_JSON"
    assert_contains "$REPO_DIR/scripts/lib/rebuild-report.sh" "write_rebuild_report_json"
    assert_contains "$REPO_DIR/install.sh" "MIN_BETTER_SQLITE3_VERSION_FOR_ELECTRON_41=\"12.9.0\""
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" "better_sqlite3_build_version"
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" "patch_better_sqlite3_for_v8_external_pointer_api"
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" "@electron/rebuild@4.0.4"
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" "node-abi@^4.31.0"
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" 'node_modules/@electron/rebuild/lib/cli.js'
    assert_not_contains "$REPO_DIR/scripts/lib/native-modules.sh" "npx --yes @electron/rebuild"
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" "prune_native_module_build_artifacts"
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" 'find "$build_dir" -type f ! -name'
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" 'find "$module_dir" -type f -name'
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" "CODEX_ELECTRON_CACHE_DIR"
    assert_contains "$REPO_DIR/scripts/lib/native-modules.sh" "--continue-at -"
    assert_file_exists "$REPO_DIR/launcher/webview-server.py"
    assert_file_exists "$REPO_DIR/launcher/cli-launch-path.py"
    assert_contains "$REPO_DIR/launcher/webview-server.py" "Cache-Control"
    assert_contains "$REPO_DIR/launcher/webview-server.py" "If-Modified-Since"
    assert_contains "$REPO_DIR/install.sh" "webview-server.py"
    assert_contains "$REPO_DIR/install.sh" "cli-launch-path.py"
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'python3 "$SCRIPT_DIR/.codex-linux/webview-server.py" "$CODEX_LINUX_WEBVIEW_PORT" --bind 127.0.0.1'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "WEBVIEW_PID_FILE"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "owned_webview_server_pid"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "discover_webview_server_pid"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "Adopted existing webview server"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "reconcile_runtime_state"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "detect_warm_start"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "send_warm_start_launch_action"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_DESKTOP_LAUNCH_ACTION_SOCKET"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "APP_SETTINGS_FILE"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "linux_setting_enabled"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "register_url_scheme_handlers"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "xdg-mime default"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "x-scheme-handler/"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "codex-browser-sidebar"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "codex-linux-warm-start-enabled"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "--new-instance"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_MULTI_LAUNCH"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_MULTI_LAUNCH_PORT_RANGE"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "choose_multi_launch_port"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "configure_multi_launch_instance"
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'launcher-$CODEX_LINUX_INSTANCE_ID.log'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "ADOPTED_WEBVIEW_PID"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "Reusing webview server pid="
    assert_contains "$REPO_DIR/launcher/start.sh.template" "run_cold_start_hooks"
    assert_contains "$REPO_DIR/launcher/start.sh.template" '2>/dev/null 1>&"\$LAUNCHER_EARLY_STDERR_FD" || true'
    assert_not_contains "$REPO_DIR/launcher/start.sh.template" '>&"\$LAUNCHER_EARLY_STDERR_FD" 2>/dev/null || true'
    assert_contains "$REPO_DIR/linux-features/remote-mobile-control/feature.json" '"stageHook": "./stage.sh"'
    assert_contains "$REPO_DIR/linux-features/remote-mobile-control/stage.sh" "cold-start.d"
    assert_contains "$REPO_DIR/linux-features/remote-mobile-control/stage.sh" "remote-mobile-control"
    assert_contains "$REPO_DIR/linux-features/remote-mobile-control/stage.sh" "cold-start-hook.sh"
    assert_contains "$REPO_DIR/linux-features/remote-mobile-control/cold-start-hook.sh" "remote-control start"
    assert_contains "$REPO_DIR/linux-features/remote-mobile-control/cold-start-hook.sh" "/run/current-system/sw/bin"
    assert_contains "$REPO_DIR/linux-features/remote-mobile-control/cold-start-hook.sh" "codex-remote-control.service"
    assert_contains "$REPO_DIR/linux-features/remote-mobile-control/cold-start-hook.sh" "continuing best-effort in the background"
    assert_contains "$REPO_DIR/flake.nix" "homeManagerModules"
    assert_contains "$REPO_DIR/flake.nix" "nixosModules"
    assert_contains "$REPO_DIR/nix/home-manager-module.nix" "codex-remote-control"
    assert_contains "$REPO_DIR/nix/home-manager-module.nix" "--remote-control"
    assert_contains "$REPO_DIR/nix/home-manager-module.nix" "CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED"
    assert_contains "$REPO_DIR/nix/nixos-module.nix" "codex-remote-control"
    assert_contains "$REPO_DIR/nix/nixos-module.nix" "--remote-control"
    assert_contains "$REPO_DIR/nix/nixos-module.nix" "CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED"
    python3 - "$REPO_DIR/launcher/start.sh.template" <<'PY'
import re
import sys

source = open(sys.argv[1], encoding="utf-8").read()
detect_body = source.split("detect_warm_start() {", 1)[1].split("send_warm_start_launch_action() {", 1)[0]
launch_body = source.split("launch_electron() {", 1)[1].split("load_packaged_runtime_helper", 1)[0]
runtime_body = source.split("trap cleanup_launcher EXIT", 1)[1].split("launch_electron", 1)[0]
webview_probe_body = source.split("webview_port_is_open() {", 1)[1].split("wait_for_webview_server() {", 1)[0]
wait_body = source.split("wait_for_webview_server() {", 1)[1].split("verify_webview_origin() {", 1)[0]
send_body = source.split("send_warm_start_launch_action() {", 1)[1].split("webview_origin_is_reachable() {", 1)[0]
prelaunch_hooks_body = source.split("run_feature_prelaunch_hooks() {", 1)[1].split("bundled_plugin_version() {", 1)[0]
launcher_hooks_body = source.split("run_feature_launcher_hooks() {", 1)[1].split("build_electron_launch_args() {", 1)[0]
cold_start_hooks_body = source.split("run_cold_start_hooks() {", 1)[1].split("run_cli_preflight() {", 1)[0]
after_exit_hooks_body = source.split("run_feature_after_exit_hooks() {", 1)[1].split("run_cli_preflight() {", 1)[0]
cli_probe_body = source.split("codex_cli_version_probe() {", 1)[1].split("codex_cli_version() {", 1)[0]
cli_preflight_body = source.split("run_cli_preflight() {", 1)[1].split("run_cli_preflight_background() {", 1)[0]
notify_body = source.split("notify_error() {", 1)[1].split("canonical_path() {", 1)[0]
update_manager_body = source.split("run_update_manager() {", 1)[1].split("pid_is_current_user() {", 1)[0]
stop_body = source.split("stop_owned_webview_server() {", 1)[1].split("owned_webview_server_pid() {", 1)[0]
stale_body = source.split("pid_is_stale_webview_server() {", 1)[1].split("stop_owned_webview_server() {", 1)[0]
multi_body = source.split("configure_multi_launch_instance() {", 1)[1].split('WEBVIEW_ORIGIN="http://127.0.0.1:$CODEX_LINUX_WEBVIEW_PORT"', 1)[0]
adopt_body = source.split("adopt_existing_webview_server() {", 1)[1].split("start_webview_server() {", 1)[0]
ensure_body = source.split("start_webview_server() {", 1)[1].split("wait_for_webview_server", 1)[0]
reconcile_body = source.split("reconcile_runtime_state() {", 1)[1].split("set_electron_defaults() {", 1)[0]
match_executable_body = source.split("pid_matches_executable() {", 1)[1].split("find_running_app_pid() {", 1)[0]
arg0_path_body = source.split("pid_cmdline_arg0_path() {", 1)[1].split("pid_arg0_matches_path() {", 1)[0]
arg0_match_body = source.split("pid_arg0_matches_path() {", 1)[1].split("pid_environ_lines() {", 1)[0]
foreign_body = source.split("pid_is_foreign_codex_electron() {", 1)[1].split("discover_running_app_pid() {", 1)[0]
summary_body = source.split("pid_summary() {", 1)[1].split("detect_cross_install_conflict() {", 1)[0]
warm_recovery_body = source.split("recover_unhealthy_running_app() {", 1)[1].split("send_warm_start_launch_action() {", 1)[0]
terminate_body = source.split("terminate_stale_electron_with_pidfd() {", 1)[1].split("recover_unhealthy_running_app() {", 1)[0]
if 'LAUNCHER_ARGS=()' not in source:
    raise SystemExit("launcher must keep a sanitized argv for launcher-only flags")
if 'CODEX_LINUX_FEATURES_DIR="$SCRIPT_DIR/.codex-linux/features"' not in source:
    raise SystemExit("launcher must expose the app-local Linux feature resource directory")
if 'export CODEX_HOME CODEX_LINUX_APP_ID CODEX_LINUX_APP_DISPLAY_NAME CODEX_LINUX_WEBVIEW_PORT CODEX_LINUX_SETTINGS_FILE CODEX_LINUX_FEATURES_DIR' not in source:
    raise SystemExit("launcher must export CODEX_HOME and Linux feature resource directory")
if 'configure_multi_launch_instance "$@"' not in source:
    raise SystemExit("launcher must configure multi-launch before deriving WEBVIEW_ORIGIN")
if 'unset CODEX_LINUX_MULTI_LAUNCH' not in source.split('parse_launcher_args() {', 1)[0]:
    raise SystemExit("launcher must clear inherited internal multi-launch markers before parsing args")
if '$((CODEX_LINUX_WEBVIEW_PORT + 4))' not in source:
    raise SystemExit("multi-launch default range must cap the default at five ports")
if '( trap - EXIT\n      exec 3<>/dev/tcp/127.0.0.1/"$CODEX_LINUX_WEBVIEW_PORT" || exit 1\n      exec 3>&- 3<&-\n      exit 0 )' not in webview_probe_body:
    raise SystemExit("webview port probe must not inherit the launcher EXIT cleanup trap")
if '( trap - EXIT\n      sleep 0.2' not in webview_probe_body:
    raise SystemExit("webview port probe watchdog must not inherit the launcher EXIT cleanup trap")
if "webview_origin_is_reachable_fast" not in wait_body or "webview_port_is_open" in wait_body:
    raise SystemExit("wait_for_webview_server must use the HTTP origin as the readiness signal")
if "if webview_origin_is_reachable;" not in wait_body:
    raise SystemExit("wait_for_webview_server must fall back to full origin verification before failing")
if 'CODEX_LINUX_INSTANCE_ID="port-$CODEX_LINUX_WEBVIEW_PORT"' not in multi_body:
    raise SystemExit("multi-launch must derive a stable instance id from the allocated port")
if 'CODEX_LINUX_MULTI_LAUNCH=1' not in multi_body:
    raise SystemExit("multi-launch must export an app-visible multi-launch marker")
if 'export CODEX_ELECTRON_USER_DATA_DIR CODEX_LINUX_INSTANCE_ID CODEX_LINUX_MULTI_LAUNCH CODEX_LINUX_WEBVIEW_PORT' not in multi_body:
    raise SystemExit("multi-launch must export instance identity for Electron")
if 'APP_STATE_DIR="$base_state_dir/instances/$CODEX_LINUX_INSTANCE_ID"' not in multi_body:
    raise SystemExit("multi-launch must isolate app pid/webview state per allocated port")
if 'LAUNCH_ACTION_RUNTIME_DIR="$XDG_RUNTIME_DIR/$CODEX_LINUX_APP_ID/instances/$CODEX_LINUX_INSTANCE_ID"' not in multi_body:
    raise SystemExit("multi-launch must isolate warm-start sockets per allocated port")
if 'CODEX_ELECTRON_USER_DATA_DIR="$APP_STATE_DIR/electron-user-data"' not in multi_body:
    raise SystemExit("multi-launch must force a per-instance Electron user-data dir")
if 'send_warm_start_launch_action "${LAUNCHER_ARGS[@]}"' not in source:
    raise SystemExit("warm-start handoff must not receive launcher-only multi-launch flags")
if "client.shutdown(socket.SHUT_WR)" not in send_body or "response = client.recv(32)" not in send_body:
    raise SystemExit("warm-start IPC client must read the Electron socket acknowledgement")
if 'launch_electron "${LAUNCHER_ARGS[@]}"' not in source:
    raise SystemExit("Electron launch must receive sanitized launcher args")
if 'FEATURE_LAUNCHER_HOOK_DIR="$SCRIPT_DIR/.codex-linux/launcher.d"' not in source:
    raise SystemExit("launcher must expose a generic Linux feature launcher hook directory")
if launch_body.index("run_feature_launcher_hooks") > launch_body.index("build_electron_launch_args"):
    raise SystemExit("Linux feature launcher hooks must run before final Electron launch args are built")
if "configure_electron_proxy_from_env" in source or "CODEX_LINUX_PROXY_SERVER=URL" in source:
    raise SystemExit("authenticated proxy setup must live in an opt-in Linux feature, not the core launcher")
if 'Adopted concurrently-started verified webview server' not in source:
    raise SystemExit("launcher must tolerate a concurrent verified webview server winning the bind race")
if 'set_detected_running_app "$pid"' not in detect_body:
    raise SystemExit("detect_warm_start must record a pid-file running app even when warm start is disabled")
if 'runtime_recovery_scan_needed && pid="$(discover_running_app_pid)"' not in detect_body:
    raise SystemExit("detect_warm_start must limit the running-app scan to recovery cases")
if '[ -S "$LAUNCH_ACTION_SOCKET" ]' in detect_body:
    raise SystemExit("detect_warm_start must not gate the running-app scan on launch socket existence; hidden instances can lose the socket")
if not re.search(r'if ! linux_setting_enabled "codex-linux-warm-start-enabled" 1; then.*?return 0', source, re.S):
    raise SystemExit("detect_warm_start must not fail when warm start is disabled")
if "preserving liveness marker for second-instance handoff" not in source:
    raise SystemExit("detect_warm_start must preserve the live app liveness marker")
if "running_app_uses_renderer_url_override" not in warm_recovery_body:
    raise SystemExit("warm-start recovery must preserve explicit renderer URL overrides")
if "webview_origin_is_reachable" not in warm_recovery_body or "webview_port_is_open" not in warm_recovery_body:
    raise SystemExit("warm-start recovery must verify the packaged origin and fail closed on an occupied port")
if "acquire_launcher_lock" not in warm_recovery_body or "refresh_launch_state_quick" not in warm_recovery_body:
    raise SystemExit("warm-start recovery must revalidate the stale app while holding the launcher lock")
if "terminate_stale_electron_with_pidfd" not in warm_recovery_body:
    raise SystemExit("warm-start recovery must terminate only an identity-verified stale Electron")
if "os.pidfd_open" not in terminate_body or "signal.pidfd_send_signal" not in terminate_body:
    raise SystemExit("stale Electron termination must bind signals to a pidfd")
for identity_guard in ("expected_start_time", "expected_executable", "expected_app_id", "expected_instance_id"):
    if identity_guard not in terminate_body:
        raise SystemExit(f"pidfd termination is missing identity guard: {identity_guard}")
if 'running_app_is_active || return 0' not in warm_recovery_body or '[ "$WARM_START" -eq 1 ]' in warm_recovery_body:
    raise SystemExit("unhealthy origin recovery must also cover Electron second-instance handoff")
if "renderer_url_override_is_active" in warm_recovery_body:
    raise SystemExit("a new-launch renderer override must not preserve a stale packaged-origin Electron")
if not re.search(r'trap cleanup_launcher EXIT.*?recover_unhealthy_running_app.*?prepare_launch_state_under_lock.*?send_warm_start_launch_action', source, re.S):
    raise SystemExit("launcher must recover an unhealthy packaged origin before warm-start IPC")
if launch_body.count("unset ELECTRON_RUN_AS_NODE") != 2:
    raise SystemExit("launch_electron must clear ELECTRON_RUN_AS_NODE before both Electron launch paths")
if 'pid_matches_executable "$RUNNING_APP_PID" "$SCRIPT_DIR/electron"' not in launch_body:
    raise SystemExit("launch_electron must not overwrite APP_PID_FILE for second-instance handoff")
if 'echo "$ELECTRON_PID" > "$APP_PID_FILE"' not in launch_body:
    raise SystemExit("launch_electron must still write APP_PID_FILE for normal cold launches")
if "pid_cmdline_arg0_path" not in source:
    raise SystemExit("launcher process discovery must use cmdline arg0 path rather than canonicalizing /proc exe paths")
if '${arg0%% *}' in arg0_path_body:
    raise SystemExit("launcher process discovery must preserve argv0 paths containing spaces")
if '"$expected"|"$expected "*' not in arg0_match_body:
    raise SystemExit("launcher process discovery must accept exact argv0 paths and no-NUL cmdline fallbacks")
if "/proc/[0-9]*/exe" in source or 'readlink -f "/proc/$pid/exe"' in source or 'canonical_path "$SCRIPT_DIR/electron"' in source:
    raise SystemExit("launcher process discovery must not scan or canonicalize /proc exe paths; autofs can block those stats")
if "command -v fuser" in source or "timeout 1 fuser" in source or "launcher_lock_holder_pids" in source:
    raise SystemExit("launcher lock diagnostics must not require fuser/timeout or scan /proc fd targets")
if "command -v timeout" in source or re.search(r'(^|[ \t])timeout[ \t]+"?\\$', source, re.M):
    raise SystemExit("launcher hot path must not require external timeout")
if match_executable_body.index('actual="$(pid_cmdline_arg0_path "$pid")"') > match_executable_body.index('pid_is_current_user "$pid"'):
    raise SystemExit("launcher process discovery must check cmdline arg0 before reading /proc status for UID")
if 'basename "$actual"' in foreign_body:
    raise SystemExit("foreign Electron detection must not fork basename for every /proc candidate")
if 'readlink "/proc/$pid/cwd"' in summary_body:
    raise SystemExit("pid summaries in launcher hot paths must not readlink /proc cwd")
electron_launch = '"$SCRIPT_DIR/electron" "${ELECTRON_LAUNCH_ARGS[@]}" "${ELECTRON_ARGS[@]}"'
electron_exec = 'exec "$SCRIPT_DIR/electron" "${ELECTRON_LAUNCH_ARGS[@]}" "${ELECTRON_ARGS[@]}"'
warm_log = 'echo "Electron warm-start handoff:'
normal_log = 'echo "Electron launch mode:'
warm_log_pos = launch_body.index(warm_log)
warm_unset_pos = launch_body.index("unset ELECTRON_RUN_AS_NODE", warm_log_pos)
warm_launch_pos = launch_body.index(electron_launch, warm_unset_pos)
normal_log_pos = launch_body.index(normal_log)
normal_unset_pos = launch_body.index("unset ELECTRON_RUN_AS_NODE", normal_log_pos)
normal_launch_pos = launch_body.index(electron_exec, normal_unset_pos)
if electron_launch + " &" in launch_body:
    raise SystemExit("cold Electron launch must exec from a child, not background the binary directly")
if not (warm_log_pos < warm_unset_pos < warm_launch_pos < normal_log_pos < normal_unset_pos < normal_launch_pos):
    raise SystemExit("launch_electron must clear ELECTRON_RUN_AS_NODE immediately before cold Electron exec")
if "using_second_instance_handoff" not in source or "needs_cold_start" not in source:
    raise SystemExit("launcher must have an explicit second-instance handoff mode")
if "second_instance_handoff_ready" not in runtime_body:
    raise SystemExit("second-instance handoff must skip cold-start setup")
if "clear_bundled_marketplace_tmp_cache\nreconcile_runtime_state" in runtime_body:
    raise SystemExit("warm-start path must not clear bundled marketplace temp cache")
if not re.search(r'if needs_cold_start; then\s+log_phase "cold_start_cache_sync_start"\s+clear_bundled_marketplace_tmp_cache.*?stage_bundled_marketplace_metadata.*?sync_browser_use_bundled_plugin_cache &.*?sync_chrome_bundled_plugin_cache &.*?sync_computer_use_bundled_plugin_cache &.*?sync_read_aloud_bundled_plugin_cache &.*?sync_extra_bundled_plugin_cache &.*?run_cold_start_hooks.*?log_phase "cold_start_hooks_dispatched"\s+await_webview_server_ready\s+fi', runtime_body, re.S):
    raise SystemExit("bundled marketplace cleanup, staged metadata, concurrent plugin syncs, cold-start hooks, and the webview readiness wait must run only on cold start")
# The plugin syncs run concurrently, so the shared marketplace.json is staged
# exactly once beforehand and every sync is awaited before cold-start hooks.
if source.count('\n    stage_bundled_marketplace_metadata\n') != 1:
    raise SystemExit("bundled marketplace metadata must be staged exactly once")
if 'rm -f "$marketplace_plugins_dir/marketplace.json"' in source:
    raise SystemExit("bundled marketplace metadata must not delete the live target before copying")
if 'mktemp "$marketplace_plugins_dir/.marketplace.json.tmp.XXXXXX"' not in source:
    raise SystemExit("bundled marketplace metadata temp must be unique and destination-adjacent")
if 'mv -fT -- "$marketplace_temp" "$marketplace_target"' not in source:
    raise SystemExit("bundled marketplace metadata must atomically replace the live target")
for sync_pid_var in ("SYNC_BROWSER_USE_PID", "SYNC_CHROME_PID", "SYNC_COMPUTER_USE_PID", "SYNC_READ_ALOUD_PID", "SYNC_EXTRA_PID"):
    if 'wait "$' + sync_pid_var + '"' not in runtime_body:
        raise SystemExit(f"cold start must await concurrent plugin sync {sync_pid_var}")
    if runtime_body.index('wait "$' + sync_pid_var + '"') > runtime_body.index("run_cold_start_hooks"):
        raise SystemExit(f"plugin sync {sync_pid_var} must be awaited before cold-start hooks run")
for marker in (
    "initial_launch_state_refresh_start",
    "initial_launch_state_refreshed",
    "feature_prelaunch_start",
    "packaged_prelaunch_start",
    "bundled_marketplace_metadata_staged",
    "browser_use_plugin_cache_synced",
    "chrome_plugin_cache_synced",
    "computer_use_plugin_cache_synced",
    "read_aloud_plugin_cache_synced",
    "launcher_lock_ready",
    "launch_state_refreshed_under_lock",
):
    if f'log_phase "{marker}"' not in source:
        raise SystemExit(f"launcher must log phase marker {marker}")
if 'if [ -z "${CODEX_CLI_PATH:-}" ]; then' not in runtime_body:
    raise SystemExit("launcher must run the cheap CLI lookup even for second-instance fallback")
if 'if needs_cold_start && [ -z "$CODEX_CLI_PATH" ]; then' not in runtime_body:
    raise SystemExit("second-instance handoff must skip missing-CLI failure")
if '"$HOME/.bun/bin/codex"' not in source:
    raise SystemExit("CLI lookup must include bun global install path")
if "codex_cli_version_probe()" not in source or "codex_cli_version()" not in source or "codex_cli_missing_optional_dependency()" not in source:
    raise SystemExit("CLI lookup must log a bounded best-effort resolved CLI version probe")
if "version unknown; set CODEX_CLI_PATH=/path/to/codex" not in source:
    raise SystemExit("CLI lookup diagnostics must explain explicit CODEX_CLI_PATH pinning")
if 'local self_pid="${BASHPID:-$$}"' not in source or 'pid_parent_matches "$probe_pid" "$self_pid"' not in source:
    raise SystemExit("CLI version probe watchdog must guard kills against PID reuse")
if source.count('{ exec 9>&-; } 2>/dev/null || true') < 2:
    raise SystemExit("CLI version probe children must close their inherited watchdog fd 9")
for unexpected in ("find_codex_cli_entry", "codex_cli_version_compare", "codex_cli_version_gt", "sort -V"):
    if unexpected in source:
        raise SystemExit(f"launcher must not rank discovered CLI candidates with {unexpected}")
if "if needs_cold_start;" not in runtime_body:
    raise SystemExit("second-instance handoff must skip CLI preflight")
if 'run_cold_start_hooks' not in runtime_body:
    raise SystemExit("cold start must run feature-staged hooks before Electron launches")
for name, body in (("prelaunch", prelaunch_hooks_body), ("cold-start", cold_start_hooks_body), ("launcher", launcher_hooks_body)):
    if 'CODEX_HOME="$CODEX_HOME"' not in body:
        raise SystemExit(f"launcher {name} hooks must receive resolved CODEX_HOME")
    if 'CODEX_LINUX_FEATURES_DIR="$CODEX_LINUX_FEATURES_DIR"' not in body:
        raise SystemExit(f"launcher {name} hooks must receive the app-local Linux feature resource directory")
    if 'codex_run_host_command "$hook"' not in body:
        raise SystemExit(f"launcher {name} hooks must not inherit packaged LD_LIBRARY_PATH")
if 'codex_run_host_command "$hook"' not in after_exit_hooks_body:
    raise SystemExit("launcher after-exit hooks must not inherit packaged LD_LIBRARY_PATH")
if 'codex_exec_host_command "$@"' not in cli_probe_body:
    raise SystemExit("launcher CLI version probes must not inherit packaged LD_LIBRARY_PATH")
if "CODEX_CLI_PROBE_STDERR_FILE" in source:
    raise SystemExit("launcher CLI probes must not expose stderr redirection through inherited environment")
if 'local require_success="${2:-0}"' not in cli_preflight_body:
    raise SystemExit("CLI preflight must support a required-success repair mode")
if not re.search(r'cli_repair_required=0\s+if codex_cli_missing_optional_dependency "\$CODEX_CLI_PATH"; then\s+cli_repair_required=1\s+fi\s+if \[ "\$\{CODEX_SYNC_CLI_PREFLIGHT:-0\}" = "1" \]; then\s+if ! run_cli_preflight 0 "\$cli_repair_required"; then.*?exit 1.*?cli_preflight_repair_sync', runtime_body, re.S):
    raise SystemExit("sync CLI preflight must detect a required repair first and preserve fail-closed semantics")
if not re.search(r'elif \[ "\$cli_repair_required" = "1" \]; then\s+if ! run_cli_preflight 0 1; then.*?exit 1.*?cli_preflight_repair_sync', runtime_body, re.S):
    raise SystemExit("a known broken Linux CLI must be repaired synchronously or abort before Electron launch")
if 'codex_run_host_command notify-send' not in notify_body:
    raise SystemExit("desktop notifications must not inherit packaged LD_LIBRARY_PATH")
if 'codex_run_host_command "$CODEX_UPDATE_MANAGER_PATH" "$@"' not in update_manager_body:
    raise SystemExit("update manager and its host children must not inherit packaged LD_LIBRARY_PATH")
if 'CODEX_LINUX_FEATURE_HOOK_PHASE=launcher' not in launcher_hooks_body:
    raise SystemExit("launcher hooks must receive their hook phase")
if '"$hook" "${ELECTRON_ARGS[@]}"' not in launcher_hooks_body:
    raise SystemExit("launcher hooks must receive current Electron args as argv")
if 'env\\ *)' not in launcher_hooks_body or 'electron-arg\\ *)' not in launcher_hooks_body:
    raise SystemExit("launcher hooks must use the generic env/electron-arg stdout protocol")
if 'COLD_START_HOOK_DIR' not in cold_start_hooks_body or '"$hook" "$SCRIPT_DIR" "$APP_STATE_DIR" "$LOG_DIR"' not in cold_start_hooks_body:
    raise SystemExit("launcher cold-start hook runner must be generic and pass standard paths")
if '>>"$LOG_FILE" 2>&1 &' not in cold_start_hooks_body:
    raise SystemExit("launcher cold-start hooks must be non-blocking")
if 'remote_mobile_control_main' in source:
    raise SystemExit("remote mobile daemon startup must live in the remote-mobile-control feature hook, not the main launcher")
if "running_app_is_active" not in stop_body or "Preserving webview server" not in stop_body:
    raise SystemExit("stop_owned_webview_server must not stop the live app webview server")
if "stale_webview_server_pid" not in source or "stop_stale_webview_server" not in source:
    raise SystemExit("launcher must detect stale deleted webview servers left behind by previous installs")
if 'current_webview_dir="$(canonical_path "$WEBVIEW_DIR")"' not in stale_body:
    raise SystemExit("stale webview detection must compare against the current bundle path")
if '[ "$cwd" != "$current_webview_dir" ]' not in stale_body:
    raise SystemExit("stale webview detection must catch servers moved into backup bundle directories")
if 'ADOPTED_WEBVIEW_PID="$pid"' not in adopt_body:
    raise SystemExit("adopt_existing_webview_server must not mark a running app server as started by this launcher")
if 'STARTED_WEBVIEW_PID="$pid"' not in adopt_body:
    raise SystemExit("adopt_existing_webview_server must still own orphaned servers when no live app is running")
if "running_app_is_active" not in adopt_body:
    raise SystemExit("adopt_existing_webview_server must detect live-app reuse before cleanup")
if "if adopt_existing_webview_server; then" not in ensure_body:
    raise SystemExit("start_webview_server must split adoption from origin verification")
if "stop_stale_webview_server" not in ensure_body:
    raise SystemExit("start_webview_server must clear stale deleted webview servers before treating the port as foreign")
if ensure_body.find("stop_stale_webview_server") > ensure_body.find("is already serving Codex content"):
    raise SystemExit("start_webview_server must try stale-server cleanup before foreign reachable-port failure")
if "Keeping the live app untouched" not in ensure_body:
    raise SystemExit("start_webview_server must not stop a live app server when validation fails")

# Cold-start overlap: the webview server is spawned before the plugin cache
# syncs and only awaited (readiness + origin verification) after them, so the
# Python server boots while the launcher does unrelated work. Electron must
# still never launch before the origin is verified.
if "ensure_webview_server" in source:
    raise SystemExit("ensure_webview_server was split into start_webview_server + await_webview_server_ready")
if "WEBVIEW_STARTUP_PENDING" not in source:
    raise SystemExit("start_webview_server must track pending startup for await_webview_server_ready")
cold_flow = source.split("elif needs_cold_start; then", 1)[1]
if "\n    start_webview_server\n" not in cold_flow:
    raise SystemExit("cold start must spawn the webview server before the cache syncs")
overlap_start = cold_flow.index("\n    start_webview_server\n")
overlap_sync = cold_flow.index('log_phase "cold_start_cache_sync_start"')
overlap_last_sync = cold_flow.index("sync_extra_bundled_plugin_cache")
overlap_await = cold_flow.index("\n    await_webview_server_ready\n")
if not (overlap_start < overlap_sync < overlap_last_sync < overlap_await):
    raise SystemExit("webview readiness wait must overlap the plugin cache syncs and finish before Electron")
await_body = source.split("await_webview_server_ready() {", 1)[1].split("clear_stale_pid_file() {", 1)[0]
if "wait_for_webview_server" not in await_body or "verify_webview_origin" not in await_body:
    raise SystemExit("await_webview_server_ready must keep readiness and origin verification before Electron")
if 'log_phase "webview_ready"' not in await_body:
    raise SystemExit("await_webview_server_ready must keep the webview_ready phase marker")
if 'if [ -n "${RUNNING_APP_PID:-}" ] && running_app_is_active; then' not in reconcile_body:
    raise SystemExit("reconcile_runtime_state must preserve runtime markers when a live app still exists")
if 'discover_running_app_pid' in reconcile_body:
    raise SystemExit("reconcile_runtime_state must not perform full process discovery on the normal startup path")
if 'rm -f "$LAUNCH_ACTION_SOCKET"' not in reconcile_body:
    raise SystemExit("reconcile_runtime_state must clear a stale launch-action socket when no live app exists")
if 'clear_stale_pid_file' not in reconcile_body:
    raise SystemExit("reconcile_runtime_state must still clear stale app.pid markers")
if 'if [ -z "$webview_pid" ] || { ! pid_is_webview_server "$webview_pid" && ! pid_is_stale_webview_server "$webview_pid"; }; then' not in reconcile_body:
    raise SystemExit("reconcile_runtime_state must clear stale launcher webview ownership markers without touching valid orphaned servers")
discover_body = source.split("discover_running_app_pid() {", 1)[1].split("running_app_is_active() {", 1)[0]
if 'pid_in_same_launch_instance "$pid"' not in discover_body:
    raise SystemExit("discover_running_app_pid must filter by launch instance so default and side-by-side apps never adopt each other")
instance_match_body = source.split("pid_in_same_launch_instance() {", 1)[1].split("discover_running_app_pid() {", 1)[0]
if 'CODEX_LINUX_INSTANCE_ID=$CODEX_LINUX_INSTANCE_ID' not in instance_match_body or 'CODEX_LINUX_MULTI_LAUNCH=1' not in instance_match_body:
    raise SystemExit("pid_in_same_launch_instance must match instance identity from the process environment")
if not re.search(r'log_phase "initial_launch_state_refresh_start"\s+refresh_launch_state\s+log_phase "initial_launch_state_refreshed"\s+trap cleanup_launcher EXIT', source):
    raise SystemExit("launcher must do an initial runtime-state refresh before warm-start IPC")
if "trap 'exit 130' INT" not in source or "trap 'exit 143' TERM" not in source or "trap 'exit 129' HUP" not in source:
    raise SystemExit("launcher must cleanup through EXIT after INT/TERM/HUP")
prepare_body = source.split("prepare_launch_state_under_lock() {", 1)[1].split("launch_electron() {", 1)[0]
if "acquire_launcher_lock" not in prepare_body or "refresh_launch_state_quick" not in prepare_body:
    raise SystemExit("launcher must refresh launch state under the launcher lock before cold-start work")
if not re.search(r'prepare_launch_state_under_lock.*?elif needs_cold_start; then.*?start_webview_server', source, re.S):
    raise SystemExit("launcher must acquire the cold-start lock before spawning the packaged webview")
if "No new app process was started" not in prepare_body:
    raise SystemExit("launcher lock timeout must fail closed instead of continuing a duplicate cold start")
if 'CODEX_LAUNCHER_LOCK_WAIT_SECONDS:-5' not in source:
    raise SystemExit("launcher lock wait must default to 5 seconds so duplicate launches do not look hung")
if "fcntl.flock" not in source or "PR_SET_PDEATHSIG" not in source:
    raise SystemExit("launcher lock must be held by a parent-death-bound helper instead of an inherited fd")
if 'wait_seconds * 20 + 20' not in source:
    raise SystemExit("launcher lock helper status wait must remain bounded")
if "detect_cross_install_conflict" not in source or "Both use app id" not in source:
    raise SystemExit("launcher must still support same-identity cross-install diagnostics")
if "LAUNCHER_LOCK_TIMED_OUT" not in source:
    raise SystemExit("launcher must track bounded lock timeout failures")
if "reap_orphaned_runtime_processes" in source or "pid_is_orphaned_runtime_process" in source:
    raise SystemExit("lock timeout must not kill processes belonging to the active serialized cold start")
if "LAUNCHER_LOCK_HELD=1" not in source or "stop_launcher_lock_helper" not in source:
    raise SystemExit("launcher must explicitly release and reap its dedicated lock helper")
if "signal.SIGUSR1, 500" not in source or "signal.SIGTERM, 500" not in source or "signal.SIGKILL, 500" not in source:
    raise SystemExit("launcher lock helper shutdown must use bounded identity-bound pidfd escalation")
if "launcher_lock_helper_is_active" not in source or "require_active_launcher_lock" not in launch_body:
    raise SystemExit("launcher must fail closed if the identity-bound lock helper exits before Electron")
if "LAUNCHER_LOCK_CONTROL_PATH" in source or "mkfifo" in source:
    raise SystemExit("launcher lock release must not expose an inherited FIFO capability")
if "CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1" not in launch_body:
    raise SystemExit("launcher must log the GPU compositing workaround hint for side-panel flicker")
if launch_body.count("release_launcher_lock") != 2:
    raise SystemExit("launch_electron must release the launcher lock on both the warm-start and cold-start paths")
if launch_body.index("release_launcher_lock", launch_body.index('echo "$ELECTRON_PID" > "$APP_PID_FILE"')) > launch_body.index('wait "$ELECTRON_PID"'):
    raise SystemExit("launch_electron must release the launcher lock after writing app.pid and before waiting on Electron")
PY
    local launcher_probe
    local output
    launcher_probe="$TMP_DIR/launcher-rendering-probe.sh"
    python3 - "$REPO_DIR/launcher/start.sh.template" "$launcher_probe" <<'PY'
import sys

source_path, output_path = sys.argv[1:3]
source = open(source_path, encoding="utf-8").read()
host_command_helpers = source[
    source.index("codex_restore_original_ld_library_path() {"):
    source.index("# Capture before package-specific launcher patches")
]
start = source.index("is_wsl_environment() {")
end = source.index("configure_side_by_side_app_env() {")
helpers = source[start:end].replace(
    "is_wsl_environment() {",
    "launcher_is_wsl_environment() {",
    1,
)
probe = "#!/usr/bin/env bash\n" + host_command_helpers + helpers + r'''
set -Eeuo pipefail

is_wsl_environment() {
    [ "${CODEX_TEST_ASSUME_NON_WSL:-0}" != "1" ] || return 1
    launcher_is_wsl_environment
}

CODEX_LINUX_APP_ID="${CODEX_LINUX_APP_ID:-codex-desktop}"
SCRIPT_DIR="${SCRIPT_DIR:-/tmp/codex-launcher-probe-app}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
APP_STATE_DIR="${APP_STATE_DIR:-/tmp/codex-launcher-probe-state}"
APP_CONFIG_DIR="${APP_CONFIG_DIR:-/tmp/codex-launcher-probe-config.$$}"
USER_ELECTRON_FLAGS_FILE="${USER_ELECTRON_FLAGS_FILE:-$APP_CONFIG_DIR/electron-flags.conf}"
LOG_FILE="${LOG_FILE:-/tmp/codex-launcher-probe.log}"
CODEX_LINUX_FEATURES_DIR="${CODEX_LINUX_FEATURES_DIR:-$SCRIPT_DIR/.codex-linux/features}"
FEATURE_ELECTRON_ARGS_DIR="${FEATURE_ELECTRON_ARGS_DIR:-}"
FEATURE_LAUNCHER_HOOK_DIR="${FEATURE_LAUNCHER_HOOK_DIR:-}"

print_state() {
    printf 'mode=%s wslg=%s ozone_platform=%s ozone_hint=%s gpu=%s gpu_arg=%s comp=%s gl_added=%s renderer_accessibility=%s hook_value=%s hook_saw_arg=%s launch=' \
        "$ELECTRON_RENDERING_MODE" \
        "$ELECTRON_WSLG_DETECTED" \
        "${ELECTRON_OZONE_PLATFORM:-}" \
        "${ELECTRON_OZONE_HINT:-}" \
        "$ELECTRON_GPU_ENABLED" \
        "$ELECTRON_GPU_DISABLE_SWITCH_IN_ARGS" \
        "$ELECTRON_GPU_COMPOSITING_DISABLED" \
        "$ELECTRON_GL_SWITCH_ADDED" \
        "$ELECTRON_RENDERER_ACCESSIBILITY_FORCED" \
        "${CODEX_TEST_LAUNCHER_HOOK_VALUE:-}" \
        "${CODEX_TEST_LAUNCHER_HOOK_SAW_ARG:-}"
    for arg in "${ELECTRON_LAUNCH_ARGS[@]}"; do
        printf '<%s>' "$arg"
    done
    printf ' electron='
    for arg in "${ELECTRON_ARGS[@]}"; do
        printf '<%s>' "$arg"
    done
    printf '\n'
}

case "${1:-}" in
    probe)
        shift
        load_feature_electron_args
        load_user_electron_flags
        set_electron_defaults "${FEATURE_ELECTRON_ARGS[@]}" "${USER_ELECTRON_FLAGS[@]}" "$@"
        run_feature_launcher_hooks
        build_electron_launch_args
        print_state
        ;;
    ensure-template)
        ensure_user_electron_flags_file
        ;;
    *)
        echo "Usage: $0 probe [launcher args...]" >&2
        exit 2
        ;;
esac
'''
open(output_path, "w", encoding="utf-8").write(probe)
PY
    chmod +x "$launcher_probe"

    local at_stub_dir="$TMP_DIR/assistive-tech-stubs"
    mkdir -p "$at_stub_dir/none" "$at_stub_dir/orca" "$at_stub_dir/screenreader" \
        "$at_stub_dir/toolkit" "$at_stub_dir/atspibus" "$at_stub_dir/slowbus"
    printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$at_stub_dir/none/pgrep"
    printf '%s\n' '#!/usr/bin/env bash' "printf 'false\\n'" > "$at_stub_dir/none/gsettings"
    printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$at_stub_dir/orca/pgrep"
    printf '%s\n' '#!/usr/bin/env bash' "printf 'false\\n'" > "$at_stub_dir/orca/gsettings"
    printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$at_stub_dir/screenreader/pgrep"
    printf '%s\n' '#!/usr/bin/env bash' "printf 'true\\n'" > "$at_stub_dir/screenreader/gsettings"
    # Computer Use gsettings fallback: toolkit-accessibility on, screen reader off.
    cat > "$at_stub_dir/toolkit/gsettings" <<'EOF'
#!/usr/bin/env bash
case "${3:-}" in
    toolkit-accessibility) printf 'true\n' ;;
    *) printf 'false\n' ;;
esac
EOF
    printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$at_stub_dir/toolkit/pgrep"
    # Computer Use primary path: org.a11y.Status IsEnabled=true via busctl.
    printf '%s\n' '#!/usr/bin/env bash' "printf 'false\\n'" > "$at_stub_dir/atspibus/gsettings"
    printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$at_stub_dir/atspibus/pgrep"
    printf '%s\n' '#!/usr/bin/env bash' "printf 'b true\\n'" > "$at_stub_dir/atspibus/busctl"
    # Hung session bus: gsettings blocks far past the launch-path budget.
    cat > "$at_stub_dir/slowbus/gsettings" <<'EOF'
#!/usr/bin/env bash
: "${CODEX_TEST_SLOWBUS_PID_FILE:=}"
if [ -n "$CODEX_TEST_SLOWBUS_PID_FILE" ]; then
    printf '%s\n' "$$" > "$CODEX_TEST_SLOWBUS_PID_FILE"
fi
sleep 5
printf 'true\n'
EOF
    printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$at_stub_dir/slowbus/pgrep"
    local at_stub_variant
    for at_stub_variant in none orca screenreader toolkit slowbus; do
        printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$at_stub_dir/$at_stub_variant/busctl"
    done
    chmod +x "$at_stub_dir"/*/pgrep "$at_stub_dir"/*/gsettings "$at_stub_dir"/*/busctl

    output="$(env -i PATH="$at_stub_dir/none:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe --x11 -- --use-gl=angle)"
    [[ "$output" == *"electron=<--use-gl=angle>"* ]] || fail "launcher must pass Electron args after -- without the separator: $output"
    [[ "$output" != *"electron=<--><--use-gl=angle>"* ]] || fail "launcher must not pass the -- separator to Electron: $output"
    [[ "$output" == *"<--ozone-platform=x11>"* ]] || fail "launcher --x11 must still set the Electron ozone platform: $output"
    [[ "$output" == *"comp=0"* && "$output" != *"<--disable-gpu-compositing>"* ]] || fail "default Linux profile must keep GPU compositing enabled: $output"
    [[ "$output" == *"renderer_accessibility=0"* && "$output" != *"<--force-renderer-accessibility>"* ]] || fail "default Linux profile must not force renderer accessibility without assistive technology: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" XDG_SESSION_TYPE=wayland CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"comp=1"* && "$output" == *"<--disable-gpu-compositing>"* ]] || fail "Wayland default profile must disable GPU compositing for side-panel stability: $output"

    local drm_stub_dir="$TMP_DIR/drm-stubs/two"
    mkdir -p "$drm_stub_dir/card0-DP-2" "$drm_stub_dir/card0-HDMI-3"
    printf '%s\n' connected > "$drm_stub_dir/card0-DP-2/status"
    printf '%s\n' connected > "$drm_stub_dir/card0-HDMI-3/status"
    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_TEST_ASSUME_NON_WSL=1 CODEX_DRM_CLASS_ROOT="$drm_stub_dir" DISPLAY=:0 XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=ubuntu:GNOME "$launcher_probe" probe)"
    [[ "$output" == *"mode=gnome-wayland-multi-monitor"* && "$output" == *"<--ozone-platform=x11>"* ]] || fail "GNOME Wayland multi-monitor auto profile must force X11 for stable maximize/scale behavior: $output"
    [[ "$output" != *"<--ozone-platform-hint=auto>"* ]] || fail "GNOME Wayland multi-monitor auto profile must not leave backend selection to Electron: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" XDG_SESSION_TYPE=wayland CODEX_LINUX_RENDERING_MODE=default CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=0 "$launcher_probe" probe)"
    [[ "$output" == *"comp=0"* && "$output" != *"<--disable-gpu-compositing>"* ]] || fail "CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=0 must suppress the Wayland compositor workaround: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe -- --ozone-platform=x11)"
    [[ "$output" == *"electron=<--ozone-platform=x11>"* ]] || fail "pass-through ozone platform must reach Electron: $output"
    [[ "$output" != *"<--ozone-platform-hint=auto>"* ]] || fail "launcher must not add ozone hint when pass-through supplies an ozone platform: $output"

    local feature_launcher_hook_dir="$TMP_DIR/feature-launcher-hooks"
    mkdir -p "$feature_launcher_hook_dir"
    cat > "$feature_launcher_hook_dir/generic-hook" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'env CODEX_TEST_LAUNCHER_HOOK_VALUE=from-hook'
printf '%s\n' 'electron-arg --test-feature-launcher-hook=1'
printf '%s\n' 'electron-arg --enable-features=TestHookFeature'
for arg in "$@"; do
    if [ "$arg" = "--existing-electron-arg" ]; then
        printf '%s\n' 'env CODEX_TEST_LAUNCHER_HOOK_SAW_ARG=1'
    fi
done
EOF
    chmod +x "$feature_launcher_hook_dir/generic-hook"
    output="$(env -i PATH="$PATH" HOME="$HOME" FEATURE_LAUNCHER_HOOK_DIR="$feature_launcher_hook_dir" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe -- --existing-electron-arg)"
    [[ "$output" == *"hook_value=from-hook hook_saw_arg=1"* ]] || fail "launcher hook must contribute environment variables and receive current Electron args: $output"
    [[ "$output" == *"electron=<--existing-electron-arg><--test-feature-launcher-hook=1>"* ]] || fail "launcher hook must append Electron args after existing args: $output"
    [[ "$output" == *"<--enable-features=TestHookFeature>"* ]] || fail "launcher hook enable-features output must merge into launch args: $output"

    local user_flags_dir="$TMP_DIR/user-electron-flags"
    local user_flags_file="$user_flags_dir/electron-flags.conf"
    mkdir -p "$user_flags_dir"
    printf '%s\n' \
        '# --disable-gpu' \
        '' \
        '--ozone-platform=x11' \
        '--enable-wayland-ime' \
        '--use-gl=angle' > "$user_flags_file"

    output="$(env -i PATH="$PATH" HOME="$HOME" APP_CONFIG_DIR="$user_flags_dir" USER_ELECTRON_FLAGS_FILE="$user_flags_file" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"<--ozone-platform=x11>"* ]] || fail "persistent flags file must set the Electron ozone platform: $output"
    [[ "$output" != *"<--ozone-platform-hint=auto>"* ]] || fail "persistent ozone platform must suppress the default ozone hint: $output"
    [[ "$output" == *"electron=<--enable-wayland-ime><--use-gl=angle>"* ]] || fail "persistent flags file must pass non-launcher Electron args in order: $output"
    [[ "$output" != *"<--disable-gpu>"* ]] || fail "commented persistent flags must be ignored: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" APP_CONFIG_DIR="$user_flags_dir" USER_ELECTRON_FLAGS_FILE="$user_flags_file" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe -- --use-gl=desktop)"
    [[ "$output" == *"electron=<--enable-wayland-ime><--use-gl=angle><--use-gl=desktop>"* ]] || fail "explicit CLI Electron args must follow persistent file args: $output"

    local feature_args_dir="$TMP_DIR/feature-electron-args"
    mkdir -p "$feature_args_dir"
    printf '%s\n' '--ozone-platform=wayland' '--use-angle=gl' > "$feature_args_dir/feature"
    output="$(env -i PATH="$PATH" HOME="$HOME" APP_CONFIG_DIR="$user_flags_dir" USER_ELECTRON_FLAGS_FILE="$user_flags_file" FEATURE_ELECTRON_ARGS_DIR="$feature_args_dir" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"<--ozone-platform=x11>"* ]] || fail "persistent flags file must override feature Electron platform args: $output"
    [[ "$output" != *"<--ozone-platform=wayland>"* ]] || fail "feature Electron platform args must not survive after user override: $output"
    [[ "$output" == *"electron=<--use-angle=gl><--enable-wayland-ime><--use-gl=angle>"* ]] || fail "feature, user, and CLI-independent Electron args must keep precedence order: $output"

    local template_dir="$TMP_DIR/user-electron-template"
    local template_file="$template_dir/electron-flags.conf"
    env -i PATH="$PATH" HOME="$HOME" APP_CONFIG_DIR="$template_dir" USER_ELECTRON_FLAGS_FILE="$template_file" "$launcher_probe" ensure-template >/dev/null
    assert_file_exists "$template_file"
    assert_contains "$template_file" "--x11"
    assert_contains "$template_file" "--enable-wayland-ime"
    printf '%s\n' '--wayland' > "$template_file"
    env -i PATH="$PATH" HOME="$HOME" APP_CONFIG_DIR="$template_dir" USER_ELECTRON_FLAGS_FILE="$template_file" "$launcher_probe" ensure-template >/dev/null
    [ "$(cat "$template_file")" = "--wayland" ] || fail "persistent flags template must not overwrite an existing file"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wayland-gpu "$launcher_probe" probe)"
    [[ "$output" == *"mode=wayland-gpu"* && "$output" == *"ozone_platform=wayland"* && "$output" == *"gpu=1"* ]] || fail "wayland-gpu profile must force native Wayland with GPU enabled: $output"
    [[ "$output" == *"comp=0"* && "$output" != *"<--disable-gpu-compositing>"* ]] || fail "wayland-gpu profile must keep GPU compositing enabled: $output"
    [[ "$output" == *"<--ozone-platform=wayland>"* && "$output" == *"<--enable-features=WaylandWindowDecorations>"* ]] || fail "wayland-gpu profile must add Wayland launch args: $output"
    [[ "$output" == *"renderer_accessibility=0"* && "$output" != *"<--force-renderer-accessibility>"* ]] || fail "wayland-gpu profile must skip renderer accessibility by default: $output"

    local portal_feature_args_dir="$TMP_DIR/portal-feature-electron-args"
    mkdir -p "$portal_feature_args_dir"
    printf '%s\n' '--enable-features=GlobalShortcutsPortal' '--enable-features=GlobalShortcutsPortal' > "$portal_feature_args_dir/appshots"
    output="$(env -i PATH="$PATH" HOME="$HOME" FEATURE_ELECTRON_ARGS_DIR="$portal_feature_args_dir" CODEX_LINUX_RENDERING_MODE=wayland-gpu "$launcher_probe" probe)"
    [[ "$output" == *"<--enable-features=GlobalShortcutsPortal,WaylandWindowDecorations>"* ]] || fail "feature and Wayland Electron feature flags must be merged: $output"
    [[ "$output" != *"electron=<--enable-features=GlobalShortcutsPortal>"* ]] || fail "merged Electron feature flags must not remain in pass-through args: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wayland-gpu CODEX_FORCE_RENDERER_ACCESSIBILITY=1 "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "CODEX_FORCE_RENDERER_ACCESSIBILITY=1 must force renderer accessibility under wayland-gpu: $output"

    output="$(env -i PATH="$at_stub_dir/none:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wayland-gpu "$launcher_probe" probe --x11)"
    [[ "$output" == *"mode=wayland-gpu"* && "$output" == *"ozone_platform=x11"* ]] || fail "explicit --x11 must override the wayland-gpu platform: $output"
    [[ "$output" == *"renderer_accessibility=0"* && "$output" != *"<--force-renderer-accessibility>"* ]] || fail "wayland-gpu with explicit --x11 must fall back to assistive-technology detection: $output"

    output="$(env -i PATH="$at_stub_dir/orca:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wayland-gpu "$launcher_probe" probe --x11)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "wayland-gpu with explicit --x11 must force renderer accessibility when a screen reader runs: $output"

    output="$(env -i PATH="$at_stub_dir/none:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wayland-gpu "$launcher_probe" probe --safe-mode)"
    [[ "$output" == *"mode=wayland-gpu"* && "$output" == *"ozone_platform=x11"* && "$output" == *"gpu=0"* ]] || fail "safe-mode must override wayland-gpu to X11 software rendering: $output"
    [[ "$output" == *"renderer_accessibility=0"* && "$output" != *"<--force-renderer-accessibility>"* ]] || fail "wayland-gpu with safe-mode must fall back to assistive-technology detection: $output"

    output="$(env -i PATH="$at_stub_dir/none:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wayland-gpu "$launcher_probe" probe -- --ozone-platform=x11)"
    [[ "$output" == *"electron=<--ozone-platform=x11>"* && "$output" != *"<--ozone-platform-hint=auto>"* ]] || fail "pass-through X11 platform must override wayland-gpu hinting: $output"
    [[ "$output" == *"renderer_accessibility=0"* && "$output" != *"<--force-renderer-accessibility>"* ]] || fail "wayland-gpu with pass-through X11 platform must fall back to assistive-technology detection: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wslg "$launcher_probe" probe)"
    [[ "$output" == *"mode=wslg"* && "$output" == *"comp=0"* && "$output" == *"gl_added=1"* ]] || fail "forced WSLg profile must keep GPU compositing enabled and add ANGLE: $output"
    [[ "$output" == *"<--ozone-platform=x11>"* && "$output" == *"electron=<--use-gl=angle>"* ]] || fail "forced WSLg profile must use X11 and ANGLE by default: $output"
    [[ "$output" != *"<--disable-gpu-compositing>"* ]] || fail "forced WSLg profile must not add disable-gpu-compositing by default: $output"
    [[ "$output" == *"renderer_accessibility=0"* && "$output" != *"<--force-renderer-accessibility>"* ]] || fail "forced WSLg profile must skip renderer accessibility by default: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wslg CODEX_FORCE_RENDERER_ACCESSIBILITY=1 "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "CODEX_FORCE_RENDERER_ACCESSIBILITY=1 must force renderer accessibility under WSLg: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_FORCE_RENDERER_ACCESSIBILITY=0 "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=0"* && "$output" != *"<--force-renderer-accessibility>"* ]] || fail "CODEX_FORCE_RENDERER_ACCESSIBILITY=0 must disable renderer accessibility under default Linux: $output"

    output="$(env -i PATH="$at_stub_dir/orca:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "a running screen reader must force renderer accessibility under default Linux: $output"

    output="$(env -i PATH="$at_stub_dir/screenreader:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "the GNOME screen-reader setting must force renderer accessibility under default Linux: $output"

    output="$(env -i PATH="$at_stub_dir/none:$PATH" HOME="$HOME" GNOME_ACCESSIBILITY=1 CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "GNOME_ACCESSIBILITY=1 must force renderer accessibility under default Linux: $output"

    output="$(env -i PATH="$at_stub_dir/none:$PATH" HOME="$HOME" QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 must force renderer accessibility under default Linux: $output"

    output="$(env -i PATH="$at_stub_dir/none:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_FORCE_RENDERER_ACCESSIBILITY=1 "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "CODEX_FORCE_RENDERER_ACCESSIBILITY=1 must force renderer accessibility without detected assistive technology: $output"

    output="$(env -i PATH="$at_stub_dir/toolkit:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "toolkit-accessibility=true (Computer Use gsettings fallback) must force renderer accessibility: $output"

    output="$(env -i PATH="$at_stub_dir/atspibus:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default "$launcher_probe" probe)"
    [[ "$output" == *"renderer_accessibility=1"* && "$output" == *"<--force-renderer-accessibility>"* ]] || fail "org.a11y.Status IsEnabled (Computer Use setup) must force renderer accessibility: $output"

    local at_probe_start_ns at_probe_end_ns at_probe_elapsed_ms slowbus_pid slowbus_pid_file
    slowbus_pid_file="$TMP_DIR/slowbus-gsettings.pid"
    rm -f "$slowbus_pid_file"
    at_probe_start_ns="$(date +%s%N)"
    output="$(env -i PATH="$at_stub_dir/slowbus:$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_TEST_SLOWBUS_PID_FILE="$slowbus_pid_file" "$launcher_probe" probe)"
    at_probe_end_ns="$(date +%s%N)"
    at_probe_elapsed_ms=$(( (10#$at_probe_end_ns - 10#$at_probe_start_ns) / 1000000 ))
    [[ "$output" == *"renderer_accessibility=0"* && "$output" != *"<--force-renderer-accessibility>"* ]] || fail "a hung session bus must not force renderer accessibility: $output"
    [ "$at_probe_elapsed_ms" -lt 3000 ] || fail "session-bus assistive-tech probe must be watchdog-capped, took ${at_probe_elapsed_ms}ms: $output"
    [ -s "$slowbus_pid_file" ] || fail "hung session-bus probe did not start the gsettings helper"
    slowbus_pid="$(< "$slowbus_pid_file")"
    if kill -0 "$slowbus_pid" 2>/dev/null; then
        kill -KILL "$slowbus_pid" 2>/dev/null || true
        fail "session-bus assistive-tech watchdog leaked hung gsettings pid $slowbus_pid"
    fi

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wslg "$launcher_probe" probe --wayland --use-gl=desktop)"
    [[ "$output" == *"<--ozone-platform=wayland>"* && "$output" == *"electron=<--use-gl=desktop>"* ]] || fail "explicit rendering args must override WSLg defaults: $output"
    [[ "$output" == *"gl_added=0"* && "$output" != *"<--use-gl=angle>"* ]] || fail "WSLg profile must not add ANGLE when a GL switch was supplied: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wslg "$launcher_probe" probe -- --disable-gpu)"
    [[ "$output" == *"gpu=1"* && "$output" == *"gpu_arg=1"* && "$output" == *"gl_added=0"* ]] || fail "pass-through --disable-gpu must suppress WSLg ANGLE without becoming a launcher GPU toggle: $output"
    [[ "$output" == *"electron=<--disable-gpu>"* && "$output" != *"<--disable-features=Vulkan>"* ]] || fail "pass-through --disable-gpu must not add launcher-only Vulkan flags: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wslg CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 "$launcher_probe" probe)"
    [[ "$output" == *"comp=1"* && "$output" == *"<--disable-gpu-compositing>"* ]] || fail "CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 must force the compositor flag: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 "$launcher_probe" probe)"
    [[ "$output" == *"comp=1"* && "$output" == *"<--disable-gpu-compositing>"* ]] || fail "CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 must force the compositor flag under default Linux: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=0 "$launcher_probe" probe)"
    [[ "$output" == *"comp=0"* && "$output" != *"<--disable-gpu-compositing>"* ]] || fail "CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=0 must suppress the compositor flag: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" WSL_INTEROP=/tmp/codex-wsl WAYLAND_DISPLAY=wayland-0 "$launcher_probe" probe)"
    [[ "$output" == *"mode=wslg"* && "$output" == *"wslg=1"* ]] || fail "auto rendering mode must detect WSLg from WSL and GUI markers: $output"

    local dev_shm_stub_dir="$TMP_DIR/dev-shm-stubs"
    mkdir -p "$dev_shm_stub_dir/large" "$dev_shm_stub_dir/small" "$dev_shm_stub_dir/broken"
    cat > "$dev_shm_stub_dir/large/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'tmpfs 16000000 0 16000000 0%% /dev/shm\n'
EOF
    cat > "$dev_shm_stub_dir/small/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'tmpfs 65536 0 65536 0%% /dev/shm\n'
EOF
    cat > "$dev_shm_stub_dir/broken/df" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$dev_shm_stub_dir/large/df" "$dev_shm_stub_dir/small/df" "$dev_shm_stub_dir/broken/df"

    output="$(env -i PATH="$dev_shm_stub_dir/large:$PATH" HOME="$HOME" "$launcher_probe" probe)"
    [[ "$output" != *"<--disable-dev-shm-usage>"* ]] || fail "adequate /dev/shm must not disable Chromium /dev/shm usage: $output"

    output="$(env -i PATH="$dev_shm_stub_dir/small:$PATH" HOME="$HOME" "$launcher_probe" probe)"
    [[ "$output" == *"<--disable-dev-shm-usage>"* ]] || fail "small /dev/shm must keep --disable-dev-shm-usage: $output"

    output="$(env -i PATH="$dev_shm_stub_dir/broken:$PATH" HOME="$HOME" "$launcher_probe" probe)"
    [[ "$output" == *"<--disable-dev-shm-usage>"* ]] || fail "unreadable /dev/shm capacity must keep --disable-dev-shm-usage: $output"

    output="$(env -i PATH="$dev_shm_stub_dir/large:$PATH" HOME="$HOME" CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=1 "$launcher_probe" probe)"
    [[ "$output" == *"<--disable-dev-shm-usage>"* ]] || fail "CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=1 must force --disable-dev-shm-usage: $output"

    output="$(env -i PATH="$dev_shm_stub_dir/small:$PATH" HOME="$HOME" CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=0 "$launcher_probe" probe)"
    [[ "$output" != *"<--disable-dev-shm-usage>"* ]] || fail "CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=0 must suppress --disable-dev-shm-usage: $output"

    output="$(env -i PATH="$dev_shm_stub_dir/small:$PATH" HOME="$HOME" CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=bogus "$launcher_probe" probe 2>/dev/null)"
    [[ "$output" == *"<--disable-dev-shm-usage>"* ]] || fail "invalid CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE must fall back to /dev/shm detection: $output"
    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_OZONE_PLATFORM=x11 "$launcher_probe" probe)"
    [[ "$output" == *"<--ozone-platform=x11>"* && "$output" != *"<--ozone-platform-hint=auto>"* ]] || fail "CODEX_OZONE_PLATFORM=x11 must select the X11 Ozone backend: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_OZONE_PLATFORM=wayland "$launcher_probe" probe)"
    [[ "$output" == *"<--ozone-platform=wayland>"* && "$output" == *"WaylandWindowDecorations"* ]] || fail "CODEX_OZONE_PLATFORM=wayland must select native Wayland with decorations: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_OZONE_PLATFORM=auto SOMMELIER_VERSION=1 "$launcher_probe" probe)"
    [[ "$output" == *"<--ozone-platform-hint=auto>"* && "$output" != *"<--ozone-platform=x11>"* ]] || fail "CODEX_OZONE_PLATFORM=auto must override the Sommelier X11 fallback: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_OZONE_PLATFORM=wayland "$launcher_probe" probe --x11)"
    [[ "$output" == *"<--ozone-platform=x11>"* && "$output" != *"<--ozone-platform=wayland>"* ]] || fail "explicit --x11 must win over CODEX_OZONE_PLATFORM: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_OZONE_PLATFORM=bogus "$launcher_probe" probe 2>/dev/null)"
    [[ "$output" == *"<--ozone-platform-hint=auto>"* ]] || fail "invalid CODEX_OZONE_PLATFORM must fall back to the default ozone hint: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_FORCE_DEVICE_SCALE_FACTOR=1 "$launcher_probe" probe)"
    [[ "$output" == *"<--force-device-scale-factor=1>"* ]] || fail "CODEX_FORCE_DEVICE_SCALE_FACTOR=1 must pass the scale flag to Electron: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_FORCE_DEVICE_SCALE_FACTOR=1.25 "$launcher_probe" probe)"
    [[ "$output" == *"<--force-device-scale-factor=1.25>"* ]] || fail "fractional CODEX_FORCE_DEVICE_SCALE_FACTOR must pass through: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_FORCE_DEVICE_SCALE_FACTOR=abc "$launcher_probe" probe 2>/dev/null)"
    [[ "$output" != *"--force-device-scale-factor"* ]] || fail "invalid CODEX_FORCE_DEVICE_SCALE_FACTOR must be ignored: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_FORCE_DEVICE_SCALE_FACTOR=0 "$launcher_probe" probe 2>/dev/null)"
    [[ "$output" != *"--force-device-scale-factor"* ]] || fail "zero CODEX_FORCE_DEVICE_SCALE_FACTOR must be ignored: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default CODEX_FORCE_DEVICE_SCALE_FACTOR=1 "$launcher_probe" probe -- --force-device-scale-factor=2)"
    [[ "$output" == *"electron=<--force-device-scale-factor=2>"* && "$output" != *"<--force-device-scale-factor=1>"* ]] || fail "explicit --force-device-scale-factor must win over the env override: $output"

    # Feature launcher hooks run after set_electron_defaults() has already chosen
    # the Ozone platform, so a hook-supplied explicit --ozone-platform must drop
    # the launcher-computed value instead of leaving both in the final argv. This
    # must hold no matter how the launcher picked the platform: CODEX_OZONE_PLATFORM,
    # the CODEX_LINUX_RENDERING_MODE profile (wayland-gpu / wslg), or the Sommelier
    # fallback.
    local hook_force_x11_dir="$TMP_DIR/hook-force-x11"
    mkdir -p "$hook_force_x11_dir"
    printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' 'electron-arg --ozone-platform=x11'" > "$hook_force_x11_dir/force-x11"
    chmod +x "$hook_force_x11_dir/force-x11"
    local hook_force_wayland_dir="$TMP_DIR/hook-force-wayland"
    mkdir -p "$hook_force_wayland_dir"
    printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' 'electron-arg --ozone-platform=wayland'" > "$hook_force_wayland_dir/force-wayland"
    chmod +x "$hook_force_wayland_dir/force-wayland"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default FEATURE_LAUNCHER_HOOK_DIR="$hook_force_x11_dir" CODEX_OZONE_PLATFORM=wayland "$launcher_probe" probe)"
    [[ "$output" == *"electron=<--ozone-platform=x11>"* ]] || fail "launcher hook --ozone-platform must reach Electron over CODEX_OZONE_PLATFORM: $output"
    [[ "$output" != *"<--ozone-platform=wayland>"* ]] || fail "env-derived --ozone-platform must be dropped when a launcher hook overrides it: $output"
    [[ "$output" != *"WaylandWindowDecorations"* ]] || fail "cleared env Wayland platform must not still add Wayland decorations: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wayland-gpu FEATURE_LAUNCHER_HOOK_DIR="$hook_force_x11_dir" "$launcher_probe" probe)"
    [[ "$output" == *"electron=<--ozone-platform=x11>"* ]] || fail "launcher hook --ozone-platform must reach Electron under wayland-gpu: $output"
    [[ "$output" != *"<--ozone-platform=wayland>"* ]] || fail "wayland-gpu launcher platform must be dropped when a hook overrides it: $output"
    [[ "$output" != *"WaylandWindowDecorations"* ]] || fail "dropped wayland-gpu platform must not still add Wayland decorations: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=wslg FEATURE_LAUNCHER_HOOK_DIR="$hook_force_wayland_dir" "$launcher_probe" probe)"
    [[ "$output" == *"<--ozone-platform=wayland>"* ]] || fail "launcher hook --ozone-platform must reach Electron under wslg: $output"
    [[ "$output" != *"<--ozone-platform=x11>"* ]] || fail "wslg launcher platform must be dropped when a hook overrides it: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default SOMMELIER_VERSION=1 FEATURE_LAUNCHER_HOOK_DIR="$hook_force_wayland_dir" "$launcher_probe" probe)"
    [[ "$output" == *"<--ozone-platform=wayland>"* ]] || fail "launcher hook --ozone-platform must reach Electron over the Sommelier fallback: $output"
    [[ "$output" != *"<--ozone-platform=x11>"* ]] || fail "Sommelier X11 fallback must be dropped when a hook overrides it: $output"

    local hook_scale_dir="$TMP_DIR/hook-scale-override"
    mkdir -p "$hook_scale_dir"
    printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' 'electron-arg --force-device-scale-factor=2'" > "$hook_scale_dir/force-scale2"
    chmod +x "$hook_scale_dir/force-scale2"
    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default FEATURE_LAUNCHER_HOOK_DIR="$hook_scale_dir" CODEX_FORCE_DEVICE_SCALE_FACTOR=1 "$launcher_probe" probe)"
    [[ "$output" == *"electron=<--force-device-scale-factor=2>"* ]] || fail "launcher hook --force-device-scale-factor must reach Electron over CODEX_FORCE_DEVICE_SCALE_FACTOR: $output"
    [[ "$output" != *"<--force-device-scale-factor=1>"* ]] || fail "env-derived --force-device-scale-factor must be dropped when a launcher hook overrides it: $output"

    # A hook-emitted arg must also replace a conflicting arg already collected in
    # ELECTRON_ARGS (pass-through CLI, persistent flags file, or feature
    # electron-args) instead of appending a duplicate switch to the final argv.
    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default FEATURE_LAUNCHER_HOOK_DIR="$hook_force_wayland_dir" "$launcher_probe" probe -- --ozone-platform=x11)"
    [[ "$output" == *"electron=<--ozone-platform=wayland>"* ]] || fail "launcher hook --ozone-platform must replace a pass-through ozone arg: $output"
    [[ "$output" != *"<--ozone-platform=x11>"* ]] || fail "pass-through --ozone-platform must be dropped when a launcher hook supersedes it: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default FEATURE_LAUNCHER_HOOK_DIR="$hook_force_wayland_dir" "$launcher_probe" probe -- --ozone-platform-hint=auto)"
    [[ "$output" == *"electron=<--ozone-platform=wayland>"* ]] || fail "launcher hook --ozone-platform must replace a pass-through ozone hint: $output"
    [[ "$output" != *"<--ozone-platform-hint=auto>"* ]] || fail "pass-through --ozone-platform-hint must be dropped when a hook supplies an explicit platform: $output"

    output="$(env -i PATH="$PATH" HOME="$HOME" CODEX_LINUX_RENDERING_MODE=default FEATURE_LAUNCHER_HOOK_DIR="$hook_scale_dir" "$launcher_probe" probe -- --force-device-scale-factor=1)"
    [[ "$output" == *"electron=<--force-device-scale-factor=2>"* ]] || fail "launcher hook scale arg must replace a pass-through scale arg: $output"
    [[ "$output" != *"<--force-device-scale-factor=1>"* ]] || fail "pass-through --force-device-scale-factor must be dropped when a launcher hook supersedes it: $output"

    local hook_scale_flags_dir="$TMP_DIR/hook-scale-user-flags"
    local hook_scale_flags_file="$hook_scale_flags_dir/electron-flags.conf"
    mkdir -p "$hook_scale_flags_dir"
    printf '%s\n' '--force-device-scale-factor=1' > "$hook_scale_flags_file"
    output="$(env -i PATH="$PATH" HOME="$HOME" APP_CONFIG_DIR="$hook_scale_flags_dir" USER_ELECTRON_FLAGS_FILE="$hook_scale_flags_file" CODEX_LINUX_RENDERING_MODE=default FEATURE_LAUNCHER_HOOK_DIR="$hook_scale_dir" "$launcher_probe" probe)"
    [[ "$output" == *"electron=<--force-device-scale-factor=2>"* ]] || fail "launcher hook scale arg must replace a persistent-flags scale arg: $output"
    [[ "$output" != *"<--force-device-scale-factor=1>"* ]] || fail "persistent-flags --force-device-scale-factor must be dropped when a launcher hook supersedes it: $output"

    local hook_scale_feature_args_dir="$TMP_DIR/hook-scale-feature-args"
    mkdir -p "$hook_scale_feature_args_dir"
    printf '%s\n' '--force-device-scale-factor=1' > "$hook_scale_feature_args_dir/feature"
    output="$(env -i PATH="$PATH" HOME="$HOME" FEATURE_ELECTRON_ARGS_DIR="$hook_scale_feature_args_dir" CODEX_LINUX_RENDERING_MODE=default FEATURE_LAUNCHER_HOOK_DIR="$hook_scale_dir" "$launcher_probe" probe)"
    [[ "$output" == *"electron=<--force-device-scale-factor=2>"* ]] || fail "launcher hook scale arg must replace a feature electron-args scale arg: $output"
    [[ "$output" != *"<--force-device-scale-factor=1>"* ]] || fail "feature electron-args --force-device-scale-factor must be dropped when a launcher hook supersedes it: $output"

    assert_contains "$REPO_DIR/launcher/start.sh.template" "warm_start_ipc_sent"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "launcher_phase"
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'date +%s%N'
    assert_contains "$REPO_DIR/launcher/start.sh.template" '10#$nanos / 1000000'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_SYNC_CLI_PREFLIGHT"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "wait_for_webview_server"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "verify_webview_origin"
    # Probe-shape invariants: shell-native bash /dev/tcp + curl, with the
    # bounded-execution defenses preserved (0.2 s watchdog + 2 s curl cap).
    assert_contains "$REPO_DIR/launcher/start.sh.template" '/dev/tcp/127.0.0.1/"$CODEX_LINUX_WEBVIEW_PORT"'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "kill -9 \"\$probe_pid\""
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'curl --disable --noproxy 127.0.0.1,localhost --silent --show-error --fail --max-time 2'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "webview_origin_is_reachable_fast"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "for attempt in \$(seq 1 20)"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "sleep 0.05"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "Webview origin verified."
    assert_contains "$REPO_DIR/launcher/start.sh.template" "hydrate_graphical_session_env"
    assert_not_contains "$REPO_DIR/install.sh" "pkill -f \"http.server 5175\""
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_WEBVIEW_PORT"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_LINUX_ALLOW_RENDERER_URL_OVERRIDE"
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'export ELECTRON_RENDERER_URL="$WEBVIEW_ORIGIN/"'
    assert_contains "$REPO_DIR/launcher/start.sh.template" '--app-id="$CODEX_LINUX_APP_ID"'
    assert_contains "$REPO_DIR/scripts/lib/process-detection.sh" "CODEX_APP_ID"
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'ELECTRON_OZONE_HINT="auto"'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_LINUX_RENDERING_MODE=auto|default|wslg|wayland-gpu"
    assert_contains "$REPO_DIR/launcher/start.sh.template" '--ozone-platform-hint="$ELECTRON_OZONE_HINT"'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "--disable-gpu-sandbox"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=auto|0|1"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "dev_shm_usage_disabled="
    assert_contains "$REPO_DIR/launcher/start.sh.template" "--force-renderer-accessibility"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_FORCE_RENDERER_ACCESSIBILITY=auto|0|1"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "assistive_technology_detected"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "session_bus_probe_command"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_OZONE_PLATFORM=x11|wayland|auto"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_FORCE_DEVICE_SCALE_FACTOR=N"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "print_scaling_diagnostics"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "--diagnose-scaling"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "PACKAGED_RUNTIME_HELPER"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "--allow-install-missing"
    assert_contains "$REPO_DIR/scripts/lib/process-detection.sh" "CODEX_INSTALL_ALLOW_RUNNING"
    assert_contains "$REPO_DIR/scripts/lib/process-detection.sh" "assert_install_target_not_running"
    assert_contains "$REPO_DIR/scripts/lib/process-detection.sh" "find_running_install_target_pid"
    assert_contains "$REPO_DIR/scripts/lib/process-detection.sh" "ChatGPT Desktop is currently running from"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "prompt_install_missing_cli"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "prompt-install-cli"
    assert_contains "$REPO_DIR/launcher/start.sh.template" '.npm-global/bin/codex'
    assert_contains "$REPO_DIR/launcher/start.sh.template" '.config}/nvm/versions/node'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_UPDATE_MANAGER_PATH"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "resolve_update_manager_path"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "run_update_manager"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "sync_browser_use_bundled_plugin_cache"
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'source_plugin="$SCRIPT_DIR/resources/plugins/openai-bundled/plugins/browser"'
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'marketplace_plugin_link="$marketplace_root/plugins/$plugin_dir_name"'
    assert_contains "$REPO_DIR/launcher/start.sh.template" "sync_chrome_bundled_plugin_cache"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "sync_read_aloud_bundled_plugin_cache"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "make_tree_owner_writable"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "make_path_owner_trusted"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "make_tree_owner_trusted"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "clear_bundled_marketplace_tmp_cache"
    assert_not_contains "$REPO_DIR/launcher/start.sh.template" "monitor_bundled_marketplace_tmp_permissions"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "extension-id.json"
    assert_contains "$REPO_DIR/launcher/start.sh.template" ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    assert_contains "$REPO_DIR/launcher/start.sh.template" ".config/chromium/NativeMessagingHosts"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "scripts/check-extension-installed.js"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "scripts/chrome-is-running.js"
    assert_contains "$REPO_DIR/launcher/start.sh.template" ".tmp/bundled-marketplaces/openai-bundled"
    assert_contains "$REPO_DIR/launcher/start.sh.template" ".agents/plugins/marketplace.json"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "stage_chrome_plugin_from_upstream"
    assert_contains "$REPO_DIR/scripts/lib/patch-chrome-plugin.js" "Linux native host manifest location"
    assert_contains "$REPO_DIR/computer-use-linux/src/bin/codex-chrome-extension-host.rs" "CODEX_BROWSER_USE_SOCKET_DIR"
    assert_contains "$REPO_DIR/flake.nix" "Browser Use bundled marketplace metadata"
    assert_contains "$REPO_DIR/flake.nix" ".tmp/bundled-marketplaces/openai-bundled"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "Install it now? \\[Y/n\\]"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "is_interactive_terminal"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "LAUNCHER_INTERACTIVE_TERMINAL"
    assert_contains "$REPO_DIR/launcher/start.sh.template" 'detail=$(cat "$err" 2>/dev/null || true)'
    assert_contains "$REPO_DIR/updater/src/app.rs" "kdialog"
    assert_contains "$REPO_DIR/updater/src/app.rs" "zenity"
    assert_contains "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh" "CHROME_DESKTOP"
    assert_contains "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh" "is-enabled codex-update-manager.service"
    assert_contains "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh" "codex-update-manager-launch-check"
    assert_contains "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh" "codex-update-manager check-now --if-stale"
    assert_not_contains "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh" "enable --now codex-update-manager.service"
    assert_not_contains "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh" "restart codex-update-manager.service"
    assert_contains "$REPO_DIR/packaging/linux/codex-update-manager-user-service.sh" "codex_start_enabled_user_service"
    assert_contains "$REPO_DIR/packaging/linux/codex-update-manager.postinst" "codex_start_enabled_user_service"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.install" "codex_start_enabled_user_service"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.spec" "codex_start_enabled_user_service"
    assert_contains "$REPO_DIR/scripts/install-deps.sh" 'NODEJS_MAJOR="${NODEJS_MAJOR:-22}"'
    assert_contains "$REPO_DIR/scripts/install-deps.sh" "apt_nodejs_candidate_major"
    assert_contains "$REPO_DIR/scripts/install-deps.sh" "Installing distro Node.js/npm candidate"
    assert_contains "$REPO_DIR/scripts/install-deps.sh" "/etc/apt/keyrings/nodesource.gpg"
    assert_contains "$REPO_DIR/scripts/install-deps.sh" "signed-by="
    assert_contains "$REPO_DIR/scripts/install-deps.sh" "https://deb.nodesource.com/node_"
    assert_not_contains "$REPO_DIR/packaging/linux/control" "Depends:.*nodejs"
    assert_not_contains "$REPO_DIR/packaging/linux/control" "Depends:.*npm"
    assert_not_contains "$REPO_DIR/packaging/linux/codex-desktop.spec" "Requires:.*nodejs"
    assert_not_contains "$REPO_DIR/packaging/linux/codex-desktop.spec" "Requires:.*npm"
    assert_not_contains "$REPO_DIR/packaging/linux/PKGBUILD.template" "'nodejs>=20'"
    assert_contains "$REPO_DIR/packaging/linux/PKGBUILD.template" "optional override for the bundled managed Node.js runtime"
    assert_contains "$REPO_DIR/scripts/lib/node-runtime.sh" "MANAGED_NODE_VERSION"
    assert_contains "$REPO_DIR/scripts/lib/package-common.sh" "node-runtime"
    assert_contains "$REPO_DIR/tests/fixtures/create-packaged-app-fixture.sh" "resources/node-runtime/bin"
    assert_contains "$REPO_DIR/.github/workflows/ci.yml" "tests/fixtures/create-packaged-app-fixture.sh codex-app"
    assert_contains "$REPO_DIR/.github/workflows/ci.yml" "bash scripts/ci/run-node-checks.sh"
    assert_contains "$REPO_DIR/scripts/ci/container-entrypoint.sh" "bash scripts/ci/run-node-checks.sh"
    assert_contains "$REPO_DIR/scripts/ci/run-node-checks.sh" "git ls-files '\\*.js'"
    assert_contains "$REPO_DIR/scripts/ci/run-node-checks.sh" "git ls-files '\\*.test.js' 'linux-features/\\*/test.js'"
    assert_contains "$REPO_DIR/flake.nix" "rewriteCratesIoDownloadUrl"
    assert_contains "$REPO_DIR/flake.nix" "https://static.crates.io/crates/"
    assert_contains "$REPO_DIR/flake.nix" "api/v1/crates/"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "MANAGED_NODE_BIN_DIR"
    assert_contains "$REPO_DIR/launcher/start.sh.template" "CODEX_LINUX_USER_PATH"
    assert_contains "$REPO_DIR/updater/src/builder.rs" "managed_node_bin_dirs"
    assert_contains "$REPO_DIR/scripts/build-rpm.sh" "stage_common_package_files"
    assert_contains "$REPO_DIR/scripts/build-rpm.sh" "PACKAGED_RUNTIME_SOURCE"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "BAMF_DESKTOP_FILE_HINT"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "/usr/bin/codex-desktop %u"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "MimeType=x-scheme-handler/codex;x-scheme-handler/codex-browser-sidebar;"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "StartupWMClass=codex-desktop"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "X-GNOME-WMClass=codex-desktop"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "Actions=new-window;CheckForUpdates;InstallReadyUpdate;"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "[Desktop Action new-window]"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "CODEX_MULTI_LAUNCH=1 /usr/bin/codex-desktop --new-instance"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "codex-update-manager check-now"
    assert_contains "$REPO_DIR/packaging/linux/codex-desktop.desktop" "codex-update-manager install-ready"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/share/applications/codex-desktop.desktop" "BAMF_DESKTOP_FILE_HINT=@HOME@/.local/share/applications/codex-desktop.desktop"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/share/applications/codex-desktop.desktop" "@HOME@/.local/bin/codex-desktop %U"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/share/applications/codex-desktop.desktop" "MimeType=x-scheme-handler/codex;x-scheme-handler/codex-browser-sidebar;"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/share/applications/codex-desktop.desktop" "Actions=new-window;"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/share/applications/codex-desktop.desktop" "CODEX_MULTI_LAUNCH=1 @HOME@/.local/bin/codex-desktop --new-instance"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/bin/codex-desktop" "CODEX_USER_LOCAL_OZONE_PLATFORM"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/bin/codex-desktop" 'exec "${APP_DIR}/start.sh" --x11 "$@"'
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/bin/codex-desktop" 'exec "${APP_DIR}/start.sh" --wayland "$@"'
    assert_contains "$REPO_DIR/contrib/user-local-install/install-user-local.sh" "--force-x11"
    assert_contains "$REPO_DIR/contrib/user-local-install/install-user-local.sh" "user-local.env"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh" "assets/codex-linux.png"
    assert_contains "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh" "CODEX_USER_LOCAL_RECORD_DMG_FINGERPRINT"
    assert_contains "$REPO_DIR/contrib/user-local-install/README.md" "--force-x11"

    node - "$REPO_DIR/launcher/start.sh.template" <<'NODE' || fail "Bundled backend plugin cache syncs must expose marketplace plugin links"
const fs = require("node:fs");
const launcher = fs.readFileSync(process.argv[2], "utf8");

function functionBody(name, nextName) {
  const pattern = new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)\\n\\}\\n\\n${nextName}\\(\\) \\{`, "u");
  const match = launcher.match(pattern);
  if (match == null) {
    throw new Error(`missing ${name}`);
  }
  return match[1];
}

function assertCacheLinks({ body, plugin }) {
  for (const required of [
    `marketplace_plugin_link="$marketplace_root/plugins/${plugin}"`,
    'replace_symlink "$version" "$cache_root/latest"',
    'replace_symlink "$cache_root/latest" "$marketplace_plugin_link"',
  ]) {
    if (!body.includes(required)) {
      throw new Error(`${plugin} sync missing ${required}`);
    }
  }
  if (!body.includes("needs_copy=0")) {
    throw new Error(`${plugin} sync must refresh links on cache hits`);
  }
}

assertCacheLinks({
  body: functionBody("sync_computer_use_bundled_plugin_cache", "sync_read_aloud_bundled_plugin_cache"),
  plugin: "computer-use",
});
assertCacheLinks({
  body: functionBody("sync_read_aloud_bundled_plugin_cache", "resolve_browser_use_runtime_env"),
  plugin: "read-aloud",
});
const chromeBody = functionBody("sync_chrome_bundled_plugin_cache", "sync_computer_use_bundled_plugin_cache");
for (const required of [
  'make_path_owner_trusted',
  'path_has_unsafe_write',
  'tree_has_unsafe_write "$cache_plugin"',
  'cache_was_untrusted=1',
  'make_tree_owner_trusted "$tmp_plugin"',
  'make_tree_owner_trusted "$cache_plugin"',
  'write_chrome_native_host_manifests "$host_path" "$cache_root/latest"',
]) {
  if (!chromeBody.includes(required)) {
    throw new Error(`Chrome plugin runtime cache sync missing ${required}`);
  }
}
if (chromeBody.includes('make_tree_owner_trusted "$source_plugin"')) {
  throw new Error("Chrome plugin sync must not bless an installed writable source tree");
}
const mkdirCacheParent = chromeBody.indexOf('mkdir -p "$cache_parent"');
if (mkdirCacheParent === -1 || chromeBody.indexOf('"$cache_parent"', mkdirCacheParent) === -1) {
  throw new Error("Chrome plugin runtime cache sync must harden newly created cache parents");
}
if (!launcher.includes('ln -sfnT "$target" "$link_path"')) {
  throw new Error("replace_symlink must replace plugin links as paths, not as directory children");
}
NODE

    local trust_probe="$TMP_DIR/chrome-cache-permissions-probe.sh"
    python3 - "$REPO_DIR/launcher/start.sh.template" "$trust_probe" <<'PY'
import pathlib
import re
import sys

launcher = pathlib.Path(sys.argv[1]).read_text()
helpers = []
for name in (
    "make_tree_owner_writable",
    "make_path_owner_trusted",
    "make_tree_owner_trusted",
    "path_has_unsafe_write",
    "tree_has_unsafe_write",
    "remove_tree_if_exists",
):
    match = re.search(rf"{name}\(\) \{{[\s\S]*?\n\}}\n", launcher)
    if match is None:
        raise SystemExit(f"missing {name}")
    helpers.append(match.group(0))

sync_match = re.search(
    r"sync_chrome_bundled_plugin_cache\(\) \{[\s\S]*?\n\}\n\nsync_computer_use_bundled_plugin_cache\(\)",
    launcher,
)
if sync_match is None:
    raise SystemExit("missing Chrome cache sync")
sync_function = sync_match.group(0).rsplit("\n\nsync_computer_use_bundled_plugin_cache()", 1)[0]

pathlib.Path(sys.argv[2]).write_text(
    """#!/usr/bin/env bash
set -euo pipefail

"""
    + "\n".join(helpers)
    + "\n"
    + sync_function
    + r'''
root="$1"
SCRIPT_DIR="$root/app"
HOME="$root/home"
CODEX_HOME="$HOME/.codex"
source_plugin="$SCRIPT_DIR/resources/plugins/openai-bundled/plugins/chrome"
cache_root="$CODEX_HOME/plugins/cache/openai-bundled/chrome"
cache_plugin="$cache_root/26.test"

chrome_extension_host_arch() { printf '%s\n' x64; }
bundled_plugin_version() { printf '%s\n' 26.test; }
replace_symlink() { ln -sfnT "$1" "$2"; }
write_chrome_native_host_manifests() { :; }

mkdir -p \
  "$source_plugin/.codex-plugin" \
  "$source_plugin/extension-host/linux/x64" \
  "$source_plugin/scripts/node_modules" \
  "$cache_plugin/.codex-plugin" \
  "$cache_plugin/extension-host/linux/x64" \
  "$cache_plugin/scripts/node_modules"
printf '%s\n' '{"name":"chrome","version":"26.test"}' > "$source_plugin/.codex-plugin/plugin.json"
printf '%s\n' trusted-host > "$source_plugin/extension-host/linux/x64/extension-host"
printf '%s\n' trusted-client > "$source_plugin/scripts/browser-client.mjs"
printf '%s\n' trusted-manifest > "$source_plugin/scripts/installManifest.mjs"
printf '%s\n' trusted-module > "$source_plugin/scripts/node_modules/classic-level.mjs"
chmod +x "$source_plugin/extension-host/linux/x64/extension-host"
cp -R "$source_plugin/." "$cache_plugin/"
printf '%s\n' tampered-module > "$cache_plugin/scripts/node_modules/classic-level.mjs"

# Simulate a cache and relevant ancestor created under umask 0002. The four
# files used by the old partial comparison still match, while an imported
# module that was not compared has been changed.
chmod 775 "$CODEX_HOME" "$CODEX_HOME/plugins" "$CODEX_HOME/plugins/cache" \
  "$CODEX_HOME/plugins/cache/openai-bundled" "$cache_root" "$cache_plugin"
chmod 664 "$cache_plugin/scripts/node_modules/classic-level.mjs"
chmod -R go-w "$SCRIPT_DIR"

sync_chrome_bundled_plugin_cache

grep -qx trusted-module "$cache_plugin/scripts/node_modules/classic-level.mjs"
for trusted_path in \
  "$CODEX_HOME" \
  "$CODEX_HOME/plugins" \
  "$CODEX_HOME/plugins/cache" \
  "$CODEX_HOME/plugins/cache/openai-bundled" \
  "$cache_root"; do
  if find "$trusted_path" -maxdepth 0 ! -type l -perm /022 -print -quit | grep -q .; then
    echo "Chrome cache ancestor remained group/world writable: $trusted_path" >&2
    exit 1
  fi
done
if find "$cache_plugin" ! -type l -perm /022 -print -quit | grep -q .; then
  echo "Chrome plugin cache remained group/world writable" >&2
  exit 1
fi
test -L "$cache_root/latest"
test "$(readlink "$cache_root/latest")" = 26.test
'''
)
PY
    chmod +x "$trust_probe"
    "$trust_probe" "$TMP_DIR/chrome-cache-permissions"
}

test_launcher_cli_resolution_policy() {
    info "Checking launcher CLI resolution policy"
    local launcher_probe="$TMP_DIR/launcher-cli-policy-probe.sh"
    local routing_probe="$TMP_DIR/launcher-cli-preflight-routing-probe.sh"
    python3 - "$REPO_DIR/launcher/start.sh.template" "$launcher_probe" "$routing_probe" <<'PY'
import pathlib
import re
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
functions = [source[
    source.index("codex_restore_original_ld_library_path() {"):
    source.index("# Capture before package-specific launcher patches")
]]
for name in ("find_codex_cli", "pid_parent_matches", "codex_cli_version_probe", "codex_cli_version", "codex_cli_missing_optional_dependency", "log_codex_cli_path"):
    match = re.search(r"^" + re.escape(name) + r"\(\) \{[\s\S]*?^\}\n", source, re.M)
    if match is None:
        raise SystemExit(f"missing {name}")
    functions.append(match.group(0))

pathlib.Path(sys.argv[2]).write_text(
    "#!/usr/bin/env bash\n"
    "set -Eeuo pipefail\n\n"
    + "\n".join(functions)
    + r'''
case "${1:?}" in
    find)
        find_codex_cli
        ;;
    version)
        codex_cli_version "$2"
        ;;
    missing-optional)
        codex_cli_missing_optional_dependency "$2"
        ;;
    log)
        CODEX_CLI_PATH="${2:-}"
        export CODEX_CLI_PATH
        log_codex_cli_path
        ;;
    *)
        exit 64
        ;;
esac
''',
    encoding="utf-8",
)

preflight_match = re.search(r"^run_cli_preflight\(\) \{[\s\S]*?^\}\n", source, re.M)
if preflight_match is None:
    raise SystemExit("missing run_cli_preflight")
trust_match = re.search(r"^verify_cli_launch_path\(\) \{[\s\S]*?^\}\n", source, re.M)
if trust_match is None:
    raise SystemExit("missing verify_cli_launch_path")
routing_start = source.index('if [ -n "$CODEX_CLI_PATH" ]; then\n    if ! verify_cli_launch_path')
routing_end = source.index("\nexport_packaged_runtime_env", routing_start)
final_version_log = source.index("\nlog_codex_cli_path\n", routing_end)
electron_launch = source.index("\nlaunch_electron ", final_version_log)
if not routing_start < routing_end < final_version_log < electron_launch:
    raise SystemExit("CLI trust gate must precede the final version log and Electron launch")
pathlib.Path(sys.argv[3]).write_text(
    "#!/usr/bin/env bash\n"
    "set -Eeuo pipefail\n\n"
    + r'''
CODEX_CLI_PATH=/tmp/codex
has_update_manager() { [ "${UPDATE_MANAGER_AVAILABLE:-0}" = "1" ]; }
run_cli_launch_path_helper() {
    printf 'trust=called\n' >> "$ROUTING_LOG"
    if [ "${TRUST_RESULT:-success}" = "success" ]; then
        printf '%s\n' /tmp/verified-codex
        return 0
    fi
    return 1
}
run_update_manager() {
    if [ "${UPDATE_MANAGER_RESULT:-failure}" = "success" ]; then
        printf '%s\n' /tmp/repaired-codex
        return 0
    fi
    return 1
}
notify_error() { printf 'notify=%s\n' "$1" >> "$ROUTING_LOG"; }
log_phase() { printf 'phase=%s\n' "$1" >> "$ROUTING_LOG"; }
needs_cold_start() { [ "${COLD_START:-1}" = "1" ]; }
codex_cli_missing_optional_dependency() {
    printf 'probe=missing-optional\n' >> "$ROUTING_LOG"
    [ "${BROKEN_CLI:-0}" = "1" ]
}
run_cli_preflight_background() { printf 'background=1\n' >> "$ROUTING_LOG"; }
log_codex_cli_path() { printf 'version=final\n' >> "$ROUTING_LOG"; }
launch_electron() { printf 'electron=launch\n' >> "$ROUTING_LOG"; }
'''
    + preflight_match.group(0)
    + trust_match.group(0)
    + "\n"
    + source[routing_start:routing_end]
    + "\nlog_codex_cli_path\nlaunch_electron\n",
    encoding="utf-8",
)
PY
    chmod +x "$launcher_probe" "$routing_probe"

    local workspace="$TMP_DIR/launcher-cli-policy"
    local fake_home="$workspace/home"
    local path_cli_bin="$workspace/path-cli-bin"
    local selected_cli
    mkdir -p "$path_cli_bin" "$fake_home/.npm-global/bin"

    printf '#!/usr/bin/env bash\nprintf "codex-cli 0.120.0\\n"\n' > "$path_cli_bin/codex"
    printf '#!/usr/bin/env bash\nprintf "codex-cli 9.999.0\\n"\n' > "$fake_home/.npm-global/bin/codex"
    chmod +x "$path_cli_bin/codex" "$fake_home/.npm-global/bin/codex"

    selected_cli="$(env -i PATH="$path_cli_bin:$HOST_TOOL_PATH" HOME="$fake_home" "$launcher_probe" find)"
    [ "$selected_cli" = "$path_cli_bin/codex" ] || fail "CLI lookup must keep the first PATH hit, got $selected_cli"

    local override_cli="$workspace/override-codex"
    local log_output
    printf '#!/usr/bin/env bash\nprintf "codex-cli 0.42.0\\n"\n' > "$override_cli"
    chmod +x "$override_cli"
    log_output="$(env -i PATH="$path_cli_bin:$HOST_TOOL_PATH" HOME="$fake_home" "$launcher_probe" log "$override_cli")"
    [[ "$log_output" == "Using CODEX_CLI_PATH=$override_cli (version 0.42.0)" ]] || fail "CODEX_CLI_PATH must remain an explicit override with version logging: $log_output"

    local dash_version_cli="$workspace/dash-version-codex"
    local fallback_version_cli="$workspace/fallback-version-codex"
    local version_output
    printf '#!/usr/bin/env bash\n[ "${1:-}" = "--version" ] || exit 2\nprintf "codex-cli 0.150.0\\n"\n' > "$dash_version_cli"
    printf '#!/usr/bin/env bash\nif [ "${1:-}" = "--version" ]; then exit 2; fi\n[ "${1:-}" = "version" ] || exit 2\nprintf "codex-cli v0.151.0\\n"\n' > "$fallback_version_cli"
    chmod +x "$dash_version_cli" "$fallback_version_cli"

    version_output="$(env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" "$launcher_probe" version "$dash_version_cli")"
    [ "$version_output" = "0.150.0" ] || fail "CLI version probe must read --version output, got $version_output"
    version_output="$(env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" "$launcher_probe" version "$fallback_version_cli")"
    [ "$version_output" = "0.151.0" ] || fail "CLI version probe must fall back to version output, got $version_output"

    local inherited_stderr_target="$workspace/inherited-stderr-target"
    version_output="$(env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" CODEX_CLI_PROBE_STDERR_FILE="$inherited_stderr_target" "$launcher_probe" version "$dash_version_cli")"
    [ "$version_output" = "0.150.0" ] || fail "inherited probe environment must not affect version output"
    [ ! -e "$inherited_stderr_target" ] || fail "inherited environment must not control CLI probe stderr files"

    local missing_x64_cli="$workspace/missing-x64-codex"
    local missing_arm64_cli="$workspace/missing-arm64-codex"
    local unrelated_failure_cli="$workspace/unrelated-failure-codex"
    local successful_warning_cli="$workspace/successful-warning-codex"
    printf '#!/usr/bin/env bash\nprintf "Error: Missing optional dependency@openai/codex-linux-x64. Reinstall Codex.\\n" >&2\nexit 1\n' > "$missing_x64_cli"
    printf '#!/usr/bin/env bash\nprintf "Missing optional dependency @openai/codex-linux-arm64\\n" >&2\nexit 1\n' > "$missing_arm64_cli"
    printf '#!/usr/bin/env bash\nprintf "network unavailable\\n" >&2\nexit 1\n' > "$unrelated_failure_cli"
    printf '#!/usr/bin/env bash\nprintf "Missing optional dependency @openai/codex-linux-x64.\\n" >&2\nprintf "codex-cli 0.200.0\\n"\n' > "$successful_warning_cli"
    chmod +x "$missing_x64_cli" "$missing_arm64_cli" "$unrelated_failure_cli" "$successful_warning_cli"
    env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" TMPDIR="$workspace" "$launcher_probe" missing-optional "$missing_x64_cli" || fail "x64 optional dependency failure must request synchronous repair"
    env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" TMPDIR="$workspace" "$launcher_probe" missing-optional "$missing_arm64_cli" || fail "arm64 optional dependency failure must request synchronous repair"
    if compgen -G "$workspace/codex-cli-output.*" >/dev/null || compgen -G "$workspace/codex-cli-error.*" >/dev/null; then
        fail "optional dependency probes must remove temporary output files"
    fi
    if env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" TMPDIR="$workspace" "$launcher_probe" missing-optional "$unrelated_failure_cli"; then
        fail "unrelated CLI failures must not request synchronous npm repair"
    fi
    if env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" TMPDIR="$workspace" "$launcher_probe" missing-optional "$successful_warning_cli"; then
        fail "successful CLI probes must not request repair based on diagnostic text alone"
    fi
    if env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" "$launcher_probe" missing-optional "$fallback_version_cli"; then
        fail "working CLI versions must keep the background preflight"
    fi

    # The version probe result is read through command substitution on the
    # launch path. The watchdog subshell (and its sleep child) must not
    # inherit that pipe, or a fast CLI still blocks the caller for the full
    # watchdog second waiting for pipe EOF.
    local fast_probe_start_ns fast_probe_end_ns fast_probe_elapsed_ms
    fast_probe_start_ns="$(date +%s%N)"
    version_output="$(env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" "$launcher_probe" version "$dash_version_cli")"
    fast_probe_end_ns="$(date +%s%N)"
    fast_probe_elapsed_ms=$(( (10#$fast_probe_end_ns - 10#$fast_probe_start_ns) / 1000000 ))
    [ "$version_output" = "0.150.0" ] || fail "fast CLI version probe must still parse --version output, got $version_output"
    [ "$fast_probe_elapsed_ms" -lt 700 ] || fail "CLI version probe must not hold the command-substitution pipe until the watchdog sleep expires, took ${fast_probe_elapsed_ms}ms"

    local unknown_cli="$workspace/unknown-version-codex"
    printf '#!/usr/bin/env bash\nprintf "codex-cli dev build\\n"\n' > "$unknown_cli"
    chmod +x "$unknown_cli"
    log_output="$(env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" "$launcher_probe" log "$unknown_cli")"
    [[ "$log_output" == "Using CODEX_CLI_PATH=$unknown_cli (version unknown; set CODEX_CLI_PATH=/path/to/codex to pin a known CLI)" ]] || fail "CLI diagnostics must explain unknown versions and explicit pinning: $log_output"

    local fd_probe_cli="$workspace/fd-probe-codex"
    local fd_state="$workspace/fd9.state"
    {
        printf '#!/usr/bin/env bash\n'
        printf 'if { true >&9; } 2>/dev/null; then printf "open\\n" > %q; else printf "closed\\n" > %q; fi\n' "$fd_state" "$fd_state"
        printf 'printf "codex-cli 0.200.0\\n"\n'
    } > "$fd_probe_cli"
    chmod +x "$fd_probe_cli"
    version_output="$(
        exec 9>"$workspace/launcher.lock"
        env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" "$launcher_probe" version "$fd_probe_cli"
    )"
    [ "$version_output" = "0.200.0" ] || fail "fd-guarded CLI probe must still read versions, got $version_output"
    [ "$(cat "$fd_state")" = "closed" ] || fail "CLI version probe child must not inherit launcher lock fd 9"

    local hanging_cli="$workspace/hanging-codex"
    local hanging_pid_file="$workspace/hanging.pid"
    {
        printf '#!/usr/bin/env bash\n'
        printf 'printf "%%s\\n" "$$" > %q\n' "$hanging_pid_file"
        printf 'printf "codex-cli 9.999.0\\n"\n'
        printf 'exec sleep 30\n'
    } > "$hanging_cli"
    chmod +x "$hanging_cli"

    version_output="$(env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" TMPDIR="$workspace" "$launcher_probe" version "$hanging_cli" || true)"
    [ -z "$version_output" ] || fail "hanging CLI probe must ignore partial version output, got $version_output"
    assert_file_exists "$hanging_pid_file"
    local hanging_pid
    hanging_pid="$(cat "$hanging_pid_file")"
    if kill -0 "$hanging_pid" 2>/dev/null; then
        sleep 0.1
    fi
    if kill -0 "$hanging_pid" 2>/dev/null; then
        kill -9 "$hanging_pid" 2>/dev/null || true
        fail "hanging CLI probe left process $hanging_pid alive"
    fi
    if env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" TMPDIR="$workspace" "$launcher_probe" missing-optional "$hanging_cli"; then
        fail "timed-out CLI probes must not request synchronous npm repair"
    fi

    local hanging_log_cli="$workspace/hanging-log-codex"
    local hanging_log_pid_file="$workspace/hanging-log.pid"
    {
        printf '#!/usr/bin/env bash\n'
        printf 'printf "%%s\\n" "$$" > %q\n' "$hanging_log_pid_file"
        printf 'printf "codex-cli 9.999.0\\n"\n'
        printf 'exec sleep 2\n'
    } > "$hanging_log_cli"
    chmod +x "$hanging_log_cli"

    log_output="$(env -i PATH="$HOST_TOOL_PATH" HOME="$fake_home" TMPDIR="$workspace" "$launcher_probe" log "$hanging_log_cli")"
    [[ "$log_output" == "Using CODEX_CLI_PATH=$hanging_log_cli (version unknown; set CODEX_CLI_PATH=/path/to/codex to pin a known CLI)" ]] || fail "log path must time out hung CLI version probes under command substitution: $log_output"
    assert_file_exists "$hanging_log_pid_file"
    local hanging_log_pid
    hanging_log_pid="$(cat "$hanging_log_pid_file")"
    if kill -0 "$hanging_log_pid" 2>/dev/null; then
        sleep 0.1
    fi
    if kill -0 "$hanging_log_pid" 2>/dev/null; then
        kill -9 "$hanging_log_pid" 2>/dev/null || true
        fail "hanging CLI log probe left process $hanging_log_pid alive"
    fi

    local routing_log="$workspace/preflight-routing.log"
    if env -i PATH="$HOST_TOOL_PATH" ROUTING_LOG="$routing_log" \
        UPDATE_MANAGER_AVAILABLE=0 TRUST_RESULT=failure BROKEN_CLI=1 \
        "$routing_probe"; then
        fail "standalone trust failure must abort launcher startup"
    fi
    grep -q '^notify=The selected Codex CLI failed its execution-free trust check' "$routing_log" || \
        fail "standalone trust failure must show safe recovery guidance"
    if grep -qE '^(probe=|background=|version=|electron=)' "$routing_log"; then
        fail "standalone trust failure must block every CLI probe, final version log, and Electron startup"
    fi

    : > "$routing_log"
    if env -i PATH="$HOST_TOOL_PATH" ROUTING_LOG="$routing_log" \
        COLD_START=0 UPDATE_MANAGER_AVAILABLE=0 TRUST_RESULT=failure \
        "$routing_probe"; then
        fail "standalone trust failure must also abort second-instance handoff"
    fi
    if grep -qE '^(probe=|background=|version=|electron=)' "$routing_log"; then
        fail "second-instance trust failure must not reach any CLI probe or Electron startup"
    fi

    : > "$routing_log"
    if env -i PATH="$HOST_TOOL_PATH" ROUTING_LOG="$routing_log" \
        CODEX_SYNC_CLI_PREFLIGHT=1 BROKEN_CLI=1 UPDATE_MANAGER_AVAILABLE=0 \
        "$routing_probe"; then
        fail "sync preflight must abort when a known-broken CLI cannot be repaired"
    fi
    grep -q '^notify=The selected Codex CLI is missing' "$routing_log" || \
        fail "sync required repair failure must show actionable reinstall guidance"

    : > "$routing_log"
    env -i PATH="$HOST_TOOL_PATH" ROUTING_LOG="$routing_log" \
        CODEX_SYNC_CLI_PREFLIGHT=1 BROKEN_CLI=1 UPDATE_MANAGER_AVAILABLE=1 \
        UPDATE_MANAGER_RESULT=success "$routing_probe"
    grep -qx 'phase=cli_preflight_repair_sync' "$routing_log" || \
        fail "sync preflight must record a successful required repair"

    : > "$routing_log"
    env -i PATH="$HOST_TOOL_PATH" ROUTING_LOG="$routing_log" \
        CODEX_SYNC_CLI_PREFLIGHT=1 BROKEN_CLI=0 UPDATE_MANAGER_AVAILABLE=0 \
        "$routing_probe"
    grep -qx 'phase=cli_preflight_sync' "$routing_log" || \
        fail "sync preflight must remain fail-soft for a CLI that is not known broken"

    : > "$routing_log"
    if env -i PATH="$HOST_TOOL_PATH" ROUTING_LOG="$routing_log" \
        BROKEN_CLI=1 UPDATE_MANAGER_AVAILABLE=0 "$routing_probe"; then
        fail "default preflight must abort when a known-broken CLI cannot be repaired"
    fi

    : > "$routing_log"
    env -i PATH="$HOST_TOOL_PATH" ROUTING_LOG="$routing_log" \
        BROKEN_CLI=0 UPDATE_MANAGER_AVAILABLE=0 "$routing_probe"
    grep -qx 'background=1' "$routing_log" || \
        fail "healthy default preflight must stay asynchronous"
    grep -qx 'phase=cli_preflight_backgrounded' "$routing_log" || \
        fail "healthy default preflight must record the background path"

    : > "$routing_log"
    env -i PATH="$HOST_TOOL_PATH" ROUTING_LOG="$routing_log" \
        BROKEN_CLI=0 UPDATE_MANAGER_AVAILABLE=1 TRUST_RESULT=success \
        "$routing_probe"
    grep -qx 'trust=called' "$routing_log" || \
        fail "native launcher must synchronously validate the selected CLI"
    grep -qx 'phase=cli_launch_path_verified' "$routing_log" || \
        fail "successful trust validation must be recorded before normal preflight"
    grep -qx 'probe=missing-optional' "$routing_log" || \
        fail "healthy CLI must be probed only after trust validation succeeds"
    grep -qx 'version=final' "$routing_log" || \
        fail "successful trust validation must allow the final CLI version log"
    grep -qx 'electron=launch' "$routing_log" || \
        fail "successful trust validation must allow Electron startup"
    [ "$(sed -n '/^trust=called$/=' "$routing_log")" -lt "$(sed -n '/^probe=missing-optional$/=' "$routing_log")" ] || \
        fail "trust validation must precede every CLI version probe"

    local trust_workspace="$workspace/standalone-trust"
    local codex_home="$trust_workspace/home/.codex"
    local release="$codex_home/packages/standalone/releases/0.42.0-test-target"
    local visible_cli="$trust_workspace/home/.local/bin/codex"
    local stable_path
    mkdir -p "$release/bin" "$(dirname "$visible_cli")"
    chmod go-w "$workspace"
    find "$trust_workspace" -type d -exec chmod go-w {} +
    cat > "$release/bin/codex" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' 'codex-cli 0.42.0'
SCRIPT
    chmod 0755 "$release/bin/codex"
    ln -s "$release" "$codex_home/packages/standalone/current"
    ln -s "$codex_home/packages/standalone/current/bin/codex" "$visible_cli"

    stable_path="$(HOME="$trust_workspace/home" python3 "$REPO_DIR/launcher/cli-launch-path.py" "$visible_cli")"
    [ "$stable_path" = "$(realpath "$release/bin/codex")" ] || \
        fail "launcher trust helper must return the canonical standalone release target"

    local replacement_marker="$trust_workspace/replacement-executed"
    local replacement_cli="$trust_workspace/replacement-codex"
    cat > "$replacement_cli" <<SCRIPT
#!/usr/bin/env bash
: > "$replacement_marker"
printf '%s\n' 'codex-cli 9.9.9'
SCRIPT
    chmod 0755 "$replacement_cli"
    rm "$visible_cli"
    ln -s "$replacement_cli" "$visible_cli"
    "$stable_path" --version >/dev/null
    [ ! -e "$replacement_marker" ] || \
        fail "replacing the visible CLI symlink must not redirect the verified launch target"

    chmod 0775 "$(dirname "$visible_cli")"
    chmod 0755 "$replacement_cli"
    mv "$codex_home/packages/standalone" "$codex_home/packages/standalone-rejected"
    if HOME="$trust_workspace/home" CODEX_HOME="$codex_home" \
        python3 "$REPO_DIR/launcher/cli-launch-path.py" "$visible_cli" >/dev/null 2>&1; then
        fail "launcher trust helper must reject an unsafe visible replacement before classification"
    fi
    [ ! -e "$replacement_marker" ] || \
        fail "launcher trust helper must not execute an unsafe pre-validation replacement"
    mv "$codex_home/packages/standalone-rejected" "$codex_home/packages/standalone"

    python3 - "$REPO_DIR/launcher/cli-launch-path.py" <<'PY'
import importlib.util
import os
import pathlib
import sys

spec = importlib.util.spec_from_file_location("cli_launch_path", pathlib.Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
euid = os.geteuid()
untrusted_uid = 2 if euid == 1 else 1
assert module.trusted_owner(euid)
assert module.trusted_owner(0)
assert not module.trusted_owner(untrusted_uid)
PY

    rm "$visible_cli"
    ln -s "$codex_home/packages/standalone/current/bin/codex" "$visible_cli"
    chmod 0775 "$release/bin/codex"
    if HOME="$trust_workspace/home" python3 "$REPO_DIR/launcher/cli-launch-path.py" "$visible_cli" >/dev/null 2>&1; then
        fail "launcher trust helper must reject a group-writable standalone binary"
    fi
    chmod 0755 "$release/bin/codex"

    local external_root="$trust_workspace/external"
    mkdir -p "$external_root/bin"
    cp "$release/bin/codex" "$external_root/bin/codex"
    rm "$codex_home/packages/standalone/current"
    ln -s "$external_root" "$codex_home/packages/standalone/current"
    if python3 "$REPO_DIR/launcher/cli-launch-path.py" "$visible_cli" >/dev/null 2>&1; then
        fail "launcher trust helper must reject an external standalone current symlink"
    fi
}

test_webview_server_cache_policy() {
    info "Checking webview server cache policy"
    python3 - "$REPO_DIR/launcher/webview-server.py" <<'PY'
import http.client
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time

server_path = pathlib.Path(sys.argv[1])
workspace = pathlib.Path(tempfile.mkdtemp(prefix="codex-webview-cache-policy-"))
proc = None

try:
    (workspace / "assets").mkdir()
    (workspace / "apps").mkdir()
    (workspace / "index.html").write_text("<!doctype html><title>Codex</title>", encoding="utf8")
    (workspace / "assets" / "app-test-abc123.js").write_text("export default 1;\n", encoding="utf8")
    (workspace / "apps" / "icon.png").write_bytes(b"png")
    fixed_mtime = 1_700_000_000
    for path in workspace.rglob("*"):
        if path.is_file():
            os.utime(path, (fixed_mtime, fixed_mtime))

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    proc = subprocess.Popen(
        [sys.executable, str(server_path), str(port), "--bind", "127.0.0.1"],
        cwd=workspace,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )

    deadline = time.time() + 5
    while True:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            if proc.poll() is not None:
                raise AssertionError(f"webview server exited early with {proc.returncode}")
            if time.time() > deadline:
                raise AssertionError("webview server did not start")
            time.sleep(0.05)

    def request(method, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request(method, path, headers=headers or {})
        response = conn.getresponse()
        body = response.read()
        result = (response.status, {k.lower(): v for k, v in response.getheaders()}, body)
        conn.close()
        return result

    index_status, index_headers, _ = request("HEAD", "/index.html")
    assert index_status == 200, index_status
    assert index_headers.get("cache-control") == "no-store, max-age=0", index_headers
    assert index_headers.get("pragma") == "no-cache", index_headers
    assert index_headers.get("expires") == "0", index_headers

    asset_status, asset_headers, _ = request("HEAD", "/assets/app-test-abc123.js")
    assert asset_status == 200, asset_status
    assert asset_headers.get("cache-control") == "no-store, max-age=0", asset_headers
    assert asset_headers.get("pragma") == "no-cache", asset_headers
    assert asset_headers.get("expires") == "0", asset_headers

    cached_status, cached_headers, _ = request(
        "GET",
        "/assets/app-test-abc123.js",
        {"If-Modified-Since": asset_headers["last-modified"]},
    )
    assert cached_status == 200, (cached_status, cached_headers)
    assert cached_headers.get("cache-control") == "no-store, max-age=0", cached_headers

    refreshed_index_status, _, _ = request(
        "GET",
        "/index.html",
        {"If-Modified-Since": index_headers["last-modified"]},
    )
    assert refreshed_index_status == 200, refreshed_index_status

    icon_status, icon_headers, _ = request("HEAD", "/apps/icon.png")
    assert icon_status == 200, icon_status
    assert icon_headers.get("cache-control") == "no-store, max-age=0", icon_headers

    escaped_index_status, escaped_index_headers, _ = request("HEAD", "/assets/../index.html")
    assert escaped_index_status == 200, escaped_index_status
    assert escaped_index_headers.get("cache-control") == "no-store, max-age=0", escaped_index_headers
finally:
    if proc is not None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    shutil.rmtree(workspace, ignore_errors=True)
PY
}

test_process_detection_helper_cmdline_shapes() {
    info "Checking Electron helper process detection cmdline shapes"
    local nul_cmdline="$TMP_DIR/electron-helper-nul.cmdline"
    local space_cmdline="$TMP_DIR/electron-helper-space.cmdline"
    local main_cmdline="$TMP_DIR/electron-main.cmdline"

    printf '/opt/codex-desktop/electron\0--type=gpu-process\0--no-sandbox\0' > "$nul_cmdline"
    printf '/opt/codex-desktop/electron --type=utility --no-sandbox' > "$space_cmdline"
    printf '/opt/codex-desktop/electron --no-sandbox' > "$main_cmdline"

    (
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/process-detection.sh"
        cmdline_has_electron_helper_type "$nul_cmdline" || exit 1
        cmdline_has_electron_helper_type "$space_cmdline" || exit 1
        ! cmdline_has_electron_helper_type "$main_cmdline" || exit 1
    ) || fail "Electron helper detection must handle NUL-separated and space-joined cmdline formats"
}

test_side_by_side_launcher_identity() {
    info "Checking side-by-side launcher identity"
    local workspace="$TMP_DIR/side-by-side-launcher"
    local app_dir="$workspace/codex-cua-lab-app"
    local bin_dir="$workspace/bin"
    local help_log="$workspace/help.log"
    local symlink_help_log="$workspace/symlink-help.log"
    local linux_icon_source="$workspace/codex-linux.png"

    mkdir -p "$app_dir" "$bin_dir"
    printf '%s\n' 'linux-icon' > "$linux_icon_source"

    CODEX_INSTALLER_SOURCE_ONLY=1 \
    CODEX_APP_ID="codex-cua-lab" \
    CODEX_APP_DISPLAY_NAME="Codex CUA Lab" \
    CODEX_INSTALL_DIR="$app_dir" \
    CODEX_LINUX_ICON_SOURCE="$linux_icon_source" \
    bash -c 'source "$1"; validate_app_identity; create_start_script' _ "$REPO_DIR/install.sh"

    assert_file_exists "$app_dir/start.sh"
    assert_file_exists "$app_dir/.codex-linux/webview-server.py"
    assert_file_exists "$app_dir/.codex-linux/cli-launch-path.py"
    assert_file_exists "$app_dir/.codex-linux/codex-cua-lab.png"
    cmp -s "$linux_icon_source" "$app_dir/.codex-linux/codex-cua-lab.png" \
        || fail "Expected side-by-side launcher icon to use CODEX_LINUX_ICON_SOURCE"
    assert_contains "$app_dir/start.sh" "CODEX_LINUX_APP_ID=codex-cua-lab"
    assert_contains "$app_dir/start.sh" "CODEX_LINUX_APP_DISPLAY_NAME=Codex\\\\ CUA\\\\ Lab"
    assert_contains "$app_dir/start.sh" 'CODEX_LINUX_WEBVIEW_PORT=${CODEX_WEBVIEW_PORT:-5176}'
    assert_contains "$app_dir/start.sh" 'CODEX_LINUX_SETTINGS_FILE="$APP_SETTINGS_FILE"'
    assert_contains "$app_dir/start.sh" 'export CODEX_HOME CODEX_LINUX_APP_ID CODEX_LINUX_APP_DISPLAY_NAME CODEX_LINUX_WEBVIEW_PORT CODEX_LINUX_SETTINGS_FILE CODEX_LINUX_FEATURES_DIR'
    assert_contains "$app_dir/start.sh" 'WEBVIEW_ORIGIN="http://127.0.0.1:$CODEX_LINUX_WEBVIEW_PORT"'
    assert_contains "$app_dir/start.sh" "CODEX_LINUX_ALLOW_RENDERER_URL_OVERRIDE"
    assert_contains "$app_dir/start.sh" 'export ELECTRON_RENDERER_URL="$WEBVIEW_ORIGIN/"'
    assert_contains "$app_dir/start.sh" "resolve_script_dir"
    assert_contains "$app_dir/start.sh" "configure_side_by_side_app_env"
    assert_contains "$app_dir/start.sh" 'XDG_CONFIG_HOME="${CODEX_XDG_CONFIG_HOME:-$APP_STATE_DIR/xdg-config}"'
    assert_contains "$app_dir/start.sh" '--class="$CODEX_LINUX_APP_ID"'
    assert_contains "$app_dir/start.sh" '--app-id="$CODEX_LINUX_APP_ID"'
    assert_contains "$app_dir/start.sh" '--user-data-dir="${CODEX_ELECTRON_USER_DATA_DIR:-$APP_STATE_DIR/electron-user-data}"'
    assert_contains "$app_dir/start.sh" "--force-renderer-accessibility"
    assert_contains "$app_dir/start.sh" 'LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/$CODEX_LINUX_APP_ID"'
    XDG_CACHE_HOME="$workspace/cache" XDG_STATE_HOME="$workspace/state" XDG_RUNTIME_DIR="$workspace/runtime" bash "$app_dir/start.sh" --help >"$help_log"
    assert_contains "$help_log" "Launches the Codex CUA Lab app."
    assert_contains "$help_log" "codex-cua-lab/launcher"

    ln -s "$app_dir/start.sh" "$bin_dir/codex-cua-lab"
    XDG_CACHE_HOME="$workspace/cache" XDG_STATE_HOME="$workspace/state" XDG_RUNTIME_DIR="$workspace/runtime" bash "$bin_dir/codex-cua-lab" --help >"$symlink_help_log"
    assert_contains "$symlink_help_log" "Launches the Codex CUA Lab app."
}

test_browser_use_node_repl_fallback_runtime() {
    info "Checking Browser Use node_repl fallback runtime"
    if [ "$(uname -m)" != "x86_64" ]; then
        info "Skipping x86_64-only Browser Use fallback runtime test"
        return 0
    fi

    local workspace="$TMP_DIR/browser-use-node-repl-fallback"
    local app_dir="$workspace/Codex.app"
    local install_dir="$workspace/install"
    local archive_root="$workspace/archive-root"
    local archive="$workspace/runtime.tar.xz"
    local output_log="$workspace/output.log"
    local archive_sha
    local true_bin

    mkdir -p "$workspace" "$install_dir/resources" "$archive_root/codex-primary-runtime/dependencies/bin"
    make_fake_browser_upstream_app "$app_dir"

    # Simulate the current upstream DMG shape: node_repl is under cua_node/bin,
    # but the macOS binary is not a Linux ELF.
    mkdir -p "$app_dir/Contents/Resources/cua_node/bin"
    printf '\xfe\xed\xfa\xcf' > "$app_dir/Contents/Resources/cua_node/bin/node_repl"
    chmod +x "$app_dir/Contents/Resources/cua_node/bin/node_repl"

    true_bin="$(type -P true)"
    cp "$true_bin" "$archive_root/codex-primary-runtime/dependencies/bin/node_repl"
    chmod 0755 "$archive_root/codex-primary-runtime/dependencies/bin/node_repl"
    tar -cJf "$archive" -C "$archive_root" codex-primary-runtime
    archive_sha="$(sha256sum "$archive" | awk '{print $1}')"

    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        WORK_DIR="$workspace/work"
        ARCH="$(uname -m)"
        ICON_SOURCE="$workspace/missing-icon.png"
        CODEX_APP_ID="codex-desktop"
        XDG_CACHE_HOME="$workspace/xdg-cache"
        CODEX_NODE_REPL_PATH=
        CODEX_LINUX_NODE_REPL_SOURCE=
        CODEX_BROWSER_USE_RUNTIME_CACHE_DIR="$workspace/cache"
        CODEX_BROWSER_USE_NODE_REPL_RUNTIME_URL="file://$archive"
        CODEX_BROWSER_USE_NODE_REPL_RUNTIME_SHA256="$archive_sha"
        mkdir -p "$WORK_DIR"
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_linux_computer_use_plugin() { return 1; }
        build_chrome_extension_host() {
            local fake_host="$workspace/codex-chrome-extension-host"
            printf '#!/bin/sh\n' > "$fake_host"
            chmod +x "$fake_host"
            printf '%s\n' "$fake_host"
        }
        install_bundled_plugin_resources "$app_dir"
    ) >"$output_log" 2>&1

    assert_file_exists "$install_dir/resources/node_repl"
    assert_file_exists "$install_dir/resources/plugins/openai-bundled/plugins/browser/scripts/browser-client.mjs"
    cmp -s "$true_bin" "$install_dir/resources/node_repl" || fail "Expected fallback node_repl to come from the runtime archive"
    assert_contains "$install_dir/resources/plugins/openai-bundled/plugins/browser/scripts/browser-client.mjs" 'globalThis.nodeRepl?.env?.\[e\]'
    assert_not_contains "$install_dir/resources/plugins/openai-bundled/plugins/browser/scripts/browser-client.mjs" 'globalThis.nodeRepl?.env\[e\]'
    assert_contains "$install_dir/resources/plugins/openai-bundled/plugins/browser/scripts/browser-client.mjs" "codexLinuxSiteStatusAllowlistFallback"
    assert_contains "$install_dir/resources/plugins/openai-bundled/plugins/browser/scripts/browser-client.mjs" "codexLinuxFileUrlPolicy"
    assert_contains "$output_log" "Browser Use node_repl runtime is not a Linux executable for x86_64; skipping"
    assert_not_contains "$output_log" "WARN.*Browser Use node_repl runtime is not a Linux executable"
    assert_contains "$output_log" "Downloading Browser Use node_repl fallback runtime"
}

test_browser_use_file_url_policy_patch_behavior() {
    info "Checking Browser Use file URL policy patch behavior"
    local workspace="$TMP_DIR/browser-file-url-policy"
    local client="$workspace/browser-client.mjs"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    cat > "$client" <<'JS'
var I2=new Set(["about:blank"]);function Gb(e){if(I2.has(e))return!0;let t;try{t=new URL(e)}catch{return!1}return t.protocol==="http:"||t.protocol==="https:"}
JS

    (
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        patch_browser_use_file_url_policy "$client"
    ) >"$output_log" 2>&1

    assert_contains "$client" "codexLinuxFileUrlPolicy"
    assert_contains "$client" 'protocol==="file:"'
    assert_not_contains "$client" 'protocol==="data:"'
    assert_not_contains "$output_log" "Could not find Browser Use URL policy insertion point"

    node - "$client" <<'NODE'
const fs = require("fs");
const vm = require("vm");

const client = process.argv[2];
const source = fs.readFileSync(client, "utf8");
const context = { URL };
vm.createContext(context);
vm.runInContext(
  `${source}
this.results = {
  aboutBlank: Gb("about:blank"),
  http: Gb("http://example.com/"),
  https: Gb("https://example.com/"),
  localFile: Gb("file:///tmp/codex-browser-file-policy.html"),
  localhostFile: Gb("file://localhost/tmp/codex-browser-file-policy.html"),
  remoteFile: Gb("file://example.com/tmp/codex-browser-file-policy.html"),
  data: Gb("data:text/html,hello"),
  javascript: Gb("javascript:alert(1)"),
  ftp: Gb("ftp://example.com/"),
  invalid: Gb("not a url"),
};`,
  context,
);

const expected = {
  aboutBlank: true,
  http: true,
  https: true,
  localFile: true,
  localhostFile: true,
  remoteFile: false,
  data: false,
  javascript: false,
  ftp: false,
  invalid: false,
};

for (const [key, value] of Object.entries(expected)) {
  if (context.results[key] !== value) {
    throw new Error(`${key}: expected ${value}, got ${context.results[key]}`);
  }
}
NODE
}

test_browser_plugin_renamed_upstream_staging() {
    info "Checking Browser plugin staging from renamed upstream resources"
    local workspace="$TMP_DIR/browser-plugin-renamed"
    local app_dir="$workspace/Codex.app"
    local install_dir="$workspace/install"
    local output_log="$workspace/output.log"
    local browser_dir="$install_dir/resources/plugins/openai-bundled/plugins/browser"
    local marketplace="$install_dir/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"

    mkdir -p "$workspace" "$install_dir/resources"
    make_fake_browser_upstream_app "$app_dir"

    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        WORK_DIR="$workspace/work"
        ARCH="x86_64"
        ICON_SOURCE="$workspace/missing-icon.png"
        CODEX_APP_ID="codex-desktop"
        mkdir -p "$WORK_DIR"
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_linux_computer_use_plugin() { return 1; }
        install_browser_use_node_repl_resource() { return 0; }
        install_bundled_plugin_resources "$app_dir"
    ) >"$output_log" 2>&1

    assert_file_exists "$browser_dir/scripts/browser-client.mjs"
    assert_contains "$browser_dir/.codex-plugin/plugin.json" '"name":"browser"'
    assert_contains "$browser_dir/scripts/browser-client.mjs" 'globalThis.nodeRepl?.env?.\[e\]'
    assert_not_contains "$browser_dir/scripts/browser-client.mjs" 'globalThis.nodeRepl?.env\[e\]'
    assert_contains "$browser_dir/scripts/browser-client.mjs" "nativePipe??import.meta.__codexNativePipe"
    assert_not_contains "$browser_dir/scripts/browser-client.mjs" "let e=import.meta.__codexNativePipe;return"
    assert_contains "$browser_dir/scripts/browser-client.mjs" "codexLinuxSiteStatusAllowlistFallback"
    assert_contains "$browser_dir/scripts/browser-client.mjs" "codexLinuxFileUrlPolicy"
    assert_contains "$browser_dir/scripts/browser-client.mjs" "codexLinuxIabSocketScope"
    assert_contains "$browser_dir/scripts/browser-client.mjs" 'protocol==="file:"'
    assert_not_contains "$browser_dir/scripts/browser-client.mjs" 'protocol==="data:"'
    assert_contains "$marketplace" '"name": "browser"'
    assert_contains "$marketplace" '"path": "./plugins/browser"'
    assert_contains "$output_log" "Browser plugin staged from upstream DMG"
    assert_not_contains "$output_log" "Browser bundled plugin resources not present"
}

test_upstream_bundled_skills_staging() {
    info "Checking current upstream bundled skills staging"
    local workspace="$TMP_DIR/upstream-bundled-skills"
    local app_dir="$workspace/ChatGPT.app"
    local install_dir="$workspace/install"
    local output_log="$workspace/output.log"
    local source_skill="$app_dir/Contents/Resources/skills/skills/.curated/hatch-pet"
    local target_skill="$install_dir/resources/skills/skills/.curated/hatch-pet"

    mkdir -p "$workspace" "$install_dir/resources"
    make_fake_browser_upstream_app "$app_dir"
    mkdir -p "$source_skill/references" "$source_skill/scripts"
    printf '%s\n' '# Hatch Pet' > "$source_skill/SKILL.md"
    printf '%s\n' '# Animation rows' > "$source_skill/references/animation-rows.md"
    printf '%s\n' 'print("render")' > "$source_skill/scripts/render_animation_previews.py"
    printf '%s\n' 'finder metadata' > "$source_skill/scripts/render_animation_previews.py:com.apple.FinderInfo"
    ln -s "../references/animation-rows.md" "$source_skill/scripts/animation-rows.md"

    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        WORK_DIR="$workspace/work"
        ARCH="x86_64"
        ICON_SOURCE="$workspace/missing-icon.png"
        CODEX_APP_ID="codex-desktop"
        mkdir -p "$WORK_DIR"
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_linux_computer_use_plugin() { return 1; }
        stage_browser_plugin_from_upstream() { return 1; }
        stage_chrome_plugin_from_upstream() { return 1; }
        install_browser_use_node_repl_resource() { return 0; }
        install_bundled_plugin_resources "$app_dir"
    ) >"$output_log" 2>&1

    assert_file_exists "$target_skill/SKILL.md"
    assert_file_exists "$target_skill/references/animation-rows.md"
    assert_file_exists "$target_skill/scripts/render_animation_previews.py"
    [ -L "$target_skill/scripts/animation-rows.md" ] \
        || fail "Expected internal bundled-skill symlink to be preserved"
    [ "$(readlink "$target_skill/scripts/animation-rows.md")" = "../references/animation-rows.md" ] \
        || fail "Expected internal bundled-skill symlink target to remain relative"
    [ "$(readlink -f "$target_skill/scripts/animation-rows.md")" = "$target_skill/references/animation-rows.md" ] \
        || fail "Expected internal bundled-skill symlink to remain inside the staged root"
    [ ! -e "$target_skill/scripts/render_animation_previews.py:com.apple.FinderInfo" ] \
        || fail "Expected macOS sidecar metadata to be removed from staged bundled skills"
    assert_contains "$output_log" "Bundled skills staged from upstream DMG"
}

test_upstream_bundled_skills_validator_guards() {
    info "Checking bundled skills filesystem guards"
    local workspace="$TMP_DIR/upstream-bundled-skills-validator"
    local case_name=""
    local case_dir=""
    local output_log=""

    mkdir -p "$workspace"
    printf '%s\n' 'outside' > "$workspace/outside.txt"

    # shellcheck disable=SC1091
    source "$REPO_DIR/scripts/lib/bundled-plugins.sh"

    for case_name in internal-relative absolute escaping chained-escape dangling named-pipe privileged-file root-symlink; do
        case_dir="$workspace/$case_name"
        output_log="$workspace/$case_name.log"
        mkdir -p "$case_dir/skills/.curated/hatch-pet/references"
        printf '%s\n' '# Hatch Pet' > "$case_dir/skills/.curated/hatch-pet/SKILL.md"

        case "$case_name" in
            internal-relative)
                printf '%s\n' '# Shared reference' > "$case_dir/skills/.curated/shared.md"
                ln -s "../../shared.md" "$case_dir/skills/.curated/hatch-pet/references/shared.md"
                ;;
            absolute)
                ln -s "$workspace/outside.txt" "$case_dir/skills/.curated/hatch-pet/references/outside.md"
                ;;
            escaping)
                ln -s "../../../../../outside.txt" "$case_dir/skills/.curated/hatch-pet/references/outside.md"
                ;;
            chained-escape)
                ln -s "../../../outside.txt" "$case_dir/skills/.curated/escape"
                ln -s "../../escape" "$case_dir/skills/.curated/hatch-pet/references/outside.md"
                ;;
            dangling)
                ln -s "missing.md" "$case_dir/skills/.curated/hatch-pet/references/missing.md"
                ;;
            named-pipe)
                mkfifo "$case_dir/skills/.curated/hatch-pet/channel"
                ;;
            privileged-file)
                chmod 4755 "$case_dir/skills/.curated/hatch-pet/SKILL.md"
                ;;
            root-symlink)
                mv "$case_dir" "$case_dir.real"
                ln -s "$case_dir.real" "$case_dir"
                ;;
        esac

        if [ "$case_name" = "internal-relative" ]; then
            validate_upstream_bundled_skills "$case_dir" >"$output_log" 2>&1 \
                || fail "Expected internal relative bundled-skill symlink to be accepted"
        elif validate_upstream_bundled_skills "$case_dir" >"$output_log" 2>&1; then
            fail "Expected bundled skills validator to reject $case_name"
        fi
    done

    assert_contains "$workspace/absolute.log" "absolute symlink is not allowed"
    assert_contains "$workspace/escaping.log" "symlink escapes bundled skills root"
    assert_contains "$workspace/chained-escape.log" "symlink escapes bundled skills root"
    assert_contains "$workspace/dangling.log" "cannot resolve symlink"
    assert_contains "$workspace/named-pipe.log" "unsupported file type"
    assert_contains "$workspace/privileged-file.log" "privileged mode is not allowed"
    assert_contains "$workspace/root-symlink.log" "bundled skills root cannot be a symlink"
}

test_upstream_bundled_skills_rejects_unsafe_source() {
    info "Checking bundled skills unsafe source rejection is propagated"
    local workspace="$TMP_DIR/upstream-bundled-skills-unsafe-source"
    local app_dir="$workspace/ChatGPT.app"
    local install_dir="$workspace/install"
    local source_skills="$app_dir/Contents/Resources/skills"
    local target_skills="$install_dir/resources/skills"
    local output_log="$workspace/output.log"

    mkdir -p "$source_skills/skills/.curated/hatch-pet" "$target_skills/skills/.curated/hatch-pet"
    printf '%s\n' 'new skill' > "$source_skills/skills/.curated/hatch-pet/SKILL.md"
    printf '%s\n' 'previous skill' > "$target_skills/skills/.curated/hatch-pet/SKILL.md"
    ln -s "$workspace/outside.txt" "$source_skills/skills/.curated/hatch-pet/outside"

    (
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        if install_bundled_plugin_resources "$app_dir"; then
            fail "Expected bundled plugin installation to propagate unsafe skills rejection"
        fi
    ) >"$output_log" 2>&1

    assert_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "previous skill"
    assert_not_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "new skill"
    assert_contains "$output_log" "Bundled skills source contains unsupported content"
    [ -z "$(find "$(dirname "$target_skills")" -mindepth 1 -maxdepth 1 -type d -name '.skills.tmp.*' -print -quit)" ] \
        || fail "Expected unsafe bundled skills source rejection to leave no staging directory"
}

test_upstream_bundled_skills_post_copy_validation() {
    info "Checking bundled skills post-copy validation preserves the target"
    local workspace="$TMP_DIR/upstream-bundled-skills-post-copy"
    local source_skills="$workspace/source-skills"
    local target_skills="$workspace/install/resources/skills"
    local output_log="$workspace/output.log"

    mkdir -p "$source_skills/skills/.curated/hatch-pet" "$target_skills/skills/.curated/hatch-pet"
    printf '%s\n' 'new skill' > "$source_skills/skills/.curated/hatch-pet/SKILL.md"
    printf '%s\n' 'previous skill' > "$target_skills/skills/.curated/hatch-pet/SKILL.md"
    printf '%s\n' 'outside' > "$workspace/outside.txt"

    (
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        cp() {
            command cp "$@" || return
            if [ "$#" -eq 3 ] && [ "$1" = "-R" ] && [ "$2" = "$source_skills/." ] &&
                [[ "$3" == "$(dirname "$target_skills")/.skills.tmp."* ]]; then
                ln -s "$workspace/outside.txt" "$3/post-copy-link"
            fi
        }
        if stage_upstream_bundled_skills "$source_skills" "$target_skills"; then
            fail "Expected post-copy bundled skills validation to reject injected content"
        fi
    ) >"$output_log" 2>&1

    assert_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "previous skill"
    assert_not_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "new skill"
    assert_contains "$output_log" "Bundled skills failed post-copy validation"
    [ -z "$(find "$(dirname "$target_skills")" -mindepth 1 -maxdepth 1 -type d -name '.skills.tmp.*' -print -quit)" ] \
        || fail "Expected post-copy validation failure to leave no staging directory"
}

test_upstream_bundled_skills_replaces_target_symlink_safely() {
    info "Checking bundled skills target symlink replacement"
    local workspace="$TMP_DIR/upstream-bundled-skills-target-symlink"
    local source_skills="$workspace/source-skills"
    local target_skills="$workspace/install/resources/skills"
    local external_target="$workspace/external-target"

    mkdir -p "$source_skills/skills/.curated/hatch-pet" "$external_target" "$(dirname "$target_skills")"
    printf '%s\n' 'new skill' > "$source_skills/skills/.curated/hatch-pet/SKILL.md"
    printf '%s\n' 'external state' > "$external_target/existing.txt"
    ln -s "$external_target" "$target_skills"

    (
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_upstream_bundled_skills "$source_skills" "$target_skills"
    )

    [ ! -L "$target_skills" ] || fail "Expected target symlink to be replaced, not followed"
    assert_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "new skill"
    assert_contains "$external_target/existing.txt" "external state"
    [ ! -e "$external_target/skills" ] || fail "Expected external symlink target to remain untouched"
}

test_upstream_bundled_skills_backup_cleanup_failure_is_recoverable() {
    info "Checking bundled skills backup cleanup failure is fail-closed and recoverable"
    local workspace="$TMP_DIR/upstream-bundled-skills-cleanup-failure"
    local source_skills="$workspace/source-skills"
    local target_skills="$workspace/install/resources/skills"
    local backup_skills="$(dirname "$target_skills")/.skills.backup.$$"
    local output_log="$workspace/output.log"

    mkdir -p "$source_skills/skills/.curated/hatch-pet" "$target_skills/skills/.curated/hatch-pet"
    printf '%s\n' 'new skill' > "$source_skills/skills/.curated/hatch-pet/SKILL.md"
    printf '%s\n' 'previous skill' > "$target_skills/skills/.curated/hatch-pet/SKILL.md"

    (
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        rm() {
            if [ "$#" -eq 3 ] && [ "$1" = "-rf" ] && [ "$2" = "--" ] &&
                [ "$3" = "$backup_skills" ] && { [ -e "$backup_skills" ] || [ -L "$backup_skills" ]; }; then
                return 1
            fi
            command rm "$@"
        }
        if stage_upstream_bundled_skills "$source_skills" "$target_skills"; then
            fail "Expected bundled skills backup cleanup failure to fail staging"
        fi
    ) >"$output_log" 2>&1

    assert_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "new skill"
    assert_contains "$backup_skills/skills/.curated/hatch-pet/SKILL.md" "previous skill"
    assert_contains "$output_log" "Failed to clean previous bundled skills backup"

    (
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_upstream_bundled_skills "$source_skills" "$target_skills"
    )

    assert_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "new skill"
    [ ! -e "$backup_skills" ] || fail "Expected second staging run to clean the stale backup"
}

test_upstream_bundled_skills_stage_failure_restores_target() {
    info "Checking bundled skills staging restores the previous target on failure"
    local workspace="$TMP_DIR/upstream-bundled-skills-failure"
    local source_skills="$workspace/source-skills"
    local target_skills="$workspace/install/resources/skills"
    local output_log="$workspace/output.log"

    mkdir -p "$source_skills/skills/.curated/hatch-pet" "$target_skills/skills/.curated/hatch-pet"
    printf '%s\n' 'new skill' > "$source_skills/skills/.curated/hatch-pet/SKILL.md"
    printf '%s\n' 'previous skill' > "$target_skills/skills/.curated/hatch-pet/SKILL.md"

    (
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        mv() {
            if [ "$#" -eq 3 ] && [ "$1" = "--" ] &&
                [[ "$2" == "$(dirname "$target_skills")/.skills.tmp."* ]] &&
                [ "$3" = "$target_skills" ]; then
                return 1
            fi
            command mv "$@"
        }
        if stage_upstream_bundled_skills "$source_skills" "$target_skills"; then
            fail "Expected bundled skills staging to fail when target promotion fails"
        fi
    ) >"$output_log" 2>&1

    assert_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "previous skill"
    assert_not_contains "$target_skills/skills/.curated/hatch-pet/SKILL.md" "new skill"
    assert_contains "$output_log" "previous target was restored"
}

test_portable_bundled_plugins_staging() {
    info "Checking portable upstream bundled plugin staging"
    local workspace="$TMP_DIR/portable-bundled-plugins"
    local app_dir="$workspace/ChatGPT.app"
    local install_dir="$workspace/install"
    local output_log="$workspace/output.log"
    local marketplace="$install_dir/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"
    local plugins_dir="$install_dir/resources/plugins/openai-bundled/plugins"

    mkdir -p "$workspace" "$install_dir/resources"
    make_fake_portable_plugins_upstream_app "$app_dir"

    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        WORK_DIR="$workspace/work"
        ARCH="x86_64"
        ICON_SOURCE="$workspace/missing-icon.png"
        CODEX_APP_ID="codex-desktop"
        mkdir -p "$WORK_DIR"
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_linux_computer_use_plugin() { return 1; }
        stage_browser_plugin_from_upstream() { return 1; }
        stage_chrome_plugin_from_upstream() { return 1; }
        install_browser_use_node_repl_resource() { return 0; }
        install_bundled_plugin_resources "$app_dir"
    ) >"$output_log" 2>&1

    assert_file_exists "$plugins_dir/sites/.codex-plugin/plugin.json"
    assert_file_exists "$plugins_dir/deep-research/.codex-plugin/plugin.json"
    assert_file_exists "$plugins_dir/visualize/.codex-plugin/plugin.json"
    assert_mode "$plugins_dir/sites/scripts/init-site.sh" "755"
    [ ! -e "$plugins_dir/latex" ] || fail "Expected native LaTeX plugin to remain unstaged"
    [ ! -e "$plugins_dir/record-and-replay" ] || fail "Expected native Record and Replay plugin to remain unstaged"
    assert_contains "$output_log" "Portable bundled plugin sites staged from upstream DMG"
    assert_contains "$output_log" "Portable bundled plugin deep-research staged from upstream DMG"
    assert_contains "$output_log" "Portable bundled plugin visualize staged from upstream DMG"

    node - "$marketplace" <<'NODE'
const fs = require("fs");
const marketplace = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const names = marketplace.plugins.map((plugin) => plugin.name);
const expected = ["sites", "deep-research", "visualize"];
if (JSON.stringify(names) !== JSON.stringify(expected)) {
  throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(names)}`);
}
for (const plugin of marketplace.plugins) {
  if (plugin.source?.source !== "local" || plugin.source.path !== `./plugins/${plugin.name}`) {
    throw new Error(`unsafe marketplace source for ${plugin.name}`);
  }
}
NODE
    node --check "$plugins_dir/sites/mcp/server.mjs"
    python3 -m py_compile "$plugins_dir/visualize/skills/visualize/scripts/render.py"
}

test_portable_bundled_plugins_reject_unsafe_content() {
    info "Checking unsafe portable bundled plugin rejection"
    local workspace="$TMP_DIR/portable-bundled-plugins-unsafe"
    local app_dir="$workspace/ChatGPT.app"
    local install_dir="$workspace/install"
    local output_log="$workspace/output.log"
    local source_plugins="$app_dir/Contents/Resources/plugins/openai-bundled/plugins"
    local target_plugins="$install_dir/resources/plugins/openai-bundled/plugins"
    local victim="$workspace/private.txt"

    mkdir -p "$workspace" "$install_dir/resources"
    make_fake_portable_plugins_upstream_app "$app_dir"
    printf '%s\n' 'do-not-copy' > "$victim"
    ln -s "$victim" "$source_plugins/sites/private-link"
    printf '\x7fELF' > "$source_plugins/deep-research/native-helper"
    chmod 0755 "$source_plugins/deep-research/native-helper"

    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        WORK_DIR="$workspace/work"
        ARCH="x86_64"
        ICON_SOURCE="$workspace/missing-icon.png"
        CODEX_APP_ID="codex-desktop"
        mkdir -p "$WORK_DIR"
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_linux_computer_use_plugin() { return 1; }
        stage_browser_plugin_from_upstream() { return 1; }
        stage_chrome_plugin_from_upstream() { return 1; }
        install_browser_use_node_repl_resource() { return 0; }
        install_bundled_plugin_resources "$app_dir"
    ) >"$output_log" 2>&1

    [ ! -e "$target_plugins/sites" ] || fail "Expected symlink-bearing Sites plugin to be rejected"
    [ ! -e "$target_plugins/deep-research" ] || fail "Expected native Deep Research payload to be rejected"
    assert_file_exists "$target_plugins/visualize/.codex-plugin/plugin.json"
    assert_contains "$output_log" "symlink is not allowed: private-link"
    assert_contains "$output_log" "native executable is not portable: native-helper"
    assert_contains "$victim" "do-not-copy"
}

test_portable_bundled_plugin_validator_guards() {
    info "Checking portable bundled plugin manifest and filesystem guards"
    local workspace="$TMP_DIR/portable-bundled-plugin-validator-guards"
    local base_plugin="$workspace/base"
    local case_dir=""
    local case_name=""
    local output_log=""

    mkdir -p "$base_plugin/.codex-plugin"
    printf '%s\n' '{"name":"sites","version":"1.0.0"}' > "$base_plugin/.codex-plugin/plugin.json"
    printf '%s\n' "portable" > "$base_plugin/content.txt"

    # shellcheck disable=SC1091
    source "$REPO_DIR/scripts/lib/bundled-plugins.sh"

    for case_name in invalid-version manifest-symlink privileged-directory native-bundle named-pipe; do
        case_dir="$workspace/$case_name"
        output_log="$workspace/$case_name.log"
        cp -R "$base_plugin" "$case_dir"

        case "$case_name" in
            invalid-version)
                printf '%s\n' '{"name":"sites","version":"../invalid"}' > "$case_dir/.codex-plugin/plugin.json"
                ;;
            manifest-symlink)
                printf '%s\n' '{"name":"sites","version":"1.0.0"}' > "$workspace/external-manifest.json"
                rm "$case_dir/.codex-plugin/plugin.json"
                ln -s "$workspace/external-manifest.json" "$case_dir/.codex-plugin/plugin.json"
                ;;
            privileged-directory)
                mkdir "$case_dir/privileged"
                chmod 2755 "$case_dir/privileged"
                ;;
            native-bundle)
                mkdir "$case_dir/helper.app"
                ;;
            named-pipe)
                mkfifo "$case_dir/channel"
                ;;
        esac

        if validate_portable_bundled_plugin "$case_dir" sites >"$output_log" 2>&1; then
            fail "Expected portable plugin validator to reject $case_name"
        fi
    done

    assert_contains "$workspace/invalid-version.log" "plugin manifest version is missing or invalid"
    assert_contains "$workspace/manifest-symlink.log" "plugin manifest cannot be a symlink"
    assert_contains "$workspace/privileged-directory.log" "privileged mode is not allowed: privileged"
    assert_contains "$workspace/native-bundle.log" "native bundle is not portable: helper.app"
    assert_contains "$workspace/named-pipe.log" "non-regular file is not allowed: channel"
}

test_portable_bundled_plugin_stage_failures() {
    info "Checking portable bundled plugin stage failure propagation"
    local workspace="$TMP_DIR/portable-bundled-plugin-stage-failures"
    local failure=""

    for failure in sidecar-cleanup target-backup final-move; do
        local case_dir="$workspace/$failure"
        local app_dir="$case_dir/ChatGPT.app"
        local source_plugin="$app_dir/Contents/Resources/plugins/openai-bundled/plugins/sites"
        local target_plugins="$case_dir/target"
        local output_log="$case_dir/output.log"

        mkdir -p "$target_plugins"
        make_fake_portable_plugins_upstream_app "$app_dir"
        if [ "$failure" = "target-backup" ] || [ "$failure" = "final-move" ]; then
            mkdir -p "$target_plugins/sites"
            printf '%s\n' "keep-existing" > "$target_plugins/sites/existing.txt"
        fi

        if ! (
            warn() { echo "[WARN] $*" >&2; }
            info() { echo "[INFO] $*" >&2; }
            # shellcheck disable=SC1091
            source "$REPO_DIR/scripts/lib/bundled-plugins.sh"

            case "$failure" in
                sidecar-cleanup)
                    remove_macos_sidecar_files() { return 71; }
                    ;;
                target-backup)
                    mv() {
                        local args=("$@")
                        local offset=0
                        if [ "${args[0]}" = "--" ]; then
                            offset=1
                        fi
                        if [ "${args[$offset]}" = "$target_plugins/sites" ]; then
                            return 72
                        fi
                        command mv "$@"
                    }
                    ;;
                final-move)
                    mv() {
                        local args=("$@")
                        local offset=0
                        if [ "${args[0]}" = "--" ]; then
                            offset=1
                        fi
                        local source="${args[$offset]}"
                        local destination="${args[$((offset + 1))]}"
                        if [[ "$source" == *".sites.tmp."* ]] && [ "$destination" = "$target_plugins/sites" ]; then
                            return 73
                        fi
                        command mv "$@"
                    }
                    ;;
            esac

            if stage_portable_bundled_plugin_from_upstream "$source_plugin" "$target_plugins" sites; then
                echo "stage unexpectedly succeeded for $failure" >&2
                exit 1
            fi
        ) >"$output_log" 2>&1; then
            fail "Expected $failure to propagate as a staging failure"
        fi

        assert_not_contains "$output_log" "Portable bundled plugin sites staged from upstream DMG"
        [ -z "$(find "$target_plugins" -mindepth 1 -maxdepth 1 -type d \( -name '.sites.tmp.*' -o -name '.sites.backup.*' \) -print -quit)" ] \
            || fail "Expected $failure staging and backup cleanup"

        case "$failure" in
            sidecar-cleanup)
                assert_contains "$output_log" "Failed to clean macOS sidecar files for portable bundled plugin sites"
                [ ! -e "$target_plugins/sites" ] || fail "Expected sidecar cleanup failure to leave no target"
                ;;
            target-backup)
                assert_contains "$output_log" "Failed to preserve existing portable bundled plugin sites"
                assert_contains "$target_plugins/sites/existing.txt" "keep-existing"
                ;;
            final-move)
                assert_contains "$output_log" "previous target was restored"
                assert_contains "$target_plugins/sites/existing.txt" "keep-existing"
                ;;
        esac
    done
}

test_portable_bundled_plugin_marketplace_path_guard() {
    info "Checking portable bundled plugin marketplace path guard"
    local workspace="$TMP_DIR/portable-bundled-plugin-path-guard"
    local marketplace="$workspace/marketplace.json"
    local listed="$workspace/listed.txt"
    local rewritten="$workspace/rewritten/.agents/plugins/marketplace.json"

    mkdir -p "$workspace"
    cat > "$marketplace" <<'JSON'
{"plugins":[{"name":"sites","source":{"source":"local","path":"../../outside"},"category":"unsafe-first"},{"name":"sites","source":{"source":"local","path":"./plugins/sites"},"category":"safe-sites"},{"name":"sites","source":{"source":"local","path":"./plugins/sites"},"category":"duplicate-safe"},{"name":"deep-research","source":{"source":"git","path":"./plugins/deep-research"}},{"name":"visualize","source":{"source":"local","path":".\\plugins\\visualize"},"category":"safe-visualize"}]}
JSON

    (
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        list_portable_bundled_plugins "$marketplace"
    ) > "$listed"

    [ "$(grep -Fxc 'sites' "$listed")" -eq 1 ] || fail "Expected one safe Sites marketplace entry"
    [ "$(grep -Fxc 'visualize' "$listed")" -eq 1 ] || fail "Expected one safe Visualize marketplace entry"
    assert_not_contains "$listed" "deep-research"

    (
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        write_bundled_plugins_marketplace "$marketplace" "$rewritten" 0 0 0 sites visualize
    )
    node - "$rewritten" <<'NODE'
const fs = require("fs");
const marketplace = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byName = new Map(marketplace.plugins.map((plugin) => [plugin.name, plugin]));
if (byName.get("sites")?.category !== "safe-sites") {
  throw new Error("Sites metadata did not come from the accepted marketplace entry");
}
if (byName.get("visualize")?.category !== "safe-visualize") {
  throw new Error("Visualize metadata did not come from the accepted marketplace entry");
}
for (const [name, plugin] of byName) {
  if (plugin.source?.source !== "local" || plugin.source.path !== `./plugins/${name}`) {
    throw new Error(`unsafe rewritten source for ${name}`);
  }
}
NODE
}

test_browser_use_node_repl_glibc_pidfd_patch_static() {
    info "Checking Browser Use node_repl glibc pidfd patch scope"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "patch_browser_use_node_repl_glibc_pidfd_symbols"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "is_browser_use_node_repl_ldd_output_compatible"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "install_browser_use_node_repl_executable_resource"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "pidfd_spawnp"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "pidfd_getpid"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "GLIBC_2.39"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "GLIBC_2.34"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" "non-pidfd GLIBC_2.39 references remain"
    assert_contains "$REPO_DIR/scripts/lib/bundled-plugins.sh" 'ldd "$destination"'
}

test_browser_use_node_repl_ldd_output_compatibility() {
    info "Checking Browser Use node_repl ldd output compatibility gate"
    # shellcheck disable=SC1091
    source "$REPO_DIR/scripts/lib/bundled-plugins.sh"

    if is_browser_use_node_repl_ldd_output_compatible "/node_repl: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.39' not found (required by /node_repl)"; then
        fail "Expected ldd GLIBC version errors to be rejected"
    fi

    if is_browser_use_node_repl_ldd_output_compatible "libmissing.so => not found"; then
        fail "Expected unresolved ldd libraries to be rejected"
    fi

    is_browser_use_node_repl_ldd_output_compatible "libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6" \
        || fail "Expected ordinary ldd output to be accepted"
}

make_fake_chrome_upstream_app() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"
    local chrome_dir="$resources_dir/plugins/openai-bundled/plugins/chrome"

    mkdir -p \
        "$resources_dir/plugins/openai-bundled/.agents/plugins" \
        "$chrome_dir/.codex-plugin" \
        "$chrome_dir/skills/control-chrome" \
        "$chrome_dir/scripts"

    cat > "$resources_dir/plugins/openai-bundled/.agents/plugins/marketplace.json" <<'JSON'
{"plugins":[{"name":"chrome","source":{"source":"local","path":"./plugins/chrome"},"policy":{"installation":"AVAILABLE"}}]}
JSON
    cat > "$chrome_dir/.codex-plugin/plugin.json" <<'JSON'
{"name":"chrome","version":"0.1.7"}
JSON
    cat > "$chrome_dir/scripts/installManifest.mjs" <<'JS'
var n={extensionId:"hehggadaopoacecdllhhajmbjkdcmajg",extensionHostName:"com.openai.codexextension"};var p=o=>{let t=`${o.extensionHostName}.json`,r={darwin:["Library/Application Support/Google/Chrome/NativeMessagingHosts"],linux:[".config/google-chrome/NativeMessagingHosts"],win32:["AppData/Local/OpenAI/extension"]}[m.platform()];return r.map(s=>l.resolve(m.homedir(),s,t))};
JS
    cat > "$chrome_dir/skills/control-chrome/SKILL.md" <<'MD'
# Chrome

Use the browser bound to `browser` for tasks in this skill.
MD
    cat > "$chrome_dir/scripts/extension-id.json" <<'JSON'
{"extensionId":"hehggadaopoacecdllhhajmbjkdcmajg","extensionHostName":"com.openai.codexextension"}
JSON
    cat > "$chrome_dir/scripts/browser-client.mjs" <<'JS'
const browserPreference={};function preferredWindowIdFor(){}function getForUrl(){}const extensionInstanceId=null;
var Cb=kE(hV.platform()),EV=()=>_P()==="win32"?TV():CV(),CV=async()=>(await yP(Cb)).map(e=>wP.resolve(Cb,e)),TV=async()=>[];
function lu(e){let t=globalThis.nodeRepl?.env[e];return typeof t=="string"?t:void 0}
function Me(){let e=globalThis.nodeRepl;return e?.config==null?void 0:e}
import{platform as yT}from"node:os";function eh(){return"privileged native pipe bridge is not available; browser-client is not trusted"}function th(){let e=globalThis.nodeRepl?.nativePipe;return e==null||typeof e.createConnection!="function"?null:e}var ml=class e{constructor(t){this.socket=t}static async create(t){let r=th();if(r!=null){let n=await r.createConnection(t);return new e(n)}throw new Error(eh())}};
async fetchBlocked(e){let r=await bS(e.endpoint,{method:"GET"});if(!r.ok)throw new Error(ae(`Browser Use cannot determine if ${e.displayUrl} is allowed. Please try again later or use another source.`));let n=await r.json();return TF(n)}
JS
    cat > "$chrome_dir/scripts/check-native-host-manifest.js" <<'JS'
#!/usr/bin/env node
function getNativeHostManifestLocation() {
  if (process.platform === "win32") {
    const registryKey = `${WINDOWS_NATIVE_HOST_REGISTRY_KEY_PREFIX}\\${expectedHostName}`;
    const registryManifestPath = readWindowsRegistryDefaultValue(registryKey);

    return {
      manifestPath: registryManifestPath || getDefaultWindowsManifestPath(),
      registryKey,
      registryManifestPath,
      registryKeyExists: registryManifestPath != null,
    };
  }

  throw new Error(
    `Unsupported platform for native host manifest check: ${process.platform}. This script supports macOS and Windows.`,
  );
}
JS
    cat > "$chrome_dir/scripts/installed-browsers.js" <<'JS'
#!/usr/bin/env node
const KNOWN_BROWSERS = [
  {
    name: "Google Chrome",
    bundleIds: ["com.google.Chrome"],
    appNames: ["Google Chrome.app"],
    commands: ["google-chrome", "chrome"],
    windowsExecutable: "chrome.exe",
  },
];
JS
    cat > "$chrome_dir/scripts/chrome-is-running.js" <<'JS'
#!/usr/bin/env node
const CHROME_PROCESS_NAMES_BY_PLATFORM = {
  darwin: new Set(["Google Chrome", "Google Chrome Helper"]),
  win32: new Set(["chrome.exe"]),
};
JS
    cat > "$chrome_dir/scripts/check-extension-installed.js" <<'JS'
#!/usr/bin/env node
function resolveChromeUserDataDirectory() {
  return path.join(os.homedir(), ".config", "google-chrome");
}

function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;

  const latestProfile = findLatestChromeProfile(userDataDirectory);
  if (latestProfile) return latestProfile;

  throw new Error(`No Chrome profile found in ${userDataDirectory}`);
}

function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {
  return null;
}

function findLatestChromeProfile(userDataDirectory) {
  return "Default";
}

function isUsableChromeProfile(userDataDirectory, profileDirectory) {
  return profileDirectory.length > 0;
}
JS
    cat > "$chrome_dir/scripts/open-chrome-window.js" <<'JS'
#!/usr/bin/env node
function resolveChromeUserDataDirectory() {
  return path.join(os.homedir(), ".config", "google-chrome");
}

function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;

  const latestProfile = findLatestChromeProfile(userDataDirectory);
  if (latestProfile) return latestProfile;

  throw new Error(`No Chrome profile found in ${userDataDirectory}`);
}

function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {
  return null;
}

function findLatestChromeProfile(userDataDirectory) {
  return "Default";
}

function isUsableChromeProfile(userDataDirectory, profileDirectory) {
  return profileDirectory.length > 0;
}

function getOpenChromeCommand(profileDirectory) {
  const chromeArgs = [
    `--profile-directory=${profileDirectory}`,
    "--new-window",
    ABOUT_BLANK_URL,
  ];

  return {
    command: "google-chrome",
    args: chromeArgs,
  };
}
JS
}

test_chrome_plugin_staging() {
    info "Checking Chrome plugin staging"
    local workspace="$TMP_DIR/chrome-plugin"
    local app_dir="$workspace/Codex.app"
    local install_dir="$workspace/install"
    local output_log="$workspace/output.log"
    local chrome_dir="$install_dir/resources/plugins/openai-bundled/plugins/chrome"
    local host="$chrome_dir/extension-host/linux/x64/extension-host"

    mkdir -p "$workspace" "$install_dir/resources"
    make_fake_chrome_upstream_app "$app_dir"

    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        WORK_DIR="$workspace/work"
        ARCH="x86_64"
        ICON_SOURCE="$workspace/missing-icon.png"
        CODEX_APP_ID="codex-desktop"
        mkdir -p "$WORK_DIR"
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_linux_computer_use_plugin() { return 1; }
        build_chrome_extension_host() {
            local fake_host="$workspace/codex-chrome-extension-host"
            printf '#!/bin/sh\n' > "$fake_host"
            chmod +x "$fake_host"
            printf '%s\n' "$fake_host"
        }
        install_bundled_plugin_resources "$app_dir"
    ) >"$output_log" 2>&1

    assert_file_exists "$host"
    [ -x "$host" ] || fail "Expected Chrome extension host to be executable: $host"
    assert_mode "$chrome_dir/scripts/check-native-host-manifest.js" "755"
    assert_mode "$chrome_dir/scripts/installed-browsers.js" "755"
    assert_mode "$chrome_dir/scripts/chrome-is-running.js" "755"
    assert_mode "$chrome_dir/scripts/check-extension-installed.js" "755"
    assert_mode "$chrome_dir/scripts/open-chrome-window.js" "755"
    assert_contains "$chrome_dir/scripts/installManifest.mjs" "BraveSoftware/Brave-Browser/NativeMessagingHosts"
    assert_contains "$chrome_dir/scripts/installManifest.mjs" ".config/chromium/NativeMessagingHosts"
    assert_contains "$chrome_dir/scripts/installed-browsers.js" "Brave Browser"
    assert_contains "$chrome_dir/scripts/installed-browsers.js" "Chromium"
    assert_contains "$chrome_dir/scripts/chrome-is-running.js" "brave-browser"
    assert_contains "$chrome_dir/scripts/chrome-is-running.js" "chromium-browser"
    assert_contains "$chrome_dir/scripts/check-native-host-manifest.js" 'process.platform === "linux"'
    assert_contains "$chrome_dir/scripts/check-native-host-manifest.js" "BraveSoftware"
    assert_contains "$chrome_dir/scripts/check-native-host-manifest.js" "chromium"
    assert_contains "$chrome_dir/scripts/check-extension-installed.js" "linuxBraveUserDataDirectory"
    assert_contains "$chrome_dir/scripts/check-extension-installed.js" "linuxChromiumUserDataDirectory"
    assert_contains "$chrome_dir/scripts/check-extension-installed.js" "linuxCandidateWithInstalledExtension"
    assert_contains "$chrome_dir/scripts/check-extension-installed.js" "resolveChromeProfileDirectoryFromRunningProcess"
    assert_contains "$chrome_dir/scripts/check-extension-installed.js" "defaultLinuxUserDataDirectoryForCommand"
    assert_contains "$chrome_dir/scripts/open-chrome-window.js" "brave-browser"
    assert_contains "$chrome_dir/scripts/open-chrome-window.js" "chromium"
    assert_contains "$chrome_dir/scripts/open-chrome-window.js" "defaultBrowser ==="
    assert_contains "$chrome_dir/scripts/open-chrome-window.js" "resolveChromeProfileDirectoryFromRunningProcess"
    assert_contains "$chrome_dir/scripts/open-chrome-window.js" "defaultLinuxUserDataDirectoryForCommand"
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "browserPreference"
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "preferredWindowIdFor"
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "getForUrl"
    assert_contains "$chrome_dir/scripts/browser-client.mjs" 'globalThis.nodeRepl?.env?.\[e\]'
    assert_not_contains "$chrome_dir/scripts/browser-client.mjs" 'globalThis.nodeRepl?.env\[e\]'
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "codexLinuxBrowserUseConfigShim"
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "writeValue: codexLinuxBrowserUseIgnoreConfigWrite"
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "batchWrite: codexLinuxBrowserUseIgnoreConfigWrite"
    assert_not_contains "$chrome_dir/scripts/browser-client.mjs" "writeFile"
    assert_not_contains "$chrome_dir/scripts/browser-client.mjs" "codexLinuxBrowserUseStringifyToml"
    assert_contains "$chrome_dir/scripts/browser-client.mjs" 'Object.getPrototypeOf(repl)'
    assert_contains "$chrome_dir/scripts/browser-client.mjs" 'Object.defineProperty(prototype, "config"'
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "codexLinuxBrowserUseConfigShim();let e=globalThis.nodeRepl"
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "nativePipe??import.meta.__codexNativePipe"
    assert_not_contains "$chrome_dir/scripts/browser-client.mjs" "codexLinuxNativePipeFallback"
    assert_not_contains "$chrome_dir/scripts/browser-client.mjs" 'await import("node:net")'
    assert_contains "$chrome_dir/scripts/browser-client.mjs" "codexLinuxSiteStatusAllowlistFallback"
    assert_not_contains "$chrome_dir/scripts/browser-client.mjs" "codexLinuxIabSocketScope"
    assert_contains "$chrome_dir/skills/control-chrome/SKILL.md" "agent.browsers.list()"
    assert_contains "$chrome_dir/skills/control-chrome/SKILL.md" "browser.tabs.new()"
    assert_contains "$install_dir/resources/plugins/openai-bundled/.agents/plugins/marketplace.json" '"name": "chrome"'
    [ -z "$(find "$install_dir/resources/plugins/openai-bundled" -perm /022 -print -quit)" ] \
        || fail "Expected staged bundled plugin resources to reject group/other writes"
    assert_contains "$output_log" "Chrome plugin staged from upstream DMG"
}

test_chrome_marketplace_fallback_synthesis() {
    info "Checking Chrome marketplace fallback synthesis when upstream omits chrome"
    local workspace="$TMP_DIR/chrome-marketplace-fallback"
    local app_dir="$workspace/Codex.app"
    local install_dir="$workspace/install"
    local output_log="$workspace/output.log"
    local marketplace="$install_dir/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"

    mkdir -p "$workspace" "$install_dir/resources"
    make_fake_chrome_upstream_app "$app_dir"

    # Upstream marketplace.json lists no chrome entry — exercises the
    # synthesized-fallback path in write_bundled_plugins_marketplace.
    cat > "$app_dir/Contents/Resources/plugins/openai-bundled/.agents/plugins/marketplace.json" <<'JSON'
{"plugins":[{"name":"browser","source":{"source":"local","path":"./plugins/browser"},"policy":{"installation":"AVAILABLE"}}]}
JSON

    # Distinctive name + category prove the synthesized entry actually
    # reads the staged plugin.json rather than reusing hardcoded values.
    cat > "$app_dir/Contents/Resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json" <<'JSON'
{"name":"chrome-fallback-test","version":"9.9.9","interface":{"category":"FallbackCategory"}}
JSON

    (
        SCRIPT_DIR="$REPO_DIR"
        INSTALL_DIR="$install_dir"
        WORK_DIR="$workspace/work"
        ARCH="x86_64"
        ICON_SOURCE="$workspace/missing-icon.png"
        CODEX_APP_ID="codex-desktop"
        mkdir -p "$WORK_DIR"
        warn() { echo "[WARN] $*" >&2; }
        info() { echo "[INFO] $*" >&2; }
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/bundled-plugins.sh"
        stage_linux_computer_use_plugin() { return 1; }
        build_chrome_extension_host() {
            local fake_host="$workspace/codex-chrome-extension-host"
            printf '#!/bin/sh\n' > "$fake_host"
            chmod +x "$fake_host"
            printf '%s\n' "$fake_host"
        }
        install_bundled_plugin_resources "$app_dir"
    ) >"$output_log" 2>&1

    assert_file_exists "$marketplace"
    assert_contains "$marketplace" '"name": "chrome-fallback-test"'
    assert_contains "$marketplace" '"category": "FallbackCategory"'
    assert_contains "$marketplace" '"path": "./plugins/chrome"'
    assert_contains "$marketplace" '"installation": "AVAILABLE"'
    assert_contains "$marketplace" '"authentication": "ON_INSTALL"'
    assert_not_contains "$marketplace" "Bundled marketplace does not contain chrome plugin"
}

test_chrome_native_host_manifest_writer() {
    info "Checking Chrome native host manifest writer"
    local workspace="$TMP_DIR/chrome-native-host-manifest"
    local plugin_dir="$workspace/plugin"
    local home_dir="$workspace/home"
    local app_dir="$workspace/app"
    local host_path="$workspace/extension-host"
    local manifest_path

    mkdir -p "$plugin_dir/scripts" "$home_dir" "$app_dir/.codex-linux" "$(dirname "$host_path")"
    printf '#!/bin/sh\n' > "$host_path"
    chmod +x "$host_path"
    cat > "$plugin_dir/scripts/extension-id.json" <<'JSON'
{"extensionId":"abcdefghijklmnopabcdefghijklmnop","extensionHostName":"com.example.codextest"}
JSON
    printf '%s\n' ".config/example-browser/NativeMessagingHosts" > "$app_dir/.codex-linux/chrome-native-host-manifest-paths"

    python3 - "$REPO_DIR/launcher/start.sh.template" "$host_path" "$home_dir" "$plugin_dir" "$app_dir" <<'PY'
import subprocess
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text(encoding="utf-8")
marker = "python3 - \"$host_path\" \"$HOME\" \"$plugin_dir\" \"$SCRIPT_DIR\" <<'PY'\n"
start = source.index(marker) + len(marker)
end = source.index("\nPY\n", start)
script = source[start:end]
subprocess.run(
    ["python3", "-", sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]],
    input=script,
    text=True,
    check=True,
)
PY

    for relative in \
        ".config/google-chrome/NativeMessagingHosts" \
        ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
        ".config/chromium/NativeMessagingHosts" \
        ".config/example-browser/NativeMessagingHosts"; do
        manifest_path="$home_dir/$relative/com.example.codextest.json"
        assert_file_exists "$manifest_path"
        assert_contains "$manifest_path" "com.example.codextest"
        assert_contains "$manifest_path" "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        assert_contains "$manifest_path" "$host_path"
    done
}

make_fake_extracted_asar() {
    local root="$1"
    local bundle_body="$2"
    local settings_body="${3:-}"
    local index_body="${4:-}"

    mkdir -p "$root/webview/assets" "$root/.vite/build"
    printf 'png' > "$root/webview/assets/app-test.png"
    printf 'export{s as t};\n' > "$root/webview/assets/chunk-test.js"
    printf 'import{t as e}from"./chunk-test.js";Symbol.for(`react.transitional.element`);export{e as t};\n' > "$root/webview/assets/react-test.js"
    printf 'import{t as e}from"./chunk-test.js";Symbol.for(`react.transitional.element`);export{e as t};\n' > "$root/webview/assets/jsx-runtime-test.js"
    printf 'async function send(e,t,n,r,i){return fetch(`vscode://codex/${e}`)}function request(...e){let[t,n]=e,{params:r,select:i,signal:a,source:o}=n??{};return send(t,r,i,a,o)}export{request as l};\n' > "$root/webview/assets/setting-storage-test.js"
    cat > "$root/webview/assets/app-server-manager-signals-test.js" <<'JS'
function j(e){return e}function B(e){if(e==null||typeof e==`string`)return null;let t=Mi(e);return t==null?null:Ni(t)}function Mi(e){return`subAgent`in e?e.subAgent:null}function Ni(e){return typeof e==`string`?Pi():`thread_spawn`in e?{parentThreadId:j(e.thread_spawn.parent_thread_id),depth:e.thread_spawn.depth,agentNickname:e.thread_spawn.agent_nickname,agentRole:e.thread_spawn.agent_role}:Pi()}function Pi(){return{parentThreadId:null,depth:null,agentNickname:null,agentRole:null}}function Xl(e){return e==null?null:Zl(e.agentNickname)??Zl(B(e.source)?.agentNickname)}function Zl(e){if(e==null)return null;let t=e.trim();return t.length===0?null:t}
JS
    printf 'let marker=`hotkey-window-hotkey-state`;function i(){}export{i};\n' > "$root/webview/assets/general-settings-hotkey-test.js"
    printf 'function t(){}export{t};\n' > "$root/webview/assets/toggle-test.js"
    printf 'function n(){}export{n};\n' > "$root/webview/assets/settings-row-test.js"
    printf 'function r(){}function n(){}function t(){}export{r,n,t};\n' > "$root/webview/assets/settings-content-layout-test.js"
    if [ -n "$settings_body" ]; then
        printf '%s\n' "$settings_body" > "$root/webview/assets/general-settings-test.js"
    fi
    if [ -n "$index_body" ]; then
        printf '%s\n' "$index_body" > "$root/webview/assets/index-test.js"
    fi
    cat > "$root/package.json" <<'JSON'
{}
JSON
    printf '%s\n' "$bundle_body" > "$root/.vite/build/main-test.js"
}

test_linux_file_manager_patch_smoke() {
    info "Checking Linux file manager patch behavior"
    local workspace="$TMP_DIR/file-manager-patch"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    make_fake_extracted_asar "$extracted" 'let D={removeMenu(){},setMenuBarVisibility(){},setIcon(){},once(){}};let n=require(`electron`),t=require(`node:path`),a=require(`node:fs`);...process.platform===`win32`?{autoHideMenuBar:!0}:{},process.platform===`win32`&&D.removeMenu(),foo)}),D.once(`ready-to-show`,()=>{var sa=Mi({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>ai(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:ca,args:e=>ai(e),open:async({path:e})=>la(e)}});function ca(){let e=1;return e}async function la(e){let t=ua(e);if(t&&(0,a.statSync)(t).isFile()){n.shell.showItemInFolder(t);return}let r=t??e,i=await n.shell.openPath(r);if(i)throw Error(i)}function ua(e){return e}var Ua=Mi({id:`systemDefault`,label:`System Default App`,icon:`apps/file-explorer.png`,kind:`systemDefault`,hidden:!0,darwin:{icon:`apps/finder.png`,detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},win32:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},linux:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)}});async function Wa(e){return e}'

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$extracted/.vite/build/main-test.js" 'detect:()=>`linux-file-manager`'
    assert_contains "$extracted/.vite/build/main-test.js" 'linux:{label:`File Manager`'
    assert_contains "$extracted/.vite/build/main-test.js" 'process.platform===`linux`&&D.removeMenu(),process.platform===`win32`&&D.removeMenu(),'
    assert_not_contains "$extracted/.vite/build/main-test.js" 'D.setMenuBarVisibility(!1)'
    assert_contains "$extracted/.vite/build/main-test.js" '&&D.setIcon('
    assert_contains "$extracted/webview/assets/app-server-manager-signals-test.js" '`subAgent`in e?e.subAgent:`subagent`in e?e.subagent:null'
    assert_contains "$extracted/webview/assets/app-server-manager-signals-test.js" 'Zl(e.agentNickname)??Zl(e.agent_nickname)??Zl(B(e.source)?.agentNickname)'
    assert_not_contains "$output_log" 'Failed to apply Linux File Manager Patch'

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_occurrence_count "$extracted/webview/assets/app-server-manager-signals-test.js" '`subagent`in e?e.subagent' '1'
    assert_occurrence_count "$extracted/webview/assets/app-server-manager-signals-test.js" 'Zl(e.agent_nickname)' '1'
    assert_not_contains "$output_log" 'Failed to apply Linux File Manager Patch'
}

test_linux_translucent_sidebar_default_patch_smoke() {
    info "Checking Linux translucent sidebar default patch behavior"
    local workspace="$TMP_DIR/translucent-sidebar-patch"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    make_fake_extracted_asar \
        "$extracted" \
        'let D={removeMenu(){},setMenuBarVisibility(){},setIcon(){},once(){}};let n=require(`electron`),t=require(`node:path`),a=require(`node:fs`);...process.platform===`win32`?{autoHideMenuBar:!0}:{},process.platform===`win32`&&D.removeMenu(),foo)}),D.once(`ready-to-show`,()=>{var sa=Mi({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>ai(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:ca,args:e=>ai(e),open:async({path:e})=>la(e)}});function ca(){let e=1;return e}async function la(e){let t=ua(e);if(t&&(0,a.statSync)(t).isFile()){n.shell.showItemInFolder(t);return}let r=t??e,i=await n.shell.openPath(r);if(i)throw Error(i)}function ua(e){return e}var Ua=Mi({id:`systemDefault`,label:`System Default App`,icon:`apps/file-explorer.png`,kind:`systemDefault`,hidden:!0,darwin:{icon:`apps/finder.png`,detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},win32:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},linux:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)}});async function Wa(e){return e}' \
        'function settings(){let{canImportThemeString:u,setThemePatch:b,theme:x}=p(t),S=vn(r,t),k=[{label:i}],A=[];return x.opaqueWindows}' \
        ''

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$extracted/webview/assets/general-settings-test.js" 'navigator.userAgent.includes(`Linux`)&&x?.opaqueWindows==null&&(x={...x,opaqueWindows:!0})'
    assert_occurrence_count "$extracted/webview/assets/general-settings-test.js" 'navigator.userAgent.includes(`Linux`)' '1'
    assert_not_contains "$output_log" 'Could not find Linux opaque window default insertion point'

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_occurrence_count "$extracted/webview/assets/general-settings-test.js" 'navigator.userAgent.includes(`Linux`)' '1'
    assert_not_contains "$output_log" 'Could not find Linux opaque window default insertion point'
}

test_linux_tray_patch_smoke() {
    info "Checking Linux tray patch behavior"
    local workspace="$TMP_DIR/tray-patch"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"
    local bundle_body

    mkdir -p "$workspace"
    bundle_body="$(cat <<'JS'
let D={removeMenu(){},setMenuBarVisibility(){},setIcon(){},once(){}};
const x={o:e=>e};let s=require(`node:url`),n=require(`electron`);n=x.o(n);let l=require(`node:os`);l=x.o(l);let i=require(`node:path`);i=x.o(i);let d=require(`node:util`),q=require(`node:crypto`),a=require(`node:fs`);a=x.o(a);
let t={join(){},C:{Prod:`prod`},A(){}};
let k={hide(){},isDestroyed(){return false}};
let f=`local`;
...process.platform===`win32`?{autoHideMenuBar:!0}:{},process.platform===`win32`&&D.removeMenu(),foo)}),D.once(`ready-to-show`,()=>{
var sa=Mi({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>ai(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:ca,args:e=>ai(e),open:async({path:e})=>la(e)}});
function ca(){let e=1;return e}
async function la(e){let t=ua(e);if(t&&(0,a.statSync)(t).isFile()){n.shell.showItemInFolder(t);return}let r=t??e,i=await n.shell.openPath(r);if(i)throw Error(i)}
function ua(e){return e}
var Ua=Mi({id:`systemDefault`,label:`System Default App`,icon:`apps/file-explorer.png`,kind:`systemDefault`,hidden:!0,darwin:{icon:`apps/finder.png`,detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},win32:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},linux:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)}});
async function Wa(e){return e}
async function Hw(e){return process.platform!==`win32`&&process.platform!==`darwin`?null:(zw=!0,Lw??Rw??(Rw=(async()=>{let r=await Ww(e.buildFlavor,e.appBrand,e.repoRoot),i=new n.Tray(r.defaultIcon);return i})()))}
async function Ww(e,t,i){if(process.platform===`darwin`){return null}let r=K9(e,t,i);return r==null?{defaultIcon:await n.app.getFileIcon(process.execPath,{size:`small`}),chronicleRunningIcon:null}:{defaultIcon:r,chronicleRunningIcon:null}}
function K9(e,t,r){let a=[(0,i.join)(r,`electron`,`src`,`icons`,`tray.png`)];for(let e of a){let t=n.nativeImage.createFromPath(e);if(!t.isEmpty())return t}return null}
var pb=class{nativeTrayClickSuppressionReason=null;clearNativeTrayClickSuppressionTimeout=null;chronicleTrayIconRefreshInterval=null;chronicleTrayIconState=`default`;isNativeTrayMenuOpen=!1;trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(){this.tray={on(){},setContextMenu(){},popUpContextMenu(){}};this.onTrayButtonClick=()=>{};this.tray.on(`click`,()=>{this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}async handleMessage(e){switch(e.type){case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads;return}}openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}updateChronicleTrayIcon(){}getNativeTrayMenuItems(){return[]}}
v&&k.on(`close`,e=>{this.persistPrimaryWindowBounds(k);let t=this.getPrimaryWindows().some(e=>e!==k);if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}if(process.platform===`darwin`&&!this.isAppQuitting&&!t){e.preventDefault(),k.hide()}});
let E=process.platform===`win32`;
let oe=async()=>{O=!0;try{await Hw({appBrand:a.U(),buildFlavor:b,repoRoot:j.repoRoot})}catch(e){O=!1}};
let se=async e=>{};
E&&oe();let ce=Hr({});
JS
)"
    make_fake_extracted_asar "$extracted" "$bundle_body"

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$extracted/.vite/build/main-test.js" 'process.platform!==`win32`&&process.platform!==`darwin`&&process.platform!==`linux`?null:'
    assert_contains "$extracted/.vite/build/main-test.js" 'nativeImage.createFromPath(process.resourcesPath+`/../content/webview/assets/app-test.png`)'
    assert_contains "$extracted/.vite/build/main-test.js" '(process.platform===`win32`||process.platform===`linux`)&&!this.isAppQuitting'
    assert_contains "$extracted/.vite/build/main-test.js" '!this.isAppQuitting&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())'
    assert_contains "$extracted/.vite/build/main-test.js" 'setLinuxTrayContextMenu(){let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems())'
    assert_contains "$extracted/.vite/build/main-test.js" 'process.platform===`linux`&&(codexLinuxSetTrayController(this),this.setLinuxTrayContextMenu()),this.tray.on(`click`'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxTrayRecoveryHandler=()=>{let e=codexLinuxTrayController;e?.setLinuxTrayContextMenu?.()}'
    assert_contains "$extracted/.vite/build/main-test.js" 'process.platform===`linux`?this.openNativeTrayMenu():this.onTrayButtonClick()'
    assert_contains "$extracted/.vite/build/main-test.js" 'openNativeTrayMenu(){if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()))return;'
    assert_contains "$extracted/.vite/build/main-test.js" 'let e=process.platform===`linux`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():n.Menu.buildFromTemplate'
    assert_contains "$extracted/.vite/build/main-test.js" 'if(process.platform===`linux`)return;e.once(`menu-will-show`'
    assert_contains "$extracted/.vite/build/main-test.js" 'this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.setLinuxTrayContextMenu?.()'
    assert_contains "$extracted/.vite/build/main-test.js" '(E||process.platform===`linux`&&(typeof codexLinuxIsTrayEnabled!==`function`||codexLinuxIsTrayEnabled()))&&oe();'
    assert_not_contains "$extracted/.vite/build/main-test.js" 'process.platform===`linux`&&this.tray.setContextMenu?.(e),this.tray.popUpContextMenu(e)'
    assert_not_contains "$output_log" 'WARN: Could not find tray'

    node - "$extracted/.vite/build/main-test.js" <<'NODE'
const fs = require("fs");

const source = fs.readFileSync(process.argv[2], "utf8");
const closeSnippet = source.match(/v&&k\.on\(`close`,e=>\{.*?\}\);/)?.[0];
if (!closeSnippet) {
  throw new Error("Could not extract patched Linux close handler");
}

function registerCloseHandler({ quitInProgress = false, isAppQuitting = false, trayEnabled = true } = {}) {
  const state = { hideCalls: 0 };
  const controller = {
    isAppQuitting,
    options: { canHideLastWindowToTray: () => trayEnabled },
    persistPrimaryWindowBounds() {},
    getPrimaryWindows() {
      return [];
    },
  };
  const factory = new Function(
    "process",
    "codexLinuxIsQuitInProgress",
    "state",
    `return function(){const v=true;const f=\`local\`;const k={handlers:{},on(event,handler){this.handlers[event]=handler},hide(){state.hideCalls+=1}};${closeSnippet};return k.handlers.close;};`,
  );
  const makeHandler = factory({ platform: "linux" }, () => quitInProgress, state);
  const handler = makeHandler.call(controller);
  return { handler, state };
}

function runCloseWithoutHelper({ trayEnabled = true, isAppQuitting = false } = {}) {
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  const state = { hideCalls: 0 };
  const controller = {
    isAppQuitting,
    options: { canHideLastWindowToTray: () => trayEnabled },
    persistPrimaryWindowBounds() {},
    getPrimaryWindows() {
      return [];
    },
  };
  const factory = new Function(
    "process",
    "state",
    `return function(){const v=true;const f=\`local\`;const k={handlers:{},on(event,handler){this.handlers[event]=handler},hide(){state.hideCalls+=1}};${closeSnippet};return k.handlers.close;};`,
  );
  const handler = factory({ platform: "linux" }, state).call(controller);
  handler(event);
  return { event, state };
}

function runClose(options) {
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  const { handler, state } = registerCloseHandler(options);
  handler(event);
  return { event, state };
}

let result = runClose({ trayEnabled: true, quitInProgress: false, isAppQuitting: false });
if (!result.event.prevented || result.state.hideCalls !== 1) {
  throw new Error("normal Linux close should still hide to tray");
}

result = runClose({ trayEnabled: true, quitInProgress: true, isAppQuitting: false });
if (result.event.prevented || result.state.hideCalls !== 0) {
  throw new Error("quit-in-progress Linux close should not hide to tray");
}

result = runClose({ trayEnabled: true, quitInProgress: false, isAppQuitting: true });
if (result.event.prevented || result.state.hideCalls !== 0) {
  throw new Error("app.quit close should not hide to tray when upstream quit flag is already set");
}

result = runCloseWithoutHelper({ trayEnabled: true, isAppQuitting: false });
if (!result.event.prevented || result.state.hideCalls !== 1) {
  throw new Error("Linux close should still hide to tray when the quit helper is unavailable");
}
NODE

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'process.platform!==`win32`&&process.platform!==`darwin`&&process.platform!==`linux`?null:' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'nativeImage.createFromPath(process.resourcesPath' '3'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'nativeImage.createFromPath(process.resourcesPath+`/../.codex-linux/codex-desktop-tray.png`)' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'nativeImage.createFromPath(process.resourcesPath+`/../.codex-linux/codex-desktop.png`)' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'nativeImage.createFromPath(process.resourcesPath+`/../content/webview/assets/app-test.png`)' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'process.platform===`linux`)&&!this.isAppQuitting' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'setLinuxTrayContextMenu(){' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'process.platform===`linux`&&(codexLinuxSetTrayController(this),this.setLinuxTrayContextMenu()),this.tray.on(`click`' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'process.platform===`linux`?this.openNativeTrayMenu():this.onTrayButtonClick()' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()' '3'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'openNativeTrayMenu(){if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()))return;' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'let e=process.platform===`linux`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():n.Menu.buildFromTemplate' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'if(process.platform===`linux`)return;e.once(`menu-will-show`' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'process.platform===`linux`&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.setLinuxTrayContextMenu?.()' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'process.platform===`linux`&&(typeof codexLinuxIsTrayEnabled!==`function`||codexLinuxIsTrayEnabled()))&&oe' '1'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxRegisterTray=e=>(codexLinuxTray=e,e)'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxDestroyTray=()=>{if(process.platform!==`linux`)return;'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0,codexLinuxDestroyTray()}'
    assert_contains "$extracted/.vite/build/main-test.js" 'n.app.on(`before-quit`,()=>codexLinuxDestroyTray())'
    assert_contains "$extracted/.vite/build/main-test.js" 'i=typeof codexLinuxRegisterTray===`function`?codexLinuxRegisterTray(new n.Tray(r.defaultIcon)):new n.Tray(r.defaultIcon)'
    assert_not_contains "$extracted/.vite/build/main-test.js" 'codexLinuxTrayQuitDelayMs'
}

test_linux_explicit_quit_patch_smoke() {
    info "Checking Linux explicit quit patch behavior"
    local workspace="$TMP_DIR/explicit-quit-patch"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"
    local bundle_body

    mkdir -p "$workspace"
    bundle_body="$(cat <<'JS'
const x={o:e=>e};let s=require(`node:url`),n=require(`electron`);n=x.o(n);let l=require(`node:os`);l=x.o(l);let i=require(`node:path`);i=x.o(i);let d=require(`node:util`),q=require(`node:crypto`),a=require(`node:fs`);a=x.o(a);
var pb=class{getNativeTrayMenuItems(){return[{label:rB(this.appName),click:()=>{n.app.quit()}}]}};
function qB(r,o){if(o.type===`quit-app`){n.app.quit();return}return o}
n.app.on(`before-quit`,o=>{let s=BI(),c=t.sr().some(e=>e.status===`ACTIVE`);if(e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}let l=n.app.getName();if(n.dialog.showMessageBoxSync({type:`warning`,buttons:[`Quit`,`Cancel`],defaultId:0,cancelId:1,noLink:!0,title:`Quit ${l}?`,message:`Quit ${l}?`,detail:vB({hasInProgressLocalConversation:s,hasEnabledAutomations:c})})!==0){o.preventDefault();return}i.markQuitApproved(),g=!0,a.markAppQuitting()});
n.app.on(`will-quit`,e=>{if(g=!0,!h){if(i.shouldSkipDrainBeforeQuit()){mB({hotkeyWindowLifecycleManager:c,globalDictationLifecycleManager:l,flushAndDisposeContexts:d,disposables:f});return}e.preventDefault(),h=!0,c.dispose(),l.dispose(),Promise.all([u.flush(),p.flush()]).finally(()=>{d(),f.dispose(),n.app.quit()})}});
JS
)"
    make_fake_extracted_asar "$extracted" "$bundle_body"

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress()}'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxShouldBypassQuitPrompt=()=>codexLinuxExplicitQuitApproved===!0'
    assert_contains "$extracted/.vite/build/main-test.js" '{label:rB(this.appName),click:()=>{typeof codexLinuxPrepareForExplicitQuit===`function`?codexLinuxPrepareForExplicitQuit():typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),n.app.quit()}}'
    assert_contains "$extracted/.vite/build/main-test.js" 'if(o.type===`quit-app`){typeof codexLinuxPrepareForExplicitQuit===`function`?codexLinuxPrepareForExplicitQuit():typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),n.app.quit();return}'
    assert_contains "$extracted/.vite/build/main-test.js" 'if((typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt())||e||i.canQuitWithoutPrompt()||r||!s&&!c){process.platform===`linux`&&typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),g=!0,a.markAppQuitting();return}'
    assert_contains "$extracted/.vite/build/main-test.js" 'process.platform===`linux`&&typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),i.markQuitApproved(),g=!0,a.markAppQuitting()'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxFinalizeQuit=()=>{d(),f.dispose(),n.app.quit()},codexLinuxDrainPromise=Promise.all('
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxExplicitQuitDrainTimeoutMs'
    assert_contains "$extracted/.vite/build/main-test.js" 'setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs'
    assert_not_contains "$extracted/.vite/build/main-test.js" '\`number\`'
    assert_not_contains "$output_log" 'WARN: Could not find tray quit menu handler'
    assert_not_contains "$output_log" 'WARN: Could not find quit-app IPC handler'
    assert_not_contains "$output_log" 'WARN: Could not find before-quit confirmation guard'
    assert_not_contains "$output_log" 'WARN: Could not find will-quit drain sequence'

    node - "$extracted/.vite/build/main-test.js" <<'NODE'
const fs = require("fs");

const source = fs.readFileSync(process.argv[2], "utf8");
const helperStart = source.indexOf("let codexLinuxTray=null");
const helperEnd = source.indexOf(";n.app.on(`before-quit`,()=>codexLinuxDestroyTray())", helperStart) + 1;
const helperSnippet = helperStart === -1 || helperEnd === 0 ? null : source.slice(helperStart, helperEnd);
const traySnippet = source.match(/\{label:rB\(this\.appName\),click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),n\.app\.quit\(\)\}\}/)?.[0];
const quitAppSnippet = source.match(/if\(o\.type===`quit-app`\)\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),n\.app\.quit\(\);return\}/)?.[0];
const beforeQuitSnippet = source.match(/if\(\(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt\(\)\)\|\|e\|\|i\.canQuitWithoutPrompt\(\)\|\|r\|\|!s&&!c\)\{process\.platform===`linux`&&typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),g=!0,a\.markAppQuitting\(\);return\}/)?.[0];
if (!helperSnippet || !traySnippet || !quitAppSnippet || !beforeQuitSnippet) {
  throw new Error("Could not extract explicit quit snippets");
}

function runTrayQuit({ withHelper = true } = {}) {
  const state = { markCalls: 0, prepareCalls: 0, quitCalls: 0 };
  const app = { quit() { state.quitCalls += 1; } };
  const mark = () => { state.markCalls += 1; };
  const prepare = withHelper ? () => { state.prepareCalls += 1; mark(); } : undefined;
  const factory = new Function(
    "n",
    "rB",
    "codexLinuxPrepareForExplicitQuit",
    "codexLinuxMarkQuitInProgress",
    `return (${traySnippet}).click;`,
  );
  const click = factory({ app }, () => "Quit", prepare, mark);
  click();
  return state;
}

function runQuitApp({ withHelper = true } = {}) {
  const state = { markCalls: 0, prepareCalls: 0, quitCalls: 0 };
  const app = { quit() { state.quitCalls += 1; } };
  const mark = () => { state.markCalls += 1; };
  const prepare = withHelper ? () => { state.prepareCalls += 1; mark(); } : undefined;
  const handler = new Function(
    "n",
    "codexLinuxPrepareForExplicitQuit",
    "codexLinuxMarkQuitInProgress",
    "o",
    `${quitAppSnippet};return null;`,
  );
  handler({ app }, prepare, mark, { type: "quit-app" });
  return state;
}

function runBeforeQuitBypass() {
  const state = { markCalls: 0 };
  const scope = new Function(
    "BI",
    "t",
    `${helperSnippet}return {runBeforeQuitCheck(e,i,r,a){let s=BI(),c=t.sr().some(e=>e.status===\`ACTIVE\`);${beforeQuitSnippet}return \`prompt\`;},prepare:codexLinuxPrepareForExplicitQuit,bypass:codexLinuxShouldBypassQuitPrompt,marked:codexLinuxIsQuitInProgress};`,
  )(
    () => true,
    { sr: () => [{ status: "ACTIVE" }] },
  );
  const controller = {
    canQuitWithoutPrompt() { return false; },
    markQuitApproved() {},
  };
  const appQuitting = { markAppQuitting() { state.markCalls += 1; } };
  scope.prepare();
  const bypassed = scope.runBeforeQuitCheck(false, controller, false, appQuitting);
  return { state, bypassed, shouldBypass: scope.bypass(), marked: scope.marked() };
}

let state = runTrayQuit();
if (state.prepareCalls !== 1 || state.markCalls !== 1 || state.quitCalls !== 1) {
  throw new Error("tray quit should prepare explicit quit before quitting");
}

state = runQuitApp();
if (state.prepareCalls !== 1 || state.markCalls !== 1 || state.quitCalls !== 1) {
  throw new Error("quit-app IPC should prepare explicit quit before quitting");
}

state = runTrayQuit({ withHelper: false });
if (state.prepareCalls !== 0 || state.markCalls !== 1 || state.quitCalls !== 1) {
  throw new Error("tray quit should still fall back to the quit-in-progress marker");
}

state = runQuitApp({ withHelper: false });
if (state.prepareCalls !== 0 || state.markCalls !== 1 || state.quitCalls !== 1) {
  throw new Error("quit-app IPC should still fall back to the quit-in-progress marker");
}

state = runBeforeQuitBypass();
if (!state.shouldBypass || state.bypassed !== undefined || state.state.markCalls !== 1 || !state.marked) {
  throw new Error("before-quit should bypass the Linux quit confirmation after an explicit quit");
}
NODE

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress()}' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxShouldBypassQuitPrompt=()=>codexLinuxExplicitQuitApproved===!0' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'typeof codexLinuxPrepareForExplicitQuit===`function`?codexLinuxPrepareForExplicitQuit():typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress()' '2'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt()' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxDrainPromise=Promise.all(' '1'
}

test_keybinds_settings_tab_patch_smoke() {
    info "Checking Linux desktop settings tab patch behavior"
    local workspace="$TMP_DIR/keybinds-settings-patch"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    make_fake_extracted_asar "$extracted" 'let D={removeMenu(){},setMenuBarVisibility(){},setIcon(){},once(){}};let t={join(){}};let a={existsSync(){return true},statSync(){return {isFile(){return false}}}};let n={shell:{openPath(){return ""},showItemInFolder(){}}};...process.platform===`win32`?{autoHideMenuBar:!0}:{},process.platform===`win32`&&D.removeMenu(),foo)}),D.once(`ready-to-show`,()=>{var sa=Mi({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>ai(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:ca,args:e=>ai(e),open:async({path:e})=>la(e)}});function ca(){let e=1;return e}async function la(e){let t=ua(e);if(t&&(0,a.statSync)(t).isFile()){n.shell.showItemInFolder(t);return}let r=t??e,i=await n.shell.openPath(r);if(i)throw Error(i)}function ua(e){return e}var Ua=Mi({id:`systemDefault`,label:`System Default App`,icon:`apps/file-explorer.png`,kind:`systemDefault`,hidden:!0,darwin:{icon:`apps/finder.png`,detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},win32:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},linux:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)}});async function Wa(e){return e}'

    cat > "$extracted/webview/assets/settings-sections-test.js" <<'JS'
var e=[`general-settings`,`profile`,`keyboard-shortcuts`,`account`],t=`general-settings`,n=function(){},r=[{slug:`general-settings`},{slug:`profile`},{slug:`appearance`},{slug:`keyboard-shortcuts`}];
JS
    cat > "$extracted/webview/assets/settings-shared-test.js" <<'JS'
import{t as d}from"./jsx-runtime-test.js";var c={"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},"keyboard-shortcuts":{id:`settings.nav.keyboard-shortcuts`,defaultMessage:`Keyboard shortcuts`,description:`Title for keyboard shortcuts settings section`}};function m(e){let t=(0,u.c)(17),{slug:r}=e;switch(r){case`keyboard-shortcuts`:{let e;return t[1]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,d.jsx)(n,{id:`settings.section.keyboard-shortcuts`,defaultMessage:`Keyboard shortcuts`,description:`Title for keyboard shortcuts settings section`}),t[1]=e):e=t[1],e}case`general-settings`:{let e;return t[2]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,d.jsx)(n,{id:`settings.section.general-settings`,defaultMessage:`General`,description:`Title for general settings section`}),t[2]=e):e=t[2],e}}}
JS
    cat > "$extracted/webview/assets/index-test.js" <<'JS'
import{n as routeModule,s as routeToESM}from"./rolldown-runtime-test.js";import{I as routeJsxFactory,R as routeReactFactory}from"./shared-runtime-test.js";function Z(e){let r=(0,RouteReact.lazy)(e);function SettingsRouteWrapper(){let t=(0,RouteReact.useState)(null);return (0,RouteJsx.jsx)(r,{children:t})}return SettingsRouteWrapper}var RouteReact,RouteJsx;routeModule(()=>{RouteReact=routeToESM(routeReactFactory(),1),RouteJsx=routeJsxFactory()})();var Xge={"general-settings":xh,"keyboard-shortcuts":ks,appearance:Pf,agent:gU},H7={},Zge=[`general-settings`,`profile`,`keyboard-shortcuts`,`appearance`,`agent`,`personalization`,`mcp-settings`,`connections`,`git-settings`,`local-environments`,`worktrees`,`browser-use`,`computer-use`,`data-controls`],Qge=[{key:`app`,heading:H7.appHeading,slugs:[`general-settings`,`profile`,`keyboard-shortcuts`,`appearance`,`connections`,`git-settings`,`usage`]}];function n_e(){let e=e=>{switch(e.slug){case`general-settings`:case`agent`:case`personalization`:return!0;case`keyboard-shortcuts`:return!0}};if(O)bb0:switch(D.slug){case`usage`:k=g;break bb0;case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`account`:case`data-controls`:case`personalization`:k=!1;break bb0;case`keyboard-shortcuts`:k=!1;break bb0;}}function s_e(e){let{slug:n}=e,r=c_e[n];return (0,$.jsx)(r,{})}var c_e={"general-settings":Z(async()=>(await s(async()=>{let{GeneralSettings:e}=await import(`./general-settings-DZbwMmWz.js`);return{GeneralSettings:e}},[],import.meta.url)).GeneralSettings),"keyboard-shortcuts":Z(async()=>(await s(async()=>{let{KeyboardShortcutsSettings:e}=await import(`./keyboard-shortcuts-settings-test.js`);return{KeyboardShortcutsSettings:e}},[],import.meta.url)).KeyboardShortcutsSettings)};
JS
    cat > "$extracted/webview/assets/keyboard-shortcuts-settings-test.js" <<'JS'
import{s as __toESM}from"./chunk-test.js";import{t as __reactFactory}from"./react-test.js";import{t as __jsxFactory}from"./jsx-runtime-test.js";function KeyboardShortcutsSettings(){let t=(0,React.useState)(null);return (0,$.jsx)(`div`,{children:t})}var React,$;initialize(()=>{React=__toESM(__reactFactory(),1),$=__jsxFactory()})();slug:`keyboard-shortcuts`;export{KeyboardShortcutsSettings};
JS

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_file_exists "$extracted/webview/assets/linux-desktop-settings-linux.js"
    assert_file_exists "$extracted/webview/assets/linux-settings-toggle-linux.js"
    [ ! -f "$extracted/webview/assets/keybinds-settings-linux.js" ] || fail "Old Keybinds settings asset should not be written for current native Keyboard Shortcuts"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "function LinuxDesktopSettings"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "Linux desktop"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "System tray"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "Warm start"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "Build information"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "codex-linux-system-tray-enabled"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "codex-linux-warm-start-enabled"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "codex-linux-prompt-window-enabled"
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" 'import{t as Toggle}from"./linux-settings-toggle-linux.js?v='
    assert_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" 'import{codexLinuxReact as React,codexLinuxJsx as $}from"./index-test.js"'
    assert_not_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "__reactFactory"
    assert_not_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "__jsxFactory"
    assert_not_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "function LinuxSwitch"
    assert_not_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "bg-token-text-primary"
    assert_not_contains "$extracted/webview/assets/linux-desktop-settings-linux.js" "translate-x-4"
    assert_contains "$extracted/webview/assets/settings-sections-test.js" 'slug:`linux-desktop`'
    assert_contains "$extracted/webview/assets/settings-shared-test.js" "settings.nav.linux-desktop"
    assert_contains "$extracted/webview/assets/settings-shared-test.js" "settings.section.linux-desktop"
    assert_contains "$extracted/webview/assets/index-test.js" "linux-desktop-settings-linux.js?v="
    assert_contains "$extracted/webview/assets/index-test.js" 'export{RouteReact as codexLinuxReact,RouteJsx as codexLinuxJsx}'
    assert_contains "$extracted/webview/assets/index-test.js" '"linux-desktop":'
    assert_contains "$extracted/webview/assets/index-test.js" 'Zge=\[`general-settings`,`linux-desktop`'
    assert_contains "$extracted/webview/assets/index-test.js" 'slugs:\[`general-settings`,`linux-desktop`'
    assert_contains "$extracted/webview/assets/index-test.js" 'case`linux-desktop`:case`general-settings`'
    assert_not_contains "$extracted/webview/assets/index-test.js" "keybinds-settings-linux.js"
    assert_not_contains "$extracted/webview/assets/index-test.js" "codexLinuxKeybindOverridesRuntime"

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_occurrence_count "$extracted/webview/assets/settings-sections-test.js" 'slug:`linux-desktop`' '1'
    assert_occurrence_count "$extracted/webview/assets/settings-shared-test.js" "settings.nav.linux-desktop" '1'
    assert_occurrence_count "$extracted/webview/assets/settings-shared-test.js" "settings.section.linux-desktop" '1'
    assert_occurrence_count "$extracted/webview/assets/index-test.js" "linux-desktop-settings-linux.js" '1'
}

test_keybinds_settings_patch_warns_on_bundle_shape_miss() {
    info "Checking Keybinds settings bundle-shape warning"
    local workspace="$TMP_DIR/keybinds-settings-shape-warning"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    make_fake_extracted_asar "$extracted" 'let D={removeMenu(){},setMenuBarVisibility(){},setIcon(){},once(){}};let t={join(){}};let a={existsSync(){return true},statSync(){return {isFile(){return false}}}};let n={shell:{openPath(){return ""},showItemInFolder(){}}};...process.platform===`win32`?{autoHideMenuBar:!0}:{},process.platform===`win32`&&D.removeMenu(),foo)}),D.once(`ready-to-show`,()=>{var sa=Mi({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>ai(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:ca,args:e=>ai(e),open:async({path:e})=>la(e)}});function ca(){let e=1;return e}async function la(e){let t=ua(e);if(t&&(0,a.statSync)(t).isFile()){n.shell.showItemInFolder(t);return}let r=t??e,i=await n.shell.openPath(r);if(i)throw Error(i)}function ua(e){return e}var Ua=Mi({id:`systemDefault`,label:`System Default App`,icon:`apps/file-explorer.png`,kind:`systemDefault`,hidden:!0,darwin:{icon:`apps/finder.png`,detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},win32:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},linux:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)}});async function Wa(e){return e}'
    rm "$extracted/webview/assets/settings-row-test.js"
    cat > "$extracted/webview/assets/keyboard-shortcuts-settings-test.js" <<'JS'
import{s as __toESM}from"./chunk-test.js";import{t as __reactFactory}from"./react-test.js";import{t as __jsxFactory}from"./jsx-runtime-test.js";function KeyboardShortcutsSettings(){let t=(0,React.useState)(null);return (0,$.jsx)(`div`,{children:t})}var React,$;initialize(()=>{React=__toESM(__reactFactory(),1),$=__jsxFactory()})();slug:`keyboard-shortcuts`;export{KeyboardShortcutsSettings};
JS
    cat > "$extracted/webview/assets/settings-sections-test.js" <<'JS'
var e=[`general-settings`,`profile`,`keyboard-shortcuts`],t=`general-settings`,n=[{slug:`general-settings`},{slug:`keyboard-shortcuts`}];
JS
    cat > "$extracted/webview/assets/settings-shared-test.js" <<'JS'
var c={"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},"keyboard-shortcuts":{id:`settings.nav.keyboard-shortcuts`,defaultMessage:`Keyboard shortcuts`,description:`Title for keyboard shortcuts settings section`}};function m(e){let t=(0,u.c)(17),{slug:r}=e;switch(r){case`general-settings`:{let e;return t[2]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,d.jsx)(n,{id:`settings.section.general-settings`,defaultMessage:`General`,description:`Title for general settings section`}),t[2]=e):e=t[2],e}}}
JS
    cat > "$extracted/webview/assets/index-test.js" <<'JS'
var Xge={"general-settings":xh,appearance:Pf},H7={},Zge=[`general-settings`,`appearance`],Qge=[{key:`app`,heading:H7.appHeading,slugs:[`general-settings`,`appearance`,`connections`,`git-settings`,`usage`]}];
JS

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$output_log" "WARN: Keybinds settings patch skipped"
    [ ! -f "$extracted/webview/assets/linux-desktop-settings-linux.js" ] || fail "Linux desktop settings asset should not be written when route bundle is missing"
    [ ! -f "$extracted/webview/assets/linux-settings-row-linux.js" ] || fail "Fallback row asset should not be written when route bundle is missing"
    [ ! -f "$extracted/webview/assets/linux-settings-section-linux.js" ] || fail "Fallback section asset should not be written when route bundle is missing"
    [ ! -f "$extracted/webview/assets/linux-settings-group-linux.js" ] || fail "Fallback group asset should not be written when route bundle is missing"
    assert_not_contains "$extracted/webview/assets/settings-sections-test.js" 'slug:`linux-desktop`'
    assert_not_contains "$extracted/webview/assets/index-test.js" "linux-desktop-settings-linux.js"
}

test_browser_annotation_screenshot_patch_smoke() {
    info "Checking browser annotation screenshot patch behavior"
    local workspace="$TMP_DIR/browser-annotation-patch"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    make_fake_extracted_asar "$extracted" 'let D={removeMenu(){},setMenuBarVisibility(){},setIcon(){},once(){}};let n=require(`electron`),t=require(`node:path`),a=require(`node:fs`);...process.platform===`win32`?{autoHideMenuBar:!0}:{},process.platform===`win32`&&D.removeMenu(),foo)}),D.once(`ready-to-show`,()=>{})'
    cat > "$extracted/.vite/build/comment-preload.js" <<'JS'
if(ve&&M?.anchor.kind===`element`){let e=hl(M,y.current)??null,t=e==null?null:El(e);ke=t?.rect??Rl(M.anchor),je=t?.borderRadius,Ae=Xl(M.anchor,ke,_.width,_.height)}
Se=(!ve&&xe!=null?k.filter(e=>e.id!==xe.id):k).flatMap
JS

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$extracted/.vite/build/comment-preload.js" 'if(ve&&M?.anchor.kind===`element`){ke=Rl(M.anchor),je=void 0,Ae=Xl(M.anchor,ke,_.width,_.height)}'
    assert_contains "$extracted/.vite/build/comment-preload.js" 'Se=(ve?_e:!ve&&xe!=null?k.filter(e=>e.id!==xe.id):k).flatMap'
    assert_not_contains "$extracted/.vite/build/comment-preload.js" 'hl(M,y.current)'

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_occurrence_count "$extracted/.vite/build/comment-preload.js" 'ke=Rl(M.anchor)' '1'
    assert_occurrence_count "$extracted/.vite/build/comment-preload.js" 'Se=(ve?_e' '1'
}

test_linux_single_instance_patch_smoke() {
    info "Checking Linux single-instance patch behavior"
    local workspace="$TMP_DIR/single-instance-patch"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"
    local bundle_body

    mkdir -p "$workspace"
    bundle_body="$(cat <<'JS'
let S=globalThis.__codexSmoke;
let n=require(`electron`);
let t={Er(){return {info(){}}},jn:class{add(e){S.disposables.push(e)}},y(){return{setSecondInstanceArgsHandler:e=>{S.initialHandler=e}}},g(e){return e},t(e){return Array.isArray(e)&&e.includes(`--open-project`)}};
let i={default:{dirname(e){S.dirnameCalls.push(e);return `/tmp`}}},o={mkdirSync(...e){S.mkdirSyncCalls.push(e)},rmSync(...e){S.rmSyncCalls.push(e)}},u={default:{createServer(e){S.createServerCalls++;S.socketConnectionHandler=e;return S.socketServer}}};
async function uT(){let{setSecondInstanceArgsHandler:l}=t.y(),k=new t.jn;k.add(()=>{}),t.Er().info(`Launching app`,{safe:{agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});let A=Date.now();await n.app.whenReady();let w=(...e)=>{S.traceCalls.push(e)},M={globalState:S.globalState,repoRoot:`/tmp/codex-smoke`},z=`local`,R={deepLinks:{queueProcessArgs(e){S.queueArgs.push(e);return Array.isArray(e)&&e.some(e=>{let t=String(e);return t.startsWith(`codex://`)||t.startsWith(`codex-browser-sidebar://`)})},flushPendingDeepLinks(){S.flushPendingDeepLinksCalls++;return Promise.resolve()}},navigateToRoute(e,t){S.navigateCalls.push({windowId:e.id,path:t})}},P={windowManager:{sendMessageToWindow(e,t){S.messages.push({windowId:e.id,message:t})}},hotkeyWindowLifecycleManager:{hide(){S.hideCalls++},show(){S.showCalls++;return S.hotkeyWindowShowResult},ensureHotkeyWindowController(){S.ensureHotkeyWindowControllerCalls++;return S.hotkeyWindowController}},getPrimaryWindow(){return S.primaryWindow},createFreshLocalWindow(e){S.createFreshLocalWindowCalls.push(e);return S.createdWindow},ensureHostWindow(e){S.ensureHostWindowCalls.push(e);return S.primaryWindow??S.createdWindow}},g={reportNonFatal(e,t){S.errors.push({error:String(e),meta:t})}},re=e=>{S.focusCalls.push(e.id);e.isMinimized()&&e.restore(),e.show(),e.focus()},ie=async()=>{S.ieCalls++;try{P.hotkeyWindowLifecycleManager.hide();let e=P.getPrimaryWindow()??await P.createFreshLocalWindow(`/`);if(e==null)return;re(e)}catch(e){g.reportNonFatal(e instanceof Error?e:`Failed to open window on second instance`,{kind:`second-instance-open-window-failed`})}};l(e=>{let n=t.t(t.g(e));if(R.deepLinks.queueProcessArgs(e)){n&&ie();return}if(n){ie();return}ie()});let ae=async(e,t)=>{P.hotkeyWindowLifecycleManager.hide();let n=P.getPrimaryWindow(),r=n??await P.createFreshLocalWindow(e);r!=null&&(n!=null&&t.navigateExistingWindow&&R.navigateToRoute(r,e),re(r))};async function ore(e){return new n.Tray(e)}let oe=async()=>{N=!0;try{await ore({appBrand:`codex`,buildFlavor:`prod`,repoRoot:M.repoRoot}),S.trayStartupCalls++}catch(e){N=!1}};let E=process.platform===`win32`;E&&oe();let me=await P.ensureHostWindow(z);me&&re(me),w(`local window ensured`,A,{hostId:z,localWindowVisible:me?.isVisible()??!1}),A=Date.now(),await R.deepLinks.flushPendingDeepLinks()}
JS
)"
    make_fake_extracted_asar "$extracted" "$bundle_body"

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$extracted/.vite/build/main-test.js" 'process.platform===`linux`&&process.env.CODEX_LINUX_MULTI_LAUNCH!==`1`&&!n.app.requestSingleInstanceLock()'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxHandleLaunchActionArgs'
    assert_contains "$extracted/.vite/build/main-test.js" 'e.includes(`--new-chat`)'
    assert_contains "$extracted/.vite/build/main-test.js" 'e.includes(`--quick-chat`)'
    assert_contains "$extracted/.vite/build/main-test.js" 'e.includes(`--prompt-chat`)'
    assert_contains "$extracted/.vite/build/main-test.js" 'e.includes(`--hotkey-window`)'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxHasDeepLink'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxShowHotkeyWindow'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxGetHotkeyWindowController'
    assert_contains "$extracted/.vite/build/main-test.js" 'ensureHotkeyWindowController'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxPrewarmHotkeyWindow'
    assert_contains "$extracted/.vite/build/main-test.js" 'codexLinuxStartLaunchActionSocket'
    assert_contains "$extracted/.vite/build/main-test.js" 'CODEX_DESKTOP_LAUNCH_ACTION_SOCKET'
    assert_contains "$extracted/.vite/build/main-test.js" 'e.openHome'
    assert_contains "$extracted/.vite/build/main-test.js" 'e.prewarm'
    assert_contains "$extracted/.vite/build/main-test.js" 'type:`new-quick-chat`'

    node - "$extracted/.vite/build/main-test.js" <<'NODE'
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(process.argv[2], "utf8");
let state = makeState();

function makeState(settings = {}) {
  const next = {
    appHandlers: Object.create(null),
    offHandlers: Object.create(null),
    disposables: [],
    initialHandler: null,
    lockCount: 0,
    quitCount: 0,
    globalStateGetKeys: [],
    linuxSettings: {
      promptChatEnabled: true,
      warmStartEnabled: true,
      trayEnabled: true,
      ...settings,
    },
  };

  next.globalState = {
    get(key) {
      next.globalStateGetKeys.push(String(key));
      return linuxSettingForKey(next, key);
    },
  };

  return next;
}

function linuxSettingsAtom(settings) {
  return {
    "settings.keybinds.promptChatEnabled": settings.promptChatEnabled,
    "settings.keybinds.promptChat": settings.promptChatEnabled,
    "settings.keybinds.hotkeyWindowEnabled": settings.promptChatEnabled,
    "settings.keybinds.warmStartEnabled": settings.warmStartEnabled,
    "settings.keybinds.warmStart": settings.warmStartEnabled,
    "settings.keybinds.launchActionSocketEnabled": settings.warmStartEnabled,
    "settings.keybinds.trayEnabled": settings.trayEnabled,
    "settings.keybinds.tray": settings.trayEnabled,
    "settings.linux.promptChatEnabled": settings.promptChatEnabled,
    "settings.linux.warmStartEnabled": settings.warmStartEnabled,
    "settings.linux.trayEnabled": settings.trayEnabled,
  };
}

function linuxSettingForKey(next, key) {
  const keyText = String(key).toLowerCase();
  const settings = next.linuxSettings;

  if (keyText.includes("persisted") || keyText === "electron-persisted-atom-state") {
    return linuxSettingsAtom(settings);
  }

  if (keyText.includes("keybind") && !keyText.includes("prompt") && !keyText.includes("hotkey") && !keyText.includes("warm") && !keyText.includes("launch") && !keyText.includes("socket") && !keyText.includes("tray")) {
    return {
      promptChatEnabled: settings.promptChatEnabled,
      hotkeyWindowEnabled: settings.promptChatEnabled,
      warmStartEnabled: settings.warmStartEnabled,
      launchActionSocketEnabled: settings.warmStartEnabled,
      trayEnabled: settings.trayEnabled,
    };
  }

  if (keyText.includes("prompt") || keyText.includes("hotkey")) {
    return settings.promptChatEnabled;
  }

  if (keyText.includes("warm") || keyText.includes("socket") || keyText.includes("launch")) {
    return settings.warmStartEnabled;
  }

  if (keyText.includes("tray")) {
    return settings.trayEnabled;
  }

  return null;
}

function makeWindow(id) {
  return {
    id,
    isMinimized() {
      state.windowCalls.push(`${id}:isMinimized`);
      return false;
    },
    isVisible() {
      state.windowCalls.push(`${id}:isVisible`);
      return true;
    },
    restore() {
      state.windowCalls.push(`${id}:restore`);
    },
    show() {
      state.windowCalls.push(`${id}:show`);
    },
    focus() {
      state.windowCalls.push(`${id}:focus`);
    },
  };
}

function resetCalls() {
  const existingCreateServerCalls = state.createServerCalls ?? 0;
  const existingSocketConnectionHandler = state.socketConnectionHandler ?? null;
  const existingSocketListenCalls = state.socketListenCalls ?? [];
  const existingSocketServerHandlers = state.socketServerHandlers ?? Object.create(null);
  state.queueArgs = [];
  state.navigateCalls = [];
  state.messages = [];
  state.hideCalls = 0;
  state.showCalls = 0;
  state.controllerShowCalls = 0;
  state.hotkeyWindowShowResult = true;
  state.openHomeCalls = 0;
  state.hotkeyWindowOpenHomeResult = undefined;
  state.prewarmCalls = 0;
  state.prewarmThrows = false;
  state.ensureHotkeyWindowControllerCalls = 0;
  state.hotkeyWindowController = {
    show() {
      state.controllerShowCalls++;
      return state.hotkeyWindowShowResult;
    },
    openHome() {
      state.openHomeCalls++;
      return state.hotkeyWindowOpenHomeResult;
    },
    prewarm() {
      state.prewarmCalls++;
      if (state.prewarmThrows) {
        throw new Error("prewarm failed");
      }
    },
  };
  state.ensureHostWindowCalls = [];
  state.createFreshLocalWindowCalls = [];
  state.focusCalls = [];
  state.windowCalls = [];
  state.errors = [];
  state.ieCalls = 0;
  state.traceCalls = [];
  state.flushPendingDeepLinksCalls = 0;
  state.trayStartupCalls = 0;
  state.primaryWindow = null;
  state.createdWindow = makeWindow("created");
  state.dirnameCalls = [];
  state.mkdirSyncCalls = [];
  state.rmSyncCalls = [];
  state.createServerCalls = existingCreateServerCalls;
  state.socketConnectionHandler = existingSocketConnectionHandler;
  state.socketListenCalls = existingSocketListenCalls;
  state.socketCloseCalls = 0;
  state.socketServer = {
    listen(path) {
      state.socketListenCalls.push(path);
    },
    close() {
      state.socketCloseCalls += 1;
    },
    on(event, handler) {
      state.socketServerHandlers[event] = handler;
      return this;
    },
  };
  state.socketServerHandlers = existingSocketServerHandlers;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function flushAsyncHandlers() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function boot(settings = {}, env = { CODEX_DESKTOP_LAUNCH_ACTION_SOCKET: "/tmp/codex-smoke.sock" }) {
  state = makeState(settings);
  resetCalls();
  state.primary = makeWindow("primary");

  const context = {
    console,
    process: { platform: "linux", env },
    require(moduleName) {
      if (moduleName === "electron") {
        return {
          app: {
            whenReady() {
              return Promise.resolve();
            },
            quit() {
              state.quitCount++;
            },
            requestSingleInstanceLock() {
              state.lockCount++;
              return true;
            },
            on(event, handler) {
              state.appHandlers[event] = handler;
            },
            off(event, handler) {
              state.offHandlers[event] = handler;
            },
          },
          Tray: class {},
        };
      }
      if (moduleName === "node:path") {
        return {
          dirname(path) {
            state.dirnameCalls.push(path);
            return "/tmp";
          },
          join(...parts) {
            return parts.join("/").replace(/\/+/g, "/");
          },
        };
      }
      if (moduleName === "node:fs") {
        return {
          mkdirSync(...args) {
            state.mkdirSyncCalls.push(args);
          },
          rmSync(...args) {
            state.rmSyncCalls.push(args);
          },
        };
      }
      if (moduleName === "node:net") {
        return {
          createServer(handler) {
            state.createServerCalls++;
            state.socketConnectionHandler = handler;
            return state.socketServer;
          },
        };
      }
      throw new Error(`Unexpected require(${moduleName})`);
    },
    __codexSmoke: state,
  };
  context.globalThis = context;

  vm.runInNewContext(`${source}\nglobalThis.__codexSmokeRun = uT;`, context, {
    filename: "main-test.js",
  });

  await context.__codexSmokeRun();
  return context;
}

(async () => {
  await boot();
  assert(typeof state.initialHandler === "function", "setSecondInstanceArgsHandler callback was not registered");
  assert(state.createServerCalls === 1, "warm-start launch action socket server was not created");
  assert(state.socketListenCalls.length === 1 && state.socketListenCalls[0] === "/tmp/codex-smoke.sock", "warm-start launch action socket did not listen on the configured path");
  assert(typeof state.socketConnectionHandler === "function", "warm-start launch action socket connection handler was not registered");
  assert(state.mkdirSyncCalls.length === 1, "warm-start launch action socket should create its parent runtime directory");
  assert(state.rmSyncCalls.length === 1 && state.rmSyncCalls[0][0] === "/tmp/codex-smoke.sock", "warm-start launch action socket should remove a stale socket before listening");
  assert(state.prewarmCalls === 1, "startup should prewarm the compact hotkey prompt window");
  assert(state.ensureHotkeyWindowControllerCalls === 1, "startup prewarm should use the real hotkey window controller");
  assert(state.flushPendingDeepLinksCalls === 1, "startup should still flush pending deeplinks after prewarm");
  assert(state.trayStartupCalls === 1, "startup should initialize the Linux tray when the tray gate is enabled");

  async function runSecondInstance(args) {
    state.initialHandler(args);
    await flushAsyncHandlers();
  }

  async function runInitialArgs(args) {
    state.initialHandler(args);
    await flushAsyncHandlers();
  }

  function makeSocket() {
    const handlers = Object.create(null);
    return {
      destroyed: false,
      encoding: null,
      outputs: [],
      setEncoding(encoding) {
        this.encoding = encoding;
      },
      on(event, handler) {
        handlers[event] = handler;
        return this;
      },
      emit(event, payload) {
        if (handlers[event]) {
          handlers[event](payload);
        }
      },
      end(output) {
        this.outputs.push(output);
      },
      destroy() {
        this.destroyed = true;
      },
    };
  }

  async function runSocketArgs(args) {
    const socket = makeSocket();
    state.socketConnectionHandler(socket);
    socket.emit("data", `${JSON.stringify({ argv: args })}\n`);
    await flushAsyncHandlers();
    return socket;
  }

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex-desktop", "--new-chat"]);
  assert(state.queueArgs.length === 0, "--new-chat without a deeplink should not be consumed by deeplink routing");
  assert(state.createFreshLocalWindowCalls.length === 0, "--new-chat should reuse the warm primary window");
  assert(state.focusCalls.length === 1 && state.focusCalls[0] === "primary", "--new-chat should focus the warm primary window");
  assert(state.navigateCalls.length === 1 && state.navigateCalls[0].path === "/", "--new-chat should navigate the warm primary window to /");
  assert(state.messages.length === 0, "--new-chat should not send a quick-chat message");

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex-desktop", "--quick-chat"]);
  assert(state.queueArgs.length === 0, "--quick-chat without a deeplink should not be consumed by deeplink routing");
  assert(state.createFreshLocalWindowCalls.length === 0, "--quick-chat should reuse the warm primary window");
  assert(state.focusCalls.length === 1 && state.focusCalls[0] === "primary", "--quick-chat should focus the warm primary window");
  assert(state.messages.length === 1 && state.messages[0].windowId === "primary" && state.messages[0].message.type === "new-quick-chat", "--quick-chat should send new-quick-chat to the warm primary window");
  assert(state.navigateCalls.length === 0, "--quick-chat should not navigate by route");

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex-desktop", "--prompt-chat"]);
  assert(state.queueArgs.length === 0, "--prompt-chat without a deeplink should not be consumed by deeplink routing");
  assert(state.openHomeCalls === 1, "--prompt-chat should open the compact hotkey prompt on the new-chat home surface");
  assert(state.ensureHotkeyWindowControllerCalls === 1, "--prompt-chat should use the real hotkey window controller");
  assert(state.showCalls === 0, "--prompt-chat should not reopen the last hotkey surface");
  assert(state.controllerShowCalls === 0, "--prompt-chat should not call the controller show fallback");
  assert(state.ensureHostWindowCalls.length === 0, "--prompt-chat should not open the main window when the hotkey prompt shows");
  assert(state.hideCalls === 0, "--prompt-chat should not hide the hotkey window before showing it");
  assert(state.focusCalls.length === 0, "--prompt-chat should not focus the main window");

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex-desktop", "--hotkey-window"]);
  assert(state.openHomeCalls === 1, "--hotkey-window should open the compact hotkey prompt on the new-chat home surface");
  assert(state.ensureHotkeyWindowControllerCalls === 1, "--hotkey-window should use the real hotkey window controller");
  assert(state.ensureHostWindowCalls.length === 0, "--hotkey-window should not open the main window when the compact prompt shows");

  resetCalls();
  state.primaryWindow = state.primary;
  let socket = await runSocketArgs(["codex-desktop", "--prompt-chat"]);
  assert(socket.outputs[0] === "ok\n", "warm-start socket should acknowledge handled prompt args");
  assert(state.openHomeCalls === 1, "warm-start socket should open the compact prompt on the new-chat home surface");
  assert(state.ensureHotkeyWindowControllerCalls === 1, "warm-start socket prompt should use the real hotkey window controller");
  assert(state.focusCalls.length === 0, "warm-start socket prompt should not focus the main window");

  resetCalls();
  state.primaryWindow = state.primary;
  socket = await runSocketArgs(["codex://thread/abc", "--prompt-chat"]);
  assert(socket.outputs[0] === "ok\n", "warm-start socket should acknowledge deeplink args");
  assert(state.queueArgs.length === 1, "warm-start socket should check deeplinks before prompt flags");
  assert(state.openHomeCalls === 0, "warm-start socket should not open the prompt when a deeplink is present");

  resetCalls();
  socket = await runSocketArgs(["codex-desktop"]);
  assert(socket.outputs[0] === "ok\n", "warm-start socket should acknowledge fallback focus args");
  assert(state.ieCalls === 1, "warm-start socket should use the focus fallback for args without launch flags");

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex://thread/abc", "--quick-chat"]);
  assert(state.queueArgs.length === 1, "deeplink+flag should check deeplinks");
  assert(state.messages.length === 0, "deeplink+flag should not open quick chat");
  assert(state.navigateCalls.length === 0, "deeplink+flag should not navigate to /");
  assert(state.ieCalls === 0, "deeplink+flag should not fall back to focus");

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex-browser-sidebar://open", "--quick-chat"]);
  assert(state.queueArgs.length === 1, "browser-sidebar deeplink+flag should check deeplinks");
  assert(state.messages.length === 0, "browser-sidebar deeplink+flag should not open quick chat");
  assert(state.navigateCalls.length === 0, "browser-sidebar deeplink+flag should not navigate to /");
  assert(state.ieCalls === 0, "browser-sidebar deeplink+flag should not fall back to focus");

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex://thread/abc", "--prompt-chat"]);
  assert(state.queueArgs.length === 1, "deeplink+prompt flag should check deeplinks first");
  assert(state.openHomeCalls === 0, "deeplink+prompt flag should not open the compact prompt");
  assert(state.showCalls === 0, "deeplink+prompt flag should not show the compact prompt");
  assert(state.ensureHostWindowCalls.length === 0, "deeplink+prompt flag should not fall back to the host window");

  resetCalls();
  await runSecondInstance(["codex-desktop"]);
  assert(state.queueArgs.length === 0, "no-flag args without a deeplink should not be consumed by deeplink routing");
  assert(state.ieCalls === 1, "no-flag args should use the focus fallback");
  assert(state.createFreshLocalWindowCalls.length === 1 && state.createFreshLocalWindowCalls[0] === "/", "fallback should create the default window");

  resetCalls();
  state.primaryWindow = state.primary;
  await runInitialArgs(["codex-desktop", "--quick-chat"]);
  assert(state.createFreshLocalWindowCalls.length === 0, "initial argv handler should reuse an existing primary window");
  assert(state.messages.length === 1 && state.messages[0].windowId === "primary" && state.messages[0].message.type === "new-quick-chat", "initial argv handler should open quick chat in the existing primary window");

  resetCalls();
  state.primaryWindow = state.primary;
  await runInitialArgs(["codex-desktop", "--prompt-chat"]);
  assert(state.openHomeCalls === 1, "initial argv handler should open the compact prompt on the new-chat home surface");
  assert(state.ensureHotkeyWindowControllerCalls === 1, "initial argv handler should use the real hotkey window controller");
  assert(state.showCalls === 0, "initial argv handler should not reopen the last hotkey surface");
  assert(state.ensureHostWindowCalls.length === 0, "initial argv handler should not open the main window when the compact prompt shows");

  resetCalls();
  await runInitialArgs(["codex-desktop", "--quick-chat"]);
  assert(state.createFreshLocalWindowCalls.length === 1 && state.createFreshLocalWindowCalls[0] === "/", "initial argv handler should create a window when no primary exists");
  assert(state.messages.length === 1 && state.messages[0].windowId === "created" && state.messages[0].message.type === "new-quick-chat", "initial argv handler should open quick chat in the created window when no primary exists");

  resetCalls();
  state.primaryWindow = state.primary;
  await runInitialArgs(["codex-desktop", "--new-chat"]);
  assert(state.createFreshLocalWindowCalls.length === 0, "initial --new-chat should reuse a warm primary window");
  assert(state.navigateCalls.length === 1 && state.navigateCalls[0].path === "/", "initial --new-chat should navigate an existing window to /");
  assert(state.focusCalls.length === 1 && state.focusCalls[0] === "primary", "initial --new-chat should focus the main window");

  await boot({ promptChatEnabled: false });
  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex://thread/abc", "--prompt-chat"]);
  assert(state.queueArgs.length === 1, "deeplink priority should still win when the prompt-chat gate is disabled");
  assert(state.openHomeCalls === 0, "disabled prompt-chat gate should not open the compact prompt for deeplink args");
  assert(state.ieCalls === 0, "deeplink args should not fall back to main-window focus when the prompt-chat gate is disabled");

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex-desktop", "--prompt-chat"]);
  assert(state.queueArgs.length === 0, "disabled prompt-chat args without a deeplink should not be consumed by deeplink routing");
  assert(state.openHomeCalls === 0, "disabled prompt-chat gate should not open the compact prompt");
  assert(state.ensureHotkeyWindowControllerCalls === 0, "disabled prompt-chat gate should not create the hotkey window controller");
  assert(state.ieCalls === 1, "disabled prompt-chat gate should fall back to main-window focus");
  assert(state.focusCalls.length === 1 && state.focusCalls[0] === "primary", "disabled prompt-chat fallback should focus the warm primary window");

  resetCalls();
  state.primaryWindow = state.primary;
  await runSecondInstance(["codex-desktop", "--hotkey-window"]);
  assert(state.openHomeCalls === 0, "disabled prompt-chat gate should also block --hotkey-window prompt opening");
  assert(state.ensureHotkeyWindowControllerCalls === 0, "disabled prompt-chat gate should not create a controller for --hotkey-window");
  assert(state.ieCalls === 1, "disabled --hotkey-window should fall back to main-window focus");

  await boot({ warmStartEnabled: false }, { CODEX_DESKTOP_LAUNCH_ACTION_SOCKET: "/tmp/codex-disabled.sock" });
  assert(state.createServerCalls === 0, "disabled warm-start gate should not create the launch-action socket server");
  assert(state.socketListenCalls.length === 0, "disabled warm-start gate should not listen on the launch-action socket");
  assert(state.socketConnectionHandler == null, "disabled warm-start gate should not register a socket connection handler");

  await boot({ trayEnabled: false });
  assert(state.trayStartupCalls === 0, "disabled tray gate should not start the Linux tray during startup");
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
NODE

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_occurrence_count "$extracted/.vite/build/main-test.js" '!n.app.requestSingleInstanceLock()' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxQuitInProgress=!1' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxHandleLaunchActionArgs=' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxHandleLaunchActionArgs=async e=>(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())?!0:' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxHandleLaunchActionArgsFallback=(e,t)=>{if(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())return;' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'e.includes(`--new-chat`)' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'e.includes(`--quick-chat`)' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'e.includes(`--prompt-chat`)' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'e.includes(`--hotkey-window`)' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxShowHotkeyWindow=' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxGetHotkeyWindowController=' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxPrewarmHotkeyWindow=' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxStartLaunchActionSocket=' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxOpenQuickChat=' '1'
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'codexLinuxPrewarmHotkeyWindow()' '1'
}

test_linux_computer_use_gate_patch_smoke() {
    info "Checking Linux Computer Use plugin gate patch behavior"
    local workspace="$TMP_DIR/computer-use-gate-patch"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"
    local bundle_body

    mkdir -p "$workspace"
    bundle_body="$(cat <<'JS'
let n={app:{whenReady(){},quit(){},requestSingleInstanceLock(){},on(){},off(){}}};
let Qt=`openai-bundled`,$t=`browser-use`,en=`chrome-internal`,tn=`computer-use`,nn=`latex-tectonic`;
function cl(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}
var $n=[{forceReload:!0,installWhenMissing:!0,name:$t,isEnabled:({features:e})=>e.browserAgentAvailable,migrate:cn},{name:en,isEnabled:({buildFlavor:e})=>rn(e)},{name:tn,isEnabled:cl,migrate:wn},{name:nn,isEnabled:()=>!0}];
JS
)"
    make_fake_extracted_asar "$extracted" "$bundle_body"

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$extracted/.vite/build/main-test.js" 'if(!((e.platform!==`darwin`&&e.platform!==`linux`)||!e.marketplacePluginNames.includes(`computer-use`))'
    assert_contains "$extracted/.vite/build/main-test.js" 'return e.platform===`darwin`&&e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`'
    assert_not_contains "$extracted/.vite/build/main-test.js" 'if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`'

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_occurrence_count "$extracted/.vite/build/main-test.js" 'return e.platform===`darwin`&&e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`' '1'
}

test_linux_computer_use_ui_opt_in_smoke() {
    info "Checking Linux Computer Use UI opt-in gating"
    local workspace="$TMP_DIR/computer-use-ui-opt-in"
    local extracted="$workspace/extracted"
    local fake_home="$workspace/home"
    local output_log="$workspace/output.log"
    local main_bundle="$extracted/.vite/build/main-test.js"
    local renderer_asset="$extracted/webview/assets/computer-use-settings-renderer-test.js"
    local current_renderer_asset="$extracted/webview/assets/computer-use-settings-current-test.js"
    local install_flow_asset="$extracted/webview/assets/app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-test.js"
    local native_apps_asset="$extracted/webview/assets/computer-use-settings-native-apps-test.js"
    local bundle_body
    local renderer_body
    local current_renderer_body
    local install_flow_body
    local native_apps_body

    mkdir -p "$workspace" "$fake_home/.config/codex-desktop"

    bundle_body="$(cat <<'JS'
let n={app:{whenReady(){},quit(){},requestSingleInstanceLock(){},on(){},off(){}}};
let cp=require(`node:child_process`),fs=require(`node:fs`),p=require(`node:path`),os=require(`node:os`);
let Qt=`openai-bundled`,$t=`browser-use`,en=`chrome-internal`,tn=`computer-use`,nn=`latex-tectonic`;
function cl(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}
var $n=[{name:tn,isEnabled:cl,migrate:wn}];
function me(e,{env:t=process.env,platform:n=process.platform}={}){return n!==`win32`||t.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`?e:{...e,computerUse:!0,computerUseNodeRepl:!0}}
var h={handlers:{"native-desktop-apps":async()=>({apps:[]})}};
JS
)"
    renderer_body="$(cat <<'JS'
function hae(e){return e===`macOS`||e===`windows`}
function RS(e){let t=(0,q.c)(8),{enabled:n,hostId:r,isHostLocal:i}=e,a=n===void 0?!0:n,o=r===void 0?R:r,s=Kn(),{isLoading:c,platform:l}=Hr(),u=Vn(`1506311413`),d;t[0]===o?d=t[1]:(d={featureName:`computer_use`,hostId:o},t[0]=o,t[1]=d);let f=LS(d),p;t[2]===l?p=t[3]:(p=hae(l),t[2]=l,t[3]=p);let m=a&&i&&s===`electron`&&u&&(c||p),h=m&&!c&&f.enabled&&!f.isLoading,g=m&&f.isLoading,_=m&&(c||f.isLoading),v;return v}
JS
)"
    current_renderer_body="$(cat <<'JS'
function b(e){return e===`macOS`||e===`windows`}
function x(e){let t=(0,_.c)(16),{enabled:n,hostId:r}=e,i=n===void 0?!0:n,{isLoading:a,platform:o}=m(),s=u(`1506311413`),c;t[0]===r?c=t[1]:(c={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=c);let l=v(c),d=o===`windows`&&!a,f=i&&d,p;t[2]===f?p=t[3]:(p={enabled:f},t[2]=f,t[3]=p);let h=S(p),g=l.isLoading||d&&h.isLoading,y=l.enabled&&(!d||h.enabled),x;t[4]!==y||t[5]!==i||t[6]!==g||t[7]!==s||t[8]!==a||t[9]!==o?(x=w({areRequiredFeaturesEnabled:y,enabled:i,isAnyFeatureLoading:g,isComputerUseGateEnabled:s,isHostCompatiblePlatform:b(o),isPlatformLoading:a,windowType:`electron`}),t[4]=y,t[5]=i,t[6]=g,t[7]=s,t[8]=a,t[9]=o,t[10]=x):x=t[10];return x}
JS
)"
    install_flow_body="$(cat <<'JS'
function Rj(e){return e===`macOS`||e===`windows`}
function zj(e){let t=(0,Uj.c)(16),{enabled:n,hostId:r}=e,i=n===void 0?!0:n,{isLoading:a,platform:o}=Xt(),s=cn(`1506311413`),c;t[0]===r?c=t[1]:(c={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=c);let l=Fj(c),u=o===`windows`&&!a,d=i&&u,f;t[2]===d?f=t[3]:(f={enabled:d},t[2]=d,t[3]=f);let p=Bj(f),m=l.isLoading||u&&p.isLoading,h=l.enabled&&(!u||p.enabled),g;t[4]!==h||t[5]!==i||t[6]!==m||t[7]!==s||t[8]!==a||t[9]!==o?(g=Hj({areRequiredFeaturesEnabled:h,enabled:i,isAnyFeatureLoading:m,isComputerUseGateEnabled:s,isHostCompatiblePlatform:Rj(o),isPlatformLoading:a,windowType:`electron`}),t[4]=h,t[5]=i,t[6]=m,t[7]=s,t[8]=a,t[9]=o,t[10]=g):g=t[10];return g}
JS
)"
    native_apps_body="$(cat <<'JS'
function d(e){return e.find(e=>e.plugin.name===`computer-use`)??null}
function C(e){let t=(0,S.c)(9),{enabled:n}=e,{platform:a,isLoading:o}=c(),s=n&&(a===`macOS`||a===`windows`),l;t[0]===Symbol.for(`react.memo_cache_sentinel`)?(l={order:`usage`},t[0]=l):l=t[0];let u;t[1]===s?u=t[2]:(u={params:l,queryConfig:{enabled:s,staleTime:i.FIVE_MINUTES,refetchOnWindowFocus:!1}},t[1]=s,t[2]=u);let d=r(`native-desktop-apps`,u);return d}
JS
)"

    make_fake_extracted_asar "$extracted" "$bundle_body"
    printf '%s\n' "$renderer_body" > "$renderer_asset"
    printf '%s\n' "$current_renderer_body" > "$current_renderer_asset"
    printf '%s\n' "$install_flow_body" > "$install_flow_asset"
    printf '%s\n' "$native_apps_body" > "$native_apps_asset"

    # Branch 1: no env var, no settings.json — only the plugin manifest gate runs.
    HOME="$fake_home" XDG_CONFIG_HOME= unset_env_value="" \
        env -u CODEX_LINUX_ENABLE_COMPUTER_USE_UI -u CODEX_LINUX_APP_ID -u CODEX_APP_ID -u CODEX_LINUX_SETTINGS_FILE \
        HOME="$fake_home" XDG_CONFIG_HOME="$fake_home/.config" \
        node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$main_bundle" 'if(!((e.platform!==`darwin`&&e.platform!==`linux`)||!e.marketplacePluginNames.includes(`computer-use`))'
    assert_contains "$main_bundle" 'return e.platform===`darwin`&&e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`'
    assert_not_contains "$main_bundle" 'if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`'
    assert_not_contains "$main_bundle" 'return n===`linux`?{...e,computerUse:!0,computerUseNodeRepl:!0}'
    assert_not_contains "$main_bundle" 'codexLinuxNativeDesktopApps'
    assert_not_contains "$renderer_asset" 'function hae(e){return e===`macOS`||e===`windows`||e===`linux`}'
    assert_not_contains "$current_renderer_asset" 'areRequiredFeaturesEnabled:o===`linux`||y'
    assert_not_contains "$native_apps_asset" 'a===`macOS`||a===`windows`||a===`linux`'
    assert_not_contains "$install_flow_asset" 'isHostCompatiblePlatform:o===`linux`||Rj(o)'

    # Branch 2: env var opts in — all Computer Use UI patches apply.
    rm "$main_bundle" "$renderer_asset" "$current_renderer_asset" "$install_flow_asset" "$native_apps_asset"
    printf '%s\n' "$bundle_body" > "$main_bundle"
    printf '%s\n' "$renderer_body" > "$renderer_asset"
    printf '%s\n' "$current_renderer_body" > "$current_renderer_asset"
    printf '%s\n' "$install_flow_body" > "$install_flow_asset"
    printf '%s\n' "$native_apps_body" > "$native_apps_asset"

    env -u CODEX_LINUX_APP_ID -u CODEX_APP_ID -u CODEX_LINUX_SETTINGS_FILE \
        CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1 HOME="$fake_home" XDG_CONFIG_HOME="$fake_home/.config" \
        node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$main_bundle" 'if(!((e.platform!==`darwin`&&e.platform!==`linux`)||!e.marketplacePluginNames.includes(`computer-use`))'
    assert_contains "$main_bundle" 'return e.platform===`darwin`&&e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`'
    assert_contains "$main_bundle" 'return n===`linux`?{...e,computerUse:!0,computerUseNodeRepl:!0}'
    assert_contains "$main_bundle" 'codexLinuxNativeDesktopApps'
    assert_contains "$main_bundle" '"computer-use-native-desktop-app-icon":async(e)=>process.platform===`linux`?codexLinuxNativeDesktopAppIcon(e):{iconSmall:``}'
    assert_contains "$renderer_asset" 'function hae(e){return e===`macOS`||e===`windows`||e===`linux`}'
    assert_contains "$current_renderer_asset" 'areRequiredFeaturesEnabled:o===`linux`||y'
    assert_contains "$current_renderer_asset" 'isAnyFeatureLoading:o===`linux`?!1:g'
    assert_contains "$native_apps_asset" 'a===`macOS`||a===`windows`||a===`linux`'
    assert_contains "$install_flow_asset" 'areRequiredFeaturesEnabled:h'
    assert_contains "$install_flow_asset" 'isAnyFeatureLoading:m'
    assert_contains "$install_flow_asset" 'isComputerUseGateEnabled:s'
    assert_contains "$install_flow_asset" 'isHostCompatiblePlatform:o===`linux`||Rj(o)'
    assert_not_contains "$install_flow_asset" 'areRequiredFeaturesEnabled:o===`linux`||h'
    assert_not_contains "$install_flow_asset" 'isComputerUseGateEnabled:o===`linux`||s'

    # Branch 3: settings.json flag opts in even without env var.
    rm "$main_bundle" "$renderer_asset" "$current_renderer_asset" "$install_flow_asset" "$native_apps_asset"
    printf '%s\n' "$bundle_body" > "$main_bundle"
    printf '%s\n' "$renderer_body" > "$renderer_asset"
    printf '%s\n' "$current_renderer_body" > "$current_renderer_asset"
    printf '%s\n' "$install_flow_body" > "$install_flow_asset"
    printf '%s\n' "$native_apps_body" > "$native_apps_asset"
    printf '%s\n' '{"codex-linux-computer-use-ui-enabled": true}' > "$fake_home/.config/codex-desktop/settings.json"

    env -u CODEX_LINUX_ENABLE_COMPUTER_USE_UI -u CODEX_LINUX_APP_ID -u CODEX_APP_ID -u CODEX_LINUX_SETTINGS_FILE \
        HOME="$fake_home" XDG_CONFIG_HOME="$fake_home/.config" \
        node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$main_bundle" 'return n===`linux`?{...e,computerUse:!0,computerUseNodeRepl:!0}'
    assert_contains "$main_bundle" 'codexLinuxNativeDesktopApps'
    assert_contains "$renderer_asset" 'function hae(e){return e===`macOS`||e===`windows`||e===`linux`}'
    assert_contains "$current_renderer_asset" 'areRequiredFeaturesEnabled:o===`linux`||y'
    assert_contains "$native_apps_asset" 'a===`macOS`||a===`windows`||a===`linux`'
    assert_contains "$install_flow_asset" 'areRequiredFeaturesEnabled:h'
    assert_contains "$install_flow_asset" 'isComputerUseGateEnabled:s'
    assert_contains "$install_flow_asset" 'isHostCompatiblePlatform:o===`linux`||Rj(o)'
    assert_not_contains "$install_flow_asset" 'areRequiredFeaturesEnabled:o===`linux`||h'
    assert_not_contains "$install_flow_asset" 'isComputerUseGateEnabled:o===`linux`||s'
}

test_linux_file_manager_patch_fails_soft() {
    info "Checking Linux file manager patch fallback"
    local workspace="$TMP_DIR/file-manager-patch-fallback"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"

    mkdir -p "$workspace"
    make_fake_extracted_asar "$extracted" 'let D={removeMenu(){},setMenuBarVisibility(){},setIcon(){},once(){}};let t={join(){}};...process.platform===`win32`?{autoHideMenuBar:!0}:{},process.platform===`win32`&&D.removeMenu(),foo)}),D.once(`ready-to-show`,()=>{var brokenFileManager=Mi({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`});var Ua=Mi({id:`systemDefault`,label:`System Default App`,icon:`apps/file-explorer.png`,kind:`systemDefault`,hidden:!0,darwin:{icon:`apps/finder.png`,detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},win32:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)},linux:{detect:()=>`system-default`,iconPath:()=>null,args:e=>[e],open:async({path:e})=>Wa(e)}});async function Wa(e){return e}'

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1
    assert_contains "$output_log" 'Failed to apply Linux File Manager Patch'
}

test_patcher_enforce_critical_gate() {
    info "Checking --enforce-critical patcher gate"
    local workspace="$TMP_DIR/enforce-critical-gate"
    local extracted="$workspace/extracted"
    local output_log="$workspace/output.log"
    local report_json="$workspace/reports/patch-report.json"
    local status=0

    mkdir -p "$workspace"
    # Minimal fixture: most required patches cannot match, so enforcement must fail.
    make_fake_extracted_asar "$extracted" 'let n=require(`electron`);process.platform===`win32`&&D.removeMenu(),'

    # Bare invocation stays fail-soft (exit 0) — build scripts opt into enforcement.
    node "$REPO_DIR/scripts/patch-linux-window-ui.js" "$extracted" >"$output_log" 2>&1 \
        || fail "expected bare patcher invocation to stay fail-soft on this fixture"

    node "$REPO_DIR/scripts/patch-linux-window-ui.js" --enforce-critical --report-json "$report_json" "$extracted" >"$output_log" 2>&1 || status=$?
    [ "$status" -ne 0 ] || fail "expected --enforce-critical to exit non-zero on critical patch failures"
    assert_contains "$output_log" 'Critical patch failures'
    [ -f "$report_json" ] || fail "expected patch report to be written despite enforcement failure"
}

test_webview_probe_equivalence() {
    info "Checking webview probe behavioral equivalence (bash + curl vs python3 reference)"
    # The harness extracts webview_port_is_open and verify_webview_origin from
    # the live launcher template, runs them against a controlled localhost
    # python3 http.server fixture, and asserts the verdicts match the
    # python3 reference implementation across every input class (open/closed
    # port, marker-OK, 404, wrong title, missing loader, dead port) plus
    # confirms the watchdog cap still fires within its 150-500 ms window.
    bash "$REPO_DIR/tests/webview_probe_equivalence.sh" \
        || fail "webview probe equivalence harness reported a verdict mismatch or unbounded watchdog"
}

test_user_local_prepare_build_repo_overlays_committed_local_changes() {
    info "Checking user-local managed checkout preserves committed local overlay changes"
    local workspace="$TMP_DIR/user-local-overlay"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local upstream_repo="$workspace/upstream"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"

    cat > "$source_repo/tracked.txt" <<'EOF'
base
EOF
    cat > "$source_repo/upstream.txt" <<'EOF'
upstream-base
EOF
    git -C "$source_repo" add tracked.txt upstream.txt
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin main >/dev/null
    git -C "$source_repo" remote set-head origin -a >/dev/null 2>&1 || true

    cat > "$source_repo/tracked.txt" <<'EOF'
local-overlay
EOF
    git -C "$source_repo" commit -am "local overlay" >/dev/null

    git clone "$origin_repo" "$upstream_repo" >/dev/null 2>&1
    git -C "$upstream_repo" config user.name "Smoke Test"
    git -C "$upstream_repo" config user.email "smoke@example.com"
    cat > "$upstream_repo/upstream.txt" <<'EOF'
upstream-advanced
EOF
    cat > "$upstream_repo/remote-only.txt" <<'EOF'
remote-only
EOF
    git -C "$upstream_repo" add upstream.txt remote-only.txt
    git -C "$upstream_repo" commit -m "upstream advance" >/dev/null
    git -C "$upstream_repo" push origin main >/dev/null

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$source_repo")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "main")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ "$(git -C "$MANAGED_REPO_DIR" rev-parse HEAD)" = "$(git -C "$upstream_repo" rev-parse HEAD)" ] \
            || fail "Expected managed checkout to reset to latest upstream commit"
        [ "$(cat "$MANAGED_REPO_DIR/tracked.txt")" = "local-overlay" ] \
            || fail "Expected committed local overlay change to be copied into managed checkout"
        [ "$(cat "$MANAGED_REPO_DIR/upstream.txt")" = "upstream-advanced" ] \
            || fail "Expected upstream-only change to remain intact in managed checkout"
        [ "$(cat "$MANAGED_REPO_DIR/remote-only.txt")" = "remote-only" ] \
            || fail "Expected upstream-only added file to remain in managed checkout"
        [ -n "$(source_repo_overlay_signature)" ] \
            || fail "Expected committed local overlay to produce a non-empty overlay signature"
    )
}

test_user_local_prepare_build_repo_detects_default_branch_without_recorded_branch() {
    info "Checking user-local managed checkout detects remote default branch when metadata leaves it empty"
    local workspace="$TMP_DIR/user-local-branch-detect"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local unmanaged_source="$workspace/source-without-git"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace" "$unmanaged_source"
    git init --bare --initial-branch=master "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"
    cat > "$source_repo/branch.txt" <<'EOF'
master-branch
EOF
    git -C "$source_repo" add branch.txt
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin master >/dev/null
    git -C "$source_repo" remote set-head origin -a >/dev/null 2>&1 || true

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$unmanaged_source")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ "$(repo_default_branch)" = "master" ] \
            || fail "Expected default branch detection to resolve to the remote master branch"
        [ "$(git -C "$MANAGED_REPO_DIR" rev-parse --abbrev-ref HEAD)" = "master" ] \
            || fail "Expected managed checkout to land on the detected master branch"
        [ "$(cat "$MANAGED_REPO_DIR/branch.txt")" = "master-branch" ] \
            || fail "Expected managed checkout contents from the detected master branch"
    )
}

test_user_local_prepare_build_repo_ignores_stale_recorded_default_branch() {
    info "Checking user-local managed checkout ignores a stale recorded default branch"
    local workspace="$TMP_DIR/user-local-stale-branch"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local unmanaged_source="$workspace/source-without-git"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace" "$unmanaged_source"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"
    cat > "$source_repo/branch.txt" <<'EOF'
main-branch
EOF
    git -C "$source_repo" add branch.txt
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin main >/dev/null
    git -C "$source_repo" remote set-head origin -a >/dev/null 2>&1 || true

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$unmanaged_source")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "master")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ "$(repo_default_branch)" = "main" ] \
            || fail "Expected stale recorded branch to fall back to the remote default branch"
        [ "$(git -C "$MANAGED_REPO_DIR" rev-parse --abbrev-ref HEAD)" = "main" ] \
            || fail "Expected managed checkout to land on the recovered main branch"
        [ "$(cat "$MANAGED_REPO_DIR/branch.txt")" = "main-branch" ] \
            || fail "Expected managed checkout contents from the recovered main branch"
    )
}

test_user_local_prepare_build_repo_ignores_stale_source_origin_head() {
    info "Checking user-local managed checkout ignores a stale source origin/HEAD ref"
    local workspace="$TMP_DIR/user-local-stale-origin-head"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"
    cat > "$source_repo/branch.txt" <<'EOF'
main-branch
EOF
    git -C "$source_repo" add branch.txt
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin main >/dev/null
    git -C "$source_repo" remote set-head origin -a >/dev/null 2>&1 || true
    git -C "$source_repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$source_repo")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ "$(repo_default_branch)" = "main" ] \
            || fail "Expected stale source origin/HEAD to fall back to the real remote default branch"
        [ "$(git -C "$MANAGED_REPO_DIR" rev-parse --abbrev-ref HEAD)" = "main" ] \
            || fail "Expected managed checkout to land on the recovered main branch"
        [ "$(cat "$MANAGED_REPO_DIR/branch.txt")" = "main-branch" ] \
            || fail "Expected managed checkout contents from the recovered main branch"
    )
}

test_user_local_prepare_build_repo_handles_relative_origin_url() {
    info "Checking user-local managed checkout handles relative origin URLs"
    local workspace="$TMP_DIR/user-local-relative-origin"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local moved_source_repo="$workspace/source-moved"
    local updater_repo="$workspace/updater"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"
    cat > "$source_repo/relative.txt" <<'EOF'
relative-origin
EOF
    git -C "$source_repo" add relative.txt
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin main >/dev/null
    git -C "$source_repo" remote set-head origin -a >/dev/null 2>&1 || true
    git -C "$source_repo" remote set-url origin ../origin.git

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$source_repo")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "../origin.git")
REPO_DEFAULT_BRANCH=$(printf '%q' "main")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ "$(cat "$MANAGED_REPO_DIR/relative.txt")" = "relative-origin" ] \
            || fail "Expected managed checkout contents from relative origin URL"
        [ "$(git -C "$MANAGED_REPO_DIR" remote get-url origin)" = "$origin_repo" ] \
            || fail "Expected first relative-origin checkout to store an absolute managed origin URL"

        mv "$source_repo" "$moved_source_repo"
        git clone "$origin_repo" "$updater_repo" >/dev/null 2>&1
        git -C "$updater_repo" config user.name "Smoke Test"
        git -C "$updater_repo" config user.email "smoke@example.com"
        cat > "$updater_repo/relative.txt" <<'EOF'
relative-origin-updated
EOF
        git -C "$updater_repo" commit -am "advance remote" >/dev/null
        git -C "$updater_repo" push origin main >/dev/null

        prepare_build_repo

        [ "$(cat "$MANAGED_REPO_DIR/relative.txt")" = "relative-origin-updated" ] \
            || fail "Expected managed checkout to update after source checkout moved away"
        [ "$(git -C "$MANAGED_REPO_DIR" remote get-url origin)" = "$origin_repo" ] \
            || fail "Expected moved-source update to keep using the absolute managed origin URL"
    )
}

test_desktop_entry_doctor_repairs_only_legacy_generated_entries() {
    info "Checking desktop-entry doctor only backs up legacy generated entries"
    local workspace="$TMP_DIR/desktop-entry-doctor"
    local desktop_dir="$workspace/applications"
    local template="$REPO_DIR/contrib/user-local-install/files/.local/share/applications/codex-desktop.desktop"
    local stale_entry="$desktop_dir/stale.desktop"
    local current_entry="$desktop_dir/current.desktop"
    local custom_entry="$desktop_dir/custom.desktop"

    mkdir -p "$desktop_dir"

    cat > "$stale_entry" <<'EOF'
[Desktop Entry]
Type=Application
Name=Codex Desktop
Exec=/home/tester/.local/bin/codex-desktop %U
TryExec=/home/tester/.local/bin/codex-desktop
Terminal=false
Icon=codex-desktop
Actions=NewInstance;

[Desktop Action NewInstance]
Name=Open New Instance
Exec=env CODEX_MULTI_LAUNCH=1 /home/tester/.local/bin/codex-desktop --new-instance
EOF

    cat > "$custom_entry" <<'EOF'
[Desktop Entry]
Type=Application
Name=My Custom App
Exec=/usr/bin/custom-app
Icon=custom-app
EOF

    (
        # shellcheck disable=SC1091
        . "$REPO_DIR/packaging/linux/codex-desktop-entry-doctor.sh"
        codex_desktop_write_user_local_entry "$template" "$current_entry" "/home/tester"
        codex_desktop_repair_shadow_entry "$stale_entry"
        if codex_desktop_repair_shadow_entry "$current_entry"; then
            exit 1
        fi
        if codex_desktop_repair_shadow_entry "$custom_entry"; then
            exit 1
        fi
        if codex_desktop_repair_shadow_entry "$stale_entry"; then
            exit 1
        fi
    )

    assert_file_not_exists "$stale_entry"
    assert_file_exists "$stale_entry.bak"
    assert_contains "$stale_entry.bak" "Actions=NewInstance;"
    assert_file_exists "$current_entry"
    assert_contains "$current_entry" "Actions=new-window;"
    assert_contains "$current_entry" "x-scheme-handler/codex-browser-sidebar"
    assert_file_exists "$custom_entry"
    assert_not_contains "$custom_entry" "codex-browser-sidebar"
    assert_file_not_exists "$stale_entry.bak.1"
}

test_user_local_install_from_update_defers_record_only_metadata() {
    info "Checking user-local helper refresh does not record metadata before update success"
    local workspace="$TMP_DIR/user-local-from-update-record-only"
    local fake_bin="$workspace/bin"
    local home="$workspace/home"
    local marker="$workspace/record-only-attempted"
    local metadata_file="$workspace/state/codex-desktop-linux/metadata.env"
    local app_dir="$home/.local/opt/codex-desktop-linux/codex-app"

    mkdir -p "$fake_bin"
    cat > "$fake_bin/7z" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
: "${RECORD_ONLY_MARKER:?}"
mkdir -p "$(dirname "$RECORD_ONLY_MARKER")"
printf '%s\n' "attempted" > "$RECORD_ONLY_MARKER"
exit 1
SCRIPT
    printf '#!/usr/bin/env bash\nexit 0\n' > "$fake_bin/systemctl"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$fake_bin/update-desktop-database"
    chmod +x "$fake_bin/7z" "$fake_bin/systemctl" "$fake_bin/update-desktop-database"
    mkdir -p "$app_dir"
    printf '%s\n' "26.609.41114" > "$app_dir/version"

    PATH="$fake_bin:$PATH" \
        HOME="$home" \
        XDG_DATA_HOME="$workspace/data" \
        XDG_STATE_HOME="$workspace/state" \
        RECORD_ONLY_MARKER="$marker" \
        CODEX_USER_LOCAL_SOURCE_REPO_DIR="$REPO_DIR" \
        bash "$REPO_DIR/contrib/user-local-install/install-user-local.sh" --from-update >/dev/null
    assert_file_not_exists "$marker"
    assert_file_not_exists "$metadata_file"

    PATH="$fake_bin:$PATH" \
        HOME="$home" \
        XDG_DATA_HOME="$workspace/data" \
        XDG_STATE_HOME="$workspace/state" \
        RECORD_ONLY_MARKER="$marker" \
        CODEX_USER_LOCAL_SOURCE_REPO_DIR="$REPO_DIR" \
        bash "$REPO_DIR/contrib/user-local-install/install-user-local.sh" >/dev/null
    assert_file_not_exists "$marker"
    assert_file_exists "$metadata_file"
    assert_contains "$metadata_file" "DMG_SHA256=unavailable"
}

test_user_local_install_preserves_persisted_x11_preference_on_refresh() {
    info "Checking user-local X11 fallback preference persists across helper refreshes"
    local workspace="$TMP_DIR/user-local-x11-preference"
    local stub_bin="$workspace/bin"
    local home="$workspace/home"
    local config_home="$workspace/config"
    local preference_file="$config_home/codex-desktop-linux/user-local.env"

    mkdir -p "$stub_bin"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$stub_bin/7z"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$stub_bin/systemctl"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$stub_bin/update-desktop-database"
    chmod +x "$stub_bin/7z" "$stub_bin/systemctl" "$stub_bin/update-desktop-database"

    PATH="$stub_bin:$PATH" \
        HOME="$home" \
        XDG_CONFIG_HOME="$config_home" \
        XDG_DATA_HOME="$workspace/data" \
        XDG_STATE_HOME="$workspace/state" \
        CODEX_USER_LOCAL_SOURCE_REPO_DIR="$REPO_DIR" \
        bash "$REPO_DIR/contrib/user-local-install/install-user-local.sh" --force-x11 >/dev/null
    assert_file_exists "$preference_file"
    assert_contains "$preference_file" "CODEX_USER_LOCAL_OZONE_PLATFORM=x11"

    PATH="$stub_bin:$PATH" \
        HOME="$home" \
        XDG_CONFIG_HOME="$config_home" \
        XDG_DATA_HOME="$workspace/data" \
        XDG_STATE_HOME="$workspace/state" \
        CODEX_USER_LOCAL_SOURCE_REPO_DIR="$REPO_DIR" \
        bash "$REPO_DIR/contrib/user-local-install/install-user-local.sh" --from-update >/dev/null
    assert_contains "$preference_file" "CODEX_USER_LOCAL_OZONE_PLATFORM=x11"

    PATH="$stub_bin:$PATH" \
        HOME="$home" \
        XDG_CONFIG_HOME="$config_home" \
        XDG_DATA_HOME="$workspace/data" \
        XDG_STATE_HOME="$workspace/state" \
        CODEX_USER_LOCAL_SOURCE_REPO_DIR="$REPO_DIR" \
        bash "$REPO_DIR/contrib/user-local-install/install-user-local.sh" --no-force-x11 >/dev/null
    assert_contains "$preference_file" "CODEX_USER_LOCAL_OZONE_PLATFORM=auto"
}

test_user_local_prepare_build_repo_copies_enabled_local_features() {
    info "Checking user-local managed checkout stages enabled local features"
    local workspace="$TMP_DIR/user-local-local-features"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"
    local feature_config="$workspace/linux-features.json"
    local staged_local_feature="$managed_repo/linux-features/local/local-tool"

    mkdir -p "$workspace"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"

    mkdir -p "$source_repo/linux-features/repo-feature"
    printf '%s\n' '# Linux Features' > "$source_repo/linux-features/README.md"
    printf '%s\n' '{"enabled":[]}' > "$source_repo/linux-features/features.example.json"
    printf '%s\n' '{"id":"repo-feature","title":"Repo Feature"}' \
        > "$source_repo/linux-features/repo-feature/feature.json"
    printf '%s\n' '# Repo Feature' > "$source_repo/linux-features/repo-feature/README.md"
    git -C "$source_repo" add linux-features
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin main >/dev/null

    mkdir -p "$source_repo/linux-features/local/local-tool/nested"
    mkdir -p "$source_repo/linux-features/local/repo-feature"
    printf '%s\n' '{"id":"local-tool","title":"Local Tool"}' \
        > "$source_repo/linux-features/local/local-tool/feature.json"
    printf '%s\n' '# Local Tool' > "$source_repo/linux-features/local/local-tool/README.md"
    printf '%s\n' 'payload' > "$source_repo/linux-features/local/local-tool/nested/payload.txt"
    ln -s nested/payload.txt "$source_repo/linux-features/local/local-tool/payload-link"
    printf '%s\n' '{"id":"repo-feature","title":"Local Repo Feature"}' \
        > "$source_repo/linux-features/local/repo-feature/feature.json"
    cat > "$feature_config" <<'JSON'
{
  "enabled": [
    "local-tool",
    "repo-feature",
    "missing-local",
    "bad id"
  ]
}
JSON

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        export CODEX_LINUX_FEATURES_CONFIG="$feature_config"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$source_repo")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "main")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo
    )

    assert_file_exists "$staged_local_feature/feature.json"
    [ "$(cat "$staged_local_feature/nested/payload.txt")" = "payload" ] \
        || fail "Expected local feature nested payload to be copied"
    [ -L "$staged_local_feature/payload-link" ] \
        || fail "Expected local feature symlink to be preserved"
    [ "$(readlink "$staged_local_feature/payload-link")" = "nested/payload.txt" ] \
        || fail "Expected local feature symlink target to be preserved"
    assert_file_not_exists "$managed_repo/linux-features/local/repo-feature/feature.json"
    assert_file_not_exists "$managed_repo/linux-features/local/missing-local/feature.json"
    assert_file_exists "$managed_repo/linux-features/repo-feature/feature.json"
}

test_user_local_prepare_build_repo_updates_existing_single_branch_fetch_refspec() {
    info "Checking user-local managed checkout can switch branches after a single-branch clone"
    local workspace="$TMP_DIR/user-local-single-branch-refspec"
    local origin_repo="$workspace/origin.git"
    local upstream_repo="$workspace/upstream"
    local unmanaged_source="$workspace/source-without-git"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace" "$unmanaged_source"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$upstream_repo" >/dev/null 2>&1
    git -C "$upstream_repo" config user.name "Smoke Test"
    git -C "$upstream_repo" config user.email "smoke@example.com"
    cat > "$upstream_repo/branch.txt" <<'EOF'
main-branch
EOF
    git -C "$upstream_repo" add branch.txt
    git -C "$upstream_repo" commit -m "base" >/dev/null
    git -C "$upstream_repo" push -u origin main >/dev/null

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$unmanaged_source")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "main")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ "$(git -C "$MANAGED_REPO_DIR" rev-parse --abbrev-ref HEAD)" = "main" ] \
            || fail "Expected managed checkout to start on main"
        [ "$(git -C "$MANAGED_REPO_DIR" config --get-all remote.origin.fetch)" = "+refs/heads/*:refs/remotes/origin/*" ] \
            || fail "Expected managed checkout fetch refspec to include all branches"
    )

    git -C "$upstream_repo" checkout -q -b master
    cat > "$upstream_repo/branch.txt" <<'EOF'
master-branch
EOF
    git -C "$upstream_repo" commit -am "master branch" >/dev/null
    git -C "$upstream_repo" push -u origin master >/dev/null
    git --git-dir="$origin_repo" symbolic-ref HEAD refs/heads/master

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$unmanaged_source")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "master")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ "$(git -C "$MANAGED_REPO_DIR" rev-parse --abbrev-ref HEAD)" = "master" ] \
            || fail "Expected managed checkout to switch to master"
        [ "$(cat "$MANAGED_REPO_DIR/branch.txt")" = "master-branch" ] \
            || fail "Expected managed checkout contents from the newly selected branch"
    )
}

test_user_local_prepare_build_repo_handles_deleted_overlay_paths() {
    info "Checking user-local managed checkout tolerates overlay paths deleted in the worktree"
    local workspace="$TMP_DIR/user-local-deleted-overlay"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"

    cat > "$source_repo/overlay.txt" <<'EOF'
base
EOF
    git -C "$source_repo" add overlay.txt
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin main >/dev/null
    git -C "$source_repo" remote set-head origin -a >/dev/null 2>&1 || true

    cat > "$source_repo/overlay.txt" <<'EOF'
committed-overlay
EOF
    git -C "$source_repo" commit -am "overlay commit" >/dev/null
    rm -f "$source_repo/overlay.txt"

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$source_repo")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "main")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ ! -e "$MANAGED_REPO_DIR/overlay.txt" ] \
            || fail "Expected deleted overlay path to be removed from managed checkout"
    )
}

test_user_local_prepare_build_repo_removes_rename_source_paths() {
    info "Checking user-local managed checkout removes rename source paths"
    local workspace="$TMP_DIR/user-local-rename-overlay"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"

    cat > "$source_repo/old-name.txt" <<'EOF'
base
EOF
    git -C "$source_repo" add old-name.txt
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin main >/dev/null
    git -C "$source_repo" remote set-head origin -a >/dev/null 2>&1 || true

    git -C "$source_repo" mv old-name.txt new-name.txt
    git -C "$source_repo" commit -m "rename overlay file" >/dev/null

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$source_repo")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "main")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ ! -e "$MANAGED_REPO_DIR/old-name.txt" ] \
            || fail "Expected rename source path to be removed from managed checkout"
        [ "$(cat "$MANAGED_REPO_DIR/new-name.txt")" = "base" ] \
            || fail "Expected rename destination path to be present in managed checkout"
    )
}

test_user_local_prepare_build_repo_skips_unmerged_overlay_paths() {
    info "Checking user-local managed checkout skips unmerged overlay paths"
    local workspace="$TMP_DIR/user-local-unmerged-overlay"
    local origin_repo="$workspace/origin.git"
    local source_repo="$workspace/source"
    local managed_repo="$workspace/xdg-data/codex-desktop-linux/managed-repo"
    local install_env="$workspace/install.env"

    mkdir -p "$workspace"
    git init --bare --initial-branch=main "$origin_repo" >/dev/null
    git clone "$origin_repo" "$source_repo" >/dev/null 2>&1
    git -C "$source_repo" config user.name "Smoke Test"
    git -C "$source_repo" config user.email "smoke@example.com"

    cat > "$source_repo/conflict.txt" <<'EOF'
base
EOF
    git -C "$source_repo" add conflict.txt
    git -C "$source_repo" commit -m "base" >/dev/null
    git -C "$source_repo" push -u origin main >/dev/null
    git -C "$source_repo" remote set-head origin -a >/dev/null 2>&1 || true

    git -C "$source_repo" checkout -q -b feature
    cat > "$source_repo/conflict.txt" <<'EOF'
feature-change
EOF
    git -C "$source_repo" commit -am "feature change" >/dev/null
    git -C "$source_repo" checkout -q main
    cat > "$source_repo/conflict.txt" <<'EOF'
main-change
EOF
    git -C "$source_repo" commit -am "main change" >/dev/null
    if git -C "$source_repo" merge feature >/dev/null 2>&1; then
        fail "Expected merge to conflict in unmerged overlay smoke test"
    fi
    assert_contains "$source_repo/conflict.txt" "<<<<<<<"

    (
        export HOME="$workspace/home"
        export XDG_DATA_HOME="$workspace/xdg-data"
        export XDG_STATE_HOME="$workspace/xdg-state"
        mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        # shellcheck disable=SC1091
        source "$REPO_DIR/contrib/user-local-install/files/.local/lib/codex-desktop-linux/common.sh"

        INSTALL_CONFIG_FILE="$install_env"
        cat > "$INSTALL_CONFIG_FILE" <<EOF
SOURCE_REPO_DIR=$(printf '%q' "$source_repo")
MANAGED_REPO_DIR=$(printf '%q' "$managed_repo")
REPO_ORIGIN_URL=$(printf '%q' "$origin_repo")
REPO_DEFAULT_BRANCH=$(printf '%q' "main")
OPT_ROOT=$(printf '%q' "$workspace/opt")
EOF

        prepare_build_repo

        [ "$(cat "$MANAGED_REPO_DIR/conflict.txt")" = "base" ] \
            || fail "Expected managed checkout to keep clean upstream content for unmerged overlay paths"
        assert_not_contains "$MANAGED_REPO_DIR/conflict.txt" "<<<<<<<"
    )
}

test_launcher_warm_start_recovery() {
    info "Checking warm-start recovery after launcher SIGKILL"
    bash "$REPO_DIR/tests/launcher_warm_start_recovery.sh"
    CODEX_TEST_DISABLE_WARM_START=1 bash "$REPO_DIR/tests/launcher_warm_start_recovery.sh"
    CODEX_TEST_KILL_DURING_PRELAUNCH=1 bash "$REPO_DIR/tests/launcher_warm_start_recovery.sh"
}

test_notification_actions_bridge_accepts_prebuilt_binary() {
    local workspace="$TMP_DIR/notification-actions-bridge"
    local source_binary="$workspace/prebuilt/codex-notification-actions-linux"
    local install_dir="$workspace/codex-app"
    local target_binary="$install_dir/resources/native/codex-notification-actions-linux"

    mkdir -p "$(dirname "$source_binary")" "$install_dir/resources/native"
    cp "$TRUE_BIN" "$source_binary"
    chmod 0755 "$source_binary"

    (
        export SCRIPT_DIR="$REPO_DIR"
        export INSTALL_DIR="$install_dir"
        export CODEX_NOTIFICATION_ACTIONS_SOURCE="$source_binary"
        # shellcheck disable=SC1091
        source "$REPO_DIR/scripts/lib/notification-actions.sh"
        stage_linux_notification_actions_bridge
    )

    assert_file_exists "$target_binary"
    assert_mode "$target_binary" "755"
}

main() {
    test_common_helper_sourcing
    test_package_icon_source_resolution
    test_extract_webview_replaces_linux_icon_assets
    test_installer_prefers_compact_upstream_chatgpt_icon
    test_user_local_icon_prefers_generated_app_icon
    test_extract_webview_requires_entrypoint
    test_package_layout_requires_webview_entrypoint
    test_package_payload_permission_normalization
    test_deb_builder_smoke
    test_deb_builder_rebuilds_deleted_updater_source
    test_update_builder_preserves_enabled_linux_features_config
    test_update_builder_source_info_survives_without_git_checkout
    test_linux_feature_package_hook_discovery_failure_blocks_build
    test_deb_builder_respects_package_identity
    test_deb_builder_without_updater
    test_no_updater_cleanup_helper_removes_inactive_user_enablement
    test_update_manager_service_helper_respects_disabled_service
    test_rpm_builder_smoke
    test_pacman_builder_without_updater_transition_hook
    test_appimage_builder_smoke
    test_missing_input_failure
    test_make_install_reports_missing_native_packages
    test_make_run_app_reports_missing_launcher
    test_make_build_app_uses_installer_download_flow_by_default
    test_make_build_app_fresh_uses_installer_fresh_flow
    test_make_build_dev_app_writes_host_portable_launcher_symlink
    test_installer_refreshes_stale_cached_dmg_metadata
    test_extract_dmg_repairs_safe_7z_link_warnings
    test_fresh_install_removes_cached_dmg_metadata
    test_fresh_pinned_dmg_preserves_cached_dmg_metadata
    test_fresh_reuse_dmg_uses_cache_when_metadata_matches
    test_rebuild_candidate_uses_validated_default_dmg
    test_make_rebuild_targets_omit_empty_dmg_argument
    test_candidate_install_is_transactional
    test_candidate_promotion_stops_when_journal_prepare_fails
    test_candidate_prepare_failure_cleans_transaction_metadata
    test_candidate_first_install_rename_failure_propagates
    test_candidate_promotion_refuses_a_running_final_app
    test_candidate_backup_retention_is_bounded
    test_candidate_promotion_recovers_after_sigkill
    test_candidate_backup_cleanup_retries_after_failure
    test_candidate_promotion_is_serialized
    test_user_local_updates_preserve_the_running_app_gate
    test_transactional_install_reenters_with_current_bash
    test_transactional_install_uses_managed_node_and_isolated_reports
    test_installer_cleanup_handles_readonly_trees
    test_native_shortcut_targets_compose_existing_flows
    test_sudo_alert_wrapper
    test_native_sudo_alert_wiring
    test_fedora_dependency_bootstrap_installs_rpmbuild
    test_fedora_atomic_rpm_ostree_target_detection
    test_setup_native_wizard_noninteractive_feature_writer
    test_setup_native_wizard_rejects_invalid_feature_ids
    test_setup_native_wizard_rejects_features_without_readme
    test_setup_native_wizard_rejects_conflicting_feature_ids
    test_setup_native_wizard_disable_is_non_destructive
    test_setup_native_wizard_accepts_numbered_feature_selection
    test_setup_native_wizard_rejects_out_of_range_feature_numbers
    test_setup_native_wizard_summary_keeps_existing_config
    test_setup_native_wizard_lists_local_features
    test_setup_native_wizard_uses_package_name_for_installed_state
    test_setup_native_wizard_portal_summary_survives_busctl_sigpipe
    test_setup_native_wizard_warns_when_conversation_mode_lacks_read_aloud
    test_setup_native_wizard_dry_runs_deps_and_install_native
    test_setup_native_wizard_prints_deep_readiness_guidance
    test_setup_native_wizard_uinput_stat_is_bounded
    test_setup_native_wizard_read_aloud_paths_match_runtime_defaults
    test_setup_native_wizard_sway_hint_is_conservative
    test_setup_native_wizard_cleanup_requires_interactive_confirmation
    test_setup_native_wizard_dry_run_cleanup_allows_noninteractive_preview
    test_setup_native_wizard_blank_interactive_cleanup_ids_skip_cleanup
    test_setup_native_wizard_dry_run_cleanup_does_not_delete_confirmed_paths
    test_setup_native_wizard_cleanup_deletes_only_confirmed_paths
    test_update_nix_hashes_skips_unchanged_package_verification
    test_update_nix_hashes_verifies_changed_pins
    test_update_nix_hashes_verifies_changed_dmg_hash
    test_update_nix_hashes_supports_focused_verification_output
    test_update_nix_hashes_skips_output_build_when_refresh_ref_already_matches
    test_ci_local_mounts_shared_git_metadata_for_linked_worktrees
    test_installer_detects_electron_version_from_plist
    test_installer_keeps_electron_fallback_for_bad_metadata
    test_port_validation_rejects_oversized_numeric_values
    test_managed_node_runtime_source_install
    test_managed_node_runtime_rejects_version_only_stub
    test_better_sqlite3_electron_42_source_patch
    test_v8_nullptr_workaround_skips_when_included_probe_succeeds
    test_v8_nullptr_workaround_wraps_when_included_probe_fails
    test_native_module_rebuild_uses_local_electron_rebuild_toolchain
    test_native_module_rebuild_accepts_prebuilt_source
    test_bundled_plugin_builders_accept_prebuilt_binaries
    test_notification_actions_bridge_accepts_prebuilt_binary
    test_bundled_plugin_system_computer_use_preserves_cosmic_helper_name
    test_browser_use_node_repl_fallback_runtime
    test_browser_use_file_url_policy_patch_behavior
    test_browser_plugin_renamed_upstream_staging
    test_upstream_bundled_skills_staging
    test_upstream_bundled_skills_validator_guards
    test_upstream_bundled_skills_rejects_unsafe_source
    test_upstream_bundled_skills_post_copy_validation
    test_upstream_bundled_skills_replaces_target_symlink_safely
    test_upstream_bundled_skills_backup_cleanup_failure_is_recoverable
    test_upstream_bundled_skills_stage_failure_restores_target
    test_portable_bundled_plugins_staging
    test_portable_bundled_plugins_reject_unsafe_content
    test_portable_bundled_plugin_validator_guards
    test_portable_bundled_plugin_stage_failures
    test_portable_bundled_plugin_marketplace_path_guard
    test_browser_use_node_repl_glibc_pidfd_patch_static
    test_browser_use_node_repl_ldd_output_compatibility
    test_chrome_plugin_staging
    test_chrome_marketplace_fallback_synthesis
    test_chrome_native_host_manifest_writer
    test_launcher_managed_node_handles_unset_path
    test_launcher_captures_original_ld_library_path_state
    test_packaged_runtime_keeps_managed_node_out_of_user_service_path
    test_launcher_extra_bundled_plugin_cache_rollback
    test_launcher_extra_bundled_plugin_cache_concurrent_destination
    test_launcher_rejects_missing_webview_entrypoint
    test_launcher_marketplace_metadata_atomic_staging
    test_launcher_template_sanity
    test_launcher_warm_start_recovery
    test_launcher_cli_resolution_policy
    test_webview_server_cache_policy
    test_process_detection_helper_cmdline_shapes
    test_webview_probe_equivalence
    test_side_by_side_launcher_identity
    test_linux_file_manager_patch_smoke
    test_linux_translucent_sidebar_default_patch_smoke
    test_keybinds_settings_tab_patch_smoke
    test_keybinds_settings_patch_warns_on_bundle_shape_miss
    test_linux_tray_patch_smoke
    test_linux_explicit_quit_patch_smoke
    test_browser_annotation_screenshot_patch_smoke
    test_linux_single_instance_patch_smoke
    test_linux_computer_use_gate_patch_smoke
    test_linux_computer_use_ui_opt_in_smoke
    test_linux_file_manager_patch_fails_soft
    test_patcher_enforce_critical_gate
    test_user_local_prepare_build_repo_overlays_committed_local_changes
    test_user_local_prepare_build_repo_detects_default_branch_without_recorded_branch
    test_user_local_prepare_build_repo_ignores_stale_recorded_default_branch
    test_user_local_prepare_build_repo_ignores_stale_source_origin_head
    test_user_local_prepare_build_repo_handles_relative_origin_url
    test_desktop_entry_doctor_repairs_only_legacy_generated_entries
    test_user_local_install_from_update_defers_record_only_metadata
    test_user_local_install_preserves_persisted_x11_preference_on_refresh
    test_user_local_prepare_build_repo_copies_enabled_local_features
    test_user_local_prepare_build_repo_updates_existing_single_branch_fetch_refspec
    test_user_local_prepare_build_repo_handles_deleted_overlay_paths
    test_user_local_prepare_build_repo_removes_rename_source_paths
    test_user_local_prepare_build_repo_skips_unmerged_overlay_paths
    info "All script smoke tests passed"
}

main "$@"
