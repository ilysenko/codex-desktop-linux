"use strict";

function applyBrowserSidebarAvailabilityPatch(currentSource) {
  let patchedSource = currentSource;

  // 1. Force the Statsig Gate check (1714131075) to return true
  const statsigRegex = /d=r\(i,\(\{get:e\}\)=>e\(o,`1714131075`\)&&y\(\)\)/;
  if (patchedSource.includes("d=r(i,()=>!0)")) {
    // Already patched
  } else if (statsigRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(statsigRegex, "d=r(i,()=>!0)");
  } else {
    console.warn("WARN: Could not find Statsig gate check in availability bundle");
  }

  // 2. Force the Experimental Features check (in_app_browser) to return true
  const experimentalRegex = /u=r\(i,\(\{get:e\}\)=>\{let\{data:n\}=e\(s,e\(t\)\),r=n\?\.find\(e=>e\.name===c\);return n!=null&&r\?\.enabled!==!1\}\)/;
  if (patchedSource.includes("u=r(i,()=>!0)")) {
    // Already patched
  } else if (experimentalRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(experimentalRegex, "u=r(i,()=>!0)");
  } else {
    console.warn("WARN: Could not find Experimental Features check in availability bundle");
  }

  return patchedSource;
}

module.exports = {
  descriptors: [
    {
      id: "browser-sidebar-availability",
      name: "browser-sidebar-availability",
      phase: "webview-asset",
      pattern: /^browser-sidebar-availability-.*\.js$/,
      missingDescription: "browser sidebar availability bundle",
      skipDescription: "Browser sidebar availability patch",
      apply: applyBrowserSidebarAvailabilityPatch,
    }
  ],
  applyBrowserSidebarAvailabilityPatch
};
