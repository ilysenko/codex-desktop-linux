#!/usr/bin/env bash
set -eu

if [ "${CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY+x}" = x ] || [ "${CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET+x}" = x ]; then exit 0; fi
config_root="${XDG_CONFIG_HOME:-${HOME:?}/.config}"
app_id="${CODEX_LINUX_APP_ID:-codex-desktop}"
descriptor_path="$config_root/$app_id/app-server-attachment.json"
managed_node="${CODEX_LINUX_APP_DIR:?}/resources/node-runtime/bin/node"
reader="${CODEX_LINUX_FEATURES_DIR:?}/external-app-server-attachment/descriptor-reader.js"
exec "$managed_node" "$reader" "$descriptor_path"
