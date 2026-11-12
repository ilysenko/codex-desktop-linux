"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const fixture = require("./fixtures/current-usage-limit-composers.json");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const MARKER = "codexLinuxUsageLimitSendAttempt";
const ID = "[A-Za-z_$][\\w$]*";
const gatePattern = new RegExp(`(?<flag>${ID})=\\(0,(?<hook>${ID})\\.(?<hookKey>${ID})\\)\\("local"===(?<host>${ID})&&(?<atom>${ID})\\.(?<atomKey>${ID})\\)`, "gu");

function chunk(record, moduleSource = record.moduleSource, moduleId = record.moduleId) {
  return `export const __rspack_esm_ids=[1];export const __webpack_modules__={${JSON.stringify(moduleId)}(${record.params.join(",")}){${moduleSource}}};`;
}
function copy(record, moduleSource = record.moduleSource) {
  return [...rspackModuleFactories(chunk(record, moduleSource), "current.js")][0];
}
function nativeGate(record) {
  const matches = [...record.moduleSource.matchAll(gatePattern)];
  assert.equal(matches.length, 1);
  return matches[0];
}

const blockerBindings = [
  { callerDisabled: "tg", readOnlySsh: "nO", providerBlocked: "nL", modelUnavailable: "of", environmentBusy: "nK", draftsLoading: "nM", draftsCondition: "nS", policyViolation: "nH", collaborationLoading: "os", collaborationCondition: "n9", tierLoading: "oc", reserveLimit: "n$" },
  { callerDisabled: "tg", readOnlySsh: "nV", providerBlocked: "nG", modelUnavailable: "aC", environmentBusy: "nB", draftsLoading: "nS", draftsCondition: "nk", policyViolation: "n$", collaborationLoading: "ao", collaborationCondition: "n7", tierLoading: "ac", reserveLimit: "nz" },
];

function disabledReasons(record, source, values = {}) {
  const gate = nativeGate(record), names = gate.groups;
  const index = fixture.owners.indexOf(record);
  assert.ok(index >= 0);
  const bindings = blockerBindings[index];
  const usageAt = source.indexOf('&&"usage-limit"');
  assert.ok(usageAt >= 0);
  const first = source.indexOf('"caller-disabled"');
  const start = source.lastIndexOf("let ", first);
  const joined = [...source.matchAll(new RegExp(`let (?<joined>${ID})=(?<list>${ID})\\.join\\(","\\);`, "gu"))].filter(match => match.index > usageAt)[0];
  assert.ok(start >= 0 && joined);
  const business = source.slice(start, joined.index + joined[0].length);
  const cache = source.slice(usageAt).match(new RegExp(`;(?<cache>${ID})\\[\\d+\\]!==`, "u"));
  assert.ok(cache);
  const native = source.includes(gate[0]);
  const appliedGate = new RegExp(`${escapeRegExp(names.flag)}=!1/\\*${MARKER}\\*/`, "u").exec(source);
  assert.ok(native || appliedGate);
  const expression = native ? gate[0] : appliedGate[0];
  const property = new RegExp(`submitDisabledReasons:${escapeRegExp(joined.groups.joined)}(?=,|\\})`, "u").exec(source);
  assert.ok(property);
  const atom = Symbol("current-account-usage-atom"), reads = [];
  const variables = {
    [names.hook]: { [names.hookKey](key) { reads.push(key === atom ? "account-usage" : key); return key === atom && values.usageBlocked === true; } },
    [names.atom]: { [names.atomKey]: atom }, [names.host]: values.host ?? "local",
    [cache.groups.cache]: [],
    [bindings.callerDisabled]: values.callerDisabled === true,
    [bindings.readOnlySsh]: values.readOnlySsh === true,
    [bindings.providerBlocked]: values.providerBlocked === true,
    [bindings.modelUnavailable]: values.modelUnavailable === true,
    [bindings.environmentBusy]: values.environmentBusy === true,
    [bindings.draftsLoading]: values.draftsLoading === true,
    [bindings.draftsCondition]: true,
    [bindings.policyViolation]: values.policyViolation === true,
    [bindings.collaborationLoading]: values.collaborationLoading === true,
    [bindings.collaborationCondition]: true,
    [bindings.tierLoading]: { isLoading: values.tierLoading === true },
    [bindings.reserveLimit]: values.reserveLimit === true,
  };
  const context = vm.createContext(variables);
  vm.runInContext(`result=(()=>{let ${joined.groups.list};let ${expression};${business};return{${property[0]},reasons:${joined.groups.list}}})()`, context, { timeout: 1000 });
  return { ...structuredClone(context.result), reads };
}

module.exports = { fixture, MARKER, chunk, copy, nativeGate, disabledReasons };
