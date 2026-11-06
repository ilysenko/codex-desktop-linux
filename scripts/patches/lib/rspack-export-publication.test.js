"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex } = require("./minified-js.js");
const { mainProcessFactories } = require("./main-process-factories.js");
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

function nativeSnapshot(local) {
  const moduleSource = local + 'n.d(t,{iRL:()=>eK.iR});var eK=n(84766);';
  new Script(`"use strict";function nativeFactory(e,t,n){${moduleSource}}`);
  return { moduleSource, params: ["e", "t", "n"] };
}
const nativePublication = { requireName: "n", exportsName: "t", expression: "eK.iR" };

test("native factory local scopes retain full parameter authority in the fourteen diagnosed cases", () => {
  for (const local of [
    "",
    'class B{emit(e,t){return t}}',
    'class B{emit(e,t=Date.now()){return t}}',
    'class B{emit(e){for(let n of this.handlers)n(e)}}',
    'class B{emit(e){for(let n of this.handlers){n(e)}}}',
    'class B{prune(){for(let[t,n]of this.items)this.remove(t,n)}}',
    'class B{#e;close(e,t){let n=this.#e;return n?.id!==t}}',
    'class B{close(e,t){let n=this.map;return n?.id!==t}}',
    'async function sn(){for await(let n of values){n()}}',
    'const local=async function*(){let n=1;yield n};',
  ]) assert.deepEqual(findRspackExportPublication(nativeSnapshot(local), "iRL"), nativePublication, local);
  for (const local of [
    'n=other;',
    'class B{emit(t){n=other}}',
    'class B{#e;emit(t){this.#e;n=other}}',
    'class B{emit(){for(let n of this.handlers)t=other}}',
  ]) assert.equal(findRspackExportPublication(nativeSnapshot(local), "iRL"), null, local);
});

test("balanced callable parameters and native loop branches preserve their actual local bindings", () => {
  for (const local of [
    'class B{emit(e,t=Date.now()){for(let n of this.handlers)n({type:e,at:t})}}',
    'async function sn(e,t){for await(let n of async function*(){let n=new Set;yield n}(e))if(n.threadId!==t)return!0;return!1}',
    'class B{#state;run(t=this.#state){let n=t;return n}}',
    'function run(e=Date.now()){let n=e;return n}',
    'class B{*run(n=Date.now()){yield n}}',
    'const local=async function* named({value:n=Date.now()}){n=other;yield n};',
    'class B{run(){for(let[t,n]of this.items)if(t)if(n)n();else t();else n()}}',
    'class B{run(){for(let n of this.items)n=(()=>({value:n}))()}}',
    'class B{run(){for(let n=of;n<2;n++)n()}}',
    'class B{run(){for(let n=this.of;n<2;n++)n()}}',
    String.raw`class B{run(){for(let \u006e of this.items)n=other}}`,
    String.raw`class B{run(\u006e=Date.now()){n=other}}`,
    'class B{__codexPublicationScopeProbe;run(n=Date.now()){n=other}}',
    'class B{run(n=call(/[(){}]/,`value${1}`,/* () */()=>({value:1}))){n=other}}',
  ]) assert.deepEqual(findRspackExportPublication(nativeSnapshot(local), "iRL"), nativePublication, local);
});

test("native local projection keeps free parameter writes and default initializer scope visible", () => {
  for (const local of [
    'function run(e=(n=other)){let n;return n}',
    'function run(e=({value:n}=other)){var n;return n}',
    'class B{run(e=(n=other)){let n;return n}}',
    'class B{#state;run(e=(n=other)){let n=this.#state;return n}}',
    'class B{run(n=(t=other)){return n}}',
    'class B{run(){for(let n of(t=other))n()}}',
    'class B{run(){for(let [value=(n=other)]of this.items)value()}}',
    'class B{run(){for(let n of this.items)n();n=other}}',
    'class B{run(){for(let n of this.items)if(n)n();else n();n=other}}',
    'class B{run(){for(let n of this.items)if(n)n();else t=other}}',
    'class B{run(){for(let n of this.items)n();function nested(t){n=other}}}',
    'async function run(){for await(let n of values){t=other}}',
    'const local=async function*(){let n;t=other;yield n};',
    String.raw`class B{#state;run(t){this.#state;\u006e=other}}`,
    String.raw`class B{run(n=Date.now()){({value:\u0074}=other)}}`,
    'class B{run(){for(let n of this.items)return\nn=other}}',
  ]) assert.equal(findRspackExportPublication(nativeSnapshot(local), "iRL"), null, local);
  const source = nativeSnapshot('class B{run(n=Date.now()){n=other}}');
  const input = Object.freeze({ ...source, params: Object.freeze(source.params), moduleId: "native", start: 4, end: 90,
    sourceFlags: Object.freeze({ native: true }) });
  assert.deepEqual(findRspackExportPublication(input, "iRL"), nativePublication);
  assert.deepEqual(input, { ...source, moduleId: "native", start: 4, end: 90, sourceFlags: { native: true } });
});

test("native local projection retains unsafe getter and publication ambiguity refusals", () => {
  const module = nativeSnapshot('class B{#state;run(n=Date.now()){let t=this.#state;return t}}');
  for (const getter of [
    '()=>eK.iR()',
    '()=>eK["iR"]',
    '()=>(eK.iR=other)',
    '()=>eK.iR||other',
    'function(){return eK.iR}',
  ]) {
    const moduleSource = module.moduleSource.replace('()=>eK.iR', getter);
    new Script(`function factory(e,t,n){${moduleSource}}`);
    assert.equal(findRspackExportPublication({ ...module, moduleSource }, "iRL"), null, getter);
  }
  for (const publication of [
    ';n.d(t,{other:()=>other});',
    ';(()=>n.d(t,{other:()=>other}))();n=other;',
  ]) assert.equal(findRspackExportPublication({ ...module, moduleSource: module.moduleSource + publication }, "iRL"), null, publication);
});

test("native Markdown object methods preserve destructured local parameters and data keys", () => {
  const publication = 'n.d(t,{ChatGptMarkdown:()=>eN});function eN(e){return e}';
  const locals = [
    'const renderer={link({href:e,title:t,tokens:n}){let r=this.parser.parseInline(n);t=String(t??"");n=[];return r+t},image({href:e,text:t,title:n}){t=String(t);n=String(n??"");return e+t+n}};',
    'const renderer={link(value){let t,n;t=value;n=value;return t+n}};',
    'const renderer={link(t=Date.now(),n={}){t=other;n=other;return t+n}};',
    'const renderer={t:other,n:other,link(value){return value}};',
    'const renderer={t(value){return value},n(value){return value}};',
  ];
  for (const local of locals) {
    const moduleSource = local + publication;
    new Script(`function nativeFactory(e,t,n){${moduleSource}}`);
    assert.deepEqual(findRspackExportPublication({ moduleSource, params: ["e", "t", "n"] }, "ChatGptMarkdown"),
      { requireName: "n", exportsName: "t", expression: "eN" }, local);
  }
});

test("object method projection retains factory writes in bodies, defaults and computed keys", () => {
  const publication = 'n.d(t,{ChatGptMarkdown:()=>eN});function eN(e){return e}';
  for (const local of [
    'const renderer={link({title:t}){t=other;n=other}};',
    'const renderer={link({tokens:n}){n=other;t=other}};',
    'const renderer={link(value=(n=other)){let n;return n}};',
    'const renderer={link(value=(t=other)){let t;return t}};',
    'const renderer={link(n=other,value=(t=other)){n=other;return value}};',
    'const renderer={link(t=other,value=(n=other)){t=other;return value}};',
    'const renderer={[(n=other)](value){return value}};',
    'const renderer={[(t=other)](value){return value}};',
    'const renderer={link({title:t,tokens:n}){t=other;n=other}};n=other;',
    'const renderer={link({title:t,tokens:n}){t=other;n=other},image(value){t=other}};',
  ]) {
    const moduleSource = local + publication;
    new Script(`function nativeFactory(e,t,n){${moduleSource}}`);
    assert.equal(findRspackExportPublication({ moduleSource, params: ["e", "t", "n"] }, "ChatGptMarkdown"), null, local);
  }
});

test("native async object methods keep their local parameters separate from factory authority", () => {
  const publication = 'n.d(o,{DilResponse:()=>nR});function nR(){return null}';
  for (const local of [
    '(function(e,{getContext:t,applyState:n,openGrid:i}){let r;return{async open(a,o){o=e.parse(o);return o}}})(source,{});',
    'const methods={async open(n,o){n=other;o=other;return n+o}};',
    'const methods={async open({value:n},{value:o}){n=other;o=other}};',
    'const methods={async open(value){let n,o;n=other;o=other}};',
    'const methods={async o(value){return value},async n(value){return value}};',
  ]) {
    const moduleSource = local + publication;
    new Script(`function nativeFactory(e,o,n){${moduleSource}}`);
    assert.deepEqual(findRspackExportPublication({ moduleSource, params: ["e", "o", "n"] }, "DilResponse"),
      { requireName: "n", exportsName: "o", expression: "nR" }, local);
  }
});

test("async object method defaults and nested free writes remain visible to factory authority", () => {
  const publication = 'n.d(o,{DilResponse:()=>nR});function nR(){return null}';
  for (const local of [
    'const methods={async open(value){o=other}};',
    'const methods={async open(o){n=other}};',
    'const methods={async open(value=(o=other)){let o;return o}};',
    'const methods={async open(value=(n=other)){let n;return n}};',
    'const methods={async open(n=other,value=(o=other)){return n+value}};',
    'const methods={async [(n=other)](o){return o}};',
    'const methods={async [(o=other)](n){return n}};',
    'const methods={async open(n,o){n=other;o=other}};o=other;',
    'const methods={async open(o){o=other},async close(value){n=other}};',
  ]) {
    const moduleSource = local + publication;
    new Script(`function nativeFactory(e,o,n){${moduleSource}}`);
    assert.equal(findRspackExportPublication({ moduleSource, params: ["e", "o", "n"] }, "DilResponse"), null, local);
  }
});

for (const inputVariable of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  test(`full native entry publication and imported plugin field (${inputVariable})`, { skip: !process.env[inputVariable] }, () => {
    const entryPath = path.join(process.env[inputVariable], ".vite", "build", "early-bootstrap.js");
    const source = fs.readFileSync(entryPath, "utf8"), lexical = createJavaScriptLexicalIndex(source);
    const head = /^\(\(\)=>\{var [A-Za-z_$][\w$,]*=\{/u.exec(source);
    assert.ok(head, "current entry seed table");
    const open = head[0].length - 1, end = lexical.matchingBrace(open);
    const prefix = "exports.ids=[0],exports.modules=";
    const factories = mainProcessFactories(prefix + source.slice(open, end + 1) + ";");
    const delta = open - prefix.length;
    for (const factory of factories) assert.equal(source.slice(factory.start + delta, factory.end + delta), factory.body);
    const namespace = factories.filter(factory => factory.identity === "40614");
    assert.equal(namespace.length, 1);
    const module = { moduleSource: namespace[0].body, params: namespace[0].parameters };
    assert.deepEqual(findRspackExportPublication(module, "iRL"), nativePublication);
    const ownerLexical = createJavaScriptLexicalIndex(module.moduleSource);
    const imports = [...module.moduleSource.matchAll(/(?<![\w$.])eK=n\((\d+)\)/gu)]
      .filter(match => ownerLexical.isRoot(match.index));
    assert.equal(imports.length, 1);
    const definitions = factories.filter(factory => factory.identity === imports[0][1]);
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].identity, "84766");
    const target = { moduleSource: definitions[0].body, params: definitions[0].parameters };
    assert.deepEqual(findRspackExportPublication(target, "iR"), { requireName: "n", exportsName: "t", expression: "x" });
    const targetLexical = createJavaScriptLexicalIndex(target.moduleSource);
    const tables = [...target.moduleSource.matchAll(/(?<![\w$.])x=\{/gu)].filter(match => targetLexical.isRoot(match.index));
    assert.equal(tables.length, 1);
    const tableOpen = tables[0].index + tables[0][0].length - 1;
    const table = target.moduleSource.slice(tableOpen + 1, targetLexical.matchingBrace(tableOpen));
    const tableLexical = createJavaScriptLexicalIndex(table);
    const record = [...table.matchAll(/\brecordAndReplay:\{name:"record-and-replay"\}/gu)]
      .filter(match => tableLexical.isRoot(match.index));
    assert.equal(record.length, 1, "normal publication chain retains the actual native field name");
    for (const corruption of [
      ';n=other;',
      String.raw`;({value:\u0074}=other);`,
      ';class PublicationControl{#state;run(t){this.#state;n=other}}',
    ]) assert.equal(findRspackExportPublication({ ...module, moduleSource: module.moduleSource + corruption }, "iRL"), null, corruption);
    assert.equal(fs.readFileSync(entryPath, "utf8"), source);
  });
}
