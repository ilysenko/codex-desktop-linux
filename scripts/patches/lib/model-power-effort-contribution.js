"use strict";

const { createJavaScriptLexicalIndex, escapeRegExp: q } = require("./minified-js.js");

// Both the UI tweak and the configured-preset inspectors must recognize this
// optional contribution without depending on another enabled feature tree.
// The feature descriptor owns activation. This module only builds and projects
// the contribution so each consumer can validate its own native contract.
const MARKER = "codex-linux-dynamic-supported-reasoning-efforts";
const CONSUMER_MARKER = "codexLinuxDynamicPowerEffortConsumer";
const ENABLED = "codexLinuxEnabledPowerEfforts";
const MODEL = "codexLinuxPowerModel";
const EFFORT = "codexLinuxPowerEffort";
const SELECTIONS = "codexLinuxPowerSelections";
const ID = "[A-Za-z_$][\\w$]*";
const HEADER = new RegExp(`^function\\((?<models>${ID}),\\{` +
  `(?<addition>enabledReasoningEfforts:${ENABLED},)?removeXHigh:(?<remove>${ID})=!1,` +
  `sliderModelsConfig:(?<config>${ID}),stripGptPrefix:(?<strip>${ID})=!0\\}=\\{\\}\\)\\{`, "u");

function powerEffortPrefix(roles) {
  const { models, remove, config, strip, normalizer, intersection } = roles;
  return `if(null!=${ENABLED}){` +
    `${models}=${models}?.map(${MODEL}=>({...${MODEL},displayName:${MODEL}.displayName??"Custom",supportedReasoningEfforts:` +
    `${MODEL}.supportedReasoningEfforts.filter(({reasoningEffort:${EFFORT}})=>${ENABLED}.has(${EFFORT}))}));` +
    `if(${config}?.codexLinuxDefaultPresets!==!0){let ${SELECTIONS}=${intersection}(` +
    `${normalizer}(${models},{stripGptPrefix:${strip}}).filter(({reasoningEffort:${EFFORT}})=>` +
    `!${remove}||"xhigh"!==${EFFORT}),${models},${strip});` +
    `return ${SELECTIONS}.length>=3?${SELECTIONS}:[]}}/*${MARKER}*/`;
}

function projectPowerEffortFunction(source) {
  const present = source.includes(MARKER) || source.includes(ENABLED);
  if (!present) return { applied: false, nativeFunction: source, roles: null };
  const head = HEADER.exec(source);
  if (!head?.groups.addition || source.split(MARKER).length !== 2) {
    throw new Error("Incomplete dynamic Power effort contribution");
  }
  const start = head[0].length;
  if (!source.startsWith(`if(null!=${ENABLED}){`, start)) {
    throw new Error("Misplaced dynamic Power effort contribution");
  }
  const lexical = createJavaScriptLexicalIndex(source);
  const open = start + `if(null!=${ENABLED})`.length;
  const end = lexical.matchingBrace(open) + 1 + `/*${MARKER}*/`.length;
  const prefix = source.slice(start, end);
  const calls = new RegExp(`let ${SELECTIONS}=(?<intersection>${ID})\\((?<normalizer>${ID})\\(`, "u").exec(prefix);
  if (!calls) throw new Error("Missing dynamic Power native mapper");
  const roles = { ...head.groups, ...calls.groups };
  if (prefix !== powerEffortPrefix(roles)) throw new Error("Changed dynamic Power effort contribution");
  const nativeHead = head[0].replace(head.groups.addition, "");
  return { applied: true, nativeFunction: nativeHead + source.slice(end), roles };
}

function requirePowerEffortRoles(projection, roles) {
  if (!projection.applied) return;
  for (const name of ["models", "remove", "config", "strip", "normalizer", "intersection"]) {
    if (projection.roles[name] !== roles[name]) throw new Error("Disconnected dynamic Power native role");
  }
}

function applyPowerEffortFunction(source, roles) {
  const head = HEADER.exec(source);
  if (!head || head.groups.addition || source.includes(ENABLED) || source.includes(MARKER)) {
    throw new Error("Expected the native Power resolver contribution state");
  }
  for (const name of ["models", "remove", "config", "strip"]) {
    if (head.groups[name] !== roles[name]) throw new Error("Changed native Power resolver inputs");
  }
  return head[0].replace("{removeXHigh:", `{enabledReasoningEfforts:${ENABLED},removeXHigh:`) +
    powerEffortPrefix(roles) + source.slice(head[0].length);
}

function powerEffortOption(enabled) {
  if (!new RegExp(`^${ID}$`, "u").test(enabled)) throw new Error("Invalid native enabled-effort binding");
  return `,enabledReasoningEfforts:${enabled}/*${CONSUMER_MARKER}*/`;
}

function projectPowerEffortOption(source) {
  const options = [...source.matchAll(new RegExp(`,enabledReasoningEfforts:(${ID})/\\*${CONSUMER_MARKER}\\*/`, "gu"))];
  if (!source.includes(CONSUMER_MARKER)) return { applied: false, nativeSource: source };
  if (options.length !== 1 || source.split(CONSUMER_MARKER).length !== 2) {
    throw new Error("Incomplete dynamic Power consumer contribution");
  }
  const [option] = options;
  return { applied: true, enabled: option[1], index: option.index,
    nativeSource: source.slice(0, option.index) + source.slice(option.index + option[0].length) };
}

function inspectEnabledPowerEffortInput(body, roles) {
  const lexical = createJavaScriptLexicalIndex(body);
  const sole = (expression, root = false) => {
    const values = [...body.matchAll(expression)].filter(match => root ? lexical.isRoot(match.index) : lexical.isCode(match.index));
    if (values.length !== 1) throw new Error("Missing or ambiguous native enabled Power effort input");
    return values[0];
  };
  const filtered = sole(new RegExp(`\\(0,${q(roles.namespace)}\\.CT\\)\\(${q(roles.models)},` +
    `\\{stripGptPrefix:!${q(roles.strip)}\\}\\)\\.filter\\((${ID})\\)`, "gu"), true);
  const callback = sole(new RegExp(`${q(filtered[1])}=(${ID})=>\\{let\\{reasoningEffort:(${ID})\\}=\\1;return (${ID})\\.has\\(\\2\\)\\}`, "gu"));
  const enabled = callback[3];
  const read = sole(new RegExp(`(?<![\\w$.])${q(enabled)}=\\(0,(${ID})\\.Ul\\)\\((${ID})\\.pN\\)`, "gu"), true);
  return { enabled, initializer: read.index, reader: read[1], atom: read[2] };
}

module.exports = { MARKER, CONSUMER_MARKER, projectPowerEffortFunction, requirePowerEffortRoles,
  applyPowerEffortFunction, powerEffortOption, projectPowerEffortOption, inspectEnabledPowerEffortInput };
