"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  fallbackSource,
  applyDilMarkdownFallback,
  findMarkdownChunk,
  findMarkdownModule,
  patchDilMarkdownFallback,
} = require("./patch.js");

// Reduced rspack chunks shaped like the current signed stable Linux webview:
// the interactive reply chunk loads the unique async chunk that exports the
// native Markdown module.
const MARKDOWN_CHUNK = 168420;
const REPLY = 'URlo(e,t,n){let a;n.d(t,{DilResponse:()=>nS});var r=n("ABep"),tG=n("Fail"),aJ=n("Prog");' +
  "function nS(e){let {experiment:x,assistantMessageId:y,reference:t,source:n,onAutoSafeUrls:u,dilComponents:a,loadPublicComponents:l,surface:s}=e;" +
  "let aN=n.preparing,st=n.source_message_status,q=n.error;return(0,r.jsx)(n.runtime,{" +
  "dil:aJ.prepareDil(t.model_dil_v2.code)," +
  "errorFallback:aN?null:(0,r.jsx)(tG.X,{stage:q?.stage,errorClass:q?.errorClass}),diagnostics:!1})}}";
const ASYNC_MARKDOWN = `WT9T(e,t,n){function o(){return n.e(${MARKDOWN_CHUNK}).then(n.bind(n,"UePh"))}n.d(t,{o:()=>o})}`;
const SYNC_MARKDOWN = 'WT9T(e,t,n){var N=n("UePh");function o(e){return N.ChatGptMarkdown}n.d(t,{o:()=>o})}';
const EXPORTER = 'UePh(e,t,n){n.d(t,{ChatGptMarkdown:()=>e_});function e_(e){return e}}';
const chunk = (id, ...modules) => `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];` +
  `export const __webpack_modules__={${modules.join(",")}};`;
const asyncChunk = (id, ...modules) => `export const __rspack_esm_ids=[${id}];` +
  `export const __webpack_modules__={${modules.join(",")}};`;
const REPLY_CHUNK = chunk(62056, ASYNC_MARKDOWN, REPLY);

const jsx = { jsx: (type, props) => ({ type, props }) };

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
  const patched = applyDilMarkdownFallback(REPLY_CHUNK, "UePh", MARKDOWN_CHUNK);
  assert.ok(patched.includes('URlo(e,t,n){function codexLinuxDilMarkdownFallback(codexLinuxDilProps){'));
  assert.ok(patched.includes('try{codexLinuxView=n("UePh").ChatGptMarkdown}catch{}'));
  assert.ok(patched.includes(
    "errorFallback:aN?null:(0,r.jsx)(codexLinuxDilMarkdownFallback,{reference:t,jsx:r," +
      "failure:(0,r.jsx)(tG.X,{stage:q?.stage,errorClass:q?.errorClass})}),diagnostics:",
  ));
  assert.ok(patched.includes("dil:aJ.prepareDil(t.model_dil_v2.code)"));
  assert.ok(patched.endsWith(REPLY_CHUNK.slice(REPLY_CHUNK.indexOf(",diagnostics:!1"))));
  assert.equal(applyDilMarkdownFallback(patched, "UePh", MARKDOWN_CHUNK), patched);
  const renamed = REPLY_CHUNK.replaceAll("(0,r.jsx)", () => "(0,$$.jsx)").replace("var r=", () => "var $$=");
  assert.ok(applyDilMarkdownFallback(renamed, "UePh", MARKDOWN_CHUNK).includes(
    "errorFallback:aN?null:(0,$$.jsx)(codexLinuxDilMarkdownFallback,{reference:t,jsx:$$,",
  ));
  for (const source of [
    REPLY_CHUNK.replace("errorFallback:", "fallback:"),
    REPLY_CHUNK.replace("onAutoSafeUrls:u", "onAutoSafeUrlsDrift:u"),
    chunk(1, ASYNC_MARKDOWN, REPLY, REPLY.replace("URlo", "URlp")),
    REPLY_CHUNK.replace("export const __webpack_modules__=", "export const modules="),
  ]) {
    assert.throws(() => applyDilMarkdownFallback(source, "UePh", MARKDOWN_CHUNK), /contract changed/);
  }
  assert.throws(() => applyDilMarkdownFallback(chunk(1, REPLY), "UePh", MARKDOWN_CHUNK), /not loaded with the interactive reply chunk/);
  assert.throws(() => applyDilMarkdownFallback(REPLY_CHUNK, "UePh", MARKDOWN_CHUNK + 1), /not loaded with the interactive reply chunk/);
  assert.throws(() => applyDilMarkdownFallback(REPLY_CHUNK, '"bad"'), /Invalid/);
  assert.throws(() => applyDilMarkdownFallback(patched.replace("jsx)(codexLinuxDilMarkdownFallback,{", "jsx)(Other,{"), "UePh", MARKDOWN_CHUNK), /Incomplete/);
});

test("sync-only obsolete Markdown layout is rejected", () => {
  const obsolete = chunk(62056, SYNC_MARKDOWN, REPLY);
  assert.throws(
    () => applyDilMarkdownFallback(obsolete, "UePh", MARKDOWN_CHUNK),
    /Markdown async chunk is not loaded/,
  );
  const obsoletePatched = applyDilMarkdownFallback(REPLY_CHUNK, "UePh", MARKDOWN_CHUNK)
    .replace(ASYNC_MARKDOWN, SYNC_MARKDOWN);
  assert.throws(
    () => applyDilMarkdownFallback(obsoletePatched, "UePh", MARKDOWN_CHUNK),
    /Incomplete ChatGPT DIL Markdown fallback patch/,
  );
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

  const patched = applyDilMarkdownFallback(REPLY_CHUNK, "UePh", MARKDOWN_CHUNK);
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

function withAssets(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dil-markdown-test-"));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(path.join(assets, "async"), {recursive:true});
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(assets, name), source);
  return { root, read: (name) => fs.readFileSync(path.join(assets, name), "utf8") };
}

test("module discovery is fail closed and writes only after all contracts match", t => {
  const replyName = "async/62056.3f2d3d25bb.js";
  const { root, read } = withAssets(t, { [replyName]: REPLY_CHUNK });
  assert.throws(() => patchDilMarkdownFallback(root), /found 1, 0, and 0/);
  assert.equal(read(replyName), REPLY_CHUNK);
  fs.writeFileSync(path.join(root, "webview/assets/async/168420.0210291773.js"), asyncChunk(MARKDOWN_CHUNK, EXPORTER));
  assert.equal(patchDilMarkdownFallback(root).changed, true);
  assert.equal(read(replyName), applyDilMarkdownFallback(REPLY_CHUNK, "UePh", MARKDOWN_CHUNK));
  assert.equal(read("async/168420.0210291773.js"), asyncChunk(MARKDOWN_CHUNK, EXPORTER));
  assert.equal(patchDilMarkdownFallback(root).changed, false);
});

test("duplicate Markdown exporter chunks are rejected before any reply write", t => {
  const replyName = "async/62056.3f2d3d25bb.js";
  const { root, read } = withAssets(t, {
    [replyName]: REPLY_CHUNK,
    "async/168420.0210291773.js": asyncChunk(MARKDOWN_CHUNK, EXPORTER),
    "async/168421.0210291773.js": asyncChunk(MARKDOWN_CHUNK + 1, EXPORTER),
  });
  assert.throws(() => patchDilMarkdownFallback(root), /found 1, 1, and 2/);
  assert.equal(read(replyName), REPLY_CHUNK);
});

test("exporters without the named export or with competing ids are rejected before any reply write", t => {
  const replyName = "async/62056.3f2d3d25bb.js";
  const { root, read } = withAssets(t, { [replyName]: REPLY_CHUNK });
  const exporter = path.join(root, "webview/assets/async/168420.0210291773.js");
  for (const [source, expected] of [
    [asyncChunk(1, 'UePh(e,t,n){n.d(t,{ChatGptMarkdownOther:()=>e_})}'), /found 1, 0, and 0/],
    [asyncChunk(1, 'UePh(e,t,n){const x={ChatGptMarkdown:e_};n.d(t,{x:()=>x})}'), /found 1, 0, and 0/],
    [asyncChunk(1, 'UePh(e,t,n){let x="ChatGptMarkdown:()=>e_"}'), /found 1, 0, and 0/],
    [asyncChunk(1, EXPORTER, EXPORTER.replace("UePh", "Othr")), /found 1, 2, and 0/],
    [asyncChunk(1, EXPORTER.replace("UePh", "Othr")), /not loaded with the interactive reply chunk/],
  ]) {
    fs.writeFileSync(exporter, source);
    assert.throws(() => patchDilMarkdownFallback(root), expected);
    assert.equal(read(replyName), REPLY_CHUNK);
  }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("the signed official webview exposes one patchable reply and Markdown module", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const markdown = findMarkdownModule(signedApp);
  assert.equal(markdown.length, 1);
  const markdownChunks = findMarkdownChunk(signedApp, markdown[0]);
  assert.equal(markdownChunks.length, 1);
  const replies = findWebviewAssetsContaining(signedApp, ["model_dil_v2", "source_message_status", ".prepareDil(", "errorFallback:"])
    .map((name) => fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8"));
  const patched = replies.map((source) => {
    try { return applyDilMarkdownFallback(source, markdown[0], markdownChunks[0]); } catch { return null; }
  }).filter(Boolean);
  assert.equal(patched.length, 1);
  assert.equal(applyDilMarkdownFallback(patched[0], markdown[0], markdownChunks[0]), patched[0]);
});
