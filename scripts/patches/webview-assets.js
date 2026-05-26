"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Webview asset patches target hashed browser chunks copied out of app.asar.
// They stay fail-soft because upstream chunk names and minified symbols drift.
function applyLinuxOpaqueWindowsDefaultPatch(currentSource) {
  let patchedSource = currentSource;
  let warnedMissingNeedle = false;
  const mergeDefaultPatched = () =>
    patchedSource.includes("opaqueWindows:e?.opaqueWindows??(typeof navigator<`u`&&");
  const settingsDefaultPatched = () =>
    patchedSource.includes("navigator.userAgent.includes(`Linux`)&&r?.opaqueWindows==null") ||
    patchedSource.includes("navigator.userAgent.includes(`Linux`)&&x?.opaqueWindows==null") ||
    /navigator\.userAgent\.includes\(`Linux`\)&&[A-Za-z_$][\w$]*\?\.opaqueWindows==null/u.test(patchedSource);
  const runtimeDefaultPatched = () =>
    patchedSource.includes("document.documentElement.dataset.codexOs===`linux`&&((o===`light`?l:f)?.opaqueWindows==null") ||
    patchedSource.includes("document.documentElement.dataset.codexOs===`linux`&&((s===`light`?u:p)?.opaqueWindows==null") ||
    patchedSource.includes("document.documentElement.dataset.codexOs===`linux`&&g.opaqueWindows==null&&(g={...g,opaqueWindows:!0})") ||
    /document\.documentElement\.dataset\.codexOs===`linux`&&\(\([A-Za-z_$][\w$]*===`light`\?[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*\)\?\.opaqueWindows==null/u.test(patchedSource);
  const linuxDefaultPatched = () =>
    mergeDefaultPatched() || settingsDefaultPatched() || runtimeDefaultPatched();
  const warnMissingNeedle = () => {
    if (warnedMissingNeedle || linuxDefaultPatched()) {
      return;
    }
    warnedMissingNeedle = true;
    console.warn(
      "WARN: Could not find Linux opaque window default insertion point — skipping settings default patch",
    );
  };

  const mergeNeedle = "opaqueWindows:e?.opaqueWindows??n.opaqueWindows,semanticColors:";
  const mergePatch =
    "opaqueWindows:e?.opaqueWindows??(typeof navigator<`u`&&((navigator.userAgentData?.platform??navigator.platform??navigator.userAgent).toLowerCase().includes(`linux`))?!0:n.opaqueWindows),semanticColors:";

  if (mergeDefaultPatched()) {
    // Already patched.
  } else if (patchedSource.includes(mergeNeedle)) {
    patchedSource = patchedSource.replace(mergeNeedle, mergePatch);
  } else if (patchedSource.includes("opaqueWindows") && patchedSource.includes("semanticColors")) {
    warnMissingNeedle();
  }

  const settingsNeedle =
    "let d=ot(r,e),f=at(e),p={codeThemeId:tt(a,e).id,theme:d},";
  const settingsPatch =
    "let d=ot(r,e);navigator.userAgent.includes(`Linux`)&&r?.opaqueWindows==null&&(d={...d,opaqueWindows:!0});let f=at(e),p={codeThemeId:tt(a,e).id,theme:d},";
  if (patchedSource.includes("navigator.userAgent.includes(`Linux`)&&r?.opaqueWindows==null")) {
    // Already patched.
  } else if (patchedSource.includes(settingsNeedle)) {
    patchedSource = patchedSource.replace(settingsNeedle, settingsPatch);
  }

  const currentSettingsNeedle = "setThemePatch:b,theme:x}=ne(t),S=$t(i,t),";
  const currentSettingsPatch =
    "setThemePatch:b,theme:x}=ne(t);navigator.userAgent.includes(`Linux`)&&x?.opaqueWindows==null&&(x={...x,opaqueWindows:!0});let S=$t(i,t),";
  if (patchedSource.includes("navigator.userAgent.includes(`Linux`)&&x?.opaqueWindows==null")) {
    // Already patched.
  } else if (patchedSource.includes(currentSettingsNeedle)) {
    patchedSource = patchedSource.replace(currentSettingsNeedle, currentSettingsPatch);
  }

  const currentSettingsRegex =
    /setThemePatch:([A-Za-z_$][\w$]*),theme:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=/;
  if (patchedSource.includes("navigator.userAgent.includes(`Linux`)&&x?.opaqueWindows==null")) {
    // Already patched by the current-settings branch above.
  } else if (/navigator\.userAgent\.includes\(`Linux`\)&&[A-Za-z_$][\w$]*\?\.opaqueWindows==null/.test(patchedSource)) {
    // Already patched with drifted minified names.
  } else if (currentSettingsRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      currentSettingsRegex,
      (match, setThemePatchVar, themeVar, hookVar, variantVar, nextVar) =>
        `setThemePatch:${setThemePatchVar},theme:${themeVar}}=${hookVar}(${variantVar});navigator.userAgent.includes(\`Linux\`)&&${themeVar}?.opaqueWindows==null&&(${themeVar}={...${themeVar},opaqueWindows:!0});let ${nextVar}=`,
    );
  }

  const runtimeNeedle =
    "let T=o===`light`?C:w,E;if(T.opaqueWindows&&!XZ()){";
  const runtimePatch =
    "let T=o===`light`?C:w,E;document.documentElement.dataset.codexOs===`linux`&&((o===`light`?l:f)?.opaqueWindows==null&&(T={...T,opaqueWindows:!0}));if(T.opaqueWindows&&!XZ()){";
  if (patchedSource.includes("document.documentElement.dataset.codexOs===`linux`&&((o===`light`?l:f)?.opaqueWindows==null")) {
    // Already patched.
  } else if (patchedSource.includes(runtimeNeedle)) {
    patchedSource = patchedSource.replace(runtimeNeedle, runtimePatch);
  }

  const currentRuntimeNeedle = "let T=s===`light`?S:w,E;";
  const currentRuntimePatch =
    "let T=s===`light`?S:w,E;document.documentElement.dataset.codexOs===`linux`&&((s===`light`?u:p)?.opaqueWindows==null&&(T={...T,opaqueWindows:!0}));";
  if (patchedSource.includes("document.documentElement.dataset.codexOs===`linux`&&((s===`light`?u:p)?.opaqueWindows==null")) {
    // Already patched.
  } else if (patchedSource.includes(currentRuntimeNeedle)) {
    patchedSource = patchedSource.replace(currentRuntimeNeedle, currentRuntimePatch);
  }

  const appMainRuntimeNeedle =
    "if((g.opaqueWindows||i)&&!pc()){e.classList.add(`electron-opaque`);return}";
  const appMainRuntimePatch =
    "if(document.documentElement.dataset.codexOs===`linux`&&g.opaqueWindows==null&&(g={...g,opaqueWindows:!0}),(g.opaqueWindows||i)&&!pc()){e.classList.add(`electron-opaque`);return}";
  if (patchedSource.includes("document.documentElement.dataset.codexOs===`linux`&&g.opaqueWindows==null&&(g={...g,opaqueWindows:!0})")) {
    // Already patched.
  } else if (patchedSource.includes(appMainRuntimeNeedle)) {
    patchedSource = patchedSource.replace(appMainRuntimeNeedle, appMainRuntimePatch);
  }

  if (!runtimeDefaultPatched()) {
    const currentRuntimeRegex =
      /let\{data:([A-Za-z_$][\w$]*)\}=Qc\([A-Za-z_$][\w$]*\.APPEARANCE_LIGHT_CHROME_THEME,[A-Za-z_$][\w$]*\).*?let\{data:([A-Za-z_$][\w$]*)\}=Qc\([A-Za-z_$][\w$]*\.APPEARANCE_DARK_CHROME_THEME,[A-Za-z_$][\w$]*\).*?let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`light`\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),/;
    const currentRuntimeMatch = patchedSource.match(currentRuntimeRegex);
    if (currentRuntimeMatch != null) {
      const [
        ,
        lightThemeRawVar,
        darkThemeRawVar,
        selectedThemeVar,
        resolvedVariantVar,
        lightThemeVar,
        darkThemeVar,
      ] = currentRuntimeMatch;
      const selectorNeedle =
        `let ${selectedThemeVar}=${resolvedVariantVar}===\`light\`?${lightThemeVar}:${darkThemeVar},`;
      const selectorPatch =
        `let ${selectedThemeVar}=${resolvedVariantVar}===\`light\`?${lightThemeVar}:${darkThemeVar};document.documentElement.dataset.codexOs===\`linux\`&&((${resolvedVariantVar}===\`light\`?${lightThemeRawVar}:${darkThemeRawVar})?.opaqueWindows==null&&(${selectedThemeVar}={...${selectedThemeVar},opaqueWindows:!0}));let `;
      if (patchedSource.includes(selectorNeedle)) {
        patchedSource = patchedSource.replace(selectorNeedle, selectorPatch);
      }
    }
  }

  if (
    patchedSource === currentSource &&
    !linuxDefaultPatched() &&
    (currentSource.includes("opaqueWindows") ||
      currentSource.includes("electron-opaque") ||
      currentSource.includes("translucentSidebar"))
  ) {
    warnMissingNeedle();
  }

  return patchedSource;
}

function applyLinuxAppSunsetPatch(currentSource) {
  const statsigKey = "2929582856";
  const disabledGatePattern = /if\(!1&&([A-Za-z_$][\w$]*)\(`2929582856`\)\)\{/u;
  const gatePattern = /if\(([A-Za-z_$][\w$]*)\(`2929582856`\)\)\{/u;

  if (disabledGatePattern.test(currentSource)) {
    return currentSource;
  }

  if (gatePattern.test(currentSource)) {
    return currentSource.replace(gatePattern, "if(!1&&$1(`2929582856`)){");
  }

  if (currentSource.includes(statsigKey)) {
    console.warn("WARN: Could not find app sunset gate needle — skipping Linux app sunset patch");
  }

  return currentSource;
}

function applyLinuxAppServerFeatureEnablementPatch(currentSource) {
  const supportedFeatures = new Set([
    "apps",
    "memories",
    "mentions_v2",
    "plugins",
    "remote_control",
    "tool_call_mcp_elicitation",
    "tool_suggest",
  ]);
  const defaultFeaturesMarker = "statsig_default_enable_features";
  const syncMethodMarker = "set-experimental-feature-enablement-for-host";
  if (
    !currentSource.includes(defaultFeaturesMarker) ||
    !currentSource.includes(syncMethodMarker)
  ) {
    return currentSource;
  }

  const featureArrayRegex =
    /var ([A-Za-z_$][\w$]*)=\[([^\]]*?)\];function ([A-Za-z_$][\w$]*)\(\)\{let [\s\S]{0,2400}?statsig_default_enable_features[\s\S]{0,2400}?set-experimental-feature-enablement-for-host/u;
  const featureArrayMatch = currentSource.match(featureArrayRegex);

  if (featureArrayMatch == null) {
    console.warn(
      "WARN: Could not find app-server feature enablement list — skipping unsupported feature compatibility patch",
    );
    return currentSource;
  }

  const [, arrayVar, featureArrayItems] = featureArrayMatch;
  const supportedFeatureArrayItems = featureArrayItems
    .split(",")
    .filter((entry) => {
      const featureMatch = entry.trim().match(/^`([^`]+)`$/u);
      return featureMatch != null && supportedFeatures.has(featureMatch[1]);
    })
    .join(",");
  if (supportedFeatureArrayItems === featureArrayItems) {
    return currentSource;
  }

  const featureArrayNeedle = `var ${arrayVar}=[${featureArrayItems}];`;
  const featureArrayPatch = `var ${arrayVar}=[${supportedFeatureArrayItems}];`;
  const featureArrayIndex = featureArrayMatch.index;
  if (
    featureArrayIndex == null ||
    currentSource.slice(featureArrayIndex, featureArrayIndex + featureArrayNeedle.length) !==
      featureArrayNeedle
  ) {
    console.warn(
      "WARN: Could not locate matched app-server feature enablement list — skipping unsupported feature compatibility patch",
    );
    return currentSource;
  }

  return [
    currentSource.slice(0, featureArrayIndex),
    featureArrayPatch,
    currentSource.slice(featureArrayIndex + featureArrayNeedle.length),
  ].join("");
}

function applySubagentNicknameMetadataPatch(currentSource) {
  let patchedSource = currentSource;
  const sourceShapePatchedMarker = "`subAgent`in e?e.subAgent:`subagent`in e?e.subagent:null";
  const nicknamePatchedMarker =
    "Zl(e.agentNickname)??Zl(e.agent_nickname)??Zl(B(e.source)?.agentNickname)";

  const sourceShapeNeedle =
    "function Mi(e){return`subAgent`in e?e.subAgent:null}function Ni(e){return typeof e==`string`?Pi():`thread_spawn`in e?{parentThreadId:j(e.thread_spawn.parent_thread_id),depth:e.thread_spawn.depth,agentNickname:e.thread_spawn.agent_nickname,agentRole:e.thread_spawn.agent_role}:Pi()}";
  const sourceShapePatch =
    "function Mi(e){return`subAgent`in e?e.subAgent:`subagent`in e?e.subagent:null}function Ni(e){return typeof e==`string`?Pi():`thread_spawn`in e?{parentThreadId:j(e.thread_spawn.parent_thread_id),depth:e.thread_spawn.depth,agentNickname:e.thread_spawn.agent_nickname,agentRole:e.thread_spawn.agent_role}:Pi()}";
  if (patchedSource.includes(sourceShapePatchedMarker)) {
    // Already patched.
  } else if (patchedSource.includes(sourceShapeNeedle)) {
    patchedSource = patchedSource.replace(sourceShapeNeedle, sourceShapePatch);
  } else {
    const sourceShapeRegex =
      /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return`subAgent`in \2\?\2\.subAgent:null\}function ([A-Za-z_$][\w$]*)\(/u;
    if (sourceShapeRegex.test(patchedSource)) {
      patchedSource = patchedSource.replace(
        sourceShapeRegex,
        "function $1($2){return`subAgent`in $2?$2.subAgent:`subagent`in $2?$2.subagent:null}function $3(",
      );
    }
  }

  const nicknameNeedle =
    "function Xl(e){return e==null?null:Zl(e.agentNickname)??Zl(B(e.source)?.agentNickname)}";
  const nicknamePatch =
    "function Xl(e){return e==null?null:Zl(e.agentNickname)??Zl(e.agent_nickname)??Zl(B(e.source)?.agentNickname)}";
  if (patchedSource.includes(nicknamePatchedMarker)) {
    // Already patched.
  } else if (patchedSource.includes(nicknameNeedle)) {
    patchedSource = patchedSource.replace(nicknameNeedle, nicknamePatch);
  } else {
    const nicknameRegex =
      /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return \2==null\?null:([A-Za-z_$][\w$]*)\(\2\.agentNickname\)\?\?\3\(([A-Za-z_$][\w$]*)\(\2\.source\)\?\.agentNickname\)\}/u;
    if (nicknameRegex.test(patchedSource)) {
      patchedSource = patchedSource.replace(
        nicknameRegex,
        "function $1($2){return $2==null?null:$3($2.agentNickname)??$3($2.agent_nickname)??$3($4($2.source)?.agentNickname)}",
      );
    }
  }

  if (
    patchedSource === currentSource &&
    !(currentSource.includes(sourceShapePatchedMarker) && currentSource.includes(nicknamePatchedMarker)) &&
    (currentSource.includes("agentNickname") ||
      currentSource.includes("agent_nickname") ||
      currentSource.includes("thread_spawn"))
  ) {
    console.warn("WARN: Could not find subagent nickname metadata needles — skipping metadata shape patch");
  }

  return patchedSource;
}

function applyBrowserAnnotationScreenshotPatch(currentSource) {
  let patchedSource = currentSource;

  const liveElementScreenshotNeedle =
    "if(M&&j?.anchor.kind===`element`){let e=qu(j,y.current)??null,t=e==null?null:rd(e);he=t?.rect??md(j.anchor),_e=t?.borderRadius}";
  const storedAnchorScreenshotPatch =
    "if(M&&j?.anchor.kind===`element`){he=md(j.anchor),_e=void 0}";
  if (patchedSource.includes(storedAnchorScreenshotPatch)) {
    // Already patched.
  } else if (
    /if\([A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\?\.anchor\.kind===`element`\)\{[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.anchor\),[A-Za-z_$][\w$]*=void 0\}/.test(patchedSource)
  ) {
    // Already patched with the current upstream symbol names.
  } else if (patchedSource.includes(liveElementScreenshotNeedle)) {
    patchedSource = patchedSource.replace(liveElementScreenshotNeedle, storedAnchorScreenshotPatch);
  } else {
    const currentSelectedElementNeedle =
      "if(ve&&M?.anchor.kind===`element`){let e=hl(M,y.current)??null,t=e==null?null:El(e);ke=t?.rect??Rl(M.anchor),je=t?.borderRadius,Ae=Xl(M.anchor,ke,_.width,_.height)}";
    const currentSelectedElementPatch =
      "if(ve&&M?.anchor.kind===`element`){ke=Rl(M.anchor),je=void 0,Ae=Xl(M.anchor,ke,_.width,_.height)}";
    const currentCommentPreloadElementNeedle =
      "if(M&&j?.annotation.anchor.kind===`element`){let e=tt==null?null:ed(tt);at=e?.rect??Td(j.annotation.anchor),st=e?.borderRadius,ot=Wd(j.annotation.anchor,at,S.width,S.height)}";
    const currentCommentPreloadElementPatch =
      "if(M&&j?.annotation.anchor.kind===`element`){at=Td(j.annotation.anchor),st=void 0,ot=Wd(j.annotation.anchor,at,S.width,S.height)}";
    const currentElementScreenshotRegex =
      /if\(([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\?\.anchor\.kind===`element`\)\{let e=[^;{}]+?\?\?null,t=e==null\?null:[A-Za-z_$][\w$]*\(e\);([A-Za-z_$][\w$]*)=t\?\.rect\?\?([A-Za-z_$][\w$]*)\(\2\.anchor\),([A-Za-z_$][\w$]*)=t\?\.borderRadius\}/;
    const currentCommentPreloadElementRegex =
      /if\(([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\?\.annotation\.anchor\.kind===`element`\)\{let e=([A-Za-z_$][\w$]*)==null\?null:[A-Za-z_$][\w$]*\(\3\);([A-Za-z_$][\w$]*)=e\?\.rect\?\?([A-Za-z_$][\w$]*)\(\2\.annotation\.anchor\),([A-Za-z_$][\w$]*)=e\?\.borderRadius,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\.annotation\.anchor,\4,([A-Za-z_$][\w$]*)\.width,([A-Za-z_$][\w$]*)\.height\)\}/;
    if (patchedSource.includes(currentSelectedElementNeedle)) {
      patchedSource = patchedSource.replace(currentSelectedElementNeedle, currentSelectedElementPatch);
    } else if (patchedSource.includes(currentCommentPreloadElementNeedle)) {
      patchedSource = patchedSource.replace(
        currentCommentPreloadElementNeedle,
        currentCommentPreloadElementPatch,
      );
    } else if (currentElementScreenshotRegex.test(patchedSource)) {
      const currentElementScreenshotMatch = patchedSource.match(currentElementScreenshotRegex);
      const [, screenshotModeVar, selectedCommentVar, rectVar, anchorRectFn, radiusVar] = currentElementScreenshotMatch;
      patchedSource = patchedSource.replace(
        currentElementScreenshotRegex,
        `if(${screenshotModeVar}&&${selectedCommentVar}?.anchor.kind===\`element\`){${rectVar}=${anchorRectFn}(${selectedCommentVar}.anchor),${radiusVar}=void 0}`,
      );
    } else if (currentCommentPreloadElementRegex.test(patchedSource)) {
      patchedSource = patchedSource.replace(
        currentCommentPreloadElementRegex,
        (
          _match,
          screenshotModeVar,
          selectedAnnotationVar,
          _connectedElementVar,
          rectVar,
          anchorRectFn,
          radiusVar,
          highlightClassVar,
          highlightFn,
          widthSourceVar,
          heightSourceVar,
        ) =>
          `if(${screenshotModeVar}&&${selectedAnnotationVar}?.annotation.anchor.kind===\`element\`){${rectVar}=${anchorRectFn}(${selectedAnnotationVar}.annotation.anchor),${radiusVar}=void 0,${highlightClassVar}=${highlightFn}(${selectedAnnotationVar}.annotation.anchor,${rectVar},${widthSourceVar}.width,${heightSourceVar}.height)}`,
      );
    } else {
      console.warn("WARN: Could not find browser annotation screenshot element highlight — skipping screenshot anchor patch");
    }
  }

  const allMarkersInScreenshotNeedle =
    "de=u?.target.mode===`create`?ce.find(e=>Sd(e.anchor,u.anchor.value))??null:null,fe=!M&&de!=null?ce.filter(e=>e.id!==de.id):ce,";
  const selectedMarkerInScreenshotPatch =
    "de=u?.target.mode===`create`?ce.find(e=>Sd(e.anchor,u.anchor.value))??null:null,fe=M?ue:!M&&de!=null?ce.filter(e=>e.id!==de.id):ce,";
  if (patchedSource.includes(selectedMarkerInScreenshotPatch)) {
    // Already patched.
  } else if (/=\([A-Za-z_$][\w$]*\?[A-Za-z_$][\w$]*:![A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*!=null\?[A-Za-z_$][\w$]*\.filter\(e=>e\.id!==[A-Za-z_$][\w$]*\.id\):[A-Za-z_$][\w$]*\)\.flatMap/.test(patchedSource)) {
    // Already patched with the current upstream symbol names.
  } else if (patchedSource.includes(allMarkersInScreenshotNeedle)) {
    patchedSource = patchedSource.replace(allMarkersInScreenshotNeedle, selectedMarkerInScreenshotPatch);
  } else {
    const currentMarkersNeedle = "be=(!ge&&ye!=null?A.filter(e=>e.id!==ye.id):A).flatMap";
    const currentMarkersPatch = "be=(ge?he:!ge&&ye!=null?A.filter(e=>e.id!==ye.id):A).flatMap";
    const currentSelectedMarkersNeedle = "Se=(!ve&&xe!=null?k.filter(e=>e.id!==xe.id):k).flatMap";
    const currentSelectedMarkersPatch = "Se=(ve?_e:!ve&&xe!=null?k.filter(e=>e.id!==xe.id):k).flatMap";
    const currentCommentPreloadMarkersNeedle =
      "Xe=(M?j?.kind===`comment`?ge:[]:Ye==null?ge:ge.filter(e=>e.id!==Ye.id)).flatMap";
    const currentCommentPreloadMarkersPatch =
      "Xe=(M?j?.kind===`comment`?ge.filter(e=>e.id===j.annotation.id):[]:Ye==null?ge:ge.filter(e=>e.id!==Ye.id)).flatMap";
    if (patchedSource.includes(currentMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(currentSelectedMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(currentCommentPreloadMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(currentMarkersNeedle)) {
      patchedSource = patchedSource.replace(currentMarkersNeedle, currentMarkersPatch);
    } else if (patchedSource.includes(currentSelectedMarkersNeedle)) {
      patchedSource = patchedSource.replace(currentSelectedMarkersNeedle, currentSelectedMarkersPatch);
    } else if (patchedSource.includes(currentCommentPreloadMarkersNeedle)) {
      patchedSource = patchedSource.replace(
        currentCommentPreloadMarkersNeedle,
        currentCommentPreloadMarkersPatch,
      );
    } else {
      console.warn("WARN: Could not find browser annotation screenshot markers — skipping screenshot marker patch");
    }
  }

  return patchedSource;
}

function detectCurrentRateLimitFooterSymbols(source) {
  const accountSignalMatch = source.match(
    /[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\?\.settings\.model\?\?null,[\s\S]{0,1200}?\{data:[A-Za-z_$][\w$]*\}=ci\(([A-Za-z_$][\w$]*)\),[\s\S]{0,1200}?[A-Za-z_$][\w$]*=Ro\([A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*=Zo\([A-Za-z_$][\w$]*\)/,
  );
  const durationMatch = source.match(
    /function ([A-Za-z_$][\w$]*)\(e\)\{let [A-Za-z_$][\w$]*=\(0,Z\.c\)\(\d+\),\{minutes:[A-Za-z_$][\w$]*,variant:[A-Za-z_$][\w$]*\}=e,[\s\S]{0,700}?=Uo\(\{intl:[A-Za-z_$][\w$]*,minutes:[A-Za-z_$][\w$]*,variant:[A-Za-z_$][\w$]*\}\)/,
  );
  if (accountSignalMatch == null || durationMatch == null) {
    return null;
  }

  const durationComponent = durationMatch[1];
  const durationIndex = source.indexOf(`function ${durationComponent}(e)`);
  const afterDuration = durationIndex === -1 ? source : source.slice(durationIndex);
  const rateLimitMenuMatch = afterDuration.match(
    /function ([A-Za-z_$][\w$]*)\(e\)\{let [A-Za-z_$][\w$]*=\(0,Z\.c\)\(\d+\),\{rateLimits:/,
  );
  if (rateLimitMenuMatch == null) {
    return null;
  }

  return {
    accountSignalVar: accountSignalMatch[1],
    durationComponent,
    insertionNeedle: `function ${rateLimitMenuMatch[1]}(e){`,
  };
}

function detectComposerFooterConversationIdVar(source, footerNeedles) {
  const needles = Array.isArray(footerNeedles) ? footerNeedles : [footerNeedles];
  const footerGroupIndex = needles
    .map((needle) => source.indexOf(needle))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];
  if (footerGroupIndex == null) {
    return null;
  }

  const functionStart = source.lastIndexOf("function ", footerGroupIndex);
  const scopePrefix = source.slice(
    functionStart === -1 ? Math.max(0, footerGroupIndex - 5000) : functionStart,
    footerGroupIndex,
  );
  const conversationPropMatch = scopePrefix.match(/conversationId:([A-Za-z_$][\w$]*)/);
  if (conversationPropMatch != null) {
    const conversationPropVar = conversationPropMatch[1];
    const normalizedConversationMatches = Array.from(
      scopePrefix.matchAll(/(?:let |,)([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\?([A-Za-z_$][\w$]*)(?=,|;)/g),
    ).filter((match) => match[2] === conversationPropVar);
    if (normalizedConversationMatches.length > 0) {
      return normalizedConversationMatches[normalizedConversationMatches.length - 1][1];
    }
    return conversationPropVar;
  }

  const conversationSignalMatches = Array.from(
    scopePrefix.matchAll(/(?:let |,)([A-Za-z_$][\w$]*)=ci\([A-Za-z_$][\w$]*\)(?=,|;)/g),
  );
  if (conversationSignalMatches.length > 0) {
    return conversationSignalMatches[conversationSignalMatches.length - 1][1];
  }

  return null;
}

function applyPersistentRateLimitFooterPatch(currentSource) {
  let patchedSource = currentSource;
  const currentSymbols = detectCurrentRateLimitFooterSymbols(currentSource);
  const currentComposerStatusNeedle =
    "function zg(e){";
  const currentComposerFooterFunction =
    "function codexLinuxRateLimitFooter({conversationId:e,rateLimit:t}){try{let n=Et(),{activeMode:r}=or(e),i=r?.settings.model??null,a=sa(t),o=ta(t),s=da(a,{activeLimitName:o,selectedModel:i}),c=s.filter(kg).slice(0,2);c.length===0&&(c=da(a,{activeLimitName:o,selectedModel:null}).filter(kg).slice(0,2));if(c.length===0)return null;let l=c.map(e=>`${bg(e.bucket.windowDurationMins??null,n,{withColon:!1})} ${n.formatNumber(Yi(e.bucket.usedPercent??0),{maximumFractionDigits:0})}%`).join(` / `);return(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:l})}catch(e){return null}}";
  const currentComposerFooterCallNeedle =
    "children:[ue,de,W,fe,pe,me,G,he,_e,ve,ye,xe,Se,Ce,we,Te,Ee,Oe,Ae,je,Me]";
  const currentComposerFooterCallPatch =
    "children:[ue,de,W,fe,pe,me,G,he,_e,ve,ye,xe,Se,Ce,we,Te,Ee,De==null?null:(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:x,rateLimit:De}),Oe,Ae,je,Me]";
  const currentPermissionsControlsNeedle =
    /\(0,Q\.jsx\)\(([A-Za-z_$][\w$]*),\{conversationId:f,hostId:C,cwdOverride:w\}\),\(0,Q\.jsx\)\(([A-Za-z_$][\w$]*),\{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0\}\)/;
  const shouldWarnAboutMissingFooterHelper =
    currentSource.includes("function TF(e)") ||
    currentSource.includes("function Cz(e)") ||
    currentSource.includes("children:[Ut,Wt,Gt]") ||
    currentSource.includes("(0,Q.jsx)(nz,{conversationId:f,hostId:C,cwdOverride:w})") ||
    currentPermissionsControlsNeedle.test(currentSource) ||
    (currentSource.includes(currentComposerStatusNeedle) &&
      currentSource.includes(currentComposerFooterCallNeedle));
  const homeFooterGroupNeedle =
    "t[131]!==Ut||t[132]!==Wt||t[133]!==Gt?(Kt=(0,Q.jsxs)(`div`,{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:[Ut,Wt,Gt]}),t[131]=Ut,t[132]=Wt,t[133]=Gt,t[134]=Kt):Kt=t[134]";
  const previousHomeOnlyCall =
    "w===`home`?(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:z}):null";
  const previousUnguardedHomeGroupCall =
    "children:[Ut,(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:z}),Wt,Gt]";
  const previousBrokenCurrentCallNeedle =
    "(0,Q.jsx)(codexLinuxRateLimitFooter,{rateLimitEntries:";
  const homeFooterConversationIdVar = detectComposerFooterConversationIdVar(
    currentSource,
    [
      homeFooterGroupNeedle,
      previousHomeOnlyCall,
      previousUnguardedHomeGroupCall,
      previousBrokenCurrentCallNeedle,
    ],
  );
  const homeFooterCall = homeFooterConversationIdVar == null
    ? null
    : `(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:${homeFooterConversationIdVar}})`;

  const legacyFooterFunction =
    "function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,Z.c)(22),n=ea(),{modelSettings:r}=Bi(e),i=r.model??null,{data:a=null}=li(Fn),o=Ro(a),s=Zo(a),c=Xo(Jo(o,{activeLimitName:s,selectedModel:i})).slice(0,2);c.length===0&&(c=Xo(Jo(o,{activeLimitName:s,selectedModel:null})).slice(0,2));if(c.length===0)return null;let l;t[0]!==n?(l=(0,Q.jsx)(X,{id:`composer.linuxRateLimitFooter.tooltip`,defaultMessage:`Rate limits remaining`,description:`Tooltip for compact footer rate limit status`}),t[0]=n,t[1]=l):l=t[1];let u;if(t[2]!==c){u=c.map((e,t)=>{let n=No(e.bucket.usedPercent??0);return(0,Q.jsxs)(`span`,{className:`flex items-center gap-1 whitespace-nowrap`,children:[t>0?(0,Q.jsx)(`span`,{className:`text-token-input-placeholder-foreground`,children:`/`}):null,(0,Q.jsx)(`span`,{children:(0,Q.jsx)(V_,{minutes:e.bucket.windowDurationMins,variant:`summary`})}),(0,Q.jsx)(`span`,{className:`font-medium text-token-text-primary`,children:Do(n)})]},e.key)}),t[2]=c,t[3]=u}else u=t[3];let d;t[4]!==u?(d=(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:u}),t[4]=u,t[5]=d):d=t[5];let f;return t[6]!==l||t[7]!==d?(f=(0,Q.jsx)(nc,{tooltipContent:l,children:d}),t[6]=l,t[7]=d,t[8]=f):f=t[8],f}catch(e){return null}}";
  const currentFooterFunction = currentSymbols == null
    ? null
    : `function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,Z.c)(22),{activeMode:n}=Bi(e),r=n?.settings.model??null,{data:i}=ci(${currentSymbols.accountSignalVar}),a=i===void 0?null:i,o=Ro(a),s=Zo(a),c=Xo(Jo(o,{activeLimitName:s,selectedModel:r})).slice(0,2);c.length===0&&(c=Xo(Jo(o,{activeLimitName:s,selectedModel:null})).slice(0,2));if(c.length===0)return null;let l;t[0]===Symbol.for(\`react.memo_cache_sentinel\`)?(l=(0,Q.jsx)(X,{id:\`composer.linuxRateLimitFooter.tooltip\`,defaultMessage:\`Rate limits remaining\`,description:\`Tooltip for compact footer rate limit status\`}),t[0]=l):l=t[0];let u;if(t[1]!==c){u=c.map((e,t)=>{let n=No(e.bucket.usedPercent??0);return(0,Q.jsxs)(\`span\`,{className:\`flex items-center gap-1 whitespace-nowrap\`,children:[t>0?(0,Q.jsx)(\`span\`,{className:\`text-token-input-placeholder-foreground\`,children:\`/\`}):null,(0,Q.jsx)(\`span\`,{children:(0,Q.jsx)(${currentSymbols.durationComponent},{minutes:e.bucket.windowDurationMins,variant:\`summary\`})}),(0,Q.jsx)(\`span\`,{className:\`font-medium text-token-text-primary\`,children:Do(n)})]},e.key)}),t[1]=c,t[2]=u}else u=t[2];let d;t[3]!==u?(d=(0,Q.jsx)(\`span\`,{className:\`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10\`,children:u}),t[3]=u,t[4]=d):d=t[4];let f;return t[5]!==l||t[6]!==d?(f=(0,Q.jsx)(nc,{tooltipContent:l,children:d}),t[5]=l,t[6]=d,t[7]=f):f=t[7],f}catch(e){return null}}`;

  if (!patchedSource.includes("function codexLinuxRateLimitFooter(")) {
    const legacyInsertionNeedle = "function TF(e){";
    if (currentSymbols != null && currentFooterFunction != null) {
      patchedSource = patchedSource.replace(
        currentSymbols.insertionNeedle,
        `${currentFooterFunction}${currentSymbols.insertionNeedle}`,
      );
    } else if (patchedSource.includes(currentComposerStatusNeedle)) {
      patchedSource = patchedSource.replace(
        currentComposerStatusNeedle,
        `${currentComposerFooterFunction}${currentComposerStatusNeedle}`,
      );
    } else if (patchedSource.includes(legacyInsertionNeedle)) {
      patchedSource = patchedSource.replace(
        legacyInsertionNeedle,
        `${legacyFooterFunction}${legacyInsertionNeedle}`,
      );
    }
  } else if (currentSymbols != null && currentFooterFunction != null) {
    const functionStart = patchedSource.indexOf("function codexLinuxRateLimitFooter(");
    const functionEnd = patchedSource.indexOf(currentSymbols.insertionNeedle, functionStart);
    if (functionEnd !== -1) {
      const existingFooterFunction = patchedSource.slice(functionStart, functionEnd);
      if (existingFooterFunction !== currentFooterFunction) {
        patchedSource =
          patchedSource.slice(0, functionStart) +
          currentFooterFunction +
          patchedSource.slice(functionEnd);
      }
    }
  } else {
    const legacyInsertionNeedle = "function TF(e){";
    const functionStart = patchedSource.indexOf("function codexLinuxRateLimitFooter(");
    const functionEnd = patchedSource.indexOf(legacyInsertionNeedle, functionStart);
    if (functionStart !== -1 && functionEnd !== -1) {
      const existingFooterFunction = patchedSource.slice(functionStart, functionEnd);
      if (existingFooterFunction !== legacyFooterFunction) {
        patchedSource =
          patchedSource.slice(0, functionStart) +
          legacyFooterFunction +
          patchedSource.slice(functionEnd);
      }
    }
  }

  const hasFooterFunction = patchedSource.includes("function codexLinuxRateLimitFooter(");
  if (!hasFooterFunction) {
    if (shouldWarnAboutMissingFooterHelper) {
      console.warn("WARN: Could not insert persistent rate limit footer helper — skipping composer footer limit patch");
    }
    return currentSource;
  }

  const cacheNeedle = "function TF(e){let t=(0,Z.c)(148),";
  const cachePatch = "function TF(e){let t=(0,Z.c)(149),";
  if (patchedSource.includes(cacheNeedle)) {
    patchedSource = patchedSource.replace(cacheNeedle, cachePatch);
  }

  // The upstream Kt cache only tracks Ut/Wt/Gt. Recompute this group once the
  // injected child depends on conversationId, otherwise the footer can retain
  // a stale conversationId while the other footer children stay stable.
  const homeFooterGroupPatch = homeFooterCall == null
    ? null
    : `Kt=(0,Q.jsxs)(\`div\`,{className:\`flex min-w-0 flex-1 flex-nowrap items-center gap-1\`,children:[Ut,${homeFooterCall},Wt,Gt]})`;
  if (homeFooterGroupPatch != null && patchedSource.includes(homeFooterGroupNeedle)) {
    patchedSource = patchedSource.replace(homeFooterGroupNeedle, homeFooterGroupPatch);
  }

  if (patchedSource.includes(previousHomeOnlyCall)) {
    patchedSource = patchedSource.replace(
      previousHomeOnlyCall,
      homeFooterCall ?? "null",
    );
  }

  if (patchedSource.includes(previousUnguardedHomeGroupCall)) {
    patchedSource = patchedSource.replace(
      previousUnguardedHomeGroupCall,
      `children:[Ut,${homeFooterCall ?? "null"},Wt,Gt]`,
    );
  }

  const previousBrokenCurrentCall =
    /\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{rateLimitEntries:[A-Za-z_$][\w$]*,activeLimitName:[A-Za-z_$][\w$]*,selectedModel:[A-Za-z_$][\w$]*\}\)/g;
  if (
    currentFooterFunction != null &&
    previousBrokenCurrentCall.test(patchedSource) &&
    currentSymbols != null
  ) {
    patchedSource = patchedSource.replace(
      previousBrokenCurrentCall,
      homeFooterCall ?? "null",
    );
  }
  if (patchedSource.includes(previousHomeOnlyCall)) {
    patchedSource = patchedSource.replace(
      previousHomeOnlyCall,
      homeFooterCall ?? "null",
    );
  }

  const permissionsControlsNeedle =
    "(0,Q.jsx)(nz,{conversationId:f,hostId:C,cwdOverride:w}),(0,Q.jsx)(vz,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})";
  const permissionsControlsPatch =
    "(0,Q.jsx)(nz,{conversationId:f,hostId:C,cwdOverride:w}),f==null?null:(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:f}),(0,Q.jsx)(vz,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})";
  if (patchedSource.includes(permissionsControlsNeedle)) {
    patchedSource = patchedSource.replace(permissionsControlsNeedle, permissionsControlsPatch);
  }
  if (currentPermissionsControlsNeedle.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      currentPermissionsControlsNeedle,
      "(0,Q.jsx)($1,{conversationId:f,hostId:C,cwdOverride:w}),f==null?null:(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:f}),(0,Q.jsx)($2,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})",
    );
  }

  if (
    patchedSource === currentSource &&
    !currentSource.includes("function codexLinuxRateLimitFooter(") &&
    shouldWarnAboutMissingFooterHelper
  ) {
    console.warn("WARN: Could not find persistent rate limit footer needles — skipping composer footer limit patch");
  }
  if (patchedSource.includes(currentComposerFooterCallPatch)) {
    // Already patched.
  } else if (patchedSource.includes(currentComposerFooterCallNeedle)) {
    patchedSource = patchedSource.replace(
      currentComposerFooterCallNeedle,
      currentComposerFooterCallPatch,
    );
  }

  return patchedSource;
}

function applyLinuxFastModeModelGuardPatch(currentSource) {
  const exactNeedle =
    "function m(e){return e.serviceTiers.length>0||e.additionalSpeedTiers?.includes(u)===!0}";
  const exactPatch =
    "function m(e){return(e?.serviceTiers?.length??0)>0||e?.additionalSpeedTiers?.includes(u)===!0}";
  if (currentSource.includes(exactPatch)) {
    return currentSource;
  }
  if (currentSource.includes(exactNeedle)) {
    return currentSource.replace(exactNeedle, exactPatch);
  }

  const driftedNeedle = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return \2\.serviceTiers\.length>0\|\|\2\.additionalSpeedTiers\?\.includes\(([A-Za-z_$][\w$]*)\)===!0\}/u;
  if (driftedNeedle.test(currentSource)) {
    return currentSource.replace(
      driftedNeedle,
      (match, fnName, modelVar, fastTierVar) =>
        `function ${fnName}(${modelVar}){return(${modelVar}?.serviceTiers?.length??0)>0||${modelVar}?.additionalSpeedTiers?.includes(${fastTierVar})===!0}`,
    );
  }

  if (currentSource.includes("serviceTiers.length>0") && currentSource.includes("additionalSpeedTiers")) {
    console.warn(
      "WARN: Could not find fast-mode model guard insertion point — skipping fast-mode crash guard patch",
    );
  }

  return currentSource;
}

function patchCommentPreloadBundle(extractedDir) {
  const commentPreloadBundle = path.join(extractedDir, ".vite", "build", "comment-preload.js");
  if (!fs.existsSync(commentPreloadBundle)) {
    console.warn(
      `WARN: Could not find comment preload bundle in ${path.dirname(commentPreloadBundle)} — skipping annotation screenshot patch`,
    );
    return { matched: false, changed: false };
  }

  const source = fs.readFileSync(commentPreloadBundle, "utf8");
  const patchedSource = applyBrowserAnnotationScreenshotPatch(source);
  if (patchedSource !== source) {
    fs.writeFileSync(commentPreloadBundle, patchedSource, "utf8");
    return { matched: true, changed: true };
  }
  return { matched: true, changed: false };
}

module.exports = {
  applyBrowserAnnotationScreenshotPatch,
  applyLinuxAppServerFeatureEnablementPatch,
  applyPersistentRateLimitFooterPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxFastModeModelGuardPatch,
  applySubagentNicknameMetadataPatch,
  patchCommentPreloadBundle,
};
