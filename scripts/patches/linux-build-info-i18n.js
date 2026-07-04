"use strict";

const {
  BUILD_INFO_LOCALES,
  BUILD_INFO_MESSAGES,
  LOCALE_ALIASES,
} = require("./linux-build-info-locales.js");

function normalizeBuildInfoLocale(locale, aliases = LOCALE_ALIASES) {
  if (typeof locale !== "string") {
    return "";
  }
  const normalized = locale.trim().toLowerCase().replace(/_/gu, "-");
  if (!normalized) {
    return "";
  }
  return aliases[normalized] ?? normalized;
}

function resolveBuildInfoLocale(candidates, messages = BUILD_INFO_MESSAGES, aliases = LOCALE_ALIASES) {
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
    const normalized = normalizeBuildInfoLocale(candidate, aliases);
    if (!normalized) {
      continue;
    }
    if (messages[normalized] != null) {
      return normalized;
    }
    const base = normalized.split("-")[0];
    const aliasedBase = aliases[base] ?? base;
    if (messages[aliasedBase] != null) {
      return aliasedBase;
    }
  }
  return "en";
}

function sharedBuildInfoI18nRuntimeSource(localeExpression) {
  return `const codexLinuxBuildInfoMessages=${JSON.stringify(BUILD_INFO_MESSAGES)};const codexLinuxLocaleAliases=${JSON.stringify(LOCALE_ALIASES)};function codexLinuxNormalizeLocale(locale){if(typeof locale!="string")return"";let normalized=locale.trim().toLowerCase().replace(/_/g,"-");return normalized?codexLinuxLocaleAliases[normalized]??normalized:""}function codexLinuxResolveLocale(candidates){for(let candidate of Array.isArray(candidates)?candidates:[candidates]){let normalized=codexLinuxNormalizeLocale(candidate);if(!normalized)continue;if(codexLinuxBuildInfoMessages[normalized])return normalized;let base=normalized.split("-")[0],aliasedBase=codexLinuxLocaleAliases[base]??base;if(codexLinuxBuildInfoMessages[aliasedBase])return aliasedBase}return"en"}function codexLinuxBuildInfoI18n(){let locale=codexLinuxResolveLocale(${localeExpression}),messages=codexLinuxBuildInfoMessages[locale]??codexLinuxBuildInfoMessages.en;return{locale,t:key=>messages[key]??codexLinuxBuildInfoMessages.en[key]??key}}function codexLinuxFormatBuildInfoTimestamp(value,locale,fallback){let text=typeof value=="string"?value.trim():"";if(!text)return fallback;let parsed=Date.parse(text);if(!Number.isFinite(parsed))return text;try{return new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short"}).format(parsed)}catch{return text}}`;
}

function buildMainBuildInfoI18nSource(appLocaleExpression) {
  return sharedBuildInfoI18nRuntimeSource(`(()=>{let candidates=[];try{let appLocale=${appLocaleExpression};appLocale&&candidates.push(appLocale)}catch{}return candidates})()`);
}

module.exports = {
  BUILD_INFO_LOCALES,
  BUILD_INFO_MESSAGES,
  buildMainBuildInfoI18nSource,
  normalizeBuildInfoLocale,
  resolveBuildInfoLocale,
};
