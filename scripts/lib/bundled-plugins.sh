#!/bin/bash
# Bundled-plugin staging — Browser Use, Chrome, Linux Computer Use, manifests, marketplace.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

# ---- Install Linux-safe bundled plugin resources ----
find_cargo_for_linux_computer_use() {
    if command -v cargo >/dev/null 2>&1; then
        command -v cargo
        return 0
    fi

    if [ -x "$HOME/.cargo/bin/cargo" ]; then
        echo "$HOME/.cargo/bin/cargo"
        return 0
    fi

    return 1
}

build_linux_computer_use_backend() {
    local crate_dir="$SCRIPT_DIR/computer-use-linux"
    local backend_binary="$SCRIPT_DIR/target/release/codex-computer-use-linux"
    local cosmic_helper_binary="$SCRIPT_DIR/target/release/codex-computer-use-cosmic"
    local cargo_cmd=""

    if [ -n "${CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE:-}" ] || [ -n "${CODEX_LINUX_COMPUTER_USE_COSMIC_SOURCE:-}" ]; then
        [ -n "${CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE:-}" ] || warn "CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE is not set"
        [ -n "${CODEX_LINUX_COMPUTER_USE_COSMIC_SOURCE:-}" ] || warn "CODEX_LINUX_COMPUTER_USE_COSMIC_SOURCE is not set"
        [ -x "${CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE:-}" ] || return 1
        [ -x "${CODEX_LINUX_COMPUTER_USE_COSMIC_SOURCE:-}" ] || return 1
        info "Using prebuilt Linux Computer Use backend"
        printf '%s\n%s\n' "$CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE" "$CODEX_LINUX_COMPUTER_USE_COSMIC_SOURCE"
        return 0
    fi

    if [ ! -d "$crate_dir" ]; then
        warn "Linux Computer Use backend source not found at $crate_dir"
        return 1
    fi

    if ! cargo_cmd="$(find_cargo_for_linux_computer_use)"; then
        warn "cargo not found; Linux Computer Use plugin will be unavailable"
        return 1
    fi

    info "Building Linux Computer Use backend..."
    if ! (cd "$SCRIPT_DIR" && "$cargo_cmd" build --release -p codex-computer-use-linux >&2); then
        warn "Failed to build Linux Computer Use backend"
        return 1
    fi

    [ -x "$backend_binary" ] || {
        warn "Linux Computer Use backend binary missing after build: $backend_binary"
        return 1
    }

    [ -x "$cosmic_helper_binary" ] || {
        warn "Linux Computer Use COSMIC helper binary missing after build: $cosmic_helper_binary"
        return 1
    }

    printf '%s\n%s\n' "$backend_binary" "$cosmic_helper_binary"
}

stage_linux_computer_use_plugin() {
    local target_plugins="$1"
    local plugin_template="$SCRIPT_DIR/plugins/openai-bundled/plugins/computer-use"
    local build_outputs=""
    local backend_binary=""
    local cosmic_helper_binary=""
    local target_plugin="$target_plugins/computer-use"

    if [ ! -d "$plugin_template" ]; then
        warn "Linux Computer Use plugin template not found at $plugin_template"
        return 1
    fi

    if ! build_outputs="$(build_linux_computer_use_backend)"; then
        return 1
    fi
    backend_binary="$(printf '%s\n' "$build_outputs" | sed -n '1p')"
    cosmic_helper_binary="$(printf '%s\n' "$build_outputs" | sed -n '2p')"

    rm -rf "$target_plugin"
    mkdir -p "$target_plugin"
    cp -R "$plugin_template/." "$target_plugin/"
    mkdir -p "$target_plugin/bin"
    cp "$backend_binary" "$target_plugin/bin/codex-computer-use-linux"
    cp "$cosmic_helper_binary" "$target_plugin/bin/codex-computer-use-cosmic"
    chmod 0755 "$target_plugin/bin/codex-computer-use-linux"
    chmod 0755 "$target_plugin/bin/codex-computer-use-cosmic"

    if [ -f "$ICON_SOURCE" ]; then
        mkdir -p "$target_plugin/assets"
        cp "$ICON_SOURCE" "$target_plugin/assets/app-icon.png"
    fi

    find "$target_plugin" \( -name '*:com.apple.*' -o -name '.gitkeep' \) -delete
    return 0
}

is_host_linux_elf_executable() {
    local file="$1"
    python3 - "$file" "$ARCH" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
arch = sys.argv[2]
expected_machine = {
    "x86_64": 62,
    "aarch64": 183,
    "armv7l": 40,
    "armv6l": 40,
    "armhf": 40,
}.get(arch)
if expected_machine is None:
    sys.exit(1)

try:
    header = path.read_bytes()[:20]
except OSError:
    sys.exit(1)

if len(header) < 20 or header[:4] != b"\x7fELF":
    sys.exit(1)

is_little_endian = header[5] == 1
if not is_little_endian:
    sys.exit(1)

machine = int.from_bytes(header[18:20], "little")
sys.exit(0 if machine == expected_machine else 1)
PY
}

install_linux_executable_resource() {
    local source="$1"
    local destination="$2"
    local label="$3"
    local log_level="${4:-warn}"

    if [ ! -f "$source" ]; then
        if [ "$log_level" = "info" ]; then
            info "Browser Use $label not found in upstream resources; skipping"
        else
            warn "Browser Use $label not found in upstream resources; skipping"
        fi
        return 1
    fi

    if ! is_host_linux_elf_executable "$source"; then
        if [ "$log_level" = "info" ]; then
            info "Browser Use $label is not a Linux executable for $ARCH; skipping"
        else
            warn "Browser Use $label is not a Linux executable for $ARCH; skipping"
        fi
        return 1
    fi

    install -m 0755 "$source" "$destination"
}

patch_browser_use_node_repl_glibc_pidfd_symbols() {
    local file="$1"
    python3 - "$file" <<'PY'
import pathlib
import struct
import sys

# node_repl only needs these pidfd symbols opportunistically. Keeping their
# GLIBC_2.39 version binding makes the whole binary fail to load on glibc
# 2.34-2.38.

path = pathlib.Path(sys.argv[1])
data = bytearray(path.read_bytes())


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def read_cstr(blob, offset):
    if offset < 0 or offset >= len(blob):
        return ""
    end = blob.find(b"\0", offset)
    if end == -1:
        end = len(blob)
    return blob[offset:end].decode("utf-8", "replace")


def elf_hash(name):
    value = 0
    for byte in name.encode("utf-8"):
        value = (value << 4) + byte
        high = value & 0xF0000000
        if high:
            value ^= high >> 24
            value &= ~high
    return value & 0xFFFFFFFF


if len(data) < 64 or data[:4] != b"\x7fELF":
    sys.exit(0)
if data[4] != 2 or data[5] != 1:
    sys.exit(0)

e_machine = struct.unpack_from("<H", data, 18)[0]
if e_machine != 62:
    sys.exit(0)

e_shoff = struct.unpack_from("<Q", data, 40)[0]
e_shentsize = struct.unpack_from("<H", data, 58)[0]
e_shnum = struct.unpack_from("<H", data, 60)[0]
e_shstrndx = struct.unpack_from("<H", data, 62)[0]

if e_shoff == 0 or e_shentsize < 64 or e_shnum == 0 or e_shstrndx >= e_shnum:
    sys.exit(0)
if e_shoff + (e_shnum * e_shentsize) > len(data):
    fail("ELF section table is outside file bounds")

sections = []
for index in range(e_shnum):
    offset = e_shoff + (index * e_shentsize)
    fields = struct.unpack_from("<IIQQQQIIQQ", data, offset)
    sections.append(
        {
            "name_offset": fields[0],
            "type": fields[1],
            "offset": fields[4],
            "size": fields[5],
            "link": fields[6],
            "entsize": fields[9],
        }
    )

shstr = sections[e_shstrndx]
shstr_data = data[shstr["offset"] : shstr["offset"] + shstr["size"]]
by_name = {
    read_cstr(shstr_data, section["name_offset"]): section for section in sections
}

dynsym = by_name.get(".dynsym")
dynstr = by_name.get(".dynstr")
versym = by_name.get(".gnu.version")
verneed = by_name.get(".gnu.version_r")
if not dynsym or not dynstr or not versym or not verneed:
    sys.exit(0)
if dynsym["entsize"] < 24:
    fail("ELF dynamic symbol table has an unsupported entry size")

dynstr_data = data[dynstr["offset"] : dynstr["offset"] + dynstr["size"]]
glibc_234_offset = dynstr_data.find(b"GLIBC_2.34\0")
if glibc_234_offset < 0:
    sys.exit(0)
glibc_234_name_offset = glibc_234_offset
glibc_234_hash = elf_hash("GLIBC_2.34")

version_names = {}
version_aux_offsets = {}
cursor = verneed["offset"]
end = verneed["offset"] + verneed["size"]
while cursor and cursor + 16 <= end:
    vn_version, vn_cnt, _vn_file, vn_aux, vn_next = struct.unpack_from(
        "<HHIII", data, cursor
    )
    if vn_version == 0 or vn_cnt == 0:
        break
    aux_cursor = cursor + vn_aux
    for _ in range(vn_cnt):
        if aux_cursor + 16 > end:
            fail("ELF version need auxiliary record is outside section bounds")
        _hash, _flags, other, name_offset, aux_next = struct.unpack_from(
            "<IHHII", data, aux_cursor
        )
        version_names[other] = read_cstr(dynstr_data, name_offset)
        version_aux_offsets[other] = aux_cursor
        if aux_next == 0:
            break
        aux_cursor += aux_next
    if vn_next == 0:
        break
    cursor += vn_next

target_names = {"pidfd_spawnp", "pidfd_getpid"}
target_version_ids = set()
non_target_glibc_239_refs = []
patched_symbols = 0
symbol_count = dynsym["size"] // dynsym["entsize"]
for index in range(symbol_count):
    symbol_offset = dynsym["offset"] + (index * dynsym["entsize"])
    if symbol_offset + 24 > len(data):
        fail("ELF dynamic symbol entry is outside file bounds")
    name_offset, info, _other, shndx = struct.unpack_from("<IBBH", data, symbol_offset)
    name = read_cstr(dynstr_data, name_offset)
    if not name:
        continue
    versym_offset = versym["offset"] + (index * 2)
    if versym_offset + 2 > versym["offset"] + versym["size"]:
        fail("ELF version symbol entry is outside section bounds")
    raw_version = struct.unpack_from("<H", data, versym_offset)[0]
    version_id = raw_version & 0x7FFF
    if version_names.get(version_id) != "GLIBC_2.39":
        continue
    bind = info >> 4
    is_weak_undefined = bind == 2 and shndx == 0
    if name in target_names and is_weak_undefined:
        struct.pack_into("<H", data, versym_offset, 1)
        target_version_ids.add(version_id)
        patched_symbols += 1
    else:
        non_target_glibc_239_refs.append(name)

if non_target_glibc_239_refs:
    fail(
        "non-pidfd GLIBC_2.39 references remain: "
        + ", ".join(sorted(set(non_target_glibc_239_refs)))
    )

if patched_symbols == 0:
    sys.exit(0)

for version_id in target_version_ids:
    aux_offset = version_aux_offsets.get(version_id)
    if aux_offset is None:
        fail("GLIBC_2.39 version need record was not found")
    struct.pack_into("<I", data, aux_offset, glibc_234_hash)
    struct.pack_into("<I", data, aux_offset + 8, glibc_234_name_offset)

path.write_bytes(data)
print("patched")
PY
}

is_browser_use_node_repl_ldd_output_compatible() {
    local output="$1"
    ! printf '%s\n' "$output" | grep -Eq "=> not found|version .* not found"
}

install_browser_use_node_repl_executable_resource() {
    local source="$1"
    local destination="$2"
    local label="$3"
    local log_level="${4:-warn}"
    local ldd_output
    local patch_status

    if ! install_linux_executable_resource "$source" "$destination" "$label" "$log_level"; then
        return 1
    fi

    if ! patch_status="$(patch_browser_use_node_repl_glibc_pidfd_symbols "$destination" 2>&1)"; then
        warn "Browser Use $label has unsupported GLIBC_2.39 runtime references; skipping"
        [ -z "$patch_status" ] || warn "$patch_status"
        rm -f "$destination"
        return 1
    fi

    if [ "$patch_status" = "patched" ]; then
        info "Patched Browser Use $label for glibc 2.34+ compatibility"
    fi

    if command -v ldd >/dev/null 2>&1; then
        if ! ldd_output="$(ldd "$destination" 2>&1)" \
            || ! is_browser_use_node_repl_ldd_output_compatible "$ldd_output"; then
            if [ "$log_level" = "info" ]; then
                info "Browser Use $label is not compatible with this host runtime; skipping"
            else
                warn "Browser Use $label is not compatible with this host runtime; skipping"
            fi
            rm -f "$destination"
            return 1
        fi
    fi
}

browser_use_node_repl_runtime_url() {
    case "$ARCH" in
        x86_64)
            echo "${CODEX_BROWSER_USE_NODE_REPL_RUNTIME_URL:-https://persistent.oaistatic.com/codex-primary-runtime/26.426.12240/codex-primary-runtime-linux-x64-26.426.12240.tar.xz}"
            ;;
        *)
            return 1
            ;;
    esac
}

browser_use_node_repl_runtime_sha256() {
    case "$ARCH" in
        x86_64)
            echo "${CODEX_BROWSER_USE_NODE_REPL_RUNTIME_SHA256:-db5624eb6efa36b66ec6f6dd0488cefb966e49636862aab6209a4336c1ca90c4}"
            ;;
        *)
            return 1
            ;;
    esac
}

install_node_repl_from_primary_runtime_archive() {
    local destination="$1"
    local url
    local expected_sha
    local cache_dir
    local archive
    local extract_dir
    local source

    if ! url="$(browser_use_node_repl_runtime_url)"; then
        warn "Browser Use node_repl primary-runtime fallback is unavailable for $ARCH"
        return 1
    fi
    expected_sha="$(browser_use_node_repl_runtime_sha256)"

    cache_dir="${CODEX_BROWSER_USE_RUNTIME_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop/browser-use}"
    archive="$cache_dir/$(basename "$url")"
    extract_dir="$WORK_DIR/browser-use-node-repl-runtime"
    source="$extract_dir/codex-primary-runtime/dependencies/bin/node_repl"

    mkdir -p "$cache_dir" "$extract_dir"
    if [ ! -f "$archive" ]; then
        info "Downloading Browser Use node_repl fallback runtime..."
        if ! curl -L --fail --progress-bar -o "$archive.part" "$url"; then
            rm -f "$archive.part"
            warn "Failed to download Browser Use node_repl fallback runtime"
            return 1
        fi
        mv "$archive.part" "$archive"
    else
        info "Using cached Browser Use node_repl fallback runtime: $archive"
    fi

    if ! printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c - >/dev/null 2>&1; then
        rm -f "$archive"
        warn "Browser Use node_repl fallback runtime checksum mismatch; removed cached archive"
        return 1
    fi

    if ! tar -xJf "$archive" -C "$extract_dir" codex-primary-runtime/dependencies/bin/node_repl; then
        warn "Failed to extract Browser Use node_repl from fallback runtime"
        return 1
    fi

    install_browser_use_node_repl_executable_resource "$source" "$destination" "node_repl fallback runtime"
}

install_browser_use_node_repl_resource() {
    local upstream_resources="$1"
    local destination="$2"
    local source

    for source in \
        "${CODEX_LINUX_NODE_REPL_SOURCE:-}" \
        "${CODEX_NODE_REPL_PATH:-}"
    do
        [ -n "$source" ] || continue
        if install_browser_use_node_repl_executable_resource "$source" "$destination" "node_repl runtime"; then
            return 0
        fi
    done

    source="${XDG_CACHE_HOME:-$HOME/.cache}/codex-runtimes/codex-primary-runtime/dependencies/bin/node_repl"
    if [ -f "$source" ] && install_browser_use_node_repl_executable_resource "$source" "$destination" "node_repl runtime"; then
        return 0
    fi

    for source in \
        "$upstream_resources/cua_node/bin/node_repl" \
        "$upstream_resources/node_repl"
    do
        [ -f "$source" ] || continue
        if install_browser_use_node_repl_executable_resource "$source" "$destination" "node_repl runtime" "info"; then
            return 0
        fi
    done

    install_node_repl_from_primary_runtime_archive "$destination"
}

remove_macos_sidecar_files() {
    local root="$1"
    find "$root" -type f -name '*:com.apple.*' -delete
}

chrome_extension_host_arch() {
    case "$ARCH" in
        x86_64) echo "x64" ;;
        aarch64|arm64) echo "arm64" ;;
        *) return 1 ;;
    esac
}

build_chrome_extension_host() {
    local source_binary="$SCRIPT_DIR/target/release/codex-chrome-extension-host"
    local cargo_cmd=""

    if [ -n "${CODEX_CHROME_EXTENSION_HOST_SOURCE:-}" ]; then
        [ -x "$CODEX_CHROME_EXTENSION_HOST_SOURCE" ] || {
            warn "CODEX_CHROME_EXTENSION_HOST_SOURCE is not executable: $CODEX_CHROME_EXTENSION_HOST_SOURCE"
            return 1
        }
        info "Using prebuilt Chrome extension host"
        printf '%s\n' "$CODEX_CHROME_EXTENSION_HOST_SOURCE"
        return 0
    fi

    if ! cargo_cmd="$(find_cargo_for_linux_computer_use)"; then
        warn "cargo not found; Chrome extension host will be unavailable"
        return 1
    fi

    info "Building Chrome extension host..."
    if ! (cd "$SCRIPT_DIR" && "$cargo_cmd" build --release -p codex-computer-use-linux --bin codex-chrome-extension-host >&2); then
        warn "Failed to build Chrome extension host"
        return 1
    fi

    if [ ! -x "$source_binary" ]; then
        warn "Chrome extension host binary missing after build: $source_binary"
        return 1
    fi

    printf '%s\n' "$source_binary"
}

install_chrome_extension_host_resource() {
    local target_plugin="$1"
    local source_host=""
    local extension_arch
    local target_host

    if ! extension_arch="$(chrome_extension_host_arch)"; then
        warn "Chrome extension host is unavailable for $ARCH; skipping Chrome plugin"
        return 1
    fi

    if ! source_host="$(build_chrome_extension_host)"; then
        return 1
    fi

    target_host="$target_plugin/extension-host/linux/$extension_arch/extension-host"
    mkdir -p "$(dirname "$target_host")"
    install -m 0755 "$source_host" "$target_host"
}

patch_chrome_plugin_for_linux() {
    local target_plugin="$1"
    local patcher="$SCRIPT_DIR/scripts/lib/patch-chrome-plugin.js"

    if [ ! -f "$patcher" ]; then
        warn "Chrome plugin patch helper not found at $patcher; leaving upstream scripts unchanged"
        return 0
    fi

    if ! node "$patcher" "$target_plugin" >&2; then
        warn "Chrome plugin Linux patch helper failed; leaving upstream scripts as-is"
    fi
}

normalize_plugin_script_executable_modes() {
    local target_plugin="$1"
    local scripts_dir="$target_plugin/scripts"
    local script

    [ -d "$scripts_dir" ] || return 0

    while IFS= read -r -d '' script; do
        if [ "$(head -c 2 "$script" 2>/dev/null || true)" = "#!" ]; then
            chmod 0755 "$script"
        fi
    done < <(find "$scripts_dir" -maxdepth 1 -type f -name '*.js' -print0)
}

stage_chrome_plugin_from_upstream() {
    local source_plugin="$1"
    local target_plugins="$2"
    local target_plugin="$target_plugins/chrome"
    local source_manifest="$source_plugin/.codex-plugin/plugin.json"
    local source_client="$source_plugin/scripts/browser-client.mjs"
    local source_install_manifest="$source_plugin/scripts/installManifest.mjs"

    if [ ! -d "$source_plugin" ]; then
        warn "Chrome bundled plugin resources not found in upstream app; skipping Chrome"
        return 1
    fi

    if [ ! -f "$source_manifest" ]; then
        warn "Chrome plugin manifest not found in upstream app; skipping Chrome"
        return 1
    fi

    if [ ! -f "$source_client" ] || [ ! -f "$source_install_manifest" ]; then
        warn "Chrome plugin scripts not found in upstream app; skipping Chrome"
        return 1
    fi

    rm -rf "$target_plugin"
    cp -R "$source_plugin" "$target_plugin"
    remove_macos_sidecar_files "$target_plugin"
    patch_chrome_plugin_for_linux "$target_plugin"
    patch_browser_use_node_repl_env_guard "$target_plugin/scripts/browser-client.mjs"
    patch_browser_use_node_repl_config_shim "$target_plugin/scripts/browser-client.mjs"
    patch_browser_use_native_pipe_import_meta_bridge "$target_plugin/scripts/browser-client.mjs"
    patch_browser_use_site_status_allowlist_fallback "$target_plugin/scripts/browser-client.mjs"
    normalize_plugin_script_executable_modes "$target_plugin"
    if ! install_chrome_extension_host_resource "$target_plugin"; then
        rm -rf "$target_plugin"
        return 1
    fi

    info "Chrome plugin staged from upstream DMG"
    return 0
}

patch_browser_use_site_status_allowlist_fallback() {
    local client="$1"

    if grep -q "codexLinuxSiteStatusAllowlistFallback" "$client"; then
        return 0
    fi

    python3 - "$client" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
pattern = re.compile(
    r'async fetchBlocked\((?P<url>[A-Za-z_$][\w$]*)\)\{'
    r'let (?P<response>[A-Za-z_$][\w$]*)=await (?P<fetch>[A-Za-z_$][\w$]*)'
    r'\((?P=url)\.endpoint,\{method:"GET"\}\);'
    r'if\(!(?P=response)\.ok\)throw new Error\((?P<format>[A-Za-z_$][\w$]*)'
    r'\(`Browser Use cannot determine if \$\{(?P=url)\.displayUrl\} is allowed\. '
    r'Please try again later or use another source\.`\)\);'
    r'let (?P<json>[A-Za-z_$][\w$]*)=await (?P=response)\.json\(\);'
    r'return (?P<status>[A-Za-z_$][\w$]*)\((?P=json)\)\}'
)
match = pattern.search(source)
if match is None:
    print(
        "WARN: Could not find Browser Use site_status allowlist fallback insertion point — leaving browser-client.mjs unchanged",
        file=sys.stderr,
    )
    raise SystemExit(0)

url = match.group("url")
response = match.group("response")
fetch = match.group("fetch")
formatter = match.group("format")
json_value = match.group("json")
status = match.group("status")
error = "__codexLinuxErr"
replacement = (
    f'async fetchBlocked({url}){{let {response};try{{{response}=await {fetch}({url}.endpoint,{{method:"GET"}})}}'
    f'catch({error}){{if(String({url}?.endpoint??"").includes("/aura/site_status")&&'
    f'String({error}?.message??{error}).toLowerCase().includes("allowlist"))return console.warn'
    f'("codexLinuxSiteStatusAllowlistFallback",{url}.endpoint),!1;throw {error}}}'
    f'if(!{response}.ok)throw new Error({formatter}(`Browser Use cannot determine if ${{{url}.displayUrl}} is allowed. '
    f'Please try again later or use another source.`));let {json_value}=await {response}.json();return {status}({json_value})}}'
)
path.write_text(source[:match.start()] + replacement + source[match.end():], encoding="utf-8")
PY
}

patch_browser_use_file_url_policy() {
    local client="$1"

    if grep -q "codexLinuxFileUrlPolicy" "$client"; then
        return 0
    fi

    python3 - "$client" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
patterns = [
    re.compile(
        r'function\s+(?P<helper>[A-Za-z_$][\w$]*)\((?P<url>[A-Za-z_$][\w$]*)\)\{'
        r'if\((?P<allowlist>[A-Za-z_$][\w$]*)\.has\((?P=url)\)\)return\s*(?:true|!0);'
        r'let\s+(?P<parsed>[A-Za-z_$][\w$]*);'
        r'try\{\s*(?P=parsed)\s*=\s*new URL\((?P=url)\);?\s*\}'
        r'catch\{\s*return\s*(?:false|!1);?\s*\}'
        r'return\s+(?P=parsed)\.protocol\s*===\s*"http:"\s*\|\|\s*'
        r'(?P=parsed)\.protocol\s*===\s*"https:"(?P<semicolon>;?)\}'
    ),
    re.compile(
        r'function\s+(?P<helper>[A-Za-z_$][\w$]*)\((?P<url>[A-Za-z_$][\w$]*)\)\{'
        r'if\((?P<allowlist>[A-Za-z_$][\w$]*)\.has\((?P=url)\)\)return\s*(?:true|!0);'
        r'(?:const|let|var)\s+(?P<parsed>[A-Za-z_$][\w$]*)\s*=\s*new URL\((?P=url)\);'
        r'return\s+(?P=parsed)\.protocol\s*===\s*"http:"\s*\|\|\s*'
        r'(?P=parsed)\.protocol\s*===\s*"https:"(?P<semicolon>;?)\}'
    ),
]

for pattern in patterns:
    match = pattern.search(source)
    if match is None:
        continue

    parsed = match.group("parsed")
    semicolon = match.group("semicolon")
    old_body = match.group(0)
    old_return = re.compile(
        rf'return\s+{re.escape(parsed)}\.protocol\s*===\s*"http:"\s*\|\|\s*'
        rf'{re.escape(parsed)}\.protocol\s*===\s*"https:"{re.escape(semicolon)}'
    )
    file_policy = (
        f'{parsed}.protocol==="file:"&&'
        f'({parsed}.hostname===""||{parsed}.hostname==="localhost")'
        f'/*codexLinuxFileUrlPolicy*/'
    )
    new_return = (
        f'return {parsed}.protocol==="http:"||{parsed}.protocol==="https:"||'
        f'{file_policy}{semicolon}'
    )
    new_body, count = old_return.subn(new_return, old_body, count=1)
    if count != 1:
        continue

    path.write_text(source[:match.start()] + new_body + source[match.end():], encoding="utf-8")
    raise SystemExit(0)

print(
    "WARN: Could not find Browser Use URL policy insertion point — leaving browser-client.mjs unchanged",
    file=sys.stderr,
)
PY
}

patch_browser_use_node_repl_env_guard() {
    local client="$1"

    if grep -Eq 'globalThis\.nodeRepl\?\.env\?\.\[[^]]+\]' "$client"; then
        return 0
    fi

    python3 - "$client" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
pattern = re.compile(
    r'function (?P<helper>[A-Za-z_$][\w$]*)\((?P<key>[A-Za-z_$][\w$]*)\)\{'
    r'let (?P<value>[A-Za-z_$][\w$]*)=globalThis\.nodeRepl\?\.env\[(?P=key)\];'
    r'return typeof (?P=value)=="string"\?(?P=value):void 0\}'
)
match = pattern.search(source)
if match is None:
    print(
        "WARN: Could not find Browser Use nodeRepl env guard insertion point — leaving browser-client.mjs unchanged",
        file=sys.stderr,
    )
    raise SystemExit(0)

helper = match.group("helper")
key = match.group("key")
value = match.group("value")
replacement = (
    f'function {helper}({key}){{'
    f'let {value}=globalThis.nodeRepl?.env?.[{key}];'
    f'return typeof {value}=="string"?{value}:void 0}}'
)
path.write_text(source[:match.start()] + replacement + source[match.end():], encoding="utf-8")
PY
}

patch_browser_use_node_repl_config_shim() {
    local client="$1"

    if grep -q "codexLinuxBrowserUseConfigShim" "$client"; then
        return 0
    fi

    python3 - "$client" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
pattern = re.compile(
    r'function (?P<helper>[A-Za-z_$][\w$]*)\(\)\{'
    r'let (?P<value>[A-Za-z_$][\w$]*)=globalThis\.nodeRepl;'
    r'return (?P=value)\?\.config==null\?void 0:(?P=value)\}'
)
match = pattern.search(source)
if match is None:
    print(
        "WARN: Could not find Browser Use nodeRepl config shim insertion point — leaving browser-client.mjs unchanged",
        file=sys.stderr,
    )
    raise SystemExit(0)

helper = match.group("helper")
value = match.group("value")
shim = r'''
function codexLinuxBrowserUseConfigShim() {
  let repl = globalThis.nodeRepl;
  if (repl == null || repl.config != null) return;
  let config = {
    read: async () => ({ config: await codexLinuxBrowserUseReadToml("config.toml") }),
    readRequirements: async () => ({ requirements: null }),
    readToml: async (filePath) => codexLinuxBrowserUseReadToml(filePath),
    writeToml: codexLinuxBrowserUseIgnoreConfigWrite,
    writeValue: codexLinuxBrowserUseIgnoreConfigWrite,
    batchWrite: codexLinuxBrowserUseIgnoreConfigWrite,
  };

  try {
    repl.config = config;
    if (repl.config != null) return;
  } catch {}

  try {
    let prototype = Object.getPrototypeOf(repl);
    if (prototype != null && Object.getOwnPropertyDescriptor(prototype, "config") == null) {
      Object.defineProperty(prototype, "config", {
        configurable: true,
        get: () => config,
      });
    }
  } catch {}
}

function codexLinuxBrowserUseCodexHome() {
  let codexHome = globalThis.nodeRepl?.env?.CODEX_HOME;
  if (typeof codexHome == "string" && codexHome.length > 0) {
    return codexHome.replace(/\/+$/, "");
  }

  let homeDir = globalThis.nodeRepl?.homeDir;
  return typeof homeDir == "string" && homeDir.length > 0
    ? `${homeDir.replace(/\/+$/, "")}/.codex`
    : null;
}

function codexLinuxBrowserUseConfigPath(filePath) {
  let codexHome = codexLinuxBrowserUseCodexHome();
  if (codexHome == null || typeof filePath != "string" || filePath.length === 0) {
    return null;
  }

  let normalized = filePath.replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    return normalized === codexHome || normalized.startsWith(`${codexHome}/`)
      ? normalized
      : null;
  }

  normalized = normalized.replace(/^\/+/, "");
  return normalized.split("/").includes("..") ? null : `${codexHome}/${normalized}`;
}

async function codexLinuxBrowserUseReadToml(filePath) {
  let configPath = codexLinuxBrowserUseConfigPath(filePath);
  if (configPath == null) return {};

  try {
    let { readFile } = await import("node:fs/promises");
    return codexLinuxBrowserUseParseToml(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error && typeof error == "object" && error.code === "ENOENT") return {};
    throw error;
  }
}

async function codexLinuxBrowserUseIgnoreConfigWrite() {
  return undefined;
}

function codexLinuxBrowserUseParseToml(source) {
  let root = {};
  let section = root;

  for (let line of String(source).split(/\r?\n/)) {
    let trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    let sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = root;
      for (let part of sectionMatch[1].split(".")) {
        section = section[part] && typeof section[part] == "object" && !Array.isArray(section[part])
          ? section[part]
          : (section[part] = {});
      }
      continue;
    }

    let separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    let key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (key) section[key] = codexLinuxBrowserUseParseTomlValue(value);
  }

  return root;
}

function codexLinuxBrowserUseParseTomlValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);

  if (value.startsWith("[") && value.endsWith("]")) {
    let body = value.slice(1, -1).trim();
    return body.length === 0
      ? []
      : body.split(",").map((item) => codexLinuxBrowserUseParseTomlValue(item.trim()));
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}
'''
replacement = (
    shim
    + f'function {helper}(){{codexLinuxBrowserUseConfigShim();let {value}=globalThis.nodeRepl;'
    + f'return {value}?.config==null?void 0:{value}}}'
)
path.write_text(source[:match.start()] + replacement + source[match.end():], encoding="utf-8")
PY
}

patch_browser_use_native_pipe_import_meta_bridge() {
    local client="$1"

    if grep -Fq "globalThis.nodeRepl?.nativePipe??import.meta.__codexNativePipe" "$client"; then
        return 0
    fi

    python3 - "$client" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
pattern = re.compile(
    r'function (?P<helper>[A-Za-z_$][\w$]*)\(\)\{'
    r'let (?P<bridge>[A-Za-z_$][\w$]*)='
    r'(?:globalThis\.nodeRepl\?\.nativePipe|import\.meta\.__codexNativePipe);'
    r'return (?P=bridge)==null\|\|typeof (?P=bridge)\.createConnection!="function"\?null:(?P=bridge)\}'
)
match = pattern.search(source)
if match is None:
    print(
        "WARN: Could not find Browser Use nativePipe bridge helper — leaving browser-client.mjs unchanged",
        file=sys.stderr,
    )
    raise SystemExit(0)

helper = match.group("helper")
bridge = match.group("bridge")
replacement = (
    f'function {helper}(){{let {bridge}=globalThis.nodeRepl?.nativePipe??import.meta.__codexNativePipe;'
    f'return {bridge}==null||typeof {bridge}.createConnection!="function"?null:{bridge}}}'
)
path.write_text(source[:match.start()] + replacement + source[match.end():], encoding="utf-8")
PY
}

find_browser_plugin_source() {
    local bundled_root="$1"
    local source_marketplace="$2"

    node - "$bundled_root" "$source_marketplace" <<'NODE'
const fs = require("fs");
const path = require("path");

const bundledRoot = process.argv[2];
const marketplacePath = process.argv[3];
const candidates = [];

try {
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const plugin = plugins.find((entry) => entry && entry.name === "browser");
  const source = plugin && plugin.source;
  if (
    source &&
    source.source === "local" &&
    typeof source.path === "string" &&
    source.path.length > 0
  ) {
    candidates.push(path.resolve(bundledRoot, source.path));
  }
} catch (_err) {
  // Fall back to the known upstream directory name below.
}

candidates.push(path.join(bundledRoot, "plugins", "browser"));

const seen = new Set();
for (const candidate of candidates) {
  const normalized = path.normalize(candidate);
  if (seen.has(normalized)) {
    continue;
  }
  seen.add(normalized);

  if (
    fs.existsSync(path.join(normalized, ".codex-plugin", "plugin.json")) &&
    fs.existsSync(path.join(normalized, "scripts", "browser-client.mjs"))
  ) {
    console.log(normalized);
    process.exit(0);
  }
}

process.exit(1);
NODE
}

stage_browser_plugin_from_upstream() {
    local source_plugin="$1"
    local target_plugins="$2"
    local target_name
    target_name="$(basename "$source_plugin")"
    local target_plugin="$target_plugins/$target_name"
    local source_client="$source_plugin/scripts/browser-client.mjs"
    local target_client="$target_plugin/scripts/browser-client.mjs"

    if [ ! -d "$source_plugin" ]; then
        info "Browser bundled plugin resources not present in upstream app; skipping Browser"
        return 1
    fi

    if [ ! -f "$source_plugin/.codex-plugin/plugin.json" ]; then
        warn "Browser plugin manifest not found in upstream app; skipping Browser"
        return 1
    fi

    if [ ! -f "$source_client" ]; then
        warn "Browser browser-client.mjs not found in upstream app; skipping Browser"
        return 1
    fi

    rm -rf "$target_plugin"
    cp -R "$source_plugin" "$target_plugin"
    remove_macos_sidecar_files "$target_plugin"
    patch_browser_use_node_repl_env_guard "$target_client"
    patch_browser_use_node_repl_config_shim "$target_client"
    patch_browser_use_native_pipe_import_meta_bridge "$target_client"
    patch_browser_use_site_status_allowlist_fallback "$target_client"
    patch_browser_use_file_url_policy "$target_client"

    info "Browser plugin staged from upstream DMG"
    return 0
}

write_bundled_plugins_marketplace() {
    local source="$1"
    local destination="$2"
    local include_browser="$3"
    local include_chrome="$4"
    local include_computer_use="$5"

    node - "$source" "$destination" "$include_browser" "$include_chrome" "$include_computer_use" <<'NODE'
const fs = require("fs");
const path = require("path");

const sourcePath = process.argv[2];
const destinationPath = process.argv[3];
const includeBrowser = process.argv[4] === "1";
const includeChrome = process.argv[5] === "1";
const includeComputerUse = process.argv[6] === "1";
const marketplace = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const sourcePlugins = marketplace.plugins || [];
const plugins = [];

if (includeBrowser) {
  const marketplaceRoot = path.resolve(path.dirname(destinationPath), "..", "..");
  const browser = sourcePlugins.find((plugin) => {
    if (plugin == null || typeof plugin !== "object") {
      return false;
    }
    if (plugin.name !== "browser") {
      return false;
    }
    const source = plugin.source || {};
    if (source.source !== "local" || typeof source.path !== "string") {
      return true;
    }
    const stagedManifest = path.join(
      path.resolve(marketplaceRoot, source.path),
      ".codex-plugin",
      "plugin.json",
    );
    return fs.existsSync(stagedManifest);
  });
  if (browser == null) {
    let fallback = null;
    const stagedManifestPath = path.join(
      marketplaceRoot,
      "plugins",
      "browser",
      ".codex-plugin",
      "plugin.json",
    );
    try {
      const manifest = JSON.parse(fs.readFileSync(stagedManifestPath, "utf8"));
      const name =
        typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : "browser";
      const category =
        manifest &&
        manifest.interface &&
        typeof manifest.interface.category === "string" &&
        manifest.interface.category.length > 0
          ? manifest.interface.category
          : "Engineering";
      fallback = {
        name,
        source: {
          source: "local",
          path: "./plugins/browser",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category,
      };
    } catch (_err) {
      // Fall through to the explicit error below.
    }
    if (fallback == null) {
      throw new Error("Bundled marketplace does not contain browser plugin");
    }
    plugins.push(fallback);
  } else {
    plugins.push(browser);
  }
}

if (includeChrome) {
  const chrome = sourcePlugins.find((plugin) => plugin.name === "chrome");
  if (chrome != null) {
    plugins.push(chrome);
  } else {
    let name = "chrome";
    let category = "Productivity";
    const stagedManifestPath = path.join(
      path.dirname(destinationPath),
      "..",
      "..",
      "plugins",
      "chrome",
      ".codex-plugin",
      "plugin.json",
    );
    try {
      const manifest = JSON.parse(fs.readFileSync(stagedManifestPath, "utf8"));
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        name = manifest.name;
      }
      const manifestCategory =
        manifest && manifest.interface ? manifest.interface.category : undefined;
      if (typeof manifestCategory === "string" && manifestCategory.length > 0) {
        category = manifestCategory;
      }
    } catch (_err) {
      // Fall through to defaults when the staged plugin manifest is
      // missing or malformed — stage_chrome_plugin_from_upstream only
      // existence-checks plugin.json, so it can still be unparseable here.
    }
    plugins.push({
      name,
      source: {
        source: "local",
        path: "./plugins/chrome",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category,
    });
  }
}

if (includeComputerUse) {
  plugins.push({
    name: "computer-use",
    source: {
      source: "local",
      path: "./plugins/computer-use",
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  });
}

marketplace.plugins = plugins;
fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
fs.writeFileSync(destinationPath, `${JSON.stringify(marketplace, null, 2)}\n`);
NODE
}

install_bundled_plugin_resources() {
    local app_dir="$1"
    local upstream_resources="$app_dir/Contents/Resources"
    local bundled_source_root="$upstream_resources/plugins/openai-bundled"
    local source_marketplace="$bundled_source_root/.agents/plugins/marketplace.json"
    local source_browser_plugin=""
    local source_chrome_plugin="$upstream_resources/plugins/openai-bundled/plugins/chrome"
    local resources_dir="$INSTALL_DIR/resources"
    local bundled_plugins_dir="$resources_dir/plugins/openai-bundled"
    local include_browser=0
    local include_chrome=0
    local include_computer_use=0

    if [ ! -f "$source_marketplace" ]; then
        warn "Bundled plugin marketplace not found in upstream app; skipping bundled plugins"
        return 0
    fi

    mkdir -p "$bundled_plugins_dir/plugins" "$bundled_plugins_dir/.agents/plugins"

    if source_browser_plugin="$(find_browser_plugin_source "$bundled_source_root" "$source_marketplace")" &&
        stage_browser_plugin_from_upstream "$source_browser_plugin" "$bundled_plugins_dir/plugins"; then
        include_browser=1
    else
        info "Browser bundled plugin resources not present in upstream app; skipping Browser"
    fi

    if stage_chrome_plugin_from_upstream "$source_chrome_plugin" "$bundled_plugins_dir/plugins"; then
        include_chrome=1
    fi

    if stage_linux_computer_use_plugin "$bundled_plugins_dir/plugins"; then
        include_computer_use=1
    else
        warn "Linux Computer Use plugin will be unavailable"
    fi

    if [ "$include_browser" -eq 0 ] && [ "$include_chrome" -eq 0 ] && [ "$include_computer_use" -eq 0 ]; then
        warn "No Linux-safe bundled plugins were staged"
        return 0
    fi

    write_bundled_plugins_marketplace "$source_marketplace" "$bundled_plugins_dir/.agents/plugins/marketplace.json" "$include_browser" "$include_chrome" "$include_computer_use"

    install_linux_executable_resource "$upstream_resources/node" "$resources_dir/node" "node runtime" "info" || true
    install_browser_use_node_repl_resource "$upstream_resources" "$resources_dir/node_repl" || true

    info "Linux-safe bundled plugins installed"
}
