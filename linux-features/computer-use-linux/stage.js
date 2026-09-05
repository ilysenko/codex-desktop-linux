"use strict";
const fs = require("node:fs");
const path = require("node:path");

const target = path.join(process.env.INSTALL_DIR, "resources/plugins/openai-bundled/plugins/unified-computer-use");
const marketplacePath = path.join(target, "../../.agents/plugins/marketplace.json");
const settingsTarget = path.join(target, "../computer-use");
const settingsSource = path.join(process.env.SCRIPT_DIR, "plugins/openai-bundled/plugins/computer-use");
const launcherPath = path.join(target, "scripts/launch.mjs");
const manifestPath = path.join(target, ".codex-plugin/plugin.json");
const anchor = "NODE_REPL_JS_BANNER: banner,";
const replacement = "...linuxNativeEnvironment(setupOptions, banner),";
const importLine = 'import { linuxNativeEnvironment } from "./native-launch.mjs";\n';
let launcher;
let manifest;
let marketplace;
try {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.filter(p => p.name === "unified-computer-use").length !== 1) {
    throw new Error("missing or ambiguous unified marketplace entry");
  }
  launcher = fs.readFileSync(launcherPath, "utf8");
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "unified-computer-use" || typeof manifest.version !== "string" ||
      !launcher.includes('"@oai/sky/service"')) throw new Error("unexpected unified plugin");
  const pristine = launcher.split(anchor).length - 1;
  const patched = launcher.split(replacement).length - 1;
  if (pristine === 1 && patched === 0 && !launcher.includes(importLine)) {
    launcher = importLine + launcher.replace(anchor, replacement);
  } else if (pristine !== 0 || patched !== 1 || !launcher.startsWith(importLine)) {
    throw new Error("unexpected unified launcher");
  }
} catch (error) {
  throw new Error(`Linux unified Computer Use contract drift: ${error.message}`);
}

// The app materializes bundled plugin caches by version, not resource contents.
manifest.version = manifest.version.replace(/-linux-native\.1$/, "") + "-linux-native.1";
for (const name of ["native-launch.mjs", "native-client.mjs", "native-service.mjs"]) {
  fs.copyFileSync(path.join(__dirname, name), path.join(target, "scripts", name));
}
fs.writeFileSync(launcherPath, launcher);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Keep the native toggle's existing plugin state, but expose no legacy MCP tools.
fs.mkdirSync(path.join(settingsTarget, ".codex-plugin"), { recursive: true });
fs.copyFileSync(path.join(settingsSource, ".codex-plugin/plugin.json"), path.join(settingsTarget, ".codex-plugin/plugin.json"));
fs.rmSync(path.join(settingsTarget, ".mcp.json"), { force: true });
marketplace.plugins = marketplace.plugins.filter(p => p.name !== "computer-use");
marketplace.plugins.push({ name: "computer-use", source: { source: "local", path: "./plugins/computer-use" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" });
fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
