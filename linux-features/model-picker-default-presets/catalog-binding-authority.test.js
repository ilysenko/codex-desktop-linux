"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {requireStableCatalogBinding:stable}=require('./catalog-binding-authority.js');
for(const[target,label]of [['n','literal'],['\\u006e','escaped']])for(const shape of [`([...${target}]=values)`,`({...${target}}=values)`,`([... ${target}]=values)`,`([.../*c*/${target}]=values)`])test('binding authority refuses '+label+' '+shape,()=>assert.throws(()=>stable(shape+';','n'),/Unstable/));
test('binding proof retains spread reads and true local rest shadows',()=>{for(const source of ['const value=[...n];','const value={... n};','function nested(...n){n=foreign}','function nested(){let n;([...n]=values)}','for(let n of []){([... n]=values)}'])assert.doesNotThrow(()=>stable(source,'n'));});
test('initializer projection still rejects later global writes and preserves actual native aliases',()=>{const source='var n=namespace;function nested(n){n=foreign}';assert.doesNotThrow(()=>stable(source,'n',4));assert.throws(()=>stable(source+';([...n]=values);','n',4),/Unstable/);});
test('object division cannot hide a captured binding write',()=>{for(const name of ['n','\\u006e'])assert.throws(()=>stable(`const value={} / (${name}=foreign) / 1;`,'n'),/Ambiguous slash/);});
