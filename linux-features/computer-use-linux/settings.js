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

module.exports = { applyNativeSettingsAvailabilityPatch };
