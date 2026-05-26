#!/usr/bin/env bash
# Guided, conservative setup helper for native Codex Desktop Linux builds.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FEATURES_ROOT="${CODEX_LINUX_FEATURES_ROOT:-$REPO_DIR/linux-features}"
PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"

info() {
    echo "[setup] $*"
}

warn() {
    echo "[setup][WARN] $*" >&2
}

error() {
    echo "[setup][ERROR] $*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: scripts/bootstrap-wizard.sh [--help]

Environment:
  CODEX_BOOTSTRAP_NONINTERACTIVE=1     never prompt
  CODEX_BOOTSTRAP_DRY_RUN=1            preview install/cleanup actions without changing them
  CODEX_BOOTSTRAP_INSTALL_DEPS=1       run bash scripts/install-deps.sh after checks
  CODEX_BOOTSTRAP_INSTALL_NATIVE=1     run make install-native after checks
  CODEX_BOOTSTRAP_CLEANUP_FEATURES=a,b cleanup feature-owned data with confirmation
  CODEX_LINUX_FEATURES=a,b             enable build-time Linux features
  CODEX_LINUX_DISABLE_FEATURES=a,b     disable build-time Linux features
  CODEX_LINUX_FEATURES_ROOT=/path      override linux-features root
  CODEX_LINUX_FEATURES_CONFIG=/path    override features.json path
  PACKAGE_NAME=codex-cua-lab           check side-by-side installed package state
  PACKAGE_WITH_UPDATER=0               choose manual-update package mode

The wizard is conservative: it does not install packages, start services, stop
ydotoold, or delete feature-owned user data unless the user explicitly asks and
confirms exact paths. It prepares feature config and prints the exact
rebuild/reinstall command to run next.
EOF
}

case "${1:-}" in
    -h|--help)
        usage
        exit 0
        ;;
    "")
        ;;
    *)
        error "Unknown argument: $1"
        ;;
esac

truthy() {
    case "${1:-}" in
        1|true|True|TRUE|yes|Yes|YES|on|On|ON)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

falsy() {
    case "${1:-}" in
        0|false|False|FALSE|no|No|NO|off|Off|OFF)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

noninteractive_mode() {
    truthy "${CODEX_BOOTSTRAP_NONINTERACTIVE:-0}" || ! [ -t 0 ]
}

dry_run_enabled() {
    truthy "${CODEX_BOOTSTRAP_DRY_RUN:-0}"
}

prompt_read() {
    local __var="$1"
    local prompt="$2"
    if read -r -p "$prompt" "$__var"; then
        return 0
    fi
    printf -v "$__var" ''
    echo
    return 1
}

env_flag_enabled() {
    local name="$1"
    local value="${!name:-}"
    [ -n "${!name+x}" ] || return 1
    if truthy "$value"; then
        return 0
    fi
    if falsy "$value"; then
        return 1
    fi
    error "$name must be 1 or 0"
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

feature_config_path() {
    if [ -n "${CODEX_LINUX_FEATURES_CONFIG:-}" ]; then
        printf '%s\n' "$CODEX_LINUX_FEATURES_CONFIG"
    else
        printf '%s\n' "$FEATURES_ROOT/features.json"
    fi
}

os_release_field() {
    local field="$1"
    local file line value

    for file in ${OS_RELEASE_FILE:-} /etc/os-release /usr/lib/os-release; do
        [ -n "$file" ] || continue
        [ -r "$file" ] || continue
        while IFS= read -r line; do
            case "$line" in
                "$field="*)
                    value="${line#*=}"
                    value="${value#\"}"
                    value="${value%\"}"
                    value="${value#\'}"
                    value="${value%\'}"
                    printf '%s\n' "${value,,}"
                    return 0
                    ;;
            esac
        done < "$file"
    done

    return 1
}

os_release_matches() {
    local expected token
    for expected in "$@"; do
        [ "${OS_RELEASE_ID:-}" = "$expected" ] && return 0
        for token in ${OS_RELEASE_ID_LIKE:-}; do
            [ "$token" = "$expected" ] && return 0
        done
    done
    return 1
}

detect_package_manager() {
    if os_release_matches debian ubuntu linuxmint pop elementary zorin && command -v apt-get >/dev/null 2>&1; then
        echo "apt"
    elif os_release_matches arch archlinux manjaro endeavouros artix && command -v pacman >/dev/null 2>&1; then
        echo "pacman"
    elif os_release_matches opensuse suse sles && command -v zypper >/dev/null 2>&1; then
        echo "zypper"
    elif os_release_matches fedora rhel centos rocky almalinux ol; then
        if command -v dnf5 >/dev/null 2>&1; then
            echo "dnf5"
        elif command -v dnf >/dev/null 2>&1; then
            echo "dnf"
        else
            echo "unknown"
        fi
    elif command -v apt-get >/dev/null 2>&1; then
        echo "apt"
    elif command -v dnf5 >/dev/null 2>&1; then
        echo "dnf5"
    elif command -v dnf >/dev/null 2>&1; then
        echo "dnf"
    elif command -v pacman >/dev/null 2>&1; then
        echo "pacman"
    elif command -v zypper >/dev/null 2>&1; then
        echo "zypper"
    else
        echo "unknown"
    fi
}

detect_package_format() {
    if os_release_matches arch archlinux manjaro endeavouros artix; then
        echo "pacman"
    elif os_release_matches fedora rhel centos rocky almalinux ol sles suse opensuse; then
        echo "rpm"
    elif os_release_matches debian ubuntu linuxmint pop elementary zorin; then
        echo "deb"
    elif command -v pacman >/dev/null 2>&1 && ! command -v dpkg-deb >/dev/null 2>&1; then
        echo "pacman"
    elif command -v rpmbuild >/dev/null 2>&1 && ! command -v dpkg-deb >/dev/null 2>&1; then
        echo "rpm"
    elif command -v dpkg-deb >/dev/null 2>&1; then
        echo "deb"
    elif command -v rpmbuild >/dev/null 2>&1; then
        echo "rpm"
    elif command -v pacman >/dev/null 2>&1; then
        echo "pacman"
    else
        echo "unknown"
    fi
}

command_status() {
    local name="$1"
    if command -v "$name" >/dev/null 2>&1; then
        printf '%s' "$(command -v "$name")"
    else
        printf 'missing'
    fi
}

service_state() {
    local unit="$1"
    local scope="${2:-system}"
    if ! command -v systemctl >/dev/null 2>&1; then
        printf 'systemctl missing'
        return
    fi

    local active enabled
    if [ "$scope" = "user" ]; then
        active="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
        enabled="$(systemctl --user is-enabled "$unit" 2>/dev/null || true)"
    else
        active="$(systemctl is-active "$unit" 2>/dev/null || true)"
        enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    fi
    if [ -z "$active$enabled" ]; then
        printf 'unknown'
    else
        printf 'active=%s enabled=%s' "${active:-unknown}" "${enabled:-unknown}"
    fi
}

ydotool_socket_summary() {
    local uid runtime_dir candidate
    uid="$(id -u 2>/dev/null || true)"
    runtime_dir="${XDG_RUNTIME_DIR:-${uid:+/run/user/$uid}}"
    for candidate in \
        "${YDOTOOL_SOCKET:-}" \
        "${runtime_dir:+$runtime_dir/.ydotool_socket}" \
        "/tmp/.ydotool_socket"; do
        [ -n "$candidate" ] || continue
        if [ -S "$candidate" ]; then
            printf '%s' "$candidate"
            return
        fi
    done
    printf 'not found'
}

portal_summary() {
    local bus_names
    if command -v busctl >/dev/null 2>&1; then
        bus_names="$(busctl --user --list 2>/dev/null || true)"
    else
        bus_names=""
    fi

    if grep 'org.freedesktop.portal.Desktop' >/dev/null 2>&1 <<<"$bus_names"; then
        printf 'available on session bus'
    elif command -v pgrep >/dev/null 2>&1 &&
        pgrep -f '(^|[/[:space:]])xdg-desktop-portal([[:space:]]|$)' >/dev/null 2>&1; then
        printf 'running'
    else
        printf 'not detected'
    fi
}

install_command_for_packages() {
    local packages="$1"
    case "$(detect_package_manager)" in
        apt)
            printf 'sudo apt install %s' "$packages"
            ;;
        dnf5)
            printf 'sudo dnf5 install %s' "$packages"
            ;;
        dnf)
            printf 'sudo dnf install %s' "$packages"
            ;;
        pacman)
            printf 'sudo pacman -S %s' "$packages"
            ;;
        zypper)
            printf 'sudo zypper install %s' "$packages"
            ;;
        *)
            printf 'Use your distro package manager to install: %s' "$packages"
            ;;
    esac
}

computer_use_portal_packages() {
    local desktop="${XDG_CURRENT_DESKTOP:-} ${DESKTOP_SESSION:-}"
    desktop="${desktop,,}"
    if [[ "$desktop" == *kde* || "$desktop" == *plasma* ]]; then
        printf 'xdg-desktop-portal xdg-desktop-portal-kde'
    elif [[ "$desktop" == *hyprland* || "$desktop" == *sway* || "$desktop" == *wlroots* ]]; then
        printf 'xdg-desktop-portal xdg-desktop-portal-wlr'
    elif [[ "$desktop" == *gnome* ]]; then
        printf 'xdg-desktop-portal xdg-desktop-portal-gnome'
    else
        printf 'xdg-desktop-portal'
    fi
}

computer_use_ydotool_packages() {
    case "$(detect_package_manager)" in
        apt)
            printf 'ydotool ydotoold'
            ;;
        *)
            printf 'ydotool'
            ;;
    esac
}

uinput_summary() {
    local uinput_path="${CODEX_BOOTSTRAP_UINPUT_PATH:-/dev/uinput}"
    if [ ! -e "$uinput_path" ]; then
        printf 'missing'
        return
    fi

    local access="no read/write access"
    if [ -r "$uinput_path" ] && [ -w "$uinput_path" ]; then
        access="read/write access"
    elif [ -r "$uinput_path" ]; then
        access="read-only access"
    elif [ -w "$uinput_path" ]; then
        access="write-only access"
    fi

    local stat_output=""
    if command -v stat >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
        stat_output="$(timeout 1 stat -c '%A %U:%G' "$uinput_path" 2>/dev/null || true)"
    fi
    printf '%s%s' "$access" "${stat_output:+ ($stat_output)}"
}

input_group_summary() {
    if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx 'input'; then
        printf 'yes'
    else
        printf 'no'
    fi
}

window_backend_hint() {
    local desktop="${XDG_CURRENT_DESKTOP:-} ${DESKTOP_SESSION:-} ${XDG_SESSION_DESKTOP:-}"
    desktop="${desktop,,}"
    if [[ "$desktop" == *hyprland* ]]; then
        printf 'Hyprland -> hyprctl backend'
    elif [[ "$desktop" == *sway* ]]; then
        printf 'Sway -> not explicitly supported by the current i3 backend; verify with Computer Use doctor after install'
    elif [[ "$desktop" == *i3* ]]; then
        printf 'i3 -> i3 IPC backend'
    elif [[ "$desktop" == *cosmic* ]]; then
        printf 'COSMIC -> bundled COSMIC helper backend'
    elif [[ "$desktop" == *kde* || "$desktop" == *plasma* ]]; then
        printf 'KDE/Plasma -> KWin scripting backend'
    elif [[ "$desktop" == *gnome* ]]; then
        printf 'GNOME -> Shell Introspect plus optional bundled extension for exact activation'
    else
        printf 'unknown desktop -> screenshots, AT-SPI, and global ydotool may still work'
    fi
}

computer_use_doctor_path() {
    local candidate
    for candidate in \
        "$REPO_DIR/codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux" \
        "/opt/$PACKAGE_NAME/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux" \
        "$(command -v codex-computer-use-linux 2>/dev/null || true)"; do
        [ -n "$candidate" ] || continue
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return
        fi
    done
    return 1
}

settings_file_path() {
    if [ -n "${CODEX_LINUX_SETTINGS_FILE:-}" ]; then
        printf '%s\n' "$CODEX_LINUX_SETTINGS_FILE"
    else
        local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
        local app_id
        app_id="$(linux_app_id)"
        printf '%s\n' "$config_home/$app_id/settings.json"
    fi
}

linux_app_id() {
    local app_id="${CODEX_LINUX_APP_ID:-${CODEX_APP_ID:-${PACKAGE_NAME:-codex-desktop}}}"
    case "$app_id" in
        */*|*[!A-Za-z0-9._-]*|"."|".."|"")
            app_id="codex-desktop"
            ;;
    esac
    printf '%s\n' "$app_id"
}

remote_mobile_key_file_path() {
    local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
    printf '%s/%s/remote-control-device-keys-v1.json\n' "$config_home" "$(linux_app_id)"
}

remote_mobile_legacy_key_file_path() {
    local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
    printf '%s/codex-desktop/remote-control-device-keys-v1.json\n' "$config_home"
}

json_setting_value() {
    local key="$1"
    local settings_path
    settings_path="$(settings_file_path)"
    [ -r "$settings_path" ] || return 1
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$settings_path" "$key" <<'PY' 2>/dev/null || true
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)
value = data.get(sys.argv[2])
if isinstance(value, str) and value.strip():
    print(value)
PY
}

read_aloud_python_path() {
    local value="${CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON:-}"
    if [ -z "$value" ]; then
        value="$(json_setting_value "codex-linux-read-aloud-kokoro-python")"
    fi
    if [ -z "$value" ]; then
        value="${XDG_DATA_HOME:-$HOME/.local/share}/codex-desktop/read-aloud/kokoro-venv/bin/python"
    fi
    printf '%s\n' "$value"
}

read_aloud_model_path() {
    local value="${CODEX_LINUX_READ_ALOUD_KOKORO_MODEL:-}"
    if [ -z "$value" ]; then
        value="$(json_setting_value "codex-linux-read-aloud-kokoro-model")"
    fi
    if [ -z "$value" ]; then
        value="${XDG_DATA_HOME:-$HOME/.local/share}/kokoro/kokoro-v1.0.onnx"
    fi
    printf '%s\n' "$value"
}

read_aloud_voices_path() {
    local value="${CODEX_LINUX_READ_ALOUD_KOKORO_VOICES:-}"
    if [ -z "$value" ]; then
        value="$(json_setting_value "codex-linux-read-aloud-kokoro-voices")"
    fi
    if [ -z "$value" ]; then
        value="${XDG_DATA_HOME:-$HOME/.local/share}/kokoro/voices-v1.0.bin"
    fi
    printf '%s\n' "$value"
}

path_summary() {
    local path="$1"
    if [ -d "$path" ]; then
        printf 'directory'
    elif [ -x "$path" ]; then
        printf 'executable'
    elif [ -f "$path" ]; then
        printf 'file'
    elif [ -e "$path" ]; then
        printf 'exists'
    else
        printf 'missing'
    fi
}

read_aloud_doctor_path() {
    local candidate
    for candidate in \
        "$REPO_DIR/codex-app/resources/plugins/openai-bundled/plugins/read-aloud/bin/codex-read-aloud-linux" \
        "/opt/$PACKAGE_NAME/resources/plugins/openai-bundled/plugins/read-aloud/bin/codex-read-aloud-linux" \
        "$(command -v codex-read-aloud-linux 2>/dev/null || true)"; do
        [ -n "$candidate" ] || continue
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return
        fi
    done
    return 1
}

print_read_aloud_details() {
    local python_path model_path voices_path doctor plugin_cache settings_path
    python_path="$(read_aloud_python_path)"
    model_path="$(read_aloud_model_path)"
    voices_path="$(read_aloud_voices_path)"
    doctor="$(read_aloud_doctor_path 2>/dev/null || true)"
    plugin_cache="$HOME/.codex/plugins/cache/openai-bundled/read-aloud"
    settings_path="$(settings_file_path)"

    info "Read Aloud readiness:"
    info "  Settings file: $settings_path ($(path_summary "$settings_path"))"
    info "  Kokoro python: $python_path ($(path_summary "$python_path"))"
    info "  Kokoro model: $model_path ($(path_summary "$model_path"))"
    info "  Kokoro voices: $voices_path ($(path_summary "$voices_path"))"
    info "  Read Aloud plugin cache: $plugin_cache ($(path_summary "$plugin_cache"))"
    if [ -n "$doctor" ]; then
        info "  Read Aloud doctor command: $doctor doctor"
    else
        info "  Read Aloud doctor command: enable read-aloud-mcp and rebuild/install, then run codex-read-aloud-linux doctor from the staged plugin."
    fi
    info "  Setup hint: use the Read Aloud settings download flow or linux-features/read-aloud/install-kokoro-runtime.sh; custom paths stay in settings/env."
}

print_computer_use_details() {
    local doctor=""
    doctor="$(computer_use_doctor_path 2>/dev/null || true)"

    info "Computer Use details:"
    info "  uinput=$(uinput_summary)"
    info "  current user in input group=$(input_group_summary)"
    info "  Window backend hint: $(window_backend_hint)"
    info "  Suggested ydotool command: $(install_command_for_packages "$(computer_use_ydotool_packages)")"
    info "  Suggested portal package: $(install_command_for_packages "$(computer_use_portal_packages)")"
    info "  Suggested ydotool service command: sudo systemctl enable --now ydotoold.service"
    info "  If your distro ships ydotool.service instead, use sudo systemctl enable --now ydotool.service."
    info "  Do not stop or disable ydotoold from this wizard; other apps may use it."
    if [ -n "$doctor" ]; then
        info "  Computer Use doctor command: $doctor doctor"
    else
        info "  Computer Use doctor command: build/install first, then run codex-computer-use-linux doctor from the staged plugin."
    fi
}

installed_package_version() {
    if command -v dpkg-query >/dev/null 2>&1 &&
        dpkg-query -W -f='${Version}' "$PACKAGE_NAME" >/dev/null 2>&1; then
        dpkg-query -W -f='deb ${Version}' "$PACKAGE_NAME" 2>/dev/null || true
        return
    fi
    if command -v rpm >/dev/null 2>&1 &&
        rpm -q --qf 'rpm %{VERSION}-%{RELEASE}' "$PACKAGE_NAME" >/dev/null 2>&1; then
        rpm -q --qf 'rpm %{VERSION}-%{RELEASE}' "$PACKAGE_NAME" 2>/dev/null || true
        return
    fi
    if command -v pacman >/dev/null 2>&1 &&
        pacman -Q "$PACKAGE_NAME" >/dev/null 2>&1; then
        pacman -Q "$PACKAGE_NAME" 2>/dev/null | sed 's/^/pacman /'
        return
    fi
    printf 'not installed'
}

updater_install_summary() {
    if [ -x /usr/bin/codex-update-manager ] || [ -d "/opt/$PACKAGE_NAME/update-builder" ]; then
        printf 'updater artifacts detected'
    else
        printf 'not detected'
    fi
}

print_system_summary() {
    OS_RELEASE_ID="$(os_release_field ID 2>/dev/null || true)"
    OS_RELEASE_ID_LIKE="$(os_release_field ID_LIKE 2>/dev/null || true)"
    OS_RELEASE_VERSION_ID="$(os_release_field VERSION_ID 2>/dev/null || true)"

    info "Codex Desktop Linux guided setup"
    info "Repository: $REPO_DIR"
    info "Distro: ID=${OS_RELEASE_ID:-unknown} ID_LIKE=${OS_RELEASE_ID_LIKE:-unknown} VERSION_ID=${OS_RELEASE_VERSION_ID:-unknown}"
    info "Package manager: $(detect_package_manager)"
    info "Native package format: $(detect_package_format)"
    info "Session: XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-unknown} DESKTOP_SESSION=${DESKTOP_SESSION:-unknown} XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-unknown} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-none} DISPLAY=${DISPLAY:-none}"
    info "Helpers: pkexec=$(command_status pkexec) kdialog=$(command_status kdialog) zenity=$(command_status zenity)"
    info "Computer Use readiness: ydotool=$(command_status ydotool) ydotoold=$(command_status ydotoold) ydotoold.service(system)=[$(service_state ydotoold.service system)] ydotoold.service(user)=[$(service_state ydotoold.service user)] ydotool.service(system)=[$(service_state ydotool.service system)] ydotool.service(user)=[$(service_state ydotool.service user)] socket=$(ydotool_socket_summary) portal=$(portal_summary)"
    info "Installed package: $(installed_package_version)"
    info "Installed updater mode: $(updater_install_summary)"
}

run_feature_config_python() {
    local enable_raw="$1"
    local disable_raw="$2"
    local apply_changes="$3"
    local config_path
    config_path="$(feature_config_path)"

    if ! command -v python3 >/dev/null 2>&1; then
        if [ -n "$enable_raw$disable_raw" ]; then
            error "python3 is required to edit Linux feature config. Run bash scripts/install-deps.sh first."
        fi
        warn "python3 is missing; skipping Linux feature discovery and config editing"
        return
    fi

    python3 - "$FEATURES_ROOT" "$config_path" "$enable_raw" "$disable_raw" "$apply_changes" <<'PY'
import json
import pathlib
import re
import sys

features_root = pathlib.Path(sys.argv[1])
config_path = pathlib.Path(sys.argv[2])
enable_raw = sys.argv[3]
disable_raw = sys.argv[4]
apply_changes = sys.argv[5] == "1"

id_re = re.compile(r"^[a-z0-9][a-z0-9-]*$")

def die(message):
    print(f"[setup][ERROR] {message}", file=sys.stderr)
    sys.exit(1)

def warn(message):
    print(f"[setup][WARN] {message}", file=sys.stderr)

def split_ids(raw):
    if not raw.strip():
        return []
    ids = [item for item in re.split(r"[,\s]+", raw.strip()) if item]
    seen = set()
    result = []
    for item in ids:
        if not id_re.match(item):
            die(f"Invalid Linux feature id: {item}")
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result

def read_json(path, label):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except Exception as exc:
        die(f"Could not read {label} at {path}: {exc}")

def discover_features(root):
    features = {}
    if not root.exists():
        warn(f"Linux features root not found: {root}")
        return features
    for manifest_path in sorted(root.glob("*/feature.json")):
        data = read_json(manifest_path, f"Linux feature manifest {manifest_path}") or {}
        feature_id = data.get("id")
        if not isinstance(feature_id, str) or not id_re.match(feature_id):
            warn(f"Skipping feature with invalid id in {manifest_path}")
            continue
        if feature_id in features:
            warn(f"Skipping duplicate Linux feature id: {feature_id}")
            continue
        title = data.get("title") or data.get("name") or feature_id
        description = data.get("description") or ""
        features[feature_id] = {
            "id": feature_id,
            "title": str(title),
            "description": str(description),
        }
    return dict(sorted(features.items()))

def read_enabled_ids(path):
    if not path.exists():
        fallback = features_root / "features.example.json"
        if fallback.exists():
            data = read_json(fallback, "Linux features example config") or {}
        else:
            return []
    else:
        data = read_json(path, "Linux features config") or {}
    enabled = data.get("enabled", [])
    if not isinstance(enabled, list):
        die(f"Linux features config {path} must contain an enabled array")
    result = []
    seen = set()
    for item in enabled:
        if not isinstance(item, str) or not id_re.match(item):
            die(f"Invalid Linux feature id in {path}: {item}")
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result

def csv(ids):
    return ", ".join(ids) if ids else "none"

features = discover_features(features_root)
current = read_enabled_ids(config_path)
enable = split_ids(enable_raw)
disable = split_ids(disable_raw)
conflicting = sorted(set(enable) & set(disable))
if conflicting:
    die(f"Linux feature ids cannot be both enabled and disabled: {csv(conflicting)}")

for feature_id in enable:
    if feature_id not in features:
        die(f"Unknown Linux feature id: {feature_id}")
for feature_id in disable:
    if feature_id not in features and feature_id not in current:
        die(f"Unknown Linux feature id: {feature_id}")

final = [feature_id for feature_id in current if feature_id not in set(disable)]
for feature_id in enable:
    if feature_id not in final:
        final.append(feature_id)

if apply_changes and (enable or disable):
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"enabled": final}, indent=2) + "\n")
    print(f"[setup] Updated Linux feature config: {config_path}")
elif not config_path.exists():
    print(f"[setup] Linux feature config: {config_path} (not created yet)")
else:
    print(f"[setup] Linux feature config: {config_path}")

print(f"[setup] Enabled Linux features: {csv(final)}")

unknown_enabled = [feature_id for feature_id in final if feature_id not in features]
if unknown_enabled:
    warn(f"Enabled feature ids not found in this checkout: {csv(unknown_enabled)}")

if "conversation-mode" in final and "read-aloud" not in final:
    warn("conversation-mode is enabled without read-aloud; speech output requires the Read Aloud feature.")

if features:
    print("[setup] Available Linux features:")
    for feature_id, feature in features.items():
        state = "enabled" if feature_id in final else "available"
        sample = " (developer sample)" if feature_id == "example-feature" else ""
        print(f"[setup]   [{state}] {feature_id}{sample} - {feature['title']}")
else:
    print("[setup] Available Linux features: none found")

if apply_changes and (enable or disable):
    print("[setup] Feature changes apply after rebuilding and reinstalling Codex Desktop Linux.")
PY
}

list_includes_id() {
    local raw="$1"
    local needle="$2"
    local item
    raw="${raw//,/ }"
    for item in $raw; do
        [ "$item" = "$needle" ] && return 0
    done
    return 1
}

print_safe_disable_guidance() {
    local disable_raw="$1"
    [ -n "$disable_raw" ] || return 0

    info "Disabling a build-time feature only edits linux-features/features.json for the next rebuild."

    if list_includes_id "$disable_raw" "remote-mobile-control"; then
        local key_file
        key_file="$(remote_mobile_key_file_path)"
        info "Remote mobile control opt-out: Not deleting $key_file."
        if [ "$(linux_app_id)" != "codex-desktop" ]; then
            info "Legacy default-app metadata may also exist at $(remote_mobile_legacy_key_file_path)."
        fi
        info "If Secret Service is available, that file may contain only key metadata while private keys live in the desktop keyring."
        info "Revoke paired devices from Codex Settings/Connections or ChatGPT before deleting local keys manually."
    fi

    if list_includes_id "$disable_raw" "read-aloud" ||
        list_includes_id "$disable_raw" "read-aloud-mcp" ||
        list_includes_id "$disable_raw" "conversation-mode"; then
        local data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
        local read_aloud_data="$data_home/codex-desktop/read-aloud"
        local read_aloud_model
        local read_aloud_voices
        local read_aloud_cache="$HOME/.codex/plugins/cache/openai-bundled/read-aloud"
        read_aloud_model="$(read_aloud_model_path)"
        read_aloud_voices="$(read_aloud_voices_path)"
        info "Read Aloud opt-out: Not removing Read Aloud model files, Python runtimes, or plugin caches."
        info "Cleanup is separate and should list exact paths first, such as:"
        info "  $read_aloud_data"
        info "  $read_aloud_model"
        info "  $read_aloud_voices"
        info "  $read_aloud_cache"
    fi
}

validate_cleanup_feature_ids() {
    local raw="$1"
    local item
    raw="${raw//,/ }"
    for item in $raw; do
        case "$item" in
            remote-mobile-control|read-aloud|read-aloud-mcp|conversation-mode)
                ;;
            "")
                ;;
            *)
                error "Unsupported cleanup feature id: $item"
                ;;
        esac
    done
}

cleanup_path_is_safe() {
    local path="$1"
    local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
    local data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
    case "$path" in
        ""|"/"|"$HOME"|"$HOME/"|"$config_home"|"$config_home/"|"$data_home"|"$data_home/"|"$HOME/.codex"|"$HOME/.codex/")
            return 1
            ;;
    esac
    case "$path" in
        "$config_home"/codex-desktop/*|"$data_home"/codex-desktop/read-aloud|"$data_home"/codex-desktop/read-aloud/*|"$data_home"/kokoro/kokoro-v1.0.onnx|"$data_home"/kokoro/voices-v1.0.bin|"$HOME"/.codex/plugins/cache/openai-bundled/read-aloud|"$HOME"/.codex/plugins/cache/openai-bundled/read-aloud/*)
            return 0
            ;;
    esac
    return 1
}

confirm_and_delete_path() {
    local path="$1"
    if [ ! -e "$path" ]; then
        info "Cleanup path missing, nothing to delete: $path"
        return
    fi
    if ! cleanup_path_is_safe "$path"; then
        warn "Refusing cleanup path outside the known feature-owned locations: $path"
        return
    fi

    if dry_run_enabled; then
        info "Would delete: $path"
        return
    fi

    local answer
    prompt_read answer "[setup] Type DELETE $path to delete, or press Enter to skip: " || true
    if [ "$answer" = "DELETE $path" ]; then
        rm -rf -- "$path"
        info "Deleted $path"
    else
        info "Skipped $path"
    fi
}

run_feature_cleanup() {
    local cleanup_raw="${CODEX_BOOTSTRAP_CLEANUP_FEATURES:-}"
    if [ -z "$cleanup_raw" ]; then
        if noninteractive_mode; then
            return
        fi
        local wants_cleanup=""
        prompt_read wants_cleanup "[setup] Clean up feature-owned local data now? [y/N]: " || true
        case "$wants_cleanup" in
            y|Y|yes|Yes|YES)
                prompt_read cleanup_raw "[setup] Cleanup feature ids (comma-separated): " || true
                ;;
            *)
                return
                ;;
        esac
    fi

    [ -n "$cleanup_raw" ] || return
    validate_cleanup_feature_ids "$cleanup_raw"

    if noninteractive_mode && ! dry_run_enabled; then
        error "Cleanup requires an interactive terminal and exact path confirmation."
    fi

    info "Feature cleanup is separate from disabling features for the next rebuild."
    if dry_run_enabled; then
        info "Dry-run cleanup: matching paths will be printed and not deleted."
    else
        info "Only paths confirmed with the exact DELETE line will be removed."
    fi

    if list_includes_id "$cleanup_raw" "remote-mobile-control"; then
        local key_file legacy_key_file
        key_file="$(remote_mobile_key_file_path)"
        legacy_key_file="$(remote_mobile_legacy_key_file_path)"
        info "Remote mobile control cleanup: revoke paired devices in Codex Settings/Connections or ChatGPT before deleting local key metadata or fallback keys."
        info "Secret Service-backed keys are cleared by the app when the paired device is revoked; manual metadata deletion alone may leave orphaned keyring entries."
        confirm_and_delete_path "$key_file"
        if [ "$legacy_key_file" != "$key_file" ] && [ -e "$legacy_key_file" ]; then
            confirm_and_delete_path "$legacy_key_file"
        fi
    fi

    if list_includes_id "$cleanup_raw" "read-aloud" ||
        list_includes_id "$cleanup_raw" "read-aloud-mcp" ||
        list_includes_id "$cleanup_raw" "conversation-mode"; then
        local data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
        local read_aloud_data="$data_home/codex-desktop/read-aloud"
        local read_aloud_model
        local read_aloud_voices
        local read_aloud_cache="$HOME/.codex/plugins/cache/openai-bundled/read-aloud"
        read_aloud_model="$(read_aloud_model_path)"
        read_aloud_voices="$(read_aloud_voices_path)"
        info "Read Aloud cleanup: model files, Python runtimes, and plugin caches are not removed unless their exact paths are confirmed."
        confirm_and_delete_path "$read_aloud_model"
        confirm_and_delete_path "$read_aloud_voices"
        confirm_and_delete_path "$read_aloud_data"
        confirm_and_delete_path "$read_aloud_cache"
    fi
}

print_package_mode_guidance() {
    if package_with_updater_enabled; then
        info "Default native package mode includes codex-update-manager."
        info "Next rebuild/reinstall command: make install-native"
    else
        info "Manual-update native package mode selected (PACKAGE_WITH_UPDATER=0)."
        info "No-updater mode takes effect only after rebuilding and reinstalling the native package."
        info "Next rebuild/reinstall command: PACKAGE_WITH_UPDATER=0 make install-native"
    fi
    info "AppImage builds never include codex-update-manager. Nix feature choices stay declarative in flake outputs, not linux-features/features.json."
}

run_repo_command() {
    local display="$1"
    shift
    if dry_run_enabled; then
        info "Would run: $display"
    else
        info "Running: $display"
        (cd "$REPO_DIR" && "$@")
    fi
}

run_install_deps_step() {
    run_repo_command "bash scripts/install-deps.sh" bash "$REPO_DIR/scripts/install-deps.sh"
}

run_install_native_step() {
    if package_with_updater_enabled; then
        if dry_run_enabled; then
            info 'Would run: PATH="$HOME/.cargo/bin:$PATH" make install-native'
        else
            info 'Running: PATH="$HOME/.cargo/bin:$PATH" make install-native'
            (cd "$REPO_DIR" && PATH="$HOME/.cargo/bin:$PATH" make install-native)
        fi
    else
        if dry_run_enabled; then
            info 'Would run: PATH="$HOME/.cargo/bin:$PATH" PACKAGE_WITH_UPDATER=0 make install-native'
        else
            info 'Running: PATH="$HOME/.cargo/bin:$PATH" PACKAGE_WITH_UPDATER=0 make install-native'
            (cd "$REPO_DIR" && PATH="$HOME/.cargo/bin:$PATH" PACKAGE_WITH_UPDATER=0 make install-native)
        fi
    fi
}

maybe_run_install_steps() {
    local ran_or_planned=0
    local run_deps=0
    local run_install=0

    if env_flag_enabled CODEX_BOOTSTRAP_INSTALL_DEPS; then
        run_deps=1
    fi
    if env_flag_enabled CODEX_BOOTSTRAP_INSTALL_NATIVE; then
        run_install=1
    fi

    if ! noninteractive_mode; then
        local answer
        if [ -z "${CODEX_BOOTSTRAP_INSTALL_DEPS+x}" ]; then
            prompt_read answer "[setup] Run host dependency bootstrap now (bash scripts/install-deps.sh)? [y/N]: " || true
            case "$answer" in
                y|Y|yes|Yes|YES)
                    run_deps=1
                    ;;
            esac
        fi
        if [ -z "${CODEX_BOOTSTRAP_INSTALL_NATIVE+x}" ]; then
            prompt_read answer "[setup] Run native build/package/install now? [y/N]: " || true
            case "$answer" in
                y|Y|yes|Yes|YES)
                    run_install=1
                    ;;
            esac
        fi
    fi

    if [ "$run_deps" = "1" ]; then
        run_install_deps_step
        ran_or_planned=1
    fi
    if [ "$run_install" = "1" ]; then
        run_install_native_step
        ran_or_planned=1
    fi

    if [ "$ran_or_planned" = "1" ] && dry_run_enabled; then
        info "Dry-run mode: no dependency install or native package install command was executed."
    fi
}

prompt_for_feature_changes() {
    local enable_raw="${CODEX_LINUX_FEATURES:-}"
    local disable_raw="${CODEX_LINUX_DISABLE_FEATURES:-}"

    if truthy "${CODEX_BOOTSTRAP_NONINTERACTIVE:-0}" || ! [ -t 0 ]; then
        run_feature_config_python "$enable_raw" "$disable_raw" "1"
        print_safe_disable_guidance "$disable_raw"
        return
    fi

    run_feature_config_python "" "" "0"
    echo
    prompt_read enable_raw "[setup] Enable feature ids for the next build (comma-separated, blank keeps current): " || true
    prompt_read disable_raw "[setup] Disable feature ids for the next build (comma-separated, blank disables none): " || true
    if [ -n "$enable_raw$disable_raw" ]; then
        run_feature_config_python "$enable_raw" "$disable_raw" "1"
        print_safe_disable_guidance "$disable_raw"
    else
        info "Feature config unchanged."
    fi

    local answer
    if package_with_updater_enabled; then
        prompt_read answer "[setup] Keep codex-update-manager in the next native package? [Y/n]: " || true
        case "$answer" in
            n|N|no|No|NO)
                PACKAGE_WITH_UPDATER=0
                ;;
        esac
    else
        prompt_read answer "[setup] Keep manual-update package mode for the next native build? [Y/n]: " || true
        case "$answer" in
            n|N|no|No|NO)
                PACKAGE_WITH_UPDATER=1
                ;;
        esac
    fi
}

main() {
    print_system_summary
    prompt_for_feature_changes
    print_computer_use_details
    print_read_aloud_details
    run_feature_cleanup
    print_package_mode_guidance
    maybe_run_install_steps
    if dry_run_enabled; then
        info "Dry-run completed."
    else
        info "Feature cleanup did not change services, groups, key files, model files, or plugin caches unless explicitly confirmed above."
    fi
    info "If Computer Use needs ydotoold, input group membership, a portal backend, or logout/login, run those steps explicitly after reviewing the commands."
}

main "$@"
