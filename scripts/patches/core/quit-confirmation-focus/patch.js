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
const QUIT_ANCHOR = /messageId:(["'`])desktop\.quitConfirmation\.quit\1/g;
const QUIT_COORDINATOR = new RegExp(
  `function\\(\\{isWindows:(${IDENT}),disableQuitConfirmationPrompt:(${IDENT}),` +
    `quitState:(${IDENT}),windows:(${IDENT}),`,
  "g",
);

function quitConfirmationMarkers(source) {
  QUIT_ANCHOR.lastIndex = 0;
  return [...source.matchAll(QUIT_ANCHOR)];
}

function matchesQuitConfirmationModule(source) {
  return quitConfirmationMarkers(source).length === 1;
}

function quitCoordinator(source) {
  const markers = quitConfirmationMarkers(source);
  if (markers.length !== 1) {
    throw new Error("Expected exactly one official Quit confirmation anchor");
  }

  QUIT_COORDINATOR.lastIndex = 0;
  const coordinators = [...source.matchAll(QUIT_COORDINATOR)]
    .filter((match) => match.index < markers[0].index);
  if (coordinators.length !== 1) {
    throw new Error("Expected exactly one official Quit coordinator");
  }
  const [coordinator] = coordinators;
  return {
    anchorIndex: markers[0].index,
    bodyStart: coordinator.index + coordinator[0].length,
    quitState: coordinator[3],
    windows: coordinator[4],
  };
}

function applyQuitConfirmationFocus(source) {
  const { anchorIndex, bodyStart, quitState, windows } = quitCoordinator(source);
  const helperPresent = source.includes(`function ${HELPER_NAME}(`);
  if (helperPresent) {
    const guard = source.indexOf("if(codexLinuxQuitPromptPending){", bodyStart);
    const asyncDialog = source.indexOf(
      `dialog.showMessageBox(codexLinuxParent,codexLinuxOptions)`,
      bodyStart,
    );
    if (guard >= 0 && guard < anchorIndex && asyncDialog >= 0) {
      return source;
    }
    throw new Error("Incomplete Quit confirmation focus patch");
  }

  const beforeQuitPattern = new RegExp(
    `(${IDENT})\\.app\\.on\\((["'\\\`])before-quit\\2,(${IDENT})=>\\{`,
    "g",
  );
  const beforeQuit = [...source.slice(bodyStart, anchorIndex).matchAll(beforeQuitPattern)];
  if (beforeQuit.length !== 1) {
    throw new Error("Expected one official before-quit handler");
  }
  const beforeQuitIndex = bodyStart + beforeQuit[0].index;
  const [, appAlias, , eventName] = beforeQuit[0];
  const confirmation = new RegExp(
    `${appAlias}\\.dialog\\.showMessageBoxSync\\((\\{[\\s\\S]*?\\})\\)` +
      `\\?${eventName}\\.preventDefault\\(\\):\\(` +
      `${quitState}\\.markQuitApproved\\(\\),${IDENT}=!0,` +
      `${windows}\\.markAppQuitting\\(\\)\\)`,
    "g",
  );
  const confirmations = [...source.slice(beforeQuitIndex).matchAll(confirmation)]
    .filter((match) => beforeQuitIndex + match.index < anchorIndex &&
      beforeQuitIndex + match.index + match[0].length > anchorIndex);
  if (confirmations.length !== 1) {
    throw new Error("Expected one official synchronous Quit confirmation");
  }
  const confirmationIndex = beforeQuitIndex + confirmations[0].index;

  const patchedConfirmation = confirmations[0][0].replace(confirmation, (_match, options) =>
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
  let patched = source.slice(0, confirmationIndex) + patchedConfirmation +
    source.slice(confirmationIndex + confirmations[0][0].length);
  patched = patched.slice(0, beforeQuitIndex) +
    `${beforeQuit[0][0]}if(codexLinuxQuitPromptPending){` +
      `${eventName}.preventDefault();return}` +
    patched.slice(beforeQuitIndex + beforeQuit[0][0].length);

  return HELPER_SOURCE + patched;
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
  const mainCandidates = modules.filter(({ source }) => matchesQuitConfirmationModule(source));
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
  matchesQuitConfirmationModule,
  patchRequiredCoreBlockers,
  descriptors,
};
