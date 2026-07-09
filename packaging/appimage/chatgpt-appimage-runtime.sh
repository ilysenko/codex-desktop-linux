#!/bin/bash

codex_packaged_runtime_export_env() {
    export CHROME_DESKTOP="__PACKAGE_NAME__.desktop"

    if [ -n "${APPDIR:-}" ] && [ -f "$APPDIR/__PACKAGE_NAME__.desktop" ]; then
        export BAMF_DESKTOP_FILE_HINT="$APPDIR/__PACKAGE_NAME__.desktop"
    else
        export BAMF_DESKTOP_FILE_HINT="__PACKAGE_NAME__.desktop"
    fi
}
