"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const {
  applyNativeSettingsAvailabilityPatch: availability,
  applyNativeSettingsVisibilityPatch: visibility,
  matchesNativeSettingsVisibilityContract,
} = require("./settings.js");
// rspack/SWC shape of the Settings → Computer use page owner.
const fixture = 'function settings(){let i=(0,O.H)(e),{platform:o}=(0,q.V)();let s=(0,C.l)();return {computerUseAvailability:i,available:i.available,plugins:s.availablePlugins}}';
const original = fixture.replace('(0,q.V)();let s=', '(0,q.V)(),s=');
function render(source, platform, plugins) {
  return vm.runInNewContext(`${source};settings()`, { e:{hostId:'local'}, O:{H:()=>({available:false,isFetching:true,isLoading:true})}, q:{V:()=>({platform})}, C:{l:()=>({availablePlugins:plugins})} });
}
test('Linux availability uses genuine disabled plugin state and never fabricates a missing plugin',()=>{
  const patched=availability(original);
  for(const plugins of [[],[{plugin:{name:'computer-use',installed:true,enabled:false}}]]) {
    const result=render(patched,'linux',plugins);
    assert.equal(result.available,true);
    assert.equal(result.computerUseAvailability.isLoading,false);
    assert.equal(result.plugins,plugins);
  }
  assert.equal(render(patched,'darwin',[]).available,false);
  assert.equal(availability(patched),patched);
});
const filter='function Esc(e,t,n){if(0===t.length&&!n)return e;let r=new Set(t);return e.filter(e=>(!n||!(0,i.zG)(e.plugin.id))&&!r.has(e.plugin.id))}';
test('Plugins presentation hides only the bundled native component',()=>{
  const plugins=[{marketplaceName:'openai-bundled',plugin:{id:'computer-use@openai-bundled',name:'computer-use',enabled:false}},{marketplaceName:'openai-bundled',plugin:{id:'browser@openai-bundled',name:'browser'}},{marketplaceName:'custom',plugin:{id:'computer-use@custom',name:'computer-use'}}];
  const patched=visibility(filter);
  const run=(hidden=[],restrictedMode=false)=>vm.runInNewContext(`${patched};Esc(plugins,hidden,mode)`,{plugins,hidden,mode:restrictedMode,i:{zG:id=>id.startsWith('browser')}});
  assert.deepEqual(Array.from(run()),plugins.slice(1));
  assert.deepEqual(Array.from(run(['computer-use@custom'])),plugins.slice(1,2));
  assert.deepEqual(Array.from(run([],true)),plugins.slice(2));
  assert.equal(plugins.length,3);
  assert.equal(matchesNativeSettingsVisibilityContract(filter),true);
  assert.equal(matchesNativeSettingsVisibilityContract(patched),true);
  assert.equal(visibility(patched),patched);
});
test('unsupported and ambiguous contracts fail closed',()=>{
  // Pre-rspack template-literal and plain-call shapes are retired.
  assert.throws(()=>availability('function settings(){let i=Ft(r),{platform:a}=Ze(),o=ft();return {computerUseAvailability:i,available:i.available}}'),/contract/);
  assert.equal(matchesNativeSettingsVisibilityContract(filter.replace('0===t.length','t.length===0')),false);
  assert.equal(matchesNativeSettingsVisibilityContract(filter.replace('(0,i.zG)','pqn')),false);
  assert.throws(()=>availability('function unrelated(){}'),/contract/);
  assert.throws(()=>availability(original+original),/contract/);
  assert.equal(matchesNativeSettingsVisibilityContract('function unrelated(){}'),false);
  assert.equal(matchesNativeSettingsVisibilityContract(filter+filter),false);
  assert.throws(()=>visibility('function unrelated(){}'),/contract/);
  assert.throws(()=>visibility(filter+filter),/contract/);
});
test('rejects the retired synthetic Settings contract instead of preserving fabricated enablement',()=>{
  assert.throws(()=>availability(availability(original)+'let EBundledMarketplaceDonor={plugin:{enabled:!0}};'),/contract/);
});

for (const [name, patch, pristine, damage] of [
  ['availability', availability, original, source => source.replace('computerUseAvailability:i', 'computerUseAvailability:other')],
  ['availability flags', availability, original, source => source.replace('available:!0', 'available:!1')],
  ['availability platform binding', availability, original, source => source.replace('"linux"===o', '"linux"===other')],
  ['visibility', visibility, filter, source => source.replace('&&!r.has(e.plugin.id)', '')],
  ['visibility exclusion', visibility, filter, source => source.replace('openai-bundled', 'custom')],
]) {
  test(`${name} rejects mixed, duplicate, and damaged patched owners`, () => {
    const patched = patch(pristine);
    const damaged = damage(patched);
    assert.notEqual(damaged, patched);
    for (const source of [patched + ';' + pristine, pristine + ';' + patched,
      patched + ';' + patched, damaged, patched + ';' + damaged, pristine + ';' + damaged]) {
      assert.throws(() => patch(source), /contract/, source);
    }
  });
}
