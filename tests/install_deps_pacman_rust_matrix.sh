#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() { printf '[pacman-rust-matrix][ERROR] %s\n' "$*" >&2; exit 1; }
info() { printf '[pacman-rust-matrix] %s\n' "$*"; }

build_path() {
    printf '%s:%s\n' "$HOME/.cargo/bin" "$PATH"
}

with_build_path() {
    PATH="$(build_path)" "$@"
}

assert_succeeds() {
    "$@" >/dev/null 2>&1 || fail "expected command to succeed: $*"
}

assert_fails() {
    ! "$@" >/dev/null 2>&1 || fail "expected command to fail: $*"
}

pacman_package_installed() {
    local package="$1"
    [ "$(pacman -Qq "$package" 2>/dev/null || true)" = "$package" ]
}

assert_no_pacman_rust_conflict() {
    if pacman_package_installed rust &&
       pacman_package_installed rustup; then
        fail 'pacman rust and rustup packages must not be installed together'
    fi
}

reset_rust_state() {
    local -a installed=()
    local package
    for package in rust rustup; do
        if pacman_package_installed "$package"; then
            installed+=("$package")
        fi
    done
    if [ "${#installed[@]}" -gt 0 ]; then
        pacman -Rns --noconfirm "${installed[@]}"
    fi
    rm -rf -- "$HOME/.cargo" "$HOME/.rustup"
    hash -r
}

install_base_tools() {
    pacman -Syu --noconfirm --needed ca-certificates curl
}

run_install_deps() {
    (cd "$REPO_DIR" && bash scripts/install-deps.sh)
}

assert_ready_host_skips_pacman_transaction() {
    local wrapper_dir
    local pacman_log

    wrapper_dir="$(mktemp -d)"
    pacman_log="$wrapper_dir/pacman.log"
    cat >"$wrapper_dir/pacman" <<'EOF'
#!/bin/bash
printf '%q ' "$@" >>"$CODEX_TEST_PACMAN_LOG"
printf '\n' >>"$CODEX_TEST_PACMAN_LOG"
exec /usr/bin/pacman "$@"
EOF
    chmod +x "$wrapper_dir/pacman"

    CODEX_TEST_PACMAN_LOG="$pacman_log" \
        PATH="$wrapper_dir:$PATH" \
        run_install_deps

    grep -q '^-T ' "$pacman_log" ||
        fail 'expected the ready-host dependency probe'
    if grep -q '^-S' "$pacman_log"; then
        fail 'ready host must not start a pacman install or upgrade transaction'
    fi

    rm -rf "$wrapper_dir"
}

verify_build_rust() {
    assert_succeeds with_build_path cargo --version
    assert_succeeds with_build_path rustc --version
    assert_no_pacman_rust_conflict
}

case_working_distro_cargo() {
    reset_rust_state
    pacman -S --noconfirm --needed rust
    assert_succeeds /usr/bin/cargo --version
    assert_succeeds with_build_path cargo --version
    run_install_deps
    verify_build_rust
    assert_ready_host_skips_pacman_transaction
    pacman_package_installed rust || fail 'expected pacman rust to remain installed'
    ! pacman_package_installed rustup || fail 'did not expect pacman rustup with distro rust'
}

case_rustup_without_toolchain() {
    reset_rust_state
    pacman -S --noconfirm --needed rustup
    assert_fails with_build_path cargo --version
    assert_succeeds with_build_path rustup --version
    run_install_deps
    verify_build_rust
    pacman_package_installed rustup || fail 'expected pacman rustup to remain installed'
    ! pacman_package_installed rust || fail 'did not expect pacman rust with rustup'
}

case_neither_rust_nor_rustup() {
    reset_rust_state
    assert_fails with_build_path cargo --version
    assert_fails with_build_path rustup --version
    run_install_deps
    verify_build_rust
    pacman_package_installed rustup || fail 'expected install-deps to install pacman rustup'
    ! pacman_package_installed rust || fail 'did not expect pacman rust with rustup'
}

install_user_local_rustup_proxy_from_pacman() {
    local rustup_cmd

    pacman -S --noconfirm --needed rustup
    pacman_package_installed rustup || fail 'expected pacman rustup package to be installed'
    rustup_cmd="$(command -v rustup)"
    install -d -m 0755 "$HOME/.cargo/bin"
    install -m 0755 "$rustup_cmd" "$HOME/.cargo/bin/rustup"
    ln -s rustup "$HOME/.cargo/bin/cargo"
    ln -s rustup "$HOME/.cargo/bin/rustc"
    pacman -Rns --noconfirm rustup
    hash -r
}

case_shadowed_user_local_proxy() {
    reset_rust_state
    install_user_local_rustup_proxy_from_pacman
    pacman -S --noconfirm --needed rust
    hash -r

    assert_succeeds /usr/bin/cargo --version
    [ "$(with_build_path command -v cargo)" = "$HOME/.cargo/bin/cargo" ] ||
        fail 'expected user-local rustup cargo proxy to shadow /usr/bin/cargo'
    assert_fails with_build_path cargo --version

    run_install_deps
    verify_build_rust
    [ "$(with_build_path command -v cargo)" = "$HOME/.cargo/bin/cargo" ] ||
        fail 'expected native build path to keep resolving user-local cargo after setup'
    pacman_package_installed rust || fail 'expected pacman rust to remain installed'
    ! pacman_package_installed rustup || fail 'did not expect pacman rustup with distro rust'
}

require_arch_container() {
    [ "${CODEX_RUN_ARCH_INSTALL_DEPS_MATRIX:-0}" = "1" ] ||
        fail 'set CODEX_RUN_ARCH_INSTALL_DEPS_MATRIX=1 to run this destructive Arch container test'
    [ "$(id -u)" -eq 0 ] || fail 'this test must run as root inside a disposable Arch container'
    command -v pacman >/dev/null 2>&1 || fail 'pacman is required'
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
        arch|archlinux) ;;
        *) fail "expected an Arch container, found ${PRETTY_NAME:-unknown}" ;;
    esac
}

run_case() {
    local name="$1"
    info "case: $name"
    case "$name" in
        working-distro-cargo) case_working_distro_cargo ;;
        rustup-without-toolchain) case_rustup_without_toolchain ;;
        neither-rust-nor-rustup) case_neither_rust_nor_rustup ;;
        shadowed-user-local-proxy) case_shadowed_user_local_proxy ;;
        *) fail "unknown case: $name" ;;
    esac
    info "case passed: $name"
}

require_arch_container
install_base_tools

if [ "$#" -eq 0 ]; then
    set -- \
        working-distro-cargo \
        rustup-without-toolchain \
        neither-rust-nor-rustup \
        shadowed-user-local-proxy
fi

for case_name in "$@"; do
    run_case "$case_name"
done
