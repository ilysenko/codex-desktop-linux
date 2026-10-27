#!/bin/bash
# Resolve, validate, and extract the official OpenAI Linux package.
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

map_upstream_architecture() {
    case "${1:-$(uname -m)}" in
        x86_64|amd64) printf '%s\n' amd64 ;;
        aarch64|arm64) printf '%s\n' arm64 ;;
        *) error "Unsupported architecture '${1:-$(uname -m)}'; official packages support amd64 and arm64 only" ;;
    esac
}

resolve_upstream_linux_package() {
    local metadata_path="$1"
    local architecture
    local -a verifier_args=()
    architecture="$(map_upstream_architecture "$ARCH")"

    if [ -n "$PROVIDED_UPSTREAM_DEB_PATH" ]; then
        [ -f "$PROVIDED_UPSTREAM_DEB_PATH" ] || error "Provided upstream package not found: $PROVIDED_UPSTREAM_DEB_PATH"
        UPSTREAM_DEB_PATH="$(realpath "$PROVIDED_UPSTREAM_DEB_PATH")"
        info "Using explicitly provided upstream Linux package: $UPSTREAM_DEB_PATH"
        validate_upstream_linux_package "$UPSTREAM_DEB_PATH" "$architecture"
        if [ "${SKIP_OAI_OFFICIAL_SIG_VERIFICATION:-0}" -eq 1 ]; then
            warn "Skipping OpenAI official signed-repository verification for this local package for this build"
            write_local_upstream_metadata "$metadata_path" "$UPSTREAM_DEB_PATH" "$architecture"
            return 0
        fi
        verifier_args=(--local-package "$UPSTREAM_DEB_PATH")
    fi

    info "Resolving official chatgpt/$architecture from signed stable APT metadata"
    UPSTREAM_DEB_PATH="$(
        node "$SCRIPT_DIR/scripts/lib/upstream-linux-package.js" \
            --output-dir "$WORK_DIR/upstream-download" \
            --metadata "$metadata_path" \
            --key-base64 "$SCRIPT_DIR/assets/openai-codex-linux-repository-key.gpg.base64" \
            --arch "$architecture" \
            --repository "${CODEX_UPSTREAM_LINUX_REPOSITORY:-https://persistent.oaistatic.com/codex-app-prod/linux/deb}" \
            "${verifier_args[@]}"
    )"
    validate_upstream_linux_package "$UPSTREAM_DEB_PATH" "$architecture"
}

validate_upstream_linux_package() {
    local package_path="$1"
    local expected_architecture="$2"
    local package_name
    local package_version
    local package_architecture

    package_name="$(dpkg-deb -f "$package_path" Package 2>/dev/null || true)"
    package_version="$(dpkg-deb -f "$package_path" Version 2>/dev/null || true)"
    package_architecture="$(dpkg-deb -f "$package_path" Architecture 2>/dev/null || true)"

    [ "$package_name" = "chatgpt" ] || error "Upstream package name must be 'chatgpt', got '${package_name:-missing}'"
    [[ "$package_version" =~ ^[0-9][0-9A-Za-z.+:~-]*$ ]] || error "Upstream package has invalid version '${package_version:-missing}'"
    [ "$package_architecture" = "$expected_architecture" ] || \
        error "Upstream package architecture is '$package_architecture', expected '$expected_architecture'"
}

write_local_upstream_metadata() {
    local metadata_path="$1"
    local package_path="$2"
    local architecture="$3"
    node - "$metadata_path" "$package_path" "$architecture" <<'NODE'
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [metadataPath, packagePath, architecture] = process.argv.slice(2);
const field = (name) => childProcess.execFileSync("dpkg-deb", ["-f", packagePath, name], { encoding: "utf8" }).trim();
const bytes = fs.readFileSync(packagePath);
const metadata = {
  package: "chatgpt",
  version: field("Version"),
  architecture,
  repository: null,
  repositoryPath: null,
  path: path.resolve(packagePath),
  sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  depends: field("Depends"),
  explicitlyProvided: true,
  signatureVerification: "skipped",
};
fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
NODE
}

extract_upstream_linux_package() {
    local package_path="$1"
    local extraction_root="$WORK_DIR/upstream-package"
    local upstream_app_dir="$extraction_root/usr/lib/chatgpt"

    mkdir -p "$extraction_root"
    dpkg-deb -x "$package_path" "$extraction_root"

    [ -x "$upstream_app_dir/ChatGPT" ] || error "Official package payload is missing executable /usr/lib/chatgpt/ChatGPT"
    [ -f "$upstream_app_dir/resources/app.asar" ] || error "Official package payload is missing resources/app.asar"
    [ -x "$upstream_app_dir/resources/codex" ] || error "Official package payload is missing bundled codex"
    [ -x "$upstream_app_dir/resources/rg" ] || error "Official package payload is missing bundled rg"
    [ -x "$upstream_app_dir/resources/codex-code-mode-host" ] || error "Official package payload is missing code-mode host"
    [ -f "$upstream_app_dir/resources/owl-electron-app.json" ] || error "Official package payload is missing Owl application metadata"
    [ -f "$upstream_app_dir/resources/owl-app.ini" ] || error "Official package payload is missing Owl profile metadata"

    UPSTREAM_PACKAGE_ROOT="$extraction_root"
    UPSTREAM_APP_DIR="$upstream_app_dir"
    export UPSTREAM_PACKAGE_ROOT UPSTREAM_APP_DIR
}

stage_official_linux_payload() {
    local upstream_app_dir="$1"
    mkdir -p "$INSTALL_DIR"
    cp -a "$upstream_app_dir/." "$INSTALL_DIR/"

    mkdir -p "$INSTALL_DIR/.codex-linux/upstream-package"
    if [ -f "$UPSTREAM_PACKAGE_ROOT/usr/share/applications/chatgpt.desktop" ]; then
        cp "$UPSTREAM_PACKAGE_ROOT/usr/share/applications/chatgpt.desktop" \
            "$INSTALL_DIR/.codex-linux/upstream-package/chatgpt.desktop"
    fi
    if [ -f "$UPSTREAM_PACKAGE_ROOT/etc/apparmor.d/chatgpt" ]; then
        cp "$UPSTREAM_PACKAGE_ROOT/etc/apparmor.d/chatgpt" \
            "$INSTALL_DIR/.codex-linux/upstream-package/chatgpt.apparmor"
    fi
    dpkg-deb -f "$UPSTREAM_DEB_PATH" > "$INSTALL_DIR/.codex-linux/upstream-package/control"
}
