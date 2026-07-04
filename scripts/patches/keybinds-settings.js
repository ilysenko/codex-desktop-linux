"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  escapeRegExp,
  findCodexRequestWebviewAsset,
  findImportedAsset,
  findRequiredWebviewAsset,
  linuxSettingsKeys,
} = require("./shared.js");

// Keybind settings are transactional: either all dependent webview assets are
// updated together, or the patch logs a warning and leaves the app usable.
const keybindsSettingsAsset = "keybinds-settings-linux.js";
const linuxDesktopSettingsAsset = "linux-desktop-settings-linux.js";
const linuxKeybindOverridesKey = "codex-linux-keybind-overrides";
const linuxDesktopTitleMessage = Object.freeze({
  id: "settings.section.linux-desktop",
  defaultMessage: "Linux desktop",
  description: "Title for Linux desktop settings section",
});
const linuxDesktopRendererMessageEntries = Object.freeze([
  [
    "settings.nav.linux-desktop",
    "Рабочий стол Linux",
    "settings.nav.general-settings",
  ],
  [
    "settings.section.linux-desktop",
    "Рабочий стол Linux",
    "settings.section.general-settings",
  ],
  [
    "settings.linux-desktop.subtitle",
    "Поведение запуска, системного трея, окна запроса и обновлений.",
    "settings.section.linux-desktop",
  ],
  [
    "settings.linux-desktop.globalShortcuts",
    "Глобальные сочетания клавиш",
    "settings.linux-desktop.subtitle",
  ],
  [
    "settings.linux-desktop.compactPromptWindow",
    "Компактное окно запроса",
    "settings.linux-desktop.globalShortcuts",
  ],
  [
    "settings.linux-desktop.compactPromptWindowDescription",
    "Разрешить --prompt-chat и --hotkey-window открывать компактное окно запроса и держать его прогретым.",
    "settings.linux-desktop.compactPromptWindow",
  ],
  [
    "settings.linux-desktop.desktopIntegration",
    "Интеграция с рабочим столом",
    "settings.linux-desktop.compactPromptWindowDescription",
  ],
  [
    "settings.linux-desktop.systemTray",
    "Системный трей",
    "settings.linux-desktop.desktopIntegration",
  ],
  [
    "settings.linux-desktop.systemTrayDescription",
    "Показывать значок Codex в системном трее и оставлять приложение доступным из трея.",
    "settings.linux-desktop.systemTray",
  ],
  [
    "settings.linux-desktop.warmStart",
    "Быстрый запуск",
    "settings.linux-desktop.systemTrayDescription",
  ],
  [
    "settings.linux-desktop.warmStartDescription",
    "Использовать уже запущенное приложение для действий запуска вместо создания нового экземпляра Electron.",
    "settings.linux-desktop.warmStart",
  ],
  [
    "settings.linux-desktop.updates",
    "Обновления",
    "settings.linux-desktop.warmStartDescription",
  ],
  [
    "settings.linux-desktop.autoUpdateOnExit",
    "Устанавливать обновления после закрытия Codex",
    "settings.linux-desktop.updates",
  ],
  [
    "settings.linux-desktop.autoUpdateOnExitDescription",
    "Если включено, готовое обновление дождется закрытия Codex и установится. Если выключено, обновления будут ждать, пока вы не нажмете «Обновить».",
    "settings.linux-desktop.autoUpdateOnExit",
  ],
  [
    "settings.linux-desktop.build",
    "Сборка",
    "settings.linux-desktop.autoUpdateOnExitDescription",
  ],
  [
    "settings.linux-desktop.buildInformation",
    "Информация о сборке",
    "settings.linux-desktop.build",
  ],
  [
    "settings.linux-desktop.buildInformationDescription",
    "Метаданные установленного пакета и исходной upstream-сборки.",
    "settings.linux-desktop.buildInformation",
  ],
  [
    "settings.linux-desktop.copyCommit",
    "Скопировать коммит",
    "settings.linux-desktop.buildInformationDescription",
  ],
  [
    "settings.linux-desktop.openOnGitHub",
    "Открыть на GitHub",
    "settings.linux-desktop.copyCommit",
  ],
  [
    "settings.linux-desktop.refresh",
    "Обновить",
    "settings.linux-desktop.openOnGitHub",
  ],
  [
    "settings.linux-desktop.details",
    "Подробнее",
    "settings.linux-desktop.refresh",
  ],
  [
    "settings.linux-desktop.metadataFile",
    "Файл метаданных",
    "settings.linux-desktop.details",
  ],
  [
    "settings.linux-desktop.linuxPackageProfile",
    "Профиль Linux-пакета",
    "settings.linux-desktop.metadataFile",
  ],
  [
    "settings.linux-desktop.linuxSourceCommit",
    "Коммит исходников Linux",
    "settings.linux-desktop.linuxPackageProfile",
  ],
  [
    "settings.linux-desktop.sourceBranch",
    "Исходная ветка",
    "settings.linux-desktop.linuxSourceCommit",
  ],
  [
    "settings.linux-desktop.generated",
    "Сгенерировано",
    "settings.linux-desktop.sourceBranch",
  ],
  [
    "settings.linux-desktop.distro",
    "Дистрибутив",
    "settings.linux-desktop.generated",
  ],
  [
    "settings.linux-desktop.packageManager",
    "Менеджер пакетов",
    "settings.linux-desktop.distro",
  ],
  [
    "settings.linux-desktop.packageFormat",
    "Формат пакета",
    "settings.linux-desktop.packageManager",
  ],
  [
    "settings.linux-desktop.enabledFeatures",
    "Включенные возможности",
    "settings.linux-desktop.packageFormat",
  ],
  [
    "settings.linux-desktop.upstreamAppVersion",
    "Версия upstream-приложения",
    "settings.linux-desktop.enabledFeatures",
  ],
  [
    "settings.linux-desktop.electron",
    "Electron",
    "settings.linux-desktop.upstreamAppVersion",
  ],
  [
    "settings.linux-desktop.upstreamDmgSha256",
    "SHA256 upstream DMG",
    "settings.linux-desktop.electron",
  ],
  [
    "settings.linux-desktop.none",
    "нет",
    "settings.linux-desktop.upstreamDmgSha256",
  ],
  [
    "settings.linux-desktop.notFound",
    "не найден",
    "settings.linux-desktop.none",
  ],
  [
    "settings.linux-desktop.unknown",
    "неизвестно",
    "settings.linux-desktop.notFound",
  ],
  [
    "settings.linux-desktop.dirtySuffix",
    " (грязное дерево)",
    "settings.linux-desktop.unknown",
  ],
  [
    "settings.linux-desktop.loadingBuildMetadata",
    "Загрузка метаданных сборки...",
    "settings.linux-desktop.dirtySuffix",
  ],
  [
    "settings.linux-desktop.clipboardUnavailable",
    "Clipboard API недоступен",
    "settings.linux-desktop.loadingBuildMetadata",
  ],
  [
    "settings.linux-desktop.commitCopied",
    "Коммит скопирован",
    "settings.linux-desktop.clipboardUnavailable",
  ],
]);

function linuxDesktopRendererMessage(useMessageComponent, message) {
  return useMessageComponent
    ? `codexLinuxDesktopText(${JSON.stringify(message.id)},${JSON.stringify(message.defaultMessage)},${JSON.stringify(message.description)})`
    : JSON.stringify(message.defaultMessage);
}

function linuxDesktopTextHelperSource(useMessageComponent) {
  return useMessageComponent
    ? "function codexLinuxDesktopText(id,defaultMessage,description){return $.jsx(LinuxDesktopMessage,{id,defaultMessage,description})}"
    : "function codexLinuxDesktopText(_id,defaultMessage){return defaultMessage}";
}

function linuxDesktopMessage(id, defaultMessage, description) {
  return { id, defaultMessage, description };
}

function linuxBuildInfoPanelSource() {
  return `const CODEX_LINUX_BUILD_INFO_CLIPBOARD_UNAVAILABLE="__codex_linux_build_info_clipboard_unavailable__";function codexLinuxBuildInfoValueNode(value,fallback){return typeof value=="string"&&value.trim().length>0?value:Array.isArray(value)&&value.length>0?value.join(", "):value==null?fallback:String(value)}function codexLinuxFormatBuildInfoTimestamp(value){let text=typeof value=="string"?value.trim():"";if(!text)return null;let parsed=Date.parse(text);if(!Number.isFinite(parsed))return text;try{return new Intl.DateTimeFormat(void 0,{dateStyle:"medium",timeStyle:"short"}).format(parsed)}catch{return text}}function codexLinuxBuildInfoRows(payload){let info=payload?.info;if(!info)return[[codexLinuxDesktopText("settings.linux-desktop.metadataFile","Metadata file","Label for the Linux build metadata file path"),codexLinuxBuildInfoValueNode(payload?.path,codexLinuxDesktopText("settings.linux-desktop.notFound","not found","Fallback label when Linux build metadata is missing"))]];let target=info.linuxTarget??{},distro=target.distro??{},dmg=info.upstreamDmg??{},source=info.source??{},features=info.linuxFeatures?.enabled??[],profile=info.packageProfile??{},commit=source.commit||source.shortCommit||"",commitValue=commit?source.dirty?$.jsxs("span",{children:[commit,codexLinuxDesktopText("settings.linux-desktop.dirtySuffix"," (dirty)","Suffix appended to a dirty Linux source commit value")]}):commit:codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"),distroValue=distro.prettyName||[distro.id,distro.versionId].filter(Boolean).join(" ")||codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"),generatedValue=codexLinuxFormatBuildInfoTimestamp(info.generatedAt)??codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown");return[[codexLinuxDesktopText("settings.linux-desktop.metadataFile","Metadata file","Label for the Linux build metadata file path"),codexLinuxBuildInfoValueNode(payload?.path,codexLinuxDesktopText("settings.linux-desktop.notFound","not found","Fallback label when Linux build metadata is missing"))],[codexLinuxDesktopText("settings.linux-desktop.linuxPackageProfile","Linux package profile","Label for the Linux package profile value"),codexLinuxBuildInfoValueNode(profile.label,codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"))],[codexLinuxDesktopText("settings.linux-desktop.linuxSourceCommit","Linux source commit","Label for the Linux source commit value"),commitValue,payload?.commitUrl],[codexLinuxDesktopText("settings.linux-desktop.sourceBranch","Source branch","Label for the source branch value"),codexLinuxBuildInfoValueNode(source.branch,codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"))],[codexLinuxDesktopText("settings.linux-desktop.generated","Generated","Label for the build timestamp value"),generatedValue],[codexLinuxDesktopText("settings.linux-desktop.distro","Distro","Label for the Linux distro value"),distroValue],[codexLinuxDesktopText("settings.linux-desktop.packageManager","Package manager","Label for the package manager value"),codexLinuxBuildInfoValueNode(target.packageManager??profile.packageManager,codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"))],[codexLinuxDesktopText("settings.linux-desktop.packageFormat","Package format","Label for the package format value"),codexLinuxBuildInfoValueNode(target.packageFormat??profile.format,codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"))],[codexLinuxDesktopText("settings.linux-desktop.enabledFeatures","Enabled features","Label for the enabled Linux feature list"),features.length>0?features.join(", "):codexLinuxDesktopText("settings.linux-desktop.none","none","Fallback value when no Linux features are enabled")],[codexLinuxDesktopText("settings.linux-desktop.upstreamAppVersion","Upstream app version","Label for the upstream app version value"),codexLinuxBuildInfoValueNode(dmg.appVersion,codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"))],[codexLinuxDesktopText("settings.linux-desktop.electron","Electron","Label for the Electron version value"),codexLinuxBuildInfoValueNode(info.electronVersion,codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"))],[codexLinuxDesktopText("settings.linux-desktop.upstreamDmgSha256","Upstream DMG SHA256","Label for the upstream DMG SHA256 value"),codexLinuxBuildInfoValueNode(dmg.sha256,codexLinuxDesktopText("settings.linux-desktop.unknown","unknown","Fallback value when Linux build information is unknown"))]].filter(row=>row[1]!=null)}function LinuxBuildInfoPanel(){let[data,setData]=React.useState(null),[isLoading,setIsLoading]=React.useState(!0),[error,setError]=React.useState(null),[copied,setCopied]=React.useState(!1),load=React.useCallback(()=>{setIsLoading(!0),setError(null),__post("codex-linux-get-build-info",{}).then(result=>setData(result)).catch(err=>setError(err instanceof Error?err.message:String(err))).finally(()=>setIsLoading(!1))},[]);React.useEffect(()=>{load()},[load]);let info=data?.info,commit=info?.source?.commit||"",commitUrl=data?.commitUrl||"",copyCommit=()=>{if(!commit)return;let fail=err=>setError(err instanceof Error?err.message:String(err));navigator.clipboard?.writeText?navigator.clipboard.writeText(commit).then(()=>{setCopied(!0),setTimeout(()=>setCopied(!1),1500)}).catch(fail):setError(CODEX_LINUX_BUILD_INFO_CLIPBOARD_UNAVAILABLE)},openCommit=()=>{commitUrl&&__post("codex-linux-open-build-info-commit",{}).catch(err=>setError(err instanceof Error?err.message:String(err)))},showDetails=()=>__post("codex-linux-show-build-info",{}).catch(err=>setError(err instanceof Error?err.message:String(err))),buttonClass="h-8 rounded-md border border-token-border-default bg-token-bg-primary px-3 text-sm text-token-text-primary hover:bg-token-surface-secondary disabled:cursor-not-allowed disabled:opacity-60",rows=codexLinuxBuildInfoRows(data),actions=[{key:"copyCommit",label:codexLinuxDesktopText("settings.linux-desktop.copyCommit","Copy commit","Button label for copying the Linux source commit"),disabled:!commit,onClick:copyCommit},{key:"openCommit",label:codexLinuxDesktopText("settings.linux-desktop.openOnGitHub","Open on GitHub","Button label for opening the Linux source commit on GitHub"),disabled:!commitUrl,onClick:openCommit},{key:"refresh",label:codexLinuxDesktopText("settings.linux-desktop.refresh","Refresh","Button label for refreshing Linux build information"),disabled:isLoading,onClick:load},{key:"details",label:codexLinuxDesktopText("settings.linux-desktop.details","Details","Button label for opening the Linux build information details dialog"),disabled:!1,onClick:showDetails}],status=error||copied?$.jsxs("div",{className:"flex flex-wrap items-center gap-3 text-sm",children:[error?$.jsx("span",{className:"text-token-error-foreground",children:error===CODEX_LINUX_BUILD_INFO_CLIPBOARD_UNAVAILABLE?codexLinuxDesktopText("settings.linux-desktop.clipboardUnavailable","Clipboard API is unavailable","Error shown when the clipboard API cannot be used on the Linux build information panel"):error}):null,copied?$.jsx("span",{className:"text-token-text-secondary",children:codexLinuxDesktopText("settings.linux-desktop.commitCopied","Commit copied","Status shown after copying the Linux source commit")}):null]}):null,content=isLoading?$.jsx("div",{className:"rounded-lg border border-token-border-default bg-token-bg-primary px-3 py-4 text-sm text-token-text-secondary",children:codexLinuxDesktopText("settings.linux-desktop.loadingBuildMetadata","Loading build metadata...","Status shown while Linux build information is loading")}):$.jsx("dl",{className:"grid gap-3 sm:grid-cols-2",children:rows.map(([label,value,url],rowIndex)=>{let valueNode=url?$.jsx("a",{href:url,title:url,onClick:event=>{event.preventDefault(),openCommit()},className:"inline-flex max-w-full select-text break-all rounded-md bg-token-bg-secondary px-2 py-1 font-mono text-xs text-token-text-primary underline decoration-token-text-tertiary underline-offset-2 hover:decoration-token-text-primary",children:value}):$.jsx("code",{className:"inline-flex max-w-full select-text break-all rounded-md bg-token-bg-secondary px-2 py-1 font-mono text-xs text-token-text-primary",children:value});return $.jsxs("div",{className:"flex min-w-0 flex-col gap-2 rounded-lg border border-token-border-default bg-token-bg-primary p-3",children:[$.jsx("dt",{className:"text-xs font-medium uppercase tracking-wide text-token-text-tertiary",children:label}),$.jsx("dd",{className:"min-w-0 text-sm text-token-text-primary",children:valueNode})]},url??rowIndex)})});return $.jsxs("div",{className:"flex flex-col gap-4 p-4",children:[$.jsxs("div",{className:"flex flex-col gap-3 border-b border-token-border-default pb-4 sm:flex-row sm:items-start sm:justify-between",children:[$.jsxs("div",{className:"space-y-1",children:[$.jsx("div",{className:"text-sm font-medium text-token-text-primary",children:codexLinuxDesktopText("settings.linux-desktop.buildInformation","Build information","Title for the Linux build information panel")}),$.jsx("p",{className:"text-sm text-token-text-tertiary",children:codexLinuxDesktopText("settings.linux-desktop.buildInformationDescription","Installed package and upstream build metadata.","Description for the Linux build information panel")})]}),$.jsx("div",{className:"flex flex-wrap items-center gap-2",children:actions.map(action=>$.jsx("button",{type:"button",className:buttonClass,disabled:action.disabled,onClick:action.onClick,children:action.label},action.key))})]}),status,content]})}`;
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
  messageAsset = null,
  messageExportName = null,
}) {
  const reactImport = reactAsset === jsxRuntimeAsset
    ? `import{${reactExportName} as __reactFactory,${jsxRuntimeExportName} as __jsxFactory}from"./${jsxRuntimeAsset}";`
    : `import{${reactExportName} as __reactFactory}from"./${reactAsset}";import{${jsxRuntimeExportName} as __jsxFactory}from"./${jsxRuntimeAsset}";`;
  const messageImport = messageAsset == null
    ? ""
    : `import{${messageExportName} as LinuxDesktopMessage}from"./${messageAsset}";`;
  const useMessageComponent = messageAsset != null;
  const linuxDesktopTextHelper = linuxDesktopTextHelperSource(useMessageComponent);
  const linuxDesktopTitle = linuxDesktopRendererMessage(useMessageComponent, linuxDesktopTitleMessage);
  const linuxDesktopGlobalShortcuts = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.globalShortcuts",
      "Global shortcuts",
      "Section title for Linux desktop global shortcuts settings",
    ),
  );
  const linuxDesktopCompactPromptWindow = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.compactPromptWindow",
      "Compact prompt window",
      "Label for the Linux compact prompt window setting",
    ),
  );
  const linuxDesktopCompactPromptWindowDescription = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.compactPromptWindowDescription",
      "Allow --prompt-chat and --hotkey-window to open the compact prompt window and keep it prewarmed.",
      "Description for the Linux compact prompt window setting",
    ),
  );
  const linuxDesktopDesktopIntegration = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.desktopIntegration",
      "Desktop integration",
      "Section title for Linux desktop integration settings",
    ),
  );
  const linuxDesktopSystemTray = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.systemTray",
      "System tray",
      "Label for the Linux system tray setting",
    ),
  );
  const linuxDesktopSystemTrayDescription = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.systemTrayDescription",
      "Show the Codex system tray icon and keep the app available from the tray.",
      "Description for the Linux system tray setting",
    ),
  );
  const linuxDesktopWarmStart = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.warmStart",
      "Warm start",
      "Label for the Linux warm start setting",
    ),
  );
  const linuxDesktopWarmStartDescription = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.warmStartDescription",
      "Use the running app for launch actions instead of starting a fresh Electron instance.",
      "Description for the Linux warm start setting",
    ),
  );
  const linuxDesktopUpdates = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.updates",
      "Updates",
      "Section title for Linux desktop update settings",
    ),
  );
  const linuxDesktopAutoUpdateOnExit = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.autoUpdateOnExit",
      "Install updates when you close Codex",
      "Label for the Linux install-on-exit update setting",
    ),
  );
  const linuxDesktopAutoUpdateOnExitDescription = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.autoUpdateOnExitDescription",
      "When on, a ready update waits for Codex to close and then installs. When off, updates wait until you click Update.",
      "Description for the Linux install-on-exit update setting",
    ),
  );
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

  return `import{s as __toESM}from"./${chunkAsset}";${reactImport}${messageImport}import{${vscodeApiExportName} as __post}from"./${vscodeApiAsset}";import{i as HotkeyWindowHotkeyRow}from"./${hotkeySettingsAsset}";import{${settingsRowExportName} as SettingsRow}from"./${settingsRowAsset}";import{${settingsSectionExportName} as SettingsSection}from"./${settingsSectionAsset}";import{${settingsGroupExportName} as SettingsGroup}from"./${settingsGroupAsset}";import{${settingsPageExportName} as SettingsPage}from"./${settingsPageAsset}";import{${toggleExportName} as Toggle}from"./${toggleAsset}";var React=__toESM(__reactFactory(),1),$=__jsxFactory(),KEYS={promptWindow:${JSON.stringify(linuxSettingsKeys.promptWindow)},systemTray:${JSON.stringify(linuxSettingsKeys.systemTray)},warmStart:${JSON.stringify(linuxSettingsKeys.warmStart)},autoUpdateOnExit:${JSON.stringify(linuxSettingsKeys.autoUpdateOnExit)}},KEYBIND_OVERRIDES_KEY=${JSON.stringify(linuxKeybindOverridesKey)},DEFAULT_SHORTCUTS=${JSON.stringify(defaultShortcuts)},KEYBIND_GROUPS=${JSON.stringify(keybindGroups)};${linuxDesktopTextHelper}function normalizeOverrides(value){if(!value||typeof value!="object"||Array.isArray(value))return{};return Object.fromEntries(Object.entries(value).filter(([key,accelerator])=>typeof key=="string"&&typeof accelerator=="string"&&accelerator.trim().length>0).map(([key,accelerator])=>[key,accelerator.trim()]))}function readLocalOverrides(){try{return normalizeOverrides(JSON.parse(localStorage.getItem(KEYBIND_OVERRIDES_KEY)||"{}"))}catch{return{}}}function writeLocalOverrides(next){try{localStorage.setItem(KEYBIND_OVERRIDES_KEY,JSON.stringify(next)),window.dispatchEvent(new CustomEvent("codex-linux-keybind-overrides-changed",{detail:next}))}catch{}}function useKeybindOverrides(){let[overrides,setOverrides]=React.useState(()=>readLocalOverrides()),[error,setError]=React.useState(null);React.useEffect(()=>{let alive=!0;__post("get-global-state",{params:{key:KEYBIND_OVERRIDES_KEY}}).then(result=>{if(!alive)return;let next=normalizeOverrides(result?.value);Object.keys(next).length>0?(setOverrides(next),writeLocalOverrides(next)):setOverrides(readLocalOverrides());setError(null)}).catch(err=>{alive&&setError(err instanceof Error?err.message:String(err))});return()=>{alive=!1}},[]);let update=React.useCallback((actionId,accelerator)=>{setOverrides(previous=>{let next={...previous},defaultValue=typeof DEFAULT_SHORTCUTS[actionId]=="string"?DEFAULT_SHORTCUTS[actionId]:"",trimmed=String(accelerator??"").trim();trimmed.length===0||trimmed===defaultValue?delete next[actionId]:next[actionId]=trimmed;writeLocalOverrides(next);__post("set-global-state",{params:{key:KEYBIND_OVERRIDES_KEY,value:next}}).then(()=>setError(null)).catch(err=>setError(err instanceof Error?err.message:String(err)));return next})},[]);return{overrides,error,update}}function useLinuxSetting(key,defaultValue){let[value,setValue]=React.useState(defaultValue),[isLoading,setIsLoading]=React.useState(!0),[error,setError]=React.useState(null);React.useEffect(()=>{let alive=!0;setIsLoading(!0);__post("get-global-state",{params:{key}}).then(result=>{alive&&(setValue(result?.value??defaultValue),setError(null))}).catch(err=>{alive&&setError(err instanceof Error?err.message:String(err))}).finally(()=>{alive&&setIsLoading(!1)});return()=>{alive=!1}},[key,defaultValue]);let update=React.useCallback(next=>{let previous=value;setValue(next);setError(null);__post("set-global-state",{params:{key,value:next}}).catch(err=>{setValue(previous);setError(err instanceof Error?err.message:String(err))})},[key,value]);return{value,isLoading,error,update}}function LinuxToggle({settingKey,label,description,defaultValue=!0}){let{value,isLoading,error,update}=useLinuxSetting(settingKey,defaultValue),details=error?$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("span",{children:description}),$.jsx("span",{className:"text-token-error-foreground",children:error})]}):description;return $.jsx(SettingsRow,{label,description:details,control:$.jsx(Toggle,{checked:value,disabled:isLoading,onChange:update,ariaLabel:label})})}${linuxBuildInfoPanelSource()}function normalizeCapturedKey(key){let map={" ":"Space",ArrowUp:"Up",ArrowDown:"Down",ArrowLeft:"Left",ArrowRight:"Right",Escape:"Esc",",":",",".":".","/":"/","\\\\":"\\\\","[":"[","]":"]",";":";","'":"'","-":"-","=":"=","+":"Plus"};if(map[key])return map[key];if(/^.$/.test(key))return key.toUpperCase();return key}function formatAcceleratorForInput(event){if(!(event.ctrlKey||event.altKey||event.metaKey))return null;if(["Control","Shift","Alt","Meta"].includes(event.key))return null;let parts=[];event.ctrlKey&&parts.push("Ctrl");event.altKey&&parts.push("Alt");event.shiftKey&&parts.push("Shift");event.metaKey&&parts.push("Command");let key=normalizeCapturedKey(event.key);return key?[...parts,key].join("+"):null}function ShortcutInput({value,defaultValue,changed,onChange}){let[draft,setDraft]=React.useState(value);React.useEffect(()=>setDraft(value),[value]);let commit=next=>onChange(String(next??"").trim());return $.jsxs("div",{className:"flex min-w-[260px] items-center justify-end gap-2",children:[$.jsx("input",{className:"h-8 w-[190px] rounded-md border border-token-border-default bg-token-bg-primary px-2 text-sm text-token-text-primary outline-none focus:border-token-border-strong","data-codex-keybind-input":!0,value:draft,placeholder:defaultValue,onChange:event=>{setDraft(event.target.value),onChange(event.target.value)},onBlur:()=>commit(draft),onKeyDown:event=>{if(event.key==="Escape"){setDraft(value);return}if(event.key==="Enter"){event.preventDefault(),commit(draft);return}let captured=formatAcceleratorForInput(event);captured&&(event.preventDefault(),setDraft(captured),onChange(captured))}}),$.jsx("button",{type:"button",className:"h-8 rounded-md border border-token-border-default px-2 text-xs text-token-text-secondary disabled:opacity-40",disabled:!changed,onClick:()=>onChange(""),children:"Reset"})]})}function KeybindRow({action,overrides,update}){let defaultValue=typeof DEFAULT_SHORTCUTS[action.id]=="string"?DEFAULT_SHORTCUTS[action.id]:action.defaultAccelerator??"",hasOverride=Object.prototype.hasOwnProperty.call(overrides,action.id),value=hasOverride?overrides[action.id]:defaultValue,changed=hasOverride&&value!==defaultValue,description=$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("span",{children:action.description}),$.jsxs("span",{className:"text-token-text-tertiary",children:["Default: ",defaultValue||"Unassigned"]})]});return $.jsx(SettingsRow,{label:action.label,description,control:$.jsx(ShortcutInput,{value,defaultValue,changed,onChange:next=>update(action.id,next)})})}function KeybindGroup({group,overrides,update}){return $.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:group.title}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:group.actions.map(action=>$.jsx(KeybindRow,{action,overrides,update},action.id))})})]},group.title)}function KeybindsSettings(){let{overrides,error,update}=useKeybindOverrides();return $.jsx(SettingsPage,{title:"Keybinds",subtitle:"App shortcuts and Linux desktop behavior.",children:$.jsxs("div",{className:"flex flex-col gap-6",children:[$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"App shortcuts"}),error?$.jsx("div",{className:"px-1 text-sm text-token-error-foreground",children:error}):null]}),...KEYBIND_GROUPS.map(group=>$.jsx(KeybindGroup,{group,overrides,update},group.title)),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:${linuxDesktopGlobalShortcuts}}),$.jsx(SettingsSection.Content,{children:$.jsxs(SettingsGroup,{children:[$.jsx(HotkeyWindowHotkeyRow,{}),$.jsx(LinuxToggle,{settingKey:KEYS.promptWindow,label:${linuxDesktopCompactPromptWindow},description:${linuxDesktopCompactPromptWindowDescription}})]})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:${linuxDesktopTitle}}),$.jsx(SettingsSection.Content,{children:$.jsxs(SettingsGroup,{children:[$.jsx(LinuxToggle,{settingKey:KEYS.systemTray,label:${linuxDesktopSystemTray},description:${linuxDesktopSystemTrayDescription}}),$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:${linuxDesktopWarmStart},description:${linuxDesktopWarmStartDescription}}),$.jsx(LinuxBuildInfoPanel,{})]})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:${linuxDesktopUpdates}}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:${linuxDesktopAutoUpdateOnExit},description:${linuxDesktopAutoUpdateOnExitDescription}})})})]})]})})}export{KeybindsSettings,KeybindsSettings as default};\n//# sourceMappingURL=${keybindsSettingsAsset}.map\n`;
}

function buildLinuxDesktopSettingsSource({
  chunkAsset,
  reactAsset,
  reactExportName = "t",
  jsxRuntimeAsset,
  jsxRuntimeExportName = "t",
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
  messageAsset = null,
  messageExportName = null,
}) {
  const reactImport = reactAsset === jsxRuntimeAsset
    ? `import{${reactExportName} as __reactFactory,${jsxRuntimeExportName} as __jsxFactory}from"./${jsxRuntimeAsset}";`
    : `import{${reactExportName} as __reactFactory}from"./${reactAsset}";import{${jsxRuntimeExportName} as __jsxFactory}from"./${jsxRuntimeAsset}";`;
  const messageImport = messageAsset == null
    ? ""
    : `import{${messageExportName} as LinuxDesktopMessage}from"./${messageAsset}";`;
  const useMessageComponent = messageAsset != null;
  const linuxDesktopTextHelper = linuxDesktopTextHelperSource(useMessageComponent);
  const linuxDesktopTitle = linuxDesktopRendererMessage(useMessageComponent, linuxDesktopTitleMessage);
  const linuxDesktopSubtitle = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.subtitle",
      "Launcher, tray, prompt window, and update behavior.",
      "Subtitle for the Linux desktop settings page",
    ),
  );
  const linuxDesktopGlobalShortcuts = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.globalShortcuts",
      "Global shortcuts",
      "Section title for Linux desktop global shortcuts settings",
    ),
  );
  const linuxDesktopCompactPromptWindow = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.compactPromptWindow",
      "Compact prompt window",
      "Label for the Linux compact prompt window setting",
    ),
  );
  const linuxDesktopCompactPromptWindowDescription = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.compactPromptWindowDescription",
      "Allow --prompt-chat and --hotkey-window to open the compact prompt window and keep it prewarmed.",
      "Description for the Linux compact prompt window setting",
    ),
  );
  const linuxDesktopDesktopIntegration = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.desktopIntegration",
      "Desktop integration",
      "Section title for Linux desktop integration settings",
    ),
  );
  const linuxDesktopSystemTray = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.systemTray",
      "System tray",
      "Label for the Linux system tray setting",
    ),
  );
  const linuxDesktopSystemTrayDescription = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.systemTrayDescription",
      "Show the Codex system tray icon and keep the app available from the tray.",
      "Description for the Linux system tray setting",
    ),
  );
  const linuxDesktopWarmStart = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.warmStart",
      "Warm start",
      "Label for the Linux warm start setting",
    ),
  );
  const linuxDesktopWarmStartDescription = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.warmStartDescription",
      "Use the running app for launch actions instead of starting a fresh Electron instance.",
      "Description for the Linux warm start setting",
    ),
  );
  const linuxDesktopUpdates = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.updates",
      "Updates",
      "Section title for Linux desktop update settings",
    ),
  );
  const linuxDesktopAutoUpdateOnExit = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.autoUpdateOnExit",
      "Install updates when you close Codex",
      "Label for the Linux install-on-exit update setting",
    ),
  );
  const linuxDesktopAutoUpdateOnExitDescription = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.autoUpdateOnExitDescription",
      "When on, a ready update waits for Codex to close and then installs. When off, updates wait until you click Update.",
      "Description for the Linux install-on-exit update setting",
    ),
  );
  const linuxDesktopBuildSection = linuxDesktopRendererMessage(
    useMessageComponent,
    linuxDesktopMessage(
      "settings.linux-desktop.build",
      "Build",
      "Section title for Linux desktop build information",
    ),
  );

  return `import{s as __toESM}from"./${chunkAsset}";${reactImport}${messageImport}import{${vscodeApiExportName} as __post}from"./${vscodeApiAsset}";import{${settingsRowExportName} as SettingsRow}from"./${settingsRowAsset}";import{${settingsSectionExportName} as SettingsSection}from"./${settingsSectionAsset}";import{${settingsGroupExportName} as SettingsGroup}from"./${settingsGroupAsset}";import{${settingsPageExportName} as SettingsPage}from"./${settingsPageAsset}";import{${toggleExportName} as Toggle}from"./${toggleAsset}";var React=__toESM(__reactFactory(),1),$=__jsxFactory(),KEYS={promptWindow:${JSON.stringify(linuxSettingsKeys.promptWindow)},systemTray:${JSON.stringify(linuxSettingsKeys.systemTray)},warmStart:${JSON.stringify(linuxSettingsKeys.warmStart)},autoUpdateOnExit:${JSON.stringify(linuxSettingsKeys.autoUpdateOnExit)}};${linuxDesktopTextHelper}function useLinuxSetting(key,defaultValue){let[value,setValue]=React.useState(defaultValue),[isLoading,setIsLoading]=React.useState(!0),[error,setError]=React.useState(null);React.useEffect(()=>{let alive=!0;setIsLoading(!0);__post("get-global-state",{params:{key}}).then(result=>{alive&&(setValue(result?.value??defaultValue),setError(null))}).catch(err=>{alive&&setError(err instanceof Error?err.message:String(err))}).finally(()=>{alive&&setIsLoading(!1)});return()=>{alive=!1}},[key,defaultValue]);let update=React.useCallback(next=>{let previous=value;setValue(next);setError(null);__post("set-global-state",{params:{key,value:next}}).catch(err=>{setValue(previous);setError(err instanceof Error?err.message:String(err))})},[key,value]);return{value,isLoading,error,update}}function LinuxToggle({settingKey,label,description,defaultValue=!0}){let{value,isLoading,error,update}=useLinuxSetting(settingKey,defaultValue),details=error?$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("span",{children:description}),$.jsx("span",{className:"text-token-error-foreground",children:error})]}):description;return $.jsx(SettingsRow,{label,description:details,control:$.jsx(Toggle,{checked:value,disabled:isLoading,onChange:update,ariaLabel:label})})}${linuxBuildInfoPanelSource()}function LinuxDesktopSettings(){return $.jsx(SettingsPage,{title:${linuxDesktopTitle},subtitle:${linuxDesktopSubtitle},children:$.jsxs("div",{className:"flex flex-col gap-6",children:[$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:${linuxDesktopGlobalShortcuts}}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.promptWindow,label:${linuxDesktopCompactPromptWindow},description:${linuxDesktopCompactPromptWindowDescription}})})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:${linuxDesktopDesktopIntegration}}),$.jsx(SettingsSection.Content,{children:$.jsxs(SettingsGroup,{children:[$.jsx(LinuxToggle,{settingKey:KEYS.systemTray,label:${linuxDesktopSystemTray},description:${linuxDesktopSystemTrayDescription}}),$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:${linuxDesktopWarmStart},description:${linuxDesktopWarmStartDescription}})]})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:${linuxDesktopUpdates}}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:${linuxDesktopAutoUpdateOnExit},description:${linuxDesktopAutoUpdateOnExitDescription}})})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:${linuxDesktopBuildSection}}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxBuildInfoPanel,{})})})]})]})})}export{LinuxDesktopSettings,LinuxDesktopSettings as default};\n//# sourceMappingURL=${linuxDesktopSettingsAsset}.map\n`;
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
    return "n";
  }

  const exportMatch = source.match(/export\{([^}]*)\}/);
  if (exportMatch == null) {
    return "n";
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

  return "n";
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
  const jsxLocal = source.match(/\(0,([A-Za-z_$][\w$]*)\.jsx\)/)?.[1] ?? null;
  const reactLocal = source.match(/\(0,([A-Za-z_$][\w$]*)\.useState\)/)?.[1] ?? null;
  if (jsxLocal == null || reactLocal == null) {
    return null;
  }

  const jsxFactoryLocal = source.match(
    new RegExp(`${escapeRegExp(jsxLocal)}=([A-Za-z_$][\\w$]*)\\(\\)`),
  )?.[1] ?? null;
  const reactFactoryLocal = source.match(
    new RegExp(`${escapeRegExp(reactLocal)}=[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*)\\(\\),1\\)`),
  )?.[1] ?? null;
  if (jsxFactoryLocal == null || reactFactoryLocal == null) {
    return null;
  }

  const bindings = importBindings(source);
  const jsxBinding = bindings.get(jsxFactoryLocal);
  const reactBinding = bindings.get(reactFactoryLocal);
  if (jsxBinding == null || reactBinding == null) {
    return null;
  }

  return {
    jsxRuntimeAsset: jsxBinding.assetName,
    jsxRuntimeExportName: jsxBinding.exportName,
    reactAsset: reactBinding.assetName,
    reactExportName: reactBinding.exportName,
  };
}

function inferMessageComponentDependencyFromSettingsSource(source) {
  const bindings = importBindings(source);
  const messageLocal = source.match(
    /(?:\(0,[A-Za-z_$][\w$]*\.jsx\)|[A-Za-z_$][\w$]*\.jsx)\(([A-Za-z_$][\w$]*),\{id:`[^`]+`,defaultMessage:/,
  )?.[1] ?? null;
  if (messageLocal == null) {
    return null;
  }

  const binding = bindings.get(messageLocal);
  return binding == null
    ? null
    : {
      assetName: binding.assetName,
      exportName: binding.exportName,
    };
}

function findNativeKeyboardShortcutsSettingsAsset(webviewAssetsDir) {
  return fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => /^keyboard-shortcuts-settings-.*\.js$/.test(name))
    .sort()[0] ?? null;
}

function tryFindRequiredWebviewAsset(webviewAssetsDir, namePattern, requiredContent, description) {
  try {
    return findRequiredWebviewAsset(webviewAssetsDir, namePattern, requiredContent, description);
  } catch {
    return null;
  }
}

function linuxSettingsFallbackComponents({ jsxRuntimeAsset, jsxRuntimeExportName }) {
  const jsxImport = `import{${jsxRuntimeExportName} as __jsxFactory}from"./${jsxRuntimeAsset}";var $=__jsxFactory();`;

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

function inferFirstExportName(source, fallback = "t") {
  const exportMatch = source.match(/export\{([^}]*)\}/);
  if (exportMatch == null) {
    return fallback;
  }

  const exportedNames = exportMatch[1].split(",").map((rawExport) => {
    const exportPart = rawExport.trim();
    const aliasedMatch = exportPart.match(/^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/);
    return aliasedMatch?.[1] ?? exportPart;
  }).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));

  return exportedNames.includes(fallback) ? fallback : exportedNames[0] ?? fallback;
}

function inferToggleDependencyFromSettingsSource(source) {
  const bindings = importBindings(source);
  const controlPattern = /control:(?:\(0,[A-Za-z_$][\w$]*\.jsx\)|[A-Za-z_$][\w$]*\.jsx)\(([A-Za-z_$][\w$]*),\{/g;
  let match;
  while ((match = controlPattern.exec(source)) != null) {
    const localName = match[1];
    const sample = source.slice(match.index, match.index + 1000);
    if (!sample.includes("checked:") || !sample.includes("onChange:") || !sample.includes("ariaLabel:")) {
      continue;
    }
    const binding = bindings.get(localName);
    if (binding != null) {
      return {
        assetName: binding.assetName,
        exportName: binding.exportName,
      };
    }
  }
  return null;
}

function resolveSettingsToggleDependency(webviewAssetsDir, fallbackComponents, generatedAssets) {
  const directToggleAsset = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => /^toggle-.*\.js$/.test(name))
    .sort()[0] ?? null;
  if (directToggleAsset != null) {
    const source = fs.readFileSync(path.join(webviewAssetsDir, directToggleAsset), "utf8");
    return {
      assetName: directToggleAsset,
      exportName: inferFirstExportName(source),
    };
  }

  const settingsAssets = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) =>
      name.endsWith(".js") &&
        name.includes("settings") &&
        name !== linuxDesktopSettingsAsset &&
        name !== keybindsSettingsAsset &&
        !name.startsWith("linux-settings-")
    )
    .sort();
  for (const assetName of settingsAssets) {
    const source = fs.readFileSync(path.join(webviewAssetsDir, assetName), "utf8");
    const dependency = inferToggleDependencyFromSettingsSource(source);
    if (dependency != null) {
      return dependency;
    }
  }

  const fallback = fallbackComponents.settingsToggle;
  generatedAssets.push({
    filePath: path.join(webviewAssetsDir, fallback.assetName),
    source: fallback.source,
  });
  return {
    assetName: fallback.assetName,
    exportName: fallback.exportName,
  };
}

function resolveSettingsMessageDependency(webviewAssetsDir) {
  const settingsAssets = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) =>
      name.endsWith(".js") &&
        name.includes("settings") &&
        name !== linuxDesktopSettingsAsset &&
        name !== keybindsSettingsAsset
    )
    .sort();
  for (const assetName of settingsAssets) {
    const source = fs.readFileSync(path.join(webviewAssetsDir, assetName), "utf8");
    const dependency = inferMessageComponentDependencyFromSettingsSource(source);
    if (dependency != null) {
      return dependency;
    }
  }

  return null;
}

function resolveSettingsAssetDependencies(extractedDir, { includeHotkeySettings = true } = {}) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Required Keybinds settings patch failed: missing webview assets directory ${webviewAssetsDir}`);
  }

  let runtimeDependencies = null;
  const nativeKeyboardShortcutsAsset = findNativeKeyboardShortcutsSettingsAsset(webviewAssetsDir);
  if (nativeKeyboardShortcutsAsset != null) {
    const source = fs.readFileSync(path.join(webviewAssetsDir, nativeKeyboardShortcutsAsset), "utf8");
    runtimeDependencies = inferRuntimeDependenciesFromSettingsSource(source);
  }

  let jsxRuntimeAsset;
  let jsxRuntimeExportName;
  let reactAsset;
  let reactExportName;
  if (runtimeDependencies != null) {
    ({
      jsxRuntimeAsset,
      jsxRuntimeExportName,
      reactAsset,
      reactExportName,
    } = runtimeDependencies);
  } else {
    jsxRuntimeAsset = findRequiredWebviewAsset(webviewAssetsDir, /^jsx-runtime-.*\.js$/, "react.transitional.element", "JSX runtime asset");
    const jsxRuntimeSource = fs.readFileSync(path.join(webviewAssetsDir, jsxRuntimeAsset), "utf8");
    const jsxExportsReactFactory = /export\{[^}]*\bn\b/.test(jsxRuntimeSource);
    reactAsset = jsxExportsReactFactory
      ? jsxRuntimeAsset
      : findRequiredWebviewAsset(webviewAssetsDir, /^react-.*\.js$/, "react.transitional.element", "React asset");
    reactExportName = jsxExportsReactFactory ? "n" : "t";
    jsxRuntimeExportName = "t";
  }
  const chunkAsset = findImportedAsset(webviewAssetsDir, reactAsset, "React shared chunk asset");
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
    jsxRuntimeAsset,
    jsxRuntimeExportName,
  });
  const generatedAssets = [];
  const useFallbackComponent = (componentName) => {
    const component = fallbackComponents[componentName];
    generatedAssets.push({
      filePath: path.join(webviewAssetsDir, component.assetName),
      source: component.source,
    });
    return component;
  };

  const settingsRowCandidate = tryFindRequiredWebviewAsset(webviewAssetsDir, /^settings-row-.*\.js$/, null, "settings row asset");
  const settingsRowFallback = settingsRowCandidate == null ? useFallbackComponent("settingsRow") : null;
  const settingsRowAsset = settingsRowCandidate ?? settingsRowFallback.assetName;
  const settingsRowSource = settingsRowCandidate == null
    ? settingsRowFallback.source
    : fs.readFileSync(path.join(webviewAssetsDir, settingsRowAsset), "utf8");
  const settingsLayoutCandidate = tryFindRequiredWebviewAsset(
    webviewAssetsDir,
    /^settings-content-layout-.*\.js$/,
    null,
    "settings content layout asset",
  );
  const settingsLayoutFallback = settingsLayoutCandidate == null ? useFallbackComponent("settingsPage") : null;
  const settingsLayoutAsset = settingsLayoutCandidate ?? settingsLayoutFallback.assetName;
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
  const toggleDependency = resolveSettingsToggleDependency(webviewAssetsDir, fallbackComponents, generatedAssets);
  const messageDependency = resolveSettingsMessageDependency(webviewAssetsDir);

  return {
    chunkAsset,
    reactAsset,
    reactExportName,
    jsxRuntimeAsset,
    jsxRuntimeExportName,
    vscodeApiAsset,
    vscodeApiExportName,
    hotkeySettingsAsset,
    settingsRowAsset,
    settingsRowExportName: inferSettingsRowExportName(settingsRowSource),
    settingsPageAsset: settingsLayoutAsset,
    settingsPageExportName: settingsLayoutFallback == null ? "t" : settingsLayoutFallback.exportName,
    settingsSectionAsset: settingsGroupCandidate ?? settingsSectionFallback.assetName,
    settingsSectionExportName: settingsGroupCandidate == null ? settingsSectionFallback.exportName : "t",
    settingsGroupAsset: settingsSurfaceCandidate ?? settingsGroupFallback.assetName,
    settingsGroupExportName: settingsSurfaceCandidate == null ? settingsGroupFallback.exportName : "t",
    toggleAsset: toggleDependency.assetName,
    toggleExportName: toggleDependency.exportName,
    messageAsset: messageDependency?.assetName ?? null,
    messageExportName: messageDependency?.exportName ?? null,
    generatedAssets,
  };
}

function resolveKeybindsSettingsAsset(extractedDir) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  const dependencies = resolveSettingsAssetDependencies(extractedDir);

  return {
    filePath: path.join(webviewAssetsDir, keybindsSettingsAsset),
    source: buildKeybindsSettingsSource(dependencies),
    generatedAssets: dependencies.generatedAssets,
  };
}

function resolveLinuxDesktopSettingsAsset(extractedDir) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  const dependencies = resolveSettingsAssetDependencies(extractedDir, {
    includeHotkeySettings: false,
  });

  return {
    filePath: path.join(webviewAssetsDir, linuxDesktopSettingsAsset),
    source: buildLinuxDesktopSettingsSource(dependencies),
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`WARN: Optional Keybinds settings patch skipped for ${candidate}: ${message}`);
    }
  }

  return patches;
}
function collectLinuxDesktopSettingsAssetPatches(extractedDir) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Required Keybinds settings patch failed: missing webview assets directory ${webviewAssetsDir}`);
  }

  const candidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => name.endsWith(".js"))
    .sort();

  let routeMatched = false;
  let navigationMatched = false;
  const patches = [];
  for (const candidate of candidates) {
    const filePath = path.join(webviewAssetsDir, candidate);
    const currentSource = fs.readFileSync(filePath, "utf8");
    const hasSectionsMetadata = isSettingsSectionsMetadataBundleSource(currentSource);
    const hasSharedMetadata = isSettingsSharedMetadataBundleSource(currentSource);
    const isRouteCandidate =
      /^(?:(?:app-main|index)-|app-initial~app-main~).*\.js$/.test(candidate) ||
      /settings-page.*\.js$/.test(candidate);
    const hasRouteBundle = isRouteCandidate && isSettingsRouteBundleSource(currentSource);
    const hasNavigationBundle = isRouteCandidate && isSettingsNavigationBundleSource(currentSource);
    let patchedSource = currentSource;
    if (hasSectionsMetadata) {
      try {
        patchedSource = applyLinuxDesktopSettingsSectionsPatch(patchedSource);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`WARN: Optional Keybinds settings patch skipped for ${candidate}: ${message}`);
      }
    }
    if (hasSharedMetadata) {
      try {
        patchedSource = applyLinuxDesktopSettingsSharedPatch(patchedSource);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`WARN: Optional Keybinds settings patch skipped for ${candidate}: ${message}`);
      }
    }
    if (hasRouteBundle) {
      routeMatched = true;
      patchedSource = applyLinuxDesktopSettingsRoutePatch(patchedSource);
    }
    if (hasNavigationBundle) {
      navigationMatched = true;
      patchedSource = applyLinuxDesktopSettingsNavigationPatch(patchedSource);
    }
    if (patchedSource !== currentSource) {
      patches.push({ filePath, currentSource, patchedSource });
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

function upsertLocaleMessageEntry(currentSource, key, value, anchorKey) {
  const entrySource = `"${key}":\`${value}\`,`;
  const keyPrefix = `"${key}":\``;
  const existingIndex = currentSource.indexOf(keyPrefix);
  if (existingIndex !== -1) {
    const existingValueEnd = currentSource.indexOf("`", existingIndex + keyPrefix.length);
    if (existingValueEnd === -1) {
      throw new Error(`could not update locale message ${key}`);
    }
    const existingHasComma = currentSource[existingValueEnd + 1] === ",";
    return currentSource.slice(0, existingIndex)
      + entrySource
      + currentSource.slice(existingValueEnd + (existingHasComma ? 2 : 1));
  }

  const anchorPrefix = `"${anchorKey}":\``;
  const anchorIndex = currentSource.indexOf(anchorPrefix);
  if (anchorIndex === -1) {
    throw new Error(`could not add locale message ${key}`);
  }
  const anchorValueEnd = currentSource.indexOf("`", anchorIndex + anchorPrefix.length);
  if (anchorValueEnd === -1) {
    throw new Error(`could not add locale message ${key}`);
  }
  const anchorHasComma = currentSource[anchorValueEnd + 1] === ",";

  if (anchorHasComma) {
    return currentSource.slice(0, anchorValueEnd + 2)
      + entrySource
      + currentSource.slice(anchorValueEnd + 2);
  }

  return currentSource.slice(0, anchorValueEnd + 1)
    + ","
    + entrySource
    + currentSource.slice(anchorValueEnd + 1);
}

function applyLinuxDesktopLocaleAssetPatch(currentSource, value = "Рабочий стол Linux") {
  let patched = currentSource;
  for (const [key, entryValue, anchorKey] of linuxDesktopRendererMessageEntries) {
    patched = upsertLocaleMessageEntry(
      patched,
      key,
      key === "settings.nav.linux-desktop" || key === "settings.section.linux-desktop"
        ? value
        : entryValue,
      anchorKey,
    );
  }
  return patched;
}

function collectLinuxDesktopLocaleAssetPatches(extractedDir) {
  return collectOptionalAssetPatches(
    extractedDir,
    /^ru-RU-.*\.js$/,
    (source) => applyLinuxDesktopLocaleAssetPatch(source),
  );
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
    const patches = [
      ...collectLinuxDesktopSettingsAssetPatches(extractedDir),
      ...collectLinuxDesktopLocaleAssetPatches(extractedDir),
    ];

    const generatedWrites = (settingsAsset.generatedAssets ?? []).filter((generatedAsset) =>
      !fs.existsSync(generatedAsset.filePath) ||
        fs.readFileSync(generatedAsset.filePath, "utf8") !== generatedAsset.source
    );
    for (const generatedAsset of generatedWrites) {
      fs.writeFileSync(generatedAsset.filePath, generatedAsset.source, "utf8");
    }
    fs.writeFileSync(settingsAsset.filePath, settingsAsset.source, "utf8");
    let changed = generatedWrites.length + (previousSettingsSource !== settingsAsset.source ? 1 : 0);
    for (const patch of patches) {
      if (patch.patchedSource !== patch.currentSource) {
        fs.writeFileSync(patch.filePath, patch.patchedSource, "utf8");
        changed += 1;
      }
    }
    return {
      matched: true,
      changed,
      reason: "upstream keyboard shortcuts settings are present; added Linux desktop settings",
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

  if (
    patchedSource.includes("slug:`linux-desktop`") &&
    (/=\[`general-settings`,`linux-desktop`/.test(patchedSource)
      || /`general-settings\.linux-desktop\.[^`]*`\.split\(`\.`\)/.test(patchedSource))
  ) {
    return patchedSource;
  }

  if (!/=\[`general-settings`,`linux-desktop`/.test(patchedSource)) {
    const orderPattern = /([A-Za-z_$][\w$]*=\[`general-settings`,)(?!`linux-desktop`)/;
    if (orderPattern.test(patchedSource)) {
      patchedSource = patchedSource.replace(orderPattern, "$1`linux-desktop`,");
    }
  }

  if (!/`general-settings\.linux-desktop\.[^`]*`\.split\(`\.`\)/.test(patchedSource)) {
    const splitOrderPattern = /(`general-settings\.)(?!linux-desktop\.)([^`]*keyboard-shortcuts[^`]*`\.split\(`\.`\))/;
    if (splitOrderPattern.test(patchedSource)) {
      patchedSource = patchedSource.replace(splitOrderPattern, "$1linux-desktop.$2");
    }
  }

  if (!patchedSource.includes("slug:`linux-desktop`")) {
    const sectionsNeedle = "var e=`general-settings`,t=`mcp-settings`,n=[{slug:e},";
    const sectionsPatch = "var e=`general-settings`,t=`mcp-settings`,n=[{slug:e},{slug:`linux-desktop`},";
    if (patchedSource.includes(sectionsNeedle)) {
      patchedSource = patchedSource.replace(sectionsNeedle, sectionsPatch);
    } else {
      const currentNeedle = "n=[{slug:e},{slug:`appearance`}";
      if (patchedSource.includes(currentNeedle)) {
        patchedSource = patchedSource.replace(currentNeedle, "n=[{slug:e},{slug:`linux-desktop`},{slug:`appearance`}");
      } else {
        const literalNeedle = "n=[{slug:`general-settings`},{slug:`appearance`}";
        if (patchedSource.includes(literalNeedle)) {
          patchedSource = patchedSource.replace(literalNeedle, "n=[{slug:`general-settings`},{slug:`linux-desktop`},{slug:`appearance`}");
        } else {
          const generalFirstPattern = /([A-Za-z_$][\w$]*=\[\{slug:(?:`general-settings`|[A-Za-z_$][\w$]*)\},)/;
          if (generalFirstPattern.test(patchedSource)) {
            patchedSource = patchedSource.replace(generalFirstPattern, "$1{slug:`linux-desktop`},");
          }
        }
      }
    }
  }

  if (
    patchedSource.includes("slug:`linux-desktop`") &&
    (/=\[`general-settings`,`linux-desktop`/.test(patchedSource) || !/[A-Za-z_$][\w$]*=\[`general-settings`,/.test(currentSource))
  ) {
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
function injectSettingsSectionTitle(currentSource, {
  slug,
  defaultMessage,
  defaultMessageExpression,
  description,
}) {
  const generalCasePattern =
    /case`general-settings`:\{let ([A-Za-z_$][\w$]*);return ([A-Za-z_$][\w$]*)\[(\d+)\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\1=\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{id:`settings\.section\.general-settings`,defaultMessage:`General`,description:`Title for general settings section`\}\),\2\[\3\]=\1\):\1=\2\[\3\],\1\}/;
  const match = currentSource.match(generalCasePattern);
  if (match == null) {
    return null;
  }
  const matchedBlock = match[0];
  const jsxFactory = match[4];
  const messageComponent = match[5];
  const defaultMessageSource = typeof defaultMessageExpression === "string"
    ? defaultMessageExpression
    : `\`${defaultMessage}\``;
  const injectedCase =
    `case\`${slug}\`:{return (0,${jsxFactory}.jsx)(${messageComponent},`
    + `{id:\`settings.section.${slug}\`,defaultMessage:${defaultMessageSource},description:\`${description}\`})}`;
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

  const linuxDesktopNavPattern =
    /"linux-desktop":\{id:`settings\.nav\.linux-desktop`,defaultMessage:(?:`Linux desktop`|codexLinuxDesktopLabelText\(\)),description:`Title for Linux desktop settings section`\},?/;
  if (linuxDesktopNavPattern.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      linuxDesktopNavPattern,
      '"linux-desktop":{id:`settings.nav.linux-desktop`,defaultMessage:`Linux desktop`,description:`Title for Linux desktop settings section`},',
    );
  } else if (!patchedSource.includes("settings.nav.linux-desktop")) {
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
  } else {
    patchedSource = patchedSource.replace(
      /case`linux-desktop`:\{return \(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{id:`settings\.section\.linux-desktop`,defaultMessage:(?:`Linux desktop`|codexLinuxDesktopLabelText\(\)),description:`Title for Linux desktop settings section`\}\)\}/,
      "case`linux-desktop`:{return (0,$1.jsx)($2,{id:`settings.section.linux-desktop`,defaultMessage:`Linux desktop`,description:`Title for Linux desktop settings section`})}",
    );
  }

  return patchedSource;
}

function applyLinuxKeybindOverridesRuntimePatch(currentSource) {
  const runtimePatch = `;function codexLinuxKeybindOverridesRuntime(){try{if(typeof window=="undefined")return;let storageKey=${JSON.stringify(linuxKeybindOverridesKey)},defaultMap=typeof Ct=="object"&&Ct?Ct:{},overrides={};function loadOverrides(){try{let value=JSON.parse(localStorage.getItem(storageKey)||"{}");overrides=value&&typeof value=="object"&&!Array.isArray(value)?value:{}}catch{overrides={}}}function isShortcutCaptureTarget(event){let target=event.target;return target instanceof Element&&target.closest("[data-codex-keybind-input]")!=null}function normalizeKeyName(key){let map={Space:" ",Esc:"Escape",Up:"ArrowUp",Down:"ArrowDown",Left:"ArrowLeft",Right:"ArrowRight",Plus:"+",Comma:",",Period:".",Slash:"/"};return map[key]??(/^.$/.test(key)?key.toUpperCase():key)}function parseAccelerator(accelerator){if(typeof accelerator!="string"||accelerator.trim().length===0)return null;let isMac=/Mac/.test(navigator.platform||""),parts=accelerator.split("+").map(part=>part.trim()).filter(Boolean),parsed={ctrl:false,alt:false,shift:false,meta:false,key:null};for(let part of parts){switch(part){case"CmdOrCtrl":isMac?parsed.meta=true:parsed.ctrl=true;break;case"Command":case"Cmd":case"Meta":case"Super":case"Win":parsed.meta=true;break;case"Control":case"Ctrl":parsed.ctrl=true;break;case"Alt":case"Option":parsed.alt=true;break;case"Shift":parsed.shift=true;break;default:parsed.key=normalizeKeyName(part);break}}return parsed.key?parsed:null}function matches(event,parsed){return event.ctrlKey===parsed.ctrl&&event.altKey===parsed.alt&&event.shiftKey===parsed.shift&&event.metaKey===parsed.meta&&normalizeKeyName(event.key)===parsed.key}function dispatchHost(message){if(typeof E=="object"&&E&&typeof E.dispatchHostMessage=="function"){E.dispatchHostMessage(message);return true}return false}function dispatchElectron(type,params={}){if(typeof E=="object"&&E&&typeof E.dispatchMessage=="function"){E.dispatchMessage(type,params);return true}return false}let hostActionTypes={newThread:"new-chat",quickChat:"new-quick-chat",newThreadAlt:"new-chat",toggleSidebar:"toggle-sidebar",toggleTerminal:"toggle-terminal",toggleBrowserPanel:"toggle-browser-panel",toggleDiffPanel:"toggle-diff-panel",findInThread:"find-in-thread",navigateBack:"navigate-back",navigateForward:"navigate-forward",previousThread:"previous-thread",nextThread:"next-thread",copyConversationPath:"copy-conversation-path",toggleThreadPin:"toggle-thread-pin",renameThread:"rename-thread",archiveThread:"archive-thread",copyWorkingDirectory:"copy-working-directory",copySessionId:"copy-session-id",copyDeeplink:"copy-deeplink",toggleFileTreePanel:"toggle-file-tree-panel"};function runAction(id){if(/^thread[1-9]$/.test(id))return dispatchHost({type:"go-to-thread-index",index:Number(id.slice(6))-1});switch(id){case"openCommandMenu":case"openCommandMenuAlt":return dispatchHost({type:"command-menu",query:""});case"searchChats":return dispatchHost({type:"chat-search-command-menu"});case"searchFiles":return dispatchHost({type:"file-search-command-menu"});case"openFolder":return dispatchElectron("electron-create-new-workspace-root-option",{});case"settings":return dispatchElectron("show-settings",{section:"general-settings"});case"openBrowserTab":return dispatchHost({type:"browser-sidebar-command",command:{type:"new-tab"}});case"reloadBrowserPage":return dispatchHost({type:"browser-sidebar-command",command:{type:"reload"}});case"hardReloadBrowserPage":return dispatchHost({type:"browser-sidebar-command",command:{type:"hard-reload"}});case"dictation":return dispatchElectron("global-dictation-start",{});default:return hostActionTypes[id]?dispatchHost({type:hostActionTypes[id]}):false}}loadOverrides();window.addEventListener("storage",event=>{event.key===storageKey&&loadOverrides()});window.addEventListener("codex-linux-keybind-overrides-changed",loadOverrides);window.addEventListener("keydown",event=>{if(event.defaultPrevented||event.repeat||isShortcutCaptureTarget(event))return;for(let[id,accelerator]of Object.entries(overrides)){if(typeof accelerator!="string"||accelerator.trim().length===0||accelerator.trim()===(defaultMap[id]||""))continue;let parsed=parseAccelerator(accelerator);if(parsed&&matches(event,parsed)&&runAction(id)){event.preventDefault();event.stopPropagation();break}}},true)}catch{}}codexLinuxKeybindOverridesRuntime();`;

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
  // Only treat a chunk as the route map when general-settings is wired to a lazy
  // page component (or the Linux desktop route is already present). The previous
  // `"general-settings":ID,...,"keyboard-shortcuts":ID` heuristic also matched the
  // icon map (slug -> SVG component), which caused the route patch to inject the
  // settings page component as a navigation icon and render a broken nav entry.
  return currentSource.includes(linuxDesktopSettingsAsset)
    || /"general-settings":\(0,[A-Za-z_$][\w$]*\.lazy\)\(\(\)=>[A-Za-z_$][\w$]*\(/.test(currentSource);
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

function applyLinuxDesktopSettingsRoutePatch(currentSource) {
  let patchedSource = currentSource;

  if (!patchedSource.includes(`${linuxDesktopSettingsAsset}`)) {
    // The route map is `var X={...}` in older bundles but a bare `X={...}` inside an
    // IIFE body (`...,X={"general-settings":(0,Y.lazy)(...)`) in newer split chunks,
    // so the `var` keyword is optional and preserved when present.
    const routePattern = /(var )?([A-Za-z_$][\w$]*)=\{([^;]*?)"general-settings":(?=\(0,([A-Za-z_$][\w$]*)\.lazy\)\(\(\)=>([A-Za-z_$][\w$]*)\()/;
    const directRoutePattern = /((?:var )?[A-Za-z_$][\w$]*=\{)([^;}]*?)"general-settings":(?=[A-Za-z_$][\w$]*,)/;
    // A navigation/icon bundle (it carries the `slugs:[`general-settings`,...]`
    // group array) also exposes a `{"general-settings":ID,...}` map, but those IDs
    // are SVG icon components, not route targets. Never apply the direct-route
    // fallback there or the page component is injected as a nav icon.
    const isNavigationBundle = /slugs:\[`general-settings`/.test(patchedSource);
    if (routePattern.test(patchedSource)) {
      patchedSource = patchedSource.replace(
        routePattern,
        (_match, varKeyword, routeMap, beforeGeneralSettings, lazyAlias, preloadAlias) =>
          `${varKeyword ?? ""}${routeMap}={"linux-desktop":(0,${lazyAlias}.lazy)(()=>${preloadAlias}(()=>import(\`./${linuxDesktopSettingsAsset}\`),[],import.meta.url)),${beforeGeneralSettings}"general-settings":`,
      );
    } else if (!isNavigationBundle && directRoutePattern.test(patchedSource)) {
      patchedSource = `import{LinuxDesktopSettings as codexLinuxDesktopSettings}from"./${linuxDesktopSettingsAsset}";${patchedSource}`;
      patchedSource = patchedSource.replace(
        directRoutePattern,
        (_match, prefix, beforeGeneralSettings) =>
          `${prefix}"linux-desktop":codexLinuxDesktopSettings,${beforeGeneralSettings}"general-settings":`,
      );
    } else {
      throw new Error("Required Keybinds settings patch failed: could not add Linux desktop route");
    }
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
  applyLinuxDesktopLocaleAssetPatch,
  applyLinuxDesktopSettingsNavigationPatch,
  applyLinuxDesktopSettingsRoutePatch,
  applyLinuxDesktopSettingsSectionsPatch,
  applyLinuxDesktopSettingsSharedPatch,
  applyLinuxKeybindOverridesRuntimePatch,
  keybindsSettingsAsset,
  linuxDesktopSettingsAsset,
  linuxKeybindOverridesKey,
  patchKeybindsSettingsAssets,
  resolveLinuxDesktopSettingsAsset,
  resolveKeybindsSettingsAsset,
};
