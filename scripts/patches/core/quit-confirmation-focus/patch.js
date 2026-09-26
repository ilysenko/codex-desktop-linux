"use strict";

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

const descriptors = [{
  id: "quit-confirmation-focus",
  phase: "main-bundle",
  ciPolicy: "required-upstream",
  apply: applyQuitConfirmationFocus,
}];

module.exports = {
  HELPER_SOURCE,
  applyQuitConfirmationFocus,
  descriptors,
};
