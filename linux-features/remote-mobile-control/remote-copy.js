"use strict";

const path = require("node:path");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const scope = require("./remote-copy-scope.js");
const contracts = require("./remote-copy-contracts.js");
const ID = "[A-Za-z_$][\\w$]*";
const STRING = '"(?:\\\\.|[^"\\\\])*"';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function fail(reason) { throw Error("Native Remote copy: " + reason); }
function one(rows, reason) { if (rows.length !== 1) fail(reason);return rows[0]; }
function ownMatches(copy, expression) {
  const lexical = scope.context(copy).lexical;
  return [...copy.moduleSource.matchAll(expression)].filter(row => lexical.isCode(row.index + (row[0].startsWith('"macOS"') ? 7 : 0)));
}
function objectText(message) {
  return ["id", "defaultMessage", "description"].map(key => key + ":" + JSON.stringify(message[key])).join(",");
}

// Selected object/array data only. The shared publication helper intentionally
// handles expression properties, whose root commas do not delimit arrays.
// Balance every delimiter here; strings/comments remain opaque to the index.
function literalMember(text, key, opener) {
  const lexical = createJavaScriptLexicalIndex(text);
  const heads = [...text.matchAll(new RegExp(`(?<![\\w$.])${escape(key)}:`, "gu"))]
    .filter(row => lexical.isRoot(row.index));
  const head = one(heads, "unique data member " + key);
  const start = head.index + head[0].length;
  if (text[start] !== opener) fail("literal data member " + key);
  const stack = [], closes = { "{": "}", "[": "]", "(": ")" };
  for (let at = start; at < text.length; at++) {
    if (!lexical.isCode(at)) continue;
    const char = text[at];
    if (closes[char]) stack.push(closes[char]);
    else if ("}])".includes(char)) {
      if (stack.pop() !== char) fail("data delimiter " + key);
      if (!stack.length) return { text: text.slice(start, at + 1), start, end: at + 1 };
    }
  }
  fail("unterminated data member " + key);
}

function messages(copy, role) {
  const expected = new Map();
  for (const message of contracts.messages[role]) {
    const key = objectText(message);expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  for (const [text, count] of expected) {
    const message = contracts.messages[role].find(row => objectText(row) === text);
    const ids = ownMatches(copy, new RegExp(`(?<![\\w$.])id:${escape(JSON.stringify(message.id))}(?=,)`, "gu"));
    const exact = ownMatches(copy, new RegExp(escape(text), "gu"));
    if (ids.length !== count || exact.length !== count) fail(role + " message " + message.id);
  }
}
function sameShape(copy, role) {
  if (copy.moduleSource.length > contracts.shapes[role].moduleSource.length * 2 + 512) fail(role + " bounded native shape");
  // FormattedMessage natively publishes with exports.A=value. Its complete
  // bounded shape qualifies that write rather than treating it as mutation.
  scope.context(copy);
  const actual = scope.normalized(copy), expected = scope.normalized(contracts.shapes[role]);
  if (actual.text !== expected.text) fail(role + " native shape");
  return actual;
}
function rootOwner(copy, at) {
  return one(scope.context(copy).functions.filter(row => row.root && row.start < at && at < row.end), "root consumer");
}
function localInitializer(copy, owner, local, expression) {
  const candidates = [...owner.source.matchAll(expression)].filter(row => scope.context(copy).lexical.isCode(owner.start + row.index));
  const match = one(candidates, "local native provider " + local);
  // A selected platform/formatter value is initialized once and never written
  // again in its consumer. Same-spelled inner locals cannot authorize a site.
  for (const use of owner.source.matchAll(new RegExp(`(?<![\\w$.])${escape(local)}(?![\\w$])`, "gu"))) {
    if (!scope.context(copy).lexical.isCode(owner.start + use.index)) continue;
    const tail = owner.source.slice(use.index + local.length);
    if (/^\s*(?:=(?![=>])|\+\+|--|[+\-*/%&|^]=|\?\?=|&&=|\|\|=)/u.test(tail) &&
        !(match.index <= use.index && use.index < match.index + match[0].length)) fail("mutable native consumer " + local);
  }
  return match;
}
function stableDataMap(copy, local, allowed) {
  for (const use of ownMatches(copy, new RegExp(`(?<![\\w$.])${escape(local)}(?![\\w$])`, "gu"))) {
    try { scope.unshadowed(copy, local, use.index); } catch { continue; }
    if (!allowed.some(([start, end]) => start <= use.index && use.index < end)) fail("extra native message map authority");
  }
}
function platform(copy, owner, local, at, ids) {
  const match = localInitializer(copy, owner, local,
    new RegExp(`\\{platform:${escape(local)}\\}=\\(0,(${ID})\\.V\\)\\(\\)`, "gu"));
  if (scope.enclosingFunction(copy, at).start !== owner.start) fail("nested platform selector");
  scope.requireImport(copy, match[1], owner.start + match.index, ids.platformHook);
}
function formatter(copy, owner, local, at, ids) {
  const match = localInitializer(copy, owner, local,
    new RegExp(`(?<![\\w$.])${escape(local)}=\\(0,(${ID})\\.A\\)\\(\\)`, "gu"));
  scope.requireImport(copy, match[1], owner.start + match.index, ids.intlHook);
  if (scope.enclosingFunction(copy, at).start !== owner.start) fail("nested native formatter");
}
function settingsProof(copy, ids) {
  scope.stableFactoryParameters(copy);messages(copy, "settings");
  const entry = scope.publishedRootFunction(copy, "RemoteConnectionsSettings");
  const unique = [...new Map(contracts.messages.settings.map(row => [row.id, row])).values()];
  for (const pc of unique.filter(row => row.id.endsWith(".windows") && !row.id.endsWith("keepLive.label.windows"))) {
    const mac = unique.find(row => row.id === pc.id.slice(0, -8));
    if (!mac) fail("missing Mac sibling " + pc.id);
    const pcText = escape(objectText(pc)), macText = escape(objectText(mac));
    const jsx = new RegExp(`"macOS"!==(${ID})\\?\\(0,(${ID})\\.jsx\\)\\((${ID})\\.A,\\{${pcText}\\}\\):\\(0,\\2\\.jsx\\)\\(\\3\\.A,\\{${macText}\\}\\)`, "gu");
    const intl = new RegExp(`"macOS"!==(${ID})\\?(${ID})\\.formatMessage\\(\\{${pcText}\\}\\):\\2\\.formatMessage\\(\\{${macText}\\}\\)`, "gu");
    const rows = [...ownMatches(copy, jsx).map(row => ({ row, jsx: true })), ...ownMatches(copy, intl).map(row => ({ row, jsx: false }))];
    const expectedCount = contracts.messages.settings.filter(row => row.id === pc.id).length;
    if (rows.length !== expectedCount) fail("native PC/Mac selector " + pc.id);
    for (const { row, jsx: isJsx } of rows) {
      const owner = rootOwner(copy, row.index);scope.reachable(copy, entry, owner);
      platform(copy, owner, row[1], row.index, ids);
      if (isJsx) {
        scope.requireImport(copy, row[2], row.index, contracts.jsxRuntimeId);
        scope.requireImport(copy, row[3], row.index, ids.formatted);
      }
      else formatter(copy, owner, row[2], row.index, ids);
    }
  }
  const keep = one(ownMatches(copy, new RegExp(`(${ID})=\\(0,(${ID})\\.YK\\)\\(\\{[\\s\\S]*?keepLiveMacLabel:\\{${escape(objectText(unique.find(row => row.id === "settings.remoteConnections.localHost.keepLive.label")))}\\},keepLiveWindowsLabel:\\{${escape(objectText(unique.find(row => row.id.endsWith("keepLive.label.windows"))))}\\}\\}\\)`, "gu")), "native keep-awake map");
  if (!scope.context(copy).lexical.isRoot(keep.index)) fail("root native keep-awake map");
  if (scope.normalized(copy, keep[0]).text !== scope.normalized(contracts.keepMap, contracts.keepMap.moduleSource).text) fail("native message map values");
  scope.requireImport(copy, keep[2], keep.index, contracts.defineMessagesId);
  const mapUses = [[keep.index, keep.index + keep[1].length]];
  for (const type of ["jsx", "intl"]) {
    const map = escape(keep[1]);
    const expression = type === "jsx"
      ? new RegExp(`"macOS"!==(${ID})\\?\\(0,(${ID})\\.jsx\\)\\((${ID})\\.A,\\{\\.\\.\\.${map}\\.keepLiveWindowsLabel\\}\\):\\(0,\\2\\.jsx\\)\\(\\3\\.A,\\{\\.\\.\\.${map}\\.keepLiveMacLabel\\}\\)`, "gu")
      : new RegExp(`"macOS"!==(${ID})\\?(${ID})\\.formatMessage\\(${map}\\.keepLiveWindowsLabel\\):\\2\\.formatMessage\\(${map}\\.keepLiveMacLabel\\)`, "gu");
    const use = one(ownMatches(copy, expression), "keep-awake " + type + " consumer"), owner = rootOwner(copy, use.index);
    mapUses.push([use.index, use.index + use[0].length]);
    platform(copy, owner, use[1], use.index, ids);scope.reachable(copy, entry, owner);scope.unshadowed(copy, keep[1], use.index);
    if (type === "jsx") {
      scope.requireImport(copy, use[2], use.index, contracts.jsxRuntimeId);
      scope.requireImport(copy, use[3], use.index, ids.formatted);
    }
    else formatter(copy, owner, use[2], use.index, ids);
  }
  const allow = one(ownMatches(copy, new RegExp(`(${ID})\\.formatMessage\\(${escape(keep[1])}\\.allowConnectionsLabel\\)`, "gu")), "native allow-connections map consumer");
  const allowOwner = rootOwner(copy, allow.index);scope.reachable(copy, entry, allowOwner);
  formatter(copy, allowOwner, allow[1], allow.index, ids);mapUses.push([allow.index, allow.index + allow[0].length]);
  stableDataMap(copy, keep[1], mapUses);
  const peer = unique.filter(row => row.id.includes("manualPairingDialog.instructions."));
  for (const message of peer) {
    const at = one(ownMatches(copy, new RegExp(escape(objectText(message)), "gu")), "native peer instruction").index;
    const owner = rootOwner(copy, at);scope.reachable(copy, entry, owner);
    const prefix = copy.moduleSource.slice(Math.max(owner.start, at - 100), at);
    const render = new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID})\\.A,\\{$`, "u").exec(prefix);
    if (!render) fail("peer instruction renderer");
    scope.requireImport(copy, render[1], at, contracts.jsxRuntimeId);scope.requireImport(copy, render[2], at, ids.formatted);
  }
}
function searchProof(copy, consumer, ids) {
  scope.stableFactoryParameters(copy);
  const publication = scope.publicationMember(copy, "settingsSearchDocuments");
  if (!publication.value.startsWith("{") || !publication.value.endsWith("}")) fail("literal search publication");
  const section = literalMember(publication.value.slice(1, -1), "connections", "[").text;
  const records = [...section.matchAll(new RegExp(`\\{defaultMessage:(${STRING}),id:(${STRING})\\}`, "gu"))]
    .map(row => ({ defaultMessage: JSON.parse(row[1]), id: JSON.parse(row[2]) }));
  if (!contracts.searchMessages.length) fail("empty selected search contract");
  for (const message of contracts.searchMessages) {
    const rows = records.filter(row => row.id === message.id);
    if (rows.length !== 1 || rows[0].defaultMessage !== message.defaultMessage) fail("Connections search message " + message.id);
  }
  scope.stableFactoryParameters(consumer);
  const req = escape(consumer.params[2]);
  const load = one(ownMatches(consumer, new RegExp(`${req}\\.e\\((\\d+)\\)\\.then\\(${req}\\.bind\\(${req},${escape(JSON.stringify(ids.search))}\\)\\)\\.then\\((${ID})=>\\2\\.settingsSearchDocuments\\)\\.then\\((${ID})=>\\{(${ID})\\|\\|(${ID})\\(\\3\\)\\}\\)`, "gu")), "native search loader");
  if (load[1] !== contracts.searchChunkId) fail("native search chunk link");
  const owner = rootOwner(consumer, load.index);scope.reachable(consumer, scope.publishedRootFunction(consumer, "SettingsLayout"), owner);
  scope.unshadowed(consumer, consumer.params[2], load.index);
  const state = one([...owner.source.matchAll(new RegExp(`\\[(${ID}),${escape(load[5])}\\]=\\(0,(${ID})\\.useState\\)\\(null\\)`, "gu"))], "search loaded state");
  scope.requireImport(consumer, state[2], owner.start + state.index);
  const use = one(ownMatches(consumer, new RegExp(`messages:\\(${escape(state[1])}\\?\\.\\[(${ID})\\]\\?\\?\\[\\]\\)\\.filter\\(`, "gu")), "search loaded Connections consumer");
  if (!(owner.start < use.index && use.index < owner.end)) fail("unrelated search consumer");
  // Qualify the bounded native message-filter projection. It is
  // separate from the experimental-feature search predicate owned by UP79.
  const projection = contracts.searchProjection;
  const current = consumer.moduleSource.slice(use.index, use.index + projection.length);
  if (scope.normalized(consumer, current).text !== scope.normalized(contracts.searchConsumer, projection).text) fail("native search message filter");
  return { chunkId: load[1], selectedSearchMessages: contracts.searchMessages.length };
}

const ROLES = ["settings", "initial", "allow", "flow", "platformHook", "platformMap", "formatted", "intlHook", "search", "searchConsumer"];
function prepareNativeRemoteCopy(cohort) {
  const ids = {};
  for (const role of ROLES) {
    if (!cohort?.[role]?.length) fail("missing " + role + " cohort");
    ids[role] = one([...new Set(cohort[role].map(copy => copy.moduleId))], "mixed " + role + " identities");
  }
  if (new Set(Object.values(ids)).size !== ROLES.length) fail("overlapping native role identities");
  for (const role of Object.keys(contracts.shapes)) for (const copy of cohort[role]) {
    const proof = sameShape(copy, role);
    for (const [index, imported] of proof.imports.entries()) {
      const link = contracts.links[role].find(row => row.index === index);
      if (imported.moduleId !== (link ? ids[link.target] : contracts.importIds[role][index])) fail(role + " native import link");
    }
  }
  for (const copy of cohort.settings) settingsProof(copy, ids);
  for (const copy of cohort.search) for (const consumer of cohort.searchConsumer) searchProof(copy, consumer, ids);
  const assets = new Map();
  for (const role of ROLES) for (const copy of cohort[role]) {
    if (!Number.isInteger(copy.start) || !Number.isInteger(copy.end) || copy.start < 0 || copy.end < copy.start ||
        typeof copy.source !== "string" || copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("invalid physical snapshot");
    const known = assets.get(copy.assetName);
    if (known && known.source !== copy.source) fail("inconsistent physical snapshot");
    if (!known) assets.set(copy.assetName, { assetName: copy.assetName, source: copy.source, patchedSource: copy.source });
  }
  return Object.freeze({ edits: Object.freeze([...assets.values()].map(Object.freeze)), alreadyApplied: true,
    targetCopies: cohort.settings.length, selectedSearchMessages: contracts.searchMessages.length,
    dependencyAssets: Object.freeze([...assets.keys()].sort()) });
}
function locateNativeRemoteCopy(assets) {
  const needles = {
    settings: "RemoteConnectionsSettings:", initial: "codexMobile.setupDialog.initial.heading.windows",
    allow: "codexMobile.setupDialog.initial.title.windows", flow: "showLockedComputerUse:",
    platformHook: "modifierSymbol:", platformMap: 'qH:{macOS:"darwin",windows:"win32",linux:"linux"}',
    formatted: 'displayName="MemoizedFormattedMessage"', intlHook: ".useContext(",
    search: "settingsSearchDocuments:", searchConsumer: "SettingsLayout:",
  };
  const cohort = {};
  for (const role of ROLES) cohort[role] = findUniqueRspackModuleCopies(assets, {
    description: "native Remote copy " + role, sourceMatch: source => source.includes(needles[role]),
    matchModule: (body, copy) => {
      if (!body.includes(needles[role])) return false;
      if (contracts.shapes[role]) { try { sameShape(copy, role);return true; } catch { return false; } }
      return true;
    },
  });
  return prepareNativeRemoteCopy(cohort);
}
function applyNativeRemoteCopy(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets"), plan = locateNativeRemoteCopy(assets);
  return { ...patchWebviewAssets(assets, plan.edits, options), matched: true, targetCopies: plan.targetCopies,
    selectedSearchMessages: plan.selectedSearchMessages };
}
module.exports = { literalMember, prepareNativeRemoteCopy, locateNativeRemoteCopy, applyNativeRemoteCopy };
