#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/linux-target-detect.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/install-deps-rust.sh"

run_privileged() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        "$SCRIPT_DIR/sudo-with-alert.sh" "$@"
    fi
}

info() { printf '[deps] %s\n' "$*"; }
fail() { printf '[deps][ERROR] %s\n' "$*" >&2; exit 1; }

build_path() {
    printf '%s:%s\n' "$HOME/.cargo/bin" "$PATH"
}

cargo_works_for_build() {
    PATH="$(build_path)" cargo --version >/dev/null 2>&1
}

rustc_works_for_build() {
    PATH="$(build_path)" rustc --version >/dev/null 2>&1
}

rustup_available_for_build() {
    PATH="$(build_path)" command -v rustup >/dev/null 2>&1
}

install_nodesource_apt() {
    local nodejs_major="${NODEJS_MAJOR:-24}"
    local keyring=/usr/share/keyrings/nodesource.gpg
    local source_list=/etc/apt/sources.list.d/nodesource.list
    local staging_dir

    case "$nodejs_major" in
        20|22|24) ;;
        *) fail "NODEJS_MAJOR must be one of: 20, 22, 24" ;;
    esac

    staging_dir="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$staging_dir'" RETURN
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        -o "$staging_dir/nodesource.asc"
    gpg --batch --dearmor --output "$staging_dir/nodesource.gpg" \
        "$staging_dir/nodesource.asc"
    run_privileged install -m 0644 "$staging_dir/nodesource.gpg" "$keyring"
    printf 'deb [signed-by=%s] https://deb.nodesource.com/node_%s.x nodistro main\n' \
        "$keyring" "$nodejs_major" | run_privileged tee "$source_list" >/dev/null

    if command -v node >/dev/null 2>&1 && \
        [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]; then
        run_privileged env DEBIAN_FRONTEND=noninteractive apt-get remove -y \
            nodejs npm libnode-dev
    fi

    rm -rf "$staging_dir"
    trap - RETURN
}

install_apt() {
    run_privileged apt-get update -qq
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y \
        bash ca-certificates curl dpkg-dev g++ gcc git gnupg make \
        pkg-config python3 rpm rpm2cpio tar unzip util-linux xz-utils
    install_nodesource_apt
    run_privileged apt-get update -qq
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
}

install_dnf() {
    run_privileged dnf install -y bash ca-certificates curl dpkg gcc gcc-c++ git \
        gnupg2 make nodejs npm python3 rpm-build tar unzip util-linux xz
}

install_zypper() {
    run_privileged zypper --non-interactive install \
        bash ca-certificates curl dpkg gcc gcc-c++ git gpg2 make nodejs npm \
        python3 rpm-build tar unzip util-linux xz
}

install_pacman() {
    local -a packages=(
        base-devel ca-certificates curl dpkg git gnupg nodejs npm python
        tar unzip util-linux xz zstd
    )
    local rust_package

    # Match bootstrap-native's Rust resolution order. A user-local rustup
    # proxy can shadow a working distro Cargo once $HOME/.cargo/bin is
    # prepended for the native build.
    rust_package="$(PATH="$(build_path)" pacman_rust_bootstrap_package)"
    if [ -n "$rust_package" ]; then
        packages+=("$rust_package")
    fi

    if pacman_dependencies_installed "${packages[@]}"; then
        info 'pacman dependencies already installed; skipping system upgrade.'
        return 0
    fi

    run_privileged pacman -Syu --noconfirm --needed "${packages[@]}"
}

install_rust() {
    cargo_works_for_build && rustc_works_for_build && return 0

    rustup_available_for_build || {
        info 'Rust is only required for the updater and retained native feature helpers.'
        info 'Install Rust or rustup for your distribution, then rerun this script.'
        return 0
    }

    PATH="$(build_path)" rustup toolchain install stable --profile minimal
    PATH="$(build_path)" rustup default stable
    cargo_works_for_build || fail 'Cargo is unavailable after Rust toolchain setup.'
    rustc_works_for_build || fail 'rustc is unavailable after Rust toolchain setup.'
}

manager="$(detect_package_manager)"
case "$manager" in
    apt) install_apt ;;
    dnf|dnf5) install_dnf ;;
    zypper) install_zypper ;;
    pacman) install_pacman ;;
    rpm-ostree)
        fail 'Use a toolbox/distrobox build environment on rpm-ostree systems.'
        ;;
    *) fail "unsupported package manager: ${manager:-unknown}" ;;
esac

install_rust

for command in bash curl dpkg-deb gpgv node npm python3 sha256sum tar; do
    command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable after bootstrap: $command"
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$node_major" -ge 20 ] || fail "Node.js 20 or newer is required; found $(node --version)"

info "ready: node $(node --version), architecture $(uname -m)"
