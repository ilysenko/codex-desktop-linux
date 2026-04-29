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

ensure_updater_binary() {
    if [ -x "$UPDATER_BINARY_SOURCE" ] && ! updater_binary_is_stale "$UPDATER_BINARY_SOURCE"; then
        return
    fi

    [ -f "$REPO_DIR/Cargo.toml" ] || error "Missing updater binary: $UPDATER_BINARY_SOURCE"
    command -v cargo >/dev/null 2>&1 || error "cargo is required to build codex-update-manager.
Install the Rust toolchain:
  bash scripts/install-deps.sh        # auto-installs via rustup
  # or manually: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"

    info "Building codex-update-manager release binary"
    cargo build --release -p codex-update-manager >&2
    [ -x "$UPDATER_BINARY_SOURCE" ] || error "Failed to build updater binary: $UPDATER_BINARY_SOURCE"
}

stage_common_package_files() {
    local root="$1"
    local app_root="$root/opt/$PACKAGE_NAME"
    local polkit_policy="$REPO_DIR/packaging/linux/com.github.ilysenko.codex-desktop-linux.update.policy"

    ensure_file_exists "$polkit_policy" "polkit policy"

    mkdir -p \
        "$root/opt" \
        "$root/usr/bin" \
        "$root/usr/lib/systemd/user" \
        "$root/usr/share/applications" \
        "$root/usr/share/icons/hicolor/256x256/apps" \
        "$root/usr/share/polkit-1/actions"

    rm -rf "$app_root"
    cp -aT "$APP_DIR" "$app_root"
    mkdir -p "$app_root/.codex-linux"
    cp "$ICON_SOURCE" "$app_root/.codex-linux/$PACKAGE_NAME.png"
    cp "$DESKTOP_TEMPLATE" "$root/usr/share/applications/$PACKAGE_NAME.desktop"
    cp "$ICON_SOURCE" "$root/usr/share/icons/hicolor/256x256/apps/$PACKAGE_NAME.png"
    cp "$UPDATER_BINARY_SOURCE" "$root/usr/bin/codex-update-manager"
    chmod 0755 "$root/usr/bin/codex-update-manager"
    cp "$UPDATER_SERVICE_SOURCE" "$root/usr/lib/systemd/user/codex-update-manager.service"
    chmod 0644 "$root/usr/lib/systemd/user/codex-update-manager.service"
    cp "$polkit_policy" "$root/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy"
    chmod 0644 "$root/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy"
    cp "$PACKAGED_RUNTIME_SOURCE" "$app_root/.codex-linux/codex-packaged-runtime.sh"
    chmod 0644 "$app_root/.codex-linux/codex-packaged-runtime.sh"
}

stage_update_builder_bundle() {
    local root="$1"
    local update_builder_root="$root/opt/$PACKAGE_NAME/update-builder"

    mkdir -p \
        "$update_builder_root/scripts" \
        "$update_builder_root/scripts/lib" \
        "$update_builder_root/packaging/linux" \
        "$update_builder_root/assets"

    cp "$REPO_DIR/install.sh" "$update_builder_root/install.sh"
    cp "$REPO_DIR/scripts/build-deb.sh" "$update_builder_root/scripts/build-deb.sh"
    cp "$REPO_DIR/scripts/build-rpm.sh" "$update_builder_root/scripts/build-rpm.sh"
    cp "$REPO_DIR/scripts/build-pacman.sh" "$update_builder_root/scripts/build-pacman.sh"
    cp "$REPO_DIR/scripts/patch-linux-window-ui.js" "$update_builder_root/scripts/patch-linux-window-ui.js"
    cp "$REPO_DIR/scripts/lib/package-common.sh" "$update_builder_root/scripts/lib/package-common.sh"
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
    cp "$REPO_DIR/packaging/linux/codex-update-manager.postrm" "$update_builder_root/packaging/linux/codex-update-manager.postrm"
    cp "$REPO_DIR/assets/codex.png" "$update_builder_root/assets/codex.png"
}

write_launcher_stub() {
    local root="$1"

    cat > "$root/usr/bin/$PACKAGE_NAME" <<SCRIPT
#!/bin/bash
exec /opt/$PACKAGE_NAME/start.sh "\$@"
SCRIPT
    chmod 0755 "$root/usr/bin/$PACKAGE_NAME"
}

normalize_package_permissions() {
    local root="$1"
    local path

    chmod 0755 "$root"

    for path in "$root/opt" "$root/usr"; do
        if [ -d "$path" ]; then
            chmod -R u+rwX,go+rX,go-w "$path"
        fi
    done

    [ -x "$root/opt/$PACKAGE_NAME/start.sh" ] && chmod 0755 "$root/opt/$PACKAGE_NAME/start.sh"
    [ -x "$root/usr/bin/$PACKAGE_NAME" ] && chmod 0755 "$root/usr/bin/$PACKAGE_NAME"
    [ -x "$root/usr/bin/codex-update-manager" ] && chmod 0755 "$root/usr/bin/codex-update-manager"
}
