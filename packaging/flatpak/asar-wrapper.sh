#!/bin/sh
exec /app/lib/codex-flatpak-tools/node-runtime/bin/node /app/lib/codex-flatpak-tools/asar/node_modules/asar/bin/asar.js "$@"
