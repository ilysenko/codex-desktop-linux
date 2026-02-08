#!/bin/bash
set -Eeuo pipefail

# ============================================================================
# Codex Desktop for Linux — Installer
# Converts the official macOS Codex Desktop app to run on Linux
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${CODEX_INSTALL_DIR:-$SCRIPT_DIR/codex-app}"
ELECTRON_VERSION_DEFAULT="40.0.0"
ELECTRON_VERSION=""
WORK_DIR="$(mktemp -d)"
ARCH="$(uname -m)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Run a command, capturing output to a log file. On failure, print the log.
run_logged() {
    local label="$1"; shift
    local log="$WORK_DIR/${label}.log"
    if "$@" > "$log" 2>&1; then
        return 0
    else
        local rc=$?
        echo -e "${RED}--- $label failed (exit $rc) ---${NC}" >&2
        tail -40 "$log" >&2
        echo -e "${RED}--- end of log ($log) ---${NC}" >&2
        return "$rc"
    fi
}
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

    # 7z may report errors for macOS symlinks (e.g. /Applications shortcut)
    # which are harmless — check for the .app bundle instead of the exit code
    7z x -y "$dmg_path" -o"$WORK_DIR/dmg-extract" >&2 || true

    local app_dir
    app_dir=$(find "$WORK_DIR/dmg-extract" -maxdepth 3 -name "*.app" -type d | head -1)
    [ -n "$app_dir" ] || error "Failed to extract DMG (no .app bundle found)"

    info "Found: $(basename "$app_dir")"
    echo "$app_dir"
}

# ---- Detect Electron version from extracted app ----
detect_electron_version() {
    local app_dir="$1"
    local ver_file="$app_dir/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/version"
    if [ -f "$ver_file" ]; then
        local detected
        detected="$(tr -d '[:space:]' < "$ver_file")"
        if [[ "$detected" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
            ELECTRON_VERSION="$detected"
            info "Detected Electron version from app: $ELECTRON_VERSION"
            return
        fi
    fi
    ELECTRON_VERSION="$ELECTRON_VERSION_DEFAULT"
    warn "Could not detect Electron version from app — using default: $ELECTRON_VERSION"
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
    run_logged "npm-electron" npm install "electron@$ELECTRON_VERSION" --save-dev --ignore-scripts
    run_logged "npm-native" npm install "better-sqlite3@$bs3_ver" "node-pty@$npty_ver" --ignore-scripts

    info "Compiling for Electron v$ELECTRON_VERSION (this takes ~1 min)..."
    run_logged "electron-rebuild" npx --yes @electron/rebuild -v "$ELECTRON_VERSION" --force

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
    npx --yes @electron/asar extract "$resources_dir/app.asar" app-extracted

    # Copy unpacked native modules if they exist
    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        cp -r "$resources_dir/app.asar.unpacked/"* app-extracted/ 2>/dev/null || true
    fi

    # Remove macOS-only modules
    rm -rf "$WORK_DIR/app-extracted/node_modules/sparkle-darwin" 2>/dev/null || true
    find "$WORK_DIR/app-extracted" -name "sparkle.node" -delete 2>/dev/null || true

    # Build native modules in clean environment and copy back
    build_native_modules "$WORK_DIR/app-extracted"

    # Inject Linux update mechanism
    info "Injecting Linux update mechanism..."
    cp "$SCRIPT_DIR/linux-updater.js" "$WORK_DIR/app-extracted/.vite/build/linux-updater.js"
    sed -i '1s|"use strict";|"use strict";require("./linux-updater.js");|' \
        "$WORK_DIR/app-extracted/.vite/build/main.js"

    # Repack
    info "Repacking app.asar..."
    cd "$WORK_DIR"
    npx --yes @electron/asar pack app-extracted app.asar --unpack "{*.node,*.so,*.dylib}" 2>/dev/null

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

    local base_url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}"
    local zip_name="electron-v${ELECTRON_VERSION}-linux-${electron_arch}.zip"
    local url="${base_url}/${zip_name}"

    curl -L --progress-bar -o "$WORK_DIR/electron.zip" "$url"

    # Verify checksum
    info "Verifying Electron download checksum..."
    local shasums_url="${base_url}/SHASUMS256.txt"
    if curl -fsSL --max-time 30 -o "$WORK_DIR/SHASUMS256.txt" "$shasums_url"; then
        local expected actual
        expected=$(grep "$zip_name" "$WORK_DIR/SHASUMS256.txt" | grep -v '\-symbols' | head -1 | awk '{print $1}')
        actual=$(sha256sum "$WORK_DIR/electron.zip" | awk '{print $1}')
        if [ -z "$expected" ]; then
            warn "Could not find checksum for $zip_name in SHASUMS256.txt — skipping verification"
        elif [ "$expected" != "$actual" ]; then
            error "Electron checksum mismatch!
  Expected: $expected
  Got:      $actual
Delete $WORK_DIR/electron.zip and retry, or check your network."
        else
            info "Checksum verified: $actual"
        fi
    else
        warn "Could not fetch SHASUMS256.txt — skipping checksum verification"
    fi

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
HTTP_PID=""
ELECTRON_PID=""
HTTP_PORT=5175

cleanup() {
    [ -n "$ELECTRON_PID" ] && kill "$ELECTRON_PID" 2>/dev/null || true
    [ -n "$HTTP_PID" ]     && kill "$HTTP_PID"     2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ -d "$WEBVIEW_DIR" ] && [ "$(ls -A "$WEBVIEW_DIR" 2>/dev/null)" ]; then
    # Check if port is already in use
    if ss -tlnp 2>/dev/null | grep -q ":${HTTP_PORT} " || \
       lsof -iTCP:"$HTTP_PORT" -sTCP:LISTEN &>/dev/null; then
        echo "[WARN] Port $HTTP_PORT already in use — skipping HTTP server" >&2
    else
        cd "$WEBVIEW_DIR"
        python3 -m http.server "$HTTP_PORT" &> /dev/null &
        HTTP_PID=$!

        # Wait for server readiness (up to 3 seconds)
        for _ in $(seq 1 30); do
            if curl -sf "http://127.0.0.1:${HTTP_PORT}/" > /dev/null 2>&1; then
                break
            fi
            sleep 0.1
        done
    fi
fi

export CODEX_CLI_PATH="${CODEX_CLI_PATH:-$(which codex 2>/dev/null || true)}"
SCRIPT

    # Bake the absolute installer path at install time (not inside the
    # single-quoted heredoc) so custom CODEX_INSTALL_DIR works correctly.
    local real_installer_path
    real_installer_path="$(cd "$SCRIPT_DIR" && realpath install.sh)"
    echo "export CODEX_LINUX_INSTALLER_PATH=\"$real_installer_path\"" >> "$INSTALL_DIR/start.sh"

    cat >> "$INSTALL_DIR/start.sh" << 'SCRIPT'

if [ -z "$CODEX_CLI_PATH" ]; then
    echo "Error: Codex CLI not found. Install with: npm i -g @openai/codex" >&2
    exit 1
fi

cd "$SCRIPT_DIR"
"$SCRIPT_DIR/electron" --no-sandbox "$@" &
ELECTRON_PID=$!
wait "$ELECTRON_PID" 2>/dev/null || true
ELECTRON_PID=""
SCRIPT

    chmod +x "$INSTALL_DIR/start.sh"
    info "Start script created"
}

# ---- Idempotency stamp ----
STAMP_FILE="${INSTALL_DIR}/.install-stamp"

compute_stamp() {
    local dmg_path="$1"
    local dmg_hash
    dmg_hash=$(sha256sum "$dmg_path" | awk '{print $1}')
    echo "${dmg_hash}:${ELECTRON_VERSION}:${ARCH}"
}

check_stamp() {
    local dmg_path="$1"
    [ -f "$STAMP_FILE" ] || return 1
    local current
    current=$(compute_stamp "$dmg_path")
    local saved
    saved=$(cat "$STAMP_FILE" 2>/dev/null)
    [ "$current" = "$saved" ]
}

write_stamp() {
    local dmg_path="$1"
    compute_stamp "$dmg_path" > "$STAMP_FILE"
}

# ---- Desktop integration ----
install_desktop_entry() {
    local app_dir="$1"
    local icon_path="$INSTALL_DIR/codex-desktop.png"

    # Try to extract icon from macOS .icns using multiple methods
    local icns_file icon_extracted=false
    icns_file=$(find "$app_dir" -name "*.icns" -type f 2>/dev/null | head -1)

    if [ -z "$icns_file" ]; then
        icon_path=""
        warn "No .icns icon found in app bundle"
    else
        # Method 1: ImageMagick convert
        if [ "$icon_extracted" = false ] && command -v convert &>/dev/null; then
            if convert "$icns_file[0]" -resize 256x256 "$icon_path" 2>/dev/null; then
                icon_extracted=true
                info "Extracted app icon via ImageMagick (256x256)"
            fi
        fi

        # Method 2: icns2png (from libicns)
        if [ "$icon_extracted" = false ] && command -v icns2png &>/dev/null; then
            if icns2png -x -s 256 -o "$INSTALL_DIR" "$icns_file" 2>/dev/null; then
                # icns2png outputs <name>_256x256x32.png — find and rename it
                local extracted
                extracted=$(find "$INSTALL_DIR" -maxdepth 1 -name "*_256x256*" -o -name "*_128x128*" 2>/dev/null | head -1)
                if [ -n "$extracted" ]; then
                    mv "$extracted" "$icon_path"
                    icon_extracted=true
                    info "Extracted app icon via icns2png"
                fi
            fi
        fi

        # Method 3: Python3 + Pillow
        if [ "$icon_extracted" = false ]; then
            if python3 -c "
from PIL import Image
import struct, io, sys

with open(sys.argv[1], 'rb') as f:
    data = f.read()

# .icns files contain multiple sizes; find the largest PNG chunk
# Common icon types with embedded PNG: ic10 (1024), ic09 (512), ic08 (256), ic07 (128)
best = None
pos = 8  # skip header
while pos < len(data) - 8:
    icon_type = data[pos:pos+4]
    size = struct.unpack('>I', data[pos+4:pos+8])[0]
    chunk = data[pos+8:pos+size]
    if chunk[:8] == b'\\x89PNG\\r\\n\\x1a\\n':
        if best is None or len(chunk) > len(best):
            best = chunk
    pos += size

if best:
    img = Image.open(io.BytesIO(best))
    img = img.resize((256, 256), Image.LANCZOS)
    img.save(sys.argv[2])
else:
    sys.exit(1)
" "$icns_file" "$icon_path" 2>/dev/null; then
                icon_extracted=true
                info "Extracted app icon via Python Pillow"
            fi
        fi

        # Method 4: 7z can sometimes extract PNGs from .icns
        if [ "$icon_extracted" = false ]; then
            local icns_extract="$WORK_DIR/icns-extract"
            mkdir -p "$icns_extract"
            if 7z x -y "$icns_file" -o"$icns_extract" &>/dev/null; then
                local best_png
                best_png=$(find "$icns_extract" -name "*.png" -type f -printf '%s %p\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')
                if [ -n "$best_png" ]; then
                    cp "$best_png" "$icon_path"
                    icon_extracted=true
                    info "Extracted app icon via 7z"
                fi
            fi
        fi

        if [ "$icon_extracted" = false ]; then
            icon_path=""
            warn "Could not extract icon — install ImageMagick (sudo apt install imagemagick) or Pillow (pip3 install Pillow)"
        fi
    fi

    local desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$desktop_dir"
    local desktop_file="$desktop_dir/codex-desktop.desktop"

    {
        echo "[Desktop Entry]"
        echo "Name=Codex Desktop"
        echo "Comment=OpenAI Codex Desktop App"
        echo "Exec=$INSTALL_DIR/start.sh"
        [ -n "$icon_path" ] && echo "Icon=$icon_path"
        echo "Terminal=false"
        echo "Type=Application"
        echo "Categories=Development;IDE;"
        echo "StartupWMClass=codex"
    } > "$desktop_file"

    # Validate if desktop-file-validate is available
    if command -v desktop-file-validate &>/dev/null; then
        desktop-file-validate "$desktop_file" 2>/dev/null || true
    fi

    info "Desktop entry installed: $desktop_file"
}

# ---- Main ----
main() {
    echo "============================================" >&2
    echo "  Codex Desktop for Linux — Installer"       >&2
    echo "============================================" >&2
    echo ""                                             >&2

    local force=false
    local positional=()
    for arg in "$@"; do
        case "$arg" in
            --force) force=true ;;
            *)       positional+=("$arg") ;;
        esac
    done

    check_deps

    local dmg_path=""
    if [ "${#positional[@]}" -ge 1 ] && [ -f "${positional[0]}" ]; then
        dmg_path="$(realpath "${positional[0]}")"
        info "Using provided DMG: $dmg_path"
    else
        dmg_path=$(get_dmg)
    fi

    # Idempotency: we need the Electron version to compute the stamp,
    # but detection requires extracting the DMG. Do a quick extract just
    # for version detection first.
    local app_dir
    app_dir=$(extract_dmg "$dmg_path")

    detect_electron_version "$app_dir"

    if [ "$force" = false ] && check_stamp "$dmg_path"; then
        info "Installation is up to date (DMG, Electron $ELECTRON_VERSION, $ARCH unchanged)"
        info "  Re-run with --force to rebuild anyway"
        echo "  Run:  $INSTALL_DIR/start.sh"            >&2
        return 0
    fi

    patch_asar "$app_dir"
    download_electron
    extract_webview "$app_dir"
    install_app
    create_start_script
    install_desktop_entry "$app_dir"

    write_stamp "$dmg_path"

    if ! command -v codex &>/dev/null; then
        warn "Codex CLI not found. Install it: npm i -g @openai/codex"
    fi

    echo ""                                             >&2
    echo "============================================" >&2
    info "Installation complete!"
    echo "  Run:  $INSTALL_DIR/start.sh"                >&2
    echo "============================================" >&2
}

main "$@"
