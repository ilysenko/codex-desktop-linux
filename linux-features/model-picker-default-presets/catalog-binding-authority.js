"use strict";
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {assertUnambiguousModelComposerLexicalSource:assertLexical}=require("../../scripts/patches/lib/model-composer-lexical-guard.js");
const CATALOG_DESCRIPTION="current model composer binding";
const catalogBindingProofs=new Map();
function requireStableCatalogBinding(source, name, initializer = null) {
  assertLexical(source,createJavaScriptLexicalIndex(source));
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
      const gap=projected.slice(Math.max(0,token.index-3),token.index)==="..."?" ":"";
      projected = projected.slice(0,token.index) + gap + name + projected.slice(token.index + token[0].length);
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
module.exports={requireStableCatalogBinding};
