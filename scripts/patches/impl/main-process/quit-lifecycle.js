"use strict";

function applyLinuxQuitGuardPatch(currentSource) {
  if (
    currentSource.includes("codexLinuxArmQuitWatchdog=()=>") &&
    /\.app\.on\(`will-quit`,\(\)=>\{process\.platform===`linux`&&codexLinuxCommitQuit\(\)\}\)/.test(currentSource)
  ) {
    return currentSource;
  }

  const currentBundlerQuitGuardNeedle =
    /(?:let|,)\s*([A-Za-z_$][\w$]*)=require\(`electron`\);\1=[^;]+;[\s\S]{0,500}?(?:let|,)\s*([A-Za-z_$][\w$]*)=require\(`node:path`\);\2=[^;]+;[\s\S]{0,500}?(?:let|,)\s*([A-Za-z_$][\w$]*)=require\(`node:fs`\);\3=[^;]+;/;
  const currentBundlerQuitGuardMatch = currentSource.match(currentBundlerQuitGuardNeedle);
  if (currentBundlerQuitGuardMatch != null) {
    const matchedPrefix = currentBundlerQuitGuardMatch[0];
    const electronVar = currentBundlerQuitGuardMatch[1];
    const quitGuardSuffix =
      `let codexLinuxTray=null,codexLinuxRegisterTray=e=>(codexLinuxTray=e,e),codexLinuxIsTrayAlive=()=>{let e=codexLinuxTray;if(e==null)return!1;try{return typeof e.isDestroyed===\`function\`?!e.isDestroyed():!0}catch{return!1}},codexLinuxDestroyTray=()=>{if(process.platform!==\`linux\`)return;let e=codexLinuxTray;codexLinuxTray=null;try{e?.destroy()}catch{}},codexLinuxQuitAttempting=!1,codexLinuxQuitCommitted=!1,codexLinuxQuitCommitCallback=null,codexLinuxExplicitQuitTicket=!1,codexLinuxQuitWatchdogTimer=null,codexLinuxExplicitQuitDrainTimeoutMs=3e3,codexLinuxQuitHardExitTimeoutMs=8e3,codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitTicket=!0,queueMicrotask(()=>{codexLinuxExplicitQuitTicket=!1})},codexLinuxCancelQuitAttempt=()=>{if(codexLinuxQuitCommitted===!0)return;codexLinuxQuitAttempting=!1,codexLinuxQuitCommitCallback=null},codexLinuxAcceptQuitAttempt=(e,t)=>{if(process.platform!==\`linux\`){e();return}codexLinuxQuitAttempting=!0,codexLinuxQuitCommitCallback=e,queueMicrotask(()=>{t?.defaultPrevented&&codexLinuxCancelQuitAttempt()})},codexLinuxShouldBypassQuitPrompt=()=>{if(codexLinuxQuitCommitted===!0)return!0;if(codexLinuxExplicitQuitTicket!==!0)return!1;codexLinuxExplicitQuitTicket=!1;return!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitAttempting===!0||codexLinuxQuitCommitted===!0,codexLinuxForceExit=()=>{try{codexLinuxDestroyTray()}catch{}try{${electronVar}.app.exit(0)}catch{}try{process.exit(0)}catch{}},codexLinuxArmQuitWatchdog=()=>{if(process.platform!==\`linux\`)return;if(codexLinuxQuitWatchdogTimer!=null)return;let e=setTimeout(codexLinuxForceExit,typeof codexLinuxQuitHardExitTimeoutMs===\`number\`?codexLinuxQuitHardExitTimeoutMs:8e3);e.unref?.(),codexLinuxQuitWatchdogTimer=e},codexLinuxCommitQuit=()=>{if(codexLinuxQuitCommitted===!0)return;codexLinuxQuitCommitted=!0,codexLinuxQuitAttempting=!1,codexLinuxExplicitQuitTicket=!1;let e=codexLinuxQuitCommitCallback;codexLinuxQuitCommitCallback=null;try{e?.()}catch{}codexLinuxDestroyTray(),codexLinuxArmQuitWatchdog()};${electronVar}.app.on(\`will-quit\`,()=>{process.platform===\`linux\`&&codexLinuxCommitQuit()});`;
    return currentSource.replace(matchedPrefix, `${matchedPrefix}${quitGuardSuffix}`);
  }

  if (currentSource.includes("require(`electron`)") && currentSource.includes("require(`node:path`)")) {
    console.warn("WARN: Could not find Linux quit guard insertion point — skipping explicit quit-state patch");
  }

  return currentSource;
}

function linuxExplicitQuitExpression() {
  return "typeof codexLinuxPrepareForExplicitQuit===`function`&&codexLinuxPrepareForExplicitQuit(),";
}

function applyLinuxWillQuitDrainTimeoutPatch(currentSource) {
  let patchedSource = currentSource;

  let patchedAny = false;

  const drainRegex =
    /Promise\.all\(\[([A-Za-z_$][\w$]*)\.flush\(\),([A-Za-z_$][\w$]*)\.flush\(\)\]\)\.finally\(\(\)=>\{([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)\.dispose\(\),([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\)/g;
  patchedSource = patchedSource.replace(
    drainRegex,
    (_match, firstDrainVar, secondDrainVar, flushDisposeVar, disposablesVar, electronVar) => {
      patchedAny = true;
      return `(()=>{let codexLinuxFinalizeQuit=()=>{${flushDisposeVar}(),${disposablesVar}.dispose(),${electronVar}.app.quit()},codexLinuxDrainPromise=Promise.all([${firstDrainVar}.flush(),${secondDrainVar}.flush()]);if(process.platform===\`linux\`){typeof codexLinuxCommitQuit===\`function\`&&codexLinuxCommitQuit();let codexLinuxLinuxFinalizeQuit=()=>{try{${flushDisposeVar}()}catch{}try{${disposablesVar}.dispose()}catch{}try{${electronVar}.app.exit(0)}catch{}process.exit(0)};Promise.race([codexLinuxDrainPromise.catch(()=>{}),new Promise(e=>setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===\`number\`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).finally(codexLinuxLinuxFinalizeQuit);return}codexLinuxDrainPromise.finally(codexLinuxFinalizeQuit)})()`;
    },
  );

  if (
    !patchedAny &&
    !patchedSource.includes("codexLinuxLinuxFinalizeQuit=()=>") &&
    patchedSource.includes("n.app.on(`will-quit`,") &&
    patchedSource.includes(".flush()")
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
  const beforeQuitNeedle =
    "if(e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}";
  const beforeQuitPatch =
    `if(${promptBypassExpression}e||i.canQuitWithoutPrompt()||r||!s&&!c){if(process.platform===\`linux\`&&typeof codexLinuxAcceptQuitAttempt===\`function\`){codexLinuxAcceptQuitAttempt(()=>{g=!0,a.markAppQuitting()},o);return}g=!0,a.markAppQuitting();return}`;
  const beforeQuitRegex =
    /if\(([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\.canQuitWithoutPrompt\(\)\|\|([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\);return\}/g;
  const acceptedPromptRegex =
    /([A-Za-z_$][\w$]*)\.markQuitApproved\(\),([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\)/g;

  const beforeQuitEventAt = (source, offset) => {
    const prefix = source.slice(Math.max(0, offset - 1600), offset);
    const matches = [...prefix.matchAll(/\.app\.on\(`before-quit`,([A-Za-z_$][\w$]*)=>\{/g)];
    return matches.at(-1)?.[1] ?? null;
  };

  if (patchedSource.includes(beforeQuitNeedle)) {
    patchedSource = patchedSource.split(beforeQuitNeedle).join(beforeQuitPatch);
  }

  patchedSource = patchedSource.replace(
    beforeQuitRegex,
    (match, updateInstallVar, quitControllerVar, appQuittingVar, activeConversationVar, automationVar, quittingStateVar, appQuittingControllerVar, offset, source) => {
      const eventVar = beforeQuitEventAt(source, offset);
      if (eventVar == null) return match;
      return `if(${promptBypassExpression}${updateInstallVar}||${quitControllerVar}.canQuitWithoutPrompt()||${appQuittingVar}||!${activeConversationVar}&&!${automationVar}){if(process.platform===\`linux\`&&typeof codexLinuxAcceptQuitAttempt===\`function\`){codexLinuxAcceptQuitAttempt(()=>{${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting()},${eventVar});return}${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting();return}`;
    },
  );
  if (patchedSource.includes(promptBypassGuard)) {
    patchedSource = patchedSource.replace(
      acceptedPromptRegex,
      (match, quitControllerVar, quittingStateVar, appQuittingControllerVar, offset, source) => {
        const eventVar = beforeQuitEventAt(source, offset);
        if (eventVar == null) return match;
        return `${quitControllerVar}.markQuitApproved();if(process.platform===\`linux\`&&typeof codexLinuxAcceptQuitAttempt===\`function\`){codexLinuxAcceptQuitAttempt(()=>{${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting()},${eventVar});return}${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting()`;
      },
    );
  }

  const hasQuitConfirmationSite =
    patchedSource.includes(".canQuitWithoutPrompt()") ||
    (patchedSource.includes("showMessageBoxSync") &&
      patchedSource.includes(".markQuitApproved()"));

  if (!patchedSource.includes(promptBypassGuard) && hasQuitConfirmationSite) {
    console.warn("WARN: Could not find before-quit confirmation guard — skipping Linux explicit quit prompt bypass patch");
  }

  return patchedSource;
}

function applyLinuxSqliteBackfillQuitClosePatch(currentSource) {
  const patchedCloseGuard =
    /if\(!\([A-Za-z_$][\w$]*\|\|[A-Za-z_$][\w$]*\|\|process\.platform===`linux`&&typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)\)/;
  if (patchedCloseGuard.test(currentSource)) {
    return currentSource;
  }

  const closeGuardRegex =
    /([A-Za-z_$][\w$]*)\.on\(`close`,([A-Za-z_$][\w$]*)=>\{if\(!\(([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\)\)\{\2\.preventDefault\(\),\4=!0;try\{([A-Za-z_$][\w$]*)\(\)\}finally\{\4=!1\}\}\}\)/;
  if (closeGuardRegex.test(currentSource)) {
    return currentSource.replace(
      closeGuardRegex,
      (_match, windowVar, eventVar, disposedVar, reentrantVar, onQuitVar) =>
        `${windowVar}.on(\`close\`,${eventVar}=>{if(!(${disposedVar}||${reentrantVar}||process.platform===\`linux\`&&typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress())){${eventVar}.preventDefault(),${reentrantVar}=!0;try{${onQuitVar}()}finally{${reentrantVar}=!1}}})`,
    );
  }

  if (currentSource.includes("sqliteBackfillProgress") || currentSource.includes("onBackfillWait")) {
    console.warn("WARN: Could not find SQLite backfill quit close guard — skipping Linux quit-attempt bypass patch");
  }
  return currentSource;
}

function applyLinuxExplicitTrayQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression = linuxExplicitQuitExpression();

  const trayQuitNeedle = "{label:rB(this.appName),click:()=>{n.app.quit()}}";
  const trayQuitPatch =
    `{label:rB(this.appName),click:()=>{${quitMarkerExpression}n.app.quit()}}`;
  const patchedTrayQuitRegex =
    /\{label:[^{}]+,click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`&&codexLinuxPrepareForExplicitQuit\(\),[A-Za-z_$][\w$]*\.app\.quit\(\)\}\}/;
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
    /if\([A-Za-z_$][\w$]*\.type===`quit-app`\)\{typeof codexLinuxPrepareForExplicitQuit===`function`&&codexLinuxPrepareForExplicitQuit\(\),[A-Za-z_$][\w$]*\.app\.quit\(\);return\}/;
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

module.exports = {
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxSqliteBackfillQuitClosePatch,
  applyLinuxWillQuitDrainTimeoutPatch,
};
