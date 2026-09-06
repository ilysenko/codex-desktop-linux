"use strict";

function rewriteComputerUseMarketplaceSelector(currentSource) {
  const marketplaceGateRegex =
    /if\(!\(\s*([A-Za-z_$][\w$]*)\.platform!==`darwin`\|\|!\s*\1\.marketplacePluginNames\.includes\(`computer-use`\)\s*\)\)return\s*\1\.desktopFeatureAvailability\.computerUseNodeRepl\?`node-repl`:`legacy-mcp`/g;
  return currentSource.replace(
    marketplaceGateRegex,
    (_match, ref) =>
      `if(!((${ref}.platform!==\`darwin\`&&${ref}.platform!==\`linux\`)||!${ref}.marketplacePluginNames.includes(\`computer-use\`)))return ${ref}.platform===\`darwin\`&&${ref}.desktopFeatureAvailability.computerUseNodeRepl?\`node-repl\`:\`legacy-mcp\``,
  );
}

// The descriptor registry now spreads the shared plugin definition. Override the
// inherited opt-in requirement locally, without changing the Windows descriptor.
function applyLinuxComputerUsePluginGatePatch(source) {
  const gate = /\{\.\.\.([\w$]+(?:\.[\w$]+)*\.computerUse),autoInstallOptOutKey:([^{}]+?),isAvailable:\(\{features:([\w$]+),platform:([\w$]+)\}\)=>([^{}]+?),migrate:([\w$]+)(,installWhenMissingRequiresOptIn:!1)?\}/g;
  let matches = 0;
  const patched = source.replace(gate, (original, descriptor, optOut, features, platform, expression, migrate) => {
    const before = `${platform}===\`darwin\`&&${features}.computerUse`;
    const after = `${platform}===\`linux\`||${before}`;
    if (expression !== before && expression !== after) {
      throw new Error("Linux Computer Use plugin availability expression changed");
    }
    matches += 1;
    return `{...${descriptor},autoInstallOptOutKey:${optOut},isAvailable:({features:${features},platform:${platform}})=>${after},migrate:${migrate},installWhenMissingRequiresOptIn:!1}`;
  });
  if (matches !== 1) {
    throw new Error(`Expected one Linux Computer Use plugin descriptor, found ${matches}`);
  }
  // A patched skill selector alone is not evidence of plugin availability.
  return rewriteComputerUseMarketplaceSelector(patched);
}

module.exports = { applyLinuxComputerUsePluginGatePatch };
