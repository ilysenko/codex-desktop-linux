"use strict";

const READ_ALOUD_PLUGIN_NAME = "read-aloud";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasReadAloudPluginGate(source) {
  const pluginGateArray = findBundledPluginGateArray(source);
  const target = pluginGateArray?.text ?? source;
  const nameExpression = pluginNameExpressionRegex(source, READ_ALOUD_PLUGIN_NAME);
  return new RegExp(
    String.raw`\{(?:[^{}]*,)?name:${nameExpression},(?:isEnabled|isAvailable):`,
  ).test(target);
}

function pluginNameExpressionRegex(source, pluginName) {
  const escapedPluginName = escapeRegExp(pluginName);
  const boundName = sourceBoundName(source, pluginName);
  return boundName == null
    ? String.raw`(?:\`${escapedPluginName}\`|"${escapedPluginName}"|'${escapedPluginName}')`
    : String.raw`(?:${escapeRegExp(boundName)}|\`${escapedPluginName}\`|"${escapedPluginName}"|'${escapedPluginName}')`;
}

function sourceBoundName(source, pluginName) {
  return source.match(
    new RegExp(String.raw`([A-Za-z_$][\w$]*)=(?:\`${escapeRegExp(pluginName)}\`|"${escapeRegExp(pluginName)}"|'${escapeRegExp(pluginName)}')`),
  )?.[1] ?? null;
}

function buildReadAloudDescriptor() {
  return `{installWhenMissing:!0,name:\`${READ_ALOUD_PLUGIN_NAME}\`,isAvailable:({platform:e})=>e===\`linux\`}`;
}

function findMatchingBracket(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findBundledPluginGateArray(source) {
  const markerPattern = /\.\.\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.computerUse\b/g;
  for (const marker of source.matchAll(markerPattern)) {
    const markerIndex = marker.index;
    const openIndex = source.lastIndexOf("[", markerIndex);
    if (openIndex === -1) {
      continue;
    }
    const closeIndex = findMatchingBracket(source, openIndex);
    if (closeIndex !== -1 && markerIndex < closeIndex) {
      const text = source.slice(openIndex + 1, closeIndex);
      const descriptorNamespace = marker[1];
      if (
        text.includes(`...${descriptorNamespace}.latex,isAvailable:()=>!0`) &&
        text.includes(`...${descriptorNamespace}.visualize`) &&
        text.includes(`autoInstallOptOutKey:`) &&
        text.includes(`${descriptorNamespace}.computerUse.name`)
      ) {
        return {
          start: openIndex + 1,
          end: closeIndex,
          text,
          descriptorNamespace,
        };
      }
    }
  }

  return null;
}

function findAlwaysOnBundledDescriptor(pluginGateArray) {
  return new RegExp(
    String.raw`\{\.\.\.${escapeRegExp(pluginGateArray.descriptorNamespace)}\.latex,isAvailable:\(\)=>!0\}`,
  ).exec(pluginGateArray.text);
}

function applyLinuxReadAloudPluginGatePatch(currentSource) {
  if (hasReadAloudPluginGate(currentSource)) {
    return currentSource;
  }

  const pluginGateArray = findBundledPluginGateArray(currentSource);
  if (pluginGateArray == null) {
    if (currentSource.includes(".computerUse")) {
      throw new Error("Required Linux Read Aloud plugin gate patch failed: could not find bundled plugin descriptor array");
    }
    return currentSource;
  }

  const match = findAlwaysOnBundledDescriptor(pluginGateArray);
  if (match == null) {
    throw new Error("Required Linux Read Aloud plugin gate patch failed: could not find bundled plugin descriptor insertion point");
  }

  const insertionIndex = pluginGateArray.start + match.index;
  return `${currentSource.slice(0, insertionIndex)}${buildReadAloudDescriptor()},${currentSource.slice(insertionIndex)}`;
}

const descriptors = [
  {
    id: "linux-read-aloud-plugin-gate",
    phase: "main-bundle",
    order: 155,
    ciPolicy: "required-upstream",
    apply: applyLinuxReadAloudPluginGatePatch,
  },
];

module.exports = {
  READ_ALOUD_PLUGIN_NAME,
  applyLinuxReadAloudPluginGatePatch,
  descriptors,
};
