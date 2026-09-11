"use strict";

function applyUnifiedComputerUsePatch(source) {
  // Match the current selector, including variable relationships. Both pristine
  // and patched forms must have exactly one owner; drift must abort the build.
  const pattern = /(?<native>[\w$]+)=(?<ready>[\w$]+)&&(?<runtime>[\w$]+)\.platform===`darwin`&&(?<features>[\w$]+)\.computerUse&&(?<legacy>[\w$]+)\.enabled&&\k<legacy>\.paths\.serviceAppPath!=null(?<linux>\|\|\k<ready>&&\k<runtime>\.platform===`linux`&&\k<features>\.computerUse&&\k<legacy>\.enabled)?,(?<mode>[\w$]+)=(?<modeLinux>\k<runtime>\.platform===`linux`\?\k<native>:)?(?<modeValue>\k<features>\.computerUse&&\(\k<features>\.computerUseNodeRepl\|\|\k<native>\)&&\(!\k<features>\.browserUseTinysky\|\|\k<runtime>\.platform!==`darwin`\|\|\k<legacy>\.enabled\))(?=,)/g;
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
  const currentBannerPattern = /CUA_REPL_ENABLED_SURFACES:(?<surfaces>[\w$]+)\.surfaces\.join\(`,`\),\[(?<constants>[\w$]+)\.Il\]:JSON\.stringify\((?<services>[\w$]+)\)/g;
  const patchedBannerPattern = /CUA_REPL_ENABLED_SURFACES:(?<surfaces>[\w$]+)\.surfaces\.join\(`,`\),NODE_REPL_JS_BANNER:`await import\("@oai\/cua\/tinyskyAlt"\);await\(await import\(\$\{JSON\.stringify\((?<path>[\w$]+)\.default\.join\((?<pluginRoot>[\w$]+),`scripts`,`native-client\.mjs`\)\)\}\)\)\.installLinuxComputerUse\(cua\);`,\[(?<constants>[\w$]+)\.Il\]:JSON\.stringify\((?<services>[\w$]+)\)/g;
  const currentBanners = [...source.matchAll(currentBannerPattern)];
  const patchedBanners = [...source.matchAll(patchedBannerPattern)];
  const pluginRootPattern = /[\w$]+=(?<path>[\w$]+)\.default\.join\((?<pluginRoot>[\w$]+),`\.mcp\.json`\)/g;
  const pluginRoots = [...source.matchAll(pluginRootPattern)];
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
  let patchedSource = source.slice(0, match.index) +
    `${native}=${ready}&&${runtime}.platform===\`darwin\`&&${features}.computerUse&&${legacy}.enabled&&${legacy}.paths.serviceAppPath!=null` +
    `||${ready}&&${runtime}.platform===\`linux\`&&${features}.computerUse&&${legacy}.enabled,` +
    `${mode}=${runtime}.platform===\`linux\`?${native}:${modeValue}` +
    source.slice(match.index + match[0].length);
  const pluginRoot = root.groups.pluginRoot;
  const pathAlias = root.groups.path;
  patchedSource = patchedSource.replace(
    currentServicePattern,
    `${service.groups.surfaces}.surfaces.includes(\`computer\`)&&(${service.groups.services}.sky=${pathAlias}.default.join(${pluginRoot},\`scripts\`,\`native-service.mjs\`))`,
  );
  patchedSource = patchedSource.replace(
    currentBannerPattern,
    `CUA_REPL_ENABLED_SURFACES:${banner.groups.surfaces}.surfaces.join(\`,\`),` +
      `NODE_REPL_JS_BANNER:\`await import("@oai/cua/tinyskyAlt");await(await import(\${JSON.stringify(${pathAlias}.default.join(${pluginRoot},\`scripts\`,\`native-client.mjs\`))})).installLinuxComputerUse(cua);\`,` +
      `[${banner.groups.constants}.Il]:JSON.stringify(${banner.groups.services})`,
  );
  return patchedSource;
}

module.exports = { applyUnifiedComputerUsePatch };
