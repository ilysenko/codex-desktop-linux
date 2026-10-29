"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const url = require("node:url");
const vm = require("node:vm");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { applyUnifiedComputerUsePatch } = require("./unified.js");

const IDENT = "[A-Za-z_$][\\w$]*";

function only(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `Expected one official contract: ${pattern}`);
  return matches[0];
}

function oneAlias(source, pattern) {
  const aliases = new Set([...source.matchAll(pattern)].map(match => match[1]));
  assert.equal(aliases.size, 1, `Expected one official module alias: ${pattern}`);
  return [...aliases][0];
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

// The rspack main process spreads code over CommonJS chunks; exactly one owns
// the unified Computer Use setup.
function signedChunks() {
  const mainProcess = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert(mainProcess, "Expected the official main-process chunks");
  return mainProcess.chunks.map(name => ({
    name, source: fs.readFileSync(path.join(mainProcess.buildDir, name), "utf8"),
  }));
}

function trustedServicesConstant(chunks, exportName) {
  // Resolve the cross-chunk constant export used as the trusted-services key.
  const entry = only(chunks.find(({ name }) => name === "early-bootstrap.js").source,
    new RegExp(`[,{]${escapeRegExp(exportName)}:\\(\\)=>${IDENT}\\.(${IDENT})[,}]`, "g"));
  const values = chunks.flatMap(({ source }) => [...source.matchAll(
    new RegExp(`[,{]${escapeRegExp(entry[1])}:"(NODE_REPL_[A-Z_]+)"[,}]`, "g"))]);
  assert.equal(values.length, 1);
  return values[0][1];
}

// Run the actual packaged helper and per-thread override function with inert
// external dependencies. No Electron, app-server, profile, or network is used.
function resumeHarness(source, trustedServicesKey) {
  const builder = only(source, new RegExp(
    `function (${IDENT})\\(\\{browserBackends:(${IDENT}),deferTools:${IDENT},surfaces:${IDENT},` +
    `nodeRepl:${IDENT},accessBootstrapPath:(${IDENT})\\}`,
    "g",
  ));
  const call = only(source, new RegExp(
    `(${IDENT})\\[\`mcp_servers\\.\\$\\{(${IDENT})\\.(${IDENT})\\}\`\\]=${escapeRegExp(builder[1])}\\(\\{browserBackends:(${IDENT})\\.browserBackends,`, "g"));
  const buildSource = owner(source, builder.index);
  const resumeSource = owner(source, call.index);
  const selection = call[4];
  const cache = only(resumeSource, new RegExp(`=(${IDENT})\\?await (${IDENT})\\((${IDENT})\\):null,${IDENT}=\\1\\?(${IDENT})\\(\\):`, "g"));
  const select = only(resumeSource, new RegExp(`\\?\\.selection\\?\\?await (${IDENT})\\(`, "g"));
  const config = only(resumeSource, new RegExp(
    `let ${IDENT}=await (${IDENT})\\(\\{\\.\\.\\.(${IDENT}),selection:${selection},` +
    `hostServicesPipePath:${IDENT}\\|\\|!${IDENT}\\.computerAudio\\?\\2\\.hostServicesPipePath:null\\}\\)`,
    "g",
  ));
  const principal = only(resumeSource, new RegExp(
    `(${IDENT})=${cache[1]}\\?await ${cache[3]}\\.getAuthenticatedPrincipal\\(\\)\\.catch\\(\\(\\)=>null\\):null`,
    "g",
  ));
  const identity = only(resumeSource, new RegExp(`=${cache[1]}\\?(${IDENT})\\(${principal[1]}\\)\\?\\?(${IDENT}):null`, "g"));
  const env = only(resumeSource, new RegExp(
    `Object\\.assign\\(${IDENT}\\.env,\\{\\[(${IDENT})\\.${IDENT}\\]:${IDENT},\\[\\1\\.${IDENT}\\]:(${IDENT})\\(\\)\\.env\\[(${IDENT})\\]\\?\\?"",`, "g"));
  const fallback = only(resumeSource, new RegExp(`:\\{\\.\\.\\.${IDENT},\\.\\.\\.(${IDENT})\\}\\}$`, "g"));
  const cleanup = only(resumeSource, new RegExp(`\\)\\),(${IDENT})\\(${IDENT}\\["mcp_servers\\.node_repl"\\],${selection}\\.cuaReplSurfaces\\)`, "g"));
  const packageRoot = only(buildSource, new RegExp(
    `(${IDENT})\\(\\)\\.join\\((${IDENT})\\.env\\[(${IDENT})\\.(${IDENT})\\],"@oai/cua-repl"\\)`, "g"));
  const services = only(buildSource, new RegExp(`\\[(${IDENT})\\.(${IDENT})\\]:JSON\\.stringify\\(${IDENT}\\)`, "g"));
  const backends = only(buildSource, new RegExp(`\\[(${IDENT})\\.(${IDENT})\\]:${builder[2]}\\.join\\(","\\)`, "g"));
  const executable = only(buildSource, new RegExp(`command:${packageRoot[2]}\\.env\\[${packageRoot[3]}\\.(${IDENT})\\]`, "g"));
  const files = [null, oneAlias(buildSource, new RegExp(`\\(0,(${IDENT})\\.readFileSync\\)\\(new URL`, "g"))];
  const fileUrls = [null, oneAlias(buildSource, new RegExp(`\\(0,(${IDENT})\\.pathToFileURL\\)`, "g"))];
  const platforms = only(buildSource, new RegExp(`(${IDENT})\\[${IDENT}\\];if\\(!${IDENT}\\)throw Error\\(\`unsupported cua_repl platform`, "g"));
  assert.equal(services[1], packageRoot[3]);
  assert.equal(services[1], call[2]);

  let cached;
  let instructionsAvailable = true;
  const constants = new Proxy({}, {
    get: (_, key) => key === services[2] ? trustedServicesKey : String(key),
  });
  const globals = {
    [packageRoot[1]]: () => path,
    [packageRoot[3]]: constants,
    [backends[1]]: constants,
    [env[1]]: constants,
    [files[1]]: {
      readFileSync: file => {
        // The packaged fallback checks `instanceof Error` in its own realm.
        if (!instructionsAvailable) throw Object.assign(new (vm.runInContext("Error", globals))(`missing ${file}`), { code: "ENOENT" });
        return file.pathname.endsWith("banner.js") ? 'await import("@oai/cua/tinyskyAlt");' : "instructions";
      },
    },
    [fileUrls[1]]: { pathToFileURL: url.pathToFileURL },
    [platforms[1]]: { linux: "linux" },
    [cache[2]]: async () => cached,
    [cache[4]]: () => ({ browserUseTinysky: true }),
    [select[1]]: () => { throw Error("Unexpected fallback instead of cached selection"); },
    [config[1]]: async () => ({
      "mcp_servers.node_repl": {
        command: "/node", args: [], env: { [packageRoot[4]]: "/bundled", [executable[1]]: "/node" },
      },
    }),
    [identity[1]]: () => "test-identity",
    [identity[2]]: "api-key",
    [env[2]]: () => ({ env: { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" } }),
    [env[3]]: "browserIdentity",
    [fallback[1]]: { "mcp_servers.cua_repl": { enabled: false } },
    [cleanup[1]]: () => {},
    URL,
    require: name => {
      assert.equal(name, "node:path");
      return path;
    },
    process: { platform: "linux", execPath: "/electron", env: { CODEX_LINUX_CUA_HOST_SOCKET: "/runtime/cua.sock" } },
  };
  // Function declarations need a shared lexical scope for the builder call.
  vm.createContext(globals);
  const sharedResume = vm.runInContext(`${buildSource}\n(${resumeSource})`, globals);
  return async (selectionValue, { enabled = true, instructions = true } = {}) => {
    cached = { selection: selectionValue, cuaReplEnabled: enabled };
    instructionsAvailable = instructions;
    const result = await sharedResume({
      appServerConnection: {
        hostConfig: { kind: "local" },
        getAuthenticatedPrincipal: async () => ({}),
      },
    });
    return result[`mcp_servers.${call[3]}`];
  };
}

test("official per-thread CUA overrides carry the trusted root when resuming chats", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async () => {
  const chunks = signedChunks();
  const owners = chunks.filter(({ source }) => source.includes("cuaReplSurfaces:"));
  assert.equal(owners.length, 1, "Expected one chunk owning unified Computer Use");
  const source = owners[0].source;
  const patched = applyUnifiedComputerUsePatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyUnifiedComputerUsePatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  const builderStart = patched.search(new RegExp(`function ${IDENT}\\(\\{browserBackends:${IDENT},deferTools:`));
  const builderServices = only(owner(patched, builderStart),
    new RegExp(`\\[${IDENT}\\.(${IDENT})\\]:JSON\\.stringify\\(${IDENT}\\)`, "g"));
  const trustedServicesKey = trustedServicesConstant(chunks, builderServices[1]);
  assert.equal(trustedServicesKey, "NODE_REPL_TRUSTED_SERVICES");
  const resume = resumeHarness(patched, trustedServicesKey);
  for (const instructions of [true, false]) {
    for (const surfaces of [["computer"], ["browser"], ["browser", "computer"]]) {
      const cua = await resume({
        browserBackends: ["iab"], desktopFeatureAvailability: { deferCuaTools: false },
        cuaReplSurfaces: surfaces, codexLinuxCuaPluginRoot: "/trusted-plugin",
      }, { instructions });
      assert.equal(cua.enabled, true);
      assert.equal(cua.env.CUA_REPL_ENABLED_SURFACES, surfaces.join(","));
      assert.equal(cua.env.CODEX_LINUX_CUA_HOST_SOCKET, "/runtime/cua.sock");
      assert.equal(cua.env.NODE_REPL_JS_BANNER,
        'await import("@oai/cua/tinyskyAlt");await(await import("/trusted-plugin/scripts/native-client.mjs")).installLinuxComputerUse(cua);');
      assert.equal(JSON.parse(cua.env.NODE_REPL_TRUSTED_SERVICES).sky,
        surfaces.includes("computer") ? "/trusted-plugin/scripts/native-service.mjs" : undefined);
      // Both the packaged instructions path and its ENOENT fallback keep the bridge.
      assert.equal(cua.env.NODE_REPL_TOOL_OVERRIDES != null, instructions);
    }
  }
  await assert.rejects(resume({
    browserBackends: ["iab"], desktopFeatureAvailability: { deferCuaTools: false }, cuaReplSurfaces: ["computer"],
  }), /Linux Computer Use trusted plugin root is unavailable/);
});
