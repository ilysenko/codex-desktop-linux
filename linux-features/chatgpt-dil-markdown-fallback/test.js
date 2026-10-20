"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { fallbackSource, applyDilMarkdownFallback, patchDilMarkdownFallback } = require("./patch.js");

const fixture = "function reply({assistantMessageId:a,reference:r,source:s,dilComponents:c}){" +
  "let p=r.model_dil_v2,st=s.source_message_status;return{dil:program.prepareDil(p.code)," +
  "errorFallback:preparing?null:(0,jsx.jsx)(Failure,{}),diagnostics:enabled}}";

function fallback() {
  let initialized = 0;
  const context = vm.createContext({
    jsx: { jsx: (type, props) => ({ type, props }) },
    Failure: "Failure",
    Markdown: "Markdown",
    codexLinuxInitDilMarkdown: () => { initialized++; },
  });
  vm.runInContext(fallbackSource("jsx", "Failure", "Markdown"), context);
  return { render: context.codexLinuxDilMarkdownFallback, initialized: () => initialized };
}

test("failed replies render only versioned Markdown through the native renderer", () => {
  const { render, initialized } = fallback();
  const result = render({ source: { source_message_status: "finished_successfully" }, reference: { model_dil_v2: {
    code: "DO_NOT_DISPLAY_OR_EXECUTE()", fallbackMarkdownVersion: 1,
    fallbackMarkdown: "正文\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x=1;\n```",
  } } });
  assert.equal(result.type, "div");
  assert.equal(result.props["data-dil-markdown-fallback"], "");
  assert.equal(result.props.children.type, "Markdown");
  assert.match(result.props.children.props.children, /^正文/);
  assert.equal(result.props.children.props.isStreaming, false);
  assert.equal(initialized(), 1);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_DISPLAY_OR_EXECUTE/);
});

test("missing, empty, invalid or unversioned fallback keeps the original failure", () => {
  for (const payload of [undefined, {}, {fallbackMarkdown:"answer"},
    {fallbackMarkdownVersion:2,fallbackMarkdown:"answer"},
    {fallbackMarkdownVersion:1,fallbackMarkdown:" \n"},
    {fallbackMarkdownVersion:1,fallbackMarkdown:123},
    {fallbackMarkdownVersion:1,code:"DIL.render(secret)"}]) {
    const { render, initialized } = fallback();
    assert.equal(render({reference:{model_dil_v2:payload}}).type, "Failure");
    assert.equal(initialized(), 0);
  }
});

test("streaming fallback remains eligible for subsequent text updates", () => {
  const { render } = fallback();
  const source = {source_message_status:"in_progress"};
  const reference = {model_dil_v2:{fallbackMarkdownVersion:1,fallbackMarkdown:"partial"}};
  assert.equal(render({reference,source}).props.children.props.isStreaming, true);
  reference.model_dil_v2.fallbackMarkdown = "updated";
  assert.equal(render({reference,source}).props.children.props.children, "updated");
  source.source_message_status = "finished_successfully";
  assert.equal(render({reference,source}).props.children.props.isStreaming, false);
  assert.equal(render({reference}).props.children.props.isStreaming, false);
});

test("patch targets only the failure branch and is idempotent", () => {
  const patched = applyDilMarkdownFallback(fixture, "chatgpt-markdown-view-current.js");
  assert.match(patched, /errorFallback:preparing\?null:\(0,jsx.jsx\)\(codexLinuxDilMarkdownFallback,\{reference:r,source:s\}\)/);
  assert.ok(patched.includes("dil:program.prepareDil(p.code)"));
  assert.equal(applyDilMarkdownFallback(patched, "chatgpt-markdown-view-current.js"), patched);
  const renamed = fixture.replaceAll("jsx.jsx", () => "$$.jsx");
  assert.ok(applyDilMarkdownFallback(renamed, "markdown.js").includes(
    "errorFallback:preparing?null:(0,$$.jsx)(codexLinuxDilMarkdownFallback,{reference:r,source:s})",
  ));
  assert.throws(() => applyDilMarkdownFallback(fixture.replace("errorFallback:", "fallback:"), "markdown.js"), /contract changed/);
  assert.throws(() => applyDilMarkdownFallback(fixture + fixture, "markdown.js"), /contract changed/);
  assert.throws(() => applyDilMarkdownFallback(fixture, "../bad.js"), /Invalid/);
});

test("runner startup failure reaches the patched fallback; success and preparation stay unchanged", async () => {
  // Reduced upstream boundary: the DIL runtime selects errorFallback after its
  // asynchronous runner startup fails. JSX children remain lazy as in React.
  const boundary = "function reply({assistantMessageId:a,reference:r,source:s,dilComponents:c}){" +
    "let preparing=s.preparing,status=s.source_message_status;return(0,jsx.jsx)(Runtime,{" +
    "dil:program.prepareDil(r.model_dil_v2.code)," +
    "errorFallback:preparing?null:(0,jsx.jsx)(Failure,{}),diagnostics:false})}";
  const patched = applyDilMarkdownFallback(boundary, "chatgpt-markdown-view-current.js");
  const importLine = 'import{n as codexLinuxInitDilMarkdown,t as codexLinuxDilMarkdownView}from"./chatgpt-markdown-view-current.js";';
  assert.ok(patched.startsWith(importLine));
  const reference = {model_dil_v2:{code:"interactive-program",fallbackMarkdownVersion:1,fallbackMarkdown:"Saved answer"}};

  async function render(source, {fails, preparing = false}) {
    let initialized = 0;
    const prepared = [];
    const context = vm.createContext({
      jsx: {jsx: (type, props) => ({type, props})},
      Failure: "Failure",
      codexLinuxDilMarkdownView: "Markdown",
      codexLinuxInitDilMarkdown: () => { initialized++; },
      program: {prepareDil: code => { prepared.push(code); return code; }},
      Runtime: async props => {
        try {
          await (fails ? Promise.reject(new Error("frame_timeout")) : Promise.resolve());
          return {type:"Interactive",props:{code:props.dil}};
        } catch {
          return props.errorFallback;
        }
      },
    });
    vm.runInContext(source, context);
    const root = context.reply({assistantMessageId:"a",reference,source:{preparing,source_message_status:"finished_successfully"}});
    let result = await root.type(root.props);
    if (typeof result?.type === "function") result = result.type(result.props);
    assert.deepEqual(prepared, ["interactive-program"]);
    return {result, initialized};
  }

  assert.equal((await render(boundary, {fails:true})).result.type, "Failure");
  const failed = await render(patched.slice(importLine.length), {fails:true});
  assert.equal(failed.result.props.children.type, "Markdown");
  assert.equal(failed.result.props.children.props.children, "Saved answer");
  assert.equal(failed.result.props.children.props.isStreaming, false);
  assert.equal(failed.initialized, 1);
  const success = await render(patched.slice(importLine.length), {fails:false});
  assert.equal(success.result.type, "Interactive");
  assert.equal(success.initialized, 0);
  const preparing = await render(patched.slice(importLine.length), {fails:true,preparing:true});
  assert.equal(preparing.result, null);
  assert.equal(preparing.initialized, 0);
});

test("module discovery is fail closed and writes only after all contracts match", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dil-markdown-test-"));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const assets = path.join(root,"webview","assets");fs.mkdirSync(assets,{recursive:true});
  const file = path.join(assets,"response-A.js");fs.writeFileSync(file,fixture);
  assert.throws(() => patchDilMarkdownFallback(root), /found 1 and 0/);
  assert.equal(fs.readFileSync(file,"utf8"), fixture);
  fs.writeFileSync(path.join(assets,"chatgpt-markdown-view-B.js"), "externalLinkAppearance;getDefaultComponents;export{init as n,view as t}");
  assert.equal(patchDilMarkdownFallback(root).changed,true);
  assert.equal(patchDilMarkdownFallback(root).changed,false);
});
