"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "function codexLinuxDilMarkdownFallback(";
const IDENT = "[A-Za-z_$][\\w$]*";

function fallbackSource(jsx, failure, markdown = "codexLinuxDilMarkdownView") {
  return `${MARKER}{reference:e,source:s}){` +
    "let p=e?.model_dil_v2,m=p?.fallbackMarkdown;" +
    "if(p?.fallbackMarkdownVersion!==1||typeof m!==`string`||m.trim().length===0)" +
    `return(0,${jsx}.jsx)(${failure},{});` +
    "codexLinuxInitDilMarkdown();" +
    `return(0,${jsx}.jsx)(\`div\`,{\"data-dil-markdown-fallback\":\`\`,` +
    `children:(0,${jsx}.jsx)(${markdown},{` +
    "isStreaming:s?.source_message_status!=null&&s.source_message_status!==`finished_successfully`," +
    "textStyle:{kind:`assistant-message`},children:m})})}";
}

function applyDilMarkdownFallback(source, markdownFile) {
  if (!/^[A-Za-z0-9_-]+\.js$/.test(markdownFile)) {
    throw new Error("Invalid native ChatGPT Markdown module name");
  }
  const patched = source.includes(MARKER);
  if (patched) {
    if (source.includes("errorFallback:") &&
        source.includes("jsx)(codexLinuxDilMarkdownFallback,{reference:") &&
        source.includes("n as codexLinuxInitDilMarkdown,t as codexLinuxDilMarkdownView")) return source;
    throw new Error("Incomplete ChatGPT DIL Markdown fallback patch");
  }
  const owners = [...source.matchAll(new RegExp(
    `function ${IDENT}\\(\\{assistantMessageId:${IDENT},reference:(${IDENT}),source:(${IDENT}),`, "g",
  ))];
  const fallbacks = [...source.matchAll(new RegExp(
    `errorFallback:(${IDENT})\\?null:\\(0,(${IDENT})\\.jsx\\)\\((${IDENT}),\\{\\}\\),diagnostics:`, "g",
  ))];
  if (owners.length !== 1 || fallbacks.length !== 1 ||
      !source.includes("model_dil_v2") || !source.includes("source_message_status") ||
      !source.includes(".prepareDil(")) {
    throw new Error("ChatGPT interactive reply fallback contract changed");
  }
  const [, preparing, jsx, failure] = fallbacks[0];
  const reference = owners[0][1];
  const messageSource = owners[0][2];
  const replacement = `errorFallback:${preparing}?null:(0,${jsx}.jsx)(codexLinuxDilMarkdownFallback,{reference:${reference},source:${messageSource}}),diagnostics:`;
  const importSource = `import{n as codexLinuxInitDilMarkdown,t as codexLinuxDilMarkdownView}from"./${markdownFile}";`;
  return importSource + fallbackSource(jsx, failure) + source.replace(fallbacks[0][0], () => replacement);
}

function patchDilMarkdownFallback(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const modules = fs.readdirSync(assets).filter(file => file.endsWith(".js")).map(file => ({
    file,
    source: fs.readFileSync(path.join(assets, file), "utf8"),
  }));
  const responses = modules.filter(({ source }) =>
    source.includes("model_dil_v2") && source.includes("source_message_status") &&
    source.includes(".prepareDil(") && source.includes("errorFallback:"));
  const markdown = modules.filter(({ file, source }) =>
    /^chatgpt-markdown-view-[A-Za-z0-9_-]+\.js$/.test(file) &&
    source.includes("externalLinkAppearance") && source.includes("getDefaultComponents") &&
    new RegExp(`${IDENT} as n(?:,|\\})`).test(source) &&
    new RegExp(`${IDENT} as t(?:,|\\})`).test(source));
  if (responses.length !== 1 || markdown.length !== 1) {
    throw new Error(`Expected one interactive reply and one native Markdown module; found ${responses.length} and ${markdown.length}`);
  }
  const output = applyDilMarkdownFallback(responses[0].source, markdown[0].file);
  if (output === responses[0].source) return { changed: false };
  fs.writeFileSync(path.join(assets, responses[0].file), output, "utf8");
  return { changed: true };
}

module.exports = {
  fallbackSource,
  applyDilMarkdownFallback,
  patchDilMarkdownFallback,
  descriptors: [{
    id: "chatgpt-dil-markdown-fallback",
    phase: "extracted-app:pre-webview",
    ciPolicy: "opt-in",
    apply: patchDilMarkdownFallback,
  }],
};
