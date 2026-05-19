#!/bin/bash

info() {
    echo "[INFO] $*" >&2
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
const { enabledLinuxFeatureIds } = require(helperPath);

const enabled = enabledLinuxFeatureIds();
if (enabled.length === 0) {
  fs.rmSync(targetPath, { force: true });
  process.exit(0);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
NODE
}

render_desktop_entry() {
    local target="$1"
    local package_name
    local display_name
    local comment
    local rendered_target="$target.tmp"

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    display_name="$(sed_escape_replacement "${PACKAGE_DISPLAY_NAME:-Codex Desktop}")"
    comment="$(sed_escape_replacement "${PACKAGE_COMMENT:-Run Codex Desktop on Linux}")"

    sed \
        -e "s/codex-desktop/$package_name/g" \
        -e "s/^Name=.*/Name=$display_name/g" \
        -e "s/^Comment=.*/Comment=$comment/g" \
        "$DESKTOP_TEMPLATE" > "$rendered_target"
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
                print "Actions=NewInstance;"
                actions_rewritten = 1
                next
            }
            { print }
            END {
                if (actions_rewritten == 0) {
                    print "Actions=NewInstance;"
                }
            }
        ' "$rendered_target" > "$target"
        rm -f "$rendered_target"
    fi
    chmod 0644 "$target"
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
if [ -f "\$CLEANUP_HELPER" ]; then
    # shellcheck source=/opt/$package_name/.codex-linux/codex-no-updater-transition-cleanup.sh
    . "\$CLEANUP_HELPER"
    codex_no_updater_cleanup_update_manager_service || true
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

codex_no_updater_cleanup_if_present() {
    if [ -f "\$CLEANUP_HELPER" ]; then
        # shellcheck source=/opt/$package_name/.codex-linux/codex-no-updater-transition-cleanup.sh
        . "\$CLEANUP_HELPER"
        codex_no_updater_cleanup_update_manager_service || true
    fi
}

post_install() {
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
    fi
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

ensure_updater_binary() {
    local cargo_cmd=""

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
    [ -x "$UPDATER_BINARY_SOURCE" ] || error "Failed to build updater binary: $UPDATER_BINARY_SOURCE"
}

stage_common_package_files() {
    local root="$1"
    local app_root="$root/opt/$PACKAGE_NAME"
    local polkit_policy="$REPO_DIR/packaging/linux/com.github.ilysenko.codex-desktop-linux.update.policy"

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
    cp "$REPO_DIR/launcher/start.sh.template" "$update_builder_root/launcher/start.sh.template"
    cp "$REPO_DIR/launcher/webview-server.py" "$update_builder_root/launcher/webview-server.py"
    cp "$REPO_DIR/Cargo.toml" "$update_builder_root/Cargo.toml"
    cp "$REPO_DIR/Cargo.lock" "$update_builder_root/Cargo.lock"
    cp -r "$REPO_DIR/computer-use-linux" "$update_builder_root/computer-use-linux"
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
    cp "$REPO_DIR/scripts/patch-linux-window-ui.js" "$update_builder_root/scripts/patch-linux-window-ui.js"
    cp -r "$REPO_DIR/scripts/patches/." "$update_builder_root/scripts/patches/"
    cp "$REPO_DIR/scripts/lib/package-common.sh" "$update_builder_root/scripts/lib/package-common.sh"
    cp "$REPO_DIR/scripts/lib/patch-chrome-plugin.js" "$update_builder_root/scripts/lib/patch-chrome-plugin.js"
    cp "$REPO_DIR/scripts/lib/node-runtime.sh" "$update_builder_root/scripts/lib/node-runtime.sh"
    cp "$REPO_DIR/scripts/lib/install-helpers.sh" "$update_builder_root/scripts/lib/install-helpers.sh"
    cp "$REPO_DIR/scripts/lib/process-detection.sh" "$update_builder_root/scripts/lib/process-detection.sh"
    cp "$REPO_DIR/scripts/lib/dmg.sh" "$update_builder_root/scripts/lib/dmg.sh"
    cp "$REPO_DIR/scripts/lib/native-modules.sh" "$update_builder_root/scripts/lib/native-modules.sh"
    cp "$REPO_DIR/scripts/lib/asar-patch.sh" "$update_builder_root/scripts/lib/asar-patch.sh"
    cp "$REPO_DIR/scripts/lib/webview-install.sh" "$update_builder_root/scripts/lib/webview-install.sh"
    cp "$REPO_DIR/scripts/lib/bundled-plugins.sh" "$update_builder_root/scripts/lib/bundled-plugins.sh"
    cp "$REPO_DIR/scripts/lib/linux-features.js" "$update_builder_root/scripts/lib/linux-features.js"
    cp "$REPO_DIR/scripts/lib/linux-features.sh" "$update_builder_root/scripts/lib/linux-features.sh"
    cp "$REPO_DIR/scripts/lib/linux-target-context.js" "$update_builder_root/scripts/lib/linux-target-context.js"
    cp "$REPO_DIR/scripts/lib/linux-update-bridge-patch.js" "$update_builder_root/scripts/lib/linux-update-bridge-patch.js"
    cp "$REPO_DIR/scripts/lib/patch-report.js" "$update_builder_root/scripts/lib/patch-report.js"
    cp "$REPO_DIR/scripts/lib/rebuild-report.sh" "$update_builder_root/scripts/lib/rebuild-report.sh"
    cp "$REPO_DIR/packaging/linux/control" "$update_builder_root/packaging/linux/control"
    cp "$REPO_DIR/packaging/linux/codex-desktop.spec" "$update_builder_root/packaging/linux/codex-desktop.spec"
    cp "$REPO_DIR/packaging/linux/codex-desktop.desktop" "$update_builder_root/packaging/linux/codex-desktop.desktop"
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
    cp -r "$REPO_DIR/linux-features/." "$update_builder_root/linux-features/"
    stage_update_builder_linux_features_config "$update_builder_root"
    cp "$REPO_DIR/packaging/linux/codex-update-manager.postrm" "$update_builder_root/packaging/linux/codex-update-manager.postrm"
    cp "$REPO_DIR/assets/codex.png" "$update_builder_root/assets/codex.png"
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

write_launcher_stub() {
    local root="$1"

    cat > "$root/usr/bin/$PACKAGE_NAME" <<SCRIPT
#!/bin/bash
exec /opt/$PACKAGE_NAME/start.sh "\$@"
SCRIPT
    chmod 0755 "$root/usr/bin/$PACKAGE_NAME"
}
