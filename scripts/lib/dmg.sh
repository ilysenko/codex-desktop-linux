#!/bin/bash
# Codex installer download, extraction, and Electron-version detection from app metadata.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

# ---- Download or find Codex DMG ----
get_dmg() {
    local dmg_dest="$CACHED_DMG_PATH"

    # Reuse existing DMG
    if [ -s "$dmg_dest" ]; then
        info "Using cached DMG: $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"
        echo "$dmg_dest"
        return
    fi

    info "Downloading Codex Desktop DMG..."
    local dmg_url="https://persistent.oaistatic.com/codex-app-prod/Codex.dmg"
    info "URL: $dmg_url"

    if ! curl -L --progress-bar --max-time 600 --connect-timeout 30 \
            -o "$dmg_dest" "$dmg_url"; then
        rm -f "$dmg_dest"
        error "Download failed. Download manually and place as: $dmg_dest"
    fi

    if [ ! -s "$dmg_dest" ]; then
        rm -f "$dmg_dest"
        error "Download produced empty file. Download manually and place as: $dmg_dest"
    fi

    info "Saved: $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"
    echo "$dmg_dest"
}

appcast_url_for_track() {
    case "$1" in
        preview)
            echo "${CODEX_BETA_APPCAST_URL:-https://persistent.oaistatic.com/codex-app-beta/appcast.xml}"
            ;;
        *)
            error "No appcast URL for release track: $1"
            ;;
    esac
}

track_title() {
    case "$1" in
        preview) echo "Preview" ;;
        *) echo "$1" ;;
    esac
}

get_appcast_zip() {
    local track="$1"
    local title
    local appcast_url
    title="$(track_title "$track")"
    appcast_url="$(appcast_url_for_track "$track")"

    local cache_dir="$CACHED_TRACK_ZIP_ROOT/$track"
    mkdir -p "$cache_dir"

    info "Checking Codex Desktop $track appcast..."
    local release_meta
    release_meta=$(python3 - "$appcast_url" "$track" <<'PY'
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
)

    local release_version release_url release_filename_version release_dest
    release_version="$(printf '%s\n' "$release_meta" | sed -n '1p')"
    release_url="$(printf '%s\n' "$release_meta" | sed -n '2p')"
    release_filename_version="$(printf '%s' "$release_version" | tr -c 'A-Za-z0-9._-' '_')"
    [ -n "$release_filename_version" ] || release_filename_version="latest"
    release_dest="$cache_dir/Codex-$title-$release_filename_version.zip"

    info "Latest $track: $release_version"
    info "URL: $release_url"

    if [ -s "$release_dest" ]; then
        info "Using cached $track zip: $release_dest ($(du -h "$release_dest" | cut -f1))"
        echo "$release_dest"
        return
    fi

    local tmp_dest="$release_dest.tmp"
    rm -f "$tmp_dest"
    if ! curl -L --fail --progress-bar --retry 3 --connect-timeout 30 --max-time 900 \
            -A "Mozilla/5.0" -o "$tmp_dest" "$release_url"; then
        rm -f "$tmp_dest"
        error "$title download failed from appcast URL"
    fi

    if [ ! -s "$tmp_dest" ]; then
        rm -f "$tmp_dest"
        error "$title download produced empty file"
    fi

    mv "$tmp_dest" "$release_dest"
    info "Saved: $release_dest ($(du -h "$release_dest" | cut -f1))"
    echo "$release_dest"
}

installer_app_track() {
    case "$RELEASE_TRACK" in
        stable) echo "stable" ;;
        preview) echo "preview" ;;
    esac
}

get_installer() {
    case "$(installer_app_track)" in
        stable) get_dmg ;;
        preview) get_appcast_zip preview ;;
    esac
}

# ---- Extract app from DMG ----
extract_dmg() {
    local dmg_path="$1"
    info "Extracting DMG with 7z..."

    local extract_dir="$WORK_DIR/dmg-extract"
    local seven_log="$WORK_DIR/7z.log"
    local seven_zip_status=0

    mkdir -p "$extract_dir"
    if "$SEVEN_ZIP_CMD" x -y -snl "$dmg_path" -o"$extract_dir" >"$seven_log" 2>&1; then
        :
    else
        seven_zip_status=$?
    fi

    local app_dir
    app_dir=$(find "$extract_dir" -maxdepth 3 -name "*.app" -type d | head -1)

    if [ "$seven_zip_status" -ne 0 ]; then
        if [ -n "$app_dir" ]; then
            warn "7z exited with code $seven_zip_status but app bundle was found; continuing"
            warn "$(tail -n 5 "$seven_log" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
        else
            cat "$seven_log" >&2
            error "Failed to extract DMG"
        fi
    fi

    [ -n "$app_dir" ] || error "Could not find .app bundle in DMG"

    info "Found: $(basename "$app_dir")"
    echo "$app_dir"
}

extract_zip() {
    local zip_path="$1"
    info "Extracting ZIP..."

    local extract_dir="$WORK_DIR/zip-extract"
    mkdir -p "$extract_dir"
    unzip -q "$zip_path" -d "$extract_dir"

    local app_dir
    app_dir=$(find "$extract_dir" -maxdepth 3 -path '*/__MACOSX' -prune -o -name "*.app" -type d -print | head -1)
    [ -n "$app_dir" ] || error "Could not find .app bundle in ZIP"

    info "Found: $(basename "$app_dir")"
    echo "$app_dir"
}

extract_app_bundle() {
    local installer_path="$1"
    case "${installer_path,,}" in
        *.zip) extract_zip "$installer_path" ;;
        *) extract_dmg "$installer_path" ;;
    esac
}

# ---- Detect Electron version from DMG ----
sanitize_electron_version() {
    local value="$1"
    value="${value#v}"
    value="${value#^}"
    value="${value#~}"

    if [[ "$value" =~ ^[0-9]+(\.[0-9]+){2}([.-][0-9A-Za-z]+)*$ ]]; then
        echo "$value"
        return 0
    fi

    return 1
}

detect_electron_version() {
    local app_dir="$1"
    local detected=""
    local detected_version=""
    local plist_file="$app_dir/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist"

    if [ -f "$plist_file" ]; then
        detected=$(python3 - "$plist_file" <<'PY' 2>/dev/null || true
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    print(plistlib.load(handle).get("CFBundleVersion", ""))
PY
)
        if detected_version=$(sanitize_electron_version "$detected"); then
            ELECTRON_VERSION="$detected_version"
            info "Detected Electron version from DMG: $ELECTRON_VERSION"
            return 0
        elif [ -n "$detected" ]; then
            warn "Ignoring invalid Electron version from DMG: $detected"
        fi
    fi

    local resources_dir="$app_dir/Contents/Resources"
    if [ -f "$resources_dir/app.asar" ]; then
        detected=$(npx --yes asar extract-file "$resources_dir/app.asar" package.json 2>/dev/null |
            node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(String(pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? ""));
' 2>/dev/null || true)
        if detected_version=$(sanitize_electron_version "$detected"); then
            ELECTRON_VERSION="$detected_version"
            info "Detected Electron version from package.json: $ELECTRON_VERSION"
            return 0
        elif [ -n "$detected" ]; then
            warn "Ignoring invalid Electron version from package.json: $detected"
        fi
    fi

    warn "Could not auto-detect Electron version; using fallback $ELECTRON_VERSION"
    return 0
}
