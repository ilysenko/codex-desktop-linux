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
CODEX_CLI_WRAPPER_TEMPLATE="$REPO_DIR/packaging/appimage/codex-cli-wrapper.sh"
PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
PACKAGE_DISPLAY_NAME="${PACKAGE_DISPLAY_NAME:-ChatGPT}"
PACKAGE_COMMENT="${PACKAGE_COMMENT:-Run ChatGPT Desktop on Linux}"
PACKAGE_VERSION="${PACKAGE_VERSION:-$(date -u +%Y.%m.%d.%H%M%S)}"
ICON_SOURCE="$(resolve_package_icon_source)"

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

stage_bundled_codex_cli() {
    local arch="$1"
    local target="$APPDIR/opt/$PACKAGE_NAME/resources/codex-cli"
    local cli_source="${CODEX_CLI_BUNDLE_SOURCE:-}"
    local platform_package
    local platform_suffix
    local target_triple
    local platform_source
    local unsupported_path
    local symlink_path

    [ -n "$cli_source" ] || return 0
    rm -rf "$target"

    case "$arch" in
        x86_64)
            platform_package="codex-linux-x64"
            platform_suffix="linux-x64"
            target_triple="x86_64-unknown-linux-musl"
            ;;
        aarch64)
            platform_package="codex-linux-arm64"
            platform_suffix="linux-arm64"
            target_triple="aarch64-unknown-linux-musl"
            ;;
        *)
            error "Bundling the Codex CLI is not supported for AppImage architecture: $arch"
            ;;
    esac

    [ -d "$cli_source" ] || error "Missing bundled Codex CLI package: $cli_source"
    cli_source="$(readlink -f -- "$cli_source")" \
        || error "Unable to resolve bundled Codex CLI package: $cli_source"
    platform_source="$(dirname "$cli_source")/$platform_package"
    [ -d "$platform_source" ] || error "Missing bundled Codex CLI platform package: $platform_source"
    platform_source="$(readlink -f -- "$platform_source")" \
        || error "Unable to resolve bundled Codex CLI platform package: $platform_source"

    ensure_file_exists "$cli_source/package.json" "bundled Codex CLI package metadata"
    ensure_file_exists "$cli_source/bin/codex.js" "bundled Codex CLI entrypoint"
    ensure_file_exists "$platform_source/package.json" "bundled Codex CLI platform metadata"
    [ -x "$platform_source/vendor/$target_triple/bin/codex" ] \
        || error "Missing executable bundled Codex CLI binary: $platform_source/vendor/$target_triple/bin/codex"

    for source_dir in "$cli_source" "$platform_source"; do
        symlink_path="$(find "$source_dir" -type l -print -quit 2>/dev/null || true)"
        [ -z "$symlink_path" ] \
            || error "Bundled Codex CLI package contains a symlink: $symlink_path"
        unsupported_path="$(find "$source_dir" ! -type d ! -type f -print -quit 2>/dev/null || true)"
        [ -z "$unsupported_path" ] \
            || error "Bundled Codex CLI package contains an unsupported filesystem entry: $unsupported_path"
    done

    command -v python3 >/dev/null 2>&1 || error "python3 is required to validate bundled Codex CLI metadata"
    python3 - \
        "$cli_source/package.json" \
        "$platform_source/package.json" \
        "$platform_package" \
        "$platform_suffix" <<'PY'
import json
import sys

cli_path, platform_path, platform_package, platform_suffix = sys.argv[1:]
try:
    with open(cli_path, encoding="utf-8") as handle:
        cli = json.load(handle)
    with open(platform_path, encoding="utf-8") as handle:
        platform = json.load(handle)
except (OSError, ValueError) as exc:
    raise SystemExit(f"Invalid bundled Codex CLI package metadata: {exc}")

version = cli.get("version")
dependency = cli.get("optionalDependencies", {}).get(f"@openai/{platform_package}")
expected_dependency = f"npm:@openai/codex@{version}-{platform_suffix}"
if cli.get("name") != "@openai/codex" or not isinstance(version, str) or not version:
    raise SystemExit("Invalid bundled Codex CLI package identity")
if dependency != expected_dependency:
    raise SystemExit(
        f"Bundled Codex CLI does not require the matching {platform_package} package"
    )
if platform.get("name") != "@openai/codex" or platform.get("version") != f"{version}-{platform_suffix}":
    raise SystemExit("Bundled Codex CLI platform package version does not match the CLI package")
PY

    info "Bundling Codex CLI from $cli_source"
    mkdir -p "$target/bin" "$target/node_modules/@openai"
    cp -aT "$cli_source" "$target/node_modules/@openai/codex"
    cp -aT "$platform_source" "$target/node_modules/@openai/$platform_package"
    cp "$CODEX_CLI_WRAPPER_TEMPLATE" "$target/bin/codex"
    chmod 0755 "$target/bin/codex"
}

prepare_appdir() {
    local arch="$1"
    info "Preparing AppDir at $APPDIR"
    rm -rf "$APPDIR"
    mkdir -p \
        "$APPDIR/opt" \
        "$APPDIR/usr/share/applications" \
        "$APPDIR/usr/share/icons/hicolor/256x256/apps"

    cp -aT "$APP_DIR" "$APPDIR/opt/$PACKAGE_NAME"
    mkdir -p "$APPDIR/opt/$PACKAGE_NAME/.codex-linux"
    stage_bundled_codex_cli "$arch"

    render_template "$APPRUN_TEMPLATE" "$APPDIR/AppRun"
    chmod 0755 "$APPDIR/AppRun"

    render_template "$DESKTOP_TEMPLATE" "$APPDIR/$PACKAGE_NAME.desktop"
    chmod 0644 "$APPDIR/$PACKAGE_NAME.desktop"
    cp "$APPDIR/$PACKAGE_NAME.desktop" "$APPDIR/usr/share/applications/$PACKAGE_NAME.desktop"

    cp "$ICON_SOURCE" "$APPDIR/$PACKAGE_NAME.png"
    cp "$ICON_SOURCE" "$APPDIR/.DirIcon"
    cp "$ICON_SOURCE" "$APPDIR/usr/share/icons/hicolor/256x256/apps/$PACKAGE_NAME.png"
    cp "$ICON_SOURCE" "$APPDIR/opt/$PACKAGE_NAME/.codex-linux/$PACKAGE_NAME.png"
    cp "$REPO_DIR/launcher/launcher-log-router.py" "$APPDIR/opt/$PACKAGE_NAME/.codex-linux/launcher-log-router.py"
    cp "$REPO_DIR/launcher/cli-launch-path.py" "$APPDIR/opt/$PACKAGE_NAME/.codex-linux/cli-launch-path.py"

    render_template \
        "$APPIMAGE_RUNTIME_TEMPLATE" \
        "$APPDIR/opt/$PACKAGE_NAME/.codex-linux/codex-packaged-runtime.sh"
    chmod 0644 "$APPDIR/opt/$PACKAGE_NAME/.codex-linux/codex-packaged-runtime.sh"
    normalize_package_payload_permissions "$APPDIR"
    restore_linux_feature_payload_permissions "$APPDIR"
}

main() {
    ensure_app_layout
    ensure_file_exists "$APPRUN_TEMPLATE" "AppImage AppRun template"
    ensure_file_exists "$DESKTOP_TEMPLATE" "AppImage desktop template"
    ensure_file_exists "$APPIMAGE_RUNTIME_TEMPLATE" "AppImage runtime helper template"
    ensure_file_exists "$CODEX_CLI_WRAPPER_TEMPLATE" "AppImage Codex CLI wrapper template"
    ensure_file_exists "$ICON_SOURCE" "icon"

    local arch
    local appimagetool
    local output_file
    arch="$(map_arch)"
    appimagetool="$(resolve_appimagetool)"
    output_file="$DIST_DIR/${PACKAGE_NAME}-${PACKAGE_VERSION}-${arch}.AppImage"

    prepare_appdir "$arch"

    mkdir -p "$DIST_DIR"
    rm -f "$output_file"
    info "Building AppImage: $output_file"
    ARCH="$arch" VERSION="$PACKAGE_VERSION" \
        "$appimagetool" --no-appstream "$APPDIR" "$output_file" >&2
    chmod 0755 "$output_file"
    info "Built AppImage: $output_file"
}

main "$@"
