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
  const currentServicePattern = /(?<surfaces>[\w$]+)\.surfaces\.includes\(`computer`\)&&\((?<services>[\w$]+)\.sky=`@oai\/sky\/service`\)/g;
  const patchedServicePattern = /(?<surfaces>[\w$]+)\.surfaces\.includes\(`computer`\)&&\((?<services>[\w$]+)\.sky=(?<path>[\w$]+)\.default\.join\((?<pluginRoot>[\w$]+),`scripts`,`native-service\.mjs`\)\)/g;
  const currentServices = [...source.matchAll(currentServicePattern)];
  const patchedServices = [...source.matchAll(patchedServicePattern)];
  const currentBannerPattern = /CUA_REPL_ENABLED_SURFACES:(?<surfaces>[\w$]+)\.surfaces\.join\(`,`\),\[(?<constants>[\w$]+)\.(?<constant>[\w$]+)\]:JSON\.stringify\((?<services>[\w$]+)\)/g;
  const patchedBannerPattern = /CUA_REPL_ENABLED_SURFACES:(?<surfaces>[\w$]+)\.surfaces\.join\(`,`\),CODEX_LINUX_CUA_HOST_SOCKET:process\.env\.CODEX_LINUX_CUA_HOST_SOCKET,NODE_REPL_JS_BANNER:`await import\("@oai\/cua\/tinyskyAlt"\);await\(await import\(\$\{JSON\.stringify\((?<path>[\w$]+)\.default\.join\((?<pluginRoot>[\w$]+),`scripts`,`native-client\.mjs`\)\)\}\)\)\.installLinuxComputerUse\(cua\);`,\[(?<constants>[\w$]+)\.(?<constant>[\w$]+)\]:JSON\.stringify\((?<services>[\w$]+)\)/g;
  const pluginRootPattern = /[\w$]+=(?<path>[\w$]+)\.default\.join\((?<pluginRoot>[\w$]+),`\.mcp\.json`\)/g;
  const serviceOwner = enclosingFunction(source, (currentServices[0] ?? patchedServices[0])?.index ?? -1);
  const serviceOwnerSource = serviceOwner == null ? "" : source.slice(serviceOwner.start, serviceOwner.end);
  const currentBanners = [...serviceOwnerSource.matchAll(currentBannerPattern)];
  const patchedBanners = [...serviceOwnerSource.matchAll(patchedBannerPattern)];
  const pluginRoots = [...serviceOwnerSource.matchAll(pluginRootPattern)];
  const current = !linux && currentServices.length === 1 && patchedServices.length === 0 &&
    currentBanners.length === 1 && patchedBanners.length === 0;
  const patched = Boolean(linux) && currentServices.length === 0 && patchedServices.length === 1 &&
    currentBanners.length === 0 && patchedBanners.length === 1;
  if (!current && !patched) {
    throw new Error("Linux unified Computer Use contract drift: expected one native trusted service selector");
  }
  const service = current ? currentServices[0] : patchedServices[0];
  if (pluginRoots.length !== 1) {
    throw new Error("Linux unified Computer Use contract drift: changed plugin cache relationship");
  }
  const root = pluginRoots[0];
  const banner = current ? currentBanners[0] : patchedBanners[0];
  if (banner.groups.surfaces !== service.groups.surfaces || banner.groups.services !== service.groups.services) {
    throw new Error("Linux unified Computer Use contract drift: changed native banner relationship");
  }
  if (patched && (service.groups.path !== root.groups.path || service.groups.pluginRoot !== root.groups.pluginRoot)) {
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
      index: service.index,
      length: service[0].length,
      replacement: `${service.groups.surfaces}.surfaces.includes(\`computer\`)&&(${service.groups.services}.sky=${pathAlias}.default.join(${pluginRoot},\`scripts\`,\`native-service.mjs\`))`,
    },
    {
      index: serviceOwner.start + banner.index,
      length: banner[0].length,
      replacement:
        `CUA_REPL_ENABLED_SURFACES:${banner.groups.surfaces}.surfaces.join(\`,\`),` +
        `CODEX_LINUX_CUA_HOST_SOCKET:process.env.CODEX_LINUX_CUA_HOST_SOCKET,` +
        `NODE_REPL_JS_BANNER:\`await import("@oai/cua/tinyskyAlt");await(await import(\${JSON.stringify(${pathAlias}.default.join(${pluginRoot},\`scripts\`,\`native-client.mjs\`))})).installLinuxComputerUse(cua);\`,` +
        `[${banner.groups.constants}.${banner.groups.constant}]:JSON.stringify(${banner.groups.services})`,
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
