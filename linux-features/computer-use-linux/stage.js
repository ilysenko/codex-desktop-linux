"use strict";
const fs = require("node:fs");
const path = require("node:path");

const target = path.join(process.env.INSTALL_DIR, "resources/plugins/openai-bundled/plugins/unified-computer-use");
const marketplacePath = path.join(target, "../../.agents/plugins/marketplace.json");
const settingsTarget = path.join(target, "../computer-use");
const settingsSource = path.join(process.env.SCRIPT_DIR, "plugins/openai-bundled/plugins/computer-use");
const mcpPath = path.join(target, ".mcp.json");
const manifestPath = path.join(target, ".codex-plugin/plugin.json");
let manifest;
let marketplace;
try {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.filter(p => p.name === "unified-computer-use").length !== 1) {
    throw new Error("missing or ambiguous unified marketplace entry");
  }
  const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "unified-computer-use" || typeof manifest.version !== "string" ||
      manifest.mcpServers !== "./.mcp.json" ||
      Object.keys(mcp.mcpServers ?? {}).length !== 1 ||
      mcp.mcpServers?.cua_repl?.command !== "node" ||
      !Array.isArray(mcp.mcpServers.cua_repl.args) || mcp.mcpServers.cua_repl.args.length !== 0 ||
      mcp.mcpServers.cua_repl.enabled !== false) throw new Error("unexpected unified plugin");
} catch (error) {
  throw new Error(`Linux unified Computer Use contract drift: ${error.message}`);
}

// The app materializes bundled plugin caches by version, not resource contents.
manifest.version = manifest.version.replace(/-linux-native\.\d+$/, "") + "-linux-native.4";
fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
for (const name of ["native-client.mjs", "native-service.mjs"]) {
  fs.copyFileSync(path.join(__dirname, name), path.join(target, "scripts", name));
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Keep the native toggle's existing plugin state, but expose no legacy MCP tools.
fs.mkdirSync(path.join(settingsTarget, ".codex-plugin"), { recursive: true });
fs.copyFileSync(path.join(settingsSource, ".codex-plugin/plugin.json"), path.join(settingsTarget, ".codex-plugin/plugin.json"));
fs.rmSync(path.join(settingsTarget, ".mcp.json"), { force: true });
marketplace.plugins = marketplace.plugins.filter(p => p.name !== "computer-use");
marketplace.plugins.push({ name: "computer-use", source: { source: "local", path: "./plugins/computer-use" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" });
fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
