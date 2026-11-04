"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { RUNTIME, runtimeVisibility, withRuntime } = require("./runtime.js");

const call = "codexLinuxReasoningVisibilityEnabled()";
const factory = (name, body) => `${name}(e,t,n){${body}}`;
const chunk = (...factories) => `export const __webpack_modules__={${factories.join(",")}};`;
const targetIn = source => source.lastIndexOf(call);

test("direct supplied-scope helpers remain visible after balanced syntax and other feature prefixes", () => {
  for (const prefix of ["", 'function other(){return {x:`${{y:1}.y}`}}', 'const pattern=/[{}]/;/* balanced {} */', '// previous feature\n']) {
    const source = `${prefix}${RUNTIME}\nfunction owner(){return ${call}}`;
    assert.equal(runtimeVisibility(source, targetIn(source)), "visible");
    assert.equal(withRuntime(source, targetIn(source)), source);
    assert.equal(vm.runInNewContext(`${source};owner()`, { localStorage: { getItem: () => "1" } }), true);
  }
});

test("a sibling factory helper is complete but invisible at the owning factory callsite", () => {
  const source = chunk(factory("Sibling", RUNTIME), factory("Owner", `return ${call}`));
  assert.equal(runtimeVisibility(source, targetIn(source)), "inaccessible");
  const execute = source.replace("export const __webpack_modules__=", "const factories=") + ";factories.Owner()";
  assert.throws(() => vm.runInNewContext(execute), /codexLinuxReasoningVisibilityEnabled is not defined/);
  const normalized = withRuntime(source, targetIn(source));
  assert.equal(runtimeVisibility(normalized, targetIn(normalized)), "visible");
});

test("ordinary nested functions, arrow callbacks, methods, and blocks cannot conceal an applied helper", () => {
  for (const hidden of [
    `function unused(){${RUNTIME}}`, `const unused=()=>{${RUNTIME}};`,
    `const object={unused(){${RUNTIME}}};`, `if(false){${RUNTIME}}`,
  ]) {
    const source = `${hidden}function owner(){return ${call}}`;
    assert.equal(runtimeVisibility(source, targetIn(source)), "invalid");
    assert.throws(() => withRuntime(source, targetIn(source)), /misplaced/);
    assert.throws(() => vm.runInNewContext(`${source};owner()`), /codexLinuxReasoningVisibilityEnabled is not (?:defined|a function)|reasoningVisibilitySnapshot/);
  }
});

test("comment and template-literal copies are rejected without inventing a new line", () => {
  for (const source of [
    `/*${RUNTIME}*/function owner(){return ${call}}`,
    `// ${RUNTIME}\nfunction owner(){return ${call}}`,
    "const text=`" + RUNTIME + "`;function owner(){return " + call + "}",
  ]) {
    assert.equal(runtimeVisibility(source, targetIn(source)), "invalid");
    assert.throws(() => withRuntime(source), /misplaced/);
  }
});

test("own-factory helpers are visible to nested owner functions but not sibling factories", () => {
  const source = chunk(factory("Owner", `${RUNTIME}function nested(){return ${call}}return nested()`),
    factory("Sibling", `return ${call}`));
  const ownTarget = source.indexOf("return " + call) + "return ".length;
  assert.equal(runtimeVisibility(source, ownTarget), "visible");
  assert.equal(runtimeVisibility(source, targetIn(source)), "inaccessible");
  assert.equal(withRuntime(source, ownTarget), source);
  const execute = source.replace("export const __webpack_modules__=", "const factories=") + ";factories.Owner()";
  assert.equal(vm.runInNewContext(execute, { localStorage: { getItem: () => "1" } }), true);
});

test("legitimate outer and distinct factory helpers share one immutable session preference snapshot", () => {
  const source = `${RUNTIME}${chunk(factory("First", `${RUNTIME}return ${call}`), factory("Second", `${RUNTIME}return ${call}`))}`;
  assert.equal(runtimeVisibility(source, targetIn(source)), "visible");
  assert.equal(withRuntime(source), source);
  let enabled = true;
  const context = vm.createContext({ localStorage: { getItem: () => enabled ? "1" : null } });
  vm.runInContext(source.replace("export const __webpack_modules__=", "globalThis.factories="), context);
  enabled = false;
  assert.equal(vm.runInContext("factories.First()", context), true);
  assert.equal(vm.runInContext("factories.Second()", context), true);
});

test("duplicate helpers in one scope and incomplete declarations remain invalid", () => {
  for (const source of [RUNTIME + RUNTIME + call,
    chunk(factory("Owner", RUNTIME + RUNTIME + call)),
    RUNTIME.replace("codexLinuxReasoningVisibilityActive", "changed") + call]) {
    assert.equal(runtimeVisibility(source, targetIn(source)), "invalid");
  }
  assert.equal(runtimeVisibility("function owner(){}"), "absent");
});
