#!/bin/bash
# Managed Node.js runtime used by the installer, launcher, and update builder.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

MANAGED_NODE_VERSION="${CODEX_MANAGED_NODE_VERSION:-v22.22.2}"
case "$MANAGED_NODE_VERSION" in
    v*) ;;
    *) MANAGED_NODE_VERSION="v$MANAGED_NODE_VERSION" ;;
esac
MANAGED_NODE_MIN_VERSION="22.22.0"
MANAGED_NODE_MIN_MAJOR=22
MANAGED_NODE_MIN_MINOR=22
MANAGED_NODE_MIN_PATCH=0

managed_node_arch() {
    case "$ARCH" in
        x86_64)  echo "x64" ;;
        aarch64) echo "arm64" ;;
        armv7l)  echo "armv7l" ;;
        *)       error "Unsupported Node.js runtime architecture: $ARCH" ;;
    esac
}

managed_node_archive_sha256() {
    local node_arch="$1"

    if [ -n "${CODEX_MANAGED_NODE_SHA256:-}" ]; then
        echo "$CODEX_MANAGED_NODE_SHA256"
        return
    fi

    case "$MANAGED_NODE_VERSION:$node_arch" in
        v22.22.2:x64)   echo "88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a" ;;
        v22.22.2:arm64) echo "e9e1930fd321a470e29bb68f30318bf58e3ecb4acb4f1533fb19c58328a091fe" ;;
        v22.22.2:armv7l) echo "2ebc6746e517f345da340ec76a108203eb6c2365391eb525c0e0dd6135b0b9df" ;;
        *)
            error "No SHA256 configured for Node.js $MANAGED_NODE_VERSION linux-$node_arch.
Set CODEX_MANAGED_NODE_SHA256 when overriding CODEX_MANAGED_NODE_VERSION or CODEX_MANAGED_NODE_URL."
            ;;
    esac
}

node_version_parts() {
    local node_path="$1"
    local probe
    local version
    local major
    local minor
    local patch

    [ -x "$node_path" ] || return 1
    probe="$("$node_path" -e 'process.stdout.write("codex-node-runtime-ok:" + process.versions.node)' 2>/dev/null)" || return 1
    case "$probe" in
        codex-node-runtime-ok:*) version="${probe#codex-node-runtime-ok:}" ;;
        *) return 1 ;;
    esac

    major="$version"
    minor="${major#*.}"
    patch="${minor#*.}"
    major="${major%%.*}"
    minor="${minor%%.*}"
    patch="${patch%%.*}"

    case "$major" in ""|*[!0-9]*) return 1 ;; esac
    case "$minor" in ""|*[!0-9]*) return 1 ;; esac
    case "$patch" in ""|*[!0-9]*) return 1 ;; esac

    echo "$major $minor $patch"
}

node_runtime_compatible() {
    local node_path="$1"
    local parts
    local major
    local minor
    local patch

    parts="$(node_version_parts "$node_path" 2>/dev/null || true)"
    [ -n "$parts" ] || return 1
    read -r major minor patch <<< "$parts"
    if [ "$major" -gt "$MANAGED_NODE_MIN_MAJOR" ]; then
        return 0
    fi
    if [ "$major" -lt "$MANAGED_NODE_MIN_MAJOR" ]; then
        return 1
    fi
    if [ "$minor" -gt "$MANAGED_NODE_MIN_MINOR" ]; then
        return 0
    fi
    if [ "$minor" -lt "$MANAGED_NODE_MIN_MINOR" ]; then
        return 1
    fi
    [ "$patch" -ge "$MANAGED_NODE_MIN_PATCH" ]
}

node_toolchain_compatible() {
    local runtime_dir="$1"

    node_runtime_compatible "$runtime_dir/bin/node" \
        && [ -x "$runtime_dir/bin/npm" ] \
        && [ -x "$runtime_dir/bin/npx" ]
}

copy_node_runtime() {
    local source_dir="$1"
    local destination_dir="$2"
    local tmp_dir

    node_toolchain_compatible "$source_dir" || return 1

    if [ "$(realpath -m "$source_dir")" = "$(realpath -m "$destination_dir")" ]; then
        return 0
    fi

    tmp_dir="$(dirname "$destination_dir")/.node-runtime.tmp.$$"
    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"
    cp -a "$source_dir/." "$tmp_dir/"
    rm -rf "$destination_dir"
    mv "$tmp_dir" "$destination_dir"
}

managed_node_archive_url() {
    local node_arch="$1"

    if [ -n "${CODEX_MANAGED_NODE_URL:-}" ]; then
        echo "$CODEX_MANAGED_NODE_URL"
    else
        echo "https://nodejs.org/dist/$MANAGED_NODE_VERSION/node-$MANAGED_NODE_VERSION-linux-$node_arch.tar.xz"
    fi
}

download_managed_node_runtime() {
    local destination_dir="$1"
    local node_arch
    local url
    local expected_sha
    local cache_dir
    local archive
    local extract_dir
    local extracted_root

    node_arch="$(managed_node_arch)"
    url="$(managed_node_archive_url "$node_arch")"
    expected_sha="$(managed_node_archive_sha256 "$node_arch")"
    cache_dir="${CODEX_MANAGED_NODE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop/node-runtime}"
    archive="$cache_dir/$(basename "$url")"
    extract_dir="$WORK_DIR/managed-node-runtime"
    extracted_root="$extract_dir/node-$MANAGED_NODE_VERSION-linux-$node_arch"

    mkdir -p "$cache_dir" "$extract_dir"
    if [ ! -f "$archive" ]; then
        info "Downloading managed Node.js $MANAGED_NODE_VERSION runtime..."
        if ! curl -L --fail --progress-bar -o "$archive.part" "$url"; then
            rm -f "$archive.part"
            error "Failed to download managed Node.js runtime from $url"
        fi
        mv "$archive.part" "$archive"
    else
        info "Using cached managed Node.js runtime: $archive"
    fi

    if ! printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c - >/dev/null 2>&1; then
        rm -f "$archive"
        error "Managed Node.js runtime checksum mismatch; removed cached archive"
    fi

    rm -rf "$extract_dir"
    mkdir -p "$extract_dir"
    tar -xJf "$archive" -C "$extract_dir"
    [ -d "$extracted_root" ] || error "Managed Node.js archive did not contain expected directory: node-$MANAGED_NODE_VERSION-linux-$node_arch"
    copy_node_runtime "$extracted_root" "$destination_dir" || error "Managed Node.js runtime is not compatible"
}

ensure_managed_node_runtime() {
    local destination_dir="$1"
    local source_dir

    if node_toolchain_compatible "$destination_dir"; then
        info "Managed Node.js runtime ready: $destination_dir"
        export_managed_node_runtime "$destination_dir"
        return 0
    fi

    for source_dir in \
        "${CODEX_MANAGED_NODE_SOURCE:-}" \
        "$SCRIPT_DIR/node-runtime" \
        "$SCRIPT_DIR/resources/node-runtime" \
        "$SCRIPT_DIR/../node-runtime"
    do
        [ -n "$source_dir" ] || continue
        if copy_node_runtime "$source_dir" "$destination_dir"; then
            info "Managed Node.js runtime copied from $source_dir"
            export_managed_node_runtime "$destination_dir"
            return 0
        fi
    done

    download_managed_node_runtime "$destination_dir"
    export_managed_node_runtime "$destination_dir"
    info "Managed Node.js runtime ready: $destination_dir"
}

export_managed_node_runtime() {
    local runtime_dir="$1"
    local bin_dir="$runtime_dir/bin"

    [ -x "$bin_dir/node" ] || error "Managed Node.js runtime is missing node: $bin_dir/node"
    export PATH="$bin_dir:$PATH"
    export CODEX_MANAGED_NODE_RUNTIME_DIR="$runtime_dir"
}
