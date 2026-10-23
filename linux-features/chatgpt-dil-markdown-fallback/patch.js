"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "function codexLinuxDilMarkdownFallback(";
const IDENT = "[A-Za-z_$][\\w$]*";
const MODULE_PATH = `(?:"[./A-Za-z0-9_-]+\\.js"|'[./A-Za-z0-9_-]+\\.js')`;
const MARKDOWN_WRAPPER = new RegExp(
  `^(?:\\s*import\\s*(?:${MODULE_PATH}|\\{[\\w$,\\s]+\\}\\s*from\\s*${MODULE_PATH})\\s*;)*\\s*` +
  `(?:${IDENT}\\s*\\(\\s*\\)\\s*;\\s*)*export\\s*\\{([\\w$,\\s]+)\\}\\s*;?\\s*` +
  `(?:\\/\\/# sourceMappingURL=[^\\r\\n]*)?\\s*$`,
);

function fallbackSource(jsx, failure, markdown = "codexLinuxDilMarkdownView") {
  return `${MARKER}{reference:e}){` +
    "let p=e?.model_dil_v2,m=p?.fallbackMarkdown;" +
    "if(p?.fallbackMarkdownVersion!==1||typeof m!==`string`||m.trim().length===0)" +
    `return(0,${jsx}.jsx)(${failure},{});` +
    `return(0,${jsx}.jsx)(\`div\`,{\"data-dil-markdown-fallback\":\`\`,` +
    `children:(0,${jsx}.jsx)(${markdown},{` +
    "isStreaming:false," +
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
        source.includes("ChatGptMarkdown as codexLinuxDilMarkdownView")) return source;
    throw new Error("Incomplete ChatGPT DIL Markdown fallback patch");
  }
  const owners = [...source.matchAll(new RegExp(
    `function ${IDENT}\\(\\{assistantMessageId:${IDENT},reference:(${IDENT}),source:${IDENT},`, "g",
  ))];
  const fallbacks = [...source.matchAll(new RegExp(
    `errorFallback:(${IDENT})\\?null:\\(0,(${IDENT})\\.jsx\\)\\((${IDENT}),\\{[^{}]{0,200}\\}\\),diagnostics:`, "g",
  ))];
  if (owners.length !== 1 || fallbacks.length !== 1 ||
      !source.includes("model_dil_v2") || !source.includes("source_message_status") ||
      !source.includes(".prepareDil(")) {
    throw new Error("ChatGPT interactive reply fallback contract changed");
  }
  const [, preparing, jsx, failure] = fallbacks[0];
  const reference = owners[0][1];
  const replacement = `errorFallback:${preparing}?null:(0,${jsx}.jsx)(codexLinuxDilMarkdownFallback,{reference:${reference}}),diagnostics:`;
  const importSource = `import{ChatGptMarkdown as codexLinuxDilMarkdownView}from"./${markdownFile}";`;
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
  // The public wrapper initializes the native view and exports its stable name.
  // The implementation chunk's single-letter exports are not a safe contract.
  const markdown = modules.filter(({ source }) => {
    const exports = source.match(/\bexport\s*\{([^{}]*)\}\s*;?\s*(?:\/\/# sourceMappingURL=[^\r\n]*)?\s*$/)?.[1];
    return exports != null && exports.split(",").some(entry =>
      new RegExp(`^(?:${IDENT}\\s+as\\s+)?ChatGptMarkdown$`).test(entry.trim()));
  });
  if (responses.length !== 1 || markdown.length !== 1) {
    throw new Error(`Expected one interactive reply and one native Markdown module; found ${responses.length} and ${markdown.length}`);
  }
  // Validate the whole unique entry so comments or string examples cannot
  // qualify, and competing named exports are rejected even in larger modules.
  if (!MARKDOWN_WRAPPER.test(markdown[0].source)) {
    throw new Error("Native ChatGPT Markdown wrapper contract changed");
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
