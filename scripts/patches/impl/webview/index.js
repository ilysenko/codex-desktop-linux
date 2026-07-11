"use strict";

const { recordStrategy } = require("../../strategy-telemetry.js");

const fs = require("node:fs");
const path = require("node:path");

const {
  escapeRegExp,
  findMatchingBrace,
} = require("../../lib/minified-js.js");

// Webview asset patches target hashed browser chunks copied out of app.asar.
// They stay fail-soft because upstream chunk names and minified symbols drift.
const LINUX_SAFE_MONOSPACE_FONT_STACK =
  "\"Noto Sans Mono\", \"DejaVu Sans Mono\", \"Liberation Mono\", \"Ubuntu Mono\", ui-monospace, \"SFMono-Regular\", \"SF Mono\", Menlo, Consolas, monospace";
const LINUX_TOOLTIP_COLLISION_PADDING_TOP = 44;
const LINUX_WINDOW_CONTROLS_SAFE_AREA_RIGHT = 138;

function applyLinuxSafeMonospaceFontStackPatch(currentSource) {
  const safeLinuxMonoFontPattern =
    /`[^`]*(?:Noto Sans Mono|DejaVu Sans Mono|Liberation Mono|Ubuntu Mono)[^`]*monospace[^`]*`/u;
  if (safeLinuxMonoFontPattern.test(currentSource)) {
    return currentSource;
  }

  const unsafeDefaultStack = "`ui-monospace, \"SFMono-Regular\", Menlo, Consolas, monospace`";
  if (currentSource.includes(unsafeDefaultStack)) {
    return currentSource.replace(
      unsafeDefaultStack,
      `\`${LINUX_SAFE_MONOSPACE_FONT_STACK}\``,
    );
  }

  if (currentSource.includes("ui-monospace") && currentSource.includes("monospace")) {
    console.warn(
      "WARN: Could not find Linux monospace font stack insertion point — skipping default font stack patch",
    );
  }

  return currentSource;
}

function applyLinuxSettingsSearchVisibilityPatch(currentSource) {
  if (currentSource.includes("function codexLinuxFilterSettingsSearchSection(")) {
    return currentSource;
  }

  let sharedSettingsImport = null;
  let featureGateImport = null;
  for (const match of currentSource.matchAll(/import\{([^}]*)\}from"[^"]+"/gu)) {
    const featureGateMatch = match[1].match(/\baG as ([A-Za-z_$][\w$]*)\b/u);
    if (featureGateMatch == null) {
      continue;
    }
    sharedSettingsImport = {
      text: match[0],
      specifiers: match[1],
    };
    featureGateImport = featureGateMatch;
    break;
  }
  const functionPattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let [A-Za-z_$][\w$]*=\(0,[A-Za-z_$][\w$]*\.c\)\(\d+\),/gu;
  let settingsSearchFunction = null;
  let match;
  while ((match = functionPattern.exec(currentSource)) != null) {
    const openBrace = currentSource.indexOf("{", match.index);
    const closeBrace = findMatchingBrace(currentSource, openBrace);
    if (closeBrace === -1) {
      continue;
    }
    const text = currentSource.slice(match.index, closeBrace + 1);
    if (
      text.includes("isSystemBackdropSupported") &&
      text.includes("?.platform===`darwin`") &&
      text.includes("sectionSlug===`appearance`") &&
      text.includes("sectionSlug===`agent`")
    ) {
      settingsSearchFunction = {
        start: match.index,
        end: closeBrace + 1,
        name: match[1],
        param: match[2],
        text,
      };
      break;
    }
  }

  const darwinVariable = settingsSearchFunction?.text.match(
    /,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.platform===`darwin`,/u,
  )?.[1];
  const resultVariable = settingsSearchFunction?.text.match(
    /return ([A-Za-z_$][\w$]*)\}$/u,
  )?.[1];
  if (
    featureGateImport == null ||
    settingsSearchFunction == null ||
    darwinVariable == null ||
    resultVariable == null
  ) {
    if (
      currentSource.includes("settingsSearchDocuments") ||
      currentSource.includes("isSystemBackdropSupported")
    ) {
      console.warn(
        "WARN: Could not find settings search visibility insertion point — skipping Linux settings search visibility patch",
      );
    }
    return currentSource;
  }

  const importAdditions = [
    "oJ as codexLinuxAccountInfoQuery",
    "y1 as codexLinuxSuggestedPromptsEligible",
    "lS as codexLinuxUseAuthSession",
  ].filter((specifier) => !sharedSettingsImport.specifiers.includes(specifier));
  const patchedImport = importAdditions.length === 0
    ? sharedSettingsImport.text
    : sharedSettingsImport.text.replace(
        sharedSettingsImport.specifiers,
        `${sharedSettingsImport.specifiers},${importAdditions.join(",")}`,
      );
  const helper =
    `var codexLinuxDarwinOnlySettingsSearchMessageIds=new Set([\`settings.general.appearance.dockIcon.chatGPT.ariaLabel\`,\`settings.general.appearance.dockIcon.codex.ariaLabel\`,\`settings.general.appearance.dockIcon.label\`,\`settings.general.appearance.dockIcon.row.description\`]);function codexLinuxSuggestedPromptsSearchEnabled(){return ${featureGateImport[1]}(\`2425897452\`)}function codexLinuxSuggestedPromptsSearchVisible(e){let t=codexLinuxSuggestedPromptsSearchEnabled(),n=codexLinuxUseAuthSession(),{authMethod:r,email:i,planAtLogin:a}=n,o=e&&t&&r===\`chatgpt\`,s={queryConfig:{enabled:o}},{data:c}=codexLinuxAccountInfoQuery(\`account-info\`,s);return e&&t&&codexLinuxSuggestedPromptsEligible({authMethod:r,email:c?.email??i,plan:c?.plan??a})}function codexLinuxFilterSettingsSearchSection(e,t,n){let r=e.messages;return e.sectionSlug===\`appearance\`&&!t&&(r=r.filter(e=>!codexLinuxDarwinOnlySettingsSearchMessageIds.has(e.id))),((e.sectionSlug===\`agent\`||e.sectionSlug===\`general-settings\`)&&!n)&&(r=r.filter(e=>!e.id.startsWith(\`settings.agent.ambientSuggestions.\`))),r===e.messages?e:{...e,messages:r}}`;
  const functionStart = `function ${settingsSearchFunction.name}(${settingsSearchFunction.param}){`;
  const functionPatch =
    `${functionStart}let codexLinuxSuggestedPromptsVisible=codexLinuxSuggestedPromptsSearchVisible(${settingsSearchFunction.param}.enabled);`;
  const returnNeedle = `return ${resultVariable}}`;
  const returnPatch =
    `return ${resultVariable}.map(e=>codexLinuxFilterSettingsSearchSection(e,${darwinVariable},codexLinuxSuggestedPromptsVisible))}`;
  const patchedFunction = settingsSearchFunction.text
    .replace(functionStart, functionPatch)
    .replace(returnNeedle, returnPatch);

  if (patchedFunction === settingsSearchFunction.text) {
    console.warn(
      "WARN: Could not find settings search visibility insertion point — skipping Linux settings search visibility patch",
    );
    return currentSource;
  }

  return `${currentSource.slice(0, settingsSearchFunction.start)}${helper}${patchedFunction}${currentSource.slice(settingsSearchFunction.end)}`.replace(
    sharedSettingsImport.text,
    patchedImport,
  );
}

function applyLinuxOpaqueWindowsDefaultPatch(currentSource) {
  if (
    /navigator\.userAgent\.includes\(`Linux`\)&&[A-Za-z_$][\w$]*\?\.opaqueWindows==null/u.test(
      currentSource,
    )
  ) {
    return currentSource;
  }

  const settingsPattern =
    /setThemePatch:([A-Za-z_$][\w$]*),theme:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=/u;
  if (settingsPattern.test(currentSource)) {
    return currentSource.replace(
      settingsPattern,
      (_match, setThemePatchVar, themeVar, hookVar, variantVar, nextVar) =>
        `setThemePatch:${setThemePatchVar},theme:${themeVar}}=${hookVar}(${variantVar});navigator.userAgent.includes(\`Linux\`)&&${themeVar}?.opaqueWindows==null&&(${themeVar}={...${themeVar},opaqueWindows:!0});let ${nextVar}=`,
    );
  }

  if (currentSource.includes("opaqueWindows") && currentSource.includes("setThemePatch")) {
    console.warn(
      "WARN: Could not find Linux opaque window default insertion point — skipping settings default patch",
    );
  }

  return currentSource;
}

function applyLinuxWindowControlsSafeAreaPatch(currentSource) {
  const currentInset = `applicationMenu:Object.freeze({left:0,right:${LINUX_WINDOW_CONTROLS_SAFE_AREA_RIGHT}})`;
  const defaultInset = "applicationMenu:Object.freeze({left:0,right:0})";
  if (currentSource.includes(defaultInset)) {
    return currentSource.split(defaultInset).join(currentInset);
  }

  if (currentSource.includes(currentInset)) {
    return currentSource;
  }

  if (currentSource.includes("applicationMenu:Object.freeze({left:0,right:")) {
    console.warn(
      "WARN: Could not find Linux window controls safe-area insertion point — skipping safe-area patch",
    );
  }

  return currentSource;
}

function applyLinuxTooltipWindowControlsCollisionPatch(currentSource) {
  const currentPadding = `padding:{top:${LINUX_TOOLTIP_COLLISION_PADDING_TOP},right:8,bottom:8,left:8}`;
  const defaultMiddleware = "middleware:[a({mainAxis:C,crossAxis:t}),c({padding:8}),l({padding:8}),u({padding:8,apply({availableWidth:e,availableHeight:t,elements:n,rects:r})";
  const patchedMiddleware =
    `middleware:[a({mainAxis:C,crossAxis:t}),c({${currentPadding}}),l({${currentPadding}}),u({${currentPadding},apply({availableWidth:e,availableHeight:t,elements:n,rects:r})`;

  let patchedSource = currentSource;
  if (patchedSource.includes(defaultMiddleware)) {
    patchedSource = patchedSource.split(defaultMiddleware).join(patchedMiddleware);
  }

  const middlewarePattern =
    /middleware:\[([A-Za-z_$][\w$]*)\(\{mainAxis:([^{}]*?),crossAxis:([^{}]*?)\}\),([A-Za-z_$][\w$]*)\(\{padding:8\}\),([A-Za-z_$][\w$]*)\(\{padding:8\}\),([A-Za-z_$][\w$]*)\(\{padding:8,apply\(\{availableWidth:([A-Za-z_$][\w$]*),availableHeight:([A-Za-z_$][\w$]*),elements:([A-Za-z_$][\w$]*),rects:([A-Za-z_$][\w$]*)\}\)/g;
  patchedSource = patchedSource.replace(
    middlewarePattern,
    (_match, offsetAlias, mainAxis, crossAxis, shiftAlias, flipAlias, sizeAlias, availableWidth, availableHeight, elements, rects) =>
      `middleware:[${offsetAlias}({mainAxis:${mainAxis},crossAxis:${crossAxis}}),${shiftAlias}({${currentPadding}}),${flipAlias}({${currentPadding}}),${sizeAlias}({${currentPadding},apply({availableWidth:${availableWidth},availableHeight:${availableHeight},elements:${elements},rects:${rects}})`,
  );

  if (patchedSource !== currentSource || patchedSource.includes(currentPadding)) {
    return patchedSource;
  }

  if (currentSource.includes("middleware:[") && currentSource.includes("availableWidth")) {
    console.warn(
      "WARN: Could not find tooltip collision padding insertion point — skipping Linux tooltip titlebar collision patch",
    );
  }

  return currentSource;
}

function findLocalEnvironmentActionModalFunction(currentSource) {
  const componentPattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(\d+\),\{action:([A-Za-z_$][\w$]*),[^{}]*onUpdate:([A-Za-z_$][\w$]*),workspaceRoot:([A-Za-z_$][\w$]*)\}=\2,/g;
  let match;
  while ((match = componentPattern.exec(currentSource)) != null) {
    const openBrace = currentSource.indexOf("{", match.index);
    const closeBrace = findMatchingBrace(currentSource, openBrace);
    if (closeBrace === -1) {
      continue;
    }
    const text = currentSource.slice(match.index, closeBrace + 1);
    if (
      text.includes("settings.localEnvironments.actions.add.description") &&
      text.includes("threadPage.runAction.setup.commandLabel") &&
      text.includes(`local-env-action-name-\${${match[5]}.id}`)
    ) {
      return {
        start: match.index,
        end: closeBrace + 1,
        text,
        paramVar: match[2],
        cacheVar: match[3],
        actionVar: match[5],
        updateVar: match[6],
        workspaceVar: match[7],
      };
    }
  }
  return null;
}

function applyLinuxThreadSidePanelNativeTooltipPatch(currentSource) {
  const nativeTitleNeedle = 'disabled:l,title:i,onClick:a,uniform:!0';
  const nativeTitlePatch = 'disabled:l,onClick:a,uniform:!0';

  if (!currentSource.includes("id:`thread.sidePanel.toggle`")) {
    return currentSource;
  }

  if (currentSource.includes(nativeTitlePatch) && !currentSource.includes(nativeTitleNeedle)) {
    return currentSource;
  }

  if (currentSource.includes(nativeTitleNeedle)) {
    return currentSource.split(nativeTitleNeedle).join(nativeTitlePatch);
  }

  if (currentSource.includes("tooltipContent:i") && currentSource.includes("title:i")) {
    console.warn(
      "WARN: Could not find thread side panel native tooltip insertion point — skipping Linux duplicate side panel tooltip patch",
    );
  }

  return currentSource;
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

function applyLinuxBrowserUseAvailabilityPatch(currentSource) {
  const browserUseFeatureNeedle = "featureName:`browser_use`";
  const statsigNeedle = "410262010";
  let changed = false;

  const alreadyPatched = () =>
    /featureName:`browser_use`[\s\S]{0,1400}?isBrowserAgentGateEnabled:!0,/.test(currentSource);

  const gatePattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{isBrowserAgentGateEnabled:([A-Za-z_$][\w$]*),isBrowserSidebarEnabled:([A-Za-z_$][\w$]*),isBrowserUseEnabled:([A-Za-z_$][\w$]*),isLoading:([A-Za-z_$][\w$]*),runCodexInWsl:([A-Za-z_$][\w$]*),windowType:`electron`\}\)/g;

  const patchedSource = currentSource.replace(
    gatePattern,
    (
      match,
      resultVar,
      helperVar,
      gateVar,
      sidebarVar,
      browserUseVar,
      loadingVar,
      wslVar,
      offset,
    ) => {
      const contextStart = Math.max(0, offset - 1400);
      const context = currentSource.slice(contextStart, offset + match.length);
      if (!context.includes(browserUseFeatureNeedle) || !context.includes(statsigNeedle)) {
        return match;
      }

      changed = true;
      return `${resultVar}=${helperVar}({isBrowserAgentGateEnabled:!0,isBrowserSidebarEnabled:${sidebarVar},isBrowserUseEnabled:${browserUseVar},isLoading:${loadingVar},runCodexInWsl:${wslVar},windowType:\`electron\`})`;
    },
  );

  if (changed || alreadyPatched()) {
    return patchedSource;
  }

  if (currentSource.includes(browserUseFeatureNeedle) && currentSource.includes(statsigNeedle)) {
    console.warn(
      "WARN: Could not find Browser Use availability gate — skipping Linux Browser Use availability patch",
    );
  }

  return currentSource;
}

function applyLinuxBrowserUseNonLocalNavigationPatch(currentSource) {
  const messageNeedle = "browser-use-non-local-sites-allowed-changed";
  const statsigNeedle = "3903563814";
  let changed = false;

  const dispatchPattern =
    /((?:[A-Za-z_$][\w$]*=)?[A-Za-z_$][\w$]*\(`3903563814`\)[\s\S]{0,1800}?dispatchMessage\(`browser-use-non-local-sites-allowed-changed`,\{allowed:)([A-Za-z_$][\w$]*)(\}\))/g;

  const patchedSource = currentSource.replace(
    dispatchPattern,
    (match, prefix, allowedVar, suffix) => {
      changed = true;
      return `${prefix}!0${suffix}`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (currentSource.includes(`${messageNeedle}\`,{allowed:!0}`)) {
    return currentSource;
  }

  if (currentSource.includes(messageNeedle) && currentSource.includes(statsigNeedle)) {
    console.warn(
      "WARN: Could not find Browser Use non-local navigation gate — skipping Linux Browser Use navigation patch",
    );
  }

  return currentSource;
}

function applyLinuxChatSearchHydrationPatch(currentSource) {
  if (currentSource.includes("function codexLinuxHydrateSearchConversation(")) {
    return currentSource;
  }

  if (!currentSource.includes("search-threads-for-host")) {
    return currentSource;
  }

  let patchedSource = currentSource;
  const requestAliasMatch = patchedSource.match(
    /([A-Za-z_$][\w$]*)\(`search-threads-for-host`,\{hostId:[A-Za-z_$][\w$]*,query:/u,
  );
  const requestAlias = requestAliasMatch?.[1] ?? null;

  const asyncSearchNeedle =
    /([A-Za-z_$][\w$]*)\.map\(([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\(`search-threads-for-host`,\{hostId:\2,query:([A-Za-z_$][\w$]*),limit:([A-Za-z_$][\w$]*)\}\)\)/u;
  patchedSource = patchedSource.replace(
    asyncSearchNeedle,
    (_match, hostsVar, hostVar, requestVar, queryVar, limitVar) =>
      `${hostsVar}.map(${hostVar}=>${requestVar}(\`search-threads-for-host\`,{hostId:${hostVar},query:${queryVar},limit:${limitVar}}).then(codexLinuxSearchResults=>codexLinuxSearchResults.map(codexLinuxSearchResult=>({...codexLinuxSearchResult,hostId:${hostVar}}))))`,
  );

  patchedSource = patchedSource.replace(
    /return\[\{kind:`local`,threadKey:/g,
    "return[{kind:`local`,hostId:e.hostId??`local`,threadKey:",
  );
  patchedSource = patchedSource.replace(
    /return\{kind:`local`,threadKey:/g,
    "return{kind:`local`,hostId:e.hostId??`local`,threadKey:",
  );

  patchedSource = patchedSource.replace(
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return \2\.threadKey\}function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return \4\.threadKey\}/u,
    "function $1($2){return $2}function $3($4){return $4}",
  );

  let patchedResultSelectCache = false;
  const resultSelectCachePattern =
    /(?<cache>[A-Za-z_$][\w$]*)\[(?<closeSlot>\d+)\]!==(?<close>[A-Za-z_$][\w$]*)\|\|\k<cache>\[(?<routeSlot>\d+)\]!==(?<route>[A-Za-z_$][\w$]*)\|\|\k<cache>\[(?<localSlot>\d+)\]!==(?<local>[A-Za-z_$][\w$]*)\|\|\k<cache>\[(?<resultSlot>\d+)\]!==(?<result>[A-Za-z_$][\w$]*)\.threadKey\?\((?<callback>[A-Za-z_$][\w$]*)=\(\)=>\{(?<select>[A-Za-z_$][\w$]*)\(\k<result>\.threadKey,\k<local>,\k<route>\),\k<close>\(\)\},\k<cache>\[\k<closeSlot>\]=\k<close>,\k<cache>\[\k<routeSlot>\]=\k<route>,\k<cache>\[\k<localSlot>\]=\k<local>,\k<cache>\[\k<resultSlot>\]=\k<result>\.threadKey,\k<cache>\[(?<callbackSlot>\d+)\]=\k<callback>\):\k<callback>=\k<cache>\[\k<callbackSlot>\]/u;
  patchedSource = patchedSource.replace(
    resultSelectCachePattern,
    (...args) => {
      const {
        cache: cacheVar,
        closeSlot,
        close: closeVar,
        routeSlot,
        route: routeVar,
        localSlot,
        local: localVar,
        resultSlot,
        result: resultVar,
        callbackSlot,
        callback: callbackVar,
        select: selectFn,
      } = args[args.length - 1];
      patchedResultSelectCache = true;
      return `${cacheVar}[${closeSlot}]!==${closeVar}||${cacheVar}[${routeSlot}]!==${routeVar}||${cacheVar}[${localSlot}]!==${localVar}||${cacheVar}[${resultSlot}]!==${resultVar}?(${callbackVar}=()=>{${selectFn}(${resultVar},${localVar},${routeVar}),${closeVar}()},${cacheVar}[${closeSlot}]=${closeVar},${cacheVar}[${routeSlot}]=${routeVar},${cacheVar}[${localSlot}]=${localVar},${cacheVar}[${resultSlot}]=${resultVar},${cacheVar}[${callbackSlot}]=${callbackVar}):${callbackVar}=${cacheVar}[${callbackSlot}]`;
    },
  );
  if (!patchedResultSelectCache) {
    if (requestAlias != null) {
      const currentRoutePattern =
        /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{switch\(\2\.kind\)\{case`local`:case`remote`:([A-Za-z_$][\w$]*)\(\2\.threadKey,\3,\4\);return;case`chatgpt`:return\}\}/u;
      if (currentRoutePattern.test(patchedSource)) {
        return patchedSource.replace(
          currentRoutePattern,
          (_match, routeFn, resultVar, localNavigateArg, routeNavigateArg, modeArg, navigateFn) => {
            const helper = `function codexLinuxHydrateSearchConversation(e,t){try{if(e==null||typeof e!==\`object\`||e.kind!==\`local\`)return Promise.resolve();let n=e.hostId??\`local\`,r=${requestAlias}(\`load-recent-conversation-ids-for-host\`,{hostId:n,conversationIds:[t]}),i=new Promise(e=>globalThis.setTimeout(e,1500));return Promise.race([r,i]).catch(()=>{})}catch{return Promise.resolve()}}`;
            return `${helper}async function ${routeFn}(${resultVar},${localNavigateArg},${routeNavigateArg},${modeArg}){switch(${resultVar}.kind){case\`local\`:await codexLinuxHydrateSearchConversation(${resultVar},${resultVar}.threadKey);${navigateFn}(${resultVar}.threadKey,${localNavigateArg},${routeNavigateArg});return;case\`remote\`:${navigateFn}(${resultVar}.threadKey,${localNavigateArg},${routeNavigateArg});return;case\`chatgpt\`:return}}`;
          },
        );
      }
    }
    console.warn(
      "WARN: Could not find chat search result selection cache — skipping Linux chat search hydration patch",
    );
    return currentSource;
  }

  if (requestAlias == null) {
    if (patchedSource !== currentSource) {
      console.warn(
        "WARN: Could not find chat search request helper — skipping Linux chat search hydration patch",
      );
      return currentSource;
    }
    return currentSource;
  }

  const routePattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\);if\(\5!=null\)\{\3\(\5\);return\}\4\(([A-Za-z_$][\w$]*)\(\2\)\)\}/u;
  const routeMatch = patchedSource.match(routePattern);
  if (routeMatch == null) {
    if (
      currentSource.includes("search-threads-for-host") &&
      currentSource.includes("threadKey")
    ) {
      console.warn(
        "WARN: Could not find chat search route handler — skipping Linux chat search hydration patch",
      );
    }
    return currentSource;
  }

  const [
    routeNeedle,
    routeFn,
    targetArg,
    localNavigateArg,
    routeNavigateArg,
    conversationVar,
    localThreadKeyFn,
    routeThreadKeyFn,
  ] = routeMatch;
  const helper = `function codexLinuxSearchThreadKey(e){return e&&typeof e===\`object\`?e.threadKey:e}function codexLinuxHydrateSearchConversation(e,t){try{if(e==null||typeof e!==\`object\`||e.kind!==\`local\`)return Promise.resolve();let n=e.hostId??\`local\`,r=${requestAlias}(\`load-recent-conversation-ids-for-host\`,{hostId:n,conversationIds:[t]}),i=new Promise(e=>globalThis.setTimeout(e,1500));return Promise.race([r,i]).catch(()=>{})}catch{return Promise.resolve()}}`;
  const routePatch =
    `${helper}async function ${routeFn}(${targetArg},${localNavigateArg},${routeNavigateArg}){let codexLinuxRouteKey=codexLinuxSearchThreadKey(${targetArg}),${conversationVar}=${localThreadKeyFn}(codexLinuxRouteKey);if(${conversationVar}!=null){await codexLinuxHydrateSearchConversation(${targetArg},${conversationVar});${localNavigateArg}(${conversationVar});return}${routeNavigateArg}(${routeThreadKeyFn}(codexLinuxRouteKey))}`;
  patchedSource = patchedSource.replace(routeNeedle, routePatch);

  return patchedSource;
}

function applyLinuxBrowserUseExternalAvailabilityPatch(currentSource) {
  const externalFeatureNeedle = "featureName:`browser_use_external`";
  const statsigNeedle = "410065390";
  let changed = false;

  const alreadyPatched = () =>
    /featureName:`browser_use_external`[\s\S]{0,900}?navigator\.userAgent\.includes\(`Linux`\)/.test(currentSource);

  const availabilityPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`chrome-extension`\|\|([A-Za-z_$][\w$]*)&&\1\.enabled&&!\1\.isLoading,([A-Za-z_$][\w$]*)=\5===`chrome-extension`\?!1:\1\.isLoading,/g;

  let patchedSource = currentSource.replace(
    availabilityPattern,
    (
      match,
      featureQueryVar,
      featureQueryFn,
      featureQueryArg,
      availableVar,
      windowTypeVar,
      statsigVar,
      loadingVar,
      offset,
    ) => {
      const contextStart = Math.max(0, offset - 700);
      const context = currentSource.slice(contextStart, offset + match.length);
      if (!context.includes(externalFeatureNeedle) || !context.includes(statsigNeedle)) {
        return match;
      }

      changed = true;
      return `let ${featureQueryVar}=${featureQueryFn}(${featureQueryArg}),${availableVar}=${windowTypeVar}===\`chrome-extension\`||navigator.userAgent.includes(\`Linux\`)||${statsigVar}&&${featureQueryVar}.enabled&&!${featureQueryVar}.isLoading,${loadingVar}=${windowTypeVar}===\`chrome-extension\`||navigator.userAgent.includes(\`Linux\`)?!1:${featureQueryVar}.isLoading,`;
    },
  );

  if (!changed) {
    // 26.623 refactored the inline availability gate into a status-string helper:
    //   function X({isExternalBrowserUseFeatureEnabled:e,isExternalBrowserUseFeatureLoading:t,
    //     isExternalBrowserUseGateEnabled:n,windowType:r}){return r===`chrome-extension`?`available`:...}
    // Treat Linux like chrome-extension so the resolved status is `available`.
    const statusFnPattern =
      /(function [A-Za-z_$][\w$]*\(\{isExternalBrowserUseFeatureEnabled:[A-Za-z_$][\w$]*,isExternalBrowserUseFeatureLoading:[A-Za-z_$][\w$]*,isExternalBrowserUseGateEnabled:[A-Za-z_$][\w$]*,windowType:([A-Za-z_$][\w$]*)\}\)\{return )\2===`chrome-extension`\?`available`:/;
    patchedSource = patchedSource.replace(
      statusFnPattern,
      (match, prefix, windowTypeVar) => {
        changed = true;
        return `${prefix}${windowTypeVar}===\`chrome-extension\`||navigator.userAgent.includes(\`Linux\`)?\`available\`:`;
      },
    );
  }

  if (changed || alreadyPatched()) {
    return patchedSource;
  }

  if (currentSource.includes(externalFeatureNeedle) && currentSource.includes(statsigNeedle)) {
    console.warn(
      "WARN: Could not find Browser Use external availability gate — skipping Linux external Browser Use availability patch",
    );
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
    "remote_plugin",
    "tool_call_mcp_elicitation",
    "tool_search",
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

  function sanitizeFeatureArrayItems(featureArrayItems) {
    return featureArrayItems
      .split(",")
      .filter((entry) => {
        const featureMatch = entry.trim().match(/^`([^`]+)`$/u);
        return featureMatch != null && supportedFeatures.has(featureMatch[1]);
      })
      .join(",");
  }

  function sanitizeFeatureArrayDeclaration(source, arrayVar) {
    const arrayDeclarationRegex = new RegExp(
      `(^|[^\\w$])((?:var\\s+)?${escapeRegExp(arrayVar)}=\\[)([^\\]]*?)(\\])`,
      "u",
    );
    const match = source.match(arrayDeclarationRegex);
    if (match == null) {
      return source;
    }
    const [, boundary, prefix, featureArrayItems, suffix] = match;
    const supportedFeatureArrayItems = sanitizeFeatureArrayItems(featureArrayItems);
    if (supportedFeatureArrayItems === featureArrayItems) {
      return source;
    }
    return source.replace(
      arrayDeclarationRegex,
      `${boundary}${prefix}${supportedFeatureArrayItems}${suffix}`,
    );
  }

  const featureArrayRegex =
    /var ([A-Za-z_$][\w$]*)=\[([^\]]*?)\];function ([A-Za-z_$][\w$]*)\(\)\{let [\s\S]{0,2400}?statsig_default_enable_features[\s\S]{0,2400}?set-experimental-feature-enablement-for-host/u;
  const featureArrayMatch = currentSource.match(featureArrayRegex);

  if (featureArrayMatch == null) {
    // 26.527.x replaced the static default-enable array with a dynamic builder
    // that copies supported defaults, then adds a gated extra. The copied
    // defaults are Linux-safe; the trailing extra is not.
    const dynamicBuilderExtraRegex =
      /(for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\[\2\];\4!=null&&\(([A-Za-z_$][\w$]*)\[\2\]=\4\)\})return \5\[([A-Za-z_$][\w$]*)\]=([A-Za-z_$][\w$]*),\5\}/u;
    const dynamicBuilderExtraMatch = currentSource.match(dynamicBuilderExtraRegex);
    if (dynamicBuilderExtraMatch != null) {
      const [, loopBlock, , arrayVar, , enablementVar, featureKeyVar] = dynamicBuilderExtraMatch;
      const featureKeyDeclaration = new RegExp(
        `${escapeRegExp(featureKeyVar)}=\`remote_plugin\``,
        "u",
      );
      const arraySanitizedSource = sanitizeFeatureArrayDeclaration(currentSource, arrayVar);
      if (featureKeyDeclaration.test(currentSource)) {
        return arraySanitizedSource;
      }
      return arraySanitizedSource.replace(
        dynamicBuilderExtraRegex,
        `${loopBlock}return ${enablementVar}}`,
      );
    }

    const dynamicBuilderSanitizedRegex =
      /for\(let ([A-Za-z_$][\w$]*) of [A-Za-z_$][\w$]*\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\[\1\];\2!=null&&\(([A-Za-z_$][\w$]*)\[\1\]=\2\)\}return \3\}/u;
    if (dynamicBuilderSanitizedRegex.test(currentSource)) {
      return currentSource;
    }

    console.warn(
      "WARN: Could not find app-server feature enablement list — skipping unsupported feature compatibility patch",
    );
    return currentSource;
  }

  const [, arrayVar, featureArrayItems] = featureArrayMatch;
  const supportedFeatureArrayItems = sanitizeFeatureArrayItems(featureArrayItems);
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

function applyAutomationUpdateEagerToolPatch(currentSource) {
  const markerPattern =
    /[A-Za-z_$][\w$]*\.name===`automation_update`&&delete [A-Za-z_$][\w$]*\.deferLoading/u;
  if (markerPattern.test(currentSource)) {
    return currentSource;
  }

  const dynamicToolsPattern =
    /\.map\(([A-Za-z_$][\w$]*)=>\(\{type:`function`,\.\.\.\1,\.\.\.([A-Za-z_$][\w$]*)\.has\(\1\.name\)\?\{\}:\{deferLoading:!0\}\}\)\)/u;
  if (!dynamicToolsPattern.test(currentSource)) {
    if (currentSource.includes("automation_update") && currentSource.includes("deferLoading:!0")) {
      console.warn(
        "WARN: Could not find dynamic tools construction point — skipping automation_update eager tool patch",
      );
    }
    return currentSource;
  }

  return currentSource.replace(
    dynamicToolsPattern,
    (_match, toolVar, eagerToolsVar) => {
      const descriptorVar = toolVar === "t" ? "codexLinuxAutomationDescriptor" : "t";
      return `.map(${toolVar}=>{let ${descriptorVar}={type:\`function\`,...${toolVar},...${eagerToolsVar}.has(${toolVar}.name)?{}:{deferLoading:!0}};return ${toolVar}.name===\`automation_update\`&&delete ${descriptorVar}.deferLoading,${descriptorVar}})`;
    },
  );
}

function applyLinuxAppServerBackfillWaitPatch(currentSource) {
  const helperSource =
    "function codexLinuxIsStateDbBackfillMessage(e){return typeof e===`string`&&e.toLowerCase().includes(`state db backfill is running`)}" +
    "function codexLinuxStateDbBackfillMessage(e){return`Codex state database backfill is still running; waiting up to 5 minutes before surfacing a startup error. ${e}`}" +
    "function codexLinuxAppServerBackfillTimeoutMs(e,t){return t===3e4&&(e===`thread/start`||e===`config/read`||e===`account/read`)?3e5:t}";
  const parserNeedle =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{if\(\2\.startsWith\(`Parse Error`\)\)return\{code:`restart-required`\};/;
  const parserPatchedRegex =
    /codexLinuxIsStateDbBackfillMessage\([A-Za-z_$][\w$]*\)\)return\{code:`connection-failed`/;
  const timeoutNeedle =
    /createRequest\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([^,]+),([A-Za-z_$][\w$]*)=\3\?\.timeoutMs\?\?0,/;
  const timeoutPatchedRegex =
    /(?:^|[;,])\s*[A-Za-z_$][\w$]*=codexLinuxAppServerBackfillTimeoutMs\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)/;
  const shouldPatchParser = parserNeedle.test(currentSource) || parserPatchedRegex.test(currentSource);
  const shouldPatchTimeout = timeoutNeedle.test(currentSource) || timeoutPatchedRegex.test(currentSource);
  const topLevelInsertionPointBefore = (source, index) => {
    let depth = 0;
    let state = "code";
    let insertionPoint = 0;
    for (let i = 0; i < index; i += 1) {
      const char = source[i];
      const next = source[i + 1];
      if (state === "code") {
        if (char === "/" && next === "/") {
          state = "line-comment";
          i += 1;
        } else if (char === "/" && next === "*") {
          state = "block-comment";
          i += 1;
        } else if (char === "\"" || char === "'") {
          state = char;
        } else if (char === "`") {
          state = "template";
        } else if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth = Math.max(0, depth - 1);
        } else if (char === ";" && depth === 0) {
          insertionPoint = i + 1;
        }
      } else if (state === "line-comment") {
        if (char === "\n" || char === "\r") {
          state = "code";
        }
      } else if (state === "block-comment") {
        if (char === "*" && next === "/") {
          state = "code";
          i += 1;
        }
      } else if (state === "template") {
        if (char === "\\") {
          i += 1;
        } else if (char === "`") {
          state = "code";
        }
      } else if (char === "\\") {
        i += 1;
      } else if (char === state) {
        state = "code";
      }
    }
    return insertionPoint;
  };
  let patchedSource = currentSource;
  let changed = false;

  if (!patchedSource.includes("function codexLinuxIsStateDbBackfillMessage(")) {
    // Insert helpers at module top-level so they're visible to ALL scopes.
    // The helpers must not land inside the Sentry error handler because
    // createRequest() calls them from a different scope.
    const currentTopLevelAnchors = [
      "function fi(e,t){let n=hi(t.originalException);",
    ];
    let inserted = false;
    for (const anchor of currentTopLevelAnchors) {
      const anchorIndex = patchedSource.indexOf(anchor);
      if (
        anchorIndex !== -1 &&
        patchedSource.indexOf(anchor, anchorIndex + anchor.length) === -1
      ) {
        patchedSource = patchedSource.replace(anchor, `${helperSource}${anchor}`);
        changed = true;
        inserted = true;
        break;
      }
    }
    if (!inserted && shouldPatchTimeout) {
      const timeoutMatch = patchedSource.match(timeoutNeedle);
      const classIndex = timeoutMatch?.index == null
        ? -1
        : patchedSource.lastIndexOf("=class{", timeoutMatch.index);
      if (classIndex !== -1) {
        const statementStart = topLevelInsertionPointBefore(patchedSource, classIndex);
        patchedSource =
          patchedSource.slice(0, statementStart) +
          helperSource +
          patchedSource.slice(statementStart);
        changed = true;
      }
    }
  }

  if (shouldPatchParser && !parserPatchedRegex.test(patchedSource)) {
    const parserPatched = patchedSource.replace(
      parserNeedle,
      (_match, fnName, messageVar) => {
        const helperPrefix = patchedSource.includes("function codexLinuxIsStateDbBackfillMessage(")
          ? ""
          : helperSource;
        return `${helperPrefix}function ${fnName}(${messageVar}){if(codexLinuxIsStateDbBackfillMessage(${messageVar}))return{code:\`connection-failed\`,message:codexLinuxStateDbBackfillMessage(${messageVar})};if(${messageVar}.startsWith(\`Parse Error\`))return{code:\`restart-required\`};`;
      },
    );
    if (parserPatched !== patchedSource) {
      patchedSource = parserPatched;
      changed = true;
    }
  }

  if (
    shouldPatchTimeout &&
    !timeoutPatchedRegex.test(patchedSource) &&
    patchedSource.includes("function codexLinuxAppServerBackfillTimeoutMs(")
  ) {
    const timeoutPatched = patchedSource.replace(
      timeoutNeedle,
      (_match, methodVar, paramsVar, optionsVar, requestIdVar, requestIdExpr, timeoutVar) =>
        `createRequest(${methodVar},${paramsVar},${optionsVar}){let ${requestIdVar}=${requestIdExpr},${timeoutVar}=${optionsVar}?.timeoutMs??0;${timeoutVar}=codexLinuxAppServerBackfillTimeoutMs(${methodVar},${timeoutVar});let `,
    );
    if (timeoutPatched !== patchedSource) {
      patchedSource = timeoutPatched;
      changed = true;
    }
  }

  if (
    (shouldPatchParser || shouldPatchTimeout) &&
    !patchedSource.includes("function codexLinuxIsStateDbBackfillMessage(")
  ) {
    console.warn(
      "WARN: Could not insert app-server backfill wait helper — startup backfill may still time out early",
    );
  } else if (
    (shouldPatchParser && !parserPatchedRegex.test(patchedSource)) ||
    (shouldPatchTimeout && !timeoutPatchedRegex.test(patchedSource))
  ) {
    console.warn(
      "WARN: App-server backfill wait patch applied only partially — startup backfill may still time out early",
    );
  }

  return patchedSource;
}

function applyLinuxI18nGatePatch(currentSource) {
  const alreadyPatchedI18nGateRegexes = [
    /([A-Za-z_$][\w$]*)=[^;]*?\.get\(`enable_i18n`,!1\)[^;]*;let [^;]*,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.localeOverride\),[A-Za-z_$][\w$]*=\1\|\|\2!=null/u,
    /([A-Za-z_$][\w$]*)=[^;]*?\.get\(`enable_i18n`,!0\)[^;]*,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.localeOverride\);\1=\1\|\|\2!=null;/u,
  ];
  let patchedSource = currentSource.replace(
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\?\.get\(`enable_i18n`,!1\)(?:,[^;]+?)?);let ([A-Za-z_$][\w$]*)=\1,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\?\.get\(`locale_source`,`IDE`\)),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.localeOverride\)/g,
    (
      _match,
      gateVar,
      gateExpression,
      enabledVar,
      localeSourceVar,
      localeSourceExpression,
      localeOverrideVar,
      readLocaleOverrideVar,
      settingsVar,
    ) =>
      `${gateVar}=${gateExpression};let ${localeSourceVar}=${localeSourceExpression},${localeOverrideVar}=${readLocaleOverrideVar}(${settingsVar}.localeOverride),${enabledVar}=${gateVar}||${localeOverrideVar}!=null`,
  );

  patchedSource = patchedSource.replace(
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\([^)]*\)\?\.get\(`enable_i18n`,!0\))((?:,\[[^\]]+\]=[^;]+?)),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.localeOverride\),([A-Za-z_$][\w$]*);/g,
    (
      _match,
      gateVar,
      gateExpression,
      betweenGateAndOverride,
      localeOverrideVar,
      readLocaleOverrideVar,
      settingsVar,
      nextVar,
    ) =>
      `${gateVar}=${gateExpression}${betweenGateAndOverride},${localeOverrideVar}=${readLocaleOverrideVar}(${settingsVar}.localeOverride);${gateVar}=${gateVar}||${localeOverrideVar}!=null;let ${nextVar};`,
  );

  patchedSource = patchedSource.replace(
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\([^)]*\)\?\.get\(`enable_i18n`,!0\)),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.localeOverride\);/g,
    (
      match,
      gateVar,
      gateExpression,
      localeOverrideVar,
      readLocaleOverrideVar,
      settingsVar,
      offset,
      source,
    ) => {
      const appliedMarker = `${gateVar}=${gateVar}||${localeOverrideVar}!=null;`;
      if (source.startsWith(appliedMarker, offset + match.length)) {
        return match;
      }
      return `${gateVar}=${gateExpression},${localeOverrideVar}=${readLocaleOverrideVar}(${settingsVar}.localeOverride);${appliedMarker}`;
    },
  );

  if (
    currentSource.includes("enable_i18n") &&
    patchedSource === currentSource &&
    !alreadyPatchedI18nGateRegexes.some((regex) => regex.test(currentSource))
  ) {
    console.warn("WARN: Could not find i18n gate needle — skipping Linux i18n gate patch");
  }

  return patchedSource;
}

function applyLinuxConfigWriteVersionConflictPatch(currentSource) {
  if (!currentSource.includes("expectedVersion:")) {
    return currentSource;
  }

  const patchedSource = currentSource.replace(
    /expectedVersion:(?:[A-Za-z_$][\w$]*\?\.[^,{}]+|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?:\?\?null)?/g,
    "expectedVersion:null",
  );

  if (patchedSource !== currentSource) {
    return patchedSource;
  }

  if (
    currentSource.includes("expectedVersion:") &&
    !currentSource.includes("expectedVersion:null")
  ) {
    console.warn(
      "WARN: Could not find config write expectedVersion needle — skipping config version-conflict patch",
    );
  }

  return currentSource;
}

function applySubagentNicknameMetadataPatch(currentSource) {
  let patchedSource = currentSource;
  const sourceShapePatchedRegex =
    /`subAgent`in ([A-Za-z_$][\w$]*)\?\1\.subAgent:`subagent`in \1\?\1\.subagent:null/u;
  const nicknamePatchedRegex =
    /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.agentNickname\)\?\?\1\(\2\.agent_nickname\)\?\?\1\([A-Za-z_$][\w$]*\(\2\.source\)\?\.agentNickname\)/u;

  const sourceShapeNeedle =
    "function Mi(e){return`subAgent`in e?e.subAgent:null}function Ni(e){return typeof e==`string`?Pi():`thread_spawn`in e?{parentThreadId:j(e.thread_spawn.parent_thread_id),depth:e.thread_spawn.depth,agentNickname:e.thread_spawn.agent_nickname,agentRole:e.thread_spawn.agent_role}:Pi()}";
  const sourceShapePatch =
    "function Mi(e){return`subAgent`in e?e.subAgent:`subagent`in e?e.subagent:null}function Ni(e){return typeof e==`string`?Pi():`thread_spawn`in e?{parentThreadId:j(e.thread_spawn.parent_thread_id),depth:e.thread_spawn.depth,agentNickname:e.thread_spawn.agent_nickname,agentRole:e.thread_spawn.agent_role}:Pi()}";
  if (sourceShapePatchedRegex.test(patchedSource)) {
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
  if (nicknamePatchedRegex.test(patchedSource)) {
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
    !(sourceShapePatchedRegex.test(currentSource) && nicknamePatchedRegex.test(currentSource)) &&
    // `thread_spawn` uniquely marks the subagent metadata module. Other webview
    // chunks reference `agentNickname` without carrying these needles, so gate
    // the warning on `thread_spawn` to avoid false drift alarms when the patch
    // pattern matches the shared bundle alongside unrelated chunks.
    currentSource.includes("thread_spawn")
  ) {
    console.warn("WARN: Could not find subagent nickname metadata needles — skipping metadata shape patch");
  }

  return patchedSource;
}

function applyLocalEnvironmentActionModalDraftPatch(currentSource) {
  if (currentSource.includes("codexLinuxActionDraft")) {
    return currentSource;
  }

  if (
    !currentSource.includes("settings.localEnvironments.actions.add.description") ||
    !currentSource.includes("threadPage.runAction.setup.commandLabel") ||
    !currentSource.includes("onUpdate:")
  ) {
    return currentSource;
  }

  const modalFunction = findLocalEnvironmentActionModalFunction(currentSource);
  if (modalFunction == null) {
    console.warn(
      "WARN: Could not find local environment action modal component — skipping action input patch",
    );
    return currentSource;
  }

  const beforeFunction = currentSource.slice(0, modalFunction.start);
  const afterFunction = currentSource.slice(modalFunction.end);
  let patchedFunction = modalFunction.text;
  const reactVar =
    currentSource.match(/\(0,([A-Za-z_$][\w$]*)\.useState\)\(/)?.[1] ?? "Q";
  const { actionVar, cacheVar, paramVar, updateVar, workspaceVar } = modalFunction;
  const stateNeedle = `workspaceRoot:${workspaceVar}}=${paramVar},`;
  const statePatch =
    `workspaceRoot:${workspaceVar}}=${paramVar},[codexLinuxActionDraft,codexLinuxSetActionDraft]=(0,${reactVar}.useState)(()=>${actionVar}),codexLinuxUpdateActionDraft=codexLinuxPatch=>(codexLinuxSetActionDraft(codexLinuxDraft=>({...codexLinuxDraft,...codexLinuxPatch})),${updateVar}(codexLinuxPatch)),`;
  const memoGuardPattern = new RegExp(
    String.raw`if\(${cacheVar}\[(\d+)\]!==${actionVar}\|\|`,
  );
  const memoGuardMatch = patchedFunction.match(memoGuardPattern);
  if (memoGuardMatch == null) {
    console.warn(
      "WARN: Could not find local environment action modal modal memo guard — skipping action input patch",
    );
    return currentSource;
  }
  const memoGuardSlot = memoGuardMatch[1];
  const requiredReplacements = [
    {
      needle: stateNeedle,
      replacement: statePatch,
      description: "draft state insertion point",
    },
    {
      needle: memoGuardMatch[0],
      replacement: `if(${cacheVar}[${memoGuardSlot}]!==codexLinuxActionDraft||${cacheVar}[${memoGuardSlot}]!==${actionVar}||`,
      description: "modal memo guard",
    },
    {
      needle: `${actionVar}.icon`,
      replacement: "codexLinuxActionDraft.icon",
      description: "icon draft references",
    },
    {
      needle: `${actionVar}.name`,
      replacement: "codexLinuxActionDraft.name",
      description: "name draft references",
    },
    {
      needle: `${actionVar}.command`,
      replacement: "codexLinuxActionDraft.command",
      description: "command draft references",
    },
    {
      needle: `${updateVar}({icon:e.value})`,
      replacement: "codexLinuxUpdateActionDraft({icon:e.value})",
      description: "icon update callback",
    },
    {
      needle: `${updateVar}({name:e.target.value})`,
      replacement: "codexLinuxUpdateActionDraft({name:e.target.value})",
      description: "name update callback",
    },
    {
      needle: `${updateVar}({command:e})`,
      replacement: "codexLinuxUpdateActionDraft({command:e})",
      description: "command update callback",
    },
  ];

  const savedPayloadPattern = new RegExp(
    String.raw`\{\.\.\.${actionVar},command:([A-Za-z_$][\w$]*),name:([A-Za-z_$][\w$]*)\}`,
  );
  if (!savedPayloadPattern.test(patchedFunction)) {
    console.warn(
      "WARN: Could not find local environment action modal saved action payload — skipping action input patch",
    );
    return currentSource;
  }
  patchedFunction = patchedFunction.replace(
    savedPayloadPattern,
    "{...codexLinuxActionDraft,command:$1,name:$2}",
  );

  const missingReplacement = requiredReplacements.find(
    ({ needle }) => !patchedFunction.includes(needle),
  );
  if (missingReplacement != null) {
    console.warn(
      `WARN: Could not find local environment action modal ${missingReplacement.description} — skipping action input patch`,
    );
    return currentSource;
  }

  for (const { needle, replacement } of requiredReplacements) {
    patchedFunction = patchedFunction.replaceAll(needle, replacement);
  }

  return `${beforeFunction}${patchedFunction}${afterFunction}`;
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
    /if\([A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\?\.anchor\.kind===`element`\)\{[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.anchor\),[A-Za-z_$][\w$]*=void 0\}/.test(patchedSource) ||
    /if\([A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\?\.annotation\.anchor\.kind===`element`\)\{[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.annotation\.anchor\),[A-Za-z_$][\w$]*=void 0,/.test(patchedSource)
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
  } else if (/=\([A-Za-z_$][\w$]*\?[A-Za-z_$][\w$]*\?\.kind===`comment`\?[A-Za-z_$][\w$]*\.filter\(e=>e\.id===[A-Za-z_$][\w$]*\.annotation\.id\):\[\]:[A-Za-z_$][\w$]*==null\?[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*\.filter\(e=>e\.id!==[A-Za-z_$][\w$]*\.id\)\)\.flatMap/.test(patchedSource)) {
    // Already patched with the current comment-preload selected-comment shape.
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
    const latestCommentPreloadMarkersNeedle =
      "Je=(We?N?.kind===`comment`?me:[]:qe==null?me:me.filter(e=>e.id!==qe.id)).flatMap";
    const latestCommentPreloadMarkersPatch =
      "Je=(We?N?.kind===`comment`?Ue:[]:qe==null?me:me.filter(e=>e.id!==qe.id)).flatMap";
    const currentCommentPreloadSelectedMarkersNeedle =
      "Ye=(Ge?M?.kind===`comment`?he:[]:Je==null?he:he.filter(e=>e.id!==Je.id)).flatMap";
    const currentCommentPreloadSelectedMarkersPatch =
      "Ye=(Ge?M?.kind===`comment`?We:[]:Je==null?he:he.filter(e=>e.id!==Je.id)).flatMap";
    const electron42CommentPreloadMarkersNeedle =
      "Ze=(qe?A?.kind===`comment`?ge:[]:Xe==null?ge:ge.filter(e=>e.id!==Xe.id)).flatMap";
    const electron42CommentPreloadMarkersPatch =
      "Ze=(qe?A?.kind===`comment`?Ke:[]:Xe==null?ge:ge.filter(e=>e.id!==Xe.id)).flatMap";
    // 26.623 refactored the marker-list computation into imperative form and
    // adopted the screenshot fix natively: when a comment is selected it now
    // assigns `it=rt?[j.annotation]:ye`, i.e. only the selected comment's marker
    // is shown in screenshot mode. Detect that native-safe shape so we skip the
    // patch without warning.
    const nativeCommentPreloadMarkersRegex =
      /([A-Za-z_$][\w$]*)\?\.kind===`comment`\?([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\?\[\1\.annotation\]:([A-Za-z_$][\w$]*):\3\|\|[A-Za-z_$][\w$]*\?\2=\[\]:[A-Za-z_$][\w$]*!=null&&\(\2=\4\.filter\(e=>e\.id!==[A-Za-z_$][\w$]*\.id\)\)/;
    if (patchedSource.includes(currentMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(currentSelectedMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(currentCommentPreloadMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(latestCommentPreloadMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(currentCommentPreloadSelectedMarkersPatch)) {
      // Already patched.
    } else if (patchedSource.includes(electron42CommentPreloadMarkersPatch)) {
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
    } else if (patchedSource.includes(latestCommentPreloadMarkersNeedle)) {
      patchedSource = patchedSource.replace(
        latestCommentPreloadMarkersNeedle,
        latestCommentPreloadMarkersPatch,
      );
    } else if (patchedSource.includes(currentCommentPreloadSelectedMarkersNeedle)) {
      patchedSource = patchedSource.replace(
        currentCommentPreloadSelectedMarkersNeedle,
        currentCommentPreloadSelectedMarkersPatch,
      );
    } else if (patchedSource.includes(electron42CommentPreloadMarkersNeedle)) {
      patchedSource = patchedSource.replace(
        electron42CommentPreloadMarkersNeedle,
        electron42CommentPreloadMarkersPatch,
      );
    } else if (nativeCommentPreloadMarkersRegex.test(patchedSource)) {
      // Already native: upstream now scopes screenshot markers to the selected
      // comment, so no marker patch is required for this build.
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

function detectLatestComposerFooterControls(source) {
  const candidates = [];
  for (const match of source.matchAll(
    /FooterInlineControls,\{gap:`normal`,children:\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\]\}/g,
  )) {
    candidates.push({
      index: match.index,
      firstChildVar: match[1],
      secondChildVar: match[2],
      conversationIdVar: null,
    });
  }
  for (const match of source.matchAll(
    /FooterInlineControls,\{gap:`normal`,children:\[([A-Za-z_$][\w$]*),\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:([A-Za-z_$][\w$]*)\}\),([A-Za-z_$][\w$]*)\]\}/g,
  )) {
    candidates.push({
      index: match.index,
      firstChildVar: match[1],
      secondChildVar: match[3],
      conversationIdVar: match[2],
    });
  }
  for (const match of source.matchAll(
    /FooterInlineControls,\{gap:`normal`,children:\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)==null\?null:\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:\2\}\),([A-Za-z_$][\w$]*)\]\}/g,
  )) {
    candidates.push({
      index: match.index,
      firstChildVar: match[1],
      secondChildVar: match[3],
      conversationIdVar: match[2],
    });
  }
  for (const match of source.matchAll(
    /FooterInlineControls,\{gap:`normal`,children:\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:([A-Za-z_$][\w$]*)\}\)\]\}/g,
  )) {
    candidates.push({
      index: match.index,
      firstChildVar: match[1],
      secondChildVar: match[2],
      conversationIdVar: match[3],
    });
  }

  candidates.sort((left, right) => left.index - right.index);
  for (const candidate of candidates) {
    const functionStart = source.lastIndexOf("function ", candidate.index);
    if (functionStart === -1) {
      continue;
    }
    const functionHeader = source.slice(functionStart).match(/^function ([A-Za-z_$][\w$]*)\(e\)\{/);
    if (functionHeader == null) {
      continue;
    }
    const scopePrefix = source.slice(functionStart, candidate.index);
    if (!scopePrefix.includes("addContextButton:")) {
      continue;
    }
    const conversationIdVar =
      candidate.conversationIdVar ??
      scopePrefix.match(/conversationId:([A-Za-z_$][\w$]*)/)?.[1] ??
      null;
    if (conversationIdVar == null) {
      continue;
    }

    const [, functionName] = functionHeader;
    const { firstChildVar, secondChildVar } = candidate;
    return {
      insertionNeedle: `function ${functionName}(e){`,
      conversationIdVar,
      footerControlsNeedle:
        `FooterInlineControls,{gap:\`normal\`,children:[${firstChildVar},${secondChildVar}]}`,
      footerControlsPatch:
        `FooterInlineControls,{gap:\`normal\`,children:[${firstChildVar},(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:${conversationIdVar}}),${secondChildVar}]}`,
      footerControlsAfterPermissionsPatch:
        `FooterInlineControls,{gap:\`normal\`,children:[${firstChildVar},${secondChildVar},(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:${conversationIdVar}})]}`,
    };
  }

  return null;
}

function detectLatestComposerRateLimitQuery(source) {
  const queryMatches = Array.from(
    source.matchAll(
      /\{data:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)[\s\S]{0,1800}?rateLimitStatus:\1/g,
    ),
  );
  if (queryMatches.length === 0) {
    return null;
  }

  const [, , queryHook, queryKey] = queryMatches[queryMatches.length - 1];
  return { queryHook, queryKey };
}

function removeBroadFooterInlineControlsRateLimitPatch(source) {
  return source.replace(
    /let ([A-Za-z_$][\w$]*);return \1=\(0,([A-Za-z_$][\w$]*)\.jsxs\)\(`div`,\{ref:([A-Za-z_$][\w$]*),className:([A-Za-z_$][\w$]*),children:\[([A-Za-z_$][\w$]*),\(0,\2\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:null\}\)\]\}\),\1\}/g,
    "let $1;return $1=(0,$2.jsx)(`div`,{ref:$3,className:$4,children:$5}),$1}",
  );
}

function detectCurrentPermissionsRateLimitFooterSymbols(source) {
  if (!source.includes("function Sm(e){") || !source.includes("function Rm(e){")) {
    return null;
  }

  const jsxAlias =
    source.match(/var ([A-Za-z_$][\w$]*)=Hr\(\);/)?.[1] ??
    source.match(/import\{[^}]*\bt as ([A-Za-z_$][\w$]*)\}from"\.\/jsx-runtime-[^"]+"/)?.[1] ??
    null;
  const rateLimitAliasMatch = source.match(
    /\{data:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),[\s\S]{0,2000}?([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\1\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\1\),[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\(\4,\{activeLimitName:\6,selectedModel:[A-Za-z_$][\w$]*\}\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\4,\{activeLimitName:\6,selectedModel:[A-Za-z_$][\w$]*\}\)/,
  );
  const activeModeHook = source.match(
    /\{activeMode:[A-Za-z_$][\w$]*,modes:[A-Za-z_$][\w$]*,setSelectedMode:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)/,
  )?.[1] ?? null;
  if (jsxAlias == null || rateLimitAliasMatch == null || activeModeHook == null) {
    return null;
  }

  return {
    jsxAlias,
    queryHook: rateLimitAliasMatch[2],
    queryKey: rateLimitAliasMatch[3],
    entriesFn: rateLimitAliasMatch[5],
    activeLimitFn: rateLimitAliasMatch[7],
    summaryFn: rateLimitAliasMatch[9],
    activeModeHook,
    insertionNeedle: "function Sm(e){",
  };
}

function replaceCodexLinuxRateLimitFooterFunction(source, replacement) {
  const functionStart = source.indexOf("function codexLinuxRateLimitFooter(");
  if (functionStart === -1) {
    return source;
  }

  const headerMatch = source
    .slice(functionStart)
    .match(/^function codexLinuxRateLimitFooter\([^)]*\)\{/);
  if (headerMatch == null) {
    return source;
  }
  const openBrace = functionStart + headerMatch[0].length - 1;

  const closeBrace = findMatchingBrace(source, openBrace);
  if (closeBrace === -1) {
    return source;
  }

  const existingFunction = source.slice(functionStart, closeBrace + 1);
  if (existingFunction === replacement) {
    return source;
  }

  return source.slice(0, functionStart) + replacement + source.slice(closeBrace + 1);
}

function applyPersistentRateLimitFooterPatch(currentSource) {
  let patchedSource = currentSource;
  const currentSymbols = detectCurrentRateLimitFooterSymbols(currentSource);
  const latestFooterControls = detectLatestComposerFooterControls(currentSource);
  const latestRateLimitQuery = detectLatestComposerRateLimitQuery(currentSource) ?? {
    queryHook: "f",
    queryKey: "Ae",
  };
  const currentPermissionsFooterSymbols = detectCurrentPermissionsRateLimitFooterSymbols(currentSource);
  const footerLabelClass = "composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-transparent px-2 py-1 text-xs text-token-text-secondary dark:border-white/10";
  const currentComposerStatusNeedle =
    "function zg(e){";
  const currentComposerFooterFunction =
    `function codexLinuxRateLimitFooter({conversationId:e,rateLimit:t}){try{let n=Et(),{activeMode:r}=or(e),i=r?.settings.model??null,a=sa(t),o=ta(t),s=da(a,{activeLimitName:o,selectedModel:i}),c=s.filter(kg).slice(0,2);c.length===0&&(c=da(a,{activeLimitName:o,selectedModel:null}).filter(kg).slice(0,2));if(c.length===0)return null;let l=c.map(e=>\`\${bg(e.bucket.windowDurationMins??null,n,{withColon:!1})} \${n.formatNumber(Yi(e.bucket.usedPercent??0),{maximumFractionDigits:0})}%\`).join(\` / \`);return(0,Q.jsx)(\`span\`,{className:\`${footerLabelClass}\`,children:l})}catch(e){return null}}`;
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
    latestFooterControls != null ||
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

  const currentFooterFunction = currentSymbols == null
    ? null
    : `function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,Z.c)(22),{activeMode:n}=Bi(e),r=n?.settings.model??null,{data:i}=ci(${currentSymbols.accountSignalVar}),a=i===void 0?null:i,o=Ro(a),s=Zo(a),c=Xo(Jo(o,{activeLimitName:s,selectedModel:r})).slice(0,2);c.length===0&&(c=Xo(Jo(o,{activeLimitName:s,selectedModel:null})).slice(0,2));if(c.length===0)return null;let l;t[0]===Symbol.for(\`react.memo_cache_sentinel\`)?(l=(0,Q.jsx)(X,{id:\`composer.linuxRateLimitFooter.tooltip\`,defaultMessage:\`Rate limits remaining\`,description:\`Tooltip for compact footer rate limit status\`}),t[0]=l):l=t[0];let u;if(t[1]!==c){u=c.map((e,t)=>{let n=No(e.bucket.usedPercent??0);return(0,Q.jsxs)(\`span\`,{className:\`flex items-center gap-1 whitespace-nowrap\`,children:[t>0?(0,Q.jsx)(\`span\`,{className:\`text-token-input-placeholder-foreground\`,children:\`/\`}):null,(0,Q.jsx)(\`span\`,{children:(0,Q.jsx)(${currentSymbols.durationComponent},{minutes:e.bucket.windowDurationMins,variant:\`summary\`})}),(0,Q.jsx)(\`span\`,{className:\`font-medium text-token-text-primary\`,children:Do(n)})]},e.key)}),t[1]=c,t[2]=u}else u=t[2];let d;t[3]!==u?(d=(0,Q.jsx)(\`span\`,{className:\`${footerLabelClass}\`,children:u}),t[3]=u,t[4]=d):d=t[4];let f;return t[5]!==l||t[6]!==d?(f=(0,Q.jsx)(nc,{tooltipContent:l,children:d}),t[5]=l,t[6]=d,t[7]=f):f=t[7],f}catch(e){return null}}`;
  const latestFooterFunction =
    `function codexLinuxRateLimitFooter(){try{let e=(0,$.c)(6),t=${latestRateLimitQuery.queryHook}(${latestRateLimitQuery.queryKey})?.data,n=t?.rate_limit,r=[n?.primary_window,n?.secondary_window].filter(e=>e!=null&&Number.isFinite(e.used_percent)).slice(0,2);if(r.length===0)return null;let i;if(e[0]!==r){i=r.map(e=>{let t=e.limit_window_seconds==null?null:e.limit_window_seconds/60,n=t==null?\`Rate\`:t>=1440?\`\${Math.ceil(t/1440)}d\`:t>=60?\`\${Math.ceil(t/60)}h\`:\`\${Math.ceil(t)}m\`,r=Math.max(0,100-(e.used_percent??0));return\`\${n} \${Math.round(r)}%\`}).join(\` / \`),e[0]=r,e[1]=i}else i=e[1];let a;return e[2]!==i?(a=(0,Q.jsx)(\`span\`,{className:\`${footerLabelClass}\`,children:i}),e[2]=i,e[3]=a):a=e[3],a}catch(e){return null}}`;
  const previousLatestFooterFunctionWithVisibleFallback =
    "function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,$.c)(8),{activeMode:n}=or(e),r=n?.settings.model??null,{data:i}=St(ue),a=ma(i),o=la(i),s=da(a,{activeLimitName:o,selectedModel:r}).filter(og).slice(0,2);s.length===0&&(s=da(a,{activeLimitName:o,selectedModel:null}).filter(og).slice(0,2));if(s.length===0)return(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:`Usage limits`});let c=ht(),l;if(t[0]!==s||t[1]!==c){l=s.map(e=>`${Xh(e.bucket.windowDurationMins??null,c)} ${c.formatNumber(Sa(e.bucket.usedPercent??0),{maximumFractionDigits:0})}%`).join(` / `),t[0]=s,t[1]=c,t[2]=l}else l=t[2];let u;return t[3]!==l?(u=(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:l}),t[3]=l,t[4]=u):u=t[4],u}catch(e){return null}}";
  const previousLatestFooterFunctionWithVisibleCatchFallback =
    "function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,$.c)(8),{activeMode:n}=or(e),r=n?.settings.model??null,{data:i}=St(ue),a=ma(i),o=la(i),s=da(a,{activeLimitName:o,selectedModel:r}).filter(og).slice(0,2);s.length===0&&(s=da(a,{activeLimitName:o,selectedModel:null}).filter(og).slice(0,2));if(s.length===0)return(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:`Usage limits`});let c=ht(),l;if(t[0]!==s||t[1]!==c){l=s.map(e=>`${Xh(e.bucket.windowDurationMins??null,c)} ${c.formatNumber(Sa(e.bucket.usedPercent??0),{maximumFractionDigits:0})}%`).join(` / `),t[0]=s,t[1]=c,t[2]=l}else l=t[2];let u;return t[3]!==l?(u=(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:l}),t[3]=l,t[4]=u):u=t[4],u}catch(e){return(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:`Usage limits`})}}";
  const previousLatestFooterFunctionWithModelFallback =
    "function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,$.c)(8),{activeMode:n}=or(e),r=n?.settings.model??null,{data:i}=St(ue),a=ma(i),o=la(i),s=da(a,{activeLimitName:o,selectedModel:r}).filter(og).slice(0,2);s.length===0&&(s=da(a,{activeLimitName:o,selectedModel:null}).filter(og).slice(0,2));if(s.length===0)return null;let c=ht(),l;if(t[0]!==s||t[1]!==c){l=s.map(e=>`${Xh(e.bucket.windowDurationMins??null,c)} ${c.formatNumber(Sa(e.bucket.usedPercent??0),{maximumFractionDigits:0})}%`).join(` / `),t[0]=s,t[1]=c,t[2]=l}else l=t[2];let u;return t[3]!==l?(u=(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:l}),t[3]=l,t[4]=u):u=t[4],u}catch(e){return null}}";
  const previousLatestFooterFunction =
    "function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,$.c)(8),{activeMode:n}=or(e),r=n?.settings.model??null,{data:i}=St(ue),a=ma(i),o=la(i),s=da(a,{activeLimitName:o,selectedModel:r}).filter(og).slice(0,2);if(s.length===0)return null;let c=ht(),l;if(t[0]!==s||t[1]!==c){l=s.map(e=>`${Xh(e.bucket.windowDurationMins??null,c)} ${c.formatNumber(Sa(e.bucket.usedPercent??0),{maximumFractionDigits:0})}%`).join(` / `),t[0]=s,t[1]=c,t[2]=l}else l=t[2];let u;return t[3]!==l?(u=(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:l}),t[3]=l,t[4]=u):u=t[4],u}catch(e){return null}}";
  const currentPermissionsFooterFunction = currentPermissionsFooterSymbols == null
    ? null
    : `function codexLinuxRateLimitFooter({conversationId:e}){try{let t=${currentPermissionsFooterSymbols.activeModeHook}(e)?.activeMode?.settings.model??null,{data:n}=${currentPermissionsFooterSymbols.queryHook}(${currentPermissionsFooterSymbols.queryKey}),r=${currentPermissionsFooterSymbols.entriesFn}(n),i=${currentPermissionsFooterSymbols.activeLimitFn}(n),a=${currentPermissionsFooterSymbols.summaryFn}(r,{activeLimitName:i,selectedModel:t});if(a==null)return null;let o=[];if(a.windowMinutes!=null){let e=a.windowMinutes;o.push(e>=1440?\`\${Math.ceil(e/1440)}d\`:e>=60?\`\${Math.ceil(e/60)}h\`:\`\${Math.ceil(e)}m\`)}a.remainingPercent!=null&&o.push(\`\${Math.round(a.remainingPercent)}%\`);if(o.length===0)return null;return(0,${currentPermissionsFooterSymbols.jsxAlias}.jsx)(\`span\`,{className:\`${footerLabelClass}\`,children:o.join(\` \`)})}catch(e){return null}}`;

  if (!patchedSource.includes("function codexLinuxRateLimitFooter(")) {
    if (currentPermissionsFooterSymbols != null && currentPermissionsFooterFunction != null) {
      patchedSource = patchedSource.replace(
        currentPermissionsFooterSymbols.insertionNeedle,
        `${currentPermissionsFooterFunction}${currentPermissionsFooterSymbols.insertionNeedle}`,
      );
    } else if (latestFooterControls != null) {
      recordStrategy("rate-limit-footer", "upstream-latest");
      patchedSource = patchedSource.replace(
        latestFooterControls.insertionNeedle,
        `${latestFooterFunction}${latestFooterControls.insertionNeedle}`,
      );
    } else if (currentSymbols != null && currentFooterFunction != null) {
      patchedSource = patchedSource.replace(
        currentSymbols.insertionNeedle,
        `${currentFooterFunction}${currentSymbols.insertionNeedle}`,
      );
    } else if (patchedSource.includes(currentComposerStatusNeedle)) {
      patchedSource = patchedSource.replace(
        currentComposerStatusNeedle,
        `${currentComposerFooterFunction}${currentComposerStatusNeedle}`,
      );
    }
  } else if (currentPermissionsFooterSymbols != null && currentPermissionsFooterFunction != null) {
    patchedSource = replaceCodexLinuxRateLimitFooterFunction(
      patchedSource,
      currentPermissionsFooterFunction,
    );
  } else if (currentSymbols != null && currentFooterFunction != null) {
    patchedSource = replaceCodexLinuxRateLimitFooterFunction(
      patchedSource,
      currentFooterFunction,
    );
  } else if (currentSource.includes(currentComposerStatusNeedle)) {
    patchedSource = replaceCodexLinuxRateLimitFooterFunction(
      patchedSource,
      currentComposerFooterFunction,
    );
  } else if (latestFooterControls != null) {
    patchedSource = replaceCodexLinuxRateLimitFooterFunction(
      patchedSource,
      latestFooterFunction,
    );
  }

  const hasFooterFunction = patchedSource.includes("function codexLinuxRateLimitFooter(");
  if (!hasFooterFunction) {
    if (currentSource.includes("FooterInlineControls")) {
      // Composer-shaped bundle, but the footer controls drifted from the
      // supported upstream shape.
      recordStrategy("rate-limit-footer", "none");
      console.warn("WARN: Could not insert persistent rate limit footer helper — skipping composer footer limit patch");
      return currentSource;
    }
    if (shouldWarnAboutMissingFooterHelper) {
      console.warn("WARN: Could not insert persistent rate limit footer helper — skipping composer footer limit patch");
      return currentSource;
    }
    return currentSource;
  }

  if (patchedSource.includes(previousLatestFooterFunction)) {
    patchedSource = patchedSource.replace(previousLatestFooterFunction, latestFooterFunction);
  }
  if (patchedSource.includes(previousLatestFooterFunctionWithModelFallback)) {
    patchedSource = patchedSource.replace(previousLatestFooterFunctionWithModelFallback, latestFooterFunction);
  }
  if (patchedSource.includes(previousLatestFooterFunctionWithVisibleFallback)) {
    patchedSource = patchedSource.replace(previousLatestFooterFunctionWithVisibleFallback, latestFooterFunction);
  }
  if (patchedSource.includes(previousLatestFooterFunctionWithVisibleCatchFallback)) {
    patchedSource = patchedSource.replace(previousLatestFooterFunctionWithVisibleCatchFallback, latestFooterFunction);
  }

  patchedSource = removeBroadFooterInlineControlsRateLimitPatch(patchedSource);

  patchedSource = patchedSource.replace(
    /([A-Za-z_$][\w$]*)==null\?null:\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:\1\}\)/g,
    "(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:$1})",
  );

  patchedSource = patchedSource.replace(
    /FooterInlineControls,\{gap:`normal`,children:\[([A-Za-z_$][\w$]*),\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:([A-Za-z_$][\w$]*)\}\),([A-Za-z_$][\w$]*)\]\}/g,
    "FooterInlineControls,{gap:`normal`,children:[$1,$3,(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:$2})]}",
  );

  if (
    latestFooterControls != null &&
    patchedSource.includes(latestFooterControls.footerControlsPatch)
  ) {
    patchedSource = patchedSource.replace(
      latestFooterControls.footerControlsPatch,
      latestFooterControls.footerControlsAfterPermissionsPatch,
    );
  }

  if (
    latestFooterControls != null &&
    !patchedSource.includes(`codexLinuxRateLimitFooter,{conversationId:${latestFooterControls.conversationIdVar}}`) &&
    patchedSource.includes(latestFooterControls.footerControlsNeedle)
  ) {
    patchedSource = patchedSource.replace(
      latestFooterControls.footerControlsNeedle,
      latestFooterControls.footerControlsAfterPermissionsPatch,
    );
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
    "(0,Q.jsx)(nz,{conversationId:f,hostId:C,cwdOverride:w}),(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:f}),(0,Q.jsx)(vz,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})";
  if (patchedSource.includes(permissionsControlsNeedle)) {
    patchedSource = patchedSource.replace(permissionsControlsNeedle, permissionsControlsPatch);
  }
  if (currentPermissionsControlsNeedle.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      currentPermissionsControlsNeedle,
      "(0,Q.jsx)($1,{conversationId:f,hostId:C,cwdOverride:w}),(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:f}),(0,Q.jsx)($2,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})",
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
  const tierLookupNeedle =
    /([A-Za-z_$][\w$]*)\.serviceTiers\.length\s*>\s*0\s*\|\|\s*\1\.additionalSpeedTiers(?:\?\.|\.)includes\(([^()]*)\)(?:\s*===\s*!0)?/gu;
  const patchedSource = currentSource.replace(
    tierLookupNeedle,
    (match, modelVar, fastTierExpr) =>
      `(${modelVar}?.serviceTiers?.length??0)>0||${modelVar}?.additionalSpeedTiers?.includes(${fastTierExpr})===!0`,
  );
  if (patchedSource !== currentSource) {
    return patchedSource;
  }

  if (/\bserviceTiers\.length\s*>\s*0/u.test(currentSource)) {
    console.warn(
      "WARN: Could not find fast-mode model guard insertion point — skipping fast-mode crash guard patch",
    );
  }

  return currentSource;
}

function applyLinuxSkillsListDedupePatch(currentSource) {
  if (currentSource.includes("function codexLinuxDedupeSkills(")) {
    return currentSource;
  }

  if (
    !currentSource.includes("list-skills-for-host") ||
    !currentSource.includes("function IJ(e){return e.skills}")
  ) {
    return currentSource;
  }

  const flatMapNeedle = "b=y.flatMap(IJ)";
  const flatMapPatch = "b=codexLinuxDedupeSkills(y.flatMap(IJ))";
  if (!currentSource.includes(flatMapNeedle)) {
    console.warn(
      "WARN: Could not find skills list flatten insertion point — skipping Linux skills dedupe patch",
    );
    return currentSource;
  }

  const helper =
    "function codexLinuxDedupeSkills(e){try{let t=[],n=new Set;for(let r of e??[]){if(r==null){t.push(r);continue}let e=r.path??r.id??r.privateIdentity;if(e==null){t.push(r);continue}let i=String(e);if(n.has(i))continue;n.add(i),t.push(r)}return t}catch{return e}}";
  return currentSource
    .replace(flatMapNeedle, flatMapPatch)
    .replace("function IJ(e){return e.skills}", `${helper}function IJ(e){return e.skills}`);
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
  applyLinuxAppServerBackfillWaitPatch,
  applyLinuxAppServerFeatureEnablementPatch,
  applyAutomationUpdateEagerToolPatch,
  applyLinuxChatSearchHydrationPatch,
  applyLinuxBrowserUseAvailabilityPatch,
  applyLinuxBrowserUseExternalAvailabilityPatch,
  applyLinuxBrowserUseNonLocalNavigationPatch,
  applyLinuxConfigWriteVersionConflictPatch,
  applyLinuxI18nGatePatch,
  applyPersistentRateLimitFooterPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxThreadSidePanelNativeTooltipPatch,
  applyLinuxTooltipWindowControlsCollisionPatch,
  applyLinuxWindowControlsSafeAreaPatch,
  applyLinuxSafeMonospaceFontStackPatch,
  applyLinuxSettingsSearchVisibilityPatch,
  applyLinuxFastModeModelGuardPatch,
  applyLinuxSkillsListDedupePatch,
  applyLocalEnvironmentActionModalDraftPatch,
  applySubagentNicknameMetadataPatch,
  patchCommentPreloadBundle,
};
