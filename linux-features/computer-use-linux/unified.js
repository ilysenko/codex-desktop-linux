"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");
const { Script } = require("node:vm");
const { mainProcessFactories } = require("../../scripts/patches/lib/main-process-factories.js");
const { escapeRegExp, findMatchingBrace, createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const ROOT_KEY = "codexLinuxCuaPluginRoot";
const CONTEXT_KEY = "codexLinuxCuaContext";
const ROOT_PLACEHOLDER = "\u0000ROOT\u0000";

function drift(description) {
  return new Error(`Linux unified Computer Use contract drift: ${description}`);
}

function uniqueMatch(source, pattern, description) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw drift(description);
  return matches[0];
}

function bindingReferences(source, name) {
  // Include bare references as well as calls so an added alias/export fails
  // closed. Property accesses such as constants.Aa and private class members
  // such as #Aa are different bindings.
  const lexical = createJavaScriptLexicalIndex(source);
  const uses = [...source.matchAll(new RegExp(`(?<![\\w$.#])${escapeRegExp(name)}(?![\\w$])`, "g"))].filter(match => {
    if (!lexical.isCode(match.index)) return false;
    let before = match.index - 1, after = match.index + match[0].length;
    while (before >= 0 && (!lexical.isCode(before) || /\s/u.test(source[before]))) before--;
    while (after < source.length && (!lexical.isCode(after) || /\s/u.test(source[after]))) after++;
    // Native vendored tables contain identifier-key data properties. A
    // conditional value before a colon remains a real binding reference.
    return source[after] !== ":" || !["{", ","].includes(source[before]);
  });
  return uses;
}

function requireUsages(source, name, expected) {
  if (bindingReferences(source, name).length !== expected) throw drift(`unexpected ${name} consumers`);
}

// Keep relationships inside the actual CommonJS factory body. Standalone
// source text remains the pure transformer representation of one module.
function moduleBounds(source, index) {
  const factories = mainProcessFactories(source);
  if (factories.length === 0) return { start: 0, end: source.length };
  const owners = factories.filter(factory => factory.start <= index && index < factory.end);
  if (owners.length !== 1) throw drift("missing or ambiguous selector factory");
  return { start: owners[0].start, end: owners[0].end };
}

function codeAt(source, index) {
  return findMatchingBrace("{" + source.slice(0, index) + "}".repeat(index + 2), 0) >= index + 1;
}

function rootGuard(name) {
  return `if(typeof ${name}!==\`string\`||${name}.length===0)throw Error(\`Linux Computer Use trusted plugin root is unavailable\`);`;
}

// Chunk files are CommonJS modules, so injected code uses Node's require
// instead of a module-local rspack path alias.
function pluginFile(root, file) {
  return `require("node:path").join(${root},"scripts","${file}")`;
}

function bannerExpression(root) {
  return `'await import("@oai/cua/tinyskyAlt");await(await import('+JSON.stringify(${pluginFile(root, "native-client.mjs")})+")).installLinuxComputerUse(cua);"`;
}

function rootPattern(source) {
  return escapeRegExp(source).replace(escapeRegExp(ROOT_PLACEHOLDER), `(?<pluginRoot>${ID})`);
}

function uniqueCodeMatch(source, pattern, description) {
  const matches = [...source.matchAll(pattern)].filter(match => codeAt(source, match.index));
  if (matches.length !== 1) throw drift(description);
  return matches[0];
}

function functionOwnsBinding(source, owner, name) {
  const body = source.slice(owner.open + 1, owner.end - 1);
  try { new Script(`async function owner(${owner.parameters}){${body}\n;let ${name};}`); return false; }
  catch { return true; }
}

function assertRootDeclaration(source, owner) {
  if (owner?.name == null || !codeAt(source, owner.start)) throw drift("expected a named native root declaration");
  const prefix = source.slice(0, owner.start);
  if (findMatchingBrace("{" + prefix + "}", 0) !== prefix.length + 1) throw drift("native declaration is nested outside its owner");
  try { new Script(`function declarationScope(){${prefix}\nconst codexLinuxDeclarationProbe=0;}`); }
  catch { throw drift("native function is not a root declaration"); }
  const header = source.slice(owner.start, source.indexOf("(", owner.start));
  const declared = owner.start + header.lastIndexOf(owner.name);
  const tokens = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  const references = [];
  for (const token of source.matchAll(tokens)) {
    if (token[0] !== owner.name && !token[0].includes("\\u")) continue;
    const decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => {
      const value = parseInt(braced || fixed, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : "\0";
    });
    if (decoded !== owner.name || token.index === declared || (source[token.index - 1] === "." || source[token.index - 1] === "#") ||
        /^\s*:/u.test(source.slice(token.index + token[0].length)) || !codeAt(source, token.index)) continue;
    references.push({ start: token.index, end: token.index + token[0].length });
  }
  let probe = source;
  for (const range of references.reverse()) probe = probe.slice(0, range.start) + "(0)" + probe.slice(range.end);
  try { new Script(`function bindingScope(){${probe}\n}`); }
  catch { throw drift(`native ${owner.name} binding is shadowed or written outside its declaration`); }
}

function enclosingFunction(source, targetIndex) {
  const functions = new RegExp(String.raw`(?:async )?function(?: (?<name>${ID}))?\((?<parameters>[^)]*)\)\{`, "gu");
  const owners = [];
  for (const candidate of source.matchAll(functions)) {
    if (candidate.index > targetIndex) break;
    if (!codeAt(source, candidate.index)) continue;
    const open = candidate.index + candidate[0].length - 1;
    const close = findMatchingBrace(source, open);
    const prefix = source.slice(0, candidate.index);
    const modifier = /\basync(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*[\r\n])*$/.exec(prefix);
    const modifierStart = modifier && codeAt(source, modifier.index) ? modifier.index : null;
    const isAsync = candidate[0].startsWith("async ") || modifierStart != null;
    if (close >= targetIndex) owners.push({ start: modifierStart ?? candidate.index, end: close + 1, open, isAsync,
      name: candidate.groups.name ?? null, parameters: candidate.groups.parameters });
  }
  return owners.sort((left, right) => left.end - left.start - (right.end - right.start))[0] ?? null;
}

function serializedQueueContract(source, initializer) {
  const queue = enclosingFunction(source, initializer.start - 1);
  if (queue == null || queue.isAsync) throw drift("expected ordinary plugin synchronization queue");
  assertRootDeclaration(source, queue);
  const prefix = source.slice(queue.start, initializer.start);
  const head = uniqueMatch(prefix, new RegExp(
    String.raw`^function (?<name>${ID})\((?<argument>${ID})\)\{let (?<pending>${ID})=\((?<cache>${ID})\.get\(\k<argument>\.appServerConnection\)\?\?Promise\.resolve\(\)\)\.catch\(\(\)=>\{\}\)\.then\(\(\)=>\($`, "g"),
    "expected native serialized plugin synchronization queue");
  const { name, argument, pending, cache } = head.groups;
  const suffix = `)(${argument}));return ${cache}.set(${argument}.appServerConnection,${pending}),${pending}}`;
  if (source.slice(initializer.end, queue.end) !== suffix || queue.name !== name ||
      !initializer.isAsync || initializer.name != null ||
      !initializer.parameters.startsWith("{appServerConnection:") || !initializer.parameters.endsWith("}")) {
    throw drift("plugin initialization is disconnected from its native queue");
  }
  requireUsages(source, name, 3);
  requireUsages(source, cache, 5);
  uniqueCodeMatch(source, new RegExp(String.raw`(?<![\w$.#])${escapeRegExp(cache)}=new WeakMap(?=[,;])`, "g"),
    "expected native per-connection synchronization cache");
  uniqueCodeMatch(source, new RegExp(
    String.raw`async syncAfterPluginChange\(\)\{let (?<pending>${ID})=${escapeRegExp(name)}\(\{\.\.\.this\.options,reloadUserConfig:!1\}\);` +
    String.raw`for\(let (?<outcome>${ID}) of\(await Promise\.allSettled\(\[\k<pending>,this\.onPluginsChanged\?\.\(\)\]\)\)\)` +
    String.raw`if\("rejected"===\k<outcome>\.status\)throw \k<outcome>\.reason\}`, "g"),
    "expected native plugin-change queue consumer and failure propagation");
  uniqueCodeMatch(source, new RegExp(
    String.raw`await ${escapeRegExp(name)}\(\{appServerConnection:(?<options>${ID})\.getLocalAppServerConnection\(\),` +
    String.raw`appVersion:\k<options>\.appVersion,getDesktopFeatureAvailability:\(\)=>${ID}\?\?${ID},` +
    String.raw`isPackaged:\k<options>\.isPackaged,platform:${ID},repoRoot:\k<options>\.repoRoot,resourcesPath:${ID}\}\)`, "g"),
    "expected native startup queue consumer");
  return cache;
}

function cacheReaderContract(source, cache, resumeSource, posture, argument) {
  const access = uniqueMatch(resumeSource, new RegExp(
    String.raw`(?<cached>${ID})=(?<local>${ID})\?await (?<reader>${ID})\((?<connection>${ID}),\{waitForReconcile:!1\}\):null,`, "g"),
    "expected thread configuration to read its connection cache");
  if (!new RegExp(`^${ID}$`).test(argument)) throw drift("unexpected thread configuration arguments");
  uniqueCodeMatch(resumeSource, new RegExp(String.raw`\{appServerConnection:${escapeRegExp(access.groups.connection)}\}=${escapeRegExp(argument)},` +
    String.raw`${escapeRegExp(access.groups.local)}="local"===${escapeRegExp(access.groups.connection)}\.hostConfig\.kind,`, "g"),
    "expected cached configuration to use its current local connection");
  uniqueMatch(resumeSource, new RegExp(
    String.raw`${escapeRegExp(posture)}=${ID}\.browserUseTinysky\?${escapeRegExp(access.groups.cached)}:null`, "g"),
    "expected thread browser posture to use synchronized cache data");
  const reader = access.groups.reader;
  const declaration = uniqueCodeMatch(source, new RegExp(String.raw`async function ${escapeRegExp(reader)}\(${ID},\{waitForReconcile:(?<wait>${ID})=!0\}=\{\}\)\{`, "g"),
    "expected one native connection cache reader declaration");
  assertRootDeclaration(source, enclosingFunction(source, declaration.index));
  const declarationName = declaration.index + "async function ".length;
  const references = bindingReferences(source, reader);
  for (const reference of references) {
    if (reference.index === declarationName) continue;
    if (!/await $/.test(source.slice(0, reference.index)) ||
        !new RegExp(String.raw`^${escapeRegExp(reader)}\(${ID}(?:,\{waitForReconcile:!1\})?\)`).test(source.slice(reference.index))) {
      throw drift("native connection cache reader is aliased or rebound");
    }
  }
  uniqueCodeMatch(source, new RegExp(
    String.raw`async function ${escapeRegExp(reader)}\((?<connection>${ID}),\{waitForReconcile:${escapeRegExp(declaration.groups.wait)}=!0\}=\{\}\)\{for\(;;\)\{let ` +
    String.raw`(?<otherPending>${ID})=(?<otherCache>${ID})\.get\(\k<connection>\);if\(null!=\k<otherPending>&&!${escapeRegExp(declaration.groups.wait)}\)return null;let (?<pending>${ID})=${escapeRegExp(cache)}\.get\(\k<connection>\),` +
    String.raw`(?<value>${ID})=await Promise\.all\(\[\k<otherPending>,\k<pending>\]\)\.then\(\(\[,(?<result>${ID})\]\)=>\k<result>\?\?null,\(\)=>null\);` +
    String.raw`if\(\k<otherPending>===\k<otherCache>\.get\(\k<connection>\)&&\k<pending>===${escapeRegExp(cache)}\.get\(\k<connection>\)\)return \k<value>\}\}`, "g"),
    "expected stable native plugin-work and synchronization cache snapshot");
}

function lifecycleContract(source, builder, configuration) {
  if (!configuration.isAsync || configuration.name != null || !new RegExp(`^${ID}$`).test(configuration.parameters)) {
    throw drift("expected one directly invoked async anonymous plugin configuration owner");
  }
  const argument = configuration.parameters;
  requireUsages(source, builder, 3);
  const enabled = uniqueMatch(source.slice(0, configuration.start), new RegExp(String.raw`(?<![\w$.#])(?<enabled>${ID})=await $`, "g"),
    "expected awaited native plugin configuration result");
  const call = uniqueMatch(source.slice(configuration.end), new RegExp(
    String.raw`^\(\{browserBackends:(?<backends>${ID}),deferTools:(?<features>${ID})\.deferCuaTools,` +
    String.raw`surfaces:(?<surfaces>${ID}),codexHome:(?<home>${ID}),marketplaceName:(?<marketplace>${ID}),marketplaces:${ID},nodeRepl:${ID}\?void 0:${ID}` +
    String.raw`(?<context>,${CONTEXT_KEY}:(?<selection>${ID}))?\}\)`, "g"),
    "expected direct native plugin configuration invocation");
  const sync = { 0: call[0], index: configuration.end, groups: { ...call.groups, enabled: enabled.groups.enabled } };
  const initializer = enclosingFunction(source, configuration.start - 1);
  if (initializer == null) throw drift("expected a plugin initialization owner");
  const cache = serializedQueueContract(source, initializer);
  const initializationSource = source.slice(initializer.start, initializer.end);
  const cached = uniqueCodeMatch(initializationSource, new RegExp(
    String.raw`(?:return |,)\{selection:(?<selection>${ID}),cuaReplEnabled:${escapeRegExp(sync.groups.enabled)}\}`, "g"),
    "expected synchronized selection to be cached with CUA enabled state");
  if (initializationSource.slice(cached.index + cached[0].length) !== "}" ||
      !functionOwnsBinding(source, initializer, cached.groups.selection)) {
    throw drift("cached selection is not the initialization result binding");
  }
  uniqueMatch(initializationSource, new RegExp(String.raw`(?:let |,)${escapeRegExp(cached.groups.selection)}=`, "g"),
    "expected cached selection to belong to plugin initialization");
  uniqueMatch(initializationSource, new RegExp(
    String.raw`\{codexHome:${escapeRegExp(call.groups.home)},marketplaceName:${escapeRegExp(call.groups.marketplace)},runtimePaths:${ID},` +
    String.raw`browserBackends:${escapeRegExp(call.groups.backends)},cuaReplSurfaces:${escapeRegExp(call.groups.surfaces)}\}=${escapeRegExp(cached.groups.selection)}`, "g"),
    "expected configuration inputs to belong to the cached selection");
  const resume = uniqueCodeMatch(source, new RegExp(
    String.raw`(?<![\w$.#])${escapeRegExp(builder)}\(\{browserBackends:(?<selection>${ID})\.browserBackends,` +
    String.raw`deferTools:\k<selection>\.desktopFeatureAvailability\.deferCuaTools,surfaces:\k<selection>\.cuaReplSurfaces,` +
    String.raw`nodeRepl:${ID}\}(?<root>,\k<selection>\.${ROOT_KEY})?\)`, "g"),
    "expected one thread configuration builder call");
  const resumeOwner = enclosingFunction(source, resume.index);
  if (resumeOwner == null || !resumeOwner.isAsync) throw drift("expected an async thread configuration owner");
  assertRootDeclaration(source, resumeOwner);
  const resumeSource = source.slice(resumeOwner.start, resumeOwner.end);
  const selection = escapeRegExp(resume.groups.selection);
  const posture = uniqueMatch(resumeSource, new RegExp(
    String.raw`(?<cached>${ID})=${ID}\.browserUseTinysky\?${ID}:null,` +
    String.raw`${ID}=${ID}\?await ${ID}\.getAuthenticatedPrincipal\(\)\.catch\(\(\)=>null\):null,` +
    String.raw`${selection}=\k<cached>\?\.selection\?\?await ${ID}\(`, "g"),
    "expected thread configuration to reuse the cached selection");
  cacheReaderContract(source, cache, resumeSource, posture.groups.cached, resumeOwner.parameters);
  const reassignments = [...resumeSource.matchAll(new RegExp(String.raw`(?<![\w$.#])${selection}=(?!=)`, "g"))];
  const copies = [...resumeSource.matchAll(new RegExp(String.raw`(?<![\w$.#])${selection}=\{\.\.\.${selection},`, "g"))];
  if (reassignments.length !== 1 + copies.length) throw drift("thread configuration replaces the cached selection");
  if (sync.groups.context != null && sync.groups.selection !== cached.groups.selection) throw drift("plugin root receiver is not the cached selection");
  return { argument, sync, resume, selection: cached.groups.selection };
}

function freshBuilderRoot(source) {
  const identifiers = new Set(source.match(/[A-Za-z_$][\w$]*/g));
  const base = ROOT_KEY;
  let name = base;
  for (let suffix = 1; identifiers.has(name); suffix += 1) name = `${base}${suffix}`;
  return name;
}

function selectorPattern() {
  return /(?<native>[\w$]+)=(?<ready>[\w$]+)&&(?<features>[\w$]+)\.computerUse&&(?<legacy>[\w$]+)\.enabled&&\("win32"===(?<runtime>[\w$]+)\.platform\|\|"darwin"===\k<runtime>\.platform&&null!=\k<legacy>\.paths\.serviceAppPath\)(?<linux>\|\|\k<ready>&&"linux"===\k<runtime>\.platform&&\k<features>\.computerUse&&\k<legacy>\.enabled)?,(?<mode>[\w$]+)=(?<modeLinux>"linux"===\k<runtime>\.platform\?\k<native>:)?(?<modeValue>\k<features>\.computerUse&&\(!\k<features>\.browserUseTinysky\|\|"darwin"!==\k<runtime>\.platform\|\|\k<legacy>\.enabled\))(?=,)/g;
}

function applyUnifiedComputerUsePatch(chunk) {
  if (!chunk.includes("cuaReplSurfaces")) {
    // The rspack main process spans several chunks; only one owns CUA setup.
    console.warn("WARN: Could not find the unified Computer Use surface selector - skipping Linux unified Computer Use patch");
    return chunk;
  }
  // Match the current selector, including variable relationships. Both pristine
  // and patched forms must have exactly one owner; drift must abort the build.
  const ownersPattern = /[\w$]+=[\w$]+&&[\w$]+\.computerUse&&[\w$]+\.enabled&&\("win32"===[\w$]+\.platform\|\|"darwin"===[\w$]+\.platform&&null!=[\w$]+\.paths\.serviceAppPath/g;
  const chunkSelectors = [...chunk.matchAll(selectorPattern())];
  if (chunkSelectors.length !== 1 || [...chunk.matchAll(ownersPattern)].length !== 1 || !chunk.includes("cuaReplSurfaces:")) {
    throw drift("expected one native surface selector");
  }
  const bounds = moduleBounds(chunk, chunkSelectors[0].index);
  const source = chunk.slice(bounds.start, bounds.end);
  const patchedModule = applyUnifiedComputerUseModulePatch(source);
  return patchedModule === source ? chunk : chunk.slice(0, bounds.start) + patchedModule + chunk.slice(bounds.end);
}

function applyUnifiedComputerUseModulePatch(source) {
  const match = uniqueMatch(source, selectorPattern(), "expected one native surface selector");
  const { native, ready, runtime, features, legacy, mode, modeValue, linux, modeLinux } = match.groups;
  if (Boolean(linux) !== Boolean(modeLinux)) throw drift("partial native selector patch");
  // The signed package shares a config builder between plugin synchronization
  // and per-thread configuration. Publish synchronization's verified root in
  // its cached selection, then pass that context through both builder calls.
  const builder = uniqueMatch(source, new RegExp(
    `function (?<builder>[\\w$]+)\\(\\{browserBackends:(?<backends>[\\w$]+),deferTools:(?<defer>[\\w$]+),` +
      `surfaces:(?<surfaces>[\\w$]+),nodeRepl:(?<nodeRepl>[\\w$]+),` +
      `accessBootstrapPath:(?<accessBootstrapPath>[\\w$]+)\\}(?<rootParam>,(?<pluginRoot>[\\w$]+))?\\)\\{`,
    "g",
  ), "expected one native config builder");
  const builderOwner = enclosingFunction(source, builder.index);
  if (builderOwner == null || builderOwner.isAsync || builderOwner.start !== builder.index) throw drift("expected one ordinary native config builder");
  assertRootDeclaration(source, builderOwner);
  const builderSource = source.slice(builderOwner.start, builderOwner.end);
  const { surfaces, nodeRepl } = builder.groups;
  const currentServices = [...builderSource.matchAll(new RegExp(
    `${surfaces}\\.includes\\("computer"\\)&&\\((?<services>[\\w$]+)\\.sky="@oai/sky/service"\\)`, "g"))];
  const patchedServices = [...builderSource.matchAll(new RegExp(
    `${surfaces}\\.includes\\("computer"\\)&&\\((?<services>[\\w$]+)\\.sky=` +
      `${rootPattern(pluginFile(ROOT_PLACEHOLDER, "native-service.mjs"))}\\)`, "g"))];
  const audioEnvironmentPattern =
    `(?<audio>\\.\\.\\.${nodeRepl}\\?\\.env\\.SKY_ENABLE_AUDIO==="1"\\?\\{` +
    `SKY_ENABLE_AUDIO:${surfaces}\\.includes\\("computer"\\)\\?"1":"0",` +
    `NODE_REPL_ENABLE_AUDIO:${surfaces}\\.includes\\("computer"\\)\\?${nodeRepl}\\.env\\.NODE_REPL_ENABLE_AUDIO:"0"\\}:\\{\\},)`;
  const environmentPrefix = `\\{\\.\\.\\.${nodeRepl}\\?\\.env,CUA_REPL_ENABLED_SURFACES:${surfaces}\\.join\\(","\\),`;
  const servicesEnvironment = `\\[(?<constants>[\\w$]+)\\.(?<constant>[\\w$]+)\\]:JSON\\.stringify\\((?<services>[\\w$]+)\\)`;
  const currentBanners = [...builderSource.matchAll(new RegExp(
    environmentPrefix + audioEnvironmentPattern + servicesEnvironment, "g"))];
  const patchedBanners = [...builderSource.matchAll(new RegExp(
    environmentPrefix + "CODEX_LINUX_CUA_HOST_SOCKET:process\\.env\\.CODEX_LINUX_CUA_HOST_SOCKET," +
      `NODE_REPL_JS_BANNER:${rootPattern(bannerExpression(ROOT_PLACEHOLDER))},` +
      audioEnvironmentPattern + servicesEnvironment, "g"))];
  // The packaged cua-repl instructions path rebuilds the environment but keeps
  // caller-provided trusted services and banner; anything else drops the bridge.
  const bannerKeys = builderSource.split("NODE_REPL_JS_BANNER:").length - 1;
  const serviceKeys = builderSource.split("NODE_REPL_TRUSTED_SERVICES:").length - 1;
  const bannerFallback = [...builderSource.matchAll(new RegExp(
    `NODE_REPL_JS_BANNER:(${ID})\\.NODE_REPL_JS_BANNER\\?\\?`, "g"))];
  const serviceFallback = [...builderSource.matchAll(new RegExp(
    `NODE_REPL_TRUSTED_SERVICES:(${ID})\\.NODE_REPL_TRUSTED_SERVICES\\?\\?`, "g"))];
  if (bannerFallback.length !== 1 || serviceFallback.length !== 1 || serviceKeys !== 1 ||
      bannerKeys !== 1 + patchedBanners.length) {
    throw drift("packaged cua-repl environment no longer preserves the native bridge");
  }
  if (/(?<![\w$.#])require(?![\w$]|\()/.test(builderSource)) {
    throw drift("native config builder shadows require");
  }
  const callPattern = new RegExp(
    `Object\\.assign\\([\\w$]+,${escapeRegExp(builder.groups.builder)}\\(\\{\\.\\.\\.(?<argument>[\\w$]+),` +
      `accessBootstrapPath:(?<accessBootstrapPath>[\\w$]+)\\}(?<rootArg>,(?<pluginRoot>[\\w$]+))?\\)\\)`,
    "g",
  );
  const calls = [...source.matchAll(callPattern)];
  const callOwner = calls.length === 1 ? enclosingFunction(source, calls[0].index) : null;
  const callOwnerSource = callOwner == null ? "" : source.slice(callOwner.start, callOwner.end);
  const pluginRoots = [...callOwnerSource.matchAll(new RegExp(
    `${ID}=${ID}\\(\\)\\.join\\((?<pluginRoot>${ID}),"\\.mcp\\.json"\\)`, "g"))];
  const lifecycle = lifecycleContract(source, builder.groups.builder, callOwner);
  const serviceCurrent = currentServices.length === 1 && patchedServices.length === 0;
  const servicePatched = currentServices.length === 0 && patchedServices.length === 1;
  const bannerCurrent = currentBanners.length === 1 && patchedBanners.length === 0;
  const bannerPatched = currentBanners.length === 0 && patchedBanners.length === 1;
  const current = !linux && builder.groups.rootParam == null && calls.length === 1 &&
    calls[0].groups.rootArg == null && serviceCurrent && bannerCurrent &&
    lifecycle.sync.groups.context == null && lifecycle.resume.groups.root == null;
  const patched = Boolean(linux) && builder.groups.rootParam != null && calls.length === 1 &&
    calls[0].groups.rootArg != null && servicePatched && bannerPatched &&
    lifecycle.sync.groups.context != null && lifecycle.resume.groups.root != null;
  if (!current && !patched) throw drift("expected one native trusted service selector");
  const service = current ? currentServices[0] : patchedServices[0];
  if (pluginRoots.length !== 1) throw drift("changed plugin cache relationship");
  const root = pluginRoots[0];
  const argument = lifecycle.argument;
  uniqueMatch(callOwnerSource, new RegExp(
    `${escapeRegExp(root.groups.pluginRoot)}=\\(0,${ID}\\.${ID}\\)\\(\\{codexHome:${escapeRegExp(argument)}\\.codexHome,` +
    `localVersion:(?<plugin>${ID})\\.plugin\\.localVersion,marketplaceName:\\k<plugin>\\.marketplace\\.name,pluginName:\\k<plugin>\\.plugin\\.name\\}\\)`, "g"),
  "expected plugin root derived from verified installed plugin metadata");
  const publishRoot = `${argument}.${CONTEXT_KEY}.${ROOT_KEY}=${root.groups.pluginRoot};`;
  const banner = current ? currentBanners[0] : patchedBanners[0];
  if (banner.groups.services !== service.groups.services) throw drift("changed native banner relationship");
  if (patched && (service.groups.pluginRoot !== builder.groups.pluginRoot ||
      banner.groups.pluginRoot !== builder.groups.pluginRoot ||
      calls[0].groups.pluginRoot !== root.groups.pluginRoot)) {
    throw drift("changed native service path relationship");
  }
  const completePropagation = callOwnerSource.split(publishRoot).length === 2 &&
    callOwnerSource.includes(publishRoot + calls[0][0]) &&
    builderSource.startsWith(builder[0] + rootGuard(builder.groups.pluginRoot));
  if ((current && callOwnerSource.includes(publishRoot)) || (patched && !completePropagation)) {
    throw drift("incomplete trusted root propagation");
  }
  if (patched) return source;
  const pluginRoot = root.groups.pluginRoot;
  // Caller and helper have independent minified scopes. A caller alias can be
  // an existing destructured parameter or local in the helper. Use a fresh
  // helper binding, including nested scopes that capture the injected value.
  const builderRoot = freshBuilderRoot(builderSource);
  const edits = [
    {
      index: match.index,
      length: match[0].length,
      replacement:
        `${native}=${ready}&&${features}.computerUse&&${legacy}.enabled&&("win32"===${runtime}.platform||"darwin"===${runtime}.platform&&null!=${legacy}.paths.serviceAppPath)` +
        `||${ready}&&"linux"===${runtime}.platform&&${features}.computerUse&&${legacy}.enabled,` +
        `${mode}="linux"===${runtime}.platform?${native}:${modeValue}`,
    },
    {
      index: builderOwner.start + service.index,
      length: service[0].length,
      replacement: `${surfaces}.includes("computer")&&(${service.groups.services}.sky=${pluginFile(builderRoot, "native-service.mjs")})`,
    },
    {
      index: builderOwner.start + banner.index,
      length: banner[0].length,
      replacement:
        `{...${nodeRepl}?.env,CUA_REPL_ENABLED_SURFACES:${surfaces}.join(","),` +
        "CODEX_LINUX_CUA_HOST_SOCKET:process.env.CODEX_LINUX_CUA_HOST_SOCKET," +
        `NODE_REPL_JS_BANNER:${bannerExpression(builderRoot)},` +
        banner.groups.audio +
        `[${banner.groups.constants}.${banner.groups.constant}]:JSON.stringify(${banner.groups.services})`,
    },
    {
      index: builder.index + builder[0].length - 2,
      length: 1,
      replacement: `,${builderRoot})`,
    },
    {
      index: builder.index + builder[0].length,
      length: 0,
      replacement: rootGuard(builderRoot),
    },
    {
      index: calls[0].index,
      length: calls[0][0].length,
      replacement: publishRoot + calls[0][0].slice(0, -2) + `,${pluginRoot}` + calls[0][0].slice(-2),
    },
    {
      index: lifecycle.sync.index,
      length: lifecycle.sync[0].length,
      replacement: lifecycle.sync[0].slice(0, -2) + `,${CONTEXT_KEY}:${lifecycle.selection}})`,
    },
    {
      index: lifecycle.resume.index,
      length: lifecycle.resume[0].length,
      replacement: lifecycle.resume[0].slice(0, -1) + `,${lifecycle.resume.groups.selection}.${ROOT_KEY})`,
    },
  ];
  let patchedSource = source;
  const ordered = edits.sort((left, right) => right.index - left.index);
  for (let index = 0; index < ordered.length; index += 1) {
    const edit = ordered[index];
    if (index > 0 && edit.index + edit.length > ordered[index - 1].index) {
      throw drift("overlapping native owner edits");
    }
    patchedSource = patchedSource.slice(0, edit.index) + edit.replacement +
      patchedSource.slice(edit.index + edit.length);
  }
  new Script(`function nativeOwner(){${patchedSource}\n}`);
  return patchedSource;
}

function patchUnifiedComputerUseAssets(extractedDir) {
  const inventory = findMainProcessChunks(extractedDir);
  if (!inventory) throw drift("missing native main-process inventory");
  const chunks = inventory.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8");
    return { assetName, source, factories: mainProcessFactories(source) };
  });
  const owners = chunks.flatMap(chunk => chunk.factories
    .filter(factory => factory.body.includes("cuaReplSurfaces:") && [...factory.body.matchAll(selectorPattern())].length > 0)
    .map(factory => ({ chunk, factory })));
  if (owners.length !== 1) throw drift("missing or ambiguous unified selector owner");
  const [{ chunk, factory }] = owners;
  const cohort = chunks.flatMap(candidate => candidate.factories.filter(copy => copy.identity === factory.identity));
  if (cohort.length !== 1) throw drift("duplicate or damaged unified native owner cohort");
  const patchedSource = applyUnifiedComputerUsePatch(chunk.source);
  return { matched: 1, ...commitAssetEdits(inventory.buildDir, [{ assetName: chunk.assetName,
    source: chunk.source, patchedSource }]) };
}

module.exports = { applyUnifiedComputerUsePatch, patchUnifiedComputerUseAssets };
