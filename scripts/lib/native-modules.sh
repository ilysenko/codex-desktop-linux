#!/bin/bash
# Native Node module rebuilds (better-sqlite3, node-pty) and Linux Electron download.
#
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

# ---- Build native modules in a clean directory ----
ELECTRON_REBUILD_PACKAGE="@electron/rebuild@4.0.4"
ELECTRON_REBUILD_NODE_ABI_PACKAGE="node-abi@^4.31.0"

version_lt() {
    [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

better_sqlite3_build_version() {
    local detected_version="$1"

    case "$ELECTRON_VERSION" in
        41.*)
            if version_lt "$detected_version" "$MIN_BETTER_SQLITE3_VERSION_FOR_ELECTRON_41"; then
                echo "$MIN_BETTER_SQLITE3_VERSION_FOR_ELECTRON_41"
                return
            fi
            ;;
    esac

    echo "$detected_version"
}

patch_better_sqlite3_for_v8_external_pointer_api() {
    local module_dir="$1"
    local electron_major="${ELECTRON_VERSION%%.*}"

    case "$electron_major" in
        ""|*[!0-9]*) return 0 ;;
    esac
    [ "$electron_major" -ge 42 ] || return 0

    [ -d "$module_dir" ] || error "better-sqlite3 source not found at $module_dir"

    node - "$module_dir" <<'JS'
const fs = require("fs");
const path = require("path");

const moduleDir = process.argv[2];
const files = {
  main: path.join(moduleDir, "src/better_sqlite3.cpp"),
  helpers: path.join(moduleDir, "src/util/helpers.cpp"),
  macros: path.join(moduleDir, "src/util/macros.cpp"),
};

for (const [name, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing better-sqlite3 ${name} source: ${file}`);
  }
}

function replaceOnce(file, needle, replacement) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(replacement)) {
    return false;
  }
  if (!source.includes(needle)) {
    throw new Error(`Could not find better-sqlite3 V8 external pointer patch needle in ${file}`);
  }
  fs.writeFileSync(file, source.replace(needle, replacement));
  return true;
}

let patched = false;
patched = replaceOnce(
  files.main,
  "v8::Local<v8::External> data = v8::External::New(isolate, addon);",
  "v8::Local<v8::External> data = BETTER_SQLITE3_EXTERNAL_NEW(isolate, addon);",
) || patched;

patched = replaceOnce(
  files.macros,
  `#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()
#define OnlyIsolate info.GetIsolate()
#define OnlyContext isolate->GetCurrentContext()
#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())`,
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 14
#define BETTER_SQLITE3_EXTERNAL_POINTER_TAG v8::kExternalPointerTypeTagDefault
#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value), BETTER_SQLITE3_EXTERNAL_POINTER_TAG)
#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value(BETTER_SQLITE3_EXTERNAL_POINTER_TAG))
#else
#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value))
#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value())
#endif

#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()
#define OnlyIsolate info.GetIsolate()
#define OnlyContext isolate->GetCurrentContext()
#define OnlyAddon static_cast<Addon*>(BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>()))`,
) || patched;

patched = replaceOnce(
  files.helpers,
  `\t\tfunc,
\t\t0,
\t\tdata`,
  `\t\tfunc,
\t\tnullptr,
\t\tdata`,
) || patched;

if (patched) {
  console.error("[INFO] Patched better-sqlite3 source for V8 external pointer API");
} else {
  console.error("[INFO] better-sqlite3 V8 external pointer source patch already applied");
}
JS
}

prune_native_module_build_artifacts() {
    local module_dir="$1"
    local build_dir="$module_dir/build"

    [ -d "$build_dir" ] || return 0

    # node-gyp leaves Makefiles/configs/objects with absolute build paths.
    # The packaged runtime only needs the compiled .node binaries.
    find "$build_dir" -type f ! -name "*.node" -delete 2>/dev/null || true
    find "$build_dir" -type d -empty -delete 2>/dev/null || true
    find "$module_dir" -type f -name "*.target.mk" -delete 2>/dev/null || true
}

apply_v8_nullptr_t_workaround_if_needed() {
    local build_dir="$1"
    local probe_source="$build_dir/.v8-nullptr-probe.cc"
    local nullptr_fix="$build_dir/.v8-nullptr-fix.h"
    local cxx_wrapper="$build_dir/.cxx-v8-nullptr"
    local -a cxx_command

    mkdir -p "$build_dir"

    # CXX is conventionally a command plus optional leading arguments, e.g.
    # "ccache g++". Preserve that common form when wrapping the compiler.
    # shellcheck disable=SC2206
    cxx_command=( ${CXX:-c++} )
    if [ "${#cxx_command[@]}" -eq 0 ]; then
        cxx_command=(c++)
    fi

    command -v "${cxx_command[0]}" >/dev/null 2>&1 || error "C++ compiler not found: ${cxx_command[0]}"

    cat > "$probe_source" <<'CPP'
#include <cstddef>
nullptr_t x = nullptr;
CPP

    if "${cxx_command[@]}" -x c++ -std=c++20 -fsyntax-only "$probe_source" >/dev/null 2>&1; then
        return 0
    fi

    printf '#include <cstddef>\nusing std::nullptr_t;\n' > "$nullptr_fix"
    {
        printf '#!/bin/bash\n'
        printf 'exec'
        local arg
        for arg in "${cxx_command[@]}"; do
            printf ' %q' "$arg"
        done
        printf ' -include %q "$@"\n' "$nullptr_fix"
    } > "$cxx_wrapper"
    chmod +x "$cxx_wrapper"

    export CXX="$cxx_wrapper"
    info "Applied GCC 16+ nullptr_t compatibility workaround"
}

build_native_modules() {
    local app_extracted="$1"
    local max_build_threads="${MAX_BUILD_THREADS:-0}"
    local -a electron_rebuild_mode_args=()
    local -a native_build_env=()

    case "$max_build_threads" in
        ""|*[!0-9]*)
            error "MAX_BUILD_THREADS must be 0 or a positive integer"
            ;;
    esac

    if [ "$max_build_threads" != "0" ]; then
        electron_rebuild_mode_args+=(--sequential)
    fi

    if [ "$max_build_threads" != "0" ]; then
        native_build_env+=(
            "npm_config_jobs=$max_build_threads"
            "NPM_CONFIG_JOBS=$max_build_threads"
            "MAKEFLAGS=-j$max_build_threads"
        )
        info "Max build threads: $max_build_threads"
    fi

    # Read versions from extracted app
    local bs3_ver bs3_build_ver npty_ver
    bs3_ver=$(node -p "require('$app_extracted/node_modules/better-sqlite3/package.json').version" 2>/dev/null || echo "")
    npty_ver=$(node -p "require('$app_extracted/node_modules/node-pty/package.json').version" 2>/dev/null || echo "")

    [ -n "$bs3_ver" ] || error "Could not detect better-sqlite3 version"
    [ -n "$npty_ver" ] || error "Could not detect node-pty version"

    info "Native modules: better-sqlite3@$bs3_ver, node-pty@$npty_ver"
    bs3_build_ver="$(better_sqlite3_build_version "$bs3_ver")"
    if [ "$bs3_build_ver" != "$bs3_ver" ]; then
        warn "Using better-sqlite3@$bs3_build_ver for Electron v$ELECTRON_VERSION compatibility (DMG has $bs3_ver)"
    fi

    if [ -n "${CODEX_NATIVE_MODULES_SOURCE:-}" ]; then
        install_native_modules_from_source "$app_extracted" "$CODEX_NATIVE_MODULES_SOURCE" "$bs3_build_ver" "$npty_ver"
        return 0
    fi

    # Build in a CLEAN directory (asar doesn't have full source)
    local build_dir="$WORK_DIR/native-build"
    mkdir -p "$build_dir"
    cd "$build_dir"

    echo '{"private":true}' > package.json

    info "Installing fresh sources from npm..."
    npm install \
        "electron@$ELECTRON_VERSION" \
        "$ELECTRON_REBUILD_PACKAGE" \
        "$ELECTRON_REBUILD_NODE_ABI_PACKAGE" \
        --save-dev \
        --ignore-scripts 2>&1 >&2
    npm install "better-sqlite3@$bs3_build_ver" "node-pty@$npty_ver" --ignore-scripts 2>&1 >&2
    patch_better_sqlite3_for_v8_external_pointer_api "$build_dir/node_modules/better-sqlite3"

    info "Compiling for Electron v$ELECTRON_VERSION (this takes ~1 min)..."
    info "Using Electron headers: $ELECTRON_HEADERS_URL"
    [ -f "$build_dir/node_modules/@electron/rebuild/lib/cli.js" ] || error "electron-rebuild CLI not found in native build toolchain"
    apply_v8_nullptr_t_workaround_if_needed "$build_dir"
    env \
        npm_config_disturl="$ELECTRON_HEADERS_URL" \
        NPM_CONFIG_DISTURL="$ELECTRON_HEADERS_URL" \
        "${native_build_env[@]}" \
        node "$build_dir/node_modules/@electron/rebuild/lib/cli.js" -v "$ELECTRON_VERSION" --force --dist-url "$ELECTRON_HEADERS_URL" "${electron_rebuild_mode_args[@]}" 2>&1 >&2

    info "Native modules built successfully"

    # Copy compiled modules back into extracted app
    rm -rf "$app_extracted/node_modules/better-sqlite3"
    rm -rf "$app_extracted/node_modules/node-pty"
    cp -r "$build_dir/node_modules/better-sqlite3" "$app_extracted/node_modules/"
    cp -r "$build_dir/node_modules/node-pty" "$app_extracted/node_modules/"
    prune_native_module_build_artifacts "$app_extracted/node_modules/better-sqlite3"
    prune_native_module_build_artifacts "$app_extracted/node_modules/node-pty"
}

install_native_modules_from_source() {
    local app_extracted="$1"
    local source_dir="$2"
    local expected_better_sqlite3_version="$3"
    local expected_node_pty_version="$4"
    local source_better_sqlite3="$source_dir/better-sqlite3"
    local source_node_pty="$source_dir/node-pty"
    local actual_better_sqlite3_version
    local actual_node_pty_version

    [ -d "$source_better_sqlite3" ] || error "Prebuilt better-sqlite3 source not found at $source_better_sqlite3"
    [ -d "$source_node_pty" ] || error "Prebuilt node-pty source not found at $source_node_pty"

    actual_better_sqlite3_version=$(node -p "require('$source_better_sqlite3/package.json').version" 2>/dev/null || echo "")
    actual_node_pty_version=$(node -p "require('$source_node_pty/package.json').version" 2>/dev/null || echo "")

    [ "$actual_better_sqlite3_version" = "$expected_better_sqlite3_version" ] || \
        error "Prebuilt better-sqlite3 version mismatch: expected $expected_better_sqlite3_version, got ${actual_better_sqlite3_version:-unknown}"
    [ "$actual_node_pty_version" = "$expected_node_pty_version" ] || \
        error "Prebuilt node-pty version mismatch: expected $expected_node_pty_version, got ${actual_node_pty_version:-unknown}"

    info "Using prebuilt native modules from $source_dir"
    rm -rf "$app_extracted/node_modules/better-sqlite3"
    rm -rf "$app_extracted/node_modules/node-pty"
    cp -r "$source_better_sqlite3" "$app_extracted/node_modules/"
    cp -r "$source_node_pty" "$app_extracted/node_modules/"
    chmod -R u+w "$app_extracted/node_modules/better-sqlite3" "$app_extracted/node_modules/node-pty"
    prune_native_module_build_artifacts "$app_extracted/node_modules/better-sqlite3"
    prune_native_module_build_artifacts "$app_extracted/node_modules/node-pty"
}

# ---- Download Linux Electron ----
download_electron() {
    info "Downloading Electron v${ELECTRON_VERSION} for Linux..."

    local electron_arch
    case "$ARCH" in
        x86_64)  electron_arch="x64" ;;
        aarch64) electron_arch="arm64" ;;
        armv7l)  electron_arch="armv7l" ;;
        *)       error "Unsupported architecture: $ARCH" ;;
    esac

    local electron_zip="electron-v${ELECTRON_VERSION}-linux-${electron_arch}.zip"
    if [ -n "${CODEX_ELECTRON_ZIP_SOURCE:-}" ]; then
        [ -f "$CODEX_ELECTRON_ZIP_SOURCE" ] || error "CODEX_ELECTRON_ZIP_SOURCE does not exist: $CODEX_ELECTRON_ZIP_SOURCE"
        info "Using Electron runtime archive: $CODEX_ELECTRON_ZIP_SOURCE"
        cp "$CODEX_ELECTRON_ZIP_SOURCE" "$WORK_DIR/electron.zip"
        mkdir -p "$INSTALL_DIR"
        cd "$INSTALL_DIR"
        unzip -qo "$WORK_DIR/electron.zip"
        info "Electron ready"
        return 0
    fi

    local url
    if [ -n "$ELECTRON_MIRROR" ]; then
        url="${ELECTRON_MIRROR%/}/v${ELECTRON_VERSION}/${electron_zip}"
        info "Using Electron runtime mirror: ${ELECTRON_MIRROR%/}"
    else
        url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${electron_zip}"
    fi
    local electron_cache_dir="${CODEX_ELECTRON_CACHE_DIR:-$HOME/.cache/codex-desktop/electron}"
    local cached_zip="$electron_cache_dir/$electron_zip"
    local partial_zip="$cached_zip.part"

    mkdir -p "$electron_cache_dir"
    if [ ! -f "$cached_zip" ]; then
        info "Downloading $electron_zip into cache..."
        curl -L --fail --continue-at - --progress-bar -o "$partial_zip" "$url"
        mv "$partial_zip" "$cached_zip"
    else
        info "Using cached Electron archive: $cached_zip"
    fi

    cp "$cached_zip" "$WORK_DIR/electron.zip"
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    unzip -qo "$WORK_DIR/electron.zip"

    info "Electron ready"
}
