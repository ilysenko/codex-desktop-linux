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
    [ -f "$APP_DIR/content/webview/index.html" ] || error "Missing webview entrypoint: $APP_DIR/content/webview/index.html. Run ./install.sh first."
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
    local managed_node="${APP_DIR:-}/resources/node-runtime/bin/node"
    if [ -x "$managed_node" ] && [ "$("$managed_node" -e 'process.stdout.write("ok")' 2>/dev/null || true)" = "ok" ]; then
        printf '%s\n' "$managed_node"
        return 0
    fi

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

stage_update_builder_global_dictation_source() {
    local update_builder_root="$1"
    local source_root="$REPO_DIR/global-dictation-linux"
    local target_root="$update_builder_root/global-dictation-linux"

    mkdir -p "$target_root/src"
    cp "$source_root/Cargo.toml" "$target_root/Cargo.toml"
    cp "$source_root/Cargo.lock" "$target_root/Cargo.lock"
    cp -R "$source_root/src/." "$target_root/src/"
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
    cp -a "$source_root/." "$target/"
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
    if ! hooks_output="$("$node_bin" "$helper" --package-hooks "$package_format")"; then
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

render_desktop_entry() {
    local target="$1"
    local package_name
    local display_name
    local comment
    local rendered_target="$target.tmp"

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    display_name="$(sed_escape_replacement "${PACKAGE_DISPLAY_NAME:-ChatGPT}")"
    comment="$(sed_escape_replacement "${PACKAGE_COMMENT:-Run ChatGPT Desktop on Linux}")"

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

    local expected_icon="$APP_DIR/.codex-linux/$PACKAGE_NAME.png"
    if [ -f "$expected_icon" ]; then
        printf '%s\n' "$expected_icon"
        return 0
    fi

    local icon_dir="$APP_DIR/.codex-linux"
    local -a candidates=()
    local candidate
    if [ -d "$icon_dir" ]; then
        while IFS= read -r -d '' candidate; do
            candidates+=("$candidate")
        done < <(
            find "$icon_dir" -maxdepth 1 -type f -name '*.png' ! -name '*-tray.png' -print0 |
                sort -z
        )
    fi
    if [ "${#candidates[@]}" -eq 1 ]; then
        printf '%s\n' "${candidates[0]}"
        return 0
    fi

    if [ "${#candidates[@]}" -gt 1 ]; then
        warn "Multiple generated app icons found in $icon_dir; using the bundled Linux icon"
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
            ! -path './node-runtime/*' \
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
        "$root/usr/share/icons/hicolor/256x256/apps"
    if package_with_updater_enabled; then
        mkdir -p \
            "$root/usr/lib/systemd/user" \
            "$root/usr/share/polkit-1/actions"
    fi

    rm -rf "$app_root"
    cp -aT "$APP_DIR" "$app_root"
    mkdir -p "$app_root/.codex-linux"
    cp "$ICON_SOURCE" "$app_root/.codex-linux/$PACKAGE_NAME.png"
    cp "$(resolve_tray_icon_source "$app_root")" "$app_root/.codex-linux/$PACKAGE_NAME-tray.png"
    render_desktop_entry_doctor_helper "$app_root/.codex-linux/codex-desktop-entry-doctor.sh"
    render_desktop_entry "$root/usr/share/applications/$PACKAGE_NAME.desktop"
    cp "$ICON_SOURCE" "$root/usr/share/icons/hicolor/256x256/apps/$PACKAGE_NAME.png"
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

resolve_tray_icon_source() {
    local app_root="$1"
    local assets_dir="$app_root/content/webview/assets"
    local -a candidates=()
    local candidate

    if [ -d "$assets_dir" ]; then
        while IFS= read -r -d '' candidate; do
            candidates+=("$candidate")
        done < <(find "$assets_dir" -maxdepth 1 -type f -name 'app-*.png' -print0 | sort -z)
    fi

    if [ "${#candidates[@]}" -eq 1 ]; then
        printf '%s\n' "${candidates[0]}"
        return 0
    fi

    if [ "${#candidates[@]}" -gt 1 ]; then
        warn "Multiple tray icon candidates found in $assets_dir; falling back to package icon"
    else
        warn "Could not resolve a unique tray icon in $assets_dir; falling back to package icon"
    fi
    printf '%s\n' "$ICON_SOURCE"
}

stage_update_builder_bundle() {
    local root="$1"
    local update_builder_root="$root/opt/$PACKAGE_NAME/update-builder"
    local node_runtime_source="$APP_DIR/resources/node-runtime"

    mkdir -p \
        "$update_builder_root/scripts" \
        "$update_builder_root/scripts/lib" \
        "$update_builder_root/scripts/patches" \
        "$update_builder_root/launcher" \
        "$update_builder_root/linux-features" \
        "$update_builder_root/packaging/linux" \
        "$update_builder_root/assets"

    cp "$REPO_DIR/install.sh" "$update_builder_root/install.sh"
    cp "$REPO_DIR/CHANGELOG.md" "$update_builder_root/CHANGELOG.md"
    cp "$REPO_DIR/launcher/start.sh.template" "$update_builder_root/launcher/start.sh.template"
    cp "$REPO_DIR/launcher/cli-launch-path.py" "$update_builder_root/launcher/cli-launch-path.py"
    cp "$REPO_DIR/launcher/webview-server.py" "$update_builder_root/launcher/webview-server.py"
    cp "$REPO_DIR/Cargo.toml" "$update_builder_root/Cargo.toml"
    cp "$REPO_DIR/Cargo.lock" "$update_builder_root/Cargo.lock"
    cp -r "$REPO_DIR/computer-use-linux" "$update_builder_root/computer-use-linux"
    cp -r "$REPO_DIR/notification-actions-linux" "$update_builder_root/notification-actions-linux"
    cp -r "$REPO_DIR/record-replay-linux" "$update_builder_root/record-replay-linux"
    cp -r "$REPO_DIR/read-aloud-linux" "$update_builder_root/read-aloud-linux"
    cp -r "$REPO_DIR/updater" "$update_builder_root/updater"
    mkdir -p "$update_builder_root/plugins/openai-bundled/plugins"
    cp -r "$REPO_DIR/plugins/openai-bundled/plugins/computer-use" \
        "$update_builder_root/plugins/openai-bundled/plugins/computer-use"
    cp -r "$REPO_DIR/plugins/openai-bundled/plugins/read-aloud" \
        "$update_builder_root/plugins/openai-bundled/plugins/read-aloud"
    cp "$REPO_DIR/scripts/build-deb.sh" "$update_builder_root/scripts/build-deb.sh"
    cp "$REPO_DIR/scripts/build-rpm.sh" "$update_builder_root/scripts/build-rpm.sh"
    cp "$REPO_DIR/scripts/build-pacman.sh" "$update_builder_root/scripts/build-pacman.sh"
    cp "$REPO_DIR/scripts/rebuild-candidate.sh" "$update_builder_root/scripts/rebuild-candidate.sh"
    cp "$REPO_DIR/scripts/validate-upstream-dmg.js" "$update_builder_root/scripts/validate-upstream-dmg.js"
    cp "$REPO_DIR/scripts/patch-linux-window-ui.js" "$update_builder_root/scripts/patch-linux-window-ui.js"
    cp -r "$REPO_DIR/scripts/patches/." "$update_builder_root/scripts/patches/"
    cp "$REPO_DIR/scripts/lib/package-common.sh" "$update_builder_root/scripts/lib/package-common.sh"
    cp "$REPO_DIR/scripts/lib/patch-chrome-plugin.js" "$update_builder_root/scripts/lib/patch-chrome-plugin.js"
    cp "$REPO_DIR/scripts/lib/node-runtime.sh" "$update_builder_root/scripts/lib/node-runtime.sh"
    cp "$REPO_DIR/scripts/lib/upstream-dmg-intel.js" "$update_builder_root/scripts/lib/upstream-dmg-intel.js"
    cp "$REPO_DIR/scripts/lib/install-helpers.sh" "$update_builder_root/scripts/lib/install-helpers.sh"
    cp "$REPO_DIR/scripts/lib/process-detection.sh" "$update_builder_root/scripts/lib/process-detection.sh"
    cp "$REPO_DIR/scripts/lib/dmg.sh" "$update_builder_root/scripts/lib/dmg.sh"
    cp "$REPO_DIR/scripts/lib/native-modules.sh" "$update_builder_root/scripts/lib/native-modules.sh"
    cp "$REPO_DIR/scripts/lib/asar-patch.sh" "$update_builder_root/scripts/lib/asar-patch.sh"
    cp "$REPO_DIR/scripts/lib/webview-install.sh" "$update_builder_root/scripts/lib/webview-install.sh"
    cp "$REPO_DIR/scripts/lib/bundled-plugins.sh" "$update_builder_root/scripts/lib/bundled-plugins.sh"
    cp "$REPO_DIR/scripts/lib/notification-actions.sh" "$update_builder_root/scripts/lib/notification-actions.sh"
    cp "$REPO_DIR/scripts/lib/patch-browser-client-iab-socket-scope.js" \
        "$update_builder_root/scripts/lib/patch-browser-client-iab-socket-scope.js"
    cp "$REPO_DIR/scripts/lib/linux-features.js" "$update_builder_root/scripts/lib/linux-features.js"
    cp "$REPO_DIR/scripts/lib/linux-features.sh" "$update_builder_root/scripts/lib/linux-features.sh"
    cp "$REPO_DIR/scripts/lib/linux-target-context.js" "$update_builder_root/scripts/lib/linux-target-context.js"
    cp "$REPO_DIR/scripts/lib/linux-update-bridge-patch.js" "$update_builder_root/scripts/lib/linux-update-bridge-patch.js"
    cp "$REPO_DIR/scripts/lib/patch-report.js" "$update_builder_root/scripts/lib/patch-report.js"
    cp "$REPO_DIR/scripts/lib/patch-validation.js" "$update_builder_root/scripts/lib/patch-validation.js"
    cp "$REPO_DIR/scripts/lib/upstream-dmg-acceptance.js" "$update_builder_root/scripts/lib/upstream-dmg-acceptance.js"
    cp "$REPO_DIR/scripts/lib/upstream-dmg-release-profile.js" "$update_builder_root/scripts/lib/upstream-dmg-release-profile.js"
    cp "$REPO_DIR/scripts/lib/candidate-install.sh" "$update_builder_root/scripts/lib/candidate-install.sh"
    cp "$REPO_DIR/scripts/lib/candidate-promotion.py" "$update_builder_root/scripts/lib/candidate-promotion.py"
    cp "$REPO_DIR/scripts/lib/rebuild-report.sh" "$update_builder_root/scripts/lib/rebuild-report.sh"
    cp "$REPO_DIR/scripts/lib/build-info.js" "$update_builder_root/scripts/lib/build-info.js"
    cp "$REPO_DIR/scripts/lib/build-info.sh" "$update_builder_root/scripts/lib/build-info.sh"
    cp "$REPO_DIR/packaging/linux/control" "$update_builder_root/packaging/linux/control"
    cp "$REPO_DIR/packaging/linux/codex-desktop.spec" "$update_builder_root/packaging/linux/codex-desktop.spec"
    cp "$REPO_DIR/packaging/linux/codex-desktop.desktop" "$update_builder_root/packaging/linux/codex-desktop.desktop"
    cp "$REPO_DIR/packaging/linux/codex-desktop-entry-doctor.sh" \
        "$update_builder_root/packaging/linux/codex-desktop-entry-doctor.sh"
    cp "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh" "$update_builder_root/packaging/linux/codex-packaged-runtime.sh"
    cp "$REPO_DIR/packaging/linux/com.github.ilysenko.codex-desktop-linux.update.policy" \
        "$update_builder_root/packaging/linux/com.github.ilysenko.codex-desktop-linux.update.policy"
    cp "$REPO_DIR/packaging/linux/codex-update-manager-user-service.sh" \
        "$update_builder_root/packaging/linux/codex-update-manager-user-service.sh"
    cp "$REPO_DIR/packaging/linux/PKGBUILD.template" "$update_builder_root/packaging/linux/PKGBUILD.template"
    cp "$REPO_DIR/packaging/linux/codex-desktop.install" "$update_builder_root/packaging/linux/codex-desktop.install"
    cp "$UPDATER_SERVICE_SOURCE" "$update_builder_root/packaging/linux/codex-update-manager.service"
    cp "$REPO_DIR/packaging/linux/codex-update-manager.postinst" "$update_builder_root/packaging/linux/codex-update-manager.postinst"
    cp "$REPO_DIR/packaging/linux/codex-update-manager.prerm" "$update_builder_root/packaging/linux/codex-update-manager.prerm"
    stage_update_builder_linux_features_tree "$update_builder_root"
    stage_update_builder_linux_features_config "$update_builder_root"
    if linux_feature_enabled "global-dictation"; then
        stage_update_builder_global_dictation_source "$update_builder_root"
    fi
    cp "$REPO_DIR/packaging/linux/codex-update-manager.postrm" "$update_builder_root/packaging/linux/codex-update-manager.postrm"
    cp "$REPO_DIR/assets/codex.png" "$update_builder_root/assets/codex.png"
    cp "$REPO_DIR/assets/codex-linux.png" "$update_builder_root/assets/codex-linux.png"
    stage_update_builder_source_info "$update_builder_root"
    write_update_builder_manifest "$update_builder_root"
    if [ -d "$node_runtime_source" ]; then
        cp -a "$node_runtime_source" "$update_builder_root/node-runtime"
    else
        error "Missing managed Node.js runtime: $node_runtime_source. Run ./install.sh first."
    fi
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
