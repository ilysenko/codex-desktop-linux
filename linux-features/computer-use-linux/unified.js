"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const ROOT_KEY = "codexLinuxCuaPluginRoot";
const CONTEXT_KEY = "codexLinuxCuaContext";
const MARKERS = ["codexLinuxUnifiedCuaBuilder", "codexLinuxUnifiedCuaRoot", "codexLinuxUnifiedCuaThread"];
const MODULE_HEADER = /(?:modules=\{|\},)\d+\([\w$]+(?:,[\w$]+){0,2}\)\{/g;

function drift(description) {
  return new Error(`Linux unified Computer Use contract drift: ${description}`);
}

function unique(source, pattern, description) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw drift(`${description} matched ${matches.length} times`);
  return matches[0];
}

function enclosingFunction(source, index) {
  let owner = null;
  for (const match of source.matchAll(new RegExp(`(?:async )?function ${ID}\\([^)]*\\)\\{`, "gu"))) {
    if (match.index > index) break;
    const open = match.index + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close >= index) owner = { start: match.index, end: close + 1 };
  }
  return owner;
}

function moduleBounds(source, index) {
  let start = 0, end = source.length;
  for (const header of source.matchAll(MODULE_HEADER)) {
    if (header.index < index) start = header.index;
    else { end = header.index; break; }
  }
  return { start, end };
}

function selectorPattern() {
  return /(?<native>[\w$]+)=(?<ready>[\w$]+)&&(?<features>[\w$]+)\.computerUse&&(?<legacy>[\w$]+)\.enabled&&\("win32"===(?<runtime>[\w$]+)\.platform\|\|"darwin"===\k<runtime>\.platform&&null!=\k<legacy>\.paths\.serviceAppPath\)(?<linux>\|\|\k<ready>&&"linux"===\k<runtime>\.platform&&\k<features>\.computerUse&&\k<legacy>\.enabled)?,(?<mode>[\w$]+)=(?<modeLinux>"linux"===\k<runtime>\.platform\?\k<native>:)?(?<modeValue>\k<features>\.computerUse&&\(!\k<features>\.browserUseTinysky\|\|"darwin"!==\k<runtime>\.platform\|\|\k<legacy>\.enabled\))(?=,)/gu;
}

function guard(root) {
  return `if(typeof ${root}!==\`string\`||${root}.length===0)throw Error(\`Linux Computer Use trusted plugin root is unavailable\`);`;
}

function pluginFile(root, name) {
  return `require("node:path").join(${root},"scripts","${name}")`;
}

function banner(root) {
  return `'await import("@oai/cua/tinyskyAlt");await(await import('+JSON.stringify(${pluginFile(root, "native-client.mjs")})+')).installLinuxComputerUse(cua);'`;
}

function applyUnifiedComputerUsePatch(chunk) {
  if (!chunk.includes("cuaReplSurfaces")) {
    console.warn("WARN: Could not find the unified Computer Use surface selector - skipping Linux unified Computer Use patch");
    return chunk;
  }
  const selectors = [...chunk.matchAll(selectorPattern())];
  if (selectors.length !== 1) throw drift(`native surface selector matched ${selectors.length} times`);
  const bounds = moduleBounds(chunk, selectors[0].index);
  const source = chunk.slice(bounds.start, bounds.end);
  const patched = applyModule(source);
  return patched === source ? chunk : chunk.slice(0, bounds.start) + patched + chunk.slice(bounds.end);
}

function applyModule(source) {
  const selector = unique(source, selectorPattern(), "native surface selector");
  const markerCounts = MARKERS.map(marker => source.split(marker).length - 1);
  const g = selector.groups;
  if (Boolean(g.linux) !== Boolean(g.modeLinux)) throw drift("partial native selector patch");
  if (markerCounts.every(count => count === 1)) {
    if (!g.linux) throw drift("markers exist without Linux selector");
    return source;
  }
  if (g.linux || markerCounts.some(count => count !== 0)) throw drift("partial unified Computer Use patch");

  const builder = unique(source, new RegExp(
    `function (?<builder>${ID})\\(\\{browserBackends:(?<backends>${ID}),deferTools:(?<defer>${ID}),` +
    `confirmationPolicyConfig:(?<confirmation>${ID})="\\{\\}",omitCuaConfirmationPolicyBySku:(?<omit>${ID}),` +
    `surfaces:(?<surfaces>${ID}),nodeRepl:(?<nodeRepl>${ID}),sharedPlugin:(?<shared>${ID})=!1\\}\\)\\{`, "gu"),
  "native config builder");
  const builderOwner = enclosingFunction(source, builder.index);
  if (builderOwner == null || builderOwner.start !== builder.index) throw drift("native config builder owner");
  const builderSource = source.slice(builderOwner.start, builderOwner.end);
  const surfaces = builder.groups.surfaces;
  const service = unique(builderSource, new RegExp(
    `${escapeRegExp(surfaces)}\\.includes\\("computer"\\)&&\\((?<services>${ID})\\.sky="@oai/sky/service"\\)`, "gu"),
  "native service selector");
  const environment = unique(builderSource, new RegExp(
    `CUA_REPL_ENABLED_SURFACES:${escapeRegExp(surfaces)}\\.join\\(","\\),`, "gu"),
  "builder environment");
  if (builderSource.split("NODE_REPL_TRUSTED_SERVICES:").length - 1 !== 1 ||
      builderSource.split("NODE_REPL_JS_BANNER:").length - 1 !== 1) {
    throw drift("packaged environment fallback changed");
  }

  const cache = unique(source, new RegExp(
    `return await (?<connection>${ID})\\.sendAppServerRequest\\("config/batchWrite",[\\s\\S]{0,500}?` +
    `\\{selection:(?<selection>${ID}),cuaReplEnabled:${ID},executorLaunch:${ID},confirmationPolicyConfig:${ID}\\}`, "gu"),
  "synchronized selection cache");
  const selection = cache.groups.selection;
  const root = unique(source, new RegExp(
    `let (?<root>${ID})=\\(0,${ID}\\.${ID}\\)\\(\\{codexHome:(?<argument>${ID})\\.codexHome,` +
    `localVersion:(?<plugin>${ID})\\.plugin\\.localVersion,marketplaceName:\\k<plugin>\\.marketplace\\.name,` +
    `pluginName:\\k<plugin>\\.plugin\\.name\\}\\);return await (?<sync>${ID})\\(\\k<root>,\\k<argument>\\)`, "gu"),
  "verified plugin root");
  const invocation = unique(source, new RegExp(
    `\\}\\(\\{\\.\\.\\.(?<config>${ID}),codexHome:${ID},marketplaceName:${ID},marketplaces:${ID}\\}\\)`, "gu"),
  "plugin synchronization invocation");
  const daemon = unique(source, new RegExp(
    `${escapeRegExp(builder.groups.builder)}\\(\\{browserBackends:(?<daemonSelection>${ID})\\.browserBackends,` +
    `deferTools:\\k<daemonSelection>\\.desktopFeatureAvailability\\.deferCuaTools,confirmationPolicyConfig:${ID}\\.confirmationPolicyConfig,` +
    `omitCuaConfirmationPolicyBySku:\\k<daemonSelection>\\.desktopFeatureAvailability\\.omitCuaConfirmationPolicyBySku,` +
    `surfaces:\\k<daemonSelection>\\.cuaReplSurfaces,nodeRepl:${ID}\\}\\)`, "gu"),
  "thread daemon config");
  const aqHeader = unique(source, new RegExp(
    `function (?<aq>${ID})\\(\\{appServerConnection:${ID},appVersion:${ID},selection:(?<selection>${ID}),[\\s\\S]{0,220}?\\}\\)\\{`, "gu"),
  "thread config owner");
  const aqClose = findMatchingBrace(source, aqHeader.index + aqHeader[0].length - 1);
  const aqOwner = aqClose < 0 ? null : { start: aqHeader.index, end: aqClose + 1 };
  if (aqOwner == null) throw drift("thread config function owner");
  const aqSource = source.slice(aqOwner.start, aqOwner.end);
  const aqBindings = unique(aqSource, new RegExp(
    `let\\{codexHome:${ID},marketplaceName:${ID},browserServicePluginVersion:${ID},desktopFeatureAvailability:${ID},` +
    `runtimePaths:(?<runtime>${ID}),shouldUseWslPaths:${ID},browserBackends:${ID},computerUse:(?<computer>${ID}),` +
    `computerUsePaths:${ID}\\}=${escapeRegExp(aqHeader.groups.selection)};`, "gu"),
  "thread selection bindings");
  const configReady = unique(aqSource, new RegExp(`if\\(null==(?<config>${ID})\\)return null;`, "gu"),
    "thread node-repl config");
  const trustedKey = unique(aqSource, new RegExp(
    `\\[(?<constants>${ID})\\.(?<constant>${ID})\\]:null!=${ID}\\|\\|${ID}\\?JSON\\.stringify\\(` +
    `\\{[\\s\\S]{0,500}?sky:"@oai/sky/service"`, "gu"), "thread trusted-services key");

  const builderHeader = builder[0].slice(0, -3) + `,${ROOT_KEY}}){/*${MARKERS[0]}*/` +
    `if("linux"===process.platform&&${surfaces}.includes("computer")){${guard(ROOT_KEY)}}`;
  const builderService = `${surfaces}.includes("computer")&&(${service.groups.services}.sky=` +
    `"linux"===process.platform?${pluginFile(ROOT_KEY, "native-service.mjs")}:"@oai/sky/service")`;
  const builderEnvironment = `CUA_REPL_ENABLED_SURFACES:${surfaces}.join(","),` +
    `...("linux"===process.platform&&${surfaces}.includes("computer")?{` +
    `CODEX_LINUX_CUA_HOST_SOCKET:process.env.CODEX_LINUX_CUA_HOST_SOCKET,NODE_REPL_JS_BANNER:${banner(ROOT_KEY)}}:{}),`;
  const rootPublish = root[0].replace(
    `;return await ${root.groups.sync}(${root.groups.root},${root.groups.argument})`,
    `;/*${MARKERS[1]}*/${root.groups.argument}.${ROOT_KEY}=${root.groups.root};` +
      `${root.groups.argument}.${CONTEXT_KEY}.${ROOT_KEY}=${root.groups.root};` +
      `return await ${root.groups.sync}(${root.groups.root},${root.groups.argument})`,
  );
  const invocationWithContext = invocation[0].slice(0, -2) + `,${CONTEXT_KEY}:${selection}})`;
  const daemonWithRoot = daemon[0].slice(0, -2) +
    `,${ROOT_KEY}:${daemon.groups.daemonSelection}.${ROOT_KEY}})`;
  const aqRoot = `${aqHeader.groups.selection}.${ROOT_KEY}`;
  const aqInjection = `/*${MARKERS[2]}*/if("linux"===${aqBindings.groups.runtime}.platform&&${aqBindings.groups.computer}){` +
    `let ${ROOT_KEY}=${aqRoot};${guard(ROOT_KEY)}` +
    `let codexLinuxCuaEnv=${configReady.groups.config}["mcp_servers.node_repl"].env,` +
    `codexLinuxCuaServices=JSON.parse(codexLinuxCuaEnv[${trustedKey.groups.constants}.${trustedKey.groups.constant}]??"{}");` +
    `codexLinuxCuaServices.sky=${pluginFile(ROOT_KEY, "native-service.mjs")};` +
    `codexLinuxCuaEnv[${trustedKey.groups.constants}.${trustedKey.groups.constant}]=JSON.stringify(codexLinuxCuaServices);` +
    `codexLinuxCuaEnv.CODEX_LINUX_CUA_HOST_SOCKET=process.env.CODEX_LINUX_CUA_HOST_SOCKET;` +
    `codexLinuxCuaEnv.NODE_REPL_JS_BANNER=${banner(ROOT_KEY)};}`;

  const edits = [
    { index: selector.index, length: selector[0].length, replacement:
      `${g.native}=${g.ready}&&${g.features}.computerUse&&${g.legacy}.enabled&&("win32"===${g.runtime}.platform||"darwin"===${g.runtime}.platform&&null!=${g.legacy}.paths.serviceAppPath)` +
      `||${g.ready}&&"linux"===${g.runtime}.platform&&${g.features}.computerUse&&${g.legacy}.enabled,` +
      `${g.mode}="linux"===${g.runtime}.platform?${g.native}:${g.modeValue}` },
    { index: builder.index, length: builder[0].length, replacement: builderHeader },
    { index: builderOwner.start + service.index, length: service[0].length, replacement: builderService },
    { index: builderOwner.start + environment.index, length: environment[0].length, replacement: builderEnvironment },
    { index: root.index, length: root[0].length, replacement: rootPublish },
    { index: invocation.index, length: invocation[0].length, replacement: invocationWithContext },
    { index: daemon.index, length: daemon[0].length, replacement: daemonWithRoot },
    { index: aqOwner.start + configReady.index + configReady[0].length, length: 0, replacement: aqInjection },
  ];
  let result = source;
  for (const edit of edits.sort((a, b) => b.index - a.index)) {
    result = result.slice(0, edit.index) + edit.replacement + result.slice(edit.index + edit.length);
  }
  return result;
}

module.exports = { applyUnifiedComputerUsePatch };
