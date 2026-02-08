#!/bin/bash
set -Eeuo pipefail

# ============================================================================
# Codex Desktop for Linux — Installer
# Converts the official macOS Codex Desktop app to run on Linux
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${CODEX_INSTALL_DIR:-$SCRIPT_DIR/codex-app}"
ELECTRON_VERSION="40.0.0"
WORK_DIR="$(mktemp -d)"
ARCH="$(uname -m)"
DESKTOP_APP_ID="codex-desktop-linux"
WINDOW_CLASS="Codex"
DESKTOP_ENTRY_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_ENTRY_FILE="$DESKTOP_ENTRY_DIR/${DESKTOP_APP_ID}.desktop"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
ICON_FILE="$ICON_DIR/${DESKTOP_APP_ID}.png"
DEFAULT_DISABLE_SANDBOX="${CODEX_DISABLE_SANDBOX:-1}"
WEBVIEW_SERVER_PORT="5175"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

print_usage() {
    cat << 'EOF'
Usage:
  ./install.sh [path/to/Codex.dmg]
  ./install.sh --repair-desktop
  ./install.sh --uninstall
  ./install.sh --help

Environment variables:
  CODEX_INSTALL_DIR      Install location (default: ./codex-app)
  CODEX_DISABLE_SANDBOX  1 to pass --no-sandbox (default: 1), 0 to omit it
EOF
}

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'error "Failed at line $LINENO (exit code $?)"' ERR

# ---- Check dependencies ----
check_deps() {
    local missing=()
    for cmd in node npm npx python3 7z curl unzip; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing dependencies: ${missing[*]}
Install them first:
  sudo apt install nodejs npm python3 p7zip-full curl unzip build-essential  # Debian/Ubuntu
  sudo dnf install nodejs npm python3 p7zip curl unzip && sudo dnf groupinstall 'Development Tools'  # Fedora
  sudo pacman -S nodejs npm python p7zip curl unzip base-devel  # Arch"
    fi

    NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d v)
    if [ "$NODE_MAJOR" -lt 20 ]; then
        error "Node.js 20+ required (found $(node -v))"
    fi

    if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
        error "Build tools (make, g++) required:
  sudo apt install build-essential   # Debian/Ubuntu
  sudo dnf groupinstall 'Development Tools'  # Fedora
  sudo pacman -S base-devel          # Arch"
    fi

    info "All dependencies found"
}

validate_installer_script() {
    local installer_path="$SCRIPT_DIR/install.sh"
    if command -v shellcheck &>/dev/null; then
        if shellcheck -S warning "$installer_path" >/dev/null; then
            info "shellcheck validation passed"
        else
            warn "shellcheck reported findings for $installer_path"
        fi
    else
        warn "shellcheck not found; skipping installer validation"
    fi
}

# ---- Download or find Codex DMG ----
get_dmg() {
    local dmg_dest="$SCRIPT_DIR/Codex.dmg"

    # Reuse existing DMG
    if [ -s "$dmg_dest" ]; then
        info "Using cached DMG: $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"
        echo "$dmg_dest"
        return
    fi

    info "Downloading Codex Desktop DMG..."
    local dmg_url="https://persistent.oaistatic.com/codex-app-prod/Codex.dmg"
    info "URL: $dmg_url"

    if ! curl -L --progress-bar --max-time 600 --connect-timeout 30 \
            -o "$dmg_dest" "$dmg_url"; then
        rm -f "$dmg_dest"
        error "Download failed. Download manually and place as: $dmg_dest"
    fi

    if [ ! -s "$dmg_dest" ]; then
        rm -f "$dmg_dest"
        error "Download produced empty file. Download manually and place as: $dmg_dest"
    fi

    info "Saved: $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"
    echo "$dmg_dest"
}

# ---- Extract app from DMG ----
extract_dmg() {
    local dmg_path="$1"
    info "Extracting DMG with 7z..."

    7z x -y "$dmg_path" -o"$WORK_DIR/dmg-extract" >&2 || \
        error "Failed to extract DMG"

    local app_dir
    app_dir=$(find "$WORK_DIR/dmg-extract" -maxdepth 3 -name "*.app" -type d | head -1)
    [ -n "$app_dir" ] || error "Could not find .app bundle in DMG"

    info "Found: $(basename "$app_dir")"
    echo "$app_dir"
}

# ---- Build native modules in a clean directory ----
build_native_modules() {
    local app_extracted="$1"

    # Read versions from extracted app
    local bs3_ver npty_ver
    bs3_ver=$(node -p "require('$app_extracted/node_modules/better-sqlite3/package.json').version" 2>/dev/null || echo "")
    npty_ver=$(node -p "require('$app_extracted/node_modules/node-pty/package.json').version" 2>/dev/null || echo "")

    [ -n "$bs3_ver" ] || error "Could not detect better-sqlite3 version"
    [ -n "$npty_ver" ] || error "Could not detect node-pty version"

    info "Native modules: better-sqlite3@$bs3_ver, node-pty@$npty_ver"

    # Build in a CLEAN directory (asar doesn't have full source)
    local build_dir="$WORK_DIR/native-build"
    mkdir -p "$build_dir"
    cd "$build_dir"

    echo '{"private":true}' > package.json

    info "Installing fresh sources from npm..."
    npm install "electron@$ELECTRON_VERSION" --save-dev --ignore-scripts 2>&1 >&2
    npm install "better-sqlite3@$bs3_ver" "node-pty@$npty_ver" --ignore-scripts 2>&1 >&2

    info "Compiling for Electron v$ELECTRON_VERSION (this takes ~1 min)..."
    npx --yes @electron/rebuild -v "$ELECTRON_VERSION" --force 2>&1 >&2

    info "Native modules built successfully"

    # Copy compiled modules back into extracted app
    rm -rf "$app_extracted/node_modules/better-sqlite3"
    rm -rf "$app_extracted/node_modules/node-pty"
    cp -r "$build_dir/node_modules/better-sqlite3" "$app_extracted/node_modules/"
    cp -r "$build_dir/node_modules/node-pty" "$app_extracted/node_modules/"
}

# ---- Extract and patch app.asar ----
patch_asar() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"

    [ -f "$resources_dir/app.asar" ] || error "app.asar not found in $resources_dir"

    info "Extracting app.asar..."
    cd "$WORK_DIR"
    npx --yes asar extract "$resources_dir/app.asar" app-extracted

    # Copy unpacked native modules if they exist
    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        cp -r "$resources_dir/app.asar.unpacked/"* app-extracted/ 2>/dev/null || true
    fi

    # Remove macOS-only modules
    rm -rf "$WORK_DIR/app-extracted/node_modules/sparkle-darwin" 2>/dev/null || true
    find "$WORK_DIR/app-extracted" -name "sparkle.node" -delete 2>/dev/null || true

    # Build native modules in clean environment and copy back
    build_native_modules "$WORK_DIR/app-extracted"

    # Repack
    info "Repacking app.asar..."
    cd "$WORK_DIR"
    npx asar pack app-extracted app.asar --unpack "{*.node,*.so,*.dylib}" 2>/dev/null

    info "app.asar patched"
}

# ---- Download Linux Electron ----
download_electron() {
    info "Downloading Electron v${ELECTRON_VERSION} for Linux..."

    local electron_arch
    case "$ARCH" in
        x86_64)  electron_arch="x64" ;;
        aarch64) electron_arch="arm64" ;;
        armv7l)  electron_arch="armv7l" ;;
        *)       error "Unsupported architecture: $ARCH" ;;
    esac

    local url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-${electron_arch}.zip"

    curl -L --progress-bar -o "$WORK_DIR/electron.zip" "$url"
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    unzip -qo "$WORK_DIR/electron.zip"

    info "Electron ready"
}

# ---- Extract webview files ----
extract_webview() {
    local app_dir="$1"
    mkdir -p "$INSTALL_DIR/content/webview"

    # Webview files are inside the extracted asar at webview/
    local asar_extracted="$WORK_DIR/app-extracted"
    if [ -d "$asar_extracted/webview" ]; then
        cp -r "$asar_extracted/webview/"* "$INSTALL_DIR/content/webview/"
        info "Webview files copied"
    else
        warn "Webview directory not found in asar — app may not work"
    fi
}

# ---- Install app.asar ----
install_app() {
    cp "$WORK_DIR/app.asar" "$INSTALL_DIR/resources/"
    if [ -d "$WORK_DIR/app.asar.unpacked" ]; then
        cp -r "$WORK_DIR/app.asar.unpacked" "$INSTALL_DIR/resources/"
    fi
    info "app.asar installed"
}

# ---- Create start script ----
create_start_script() {
    cat > "$INSTALL_DIR/start.sh" << 'SCRIPT'
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBVIEW_DIR="$SCRIPT_DIR/content/webview"
SERVER_PID_FILE="$SCRIPT_DIR/.webview-http.pid"
SERVER_LOCK_DIR="$SCRIPT_DIR/.webview-http.lock"
WEBVIEW_PORT="5175"
DISABLE_SANDBOX="${CODEX_DISABLE_SANDBOX:-1}"

is_webview_server_pid_valid() {
    local pid="$1"
    [ -n "$pid" ] || return 1
    [ -e "/proc/$pid/cmdline" ] || return 1
    local cmdline
    cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    [[ "$cmdline" == *"python3 -m http.server ${WEBVIEW_PORT}"* ]]
}

start_webview_server_if_needed() {
    if [ ! -d "$WEBVIEW_DIR" ] || [ -z "$(ls -A "$WEBVIEW_DIR" 2>/dev/null)" ]; then
        return
    fi

    if [ -f "$SERVER_PID_FILE" ]; then
        local existing_pid
        existing_pid="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"
        if is_webview_server_pid_valid "$existing_pid" && kill -0 "$existing_pid" 2>/dev/null; then
            return
        fi
    fi

    if mkdir "$SERVER_LOCK_DIR" 2>/dev/null; then
        python3 -m http.server "$WEBVIEW_PORT" --bind 127.0.0.1 --directory "$WEBVIEW_DIR" >/dev/null 2>&1 &
        echo "$!" > "$SERVER_PID_FILE"
        rmdir "$SERVER_LOCK_DIR" 2>/dev/null || true
    fi
}

start_webview_server_if_needed

export CODEX_CLI_PATH="${CODEX_CLI_PATH:-$(which codex 2>/dev/null)}"

if [ -z "$CODEX_CLI_PATH" ]; then
    echo "Error: Codex CLI not found. Install with: npm i -g @openai/codex"
    exit 1
fi

export CHROME_DESKTOP="${CHROME_DESKTOP:-codex-desktop-linux.desktop}"

cd "$SCRIPT_DIR"
if [ "$DISABLE_SANDBOX" = "1" ]; then
    exec -a "codex-desktop-linux" "$SCRIPT_DIR/electron" --no-sandbox --class=Codex --name=Codex --icon="$SCRIPT_DIR/icon.png" "$@"
fi
exec -a "codex-desktop-linux" "$SCRIPT_DIR/electron" --class=Codex --name=Codex --icon="$SCRIPT_DIR/icon.png" "$@"
SCRIPT

    chmod +x "$INSTALL_DIR/start.sh"
    info "Start script created"
}

# ---- Create desktop entry ----
escape_exec_path() {
    local raw_path="$1"
    printf '%s' "$raw_path" | sed -e 's/\\/\\\\/g' -e 's/ /\\ /g'
}

create_desktop_entry() {
    local icon_source=""
    local escaped_exec=""
    local local_icon_file="$INSTALL_DIR/icon.png"

    mkdir -p "$DESKTOP_ENTRY_DIR" "$ICON_DIR"

    escaped_exec=$(escape_exec_path "$INSTALL_DIR/start.sh")
    icon_source=$(find "$INSTALL_DIR/content/webview/assets" -maxdepth 1 -type f -name 'app-*.png' | sort | head -1 || true)

    if [ -n "$icon_source" ] && [ -f "$icon_source" ]; then
        cp "$icon_source" "$ICON_FILE"
        cp "$icon_source" "$local_icon_file"
    else
        warn "Could not find app icon in $INSTALL_DIR/content/webview/assets"
    fi

    cat > "$DESKTOP_ENTRY_FILE" << EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Codex Desktop
Comment=Run Codex Desktop for Linux
Exec=$escaped_exec %U
TryExec=$escaped_exec
Terminal=false
Categories=Development;
StartupNotify=true
Icon=$DESKTOP_APP_ID
StartupWMClass=$WINDOW_CLASS
X-GNOME-WMClass=$WINDOW_CLASS
EOF

    chmod 644 "$DESKTOP_ENTRY_FILE"

    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database "$DESKTOP_ENTRY_DIR" 2>/dev/null || true
    fi

    if command -v gtk-update-icon-cache &>/dev/null; then
        gtk-update-icon-cache -f -t "$(dirname "$(dirname "$ICON_DIR")")" 2>/dev/null || true
    fi

    if command -v desktop-file-validate &>/dev/null; then
        desktop-file-validate "$DESKTOP_ENTRY_FILE"
        info "desktop-file-validate passed"
    else
        warn "desktop-file-validate not found; skipping desktop-entry validation"
    fi

    info "Desktop entry created: $DESKTOP_ENTRY_FILE"
}

remove_desktop_entry() {
    rm -f "$DESKTOP_ENTRY_FILE"
    rm -f "$ICON_FILE"

    if command -v update-desktop-database &>/dev/null; then
        update-desktop-database "$DESKTOP_ENTRY_DIR" 2>/dev/null || true
    fi

    if command -v gtk-update-icon-cache &>/dev/null; then
        gtk-update-icon-cache -f -t "$(dirname "$(dirname "$ICON_DIR")")" 2>/dev/null || true
    fi
}

repair_desktop_integration() {
    [ -d "$INSTALL_DIR" ] || error "Install directory not found: $INSTALL_DIR"
    [ -f "$INSTALL_DIR/electron" ] || error "Electron binary missing in $INSTALL_DIR"
    create_start_script
    create_desktop_entry
    info "Desktop integration repaired"
}

uninstall_app() {
    local default_install_dir="$SCRIPT_DIR/codex-app"
    local dmg_cache="$SCRIPT_DIR/Codex.dmg"
    local install_dirs=("$INSTALL_DIR")
    local icon_pattern_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
    local desktop_entries=(
        "${XDG_DATA_HOME:-$HOME/.local/share}/applications/codex-desktop-linux.desktop"
        "$HOME/.local/share/applications/codex-desktop-linux.desktop"
    )

    if [ "$INSTALL_DIR" != "$default_install_dir" ]; then
        install_dirs+=("$default_install_dir")
    fi

    # Stop app processes from known install locations.
    for dir in "${install_dirs[@]}"; do
        pkill -f "$dir/electron" 2>/dev/null || true
        pkill -f "$dir/start.sh" 2>/dev/null || true
        if [ -f "$dir/.webview-http.pid" ]; then
            local webview_pid
            webview_pid="$(cat "$dir/.webview-http.pid" 2>/dev/null || true)"
            if [ -n "$webview_pid" ] && kill -0 "$webview_pid" 2>/dev/null; then
                kill "$webview_pid" 2>/dev/null || true
            fi
        fi
    done

    # Remove desktop launchers (current and legacy locations).
    for entry in "${desktop_entries[@]}"; do
        rm -f "$entry"
    done

    # Remove all icon-size variants created for this launcher.
    find "$icon_pattern_dir" -type f -path "*/apps/${DESKTOP_APP_ID}.png" -delete 2>/dev/null || true

    # Refresh desktop caches.
    remove_desktop_entry

    for dir in "${install_dirs[@]}"; do
        if [ -d "$dir" ]; then
            rm -rf "$dir"
            info "Removed install directory: $dir"
        fi
    done

    rm -f "$dmg_cache"
    info "Removed cached DMG: $dmg_cache"

    info "Uninstall complete"
}

resolve_dmg_path() {
    local provided_path="${1:-}"
    if [ -n "$provided_path" ] && [ -f "$provided_path" ]; then
        realpath "$provided_path"
        return
    fi
    get_dmg
}

# ---- Main ----
main() {
    local action="install"
    local provided_dmg=""

    while [ $# -gt 0 ]; do
        case "$1" in
            --help|-h)
                print_usage
                exit 0
                ;;
            --repair-desktop)
                action="repair-desktop"
                ;;
            --uninstall)
                action="uninstall"
                ;;
            *)
                if [ -z "$provided_dmg" ] && [ -f "$1" ]; then
                    provided_dmg="$1"
                else
                    error "Unknown argument: $1 (use --help for usage)"
                fi
                ;;
        esac
        shift
    done

    echo "============================================" >&2
    echo "  Codex Desktop for Linux — Installer"       >&2
    echo "============================================" >&2
    echo ""                                             >&2

    if [ "$action" = "uninstall" ]; then
        uninstall_app
        exit 0
    fi

    validate_installer_script

    if [ "$action" = "repair-desktop" ]; then
        repair_desktop_integration
        exit 0
    fi

    check_deps

    local dmg_path
    dmg_path="$(resolve_dmg_path "$provided_dmg")"
    info "Using DMG: $dmg_path"

    local app_dir
    app_dir=$(extract_dmg "$dmg_path")

    patch_asar "$app_dir"
    download_electron
    extract_webview "$app_dir"
    install_app
    create_start_script
    create_desktop_entry

    if ! command -v codex &>/dev/null; then
        warn "Codex CLI not found. Install it: npm i -g @openai/codex"
    fi

    echo ""                                             >&2
    echo "============================================" >&2
    info "Installation complete!"
    echo "  Run:  $INSTALL_DIR/start.sh"                >&2
    echo "  Menu: Codex Desktop"                        >&2
    echo "  Sandbox: CODEX_DISABLE_SANDBOX=$DEFAULT_DISABLE_SANDBOX" >&2
    echo "============================================" >&2
}

main "$@"
