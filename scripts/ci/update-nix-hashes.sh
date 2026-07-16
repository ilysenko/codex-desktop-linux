#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
FLAKE_FILE="${FLAKE_FILE:-$REPO_DIR/flake.nix}"
UPSTREAM_DMG_URL="${UPSTREAM_DMG_URL:-https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg}"
UPSTREAM_DMG_PATH="${UPSTREAM_DMG_PATH:-/tmp/Codex.dmg}"
VERIFY_LOG="${VERIFY_LOG:-/tmp/codex-nix-build-verify.log}"
# Upstream Codex Sparkle appcast (x64 runners). Used only for reporting when it
# lags behind the moving Codex.dmg; the verified DMG payload is the pin source.
APPCAST_URL="${APPCAST_URL:-https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml}"

PACKAGE_OUTPUTS=(
    ".#codex-desktop"
    ".#codex-desktop-computer-use-ui"
    ".#codex-desktop-remote-mobile-control"
    ".#codex-desktop-computer-use-ui-remote-mobile-control"
    ".#installer"
)

if [ -n "${NIX_VERIFY_OUTPUTS:-}" ]; then
    PACKAGE_OUTPUTS=()
    while IFS= read -r output; do
        [ -n "$output" ] || continue
        if [[ ! "$output" =~ ^\.#[A-Za-z0-9._+-]+$ ]]; then
            echo "Invalid Nix verification output: $output" >&2
            exit 2
        fi
        PACKAGE_OUTPUTS+=("$output")
    done <<< "$NIX_VERIFY_OUTPUTS"
    if [ "${#PACKAGE_OUTPUTS[@]}" -eq 0 ]; then
        echo "NIX_VERIFY_OUTPUTS did not contain any outputs." >&2
        exit 2
    fi
fi

NIX_PIN_DIFF_PATHS=(
    "flake.nix"
    "nix/native-modules/package.json"
    "nix/native-modules/package-lock.json"
)

validate_sri_hash() {
    local hash="$1"
    [[ "$hash" =~ ^sha256-[A-Za-z0-9+/=]{44}$ ]]
}

read_flake_string() {
    local name="$1"
    grep -m1 "$name = " "$FLAKE_FILE" | sed 's/.*"\(.*\)".*/\1/'
}

fetch_appcast_latest_version() {
    local url="${1:-$APPCAST_URL}"
    curl -fsSL --retry 3 "$url" | python3 -c '
import re
import sys

xml = sys.stdin.read()
match = re.search(r"<sparkle:shortVersionString>([^<]+)</sparkle:shortVersionString>", xml)
if not match:
    sys.exit("Could not find sparkle:shortVersionString in appcast")
sys.stdout.write(match.group(1).strip())
'
}

prefetch_sri() {
    local url="$1"
    nix store prefetch-file --json --hash-type sha256 "$url" \
        | python3 -c 'import sys, json; print(json.load(sys.stdin)["hash"])'
}

# When electronVersion changes, the electron zip + headers URLs move to the new
# version while flake.nix keeps the old fixed-output hashes, so the verify build
# would fail. Refresh both per-arch electron zip hashes and the headers hash.
refresh_electron_hashes() {
    local version="$1"
    local base="https://github.com/electron/electron/releases/download/v${version}"
    replace_flake_hash "x86_64-linux = {" "hash = " \
        "$(prefetch_sri "${base}/electron-v${version}-linux-x64.zip")"
    replace_flake_hash "aarch64-linux = {" "hash = " \
        "$(prefetch_sri "${base}/electron-v${version}-linux-arm64.zip")"
    replace_flake_hash "electronHeaders = pkgs.fetchurl {" "hash = " \
        "$(prefetch_sri "https://artifacts.electronjs.org/headers/dist/v${version}/node-v${version}-headers.tar.gz")"
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

nix_pin_files_changed() {
    ! git -C "$REPO_DIR" diff --quiet -- "${NIX_PIN_DIFF_PATHS[@]}"
}

main() {
    mkdir -p "$(dirname "$UPSTREAM_DMG_PATH")"
    curl -fL --retry 3 -o "$UPSTREAM_DMG_PATH" "$UPSTREAM_DMG_URL"

    new_dmg_hash="$(nix hash file --sri --type sha256 "$UPSTREAM_DMG_PATH")"
    if ! validate_sri_hash "$new_dmg_hash"; then
        echo "Refusing to proceed: computed DMG hash '$new_dmg_hash' is not a valid SRI sha256." >&2
        exit 1
    fi

    # Refresh the version pins (codexVersion/electronVersion + native-modules)
    # from the current upstream DMG. The appcast can lag the moving DMG for many
    # hours, so it is reported as metadata instead of blocking the refresh PR.
    local old_electron_version
    old_electron_version="$(read_flake_string electronVersion)"

    local appcast_latest_version=""
    if appcast_latest_version="$(fetch_appcast_latest_version "$APPCAST_URL" 2>/dev/null)"; then
        echo "Appcast latest version: $appcast_latest_version"
    else
        echo "WARN: Could not read upstream appcast version from $APPCAST_URL; continuing with Codex.dmg pins." >&2
    fi

    WRITE_PINS=1 APPCAST_URL= "$REPO_DIR/scripts/ci/validate-nix-pins.sh" "$UPSTREAM_DMG_PATH"

    # If the Electron pin moved, refresh its fixed-output hashes so the verify
    # build does not fail on the new download URLs.
    local new_electron_version
    new_electron_version="$(read_flake_string electronVersion)"
    local new_codex_version
    new_codex_version="$(read_flake_string codexVersion)"
    if [ -n "$appcast_latest_version" ] && [ "$new_codex_version" != "$appcast_latest_version" ]; then
        echo "WARN: Appcast latest version ($appcast_latest_version) differs from Codex.dmg version ($new_codex_version); proceeding with verified DMG pins." >&2
    fi
    if [ "$old_electron_version" != "$new_electron_version" ]; then
        echo "Electron pin: $old_electron_version -> $new_electron_version; refreshing electron hashes."
        refresh_electron_hashes "$new_electron_version"
    fi

    # Regenerate the native-module lockfile whenever its package.json changed, so
    # the committed refresh stays reproducible for importNpmLock / npm ci.
    if ! git -C "$REPO_DIR" diff --quiet -- nix/native-modules/package.json; then
        echo "native-modules package.json changed; regenerating package-lock.json."
        ( cd "$REPO_DIR/nix/native-modules" && npm install --package-lock-only --ignore-scripts >/dev/null )
    fi

    current_dmg_hash="$(read_flake_hash "codexDmg = pkgs.fetchurl {" "hash = ")"
    echo "Current Codex.dmg hash:  $current_dmg_hash"
    echo "Upstream Codex.dmg hash: $new_dmg_hash"
    replace_flake_hash "codexDmg = pkgs.fetchurl {" "hash = " "$new_dmg_hash"

    if ! nix_pin_files_changed; then
        echo "Nix pins unchanged; skipping package-output verification."
        return 0
    fi

    if [ -n "${NIX_COMPARE_REF:-}" ]; then
        if ! git -C "$REPO_DIR" rev-parse --verify --quiet "$NIX_COMPARE_REF^{commit}" >/dev/null; then
            echo "Nix comparison ref is unavailable; continuing with verification: $NIX_COMPARE_REF"
        elif git -C "$REPO_DIR" diff --quiet "$NIX_COMPARE_REF" -- "${NIX_PIN_DIFF_PATHS[@]}"; then
            echo "Nix pins already match $NIX_COMPARE_REF; skipping duplicate package-output verification."
            return 0
        fi
    fi

    # Seed the Nix store so the verification build can reuse the DMG that was
    # already downloaded for hashing instead of fetching the same artifact again.
    nix-store --add-fixed sha256 "$UPSTREAM_DMG_PATH" >/dev/null

    run_nix_build "$VERIFY_LOG" "${PACKAGE_OUTPUTS[@]}"
    echo "Nix builds succeeded after refreshing the upstream pins and Codex.dmg hash."
}

case "${1:-}" in
    read-flake-hash)
        if [ "$#" -ne 3 ]; then
            echo "usage: $0 read-flake-hash <anchor> <key>" >&2
            exit 2
        fi
        read_flake_hash "$2" "$3"
        ;;
    read-flake-string)
        if [ "$#" -ne 2 ]; then
            echo "usage: $0 read-flake-string <name>" >&2
            exit 2
        fi
        read_flake_string "$2"
        ;;
    read-appcast-version)
        if [ "$#" -gt 2 ]; then
            echo "usage: $0 read-appcast-version [url]" >&2
            exit 2
        fi
        fetch_appcast_latest_version "${2:-$APPCAST_URL}"
        ;;
    "")
        main
        ;;
    *)
        echo "unknown command: $1" >&2
        exit 2
        ;;
esac
