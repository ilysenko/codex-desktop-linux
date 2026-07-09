#!/usr/bin/env bash
# Guided, conservative setup helper for native Codex Desktop Linux builds.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FEATURES_ROOT="${CODEX_LINUX_FEATURES_ROOT:-$REPO_DIR/linux-features}"
PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/linux-target-detect.sh"
SETUP_ERROR_REPORTED=0
COLOR_RESET=""
COLOR_BOLD=""
COLOR_DIM=""
COLOR_RED=""
COLOR_YELLOW=""
COLOR_CYAN=""
COLOR_GREEN=""

info() {
    echo "${COLOR_DIM}[setup]${COLOR_RESET} $*"
}

warn() {
    echo "${COLOR_YELLOW}[setup][WARN]${COLOR_RESET} $*" >&2
}

error() {
    SETUP_ERROR_REPORTED=1
    echo "${COLOR_RED}[setup][ERROR]${COLOR_RESET} $*" >&2
    exit 1
}

section() {
    echo
    echo "${COLOR_CYAN}${COLOR_BOLD}[setup] == $* ==${COLOR_RESET}"
}

unexpected_error() {
    local status=$?
    [ "$status" = "0" ] && return 0
    [ "${SETUP_ERROR_REPORTED:-0}" = "1" ] && return "$status"
    echo "${COLOR_RED}[setup][ERROR]${COLOR_RESET} setup-native stopped unexpectedly near line ${BASH_LINENO[0]:-unknown} (exit $status)." >&2
    echo "${COLOR_RED}[setup][ERROR]${COLOR_RESET} Review the last [setup] lines above. You can rerun with CODEX_BOOTSTRAP_DRY_RUN=1 for a read-only preview." >&2
    return "$status"
}

trap unexpected_error ERR

usage() {
    cat <<'EOF'
Usage: scripts/bootstrap-wizard.sh [--help]

Environment:
  CODEX_BOOTSTRAP_NONINTERACTIVE=1     never prompt
  CODEX_BOOTSTRAP_DRY_RUN=1            preview install/cleanup actions without changing them
  CODEX_BOOTSTRAP_INSTALL_DEPS=1       run bash scripts/install-deps.sh after checks
  CODEX_BOOTSTRAP_INSTALL_NATIVE=1     run make install-native after checks
  CODEX_BOOTSTRAP_CLEANUP_FEATURES=a,b cleanup feature-owned data with confirmation
  CODEX_BOOTSTRAP_COLOR=auto|1|0       enable ANSI color automatically, force it, or disable it
  CODEX_LINUX_FEATURES=a,b             enable build-time Linux features
  CODEX_LINUX_DISABLE_FEATURES=a,b     disable build-time Linux features
  CODEX_LINUX_FEATURES_ROOT=/path      override linux-features root
  CODEX_LINUX_FEATURES_CONFIG=/path    override features.json path
  linux-features/local/<id>/           user-local feature dirs are discovered and marked [local]
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

init_colors() {
    case "${CODEX_BOOTSTRAP_COLOR:-auto}" in
        1|true|True|TRUE|yes|Yes|YES|on|On|ON|always)
            ;;
        0|false|False|FALSE|no|No|NO|off|Off|OFF|never)
            return 0
            ;;
        auto|"")
            [ -z "${NO_COLOR:-}" ] || return 0
            [ -t 1 ] || return 0
            [ "${TERM:-}" != "dumb" ] || return 0
            ;;
        *)
            error "CODEX_BOOTSTRAP_COLOR must be auto, 1, or 0"
            ;;
    esac

    COLOR_RESET=$'\033[0m'
    COLOR_BOLD=$'\033[1m'
    COLOR_DIM=$'\033[2m'
    COLOR_RED=$'\033[31m'
    COLOR_YELLOW=$'\033[33m'
    COLOR_CYAN=$'\033[36m'
    COLOR_GREEN=$'\033[32m'
}

init_colors

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
        rpm-ostree)
            printf 'sudo rpm-ostree install %s' "$packages"
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
        local app_id="${CODEX_LINUX_APP_ID:-${CODEX_APP_ID:-codex-desktop}}"
        case "$app_id" in
            */*|*[!A-Za-z0-9._-]*|"."|".."|"")
                app_id="codex-desktop"
                ;;
        esac
        printf '%s\n' "$config_home/$app_id/settings.json"
    fi
}

json_setting_value() {
    local key="$1"
    local settings_path
    settings_path="$(settings_file_path)"
    [ -r "$settings_path" ] || return 0
    command -v python3 >/dev/null 2>&1 || return 0
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
    local atomic_host="no"
    if linux_target_is_atomic; then
        atomic_host="yes"
    fi

    info "Codex Desktop Linux guided setup"
    info "Repository: $REPO_DIR"
    info "Distro: ID=${OS_RELEASE_ID:-unknown} ID_LIKE=${OS_RELEASE_ID_LIKE:-unknown} VERSION_ID=${OS_RELEASE_VERSION_ID:-unknown}"
    info "Package manager: $(detect_package_manager)"
    info "Native package format: $(detect_package_format)"
    info "Atomic host: $atomic_host"
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
    local output_mode="${4:-}"
    local config_path
    config_path="$(feature_config_path)"

    if ! command -v python3 >/dev/null 2>&1; then
        if [ -n "$enable_raw$disable_raw" ]; then
            error "python3 is required to edit Linux feature config. Run bash scripts/install-deps.sh first."
        fi
        warn "python3 is missing; skipping Linux feature discovery and config editing"
        return
    fi

    if ! python3 - "$FEATURES_ROOT" "$config_path" "$enable_raw" "$disable_raw" "$apply_changes" "$output_mode" <<'PY'
import json
import pathlib
import re
import sys

features_root = pathlib.Path(sys.argv[1])
config_path = pathlib.Path(sys.argv[2])
enable_raw = sys.argv[3]
disable_raw = sys.argv[4]
apply_changes = sys.argv[5] == "1"
output_mode = sys.argv[6] if len(sys.argv) > 6 else ""

id_re = re.compile(r"^[a-z0-9][a-z0-9-]*$")

def die(message):
    print(f"[setup][ERROR] {message}", file=sys.stderr)
    sys.exit(1)

def warn(message):
    print(f"[setup][WARN] {message}", file=sys.stderr)

def split_selectors(raw, features, label):
    if not raw.strip():
        return []
    items = [item for item in re.split(r"[,\s]+", raw.strip()) if item]
    feature_ids = list(features)
    seen = set()
    result = []
    def add_feature_number(raw_number):
        number = int(raw_number)
        if number < 1 or number > len(feature_ids):
            maximum = len(feature_ids)
            hint = f"1-{maximum}" if maximum else "none available"
            die(f"Feature number {number} is out of range for {label} (available: {hint}). Use feature ids, numbers, or ranges like 1,3-4.")
        feature_id = feature_ids[number - 1]
        if feature_id not in seen:
            seen.add(feature_id)
            result.append(feature_id)
    for item in items:
        if re.match(r"^[0-9]+-[0-9]+$", item):
            start_raw, end_raw = item.split("-", 1)
            start = int(start_raw)
            end = int(end_raw)
            if start > end:
                die(f"Feature range {item} is invalid for {label}. Use ascending ranges like 2-4.")
            for number in range(start, end + 1):
                add_feature_number(str(number))
            continue
        if re.match(r"^[0-9]+$", item):
            add_feature_number(item)
            continue
        if not id_re.match(item):
            die(f"Invalid Linux feature selector for {label}: {item}. Use feature ids, numbers, or ranges like 1,3-4.")
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

def normalize_id_list(value, label, manifest_path):
    if value is None:
        return []
    if not isinstance(value, list):
        die(f"Linux feature manifest {manifest_path} field {label} must be an array")
    result = []
    seen = set()
    for item in value:
        if not isinstance(item, str) or not id_re.match(item):
            die(f"Linux feature manifest {manifest_path} field {label} contains invalid feature id: {item}")
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result

def feature_manifest_paths(root):
    if not root.exists():
        return []
    reserved = {"local", "README.md", "features.example.json", "features.json"}
    paths = []
    for child in sorted(root.iterdir(), key=lambda item: item.name):
        if child.name.startswith(".") or child.name in reserved or not child.is_dir():
            continue
        manifest_path = child / "feature.json"
        if manifest_path.exists():
            paths.append(("repo", manifest_path))
    local_root = root / "local"
    if local_root.is_dir():
        for child in sorted(local_root.iterdir(), key=lambda item: item.name):
            if child.name.startswith(".") or not child.is_dir():
                continue
            manifest_path = child / "feature.json"
            if manifest_path.exists():
                paths.append(("local", manifest_path))
    return paths

def discover_features(root):
    features = {}
    if not root.exists():
        warn(f"Linux features root not found: {root}")
        return features
    for origin, manifest_path in feature_manifest_paths(root):
        data = read_json(manifest_path, f"Linux feature manifest {manifest_path}") or {}
        feature_id = data.get("id")
        if not isinstance(feature_id, str) or not id_re.match(feature_id):
            warn(f"Skipping feature with invalid id in {manifest_path}")
            continue
        if not (manifest_path.parent / "README.md").is_file():
            die(f"Linux feature '{feature_id}' must include README.md next to feature.json")
        if data.get("defaultEnabled") is True:
            die(f"Linux feature '{feature_id}' must be disabled by default; defaultEnabled true is not allowed")
        if feature_id in features:
            die(f"Duplicate Linux feature id '{feature_id}' in {manifest_path} and {features[feature_id]['manifest_path']}")
        title = data.get("title") or data.get("name") or feature_id
        description = data.get("description") or ""
        features[feature_id] = {
            "id": feature_id,
            "title": str(title),
            "description": str(description),
            "origin": origin,
            "local": origin == "local",
            "requires": normalize_id_list(data.get("requires"), "requires", manifest_path),
            "conflicts": normalize_id_list(data.get("conflicts"), "conflicts", manifest_path),
            "manifest_path": str(manifest_path),
        }
    return dict(sorted(features.items()))

def read_feature_config(path):
    if not path.exists():
        fallback = features_root / "features.example.json"
        if fallback.exists():
            return read_json(fallback, "Linux features example config") or {}
        else:
            return {}
    else:
        return read_json(path, "Linux features config") or {}

def read_enabled_ids(data, path):
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
config_data = read_feature_config(config_path)
if not isinstance(config_data, dict):
    die(f"Linux features config {config_path} must be a JSON object")
current = read_enabled_ids(config_data, config_path)

if output_mode == "tsv":
    # Machine-readable discovery for the GUI feature picker: one
    # id<TAB>title<TAB>enabled_flag line per feature. No side effects.
    current_set = set(current)
    for feature_id, feature in features.items():
        title = feature["title"].replace("\t", " ").replace("\n", " ")
        flag = "1" if feature_id in current_set else "0"
        print(f"{feature_id}\t{title}\t{flag}")
    sys.exit(0)

enable = split_selectors(enable_raw, features, "enable")
disable = split_selectors(disable_raw, features, "disable")
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

final_set = set(final)
for feature_id in final:
    feature = features.get(feature_id)
    if feature is None:
        continue
    missing_required = [required for required in feature["requires"] if required not in final_set]
    if missing_required:
        die(f"Linux feature '{feature_id}' requires enabled feature(s): {csv(missing_required)}")
    conflicting_enabled = [conflict for conflict in feature["conflicts"] if conflict in final_set]
    if conflicting_enabled:
        die(f"Linux feature '{feature_id}' conflicts with enabled feature(s): {csv(conflicting_enabled)}")

if apply_changes and (enable or disable):
    config_path.parent.mkdir(parents=True, exist_ok=True)
    updated_config = dict(config_data)
    updated_config["enabled"] = final
    config_path.write_text(json.dumps(updated_config, indent=2) + "\n")
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
    for index, (feature_id, feature) in enumerate(features.items(), start=1):
        state = "enabled" if feature_id in final else "available"
        sample = " (developer sample)" if feature_id == "example-feature" else ""
        local = " [local]" if feature.get("local") else ""
        print(f"[setup]   {index}. [{state}] {feature_id}{local}{sample} - {feature['title']}")
else:
    print("[setup] Available Linux features: none found")

if apply_changes and (enable or disable):
    print("[setup] Feature changes apply after rebuilding and reinstalling Codex Desktop Linux.")
PY
    then
        SETUP_ERROR_REPORTED=1
        echo "${COLOR_RED}[setup][ERROR]${COLOR_RESET} Could not update Linux feature config; review the message above." >&2
        return 1
    fi
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
        local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
        local key_file="$config_home/codex-desktop/remote-control-device-keys-v1.json"
        info "Remote mobile control opt-out: Not deleting $key_file."
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
        section "Cleanup"
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
    else
        section "Cleanup"
    fi

    if [ -z "$cleanup_raw" ]; then
        info "No cleanup feature ids provided; skipping feature cleanup."
        return 0
    fi
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
        local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
        local key_file="$config_home/codex-desktop/remote-control-device-keys-v1.json"
        info "Remote mobile control cleanup: revoke paired devices in Codex Settings/Connections or ChatGPT before deleting local keys."
        confirm_and_delete_path "$key_file"
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

# True when an interactive GUI checklist can be shown: a graphical session,
# a dialog helper (zenity/kdialog), python3 for feature discovery, and the user
# has not opted out via CODEX_BOOTSTRAP_NO_GUI.
gui_feature_picker_available() {
    truthy "${CODEX_BOOTSTRAP_NO_GUI:-0}" && return 1
    [ -t 0 ] || return 1
    [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || return 1
    command -v python3 >/dev/null 2>&1 || return 1
    command -v zenity >/dev/null 2>&1 || command -v kdialog >/dev/null 2>&1
}

# Shows a zenity/kdialog checklist of discovered features (pre-checked = current),
# then applies the selection through the existing Python config writer. Returns
# non-zero when the GUI path could not run so the caller falls back to the
# terminal prompt. A cancelled dialog leaves the config unchanged and returns 0.
prompt_for_feature_changes_gui() {
    local feature_lines
    feature_lines="$(run_feature_config_python "" "" "0" "tsv")" || return 1
    [ -n "$feature_lines" ] || return 1

    local -a all_ids=()
    declare -A enabled_now=()
    declare -A title_of=()
    local id title flag
    while IFS=$'\t' read -r id title flag; do
        [ -n "$id" ] || continue
        all_ids+=("$id")
        title_of["$id"]="$title"
        [ "$flag" = "1" ] && enabled_now["$id"]=1
    done <<< "$feature_lines"

    [ "${#all_ids[@]}" -gt 0 ] || return 1

    local selected="" status=0
    if command -v zenity >/dev/null 2>&1; then
        # Columns: [Enable checkbox] [feature id] [title]. Print the id column
        # (2) one per line. `--separate-output` was removed in zenity 4.x, so we
        # pin the row separator with `--separator` instead for both 3.x and 4.x.
        local -a rows=()
        for id in "${all_ids[@]}"; do
            if [ -n "${enabled_now[$id]:-}" ]; then rows+=("TRUE"); else rows+=("FALSE"); fi
            rows+=("$id" "${title_of[$id]}")
        done
        selected="$(zenity --list --checklist \
            --title="Codex Desktop Linux features" \
            --text="Select the optional Linux features to enable for the next build." \
            --column="Enable" --column="Feature" --column="Description" \
            --print-column=2 --separator=$'\n' \
            "${rows[@]}" 2>/dev/null)" || status=$?
    else
        local -a rows=()
        for id in "${all_ids[@]}"; do
            if [ -n "${enabled_now[$id]:-}" ]; then
                rows+=("$id" "${title_of[$id]}" "on")
            else
                rows+=("$id" "${title_of[$id]}" "off")
            fi
        done
        selected="$(kdialog --separate-output --checklist \
            "Select the optional Linux features to enable for the next build." \
            "${rows[@]}" 2>/dev/null)" || status=$?
    fi

    if [ "$status" -ne 0 ]; then
        info "Feature selection cancelled; config unchanged."
        return 0
    fi

    declare -A selected_set=()
    while IFS= read -r id; do
        id="${id//\"/}"
        [ -n "$id" ] && selected_set["$id"]=1
    done <<< "$selected"

    local -a enable_ids=() disable_ids=()
    for id in "${all_ids[@]}"; do
        if [ -n "${selected_set[$id]:-}" ]; then
            [ -z "${enabled_now[$id]:-}" ] && enable_ids+=("$id")
        else
            [ -n "${enabled_now[$id]:-}" ] && disable_ids+=("$id")
        fi
    done

    if [ "${#enable_ids[@]}" -eq 0 ] && [ "${#disable_ids[@]}" -eq 0 ]; then
        info "Feature config unchanged."
        return 0
    fi

    local enable_csv disable_csv
    enable_csv="$(IFS=,; echo "${enable_ids[*]}")"
    disable_csv="$(IFS=,; echo "${disable_ids[*]}")"
    run_feature_config_python "$enable_csv" "$disable_csv" "1"
    print_safe_disable_guidance "$disable_csv"
    return 0
}

prompt_for_feature_changes() {
    local enable_raw="${CODEX_LINUX_FEATURES:-}"
    local disable_raw="${CODEX_LINUX_DISABLE_FEATURES:-}"

    if truthy "${CODEX_BOOTSTRAP_NONINTERACTIVE:-0}" || ! [ -t 0 ]; then
        run_feature_config_python "$enable_raw" "$disable_raw" "1"
        print_safe_disable_guidance "$disable_raw"
        return
    fi

    # Prefer a graphical checklist when the environment supports it; the explicit
    # CODEX_LINUX_FEATURES / CODEX_LINUX_DISABLE_FEATURES env selectors and the
    # terminal prompt remain the fallback for headless or no-GUI sessions.
    if [ -z "$enable_raw$disable_raw" ] && gui_feature_picker_available; then
        if prompt_for_feature_changes_gui; then
            prompt_package_updater_mode
            return
        fi
    fi

    run_feature_config_python "" "" "0"
    echo
    prompt_read enable_raw "[setup] Enable feature ids or numbers for the next build (comma-separated, blank keeps current): " || true
    prompt_read disable_raw "[setup] Disable feature ids or numbers for the next build (comma-separated, blank disables none): " || true
    if [ -n "$enable_raw$disable_raw" ]; then
        run_feature_config_python "$enable_raw" "$disable_raw" "1"
        print_safe_disable_guidance "$disable_raw"
    else
        info "Feature config unchanged."
    fi

    prompt_package_updater_mode
}

prompt_package_updater_mode() {
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
    section "System"
    print_system_summary
    section "Linux Features"
    prompt_for_feature_changes
    section "Readiness"
    print_computer_use_details
    print_read_aloud_details
    run_feature_cleanup
    section "Next Steps"
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
