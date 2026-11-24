"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { URL, pathToFileURL } = require("node:url");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { applyUnifiedComputerUsePatch } = require("./unified.js");

const ID = "[A-Za-z_$][\\w$]*";

function extractBuilder(source) {
  const matches = [...source.matchAll(new RegExp(
    `function ${ID}\\(\\{browserBackends:[\\s\\S]{0,500}?,codexLinuxCuaPluginRoot\\}\\)` +
    `\\{/\\*codexLinuxUnifiedCuaBuilder\\*/`, "gu"))];
  assert.equal(matches.length, 1, "Expected one patched native config builder");
  const open = matches[0].index + matches[0][0].lastIndexOf("{/*");
  const close = findMatchingBrace(source, open);
  assert.notEqual(close, -1, "Expected a complete patched native config builder");
  return source.slice(matches[0].index, close + 1);
}

function executeBuilder(builderSource, instructionsAvailable) {
  const readFileSync = location => {
    if (!instructionsAvailable) {
      const error = new Error("instructions unavailable");
      error.code = "ENOENT";
      throw error;
    }
    return `signed instruction ${path.basename(String(location))}`;
  };
  const context = {
    require(specifier) {
      assert.equal(specifier, "node:path");
      return path;
    },
    process: {
      platform: "linux",
      execPath: "/upstream/ChatGPT",
      env: { CODEX_LINUX_CUA_HOST_SOCKET: "/run/codex-desktop/cua.sock" },
    },
    r3: "NODE_REPL_UNTRUSTED_ENV_ALLOWLIST",
    th: {
      gVp: "NODE_REPL_NODE_MODULES_PATH",
      wLF: "NODE_REPL_NODE_PATH",
      ytA: "NODE_REPL_TRUSTED_SERVICES",
    },
    tc: { tno: "CUA_REPL_BROWSER_BACKENDS" },
    tl: () => path,
    rD: { readFileSync },
    rO: { pathToFileURL },
    n9: { linux: "linux" },
    Error,
    URL,
  };
  return new vm.Script(`(${builderSource})`).runInNewContext(context);
}

function runResumeBranch(builderSource, instructionsAvailable) {
  const build = executeBuilder(builderSource, instructionsAvailable);
  return build({
    browserBackends: [],
    deferTools: false,
    confirmationPolicyConfig: "{}",
    omitCuaConfirmationPolicyBySku: false,
    surfaces: ["computer"],
    nodeRepl: {
      command: "/runtime/node-repl",
      args: ["/runtime/node-repl.mjs"],
      env: {
        NODE_REPL_NODE_MODULES_PATH: "/runtime/node_modules",
        NODE_REPL_NODE_PATH: "/runtime/node",
      },
    },
    codexLinuxCuaPluginRoot: "/verified/unified-computer-use",
  });
}

test("official resume executes packaged-instructions and missing-instructions branches", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const main = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert(main);
  const owners = main.chunks.map(name =>
    fs.readFileSync(path.join(main.buildDir, name), "utf8")
  ).filter(source => source.includes("cuaReplSurfaces:"));
  assert.equal(owners.length, 1);
  const patched = applyUnifiedComputerUsePatch(owners[0]);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.match(patched, /codexLinuxCuaContext:[A-Za-z_$][\w$]*/u);
  assert.match(patched, /codexLinuxUnifiedCuaRoot/u);
  assert.match(patched,
    /codexLinuxCuaPluginRoot:[A-Za-z_$][\w$]*\.codexLinuxCuaPluginRoot/u);
  assert.match(patched,
    /codexLinuxUnifiedCuaThread[\s\S]*?NODE_REPL_JS_BANNER=/u);
  assert.equal(
    patched.split('require("node:path").join(codexLinuxCuaPluginRoot,"scripts","native-service.mjs")').length - 1,
    2,
  );
  assert.equal(applyUnifiedComputerUsePatch(patched), patched);

  const builder = extractBuilder(patched);
  const packaged = runResumeBranch(builder, true);
  const fallback = runResumeBranch(builder, false);
  for (const result of [packaged, fallback]) {
    assert.deepEqual(JSON.parse(result.env.NODE_REPL_TRUSTED_SERVICES), {
      sky: "/verified/unified-computer-use/scripts/native-service.mjs",
    });
    assert.match(result.env.NODE_REPL_JS_BANNER,
      /\/verified\/unified-computer-use\/scripts\/native-client\.mjs/u);
    assert.match(result.env.NODE_REPL_JS_BANNER, /installLinuxComputerUse\(cua\)/u);
    assert.equal(result.env.CODEX_LINUX_CUA_HOST_SOCKET, "/run/codex-desktop/cua.sock");
  }

  assert.equal(packaged.command, "/runtime/node-repl");
  assert.deepEqual(Array.from(packaged.args), ["/runtime/node-repl.mjs"]);
  const overrides = JSON.parse(packaged.env.NODE_REPL_TOOL_OVERRIDES);
  assert.match(overrides.server_instructions, /signed instruction server\.md/u);
  assert.match(overrides.tools.js.description, /signed instruction description\.md/u);

  assert.equal(fallback.command, "/runtime/node");
  assert.deepEqual(Array.from(fallback.args), ["/runtime/node_modules/@oai/cua-repl/bin/cua-repl.mjs"]);
  assert.equal(fallback.env.CUA_REPL_NODE_REPL_PATH, "/runtime/node-repl");
  assert.equal(Object.hasOwn(fallback.env, "NODE_REPL_TOOL_OVERRIDES"), false);
});
