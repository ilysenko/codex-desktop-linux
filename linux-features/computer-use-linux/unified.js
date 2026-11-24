"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const ROOT_KEY = "codexLinuxCuaPluginRoot";
const CONTEXT_KEY = "codexLinuxCuaContext";
const MARKERS = [
  "codexLinuxUnifiedCuaBuilder",
  "codexLinuxUnifiedCuaRoot",
  "codexLinuxUnifiedCuaThread",
  "codexLinuxUnifiedCuaStartup",
];
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

function callableScopes(source) {
  const scopes = [];
  const header = new RegExp(`(?:async )?function(?: ${ID})?\\([^)]*\\)\\{`, "gu");
  for (const match of source.matchAll(header)) {
    const open = match.index + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) throw drift("unterminated function owner");
    scopes.push({ start: match.index, open, end: close + 1, header: match[0] });
  }
  return scopes;
}

function innermostScope(scopes, index) {
  return scopes.filter(scope => scope.start < index && scope.end > index)
    .sort((a, b) => b.start - a.start)[0] ?? null;
}

function braceScopes(source) {
  const byEnd = new Map();
  for (const match of source.matchAll(/\{/gu)) {
    const end = findMatchingBrace(source, match.index);
    if (end < 0) continue;
    const existing = byEnd.get(end);
    if (existing == null || match.index < existing.start) {
      byEnd.set(end, { start: match.index, end: end + 1 });
    }
  }
  return [...byEnd.values()];
}

function lexicalOwner(scopes, index) {
  return innermostScope(scopes, index);
}

function accessibleBindingAt(source, callable, lexical, name, index) {
  const escaped = escapeRegExp(name);
  const containsUse = scope => scope == null || (scope.start < index && scope.end > index);
  const candidates = [];
  const add = (kind, declaration, scope) => {
    if (containsUse(scope)) candidates.push({
      key: `${kind}:${declaration}`,
      scopeStart: scope?.start ?? -1,
    });
  };

  for (const match of source.matchAll(new RegExp(`(?:async )?function ${escaped}\\(`, "gu"))) {
    add("function", match.index, lexicalOwner(lexical, match.index));
  }
  for (const scope of callable) {
    if (!containsUse(scope)) continue;
    const parameters = scope.header.slice(scope.header.indexOf("(") + 1, scope.header.lastIndexOf(")"));
    if (new RegExp(`(?:^|[,({])\\s*${escaped}\\s*(?=[,)=}]|=)`, "u").test(parameters) ||
        new RegExp(`:\\s*${escaped}\\s*(?=[,}])`, "u").test(parameters)) {
      add("parameter", scope.start, scope);
    }
  }
  for (const match of source.matchAll(/\b(?:let|const)\s+([^;]{1,2000});/gu)) {
    if (match.index >= index || !containsUse(lexicalOwner(lexical, match.index))) continue;
    const declaration = match[1];
    if (new RegExp(`(?:^|,)\\s*${escaped}\\s*(?==|,|$)`, "u").test(declaration) ||
        new RegExp(`:\\s*${escaped}\\s*(?=[,}])`, "u").test(declaration)) {
      add("lexical", match.index, lexicalOwner(lexical, match.index));
    }
  }
  for (const match of source.matchAll(/\bvar\s+([^;]{1,2000});/gu)) {
    if (match.index >= index || !containsUse(innermostScope(callable, match.index))) continue;
    const declaration = match[1];
    if (new RegExp(`(?:^|,)\\s*${escaped}\\s*(?==|,|$)`, "u").test(declaration) ||
        new RegExp(`:\\s*${escaped}\\s*(?=[,}])`, "u").test(declaration)) {
      add("var", match.index, innermostScope(callable, match.index));
    }
  }
  return candidates.sort((a, b) => b.scopeStart - a.scopeStart)[0] ?? null;
}

function requireAccessibleBindings(source, index, bindings, semanticUses = {}) {
  const callable = callableScopes(source);
  const lexical = braceScopes(source);
  for (const [description, name] of Object.entries(bindings)) {
    const binding = accessibleBindingAt(source, callable, lexical, name, index);
    if (binding == null) {
      throw drift(`${description} binding ${name} is not accessible from startup owner`);
    }
    if (semanticUses[description] != null) {
      const semanticBinding = accessibleBindingAt(source, callable, lexical, name, semanticUses[description]);
      if (semanticBinding == null || semanticBinding.key !== binding.key) {
        throw drift(`${description} binding ${name} does not resolve to the semantic declaration`);
      }
    }
  }
}

function startupPattern() {
  return new RegExp(
    `/\\*${MARKERS[3]}\\*/\\("linux"===(?<selection>${ID})\\.runtimePaths\\.platform&&\\k<selection>\\.computerUse&&\\(\\(\\)=>\\{` +
    `let codexLinuxCuaPlugin=(?<lookup>${ID})\\(\\{marketplaceName:(?<marketplaceName>${ID}),` +
    `marketplaces:(?<marketplaces>${ID}),pluginName:(?<pluginModule>${ID})\\.(?<pluginName>${ID})\\}\\);` +
    `if\\(!codexLinuxCuaPlugin\\?\\.plugin\\.installed\\)throw Error\\(\\x60Linux Computer Use trusted plugin root is unavailable\\x60\\);` +
    `\\k<selection>\\.${ROOT_KEY}=\\(0,(?<rootModule>${ID})\\.(?<rootHelper>${ID})\\)\\(\\{` +
    `codexHome:(?<codexHome>${ID}),localVersion:codexLinuxCuaPlugin\\.plugin\\.localVersion,` +
    `marketplaceName:codexLinuxCuaPlugin\\.marketplace\\.name,pluginName:codexLinuxCuaPlugin\\.plugin\\.name\\}\\)` +
    `\\}\\)\\(\\),(?<thread>${ID})\\(\\{appServerConnection:${ID},appVersion:${ID},selection:\\k<selection>,` +
    `hostServicesPipePath:null,includePrivateProcessEnv:!1\\}\\)\\)`, "gu");
}

function validateStartupContract(source) {
  const startup = unique(source, startupPattern(), "startup verified-root publication");
  const semanticLookup = unique(source, new RegExp(
    `let (?<plugin>${ID})=${escapeRegExp(startup.groups.lookup)}\\(\\{` +
    `marketplaceName:(?<argument>${ID})\\.marketplaceName,marketplaces:\\k<argument>\\.marketplaces,` +
    `pluginName:${ID}\\.${ID}\\}\\);if\\(!\\k<plugin>\\?\\.plugin\\.installed\\)return!1;`, "gu"),
  "semantic plugin lookup");
  requireAccessibleBindings(source, startup.index, {
    selection: startup.groups.selection,
    "plugin lookup": startup.groups.lookup,
    "plugin constants": startup.groups.pluginModule,
    "plugin root helper": startup.groups.rootModule,
    "codex home": startup.groups.codexHome,
    "marketplace name": startup.groups.marketplaceName,
    marketplaces: startup.groups.marketplaces,
  }, { "plugin lookup": semanticLookup.index });
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
    validateStartupContract(source);
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
    `let (?<plugin>${ID})=(?<lookup>${ID})\\(\\{marketplaceName:(?<argument>${ID})\\.marketplaceName,` +
    `marketplaces:\\k<argument>\\.marketplaces,pluginName:(?<pluginModule>${ID})\\.(?<pluginName>${ID})\\}\\);` +
    `if\\(!\\k<plugin>\\?\\.plugin\\.installed\\)return!1;` +
    `let (?<root>${ID})=\\(0,(?<rootModule>${ID})\\.(?<rootHelper>${ID})\\)\\(\\{codexHome:\\k<argument>\\.codexHome,` +
    `localVersion:\\k<plugin>\\.plugin\\.localVersion,marketplaceName:\\k<plugin>\\.marketplace\\.name,` +
    `pluginName:\\k<plugin>\\.plugin\\.name\\}\\);return await (?<sync>${ID})\\(\\k<root>,\\k<argument>\\)`, "gu"),
  "verified plugin root");
  const invocation = unique(source, new RegExp(
    `\\}\\(\\{\\.\\.\\.(?<config>${ID}),codexHome:(?<codexHome>${ID}),marketplaceName:(?<marketplaceName>${ID}),` +
    `marketplaces:(?<marketplaces>${ID})\\}\\)`, "gu"),
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
  const initialThread = unique(source, new RegExp(
    `${escapeRegExp(aqHeader.groups.aq)}\\(\\{appServerConnection:${ID},appVersion:${ID},` +
    `selection:${escapeRegExp(selection)},hostServicesPipePath:null,includePrivateProcessEnv:!1\\}\\)`, "gu"),
  "initial thread config");
  requireAccessibleBindings(source, initialThread.index, {
    selection,
    "plugin lookup": root.groups.lookup,
    "plugin constants": root.groups.pluginModule,
    "plugin root helper": root.groups.rootModule,
    "codex home": invocation.groups.codexHome,
    "marketplace name": invocation.groups.marketplaceName,
    marketplaces: invocation.groups.marketplaces,
  }, { "plugin lookup": root.index });

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
  const initialRoot = `/*${MARKERS[3]}*/("linux"===${selection}.runtimePaths.platform&&${selection}.computerUse&&(()=>{` +
    `let codexLinuxCuaPlugin=${root.groups.lookup}({marketplaceName:${invocation.groups.marketplaceName},` +
    `marketplaces:${invocation.groups.marketplaces},pluginName:${root.groups.pluginModule}.${root.groups.pluginName}});` +
    `if(!codexLinuxCuaPlugin?.plugin.installed)throw Error(\`Linux Computer Use trusted plugin root is unavailable\`);` +
    `${selection}.${ROOT_KEY}=(0,${root.groups.rootModule}.${root.groups.rootHelper})({` +
    `codexHome:${invocation.groups.codexHome},localVersion:codexLinuxCuaPlugin.plugin.localVersion,` +
    `marketplaceName:codexLinuxCuaPlugin.marketplace.name,pluginName:codexLinuxCuaPlugin.plugin.name})})(),` +
    `${initialThread[0]})`;
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
    { index: initialThread.index, length: initialThread[0].length, replacement: initialRoot },
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
