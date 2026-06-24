#!/bin/bash
set -eu

MODULE_DIR=${1:?usage: build-native-modules.sh <module-dir> <electron-version> <electron-headers-tarball>}
ELECTRON_VERSION=${2:?usage: build-native-modules.sh <module-dir> <electron-version> <electron-headers-tarball>}
ELECTRON_HEADERS_TARBALL=${3:?usage: build-native-modules.sh <module-dir> <electron-version> <electron-headers-tarball>}
MAX_BUILD_THREADS=${MAX_BUILD_THREADS:-0}

version_major=${ELECTRON_VERSION%%.*}

patch_better_sqlite3() {
    [ -d "$MODULE_DIR/node_modules/better-sqlite3" ] || return 0
    case "$version_major" in
        ''|*[!0-9]*) return 0 ;;
    esac
    [ "$version_major" -ge 42 ] || return 0

    node - "$MODULE_DIR/node_modules/better-sqlite3" <<'JS'
const fs = require("node:fs");
const path = require("node:path");

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
  `#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()\n#define OnlyIsolate info.GetIsolate()\n#define OnlyContext isolate->GetCurrentContext()\n#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())`,
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 14\n#define BETTER_SQLITE3_EXTERNAL_POINTER_TAG v8::kExternalPointerTypeTagDefault\n#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value), BETTER_SQLITE3_EXTERNAL_POINTER_TAG)\n#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value(BETTER_SQLITE3_EXTERNAL_POINTER_TAG))\n#else\n#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value))\n#define BETTER_SQLITE3_EXTERNAL_VALUE(external) ((external)->Value())\n#endif\n\n#define EasyIsolate v8::Isolate* isolate = v8::Isolate::GetCurrent()\n#define OnlyIsolate info.GetIsolate()\n#define OnlyContext isolate->GetCurrentContext()\n#define OnlyAddon static_cast<Addon*>(BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>()))`,
) || patched;

patched = replaceOnce(
  files.helpers,
  `\t\tfunc,\n\t\t0,\n\t\tdata`,
  `\t\tfunc,\n\t\tnullptr,\n\t\tdata`,
) || patched;

if (patched) {
  console.error("[INFO] Patched better-sqlite3 source for V8 external pointer API");
} else {
  console.error("[INFO] better-sqlite3 V8 external pointer source patch already applied");
}
JS
}

apply_v8_nullptr_t_workaround_if_needed() {
    local build_dir="$1"
    local probe_source="$build_dir/.v8-nullptr-probe.cc"
    local nullptr_fix="$build_dir/.v8-nullptr-fix.h"
    local cxx_wrapper="$build_dir/.cxx-v8-nullptr"
    local -a cxx_command

    mkdir -p "$build_dir"
    # shellcheck disable=SC2206
    cxx_command=( ${CXX:-c++} )
    if [ "${#cxx_command[@]}" -eq 0 ]; then
        cxx_command=(c++)
    fi

    command -v "${cxx_command[0]}" >/dev/null 2>&1 || {
        echo "C++ compiler not found: ${cxx_command[0]}" >&2
        exit 1
    }

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
    chmod 0755 "$cxx_wrapper"
    export CXX="$cxx_wrapper"
    echo "[INFO] Applied GCC 16+ nullptr_t compatibility workaround" >&2
}

prune_build_artifacts() {
    local package_dir="$1"
    local build_dir="$package_dir/build"

    [ -d "$build_dir" ] || return 0
    find "$build_dir" -type f ! -name '*.node' -delete 2>/dev/null || true
    find "$build_dir" -type d -empty -delete 2>/dev/null || true
    find "$package_dir" -type f -name '*.target.mk' -delete 2>/dev/null || true
}

patch_better_sqlite3
apply_v8_nullptr_t_workaround_if_needed "$MODULE_DIR"

rebuild_args=(--force)
if [ "$MAX_BUILD_THREADS" != 0 ]; then
    rebuild_args+=(--sequential)
    export npm_config_jobs="$MAX_BUILD_THREADS"
    export NPM_CONFIG_JOBS="$MAX_BUILD_THREADS"
    export MAKEFLAGS="-j$MAX_BUILD_THREADS"
fi

(
    cd "$MODULE_DIR"
    env \
        npm_config_tarball="$ELECTRON_HEADERS_TARBALL" \
        npm_config_devdir="$MODULE_DIR/.electron-gyp" \
        node "$MODULE_DIR/node_modules/@electron/rebuild/lib/cli.js" \
            -v "$ELECTRON_VERSION" \
            --dist-url "https://artifacts.electronjs.org/headers/dist" \
            "${rebuild_args[@]}"
)

prune_build_artifacts "$MODULE_DIR/node_modules/better-sqlite3"
prune_build_artifacts "$MODULE_DIR/node_modules/node-pty"
