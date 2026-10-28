"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const ROOT_KEY = "codexLinuxCuaPluginRoot";
const CONTEXT_KEY = "codexLinuxCuaContext";

function uniqueMatch(source, pattern, description) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Linux unified Computer Use contract drift: ${description}`);
  return matches[0];
}

function requireUsages(source, name, expected) {
  // Include bare references as well as calls so an added alias/export fails
  // closed. Property accesses such as constants.Aa are a different binding.
  const uses = [...source.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g"))];
  if (uses.length !== expected) {
    throw new Error(`Linux unified Computer Use contract drift: unexpected ${name} consumers`);
  }
}

function rootGuard(name) {
  return `if(typeof ${name}!==\`string\`||${name}.length===0)throw Error(\`Linux Computer Use trusted plugin root is unavailable\`);`;
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
  const syncOwnerSource = source.slice(syncOwner.start, syncOwner.end);
  const cached = uniqueMatch(syncOwnerSource, new RegExp(
    `(?:return |,)\\{selection:(?<selection>${ID}),cuaReplEnabled:${escapeRegExp(sync.groups.enabled)}\\}`, "g"),
  "expected synchronized selection to be cached with CUA enabled state");
  uniqueMatch(syncOwnerSource, new RegExp(`(?:let |,)${escapeRegExp(cached.groups.selection)}=`, "g"),
    "expected cached selection to belong to plugin initialization");
  const resume = uniqueMatch(source, new RegExp(
    `(?<![\\w$.])${escapeRegExp(builder)}\\(\\{browserBackends:(?<selection>${ID})\\.browserBackends,` +
    `deferTools:\\k<selection>\\.desktopFeatureAvailability\\.deferCuaTools,surfaces:\\k<selection>\\.cuaReplSurfaces,` +
    `nodeRepl:${ID}\\}(?<root>,\\k<selection>\\.${ROOT_KEY})?\\)`, "g"),
  "expected one thread configuration builder call");
  const resumeOwner = enclosingFunction(source, resume.index);
  uniqueMatch(source.slice(resumeOwner.start, resumeOwner.end), new RegExp(
    `(?<cached>${ID})=${ID}\\.browserUseTinysky\\?${ID}:null,` +
    `${ID}=${ID}\\?await ${ID}\\.getAuthenticatedPrincipal\\(\\)\\.catch\\(\\(\\)=>null\\):null,` +
    `${escapeRegExp(resume.groups.selection)}=\\k<cached>\\?\\.selection\\?\\?await ${ID}\\(`, "g"),
  "expected thread configuration to reuse the cached selection");
  if (sync.groups.context != null && sync.groups.selection !== cached.groups.selection) {
    throw new Error("Linux unified Computer Use contract drift: plugin root receiver is not the cached selection");
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
  const base = "codexLinuxCuaPluginRoot";
  let name = base;
  for (let suffix = 1; identifiers.has(name); suffix += 1) name = `${base}${suffix}`;
  return name;
}

function applyUnifiedComputerUsePatch(source) {
  // Match the current selector, including variable relationships. Both pristine
  // and patched forms must have exactly one owner; drift must abort the build.
  const pattern = /(?<native>[\w$]+)=(?<ready>[\w$]+)&&(?<features>[\w$]+)\.computerUse&&(?<legacy>[\w$]+)\.enabled&&\((?<runtime>[\w$]+)\.platform===`win32`\|\|\k<runtime>\.platform===`darwin`&&\k<legacy>\.paths\.serviceAppPath!=null\)(?<linux>\|\|\k<ready>&&\k<runtime>\.platform===`linux`&&\k<features>\.computerUse&&\k<legacy>\.enabled)?,(?<mode>[\w$]+)=(?<modeLinux>\k<runtime>\.platform===`linux`\?\k<native>:)?(?<modeValue>\k<features>\.computerUse&&\(!\k<features>\.browserUseTinysky\|\|\k<runtime>\.platform!==`darwin`\|\|\k<legacy>\.enabled\))(?=,)/g;
  const matches = [...source.matchAll(pattern)];
  const owners = [...source.matchAll(/[\w$]+=[\w$]+&&[\w$]+\.computerUse&&[\w$]+\.enabled&&\([\w$]+\.platform===`win32`\|\|[\w$]+\.platform===`darwin`&&[\w$]+\.paths\.serviceAppPath/g)];
  if (matches.length !== 1 || owners.length !== 1 || !source.includes("cuaReplSurfaces:")) {
    throw new Error("Linux unified Computer Use contract drift: expected one native surface selector");
  }
  const match = matches[0];
  const { native, ready, runtime, features, legacy, mode, modeValue, linux, modeLinux } = match.groups;
  if (Boolean(linux) !== Boolean(modeLinux)) {
    throw new Error("Linux unified Computer Use contract drift: partial native selector patch");
  }
  // The signed package shares a config builder between plugin synchronization
  // and per-thread configuration. Publish synchronization's verified root in
  // its cached selection, then pass that context through both builder calls.
  const builderPattern = new RegExp(
    `function (?<builder>[\\w$]+)\\(\\{browserBackends:(?<backends>[\\w$]+),deferTools:(?<defer>[\\w$]+),` +
      `surfaces:(?<surfaces>[\\w$]+),nodeRepl:(?<nodeRepl>[\\w$]+),` +
      `accessBootstrapPath:(?<accessBootstrapPath>[\\w$]+)\\}(?<rootParam>,(?<pluginRoot>[\\w$]+))?\\)\\{`,
    "g",
  );
  const builders = [...source.matchAll(builderPattern)];
  if (builders.length !== 1) {
    throw new Error("Linux unified Computer Use contract drift: expected one native config builder");
  }
  const builder = builders[0];
  const builderOwner = enclosingFunction(source, builder.index);
  const builderSource = source.slice(builderOwner.start, builderOwner.end);
  const surfaces = builder.groups.surfaces;
  const currentServicePattern = new RegExp(
    `${surfaces}\\.includes\\(\`computer\`\\)&&\\((?<services>[\\w$]+)\\.sky=\`@oai/sky/service\`\\)`,
    "g",
  );
  const patchedServicePattern = new RegExp(
    `${surfaces}\\.includes\\(\`computer\`\\)&&\\((?<services>[\\w$]+)\\.sky=(?<path>[\\w$]+)\\.default\\.join\\((?<pluginRoot>[\\w$]+),\`scripts\`,\`native-service\\.mjs\`\\)\\)`,
    "g",
  );
  const currentServices = [...builderSource.matchAll(currentServicePattern)];
  const patchedServices = [...builderSource.matchAll(patchedServicePattern)];
  const audioEnvironmentPattern =
    `(?<audio>\\.\\.\\.${builder.groups.nodeRepl}\\?\\.env\\.SKY_AUDIO_ATTACHMENTS===\`1\`\\?\\{` +
    `SKY_ENABLE_AUDIO:${surfaces}\\.includes\\(\`computer\`\\)\\?\`1\`:\`0\`,` +
    `SKY_AUDIO_ATTACHMENTS:${surfaces}\\.includes\\(\`computer\`\\)\\?\`1\`:\`0\`,` +
    "NODE_REPL_ENABLE_AUDIO:`0`\\}:\\{\\},)";
  const currentBannerPattern = new RegExp(
    `CUA_REPL_NODE_REPL_PATH:${builder.groups.nodeRepl}\\?\\.command,` +
      `CUA_REPL_ENABLED_SURFACES:${surfaces}\\.join\\(\`,\`\\),${audioEnvironmentPattern}` +
      `\\[(?<constants>[\\w$]+)\\.(?<constant>[\\w$]+)\\]:JSON\\.stringify\\((?<services>[\\w$]+)\\)`,
    "g",
  );
  const patchedBannerPattern = new RegExp(
    `CUA_REPL_NODE_REPL_PATH:${builder.groups.nodeRepl}\\?\\.command,` +
      `CUA_REPL_ENABLED_SURFACES:${surfaces}\\.join\\(\`,\`\\),CODEX_LINUX_CUA_HOST_SOCKET:process\\.env\\.CODEX_LINUX_CUA_HOST_SOCKET,` +
      `NODE_REPL_JS_BANNER:\`await import\\("@oai/cua/tinyskyAlt"\\);await\\(await import\\(\\$\\{JSON\\.stringify\\((?<path>[\\w$]+)\\.default\\.join\\((?<pluginRoot>[\\w$]+),\`scripts\`,\`native-client\\.mjs\`\\)\\)\\}\\)\\)\\.installLinuxComputerUse\\(cua\\);\`,` +
      audioEnvironmentPattern +
      `\\[(?<constants>[\\w$]+)\\.(?<constant>[\\w$]+)\\]:JSON\\.stringify\\((?<services>[\\w$]+)\\)`,
    "g",
  );
  const currentBanners = [...builderSource.matchAll(currentBannerPattern)];
  const patchedBanners = [...builderSource.matchAll(patchedBannerPattern)];
  const callPattern = new RegExp(
    `Object\\.assign\\([\\w$]+,${builder.groups.builder}\\(\\{\\.\\.\\.(?<argument>[\\w$]+),` +
      `accessBootstrapPath:(?<accessBootstrapPath>[\\w$]+)\\}(?<rootArg>,(?<pluginRoot>[\\w$]+))?\\)\\)`,
    "g",
  );
  const calls = [...source.matchAll(callPattern)];
  const callOwner = calls.length === 1 ? enclosingFunction(source, calls[0].index) : null;
  const callOwnerSource = callOwner == null ? "" : source.slice(callOwner.start, callOwner.end);
  const pluginRoots = [...callOwnerSource.matchAll(/[\w$]+=(?<path>[\w$]+)\.default\.join\((?<pluginRoot>[\w$]+),`\.mcp\.json`\)/g)];
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
  if (!current && !patched) {
    throw new Error("Linux unified Computer Use contract drift: expected one native trusted service selector");
  }
  const service = current ? currentServices[0] : patchedServices[0];
  if (pluginRoots.length !== 1) {
    throw new Error("Linux unified Computer Use contract drift: changed plugin cache relationship");
  }
  const root = pluginRoots[0];
  const argument = lifecycle.argument;
  uniqueMatch(callOwnerSource, new RegExp(
    `${escapeRegExp(root.groups.pluginRoot)}=${ID}\\.${ID}\\(\\{codexHome:${escapeRegExp(argument)}\\.codexHome,` +
    `localVersion:(?<plugin>${ID})\\.plugin\\.localVersion,marketplaceName:\\k<plugin>\\.marketplace\\.name,pluginName:\\k<plugin>\\.plugin\\.name\\}\\)`, "g"),
  "expected plugin root derived from verified installed plugin metadata");
  const publishRoot = `${argument}.${CONTEXT_KEY}.${ROOT_KEY}=${root.groups.pluginRoot};`;
  const banner = current ? currentBanners[0] : patchedBanners[0];
  if (banner.groups.services !== service.groups.services) {
    throw new Error("Linux unified Computer Use contract drift: changed native banner relationship");
  }
  if (patched && (service.groups.path !== root.groups.path || service.groups.pluginRoot !== builder.groups.pluginRoot ||
      banner.groups.path !== root.groups.path || banner.groups.pluginRoot !== builder.groups.pluginRoot ||
      calls[0].groups.pluginRoot !== root.groups.pluginRoot)) {
    throw new Error("Linux unified Computer Use contract drift: changed native service path relationship");
  }
  const completePropagation = callOwnerSource.split(publishRoot).length === 2 &&
    callOwnerSource.includes(publishRoot + calls[0][0]) &&
    builderSource.startsWith(builder[0] + rootGuard(builder.groups.pluginRoot));
  if ((current && callOwnerSource.includes(publishRoot)) || (patched && !completePropagation)) {
    throw new Error("Linux unified Computer Use contract drift: incomplete trusted root propagation");
  }
  if (patched) return source;
  const pluginRoot = root.groups.pluginRoot;
  // Caller and helper have independent minified scopes. A caller alias can be
  // an existing destructured parameter or local in the helper. Use a fresh
  // helper binding, including nested scopes that capture the injected value.
  const builderRoot = freshBuilderRoot(builderSource);
  const pathAlias = root.groups.path;
  const { backends, defer, nodeRepl, accessBootstrapPath } = builder.groups;
  if ([backends, defer, surfaces, nodeRepl, accessBootstrapPath].includes(pathAlias)) {
    throw new Error("Linux unified Computer Use contract drift: native config builder shadows the path module");
  }
  const edits = [
    {
      index: match.index,
      length: match[0].length,
      replacement:
        `${native}=${ready}&&${features}.computerUse&&${legacy}.enabled&&(${runtime}.platform===\`win32\`||${runtime}.platform===\`darwin\`&&${legacy}.paths.serviceAppPath!=null)` +
        `||${ready}&&${runtime}.platform===\`linux\`&&${features}.computerUse&&${legacy}.enabled,` +
        `${mode}=${runtime}.platform===\`linux\`?${native}:${modeValue}`,
    },
    {
      index: builderOwner.start + service.index,
      length: service[0].length,
      replacement: `${surfaces}.includes(\`computer\`)&&(${service.groups.services}.sky=${pathAlias}.default.join(${builderRoot},\`scripts\`,\`native-service.mjs\`))`,
    },
    {
      index: builderOwner.start + banner.index,
      length: banner[0].length,
      replacement:
        `CUA_REPL_NODE_REPL_PATH:${nodeRepl}?.command,` +
        `CUA_REPL_ENABLED_SURFACES:${surfaces}.join(\`,\`),` +
        `CODEX_LINUX_CUA_HOST_SOCKET:process.env.CODEX_LINUX_CUA_HOST_SOCKET,` +
        `NODE_REPL_JS_BANNER:\`await import("@oai/cua/tinyskyAlt");await(await import(\${JSON.stringify(${pathAlias}.default.join(${builderRoot},\`scripts\`,\`native-client.mjs\`))})).installLinuxComputerUse(cua);\`,` +
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
