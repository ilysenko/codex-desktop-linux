"use strict";

function applyUnifiedComputerUsePatch(source) {
  // Match the current selector, including variable relationships. Both pristine
  // and patched forms must have exactly one owner; drift must abort the build.
  const pattern = /(?<native>[\w$]+)=(?<ready>[\w$]+)&&(?<runtime>[\w$]+)\.platform===`darwin`&&(?<features>[\w$]+)\.computerUse&&(?<legacy>[\w$]+)\.enabled&&\k<legacy>\.paths\.serviceAppPath!=null(?<linux>\|\|\k<ready>&&\k<runtime>\.platform===`linux`&&\k<features>\.computerUse&&\k<legacy>\.enabled)?,(?<mode>[\w$]+)=(?<modeLinux>\k<runtime>\.platform===`linux`\?\k<native>:)?(?<modeValue>\k<features>\.computerUse&&\(\k<features>\.computerUseNodeRepl\|\|\k<native>\)&&\(!\k<features>\.browserUseTinysky\|\|\k<runtime>\.platform!==`darwin`\|\|\k<legacy>\.enabled\))/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || !source.includes("cuaReplSurfaces:")) {
    throw new Error("Linux unified Computer Use contract drift: expected one native surface selector");
  }
  const match = matches[0];
  const { native, ready, runtime, features, legacy, mode, modeValue, linux, modeLinux } = match.groups;
  if (Boolean(linux) !== Boolean(modeLinux)) {
    throw new Error("Linux unified Computer Use contract drift: partial native selector patch");
  }
  if (linux) return source;
  return source.slice(0, match.index) +
    `${native}=${ready}&&${runtime}.platform===\`darwin\`&&${features}.computerUse&&${legacy}.enabled&&${legacy}.paths.serviceAppPath!=null` +
    `||${ready}&&${runtime}.platform===\`linux\`&&${features}.computerUse&&${legacy}.enabled,` +
    `${mode}=${runtime}.platform===\`linux\`?${native}:${modeValue}` +
    source.slice(match.index + match[0].length);
}

module.exports = { applyUnifiedComputerUsePatch };
