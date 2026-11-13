"use strict";

// Test carriers retain bounded native statements without executing a bundled
// factory, manager class or root turn. Only selected snippets run under mocks.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const data = require("./summary-contract-data.js");
const CHANNEL = "codexLinuxRemoteSummaryVisibilityPreference";
const FLOW = 'e4=Z?.summary??"none";H?.summary!==void 0&&(e4=H.summary),null!=s.reasoningSummaryOverride&&(e4=s.reasoningSummaryOverride),e4=null==e0?null:e0.model_reasoning_summary??e4,void 0!==h.summary&&(e4=h.summary);';

function nativeCarrier(moduleId = "V7mA") {
  const body = 'n.d(t,{O3:()=>sM});var p=n("Fkn8");' + data.canonicalIsland + data.flatten + data.turns + data.previousLookup + data.previousGetter + data.configReader + data.turn +
    'class sM extends p.TF{#Z(){}constructor(e){super();' + data.constructorInput + 'this.logger=v;' + data.route +
    data.settingsField+';'+data.hostField+';' + data.executionBoundary + data.executionPrefix + ',false){}}' +
    data.getDefault + data.getHost + data.getConversation + data.startTurn + '}';
  return 'export const __rspack_esm_ids=[1];export const __webpack_modules__={' + moduleId + '(e,t,n){' + body + '}};';
}

function selectedRuntime(source, scope = {}) {
  assert.equal(source.split(FLOW).length, 2, "the native summary precedence chain must remain exact");
  const declaration = source.match(/const codexLinuxRemoteSummaryVisibilityPreference=[\s\S]*?;\/\*codexCommunitySummaryChannel:[MVJ]\*\//u)?.[0] ?? "";
  const end = source.indexOf(",getRequestModel:");
  const start = source.lastIndexOf("reasoningSummaryOverride:", end) + "reasoningSummaryOverride:".length;
  assert.ok(start >= "reasoningSummaryOverride:".length);
  assert.ok(end > start && end - start < 512);
  const option = source.slice(start, end);
  const flowEnd = source.indexOf(FLOW) + FLOW.length;
  const suffix = source.startsWith('/*codexLinuxRemoteMobileReasoningSummaryNone*/', flowEnd)
    ? source.slice(flowEnd, source.indexOf(";", flowEnd) + 1) : "";
  const flag = source.match(/codexLinuxRemoteMobileHost:("local"===e\.getHostId\(\)&&"durable"===e\.getConversation\(c\)\?\.mode),turnStarts:/u)?.[1] ?? "false";
  const program = declaration + '\n(function(e,d,Z,H,e0,h){const c="test-conversation",codexLinuxRemoteMobileHost=' + flag + ';let e4,s={reasoningSummaryOverride:' + option + '};' + FLOW + suffix + 'return e4})';
  return vm.runInNewContext(program, scope);
}

function nativeDefaultGetter() {
  return vm.runInNewContext('({' + data.getDefault + '}).getDefaultFeatureOverride');
}

function nativeConfigReader(scope) {
  return vm.runInNewContext(data.configReader + ';ss', scope);
}

function nativeConfigurationSelection(scope) {
  const expression = 'void 0!==h.summary?void 0:ss(e.requestClient,e_)';
  assert.ok(data.turn.includes(expression));
  return vm.runInNewContext('(function(e,h,e_){return ' + expression + '})', scope);
}

function nativeInheritance(scope) {
  assert.ok(data.turn.includes('H=_?a.latestThreadSettings:null'));
  assert.ok(data.turn.includes('X=ey(a),Z=_?X?.params??null:null'));
  return vm.runInNewContext(data.canonicalIsland + data.flatten + data.turns + data.previousLookup + data.previousGetter + ';(function(a,_){let H=_?a.latestThreadSettings:null,X=ey(a),Q=_?X?.params??null:null;return{H,Q}})', scope);
}

module.exports = { nativeCarrier, selectedRuntime, nativeDefaultGetter, nativeConfigReader, nativeConfigurationSelection, nativeInheritance, FLOW, CHANNEL };
