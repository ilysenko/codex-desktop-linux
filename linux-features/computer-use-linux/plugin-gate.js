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

function hasPatchedComputerUseMarketplaceSelector(currentSource) {
  return [...currentSource.matchAll(/if\(!\(\(\s*([A-Za-z_$][\w$]*)\.platform!==`darwin`&&\1\.platform!==`linux`\)\|\|!\1\.marketplacePluginNames\.includes\(`computer-use`\)\)\)return\s+\1\.platform===`darwin`&&\1\.desktopFeatureAvailability\.computerUseNodeRepl\?`node-repl`:`legacy-mcp`/g)].length === 1;
}

function applyLinuxComputerUsePluginGatePatch(currentSource) {
  const fail = () => {
    throw new Error("Required Linux Computer Use plugin gate patch failed: expected unique native registrations and marketplace selector");
  };
  const identifier = String.raw`[A-Za-z_$][\w$]*`;
  const reference = String.raw`${identifier}(?:\.${identifier})+`;
  // Match the current descriptor's shared metadata, opt-out identity and bound
  // feature/platform aliases together. Never infer registration from Nd alone.
  const descriptorPattern = new RegExp(
    String.raw`\{\.\.\.(${reference}\.computerUse),autoInstallOptOutKey:(${reference})\(\1\.name\),isAvailable:\(\{features:(${identifier}),platform:(${identifier})\}\)=>\4===` +
      "`(darwin|win32|linux)`" + String.raw`&&\3\.computerUse(?:,migrate:(${identifier}))?\}`,
    "g",
  );
  const descriptors = [...currentSource.matchAll(descriptorPattern)];
  const spreadCount = [...currentSource.matchAll(new RegExp(String.raw`\{\.\.\.${reference}\.computerUse,`, "g"))].length;
  if (descriptors.length !== spreadCount || ![2, 3].includes(descriptors.length)) fail();
  const mac = descriptors.filter(match => match[5] === "darwin");
  const windows = descriptors.filter(match => match[5] === "win32");
  const linux = descriptors.filter(match => match[5] === "linux");
  if (mac.length !== 1 || windows.length !== 1 || linux.length > 1 || !mac[0][6]) fail();
  if (windows[0][6] || linux.some(match => match[6])) fail();
  if (descriptors.some(match => match[1] !== mac[0][1] || match[2] !== mac[0][2])) fail();

  const patchedSelectorSource = rewriteComputerUseMarketplaceSelector(currentSource);
  if (!hasPatchedComputerUseMarketplaceSelector(patchedSelectorSource)) fail();
  // Mac's migration deletes legacy macOS helpers. Linux inherits consent and
  // installation policy from the same metadata, but must never run that migration.
  if (linux.length === 1) return patchedSelectorSource;
  const [, metadata, optOut, features, platform] = mac[0];
  const linuxDescriptor = `{...${metadata},autoInstallOptOutKey:${optOut}(${metadata}.name),isAvailable:({features:${features},platform:${platform}})=>${platform}===\`linux\`&&${features}.computerUse}`;
  return patchedSelectorSource.replace(mac[0][0], `${mac[0][0]},${linuxDescriptor}`);
}

module.exports = { applyLinuxComputerUsePluginGatePatch };
