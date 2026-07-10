#!/usr/bin/env bash
set -euo pipefail

OPT_ROOT="${HOME}/.local/opt/codex-desktop-linux"
APP_DIR="${OPT_ROOT}/codex-app"
DMG_URL="https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg"

XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-${HOME}/.local/state}"

DATA_DIR="${XDG_DATA_HOME}/codex-desktop-linux"
STATE_DIR="${XDG_STATE_HOME}/codex-desktop-linux"
LOG_DIR="${STATE_DIR}/logs"
METADATA_FILE="${STATE_DIR}/metadata.env"
INSTALL_CONFIG_FILE="${STATE_DIR}/install.env"
ICON_PATH="${XDG_DATA_HOME}/icons/hicolor/512x512/apps/codex-desktop.png"
DESKTOP_FILE="${XDG_DATA_HOME}/applications/codex-desktop.desktop"

REPO_DIR_DEFAULT="${HOME}/workspace/codex-desktop-linux"
SOURCE_REPO_DIR="$REPO_DIR_DEFAULT"
MANAGED_REPO_DIR="${DATA_DIR}/managed-repo"
BUILD_REPO_DIR=""

ensure_layout() {
    mkdir -p "$DATA_DIR" "$STATE_DIR" "$LOG_DIR" "$(dirname "$ICON_PATH")" "$(dirname "$DESKTOP_FILE")"
}

load_install_config() {
    if [ -f "$INSTALL_CONFIG_FILE" ]; then
        # shellcheck disable=SC1090
        source "$INSTALL_CONFIG_FILE"
    fi
    SOURCE_REPO_DIR="${SOURCE_REPO_DIR:-${REPO_DIR:-$REPO_DIR_DEFAULT}}"
    REPO_DIR="$SOURCE_REPO_DIR"
    MANAGED_REPO_DIR="${MANAGED_REPO_DIR:-${DATA_DIR}/managed-repo}"
    REPO_DEFAULT_BRANCH="${REPO_DEFAULT_BRANCH-}"
}

load_metadata() {
    if [ -f "$METADATA_FILE" ]; then
        # shellcheck disable=SC1090
        source "$METADATA_FILE"
    fi
}

write_kv() {
    printf '%s=%q\n' "$1" "${2-}"
}

effective_repo_dir() {
    if [ -n "${BUILD_REPO_DIR:-}" ] && [ -d "$BUILD_REPO_DIR/.git" ]; then
        printf '%s\n' "$BUILD_REPO_DIR"
        return 0
    fi
    if [ -d "$MANAGED_REPO_DIR/.git" ]; then
        printf '%s\n' "$MANAGED_REPO_DIR"
        return 0
    fi
    printf '%s\n' "$SOURCE_REPO_DIR"
}

# install.sh caches the upstream DMG next to itself in the build repo
# checkout, never under $OPT_ROOT.
cached_dmg_file() {
    printf '%s/Codex.dmg\n' "$(effective_repo_dir)"
}

current_repo_head() {
    local repo_dir
    repo_dir="$(effective_repo_dir)"
    git -C "$repo_dir" rev-parse HEAD
}

source_repo_head() {
    [ -d "$SOURCE_REPO_DIR/.git" ] || return 1
    git -C "$SOURCE_REPO_DIR" rev-parse HEAD
}

remote_repo_head() {
    local origin_url
    origin_url="$(repo_origin_url)" || return 1
    git -C "$(repo_remote_query_dir)" ls-remote "$origin_url" HEAD | awk 'NR==1 { print $1 }'
}

repo_origin_url_is_relative_local() {
    local origin_url="$1"

    case "$origin_url" in
        ""|/*|~*|*://*|*:*)
            return 1
            ;;
    esac
    return 0
}

resolve_repo_origin_url() {
    local origin_url="$1"
    local base_dir="$2"
    local base_abs candidate target_dir target_name

    if ! repo_origin_url_is_relative_local "$origin_url" || [ -z "$base_dir" ]; then
        printf '%s\n' "$origin_url"
        return 0
    fi

    if [ -d "$base_dir" ]; then
        base_abs="$(cd "$base_dir" && pwd -P)" || base_abs="$base_dir"
    else
        base_abs="$base_dir"
    fi

    candidate="$base_abs/$origin_url"
    target_dir="$(dirname "$candidate")"
    target_name="$(basename "$candidate")"
    if [ -d "$target_dir" ]; then
        printf '%s/%s\n' "$(cd "$target_dir" && pwd -P)" "$target_name"
    else
        printf '%s\n' "$candidate"
    fi
}

managed_repo_origin_url() {
    [ -d "$MANAGED_REPO_DIR/.git" ] || return 1
    git -C "$MANAGED_REPO_DIR" remote get-url origin 2>/dev/null
}

repo_origin_url() {
    local origin_url=""
    local resolved_url=""
    local managed_origin_url=""

    if [ -n "${REPO_ORIGIN_URL:-}" ]; then
        origin_url="$REPO_ORIGIN_URL"
        if repo_origin_url_is_relative_local "$origin_url"; then
            resolved_url="$(resolve_repo_origin_url "$origin_url" "$SOURCE_REPO_DIR")"
            if [ -e "$resolved_url" ]; then
                printf '%s\n' "$resolved_url"
                return 0
            fi
            managed_origin_url="$(managed_repo_origin_url 2>/dev/null || true)"
            if [ -n "$managed_origin_url" ]; then
                printf '%s\n' "$managed_origin_url"
                return 0
            fi
            printf '%s\n' "$resolved_url"
            return 0
        fi
        printf '%s\n' "$origin_url"
        return 0
    elif [ -d "$SOURCE_REPO_DIR/.git" ]; then
        git -C "$SOURCE_REPO_DIR" remote get-url origin
        return $?
    fi

    managed_repo_origin_url
}

repo_remote_query_dir() {
    if [ -d "$SOURCE_REPO_DIR/.git" ]; then
        printf '%s\n' "$SOURCE_REPO_DIR"
        return 0
    fi
    if [ -d "$MANAGED_REPO_DIR/.git" ]; then
        printf '%s\n' "$MANAGED_REPO_DIR"
        return 0
    fi
    printf '%s\n' "/"
}

repo_branch_from_origin_head() {
    local repo_dir="$1"
    local branch=""

    [ -d "$repo_dir/.git" ] || return 1
    branch="$(git -C "$repo_dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    branch="${branch#origin/}"
    [ -n "$branch" ] || return 1
    printf '%s\n' "$branch"
}

repo_branch_from_remote_head() {
    local origin_url=""
    local branch=""

    origin_url="$(repo_origin_url 2>/dev/null || true)"
    [ -n "$origin_url" ] || return 1
    branch="$(git -C "$(repo_remote_query_dir)" ls-remote --symref "$origin_url" HEAD 2>/dev/null | awk '
        $1 == "ref:" {
            branch = $2
            sub("^refs/heads/", "", branch)
            print branch
            exit
        }
    ')"
    [ -n "$branch" ] || return 1
    printf '%s\n' "$branch"
}

remote_branch_exists() {
    local branch="$1"
    local origin_url=""

    [ -n "$branch" ] || return 1
    origin_url="$(repo_origin_url 2>/dev/null || true)"
    [ -n "$origin_url" ] || return 1

    git -C "$(repo_remote_query_dir)" ls-remote --exit-code --heads "$origin_url" "refs/heads/$branch" >/dev/null 2>&1
}

repo_default_branch() {
    local branch="${REPO_DEFAULT_BRANCH:-}"
    if [ -n "$branch" ] && [ "$branch" != "origin/HEAD" ] && remote_branch_exists "$branch"; then
        printf '%s\n' "$branch"
        return 0
    fi

    if branch="$(repo_branch_from_origin_head "$SOURCE_REPO_DIR" 2>/dev/null)" && remote_branch_exists "$branch"; then
        printf '%s\n' "$branch"
        return 0
    fi

    if branch="$(repo_branch_from_origin_head "$MANAGED_REPO_DIR" 2>/dev/null)" && remote_branch_exists "$branch"; then
        printf '%s\n' "$branch"
        return 0
    fi

    if branch="$(repo_branch_from_remote_head 2>/dev/null)" && remote_branch_exists "$branch"; then
        printf '%s\n' "$branch"
        return 0
    fi

    printf '%s\n' "main"
}

source_repo_overlay_base_ref() {
    local upstream_ref current_branch default_branch

    [ -d "$SOURCE_REPO_DIR/.git" ] || return 1

    upstream_ref="$(git -C "$SOURCE_REPO_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
    if [ -n "$upstream_ref" ] && git -C "$SOURCE_REPO_DIR" rev-parse --verify --quiet "$upstream_ref" >/dev/null; then
        printf '%s\n' "$upstream_ref"
        return 0
    fi

    current_branch="$(git -C "$SOURCE_REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    if [ -n "$current_branch" ] && git -C "$SOURCE_REPO_DIR" rev-parse --verify --quiet "refs/remotes/origin/$current_branch" >/dev/null; then
        printf 'origin/%s\n' "$current_branch"
        return 0
    fi

    default_branch="$(repo_default_branch)"
    if git -C "$SOURCE_REPO_DIR" rev-parse --verify --quiet "refs/remotes/origin/$default_branch" >/dev/null; then
        printf 'origin/%s\n' "$default_branch"
        return 0
    fi

    return 1
}

source_repo_overlay_paths() {
    local diff_filter="$1"
    local base_ref="${2:-}"

    if [ -n "$base_ref" ]; then
        {
            git -C "$SOURCE_REPO_DIR" diff --name-only --diff-filter="$diff_filter" "$base_ref...HEAD" --
            git -C "$SOURCE_REPO_DIR" diff --name-only --diff-filter="$diff_filter" HEAD --
        } | awk 'NF && !seen[$0]++'
        return 0
    fi

    git -C "$SOURCE_REPO_DIR" diff --name-only --diff-filter="$diff_filter" HEAD --
}

source_repo_overlay_remove_paths() {
    local base_ref="${1:-}"

    if [ -n "$base_ref" ]; then
        {
            git -C "$SOURCE_REPO_DIR" diff --name-status --find-renames "$base_ref...HEAD" --
            git -C "$SOURCE_REPO_DIR" diff --name-status --find-renames HEAD --
        } | awk '
            $1 ~ /^D/ && NF >= 2 { print $2; next }
            $1 ~ /^R/ && NF >= 3 { print $2; next }
        ' | awk 'NF && !seen[$0]++'
        return 0
    fi

    git -C "$SOURCE_REPO_DIR" diff --name-status --find-renames HEAD -- | awk '
        $1 ~ /^D/ && NF >= 2 { print $2; next }
        $1 ~ /^R/ && NF >= 3 { print $2; next }
    '
}

source_repo_path_is_unmerged() {
    local path="$1"
    git -C "$SOURCE_REPO_DIR" ls-files -u -- "$path" | grep -q .
}

source_repo_has_overlay() {
    local base_ref=""

    [ -d "$SOURCE_REPO_DIR/.git" ] || return 1
    base_ref="$(source_repo_overlay_base_ref 2>/dev/null || true)"

    if [ -n "$base_ref" ] && ! git -C "$SOURCE_REPO_DIR" diff --quiet --no-ext-diff "$base_ref...HEAD" --; then
        return 0
    fi

    ! git -C "$SOURCE_REPO_DIR" diff --quiet --no-ext-diff HEAD --
}

source_repo_overlay_signature() {
    local base_ref=""

    [ -d "$SOURCE_REPO_DIR/.git" ] || return 0
    base_ref="$(source_repo_overlay_base_ref 2>/dev/null || true)"

    if [ -z "$base_ref" ] && git -C "$SOURCE_REPO_DIR" diff --quiet --no-ext-diff HEAD --; then
        return 0
    fi

    if [ -n "$base_ref" ] && git -C "$SOURCE_REPO_DIR" diff --quiet --no-ext-diff "$base_ref...HEAD" -- && git -C "$SOURCE_REPO_DIR" diff --quiet --no-ext-diff HEAD --; then
        return 0
    fi

    {
        printf 'base_ref=%s\n' "$base_ref"
        if [ -n "$base_ref" ]; then
            git -C "$SOURCE_REPO_DIR" diff --binary "$base_ref...HEAD" --
        fi
        printf '\n--worktree--\n'
        git -C "$SOURCE_REPO_DIR" diff --binary HEAD --
    } | sha256sum | awk '{ print $1 }'
}

configure_managed_repo_fetch() {
    git -C "$MANAGED_REPO_DIR" config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
}

ensure_managed_repo() {
    local origin_url branch
    origin_url="$(repo_origin_url)" || return 1
    branch="$(repo_default_branch)"

    mkdir -p "$(dirname "$MANAGED_REPO_DIR")"
    if [ -d "$MANAGED_REPO_DIR/.git" ]; then
        git -C "$MANAGED_REPO_DIR" remote set-url origin "$origin_url"
        configure_managed_repo_fetch
        return 0
    fi

    rm -rf "$MANAGED_REPO_DIR"
    git clone --origin origin --branch "$branch" --single-branch "$origin_url" "$MANAGED_REPO_DIR" >/dev/null 2>&1 \
        || git clone --origin origin "$origin_url" "$MANAGED_REPO_DIR" >/dev/null
    configure_managed_repo_fetch
}

apply_source_overlay() {
    local path target_path base_ref
    source_repo_has_overlay || return 0
    base_ref="$(source_repo_overlay_base_ref 2>/dev/null || true)"

    while IFS= read -r path; do
        [ -n "$path" ] || continue
        [ -e "$SOURCE_REPO_DIR/$path" ] || continue
        source_repo_path_is_unmerged "$path" && continue
        target_path="$MANAGED_REPO_DIR/$path"
        mkdir -p "$(dirname "$target_path")"
        rm -rf "$target_path"
        cp -a "$SOURCE_REPO_DIR/$path" "$target_path"
    done < <(source_repo_overlay_paths "ACMRTXB" "$base_ref")

    while IFS= read -r path; do
        [ -n "$path" ] || continue
        rm -rf "$MANAGED_REPO_DIR/$path"
    done < <(source_repo_overlay_remove_paths "$base_ref")
}

copy_enabled_local_features() {
    local config_path source_local_root target_local_root feature_id source_dir target_dir

    config_path="${CODEX_LINUX_FEATURES_CONFIG:-}"
    if [ -z "$config_path" ] && [ -f "$SOURCE_REPO_DIR/linux-features/features.json" ]; then
        config_path="$SOURCE_REPO_DIR/linux-features/features.json"
    fi

    [ -f "$config_path" ] || return 0
    source_local_root="$SOURCE_REPO_DIR/linux-features/local"
    [ -d "$source_local_root" ] || return 0

    target_local_root="$MANAGED_REPO_DIR/linux-features/local"
    while IFS= read -r feature_id; do
        [ -n "$feature_id" ] || continue
        source_dir="$source_local_root/$feature_id"
        [ -f "$source_dir/feature.json" ] || continue

        # If the fetched wrapper gained a real top-level feature with this id,
        # prefer the upstream feature and do not create a duplicate local id.
        [ ! -f "$MANAGED_REPO_DIR/linux-features/$feature_id/feature.json" ] || continue

        target_dir="$target_local_root/$feature_id"
        mkdir -p "$(dirname "$target_dir")"
        rm -rf "$target_dir"
        cp -a "$source_dir" "$target_dir"
    done < <(python3 - "$config_path" <<'PY'
import json
import re
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        config = json.load(handle)
except Exception:
    raise SystemExit(0)

seen = set()
for item in config.get("enabled", []):
    if not isinstance(item, str):
        continue
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", item):
        continue
    if item in seen:
        continue
    seen.add(item)
    print(item)
PY
)
}

prepare_build_repo() {
    local branch managed_ref

    load_install_config
    if ! repo_origin_url >/dev/null 2>&1; then
        BUILD_REPO_DIR="$SOURCE_REPO_DIR"
        return 0
    fi

    ensure_managed_repo
    branch="$(repo_default_branch)"
    managed_ref="origin/$branch"

    git -C "$MANAGED_REPO_DIR" reset --hard >/dev/null
    git -C "$MANAGED_REPO_DIR" clean -fdx >/dev/null
    git -C "$MANAGED_REPO_DIR" fetch --prune origin
    if git -C "$MANAGED_REPO_DIR" show-ref --verify --quiet "refs/heads/$branch"; then
        git -C "$MANAGED_REPO_DIR" checkout -q "$branch"
    else
        git -C "$MANAGED_REPO_DIR" checkout -q -B "$branch" "$managed_ref"
    fi
    git -C "$MANAGED_REPO_DIR" reset --hard "$managed_ref" >/dev/null
    git -C "$MANAGED_REPO_DIR" clean -fdx >/dev/null
    apply_source_overlay
    copy_enabled_local_features
    BUILD_REPO_DIR="$MANAGED_REPO_DIR"
}

remote_dmg_headers() {
    curl -fsSIL "$DMG_URL" | tr -d '\r'
}

header_value() {
    local headers="$1"
    local name="$2"
    printf '%s\n' "$headers" | awk -F': ' -v target="$name" 'tolower($1) == tolower(target) { print $2; exit }'
}

extract_icon() {
    ensure_layout
    local dmg_file source_icon tmp_dir
    source_icon="$APP_DIR/.codex-linux/codex-desktop.png"
    if [ -f "$source_icon" ]; then
        cp "$source_icon" "$ICON_PATH"
        return 0
    fi

    source_icon="${SOURCE_REPO_DIR:-$REPO_DIR_DEFAULT}/assets/codex-linux.png"
    if [ -f "$source_icon" ]; then
        cp "$source_icon" "$ICON_PATH"
        return 0
    fi

    dmg_file="$(cached_dmg_file)"
    tmp_dir="$(mktemp -d)"
    trap 'rm -rf "$tmp_dir"' RETURN

    7z e -y "$dmg_file" "ChatGPT Installer/ChatGPT.app/Contents/Resources/electron.icns" "-o${tmp_dir}" >/dev/null
    python3 - "$tmp_dir/electron.icns" "$ICON_PATH" <<'PY'
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

    local build_repo_dir repo_head source_repo_head_value source_overlay_sha dmg_file dmg_sha256 dmg_size electron_version dmg_headers dmg_etag dmg_last_modified dmg_content_length build_time repo_origin
    build_repo_dir="$(effective_repo_dir)"

    if [ -d "$build_repo_dir/.git" ]; then
        repo_head="$(current_repo_head)"
        repo_origin="$(repo_origin_url 2>/dev/null || git -C "$build_repo_dir" remote get-url origin 2>/dev/null || printf '%s' unavailable)"
    else
        repo_head="unavailable"
        repo_origin="unavailable"
    fi
    dmg_file="$(cached_dmg_file)"
    if [ "${CODEX_USER_LOCAL_RECORD_DMG_FINGERPRINT:-0}" = "1" ] && [ -f "$dmg_file" ]; then
        dmg_sha256="$(sha256sum "$dmg_file" | awk '{ print $1 }')"
        dmg_size="$(stat -c '%s' "$dmg_file")"
    else
        dmg_sha256="unavailable"
        dmg_size="unavailable"
    fi
    electron_version="$(cat "$APP_DIR/version")"
    build_time="$(date -Iseconds)"
    source_repo_head_value="$(source_repo_head 2>/dev/null || true)"
    source_overlay_sha="$(source_repo_overlay_signature 2>/dev/null || true)"

    dmg_headers="$(remote_dmg_headers 2>/dev/null || true)"
    dmg_etag="$(header_value "$dmg_headers" "etag")"
    dmg_last_modified="$(header_value "$dmg_headers" "last-modified")"
    dmg_content_length="$(header_value "$dmg_headers" "content-length")"

    {
        write_kv BUILD_TIME "$build_time"
        write_kv REPO_ORIGIN "$repo_origin"
        write_kv REPO_HEAD "$repo_head"
        write_kv SOURCE_REPO_HEAD "$source_repo_head_value"
        write_kv SOURCE_OVERLAY_SHA256 "$source_overlay_sha"
        write_kv DMG_SHA256 "$dmg_sha256"
        write_kv DMG_SIZE "$dmg_size"
        write_kv DMG_ETAG "$dmg_etag"
        write_kv DMG_LAST_MODIFIED "$dmg_last_modified"
        write_kv DMG_CONTENT_LENGTH "$dmg_content_length"
        write_kv ELECTRON_VERSION "$electron_version"
        write_kv APP_DIR "$APP_DIR"
        write_kv ICON_PATH "$ICON_PATH"
        write_kv OPT_ROOT "$OPT_ROOT"
        write_kv REPO_DIR "$build_repo_dir"
        write_kv SOURCE_REPO_DIR "$SOURCE_REPO_DIR"
        write_kv MANAGED_REPO_DIR "$MANAGED_REPO_DIR"
    } > "$METADATA_FILE"
}
