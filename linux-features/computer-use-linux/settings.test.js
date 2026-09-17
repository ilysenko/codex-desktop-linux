"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { applyNativeSettingsAvailabilityPatch: availability } = require("./settings.js");
const fixture = 'function settings(){let i=availability(),{platform:o}=platform();let s=read();return {computerUseAvailability:i,available:i.available,plugins:s.availablePlugins}}';
const original = fixture.replace('platform();let s=', 'platform(),s=');
function render(source, platform, plugins) {
  return vm.runInNewContext(`${source};settings()`, { availability:()=>({available:false,isFetching:true,isLoading:true}), platform:()=>({platform}), read:()=>({availablePlugins:plugins}) });
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
test('unsupported and ambiguous contracts fail closed',()=>{
  assert.throws(()=>availability('function unrelated(){}'),/contract/);
  assert.throws(()=>availability(original+original),/contract/);
});
test('rejects the retired synthetic Settings contract instead of preserving fabricated enablement',()=>{
  assert.throws(()=>availability(availability(original)+'let EBundledMarketplaceDonor={plugin:{enabled:!0}};'),/contract/);
});

for (const [name, patch, pristine, damage] of [
  ['availability', availability, original, source => source.replace('computerUseAvailability:i', 'computerUseAvailability:other')],
  ['availability flags', availability, original, source => source.replace('available:!0', 'available:!1')],
  ['availability platform binding', availability, original, source => source.replace('o===`linux`', 'other===`linux`')],
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
