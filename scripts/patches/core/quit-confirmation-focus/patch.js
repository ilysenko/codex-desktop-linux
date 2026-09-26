"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  applyShellEnvironmentStartup,
  matchesShellEnvironment,
} = require("../shell-env-startup/shell-env.js");

const HELPER_NAME = "codexLinuxQuitDialogParent";
const HELPER_SOURCE =
  "let codexLinuxQuitPromptPending=!1;" +
  `function ${HELPER_NAME}(e){` +
  "let t=require(`electron`).BrowserWindow,n=t.getFocusedWindow();" +
  "if(n!=null&&!n.isDestroyed()&&n.isVisible())return n;" +
  "n=e.windowManager.getPrimaryWindow();" +
  "if(n!=null&&!n.isDestroyed()&&n.isVisible())return n;" +
  "return t.getAllWindows().find(e=>!e.isDestroyed()&&e.isVisible())??null}";

const IDENT = "[A-Za-z_$][\\w$]*";

function quitFunctionRange(source) {
  const markers = [...source.matchAll(/messageId:`desktop\.quitConfirmation\.quit`/g)];
  if (markers.length !== 1) {
    throw new Error("Expected exactly one official Quit confirmation anchor");
  }

  const start = source.lastIndexOf("function ", markers[0].index);
  const endMarker = source.indexOf("}function ", markers[0].index);
  if (start < 0 || endMarker < 0) {
    throw new Error("Could not isolate official Quit handler");
  }
  const end = endMarker + 1;
  const body = source.slice(start, end);
  if (!body.includes(".app.on(`before-quit`,") ||
      !body.includes(".markAppQuitting()")) {
    throw new Error("Official Quit handler contract changed");
  }
  return { start, end, body };
}

function applyQuitConfirmationFocus(source) {
  const { start, end, body } = quitFunctionRange(source);
  const helperPresent = source.includes(`function ${HELPER_NAME}(`);
  if (helperPresent) {
    if (body.includes("codexLinuxQuitPromptPending") &&
        !body.includes("showMessageBoxSync(")) {
      return source;
    }
    throw new Error("Incomplete Quit confirmation focus patch");
  }

  const headerEnd = body.indexOf("}){");
  if (headerEnd < 0) {
    throw new Error("Official Quit handler signature changed");
  }
  const header = body.slice(0, headerEnd + 3);
  const binding = (name) => {
    const matches = [...header.matchAll(new RegExp(`${name}:(${IDENT})(?=,|\\})`, "g"))];
    if (matches.length !== 1) {
      throw new Error(`Official Quit binding changed: ${name}`);
    }
    return matches[0][1];
  };
  const windows = binding("windows");
  const quitState = binding("quitState");

  const beforeQuit = [...body.matchAll(
    /([A-Za-z_$][\w$]*)\.app\.on\(`before-quit`,([A-Za-z_$][\w$]*)=>\{/g,
  )];
  if (beforeQuit.length !== 1) {
    throw new Error("Expected one official before-quit handler");
  }
  const [, appAlias, eventName] = beforeQuit[0];
  const confirmation = new RegExp(
    `if\\(${appAlias}\\.dialog\\.showMessageBoxSync\\((\\{[\\s\\S]*?\\})\\)!==0\\)` +
      `\\{${eventName}\\.preventDefault\\(\\);return\\}` +
      `${quitState}\\.markQuitApproved\\(\\),${IDENT}=!0,${windows}\\.markAppQuitting\\(\\)`,
    "g",
  );
  if ([...body.matchAll(confirmation)].length !== 1) {
    throw new Error("Expected one official synchronous Quit confirmation");
  }

  let patchedBody = body.replace(confirmation, (_match, options) =>
    `${eventName}.preventDefault();codexLinuxQuitPromptPending=!0;` +
    `let codexLinuxParent=${HELPER_NAME}(${windows});` +
    `let codexLinuxOptions=${options};` +
    `Promise.resolve().then(()=>codexLinuxParent?` +
    `${appAlias}.dialog.showMessageBox(codexLinuxParent,codexLinuxOptions):` +
    `${appAlias}.dialog.showMessageBox(codexLinuxOptions)).then(e=>{` +
    `codexLinuxQuitPromptPending=!1;if(e.response===0){` +
    `${quitState}.markQuitApproved();${appAlias}.app.quit()}}).catch(e=>{` +
    "codexLinuxQuitPromptPending=!1;" +
    "console.error(`[codex-desktop] Quit confirmation failed`,e)});return");
  patchedBody = patchedBody.replace(
    beforeQuit[0][0],
    `${beforeQuit[0][0]}if(codexLinuxQuitPromptPending){` +
      `${eventName}.preventDefault();return}`,
  );

  return source.slice(0, start) + HELPER_SOURCE + patchedBody + source.slice(end);
}

function patchRequiredCoreBlockers(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const modules = fs.readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => ({
      file: path.join(buildDir, name),
      source: fs.readFileSync(path.join(buildDir, name), "utf8"),
    }));
  const mainCandidates = modules.filter(({ source }) =>
    source.includes("messageId:`desktop.quitConfirmation.quit`"));
  if (mainCandidates.length !== 1) {
    throw new Error("Expected exactly one official main-process Quit module");
  }
  const [{ file: mainPath, source: mainSource }] = mainCandidates;
  const patchedMain = applyQuitConfirmationFocus(mainSource);
  const shellCandidates = modules.filter(({ source }) => matchesShellEnvironment(source));
  if (shellCandidates.length !== 1) {
    throw new Error("Expected exactly one official shell environment module");
  }
  const [{ file: shellPath, source: shellSource }] = shellCandidates;
  const sameModule = mainPath === shellPath;
  const patchedShell = applyShellEnvironmentStartup(
    sameModule ? patchedMain : shellSource,
  );

  // Resolve both semantic contracts before writing either file. The required
  // core repair is one fail-closed transaction and one patch-report entry.
  if (sameModule) {
    if (patchedShell !== mainSource) fs.writeFileSync(mainPath, patchedShell, "utf8");
  } else {
    if (patchedMain !== mainSource) fs.writeFileSync(mainPath, patchedMain, "utf8");
    if (patchedShell !== shellSource) fs.writeFileSync(shellPath, patchedShell, "utf8");
  }
  return {
    changed: sameModule
      ? patchedShell !== mainSource
      : patchedMain !== mainSource || patchedShell !== shellSource,
  };
}

const descriptors = [{
  id: "quit-confirmation-focus",
  phase: "extracted-app:pre-webview",
  ciPolicy: "required-upstream",
  apply: patchRequiredCoreBlockers,
}];

module.exports = {
  HELPER_SOURCE,
  applyQuitConfirmationFocus,
  patchRequiredCoreBlockers,
  descriptors,
};
