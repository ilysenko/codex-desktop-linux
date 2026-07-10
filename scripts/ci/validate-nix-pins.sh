#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
FLAKE_FILE="${FLAKE_FILE:-$REPO_DIR/flake.nix}"
UPSTREAM_DMG_URL="${UPSTREAM_DMG_URL:-https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg}"
UPSTREAM_DMG_PATH="${1:-${UPSTREAM_DMG_PATH:-/tmp/Codex.dmg}}"
NATIVE_MODULES_PKG="${NATIVE_MODULES_PKG:-$REPO_DIR/nix/native-modules/package.json}"

# Opt-in pin-writing mode (used by refresh flows, not by PR CI). When set, the
# version pins are rewritten from the DMG before the assertions run, so they
# confirm the write instead of failing on drift. APPCAST_URL remains an optional
# caller-controlled guard for flows that explicitly want Sparkle appcast parity.
WRITE_PINS="${WRITE_PINS:-0}"
APPCAST_URL="${APPCAST_URL:-}"

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

find_seven_zip() {
    local candidate
    for candidate in 7zz 7z 7za; do
        if command -v "$candidate" >/dev/null 2>&1; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

read_nix_string() {
    local name="$1"
    python3 - "$FLAKE_FILE" "$name" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
name = re.escape(sys.argv[2])
match = re.search(rf'\b{name}\s*=\s*"([^"]+)";', text)
if not match:
    raise SystemExit(f"Could not find Nix string {sys.argv[2]!r}")
print(match.group(1))
PY
}

write_nix_string() {
    local name="$1"
    local value="$2"
    python3 - "$FLAKE_FILE" "$name" "$value" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
name = re.escape(sys.argv[2])
value = sys.argv[3]
text = path.read_text()
new_text, count = re.subn(
    rf'(\b{name}\s*=\s*")[^"]+(";)',
    lambda match: match.group(1) + value + match.group(2),
    text,
    count=1,
)
if count != 1:
    raise SystemExit(f"Could not write Nix string {sys.argv[2]!r}")
path.write_text(new_text)
PY
}

write_json_dep() {
    local file="$1"
    local dep="$2"
    local value="$3"
    node -e '
const fs = require("fs");
const [file, dep, value] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
if (!pkg.dependencies || !(dep in pkg.dependencies)) {
  console.error(`missing dependency ${dep} in ${file}`);
  process.exit(1);
}
pkg.dependencies[dep] = value;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$file" "$dep" "$value"
}

fetch_appcast_latest_version() {
    local url="$1"
    curl -fsSL --retry 3 "$url" | python3 -c '
import re
import sys

xml = sys.stdin.read()
# Appcast items are newest-first; the first shortVersionString is the latest.
match = re.search(r"<sparkle:shortVersionString>([^<]+)</sparkle:shortVersionString>", xml)
if not match:
    sys.exit("Could not find sparkle:shortVersionString in appcast")
sys.stdout.write(match.group(1).strip())
'
}

read_nix_fetchurl_field() {
    local binding="$1"
    local field="$2"
    python3 - "$FLAKE_FILE" "$binding" "$field" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
binding = re.escape(sys.argv[2])
field = re.escape(sys.argv[3])
block_match = re.search(rf'\b{binding}\s*=\s*pkgs\.fetchurl\s*\{{(?P<body>.*?)\n\s*\}};', text, re.S)
if not block_match:
    raise SystemExit(f"Could not find fetchurl block {sys.argv[2]!r}")
field_match = re.search(rf'\b{field}\s*=\s*"([^"]+)";', block_match.group("body"))
if not field_match:
    raise SystemExit(f"Could not find field {sys.argv[3]!r} in {sys.argv[2]!r}")
print(field_match.group(1))
PY
}

json_file_field() {
    local json_path="$1"
    local expression="$2"

    node -e "const value = require(process.argv[1]); process.stdout.write(String($expression ?? ''));" "$json_path"
}

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

read_plist_key() {
    local plist_path="$1"
    local key="$2"

    python3 - "$plist_path" "$key" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    print(plistlib.load(handle).get(sys.argv[2], ""))
PY
}

detect_dmg_electron_version() {
    local app_dir="$1"
    local asar_extract_dir="$2"
    local detected=""
    local detected_version=""
    local plist_path="$app_dir/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist"

    if [ -f "$plist_path" ]; then
        detected="$(read_plist_key "$plist_path" CFBundleVersion)"
        if detected_version="$(sanitize_electron_version "$detected")"; then
            echo "$detected_version"
            return 0
        fi
    fi

    detected="$(json_file_field "$asar_extract_dir/package.json" "(value.devDependencies?.electron || value.dependencies?.electron)")"
    if detected_version="$(sanitize_electron_version "$detected")"; then
        echo "$detected_version"
        return 0
    fi

    fail "Could not find Electron version in DMG"
}

assert_equal() {
    local label="$1"
    local expected="$2"
    local actual="$3"

    if [ "$expected" != "$actual" ]; then
        fail "$label mismatch: expected '$expected', got '$actual'"
    fi
    echo "OK: $label = $actual"
}

if [ ! -s "$UPSTREAM_DMG_PATH" ]; then
    mkdir -p "$(dirname "$UPSTREAM_DMG_PATH")"
    curl -fL --retry 3 -o "$UPSTREAM_DMG_PATH" "$UPSTREAM_DMG_URL"
fi

SEVEN_ZIP_CMD="$(find_seven_zip)" || fail "7z/7zz/7za not found"
WORK_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

"$SEVEN_ZIP_CMD" x -y -snl "$UPSTREAM_DMG_PATH" -o"$WORK_DIR/dmg" >/dev/null 2>&1 || true
APP_DIR="$(find "$WORK_DIR/dmg" -maxdepth 3 -name "*.app" -type d | head -1)"
[ -n "$APP_DIR" ] || fail "Could not find .app bundle in $UPSTREAM_DMG_PATH"

ASAR_PATH="$APP_DIR/Contents/Resources/app.asar"
[ -f "$ASAR_PATH" ] || fail "Could not find app.asar in DMG"
ASAR_EXTRACT_DIR="$WORK_DIR/app-extracted"
npx --yes asar extract "$ASAR_PATH" "$ASAR_EXTRACT_DIR"

dmg_electron_version="$(detect_dmg_electron_version "$APP_DIR" "$ASAR_EXTRACT_DIR")"
dmg_codex_version="$(json_file_field "$ASAR_EXTRACT_DIR/package.json" "value.version")"
dmg_better_sqlite3_version="$(json_file_field "$ASAR_EXTRACT_DIR/node_modules/better-sqlite3/package.json" "value.version")"
dmg_node_pty_version="$(json_file_field "$ASAR_EXTRACT_DIR/node_modules/node-pty/package.json" "value.version")"

nix_codex_version="$(read_nix_string codexVersion)"
nix_electron_version="$(read_nix_string electronVersion)"
native_electron_version="$(node -p "require('$REPO_DIR/nix/native-modules/package.json').dependencies.electron")"
native_better_sqlite3_version="$(node -p "require('$REPO_DIR/nix/native-modules/package.json').dependencies['better-sqlite3']")"
native_node_pty_version="$(node -p "require('$REPO_DIR/nix/native-modules/package.json').dependencies['node-pty']")"

if [ "$WRITE_PINS" = "1" ]; then
    if [ -n "$APPCAST_URL" ]; then
        appcast_latest_version="$(fetch_appcast_latest_version "$APPCAST_URL")"
        echo "Appcast latest version: $appcast_latest_version"
        echo "DMG codex version:      $dmg_codex_version"
        if [ "$dmg_codex_version" != "$appcast_latest_version" ]; then
            echo "DMG ($dmg_codex_version) is not yet aligned with the appcast latest ($appcast_latest_version);" >&2
            echo "upstream rollout in progress, skipping pin update (exit 75)." >&2
            exit 75
        fi
    fi

    write_nix_string codexVersion "$dmg_codex_version"
    write_nix_string electronVersion "$dmg_electron_version"
    write_json_dep "$NATIVE_MODULES_PKG" electron "$dmg_electron_version"
    write_json_dep "$NATIVE_MODULES_PKG" better-sqlite3 "$dmg_better_sqlite3_version"
    write_json_dep "$NATIVE_MODULES_PKG" node-pty "$dmg_node_pty_version"

    # Re-read so the assertions below confirm the writes landed.
    nix_codex_version="$(read_nix_string codexVersion)"
    nix_electron_version="$(read_nix_string electronVersion)"
    native_electron_version="$(node -p "require('$NATIVE_MODULES_PKG').dependencies.electron")"
    native_better_sqlite3_version="$(node -p "require('$NATIVE_MODULES_PKG').dependencies['better-sqlite3']")"
    native_node_pty_version="$(node -p "require('$NATIVE_MODULES_PKG').dependencies['node-pty']")"
fi

assert_equal "Codex app version pin" "$dmg_codex_version" "$nix_codex_version"
assert_equal "Electron version pin" "$dmg_electron_version" "$nix_electron_version"
assert_equal "native-modules Electron pin" "$nix_electron_version" "$native_electron_version"
assert_equal "native-modules better-sqlite3 pin" "$dmg_better_sqlite3_version" "$native_better_sqlite3_version"
assert_equal "native-modules node-pty pin" "$dmg_node_pty_version" "$native_node_pty_version"

flake_node_repl_url="$(read_nix_fetchurl_field browserUseNodeReplRuntime url)"
flake_node_repl_sri="$(read_nix_fetchurl_field browserUseNodeReplRuntime hash)"
installer_node_repl_url="$(python3 - "$REPO_DIR/scripts/lib/bundled-plugins.sh" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
match = re.search(r'CODEX_BROWSER_USE_NODE_REPL_RUNTIME_URL:-([^}"]+)', text)
if not match:
    raise SystemExit("Could not find Browser Use node_repl default URL")
print(match.group(1))
PY
)"
installer_node_repl_sha="$(python3 - "$REPO_DIR/scripts/lib/bundled-plugins.sh" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
match = re.search(r'CODEX_BROWSER_USE_NODE_REPL_RUNTIME_SHA256:-([0-9a-f]{64})', text)
if not match:
    raise SystemExit("Could not find Browser Use node_repl default SHA-256")
print(match.group(1))
PY
)"
flake_node_repl_sha="$(python3 - "$flake_node_repl_sri" <<'PY'
import base64
import sys

sri = sys.argv[1]
if not sri.startswith("sha256-"):
    raise SystemExit("Browser Use node_repl flake hash is not an SRI sha256")
print(base64.b64decode(sri.removeprefix("sha256-")).hex())
PY
)"

assert_equal "Browser Use node_repl URL pin" "$installer_node_repl_url" "$flake_node_repl_url"
assert_equal "Browser Use node_repl SHA-256 pin" "$installer_node_repl_sha" "$flake_node_repl_sha"

echo "Nix pins match the upstream DMG and installer defaults."
