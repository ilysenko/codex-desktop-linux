#!/bin/bash

info() {
    echo "[INFO] $*" >&2
}

warn() {
    echo "[WARN] $*" >&2
}

error() {
    echo "[ERROR] $*" >&2
    exit 1
}

ensure_file_exists() {
    local path="$1"
    local label="$2"
    [ -f "$path" ] || error "Missing $label: $path"
}

ensure_app_layout() {
    [ -d "$APP_DIR" ] || error "Missing app directory: $APP_DIR. Run ./install.sh first."
    [ -x "$APP_DIR/start.sh" ] || error "Missing launcher: $APP_DIR/start.sh"
    [ -x "$APP_DIR/ChatGPT" ] || error "Missing official ChatGPT runtime: $APP_DIR/ChatGPT. Run ./install.sh first."
    [ -f "$APP_DIR/resources/app.asar" ] || error "Missing official app.asar: $APP_DIR/resources/app.asar. Run ./install.sh first."
    [ -x "$APP_DIR/resources/codex" ] || error "Missing bundled Codex CLI: $APP_DIR/resources/codex. Run ./install.sh first."
}

upstream_linux_control_field() {
    local field_name="$1"
    local control_file="$APP_DIR/.codex-linux/upstream-package/control"
    local node_bin

    ensure_file_exists "$control_file" "official Linux package control metadata"
    node_bin="$(package_node_binary)"
    "$node_bin" - "$control_file" "$field_name" <<'NODE'
const fs = require("node:fs");
const [controlPath, fieldName] = process.argv.slice(2);
const fields = new Map();
let current = null;
for (const line of fs.readFileSync(controlPath, "utf8").split(/\r?\n/)) {
  if (/^[ \t]/.test(line) && current != null) {
    fields.set(current, `${fields.get(current)} ${line.trim()}`);
    continue;
  }
  const separator = line.indexOf(":");
  if (separator < 1) {
    current = null;
    continue;
  }
  current = line.slice(0, separator);
  fields.set(current, line.slice(separator + 1).trim());
}
process.stdout.write(fields.get(fieldName) ?? "");
NODE
}

official_payload_deb_architecture() {
    local architecture
    architecture="$(upstream_linux_control_field Architecture)"
    case "$architecture" in
        amd64|arm64) printf '%s\n' "$architecture" ;;
        *) error "Unsupported official payload architecture '${architecture:-missing}'; expected amd64 or arm64" ;;
    esac
}

assert_official_payload_architecture() {
    local host_architecture="$1"
    local payload_architecture
    payload_architecture="$(official_payload_deb_architecture)"
    [ "$payload_architecture" = "$host_architecture" ] || \
        error "Official payload architecture is '$payload_architecture', but this package builder targets '$host_architecture'"
}

sed_escape_replacement() {
    printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

package_with_updater_enabled() {
    case "${PACKAGE_WITH_UPDATER:-1}" in
        1|true|True|TRUE|yes|Yes|YES|on|On|ON)
            return 0
            ;;
        0|false|False|FALSE|no|No|NO|off|Off|OFF)
            return 1
            ;;
        *)
            error "PACKAGE_WITH_UPDATER must be 1 or 0"
            ;;
    esac
}

package_node_binary() {
    command -v node >/dev/null 2>&1 || error "node is required"
    command -v node
}

linux_feature_enabled() {
    local feature_id="$1"
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local node_bin
    local enabled_output

    [ -f "$helper" ] || error "Missing Linux features helper: $helper"
    node_bin="$(package_node_binary)"
    if ! enabled_output="$("$node_bin" "$helper" --enabled)"; then
        error "Failed to discover enabled Linux features"
    fi
    grep -Fxq "$feature_id" <<<"$enabled_output"
}

stage_update_builder_linux_features_config() {
    local update_builder_root="$1"
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local target="$update_builder_root/linux-features/features.json"
    local node_bin

    [ -f "$helper" ] || error "Missing Linux features helper: $helper"

    node_bin="$(package_node_binary)"
    "$node_bin" - "$helper" "$target" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const helperPath = path.resolve(process.argv[2]);
const targetPath = path.resolve(process.argv[3]);
const { enabledLinuxFeaturesConfig } = require(helperPath);

const config = enabledLinuxFeaturesConfig();
if (config.enabled.length === 0) {
  fs.rmSync(targetPath, { force: true });
  process.exit(0);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
}

linux_features_root_path() {
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local node_bin

    [ -f "$helper" ] || error "Missing Linux features helper: $helper"

    node_bin="$(package_node_binary)"
    "$node_bin" "$helper" --features-root
}

stage_update_builder_linux_features_tree() {
    local update_builder_root="$1"
    local source_root
    local target="$update_builder_root/linux-features"

    source_root="$(linux_features_root_path)"
    [ -d "$source_root" ] || error "Missing Linux features root: $source_root"

    mkdir -p "$target"
    cp "$source_root/features.example.json" "$target/features.example.json"
    cp "$source_root/compatibility.json" "$target/compatibility.json"

    local feature_id
    while IFS= read -r feature_id; do
        [ -n "$feature_id" ] || continue
        [ -d "$source_root/$feature_id" ] || error "Missing enabled Linux feature: $feature_id"
        cp -a "$source_root/$feature_id" "$target/$feature_id"
        find "$target/$feature_id" -type d -name target -prune -exec rm -rf {} +
        if [ "$feature_id" = "mcp-helper-reaper" ]; then
            rm -rf \
                "$target/$feature_id/reaper/src" \
                "$target/$feature_id/reaper/Cargo.toml" \
                "$target/$feature_id/reaper/Cargo.lock"
        fi
    done < <("$(package_node_binary)" "$REPO_DIR/scripts/lib/linux-features.js" --enabled)
}

stage_update_builder_enabled_plugin_templates() {
    local update_builder_root="$1"
    local feature_id
    local plugin_id

    while IFS= read -r feature_id; do
        case "$feature_id" in
            computer-use-linux) plugin_id="computer-use" ;;
            read-aloud-mcp) plugin_id="read-aloud" ;;
            *) continue ;;
        esac
        local source="$REPO_DIR/plugins/openai-bundled/plugins/$plugin_id"
        local target="$update_builder_root/plugins/openai-bundled/plugins/$plugin_id"
        [ -d "$source" ] || error "Missing enabled Linux feature plugin template: $source"
        mkdir -p "$(dirname "$target")"
        cp -a "$source" "$target"
    done < <("$(package_node_binary)" "$REPO_DIR/scripts/lib/linux-features.js" --enabled)
}

run_linux_feature_package_hooks() {
    local staging_root="$1"
    local package_format="$2"
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local node_bin
    local feature_id
    local hook_path
    local hooks_output
    local app_dir="$staging_root/opt/$PACKAGE_NAME"

    [ -d "$staging_root" ] || error "Missing package staging root: $staging_root"
    [ -f "$helper" ] || error "Missing Linux features helper: $helper"

    node_bin="$(package_node_binary)"
    if ! hooks_output="$("$node_bin" "$helper" --package-hooks "$package_format" "$app_dir")"; then
        error "Failed to discover Linux feature package hooks for $package_format"
    fi

    while IFS=$'\t' read -r feature_id hook_path; do
        [ -n "${feature_id:-}" ] || continue
        [ -f "$hook_path" ] || error "Missing Linux feature package hook for $feature_id: $hook_path"

        info "Running Linux feature package hook ($package_format): $feature_id"
        REPO_DIR="$REPO_DIR" \
            SCRIPT_DIR="$REPO_DIR" \
            APP_DIR="$app_dir" \
            PACKAGE_APP_DIR="$app_dir" \
            PACKAGE_NAME="$PACKAGE_NAME" \
            PACKAGE_VERSION="$PACKAGE_VERSION" \
            PACKAGE_FORMAT="$package_format" \
            PACKAGE_ROOT="$staging_root" \
            PACKAGE_STAGING_ROOT="$staging_root" \
            bash "$hook_path"
    done <<< "$hooks_output"
}

stage_linux_feature_package_resources() {
    local staging_root="$1"
    local package_format="$2"
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local node_bin
    local app_dir="$staging_root/opt/$PACKAGE_NAME"

    [ -d "$staging_root" ] || error "Missing package staging root: $staging_root"
    [ -f "$helper" ] || error "Missing Linux features helper: $helper"
    node_bin="$(package_node_binary)"
    "$node_bin" "$helper" --stage-package-resources "$package_format" "$staging_root" "$app_dir"
}

linux_feature_package_dependencies() {
    local package_format="$1"
    local app_dir="$2"
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local node_bin

    [ -f "$helper" ] || error "Missing Linux features helper: $helper"
    node_bin="$(package_node_binary)"
    "$node_bin" "$helper" --package-dependencies "$package_format" "$app_dir"
}

linux_feature_package_files() {
    local package_format="$1"
    local app_dir="$2"
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local node_bin

    [ -f "$helper" ] || error "Missing Linux features helper: $helper"
    node_bin="$(package_node_binary)"
    "$node_bin" "$helper" --package-files "$package_format" "$app_dir"
}

linux_feature_package_dependency_suffix() {
    local package_format="$1"
    local app_dir="$2"
    local dependencies_output
    local dependency
    local suffix=""

    if ! dependencies_output="$(linux_feature_package_dependencies "$package_format" "$app_dir")"; then
        return 1
    fi
    while IFS= read -r dependency; do
        [ -n "$dependency" ] || continue
        suffix+=", $dependency"
    done <<< "$dependencies_output"
    printf '%s' "$suffix"
}

replace_literal_file_token() {
    local target="$1"
    local token="$2"
    local replacement="$3"
    local node_bin

    node_bin="$(package_node_binary)"
    "$node_bin" - "$target" "$token" "$replacement" <<'NODE'
const fs = require("node:fs");
const [target, token, replacement] = process.argv.slice(2);
const source = fs.readFileSync(target, "utf8");
if (!source.includes(token)) {
  throw new Error(`Template token not found in ${target}: ${token}`);
}
fs.writeFileSync(target, source.split(token).join(replacement));
NODE
}

render_desktop_entry() {
    local target="$1"
    local package_name
    local display_name
    local comment
    local rendered_target="$target.tmp"

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    display_name="$(sed_escape_replacement "${PACKAGE_DISPLAY_NAME:-ChatGPT Community}")"
    comment="$(sed_escape_replacement "${PACKAGE_COMMENT:-Community Linux distribution based on OpenAI ChatGPT}")"

    awk \
        -v package_name="$package_name" \
        -v display_name="$display_name" \
        -v comment="$comment" '
            BEGIN { in_desktop_entry = 0 }
            /^\[Desktop Entry\]$/ {
                in_desktop_entry = 1
                gsub(/codex-desktop/, package_name)
                print
                next
            }
            /^\[/ {
                in_desktop_entry = 0
            }
            {
                gsub(/codex-desktop/, package_name)
                if (in_desktop_entry && /^Name=/) {
                    print "Name=" display_name
                    next
                }
                if (in_desktop_entry && /^Comment=/) {
                    print "Comment=" comment
                    next
                }
                print
            }
        ' "$DESKTOP_TEMPLATE" > "$rendered_target"
    if package_with_updater_enabled; then
        mv "$rendered_target" "$target"
    else
        awk '
            BEGIN { actions_rewritten = 0 }
            /^\[Desktop Action CheckForUpdates\]$/ { skip = 1; next }
            /^\[Desktop Action InstallReadyUpdate\]$/ { skip = 1; next }
            /^\[/ { skip = 0 }
            skip { next }
            /^Actions=/ {
                print "Actions=new-window;"
                actions_rewritten = 1
                next
            }
            { print }
            END {
                if (actions_rewritten == 0) {
                    print "Actions=new-window;"
                }
            }
        ' "$rendered_target" > "$target"
        rm -f "$rendered_target"
    fi
    chmod 0644 "$target"
}

resolve_package_icon_source() {
    if [ -n "${PACKAGE_ICON_SOURCE:-}" ]; then
        printf '%s\n' "$PACKAGE_ICON_SOURCE"
        return 0
    fi
    printf '%s\n' "$REPO_DIR/assets/codex-linux.png"
}

render_packaged_runtime_helper() {
    local target="$1"
    local package_name

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    if ! package_with_updater_enabled; then
        cat > "$target" <<SCRIPT
#!/bin/bash

codex_packaged_runtime_export_env() {
    export CHROME_DESKTOP="$package_name.desktop"
    export BAMF_DESKTOP_FILE_HINT="/usr/share/applications/$package_name.desktop"
}
SCRIPT
        chmod 0644 "$target"
        return
    fi

    sed -e "s/codex-desktop/$package_name/g" "$PACKAGED_RUNTIME_SOURCE" > "$target"
    chmod 0644 "$target"
}

render_no_updater_transition_cleanup_helper() {
    local target="$1"

    cat > "$target" <<'SCRIPT'
#!/bin/sh

SERVICE_NAME="${SERVICE_NAME:-codex-update-manager.service}"

codex_no_updater_foreach_user_manager() {
    if ! command -v runuser >/dev/null 2>&1 ||
        ! command -v systemctl >/dev/null 2>&1 ||
        ! command -v getent >/dev/null 2>&1; then
        return
    fi

    for runtime_dir in /run/user/*; do
        [ -d "$runtime_dir" ] || continue

        uid="$(basename "$runtime_dir")"
        case "$uid" in
            ''|*[!0-9]*|0)
                continue
                ;;
        esac

        bus="$runtime_dir/bus"
        [ -S "$bus" ] || continue

        user_name="$(getent passwd "$uid" | cut -d: -f1 || true)"
        [ -n "$user_name" ] || continue

        "$@" "$user_name" "$runtime_dir" "$bus"
    done
}

codex_no_updater_run_systemctl_user() {
    user_name="$1"
    runtime_dir="$2"
    bus="$3"
    shift 3

    runuser -u "$user_name" -- env \
        XDG_RUNTIME_DIR="$runtime_dir" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=$bus" \
        systemctl --user "$@" >/dev/null 2>&1
}

codex_no_updater_cleanup_one_user_manager() {
    user_name="$1"
    runtime_dir="$2"
    bus="$3"

    codex_no_updater_run_systemctl_user "$user_name" "$runtime_dir" "$bus" stop "$SERVICE_NAME" || true
    codex_no_updater_run_systemctl_user "$user_name" "$runtime_dir" "$bus" disable "$SERVICE_NAME" || true
    codex_no_updater_run_systemctl_user "$user_name" "$runtime_dir" "$bus" daemon-reload || true
}

codex_no_updater_cleanup_user_enablement_links() {
    if ! command -v getent >/dev/null 2>&1 || ! command -v runuser >/dev/null 2>&1; then
        return
    fi

    getent passwd | while IFS=: read -r user_name _ uid _ _ home _; do
        case "$uid" in
            ''|*[!0-9]*|0)
                continue
                ;;
        esac

        [ -n "$home" ] || continue
        [ "$home" != "/" ] || continue

        wants_dir="$home/.config/systemd/user/default.target.wants"
        service_link="$wants_dir/$SERVICE_NAME"
        [ -L "$service_link" ] || continue

        runuser -u "$user_name" -- rm -f "$service_link" >/dev/null 2>&1 || true
    done
}

codex_no_updater_cleanup_update_manager_service() {
    codex_no_updater_foreach_user_manager codex_no_updater_cleanup_one_user_manager
    codex_no_updater_cleanup_user_enablement_links
}
SCRIPT
    chmod 0644 "$target"
}

render_desktop_entry_doctor_helper() {
    local target="$1"

    cp "$REPO_DIR/packaging/linux/codex-desktop-entry-doctor.sh" "$target"
    chmod 0644 "$target"
}

write_no_updater_deb_postinst() {
    local target="$1"
    local package_name

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    cat > "$target" <<SCRIPT
#!/bin/sh
set -eu

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

CLEANUP_HELPER="/opt/$package_name/.codex-linux/codex-no-updater-transition-cleanup.sh"
DESKTOP_ENTRY_DOCTOR="/opt/$package_name/.codex-linux/codex-desktop-entry-doctor.sh"
if [ -f "\$CLEANUP_HELPER" ]; then
    # shellcheck source=/opt/$package_name/.codex-linux/codex-no-updater-transition-cleanup.sh
    . "\$CLEANUP_HELPER"
    codex_no_updater_cleanup_update_manager_service || true
fi
if [ -f "\$DESKTOP_ENTRY_DOCTOR" ]; then
    # shellcheck source=/opt/$package_name/.codex-linux/codex-desktop-entry-doctor.sh
    . "\$DESKTOP_ENTRY_DOCTOR"
    codex_desktop_repair_system_package_shadow_entries $package_name || true
fi

exit 0
SCRIPT
    chmod 0755 "$target"
}

append_deb_apparmor_postinst() {
    local target="$1"
    local package_name
    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    sed -i '/^exit 0$/d' "$target"
    cat >> "$target" <<SCRIPT

if command -v aa-enabled >/dev/null 2>&1 &&
   command -v apparmor_parser >/dev/null 2>&1 &&
   aa-enabled --quiet && [ -f "/etc/apparmor.d/$package_name" ]; then
    apparmor_parser -r -W -T "/etc/apparmor.d/$package_name" >/dev/null 2>&1 || true
fi

exit 0
SCRIPT
}

write_no_updater_deb_prerm() {
    local target="$1"
    local package_name

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    cat > "$target" <<SCRIPT
#!/bin/sh
set -eu

CLEANUP_HELPER="/opt/$package_name/.codex-linux/codex-no-updater-transition-cleanup.sh"
if [ -f "\$CLEANUP_HELPER" ]; then
    # shellcheck source=/opt/$package_name/.codex-linux/codex-no-updater-transition-cleanup.sh
    . "\$CLEANUP_HELPER"
    codex_no_updater_cleanup_update_manager_service || true
fi

exit 0
SCRIPT
    chmod 0755 "$target"
}

write_no_updater_pacman_install_hooks() {
    local target="$1"
    local package_name

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    cat > "$target" <<SCRIPT
CLEANUP_HELPER="/opt/$package_name/.codex-linux/codex-no-updater-transition-cleanup.sh"
DESKTOP_ENTRY_DOCTOR="/opt/$package_name/.codex-linux/codex-desktop-entry-doctor.sh"

codex_no_updater_cleanup_if_present() {
    if [ -f "\$CLEANUP_HELPER" ]; then
        # shellcheck source=/opt/$package_name/.codex-linux/codex-no-updater-transition-cleanup.sh
        . "\$CLEANUP_HELPER"
        codex_no_updater_cleanup_update_manager_service || true
    fi
}

codex_desktop_repair_if_present() {
    if [ -f "\$DESKTOP_ENTRY_DOCTOR" ]; then
        # shellcheck source=/opt/$package_name/.codex-linux/codex-desktop-entry-doctor.sh
        . "\$DESKTOP_ENTRY_DOCTOR"
        codex_desktop_repair_system_package_shadow_entries $package_name || true
    fi
}

post_install() {
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
    fi
    codex_desktop_repair_if_present
    codex_no_updater_cleanup_if_present
}

post_upgrade() {
    post_install
}

pre_remove() {
    codex_no_updater_cleanup_if_present
}
SCRIPT
    chmod 0644 "$target"
}

updater_binary_is_stale() {
    local binary="$1"

    [ -x "$binary" ] || return 0

    local source
    for source in "$REPO_DIR/Cargo.toml" "$REPO_DIR/Cargo.lock"; do
        if [ -f "$source" ] && [ "$source" -nt "$binary" ]; then
            return 0
        fi
    done

    while IFS= read -r -d '' source; do
        if [ "$source" -nt "$binary" ]; then
            return 0
        fi
    done < <(find "$REPO_DIR/updater" -type f -print0 2>/dev/null)

    return 1
}

find_cargo_command() {
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

updater_build_output_binary() {
    local target_dir="${CARGO_TARGET_DIR:-$REPO_DIR/target}"
    case "$target_dir" in
        /*) ;;
        *) target_dir="$REPO_DIR/$target_dir" ;;
    esac
    printf '%s\n' "$target_dir/release/codex-update-manager"
}

ensure_updater_binary() {
    local cargo_cmd=""
    local built_binary=""

    if ! package_with_updater_enabled; then
        return
    fi

    if [ -x "$UPDATER_BINARY_SOURCE" ] && ! updater_binary_is_stale "$UPDATER_BINARY_SOURCE"; then
        return
    fi

    [ -f "$REPO_DIR/Cargo.toml" ] || error "Missing updater binary: $UPDATER_BINARY_SOURCE"
    cargo_cmd="$(find_cargo_command)" || error "cargo is required to build codex-update-manager.
Install the Rust toolchain:
  bash scripts/install-deps.sh        # auto-installs via rustup
  # or manually: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"

    info "Building codex-update-manager release binary"
    "$cargo_cmd" build --release -p codex-update-manager >&2
    built_binary="$(updater_build_output_binary)"
    if [ -x "$built_binary" ]; then
        UPDATER_BINARY_SOURCE="$built_binary"
    fi
    [ -x "$UPDATER_BINARY_SOURCE" ] || error "Failed to build updater binary: $UPDATER_BINARY_SOURCE"
}

stage_update_builder_source_info() {
    local update_builder_root="$1"
    local info_dir="$update_builder_root/.codex-linux"
    local info_file="$info_dir/source-info.json"
    local node_bin

    mkdir -p "$info_dir"
    node_bin="$(package_node_binary)"
    "$node_bin" - "$REPO_DIR" "$info_file" <<'NODE'
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [repoDir, infoFile] = process.argv.slice(2);

function git(args) {
  const result = childProcess.spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function isoTimestamp() {
  const rawEpoch = process.env.SOURCE_DATE_EPOCH?.trim();
  if (rawEpoch) {
    const epochSeconds = Number(rawEpoch);
    if (Number.isFinite(epochSeconds) && epochSeconds >= 0) {
      return new Date(Math.trunc(epochSeconds) * 1000).toISOString();
    }
  }
  return new Date().toISOString();
}

function sanitizeGitRemoteUrl(remote) {
  if (remote == null) {
    return null;
  }
  const value = String(remote).trim();
  if (value.length === 0 || path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return null;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      return url.toString();
    }
  } catch {
    return value;
  }
  return value;
}

function readJsonFile(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value != null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseWrapperVersion(content) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^version\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function readWrapperVersion(repoDir) {
  try {
    return parseWrapperVersion(fs.readFileSync(path.join(repoDir, "updater", "Cargo.toml"), "utf8"));
  } catch {
    return null;
  }
}

function sanitizeSourceInfo(info) {
  const remote = sanitizeGitRemoteUrl(info.remote);
  return {
    ...info,
    version: info.version ?? readWrapperVersion(repoDir),
    remote,
    commitUrl: githubCommitUrl(remote, info.commit),
    provenance: info.provenance ?? "packaged-update-builder",
    recapturedAt: isoTimestamp(),
  };
}

function githubCommitUrl(remote, commit) {
  const sha = typeof commit === "string" ? commit.trim() : "";
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return null;
  }
  const value = sanitizeGitRemoteUrl(remote);
  if (value == null) {
    return null;
  }

  let ownerAndRepo = null;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    ownerAndRepo = url.pathname.replace(/^\/+/, "");
  } catch {
    const scpMatch = value.match(/^(?:[^@]+@)?github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (scpMatch) {
      ownerAndRepo = scpMatch[1];
    }
  }

  if (ownerAndRepo == null) {
    return null;
  }
  ownerAndRepo = ownerAndRepo.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(ownerAndRepo)) {
    return null;
  }
  return `https://github.com/${ownerAndRepo}/commit/${sha}`;
}

const stagedInfo = readJsonFile(path.join(repoDir, ".codex-linux", "source-info.json"));
const commit = process.env.CODEX_LINUX_SOURCE_COMMIT?.trim() || git(["rev-parse", "HEAD"]);
const status = git(["status", "--porcelain"]);
const remote = sanitizeGitRemoteUrl(process.env.CODEX_LINUX_SOURCE_REMOTE?.trim() || git(["remote", "get-url", "origin"]));
const info = stagedInfo?.commit
  ? sanitizeSourceInfo(stagedInfo)
  : {
      commit,
      shortCommit: commit == null ? null : commit.slice(0, 12),
      version: readWrapperVersion(repoDir),
      branch: process.env.CODEX_LINUX_SOURCE_BRANCH?.trim() || git(["branch", "--show-current"]),
      remote,
      commitUrl: githubCommitUrl(remote, commit),
      describe: process.env.CODEX_LINUX_SOURCE_DESCRIBE?.trim() || git(["describe", "--always", "--dirty", "--tags"]),
      dirty: status == null ? null : status.length > 0,
      provenance: "packaged-update-builder",
      capturedAt: isoTimestamp(),
    };

fs.mkdirSync(path.dirname(infoFile), { recursive: true });
fs.writeFileSync(infoFile, `${JSON.stringify(info, null, 2)}\n`, "utf8");
NODE
}

write_update_builder_manifest() {
    local update_builder_root="$1"
    local manifest="$update_builder_root/.codex-linux/update-builder-manifest.txt"
    (
        cd "$update_builder_root"
        find . -mindepth 1 -type f \
            ! -path './.codex-linux/update-builder-manifest.txt' \
            -printf '%P\n' | LC_ALL=C sort > "$manifest"
    )
}

stage_common_package_files() {
    local root="$1"
    local app_root="$root/opt/$PACKAGE_NAME"
    local polkit_policy="$REPO_DIR/packaging/linux/com.github.ilysenko.codex-desktop-linux.update.policy"

    ensure_app_layout

    if package_with_updater_enabled; then
        ensure_file_exists "$polkit_policy" "polkit policy"
    fi

    mkdir -p \
        "$root/opt" \
        "$root/usr/bin" \
        "$root/usr/share/applications" \
        "$root/usr/share/icons/hicolor/256x256/apps" \
        "$root/etc/apparmor.d"
    if package_with_updater_enabled; then
        mkdir -p \
            "$root/usr/lib/systemd/user" \
            "$root/usr/share/polkit-1/actions"
    fi

    rm -rf "$app_root"
    cp -aT "$APP_DIR" "$app_root"
    mkdir -p "$app_root/.codex-linux"
    cp "$ICON_SOURCE" "$app_root/.codex-linux/$PACKAGE_NAME.png"
    cp "$ICON_SOURCE" "$app_root/resources/icon-chatgpt.png"
    render_desktop_entry_doctor_helper "$app_root/.codex-linux/codex-desktop-entry-doctor.sh"
    render_desktop_entry "$root/usr/share/applications/$PACKAGE_NAME.desktop"
    cp "$ICON_SOURCE" "$root/usr/share/icons/hicolor/256x256/apps/$PACKAGE_NAME.png"
    render_apparmor_profile "$root/etc/apparmor.d/$PACKAGE_NAME"
    if package_with_updater_enabled; then
        cp "$UPDATER_BINARY_SOURCE" "$root/usr/bin/codex-update-manager"
        chmod 0755 "$root/usr/bin/codex-update-manager"
        cp "$UPDATER_SERVICE_SOURCE" "$root/usr/lib/systemd/user/codex-update-manager.service"
        chmod 0644 "$root/usr/lib/systemd/user/codex-update-manager.service"
        cp "$polkit_policy" "$root/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy"
        chmod 0644 "$root/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy"
    else
        render_no_updater_transition_cleanup_helper \
            "$app_root/.codex-linux/codex-no-updater-transition-cleanup.sh"
    fi
    render_packaged_runtime_helper "$app_root/.codex-linux/codex-packaged-runtime.sh"
}

render_apparmor_profile() {
    local target="$1"
    cat > "$target" <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile $PACKAGE_NAME "/opt/$PACKAGE_NAME/ChatGPT" flags=(unconfined) {
  userns,
  include if exists <local/$PACKAGE_NAME>
}
PROFILE
    chmod 0644 "$target"
}

stage_update_builder_bundle() {
    local root="$1"
    local update_builder_root="$root/opt/$PACKAGE_NAME/update-builder"
    local relative

    mkdir -p \
        "$update_builder_root/scripts/lib" \
        "$update_builder_root/scripts/patches" \
        "$update_builder_root/launcher" \
        "$update_builder_root/packaging/linux" \
        "$update_builder_root/assets"

    cp "$REPO_DIR/install.sh" "$update_builder_root/install.sh"
    cp "$REPO_DIR/launcher/start.sh.template" "$update_builder_root/launcher/start.sh.template"
    cp "$REPO_DIR/scripts/build-deb.sh" "$update_builder_root/scripts/build-deb.sh"
    cp "$REPO_DIR/scripts/build-rpm.sh" "$update_builder_root/scripts/build-rpm.sh"
    cp "$REPO_DIR/scripts/build-pacman.sh" "$update_builder_root/scripts/build-pacman.sh"
    cp "$REPO_DIR/scripts/patch-linux-window-ui.js" "$update_builder_root/scripts/patch-linux-window-ui.js"
    cp -a "$REPO_DIR/scripts/patches/." "$update_builder_root/scripts/patches/"

    for relative in \
        asar-patch.sh \
        build-info.js \
        build-info.sh \
        candidate-install.sh \
        candidate-promotion.py \
        install-helpers.sh \
        linux-features.js \
        linux-features.sh \
        linux-target-context.js \
        package-common.sh \
        patch-report.js \
        patch-validation.js \
        process-detection.sh \
        upstream-linux-package.js \
        upstream-linux-package.sh; do
        cp "$REPO_DIR/scripts/lib/$relative" "$update_builder_root/scripts/lib/$relative"
    done

    cp -a "$REPO_DIR/packaging/linux/." "$update_builder_root/packaging/linux/"
    cp "$REPO_DIR/assets/codex.png" "$update_builder_root/assets/codex.png"
    cp "$REPO_DIR/assets/codex-linux.png" "$update_builder_root/assets/codex-linux.png"
    cp "$REPO_DIR/assets/openai-codex-linux-repository-key.gpg.base64" \
        "$update_builder_root/assets/openai-codex-linux-repository-key.gpg.base64"

    stage_update_builder_linux_features_tree "$update_builder_root"
    stage_update_builder_enabled_plugin_templates "$update_builder_root"
    stage_update_builder_linux_features_config "$update_builder_root"
    stage_enabled_native_feature_artifacts "$update_builder_root"
    stage_update_builder_source_info "$update_builder_root"
    write_update_builder_manifest "$update_builder_root"
}

stage_update_builder_native_artifact() {
    local source="$1"
    local target="$2"
    local label="$3"

    [ -x "$source" ] || error "Missing staged native feature artifact for $label: $source"
    mkdir -p "$(dirname "$target")"
    install -m 0755 "$source" "$target"
}

stage_enabled_native_feature_artifacts() {
    local update_builder_root="$1"
    local feature_id

    while IFS= read -r feature_id; do
        case "$feature_id" in
            computer-use-linux)
                stage_update_builder_native_artifact \
                    "$APP_DIR/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux" \
                    "$update_builder_root/target/release/codex-computer-use-linux" \
                    "$feature_id backend"
                stage_update_builder_native_artifact \
                    "$APP_DIR/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-cosmic" \
                    "$update_builder_root/target/release/codex-computer-use-cosmic" \
                    "$feature_id COSMIC helper"
                ;;
            global-dictation)
                stage_update_builder_native_artifact \
                    "$APP_DIR/resources/native/codex-global-dictation-linux" \
                    "$update_builder_root/global-dictation-linux/target/release/codex-global-dictation-linux" \
                    "$feature_id helper"
                ;;
            mcp-helper-reaper)
                stage_update_builder_native_artifact \
                    "$APP_DIR/.codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper" \
                    "$update_builder_root/linux-features/mcp-helper-reaper/reaper/target/release/codex-mcp-helper-reaper" \
                    "$feature_id helper"
                ;;
            read-aloud-mcp)
                stage_update_builder_native_artifact \
                    "$APP_DIR/resources/plugins/openai-bundled/plugins/read-aloud/bin/codex-read-aloud-linux" \
                    "$update_builder_root/target/release/codex-read-aloud-linux" \
                    "$feature_id backend"
                ;;
            chronicle-skysight)
                stage_update_builder_native_artifact \
                    "$APP_DIR/resources/native/codex-record-replay-linux" \
                    "$update_builder_root/target/release/codex-record-replay-linux" \
                    "$feature_id backend"
                ;;
            *) continue ;;
        esac
    done < <("$(package_node_binary)" "$REPO_DIR/scripts/lib/linux-features.js" --enabled)
}

stage_optional_update_builder_bundle() {
    if package_with_updater_enabled; then
        stage_update_builder_bundle "$@"
    else
        info "Skipping update-builder bundle (PACKAGE_WITH_UPDATER=0)"
    fi
}

restore_linux_feature_payload_permissions() {
    local root="$1"
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local app_root="$root/opt/$PACKAGE_NAME"
    local node_bin
    local staged_files_json

    [ -d "$root" ] || error "Missing package root: $root"
    [ -d "$app_root" ] || error "Missing package app root: $app_root"
    [ -f "$helper" ] || error "Missing Linux features helper: $helper"

    node_bin="$(package_node_binary)"
    if ! staged_files_json="$("$node_bin" "$helper" --staged-files-json "$app_root")"; then
        error "Failed to read Linux feature staged file manifest"
    fi

    if ! "$node_bin" - "$app_root" "$staged_files_json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [appRoot, rawJson] = process.argv.slice(2);
const entries = JSON.parse(rawJson);

if (!Array.isArray(entries)) {
  throw new Error("Linux feature staged files payload must be an array");
}

function assertRelativeTarget(target) {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("Linux feature staged file target must be a relative path");
  }
  const parts = target.split(/[\\/]+/).filter(Boolean);
  if (path.isAbsolute(target) || parts.includes("..")) {
    throw new Error(`Unsafe Linux feature staged file target: ${target}`);
  }
  const resolved = path.resolve(appRoot, ...parts);
  const relative = path.relative(appRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Linux feature staged file target: ${target}`);
  }
  return resolved;
}

for (const entry of entries) {
  if (entry == null || typeof entry !== "object") {
    throw new Error("Linux feature staged file entry must be an object");
  }
  if (typeof entry.mode !== "string" || !/^[0-7]{3,4}$/.test(entry.mode)) {
    throw new Error(`Invalid Linux feature staged file mode for ${entry.target}: ${entry.mode}`);
  }
  const target = assertRelativeTarget(entry.target);
  if (!fs.existsSync(target)) {
    throw new Error(`Linux feature staged file is missing from package payload: ${entry.target}`);
  }
  fs.chmodSync(target, Number.parseInt(entry.mode, 8));
}
NODE
    then
        error "Failed to restore Linux feature staged file permissions"
    fi
}

restore_linux_feature_package_resource_permissions() {
    local root="$1"
    local package_format="$2"
    local helper="$REPO_DIR/scripts/lib/linux-features.js"
    local node_bin
    local app_dir="$root/opt/$PACKAGE_NAME"

    [ -d "$root" ] || error "Missing package root: $root"
    [ -f "$helper" ] || error "Missing Linux features helper: $helper"

    node_bin="$(package_node_binary)"
    if ! "$node_bin" "$helper" \
        --restore-package-resource-permissions "$package_format" "$root" "$app_dir"; then
        error "Failed to restore Linux feature package resource permissions"
    fi
}

normalize_package_payload_permissions() {
    local root="$1"

    [ -d "$root" ] || error "Missing package root: $root"
    find "$root" -type d -exec chmod 0755 {} +
    find "$root" -type f \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0755 {} +
    find "$root" -type f ! \( -perm /u=x -o -perm /g=x -o -perm /o=x \) -exec chmod 0644 {} +
}

write_launcher_stub() {
    local root="$1"

    cat > "$root/usr/bin/$PACKAGE_NAME" <<SCRIPT
#!/usr/bin/env bash
exec /opt/$PACKAGE_NAME/start.sh "\$@"
SCRIPT
    chmod 0755 "$root/usr/bin/$PACKAGE_NAME"
}
