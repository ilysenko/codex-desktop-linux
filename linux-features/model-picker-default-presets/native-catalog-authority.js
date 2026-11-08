"use strict";
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {assertUnambiguousModelComposerLexicalSource:assertLexical}=require("../../scripts/patches/lib/model-composer-lexical-guard.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findRspackRequireBinding}=require("../../scripts/patches/lib/rspack-module-assets.js");
const IDENT="[A-Za-z_$][\\w$]*";
const CATALOG_PATCH_MARKER="codexLinuxModelPickerDefaultPresets";
const CATALOG_CONFIG_NAME="codexLinuxDefaultPresetsConfigured";
const CATALOG_DESCRIPTION = "current ChatGPT model catalog normalizer";
const CATALOG_NEEDLES = [".slider_settings.flatMap(", "serviceTiersByModelSlug:", "modelConfigBySlug:", "workspaceModelPolicy:"];
const catalogMarkerCount = source => [CATALOG_PATCH_MARKER, CATALOG_CONFIG_NAME]
  .reduce((total, name) => total + source.split(name).length - 1, 0);



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

function catalogReturnedObject(source, publication) {
  const { start, end } = publication.fn;
  const bodyStart = source.indexOf("{", start) + 1, bodyEnd = end - 1;
  const body = source.slice(bodyStart, bodyEnd), lexical = createJavaScriptLexicalIndex(source);
  const returned = catalogOne(body, /\breturn\b/gu, "native return");
  const returnEnd = bodyStart + returned.index + returned[0].length;
  let open = returnEnd;
  while (/\s/u.test(source[open] ?? "") && open < bodyEnd) open++;
  const close = lexical.matchingBrace(open);
  if (source[open] !== "{" || close < open || source.slice(close + 1, bodyEnd).trimEnd() !== "") {
    throw new Error(`Unsupported ${CATALOG_DESCRIPTION} final return object`);
  }
  return { open, close, wrapperStart:null, suffix:"", bodyStart, bodyEnd };
}


// Native publication and initializer ownership are established separately.
// Project only that proven initializer's binder to a fresh local and treat the
// captured binding as a parameter of a syntax-only probe. The existing Rspack
// parameter-authority checker then rejects writes/redeclarations at any depth,
// including escaped spellings, while retaining real local shadows/member keys.
// This synthetic publication is only a readonly-binding proof, never an owner.
function requireStableCatalogBinding(source,name,initializer=null){return require("./catalog-binding-authority.js").requireStableCatalogBinding(source,name,initializer)}

// Latest signed stable has one published schema-normalizing function. The
// legacy catalog+flattened-selection-resolver format is deliberately absent.
function inspectNativeCatalog(source, snapshot) {
  assertLexical(source,createJavaScriptLexicalIndex(source));
  for(const name of snapshot?.params?.slice(1)??[])requireStableCatalogBinding(source,name);
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
module.exports={inspectNativeCatalog,requireStableBinding:requireStableCatalogBinding,requireRegistry:requireCatalogRegistry};
