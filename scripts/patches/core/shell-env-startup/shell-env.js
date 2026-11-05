"use strict";

const { Script } = require("node:vm");
const { escapeRegExp, findMatchingBrace } = require("../../lib/minified-js.js");
const { mainProcessFactories } = require("../../lib/main-process-factories.js");

const MARKER = "/* codex-linux-shell-env-startup */";
// A microtask still runs during early browser initialization. Yield one loop
// turn before uv_spawn installs SIGCHLD, which browser startup otherwise resets.
const DEFER = `${MARKER}if(process.platform===\`linux\`)await new Promise(setImmediate);`;
const IDENT = "[A-Za-z_$][\\w$]*";
const FAILURE_ANCHOR = /(["'`])Failed to load shell env\1/;
const LOAD_RESULT_ANCHOR = /resultSource:(["'`])load\1/;

function matchesShellEnvironment(source) {
  return source.includes(MARKER) || FAILURE_ANCHOR.test(source) &&
    LOAD_RESULT_ANCHOR.test(source) && source.includes("new AbortController");
}

function rootMatches(body, pattern) {
  return [...body.matchAll(pattern)].filter(match =>
    findMatchingBrace("{" + body.slice(0, match.index) + "}", 0) === match.index + 1);
}

function declarationAt(body, index) {
  try { new Script(body.slice(0, index) + "\nconst shellDeclaration=0;\n"); return true; }
  catch { return false; }
}

function assertStableBinding(body, name, declarationIndex) {
  const tokens = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  for (const token of body.matchAll(tokens)) {
    const decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
      (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
    if (decoded !== name || token.index === declarationIndex || body[token.index - 1] === "." ||
        /^\s*:/u.test(body.slice(token.index + token[0].length))) continue;
    if (findMatchingBrace("{" + body.slice(0, token.index) + "}".repeat(token.index + 2), 0) < token.index + 1) continue;
    // A value expression remains legal in read positions. Declarations,
    // updates and assignment/destructuring targets reject it during parsing.
    const probe = body.slice(0, token.index) + "(0)" + body.slice(token.index + token[0].length);
    try { new Script(`async function shellBindingProbe(){\n${probe}\n}`); }
    catch { throw new Error(`Shell environment ${name} binding is shadowed or written outside its declaration`); }
  }
}

function one(values, description) {
  if (values.length !== 1) throw new Error(`Expected exactly one ${description}`);
  return values[0];
}

function loaderPlan(source) {
  const owner = one(mainProcessFactories(source).filter(module =>
    FAILURE_ANCHOR.test(module.body) && LOAD_RESULT_ANCHOR.test(module.body) &&
    module.body.includes("new AbortController")), "official shell environment module");
  const body = owner.body;
  const request = one(rootMatches(body, new RegExp(
    `async function (${IDENT})\\(\\{caller:(${IDENT})="startup",retryFailed:(${IDENT})=!0,timeoutMs:(${IDENT})=5e3\\}=\\{\\}\\)\\{`, "gu",
  )).filter(head => declarationAt(body, head.index)), "official shell environment request declaration");
  const requestOpen = request.index + request[0].length - 1;
  const requestClose = findMatchingBrace(body, requestOpen);
  const requestBody = body.slice(requestOpen + 1, requestClose);
  const loader = one(rootMatches(requestBody, new RegExp(
    `let (${IDENT})=async function\\((${IDENT}),(${IDENT})\\)\\{(?=let ${IDENT}=Date\\.now\\(\\);${IDENT}\\.app\\.isPackaged)`, "gu",
  )), "official anonymous shell environment loader");
  for (const returned of rootMatches(requestBody.slice(0, loader.index), /\breturn\b/gu)) {
    try { new Script(`async function shellLoaderReachability(){\n${requestBody.slice(0, returned.index)}\nconst reached=0;\n}`); }
    catch { continue; }
    throw new Error("Shell environment loader follows an unconditional request return");
  }
  const open = requestOpen + 1 + loader.index + loader[0].length - 1;
  const close = findMatchingBrace(body, open);
  const call = new RegExp(`^\\(${escapeRegExp(request[2])},${escapeRegExp(request[4])}\\);(${IDENT})=${escapeRegExp(loader[1])},(${IDENT})=${escapeRegExp(request[4])};try\\{`, "u")
    .exec(body.slice(close + 1, requestClose));
  if (!call) throw new Error("Shell environment loader is not called by its request owner");
  const pending = escapeRegExp(call[1]), timeout = escapeRegExp(call[2]);
  if (!new RegExp(`if\\(null!=${pending}&&null!=${timeout}&&${timeout}>=${escapeRegExp(request[4])}\\)return ${pending}\\.then\\(`, "u").test(requestBody.slice(0, loader.index))) {
    throw new Error("Shell environment loader is disconnected from pending requests");
  }
  const loaderBody = body.slice(open + 1, close);
  if (!FAILURE_ANCHOR.test(loaderBody) || !LOAD_RESULT_ANCHOR.test(loaderBody) ||
      !loaderBody.includes("new AbortController") || !loaderBody.includes("Promise.race([") ||
      !new RegExp(`\\},${escapeRegExp(loader[3])}\\)\\)\\.unref\\(\\)`, "u").test(loaderBody)) {
    throw new Error("Official shell environment loader body changed");
  }
  const startup = one(rootMatches(body, new RegExp(
    `async function (${IDENT})\\(\\)\\{return ${escapeRegExp(request[1])}\\(\\{caller:"startup",retryFailed:!1\\}\\)\\}`, "gu",
  )).filter(head => declarationAt(body, head.index)), "official shell environment startup declaration");
  for (const declaration of [request, startup]) {
    if (owner.parameters.includes(declaration[1])) throw new Error("Shell startup declaration shadows a factory parameter");
    assertStableBinding(body, declaration[1], declaration.index + "async function ".length);
  }
  const loaderName = owner.parameters[2], exportsName = owner.parameters[1];
  // Omit the incoming params so a new lexical sentinel conflicts only with
  // factory-root declarations, including hoisted functions and escaped names.
  try { new Script(`async function shellPublicationBindings(){\n${body}\n;let ${loaderName};let ${exportsName};\n}`); }
  catch { throw new Error("Shell environment factory redeclares its publication parameters"); }
  const publication = one(rootMatches(body, new RegExp(
    `${escapeRegExp(loaderName)}\\.d\\(${escapeRegExp(exportsName)},\\{([^{}]+)\\}\\)`, "gu",
  )).filter(publication => declarationAt(body, publication.index)), "official shell environment exports");
  // The latest factory publishes before any executable statement or imports.
  // Its loader and export target therefore still denote the incoming params.
  if (!/^(?:\s*(?:"use strict"|'use strict');)?\s*$/u.test(body.slice(0, publication.index))) {
    throw new Error("Shell environment publication does not use the incoming factory parameters");
  }
  for (const name of [request[1], startup[1]]) {
    if ([...publication[1].matchAll(new RegExp(`(?:^|,)${IDENT}:\\(\\)=>${escapeRegExp(name)}(?=,|$)`, "gu"))].length !== 1) {
      throw new Error("Shell environment startup/request exports changed");
    }
  }
  return { moduleId: owner.identity, insertion: owner.start + open + 1 };
}

function applyShellEnvironmentStartup(source) {
  if (!matchesShellEnvironment(source)) throw new Error("Official shell environment loader contract changed");
  const markerCount = source.split(MARKER).length - 1;
  const original = markerCount === 1 ? source.replace(DEFER, "") : source;
  if (markerCount > 1 || original.includes(MARKER)) throw new Error("Incomplete shell environment startup patch");
  const { insertion } = loaderPlan(original);
  const patched = original.slice(0, insertion) + DEFER + original.slice(insertion);
  if (markerCount === 1 && patched !== source) throw new Error("Shell environment startup patch is in the wrong location");
  new Script(patched);
  return patched;
}

module.exports = { DEFER, applyShellEnvironmentStartup, matchesShellEnvironment };
