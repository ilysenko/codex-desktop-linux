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
const REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER = "codexLinuxRemoteControlEnablementBridge";
const REMOTE_CONTROL_AUTO_CONNECT_CLEANUP_MARKER = "codexLinuxRemoteControlAutoConnectCleanup";
const REMOTE_CONTROL_SELF_AUTO_CONNECT_MARKER = "codexLinuxRemoteControlSelfAutoConnect";
const REMOTE_MOBILE_ACTIVE_STATUS_MARKER = "codexLinuxRemoteMobileActiveStatus";
const REMOTE_CONTROL_STATUS_READ_GUARD_MARKER = "codexLinuxRemoteControlShouldReadStatus";
const REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER = "codexLinuxRemoteControlResetMobileSetupAfterRevoke";
const REMOTE_MOBILE_APP_SERVER_REMOTE_CONTROL_MARKER = "codexLinuxRemoteMobileAppServerArgs";
const REMOTE_MOBILE_APP_SERVER_ARGS_NEEDLE = "args:[`app-server`,`--analytics-default-enabled`]";
const REMOTE_MOBILE_PROJECTLESS_REMOTE_TASK_MARKER = "codexLinuxRemoteMobileProjectlessRemoteTaskId";
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
    `let e=process.env.XDG_CONFIG_HOME&&process.env.XDG_CONFIG_HOME.trim()?process.env.XDG_CONFIG_HOME.trim():process.env.HOME?${pathVar}.join(process.env.HOME,\`.config\`):null;`,
    "if(e==null)throw Error(`Linux remote control device keys require HOME or XDG_CONFIG_HOME`);",
    `${fsVar}.mkdirSync(${pathVar}.join(e,\`codex-desktop\`),{recursive:!0,mode:448});`,
    `return ${pathVar}.join(e,\`codex-desktop\`,\`remote-control-device-keys-v1.json\`)`,
    "}",
    "function codexLinuxRemoteControlPublicDeviceKey(e){",
    "return{algorithm:e.algorithm,keyId:e.keyId,protectionClass:e.protectionClass,publicKeySpkiDerBase64:e.publicKeySpkiDerBase64}",
    "}",
    "function codexLinuxReadRemoteControlDeviceKeyStore(){",
    "let e=codexLinuxRemoteControlDeviceKeyStorePath();",
    `if(!${fsVar}.existsSync(e))return{keys:{}};`,
    "try{",
    `let t=JSON.parse(${fsVar}.readFileSync(e,\`utf8\`));`,
    "return t&&typeof t==`object`&&!Array.isArray(t)&&t.keys&&typeof t.keys==`object`&&!Array.isArray(t.keys)?t:{keys:{}}",
    "}catch{return{keys:{}}}",
    "}",
    "function codexLinuxWriteRemoteControlDeviceKeyStore(e){",
    "let t=codexLinuxRemoteControlDeviceKeyStorePath(),n=`${t}.tmp-${process.pid}-${Date.now()}`;",
    `try{${fsVar}.writeFileSync(n,JSON.stringify(e,null,2)+\`\\n\`,{encoding:\`utf8\`,mode:384}),${fsVar}.chmodSync(n,384),${fsVar}.renameSync(n,t),${fsVar}.chmodSync(t,384)}catch(e){try{${fsVar}.rmSync(n,{force:!0})}catch{}throw e}`,
    "}",
    "function codexLinuxRemoteControlDeviceKeyClient(){return{",
    "createDeviceKey:async e=>{",
    "let t=codexLinuxReadRemoteControlDeviceKeyStore();",
    `let{publicKey:n,privateKey:r}=(0,${cryptoVar}.generateKeyPairSync)(\`ec\`,{namedCurve:\`P-256\`});`,
    `let i=(0,${cryptoVar}.randomUUID)(),a=n.export({type:\`spki\`,format:\`der\`}).toString(\`base64\`),o=r.export({type:\`pkcs8\`,format:\`pem\`});`,
    "let c={algorithm:`ecdsa_p256_sha256`,keyId:i,protectionClass:`os_protected_nonextractable`,publicKeySpkiDerBase64:a,privateKeyPkcs8Pem:o,createdAt:new Date().toISOString()};",
    "t.keys={...t.keys,[i]:c},codexLinuxWriteRemoteControlDeviceKeyStore(t);",
    "return codexLinuxRemoteControlPublicDeviceKey(c)",
    "},",
    "deleteDeviceKey:async e=>{let t=codexLinuxReadRemoteControlDeviceKeyStore();t.keys&&delete t.keys[e],codexLinuxWriteRemoteControlDeviceKeyStore(t)},",
    "getDeviceKeyPublic:async e=>{let t=codexLinuxReadRemoteControlDeviceKeyStore().keys?.[e];if(t==null)throw Error(`Linux remote control device key not found`);return codexLinuxRemoteControlPublicDeviceKey(t)},",
    `signDeviceKey:async(e,t)=>{let n=codexLinuxReadRemoteControlDeviceKeyStore().keys?.[e];if(n==null)throw Error(\`Linux remote control device key not found\`);let r=(0,${cryptoVar}.createPrivateKey)(n.privateKeyPkcs8Pem),i=(0,${cryptoVar}.sign)(\`sha256\`,t,r).toString(\`base64\`);return{algorithm:n.algorithm,signatureDerBase64:i}}`,
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

function applyLinuxRemoteControlPreserveConfigPatch(source) {
  const stripperGuardRegex =
    /async function [A-Za-z_$][\w$]*\(\{codexHome:[A-Za-z_$][\w$]*,hostConfig:([A-Za-z_$][\w$]*),logger:[A-Za-z_$][\w$]*=[^}]*\}\)\{if\(\1\.kind===`local`\)try\{/gu;
  const patched = source.replace(stripperGuardRegex, (needle, hostConfigVar) =>
    needle.replace(
      `if(${hostConfigVar}.kind===\`local\`)try{`,
      `if(${hostConfigVar}.kind===\`local\`&&process.platform!==\`linux\`)try{`,
    ),
  );
  if (patched !== source) {
    return patched;
  }

  const alreadyPatchedRegex =
    /async function [A-Za-z_$][\w$]*\(\{codexHome:[A-Za-z_$][\w$]*,hostConfig:([A-Za-z_$][\w$]*),logger:[A-Za-z_$][\w$]*=[^}]*\}\)\{if\(\1\.kind===`local`&&process\.platform!==`linux`\)try\{/u;
  if (
    alreadyPatchedRegex.test(source) ||
    !source.includes("Removed remote_control from config before app-server start") &&
      !source.includes("Failed to remove remote_control before app-server start")
  ) {
    return source;
  }

  console.warn("WARN: Could not find remote-control config stripping needle - skipping Linux remote-control config patch");
  return source;
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
    "function codexLinuxRemoteMobileAppServerArgs(){return process.platform===`linux`?[`app-server`,`--remote-control`,`--analytics-default-enabled`]:[`app-server`,`--analytics-default-enabled`]}";
  return `${helper}${source.split(REMOTE_MOBILE_APP_SERVER_ARGS_NEEDLE).join("args:codexLinuxRemoteMobileAppServerArgs()")}`;
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

  const setGlobalStateMatch = source.match(
    /mutationFn:[A-Za-z_$][\w$]*=>([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.ADDED_REMOTE_CONTROL_ENV_IDS,/u,
  );
  if (setGlobalStateMatch == null) {
    console.warn("WARN: Could not find global-state setter alias - skipping remote-control revoke setup reset patch");
    return source;
  }

  const setGlobalStateFn = setGlobalStateMatch[1];
  const helperNeedle = source.match(/var [A-Za-z_$][\w$]*=`remote-control-client-revoke-success`/u)?.[0] ?? null;
  if (helperNeedle == null) {
    console.warn("WARN: Could not find remote-control revoke toast marker - skipping setup reset helper insertion");
    return source;
  }

  const helper = [
    `function ${REMOTE_CONTROL_REVOKE_SETUP_RESET_MARKER}(e,t,n){`,
    "let r=e?.filter(e=>e.client_id!==t);",
    `return r?.length===0&&${setGlobalStateFn}(n,\`codex-mobile-has-connected-device\`,!1),r`,
    "}",
  ].join("");

  const patched = source.replace(helperNeedle, `${helper}${helperNeedle}`);
  const successPattern =
    /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{eventName:`codex_remote_control_client_revoke_result`,metadata:\{result:`succeeded`\}\}\),([A-Za-z_$][\w$]*)\.setData\(([A-Za-z_$][\w$]*)=>\4\?\.filter\(\4=>\4\.client_id!==([A-Za-z_$][\w$]*)\)\)/u;
  if (!successPattern.test(patched)) {
    console.warn("WARN: Could not find remote-control revoke success cache update - skipping setup reset patch");
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
  // supported defaults, then unconditionally adds remote_plugin (n[vI]=t) — which
  // the app-server rejects — and never includes remote_control. On Linux, force
  // remote_control on and drop the unsupported remote_plugin entry before sync.
  // The core Linux patch may already have removed the remote_plugin tail; compose
  // with that sanitized shape instead of treating it as drift.
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
        `?(${REMOTE_CONTROL_FEATURE_SYNC_MARKER}(arguments[2],arguments[3])&&(${enablementVar}.remote_control=!0),${enablementVar})` +
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
    /let ([A-Za-z_$][\w$]*)=!([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)\?\.code===`remote-codex-not-found`\|\|\3\?\.code===`update-required`\);([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)==null\|\|\1\?null:([A-Za-z_$][\w$]*)\(\{action:\5\.action,/u;
  const match = source.match(actionGateRegex);
  if (match == null) {
    console.warn("WARN: Could not find remote-control SSH install action gate - skipping Linux install action patch");
    return source;
  }

  const [, gateVar, , , renderedActionVar, connectionActionVar, renderActionFn] = match;
  return source.replace(
    actionGateRegex,
    `let ${gateVar}=/*${REMOTE_CONTROL_SSH_INSTALL_ACTION_MARKER}*/!1;${renderedActionVar}=${connectionActionVar}==null?null:${renderActionFn}({action:${connectionActionVar}.action,`,
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
    /function ([A-Za-z_$][\w$]*)\(\{action:([A-Za-z_$][\w$]*),disabled:([A-Za-z_$][\w$]*),hostId:([A-Za-z_$][\w$]*),installCodexPending:([A-Za-z_$][\w$]*),onAuthenticate:([A-Za-z_$][\w$]*),onInstallCodex:([A-Za-z_$][\w$]*)\}\)\{if\(\2==null\)return null;switch\(\2\.kind\)\{case`install-codex`:return\{disabled:\3,label:\2\.label,loading:\5,loadingLabel:\2\.loadingLabel,renderInElectronOnly:!0,tooltipText:\2\.tooltipText,onClick:\(\)=>\7\(\4\)\}/u;
  const actionCallRegex =
    /let ([A-Za-z_$][\w$]*)=!([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)\?\.code===`remote-codex-not-found`\|\|\3\?\.code===`update-required`\);([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)==null\|\|\1\?null:([A-Za-z_$][\w$]*)\(\{action:\5\.action,disabled:([A-Za-z_$][\w$]*),hostId:([A-Za-z_$][\w$]*)\.hostId,installCodexPending:([A-Za-z_$][\w$]*),onAuthenticate:([A-Za-z_$][\w$]*),onInstallCodex:([A-Za-z_$][\w$]*)\}\)/u;
  const mutationRegex =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.mutate\(\{hostId:\2\},\{onSuccess:\(\{state:([A-Za-z_$][\w$]*),error:([A-Za-z_$][\w$]*)\}\)=>\{([A-Za-z_$][\w$]*)\(\2,\4,\5\)\}\}\)\}/u;
  const localVersionRegex =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\((\d+)\),\{connection:([A-Za-z_$][\w$]*),disabled:([A-Za-z_$][\w$]*),installCodexPending:([A-Za-z_$][\w$]*),onAuthenticate:([A-Za-z_$][\w$]*),onEdit:([A-Za-z_$][\w$]*),onInstallCodex:([A-Za-z_$][\w$]*),onLogoutConnection:([A-Za-z_$][\w$]*),onRemove:([A-Za-z_$][\w$]*),onShowDetails:([A-Za-z_$][\w$]*),onToggleConnection:([A-Za-z_$][\w$]*)\}=\2,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),\{appServerVersion:([A-Za-z_$][\w$]*),error:([A-Za-z_$][\w$]*),installedCodexVersion:([A-Za-z_$][\w$]*),state:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\6\.hostId\),([A-Za-z_$][\w$]*)=\6\.displayName/u;

  const actionBuilderMatch = source.match(actionBuilderRegex);
  const actionCallMatch = source.match(actionCallRegex);
  const mutationMatch = source.match(mutationRegex);
  const localVersionMatch = source.match(localVersionRegex);
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
    rowAuthenticateVar,
    rowEditVar,
    rowInstallVar,
    rowLogoutVar,
    rowRemoveVar,
    rowShowDetailsVar,
    rowToggleVar,
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
    `onAuthenticate:${rowAuthenticateVar},onEdit:${rowEditVar},onInstallCodex:${rowInstallVar},` +
    `onLogoutConnection:${rowLogoutVar},onRemove:${rowRemoveVar},onShowDetails:${rowShowDetailsVar},` +
    `onToggleConnection:${rowToggleVar}}=${rowPropsVar},${rowFormatVar}=${rowFormatFn}(),` +
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
  ] = actionBuilderMatch;
  const actionBuilderReplacement =
    `function ${builderFn}({action:${builderActionVar},disabled:${builderDisabledVar},hostId:${builderHostVar},installCodexPending:${builderPendingVar},` +
    `installCodexRelease:codexLinuxRemoteControlSshInstallReleaseTarget,onAuthenticate:${builderAuthVar},onInstallCodex:${builderInstallVar}}){` +
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
    authenticateVar,
    installVar,
  ] = actionCallMatch;
  const actionCallReplacement =
    `let ${gateVar}=!${loadGateVar}&&(${errorVar}?.code===\`remote-codex-not-found\`||${errorVar}?.code===\`update-required\`);` +
    `${renderedActionVar}=${connectionActionVar}==null||${gateVar}?null:${renderActionFn}({action:${connectionActionVar}.action,disabled:${disabledVar},hostId:${connectionVar}.hostId,` +
    `installCodexPending:${pendingVar},installCodexRelease:${REMOTE_CONTROL_SSH_INSTALL_RELEASE_MARKER}(${errorVar}),onAuthenticate:${authenticateVar},onInstallCodex:${installVar}})`;

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

  if (!source.includes(backendNeedle) || !source.includes(currentBackendNeedle)) {
    console.warn("WARN: Could not find Chrome browser-client backend allowlist needles - skipping remote-mobile Chrome bridge patch");
    return source;
  }

  return source
    .replace(backendNeedle, backendReplacement)
    .replace(currentBackendNeedle, currentBackendReplacement);
}

function applyLinuxRemoteMobileConversationHydrationPatch(source) {
  let patched = source;

  if (!patched.includes(REMOTE_MOBILE_THREAD_RUNTIME_MARKER)) {
    const runtimeNeedle = "e.resumeState===`needs_resume`&&(e.threadRuntimeStatus=h)";
    const runtimeReplacement =
      `/*${REMOTE_MOBILE_THREAD_RUNTIME_MARKER}*/(e.resumeState===\`needs_resume\`||h?.type===\`active\`||h?.type===\`idle\`)&&(e.threadRuntimeStatus=h)`;
    if (patched.includes(runtimeNeedle)) {
      patched = patched.replace(runtimeNeedle, runtimeReplacement);
    } else if (patched.includes("threadRuntimeStatus") && patched.includes("resumeState")) {
      console.warn("WARN: Could not find thread/list runtime-status needle - skipping remote mobile runtime-status patch");
    }
  }

  // Upstream 26.527.x removed the browserUse/computerUse turn-route tracking and
  // simplified each unknown-conversation guard to `if(!this.conversations.get(x)){error;break}`.
  // Re-implement hydrate-on-turn/started + queue-while-hydrating without the deleted routes.
  if (!patched.includes(REMOTE_MOBILE_NOTIFICATION_QUEUE_MARKER)) {
    const unknownTurnNeedle =
      "if(!this.conversations.get(r)){z.error(`Received turn/started for unknown conversation`,{safe:{conversationId:r},sensitive:{}});break}";
    const unknownTurnReplacement =
      `if(!this.conversations.get(r)){/*${REMOTE_MOBILE_UNKNOWN_TURN_MARKER}*//*${REMOTE_MOBILE_NOTIFICATION_QUEUE_MARKER}*/let i=this.codexLinuxRemoteMobilePendingNotifications??=new Map,a=i.get(r);a||(a=[],i.set(r,a)),a.push(n),z.warning(\`Hydrating conversation for turn/started\`,{safe:{conversationId:r,queuedNotificationCount:a.length},sensitive:{}});let o=(s=0)=>this.readThread(r,{includeTurns:!1}).then(e=>{let t=e?.thread??e,c=this.codexLinuxRemoteMobilePendingNotifications?.get(r)??[];if(!t){if(s<12){z.warning(\`Retrying hydration for missing conversation\`,{safe:{conversationId:r,queuedNotificationCount:c.length,attempt:s+1},sensitive:{}}),setTimeout(()=>o(s+1),250);return}this.codexLinuxRemoteMobilePendingNotifications?.delete(r),z.warning(\`Skipping hydration for missing conversation\`,{safe:{conversationId:r,queuedNotificationCount:c.length},sensitive:{}});return}this.upsertConversationFromThread(t),this.codexLinuxRemoteMobilePendingNotifications?.delete(r);for(let e of c)this.onNotification(e.method,e.params)}).catch(e=>{if(s<12){z.warning(\`Retrying hydration for turn/started\`,{safe:{conversationId:r,attempt:s+1},sensitive:{error:e}}),setTimeout(()=>o(s+1),250);return}this.codexLinuxRemoteMobilePendingNotifications?.delete(r),z.error(\`Failed to hydrate conversation for turn/started\`,{safe:{conversationId:r},sensitive:{error:e}})});o();break}`;
    if (patched.includes(unknownTurnNeedle)) {
      patched = patched.replace(unknownTurnNeedle, unknownTurnReplacement);
    } else if (patched.includes("Received turn/started for unknown conversation")) {
      console.warn("WARN: Could not find unknown turn/started needle - skipping remote mobile hydration patch");
    }

    const itemStartedNeedle =
      "if(!this.conversations.get(a)){z.error(`Received item/started for unknown conversation`,{safe:{conversationId:a},sensitive:{}});break}";
    const itemStartedReplacement =
      "if(!this.conversations.get(a)){let o=this.codexLinuxRemoteMobilePendingNotifications?.get(a);if(o){o.push(n),z.warning(`Queueing item/started for hydrating conversation`,{safe:{conversationId:a,queuedNotificationCount:o.length},sensitive:{}});break}z.error(`Received item/started for unknown conversation`,{safe:{conversationId:a},sensitive:{}});break}";
    if (patched.includes(itemStartedNeedle)) {
      patched = patched.replace(itemStartedNeedle, itemStartedReplacement);
    } else if (patched.includes("Received item/started for unknown conversation")) {
      console.warn("WARN: Could not find unknown item/started needle - skipping remote mobile item queue patch");
    }

    const itemCompletedNeedle =
      "if(!this.conversations.get(a)){z.error(`Received item/completed for unknown conversation`,{safe:{conversationId:a},sensitive:{}});break}";
    const itemCompletedReplacement =
      "if(!this.conversations.get(a)){let o=this.codexLinuxRemoteMobilePendingNotifications?.get(a);if(o){o.push(n),z.warning(`Queueing item/completed for hydrating conversation`,{safe:{conversationId:a,queuedNotificationCount:o.length},sensitive:{}});break}z.error(`Received item/completed for unknown conversation`,{safe:{conversationId:a},sensitive:{}});break}";
    if (patched.includes(itemCompletedNeedle)) {
      patched = patched.replace(itemCompletedNeedle, itemCompletedReplacement);
    } else if (patched.includes("Received item/completed for unknown conversation")) {
      console.warn("WARN: Could not find unknown item/completed needle - skipping remote mobile item queue patch");
    }

    const turnCompletedNeedle =
      "if(!this.conversations.get(r)){z.error(`Received turn/completed for unknown conversation`,{safe:{conversationId:r},sensitive:{}});break}";
    const turnCompletedReplacement =
      "if(!this.conversations.get(r)){let o=this.codexLinuxRemoteMobilePendingNotifications?.get(r);if(o){o.push(n),z.warning(`Queueing turn/completed for hydrating conversation`,{safe:{conversationId:r,queuedNotificationCount:o.length},sensitive:{}});break}z.error(`Received turn/completed for unknown conversation`,{safe:{conversationId:r},sensitive:{}});break}";
    if (patched.includes(turnCompletedNeedle)) {
      patched = patched.replace(turnCompletedNeedle, turnCompletedReplacement);
    } else if (patched.includes("Received turn/completed for unknown conversation")) {
      console.warn("WARN: Could not find unknown turn/completed needle - skipping remote mobile turn queue patch");
    }
  }

  return patched;
}

function applyLinuxRemoteControlStatusReadGuardPatch(source) {
  if (source.includes(REMOTE_CONTROL_STATUS_READ_GUARD_MARKER) || !source.includes("remoteControl/status/read")) {
    return source;
  }

  const statusReadPattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=\3\.getHostId\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2,\4\),([A-Za-z_$][\w$]*)=\2\.get\(([A-Za-z_$][\w$]*),\4\);\3\.addNotificationCallback\(`remoteControl\/status\/changed`,\(\{params:([A-Za-z_$][\w$]*)\}\)=>\{([A-Za-z_$][\w$]*)\(\2,\4,\5\)&&\2\.set\(\8,\4,\9\)\}\),\3\.sendRequest\(`remoteControl\/status\/read`,void 0\)\.then\(([A-Za-z_$][\w$]*)=>\{\2\.get\(\8,\4\)===\7&&\10\(\2,\4,\5\)&&\2\.set\(\8,\4,\11\)\}\)\.catch\(([A-Za-z_$][\w$]*)=>\{\10\(\2,\4,\5\)&&([A-Za-z_$][\w$]*)\.error\(`Failed to read remote-control status`,\{safe:\{\},sensitive:\{error:\12\}\}\)\}\)\}/u;
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
    readResultVar,
    errorVar,
    loggerVar,
  ] = match;
  const replacement =
    `function ${REMOTE_CONTROL_STATUS_READ_GUARD_MARKER}(e){return !(typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)&&typeof e==\`string\`&&e.startsWith(\`remote-ssh\`))}` +
    `function ${functionName}(${storeVar},${clientVar}){let ${hostVar}=${clientVar}.getHostId(),${generationVar}=${generationFn}(${storeVar},${hostVar}),${initialValueVar}=${storeVar}.get(${statusAtomVar},${hostVar});` +
    `${clientVar}.addNotificationCallback(\`remoteControl/status/changed\`,({params:${notificationParamsVar}})=>{${isCurrentFn}(${storeVar},${hostVar},${generationVar})&&${storeVar}.set(${statusAtomVar},${hostVar},${notificationParamsVar})});` +
    `if(!${REMOTE_CONTROL_STATUS_READ_GUARD_MARKER}(${hostVar})){${isCurrentFn}(${storeVar},${hostVar},${generationVar})&&${storeVar}.set(${statusAtomVar},${hostVar},{status:\`disabled\`,available:!1,accessRequired:!1});return}` +
    `${clientVar}.sendRequest(\`remoteControl/status/read\`,void 0).then(${readResultVar}=>{${storeVar}.get(${statusAtomVar},${hostVar})===${initialValueVar}&&${isCurrentFn}(${storeVar},${hostVar},${generationVar})&&${storeVar}.set(${statusAtomVar},${hostVar},${readResultVar})}).catch(${errorVar}=>{${isCurrentFn}(${storeVar},${hostVar},${generationVar})&&${loggerVar}.error(\`Failed to read remote-control status\`,{safe:{},sensitive:{error:${errorVar}}})})}`;

  return source.replace(needle, replacement);
}

function applyLinuxRemoteControlEnablementBridgePatch(source) {
  const markerIndex = source.indexOf("[remote-connections/slingshot-gate-bridge]");
  if (markerIndex < 0 || source.indexOf("set-remote-control-connections-enabled", markerIndex) < 0) {
    return source;
  }

  let patched = source;
  let region = patched.slice(markerIndex, markerIndex + 4_500);

  if (!patched.includes(REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER)) {
    const bridgePattern =
      /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(3\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*);return \2\[0\]===\4\?/u;
    const patchedRegion = region.replace(
      bridgePattern,
      (_needle, functionName, cacheVar, compilerVar, enabledVar, gateVar, callbackVar, depsVar) =>
        `function ${functionName}(){let ${cacheVar}=(0,${compilerVar}.c)(3),${enabledVar}=${gateVar}()||/*${REMOTE_CONTROL_ENABLEMENT_BRIDGE_MARKER}*/typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`),${callbackVar},${depsVar};return ${cacheVar}[0]===${enabledVar}?`,
    );

    if (patchedRegion === region) {
      console.warn("WARN: Could not find remote-control enablement bridge needle - skipping Linux remote-control bridge patch");
      return source;
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
    /([A-Za-z_$][\w$]*)\(`set-remote-control-connections-enabled`,\{params:\{enabled:([A-Za-z_$][\w$]*)\}\}\)\.then\(async ([A-Za-z_$][\w$]*)=>\{[\s\S]*?\/\*codexLinuxRemoteControlAutoConnectCleanup\*\/\)\.catch\(([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.warning\(`\$\{([A-Za-z_$][\w$]*)\} sync_failed`,\{safe:\{enabled:\2\},sensitive:\{error:\4\}\}\)\}\)/u;
  const selfAutoConnectPattern =
    /([A-Za-z_$][\w$]*)\(`set-remote-control-connections-enabled`,\{params:\{enabled:([A-Za-z_$][\w$]*)\}\}\)\.catch\(([A-Za-z_$][\w$]*)=>\{([A-Za-z_$][\w$]*)\.warning\(`\$\{([A-Za-z_$][\w$]*)\} sync_failed`,\{safe:\{enabled:\2\},sensitive:\{error:\3\}\}\)\}\)/u;
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

function applyLinuxRemoteMobileActiveStatusPatch(source) {
  if (source.includes(REMOTE_MOBILE_ACTIVE_STATUS_MARKER)) {
    return source;
  }

  const statusPattern =
    /function ([A-Za-z_$][\w$]*)\(\{latestTurnStatus:([A-Za-z_$][\w$]*),resumeState:([A-Za-z_$][\w$]*),streamRole:([A-Za-z_$][\w$]*),threadRuntimeStatus:([A-Za-z_$][\w$]*)\}\)\{return \4==null\?\3===`needs_resume`\?`needs-resume`:`read-only`:\4\.role===`follower`\?`follower`:\5\?\.type===`active`\|\|\2===`inProgress`\?`active`:`inactive`\}/u;
  if (!statusPattern.test(source)) {
    if (source.includes("threadRuntimeStatus") && source.includes("needs-resume")) {
      console.warn("WARN: Could not find active-status renderer needle - skipping remote mobile active-status patch");
    }
    return source;
  }

  return source.replace(
    statusPattern,
    `function $1({latestTurnStatus:$2,resumeState:$3,streamRole:$4,threadRuntimeStatus:$5}){/*${REMOTE_MOBILE_ACTIVE_STATUS_MARKER}*/return $4?.role===\`follower\`?\`follower\`:$5?.type===\`active\`||$2===\`inProgress\`?\`active\`:$4==null?$3===\`needs_resume\`?\`needs-resume\`:\`read-only\`:\`inactive\`}`,
  );
}

function applyLinuxRemoteMobileProjectlessRemoteTaskPatch(source) {
  if (source.includes(REMOTE_MOBILE_PROJECTLESS_REMOTE_TASK_MARKER)) {
    return source;
  }
  if (!source.includes("No owner repo found for remote task")) {
    return source;
  }

  const fallbackPattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2,\3\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\5\);if\(!\7\)\{([A-Za-z_$][\w$]*)\.warning\(`No owner repo found for remote task`,\{safe:\{taskId:\2\.task\.id\},sensitive:\{\}\}\);return\}/u;
  const match = source.match(fallbackPattern);
  if (match == null) {
    console.warn("WARN: Could not find remote task owner-repo grouping needle - skipping projectless remote task patch");
    return source;
  }

  const [
    needle,
    functionName,
    remoteTaskVar,
    remoteProjectsByLabelVar,
    projectGroupsVar,
    remoteProjectVar,
    remoteProjectForTaskFn,
    ownerRepoVar,
    ownerRepoForProjectFn,
  ] = match;

  return source.replace(
    needle,
    [
      `function ${functionName}(${remoteTaskVar},${remoteProjectsByLabelVar},${projectGroupsVar}){`,
      `let ${remoteProjectVar}=${remoteProjectForTaskFn}(${remoteTaskVar},${remoteProjectsByLabelVar}),`,
      `${ownerRepoVar}=${ownerRepoForProjectFn}(${remoteProjectVar});`,
      `if(!${ownerRepoVar}){`,
      `let ${REMOTE_MOBILE_PROJECTLESS_REMOTE_TASK_MARKER}=${remoteTaskVar}.task?.id??${remoteTaskVar}.conversationId??${remoteTaskVar}.key??\`unknown\`,`,
      `codexLinuxRemoteMobileProjectlessRemoteTaskLabel=${remoteTaskVar}.task?.task_status_display?.environment_label??${remoteTaskVar}.task?.title??\`Remote task\`,`,
      `codexLinuxRemoteMobileProjectlessRemoteTaskGroup={projectId:\`remote-task:\${${REMOTE_MOBILE_PROJECTLESS_REMOTE_TASK_MARKER}}\`,projectKind:\`remote\`,label:codexLinuxRemoteMobileProjectlessRemoteTaskLabel,path:\`\${${REMOTE_MOBILE_PROJECTLESS_REMOTE_TASK_MARKER}}\`,repositoryData:null,isCodexWorktree:!1,threadKeys:[]};`,
      `${projectGroupsVar}.push(codexLinuxRemoteMobileProjectlessRemoteTaskGroup),codexLinuxRemoteMobileProjectlessRemoteTaskGroup.threadKeys.push(${remoteTaskVar}.key);return}`,
    ].join(""),
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
    id: "linux-remote-control-preserve-config",
    phase: "main-bundle",
    order: 20_110,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlPreserveConfigPatch,
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
    phase: "extracted-app",
    order: 20_117,
    ciPolicy: "optional",
    apply: applyLinuxRemoteMobileAppServerRemoteControlExtractedAppPatch,
  },
  {
    id: "linux-remote-control-load-gate",
    phase: "webview-asset",
    pattern: /^remote-connection-visibility-.*\.js$/,
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
    pattern: /^app-server-manager-signals-.*\.js$/,
    order: 20_150,
    ciPolicy: "optional",
    missingDescription: "app-server manager signals bundle",
    skipDescription: "Linux remote-mobile conversation hydration patch",
    apply: applyLinuxRemoteMobileConversationHydrationPatch,
  },
  {
    id: "linux-remote-control-status-read-guard",
    phase: "webview-asset",
    pattern: /^app-server-manager-signals-.*\.js$/,
    order: 20_151,
    ciPolicy: "optional",
    missingDescription: "app-server manager signals bundle",
    skipDescription: "Linux remote-control status read guard patch",
    apply: applyLinuxRemoteControlStatusReadGuardPatch,
  },
  {
    id: "linux-remote-control-enablement-bridge",
    phase: "webview-asset",
    pattern: /^app-main-.*\.js$/,
    order: 20_155,
    ciPolicy: "optional",
    missingDescription: "app main bundle",
    skipDescription: "Linux remote-control enablement bridge patch",
    apply: applyLinuxRemoteControlEnablementBridgePatch,
  },
  {
    id: "linux-remote-mobile-active-status",
    phase: "webview-asset",
    pattern: /^app-main-.*\.js$/,
    order: 20_160,
    ciPolicy: "optional",
    missingDescription: "app main bundle",
    skipDescription: "Linux remote-mobile active status patch",
    apply: applyLinuxRemoteMobileActiveStatusPatch,
  },
  {
    id: "linux-remote-mobile-projectless-remote-task",
    phase: "webview-asset",
    pattern: /^sidebar-project-groups-.*\.js$/,
    order: 20_170,
    ciPolicy: "optional",
    missingDescription: "sidebar project groups bundle",
    skipDescription: "Linux remote-mobile projectless remote task patch",
    apply: applyLinuxRemoteMobileProjectlessRemoteTaskPatch,
  },
];

module.exports.applyLinuxRemoteControlDeviceKeyPatch = applyLinuxRemoteControlDeviceKeyPatch;
module.exports.applyLinuxRemoteMobileAppServerRemoteControlPatch =
  applyLinuxRemoteMobileAppServerRemoteControlPatch;
module.exports.applyLinuxRemoteMobileChromeBridgePatch = applyLinuxRemoteMobileChromeBridgePatch;
module.exports.applyLinuxRemoteMobileConversationHydrationPatch = applyLinuxRemoteMobileConversationHydrationPatch;
module.exports.applyLinuxRemoteControlStatusReadGuardPatch = applyLinuxRemoteControlStatusReadGuardPatch;
module.exports.applyLinuxRemoteControlEnablementBridgePatch = applyLinuxRemoteControlEnablementBridgePatch;
module.exports.applyLinuxRemoteMobileActiveStatusPatch = applyLinuxRemoteMobileActiveStatusPatch;
module.exports.applyLinuxRemoteControlPreserveConfigPatch = applyLinuxRemoteControlPreserveConfigPatch;
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
module.exports.applyLinuxRemoteMobileProjectlessRemoteTaskPatch =
  applyLinuxRemoteMobileProjectlessRemoteTaskPatch;
