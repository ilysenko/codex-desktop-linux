#!/bin/bash
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
UPSTREAM_JSON="$REPO_DIR/packaging/flatpak/upstream.json"
APP_ID=$(python3 - "$UPSTREAM_JSON" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["appId"])
PY
)
APP_VERSION=$(python3 - "$UPSTREAM_JSON" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["codexVersion"])
PY
)
RUNTIME_VERSION=$(python3 - "$UPSTREAM_JSON" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["runtimeVersion"])
PY
)
BUILD_ROOT=${FLATPAK_BUILD_ROOT:-$REPO_DIR/dist/flatpak-build}
REPO_ROOT=${FLATPAK_REPO_ROOT:-$REPO_DIR/dist/flatpak-repo}
BUNDLE_PATH=${FLATPAK_BUNDLE_PATH:-$REPO_DIR/dist/${APP_ID}-${APP_VERSION}.flatpak}
MANIFEST_PATH=${FLATPAK_MANIFEST_PATH:-$REPO_DIR/dist/flatpak/${APP_ID}.json}
SOURCE_ARCHIVE=${FLATPAK_SOURCE_ARCHIVE:-$REPO_DIR/dist/flatpak/${APP_ID}-source.tar.gz}
FLATPAK_STATE_DIR=${FLATPAK_STATE_DIR:-$REPO_DIR/.flatpak-builder}
FLATPAK_DEPS_REMOTE=${FLATPAK_DEPS_REMOTE:-flathub}
FLATPAK_INSTALL_DEPS=${FLATPAK_INSTALL_DEPS:-1}
FLATPAK_DEP_INSTALL_RETRIES=${FLATPAK_DEP_INSTALL_RETRIES:-4}
FLATPAK_DISABLE_ROFILES_FUSE=${FLATPAK_DISABLE_ROFILES_FUSE:-1}
FLATPAK_DEFAULT_BRANCH=${FLATPAK_DEFAULT_BRANCH:-stable}
FLATPAK_SKIP_BUNDLE=${FLATPAK_SKIP_BUNDLE:-0}

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "Missing required command: $1" >&2
        exit 1
    }
}

is_truthy() {
    case "$1" in
        0|false|False|FALSE|no|No|NO|off|Off|OFF)
            return 1
            ;;
        *)
            return 0
            ;;
    esac
}

install_flatpak_ref_with_retries() {
    local ref="$1"
    local attempt=1

    while [ "$attempt" -le "$FLATPAK_DEP_INSTALL_RETRIES" ]; do
        echo "Installing Flatpak dependency ($attempt/$FLATPAK_DEP_INSTALL_RETRIES): $ref"
        if flatpak --user install -y --noninteractive --or-update --no-related --no-static-deltas "$FLATPAK_DEPS_REMOTE" "$ref"; then
            return 0
        fi
        if [ "$attempt" -eq "$FLATPAK_DEP_INSTALL_RETRIES" ]; then
            echo "Flatpak dependency install failed after $attempt attempts: $ref" >&2
            return 1
        fi
        attempt=$((attempt + 1))
        sleep 5
    done
}

prepare_manifest() {
    local local_dmg_env=""

    mkdir -p \
        "$(dirname "$MANIFEST_PATH")" \
        "$(dirname "$SOURCE_ARCHIVE")" \
        "$BUILD_ROOT" \
        "$REPO_ROOT" \
        "$FLATPAK_STATE_DIR" \
        "$(dirname "$BUNDLE_PATH")"

    rm -f "$SOURCE_ARCHIVE"
    (
        cd "$REPO_DIR"
        tar \
            --exclude='.git' \
            --exclude='./codex-app' \
            --exclude='./codex-app-next' \
            --exclude='./codex-*-app' \
            --exclude='./dist' \
            --exclude='./dist-next' \
            --exclude='./target' \
            --exclude='./Codex.dmg' \
            --exclude='./linux-features/features.json' \
            --exclude='./linux-features/local' \
            -czf "$SOURCE_ARCHIVE" .
    )

    if [ -f "$REPO_DIR/Codex.dmg" ]; then
        local_dmg_env="CODEX_FLATPAK_LOCAL_DMG_PATH=$REPO_DIR/Codex.dmg"
    fi

    if [ -n "$local_dmg_env" ]; then
        env \
            CODEX_FLATPAK_SOURCE_KIND=archive \
            CODEX_FLATPAK_SOURCE_ARCHIVE_PATH="$SOURCE_ARCHIVE" \
            "$local_dmg_env" \
            node "$REPO_DIR/packaging/flatpak/render-manifest.mjs" --output "$MANIFEST_PATH"
    else
        env \
            CODEX_FLATPAK_SOURCE_KIND=archive \
            CODEX_FLATPAK_SOURCE_ARCHIVE_PATH="$SOURCE_ARCHIVE" \
            node "$REPO_DIR/packaging/flatpak/render-manifest.mjs" --output "$MANIFEST_PATH"
    fi

    if command -v git >/dev/null 2>&1 && git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        export CODEX_LINUX_SOURCE_COMMIT
        export CODEX_LINUX_SOURCE_BRANCH
        export CODEX_LINUX_SOURCE_REMOTE
        export CODEX_LINUX_SOURCE_DESCRIBE
        CODEX_LINUX_SOURCE_COMMIT=$(git -C "$REPO_DIR" rev-parse HEAD)
        CODEX_LINUX_SOURCE_BRANCH=$(git -C "$REPO_DIR" branch --show-current || true)
        CODEX_LINUX_SOURCE_REMOTE=$(git -C "$REPO_DIR" remote get-url origin || true)
        CODEX_LINUX_SOURCE_DESCRIBE=$(git -C "$REPO_DIR" describe --always --dirty --tags || true)
    fi
}

validate_static_inputs() {
    for required in \
        "$REPO_DIR/packaging/flatpak/asar/package-lock.json" \
        "$REPO_DIR/packaging/flatpak/codex-cli/package-lock.json" \
        "$REPO_DIR/packaging/flatpak/native-modules/package-lock.json" \
        "$REPO_DIR/packaging/flatpak/tools/package-lock.json" \
        "$REPO_DIR/packaging/flatpak/asar-sources.json" \
        "$REPO_DIR/packaging/flatpak/codex-cli-sources.json" \
        "$REPO_DIR/packaging/flatpak/native-modules-sources.json" \
        "$REPO_DIR/packaging/flatpak/tools-sources.json" \
        "$REPO_DIR/packaging/flatpak/dugite-native-sources.json"
    do
        [ -f "$required" ] || {
            echo "Missing generated Flatpak source file: $required" >&2
            echo "Run: bash scripts/flatpak/refresh-generated-sources.sh" >&2
            exit 1
        }
    done

    if ! flatpak remotes --columns=name 2>/dev/null | tail -n +1 | grep -Fx "$FLATPAK_DEPS_REMOTE" >/dev/null 2>&1; then
        echo "Missing Flatpak remote: $FLATPAK_DEPS_REMOTE" >&2
        echo "Add it with: flatpak remote-add --if-not-exists $FLATPAK_DEPS_REMOTE https://flathub.org/repo/flathub.flatpakrepo" >&2
        exit 1
    fi

    if command -v appstreamcli >/dev/null 2>&1; then
        appstreamcli validate "$REPO_DIR/packaging/flatpak/${APP_ID}.metainfo.xml"
    fi
}

install_deps() {
    if ! is_truthy "$FLATPAK_INSTALL_DEPS"; then
        return 0
    fi

    install_flatpak_ref_with_retries "org.freedesktop.Platform//${RUNTIME_VERSION}"
    install_flatpak_ref_with_retries "org.freedesktop.Sdk//${RUNTIME_VERSION}"
    install_flatpak_ref_with_retries "org.electronjs.Electron2.BaseApp//${RUNTIME_VERSION}"
}

build_with_builder() {
    local builder_args=(
        --force-clean
        --user
        --repo="$REPO_ROOT"
        --state-dir="$FLATPAK_STATE_DIR"
        --default-branch="$FLATPAK_DEFAULT_BRANCH"
    )

    if is_truthy "$FLATPAK_DISABLE_ROFILES_FUSE"; then
        builder_args+=(--disable-rofiles-fuse)
    fi

    flatpak-builder \
        "${builder_args[@]}" \
        "$BUILD_ROOT" \
        "$MANIFEST_PATH"
}

export_bundle() {
    rm -f "$BUNDLE_PATH"
    flatpak build-update-repo "$REPO_ROOT"
    flatpak build-bundle "$REPO_ROOT" "$BUNDLE_PATH" "$APP_ID" "$FLATPAK_DEFAULT_BRANCH"
}

print_debug_repo_hint() {
    echo "Manifest: $MANIFEST_PATH"
    echo "Repository: $REPO_ROOT"
    echo "Bundle: skipped (FLATPAK_SKIP_BUNDLE=$FLATPAK_SKIP_BUNDLE)"
    echo "Debug install:"
    echo "  flatpak remote-add --user --if-not-exists --no-gpg-verify codex-debug file://$REPO_ROOT"
    echo "  flatpak install --user --or-update codex-debug ${APP_ID}//${FLATPAK_DEFAULT_BRANCH}"
    echo "  flatpak run $APP_ID"
}

main() {
    require_cmd flatpak
    require_cmd flatpak-builder
    require_cmd tar
    require_cmd python3
    require_cmd node

    if [ "${FLATPAK_BUILD_STRATEGY:-builder}" != "builder" ]; then
        echo "Unsupported FLATPAK_BUILD_STRATEGY: ${FLATPAK_BUILD_STRATEGY}" >&2
        echo "The local-export fallback has been removed; Flatpak builds must run through flatpak-builder." >&2
        exit 1
    fi

    validate_static_inputs
    prepare_manifest
    install_deps

    build_with_builder
    if is_truthy "$FLATPAK_SKIP_BUNDLE"; then
        rm -f "$BUNDLE_PATH"
        print_debug_repo_hint
    else
        export_bundle
    fi

    echo "Manifest: $MANIFEST_PATH"
    echo "Repository: $REPO_ROOT"
    echo "Bundle: $BUNDLE_PATH"
}

main "$@"
