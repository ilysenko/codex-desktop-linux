"use strict";

function hasChromePluginLiteral(source) {
  return /(?:`chrome`|"chrome"|'chrome')/.test(source);
}

function isChromeNameExpr(nameExpr, chromeNameVar) {
  return /^(?:`chrome`|"chrome"|'chrome')$/.test(nameExpr) ||
    nameExpr === chromeNameVar;
}

function hasChromeAutoInstall(source, chromeNameVar) {
  const namePatterns = [String.raw`\`chrome\``, "\"chrome\"", "'chrome'"];
  if (chromeNameVar != null) {
    namePatterns.push(chromeNameVar);
  }
  return new RegExp(String.raw`installWhenMissing:!0,name:(?:${namePatterns.join("|")})`).test(source);
}

function applyNearbyChromeGateFallback(currentSource, chromeNameVar, nameExpressionPattern) {
  const nameAvailabilityRegex =
    new RegExp(String.raw`name:(${nameExpressionPattern}),((?:isEnabled|isAvailable):)`, "g");

  let patched = "";
  let lastIndex = 0;
  let didPatch = false;

  for (const match of currentSource.matchAll(nameAvailabilityRegex)) {
    const [matchText, nameExpr, availabilityPrefix] = match;
    const matchIndex = match.index;
    if (matchIndex == null || !isChromeNameExpr(nameExpr, chromeNameVar)) {
      continue;
    }

    const before = currentSource.slice(Math.max(0, matchIndex - 300), matchIndex);
    const after = currentSource.slice(matchIndex, Math.min(currentSource.length, matchIndex + 900));
    if (
      before.includes("installWhenMissing:!0") ||
      !after.includes("externalBrowserUseAllowed")
    ) {
      continue;
    }

    patched += currentSource.slice(lastIndex, matchIndex);
    patched += `installWhenMissing:!0,name:${nameExpr},${availabilityPrefix}`;
    lastIndex = matchIndex + matchText.length;
    didPatch = true;
  }

  if (!didPatch) {
    return currentSource;
  }

  return patched + currentSource.slice(lastIndex);
}

function applyLinuxChromePluginAutoInstallPatch(currentSource) {
  if (!hasChromePluginLiteral(currentSource)) {
    console.warn(
      "WARN: Could not find Chrome plugin gate literal — skipping Linux Chrome plugin auto-install patch",
    );
    return currentSource;
  }

  const chromeNameVar = currentSource.match(/([A-Za-z_$][\w$]*)=(?:`chrome`|"chrome"|'chrome')/)?.[1] ?? null;
  const nameExpressionPattern = String.raw`(?:[A-Za-z_$][\w$]*|` +
    String.raw`\`chrome\`|"chrome"|'chrome')`;
  const gateRegex =
    new RegExp(String.raw`\{([^{}]*?)(installWhenMissing:!0,)?name:(${nameExpressionPattern}),(isEnabled|isAvailable):\(\{([^}]*)\}\)=>([^{}]*?externalBrowserUseAllowed[^{}]*?)(,migrate:[A-Za-z_$][\w$]*)?\}`, "g");

  let sawChromeGate = false;
  let sawAlreadyInstalledGate = false;
  const patched = currentSource.replace(
    gateRegex,
    (gateSource, prefix, installWhenMissing, nameExpr, availabilityProp, paramsText, expression, migrateSuffix = "") => {
      if (!isChromeNameExpr(nameExpr, chromeNameVar)) {
        return gateSource;
      }

      sawChromeGate = true;
      if (installWhenMissing != null || prefix.includes("installWhenMissing:!0")) {
        sawAlreadyInstalledGate = true;
        return gateSource;
      }

      return `{${prefix}installWhenMissing:!0,name:${nameExpr},${availabilityProp}:({${paramsText}})=>${expression}${migrateSuffix}}`;
    },
  );

  if (patched !== currentSource || (sawChromeGate && sawAlreadyInstalledGate)) {
    return patched;
  }

  if (hasChromeAutoInstall(currentSource, chromeNameVar)) {
    return currentSource;
  }

  const fallbackPatched = applyNearbyChromeGateFallback(
    currentSource,
    chromeNameVar,
    nameExpressionPattern,
  );
  if (fallbackPatched !== currentSource) {
    return fallbackPatched;
  }

  return currentSource;
}

module.exports = {
  applyLinuxChromePluginAutoInstallPatch,
};
