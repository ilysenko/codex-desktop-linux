#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
FLAKE_FILE="${FLAKE_FILE:-$REPO_DIR/flake.nix}"
UPSTREAM_DMG_URL="${UPSTREAM_DMG_URL:-https://persistent.oaistatic.com/codex-app-prod/Codex.dmg}"
UPSTREAM_DMG_PATH="${UPSTREAM_DMG_PATH:-/tmp/Codex.dmg}"
VERIFY_LOG="${VERIFY_LOG:-/tmp/codex-nix-build-verify.log}"

PACKAGE_OUTPUTS=(
    ".#codex-desktop"
    ".#codex-desktop-computer-use-ui"
    ".#codex-desktop-remote-mobile-control"
    ".#codex-desktop-computer-use-ui-remote-mobile-control"
    ".#codex-desktop-remote-control-ui"
    ".#codex-desktop-computer-use-ui-remote-control-ui"
    ".#codex-desktop-remote-control"
    ".#codex-desktop-computer-use-ui-remote-control"
    ".#installer"
)

validate_sri_hash() {
    local hash="$1"
    [[ "$hash" =~ ^sha256-[A-Za-z0-9+/=]{44}$ ]]
}

replace_flake_hash() {
    local anchor="$1"
    local key="$2"
    local new_hash="$3"

    python3 - "$FLAKE_FILE" "$anchor" "$key" "$new_hash" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
anchor = sys.argv[2]
key = sys.argv[3]
new_hash = sys.argv[4]

lines = path.read_text().splitlines(keepends=True)
in_block = False
for index, line in enumerate(lines):
    if anchor in line:
        in_block = True
        continue
    if not in_block:
        continue
    if key in line:
        lines[index] = re.sub(r'sha256-[^"]+', new_hash, line, count=1)
        path.write_text("".join(lines))
        raise SystemExit(0)
    if line.strip() == "};":
        break

raise SystemExit(f"Could not find {key!r} after {anchor!r} in {path}")
PY
}

read_flake_hash() {
    local anchor="$1"
    local key="$2"

    python3 - "$FLAKE_FILE" "$anchor" "$key" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
anchor = sys.argv[2]
key = sys.argv[3]

in_block = False
for line in path.read_text().splitlines():
    if anchor in line:
        in_block = True
        continue
    if not in_block:
        continue
    if key in line:
        match = re.search(r'sha256-[^"]+', line)
        if match:
            print(match.group(0))
            raise SystemExit(0)
    if line.strip() == "};":
        break

raise SystemExit(f"Could not find {key!r} after {anchor!r} in {path}")
PY
}

run_nix_build() {
    local log_path="$1"
    shift
    rm -f "$log_path"
    set +e
    nix build "$@" --no-link --print-build-logs >"$log_path" 2>&1
    local status="$?"
    set -e
    cat "$log_path"
    return "$status"
}

main() {
    mkdir -p "$(dirname "$UPSTREAM_DMG_PATH")"
    curl -fL --retry 3 -o "$UPSTREAM_DMG_PATH" "$UPSTREAM_DMG_URL"

    new_dmg_hash="$(nix hash file --sri --type sha256 "$UPSTREAM_DMG_PATH")"
    if ! validate_sri_hash "$new_dmg_hash"; then
        echo "Refusing to proceed: computed DMG hash '$new_dmg_hash' is not a valid SRI sha256." >&2
        exit 1
    fi

    current_dmg_hash="$(read_flake_hash "codexDmg = pkgs.fetchurl {" "hash = ")"
    echo "Current Codex.dmg hash:  $current_dmg_hash"
    echo "Upstream Codex.dmg hash: $new_dmg_hash"
    replace_flake_hash "codexDmg = pkgs.fetchurl {" "hash = " "$new_dmg_hash"

    # Seed the Nix store so the verification build can reuse the DMG that was
    # already downloaded for hashing instead of fetching the same artifact again.
    nix-store --add-fixed sha256 "$UPSTREAM_DMG_PATH" >/dev/null

    "$REPO_DIR/scripts/ci/validate-nix-pins.sh" "$UPSTREAM_DMG_PATH"
    run_nix_build "$VERIFY_LOG" "${PACKAGE_OUTPUTS[@]}"
    echo "Nix builds succeeded after refreshing the Codex.dmg hash."
}

case "${1:-}" in
    read-flake-hash)
        if [ "$#" -ne 3 ]; then
            echo "usage: $0 read-flake-hash <anchor> <key>" >&2
            exit 2
        fi
        read_flake_hash "$2" "$3"
        ;;
    "")
        main
        ;;
    *)
        echo "unknown command: $1" >&2
        exit 2
        ;;
esac
