#!/bin/sh
exec /app/opt/codex-desktop/resources/node-runtime/bin/node /app/lib/codex-flatpak/codex-cli/node_modules/@openai/codex/bin/codex.js "$@"
