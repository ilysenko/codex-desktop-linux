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
// rspack can copy one module into several async chunks, so every chunk that
// carries all needles is patched and each one must hold the complete contract.
function recipe(id, pattern, replacement, assetNeedles, validate = () => true) {
  const regex = new RegExp(pattern, "g");
  const matches = (source) => [...source.matchAll(regex)].filter((match) => validate(match.groups));
  const apply = (source) => {
    if (id === "persistent") {
      const current = [...source.matchAll(new RegExp(String.raw`(?<prefix>"standalone"===(?<unit>${ident})\.kind&&\()(?:${enabledPattern}&&"reasoning"===\k<unit>\.item\.item\.type\|\|${escape(marker("persistent-current"))})?(?<classifier>\(0,${ident}\.${ident}\)\(\k<unit>\.item\.item,[^)]+\))`, "g"))];
      if (current.length === 1) {
        if (current[0][0].includes(marker("persistent-current"))) return source;
        const next = `${current[0].groups.prefix}${enabled}&&"reasoning"===${current[0].groups.unit}.item.item.type||${marker("persistent-current")}${current[0].groups.classifier}`;
        return withRuntime(source.slice(0, current[0].index) + next + source.slice(current[0].index + current[0][0].length));
      }
    }
    if (id === "transcript" && source.includes(marker("persistent-current")) &&
        source.includes("collapsibleUnits:") && source.includes("persistentUnits:")) return source;
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
    assetNeedles,
    missingDescription: `reasoning visibility ${id} contract`,
    apply,
  };
}

const standalone = recipe(
  "standalone",
  String.raw`(?<prefix>case"worktree-init":return (?<wrap>${ident})\((?<item>${ident}),"standalone"\);case"reasoning":)(?:if\(${enabledPattern}\)return \k<wrap>\(\k<item>,"standalone"\);${escape(marker("standalone"))})?(?<suffix>case"[\w-]+":)`,
  ({ prefix, wrap, item, suffix }) => `${prefix}if(${enabled})return ${wrap}(${item},"standalone");${marker("standalone")}${suffix}`,
  ['case"worktree-init":return ', '"standalone");case"reasoning":'],
);

const persistent = recipe(
  "persistent",
  String.raw`(?<prefix>if\("standalone"!==(?<unit>${ident})\.kind\)return!1;let (?<item>${ident})=\k<unit>\.item\.item;return)(?: ${enabledPattern}&&"reasoning"===\k<item>\.type\?!0:${escape(marker("persistent"))})?(?<suffix>"user-input-response"===\k<item>\.type\?!\k<item>\.completed:)`,
  ({ prefix, item, suffix }) => `${prefix} ${enabled}&&"reasoning"===${item}.type?!0:${marker("persistent")}${suffix}`,
  ["collapsibleUnits:", "persistentUnits:"],
);

// The transcript projection has its own explicit reasoning grouping exception,
// compiled as `if(classified?.grouping==="standalone"||persistent?.has(item)===!0){flush(),output.push(…)`.
const transcript = recipe(
  "transcript",
  String.raw`(?<prefix>if\()(?:${enabledPattern}&&"reasoning"===(?<item>${ident})\.type\|\|${escape(marker("transcript"))})?(?<rest>(?<classified>${ident})\?\.grouping==="standalone"\|\|(?<persistent>${ident})\?\.has\((?<current>${ident})\)===!0\)\{(?<flush>${ident})\(\),(?<output>${ident})\.push\(\{type:"activity-item",key:\`transcript-activity-item-)(?=\$\{)`,
  ({ prefix, rest, current }) => `${prefix}${enabled}&&"reasoning"===${current}.type||${marker("transcript")}${rest}`,
  ["collapsibleUnits:", "persistentUnits:"],
  ({ item, current }) => item == null || item === current,
);

const upstreamSummary = String.raw`!0===${ident}\.getDefaultFeatureOverride\("concurrent_reasoning_summaries"\)\|\|${ident}\?"detailed":null`;
const summaries = recipe(
  "request-summaries",
  String.raw`reasoningSummaryOverride:(?:(?<upstream>${upstreamSummary})|${enabledPattern}\?"detailed":\((?<fallback>${upstreamSummary})\)${escape(marker("request-summaries"))})(?<suffix>,getRequestModel:(?<model>${ident})=>\k<model>,getRequestCollaborationMode\()`,
  ({ upstream, fallback, suffix }) => `reasoningSummaryOverride:${enabled}?"detailed":(${upstream ?? fallback})${marker("request-summaries")}${suffix}`,
  ["concurrent_reasoning_summaries", "getRequestCollaborationMode("],
);

function reasoningComponent(source) {
  const keys = [...source.matchAll(/key:"reasoning-markdown"/g)];
  if (keys.length !== 1) return null;
  const headers = [...source.slice(0, keys[0].index).matchAll(new RegExp(String.raw`function ${ident}\(${ident}\)\{`, "g"))];
  const header = headers.at(-1);
  if (header == null) return null;
  const end = findMatchingBrace(source, header.index + header[0].length - 1);
  if (end < keys[0].index) return null;
  const text = source.slice(header.index, end + 1);
  // Bind this state to the completed reasoning body and native disclosure.
  const pattern = new RegExp(
    String.raw`\[(?<state>${ident}),(?<setter>${ident})\]=\(0,(?<react>${ident})\.useState\)\((?:!1|${enabledPattern}${escape(marker("expanded"))})\),(?<disclosure>${ident})=!(?<stream>${ident})&&!!(?<body>${ident})[,;]`, "g",
  );
  const states = [...text.matchAll(pattern)];
  if (states.length !== 1) return null;
  const state = states[0];
  const { stream, body, state: expanded, setter } = state.groups;
  // The upstream completed body strips a leading heading. For a summary
  // consisting only of that heading this leaves nothing to display.
  const contentPattern = new RegExp(
    String.raw`(?<target>${ident})=${escape(stream)}\?"":(?:${enabledPattern}\?(?<patchedItem>${ident})\.content:${escape(marker("completed-content"))})?\(0,(?<module>${ident})\.(?<method>${ident})\)\((?<item>${ident})\.content\)`, "g",
  );
  const contents = [...text.matchAll(contentPattern)];
  if (contents.length !== 1) return null;
  const content = contents[0];
  const { target, item, patchedItem } = content.groups;
  if ((patchedItem != null && patchedItem !== item) ||
      !text.includes(`{item:${item},`) || !text.includes(`let ${body}=${target},[`)) return null;
  if (!text.includes(`:${expanded},`) || !text.includes(`expanded:${expanded},onToggle:()=>{${setter}(`) ||
      !text.includes(`autoScrollToBottom:${stream},`) ||
      (!text.includes(`?${body}`) && !text.includes(`:${body},`) && !text.includes(`:${body};`))) return null;
  if (state[0].includes(marker("expanded")) !== content[0].includes(marker("completed-content"))) return null;
  return { start: header.index, text, state, content };
}

function applyExpandedPatch(source) {
  const component = reasoningComponent(source);
  if (component == null) {
    console.warn("WARN: reasoning-visibility/expanded: current reasoning disclosure contract missing or ambiguous; disable this feature and rebuild or update its patch.");
    return source;
  }
  const { state, content, text, start } = component;
  const replacement = state[0].replace(new RegExp(String.raw`\(!1\)|\(${enabledPattern}${escape(marker("expanded"))}\)`), `(${enabled}${marker("expanded")})`);
  const { target, item, module, method } = content.groups;
  const contentReplacement = `${target}=${component.state.groups.stream}?"":${enabled}?${item}.content:${marker("completed-content")}(0,${module}.${method})(${item}.content)`;
  const edits = [{ index: state.index, length: state[0].length, replacement },
    { index: content.index, length: content[0].length, replacement: contentReplacement }].sort((a, b) => b.index - a.index);
  let next = text;
  for (const edit of edits) next = next.slice(0, edit.index) + edit.replacement + next.slice(edit.index + edit.length);
  return withRuntime(source.slice(0, start) + next + source.slice(start + text.length));
}

module.exports = {
  reasoningComponent,
  descriptors: [standalone, persistent, transcript, summaries, {
    id: "expanded",
    phase: "webview-asset",
    order: 20_746,
    ciPolicy: "optional",
    assetNeedles: ['key:"reasoning-markdown"'],
    missingDescription: "reasoning markdown disclosure component",
    apply: applyExpandedPatch,
  }, settingsDescriptor],
};
