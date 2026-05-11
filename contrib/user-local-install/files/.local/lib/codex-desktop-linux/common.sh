#!/usr/bin/env bash
set -euo pipefail

OPT_ROOT="${HOME}/.local/opt/codex-desktop-linux"
APP_DIR="${OPT_ROOT}/codex-app"

ENV_CODEX_RELEASE_TRACK="${CODEX_RELEASE_TRACK:-}"
CODEX_RELEASE_TRACK="${ENV_CODEX_RELEASE_TRACK:-stable}"
STABLE_DMG_URL="https://persistent.oaistatic.com/codex-app-prod/Codex.dmg"
BETA_APPCAST_URL="${CODEX_BETA_APPCAST_URL:-https://persistent.oaistatic.com/codex-app-beta/appcast.xml}"

XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"

STATE_DIR="${XDG_STATE_HOME}/codex-desktop-linux"
LOG_DIR="${STATE_DIR}/logs"
METADATA_FILE="${STATE_DIR}/metadata.env"
INSTALL_CONFIG_FILE="${STATE_DIR}/install.env"
ICON_PATH="${XDG_DATA_HOME}/icons/hicolor/512x512/apps/codex-desktop.png"
DESKTOP_FILE="${XDG_DATA_HOME}/applications/codex-desktop.desktop"

REPO_DIR_DEFAULT="${HOME}/workspace/codex-desktop-linux"
REPO_DIR="$REPO_DIR_DEFAULT"
DMG_FILE="${OPT_ROOT}/Codex.dmg"
REPO_DMG_FILE="${REPO_DIR}/Codex.dmg"

ensure_layout() {
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    mkdir -p "$LOG_DIR" "$(dirname "$ICON_PATH")" "$(dirname "$DESKTOP_FILE")"
}

validate_track() {
    case "$CODEX_RELEASE_TRACK" in
        stable|preview) ;;
        *) echo "Unknown CODEX_RELEASE_TRACK=$CODEX_RELEASE_TRACK (expected stable or preview)" >&2; exit 2 ;;
    esac
}

load_install_config() {
    local env_track="$ENV_CODEX_RELEASE_TRACK"
    if [ -f "$INSTALL_CONFIG_FILE" ]; then
        # shellcheck disable=SC1090
        source "$INSTALL_CONFIG_FILE"
    fi
    REPO_DIR="${REPO_DIR:-$REPO_DIR_DEFAULT}"
    CODEX_RELEASE_TRACK="${env_track:-${CODEX_RELEASE_TRACK:-stable}}"
    REPO_DMG_FILE="${REPO_DIR}/Codex.dmg"
    validate_track
}

load_metadata() {
    local configured_track="$CODEX_RELEASE_TRACK"
    if [ -f "$METADATA_FILE" ]; then
        # shellcheck disable=SC1090
        source "$METADATA_FILE"
    fi
    CODEX_RELEASE_TRACK="$configured_track"
    validate_track
}

write_kv() {
    printf '%s=%q\n' "$1" "${2-}"
}

current_repo_head() {
    git -C "$REPO_DIR" rev-parse HEAD
}

remote_repo_head() {
    git -C "$REPO_DIR" ls-remote origin HEAD | awk 'NR==1 { print $1 }'
}

remote_dmg_headers() {
    curl -fsSIL "$STABLE_DMG_URL" | tr -d '\r'
}

header_value() {
    local headers="$1"
    local name="$2"
    printf '%s\n' "$headers" | awk -F': ' -v target="$name" 'tolower($1) == tolower(target) { print $2; exit }'
}

metadata_value() {
    local metadata="$1"
    local name="$2"
    printf '%s\n' "$metadata" | awk -v target="$name" '
        index($0, target "=") == 1 {
            sub("^[^=]*=", "")
            print
            exit
        }
    '
}

redact_url() {
    python3 - "$1" <<'PY'
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
import sys

value = sys.argv[1]
try:
    parts = urlsplit(value)
    if not parts.scheme or not parts.netloc:
        print(value)
        raise SystemExit(0)

    host = parts.hostname or ""
    netloc = f"{host}:{parts.port}" if parts.port else host
    sensitive = ("auth", "credential", "key", "secret", "sig", "signature", "token", "x-amz-")
    query = []
    for key, item_value in parse_qsl(parts.query, keep_blank_values=True):
        if any(marker in key.lower() for marker in sensitive):
            query.append((key, "REDACTED"))
        else:
            query.append((key, item_value))
    print(urlunsplit((parts.scheme, netloc, parts.path, urlencode(query), parts.fragment)))
except Exception:
    print(value)
PY
}

appcast_metadata() {
    local track="$1"
    local appcast_url="$2"
    python3 - "$appcast_url" "$track" <<'PY'
import sys
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

appcast_url, track = sys.argv[1:3]
request = urllib.request.Request(
    appcast_url,
    headers={
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/xml,text/xml,*/*",
    },
)
with urllib.request.urlopen(request, timeout=30) as response:
    body = response.read()

root = ET.fromstring(body)
ns = {"sparkle": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
item = root.find("./channel/item")
if item is None:
    raise SystemExit(f"No {track} releases found in appcast")

version = item.findtext("sparkle:shortVersionString", namespaces=ns) or item.findtext("title")
enclosure = item.find("enclosure")
url = enclosure.get("url") if enclosure is not None else None
if not version or not url:
    raise SystemExit(f"{track} appcast missing version or enclosure URL")

appcast_parts = urlsplit(appcast_url)
release_parts = urlsplit(url)
if release_parts.scheme not in ("http", "https") or not release_parts.netloc:
    raise SystemExit(f"{track} appcast enclosure URL must be absolute HTTP(S)")
if appcast_parts.scheme == "https" and release_parts.scheme != "https":
    raise SystemExit(f"{track} appcast enclosure URL must use HTTPS")
if appcast_parts.hostname == "persistent.oaistatic.com" and release_parts.hostname != appcast_parts.hostname:
    raise SystemExit(f"{track} appcast enclosure URL must use {appcast_parts.hostname}")

print(version)
print(url)
PY
}

remote_stable_metadata() {
    local headers
    headers="$(remote_dmg_headers)"

    printf 'UPSTREAM_KIND=stable\n'
    printf 'UPSTREAM_VERSION=\n'
    printf 'UPSTREAM_URL=%s\n' "$STABLE_DMG_URL"
    printf 'UPSTREAM_ETAG=%s\n' "$(header_value "$headers" "etag")"
    printf 'UPSTREAM_LAST_MODIFIED=%s\n' "$(header_value "$headers" "last-modified")"
    printf 'UPSTREAM_CONTENT_LENGTH=%s\n' "$(header_value "$headers" "content-length")"
}

remote_appcast_metadata() {
    local track="$1"
    local appcast_url="$2"
    local release_meta release_version release_url headers
    release_meta="$(appcast_metadata "$track" "$appcast_url")"
    release_version="$(printf '%s\n' "$release_meta" | sed -n '1p')"
    release_url="$(printf '%s\n' "$release_meta" | sed -n '2p')"
    headers="$(curl -fsSIL "$release_url" | tr -d '\r' || true)"

    printf 'UPSTREAM_KIND=%s\n' "$track"
    printf 'UPSTREAM_VERSION=%s\n' "$release_version"
    printf 'UPSTREAM_URL=%s\n' "$release_url"
    printf 'UPSTREAM_ETAG=%s\n' "$(header_value "$headers" "etag")"
    printf 'UPSTREAM_LAST_MODIFIED=%s\n' "$(header_value "$headers" "last-modified")"
    printf 'UPSTREAM_CONTENT_LENGTH=%s\n' "$(header_value "$headers" "content-length")"
}

remote_upstream_metadata() {
    case "$CODEX_RELEASE_TRACK" in
        stable) remote_stable_metadata ;;
        preview) remote_appcast_metadata preview "$BETA_APPCAST_URL" ;;
    esac
}

local_installer_path() {
    case "$CODEX_RELEASE_TRACK" in
        stable)
            if [ -f "$REPO_DMG_FILE" ]; then
                printf '%s\n' "$REPO_DMG_FILE"
            elif [ -f "$DMG_FILE" ]; then
                printf '%s\n' "$DMG_FILE"
            fi
            ;;
        preview)
            [ -d "$REPO_DIR/.cache/preview" ] || return 0
            find "$REPO_DIR/.cache/preview" -maxdepth 1 -type f -name 'Codex-Preview-*.zip' 2>/dev/null | sort -V | tail -n 1
            ;;
    esac
    return 0
}

extract_icon() {
    ensure_layout
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_dir"; trap - RETURN' RETURN

    local installer_path="$1"
    local icns_path="$tmp_dir/electron.icns"
    case "${installer_path,,}" in
        *.zip)
            local zip_icon_path
            zip_icon_path="$(unzip -Z1 "$installer_path" | awk '/\.app\/Contents\/Resources\/electron.icns$/ && $0 !~ /__MACOSX/ { print; exit }')"
            [ -n "$zip_icon_path" ] || return 0
            unzip -p "$installer_path" "$zip_icon_path" > "$icns_path"
            ;;
        *)
            7z e -y "$installer_path" "Codex Installer/Codex.app/Contents/Resources/electron.icns" "-o${tmp_dir}" >/dev/null
            ;;
    esac

    [ -s "$icns_path" ] || return 0
    python3 - "$icns_path" "$ICON_PATH" <<'PY'
from PIL import Image
import sys

source_path, target_path = sys.argv[1], sys.argv[2]
with Image.open(source_path) as img:
    img.load()
    img.thumbnail((512, 512))
    img.save(target_path, format="PNG")
PY
}

record_metadata() {
    ensure_layout
    load_install_config

    local repo_head installer_path installer_sha256 installer_size electron_version upstream_metadata upstream_kind upstream_version upstream_url upstream_etag upstream_last_modified upstream_content_length build_time repo_origin metadata_tmp
    if [ -d "$REPO_DIR/.git" ]; then
        repo_head="$(current_repo_head)"
        repo_origin="$(git -C "$REPO_DIR" remote get-url origin)"
    else
        repo_head="unavailable"
        repo_origin="unavailable"
    fi
    installer_path="$(local_installer_path)"
    [ -n "$installer_path" ] && [ -f "$installer_path" ] || return 0

    installer_sha256="$(sha256sum "$installer_path" | awk '{ print $1 }')"
    installer_size="$(stat -c '%s' "$installer_path")"
    electron_version="$(cat "$APP_DIR/version")"
    build_time="$(date -Iseconds)"

    upstream_metadata="$(remote_upstream_metadata 2>/dev/null || true)"
    upstream_kind="$(metadata_value "$upstream_metadata" "UPSTREAM_KIND")"
    upstream_version="$(metadata_value "$upstream_metadata" "UPSTREAM_VERSION")"
    upstream_url="$(metadata_value "$upstream_metadata" "UPSTREAM_URL")"
    upstream_etag="$(metadata_value "$upstream_metadata" "UPSTREAM_ETAG")"
    upstream_last_modified="$(metadata_value "$upstream_metadata" "UPSTREAM_LAST_MODIFIED")"
    upstream_content_length="$(metadata_value "$upstream_metadata" "UPSTREAM_CONTENT_LENGTH")"

    repo_origin="$(redact_url "$repo_origin")"
    upstream_url="$(redact_url "$upstream_url")"

    metadata_tmp="$(mktemp "${METADATA_FILE}.tmp.XXXXXX")"
    chmod 600 "$metadata_tmp"
    {
        write_kv BUILD_TIME "$build_time"
        write_kv REPO_ORIGIN "$repo_origin"
        write_kv REPO_HEAD "$repo_head"
        write_kv INSTALLER_PATH "$installer_path"
        write_kv INSTALLER_SHA256 "$installer_sha256"
        write_kv INSTALLER_SIZE "$installer_size"
        write_kv UPSTREAM_KIND "$upstream_kind"
        write_kv UPSTREAM_VERSION "$upstream_version"
        write_kv UPSTREAM_URL "$upstream_url"
        write_kv UPSTREAM_ETAG "$upstream_etag"
        write_kv UPSTREAM_LAST_MODIFIED "$upstream_last_modified"
        write_kv UPSTREAM_CONTENT_LENGTH "$upstream_content_length"
        write_kv DMG_SHA256 "$installer_sha256"
        write_kv DMG_SIZE "$installer_size"
        write_kv DMG_ETAG "$upstream_etag"
        write_kv DMG_LAST_MODIFIED "$upstream_last_modified"
        write_kv DMG_CONTENT_LENGTH "$upstream_content_length"
        write_kv ELECTRON_VERSION "$electron_version"
        write_kv APP_DIR "$APP_DIR"
        write_kv ICON_PATH "$ICON_PATH"
        write_kv OPT_ROOT "$OPT_ROOT"
        write_kv REPO_DIR "$REPO_DIR"
    } > "$metadata_tmp"
    mv "$metadata_tmp" "$METADATA_FILE"

    if ! extract_icon "$installer_path"; then
        echo "Could not refresh desktop icon; continuing without icon update." >&2
    fi
}
