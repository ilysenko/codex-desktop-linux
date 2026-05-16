"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Webview asset patches target hashed browser chunks copied out of app.asar.
// They stay fail-soft because upstream chunk names and minified symbols drift.
function applyLinuxOpaqueWindowsDefaultPatch(currentSource) {
  let patchedSource = currentSource;
  let warnedMissingNeedle = false;
  const linuxDefaultPatched = () =>
    patchedSource.includes("opaqueWindows:e?.opaqueWindows??(typeof navigator<`u`&&") ||
    patchedSource.includes("navigator.userAgent.includes(`Linux`)&&") ||
    patchedSource.includes("document.documentElement.dataset.codexOs===`linux`&&");
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

  if (patchedSource.includes("opaqueWindows:e?.opaqueWindows??(typeof navigator<`u`&&")) {
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

  if (!patchedSource.includes("document.documentElement.dataset.codexOs===`linux`&&")) {
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
    const currentElementScreenshotRegex =
      /if\(([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\?\.anchor\.kind===`element`\)\{let e=[^;{}]+?\?\?null,t=e==null\?null:[A-Za-z_$][\w$]*\(e\);([A-Za-z_$][\w$]*)=t\?\.rect\?\?([A-Za-z_$][\w$]*)\(\2\.anchor\),([A-Za-z_$][\w$]*)=t\?\.borderRadius\}/;
    if (patchedSource.includes(currentSelectedElementNeedle)) {
      patchedSource = patchedSource.replace(currentSelectedElementNeedle, currentSelectedElementPatch);
    } else if (currentElementScreenshotRegex.test(patchedSource)) {
      const currentElementScreenshotMatch = patchedSource.match(currentElementScreenshotRegex);
      const [, screenshotModeVar, selectedCommentVar, rectVar, anchorRectFn, radiusVar] = currentElementScreenshotMatch;
      patchedSource = patchedSource.replace(
        currentElementScreenshotRegex,
        `if(${screenshotModeVar}&&${selectedCommentVar}?.anchor.kind===\`element\`){${rectVar}=${anchorRectFn}(${selectedCommentVar}.anchor),${radiusVar}=void 0}`,
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
    if (patchedSource.includes(currentMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(currentSelectedMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(currentMarkersNeedle)) {
      patchedSource = patchedSource.replace(currentMarkersNeedle, currentMarkersPatch);
    } else if (patchedSource.includes(currentSelectedMarkersNeedle)) {
      patchedSource = patchedSource.replace(currentSelectedMarkersNeedle, currentSelectedMarkersPatch);
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
    if (
      currentSource.includes("composer-footer flex flex-nowrap") ||
      currentSource.includes("function Cz(e)") ||
      currentSource.includes("children:[Ut,Wt,Gt]") ||
      currentSource.includes("(0,Q.jsx)(nz,{conversationId:f,hostId:C,cwdOverride:w})")
    ) {
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
  const currentPermissionsControlsNeedle =
    /\(0,Q\.jsx\)\(([A-Za-z_$][\w$]*),\{conversationId:f,hostId:C,cwdOverride:w\}\),\(0,Q\.jsx\)\(([A-Za-z_$][\w$]*),\{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0\}\)/;
  if (currentPermissionsControlsNeedle.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      currentPermissionsControlsNeedle,
      "(0,Q.jsx)($1,{conversationId:f,hostId:C,cwdOverride:w}),f==null?null:(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:f}),(0,Q.jsx)($2,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})",
    );
  }

  if (
    patchedSource === currentSource &&
    !currentSource.includes("function codexLinuxRateLimitFooter(") &&
    (currentSource.includes("composer-footer flex flex-nowrap") ||
      currentSource.includes("function TF(e)") ||
      currentSource.includes("function Cz(e)"))
  ) {
    console.warn("WARN: Could not find persistent rate limit footer needles — skipping composer footer limit patch");
  }

  return patchedSource;
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
  applyPersistentRateLimitFooterPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  patchCommentPreloadBundle,
};
