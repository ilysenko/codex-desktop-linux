#!/bin/bash
# install-deps.sh — Install system dependencies for ChatGPT Desktop for Linux
# Supports: Debian/Ubuntu (apt), Fedora 41+ (dnf5), Fedora <41 (dnf), Fedora Atomic detection (rpm-ostree), Arch (pacman), openSUSE (zypper)
# Also installs the Rust toolchain (cargo) via rustup when not already present.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/linux-target-detect.sh"

sudo() {
    "$SCRIPT_DIR/sudo-with-alert.sh" "$@"
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
ARCH="$(uname -m)"
MIN_NODE_MAJOR=20
NODEJS_MAJOR="${NODEJS_MAJOR:-22}"

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Node.js compatibility
# ---------------------------------------------------------------------------
node_major() {
    command -v node &>/dev/null || return 1

    local version major
    version="$(node -v 2>/dev/null || true)"
    major="${version#v}"
    major="${major%%.*}"

    case "$major" in
        ''|*[!0-9]*) return 1 ;;
        *) printf '%s\n' "$major" ;;
    esac
}

has_compatible_nodejs() {
    local major
    major="$(node_major 2>/dev/null || true)"

    [ -n "$major" ] \
        && [ "$major" -ge "$MIN_NODE_MAJOR" ] \
        && command -v npm &>/dev/null \
        && command -v npx &>/dev/null
}

validate_nodejs_major() {
    case "$NODEJS_MAJOR" in
        ''|*[!0-9]*)
            error "NODEJS_MAJOR must be numeric, for example: NODEJS_MAJOR=22 bash scripts/install-deps.sh"
            ;;
    esac

    if [ "$NODEJS_MAJOR" -lt 22 ]; then
        error "NODEJS_MAJOR=$NODEJS_MAJOR is not supported for apt bootstrap. Use Node.js 22 or newer.
Existing user-managed Node.js 20 installations are still accepted by install.sh, but new bootstrap installs should use a maintained Node.js line."
    fi
}

apt_nodejs_candidate_major() {
    local line candidate major=""

    while IFS= read -r line; do
        case "$line" in
            *Candidate:*)
                candidate="${line#*Candidate: }"
                break
                ;;
        esac
    done < <(apt-cache policy nodejs 2>/dev/null || true)

    [ -n "${candidate:-}" ] && [ "$candidate" != "(none)" ] || return 1

    if [[ "$candidate" =~ ^[0-9]+:([0-9]+)\. ]]; then
        major="${BASH_REMATCH[1]}"
    elif [[ "$candidate" =~ ^([0-9]+)\. ]]; then
        major="${BASH_REMATCH[1]}"
    else
        return 1
    fi

    printf '%s\n' "$major"
}

install_apt_distro_nodejs_if_compatible() {
    local major
    major="$(apt_nodejs_candidate_major 2>/dev/null || true)"

    if [ -z "$major" ]; then
        warn "Could not determine distro nodejs candidate; using NodeSource"
        return 1
    fi

    if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
        warn "Distro nodejs candidate is below Node.js ${MIN_NODE_MAJOR}; using NodeSource"
        return 1
    fi

    info "Installing distro Node.js/npm candidate (Node.js major $major)"
    sudo apt-get install -y nodejs npm
}

apt_arch_for_nodesource() {
    local apt_arch
    apt_arch="$(dpkg --print-architecture)"

    case "$apt_arch" in
        amd64|arm64|armhf)
            printf '%s\n' "$apt_arch"
            ;;
        *)
            error "NodeSource apt packages are not available for architecture '$apt_arch'.
Install Node.js ${MIN_NODE_MAJOR}+ manually, then re-run this script."
            ;;
    esac
}

install_nodesource_nodejs() {
    validate_nodejs_major

    local apt_arch keyring source_list tmp_key
    apt_arch="$(apt_arch_for_nodesource)"
    keyring="/etc/apt/keyrings/nodesource.gpg"
    source_list="/etc/apt/sources.list.d/nodesource.list"
    tmp_key="$(mktemp)"
    # shellcheck disable=SC2064
    trap "rm -f '$tmp_key'" RETURN

    info "Installing Node.js ${NODEJS_MAJOR}.x from NodeSource"
    sudo apt-get install -y gnupg
    sudo install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$tmp_key"
    gpg --dearmor < "$tmp_key" | sudo tee "$keyring" >/dev/null
    sudo chmod 0644 "$keyring"

    printf 'deb [arch=%s signed-by=%s] https://deb.nodesource.com/node_%s.x nodistro main\n' \
        "$apt_arch" "$keyring" "$NODEJS_MAJOR" \
        | sudo tee "$source_list" >/dev/null

    sudo apt-get update -qq
    sudo apt-get install -y nodejs
}

report_nodejs_toolchain() {
    info "Node.js toolchain available: node $(node -v), npm $(npm -v), npx $(npx -v)"
}

current_node_version_suffix() {
    if command -v node &>/dev/null; then
        printf ' but found %s' "$(node -v)"
    fi
}

ensure_nodejs_compatible() {
    local distro="$1"

    if has_compatible_nodejs; then
        report_nodejs_toolchain
        return
    fi

    if [ "$distro" = "dnf5" ] || [ "$distro" = "rpm-ostree" ]; then
        info "Skipping system Node.js check; install.sh provides the managed Node.js runtime"
        return
    fi

    if [ "$distro" != "apt" ]; then
        error "Node.js ${MIN_NODE_MAJOR}+ with npm and npx is required$(current_node_version_suffix).
Install a supported Node.js version for this distro, or use install.sh to download the managed runtime, then re-run this script."
    fi

    warn "Node.js ${MIN_NODE_MAJOR}+ with npm and npx is required$(current_node_version_suffix)"
    install_apt_distro_nodejs_if_compatible || true

    if has_compatible_nodejs; then
        report_nodejs_toolchain
        return
    fi

    install_nodesource_nodejs

    if has_compatible_nodejs; then
        report_nodejs_toolchain
        return
    fi

    error "NodeSource install completed, but Node.js ${MIN_NODE_MAJOR}+ with npm and npx is still unavailable.
Check apt output above or install Node.js ${MIN_NODE_MAJOR}+ manually."
}

detect_distro() {
    detect_package_manager
}

preferred_gui_prompt_package() {
    local desktop="${XDG_CURRENT_DESKTOP:-${DESKTOP_SESSION:-}}"
    desktop="$(printf '%s' "$desktop" | tr '[:upper:]' '[:lower:]')"
    case "$desktop" in
        *kde*|*plasma*)
            echo "kdialog"
            ;;
        *)
            echo "zenity"
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Install helpers
# ---------------------------------------------------------------------------
install_apt() {
    info "Detected Debian/Ubuntu (apt)"
    sudo apt-get update -qq
    sudo apt-get install -y \
        ca-certificates python3 \
        binutils curl unzip tar \
        build-essential
}

install_dnf5() {
    info "Detected RPM-based distro (dnf5)"
    # Install make and gcc-c++ explicitly because the group may already be marked
    # installed without providing the g++ executable required by install.sh.
    sudo dnf install -y \
        python3 binutils curl unzip tar rpm-build make gcc-c++ \
        @development-tools
}

install_dnf() {
    info "Detected RPM-based distro (dnf)"
    sudo dnf install -y \
        nodejs npm python3 \
        binutils curl unzip tar rpm-build make gcc-c++
    sudo dnf groupinstall -y 'Development Tools'
}

install_rpm_ostree() {
    info "Detected Fedora Atomic / rpm-ostree host"

    local -a missing=()
    command -v python3 >/dev/null 2>&1 || missing+=("python3")
    command -v ar >/dev/null 2>&1 || missing+=("binutils")
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v unzip >/dev/null 2>&1 || missing+=("unzip")
    command -v rpmbuild >/dev/null 2>&1 || missing+=("rpm-build")
    command -v make >/dev/null 2>&1 || missing+=("make")
    command -v g++ >/dev/null 2>&1 || missing+=("gcc-c++")

    if [ "${#missing[@]}" -eq 0 ]; then
        info "rpm-ostree layered build dependencies are already available"
        return
    fi

    error "Fedora Atomic hosts layer packages with rpm-ostree and usually need a reboot before new tools are available.
Review and run manually if this is the host you want to layer:
  sudo rpm-ostree install python3 binutils curl unzip tar rpm-build make gcc-c++
  systemctl reboot
Then rerun this script after the reboot.
Still missing: ${missing[*]}"
}

install_pacman() {
    info "Detected Arch Linux (pacman)"
    local node_packages=(nodejs npm)

    if has_compatible_nodejs; then
        info "Compatible Node.js toolchain already available; skipping pacman nodejs/npm packages"
        node_packages=()
    fi

    sudo pacman -S --needed --noconfirm \
        "${node_packages[@]}" python \
        binutils curl unzip tar zstd \
        base-devel
}

install_zypper() {
    info "Detected openSUSE (zypper)"
    sudo zypper --non-interactive install \
        nodejs-default npm-default python3 \
        binutils curl unzip tar
    sudo zypper --non-interactive install -t pattern devel_basis
}

install_gui_prompt_helper() {
    local package
    package="$(preferred_gui_prompt_package)"

    case "$DISTRO" in
        apt)
            sudo apt-get install -y "$package"
            ;;
        dnf5)
            sudo dnf install -y "$package"
            ;;
        dnf)
            sudo dnf install -y "$package"
            ;;
        pacman)
            sudo pacman -S --needed --noconfirm "$package"
            ;;
        zypper)
            sudo zypper --non-interactive install "$package"
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Rust / cargo (via rustup — distro-independent)
# ---------------------------------------------------------------------------
install_rust() {
    # Already on PATH
    if command -v cargo &>/dev/null; then
        info "cargo already installed ($(cargo --version))"
        return
    fi

    # Installed by rustup but not yet sourced in this session
    if [ -x "$HOME/.cargo/bin/cargo" ]; then
        info "cargo found at ~/.cargo/bin — sourcing environment"
        # shellcheck source=/dev/null
        source "$HOME/.cargo/env"
        return
    fi

    info "Installing Rust toolchain via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

    # Make cargo available in this shell session
    # shellcheck source=/dev/null
    source "$HOME/.cargo/env"

    info "Rust installed. Run 'source \$HOME/.cargo/env' or open a new terminal to use cargo."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
OS_RELEASE_ID="$(os_release_field ID 2>/dev/null || true)"
OS_RELEASE_ID_LIKE="$(os_release_field ID_LIKE 2>/dev/null || true)"
OS_RELEASE_VERSION_ID="$(os_release_field VERSION_ID 2>/dev/null || true)"
DISTRO="$(detect_distro)"

if [ "${DETECT_ONLY:-0}" = "1" ]; then
    info "Detected dependency profile: $DISTRO"
    info "os-release: ID=${OS_RELEASE_ID:-unknown} ID_LIKE=${OS_RELEASE_ID_LIKE:-unknown} VERSION_ID=${OS_RELEASE_VERSION_ID:-unknown}"
    exit 0
fi

case "$DISTRO" in
    apt)     install_apt    ;;
    dnf5)    install_dnf5   ;;
    dnf)     install_dnf    ;;
    rpm-ostree) install_rpm_ostree ;;
    pacman)  install_pacman ;;
    zypper)  install_zypper ;;
    *)
        error "Unsupported package manager. Install manually:
  # Debian/Ubuntu: install Node.js 20+ with npm/npx from NodeSource, nvm, or another compatible source, then:
  sudo apt install python3 binutils curl unzip tar build-essential                   # Debian/Ubuntu
  sudo dnf install python3 binutils curl unzip tar rpm-build make gcc-c++ @development-tools             # Fedora 41+ (dnf5)
  sudo dnf install nodejs npm python3 binutils curl unzip tar rpm-build make gcc-c++      # Fedora <41 (dnf)
    && sudo dnf groupinstall 'Development Tools'
  sudo pacman -S nodejs npm python binutils curl unzip tar zstd base-devel                 # Arch
  sudo zypper install nodejs-default npm-default python3 binutils curl unzip tar      # openSUSE
    && sudo zypper install -t pattern devel_basis"
        ;;
esac

ensure_nodejs_compatible "$DISTRO"
install_rust
install_gui_prompt_helper

info "All dependencies installed. You can now run: ./install.sh"
