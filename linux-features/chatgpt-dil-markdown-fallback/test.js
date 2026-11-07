"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const { rspackModuleFactories, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const {
  fallbackSource,
  applyDilMarkdownFallback,
  findMarkdownModule,
  patchDilMarkdownFallback,
  descriptors,
} = require("./patch.js");

// Reduced current native modules. The anonymous lazy callback preloads both
// registrations before requiring the exported reply. The reply chunk itself
// has no direct Markdown import.
const REPLY = 'URlo(e,t,n){let a;n.d(t,{DilResponse:()=>nS});var r=n("ABep"),tG=n("Fail"),aJ=n("Prog");' +
  "function nS(e){let {experiment:x,assistantMessageId:y,reference:t,source:n,onAutoSafeUrls:u,dilComponents:a,loadPublicComponents:l,surface:s}=e;" +
  "let aN=n.preparing,st=n.source_message_status,q=n.error;return(0,r.jsx)(n.runtime,{" +
  "dil:aJ.prepareDil(t.model_dil_v2.code)," +
  "errorFallback:aN?null:(0,r.jsx)(tG.X,{stage:q?.stage,errorClass:q?.errorClass}),diagnostics:!1})}}";
const OTHER = 'Other(e){return e}';
const EXPORTER = 'UePh(e,t,n){n.d(t,{ChatGptMarkdown:()=>e_});function e_(e){return e}}';
const LOADER = 'KO1w(e,t,n){var r=n("ABep"),a=n("Lazy"),l=n("Fail");' +
  'let i=(0,a._)(async()=>(await Promise.all([n.e(168420),n.e(62056)]).then(n.bind(n,"URlo"))).DilResponse,' +
  '{errorFallback:(0,r.jsx)(l.X,{stage:"host_error",initialization:!0})});n.d(t,{},{DilResponse:i})}';
const chunk = (id, ...modules) => `export const __rspack_esm_ids=[${id}];` +
  `export const __webpack_modules__={${modules.join(",")}};`;
const REPLY_CHUNK = chunk(62056, OTHER, REPLY);
const LOADER_CHUNK = chunk(7, LOADER);
const WRAPPER = 'function nR(e){let tree,result,memo=(0,Z.memo)(3),{experiment:experiment,reference:reference,dilComponents:components,surface:surface}=e,context=(0,P.context)();' +
  'if(memo[0]!==reference){result=Symbol.for("react.early_return_sentinel");bound:{let parsed=ny.safeParse(reference),valid=!0;tree=(0,r.jsxs)(P.Q.Provider,{value:{},children:[(0,r.jsx)(Container,{children:' +
  '(0,r.jsx)(nN,{experiment:experiment,assistantMessageId:context.messageId,dilComponents:components??S.Hy,loadPublicComponents:void 0===components,' +
  'reference:reference,source:parsed.data,surface:surface})})]})}memo[0]=reference,memo[1]=tree,memo[2]=result}else tree=memo[1],result=memo[2];return result!==Symbol.for("react.early_return_sentinel")?result:tree}';
const WRAPPED_REPLY = REPLY.replace('()=>nS', '()=>nR').replace('function nS(',
  'var S=n("Catalog"),P=n("Provider"),Z=n("Schema");let ny=Z.object({});' + WRAPPER + 'function nN(')
  .replace('let aN=', 'let nR=opaque;nR=other;function local(r){r=other;return r}let aN=');
const WRAPPED_CHUNK = chunk(62056, OTHER, WRAPPED_REPLY);

const jsx = { jsx: (type, props) => ({ type, props }) };
const MARKER_FOR_TEST = "function codexLinuxDilMarkdownFallback(";

function fallback(resolve = () => ({ ChatGptMarkdown: "Markdown" })) {
  const context = vm.createContext({ n: resolve });
  vm.runInContext(fallbackSource("n", "UePh"), context);
  return (props) => context.codexLinuxDilMarkdownFallback({ jsx, failure: "Failure", ...props });
}

test("failed replies render only versioned Markdown through the native renderer", () => {
  const requested = [];
  const render = fallback((id) => { requested.push(id); return { ChatGptMarkdown: "Markdown" }; });
  const result = render({ reference: { model_dil_v2: {
    code: "DO_NOT_DISPLAY_OR_EXECUTE()", fallbackMarkdownVersion: 1,
    fallbackMarkdown: "正文\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x=1;\n```",
  } } });
  assert.deepEqual(requested, ["UePh"]);
  assert.equal(result.type, "div");
  assert.equal(result.props["data-dil-markdown-fallback"], "");
  assert.equal(result.props.children.type, "Markdown");
  assert.match(result.props.children.props.children, /^正文/);
  assert.equal(result.props.children.props.isStreaming, false);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_DISPLAY_OR_EXECUTE/);
});

test("missing, empty, invalid or unversioned fallback keeps the original failure", () => {
  for (const payload of [undefined, {}, {fallbackMarkdown:"answer"},
    {fallbackMarkdownVersion:2,fallbackMarkdown:"answer"},
    {fallbackMarkdownVersion:1,fallbackMarkdown:" \n"},
    {fallbackMarkdownVersion:1,fallbackMarkdown:123},
    {fallbackMarkdownVersion:1,code:"DIL.render(secret)"}]) {
    assert.equal(fallback()({reference:{model_dil_v2:payload}}), "Failure");
  }
  assert.equal(fallback()({reference:undefined}), "Failure");
});

test("an unavailable native Markdown module keeps the original failure", () => {
  const reference = {model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:"answer"}};
  assert.equal(fallback(() => { throw new Error("module missing"); })({reference}), "Failure");
  assert.equal(fallback(() => ({}))({reference}), "Failure");
});

test("saved fallback never remains streaming, including interrupted and partial history", () => {
  const render = fallback();
  const reference = {model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:"partial"}};
  assert.equal(render({reference}).props.children.props.isStreaming, false);
  reference.model_dil_v2.fallbackMarkdown = "updated";
  assert.equal(render({reference}).props.children.props.children, "updated");
  assert.equal(render({reference}).props.children.props.isStreaming, false);
});

test("patch targets only the failure branch at module scope and is idempotent", () => {
  const patched = applyDilMarkdownFallback(REPLY_CHUNK, "UePh");
  assert.ok(patched.includes('URlo(e,t,n){function codexLinuxDilMarkdownFallback(codexLinuxDilProps){'));
  assert.ok(patched.includes('try{codexLinuxView=n("UePh").ChatGptMarkdown}catch{}'));
  assert.ok(patched.includes(
    "errorFallback:aN?null:(0,r.jsx)(codexLinuxDilMarkdownFallback,{reference:t,jsx:r," +
      "failure:(0,r.jsx)(tG.X,{stage:q?.stage,errorClass:q?.errorClass})}),diagnostics:",
  ));
  assert.ok(patched.includes("dil:aJ.prepareDil(t.model_dil_v2.code)"));
  assert.ok(patched.endsWith(REPLY_CHUNK.slice(REPLY_CHUNK.indexOf(",diagnostics:!1"))));
  assert.equal(applyDilMarkdownFallback(patched, "UePh"), patched);
  const renamed = REPLY_CHUNK.replaceAll("(0,r.jsx)", () => "(0,$$.jsx)").replace("var r=", () => "var $$=");
  assert.ok(applyDilMarkdownFallback(renamed, "UePh").includes(
    "errorFallback:aN?null:(0,$$.jsx)(codexLinuxDilMarkdownFallback,{reference:t,jsx:$$,",
  ));
  for (const source of [
    REPLY_CHUNK.replace("errorFallback:", "fallback:"),
    chunk(1, OTHER, REPLY, REPLY.replace("URlo", "URlp")),
    REPLY_CHUNK.replace("export const __webpack_modules__=", "export const modules="),
  ]) {
    assert.throws(() => applyDilMarkdownFallback(source, "UePh"), /contract changed/);
  }
  assert.throws(() => applyDilMarkdownFallback(REPLY_CHUNK, '"bad"'), /Invalid/);
  assert.throws(() => applyDilMarkdownFallback(patched.replace("jsx)(codexLinuxDilMarkdownFallback,{", "jsx)(Other,{"), "UePh"), /Incomplete/);
});

test("applied state proves the complete version-one helper and its reply dataflow", () => {
  const patched = applyDilMarkdownFallback(REPLY_CHUNK, "UePh");
  const helper = fallbackSource("n", "UePh");
  const withoutHelper = patched.replace(helper, "");
  const owner = "function nS(e){let {experiment:x,assistantMessageId:y,reference:t,source:n,onAutoSafeUrls:u,dilComponents:a,loadPublicComponents:l,surface:s}=e;";
  const damaged = [
    patched.replace("1!==codexLinuxDil?.fallbackMarkdownVersion", "2!==codexLinuxDil?.fallbackMarkdownVersion"),
    patched.replace("codexLinuxDilProps.reference?.model_dil_v2", "codexLinuxDilProps.otherReference?.model_dil_v2"),
    patched.replace("codexLinuxMarkdown.trim().length", "codexLinuxMarkdown.length"),
    patched.replace('codexLinuxView=n("UePh")', 'codexLinuxView=other("UePh")'),
    patched.replace("isStreaming:!1", "isStreaming:!0"),
    patched.replace("children:codexLinuxMarkdown", "children:codexLinuxDil.code"),
    patched.replace("return codexLinuxDilProps.failure", "return null"),
    patched.replace("{reference:t,jsx:r,", "{reference:a,jsx:r,"),
    patched.replace("{reference:t,jsx:r,", "{reference:t,jsx:a,"),
    patched.replace("(0,r.jsx)(codexLinuxDilMarkdownFallback,", "(0,other.jsx)(codexLinuxDilMarkdownFallback,"),
    patched.replace("failure:(0,r.jsx)", "failure:(0,other.jsx)"),
    patched.replace(helper, helper + helper),
    withoutHelper.replace(owner, owner + helper),
    withoutHelper.replace("Other(e){", "Other(e){" + helper),
    helper + withoutHelper,
    patched.replace(helper, "{" + helper + "}"),
    patched.replace("let a;", "let a;codexLinuxDilMarkdownFallback({});"),
    "/* codexLinuxDilMarkdownFallback */" + REPLY_CHUNK,
  ];
  for (const source of damaged) {
    assert.doesNotThrow(() => new vm.Script(source.replaceAll("export const ", "const ")));
    assert.throws(() => applyDilMarkdownFallback(source, "UePh"), /Incomplete/);
  }
  assert.equal(applyDilMarkdownFallback(patched, "UePh"), patched);
});

test("runner startup failure reaches the patched fallback; success and preparation stay unchanged", async () => {
  // Reduced upstream boundary: the DIL runtime selects errorFallback after its
  // asynchronous runner startup fails. JSX children remain lazy as in React.
  const reference = {model_dil_v2:{code:"interactive-program",fallbackMarkdownVersion:1,fallbackMarkdown:"Saved answer"}};

  async function render(source, {fails, preparing = false}) {
    let markdownViews = 0;
    const prepared = [];
    const marker = "export const __webpack_modules__=";
    const factories = vm.runInNewContext(`(${source.slice(source.indexOf(marker) + marker.length).replace(/;$/, "")})`);
    const externals = {
      ABep: { jsx: (type, props) => {
        if (type === "Markdown") markdownViews++;
        return {type, props};
      } },
      Fail: { X: "Failure" },
      Prog: { prepareDil: code => { prepared.push(code); return code; } },
      UePh: { ChatGptMarkdown: "Markdown" },
    };
    const cache = new Map();
    function require(id) {
      if (Object.hasOwn(externals, id)) return externals[id];
      if (!cache.has(id)) {
        const module = { exports: {} };
        cache.set(id, module);
        factories[id](module, module.exports, require);
      }
      return cache.get(id).exports;
    }
    require.d = (exports, getters) => {
      for (const [key, get] of Object.entries(getters)) Object.defineProperty(exports, key, { get, enumerable: true });
    };
    const runtime = async props => {
      try {
        await (fails ? Promise.reject(new Error("frame_timeout")) : Promise.resolve());
        return {type:"Interactive",props:{code:props.dil}};
      } catch {
        return props.errorFallback;
      }
    };
    const root = require("URlo").DilResponse({assistantMessageId:"a",reference,source:{preparing,runtime,source_message_status:"finished_successfully"}});
    let result = await root.type(root.props);
    if (typeof result?.type === "function") result = result.type(result.props);
    assert.deepEqual(prepared, ["interactive-program"]);
    return {result, markdownViews};
  }

  const patched = applyDilMarkdownFallback(REPLY_CHUNK, "UePh");
  assert.equal((await render(REPLY_CHUNK, {fails:true})).result.type, "Failure");
  const failed = await render(patched, {fails:true});
  assert.equal(failed.result.props.children.type, "Markdown");
  assert.equal(failed.result.props.children.props.children, "Saved answer");
  assert.equal(failed.result.props.children.props.isStreaming, false);
  assert.equal(failed.markdownViews, 1);
  const success = await render(patched, {fails:false});
  assert.equal(success.result.type, "Interactive");
  assert.equal(success.markdownViews, 0);
  const preparing = await render(patched, {fails:true,preparing:true});
  assert.equal(preparing.result, null);
  assert.equal(preparing.markdownViews, 0);
});

function withAssets(t, files, { nativeLoader = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dil-markdown-test-"));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(path.join(assets, "async"), {recursive:true});
  const inputs = { ...(nativeLoader ? { "async/loader.js": LOADER_CHUNK } : {}), ...files };
  for (const [name, source] of Object.entries(inputs)) {
    fs.mkdirSync(path.dirname(path.join(assets, name)), { recursive: true });
    fs.writeFileSync(path.join(assets, name), source);
  }
  return { root, read: (name) => fs.readFileSync(path.join(assets, name), "utf8") };
}

function assertUnpublishedOrUnsafe(t, pristine, change) {
  const applied = applyDilMarkdownFallback(pristine, "UePh");
  for (const source of [change(pristine), change(applied)]) {
    assert.doesNotThrow(() => new vm.Script(source.replaceAll("export const ", "const ")));
    assert.throws(() => applyDilMarkdownFallback(source, "UePh"));
    const { root, read } = withAssets(t, { "async/reply.js": source, "async/markdown.js": chunk(168420, EXPORTER) });
    const { createPatchReport } = require("../../scripts/lib/patch-report.js");
    const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
    let writes = 0;
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, descriptors, { writeFileSync(file, bytes) { writes++; fs.writeFileSync(file, bytes); } }, report, descriptors[0].phase);
    assert.equal(report.patches[0].status, "skipped-optional");
    assert.equal(writes, 0);
    assert.equal(read("async/reply.js"), source);
  }
}

test("published native wrapper reaches the renderer with local context shadows and opaque data preserved", t => {
  const source = WRAPPED_CHUNK.replace('let a;', 'let a;const metadata={nR:"opaque",nN:"opaque",r:"opaque",tG:"opaque"};');
  const patched = applyDilMarkdownFallback(source, "UePh");
  assert.notEqual(patched, source);
  assert.equal(applyDilMarkdownFallback(patched, "UePh"), patched);
  const { root } = withAssets(t, { "async/reply.js": source, "async/markdown.js": chunk(168420, EXPORTER) });
  assert.equal(patchDilMarkdownFallback(root).changed, true);
  assert.equal(patchDilMarkdownFallback(root).changed, false);
  const other = source => source.replace("function nR(", "function Other(){return null}function nR(");
  for (const change of [
    source => other(source).replace('()=>nR', '()=>Other'),
    source => other(source).replace('(nN,{experiment:', '(Other,{experiment:'),
    source => other(source).replace('function nR(e){', 'function nR(e){let nN=Other;'),
    source => other(source).replace('function nR(e){', 'nR=Other;function nR(e){'),
    source => other(source).replace('function nR(e){', 'nN=Other;function nR(e){'),
    source => other(source).replace('function nR(e){', String.raw`\u006eR=Other;function nR(e){`),
    source => source.replace('function nN(', 'function UnusedRenderer('),
    source => source.replace('function nR(', 'function side(value=(nR=other)){let nR;}function nR('),
    source => source.replace('function nR(', 'const side={[(nR=other)](){return null}};function nR('),
    source => source.replace('return result!==', 'tree=null;return result!=='),
    source => source.replace('return result!==', 'result=null;return result!=='),
    source => source.replace('memo[1]=tree', 'memo[1]=null'),
    source => source.replace('else tree=memo[1]', 'else tree=memo[0]'),
    source => source.replace('value:{}', 'value:{sideEffect:(result=null)}'),
  ]) assertUnpublishedOrUnsafe(t, WRAPPED_CHUNK, change);
  assertUnpublishedOrUnsafe(t, REPLY_CHUNK, source => source.replace('()=>nS', '()=>Other')
    .replace('function nS(', 'function Other(){return null}function nS('));
});

test("subsequent import writes and escaped owned declarations refuse raw and canonical descriptor states", t => {
  for (const insertion of [
    'r=other;', 'tG=other;', String.raw`\u0072=other;`, String.raw`t\u0047=other;`,
    String.raw`function codexLinuxD\u0069lMarkdownFallback(p){return p.failure}`,
    String.raw`function \u0063odexLinuxDilMarkdownFallback(p){return p.failure}`,
  ]) assertUnpublishedOrUnsafe(t, REPLY_CHUNK, source => source.replace('let a;', 'let a;' + insertion));
});

test("native Promise barrier rejects factory, body and chunk-root shadows or writes", t => {
  const opaque = withAssets(t, { "async/reply.js": REPLY_CHUNK, "async/markdown.js": chunk(168420, EXPORTER),
    "async/loader.js": 'const metadata={Promise:"opaque"};' + LOADER_CHUNK });
  assert.equal(patchDilMarkdownFallback(opaque.root).changed, true);
  for (const loader of [
    LOADER_CHUNK.replace('KO1w(e,t,n)', 'KO1w(Promise,t,n)'),
    LOADER_CHUNK.replace('var r=', 'var Promise=').replace('(0,r.jsx)', '(0,Promise.jsx)'),
    LOADER_CHUNK.replace('let i=', 'let Promise=').replace('DilResponse:i', 'DilResponse:Promise'),
    LOADER_CHUNK.replace('var r=', 'Promise=other;var r='),
    'const Promise=other;' + LOADER_CHUNK,
    'Promise=other;' + LOADER_CHUNK,
    String.raw`\u0050romise=other;` + LOADER_CHUNK,
    'globalThis.Promise=other;' + LOADER_CHUNK,
    'globalThis.Promise.all=other;' + LOADER_CHUNK,
    String.raw`globalThis.\u0050romise=other;` + LOADER_CHUNK,
    String.raw`globalThis.Promise.\u0061ll=other;` + LOADER_CHUNK,
    'globalThis . Promise /*memo*/ . all =other;' + LOADER_CHUNK,
    'globalThis.Promise. /*memo*/all=other;' + LOADER_CHUNK,
  ]) {
    assert.doesNotThrow(() => new vm.Script(loader.replaceAll("export const ", "const ")));
    const { root, read } = withAssets(t, { "async/reply.js": REPLY_CHUNK, "async/markdown.js": chunk(168420, EXPORTER), "async/loader.js": loader });
    let writes = 0;
    assert.throws(() => patchDilMarkdownFallback(root, { writeFileSync(file, bytes) { writes++; fs.writeFileSync(file, bytes); } }));
    assert.equal(writes, 0);
    assert.equal(read("async/reply.js"), REPLY_CHUNK);
  }
});

test("module discovery is fail closed and writes only after all contracts match", t => {
  const replyName = "async/62056.3f2d3d25bb.js";
  const { root, read } = withAssets(t, { [replyName]: REPLY_CHUNK });
  assert.throws(() => patchDilMarkdownFallback(root), /found 1 and 0/);
  assert.equal(read(replyName), REPLY_CHUNK);
  fs.writeFileSync(path.join(root, "webview/assets/async/168420.0210291773.js"), chunk(168420, EXPORTER));
  // A duplicate copy of the same exporter module in another chunk is the same module.
  fs.writeFileSync(path.join(root, "webview/assets/async/168421.0210291773.js"), chunk(168421, EXPORTER));
  assert.equal(patchDilMarkdownFallback(root).changed, true);
  assert.equal(read(replyName), applyDilMarkdownFallback(REPLY_CHUNK, "UePh"));
  assert.equal(read("async/168420.0210291773.js"), chunk(168420, EXPORTER));
  assert.equal(patchDilMarkdownFallback(root).changed, false);
});

test("exporters without the named export or with competing ids are rejected before any reply write", t => {
  const replyName = "async/62056.3f2d3d25bb.js";
  const { root, read } = withAssets(t, { [replyName]: REPLY_CHUNK });
  const exporter = path.join(root, "webview/assets/async/168420.0210291773.js");
  for (const [source, expected] of [
    [chunk(1, 'UePh(e,t,n){n.d(t,{ChatGptMarkdownOther:()=>e_})}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){const x={ChatGptMarkdown:e_};n.d(t,{x:()=>x})}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){let x="ChatGptMarkdown:()=>e_"}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){n.d(otherExports,{ChatGptMarkdown:()=>e_});function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){other.d(t,{ChatGptMarkdown:()=>e_});function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){n.d(t,{Other:()=>e_}),({ChatGptMarkdown:e_});function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){n.d(t,{Nested:{Other:e_,ChatGptMarkdown:e_,Tail:e_}});function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){function unused(){n.d(t,{ChatGptMarkdown:()=>e_})}function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){let unused=()=>n.d(t,{ChatGptMarkdown:()=>e_});function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){let unused={register(){n.d(t,{ChatGptMarkdown:()=>e_})}};function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){let text=";n.d(t,{ChatGptMarkdown:()=>e_})";function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){/*;n.d(t,{ChatGptMarkdown:()=>e_})*/function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, 'UePh(e,t,n){for(let i=0;n.d(t,{ChatGptMarkdown:()=>e_});i++){}function e_(e){return e}}'), /found 1 and 0/],
    [chunk(1, EXPORTER, EXPORTER.replace("UePh", "Othr")), /found 1 and 2/],
    [chunk(1, EXPORTER.replace("UePh", "Othr")), /does not preload/],
  ]) {
    fs.writeFileSync(exporter, source);
    assert.throws(() => patchDilMarkdownFallback(root), expected);
    assert.equal(read(replyName), REPLY_CHUNK);
  }
});

test("native Markdown discovery accepts its own getter or third value export record", t => {
  for (const body of [
    'n.d(t,{ChatGptMarkdown:()=>e_});',
    'n.d(t,{Other:()=>e_},{ChatGptMarkdown:e_});',
    'n.d(t,{ChatGptMarkdown:()=>e_},{Other:e_});',
    'n.d(t,{ChatGptMarkdown:()=>e_}),({ChatGptMarkdown:e_});',
    'function prior(){}n.d(t,{ChatGptMarkdown:()=>e_});',
  ]) {
    const { root } = withAssets(t, { "async/markdown.js": chunk(1, `UePh(e,t,n){${body}function e_(e){return e}}`) });
    assert.deepEqual(findMarkdownModule(root), ["UePh"]);
  }
});

test("the native anonymous loader owns the published callback and its complete preload set", t => {
  const variants = [
    LOADER.replace("n.e(168420),", ""),
    LOADER.replace(",n.e(62056)", ""),
    LOADER.replace("n.e(168420)", "other.e(168420)"),
    LOADER.replace('n.bind(n,"URlo")', 'other.bind(other,"URlo")'),
    LOADER.replace("async()=>", "async function namedLoader(){return ").replace(".DilResponse,{", ".DilResponse},{"),
    LOADER.replace('a=n("Lazy")', 'a=other("Lazy")'),
    LOADER.replace("DilResponse:i", "DilResponse:r"),
    LOADER.replace("var r=", "n=other;var r="),
    LOADER.replace(".e(168420)", ".e(168420),n.e(168420)"),
    LOADER.replace("let i=", "function unused(){let i=").replace(";n.d(t,", ";}n.d(t,"),
  ];
  for (const loader of variants) {
    assert.doesNotThrow(() => new vm.Script(chunk(7, loader).replaceAll("export const ", "const ")));
    const { root, read } = withAssets(t, { "async/reply.js": REPLY_CHUNK,
      "async/markdown.js": chunk(168420, EXPORTER), "async/loader.js": chunk(7, loader) });
    assert.throws(() => patchDilMarkdownFallback(root), /native DIL|Native DIL|anonymous loader/);
    assert.equal(read("async/reply.js"), REPLY_CHUNK);
  }
  const { root, read } = withAssets(t, { "async/reply.js": REPLY_CHUNK,
    "async/markdown.js": chunk(168420, EXPORTER) }, { nativeLoader: false });
  assert.throws(() => patchDilMarkdownFallback(root), /anonymous loader/);
  assert.equal(read("async/reply.js"), REPLY_CHUNK);
});

test("native lazy loading waits for Markdown and reply registration before resolving the component", async () => {
  const factories = vm.runInNewContext(`(${LOADER_CHUNK.split("export const __webpack_modules__=")[1].replace(/;$/, "")})`);
  const events = [], resolvers = new Map(), ready = new Set(), exports = {};
  const require = id => {
    if (id === "ABep") return jsx;
    if (id === "Fail") return { X: "Failure" };
    if (id === "Lazy") return { _: load => ({ load }) };
    assert.equal(id, "URlo");
    assert.equal(ready.has(168420) && ready.has(62056), true);
    events.push("require-reply");
    return { DilResponse: "NativeReply" };
  };
  require.e = id => new Promise(resolve => resolvers.set(id, () => {
    ready.add(id); events.push(`registered-${id}`); resolve();
  }));
  require.d = (target, getters, values) => Object.assign(target, values);
  factories.KO1w({}, exports, require);
  assert.equal(events.length, 0);
  const pending = exports.DilResponse.load();
  assert.deepEqual([...resolvers.keys()], [168420, 62056]);
  resolvers.get(62056)();
  await Promise.resolve();
  assert.deepEqual(events, ["registered-62056"]);
  resolvers.get(168420)();
  assert.equal(await pending, "NativeReply");
  assert.deepEqual(events, ["registered-62056", "registered-168420", "require-reply"]);
});

test("missing and damaged dependency replicas or chunk registrations refuse every reply write", t => {
  const variants = [
    { "async/loader-copy.js": chunk(8, LOADER.replace('n.bind(n,"URlo")', 'n.bind(n,"Missing")')) },
    { "async/loader-copy.js": chunk(8, LOADER.replace("KO1w(e,t,n)", "Competing(e,t,n)")) },
    { "async/markdown-copy.js": chunk(168421, EXPORTER.replace("ChatGptMarkdown:", "Other:")) },
    { "async/markdown-copy.js": chunk(168421, EXPORTER.replace("n.d(t,", "n=other;n.d(t,")) },
    { "async/reply.js": REPLY_CHUNK.replace("__rspack_esm_ids", "unregistered") },
    { "async/markdown.js": chunk(168420, EXPORTER).replace("__rspack_esm_ids", "unregistered") },
    { "async/reply-copy.js": chunk(62057, REPLY) },
  ];
  for (const extra of variants) {
    const files = { "async/reply.js": REPLY_CHUNK, "async/markdown.js": chunk(168420, EXPORTER), ...extra };
    const { root, read } = withAssets(t, files);
    assert.throws(() => patchDilMarkdownFallback(root));
    for (const [name, source] of Object.entries(files)) assert.equal(read(name), source);
  }
});

test("reply publication, current experiment props and native JSX imports remain authoritative", t => {
  for (const reply of [
    REPLY_CHUNK.replace("experiment:z,", ""),
    REPLY_CHUNK.replace('r=n("ABep")', 'r=other("ABep")'),
    REPLY_CHUNK.replace('tG=n("Fail")', 'tG=other("Fail")'),
    REPLY_CHUNK.replace("let aN=", "let r=other;let aN="),
    REPLY_CHUNK.replace("experiment:z,", "experiment:r,"),
    REPLY_CHUNK.replace("let a;", "let a;n=other;"),
    REPLY_CHUNK.replace("n.d(t,", "n.d(other,"),
  ]) {
    const { root, read } = withAssets(t, { "async/reply.js": reply, "async/markdown.js": chunk(168420, EXPORTER) });
    assert.throws(() => patchDilMarkdownFallback(root), /contract changed/);
    assert.equal(read("async/reply.js"), reply);
  }
  const text = REPLY.slice(REPLY.indexOf("function nS("), -1);
  const fake = chunk(62056, 'URlo(e,t,n){n.d(t,{DilResponse:()=>nS});var r=n("ABep"),tG=n("Fail");const text=' + JSON.stringify(text) + ';}');
  assert.doesNotThrow(() => new vm.Script(fake.replaceAll("export const ", "const ")));
  assert.throws(() => applyDilMarkdownFallback(fake, "UePh"), /contract changed/);
});

test("orphan artifacts and misleading string load edges cannot grant a valid descriptor state", t => {
  const { root, read } = withAssets(t, { "async/reply.js": REPLY_CHUNK,
    "async/markdown.js": chunk(168420, EXPORTER), "async/orphan.js": 'const orphan="codexLinuxDilProps";' });
  assert.throws(() => patchDilMarkdownFallback(root), /artifact escaped/);
  assert.equal(read("async/reply.js"), REPLY_CHUNK);
  const decoy = 'Decoy(e,t,n){const text=\'n.bind(n,"URlo")\';}';
  const misleading = withAssets(t, { "async/reply.js": REPLY_CHUNK,
    "async/markdown.js": chunk(168420, EXPORTER), "async/decoy.js": chunk(7, decoy) }, { nativeLoader: false });
  assert.throws(() => patchDilMarkdownFallback(misleading.root), /anonymous loader/);
  assert.equal(misleading.read("async/reply.js"), REPLY_CHUNK);
});

test("dependency preimages participate in the reply asset transaction", t => {
  const { root, read } = withAssets(t, { "async/reply.js": REPLY_CHUNK, "async/markdown.js": chunk(168420, EXPORTER) });
  let checked = false, writes = 0;
  assert.throws(() => patchDilMarkdownFallback(root, {
    readFileSync(file) {
      if (!checked && file.endsWith("/markdown.js")) {
        checked = true; fs.appendFileSync(file, "/*concurrent dependency edit*/");
      }
      return fs.readFileSync(file);
    },
    writeFileSync(file, bytes) { writes++; fs.writeFileSync(file, bytes); },
  }), /changed before patch commit/);
  assert.equal(checked, true);
  assert.equal(writes, 0);
  assert.equal(read("async/reply.js"), REPLY_CHUNK);
});

test("normal descriptor phase applies once and refuses a damaged complete-state helper", t => {
  const { createPatchReport } = require("../../scripts/lib/patch-report.js");
  const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
  const { root, read } = withAssets(t, { "async/reply.js": REPLY_CHUNK, "async/markdown.js": chunk(168420, EXPORTER) });
  const run = () => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, descriptors, {}, report, descriptors[0].phase);
    return report.patches[0].status;
  };
  assert.equal(run(), "applied");
  assert.equal(run(), "already-applied");
  const damaged = read("async/reply.js").replace("isStreaming:!1", "isStreaming:!0");
  fs.writeFileSync(path.join(root, "webview/assets/async/reply.js"), damaged);
  assert.equal(run(), "skipped-optional");
  assert.equal(read("async/reply.js"), damaged);
});


test("reply replicas reject mixed, damaged and competing identities before any write", t => {
  const patched = applyDilMarkdownFallback(REPLY_CHUNK, "UePh");
  for (const [second, expected] of [
    [patched, /Partially applied/],
    [patched.replace("1!==codexLinuxDil?.fallbackMarkdownVersion", "2!==codexLinuxDil?.fallbackMarkdownVersion"), /Incomplete/],
    [REPLY_CHUNK.replace("source_message_status", "changed_status"), /contract changed/],
    [REPLY_CHUNK.replace("URlo(e,t,n)", "Competing(e,t,n)"), /multiple.*identities/],
  ]) {
    const { root, read } = withAssets(t, { "async/a.js": REPLY_CHUNK, "async/b.js": second, "async/markdown.js": chunk(168420, EXPORTER) });
    assert.throws(() => patchDilMarkdownFallback(root), expected);
    assert.equal(read("async/a.js"), REPLY_CHUNK);
    assert.equal(read("async/b.js"), second);
  }
});

test("replica writes are verified, rolled back on interruption and idempotent", t => {
  const { root, read } = withAssets(t, { "async/a.js": REPLY_CHUNK, "async/b.js": REPLY_CHUNK, "async/markdown.js": chunk(168420, EXPORTER) });
  let writes = 0;
  assert.throws(() => patchDilMarkdownFallback(root, {
    writeFileSync(...args) {
      fs.writeFileSync(...args);
      if (++writes === 2) throw new Error("interrupted second replica");
    },
  }), /interrupted second replica/);
  assert.equal(read("async/a.js"), REPLY_CHUNK);
  assert.equal(read("async/b.js"), REPLY_CHUNK);
  const result = patchDilMarkdownFallback(root);
  assert.equal(result.changed, true);
  assert.equal(result.matched, 2);
  assert.equal(read("async/a.js"), applyDilMarkdownFallback(REPLY_CHUNK, "UePh"));
  assert.equal(read("async/b.js"), read("async/a.js"));
  assert.equal(read("async/markdown.js"), chunk(168420, EXPORTER));
  assert.equal(patchDilMarkdownFallback(root).changed, false);
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("the signed official webview exposes one patchable reply and Markdown module", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const markdown = findMarkdownModule(signedApp);
  assert.equal(markdown.length, 1);
  const replies = findWebviewAssetsContaining(signedApp, ["model_dil_v2", "source_message_status", ".prepareDil(", "errorFallback:"])
    .map((name) => fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8"));
  const patched = replies.map((source) => {
    try { return applyDilMarkdownFallback(source, markdown[0]); } catch { return null; }
  }).filter(Boolean);
  assert.equal(patched.length, 1);
  assert.equal(applyDilMarkdownFallback(patched[0], markdown[0]), patched[0]);
});

test("actual native anonymous loaders register all chunks before requiring the reply", { skip: signedApp == null }, async () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const replies = findWebviewAssetsContaining(signedApp, ["model_dil_v2", "source_message_status", ".prepareDil(", "errorFallback:"]);
  const ids = replies.flatMap(name => [...rspackModuleFactories(fs.readFileSync(path.join(signedApp, "webview/assets", name), "utf8"), name)])
    .filter(copy => copy.moduleSource.includes(".prepareDil(") && copy.moduleSource.includes("model_dil_v2"))
    .map(copy => copy.moduleId);
  assert.equal(new Set(ids).size, 1);
  let exercised = 0;
  for (const name of findWebviewAssetsContaining(signedApp, [JSON.stringify(ids[0])])) {
    const source = fs.readFileSync(path.join(signedApp, "webview/assets", name), "utf8");
    for (const copy of rspackModuleFactories(source, name)) {
      if (!copy.moduleSource.includes(JSON.stringify(ids[0])) || !copy.moduleSource.includes(".DilResponse")) continue;
      const imports = [...copy.moduleSource.matchAll(/(?:var |,)([\w$]+)=[\w$]+\("([\w$]+)"\)/gu)];
      assert.equal(imports.length, 3);
      const lazyExport = /let [\w$]+=\(0,[\w$]+\.([\w$]+)\)/u.exec(copy.moduleSource)?.[1];
      assert.ok(lazyExport);
      const chunkIds = [...copy.moduleSource.matchAll(/[\w$]+\.e\((\d+)\)/gu)].map(match => Number(match[1]));
      const ready = new Set(), exports = {};
      let required = 0;
      const require = id => {
        if (id === imports[0][2]) return jsx;
        if (id === imports[1][2]) return { [lazyExport]: load => ({ load }) };
        if (id === imports[2][2]) return { X: "NativeFailure" };
        assert.equal(id, ids[0]);
        assert.equal(ready.size, chunkIds.length);
        required++;
        return { DilResponse: "NativeReply" };
      };
      require.e = id => Promise.resolve().then(() => ready.add(id));
      require.d = (target, getters, values) => Object.assign(target, values);
      const factory = vm.runInNewContext(`(function(${copy.params.join(",")}){${copy.moduleSource}})`);
      factory({}, exports, require);
      assert.equal(required, 0);
      assert.equal(await exports.DilResponse.load(), "NativeReply");
      assert.equal(required, 1);
      exercised++;
    }
  }
  assert.ok(exercised > 0);
});

test("actual signed failure seam executes with its factory require, native JSX and original failure", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const [markdownId] = findMarkdownModule(signedApp);
  const source = findWebviewAssetsContaining(signedApp, ["model_dil_v2", "source_message_status", ".prepareDil(", "errorFallback:"])
    .map(name => fs.readFileSync(path.join(signedApp, "webview/assets", name), "utf8"))
    .find(value => { try { applyDilMarkdownFallback(value, markdownId); return true; } catch { return false; } });
  assert.ok(source);
  const patched = applyDilMarkdownFallback(source, markdownId);
  const owner = [...rspackModuleFactories(patched, "actual")].find(module => module.moduleSource.startsWith(MARKER_FOR_TEST));
  assert.ok(owner);
  const requireName = owner.params[2];
  const reference = owner.moduleSource.match(/function [\w$]+\(\{experiment:[\w$]+,assistantMessageId:[\w$]+,reference:([\w$]+),source:([\w$]+),/);
  const seam = owner.moduleSource.match(/errorFallback:([\w$]+)\?null:\(0,([\w$]+)\.jsx\)\(codexLinuxDilMarkdownFallback,\{reference:([\w$]+),jsx:[\w$]+,failure:\(0,[\w$]+\.jsx\)\(([\w$]+)\.([\w$]+),\{stage:([\w$]+)\?\.stage,errorClass:[\w$]+\?\.errorClass\}\)\}\),diagnostics:/);
  assert.ok(reference && seam);
  assert.equal(reference[1], seam[3]);
  const jsxBinding = findRspackRequireBinding(owner, seam[2]);
  assert.ok(jsxBinding);
  const helper = owner.moduleSource.slice(0, fallbackSource(requireName, markdownId).length);
  const expression = seam[0].slice("errorFallback:".length, -",diagnostics:".length);
  const make = vm.runInNewContext(`(function(${requireName}){${helper}let ${seam[2]}=${requireName}(${JSON.stringify(jsxBinding.moduleId)});` +
    `return function(${reference[1]},${reference[2]},${seam[1]},${seam[6]},${seam[4]}){return ${expression}}})`);
  function render(payload, { preparing = false, fails = true, available = true } = {}) {
    const required = [];
    const actual = make(id => {
      if (id === jsxBinding.moduleId) return jsx;
      required.push(id);
      if (!available) throw new Error("Markdown registration unavailable");
      assert.equal(id, markdownId);
      return { ChatGptMarkdown: "NativeMarkdown" };
    });
    const error = { stage: "frame_timeout", errorClass: "runner_unavailable" };
    const tree = actual({ model_dil_v2: payload }, { notCallable: true }, preparing, error, { [seam[5]]: "NativeFailure" });
    const result = !fails ? { type: "Interactive" } : typeof tree?.type === "function" ? tree.type(tree.props) : tree;
    return { result, required };
  }
  const payload = { code: "DO_NOT_EXECUTE()", fallbackMarkdownVersion: 1, fallbackMarkdown: "答复\n\n| A |\n| - |\n| B |\n\n```js\nconst x=1;\n```\n[link](https://example.com)" };
  const valid = render(payload);
  assert.deepEqual(valid.required, [markdownId]);
  assert.equal(valid.result.props.children.type, "NativeMarkdown");
  assert.equal(valid.result.props.children.props.children, payload.fallbackMarkdown);
  assert.equal(valid.result.props.children.props.isStreaming, false);
  assert.doesNotMatch(JSON.stringify(valid.result), /DO_NOT_EXECUTE/);
  for (const value of [undefined, {}, { ...payload, fallbackMarkdownVersion: 2 }, { ...payload, fallbackMarkdown: " \n" }]) {
    const invalid = render(value);
    assert.equal(invalid.result.type, "NativeFailure");
    assert.deepEqual({ ...invalid.result.props }, { stage: "frame_timeout", errorClass: "runner_unavailable" });
    assert.deepEqual(invalid.required, []);
  }
  assert.equal(render(payload, { available: false }).result.type, "NativeFailure");
  assert.equal(render(payload, { preparing: true }).result, null);
  const success = render(payload, { fails: false });
  assert.equal(success.result.type, "Interactive");
  assert.deepEqual(success.required, []);
});

test("production descriptor patches independent actual owner copies and preserves official inputs", { skip: signedApp == null }, t => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const replies = findWebviewAssetsContaining(signedApp, ["model_dil_v2", "source_message_status", ".prepareDil(", "errorFallback:"]);
  const replyIds = replies.flatMap(name => [...rspackModuleFactories(fs.readFileSync(path.join(signedApp, "webview/assets", name), "utf8"), name)])
    .filter(copy => ["model_dil_v2", "source_message_status", ".prepareDil(", "errorFallback:"].every(needle => copy.moduleSource.includes(needle)))
    .map(copy => copy.moduleId);
  assert.equal(new Set(replyIds).size, 1);
  const names = [...new Set([
    ...replies, ...findWebviewAssetsContaining(signedApp, ["ChatGptMarkdown:"]),
    ...findWebviewAssetsContaining(signedApp, [JSON.stringify(replyIds[0])]),
  ])];
  const files = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(signedApp, "webview/assets", name), "utf8")]));
  const originals = new Map(names.map(name => [name, createHash("sha256").update(files[name]).digest("hex")]));
  const { root, read } = withAssets(t, files, { nativeLoader: false });
  const { createPatchReport } = require("../../scripts/lib/patch-report.js");
  const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
  const run = () => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, descriptors, {}, report, descriptors[0].phase);
    return report.patches[0].status;
  };
  assert.equal(run(), "applied");
  assert.equal(run(), "already-applied");
  let changed = 0;
  for (const name of names) {
    if (read(name) !== files[name]) {
      changed++;
      assert.doesNotThrow(() => new vm.Script(read(name).replaceAll("export const ", "const ")));
    }
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(signedApp, "webview/assets", name))).digest("hex"), originals.get(name));
  }
  assert.equal(changed, 1);
  const markdownName = names.find(name => files[name].includes("ChatGptMarkdown:"));
  const markdownChunk = /export const __rspack_esm_ids=\[(\d+)\]/u.exec(files[markdownName])?.[1];
  assert.ok(markdownChunk);
  const loaderName = names.find(name => files[name].includes(JSON.stringify(replyIds[0])));
  const loader = [...rspackModuleFactories(files[loaderName], loaderName)]
    .find(copy => copy.moduleSource.includes(JSON.stringify(replyIds[0])) && copy.moduleSource.includes(".DilResponse"));
  assert.ok(loader);
  const damagedBody = loader.moduleSource.replace(`.e(${markdownChunk})`, ".e(999999999)");
  assert.notEqual(damagedBody, loader.moduleSource);
  const damagedLoader = loader.source.slice(0, loader.start) + damagedBody + loader.source.slice(loader.end);
  fs.writeFileSync(path.join(root, "webview/assets", loaderName), damagedLoader);
  const beforeRefusal = new Map(names.map(name => [name, read(name)]));
  assert.equal(run(), "skipped-optional");
  for (const name of names) {
    assert.equal(read(name), beforeRefusal.get(name));
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(signedApp, "webview/assets", name))).digest("hex"), originals.get(name));
  }
});
