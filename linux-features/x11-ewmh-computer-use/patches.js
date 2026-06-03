"use strict";

const X11_COMPUTER_USE_PLUGIN_NAME = "codex-computer-use-x11";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pluginNameExpressionRegex(pluginName) {
  const escaped = escapeRegExp(pluginName);
  return String.raw`(?:\`${escaped}\`|"${escaped}"|'${escaped}')`;
}

function hasX11ComputerUsePluginGate(source) {
  const pluginGateArray = findBundledPluginGateArray(source);
  const target = pluginGateArray?.text ?? source;
  return new RegExp(
    String.raw`\{(?:[^{}]*,)?name:${pluginNameExpressionRegex(X11_COMPUTER_USE_PLUGIN_NAME)},(?:isEnabled|isAvailable):`,
  ).test(target);
}

function buildX11ComputerUseDescriptor(availabilityProp) {
  return `{installWhenMissing:!0,name:\`${X11_COMPUTER_USE_PLUGIN_NAME}\`,${availabilityProp}:({platform:e})=>e===\`linux\`}`;
}

function findMatchingBracket(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote != null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findBundledPluginGateArray(source) {
  let markerIndex = source.indexOf(".computerUse");
  while (markerIndex !== -1) {
    const openIndex = source.lastIndexOf("[", markerIndex);
    if (openIndex === -1) return null;
    const closeIndex = findMatchingBracket(source, openIndex);
    if (closeIndex !== -1 && markerIndex < closeIndex) {
      const text = source.slice(openIndex + 1, closeIndex);
      if (text.includes("installWhenMissing") && text.includes("name:") && /(?:isEnabled|isAvailable):/.test(text)) {
        return { start: openIndex + 1, end: closeIndex, text };
      }
    }
    markerIndex = source.indexOf(".computerUse", markerIndex + ".computerUse".length);
  }
  return null;
}

function findAlwaysOnBundledDescriptor(pluginGateArray) {
  const pluginNameExpression = "(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?|`[^`]+`|\"[^\"]+\"|'[^']+')";
  const regex = new RegExp(String.raw`\{name:(${pluginNameExpression}),(isEnabled|isAvailable):\(\)=>!0\}`, "g");
  let lastMatch = null;
  for (const match of pluginGateArray.text.matchAll(regex)) lastMatch = match;
  return lastMatch;
}

function applyX11ComputerUsePluginGatePatch(currentSource) {
  if (hasX11ComputerUsePluginGate(currentSource)) return currentSource;
  const pluginGateArray = findBundledPluginGateArray(currentSource);
  if (pluginGateArray == null) {
    throw new Error("Optional X11 Computer Use plugin gate patch drift: could not find expected upstream .computerUse plugin descriptor array");
  }
  const match = findAlwaysOnBundledDescriptor(pluginGateArray);
  if (match == null) {
    throw new Error("Required X11 Computer Use plugin gate patch failed: could not find bundled plugin descriptor insertion point");
  }
  const [_descriptor, _pluginName, availabilityProp] = match;
  const insertionIndex = pluginGateArray.start + match.index;
  return `${currentSource.slice(0, insertionIndex)}${buildX11ComputerUseDescriptor(availabilityProp)},${currentSource.slice(insertionIndex)}`;
}

const descriptors = [
  {
    id: "x11-ewmh-computer-use-plugin-gate",
    phase: "main-bundle",
    order: 156,
    ciPolicy: "optional",
    apply: applyX11ComputerUsePluginGatePatch,
  },
];

module.exports = {
  X11_COMPUTER_USE_PLUGIN_NAME,
  applyX11ComputerUsePluginGatePatch,
  descriptors,
};
