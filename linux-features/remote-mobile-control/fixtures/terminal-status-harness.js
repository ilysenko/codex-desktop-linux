"use strict";
const targets = require("./current-terminal-status.json");
const providers = require("./current-terminal-status-graph.json");
const vm = require("node:vm");
const { rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../../scripts/patches/lib/minified-js.js");
const { HELPER, prepareTerminalStatusModule } = require("../terminal-status-owner.js");
function chunk(modules) {
  return "export const __rspack_esm_ids=[1];export const __webpack_modules__={" + modules.map(x => `${x.moduleId}(${x.params.join(",")}){${x.moduleSource}}`).join(",") + "};";
}
function source() { return chunk([...targets.modules, ...providers.modules]); }
function sources() {
  return Object.fromEntries([...targets.modules, ...providers.modules].map(x => [`async/${x.moduleId}.js`, chunk([x])]));
}
function selectedFrame(source, pattern) {
  const matches = [...source.matchAll(pattern)];if (matches.length !== 1) throw Error("Expected one selected native test callback");
  const m = matches[0], open = m.index + m[0].length - 1, end = createJavaScriptLexicalIndex(source).matchingBrace(open);
  return source.slice(m.index, end + 1);
}
function behavior(patched) {
  const all = [...rspackModuleFactories(patched, "controlled terminal fixture")];
  const terminal = all.find(x => x.moduleId === "EU9a"), pending = all.find(x => x.moduleId === "sZJm");
  const proof = prepareTerminalStatusModule(terminal, "terminal").proof;
  const fn = selectedFrame(terminal.moduleSource, new RegExp(`function ${escapeRegExp(proof.reducerName)}\\(\\{hasInProgressOwnedWork:[^}]+\\}\\)\\{`, "gu"));
  const status = vm.runInNewContext(`(${fn})`);
  const terminalRead = selectedFrame(terminal.moduleSource, /\(\{conversationId:e,hostId:t\},\{get:n\}\)=>\{/gu);
  const read = vm.runInNewContext(`${HELPER};(${terminalRead})`, { o: { pC: "pC", ok: "ok" }, u: { Oz: "Oz" }, [proof.reducerName]: status });
  const pendingRead = selectedFrame(pending.moduleSource, /\(\{conversationId:e,hostId:t\},\{get:n\}\)=>\{/gu);
  const approval = selectedFrame(pending.moduleSource, /function m\(e\)\{/gu);
  const resolve = vm.runInNewContext(`${HELPER};${approval};(${pendingRead})`, {
    s: { hF: "hF" }, o: { r: "resolution" }, h: "async-input",
    l: { PZ: requests => Array.isArray(requests) && requests.some(x => x.method?.endsWith("/requestApproval")), w_: type => type === "approval" },
  });
  return { terminal: { sX: status, h: read }, pending: { Z: resolve } };
}
module.exports = { chunk, source, sources, behavior };
