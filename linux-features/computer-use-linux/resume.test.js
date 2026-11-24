"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { URL, pathToFileURL } = require("node:url");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
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

function semanticMatch(source, pattern, description) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `Expected one ${description}; found ${matches.length}`);
  return matches[0].groups;
}

function deriveBuilderBindings(builderSource) {
  const header = semanticMatch(builderSource, new RegExp(
    `function ${ID}\\(\\{browserBackends:(?<backends>${ID}),[\\s\\S]{0,500}?` +
    `surfaces:${ID},nodeRepl:(?<nodeRepl>${ID}),[\\s\\S]{0,200}?codexLinuxCuaPluginRoot\\}\\)` , "gu"),
  "patched builder parameter contract");
  const service = semanticMatch(builderSource, new RegExp(
    `(?<services>${ID})\\.sky="linux"===process\\.platform\\?require\\("node:path"\\)\\.join\\(` +
    `codexLinuxCuaPluginRoot,"scripts","native-service\\.mjs"\\):"@oai/sky/service"`, "gu"),
  "Linux native service relationship");
  const allowlist = semanticMatch(builderSource, new RegExp(
    `\\[(?<binding>${ID})\\]:\\[${escapeRegExp(header.nodeRepl)}\\?\\.env\\[\\k<binding>\\],${ID},` +
    `"CUA_REPL_CONFIRMATION_POLICY_CONFIG"\\]\\.filter\\(Boolean\\)\\.join\\(","\\)`, "gu"),
  "untrusted environment allowlist relationship");
  const trusted = semanticMatch(builderSource, new RegExp(
    `\\[(?<object>${ID})\\.(?<property>${ID})\\]:JSON\\.stringify\\(${escapeRegExp(service.services)}\\)`, "gu"),
  "trusted services relationship");
  const backends = semanticMatch(builderSource, new RegExp(
    `\\[(?<object>${ID})\\.(?<property>${ID})\\]:${escapeRegExp(header.backends)}\\.join\\(","\\)`, "gu"),
  "browser backends relationship");
  const modules = semanticMatch(builderSource, new RegExp(
    `let (?<root>${ID})=(?<path>${ID})\\(\\)\\.join\\(${escapeRegExp(header.nodeRepl)}\\.env` +
    `\\[(?<object>${ID})\\.(?<property>${ID})\\],"@oai/cua-repl"\\)`, "gu"),
  "Cua Repl module path relationship");
  const nodePath = semanticMatch(builderSource, new RegExp(
    `command:${escapeRegExp(header.nodeRepl)}\\.env\\[(?<object>${ID})\\.(?<property>${ID})\\],` +
    `args:\\[${escapeRegExp(modules.path)}\\(\\)\\.join\\(${escapeRegExp(modules.root)},"bin/cua-repl\\.mjs"\\)\\]`, "gu"),
  "ENOENT fallback command relationship");
  const file = semanticMatch(builderSource, new RegExp(
    `NODE_REPL_JS_BANNER:${ID}\\.NODE_REPL_JS_BANNER\\?\\?\\(0,(?<object>${ID})\\.(?<property>${ID})\\)` +
    `\\(new URL\\("banner\\.js",${ID}\\),"utf8"\\)`, "gu"),
  "packaged instruction reader relationship");
  const url = semanticMatch(builderSource, new RegExp(
    `instructions_directory:\\(0,(?<object>${ID})\\.(?<property>${ID})\\)` +
    `\\(${escapeRegExp(modules.path)}\\(\\)\\.join\\(${escapeRegExp(modules.root)},"instructions"\\)` +
    `\\+${escapeRegExp(modules.path)}\\(\\)\\.sep\\)`, "gu"),
  "instruction URL relationship");
  const platforms = semanticMatch(builderSource, new RegExp(
    `(?<value>${ID})=(?<object>${ID})\\[(?<platform>${ID})\\];if\\(!\\k<value>\\)throw Error` +
    `\\(\\x60unsupported cua_repl platform=\\$\\{\\k<platform>\\}\\x60\\)`, "gu"),
  "instruction platform relationship");
  return { allowlist: allowlist.binding, trusted, backends, modules, nodePath, file, url, platforms };
}

function installObjectProperty(context, binding, value, description) {
  if (!Object.hasOwn(context, binding.object)) context[binding.object] = {};
  assert.equal(typeof context[binding.object], "object", `${description} owner must be an object`);
  assert.equal(Object.hasOwn(context[binding.object], binding.property), false,
    `${description} property must be unique`);
  context[binding.object][binding.property] = value;
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
    Error,
    URL,
  };
  const bindings = deriveBuilderBindings(builderSource);
  assert.equal(Object.hasOwn(context, bindings.allowlist), false,
    "allowlist binding must be unique");
  context[bindings.allowlist] = "NODE_REPL_UNTRUSTED_ENV_ALLOWLIST";
  installObjectProperty(context, bindings.trusted, "NODE_REPL_TRUSTED_SERVICES", "trusted services");
  installObjectProperty(context, bindings.backends, "CUA_REPL_BROWSER_BACKENDS", "browser backends");
  installObjectProperty(context, bindings.modules, "NODE_REPL_NODE_MODULES_PATH", "module path");
  installObjectProperty(context, bindings.nodePath, "NODE_REPL_NODE_PATH", "fallback node path");
  installObjectProperty(context, bindings.file, readFileSync, "instruction reader");
  installObjectProperty(context, bindings.url, pathToFileURL, "instruction URL");
  assert.equal(Object.hasOwn(context, bindings.modules.path), false, "path binding must be unique");
  context[bindings.modules.path] = () => path;
  assert.equal(Object.hasOwn(context, bindings.platforms.object), false,
    "platform binding must be unique");
  context[bindings.platforms.object] = { linux: "linux" };
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
  assert.throws(() => deriveBuilderBindings(builder.replace("native-service.mjs", "changed-service.mjs")),
    /Expected one Linux native service relationship; found 0/u);
  assert.throws(() => deriveBuilderBindings(builder + builder),
    /Expected one patched builder parameter contract; found 2/u);
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
