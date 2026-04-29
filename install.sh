#!/bin/bash
set -Eeuo pipefail

# ============================================================================
# Codex Desktop for Linux — Installer
# Converts the official macOS Codex Desktop app to run on Linux
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${CODEX_INSTALL_ROOT:-$SCRIPT_DIR}"
INSTALL_DIR="${CODEX_INSTALL_DIR:-$INSTALL_ROOT/codex-app}"
ELECTRON_VERSION="41.3.0"
WORK_DIR="$(mktemp -d)"
ARCH="$(uname -m)"
ICON_SOURCE="$SCRIPT_DIR/assets/codex.png"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

dependency_help() {
    cat <<'EOF'
Run the helper to install them automatically:
  bash scripts/install-deps.sh

Or install manually:
  sudo apt install nodejs npm python3 p7zip-full curl unzip build-essential         # Debian/Ubuntu
  sudo dnf install nodejs npm python3 7zip curl unzip @development-tools            # Fedora 41+ (dnf5)
  sudo dnf install nodejs npm python3 p7zip p7zip-plugins curl unzip                # Fedora <41 (dnf)
    && sudo dnf groupinstall 'Development Tools'
  sudo pacman -S nodejs npm python p7zip curl unzip zstd base-devel                 # Arch
  sudo zypper install nodejs-default npm-default python3 p7zip-full curl unzip      # openSUSE
    && sudo zypper install -t pattern devel_basis
EOF
}

cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'error "Failed at line $LINENO (exit code $?)"' ERR

CACHED_DMG_PATH="$SCRIPT_DIR/Codex.dmg"
FRESH_INSTALL=0
REUSE_CACHED_DMG=1
PROVIDED_DMG_PATH=""

usage() {
    cat <<'HELP'
Usage: ./install.sh [OPTIONS] [path/to/Codex.dmg]

Converts the official macOS Codex Desktop app to run on Linux.

Options:
  -h, --help     Show this help message and exit
  --fresh        Remove existing install directory and cached DMG before building
  --reuse-dmg    Reuse cached Codex.dmg if present (default)

Environment variables:
  CODEX_INSTALL_DIR   Override the install directory (default: ./codex-app)

After install, launch with:
  ./codex-app/start.sh
HELP
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --fresh)
                FRESH_INSTALL=1
                REUSE_CACHED_DMG=0
                ;;
            --reuse-dmg)
                REUSE_CACHED_DMG=1
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            -*)
                error "Unknown option: $1 (see --help)"
                ;;
            *)
                [ -z "$PROVIDED_DMG_PATH" ] || error "Only one DMG path may be provided"
                PROVIDED_DMG_PATH="$1"
                ;;
        esac
        shift
    done
}

prepare_install() {
    if [ "$FRESH_INSTALL" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then
        info "Removing existing install directory: $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
    fi

    if [ "$FRESH_INSTALL" -eq 1 ] && [ "$REUSE_CACHED_DMG" -ne 1 ] && [ -f "$CACHED_DMG_PATH" ]; then
        info "Removing cached DMG: $CACHED_DMG_PATH"
        rm -f "$CACHED_DMG_PATH"
    fi
}

# ---- Check dependencies ----
check_deps() {
    local missing=()
    for cmd in node npm npx python3 7z curl unzip; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing dependencies: ${missing[*]}
$(dependency_help)"
    fi

    NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d v)
    if [ "$NODE_MAJOR" -lt 20 ]; then
        error "Node.js 20+ required (found $(node -v))"
    fi

    if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
        error "Build tools (make, g++) required:
$(dependency_help)"
    fi

    # Prefer modern 7-zip if available (required for APFS DMG)
    if command -v 7zz &>/dev/null; then
        SEVEN_ZIP_CMD="7zz"
    else
        SEVEN_ZIP_CMD="7z"
    fi

    if "$SEVEN_ZIP_CMD" 2>&1 | grep -m 1 "7-Zip" | grep -q "16.02"; then
        error "System 7-zip is too old for modern APFS DMGs.
Install a newer 7zz first by running:
  bash scripts/install-deps.sh

That helper bootstraps a current 7zz into ~/.local/bin by default.
If ~/.local/bin is not on your PATH, add it before re-running this script:
  export PATH=\"$HOME/.local/bin:$PATH\"
Set SEVENZIP_SYSTEM_INSTALL=1 to install into /usr/local/bin instead."
    fi

    info "All dependencies found (using $SEVEN_ZIP_CMD)"
}

# ---- Download or find Codex DMG ----
get_dmg() {
    local dmg_dest="$CACHED_DMG_PATH"

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

    local extract_dir="$WORK_DIR/dmg-extract"
    local seven_log="$WORK_DIR/7z.log"
    local seven_zip_status=0

    mkdir -p "$extract_dir"
    if "$SEVEN_ZIP_CMD" x -y -snl "$dmg_path" -o"$extract_dir" >"$seven_log" 2>&1; then
        :
    else
        seven_zip_status=$?
    fi

    local app_dir
    app_dir=$(find "$extract_dir" -maxdepth 3 -name "*.app" -type d | head -1)

    if [ "$seven_zip_status" -ne 0 ]; then
        if [ -n "$app_dir" ]; then
            warn "7z exited with code $seven_zip_status but app bundle was found; continuing"
            warn "$(tail -n 5 "$seven_log" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
        else
            cat "$seven_log" >&2
            error "Failed to extract DMG"
        fi
    fi

    [ -n "$app_dir" ] || error "Could not find .app bundle in DMG"

    info "Found: $(basename "$app_dir")"
    echo "$app_dir"
}

# ---- Detect Electron version from DMG ----
sanitize_electron_version() {
    local value="$1"
    value="${value#v}"
    value="${value#^}"
    value="${value#~}"

    if [[ "$value" =~ ^[0-9]+(\.[0-9]+){2}([.-][0-9A-Za-z]+)*$ ]]; then
        echo "$value"
        return 0
    fi

    return 1
}

detect_electron_version() {
    local app_dir="$1"
    local plist_file="$app_dir/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist"

    if [ -f "$plist_file" ]; then
        local detected detected_version
        detected=$(python3 - "$plist_file" <<'PY' 2>/dev/null || true
import sys
import xml.etree.ElementTree as ET

tree = ET.parse(sys.argv[1])
root = tree.getroot()
it = iter(root.iter())
for elem in it:
    if elem.tag == 'key' and elem.text == 'CFBundleVersion':
        try:
            print(next(it).text)
        except StopIteration:
            pass
        break
PY
)
        if detected_version=$(sanitize_electron_version "$detected"); then
            info "Detected Electron version from DMG: $detected_version"
            ELECTRON_VERSION="$detected_version"
            return
        elif [ -n "$detected" ]; then
            warn "Ignoring invalid Electron version from DMG: $detected"
        fi
    fi

    local resources_dir="$app_dir/Contents/Resources"
    if [ -f "$resources_dir/app.asar" ]; then
        local probe_dir detected_json detected_json_version
        probe_dir="$WORK_DIR/electron-version-probe"
        mkdir -p "$probe_dir"
        if (cd "$probe_dir" && npx --yes asar extract-file "$resources_dir/app.asar" package.json >/dev/null 2>&1); then
            detected_json=$(node -e "
const pkg = require(process.argv[1]);
process.stdout.write(String(pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? ''));
" "$probe_dir/package.json" 2>/dev/null || true)
        else
            detected_json=""
        fi

        if detected_json_version=$(sanitize_electron_version "$detected_json"); then
            info "Detected Electron version from package.json: $detected_json_version"
            ELECTRON_VERSION="$detected_json_version"
            return
        elif [ -n "$detected_json" ]; then
            warn "Ignoring invalid Electron version from package.json: $detected_json"
        fi
    fi

    warn "Could not auto-detect Electron version; using fallback $ELECTRON_VERSION"
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

    # Remove dead foreign prebuilds and build artifacts to save space.
    rm -rf "$WORK_DIR/app-extracted/node_modules/node-pty/prebuilds/darwin-"* \
           "$WORK_DIR/app-extracted/node_modules/node-pty/prebuilds/win32-"* \
           "$WORK_DIR/app-extracted/node_modules/node-pty/build/Release/obj.target" \
           2>/dev/null || true

    info "Patching Linux window and shell behavior..."
    node "$SCRIPT_DIR/scripts/patch-linux-window-ui.js" "$WORK_DIR/app-extracted"

    # Repack
    info "Repacking app.asar..."
    cd "$WORK_DIR"
    npx asar pack app-extracted app.asar --unpack "{*.node,*.so,*.so.*,*.dylib}" 2>/dev/null

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
        # Replace transparent startup background with an opaque color for Linux.
        # The upstream app relies on macOS vibrancy for the transparent effect;
        # on Linux the transparent background causes flickering.
        local webview_index="$INSTALL_DIR/content/webview/index.html"
        if [ -f "$webview_index" ]; then
            sed -i 's/--startup-background: transparent/--startup-background: #1e1e1e/' "$webview_index"
        fi
        info "Webview files copied"
    else
        warn "Webview directory not found in asar — app may not work"
    fi
}

# ---- Install app.asar ----
install_app() {
    mkdir -p "$INSTALL_DIR/resources"
    rm -f "$INSTALL_DIR/resources/app.asar"
    rm -rf "$INSTALL_DIR/resources/app.asar.unpacked"

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
LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop"
LOG_FILE="$LOG_DIR/launcher.log"
APP_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codex-desktop"
APP_PID_FILE="$APP_STATE_DIR/app.pid"
WEBVIEW_PID_FILE="$APP_STATE_DIR/webview.pid"
PACKAGED_RUNTIME_HELPER="$SCRIPT_DIR/.codex-linux/codex-packaged-runtime.sh"
APP_NOTIFICATION_ICON_NAME="codex-desktop"
APP_NOTIFICATION_ICON_BUNDLE="$SCRIPT_DIR/.codex-linux/$APP_NOTIFICATION_ICON_NAME.png"
APP_NOTIFICATION_ICON_SYSTEM="/usr/share/icons/hicolor/256x256/apps/$APP_NOTIFICATION_ICON_NAME.png"
APP_NOTIFICATION_ICON_REPO="$SCRIPT_DIR/../assets/codex.png"
USER_SUPPLIED_CODEX_CLI_PATH=0

mkdir -p "$LOG_DIR" "$APP_STATE_DIR"
STARTED_WEBVIEW_PID=""
ELECTRON_PID=""
RUNNING_APP_PID=""
WARM_START=0

if [ -n "${CODEX_CLI_PATH:-}" ]; then
    USER_SUPPLIED_CODEX_CLI_PATH=1
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
Usage: ./start.sh [OPTIONS] [-- ELECTRON_FLAGS...]

Launches the Codex Desktop app.

Options:
  -h, --help                  Show this help message and exit
  --disable-gpu               Completely disable GPU acceleration
  --disable-gpu-compositing   Disable GPU compositing (fixes flickering)
  --ozone-platform=x11        Force X11 instead of Wayland

Environment:
  CODEX_ENABLE_SANDBOX=1      Keep Chromium sandbox enabled (default: off)
  CODEX_GPU_MODE=MODE         conservative, auto, nvidia, or off
                              default: conservative
  CODEX_ENABLE_GPU_COMPOSITING=1  Legacy alias for CODEX_GPU_MODE=auto

Extra flags are passed directly to Electron.

Logs: ~/.cache/codex-desktop/launcher.log
HELP
    exit 0
fi

exec >>"$LOG_FILE" 2>&1

echo "[$(date -Is)] Starting Codex Desktop launcher"

now_ms() {
    local value
    value="$(date +%s%3N 2>/dev/null || true)"
    case "$value" in
        *N*|"") echo "$(($(date +%s) * 1000))" ;;
        *) echo "$value" ;;
    esac
}

LAUNCHER_START_MS="$(now_ms)"

log_phase() {
    local phase="$1"
    local elapsed_ms
    elapsed_ms="$(($(now_ms) - LAUNCHER_START_MS))"
    echo "[$(date -Is)] launcher_phase=$phase elapsedMs=$elapsed_ms"
}

load_packaged_runtime_helper() {
    if [ -f "$PACKAGED_RUNTIME_HELPER" ]; then
        # shellcheck disable=SC1090
        . "$PACKAGED_RUNTIME_HELPER"
    fi
}

run_packaged_runtime_prelaunch() {
    if declare -F codex_packaged_runtime_prelaunch >/dev/null 2>&1; then
        codex_packaged_runtime_prelaunch
    fi
}

export_packaged_runtime_env() {
    if declare -F codex_packaged_runtime_export_env >/dev/null 2>&1; then
        codex_packaged_runtime_export_env
    fi
}

run_cli_preflight() {
    local allow_install_missing="${1:-0}"
    if ! command -v codex-update-manager >/dev/null 2>&1; then
        if [ "$allow_install_missing" = "1" ]; then
            return 1
        fi
        return 0
    fi

    local -a preflight_args=(
        cli-preflight
        --print-path
    )
    if [ "$USER_SUPPLIED_CODEX_CLI_PATH" = "1" ] && [ -n "${CODEX_CLI_PATH:-}" ]; then
        preflight_args+=(--cli-path "$CODEX_CLI_PATH")
    fi
    if [ "$allow_install_missing" = "1" ]; then
        preflight_args+=(--allow-install-missing)
    fi

    local refreshed_path=""
    if ! refreshed_path="$(codex-update-manager "${preflight_args[@]}")"; then
        if [ "$allow_install_missing" = "1" ]; then
            return 1
        fi
        notify_error "Codex CLI prelaunch check failed. Continuing with the current CLI state. Check the launcher and updater logs if Codex Desktop misbehaves."
        return 0
    fi

    if [ -n "$refreshed_path" ]; then
        CODEX_CLI_PATH="$refreshed_path"
        export CODEX_CLI_PATH
    fi
}

run_cli_preflight_background() {
    if ! command -v codex-update-manager >/dev/null 2>&1; then
        return 0
    fi

    local -a preflight_args=(
        cli-preflight
        --print-path
    )
    if [ "$USER_SUPPLIED_CODEX_CLI_PATH" = "1" ] && [ -n "${CODEX_CLI_PATH:-}" ]; then
        preflight_args+=(--cli-path "$CODEX_CLI_PATH")
    fi

    (
        if ! codex-update-manager "${preflight_args[@]}" >/dev/null 2>&1; then
            echo "Codex CLI background preflight failed. Continuing with the current CLI."
        fi
    ) &
}

is_interactive_terminal() {
    [ -t 0 ] && [ -t 1 ]
}

prompt_install_missing_cli() {
    if ! is_interactive_terminal; then
        return 1
    fi

    if ! command -v codex-update-manager >/dev/null 2>&1; then
        return 1
    fi

    local reply=""
    printf 'Codex CLI is not installed. Install it now? [Y/n] '
    if ! read -r reply; then
        return 1
    fi

    case "$reply" in
        ""|y|Y|yes|YES|Yes)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

resolve_notification_icon() {
    local candidate
    for candidate in \
        "$APP_NOTIFICATION_ICON_BUNDLE" \
        "$APP_NOTIFICATION_ICON_SYSTEM" \
        "$APP_NOTIFICATION_ICON_REPO"
    do
        if [ -f "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done

    echo "$APP_NOTIFICATION_ICON_NAME"
}

find_codex_cli() {
    if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
        export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
        # shellcheck disable=SC1090
        . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
        if command -v codex >/dev/null 2>&1; then
            command -v codex
            return 0
        fi
    fi

    local candidate
    for candidate in \
        "$HOME/.nvm/versions/node/current/bin/codex" \
        "$HOME/.nvm/versions/node"/*/bin/codex \
        "$HOME/.npm-global/bin/codex" \
        "$HOME/.local/share/pnpm/codex" \
        "$HOME/.local/bin/codex" \
        "/usr/local/bin/codex" \
        "/usr/bin/codex"
    do
        if [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done

    if command -v codex >/dev/null 2>&1; then
        command -v codex
        return 0
    fi

    return 1
}

notify_error() {
    local message="$1"
    local icon
    icon="$(resolve_notification_icon)"
    echo "$message"
    if command -v notify-send >/dev/null 2>&1; then
        notify-send \
            -a "Codex Desktop" \
            -i "$icon" \
            -h "string:desktop-entry:codex-desktop" \
            "Codex Desktop" \
            "$message"
    fi
}

canonical_path() {
    readlink -f "$1" 2>/dev/null || echo "$1"
}

pid_is_current_user() {
    local pid="$1"
    local uid

    uid="$(awk '/^Uid:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)"
    [ "$uid" = "$(id -u)" ]
}

pid_matches_executable() {
    local pid="$1"
    local expected="$2"
    local actual

    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    [ -d "/proc/$pid" ] || return 1
    pid_is_current_user "$pid" || return 1
    actual="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
    [ "$actual" = "$(canonical_path "$expected")" ]
}

find_running_app_pid() {
    local pid

    if [ -f "$APP_PID_FILE" ]; then
        pid="$(cat "$APP_PID_FILE" 2>/dev/null || true)"
        if pid_matches_executable "$pid" "$SCRIPT_DIR/electron"; then
            echo "$pid"
            return 0
        fi
    fi

    local proc_exe
    for proc_exe in /proc/[0-9]*/exe; do
        [ -e "$proc_exe" ] || continue
        pid="${proc_exe#/proc/}"
        pid="${pid%/exe}"
        if pid_matches_executable "$pid" "$SCRIPT_DIR/electron"; then
            echo "$pid"
            return 0
        fi
    done

    return 1
}

detect_warm_start() {
    if RUNNING_APP_PID="$(find_running_app_pid)"; then
        WARM_START=1
        echo "$RUNNING_APP_PID" > "$APP_PID_FILE"
        echo "Detected running Codex Desktop pid=$RUNNING_APP_PID; using warm-start handoff"
    fi
}

wait_for_webview_server() {
    echo "Waiting for webview server on :5175"

    local attempt
    for attempt in $(seq 1 50); do
        if python3 -c "import socket; s=socket.socket(); s.settimeout(0.5); s.connect(('127.0.0.1', 5175)); s.close()" 2>/dev/null; then
            echo "Webview server is ready"
            return 0
        fi
        sleep 0.1
    done

    return 1
}

verify_webview_origin() {
    local url="$1"

    python3 - "$url" <<'PY'
import sys
import urllib.request

url = sys.argv[1]
required_markers = ("<title>Codex</title>", "startup-loader")

with urllib.request.urlopen(url, timeout=2) as response:
    body = response.read(8192).decode("utf-8", "ignore")

missing = [marker for marker in required_markers if marker not in body]
if missing:
    raise SystemExit(
        f"Webview origin validation failed for {url}; missing markers: {', '.join(missing)}"
    )
PY
}

pid_is_webview_server() {
    local pid="$1"
    local cmdline
    local cwd

    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    [ -d "/proc/$pid" ] || return 1
    pid_is_current_user "$pid" || return 1
    cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    [[ "$cmdline" == *"http.server 5175"* ]] || return 1
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [ "$cwd" = "$(canonical_path "$WEBVIEW_DIR")" ]
}

stop_owned_webview_server() {
    local pid=""

    if [ -f "$WEBVIEW_PID_FILE" ]; then
        pid="$(cat "$WEBVIEW_PID_FILE" 2>/dev/null || true)"
    fi

    if [ -n "$pid" ] && pid_is_webview_server "$pid"; then
        echo "Stopping owned webview server pid=$pid"
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 1 20); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.05
        done
    fi

    rm -f "$WEBVIEW_PID_FILE"
}

owned_webview_server_pid() {
    local pid=""

    if [ -f "$WEBVIEW_PID_FILE" ]; then
        pid="$(cat "$WEBVIEW_PID_FILE" 2>/dev/null || true)"
    fi

    if [ -n "$pid" ] && pid_is_webview_server "$pid"; then
        echo "$pid"
        return 0
    fi

    if [ -n "$pid" ]; then
        rm -f "$WEBVIEW_PID_FILE"
    fi

    return 1
}

discover_webview_server_pid() {
    local proc_cmdline
    local pid

    for proc_cmdline in /proc/[0-9]*/cmdline; do
        [ -e "$proc_cmdline" ] || continue
        pid="${proc_cmdline#/proc/}"
        pid="${pid%/cmdline}"
        if pid_is_webview_server "$pid"; then
            echo "$pid"
            return 0
        fi
    done

    return 1
}

adopt_existing_webview_server() {
    local pid

    if pid="$(owned_webview_server_pid)"; then
        STARTED_WEBVIEW_PID="$pid"
        return 0
    fi

    if pid="$(discover_webview_server_pid)"; then
        STARTED_WEBVIEW_PID="$pid"
        echo "$pid" > "$WEBVIEW_PID_FILE"
        echo "Adopted existing webview server pid=$pid dir=$WEBVIEW_DIR"
        return 0
    fi

    return 1
}

ensure_webview_server() {
    if [ ! -d "$WEBVIEW_DIR" ] || [ ! "$(ls -A "$WEBVIEW_DIR" 2>/dev/null)" ]; then
        return 0
    fi

    if adopt_existing_webview_server && verify_webview_origin "http://127.0.0.1:5175/index.html" >/dev/null 2>&1; then
        echo "Reusing existing verified webview server on :5175"
        log_phase "webview_reused"
        return 0
    fi

    if verify_webview_origin "http://127.0.0.1:5175/index.html" >/dev/null 2>&1; then
        notify_error "Codex Desktop webview port 5175 is already serving Codex content, but it is not owned by this launcher. Stop the other webview server and try again."
        exit 1
    fi

    stop_owned_webview_server

    cd "$WEBVIEW_DIR"
    python3 -m http.server 5175 --bind 127.0.0.1 &
    STARTED_WEBVIEW_PID=$!
    echo "$STARTED_WEBVIEW_PID" > "$WEBVIEW_PID_FILE"

    echo "Started webview server pid=$STARTED_WEBVIEW_PID dir=$WEBVIEW_DIR"

    if ! wait_for_webview_server; then
        notify_error "Codex Desktop webview server did not become ready on port 5175. Check the launcher log for the embedded http.server output."
        exit 1
    fi

    if ! kill -0 "$STARTED_WEBVIEW_PID" 2>/dev/null; then
        notify_error "Codex Desktop webview server exited before Electron launch. Another process may already be using port 5175."
        exit 1
    fi

    if ! verify_webview_origin "http://127.0.0.1:5175/index.html"; then
        notify_error "Codex Desktop webview origin validation failed. Another process may be serving port 5175 or the extracted webview bundle is incomplete."
        exit 1
    fi

    echo "Webview origin verified."
    log_phase "webview_ready"
}

clear_stale_pid_file() {
    if [ ! -f "$APP_PID_FILE" ]; then
        return 0
    fi

    local pid=""
    pid="$(cat "$APP_PID_FILE" 2>/dev/null || true)"
    if [ -z "$pid" ] || ! pid_matches_executable "$pid" "$SCRIPT_DIR/electron"; then
        rm -f "$APP_PID_FILE"
    fi
}

cleanup_launcher() {
    if [ -n "${ELECTRON_PID:-}" ] && [ -f "$APP_PID_FILE" ]; then
        local current_pid
        current_pid="$(cat "$APP_PID_FILE" 2>/dev/null || true)"
        if [ "$current_pid" = "$ELECTRON_PID" ]; then
            rm -f "$APP_PID_FILE"
        fi
    fi

    if [ -n "${STARTED_WEBVIEW_PID:-}" ] && pid_is_webview_server "$STARTED_WEBVIEW_PID"; then
        kill "$STARTED_WEBVIEW_PID" 2>/dev/null || true
        rm -f "$WEBVIEW_PID_FILE"
    fi
}

configure_gpu_mode() {
    local requested="${CODEX_GPU_MODE:-}"
    if [ -z "$requested" ] && [ -n "${CODEX_ENABLE_GPU_COMPOSITING:-}" ]; then
        requested="auto"
    fi
    if [ -z "$requested" ]; then
        requested="conservative"
    fi

    case "$requested" in
        conservative|auto|nvidia|off)
            ;;
        *)
            echo "Unknown CODEX_GPU_MODE=$requested; using conservative"
            requested="conservative"
            ;;
    esac

    CODEX_GPU_MODE="$requested"
    export CODEX_GPU_MODE

    if [ "$CODEX_GPU_MODE" = "nvidia" ]; then
        export __NV_PRIME_RENDER_OFFLOAD="${__NV_PRIME_RENDER_OFFLOAD:-1}"
        export __GLX_VENDOR_LIBRARY_NAME="${__GLX_VENDOR_LIBRARY_NAME:-nvidia}"
        export __VK_LAYER_NV_optimus="${__VK_LAYER_NV_optimus:-NVIDIA_only}"
    fi
}

log_gpu_diagnostics() {
    echo "GPU mode: $CODEX_GPU_MODE"
    echo "Display: XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-} DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}"

    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "nvidia-smi:"
        nvidia-smi --query-gpu=name,driver_version,pci.bus_id --format=csv,noheader 2>&1 || true
    else
        echo "nvidia-smi: unavailable"
    fi

    if command -v glxinfo >/dev/null 2>&1; then
        echo "glxinfo -B:"
        glxinfo -B 2>&1 | sed -n '1,25p' || true
    else
        echo "glxinfo: unavailable"
    fi
}

launch_electron() {
    cd "$SCRIPT_DIR"
    log_phase "electron_launch"

    local -a electron_flags=(
        --class=codex-desktop
        --app-id=codex-desktop
        --ozone-platform-hint=auto
        --disable-gpu-sandbox
        --enable-features=WaylandWindowDecorations
    )

    if [ -z "${CODEX_ENABLE_SANDBOX:-}" ]; then
        electron_flags+=(--no-sandbox)
    fi

    case "$CODEX_GPU_MODE" in
        conservative)
            electron_flags+=(--disable-gpu-compositing)
            ;;
        off)
            electron_flags+=(--disable-gpu --disable-gpu-compositing)
            ;;
    esac

    echo "Electron flags: ${electron_flags[*]}"
    log_gpu_diagnostics

    if [ "$WARM_START" -eq 1 ]; then
        "$SCRIPT_DIR/electron" "${electron_flags[@]}" "$@"
        return $?
    fi

    "$SCRIPT_DIR/electron" "${electron_flags[@]}" "$@" &
    ELECTRON_PID=$!
    echo "$ELECTRON_PID" > "$APP_PID_FILE"
    log_phase "electron_spawned"

    set +e
    wait "$ELECTRON_PID"
    local status=$?
    set -e
    return "$status"
}

load_packaged_runtime_helper
clear_stale_pid_file
detect_warm_start
trap cleanup_launcher EXIT

if [ "$WARM_START" -eq 0 ]; then
    run_packaged_runtime_prelaunch
    log_phase "packaged_prelaunch"
    ensure_webview_server
else
    echo "Skipping packaged prelaunch and webview setup for warm start"
    log_phase "warm_start_ready"
fi

if [ "$WARM_START" -eq 0 ] && [ -z "${CODEX_CLI_PATH:-}" ]; then
    CODEX_CLI_PATH="$(find_codex_cli || true)"
    export CODEX_CLI_PATH
    log_phase "cli_lookup"
fi
export CHROME_DESKTOP="${CHROME_DESKTOP:-codex-desktop.desktop}"

if [ "$WARM_START" -eq 0 ] && [ -z "$CODEX_CLI_PATH" ]; then
    if prompt_install_missing_cli; then
        if ! run_cli_preflight 1; then
            notify_error "Codex CLI automatic installation failed. Install with: npm i -g @openai/codex or npm i -g --prefix ~/.local @openai/codex"
            exit 1
        fi
    fi
fi

if [ "$WARM_START" -eq 0 ] && [ -z "$CODEX_CLI_PATH" ]; then
    notify_error "Codex CLI not found. Install with: npm i -g @openai/codex or npm i -g --prefix ~/.local @openai/codex"
    exit 1
fi

if [ "$WARM_START" -eq 0 ]; then
    if [ "${CODEX_SYNC_CLI_PREFLIGHT:-0}" = "1" ]; then
        run_cli_preflight 0
        log_phase "cli_preflight_sync"
    else
        run_cli_preflight_background
        log_phase "cli_preflight_backgrounded"
    fi
fi

export_packaged_runtime_env
configure_gpu_mode

echo "Using CODEX_CLI_PATH=${CODEX_CLI_PATH:-warm-start-skip}"

launch_electron "$@"
SCRIPT

    chmod +x "$INSTALL_DIR/start.sh"
    mkdir -p "$INSTALL_DIR/.codex-linux"
    if [ -f "$ICON_SOURCE" ]; then
        cp "$ICON_SOURCE" "$INSTALL_DIR/.codex-linux/codex-desktop.png"
    else
        warn "Notification icon not found at $ICON_SOURCE"
    fi
    info "Start script created"
}

# ---- Main ----
main() {
    echo "============================================" >&2
    echo "  Codex Desktop for Linux — Installer"       >&2
    echo "============================================" >&2
    echo ""                                             >&2

    parse_args "$@"
    check_deps
    prepare_install

    local dmg_path=""
    if [ -n "$PROVIDED_DMG_PATH" ]; then
        [ -f "$PROVIDED_DMG_PATH" ] || error "Provided DMG not found: $PROVIDED_DMG_PATH"
        dmg_path="$(realpath "$PROVIDED_DMG_PATH")"
        info "Using provided DMG: $dmg_path"
    else
        dmg_path=$(get_dmg)
    fi

    local app_dir
    app_dir=$(extract_dmg "$dmg_path")

    detect_electron_version "$app_dir"

    patch_asar "$app_dir"
    download_electron
    extract_webview "$app_dir"
    install_app
    create_start_script

    if ! command -v codex &>/dev/null; then
        warn "Codex CLI not found. Install it with: npm i -g @openai/codex or npm i -g --prefix ~/.local @openai/codex"
    fi

    echo ""                                             >&2
    echo "============================================" >&2
    info "Installation complete!"
    echo "  Run:  $INSTALL_DIR/start.sh"                >&2
    echo "============================================" >&2
}

main "$@"
