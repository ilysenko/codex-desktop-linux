#!/bin/bash
set -Eeuo pipefail

REPO_DIR="/work"
CI_JOB="${1:-${CI_JOB:-}}"
CI_IMAGE_KEY="${CI_IMAGE_KEY:-unknown}"
CI_HOST_UID="${CI_HOST_UID:-1000}"
CI_HOST_GID="${CI_HOST_GID:-1000}"
CI_PACKAGE_VERSION="${CI_PACKAGE_VERSION:-2026.04.28.000000+local}"
CI_CARGO_HOME="${CARGO_HOME:-/ci-cache/cargo}"
CI_RUSTUP_HOME="${RUSTUP_HOME:-/ci-cache/rustup}"
CI_NPM_CACHE="${npm_config_cache:-/ci-cache/npm}"

info() {
    echo "[ci:$CI_JOB] $*" >&2
}

error() {
    echo "[ci:$CI_JOB][ERROR] $*" >&2
    exit 1
}

append_summary() {
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
    {
        echo "## $1"
        echo ""
        shift
        for line in "$@"; do
            echo "- $line"
        done
        echo ""
    } >> "$GITHUB_STEP_SUMMARY"
}

apt_install() {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends "$@"
    rm -rf /var/lib/apt/lists/*
}

prepare_apt_ci() {
    apt_install \
        bash \
        ca-certificates \
        curl \
        file \
        g++ \
        gcc \
        git \
        libssl-dev \
        make \
        nodejs \
        npm \
        p7zip-full \
        pkg-config \
        python3 \
        tar \
        unzip \
        xz-utils
}

prepare_apt_install_deps() {
    apt_install ca-certificates curl sudo
}

prepare_fedora_ci() {
    dnf install -y \
        bash \
        ca-certificates \
        curl \
        findutils \
        gcc \
        gcc-c++ \
        git \
        make \
        nodejs \
        npm \
        openssl-devel \
        pkgconf-pkg-config \
        python3 \
        rpm \
        rpm-build \
        shadow-utils \
        tar \
        unzip \
        which \
        xz
    dnf clean all
}

prepare_arch_ci() {
    pacman -Syu --noconfirm --needed \
        base-devel \
        ca-certificates \
        curl \
        git \
        nodejs \
        npm \
        python \
        rustup \
        sudo \
        unzip \
        xz \
        zstd
}

ensure_ci_user() {
    if [ "$CI_HOST_UID" = "0" ]; then
        CI_USER="root"
        CI_HOME="/root"
        return 0
    fi

    local group_name
    if getent group "$CI_HOST_GID" >/dev/null 2>&1; then
        group_name="$(getent group "$CI_HOST_GID" | cut -d: -f1)"
    else
        group_name="ci"
        groupadd -g "$CI_HOST_GID" "$group_name"
    fi

    if getent passwd "$CI_HOST_UID" >/dev/null 2>&1; then
        CI_USER="$(getent passwd "$CI_HOST_UID" | cut -d: -f1)"
    else
        CI_USER="ci"
        useradd -m -u "$CI_HOST_UID" -g "$CI_HOST_GID" -s /bin/bash "$CI_USER"
    fi

    CI_HOME="$(getent passwd "$CI_HOST_UID" | cut -d: -f6)"
    mkdir -p "$CI_HOME" "$CI_CARGO_HOME" "$CI_RUSTUP_HOME" "$CI_NPM_CACHE"
    chown -R "$CI_HOST_UID:$CI_HOST_GID" "$CI_HOME" /ci-cache
}

quote_args() {
    printf '%q ' "$@"
}

run_as_ci_user() {
    local script_path="$REPO_DIR/scripts/ci/container-entrypoint.sh"
    local -a env_cmd=(
        env
        "HOME=$CI_HOME"
        "USER=$CI_USER"
        "LOGNAME=$CI_USER"
        "CI=true"
        "CI_CONTAINER_PHASE=job"
        "CI_JOB=$CI_JOB"
        "CI_IMAGE_KEY=$CI_IMAGE_KEY"
        "CI_PACKAGE_VERSION=$CI_PACKAGE_VERSION"
        "PACKAGE_VERSION=$CI_PACKAGE_VERSION"
        "CI_DMG_PATH=${CI_DMG_PATH:-}"
        "UPSTREAM_DMG_URL=${UPSTREAM_DMG_URL:-https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg}"
        "UPSTREAM_DMG_PATH=${UPSTREAM_DMG_PATH:-/tmp/codex-upstream-ci/Codex.dmg}"
        "UPSTREAM_DMG_CACHE_HIT=${UPSTREAM_DMG_CACHE_HIT:-}"
        "GITHUB_STEP_SUMMARY=${GITHUB_STEP_SUMMARY:-}"
        "CARGO_HOME=$CI_CARGO_HOME"
        "RUSTUP_HOME=$CI_RUSTUP_HOME"
        "npm_config_cache=$CI_NPM_CACHE"
        "CARGO_TERM_COLOR=${CARGO_TERM_COLOR:-always}"
        "PATH=$CI_CARGO_HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        bash
        "$script_path"
        "$CI_JOB"
    )

    if [ "$CI_HOST_UID" = "0" ]; then
        "${env_cmd[@]}"
    else
        su -s /bin/bash "$CI_USER" -c "$(quote_args "${env_cmd[@]}")"
    fi
}

enter_workspace() {
    cd "$REPO_DIR"
    git config --global --add safe.directory "$REPO_DIR" >/dev/null 2>&1 || true
}

ensure_rust_toolchain() {
    mkdir -p "$CI_CARGO_HOME" "$CI_RUSTUP_HOME"
    if ! command -v rustup >/dev/null 2>&1; then
        info "Installing Rust toolchain with rustup"
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
            | sh -s -- -y --profile minimal --default-toolchain stable
    fi

    rustup toolchain install stable --profile minimal --component rustfmt --component clippy
    rustup default stable
    rustc --version
    cargo --version
}

package_file_or_fail() {
    local pattern="$1"
    local package_file
    package_file="$(find dist -maxdepth 1 -name "$pattern" -print -quit)"
    [ -n "$package_file" ] || error "No package found matching: $pattern"
    printf '%s\n' "$package_file"
}

assert_contains_file() {
    local path="$1"
    local pattern="$2"
    grep -q -- "$pattern" "$path" || error "Expected '$pattern' in $path"
}

assert_not_contains_file() {
    local path="$1"
    local pattern="$2"
    if grep -q -- "$pattern" "$path"; then
        error "Did not expect '$pattern' in $path"
    fi
}

prepare_package_fixture() {
    rm -rf codex-app dist
    tests/fixtures/create-packaged-app-fixture.sh codex-app
}

package_target_dir() {
    local target_dir="/ci-cache/target/$CI_IMAGE_KEY"
    mkdir -p "$target_dir"
    printf '%s\n' "$target_dir"
}

run_core_job() {
    enter_workspace
    ensure_rust_toolchain

    bash -n install.sh
    bash -n scripts/lib/*.sh
    bash -n launcher/start.sh.template
    bash -n scripts/install-deps.sh
    bash -n scripts/build-deb.sh
    bash -n scripts/build-rpm.sh
    bash -n scripts/build-pacman.sh
    bash -n scripts/build-appimage.sh
    bash -n scripts/ci-local.sh
    bash -n scripts/ci/*.sh

    cargo fmt --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo check --workspace --all-targets
    cargo test --workspace --all-targets

    bash scripts/ci/run-node-checks.sh

    bash tests/scripts_smoke.sh

    append_summary "Rust and Smoke Tests" \
        "Shell syntax checks passed." \
        "Rust formatting, clippy, check, and tests passed." \
        "Node syntax checks, Node tests, and script smoke tests passed."
}

run_deb_job() {
    enter_workspace
    ensure_rust_toolchain
    prepare_package_fixture

    local target_dir
    target_dir="$(package_target_dir)"
    CARGO_TARGET_DIR="$target_dir" \
    UPDATER_BINARY_SOURCE="$target_dir/release/codex-update-manager" \
    PACKAGE_VERSION="$CI_PACKAGE_VERSION" \
        ./scripts/build-deb.sh

    local deb_file
    deb_file="$(package_file_or_fail 'codex-desktop_*.deb')"
    dpkg-deb -I "$deb_file"
    dpkg-deb -c "$deb_file" | tee /tmp/deb-contents.txt >/dev/null
    assert_contains_file /tmp/deb-contents.txt './usr/bin/codex-update-manager'
    assert_contains_file /tmp/deb-contents.txt './usr/lib/systemd/user/codex-update-manager.service'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/update-builder/install.sh'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/update-builder/launcher/webview-server.py'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/update-builder/launcher/cli-launch-path.py'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/update-builder/scripts/lib/upstream-dmg-intel.js'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/update-builder/scripts/lib/patch-browser-client-iab-socket-scope.js'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/update-builder/scripts/lib/upstream-dmg-acceptance.js'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/update-builder/scripts/lib/candidate-promotion.py'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/update-builder/scripts/validate-upstream-dmg.js'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh'
    assert_contains_file /tmp/deb-contents.txt './opt/codex-desktop/.codex-linux/cli-launch-path.py'

    rm -rf dist
    CARGO_TARGET_DIR="$target_dir" \
    PACKAGE_WITH_UPDATER=0 \
    PACKAGE_VERSION="$CI_PACKAGE_VERSION" \
        ./scripts/build-deb.sh

    local deb_no_updater_file
    deb_no_updater_file="$(package_file_or_fail 'codex-desktop_*.deb')"
    dpkg-deb -c "$deb_no_updater_file" | tee /tmp/deb-no-updater-contents.txt >/dev/null
    rm -rf /tmp/deb-no-updater-control
    rm -rf /tmp/deb-no-updater-payload
    mkdir -p /tmp/deb-no-updater-control /tmp/deb-no-updater-payload
    dpkg-deb -e "$deb_no_updater_file" /tmp/deb-no-updater-control
    dpkg-deb -x "$deb_no_updater_file" /tmp/deb-no-updater-payload
    assert_not_contains_file /tmp/deb-no-updater-contents.txt './usr/bin/codex-update-manager'
    assert_not_contains_file /tmp/deb-no-updater-contents.txt './usr/lib/systemd/user/codex-update-manager.service'
    assert_not_contains_file /tmp/deb-no-updater-contents.txt './usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy'
    assert_not_contains_file /tmp/deb-no-updater-contents.txt './opt/codex-desktop/update-builder/'
    assert_contains_file /tmp/deb-no-updater-contents.txt './opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh'
    assert_contains_file /tmp/deb-no-updater-contents.txt './opt/codex-desktop/.codex-linux/cli-launch-path.py'
    assert_contains_file /tmp/deb-no-updater-contents.txt './opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh'
    assert_contains_file /tmp/deb-no-updater-payload/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh 'codex_no_updater_cleanup_user_enablement_links'
    assert_contains_file /tmp/deb-no-updater-payload/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh 'default.target.wants'
    assert_contains_file /tmp/deb-no-updater-control/postinst 'codex_no_updater_cleanup_update_manager_service'
    assert_contains_file /tmp/deb-no-updater-control/prerm 'codex_no_updater_cleanup_update_manager_service'
    assert_not_contains_file /tmp/deb-no-updater-control/postinst 'update-builder'
    assert_not_contains_file /tmp/deb-no-updater-control/prerm 'update-builder'

    append_summary "Debian Package Validation" \
        "Built: \`$(basename "$deb_file")\`" \
        "Verified updater binary, user service, update-builder bundle, and packaged runtime helper." \
        "Verified PACKAGE_WITH_UPDATER=0 omits updater artifacts."
}

run_rpm_job() {
    enter_workspace
    ensure_rust_toolchain
    prepare_package_fixture

    local target_dir
    target_dir="$(package_target_dir)"
    CARGO_TARGET_DIR="$target_dir" \
    UPDATER_BINARY_SOURCE="$target_dir/release/codex-update-manager" \
    PACKAGE_VERSION="$CI_PACKAGE_VERSION" \
        ./scripts/build-rpm.sh

    local rpm_file
    rpm_file="$(package_file_or_fail 'codex-desktop-*.rpm')"
    rpm -qip "$rpm_file"
    rpm -qlp "$rpm_file" | tee /tmp/rpm-contents.txt >/dev/null
    assert_contains_file /tmp/rpm-contents.txt '/usr/bin/codex-update-manager'
    assert_contains_file /tmp/rpm-contents.txt '/usr/lib/systemd/user/codex-update-manager.service'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/update-builder/install.sh'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/update-builder/launcher/webview-server.py'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/update-builder/launcher/cli-launch-path.py'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/update-builder/scripts/lib/upstream-dmg-intel.js'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/update-builder/scripts/lib/patch-browser-client-iab-socket-scope.js'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/update-builder/scripts/lib/upstream-dmg-acceptance.js'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/update-builder/scripts/lib/candidate-promotion.py'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/update-builder/scripts/validate-upstream-dmg.js'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh'
    assert_contains_file /tmp/rpm-contents.txt '/opt/codex-desktop/.codex-linux/cli-launch-path.py'

    rm -rf dist
    CARGO_TARGET_DIR="$target_dir" \
    PACKAGE_WITH_UPDATER=0 \
    PACKAGE_VERSION="$CI_PACKAGE_VERSION" \
        ./scripts/build-rpm.sh

    local rpm_no_updater_file
    rpm_no_updater_file="$(package_file_or_fail 'codex-desktop-*.rpm')"
    rpm -qlp "$rpm_no_updater_file" | tee /tmp/rpm-no-updater-contents.txt >/dev/null
    rpm -qp --scripts "$rpm_no_updater_file" | tee /tmp/rpm-no-updater-scripts.txt >/dev/null
    assert_not_contains_file /tmp/rpm-no-updater-contents.txt '/usr/bin/codex-update-manager'
    assert_not_contains_file /tmp/rpm-no-updater-contents.txt '/usr/lib/systemd/user/codex-update-manager.service'
    assert_not_contains_file /tmp/rpm-no-updater-contents.txt '/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy'
    assert_not_contains_file /tmp/rpm-no-updater-contents.txt '/opt/codex-desktop/update-builder/'
    assert_contains_file /tmp/rpm-no-updater-contents.txt '/opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh'
    assert_contains_file /tmp/rpm-no-updater-contents.txt '/opt/codex-desktop/.codex-linux/cli-launch-path.py'
    assert_contains_file /tmp/rpm-no-updater-contents.txt '/opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh'
    assert_contains_file /tmp/rpm-no-updater-scripts.txt 'codex_no_updater_cleanup_update_manager_service'
    assert_not_contains_file /tmp/rpm-no-updater-scripts.txt 'update-builder'
    assert_not_contains_file /tmp/rpm-no-updater-scripts.txt 'codex_ensure_user_service_running'

    append_summary "RPM Package Validation" \
        "Built: \`$(basename "$rpm_file")\`" \
        "Verified updater binary, user service, update-builder bundle, and packaged runtime helper." \
        "Verified PACKAGE_WITH_UPDATER=0 omits updater artifacts."
}

run_pacman_job() {
    enter_workspace
    ensure_rust_toolchain
    prepare_package_fixture

    local target_dir
    target_dir="$(package_target_dir)"
    CARGO_TARGET_DIR="$target_dir" cargo build --release -p codex-update-manager
    CARGO_TARGET_DIR="$target_dir" \
    UPDATER_BINARY_SOURCE="$target_dir/release/codex-update-manager" \
    PACKAGE_VERSION="$CI_PACKAGE_VERSION" \
        ./scripts/build-pacman.sh

    local pkg_file
    pkg_file="$(package_file_or_fail 'codex-desktop-*.pkg.tar.*')"
    pacman -Qip "$pkg_file"
    pacman -Qlp "$pkg_file" | tee /tmp/pacman-contents.txt >/dev/null
    assert_contains_file /tmp/pacman-contents.txt 'usr/bin/codex-update-manager'
    assert_contains_file /tmp/pacman-contents.txt 'usr/lib/systemd/user/codex-update-manager.service'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/update-builder/install.sh'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/update-builder/launcher/webview-server.py'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/update-builder/launcher/cli-launch-path.py'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/update-builder/scripts/lib/upstream-dmg-intel.js'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/update-builder/scripts/lib/patch-browser-client-iab-socket-scope.js'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/update-builder/scripts/lib/upstream-dmg-acceptance.js'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/update-builder/scripts/lib/candidate-promotion.py'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/update-builder/scripts/validate-upstream-dmg.js'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh'
    assert_contains_file /tmp/pacman-contents.txt 'opt/codex-desktop/.codex-linux/cli-launch-path.py'

    rm -rf dist
    CARGO_TARGET_DIR="$target_dir" \
    PACKAGE_WITH_UPDATER=0 \
    PACKAGE_VERSION="$CI_PACKAGE_VERSION" \
        ./scripts/build-pacman.sh

    local pkg_no_updater_file
    pkg_no_updater_file="$(package_file_or_fail 'codex-desktop-*.pkg.tar.*')"
    pacman -Qlp "$pkg_no_updater_file" | tee /tmp/pacman-no-updater-contents.txt >/dev/null
    tar -xOf "$pkg_no_updater_file" .INSTALL | tee /tmp/pacman-no-updater-install.txt >/dev/null
    tar -xOf "$pkg_no_updater_file" opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh | tee /tmp/pacman-no-updater-cleanup.txt >/dev/null
    assert_not_contains_file /tmp/pacman-no-updater-contents.txt 'usr/bin/codex-update-manager'
    assert_not_contains_file /tmp/pacman-no-updater-contents.txt 'usr/lib/systemd/user/codex-update-manager.service'
    assert_not_contains_file /tmp/pacman-no-updater-contents.txt 'usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy'
    assert_not_contains_file /tmp/pacman-no-updater-contents.txt 'opt/codex-desktop/update-builder/'
    assert_contains_file /tmp/pacman-no-updater-contents.txt 'opt/codex-desktop/.codex-linux/codex-packaged-runtime.sh'
    assert_contains_file /tmp/pacman-no-updater-contents.txt 'opt/codex-desktop/.codex-linux/cli-launch-path.py'
    assert_contains_file /tmp/pacman-no-updater-contents.txt 'opt/codex-desktop/.codex-linux/codex-no-updater-transition-cleanup.sh'
    assert_contains_file /tmp/pacman-no-updater-cleanup.txt 'codex_no_updater_cleanup_user_enablement_links'
    assert_contains_file /tmp/pacman-no-updater-cleanup.txt 'default.target.wants'
    assert_contains_file /tmp/pacman-no-updater-install.txt 'codex_no_updater_cleanup_update_manager_service'
    assert_contains_file /tmp/pacman-no-updater-install.txt 'post_upgrade'
    assert_contains_file /tmp/pacman-no-updater-install.txt 'pre_remove'
    assert_not_contains_file /tmp/pacman-no-updater-install.txt 'update-builder'

    append_summary "Pacman Package Validation" \
        "Built: \`$(basename "$pkg_file")\`" \
        "Verified updater binary, user service, update-builder bundle, and packaged runtime helper." \
        "Verified PACKAGE_WITH_UPDATER=0 omits updater artifacts."
}

run_install_deps_job_as_root() {
    enter_workspace

    bash scripts/install-deps.sh
    export PATH="$HOME/.local/bin:$PATH"

    node -p "process.versions.node"
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'
    npm -v
    npx -v
    dpkg-query -W -f='${Provides}\n' nodejs | grep -E '(^|[,[:space:]])npm([,[:space:](]|$)'

    local output
    local status
    output="$(./install.sh /tmp/nope.dmg 2>&1)" && status=0 || status=$?
    printf '%s\n' "$output"
    [ "$status" -ne 0 ] || error "Installer should fail for a missing DMG"
    printf '%s\n' "$output" | grep -q "Provided DMG not found: /tmp/nope.dmg"
    if printf '%s\n' "$output" | grep -q "Node.js 20+ required"; then
        error "Installer still failed Node preflight after install-deps"
    fi

    append_summary "Install Dependencies Validation" \
        "Image: \`$CI_IMAGE_KEY\`" \
        "Node.js, npm, npx, and installer preflight passed."
}

capture_upstream_metadata() {
    local dmg_path="$1"
    local headers_file
    headers_file="$(mktemp)"

    local last_modified="unknown"
    local etag="no-etag"
    local content_length="unknown"
    if curl -fsSLI "$UPSTREAM_DMG_URL" > "$headers_file"; then
        # Match header names case-insensitively without gawk's IGNORECASE,
        # which is a no-op under mawk (the default awk in the CI containers).
        last_modified="$(awk 'tolower($0) ~ /^last-modified:/ {sub(/\r$/,""); sub(/^[^:]+: /,""); print; exit}' "$headers_file")"
        etag="$(awk 'tolower($0) ~ /^etag:/ {sub(/\r$/,""); sub(/^[^:]+: /,""); gsub(/"/,""); print; exit}' "$headers_file")"
        content_length="$(awk 'tolower($0) ~ /^content-length:/ {sub(/\r$/,""); sub(/^[^:]+: /,""); print; exit}' "$headers_file")"
    fi
    rm -f "$headers_file"

    [ -n "$last_modified" ] || last_modified="unknown"
    [ -n "$etag" ] || etag="no-etag"
    [ -n "$content_length" ] || content_length="unknown"

    local dmg_sha256
    local dmg_size_bytes
    local tested_at_utc
    dmg_sha256="$(sha256sum "$dmg_path" | cut -d' ' -f1)"
    dmg_size_bytes="$(stat -c '%s' "$dmg_path")"
    tested_at_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

    node - "$UPSTREAM_DMG_URL" "$dmg_path" "$last_modified" "$etag" "$content_length" "$dmg_sha256" "$dmg_size_bytes" "$tested_at_utc" "${UPSTREAM_DMG_CACHE_HIT:-unknown}" <<'NODE'
const fs = require("node:fs");
const [url, path, lastModified, etag, contentLength, sha256, sizeBytes, testedAtUtc, cacheHit] = process.argv.slice(2);
const metadata = {
  url,
  path,
  last_modified: lastModified,
  etag,
  content_length: contentLength,
  sha256,
  size_bytes: Number(sizeBytes),
  tested_at_utc: testedAtUtc,
  cache_hit: cacheHit,
};
fs.writeFileSync("upstream-dmg-metadata.json", JSON.stringify(metadata, null, 2) + "\n");
NODE

    append_summary "Upstream Build App" \
        "DMG URL: \`$UPSTREAM_DMG_URL\`" \
        "DMG Last-Modified: \`$last_modified\`" \
        "DMG ETag: \`$etag\`" \
        "DMG Content-Length: \`$content_length\`" \
        "DMG SHA-256: \`$dmg_sha256\`" \
        "DMG Size (bytes): \`$dmg_size_bytes\`" \
        "Tested At (UTC): \`$tested_at_utc\`" \
        "Cache Hit: \`${UPSTREAM_DMG_CACHE_HIT:-unknown}\`" \
        "Build command: \`make build-app DMG=$dmg_path\`"
}

run_upstream_job() {
    enter_workspace
    ensure_rust_toolchain

    local dmg_path="${CI_DMG_PATH:-${UPSTREAM_DMG_PATH:-/tmp/codex-upstream-ci/Codex.dmg}}"
    mkdir -p "$(dirname "$dmg_path")"

    if [ ! -s "$dmg_path" ]; then
        info "Downloading upstream DMG"
        curl -fL --retry 3 -o "$dmg_path" "$UPSTREAM_DMG_URL"
    else
        info "Using cached upstream DMG: $dmg_path"
    fi

    capture_upstream_metadata "$dmg_path"
    make build-app DMG="$dmg_path"
}

run_nix_job_as_root() {
    enter_workspace
    export NIX_CONFIG="${NIX_CONFIG:-experimental-features = nix-command flakes}"

    nix flake check --no-write-lock-file --option sandbox false
    nix build .#codex-desktop --no-link --print-build-logs --option sandbox false
    nix build .#installer --no-link --print-build-logs --option sandbox false

    append_summary "Nix Validation" \
        "Flake check passed." \
        "Built the Nix checks, .#codex-desktop, and .#installer without result links."
}

run_job_as_current_user() {
    case "$CI_JOB" in
        core) run_core_job ;;
        deb) run_deb_job ;;
        rpm) run_rpm_job ;;
        pacman) run_pacman_job ;;
        upstream) run_upstream_job ;;
        *) error "Unsupported user-phase job: $CI_JOB" ;;
    esac
}

if [ -z "$CI_JOB" ]; then
    error "Missing CI job name"
fi

if [ "${CI_CONTAINER_PHASE:-root}" = "job" ]; then
    run_job_as_current_user
    exit 0
fi

case "$CI_JOB" in
    core|deb|upstream)
        prepare_apt_ci
        ensure_ci_user
        run_as_ci_user
        ;;
    rpm)
        prepare_fedora_ci
        ensure_ci_user
        run_as_ci_user
        ;;
    pacman)
        prepare_arch_ci
        ensure_ci_user
        run_as_ci_user
        ;;
    install-deps)
        prepare_apt_install_deps
        run_install_deps_job_as_root
        ;;
    nix)
        run_nix_job_as_root
        ;;
    *)
        error "Unsupported CI job: $CI_JOB"
        ;;
esac
