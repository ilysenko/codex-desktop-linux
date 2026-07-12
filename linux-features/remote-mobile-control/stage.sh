#!/usr/bin/env bash
set -euo pipefail

client="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs"
patch_module="$SCRIPT_DIR/linux-features/remote-mobile-control/patch.js"
feature_marker_dir="$INSTALL_DIR/.codex-linux"
feature_marker="$feature_marker_dir/remote-mobile-control-enabled"
desktop_remote_control_marker="$feature_marker_dir/desktop-app-server-remote-control-enabled"
cold_start_hook_dir="$feature_marker_dir/cold-start.d"
cold_start_hook="$cold_start_hook_dir/remote-mobile-control"

mkdir -p "$feature_marker_dir" "$cold_start_hook_dir"
printf '%s\n' "remote-mobile-control" > "$feature_marker"
install -m 0755 "$SCRIPT_DIR/linux-features/remote-mobile-control/cold-start-hook.sh" "$cold_start_hook"

if [ -d "$WORK_DIR/app-extracted/.vite/build" ] &&
    grep -R -q "codexLinuxRemoteMobileAppServerArgs" "$WORK_DIR/app-extracted/.vite/build" 2>/dev/null; then
    rm -f "$desktop_remote_control_marker"
    printf '%s\n' "version=1" "owner=desktop" > "$desktop_remote_control_marker"
else
    rm -f "$desktop_remote_control_marker"
    echo "WARN: Desktop app-server remote-control marker not found; standalone remote mobile daemon remains enabled" >&2
fi

if [ ! -f "$client" ]; then
    echo "WARN: Chrome browser-client.mjs not found; skipping remote-mobile Chrome bridge patch" >&2
    exit 0
fi

node - "$client" "$patch_module" <<'NODE'
const fs = require("node:fs");

const [clientPath, patchModulePath] = process.argv.slice(2);
const { applyLinuxRemoteMobileChromeBridgePatch } = require(patchModulePath);

if (typeof applyLinuxRemoteMobileChromeBridgePatch !== "function") {
  console.error("WARN: Remote mobile Chrome bridge patch export not found; skipping");
  process.exit(0);
}

const source = fs.readFileSync(clientPath, "utf8");
const patched = applyLinuxRemoteMobileChromeBridgePatch(source);
if (patched !== source) {
  fs.writeFileSync(clientPath, patched, "utf8");
  console.error("Remote mobile Chrome bridge patch applied");
} else if (patched.includes("codexLinuxRemoteMobileBrowserBackends")) {
  console.error("Remote mobile Chrome bridge patch already applied");
}
NODE
