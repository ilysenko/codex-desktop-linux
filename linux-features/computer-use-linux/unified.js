"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

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

function applyUnifiedComputerUsePatch(source) {
  // Match the current selector, including variable relationships. Both pristine
  // and patched forms must have exactly one owner; drift must abort the build.
  const pattern = /(?<native>[\w$]+)=(?<ready>[\w$]+)&&(?<runtime>[\w$]+)\.platform===`darwin`&&(?<features>[\w$]+)\.computerUse&&(?<legacy>[\w$]+)\.enabled&&\k<legacy>\.paths\.serviceAppPath!=null(?<linux>\|\|\k<ready>&&\k<runtime>\.platform===`linux`&&\k<features>\.computerUse&&\k<legacy>\.enabled)?,(?<mode>[\w$]+)=(?<modeLinux>\k<runtime>\.platform===`linux`\?\k<native>:)?(?<modeValue>\k<features>\.computerUse&&\(!\k<features>\.browserUseTinysky\|\|\k<runtime>\.platform!==`darwin`\|\|\k<legacy>\.enabled\))(?=,)/g;
  const matches = [...source.matchAll(pattern)];
  const owners = [...source.matchAll(/[\w$]+=[\w$]+&&[\w$]+\.platform===`darwin`&&[\w$]+\.computerUse&&[\w$]+\.enabled&&[\w$]+\.paths\.serviceAppPath/g)];
  if (matches.length !== 1 || owners.length !== 1 || !source.includes("cuaReplSurfaces:")) {
    throw new Error("Linux unified Computer Use contract drift: expected one native surface selector");
  }
  const match = matches[0];
  const { native, ready, runtime, features, legacy, mode, modeValue, linux, modeLinux } = match.groups;
  if (Boolean(linux) !== Boolean(modeLinux)) {
    throw new Error("Linux unified Computer Use contract drift: partial native selector patch");
  }
  // The signed package builds the CUA config in a helper, while the verified
  // plugin root belongs to its caller. Bind those two functions through the
  // unique Object.assign call instead of relying on either minified name.
  const builderPattern = new RegExp(
    `function (?<builder>[\\w$]+)\\(\\{browserBackends:(?<backends>[\\w$]+),deferTools:(?<defer>[\\w$]+),` +
      `surfaces:(?<surfaces>[\\w$]+),nodeRepl:(?<nodeRepl>[\\w$]+)\\}(?<rootParam>,(?<pluginRoot>[\\w$]+))?\\)\\{`,
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
  const currentBannerPattern = new RegExp(
    `CUA_REPL_ENABLED_SURFACES:${surfaces}\\.join\\(\`,\`\\),\\[(?<constants>[\\w$]+)\\.(?<constant>[\\w$]+)\\]:JSON\\.stringify\\((?<services>[\\w$]+)\\)`,
    "g",
  );
  const patchedBannerPattern = new RegExp(
    `CUA_REPL_ENABLED_SURFACES:${surfaces}\\.join\\(\`,\`\\),CODEX_LINUX_CUA_HOST_SOCKET:process\\.env\\.CODEX_LINUX_CUA_HOST_SOCKET,` +
      `NODE_REPL_JS_BANNER:\`await import\\("@oai/cua/tinyskyAlt"\\);await\\(await import\\(\\$\\{JSON\\.stringify\\((?<path>[\\w$]+)\\.default\\.join\\((?<pluginRoot>[\\w$]+),\`scripts\`,\`native-client\\.mjs\`\\)\\)\\}\\)\\)\\.installLinuxComputerUse\\(cua\\);\`,` +
      `\\[(?<constants>[\\w$]+)\\.(?<constant>[\\w$]+)\\]:JSON\\.stringify\\((?<services>[\\w$]+)\\)`,
    "g",
  );
  const currentBanners = [...builderSource.matchAll(currentBannerPattern)];
  const patchedBanners = [...builderSource.matchAll(patchedBannerPattern)];
  const callPattern = new RegExp(
    `Object\\.assign\\([\\w$]+,${builder.groups.builder}\\((?<argument>[\\w$]+)(?<rootArg>,(?<pluginRoot>[\\w$]+))?\\)\\)`,
    "g",
  );
  const calls = [...source.matchAll(callPattern)];
  const callOwner = calls.length === 1 ? enclosingFunction(source, calls[0].index) : null;
  const callOwnerSource = callOwner == null ? "" : source.slice(callOwner.start, callOwner.end);
  const pluginRoots = [...callOwnerSource.matchAll(/[\w$]+=(?<path>[\w$]+)\.default\.join\((?<pluginRoot>[\w$]+),`\.mcp\.json`\)/g)];
  const serviceCurrent = currentServices.length === 1 && patchedServices.length === 0;
  const servicePatched = currentServices.length === 0 && patchedServices.length === 1;
  const bannerCurrent = currentBanners.length === 1 && patchedBanners.length === 0;
  const bannerPatched = currentBanners.length === 0 && patchedBanners.length === 1;
  const current = !linux && builder.groups.rootParam == null && calls.length === 1 &&
    calls[0].groups.rootArg == null && serviceCurrent && bannerCurrent;
  const patched = Boolean(linux) && builder.groups.rootParam != null && calls.length === 1 &&
    calls[0].groups.rootArg != null && servicePatched && bannerPatched;
  if (!current && !patched) {
    throw new Error("Linux unified Computer Use contract drift: expected one native trusted service selector");
  }
  const service = current ? currentServices[0] : patchedServices[0];
  if (pluginRoots.length !== 1) {
    throw new Error("Linux unified Computer Use contract drift: changed plugin cache relationship");
  }
  const root = pluginRoots[0];
  const banner = current ? currentBanners[0] : patchedBanners[0];
  if (banner.groups.services !== service.groups.services) {
    throw new Error("Linux unified Computer Use contract drift: changed native banner relationship");
  }
  if (patched && (service.groups.path !== root.groups.path || service.groups.pluginRoot !== root.groups.pluginRoot ||
      banner.groups.path !== root.groups.path || banner.groups.pluginRoot !== root.groups.pluginRoot ||
      builder.groups.pluginRoot !== root.groups.pluginRoot || calls[0].groups.pluginRoot !== root.groups.pluginRoot)) {
    throw new Error("Linux unified Computer Use contract drift: changed native service path relationship");
  }
  if (patched) return source;
  const pluginRoot = root.groups.pluginRoot;
  const pathAlias = root.groups.path;
  const edits = [
    {
      index: match.index,
      length: match[0].length,
      replacement:
        `${native}=${ready}&&${runtime}.platform===\`darwin\`&&${features}.computerUse&&${legacy}.enabled&&${legacy}.paths.serviceAppPath!=null` +
        `||${ready}&&${runtime}.platform===\`linux\`&&${features}.computerUse&&${legacy}.enabled,` +
        `${mode}=${runtime}.platform===\`linux\`?${native}:${modeValue}`,
    },
    {
      index: builderOwner.start + service.index,
      length: service[0].length,
      replacement: `${surfaces}.includes(\`computer\`)&&(${service.groups.services}.sky=${pathAlias}.default.join(${pluginRoot},\`scripts\`,\`native-service.mjs\`))`,
    },
    {
      index: builderOwner.start + banner.index,
      length: banner[0].length,
      replacement:
        `CUA_REPL_ENABLED_SURFACES:${surfaces}.join(\`,\`),` +
        `CODEX_LINUX_CUA_HOST_SOCKET:process.env.CODEX_LINUX_CUA_HOST_SOCKET,` +
        `NODE_REPL_JS_BANNER:\`await import("@oai/cua/tinyskyAlt");await(await import(\${JSON.stringify(${pathAlias}.default.join(${pluginRoot},\`scripts\`,\`native-client.mjs\`))})).installLinuxComputerUse(cua);\`,` +
        `[${banner.groups.constants}.${banner.groups.constant}]:JSON.stringify(${banner.groups.services})`,
    },
    {
      index: builder.index + builder[0].length - 2,
      length: 1,
      replacement: `,${pluginRoot})`,
    },
    {
      index: calls[0].index,
      length: calls[0][0].length,
      replacement: calls[0][0].replace(`(${calls[0].groups.argument})`, `(${calls[0].groups.argument},${pluginRoot})`),
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
