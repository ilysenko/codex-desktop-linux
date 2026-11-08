"use strict";
const vm = require("node:vm");
const native = require("./current-feature-sync.json");
const device = require("./device-key-harness.js");
const { createJavaScriptLexicalIndex } = require("../../../scripts/patches/lib/minified-js.js");
const { HELPER } = require("../feature-sync-owner.js");
function addToSource(source) {
  source = source.replace("class RequestWrapper", native.imports + native.prelude + native.owner + "class RequestWrapper");
  return source.replace("this.seen=[]}", "this.seen=[];" + native.startup + ";}");
}
function fixture() { return addToSource(device.fixture()); }
function selected(source, name) {
  const label = source.indexOf('"app-server-feature-enablement"'), start = source.lastIndexOf("class ", label), open = source.indexOf("{", start), index = createJavaScriptLexicalIndex(source), end = index.matchingBrace(open);
  if (label < 0 || start < 0 || end < open) throw Error("missing bounded native sync class");
  const owner = source.slice(open + 1, end), lexical = createJavaScriptLexicalIndex(owner), pattern = new RegExp(`(?<![\\w$.])(?:async )?${name}\\((?<params>[^{}]*)\\)\\{`, "gu");
  const rows = [...owner.matchAll(pattern)].filter(row => lexical.isCode(row.index));
  if (rows.length !== 1) throw Error("missing selected native method " + name);
  const row = rows[0], bodyStart = row.index + row[0].length, bodyEnd = lexical.matchingBrace(bodyStart - 1), body = owner.slice(bodyStart, bodyEnd);
  return `${name === "sendEnablement" ? "async " : ""}function(${row.groups.params}){${body}}`;
}
function compile(source, name, bindings = {}) {
  // Only one selected native method/constructor body and the small community
  // helper execute. The native class, factory and application never execute.
  return vm.runInNewContext(`(${selected(source, name)})`, bindings);
}
function helper(platform) { return vm.runInNewContext(HELPER + ";codexLinuxRemoteControlFeatureSyncEnabled", { process: { platform } }); }
function assignments() {
  return { defaultEnableFeatures: { apps_mcp_path_override: true, auth_elicitation: false, tool_suggest: true, remote_control: false, unrelated: true }, values: { experimentalFeatureGates: { curatedRemoteMarketplace: false, mcp20260728: true, backgroundPaginatedRolloutMigration: true, apiKeyModelDiscovery: true, apiKeyDaybreak: false, daybreakProgramPropagation: true, shareCodexAppTools: false, localThreadStoreCompression: false } } };
}
function scene(source = native.owner, options = {}) {
  const trace = [], calls = [], state = { assignment: assignments(), ready: null, response: { enablement: { daybreak_program_propagation: true } }, connectionState: "connected" };
  state.ready = state.assignment;
  class NotReady extends Error { constructor(detail) { super(detail.reason);this.detail = detail; } }
  const bindings = { process: { platform: options.platform ?? "linux" }, eSs: ["apps_mcp_path_override", "auth_elicitation", "tool_suggest"], eSa: { parse: value => value }, t5: () => (a, b) => a === b, t4: { JF: () => options.compression === true }, t8: { uZ: NotReady }, ei: { iwv: "cloud", Rg6: error => error?.unsupported === true } };
  const make = name => vm.runInNewContext(HELPER + `;(${selected(source, name)})`, bindings);
  const self = { disposed: false, nextGeneration: 0, connections: new Map(), evaluations: { readExecutionAssignments: async () => { trace.push("assignments");return options.assignmentPromise ?? state.assignment; }, readReadyExecutionAssignments: () => state.ready }, logger: { warning: (...args) => trace.push(["warning", ...args]) }, clearPrewarmedThreads: async host => { trace.push(["clear", host]); }, onChanged: host => trace.push(["changed", host]) };
  const connection = { hostId: options.host ?? "local", appServerVersion: "current", getConnectionState: () => state.connectionState, async sendAppServerRequest(method, args, guard) { guard();calls.push({ method, args, guard });if (method === "config/read") return { config: { features: { local_thread_store_compression: options.compression === true } } };if (state.error) throw state.error;return state.responsePromise ?? state.response; } };
  const record = { connection, generation: 1, rolloutCompressionRequested: false, acknowledgedGeneration: null, supportsPropagation: null, acknowledgedEnrollment: false, stopWatching() {}, stopPreparation() {} };self.connections.set(connection.hostId, record);self.sendEnablement = make("sendEnablement");
  return { self, record, state, trace, calls, bindings, NotReady, run: () => self.sendEnablement(record, record.generation), sync: () => make("sync").call(self, record), make };
}
module.exports = { native, addToSource, fixture, selected, compile, helper, assignments, scene };
