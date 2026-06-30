"use strict";

const {
  escapeRegExp,
  requireName,
} = require("../shared.js");

function applyLinuxQuitGuardPatch(currentSource) {
  let patchedSource = currentSource;

  const quitGuardNeedle = "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);";
  const legacyQuitGuardSuffix =
    "let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";
  const quitGuardSuffix =
    "let codexLinuxQuitInProgress=!1,codexLinuxExplicitQuitApproved=!1,codexLinuxExplicitQuitDrainTimeoutMs=3e3,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress()},codexLinuxShouldBypassQuitPrompt=()=>codexLinuxExplicitQuitApproved===!0,codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";
  const quitGuardPatch = `${quitGuardNeedle}${quitGuardSuffix}`;

  if (patchedSource.includes("codexLinuxExplicitQuitApproved=!1")) {
    return patchedSource;
  }

  if (patchedSource.includes(legacyQuitGuardSuffix)) {
    return patchedSource.replace(legacyQuitGuardSuffix, quitGuardSuffix);
  }

  if (patchedSource.includes(quitGuardNeedle)) {
    return patchedSource.replace(quitGuardNeedle, quitGuardPatch);
  }

  const splitQuitGuardNeedle =
    /let ([A-Za-z_$][\w$]*)=require\(`electron`\);(?:\1=[^;]+;)?let ([A-Za-z_$][\w$]*)=require\(`node:path`\);(?:\2=[^;]+;)?let ([A-Za-z_$][\w$]*)=require\(`node:fs`\);(?:\3=[^;]+;)?/;
  const splitQuitGuardMatch = patchedSource.match(splitQuitGuardNeedle);
  if (splitQuitGuardMatch != null) {
    const matchedPrefix = splitQuitGuardMatch[0];
    return patchedSource.replace(matchedPrefix, `${matchedPrefix}${quitGuardSuffix}`);
  }

  if (patchedSource.includes("require(`electron`)")) {
    return `${quitGuardSuffix}${patchedSource}`;
  }

  if (patchedSource.includes("require(`electron`)") && patchedSource.includes("require(`node:path`)")) {
    console.warn("WARN: Could not find Linux quit guard insertion point — skipping explicit quit-state patch");
  }

  return patchedSource;
}

function linuxExplicitQuitExpression() {
  return "typeof codexLinuxPrepareForExplicitQuit===`function`?codexLinuxPrepareForExplicitQuit():typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";
}

function applyLinuxWillQuitDrainTimeoutPatch(currentSource) {
  let patchedSource = currentSource;

  const explicitQuitDrainGuard =
    "process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())";
  const originalDrainSnippet =
    "Promise.all([...u.values()].map(e=>e.flush())).finally(()=>{d(),f.dispose(),n.app.quit()})";
  const patchedDrainSnippet =
    "(()=>{let codexLinuxFinalizeQuit=()=>{d(),f.dispose(),n.app.quit()},codexLinuxDrainPromise=Promise.all([...u.values()].map(e=>e.flush()));" +
    `if(${explicitQuitDrainGuard}){Promise.race([codexLinuxDrainPromise,new Promise(e=>setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===\`number\`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).finally(codexLinuxFinalizeQuit);return}` +
    "codexLinuxDrainPromise.finally(codexLinuxFinalizeQuit)})()";
  let patchedAny = false;

  if (patchedSource.includes(originalDrainSnippet)) {
    patchedAny = true;
    patchedSource = patchedSource.split(originalDrainSnippet).join(patchedDrainSnippet);
  }

  const drainRegex =
    /Promise\.all\(\[\.\.\.([A-Za-z_$][\w$]*)\.values\(\)\]\.map\(e=>e\.flush\(\)\)\)\.finally\(\(\)=>\{([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)\.dispose\(\),([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\)/g;
  patchedSource = patchedSource.replace(
    drainRegex,
    (_match, globalStatesVar, flushDisposeVar, disposablesVar, electronVar) => {
      patchedAny = true;
      return `(()=>{let codexLinuxFinalizeQuit=()=>{${flushDisposeVar}(),${disposablesVar}.dispose(),${electronVar}.app.quit()},codexLinuxDrainPromise=Promise.all([...${globalStatesVar}.values()].map(e=>e.flush()));if(${explicitQuitDrainGuard}){Promise.race([codexLinuxDrainPromise,new Promise(e=>setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===\`number\`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).finally(codexLinuxFinalizeQuit);return}codexLinuxDrainPromise.finally(codexLinuxFinalizeQuit)})()`;
    },
  );

  if (
    !patchedAny &&
    !patchedSource.includes("codexLinuxDrainPromise=Promise.all(") &&
    patchedSource.includes("n.app.on(`will-quit`,") &&
    patchedSource.includes(".map(e=>e.flush())")
  ) {
    console.warn("WARN: Could not find will-quit drain sequence — skipping Linux explicit quit drain timeout patch");
  }

  return patchedSource;
}

function applyLinuxExplicitQuitPromptBypassPatch(currentSource) {
  let patchedSource = currentSource;

  const promptBypassExpression =
    "(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt())||";
  const promptBypassGuard = `if(${promptBypassExpression}`;
  const quitMarkerExpression =
    "process.platform===`linux`&&typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";
  const beforeQuitNeedle =
    "if(e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}";
  const beforeQuitPatch =
    `if(${promptBypassExpression}e||i.canQuitWithoutPrompt()||r||!s&&!c){${quitMarkerExpression}g=!0,a.markAppQuitting();return}`;
  const beforeQuitRegex =
    /if\(([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\.canQuitWithoutPrompt\(\)\|\|([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\);return\}/g;
  const patchedBeforeQuitWithoutMarkerRegex =
    /if\(\(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt\(\)\)\|\|([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\.canQuitWithoutPrompt\(\)\|\|([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\);return\}/g;
  const acceptedPromptRegex =
    /([A-Za-z_$][\w$]*)\.markQuitApproved\(\),([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\)/g;
  let patchedAny = false;

  if (patchedSource.includes(beforeQuitNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(beforeQuitNeedle).join(beforeQuitPatch);
  }

  patchedSource = patchedSource.replace(
    beforeQuitRegex,
    (_match, updateInstallVar, quitControllerVar, appQuittingVar, activeConversationVar, automationVar, quittingStateVar, appQuittingControllerVar) => {
      patchedAny = true;
      return `if(${promptBypassExpression}${updateInstallVar}||${quitControllerVar}.canQuitWithoutPrompt()||${appQuittingVar}||!${activeConversationVar}&&!${automationVar}){${quitMarkerExpression}${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting();return}`;
    },
  );
  patchedSource = patchedSource.replace(
    patchedBeforeQuitWithoutMarkerRegex,
    (_match, updateInstallVar, quitControllerVar, appQuittingVar, activeConversationVar, automationVar, quittingStateVar, appQuittingControllerVar) => {
      patchedAny = true;
      return `if(${promptBypassExpression}${updateInstallVar}||${quitControllerVar}.canQuitWithoutPrompt()||${appQuittingVar}||!${activeConversationVar}&&!${automationVar}){${quitMarkerExpression}${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting();return}`;
    },
  );
  patchedSource = patchedSource.replace(
    acceptedPromptRegex,
    (match, quitControllerVar, quittingStateVar, appQuittingControllerVar, offset, source) => {
      const prefix = source.slice(Math.max(0, offset - 120), offset);
      if (prefix.includes("codexLinuxMarkQuitInProgress()")) {
        return match;
      }
      patchedAny = true;
      return `${quitMarkerExpression}${quitControllerVar}.markQuitApproved(),${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting()`;
    },
  );

  if (
    !patchedAny &&
    !patchedSource.includes(promptBypassGuard) &&
    patchedSource.includes("showMessageBoxSync({type:`warning`,buttons:[`Quit`,`Cancel`]") &&
    patchedSource.includes(".canQuitWithoutPrompt()")
  ) {
    console.warn("WARN: Could not find before-quit confirmation guard — skipping Linux explicit quit prompt bypass patch");
  }

  return patchedSource;
}

function applyLinuxExplicitTrayQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression = linuxExplicitQuitExpression();

  const trayQuitNeedle = "{label:rB(this.appName),click:()=>{n.app.quit()}}";
  const trayQuitPatch =
    `{label:rB(this.appName),click:()=>{${quitMarkerExpression}n.app.quit()}}`;
  const patchedTrayQuitRegex =
    /\{label:[^{}]+,click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),[A-Za-z_$][\w$]*\.app\.quit\(\)\}\}/;
  const trayQuitRegex =
    /\{label:rB\(([^)]+)\),click:\(\)=>\{([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\}/g;
  const genericTrayQuitRegex =
    /\{label:([A-Za-z_$][\w$]*\(this\.appName\)),click:\(\)=>\{([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\}/g;
  let patchedAny = false;
  if (patchedSource.includes(trayQuitNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(trayQuitNeedle).join(trayQuitPatch);
  }
  patchedSource = patchedSource.replace(
    trayQuitRegex,
    (_match, appNameExpr, electronVar) => {
      patchedAny = true;
      return `{label:rB(${appNameExpr}),click:()=>{${quitMarkerExpression}${electronVar}.app.quit()}}`;
    },
  );
  patchedSource = patchedSource.replace(
    genericTrayQuitRegex,
    (_match, labelExpression, electronVar) => {
      patchedAny = true;
      return `{label:${labelExpression},click:()=>{${quitMarkerExpression}${electronVar}.app.quit()}}`;
    },
  );
  if (
    !patchedAny &&
    !patchedTrayQuitRegex.test(patchedSource) &&
    patchedSource.includes("getNativeTrayMenuItems(){") &&
    (patchedSource.includes("label:rB(") || patchedSource.includes("role:`quit`"))
  ) {
    console.warn("WARN: Could not find tray quit menu handler — skipping Linux explicit tray quit patch");
  }

  return patchedSource;
}

function applyLinuxExplicitIpcQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression = linuxExplicitQuitExpression();

  const quitAppNeedle = "if(o.type===`quit-app`){n.app.quit();return}";
  const quitAppPatch = `if(o.type===\`quit-app\`){${quitMarkerExpression}n.app.quit();return}`;
  const quitAppRegex =
    /if\(([A-Za-z_$][\w$]*)\.type===`quit-app`\)\{([A-Za-z_$][\w$]*)\.app\.quit\(\);return\}/g;
  const patchedQuitAppRegex =
    /if\([A-Za-z_$][\w$]*\.type===`quit-app`\)\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),[A-Za-z_$][\w$]*\.app\.quit\(\);return\}/;
  let patchedAny = false;
  if (patchedSource.includes(quitAppNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(quitAppNeedle).join(quitAppPatch);
  }
  patchedSource = patchedSource.replace(
    quitAppRegex,
    (_match, messageVar, electronVar) => {
      patchedAny = true;
      return `if(${messageVar}.type===\`quit-app\`){${quitMarkerExpression}${electronVar}.app.quit();return}`;
    },
  );
  if (!patchedAny && !patchedQuitAppRegex.test(patchedSource) && patchedSource.includes("type===`quit-app`")) {
    console.warn("WARN: Could not find quit-app IPC handler — skipping Linux explicit quit-app patch");
  }

  return patchedSource;
}

function linuxCtrlWCloseGuardSource(electronVar) {
  return `process.platform===\`linux\`&&${electronVar}.app.on(\`web-contents-created\`,(e,t)=>{t.on(\`before-input-event\`,(e,t)=>{if(t?.type===\`keyDown\`&&t.control===!0&&t.alt!==!0&&t.meta!==!0&&t.shift!==!0&&String(t.key??\`\`).toLowerCase()===\`w\`){e.preventDefault()}})});`;
}

function applyLinuxCtrlWCloseGuardPatch(currentSource) {
  if (currentSource.includes("String(t.key??``).toLowerCase()===`w`")) {
    return currentSource;
  }

  const electronVar = requireName(currentSource, "electron");
  if (electronVar == null) {
    console.warn("WARN: Could not find Electron alias — skipping Linux Ctrl+W close guard patch");
    return currentSource;
  }

  const guardSource = linuxCtrlWCloseGuardSource(electronVar);
  const requireNeedle = `let ${electronVar}=require(\`electron\`);`;
  if (currentSource.includes(requireNeedle)) {
    return currentSource.replace(requireNeedle, `${requireNeedle}${guardSource}`);
  }

  const requireDeclarationRegex = new RegExp(
    `((?:let|const|var)\\s+[^;]*\\b${escapeRegExp(electronVar)}\\s*=\\s*require\\(\\\`electron\\\`\\)[^;]*;)`,
  );
  if (requireDeclarationRegex.test(currentSource)) {
    return currentSource.replace(requireDeclarationRegex, `$1${guardSource}`);
  }

  console.warn("WARN: Could not find Linux Ctrl+W close guard insertion point");
  return currentSource;
}

module.exports = {
  applyLinuxCtrlWCloseGuardPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
};
