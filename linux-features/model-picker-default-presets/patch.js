"use strict";

const path = require("node:path");
const { Script } = require("node:vm");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const {
  findMatchingBrace, createJavaScriptLexicalIndex,
} = require("../../scripts/patches/lib/minified-js.js");

const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { findRspackRequireBinding, rspackModuleFactories, findUniqueRspackModuleCopies, patchRspackModuleCopies } =
  require("../../scripts/patches/lib/rspack-module-assets.js");

const CATALOG_PATCH_MARKER = "codexLinuxModelPickerDefaultPresets";
const CATALOG_CONFIG_NAME = "codexLinuxDefaultPresetsConfigured";
const SLIDER_PATCH_MARKER = "codex-linux-model-picker-default-presets-slider-minimum";
const LOCAL_DEFAULT_PATCH_MARKER = "codex-linux-model-picker-default-presets-local-default";
const LOCAL_COMPOSER_CONFIG_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-config";
const LOCAL_COMPOSER_RESOLVER_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-resolver";
const EXISTING_CHAT_OPTIMISTIC_MARKER =
  "codex-linux-model-picker-default-presets-existing-chat-optimistic-selection";
const EXISTING_CHAT_PRESET_IDS_KEY = "codexLinuxExistingChatDefaultPresetIds";
const IDENT = "[A-Za-z_$][\\w$]*";
const EFFORT_TO_THINKING_EFFORT = Object.freeze({
  none: "zero",
  low: "min",
  medium: "standard",
  high: "extended",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identifierSpellingPattern(identifier) {
  return [...identifier].map((character) => {
    const hex = character.codePointAt(0).toString(16)
      .replace(/[a-f]/gu, (digit) => `[${digit}${digit.toUpperCase()}]`);
    const fixedHex = character.codePointAt(0).toString(16).padStart(4, "0")
      .replace(/[a-f]/gu, (digit) => `[${digit}${digit.toUpperCase()}]`);
    return `(?:${escapeRegExp(character)}|\\\\u${fixedHex}|\\\\u\\{0*${hex}\\})`;
  }).join("");
}
const THINKING_EFFORT_TO_EFFORT = Object.freeze(
  Object.fromEntries(
    Object.entries(EFFORT_TO_THINKING_EFFORT).map(([effort, thinkingEffort]) => [
      thinkingEffort,
      effort,
    ]),
  ),
);

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function own(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function configuredPresetInput(context = {}) {
  const settings = context?.feature?.settings;
  if (own(settings, "presets")) {
    return { raw: settings.presets, userConfigured: true };
  }
  return {
    raw: context?.feature?.manifest?.presets ?? [],
    userConfigured: false,
  };
}

function normalizePresets(context = {}) {
  const { raw, userConfigured } = configuredPresetInput(context);
  if (!Array.isArray(raw)) {
    throw new Error("model-picker-default-presets presets must be an array");
  }
  if (userConfigured && raw.length === 0) {
    throw new Error("model-picker-default-presets user presets must contain at least one entry");
  }

  const normalized = [];
  const pairs = new Set();
  let defaultCount = 0;
  for (const [index, entry] of raw.entries()) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`model-picker-default-presets presets[${index}] must be an object`);
    }
    const unknownKeys = Object.keys(entry).filter(
      (key) => !["model", "effort", "default"].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `model-picker-default-presets presets[${index}] contains unknown field '${unknownKeys[0]}'`,
      );
    }
    if (typeof entry.model !== "string" || entry.model.trim().length === 0) {
      throw new Error(`model-picker-default-presets presets[${index}].model must be a non-empty string`);
    }
    if (!own(EFFORT_TO_THINKING_EFFORT, entry.effort)) {
      throw new Error(
        `model-picker-default-presets presets[${index}].effort must be one of ${Object.keys(
          EFFORT_TO_THINKING_EFFORT,
        ).join(", ")}`,
      );
    }
    if (own(entry, "default") && typeof entry.default !== "boolean") {
      throw new Error(`model-picker-default-presets presets[${index}].default must be a boolean`);
    }

    const preset = {
      modelSlug: entry.model.trim(),
      thinkingEffort: EFFORT_TO_THINKING_EFFORT[entry.effort],
      isDefault: entry.default === true,
    };
    const pair = `${preset.modelSlug}\0${preset.thinkingEffort}`;
    if (pairs.has(pair)) {
      throw new Error(
        `model-picker-default-presets contains duplicate model/effort pair at presets[${index}]`,
      );
    }
    pairs.add(pair);
    defaultCount += preset.isDefault ? 1 : 0;
    normalized.push(preset);
  }

  if (normalized.length > 0 && defaultCount !== 1) {
    throw new Error("model-picker-default-presets presets must contain exactly one default entry");
  }
  return normalized;
}

function codexLinuxModelPickerDefaultPresets(catalog, configured) {
  if (configured.length === 0) {
    return catalog;
  }
  const options = [
    ...(catalog?.options ?? []),
    ...(catalog?.internalOptions ?? []),
    ...(catalog?.versionOptions?.flatMap((version) => version?.options ?? []) ?? []),
  ];
  const supported = configured.filter(preset => options.some(option => option?.slug === preset.modelSlug));
  if (supported.length === 0) return catalog;
  const selectedDefault = supported.find(preset => preset.isDefault) ?? supported[0];
  return {
    ...catalog,
    sliderSettings: supported.map((preset) => ({
      modelSlug: preset.modelSlug,
      thinkingEffort: preset.thinkingEffort,
    })),
    defaultModelSlug: selectedDefault.modelSlug,
    defaultThinkingEffortByModelSlug: {
      ...catalog.defaultThinkingEffortByModelSlug,
      [selectedDefault.modelSlug]: selectedDefault.thinkingEffort,
    },
  };
}

function functionSections(source) {
  const sections = [];
  const pattern = /function(?: [A-Za-z_$][\w$]*)?\([^)]*\)\{/g;
  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close !== -1) {
      sections.push({
        end: close + 1,
        source: source.slice(match.index, close + 1),
        start: match.index,
      });
    }
  }
  return sections;
}

// rspack chunks register `__webpack_modules__={id(e,t,n){...},...}`; minified
// helper names repeat across module factories, so related functions are looked
// up only inside the factory that owns a matched section.
function enclosingModuleFactory(source, index) {
  const registry = "__webpack_modules__={";
  const registryStart = source.indexOf(registry);
  if (registryStart < 0 || source.indexOf(registry, registryStart + 1) >= 0) return null;
  const entry = /(?:"[^"\\]*"|[\w$]+)\([^()]*\)\{/y;
  let cursor = registryStart + registry.length;
  while (cursor < source.length && source[cursor] !== "}") {
    entry.lastIndex = cursor;
    const match = entry.exec(source);
    if (match == null) return null;
    const open = cursor + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) return null;
    if (index > open && index < close) {
      return {
        bodyStart: open + 1,
        end: close + 1,
        source: source.slice(cursor, close + 1),
        start: cursor,
      };
    }
    cursor = close + 1;
    if (source[cursor] === ",") cursor += 1;
  }
  return null;
}

function uniqueFunctionWithMarkers(source, markers) {
  const matches = functionSections(source).filter((section) =>
    markers.every((marker) => section.source.includes(marker)),
  );
  const leafMatches = matches.filter((candidate) =>
    !matches.some((other) =>
      other !== candidate && other.start > candidate.start && other.end < candidate.end
    )
  );
  return leafMatches.length === 1 ? leafMatches[0] : null;
}

const CATALOG_DESCRIPTION = "current ChatGPT model catalog normalizer";
const CATALOG_NEEDLES = [".slider_settings.flatMap(", "serviceTiersByModelSlug:", "modelConfigBySlug:", "workspaceModelPolicy:"];
const catalogMarkerCount = source => [CATALOG_PATCH_MARKER, CATALOG_CONFIG_NAME]
  .reduce((total, name) => total + source.split(name).length - 1, 0);

function catalogRuntimeHelper(presets) {
  return `${codexLinuxModelPickerDefaultPresets.toString()}const ${CATALOG_CONFIG_NAME}=${JSON.stringify(presets)};`;
}

function requireCatalogRegistry(source) {
  const headers = [...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];
  if (headers.length !== 1) throw new Error(`Missing or ambiguous ${CATALOG_DESCRIPTION} registry`);
  const header = headers[0];
  if (!createJavaScriptLexicalIndex(source.slice(0, header.index + header[0].length)).isRoot(header.index)) {
    throw new Error(`Opaque or nested ${CATALOG_DESCRIPTION} registry`);
  }
}

function catalogOne(source, expression, description, root = true) {
  const lexical = createJavaScriptLexicalIndex(source);
  const found = [...source.matchAll(expression)].filter(match =>
    root ? lexical.isRoot(match.index) : lexical.isCode(match.index));
  if (found.length !== 1) throw new Error(`Missing or ambiguous ${CATALOG_DESCRIPTION} ${description}`);
  return found[0];
}

function catalogPublication(source, snapshot) {
  const module = { ...snapshot, moduleSource: source };
  const lexical = createJavaScriptLexicalIndex(source);
  const keys = [...source.matchAll(new RegExp(`(${IDENT}):function\\(`, "gu"))]
    .filter(match => lexical.isCode(match.index)).map(match => match[1]);
  const found = [...new Set(keys)].flatMap(key => {
    const publication = findRspackExportPublication(module, key);
    return publication?.fn != null && new RegExp(`^${IDENT}$`, "u").test(publication.fn.params) &&
      CATALOG_NEEDLES.every(needle => publication.fn.body.includes(needle)) ? [publication] : [];
  });
  if (found.length !== 1) throw new Error(`Missing or ambiguous ${CATALOG_DESCRIPTION} publication`);
  return found[0];
}

function catalogReturnedObject(source, publication, applied = false) {
  const { start, end } = publication.fn;
  const bodyStart = source.indexOf("{", start) + 1, bodyEnd = end - 1;
  const body = source.slice(bodyStart, bodyEnd), lexical = createJavaScriptLexicalIndex(source);
  const returned = catalogOne(body, /\breturn\b/gu, "native return");
  const returnEnd = bodyStart + returned.index + returned[0].length;
  let open = returnEnd;
  while (/\s/u.test(source[open] ?? "") && open < bodyEnd) open++;
  let wrapperStart = null;
  if (applied) {
    const prefix = `${CATALOG_PATCH_MARKER}(`;
    if (!source.startsWith(prefix, open) || source[open - 1] !== " ") {
      throw new Error(`Noncanonical ${CATALOG_DESCRIPTION} wrapper`);
    }
    wrapperStart = open - 1;
    open += prefix.length;
  }
  const close = lexical.matchingBrace(open);
  const suffix = applied ? `,${CATALOG_CONFIG_NAME})` : "";
  if (source[open] !== "{" || close < open || source.slice(close + 1, bodyEnd).trimEnd() !== suffix) {
    throw new Error(`Unsupported ${CATALOG_DESCRIPTION} final return object`);
  }
  return { open, close, wrapperStart, suffix, bodyStart, bodyEnd };
}

const catalogBindingProofs = new Map();

// Native publication and initializer ownership are established separately.
// Project only that proven initializer's binder to a fresh local and treat the
// captured binding as a parameter of a syntax-only probe. The existing Rspack
// parameter-authority checker then rejects writes/redeclarations at any depth,
// including escaped spellings, while retaining real local shadows/member keys.
// This synthetic publication is only a readonly-binding proof, never an owner.
function requireStableCatalogBinding(source, name, initializer = null) {
  const key = `${name}:${initializer ?? -1}:${source}`;
  let stable = catalogBindingProofs.get(key);
  if (stable == null) {
    let prefix = "__codexCatalogBinding";
    while (source.includes(prefix) || name.startsWith(prefix)) prefix += "$";
    let projected = source;
    if (initializer != null) {
      if (source.slice(initializer, initializer + name.length) !== name) {
        throw new Error(`Unsupported ${CATALOG_DESCRIPTION} initializer binding`);
      }
      projected = source.slice(0, initializer) + `${prefix}Initial` + source.slice(initializer + name.length);
    }
    // Normalize only this identifier's code spellings in the probe, so an
    // escaped local parameter/key has the same lexical-shadow treatment as
    // its literal spelling. Native source bytes are never normalized.
    const lexical = createJavaScriptLexicalIndex(projected);
    const tokens = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
    const spellings = [...projected.matchAll(tokens)].filter(token => lexical.isCode(token.index) &&
      token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
        (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed,16))) === name);
    for (const token of spellings.reverse()) {
      projected = projected.slice(0,token.index) + name + projected.slice(token.index + token[0].length);
    }
    const requireName = `${prefix}Require`, value = `${prefix}Value`;
    const probe = `${requireName}.d(${name},{},{proof:${value}});function ${value}(){}${projected}`;
    try {
      stable = findRspackExportPublication({moduleSource:probe,params:[`${prefix}Module`,name,requireName]},"proof")?.expression === value;
    } catch { stable = false; }
    if (catalogBindingProofs.size === 32) catalogBindingProofs.delete(catalogBindingProofs.keys().next().value);
    catalogBindingProofs.set(key, stable);
  }
  if (!stable) throw new Error(`Unstable ${CATALOG_DESCRIPTION} binding: ${name}`);
}

// Latest signed stable has one published schema-normalizing function. The
// legacy catalog+flattened-selection-resolver format is deliberately absent.
function inspectNativeCatalog(source, snapshot) {
  if (catalogMarkerCount(source) !== 0) throw new Error(`Orphan ${CATALOG_DESCRIPTION} contribution`);
  const publication = catalogPublication(source, snapshot);
  const returned = catalogReturnedObject(source, publication);
  const body = source.slice(returned.bodyStart, returned.bodyEnd);
  const parsed = catalogOne(body, new RegExp(`(?:let |,)(?<parsed>${IDENT})=(?<schema>${IDENT})\\.parse\\((?<argument>${IDENT})\\),`, "gu"), "schema input").groups;
  if (parsed.argument !== publication.fn.params || new Set(Object.values(parsed)).size !== 3) {
    throw new Error(`Unsupported ${CATALOG_DESCRIPTION} input binding`);
  }
  try { new Script(`function catalogSchemaScope(){${body};let ${parsed.schema};}`); }
  catch { throw new Error(`Shadowed ${CATALOG_DESCRIPTION} schema binding`); }
  const factory = { ...snapshot, moduleSource: source };
  const schema = catalogOne(source, new RegExp(`(?<name>${escapeRegExp(parsed.schema)})=(?<namespace>${IDENT})\\.object\\(`, "gu"), "schema declaration").groups;
  if (findRspackRequireBinding(factory, schema.namespace) == null) {
    throw new Error(`Unsupported ${CATALOG_DESCRIPTION} schema import`);
  }
  for (const name of [parsed.schema, schema.namespace]) {
    const initializer = catalogOne(source, new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(?!=|>)`, "gu"), "factory binding");
    requireStableCatalogBinding(source, name, initializer.index);
  }
  const input = escapeRegExp(parsed.parsed);
  const slider = catalogOne(body, new RegExp(`(?<slider>${IDENT})=${input}\\.slider_settings\\.flatMap\\((?<item>${IDENT})=>null==\\k<item>\\?\\[\\]:\\[\\{modelSlug:\\k<item>\\.model_slug,thinkingEffort:\\k<item>\\.thinking_effort\\}\\]\\)`, "gu"), "slider source").groups;
  const defaults = catalogOne(body, new RegExp(`(?<defaults>${IDENT})=Object\\.fromEntries\\(\\[\\.\\.\\.(?<models>${IDENT})\\.values\\(\\)\\]\\.flatMap\\((?<item>${IDENT})=>null==\\k<item>\\.defaultThinkingEffort\\?\\[\\]:\\[\\[\\k<item>\\.slug,\\k<item>\\.defaultThinkingEffort\\]\\]\\)\\)`, "gu"), "default efforts").groups;
  const selected = catalogOne(body, new RegExp(`(?<selected>${IDENT})=${input}\\.default_model_slug\\?\\?(?<options>${IDENT})\\[0\\]\\?\\.slug\\?\\?(?:${IDENT}|"[^"\\n]*")`, "gu"), "default model").groups;
  const roles = [parsed.parsed, slider.slider, defaults.defaults, defaults.models, selected.selected, selected.options];
  if (new Set([...roles, parsed.argument, parsed.schema]).size !== roles.length + 2) {
    throw new Error(`Aliased ${CATALOG_DESCRIPTION} native role`);
  }
  for (const name of roles) {
    const initializer = catalogOne(body, new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(?!=|>)`, "gu"), "native binding");
    requireStableCatalogBinding(body, name, initializer.index);
  }
  requireStableCatalogBinding(body, parsed.argument);
  const fields = source.slice(returned.open + 1, returned.close);
  const field = (text, description) => catalogOne(fields, new RegExp(text, "gu"), description);
  const tiers = field(`serviceTiersByModelSlug:(?<tiers>${IDENT})(?=,)`, "service-tier output").groups.tiers;
  if ([...roles, parsed.argument, parsed.schema].includes(tiers)) throw new Error(`Aliased ${CATALOG_DESCRIPTION} tier binding`);
  const tierInitializer = catalogOne(body, new RegExp(`(?<![\\w$.])${escapeRegExp(tiers)}=(?!=|>)`, "gu"), "tier binding");
  requireStableCatalogBinding(body, tiers, tierInitializer.index);
  field(`modelConfigBySlug:Object\\.fromEntries\\(${input}\\.models\\.flatMap\\(`, "model metadata output");
  field(`\\.\\.\\.Object\\.keys\\(${escapeRegExp(defaults.defaults)}\\)\\.length>0\\?\\{defaultThinkingEffortByModelSlug:${escapeRegExp(defaults.defaults)}\\}:\\{\\}`, "default effort output");
  field(`defaultModelSlug:${escapeRegExp(selected.selected)}(?=,)`, "default model output");
  field(`options:${escapeRegExp(selected.options)}(?=,)`, "available options output");
  field(`\\.\\.\\.${escapeRegExp(slider.slider)}\\.length>0\\?\\{sliderSettings:${escapeRegExp(slider.slider)}\\}:\\{\\}`, "slider output");
  field(`\\.\\.\\.null==${input}\\.workspace_model_policy\\?\\{\\}:\\{workspaceModelPolicy:`, "workspace policy output");
  if (!fields.includes(`null==${parsed.parsed}.workspace_model_policy?{}:{workspaceModelPolicy:`)) {
    throw new Error(`Unsupported ${CATALOG_DESCRIPTION} workspace policy source`);
  }
  return { publication, ...returned };
}

function patchCatalogFactory(source, snapshot, presets) {
  if (!Array.isArray(snapshot?.params) || snapshot.params.length !== 3 ||
      new Set(snapshot.params).size !== 3 || snapshot.params.some(name => !new RegExp(`^${IDENT}$`, "u").test(name))) {
    throw new Error(`Invalid ${CATALOG_DESCRIPTION} factory parameters`);
  }
  try { new Script(`"use strict";function catalogFactory(${snapshot.params.join(",")}){${source}}`); }
  catch { throw new Error(`Invalid ${CATALOG_DESCRIPTION} factory syntax`); }
  const helper = catalogRuntimeHelper(presets);
  if (catalogMarkerCount(source) > 0) {
    if (!source.startsWith(helper)) throw new Error(`Orphan or stale ${CATALOG_DESCRIPTION} helper`);
    const candidate = source.slice(helper.length);
    const publication = catalogPublication(candidate, snapshot);
    const returned = catalogReturnedObject(candidate, publication, true);
    const native = candidate.slice(0, returned.wrapperStart) + candidate.slice(returned.open, returned.close + 1) +
      candidate.slice(returned.close + 1 + returned.suffix.length);
    const original = inspectNativeCatalog(native, snapshot);
    const replay = helper + native.slice(0, original.open) + ` ${CATALOG_PATCH_MARKER}(` +
      native.slice(original.open, original.close + 1) + `,${CATALOG_CONFIG_NAME})` + native.slice(original.close + 1);
    if (replay !== source) throw new Error(`Noncanonical ${CATALOG_DESCRIPTION} replay`);
    return source;
  }
  const found = inspectNativeCatalog(source, snapshot);
  const patched = helper + source.slice(0, found.open) + ` ${CATALOG_PATCH_MARKER}(` +
    source.slice(found.open, found.close + 1) + `,${CATALOG_CONFIG_NAME})` + source.slice(found.close + 1);
  if (patchCatalogFactory(patched, snapshot, presets) !== patched) throw new Error(`Incomplete ${CATALOG_DESCRIPTION} insertion`);
  return patched;
}

function catalogCandidates(source) {
  return CATALOG_NEEDLES.every(needle => source.includes(needle)) || catalogMarkerCount(source) > 0;
}

function applyCatalogPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (context.factorySnapshot != null) {
    if (context.factorySnapshot.moduleSource !== source) throw new Error("Stale ChatGPT catalog snapshot");
    return patchCatalogFactory(source, context.factorySnapshot, presets);
  }
  requireCatalogRegistry(source);
  if (!javascriptSourceParses(source)) throw new Error(`Invalid ${CATALOG_DESCRIPTION} asset syntax`);
  const modules = [...rspackModuleFactories(source, "chatgpt-catalog.js")].filter(module => {
    if (!catalogCandidates(module.moduleSource)) return false;
    try { patchCatalogFactory(module.moduleSource, module, presets); return true; } catch { return false; }
  });
  if (modules.length !== 1) throw new Error(`Missing or ambiguous ${CATALOG_DESCRIPTION} factory`);
  const [module] = modules;
  if (catalogMarkerCount(source) !== catalogMarkerCount(module.moduleSource)) throw new Error(`Orphan ${CATALOG_DESCRIPTION} marker`);
  return source.slice(0, module.start) + patchCatalogFactory(module.moduleSource, module, presets) + source.slice(module.end);
}

function catalogPatchContract(source, context = {}) {
  try { return applyCatalogPatch(source, context) === source ? "applied" : "current"; }
  catch { return "drifted"; }
}

function patchCatalog(extractedDir, context = {}, options = {}) {
  const presets = normalizePresets(context), markerAssets = new Set();
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assetsDir, {
    description: CATALOG_DESCRIPTION,
    sourceMatch(source, name) {
      if (catalogMarkerCount(source) > 0) markerAssets.add(name);
      return catalogCandidates(source);
    },
    matchModule(source, module) {
      if (!catalogCandidates(source)) return false;
      try { patchCatalogFactory(source, module, presets); return true; } catch { return false; }
    },
  });
  for (const copy of copies) {
    requireCatalogRegistry(copy.source);
    if (!javascriptSourceParses(copy.source)) throw new Error(`Invalid ${CATALOG_DESCRIPTION} asset syntax`);
    patchCatalogFactory(copy.moduleSource, copy, presets);
    if (catalogMarkerCount(copy.source) !== catalogMarkerCount(copy.moduleSource)) throw new Error(`Orphan ${CATALOG_DESCRIPTION} marker`);
    markerAssets.delete(copy.assetName);
  }
  if (markerAssets.size > 0) throw new Error(`Orphan ${CATALOG_DESCRIPTION} marker in ${[...markerAssets].join(", ")}`);
  return patchRspackModuleCopies(assetsDir, copies, (source, snapshot) => patchCatalogFactory(source, snapshot, presets), options);
}

function sliderResolverSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "powerSelectionsWithXHigh",
    "fallbackPowerSelection",
    "show_xhigh_in_simple_picker",
    "canInitializePowerPicker",
  ]);
}

// The merged picker builds its Default option from the catalog slider settings
// alone whenever the catalog provides any; version options keep their own
// model list. The configured presets replace the catalog slider settings, so
// this owner must keep using them exclusively for Default.
function defaultOptionBuilderSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "includeSyntheticDefault:",
    "paidModelFallbackEnabled:",
    ".sliderSettings?.length?",
    "defaultOption:",
  ]);
}

function upstreamDefaultSelectionContract(source) {
  const section = defaultOptionBuilderSection(source);
  const catalogParameter = new RegExp(`^function(?: ${IDENT})?\\((${IDENT}),\\{`, "u")
    .exec(section?.source ?? "")?.[1];
  if (catalogParameter == null) return "drifted";
  const catalog = escapeRegExp(catalogParameter);
  const sliderSettings = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=${catalog}\\?\\.sliderSettings\\?\\.length\\?${catalog}\\.sliderSettings:${IDENT}\\(`,
      "gu",
    ),
  )?.[1];
  if (sliderSettings == null) return "drifted";
  const defaultOption = uniqueMatch(
    section.source,
    new RegExp(
      `defaultOption:${IDENT}\\|\\|${IDENT}\\?\\{\\.\\.\\.(${IDENT})\\(${catalog},${IDENT},` +
        `${escapeRegExp(sliderSettings)}\\),isDefault:!0\\}:void 0`,
      "gu",
    ),
  );
  if (defaultOption == null) return "drifted";
  // The option builder lives in the same rspack module factory and must expose
  // its third argument as the power settings.
  const moduleFactory = enclosingModuleFactory(source, section.start);
  const builders = functionSections(moduleFactory?.source ?? "").filter((candidate) =>
    candidate.source.startsWith(`function ${defaultOption[1]}(`)
  );
  if (builders.length !== 1) return "drifted";
  const builder = new RegExp(
    `^function ${escapeRegExp(defaultOption[1])}\\(${IDENT},${IDENT},(${IDENT})\\)\\{`,
    "u",
  ).exec(builders[0].source);
  return builder != null && builders[0].source.endsWith(`powerSettings:${builder[1]}}}`)
    ? "current"
    : "drifted";
}

function upstreamDefaultSelectionAssetMatch(source, _assetName, context = {}) {
  return normalizePresets(context).length > 0 &&
    upstreamDefaultSelectionContract(source) === "current";
}

function upstreamResetEffectSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "fallbackPowerSelection:",
    "isModelSettingsLoading:",
    "onReset:",
    "resetContextKey:",
    "selectedPowerSelectionWithXHigh:",
    ".useEffectEvent)(",
  ]);
}

function upstreamResetEffectAliases(section) {
  const properties = [
    "fallbackPowerSelection",
    "isModelSettingsLoading",
    "onReset",
    "resetContextKey",
    "selectedPowerSelectionWithXHigh",
  ];
  const destructurings = [
    ...(section?.source ?? "").matchAll(
      new RegExp(`\\{([^{}]+)\\}=${IDENT}(?=,|;)`, "gu"),
    ),
  ].filter((match) =>
    properties.every((property) =>
      new RegExp(`(?:^|,)${property}:${IDENT}(?=,|$)`, "u").test(match[1]),
    )
  );
  if (destructurings.length !== 1) return null;
  const aliases = {};
  for (const property of properties) {
    const match = new RegExp(`(?:^|,)${property}:(${IDENT})(?=,|$)`, "u").exec(
      destructurings[0][1],
    );
    if (match == null) return null;
    aliases[property] = match[1];
  }
  return aliases;
}

function uniqueMatch(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function upstreamResetEffectContract(source) {
  const section = upstreamResetEffectSection(source);
  if (section == null) return "drifted";
  const aliases = upstreamResetEffectAliases(section);
  if (aliases == null) return "drifted";
  const {
    fallbackPowerSelection: fallback,
    isModelSettingsLoading: loading,
    onReset,
    resetContextKey: resetContext,
    selectedPowerSelectionWithXHigh: selected,
  } = aliases;

  const resolution = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=(?:${IDENT}|\\(0,${IDENT}\\.${IDENT}\\))\\(\\{[^{}]{0,1200}?canInitializePowerPicker:(${IDENT}),` +
        `[^{}]{0,1200}?fallbackPowerSelection:${fallback},` +
        `[^{}]{0,1200}?menuView:(${IDENT}),` +
        `[^{}]{0,1200}?selectedPowerSelection:${selected},` +
        `[^{}]{0,1200}?showXHighInSimplePicker:(${IDENT})[^{}]{0,1200}?\\}\\)`,
      "gu",
    ),
  );
  if (resolution == null) return "drifted";
  const resolved = resolution[1];
  const canInitialize = resolution[2];
  const menuView = resolution[3];
  const showXHigh = resolution[4];
  const selection = uniqueMatch(
    section.source,
    new RegExp(`(?:let\\s+|,)(${IDENT})=${resolved}(?=,)`, "gu"),
  )?.[1];
  if (selection == null) return "drifted";
  const selectedId = uniqueMatch(
    section.source,
    new RegExp(`(${IDENT})=${selection}\\?\\.id\\?\\?null`, "gu"),
  )?.[1];
  if (selectedId == null) return "drifted";
  const resetScope = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=null==${selectedId}\\?null:\\x60\\$\\{${resetContext}\\}:` +
        `\\$\\{${selectedId}\\}\\x60`,
      "gu",
    ),
  )?.[1];
  if (resetScope == null) return "drifted";
  const resetCallback = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=(${IDENT})=>\\{${selection}\\?\\.id===\\2&&${onReset}\\(${selection}\\)\\}`,
      "gu",
    ),
  )?.[1];
  if (resetCallback == null) return "drifted";
  const resetEvent = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=\\(0,${IDENT}\\.useEffectEvent\\)\\(${resetCallback}\\)`,
      "gu",
    ),
  )?.[1];
  const resetRef = uniqueMatch(
    section.source,
    new RegExp(`(${IDENT})=\\(0,${IDENT}\\.useRef\\)\\(null\\)`, "gu"),
  )?.[1];
  if (resetEvent == null || resetRef == null) return "drifted";

  const effect = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=\\(\\)=>\\{if\\(!${loading}\\)\\{if\\(!(${IDENT})\\)\\{` +
        `${resetRef}\\.current=null;return\\}` +
        `null!=${selectedId}&&null!=${resetScope}&&` +
        `${resetRef}\\.current!==${resetScope}&&\\(${resetRef}\\.current=${resetScope},` +
        `${resetEvent}\\(${selectedId}\\)\\)\\}\\}`,
      "gu",
    ),
  );
  if (effect == null) return "drifted";
  const active = effect[2];
  const pickerReady = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=!${showXHigh}&&${canInitialize}&&([\\x60'"])simple\\2===${menuView}(?=,|;)`,
      "gu",
    ),
  );
  if (pickerReady == null || pickerReady[1] !== active) return "drifted";
  const dependencies = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=\\[${selectedId},${resetScope},${active},${loading}\\]`,
      "gu",
    ),
  );
  if (dependencies == null || effect.index >= dependencies.index) return "drifted";
  const effectRegistration = uniqueMatch(
    section.source,
    new RegExp(
      `\\(0,${IDENT}\\.useEffect\\)\\(${effect[1]},${dependencies[1]}\\)`,
      "gu",
    ),
  );
  if (
    effectRegistration == null ||
    dependencies.index >= effectRegistration.index
  ) {
    return "drifted";
  }
  const auditedScope = section.source;
  const activeOccurrences = [
    ...auditedScope.matchAll(
      new RegExp(`(?<![\\w$])${identifierSpellingPattern(active)}(?![\\w$])`, "gu"),
    ),
  ].map((match) => match.index);
  const effectPredicateIndex =
    effect.index + effect[0].indexOf(`{if(!${active})`) + "{if(!".length;
  const dependencyIndex =
    dependencies.index + dependencies[0].indexOf(`,${active},`) + 1;
  const allowedActiveOccurrences = new Set([
    pickerReady.index,
    effectPredicateIndex,
    dependencyIndex,
  ]);
  // Compiler-cache reads are allowed only when the very next token is one the
  // signed bundle uses after them. Listing the allowed tokens (instead of the
  // forbidden ones) rejects assignments, updates, comments, and line breaks.
  const cacheReadSuffix = "(?=,|\\|\\|(?!=)|\\?(?![?.=]))";
  for (const match of auditedScope.matchAll(
    new RegExp(
      `${IDENT}\\[\\d+\\](?:!==|=)(${escapeRegExp(active)})${cacheReadSuffix}`,
      "gu",
    ),
  )) {
    allowedActiveOccurrences.add(
      match.index + match[0].length - active.length,
    );
  }
  if (
    pickerReady.index >= effect.index ||
    activeOccurrences.length !== allowedActiveOccurrences.size ||
    activeOccurrences.some((index) => !allowedActiveOccurrences.has(index))
  ) {
    return "drifted";
  }
  return "current";
}

function upstreamResetEffectAssetMatch(source, _assetName, context = {}) {
  return normalizePresets(context).length > 0 &&
    upstreamResetEffectContract(source) === "current";
}

function sliderPatchContract(source) {
  const markerCount = source.split(SLIDER_PATCH_MARKER).length - 1;
  const sliderSection = sliderResolverSection(source);
  if (markerCount === 0) {
    return sliderSection != null &&
      (sliderSection.source.match(/\.length>=3/g) ?? []).length === 2
      ? "current" : "drifted";
  }
  if (
    markerCount === 1 &&
    sliderSection != null &&
    sliderSection.source.includes(`/*${SLIDER_PATCH_MARKER}*/`) &&
    (sliderSection.source.match(/\.length>=codexLinuxDefaultPresetMinimum\(/g) ?? []).length === 2 &&
    !sliderSection.source.includes(".length>=3")
  ) {
    return "applied";
  }
  return "mixed";
}

function applySliderMinimumPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (presets.length === 0) {
    return source;
  }
  if (typeof source !== "string") {
    warn("Asset source is not a string", "model picker Default slider minimum patch");
    return source;
  }

  const contract = sliderPatchContract(source);
  if (contract === "applied") {
    return source;
  }
  if (contract !== "current") {
    warn(
      "Could not find one coherent ChatGPT model picker slider resolver contract",
      "model picker Default slider minimum patch",
    );
    return source;
  }

  const sliderSection = sliderResolverSection(source);
  const configuredIds = presets.map(
    ({ modelSlug, thinkingEffort }) =>
      `${modelSlug}:${THINKING_EFFORT_TO_EFFORT[thinkingEffort]}`,
  );
  const patchedSliderSection = sliderSection.source
    .replace(
      "{",
      `{/*${SLIDER_PATCH_MARKER}*/let codexLinuxDefaultPresetIds=new Set(${JSON.stringify(
        configuredIds,
      )}),codexLinuxDefaultPresetMinimum=codexLinuxSelections=>codexLinuxSelections.every(codexLinuxSelection=>codexLinuxDefaultPresetIds.has(codexLinuxSelection.id))?2:3;`,
    )
    .replace(
      /([A-Za-z_$][\w$]*)\.length>=3/g,
      "$1.length>=codexLinuxDefaultPresetMinimum($1)",
    );
  return source.slice(0, sliderSection.start) + patchedSliderSection +
    source.slice(sliderSection.end);
}

function localComposerResolverSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "sliderModelsConfig:",
    "removeXHigh:",
    "stripGptPrefix:",
    ".presets){",
  ]);
}

function localComposerSection(source) {
  const prefix = uniqueFunctionWithMarkers(source, [
    "sliderModelsConfig:",
    "modelsForPicker(",
    "setDefaultModelAndReasoningEffort:",
    "composer.mode.local.model.custom",
  ]);
  return prefix != null && prefix.source.includes("onSelectDefault:") ? prefix : null;
}

function localComposerResolverContract(source) {
  const markerCount = source.split(LOCAL_COMPOSER_RESOLVER_MARKER).length - 1;
  const section = localComposerResolverSection(source);
  if (markerCount === 0) {
    if (section == null) return "drifted";
    const configParameter = /sliderModelsConfig:([A-Za-z_$][\w$]*)/.exec(
      section.source,
    )?.[1];
    if (configParameter == null) return "drifted";
    const thresholds =
      section.source.match(/if\(([A-Za-z_$][\w$]*)\.length>=3\)return \1/gu) ?? [];
    const configLoopThresholds = section.source.match(
      new RegExp(
        `for\\(let [A-Za-z_$][\\w$]* of ${configParameter}\\.presets\\)\\{[\\s\\S]{0,2000}?if\\(([A-Za-z_$][\\w$]*)\\.length>=3\\)return \\1`,
        "gu",
      ),
    );
    return thresholds.length === 2 && configLoopThresholds?.length === 1
      ? "current"
      : "drifted";
  }
  if (
    markerCount === 1 &&
    section != null &&
    section.source.includes(`/*${LOCAL_COMPOSER_RESOLVER_MARKER}*/`) &&
    (section.source.match(/codexLinuxIsConfiguredDefaultPresets\?1:3/g) ?? []).length === 1
  ) {
    return "applied";
  }
  return "mixed";
}

function applyLocalComposerResolverPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (presets.length === 0) return source;
  const contract = localComposerResolverContract(source);
  if (contract === "applied") return source;
  if (contract !== "current") {
    warn(
      "Could not find one coherent local composer slider config resolver contract",
      "model picker Default local composer resolver patch",
    );
    return source;
  }
  const section = localComposerResolverSection(source);
  const configParameter = /sliderModelsConfig:([A-Za-z_$][\w$]*)/.exec(section.source)?.[1];
  if (configParameter == null) return source;
  let patchedSection = section.source.replace(
    new RegExp(
      `(for\\(let [A-Za-z_$][\\w$]* of ${configParameter}\\.presets\\)\\{)`,
      "u",
    ),
    `let codexLinuxIsConfiguredDefaultPresets=${configParameter}?.codexLinuxDefaultPresets===!0/*${LOCAL_COMPOSER_RESOLVER_MARKER}*/;$1`,
  );
  patchedSection = patchedSection.replace(
    new RegExp(
      `(for\\(let [A-Za-z_$][\\w$]* of ${configParameter}\\.presets\\)\\{[\\s\\S]{0,2000}?)if\\(([A-Za-z_$][\\w$]*)\\.length>=3\\)return \\2`,
      "u",
    ),
    "$1if($2.length>=(codexLinuxIsConfiguredDefaultPresets?1:3))return $2",
  );
  const patchedSource =
    source.slice(0, section.start) + patchedSection + source.slice(section.end);
  if (localComposerResolverContract(patchedSource) !== "applied") {
    warn(
      "Could not apply the complete local composer slider config resolver contract",
      "model picker Default local composer resolver patch",
    );
    return source;
  }
  return patchedSource;
}

function localComposerConfig(presets) {
  const configured = presets.map(({ modelSlug, thinkingEffort }) => ({
    model: modelSlug,
    reasoning_effort: THINKING_EFFORT_TO_EFFORT[thinkingEffort],
  }));
  const selectedDefault = presets.find(({ isDefault }) => isDefault);
  return {
    codexLinuxDefaultPresets: true,
    codexLinuxDefaultPresetIds: configured.map(
      ({ model, reasoning_effort: effort }) => `${model}:${effort}`,
    ),
    codexLinuxDefaultPresetId: `${selectedDefault.modelSlug}:${THINKING_EFFORT_TO_EFFORT[selectedDefault.thinkingEffort]}`,
    presets: [configured],
  };
}

function localComposerRuntime(config) {
  return (
    `/*${LOCAL_COMPOSER_CONFIG_MARKER}*/` +
    `const codexLinuxLocalDefaultPresetConfig=${JSON.stringify(config)},` +
    "codexLinuxLocalDefaultPresetIds=new Set(codexLinuxLocalDefaultPresetConfig.codexLinuxDefaultPresetIds);" +
    "function codexLinuxLocalDefaultPresetSelection(codexLinuxSelections){" +
    "let codexLinuxAvailable=codexLinuxSelections.filter(({id:codexLinuxId})=>codexLinuxLocalDefaultPresetIds.has(codexLinuxId));" +
    "return codexLinuxAvailable.find(({id:codexLinuxId})=>codexLinuxId===codexLinuxLocalDefaultPresetConfig.codexLinuxDefaultPresetId)??codexLinuxAvailable[0]??null}" +
    "function codexLinuxLocalDefaultPresetFallback(codexLinuxEnabled,codexLinuxSelections,codexLinuxUpstreamDefault){" +
    "return codexLinuxEnabled?codexLinuxLocalDefaultPresetSelection(codexLinuxSelections)?.id??codexLinuxUpstreamDefault:codexLinuxUpstreamDefault}"
  );
}

const LOCAL_COMPOSER_FALLBACK_PATTERN =
  /([A-Za-z_$][\w$]*)=(\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\(([A-Za-z_$][\w$]*),null==([A-Za-z_$][\w$]*)\?void 0:`\$\{\4\.model\}:\$\{\4\.defaultReasoningEffort\}`\)/gu;
// The composer picks the slider config from one of two ChatGPT-gated sources.
const LOCAL_COMPOSER_CONFIG_PATTERN =
  /sliderModelsConfig:([A-Za-z_$][\w$]*\?[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*)(?=[,}])/gu;
const LOCAL_COMPOSER_SELECTION_PATTERN = new RegExp(
  `async function(?: (?<handler>[A-Za-z_$][\\w$]*))?\\((?<model>[A-Za-z_$][\\w$]*),(?<effort>[A-Za-z_$][\\w$]*)\\)\\{` +
    `[\\s\\S]{0,240}?let (?<normalized>[A-Za-z_$][\\w$]*)=(?<normalizer>[A-Za-z_$][\\w$]*)\\(\\k<model>\\);` +
    `await ?\\(null==(?<delegate>[A-Za-z_$][\\w$]*)\\?(?<base>[A-Za-z_$][\\w$]*)\\(\\k<normalized>,\\k<effort>\\):` +
    `\\k<delegate>\\.setModelAndReasoningEffort\\(\\k<normalized>,\\k<effort>\\)\\)\\}`,
  "gu",
);

function localComposerResetContext(section) {
  const matches = [
    ...(section?.source ?? "").matchAll(
      /resetContextKey:JSON\.stringify\(\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.cwd\]\)/gu,
    ),
  ];
  if (matches.length !== 1) return null;
  const [, conversation, hostId, cwdOwner] = matches[0];
  return { conversation, cwdOwner, hostId };
}

function localComposerConfigContract(source) {
  const markerCount = source.split(LOCAL_COMPOSER_CONFIG_MARKER).length - 1;
  const section = localComposerSection(source);
  if (markerCount === 0) {
    if (section == null) return "drifted";
    const configMatches = section.source.match(LOCAL_COMPOSER_CONFIG_PATTERN) ?? [];
    const fallbackMatches = section.source.match(LOCAL_COMPOSER_FALLBACK_PATTERN) ?? [];
    const selectionMatches = section.source.match(LOCAL_COMPOSER_SELECTION_PATTERN) ?? [];
    return configMatches.length === 1 &&
      fallbackMatches.length === 2 &&
      selectionMatches.length === 1 &&
      localComposerResetContext(section) != null
      ? "current"
      : "drifted";
  }
  if (
    markerCount === 1 &&
    section != null &&
    section.source.includes(`/*${LOCAL_COMPOSER_CONFIG_MARKER}*/`) &&
    section.source.includes(":codexLinuxLocalDefaultPresetConfig") &&
    (section.source.match(/codexLinuxLocalDefaultPresetFallback\(/g) ?? []).length >= 2 &&
    (section.source.match(/codexLinuxLocalDefaultPresetSelection\(/g) ?? []).length >= 1 &&
    (section.source.match(LOCAL_COMPOSER_SELECTION_PATTERN) ?? []).length === 1
  ) {
    return "applied";
  }
  return "mixed";
}

function modelSettingsStateSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "hasManagedNewThreadSettings:",
    "setModelAndReasoningEffortForNextTurn:",
    "No conversation available for next-turn model update",
    "reasoningEffort:",
    "serviceTier:",
  ]);
}

function modelSettingsOptimisticTarget(section) {
  const source = section?.source ?? "";
  const id = "[A-Za-z_$][\\w$]*";
  const pattern = new RegExp(
    `(?<selection>${id})=\\{model:(?<model>${id}),reasoningEffort:(?<effort>${id}),` +
      `serviceTier:(?<serviceTier>[^;}]+)\\};[\\s\\S]{0,400}?` +
      `(?<store>${id})\\.set\\((?<atom>${id}(?:\\.${id})?),(?<target>${id}),\\k<selection>\\),[\\s\\S]{0,800}?` +
      `\\.finally\\(\\(\\)=>\\{(?<cleanup>\\k<store>\\.get\\(\\k<atom>,\\k<target>\\)===` +
      `\\k<selection>&&\\k<store>\\.set\\(\\k<atom>,\\k<target>,null\\))\\}\\)`,
    "gu",
  );
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function chatGptAuthVariable(section) {
  const matches = [
    ...(section?.source ?? "").matchAll(
      /([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.authMethod===(["'`])chatgpt\2(?=[,;])/gu,
    ),
  ];
  return matches.length === 1 ? matches[0][1] : null;
}

function existingChatPresetRuntime(presets) {
  const ids = new Set();
  for (const { modelSlug, thinkingEffort } of presets) {
    ids.add(`${modelSlug}:${THINKING_EFFORT_TO_EFFORT[thinkingEffort]}`);
    ids.add(`${modelSlug}:${thinkingEffort}`);
  }
  return `const ${EXISTING_CHAT_PRESET_IDS_KEY}=new Set(${JSON.stringify([...ids])});`;
}

function existingChatOptimisticContract(source) {
  const markerCount = source.split(EXISTING_CHAT_OPTIMISTIC_MARKER).length - 1;
  const presetIdsCount = source.split(EXISTING_CHAT_PRESET_IDS_KEY).length - 1;
  const modelState = modelSettingsStateSection(source);
  if (markerCount === 0 && presetIdsCount === 0) {
    if (modelState == null) return "drifted";
    return modelSettingsOptimisticTarget(modelState) != null &&
      chatGptAuthVariable(modelState) != null
      ? "current"
      : "drifted";
  }
  if (
    markerCount === 2 &&
    presetIdsCount === 2 &&
    modelState != null &&
    modelState.source.includes(".codexLinuxKeepOptimisticSelection!==!0&&") &&
    modelState.source.includes(`&&${EXISTING_CHAT_PRESET_IDS_KEY}.has(`)
  ) {
    return "applied";
  }
  return "mixed";
}

function applyExistingChatOptimisticPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (presets.length === 0) return source;
  const contract = existingChatOptimisticContract(source);
  if (contract === "applied") return source;
  if (contract !== "current") {
    warn(
      "Could not find one coherent existing-chat optimistic model-selection contract",
      "model picker Default existing-chat selection patch",
    );
    return source;
  }

  const modelState = modelSettingsStateSection(source);
  const optimisticTarget = modelSettingsOptimisticTarget(modelState);
  const chatGptAuth = chatGptAuthVariable(modelState);
  if (optimisticTarget == null || chatGptAuth == null) {
    return source;
  }

  const { groups } = optimisticTarget;
  let patchedModelState = modelState.source.replace(
    optimisticTarget[0],
    optimisticTarget[0]
      .replace(
        `serviceTier:${groups.serviceTier}`,
        `serviceTier:${groups.serviceTier},codexLinuxKeepOptimisticSelection:${chatGptAuth}&&${groups.target}[0]===\`conversation\`&&${EXISTING_CHAT_PRESET_IDS_KEY}.has(${groups.model}+\`:\`+${groups.effort})/*${EXISTING_CHAT_OPTIMISTIC_MARKER}*/`,
      )
      .replace(
        groups.cleanup,
        `${groups.selection}.codexLinuxKeepOptimisticSelection!==!0&&${groups.cleanup}/*${EXISTING_CHAT_OPTIMISTIC_MARKER}*/`,
      ),
  );
  patchedModelState = patchedModelState.replace("{", `{${existingChatPresetRuntime(presets)}`);
  const patchedSource =
    source.slice(0, modelState.start) +
    patchedModelState +
    source.slice(modelState.end);
  if (existingChatOptimisticContract(patchedSource) !== "applied") {
    warn(
      "Could not apply the complete existing-chat optimistic model-selection contract",
      "model picker Default existing-chat selection patch",
    );
    return source;
  }
  return patchedSource;
}

function applyLocalComposerConfigPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (presets.length === 0) return source;
  const contract = localComposerConfigContract(source);
  if (contract === "applied") return source;
  if (contract !== "current") {
    warn(
      "Could not find one coherent local composer model picker contract",
      "model picker Default local composer config patch",
    );
    return source;
  }
  const section = localComposerSection(source);
  const configMatches = [...section.source.matchAll(LOCAL_COMPOSER_CONFIG_PATTERN)];
  const configMatch = configMatches.length === 1 ? configMatches[0] : null;
  const fallbackMatches = [...section.source.matchAll(LOCAL_COMPOSER_FALLBACK_PATTERN)];
  const selectionMatches = [...section.source.matchAll(LOCAL_COMPOSER_SELECTION_PATTERN)];
  const resetContext = localComposerResetContext(section);
  if (
    configMatch == null ||
    fallbackMatches.length !== 2 ||
    selectionMatches.length !== 1 ||
    resetContext == null
  ) {
    return source;
  }
  const configExpression = `(${configMatch[1]})`;
  let patchedSection = section.source.replace(
    configMatch[0],
    () =>
      `sliderModelsConfig:${configExpression}==null?${configExpression}:codexLinuxLocalDefaultPresetConfig`,
  );
  patchedSection = patchedSection.replace(
    LOCAL_COMPOSER_FALLBACK_PATTERN,
    (_match, result, resolver, selections, upstreamDefault) =>
      `${result}=${resolver}(${selections},codexLinuxLocalDefaultPresetFallback(` +
      `${configExpression}!=null,${selections},null==${upstreamDefault}?void 0:` +
      `\`\${${upstreamDefault}.model}:\${${upstreamDefault}.defaultReasoningEffort}\`))`,
  );
  patchedSection = patchedSection.replace(
    "{",
    `{${localComposerRuntime(localComposerConfig(presets))}`,
  );
  const patchedSource =
    source.slice(0, section.start) +
    patchedSection +
    source.slice(section.end);
  if (localComposerConfigContract(patchedSource) !== "applied") {
    warn(
      "Could not apply the complete local composer model picker contract",
      "model picker Default local composer config patch",
    );
    return source;
  }
  return patchedSource;
}

function catalogAssetMatch(source, _assetName, context = {}) {
  return catalogPatchContract(source, context) !== "drifted";
}

function sliderAssetMatch(source, _assetName, context = {}) {
  const presets = normalizePresets(context);
  return presets.length > 0 && sliderPatchContract(source) !== "drifted";
}

const descriptors = [
  {
    id: "model-picker-default-presets-upstream-default-selection",
    phase: "webview-asset",
    order: 20_797,
    ciPolicy: "optional",
    assetNeedles: ["includeSyntheticDefault:", "paidModelFallbackEnabled:", ".sliderSettings?.length?"],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: upstreamDefaultSelectionAssetMatch,
    missingDescription: "upstream merged model picker Default-selection bundle",
    skipDescription: "model picker upstream Default-selection compatibility audit",
    apply: (source) => source,
  },
  {
    id: "model-picker-default-presets-upstream-reset-effect",
    phase: "webview-asset",
    order: 20_797.5,
    ciPolicy: "optional",
    assetNeedles: ["resetContextKey:", "selectedPowerSelectionWithXHigh:", "fallbackPowerSelection:", "onReset:"],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: upstreamResetEffectAssetMatch,
    missingDescription: "upstream model picker reset-effect bundle",
    skipDescription: "model picker upstream reset-effect compatibility audit",
    apply: (source) => source,
  },
  {
    id: "model-picker-default-presets-catalog",
    phase: "extracted-app:pre-webview",
    order: 20_798,
    ciPolicy: "optional",
    enabled: (context = {}) => {
      normalizePresets(context);
      return true;
    },
    apply: patchCatalog,
  },
  {
    id: "model-picker-default-presets-slider-minimum",
    phase: "webview-asset",
    order: 20_799,
    ciPolicy: "optional",
    assetNeedles: ["show_xhigh_in_simple_picker", "powerSelectionsWithXHigh"],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: sliderAssetMatch,
    missingDescription: "ChatGPT model picker slider resolver bundle",
    skipDescription: "model picker Default slider minimum patch",
    apply: applySliderMinimumPatch,
  },
  {
    id: "model-picker-default-presets-local-composer-resolver",
    phase: "webview-asset",
    order: 20_800,
    ciPolicy: "optional",
    assetNeedles: ["removeXHigh:", "sliderModelsConfig:", "stripGptPrefix:"],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: (source) => localComposerResolverContract(source) !== "drifted",
    missingDescription: "local composer slider config resolver bundle",
    skipDescription: "model picker Default local composer resolver patch",
    apply: applyLocalComposerResolverPatch,
  },
  {
    id: "model-picker-default-presets-existing-chat-optimistic-selection",
    phase: "webview-asset",
    order: 20_801,
    ciPolicy: "optional",
    assetNeedles: [
      "No conversation available for next-turn model update",
      "setModelAndReasoningEffortForNextTurn:",
      "hasManagedNewThreadSettings:",
    ],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    missingDescription: "existing-chat model settings state bundle",
    skipDescription: "model picker Default existing-chat selection patch",
    apply: applyExistingChatOptimisticPatch,
  },
  {
    id: "model-picker-default-presets-local-composer-config",
    phase: "webview-asset",
    order: 20_802,
    ciPolicy: "optional",
    assetNeedles: [
      "composer.mode.local.model.custom",
      "sliderModelsConfig:",
      "setDefaultModelAndReasoningEffort",
      "modelsForPicker(",
    ],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: (source) => localComposerConfigContract(source) !== "drifted",
    missingDescription: "local composer model picker bundle",
    skipDescription: "model picker Default local composer config patch",
    apply: applyLocalComposerConfigPatch,
  },
];

module.exports = {
  CATALOG_PATCH_MARKER,
  EFFORT_TO_THINKING_EFFORT,
  EXISTING_CHAT_OPTIMISTIC_MARKER,
  LOCAL_COMPOSER_CONFIG_MARKER,
  LOCAL_COMPOSER_RESOLVER_MARKER,
  LOCAL_DEFAULT_PATCH_MARKER,
  THINKING_EFFORT_TO_EFFORT,
  SLIDER_PATCH_MARKER,
  applyCatalogPatch,
  patchCatalog,
  applyExistingChatOptimisticPatch,
  applyLocalComposerConfigPatch,
  applyLocalComposerResolverPatch,
  applySliderMinimumPatch,
  catalogAssetMatch,
  catalogPatchContract,
  codexLinuxModelPickerDefaultPresets,
  descriptors,
  normalizePresets,
  existingChatOptimisticContract,
  localComposerConfig,
  localComposerConfigContract,
  localComposerResolverContract,
  sliderAssetMatch,
  sliderPatchContract,
  upstreamDefaultSelectionAssetMatch,
  upstreamDefaultSelectionContract,
  upstreamResetEffectAssetMatch,
  upstreamResetEffectContract,
};
