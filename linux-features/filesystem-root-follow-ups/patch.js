"use strict";

const identifier = "[A-Za-z_$][\\w$]*";
const followUpAlias = "codexLinuxRootFollowUp";

// Match the complete current guard, including its dependencies and return
// expression. Capture minified aliases rather than pinning bundle symbols.
const guardParts = [
  String.raw`function (?<name>${identifier})\(\{composerMode:(?<mode>${identifier}),workspaceRootsLoading:(?<loading>${identifier}),workspaceRootsForSubmit:(?<roots>${identifier}),`,
  String.raw`canUseProjectlessThreads:(?<canProjectless>${identifier}),isProjectlessConversation:(?<projectless>${identifier}),isBrowserEnvironmentSelectionActive:(?<browser>${identifier}),isRemoteProjectExecution:(?<remote>${identifier})(?<followUp>,followUp:${followUpAlias})?\}\)\{`,
  String.raw`let (?<rootless>${identifier})=(?<predicate>${identifier})\(\k<roots>\),(?<allowed>${identifier})=\k<mode>===\x60local\x60&&\(\k<projectless>\|\|\k<canProjectless>&&\k<rootless>\),`,
  String.raw`(?<selected>${identifier})=\(\k<roots>\.some\((?<item>${identifier})=>\k<item>!==\x60/\x60\)\|\|\k<remote>`,
  String.raw`(?<addition>\|\|\k<mode>===\x60local\x60&&${followUpAlias}\?\.type===\x60local\x60&&\k<roots>\.includes\(\x60/\x60\))?\)&&!\k<rootless>;`,
  String.raw`return \k<mode>!==\x60cloud\x60&&!\k<loading>&&!\k<selected>&&!\k<allowed>&&!\(\k<mode>===\x60local\x60&&\k<browser>\)\}`,
];
const guardStartPattern = new RegExp(guardParts.slice(0, 2).join(""), "g");
const guardPattern = new RegExp(guardParts.join(""), "g");

function findGuard(source) {
  if ([...source.matchAll(guardStartPattern)].length !== 1) return null;
  const matches = [...source.matchAll(guardPattern)];
  if (matches.length !== 1) return null;
  const [match] = matches;
  const { followUp, addition } = match.groups;
  if (Boolean(followUp) !== Boolean(addition)) return null;
  if (!followUp && match[0].includes(followUpAlias)) return null;
  return match;
}

function applyFilesystemRootFollowUpsPatch(source) {
  const match = findGuard(source);
  if (match == null) {
    console.warn("WARN: Could not uniquely match the current workspace submission guard - skipping filesystem root follow-ups patch");
    return source;
  }
  if (match.groups.followUp) return source;

  const { mode, roots, remote, rootless } = match.groups;
  const patched = match[0]
    .replace(`isRemoteProjectExecution:${remote}}`, `isRemoteProjectExecution:${remote},followUp:${followUpAlias}}`)
    .replace(
      `||${remote})&&!${rootless}`,
      `||${remote}||${mode}===\`local\`&&${followUpAlias}?.type===\`local\`&&${roots}.includes(\`/\`))&&!${rootless}`,
    );
  return source.slice(0, match.index) + patched + source.slice(match.index + match[0].length);
}

const descriptors = [{
  id: "workspace-submission",
  phase: "webview-asset",
  order: 20_910,
  ciPolicy: "optional",
  pattern: /^app-primary-[^.]+\.js$/,
  assetMatch: (source) => findGuard(source) != null,
  missingDescription: "filesystem root follow-ups workspace guard",
  skipDescription: "filesystem root follow-ups patch",
  apply: applyFilesystemRootFollowUpsPatch,
}];

module.exports = { applyFilesystemRootFollowUpsPatch, descriptors };
