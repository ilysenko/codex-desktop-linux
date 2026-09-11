"use strict";

const fs = require("node:fs");
const path = require("node:path");

const IDENT = "[A-Za-z_$][\\w$]*";
const AUTHED_ROUTE_ASSET_PATTERN = /^authed-route-[A-Za-z0-9_-]+\.js$/;
const APP_PRIMARY_ASSET_PATTERN = /^app-primary-[A-Za-z0-9_-]+\.js$/;
const ROUTE_INITIALIZER_PATTERN = new RegExp(
  `(?:queueMicrotask\\(\\(\\)=>(${IDENT})\\(\\)\\)|(${IDENT})\\(\\));export\\{([^}]*)\\};`,
  "gu",
);
const APP_PRIMARY_IMPORT_PATTERN = new RegExp(
  `import\\{([^}]*)\\}from[\"']\\./(app-primary-[A-Za-z0-9_-]+\\.js)[\"'];`,
  "gu",
);
const EXPORT_PATTERN = /export\{([^}]*)\};/gu;
const WARNING =
  "WARN: Could not uniquely identify the official app-primary/authed-route renderer cycle — skipping upstream renderer cycle fix";

function specifierMappings(specifiers) {
  return specifiers.split(",").map((specifier) => {
    const names = specifier.trim().split(/\s+as\s+/u);
    return { source: names[0], target: names[1] ?? names[0] };
  });
}

function exportedNames(specifiers) {
  return specifierMappings(specifiers).map(({ target }) => target);
}

function routeInitializerContracts(source) {
  const imports = [...source.matchAll(APP_PRIMARY_IMPORT_PATTERN)];
  const contracts = [];
  for (const match of source.matchAll(ROUTE_INITIALIZER_PATTERN)) {
    const initializer = match[1] ?? match[2];
    const routeExports = exportedNames(match[3]);
    if (!routeExports.includes("AuthedRoute") || !routeExports.includes("AppLayoutRoute")) {
      continue;
    }
    const primaryImports = imports.flatMap((candidate) =>
      specifierMappings(candidate[1])
        .filter(({ target }) => target === initializer)
        .map(({ source }) => ({ asset: candidate[2], exportedName: source })));
    if (primaryImports.length !== 1) continue;
    const call = match[1] == null
      ? `${initializer}()`
      : `queueMicrotask(()=>${initializer}())`;
    contracts.push({
      start: match.index,
      end: match.index + call.length,
      initializer,
      primaryAsset: primaryImports[0].asset,
      primaryExport: primaryImports[0].exportedName,
      patched: match[1] != null,
    });
  }
  return contracts;
}

function lateModuleInitializerContracts(source, exportedName) {
  const exportedBindings = [...source.matchAll(EXPORT_PATTERN)]
    .flatMap((match) => specifierMappings(match[1]))
    .filter(({ target }) => target === exportedName);
  if (exportedBindings.length !== 1) return [];

  const localName = exportedBindings[0].source;
  const escapedLocalName = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const assignmentPattern = new RegExp(
    `(?:\\bvar\\s|,)${escapedLocalName}=(${IDENT})\\(\\(\\(\\)=>\\{`,
    "gu",
  );
  return [...source.matchAll(assignmentPattern)].map((match) => ({
    localName,
    wrapperName: match[1],
  }));
}

function hasReverseImport(source, authedRouteAsset) {
  const escapedAsset = authedRouteAsset.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `import\\{[^}]*\\}from[\"']\\./${escapedAsset}[\"'];`,
    "u",
  ).test(source);
}

function rendererCycleContracts(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) return [];

  const contracts = [];
  for (const authedRouteAsset of fs.readdirSync(assetsDir).sort()) {
    if (!AUTHED_ROUTE_ASSET_PATTERN.test(authedRouteAsset)) continue;
    const authedRoutePath = path.join(assetsDir, authedRouteAsset);
    const source = fs.readFileSync(authedRoutePath, "utf8");
    for (const contract of routeInitializerContracts(source)) {
      if (!APP_PRIMARY_ASSET_PATTERN.test(contract.primaryAsset)) continue;
      const primaryPath = path.join(assetsDir, contract.primaryAsset);
      if (!fs.existsSync(primaryPath)) continue;
      const primarySource = fs.readFileSync(primaryPath, "utf8");
      if (!hasReverseImport(primarySource, authedRouteAsset)) continue;
      const primaryInitializers = lateModuleInitializerContracts(
        primarySource,
        contract.primaryExport,
      );
      if (primaryInitializers.length !== 1) continue;
      contracts.push({
        ...contract,
        authedRouteAsset,
        authedRoutePath,
        primaryInitializer: primaryInitializers[0].localName,
        source,
      });
    }
  }
  return contracts;
}

function patchUpstreamRendererCycle(extractedDir) {
  const contracts = rendererCycleContracts(extractedDir);
  if (contracts.length !== 1) {
    console.warn(WARNING);
    return { matched: false, changed: 0, reason: WARNING };
  }

  const contract = contracts[0];
  if (contract.patched) {
    return {
      matched: true,
      changed: 0,
      alreadyApplied: true,
      assetName: contract.authedRouteAsset,
    };
  }

  const patched =
    contract.source.slice(0, contract.start) +
    `queueMicrotask(()=>${contract.initializer}())` +
    contract.source.slice(contract.end);
  const verified = routeInitializerContracts(patched);
  if (
    verified.length !== 1 ||
    !verified[0].patched ||
    verified[0].primaryAsset !== contract.primaryAsset ||
    verified[0].primaryExport !== contract.primaryExport
  ) {
    console.warn(WARNING);
    return { matched: false, changed: 0, reason: WARNING };
  }
  fs.writeFileSync(contract.authedRoutePath, patched, "utf8");

  return {
    matched: true,
    changed: 1,
    alreadyApplied: false,
    assetName: contract.authedRouteAsset,
  };
}

module.exports = {
  AUTHED_ROUTE_ASSET_PATTERN,
  descriptors: [
    {
      id: "upstream-renderer-cycle",
      phase: "extracted-app:post-webview",
      order: 980,
      ciPolicy: "required-upstream",
      apply: patchUpstreamRendererCycle,
      status: (result, warnings) => {
        if (result?.matched !== true) {
          return { status: "failed-required", reason: result?.reason ?? warnings[0] ?? null };
        }
        return result.changed > 0 ? "applied" : "already-applied";
      },
    },
  ],
  hasReverseImport,
  lateModuleInitializerContracts,
  patchUpstreamRendererCycle,
  rendererCycleContracts,
  routeInitializerContracts,
};
