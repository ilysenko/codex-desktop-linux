#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_CI_PACKAGE_VERSION="2026.04.28.000000+local"
CI_PACKAGE_VERSION="${CI_PACKAGE_VERSION:-$DEFAULT_CI_PACKAGE_VERSION}"
CI_CACHE_DIR="${CI_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop-linux-ci}"

IMAGE_UBUNTU_24="${CI_IMAGE_UBUNTU_24:-docker.io/library/ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b}"
IMAGE_UBUNTU_22="${CI_IMAGE_UBUNTU_22:-docker.io/library/ubuntu:22.04@sha256:962f6cadeae0ea6284001009daa4cc9a8c37e75d1f5191cf0eb83fe565b63dd7}"
IMAGE_DEBIAN_12="${CI_IMAGE_DEBIAN_12:-docker.io/library/debian:12@sha256:8a8cd02c5912770b4980228a54d4aff9e4f986f1eb2525d2d371dec5232cefcc}"
IMAGE_FEDORA_42="${CI_IMAGE_FEDORA_42:-docker.io/library/fedora:42@sha256:99e203b80b1c3d8f7e161ec10a68fd02b081ef83a3963553e513c82846b97814}"
IMAGE_ARCH_BASE_DEVEL="${CI_IMAGE_ARCH_BASE_DEVEL:-docker.io/library/archlinux:base-devel@sha256:fdff15f24df062598faebf380430955a9bd2109736e179ebb354f1208f725774}"
IMAGE_NIX="${CI_IMAGE_NIX:-docker.io/nixos/nix:latest@sha256:bf1d938835ab96312f098fa6c2e9cab367728e0aad0646ee3e02a787c80d8fb8}"

usage() {
    cat <<'HELP'
Usage: ./scripts/ci-local.sh [target...]

Targets:
  pr                         Run the standard pull-request suite: core, deb, rpm, pacman
  all                        Run pr plus install-deps, nix, and upstream
  core                       Run shell, Rust, Node patcher, and smoke tests
  deb                        Build and inspect the Debian package
  rpm                        Build and inspect the RPM package
  pacman                     Build and inspect the pacman package
  install-deps               Test install-deps on Ubuntu 22.04, Ubuntu 24.04, and Debian 12
  install-deps:ubuntu-22.04  Test install-deps on one apt image
  install-deps:ubuntu-24.04  Test install-deps on one apt image
  install-deps:debian-12     Test install-deps on one apt image
  nix                        Run the heavy Nix flake build checks
  upstream                   Build the app against the upstream DMG

Environment:
  CI_CONTAINER_ENGINE=docker|podman
  CI_PACKAGE_VERSION=2026.04.28.000000+local
  CI_DMG_PATH=/path/to/Codex.dmg
  CI_SKIP_PULL=1
  CI_CACHE_DIR=/path/to/cache

Note: package targets recreate generated codex-app/ and dist/ just like GitHub CI.
HELP
}

info() {
    echo "[ci-local] $*" >&2
}

error() {
    echo "[ci-local][ERROR] $*" >&2
    exit 1
}

container_engine() {
    if [ -n "${CI_CONTAINER_ENGINE:-}" ]; then
        command -v "$CI_CONTAINER_ENGINE" >/dev/null 2>&1 || error "CI_CONTAINER_ENGINE is not available: $CI_CONTAINER_ENGINE"
        echo "$CI_CONTAINER_ENGINE"
        return
    fi

    if command -v docker >/dev/null 2>&1; then
        echo docker
        return
    fi
    if command -v podman >/dev/null 2>&1; then
        echo podman
        return
    fi

    error "Docker or Podman is required. Install one, or set CI_CONTAINER_ENGINE explicitly."
}

image_for_key() {
    case "$1" in
        ubuntu-24.04) echo "$IMAGE_UBUNTU_24" ;;
        ubuntu-22.04) echo "$IMAGE_UBUNTU_22" ;;
        debian-12) echo "$IMAGE_DEBIAN_12" ;;
        fedora-42) echo "$IMAGE_FEDORA_42" ;;
        archlinux-base-devel) echo "$IMAGE_ARCH_BASE_DEVEL" ;;
        nix) echo "$IMAGE_NIX" ;;
        *) error "Unknown CI image key: $1" ;;
    esac
}

image_key_for_job() {
    case "$1" in
        core|deb|upstream) echo "ubuntu-24.04" ;;
        rpm) echo "fedora-42" ;;
        pacman) echo "archlinux-base-devel" ;;
        nix) echo "nix" ;;
        *) error "No default image for job: $1" ;;
    esac
}

mount_github_summary_args() {
    local -n _args="$1"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        local summary_dir
        summary_dir="$(dirname "$GITHUB_STEP_SUMMARY")"
        mkdir -p "$summary_dir"
        _args+=(-e "GITHUB_STEP_SUMMARY=$GITHUB_STEP_SUMMARY" -v "$summary_dir:$summary_dir")
    fi
}

mount_upstream_args() {
    local -n _args="$1"
    local upstream_dir="/tmp/codex-upstream-ci"
    mkdir -p "$upstream_dir"
    _args+=(-v "$upstream_dir:$upstream_dir")

    if [ -n "${CI_DMG_PATH:-}" ] && [ "${CI_DMG_PATH#/}" != "$CI_DMG_PATH" ]; then
        local dmg_dir
        dmg_dir="$(dirname "$CI_DMG_PATH")"
        mkdir -p "$dmg_dir"
        _args+=(-v "$dmg_dir:$dmg_dir")
    fi
}

run_container_job() {
    local job="$1"
    local image_key="$2"
    local engine
    local image
    engine="$(container_engine)"
    image="$(image_for_key "$image_key")"

    mkdir -p "$CI_CACHE_DIR"

    if [ "${CI_SKIP_PULL:-0}" != "1" ]; then
        info "Pulling $image_key image"
        "$engine" pull "$image" >/dev/null
    fi

    local -a args=(
        run
        --rm
        -e "CI_JOB=$job"
        -e "CI_IMAGE_KEY=$image_key"
        -e "CI_HOST_UID=$(id -u)"
        -e "CI_HOST_GID=$(id -g)"
        -e "CI_PACKAGE_VERSION=$CI_PACKAGE_VERSION"
        -e "PACKAGE_VERSION=$CI_PACKAGE_VERSION"
        -e "CARGO_TERM_COLOR=${CARGO_TERM_COLOR:-always}"
        -e "UPSTREAM_DMG_URL=${UPSTREAM_DMG_URL:-https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg}"
        -e "UPSTREAM_DMG_PATH=${UPSTREAM_DMG_PATH:-/tmp/codex-upstream-ci/Codex.dmg}"
        -v "$REPO_DIR:/work"
        -v "$CI_CACHE_DIR:/ci-cache"
        -w /work
    )

    if [ -n "${CI_DMG_PATH:-}" ]; then
        args+=(-e "CI_DMG_PATH=$CI_DMG_PATH")
    fi
    if [ -n "${UPSTREAM_DMG_CACHE_HIT:-}" ]; then
        args+=(-e "UPSTREAM_DMG_CACHE_HIT=$UPSTREAM_DMG_CACHE_HIT")
    fi

    mount_github_summary_args args
    if [ "$job" = "upstream" ]; then
        mount_upstream_args args
    fi

    info "Running $job in $image_key"
    "$engine" "${args[@]}" "$image" bash /work/scripts/ci/container-entrypoint.sh "$job"
}

run_target() {
    local target="$1"

    case "$target" in
        -h|--help|help)
            usage
            ;;
        pr)
            run_target core
            run_target deb
            run_target rpm
            run_target pacman
            ;;
        all)
            run_target pr
            run_target install-deps
            run_target nix
            run_target upstream
            ;;
        core|deb|rpm|pacman|nix|upstream)
            run_container_job "$target" "$(image_key_for_job "$target")"
            ;;
        install-deps)
            run_target install-deps:ubuntu-22.04
            run_target install-deps:ubuntu-24.04
            run_target install-deps:debian-12
            ;;
        install-deps:ubuntu-22.04)
            run_container_job install-deps ubuntu-22.04
            ;;
        install-deps:ubuntu-24.04)
            run_container_job install-deps ubuntu-24.04
            ;;
        install-deps:debian-12)
            run_container_job install-deps debian-12
            ;;
        *)
            usage >&2
            error "Unknown target: $target"
            ;;
    esac
}

if [ "$#" -eq 0 ]; then
    set -- pr
fi

for target in "$@"; do
    run_target "$target"
done
