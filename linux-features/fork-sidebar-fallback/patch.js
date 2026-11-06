"use strict";

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const READER = new RegExp(
  String.raw`read:(?<key>${IDENT})=>\((?<assertCurrent>${IDENT})\(\),"sidebarCustomSectionsEnabled"===\k<key>\)` +
    String.raw`\?null!=(?<accountId>${IDENT})\(\):(?<evaluations>${IDENT})\.getReadyClient\(\)` +
    String.raw`\?\.checkGate\("codex-app-server-custom-sections"\)(?<fallback>\?\?![01])?(?=\}\})`,
  "g",
);

function applyForkSidebarFallback(source) {
  const matches = [...source.matchAll(READER)];
  if (matches.length !== 1 || matches[0].groups.fallback === "??!0") {
    console.warn(
      "WARN: Expected one current fork sidebar settings reader - skipping fork sidebar fallback",
    );
    return source;
  }
  const [match] = matches;
  if (match.groups.fallback === "??!1") return source;

  // The renderer defaults this optional rollout to false. The background
  // reader otherwise returns undefined without a ready Statsig client, which
  // makes fork placement report execution-config-loading indefinitely.
  const end = match.index + match[0].length;
  return source.slice(0, end) + "??!1" + source.slice(end);
}

const descriptors = [{
  id: "sidebar-settings",
  phase: "main-bundle",
  ciPolicy: "optional",
  apply: applyForkSidebarFallback,
}];

module.exports = { applyForkSidebarFallback, descriptors };
