"use strict";

const {
  findMatchingBrace,
} = require("../../lib/minified-js.js");

function applyLinuxQuitGuardPatch(currentSource) {
  if (currentSource.includes("codexLinuxExplicitQuitApproved=!1")) {
    return currentSource;
  }

  const currentBundlerQuitGuardNeedle =
    /(?:let|,)\s*([A-Za-z_$][\w$]*)=require\(`electron`\);\1=[^;]+;[\s\S]{0,500}?(?:let|,)\s*([A-Za-z_$][\w$]*)=require\(`node:path`\);\2=[^;]+;[\s\S]{0,500}?(?:let|,)\s*([A-Za-z_$][\w$]*)=require\(`node:fs`\);\3=[^;]+;/;
  const currentBundlerQuitGuardMatch = currentSource.match(currentBundlerQuitGuardNeedle);
  if (currentBundlerQuitGuardMatch != null) {
    const matchedPrefix = currentBundlerQuitGuardMatch[0];
    const electronVar = currentBundlerQuitGuardMatch[1];
    const quitGuardSuffix =
      `let codexLinuxTray=null,codexLinuxRegisterTray=e=>(codexLinuxTray=e,e),codexLinuxDestroyTray=()=>{if(process.platform!==\`linux\`)return;let e=codexLinuxTray;codexLinuxTray=null;try{e?.destroy()}catch{}},codexLinuxQuitInProgress=!1,codexLinuxExplicitQuitApproved=!1,codexLinuxExplicitQuitDrainTimeoutMs=3e3,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0,codexLinuxDestroyTray()},codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress()},codexLinuxShouldBypassQuitPrompt=()=>codexLinuxExplicitQuitApproved===!0,codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;${electronVar}.app.on(\`before-quit\`,()=>codexLinuxDestroyTray());`;
    return currentSource.replace(matchedPrefix, `${matchedPrefix}${quitGuardSuffix}`);
  }

  if (currentSource.includes("require(`electron`)") && currentSource.includes("require(`node:path`)")) {
    console.warn("WARN: Could not find Linux quit guard insertion point — skipping explicit quit-state patch");
  }

  return currentSource;
}

function linuxExplicitQuitExpression() {
  return "typeof codexLinuxPrepareForExplicitQuit===`function`?codexLinuxPrepareForExplicitQuit():typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";
}

function parseCurrentWillQuitDrainBody(body, eventVar, listenerElectronVar) {
  const identifier = "[A-Za-z_$][\\w$]*";
  const outerMatch = body.match(new RegExp(
    `^if\\((?<quitting>${identifier})=!0,(?<draining>${identifier})\\)return;let (?<upstreamFinalize>${identifier})=\\(\\)=>\\{(?<finalizer>[^;]+)\\};if\\((?<quitController>${identifier})\\.shouldSkipDrainBeforeQuit\\(\\)\\)\\{(?<reduced>[^;]+);return\\}(?<full>.+)$`,
  ));
  if (outerMatch?.groups == null) {
    return null;
  }

  const finalizerMatch = outerMatch.groups.finalizer.match(new RegExp(
    `^(?<contextDispose>${identifier})\\((?<contextArg>${identifier}),(?<contextTimeout>${identifier})\\)\\.then\\(\\(\\)=>\\{(?<disposables>${identifier})\\.dispose\\(\\),(?<electron>${identifier})\\.app\\.quit\\(\\)\\}\\)$`,
  ));
  const reducedMatch = outerMatch.groups.reduced.match(new RegExp(
    `^(?<event>${identifier})\\.preventDefault\\(\\),(?<draining>${identifier})=!0,(?<hotkey>${identifier})\\.dispose\\(\\),(?<dictation>${identifier})\\.dispose\\(\\),Promise\\.allSettled\\(\\[(?<globalState>${identifier})\\.flush\\(\\),(?<stop>${identifier})\\(\\),(?<trace>${identifier})\\(\\)\\]\\)\\.then\\((?<finalize>${identifier})\\)$`,
  ));
  const fullMatch = outerMatch.groups.full.match(new RegExp(
    `^(?<event>${identifier})\\.preventDefault\\(\\),(?<draining>${identifier})=!0,(?<hotkey>${identifier})\\.dispose\\(\\),(?<dictation>${identifier})\\.dispose\\(\\),Promise\\.allSettled\\(\\[(?<globalState>${identifier})\\.flush\\(\\),(?<settings>${identifier})\\.flush\\(\\),(?<stop>${identifier})\\(\\),(?<trace>${identifier})\\(\\)\\]\\)\\.then\\((?<finalize>${identifier})\\)$`,
  ));
  if (finalizerMatch?.groups == null || reducedMatch?.groups == null || fullMatch?.groups == null) {
    return null;
  }

  const outer = outerMatch.groups;
  const finalizer = finalizerMatch.groups;
  const reduced = reducedMatch.groups;
  const full = fullMatch.groups;
  if (
    finalizer.electron !== listenerElectronVar ||
    reduced.event !== eventVar ||
    full.event !== eventVar ||
    reduced.draining !== outer.draining ||
    full.draining !== outer.draining ||
    reduced.hotkey !== full.hotkey ||
    reduced.dictation !== full.dictation ||
    reduced.globalState !== full.globalState ||
    reduced.stop !== full.stop ||
    reduced.trace !== full.trace ||
    reduced.finalize !== outer.upstreamFinalize ||
    full.finalize !== outer.upstreamFinalize
  ) {
    return null;
  }

  return { outer, finalizer, reduced, full };
}

function currentWillQuitDrainCandidates(currentSource) {
  const listenerNeedle = ".app.on(`will-quit`,";
  const candidates = [];
  let searchFrom = 0;

  while (searchFrom < currentSource.length) {
    const listenerIndex = currentSource.indexOf(listenerNeedle, searchFrom);
    if (listenerIndex === -1) {
      break;
    }
    searchFrom = listenerIndex + listenerNeedle.length;

    const electronMatch = currentSource
      .slice(Math.max(0, listenerIndex - 100), listenerIndex)
      .match(/([A-Za-z_$][\w$]*)$/);
    const handlerPrefix = currentSource.slice(searchFrom, searchFrom + 100);
    const handlerMatch = handlerPrefix.match(/^([A-Za-z_$][\w$]*)=>\{/);
    if (electronMatch == null || handlerMatch == null) {
      continue;
    }

    const openBrace = searchFrom + handlerMatch[0].length - 1;
    const closeBrace = findMatchingBrace(currentSource, openBrace);
    if (closeBrace === -1) {
      continue;
    }
    const body = currentSource.slice(openBrace + 1, closeBrace);
    const shape = parseCurrentWillQuitDrainBody(body, handlerMatch[1], electronMatch[1]);
    if (shape != null) {
      candidates.push({ body, openBrace, closeBrace, shape });
    }
  }

  return candidates;
}

function hasAppliedWillQuitCleanupPostcondition(currentSource, appliedFinalizerStart) {
  const listenerNeedle = ".app.on(`will-quit`,";
  const listenerIndex = currentSource.lastIndexOf(
    listenerNeedle,
    appliedFinalizerStart,
  );
  if (listenerIndex === -1) {
    return false;
  }

  const handlerStart = listenerIndex + listenerNeedle.length;
  const handlerMatch = currentSource
    .slice(handlerStart, handlerStart + 100)
    .match(/^[A-Za-z_$][\w$]*=>\{/);
  if (handlerMatch == null) {
    return false;
  }

  const openBrace = handlerStart + handlerMatch[0].length - 1;
  const closeBrace = findMatchingBrace(currentSource, openBrace);
  if (
    closeBrace === -1 ||
    appliedFinalizerStart <= openBrace ||
    appliedFinalizerStart >= closeBrace
  ) {
    return false;
  }

  const handlerBody = currentSource.slice(openBrace + 1, closeBrace);
  const reducedBranchStart = handlerBody.indexOf(
    ".shouldSkipDrainBeforeQuit()){",
  );
  const reducedBranchEnd = handlerBody.indexOf(
    ";return}",
    reducedBranchStart,
  );
  if (reducedBranchStart === -1 || reducedBranchEnd === -1) {
    return false;
  }

  const identifier = "[A-Za-z_$][\\w$]*";
  const cleanupCall = /codexLinuxRunQuitCleanup\(\(\)=>\{/g;
  const reducedBody = handlerBody.slice(
    reducedBranchStart,
    reducedBranchEnd,
  );
  const fullBody = handlerBody.slice(reducedBranchEnd + 8);
  if (
    (reducedBody.match(cleanupCall) ?? []).length !== 1 ||
    (fullBody.match(cleanupCall) ?? []).length !== 1
  ) {
    return false;
  }

  const reducedMatch = reducedBody.match(new RegExp(
    `codexLinuxRunQuitCleanup\\(\\(\\)=>\\{(?<hotkey>${identifier})\\.dispose\\(\\),(?<dictation>${identifier})\\.dispose\\(\\);return Promise\\.allSettled\\(\\[(?<globalState>${identifier})\\.flush\\(\\),(?<stop>${identifier})\\(\\),(?<trace>${identifier})\\(\\)\\]\\)\\}\\)`,
  ));
  const fullMatch = fullBody.match(new RegExp(
    `codexLinuxRunQuitCleanup\\(\\(\\)=>\\{(?<hotkey>${identifier})\\.dispose\\(\\),(?<dictation>${identifier})\\.dispose\\(\\);return Promise\\.allSettled\\(\\[(?<globalState>${identifier})\\.flush\\(\\),(?<settings>${identifier})\\.flush\\(\\),(?<stop>${identifier})\\(\\),(?<trace>${identifier})\\(\\)\\]\\)\\}\\)`,
  ));
  if (reducedMatch?.groups == null || fullMatch?.groups == null) {
    return false;
  }

  return (
    reducedMatch.groups.hotkey === fullMatch.groups.hotkey &&
    reducedMatch.groups.dictation === fullMatch.groups.dictation &&
    reducedMatch.groups.globalState === fullMatch.groups.globalState &&
    reducedMatch.groups.stop === fullMatch.groups.stop &&
    reducedMatch.groups.trace === fullMatch.groups.trace
  );
}

function applyLinuxWillQuitDrainTimeoutPatch(currentSource) {
  const linuxQuitDrainGuard = "process.platform===`linux`";
  const appliedMarkers = [
    "codexLinuxLogQuitDrainResults=e=>{",
    "codexLinuxFinalizeQuit=()=>{",
    "codexLinuxRunQuitCleanup=e=>{if(process.platform===`linux`){Promise.race([Promise.resolve().then(e)",
    "Linux quit cleanup timed out",
    "WARN: Linux quit drain cleanup failed",
    "WARN: Linux quit context cleanup failed",
    "WARN: Linux quit cleanup failed",
    "WARN: Linux quit disposables cleanup failed",
  ];
  const appliedFinalizerStart = currentSource.indexOf(appliedMarkers[0]);
  const appliedFinalizerEnd = currentSource.indexOf(
    ",codexLinuxRunQuitCleanup=",
    appliedFinalizerStart,
  );
  const hasAppliedFinalizerPostcondition =
    appliedFinalizerStart !== -1 &&
    appliedFinalizerEnd > appliedFinalizerStart &&
    /finally\{[A-Za-z_$][\w$]*\.app\.exit\(0\)\}/.test(
      currentSource.slice(appliedFinalizerStart, appliedFinalizerEnd),
    ) &&
    hasAppliedWillQuitCleanupPostcondition(
      currentSource,
      appliedFinalizerStart,
    );
  if (
    appliedMarkers.every((marker) => currentSource.includes(marker)) &&
    hasAppliedFinalizerPostcondition
  ) {
    return currentSource;
  }

  const candidates = currentWillQuitDrainCandidates(currentSource);
  if (candidates.length !== 1) {
    console.warn("WARN: Could not uniquely match current will-quit drain sequence — skipping Linux explicit quit drain timeout patch");
    return currentSource;
  }

  const candidate = candidates[0];
  const { outer, finalizer, reduced, full } = candidate.shape;
  const originalFinalizer = `${outer.upstreamFinalize}=()=>{${outer.finalizer}}`;
  const linuxFinalizer =
    `codexLinuxLogQuitDrainResults=e=>{for(let t of e)if(t.status===\`rejected\`)try{console.warn(\`WARN: Linux quit drain cleanup failed\`,t.reason)}catch{};return e},codexLinuxFinalizeQuit=()=>{try{${finalizer.disposables}.dispose()}catch(e){try{console.warn(\`WARN: Linux quit disposables cleanup failed\`,e)}catch{}}finally{${finalizer.electron}.app.exit(0)}},codexLinuxRunQuitCleanup=e=>{if(${linuxQuitDrainGuard}){Promise.race([Promise.resolve().then(e).then(codexLinuxLogQuitDrainResults).catch(e=>{try{console.warn(\`WARN: Linux quit drain cleanup failed\`,e)}catch{}}).then(()=>Promise.resolve().then(()=>${finalizer.contextDispose}(${finalizer.contextArg},${finalizer.contextTimeout})).catch(e=>{try{console.warn(\`WARN: Linux quit context cleanup failed\`,e)}catch{}})),new Promise((_,e)=>setTimeout(()=>e(Error(\`Linux quit cleanup timed out\`)),typeof codexLinuxExplicitQuitDrainTimeoutMs===\`number\`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).catch(e=>{try{console.warn(\`WARN: Linux quit cleanup failed\`,e)}catch{}}).then(codexLinuxFinalizeQuit);return}e().then(${outer.upstreamFinalize})}`;
  let patchedBody = candidate.body.replace(
    `let ${originalFinalizer};`,
    `let ${originalFinalizer},${linuxFinalizer};`,
  );
  patchedBody = patchedBody.replace(
    `${reduced.hotkey}.dispose(),${reduced.dictation}.dispose(),Promise.allSettled([${reduced.globalState}.flush(),${reduced.stop}(),${reduced.trace}()]).then(${outer.upstreamFinalize})`,
    `codexLinuxRunQuitCleanup(()=>{${reduced.hotkey}.dispose(),${reduced.dictation}.dispose();return Promise.allSettled([${reduced.globalState}.flush(),${reduced.stop}(),${reduced.trace}()])})`,
  );
  patchedBody = patchedBody.replace(
    `${full.hotkey}.dispose(),${full.dictation}.dispose(),Promise.allSettled([${full.globalState}.flush(),${full.settings}.flush(),${full.stop}(),${full.trace}()]).then(${outer.upstreamFinalize})`,
    `codexLinuxRunQuitCleanup(()=>{${full.hotkey}.dispose(),${full.dictation}.dispose();return Promise.allSettled([${full.globalState}.flush(),${full.settings}.flush(),${full.stop}(),${full.trace}()])})`,
  );

  return `${currentSource.slice(0, candidate.openBrace + 1)}${patchedBody}${currentSource.slice(candidate.closeBrace)}`;
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

  const patchedTrayQuitRegex =
    /\{label:this\.systemQuitMenuItemLabel,click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),[A-Za-z_$][\w$]*\.app\.quit\(\)\}\}/;
  const trayQuitRegex =
    /\{label:this\.systemQuitMenuItemLabel,click:\(\)=>\{([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\}/g;
  let patchedAny = false;
  patchedSource = patchedSource.replace(
    trayQuitRegex,
    (_match, electronVar) => {
      patchedAny = true;
      return `{label:this.systemQuitMenuItemLabel,click:()=>{${quitMarkerExpression}${electronVar}.app.quit()}}`;
    },
  );
  if (
    !patchedAny &&
    !patchedTrayQuitRegex.test(patchedSource) &&
    patchedSource.includes("getNativeTrayMenuItems(){") &&
    patchedSource.includes("systemQuitMenuItemLabel")
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

module.exports = {
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
};
