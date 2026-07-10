#!/bin/bash
# Codex.dmg download, extraction, and Electron-version detection from app metadata.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

# ---- Download or find Codex DMG ----
DEFAULT_DMG_URL="https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg"
DMG_URL="${CODEX_UPSTREAM_DMG_URL:-$DEFAULT_DMG_URL}"
DMG_REMOTE_FINGERPRINT=""

redact_dmg_url() {
    local dmg_url="$1"
    local scheme="${dmg_url%%://*}"
    local remainder="${dmg_url#*://}"

    # Authority ends at the first '/', '?', or '#', whichever comes first.
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

validate_dmg_url() {
    local dmg_url="$1"

    case "$dmg_url" in
        https://*)
            ;;
        "")
            error "Upstream DMG URL must not be empty"
            ;;
        *)
            error "Upstream DMG URL must be an HTTPS URL: $(redact_dmg_url "$dmg_url")"
            ;;
    esac
}

dmg_url_cache_key() {
    printf '%s' "$1" | sha256sum | awk '{print $1}'
}

cached_dmg_metadata_url_sha256() {
    local metadata_path="$1"

    awk -F= '$1 == "url_sha256" { print $2; exit }' "$metadata_path" 2>/dev/null || true
}

cached_dmg_metadata_matches_url() {
    local metadata_path="$1"
    local dmg_url="$2"
    local cached_url_sha256
    local expected_url_sha256

    [ -s "$metadata_path" ] || return 1

    cached_url_sha256="$(cached_dmg_metadata_url_sha256 "$metadata_path")"
    expected_url_sha256="$(dmg_url_cache_key "$dmg_url")"

    [ -n "$cached_url_sha256" ] && [ "$cached_url_sha256" = "$expected_url_sha256" ]
}

fetch_dmg_remote_fingerprint() {
    local dmg_url="$1"
    local headers_file="$WORK_DIR/dmg-headers.txt"
    local url_sha256

    url_sha256="$(dmg_url_cache_key "$dmg_url")"

    if ! curl -fsSLI --max-time 10 --connect-timeout 5 -- "$dmg_url" >"$headers_file"; then
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
        key ~ /^http\// {
            etag = ""
            last_modified = ""
            content_length = ""
            next
        }
        key == "etag" {
            etag = value
            next
        }
        key == "last-modified" {
            last_modified = value
            next
        }
        key == "content-length" {
            content_length = value
            next
        }
        END {
            if (etag == "" && last_modified == "" && content_length == "") {
                exit 1
            }
            print "url_sha256=" url_sha256
            print "etag=" etag
            print "last_modified=" last_modified
            print "content_length=" content_length
        }
    ' "$headers_file"
}

cached_dmg_is_fresh() {
    local dmg_dest="$1"
    local metadata_path="$2"
    local dmg_url="$3"
    local remote_fingerprint

    if ! remote_fingerprint="$(fetch_dmg_remote_fingerprint "$dmg_url")"; then
        if cached_dmg_metadata_matches_url "$metadata_path" "$dmg_url"; then
            warn "Could not check upstream DMG metadata; using cached DMG for matching URL"
            return 0
        fi

        warn "Could not check upstream DMG metadata; cached DMG URL metadata does not match current URL"
        return 1
    fi
    DMG_REMOTE_FINGERPRINT="$remote_fingerprint"

    if [ ! -s "$metadata_path" ]; then
        warn "Cached DMG has no upstream metadata; refreshing once to seed the cache"
        return 1
    fi

    if [ "$(cat "$metadata_path")" = "$remote_fingerprint" ]; then
        return 0
    fi

    warn "Cached DMG metadata differs from upstream; refreshing"
    return 1
}

write_cached_dmg_metadata() {
    local metadata_path="$1"
    local remote_fingerprint="$2"

    if [ -n "$remote_fingerprint" ]; then
        printf '%s\n' "$remote_fingerprint" >"$metadata_path"
    else
        rm -f "$metadata_path"
        warn "Could not record upstream DMG metadata"
    fi
}

get_dmg() {
    local dmg_dest="$CACHED_DMG_PATH"
    local metadata_path="$CACHED_DMG_METADATA_PATH"
    local download_fingerprint=""
    local tmp_dest="$dmg_dest.part"

    if dmg_refresh_mode_is_pinned; then
        if [ -s "$dmg_dest" ]; then
            warn "CODEX_DMG_REFRESH_MODE=pinned; using cached DMG without checking upstream: $dmg_dest"
            echo "$dmg_dest"
            return
        fi

        error "CODEX_DMG_REFRESH_MODE=pinned requires an existing cached DMG at $dmg_dest or an explicit DMG path"
    fi

    validate_dmg_url "$DMG_URL"

    # Reuse existing DMG only when it still matches upstream metadata.
    if [ -s "$dmg_dest" ]; then
        DMG_REMOTE_FINGERPRINT=""
        if cached_dmg_is_fresh "$dmg_dest" "$metadata_path" "$DMG_URL"; then
            info "Using cached DMG: $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"
            echo "$dmg_dest"
            return
        fi

        download_fingerprint="$DMG_REMOTE_FINGERPRINT"
        info "Refreshing stale cached DMG: $dmg_dest"
    fi

    if [ -z "$download_fingerprint" ]; then
        if ! download_fingerprint="$(fetch_dmg_remote_fingerprint "$DMG_URL")"; then
            warn "Could not record upstream DMG metadata"
            download_fingerprint=""
        fi
    fi

    info "Downloading ChatGPT Desktop DMG..."
    info "URL: $(redact_dmg_url "$DMG_URL")"

    rm -f "$tmp_dest"
    if ! curl -L --progress-bar --max-time 600 --connect-timeout 30 \
            -o "$tmp_dest" -- "$DMG_URL"; then
        rm -f "$tmp_dest"
        error "Download failed. Download manually and place as: $dmg_dest"
    fi

    if [ ! -s "$tmp_dest" ]; then
        rm -f "$tmp_dest"
        error "Download produced empty file. Download manually and place as: $dmg_dest"
    fi

    mv "$tmp_dest" "$dmg_dest"
    write_cached_dmg_metadata "$metadata_path" "$download_fingerprint"
    info "Saved: $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"
    echo "$dmg_dest"
}

# ---- Extract app from DMG ----
path_is_within_root() {
    local root="$1"
    local candidate="$2"
    local root_real
    local candidate_real

    root_real="$(realpath -m "$root")" || return 1
    candidate_real="$(realpath -m "$candidate")" || return 1

    case "$candidate_real" in
        "$root_real"|"$root_real"/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

repair_7z_dangerous_link_path_warnings() {
    local extract_dir="$1"
    local app_dir="$2"
    local seven_log="$3"
    local dangerous_count=0
    local repaired_count=0
    local failed_count=0
    local other_error_count=0
    local line
    local payload
    local link_rel
    local link_target
    local link_path
    local link_parent
    local target_path

    while IFS= read -r line; do
        case "$line" in
            "ERROR: Dangerous link path was ignored : "*)
                dangerous_count=$((dangerous_count + 1))
                payload="${line#ERROR: Dangerous link path was ignored : }"
                link_rel="${payload% : *}"
                link_target="${payload##* : }"

                if [ "$link_rel" = "$payload" ] || [ -z "$link_rel" ] || [ -z "$link_target" ]; then
                    failed_count=$((failed_count + 1))
                    continue
                fi

                case "$link_target" in
                    /*)
                        failed_count=$((failed_count + 1))
                        continue
                        ;;
                esac

                link_path="$extract_dir/$link_rel"
                link_parent="$(dirname "$link_path")"
                target_path="$link_parent/$link_target"

                if ! path_is_within_root "$app_dir" "$link_path" \
                        || ! path_is_within_root "$app_dir" "$target_path"; then
                    failed_count=$((failed_count + 1))
                    continue
                fi

                if [ ! -e "$target_path" ] && [ ! -L "$target_path" ]; then
                    failed_count=$((failed_count + 1))
                    continue
                fi

                if [ -e "$link_path" ] || [ -L "$link_path" ]; then
                    if [ -L "$link_path" ] && [ "$(readlink "$link_path")" = "$link_target" ]; then
                        repaired_count=$((repaired_count + 1))
                        continue
                    fi
                    if [ -s "$link_path" ]; then
                        failed_count=$((failed_count + 1))
                        continue
                    fi
                    if ! rm -f "$link_path"; then
                        failed_count=$((failed_count + 1))
                        continue
                    fi
                fi

                if ln -s "$link_target" "$link_path"; then
                    repaired_count=$((repaired_count + 1))
                else
                    failed_count=$((failed_count + 1))
                fi
                ;;
            ERROR:*)
                other_error_count=$((other_error_count + 1))
                ;;
        esac
    done <"$seven_log"

    if [ "$dangerous_count" -eq 0 ] \
            || [ "$failed_count" -ne 0 ] \
            || [ "$other_error_count" -ne 0 ]; then
        return 1
    fi

    printf '%s\n' "$repaired_count"
    return 0
}

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
            local repaired_link_count=""
            if repaired_link_count="$(repair_7z_dangerous_link_path_warnings "$extract_dir" "$app_dir" "$seven_log")"; then
                local warning_word="warnings"
                [ "$repaired_link_count" = "1" ] && warning_word="warning"
                info "7z reported $repaired_link_count safe package symlink $warning_word; repaired and continuing"
            else
                warn "7z exited with code $seven_zip_status but app bundle was found; continuing"
                warn "$(tail -n 5 "$seven_log" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
            fi
        else
            cat "$seven_log" >&2
            error "Failed to extract DMG"
        fi
    fi

    [ -n "$app_dir" ] || error "Could not find .app bundle in DMG"

    info "Found: $(basename "$app_dir")"
    echo "$app_dir"
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
        local package_extract_dir="$WORK_DIR/app-package-json"
        local package_stdout="$package_extract_dir/package.stdout"
        local package_json="$package_extract_dir/package.json"
        rm -rf "$package_extract_dir"
        mkdir -p "$package_extract_dir"

        if (cd "$package_extract_dir" && npx --yes asar extract-file "$resources_dir/app.asar" package.json >"$package_stdout" 2>/dev/null); then
            if [ -f "$package_json" ]; then
                :
            elif [ -s "$package_stdout" ]; then
                package_json="$package_stdout"
            else
                package_json=""
            fi
        else
            package_json=""
        fi

        if [ -n "$package_json" ]; then
            detected=$(node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(String(pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? ""));
' "$package_json" 2>/dev/null || true)
        else
            detected=""
        fi

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
