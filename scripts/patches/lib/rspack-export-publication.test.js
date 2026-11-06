"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { findRspackExportPublication } = require("./rspack-export-publication.js");

function snapshot(body) {
  return { moduleSource: body, params: ["module", "exports", "require"], moduleId: "Role", start: 0, end: body.length };
}
test("getter, direct binding and direct function publications preserve exact function ranges", () => {
  const getter = findRspackExportPublication(snapshot('function gate(e){return e}require.d(exports,{gate:()=>gate})'), "gate");
  assert.equal(getter.expression, "gate");
  const binding = findRspackExportPublication(snapshot('function gate(e){return e}require.d(exports,{},{gate:gate})'), "gate");
  assert.equal(binding.expression, "gate");
  const body = 'require.d(exports,{},{other:function(a,b){return a+b},gate:function(e){let value={nested:[1,2]};return e}})';
  const direct = findRspackExportPublication(snapshot(body), "gate");
  assert.equal(direct.expression, null);
  assert.equal(direct.exportName, "gate");
  assert.equal(direct.fn.params, "e");
  assert.equal(body.slice(direct.fn.start, direct.fn.end), 'function(e){let value={nested:[1,2]};return e}');
  assert.equal(direct.fn.body, 'let value={nested:[1,2]};return e');
});

test("export authority rejects ambiguity, dynamic members and disconnected publication", () => {
  for (const body of [
    'require.d(exports,{gate:()=>gate},{gate:function(e){return e}})',
    'require.d(exports,{},{gate:function(e){return e},gate:other})',
    'require.d(exports,{gate:()=>gate,gate:()=>other})',
    'require.d(exports,{},{...other,gate:function(e){return e}})',
    'require.d(exports,{},{["gate"]:function(e){return e}})',
    'require.d(exports,{},{__proto__:other,gate:function(e){return e}})',
    'require.d(exports,{},{gate:function(e){return e}&&other})',
    'if(false)require.d(exports,{},{gate:function(e){return e}})',
    'return;require.d(exports,{},{gate:function(e){return e}})',
    'throw Error("dead");require.d(exports,{},{gate:function(e){return e}})',
    'require.d(exports,{},{gate:function(e){return e},other:???})',
    '(()=>require.d(exports,{},{gate:function(e){return e}}))',
    'other.d(exports,{},{gate:function(e){return e}})',
    'require.d(other,{},{gate:function(e){return e}})',
    'require={d(){}};require.d(exports,{},{gate:function(e){return e}})',
    '({require}=other);require.d(exports,{},{gate:function(e){return e}})',
    '({exports}=other);require.d(exports,{},{gate:function(e){return e}})',
    '[require]=[other];require.d(exports,{},{gate:function(e){return e}})',
    String.raw`\u0072equire=other;require.d(exports,{},{gate:function(e){return e}})`,
    String.raw`({value:\u0065xports}=other);require.d(exports,{},{gate:function(e){return e}})`,
    'function shadow(exports){require=other}require.d(exports,{},{gate:function(e){return e}})',
    'function shadow(require){exports=other}require.d(exports,{},{gate:function(e){return e}})',
    'function shadow(){{let require;}require=other}require.d(exports,{},{gate:function(e){return e}})',
    'function shadow(){for(let require of values){}require=other}require.d(exports,{},{gate:function(e){return e}})',
    String.raw`function shadow(exports){({value:\u0072equire}=other)}require.d(exports,{},{gate:function(e){return e}})`,
    'function exports(){}require.d(exports,{},{gate:function(e){return e}})',
    'require.d(exports,{gate:()=>gate});require.d(exports,{},{other:other})',
  ]) assert.equal(findRspackExportPublication(snapshot(body), "gate"), null, body);
});


test("publication requires three real factory parameters and preserves native local shadows", () => {
  const source = 'fake.d(unowned,{},{gate:function(e){return e}})';
  for (const params of [undefined, [], ["module", "unowned"], ["module", "unowned", "unowned"]]) {
    assert.equal(findRspackExportPublication({moduleSource:source,params}, "gate"), null);
  }
  for (const local of [
    'function local(require,exports){require=other,exports=other}',
    'const local=(require,exports)=>{require=other,exports=other};',
    'const local=(value,{get:require})=>require(value);',
    'const local=(value,{get:exports})=>exports(value);',
    '{let require;require=other;}',
    'for(let require of values){require=other;}',
    String.raw`function local(\u0072equire){require=other}`,
  ]) {
    const module = snapshot(local+'require.d(exports,{},{gate:function(e){return e}})');
    assert.ok(findRspackExportPublication(module,"gate"),local);
  }
});

test("large getter barrels remain bounded and source changes invalidate lexical views", { timeout: 15000 }, () => {
  const entries = Array.from({ length: 1000 }, (_, index) => `item${index}:()=>binding${index}`).join(",");
  const module = snapshot(`require.d(exports,{${entries}})`);
  assert.equal(findRspackExportPublication(module, "item999").expression, "binding999");
  module.moduleSource = '({require}=other);' + module.moduleSource;
  assert.equal(findRspackExportPublication(module, "item999"), null);
  module.moduleSource = module.moduleSource.slice('({require}=other);'.length);
  assert.equal(findRspackExportPublication(module, "item999").expression, "binding999");
});

test("complete lexical state rejects writes in template substitutions and ignores regex text", () => {
  const broken = snapshot('const note=`${require=other}`;require.d(exports,{},{gate:function(e){return e}})');
  assert.equal(findRspackExportPublication(broken,"gate"),null);
  const valid = snapshot('const pattern=/require=other/g;require.d(exports,{},{gate:function(e){return e}})');
  assert.ok(findRspackExportPublication(valid,"gate"));
});

test("class methods keep native local parameters and property names separate from outer writes", () => {
  const publish = 'require.d(exports,{},{gate:function(e){return e}})';
  for (const source of [
    'class Local{begin(event,require){require=other}}',
    'class Local{begin({get:require}){require=other}}',
    'class Local{require(){return exports}}',
    'class Local{exports=1}',
    'class Local{#require;write(){this.#require=other}}',
    'const Local=class require{read(){return require}};',
  ]) assert.ok(findRspackExportPublication(snapshot(source+publish),"gate"),source);
  for (const source of [
    'class Local{begin(exports){require=other}}',
    'class Local{begin(require){exports=other}}',
    'class Local{field=(require=other)}',
    'class Local{static{({require}=other)}}',
    'class Local{#exports;write(){require=other}}',
  ]) assert.equal(findRspackExportPublication(snapshot(source+publish),"gate"),null,source);
});
