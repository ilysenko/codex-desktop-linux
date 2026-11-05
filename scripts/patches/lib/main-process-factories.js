"use strict";

const { Script } = require("node:vm");
const { findMatchingBrace } = require("./minified-js.js");
const IDENT = "[A-Za-z_$][\\w$]*";

function codeAt(source, index) {
  return findMatchingBrace("{" + source.slice(0, index) + "}".repeat(index + 2), 0) >= index + 1;
}
function statementAt(source, index) {
  if (!codeAt(source, index) || findMatchingBrace("{" + source.slice(0, index) + "}", 0) !== index + 1) return false;
  try { new Script(source.slice(0, index) + "\nconst mainFactoryStatement=0;\n"); return true; }
  catch { return false; }
}
function codeMatches(source, pattern) {
  return [...source.matchAll(pattern)].filter(match => codeAt(source, match.index));
}

// Main-process CommonJS chunks use numeric/string method-style factories.
// Ranges delimit the original body contents. Keep the snapshot shape shared
// with the strict Portal owner plan so callers can reuse this parser directly.
function mainProcessFactories(source) {
  new Script(source);
  const headers = codeMatches(source, /(?<![\w$.])exports\.ids=\[[\d,eE+\-]*\],exports\.modules=\{/gu)
    .filter(match => statementAt(source, match.index));
  if (headers.length === 0) {
    if (codeMatches(source, /(?<![\w$.])exports\s*(?:\.\s*(?:ids|modules)|\[\s*["'](?:ids|modules)["']\s*\])/gu).length) {
      throw new Error("Unsupported main CommonJS factory carrier");
    }
    return [];
  }
  if (headers.length !== 1) throw new Error("Expected exactly one main CommonJS factory carrier");
  const [header] = headers;
  const exportsReferences = codeMatches(source, /(?<![\w$.])exports(?=\s*[.\[])/gu);
  const expectedReferences = new Set([header.index, header.index + header[0].indexOf("exports.modules")]);
  if (exportsReferences.length !== 2 || exportsReferences.some(match => !expectedReferences.has(match.index))) {
    throw new Error("Main CommonJS carrier is overwritten or aliased");
  }
  const key = `(?:"(?:\\\\.|[^"\\\\])*"|${IDENT}|0[xX][\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`;
  const member = new RegExp(`(${key})\\((${IDENT}(?:,${IDENT}){0,2})?\\)\\{`, "uy");
  const result = [], identities = new Set();
  let cursor = header.index + header[0].length;
  for (;;) {
    while (/\s/u.test(source[cursor] ?? "") && cursor < source.length) cursor++;
    if (source[cursor] === "}") return result;
    member.lastIndex = cursor;
    const found = member.exec(source);
    if (!found) throw new Error("Unsupported main CommonJS factory member");
    let identity = found[1];
    if (identity.startsWith('"')) identity = JSON.parse(identity);
    else if (/^\d/u.test(identity)) {
      const numeric = Number(identity);
      if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error("Unsafe main factory identity");
      identity = String(numeric);
    }
    if (identities.has(identity)) throw new Error("Duplicate main factory identity");
    identities.add(identity);
    const start = member.lastIndex, end = findMatchingBrace(source, start - 1);
    if (end < start) throw new Error("Incomplete main CommonJS factory");
    result.push({ identity, start, end, body: source.slice(start, end), parameters: found[2]?.split(",") ?? [] });
    cursor = end + 1;
    while (/\s/u.test(source[cursor] ?? "") && cursor < source.length) cursor++;
    if (source[cursor] === "}") return result;
    if (source[cursor++] !== ",") throw new Error("Invalid main factory separator");
  }
}

module.exports = { mainProcessFactories };
