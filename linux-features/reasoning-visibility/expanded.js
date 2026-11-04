"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { runtimeVisibility, withRuntime } = require("./runtime.js");

const ID = "[A-Za-z_$][\\w$]*";
const ENABLED = "codexLinuxReasoningVisibilityEnabled()";
const STATE_MARKER = "/*community-reasoning-visibility-expanded*/";
const BODY_MARKER = "/*community-reasoning-visibility-expanded-body*/";

function reasoningComponent(source) {
  const keys = [...source.matchAll(/key:"reasoning-markdown"/g)];
  if (keys.length !== 1) return null;
  const headers = [...source.slice(0, keys[0].index).matchAll(new RegExp(`function ${ID}\\(${ID}\\)\\{`, "g"))];
  const owners = headers.map(header => ({ start: header.index,
    end: findMatchingBrace(source, header.index + header[0].length - 1) + 1 }))
    .filter(owner => owner.end > keys[0].index);
  const owner = owners.at(-1);
  if (owner == null) return null;
  return { ...owner, text: source.slice(owner.start, owner.end) };
}

function expandedState(source) {
  const component = reasoningComponent(source);
  if (component == null) return { kind: "invalid" };
  const states = [...component.text.matchAll(new RegExp(
    `\\[(?<state>${ID}),(?<setter>${ID})\\]=\\(0,(?<react>${ID})\\.useState\\)\\(` +
    `(?<initial>!1|(?<patched>${escapeRegExp(ENABLED + STATE_MARKER)}))\\),` +
    `(?<disclosure>${ID})=!(?<stream>${ID})&&!!(?<body>${ID});`, "g"))];
  if (states.length !== 1) return { kind: "invalid" };
  const [state] = states;
  const { stream, body, state: expanded, setter } = state.groups;
  const views = [...component.text.matchAll(new RegExp(
    `(?<visible>${ID})=${escapeRegExp(stream)}\\?!!(?<streamBody>${ID})&&\\(null==(?<resume>${ID})\\|\\|"resumed"===\\k<resume>\\):${escapeRegExp(expanded)}` +
    `(?<guard>&&\\(!${escapeRegExp(ENABLED)}\\|\\|!!${escapeRegExp(body)}\\)${escapeRegExp(BODY_MARKER)})?,` +
    `(?<renderBody>${ID})=${escapeRegExp(stream)}\\?\\k<streamBody>:${escapeRegExp(body)},`, "g"))];
  if (views.length !== 1) return { kind: "invalid" };
  const [view] = views;
  const patched = state.groups.patched != null;
  if (patched !== (view.groups.guard != null) || source.split(STATE_MARKER).length - 1 !== Number(patched) ||
      source.split(BODY_MARKER).length - 1 !== Number(patched) ||
      !component.text.includes(`expanded:${expanded},onToggle:()=>{${setter}(`) ||
      !component.text.includes(`autoScrollToBottom:${stream},`) ||
      !component.text.includes(`children:${view.groups.renderBody}`)) return { kind: "invalid" };
  const initialOffset = state.index + state[0].indexOf(`(${state.groups.initial})`) + 1;
  const targetIndex = component.start + initialOffset;
  const visibility = runtimeVisibility(source, targetIndex);
  if (visibility === "invalid" || visibility === "absent" && source.includes(ENABLED) ||
      patched && visibility !== "visible") return { kind: "invalid" };
  if (patched) {
    const guardTarget = component.start + view.index + view[0].indexOf(ENABLED);
    if (runtimeVisibility(source, guardTarget) !== "visible") return { kind: "invalid" };
  }
  return { kind: patched ? "patched" : "current", component, state, view, initialOffset, targetIndex };
}

function applyExpandedPatch(source) {
  const current = expandedState(source);
  const fail = () => {
    console.warn("WARN: reasoning-visibility/expanded: current native disclosure contract missing, ambiguous, or incomplete");
    return source;
  };
  if (current.kind === "invalid") return fail();
  if (current.kind === "patched") return source;
  const { component, state, view, initialOffset, targetIndex } = current;
  const stateName = state.groups.state;
  const guardOffset = view.index + view[0].indexOf(`:${stateName}`) + 1 + stateName.length;
  // Initial expansion survives an initially empty stream. Completed items only
  // reveal a real body; the disabled preference retains the native state rule.
  const edits = [
    { index: initialOffset, length: state.groups.initial.length, text: ENABLED + STATE_MARKER },
    { index: guardOffset, length: 0, text: `&&(!${ENABLED}||!!${state.groups.body})${BODY_MARKER}` },
  ];
  let text = component.text;
  for (const edit of edits.sort((a, b) => b.index - a.index)) {
    text = text.slice(0, edit.index) + edit.text + text.slice(edit.index + edit.length);
  }
  const patched = withRuntime(source.slice(0, component.start) + text + source.slice(component.end), targetIndex);
  return expandedState(patched).kind === "patched" ? patched : fail();
}

const expandedDescriptor = {
  id: "expanded",
  phase: "webview-asset",
  order: 20_746,
  ciPolicy: "optional",
  assetNeedles: ['key:"reasoning-markdown"'],
  assetMatch: source => source.includes('key:"reasoning-markdown"') || source.includes(STATE_MARKER) || source.includes(BODY_MARKER),
  missingDescription: "current reasoning markdown native disclosure component",
  apply: applyExpandedPatch,
};

module.exports = { reasoningComponent, expandedState, applyExpandedPatch, expandedDescriptor };
