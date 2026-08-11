#!/bin/bash
# Official OpenAI Linux package download, extraction, and runtime staging.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

official_linux_deb_arch() {
    case "$ARCH" in
        x86_64) printf '%s\n' "amd64" ;;
        aarch64) printf '%s\n' "arm64" ;;
        *) error "Unsupported architecture for the official Linux package: $ARCH" ;;
    esac
}

OFFICIAL_LINUX_DEB_ARCH="$(official_linux_deb_arch)"
DEFAULT_UPSTREAM_ARTIFACT_URL="https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_${OFFICIAL_LINUX_DEB_ARCH}.deb"
UPSTREAM_ARTIFACT_URL="${CODEX_UPSTREAM_ARTIFACT_URL:-$DEFAULT_UPSTREAM_ARTIFACT_URL}"
UPSTREAM_ARTIFACT_REMOTE_FINGERPRINT=""

redact_upstream_artifact_url() {
    local artifact_url="$1"
    local scheme="${artifact_url%%://*}"
    local remainder="${artifact_url#*://}"
    local authority="${remainder%%[/?#]*}"
    local path=""

    if [ "$remainder" != "$authority" ]; then
        path="${remainder#"$authority"}"
    fi
    if [[ "$authority" == *@* ]]; then
        authority="redacted@${authority##*@}"
    fi
    if [[ "$path" == *\?* ]]; then
        path="${path%%\?*}?REDACTED"
    elif [[ "$path" == *\#* ]]; then
        path="${path%%\#*}#REDACTED"
    fi
    printf '%s://%s%s\n' "$scheme" "$authority" "$path"
}

validate_upstream_artifact_url() {
    case "$1" in
        https://*) ;;
        "") error "Upstream Linux package URL must not be empty" ;;
        *) error "Upstream Linux package URL must use HTTPS: $(redact_upstream_artifact_url "$1")" ;;
    esac
}

upstream_artifact_url_cache_key() {
    printf '%s' "$1" | sha256sum | awk '{print $1}'
}

cached_upstream_artifact_metadata_url_sha256() {
    awk -F= '$1 == "url_sha256" { print $2; exit }' "$1" 2>/dev/null || true
}

cached_upstream_artifact_metadata_matches_url() {
    local metadata_path="$1"
    local artifact_url="$2"
    [ -s "$metadata_path" ] || return 1
    [ "$(cached_upstream_artifact_metadata_url_sha256 "$metadata_path")" = \
      "$(upstream_artifact_url_cache_key "$artifact_url")" ]
}

fetch_upstream_artifact_remote_fingerprint() {
    local artifact_url="$1"
    local headers_file="$WORK_DIR/upstream-artifact-headers.txt"
    local url_sha256
    url_sha256="$(upstream_artifact_url_cache_key "$artifact_url")"

    if ! curl -fsSLI --max-time 10 --connect-timeout 5 -- "$artifact_url" >"$headers_file"; then
        return 1
    fi

    awk -v url_sha256="$url_sha256" '
        {
            line = $0
            sub(/\r$/, "", line)
            key = line
            sub(/:.*/, "", key)
            key = tolower(key)
            value = line
            sub(/^[^:]+:[[:space:]]*/, "", value)
        }
        key ~ /^http\// { etag = ""; last_modified = ""; content_length = ""; next }
        key == "etag" { etag = value; next }
        key == "last-modified" { last_modified = value; next }
        key == "content-length" { content_length = value; next }
        END {
            if (etag == "" && last_modified == "" && content_length == "") exit 1
            print "url_sha256=" url_sha256
            print "etag=" etag
            print "last_modified=" last_modified
            print "content_length=" content_length
        }
    ' "$headers_file"
}

cached_upstream_artifact_is_fresh() {
    local metadata_path="$1"
    local artifact_url="$2"
    local remote_fingerprint

    if ! remote_fingerprint="$(fetch_upstream_artifact_remote_fingerprint "$artifact_url")"; then
        if cached_upstream_artifact_metadata_matches_url "$metadata_path" "$artifact_url"; then
            warn "Could not check upstream Linux package metadata; using the matching cached package"
            return 0
        fi
        warn "Could not check upstream Linux package metadata and the cached URL identity does not match"
        return 1
    fi
    UPSTREAM_ARTIFACT_REMOTE_FINGERPRINT="$remote_fingerprint"
    [ -s "$metadata_path" ] && [ "$(cat "$metadata_path")" = "$remote_fingerprint" ]
}

write_cached_upstream_artifact_metadata() {
    local metadata_path="$1"
    local remote_fingerprint="$2"
    if [ -n "$remote_fingerprint" ]; then
        printf '%s\n' "$remote_fingerprint" >"$metadata_path"
    else
        rm -f "$metadata_path"
        warn "Could not record upstream Linux package metadata"
    fi
}

download_upstream_artifact() {
    local destination="$1"
    local temporary="${destination}.part.$$"

    validate_upstream_artifact_url "$UPSTREAM_ARTIFACT_URL"
    info "Downloading official OpenAI Linux package..."
    if ! curl -fL --retry 3 --output "$temporary" -- "$UPSTREAM_ARTIFACT_URL"; then
        rm -f "$temporary"
        error "Failed to download $(redact_upstream_artifact_url "$UPSTREAM_ARTIFACT_URL")"
    fi
    mv -f "$temporary" "$destination"
}

get_upstream_artifact() {
    local destination="$CACHED_UPSTREAM_ARTIFACT_PATH"
    local metadata_path="$CACHED_UPSTREAM_ARTIFACT_METADATA_PATH"

    validate_upstream_artifact_url "$UPSTREAM_ARTIFACT_URL"
    if upstream_artifact_refresh_mode_is_pinned; then
        [ -s "$destination" ] || error "Pinned upstream package is missing: $destination"
        info "Using pinned official Linux package: $destination"
        printf '%s\n' "$destination"
        return 0
    fi

    if [ "$REUSE_CACHED_UPSTREAM_ARTIFACT" -eq 1 ] && [ -s "$destination" ]; then
        if cached_upstream_artifact_is_fresh "$metadata_path" "$UPSTREAM_ARTIFACT_URL"; then
            info "Using cached official Linux package: $destination"
            printf '%s\n' "$destination"
            return 0
        fi
        warn "Cached official Linux package is stale; refreshing"
    fi

    mkdir -p "$(dirname "$destination")"
    download_upstream_artifact "$destination"
    if [ -z "$UPSTREAM_ARTIFACT_REMOTE_FINGERPRINT" ]; then
        UPSTREAM_ARTIFACT_REMOTE_FINGERPRINT="$(fetch_upstream_artifact_remote_fingerprint "$UPSTREAM_ARTIFACT_URL" || true)"
    fi
    write_cached_upstream_artifact_metadata "$metadata_path" "$UPSTREAM_ARTIFACT_REMOTE_FINGERPRINT"
    printf '%s\n' "$destination"
}

deb_control_field() {
    local package_path="$1"
    local field="$2"
    local control_member

    if command -v dpkg-deb >/dev/null 2>&1; then
        dpkg-deb --field "$package_path" "$field"
        return
    fi
    control_member="$(ar t "$package_path" | awk '/^control[.]tar([.].+)?$/ { print; exit }')"
    [ -n "$control_member" ] || error "Official Linux package has no control archive: $package_path"
    case "$control_member" in
        *.tar.xz) ar p "$package_path" "$control_member" | tar -xJO ./control ;;
        *.tar.gz) ar p "$package_path" "$control_member" | tar -xzO ./control ;;
        *.tar.zst) ar p "$package_path" "$control_member" | tar --zstd -xO ./control ;;
        *.tar) ar p "$package_path" "$control_member" | tar -xO ./control ;;
        *) error "Unsupported DEB control archive compression: $control_member" ;;
    esac | awk -F': ' -v field="$field" '$1 == field { print substr($0, length($1) + 3); exit }'
}

extract_official_linux_package() {
    local package_path="$1"
    local extraction_root="$WORK_DIR/official-linux-package"
    local data_member
    local package_name
    local package_arch

    package_name="$(deb_control_field "$package_path" Package)"
    [ "$package_name" = "chatgpt" ] || error "Expected official package 'chatgpt', found '${package_name:-unknown}'"
    package_arch="$(deb_control_field "$package_path" Architecture)"
    [ "$package_arch" = "$OFFICIAL_LINUX_DEB_ARCH" ] || \
        error "Official package architecture mismatch: expected $OFFICIAL_LINUX_DEB_ARCH, found ${package_arch:-unknown}"
    CODEX_UPSTREAM_APP_VERSION="$(deb_control_field "$package_path" Version)"
    export CODEX_UPSTREAM_APP_VERSION

    data_member="$(ar t "$package_path" | awk '/^data[.]tar([.].+)?$/ { print; exit }')"
    [ -n "$data_member" ] || error "Official Linux package has no data archive: $package_path"
    mkdir -p "$extraction_root"
    info "Extracting official Linux package ${CODEX_UPSTREAM_APP_VERSION}..."
    case "$data_member" in
        *.tar.xz) ar p "$package_path" "$data_member" | tar -xJ -C "$extraction_root" ;;
        *.tar.gz) ar p "$package_path" "$data_member" | tar -xz -C "$extraction_root" ;;
        *.tar.zst) ar p "$package_path" "$data_member" | tar --zstd -x -C "$extraction_root" ;;
        *.tar) ar p "$package_path" "$data_member" | tar -x -C "$extraction_root" ;;
        *) error "Unsupported DEB data archive compression: $data_member" ;;
    esac

    OFFICIAL_LINUX_RUNTIME_DIR="$extraction_root/usr/lib/chatgpt"
    [ -x "$OFFICIAL_LINUX_RUNTIME_DIR/ChatGPT" ] || error "Official Linux runtime executable is missing: $OFFICIAL_LINUX_RUNTIME_DIR/ChatGPT"
    [ -f "$OFFICIAL_LINUX_RUNTIME_DIR/resources/app.asar" ] || error "Official Linux app.asar is missing"
}

prepare_official_linux_app_layout() {
    local runtime_dir="$1"
    local app_dir="$WORK_DIR/official-linux-app"
    mkdir -p "$app_dir/Contents"
    ln -s "$runtime_dir/resources" "$app_dir/Contents/Resources"
    python3 - "$app_dir/Contents/Info.plist" "$CODEX_UPSTREAM_APP_VERSION" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "wb") as output:
    plistlib.dump({
        "CFBundleShortVersionString": sys.argv[2],
        "CFBundleVersion": sys.argv[2],
    }, output)
PY
    OFFICIAL_LINUX_APP_DIR="$app_dir"
}

stage_official_linux_runtime() {
    local runtime_dir="$1"
    info "Staging OpenAI's official Linux runtime..."
    cp -a "$runtime_dir/." "$INSTALL_DIR/"
    ln -sfn ChatGPT "$INSTALL_DIR/electron"

    local package_icon_root="$WORK_DIR/official-linux-package/usr/share/icons/hicolor"
    local icon_candidate=""
    if [ -d "$package_icon_root" ]; then
        icon_candidate="$(find "$package_icon_root" -type f -path '*/apps/chatgpt.png' -print | sort -V | tail -1)"
    fi
    if [ -n "$icon_candidate" ]; then
        LINUX_ICON_SOURCE="$icon_candidate"
    fi
}

sanitize_electron_version() {
    local value="$1"
    value="${value#v}"
    value="${value#^}"
    value="${value#~}"
    [[ "$value" =~ ^[0-9]+(\.[0-9]+){2}([.-][0-9A-Za-z]+)*$ ]] || return 1
    printf '%s\n' "$value"
}

detect_electron_version() {
    local app_dir="$1"
    local resources_dir="$app_dir/Contents/Resources"
    local package_extract_dir="$WORK_DIR/app-package-json"
    local package_json="$package_extract_dir/package.json"
    local package_stdout="$package_extract_dir/package.stdout"
    local detected=""
    local detected_version=""

    mkdir -p "$package_extract_dir"
    if (cd "$package_extract_dir" && npx --yes asar extract-file "$resources_dir/app.asar" package.json >"$package_stdout" 2>/dev/null); then
        if [ ! -f "$package_json" ] && [ -s "$package_stdout" ]; then
            package_json="$package_stdout"
        fi
        detected="$(node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(String(pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? ""));
' "$package_json" 2>/dev/null || true)"
    fi
    if detected_version="$(sanitize_electron_version "$detected")"; then
        ELECTRON_VERSION="$detected_version"
        info "Detected Electron version from official Linux package: $ELECTRON_VERSION"
        return 0
    fi
    error "Could not detect Electron version from the official Linux package"
}
