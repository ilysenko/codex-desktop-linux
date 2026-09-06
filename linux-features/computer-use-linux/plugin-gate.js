"use strict";

function rewriteComputerUseMarketplaceSelector(currentSource) {
  const selectorRegex =
    /if\(([^{};]*?\.marketplacePluginNames\.includes\(`computer-use`\)[^{};]*?)\)return\s*([^{};]+)(?=[;}])/g;
  let matchedSelectorCount = 0;
  const patched = currentSource.replace(selectorRegex, (_match, condition, expression) => {
    const ref = condition.match(/([A-Za-z_$][\w$]*)\.marketplacePluginNames/)?.[1];
    const pristineCondition = `!(${ref}.platform!==\`darwin\`||!${ref}.marketplacePluginNames.includes(\`computer-use\`))`;
    const patchedCondition = `!((${ref}.platform!==\`darwin\`&&${ref}.platform!==\`linux\`)||!${ref}.marketplacePluginNames.includes(\`computer-use\`))`;
    const pristineExpression = `${ref}.desktopFeatureAvailability.computerUseNodeRepl?\`node-repl\`:\`legacy-mcp\``;
    const patchedExpression = `${ref}.platform===\`darwin\`&&${pristineExpression}`;
    if (
      !(condition === pristineCondition && expression === pristineExpression) &&
      !(condition === patchedCondition && expression === patchedExpression)
    ) {
      throw new Error("Linux Computer Use marketplace selector changed");
    }
    matchedSelectorCount += 1;
    return `if(${patchedCondition})return ${patchedExpression}`;
  });
  if (matchedSelectorCount !== 1) {
    throw new Error(`Expected one Linux Computer Use marketplace selector, found ${matchedSelectorCount}`);
  }
  return patched;
}

// The descriptor registry now spreads the shared plugin definition. Override the
// inherited opt-in requirement locally, without changing the Windows descriptor.
function applyLinuxComputerUsePluginGatePatch(source) {
  const pluginGateRegex =
    /\{\.\.\.([\w$]+(?:\.[\w$]+)*\.computerUse),autoInstallOptOutKey:([^{}]+?),isAvailable:\(\{features:([\w$]+),platform:([\w$]+)\}\)=>([^{}]+?),migrate:([\w$]+)(,installWhenMissingRequiresOptIn:!1)?\}/g;
  let matchedGateCount = 0;
  const patched = source.replace(
    pluginGateRegex,
    (_match, descriptor, optOut, features, platform, expression, migrate) => {
      const before = `${platform}===\`darwin\`&&${features}.computerUse`;
      const after = `${platform}===\`linux\`||${before}`;
      if (expression !== before && expression !== after) {
        throw new Error("Linux Computer Use plugin availability expression changed");
      }
      matchedGateCount += 1;
      return `{...${descriptor},autoInstallOptOutKey:${optOut},isAvailable:({features:${features},platform:${platform}})=>${after},migrate:${migrate},installWhenMissingRequiresOptIn:!1}`;
    },
  );
  if (matchedGateCount !== 1) {
    throw new Error(`Expected one Linux Computer Use plugin descriptor, found ${matchedGateCount}`);
  }
  // A patched skill selector alone is not evidence of plugin availability.
  return rewriteComputerUseMarketplaceSelector(patched);
}

module.exports = { applyLinuxComputerUsePluginGatePatch };
