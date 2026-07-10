"use strict";

const ZH_CN_LOCALE_ASSET_PATTERN = /^zh-CN-[^.]+\.js$/;
const ENGLISH_REASONING_LABELS = Object.freeze({
  "composer.mode.local.reasoning.none.label": "None",
  "composer.mode.local.reasoning.minimal.label": "Minimal",
  "composer.mode.local.reasoning.low.label": "Low",
  "composer.mode.local.reasoning.medium.label": "Medium",
  "composer.mode.local.reasoning.high.label": "High",
  "composer.mode.local.reasoning.xhigh.label": "XHigh",
  "composer.mode.local.reasoning.max.label": "Max",
  "composer.mode.local.reasoning.ultra.label": "Ultra",
});

function warn(message) {
  console.warn(`WARN: ${message} - skipping missing ui-tweaks reasoning label markers`);
}

function reasoningLabelConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.reasoning?.keepEffortLabelsEnglish;
  const settings = context?.feature?.settings?.tweaks?.reasoning?.keepEffortLabelsEnglish;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function enabled(context) {
  return reasoningLabelConfig(context).enabled !== false;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyEnglishReasoningLabels(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context)) {
      return source;
    }

    let patched = source;
    const missingKeys = [];
    for (const [key, label] of Object.entries(ENGLISH_REASONING_LABELS)) {
      const replacement = `"${key}":\`${label}\``;
      if (patched.includes(replacement)) {
        continue;
      }

      const pattern = new RegExp(`"${escapeRegExp(key)}":\\\`[^\\\`]*\\\``);
      if (!pattern.test(patched)) {
        missingKeys.push(key);
        continue;
      }
      patched = patched.replace(pattern, replacement);
    }

    if (missingKeys.length > 0 && context.warnOnMissingMarkers === true) {
      warn(`Could not find ${missingKeys.join(", ")}`);
    }
    return patched;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

const descriptors = [
  {
    id: "reasoning-effort-labels-english",
    phase: "webview-asset",
    order: 20_797,
    ciPolicy: "optional",
    pattern: ZH_CN_LOCALE_ASSET_PATTERN,
    missingDescription: "Simplified Chinese locale bundle",
    skipDescription: "ui-tweaks English reasoning effort label patch",
    apply: (source, context = {}) =>
      applyEnglishReasoningLabels(source, { ...context, warnOnMissingMarkers: true }),
  },
];

module.exports = {
  ENGLISH_REASONING_LABELS,
  ZH_CN_LOCALE_ASSET_PATTERN,
  applyEnglishReasoningLabels,
  descriptors,
};
