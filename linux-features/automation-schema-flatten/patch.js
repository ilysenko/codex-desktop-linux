"use strict";

/**
 * Matches the codex_app tool emitter's special-case line:
 *
 *   return e.name===`automation_update`&&delete t.deferLoading,t
 *
 * The emitter is minified so identifiers are captured generically. The line
 * always returns the tool object via the comma operator, which is what makes
 * this single-line rewrite safe. The match ends right after the comma-tool
 * expression so any trailing punctuation (typically `}` for the map callback,
 * but possibly `;` or `]`) is preserved verbatim.
 */
const EMITTER_PATTERN =
  /return\s+([A-Za-z_$][\w$]*)\.name===\s*`automation_update`\s*&&\s*delete\s+([A-Za-z_$][\w$]*)\.deferLoading\s*,\s*\2(?=[^\w$])/;

function buildReplacement(obj, tool) {
  // `tool` is the minified variable that holds the emitted tool object.
  return (
    `if(${obj}.name===\`automation_update\`){delete ${tool}.deferLoading;` +
    `let s=${tool}.inputSchema;` +
    `if(s&&typeof s===\`object\`&&!s.type&&Array.isArray(s.oneOf)){` +
    `let p={},r=[];function merge(x){` +
    `if(x&&x.properties)Object.assign(p,x.properties);` +
    `if(Array.isArray(x.required))r.push(...x.required);` +
    `if(Array.isArray(x.oneOf))x.oneOf.forEach(merge)` +
    `}merge(s);` +
    `let o={type:\`object\`,properties:p,additionalProperties:!0};` +
    `if(r.length)o.required=[...new Set(r)];` +
    `${tool}.inputSchema=o}` +
    `}return ${tool}`
  );
}

function applyAutomationSchemaFlattenPatch(source) {
  const match = source.match(EMITTER_PATTERN);
  if (match == null) {
    console.warn(
      "WARN: automation_update tool emitter not found — skipping automation schema flatten patch",
    );
    return source;
  }
  return source.replace(
    EMITTER_PATTERN,
    buildReplacement(match[1], match[2]),
  );
}

module.exports = {
  descriptors: [
    {
      id: "automation-schema-flatten-webview",
      phase: "webview-asset",
      order: 2000,
      ciPolicy: "optional",
      pattern: /^app-initial-.*\.js$/,
      missingDescription: "codex_app webview bundle",
      skipDescription: "automation schema flatten patch",
      apply: applyAutomationSchemaFlattenPatch,
    },
  ],
};
