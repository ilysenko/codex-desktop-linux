"use strict";
const assert = require("node:assert/strict");
const ID = "[A-Za-z_$][\\w$]*";
const STRING = '"(?:\\\\.|[^"\\\\])*"';
const MARKER = "codexLinuxRemoteExperimentalFilter";
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function qualifiedFunction(copy, refs) {
  assert.equal(copy.moduleId, refs.filterModuleId, "filter publication identity");
  assert.equal(copy.params.length, 3);
  assert.equal(new Set(copy.params).size, 3);
  assert.ok(copy.params.every(name => new RegExp(`^${ID}$`, "u").test(name)));
  const [, exports, req] = copy.params;
  function pattern(patched) {
    const feature = "\\k<feature>";
    const predicate = `return"beta"===${feature}\\.stage&&${feature}\\.name!==\\k<memory>\\.j` +
      `&&"multi_agent"!==${feature}\\.name&&"plugins"!==${feature}\\.name&&"plugin"!==${feature}\\.name` +
      (patched ? "" : `&&"remote_control"!==${feature}\\.name`) +
      `&&!${feature}\\.name\\.startsWith\\("realtime_"\\)&&${feature}\\.name!==\\k<chronicle>\\.c&&${feature}\\.name!==\\k<api>\\.R1o` +
      (patched ? `/\\*${MARKER}\\*/` : "");
    return new RegExp(`^var (?<api>${ID})=${escape(req)}\\((?<apiId>${STRING})\\),` +
      `(?<memory>${ID})=${escape(req)}\\((?<memoryId>${STRING})\\),` +
      `(?<chronicle>${ID})=${escape(req)}\\((?<chronicleId>${STRING})\\);` +
      `${escape(req)}\\.d\\(${escape(exports)},\\{\\},\\{R:function\\((?<feature>${ID})\\)\\{(?<body>${predicate})\\}\\}\\)$`, "du");
  }
  const pristine = pattern(false).exec(copy.moduleSource), canonical = pattern(true).exec(copy.moduleSource);
  assert.equal(Number(pristine != null) + Number(canonical != null), 1, "complete native/canonical function grammar");
  const match = pristine ?? canonical, role = match.groups;
  assert.equal(new Set([role.api, role.memory, role.chronicle, role.feature]).size, 4, "unshadowed predicate providers");
  assert.ok([role.api, role.memory, role.chronicle].every(name => !copy.params.includes(name)), "factory loader/export binding");
  assert.equal(JSON.parse(role.apiId), refs.imports.api);
  assert.equal(JSON.parse(role.memoryId), refs.imports.memory);
  assert.equal(JSON.parse(role.chronicleId), refs.imports.chronicle);
  return { patched: canonical != null, role, body: role.body, bounds: match.indices.groups.body };
}

module.exports = { qualifiedFunction, MARKER };
