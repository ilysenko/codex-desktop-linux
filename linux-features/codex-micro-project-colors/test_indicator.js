'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');

function testIndicator(t,source,runtime){
  return t.test('project label dot follows saved overrides without changing row semantics',()=>{
    const helper=source.slice(source.indexOf('function __cmStripProjectProp('));
    const read=helper.match(/const colors=([\w$]+)\(/)[1],jsx=helper.match(/jsx=([\w$]+)\(\)/)[1];
    let colors={};
    const signal={};
    const create=(type,props)=>({type,props});
    const context={__cmInitColors:()=>{},__cmColors:signal,__cmRuntime:runtime,[read]:()=>colors,[jsx]:()=>({jsx:create,jsxs:create})};
    const api=vm.runInNewContext(helper+';({label:__cmProjectLabel,strip:__cmStripProjectProp})',context);
    const project={projectKind:'local',hostId:'local',projectId:'example'},remote={...project,projectKind:'remote',hostId:'server'};
    const original={type:'span',props:{children:'A long project name'}};
    assert.equal(api.label({project,children:original}),original);
    const key=runtime.projectKey(project);
    colors={[key]:'#c800ff'};
    let result=api.label({project,children:original});
    assert.equal(result.props.children[0].props.children,original);
    let dot=result.props.children[1];
    assert.equal(dot.props.style.backgroundColor,'#c800ff');
    assert.equal(dot.props['aria-label'],'Micro working color override: #C800FF');
    assert.equal(dot.props.title,dot.props['aria-label']);
    assert.equal(dot.props.onClick,undefined);
    assert.equal(dot.props.tabIndex,undefined);
    assert.equal(api.label({project:remote,children:original}),original);
    colors={[key]:'#000000'};
    dot=api.label({project:{...project,label:'Renamed'},children:original}).props.children[1];
    assert.equal(dot.props.style.backgroundColor,'#000000');
    assert.ok(dot.props.style.boxShadow);
    colors={};
    assert.equal(api.label({project,children:original}),original);
    const onPress=()=>{};
    const props={__cmProject:project,label:'Plain text',onPress,ref:{},'aria-label':'Plain text'};
    const filtered=api.strip(props);
    assert.equal(filtered.__cmProject,undefined);
    assert.equal(filtered.label,'Plain text');assert.equal(filtered.onPress,onPress);
    assert.equal(filtered.ref,props.ref);assert.equal(props.__cmProject,project);
    // Data attributes/accessibility retain the original string; only the visible label is wrapped.
    assert.match(source,/\.sidebarProjectRow\(\{collapsed:[\w$]+,label:[\w$]+,projectId:[\w$]+\}\)/);
    assert.match(source,/\.jsx\)\([\w$]+,\{__cmProject:[\w$]+,ref:/);
    assert.match(source,/label:\(0,[\w$]+\.jsx\)\(__cmProjectLabel,\{project:[\w$]+\.__cmProject/);
  });
}
module.exports={testIndicator};
