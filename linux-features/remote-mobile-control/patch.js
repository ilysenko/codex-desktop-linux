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
  /function ([A-Za-z_$][\w$]*)\(\{remoteControlConnectionsState:([A-Za-z_$][\w$]*),slingshotEnabled:([A-Za-z_$][\w$]*)\}\)\{return \3&&\(\2\?\.available\?\?!0\)\}/u;
const REMOTE_CONTROL_LOAD_GATE_MARKER = "codexLinuxRemoteControlLoadGateEnabled";
const REMOTE_CONTROL_LOAD_GATE_NEEDLE =
  /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\(`1042620455`\)\}/u;
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
];
const CLIENT_ACCOUNT_COMPAT_MARKER = "codexLinuxRemoteControlAccountMatches";
const INLINE_SETUP_FLOW_MARKER = "codexLinuxRemoteControlInlineSetupFlow";
const APP_SERVER_ARGS_NEEDLE = "args:[`app-server`,`--analytics-default-enabled`]";
const APP_SERVER_ARGS_REPLACEMENT =
  "args:[`app-server`,`--analytics-default-enabled`,`--remote-control`]";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceOnce(source, needle, replacement) {
  if (!source.includes(needle)) {
    return null;
  }
  return source.replace(needle, replacement);
}

function linuxRemoteControlClientAccountCompatibilityHelpers(loadEnrollmentFn) {
  return [
    "function codexLinuxRemoteControlEnrollmentAccountUserIds(e){",
    "return[...new Set([e.tokenAccountUserId,e.tokenAuthUserId].filter(e=>e!=null))]",
    "}",
    "function codexLinuxRemoteControlAccountMatches({candidateAccountId:e,candidateAccountUserId:t,candidateUserId:n,expectedAccountId:r,expectedAccountUserId:i}){",
    "return t===i||r!=null&&e===r&&n===i",
    "}",
    "async function codexLinuxRemoteControlLoadEnrollment({authIdentity:e,deviceKeyClient:t,enrollmentKey:n,globalState:r}){",
    `let i=(await Promise.all(codexLinuxRemoteControlEnrollmentAccountUserIds(e).map(async e=>{let i=pd(n,e);return{enrollment:await ${loadEnrollmentFn}({deviceKeyClient:t,enrollmentKey:i,globalState:r}),enrollmentRecordKey:i}}))).find(e=>e.enrollment!=null);`,
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

function applyLinuxRemoteControlAppServerHostModePatch(source) {
  if (!source.includes(APP_SERVER_ARGS_NEEDLE)) {
    return source;
  }
  return source.split(APP_SERVER_ARGS_NEEDLE).join(APP_SERVER_ARGS_REPLACEMENT);
}

function patchLinuxRemoteControlAppServerHostModeInExtractedApp(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    console.warn(
      `WARN: Could not find Vite build directory in ${buildDir} - skipping Linux remote-control app-server host mode patch`,
    );
    return { changed: false, matched: 0 };
  }

  let matched = 0;
  let changed = 0;
  for (const filename of fs.readdirSync(buildDir).filter((name) => name.endsWith(".js")).sort()) {
    const filePath = path.join(buildDir, filename);
    const source = fs.readFileSync(filePath, "utf8");
    if (!source.includes(APP_SERVER_ARGS_NEEDLE) && !source.includes(APP_SERVER_ARGS_REPLACEMENT)) {
      continue;
    }
    matched += 1;
    const patched = applyLinuxRemoteControlAppServerHostModePatch(source);
    if (patched !== source) {
      fs.writeFileSync(filePath, patched, "utf8");
      changed += 1;
    }
  }

  if (matched === 0) {
    console.warn(
      `WARN: Could not find local app-server launch args in ${buildDir} - skipping Linux remote-control app-server host mode patch`,
    );
  }

  return { changed: changed > 0, matched };
}

function applyLinuxRemoteControlClientAccountCompatibilityPatch(source) {
  if (
    source.includes(CLIENT_ACCOUNT_COMPAT_MARKER) ||
    source.includes("candidateAccountUserId") &&
      source.includes("expectedAccountUserId") &&
      source.includes("tokenAuthUserId")
  ) {
    return source;
  }

  if (!source.includes("Remote control enrollment start does not match current account.")) {
    return source;
  }

  const enrollmentStartRegex =
    /let ([A-Za-z_$][\w$]*)=Sd\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\1\.tokenAccountUserId;if\(\3==null\)throw Error\(`Remote control enrollment requires the current ChatGPT account user id\.`\);let ([A-Za-z_$][\w$]*)=pd\(([A-Za-z_$][\w$]*),\3\),([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\(\{deviceKeyClient:([A-Za-z_$][\w$]*),enrollmentKey:\4,globalState:([A-Za-z_$][\w$]*)\}\),([A-Za-z_$][\w$]*)=\6,([A-Za-z_$][\w$]*);/u;
  const startMatch = source.match(enrollmentStartRegex);
  if (startMatch == null) {
    console.warn("WARN: Could not find remote-control enrollment start shape - skipping account compatibility patch");
    return source;
  }

  const [
    startNeedle,
    authIdentityVar,
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
    /function ([A-Za-z_$][\w$]*)\(\{accountUserId:([A-Za-z_$][\w$]*),stepUpToken:([A-Za-z_$][\w$]*)\}\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\3\);([A-Za-z_$][\w$]*)\(\{payload:\4\}\);let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.parse\(\4\),([A-Za-z_$][\w$]*)=\7\[`https:\/\/api\.openai\.com\/auth`\],([A-Za-z_$][\w$]*)=\9\.chatgpt_account_user_id\?\?\9\.account_user_id,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\7\);if\(\10!==\2\)throw Error\(`Remote control enrollment step-up token does not match current account\.`\);if\(Math\.floor\(Date\.now\(\)\/1e3\)-\7\.iat>([A-Za-z_$][\w$]*)\)throw Error\(`Remote control enrollment step-up token is not fresh\.`\);if\(Date\.now\(\)-\7\.pwd_auth_time>\13\*1e3\)throw Error\(`Remote control enrollment step-up token does not have fresh password auth\.`\);if\(\11\.length!==1\|\|\11\[0\]!==([A-Za-z_$][\w$]*)\)throw Error\(`Remote control enrollment step-up token is missing required authorization\.`\);return\{accountUserId:\10\?\?null,issuedAt:\7\.iat,passwordAuthTime:\7\.pwd_auth_time,scopes:\11\}\}/u;
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
  const helpersNeedle = /function pd\(e,t\)\{return`\$\{e\}\\n\$\{t\}`\}/u;
  const helpersMatch = patched.match(helpersNeedle);
  if (helpersMatch == null) {
    console.warn("WARN: Could not find remote-control enrollment key helper - skipping account compatibility patch");
    return source;
  }
  patched = patched.replace(
    helpersNeedle,
    `${helpersMatch[0]}${linuxRemoteControlClientAccountCompatibilityHelpers(loadEnrollmentFn)}`,
  );

  patched = patched.replace(
    startNeedle,
    [
      `let ${authIdentityVar}=Sd(${headersVar}),${tokenAccountUserIdVar}=${authIdentityVar}.tokenAccountUserId;`,
      `if(${tokenAccountUserIdVar}==null)throw Error(\`Remote control enrollment requires the current ChatGPT account user id.\`);`,
      `let codexLinuxRemoteControlCurrentAccountId=${authIdentityVar}.tokenAccountId??${authIdentityVar}.headerChatGptAccountId,`,
      `codexLinuxRemoteControlEnrollmentKey=${enrollmentKeyVar},`,
      `codexLinuxRemoteControlExistingEnrollment=await codexLinuxRemoteControlLoadEnrollment({authIdentity:${authIdentityVar},deviceKeyClient:${deviceKeyClientVar},enrollmentKey:${enrollmentKeyVar},globalState:${globalStateVar}}),`,
      `${enrollmentRecordKeyVar}=codexLinuxRemoteControlExistingEnrollment?.enrollmentRecordKey??pd(${enrollmentKeyVar},${tokenAccountUserIdVar}),`,
      `${loadedEnrollmentVar}=codexLinuxRemoteControlExistingEnrollment?.enrollment??null,`,
      `${enrollmentVar}=${loadedEnrollmentVar},${tokenResponseVar};`,
    ].join(""),
  );

  const authCheckRegex =
    /remote_control_client_enrollment_start_response[\s\S]{0,500}?\),([A-Za-z_$][\w$]*)\.account_user_id!==([A-Za-z_$][\w$]*)\)throw/u;
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
    `${escapeRegExp(enrollmentVar)}=await ([A-Za-z_$][\\w$]*)\\(\\{accountUserId:${escapeRegExp(tokenAccountUserIdVar)},clientId:${escapeRegExp(responseVar)}\\.client_id,deviceKeyClient:${escapeRegExp(deviceKeyClientVar)}\\}\\);try\\{`,
    "u",
  );
  const createEnrollmentMatch = patched.match(createEnrollmentRegex);
  if (createEnrollmentMatch == null) {
    console.warn("WARN: Could not find remote-control enrollment creation - skipping account compatibility patch");
    return source;
  }
  const createEnrollmentFn = createEnrollmentMatch[1];
  patched = patched.replace(
    createEnrollmentRegex,
    `${enrollmentVar}=await ${createEnrollmentFn}({accountUserId:${responseVar}.account_user_id,clientId:${responseVar}.client_id,deviceKeyClient:${deviceKeyClientVar}});${enrollmentRecordKeyVar}=pd(codexLinuxRemoteControlEnrollmentKey,${enrollmentVar}.accountUserId);try{`,
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
      `function ${stepUpValidatorFn}({accountId:e,accountUserId:t,stepUpToken:n}){`,
      `let r=${decodeTokenFn}(n);${logPayloadFn}({payload:r});`,
      `let i=${tokenParserVar}.parse(r),a=i[\`https://api.openai.com/auth\`],`,
      `o=a.chatgpt_account_user_id??a.account_user_id??null,`,
      `s=a.chatgpt_account_id??a.account_id??null,c=${readScopesFn}(i);`,
      "if(!codexLinuxRemoteControlAccountMatches({candidateAccountId:s,candidateAccountUserId:o,candidateUserId:a.user_id??null,expectedAccountId:e,expectedAccountUserId:t}))",
      "throw Error(`Remote control enrollment step-up token does not match current account.`);",
      `if(Math.floor(Date.now()/1e3)-i.iat>${freshnessWindowVar})throw Error(\`Remote control enrollment step-up token is not fresh.\`);`,
      `if(Date.now()-i.pwd_auth_time>${freshnessWindowVar}*1e3)throw Error(\`Remote control enrollment step-up token does not have fresh password auth.\`);`,
      `if(c.length!==1||c[0]!==${requiredScopeVar})throw Error(\`Remote control enrollment step-up token is missing required authorization.\`);`,
      "return{accountUserId:o??null,issuedAt:i.iat,passwordAuthTime:i.pwd_auth_time,scopes:c}}",
    ].join(""),
  );

  const authorizationCheckRegex =
    /async function ([A-Za-z_$][\w$]*)\(\{appServerClient:([A-Za-z_$][\w$]*),desktopApiOptions:([A-Za-z_$][\w$]*),deviceKeyClient:([A-Za-z_$][\w$]*),globalState:([A-Za-z_$][\w$]*)\}\)\{let ([A-Za-z_$][\w$]*)=Sd\(await ([A-Za-z_$][\w$]*)\(\{action:`check remote control authorization`,appServerClient:\2,desktopApiOptions:\3\}\)\)\.tokenAccountUserId;if\(\6==null\)return\{clientAuthorized:!1,clientId:null\};let ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\(\{deviceKeyClient:\4,enrollmentKey:pd\(([A-Za-z_$][\w$]*)\(\3\),\6\),globalState:\5\}\);return\{clientAuthorized:\8!=null,clientId:\8\?\.clientId\?\?null\}\}/u;
  const authorizationCheckMatch = patched.match(authorizationCheckRegex);
  if (authorizationCheckMatch == null) {
    console.warn("WARN: Could not find remote-control authorization status check - skipping account compatibility patch");
    return source;
  }
  const [, authCheckFn, appServerClientVar, desktopApiOptionsVar, authDeviceKeyClientVar, authGlobalStateVar, authStatusIdentityVar, authHeadersFn, enrollmentVarForStatus, , enrollmentKeyFn] =
    authorizationCheckMatch;
  patched = patched.replace(
    authorizationCheckRegex,
    `async function ${authCheckFn}({appServerClient:${appServerClientVar},desktopApiOptions:${desktopApiOptionsVar},deviceKeyClient:${authDeviceKeyClientVar},globalState:${authGlobalStateVar}}){let ${authStatusIdentityVar}=Sd(await ${authHeadersFn}({action:\`check remote control authorization\`,appServerClient:${appServerClientVar},desktopApiOptions:${desktopApiOptionsVar}}));if(${authStatusIdentityVar}.tokenAccountUserId==null)return{clientAuthorized:!1,clientId:null};let ${enrollmentVarForStatus}=await codexLinuxRemoteControlLoadEnrollment({authIdentity:${authStatusIdentityVar},deviceKeyClient:${authDeviceKeyClientVar},enrollmentKey:${enrollmentKeyFn}(${desktopApiOptionsVar}),globalState:${authGlobalStateVar}});return{clientAuthorized:${enrollmentVarForStatus}!=null,clientId:${enrollmentVarForStatus}?.enrollment.clientId??null}}`,
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
      `function ${functionName}({remoteControlConnectionsState:${stateVar},slingshotEnabled:${slingshotVar}}){let n=typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`);return(n||${slingshotVar})&&(n||(${stateVar}?.available??!0))}`,
    );
  }
  return source.replace(REMOTE_CONTROL_VISIBILITY_NEEDLE, REMOTE_CONTROL_VISIBILITY_REPLACEMENT);
}

function applyLinuxRemoteControlCopyPatch(source) {
  const hasMacCopy = REMOTE_CONTROL_LINUX_COPY_REPLACEMENTS.some(([macCopy]) =>
    source.includes(macCopy),
  );
  if (!hasMacCopy && (source.includes("this Linux desktop") || source.includes("Linux apps"))) {
    return source;
  }

  let patched = source;
  let changed = false;
  for (const [macCopy, linuxCopy] of REMOTE_CONTROL_LINUX_COPY_REPLACEMENTS) {
    if (patched.includes(macCopy)) {
      patched = patched.split(macCopy).join(linuxCopy);
      changed = true;
    }
  }

  if (!changed) {
    console.warn("WARN: Could not find remote-control Mac copy - skipping Linux remote-control copy patch");
    return source;
  }
  return patched;
}

function applyLinuxRemoteControlInlineSetupFlowPatch(source) {
  if (source.includes(INLINE_SETUP_FLOW_MARKER)) {
    return source;
  }
  if (
    !source.includes("CODEX_MOBILE_SETUP_COMPLETED") ||
    !source.includes("mode:`setup`") ||
    !source.includes("variant:`dialog`")
  ) {
    return source;
  }

  const dialogSetupFlowRegex =
    /function [A-Za-z_$][\w$]*\(e\)\{[\s\S]{0,800}?\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{onClose:[A-Za-z_$][\w$]*,variant:`dialog`\}\)[\s\S]{0,300}?\}/u;
  const dialogSetupFlowMatch = source.match(dialogSetupFlowRegex);
  if (dialogSetupFlowMatch == null) {
    console.warn("WARN: Could not find Codex mobile setup flow dialog wrapper - skipping Linux inline setup flow patch");
    return source;
  }
  const [, jsxRuntimeVar, setupFlowComponentVar] = dialogSetupFlowMatch;

  const setupCardRegex = new RegExp(
    `\\(0,${escapeRegExp(jsxRuntimeVar)}\\.jsx\\)\\(([A-Za-z_$][\\w$]*),\\{mode:\`setup\`\\}\\)`,
    "u",
  );
  const setupCardMatch = source.match(setupCardRegex);
  if (setupCardMatch == null) {
    console.warn("WARN: Could not find remote-control setup card render - skipping Linux inline setup flow patch");
    return source;
  }

  const setupCardIndex = source.search(setupCardRegex);
  const setupFunctionStart = source.lastIndexOf("function ", setupCardIndex);
  if (setupFunctionStart < 0) {
    console.warn("WARN: Could not find remote-control setup state function - skipping Linux inline setup flow patch");
    return source;
  }

  const helper = `function ${INLINE_SETUP_FLOW_MARKER}(e,t){return(0,e.jsx)(t,{onClose:()=>{},variant:\`page\`})}`;
  const patched = source.replace(
    setupCardRegex,
    `${INLINE_SETUP_FLOW_MARKER}(${jsxRuntimeVar},${setupFlowComponentVar})`,
  );
  return `${patched.slice(0, setupFunctionStart)}${helper}${patched.slice(setupFunctionStart)}`;
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
    id: "linux-remote-control-app-server-host-mode",
    phase: "extracted-app",
    order: 20_112,
    ciPolicy: "optional",
    apply: patchLinuxRemoteControlAppServerHostModeInExtractedApp,
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
    id: "linux-remote-control-visibility",
    phase: "webview-asset",
    pattern: /^(?:remote-control-connections-visibility|remote-connections-settings)-.*\.js$/,
    order: 20_120,
    ciPolicy: "optional",
    missingDescription: "remote-control connections visibility bundle",
    skipDescription: "Linux remote-control visibility patch",
    apply: applyLinuxRemoteControlVisibilityPatch,
  },
  {
    id: "linux-remote-control-inline-setup-flow",
    phase: "webview-asset",
    pattern: /^remote-connections-settings-.*\.js$/,
    order: 20_125,
    ciPolicy: "optional",
    missingDescription: "remote-control settings setup bundle",
    skipDescription: "Linux remote-control inline setup flow patch",
    apply: applyLinuxRemoteControlInlineSetupFlowPatch,
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
];

module.exports.applyLinuxRemoteControlDeviceKeyPatch = applyLinuxRemoteControlDeviceKeyPatch;
module.exports.applyLinuxRemoteControlPreserveConfigPatch = applyLinuxRemoteControlPreserveConfigPatch;
module.exports.applyLinuxRemoteControlAppServerHostModePatch =
  applyLinuxRemoteControlAppServerHostModePatch;
module.exports.patchLinuxRemoteControlAppServerHostModeInExtractedApp =
  patchLinuxRemoteControlAppServerHostModeInExtractedApp;
module.exports.applyLinuxRemoteControlClientAccountCompatibilityPatch =
  applyLinuxRemoteControlClientAccountCompatibilityPatch;
module.exports.applyLinuxRemoteControlClientRevocationRecoveryPatch =
  applyLinuxRemoteControlClientRevocationRecoveryPatch;
module.exports.applyLinuxRemoteControlLoadGatePatch = applyLinuxRemoteControlLoadGatePatch;
module.exports.applyLinuxRemoteControlVisibilityPatch = applyLinuxRemoteControlVisibilityPatch;
module.exports.applyLinuxRemoteControlInlineSetupFlowPatch = applyLinuxRemoteControlInlineSetupFlowPatch;
module.exports.applyLinuxRemoteControlCopyPatch = applyLinuxRemoteControlCopyPatch;
