#!/bin/bash

DEFAULT_DMG_URL="${DEFAULT_DMG_URL:-https://persistent.oaistatic.com/codex-app-prod/Codex.dmg}"
ELECTRON_VERSION="${ELECTRON_VERSION:-40.0.0}"
ARCH="${ARCH:-$(uname -m)}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CURRENT_WORK_DIR=""

info()  { echo -e "${GREEN}[INFO]${NC} $*" >&2; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

cleanup_work_dir() {
    if [ -n "${CURRENT_WORK_DIR:-}" ] && [ -d "${CURRENT_WORK_DIR:-}" ]; then
        rm -rf "$CURRENT_WORK_DIR"
    fi
    CURRENT_WORK_DIR=""
}

create_work_dir() {
    cleanup_work_dir
    CURRENT_WORK_DIR="$(mktemp -d)"
}

timestamp_now() {
    date -Iseconds
}

ensure_state_dir() {
    mkdir -p "$STATE_DIR"
}

append_log() {
    ensure_state_dir
    printf '[%s] %s\n' "$(timestamp_now)" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

write_shell_var() {
    local name="$1"
    local value="$2"
    printf '%s=%q\n' "$name" "$value"
}

load_state() {
    INSTALLED_FINGERPRINT=""
    INSTALLED_ETAG=""
    INSTALLED_LAST_MODIFIED=""
    INSTALLED_CONTENT_LENGTH=""
    LAST_CHECK_AT=""
    LAST_UPDATE_STATUS=""
    LAST_ERROR=""
    PENDING_FINGERPRINT=""
    PENDING_ETAG=""
    PENDING_LAST_MODIFIED=""
    PENDING_CONTENT_LENGTH=""

    if [ -f "$STATE_FILE" ]; then
        # shellcheck disable=SC1090
        source "$STATE_FILE"
    fi
}

save_state() {
    local target="${1:-$STATE_FILE}"
    mkdir -p "$(dirname "$target")"
    {
        write_shell_var INSTALLED_FINGERPRINT "$INSTALLED_FINGERPRINT"
        write_shell_var INSTALLED_ETAG "$INSTALLED_ETAG"
        write_shell_var INSTALLED_LAST_MODIFIED "$INSTALLED_LAST_MODIFIED"
        write_shell_var INSTALLED_CONTENT_LENGTH "$INSTALLED_CONTENT_LENGTH"
        write_shell_var LAST_CHECK_AT "$LAST_CHECK_AT"
        write_shell_var LAST_UPDATE_STATUS "$LAST_UPDATE_STATUS"
        write_shell_var LAST_ERROR "$LAST_ERROR"
        write_shell_var PENDING_FINGERPRINT "$PENDING_FINGERPRINT"
        write_shell_var PENDING_ETAG "$PENDING_ETAG"
        write_shell_var PENDING_LAST_MODIFIED "$PENDING_LAST_MODIFIED"
        write_shell_var PENDING_CONTENT_LENGTH "$PENDING_CONTENT_LENGTH"
    } > "$target"
}

mark_pending_update() {
    PENDING_FINGERPRINT="$REMOTE_FINGERPRINT"
    PENDING_ETAG="$REMOTE_ETAG"
    PENDING_LAST_MODIFIED="$REMOTE_LAST_MODIFIED"
    PENDING_CONTENT_LENGTH="$REMOTE_CONTENT_LENGTH"
    touch "$PENDING_FILE"
}

clear_pending_update() {
    PENDING_FINGERPRINT=""
    PENDING_ETAG=""
    PENDING_LAST_MODIFIED=""
    PENDING_CONTENT_LENGTH=""
    rm -f "$PENDING_FILE"
}

acquire_update_lock() {
    ensure_state_dir
    LOCK_DIR="$STATE_DIR/lock"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        printf '%s\n' "$$" > "$LOCK_DIR/pid"
        return 0
    fi
    return 1
}

release_update_lock() {
    if [ -n "${LOCK_DIR:-}" ] && [ -d "${LOCK_DIR:-}" ]; then
        rm -rf "$LOCK_DIR"
    fi
}

check_deps() {
    local missing=()
    local cmd

    for cmd in node npm npx python3 7z curl unzip pgrep; do
        command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done

    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing dependencies: ${missing[*]}
Install them first:
  sudo apt install nodejs npm python3 p7zip-full curl unzip procps build-essential  # Debian/Ubuntu
  sudo dnf install nodejs npm python3 p7zip curl unzip procps-ng && sudo dnf groupinstall 'Development Tools'  # Fedora
  sudo pacman -S nodejs npm python p7zip curl unzip procps-ng base-devel  # Arch"
    fi

    NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d v)
    if [ "$NODE_MAJOR" -lt 20 ]; then
        error "Node.js 20+ required (found $(node -v))"
    fi

    if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
        error "Build tools (make, g++) required:
  sudo apt install build-essential   # Debian/Ubuntu
  sudo dnf groupinstall 'Development Tools'  # Fedora
  sudo pacman -S base-devel          # Arch"
    fi

    info "All dependencies found"
}

resolve_electron_arch() {
    case "$ARCH" in
        x86_64)  echo "x64" ;;
        aarch64) echo "arm64" ;;
        armv7l)  echo "armv7l" ;;
        *)       error "Unsupported architecture: $ARCH" ;;
    esac
}

download_codex_dmg() {
    local dest="$1"
    local url="${CODEX_UPDATE_URL:-$DEFAULT_DMG_URL}"

    mkdir -p "$(dirname "$dest")"
    info "Downloading Codex Desktop DMG..."
    info "URL: $url"

    if ! curl -fL --progress-bar --max-time 600 --connect-timeout 30 -o "$dest" "$url"; then
        rm -f "$dest"
        return 1
    fi

    [ -s "$dest" ] || {
        rm -f "$dest"
        return 1
    }

    info "Saved: $dest ($(du -h "$dest" | cut -f1))"
}

get_dmg_for_install() {
    local cache_path="$1"

    if [ -s "$cache_path" ]; then
        info "Using cached DMG: $cache_path ($(du -h "$cache_path" | cut -f1))"
        printf '%s\n' "$cache_path"
        return 0
    fi

    download_codex_dmg "$cache_path" || \
        error "Download failed. Download manually and place the DMG at: $cache_path"
    printf '%s\n' "$cache_path"
}

extract_dmg() {
    local dmg_path="$1"
    local extract_dir="$CURRENT_WORK_DIR/dmg-extract"

    info "Extracting DMG with 7z..."
    7z x -y "$dmg_path" -o"$extract_dir" >&2 || error "Failed to extract DMG"

    local app_dir
    app_dir=$(find "$extract_dir" -maxdepth 3 -name "*.app" -type d | head -1)
    [ -n "$app_dir" ] || error "Could not find .app bundle in DMG"

    info "Found: $(basename "$app_dir")"
    printf '%s\n' "$app_dir"
}

build_native_modules() {
    local app_extracted="$1"
    local build_dir="$CURRENT_WORK_DIR/native-build"
    local bs3_ver
    local npty_ver

    bs3_ver=$(node -p "require('$app_extracted/node_modules/better-sqlite3/package.json').version" 2>/dev/null || echo "")
    npty_ver=$(node -p "require('$app_extracted/node_modules/node-pty/package.json').version" 2>/dev/null || echo "")

    [ -n "$bs3_ver" ] || error "Could not detect better-sqlite3 version"
    [ -n "$npty_ver" ] || error "Could not detect node-pty version"

    info "Native modules: better-sqlite3@$bs3_ver, node-pty@$npty_ver"

    mkdir -p "$build_dir"
    cd "$build_dir"

    printf '%s\n' '{"private":true}' > package.json

    info "Installing fresh sources from npm..."
    npm install "electron@$ELECTRON_VERSION" --save-dev --ignore-scripts >&2
    npm install "better-sqlite3@$bs3_ver" "node-pty@$npty_ver" --ignore-scripts >&2

    info "Compiling for Electron v$ELECTRON_VERSION (this takes ~1 min)..."
    npx --yes @electron/rebuild -v "$ELECTRON_VERSION" --force >&2

    info "Native modules built successfully"

    rm -rf "$app_extracted/node_modules/better-sqlite3"
    rm -rf "$app_extracted/node_modules/node-pty"
    cp -r "$build_dir/node_modules/better-sqlite3" "$app_extracted/node_modules/"
    cp -r "$build_dir/node_modules/node-pty" "$app_extracted/node_modules/"
}

patch_asar() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"
    local extracted_dir="$CURRENT_WORK_DIR/app-extracted"

    [ -f "$resources_dir/app.asar" ] || error "app.asar not found in $resources_dir"

    info "Extracting app.asar..."
    cd "$CURRENT_WORK_DIR"
    npx --yes asar extract "$resources_dir/app.asar" "$extracted_dir"

    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        mkdir -p "$CURRENT_WORK_DIR/app.asar.unpacked"
        cp -r "$resources_dir/app.asar.unpacked/"* "$CURRENT_WORK_DIR/app.asar.unpacked/" 2>/dev/null || true
        cp -r "$resources_dir/app.asar.unpacked/"* "$extracted_dir/" 2>/dev/null || true
    fi

    rm -rf "$extracted_dir/node_modules/sparkle-darwin" 2>/dev/null || true
    find "$extracted_dir" -name "sparkle.node" -delete 2>/dev/null || true

    build_native_modules "$extracted_dir"

    info "Repacking app.asar..."
    cd "$CURRENT_WORK_DIR"
    npx asar pack "$extracted_dir" "$CURRENT_WORK_DIR/app.asar" --unpack "{*.node,*.so,*.dylib}" 2>/dev/null

    info "app.asar patched"
}

download_electron() {
    local target_dir="$1"
    local electron_arch
    local electron_url

    electron_arch="$(resolve_electron_arch)"
    electron_url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-${electron_arch}.zip"

    info "Downloading Electron v${ELECTRON_VERSION} for Linux..."
    curl -fL --progress-bar -o "$CURRENT_WORK_DIR/electron.zip" "$electron_url"

    mkdir -p "$target_dir"
    cd "$target_dir"
    unzip -qo "$CURRENT_WORK_DIR/electron.zip"

    info "Electron ready"
}

extract_webview() {
    local target_dir="$1"
    local asar_extracted="$CURRENT_WORK_DIR/app-extracted"

    mkdir -p "$target_dir/content/webview"
    if [ -d "$asar_extracted/webview" ]; then
        cp -r "$asar_extracted/webview/"* "$target_dir/content/webview/" 2>/dev/null || true
        info "Webview files copied"
    else
        warn "Webview directory not found in asar — app may not work"
    fi
}

install_app_bundle() {
    local target_dir="$1"

    mkdir -p "$target_dir/resources"
    cp "$CURRENT_WORK_DIR/app.asar" "$target_dir/resources/"
    if [ -d "$CURRENT_WORK_DIR/app.asar.unpacked" ]; then
        cp -r "$CURRENT_WORK_DIR/app.asar.unpacked" "$target_dir/resources/"
    fi

    info "app.asar installed"
}

create_start_script() {
    local target_dir="$1"

    cat > "$target_dir/start.sh" <<'SCRIPT'
#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBVIEW_DIR="$SCRIPT_DIR/content/webview"

if [ "${CODEX_AUTO_UPDATE:-1}" != "0" ] && [ -x "$SCRIPT_DIR/update.sh" ]; then
    "$SCRIPT_DIR/update.sh" --foreground || echo "[WARN] Launch-time update failed, starting current version" >&2
fi

pkill -f "http.server 5175" 2>/dev/null || true
sleep 0.3

if [ -d "$WEBVIEW_DIR" ] && [ "$(ls -A "$WEBVIEW_DIR" 2>/dev/null)" ]; then
    cd "$WEBVIEW_DIR"
    python3 -m http.server 5175 > /dev/null 2>&1 &
    HTTP_PID=$!
    trap "kill $HTTP_PID 2>/dev/null" EXIT
fi

export CODEX_CLI_PATH="${CODEX_CLI_PATH:-$(which codex 2>/dev/null)}"

if [ -z "$CODEX_CLI_PATH" ]; then
    echo "Error: Codex CLI not found. Install with: npm i -g @openai/codex"
    exit 1
fi

cd "$SCRIPT_DIR"
exec "$SCRIPT_DIR/electron" --no-sandbox "$@"
SCRIPT

    chmod +x "$target_dir/start.sh"
}

create_update_script() {
    local target_dir="$1"

    cat > "$target_dir/update.sh" <<'SCRIPT'
#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR"
STATE_DIR="$INSTALL_DIR/.updater"
STATE_FILE="$STATE_DIR/state.env"
PENDING_FILE="$STATE_DIR/pending"
LOG_FILE="$STATE_DIR/update.log"
LIB_PATH="$STATE_DIR/lib.sh"
RUNTIME_LIBRARY_SOURCE="$LIB_PATH"
MODE="${1:---foreground}"

if [ ! -f "$LIB_PATH" ]; then
    echo "[ERROR] Updater library not found at $LIB_PATH" >&2
    exit 1
fi

# shellcheck disable=SC1090
source "$LIB_PATH"
trap cleanup_work_dir EXIT

case "$MODE" in
    --foreground|--background) ;;
    *)
        echo "Usage: $0 [--foreground|--background]" >&2
        exit 1
        ;;
esac

if [ "${CODEX_AUTO_UPDATE:-1}" = "0" ]; then
    info "Auto-update disabled (CODEX_AUTO_UPDATE=0)"
    exit 0
fi

ensure_state_dir
if ! acquire_update_lock; then
    append_log "Skipping $MODE update because another updater instance is running"
    exit 0
fi
trap 'release_update_lock; cleanup_work_dir' EXIT INT TERM

load_state
LAST_CHECK_AT="$(timestamp_now)"

if ! refresh_remote_fingerprint; then
    LAST_UPDATE_STATUS="check-failed"
    LAST_ERROR="Unable to fetch update headers"
    save_state
    append_log "Failed to fetch update headers"
    exit 0
fi

if ! update_available; then
    clear_pending_update
    LAST_UPDATE_STATUS="up-to-date"
    LAST_ERROR=""
    save_state
    append_log "No update available"
    exit 0
fi

if [ "$MODE" = "--background" ] && is_codex_running; then
    mark_pending_update
    LAST_UPDATE_STATUS="pending"
    LAST_ERROR=""
    save_state
    append_log "Update available but Codex is running; deferring install to next launch"
    exit 0
fi

if install_remote_update; then
    LAST_UPDATE_STATUS="updated"
    LAST_ERROR=""
    save_state
    append_log "Successfully installed update"
    exit 0
fi

LAST_UPDATE_STATUS="install-failed"
LAST_ERROR="Update attempt failed"
save_state
append_log "Update installation failed; leaving current version in place"
exit 0
SCRIPT

    chmod +x "$target_dir/update.sh"
}

copy_runtime_library() {
    local target_dir="$1"

    mkdir -p "$target_dir/.updater"
    cp "$RUNTIME_LIBRARY_SOURCE" "$target_dir/.updater/lib.sh"
    chmod +x "$target_dir/.updater/lib.sh"
}

prepare_updater_state_dir() {
    local target_dir="$1"

    mkdir -p "$target_dir/.updater"
    : > "$target_dir/.updater/update.log"
}

install_runtime_assets() {
    local target_dir="$1"

    prepare_updater_state_dir "$target_dir"
    copy_runtime_library "$target_dir"
    create_update_script "$target_dir"
    create_start_script "$target_dir"
}

perform_install_pipeline() {
    local dmg_path="$1"
    local target_dir="$2"
    local app_dir

    rm -rf "$target_dir"
    mkdir -p "$target_dir"

    if [ -z "${CURRENT_WORK_DIR:-}" ] || [ ! -d "${CURRENT_WORK_DIR:-}" ]; then
        create_work_dir
    fi

    app_dir="$(extract_dmg "$dmg_path")"
    patch_asar "$app_dir"
    download_electron "$target_dir"
    extract_webview "$target_dir"
    install_app_bundle "$target_dir"
    install_runtime_assets "$target_dir"
}

promote_stage_install() {
    local stage_dir="$1"
    local live_dir="$2"
    local backup_dir="${live_dir}.previous"

    rm -rf "$backup_dir"
    if [ -d "$live_dir" ]; then
        mv "$live_dir" "$backup_dir"
    fi

    mv "$stage_dir" "$live_dir"
    rm -rf "$backup_dir"
}

systemd_quote() {
    local value="$1"
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf '"%s"' "$value"
}

install_systemd_user_units() {
    local systemd_user_dir
    local service_path
    local timer_path

    systemd_user_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    service_path="$systemd_user_dir/codex-desktop-updater.service"
    timer_path="$systemd_user_dir/codex-desktop-updater.timer"

    mkdir -p "$systemd_user_dir"

    cat > "$service_path" <<EOF
[Unit]
Description=Codex Desktop auto-updater
ConditionPathExists=$(systemd_quote "$INSTALL_DIR/update.sh")

[Service]
Type=oneshot
ExecStart=/usr/bin/bash $(systemd_quote "$INSTALL_DIR/update.sh") --background
EOF

    cat > "$timer_path" <<'EOF'
[Unit]
Description=Daily Codex Desktop update check

[Timer]
OnBootSec=15m
OnUnitActiveSec=1d
Persistent=true

[Install]
WantedBy=timers.target
EOF

    if ! command -v systemctl >/dev/null 2>&1; then
        warn "systemctl not found; skipping auto-update timer setup"
        return 0
    fi

    if ! systemctl --user daemon-reload; then
        warn "Could not reload user systemd units; background updates may be unavailable"
        return 0
    fi

    if ! systemctl --user enable --now codex-desktop-updater.timer; then
        warn "Could not enable the user timer automatically; run: systemctl --user enable --now codex-desktop-updater.timer"
        return 0
    fi

    info "Enabled user timer: codex-desktop-updater.timer"
}

write_initial_state() {
    INSTALLED_FINGERPRINT=""
    INSTALLED_ETAG=""
    INSTALLED_LAST_MODIFIED=""
    INSTALLED_CONTENT_LENGTH=""
    LAST_CHECK_AT=""
    LAST_UPDATE_STATUS="fresh-install"
    LAST_ERROR=""
    PENDING_FINGERPRINT=""
    PENDING_ETAG=""
    PENDING_LAST_MODIFIED=""
    PENDING_CONTENT_LENGTH=""
    save_state "$1/.updater/state.env"
}

header_value() {
    local name="$1"
    local headers="$2"

    printf '%s\n' "$headers" | awk -v key="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" '
        {
            line=$0
            sub(/\r$/, "", line)
            if (tolower(line) ~ ("^" key ":")) {
                sub(/^[^:]*:[[:space:]]*/, "", line)
                print line
                exit
            }
        }
    '
}

refresh_remote_fingerprint() {
    local headers
    local update_url="${CODEX_UPDATE_URL:-$DEFAULT_DMG_URL}"

    if ! headers="$(curl -fsSI --connect-timeout 20 --max-time 60 "$update_url")"; then
        return 1
    fi

    REMOTE_ETAG="$(header_value "etag" "$headers")"
    REMOTE_LAST_MODIFIED="$(header_value "last-modified" "$headers")"
    REMOTE_CONTENT_LENGTH="$(header_value "content-length" "$headers")"

    if [ -z "$REMOTE_ETAG" ] && [ -z "$REMOTE_LAST_MODIFIED" ] && [ -z "$REMOTE_CONTENT_LENGTH" ]; then
        return 1
    fi

    REMOTE_FINGERPRINT="etag=${REMOTE_ETAG};last_modified=${REMOTE_LAST_MODIFIED};content_length=${REMOTE_CONTENT_LENGTH}"
    return 0
}

update_available() {
    if [ -f "$PENDING_FILE" ]; then
        return 0
    fi

    [ "$REMOTE_FINGERPRINT" != "$INSTALLED_FINGERPRINT" ]
}

is_codex_running() {
    pgrep -f "$INSTALL_DIR/electron" >/dev/null 2>&1
}

install_remote_update() {
    local stage_dir="${INSTALL_DIR}.next.$$"
    local dmg_path

    create_work_dir
    dmg_path="$CURRENT_WORK_DIR/Codex.dmg"

    append_log "Downloading new Codex DMG for install"
    if ! download_codex_dmg "$dmg_path"; then
        append_log "Download failed"
        return 1
    fi

    if ! perform_install_pipeline "$dmg_path" "$stage_dir"; then
        rm -rf "$stage_dir"
        return 1
    fi

    INSTALLED_FINGERPRINT="$REMOTE_FINGERPRINT"
    INSTALLED_ETAG="$REMOTE_ETAG"
    INSTALLED_LAST_MODIFIED="$REMOTE_LAST_MODIFIED"
    INSTALLED_CONTENT_LENGTH="$REMOTE_CONTENT_LENGTH"
    LAST_CHECK_AT="$(timestamp_now)"
    clear_pending_update
    LAST_ERROR=""

    save_state "$stage_dir/.updater/state.env"
    promote_stage_install "$stage_dir" "$INSTALL_DIR"
    return 0
}

print_install_banner() {
    echo "============================================" >&2
    echo "  Codex Desktop for Linux — Installer" >&2
    echo "============================================" >&2
    echo "" >&2
}
