"use strict";

// Test carriers retain bounded native statements without executing a bundled
// factory, manager class or root turn. Only selected snippets run under mocks.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const data = require("./summary-contract-data.js");
const CHANNEL = "codexLinuxRemoteSummaryVisibilityPreference";
const FLOW = 'eZ=Q?.summary??"none";H?.summary!==void 0&&(eZ=H.summary),null!=s.reasoningSummaryOverride&&(eZ=s.reasoningSummaryOverride),eZ=null==eV?null:eV.model_reasoning_summary??eZ,void 0!==h.summary&&(eZ=h.summary);';

function nativeCarrier(moduleId = "V7mA") {
  const body = 'n.d(t,{O3:()=>sM});var p=n("Fkn8");' + data.previousLookup + data.previousGetter + data.configReader + data.turn +
    'class sM extends p.TF{#V(){}constructor(e){super();' + data.constructorInput + 'this.logger=R;' + data.route +
    'this.settings=Y;this.hostId=b;' + data.executionBoundary + data.executionPrefix + ',false){}}' +
    data.getDefault + data.getHost + data.getConversation + data.startTurn + '}';
  return 'export const __rspack_esm_ids=[1];export const __webpack_modules__={' + moduleId + '(e,t,n){' + body + '}};';
}

function selectedRuntime(source, scope = {}) {
  assert.equal(source.split(FLOW).length, 2, "the native 207-byte chain must remain exact");
  const declaration = source.match(/const codexLinuxRemoteSummaryVisibilityPreference=[\s\S]*?;\/\*codexCommunitySummaryChannel:[MVJ]\*\//u)?.[0] ?? "";
  const end = source.indexOf(",getRequestModel:");
  const start = source.lastIndexOf("reasoningSummaryOverride:", end) + "reasoningSummaryOverride:".length;
  assert.ok(start >= "reasoningSummaryOverride:".length);
  assert.ok(end > start && end - start < 512);
  const option = source.slice(start, end);
  const flowEnd = source.indexOf(FLOW) + FLOW.length;
  const tailEnd = source.indexOf("let eJ=", flowEnd);
  assert.ok(tailEnd >= flowEnd);
  const suffix = source.slice(flowEnd, tailEnd);
  const flag = source.match(/codexLinuxRemoteMobileHost:("local"===e\.getHostId\(\)&&"durable"===e\.getConversation\(c\)\?\.mode),turnStarts:/u)?.[1] ?? "false";
  const program = declaration + '\n(function(e,u,Q,H,eV,h){const c="test-conversation",codexLinuxRemoteMobileHost=' + flag + ';let eZ,s={reasoningSummaryOverride:' + option + '};' + FLOW + suffix + 'return eZ})';
  return vm.runInNewContext(program, scope);
}

function nativeDefaultGetter() {
  return vm.runInNewContext('({' + data.getDefault + '}).getDefaultFeatureOverride');
}

function nativeConfigReader(scope) {
  return vm.runInNewContext(data.configReader + ';aE', scope);
}

function nativeConfigurationSelection(scope) {
  const expression = 'void 0!==h.summary?void 0:aE(e.requestClient,ep)';
  assert.ok(data.turn.includes(expression));
  return vm.runInNewContext('(function(e,h,ep){return ' + expression + '})', scope);
}

function nativeInheritance(scope) {
  assert.ok(data.turn.includes('H=f?a.latestThreadSettings:null'));
  assert.ok(data.turn.includes('X=G(a),Q=f?X?.params??null:null'));
  return vm.runInNewContext(data.previousLookup + data.previousGetter + ';(function(a,f){let H=f?a.latestThreadSettings:null,X=G(a),Q=f?X?.params??null:null;return{H,Q}})', scope);
}

module.exports = { nativeCarrier, selectedRuntime, nativeDefaultGetter, nativeConfigReader, nativeConfigurationSelection, nativeInheritance, FLOW, CHANNEL };
