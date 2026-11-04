"use strict";

const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");

const identifier = "[A-Za-z_$][\\w$]*";
const followUpAlias = "codexLinuxRootFollowUp";
const guardProperty = "isMissingWorkspaceRoots:function({composerMode:";

// Match the complete current guard, which upstream compiles as an inline
// function called with the composer submission state:
// `isMissingWorkspaceRoots:function({…}){…}(state)`. Capture minified aliases
// rather than pinning bundle symbols.
const guardParts = [
  String.raw`isMissingWorkspaceRoots:function\(\{composerMode:(?<mode>${identifier}),workspaceRootsLoading:(?<loading>${identifier}),workspaceRootsForSubmit:(?<roots>${identifier}),`,
  String.raw`canUseProjectlessThreads:(?<canProjectless>${identifier}),isProjectlessConversation:(?<projectless>${identifier}),isBrowserEnvironmentSelectionActive:(?<browser>${identifier}),isRemoteProjectExecution:(?<remote>${identifier})(?<followUp>,followUp:${followUpAlias})?\}\)\{`,
  String.raw`let (?<rootless>${identifier})=(?:\(0,${identifier}\.${identifier}\)|${identifier})\(\k<roots>\),(?<rooted>${identifier})=\k<roots>\.some\((?<item>${identifier})=>"/"!==\k<item>\);`,
  String.raw`return"cloud"!==\k<mode>&&!\k<loading>&&!\(\(\k<rooted>\|\|\k<remote>`,
  String.raw`(?<addition>\|\|"local"===\k<mode>&&${followUpAlias}\?\.type==="local"&&\k<roots>\.includes\("/"\))?\)&&!\k<rootless>\)`,
  String.raw`&&!\("local"===\k<mode>&&\(\k<projectless>\|\|\k<canProjectless>&&\k<rootless>\)\)&&!\("local"===\k<mode>&&\k<browser>\)\}\((?<state>${identifier})\)`,
];
const guardPattern = new RegExp(guardParts.join(""), "g");
// The submission state passed to the guard must be the object whose local
// follow-up the sibling workspace-status check already reads.
const STATE_LOOKAHEAD = 4000;

function findGuard(source) {
  if (source.split(guardProperty).length !== 2) return null;
  const matches = [...source.matchAll(guardPattern)];
  if (matches.length !== 1) return null;
  const [match] = matches;
  const { followUp, addition, state } = match.groups;
  if (Boolean(followUp) !== Boolean(addition)) return null;
  if (!followUp && match[0].includes(followUpAlias)) return null;
  const following = source.slice(match.index + match[0].length, match.index + match[0].length + STATE_LOOKAHEAD);
  if (!following.includes(`${state}.followUp?.type==="local"`)) return null;
  return match;
}

function applyFilesystemRootFollowUpsPatch(source) {
  const match = findGuard(source);
  if (match == null) {
    console.warn("WARN: Could not uniquely match the current workspace submission guard - skipping filesystem root follow-ups patch");
    return source;
  }
  if (match.groups.followUp) return source;

  const { mode, roots, remote, rooted, rootless } = match.groups;
  const destructuring = `isRemoteProjectExecution:${remote}}`;
  const condition = `!((${rooted}||${remote})&&!${rootless})`;
  if (match[0].split(destructuring).length !== 2 || match[0].split(condition).length !== 2) {
    console.warn("WARN: Could not uniquely match the current workspace submission guard - skipping filesystem root follow-ups patch");
    return source;
  }
  const patched = match[0]
    .replace(destructuring, () => `isRemoteProjectExecution:${remote},followUp:${followUpAlias}}`)
    .replace(new RegExp(escapeRegExp(condition)), () =>
      `!((${rooted}||${remote}||"local"===${mode}&&${followUpAlias}?.type==="local"&&${roots}.includes("/"))&&!${rootless})`);
  return source.slice(0, match.index) + patched + source.slice(match.index + match[0].length);
}

// The composer module is duplicated into several rspack chunks. Every chunk
// that carries the guard must be patched; each one is proven independently.
const descriptors = [{
  id: "workspace-submission",
  phase: "webview-asset",
  order: 20_910,
  ciPolicy: "optional",
  assetNeedles: [guardProperty, "isRemoteProjectExecution:"],
  missingDescription: "filesystem root follow-ups workspace guard",
  skipDescription: "filesystem root follow-ups patch",
  apply: applyFilesystemRootFollowUpsPatch,
}];

module.exports = { applyFilesystemRootFollowUpsPatch, descriptors };
