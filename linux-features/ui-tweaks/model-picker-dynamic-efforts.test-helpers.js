"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const resolver = require("../model-picker-default-presets/fixtures/current-local-resolver.json");
const dependencies = require("../model-picker-default-presets/fixtures/current-local-resolver-dependencies.json").owners;
const work = require("./fixtures/current-model-picker-default-view.json").work;
const current = require("./fixtures/current-dynamic-effort-callers.json");
const dynamic = require("./patches/model-picker-dynamic-efforts.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");

function chunk(records) {
  return `export const __rspack_esm_ids=[1];export const __webpack_modules__={${records.map(record =>
    `${JSON.stringify(record.moduleId)}(${record.params.join(",")}){${record.moduleSource}}`).join(",")}};`;
}

function copy(record, moduleSource = record.moduleSource) {
  return [...rspackModuleFactories(chunk([{ ...record, moduleSource }]), "current.js")][0];
}

function world(moduleSource = resolver.moduleSource) {
  const exportsById = new Map();
  const context = vm.createContext({});
  const uniqBy = (values, key) => {
    const seen = new Set();
    return values.filter(value => {
      const identity = key(value);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  };
  const load = id => {
    if (id === "i5ac") return uniqBy;
    assert.ok(exportsById.has(id), `unexpected native dependency ${id}`);
    return exportsById.get(id);
  };
  load.n = value => () => value;
  load.j = 348410;
  load.d = (target, getters, values) => {
    for (const [key, get] of Object.entries(getters ?? {})) Object.defineProperty(target, key, { get });
    Object.assign(target, values);
  };
  for (const record of [dependencies.FQih, dependencies.O5Ra, { ...resolver, moduleSource }]) {
    const target = {};
    context.factory = new vm.Script(`(function(${record.params.join(",")}){${record.moduleSource}})`).runInContext(context);
    context.target = target;
    context.load = load;
    vm.runInContext("factory({},target,load)", context, { timeout: 1000 });
    exportsById.set(record.moduleId, target);
  }
  context.native = exportsById.get("TWUU");
  return {
    run(models, options) {
      context.models = models;
      context.options = options;
      vm.runInContext("result=native.Qv(models,options)", context, { timeout: 1000 });
      return context.result;
    },
    normalize(models, options) {
      context.models = models;
      context.options = options;
      vm.runInContext("result=native.CT(models,options)", context, { timeout: 1000 });
      return context.result;
    },
  };
}

let transformed;
function uiBodies() {
  if (!transformed) transformed = {
    resolver: dynamic.inspectDynamicResolver(copy(resolver)).patchedSource,
    consumer: dynamic.inspectEffortConsumer(copy(work)).patchedSource,
  };
  return transformed;
}

function callWork(moduleSource, run, models, enabled, sliderModelsConfig, stripGptPrefix = true) {
  const owner = copy(work, moduleSource);
  const publication = findRspackExportPublication(owner, "M");
  assert.ok(publication?.fn);
  const body = publication.fn.body;
  const start = /\(0,([A-Za-z_$][\w$]*)\.Qv\)\(([A-Za-z_$][\w$]*),\{/.exec(body);
  assert.ok(start);
  const objectOpen = start.index + start[0].length - 1;
  const objectEnd = createJavaScriptLexicalIndex(body).matchingBrace(objectOpen);
  assert.equal(body[objectEnd + 1], ")");
  const call = body.slice(start.index, objectEnd + 2);
  const props = body.slice(objectOpen + 1, objectEnd);
  const configuration = /sliderModelsConfig:([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),/.exec(props);
  const stripping = /stripGptPrefix:!([A-Za-z_$][\w$]*)/.exec(props);
  assert.ok(configuration && stripping);
  const read = /([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.Ul\)\(([A-Za-z_$][\w$]*)\.pN\)/.exec(body);
  assert.ok(read);
  const key = Symbol("native-enabled-efforts");
  const reads = [], calls = [];
  const context = vm.createContext({
    [start[1]]: { Qv(input, options) { calls.push({ input, options }); return run(input, options); } },
    [start[2]]: models,
    [configuration[1]]: false, [configuration[2]]: null, [configuration[3]]: sliderModelsConfig,
    [stripping[1]]: !stripGptPrefix,
    [read[2]]: { Ul(actual) { assert.equal(actual, key); reads.push(actual); return enabled; } },
    [read[3]]: { pN: key },
  });
  vm.runInContext(`let ${read[0]};result=${call}`, context, { timeout: 1000 });
  assert.equal(reads.length, 1);
  assert.equal(calls.length, 1);
  return { result: context.result, call: calls[0], source: call };
}

function callOther(record, run, models, sliderModelsConfig) {
  const calls = [];
  const context = vm.createContext({
    [record.namespace]: { Qv(input, options) { calls.push({ input, options }); return run(input, options); } },
    [record.modelsObject]: models == null ? models : { models },
    [record.configBinding]: sliderModelsConfig,
  });
  vm.runInContext(`result=${record.expression}`, context, { timeout: 1000 });
  assert.equal(calls.length, 1);
  return { result: context.result, call: calls[0] };
}

function model(name, efforts = ["low", "medium", "high"], displayName = `gpt-${name}`) {
  return { model: name, displayName, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) };
}

function config(pairs, marked = false) {
  return { ...(marked ? { codexLinuxDefaultPresets: true } : {}), presets: [pairs.map(([name, effort]) => ({ model: name, reasoning_effort: effort }))] };
}

function plain(value) { return structuredClone(value); }
function ids(result) { return Array.from(result, row => row.id); }
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

module.exports = { resolver, dependencies, work, current, chunk, copy, world, uiBodies, callWork, callOther, model, config, plain, ids, deepFreeze };
