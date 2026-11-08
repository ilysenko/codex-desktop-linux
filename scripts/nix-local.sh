#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
    cat <<'HELP'
Usage: scripts/nix-local.sh <command> [#output] [Nix options...]
       scripts/nix-local.sh flake <check|show|metadata|archive|lock> [Nix options...]

Commands: build, run, develop, eval

Examples:
  scripts/nix-local.sh build '#codex-desktop' --no-link
  scripts/nix-local.sh develop
  scripts/nix-local.sh flake check --no-build
  scripts/nix-local.sh flake metadata --json

Uses this checkout as an explicit git+file input before Nix imports any source.
Only Git-tracked files are included, with their current working-tree contents.
Add new source files with git add first. A Git checkout is required; there is
no fallback to importing the whole directory as a path input.
HELP
}

die() { echo "[nix-local][ERROR] $*" >&2; exit 1; }

case "${1:-}" in
    -h|--help|help) usage; exit 0 ;;
    '') usage >&2; exit 1 ;;
esac

output=""
case "$1" in
    build|run|develop|eval)
        nix_command=("$1")
        shift
        case "${1:-}" in
            \#*|.\#*) output="${1#.}"; shift ;;
        esac
        ;;
    flake)
        case "${2:-}" in
            check|show|metadata|archive|lock) nix_command=(flake "$2"); shift 2 ;;
            *) die "Expected flake check, show, metadata, archive, or lock; see --help." ;;
        esac
        ;;
    *) die "Unsupported command: $1; see --help." ;;
esac

case "${1:-}" in
    ''|-*) ;;
    *) die "Use #output (before Nix options) to select an output; the source is always this Git checkout." ;;
esac

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
command -v git >/dev/null 2>&1 || die "Git is required; refusing a whole-directory path import."
git_root="$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null)" \
    || die "A Git checkout is required; clone the repository instead of using a source archive."
[ "$(cd -- "$git_root" && pwd -P)" = "$REPO_DIR" ] \
    || die "The script must belong to the Git repository root; refusing a parent repository or path import."
git -C "$REPO_DIR" ls-files --error-unmatch -- flake.nix >/dev/null 2>&1 \
    || die "flake.nix must be tracked by Git; run git add flake.nix first."

# A literal # or ? would change the flake reference, and % must not be decoded
# as an escape from the directory name. Encode UTF-8 paths byte by byte too.
encode_uri_path() {
    local LC_ALL=C
    local value="$1" encoded="" character escape index
    for ((index = 0; index < ${#value}; index++)); do
        character="${value:index:1}"
        case "$character" in
            [a-zA-Z0-9/._~-]) encoded+="$character" ;;
            *) printf -v escape '%%%02X' "'$character"; encoded+="$escape" ;;
        esac
    done
    printf '%s' "$encoded"
}

flake_ref="git+file://$(encode_uri_path "$REPO_DIR")${output}"
exec nix "${nix_command[@]}" "$flake_ref" "$@"
