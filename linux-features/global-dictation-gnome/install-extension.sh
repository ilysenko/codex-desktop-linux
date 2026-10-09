#!/usr/bin/env bash
# Per-user source synchronization only. Never enables the extension.
set -Eeuo pipefail
umask 077
uuid='global-dictation-gnome@chatgpt-community.local'
marker='.chatgpt-community-owned.sha256'
next='' backup='' lock='' locked=0 moved=0
warn() { printf 'WARN: GNOME dictation companion: %s\n' "$*" >&2; }
skip() { warn "$*"; exit 0; }
cleanup() {
    if (( moved )) && [[ -n "$backup" && -d "$backup" ]]; then
        if [[ ! -e "$destination" && ! -L "$destination" ]]; then
            mv -- "$backup" "$destination" || warn "Restore failed; preserved previous extension at $backup"
        else
            warn "Previous extension preserved at $backup; inspect before manual recovery"
        fi
    fi
    [[ -z "$next" ]] || rm -rf -- "$next"
    if (( locked )); then rmdir -- "$lock" || true; fi
}
trap cleanup EXIT
trap 'warn "Source sync failed; application launch will continue"; exit 0' ERR
trap 'warn "Source sync interrupted"; exit 0' HUP INT TERM

case ":${XDG_CURRENT_DESKTOP:-}:" in
    *:GNOME:*) ;;
    *) skip 'Active desktop is not GNOME (XDG_CURRENT_DESKTOP must contain a GNOME component)' ;;
esac
[[ -z "${XDG_SESSION_CLASS:-}" || "${XDG_SESSION_CLASS:-}" == user ]] ||
    skip 'Not a user session (XDG_SESSION_CLASS must be user when set)'

uid="$(id -u)" || skip 'Cannot determine user identity'
[[ "$uid" =~ ^[0-9]+$ && "$uid" != 0 ]] || skip 'Refusing to install as root or with an invalid user identity'
version="$(timeout --kill-after=1s 2s gnome-shell --version)" || skip 'Cannot determine GNOME Shell version within timeout'
[[ "$version" =~ ^GNOME\ Shell\ (45|46|47|48|49|50)(\.|$) ]] || skip "Unsupported GNOME Shell version: $version"

# Root may own shared ancestors; installed extension state must belong to this UID.
trusted_permissions() {
    local path="$1" ownership="${2:-ancestor}" metadata owner mode
    metadata="$(stat -c '%u %a' -- "$path")" || return 1
    read -r owner mode <<< "$metadata"
    [[ "$owner" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
    if [[ "$ownership" == user ]]; then
        [[ "$owner" == "$uid" ]] || return 1
    else
        [[ "$owner" == 0 || "$owner" == "$uid" ]] || return 1
    fi
    (( (8#$mode & 0022) == 0 ))
}

# Reject ambiguous paths, symlinks and externally writable ancestors before writes.
safe_path() {
    local path="$1" part current=''
    [[ "$path" == /* && "$path" != / && ! "$path" =~ [[:cntrl:]] ]] || return 1
    trusted_permissions / || return 1
    local -a parts
    IFS=/ read -r -a parts <<< "$path"
    for part in "${parts[@]}"; do
        [[ -z "$part" ]] && continue
        [[ "$part" != . && "$part" != .. ]] || return 1
        current="$current/$part"
        [[ ! -L "$current" ]] || return 1
        if [[ -e "$current" ]]; then
            [[ -d "$current" ]] && trusted_permissions "$current" || return 1
        fi
    done
}
if [[ -n "${XDG_DATA_HOME:-}" ]]; then
    data="$XDG_DATA_HOME"
else
    [[ -n "${HOME:-}" ]] || skip 'HOME and XDG_DATA_HOME are unavailable'
    data="$HOME/.local/share"
fi
safe_path "$data" || skip 'Unsafe data directory (trusted owner, no group/other write, absolute non-symlink path required)'
parent="$data/gnome-shell/extensions"
safe_path "$parent" || skip 'Unsafe extension parent directory'
[[ -n "${CODEX_LINUX_APP_DIR:-}" && -n "${CODEX_LINUX_FEATURES_DIR:-}" ]] || skip 'Missing launcher paths'
helper="$CODEX_LINUX_APP_DIR/resources/native/codex-global-dictation-linux"
[[ -f "$helper" && -x "$helper" ]] || skip 'Installed dictation helper is not executable'
helper="$(realpath -e -- "$helper")"
[[ "$helper" == /* && ! "$helper" =~ [[:cntrl:]] ]] || skip 'Unsafe helper path'
source_dir="$CODEX_LINUX_FEATURES_DIR/global-dictation-gnome/extension"
[[ -d "$source_dir" && ! -L "$source_dir" ]] || skip 'Extension source is missing or symlinked'
for file in extension.js metadata.json; do
    [[ -f "$source_dir/$file" && ! -L "$source_dir/$file" ]] || skip "Unsafe or missing source $file"
done
mkdir -p -- "$parent"
safe_path "$parent" || skip 'Extension parent changed during setup'
destination="$parent/$uuid"
lock="$parent/.$uuid.lock"
mkdir -- "$lock" 2>/dev/null || skip 'Another sync is active (or a stale lock needs manual inspection)'
locked=1

manifest() {
    printf '%s\n' "ChatGPT Community managed extension v1: $uuid"
    (cd -- "$1"; sha256sum -- config.json extension.js metadata.json)
}
managed() {
    local dir="$1" count
    [[ -d "$dir" && ! -L "$dir" && -f "$dir/$marker" && ! -L "$dir/$marker" ]] || return 1
    trusted_permissions "$dir" user || return 1
    # Fixed flat inventory excludes extra files, subdirectories, and every symlink.
    count="$(find "$dir" -mindepth 1 -maxdepth 1 -printf '. ' | wc -w)"
    [[ "$count" == 4 ]] || return 1
    for file in config.json extension.js metadata.json "$marker"; do
        [[ -f "$dir/$file" && ! -L "$dir/$file" ]] || return 1
        trusted_permissions "$dir/$file" user || return 1
    done
    cmp -s -- "$dir/$marker" <(manifest "$dir")
}
if [[ -e "$destination" || -L "$destination" ]]; then
    managed "$destination" || skip 'Unmanaged or modified extension directory; preserving it unchanged'
fi

escaped="${helper//\\/\\\\}"
escaped="${escaped//\"/\\\"}"
if [[ -d "$destination" ]] &&
    cmp -s -- "$source_dir/extension.js" "$destination/extension.js" &&
    cmp -s -- "$source_dir/metadata.json" "$destination/metadata.json" &&
    cmp -s -- "$destination/config.json" <(printf '{"helperPath":"%s"}\n' "$escaped"); then
    exit 0
fi

# All scratch and backups stay beside the destination, on the same filesystem.
next="$(mktemp -d "$parent/.$uuid.next.XXXXXXXX")"
for file in extension.js metadata.json; do
    install -m 0644 -- "$source_dir/$file" "$next/$file"
done
printf '{"helperPath":"%s"}\n' "$escaped" > "$next/config.json"
manifest "$next" > "$next/$marker"
chmod 0644 -- "$next/config.json" "$next/$marker"
chmod 0755 -- "$next"

if [[ -d "$destination" ]]; then
    # Detect edits before and immediately after moving the previous installation.
    managed "$destination" || skip 'Extension changed during sync; preserving it'
    backup="$(mktemp -d "$parent/.$uuid.previous.XXXXXXXX")"
    rmdir -- "$backup"
    # Arm restoration before the rename, including signals immediately after it.
    moved=1
    mv -- "$destination" "$backup"
    managed "$backup" || skip "Backup changed during rename; restoring user changes to $destination (backup: $backup)"
fi
[[ ! -e "$destination" && ! -L "$destination" ]] || skip 'Destination appeared during sync; refusing replacement'
mv -T -- "$next" "$destination"
next=''
moved=0
if [[ -n "$backup" ]]; then
    # Edits through an open file or the renamed path may arrive during promotion.
    if managed "$backup"; then
        rm -rf -- "$backup"
    else
        warn "Preserved user changes at $backup; inspect before manual removal"
    fi
fi
printf 'Installed/updated ChatGPT Community GNOME dictation companion. Enable %s explicitly with gnome-extensions enable; log out and back in after JavaScript source updates. Helper-path configuration is reloaded for each Paste. No extension was auto-enabled.\n' "$uuid" >&2
