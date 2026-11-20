"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const sidebarProjectName = require("./patches/sidebar-project-name.js");
const uiFontSize = require("./patches/ui-font-size.js");
const modelPickerModelList = require("./patches/model-picker-model-list.js");
const reasoningEffortLabels = require("./patches/reasoning-effort-labels.js");
const dockIcon = require("./patches/dock-icon.js");
const suggestedPrompts = require("./patches/suggested-prompts.js");
const customFontInput = require("./patches/custom-font-input.js");
const selectedTextMoreDetails = require("./patches/selected-text-more-details.js");
const selectedTextAnnotationSubmit = require("./patches/selected-text-annotation-submit.js");

function patchesFrom(...modules) {
  return modules.flatMap((moduleExports) =>
    Array.isArray(moduleExports?.descriptors) ? moduleExports.descriptors : [],
  );
}

function currentReasoningLabelsDescriptor() {
  const legacy = reasoningEffortLabels.descriptors.find((descriptor) => descriptor.id === "reasoning-effort-labels-english");
  return {
    ...legacy,
    apply(extractedDir, context) {
      const assetsDir = path.join(extractedDir, "webview", "assets");
      const names = ["", "async"].flatMap((directory) => {
        const dir = path.join(assetsDir, directory);
        return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".js")).map((name) => directory ? `${directory}/${name}` : name) : [];
      });
      const loaders = [];
      for (const name of names) {
        const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
        loaders.push(...source.matchAll(/"\.\.\/locales\/zh-CN\.json":function\(\)\{return ([A-Za-z_$][\w$]*)\.e\((\d+)\)\.then\(\1\.bind\(\1,"([^"\\]+)"\)\)\}/g));
      }
      if (loaders.length === 0) return legacy.apply(extractedDir, context);
      if (loaders.length !== 1) throw Error(`Expected one current Simplified Chinese locale loader, found ${loaders.length}`);
      const [, , chunk, moduleId] = loaders[0];
      const chunkNames = names.filter((name) => new RegExp(`^async/${chunk}\\.[0-9a-f]+\\.js$`).test(name));
      if (chunkNames.length !== 1) throw Error(`Expected one current Simplified Chinese locale chunk, found ${chunkNames.length}`);
      const source = fs.readFileSync(path.join(assetsDir, chunkNames[0]), "utf8");
      const escapedModuleId = moduleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const modulePattern = new RegExp(
        `(?:^|[,{])(?:"${escapedModuleId}"|${escapedModuleId})(?::\\(function)?\\([^)]*\\)\\{` +
          `[\\s\\S]{0,800}?Promise\\.all\\(\\[\\w+\\("(assets/locales/keys\\.[^"\\\\]+\\.json\\.codex-gzip)"\\),` +
          `\\w+\\("(assets/locales/[^"\\\\]+\\.json\\.codex-gzip)"\\)\\]\\)`,
        "g",
      );
      const modules = [...source.matchAll(modulePattern)];
      if (modules.length !== 1) throw Error(`Expected one current Simplified Chinese compressed catalog, found ${modules.length}`);
      const [keysPath, valuesPath] = modules[0].slice(1).map((name) => path.join(extractedDir, "webview", name));
      const keys = JSON.parse(zlib.gunzipSync(fs.readFileSync(keysPath)));
      const values = JSON.parse(zlib.gunzipSync(fs.readFileSync(valuesPath)));
      if (!Array.isArray(keys) || !Array.isArray(values) || keys.length !== values.length) throw Error("Invalid current Simplified Chinese compressed catalog");
      let changed = false;
      for (const [key, label] of Object.entries(reasoningEffortLabels.ENGLISH_REASONING_LABELS)) {
        const indexes = keys.flatMap((candidate, index) => candidate === key ? [index] : []);
        if (indexes.length !== 1) throw Error(`Expected one current Simplified Chinese ${key}, found ${indexes.length}`);
        if (values[indexes[0]] !== label) {
          values[indexes[0]] = label;
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(valuesPath, zlib.gzipSync(Buffer.from(JSON.stringify(values))));
      return { matched: 1, changed: Number(changed), targets: [path.relative(extractedDir, valuesPath)] };
    },
  };
}

function currentUiFontSizeDescriptor() {
  const legacy = uiFontSize.descriptors[0];
  const expected = { build: 6, webview: 2 };
  return {
    ...legacy,
    apply(extractedDir, context) {
      const roots = [
        { kind: "build", dir: path.join(extractedDir, ".vite", "build") },
        { kind: "webview", dir: path.join(extractedDir, "webview", "assets") },
        { kind: "webview", dir: path.join(extractedDir, "webview", "assets", "async") },
      ];
      const candidates = [];
      for (const { kind, dir } of roots) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".js"))) {
          const target = path.join(dir, name);
          const source = fs.readFileSync(target, "utf8");
          const state = uiFontSize.fontSizeLimitContract(source);
          if (state !== "absent") candidates.push({ kind, target, source, state });
        }
      }
      const counts = Object.fromEntries(Object.keys(expected).map((kind) => [
        kind, candidates.filter((candidate) => candidate.kind === kind).length,
      ]));
      const states = new Set(candidates.map(({ state }) => state));
      if (Object.keys(expected).some((kind) => counts[kind] !== expected[kind]) ||
          states.size !== 1 || states.has("drifted")) {
        const reason = `Found ${counts.build} build and ${counts.webview} webview UI font-size contracts ` +
          `with states ${JSON.stringify([...states].sort())}`;
        console.warn(`WARN: ${reason} - skipping ui-tweaks UI font size patch`);
        return { matched: 0, changed: 0, reason };
      }
      const configuredMax = uiFontSize.normalizedMaxUiFontSize(context);
      if (states.has("applied")) {
        const maxima = new Set(candidates.map(({ source }) => uiFontSize.appliedUiFontSizeMax(source)));
        if (maxima.size !== 1 || !maxima.has(configuredMax)) {
          const reason = `Applied UI font-size maxima ${JSON.stringify([...maxima])} do not match ${configuredMax}`;
          console.warn(`WARN: ${reason} - skipping ui-tweaks UI font size patch`);
          return { matched: 0, changed: 0, reason };
        }
        return { matched: candidates.length, changed: 0,
          targets: candidates.map(({ target }) => path.relative(extractedDir, target)) };
      }
      const patched = candidates.map((candidate) => ({
        ...candidate, patched: uiFontSize.applyUiFontSizePatch(candidate.source, context),
      }));
      if (patched.some(({ source, patched: result }) => result === source ||
          uiFontSize.fontSizeLimitContract(result) !== "applied" ||
          uiFontSize.appliedUiFontSizeMax(result) !== configuredMax)) {
        const reason = "Could not patch and validate every current UI font-size contract";
        console.warn(`WARN: ${reason} - skipping ui-tweaks UI font size patch`);
        return { matched: 0, changed: 0, reason };
      }
      for (const { target, patched: result } of patched) fs.writeFileSync(target, result);
      return { matched: candidates.length, changed: candidates.length,
        targets: candidates.map(({ target }) => path.relative(extractedDir, target)) };
    },
    status(result, warnings) {
      if (result?.matched !== expected.build + expected.webview) {
        return { status: "skipped-optional", reason: result?.reason ?? warnings[0] ?? null };
      }
      return result.changed > 0 ? "applied" : "already-applied";
    },
  };
}

function normalizeCurrentCustomFontLabel(source) {
  const clean = '{id:"settings.general.appearance.chromeTheme.customFontValue",defaultMessage:"Use custom font value"}';
  const current = source.split(clean).length - 1;
  if (current === 0) return source;
  if (current !== 1) throw Error(`Expected one current custom-font label, found ${current}`);
  return source.replace(clean,
    '{id:"settings.general.appearance.chromeTheme.customFontValue",defaultMessage:"Use custom font value",' +
    'description:"Use a custom CSS font value"}');
}

function currentCustomFontDescriptor() {
  const legacy = customFontInput.descriptors[0];
  return {
    ...legacy,
    assetMatch: (source) => customFontInput.fontPickerContract(normalizeCurrentCustomFontLabel(source)) != null,
    apply(source, context) {
      return customFontInput.applyCustomFontInputPatch(normalizeCurrentCustomFontLabel(source), context);
    },
  };
}

function normalizeWrappedFactories(source) {
  const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
  const marker = "export const __webpack_modules__={";
  const start = source.indexOf(marker);
  if (start < 0) return source;
  const edits = [];
  const head = /(?<key>[A-Za-z_$][\w$]*|"[^"\\]+"):\(function\((?<params>[A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*)?\)\{/gy;
  let cursor = start + marker.length;
  while (cursor < source.length && source[cursor] !== "}") {
    if (source[cursor] === ",") cursor += 1;
    head.lastIndex = cursor;
    const wrapped = head.exec(source);
    if (wrapped) {
      const open = head.lastIndex - 1;
      const close = findMatchingBrace(source, open);
      if (close < 0 || source[close + 1] !== ")") throw Error("Unterminated wrapped rspack factory");
      edits.push({ start: cursor, end: open + 1, text: `${wrapped.groups.key}(${wrapped.groups.params ?? ""}){` });
      edits.push({ start: close + 1, end: close + 2, text: "" });
      cursor = close + 2;
      continue;
    }
    const ordinary = /(?:[A-Za-z_$][\w$]*|"[^"\\]+")\([^)]*\)\{/y;
    ordinary.lastIndex = cursor;
    const match = ordinary.exec(source);
    if (!match) return source;
    const close = findMatchingBrace(source, ordinary.lastIndex - 1);
    if (close < 0) return source;
    cursor = close + 1;
  }
  let normalized = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) normalized = normalized.slice(0, edit.start) + edit.text + normalized.slice(edit.end);
  return normalized;
}

function normalizeCurrentQuickChatOwner(source) {
  const outer = /function (?<fn>[A-Za-z_$][\w$]*)\((?<scope>[A-Za-z_$][\w$]*),\{projectId:(?<project>[A-Za-z_$][\w$]*)=null,projectName:(?<name>[A-Za-z_$][\w$]*)=null,preservePreviousSession:(?<preserve>[A-Za-z_$][\w$]*)=!1,pageOwnerKey:(?<owner>[A-Za-z_$][\w$]*),previewSession:(?<preview>[A-Za-z_$][\w$]*),\.\.\.(?<rest>[A-Za-z_$][\w$]*)\}=\{\}\)\{/g;
  const inner = /function\((?<scope>[A-Za-z_$][\w$]*),\{conversationId:(?<conversation>[A-Za-z_$][\w$]*)=(?<make>\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\)\(\)),contextSourceThread:(?<thread>[A-Za-z_$][\w$]*)=null,projectId:(?<project>[A-Za-z_$][\w$]*)=null,projectName:(?<name>[A-Za-z_$][\w$]*)=null,preservePreviousSession:(?<preserve>[A-Za-z_$][\w$]*)=!1,pageOwnerKey:(?<owner>[A-Za-z_$][\w$]*),previewSession:(?<preview>[A-Za-z_$][\w$]*)\}=\{\}\)\{/g;
  const outerMatches = [...source.matchAll(outer)];
  const innerMatches = [...source.matchAll(inner)];
  if (outerMatches.length === 0 && innerMatches.length === 0) return source;
  if (outerMatches.length !== 1 || innerMatches.length !== 1) {
    throw Error(`Expected one current Quick Chat owner pair, found ${outerMatches.length}/${innerMatches.length}`);
  }
  const outerGroups = outerMatches[0].groups;
  const innerGroups = innerMatches[0].groups;
  let normalized = source.replace(outer, (...args) => {
    const original = args[0];
    const groups = args.at(-1);
    const replacement = `function ${groups.fn}(${groups.scope},{projectId:${groups.project}=null,projectName:${groups.name}=null,` +
      `preservePreviousSession:${groups.preserve}=!1,previewSession:${groups.preview},...${groups.rest}}={}){` +
      `let ${groups.owner}=${groups.rest}.pageOwnerKey;`;
    return selectedTextMoreDetails.normalizationReplacementSpan(original, replacement);
  });
  normalized = normalized.replace(inner, (...args) => {
    const original = args[0];
    const groups = args.at(-1);
    const replacement = `function(${groups.scope},{conversationId:${groups.conversation}=${groups.make},` +
      `contextSourceThread:${groups.thread}=null,projectId:${groups.project}=null,projectName:${groups.name}=null,` +
      `preservePreviousSession:${groups.preserve}=!1,previewSession:${groups.preview}}={}){` +
      `let ${groups.owner}=${groups.preview}?.pageOwnerKey;`;
    return selectedTextMoreDetails.normalizationReplacementSpan(original, replacement);
  });
  const forwardedOwner = `pageOwnerKey:${outerGroups.owner},previewSession:${outerGroups.preview}`;
  const forwardedCount = normalized.split(forwardedOwner).length - 1;
  if (forwardedCount !== 1) throw Error(`Expected one current Quick Chat owner forwarding call, found ${forwardedCount}`);
  normalized = normalized.replace(forwardedOwner,
    selectedTextMoreDetails.normalizationReplacementSpan(forwardedOwner,
      `previewSession:null==${outerGroups.preview}?{pageOwnerKey:${outerGroups.owner}}:` +
      `{...${outerGroups.preview},pageOwnerKey:${outerGroups.owner}}`));
  if (normalized === source || outerGroups.owner === innerGroups.owner && outerGroups.rest === innerGroups.scope) {
    throw Error("Could not normalize the current Quick Chat owner contract");
  }
  return normalized;
}

function normalizeCurrentQuickChatSessionSetter(source) {
  const ident = "[A-Za-z_$][\\w$]*";
  const setterPattern = new RegExp(
    `function (?<setter>${ident})\\((?<scope>${ident}),(?<value>${ident})\\)\\{` +
      `if\\(\\k<scope>\\.set\\((?<atom>${ident}),\\k<value>\\),null!=\\k<value>\\.pageOwnerKey\\)\\{`,
    "g",
  );
  const setters = [...source.matchAll(setterPattern)];
  if (setters.length === 0) return source;
  if (setters.length !== 1) throw Error(`Expected one current Quick Chat session setter, found ${setters.length}`);
  const { setter, atom } = setters[0].groups;
  const callPattern = new RegExp(
    `${setter}\\((?<scope>${ident}),(?<object>\\{contextSourceThread:${ident},conversationId:${ident},` +
      `hasConversation:!1,pageOwnerKey:${ident},surfaceOwner:(?<preview>${ident})\\?\\.surfaceOwner,` +
      `previewId:\\k<preview>\\?\\.previewId,projectId:${ident},projectName:${ident},title:null\\})\\)`,
    "g",
  );
  const calls = [...source.matchAll(callPattern)];
  if (calls.length === 0) {
    const directPattern = new RegExp(
      `${ident}\\.set\\(${atom},\\{contextSourceThread:${ident},conversationId:${ident},` +
        `hasConversation:!1,pageOwnerKey:${ident},surfaceOwner:${ident}\\?\\.surfaceOwner,` +
        `previewId:${ident}\\?\\.previewId,projectId:${ident},projectName:${ident},title:null\\}\\)`,
      "g",
    );
    if ([...source.matchAll(directPattern)].length === 1) return source;
  }
  if (calls.length !== 1) throw Error(`Expected one current Quick Chat initial session write, found ${calls.length}`);
  return source.replace(callPattern, (...args) => {
    const original = args[0];
    const groups = args.at(-1);
    return selectedTextMoreDetails.normalizationReplacementSpan(original,
      `${groups.scope}.set(${atom},${groups.object}),${setter}(${groups.scope},${groups.scope}.get(${atom}))`);
  });
}

function normalizeCurrentQuickChatSubmission(source) {
  const ident = "[A-Za-z_$][\\w$]*";
  const callPattern = new RegExp(
    `await \\(0,(?<namespace>${ident})\\.submitChatGPTCompletion\\)\\((?<scope>${ident}),` +
      `\\{(?<before>conversationId:${ident},isTemporaryChat:${ident},isSubmissionCurrent:${ident},` +
      `messageMetadata:${ident},)model:(?<model>${ident})\\.slug,` +
      `(?<middle>[\\s\\S]{0,700}?)thinkingEffort:\\k<model>\\.thinkingEffort,`,
    "g",
  );
  const calls = [...source.matchAll(callPattern)];
  if (calls.length === 1) {
    source = source.replace(callPattern, (...args) => {
      const original = args[0];
      const groups = args.at(-1);
      return selectedTextMoreDetails.normalizationReplacementSpan(original,
        `await (0,${groups.namespace}.submitChatGPTCompletion)(${groups.scope},` +
        `{${groups.before}model:${groups.model}.slug,thinkingEffort:${groups.model}.thinkingEffort,${groups.middle}`);
    });
  } else if (calls.length > 1) {
    throw Error(`Expected one current ChatGPT native submission call, found ${calls.length}`);
  }

  const currentInput = /startupSignal:(?<signal>[A-Za-z_$][\w$]*),requireDispatchAcceptance:(?<accept>[A-Za-z_$][\w$]*),\.\.\.(?<rest>[A-Za-z_$][\w$]*)\}\)\{/g;
  const inputs = [...source.matchAll(currentInput)];
  if (inputs.length === 1) {
    source = source.replace(currentInput, (...args) => {
      const original = args[0];
      const groups = args.at(-1);
      const replacement = `startupSignal:${groups.signal},requireDispatchAcceptance:${groups.accept},` +
        `requireResponseAcceptance:codexLinuxLegacyResponseAcceptance,` +
        `isRequestCurrent:codexLinuxLegacyRequestCurrent,...${groups.rest}}){` +
        `${groups.accept}??=codexLinuxLegacyResponseAcceptance;` +
        `null!=codexLinuxLegacyRequestCurrent&&(${groups.rest}.isSubmissionCurrent=codexLinuxLegacyRequestCurrent);`;
      return selectedTextMoreDetails.normalizationReplacementSpan(original, replacement);
    });
  } else if (inputs.length > 1) {
    throw Error(`Expected one current ChatGPT submission input contract, found ${inputs.length}`);
  }
  return source;
}

function normalizeCurrentQuickChatDispatch(source) {
  const acceptance = /[A-Za-z_$][\w$]*\.isEventStream&&[A-Za-z_$][\w$]*\.requireResponseAcceptance[^;]{0,100}\?\.resolve\(null\)/g;
  const matches = [...source.matchAll(acceptance)];
  if (matches.length === 0) return source;
  if (matches.length !== 1) throw Error(`Expected one current response-acceptance dispatch, found ${matches.length}`);
  if (source.slice(Math.max(0, matches[0].index - 24), matches[0].index).includes("gizmoEditor??")) return source;
  return source.slice(0, matches[0].index) +
    selectedTextMoreDetails.normalizationSpan("/*gizmoEditor??*/") + source.slice(matches[0].index);
}

function currentRspackModules(source) {
  return source.includes("export const __webpack_modules__={")
    ? selectedTextMoreDetails.chunkModules(source)
    : [];
}

function normalizeCurrentQuickChatDispatchOwner(source) {
  if (source.includes("codexLinuxCurrentSubmitProxy")) return source;
  const modules = currentRspackModules(source);
  if (modules.length === 0) return source;
  const callPattern = /await \(0,(?<namespace>[A-Za-z_$][\w$]*)\.submitChatGPTCompletion\)\((?<scope>[A-Za-z_$][\w$]*),\{conversationId:/g;
  const calls = [...source.matchAll(callPattern)];
  if (calls.length !== 1) return source;
  const call = calls[0];
  const follower = modules.find((module) => call.index >= module.start && call.index < module.end);
  const dispatches = modules.filter((module) => {
    const text = source.slice(module.start, module.end);
    return text.includes("startCompletionStream") && text.includes("/*gizmoEditor??*/") &&
      /\.isEventStream&&[A-Za-z_$][\w$]*\.requireResponseAcceptance/.test(text);
  });
  if (follower == null || dispatches.length !== 1) {
    throw Error(`Expected current Quick Chat follower and one native dispatch owner, found ${Number(follower != null)}/${dispatches.length}`);
  }
  const dispatch = dispatches[0];
  const followerRequire = follower.params[2];
  const dispatchExports = dispatch.params[1];
  const dispatchRequire = dispatch.params[2];
  if (![followerRequire, dispatchExports, dispatchRequire].every((name) => /^[A-Za-z_$][\w$]*$/.test(name))) {
    throw Error("Current Quick Chat module parameters drifted");
  }
  const binding = new RegExp(
    `(?:var |[,;])${call.groups.namespace}=${followerRequire}\\("([^"]+)"\\)`,
    "g",
  );
  const bindings = [...source.slice(follower.start, follower.end).matchAll(binding)];
  if (bindings.length !== 1) throw Error(`Expected one current Quick Chat submission import, found ${bindings.length}`);
  const originalId = bindings[0][1];
  const original = modules.find((module) => module.id === originalId);
  if (original == null || originalId === dispatch.id) {
    throw Error("Current Quick Chat submission module drifted");
  }
  const originalText = source.slice(original.start, original.end);
  const guardPattern = /null==[A-Za-z_$][\w$]*&&![A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\.get\((?<namespace>[A-Za-z_$][\w$]*)\.(?<member>[A-Za-z_$][\w$]*)\)\)throw new /g;
  const guards = [...originalText.matchAll(guardPattern)];
  if (guards.length !== 1) throw Error(`Expected one current ChatGPT submission guard, found ${guards.length}`);
  const originalRequire = original.params[2];
  const guardBinding = new RegExp(
    `(?:var |[,;])${guards[0].groups.namespace}=${originalRequire}\\("([^"]+)"\\)`,
    "g",
  );
  const guardBindings = [...originalText.matchAll(guardBinding)];
  if (guardBindings.length !== 1) throw Error(`Expected one current ChatGPT guard import, found ${guardBindings.length}`);
  const blockedModuleId = guardBindings[0][1];
  const blockedMember = guards[0].groups.member;
  const proxy = `;async function codexLinuxCurrentSubmitProxy(e,t){` +
    `/*Lockdown mode blocks connector approvals extraDeveloperInstructions: messageMetadata: ` +
    `requireResponseAcceptance: isRequestCurrent:*/` +
    `let n=t.previewSession;if(!n&&e.get(codexLinuxCurrentBlocked.${blockedMember}))` +
    `throw new Error("ChatGPT submission blocked");` +
    `return ${dispatchRequire}(${JSON.stringify(originalId)})` +
    `.submitChatGPTCompletion(e,t)}${dispatchRequire}.d(${dispatchExports},{},` +
    `{submitChatGPTCompletion:()=>codexLinuxCurrentSubmitProxy});` +
    `var codexLinuxCurrentBlocked=${dispatchRequire}(${JSON.stringify(blockedModuleId)});`;
  const importProxy = `;var codexLinuxCurrentSubmitModule=${followerRequire}(${JSON.stringify(dispatch.id)});`;
  const normalizedCall = call[0].replace(`${call.groups.namespace}.submitChatGPTCompletion`,
    "codexLinuxCurrentSubmitModule.submitChatGPTCompletion");
  const insideNormalizedReplacement =
    source.lastIndexOf("/*codex-linux-selected-text-more-details-normalize:~", call.index) >
    source.lastIndexOf("/*codex-linux-selected-text-more-details-normalize:-*/", call.index);
  const edits = [
    { start: call.index, end: call.index + call[0].length,
      text: insideNormalizedReplacement ? normalizedCall :
        selectedTextMoreDetails.normalizationReplacementSpan(call[0], normalizedCall) },
    { start: follower.bodyEnd, end: follower.bodyEnd,
      text: selectedTextMoreDetails.normalizationSpan(importProxy) },
    { start: dispatch.bodyEnd, end: dispatch.bodyEnd,
      text: selectedTextMoreDetails.normalizationSpan(proxy) },
  ];
  let normalized = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    normalized = normalized.slice(0, edit.start) + edit.text + normalized.slice(edit.end);
  }
  return normalized;
}

function currentSelectedTextDescriptor() {
  const legacy = selectedTextMoreDetails.descriptors[0];
  return {
    ...legacy,
    apply(extractedDir, context) {
      if (!legacy.enabled(context)) return { matched: 0, changed: 0 };
      const assets = path.join(extractedDir, "webview", "assets");
      try {
        const originals = {};
        const targets = {};
        const references = [];
        let managedInput = false;
        for (const directory of ["", "async"]) {
          const dir = path.join(assets, directory);
          if (!fs.existsSync(dir)) continue;
          for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".js"))) {
            const name = directory ? `${directory}/${file}` : file;
            const target = path.join(dir, file);
            const source = fs.readFileSync(target, "utf8");
            const upstream = selectedTextMoreDetails.restoreUpstream(source);
            if (upstream !== source) managedInput = true;
            const isRuntime = upstream.includes("has-opened-quick-chat-v1");
            const isOverlay = ["onAddResponseTextAnnotation:", "targetContainerRefs:",
              "{actions:", "canOpenSideChat:"].every((needle) => upstream.includes(needle));
            if (isRuntime || isOverlay) {
              originals[name] = source;
              targets[name] = normalizeCurrentQuickChatSessionSetter(
                normalizeCurrentQuickChatDispatchOwner(
                  normalizeCurrentQuickChatSubmission(
                    normalizeCurrentQuickChatDispatch(
                      normalizeCurrentQuickChatOwner(upstream),
                    ),
                  ),
                ),
              );
            } else if (upstream.includes('id:"selectedTextOverlay.moreDetails"') &&
                upstream.includes("onMoreDetails:")) {
              references.push(upstream);
            }
          }
        }
        const result = selectedTextMoreDetails.patchSources(targets, references);
        const names = Object.keys(targets).sort();
        const changed = names.filter((name) => result.chunks[name] !== originals[name]);
        if (managedInput && changed.length > 0) {
          throw Error("Incomplete or drifted current selected-text adaptation");
        }
        for (const name of changed) fs.writeFileSync(path.join(assets, name), result.chunks[name]);
        const patchedNames = names.filter((name) => selectedTextMoreDetails.hasPatchSpans(result.chunks[name]));
        return { matched: patchedNames.length, changed: changed.length,
          targets: patchedNames.map((name) => path.join("webview", "assets", name)) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`WARN: Could not restore selected-text More details: ${reason} - skipping ui-tweaks patch`);
        return { matched: 0, changed: 0, reason };
      }
    },
  };
}

module.exports = {
  descriptors: patchesFrom(
    sidebarProjectName,
    { descriptors: [currentUiFontSizeDescriptor()] },
    modelPickerModelList,
    { descriptors: [currentReasoningLabelsDescriptor()] },
    dockIcon,
    suggestedPrompts,
    { descriptors: [currentCustomFontDescriptor()] },
    { descriptors: [currentSelectedTextDescriptor()] },
    selectedTextAnnotationSubmit,
  ),
};
