"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const ROOT_KEY = "codexLinuxCuaPluginRoot";
const CONTEXT_KEY = "codexLinuxCuaContext";
const ROOT_PLACEHOLDER = "\u0000ROOT\u0000";
// rspack chunk modules: `exports.modules={123(e,t,r){...},456(e){...}}`.
const MODULE_HEADER = /(?:modules=\{|\},)\d+\([\w$]+(?:,[\w$]+){0,2}\)\{/g;

function drift(description) {
  return new Error(`Linux unified Computer Use contract drift: ${description}`);
}

function uniqueMatch(source, pattern, description) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw drift(description);
  return matches[0];
}

function requireUsages(source, name, expected) {
  // Include bare references as well as calls so an added alias/export fails
  // closed. Property accesses such as constants.Aa and private class members
  // such as #Aa are different bindings.
  const uses = [...source.matchAll(new RegExp(`(?<![\\w$.#])${escapeRegExp(name)}(?![\\w$])`, "g"))];
  if (uses.length !== expected) throw drift(`unexpected ${name} consumers`);
}

// Minified names are module scoped. Restrict every relationship check to the
// rspack module that owns the selector; plain fixtures are one module.
function moduleBounds(source, index) {
  let start = 0;
  let end = source.length;
  for (const header of source.matchAll(MODULE_HEADER)) {
    if (header.index < index) {
      start = header.index;
    } else {
      end = header.index;
      break;
    }
  }
  return { start, end };
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

function lifecycleContract(source, builder, syncSource) {
  const owner = uniqueMatch(syncSource, new RegExp(`^(?:async )?function (?<name>${ID})\\((?<argument>${ID})\\)\\{`, "g"),
    "expected one plugin synchronization owner");
  requireUsages(source, builder, 3); // declaration, plugin synchronization, thread configuration
  requireUsages(source, owner.groups.name, 2); // declaration and cached selection initialization
  const sync = uniqueMatch(source, new RegExp(
    `(?<enabled>${ID})=await ${escapeRegExp(owner.groups.name)}\\(\\{browserBackends:${ID},deferTools:${ID}\\.deferCuaTools,` +
    `surfaces:${ID},codexHome:${ID},marketplaceName:${ID},marketplaces:${ID},nodeRepl:${ID}\\?void 0:${ID}` +
    `(?<context>,${CONTEXT_KEY}:(?<selection>${ID}))?\\}\\)`, "g"), "expected one cached plugin synchronization call");
  const syncOwner = enclosingFunction(source, sync.index);
  if (syncOwner == null) throw drift("expected a plugin synchronization owner");
  const syncOwnerSource = source.slice(syncOwner.start, syncOwner.end);
  const cached = uniqueMatch(syncOwnerSource, new RegExp(
    `(?:return |,)\\{selection:(?<selection>${ID}),cuaReplEnabled:${escapeRegExp(sync.groups.enabled)}\\}`, "g"),
  "expected synchronized selection to be cached with CUA enabled state");
  uniqueMatch(syncOwnerSource, new RegExp(`(?:let |,)${escapeRegExp(cached.groups.selection)}=`, "g"),
    "expected cached selection to belong to plugin initialization");
  const resume = uniqueMatch(source, new RegExp(
    `(?<![\\w$.#])${escapeRegExp(builder)}\\(\\{browserBackends:(?<selection>${ID})\\.browserBackends,` +
    `deferTools:\\k<selection>\\.desktopFeatureAvailability\\.deferCuaTools,surfaces:\\k<selection>\\.cuaReplSurfaces,` +
    `nodeRepl:${ID}\\}(?<root>,\\k<selection>\\.${ROOT_KEY})?\\)`, "g"),
  "expected one thread configuration builder call");
  const resumeOwner = enclosingFunction(source, resume.index);
  if (resumeOwner == null) throw drift("expected a thread configuration owner");
  const resumeSource = source.slice(resumeOwner.start, resumeOwner.end);
  const selection = escapeRegExp(resume.groups.selection);
  uniqueMatch(resumeSource, new RegExp(
    `(?<cached>${ID})=${ID}\\.browserUseTinysky\\?${ID}:null,` +
    `${ID}=${ID}\\?await ${ID}\\.getAuthenticatedPrincipal\\(\\)\\.catch\\(\\(\\)=>null\\):null,` +
    `${selection}=\\k<cached>\\?\\.selection\\?\\?await ${ID}\\(`, "g"),
  "expected thread configuration to reuse the cached selection");
  // The per-thread selection may only be widened by copying the cached
  // selection, which keeps the published trusted root.
  const reassignments = [...resumeSource.matchAll(new RegExp(`(?<![\\w$.#])${selection}=(?!=)`, "g"))];
  const copies = [...resumeSource.matchAll(new RegExp(`(?<![\\w$.#])${selection}=\\{\\.\\.\\.${selection},`, "g"))];
  if (reassignments.length !== 1 + copies.length) {
    throw drift("thread configuration replaces the cached selection");
  }
  if (sync.groups.context != null && sync.groups.selection !== cached.groups.selection) {
    throw drift("plugin root receiver is not the cached selection");
  }
  return { argument: owner.groups.argument, sync, resume, selection: cached.groups.selection };
}

function enclosingFunction(source, targetIndex) {
  const functions = /(?:async )?function [A-Za-z_$][\w$]*\([^)]*\)\{/gu;
  let owner = null;
  for (const candidate of source.matchAll(functions)) {
    if (candidate.index > targetIndex) break;
    const open = candidate.index + candidate[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close >= targetIndex) owner = { start: candidate.index, end: close + 1 };
  }
  return owner;
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
  if (builderOwner == null || builderOwner.start !== builder.index) throw drift("expected one native config builder");
  const builderSource = source.slice(builderOwner.start, builderOwner.end);
  const { surfaces, nodeRepl } = builder.groups;
  const currentServices = [...builderSource.matchAll(new RegExp(
    `${surfaces}\\.includes\\("computer"\\)&&\\((?<services>[\\w$]+)\\.sky="@oai/sky/service"\\)`, "g"))];
  const patchedServices = [...builderSource.matchAll(new RegExp(
    `${surfaces}\\.includes\\("computer"\\)&&\\((?<services>[\\w$]+)\\.sky=` +
      `${rootPattern(pluginFile(ROOT_PLACEHOLDER, "native-service.mjs"))}\\)`, "g"))];
  const audioEnvironmentPattern =
    `(?<audio>\\.\\.\\.${nodeRepl}\\?\\.env\\.SKY_AUDIO_ATTACHMENTS==="1"\\?\\{` +
    `SKY_ENABLE_AUDIO:${surfaces}\\.includes\\("computer"\\)\\?"1":"0",` +
    `SKY_AUDIO_ATTACHMENTS:${surfaces}\\.includes\\("computer"\\)\\?"1":"0",` +
    'NODE_REPL_ENABLE_AUDIO:"0"\\}:\\{\\},)';
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
  const lifecycle = lifecycleContract(source, builder.groups.builder, callOwnerSource);
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
  for (const edit of edits.sort((left, right) => right.index - left.index)) {
    patchedSource = patchedSource.slice(0, edit.index) + edit.replacement +
      patchedSource.slice(edit.index + edit.length);
  }
  return patchedSource;
}

module.exports = { applyUnifiedComputerUsePatch };
