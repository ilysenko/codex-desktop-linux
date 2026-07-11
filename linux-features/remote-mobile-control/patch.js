"use strict";

const fs = require("node:fs");
const path = require("node:path");

function requireName(source, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`([A-Za-z_$][\\w$]*)=require\\(\`${escaped}\`\\)`));
  return match?.[1] ?? null;
}

const DEVICE_KEY_CLIENT_MARKER = "codexLinuxRemoteControlDeviceKeyClient";
const DEVICE_KEY_GUARD =
  "if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);";
const DEVICE_KEY_GUARD_REPLACEMENT =
  "if(process.platform===`linux`)return codexLinuxRemoteControlDeviceKeyClient();if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);";
const DEVICE_KEY_REQUIRE_NEEDLE =
  /(?:var|let|const)\s+[A-Za-z_$][\w$]*=\(0,[A-Za-z_$][\w$]*\.createRequire\)\(__filename\),[A-Za-z_$][\w$]*=`remote-control-device-key\.node`/u;
const REMOTE_CONTROL_VISIBILITY_NEEDLE =
  "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
const REMOTE_CONTROL_VISIBILITY_REPLACEMENT =
  "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){let n=typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`);return(n||t)&&(n||(e?.available??!0))&&e?.accessRequired!==!0}";
const REMOTE_CONTROL_VISIBILITY_OLD_REPLACEMENT =
  "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){let n=typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`);return t&&(n||(e?.available??!0))&&e?.accessRequired!==!0}";
const REMOTE_CONTROL_SETTINGS_VISIBILITY_NEEDLE =
  /function ([A-Za-z_$][\w$]*)\(\{remoteControlConnectionsState:([A-Za-z_$][\w$]*),slingshotEnabled:([A-Za-z_$][\w$]*)\}\)\{return \3&&\(\2\?\.available\?\?!0\)(?:&&\2\?\.accessRequired!==!0)?\}/u;
const REMOTE_CONTROL_SETTINGS_UX_MARKER = "codexLinuxRemoteControlSettingsTabs";
const REMOTE_CONTROL_SETTINGS_TABS_HELPER =
  "function codexLinuxRemoteControlSettingsTabs(e){return e}";
const REMOTE_CONTROL_SETTINGS_TABS_OLD_HELPER =
  "function codexLinuxRemoteControlSettingsTabs(e){return typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`)?e.filter(e=>e.key!==`access-other-devices`):e}";
const REMOTE_CONTROL_SSH_INSTALL_ACTION_MARKER = "codexLinuxRemoteControlSshInstallActions";
const REMOTE_CONTROL_SSH_INSTALL_RELEASE_MARKER = "codexLinuxRemoteControlSshInstallRelease";
const REMOTE_CONNECTIONS_REFRESH_MARKER = "codexLinuxRemoteConnectionsRefreshNow";
const REMOTE_MOBILE_CHROME_BRIDGE_MARKER = "codexLinuxRemoteMobileBrowserBackends";
const REMOTE_CONTROL_LOAD_GATE_MARKER = "codexLinuxRemoteControlLoadGateEnabled";
const REMOTE_CONTROL_FEATURE_SYNC_MARKER = "codexLinuxRemoteControlFeatureSyncEnabled";
const REMOTE_CONTROL_FEATURE_SYNC_HOST_SCOPE_MARKER = "codexLinuxRemoteControlFeatureSyncHostScoped";
const REMOTE_CONTROL_LOAD_GATE_NEEDLE =
  /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\(`1042620455`\)\}/u;
const REMOTE_MOBILE_THREAD_RUNTIME_MARKER = "codexLinuxRemoteMobileThreadRuntimeStatus";
const REMOTE_MOBILE_UNKNOWN_TURN_MARKER = "codexLinuxRemoteMobileHydrateUnknownTurn";
const REMOTE_MOBILE_NOTIFICATION_QUEUE_MARKER = "codexLinuxRemoteMobileNotificationQueue";
const REMOTE_MOBILE_IN_FLIGHT_HYDRATION_MARKER = "codexLinuxRemoteMobileHydrationInFlight";
const REMOTE_MOBILE_LATE_EVENT_HYDRATION_MARKER = "codexLinuxRemoteMobileHydrateLateEvent";
const REMOTE_MOBILE_COMPLETED_ITEM_MARKER = "codexLinuxCompletedItemExists=";
const REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER = "codexLinuxRemoteControlEnablementBridge";
const REMOTE_CONTROL_ENABLE_FOR_HOST_PARAMS_MARKER = "codexLinuxRemoteControlEnableForHostParams";
const REMOTE_CONTROL_AUTO_CONNECT_CLEANUP_MARKER = "codexLinuxRemoteControlAutoConnectCleanup";
const REMOTE_CONTROL_SELF_AUTO_CONNECT_MARKER = "codexLinuxRemoteControlSelfAutoConnect";
const REMOTE_MOBILE_ACTIVE_STATUS_MARKER = "codexLinuxRemoteMobileActiveStatus";
const REMOTE_CONTROL_STATUS_READ_GUARD_MARKER = "codexLinuxRemoteControlShouldReadStatus";
const REMOTE_CONTROL_STATUS_WAIT_MARKER = "codexLinuxRemoteControlStatusWaitMs";
const REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER = "codexLinuxRemoteControlResetMobileSetupAfterRevoke";
const REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER = "codexLinuxRemoteMobileAppServerArgs";
const REMOTE_MOBILE_APP_SERVER_ARGS_NEEDLE =
  "[`-c`,`features.code_mode_host=true`,`app-server`,`--analytics-default-enabled`]";
const REMOTE_MOBILE_CONVERSATION_ASSET_PATTERN =
  /^app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~[^.]+\.js$/u;
const REMOTE_CONTROL_SELECTED_TAB_NEEDLE =
  "function rr({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}";
const REMOTE_CONTROL_SELECTED_TAB_REPLACEMENT =
  "function rr({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){let i=typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`);if(i){if(!n)return`ssh`;if(e===`control-this-mac`&&!t)return`access-other-devices`;if(e===`ssh`&&!r)return`access-other-devices`;return e}return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}";
const REMOTE_CONTROL_SELECTED_TAB_REGEX =
  /function ([A-Za-z_$][\w$]*)\(\{selectedConnectionsTab:([A-Za-z_$][\w$]*),showControlThisMacTab:([A-Za-z_$][\w$]*),showRemoteControlConnectionsSection:([A-Za-z_$][\w$]*),showTabbedSshPage:([A-Za-z_$][\w$]*)\}\)\{return \4\?\2===`control-this-mac`&&!\3\|\|\2===`ssh`&&!\5\?`access-other-devices`:\2:`ssh`\}/u;
const REMOTE_CONTROL_SELECTED_TAB_MARKER = "codexLinuxRemoteControlSelectedTab";
const REMOTE_CONTROL_LINUX_COPY_REPLACEMENTS = [
  ["defaultMessage:`Mac`", "defaultMessage:`Linux`"],
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
  ["Connect a device to this Mac", "Connect a device to this Linux desktop"],
  ["Connect your phone to this Mac", "Connect your phone to this Linux desktop"],
  ["Add device to control this Mac remotely", "Add a device to control this Linux desktop remotely"],
  ["Keep Mac awake", "Keep Linux desktop awake"],
  ["this Mac", "this Linux desktop"],
  ["local Mac", "local Linux desktop"],
];
const CLIENT_ACCOUNT_COMPAT_MARKER = "codexLinuxRemoteControlAccountMatches";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceOnce(source, needle, replacement) {
  if (!source.includes(needle)) {
    return null;
  }
  return source.replace(needle, replacement);
}

function linuxRemoteControlClientAccountCompatibilityHelpers(loadEnrollmentFn, enrollmentKeyFn) {
  return [
    "function codexLinuxRemoteControlEnrollmentAccountUserIds(e){",
    "return[...new Set([e.tokenAccountUserId,e.tokenAuthUserId].filter(e=>e!=null))]",
    "}",
    "function codexLinuxRemoteControlAccountMatches({candidateAccountId:e,candidateAccountUserId:t,candidateUserId:n,expectedAccountId:r,expectedAccountUserId:i}){",
    "return t===i||r!=null&&e===r&&n===i",
    "}",
    "async function codexLinuxRemoteControlLoadEnrollment({authIdentity:e,deviceKeyClient:t,enrollmentKey:n,globalState:r}){",
    `let i=(await Promise.all(codexLinuxRemoteControlEnrollmentAccountUserIds(e).map(async e=>{let i=${enrollmentKeyFn}(n,e);return{enrollment:await ${loadEnrollmentFn}({deviceKeyClient:t,enrollmentKey:i,globalState:r}),enrollmentRecordKey:i}}))).find(e=>e.enrollment!=null);`,
    "return i?.enrollment==null?null:i",
    "}",
  ].join("");
}

function linuxDeviceKeyProviderSource({ cryptoVar, fsVar, pathVar }) {
  return [
    "function codexLinuxRemoteControlDeviceKeyStorePath(){",
    `let codexLinuxRemoteControlConfigRoot=process.env.XDG_CONFIG_HOME&&process.env.XDG_CONFIG_HOME.trim()?process.env.XDG_CONFIG_HOME.trim():process.env.HOME?${pathVar}.join(process.env.HOME,\`.config\`):null;`,
    "if(codexLinuxRemoteControlConfigRoot==null)throw Error(`Linux remote control device keys require HOME or XDG_CONFIG_HOME`);",
    `${fsVar}.mkdirSync(${pathVar}.join(codexLinuxRemoteControlConfigRoot,\`codex-desktop\`),{recursive:!0,mode:448});`,
    `return ${pathVar}.join(codexLinuxRemoteControlConfigRoot,\`codex-desktop\`,\`remote-control-device-keys-v1.json\`)`,
    "}",
    "function codexLinuxRemoteControlPublicDeviceKey(codexLinuxRemoteControlKeyRecord){",
    "return{algorithm:codexLinuxRemoteControlKeyRecord.algorithm,keyId:codexLinuxRemoteControlKeyRecord.keyId,protectionClass:codexLinuxRemoteControlKeyRecord.protectionClass,publicKeySpkiDerBase64:codexLinuxRemoteControlKeyRecord.publicKeySpkiDerBase64}",
    "}",
    "function codexLinuxReadRemoteControlDeviceKeyStore(){",
    "let codexLinuxRemoteControlKeyStorePath=codexLinuxRemoteControlDeviceKeyStorePath();",
    `if(!${fsVar}.existsSync(codexLinuxRemoteControlKeyStorePath))return{keys:{}};`,
    "try{",
    `let codexLinuxRemoteControlKeyStore=JSON.parse(${fsVar}.readFileSync(codexLinuxRemoteControlKeyStorePath,\`utf8\`));`,
    "return codexLinuxRemoteControlKeyStore&&typeof codexLinuxRemoteControlKeyStore==`object`&&!Array.isArray(codexLinuxRemoteControlKeyStore)&&codexLinuxRemoteControlKeyStore.keys&&typeof codexLinuxRemoteControlKeyStore.keys==`object`&&!Array.isArray(codexLinuxRemoteControlKeyStore.keys)?codexLinuxRemoteControlKeyStore:{keys:{}}",
    "}catch{return{keys:{}}}",
    "}",
    "function codexLinuxWriteRemoteControlDeviceKeyStore(codexLinuxRemoteControlKeyStore){",
    "let codexLinuxRemoteControlKeyStorePath=codexLinuxRemoteControlDeviceKeyStorePath(),codexLinuxRemoteControlTempPath=`${codexLinuxRemoteControlKeyStorePath}.tmp-${process.pid}-${Date.now()}`;",
    `try{${fsVar}.writeFileSync(codexLinuxRemoteControlTempPath,JSON.stringify(codexLinuxRemoteControlKeyStore,null,2)+\`\\n\`,{encoding:\`utf8\`,mode:384}),${fsVar}.chmodSync(codexLinuxRemoteControlTempPath,384),${fsVar}.renameSync(codexLinuxRemoteControlTempPath,codexLinuxRemoteControlKeyStorePath),${fsVar}.chmodSync(codexLinuxRemoteControlKeyStorePath,384)}catch(codexLinuxRemoteControlWriteError){try{${fsVar}.rmSync(codexLinuxRemoteControlTempPath,{force:!0})}catch{}throw codexLinuxRemoteControlWriteError}`,
    "}",
    "function codexLinuxRemoteControlDeviceKeyClient(){return{",
    "createDeviceKey:async codexLinuxRemoteControlProtectionClass=>{",
    "let codexLinuxRemoteControlKeyStore=codexLinuxReadRemoteControlDeviceKeyStore();",
    `let codexLinuxRemoteControlKeyPair=(0,${cryptoVar}.generateKeyPairSync)(\`ec\`,{namedCurve:\`P-256\`}),codexLinuxRemoteControlPublicKey=codexLinuxRemoteControlKeyPair.publicKey,codexLinuxRemoteControlSigningKey=codexLinuxRemoteControlKeyPair[\`private\`+\`Key\`];`,
    `let codexLinuxRemoteControlKeyId=(0,${cryptoVar}.randomUUID)(),codexLinuxRemoteControlPublicKeySpkiDerBase64=codexLinuxRemoteControlPublicKey.export({type:\`spki\`,format:\`der\`}).toString(\`base64\`),codexLinuxRemoteControlSigningKeyPkcs8Pem=codexLinuxRemoteControlSigningKey.export({type:\`pkcs8\`,format:\`pem\`});`,
    "let codexLinuxRemoteControlKeyRecord={algorithm:`ecdsa_p256_sha256`,keyId:codexLinuxRemoteControlKeyId,protectionClass:`os_protected_nonextractable`,publicKeySpkiDerBase64:codexLinuxRemoteControlPublicKeySpkiDerBase64,privateKeyPkcs8Pem:codexLinuxRemoteControlSigningKeyPkcs8Pem,createdAt:new Date().toISOString()};",
    "codexLinuxRemoteControlKeyStore.keys={...codexLinuxRemoteControlKeyStore.keys,[codexLinuxRemoteControlKeyId]:codexLinuxRemoteControlKeyRecord},codexLinuxWriteRemoteControlDeviceKeyStore(codexLinuxRemoteControlKeyStore);",
    "return codexLinuxRemoteControlPublicDeviceKey(codexLinuxRemoteControlKeyRecord)",
    "},",
    "deleteDeviceKey:async codexLinuxRemoteControlKeyId=>{let codexLinuxRemoteControlKeyStore=codexLinuxReadRemoteControlDeviceKeyStore();codexLinuxRemoteControlKeyStore.keys&&delete codexLinuxRemoteControlKeyStore.keys[codexLinuxRemoteControlKeyId],codexLinuxWriteRemoteControlDeviceKeyStore(codexLinuxRemoteControlKeyStore)},",
    "getDeviceKeyPublic:async codexLinuxRemoteControlKeyId=>{let codexLinuxRemoteControlKeyRecord=codexLinuxReadRemoteControlDeviceKeyStore().keys?.[codexLinuxRemoteControlKeyId];if(codexLinuxRemoteControlKeyRecord==null)throw Error(`Linux remote control device key not found`);return codexLinuxRemoteControlPublicDeviceKey(codexLinuxRemoteControlKeyRecord)},",
    `signDeviceKey:async(codexLinuxRemoteControlKeyId,codexLinuxRemoteControlPayload)=>{let codexLinuxRemoteControlKeyRecord=codexLinuxReadRemoteControlDeviceKeyStore().keys?.[codexLinuxRemoteControlKeyId];if(codexLinuxRemoteControlKeyRecord==null)throw Error(\`Linux remote control device key not found\`);let codexLinuxRemoteControlSigningKey=(0,${cryptoVar}.createPrivateKey)(codexLinuxRemoteControlKeyRecord.privateKeyPkcs8Pem),codexLinuxRemoteControlSignatureDerBase64=(0,${cryptoVar}.sign)(\`sha256\`,codexLinuxRemoteControlPayload,codexLinuxRemoteControlSigningKey).toString(\`base64\`);return{algorithm:codexLinuxRemoteControlKeyRecord.algorithm,signatureDerBase64:codexLinuxRemoteControlSignatureDerBase64}}`,
    "}}",
  ].join("");
}

function applyLinuxRemoteControlDeviceKeyPatch(source) {
  if (source.includes(DEVICE_KEY_CLIENT_MARKER)) {
    return source;
  }

  const cryptoVar = requireName(source, "node:crypto");
  const fsVar = requireName(source, "node:fs");
  const pathVar = requireName(source, "node:path");
  if (cryptoVar == null || fsVar == null || pathVar == null) {
    console.warn("WARN: Could not find Node module aliases - skipping Linux remote-control device-key patch");
    return source;
  }

  const insertionNeedle = source.match(DEVICE_KEY_REQUIRE_NEEDLE)?.[0] ?? null;
  if (insertionNeedle == null || !source.includes(DEVICE_KEY_GUARD)) {
    console.warn("WARN: Could not find remote-control device-key bundle needles - skipping Linux remote-control device-key patch");
    return source;
  }

  const provider = linuxDeviceKeyProviderSource({ cryptoVar, fsVar, pathVar });
  return source
    .replace(insertionNeedle, `${provider}${insertionNeedle}`)
    .replace(DEVICE_KEY_GUARD, DEVICE_KEY_GUARD_REPLACEMENT);
}

function applyLinuxRemoteControlClientAccountCompatibilityPatch(source) {
  if (source.includes(CLIENT_ACCOUNT_COMPAT_MARKER)) {
    return source;
  }

  if (
    source.includes("function ep({authIdentity:e,connectionKey:t,deviceKeyClient:n,globalState:r})") &&
    source.includes("Promise.all(tp(e).map(async e=>{let i=jf(t,e);") &&
    source.includes("function tp(e){if(e.tokenAccountUserId==null)return[];") &&
    source.includes("tokenAuthUserId!==e.tokenAccountUserId&&t.push(e.tokenAuthUserId)") &&
    source.includes("u.account_user_id!==c&&!(s.tokenAccountId!=null&&s.headerChatGptAccountId===s.tokenAccountId&&s.tokenAuthUserId===u.account_user_id)")
  ) {
    return source;
  }
  if (
    source.includes("function tp({authIdentity:e,connectionKey:t,deviceKeyClient:n,globalState:r}){let i=(await Promise.all(np(e).map(async e=>{let i=Mf(t,e);return{key:i,record:await ip({deviceKeyClient:n,enrollmentKey:i,globalState:r})}}))).find(e=>e.record!=null);return i?.record==null?null:{key:i.key,record:i.record}}") &&
    source.includes("function np(e){if(e.tokenAccountUserId==null)return[];let t=[e.tokenAccountUserId];return e.tokenAccountId!=null&&e.headerChatGptAccountId===e.tokenAccountId&&e.tokenAuthUserId!=null&&e.tokenAuthUserId!==e.tokenAccountUserId&&t.push(e.tokenAuthUserId),t}") &&
    source.includes("u?.key??Mf(r,c)")
  ) {
    return source;
  }

  // 26.527.x ships the multi-account enrollment compatibility natively (the
  // helpers were renamed, e.g. ep->wh / tp->Th). Detect both the candidate-id
  // list builder and the account/Auth-user compatibility check so the workaround
  // stays a clean no-op without masking partially migrated shapes.
  const nativeCandidateListStatementRegex =
    /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\)\{if\(\1\.tokenAccountUserId==null\)return\[\];let ([A-Za-z_$][\w$]*)=\[\1\.tokenAccountUserId\];(?:\1\.tokenAccountId!=null&&\1\.headerChatGptAccountId===\1\.tokenAccountId&&\1\.tokenAuthUserId!=null&&)?\1\.tokenAuthUserId!==\1\.tokenAccountUserId&&\2\.push\(\1\.tokenAuthUserId\);return \2\}/u;
  const nativeCandidateListReturnRegex =
    /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\)\{if\(\1\.tokenAccountUserId==null\)return\[\];let ([A-Za-z_$][\w$]*)=\[\1\.tokenAccountUserId\];return (?:\1\.tokenAccountId!=null&&\1\.headerChatGptAccountId===\1\.tokenAccountId&&\1\.tokenAuthUserId!=null&&)?\1\.tokenAuthUserId!==\1\.tokenAccountUserId&&\2\.push\(\1\.tokenAuthUserId\),\2\}/u;
  const nativeAccountCheckRegex =
    /[A-Za-z_$][\w$]*\.account_user_id!==[A-Za-z_$][\w$]*&&!\([A-Za-z_$][\w$]*\.tokenAccountId!=null&&[A-Za-z_$][\w$]*\.headerChatGptAccountId===[A-Za-z_$][\w$]*\.tokenAccountId&&[A-Za-z_$][\w$]*\.tokenAuthUserId===[A-Za-z_$][\w$]*\.account_user_id\)/u;
  if (
    (nativeCandidateListStatementRegex.test(source) ||
      nativeCandidateListReturnRegex.test(source)) &&
    nativeAccountCheckRegex.test(source) &&
    source.includes("remote_control_client_enrollment_start_account_mismatch")
  ) {
    return source;
  }

  if (!source.includes("Remote control enrollment start does not match current account.")) {
    return source;
  }

  const enrollmentKeyHelperRegex = /function ([A-Za-z_$][\w$]*)\(e,t\)\{return`\$\{e\}\\n\$\{t\}`\}/u;
  const helpersMatch = source.match(enrollmentKeyHelperRegex);
  if (helpersMatch == null) {
    console.warn("WARN: Could not find remote-control enrollment key helper - skipping account compatibility patch");
    return source;
  }
  const enrollmentKeyFn = helpersMatch[1];

  const enrollmentStartRegex = new RegExp(
    `let ([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*)\\),[\\s\\S]{0,240}?` +
      `([A-Za-z_$][\\w$]*)=\\1\\.tokenAccountUserId(?:\\?\\?null)?(?:,[^;]{0,160})?;` +
      `if\\(\\4==null\\)throw Error\\(\`Remote control enrollment requires the current ChatGPT account user id\\.\`\\);` +
      `[\\s\\S]{0,240}?let ([A-Za-z_$][\\w$]*)=${enrollmentKeyFn}\\(([A-Za-z_$][\\w$]*),\\4\\),[\\s\\S]{0,120}?` +
      `([A-Za-z_$][\\w$]*)=await ([A-Za-z_$][\\w$]*)\\(\\{deviceKeyClient:([A-Za-z_$][\\w$]*),enrollmentKey:\\5,globalState:([A-Za-z_$][\\w$]*)\\}\\),` +
      `([A-Za-z_$][\\w$]*)=\\7,([A-Za-z_$][\\w$]*);`,
    "u",
  );
  const startMatch = source.match(enrollmentStartRegex);
  if (startMatch == null) {
    console.warn("WARN: Could not find remote-control enrollment start shape - skipping account compatibility patch");
    return source;
  }

  const [
    startNeedle,
    authIdentityVar,
    authIdentityFn,
    headersVar,
    tokenAccountUserIdVar,
    enrollmentRecordKeyVar,
    enrollmentKeyVar,
    loadedEnrollmentVar,
    loadEnrollmentFn,
    deviceKeyClientVar,
    globalStateVar,
    enrollmentVar,
    tokenResponseVar,
  ] = startMatch;

  const stepUpValidatorRegex =
    /function ([A-Za-z_$][\w$]*)\(\{accountUserId:([A-Za-z_$][\w$]*),stepUpToken:([A-Za-z_$][\w$]*)\}\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\3\);([A-Za-z_$][\w$]*)\(\{payload:\4\}\);let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\.parse\(\4\),([A-Za-z_$][\w$]*)=\7\[`https:\/\/api\.openai\.com\/auth`\],([A-Za-z_$][\w$]*)=\9\.chatgpt_account_user_id\?\?\9\.account_user_id,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\7\);if\(\10!==\2\)throw (?:Error\(`Remote control enrollment step-up token does not match current account\.`\)|new [A-Za-z_$][\w$]*);if\(Math\.floor\(Date\.now\(\)\/1e3\)-\7\.iat>([A-Za-z_$][\w$]*)\)throw Error\(`Remote control enrollment step-up token is not fresh\.`\);if\(Date\.now\(\)-\7\.pwd_auth_time>\13\*1e3\)throw Error\(`Remote control enrollment step-up token does not have fresh password auth\.`\);if\(\11\.length!==1\|\|\11\[0\]!==([A-Za-z_$][\w$]*)\)throw Error\(`Remote control enrollment step-up token is missing required authorization\.`\);return\{accountUserId:\10\?\?null,issuedAt:\7\.iat,passwordAuthTime:\7\.pwd_auth_time,scopes:\11\}\}/u;
  const validatorMatch = source.match(stepUpValidatorRegex);
  if (validatorMatch == null) {
    console.warn("WARN: Could not find remote-control step-up token validator - skipping account compatibility patch");
    return source;
  }

  const [
    validatorNeedle,
    stepUpValidatorFn,
    ,
    ,
    ,
    decodeTokenFn,
    logPayloadFn,
    ,
    tokenParserVar,
    ,
    ,
    ,
    readScopesFn,
    freshnessWindowVar,
    requiredScopeVar,
  ] = validatorMatch;

  let patched = source;
  patched = patched.replace(
    enrollmentKeyHelperRegex,
    `${helpersMatch[0]}${linuxRemoteControlClientAccountCompatibilityHelpers(loadEnrollmentFn, enrollmentKeyFn)}`,
  );

  patched = patched.replace(
    startNeedle,
    [
      `let ${authIdentityVar}=${authIdentityFn}(${headersVar}),${tokenAccountUserIdVar}=${authIdentityVar}.tokenAccountUserId;`,
      `if(${tokenAccountUserIdVar}==null)throw Error(\`Remote control enrollment requires the current ChatGPT account user id.\`);`,
      `let codexLinuxRemoteControlCurrentAccountId=${authIdentityVar}.tokenAccountId??${authIdentityVar}.headerChatGptAccountId,`,
      `codexLinuxRemoteControlEnrollmentKey=${enrollmentKeyVar},`,
      `codexLinuxRemoteControlExistingEnrollment=await codexLinuxRemoteControlLoadEnrollment({authIdentity:${authIdentityVar},deviceKeyClient:${deviceKeyClientVar},enrollmentKey:${enrollmentKeyVar},globalState:${globalStateVar}}),`,
      `${enrollmentRecordKeyVar}=codexLinuxRemoteControlExistingEnrollment?.enrollmentRecordKey??${enrollmentKeyFn}(${enrollmentKeyVar},${tokenAccountUserIdVar}),`,
      `${loadedEnrollmentVar}=codexLinuxRemoteControlExistingEnrollment?.enrollment??null,`,
      `${enrollmentVar}=${loadedEnrollmentVar},${tokenResponseVar};`,
    ].join(""),
  );

  const authCheckRegex =
    /remote_control_client_enrollment_start_response[\s\S]{0,500}?\),([A-Za-z_$][\w$]*)\.account_user_id!==([A-Za-z_$][\w$]*)/u;
  const authCheckMatch = patched.match(authCheckRegex);
  if (authCheckMatch == null) {
    console.warn("WARN: Could not find remote-control enrollment account check - skipping account compatibility patch");
    return source;
  }
  const responseVar = authCheckMatch[1];
  const checkedAccountUserVar = authCheckMatch[2];
  if (checkedAccountUserVar !== tokenAccountUserIdVar) {
    console.warn("WARN: Remote-control enrollment account check used unexpected token variable - skipping account compatibility patch");
    return source;
  }
  patched = replaceOnce(
    patched,
    `${responseVar}.account_user_id!==${tokenAccountUserIdVar}`,
    `!codexLinuxRemoteControlAccountMatches({candidateAccountId:codexLinuxRemoteControlCurrentAccountId,candidateAccountUserId:${authIdentityVar}.tokenAccountUserId,candidateUserId:${authIdentityVar}.tokenAuthUserId,expectedAccountId:codexLinuxRemoteControlCurrentAccountId,expectedAccountUserId:${responseVar}.account_user_id})`,
  );
  if (patched == null) {
    console.warn("WARN: Could not replace remote-control enrollment account check - skipping account compatibility patch");
    return source;
  }

  const createEnrollmentRegex = new RegExp(
    `${escapeRegExp(enrollmentVar)}=await ([A-Za-z_$][\\w$]*)\\(\\{accountUserId:(?:${escapeRegExp(tokenAccountUserIdVar)}|${escapeRegExp(responseVar)}\\.account_user_id),clientId:${escapeRegExp(responseVar)}\\.client_id,deviceKeyClient:${escapeRegExp(deviceKeyClientVar)}\\}\\);try\\{`,
    "u",
  );
  const createEnrollmentMatch = patched.match(createEnrollmentRegex);
  if (createEnrollmentMatch == null) {
    console.warn("WARN: Could not find remote-control enrollment creation - skipping account compatibility patch");
    return source;
  }
  const createEnrollmentFn = createEnrollmentMatch[1];
  const createdEnrollmentRecordKeyUpdate =
    responseVar === enrollmentRecordKeyVar
      ? ""
      : `${enrollmentRecordKeyVar}=${enrollmentKeyFn}(codexLinuxRemoteControlEnrollmentKey,${enrollmentVar}.accountUserId);`;
  patched = patched.replace(
    createEnrollmentRegex,
    `${enrollmentVar}=await ${createEnrollmentFn}({accountUserId:${responseVar}.account_user_id,clientId:${responseVar}.client_id,deviceKeyClient:${deviceKeyClientVar}});${createdEnrollmentRecordKeyUpdate}try{`,
  );

  const stepUpCallRegex = new RegExp(
    `let ([A-Za-z_$][\\w$]*)=await ([A-Za-z_$][\\w$]*)\\(\\),([A-Za-z_$][\\w$]*)=${escapeRegExp(stepUpValidatorFn)}\\(\\{accountUserId:${escapeRegExp(tokenAccountUserIdVar)},stepUpToken:\\1\\}\\),`,
    "u",
  );
  const stepUpCallMatch = patched.match(stepUpCallRegex);
  if (stepUpCallMatch == null) {
    console.warn("WARN: Could not find remote-control step-up validation call - skipping account compatibility patch");
    return source;
  }
  const [, stepUpTokenVar, requestStepUpVar, parsedStepUpVar] = stepUpCallMatch;
  patched = patched.replace(
    stepUpCallRegex,
    `let ${stepUpTokenVar}=await ${requestStepUpVar}({accountId:codexLinuxRemoteControlCurrentAccountId}),${parsedStepUpVar}=${stepUpValidatorFn}({accountId:codexLinuxRemoteControlCurrentAccountId,accountUserId:${enrollmentVar}.accountUserId,stepUpToken:${stepUpTokenVar}}),`,
  );

  patched = patched.replace(
    validatorNeedle,
    [
      `function ${stepUpValidatorFn}({accountId:codexLinuxExpectedAccountId,accountUserId:codexLinuxExpectedAccountUserId,stepUpToken:codexLinuxStepUpToken}){`,
      `let codexLinuxStepUpPayload=${decodeTokenFn}(codexLinuxStepUpToken);${logPayloadFn}({payload:codexLinuxStepUpPayload});`,
      `let codexLinuxStepUpClaims=${tokenParserVar}.parse(codexLinuxStepUpPayload),codexLinuxStepUpAuth=codexLinuxStepUpClaims[\`https://api.openai.com/auth\`],`,
      `codexLinuxStepUpAccountUserId=codexLinuxStepUpAuth.chatgpt_account_user_id??codexLinuxStepUpAuth.account_user_id??null,`,
      `codexLinuxStepUpAccountId=codexLinuxStepUpAuth.chatgpt_account_id??codexLinuxStepUpAuth.account_id??null,codexLinuxStepUpScopes=${readScopesFn}(codexLinuxStepUpClaims);`,
      "if(!codexLinuxRemoteControlAccountMatches({candidateAccountId:codexLinuxStepUpAccountId,candidateAccountUserId:codexLinuxStepUpAccountUserId,candidateUserId:codexLinuxStepUpAuth.user_id??null,expectedAccountId:codexLinuxExpectedAccountId,expectedAccountUserId:codexLinuxExpectedAccountUserId}))",
      "throw Error(`Remote control enrollment step-up token does not match current account.`);",
      `if(Math.floor(Date.now()/1e3)-codexLinuxStepUpClaims.iat>${freshnessWindowVar})throw Error(\`Remote control enrollment step-up token is not fresh.\`);`,
      `if(Date.now()-codexLinuxStepUpClaims.pwd_auth_time>${freshnessWindowVar}*1e3)throw Error(\`Remote control enrollment step-up token does not have fresh password auth.\`);`,
      `if(codexLinuxStepUpScopes.length!==1||codexLinuxStepUpScopes[0]!==${requiredScopeVar})throw Error(\`Remote control enrollment step-up token is missing required authorization.\`);`,
      "return{accountUserId:codexLinuxStepUpAccountUserId??null,issuedAt:codexLinuxStepUpClaims.iat,passwordAuthTime:codexLinuxStepUpClaims.pwd_auth_time,scopes:codexLinuxStepUpScopes}}",
    ].join(""),
  );

  const authorizationCheckRegex =
    new RegExp(
      `async function ([A-Za-z_$][\\w$]*)\\(\\{appServerClient:([A-Za-z_$][\\w$]*),desktopApiOptions:([A-Za-z_$][\\w$]*),deviceKeyClient:([A-Za-z_$][\\w$]*),globalState:([A-Za-z_$][\\w$]*)\\}\\)\\{` +
        `let ([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(await ([A-Za-z_$][\\w$]*)\\(\\{action:\`check remote control authorization\`,appServerClient:\\2,desktopApiOptions:\\3\\}\\)\\)\\.tokenAccountUserId;` +
        `if\\(\\6==null\\)return\\{clientAuthorized:!1,clientId:null\\};` +
        `let ([A-Za-z_$][\\w$]*)=await ([A-Za-z_$][\\w$]*)\\(\\{deviceKeyClient:\\4,enrollmentKey:${enrollmentKeyFn}\\(([A-Za-z_$][\\w$]*)\\(\\3\\),\\6\\),globalState:\\5\\}\\);` +
        `return\\{clientAuthorized:\\9!=null,clientId:\\9\\?\\.clientId\\?\\?null\\}\\}`,
      "u",
    );
  const authorizationCheckMatch = patched.match(authorizationCheckRegex);
  if (authorizationCheckMatch == null) {
    console.warn("WARN: Could not find remote-control authorization status check - skipping account compatibility patch");
    return source;
  }
  const [, authCheckFn, appServerClientVar, desktopApiOptionsVar, authDeviceKeyClientVar, authGlobalStateVar, authStatusIdentityVar, authStatusIdentityFn, authHeadersFn, enrollmentVarForStatus, , statusBaseEnrollmentKeyFn] =
    authorizationCheckMatch;
  patched = patched.replace(
    authorizationCheckRegex,
    `async function ${authCheckFn}({appServerClient:${appServerClientVar},desktopApiOptions:${desktopApiOptionsVar},deviceKeyClient:${authDeviceKeyClientVar},globalState:${authGlobalStateVar}}){let ${authStatusIdentityVar}=${authStatusIdentityFn}(await ${authHeadersFn}({action:\`check remote control authorization\`,appServerClient:${appServerClientVar},desktopApiOptions:${desktopApiOptionsVar}}));if(${authStatusIdentityVar}.tokenAccountUserId==null)return{clientAuthorized:!1,clientId:null};let ${enrollmentVarForStatus}=await codexLinuxRemoteControlLoadEnrollment({authIdentity:${authStatusIdentityVar},deviceKeyClient:${authDeviceKeyClientVar},enrollmentKey:${statusBaseEnrollmentKeyFn}(${desktopApiOptionsVar}),globalState:${authGlobalStateVar}});return{clientAuthorized:${enrollmentVarForStatus}!=null,clientId:${enrollmentVarForStatus}?.enrollment.clientId??null}}`,
  );

  return patched;
}

function applyLinuxRemoteControlClientRevocationRecoveryPatch(source) {
  if (
    source.includes("e.message===`Remote-control client key material missing`") &&
    source.includes("e.message===`Remote-control client has been revoked`")
  ) {
    return source;
  }

  const recoverableErrorNeedle =
    /e\.message===`Remote control request failed \(403\): Remote-control client key material missing`(?:\|\|e\.message===`Remote-control client key material missing`)?(?:\|\|e\.message===`Remote-control client has been revoked`)?:!1/u;
  if (!recoverableErrorNeedle.test(source)) {
    if (!source.includes("Remote-control client key material missing")) {
      return source;
    }
    console.warn("WARN: Could not find remote-control recoverable error predicate - skipping revoked-client recovery patch");
    return source;
  }

  return source.replace(
    recoverableErrorNeedle,
    "e.message===`Remote control request failed (403): Remote-control client key material missing`||e.message===`Remote-control client key material missing`||e.message===`Remote-control client has been revoked`:!1",
  );
}

function applyLinuxRemoteMobileAppServerRemoteControlPatch(source) {
  if (source.includes(REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER)) {
    return source;
  }
  if (!source.includes(REMOTE_MOBILE_APP_SERVER_ARGS_NEEDLE)) {
    return source;
  }

  const helper =
    "function codexLinuxRemoteMobileAppServerArgs(){return process.platform===`linux`?[`-c`,`features.code_mode_host=true`,`app-server`,`--remote-control`,`--analytics-default-enabled`]:[`-c`,`features.code_mode_host=true`,`app-server`,`--analytics-default-enabled`]}";
  const replaced = source
    .split(REMOTE_MOBILE_APP_SERVER_ARGS_NEEDLE)
    .join("codexLinuxRemoteMobileAppServerArgs()");
  // Insert after a leading "use strict" so prepending the helper does not
  // demote the directive to a plain expression and de-strict the bundle.
  const insertAt = replaced.startsWith('"use strict";')
    ? '"use strict";'.length
    : replaced.startsWith("'use strict';")
      ? "'use strict';".length
      : 0;
  return `${replaced.slice(0, insertAt)}${helper}${replaced.slice(insertAt)}`;
}

function applyLinuxRemoteMobileAppServerRemoteControlExtractedAppPatch(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    const reason = `missing build directory ${buildDir}`;
    console.warn(`WARN: Could not find app-server launch bundle - skipping remote mobile app-server remote-control patch`);
    return { matched: 0, changed: 0, reason };
  }

  const candidates = fs
    .readdirSync(buildDir)
    .filter((name) => /\.m?js$/u.test(name))
    .sort();

  let matched = 0;
  let changed = 0;
  for (const candidate of candidates) {
    const filePath = path.join(buildDir, candidate);
    const source = fs.readFileSync(filePath, "utf8");
    if (
      !source.includes(REMOTE_MOBILE_APP_SERVER_ARGS_NEEDLE) &&
      !source.includes(REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER)
    ) {
      continue;
    }
    matched += 1;
    const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(source);
    if (patched !== source) {
      fs.writeFileSync(filePath, patched, "utf8");
      changed += 1;
    }
  }

  if (matched === 0) {
    const reason = "no default app-server launch args found";
    console.warn("WARN: Could not find default app-server launch args - skipping remote mobile app-server remote-control patch");
    return { matched, changed, reason };
  }
  return { matched, changed };
}

function applyLinuxRemoteControlClientRevokeSetupResetPatch(source) {
  if (source.includes(REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER)) {
    return source;
  }
  if (!source.includes("remote-control-client-revoke-success")) {
    return source;
  }

  const currentStateKeysVar = source.match(/([A-Za-z_$][\w$]*)\.CODEX_MOBILE_SETUP_COMPLETED/u)?.[1] ?? null;
  const currentStateSetterVar =
    source.match(/([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.keepRemoteControlAwakeWhilePluggedIn,/u)?.[1] ??
    null;
  const currentScopeMatch = source.match(
    /function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\{let [A-Za-z_$][\w$]*=\(0,[A-Za-z_$][\w$]*\.c\)\(\d+\),[\s\S]*?([A-Za-z_$][\w$]*)=a\(s\)[\s\S]*?`local_remote_control_client_id`[\s\S]*?onRevoked:[A-Za-z_$][\w$]*=>\{[A-Za-z_$][\w$]*\.setData[\s\S]*?onRevokeResult:/u,
  );
  const currentLocalRevokePattern =
    /onRevoked:([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.setData\(([A-Za-z_$][\w$]*)=>\3\?\.filter\(\3=>\3\.clientId!==\1\)\),\2\.invalidate\(\)\},onRevokeResult:/u;
  if (
    currentStateKeysVar != null &&
    currentStateSetterVar != null &&
    currentScopeMatch != null &&
    currentLocalRevokePattern.test(source)
  ) {
    const helperNeedle = source.match(/var [A-Za-z_$][\w$]*=`remote-control-client-revoke-success`/u)?.[0] ?? null;
    if (helperNeedle == null) {
      return source;
    }
    const helper = [
      `function ${REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER}(e,t,n,r,i){`,
      "let a=e?.filter(e=>(e.clientId??e.client_id)!==t);",
      "return a?.length===0&&i(n,r.CODEX_MOBILE_SETUP_COMPLETED,!1),a",
      "}",
    ].join("");
    return source
      .replace(helperNeedle, `${helper}${helperNeedle}`)
      .replace(
        currentLocalRevokePattern,
        (_needle, clientIdVar, querySnapshotVar, dataVar) =>
          `onRevoked:${clientIdVar}=>{${querySnapshotVar}.setData(${dataVar}=>${REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER}(${dataVar},${clientIdVar},${currentScopeMatch[1]},${currentStateKeysVar},${currentStateSetterVar})),${querySnapshotVar}.invalidate()},onRevokeResult:`,
      );
  }

  const setGlobalStateMatch = source.match(
    /mutationFn:[A-Za-z_$][\w$]*=>([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.ADDED_REMOTE_CONTROL_ENV_IDS,/u,
  );
  if (setGlobalStateMatch == null) {
    return source;
  }

  const setGlobalStateFn = setGlobalStateMatch[1];
  const helperNeedle = source.match(/var [A-Za-z_$][\w$]*=`remote-control-client-revoke-success`/u)?.[0] ?? null;
  if (helperNeedle == null) {
    return source;
  }

  const helper = [
    `function ${REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER}(e,t,n){`,
    "let r=e?.filter(e=>(e.client_id??e.clientId)!==t);",
    `return r?.length===0&&${setGlobalStateFn}(n,\`codex-mobile-has-connected-device\`,!1),r`,
    "}",
  ].join("");

  const patched = source.replace(helperNeedle, `${helper}${helperNeedle}`);
  const successPattern =
    /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{eventName:`codex_remote_control_client_revoke_result`,metadata:\{result:`succeeded`\}\}\),([A-Za-z_$][\w$]*)\.setData\(([A-Za-z_$][\w$]*)=>\4\?\.filter\(\4=>\4\.client_id!==([A-Za-z_$][\w$]*)\)\)/u;
  if (!successPattern.test(patched)) {
    return source;
  }

  return patched.replace(
    successPattern,
    (_needle, trackFn, queryClientVar, querySnapshotVar, dataVar, clientIdVar) =>
      `${trackFn}(${queryClientVar},{eventName:\`codex_remote_control_client_revoke_result\`,metadata:{result:\`succeeded\`}}),${querySnapshotVar}.setData(${dataVar}=>${REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER}(${dataVar},${clientIdVar},${queryClientVar}))`,
  );
}

function applyLinuxRemoteControlLoadGatePatch(source) {
  if (source.includes(REMOTE_CONTROL_LOAD_GATE_MARKER)) {
    return source;
  }
  if (!source.includes("`1042620455`")) {
    return source;
  }

  const match = source.match(REMOTE_CONTROL_LOAD_GATE_NEEDLE);
  if (match == null) {
    console.warn("WARN: Could not find remote-control loader rollout gate - skipping Linux remote-control load gate patch");
    return source;
  }

  const [, functionName, statsigFn] = match;
  return source.replace(
    REMOTE_CONTROL_LOAD_GATE_NEEDLE,
    [
      `function ${functionName}(){return codexLinuxRemoteControlLoadGateEnabled()||${statsigFn}(\`1042620455\`)}`,
      "function codexLinuxRemoteControlLoadGateEnabled(){",
      "return typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`)",
      "}",
    ].join(""),
  );
}

function applyLinuxRemoteControlFeatureSyncPatch(source) {
  if (!source.includes("set-experimental-feature-enablement-for-host")) {
    return source;
  }

  // 26.527.x builds the per-host feature enablement in a helper that copies the
  // supported defaults, then unconditionally adds remote_plugin (n[vI]=t), and
  // never includes remote_control. Current app servers support remote_plugin and
  // use it for remote marketplace data, so Linux only adds remote_control.
  // Older core Linux patches may already have removed the remote_plugin tail;
  // compose with that sanitized shape instead of treating it as drift.
  let patched = source;
  let changed = false;
  const enablementRegex =
    /(for\(let ([A-Za-z_$][\w$]*) of [A-Za-z_$][\w$]*\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\[\2\];\3!=null&&\(([A-Za-z_$][\w$]*)\[\2\]=\3\)\})return \4\[([A-Za-z_$][\w$]*)\]=([A-Za-z_$][\w$]*),\4\}/u;
  if (!patched.includes(REMOTE_CONTROL_FEATURE_SYNC_MARKER)) {
    const match = patched.match(enablementRegex);
    if (match != null) {
      const [, loopBlock, , , enablementVar, remotePluginVar, remotePluginValue] = match;
      const replacement =
        `${loopBlock}return typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)` +
        `?(${REMOTE_CONTROL_FEATURE_SYNC_MARKER}(arguments[2],arguments[3])&&(${enablementVar}.remote_control=!0),${enablementVar}[${remotePluginVar}]=${remotePluginValue},${enablementVar})` +
        `:(${enablementVar}[${remotePluginVar}]=${remotePluginValue},${enablementVar})}` +
        `function ${REMOTE_CONTROL_FEATURE_SYNC_MARKER}(e,t){return e==null||t==null||e===t}`;
      patched = patched.replace(enablementRegex, replacement);
      changed = true;
    } else {
      const sanitizedEnablementRegex =
        /(for\(let ([A-Za-z_$][\w$]*) of [A-Za-z_$][\w$]*\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\[\2\];\3!=null&&\(([A-Za-z_$][\w$]*)\[\2\]=\3\)\})return \4\}/u;
      const sanitizedMatch = patched.match(sanitizedEnablementRegex);
      if (sanitizedMatch != null) {
        const [, loopBlock, , , enablementVar] = sanitizedMatch;
        const replacement =
          `${loopBlock}return typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)` +
          `?(${REMOTE_CONTROL_FEATURE_SYNC_MARKER}(arguments[2],arguments[3])&&(${enablementVar}.remote_control=!0),${enablementVar})` +
          `:${enablementVar}}function ${REMOTE_CONTROL_FEATURE_SYNC_MARKER}(e,t){return e==null||t==null||e===t}`;
        patched = patched.replace(sanitizedEnablementRegex, replacement);
        changed = true;
      }
    }
  }

  const scoped = applyLinuxRemoteControlFeatureSyncHostScopePatch(patched);
  if (scoped !== patched) {
    patched = scoped;
    changed = true;
  }

  if (changed || patched.includes(REMOTE_CONTROL_FEATURE_SYNC_MARKER)) {
    return patched;
  }

  console.warn("WARN: Could not find app-server feature sync list - skipping Linux remote-control feature sync patch");
  return source;
}

function applyLinuxRemoteControlFeatureSyncHostScopePatch(source) {
  if (source.includes(REMOTE_CONTROL_FEATURE_SYNC_HOST_SCOPE_MARKER)) {
    return source;
  }

  const builderCallRegex =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*|![01])\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.get\(([A-Za-z_$][\w$]*)\),/u;
  const builderCallMatch = source.match(builderCallRegex);
  if (builderCallMatch == null) {
    return source;
  }

  const [
    ,
    enablementVar,
    builderFn,
    featureConfigVar,
    remotePluginValueVar,
    localHostVar,
  ] = builderCallMatch;
  const id = "[A-Za-z_$][\\w$]*";
  const flatMapRegex = new RegExp(
    `\\(0,(${id})\\.(${id})\\)\\((${id})\\.get\\((${id})\\),${enablementVar}\\)\\?\\[\\]:` +
      `\\(\\3\\.set\\(\\4,${enablementVar}\\),\\[(${id})\\(\\x60set-experimental-feature-enablement-for-host\\x60,` +
      `\\{hostId:\\4,enablement:${enablementVar}\\}\\)`,
    "u",
  );
  const match = source.match(flatMapRegex);
  if (match == null) {
    return source;
  }

  const [needle, compareNamespaceVar, compareFnVar, cacheMapVar, hostVar, requestFnVar] = match;
  const helperName = "codexLinuxRemoteControlFeatureSyncForHost";
  const scopedEnablement =
    `${helperName}(${builderFn},${featureConfigVar},${remotePluginValueVar},${hostVar},${localHostVar})`;
  const replacement =
    `(0,${compareNamespaceVar}.${compareFnVar})(${cacheMapVar}.get(${hostVar}),${scopedEnablement})?[]:` +
    `(${cacheMapVar}.set(${hostVar},${scopedEnablement}),[${requestFnVar}(\`set-experimental-feature-enablement-for-host\`,` +
    `{hostId:${hostVar},enablement:${scopedEnablement}})/*${REMOTE_CONTROL_FEATURE_SYNC_HOST_SCOPE_MARKER}*/`;
  const helper =
    `function ${helperName}(e,t,n,r,i){return e(t,n,r,i)}`;

  return `${source.replace(needle, replacement)}\n${helper}`;
}

function applyLinuxRemoteControlVisibilityPatch(source) {
  if (
    source.includes(REMOTE_CONTROL_VISIBILITY_REPLACEMENT) ||
    source.includes("remoteControlConnectionsState") &&
      source.includes("navigator.userAgent.includes(`Linux`)")
  ) {
    return source;
  }
  if (source.includes(REMOTE_CONTROL_VISIBILITY_OLD_REPLACEMENT)) {
    return source.replace(REMOTE_CONTROL_VISIBILITY_OLD_REPLACEMENT, REMOTE_CONTROL_VISIBILITY_REPLACEMENT);
  }
  if (!source.includes(REMOTE_CONTROL_VISIBILITY_NEEDLE)) {
    if (!source.includes("remoteControlConnectionsState")) {
      return source;
    }

    const settingsVisibilityMatch = source.match(REMOTE_CONTROL_SETTINGS_VISIBILITY_NEEDLE);
    if (settingsVisibilityMatch == null) {
      console.warn("WARN: Could not find remote-control visibility gate - skipping Linux remote-control visibility patch");
      return source;
    }

    const [, functionName, stateVar, slingshotVar] = settingsVisibilityMatch;
    return source.replace(
      REMOTE_CONTROL_SETTINGS_VISIBILITY_NEEDLE,
      `function ${functionName}({remoteControlConnectionsState:${stateVar},slingshotEnabled:${slingshotVar}}){let n=typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`);return(n||${slingshotVar})&&(n||(${stateVar}?.available??!0))&&${stateVar}?.accessRequired!==!0}`,
    );
  }
  return source.replace(REMOTE_CONTROL_VISIBILITY_NEEDLE, REMOTE_CONTROL_VISIBILITY_REPLACEMENT);
}

function wrapRemoteControlTabs(source, firstKey) {
  const key = firstKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `tabs:(\\[\\{key:\`${key}\`[\\s\\S]*?\\}\\]),selectedKey:([A-Za-z_$][\\w$]*),variant:\`underline\`,onSelect:([A-Za-z_$][\\w$]*)\\}`,
    "g",
  );
  return source.replace(
    pattern,
    "tabs:codexLinuxRemoteControlSettingsTabs($1),selectedKey:$2,variant:`underline`,onSelect:$3}",
  );
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
  const { patched, changed } = replaceLinuxRemoteControlCopy(source);
  if (!changed) {
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
  return patched;
}

function applyLinuxRemoteControlSshInstallActionPatch(source) {
  if (source.includes(REMOTE_CONTROL_SSH_INSTALL_ACTION_MARKER)) {
    return source;
  }
  if (!source.includes("remote-codex-not-found") && !source.includes("update-required")) {
    return source;
  }

  const actionGateRegex =
    /let ([A-Za-z_$][\w$]*)=([^;]+?)&&\(([A-Za-z_$][\w$]*)\?\.code===`remote-codex-not-found`\|\|\3\?\.code===`update-required`\);([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)==null\|\|\1\?null:([A-Za-z_$][\w$]*)\(\{action:\5\.action,/u;
  const match = source.match(actionGateRegex);
  if (match != null) {
    const [, gateVar, , , renderedActionVar, connectionActionVar, renderActionFn] = match;
    return source.replace(
      actionGateRegex,
      `let ${gateVar}=/*${REMOTE_CONTROL_SSH_INSTALL_ACTION_MARKER}*/!1;${renderedActionVar}=${connectionActionVar}==null?null:${renderActionFn}({action:${connectionActionVar}.action,`,
    );
  }

  const currentActionGateRegex =
    /let ([A-Za-z_$][\w$]*)=([^;,]+?)&&\(([A-Za-z_$][\w$]*)\?\.code===`remote-codex-not-found`\|\|\3\?\.code===`update-required`\),([\s\S]*?)([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)==null\|\|\1\?null:([A-Za-z_$][\w$]*)\(\{action:\6\.action,/u;
  const currentMatch = source.match(currentActionGateRegex);
  if (currentMatch == null) {
    console.warn("WARN: Could not find remote-control SSH install action gate - skipping Linux install action patch");
    return source;
  }

  const [, gateVar, , , betweenGateAndAction, renderedActionVar, connectionActionVar, renderActionFn] = currentMatch;
  return source.replace(
    currentActionGateRegex,
    `let ${gateVar}=/*${REMOTE_CONTROL_SSH_INSTALL_ACTION_MARKER}*/!1,${betweenGateAndAction}${renderedActionVar}=${connectionActionVar}==null?null:${renderActionFn}({action:${connectionActionVar}.action,`,
  );
}

function applyLinuxRemoteControlSshInstallReleasePatch(source) {
  if (source.includes(REMOTE_CONTROL_SSH_INSTALL_RELEASE_MARKER)) {
    return source;
  }
  if (!source.includes("install-remote-codex") || !source.includes("install-codex")) {
    return source;
  }

  const actionBuilderRegex =
    /function ([A-Za-z_$][\w$]*)\(\{action:([A-Za-z_$][\w$]*),disabled:([A-Za-z_$][\w$]*),hostId:([A-Za-z_$][\w$]*),installCodexPending:([A-Za-z_$][\w$]*),onAuthenticate:([A-Za-z_$][\w$]*),onInstallCodex:([A-Za-z_$][\w$]*)(?:,onRestart:([A-Za-z_$][\w$]*))?\}\)\{if\(\2==null\)return null;switch\(\2\.kind\)\{case`install-codex`:return\{disabled:\3,label:\2\.label,loading:\5,loadingLabel:\2\.loadingLabel,renderInElectronOnly:!0,tooltipText:\2\.tooltipText,onClick:\(\)=>\7\(\4\)\}/u;
  const actionCallRegex =
    /let ([A-Za-z_$][\w$]*)=([^;]+?)&&\(([A-Za-z_$][\w$]*)\?\.code===`remote-codex-not-found`\|\|\3\?\.code===`update-required`\);([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)==null\|\|\1\?null:([A-Za-z_$][\w$]*)\(\{action:\5\.action,disabled:([A-Za-z_$][\w$]*),hostId:([A-Za-z_$][\w$]*)\.hostId,installCodexPending:([A-Za-z_$][\w$]*),(?:onRestart:([A-Za-z_$][\w$]*),)?onAuthenticate:([A-Za-z_$][\w$]*),onInstallCodex:([A-Za-z_$][\w$]*)\}\)/u;
  const mutationRegex =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.mutate\(\{hostId:\2\},\{onSuccess:\(\{state:([A-Za-z_$][\w$]*),error:([A-Za-z_$][\w$]*)\}\)=>\{([A-Za-z_$][\w$]*)\(\2,\4,\5\)\}\}\)\}/u;
  const localVersionRegex =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\((\d+)\),\{connection:([A-Za-z_$][\w$]*),disabled:([A-Za-z_$][\w$]*),installCodexPending:([A-Za-z_$][\w$]*),([\s\S]*?)onAuthenticate:([A-Za-z_$][\w$]*),([\s\S]*?)onInstallCodex:([A-Za-z_$][\w$]*),([\s\S]*?)\}=\2,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),\{appServerVersion:([A-Za-z_$][\w$]*),error:([A-Za-z_$][\w$]*),installedCodexVersion:([A-Za-z_$][\w$]*),state:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\6\.hostId\),([A-Za-z_$][\w$]*)=\6\.displayName/u;
  const currentActionCallRegex =
    /let ([A-Za-z_$][\w$]*)=([^;,]+?)&&\(([A-Za-z_$][\w$]*)\?\.code===`remote-codex-not-found`\|\|\3\?\.code===`update-required`\),([\s\S]*?)([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)==null\|\|\1\?null:([A-Za-z_$][\w$]*)\(\{action:\6\.action,disabled:([A-Za-z_$][\w$]*),hostId:([A-Za-z_$][\w$]*)\.hostId,installCodexPending:([A-Za-z_$][\w$]*),(?:onRestart:([A-Za-z_$][\w$]*),)?onAuthenticate:([A-Za-z_$][\w$]*),onInstallCodex:([A-Za-z_$][\w$]*)\}\)/u;
  const currentLocalVersionRegex =
    /\{appServerVersion:([A-Za-z_$][\w$]*),error:([A-Za-z_$][\w$]*),installedCodexVersion:([A-Za-z_$][\w$]*),state:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.hostId\),([A-Za-z_$][\w$]*)=\6\.displayName/u;

  const actionBuilderMatch = source.match(actionBuilderRegex);
  const actionCallMatch = source.match(actionCallRegex);
  const mutationMatch = source.match(mutationRegex);
  const localVersionMatch = source.match(localVersionRegex);
  const currentActionCallMatch = source.match(currentActionCallRegex);
  const currentLocalVersionMatch = source.match(currentLocalVersionRegex);
  if (
    actionBuilderMatch != null &&
    mutationMatch != null &&
    currentActionCallMatch != null &&
    currentLocalVersionMatch != null
  ) {
    const [
      ,
      builderFn,
      builderActionVar,
      builderDisabledVar,
      builderHostVar,
      builderPendingVar,
      builderAuthVar,
      builderInstallVar,
      builderRestartVar,
    ] = actionBuilderMatch;
    const builderRestartPart = builderRestartVar == null ? "" : `,onRestart:${builderRestartVar}`;
    const actionBuilderReplacement =
      `function ${builderFn}({action:${builderActionVar},disabled:${builderDisabledVar},hostId:${builderHostVar},installCodexPending:${builderPendingVar},` +
      `installCodexRelease:codexLinuxRemoteControlSshInstallReleaseTarget,onAuthenticate:${builderAuthVar},onInstallCodex:${builderInstallVar}${builderRestartPart}}){` +
      `if(${builderActionVar}==null)return null;switch(${builderActionVar}.kind){case\`install-codex\`:return{disabled:${builderDisabledVar},label:${builderActionVar}.label,loading:${builderPendingVar},` +
      `loadingLabel:${builderActionVar}.loadingLabel,renderInElectronOnly:!0,tooltipText:${builderActionVar}.tooltipText,onClick:()=>${builderInstallVar}(${builderHostVar},codexLinuxRemoteControlSshInstallReleaseTarget)}`;

    const [
      ,
      gateVar,
      gateExpression,
      errorVar,
      betweenGateAndAction,
      renderedActionVar,
      connectionActionVar,
      renderActionFn,
      disabledVar,
      connectionVar,
      pendingVar,
      restartVar,
      authenticateVar,
      installVar,
    ] = currentActionCallMatch;
    const restartPart = restartVar == null ? "" : `onRestart:${restartVar},`;
    const actionCallReplacement =
      `let ${gateVar}=${gateExpression}&&(${errorVar}?.code===\`remote-codex-not-found\`||${errorVar}?.code===\`update-required\`),` +
      `${betweenGateAndAction}${renderedActionVar}=${connectionActionVar}==null||${gateVar}?null:${renderActionFn}({action:${connectionActionVar}.action,disabled:${disabledVar},hostId:${connectionVar}.hostId,` +
      `installCodexPending:${pendingVar},installCodexRelease:${REMOTE_CONTROL_SSH_INSTALL_RELEASE_MARKER}(${errorVar}),${restartPart}onAuthenticate:${authenticateVar},onInstallCodex:${installVar}})`;

    const [
      ,
      currentAppServerVersionVar,
      currentErrorVar,
      currentInstalledVersionVar,
      currentStateVar,
      currentConnectionStateFn,
      currentConnectionVar,
      currentDisplayNameVar,
    ] = currentLocalVersionMatch;
    const currentLocalVersionReplacement =
      `{appServerVersion:${currentAppServerVersionVar},error:${currentErrorVar},installedCodexVersion:${currentInstalledVersionVar},state:${currentStateVar}}=${currentConnectionStateFn}(${currentConnectionVar}.hostId),` +
      `{appServerVersion:codexLinuxRemoteControlSshInstallLocalVersion}=${currentConnectionStateFn}(\`local\`);` +
      `codexLinuxRemoteControlSshInstallDefaultRelease=codexLinuxRemoteControlValidRelease(codexLinuxRemoteControlSshInstallLocalVersion)??codexLinuxRemoteControlSshInstallDefaultRelease;` +
      `let ${currentDisplayNameVar}=${currentConnectionVar}.displayName`;

    const [
      ,
      mutationHandlerVar,
      mutationHostVar,
      mutationVar,
      mutationStateVar,
      mutationErrorVar,
      syncStateFn,
    ] = mutationMatch;
    const mutationReplacement =
      `${mutationHandlerVar}=(${mutationHostVar},codexLinuxRemoteControlSshInstallTargetRelease)=>{` +
      `let codexLinuxRemoteControlSshInstallRequest={hostId:${mutationHostVar}},` +
      `codexLinuxRemoteControlSshInstallResolvedRelease=codexLinuxRemoteControlSshInstallTargetRelease??codexLinuxRemoteControlSshInstallDefaultRelease;` +
      `codexLinuxRemoteControlSshInstallResolvedRelease!=null&&(codexLinuxRemoteControlSshInstallRequest.release=codexLinuxRemoteControlSshInstallResolvedRelease),` +
      `${mutationVar}.mutate(codexLinuxRemoteControlSshInstallRequest,{onSuccess:({state:${mutationStateVar},error:${mutationErrorVar}})=>{${syncStateFn}(${mutationHostVar},${mutationStateVar},${mutationErrorVar})}})}`;

    const helper = [
      "let codexLinuxRemoteControlSshInstallDefaultRelease=null;",
      "function codexLinuxRemoteControlValidRelease(e){return typeof e==`string`&&e.trim().length>0?e.trim():null}",
      `function ${REMOTE_CONTROL_SSH_INSTALL_RELEASE_MARKER}(e){return e?.code===\`update-required\`?codexLinuxRemoteControlValidRelease(e.minRequiredVersion):null}`,
    ].join("");

    return helper + source
      .replace(currentLocalVersionRegex, currentLocalVersionReplacement)
      .replace(actionBuilderRegex, actionBuilderReplacement)
      .replace(currentActionCallRegex, actionCallReplacement)
      .replace(mutationRegex, mutationReplacement);
  }
  if (
    actionBuilderMatch == null ||
    actionCallMatch == null ||
    mutationMatch == null ||
    localVersionMatch == null
  ) {
    console.warn("WARN: Could not find remote-control SSH install release needles - skipping Linux install release patch");
    return source;
  }

  const [
    ,
    rowComponentFn,
    rowPropsVar,
    rowCacheVar,
    rowCompilerVar,
    rowCacheSize,
    rowConnectionVar,
    rowDisabledVar,
    rowInstallPendingVar,
    rowBetweenPendingAndAuth,
    rowAuthenticateVar,
    rowBetweenAuthAndInstall,
    rowInstallVar,
    rowTrailingProps,
    rowFormatVar,
    rowFormatFn,
    rowAppServerVersionVar,
    rowErrorVar,
    rowInstalledVersionVar,
    rowStateVar,
    rowConnectionStateFn,
    rowDisplayNameVar,
  ] = localVersionMatch;
  const localVersionReplacement =
    `function ${rowComponentFn}(${rowPropsVar}){let ${rowCacheVar}=(0,${rowCompilerVar}.c)(${rowCacheSize}),` +
    `{connection:${rowConnectionVar},disabled:${rowDisabledVar},installCodexPending:${rowInstallPendingVar},` +
    `${rowBetweenPendingAndAuth}onAuthenticate:${rowAuthenticateVar},${rowBetweenAuthAndInstall}` +
    `onInstallCodex:${rowInstallVar},${rowTrailingProps}}=${rowPropsVar},${rowFormatVar}=${rowFormatFn}(),` +
    `{appServerVersion:${rowAppServerVersionVar},error:${rowErrorVar},installedCodexVersion:${rowInstalledVersionVar},state:${rowStateVar}}=${rowConnectionStateFn}(${rowConnectionVar}.hostId),` +
    `{appServerVersion:codexLinuxRemoteControlSshInstallLocalVersion}=${rowConnectionStateFn}(\`local\`);` +
    `codexLinuxRemoteControlSshInstallDefaultRelease=codexLinuxRemoteControlValidRelease(codexLinuxRemoteControlSshInstallLocalVersion)??codexLinuxRemoteControlSshInstallDefaultRelease;` +
    `let ${rowDisplayNameVar}=${rowConnectionVar}.displayName`;

  const [
    ,
    builderFn,
    builderActionVar,
    builderDisabledVar,
    builderHostVar,
    builderPendingVar,
    builderAuthVar,
    builderInstallVar,
    builderRestartVar,
  ] = actionBuilderMatch;
  const builderRestartPart = builderRestartVar == null ? "" : `,onRestart:${builderRestartVar}`;
  const actionBuilderReplacement =
    `function ${builderFn}({action:${builderActionVar},disabled:${builderDisabledVar},hostId:${builderHostVar},installCodexPending:${builderPendingVar},` +
    `installCodexRelease:codexLinuxRemoteControlSshInstallReleaseTarget,onAuthenticate:${builderAuthVar},onInstallCodex:${builderInstallVar}${builderRestartPart}}){` +
    `if(${builderActionVar}==null)return null;switch(${builderActionVar}.kind){case\`install-codex\`:return{disabled:${builderDisabledVar},label:${builderActionVar}.label,loading:${builderPendingVar},` +
    `loadingLabel:${builderActionVar}.loadingLabel,renderInElectronOnly:!0,tooltipText:${builderActionVar}.tooltipText,onClick:()=>${builderInstallVar}(${builderHostVar},codexLinuxRemoteControlSshInstallReleaseTarget)}`;

  const [
    ,
    gateVar,
    loadGateVar,
    errorVar,
    renderedActionVar,
    connectionActionVar,
    renderActionFn,
    disabledVar,
    connectionVar,
    pendingVar,
    restartVar,
    authenticateVar,
    installVar,
  ] = actionCallMatch;
  const restartPart = restartVar == null ? "" : `onRestart:${restartVar},`;
  const actionCallReplacement =
    `let ${gateVar}=${loadGateVar}&&(${errorVar}?.code===\`remote-codex-not-found\`||${errorVar}?.code===\`update-required\`);` +
    `${renderedActionVar}=${connectionActionVar}==null||${gateVar}?null:${renderActionFn}({action:${connectionActionVar}.action,disabled:${disabledVar},hostId:${connectionVar}.hostId,` +
    `installCodexPending:${pendingVar},installCodexRelease:${REMOTE_CONTROL_SSH_INSTALL_RELEASE_MARKER}(${errorVar}),${restartPart}onAuthenticate:${authenticateVar},onInstallCodex:${installVar}})`;

  const [
    ,
    mutationHandlerVar,
    mutationHostVar,
    mutationVar,
    mutationStateVar,
    mutationErrorVar,
    syncStateFn,
  ] = mutationMatch;
  const mutationReplacement =
    `${mutationHandlerVar}=(${mutationHostVar},codexLinuxRemoteControlSshInstallTargetRelease)=>{` +
    `let codexLinuxRemoteControlSshInstallRequest={hostId:${mutationHostVar}},` +
    `codexLinuxRemoteControlSshInstallResolvedRelease=codexLinuxRemoteControlSshInstallTargetRelease??codexLinuxRemoteControlSshInstallDefaultRelease;` +
    `codexLinuxRemoteControlSshInstallResolvedRelease!=null&&(codexLinuxRemoteControlSshInstallRequest.release=codexLinuxRemoteControlSshInstallResolvedRelease),` +
    `${mutationVar}.mutate(codexLinuxRemoteControlSshInstallRequest,{onSuccess:({state:${mutationStateVar},error:${mutationErrorVar}})=>{${syncStateFn}(${mutationHostVar},${mutationStateVar},${mutationErrorVar})}})}`;

  const helper = [
    "let codexLinuxRemoteControlSshInstallDefaultRelease=null;",
    "function codexLinuxRemoteControlValidRelease(e){return typeof e==`string`&&e.trim().length>0?e.trim():null}",
    `function ${REMOTE_CONTROL_SSH_INSTALL_RELEASE_MARKER}(e){return e?.code===\`update-required\`?codexLinuxRemoteControlValidRelease(e.minRequiredVersion):null}`,
  ].join("");

  return helper + source
    .replace(localVersionRegex, localVersionReplacement)
    .replace(actionBuilderRegex, actionBuilderReplacement)
    .replace(actionCallRegex, actionCallReplacement)
    .replace(mutationRegex, mutationReplacement);
}

function applyLinuxRemoteControlSettingsUxPatch(source) {
  let patched = applyLinuxRemoteControlSshInstallReleasePatch(replaceLinuxRemoteControlCopy(source).patched);
  patched = applyLinuxRemoteControlSshInstallActionPatch(patched);

  if (patched.includes(REMOTE_CONTROL_SETTINGS_TABS_OLD_HELPER)) {
    patched = patched.replace(REMOTE_CONTROL_SETTINGS_TABS_OLD_HELPER, REMOTE_CONTROL_SETTINGS_TABS_HELPER);
  }

  if (!patched.includes(REMOTE_CONTROL_SETTINGS_UX_MARKER)) {
    const helperNeedle = /function ([A-Za-z_$][\w$]*)\(e,t\)\{return e\.displayName\.localeCompare\(t\.displayName\)\}/u;
    const helperMatch = patched.match(helperNeedle);
    if (helperMatch == null) {
      console.warn("WARN: Could not find remote-control settings helper needle - skipping Linux remote-control settings UX patch");
      return patched;
    }
    patched = patched.replace(helperNeedle, `${REMOTE_CONTROL_SETTINGS_TABS_HELPER}${helperMatch[0]}`);
  }

  patched = wrapRemoteControlTabs(patched, "control-this-mac");
  patched = wrapRemoteControlTabs(patched, "access-other-devices");

  return patched;
}

function applyLinuxRemoteControlSelectedTabPatch(source) {
  if (
    source.includes(REMOTE_CONTROL_SELECTED_TAB_MARKER) ||
    source.includes(REMOTE_CONTROL_SELECTED_TAB_REPLACEMENT)
  ) {
    return source;
  }

  // 26.527.x moved the selected-tab resolver into the plugin-install-flow bundle
  // and added showControlOtherDevices / showRemoteSshConnections params. Keep
  // outbound control reachable on Linux while still avoiding hidden tabs.
  const newRegex =
    /function ([A-Za-z_$][\w$]*)\(\{selectedConnectionsTab:([A-Za-z_$][\w$]*),showControlOtherDevices:([A-Za-z_$][\w$]*),showControlThisMacTab:([A-Za-z_$][\w$]*),showRemoteControlConnectionsSection:([A-Za-z_$][\w$]*),showRemoteSshConnections:([A-Za-z_$][\w$]*),showTabbedSshPage:([A-Za-z_$][\w$]*)\}\)\{return ([^{}]*)\}/u;
  const newMatch = source.match(newRegex);
  if (newMatch != null) {
    const [, fn, sel, otherDevices, controlThisMac, section, sshConns, tabbedSsh, body] = newMatch;
    const replacement =
      `function ${fn}({selectedConnectionsTab:${sel},showControlOtherDevices:${otherDevices},showControlThisMacTab:${controlThisMac},showRemoteControlConnectionsSection:${section},showRemoteSshConnections:${sshConns},showTabbedSshPage:${tabbedSsh}}){` +
      `/*${REMOTE_CONTROL_SELECTED_TAB_MARKER}*/if(typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)){` +
      `if(!${section})return ${sshConns}?\`ssh\`:\`access-other-devices\`;` +
      `if(${sel}===\`control-this-mac\`&&!${controlThisMac})return ${otherDevices}?\`access-other-devices\`:\`ssh\`;` +
      `if(${sel}===\`access-other-devices\`&&!${otherDevices})return ${controlThisMac}?\`control-this-mac\`:\`ssh\`;` +
      `if(${sel}===\`ssh\`&&!${tabbedSsh})return ${otherDevices}?\`access-other-devices\`:${controlThisMac}?\`control-this-mac\`:\`ssh\`;return ${sel}}` +
      `return ${body}}`;
    return source.replace(newRegex, replacement);
  }

  // Legacy 4-param shape (pre-26.527.x).
  const oldMatch = source.match(REMOTE_CONTROL_SELECTED_TAB_REGEX);
  if (oldMatch != null) {
    const [, functionName, selectedVar, controlThisMacVar, sectionVar, sshVar] = oldMatch;
    const replacement =
      `function ${functionName}({selectedConnectionsTab:${selectedVar},showControlThisMacTab:${controlThisMacVar},showRemoteControlConnectionsSection:${sectionVar},showTabbedSshPage:${sshVar}}){` +
      `/*${REMOTE_CONTROL_SELECTED_TAB_MARKER}*/let i=typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`);` +
      `if(i){if(!${sectionVar})return\`ssh\`;if(${selectedVar}===\`control-this-mac\`&&!${controlThisMacVar})return\`access-other-devices\`;` +
      `if(${selectedVar}===\`ssh\`&&!${sshVar})return\`access-other-devices\`;return ${selectedVar}}` +
      `return ${sectionVar}?${selectedVar}===\`control-this-mac\`&&!${controlThisMacVar}||${selectedVar}===\`ssh\`&&!${sshVar}?\`access-other-devices\`:${selectedVar}:\`ssh\`}`;
    return source.replace(REMOTE_CONTROL_SELECTED_TAB_REGEX, replacement);
  }

  if (/function [A-Za-z_$][\w$]*\(\{selectedConnectionsTab:/u.test(source)) {
    console.warn("WARN: Could not find remote-control selected-tab needle - skipping Linux remote-control selected-tab patch");
  }
  return source;
}

function applyLinuxRemoteConnectionsRefreshPatch(source) {
  if (source.includes(REMOTE_CONNECTIONS_REFRESH_MARKER)) {
    return source;
  }

  let patched = source;
  const intervalConstantRegex = /(^|[,\s;])([A-Za-z_$][\w$]*)=15e3(?=[,;])/u;
  if (patched.includes("Qn=15e3")) {
    patched = patched.replace("Qn=15e3", "Qn=5e3");
  } else if (intervalConstantRegex.test(patched) && patched.includes("refresh-remote-connections")) {
    patched = patched.replace(intervalConstantRegex, "$1$2=5e3");
  } else if (patched.includes("15e3") && patched.includes("refresh-remote-connections")) {
    console.warn("WARN: Could not find remote-connections refresh interval constant - skipping interval patch");
  }

  const effectPattern =
    /\(0,([A-Za-z_$][\w$]*)\.useEffect\)\(\(\)=>\{let ([A-Za-z_$][\w$]*)=null,([A-Za-z_$][\w$]*)=!1,([A-Za-z_$][\w$]*)=async\(\)=>\{if\(![A-Za-z_$][\w$]*\)\{[A-Za-z_$][\w$]*=!0,[A-Za-z_$][\w$]*=new AbortController;try\{await ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.signal\)\}finally\{[A-Za-z_$][\w$]*=null,[A-Za-z_$][\w$]*=!1\}\}\},([A-Za-z_$][\w$]*)=window\.setInterval\(\(\)=>\{[A-Za-z_$][\w$]*\(\)\},([A-Za-z_$][\w$]*)\);return\(\)=>\{[A-Za-z_$][\w$]*\?\.abort\(\),window\.clearInterval\([A-Za-z_$][\w$]*\)\}\},\[\]\);/;
  const match = patched.match(effectPattern);
  if (match == null) {
    if (patched.includes("refresh-remote-connections") && patched.includes("setInterval")) {
      console.warn("WARN: Could not find remote-connections auto-refresh effect - skipping resume refresh patch");
    }
    return patched;
  }

  const [
    needle,
    reactVar,
    abortVar,
    pendingVar,
    refreshVar,
    refreshEventVar,
    intervalVar,
    intervalConstantVar,
  ] = match;
  const replacement =
    `(0,${reactVar}.useEffect)(()=>{let ${abortVar}=null,${pendingVar}=!1,${refreshVar}=async()=>{if(!${pendingVar}){${pendingVar}=!0,${abortVar}=new AbortController;try{await ${refreshEventVar}(${abortVar}.signal)}finally{${abortVar}=null,${pendingVar}=!1}}},` +
    `codexLinuxRemoteConnectionsRefreshTimer=null,codexLinuxRemoteConnectionsRefreshLast=0,${REMOTE_CONNECTIONS_REFRESH_MARKER}=()=>{if(document.visibilityState===\`hidden\`)return;let e=Date.now(),t=()=>{codexLinuxRemoteConnectionsRefreshLast=Date.now(),codexLinuxRemoteConnectionsRefreshTimer=null,${refreshVar}()};if(e-codexLinuxRemoteConnectionsRefreshLast<1e3){codexLinuxRemoteConnectionsRefreshTimer!=null&&window.clearTimeout(codexLinuxRemoteConnectionsRefreshTimer),codexLinuxRemoteConnectionsRefreshTimer=window.setTimeout(t,1e3-(e-codexLinuxRemoteConnectionsRefreshLast));return}t()},` +
    `${intervalVar}=window.setInterval(()=>{${refreshVar}()},${intervalConstantVar});` +
    `document.addEventListener(\`visibilitychange\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`focus\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`online\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.addEventListener(\`resume\`,${REMOTE_CONNECTIONS_REFRESH_MARKER});` +
    `return()=>{${abortVar}?.abort(),window.clearInterval(${intervalVar}),` +
    `codexLinuxRemoteConnectionsRefreshTimer!=null&&window.clearTimeout(codexLinuxRemoteConnectionsRefreshTimer),` +
    `document.removeEventListener(\`visibilitychange\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`focus\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`online\`,${REMOTE_CONNECTIONS_REFRESH_MARKER}),` +
    `window.removeEventListener(\`resume\`,${REMOTE_CONNECTIONS_REFRESH_MARKER})}},[]);`;

  return patched.replace(needle, replacement);
}

function applyLinuxRemoteMobileChromeBridgePatch(source) {
  if (source.includes(REMOTE_MOBILE_CHROME_BRIDGE_MARKER)) {
    return source;
  }

  if (browserClientHasNativeChromeBackendPreferenceRouting(source)) {
    return source;
  }

  // 26.527.x moved the browser-use backend allowlist from the
  // x-codex-browser-use-available-backends request-meta header to the
  // BROWSER_USE_AVAILABLE_BACKENDS config value (var dy), renamed the allowlist
  // (X6->e2 / rE->ly) and reader (yC->_y), and dropped the native-pipe diagnostic.
  const backendNeedle =
    "var e2=[\"chrome\",\"iab\",\"cdp\"];function ly(e){return e2.some(t=>t===e)}";
  const backendReplacement =
    "var e2=[\"chrome\",\"iab\",\"cdp\"];function ly(e){return e2.some(t=>t===e)}function codexLinuxRemoteMobileBrowserBackends(e){if(e==null)return null;if(!Array.isArray(e))return[];let t=e.filter(ly);return typeof process!=`undefined`&&process.platform===`linux`&&!t.includes(`chrome`)?[`chrome`,...t]:t}";
  const currentBackendNeedle =
    "function _y(){let e=Su(dy);return e==null?null:vy(e).filter(ly)}";
  const currentBackendReplacement =
    "function _y(){let e=Su(dy);return codexLinuxRemoteMobileBrowserBackends(e==null?null:vy(e))}";

  if (source.includes(backendNeedle) && source.includes(currentBackendNeedle)) {
    return source
      .replace(backendNeedle, backendReplacement)
      .replace(currentBackendNeedle, currentBackendReplacement);
  }

  const backendAllowlistPattern =
    /var ([A-Za-z_$][\w$]*)=\["chrome","iab","cdp"\];function ([A-Za-z_$][\w$]*)\(e\)\{return \1\.some\(t=>t===e\)\}/u;
  const readerPattern =
    /function ([A-Za-z_$][\w$]*)\(\)\{let e=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\);return e==null\?null:([A-Za-z_$][\w$]*)\(e\)\.filter\(([A-Za-z_$][\w$]*)\)\}/u;
  const allowlistMatch = source.match(backendAllowlistPattern);
  const readerMatch = source.match(readerPattern);
  if (allowlistMatch != null && readerMatch != null && readerMatch[5] === allowlistMatch[2]) {
    const [, allowlistVar, allowlistFn] = allowlistMatch;
    const [, readerFn, envReaderFn, backendsEnvVar, parseBackendsFn] = readerMatch;
    return source
      .replace(
        backendAllowlistPattern,
        `var ${allowlistVar}=["chrome","iab","cdp"];function ${allowlistFn}(e){return ${allowlistVar}.some(t=>t===e)}function codexLinuxRemoteMobileBrowserBackends(e){if(e==null)return null;if(!Array.isArray(e))return[];let t=e.filter(${allowlistFn});return typeof process!=\`undefined\`&&process.platform===\`linux\`&&!t.includes(\`chrome\`)?[\`chrome\`,...t]:t}`,
      )
      .replace(
        readerPattern,
        `function ${readerFn}(){let e=${envReaderFn}(${backendsEnvVar});return codexLinuxRemoteMobileBrowserBackends(e==null?null:${parseBackendsFn}(e))}`,
      );
  }

  console.warn("WARN: Could not find Chrome browser-client backend allowlist needles - skipping remote-mobile Chrome bridge patch");
  return source;
}

function browserClientHasNativeChromeBackendPreferenceRouting(source) {
  return (
    source.includes("BROWSER_USE_AVAILABLE_BACKENDS") &&
    source.includes("browserPreference") &&
    source.includes("preferredWindowIdFor") &&
    /var [A-Za-z_$][\w$]*=\["chrome","iab","cdp"\];function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\{return [A-Za-z_$][\w$]*\.some\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*===[A-Za-z_$][\w$]*\)\}/u.test(source)
  );
}

function buildLateUnknownConversationHydrationReplacement(eventName, conversationIdVar, loggerVar) {
  const pendingMapVar = "codexLinuxRemoteMobilePendingMap";
  const queueVar = "codexLinuxRemoteMobileQueue";
  const inFlightVar = "codexLinuxRemoteMobileInFlight";
  const readVar = "codexLinuxRemoteMobileRead";
  return (
    `if(!this.conversations.get(${conversationIdVar})){/*${REMOTE_MOBILE_LATE_EVENT_HYDRATION_MARKER}*/` +
    `let ${pendingMapVar}=this.codexLinuxRemoteMobilePendingNotifications??=new Map,${queueVar}=${pendingMapVar}.get(${conversationIdVar});` +
    `${queueVar}||(${queueVar}=[],${pendingMapVar}.set(${conversationIdVar},${queueVar})),${queueVar}.push(n);` +
    `let ${inFlightVar}=this.codexLinuxRemoteMobileInFlightHydrations??=new Set;` +
    `if(${inFlightVar}.has(${conversationIdVar})){${loggerVar}.warning(\`Queueing ${eventName} for hydrating conversation\`,{safe:{conversationId:${conversationIdVar},queuedNotificationCount:${queueVar}.length},sensitive:{}});break}` +
    `${loggerVar}.warning(\`Hydrating conversation for ${eventName}\`,{safe:{conversationId:${conversationIdVar},queuedNotificationCount:${queueVar}.length},sensitive:{}});` +
    `let ${readVar}=(s=0)=>this.readThread(${conversationIdVar},{includeTurns:!0}).then(e=>{let t=e?.thread??e,c=this.codexLinuxRemoteMobilePendingNotifications?.get(${conversationIdVar})??[],codexLinuxRemoteMobileTurns=Array.isArray(e?.turns)?e.turns:Array.isArray(t?.turns)?t.turns:null;` +
    `if(!t||!Array.isArray(codexLinuxRemoteMobileTurns)||codexLinuxRemoteMobileTurns.length===0){if(s<12){${loggerVar}.warning(\`Retrying hydration for missing conversation\`,{safe:{conversationId:${conversationIdVar},queuedNotificationCount:c.length,attempt:s+1},sensitive:{}}),setTimeout(()=>${readVar}(s+1),250);return}` +
    `this.codexLinuxRemoteMobilePendingNotifications?.delete(${conversationIdVar}),this.codexLinuxRemoteMobileInFlightHydrations?.delete(${conversationIdVar}),${loggerVar}.warning(\`Skipping hydration for missing conversation\`,{safe:{conversationId:${conversationIdVar},queuedNotificationCount:c.length},sensitive:{}});return}` +
    `this.upsertConversationFromThread(t),this.codexLinuxRemoteMobilePendingNotifications?.delete(${conversationIdVar}),this.codexLinuxRemoteMobileInFlightHydrations?.delete(${conversationIdVar});for(let e of c)this.onNotification(e.method,e.params)})` +
    `.catch(e=>{if(s<12){${loggerVar}.warning(\`Retrying hydration for ${eventName}\`,{safe:{conversationId:${conversationIdVar},attempt:s+1},sensitive:{error:e}}),setTimeout(()=>${readVar}(s+1),250);return}` +
    `this.codexLinuxRemoteMobilePendingNotifications?.delete(${conversationIdVar}),this.codexLinuxRemoteMobileInFlightHydrations?.delete(${conversationIdVar}),${loggerVar}.error(\`Failed to hydrate conversation for ${eventName}\`,{safe:{conversationId:${conversationIdVar}},sensitive:{error:e}})});` +
    `${inFlightVar}.add(${conversationIdVar}),${readVar}();break}`
  );
}

function applyLinuxRemoteMobileConversationHydrationPatch(source) {
  let patched = source;

  if (!patched.includes(REMOTE_MOBILE_THREAD_RUNTIME_MARKER)) {
    const runtimeReplacement =
      (_needle, conversationVar, runtimeVar) =>
        `/*${REMOTE_MOBILE_THREAD_RUNTIME_MARKER}*/(${conversationVar}.resumeState===\`needs_resume\`||${runtimeVar}?.type===\`active\`||${runtimeVar}?.type===\`idle\`)&&(${conversationVar}.threadRuntimeStatus=${runtimeVar})`;
    const runtimeNeedle =
      /([A-Za-z_$][\w$]*)\.resumeState===`needs_resume`&&\(\1\.threadRuntimeStatus=([A-Za-z_$][\w$]*)\)/u;
    if (runtimeNeedle.test(patched)) {
      patched = patched.replace(runtimeNeedle, runtimeReplacement);
    } else if (
      patched.includes("threadRuntimeStatus:e.threadRuntimeStatus") &&
      patched.includes("t===`needs_resume`?n?.type===`active`")
    ) {
      // Current upstream preserves threadRuntimeStatus on thread summaries and
      // already treats active needs-resume threads as live in the sidebar model.
    } else if (patched.includes("threadRuntimeStatus") && patched.includes("resumeState")) {
      console.warn("WARN: Could not find thread/list runtime-status needle - skipping remote mobile runtime-status patch");
    }
  }

  // Hydrate on turn/started and queue later events while that read is in flight.
  if (!patched.includes(REMOTE_MOBILE_NOTIFICATION_QUEUE_MARKER)) {
    const unknownTurnNeedle =
      /(let\{threadId:([A-Za-z_$][\w$]*),turn:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\.params,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\);)if\(!this\.conversations\.get\(\4\)\)\{([A-Za-z_$][\w$]*)\.error\(`Received turn\/started for unknown conversation`,\{safe:\{conversationId:\4\},sensitive:\{\}\}\);break\}/u;
    const unknownTurnReplacement =
      (_needle, prefix, _threadIdParamVar, notificationVar, conversationIdVar, normalizerFn, loggerVar) =>
        `${prefix}if(!this.conversations.get(${conversationIdVar})){/*${REMOTE_MOBILE_UNKNOWN_TURN_MARKER}*//*${REMOTE_MOBILE_NOTIFICATION_QUEUE_MARKER}*//*${REMOTE_MOBILE_IN_FLIGHT_HYDRATION_MARKER}*/let l=${notificationVar}.params?.turn?.threadId??${notificationVar}.params?.thread?.id,d=l!=null?${normalizerFn}(l):null,u=${notificationVar}.params?.turn?.id??${notificationVar}.params?.turnId;if(d==null||u!=null&&d===${normalizerFn}(u)){${loggerVar}.warning(\`Skipping hydration for ambiguous turn/started\`,{safe:{conversationId:${conversationIdVar},resolvedConversationId:d,turnId:u??null},sensitive:{}});break}${notificationVar}={...${notificationVar},params:{...${notificationVar}.params,threadId:l}};if(this.conversations.get(d)){this.onNotification(${notificationVar}.method,${notificationVar}.params);break}let i=this.codexLinuxRemoteMobilePendingNotifications??=new Map,a=i.get(d);a||(a=[],i.set(d,a));let p=u!=null?a.findIndex(e=>{let t=e.params?.turn?.id??e.params?.turnId;return e.method===${notificationVar}.method&&t!=null&&${normalizerFn}(t)===${normalizerFn}(u)}):-1;p>=0?a[p]=${notificationVar}:a.push(${notificationVar});let h=this.codexLinuxRemoteMobileInFlightHydrations??=new Set;if(h.has(d)){${loggerVar}.warning(\`Queueing turn/started for hydrating conversation\`,{safe:{conversationId:d,queuedNotificationCount:a.length,dedupedNotification:p>=0},sensitive:{}});break}${loggerVar}.warning(\`Hydrating conversation for turn/started\`,{safe:{conversationId:d,queuedNotificationCount:a.length},sensitive:{}});let o=(s=0)=>this.readThread(d,{includeTurns:!0}).then(e=>{let t=e?.thread??e,c=this.codexLinuxRemoteMobilePendingNotifications?.get(d)??[],codexLinuxRemoteMobileTurns=Array.isArray(e?.turns)?e.turns:Array.isArray(t?.turns)?t.turns:null;if(!t||!Array.isArray(codexLinuxRemoteMobileTurns)||codexLinuxRemoteMobileTurns.length===0){if(s<12){${loggerVar}.warning(\`Retrying hydration for missing conversation\`,{safe:{conversationId:d,queuedNotificationCount:c.length,attempt:s+1},sensitive:{}}),setTimeout(()=>o(s+1),250);return}this.codexLinuxRemoteMobilePendingNotifications?.delete(d),this.codexLinuxRemoteMobileInFlightHydrations?.delete(d),${loggerVar}.warning(\`Skipping hydration for missing conversation\`,{safe:{conversationId:d,queuedNotificationCount:c.length},sensitive:{}});return}this.upsertConversationFromThread(t),this.codexLinuxRemoteMobilePendingNotifications?.delete(d),this.codexLinuxRemoteMobileInFlightHydrations?.delete(d);for(let e of c)this.onNotification(e.method,e.params)}).catch(e=>{if(s<12){${loggerVar}.warning(\`Retrying hydration for turn/started\`,{safe:{conversationId:d,attempt:s+1},sensitive:{error:e}}),setTimeout(()=>o(s+1),250);return}this.codexLinuxRemoteMobilePendingNotifications?.delete(d),this.codexLinuxRemoteMobileInFlightHydrations?.delete(d),${loggerVar}.error(\`Failed to hydrate conversation for turn/started\`,{safe:{conversationId:d},sensitive:{error:e}})});h.add(d),o();break}`;
    if (unknownTurnNeedle.test(patched)) {
      patched = patched.replace(unknownTurnNeedle, unknownTurnReplacement);
    } else if (patched.includes("Received turn/started for unknown conversation")) {
      console.warn("WARN: Could not find unknown turn/started needle - skipping remote mobile hydration patch");
    }

    const itemStartedNeedle =
      /if\(!this\.conversations\.get\(([A-Za-z_$][\w$]*)\)\)\{([A-Za-z_$][\w$]*)\.error\(`Received item\/started for unknown conversation`,\{safe:\{conversationId:\1\},sensitive:\{\}\}\);break\}/u;
    if (itemStartedNeedle.test(patched)) {
      patched = patched.replace(
        itemStartedNeedle,
        (_needle, conversationIdVar, loggerVar) =>
          buildLateUnknownConversationHydrationReplacement("item/started", conversationIdVar, loggerVar),
      );
    } else if (patched.includes("Received item/started for unknown conversation")) {
      console.warn("WARN: Could not find unknown item/started needle - skipping remote mobile item queue patch");
    }

    const itemCompletedNeedle =
      /if\(!this\.conversations\.get\(([A-Za-z_$][\w$]*)\)\)\{([A-Za-z_$][\w$]*)\.error\(`Received item\/completed for unknown conversation`,\{safe:\{conversationId:\1\},sensitive:\{\}\}\);break\}/u;
    if (itemCompletedNeedle.test(patched)) {
      patched = patched.replace(
        itemCompletedNeedle,
        (_needle, conversationIdVar, loggerVar) =>
          buildLateUnknownConversationHydrationReplacement("item/completed", conversationIdVar, loggerVar),
      );
    } else if (patched.includes("Received item/completed for unknown conversation")) {
      console.warn("WARN: Could not find unknown item/completed needle - skipping remote mobile item queue patch");
    }

    const turnCompletedNeedle =
      /if\(!this\.conversations\.get\(([A-Za-z_$][\w$]*)\)\)\{([A-Za-z_$][\w$]*)\.error\(`Received turn\/completed for unknown conversation`,\{safe:\{conversationId:\1\},sensitive:\{\}\}\);break\}/u;
    const turnCompletedReplacement =
      (_needle, conversationIdVar, loggerVar) =>
        buildLateUnknownConversationHydrationReplacement("turn/completed", conversationIdVar, loggerVar);
    if (turnCompletedNeedle.test(patched)) {
      patched = patched.replace(turnCompletedNeedle, turnCompletedReplacement);
    } else if (patched.includes("Received turn/completed for unknown conversation")) {
      console.warn("WARN: Could not find unknown turn/completed needle - skipping remote mobile turn queue patch");
    }
  }

  return patched;
}

function applyLinuxRemoteMobileCompletedItemRecoveryPatch(source) {
  if (source.includes(REMOTE_MOBILE_COMPLETED_ITEM_MARKER)) {
    return source;
  }

  const completedItemDropPattern =
    /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)&&\(([A-Za-z_$][\w$]*)\.firstTurnWorkItemStartedAtMs=\3\.firstTurnWorkItemStartedAtMs\?\?Date\.now\(\)\),!\(\2\.type!==`subAgentActivity`&&!([A-Za-z_$][\w$]*)\(\3,\2\.id,\2\.type\)\)&&\(\2\.type,([A-Za-z_$][\w$]*)\(\3,([A-Za-z_$][\w$]*)\)\)/u;

  if (completedItemDropPattern.test(source)) {
    return source.replace(
      completedItemDropPattern,
      (
        _match,
        workItemPredicate,
        completedItemVar,
        turnVar,
        findItemFn,
        upsertItemFn,
        viewItemVar,
      ) =>
        `${workItemPredicate}(${completedItemVar})&&(${turnVar}.firstTurnWorkItemStartedAtMs=${turnVar}.firstTurnWorkItemStartedAtMs??Date.now());let codexLinuxCompletedItemExists=${turnVar}.items.some(e=>e.id===${viewItemVar}.id);if(${completedItemVar}.type!==\`subAgentActivity\`&&codexLinuxCompletedItemExists&&!${findItemFn}(${turnVar},${completedItemVar}.id,${completedItemVar}.type))return;${upsertItemFn}(${turnVar},${viewItemVar})`,
    );
  }

  if (
    source.includes("Item not found in turn state") &&
    source.includes("case`item/completed`") &&
    source.includes("item/agentMessage/delta")
  ) {
    console.warn(
      "WARN: Could not find completed item recovery insertion point - skipping remote mobile completed item recovery patch",
    );
  }

  return source;
}

function applyLinuxRemoteTerminalStatusRecoveryPatch(source) {
  if (
    source.includes("codexLinuxRemoteTerminalStatusWaitingOnUserInput") &&
    source.includes("hasUserInputRequest:codexLinuxRemoteHasUserInputRequest") &&
    source.includes("&&codexLinuxRemoteHasUserInputRequest")
  ) {
    return source;
  }

  if (
    !source.includes("hasInProgressSideChat") ||
    !source.includes("isResponseInProgress") ||
    !source.includes("threadRuntimeStatus") ||
    !source.includes("pendingRequestType")
  ) {
    return source;
  }

  const userInputRequestHelper =
    "function codexLinuxRemoteHasUserInputRequest(e){try{return Array.isArray(e)&&e.some(e=>e?.method===`item/tool/requestUserInput`||e?.method===`item/tool/requestOptionPicker`||e?.method===`item/tool/requestSetupCodexContextPicker`||e?.method===`item/tool/call`&&(e?.params?.tool===`request_onboarding_input`||e?.params?.tool===`request_option_picker`||e?.params?.tool===`setup_codex_context_picker`||e?.params?.tool===`setup_codex_step`))}catch{return!1}}";
  const buildTerminalStatusReplacement = (
    fnName,
    sideChatVar,
    responseProgressVar,
    systemErrorVar,
    resumeStateVar,
    runtimeStatusVar,
  ) =>
    `function ${fnName}({hasInProgressSideChat:${sideChatVar},isResponseInProgress:${responseProgressVar},latestTurnHasSystemError:${systemErrorVar},resumeState:${resumeStateVar},threadRuntimeStatus:${runtimeStatusVar},hasUserInputRequest:codexLinuxRemoteHasUserInputRequestPending=!0}){let codexLinuxRemoteTerminalStatusActive=${runtimeStatusVar}?.type===\`active\`,codexLinuxRemoteTerminalStatusActiveFlags=Array.isArray(${runtimeStatusVar}?.activeFlags)?${runtimeStatusVar}.activeFlags:null,codexLinuxRemoteTerminalStatusWaitingOnUserInput=codexLinuxRemoteTerminalStatusActiveFlags?.includes(\`waitingOnUserInput\`)===!0,codexLinuxRemoteTerminalStatusLoading=codexLinuxRemoteTerminalStatusActive&&(${responseProgressVar}===!0||codexLinuxRemoteTerminalStatusActiveFlags==null||codexLinuxRemoteTerminalStatusActiveFlags.length>0&&(!codexLinuxRemoteTerminalStatusWaitingOnUserInput||codexLinuxRemoteHasUserInputRequestPending===!0));return ${sideChatVar}?\`loading\`:${runtimeStatusVar}?.type===\`systemError\`?\`error\`:codexLinuxRemoteTerminalStatusLoading?\`loading\`:${resumeStateVar}===\`needs_resume\`?\`idle\`:${systemErrorVar}?\`error\`:${responseProgressVar}===!0?\`loading\`:\`idle\`}`;

  const terminalStatusPattern =
    /function ([A-Za-z_$][\w$]*)\(\{hasInProgressSideChat:([A-Za-z_$][\w$]*),isResponseInProgress:([A-Za-z_$][\w$]*),latestTurnHasSystemError:([A-Za-z_$][\w$]*),resumeState:([A-Za-z_$][\w$]*),threadRuntimeStatus:([A-Za-z_$][\w$]*)\}\)\{return \2\?`loading`:\6\?\.type===`systemError`\?`error`:\6\?\.type===`active`\?`loading`:\5===`needs_resume`\?`idle`:\4\?`error`:\3===!0\?`loading`:`idle`\}/u;
  const terminalStatusMatch = source.match(terminalStatusPattern);
  if (terminalStatusMatch == null) {
    console.warn(
      "WARN: Could not find remote terminal status function - skipping Linux remote terminal status recovery patch",
    );
    return source;
  }
  const [
    ,
    terminalStatusFnName,
    sideChatVar,
    responseProgressVar,
    systemErrorVar,
    resumeStateVar,
    runtimeStatusVar,
  ] = terminalStatusMatch;

  const pendingRequestPattern =
    /function ([A-Za-z_$][\w$]*)\(\{pendingRequestType:([A-Za-z_$][\w$]*),requests:([A-Za-z_$][\w$]*),resumeState:([A-Za-z_$][\w$]*),threadRuntimeStatus:([A-Za-z_$][\w$]*)\}\)\{return \3==null\|\|\4==null\?null:\4===`needs_resume`\?\5\?\.type===`active`&&\5\.activeFlags\.includes\(`waitingOnApproval`\)&&([A-Za-z_$][\w$]*)\(\3\)\?`approval`:\5\?\.type===`active`&&\5\.activeFlags\.includes\(`waitingOnUserInput`\)\?`response`:null:([A-Za-z_$][\w$]*)\(\2\)\?`approval`:\2===`userInput`\?`response`:null\}/u;
  const pendingRequestMatch = source.match(pendingRequestPattern);
  if (pendingRequestMatch == null) {
    console.warn(
      "WARN: Could not find remote pending-request function - skipping Linux remote terminal status recovery patch",
    );
    return source;
  }
  const [
    ,
    pendingRequestFnName,
    pendingTypeVar,
    requestsVar,
    pendingResumeStateVar,
    pendingRuntimeStatusVar,
    approvalRequestFn,
    approvalTypeFn,
  ] = pendingRequestMatch;

  const pendingCallPattern = new RegExp(
    `${escapeRegExp(pendingRequestFnName)}\\(\\{pendingRequestType:[^{}]+?,requests:([^{}]*\\([^{}]*\\)[^{}]*?),resumeState:[^{}]+?,threadRuntimeStatus:[^{}]+?\\}\\)`,
    "u",
  );
  const requestExpression = source.match(pendingCallPattern)?.[1] ?? null;
  const terminalCallPattern = new RegExp(
    `${escapeRegExp(terminalStatusFnName)}\\(\\{hasInProgressSideChat:([^{}]+?),isResponseInProgress:([^{}]+?),resumeState:([^{}]+?),threadRuntimeStatus:([^{}]+?),latestTurnHasSystemError:([^{}]+?)\\}\\)`,
    "u",
  );
  if (requestExpression == null || !terminalCallPattern.test(source)) {
    console.warn(
      "WARN: Could not wire remote terminal status to pending user-input requests - skipping Linux remote terminal status recovery patch",
    );
    return source;
  }

  let patched = source.replace(
    terminalStatusPattern,
    `${userInputRequestHelper}${buildTerminalStatusReplacement(
      terminalStatusFnName,
      sideChatVar,
      responseProgressVar,
      systemErrorVar,
      resumeStateVar,
      runtimeStatusVar,
    )}`,
  );
  patched = patched.replace(
    pendingRequestPattern,
    `function ${pendingRequestFnName}({pendingRequestType:${pendingTypeVar},requests:${requestsVar},resumeState:${pendingResumeStateVar},threadRuntimeStatus:${pendingRuntimeStatusVar}}){return ${requestsVar}==null||${pendingResumeStateVar}==null?null:${pendingResumeStateVar}===\`needs_resume\`?${pendingRuntimeStatusVar}?.type===\`active\`&&Array.isArray(${pendingRuntimeStatusVar}?.activeFlags)&&${pendingRuntimeStatusVar}.activeFlags.includes(\`waitingOnApproval\`)&&${approvalRequestFn}(${requestsVar})?\`approval\`:${pendingRuntimeStatusVar}?.type===\`active\`&&Array.isArray(${pendingRuntimeStatusVar}?.activeFlags)&&${pendingRuntimeStatusVar}.activeFlags.includes(\`waitingOnUserInput\`)&&codexLinuxRemoteHasUserInputRequest(${requestsVar})?\`response\`:null:${approvalTypeFn}(${pendingTypeVar})?\`approval\`:${pendingTypeVar}===\`userInput\`?\`response\`:null}`,
  );
  patched = patched.replace(
    terminalCallPattern,
    `${terminalStatusFnName}({hasInProgressSideChat:$1,isResponseInProgress:$2,resumeState:$3,threadRuntimeStatus:$4,latestTurnHasSystemError:$5,hasUserInputRequest:codexLinuxRemoteHasUserInputRequest(${requestExpression})})`,
  );

  return patched;
}

function applyLinuxRemoteControlStatusReadGuardPatch(source) {
  if (source.includes(REMOTE_CONTROL_STATUS_READ_GUARD_MARKER)) {
    return source;
  }
  if (!source.includes("remoteControl/status/read")) {
    return source;
  }

  const statusReadPattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=\3\.getHostId\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2,\4\),([A-Za-z_$][\w$]*)=\2\.get\(([A-Za-z_$][\w$]*),\4\);\3\.addNotificationCallback\(`remoteControl\/status\/changed`,\(\{params:([A-Za-z_$][\w$]*)\}\)=>\{([A-Za-z_$][\w$]*)\(\2,\4,\5\)&&([A-Za-z_$][\w$]*)\(\2,\4,\9\)\}\),\3\.sendRequest\(`remoteControl\/status\/read`,void 0\)\.then\(([A-Za-z_$][\w$]*)=>\{\2\.get\(\8,\4\)===\7&&\10\(\2,\4,\5\)&&\11\(\2,\4,\12\)\}\)\.catch\(([A-Za-z_$][\w$]*)=>\{\10\(\2,\4,\5\)&&([A-Za-z_$][\w$]*)\.error\(`Failed to read remote-control status`,\{safe:\{\},sensitive:\{error:\13\}\}\)\}\)\}/u;
  const match = source.match(statusReadPattern);
  if (match == null) {
    console.warn("WARN: Could not find remote-control status read needle - skipping Linux remote-control status guard patch");
    return source;
  }

  const [
    needle,
    functionName,
    storeVar,
    clientVar,
    hostVar,
    generationVar,
    generationFn,
    initialValueVar,
    statusAtomVar,
    notificationParamsVar,
    isCurrentFn,
    statusSetterFn,
    readResultVar,
    errorVar,
    loggerVar,
  ] = match;
  const replacement =
    `function ${REMOTE_CONTROL_STATUS_READ_GUARD_MARKER}(e){return !(typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)&&typeof e==\`string\`&&(e.startsWith(\`remote-ssh\`)||e.startsWith(\`remote-control:\`)))}` +
    `function ${functionName}(${storeVar},${clientVar}){let ${hostVar}=${clientVar}.getHostId(),${generationVar}=${generationFn}(${storeVar},${hostVar}),${initialValueVar}=${storeVar}.get(${statusAtomVar},${hostVar});` +
    `${clientVar}.addNotificationCallback(\`remoteControl/status/changed\`,({params:${notificationParamsVar}})=>{${isCurrentFn}(${storeVar},${hostVar},${generationVar})&&${statusSetterFn}(${storeVar},${hostVar},${notificationParamsVar})});` +
    `if(!${REMOTE_CONTROL_STATUS_READ_GUARD_MARKER}(${hostVar})){${isCurrentFn}(${storeVar},${hostVar},${generationVar})&&${statusSetterFn}(${storeVar},${hostVar},{status:\`disabled\`,available:!1,accessRequired:!1});return}` +
    `${clientVar}.sendRequest(\`remoteControl/status/read\`,void 0).then(${readResultVar}=>{${storeVar}.get(${statusAtomVar},${hostVar})===${initialValueVar}&&${isCurrentFn}(${storeVar},${hostVar},${generationVar})&&${statusSetterFn}(${storeVar},${hostVar},${readResultVar})}).catch(${errorVar}=>{${isCurrentFn}(${storeVar},${hostVar},${generationVar})&&${loggerVar}.error(\`Failed to read remote-control status\`,{safe:{},sensitive:{error:${errorVar}}})})}`;

  return source.replace(needle, replacement);
}

function applyLinuxRemoteControlStatusWaitPatch(source) {
  if (source.includes(REMOTE_CONTROL_STATUS_WAIT_MARKER)) {
    return source;
  }
  if (
    !source.includes("Timed out waiting for remote control to connect") ||
    !source.includes("remoteControl/status/changed")
  ) {
    return source;
  }

  const timeoutVariableMatch = source.match(
    /setTimeout\(\(\)=>\{[^}]{0,300}Timed out waiting for remote control to connect[^}]{0,300}\},([A-Za-z_$][\w$]*)\)/u,
  );
  if (timeoutVariableMatch == null) {
    console.warn("WARN: Could not find remote-control status timeout variable - skipping Linux remote-control status wait patch");
    return source;
  }

  const timeoutVariable = timeoutVariableMatch[1];
  const statusWaitRegex = new RegExp(
    `\\b${escapeRegExp(timeoutVariable)}=5e3(?=,[A-Za-z_$][\\w$]*=([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*),e=>null\\),[A-Za-z_$][\\w$]*=\\1\\(\\2,e=>!1\\),[A-Za-z_$][\\w$]*=[A-Za-z_$][\\w$]*\\(\\2,)`,
    "u",
  );
  if (!statusWaitRegex.test(source)) {
    console.warn("WARN: Could not find remote-control status wait needle - skipping Linux remote-control status wait patch");
    return source;
  }

  return source.replace(
    statusWaitRegex,
    `${timeoutVariable}=typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)?3e4:5e3/*${REMOTE_CONTROL_STATUS_WAIT_MARKER}*/`,
  );
}

function applyLinuxRemoteControlEnablementBridgePatch(source) {
  let patched = source;

  patched = applyLinuxRemoteControlEnableForHostParamsPatch(patched);

  const markerIndex = patched.indexOf("[remote-connections/slingshot-gate-bridge]");
  if (markerIndex < 0 || patched.indexOf("set-remote-control-connections-enabled", markerIndex) < 0) {
    return patched;
  }

  let region = patched.slice(markerIndex, markerIndex + 4_500);

  if (!patched.includes(REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER)) {
    const currentBridgePattern =
      /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(6\),\{checkGate:([A-Za-z_$][\w$]*),isLoading:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*);\2\[0\]===\4\?\7=\2\[1\]:\(\7=\4\(`1042620455`\),\2\[0\]=\4,\2\[1\]=\7\);let ([A-Za-z_$][\w$]*)=\7,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*);return /u;
    let patchedRegion = region.replace(
      currentBridgePattern,
      (_needle, functionName, cacheVar, compilerVar, checkGateVar, isLoadingVar, gateHookVar, gateValueVar, enabledVar, callbackVar, depsVar) =>
        `function ${functionName}(){let ${cacheVar}=(0,${compilerVar}.c)(6),{checkGate:${checkGateVar},isLoading:${isLoadingVar}}=${gateHookVar}(),${gateValueVar};${cacheVar}[0]===${checkGateVar}?${gateValueVar}=${cacheVar}[1]:(${gateValueVar}=${checkGateVar}(\`1042620455\`),${cacheVar}[0]=${checkGateVar},${cacheVar}[1]=${gateValueVar});let ${enabledVar}=${gateValueVar}||/*${REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER}*/typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`),${callbackVar},${depsVar};return `,
    );
    const bridgePattern =
      /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(3\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*);return \2\[0\]===\4\?/u;
    if (patchedRegion === region) {
      patchedRegion = region.replace(
        bridgePattern,
        (_needle, functionName, cacheVar, compilerVar, enabledVar, gateVar, callbackVar, depsVar) =>
          `function ${functionName}(){let ${cacheVar}=(0,${compilerVar}.c)(3),${enabledVar}=${gateVar}()||/*${REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER}*/typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`),${callbackVar},${depsVar};return ${cacheVar}[0]===${enabledVar}?`,
      );
    }

    if (patchedRegion === region) {
      console.warn("WARN: Could not find remote-control enablement bridge needle - skipping Linux remote-control bridge patch");
      return patched;
    }

    patched = patched.slice(0, markerIndex) + patchedRegion + patched.slice(markerIndex + region.length);
    region = patched.slice(markerIndex, markerIndex + 4_500);
  }

  if (patched.includes(REMOTE_CONTROL_SELF_AUTO_CONNECT_MARKER)) {
    return patched;
  }

  const selfAutoConnectReplacement = (desktopHostRequestFn, enabledVar, errorVar, loggerVar, logPrefixVar) =>
    `${desktopHostRequestFn}(\`set-remote-control-connections-enabled\`,{params:{enabled:${enabledVar}}}).then(async e=>{if(${enabledVar}&&typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)){let t=e?.remoteControlConnections??e?.sharedObjects?.remote_control_connections??e?.connections??[],n=e?.sharedObjects?.local_remote_control_installation_id??e?.local_remote_control_installation_id??e?.localRemoteControlInstallationId??e?.installationId??e?.installation_id??null;if(t.length===0)try{let e=await ${desktopHostRequestFn}(\`refresh-remote-control-connections\`,{params:{}});t=e?.remoteControlConnections??e?.sharedObjects?.remote_control_connections??e?.connections??[],n=n??e?.sharedObjects?.local_remote_control_installation_id??e?.local_remote_control_installation_id??e?.localRemoteControlInstallationId??e?.installationId??e?.installation_id??null}catch(e){${loggerVar}.warning(\`\${${logPrefixVar}} self_auto_connect_refresh_failed\`,{safe:{},sensitive:{error:e}})}if(n==null)try{let e=await ${desktopHostRequestFn}(\`get-global-state\`,{params:{key:\`electron-local-remote-control-installation-id\`}});n=e?.value??e?.state?.value??e?.globalState?.[\`electron-local-remote-control-installation-id\`]??null}catch(e){${loggerVar}.warning(\`\${${logPrefixVar}} self_auto_connect_identity_failed\`,{safe:{},sensitive:{error:e}})}let r=t.filter(e=>typeof e?.hostId==\`string\`&&e.hostId.startsWith(\`remote-control:\`)),i=new Set(r.filter(e=>n!=null&&(e.installationId??e.installation_id)===n).map(e=>e.hostId));await Promise.all(r.map(e=>${desktopHostRequestFn}(\`set-remote-connection-auto-connect\`,{params:{hostId:e.hostId,autoConnect:i.has(e.hostId)}}).catch(t=>{${loggerVar}.warning(\`\${${logPrefixVar}} self_auto_connect_failed\`,{safe:{hostId:e.hostId,autoConnect:i.has(e.hostId)},sensitive:{error:t}})})))}}/*${REMOTE_CONTROL_SELF_AUTO_CONNECT_MARKER}*/).catch(${errorVar}=>{${loggerVar}.warning(\`\${${logPrefixVar}} sync_failed\`,{safe:{enabled:${enabledVar}},sensitive:{error:${errorVar}}})})`;

  const previousAutoConnectCleanupPattern =
    /([A-Za-z_$][\w$]*)\(`set-remote-control-connections-enabled`,\{params:\{enabled:([A-Za-z_$][\w$]*)\}\}\)\.then\(async ([A-Za-z_$][\w$]*)=>\{[\s\S]*?\/\*codexLinuxRemoteControlAutoConnectCleanup\*\/\)\.catch\(([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.warning\(`\$\{([A-Za-z_$][\w$]*)\} sync_failed`,\{safe:\{(?:enabled|slingshotEnabled):\2\},sensitive:\{error:\4\}\}\)\}\)/u;
  const selfAutoConnectPattern =
    /([A-Za-z_$][\w$]*)\(`set-remote-control-connections-enabled`,\{params:\{enabled:([A-Za-z_$][\w$]*)\}\}\)\.catch\(([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.warning\(`\$\{([A-Za-z_$][\w$]*)\} sync_failed`,\{safe:\{(?:enabled|slingshotEnabled):\2\},sensitive:\{error:\3\}\}\)\}\)/u;
  let selfAutoConnectRegion = region.replace(
    previousAutoConnectCleanupPattern,
    (_needle, desktopHostRequestFn, enabledVar, _resultVar, errorVar, loggerVar, logPrefixVar) =>
      selfAutoConnectReplacement(desktopHostRequestFn, enabledVar, errorVar, loggerVar, logPrefixVar),
  );
  if (selfAutoConnectRegion === region) {
    selfAutoConnectRegion = region.replace(
      selfAutoConnectPattern,
      (_needle, desktopHostRequestFn, enabledVar, errorVar, loggerVar, logPrefixVar) =>
        selfAutoConnectReplacement(desktopHostRequestFn, enabledVar, errorVar, loggerVar, logPrefixVar),
    );
  }

  if (selfAutoConnectRegion === region) {
    console.warn("WARN: Could not find remote-control self auto-connect needle - skipping Linux remote-control auto-connect patch");
    return patched;
  }

  return patched.slice(0, markerIndex) + selfAutoConnectRegion + patched.slice(markerIndex + region.length);
}

function applyLinuxRemoteControlEnableForHostParamsPatch(source) {
  let patched = source;

  if (!patched.includes(REMOTE_CONTROL_ENABLE_FOR_HOST_PARAMS_MARKER)) {
    const enabledForHostNullParamsPattern =
      /("set-remote-control-enabled-for-host":[A-Za-z_$][\w$]*\(\([A-Za-z_$][\w$]*,\{enabled:[A-Za-z_$][\w$]*\}\)=>[A-Za-z_$][\w$]*\.sendRequest\([A-Za-z_$][\w$]*\?`remoteControl\/enable`:`remoteControl\/disable`,)null(\)\))/u;
    const beforeEnableForHostParamsPatch = patched;
    patched = patched.replace(
      enabledForHostNullParamsPattern,
      `$1void 0/*${REMOTE_CONTROL_ENABLE_FOR_HOST_PARAMS_MARKER}*/$2`,
    );
    if (
      patched === beforeEnableForHostParamsPatch &&
      patched.includes("set-remote-control-enabled-for-host")
    ) {
      console.warn("WARN: Could not find remote-control enable-for-host params needle - skipping Linux remote-control host params patch");
    }
  }

  return patched;
}

function applyLinuxRemoteMobileActiveStatusPatch(source) {
  if (source.includes(REMOTE_MOBILE_ACTIVE_STATUS_MARKER)) {
    return source;
  }
  if (
    source.includes("e.resumeState===`needs_resume`?e.threadRuntimeStatus:null") &&
    source.includes("?`running`:e.hasUnreadTurn?`review`:`idle`")
  ) {
    return source;
  }

  const statusPattern =
    /function ([A-Za-z_$][\w$]*)\(\{latestTurnStatus:([A-Za-z_$][\w$]*),resumeState:([A-Za-z_$][\w$]*),streamRole:([A-Za-z_$][\w$]*),threadRuntimeStatus:([A-Za-z_$][\w$]*)\}\)\{return \4==null\?\3===`needs_resume`\?`needs-resume`:`read-only`:\4\.role===`follower`\?`follower`:\5\?\.type===`active`\|\|\2===`inProgress`\?`active`:`inactive`\}/u;
  if (!statusPattern.test(source)) {
    if (source.includes("latestTurnStatus:") && source.includes("streamRole:") && source.includes("threadRuntimeStatus:")) {
      console.warn("WARN: Could not find active-status renderer needle - skipping remote mobile active-status patch");
    }
    return source;
  }

  return source.replace(
    statusPattern,
    `function $1({latestTurnStatus:$2,resumeState:$3,streamRole:$4,threadRuntimeStatus:$5}){/*${REMOTE_MOBILE_ACTIVE_STATUS_MARKER}*/return $4?.role===\`follower\`?\`follower\`:$5?.type===\`active\`||$2===\`inProgress\`?\`active\`:$4==null?$3===\`needs_resume\`?\`needs-resume\`:\`read-only\`:\`inactive\`}`,
  );
}

module.exports = [
  {
    id: "linux-remote-control-device-key",
    phase: "main-bundle",
    order: 20_100,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlDeviceKeyPatch,
  },
  {
    id: "linux-remote-control-client-account-compatibility",
    phase: "main-bundle",
    order: 20_115,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlClientAccountCompatibilityPatch,
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
    pattern: REMOTE_MOBILE_CONVERSATION_ASSET_PATTERN,
    order: 20_118,
    ciPolicy: "optional",
    missingDescription: "remote-control loader gate bundle",
    skipDescription: "Linux remote-control load gate patch",
    apply: applyLinuxRemoteControlLoadGatePatch,
  },
  {
    id: "linux-remote-control-feature-sync",
    phase: "webview-asset",
    pattern: /^(?:app-main|index)-.*\.js$/,
    order: 20_119,
    ciPolicy: "optional",
    missingDescription: "webview app main bundle",
    skipDescription: "Linux remote-control feature sync patch",
    apply: applyLinuxRemoteControlFeatureSyncPatch,
  },
  {
    id: "linux-remote-control-visibility",
    phase: "webview-asset",
    pattern: /^(?:remote-control-connections-visibility|remote-connections-settings|use-plugin-install-flow)-.*\.js$/,
    order: 20_120,
    ciPolicy: "optional",
    missingDescription: "remote-control connections visibility bundle",
    skipDescription: "Linux remote-control visibility patch",
    apply: applyLinuxRemoteControlVisibilityPatch,
  },
  {
    id: "linux-remote-control-copy",
    phase: "webview-asset",
    pattern: /^(?:codex-mobile-setup-flow|remote-connections-settings|use-codex-mobile-connected-settings)-.*\.js$/,
    order: 20_130,
    ciPolicy: "optional",
    missingDescription: "remote-control settings or mobile setup bundle",
    skipDescription: "Linux remote-control copy patch",
    apply: applyLinuxRemoteControlCopyPatch,
  },
  {
    id: "linux-remote-control-settings-ux",
    phase: "webview-asset",
    pattern: /^remote-connections-settings-.*\.js$/,
    order: 20_135,
    ciPolicy: "optional",
    missingDescription: "remote connections settings bundle",
    skipDescription: "Linux remote-control settings UX patch",
    apply: applyLinuxRemoteControlSettingsUxPatch,
  },
  {
    id: "linux-remote-control-selected-tab",
    phase: "webview-asset",
    pattern: /^(?:use-plugin-install-flow|remote-connections-settings)-.*\.js$/,
    order: 20_136,
    ciPolicy: "optional",
    missingDescription: "remote-control selected-tab bundle",
    skipDescription: "Linux remote-control selected-tab patch",
    apply: applyLinuxRemoteControlSelectedTabPatch,
  },
  {
    id: "linux-remote-control-client-revoke-setup-reset",
    phase: "webview-asset",
    pattern: /^remote-connections-settings-.*\.js$/,
    order: 20_138,
    ciPolicy: "optional",
    missingDescription: "remote connections settings bundle",
    skipDescription: "Linux remote-control client revoke setup reset patch",
    apply: applyLinuxRemoteControlClientRevokeSetupResetPatch,
  },
  {
    id: "linux-remote-connections-refresh",
    phase: "webview-asset",
    pattern: /^remote-connections-settings-.*\.js$/,
    order: 20_140,
    ciPolicy: "optional",
    missingDescription: "remote connections settings bundle",
    skipDescription: "Linux remote-connections refresh patch",
    apply: applyLinuxRemoteConnectionsRefreshPatch,
  },
  {
    id: "linux-remote-mobile-conversation-hydration",
    phase: "webview-asset",
    pattern: REMOTE_MOBILE_CONVERSATION_ASSET_PATTERN,
    order: 20_150,
    ciPolicy: "optional",
    missingDescription: "app-server manager signals bundle",
    skipDescription: "Linux remote-mobile conversation hydration patch",
    apply: applyLinuxRemoteMobileConversationHydrationPatch,
  },
  {
    id: "linux-remote-mobile-completed-item-recovery",
    phase: "webview-asset",
    pattern: REMOTE_MOBILE_CONVERSATION_ASSET_PATTERN,
    order: 20_151,
    ciPolicy: "optional",
    missingDescription: "app-server conversation manager bundle",
    skipDescription: "Linux remote-mobile completed item recovery patch",
    apply: applyLinuxRemoteMobileCompletedItemRecoveryPatch,
  },
  {
    id: "linux-remote-terminal-status-recovery",
    phase: "webview-asset",
    pattern: REMOTE_MOBILE_CONVERSATION_ASSET_PATTERN,
    order: 20_152,
    ciPolicy: "optional",
    missingDescription: "app-server conversation manager bundle",
    skipDescription: "Linux remote terminal status recovery patch",
    apply: applyLinuxRemoteTerminalStatusRecoveryPatch,
  },
  {
    id: "linux-remote-control-status-read-guard",
    phase: "webview-asset",
    pattern: REMOTE_MOBILE_CONVERSATION_ASSET_PATTERN,
    order: 20_153,
    ciPolicy: "optional",
    missingDescription: "app-server manager signals bundle",
    skipDescription: "Linux remote-control status read guard patch",
    apply: applyLinuxRemoteControlStatusReadGuardPatch,
  },
  {
    id: "linux-remote-control-status-wait",
    phase: "webview-asset",
    pattern: /^app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~[^.]+\.js$/,
    order: 20_154,
    ciPolicy: "optional",
    missingDescription: "app-server manager signals bundle",
    skipDescription: "Linux remote-control status wait patch",
    apply: applyLinuxRemoteControlStatusWaitPatch,
  },
  {
    id: "linux-remote-control-enable-for-host-params",
    phase: "webview-asset",
    pattern: /^(?:app-main|app-initial~app-main~automations-page)-.*\.js$/,
    order: 20_155,
    ciPolicy: "optional",
    missingDescription: "app main remote-control host toggle bundle",
    skipDescription: "Linux remote-control host toggle params patch",
    apply: applyLinuxRemoteControlEnableForHostParamsPatch,
  },
  {
    id: "linux-remote-control-enablement-bridge",
    phase: "webview-asset",
    pattern: /^app-main-.*\.js$/,
    order: 20_156,
    ciPolicy: "optional",
    missingDescription: "app main bundle",
    skipDescription: "Linux remote-control enablement bridge patch",
    apply: applyLinuxRemoteControlEnablementBridgePatch,
  },
  {
    id: "linux-remote-mobile-active-status",
    phase: "webview-asset",
    pattern: /^(?:app-main|avatar-overlay-realtime-voice-button)-.*\.js$/,
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
module.exports.applyLinuxRemoteMobileChromeBridgePatch = applyLinuxRemoteMobileChromeBridgePatch;
module.exports.applyLinuxRemoteMobileCompletedItemRecoveryPatch =
  applyLinuxRemoteMobileCompletedItemRecoveryPatch;
module.exports.applyLinuxRemoteMobileConversationHydrationPatch = applyLinuxRemoteMobileConversationHydrationPatch;
module.exports.applyLinuxRemoteTerminalStatusRecoveryPatch = applyLinuxRemoteTerminalStatusRecoveryPatch;
module.exports.applyLinuxRemoteControlStatusReadGuardPatch = applyLinuxRemoteControlStatusReadGuardPatch;
module.exports.applyLinuxRemoteControlStatusWaitPatch = applyLinuxRemoteControlStatusWaitPatch;
module.exports.applyLinuxRemoteControlEnablementBridgePatch = applyLinuxRemoteControlEnablementBridgePatch;
module.exports.applyLinuxRemoteControlEnableForHostParamsPatch =
  applyLinuxRemoteControlEnableForHostParamsPatch;
module.exports.applyLinuxRemoteMobileActiveStatusPatch = applyLinuxRemoteMobileActiveStatusPatch;
module.exports.applyLinuxRemoteControlClientAccountCompatibilityPatch =
  applyLinuxRemoteControlClientAccountCompatibilityPatch;
module.exports.applyLinuxRemoteControlClientRevocationRecoveryPatch =
  applyLinuxRemoteControlClientRevocationRecoveryPatch;
module.exports.applyLinuxRemoteControlClientRevokeSetupResetPatch =
  applyLinuxRemoteControlClientRevokeSetupResetPatch;
module.exports.applyLinuxRemoteControlLoadGatePatch = applyLinuxRemoteControlLoadGatePatch;
module.exports.applyLinuxRemoteConnectionsRefreshPatch = applyLinuxRemoteConnectionsRefreshPatch;
module.exports.applyLinuxRemoteControlFeatureSyncPatch = applyLinuxRemoteControlFeatureSyncPatch;
module.exports.applyLinuxRemoteControlVisibilityPatch = applyLinuxRemoteControlVisibilityPatch;
module.exports.applyLinuxRemoteControlCopyPatch = applyLinuxRemoteControlCopyPatch;
module.exports.applyLinuxRemoteControlSshInstallActionPatch = applyLinuxRemoteControlSshInstallActionPatch;
module.exports.applyLinuxRemoteControlSshInstallReleasePatch = applyLinuxRemoteControlSshInstallReleasePatch;
module.exports.applyLinuxRemoteControlSettingsUxPatch = applyLinuxRemoteControlSettingsUxPatch;
module.exports.applyLinuxRemoteControlSelectedTabPatch = applyLinuxRemoteControlSelectedTabPatch;
