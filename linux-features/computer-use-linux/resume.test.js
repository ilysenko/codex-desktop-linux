"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { findMainBundle } = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { applyUnifiedComputerUsePatch } = require("./unified.js");

const IDENT = "[A-Za-z_$][\\w$]*";

function only(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `Expected one official contract: ${pattern}`);
  return matches[0];
}

function owner(source, index) {
  let found;
  for (const match of source.matchAll(/(?:async )?function [A-Za-z_$][\w$]*\([^)]*\)\{/g)) {
    if (match.index > index) break;
    const end = findMatchingBrace(source, match.index + match[0].length - 1) + 1;
    if (end > index) found = source.slice(match.index, end);
  }
  assert(found, "Expected a function owning the official contract");
  return found;
}

// Run the actual packaged helper and per-thread override function with inert
// external dependencies. No Electron, app-server, profile, or network is used.
function resumeHarness(source) {
  const builder = only(source, new RegExp(`function (${IDENT})\\(\\{browserBackends:(${IDENT}),deferTools:${IDENT},surfaces:${IDENT},nodeRepl:${IDENT}\\}`, "g"));
  const call = only(source, new RegExp(`(${IDENT})\\[\`mcp_servers\\.\\$\\{(${IDENT})\\.(${IDENT})\\}\`\\]=${builder[1]}\\(\\{browserBackends:(${IDENT})\\.browserBackends,`, "g"));
  const buildSource = owner(source, builder.index);
  const resumeSource = owner(source, call.index);
  const cache = only(resumeSource, new RegExp(`=(${IDENT})\\?await (${IDENT})\\((${IDENT})\\):null,${IDENT}=\\1\\?(${IDENT})\\(\\):`, "g"));
  const select = only(resumeSource, new RegExp(`\\?\\.selection\\?\\?await (${IDENT})\\(`, "g"));
  const config = only(resumeSource, new RegExp(
    `let ${call[1]}=await (${IDENT})\\(\\{\\.\\.\\.(${IDENT}),selection:${call[4]},` +
    `hostServicesPipePath:${IDENT}\\|\\|!${IDENT}\\.computerAudio\\?\\2\\.hostServicesPipePath:null\\}\\)`,
    "g",
  ));
  const principal = only(resumeSource, new RegExp(
    `(${IDENT})=${cache[1]}\\?await ${cache[3]}\\.getAuthenticatedPrincipal\\(\\)\\.catch\\(\\(\\)=>null\\):null`,
    "g",
  ));
  const identity = only(resumeSource, new RegExp(`(${IDENT})\\(${principal[1]}\\)`, "g"));
  const env = only(resumeSource, new RegExp(`\\[(${IDENT})\\]:${IDENT},\\[(${IDENT})\\]:(${IDENT})\\.default\\.env\\.CODEX_APP_TOOLS_PIPE_PATH\\?\\?\`\`,\\[(${IDENT})\\]:`, "g"));
  const fallback = only(resumeSource, new RegExp(`\\?\\{\\.\\.\\.${IDENT},\\.\\.\\.(${IDENT})\\}`, "g"));
  const cleanup = only(resumeSource, new RegExp(`\\)\\),(${IDENT})\\(${IDENT}\\[\`mcp_servers\\.node_repl\`\\],${call[4]}\\.cuaReplSurfaces\\)`, "g"));
  const pathAlias = only(buildSource, new RegExp(`(${IDENT})\\.default\\.join\\(${IDENT},\`scripts\`,\`native-service\\.mjs\`\\)`, "g"));
  const services = only(buildSource, new RegExp(`\\[(${IDENT})\\.(${IDENT})\\]:JSON\\.stringify\\(${IDENT}\\)`, "g"));
  const backends = only(buildSource, new RegExp(`\\[(${IDENT})\\]:${builder[2]}\\.join\\(\`,\`\\)`, "g"));
  const executable = only(buildSource, new RegExp(`command:${IDENT}\\.env\\[(${IDENT})\\.(${IDENT})\\],args:\\[${IDENT}\\.default\\.join\\(${IDENT}\\.env\\[\\1\\.(${IDENT})\\]`, "g"));

  let cached;
  const constants = { [services[2]]: "services", [executable[2]]: "node", [executable[3]]: "packageRoot", [call[3]]: "cua_repl" };
  assert.equal(services[1], executable[1]);
  assert.equal(services[1], call[2]);
  const globals = {
    [pathAlias[1]]: { default: path },
    [services[1]]: constants,
    [backends[1]]: "browserBackends",
    [cache[2]]: async () => cached,
    [cache[4]]: () => ({ browserUseTinysky: true }),
    [select[1]]: () => { throw Error("Unexpected fallback instead of cached selection"); },
    [config[1]]: async () => ({ "mcp_servers.node_repl": { command: "/node", env: { node: "/node", packageRoot: "/bundled" } } }),
    [identity[1]]: () => "test-identity",
    [env[1]]: "identity", [env[2]]: "toolsPipe", [env[4]]: "browserIdentity",
    [env[3]]: { default: { env: {} } },
    [fallback[1]]: { "mcp_servers.cua_repl": { enabled: false } },
    [cleanup[1]]: () => {},
    process: { env: { CODEX_LINUX_CUA_HOST_SOCKET: "/runtime/cua.sock" } },
  };
  // Function declarations need a shared lexical scope for the builder call.
  const sharedResume = vm.runInNewContext(`${buildSource}\n(${resumeSource})`, globals);
  return async (selection, enabled = true) => {
    cached = { selection, cuaReplEnabled: enabled };
    return sharedResume({
      appServerConnection: {
        hostConfig: { kind: "local" },
        getAuthenticatedPrincipal: async () => ({}),
      },
    });
  };
}

test("official per-thread CUA overrides carry the trusted root when resuming chats", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async () => {
  const main = findMainBundle(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert(main, "Expected the official main-process bundle");
  const source = fs.readFileSync(path.join(main.buildDir, main.mainBundle), "utf8");
  const patched = applyUnifiedComputerUsePatch(source);
  const resume = resumeHarness(patched);
  for (const surfaces of [["computer"], ["browser"], ["browser", "computer"]]) {
    const result = await resume({
      browserBackends: ["iab"], desktopFeatureAvailability: { deferCuaTools: false },
      cuaReplSurfaces: surfaces, codexLinuxCuaPluginRoot: "/trusted-plugin",
    });
    const cua = result["mcp_servers.cua_repl"];
    assert.equal(cua.enabled, true);
    assert.equal(cua.env.CUA_REPL_ENABLED_SURFACES, surfaces.join(","));
    assert.equal(cua.env.CODEX_LINUX_CUA_HOST_SOCKET, "/runtime/cua.sock");
    assert(cua.env.NODE_REPL_JS_BANNER.includes('"/trusted-plugin/scripts/native-client.mjs"'));
    assert.equal(JSON.parse(cua.env.services).sky,
      surfaces.includes("computer") ? "/trusted-plugin/scripts/native-service.mjs" : undefined);
  }
});
