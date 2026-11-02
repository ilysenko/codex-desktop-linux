const assert = require("node:assert/strict");
const test = require("node:test");

const { requireName, inferModuleAlias } = require("./minified-js.js");

test("requireName finds direct require assignment", () => {
  const source = `let a=1,b=require("electron"),c=3`;
  assert.strictEqual(requireName(source, "electron"), "b");
});

test("requireName finds require with double quotes", () => {
  const source = `const myModule=require("node:path")`;
  assert.strictEqual(requireName(source, "node:path"), "myModule");
});

test("requireName finds require with backticks", () => {
  const source = `const myModule=require(\`electron\`)`;
  assert.strictEqual(requireName(source, "electron"), "myModule");
});

test("requireName rejects an arbitrary require wrapper", () => {
  const source = `let a=1,electronAlias=myCustomWrapper(require(\`electron\`)),c=3`;
  assert.strictEqual(requireName(source, "electron"), null);
});

test("requireName returns null when module not found", () => {
  const source = `const other=require("other-module")`;
  assert.strictEqual(requireName(source, "electron"), null);
});

test("inferModuleAlias delegates to requireName for direct require", () => {
  const source = `let electronAlias=require("electron")`;
  assert.strictEqual(inferModuleAlias(source, "electron"), "electronAlias");
});

test("inferModuleAlias falls back to pattern matching for electron", () => {
  const source = `let electronAlias={app:{`;
  assert.strictEqual(inferModuleAlias(source, "electron"), "electronAlias");
});

const { findMatchingBrace } = require("./minified-js.js");

function closingBraceOf(source, header) {
  const open = source.indexOf(header) + header.length - 1;
  return source.slice(source.indexOf(header), findMatchingBrace(source, open) + 1);
}

test("findMatchingBrace skips quotes inside regex character classes", () => {
  // Shapes from the official 26.1027.51404 webview bundle (issue #1659).
  const first = "function yT(e){let n=e;n=n.replace(/^[`\"'\\u201c]+|[`\"'\\u201c]+$/g,``);return n}";
  const second = "function Pan(){return(Pan=t((()=>{Nan=/[\\t\\n!-,./:-@[-`\\f{-}$\\x80-\\uFFFF]/g})))()}";
  const source = `${first}function mid(){return 1}${second}`;
  assert.strictEqual(closingBraceOf(source, "function yT(e){"), first);
  assert.strictEqual(closingBraceOf(source, "function Pan(){"), second);
});

test("findMatchingBrace tells regex literals from division", () => {
  const cases = [
    "function a(e){return e.split(/}/)}",
    "function a(e){if(e)return/['{]/.test(e);return 1}",
    "function a(e){let t=e/2,n=t/3;return{t,n}}",
    "function a(e){let t=(e)/2/{}.x;return t}",
    "function a(e){let t=e[0]/2;return`}`+t}",
    "function a(e){let t=e++/2/1;return t}",
    "function a(e){return typeof/}/,e.return/2/1}",
    "function a(e){let t=[/`/,/[\\]}]/];return t}",
    "function a(e){if(e)/}/.test(e);while(!e)/`/.exec(e);return(e)/2}",
  ];
  for (const source of cases) {
    assert.strictEqual(findMatchingBrace(source, source.indexOf("{")), source.length - 1, source);
    assert.doesNotThrow(() => new Function(`(${source})`), source);
  }
});

test("findMatchingBrace skips comments and nested template substitutions", () => {
  const source = [
    "function a(e){",
    "/* } ` */",
    "let t=`x${e?`}${\"}\"}`:{a:'}'}.a}y`;",
    "// } `\n",
    "return t}",
  ].join("");
  assert.strictEqual(findMatchingBrace(source, source.indexOf("{")), source.length - 1);
  assert.strictEqual(findMatchingBrace("function a(){`${", 12), -1);
});

test("findMatchingBrace reports a missing opening brace as not found", () => {
  const source = "{a}";
  assert.strictEqual(findMatchingBrace(source, source.indexOf("{", 1)), -1);
});
