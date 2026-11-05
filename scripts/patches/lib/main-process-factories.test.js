"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { mainProcessFactories } = require("./main-process-factories.js");

const chunk = members => `"use strict";exports.ids=[747],exports.modules={${members}};`;

test("current CJS factories retain original ranges and canonical numeric identities", () => {
  const source = chunk('9e4(e,t,r){const value="nested }";return value},"66439"(a,b,c){return 42},0x1234(){return null}');
  const modules = mainProcessFactories(source);
  assert.deepEqual(modules.map(({ identity, parameters }) => ({ identity, parameters })), [
    { identity: "90000", parameters: ["e", "t", "r"] },
    { identity: "66439", parameters: ["a", "b", "c"] },
    { identity: "4660", parameters: [] },
  ]);
  for (const module of modules) assert.equal(source.slice(module.start, module.end), module.body);
  assert.equal(modules[1].body, "return 42");
});

test("ordinary entries and literal carrier text remain unrelated", () => {
  for (const source of ['const entry=true;', 'const note="exports.ids=[1],exports.modules={1(){}}";', '/* exports.ids=[1],exports.modules={1(){}} */']) {
    assert.deepEqual(mainProcessFactories(source), []);
  }
});

test("duplicate canonical identities, fake headers and unsupported carriers fail closed", () => {
  for (const source of [
    chunk('9e4(){},90000(){}'), chunk('"90000"(){},9e4(){}'), chunk('0x1234(){},4660(){}'),
    chunk('"\\u0039\\u0030\\u0030\\u0030\\u0030"(){},9e4(){}'),
    chunk('9007199254740992(){}'), chunk('...{}'), chunk('get 90000(){}'),
    chunk('90000(){}') + 'exports.modules={};',
    'exports.ids=[1];exports.modules={1(){}};',
    'exports["ids"]=[1],exports["modules"]={1(){}};',
    'false&&(exports.ids=[1],exports.modules={1(){}});',
    chunk('90000(){}') + '{',
  ]) assert.throws(() => mainProcessFactories(source), source);
});

test("all latest signed main chunks parse with scientific IDs and strict prefixes", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const build = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite/build");
  const files = fs.readdirSync(build).filter(name => /^early-bootstrap.*\.js$/u.test(name));
  let modules = [], strictPrefix = false, scientific = false;
  for (const name of files) {
    const source = fs.readFileSync(path.join(build, name), "utf8");
    const factories = mainProcessFactories(source);
    modules.push(...factories);
    strictPrefix ||= source.startsWith('"use strict";exports.ids=') && factories.length > 0;
    scientific ||= /(?:^|,)9e4\(/u.test(source) && factories.some(module => module.identity === "90000");
    for (const module of factories) assert.equal(source.slice(module.start, module.end), module.body);
  }
  assert.ok(modules.length > 0);
  assert.equal(strictPrefix, true);
  assert.equal(scientific, true);
});
