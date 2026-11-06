"use strict";

const { Script } = require("node:vm");
const { escapeRegExp, createJavaScriptLexicalIndex } = require("./minified-js.js");

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const call = String.raw`(?:\(0,${identifier}\.${identifier}\)|${identifier})`;
const classifierHead = new RegExp(
  String.raw`function\(\{unit:(?<unit>${identifier}),hasFollowingFinalAnswer:(?<following>${identifier}),` +
    String.raw`keepMcpAppEntriesPersistent:(?<keep>${identifier}),mcpServerStatuses:(?<statuses>${identifier}),` +
    String.raw`plainAsyncMessageIds:(?<plainAsync>${identifier}),renderMcpApps:(?<render>${identifier})\}\)\{` +
    String.raw`if\("standalone"!==\k<unit>\.kind\)return!1;let (?<item>${identifier})=\k<unit>\.item\.item;return`,
  "g",
);

function ordinaryPredicatePosition(source, index, lexical) {
  let previous = index - 1;
  while (previous >= 0 && !lexical.isCode(previous)) previous -= 1;
  return previous > 0 && source[previous] === "|" && source[previous - 1] === "|" && lexical.isCode(previous - 1);
}

// The classifier's Set comes from the same partition invocation as its unit
// and native options. No upstream code is evaluated to establish these roles.
function currentPartitionCall(source, start, end, lexical) {
  const header = new RegExp(
    String.raw`function\((?<items>${identifier}),\{hasFollowingFinalAnswer:(?<following>${identifier})=!1,` +
      String.raw`isTurnInProgress:${identifier}=!1,keepMcpAppEntriesPersistent:(?<keep>${identifier})=!1,` +
      String.raw`mcpServerStatuses:(?<statuses>${identifier}),plainAsyncMessageIds:(?<plainAsync>${identifier}),` +
      String.raw`renderMcpApps:(?<render>${identifier})=!1\}=\{\}\)\{`, "g");
  const owners = [...source.matchAll(header)].filter(head => lexical.isCode(head.index) && head.index < start &&
    lexical.matchingBrace(head.index + head[0].length - 1) > end);
  if (owners.length !== 1) return null;
  const owner = owners[0], names = owner.groups;
  const before = source.slice(owner.index + owner[0].length, start);
  const loops = [...before.matchAll(new RegExp(
    String.raw`for\(let\[(?<index>${identifier}),(?<unit>${identifier})\]of ${escapeRegExp(names.items)}\.entries\(\)\)\{`, "g"))];
  const limits = [...before.matchAll(new RegExp(
    String.raw`(?<limit>${identifier})=${escapeRegExp(names.following)}\?${escapeRegExp(names.items)}\.length:${escapeRegExp(names.items)}\.findLastIndex\(`, "g"))];
  if (loops.length !== 1 || limits.length !== 1) return null;
  const loopStart = owner.index + owner[0].length + loops[0].index;
  const loopOpen = loopStart + loops[0][0].length - 1;
  if (!lexical.isCode(loopStart) || lexical.matchingBrace(loopOpen) <= end) return null;
  const loop = loops[0].groups;
  const expected = `({unit:${loop.unit},hasFollowingFinalAnswer:${loop.index}<${limits[0].groups.limit},` +
    `keepMcpAppEntriesPersistent:${names.keep},mcpServerStatuses:${names.statuses},` +
    `plainAsyncMessageIds:${names.plainAsync},renderMcpApps:${names.render}})`;
  if (!source.startsWith(expected, end + 1)) return null;
  const partitionEnd = lexical.matchingBrace(owner.index + owner[0].length - 1);
  return {
    partition: { start: owner.index, end: partitionEnd + 1, bindings: { ...names } },
    loop: { start: loopStart, end: lexical.matchingBrace(loopOpen) + 1 },
    call: { start: end + 1, end: end + 1 + expected.length, source: expected, unit: loop.unit },
  };
}

function nativeActivityExpression(expression, names) {
  const { item, following, keep, render, statuses, plainAsync } = names;
  const i = escapeRegExp(item);
  const first = new RegExp(String.raw`^"user-input-response"===${i}\.type\?!${i}\.completed:!!\("mcp-tool-call"===${i}\.type&&${call}\(${i}\)\)`).exec(expression);
  const assistant = new RegExp(String.raw`"assistant-message"===${i}\.type\?${call}\(${i}\)\|\|"async"===${i}\.delivery&&null!=${i}\.searchItemId&&${escapeRegExp(plainAsync)}\?\.has\(${i}\.searchItemId\)===!0`).exec(expression);
  const dynamic = new RegExp(String.raw`"dynamic-tool-call"===${i}\.type&&${call}\(${i}\)`).exec(expression);
  const mcp = new RegExp(
    String.raw`${escapeRegExp(keep)}&&${escapeRegExp(render)}&&"mcp-tool-call"===${i}\.type&&` +
      String.raw`function\(\{item:(?<mcpItem>${identifier}),mcpServerStatuses:(?<mcpStatuses>${identifier})\}\)\{let (?<result>${identifier})=\k<mcpItem>\.result\?\.type==="success"\?\k<mcpItem>\.result\.raw:null;` +
      String.raw`return\(!\k<mcpItem>\.completed\|\|null!=\k<mcpItem>\.result\)&&\(null!=\k<mcpItem>\.mcpAppResourceUri\|\|null!=${call}\(\{mcpServerStatuses:\k<mcpStatuses>,server:\k<mcpItem>\.invocation\.server,tool:\k<mcpItem>\.invocation\.tool,toolResult:\k<result>\}\)\)\}` +
      String.raw`\(\{item:${i},mcpServerStatuses:${escapeRegExp(statuses)}\}\)`, "g");
  const mcps = [...expression.matchAll(mcp)];
  if (!first || !assistant || !dynamic || mcps.length !== 1) return null;
  const user = `"user-message"===${item}.type&&("pending"===${item}.steeringStatus||!0===${item}.followsInterruptedFinalAnswer||` +
    `!0===${item}.wasInHistoryPreview||"not-sent"===${item}.deliveryStatus||!0===${item}.hookFeedback||!${following})`;
  const expected = `${first[0]}||(${assistant[0]}:!!(${dynamic[0]}||${mcps[0][0]})||${user})`;
  return expression.startsWith(expected) ? expected : null;
}


// Return current native roles and half-open original-source ranges. Callers
// own any expression surrounding the native result and all feature policy.
function inspectActivityPartition(source) {
  const failed = (reason, candidateCount) => ({ ok: false, reason, candidateCount });
  if (typeof source !== "string") return failed("expected activity source text", 0);
  const lexical = createJavaScriptLexicalIndex(source);
  const heads = [...source.matchAll(classifierHead)].filter(head => lexical.isCode(head.index));
  if (heads.length !== 1) return failed("missing or ambiguous current activity classifier", heads.length);
  const [head] = heads;
  if (!ordinaryPredicatePosition(source, head.index, lexical)) return failed("expected ordinary direct activity predicate", 1);
  const open = head.index + head[0].indexOf("){if(") + 1;
  const end = lexical.matchingBrace(open);
  if (end < open) return failed("incomplete activity classifier", 1);
  const owner = currentPartitionCall(source, head.index, end, lexical);
  if (!owner) return failed("disconnected activity partition or caller bindings", 1);
  try { new Script(`const partition=${source.slice(owner.partition.start, owner.partition.end)};`); }
  catch { return failed("invalid activity partition syntax", 1); }
  const start = head.index + head[0].length;
  const expression = source.slice(start, end);
  const prefix = `"user-input-response"===${head.groups.item}.type?`;
  const nativeStart = expression.indexOf(prefix);
  if (nativeStart < 0 || nativeStart !== expression.lastIndexOf(prefix)) return failed("missing or ambiguous native activity expression", 1);
  const native = nativeActivityExpression(expression.slice(nativeStart), head.groups);
  if (!native) return failed("current native activity policy drifted", 1);
  return {
    ok: true,
    candidateCount: 1,
    ...owner,
    names: { ...head.groups },
    classifier: { start: head.index, end: end + 1 },
    expression: { start, end, source: expression },
    nativeExpression: { start: start + nativeStart, end: start + nativeStart + native.length, source: native },
  };
}

module.exports = { inspectActivityPartition };
