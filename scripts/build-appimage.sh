#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$REPO_DIR/scripts/lib/package-common.sh"

APP_DIR="${APP_DIR_OVERRIDE:-$REPO_DIR/codex-app}"
DIST_DIR="${DIST_DIR_OVERRIDE:-$REPO_DIR/dist}"
APPDIR="${APPIMAGE_APPDIR_OVERRIDE:-$REPO_DIR/dist/appimage.AppDir}"
APPRUN_TEMPLATE="$REPO_DIR/packaging/appimage/AppRun"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/appimage/codex-desktop.desktop"
APPIMAGE_RUNTIME_TEMPLATE="$REPO_DIR/packaging/appimage/codex-appimage-runtime.sh"
ICON_SOURCE="$REPO_DIR/assets/codex.png"

PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-Codex Desktop}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Run Codex Desktop on Linux}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"

map_arch() {
    case "$(uname -m)" in
        x86_64)  echo "x86_64" ;;
        aarch64|arm64) echo "aarch64" ;;
        armv7l|armhf) echo "armhf" ;;
        *)       error "Unsupported AppImage architecture: $(uname -m)" ;;
    esac
}

resolve_appimagetool() {
    if [ -n "${APPIMAGETOOL:-}" ]; then
        [ -x "$APPIMAGETOOL" ] || error "APPIMAGETOOL is not executable: $APPIMAGETOOL"
        printf '%s\n' "$APPIMAGETOOL"
        return 0
    fi

    command -v appimagetool >/dev/null 2>&1 || error "appimagetool is required.
Install appimagetool or set APPIMAGETOOL=/path/to/appimagetool."
    command -v appimagetool
}

render_template() {
    local source="$1"
    local target="$2"
    local package_name
    local display_name
    local comment
    local version

    package_name="$(sed_escape_replacement "$PACKAGE_NAME")"
    display_name="$(sed_escape_replacement "$PACKAGE_DISPLAY_NAME")"
    comment="$(sed_escape_replacement "$PACKAGE_COMMENT")"
    version="$(sed_escape_replacement "$PACKAGE_VERSION")"

    sed \
        -e "s/__PACKAGE_NAME__/$package_name/g" \
        -e "s/__PACKAGE_DISPLAY_NAME__/$display_name/g" \
        -e "s/__PACKAGE_COMMENT__/$comment/g" \
        -e "s/__VERSION__/$version/g" \
        "$source" > "$target"
}

prepare_appdir() {
    info "Preparing AppDir at $APPDIR"
    rm -rf "$APPDIR"
    mkdir -p \
        "$APPDIR/opt" \
        "$APPDIR/usr/share/applications" \
        "$APPDIR/usr/share/icons/hicolor/256x256/apps"

    cp -aT "$APP_DIR" "$APPDIR/opt/$PACKAGE_NAME"
    mkdir -p "$APPDIR/opt/$PACKAGE_NAME/.codex-linux"

    render_template "$APPRUN_TEMPLATE" "$APPDIR/AppRun"
    chmod 0755 "$APPDIR/AppRun"

    render_template "$DESKTOP_TEMPLATE" "$APPDIR/$PACKAGE_NAME.desktop"
    chmod 0644 "$APPDIR/$PACKAGE_NAME.desktop"
    cp "$APPDIR/$PACKAGE_NAME.desktop" "$APPDIR/usr/share/applications/$PACKAGE_NAME.desktop"

    cp "$ICON_SOURCE" "$APPDIR/$PACKAGE_NAME.png"
    cp "$ICON_SOURCE" "$APPDIR/.DirIcon"
    cp "$ICON_SOURCE" "$APPDIR/usr/share/icons/hicolor/256x256/apps/$PACKAGE_NAME.png"
    cp "$ICON_SOURCE" "$APPDIR/opt/$PACKAGE_NAME/.codex-linux/$PACKAGE_NAME.png"

    render_template \
        "$APPIMAGE_RUNTIME_TEMPLATE" \
        "$APPDIR/opt/$PACKAGE_NAME/.codex-linux/codex-packaged-runtime.sh"
    chmod 0644 "$APPDIR/opt/$PACKAGE_NAME/.codex-linux/codex-packaged-runtime.sh"
}

main() {
    ensure_app_layout
    ensure_file_exists "$APPRUN_TEMPLATE" "AppImage AppRun template"
    ensure_file_exists "$DESKTOP_TEMPLATE" "AppImage desktop template"
    ensure_file_exists "$APPIMAGE_RUNTIME_TEMPLATE" "AppImage runtime helper template"
    ensure_file_exists "$ICON_SOURCE" "icon"

    local arch
    local appimagetool
    local output_file
    arch="$(map_arch)"
    appimagetool="$(resolve_appimagetool)"
    output_file="$DIST_DIR/${PACKAGE_NAME}-${PACKAGE_VERSION}-${arch}.AppImage"

    prepare_appdir

    mkdir -p "$DIST_DIR"
    rm -f "$output_file"
    info "Building AppImage: $output_file"
    ARCH="$arch" VERSION="$PACKAGE_VERSION" \
        "$appimagetool" --no-appstream "$APPDIR" "$output_file" >&2
    chmod 0755 "$output_file"
    info "Built AppImage: $output_file"
}

main "$@"
