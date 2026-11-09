"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { prepareDeviceKeySource, applyDeviceKeyToExtractedApp } = require("./device-key-owner.js");
const { prepareRemoteLoadGateSource, applyRemoteLoadGate } = require("./remote-load-gate.js");
const { applyHostToggleSource, applyHostTogglePatch } = require("./host-toggle.js");
const { applyRemoteMobileVisibility: applyLinuxRemoteControlVisibilityPatch } = require("./remote-control-visibility.js");
const { prepareFeatureSyncSource, applyFeatureSyncToExtractedApp } = require("./feature-sync-owner.js");
const { prepareRevokeSetupResetSource, applyRevokeSetupReset } = require("./revoke-setup-reset-owner.js");
const { prepareBridgeSource, applyBridgePatch } = require("./enablement-bridge.js");
const { applyNativeRemoteCopy } = require("./remote-copy.js");
const { applyOutboundTab } = require("./outbound-tab-owner.js");
const { applyConnectionsRefresh } = require("./connections-refresh-owner.js");
const { applyAutoConnect } = require("./auto-connect-contract.js");
const { prepareStatusReadString, applyStatusReadPatch } = require("./host-status.js");
const { prepareStatusWaitString, applyStatusWaitPatch } = require("./host-status-wait.js");
const { prepareTerminalSource, applyTerminalStatus } = require("./terminal-status.js");
const { prepareSummaryLayerSource, applySummaryLayer } = require("./summary-contract.js");
const { prepareHydrationSource, applyHydration } = require("./hydration-owner.js");
const { prepareActiveStatusSource, applyActiveStatus } = require("./active-status-owner.js");

const DEVICE_KEY_CLIENT_MARKER = "codexLinuxRemoteControlDeviceKeyClient";
const DEVICE_KEY_IDENT = "[A-Za-z_$][\\w$]*";
const DEVICE_KEY_ADDON_MARKER = "codexLinuxRemoteControlDeviceKeyAddon";

const REMOTE_CONTROL_AUTO_CONNECT_CLEANUP_MARKER = "codexLinuxRemoteControlAutoConnectCleanup";
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
    `function ${DEVICE_KEY_CLIENT_MARKER}(e,t){let n=new e(null),r=t.parse(${DEVICE_KEY_ADDON_MARKER}());return n.getAddon=()=>r,n}`,
  ].join("");
}

function remoteDeviceKeyRuntimeSource() {
  return linuxDeviceKeyProviderSource({
    childProcessVar: "codexLinuxRemoteControlChildProcess",
    cryptoVar: "codexLinuxRemoteControlCrypto",
    fsVar: "codexLinuxRemoteControlFs",
    pathVar: "codexLinuxRemoteControlPath",
  });
}

function applyLinuxRemoteControlDeviceKeyPatch(source) {
  return prepareDeviceKeySource(source, remoteDeviceKeyRuntimeSource()).patchedSource;
}
function applyLinuxRemoteControlDeviceKeyExtractedApp(extractedDir, context = {}) {
  return applyDeviceKeyToExtractedApp(extractedDir, remoteDeviceKeyRuntimeSource(), context.deviceKeyWriteOptions);
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

// Successful local revoke owns the setup reset; the complete native query,
// row mutation and late application-state service remain the authority.
function applyLinuxRemoteControlClientRevokeSetupResetPatch(source) {
  return prepareRevokeSetupResetSource(source).patchedSource;
}
function applyLinuxRemoteControlClientRevokeSetupResetExtractedAppPatch(extractedDir, context = {}) {
  return applyRevokeSetupReset(extractedDir, context.revokeSetupResetWriteOptions);
}



function matchesLinuxRemoteControlEnablementBridgeContract(source, context = {}) {
  try { prepareBridgeSource(source, context); return true; } catch { return false; }
}

// Native main state and the actual Settings controls jointly own auto-connect.
// Qualification is a complete no-op cohort, including every late facade copy.
function validateLinuxRemoteControlAutoConnectContract(extractedDir, context = {}) {
  return applyAutoConnect(extractedDir, context.autoConnectReadOptions);
}

function applyLinuxRemoteControlLoadGatePatch(source) {
  return prepareRemoteLoadGateSource(source).patchedSource;
}
function applyLinuxRemoteControlLoadGateExtractedAppPatch(extractedDir, context = {}) {
  return applyRemoteLoadGate(extractedDir, context.loadGateWriteOptions);
}

// Keep the native live connection/assignment transaction; only its supplied
// local-host enablement gains the Linux remote_control alternative.
function applyLinuxRemoteControlFeatureSyncPatch(source) {
  return prepareFeatureSyncSource(source).patchedSource;
}
function applyLinuxRemoteControlFeatureSyncExtractedAppPatch(extractedDir, context = {}) {
  return applyFeatureSyncToExtractedApp(extractedDir, context.featureSyncWriteOptions);
}

// Native Linux already selects PC copy and hides macOS-only locked Computer Use.
// The extracted-app validator must qualify the complete selected copy cohort.
function applyLinuxRemoteControlCopyPatch(extractedDir, context = {}) {
  return applyNativeRemoteCopy(extractedDir, context.remoteCopyWriteOptions);
}

function applyLinuxRemoteControlSettingsUxPatch(extractedDir, context = {}) {
  return applyOutboundTab(extractedDir, context.outboundTabWriteOptions);
}

// The settings page polls remote connections every 15s from an effect
// (`window.setInterval(()=>{n()},15e3)`). Linux polls every 5s and also
// refreshes when the window becomes visible, focused, online, or resumes.
function applyLinuxRemoteConnectionsRefreshPatch(extractedDir, context = {}) {
  return applyConnectionsRefresh(extractedDir, context.connectionsRefreshWriteOptions);
}

// The complete native host/thread state cohort owns terminal recovery.
function applyLinuxRemoteTerminalStatusRecoveryPatch(source) {
  return prepareTerminalSource(source);
}
function applyLinuxRemoteTerminalStatusRecoveryExtractedAppPatch(extractedDir, context = {}) {
  return applyTerminalStatus(extractedDir, context.terminalStatusWriteOptions);
}



function applyLinuxRemoteControlStatusReadGuardPatch(source, context = {}) {
  return prepareStatusReadString(source, context);
}

// Keep the native supplied-host status watcher and settlement lifetime. Only
// its timeout scalar changes after the complete reader/lifecycle cohort qualifies.
function applyLinuxRemoteControlStatusWaitPatch(source, context = {}) {
  return prepareStatusWaitString(source, context);
}
function applyLinuxRemoteControlStatusWaitExtractedAppPatch(extractedDir, context = {}) {
  return applyStatusWaitPatch(extractedDir, context.statusWaitWriteOptions);
}

function applyLinuxRemoteControlEnablementBridgePatch(source, context = {}) {
  return prepareBridgeSource(source, context);
}

// Keep the native selected-host client and status race logic. Only the owned
// parameter scalar changes; the registered entry qualifies the complete cohort.
function applyLinuxRemoteControlEnableForHostParamsPatch(source, context = {}) {
  return applyHostToggleSource(source, context);
}

// Keep the native published row, keyed selector calls, flags and badge path.
// Only the existing indicator's status precedence changes before role assignment.
function applyLinuxRemoteMobileActiveStatusPatch(source) {
  try { return prepareActiveStatusSource(source); }
  catch (error) {
    console.warn(`WARN: Linux remote-mobile active status: ${error.message}`);
    return source;
  }
}
function applyLinuxRemoteMobileActiveStatusExtractedAppPatch(extractedDir, context = {}) {
  return applyActiveStatus(extractedDir, context.activeStatusWriteOptions);
}

// Keep the native per-manager discovery/queue/replay lifecycle. Only the
// literal-local notification gate gains item-started/completed discovery.
function applyLinuxRemoteMobileConversationHydrationPatch(source) {
  try { return prepareHydrationSource(source); }
  catch (error) {
    console.warn(`WARN: Linux remote-mobile conversation hydration: ${error.message}`);
    return source;
  }
}
function applyLinuxRemoteMobileConversationHydrationExtractedAppPatch(extractedDir, context = {}) {
  return applyHydration(extractedDir, context.hydrationWriteOptions);
}

function applyLinuxRemoteMobileReasoningSummaryPatch(source) {
  try {
    return prepareSummaryLayerSource(source, "mobile").patchedSource;
  } catch (error) {
    console.warn(`WARN: Linux remote-mobile reasoning summary contract: ${error.message}`);
    return source;
  }
}

function applyLinuxRemoteMobileReasoningSummaryExtractedAppPatch(extractedDir, context = {}) {
  return applySummaryLayer(extractedDir, "mobile", context.reasoningSummaryWriteOptions);
}

// Webview descriptors find their rspack chunks by stable strings (Statsig gate
// ids, IPC methods, log messages, i18n ids); chunk file names identify nothing.
module.exports = [
  {
    id: "linux-remote-control-device-key",
    phase: "extracted-app:pre-webview",
    order: 20_100,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlDeviceKeyExtractedApp,
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
    phase: "extracted-app:pre-webview",
    order: 20_118,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlLoadGateExtractedAppPatch,
  },
  {
    id: "linux-remote-control-feature-sync",
    phase: "extracted-app:pre-webview",
    order: 20_119,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlFeatureSyncExtractedAppPatch,
  },
  {
    // Every chunk that embeds the visibility module carries its own copy.
    id: "linux-remote-control-visibility",
    phase: "extracted-app:pre-webview",
    order: 20_120,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlVisibilityPatch,
  },
  {
    // Qualify the native Linux PC branches, peer instructions and search data.
    id: "linux-remote-control-copy",
    phase: "extracted-app:pre-webview",
    order: 20_130,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlCopyPatch,
  },
  {
    id: "linux-remote-control-settings-ux",
    phase: "extracted-app:pre-webview",
    order: 20_135,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlSettingsUxPatch,
  },
  {
    id: "linux-remote-control-client-revoke-setup-reset",
    phase: "extracted-app:pre-webview",
    order: 20_138,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlClientRevokeSetupResetExtractedAppPatch,
  },
  {
    id: "linux-remote-connections-refresh",
    phase: "extracted-app:pre-webview",
    order: 20_140,
    ciPolicy: "optional",
    apply: applyLinuxRemoteConnectionsRefreshPatch,
  },
  {
    id: "linux-remote-mobile-reasoning-summary-none",
    phase: "extracted-app:pre-webview",
    order: 20_149,
    ciPolicy: "optional",
    apply: applyLinuxRemoteMobileReasoningSummaryExtractedAppPatch,
  },
  {
    id: "linux-remote-mobile-conversation-hydration",
    phase: "extracted-app:pre-webview",
    order: 20_151,
    ciPolicy: "optional",
    apply: applyLinuxRemoteMobileConversationHydrationExtractedAppPatch,
  },
  {
    id: "linux-remote-terminal-status-recovery",
    phase: "extracted-app:pre-webview",
    order: 20_152,
    ciPolicy: "optional",
    apply: applyLinuxRemoteTerminalStatusRecoveryExtractedAppPatch,
  },
  {
    id: "linux-remote-control-status-read-guard",
    phase: "extracted-app:pre-webview",
    order: 20_153,
    ciPolicy: "optional",
    apply: applyStatusReadPatch,
  },
  {
    id: "linux-remote-control-status-wait",
    phase: "extracted-app:pre-webview",
    order: 20_154,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlStatusWaitExtractedAppPatch,
  },
  {
    id: "linux-remote-control-enable-for-host-params",
    phase: "extracted-app:pre-webview",
    order: 20_155,
    ciPolicy: "optional",
    apply: applyHostTogglePatch,
  },
  {
    id: "linux-remote-control-enablement-bridge",
    phase: "extracted-app:pre-webview",
    order: 20_156,
    ciPolicy: "optional",
    apply: applyBridgePatch,
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
    phase: "extracted-app:pre-webview",
    order: 20_160,
    ciPolicy: "optional",
    apply: applyLinuxRemoteMobileActiveStatusExtractedAppPatch,
  },
];

module.exports.applyLinuxRemoteControlDeviceKeyPatch = applyLinuxRemoteControlDeviceKeyPatch;
module.exports.applyLinuxRemoteMobileAppServerRemoteControlPatch =
  applyLinuxRemoteMobileAppServerRemoteControlPatch;
module.exports.hasLinuxRemoteMobileLocalAppServerRemoteControlPatch =
  hasLinuxRemoteMobileLocalAppServerRemoteControlPatch;
module.exports.applyLinuxRemoteMobileReasoningSummaryPatch = applyLinuxRemoteMobileReasoningSummaryPatch;
module.exports.applyLinuxRemoteMobileReasoningSummaryExtractedAppPatch = applyLinuxRemoteMobileReasoningSummaryExtractedAppPatch;
module.exports.applyLinuxRemoteMobileConversationHydrationPatch =
  applyLinuxRemoteMobileConversationHydrationPatch;
module.exports.applyLinuxRemoteMobileConversationHydrationExtractedAppPatch = applyLinuxRemoteMobileConversationHydrationExtractedAppPatch;
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
module.exports.applyLinuxRemoteMobileActiveStatusExtractedAppPatch = applyLinuxRemoteMobileActiveStatusExtractedAppPatch;
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

module.exports.applyLinuxRemoteControlDeviceKeyExtractedApp = applyLinuxRemoteControlDeviceKeyExtractedApp;

module.exports.applyLinuxRemoteControlLoadGateExtractedAppPatch = applyLinuxRemoteControlLoadGateExtractedAppPatch;

module.exports.applyLinuxRemoteControlFeatureSyncExtractedAppPatch = applyLinuxRemoteControlFeatureSyncExtractedAppPatch;

module.exports.applyLinuxRemoteControlClientRevokeSetupResetExtractedAppPatch = applyLinuxRemoteControlClientRevokeSetupResetExtractedAppPatch;

module.exports.applyLinuxRemoteTerminalStatusRecoveryExtractedAppPatch = applyLinuxRemoteTerminalStatusRecoveryExtractedAppPatch;
