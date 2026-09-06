"use strict";

// The native component owns the existing plugin toggle; unified-computer-use
// owns transport. Never invent an installed/enabled Settings row.
function applyNativeSettingsAvailabilityPatch(source) {
  if (source.includes("BundledMarketplaceDonor")) throw new Error("Retired synthetic Linux Settings contract");
  const marker = /[\w$]+===`linux`&&\([\w$]+=\{\.\.\.[\w$]+,available:/g;
  const pattern = /let (?<availability>[\w$]+)=(?<hook>[\w$]+)\((?<args>[^)]*)\),\{platform:(?<platform>[\w$]+)\}=(?<platformHook>[\w$]+)\(\)(?:,|(?<patched>;\k<platform>===`linux`&&\(\k<availability>=\{\.\.\.\k<availability>,available:!0,isFetching:!1,isLoading:!1\}\);let ))(?<next>[\w$]+)=/g;
  const matches = [...source.matchAll(pattern)].filter(match => {
    // A following owner must not supply the consumer missing from this one.
    const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 3000).split(/function [\w$]+\(/)[0];
    return tail.includes(`computerUseAvailability:${match.groups.availability}`) && tail.includes(`${match.groups.availability}.available`);
  });
  const patchedCount = matches.filter(match => match.groups.patched != null).length;
  if (matches.length !== 1 || [...source.matchAll(marker)].length !== patchedCount) {
    throw new Error("Linux native Settings availability contract missing or ambiguous");
  }
  if (patchedCount === 1) return source;
  const match = matches[0];
  const { availability, hook, args, platform, platformHook, next } = match.groups;
  const replacement = `let ${availability}=${hook}(${args}),{platform:${platform}}=${platformHook}();${platform}===\`linux\`&&(${availability}={...${availability},available:!0,isFetching:!1,isLoading:!1});let ${next}=`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

// Apply at the Plugins presentation filter, not the bundled registry's hidden
// flag: that flag drops the component from the shared Settings query too.
function applyNativeSettingsVisibilityPatch(source) {
  const marker = '/* linux-native-settings-component */';
  const pattern = /function (?<fn>[\w$]+)\((?<plugins>[\w$]+),(?<hidden>[\w$]+),(?<restrictedMode>[\w$]+)\)\{(?:if\(\k<hidden>\.length===0&&!\k<restrictedMode>\)return \k<plugins>;|(?<patched>\/\* linux-native-settings-component \*\/))let (?<set>[\w$]+)=new Set\(\k<hidden>\);return \k<plugins>\.filter\((?<entry>[\w$]+)=>(?<exclusion>!\(\k<entry>\.marketplaceName===`openai-bundled`&&\k<entry>\.plugin\.name===`computer-use`\)&&)?\(!\k<restrictedMode>\|\|!(?<restricted>[\w$]+)\(\k<entry>\.plugin\.id\)\)&&!\k<set>\.has\(\k<entry>\.plugin\.id\)\)\}/g;
  const matches = [...source.matchAll(pattern)];
  const patchedCount = matches.filter(match => match.groups.patched != null).length;
  if (matches.length !== 1 || source.split(marker).length - 1 !== patchedCount ||
      matches.some(match => (match.groups.patched != null) !== (match.groups.exclusion != null))) {
    throw new Error("Linux native Settings visibility contract missing or ambiguous");
  }
  if (patchedCount === 1) return source;
  const match = matches[0];
  const { fn, plugins, hidden, restrictedMode, set, entry, restricted } = match.groups;
  const replacement = `function ${fn}(${plugins},${hidden},${restrictedMode}){${marker}let ${set}=new Set(${hidden});return ${plugins}.filter(${entry}=>!(${entry}.marketplaceName===\`openai-bundled\`&&${entry}.plugin.name===\`computer-use\`)&&(!${restrictedMode}||!${restricted}(${entry}.plugin.id))&&!${set}.has(${entry}.plugin.id))}`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

module.exports = { applyNativeSettingsAvailabilityPatch, applyNativeSettingsVisibilityPatch };
