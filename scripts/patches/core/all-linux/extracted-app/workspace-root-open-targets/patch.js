"use strict";

const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const fs = require("node:fs");
const path = require("node:path");

const {
  findMainBundle,
} = require("../../../../lib/assets.js");

const PATCH_MARKER = "codexLinuxWorkspaceRootOpenTarget";
const MISSING_FILE_MANAGER_ACTION_REASON =
  "Workspace-root File Manager open action is not present in this upstream build";

function warn(message) {
  console.warn(`WARN: ${message} - skipping Linux workspace-root open targets patch`);
}

function findMatching(source, openIndex, openChar, closeChar) {
  let depth = 0;
  const stack = [{ type: "code" }];

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const top = stack[stack.length - 1];

    if (top.type === "string") {
      if (top.escaped) {
        top.escaped = false;
      } else if (char === "\\") {
        top.escaped = true;
      } else if (char === top.quote) {
        stack.pop();
      }
      continue;
    }

    if (top.type === "template") {
      if (top.escaped) {
        top.escaped = false;
      } else if (char === "\\") {
        top.escaped = true;
      } else if (char === "`") {
        stack.pop();
      } else if (char === "$" && source[index + 1] === "{") {
        stack.push({ type: "templateExpression", depth: 1 });
        index += 1;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      stack.push({ type: "string", quote: char, escaped: false });
      continue;
    }
    if (char === "`") {
      stack.push({ type: "template", escaped: false });
      continue;
    }

    if (top.type === "templateExpression") {
      if (char === "{") {
        top.depth += 1;
      } else if (char === "}") {
        top.depth -= 1;
        if (top.depth === 0) {
          stack.pop();
        }
      }
      continue;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function enabledWorkspaceRootTargets(mainSource) {
  const targets = [];
  if (
    mainSource.includes("id:`vscode`") &&
    (
      mainSource.includes("linuxDetect:()=>codexLinuxOpenTargetExecutable(`code`)") ||
      mainSource.includes("codexLinuxIdePlatform(`vscode`") ||
      mainSource.includes("function codexLinuxIdeCommand(")
    )
  ) {
    targets.push({ id: "vscode", label: "VS Code" });
  }
  if (
    mainSource.includes("id:`vscodeInsiders`") &&
    (
      mainSource.includes("linuxDetect:()=>codexLinuxOpenTargetExecutable(`code-insiders`)") ||
      mainSource.includes("codexLinuxIdePlatform(`vscodeInsiders`") ||
      mainSource.includes("function codexLinuxIdeCommand(")
    )
  ) {
    targets.push({ id: "vscodeInsiders", label: "VS Code Insiders" });
  }
  if (mainSource.includes("id:`zed`") && mainSource.includes("linux:{label:`Zed`")) {
    targets.push({ id: "zed", label: "Zed" });
  }
  if (mainSource.includes("id:`terminal`") && mainSource.includes("linux:{label:`Terminal`")) {
    targets.push({ id: "terminal", label: "Terminal" });
  }
  return targets;
}

function findItemAssignment(source, onSelectName, searchStart) {
  const pattern =
    /([A-Za-z_$][\w$]*)=[^;]*?\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*)\.Item,\{/g;
  let match = null;
  const prefix = source.slice(0, searchStart);
  for (let next; (next = pattern.exec(prefix)) != null;) {
    match = next;
  }
  if (match == null) {
    return null;
  }

  const valueStart = source.indexOf("=", match.index) + 1;
  const firstParenStart = source.indexOf("(", valueStart);
  const firstParenEnd = findMatching(source, firstParenStart, "(", ")");
  const callParenStart = firstParenEnd + 1;
  if (source[callParenStart] !== "(") {
    return null;
  }
  const callParenEnd = findMatching(source, callParenStart, "(", ")");
  if (callParenEnd === -1) {
    return null;
  }

  const valuePrefix = source.slice(valueStart, firstParenStart);
  const value = source.slice(firstParenStart, callParenEnd + 1);
  if (!value.includes(`onSelect:${onSelectName}`)) {
    return null;
  }

  return {
    start: match.index,
    end: callParenEnd + 1,
    itemVar: match[1],
    jsxVar: match[2],
    menuVar: match[3],
    value,
    valuePrefix,
  };
}

function onSelectNameCandidates(source, callbackName, searchStart) {
  const names = new Set([callbackName]);
  const tail = source.slice(searchStart);
  let added = true;
  while (added) {
    added = false;
    for (const name of [...names]) {
      const pattern = new RegExp(
        `(?:^|[;,])\\s*(?:var\\s+|let\\s+|const\\s+)?([A-Za-z_$][\\w$]*)=${escapeRegExp(name)}(?=[,;])`,
        "g",
      );
      for (let match; (match = pattern.exec(tail)) != null;) {
        if (!names.has(match[1])) {
          names.add(match[1]);
          added = true;
        }
      }
    }
  }
  return [...names];
}

function openTargetItem({ jsxVar, menuVar, openFn, pathVar, cwdVar, openFileVar, closeVar, target }) {
  return `(0,${jsxVar}.jsx)(${menuVar}.Item,{key:\`${PATCH_MARKER}:${target.id}\`,onSelect:()=>{${openFn}({path:${pathVar},cwd:${cwdVar},target:\`${target.id}\`,openFile:${openFileVar}.mutate}),${closeVar}(!1)},children:\`${target.label}\`})`;
}

function applyWorkspaceRootOpenTargetsPatch(currentSource, targets) {
  if (targets.length === 0) {
    return currentSource;
  }

  const openCallPattern = /([A-Za-z_$][\w$]*)\(\{path:([A-Za-z_$][\w$]*),cwd:([A-Za-z_$][\w$]*),target:`fileManager`,openFile:([A-Za-z_$][\w$]*)\.mutate\}\)/gu;
  const edits = [];
  let matchedOpenCall = false;
  for (const openCallMatch of currentSource.matchAll(openCallPattern)) {
    matchedOpenCall = true;
    const [openCall, openFn, pathVar, cwdVar, openFileVar] = openCallMatch;
    const callbackPattern = /([A-Za-z_$][\w$]*)=\(\)=>\{/g;
    let callbackMatch = null;
    const callbackSearchSource = currentSource.slice(0, openCallMatch.index);
    for (let next; (next = callbackPattern.exec(callbackSearchSource)) != null;) {
      callbackMatch = next;
    }
    if (callbackMatch == null) {
      warn("Could not identify workspace-root File Manager callback");
      continue;
    }

    const [, onSelectName] = callbackMatch;
    const callbackBraceIndex = currentSource.indexOf("{", callbackMatch.index);
    const callbackEnd = findMatching(currentSource, callbackBraceIndex, "{", "}");
    if (callbackEnd === -1 || callbackEnd < openCallMatch.index) {
      warn("Could not parse workspace-root File Manager callback body");
      continue;
    }

    const callbackBodyAfterOpen = currentSource.slice(openCallMatch.index + openCall.length, callbackEnd);
    const closeVar = callbackBodyAfterOpen.match(/,([A-Za-z_$][\w$]*)\(!1\)/u)?.[1] ?? null;
    if (closeVar == null) {
      warn("Could not identify workspace-root dropdown close callback");
      continue;
    }

    let item = null;
    for (const candidateName of onSelectNameCandidates(currentSource, onSelectName, callbackEnd)) {
      const onSelectIndex = currentSource.indexOf(`onSelect:${candidateName}`, callbackEnd);
      if (onSelectIndex === -1) {
        continue;
      }
      item = findItemAssignment(currentSource, candidateName, onSelectIndex);
      if (item != null) {
        break;
      }
    }
    if (item == null) {
      warn("Could not parse workspace-root File Manager menu item");
      continue;
    }
    if (item.value.includes(PATCH_MARKER) || edits.some((edit) => edit.start === item.start && edit.end === item.end)) {
      continue;
    }

    const targetItems = targets.map((target) =>
      openTargetItem({
        jsxVar: item.jsxVar,
        menuVar: item.menuVar,
        openFn,
        pathVar,
        cwdVar,
        openFileVar,
        closeVar,
        target,
      }),
    );
    const replacement =
      `${item.itemVar}=${item.valuePrefix}(0,${item.jsxVar}.jsxs)(${item.jsxVar}.Fragment,{children:[` +
      `${targetItems.join(",")},${item.value}]})`;

    edits.push({ start: item.start, end: item.end, replacement });
  }

  if (!matchedOpenCall) {
    warn("Could not find workspace-root File Manager open action");
    return currentSource;
  }
  if (edits.length === 0) {
    return currentSource;
  }

  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (patched, edit) => patched.slice(0, edit.start) + edit.replacement + patched.slice(edit.end),
      currentSource,
    );
}

function patchWorkspaceRootOpenTargets(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    return { matched: 0, changed: 0 };
  }

  const main = findMainBundle(extractedDir);
  if (main == null) {
    return { matched: 0, changed: 0 };
  }

  const mainSource = fs.readFileSync(path.join(main.buildDir, main.mainBundle), "utf8");
  const targets = enabledWorkspaceRootTargets(mainSource);
  if (targets.length === 0) {
    return {
      matched: 0,
      changed: 0,
      status: "skipped-target",
      reason: "No Linux editor or terminal open targets are enabled",
    };
  }
  let matched = 0;
  let changed = 0;

  for (const name of fs.readdirSync(assetsDir)) {
    if (!/^(?:app-main-.*|app-initial~app-main~.*projects-index.*)\.js$/u.test(name)) {
      continue;
    }
    const filePath = path.join(assetsDir, name);
    const source = fs.readFileSync(filePath, "utf8");
    if (!source.includes("target:`fileManager`")) {
      continue;
    }
    matched += 1;
    const patched = applyWorkspaceRootOpenTargetsPatch(source, targets);
    if (patched !== source) {
      fs.writeFileSync(filePath, patched, "utf8");
      changed += 1;
    }
  }

  if (matched === 0) {
    return {
      matched,
      changed,
      status: "skipped-optional",
      reason: MISSING_FILE_MANAGER_ACTION_REASON,
    };
  }
  return { matched, changed };
}

module.exports = extractedAppPatch({
  id: "linux-workspace-root-open-targets",
  phase: "extracted-app:post-webview",
  order: 2060,
  ciPolicy: "optional",
  apply: patchWorkspaceRootOpenTargets,
  status(result, warnings) {
    if (result?.status != null) {
      return { status: result.status, reason: result.reason ?? null };
    }
    if (result?.changed) {
      return warnings.length > 0
        ? { status: "applied-with-warnings", reason: warnings[0] }
        : "applied";
    }
    if (warnings.length > 0) {
      return { status: "skipped-optional", reason: warnings[0] };
    }
    return "already-applied";
  },
  applyWorkspaceRootOpenTargetsPatch,
  enabledWorkspaceRootTargets,
});
