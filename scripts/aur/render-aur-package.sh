#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

AUR_DIR="${AUR_DIR:-$REPO_DIR/dist/aur}"
AUR_PKGNAME="${AUR_PKGNAME:-codex-desktop-linux}"
AUR_PKGREL="${AUR_PKGREL:-1}"
AUR_SOURCE_REPO="${AUR_SOURCE_REPO:-https://github.com/ilysenko/codex-desktop-linux}"
AUR_SOURCE_REF="${AUR_SOURCE_REF:-$(git -C "$REPO_DIR" rev-parse HEAD)}"
AUR_SOURCE_SHA256="${AUR_SOURCE_SHA256:-SKIP}"
AUR_DMG_URL="${AUR_DMG_URL:-https://persistent.oaistatic.com/codex-app-prod/Codex.dmg}"
AUR_DMG_SHA256="${AUR_DMG_SHA256:-SKIP}"
AUR_PKGVER="${AUR_PKGVER:-}"

error() {
    echo "[ERROR] $*" >&2
    exit 1
}

sed_escape_replacement() {
    printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

validate_pkgver() {
    case "$1" in
        ""|*[-:[:space:]]*)
            error "AUR_PKGVER must be non-empty and cannot contain hyphens, colons, or whitespace"
            ;;
    esac
}

derive_pkgver() {
    local version
    version="$(git -C "$REPO_DIR" describe --tags --always --dirty 2>/dev/null || true)"
    version="${version#v}"
    version="${version//-/.}"
    version="${version//+/.}"
    version="${version//_/.}"
    version="${version//[^A-Za-z0-9.]/.}"
    version="${version#.}"
    version="${version%.}"
    if [ -z "$version" ]; then
        version="$(date -u +%Y.%m.%d.%H%M%S)"
    fi
    printf '%s\n' "$version"
}

render_template() {
    local template="$1"
    local target="$2"
    local aur_pkgname aur_pkgver aur_pkgrel source_repo source_ref source_sha dmg_url dmg_sha

    aur_pkgname="$(sed_escape_replacement "$AUR_PKGNAME")"
    aur_pkgver="$(sed_escape_replacement "$AUR_PKGVER")"
    aur_pkgrel="$(sed_escape_replacement "$AUR_PKGREL")"
    source_repo="$(sed_escape_replacement "$AUR_SOURCE_REPO")"
    source_ref="$(sed_escape_replacement "$AUR_SOURCE_REF")"
    source_sha="$(sed_escape_replacement "$AUR_SOURCE_SHA256")"
    dmg_url="$(sed_escape_replacement "$AUR_DMG_URL")"
    dmg_sha="$(sed_escape_replacement "$AUR_DMG_SHA256")"

    sed \
        -e "s/__AUR_PKGNAME__/$aur_pkgname/g" \
        -e "s/__PKGVER__/$aur_pkgver/g" \
        -e "s/__PKGREL__/$aur_pkgrel/g" \
        -e "s|__SOURCE_REPO__|$source_repo|g" \
        -e "s/__SOURCE_REF__/$source_ref/g" \
        -e "s/__SOURCE_SHA256__/$source_sha/g" \
        -e "s|__DMG_URL__|$dmg_url|g" \
        -e "s/__DMG_SHA256__/$dmg_sha/g" \
        "$template" > "$target"
}

main() {
    if [ -z "$AUR_PKGVER" ]; then
        AUR_PKGVER="$(derive_pkgver)"
    fi
    validate_pkgver "$AUR_PKGVER"

    mkdir -p "$AUR_DIR"
    render_template "$REPO_DIR/packaging/aur/PKGBUILD.template" "$AUR_DIR/PKGBUILD"
    cp "$REPO_DIR/packaging/aur/codex-desktop-linux.install" "$AUR_DIR/$AUR_PKGNAME.install"

    echo "[INFO] Rendered AUR package files in $AUR_DIR" >&2
    printf '%s\n' "$AUR_DIR"
}

main "$@"
