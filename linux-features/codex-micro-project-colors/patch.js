'use strict';

const fs = require('node:fs');
const path = require('node:path');
const runtime = require('./runtime.js');
const picker = require('./picker.js');
const marker = 'codex-micro-project-colors-v1';
const ident = '[A-Za-z_$][\\w$]*';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replaceOne(source, pattern, replacement, description) {
  const matches = typeof pattern === 'string'
    ? source.split(pattern).length - 1 : [...source.matchAll(new RegExp(pattern.source, 'g'))].length;
  if (matches !== 1) throw Error(`${description}: expected one match, found ${matches}`);
  return source.replace(pattern, replacement);
}

function alreadyPatched(source, checks) {
  if (!source.includes(marker)) return false;
  if (source.split(marker).length !== 2 || checks.some(check => !source.includes(check)))
    throw Error('Incomplete project colors patch');
  return true;
}

function projectModelExport(source) {
  const matches = [...source.matchAll(new RegExp(`(${ident})=${ident}\\(${ident},${ident}=>\\{let ${ident}=${ident}=>\\(\\{allProjectGroups:${ident}\\.allProjectGroups,allSidebarItems:`, 'g'))];
  if (matches.length !== 1) throw Error('Missing complete project model signal');
  const exports = [...source.matchAll(new RegExp(`\\b${escape(matches[0][1])} as (${ident})[,}]`, 'g'))];
  if (exports.length !== 1) throw Error('Ambiguous project model export');
  return exports[0][1];
}

function patchSlots(source, modelSource) {
  if (alreadyPatched(source, ['__cmInitColors()', '__cmRuntime.colorSlots(', 'projectColors:', '__cmGroups=', '__cmProjectModel'])) return source;
  const key = source.match(new RegExp(`(${ident})=\x60codex-micro-custom-agent-assignments\x60`));
  if (!key) throw Error('Missing custom-assignment storage key');
  const storage = source.match(new RegExp(`${ident}=(${ident})\\(${escape(key[1])},${ident}\\)`));
  const pinned = source.match(new RegExp(`${ident}=${ident}\\(${ident},\\{canStartProjectlessChat:(${ident}),localProjectActionsEnabled:(${ident}),sidebarMode:\x60codex\x60\\}\\)`));
  const flags = pinned && pinned.slice(1).map(name => {
    const match = source.match(new RegExp(`\\b${escape(name)}=(${ident})\\((${ident})\\)`));
    if (!match) throw Error('Missing project availability flag');
    return match[2];
  });
  const signal = source.match(new RegExp(`(${ident})=(${ident})\\((${ident}),\\(\\{get:(${ident})\\}\\)=>\\{let\\{pinnedThreadKeys:`));
  if (!storage || !pinned || !signal) throw Error('Missing project or slot signal contract');
  const atom = storage[1];
  const projectExport = projectModelExport(modelSource);
  source = replaceOne(source, /import\{([^}]+)\}from"(\.\/app-initial-[^"]+)";/,
    (_, exports, file) => `import{${exports},${projectExport} as __cmProjectModel,__cmInitColors,__cmColors,__cmRuntime}from"${file}";`, 'Complete project model import');
  source = replaceOne(source, new RegExp(`(${ident})=${escape(atom)}\\((${ident}),(${ident})\\)`),
    match => `${match},__cmInitColors()`, 'Color preference signal');
  source = replaceOne(source, signal[0], `__cmGroups=${signal[2]}(${signal[3]},({get:__get})=>__get(__get(__cmProjectModel,{canStartProjectlessChat:__get(${flags[0]}),localProjectActionsEnabled:__get(${flags[1]}),sidebarMode:\`codex\`})).allProjectGroups),${signal[0]}`, 'Complete project group signal');
  source = replaceOne(source,
    new RegExp(`let (${ident})=(${ident})\\(\\{isAppWindowFocused:(${ident})\\((${ident})\\)===!0,threadKeys:(${ident}),threads:(${ident}),selectedThreadKey:\\3\\((${ident})\\)\\}\\);return (${ident})===\x60custom\x60`),
    (match, slots, builder, get) => match.replace(';return ', `;${slots}=__cmRuntime.colorSlots(${slots},${get}(__cmGroups),${get}(__cmColors));return `),
    'Project working slot colors');
  source = replaceOne(source, /return JSON\.stringify\(\{brightness:([\w$]+)\.brightness,inactivityTimeoutMs:/,
    (match, model) => match.replace('{brightness:', `{projectColors:${model}.slots.map(slot=>slot.colorOverride??null),brightness:`), 'Lighting change signature');
  return source + `\n/* ${marker} */\nvar __cmGroups;\n`;
}

function patchSettings(source) {
  if(source.includes('__cmColorSettings') || source.includes('codex-micro-project-colors-'))
    throw Error('Unexpected project color controls remain in Micro settings');
  return source;
}

function functionAt(source, text) {
  const at=source.indexOf(text);
  if(at<0 || source.indexOf(text,at+text.length)>=0)throw Error(`Missing or ambiguous editor anchor: ${text}`);
  const start=source.lastIndexOf('function ',at),end=source.indexOf('function ',at+text.length);
  if(start<0 || end<0)throw Error('Missing editor function boundary');
  return source.slice(start,end);
}

function patchProjectEditorBase(source) {
  if(alreadyPatched(source,['function __cmProjectColorField(', 'function __cmColorPicker(', 'function __cmPickerStyles(', 'function __cmInitColors(', 'Add override', 'Remove override', '__cmDraft.save()'])) {
    if(source.split('__cmDraft.save()').length!==3)throw Error('Incomplete project editor save patch');
    return source;
  }
  const parent=functionAt(source,'projectSetup.editLocalProject.title');
  const localName=parent.match(new RegExp(`\\.jsx\\)\\((${ident}),\\{deleteProject:`))?.[1];
  if(!localName)throw Error('Missing local project editor component');
  const local=functionAt(source,`function ${localName}(`);
  const remote=functionAt(source,'projectSetup.editRemoteProject.title');
  const localArgument=local.match(new RegExp(`^function ${escape(localName)}\\((${ident})\\)`))?.[1];
  const remoteProject=remote.match(new RegExp(`\\{onClose:${ident},project:(${ident})\\}=${ident}`))?.[1];
  const remoteArgument=remote.match(new RegExp(`^function ${ident}\\((${ident})\\)`))?.[1];
  const scopeMatch=local.match(new RegExp(`,${ident}=(${ident})\\((${ident})\\),\\[`));
  const reactAlias=local.match(new RegExp(`\\(0,(${ident})\\.useState\\)`))?.[1];
  const react=reactAlias && source.match(new RegExp(`\\b${escape(reactAlias)}=(${ident})\\(\\)`))?.[1];
  const jsxAlias=local.match(new RegExp(`\\(0,(${ident})\\.jsx\\)`))?.[1];
  const jsx=jsxAlias && source.match(new RegExp(`\\b${escape(jsxAlias)}=(${ident})\\(\\)`))?.[1];
  const button=local.match(new RegExp(`\\.jsx\\)\\((${ident}),\\{color:\x60ghost\x60,type:\x60button\x60`))?.[1];
  const row=local.match(new RegExp(`\\.jsx\\)\\((${ident}),\\{className:\x60gap-2\x60,children:`))?.[1];
  const detected=source.match(new RegExp(`(${ident})=(${ident})\\(\x60codex-micro-has-ever-been-detected\x60,!1\\)`));
  const read=detected && source.match(new RegExp(`${ident}=(${ident})\\(${escape(detected[1])}\\)`))?.[1];
  if(!localArgument||!remoteProject||!remoteArgument||!scopeMatch||!read||!react||!jsx||!row||!button||!detected)
    throw Error('Missing project editor or Micro availability contract');
  const detectionInit=functionAt(source,detected[0]).match(new RegExp(`^function (${ident})\\(`))[1];
  const [,scope,scopeId]=scopeMatch;

  function addField(component,projectExpression,kind) {
    const savingSetter=component.match(new RegExp(`(${ident})\\(!0\\);try\\{`))?.[1];
    const saving=savingSetter && component.match(new RegExp(`\\[(${ident}),${escape(savingSetter)}\\]=\\(0,${ident}\\.useState\\)\\(!1\\)`))?.[1];
    if(!saving)throw Error(`Missing ${kind} project saving state`);
    component=replaceOne(component,new RegExp(`^(function ${ident}\\(${ident}\\)\\{)`),
      `$1const __cmDraft=__cmUseProjectColor(${projectExpression});`,`${kind} color draft`);
    component=replaceOne(component,new RegExp(`\\(0,(${ident})\\.jsxs\\)\\((${ident}),\\{as:\x60form\x60,([^}]+),children:\\[([^\\]]+)\\]\\}\\)`),
      (match,jsx,form,props,children)=>{
        const items=children.split(',');
        if(items.length<3 || items.some(item=>!new RegExp(`^${ident}$`).test(item)))throw Error('Unexpected project form children');
        items.splice(-1,0,`(0,${jsx}.jsx)(__cmProjectColorField,{state:__cmDraft,disabled:${saving}})`);
        return match.replace(`children:[${children}]`,`children:[${items.join(',')}]`);
      },`${kind} project color field`);
    if(kind==='local'){
      component=replaceOne(component,new RegExp(`(\\}\\)\\)\\{${escape(savingSetter)}\\(!1\\);return\\})(${ident})\\(\\)`),
        '$1__cmDraft.save();$2()', 'Commit color after successful local save');
    }else{
      component=replaceOne(component,new RegExp(`(await ${ident}\\(${ident},${escape(remoteProject)},${ident}\\)),(${ident})\\(\\)`),
        '$1,__cmDraft.save(),$2()', 'Commit color after successful remote save');
    }
    return component;
  }
  source=replaceOne(source,local,addField(local,`{projectId:${localArgument}.projectId,projectKind:"local",hostId:"local"}`,'local'),'Local project editor');
  source=replaceOne(source,remote,addField(remote,`${remoteArgument}.project`,'remote'),'Remote project editor');
  return source+`\n/* ${marker} */
var __cmColors,__cmRuntime;
function __cmInitColors(){
  ${detectionInit}();
  if(__cmColors===undefined){
    __cmRuntime=__cmCreateRuntime();
    __cmColors=${detected[2]}("codex-micro-project-color-overrides",__cmRuntime.defaults,{coerceStoredValue:__cmRuntime.normalizeColors});
  }
}
function __cmCreateRuntime(){const defaults={};
${runtime.projectKey}
${runtime.normalizeColors}
${runtime.setColor}
${runtime.colorSlots}
return {defaults,projectKey,normalizeColors,setColor,colorSlots};}
function __cmUseProjectColor(project){
  __cmInitColors();
  const scope=${scope}(${scopeId}),key=__cmRuntime.projectKey(project),ref=${react}().useRef(null);
  if(ref.current===null||ref.current.key!==key)ref.current={key,touched:false,value:null};
  const state=ref.current;
  state.save=()=>{if(state.touched&&state.key!==null)scope.set(__cmColors,current=>__cmRuntime.setColor(current,state.key,state.value));};
  return state;
}
${picker.source({READ:read,DETECTED:detected[1],JSX:jsx,REACT:react,ROW:row,BUTTON:button})}
export {__cmInitColors,__cmColors,__cmRuntime};
`;
}

const indicatorMarker='codex-micro-project-color-indicator-v1';
function patchProjectIndicator(source){
  if(source.includes(indicatorMarker)){
    if(source.split(indicatorMarker).length!==2||!source.includes('function __cmProjectLabel(')||
      !source.includes('...__cmStripProjectProp(')||!source.includes('__cmProject:'))throw Error('Incomplete project color indicator');
    return source;
  }
  if(!source.includes('function __cmInitColors('))throw Error('Project color preferences are not initialized');
  const row=functionAt(source,'.sidebarProjectRow({');
  const rowName=row.match(new RegExp(`^function (${ident})\\(`))[1];
  const argument=row.match(new RegExp(`^function ${ident}\\((${ident})\\)`))[1];
  const visual=row.match(new RegExp(`\\(0,(${ident})\\.jsx\\)\\((${ident}),\\{\\.\\.\\.(${ident}),\\.\\.\\.(${ident}),\\.\\.\\.(${ident}),actions:(${ident}),icon:(${ident}),label:(${ident})\\}\\)`));
  if(!visual)throw Error('Missing project row label rendering');
  const callerMatch=source.match(new RegExp(`${ident}=${escape(rowName)},${ident}=`));
  if(!callerMatch)throw Error('Missing local/remote project row caller');
  const caller=functionAt(source,callerMatch[0]);
  const group=caller.match(new RegExp(`\\{group:(${ident}),allowReorder:`))?.[1];
  const rowAlias=callerMatch[0].split('=')[0];
  if(!group)throw Error('Missing sidebar project group identity');
  const newCaller=replaceOne(caller,new RegExp(`(\\(0,${ident}\\.jsx\\)\\(${escape(rowAlias)},\\{)`),
    `$1__cmProject:${group},`,'Project identity for color indicator');
  const newRow=replaceOne(row,visual[0],visual[0]
    .replace(`...${visual[4]},`,`...__cmStripProjectProp(${visual[4]}),`)
    .replace(`label:${visual[8]}`,`label:(0,${visual[1]}.jsx)(__cmProjectLabel,{project:${argument}.__cmProject??{projectId:${argument}.projectId,projectKind:"local",hostId:"local"},children:${visual[8]}})`),
    'Visible project label indicator');
  const helpers=source.slice(source.indexOf('function __cmProjectColorField('));
  const read=helpers.match(new RegExp(`const colors=(${ident})\\(__cmColors\\)`))?.[1];
  const jsx=helpers.match(new RegExp(`jsx=(${ident})\\(\\)`))?.[1];
  if(!read||!jsx)throw Error('Missing reactive project-color reader');
  source=replaceOne(source,caller,newCaller,'Sidebar project group');
  source=replaceOne(source,row,newRow,'Sidebar project row');
  return source+`\n/* ${indicatorMarker} */
function __cmStripProjectProp({__cmProject,...props}){return props;}
function __cmProjectLabel({project,children}){
  __cmInitColors();
  const colors=${read}(__cmColors),key=__cmRuntime.projectKey(project),color=colors[key],jsx=${jsx}();
  if(color==null)return children;
  const description="Micro working color override: "+color.toUpperCase();
  return jsx.jsxs("span",{className:"inline-flex min-w-0 max-w-full items-center gap-1.5",children:[
    jsx.jsx("span",{className:"truncate",children}),
    jsx.jsx("span",{role:"img","aria-label":description,title:description,className:"inline-block shrink-0 rounded-full",style:{width:8,height:8,backgroundColor:color,boxShadow:"inset 0 0 0 1px rgba(127,127,127,0.45)"}})
  ]});
}
`;
}
function patchProjectEditor(source){return patchProjectIndicator(patchProjectEditorBase(source));}

function patchPreview(source) {
  if (alreadyPatched(source, ['__cmSlotColor(', 'function __cmSlotColor('])) return source;
  const slot = source.match(/slot:([\w$]+)\}=([\w$]+),[^;]+,[\w$]+=\1\?\.status\?\?`off`/);
  if (!slot) throw Error('Missing agent-key preview slot');
  source = replaceOne(source, /let ([\w$]+)=`#\$\{([\w$]+)\}`,([\w$]+)=([\w$]+)===`off`/,
    (_, color, hex, off, status) => `let ${color}=\`#\${__cmSlotColor(${slot[1]},parseInt(${hex},16)).toString(16).padStart(6,"0")}\`,${off}=${status}===\`off\``, 'Agent-key preview color');
  return source + `\n/* ${marker} */\n${String(runtime.slotColor).replace('function slotColor(', 'function __cmSlotColor(')}\n`;
}

function patchService(source) {
  if (alreadyPatched(source, ['color:__cmSlotColor(', 'function __cmSlotColor('])) {
    if (source.split('color:__cmSlotColor(').length !== 3) throw Error('Incomplete hardware color patch');
    return source;
  }
  const pattern = /color:([\w$]+)\.([\w$]+)\(([\w$]+)\.status\)/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 2 || !source.includes('sendThreadsLighting') || !source.includes('syncAmbientLighting:!1'))
    throw Error(`Missing service slot/ambient color contract (${matches.length})`);
  source = source.replace(pattern, (_, module, color, slot) => `color:__cmSlotColor(${slot},${module}.${color}(${slot}.status))`);
  return source + `\n/* ${marker} */\n${String(runtime.slotColor).replace('function slotColor(', 'function __cmSlotColor(')}\n`;
}

const contracts = [
  {directory:'webview/assets', prefix:'app-initial-', patch:patchProjectEditor},
  {directory:'webview/assets', prefix:'codex-micro-slot-signals-', patch:patchSlots},
  {directory:'webview/assets', prefix:'codex-micro-settings-', patch:patchSettings},
  {directory:'webview/assets', prefix:'codex-micro-keyboard-surface-', patch:patchPreview},
  {directory:'.vite/build', prefix:'service-', patch:patchService},
];

function apply(extractedDir) {
  const pending = contracts.map(({directory,prefix,patch}) => {
    const dir = path.join(extractedDir,directory);
    const files = fs.readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith('.js'));
    if (files.length !== 1) throw Error(`Expected one ${prefix} bundle, found ${files.length}`);
    const file = path.join(dir,files[0]), before = fs.readFileSync(file,'utf8');
    const modelImport = prefix === 'codex-micro-slot-signals-' && before.match(/from"(\.\/app-initial-[^"]+)"/);
    const modelSource = modelImport ? fs.readFileSync(path.join(dir,modelImport[1]),'utf8') : undefined;
    return {file,prefix,before,after:patch(before,modelSource)};
  });
  // Validate every bundle before writing any of them.
  const patched = pending.find(item=>item.prefix==='codex-micro-slot-signals-').before.includes(marker);
  for (const item of pending) {
    const expected = item.prefix === 'codex-micro-settings-' ? false : patched;
    if (item.before.includes(marker) !== expected) throw Error('Mixed project colors patch state');
  }
  for (const item of pending) if (item.before !== item.after) fs.writeFileSync(item.file,item.after);
  return {changed:pending.some(item => item.before !== item.after),targets:pending.map(item=>path.relative(extractedDir,item.file))};
}

module.exports = {marker,indicatorMarker,patchProjectIndicator,projectModelExport,patchSlots,patchProjectEditor,patchSettings,patchPreview,patchService,apply,contracts,descriptors:[{
  id:'working-colors',phase:'extracted-app:pre-webview',order:29010,
  ciPolicy:'opt-in',enforceWhenEnabled:true,
  targetSummary:'Micro project color controls, reactive slot colors, preview, and hardware lighting',
  apply,status:result=>result.changed?'applied':'already-applied',
}]};
