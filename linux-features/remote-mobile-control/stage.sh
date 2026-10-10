#!/usr/bin/env bash
set -euo pipefail

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
    node - "$WORK_DIR/app-extracted/.vite/build" "$patch_module" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [buildDir, patchModulePath] = process.argv.slice(2);
const { hasLinuxRemoteMobileLocalAppServerRemoteControlPatch } = require(patchModulePath);

if (typeof hasLinuxRemoteMobileLocalAppServerRemoteControlPatch !== "function") {
  process.exit(1);
}

const found = fs.readdirSync(buildDir).some((name) => {
  if (!/\.m?js$/u.test(name)) return false;
  return hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(fs.readFileSync(path.join(buildDir, name), "utf8"));
});
process.exit(found ? 0 : 1);
NODE
then
    rm -f "$desktop_remote_control_marker"
    printf '%s\n' "version=1" "owner=desktop" > "$desktop_remote_control_marker"
else
    rm -f "$desktop_remote_control_marker"
    echo "WARN: Desktop app-server remote-control marker not found; standalone remote mobile daemon remains enabled" >&2
fi
