"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks, listWebviewScriptAssets } = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const DEVICE_KEY_CLIENT_MARKER = "codexLinuxRemoteControlDeviceKeyClient";
const DEVICE_KEY_IDENT = "[A-Za-z_$][\\w$]*";

const DEVICE_KEY_ADDON_MARKER = "codexLinuxRemoteControlDeviceKeyAddon";

// The upstream base provider routes every public method through getAddon();
// its subclass serializes and validates signing payloads itself before
// signBytes() hands the bytes to the addon. Linux keeps both classes and only
// replaces the native addon of the subclass instance.
function deviceKeyProviderPattern(flags = "u") {
  return new RegExp(
    `class (?<baseClass>${DEVICE_KEY_IDENT})\\{resourcesPath;addon=null;` +
      `constructor\\((?<constructorArg>${DEVICE_KEY_IDENT})\\)\\{this\\.resourcesPath=\\k<constructorArg>\\}` +
      `createDeviceKey\\((?<createArg>${DEVICE_KEY_IDENT})\\)\\{return this\\.getAddon\\(\\)\\.createDeviceKey\\(\\k<createArg>\\?\\?"hardware_only"\\)\\}` +
      `deleteDeviceKey\\((?<deleteArg>${DEVICE_KEY_IDENT})\\)\\{return this\\.getAddon\\(\\)\\.deleteDeviceKey\\(\\k<deleteArg>\\)\\}` +
      `getDeviceKeyPublic\\((?<publicArg>${DEVICE_KEY_IDENT})\\)\\{return this\\.getAddon\\(\\)\\.getDeviceKeyPublic\\(\\k<publicArg>\\)\\}` +
      `signBytes\\((?<bytesKeyArg>${DEVICE_KEY_IDENT}),(?<bytesArg>${DEVICE_KEY_IDENT})\\)\\{return this\\.getAddon\\(\\)\\.signDeviceKey\\(\\k<bytesKeyArg>,\\k<bytesArg>\\)\\}` +
      `getAddon\\(\\)\\{if\\(null==this\\.resourcesPath\\)throw Error` +
      `\\("Device keys require resourcesPath"\\);return null==this\\.addon&&\\(this\\.addon=` +
      `${DEVICE_KEY_IDENT}\\.parse\\(${DEVICE_KEY_IDENT}\\([^;]{0,300}?"remote-control-device-key\\.node"\\)\\)\\)\\),this\\.addon\\}\\}` +
      `(?:let ${DEVICE_KEY_IDENT}=/[^/\\n]{1,120}/u;)?` +
      `class (?<providerClass>${DEVICE_KEY_IDENT}) extends \\k<baseClass>\\{` +
      `async signDeviceKey\\((?<keyArg>${DEVICE_KEY_IDENT}),(?<payloadArg>${DEVICE_KEY_IDENT})\\)\\{` +
      `(?:(?!getAddon|class )[\\s\\S]){0,4000}?"codex-device-key-sign-payload/v1"(?:(?!getAddon|class )[\\s\\S]){0,4000}?` +
      `return\\{\\.\\.\\.await this\\.signBytes\\(\\k<keyArg>,(?<serializedPayloadVar>${DEVICE_KEY_IDENT})\\),` +
      `signedPayloadBase64:\\k<serializedPayloadVar>\\.toString\\("base64"\\)\\}\\}\\}`,
    flags,
  );
}
const REMOTE_CONTROL_OUTBOUND_TAB_GATE_MARKER = "codexLinuxRemoteControlOutboundTabGate";
const REMOTE_CONNECTIONS_REFRESH_MARKER = "codexLinuxRemoteConnectionsRefreshNow";
const REMOTE_CONTROL_LOAD_GATE_MARKER = "codexLinuxRemoteControlLoadGateEnabled";
const REMOTE_CONTROL_FEATURE_SYNC_MARKER = "codexLinuxRemoteControlFeatureSyncEnabled";
// The remote-control environment loader asks a Statsig gate hook, reached
// through a module import binding: `function p(){return(0,o.Zj)("1042620455")}`.
const REMOTE_CONTROL_LOAD_GATE_NEEDLE =
  /function ([A-Za-z_$][\w$]*)\(\)\{return\(0,([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\)\("1042620455"\)\}/gu;
const REMOTE_CONTROL_LOAD_GATE_PATCHED =
  /function ([A-Za-z_$][\w$]*)\(\)\{return codexLinuxRemoteControlLoadGateEnabled\(\)\|\|\(0,([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\)\("1042620455"\)\}function codexLinuxRemoteControlLoadGateEnabled\(\)\{/gu;
const REMOTE_MOBILE_REASONING_SUMMARY_MARKER = "codexLinuxRemoteMobileReasoningSummaryNone";
const REMOTE_MOBILE_CONVERSATION_HYDRATION_MARKER =
  "codexLinuxRemoteMobileConversationHydration";
const REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER = "codexLinuxRemoteControlEnablementBridge";
const REMOTE_CONTROL_ENABLE_FOR_HOST_PARAMS_MARKER = "codexLinuxRemoteControlEnableForHostParams";
const REMOTE_CONTROL_AUTO_CONNECT_CLEANUP_MARKER = "codexLinuxRemoteControlAutoConnectCleanup";
const REMOTE_MOBILE_ACTIVE_STATUS_MARKER = "codexLinuxRemoteMobileActiveStatus";
const REMOTE_CONTROL_STATUS_READ_GUARD_MARKER = "codexLinuxRemoteControlShouldReadStatus";
const REMOTE_CONTROL_STATUS_WAIT_MARKER = "codexLinuxRemoteControlStatusWaitMs";
const REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER = "codexLinuxRemoteControlResetMobileSetupAfterRevoke";
const REMOTE_CONTROL_VISIBILITY_MARKER = "codexLinuxRemoteControlVisibilityEnabled";
const REMOTE_CONTROL_UI_VISIBILITY_MARKER = "codexLinuxRemoteControlUiVisibilityEnabled";
const REMOTE_CONTROL_COPY_MARKER = "codexLinuxRemoteControlCopy";
const REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER = "codexLinuxRemoteMobileLocalAppServerArgs";
const REMOTE_MOBILE_APP_SERVER_BASE_ARGS_NEEDLE = '["-c","features.code_mode_host=true"]';
const REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_HELPER =
  "function codexLinuxRemoteMobileLocalAppServerArgs(e,t){if(process.env.CODEX_REMOTE_CONTROL_APP_SERVER_MODE===`proxy`){let n=process.env.CODEX_REMOTE_CONTROL_APP_SERVER_PROXY_SOCKET;if(n?.startsWith(`%h/`)&&process.env.HOME)n=`${process.env.HOME}${n.slice(2)}`;return[...e,...t,`app-server`,`proxy`,...(n?[`--sock`,n]:[])]}return t.length===0?[...e,`app-server`,`--remote-control`,`--analytics-default-enabled`]:[`app-server`,...e,...t,`--remote-control`,`--analytics-default-enabled`]}";
// Startup checks (`--print-startup-config`) are one-shot runs; app-server
// rejects them together with `--remote-control` or the `proxy` subcommand.
const REMOTE_MOBILE_APP_SERVER_STARTUP_GUARD_MARKER = "codexLinuxStartupCommandAppServerArgs";
const REMOTE_MOBILE_APP_SERVER_STARTUP_GUARD_HELPER =
  "function codexLinuxStartupCommandAppServerArgs(e,t){if(t==null||process.platform!==`linux`)return e;let n=e.indexOf(`app-server`);return n>=0&&e[n+1]===`proxy`?[...e.slice(0,n),`app-server`,`--analytics-default-enabled`]:e.filter(e=>e!==`--remote-control`)}";
const REMOTE_MOBILE_APP_SERVER_STARTUP_ARGS_PATTERN =
  /\.\.\.([A-Za-z_$][\w$]*)\.args,\.\.\.([A-Za-z_$][\w$]*)\.startupCommand\?\.args\?\?\[\]/gu;
const REMOTE_CONTROL_LINUX_COPY_REPLACEMENTS = [
  ["Keep this Mac awake", "Keep this Linux desktop awake"],
  ["Devices that can control this Mac", "Devices that can control this Linux desktop"],
  ["Control this Mac from your phone or other device", "Control this Linux desktop from your phone or other device"],
  ["Add device to control this Mac remotely", "Add device to control this Linux desktop remotely"],
  ["Control other devices from this Mac", "Control other devices from this Linux desktop"],
  ["Authorize this Mac to control other devices signed in to your ChatGPT account", "Authorize this Linux desktop to control other devices signed in to your ChatGPT account"],
  ["Allow this Mac to be discovered and controlled", "Allow this Linux desktop to be discovered and controlled"],
  ["Control this Mac", "Control this Linux desktop"],
  ["Devices you can control from this Mac", "Devices you can control from this Linux desktop"],
  ["SSH connections from this Mac", "SSH connections from this Linux desktop"],
  ["Use your Mac apps while locked", "Use your Linux apps while locked"],
  ["Control Mac apps from your phone", "Control Linux apps from your phone"],
  ["Let Codex control the apps on your Mac.", "Let Codex control apps on this Linux desktop."],
  ["Let Codex control the apps on your Mac", "Let Codex control apps on this Linux desktop"],
  ["Let ChatGPT control apps on your Mac", "Let ChatGPT control apps on this Linux desktop"],
  ["connected to ChatGPT on a Mac", "connected to ChatGPT on this Linux desktop"],
  ["Connect a device to this Mac", "Connect a device to this Linux desktop"],
  ["Connect your phone to this Mac", "Connect your phone to this Linux desktop"],
  ["Add device to control this Mac remotely", "Add a device to control this Linux desktop remotely"],
  ["Keep Mac awake", "Keep Linux desktop awake"],
  ["this Mac", "this Linux desktop"],
  ["local Mac", "local Linux desktop"],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceOnce(source, needle, replacement) {
  if (!source.includes(needle)) {
    return null;
  }
  return source.replace(needle, replacement);
}

function linuxDeviceKeyProviderSource({ childProcessVar, cryptoVar, fsVar, pathVar }) {
  return [
    `const ${pathVar}=require(\`node:path\`),${fsVar}=require(\`node:fs\`),${cryptoVar}=require(\`node:crypto\`),${childProcessVar}=require(\`node:child_process\`);`,
    "const codexLinuxRemoteControlKeyStoreVersion=2,codexLinuxRemoteControlKeyStoreMaxBytes=1048576,codexLinuxRemoteControlKeyStoreMaxKeys=64;",
    "function codexLinuxRemoteControlAssertOwnedRegularStat(e){if(!e.isFile())throw Error(`Linux remote control key state must be a regular file`);if(typeof process.getuid==`function`&&e.uid!==process.getuid())throw Error(`Linux remote control key state is owned by another user`);if((e.mode&511)!==384)throw Error(`Linux remote control key state permissions must be 0600`);return e}",
    "function codexLinuxRemoteControlAssertOwnedRegularFile(e,t){let n=t.lstatSync(e);if(n.isSymbolicLink())throw Error(`Linux remote control key state must be a regular file`);return codexLinuxRemoteControlAssertOwnedRegularStat(n)}",
    "function codexLinuxRemoteControlDeviceKeyStorePath(){",
    `let codexLinuxRemoteControlConfigRoot=process.env.XDG_CONFIG_HOME&&process.env.XDG_CONFIG_HOME.trim()?process.env.XDG_CONFIG_HOME.trim():process.env.HOME?${pathVar}.join(process.env.HOME,\`.config\`):null;`,
    "if(codexLinuxRemoteControlConfigRoot==null)throw Error(`Linux remote control device keys require HOME or XDG_CONFIG_HOME`);",
    `if(!${pathVar}.isAbsolute(codexLinuxRemoteControlConfigRoot))throw Error(\`Linux remote control device key config root must be absolute\`);`,
    `let codexLinuxRemoteControlSharedConfigDirectory=${pathVar}.join(codexLinuxRemoteControlConfigRoot,\`codex-desktop\`);${fsVar}.mkdirSync(codexLinuxRemoteControlSharedConfigDirectory,{recursive:!0});`,
    `let codexLinuxRemoteControlSharedConfigDirectoryStat=${fsVar}.lstatSync(codexLinuxRemoteControlSharedConfigDirectory);if(codexLinuxRemoteControlSharedConfigDirectoryStat.isSymbolicLink()||!codexLinuxRemoteControlSharedConfigDirectoryStat.isDirectory())throw Error(\`Linux remote control shared config path must be a regular directory\`);`,
    "if(typeof process.getuid==`function`&&codexLinuxRemoteControlSharedConfigDirectoryStat.uid!==process.getuid())throw Error(`Linux remote control shared config directory is owned by another user`);",
    `let codexLinuxRemoteControlKeyStoreDirectory=${pathVar}.join(codexLinuxRemoteControlSharedConfigDirectory,\`remote-control-device-keys\`);${fsVar}.mkdirSync(codexLinuxRemoteControlKeyStoreDirectory,{recursive:!0,mode:448});`,
    `let codexLinuxRemoteControlKeyStoreDirectoryStat=${fsVar}.lstatSync(codexLinuxRemoteControlKeyStoreDirectory);if(codexLinuxRemoteControlKeyStoreDirectoryStat.isSymbolicLink()||!codexLinuxRemoteControlKeyStoreDirectoryStat.isDirectory())throw Error(\`Linux remote control device key directory must be a regular directory\`);`,
    "if(typeof process.getuid==`function`&&codexLinuxRemoteControlKeyStoreDirectoryStat.uid!==process.getuid())throw Error(`Linux remote control device key directory is owned by another user`);",
    "if((codexLinuxRemoteControlKeyStoreDirectoryStat.mode&511)!==448)throw Error(`Linux remote control device key directory permissions must be 0700`);",
    `let codexLinuxRemoteControlKeyStorePath=${pathVar}.join(codexLinuxRemoteControlKeyStoreDirectory,\`remote-control-device-keys-v1.json\`),codexLinuxRemoteControlLegacyKeyStorePath=${pathVar}.join(codexLinuxRemoteControlSharedConfigDirectory,\`remote-control-device-keys-v1.json\`);`,
    `if(!${fsVar}.existsSync(codexLinuxRemoteControlKeyStorePath)&&${fsVar}.existsSync(codexLinuxRemoteControlLegacyKeyStorePath)){let codexLinuxRemoteControlLegacyKeyStoreStat=codexLinuxRemoteControlAssertOwnedRegularFile(codexLinuxRemoteControlLegacyKeyStorePath,${fsVar});if(codexLinuxRemoteControlLegacyKeyStoreStat.size>codexLinuxRemoteControlKeyStoreMaxBytes)throw Error(\`Linux remote control device key store exceeds size limit\`);${fsVar}.renameSync(codexLinuxRemoteControlLegacyKeyStorePath,codexLinuxRemoteControlKeyStorePath)}`,
    "return codexLinuxRemoteControlKeyStorePath",
    "}",
    "function codexLinuxRemoteControlValidateDeviceKeyRecord(e,t){if(e==null||typeof e!=`object`||Array.isArray(e))throw Error(`Linux remote control device key record is invalid`);let n=[[e.keyId,128],[e.publicKeySpkiDerBase64,8192],[e.createdAt,64]],r=typeof e.privateKeyPkcs8Pem==`string`&&e.privateKeyPkcs8Pem.length>0&&e.privateKeyPkcs8Pem.length<=16384,i=typeof e.privateKeyCiphertextBase64==`string`&&e.privateKeyCiphertextBase64.length>0&&e.privateKeyCiphertextBase64.length<=32768,a=e.storageBackend==null||typeof e.storageBackend==`string`&&e.storageBackend.length>0&&e.storageBackend.length<=64,o=e.detectedBackend==null||typeof e.detectedBackend==`string`&&e.detectedBackend.length>0&&e.detectedBackend.length<=64;if(n.some(([e,t])=>typeof e!=`string`||e.length===0||e.length>t)||(!r&&!i)||r&&i||!a||!o||e.keyId!==t||e.algorithm!==`ecdsa_p256_sha256`||e.protectionClass!==`os_protected_nonextractable`||!Number.isFinite(Date.parse(e.createdAt)))throw Error(`Linux remote control device key record is invalid`)}",
    "function codexLinuxRemoteControlValidateDeviceKeyStore(e){if(e==null||typeof e!=`object`||Array.isArray(e)||e.version!==codexLinuxRemoteControlKeyStoreVersion||e.keys==null||typeof e.keys!=`object`||Array.isArray(e.keys))throw Error(`Linux remote control device key store schema is invalid`);let t=Object.entries(e.keys);if(t.length>codexLinuxRemoteControlKeyStoreMaxKeys)throw Error(`Linux remote control device key store exceeds key limit`);for(let[n,r]of t)codexLinuxRemoteControlValidateDeviceKeyRecord(r,n);return e}",
    "function codexLinuxRemoteControlPublicDeviceKey(codexLinuxRemoteControlKeyRecord){",
    "return{algorithm:codexLinuxRemoteControlKeyRecord.algorithm,keyId:codexLinuxRemoteControlKeyRecord.keyId,protectionClass:codexLinuxRemoteControlKeyRecord.protectionClass,publicKeySpkiDerBase64:codexLinuxRemoteControlKeyRecord.publicKeySpkiDerBase64}",
    "}",
    "function codexLinuxRemoteControlStorage(){",
    "let codexLinuxRemoteControlSafeStorage=null,codexLinuxRemoteControlDetectedBackend=`unavailable`;",
    "try{let codexLinuxRemoteControlElectron=require(`electron`),codexLinuxRemoteControlCandidate=codexLinuxRemoteControlElectron?.safeStorage;if(codexLinuxRemoteControlCandidate!=null){codexLinuxRemoteControlDetectedBackend=typeof codexLinuxRemoteControlCandidate.getSelectedStorageBackend===`function`?codexLinuxRemoteControlCandidate.getSelectedStorageBackend():`unknown`;if(codexLinuxRemoteControlDetectedBackend!==`unknown`&&codexLinuxRemoteControlDetectedBackend!==`basic_text`&&(typeof codexLinuxRemoteControlCandidate.isEncryptionAvailable!==`function`||codexLinuxRemoteControlCandidate.isEncryptionAvailable()))codexLinuxRemoteControlSafeStorage=codexLinuxRemoteControlCandidate}}catch{}",
    "return{safeStorage:codexLinuxRemoteControlSafeStorage,detectedBackend:codexLinuxRemoteControlDetectedBackend}",
    "}",
    "function codexLinuxRemoteControlStorageFields(codexLinuxRemoteControlPrivateKeyPem){",
    "let codexLinuxRemoteControlStorageState=codexLinuxRemoteControlStorage();",
    "if(codexLinuxRemoteControlStorageState.safeStorage==null){console.warn(`WARN: Linux remote control keychain unavailable; storing device key with file permissions 0600 (detected backend: ${codexLinuxRemoteControlStorageState.detectedBackend})`);return{privateKeyPkcs8Pem:codexLinuxRemoteControlPrivateKeyPem,storageBackend:`file_0600`,detectedBackend:codexLinuxRemoteControlStorageState.detectedBackend}}",
    "return{privateKeyCiphertextBase64:codexLinuxRemoteControlStorageState.safeStorage.encryptString(codexLinuxRemoteControlPrivateKeyPem).toString(`base64`),storageBackend:codexLinuxRemoteControlStorageState.detectedBackend,detectedBackend:codexLinuxRemoteControlStorageState.detectedBackend}",
    "}",
    "function codexLinuxRemoteControlPrivateKeyPem(codexLinuxRemoteControlKeyRecord){",
    "if(typeof codexLinuxRemoteControlKeyRecord.privateKeyPkcs8Pem===`string`)return codexLinuxRemoteControlKeyRecord.privateKeyPkcs8Pem;",
    "if(typeof codexLinuxRemoteControlKeyRecord.privateKeyCiphertextBase64!==`string`)throw Error(`Linux remote control device key has no private key material`);",
    "let codexLinuxRemoteControlStorageState=codexLinuxRemoteControlStorage();if(codexLinuxRemoteControlStorageState.safeStorage==null)throw Error(`Linux remote control device keychain is unavailable`);",
    "try{return codexLinuxRemoteControlStorageState.safeStorage.decryptString(Buffer.from(codexLinuxRemoteControlKeyRecord.privateKeyCiphertextBase64,`base64`))}catch(codexLinuxRemoteControlDecryptError){throw Error(`Failed to decrypt Linux remote control device key`)}",
    "}",
    "function codexLinuxReadRemoteControlDeviceKeyStore(){",
    "let codexLinuxRemoteControlKeyStorePath=codexLinuxRemoteControlDeviceKeyStorePath();",
    `if(!${fsVar}.existsSync(codexLinuxRemoteControlKeyStorePath))return{version:codexLinuxRemoteControlKeyStoreVersion,keys:{}};`,
    `let codexLinuxRemoteControlKeyStoreStat=codexLinuxRemoteControlAssertOwnedRegularFile(codexLinuxRemoteControlKeyStorePath,${fsVar});if(codexLinuxRemoteControlKeyStoreStat.size>codexLinuxRemoteControlKeyStoreMaxBytes)throw Error(\`Linux remote control device key store exceeds size limit\`);`,
    `let codexLinuxRemoteControlKeyStoreFd=${fsVar}.openSync(codexLinuxRemoteControlKeyStorePath,${fsVar}.constants.O_RDONLY|${fsVar}.constants.O_NOFOLLOW),codexLinuxRemoteControlKeyStoreText;try{codexLinuxRemoteControlKeyStoreStat=codexLinuxRemoteControlAssertOwnedRegularStat(${fsVar}.fstatSync(codexLinuxRemoteControlKeyStoreFd));if(codexLinuxRemoteControlKeyStoreStat.size>codexLinuxRemoteControlKeyStoreMaxBytes)throw Error(\`Linux remote control device key store exceeds size limit\`);let codexLinuxRemoteControlKeyStoreBuffer=Buffer.alloc(codexLinuxRemoteControlKeyStoreStat.size),codexLinuxRemoteControlKeyStoreOffset=0,codexLinuxRemoteControlKeyStoreBytesRead;while(codexLinuxRemoteControlKeyStoreOffset<codexLinuxRemoteControlKeyStoreBuffer.length&&(codexLinuxRemoteControlKeyStoreBytesRead=${fsVar}.readSync(codexLinuxRemoteControlKeyStoreFd,codexLinuxRemoteControlKeyStoreBuffer,codexLinuxRemoteControlKeyStoreOffset,codexLinuxRemoteControlKeyStoreBuffer.length-codexLinuxRemoteControlKeyStoreOffset,codexLinuxRemoteControlKeyStoreOffset))>0)codexLinuxRemoteControlKeyStoreOffset+=codexLinuxRemoteControlKeyStoreBytesRead;codexLinuxRemoteControlKeyStoreText=codexLinuxRemoteControlKeyStoreBuffer.subarray(0,codexLinuxRemoteControlKeyStoreOffset).toString(\`utf8\`)}finally{${fsVar}.closeSync(codexLinuxRemoteControlKeyStoreFd)}`,
    "let codexLinuxRemoteControlKeyStore;try{codexLinuxRemoteControlKeyStore=JSON.parse(codexLinuxRemoteControlKeyStoreText)}catch{throw Error(`Linux remote control device key store contains invalid JSON`)}",
    "if(codexLinuxRemoteControlKeyStore&&(codexLinuxRemoteControlKeyStore.version==null||codexLinuxRemoteControlKeyStore.version===1))codexLinuxRemoteControlKeyStore={version:codexLinuxRemoteControlKeyStoreVersion,keys:codexLinuxRemoteControlKeyStore.keys};return codexLinuxRemoteControlValidateDeviceKeyStore(codexLinuxRemoteControlKeyStore)",
    "}",
    "function codexLinuxRemoteControlMigrateDeviceKeyStore(e){let t=codexLinuxRemoteControlStorage();if(t.safeStorage==null)return null;let n={version:codexLinuxRemoteControlKeyStoreVersion,keys:{...e.keys}},r=!1;for(let [e,i] of Object.entries(n.keys))if(typeof i.privateKeyPkcs8Pem===`string`)try{let a=codexLinuxRemoteControlStorageFields(i.privateKeyPkcs8Pem);n.keys[e]={...i,...a};delete n.keys[e].privateKeyPkcs8Pem;r=!0}catch{console.warn(`WARN: Could not migrate Linux remote control device key to safeStorage; retaining legacy file-backed key`)}return r?n:null}",
    `function codexLinuxRemoteControlOpenKeyStoreLock(){let e=codexLinuxRemoteControlDeviceKeyStorePath()+\`.lock\`,t,n=!1;try{try{t=${fsVar}.openSync(e,${fsVar}.constants.O_RDWR|${fsVar}.constants.O_CREAT|${fsVar}.constants.O_EXCL|${fsVar}.constants.O_NOFOLLOW,384),n=!0}catch(r){if(r?.code!==\`EEXIST\`)throw r;t=${fsVar}.openSync(e,${fsVar}.constants.O_RDWR|${fsVar}.constants.O_NOFOLLOW)}n&&${fsVar}.fchmodSync(t,384),codexLinuxRemoteControlAssertOwnedRegularStat(${fsVar}.fstatSync(t));return t}catch(r){try{t!=null&&${fsVar}.closeSync(t)}catch{}throw r}}`,
    `function codexLinuxRemoteControlResolveExecutable(codexLinuxRemoteControlExecutableName){let codexLinuxRemoteControlSearchDirectories=[...(process.env.PATH??\`\`).split(${pathVar}.delimiter),\`/run/current-system/sw/bin\`,\`/nix/var/nix/profiles/default/bin\`,\`/usr/local/bin\`,\`/usr/bin\`,\`/bin\`],codexLinuxRemoteControlSeenDirectories=new Set;for(let codexLinuxRemoteControlDirectory of codexLinuxRemoteControlSearchDirectories){if(!codexLinuxRemoteControlDirectory||!${pathVar}.isAbsolute(codexLinuxRemoteControlDirectory)||codexLinuxRemoteControlSeenDirectories.has(codexLinuxRemoteControlDirectory))continue;codexLinuxRemoteControlSeenDirectories.add(codexLinuxRemoteControlDirectory);try{let codexLinuxRemoteControlExecutablePath=${fsVar}.realpathSync(${pathVar}.join(codexLinuxRemoteControlDirectory,codexLinuxRemoteControlExecutableName)),codexLinuxRemoteControlExecutableStat=${fsVar}.statSync(codexLinuxRemoteControlExecutablePath);if(!codexLinuxRemoteControlExecutableStat.isFile())continue;${fsVar}.accessSync(codexLinuxRemoteControlExecutablePath,${fsVar}.constants.X_OK);return codexLinuxRemoteControlExecutablePath}catch{}}return null}`,
    `function codexLinuxWithRemoteControlKeyStoreLock(codexLinuxRemoteControlLockedOperation){let codexLinuxRemoteControlLockFd=codexLinuxRemoteControlOpenKeyStoreLock(),codexLinuxRemoteControlFlockPath=codexLinuxRemoteControlResolveExecutable(\`flock\`),codexLinuxRemoteControlShellPath=codexLinuxRemoteControlResolveExecutable(\`sh\`);if(codexLinuxRemoteControlFlockPath==null||codexLinuxRemoteControlShellPath==null){${fsVar}.closeSync(codexLinuxRemoteControlLockFd);throw Error(\`Linux remote control device key store requires flock and sh\`)}return new Promise((codexLinuxRemoteControlResolve,codexLinuxRemoteControlReject)=>{let codexLinuxRemoteControlLockProcess;try{codexLinuxRemoteControlLockProcess=${childProcessVar}.spawn(codexLinuxRemoteControlFlockPath,[\`-x\`,\`-w\`,\`5\`,\`/proc/self/fd/3\`,codexLinuxRemoteControlShellPath,\`-c\`,\`printf 'ready\\n'; cat >/dev/null\`],{stdio:[\`pipe\`,\`pipe\`,\`pipe\`,codexLinuxRemoteControlLockFd]})}finally{${fsVar}.closeSync(codexLinuxRemoteControlLockFd)}let codexLinuxRemoteControlStdout=\`\`,codexLinuxRemoteControlStderr=\`\`,codexLinuxRemoteControlResult,codexLinuxRemoteControlReady=!1,codexLinuxRemoteControlOperationDone=!1,codexLinuxRemoteControlProcessDone=!1,codexLinuxRemoteControlExitCode=null,codexLinuxRemoteControlFailure=null,codexLinuxRemoteControlTimer=setTimeout(()=>{codexLinuxRemoteControlReady||(codexLinuxRemoteControlFailure=Error(\`Timed out waiting for Linux remote control device key store lock\`),codexLinuxRemoteControlOperationDone=!0,codexLinuxRemoteControlLockProcess.kill())},5500),codexLinuxRemoteControlSettle=()=>{if(!codexLinuxRemoteControlOperationDone||!codexLinuxRemoteControlProcessDone)return;codexLinuxRemoteControlFailure?codexLinuxRemoteControlReject(codexLinuxRemoteControlFailure):codexLinuxRemoteControlExitCode===0?codexLinuxRemoteControlResolve(codexLinuxRemoteControlResult):codexLinuxRemoteControlReject(Error(\`Linux remote control device key store lock failed\`))};codexLinuxRemoteControlLockProcess.stderr.on(\`data\`,codexLinuxRemoteControlChunk=>{codexLinuxRemoteControlStderr=(codexLinuxRemoteControlStderr+String(codexLinuxRemoteControlChunk)).slice(-4096)}),codexLinuxRemoteControlLockProcess.on(\`error\`,codexLinuxRemoteControlError=>{clearTimeout(codexLinuxRemoteControlTimer),codexLinuxRemoteControlFailure=codexLinuxRemoteControlError,codexLinuxRemoteControlOperationDone=!0,codexLinuxRemoteControlProcessDone=!0,codexLinuxRemoteControlSettle()}),codexLinuxRemoteControlLockProcess.on(\`close\`,codexLinuxRemoteControlCode=>{clearTimeout(codexLinuxRemoteControlTimer),codexLinuxRemoteControlExitCode=codexLinuxRemoteControlCode,codexLinuxRemoteControlProcessDone=!0,codexLinuxRemoteControlReady||(codexLinuxRemoteControlFailure=Error(codexLinuxRemoteControlStderr.trim()||\`Timed out waiting for Linux remote control device key store lock\`),codexLinuxRemoteControlOperationDone=!0),codexLinuxRemoteControlSettle()}),codexLinuxRemoteControlLockProcess.stdout.on(\`data\`,codexLinuxRemoteControlChunk=>{if(codexLinuxRemoteControlReady)return;codexLinuxRemoteControlStdout+=String(codexLinuxRemoteControlChunk);if(!codexLinuxRemoteControlStdout.includes(\`ready\\n\`))return;codexLinuxRemoteControlReady=!0,clearTimeout(codexLinuxRemoteControlTimer),Promise.resolve().then(codexLinuxRemoteControlLockedOperation).then(codexLinuxRemoteControlValue=>{codexLinuxRemoteControlResult=codexLinuxRemoteControlValue,codexLinuxRemoteControlOperationDone=!0,codexLinuxRemoteControlLockProcess.stdin.end(),codexLinuxRemoteControlSettle()},codexLinuxRemoteControlError=>{codexLinuxRemoteControlFailure=codexLinuxRemoteControlError,codexLinuxRemoteControlOperationDone=!0,codexLinuxRemoteControlLockProcess.stdin.end(),codexLinuxRemoteControlSettle()})})})}`,
    "function codexLinuxWriteRemoteControlDeviceKeyStore(codexLinuxRemoteControlKeyStore){",
    `codexLinuxRemoteControlValidateDeviceKeyStore(codexLinuxRemoteControlKeyStore);let codexLinuxRemoteControlKeyStorePath=codexLinuxRemoteControlDeviceKeyStorePath(),codexLinuxRemoteControlKeyStoreDirectory=${pathVar}.dirname(codexLinuxRemoteControlKeyStorePath),codexLinuxRemoteControlTempPath=codexLinuxRemoteControlKeyStorePath+\`.tmp-\`+${cryptoVar}.randomUUID(),codexLinuxRemoteControlKeyStoreText=JSON.stringify(codexLinuxRemoteControlKeyStore,null,2)+\`\\n\`,codexLinuxRemoteControlTempFd=null,codexLinuxRemoteControlDirectoryFd=null,codexLinuxRemoteControlTempCreated=!1;if(Buffer.byteLength(codexLinuxRemoteControlKeyStoreText,\`utf8\`)>codexLinuxRemoteControlKeyStoreMaxBytes)throw Error(\`Linux remote control device key store exceeds size limit\`);`,
    `try{codexLinuxRemoteControlTempFd=${fsVar}.openSync(codexLinuxRemoteControlTempPath,${fsVar}.constants.O_WRONLY|${fsVar}.constants.O_CREAT|${fsVar}.constants.O_EXCL|${fsVar}.constants.O_NOFOLLOW,384),codexLinuxRemoteControlTempCreated=!0,${fsVar}.writeFileSync(codexLinuxRemoteControlTempFd,codexLinuxRemoteControlKeyStoreText,\`utf8\`),${fsVar}.fsyncSync(codexLinuxRemoteControlTempFd),${fsVar}.closeSync(codexLinuxRemoteControlTempFd),codexLinuxRemoteControlTempFd=null;${fsVar}.existsSync(codexLinuxRemoteControlKeyStorePath)&&codexLinuxRemoteControlAssertOwnedRegularFile(codexLinuxRemoteControlKeyStorePath,${fsVar});${fsVar}.renameSync(codexLinuxRemoteControlTempPath,codexLinuxRemoteControlKeyStorePath),codexLinuxRemoteControlTempCreated=!1;try{codexLinuxRemoteControlDirectoryFd=${fsVar}.openSync(codexLinuxRemoteControlKeyStoreDirectory,${fsVar}.constants.O_RDONLY),${fsVar}.fsyncSync(codexLinuxRemoteControlDirectoryFd),${fsVar}.closeSync(codexLinuxRemoteControlDirectoryFd),codexLinuxRemoteControlDirectoryFd=null}catch(codexLinuxRemoteControlDirectorySyncError){try{codexLinuxRemoteControlDirectoryFd!=null&&${fsVar}.closeSync(codexLinuxRemoteControlDirectoryFd)}catch{}codexLinuxRemoteControlDirectoryFd=null;console.warn(\`WARN: Linux remote control device-key store rename committed but directory fsync failed; crash durability is not confirmed\`)}}catch(codexLinuxRemoteControlWriteError){try{codexLinuxRemoteControlTempFd!=null&&${fsVar}.closeSync(codexLinuxRemoteControlTempFd)}catch{}try{codexLinuxRemoteControlDirectoryFd!=null&&${fsVar}.closeSync(codexLinuxRemoteControlDirectoryFd)}catch{}try{codexLinuxRemoteControlTempCreated&&${fsVar}.rmSync(codexLinuxRemoteControlTempPath,{force:!0})}catch{}throw codexLinuxRemoteControlWriteError}`,
    "}",
    `function ${DEVICE_KEY_ADDON_MARKER}(){return{`,
    "createDeviceKey:async codexLinuxRemoteControlProtectionClass=>{",
    `let codexLinuxRemoteControlKeyPair=(0,${cryptoVar}.generateKeyPairSync)(\`ec\`,{namedCurve:\`P-256\`}),codexLinuxRemoteControlPublicKey=codexLinuxRemoteControlKeyPair.publicKey,codexLinuxRemoteControlSigningKey=codexLinuxRemoteControlKeyPair[\`private\`+\`Key\`];`,
    `let codexLinuxRemoteControlKeyId=(0,${cryptoVar}.randomUUID)(),codexLinuxRemoteControlPublicKeySpkiDerBase64=codexLinuxRemoteControlPublicKey.export({type:\`spki\`,format:\`der\`}).toString(\`base64\`),codexLinuxRemoteControlSigningKeyPkcs8Pem=codexLinuxRemoteControlSigningKey.export({type:\`pkcs8\`,format:\`pem\`});`,
    "let codexLinuxRemoteControlKeyRecord={algorithm:`ecdsa_p256_sha256`,keyId:codexLinuxRemoteControlKeyId,protectionClass:`os_protected_nonextractable`,publicKeySpkiDerBase64:codexLinuxRemoteControlPublicKeySpkiDerBase64,...codexLinuxRemoteControlStorageFields(codexLinuxRemoteControlSigningKeyPkcs8Pem),createdAt:new Date().toISOString()};",
    "await codexLinuxWithRemoteControlKeyStoreLock(()=>{let e=codexLinuxReadRemoteControlDeviceKeyStore(),t=codexLinuxRemoteControlMigrateDeviceKeyStore(e)??e;t.version=codexLinuxRemoteControlKeyStoreVersion,t.keys={...t.keys,[codexLinuxRemoteControlKeyId]:codexLinuxRemoteControlKeyRecord},codexLinuxWriteRemoteControlDeviceKeyStore(t)});",
    "return codexLinuxRemoteControlPublicDeviceKey(codexLinuxRemoteControlKeyRecord)",
    "},",
    "deleteDeviceKey:async codexLinuxRemoteControlKeyId=>codexLinuxWithRemoteControlKeyStoreLock(()=>{let e=codexLinuxReadRemoteControlDeviceKeyStore(),t=codexLinuxRemoteControlMigrateDeviceKeyStore(e)??e;delete t.keys[codexLinuxRemoteControlKeyId],codexLinuxWriteRemoteControlDeviceKeyStore(t)}),",
    "getDeviceKeyPublic:async codexLinuxRemoteControlKeyId=>codexLinuxWithRemoteControlKeyStoreLock(()=>{let e=codexLinuxReadRemoteControlDeviceKeyStore(),t=codexLinuxRemoteControlMigrateDeviceKeyStore(e)??e;t!==e&&codexLinuxWriteRemoteControlDeviceKeyStore(t);let n=t.keys?.[codexLinuxRemoteControlKeyId];if(n==null)throw Error(`Linux remote control device key not found`);return codexLinuxRemoteControlPublicDeviceKey(n)}),",
    `signDeviceKey:async(codexLinuxRemoteControlKeyId,codexLinuxRemoteControlSerializedPayload)=>codexLinuxWithRemoteControlKeyStoreLock(()=>{if(!Buffer.isBuffer(codexLinuxRemoteControlSerializedPayload))throw Error(\`Linux remote control device key payload must be serialized\`);let e=codexLinuxReadRemoteControlDeviceKeyStore(),t=codexLinuxRemoteControlMigrateDeviceKeyStore(e)??e;t!==e&&codexLinuxWriteRemoteControlDeviceKeyStore(t);let n=t.keys?.[codexLinuxRemoteControlKeyId];if(n==null)throw Error(\`Linux remote control device key not found\`);let i=(0,${cryptoVar}.createPrivateKey)(codexLinuxRemoteControlPrivateKeyPem(n)),a=(0,${cryptoVar}.sign)(\`sha256\`,codexLinuxRemoteControlSerializedPayload,i).toString(\`base64\`);return{algorithm:n.algorithm,signatureDerBase64:a}})`,
    "}}",
    // Keep upstream payload serialization and validation; replace only the addon.
    `function ${DEVICE_KEY_CLIENT_MARKER}(e){let t=new e(null),n=${DEVICE_KEY_ADDON_MARKER}();return t.getAddon=()=>n,t}`,
  ].join("");
}

function deviceKeyPatchState(source) {
  const providerMatches = [...source.matchAll(deviceKeyProviderPattern("gu"))];
  if (providerMatches.length !== 1) {
    return { kind: providerMatches.length > 1 ? "ambiguous" : "partial" };
  }
  const providerMatch = providerMatches[0];
  const providerSource = linuxDeviceKeyProviderSource({
    childProcessVar: "codexLinuxRemoteControlChildProcess",
    cryptoVar: "codexLinuxRemoteControlCrypto",
    fsVar: "codexLinuxRemoteControlFs",
    pathVar: "codexLinuxRemoteControlPath",
  });
  const providerSourceCount = source.split(providerSource).length - 1;
  const providerClass = escapeRegExp(providerMatch.groups.providerClass);
  const currentConstructionPattern = new RegExp(
    `this\\.remoteControlDeviceKeyClient=new ${providerClass}\\((?<args>[\\s\\S]{1,300}?)\\),this\\.executionHostRegistry`,
    "gu",
  );
  const patchedConstructionPattern = new RegExp(
    `this\\.remoteControlDeviceKeyClient=process\\.platform===\`linux\`\\?` +
      `${DEVICE_KEY_CLIENT_MARKER}\\(${providerClass}\\):new ${providerClass}\\((?<args>[\\s\\S]{1,300}?)\\),` +
      `this\\.executionHostRegistry`,
    "gu",
  );
  const currentConstructions = [...source.matchAll(currentConstructionPattern)];
  const patchedConstructions = [...source.matchAll(patchedConstructionPattern)];
  const providerStart = providerMatch.index;

  if (currentConstructions.length === 1 && patchedConstructions.length === 0 &&
      providerSourceCount === 0 && !source.includes(DEVICE_KEY_CLIENT_MARKER) &&
      !source.includes(DEVICE_KEY_ADDON_MARKER) &&
      /[;}]$/u.test(source.slice(Math.max(0, providerStart - 1), providerStart))) {
    return {
      kind: "current",
      providerStart,
      providerClass: providerMatch.groups.providerClass,
      construction: currentConstructions[0],
      providerSource,
    };
  }
  if (currentConstructions.length === 0 && patchedConstructions.length === 1 &&
      providerSourceCount === 1 && source.indexOf(providerSource) + providerSource.length === providerStart) {
    return { kind: "patched" };
  }
  if (currentConstructions.length > 0 && patchedConstructions.length > 0) {
    return { kind: "mixed" };
  }
  if (currentConstructions.length > 1 || patchedConstructions.length > 1 || providerSourceCount > 1) {
    return { kind: "ambiguous" };
  }
  return { kind: "partial" };
}

function applyLinuxRemoteControlDeviceKeyPatch(source) {
  const state = deviceKeyPatchState(source);
  if (state.kind === "patched") {
    return source;
  }
  if (state.kind !== "current") {
    if (source.includes(DEVICE_KEY_CLIENT_MARKER) || source.includes(DEVICE_KEY_ADDON_MARKER)) {
      console.warn("WARN: Found incomplete Linux remote-control device-key patch - refusing partial state");
    } else {
      console.warn("WARN: Could not find remote-control device-key bundle needles - skipping Linux remote-control device-key patch");
    }
    return source;
  }

  const { construction, providerClass, providerSource, providerStart } = state;
  // The construction follows the provider in upstream; patch it first so the
  // provider offset stays valid either way.
  const constructionEnd = construction.index + construction[0].length;
  const patchedConstruction =
    `this.remoteControlDeviceKeyClient=process.platform===\`linux\`?${DEVICE_KEY_CLIENT_MARKER}(${providerClass}):` +
    `new ${providerClass}(${construction.groups.args}),this.executionHostRegistry`;
  const withConstruction = construction.index > providerStart
    ? source.slice(0, construction.index) + patchedConstruction + source.slice(constructionEnd)
    : null;
  if (withConstruction == null) {
    console.warn("WARN: Remote-control device-key client is constructed before its provider - skipping Linux remote-control device-key patch");
    return source;
  }
  const patched = withConstruction.slice(0, providerStart) + providerSource + withConstruction.slice(providerStart);
  return deviceKeyPatchState(patched).kind === "patched" ? patched : source;
}

const REMOTE_CONTROL_KEY_MATERIAL_403_MESSAGE =
  "Remote control request failed (403): Remote-control client key material missing";
// Upstream now throws 403 responses with the bare server detail, so the
// prefixed 403 check alone no longer recovers from missing key material.
const REMOTE_CONTROL_RECOVERABLE_MESSAGES = [
  "Remote-control client key material missing",
  "Remote-control client has been revoked",
];
const REMOTE_CONTROL_RECOVERABLE_CHECKS_PATTERN = new RegExp(
  `\\((?<checks>"[^"\\\\]*"===(?<error>${DEVICE_KEY_IDENT})\\.message(?:\\|\\|"[^"\\\\]*"===\\k<error>\\.message)*)\\)`,
  "gu",
);

function applyLinuxRemoteControlClientRevocationRecoveryPatch(source) {
  const messageCheck = (message, error) => `"${message}"===${error}.message`;
  const predicates = [...source.matchAll(REMOTE_CONTROL_RECOVERABLE_CHECKS_PATTERN)].filter((match) =>
    match.groups.checks.split("||").includes(messageCheck(REMOTE_CONTROL_KEY_MATERIAL_403_MESSAGE, match.groups.error)),
  );
  if (predicates.length !== 1) {
    console.warn(
      `WARN: Expected one remote-control recoverable error predicate, found ${predicates.length} - skipping revoked-client recovery patch`,
    );
    return source;
  }
  const [predicate] = predicates;
  const { checks, error } = predicate.groups;
  const existing = checks.split("||");
  const missing = REMOTE_CONTROL_RECOVERABLE_MESSAGES
    .map((message) => messageCheck(message, error))
    .filter((check) => !existing.includes(check));
  if (missing.length === 0) {
    return source;
  }
  const start = predicate.index + 1;
  return source.slice(0, start) + [checks, ...missing].join("||") + source.slice(start + checks.length);
}

function applyLinuxRemoteMobileAppServerRemoteControlPatch(source) {
  return applyLinuxRemoteMobileStartupCommandArgsGuard(
    applyLinuxRemoteMobileAppServerRemoteControlLaunchPatch(source),
  );
}

function applyLinuxRemoteMobileStartupCommandArgsGuard(source) {
  if (
    source.includes(REMOTE_MOBILE_APP_SERVER_STARTUP_GUARD_MARKER) ||
    !hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(source)
  ) {
    return source;
  }
  const guarded = source.replace(
    REMOTE_MOBILE_APP_SERVER_STARTUP_ARGS_PATTERN,
    (_match, launch, options) =>
      `...${REMOTE_MOBILE_APP_SERVER_STARTUP_GUARD_MARKER}(${launch}.args,${options}.startupCommand),` +
      `...${options}.startupCommand?.args??[]`,
  );
  if (guarded === source) {
    return source;
  }
  return guarded.replace(
    REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_HELPER,
    `${REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_HELPER}${REMOTE_MOBILE_APP_SERVER_STARTUP_GUARD_HELPER}`,
  );
}

function applyLinuxRemoteMobileAppServerRemoteControlLaunchPatch(source) {
  if (source.includes(REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER)) {
    if (!hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(source)) {
      console.warn(
        "WARN: Found an incomplete local Desktop app-server remote-control patch - refusing to accept partial state",
      );
    }
    return source;
  }
  const baseArgsMatches = [
    ...source.matchAll(
      new RegExp(`([A-Za-z_$][\\w$]*)=${escapeRegExp(REMOTE_MOBILE_APP_SERVER_BASE_ARGS_NEEDLE)}`, "gu"),
    ),
  ];
  if (baseArgsMatches.length !== 1) {
    return source;
  }

  const baseArgsVariable = baseArgsMatches[0][1];
  const launchReturnPattern = new RegExp(
    "return 0===(?<overrides>[A-Za-z_$][\\w$]*)\\.length\\?" +
      "\\[\\.\\.\\." + escapeRegExp(baseArgsVariable) +
      ',"app-server","--analytics-default-enabled"\\]:' +
      '\\["app-server",\\.\\.\\.' + escapeRegExp(baseArgsVariable) +
      ',\\.\\.\\.\\k<overrides>,"--analytics-default-enabled"\\]',
    "gu",
  );
  const launchReturnMatches = [...source.matchAll(launchReturnPattern)];
  if (launchReturnMatches.length !== 1) {
    return source;
  }

  const launchReturn = launchReturnMatches[0];
  const functionIndex = source.lastIndexOf("function ", launchReturn.index);
  const nextFunctionIndex = source.indexOf("}function", functionIndex);
  if (functionIndex < 0 || (nextFunctionIndex >= 0 && launchReturn.index >= nextFunctionIndex)) {
    return source;
  }

  const overridesVariable = launchReturn.groups.overrides;
  const currentReturnExpression = launchReturn[0].slice("return ".length);
  const patchedReturn =
    `return process.platform===\`linux\`?` +
    `${REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER}(${baseArgsVariable},${overridesVariable}):` +
    currentReturnExpression;
  const replaced =
    source.slice(0, launchReturn.index) +
    patchedReturn +
    source.slice(launchReturn.index + launchReturn[0].length);
  // rspack chunks are CommonJS files whose module factories close over the
  // file scope, so a helper declared at the top is visible to every module.
  return `${REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_HELPER}${replaced}`;
}

function hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(source) {
  return (
    source.includes(REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_HELPER) &&
    new RegExp(
      "return process\\.platform===`linux`\\?" +
        REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER +
        "\\([A-Za-z_$][\\w$]*,[A-Za-z_$][\\w$]*\\):",
      "u",
    ).test(source)
  );
}

function applyLinuxRemoteMobileAppServerRemoteControlExtractedAppPatch(extractedDir) {
  const mainProcess = findMainProcessChunks(extractedDir);
  if (mainProcess == null) {
    const reason = `missing main-process chunks in ${path.join(extractedDir, ".vite", "build")}`;
    console.warn(`WARN: Could not find app-server launch bundle - skipping remote mobile app-server remote-control patch`);
    return { matched: 0, changed: 0, reason };
  }

  const { buildDir, chunks: candidates } = mainProcess;

  let matched = 0;
  let changed = 0;
  for (const candidate of candidates) {
    const filePath = path.join(buildDir, candidate);
    const source = fs.readFileSync(filePath, "utf8");
    if (
      !source.includes(REMOTE_MOBILE_APP_SERVER_BASE_ARGS_NEEDLE) &&
      !source.includes(REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER)
    ) {
      continue;
    }
    const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(source);
    if (patched !== source) {
      matched += 1;
      fs.writeFileSync(filePath, patched, "utf8");
      changed += 1;
    } else if (hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(source)) {
      matched += 1;
    }
  }

  if (matched === 0) {
    const reason = "no local Desktop app-server base args found";
    console.warn(
      "WARN: Could not find local Desktop app-server base args - skipping remote mobile app-server remote-control patch",
    );
    return { matched, changed, reason };
  }
  return { matched, changed };
}

// Global-state key of the mobile setup completion flag (upstream
// `CODEX_MOBILE_SETUP_COMPLETED`), now owned by the main process
// remote-connection preferences and written through `applicationState`.
const REMOTE_CONTROL_MOBILE_SETUP_COMPLETED_KEY = "codex-mobile-has-connected-device";
const REMOTE_CONTROL_REVOKE_PATTERN =
  /onRevoked:([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.setData\(([A-Za-z_$][\w$]*)=>\3\?\.filter\(\3=>\3\.clientId!==\1\)\),\2\.invalidate\(\)\}(?=,onRevokeResult:)/gu;

function enclosingFunction(source, index) {
  for (let start = source.lastIndexOf("function ", index); start !== -1; start = source.lastIndexOf("function ", start - 1)) {
    const end = findMatchingBrace(source, source.indexOf("{", start));
    if (end > index) return { start, end };
  }
  return null;
}

function revokeSetupResetContract(source) {
  const revokes = [...source.matchAll(REMOTE_CONTROL_REVOKE_PATTERN)];
  if (revokes.length !== 1 || !source.includes("remote-control-client-revoke-success")) return null;
  const [revoke] = revokes;
  const owner = enclosingFunction(source, revoke.index);
  const factory = moduleFactoryAt(source, revoke.index);
  if (owner == null || factory == null || factory.require == null) return null;
  const ownerSource = source.slice(owner.start, owner.end + 1);
  const localClients = [...ownerSource.matchAll(/localRemoteControlClientId:([A-Za-z_$][\w$]*)[,}]/gu)];
  if (localClients.length !== 1) return null;
  const localClientVar = localClients[0][1];
  // The local client id is a component variable, not a module binding.
  if (!new RegExp(`[,;{ ]${escapeRegExp(localClientVar)}=`, "u").test(ownerSource)) return null;
  // The module reaches app services through one import binding; the component
  // may shadow its minified name, so only module-scope code uses it.
  const moduleSource = source.slice(factory.bodyStart, factory.end);
  const services = new Set([...moduleSource.matchAll(/([A-Za-z_$][\w$]*)\.appServices\.remoteConnections/gu)].map((match) => match[1]));
  if (services.size !== 1) return null;
  const [servicesVar] = services;
  const imports = [...moduleSource.matchAll(new RegExp(
    `(?:\\bvar |,)${escapeRegExp(servicesVar)}=${escapeRegExp(factory.require)}\\("[^"]+"\\)`, "gu"))];
  if (imports.length !== 1) return null;
  return { revoke, factory, localClientVar, servicesVar };
}

function matchesLinuxRemoteControlClientRevokeSetupResetContract(source) {
  return source.includes(REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER) || revokeSetupResetContract(source) != null;
}

function applyLinuxRemoteControlClientRevokeSetupResetPatch(source) {
  if (source.includes(REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER)) {
    const calls = source.split(`${REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER}(`).length - 1;
    if (calls !== 2) {
      console.warn("WARN: Found an incomplete remote-control revoke setup-reset patch - skipping setup reset patch");
    }
    return source;
  }
  const contract = revokeSetupResetContract(source);
  if (contract == null) {
    console.warn("WARN: Could not find remote-control revoke success handler - skipping setup reset patch");
    return source;
  }
  const { revoke, factory, localClientVar, servicesVar } = contract;
  const [needle, clientIdVar, queryVar, dataVar] = revoke;
  const helper =
    `function ${REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER}(e,t,n){` +
    "let r=e?.filter(e=>(e.clientId??e.client_id)!==t),i=r?.filter(e=>(e.clientId??e.client_id)!==n);" +
    `return i?.length===0&&${servicesVar}.appServices?.applicationState?.write(${JSON.stringify(REMOTE_CONTROL_MOBILE_SETUP_COMPLETED_KEY)},!1)?.catch?.(()=>{}),r}`;
  const replacement =
    `onRevoked:${clientIdVar}=>{${queryVar}.setData(${dataVar}=>${REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER}(${dataVar},${clientIdVar},${localClientVar})),${queryVar}.invalidate()}`;
  const helperAt = factory.bodyStart + (source.startsWith('"use strict";', factory.bodyStart) ? '"use strict";'.length : 0);
  return source.slice(0, helperAt) + helper + source.slice(helperAt, revoke.index) + replacement +
    source.slice(revoke.index + needle.length);
}

// The gate bridge component reads the remote-control rollout gate and pushes
// the result to the main process via remoteConnections.setRemoteControlEnabled.
function linuxRemoteControlEnablementOwnerPattern(flags = "u") {
  const I = "[A-Za-z_$][\\w$]*";
  return new RegExp(
    `function (?<fn>${I})\\(\\)\\{let (?:${I},)*(?<cache>${I})=\\(0,${I}\\.c\\)\\(10\\),` +
      `\\{checkGate:(?<checkGate>${I}),isLoading:(?<isLoading>${I})\\}=\\(0,${I}\\.${I}\\)\\(\\);` +
      `\\k<cache>\\[0\\]!==\\k<checkGate>\\?\\((?<primary>${I})=\\k<checkGate>\\(${I}(?:\\.${I})?\\),` +
      `\\k<cache>\\[0\\]=\\k<checkGate>,\\k<cache>\\[1\\]=\\k<primary>\\):\\k<primary>=\\k<cache>\\[1\\];` +
      `let (?<primaryValue>${I})=\\k<primary>;` +
      `\\k<cache>\\[2\\]!==\\k<checkGate>\\|\\|\\k<cache>\\[3\\]!==\\k<primaryValue>\\?` +
      `\\((?<gate>${I})=\\k<checkGate>\\("1042620455"\\)\\|\\|\\k<primaryValue>,` +
      `\\k<cache>\\[2\\]=\\k<checkGate>,\\k<cache>\\[3\\]=\\k<primaryValue>,\\k<cache>\\[4\\]=\\k<gate>\\):\\k<gate>=\\k<cache>\\[4\\];` +
      `let (?<enabled>${I})=\\k<gate>(?<bridge>\\|\\|/\\*${REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER}\\*/` +
      `typeof navigator!=\`undefined\`&&navigator\\.userAgent\\.includes\\(\`Linux\`\\))?;return `,
    flags,
  );
}

function countText(source, needle) {
  return source.split(needle).length - 1;
}

function findLinuxRemoteControlEnablementOwners(source) {
  const matches = [...source.matchAll(linuxRemoteControlEnablementOwnerPattern("gu"))];
  return matches.filter((match) => {
    const end = findMatchingBrace(source, source.indexOf("{", match.index));
    if (end === -1) return false;
    const owner = source.slice(match.index, end + 1);
    return countText(owner, ".remoteConnections") === 1 &&
      countText(owner, ".setRemoteControlEnabled(") === 1 &&
      countText(owner, "[remote-connections/gate-bridge]") === 1;
  });
}

function matchesLinuxRemoteControlEnablementBridgeContract(source) {
  return findLinuxRemoteControlEnablementOwners(source).length === 1 &&
    countText(source, ".setRemoteControlEnabled(") === 1 &&
    countText(source, "[remote-connections/gate-bridge]") === 1;
}

function findSemanticMatches(dir, names, regex) {
  const matches = [];
  for (const name of names) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    const pattern = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    for (const _match of source.matchAll(pattern)) matches.push(name);
  }
  return matches;
}

// The main process owns auto-connect choices; the settings page only forwards
// the user's choice to that service. Linux relies on that ownership instead of
// patching auto-connect, so the contract is verified on both sides.
function validateLinuxRemoteControlAutoConnectContract(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const serviceMatches = findSemanticMatches(
    buildDir,
    fs.existsSync(buildDir) ? fs.readdirSync(buildDir).filter((name) => name.endsWith(".js")).sort() : [],
    /setAutoConnect\((?<params>[A-Za-z_$][\w$]*)\)\{return this\.(?<service>[A-Za-z_$][\w$]*)\.setRemoteConnectionAutoConnect\(\k<params>\.hostId,\k<params>\.autoConnect\)\}/u,
  );
  const callerMatches = findSemanticMatches(
    path.join(extractedDir, "webview", "assets"),
    listWebviewScriptAssets(extractedDir),
    /async function [A-Za-z_$][\w$]*\((?<choice>[A-Za-z_$][\w$]*)\)\{let (?<service>[A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\.appServices\.remoteConnections;if\(null==\k<service>\)throw Error\("Remote connections are unavailable"\);return \k<service>\.setAutoConnect\(\k<choice>\)\}/u,
  );
  if (serviceMatches.length !== 1 || callerMatches.length !== 1) {
    const reason = `could not uniquely resolve upstream auto-connect service and caller (service=${serviceMatches.length}, caller=${callerMatches.length})`;
    console.warn(`WARN: ${reason}`);
    return { matched: false, changed: false, reason };
  }
  return { matched: true, changed: false };
}

function matchesLinuxRemoteControlLoadGateContract(source) {
  return [...source.matchAll(REMOTE_CONTROL_LOAD_GATE_NEEDLE)].length +
    [...source.matchAll(REMOTE_CONTROL_LOAD_GATE_PATCHED)].length === 1;
}

function applyLinuxRemoteControlLoadGatePatch(source) {
  const pristine = [...source.matchAll(REMOTE_CONTROL_LOAD_GATE_NEEDLE)];
  const patched = [...source.matchAll(REMOTE_CONTROL_LOAD_GATE_PATCHED)];
  const markers = source.split(REMOTE_CONTROL_LOAD_GATE_MARKER).length - 1;
  if (pristine.length === 0 && patched.length === 1 && markers === 2) return source;
  if (pristine.length !== 1 || patched.length !== 0 || markers !== 0) {
    console.warn("WARN: Could not find unique remote-control loader rollout gate - skipping Linux remote-control load gate patch");
    return source;
  }
  const [match] = pristine;
  const [, functionName, gateHook] = match;
  const replacement =
    `function ${functionName}(){return ${REMOTE_CONTROL_LOAD_GATE_MARKER}()||(0,${gateHook})("1042620455")}` +
    `function ${REMOTE_CONTROL_LOAD_GATE_MARKER}(){return"undefined"!=typeof navigator&&navigator.userAgent.includes("Linux")}`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

// The main process syncs experimental feature enablement to every connected
// app server (`experimentalFeature/enablement/set`). Linux enables
// `remote_control` for the local Desktop app server only; Remote SSH, WSL and
// cloud hosts keep the upstream enablement.
const REMOTE_CONTROL_FEATURE_SYNC_HELPER =
  `function ${REMOTE_CONTROL_FEATURE_SYNC_MARKER}(e,t){return"linux"===process.platform&&"local"===t?{...e,remote_control:!0}:e}`;

function remoteControlFeatureSyncPattern(patched) {
  const enablement = patched
    ? `${REMOTE_CONTROL_FEATURE_SYNC_MARKER}\\((?<enablement>${DEVICE_KEY_IDENT}),\\k<record>\\.connection\\.hostId\\)`
    : `(?<enablement>${DEVICE_KEY_IDENT})`;
  return new RegExp(
    `(?<record>${DEVICE_KEY_IDENT})\\.connection\\.sendAppServerRequest\\("experimentalFeature/enablement/set",` +
      `\\{enablement:${enablement}\\},(?<guard>${DEVICE_KEY_IDENT})\\)`,
    "gu",
  );
}

function applyLinuxRemoteControlFeatureSyncPatch(source) {
  const pristine = [...source.matchAll(remoteControlFeatureSyncPattern(false))];
  const patched = [...source.matchAll(remoteControlFeatureSyncPattern(true))];
  const helpers = source.split(REMOTE_CONTROL_FEATURE_SYNC_HELPER).length - 1;
  const markers = source.split(REMOTE_CONTROL_FEATURE_SYNC_MARKER).length - 1;
  if (pristine.length === 0 && patched.length === 1 && helpers === 1 && markers === 2) return source;
  if (pristine.length !== 1 || patched.length !== 0 || markers !== 0 ||
      !source.includes("async sendEnablement(") || !source.includes(".remote_plugin=")) {
    console.warn(
      "WARN: Could not find unique app-server experimental feature enablement sync - skipping Linux remote-control feature sync patch",
    );
    return source;
  }
  const [match] = pristine;
  const { record, enablement, guard } = match.groups;
  const replacement = `${record}.connection.sendAppServerRequest("experimentalFeature/enablement/set",` +
    `{enablement:${REMOTE_CONTROL_FEATURE_SYNC_MARKER}(${enablement},${record}.connection.hostId)},${guard})`;
  const withSync = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
  // rspack main chunks are CommonJS scripts: a top-level declaration is
  // visible to every module factory in the chunk.
  const strict = '"use strict";';
  const insertAt = withSync.startsWith(strict) ? strict.length : 0;
  return withSync.slice(0, insertAt) + REMOTE_CONTROL_FEATURE_SYNC_HELPER + withSync.slice(insertAt);
}

// rspack duplicates the visibility module into every async chunk that uses
// it, so each copy carries the same owner and is patched independently.
function remoteControlVisibilityContract(source) {
  const ownerPattern = /function ([A-Za-z_$][\w$]*)\(\{remoteControlConnectionsState:([A-Za-z_$][\w$]*),slingshotEnabled:([A-Za-z_$][\w$]*)\}\)\{([^{}]*)\}/gu;
  const owners = [...source.matchAll(ownerPattern)];
  if (owners.length !== 1) return null;

  const [owner] = owners;
  const [, , stateVar, slingshotVar, body] = owner;
  const current =
    `return ${slingshotVar}&&(${stateVar}?.available??!0)&&${stateVar}?.accessRequired!==!0`;
  const patchedMarker = `${REMOTE_CONTROL_VISIBILITY_MARKER}(?:\\*/\\*${REMOTE_CONTROL_UI_VISIBILITY_MARKER})?`;
  const patchedPattern = new RegExp(
    `^let ([A-Za-z_$][\\w$]*)=typeof navigator!=\`undefined\`&&navigator\\.userAgent\\.includes\\(\`Linux\`\\);` +
      `/\\*${patchedMarker}\\*/return\\(\\1\\|\\|${escapeRegExp(slingshotVar)}\\)&&` +
      `\\(\\1\\|\\|\\(${escapeRegExp(stateVar)}\\?\\.available\\?\\?!0\\)\\)&&` +
      `${escapeRegExp(stateVar)}\\?\\.accessRequired!==!0$`,
    "u",
  );
  const state = body === current ? "current" : patchedPattern.test(body) ? "patched" : null;
  if (state == null) return null;

  return {
    body,
    bodyIndex: owner.index + owner[0].indexOf(body),
    slingshotVar,
    state,
    stateVar,
  };
}

function applyLinuxRemoteControlVisibilityPatch(source) {
  const contract = remoteControlVisibilityContract(source);
  if (contract == null) {
    console.warn("WARN: Could not find unique remote-control visibility gate - skipping Linux remote-control visibility patch");
    return source;
  }
  if (contract.state === "patched") {
    return source;
  }

  const { body, bodyIndex, slingshotVar, stateVar } = contract;
  // A fresh local name: the owner's minified parameters may be any letter.
  const linux = "codexLinuxRemoteControlOnLinux";
  const replacement =
    `let ${linux}=typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`);` +
    `/*${REMOTE_CONTROL_VISIBILITY_MARKER}*/return(${linux}||${slingshotVar})&&` +
    `(${linux}||(${stateVar}?.available??!0))&&${stateVar}?.accessRequired!==!0`;
  return source.slice(0, bodyIndex) + replacement + source.slice(bodyIndex + body.length);
}

function replaceLinuxRemoteControlCopy(source) {
  let patched = source;
  let changed = false;
  for (const [macCopy, linuxCopy] of REMOTE_CONTROL_LINUX_COPY_REPLACEMENTS) {
    if (patched.includes(macCopy)) {
      patched = patched.split(macCopy).join(linuxCopy);
      changed = true;
    }
  }
  return { patched, changed };
}

function applyLinuxRemoteControlCopyPatch(source) {
  const hasMarker = source.includes(REMOTE_CONTROL_COPY_MARKER);
  const { patched, changed } = replaceLinuxRemoteControlCopy(source);
  if (!changed) {
    if (hasMarker) {
      return source;
    }
    if (
      !source.includes("this Mac") &&
      !source.includes("Keep this Mac awake") &&
      !source.includes("Control this Mac") &&
      !source.includes("local Mac") &&
      !source.includes("settings.remoteConnections")
    ) {
      return source;
    }
    console.warn("WARN: Could not find remote-control Mac copy - skipping Linux remote-control copy patch");
    return source;
  }
  return hasMarker ? patched : `/*${REMOTE_CONTROL_COPY_MARKER}*/${patched}`;
}

function applyLinuxRemoteControlSettingsUxPatch(source) {
  let patched = replaceLinuxRemoteControlCopy(source).patched;
  patched = applyLinuxRemoteControlOutboundTabGatePatch(patched);

  return patched;
}

function applyLinuxRemoteControlOutboundTabGatePatch(source) {
  if (source.includes(REMOTE_CONTROL_OUTBOUND_TAB_GATE_MARKER)) {
    return source;
  }

  const gates = [...source.matchAll(/([A-Za-z_$][\w$]*)=\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\)\("782640499"\)/gu)];
  if (gates.length !== 1) {
    console.warn("WARN: Could not find unique remote-control outbound tab gate - skipping Linux outbound tab gate patch");
    return source;
  }

  const [, hiddenGateVar] = gates[0];
  const negatedGate = new RegExp(
    `([A-Za-z_$][\\w$]*)=!${escapeRegExp(hiddenGateVar)}(?=,[A-Za-z_$][\\w$]*=null==[A-Za-z_$][\\w$]*[,;])`,
    "gu",
  );
  const consumers = [...source.matchAll(negatedGate)];
  if (consumers.length !== 1) {
    console.warn("WARN: Could not find remote-control outbound tab gate consumer - skipping Linux outbound tab gate patch");
    return source;
  }
  return source.replace(
    negatedGate,
    `$1=/*${REMOTE_CONTROL_OUTBOUND_TAB_GATE_MARKER}*/(typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)||!${hiddenGateVar})`,
  );
}

// The settings page polls remote connections every 15s from an effect
// (`window.setInterval(()=>{n()},15e3)`). Linux polls every 5s and also
// refreshes when the window becomes visible, focused, online, or resumes.
function applyLinuxRemoteConnectionsRefreshPatch(source) {
  if (source.includes(REMOTE_CONNECTIONS_REFRESH_MARKER)) {
    return source;
  }

  const effectPattern =
    /([A-Za-z_$][\w$]*)=\(\)=>\{let ([A-Za-z_$][\w$]*)=null,([A-Za-z_$][\w$]*)=!1,([A-Za-z_$][\w$]*)=async\(\)=>\{\3\|\|\(\3=!0,\2=new AbortController,await \(async\(\)=>\{await ([A-Za-z_$][\w$]*)\(\2\.signal\)\}\)\(\)\.finally\(\(\)=>\{\2=null,\3=!1\}\)\)\},([A-Za-z_$][\w$]*)=window\.setInterval\(\(\)=>\{\4\(\)\},15e3\);return\(\)=>\{\2\?\.abort\(\),window\.clearInterval\(\6\)\}\}/gu;
  const matches = [...source.matchAll(effectPattern)];
  if (matches.length !== 1) {
    console.warn("WARN: Could not find unique remote-connections auto-refresh effect - skipping Linux remote-connections refresh patch");
    return source;
  }

  const [
    needle,
    effectVar,
    abortVar,
    pendingVar,
    refreshVar,
    refreshEventVar,
    intervalVar,
  ] = matches[0];
  const replacement =
    `${effectVar}=()=>{let ${abortVar}=null,${pendingVar}=!1,${refreshVar}=async()=>{${pendingVar}||(${pendingVar}=!0,${abortVar}=new AbortController,await(async()=>{await ${refreshEventVar}(${abortVar}.signal)})().finally(()=>{${abortVar}=null,${pendingVar}=!1}))},` +
    `codexLinuxRemoteConnectionsRefreshTimer=null,codexLinuxRemoteConnectionsRefreshLast=0,${REMOTE_CONNECTIONS_REFRESH_MARKER}=()=>{if(document.visibilityState===\`hidden\`)return;let e=Date.now(),t=()=>{codexLinuxRemoteConnectionsRefreshLast=Date.now(),codexLinuxRemoteConnectionsRefreshTimer=null,${refreshVar}()};if(e-codexLinuxRemoteConnectionsRefreshLast<1e3){codexLinuxRemoteConnectionsRefreshTimer!=null&&window.clearTimeout(codexLinuxRemoteConnectionsRefreshTimer),codexLinuxRemoteConnectionsRefreshTimer=window.setTimeout(t,1e3-(e-codexLinuxRemoteConnectionsRefreshLast));return}t()},` +
    `${intervalVar}=window.setInterval(()=>{${refreshVar}()},5e3);` +
    `document.addEventListener(\`visibilitychange\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`focus\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`online\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`resume\`,${REMOTE_CONNECTIONS_REFRESH_MARKER});` +
    `return()=>{${abortVar}?.abort(),window.clearInterval(${intervalVar}),` +
    `codexLinuxRemoteConnectionsRefreshTimer!=null&&window.clearTimeout(codexLinuxRemoteConnectionsRefreshTimer),` +
    `document.removeEventListener(\`visibilitychange\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`focus\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`online\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`resume\`,${REMOTE_CONNECTIONS_REFRESH_MARKER})}}`;

  return source.slice(0, matches[0].index) + replacement + source.slice(matches[0].index + needle.length);
}

// rspack chunks hold many module factories keyed by hashed ids:
// `__webpack_modules__={abCd(e,t,n){...},...}`. Returns the body bounds of the
// factory that contains `index`, so injected helpers share its module scope.
function moduleFactoryAt(source, index) {
  const objectStart = source.indexOf("__webpack_modules__={");
  if (objectStart === -1) return null;
  const header = /([A-Za-z0-9_$]+|"[^"]*")\(([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*){0,2})?\)\{/y;
  let cursor = objectStart + "__webpack_modules__={".length;
  while (cursor < source.length) {
    header.lastIndex = cursor;
    const match = header.exec(source);
    if (!match) return null;
    const open = cursor + match[0].length - 1;
    const end = findMatchingBrace(source, open);
    if (end === -1) return null;
    if (index > open && index < end) {
      return { bodyStart: open + 1, end, require: (match[2] ?? "").split(",")[2] ?? null };
    }
    cursor = end + 1;
    if (source[cursor] !== ",") return null;
    cursor += 1;
  }
  return null;
}

const REMOTE_USER_INPUT_REQUEST_HELPER =
  "function codexLinuxRemoteHasUserInputRequest(e){try{return Array.isArray(e)&&e.some(e=>e?.method===`item/tool/requestUserInput`||e?.method===`item/tool/requestOptionPicker`||e?.method===`item/tool/requestSetupCodexContextPicker`||e?.method===`item/tool/call`&&(e?.params?.tool===`request_onboarding_input`||e?.params?.tool===`request_option_picker`||e?.params?.tool===`setup_codex_context_picker`||e?.params?.tool===`setup_codex_step`))}catch{return!1}}";
const REMOTE_TERMINAL_STATUS_PATTERN =
  /function ([A-Za-z_$][\w$]*)\(\{hasInProgressOwnedWork:([A-Za-z_$][\w$]*),isResponseInProgress:([A-Za-z_$][\w$]*),latestTurnHasSystemError:([A-Za-z_$][\w$]*),resumeState:([A-Za-z_$][\w$]*),threadRuntimeStatus:([A-Za-z_$][\w$]*)\}\)\{return \2\?"loading":\6\?\.type==="systemError"\?"error":\6\?\.type==="active"\?"loading":"needs_resume"===\5\?"idle":\4\?"error":!0===\3\?"loading":"idle"\}/gu;
const REMOTE_TERMINAL_STATUS_PATCHED_PATTERN =
  /function [A-Za-z_$][\w$]*\(\{hasInProgressOwnedWork:[A-Za-z_$][\w$]*,isResponseInProgress:[A-Za-z_$][\w$]*,latestTurnHasSystemError:[A-Za-z_$][\w$]*,resumeState:[A-Za-z_$][\w$]*,threadRuntimeStatus:[A-Za-z_$][\w$]*,hasUserInputRequest:codexLinuxRemoteHasUserInputRequestPending=!0\}\)\{let codexLinuxRemoteTerminalStatusActive=/gu;
const REMOTE_TERMINAL_STATUS_CALL_PATTERN =
  /hasInProgressOwnedWork:[^{}]*latestTurnHasSystemError:([A-Za-z_$][\w$]*)\?\.latestTurnError!=null(?=\}\))/gu;
const REMOTE_TERMINAL_STATUS_PATCHED_CALL_PATTERN =
  /hasInProgressOwnedWork:[^{}]*latestTurnHasSystemError:([A-Za-z_$][\w$]*)\?\.latestTurnError!=null,hasUserInputRequest:codexLinuxRemoteHasUserInputRequest\(\1\?\.requests\)(?=\}\))/gu;
const REMOTE_PENDING_USER_INPUT_PATTERN =
  /("needs_resume"===[A-Za-z_$][\w$]*\?([A-Za-z_$][\w$]*)\?\.type==="active"&&\2\.activeFlags\.includes\("waitingOnApproval"\)&&\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\)\(([A-Za-z_$][\w$]*)\)\?\{blocking:!0,kind:"approval",source:[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\}:\2\?\.type==="active"&&\2\.activeFlags\.includes\("waitingOnUserInput"\))(&&codexLinuxRemoteHasUserInputRequest\(\3\))?(?=\?\{autoResolution:null,blocking:!0,kind:"input",requestId:[A-Za-z_$][\w$]*,source:"userInput"\}:null:)/gu;

// A thread can keep a stale `waitingOnUserInput` runtime flag after its
// mobile-side request was answered or dropped. Linux reports it as loading or
// as an input request only while a user-input request is actually pending.
function applyLinuxRemoteTerminalStatusRecoveryPatch(source) {
  const terminal = [...source.matchAll(REMOTE_TERMINAL_STATUS_PATTERN)];
  const patchedTerminal = [...source.matchAll(REMOTE_TERMINAL_STATUS_PATCHED_PATTERN)];
  const calls = [...source.matchAll(REMOTE_TERMINAL_STATUS_CALL_PATTERN)];
  const patchedCalls = [...source.matchAll(REMOTE_TERMINAL_STATUS_PATCHED_CALL_PATTERN)];
  const pending = [...source.matchAll(REMOTE_PENDING_USER_INPUT_PATTERN)];
  const pristinePending = pending.filter((match) => match[4] == null);
  const helpers = source.split(REMOTE_USER_INPUT_REQUEST_HELPER).length - 1;
  if (terminal.length === 0 && patchedTerminal.length === 1 && calls.length === 0 &&
      patchedCalls.length === 2 && pending.length === 1 && pristinePending.length === 0 && helpers > 0) {
    return source;
  }
  if (terminal.length !== 1 || patchedTerminal.length !== 0 || calls.length !== 2 || patchedCalls.length !== 0 ||
      pending.length !== 1 || pristinePending.length !== 1 || helpers !== 0 ||
      source.includes("codexLinuxRemoteTerminalStatus")) {
    console.warn(
      "WARN: Could not find unique remote terminal status, pending-request, and caller contracts - skipping Linux remote terminal status recovery patch",
    );
    return source;
  }

  const [, fnName, ownedWorkVar, responseProgressVar, systemErrorVar, resumeStateVar, runtimeStatusVar] = terminal[0];
  const terminalReplacement =
    `function ${fnName}({hasInProgressOwnedWork:${ownedWorkVar},isResponseInProgress:${responseProgressVar},latestTurnHasSystemError:${systemErrorVar},resumeState:${resumeStateVar},threadRuntimeStatus:${runtimeStatusVar},hasUserInputRequest:codexLinuxRemoteHasUserInputRequestPending=!0}){` +
    `let codexLinuxRemoteTerminalStatusActive=${runtimeStatusVar}?.type==="active",` +
    `codexLinuxRemoteTerminalStatusActiveFlags=Array.isArray(${runtimeStatusVar}?.activeFlags)?${runtimeStatusVar}.activeFlags:null,` +
    `codexLinuxRemoteTerminalStatusWaitingOnUserInput=codexLinuxRemoteTerminalStatusActiveFlags?.includes("waitingOnUserInput")===!0,` +
    `codexLinuxRemoteTerminalStatusLoading=codexLinuxRemoteTerminalStatusActive&&(${responseProgressVar}===!0||codexLinuxRemoteTerminalStatusActiveFlags==null||codexLinuxRemoteTerminalStatusActiveFlags.length>0&&(!codexLinuxRemoteTerminalStatusWaitingOnUserInput||codexLinuxRemoteHasUserInputRequestPending===!0));` +
    `return ${ownedWorkVar}?"loading":${runtimeStatusVar}?.type==="systemError"?"error":codexLinuxRemoteTerminalStatusLoading?"loading":"needs_resume"===${resumeStateVar}?"idle":${systemErrorVar}?"error":!0===${responseProgressVar}?"loading":"idle"}`;

  const edits = [
    { index: terminal[0].index, length: terminal[0][0].length, replacement: terminalReplacement },
    ...calls.map((call) => ({
      index: call.index,
      length: call[0].length,
      replacement: `${call[0]},hasUserInputRequest:codexLinuxRemoteHasUserInputRequest(${call[1]}?.requests)`,
    })),
    {
      index: pristinePending[0].index,
      length: pristinePending[0][0].length,
      replacement: `${pristinePending[0][1]}&&codexLinuxRemoteHasUserInputRequest(${pristinePending[0][3]})`,
    },
  ];
  // Every module that calls the helper declares its own copy: modules reach
  // each other only through the webpack require function.
  const helperModules = new Map();
  for (const index of [...calls.map((call) => call.index), pristinePending[0].index]) {
    const factory = moduleFactoryAt(source, index);
    if (factory == null) {
      console.warn("WARN: Remote terminal status caller is outside an rspack module factory - skipping Linux remote terminal status recovery patch");
      return source;
    }
    helperModules.set(factory.bodyStart, factory);
  }
  for (const bodyStart of helperModules.keys()) {
    const at = bodyStart + (source.startsWith('"use strict";', bodyStart) ? '"use strict";'.length : 0);
    edits.push({ index: at, length: 0, replacement: REMOTE_USER_INPUT_REQUEST_HELPER });
  }
  edits.sort((left, right) => right.index - left.index);
  return edits.reduce(
    (patched, edit) => patched.slice(0, edit.index) + edit.replacement + patched.slice(edit.index + edit.length),
    source,
  );
}

const REMOTE_CONTROL_STATUS_READ_HELPER =
  `function ${REMOTE_CONTROL_STATUS_READ_GUARD_MARKER}(e){return !(typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)&&typeof e==\`string\`&&(e.startsWith(\`remote-ssh\`)||e.startsWith(\`remote-control:\`)))}`;

function remoteControlStatusReadPattern(patched = false) {
  const I = DEVICE_KEY_IDENT;
  const guard = patched ? `${REMOTE_CONTROL_STATUS_READ_GUARD_MARKER}\\(\\k<host>\\)\\?` : "";
  const blocked = patched
    ? `:\\(\\k<active>\\(\\)&&\\k<setter>\\(\\k<store>,\\k<host>,\\{status:\\x60disabled\\x60,available:!1,accessRequired:!1\\}\\),void 0\\)`
    : "";
  return new RegExp(
    String.raw`function (?<fn>${I})\((?<store>${I}),(?<host>${I}),(?<client>${I}),(?<current>${I})\)\{let (?<resolved>${I});if\(\(0,${I}\.${I}\)\(\k<host>\)\)return\(\)=>\{\}` +
      String.raw`;let (?<abort>${I})=new AbortController,(?<active>${I})=\(\)=>!\k<abort>\.signal\.aborted&&\(\k<current>\?\.\(\)\?\?!0\),(?<initial>${I})=\k<store>\.get\((?<atom>${I}),\k<host>\)` +
      String.raw`,(?<subscription>${I})=\k<client>\.subscribe\(\{type:"notification",key:\{hostId:\k<host>\},methods:"remoteControl/status/changed",listener:\(\{params:(?<params>${I})\}\)=>\{\k<active>\(\)&&(?<setter>${I})\(\k<store>,\k<host>,\k<params>\)\}\}\)` +
      String.raw`,(?<cleanup>${I})=\(\)=>\{\k<abort>\.signal\.aborted\|\|\(\k<abort>\.abort\(\),\k<subscription>\[Symbol\.dispose\]\(\),\k<resolved>\?\.\[Symbol\.dispose\]\(\)\)\}` +
      String.raw`;return \k<subscription>\.onRpcBroken\(\k<cleanup>` +
      String.raw`\),\k<subscription>\.then\((?<ready>${I})=>\{\k<active>\(\)\?\(\k<resolved>=\k<ready>,\k<ready>\.onRpcBroken\(\k<cleanup>\)\):\k<ready>\[Symbol\.dispose\]\(\)\},\k<cleanup>\),` +
      guard +
      String.raw`(?<read>\(0,${I}\.${I}\)\(\k<client>\.sendRequest\("remoteControl/status/read",void 0\),\k<abort>\.signal\)\.then\((?<result>${I})=>\{\k<store>\.get\(\k<atom>,\k<host>\)===\k<initial>&&\k<active>\(\)&&\k<setter>\(\k<store>,\k<host>,\k<result>\)\}\)\.catch\((?<error>${I})=>\{\k<active>\(\)&&${I}\.${I}\.error\("Failed to read remote-control status",\{safe:\{\},sensitive:\{error:\k<error>\}\}\)\}\))` +
      blocked + String.raw`,\k<cleanup>\}`,
    "gu",
  );
}

function applyLinuxRemoteControlStatusReadGuardPatch(source) {
  const pristine = [...source.matchAll(remoteControlStatusReadPattern())];
  const patched = [...source.matchAll(remoteControlStatusReadPattern(true))];
  const helperCount = source.split(REMOTE_CONTROL_STATUS_READ_HELPER).length - 1;
  const markerCount = source.split(REMOTE_CONTROL_STATUS_READ_GUARD_MARKER).length - 1;
  if (pristine.length === 0 && patched.length === 1 && helperCount === 1 && markerCount === 2) {
    return source;
  }
  if (pristine.length !== 1 || patched.length !== 0 || markerCount !== 0) {
    console.warn("WARN: Could not find unique complete remote-control status subscription - skipping Linux remote-control status guard patch");
    return source;
  }
  const [match] = pristine;
  const { host, active, setter, store, read } = match.groups;
  const guardedRead = `${REMOTE_CONTROL_STATUS_READ_GUARD_MARKER}(${host})?${read}:` +
    `(${active}()&&${setter}(${store},${host},{status:\`disabled\`,available:!1,accessRequired:!1}),void 0)`;
  // The helper is a statement-level declaration in the subscription's module.
  return source.slice(0, match.index) + REMOTE_CONTROL_STATUS_READ_HELPER +
    match[0].replace(read, guardedRead) + source.slice(match.index + match[0].length);
}

const REMOTE_CONTROL_STATUS_WAIT_PATTERN =
  /(setTimeout\(\(\)=>\{[A-Za-z_$][\w$]*\(Error\("Timed out waiting for remote control to connect"\)\)\},)5e3\)/gu;

function applyLinuxRemoteControlStatusWaitPatch(source) {
  const markers = source.split(REMOTE_CONTROL_STATUS_WAIT_MARKER).length - 1;
  const matches = [...source.matchAll(REMOTE_CONTROL_STATUS_WAIT_PATTERN)];
  if (markers === 1 && matches.length === 0) {
    return source;
  }
  if (markers !== 0 || matches.length !== 1 || !source.includes('methods:"remoteControl/status/changed"')) {
    console.warn("WARN: Could not find unique remote-control status wait timeout - skipping Linux remote-control status wait patch");
    return source;
  }
  return source.replace(
    REMOTE_CONTROL_STATUS_WAIT_PATTERN,
    `$1typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)?3e4:5e3/*${REMOTE_CONTROL_STATUS_WAIT_MARKER}*/)`,
  );
}

function applyLinuxRemoteControlEnablementBridgePatch(source) {
  if (!matchesLinuxRemoteControlEnablementBridgeContract(source)) {
    console.warn(
      `WARN: Could not uniquely resolve current remote-control enablement bridge owner (owners=${findLinuxRemoteControlEnablementOwners(source).length}) - skipping Linux remote-control bridge patch`,
    );
    return source;
  }
  const [owner] = findLinuxRemoteControlEnablementOwners(source);
  const { gate, enabled, bridge } = owner.groups;
  if (bridge != null) return source;
  if (source.includes(REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER)) {
    console.warn("WARN: Found an incomplete remote-control enablement bridge patch - skipping Linux remote-control bridge patch");
    return source;
  }
  const needle = `let ${enabled}=${gate};return `;
  const needleIndex = owner.index + owner[0].lastIndexOf(needle);
  const replacement =
    `let ${enabled}=${gate}||/*${REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER}*/typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`);return `;
  return source.slice(0, needleIndex) + replacement + source.slice(needleIndex + needle.length);
}

const REMOTE_CONTROL_ENABLE_FOR_HOST_PATTERN =
  /(\.sendRequest\([A-Za-z_$][\w$]*\?"remoteControl\/enable":"remoteControl\/disable",)null\)/gu;

// The remote-control toggle sends `null` params; Linux app servers expect the
// parameterless request shape (`void 0`).
function applyLinuxRemoteControlEnableForHostParamsPatch(source) {
  const markers = source.split(REMOTE_CONTROL_ENABLE_FOR_HOST_PARAMS_MARKER).length - 1;
  const matches = [...source.matchAll(REMOTE_CONTROL_ENABLE_FOR_HOST_PATTERN)];
  if (markers === 1 && matches.length === 0) return source;
  if (markers !== 0 || matches.length !== 1) {
    console.warn("WARN: Could not find unique remote-control enable-for-host request - skipping Linux remote-control host params patch");
    return source;
  }
  return source.replace(
    REMOTE_CONTROL_ENABLE_FOR_HOST_PATTERN,
    `$1void 0/*${REMOTE_CONTROL_ENABLE_FOR_HOST_PARAMS_MARKER}*/)`,
  );
}

const REMOTE_MOBILE_ACTIVE_STATUS_PATTERN =
  /function\(\{latestTurnStatus:([A-Za-z_$][\w$]*),resumeState:([A-Za-z_$][\w$]*),streamRole:([A-Za-z_$][\w$]*),threadRuntimeStatus:([A-Za-z_$][\w$]*)\}\)\{return null==\3\?"needs_resume"===\2\?"needs-resume":"read-only":"follower"===\3\.role\?"follower":\4\?\.type==="active"\|\|"inProgress"===\1\?"active":"inactive"\}/gu;

// Mobile-started turns on the local host have no stream role yet; report them
// as active from the runtime status instead of "needs resume"/"read-only".
function applyLinuxRemoteMobileActiveStatusPatch(source) {
  const markers = source.split(REMOTE_MOBILE_ACTIVE_STATUS_MARKER).length - 1;
  const matches = [...source.matchAll(REMOTE_MOBILE_ACTIVE_STATUS_PATTERN)];
  if (markers === 1 && matches.length === 0) return source;
  if (markers !== 0 || matches.length !== 1) {
    console.warn("WARN: Could not find unique active-status renderer - skipping remote mobile active-status patch");
    return source;
  }
  return source.replace(
    REMOTE_MOBILE_ACTIVE_STATUS_PATTERN,
    `function({latestTurnStatus:$1,resumeState:$2,streamRole:$3,threadRuntimeStatus:$4}){/*${REMOTE_MOBILE_ACTIVE_STATUS_MARKER}*/return $3?.role==="follower"?"follower":$4?.type==="active"||"inProgress"===$1?"active":null==$3?"needs_resume"===$2?"needs-resume":"read-only":"inactive"}`,
  );
}

// Upstream discovers unknown conversations only on cloud hosts and only for
// turn/started and turn/completed. Linux also discovers local-host
// conversations (started from mobile) and buffers their item/started and
// item/completed notifications until the thread is hydrated.
function remoteMobileConversationHydrationGuardPattern({ patched = false, flags = "u" } = {}) {
  const I = DEVICE_KEY_IDENT;
  const marker = patched
    ? `/\\*${REMOTE_MOBILE_CONVERSATION_HYDRATION_MARKER}\\*/`
    : "";
  const hostGuard = patched
    ? '!this\\.manager\\.isCloudHost&&"local"!==this\\.manager\\.getHostId\\(\\)\\|\\|'
    : "!this\\.manager\\.isCloudHost\\|\\|";
  const methodGuard = patched
    ? `"turn/started"!==(?<notification>${I})\\.method&&"turn/completed"!==\\k<notification>\\.method&&` +
      `\\("local"!==this\\.manager\\.getHostId\\(\\)\\|\\|` +
      `"item/started"!==\\k<notification>\\.method&&"item/completed"!==\\k<notification>\\.method\\)`
    : `"turn/started"!==(?<notification>${I})\\.method&&"turn/completed"!==\\k<notification>\\.method`;
  return new RegExp(
    `return null!=(?<pending>${I})\\?\\(\\k<pending>\\.ignored\\.add\\((?<ignore>${I})\\),this\\.buffer\\.buffer\\((?<delivery>${I}),\\k<ignore>\\)\\):` +
      `!\\(${marker}${hostGuard}${methodGuard}\\|\\|` +
      `this\\.context\\.threadStore\\.conversations\\.has\\((?<conversation>${I})\\)\\|\\|` +
      `this\\.context\\.threadStore\\.isConversationSuppressed\\(\\k<conversation>\\)\\)&&` +
      `\\(this\\.beginDiscovery\\(\\k<conversation>,\\k<ignore>\\),this\\.buffer\\.buffer\\(\\k<delivery>,\\k<ignore>\\)\\)\\}`,
    flags,
  );
}

function remoteMobileConversationHydrationContract(source) {
  const pristineMatches = [
    ...source.matchAll(remoteMobileConversationHydrationGuardPattern({ flags: "gu" })),
  ];
  const patchedMatches = [
    ...source.matchAll(remoteMobileConversationHydrationGuardPattern({ patched: true, flags: "gu" })),
  ];
  const markerCount = source.split(REMOTE_MOBILE_CONVERSATION_HYDRATION_MARKER).length - 1;
  const state = markerCount === 0 && pristineMatches.length === 1 && patchedMatches.length === 0
    ? "pristine"
    : markerCount === 1 && pristineMatches.length === 0 && patchedMatches.length === 1
      ? "patched"
      : null;
  if (state == null) return null;

  const match = state === "pristine" ? pristineMatches[0] : patchedMatches[0];
  // The guard belongs to the discovery lifecycle class: it hydrates the
  // discovered thread, releases the buffered notifications, and logs failures.
  const classStart = source.lastIndexOf("class ", match.index);
  const classEnd = classStart === -1 ? -1 : findMatchingBrace(source, source.indexOf("{", classStart));
  if (classEnd === -1 || classEnd < match.index) return null;
  const lifecycle = source.slice(classStart, classEnd + 1);
  if (
    lifecycle.split("this.context.threadStore.hydrateActiveThread(").length - 1 !== 1 ||
    lifecycle.split("this.buffer.release(").length - 1 !== 1 ||
    lifecycle.split("Failed to discover thread from event").length - 1 !== 1
  ) {
    return null;
  }
  return { match, state };
}

function matchesRemoteMobileConversationHydrationContract(source) {
  return remoteMobileConversationHydrationContract(source) != null;
}

function applyLinuxRemoteMobileConversationHydrationPatch(source) {
  const contract = remoteMobileConversationHydrationContract(source);
  if (contract == null) {
    console.warn(
      "WARN: Could not find unique complete conversation-hydration lifecycle - skipping Linux remote mobile hydration patch",
    );
    return source;
  }
  if (contract.state === "patched") return source;

  const { conversation, notification, pending, ignore, delivery } = contract.match.groups;
  const replacement =
    `return null!=${pending}?(${pending}.ignored.add(${ignore}),this.buffer.buffer(${delivery},${ignore})):` +
    `!(/*${REMOTE_MOBILE_CONVERSATION_HYDRATION_MARKER}*/` +
    '!this.manager.isCloudHost&&"local"!==this.manager.getHostId()||' +
    `"turn/started"!==${notification}.method&&"turn/completed"!==${notification}.method&&` +
    `("local"!==this.manager.getHostId()||"item/started"!==${notification}.method&&"item/completed"!==${notification}.method)||` +
    `this.context.threadStore.conversations.has(${conversation})||` +
    `this.context.threadStore.isConversationSuppressed(${conversation}))&&` +
    `(this.beginDiscovery(${conversation},${ignore}),this.buffer.buffer(${delivery},${ignore}))}`;
  return source.slice(0, contract.match.index) + replacement +
    source.slice(contract.match.index + contract.match[0].length);
}

function applyLinuxRemoteMobileReasoningSummaryPatch(source) {
  const logMarker = "Reasoning summary turn-start config resolved";
  const logIndexes = [...source.matchAll(new RegExp(escapeRegExp(logMarker), "gu"))].map(
    (match) => match.index,
  );
  if (logIndexes.length === 0) {
    console.warn(
      "WARN: Could not find reasoning-summary turn-start log marker - skipping Linux remote mobile summary patch",
    );
    return source;
  }
  if (logIndexes.length !== 1) {
    console.warn(
      "WARN: Found ambiguous reasoning-summary resolver/caller contracts - skipping Linux remote mobile summary patch",
    );
    return source;
  }

  const [logIndex] = logIndexes;
  const functionStart = source.lastIndexOf("async function ", logIndex);
  const turnStartPrefix = functionStart === -1 ? "" : source.slice(functionStart, logIndex);
  const currentSummaryPattern =
    /(?<prefix>let |,)(?<summary>[A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.summary\?\?"none";(?<latestSettings>[A-Za-z_$][\w$]*)\?\.summary!==void 0&&\(\k<summary>=\k<latestSettings>\.summary\),null!=(?<runtime>[A-Za-z_$][\w$]*)\.reasoningSummaryOverride&&\(\k<summary>=\k<runtime>\.reasoningSummaryOverride\),\k<summary>=null==(?<modelConfig>[A-Za-z_$][\w$]*)\?null:\k<modelConfig>\.model_reasoning_summary\?\?\k<summary>,void 0!==(?<request>[A-Za-z_$][\w$]*)\.summary&&\(\k<summary>=\k<request>\.summary\);/u;
  const summaryMatches = [
    ...turnStartPrefix.matchAll(new RegExp(currentSummaryPattern.source, "gu")),
  ];
  if (summaryMatches.length === 0) {
    console.warn(
      "WARN: Could not find reasoning-summary turn-start resolver - skipping Linux remote mobile summary patch",
    );
    return source;
  }
  if (summaryMatches.length !== 1) {
    console.warn(
      "WARN: Found ambiguous reasoning-summary resolver/caller contracts - skipping Linux remote mobile summary patch",
    );
    return source;
  }

  const [summaryMatch] = summaryMatches;
  const { request: requestVar, summary: summaryVar } = summaryMatch.groups;
  const functionHeader = turnStartPrefix.match(/async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)[,)]/u);
  const helperName = functionHeader?.[1];
  if (helperName == null) {
    console.warn(
      "WARN: Could not find reasoning-summary turn-start helper - skipping Linux remote mobile summary patch",
    );
    return source;
  }
  const callerPrefix =
    `(?<prefix>${escapeRegExp(helperName)}\\((?<manager>[A-Za-z_$][\\w$]*),` +
      `[A-Za-z_$][\\w$]*,[A-Za-z_$][\\w$]*,[A-Za-z_$][\\w$]*,[A-Za-z_$][\\w$]*,` +
      `(?<conversation>[A-Za-z_$][\\w$]*),\\{)`;
  const callerContract =
    `(?=canUseProjectlessWorkspace:!(?<classifier>\\(0,[A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*\\))\\(\\k<manager>\\.getHostId\\(\\)\\),[\\s\\S]{0,1000}?` +
    `reasoningSummaryOverride:!0===\\k<manager>\\.getDefaultFeatureOverride\\("concurrent_reasoning_summaries"\\)\\|\\|[A-Za-z_$][\\w$]*\\?"detailed":null)`;
  const pristineCallerMatches = [...source.matchAll(new RegExp(callerPrefix + callerContract, "gu"))];
  const patchedCallerPattern = new RegExp(
    callerPrefix +
      `codexLinuxRemoteMobileHost:(?<patchedClassifier>\\(0,[A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*\\))\\(\\k<manager>\\.getHostId\\(\\)\\)&&` +
      `"durable"===\\k<conversation>\\.mode,` +
      `(?=canUseProjectlessWorkspace:!\\k<patchedClassifier>\\(\\k<manager>\\.getHostId\\(\\)\\),[\\s\\S]{0,1000}?` +
      `reasoningSummaryOverride:!0===\\k<manager>\\.getDefaultFeatureOverride\\("concurrent_reasoning_summaries"\\)\\|\\|[A-Za-z_$][\\w$]*\\?"detailed":null)`,
    "gu",
  );
  const patchedCallerMatches = [...source.matchAll(patchedCallerPattern)];

  const patchedResolverSuffix =
    `/*${REMOTE_MOBILE_REASONING_SUMMARY_MARKER}*/` +
    `navigator.userAgent.includes("Linux")&&${summaryMatch.groups.runtime}.codexLinuxRemoteMobileHost&&void 0===${requestVar}.summary&&(${summaryVar}="none");`;
  const absoluteMatchStart = functionStart + summaryMatch.index;
  const absoluteMatchEnd = absoluteMatchStart + summaryMatch[0].length;
  const resolverIsPatched = source.startsWith(patchedResolverSuffix, absoluteMatchEnd);
  const markerCount = source.split(REMOTE_MOBILE_REASONING_SUMMARY_MARKER).length - 1;
  const completePristinePair =
    !resolverIsPatched &&
    markerCount === 0 &&
    pristineCallerMatches.length === 1 &&
    patchedCallerMatches.length === 0;
  const completePatchedPair =
    resolverIsPatched &&
    markerCount === 1 &&
    pristineCallerMatches.length === 0 &&
    patchedCallerMatches.length === 1;

  if (completePatchedPair) {
    return source;
  }
  if (!completePristinePair) {
    console.warn(
      "WARN: Found ambiguous or incomplete reasoning-summary resolver/caller contract - skipping Linux remote mobile summary patch",
    );
    return source;
  }

  const replacement =
    `${summaryMatch[0]}/*${REMOTE_MOBILE_REASONING_SUMMARY_MARKER}*/` +
    `navigator.userAgent.includes("Linux")&&${summaryMatch.groups.runtime}.codexLinuxRemoteMobileHost&&void 0===${requestVar}.summary&&(${summaryVar}="none");`;
  const [currentCallerMatch] = pristineCallerMatches;
  const callerReplacement =
    `${currentCallerMatch.groups.prefix}codexLinuxRemoteMobileHost:` +
    `${currentCallerMatch.groups.classifier}(${currentCallerMatch.groups.manager}.getHostId())&&` +
    `"durable"===${currentCallerMatch.groups.conversation}.mode,`;
  const edits = [
    { index: absoluteMatchStart, length: summaryMatch[0].length, replacement },
    { index: currentCallerMatch.index, length: currentCallerMatch[0].length, replacement: callerReplacement },
  ].sort((left, right) => right.index - left.index);
  return edits.reduce(
    (patched, edit) =>
      `${patched.slice(0, edit.index)}${edit.replacement}${patched.slice(edit.index + edit.length)}`,
    source,
  );
}

// Webview descriptors find their rspack chunks by stable strings (Statsig gate
// ids, IPC methods, log messages, i18n ids); chunk file names identify nothing.
module.exports = [
  {
    id: "linux-remote-control-device-key",
    phase: "main-bundle",
    order: 20_100,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlDeviceKeyPatch,
  },
  {
    id: "linux-remote-control-client-revocation-recovery",
    phase: "main-bundle",
    order: 20_116,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlClientRevocationRecoveryPatch,
  },
  {
    id: "linux-remote-mobile-app-server-remote-control",
    phase: "extracted-app:post-webview",
    order: 20_117,
    ciPolicy: "optional",
    apply: applyLinuxRemoteMobileAppServerRemoteControlExtractedAppPatch,
  },
  {
    id: "linux-remote-control-load-gate",
    phase: "webview-asset",
    assetNeedles: ['"1042620455"', '"features.remote_connections"'],
    assetMatch: matchesLinuxRemoteControlLoadGateContract,
    order: 20_118,
    ciPolicy: "optional",
    missingDescription: "remote-control loader gate bundle",
    skipDescription: "Linux remote-control load gate patch",
    apply: applyLinuxRemoteControlLoadGatePatch,
  },
  {
    id: "linux-remote-control-feature-sync",
    phase: "main-bundle",
    order: 20_119,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlFeatureSyncPatch,
  },
  {
    // Every chunk that embeds the visibility module carries its own copy.
    id: "linux-remote-control-visibility",
    phase: "webview-asset",
    assetNeedles: ["remoteControlConnectionsState:", "slingshotEnabled:", "accessRequired!==!0"],
    order: 20_120,
    ciPolicy: "optional",
    missingDescription: "remote-control connections visibility bundle",
    skipDescription: "Linux remote-control visibility patch",
    apply: applyLinuxRemoteControlVisibilityPatch,
  },
  {
    // The remote connections settings page and the mobile setup dialog.
    id: "linux-remote-control-copy",
    phase: "webview-asset",
    assetNeedles: ['this Mac",description:"'],
    order: 20_130,
    ciPolicy: "optional",
    missingDescription: "remote-control settings or mobile setup bundle",
    skipDescription: "Linux remote-control copy patch",
    apply: applyLinuxRemoteControlCopyPatch,
  },
  {
    id: "linux-remote-control-settings-ux",
    phase: "webview-asset",
    assetNeedles: ['"782640499"', '"settings.remoteConnections.refresh"'],
    order: 20_135,
    ciPolicy: "optional",
    missingDescription: "remote connections settings bundle",
    skipDescription: "Linux remote-control settings UX patch",
    apply: applyLinuxRemoteControlSettingsUxPatch,
  },
  {
    id: "linux-remote-control-client-revoke-setup-reset",
    phase: "webview-asset",
    assetNeedles: ["remote-control-client-revoke-success", "localRemoteControlClientId:"],
    assetMatch: matchesLinuxRemoteControlClientRevokeSetupResetContract,
    order: 20_138,
    ciPolicy: "optional",
    missingDescription: "remote connections settings bundle",
    skipDescription: "Linux remote-control client revoke setup reset patch",
    apply: applyLinuxRemoteControlClientRevokeSetupResetPatch,
  },
  {
    id: "linux-remote-connections-refresh",
    phase: "webview-asset",
    assetNeedles: ['"settings.remoteConnections.refresh"', "window.setInterval("],
    order: 20_140,
    ciPolicy: "optional",
    missingDescription: "remote connections settings bundle",
    skipDescription: "Linux remote-connections refresh patch",
    apply: applyLinuxRemoteConnectionsRefreshPatch,
  },
  {
    id: "linux-remote-mobile-reasoning-summary-none",
    phase: "webview-asset",
    assetNeedles: ["Reasoning summary turn-start config resolved", "reasoningSummaryOverride", "canUseProjectlessWorkspace:"],
    order: 20_149,
    ciPolicy: "optional",
    missingDescription: "turn-start reasoning summary resolver",
    skipDescription: "Linux remote-mobile reasoning summary patch",
    apply: applyLinuxRemoteMobileReasoningSummaryPatch,
  },
  {
    id: "linux-remote-mobile-conversation-hydration",
    phase: "webview-asset",
    assetNeedles: ["Failed to discover thread from event", "this.beginDiscovery("],
    assetMatch: matchesRemoteMobileConversationHydrationContract,
    order: 20_151,
    ciPolicy: "optional",
    missingDescription: "app-server conversation hydration lifecycle",
    skipDescription: "Linux remote-mobile conversation hydration patch",
    apply: applyLinuxRemoteMobileConversationHydrationPatch,
  },
  {
    id: "linux-remote-terminal-status-recovery",
    phase: "webview-asset",
    assetNeedles: ["hasInProgressOwnedWork:", "latestTurnHasSystemError:", "mcpServerElicitationKind:"],
    order: 20_152,
    ciPolicy: "optional",
    missingDescription: "app-server conversation manager bundle",
    skipDescription: "Linux remote terminal status recovery patch",
    apply: applyLinuxRemoteTerminalStatusRecoveryPatch,
  },
  {
    id: "linux-remote-control-status-read-guard",
    phase: "webview-asset",
    assetNeedles: ['"remoteControl/status/read",void 0', "Failed to read remote-control status"],
    order: 20_153,
    ciPolicy: "optional",
    missingDescription: "app-server manager signals bundle",
    skipDescription: "Linux remote-control status read guard patch",
    apply: applyLinuxRemoteControlStatusReadGuardPatch,
  },
  {
    id: "linux-remote-control-status-wait",
    phase: "webview-asset",
    assetNeedles: ["Timed out waiting for remote control to connect"],
    order: 20_154,
    ciPolicy: "optional",
    missingDescription: "app-server manager signals bundle",
    skipDescription: "Linux remote-control status wait patch",
    apply: applyLinuxRemoteControlStatusWaitPatch,
  },
  {
    // The toggle module is embedded in every chunk that offers the toggle.
    id: "linux-remote-control-enable-for-host-params",
    phase: "webview-asset",
    assetNeedles: ['?"remoteControl/enable":"remoteControl/disable"'],
    order: 20_155,
    ciPolicy: "optional",
    missingDescription: "app main remote-control host toggle bundle",
    skipDescription: "Linux remote-control host toggle params patch",
    apply: applyLinuxRemoteControlEnableForHostParamsPatch,
  },
  {
    id: "linux-remote-control-enablement-bridge",
    phase: "webview-asset",
    assetNeedles: ["[remote-connections/gate-bridge]", ".setRemoteControlEnabled("],
    assetMatch: matchesLinuxRemoteControlEnablementBridgeContract,
    order: 20_156,
    ciPolicy: "optional",
    missingDescription: "app main bundle",
    skipDescription: "Linux remote-control enablement bridge patch",
    apply: applyLinuxRemoteControlEnablementBridgePatch,
  },
  {
    id: "linux-remote-control-auto-connect-contract",
    phase: "extracted-app:post-webview",
    order: 20_157,
    ciPolicy: "optional",
    apply: validateLinuxRemoteControlAutoConnectContract,
  },
  {
    id: "linux-remote-mobile-active-status",
    phase: "webview-asset",
    assetNeedles: ['"Read-only snapshot"', "streamRole:"],
    order: 20_160,
    ciPolicy: "optional",
    missingDescription: "app main bundle",
    skipDescription: "Linux remote-mobile active status patch",
    apply: applyLinuxRemoteMobileActiveStatusPatch,
  },
];

module.exports.applyLinuxRemoteControlDeviceKeyPatch = applyLinuxRemoteControlDeviceKeyPatch;
module.exports.applyLinuxRemoteMobileAppServerRemoteControlPatch =
  applyLinuxRemoteMobileAppServerRemoteControlPatch;
module.exports.hasLinuxRemoteMobileLocalAppServerRemoteControlPatch =
  hasLinuxRemoteMobileLocalAppServerRemoteControlPatch;
module.exports.applyLinuxRemoteMobileReasoningSummaryPatch = applyLinuxRemoteMobileReasoningSummaryPatch;
module.exports.applyLinuxRemoteMobileConversationHydrationPatch =
  applyLinuxRemoteMobileConversationHydrationPatch;
module.exports.applyLinuxRemoteTerminalStatusRecoveryPatch = applyLinuxRemoteTerminalStatusRecoveryPatch;
module.exports.applyLinuxRemoteControlStatusReadGuardPatch = applyLinuxRemoteControlStatusReadGuardPatch;
module.exports.applyLinuxRemoteControlStatusWaitPatch = applyLinuxRemoteControlStatusWaitPatch;
module.exports.applyLinuxRemoteControlEnablementBridgePatch = applyLinuxRemoteControlEnablementBridgePatch;
module.exports.matchesLinuxRemoteControlEnablementBridgeContract =
  matchesLinuxRemoteControlEnablementBridgeContract;
module.exports.validateLinuxRemoteControlAutoConnectContract =
  validateLinuxRemoteControlAutoConnectContract;
module.exports.applyLinuxRemoteControlEnableForHostParamsPatch =
  applyLinuxRemoteControlEnableForHostParamsPatch;
module.exports.applyLinuxRemoteMobileActiveStatusPatch = applyLinuxRemoteMobileActiveStatusPatch;
module.exports.applyLinuxRemoteControlClientRevocationRecoveryPatch =
  applyLinuxRemoteControlClientRevocationRecoveryPatch;
module.exports.applyLinuxRemoteControlClientRevokeSetupResetPatch =
  applyLinuxRemoteControlClientRevokeSetupResetPatch;
module.exports.applyLinuxRemoteControlLoadGatePatch = applyLinuxRemoteControlLoadGatePatch;
module.exports.applyLinuxRemoteConnectionsRefreshPatch = applyLinuxRemoteConnectionsRefreshPatch;
module.exports.applyLinuxRemoteControlFeatureSyncPatch = applyLinuxRemoteControlFeatureSyncPatch;
module.exports.applyLinuxRemoteControlVisibilityPatch = applyLinuxRemoteControlVisibilityPatch;
module.exports.applyLinuxRemoteControlCopyPatch = applyLinuxRemoteControlCopyPatch;
module.exports.applyLinuxRemoteControlSettingsUxPatch = applyLinuxRemoteControlSettingsUxPatch;
