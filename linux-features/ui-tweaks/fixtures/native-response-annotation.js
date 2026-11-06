"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { findMatchingBrace } = require("../../../scripts/patches/lib/minified-js.js");
const { rspackModuleFactories, findRspackRequireBinding } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../../scripts/patches/lib/rspack-export-publication.js");
const annotation = require("../patches/selected-text-annotation-submit.js");

function unique(values, label) {
  assert.equal(values.length, 1, label);
  return values[0];
}
function role(pattern, source, label) {
  const match = pattern.exec(source);
  assert.ok(match, label);
  return match;
}
function publishedExpression(module, key) {
  const publication = findRspackExportPublication(module, key);
  assert.ok(publication, key);
  if (publication.fn) return module.moduleSource.slice(publication.fn.start, publication.fn.end);
  const head = unique([...module.moduleSource.matchAll(new RegExp(`function ${publication.expression}\\([^)]*\\)\\{`, "gu"))], key);
  const open = head.index + head[0].length - 1;
  return module.moduleSource.slice(head.index, findMatchingBrace(module.moduleSource, open) + 1);
}
function defaults(plan) {
  const wrapper = plan.cards[0].wrapper, props = annotationProps(wrapper);
  const direct = role(/(?:^|,)allowDirectSubmit:([\w$]+)(?=,|$)/u, props, "direct policy prop")[1];
  const edit = role(/(?:^|,)allowDirectSubmitOnEdit:([\w$]+)(?=,|$)/u, props, "edit policy prop")[1];
  assert.match(wrapper.source, new RegExp(`=void 0===${direct}\\|\\|${direct}`));
  assert.match(wrapper.source, new RegExp(`=void 0!==${edit}&&${edit}`));
  return { createMode: plan.editor.createMode, allowDirect: true, allowDirectOnEdit: false };
}
function annotationProps(fn) {
  if (fn.params.startsWith("{")) return fn.params.slice(1, -1);
  return role(new RegExp(`\\{([^{}]*onDirectSubmit:[^{}]*)\\}=${fn.params}(?=[,;])`, "u"), fn.source, "callback props")[1];
}

function nativeAnnotationPlan(extractedDir) {
  const found = annotation.discoverAnnotationSubmitAssets(extractedDir);
  const plan = annotation.validateNativeEditor(found.editors, found.cards);
  const card = plan.cards[0];
  const modules = found.cards.flatMap(chunk => [...rspackModuleFactories(chunk.source, chunk.name)]);
  function dependency(module, namespace) {
    const binding = findRspackRequireBinding(module, namespace);
    assert.ok(binding, namespace);
    const nearby = modules.filter(copy => copy.moduleId === binding.moduleId && copy.assetName === module.assetName);
    const candidates = nearby.length ? nearby : modules.filter(copy => copy.moduleId === binding.moduleId);
    return unique(candidates, binding.moduleId);
  }
  const validator = dependency(card.module, card.validator.validatorNamespace);
  const validatorExpression = publishedExpression(validator, card.validator.validatorMethod);
  const modelNamespace = role(/\(0,([\w$]+)\.nl\)/u, validatorExpression, "native text model")[1];
  const model = dependency(validator, modelNamespace);
  const textExpression = publishedExpression(model, "nl"), designExpression = publishedExpression(model, "FJ");
  return { found, plan, card, validatorExpression, modelNamespace, textExpression, designExpression, defaults: defaults(plan) };
}

function nativeAnnotationRuntime(native, eventState, settings = {}) {
  const { plan, card } = native, submission = card.submit.source;
  const words = new Set((submission + card.keydown.source).match(/[A-Za-z_$][\w$]*/gu));
  const globals = Object.fromEntries([...words].map(name => [name, false]));
  const direct = [], saved = [], validations = [];
  let textReads = 0;
  const design = vm.runInNewContext(`(${native.designExpression})`, {});
  const text = vm.runInNewContext(`(${native.textExpression})`, {});
  const resolver = vm.runInNewContext(`(${native.validatorExpression})`, { [native.modelNamespace]: { nl: text, FJ: design } });
  const availability = role(/if\(!([\w$]+)\|\|([\w$]+)\)return;/u, submission, "submission availability");
  globals[availability[1]] = settings.canSubmit !== false;
  globals[availability[2]] = settings.busy === true;
  const dictation = role(/if\("dictation"!==[\w$]+&&\(([\w$]+)\(\)\|\|([\w$]+)\|\|([\w$]+)\)\)/u, submission, "dictation guard");
  globals[dictation[1]] = () => false;
  globals[dictation[2]] = false;
  globals[dictation[3]] = false;
  const designCall = role(/let [\w$]+=([\w$]+)\(([\w$]+)\.current,([\w$]+)\),/u, submission, "design snapshot");
  const designHelper = unique([...card.module.moduleSource.matchAll(new RegExp(`function ${designCall[1]}\\([^)]*\\)\\{`, "gu"))], "native design helper");
  const designOpen = designHelper.index + designHelper[0].length - 1;
  globals[designCall[1]] = vm.runInNewContext(`(${card.module.moduleSource.slice(designHelper.index, findMatchingBrace(card.module.moduleSource, designOpen) + 1)})`, {});
  globals[designCall[2]] = { current: null };
  globals[designCall[3]] = false;
  globals[card.editorBinding] = { getText() { textReads++; return settings.draft ?? "当前未保存文字"; }, view: { dom: eventState.input } };
  globals[role(/attachedImages:([\w$]+)\.current/u, submission, "attached image state")[1]] = { current: [] };
  globals[role(/allowImageAttachments:([\w$]+)/u, submission, "image permission")[1]] = false;
  globals[role(/allowEmptySubmit:([\w$]+)/u, submission, "empty policy")[1]] = true;
  globals[role(/baselineDesignGroup:([\w$]+)/u, submission, "baseline design")[1]] = null;
  globals[role(/isDesignEditorOpen:([\w$]+)/u, submission, "design editor state")[1]] = false;
  globals[card.validator.validatorNamespace] = { [card.validator.validatorMethod]: input => { validations.push(input); return resolver(input); } };
  const bridgeGlobals = {
    [plan.editor.directBridge.busy]: { current: false },
    [plan.editor.callbacks.direct]: body => direct.push(body),
    [plan.editor.callbacks.saved]: body => saved.push(body),
  };
  const bridgeContext = vm.createContext(bridgeGlobals);
  globals[card.callbacks.direct] = vm.runInContext(`(${plan.editor.directBridge.source})`, bridgeContext);
  globals[card.callbacks.saved] = vm.runInContext(`(${plan.editor.savedBridge.source})`, bridgeContext);
  const context = vm.createContext(globals);
  context[card.submit.name] = vm.runInContext(`(${submission})`, context);
  context[card.router.editing] = settings.mode === "edit" ? "annotation-id" : null;
  context[card.router.allowed] = settings.allowDirect ?? native.defaults.allowDirect;
  const edit = role(new RegExp(`null!=${card.router.editing}&&${card.router.allowed}&&([\\w$]+)\\?`, "u"), card.keydown.source, "edit direct policy")[1];
  context[edit] = settings.allowDirectOnEdit ?? native.defaults.allowDirectOnEdit;
  const create = role(new RegExp(`${card.router.submit}\\(([\\w$]+),"keyboard"\\):`, "u"), card.keydown.source, "create mode")[1];
  context[create] = settings.createMode ?? native.defaults.createMode;
  const keydown = vm.runInContext(`(${card.keydown.source})`, context);
  const owner = native.found.owners[0], pristine = annotation.shortcutContract(owner.source);
  const before = owner.source.slice(0, pristine.insertion);
  const header = role(/([\w$]+)=([\w$]+)=>\{$/u, before, "app capture handler");
  const opening = pristine.insertion - 1, start = pristine.insertion - header[0].length;
  const patched = annotation.patchSource(owner.source);
  const handler = patched.slice(start + header[1].length + 1, findMatchingBrace(patched, opening) + 1);
  const command = role(/"focusPageBlockControls"===([\w$]+)\|\|/u, owner.source, "app command binding")[1];
  const appCapture = vm.runInNewContext(`(${handler})`, {
    [command]: settings.command ?? "composer.submit",
    [annotation.GUARD_NAME]: annotation.codexLinuxResponseAnnotationOwnsSubmitShortcut,
  });
  return { direct, saved, validations, dispatch() { appCapture(eventState.event); keydown(eventState.event); }, get textReads() { return textReads; } };
}

module.exports = { nativeAnnotationPlan, nativeAnnotationRuntime };
