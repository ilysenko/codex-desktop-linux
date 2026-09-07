#!/bin/bash
set -Eeuo pipefail

REPO_DIR=/work
CI_JOB="${1:-${CI_JOB:-}}"
PACKAGE_VERSION="${CI_PACKAGE_VERSION:-2026.08.12.000000+local}"

die() { echo "[ci:${CI_JOB}][ERROR] $*" >&2; exit 1; }

install_apt() {
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash ca-certificates curl dpkg-dev g++ gcc git gnupg make nodejs npm \
        pkg-config python3 ripgrep rpm rpm2cpio sudo tar unzip util-linux xz-utils
}

install_fedora() {
    dnf install -y bash ca-certificates curl dpkg gcc gcc-c++ git gnupg2 make \
        nodejs npm python3 ripgrep rpm-build tar unzip util-linux xz
}

install_arch() {
    pacman -Syu --noconfirm --needed base-devel ca-certificates curl dpkg git \
        gnupg nodejs npm python ripgrep rustup sudo unzip util-linux xz zstd
}

prepare() {
    case "$CI_JOB" in
        rpm) install_fedora ;;
        pacman) install_arch ;;
        nix) ;;
        install-deps) ;;
        *) install_apt ;;
    esac

    if command -v git >/dev/null 2>&1; then
        git config --global --add safe.directory "$REPO_DIR"
    fi
}

build_clean_app() {
    export CODEX_LINUX_FEATURES_CONFIG="$REPO_DIR/linux-features/features.example.json"
    "$REPO_DIR/install.sh"
}

run_core() {
    local node_test_log
    node_test_log="$(mktemp)"
    bash tests/scripts_smoke.sh
    if ! node --test scripts/patch-linux-window-ui.test.js scripts/lib/linux-features.test.js linux-features/*/test.js >"$node_test_log" 2>&1; then
        rg -n -C 30 '^not ok' "$node_test_log" || tail -n 120 "$node_test_log"
        return 1
    fi
    tail -n 12 "$node_test_log"
    if command -v cargo >/dev/null 2>&1; then
        cargo test -p codex-update-manager
        cargo test -p codex-record-replay-linux
    fi
}

run_package() {
    build_clean_app
    export PACKAGE_VERSION PACKAGE_WITH_UPDATER=0
    case "$CI_JOB" in
        deb) ./scripts/build-deb.sh ;;
        rpm) ./scripts/build-rpm.sh ;;
        pacman)
            local host_uid="${CI_HOST_UID:?missing CI_HOST_UID}"
            local host_gid="${CI_HOST_GID:?missing CI_HOST_GID}"
            local builder_group
            local builder_user
            builder_group="$(getent group "$host_gid" | cut -d: -f1 || true)"
            if [ -z "$builder_group" ]; then
                builder_group=codex-ci
                groupadd --gid "$host_gid" "$builder_group"
            fi
            builder_user="$(getent passwd "$host_uid" | cut -d: -f1 || true)"
            if [ -z "$builder_user" ]; then
                builder_user=codex-ci
                useradd --uid "$host_uid" --gid "$host_gid" --no-create-home "$builder_user"
            fi
            install -d -o "$host_uid" -g "$host_gid" /tmp/codex-ci-home
            chown -R "$host_uid:$host_gid" "$REPO_DIR/codex-app" "$REPO_DIR/dist"
            runuser -u "$builder_user" -- env \
                HOME=/tmp/codex-ci-home \
                CODEX_LINUX_FEATURES_CONFIG="$CODEX_LINUX_FEATURES_CONFIG" \
                PACKAGE_VERSION="$PACKAGE_VERSION" \
                PACKAGE_WITH_UPDATER="$PACKAGE_WITH_UPDATER" \
                ./scripts/build-pacman.sh
            ;;
    esac
}

run_upstream() {
    node scripts/automation/upstream-linux-package-watchdog/watchdog.js --json
    build_clean_app
    ./codex-app/start.sh --diagnose
}

run_install_deps() {
    if [ "${CI_IMAGE_KEY:-}" = archlinux-base-devel ]; then
        local -a matrix_args=()
        if [ -n "${CI_INSTALL_DEPS_CASE:-}" ]; then
            matrix_args+=("$CI_INSTALL_DEPS_CASE")
        fi
        CODEX_RUN_ARCH_INSTALL_DEPS_MATRIX=1 \
            bash tests/install_deps_pacman_rust_matrix.sh "${matrix_args[@]}"
        return
    fi

    bash scripts/install-deps.sh
    output="$(./install.sh /tmp/retired-source.dmg 2>&1)" && status=0 || status=$?
    test "$status" -ne 0
    grep -q "macOS DMG inputs are no longer supported" <<<"$output"
}

run_nix() {
    export NIX_CONFIG="${NIX_CONFIG:-experimental-features = nix-command flakes}"
    nix flake check --no-write-lock-file --option sandbox false
    nix build .#codex-desktop --no-link --option sandbox false
}

[ -n "$CI_JOB" ] || die "missing job"
cd "$REPO_DIR"
prepare
case "$CI_JOB" in
    core) run_core ;;
    deb|rpm|pacman) run_package ;;
    upstream) run_upstream ;;
    install-deps) run_install_deps ;;
    nix) run_nix ;;
    *) die "unsupported job" ;;
esac
