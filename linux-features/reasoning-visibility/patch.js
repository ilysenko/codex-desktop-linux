"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { withRuntime } = require("./runtime.js");
const { settingsDescriptor } = require("./settings.js");

const ident = String.raw`[A-Za-z_$][\w$]*`;
const marker = (id) => `/*community-reasoning-visibility-${id}*/`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const enabled = "codexLinuxReasoningVisibilityEnabled()";
const enabledPattern = escape(enabled);

// Each contract accepts exactly the upstream form or our complete replacement.
// Markers alone are never evidence of a successfully patched contract.
function recipe(id, pattern, replacement, anchor, validate = () => true) {
  const regex = new RegExp(pattern, "g");
  const matches = (source) => [...source.matchAll(regex)].filter((match) => validate(match.groups));
  const apply = (source) => {
    const found = matches(source);
    if (found.length !== 1) {
      console.warn(`WARN: reasoning-visibility/${id}: expected one current contract, found ${found.length}; disable this feature and rebuild or update its patch.`);
      return source;
    }
    const match = found[0];
    const next = replacement(match.groups);
    return withRuntime(source.slice(0, match.index) + next + source.slice(match.index + match[0].length));
  };
  return {
    id,
    phase: "webview-asset",
    order: 20_745,
    ciPolicy: "optional",
    pattern: /^[A-Za-z0-9_-]+\.js$/,
    assetMatch: (source) => anchor(source) && matches(source).length > 0,
    missingDescription: `reasoning visibility ${id} contract`,
    apply,
  };
}

const standalone = recipe(
  "standalone",
  String.raw`(?<prefix>case\`worktree-init\`:return (?<wrap>${ident})\((?<item>${ident}),\`standalone\`\);case\`reasoning\`:)(?:return ${enabledPattern}\?\k<wrap>\(\k<item>,\`standalone\`\):null${escape(marker("standalone"))};)?(?<suffix>case\`automation-update\`:)`,
  ({ prefix, wrap, item, suffix }) => `${prefix}return ${enabled}?${wrap}(${item},\`standalone\`):null${marker("standalone")};${suffix}`,
  (source) => source.includes("includeGeneratedImages:") && source.includes("case`worktree-init`:"),
);

const persistent = recipe(
  "persistent",
  String.raw`(?<prefix>if\((?<unit>${ident})\.kind!==\`standalone\`\)return!1;let (?<item>${ident})=\k<unit>\.item\.item;return )(?:${enabledPattern}&&\k<item>\.type===\`reasoning\`\?!0:${escape(marker("persistent"))})?(?<suffix>\k<item>\.type===\`user-input-response\`\?!\k<item>\.completed:)`,
  ({ prefix, item, suffix }) => `${prefix}${enabled}&&${item}.type===\`reasoning\`?!0:${marker("persistent")}${suffix}`,
  (source) => source.includes("collapsibleUnits:") && source.includes("persistentUnits:"),
);

// The transcript projection has its own explicit reasoning grouping exception,
// compiled as `…;classified?.grouping===`standalone`||persistent?.has(item)===!0?(flush(),output.push(…)):…`.
const transcript = recipe(
  "transcript",
  String.raw`(?<prefix>;)(?:${enabledPattern}&&(?<item>${ident})\.type===\`reasoning\`\|\|${escape(marker("transcript"))})?(?<rest>(?<classified>${ident})\?\.grouping===\`standalone\`\|\|(?<persistent>${ident})\?\.has\((?<current>${ident})\)===!0\?\((?<flush>${ident})\(\),(?<output>${ident})\.push\(\{type:\`activity-item\`,key:\`transcript-activity-item-)(?=\$\{)`,
  ({ prefix, rest, current }) => `${prefix}${enabled}&&${current}.type===\`reasoning\`||${marker("transcript")}${rest}`,
  (source) => source.includes("transcript-activity-item-") && source.includes("collapseWhenPossible:"),
  ({ item, current }) => item == null || item === current,
);

const summaries = recipe(
  "request-summaries",
  String.raw`reasoningSummaryOverride:(?:(?<upstream>${ident}\.getDefaultFeatureOverride\(\`concurrent_reasoning_summaries\`\)===!0\|\|${ident}\?\`detailed\`:null)|${enabledPattern}\?\`detailed\`:\((?<fallback>${ident}\.getDefaultFeatureOverride\(\`concurrent_reasoning_summaries\`\)===!0\|\|${ident}\?\`detailed\`:null)\)${escape(marker("request-summaries"))})(?<suffix>,getRequestModel:(?<model>${ident})=>\k<model>,getRequestCollaborationMode\()`,
  ({ upstream, fallback, suffix }) => `reasoningSummaryOverride:${enabled}?\`detailed\`:(${upstream ?? fallback})${marker("request-summaries")}${suffix}`,
  (source) => (source.includes("concurrent_reasoning_summaries") || source.includes(marker("request-summaries"))) && source.includes("getRequestCollaborationMode("),
);

function reasoningComponent(source) {
  const keys = [...source.matchAll(/key:`reasoning-markdown`/g)];
  if (keys.length !== 1) return null;
  const headers = [...source.slice(0, keys[0].index).matchAll(new RegExp(String.raw`function ${ident}\(${ident}\)\{`, "g"))];
  const header = headers.at(-1);
  if (header == null) return null;
  const end = findMatchingBrace(source, header.index + header[0].length - 1);
  if (end < keys[0].index) return null;
  const text = source.slice(header.index, end + 1);
  // Bind this state to the completed reasoning body and native disclosure.
  const pattern = new RegExp(
    String.raw`\[(?<state>${ident}),(?<setter>${ident})\]=\(0,(?<react>${ident})\.useState\)\((?:!1|${enabledPattern}${escape(marker("expanded"))})\),(?<disclosure>${ident})=!(?<stream>${ident})&&!!(?<body>${ident}),`, "g",
  );
  const states = [...text.matchAll(pattern)];
  if (states.length !== 1) return null;
  const state = states[0];
  const { stream, body, state: expanded, setter } = state.groups;
  if (!text.includes(`:${expanded},`) || !text.includes(`expanded:${expanded},onToggle:()=>{${setter}(`) ||
      !text.includes(`autoScrollToBottom:${stream},`) ||
      (!text.includes(`?${body}`) && !text.includes(`:${body},`))) return null;
  return { start: header.index, text, state };
}

function applyExpandedPatch(source) {
  const component = reasoningComponent(source);
  if (component == null) {
    console.warn("WARN: reasoning-visibility/expanded: current reasoning disclosure contract missing or ambiguous; disable this feature and rebuild or update its patch.");
    return source;
  }
  const { state, text, start } = component;
  const replacement = state[0].replace(new RegExp(String.raw`\(!1\)|\(${enabledPattern}${escape(marker("expanded"))}\)`), `(${enabled}${marker("expanded")})`);
  const next = text.slice(0, state.index) + replacement + text.slice(state.index + state[0].length);
  return withRuntime(source.slice(0, start) + next + source.slice(start + text.length));
}

module.exports = {
  reasoningComponent,
  descriptors: [standalone, persistent, transcript, summaries, {
    id: "expanded",
    phase: "webview-asset",
    order: 20_746,
    ciPolicy: "optional",
    pattern: /^[A-Za-z0-9_-]+\.js$/,
    assetMatch: (source) => source.includes("key:`reasoning-markdown`"),
    missingDescription: "reasoning markdown disclosure component",
    apply: applyExpandedPatch,
  }, settingsDescriptor],
};
