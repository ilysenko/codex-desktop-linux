"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  escapeRegExp,
  findMatchingBrace,
} = require("../lib/minified-js.js");
const {
  findCodexRequestWebviewAsset,
  findRequiredWebviewAsset,
} = require("../lib/assets.js");
const {
  linuxSettingsKeys,
} = require("../lib/settings-keys.js");

// Keybind settings are transactional: either all dependent webview assets are
// updated together, or the patch logs a warning and leaves the app usable.
const keybindsSettingsAsset = "keybinds-settings-linux.js";
const linuxDesktopSettingsAsset = "linux-desktop-settings-linux.js";
const linuxKeybindOverridesKey = "codex-linux-keybind-overrides";
const linuxReactRuntimeExport = "codexLinuxReact";
const linuxJsxRuntimeExport = "codexLinuxJsx";

function versionedAssetSpecifier(assetName, source) {
  const digest = crypto.createHash("sha256").update(source).digest("hex").slice(0, 12);
  return `${assetName}?v=${digest}`;
}

function linuxBuildInfoPanelSource() {
  return `function codexLinuxBuildInfoValue(value,fallback="unknown"){return typeof value=="string"&&value.trim().length>0?value:Array.isArray(value)&&value.length>0?value.join(", "):value==null?fallback:String(value)}function codexLinuxBuildInfoRows(payload){let info=payload?.info;if(!info)return [["Metadata file",codexLinuxBuildInfoValue(payload?.path,"not found")]];let target=info.linuxTarget??{},distro=target.distro??{},dmg=info.upstreamDmg??{},source=info.source??{},features=info.linuxFeatures?.enabled??[],profile=info.packageProfile??{},commit=source.commit||source.shortCommit||"",commitValue=commit?source.dirty?commit+" (dirty)":commit:"unknown",distroValue=distro.prettyName||[distro.id,distro.versionId].filter(Boolean).join(" ")||"unknown";return [["Metadata file",codexLinuxBuildInfoValue(payload?.path)],["Linux package profile",codexLinuxBuildInfoValue(profile.label)],["Linux source commit",commitValue,payload?.commitUrl],["Source branch",codexLinuxBuildInfoValue(source.branch)],["Generated",codexLinuxBuildInfoValue(info.generatedAt)],["Distro",distroValue],["Package manager",codexLinuxBuildInfoValue(target.packageManager??profile.packageManager)],["Package format",codexLinuxBuildInfoValue(target.packageFormat??profile.format)],["Enabled features",features.length>0?features.join(", "):"none"],["Upstream app version",codexLinuxBuildInfoValue(dmg.appVersion)],["Electron",codexLinuxBuildInfoValue(info.electronVersion)],["Upstream DMG SHA256",codexLinuxBuildInfoValue(dmg.sha256)]].filter(row=>row[1]!=null)}class LinuxBuildInfoPanel extends React.Component{constructor(props){super(props),this._alive=!1,this.state={data:null,isLoading:!0,error:null,copied:!1},this.load=this.load.bind(this),this.copyCommit=this.copyCommit.bind(this),this.openCommit=this.openCommit.bind(this),this.showDetails=this.showDetails.bind(this),this.fail=this.fail.bind(this)}componentDidMount(){this._alive=!0,this.load()}componentWillUnmount(){this._alive=!1}fail(err){this._alive&&this.setState({error:err instanceof Error?err.message:String(err)})}load(){this.setState({isLoading:!0,error:null}),__post("codex-linux-get-build-info",{}).then(result=>{this._alive&&this.setState({data:result})}).catch(this.fail).finally(()=>{this._alive&&this.setState({isLoading:!1})})}copyCommit(){let info=this.state.data?.info,commit=info?.source?.commit||"";commit&&(navigator.clipboard?.writeText?navigator.clipboard.writeText(commit).then(()=>{this._alive&&(this.setState({copied:!0}),setTimeout(()=>{this._alive&&this.setState({copied:!1})},1500))}).catch(this.fail):this.fail("Clipboard API is unavailable"))}openCommit(){(this.state.data?.commitUrl||"")&&__post("codex-linux-open-build-info-commit",{}).catch(this.fail)}showDetails(){__post("codex-linux-show-build-info",{}).catch(this.fail)}render(){let{data,isLoading,error,copied}=this.state,info=data?.info,commit=info?.source?.commit||"",commitUrl=data?.commitUrl||"",buttonClass="h-8 cursor-pointer rounded-md border border-token-border-default px-3 text-sm text-token-text-primary hover:bg-token-surface-secondary disabled:cursor-not-allowed disabled:opacity-60",rows=codexLinuxBuildInfoRows(data),actionsByLabel={"Metadata file":[{key:"details",label:"Details",disabled:!1,onClick:this.showDetails}],"Linux source commit":[{key:"copyCommit",label:"Copy commit",disabled:!commit,onClick:this.copyCommit},{key:"openCommit",label:"Open on GitHub",disabled:!commitUrl,onClick:this.openCommit}],"Generated":[{key:"refresh",label:"Refresh",disabled:isLoading,onClick:this.load}]},description=isLoading?$.jsx("span",{children:"Loading build metadata..."}):$.jsxs("div",{className:"flex flex-col gap-2 text-sm",children:[$.jsx("dl",{className:"grid gap-x-4 gap-y-3 rounded-md border border-token-border-default bg-token-bg-secondary p-3 sm:grid-cols-[150px_minmax(0,1fr)]",children:rows.map(([label,value,url])=>{let valueNode=url?$.jsx("a",{href:url,title:url,onClick:event=>{event.preventDefault(),this.openCommit()},className:"select-text break-all rounded bg-token-bg-primary px-1.5 py-0.5 font-mono text-xs text-token-text-primary underline decoration-token-text-tertiary underline-offset-2 hover:decoration-token-text-primary",children:value}):$.jsx("code",{className:"select-text break-all rounded bg-token-bg-primary px-1.5 py-0.5 font-mono text-xs text-token-text-primary",children:value}),actions=actionsByLabel[label]??[],rowContent=actions.length>0?$.jsxs("div",{className:"flex min-w-0 flex-col items-start gap-2",children:[valueNode,$.jsx("div",{className:"flex flex-wrap items-center gap-2",children:actions.map(action=>$.jsx("button",{type:"button",className:buttonClass,disabled:action.disabled,onClick:action.onClick,children:action.label},action.key))})]}):valueNode;return $.jsxs(React.Fragment,{children:[$.jsx("dt",{className:"text-token-text-tertiary",children:label}),$.jsx("dd",{className:"min-w-0",children:rowContent})]},label)})}),error?$.jsx("span",{className:"text-token-error-foreground",children:error}):null,copied?$.jsx("span",{className:"text-token-text-secondary",children:"Commit copied"}):null]});return $.jsx(SettingsRow,{label:"Build information",description,control:null})}}`;
}

function linuxDesktopSettingsControlsSource() {
  return `function codexLinuxChecked(next){return next&&typeof next=="object"&&next.target&&typeof next.target.checked=="boolean"?next.target.checked:next===!0}class LinuxToggle extends React.Component{constructor(props){super(props),this._alive=!1,this.state={value:props.defaultValue??!0,isLoading:!0,error:null},this.load=this.load.bind(this),this.update=this.update.bind(this)}componentDidMount(){this._alive=!0,this.load()}componentDidUpdate(previous){(previous.settingKey!==this.props.settingKey||previous.defaultValue!==this.props.defaultValue)&&this.load()}componentWillUnmount(){this._alive=!1}load(){let{settingKey:key,defaultValue=!0}=this.props;this.setState({isLoading:!0}),__post("get-global-state",{params:{key}}).then(result=>{this._alive&&this.setState({value:result?.value??defaultValue,error:null})}).catch(err=>{this._alive&&this.setState({error:err instanceof Error?err.message:String(err)})}).finally(()=>{this._alive&&this.setState({isLoading:!1})})}update(next){let value=codexLinuxChecked(next),previous=this.state.value,{settingKey:key}=this.props;this.setState({value,error:null}),__post("set-global-state",{params:{key,value}}).catch(err=>{this._alive&&this.setState({value:previous,error:err instanceof Error?err.message:String(err)})})}render(){let{label,description}=this.props,{value,isLoading,error}=this.state,details=error?$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("span",{children:description}),$.jsx("span",{className:"text-token-error-foreground",children:error})]}):description;return $.jsx(SettingsRow,{label,description:details,control:$.jsx(Toggle,{checked:value,disabled:isLoading,onChange:this.update,ariaLabel:label})})}}`;
}

function buildKeybindsSettingsSource({
  chunkAsset,
  reactAsset,
  reactExportName = "t",
  jsxRuntimeAsset,
  jsxRuntimeExportName = "t",
  vscodeApiAsset,
  vscodeApiExportName = "n",
  hotkeySettingsAsset,
  settingsRowAsset,
  settingsRowExportName = "n",
  settingsPageAsset,
  settingsPageExportName = "t",
  settingsSectionAsset,
  settingsSectionExportName = "r",
  settingsGroupAsset,
  settingsGroupExportName = "n",
  toggleAsset,
  toggleExportName = "t",
}) {
  const reactImport = reactAsset === jsxRuntimeAsset
    ? `import{${reactExportName} as __reactFactory,${jsxRuntimeExportName} as __jsxFactory}from"./${jsxRuntimeAsset}";`
    : `import{${reactExportName} as __reactFactory}from"./${reactAsset}";import{${jsxRuntimeExportName} as __jsxFactory}from"./${jsxRuntimeAsset}";`;
  const defaultShortcuts = {
    copyConversationPath: "CmdOrCtrl+Alt+Shift+C",
    copyDeeplink: "CmdOrCtrl+Alt+L",
    copySessionId: "CmdOrCtrl+Alt+C",
    copyWorkingDirectory: "CmdOrCtrl+Shift+C",
    reloadBrowserPage: "CmdOrCtrl+R",
    hardReloadBrowserPage: "CmdOrCtrl+Shift+R",
    newThread: "CmdOrCtrl+N",
    newThreadAlt: "CmdOrCtrl+Shift+O",
    quickChat: "CmdOrCtrl+Alt+N",
    openCommandMenu: "CmdOrCtrl+K",
    openCommandMenuAlt: "CmdOrCtrl+Shift+P",
    searchChats: "CmdOrCtrl+G",
    searchFiles: "CmdOrCtrl+P",
    renameThread: "CmdOrCtrl+Alt+R",
    toggleFileTreePanel: "CmdOrCtrl+Shift+E",
    archiveThread: "CmdOrCtrl+Shift+A",
    toggleThreadPin: "CmdOrCtrl+Alt+P",
    previousThread: "CmdOrCtrl+Shift+[",
    nextThread: "CmdOrCtrl+Shift+]",
    settings: "CmdOrCtrl+,",
    openFolder: "CmdOrCtrl+O",
    findInThread: "CmdOrCtrl+F",
    toggleSidebar: "CmdOrCtrl+B",
    toggleTerminal: "CmdOrCtrl+J",
    openBrowserTab: "CmdOrCtrl+T",
    toggleBrowserPanel: "CmdOrCtrl+Shift+B",
    toggleDiffPanel: "CmdOrCtrl+Shift+D",
    navigateBack: "CmdOrCtrl+[",
    navigateForward: "CmdOrCtrl+]",
    thread1: "CmdOrCtrl+1",
    thread2: "CmdOrCtrl+2",
    thread3: "CmdOrCtrl+3",
    thread4: "CmdOrCtrl+4",
    thread5: "CmdOrCtrl+5",
    thread6: "CmdOrCtrl+6",
    thread7: "CmdOrCtrl+7",
    thread8: "CmdOrCtrl+8",
    thread9: "CmdOrCtrl+9",
  };
  const keybindGroups = [
    {
      title: "Core",
      actions: [
        { id: "newThread", label: "New chat", description: "Start a new chat." },
        { id: "quickChat", label: "Quick chat", description: "Open a quick chat window." },
        { id: "newThreadAlt", label: "New chat alternate", description: "Alternate shortcut for a new chat." },
        { id: "openFolder", label: "Open folder", description: "Open a workspace folder." },
        { id: "settings", label: "Settings", description: "Open settings." },
        { id: "openCommandMenu", label: "Command menu", description: "Open the command menu." },
        { id: "openCommandMenuAlt", label: "Command menu alternate", description: "Alternate shortcut for the command menu." },
        { id: "searchChats", label: "Search chats", description: "Search existing chats." },
        { id: "searchFiles", label: "Search files", description: "Search files in the current workspace." },
      ],
    },
    {
      title: "Thread",
      actions: [
        { id: "findInThread", label: "Find in thread", description: "Search inside the current thread." },
        { id: "copyConversationPath", label: "Copy conversation path", description: "Copy the current conversation path." },
        { id: "toggleThreadPin", label: "Toggle thread pin", description: "Pin or unpin the current thread." },
        { id: "renameThread", label: "Rename thread", description: "Rename the current thread." },
        { id: "archiveThread", label: "Archive thread", description: "Archive the current thread." },
        { id: "copyWorkingDirectory", label: "Copy working directory", description: "Copy the current working directory." },
        { id: "copySessionId", label: "Copy session ID", description: "Copy the current session ID." },
        { id: "copyDeeplink", label: "Copy deeplink", description: "Copy a deeplink for the current thread." },
        { id: "previousThread", label: "Previous thread", description: "Move to the previous thread." },
        { id: "nextThread", label: "Next thread", description: "Move to the next thread." },
        { id: "thread1", label: "Thread 1", description: "Jump to thread slot 1." },
        { id: "thread2", label: "Thread 2", description: "Jump to thread slot 2." },
        { id: "thread3", label: "Thread 3", description: "Jump to thread slot 3." },
        { id: "thread4", label: "Thread 4", description: "Jump to thread slot 4." },
        { id: "thread5", label: "Thread 5", description: "Jump to thread slot 5." },
        { id: "thread6", label: "Thread 6", description: "Jump to thread slot 6." },
        { id: "thread7", label: "Thread 7", description: "Jump to thread slot 7." },
        { id: "thread8", label: "Thread 8", description: "Jump to thread slot 8." },
        { id: "thread9", label: "Thread 9", description: "Jump to thread slot 9." },
      ],
    },
    {
      title: "Panels",
      actions: [
        { id: "toggleSidebar", label: "Toggle sidebar", description: "Show or hide the sidebar." },
        { id: "toggleTerminal", label: "Toggle terminal", description: "Show or hide the terminal." },
        { id: "toggleFileTreePanel", label: "Toggle file tree", description: "Show or hide the file tree." },
        { id: "openBrowserTab", label: "Open browser tab", description: "Open a browser tab." },
        { id: "reloadBrowserPage", label: "Reload browser page", description: "Reload the active browser page." },
        { id: "hardReloadBrowserPage", label: "Hard reload browser page", description: "Hard reload the active browser page." },
        { id: "navigateBack", label: "Navigate back", description: "Go back in app navigation." },
        { id: "navigateForward", label: "Navigate forward", description: "Go forward in app navigation." },
        { id: "toggleBrowserPanel", label: "Toggle browser panel", description: "Show or hide the browser panel." },
        { id: "toggleDiffPanel", label: "Toggle review panel", description: "Show or hide the review panel." },
      ],
    },
    {
      title: "System",
      actions: [
        { id: "dictation", label: "Dictation", description: "Start dictation." },
      ],
    },
  ];

  return `import{s as __toESM}from"./${chunkAsset}";${reactImport}import{${vscodeApiExportName} as __post}from"./${vscodeApiAsset}";import{i as HotkeyWindowHotkeyRow}from"./${hotkeySettingsAsset}";import{${settingsRowExportName} as SettingsRow}from"./${settingsRowAsset}";import{${settingsSectionExportName} as SettingsSection}from"./${settingsSectionAsset}";import{${settingsGroupExportName} as SettingsGroup}from"./${settingsGroupAsset}";import{${settingsPageExportName} as SettingsPage}from"./${settingsPageAsset}";import{${toggleExportName} as Toggle}from"./${toggleAsset}";var React=__toESM(__reactFactory(),1),$=__jsxFactory(),KEYS={promptWindow:${JSON.stringify(linuxSettingsKeys.promptWindow)},systemTray:${JSON.stringify(linuxSettingsKeys.systemTray)},warmStart:${JSON.stringify(linuxSettingsKeys.warmStart)},autoUpdateOnExit:${JSON.stringify(linuxSettingsKeys.autoUpdateOnExit)}},KEYBIND_OVERRIDES_KEY=${JSON.stringify(linuxKeybindOverridesKey)},DEFAULT_SHORTCUTS=${JSON.stringify(defaultShortcuts)},KEYBIND_GROUPS=${JSON.stringify(keybindGroups)};function normalizeOverrides(value){if(!value||typeof value!="object"||Array.isArray(value))return{};return Object.fromEntries(Object.entries(value).filter(([key,accelerator])=>typeof key=="string"&&typeof accelerator=="string"&&accelerator.trim().length>0).map(([key,accelerator])=>[key,accelerator.trim()]))}function readLocalOverrides(){try{return normalizeOverrides(JSON.parse(localStorage.getItem(KEYBIND_OVERRIDES_KEY)||"{}"))}catch{return{}}}function writeLocalOverrides(next){try{localStorage.setItem(KEYBIND_OVERRIDES_KEY,JSON.stringify(next)),window.dispatchEvent(new CustomEvent("codex-linux-keybind-overrides-changed",{detail:next}))}catch{}}function useKeybindOverrides(){let[overrides,setOverrides]=React.useState(()=>readLocalOverrides()),[error,setError]=React.useState(null);React.useEffect(()=>{let alive=!0;__post("get-global-state",{params:{key:KEYBIND_OVERRIDES_KEY}}).then(result=>{if(!alive)return;let next=normalizeOverrides(result?.value);Object.keys(next).length>0?(setOverrides(next),writeLocalOverrides(next)):setOverrides(readLocalOverrides());setError(null)}).catch(err=>{alive&&setError(err instanceof Error?err.message:String(err))});return()=>{alive=!1}},[]);let update=React.useCallback((actionId,accelerator)=>{setOverrides(previous=>{let next={...previous},defaultValue=typeof DEFAULT_SHORTCUTS[actionId]=="string"?DEFAULT_SHORTCUTS[actionId]:"",trimmed=String(accelerator??"").trim();trimmed.length===0||trimmed===defaultValue?delete next[actionId]:next[actionId]=trimmed;writeLocalOverrides(next);__post("set-global-state",{params:{key:KEYBIND_OVERRIDES_KEY,value:next}}).then(()=>setError(null)).catch(err=>setError(err instanceof Error?err.message:String(err)));return next})},[]);return{overrides,error,update}}function useLinuxSetting(key,defaultValue){let[value,setValue]=React.useState(defaultValue),[isLoading,setIsLoading]=React.useState(!0),[error,setError]=React.useState(null);React.useEffect(()=>{let alive=!0;setIsLoading(!0);__post("get-global-state",{params:{key}}).then(result=>{alive&&(setValue(result?.value??defaultValue),setError(null))}).catch(err=>{alive&&setError(err instanceof Error?err.message:String(err))}).finally(()=>{alive&&setIsLoading(!1)});return()=>{alive=!1}},[key,defaultValue]);let update=React.useCallback(next=>{let previous=value;setValue(next);setError(null);__post("set-global-state",{params:{key,value:next}}).catch(err=>{setValue(previous);setError(err instanceof Error?err.message:String(err))})},[key,value]);return{value,isLoading,error,update}}function LinuxToggle({settingKey,label,description,defaultValue=!0}){let{value,isLoading,error,update}=useLinuxSetting(settingKey,defaultValue),details=error?$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("span",{children:description}),$.jsx("span",{className:"text-token-error-foreground",children:error})]}):description;return $.jsx(SettingsRow,{label,description:details,control:$.jsx(Toggle,{checked:value,disabled:isLoading,onChange:update,ariaLabel:label})})}${linuxBuildInfoPanelSource()}function normalizeCapturedKey(key){let map={" ":"Space",ArrowUp:"Up",ArrowDown:"Down",ArrowLeft:"Left",ArrowRight:"Right",Escape:"Esc",",":",",".":".","/":"/","\\\\":"\\\\","[":"[","]":"]",";":";","'":"'","-":"-","=":"=","+":"Plus"};if(map[key])return map[key];if(/^.$/.test(key))return key.toUpperCase();return key}function formatAcceleratorForInput(event){if(!(event.ctrlKey||event.altKey||event.metaKey))return null;if(["Control","Shift","Alt","Meta"].includes(event.key))return null;let parts=[];event.ctrlKey&&parts.push("Ctrl");event.altKey&&parts.push("Alt");event.shiftKey&&parts.push("Shift");event.metaKey&&parts.push("Command");let key=normalizeCapturedKey(event.key);return key?[...parts,key].join("+"):null}function ShortcutInput({value,defaultValue,changed,onChange}){let[draft,setDraft]=React.useState(value);React.useEffect(()=>setDraft(value),[value]);let commit=next=>onChange(String(next??"").trim());return $.jsxs("div",{className:"flex min-w-[260px] items-center justify-end gap-2",children:[$.jsx("input",{className:"h-8 w-[190px] rounded-md border border-token-border-default bg-token-bg-primary px-2 text-sm text-token-text-primary outline-none focus:border-token-border-strong","data-codex-keybind-input":!0,value:draft,placeholder:defaultValue,onChange:event=>{setDraft(event.target.value),onChange(event.target.value)},onBlur:()=>commit(draft),onKeyDown:event=>{if(event.key==="Escape"){setDraft(value);return}if(event.key==="Enter"){event.preventDefault(),commit(draft);return}let captured=formatAcceleratorForInput(event);captured&&(event.preventDefault(),setDraft(captured),onChange(captured))}}),$.jsx("button",{type:"button",className:"h-8 rounded-md border border-token-border-default px-2 text-xs text-token-text-secondary disabled:opacity-40",disabled:!changed,onClick:()=>onChange(""),children:"Reset"})]})}function KeybindRow({action,overrides,update}){let defaultValue=typeof DEFAULT_SHORTCUTS[action.id]=="string"?DEFAULT_SHORTCUTS[action.id]:action.defaultAccelerator??"",hasOverride=Object.prototype.hasOwnProperty.call(overrides,action.id),value=hasOverride?overrides[action.id]:defaultValue,changed=hasOverride&&value!==defaultValue,description=$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("span",{children:action.description}),$.jsxs("span",{className:"text-token-text-tertiary",children:["Default: ",defaultValue||"Unassigned"]})]});return $.jsx(SettingsRow,{label:action.label,description,control:$.jsx(ShortcutInput,{value,defaultValue,changed,onChange:next=>update(action.id,next)})})}function KeybindGroup({group,overrides,update}){return $.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:group.title}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:group.actions.map(action=>$.jsx(KeybindRow,{action,overrides,update},action.id))})})]},group.title)}function KeybindsSettings(){let{overrides,error,update}=useKeybindOverrides();return $.jsx(SettingsPage,{title:"Keybinds",subtitle:"App shortcuts and Linux desktop behavior.",children:$.jsxs("div",{className:"flex flex-col gap-6",children:[$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"App shortcuts"}),error?$.jsx("div",{className:"px-1 text-sm text-token-error-foreground",children:error}):null]}),...KEYBIND_GROUPS.map(group=>$.jsx(KeybindGroup,{group,overrides,update},group.title)),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Global shortcuts"}),$.jsx(SettingsSection.Content,{children:$.jsxs(SettingsGroup,{children:[$.jsx(HotkeyWindowHotkeyRow,{}),$.jsx(LinuxToggle,{settingKey:KEYS.promptWindow,label:"Compact prompt window",description:"Allow --prompt-chat and --hotkey-window to open the compact prompt window and keep it prewarmed."})]})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Linux desktop"}),$.jsx(SettingsSection.Content,{children:$.jsxs(SettingsGroup,{children:[$.jsx(LinuxToggle,{settingKey:KEYS.systemTray,label:"System tray",description:"Show the ChatGPT system tray icon and keep the app available from the tray."}),$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:"Warm start",description:"Use the running app for launch actions instead of starting a fresh Electron instance."}),$.jsx(LinuxBuildInfoPanel,{})]})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Updates"}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close ChatGPT",description:"When on, a ready update waits for ChatGPT to close and then installs. When off, updates wait until you click Update."})})})]})]})})}export{KeybindsSettings,KeybindsSettings as default};\n//# sourceMappingURL=${keybindsSettingsAsset}.map\n`;
}

function buildLinuxDesktopSettingsSource({
  runtimeBridgeAsset,
  vscodeApiAsset,
  vscodeApiExportName = "n",
  settingsRowAsset,
  settingsRowExportName = "n",
  settingsPageAsset,
  settingsPageExportName = "t",
  settingsSectionAsset,
  settingsSectionExportName = "r",
  settingsGroupAsset,
  settingsGroupExportName = "n",
  toggleAsset,
  toggleExportName = "t",
}) {
  return `import{${linuxReactRuntimeExport} as React,${linuxJsxRuntimeExport} as $}from"./${runtimeBridgeAsset}";import{${vscodeApiExportName} as __post}from"./${vscodeApiAsset}";import{${settingsRowExportName} as SettingsRow}from"./${settingsRowAsset}";import{${settingsSectionExportName} as SettingsSection}from"./${settingsSectionAsset}";import{${settingsGroupExportName} as SettingsGroup}from"./${settingsGroupAsset}";import{${settingsPageExportName} as SettingsPage}from"./${settingsPageAsset}";import{${toggleExportName} as Toggle}from"./${toggleAsset}";var KEYS={promptWindow:${JSON.stringify(linuxSettingsKeys.promptWindow)},systemTray:${JSON.stringify(linuxSettingsKeys.systemTray)},warmStart:${JSON.stringify(linuxSettingsKeys.warmStart)},autoUpdateOnExit:${JSON.stringify(linuxSettingsKeys.autoUpdateOnExit)}};${linuxDesktopSettingsControlsSource()}${linuxBuildInfoPanelSource()}function LinuxDesktopSettings(){return $.jsx(SettingsPage,{title:"Linux desktop",subtitle:"Launcher, tray, prompt window, and update behavior.",children:$.jsxs("div",{className:"flex flex-col gap-6",children:[$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Global shortcuts"}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.promptWindow,label:"Compact prompt window",description:"Allow --prompt-chat and --hotkey-window to open the compact prompt window and keep it prewarmed."})})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Desktop integration"}),$.jsx(SettingsSection.Content,{children:$.jsxs(SettingsGroup,{children:[$.jsx(LinuxToggle,{settingKey:KEYS.systemTray,label:"System tray",description:"Show the ChatGPT system tray icon and keep the app available from the tray."}),$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:"Warm start",description:"Use the running app for launch actions instead of starting a fresh Electron instance."})]})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Updates"}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close ChatGPT",description:"When on, a ready update waits for ChatGPT to close and then installs. When off, updates wait until you click Update."})})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Build"}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxBuildInfoPanel,{})})})]})]})})}export{LinuxDesktopSettings,LinuxDesktopSettings as default};\n//# sourceMappingURL=${linuxDesktopSettingsAsset}.map\n`;
}

function inferSettingsRowExportName(source) {
  const functionPattern = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  let localName = null;
  let match;
  while ((match = functionPattern.exec(source)) != null) {
    const nextFunctionIndex = source.indexOf("function ", functionPattern.lastIndex);
    const functionSource = source.slice(
      match.index,
      nextFunctionIndex === -1 ? source.length : nextFunctionIndex,
    );
    if (
      functionSource.includes("label:") &&
      functionSource.includes("description:") &&
      functionSource.includes("control:")
    ) {
      localName = match[1];
      break;
    }
  }

  if (localName == null) {
    return null;
  }

  const exportMatch = source.match(/export\{([^}]*)\}/);
  if (exportMatch == null) {
    return null;
  }

  for (const rawExport of exportMatch[1].split(",")) {
    const exportPart = rawExport.trim();
    const aliasedMatch = exportPart.match(new RegExp(`^${localName}\\s+as\\s+([A-Za-z_$][\\w$]*)$`));
    if (aliasedMatch != null) {
      return aliasedMatch[1];
    }
    if (exportPart === localName) {
      return localName;
    }
  }

  return null;
}

function importBindings(source) {
  const bindings = new Map();
  const importPattern = /import\{([^}]*)\}from"\.\/([^"]+)"/g;
  let match;
  while ((match = importPattern.exec(source)) != null) {
    const [, specifiers, assetName] = match;
    for (const rawSpecifier of specifiers.split(",")) {
      const specifier = rawSpecifier.trim();
      if (specifier.length === 0) {
        continue;
      }
      const aliased = specifier.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliased != null) {
        bindings.set(aliased[2], { assetName, exportName: aliased[1] });
      } else {
        bindings.set(specifier, { assetName, exportName: specifier });
      }
    }
  }
  return bindings;
}

function inferRuntimeDependenciesFromSettingsSource(source) {
  const routeFactoryLocal = source.match(
    /["'](?:linux-desktop|general-settings)["']:\s*([A-Za-z_$][\w$]*)\(async\(\)=>/,
  )?.[1] ?? null;
  if (routeFactoryLocal == null) {
    return null;
  }

  const functionMarker = `function ${routeFactoryLocal}(`;
  const functionStart = source.indexOf(functionMarker);
  const bodyStart = functionStart === -1
    ? -1
    : source.indexOf("{", functionStart + functionMarker.length);
  const bodyEnd = bodyStart === -1 ? -1 : findMatchingBrace(source, bodyStart);
  if (bodyStart === -1 || bodyEnd === -1) {
    return null;
  }

  const routeFactorySource = source.slice(bodyStart + 1, bodyEnd);
  const lazyReactLocal = routeFactorySource.match(
    /\(0,([A-Za-z_$][\w$]*)\.lazy\)/,
  )?.[1] ?? null;
  const stateReactLocal = routeFactorySource.match(
    /\(0,([A-Za-z_$][\w$]*)\.useState\)/,
  )?.[1] ?? null;
  const jsxLocal = routeFactorySource.match(
    /\(0,([A-Za-z_$][\w$]*)\.jsx(?:s)?\)/,
  )?.[1] ?? null;
  if (
    lazyReactLocal == null
    || stateReactLocal == null
    || lazyReactLocal !== stateReactLocal
    || jsxLocal == null
  ) {
    return null;
  }

  const reactLocal = lazyReactLocal;
  const jsxFactoryMatch = new RegExp(
    `${escapeRegExp(jsxLocal)}=([A-Za-z_$][\\w$]*)\\(\\)`,
  ).exec(source);
  const reactFactoryMatch = new RegExp(
    `${escapeRegExp(reactLocal)}=[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*)\\(\\),1\\)`,
  ).exec(source);
  const jsxFactoryLocal = jsxFactoryMatch?.[1] ?? null;
  const reactFactoryLocal = reactFactoryMatch?.[1] ?? null;
  if (jsxFactoryLocal == null || reactFactoryLocal == null) {
    return null;
  }

  const initializationStart = source.lastIndexOf(";", reactFactoryMatch.index) + 1;
  const initializationEnd = source.indexOf(";", reactFactoryMatch.index);
  if (
    initializationEnd === -1
    || jsxFactoryMatch.index < initializationStart
    || jsxFactoryMatch.index > initializationEnd
  ) {
    return null;
  }

  const bindings = importBindings(source);
  const jsxBinding = bindings.get(jsxFactoryLocal);
  const reactBinding = bindings.get(reactFactoryLocal);
  if (jsxBinding == null || reactBinding == null) {
    return null;
  }

  return {
    jsxRuntimeLocalName: jsxLocal,
    reactRuntimeLocalName: reactLocal,
  };
}

function addLinuxSettingsRuntimeBridgeExports(source, runtimeDependencies) {
  if (
    source.includes(` as ${linuxReactRuntimeExport}`)
    && source.includes(` as ${linuxJsxRuntimeExport}`)
  ) {
    return source;
  }

  const exportPattern = /export\{([^}]*)\}/;
  const bridgeExports = [
    `${runtimeDependencies.reactRuntimeLocalName} as ${linuxReactRuntimeExport}`,
    `${runtimeDependencies.jsxRuntimeLocalName} as ${linuxJsxRuntimeExport}`,
  ].join(",");
  if (!exportPattern.test(source)) {
    return `${source}export{${bridgeExports}};`;
  }

  return source.replace(exportPattern, (_match, exports) => `export{${exports},${bridgeExports}}`);
}

function findNativeKeyboardShortcutsSettingsAsset(webviewAssetsDir) {
  return fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => /^keyboard-shortcuts-settings-.*\.js$/.test(name))
    .sort()[0] ?? null;
}

function findSettingsRouteRuntimeAsset(webviewAssetsDir) {
  // The lazy-route wrapper renders every settings page with this module's
  // React instance. A different initialized chunk can still have a null hook
  // dispatcher when React calls into it, so bridge the runtime from here.
  const routeMatches = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .filter((name) => {
      const source = fs.readFileSync(path.join(webviewAssetsDir, name), "utf8");
      return isSettingsRouteBundleSource(source);
    });
  if (routeMatches.length === 0) {
    throw new Error("Required Keybinds settings patch failed: could not find Linux desktop settings route bundle");
  }
  const matches = routeMatches.filter((name) => {
    const source = fs.readFileSync(path.join(webviewAssetsDir, name), "utf8");
    return inferRuntimeDependenciesFromSettingsSource(source) != null;
  });

  if (matches.length !== 1) {
    throw new Error(
      `Required Keybinds settings patch failed: could not infer the active React runtime from exactly one settings route asset (found ${matches.length})`,
    );
  }
  return matches[0];
}

function tryFindRequiredWebviewAsset(webviewAssetsDir, namePattern, requiredContent, description) {
  try {
    return findRequiredWebviewAsset(webviewAssetsDir, namePattern, requiredContent, description);
  } catch {
    return null;
  }
}

function linuxSettingsFallbackComponents({ runtimeBridgeAsset }) {
  const jsxImport = `import{${linuxJsxRuntimeExport} as $}from"./${runtimeBridgeAsset}";`;

  return {
    settingsRow: {
      assetName: "linux-settings-row-linux.js",
      exportName: "n",
      source: `${jsxImport}function n({label,description,control}){return $.jsxs("div",{className:"flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",children:[$.jsxs("div",{className:"min-w-0 flex-1",children:[$.jsx("div",{className:"text-sm font-medium text-token-text-primary",children:label}),$.jsx("div",{className:"mt-1 text-sm text-token-text-secondary",children:description})]}),$.jsx("div",{className:"shrink-0",children:control})]})}export{n};\n`,
    },
    settingsSection: {
      assetName: "linux-settings-section-linux.js",
      exportName: "n",
      source: `${jsxImport}function n({children,className}){return $.jsx("section",{className:className??"flex flex-col gap-2",children})}n.Header=function({title}){return $.jsx("h3",{className:"text-base font-medium text-token-text-primary",children:title})};n.Content=function({children}){return $.jsx("div",{className:"flex flex-col divide-y divide-token-border-light rounded-lg border border-token-border-light bg-token-main-surface-primary",children})};export{n};\n`,
    },
    settingsGroup: {
      assetName: "linux-settings-group-linux.js",
      exportName: "n",
      source: `${jsxImport}function n({children}){return $.jsx("div",{className:"flex flex-col divide-y divide-token-border-light",children})}export{n};\n`,
    },
    settingsPage: {
      assetName: "linux-settings-page-linux.js",
      exportName: "t",
      source: `${jsxImport}function t({title,subtitle,children}){return $.jsx("div",{className:"h-full min-h-0 w-full overflow-y-auto",children:$.jsxs("div",{className:"mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6",children:[$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("h2",{className:"text-xl font-semibold text-token-text-primary",children:title}),subtitle?$.jsx("p",{className:"text-sm text-token-text-secondary",children:subtitle}):null]}),children]})})}export{t};\n`,
    },
    settingsToggle: {
      assetName: "linux-settings-toggle-linux.js",
      exportName: "t",
      source: `${jsxImport}function t({checked,disabled,onChange,ariaLabel}){let active=!!checked;return $.jsx("button",{type:"button",role:"switch","aria-checked":active,"aria-label":ariaLabel,disabled,"data-state":active?"checked":"unchecked",onClick:()=>{disabled||onChange(!active)},style:{boxSizing:"border-box",width:"32px",height:"20px",borderRadius:"9999px",border:"1px solid var(--color-token-border-default)",background:active?"var(--color-token-radio-active-foreground)":"var(--color-token-bg-secondary)",padding:"2px",display:"inline-flex",alignItems:"center",justifyContent:"flex-start",opacity:disabled?0.5:1,transition:"background-color 150ms ease,border-color 150ms ease"},children:$.jsx("span",{style:{display:"block",width:"14px",height:"14px",borderRadius:"9999px",background:active?"var(--color-token-bg-primary)":"var(--color-token-text-tertiary)",transform:active?"translateX(12px)":"translateX(0)",transition:"transform 150ms ease,background-color 150ms ease"}})})}export{t};\n`,
    },
  };
}

function resolveSettingsAssetDependencies(extractedDir, { includeHotkeySettings = true } = {}) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Required Keybinds settings patch failed: missing webview assets directory ${webviewAssetsDir}`);
  }

  const runtimeBridgeAsset = findSettingsRouteRuntimeAsset(webviewAssetsDir);
  const runtimeBridgeSource = fs.readFileSync(
    path.join(webviewAssetsDir, runtimeBridgeAsset),
    "utf8",
  );
  const runtimeDependencies = inferRuntimeDependenciesFromSettingsSource(runtimeBridgeSource);

  if (runtimeDependencies == null) {
    throw new Error(
      "Required Keybinds settings patch failed: could not infer the active React runtime from the current upstream settings route asset",
    );
  }

  const { assetName: vscodeApiAsset, exportName: vscodeApiExportName } =
    findCodexRequestWebviewAsset(webviewAssetsDir);
  const hotkeySettingsAsset = includeHotkeySettings
    ? findRequiredWebviewAsset(
        webviewAssetsDir,
        /^general-settings-.*\.js$/,
        "hotkey-window-hotkey-state",
        "hotkey settings asset",
      )
    : null;
  const fallbackComponents = linuxSettingsFallbackComponents({
    runtimeBridgeAsset,
  });
  const generatedAssets = [];
  generatedAssets.push({
    filePath: path.join(webviewAssetsDir, runtimeBridgeAsset),
    source: addLinuxSettingsRuntimeBridgeExports(
      runtimeBridgeSource,
      runtimeDependencies,
    ),
  });
  const useFallbackComponent = (componentName) => {
    const component = fallbackComponents[componentName];
    generatedAssets.push({
      filePath: path.join(webviewAssetsDir, component.assetName),
      source: component.source,
    });
    return {
      ...component,
      assetSpecifier: versionedAssetSpecifier(component.assetName, component.source),
    };
  };

  let settingsRowCandidate = null;
  let settingsRowExportName = null;
  for (const candidate of fs.readdirSync(webviewAssetsDir).filter((name) => /^settings-row-.*\.js$/.test(name)).sort()) {
    const source = fs.readFileSync(path.join(webviewAssetsDir, candidate), "utf8");
    const exportName = inferSettingsRowExportName(source);
    if (exportName != null) {
      settingsRowCandidate = candidate;
      settingsRowExportName = exportName;
      break;
    }
  }
  const settingsRowFallback = settingsRowCandidate == null ? useFallbackComponent("settingsRow") : null;
  const settingsRowAsset = settingsRowCandidate ?? settingsRowFallback.assetSpecifier;
  const settingsLayoutCandidate = tryFindRequiredWebviewAsset(
    webviewAssetsDir,
    /^settings-content-layout-.*\.js$/,
    null,
    "settings content layout asset",
  );
  const settingsLayoutFallback = settingsLayoutCandidate == null ? useFallbackComponent("settingsPage") : null;
  const settingsLayoutAsset = settingsLayoutCandidate ?? settingsLayoutFallback.assetSpecifier;
  const settingsGroupCandidate = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => /^settings-group-.*\.js$/.test(name))
    .sort()[0] ?? null;
  const settingsSurfaceCandidate = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => /^settings-surface-.*\.js$/.test(name))
    .sort()[0] ?? null;
  const settingsSectionFallback = settingsGroupCandidate == null ? useFallbackComponent("settingsSection") : null;
  const settingsGroupFallback = settingsSurfaceCandidate == null ? useFallbackComponent("settingsGroup") : null;
  // Upstream settings controls are often exported from lazy Rolldown modules
  // whose private initializer is only invoked by their original consumer.
  // Importing those controls directly can therefore succeed while rendering
  // crashes inside an uninitialized React compiler runtime. Keep this small
  // control self-contained instead of depending on upstream module internals.
  const toggleDependency = useFallbackComponent("settingsToggle");

  return {
    runtimeBridgeAsset,
    vscodeApiAsset,
    vscodeApiExportName,
    hotkeySettingsAsset,
    settingsRowAsset,
    settingsRowExportName: settingsRowExportName ?? settingsRowFallback.exportName,
    settingsPageAsset: settingsLayoutAsset,
    settingsPageExportName: settingsLayoutFallback == null ? "t" : settingsLayoutFallback.exportName,
    settingsSectionAsset: settingsGroupCandidate ?? settingsSectionFallback.assetSpecifier,
    settingsSectionExportName: settingsGroupCandidate == null ? settingsSectionFallback.exportName : "t",
    settingsGroupAsset: settingsSurfaceCandidate ?? settingsGroupFallback.assetSpecifier,
    settingsGroupExportName: settingsSurfaceCandidate == null ? settingsGroupFallback.exportName : "t",
    toggleAsset: toggleDependency.assetSpecifier,
    toggleExportName: toggleDependency.exportName,
    generatedAssets,
  };
}

function resolveLinuxDesktopSettingsAsset(extractedDir) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  const dependencies = resolveSettingsAssetDependencies(extractedDir, {
    includeHotkeySettings: false,
  });

  const source = buildLinuxDesktopSettingsSource(dependencies);
  return {
    filePath: path.join(webviewAssetsDir, linuxDesktopSettingsAsset),
    source,
    routeAssetSpecifier: versionedAssetSpecifier(linuxDesktopSettingsAsset, source),
    generatedAssets: dependencies.generatedAssets,
  };
}

function collectRequiredAssetPatches(extractedDir, filenamePattern, patchFn, description) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Required Keybinds settings patch failed: missing webview assets directory ${webviewAssetsDir}`);
  }

  const candidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => filenamePattern.test(name))
    .sort();
  if (candidates.length === 0) {
    throw new Error(`Required Keybinds settings patch failed: could not find ${description}`);
  }

  return candidates.map((candidate) => {
    const filePath = path.join(webviewAssetsDir, candidate);
    const currentSource = fs.readFileSync(filePath, "utf8");
    return {
      filePath,
      currentSource,
      patchedSource: patchFn(currentSource),
    };
  });
}

function collectOptionalAssetPatches(extractedDir, filenamePattern, patchFn) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    return [];
  }

  const candidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => filenamePattern.test(name))
    .sort();

  const patches = [];
  for (const candidate of candidates) {
    const filePath = path.join(webviewAssetsDir, candidate);
    const currentSource = fs.readFileSync(filePath, "utf8");
    try {
      patches.push({
        filePath,
        currentSource,
        patchedSource: patchFn(currentSource),
        patchFn,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`WARN: Optional Keybinds settings patch skipped for ${candidate}: ${message}`);
    }
  }

  return patches;
}

function collectOptionalMatchingAssetPatches(extractedDir, predicate, patchFn) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    return [];
  }

  const candidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => name.endsWith(".js"))
    .sort();

  const patches = [];
  for (const candidate of candidates) {
    const filePath = path.join(webviewAssetsDir, candidate);
    const currentSource = fs.readFileSync(filePath, "utf8");
    if (!predicate(currentSource)) {
      continue;
    }
    try {
      patches.push({
        filePath,
        currentSource,
        patchedSource: patchFn(currentSource),
        patchFn,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`WARN: Optional Keybinds settings patch skipped for ${candidate}: ${message}`);
    }
  }

  return patches;
}
function collectLinuxDesktopRouteAndNavigationPatches(
  extractedDir,
  routeAssetSpecifier = linuxDesktopSettingsAsset,
) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Required Keybinds settings patch failed: missing webview assets directory ${webviewAssetsDir}`);
  }

  // Newer builds split the lazy settings route map out of `app-main-*.js`/`index-*.js`
  // into hashed concatenation chunks. Some keep the `app-initial~app-main~*`
  // prefix; others are settings-page chunks without that prefix. The
  // icon/navigation metadata still lives in a settings-page chunk, so scan any
  // hashed settings-page JS file plus the legacy app-main/index candidates.
  const candidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => /^(?:(?:app-main|index)-|app-initial~app-main~).*\.js$/.test(name) || /(?:^|~)settings-page(?:[-~].*)?\.js$/.test(name))
    .sort();

  let routeMatched = false;
  let navigationMatched = false;
  const patches = [];
  for (const candidate of candidates) {
    const filePath = path.join(webviewAssetsDir, candidate);
    const currentSource = fs.readFileSync(filePath, "utf8");
    let patchedSource = currentSource;
    if (isSettingsRouteBundleSource(currentSource)) {
      routeMatched = true;
      patchedSource = applyLinuxDesktopSettingsRoutePatch(patchedSource, routeAssetSpecifier);
    }
    if (isSettingsNavigationBundleSource(currentSource)) {
      navigationMatched = true;
      patchedSource = applyLinuxDesktopSettingsNavigationPatch(patchedSource);
    }
    if (patchedSource !== currentSource) {
      patches.push({
        filePath,
        currentSource,
        patchedSource,
        patchFn(source) {
          let nextSource = source;
          if (isSettingsRouteBundleSource(nextSource)) {
            nextSource = applyLinuxDesktopSettingsRoutePatch(nextSource, routeAssetSpecifier);
          }
          if (isSettingsNavigationBundleSource(nextSource)) {
            nextSource = applyLinuxDesktopSettingsNavigationPatch(nextSource);
          }
          return nextSource;
        },
      });
    }
  }

  if (!routeMatched) {
    throw new Error("Required Keybinds settings patch failed: could not find Linux desktop settings route bundle");
  }
  if (!navigationMatched) {
    throw new Error("Required Keybinds settings patch failed: could not find Linux desktop settings navigation bundle");
  }

  return patches;
}

function hasNativeKeyboardShortcutsSettings(extractedDir) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    return false;
  }

  const assets = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => name.endsWith(".js"))
    .sort();
  const hasKeyboardShortcutsAsset = assets.some((name) =>
    /^keyboard-shortcuts-settings-.*\.js$/.test(name),
  );
  if (!hasKeyboardShortcutsAsset) {
    return false;
  }

  const hasSettingsRoute = assets.some((name) => {
    const source = fs.readFileSync(path.join(webviewAssetsDir, name), "utf8");
    return (
      source.includes("slug:`keyboard-shortcuts`") ||
      source.includes("settings.nav.keyboard-shortcuts") ||
      /["']keyboard-shortcuts["']:\(0,[A-Za-z_$][\w$]*\.lazy\)/.test(source)
    );
  });
  if (!hasSettingsRoute) {
    return false;
  }

  return true;
}

function applyCollectedAssetPatchWrites(patches) {
  const firstSourcesByPath = new Map();
  const latestSourcesByPath = new Map();
  let changed = 0;

  for (const patch of patches) {
    if (!firstSourcesByPath.has(patch.filePath)) {
      firstSourcesByPath.set(patch.filePath, patch.currentSource);
    }
    const currentSource = latestSourcesByPath.get(patch.filePath) ?? patch.currentSource;
    const patchedSource = currentSource === patch.currentSource || typeof patch.patchFn !== "function"
      ? patch.patchedSource
      : patch.patchFn(currentSource);
    if (patchedSource !== currentSource) {
      changed += 1;
    }
    latestSourcesByPath.set(patch.filePath, patchedSource);
  }

  for (const [filePath, patchedSource] of latestSourcesByPath) {
    if (patchedSource !== firstSourcesByPath.get(filePath)) {
      fs.writeFileSync(filePath, patchedSource, "utf8");
    }
  }

  return changed;
}

function patchKeybindsSettingsAssets(extractedDir) {
  try {
    if (!hasNativeKeyboardShortcutsSettings(extractedDir)) {
      throw new Error("Required Keybinds settings patch failed: current upstream Keyboard Shortcuts settings route is missing");
    }

    const settingsAsset = resolveLinuxDesktopSettingsAsset(extractedDir);
    const settingsAssetExists = fs.existsSync(settingsAsset.filePath);
    const previousSettingsSource = settingsAssetExists
      ? fs.readFileSync(settingsAsset.filePath, "utf8")
      : null;
    // Treat generated updates as patches so a route bundle can receive both
    // the runtime exports and the Linux route insertion without one write
    // overwriting the other.
    const generatedPatches = (settingsAsset.generatedAssets ?? []).map((generatedAsset) => {
      const exists = fs.existsSync(generatedAsset.filePath);
      const currentSource = exists ? fs.readFileSync(generatedAsset.filePath, "utf8") : "";
      return {
        filePath: generatedAsset.filePath,
        currentSource,
        patchedSource: generatedAsset.source,
      };
    });
    const patches = [
      ...generatedPatches,
      ...collectOptionalMatchingAssetPatches(
        extractedDir,
        isSettingsSectionsMetadataBundleSource,
        applyLinuxDesktopSettingsSectionsPatch,
      ),
      ...collectOptionalMatchingAssetPatches(
        extractedDir,
        isSettingsSharedMetadataBundleSource,
        applyLinuxDesktopSettingsSharedPatch,
      ),
      ...collectOptionalMatchingAssetPatches(
        extractedDir,
        isLinuxShortcutPhysicalKeyFallbackBundleSource,
        applyLinuxShortcutPhysicalKeyFallbackPatch,
      ),
      ...collectLinuxDesktopRouteAndNavigationPatches(
        extractedDir,
        settingsAsset.routeAssetSpecifier,
      ),
    ];

    fs.writeFileSync(settingsAsset.filePath, settingsAsset.source, "utf8");
    let changed = previousSettingsSource !== settingsAsset.source ? 1 : 0;
    changed += applyCollectedAssetPatchWrites(patches);
    return {
      matched: true,
      changed,
      reason: "upstream keyboard shortcuts settings are present; added Linux desktop settings and shortcut layout fallback",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`WARN: Keybinds settings patch skipped: ${message}`);
    return { matched: false, changed: 0, reason: message };
  }
}

function applyKeybindsSettingsSectionsPatch(currentSource) {
  let patchedSource = currentSource;

  if (patchedSource.includes("slug:`keybinds`")) {
    return patchedSource;
  }

  const sectionsNeedle = "var e=`general-settings`,t=`mcp-settings`,n=[{slug:e},";
  const sectionsPatch = "var e=`general-settings`,t=`mcp-settings`,n=[{slug:e},{slug:`keybinds`},";
  if (patchedSource.includes(sectionsNeedle)) {
    return patchedSource.replace(sectionsNeedle, sectionsPatch);
  }

  const currentNeedle = "n=[{slug:e},{slug:`appearance`}";
  if (patchedSource.includes(currentNeedle)) {
    return patchedSource.replace(currentNeedle, "n=[{slug:e},{slug:`keybinds`},{slug:`appearance`}");
  }

  const literalNeedle = "n=[{slug:`general-settings`},{slug:`appearance`}";
  if (patchedSource.includes(literalNeedle)) {
    return patchedSource.replace(literalNeedle, "n=[{slug:`general-settings`},{slug:`keybinds`},{slug:`appearance`}");
  }

  throw new Error("Required Keybinds settings patch failed: could not add keybinds settings section");
}

function applyLinuxDesktopSettingsSectionsPatch(currentSource) {
  let patchedSource = currentSource;
  const unpatchedArrayOrderPattern = /([A-Za-z_$][\w$]*=\[`general-settings`,)(?!`linux-desktop`,)/g;
  const unpatchedSplitOrderPattern = /(`general-settings\.)(?!linux-desktop\.)([^`]*keyboard-shortcuts[^`]*`\.split\(`\.`\))/g;
  const unpatchedObjectSlugListPattern = /([A-Za-z_$][\w$]*=\[\{slug:(?:`general-settings`|[A-Za-z_$][\w$]*)\},)(?!\{slug:`linux-desktop`\},)/g;
  const hasUnpatchedEligibleSectionShape = (source) =>
    /[A-Za-z_$][\w$]*=\[`general-settings`,(?!`linux-desktop`,)/.test(source) ||
    /`general-settings\.(?!linux-desktop\.)[^`]*keyboard-shortcuts[^`]*`\.split\(`\.`\)/.test(source) ||
    /[A-Za-z_$][\w$]*=\[\{slug:(?:`general-settings`|[A-Za-z_$][\w$]*)\},(?!\{slug:`linux-desktop`\},)/.test(source);

  if (!hasUnpatchedEligibleSectionShape(patchedSource)) {
    return patchedSource;
  }

  patchedSource = patchedSource.replace(
    unpatchedArrayOrderPattern,
    "$1`linux-desktop`,",
  );
  patchedSource = patchedSource.replace(
    unpatchedSplitOrderPattern,
    "$1linux-desktop.$2",
  );
  patchedSource = patchedSource.replace(
    unpatchedObjectSlugListPattern,
    "$1{slug:`linux-desktop`},",
  );

  if (!hasUnpatchedEligibleSectionShape(patchedSource)) {
    return patchedSource;
  }

  throw new Error("Required Keybinds settings patch failed: could not add Linux desktop settings section");
}

// Inserts a new `titleForSection` switch case after the upstream
// `general-settings` case. The minifier names the JSX factory, the message
// component, and the memo-cache slot arbitrarily (e.g. `n` vs `r`, `t[2]` vs
// `o[5]`) and these drift between upstream builds, so the identifiers are
// captured from the matched block and reused in the injected case rather than
// hardcoded. Returns null when the anchor case cannot be located.
function injectSettingsSectionTitle(currentSource, { slug, defaultMessage, description }) {
  const generalCasePattern =
    /case`general-settings`:\{let ([A-Za-z_$][\w$]*);return ([A-Za-z_$][\w$]*)\[(\d+)\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\1=\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{id:`settings\.section\.general-settings`,defaultMessage:`General`,description:`Title for general settings section`\}\),\2\[\3\]=\1\):\1=\2\[\3\],\1\}/;
  const match = currentSource.match(generalCasePattern);
  if (match == null) {
    return null;
  }
  const matchedBlock = match[0];
  const jsxFactory = match[4];
  const messageComponent = match[5];
  const injectedCase =
    `case\`${slug}\`:{return (0,${jsxFactory}.jsx)(${messageComponent},`
    + `{id:\`settings.section.${slug}\`,defaultMessage:\`${defaultMessage}\`,description:\`${description}\`})}`;
  const insertAt = match.index + matchedBlock.length;
  return currentSource.slice(0, insertAt) + injectedCase + currentSource.slice(insertAt);
}

function applyKeybindsSettingsSharedPatch(currentSource) {
  let patchedSource = currentSource;

  if (!patchedSource.includes("settings.nav.keybinds")) {
    const navNeedle =
      '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},';
    const navPatch =
      '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},keybinds:{id:`settings.nav.keybinds`,defaultMessage:`Keybinds`,description:`Title for keybinds settings section`},';
    if (!patchedSource.includes(navNeedle)) {
      throw new Error("Required Keybinds settings patch failed: could not add keybinds nav label");
    }
    patchedSource = patchedSource.replace(navNeedle, navPatch);
  }

  if (!patchedSource.includes("settings.section.keybinds")) {
    const next = injectSettingsSectionTitle(patchedSource, {
      slug: "keybinds",
      defaultMessage: "Keybinds",
      description: "Title for keybinds settings section",
    });
    if (next == null) {
      throw new Error("Required Keybinds settings patch failed: could not add keybinds section title");
    }
    patchedSource = next;
  }

  return patchedSource;
}

function applyLinuxDesktopSettingsSharedPatch(currentSource) {
  let patchedSource = currentSource;

  if (!patchedSource.includes("settings.nav.linux-desktop")) {
    const navNeedle =
      '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},';
    const navPatch =
      '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},"linux-desktop":{id:`settings.nav.linux-desktop`,defaultMessage:`Linux desktop`,description:`Title for Linux desktop settings section`},';
    if (!patchedSource.includes(navNeedle)) {
      throw new Error("Required Keybinds settings patch failed: could not add Linux desktop nav label");
    }
    patchedSource = patchedSource.replace(navNeedle, navPatch);
  }

  if (!patchedSource.includes("settings.section.linux-desktop")) {
    const next = injectSettingsSectionTitle(patchedSource, {
      slug: "linux-desktop",
      defaultMessage: "Linux desktop",
      description: "Title for Linux desktop settings section",
    });
    if (next == null) {
      throw new Error("Required Keybinds settings patch failed: could not add Linux desktop section title");
    }
    patchedSource = next;
  }

  return patchedSource;
}

function applyLinuxShortcutPhysicalKeyFallbackPatch(currentSource) {
  const patchMarker = "codexLinuxShortcutPhysicalKeyFallbackEvent";
  if (currentSource.includes(patchMarker)) {
    return currentSource;
  }

  const physicalKeyResolverPattern =
    /function ([A-Za-z_$][\w$]*)\(\{altKey:([A-Za-z_$][\w$]*),code:([A-Za-z_$][\w$]*),key:([A-Za-z_$][\w$]*)\}\)\{return!\2\|\|\3==null\?\4:([^{};]+)\}/;
  const match = currentSource.match(physicalKeyResolverPattern);
  if (match == null) {
    return currentSource;
  }

  const [
    matchedSource,
    functionName,
    altKeyLocal,
    codeLocal,
    keyLocal,
    physicalFallbackExpression,
  ] = match;
  const patchedSource =
    `function ${functionName}(codexLinuxShortcutPhysicalKeyFallbackEvent){let{altKey:${altKeyLocal},code:${codeLocal},key:${keyLocal},ctrlKey:codexLinuxShortcutPhysicalKeyFallbackCtrl,metaKey:codexLinuxShortcutPhysicalKeyFallbackMeta}=codexLinuxShortcutPhysicalKeyFallbackEvent;return!(${altKeyLocal}||codexLinuxShortcutPhysicalKeyFallbackCtrl||codexLinuxShortcutPhysicalKeyFallbackMeta)||typeof codexLinuxShortcutPhysicalKeyFallbackEvent.getModifierState=="function"&&codexLinuxShortcutPhysicalKeyFallbackEvent.getModifierState("AltGraph")||${codeLocal}==null?${keyLocal}:${physicalFallbackExpression}}`;

  return currentSource.replace(matchedSource, patchedSource);
}

function isLinuxShortcutPhysicalKeyFallbackBundleSource(currentSource) {
  return currentSource.includes("altKey:")
    && currentSource.includes("code:")
    && currentSource.includes("key:")
    && currentSource.includes("Key[A-Z]")
    && currentSource.includes("Digit[0-9]")
    && /function [A-Za-z_$][\w$]*\(\{altKey:[A-Za-z_$][\w$]*,code:[A-Za-z_$][\w$]*,key:[A-Za-z_$][\w$]*\}\)\{return![A-Za-z_$][\w$]*\|\|[A-Za-z_$][\w$]*==null\?[A-Za-z_$][\w$]*:/.test(currentSource);
}

function applyLinuxKeybindOverridesRuntimePatch(currentSource) {
  const runtimePatch = `;function codexLinuxKeybindOverridesRuntime(){try{if(typeof window=="undefined")return;let storageKey=${JSON.stringify(linuxKeybindOverridesKey)},defaultMap=typeof Ct=="object"&&Ct?Ct:{},overrides={};function loadOverrides(){try{let value=JSON.parse(localStorage.getItem(storageKey)||"{}");overrides=value&&typeof value=="object"&&!Array.isArray(value)?value:{}}catch{overrides={}}}function isShortcutCaptureTarget(event){let target=event.target;return target instanceof Element&&target.closest("[data-codex-keybind-input]")!=null}function normalizeKeyName(key){let map={Space:" ",Esc:"Escape",Up:"ArrowUp",Down:"ArrowDown",Left:"ArrowLeft",Right:"ArrowRight",Plus:"+",Comma:",",Period:".",Slash:"/"};return map[key]??(/^.$/.test(key)?key.toUpperCase():key)}function keyNameFromCode(code){if(typeof code!="string")return null;if(/^Key[A-Z]$/.test(code))return code.slice(3);if(/^Digit[0-9]$/.test(code))return code.slice(5);let map={Backquote:"\`",Minus:"-",Equal:"=",BracketLeft:"[",BracketRight:"]",Backslash:"\\\\",Semicolon:";",Quote:"'",Comma:",",Period:".",Slash:"/",IntlBackslash:"\\\\"};return map[code]??null}function parseAccelerator(accelerator){if(typeof accelerator!="string"||accelerator.trim().length===0)return null;let isMac=/Mac/.test(navigator.platform||""),parts=accelerator.split("+").map(part=>part.trim()).filter(Boolean),parsed={ctrl:false,alt:false,shift:false,meta:false,key:null};for(let part of parts){switch(part){case"CmdOrCtrl":isMac?parsed.meta=true:parsed.ctrl=true;break;case"Command":case"Cmd":case"Meta":case"Super":case"Win":parsed.meta=true;break;case"Control":case"Ctrl":parsed.ctrl=true;break;case"Alt":case"Option":parsed.alt=true;break;case"Shift":parsed.shift=true;break;default:parsed.key=normalizeKeyName(part);break}}return parsed.key?parsed:null}function matchKind(event,parsed){if(event.ctrlKey!==parsed.ctrl||event.altKey!==parsed.alt||event.shiftKey!==parsed.shift||event.metaKey!==parsed.meta)return null;if(normalizeKeyName(event.key)===parsed.key)return"logical";if(!(parsed.ctrl||parsed.alt||parsed.meta)||typeof event.getModifierState=="function"&&event.getModifierState("AltGraph"))return null;let codeKey=keyNameFromCode(event.code);return codeKey!=null&&normalizeKeyName(codeKey)===parsed.key?"physical":null}function dispatchHost(message){if(typeof E=="object"&&E&&typeof E.dispatchHostMessage=="function"){E.dispatchHostMessage(message);return true}return false}function dispatchElectron(type,params={}){if(typeof E=="object"&&E&&typeof E.dispatchMessage=="function"){E.dispatchMessage(type,params);return true}return false}let hostActionTypes={newThread:"new-chat",quickChat:"new-quick-chat",newThreadAlt:"new-chat",toggleSidebar:"toggle-sidebar",toggleTerminal:"toggle-terminal",toggleBrowserPanel:"toggle-browser-panel",toggleDiffPanel:"toggle-diff-panel",findInThread:"find-in-thread",navigateBack:"navigate-back",navigateForward:"navigate-forward",previousThread:"previous-thread",nextThread:"next-thread",copyConversationPath:"copy-conversation-path",toggleThreadPin:"toggle-thread-pin",renameThread:"rename-thread",archiveThread:"archive-thread",copyWorkingDirectory:"copy-working-directory",copySessionId:"copy-session-id",copyDeeplink:"copy-deeplink",toggleFileTreePanel:"toggle-file-tree-panel"};function runAction(id){if(/^thread[1-9]$/.test(id))return dispatchHost({type:"go-to-thread-index",index:Number(id.slice(6))-1});switch(id){case"openCommandMenu":case"openCommandMenuAlt":return dispatchHost({type:"command-menu",query:""});case"searchChats":return dispatchHost({type:"chat-search-command-menu"});case"searchFiles":return dispatchHost({type:"file-search-command-menu"});case"openFolder":return dispatchElectron("electron-create-new-workspace-root-option",{});case"settings":return dispatchElectron("show-settings",{section:"general-settings"});case"openBrowserTab":return dispatchHost({type:"browser-sidebar-command",command:{type:"new-tab"}});case"reloadBrowserPage":return dispatchHost({type:"browser-sidebar-command",command:{type:"reload"}});case"hardReloadBrowserPage":return dispatchHost({type:"browser-sidebar-command",command:{type:"hard-reload"}});case"dictation":return dispatchElectron("global-dictation-start",{});default:return hostActionTypes[id]?dispatchHost({type:hostActionTypes[id]}):false}}loadOverrides();window.addEventListener("storage",event=>{event.key===storageKey&&loadOverrides()});window.addEventListener("codex-linux-keybind-overrides-changed",loadOverrides);window.addEventListener("keydown",event=>{if(event.defaultPrevented||event.repeat||isShortcutCaptureTarget(event))return;let accelerators={...defaultMap,...overrides};for(let[id,accelerator]of Object.entries(accelerators)){if(typeof accelerator!="string"||accelerator.trim().length===0)continue;let isDefault=accelerator.trim()===(defaultMap[id]||""),parsed=parseAccelerator(accelerator),kind=parsed?matchKind(event,parsed):null;if(kind&&(kind==="physical"||!isDefault)&&runAction(id)){event.preventDefault();event.stopPropagation();break}}},true)}catch{}}codexLinuxKeybindOverridesRuntime();`;

  const runtimeMarker = ";function codexLinuxKeybindOverridesRuntime()";
  const existingRuntimeIndex = currentSource.indexOf(runtimeMarker);
  if (existingRuntimeIndex !== -1) {
    return `${currentSource.slice(0, existingRuntimeIndex).trimEnd()}\n${runtimePatch}`;
  }

  return `${currentSource}\n${runtimePatch}`;
}

function applyKeybindsSettingsIndexPatch(currentSource) {
  let patchedSource = currentSource;

  if (!patchedSource.includes(`${keybindsSettingsAsset}`)) {
    const routePattern = /var ([A-Za-z_$][\w$]*)=\{"general-settings":(?=\(0,([A-Za-z_$][\w$]*)\.lazy\)\(\(\)=>([A-Za-z_$][\w$]*)\()/;
    if (!routePattern.test(patchedSource)) {
      throw new Error("Required Keybinds settings patch failed: could not add keybinds route");
    }
    patchedSource = patchedSource.replace(
      routePattern,
      (_match, routeMap, lazyAlias, preloadAlias) =>
        `var ${routeMap}={keybinds:(0,${lazyAlias}.lazy)(()=>${preloadAlias}(()=>import(\`./${keybindsSettingsAsset}\`),[],import.meta.url)),"general-settings":`,
    );
  }

  if (!/[,{]keybinds:[A-Za-z_$][\w$]*,"general-settings":/.test(patchedSource)) {
    const iconPattern = /([A-Za-z_$][\w$]*=\{)"general-settings":([A-Za-z_$][\w$]*),/;
    if (!iconPattern.test(patchedSource)) {
      throw new Error("Required Keybinds settings patch failed: could not add keybinds icon");
    }
    patchedSource = patchedSource.replace(
      iconPattern,
      (_match, prefix, icon) => `${prefix}keybinds:${icon},"general-settings":${icon},`,
    );
  }

  if (!/=\[`general-settings`,`keybinds`/.test(patchedSource)) {
    const orderPattern = /([A-Za-z_$][\w$]*=\[`general-settings`,)`appearance`/;
    if (!orderPattern.test(patchedSource)) {
      throw new Error("Required Keybinds settings patch failed: could not add keybinds nav order");
    }
    patchedSource = patchedSource.replace(orderPattern, "$1`keybinds`,`appearance`");
  }

  if (!patchedSource.includes("slugs:[`general-settings`,`keybinds`")) {
    const groupNeedle = "slugs:[`general-settings`,`appearance`,`connections`,`git-settings`,`usage`]";
    const groupPatch = "slugs:[`general-settings`,`keybinds`,`appearance`,`connections`,`git-settings`,`usage`]";
    if (!patchedSource.includes(groupNeedle)) {
      throw new Error("Required Keybinds settings patch failed: could not add keybinds nav group");
    }
    patchedSource = patchedSource.replace(groupNeedle, groupPatch);
  }

  if (!patchedSource.includes("case`keybinds`:return l===`electron`")) {
    const visibilityNeedle =
      "case`appearance`:case`git-settings`:case`worktrees`:case`local-environments`:case`data-controls`:case`environments`:return l===`electron`;";
    const visibilityPatch =
      "case`keybinds`:return l===`electron`;case`appearance`:case`git-settings`:case`worktrees`:case`local-environments`:case`data-controls`:case`environments`:return l===`electron`;";
    if (!patchedSource.includes(visibilityNeedle)) {
      throw new Error("Required Keybinds settings patch failed: could not add keybinds visibility");
    }
    patchedSource = patchedSource.replace(visibilityNeedle, visibilityPatch);
  }

  if (!patchedSource.includes("case`keybinds`:k=!1;break bb0;")) {
    const redirectNeedle =
      "case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`account`:case`data-controls`:case`personalization`:k=!1;break bb0;";
    const redirectPatch =
      "case`keybinds`:k=!1;break bb0;case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`account`:case`data-controls`:case`personalization`:k=!1;break bb0;";
    if (patchedSource.includes(redirectNeedle)) {
      patchedSource = patchedSource.replace(redirectNeedle, redirectPatch);
    }
  }

  return applyLinuxKeybindOverridesRuntimePatch(patchedSource);
}

function isSettingsRouteBundleSource(currentSource) {
  return currentSource.includes(linuxDesktopSettingsAsset)
    || /"general-settings":[A-Za-z_$][\w$]*\(async\(\)=>\(await [A-Za-z_$][\w$]*\(async\(\)=>\{let\{GeneralSettings:[A-Za-z_$][\w$]*\}=await import\(`/u.test(
      currentSource,
    );
}

function isSettingsSectionsMetadataBundleSource(currentSource) {
  return (
    currentSource.includes("slug:`general-settings`")
    && currentSource.includes("slug:`keyboard-shortcuts`")
  ) || (
    /[A-Za-z_$][\w$]*=`general-settings`/.test(currentSource)
    && currentSource.includes("slug:`keyboard-shortcuts`")
  ) || /`general-settings\.[^`]*keyboard-shortcuts[^`]*`\.split\(`\.`\)/.test(currentSource);
}

function isSettingsSharedMetadataBundleSource(currentSource) {
  return currentSource.includes('"general-settings":{id:`settings.nav.general-settings`')
    || currentSource.includes("id:`settings.section.general-settings`,defaultMessage:`General`");
}

function isSettingsNavigationBundleSource(currentSource) {
  return (
    /[A-Za-z_$][\w$]*=\{[^;]*"linux-desktop":[A-Za-z_$][\w$]*,/.test(currentSource)
    && currentSource.includes("slugs:[`general-settings`,`linux-desktop`")
  ) || (
    /[A-Za-z_$][\w$]*=\{[^;]*"general-settings":[A-Za-z_$][\w$]*,/.test(currentSource)
    && /[A-Za-z_$][\w$]*=\[`general-settings`,/.test(currentSource)
    && currentSource.includes("slugs:[`general-settings`,")
  );
}

function applyLinuxDesktopSettingsRoutePatch(
  currentSource,
  routeAssetSpecifier = linuxDesktopSettingsAsset,
) {
  let patchedSource = currentSource;

  if (patchedSource.includes(linuxDesktopSettingsAsset)) {
    const existingSpecifierPattern = new RegExp(
      `${escapeRegExp(linuxDesktopSettingsAsset)}(?:\\?v=[a-f0-9]+)?`,
      "g",
    );
    return patchedSource.replace(existingSpecifierPattern, routeAssetSpecifier);
  }

  if (!patchedSource.includes(routeAssetSpecifier)) {
    const routePattern =
      /((?:var )?[A-Za-z_$][\w$]*=\{)(?="general-settings":([A-Za-z_$][\w$]*)\(async\(\)=>\(await ([A-Za-z_$][\w$]*)\(async\(\)=>\{let\{GeneralSettings:[A-Za-z_$][\w$]*\}=await import\(`)/u;
    if (!routePattern.test(patchedSource)) {
      throw new Error("Required Keybinds settings patch failed: could not add Linux desktop route");
    }
    patchedSource = patchedSource.replace(
      routePattern,
      (_match, routeMapPrefix, routeLoader, preloadAlias) =>
        `${routeMapPrefix}"linux-desktop":${routeLoader}(async()=>(await ${preloadAlias}(async()=>{let{LinuxDesktopSettings:e}=await import(\`./${routeAssetSpecifier}\`);return{LinuxDesktopSettings:e}},[],import.meta.url)).LinuxDesktopSettings),`,
    );
  }

  return patchedSource;
}

function applyLinuxDesktopSettingsNavigationPatch(currentSource) {
  let patchedSource = currentSource;

  if (!/[,{]"linux-desktop":[A-Za-z_$][\w$]*,"general-settings":/.test(patchedSource)) {
    const iconPattern = /([A-Za-z_$][\w$]*=\{)"general-settings":([A-Za-z_$][\w$]*),/;
    if (!iconPattern.test(patchedSource)) {
      throw new Error("Required Keybinds settings patch failed: could not add Linux desktop icon");
    }
    patchedSource = patchedSource.replace(
      iconPattern,
      (_match, prefix, icon) => `${prefix}"linux-desktop":${icon},"general-settings":${icon},`,
    );
  }

  if (!/=\[`general-settings`,`linux-desktop`/.test(patchedSource)) {
    const orderPattern = /([A-Za-z_$][\w$]*=\[`general-settings`,)(?!`linux-desktop`)/;
    if (!orderPattern.test(patchedSource)) {
      throw new Error("Required Keybinds settings patch failed: could not add Linux desktop nav order");
    }
    patchedSource = patchedSource.replace(orderPattern, "$1`linux-desktop`,");
  }

  if (!patchedSource.includes("slugs:[`general-settings`,`linux-desktop`")) {
    const groupPattern = /(slugs:\[`general-settings`,)(?!`linux-desktop`)/;
    if (!groupPattern.test(patchedSource)) {
      throw new Error("Required Keybinds settings patch failed: could not add Linux desktop nav group");
    }
    patchedSource = patchedSource.replace(groupPattern, "$1`linux-desktop`,");
  }

  if (
    !patchedSource.includes("case`linux-desktop`:return l===`electron`")
    && !patchedSource.includes("case`linux-desktop`:case`general-settings`:case`agent`:case`personalization`:return!0;")
  ) {
    const visibilityNeedle =
      "case`appearance`:case`git-settings`:case`worktrees`:case`local-environments`:case`data-controls`:case`environments`:return l===`electron`;";
    const visibilityPatch =
      "case`linux-desktop`:return l===`electron`;case`appearance`:case`git-settings`:case`worktrees`:case`local-environments`:case`data-controls`:case`environments`:return l===`electron`;";
    if (!patchedSource.includes(visibilityNeedle)) {
      const currentVisibilityNeedle =
        "case`general-settings`:case`agent`:case`personalization`:return!0;";
      const currentVisibilityPatch =
        "case`linux-desktop`:case`general-settings`:case`agent`:case`personalization`:return!0;";
      if (!patchedSource.includes(currentVisibilityNeedle)) {
        throw new Error("Required Keybinds settings patch failed: could not add Linux desktop visibility");
      }
      patchedSource = patchedSource.replace(currentVisibilityNeedle, currentVisibilityPatch);
    } else {
      patchedSource = patchedSource.replace(visibilityNeedle, visibilityPatch);
    }
  }

  if (!/case`linux-desktop`:[A-Za-z_$][\w$]*=!1;break [A-Za-z_$][\w$]*;/.test(patchedSource)) {
    const redirectNeedle =
      "case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`account`:case`data-controls`:case`personalization`:k=!1;break bb0;";
    const redirectPatch =
      "case`linux-desktop`:k=!1;break bb0;case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`account`:case`data-controls`:case`personalization`:k=!1;break bb0;";
    if (patchedSource.includes(redirectNeedle)) {
      patchedSource = patchedSource.replace(redirectNeedle, redirectPatch);
    } else {
      const currentLoadingPattern = /(case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`data-controls`:case`personalization`:([A-Za-z_$][\w$]*)=!1;break ([A-Za-z_$][\w$]*);)/;
      if (currentLoadingPattern.test(patchedSource)) {
        patchedSource = patchedSource.replace(
          currentLoadingPattern,
          (_match, existingCases, loadingAlias, breakLabel) =>
            `case\`linux-desktop\`:${loadingAlias}=!1;break ${breakLabel};${existingCases}`,
        );
      }
    }
  }

  return patchedSource;
}

function applyLinuxDesktopSettingsIndexPatch(currentSource) {
  return applyLinuxDesktopSettingsNavigationPatch(
    applyLinuxDesktopSettingsRoutePatch(currentSource),
  );
}

module.exports = {
  applyKeybindsSettingsIndexPatch,
  applyKeybindsSettingsSectionsPatch,
  applyKeybindsSettingsSharedPatch,
  applyLinuxDesktopSettingsIndexPatch,
  applyLinuxDesktopSettingsNavigationPatch,
  applyLinuxDesktopSettingsRoutePatch,
  applyLinuxDesktopSettingsSectionsPatch,
  applyLinuxDesktopSettingsSharedPatch,
  applyLinuxKeybindOverridesRuntimePatch,
  applyLinuxShortcutPhysicalKeyFallbackPatch,
  keybindsSettingsAsset,
  linuxDesktopSettingsAsset,
  linuxKeybindOverridesKey,
  patchKeybindsSettingsAssets,
  resolveLinuxDesktopSettingsAsset,
};
