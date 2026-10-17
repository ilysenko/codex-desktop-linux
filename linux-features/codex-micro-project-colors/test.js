'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const runtime = require('./runtime.js');
const patch = require('./patch.js');
const {testEditors}=require('./test_editor.js');
const {testIndicator}=require('./test_indicator.js');
require('./test_picker.js');
const a={projectId:'project-a',projectKind:'local',label:'Same name',path:'/projects/a',threadKeys:['a','pinned-chat']};
const b={projectId:'project-b',projectKind:'local',label:'Same name',path:'/projects/b',threadKeys:['b']};
const keyA=runtime.projectKey(a),keyB=runtime.projectKey(b);
const colors={[keyA]:'#123456',[keyB]:'#654321'};

test('arbitrary projects receive independent colors; attention and completion retain priority', () => {
  const states=['working','awaiting-approval','awaiting-response','error','unread','idle','off'];
  const slots=states.flatMap(status=>['a','b','pinned-chat','ordinary'].map(threadKey=>({status,threadKey})));
  const result=runtime.colorSlots(slots,[a,b],colors);
  result.forEach(slot=>assert.equal(slot.colorOverride,slot.status==='working'?{a:0x123456,b:0x654321,'pinned-chat':0x123456}[slot.threadKey]:undefined));
  assert.ok(slots.every(slot=>!Object.hasOwn(slot,'colorOverride')));
  assert.deepEqual(runtime.colorSlots(slots,[a,b],{}),slots);
});

test('membership changes, rename, pinning, and duplicate key assignments retain project identity', () => {
  const slots=[{status:'working',threadKey:'a',id:0},{status:'working',threadKey:'a',id:1}];
  const check=groups=>runtime.colorSlots(slots,groups,colors).map(slot=>slot.colorOverride);
  assert.deepEqual(check([{...a,label:'Renamed',groupId:'pinned'}]),[0x123456,0x123456]);
  assert.deepEqual(check([{...b,threadKeys:['a']}]),[0x654321,0x654321]);
  assert.deepEqual(check([]),[undefined,undefined]);
  assert.deepEqual(check([{...a,projectId:'unconfigured'}]),[undefined,undefined]);
});

test('project identity separates hosts and keeps names out of the preference key',()=>{
  const remote={...a,projectKind:'remote',hostId:'server'};
  assert.notEqual(runtime.projectKey(remote),keyA);
  assert.notEqual(runtime.projectKey({...remote,hostId:'another'}),runtime.projectKey(remote));
  assert.equal(runtime.projectKey({...a,label:'Renamed'}),keyA);
});

test('storage rejects malformed identities and colors, accepts black, and resets to standard',()=>{
  for(const value of [undefined,null,[],12,'bad'])assert.deepEqual(runtime.normalizeColors(value),{});
  assert.deepEqual(runtime.normalizeColors({[keyA]:'#000000',[keyB]:'#ABCDEF'}),{[keyA]:'#000000',[keyB]:'#abcdef'});
  assert.deepEqual(runtime.normalizeColors({[keyA]:'#123',[keyB]:'#102030',invalid:'#abcdef'}),{[keyB]:'#102030'});
  for(const key of ['__proto__','null','[]','["local","local",null]','["local","local",""]','["local", "local","id"]'])
    assert.deepEqual(runtime.normalizeColors({[key]:'#ffffff'}),{});
  const result=runtime.setColor(colors,keyA,null);
  assert.deepEqual(result,{[keyB]:'#654321'});
  assert.deepEqual(colors,{[keyA]:'#123456',[keyB]:'#654321'});
  assert.deepEqual(runtime.setColor(result,keyA,'#000000'),{...result,[keyA]:'#000000'});
});

test('hardware only accepts valid RGB overrides while working', () => {
  for (const colorOverride of [-1,0x1000000,1.5,NaN,Infinity,'#123456',null,undefined])
    assert.equal(runtime.slotColor({status:'working',colorOverride},7),7);
  for (const colorOverride of [0,1,0xffffff]) assert.equal(runtime.slotColor({status:'working',colorOverride},7),colorOverride);
  for (const status of ['awaiting-approval','awaiting-response','error','unread','idle','off'])
    assert.equal(runtime.slotColor({status,colorOverride:123},7),7);
});

const bundleRoot=process.env.CODEX_MICRO_TEST_BUNDLES;
test('current official bundles: syntax, idempotence, preference controls, and lighting', {skip:!bundleRoot}, async t => {
  const sources={};
  for (const contract of patch.contracts) {
    const dir=path.join(bundleRoot,contract.directory);
    const file=fs.readdirSync(dir).find(name=>name.startsWith(contract.prefix)&&name.endsWith('.js'));
    const before=fs.readFileSync(path.join(dir,file),'utf8');
    const modelFile=contract.prefix==='codex-micro-slot-signals-'&&before.match(/from"(\.\/app-initial-[^"]+)"/)[1];
    const modelSource=modelFile?fs.readFileSync(path.join(dir,modelFile),'utf8'):undefined;
    const after=contract.patch(before,modelSource);
    assert.equal(contract.patch(after),after);
    const check=spawnSync(process.execPath,['--input-type=module','--check'],{input:after,encoding:'utf8'});
    assert.equal(check.status,0,check.stderr);
    sources[contract.prefix]={before,after,file:path.join(contract.directory,file)};
  }
  const {before:slotsBefore,after:slotsAfter}=sources['codex-micro-slot-signals-'];
  await t.test('only a color change still sends an updated lighting model',()=>{
    const match=slotsAfter.match(/function ([\w$]+)\([\w$]+\)\{return JSON\.stringify\(/);
    const start=match.index,end=slotsAfter.indexOf('function ',start+9);
    const signature=vm.runInNewContext(slotsAfter.slice(start,end)+`;${match[1]}`);
    const model={brightness:1,slots:[{id:0,status:'working',threadKey:'chat',colorOverride:1}]};
    assert.notEqual(signature(model),signature({...model,slots:[{...model.slots[0],colorOverride:2}]}));
    assert.equal(signature(model),signature(structuredClone(model)));
  });
  await t.test('native preference signal is registered with storage coercion',()=>{
    assert.match(sources['app-initial-'].after,/__cmColors=[\w$]+\("codex-micro-project-color-overrides",__cmRuntime.defaults,\{coerceStoredValue:__cmRuntime.normalizeColors\}\)/);
    assert.match(slotsAfter,/\)\).allProjectGroups/);
    assert.match(slotsAfter,/__cmRuntime.colorSlots\([\w$]+,[\w$]+\(__cmGroups\),[\w$]+\(__cmColors\)\)/);
    assert.throws(()=>patch.projectModelExport('missing model'));
    assert.ok(!slotsAfter.includes('/projects/'));
  });
  await testEditors(t,sources['app-initial-'].after,runtime);
  await testIndicator(t,sources['app-initial-'].after,runtime);
  await t.test('Micro settings contain no project color controls',()=>{
    assert.ok(!sources['codex-micro-settings-'].after.includes('__cmColorSettings'));
    assert.ok(!sources['codex-micro-settings-'].after.includes('codex-micro-project-colors-'));
  });
  await t.test('real hardware mapping preserves brightness, pulse, working animation, and voice priority',()=>{
    const service=sources['service-'].after;
    const start=service.indexOf('function $(e,n)');
    const end=service.indexOf('function le()',start);
    assert.ok(start>=0&&end>start);
    const effects={off:0,breath:1,solid:2,snake:3};
    const off={keys:{effect:0},ambient:{effect:0}};
    const color=service.match(/color:__cmSlotColor\([\w$]+,([\w$]+)\.([\w$]+)\(/);
    const functions=vm.runInNewContext(service.slice(start,end)+';({threads:$,ambient:se})',{
      __cmSlotColor:runtime.slotColor,[color[1]]:{[color[2]]:status=>({off:0,working:3166206,error:16711731}[status]??16777215)},O:effects,W:0.4,G:0.4,K:off});
    const slot={id:0,status:'working',selected:true,colorOverride:0xa855f7};
    const lit=functions.threads([slot],0.5)[0];
    assert.equal(lit.color,slot.colorOverride);assert.equal(lit.brightness,0.5);assert.equal(lit.effect,effects.breath);
    assert.equal(functions.ambient([slot],'idle',true,0.5).ambient.color,slot.colorOverride);
    assert.equal(functions.ambient([slot],'idle',false,0.5).ambient.effect,effects.snake);
    assert.equal(functions.ambient([slot],'recording',true,0.5).ambient.color,3050327);
    assert.equal(functions.threads([{...slot,status:'error'}],1)[0].color,16711731);
    assert.equal(functions.threads([{...slot,status:'off'}],1)[0].brightness,0);
    assert.equal(functions.threads([slot],0)[0].brightness,0);
  });
  await t.test('missing anchors and partial patch state fail closed',()=>{
    for (const contract of patch.contracts.filter(c=>c.prefix!=='codex-micro-settings-')) assert.throws(()=>contract.patch('unrelated upstream content'));
    assert.throws(()=>patch.patchService(sources['service-'].after.replace('color:__cmSlotColor(','color:broken(')));
  });
  await t.test('whole-feature application is idempotent and validates all bundles before writing',()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'micro-project-colors-'));
    const writeSources=()=>{for(const source of Object.values(sources)){
      const file=path.join(directory,source.file);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source.before);
    }};
    const assertUnchanged=except=>{for(const source of Object.values(sources))if(source!==except)
      assert.equal(fs.readFileSync(path.join(directory,source.file),'utf8'),source.before);
    };
    try{
      writeSources();
      const service=sources['service-'];
      fs.writeFileSync(path.join(directory,service.file),'upstream service drift');
      assert.throws(()=>patch.apply(directory));assertUnchanged(service);
      writeSources();
      const editor=sources['app-initial-'];
      fs.writeFileSync(path.join(directory,editor.file),editor.after);
      assert.throws(()=>patch.apply(directory),/Mixed project colors patch state/);assertUnchanged(editor);
      writeSources();assert.equal(patch.apply(directory).changed,true);assert.equal(patch.apply(directory).changed,false);
    }finally{fs.rmSync(directory,{recursive:true,force:true});}
  });
});
