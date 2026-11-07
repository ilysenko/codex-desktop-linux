"use strict";

const { Script } = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks, patchWebviewAssets: commitMainEdits } = require("../../scripts/patches/lib/assets.js");
const { createJavaScriptLexicalIndex, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { inspectMainRequestSites } = require("../../scripts/patches/lib/main-request-sites.js");

const SETTINGS_KEY = "codex-linux-read-aloud-enabled";
const KOKORO_MODEL_KEY = "codex-linux-read-aloud-kokoro-model";
const KOKORO_PYTHON_KEY = "codex-linux-read-aloud-kokoro-python";
const KOKORO_SPEED_KEY = "codex-linux-read-aloud-kokoro-speed";
const KOKORO_VOICES_KEY = "codex-linux-read-aloud-kokoro-voices";
const KOKORO_MODEL_URL =
  "https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/kokoro-v1.0.onnx";
const KOKORO_VOICES_URL =
  "https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/voices-v1.0.bin";
const HELPER_MARKER = "codexLinuxReadAloudClick";
const SETUP_MARKER = "codexLinuxReadAloudSetup";
const SETTINGS_MOUNT_MARKER = "codexLinuxReadAloudMountSettings";
const HANDLER_NAME = "linux-read-aloud";
const RUNTIME_VERSION = "kokoro-explicit-v6";
const ASSISTANT_RENDER_SHARED_PROPS = [
  "item",
  "alwaysShowActions",
  "assistantCopyText",
  "savedContentResponseId",
  "after",
  "compactAttachment",
  "renderUsedSkillsDetails",
  "autoReviewStats",
  "hookStats",
  "completedThreadGoal",
  "conversationId",
  "cwd",
  "hostId",
  "reportEntityType",
  "markdownMediaCacheKey",
  "projectlessOutputDirectory",
  "outputFileLinks",
  "forceCodeBlockWordWrap",
  "hasArtifacts",
  "onAddResponseTextAnnotation",
  "onNavigateResponseTextAnnotation",
  "onFileLinkOpen",
  "onFork",
  "renderCodeBlocksAsWritingBlocks",
  "showActionRow",
  "showTimestampHeader",
  "showTimestampWithoutActions",
  "timestampHoverOnly",
  "trailingActions",
];
const ASSISTANT_RENDER_LIVE_PROPS = [
  "isReadOnly",
  "turnId",
  "showShimmer",
  "getVisualizeTurnTriggerType",
  "allowCopyWhileStreaming",
  "additionalActions",
  "persistentAdditionalActions",
];

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

// Main transport is inspected independently of feature payloads. The helper
// block is owned by this outer CommonJS chunk, while the native request owner
// remains inside its Rspack factory.
const FETCH_ROUTE_URL = `vscode://codex/${HANDLER_NAME}`;
const FETCH_ROUTE_MARKER = "/*codex-linux-read-aloud-route*/";
const MAIN_HELPER_START = "/*codex-linux-read-aloud-helpers-start*/";
const MAIN_HELPER_END = "/*codex-linux-read-aloud-helpers-end*/";

function count(source, needle) { return source.split(needle).length - 1; }
function fetchRouteSource(site) {
  return `${FETCH_ROUTE_MARKER}if(${JSON.stringify(FETCH_ROUTE_URL)}===${site.requestVar}?.url)return void await codexLinuxReadAloudFetch(${site.requestVar},codexLinuxReadAloudMessage=>${site.senderExpr}(${site.webContentsVar},codexLinuxReadAloudMessage));`;
}
function mainHelperSource() {
  const childProcessVar = "require(`node:child_process`)";
  const fsVar = "require(`node:fs`)";
  const pathVar = "require(`node:path`)";
  const osVar = "require(`node:os`)";
  const electronVar = "require(`electron`)";

  const helper = [
    `function codexLinuxReadAloudCleanText(e){return typeof e!==\`string\`?\`\`:e.replace(/\\r\\n/g,\`\\n\`).replace(new RegExp(\`\\\`\\\`\\\`[\\\\s\\\\S]*?\\\`\\\`\\\`\`,\`gu\`),\` code block. \`).replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/gu,\`$1\`).replace(/[*_#>~]/gu,\`\`).replace(/\\n{3,}/gu,\`\\n\\n\`).trim().slice(0,8e3)}`,
    `function codexLinuxReadAloudLanguage(e){let t=process.env.CODEX_LINUX_READ_ALOUD_LANGUAGE?.trim().toLowerCase();if(t)return t;let n={han:0,kana:0,ko:0,ru:0,he:0},r=0;for(let t of String(e||\`\`).normalize(\`NFC\`)){if(!/\\p{L}/u.test(t))continue;r++;if(/\\p{Script=Han}/u.test(t))n.han++;else if(/[\\p{Script=Hiragana}\\p{Script=Katakana}]/u.test(t))n.kana++;else if(/\\p{Script=Hangul}/u.test(t))n.ko++;else if(/\\p{Script=Cyrillic}/u.test(t))n.ru++;else if(/\\p{Script=Hebrew}/u.test(t))n.he++}let a=n.kana>0&&n.kana*5>=n.han+n.kana,i={zh:a?0:n.han,ja:a?n.han+n.kana:0,ko:n.ko,ru:n.ru,he:n.he};for(let[e,t]of Object.entries(i))if(t*5>r*3)return e;return\`en\`}`,
    `function codexLinuxReadAloudNativeLanguage(e){return{en:\`en\`,zh:\`cmn\`,ja:\`ja\`,ko:\`ko\`,ru:\`ru\`,es:\`es\`,fr:\`fr\`,de:\`de\`,it:\`it\`,pt:\`pt\`,he:\`he\`,hi:\`hi\`}[e]||\`en\`}`,
    `function codexLinuxReadAloudHome(){return process.env.HOME||process.env.USERPROFILE||${osVar}.homedir?.()||\`\`}`,
    `function codexLinuxReadAloudDataHome(){let e=codexLinuxReadAloudHome(),t=process.env.XDG_DATA_HOME||e&&${pathVar}.join(e,\`.local\`,\`share\`);return t||\`\`}`,
    `function codexLinuxReadAloudSettingsAppId(){let e=process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||\`codex-desktop\`;return/^[A-Za-z0-9._-]+$/.test(e)?e:\`codex-desktop\`}`,
    `function codexLinuxReadAloudSettingsPath(){let e=process.env.CODEX_LINUX_SETTINGS_FILE;if(typeof e===\`string\`&&e.length>0)return e;let t=codexLinuxReadAloudHome(),n=process.env.XDG_CONFIG_HOME||t&&${pathVar}.join(t,\`.config\`);return n?${pathVar}.join(n,codexLinuxReadAloudSettingsAppId(),\`settings.json\`):null}`,
    `function codexLinuxReadAloudSettings(){try{let e=codexLinuxReadAloudSettingsPath();if(!e||!${fsVar}.existsSync(e))return{};let t=JSON.parse(${fsVar}.readFileSync(e,\`utf8\`));return t&&typeof t===\`object\`&&!Array.isArray(t)?t:{}}catch{return{}}}`,
    `function codexLinuxReadAloudWriteSettings(e){let t=codexLinuxReadAloudSettingsPath();if(!t)throw Error(\`settings path unavailable\`);${fsVar}.mkdirSync(${pathVar}.dirname(t),{recursive:!0});${fsVar}.writeFileSync(t,JSON.stringify(e,null,2)+\`\\n\`)}`,
    `function codexLinuxReadAloudEnabled(){if(process.env.CODEX_LINUX_READ_ALOUD_ENABLED===\`1\`)return!0;let e=codexLinuxReadAloudSettings();return e[${JSON.stringify(SETTINGS_KEY)}]===!0}`,
    `function codexLinuxReadAloudFileExists(e){try{return!!e&&${fsVar}.existsSync(e)}catch{return!1}}`,
    `function codexLinuxReadAloudCommandExists(command){if(!command)return!1;if(command.includes(\`/\`))try{return!!command&&${fsVar}.existsSync(command)&&(${fsVar}.accessSync(command,${fsVar}.constants.X_OK),!0)}catch{return!1};try{return ${childProcessVar}.spawnSync(\`which\`,[command],{stdio:\`ignore\`}).status===0}catch{return!1}}`,
    `function codexLinuxReadAloudNativeFallbackEnabled(){let e=process.env.CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK?.trim().toLowerCase();return!(e===\`0\`||e===\`false\`||e===\`off\`||e===\`no\`)}`,
    `function codexLinuxReadAloudNativeFallbackAvailable(){return codexLinuxReadAloudNativeFallbackEnabled()&&(codexLinuxReadAloudCommandExists(\`spd-say\`)||codexLinuxReadAloudCommandExists(\`espeak-ng\`))}`,
    `function codexLinuxReadAloudAudioEnv(){if(process.env.XDG_RUNTIME_DIR)return{};let e;try{e=process.getuid?.()}catch{}if(e==null)return{};let t=\`/run/user/\${e}\`;try{if(${fsVar}.existsSync(${pathVar}.join(t,\`pipewire-0\`))||${fsVar}.existsSync(${pathVar}.join(t,\`pulse\`,\`native\`)))return{XDG_RUNTIME_DIR:t}}catch{}return{}}`,
    `function codexLinuxReadAloudKokoroRunner(){let e=process.env.CODEX_LINUX_READ_ALOUD_KOKORO_RUNNER?.trim();if(e)return e;let t=process.resourcesPath?${pathVar}.join(process.resourcesPath,\`read-aloud\`,\`kokoro-stdin\`):\`\`;return t&&codexLinuxReadAloudCommandExists(t)?t:\`kokoro-stdin\`}`,
    `function codexLinuxReadAloudKokoroPython(){let e=process.env.CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON?.trim(),t=codexLinuxReadAloudSettings()[${JSON.stringify(KOKORO_PYTHON_KEY)}];return e||typeof t===\`string\`&&t.trim()||${pathVar}.join(codexLinuxReadAloudDataHome(),\`codex-desktop\`,\`read-aloud\`,\`kokoro-venv\`,\`bin\`,\`python\`)}`,
    `function codexLinuxReadAloudKokoroModel(){let e=process.env.CODEX_LINUX_READ_ALOUD_KOKORO_MODEL?.trim(),t=codexLinuxReadAloudSettings()[${JSON.stringify(KOKORO_MODEL_KEY)}];return e||typeof t===\`string\`&&t.trim()||${pathVar}.join(codexLinuxReadAloudDataHome(),\`kokoro\`,\`kokoro-v1.0.onnx\`)}`,
    `function codexLinuxReadAloudKokoroVoices(){let e=process.env.CODEX_LINUX_READ_ALOUD_KOKORO_VOICES?.trim(),t=codexLinuxReadAloudSettings()[${JSON.stringify(KOKORO_VOICES_KEY)}];return e||typeof t===\`string\`&&t.trim()||${pathVar}.join(codexLinuxReadAloudDataHome(),\`kokoro\`,\`voices-v1.0.bin\`)}`,
    `function codexLinuxReadAloudKokoroVoice(){return process.env.CODEX_LINUX_READ_ALOUD_KOKORO_VOICE?.trim()||\`bm_george\`}`,
    `function codexLinuxReadAloudClampSpeed(e){let t=Number(e);return Number.isFinite(t)?Math.min(1.4,Math.max(.7,Math.round(t*20)/20)):1.05}`,
    `function codexLinuxReadAloudKokoroSpeed(){let e=process.env.CODEX_LINUX_READ_ALOUD_KOKORO_SPEED?.trim(),t=codexLinuxReadAloudSettings()[${JSON.stringify(KOKORO_SPEED_KEY)}];return codexLinuxReadAloudClampSpeed(e!==void 0&&e!==\`\`?e:t??1.05)}`,
    `function codexLinuxReadAloudKokoroMissing(){let e=[];codexLinuxReadAloudCommandExists(codexLinuxReadAloudKokoroRunner())||e.push(\`runner\`);codexLinuxReadAloudCommandExists(codexLinuxReadAloudKokoroPython())||e.push(\`python\`);codexLinuxReadAloudFileExists(codexLinuxReadAloudKokoroModel())||e.push(\`model\`);codexLinuxReadAloudFileExists(codexLinuxReadAloudKokoroVoices())||e.push(\`voices\`);codexLinuxReadAloudCommandExists(\`aplay\`)||e.push(\`aplay\`);return e}`,
    `function codexLinuxReadAloudKokoroModelUrl(){return process.env.CODEX_LINUX_READ_ALOUD_KOKORO_MODEL_URL?.trim()||${JSON.stringify(KOKORO_MODEL_URL)}}`,
    `function codexLinuxReadAloudKokoroVoicesUrl(){return process.env.CODEX_LINUX_READ_ALOUD_KOKORO_VOICES_URL?.trim()||${JSON.stringify(KOKORO_VOICES_URL)}}`,
    `function codexLinuxReadAloudConfig(){let e=codexLinuxReadAloudKokoroMissing();return{enabled:codexLinuxReadAloudEnabled(),engine:(process.env.CODEX_LINUX_READ_ALOUD_ENGINE?.trim()||\`kokoro\`).toLowerCase(),nativeFallback:codexLinuxReadAloudNativeFallbackEnabled(),customCommand:!!process.env.CODEX_LINUX_READ_ALOUD_COMMAND?.trim(),kokoro:{available:e.length===0,missing:e,voice:codexLinuxReadAloudKokoroVoice(),speed:codexLinuxReadAloudKokoroSpeed(),python:codexLinuxReadAloudKokoroPython(),model:codexLinuxReadAloudKokoroModel(),voices:codexLinuxReadAloudKokoroVoices(),modelUrl:codexLinuxReadAloudKokoroModelUrl(),voicesUrl:codexLinuxReadAloudKokoroVoicesUrl()}}}`,
    `function codexLinuxReadAloudBackendReady(e){let t=process.env.CODEX_LINUX_READ_ALOUD_COMMAND?.trim();return!!(e?.kokoro?.available||codexLinuxReadAloudNativeFallbackAvailable()||t&&codexLinuxReadAloudCommandExists(t))}`,
    `function codexLinuxReadAloudSetupResult(){let e=codexLinuxReadAloudConfig();return codexLinuxReadAloudBackendReady(e)?{ok:!0,config:e}:{ok:!1,reason:\`voice-unavailable\`,config:e}}`,
    `function codexLinuxReadAloudRun(command,args,timeoutMs=3e5,kind="setup",token=null){return new Promise((resolve,reject)=>{let record,timer,finished=!1;const done=error=>{if(finished)return;finished=!0;clearTimeout(timer);if(record){record.cancel=null;codexLinuxReadAloudRelease(record,!1)}error?reject(error):resolve()};try{let child=${childProcessVar}.spawn(command,args,{stdio:"ignore",windowsHide:!0,detached:!0,env:{...process.env,...codexLinuxReadAloudAudioEnv()}});record={child,kind,token,group:!0,cancel:()=>done(Error("command cancelled"))};codexLinuxReadAloudChildren.set(child,record);child.on("error",error=>{record.cancel=null;codexLinuxReadAloudRelease(record,!0);done(error)});child.on("close",code=>done(code===0?null:Error("command failed")));timer=setTimeout(()=>{record.cancel=null;codexLinuxReadAloudRelease(record,!0);done(Error("command timed out"))},timeoutMs);timer.unref?.()}catch(error){done(error)}})}`,
    `function codexLinuxReadAloudPythonOk(pythonBin){try{return ${childProcessVar}.spawnSync(pythonBin,[\`-c\`,\`import sys; raise SystemExit(0 if (3,10) <= sys.version_info < (3,14) else 1)\`],{stdio:\`ignore\`,env:{...process.env,...codexLinuxReadAloudAudioEnv()}}).status===0}catch{return!1}}`,
    `function codexLinuxReadAloudFindPython(){for(let e of [process.env.PYTHON?.trim(),\`python3.12\`,\`python3.13\`,\`python3.11\`,\`python3.10\`,\`python3\`])if(e&&codexLinuxReadAloudCommandExists(e)&&codexLinuxReadAloudPythonOk(e))return e;return null}`,
    `async function codexLinuxReadAloudInstallRuntime(){let e=codexLinuxReadAloudKokoroPython();if(codexLinuxReadAloudCommandExists(e))return;let t=${pathVar}.dirname(${pathVar}.dirname(e)),n=codexLinuxReadAloudFindPython();if(!n)throw Error(\`Python 3.10-3.13 is required for Kokoro\`);${fsVar}.mkdirSync(${pathVar}.dirname(t),{recursive:!0});if(codexLinuxReadAloudCommandExists(\`uv\`)){await codexLinuxReadAloudRun(\`uv\`,[\`venv\`,\`--python\`,n,t]);await codexLinuxReadAloudRun(\`uv\`,[\`pip\`,\`install\`,\`--python\`,e,\`kokoro-onnx>=0.5.0\`,\`numpy>=2.0.2\`],6e5);return}await codexLinuxReadAloudRun(n,[\`-m\`,\`venv\`,t]);await codexLinuxReadAloudRun(e,[\`-m\`,\`ensurepip\`,\`--upgrade\`]);await codexLinuxReadAloudRun(e,[\`-m\`,\`pip\`,\`install\`,\`--upgrade\`,\`pip\`],6e5);await codexLinuxReadAloudRun(e,[\`-m\`,\`pip\`,\`install\`,\`kokoro-onnx>=0.5.0\`,\`numpy>=2.0.2\`],6e5)}`,
    `function codexLinuxReadAloudDownloadFile(url,target,minBytes,redirects=0){return new Promise((resolve,reject)=>{if(redirects>5){reject(Error(\`too many redirects\`));return}let parsed;try{parsed=new URL(url)}catch{reject(Error(\`invalid download URL\`));return}let get=parsed.protocol===\`https:\`?require(\`node:https\`).get:parsed.protocol===\`http:\`?require(\`node:http\`).get:null;if(!get){reject(Error(\`unsupported download URL\`));return}${fsVar}.mkdirSync(${pathVar}.dirname(target),{recursive:!0});let partial=\`\${target}.part\`,bytes=0,done=!1;try{${fsVar}.rmSync(partial,{force:!0})}catch{}let cleanup=()=>{try{${fsVar}.rmSync(partial,{force:!0})}catch{}};let fail=e=>{if(done)return;done=!0;cleanup();reject(e instanceof Error?e:Error(String(e)))};let fileStream=${fsVar}.createWriteStream(partial),request=get(parsed,{headers:{"User-Agent":\`codex-desktop-read-aloud\`}},response=>{if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume?.();fileStream.close(()=>{});cleanup();codexLinuxReadAloudDownloadFile(new URL(response.headers.location,parsed).toString(),target,minBytes,redirects+1).then(resolve,reject);return}if(response.statusCode!==200){response.resume?.();fileStream.close(()=>{});fail(Error(\`download failed with status \${response.statusCode}\`));return}response.on(\`data\`,chunk=>{bytes+=chunk.length}),response.pipe(fileStream),fileStream.on(\`finish\`,()=>fileStream.close(()=>{if(done)return;if(bytes<minBytes){fail(Error(\`download too small\`));return}try{${fsVar}.renameSync(partial,target),done=!0,resolve()}catch(error){fail(error)}}))});request.on(\`error\`,fail),fileStream.on(\`error\`,fail)})}`,
    `async function codexLinuxReadAloudDownloadKokoro(){let e=codexLinuxReadAloudKokoroModel(),t=codexLinuxReadAloudKokoroVoices();codexLinuxReadAloudFileExists(e)||await codexLinuxReadAloudDownloadFile(codexLinuxReadAloudKokoroModelUrl(),e,5e7);codexLinuxReadAloudFileExists(t)||await codexLinuxReadAloudDownloadFile(codexLinuxReadAloudKokoroVoicesUrl(),t,1e6);let n=codexLinuxReadAloudSettings();n[${JSON.stringify(KOKORO_PYTHON_KEY)}]=codexLinuxReadAloudKokoroPython(),n[${JSON.stringify(KOKORO_MODEL_KEY)}]=e,n[${JSON.stringify(KOKORO_VOICES_KEY)}]=t,codexLinuxReadAloudWriteSettings(n)}`,
    `async function codexLinuxReadAloudChooseModelDir(){let electronApi;try{electronApi=${electronVar ?? "require(`electron`)"}}catch{return{ok:!1,reason:\`dialog-unavailable\`}}let result=await electronApi.dialog.showOpenDialog({title:\`Choose Kokoro model folder\`,properties:[\`openDirectory\`]});if(result.canceled||!result.filePaths?.[0])return{ok:!1,reason:\`cancelled\`};let dir=result.filePaths[0],modelPath=${pathVar}.join(dir,\`kokoro-v1.0.onnx\`),voicesPath=${pathVar}.join(dir,\`voices-v1.0.bin\`);if(!codexLinuxReadAloudFileExists(modelPath)||!codexLinuxReadAloudFileExists(voicesPath))return{ok:!1,reason:\`missing-files\`,path:dir};let settings=codexLinuxReadAloudSettings();settings[${JSON.stringify(KOKORO_MODEL_KEY)}]=modelPath,settings[${JSON.stringify(KOKORO_VOICES_KEY)}]=voicesPath,codexLinuxReadAloudWriteSettings(settings);return codexLinuxReadAloudSetupResult()}`,
    `async function codexLinuxReadAloudSetup(e={}){if(process.platform!==\`linux\`)return{ok:!1,reason:\`not-linux\`};try{if(e.mode===\`choose-folder\`)return await codexLinuxReadAloudChooseModelDir();if(e.mode===\`download\`){await codexLinuxReadAloudInstallRuntime();await codexLinuxReadAloudDownloadKokoro();return codexLinuxReadAloudSetupResult()}return{ok:!1,reason:\`unknown-mode\`}}catch(t){let n=t?.message??String(t);return{ok:!1,reason:n.includes(\`Python 3.10-3.13\`)?\`python-unavailable\`:\`setup-failed\`,message:n}}}`,
    `function codexLinuxReadAloudReport(e){try{console.info(\`[linux-read-aloud] \${JSON.stringify(e)}\`)}catch{}return e}`,
    `let codexLinuxReadAloudGeneration=0;const codexLinuxReadAloudChildren=new Map;function codexLinuxReadAloudRelease(record,kill){if(!record||!codexLinuxReadAloudChildren.has(record.child))return;codexLinuxReadAloudChildren.delete(record.child);let cancel=record.cancel;record.cancel=null;cancel?.();if(!kill)return;try{if(record.group&&Number.isInteger(record.child.pid)&&record.child.pid>0){process.kill(-record.child.pid,"SIGTERM");return}}catch{}try{record.child.kill?.("SIGTERM")}catch{}}`,
    `function codexLinuxReadAloudStop(){codexLinuxReadAloudGeneration++;let owned=[...codexLinuxReadAloudChildren.values()].filter(e=>e.kind==="speech");for(let record of owned)codexLinuxReadAloudRelease(record,!0);return codexLinuxReadAloudReport(owned.length?{stopped:!0}:{stopped:!1,reason:"idle"})}`,
    `function codexLinuxReadAloudCleanup(){codexLinuxReadAloudGeneration++;for(let record of [...codexLinuxReadAloudChildren.values()])codexLinuxReadAloudRelease(record,!0)}`,
    `function codexLinuxReadAloudInstallCleanup(){process.once?.("exit",codexLinuxReadAloudCleanup);try{require("electron").app?.once?.("quit",codexLinuxReadAloudCleanup)}catch{}}`,
    `function codexLinuxReadAloudLaunch(command,args,options,token){if(token!==codexLinuxReadAloudGeneration)return Promise.resolve(null);return new Promise(resolve=>{let record,settled=!1;const finish=value=>{if(settled)return;settled=!0;if(record)record.cancel=null;resolve(value)};const fail=error=>{if(record){record.failed=!0;if(codexLinuxReadAloudChildren.has(record.child)){for(let owned of [...codexLinuxReadAloudChildren.values()])if(owned.kind==="speech"&&owned.token===token)codexLinuxReadAloudRelease(owned,!0);codexLinuxReadAloudReport({spoken:!1,reason:"speech-process-failed",message:error?.message??String(error)})}}finish(null)};try{let child=${childProcessVar}.spawn(command,args,{...options,stdio:options.stdio??"ignore",windowsHide:!0,detached:!0,env:{...process.env,...codexLinuxReadAloudAudioEnv(),...(options.env||{})}});record={child,kind:"speech",token,group:!0,failed:!1,cancel:()=>finish(null)};codexLinuxReadAloudChildren.set(child,record);child.on("error",fail);child.stdin?.on?.("error",fail);child.stdout?.on?.("error",fail);child.once("close",code=>{if(codexLinuxReadAloudChildren.has(child)){if(code!==0){fail(Error("speech process exited with code "+String(code)));return}codexLinuxReadAloudRelease(record,!1)}finish(null)});child.once("spawn",()=>{if(token!==codexLinuxReadAloudGeneration||!codexLinuxReadAloudChildren.has(child)){finish(null);return}child.unref?.();finish(record)})}catch(error){fail(error)}})}`,
    `async function codexLinuxReadAloudSpawn(command,args,options={},token=codexLinuxReadAloudGeneration){if(!codexLinuxReadAloudCommandExists(command))return!1;return null!=await codexLinuxReadAloudLaunch(command,args,options,token)}`,
    `async function codexLinuxReadAloudSpawnStdin(command,args,text,extraEnv={},token=codexLinuxReadAloudGeneration){if(!codexLinuxReadAloudCommandExists(command))return!1;let record=await codexLinuxReadAloudLaunch(command,args,{stdio:["pipe","ignore","ignore"],env:extraEnv},token);if(!record||record.failed||token!==codexLinuxReadAloudGeneration)return!1;try{record.child.stdin?.end(text);return!record.failed}catch{codexLinuxReadAloudRelease(record,!0);return!1}}`,
    `async function codexLinuxReadAloudKokoro(e,token){let t=codexLinuxReadAloudKokoroMissing(),n=codexLinuxReadAloudLanguage(e),r={en:[\`bm_george\`,\`en-us\`],zh:[\`zf_xiaobei\`,\`cmn\`],ja:[\`jf_alpha\`,\`ja\`],es:[\`ef_dora\`,\`es\`],fr:[\`ff_siwis\`,\`fr-fr\`],hi:[\`hf_alpha\`,\`hi\`],it:[\`if_sara\`,\`it\`],pt:[\`pf_dora\`,\`pt-br\`]};if(t.length)return{spoken:!1,reason:\`kokoro-unavailable\`,missing:t,language:n};let o=process.env.CODEX_LINUX_READ_ALOUD_KOKORO_LANGUAGE_VOICE?.trim()||process.env.CODEX_LINUX_READ_ALOUD_KOKORO_VOICE?.trim(),s=process.env.CODEX_LINUX_READ_ALOUD_KOKORO_LANG?.trim();if(!r[n]&&!o&&!s)return{spoken:!1,reason:\`native-language\`,language:n};let v=r[n]||r.en,i=o||v[0];s=s||v[1];let a=codexLinuxReadAloudKokoroSpeed(),l={CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON:codexLinuxReadAloudKokoroPython(),CODEX_LINUX_READ_ALOUD_KOKORO_MODEL:codexLinuxReadAloudKokoroModel(),CODEX_LINUX_READ_ALOUD_KOKORO_VOICES:codexLinuxReadAloudKokoroVoices(),CODEX_LINUX_READ_ALOUD_KOKORO_VOICE:i,CODEX_LINUX_READ_ALOUD_KOKORO_LANG:s,CODEX_LINUX_READ_ALOUD_KOKORO_SPEED:String(a)};return await codexLinuxReadAloudSpawnStdin(codexLinuxReadAloudKokoroRunner(),[],e,l,token)?{spoken:!0,engine:\`kokoro\`,voice:i,lang:s,language:n,speed:a}:{spoken:!1,reason:\`kokoro-spawn-failed\`,language:n}}`,
    `async function codexLinuxReadAloudPiper(text,modelPath,token=codexLinuxReadAloudGeneration){let piperBin=process.env.CODEX_LINUX_READ_ALOUD_PIPER_BIN?.trim()||"piper";if(!modelPath||!${fsVar}.existsSync(modelPath)||!codexLinuxReadAloudCommandExists(piperBin)||!codexLinuxReadAloudCommandExists("aplay"))return!1;let piper=await codexLinuxReadAloudLaunch(piperBin,["--model",modelPath,"--output-raw"],{stdio:["pipe","pipe","ignore"]},token);if(!piper)return!1;let aplay=await codexLinuxReadAloudLaunch("aplay",["-q","-r","22050","-c","1","-f","S16_LE","-t","raw"],{stdio:["pipe","ignore","ignore"]},token);if(!aplay||piper.failed||aplay.failed||token!==codexLinuxReadAloudGeneration){codexLinuxReadAloudRelease(piper,!0);codexLinuxReadAloudRelease(aplay,!0);return!1}try{piper.child.stdout?.pipe(aplay.child.stdin);piper.child.stdin?.end(text);return!piper.failed&&!aplay.failed}catch{codexLinuxReadAloudRelease(piper,!0);codexLinuxReadAloudRelease(aplay,!0);return!1}}`,
    `async function codexLinuxReadAloudSpeak(input,options={}){if(process.platform!==\`linux\`)return codexLinuxReadAloudReport({spoken:!1,reason:\`not-linux\`});if(options?.requireEnabled!==!1&&!codexLinuxReadAloudEnabled())return codexLinuxReadAloudReport({spoken:!1,reason:\`disabled\`});let text=codexLinuxReadAloudCleanText(input);if(!text)return codexLinuxReadAloudReport({spoken:!1,reason:\`empty\`});codexLinuxReadAloudStop();let token=codexLinuxReadAloudGeneration,cancelled=()=>token!==codexLinuxReadAloudGeneration,reportCancelled=()=>codexLinuxReadAloudReport({spoken:!1,reason:"cancelled"});let customFailed=!1,customCommand=process.env.CODEX_LINUX_READ_ALOUD_COMMAND?.trim();if(customCommand){let started=await codexLinuxReadAloudSpawnStdin(customCommand,[],text,{},token);if(cancelled())return reportCancelled();if(started)return codexLinuxReadAloudReport({spoken:!0,engine:\`custom\`});customFailed=!0}let engine=(process.env.CODEX_LINUX_READ_ALOUD_ENGINE?.trim()||\`kokoro\`).toLowerCase(),language=codexLinuxReadAloudLanguage(text),piperModel=process.env.CODEX_LINUX_READ_ALOUD_PIPER_MODEL?.trim();if(engine===\`piper\`){let started=await codexLinuxReadAloudPiper(text,piperModel,token);if(cancelled())return reportCancelled();return codexLinuxReadAloudReport(started?{spoken:!0,engine:\`piper\`,language}:{spoken:!1,reason:\`piper-unavailable\`,language})}let kokoroResult=await codexLinuxReadAloudKokoro(text,token);if(cancelled())return reportCancelled();if(kokoroResult.spoken)return codexLinuxReadAloudReport(kokoroResult);if(!codexLinuxReadAloudNativeFallbackEnabled())return codexLinuxReadAloudReport(customFailed?{spoken:!1,reason:"custom-spawn-failed"}:kokoroResult);let piperStarted=await codexLinuxReadAloudPiper(text,piperModel,token);if(cancelled())return reportCancelled();if(piperStarted)return codexLinuxReadAloudReport({spoken:!0,engine:\`piper\`,language});let voice=process.env.CODEX_LINUX_READ_ALOUD_VOICE?.trim(),rate=process.env.CODEX_LINUX_READ_ALOUD_RATE?.trim()||\`-10\`,voiceType=process.env.CODEX_LINUX_READ_ALOUD_VOICE_TYPE?.trim(),nativeLanguage=codexLinuxReadAloudNativeLanguage(language);if(codexLinuxReadAloudCommandExists("spd-say"))try{await codexLinuxReadAloudRun("spd-say",["-C"],5000,"speech",token)}catch{}if(cancelled())return reportCancelled();let spdArgs=[\`-r\`,rate,...(voiceType?[\`-t\`,voiceType]:[]),...(voice?[\`-y\`,voice]:[]),\`-l\`,nativeLanguage,\`--\`,text];let spdStarted=await codexLinuxReadAloudSpawn(\`spd-say\`,spdArgs,{},token);if(cancelled())return reportCancelled();if(spdStarted)return codexLinuxReadAloudReport({spoken:!0,engine:\`spd-say\`,language});let espeakVoice=voice||(language===\`en\`?\`en-us\`:nativeLanguage);let espeakStarted=await codexLinuxReadAloudSpawn(\`espeak-ng\`,[\`-v\`,espeakVoice,\`-s\`,process.env.CODEX_LINUX_READ_ALOUD_ESPEAK_RATE?.trim()||\`165\`,\`--\`,text],{},token);if(cancelled())return reportCancelled();return codexLinuxReadAloudReport(espeakStarted?{spoken:!0,engine:\`espeak-ng\`,language}:kokoroResult)}`,
    `function codexLinuxReadAloudSettingKey(e){if(e!==${JSON.stringify(SETTINGS_KEY)}&&e!==${JSON.stringify(KOKORO_SPEED_KEY)})throw Error(\`Unsupported read aloud setting\`);return e}`,
    `function codexLinuxReadAloudGetSetting(e){let t=codexLinuxReadAloudSettingKey(e),n=codexLinuxReadAloudSettings()[t];return{value:t===${JSON.stringify(KOKORO_SPEED_KEY)}?codexLinuxReadAloudClampSpeed(n??1.05):n===!0}}`,
    `function codexLinuxReadAloudSetSetting(e,t){let n=codexLinuxReadAloudSettingKey(e),r=codexLinuxReadAloudSettings();r[n]=n===${JSON.stringify(KOKORO_SPEED_KEY)}?codexLinuxReadAloudClampSpeed(t):t===!0;codexLinuxReadAloudWriteSettings(r);return{success:!0,value:r[n]}}`,
    `function codexLinuxReadAloudHandle(e={}){return e.action===\`config\`?codexLinuxReadAloudConfig():e.action===\`get-setting\`?codexLinuxReadAloudGetSetting(e.key):e.action===\`set-setting\`?codexLinuxReadAloudSetSetting(e.key,e.value):e.action===\`setup\`?codexLinuxReadAloudSetup(e):e.action===\`stop\`?codexLinuxReadAloudStop():e.action===\`speak\`&&e.source===\`button\`?codexLinuxReadAloudSpeak(e.text,{requireEnabled:!1}):codexLinuxReadAloudReport({spoken:!1,reason:\`not-explicit\`})}`,
    `async function codexLinuxReadAloudFetch(e,t){let n=e?.requestId;try{let r;try{r=typeof e?.body===\`string\`&&e.body.length>0?JSON.parse(e.body):e?.body??{}}catch{throw Error(\`Invalid read aloud request\`)}let i=await codexLinuxReadAloudHandle(r&&typeof r===\`object\`?r:{});t({type:\`fetch-response\`,responseType:\`success\`,requestId:n,status:200,headers:{"content-type":\`application/json\`},bodyJsonString:JSON.stringify(i??null)})}catch(r){t({type:\`fetch-response\`,responseType:\`error\`,requestId:n,status:500,error:r instanceof Error?r.message:String(r)})}}`,
    `codexLinuxReadAloudInstallCleanup();`,
  ].join("");
  return `${MAIN_HELPER_START}\n${helper}\n${MAIN_HELPER_END}\n`;
}
function helperAtOuterStatement(source, helper) {
  if (count(source, helper) !== 1) return false;
  const prefix = source.slice(0, source.indexOf(helper));
  if (findMatchingBrace("{" + prefix + "}", 0) !== prefix.length + 1) return false;
  try { new Script(prefix + "const __codexReadAloudOwnedHelper=0;"); return true; }
  catch { return false; }
}
function hasOwnedMainReferences(source) {
  if (source.includes("codexLinuxReadAloud")) return true;
  if (!source.includes("\\u")) return false;
  let lexical;
  const tokens = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  for (const token of source.matchAll(tokens)) {
    if (!token[0].includes("\\u")) continue;
    const decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => {
      const point = parseInt(braced ?? fixed, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : "\0";
    });
    if (!decoded.startsWith("codexLinuxReadAloud")) continue;
    lexical ??= createJavaScriptLexicalIndex(source);
    if (lexical.isCode(token.index)) return true;
  }
  return false;
}

function completeMainPatch(source, site, helper, route) {
  if (count(source, FETCH_ROUTE_MARKER) !== 1 || count(source, route) !== 1 ||
      !helperAtOuterStatement(source, helper) ||
      !source.slice(site.prefixStart, site.prefixEnd).includes(route)) return false;
  // A helper definition/reference outside our exact block and exact route can
  // override or hide the runtime binding. The namespace is feature-local.
  return !hasOwnedMainReferences(source.replace(helper, "").replace(route, ""));
}
function applyMainBundlePatch(source) {
  const graph = inspectMainRequestSites(source);
  if (!graph.ok) {
    warn(`Could not verify native read aloud request owner: ${graph.reason}`, "read aloud main-bundle patch");
    return source;
  }
  const site = graph.wrapperRequest, helper = mainHelperSource(), route = fetchRouteSource(site);
  if (hasOwnedMainReferences(source) || source.includes(FETCH_ROUTE_MARKER)) {
    if (!completeMainPatch(source, site, helper, route)) warn("Found incomplete read aloud route/helper ownership", "read aloud main-bundle patch");
    return source;
  }
  const routed = source.slice(0, site.insertAt) + route + source.slice(site.insertAt);
  const helperAt = routed.startsWith('"use strict";') ? '"use strict";'.length : routed.startsWith("'use strict';") ? "'use strict';".length : 0;
  const patched = routed.slice(0, helperAt) + helper + routed.slice(helperAt);
  const post = inspectMainRequestSites(patched);
  if (!post.ok || !completeMainPatch(patched, post.wrapperRequest, helper, fetchRouteSource(post.wrapperRequest))) {
    warn("Read aloud main request poststate failed", "read aloud main-bundle patch");
    return source;
  }
  return patched;
}

function applyMainToExtractedApp(extractedDir, options = {}) {
  const main = findMainProcessChunks(extractedDir);
  if (!main) throw Error("Missing read aloud main-process inventory");
  const snapshots = main.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(main.buildDir, assetName), "utf8");
    return { assetName, source, graph: inspectMainRequestSites(source) };
  });
  // Include all physical copies of the native factory and feature artifacts. A quiet
  // canonical fragment in an unrelated chunk cannot stand in for the owner.
  const verified = snapshots.filter(({ graph }) => graph.ok);
  if (verified.length !== 1) throw Error("Missing or ambiguous read aloud native request owner");
  const owner = verified[0], identity = owner.graph.scope.factoryId;
  if (typeof identity !== "string") throw Error("Missing read aloud native factory identity");
  const candidates = snapshots.filter(({ source, graph }) => graph.factoryIds?.includes(identity) ||
    hasOwnedMainReferences(source) ||
    source.includes(FETCH_ROUTE_MARKER) || source.includes(MAIN_HELPER_START));
  if (candidates.length !== 1 || candidates[0] !== owner) throw Error("Missing or ambiguous read aloud main request cohort");
  const helper = mainHelperSource(), route = fetchRouteSource(owner.graph.wrapperRequest);
  const hasArtifacts = hasOwnedMainReferences(owner.source) || owner.source.includes(FETCH_ROUTE_MARKER);
  if (hasArtifacts && !completeMainPatch(owner.source, owner.graph.wrapperRequest, helper, route)) {
    throw Error("Incomplete read aloud main route/helper ownership");
  }
  const patchedSource = applyMainBundlePatch(owner.source);
  if (!hasArtifacts && patchedSource === owner.source) throw Error("Read aloud main source poststate failed");
  const result = commitMainEdits(main.buildDir, snapshots.map(row => ({ assetName: row.assetName,
    source: row.source, patchedSource: row === owner ? patchedSource : row.source })), options);
  if (!hasArtifacts && result.changed !== 1) throw Error("Read aloud main transaction was not committed");
  return { matched: 1, ...result };
}

function readAloudRuntimeSource() {
  return [
    `;(()=>{const VERSION=${JSON.stringify(RUNTIME_VERSION)};if(globalThis.codexLinuxReadAloudVersion===VERSION)return;globalThis.codexLinuxReadAloudVersion=VERSION;try{globalThis.speechSynthesis?.cancel?.()}catch{}`,
    `const METHOD=${JSON.stringify(HANDLER_NAME)};let seq=0,speechTicket=0,pending=new Map,currentButton=null,currentSpeakTimer=null;`,
    `function onMessage(e){let t=e?.data;if(!t||typeof t!="object"||t.type!=="fetch-response")return;let n=pending.get(t.requestId);if(!n)return;pending.delete(t.requestId);clearTimeout(n.timer);if(t.responseType==="success"){let e=null;try{e=t.bodyJsonString?JSON.parse(t.bodyJsonString):null}catch{}n.resolve({status:t.status,body:e})}else n.reject(Error(t.error||"fetch failed"))}`,
    `window.addEventListener("message",onMessage);`,
    `function dispatch(payload){let bridge=window.electronBridge,event=new CustomEvent("codex-message-from-view",{detail:payload});if(bridge?.sendMessageFromView){event.__codexForwardedViaBridge=!0;bridge.sendMessageFromView(payload).catch(()=>{})}window.dispatchEvent(event)}`,
    `function log(message,tags={}){dispatch({type:"log-message",level:"info",message,tags:{safe:tags,sensitive:{}}})}`,
    `function hostPost(method,body,timeoutMs=4000){let requestId="codex-linux-read-aloud-"+ ++seq;let payload={type:"fetch",hostId:"local",requestId,method:"POST",url:"vscode://codex/"+method,body:JSON.stringify(body??{})};return new Promise((resolve,reject)=>{let timer=setTimeout(()=>{pending.delete(requestId);reject(Error("timeout"))},timeoutMs);pending.set(requestId,{resolve,reject,timer});dispatch(payload)})}`,
    `function post(params,timeoutMs=4000){return hostPost(METHOD,params,timeoutMs)}`,
    `function clean(text){return String(text||"").replace(/\\r\\n/g,"\\n").replace(/\`\`\`[\\s\\S]*?\`\`\`/g," code block. ").replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,"$1").replace(/[*_#>~]/g,"").replace(/\\n{3,}/g,"\\n\\n").trim().slice(0,8e3)}`,
    `function buttonLabel(state,label){return label??(state==="speaking"?"Stop read aloud":state==="loading"?"Loading voice":state==="error"?"No voice available":"Read assistant response aloud")}`,
    `function setButton(button,state,label){if(!button)return;let title=buttonLabel(state,label);button.dataset.codexLinuxReadAloudState=state;button.title=title;button.setAttribute("aria-label",title);button.disabled=state==="loading"}`,
    `function flash(button,label,ticket=speechTicket){if(ticket!==speechTicket)return;setButton(button,"error",label);setTimeout(()=>{ticket===speechTicket&&resetButton(button)},1500)}`,
    `function resetButton(button=currentButton){if(currentSpeakTimer!=null){clearTimeout(currentSpeakTimer);currentSpeakTimer=null}if(button)setButton(button,"ready");if(button===currentButton)currentButton=null}`,
    `function stopSpeech(){speechTicket++;resetButton();post({action:"stop"}).catch(()=>{})}`,
    `function estimateMs(text){let words=text.split(/\\s+/).filter(Boolean).length;return Math.max(3000,Math.min(120000,words*360))}`,
    `function failureLabel(result){let reason=result?.reason;if(reason==="disabled")return"Enable Read aloud in settings";if(reason==="kokoro-unavailable")return"Install Read aloud voice model";if(reason==="empty")return"Nothing to read";return"No voice available"}`,
    `async function click(item,copyText,conversationId,button){let ticket;try{button?.blur?.();if(globalThis.codexLinuxConversationIsSpeaking?.()){speechTicket++;globalThis.codexLinuxConversationStopSpeaking?.();resetButton();setButton(button,"ready");return}if(button?.dataset.codexLinuxReadAloudState==="speaking"){stopSpeech();return}let text=clean(copyText||item?.content||"");if(text.length<2)return;ticket=++speechTicket;resetButton();currentButton=button;setButton(button,"loading","Starting voice");let result=await post({action:"speak",source:"button",text}).then(e=>e.body).catch(()=>({spoken:!1,reason:"request-failed"}));if(ticket!==speechTicket)return;log("[linux-read-aloud] click",{conversationId:conversationId||null,textLength:text.length,spoken:result?.spoken===!0,engine:result?.engine||null,reason:result?.reason||null,missing:Array.isArray(result?.missing)?result.missing.join(","):null});if(result?.spoken){setButton(button,"speaking");currentSpeakTimer=setTimeout(()=>{ticket===speechTicket&&resetButton(button)},estimateMs(text));return}flash(button,failureLabel(result),ticket)}catch{flash(button,"No voice available",ticket)}}`,
    `function setupLabel(result){let reason=result?.reason;if(reason==="cancelled")return"Cancelled";if(reason==="missing-files")return"Folder is missing model files";if(reason==="python-unavailable")return"Python 3.10-3.13 required";if(reason==="voice-unavailable")return"Voice backend missing";return result?.ok?"Voice ready":"Setup failed"}`,
    `async function setup(mode,button){let original=button?.dataset.codexLinuxReadAloudOriginalLabel||button?.textContent||"";if(button&&!button.dataset.codexLinuxReadAloudOriginalLabel)button.dataset.codexLinuxReadAloudOriginalLabel=original;try{button&&(button.disabled=!0,button.textContent=mode==="download"?"Downloading...":"Choosing...");let result=await post({action:"setup",mode},mode==="download"?9e5:6e4).then(e=>e.body).catch(()=>({ok:!1,reason:"request-failed"}));button&&(button.textContent=setupLabel(result));setTimeout(()=>{button&&(button.textContent=original,button.disabled=!1)},1800);return result}catch{button&&(button.textContent="Setup failed",setTimeout(()=>{button.textContent=original,button.disabled=!1},1800))}}`,
    `function installStyle(){if(document.getElementById("codex-linux-read-aloud-style"))return;let e=document.createElement("style");e.id="codex-linux-read-aloud-style";e.textContent=".codex-linux-read-aloud-row{display:flex;align-items:center;margin-top:4px}.codex-linux-read-aloud-button{width:28px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--token-border);background:transparent;color:var(--text-secondary,var(--token-description-foreground));border-radius:6px;padding:0;cursor:pointer}.codex-linux-read-aloud-icon{width:15px;height:15px}.codex-linux-read-aloud-button:hover{background:var(--token-list-hover-background,rgba(127,127,127,.12));color:var(--text-primary,var(--token-foreground))}.codex-linux-read-aloud-button:disabled{opacity:.65;cursor:default}.codex-linux-read-aloud-button[data-codex-linux-read-aloud-state=speaking]{background:var(--token-list-hover-background,rgba(127,127,127,.14));color:var(--text-primary,var(--token-foreground))}.codex-linux-read-aloud-button[data-codex-linux-read-aloud-state=error]{color:var(--token-error-foreground,#c00);border-color:currentColor}.codex-linux-read-aloud-settings{display:flex;flex-direction:column;gap:8px;margin-top:24px}.codex-linux-read-aloud-settings-title{font-size:15px;font-weight:500;color:var(--text-primary,var(--token-foreground))}.codex-linux-read-aloud-settings-group{display:flex;flex-direction:column;border:1px solid var(--token-border);border-radius:10px}.codex-linux-read-aloud-settings-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px}.codex-linux-read-aloud-settings-row+.codex-linux-read-aloud-settings-row{border-top:1px solid var(--token-border)}.codex-linux-read-aloud-settings-row[hidden],.codex-linux-read-aloud-settings-controls[hidden],.codex-linux-read-aloud-settings-error[hidden]{display:none}.codex-linux-read-aloud-settings-text{display:flex;flex-direction:column;gap:2px;min-width:0}.codex-linux-read-aloud-settings-label{font-size:14px;color:var(--text-primary,var(--token-foreground))}.codex-linux-read-aloud-settings-description{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--text-secondary,var(--token-description-foreground))}.codex-linux-read-aloud-settings-error{color:var(--token-error-foreground,#c00)}.codex-linux-read-aloud-settings-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}.codex-linux-read-aloud-settings-button{border:1px solid var(--token-border);border-radius:6px;padding:4px 8px;font-size:13px;background:transparent;color:var(--text-primary,var(--token-foreground));cursor:pointer}.codex-linux-read-aloud-settings-button:disabled{opacity:.6;cursor:default}.codex-linux-read-aloud-settings-help{display:inline-flex;width:26px;height:26px;align-items:center;justify-content:center;border:1px solid var(--token-border);border-radius:999px;font-size:13px;color:var(--text-secondary,var(--token-description-foreground));user-select:none}.codex-linux-read-aloud-settings-range{width:144px}.codex-linux-read-aloud-settings-value{width:48px;text-align:right;font-size:13px;color:var(--text-secondary,var(--token-description-foreground))}.codex-linux-read-aloud-switch{position:relative;width:34px;height:20px;flex:none;border:0;border-radius:999px;padding:0;background:var(--token-border,rgba(127,127,127,.35));cursor:pointer;transition:background .15s}.codex-linux-read-aloud-switch:after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}.codex-linux-read-aloud-switch[aria-checked=true]{background:var(--text-primary,var(--token-foreground,#0a84ff))}.codex-linux-read-aloud-switch[aria-checked=true]:after{transform:translateX(14px)}.codex-linux-read-aloud-switch:disabled{opacity:.6;cursor:default}";document.head.appendChild(e)}`,
    `function getSetting(key){return post({action:"get-setting",key}).then(e=>e.body?.value)}`,
    `function setSetting(key,value){return post({action:"set-setting",key,value}).then(e=>{if(e.body?.success!==!0)throw Error("Could not save setting");return e.body})}`,
    `function pace(value){let number=Number(value);return Number.isFinite(number)?Math.min(1.4,Math.max(.7,Math.round(number*20)/20)):1.05}`,
    `function node(tag,props={},children=[]){let element=document.createElement(tag);for(let[key,value]of Object.entries(props))key==="className"?element.className=value:key==="text"?element.textContent=value:element.setAttribute(key,value);for(let child of children)child&&element.appendChild(child);return element}`,
    `function settingsRow(label,description,controls){return node("div",{className:"codex-linux-read-aloud-settings-row"},[node("div",{className:"codex-linux-read-aloud-settings-text"},[node("div",{className:"codex-linux-read-aloud-settings-label",text:label}),description]),node("div",{className:"codex-linux-read-aloud-settings-controls"},controls)])}`,
    `function mountSettings(root){if(!root||root.dataset?.codexLinuxReadAloudMounted===VERSION)return;root.dataset.codexLinuxReadAloudMounted=VERSION;let state={enabled:!1,speed:1.05,loading:!0,error:null},confirmed={enabled:!1,speed:1.05},writes={enabled:0,speed:0},queues={enabled:Promise.resolve(),speed:Promise.resolve()},keys={enabled:${JSON.stringify(SETTINGS_KEY)},speed:${JSON.stringify(KOKORO_SPEED_KEY)}},help="Choose folder expects kokoro-v1.0.onnx and voices-v1.0.bin. Download voice creates a managed Python runtime and downloads the Kokoro files from Hugging Face.",toggle=node("button",{type:"button",role:"switch",className:"codex-linux-read-aloud-switch","aria-label":"Read aloud responses","aria-checked":"false"}),choose=node("button",{type:"button",className:"codex-linux-read-aloud-settings-button",text:"Choose folder"}),download=node("button",{type:"button",className:"codex-linux-read-aloud-settings-button",text:"Download voice"}),setupControls=node("div",{className:"codex-linux-read-aloud-settings-controls"},[choose,download,node("span",{className:"codex-linux-read-aloud-settings-help",title:help,"aria-label":help,text:"?"})]),range=node("input",{type:"range",min:"0.7",max:"1.4",step:"0.05",value:"1.05","aria-label":"Speech pace",className:"codex-linux-read-aloud-settings-range"}),rangeValue=node("span",{className:"codex-linux-read-aloud-settings-value",text:"1.05x"}),error=node("div",{className:"codex-linux-read-aloud-settings-error",role:"status"}),paceRow=settingsRow("Speech pace",node("div",{className:"codex-linux-read-aloud-settings-description",text:"Adjust the read aloud speed."}),[range,rangeValue]);`,
    `function render(){toggle.setAttribute("aria-checked",String(state.enabled===!0));toggle.disabled=state.loading;setupControls.hidden=!state.enabled;paceRow.hidden=!state.enabled;range.value=String(state.speed);range.disabled=state.loading;rangeValue.textContent=state.speed.toFixed(2)+"x";error.textContent=state.error??"";error.hidden=!state.error}`,
    `function write(kind,value){let ticket=++writes[kind],request=()=>setSetting(keys[kind],value);state[kind]=value;state.error=null;render();queues[kind]=queues[kind].then(request,request);return queues[kind].then(()=>{confirmed[kind]=value;ticket===writes[kind]&&(state[kind]=value,state.error=null,render())},reason=>{ticket===writes[kind]&&(state[kind]=confirmed[kind],state.error=reason instanceof Error?reason.message:String(reason),render())})}`,
    `toggle.addEventListener("click",()=>{state.loading||write("enabled",!state.enabled)});range.addEventListener("input",event=>{rangeValue.textContent=pace(event.currentTarget.value).toFixed(2)+"x"});range.addEventListener("change",event=>{write("speed",pace(event.currentTarget.value))});choose.addEventListener("click",event=>setup("choose-folder",event.currentTarget));download.addEventListener("click",event=>setup("download",event.currentTarget));`,
    `root.replaceChildren(node("section",{className:"codex-linux-read-aloud-settings","aria-label":"Read Aloud"},[node("div",{className:"codex-linux-read-aloud-settings-title",text:"Read Aloud"}),node("div",{className:"codex-linux-read-aloud-settings-group"},[settingsRow("Read aloud responses",node("div",{className:"codex-linux-read-aloud-settings-description"},[node("span",{text:"Allow speech requests from integrations and show voice setup controls. Message speech buttons work independently. If the Kokoro voice files are missing, choose a local folder or download them."}),error]),[toggle,setupControls]),paceRow])]));render();`,
    `let load=Promise.allSettled([getSetting(keys.enabled),getSetting(keys.speed)]).then(([enabled,speed])=>{enabled.status==="fulfilled"&&(state.enabled=confirmed.enabled=enabled.value===!0);speed.status==="fulfilled"&&(state.speed=confirmed.speed=pace(speed.value??1.05));let failure=enabled.status==="rejected"?enabled.reason:speed.status==="rejected"?speed.reason:null;state.error=failure==null?null:failure instanceof Error?failure.message:String(failure)}).finally(()=>{state.loading=!1;render()});return{load,write,state}}`,
    `installStyle();globalThis.${HELPER_MARKER}=click;globalThis.${SETUP_MARKER}=setup;globalThis.${SETTINGS_MOUNT_MARKER}=mountSettings;globalThis.codexLinuxReadAloudGetSetting=getSetting;globalThis.codexLinuxReadAloudSetSetting=setSetting;})();`,
  ].join("");
}

function readAloudIconButtonSource(jsxVar, itemVar, copyVar, conversationVar, eventVar) {
  return `(0,${jsxVar}.jsx)("button",{type:"button",className:"codex-linux-read-aloud-button",title:"Read assistant response aloud","aria-label":"Read assistant response aloud",onClick:${eventVar}=>{${eventVar}.stopPropagation(),globalThis.${HELPER_MARKER}?.(${itemVar},${copyVar},${conversationVar},${eventVar}.currentTarget)},children:(0,${jsxVar}.jsxs)("svg",{"aria-hidden":"true",viewBox:"0 0 24 24",className:"codex-linux-read-aloud-icon",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round",children:[(0,${jsxVar}.jsx)("path",{d:"M11 5 6 9H3v6h3l5 4V5z"}),(0,${jsxVar}.jsx)("path",{d:"M15 9a5 5 0 0 1 0 6"}),(0,${jsxVar}.jsx)("path",{d:"M18 6a9 9 0 0 1 0 12"})]})})`;
}

function readAloudButtonRowSource(jsxVar, itemVar, copyVar, conversationVar, eventVar) {
  return `(0,${jsxVar}.jsx)("div",{className:"codex-linux-read-aloud-row",children:${readAloudIconButtonSource(jsxVar, itemVar, copyVar, conversationVar, eventVar)}})`;
}

function applyIndexRuntimePatch(source) {
  return ensureReadAloudRuntime(source);
}

function ensureReadAloudRuntime(source) {
  if (inspectReadAloudRuntime(source).state === "patched") return source;
  return `${source}\n${readAloudRuntimeSource()}`;
}

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function inspectAssistantRenderContract(source) {
  if (assistantContractCache.has(source)) return assistantFactCopy(assistantContractCache.get(source));
  const result = inspectAssistantSource(source);
  if (assistantContractCache.size >= 4) assistantContractCache.delete(assistantContractCache.keys().next().value);
  assistantContractCache.set(source, result);
  return assistantFactCopy(result);
}

const assistantContractCache = new Map();

function assistantFactCopy(result) {
  return { ...result, candidates: result.candidates.map(row => ({ ...row, names: [...row.names], fields: new Map(row.fields) })) };
}

function inspectAssistantSource(source) {
  let candidates = [];
  try {
    const observed = assistantCalls(source);
    const roles = observed.filter(row => row.role != null);
    candidates = roles.length ? roles : observed;
    if (candidates.length !== 2 || new Set(candidates.map(row => row.role)).size !== 2 ||
        candidates.some(row => row.role == null || row.invalid)) throw new Error("Missing complete assistant render roles");
    const wrappers = candidates.map(row => assistantWrapper(source, row));
    if (wrappers.some(row => row.attempted && !row.complete)) throw new Error("Incomplete assistant wrapper contribution");
    const claims = assistantClaims(source);
    if (wrappers.every(row => row.complete)) {
      if (claims.some(index => !wrappers.some(row => row.start <= index && index < row.end))) throw new Error("Orphan assistant wrapper artifact");
      let native = source;
      for (const row of [...wrappers].reverse()) native = native.slice(0, row.start) + row.original + native.slice(row.end);
      const pristine = inspectAssistantRenderContract(native);
      if (pristine.state !== "unpatched" || assistantWriteWrappers(native, pristine.candidates) !== source) throw new Error("Drifted assistant wrapper state");
      return { ...pristine, state: "patched", candidates, nativeSource: native };
    }
    if (wrappers.some(row => row.complete) || claims.length) throw new Error("Mixed or orphan assistant wrapper state");
    return { state: "unpatched", candidates, ...assistantProducerFacts(source, candidates, observed), nativeSource: source };
  } catch (error) {
    return { state: "invalid", candidates, reason: error.message };
  }
}

function assistantModules(source) {
  return [...require("../../scripts/patches/lib/rspack-module-assets.js").rspackModuleFactories(source, "Read Aloud assistant")];
}

function assistantDelimiterEnd(source, start, lexical) {
  const pairs = { "(": ")", "[": "]", "{": "}" }, stack = [];
  if (!pairs[source[start]]) return -1;
  for (let index = start; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if (pairs[source[index]]) stack.push(pairs[source[index]]);
    else if (")]}".includes(source[index])) {
      if (stack.pop() !== source[index]) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

function assistantFields(source) {
  const lexical = createJavaScriptLexicalIndex(source), fields = new Map(), stack = [], pairs = { "(": ")", "[": "]", "{": "}" };
  let start = 0, unknown = false;
  const member = end => {
    const value = source.slice(start, end), head = /^\s*([A-Za-z_$][\w$]*)\s*:\s*/u.exec(value);
    if (value.trim()) {
      if (head == null || fields.has(head[1])) unknown = true;
      else fields.set(head[1], value.slice(head[0].length).trim());
    }
    start = end + 1;
  };
  for (let index = 0; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if (pairs[source[index]]) stack.push(pairs[source[index]]);
    else if (")]}".includes(source[index])) {
      if (stack.pop() !== source[index]) unknown = true;
    } else if (source[index] === "," && !stack.length) member(index);
  }
  member(source.length);
  return { fields, unknown: unknown || stack.length > 0 };
}

function assistantCalls(source) {
  const lexical = createJavaScriptLexicalIndex(source), rows = [];
  const pattern = /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?),\{/gu;
  for (const head of source.matchAll(pattern)) {
    if (!lexical.isCode(head.index)) continue;
    const propsOpen = head.index + head[0].length - 1, propsEnd = findMatchingBrace(source, propsOpen);
    if (propsEnd < propsOpen) continue;
    const text = source.slice(propsOpen + 1, propsEnd);
    if (!text.includes("assistantCopyText")) continue;
    const { fields, unknown } = assistantFields(text);
    if (!["item", "assistantCopyText", "conversationId"].every(name => fields.has(name))) continue;
    const callOpen = head.index + head[0].lastIndexOf("("), callEnd = assistantDelimiterEnd(source, callOpen, lexical);
    if (callEnd < propsEnd) continue;
    const names = [...fields.keys()];
    let role = null;
    if (ASSISTANT_RENDER_SHARED_PROPS.every(name => fields.has(name))) {
      if (fields.has("sourceTurnId") && !fields.has("turnId")) role = "source-turn";
      else if (!fields.has("sourceTurnId") && ASSISTANT_RENDER_LIVE_PROPS.every(name => fields.has(name))) role = "live-turn";
    }
    const values = [fields.get("item"), fields.get("assistantCopyText"), fields.get("conversationId")];
    rows.push({ start: head.index, end: callEnd + 1, match: source.slice(head.index, callEnd + 1), component: head[2],
      jsxVar: head[1], role, fields, names, invalid: unknown || values.some(value => !/^[A-Za-z_$][\w$]*$/u.test(value)),
      itemVar: values[0], copyVar: values[1], conversationVar: values[2] });
  }
  return rows;
}

function assistantCallableScopes(source) {
  const lexical = createJavaScriptLexicalIndex(source), parentheses = new Map(), stack = [], scopes = [];
  for (let index = 0; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if (source[index] === "(") stack.push(index);
    else if (source[index] === ")") parentheses.set(index, stack.pop());
  }
  for (let open = 0; open < source.length; open++) {
    if (source[open] !== "{" || !lexical.isCode(open)) continue;
    const prefix = source.slice(0, open).trimEnd(), close = prefix.length - 1;
    const parameters = prefix[close] === ")" ? parentheses.get(close) : null;
    const before = parameters == null ? "" : source.slice(0, parameters).trimEnd();
    if (prefix.endsWith("=>") || /\bstatic$/u.test(prefix) || parameters != null && !/\b(?:if|for|while|switch|with|catch)\s*$/u.test(before)) {
      scopes.push({ start: open, end: lexical.matchingBrace(open) });
    }
  }
  for (const arrow of source.matchAll(/=>/gu)) {
    if (!lexical.isCode(arrow.index)) continue;
    let start = arrow.index + 2;
    while (/\s/u.test(source[start] ?? "")) start++;
    if (source[start] === "{") continue;
    let end = start, depth = 0;
    for (; end < source.length; end++) {
      if (!lexical.isCode(end)) continue;
      if ("([{".includes(source[end])) depth++;
      else if (")]}".includes(source[end])) { if (!depth) break; depth--; }
      else if (!depth && /[,;]/u.test(source[end])) break;
    }
    scopes.push({ start, end });
  }
  return scopes;
}

function assistantBindingProbe(module, name, declarationStart, exportName = "F") {
  const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
  const publication = findRspackExportPublication(module, exportName);
  if (publication?.expression == null || module.params.includes(name)) throw new Error("Unsupported assistant readonly binding");
  const body = module.moduleSource;
  const calls = runtimeMatches(body, new RegExp(`(?<![\\w$.])${escapeRegExp(publication.requireName)}\\.d\\(${escapeRegExp(publication.exportsName)},\\{`, "gu"), true);
  if (calls.length !== 1 || body.slice(declarationStart, declarationStart + name.length) !== name) throw new Error("Assistant binding preimage is ambiguous");
  const exportsStart = calls[0].index + calls[0][0].indexOf("(") + 1;
  let probeName = "__codexAssistantBindingProbe";
  while (body.includes(probeName)) probeName += "$";
  const edits = [
    { start: declarationStart, end: declarationStart + name.length, before: name, after: probeName },
    { start: exportsStart, end: exportsStart + publication.exportsName.length, before: publication.exportsName, after: name },
  ].sort((a, b) => b.start - a.start);
  if (edits[1].end > edits[0].start) throw new Error("Assistant binding proof ranges overlap");
  let projected = body;
  for (const edit of edits) {
    if (body.slice(edit.start, edit.end) !== edit.before) throw new Error("Assistant binding proof preimage changed");
    projected = projected.slice(0, edit.start) + edit.after + projected.slice(edit.end);
  }
  const result = findRspackExportPublication({ moduleSource: projected, params: [module.params[0], name, module.params[2]] }, exportName);
  if (result?.exportsName !== name || result.requireName !== publication.requireName || result.expression !== publication.expression) throw new Error("Assistant binding is reassigned or redeclared");
  return { edits, projected, result };
}

function assistantRootFunction(module, name, readonly = true, exportName = "F") {
  if (!/^[A-Za-z_$][\w$]*$/u.test(name ?? "")) throw new Error("Assistant publication is not a native function identifier");
  const heads = runtimeMatches(module.moduleSource, new RegExp(`\\bfunction ${escapeRegExp(name)}\\(([^()]*)\\)\\{`, "gu"), true);
  const head = runtimeOne(heads, "published assistant function");
  const open = head.index + head[0].length - 1, end = findMatchingBrace(module.moduleSource, open);
  if (readonly) assistantBindingProbe(module, name, head.index + "function ".length, exportName);
  return { name, params: head[1], open: module.start + open, end: module.start + end,
    source: module.moduleSource.slice(head.index, end + 1), body: module.moduleSource.slice(open + 1, end) };
}

function assistantImport(module, name) {
  const binding = require("../../scripts/patches/lib/rspack-module-assets.js").findRspackRequireBinding(module, name);
  if (binding == null) throw new Error("Assistant namespace is not a native static import");
  assistantBindingProbe(module, name, binding.start - module.start);
  return binding;
}

function assistantProducerFacts(source, candidates, observed) {
  const modules = assistantModules(source), owner = modules.filter(module => candidates.every(row => module.start <= row.start && row.end <= module.end));
  if (owner.length !== 1) throw new Error("Assistant roles do not share one native factory");
  const module = owner[0], publication = require("../../scripts/patches/lib/rspack-export-publication.js").findRspackExportPublication(module, "F");
  if (publication == null || module.params.includes("globalThis")) throw new Error("Missing assistant producer publication");
  const producer = assistantRootFunction(module, publication.expression), scopes = assistantCallableScopes(source);
  if (observed.some(row => !candidates.includes(row) && producer.open < row.start && row.end < producer.end)) throw new Error("Additional assistant-shaped call in the native producer");
  for (const row of candidates) {
    const enclosing = scopes.filter(scope => scope.start < row.start && row.end <= scope.end).sort((a, b) => b.start - a.start)[0];
    if (row.start <= producer.open || row.end >= producer.end || enclosing?.start !== producer.open) throw new Error("Assistant call is outside its published producer");
  }
  const first = candidates[0];
  if (candidates.some(row => row.jsxVar !== first.jsxVar || row.component !== first.component)) throw new Error("Assistant role namespaces disagree");
  const component = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/u.exec(first.component);
  if (component == null) throw new Error("Assistant component is not a native namespace member");
  const jsx = assistantImport(module, first.jsxVar), imported = assistantImport(module, component[1]);
  const shadowed = runtimeBindingScopes(module.moduleSource, module.moduleSource, createJavaScriptLexicalIndex(module.moduleSource));
  if (candidates.some(row => [first.jsxVar, component[1], "globalThis"].some(name => shadowed(name, row.start - module.start)))) throw new Error("Assistant producer shadows a captured binding");
  const componentCopies = modules.filter(row => row.moduleId === imported.moduleId);
  if (componentCopies.length !== 1) throw new Error("Missing native assistant component registration");
  const render = assistantComponentFacts(componentCopies[0], component[2]);
  return { moduleId: module.moduleId, componentId: imported.moduleId, componentExport: component[2], jsxId: jsx.moduleId,
    producerName: producer.name, componentName: render.name, producerStart: producer.open, producerEnd: producer.end };
}

function assistantComponentFacts(nativeComponent, exportName) {
  const published = require("../../scripts/patches/lib/rspack-export-publication.js").findRspackExportPublication(nativeComponent, exportName);
  if (published == null) throw new Error("Missing native assistant component export");
  const render = assistantRootFunction(nativeComponent, published.expression, true, exportName), bodyLexical = createJavaScriptLexicalIndex(render.body);
  const destructures = [];
  for (let open = 0; open < render.body.length; open++) {
    if (render.body[open] !== "{" || !bodyLexical.isRoot(open)) continue;
    const end = bodyLexical.matchingBrace(open);
    if (new RegExp(`^=${escapeRegExp(render.params)}(?=[,;])`, "u").test(render.body.slice(end + 1))) destructures.push(assistantFields(render.body.slice(open + 1, end)));
  }
  if (destructures.length !== 1 || destructures[0].unknown ||
      ![...ASSISTANT_RENDER_SHARED_PROPS, "sourceTurnId", "turnId", "isReadOnly"].every(name => destructures[0].fields.has(name))) throw new Error("Native assistant component props changed");
  return render;
}

function assistantWrapperPrefix(row) {
  const prefix = `/*codex-linux-read-aloud-assistant:${row.role}*/`;
  const child = "codexLinuxReadAloudChild";
  return prefix + `(${child}=>(0,${row.jsxVar}.jsxs)(${row.jsxVar}.Fragment,{children:[${child},` +
    readAloudButtonRowSource(row.jsxVar, child + ".props.item", child + ".props.assistantCopyText", child + ".props.conversationId", "codexLinuxReadAloudEvent") + "]}))(";
}

function assistantReplacement(row) {
  return assistantWrapperPrefix(row) + row.match + ")";
}

function assistantWrapper(source, row) {
  const bare = `(0,${row.jsxVar}.jsxs)(${row.jsxVar}.Fragment,{children:[`;
  const prefix = assistantWrapperPrefix(row);
  const replacement = assistantReplacement(row), start = row.start - prefix.length, end = start + replacement.length;
  return { start, end, original: row.match, complete: source.slice(start, end) === replacement,
    attempted: source.slice(row.start - bare.length, row.start) === bare };
}

function assistantClaims(source) {
  if (!source.includes("codexLinuxReadAloud") && !source.includes("codex-linux-read-aloud") && !source.includes("\\u") && !source.includes("\\x")) return [];
  const lexical = createJavaScriptLexicalIndex(source), claims = [];
  const decode = value => value.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, a, b) => String.fromCodePoint(parseInt(a || b, 16))).replace(/\\x([0-9a-fA-F]{2})/gu, (_, value) => String.fromCharCode(parseInt(value, 16)));
  const ownRuntime = inspectReadAloudRuntime(source);
  const runtimeStart = ownRuntime.state === "patched" ? source.indexOf(readAloudRuntimeSource()) : -1;
  const ignored = index => runtimeStart >= 0 && runtimeStart <= index && index < runtimeStart + readAloudRuntimeSource().length;
  for (const token of source.matchAll(/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu)) {
    if (!lexical.isCode(token.index) || ignored(token.index) || /^\s*:/u.test(source.slice(token.index + token[0].length))) continue;
    const name = decode(token[0]);
    if (name === HELPER_MARKER || name === "codexLinuxReadAloudEvent" || name === "codexLinuxReadAloudChild") claims.push(token.index);
  }
  for (const match of source.matchAll(/\bclassName\s*:\s*(["'`])((?:\\.|[^\\])*?)\1/gu)) {
    if (lexical.isCode(match.index) && !ignored(match.index) && /^codex-linux-read-aloud-(?:row|button|icon)$/u.test(decode(match[2]))) claims.push(match.index);
  }
  for (const match of source.matchAll(/\[\s*(["'`])((?:\\.|[^\\])*?)\1\s*\]/gu)) {
    if (lexical.isCode(match.index) && !ignored(match.index) && decode(match[2]) === HELPER_MARKER) claims.push(match.index);
  }
  for (const match of source.matchAll(/\/\*codex-linux-read-aloud-assistant:(?:source-turn|live-turn)\*\/(?=\([A-Za-z_$][\w$]*=>)/gu)) {
    if (lexical.isCode(match.index + match[0].length)) claims.push(match.index);
  }
  return claims;
}

function assistantWriteWrappers(source, candidates) {
  let result = source;
  for (const row of [...candidates].reverse()) result = result.slice(0, row.start) + assistantReplacement(row) + result.slice(row.end);
  return result;
}

function applyAssistantRenderPatch(source) {
  const contract = inspectAssistantRenderContract(source);
  if (contract.state === "patched") return source;
  if (contract.state !== "unpatched") {
    if (contract.candidates.length || assistantClaims(source).length) warn("Could not find complete assistant message render call set", "read aloud assistant render patch");
    return source;
  }
  const patched = assistantWriteWrappers(source, contract.candidates);
  if (inspectAssistantRenderContract(patched).state !== "patched") throw new Error("Assistant wrapper poststate is incomplete");
  return patched;
}

function assistantModuleCopies(extractedDir, moduleId) {
  const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
  return findUniqueRspackModuleCopies(path.join(extractedDir, "webview/assets"), {
    sourceMatch: source => source.includes(moduleId),
    matchModule: (_body, copy) => copy.moduleId === moduleId,
    description: "Read Aloud assistant dependency " + moduleId,
  });
}

function assistantJsxStaticName(value) {
  return value.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([^\r\n]))/gu,
    (_, braced, fixed, hex, escaped) => braced || fixed || hex ? String.fromCodePoint(parseInt(braced || fixed || hex, 16)) :
      ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" }[escaped] ?? escaped));
}

function assistantJsxSkipTrivia(source, start) {
  return start + /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*/u.exec(source.slice(start))[0].length;
}

function assistantJsxStaticString(source, start) {
  const quoted = /^(["'`])((?:\\.|[^\\\n])*?)\1/u.exec(source.slice(start));
  if (quoted == null || quoted[1] === "`" && quoted[2].includes("${")) return null;
  return { name: assistantJsxStaticName(quoted[2]), end: start + quoted[0].length };
}

function assistantJsxStaticPath(source, start) {
  let cursor = assistantJsxSkipTrivia(source, start);
  while (source[cursor] === "(") cursor = assistantJsxSkipTrivia(source, cursor + 1);
  const head = /^[A-Za-z_$][\w$]*/u.exec(source.slice(cursor));
  if (head == null) return null;
  const index = cursor, members = [];
  cursor += head[0].length;
  while (true) {
    cursor = assistantJsxSkipTrivia(source, cursor);
    while (source[cursor] === ")") cursor = assistantJsxSkipTrivia(source, cursor + 1);
    if (source.startsWith("?.", cursor)) cursor = assistantJsxSkipTrivia(source, cursor + 2);
    else if (source[cursor] === ".") cursor = assistantJsxSkipTrivia(source, cursor + 1);
    else if (source[cursor] !== "[") break;
    if (source[cursor] === "[") {
      const property = assistantJsxStaticString(source, assistantJsxSkipTrivia(source, cursor + 1));
      if (property == null) return null;
      cursor = assistantJsxSkipTrivia(source, property.end);
      if (source[cursor] !== "]") return null;
      members.push(property.name); cursor++;
    } else {
      const property = /^[A-Za-z_$][\w$]*/u.exec(source.slice(cursor));
      if (property == null) break;
      members.push(property[0]); cursor += property[0].length;
    }
  }
  return { head: head[0], index, members, end: cursor };
}

function assistantJsxSymbolAuthority(copy) {
  if (typeof copy.source !== "string") throw new Error("Native JSX delegate chunk is unavailable");
  const original = copy.source, originalLexical = createJavaScriptLexicalIndex(original);
  // This equal-length parse view preserves the complete chunk and its lexical
  // environment. Only native declaration-export keywords are masked.
  const script = original.replace(/\bexport(?=\s+(?:const|let|var)\b)/gu, (text, index) =>
    originalLexical.isRoot(index) ? " ".repeat(text.length) : text);
  try { new Script('"use strict";\n' + script); }
  catch { throw new Error("Unsupported native JSX delegate chunk syntax"); }
  runtimeAssertRootBinding(script, "Symbol", []);
  const scriptLexical = createJavaScriptLexicalIndex(script);
  const source = script.replace(/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu,
    (token, index) => scriptLexical.isCode(index) ? assistantJsxStaticName(token) : token);
  const lexical = createJavaScriptLexicalIndex(source), shadowed = runtimeBindingScopes(source, source, lexical);
  const global = name => ["globalThis", "window", "self"].includes(name);
  const relevant = target => target.head === "Symbol" && target.members.length <= 1 &&
    (target.members.length === 0 || target.members[0] === "for") || global(target.head) &&
    target.members[0] === "Symbol" && (target.members.length === 1 || target.members.length === 2 && target.members[1] === "for");
  for (const token of source.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/gu)) {
    if (!lexical.isCode(token.index) || !["Symbol", "globalThis", "window", "self", "Object", "Reflect"].includes(token[0])) continue;
    const target = assistantJsxStaticPath(source, token.index);
    if (target == null || shadowed(target.head, target.index)) continue;
    const prefix = source.slice(0, target.index), suffix = source.slice(target.end);
    const prefixWrite = /(?:\bdelete|\+\+|--)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n|\()*$/u.test(prefix);
    if (relevant(target) && (runtimeStartsWrite(suffix) || prefixWrite || runtimePatternWrites(source, target.index, target.end, lexical))) {
      throw new Error("Native JSX Symbol authority is explicitly modified");
    }
    const method = target.members[0];
    if (target.members.length !== 1 || !(target.head === "Object" && method === "defineProperty" ||
        target.head === "Reflect" && ["defineProperty", "deleteProperty", "set"].includes(method)) || source[target.end] !== "(") continue;
    const receiver = assistantJsxStaticPath(source, target.end + 1);
    if (receiver == null || shadowed(receiver.head, receiver.index) || source[receiver.end] !== ",") continue;
    const property = assistantJsxStaticString(source, assistantJsxSkipTrivia(source, receiver.end + 1));
    if (property == null) continue;
    const changed = { ...receiver, members: [...receiver.members, property.name] };
    if (relevant(changed)) throw new Error("Native JSX Symbol authority is statically redefined");
  }
}

function assistantJsxDelegate(copy) {
  assistantJsxSymbolAuthority(copy);
  const id = "[A-Za-z_$][\\w$]*", body = copy.moduleSource, out = escapeRegExp(copy.params[1] ?? "");
  if (copy.params.length !== 2 || new Set(copy.params).size !== 2 || copy.params.includes("Symbol")) throw new Error("Unsupported native JSX delegate parameters");
  const symbol = runtimeOne(runtimeMatches(body, new RegExp(`^var (${id})=Symbol\\.for\\("react\\.transitional\\.element"\\);`, "gu"), true), "native JSX element symbol")[1];
  const published = runtimeOne(runtimeMatches(body, new RegExp(`${out}\\.Fragment=Symbol\\.for\\("react\\.fragment"\\),${out}\\.jsx=(${id}),${out}\\.jsxs=\\1$`, "gu"), true), "native JSX public ABI");
  const fn = assistantRootFunction(copy, published[1], false), parameters = fn.params.split(",");
  if (parameters.length !== 3 || parameters.some(name => !new RegExp(`^${id}$`, "u").test(name))) throw new Error("Unsupported native JSX function signature");
  const key = /^var ([\w$]+)=null;/u.exec(fn.body)?.[1];
  const loop = /for\(var ([\w$]+) in /u.exec(fn.body)?.[1];
  const [component, props, explicitKey] = parameters;
  if (!key || !loop || new Set([symbol, ...parameters, key, loop]).size !== 6 ||
      new Set([...copy.params, symbol, fn.name]).size !== 4 || [symbol, fn.name].includes("Symbol")) throw new Error("Native JSX ABI binding collision");
  const expected = `var ${symbol}=Symbol.for("react.transitional.element");function ${fn.name}(${parameters.join(",")}){` +
    `var ${key}=null;if(void 0!==${explicitKey}&&(${key}=""+${explicitKey}),void 0!==${props}.key&&(${key}=""+${props}.key),"key"in ${props})` +
    `for(var ${loop} in ${explicitKey}={},${props})"key"!==${loop}&&(${explicitKey}[${loop}]=${props}[${loop}]);else ${explicitKey}=${props};` +
    `return{$$typeof:${symbol},type:${component},key:${key},ref:void 0!==(${props}=${explicitKey}.ref)?${props}:null,props:${explicitKey}}}` +
    `${copy.params[1]}.Fragment=Symbol.for("react.fragment"),${copy.params[1]}.jsx=${fn.name},${copy.params[1]}.jsxs=${fn.name}`;
  if (body !== expected) throw new Error("Native JSX delegate semantics changed");
}

function assistantJsxFacts(extractedDir, moduleId, include) {
  const facades = assistantModuleCopies(extractedDir, moduleId), delegates = new Set();
  for (const copy of facades) {
    if (copy.params.length !== 3 || new Set(copy.params).size !== 3) throw new Error("Unsupported native JSX facade parameters");
    const shape = new RegExp(`^${escapeRegExp(copy.params[0])}\\.exports=${escapeRegExp(copy.params[2])}\\("([A-Za-z0-9_$]+)"\\)$`, "u").exec(copy.moduleSource);
    if (shape == null) throw new Error("Native JSX facade changed");
    delegates.add(shape[1]); include(copy.assetName, copy.source);
  }
  if (delegates.size !== 1) throw new Error("Native JSX facades disagree");
  for (const copy of assistantModuleCopies(extractedDir, [...delegates][0])) {
    assistantJsxDelegate(copy); include(copy.assetName, copy.source);
  }
}

function assistantRuntimeDependencies(read) {
  const roles = [];
  for (const html of ["webview/index.html", "webview/detached-window.html"]) {
    const scripts = runtimeHtmlScripts(read(html)), entries = [];
    for (const name of scripts) {
      const text = read(name);
      if (RUNTIME_ENTRY_EXPORT.test(text) || runtimeOwnClaims(text).length) entries.push({ name, text,
        native: inspectRuntimeEntry(text), own: inspectReadAloudRuntime(text) });
    }
    const owner = runtimeOne(entries, "assistant host runtime entry");
    if (owner.own.state !== "patched") throw new Error("Assistant requires the complete Read Aloud runtime");
    const chunks = new Set(), modules = new Set(owner.native.bootstrapModules);
    for (const imported of owner.native.imports) {
      if (!/^\.\/[A-Za-z0-9_./-]+\.js$/u.test(imported) || imported.split("/").some(part => part === "..")) throw new Error("Unsupported assistant runtime dependency");
      const name = path.posix.normalize(path.posix.join(path.posix.dirname(owner.name), imported));
      if (!scripts.includes(name)) throw new Error("Assistant runtime dependency is outside its HTML edge");
      const facts = runtimeDependencyFacts(read(name)); facts.chunks.forEach(id => chunks.add(id)); facts.modules.forEach(id => modules.add(id));
    }
    if (owner.native.chunks.some(id => !chunks.has(id)) || !modules.has(owner.native.startupId)) throw new Error("Assistant runtime startup is unavailable");
    roles.push(owner);
  }
  if (new Set(roles.map(row => row.name)).size !== 2) throw new Error("Assistant runtime window roles overlap");
  return roles;
}

function applyAssistantToExtractedApp(extractedDir, options = {}) {
  const digest = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const names = runtimeAssetNames(extractedDir), hashes = new Map(), snapshots = new Map(), ownRuntime = [], ownAssistant = [];
  const read = name => {
    if (!snapshots.has(name)) {
      let file = extractedDir;
      const parts = name.split("/");
      for (const [index, part] of parts.entries()) {
        file = path.join(file, part); const stat = fs.lstatSync(file);
        if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error("Assistant dependency path is not regular");
      }
      const source = fs.readFileSync(file, "utf8"), hash = digest(source);
      if (hashes.has(name) && hashes.get(name) !== hash) throw new Error("Assistant dependency changed during qualification");
      hashes.set(name, hash); snapshots.set(name, source);
    }
    return snapshots.get(name);
  };
  for (const name of names) {
    const source = fs.readFileSync(path.join(extractedDir, name), "utf8"); hashes.set(name, digest(source));
    if (runtimeOwnClaims(source).length) ownRuntime.push(name);
    if (assistantClaims(source).length) ownAssistant.push(name);
  }
  const runtime = assistantRuntimeDependencies(read);
  if (ownRuntime.some(name => !runtime.some(row => row.name === name))) throw new Error("Orphan assistant host runtime");
  const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
  const copies = findUniqueRspackModuleCopies(path.join(extractedDir, "webview/assets"), {
    sourceMatch: source => source.includes("assistantCopyText"),
    matchModule: body => new Set(assistantCalls(body).filter(row => row.role != null).map(row => row.role)).size === 2,
    description: "published primary-thread assistant producer",
  });
  const owners = new Set(copies.map(copy => "webview/assets/" + copy.assetName));
  if (ownAssistant.some(name => !owners.has(name) && !runtime.some(row => row.name === name))) throw new Error("Assistant wrapper artifact escaped its owner");
  const states = copies.map(copy => {
    const name = "webview/assets/" + copy.assetName;
    if (read(name) !== copy.source) throw new Error("Assistant owner changed during qualification");
    const state = inspectAssistantRenderContract(copy.source);
    if (state.state === "invalid") throw new Error(state.reason);
    return state;
  });
  if (new Set(states.map(row => row.state)).size !== 1 || new Set(states.map(row => row.componentId)).size !== 1 ||
      new Set(states.map(row => row.jsxId)).size !== 1) throw new Error("Mixed assistant producer cohort");
  const include = (assetName, source) => {
    if (read("webview/assets/" + assetName) !== source) throw new Error("Assistant registration changed during qualification");
  };
  for (const copy of assistantModuleCopies(extractedDir, states[0].componentId)) {
    include(copy.assetName, copy.source);
    assistantComponentFacts(copy, states[0].componentExport);
  }
  assistantJsxFacts(extractedDir, states[0].jsxId, include);
  const outputs = new Map(copies.map(copy => ["webview/assets/" + copy.assetName, applyAssistantAssetPatch(copy.source)]));
  const verify = () => {
    if (JSON.stringify(runtimeAssetNames(extractedDir)) !== JSON.stringify(names)) throw new Error("Assistant asset inventory changed before commit");
    for (const [name, hash] of hashes) if (digest(fs.readFileSync(path.join(extractedDir, name))) !== hash) throw new Error("Assistant dependency changed before commit: " + name);
  };
  verify();
  const edits = [...snapshots].map(([assetName, source]) => ({ assetName, source, patchedSource: outputs.get(assetName) ?? source }));
  const original = new Map(edits.map(edit => [path.join(extractedDir, edit.assetName), Buffer.from(edit.source)]));
  const result = commitMainEdits(extractedDir, edits, { ...options, writeFileSync(file, bytes) {
    const restoring = original.get(file)?.equals(bytes);
    if (!restoring) verify();
    (options.writeFileSync ?? fs.writeFileSync)(file, bytes);
    if (!restoring) hashes.set(path.relative(extractedDir, file).split(path.sep).join("/"), digest(bytes));
  } });
  return { matched: 1, ...result, moduleId: copies[0].moduleId, copies: copies.length };
}

// The webview runtime is appended to the rspack runtime entry chunks: the
// chunks that own the chunked host-message decoder and export the webpack
// require function. The main window and detached windows each load one.
const RUNTIME_ENTRY_NEEDLES = ["codex-host-chunked-message-v1", "as __webpack_require__}"];
const RUNTIME_ENTRY_EXPORT = /export\{[A-Za-z_$][\w$]* as __webpack_require__\}/;

const READ_ALOUD_RUNTIME_GLOBALS = ["codexLinuxReadAloudVersion", "codexLinuxReadAloudClick", "codexLinuxReadAloudSetup", "codexLinuxReadAloudMountSettings", "codexLinuxReadAloudGetSetting", "codexLinuxReadAloudSetSetting"];
const READ_ALOUD_WRITE_OPERATORS = ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "&&=", "||=", "??=", "++", "--"];
const readAloudDependencyFacts = new Map();

function runtimeStartsWrite(source) {
  const suffix = source.replace(/^\s*(?:\)\s*)*/u, "");
  return READ_ALOUD_WRITE_OPERATORS.some(operator => suffix.startsWith(operator) &&
    (operator !== "=" || suffix[1] !== "=" && suffix[1] !== ">"));
}

function runtimePatternWrites(source, start, end, lexical) {
  if (!/^\s*(?:\)\s*)*[,}\]]/u.test(source.slice(end))) return false;
  // Keep parentheses around a complete member outside the replacement range.
  // Parentheses that form its receiver stay part of the assignment target.
  while (source[start] === "(") {
    let depth = 0, close = -1;
    for (let index = start; index < source.length; index++) {
      if (!lexical.isCode(index)) continue;
      if (source[index] === "(") depth++;
      else if (source[index] === ")" && --depth === 0) { close = index; break; }
    }
    if (close < end) break;
    start++;
    while (/\s/u.test(source[start] ?? "") && start < source.length) start++;
  }
  const opened = [], patterns = [];
  for (let index = 0; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if (source[index] === "[" || source[index] === "{") opened.push(index);
    else if (source[index] === "]" || source[index] === "}") {
      const open = opened.pop();
      if (open < start && index >= end) patterns.push({ open, close: index });
    }
  }
  for (const { open, close } of patterns) {
    const tail = source.slice(close + 1).replace(/^\s*(?:\)\s*)*/u, "");
    const assignment = tail.startsWith("=") && tail[1] !== "=" && tail[1] !== ">";
    const iteration = /^(?:of|in)\b/u.test(tail) && /\bfor(?:\s+await)?\s*\(\s*$/u.test(source.slice(0, open));
    if (!assignment && !iteration) continue;
    const pattern = source.slice(open, close + 1);
    const replaced = source.slice(open, start) + "(0)" + source.slice(end, close + 1);
    const probe = value => assignment ? `(${value}=null)` : `for(${value} of []){}`;
    try { new Script(probe(pattern)); } catch { continue; }
    try { new Script(probe(replaced)); } catch { return true; }
  }
  return false;
}

function runtimeMatches(source, pattern, root = false) {
  const lexical = createJavaScriptLexicalIndex(source);
  return [...source.matchAll(pattern)].filter(match => lexical.isCode(match.index) && (!root || lexical.isRoot(match.index)));
}

function runtimeOne(values, reason) {
  if (values.length !== 1) throw new Error(`${reason} matched ${values.length} times`);
  return values[0];
}

function runtimeOwnClaims(source) {
  const identifier = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu;
  const decode = token => token.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
  if (!source.includes("codexLinuxReadAloud") && !source.includes(RUNTIME_VERSION) &&
      !source.includes("\\u") && !source.includes("\\x")) return [];
  const lexical = createJavaScriptLexicalIndex(source), claims = [];
  const destructive = (start, end) => runtimeStartsWrite(source.slice(end)) ||
    /(?:\bdelete|\+\+|--)\s*\(*\s*(?:(?:globalThis|window|self)\s*\)*\s*(?:\?\.|\.)\s*)?$/u.test(source.slice(0, start));
  for (const token of source.matchAll(identifier)) {
    if (!lexical.isCode(token.index)) continue;
    const decoded = decode(token[0]);
    if (!READ_ALOUD_RUNTIME_GLOBALS.includes(decoded)) continue;
    const receiver = /(?:\(+\s*)?(?:globalThis|window|self)\s*\)*\s*(?:\?\.|\.)\s*$/u.exec(source.slice(0, token.index));
    if (destructive(token.index, token.index + token[0].length) || receiver && runtimePatternWrites(source, receiver.index, token.index + token[0].length, lexical)) claims.push(token.index);
  }
  for (const match of source.matchAll(/(?:\(+\s*)?(?:globalThis|window|self)\s*\)*\s*(?:\?\.)?\s*\[\s*(["'`])((?:\\.|[^\\\n])*?)\1\s*\]/gu)) {
    if (!lexical.isCode(match.index)) continue;
    const name = decode(match[2]).replace(/\\x([0-9a-fA-F]{2})/gu, (_, value) => String.fromCharCode(parseInt(value, 16)));
    if (READ_ALOUD_RUNTIME_GLOBALS.includes(name) && (destructive(match.index, match.index + match[0].length) || runtimePatternWrites(source, match.index, match.index + match[0].length, lexical))) claims.push(match.index);
  }
  for (const match of source.matchAll(/\bconst VERSION="kokoro-explicit-v6"/gu)) {
    if (lexical.isCode(match.index)) claims.push(match.index);
  }
  for (const match of source.matchAll(/(?:Object\s*\.\s*defineProperty|Reflect\s*\.\s*(?:defineProperty|deleteProperty|set))\s*\(\s*(?:globalThis|window|self)\s*,\s*(["'`])((?:\\.|[^\\\n])*?)\1/gu)) {
    if (!lexical.isCode(match.index)) continue;
    const name = decode(match[2]).replace(/\\x([0-9a-fA-F]{2})/gu, (_, value) => String.fromCharCode(parseInt(value, 16)));
    if (READ_ALOUD_RUNTIME_GLOBALS.includes(name)) claims.push(match.index);
  }
  return claims;
}

function inspectReadAloudRuntime(source) {
  const expected = readAloudRuntimeSource(), lexical = createJavaScriptLexicalIndex(source), blocks = [];
  for (let index = source.indexOf(expected); index >= 0; index = source.indexOf(expected, index + 1)) {
    if (lexical.isCode(index)) blocks.push({ start: index, end: index + expected.length, root: lexical.isRoot(index) });
  }
  const claims = runtimeOwnClaims(source);
  if (blocks.length === 0 && claims.length === 0) return { state: "current" };
  if (blocks.length !== 1 || !blocks[0].root || claims.some(index => index < blocks[0].start || index >= blocks[0].end)) {
    throw new Error("Incomplete, duplicate or misplaced Read Aloud runtime");
  }
  return { state: "patched", block: blocks[0] };
}

function runtimeBindingScopes(source, script, lexical) {
  const parentheses = new Map(), stack = [], scopes = [];
  let probeName = "__codexReadAloudScopeProbe";
  while (source.includes(probeName)) probeName += "_";
  const parses = text => { try { new Script('"use strict";\n' + text); return true; } catch { return false; } };
  const parameterShadows = (parameters, name) => parses(`function probe(${parameters}){let ${probeName};}`) &&
    !parses(`function probe(${parameters}){let ${name};}`);
  for (let index = 0; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if (source[index] === "(") stack.push(index);
    else if (source[index] === ")") parentheses.set(index, stack.pop());
  }
  for (let open = 0; open < source.length; open++) {
    if (source[open] !== "{" || !lexical.isCode(open)) continue;
    const end = lexical.matchingBrace(open);
    if (end < 0) continue;
    const prefix = source.slice(0, open).trimEnd(), close = prefix.length - 1;
    const parameterOpen = prefix[close] === ")" ? parentheses.get(close) : null;
    const beforeParameters = parameterOpen == null ? "" : source.slice(0, parameterOpen).trimEnd();
    const control = /\b(if|for|while|switch|with)\s*$/u.test(beforeParameters);
    const functionScope = prefix.endsWith("=>") || /\bstatic$/u.test(prefix) || parameterOpen != null && !control;
    const namedFunction = /\bfunction\s*\*?\s*([\w$]+)\s*$/u.exec(beforeParameters);
    const expressionName = namedFunction && /(?:[=(:,\[]|\breturn)\s*$/u.test(beforeParameters.slice(0, namedFunction.index)) ? namedFunction[1] : null;
    const insertion = script.slice(0, open + 1), remainder = script.slice(open + 1);
    let validBlock;
    const shadows = name => {
      if (expressionName === name) return true;
      if (validBlock == null) validBlock = parses(insertion + `let ${probeName};` + remainder);
      if (!validBlock || parses(insertion + `let ${name};` + remainder)) return false;
      return functionScope || !parses(insertion + `var ${name};` + remainder);
    };
    scopes.push({ start: open, end, shadows });
    if (expressionName) scopes.push({ start: namedFunction.index, end, shadows: name => name === expressionName });
    if (parameterOpen != null && functionScope) scopes.push({ start: parameterOpen, end: open, shadows: name => parameterShadows(source.slice(parameterOpen + 1, close), name) });
    if (parameterOpen != null && /\bfor\s*$/u.test(beforeParameters)) {
      const header = source.slice(parameterOpen + 1, close);
      const separator = [...header.matchAll(/;|\b(?:of|in)\b/gu)].find(match => lexical.isCode(parameterOpen + 1 + match.index));
      const declaration = separator == null ? "" : header.slice(0, separator.index) + (separator[0] === ";" ? "" : "=null");
      if (/^\s*(?:let|const)\s/u.test(declaration)) scopes.push({ start: parameterOpen, end, shadows: name =>
        parses(`function probe(){${declaration};let ${probeName};}`) && !parses(`function probe(){${declaration};let ${name};}`) });
    }
  }
  for (const arrow of source.matchAll(/=>/gu)) {
    if (!lexical.isCode(arrow.index)) continue;
    const prefix = source.slice(0, arrow.index).trimEnd(), close = prefix.length - 1;
    const parameterOpen = prefix[close] === ")" ? parentheses.get(close) : null;
    const single = /([A-Za-z_$][\w$]*)$/u.exec(prefix);
    const parameters = parameterOpen == null ? single?.[1] : source.slice(parameterOpen + 1, close);
    if (parameters == null) continue;
    let body = arrow.index + 2;
    while (/\s/u.test(source[body] ?? "") && body < source.length) body++;
    let end = body, depth = 0;
    if (source[body] === "{") end = lexical.matchingBrace(body);
    else for (; end < source.length; end++) {
      if (!lexical.isCode(end)) continue;
      const char = source[end];
      if ("([{".includes(char)) depth++;
      else if (")]}".includes(char)) { if (depth === 0) break; depth--; }
      else if (depth === 0 && (char === "," || char === ";")) break;
    }
    scopes.push({ start: parameterOpen ?? prefix.length - parameters.length, end, shadows: name => parameterShadows(parameters, name) });
  }
  return (name, index) => scopes.some(scope => scope.start <= index && index < scope.end && scope.shadows(name));
}

function runtimeAssertRootBinding(source, name, authorized) {
  const lexical = createJavaScriptLexicalIndex(source);
  let script = source;
  const masked = runtimeMatches(source, /\b(?:import\*as [\w$]+ from"[^"\n]+";|export\{[^}]+\};)/gu, true);
  for (const match of [...masked].reverse()) script = script.slice(0, match.index) + " ".repeat(match[0].length) + script.slice(match.index + match[0].length);
  script = script.replace(/import\.meta/gu, (value, index) => lexical.isCode(index) ? "({})       " : value);
  const shadowed = runtimeBindingScopes(source, script, lexical);
  const parsesReplacement = (match, replacement) => {
    try { new Script('"use strict";\n' + script.slice(0, match.index) + replacement + script.slice(match.index + match[0].length)); return true; }
    catch { return false; }
  };
  const references = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu;
  for (const match of source.matchAll(references)) {
    if (!lexical.isCode(match.index) || /[\w$.]/u.test(source[match.index - 1] ?? "")) continue;
    const decoded = match[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
    if (decoded !== name || authorized.includes(match.index) || masked.some(row => row.index <= match.index && match.index < row.index + row[0].length)) continue;
    const suffix = source.slice(match.index + match[0].length), prefix = source.slice(0, match.index);
    if (!lexical.isRoot(match.index) && !runtimeStartsWrite(suffix) && !/^\s*(?:\)\s*)*(?:[,}\]]|of\b|in\b)/u.test(suffix) && !/(?:\+\+|--)\s*\(*\s*$/u.test(prefix)) continue;
    if (parsesReplacement(match, "(0)") || parsesReplacement(match, name + ":(0)") || shadowed(name, match.index)) continue;
    throw new Error("Native runtime binding has an additional declaration or write: " + name);
  }
}

function inspectRuntimeEntry(source) {
  const id = "[A-Za-z_$][\\w$]*";
  const exported = runtimeOne(runtimeMatches(source, new RegExp(`\\bexport\\{(${id}) as __webpack_require__\\}`, "gu"), true), "native require export")[1];
  const alias = runtimeOne(runtimeMatches(source, new RegExp(`\\bvar ${escapeRegExp(exported)}=(${id});`, "gu"), true), "native require export binding");
  const requireName = alias[1];
  const head = runtimeOne(runtimeMatches(source, new RegExp(`\\bfunction ${escapeRegExp(requireName)}\\((${id})\\)\\{`, "gu"), true), "native require function");
  const open = head.index + head[0].length - 1, close = findMatchingBrace(source, open);
  const requireBody = source.slice(open + 1, close);
  const invocation = runtimeOne(runtimeMatches(requireBody, new RegExp(`(${id})\\[${escapeRegExp(head[1])}\\]\\.call\\((${id})\\.exports,\\2,\\2\\.exports,${escapeRegExp(requireName)}\\)`, "gu")), "native module invocation");
  const table = invocation[1];
  const tableHead = runtimeOne(runtimeMatches(source, new RegExp(`(?<![\\w$.])${escapeRegExp(table)}=\\{`, "gu"), true), "native bootstrap registry");
  const tableOpen = tableHead.index + tableHead[0].length - 1, tableClose = findMatchingBrace(source, tableOpen);
  runtimeAssertRootBinding(source, exported, [alias.index + "var ".length]);
  runtimeAssertRootBinding(source, requireName, [head.index + "function ".length]);
  runtimeAssertRootBinding(source, table, [tableHead.index]);
  const body = source.slice(tableOpen + 1, tableClose), bodyLexical = createJavaScriptLexicalIndex(body);
  const factories = [];
  for (const match of body.matchAll(new RegExp(`(?:^|,)([A-Za-z0-9_$]+)\\((${id}),(${id}),(${id})\\)\\{`, "gu"))) {
    const at = match.index + (match[0][0] === "," ? 1 : 0);
    if (!bodyLexical.isRoot(at)) continue;
    const factoryOpen = match.index + match[0].length - 1, factoryClose = findMatchingBrace(body, factoryOpen);
    factories.push({ moduleId: match[1], params: match.slice(2, 5), moduleSource: body.slice(factoryOpen + 1, factoryClose), start: tableOpen + factoryOpen + 2 });
  }
  const decoder = runtimeOne(factories.filter(factory => runtimeMatches(factory.moduleSource, /\b(?:let|const) ([\w$]+)="codex-host-chunked-message-v1"/gu, true).length === 1), "native host decoder");
  const marker = runtimeMatches(decoder.moduleSource, /\b(?:let|const) ([\w$]+)="codex-host-chunked-message-v1"/gu, true)[0][1];
  const publication = runtimeOne(runtimeMatches(decoder.moduleSource, new RegExp(`${escapeRegExp(decoder.params[2])}\\.d\\(${escapeRegExp(decoder.params[1])},\\{\\},\\{(${id}):${escapeRegExp(marker)},(${id}):function\\((${id})\\)\\{`, "gu"), true), "native decoder publication");
  const validatorOpen = publication.index + publication[0].length - 1, validatorClose = findMatchingBrace(decoder.moduleSource, validatorOpen);
  const validator = decoder.moduleSource.slice(validatorOpen + 1, validatorClose), parameter = publication[3];
  for (const field of ["marker", "transferId", "sequence", "kind", "tokens"]) {
    if (!validator.includes(JSON.stringify(field))) throw new Error("Native decoder field contract changed");
  }
  if (!runtimeMatches(validator, new RegExp(`${escapeRegExp(parameter)}\\.marker===${escapeRegExp(marker)}`, "gu")).length ||
      !runtimeMatches(validator, new RegExp(`Number\\.isSafeInteger\\(${escapeRegExp(parameter)}\\.sequence\\)`, "gu")).length ||
      !runtimeMatches(validator, new RegExp(`Array\\.isArray\\(${escapeRegExp(parameter)}\\.tokens\\)`, "gu")).length) throw new Error("Native decoder validation changed");
  const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
  const decoderConsumers = factories.flatMap(factory => {
    if (factory === decoder) return [];
    return runtimeMatches(factory.moduleSource, new RegExp(`(${id})=${escapeRegExp(factory.params[2])}\\("${escapeRegExp(decoder.moduleId)}"\\)`, "gu"), true)
      .filter(match => findRspackRequireBinding(factory, match[1])?.moduleId === decoder.moduleId)
      .map(match => ({ factory, name: escapeRegExp(match[1]) }));
  });
  const validatorOwner = runtimeOne(decoderConsumers.filter(row => runtimeMatches(row.factory.moduleSource,
    new RegExp(`(?:\\(0,${row.name}\\.${escapeRegExp(publication[2])}\\)|${row.name}\\.${escapeRegExp(publication[2])})\\(`, "gu")).length), "native host validator consumer").factory;
  const receiver = runtimeOne(runtimeMatches(validatorOwner.moduleSource, new RegExp(`${escapeRegExp(validatorOwner.params[2])}\\.d\\(${escapeRegExp(validatorOwner.params[1])},\\{\\},\\{(${id}):class\\{`, "gu"), true), "native host receiver publication")[1];
  const markerOwner = runtimeOne(decoderConsumers.filter(row => runtimeMatches(row.factory.moduleSource,
    new RegExp(`\\.marker===${row.name}\\.${escapeRegExp(publication[1])}(?![\\w$])`, "gu")).length), "native host marker consumer").factory;
  const receiverUses = runtimeMatches(markerOwner.moduleSource, new RegExp(`(${id})=${escapeRegExp(markerOwner.params[2])}\\("${escapeRegExp(validatorOwner.moduleId)}"\\)`, "gu"), true)
    .filter(match => findRspackRequireBinding(markerOwner, match[1])?.moduleId === validatorOwner.moduleId &&
      runtimeMatches(markerOwner.moduleSource, new RegExp(`\\bnew ${escapeRegExp(match[1])}\\.${escapeRegExp(receiver)}(?![\\w$])`, "gu")).length);
  runtimeOne(receiverUses, "native host receiver construction");
  if (!runtimeMatches(markerOwner.moduleSource, /\.receive\(/gu).length) throw new Error("Native host receiver is not consumed");
  const imports = runtimeMatches(source, /\bimport\*as ([\w$]+) from"([^"\n]+)";/gu, true).map(match => {
    if (runtimeMatches(source, new RegExp(`${escapeRegExp(requireName)}\\.C\\(${escapeRegExp(match[1])}\\)`, "gu"), true).length !== 1) throw new Error("Native imported chunk registration changed");
    return match[2];
  });
  if (imports.length === 0) throw new Error("Missing native startup imports");
  const startup = runtimeOne(runtimeMatches(source, new RegExp(`\\bvar (${id})=${escapeRegExp(requireName)}\\.O\\(void 0,(\\[[^\\]]*\\]),\\(\\)=>${escapeRegExp(requireName)}\\("([^"\\n]+)"\\)\\);${escapeRegExp(requireName)}\\.O\\(\\1\\);`, "gu"), true), "native startup invocation");
  const prefix = source.slice(0, startup.index).trimEnd();
  if (prefix && !/[;}]/u.test(prefix.at(-1))) throw new Error("Native startup is not an unconditional declaration");
  const chunks = JSON.parse(startup[2]);
  if (!Array.isArray(chunks) || !chunks.length || chunks.some(value => typeof value !== "string" && typeof value !== "number")) throw new Error("Native startup chunk set changed");
  return { requireName, exported, decoderId: decoder.moduleId, imports, chunks: chunks.map(String), startupId: startup[3], bootstrapModules: factories.map(factory => factory.moduleId) };
}

function runtimeAssetNames(extractedDir) {
  const base = path.join(extractedDir, "webview", "assets"), names = [];
  function visit(directory, prefix) {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Read Aloud asset inventory directory is not regular");
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = prefix + name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Read Aloud asset inventory contains a symlink");
      if (stat.isDirectory()) visit(file, relative + "/");
      else if (stat.isFile() && /\.(?:c|m)?js$/u.test(name)) names.push("webview/assets/" + relative);
    }
  }
  visit(base, "");
  return names;
}

function runtimeHtmlScripts(source) {
  const scripts = [];
  for (const match of source.replace(/<!--[\s\S]*?-->/gu, "").matchAll(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/giu)) {
    const attrs = new Map();
    for (const attr of match[1].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gu)) {
      const name = attr[1].toLowerCase();
      if (attrs.has(name)) throw new Error("Duplicate native HTML script attribute");
      attrs.set(name, attr[3]);
    }
    if (attrs.get("type") !== "module" || !attrs.has("src")) continue;
    const src = attrs.get("src");
    if (!/^\/?(?:\.\/)?assets\/[A-Za-z0-9_./-]+\.(?:m?js)$/u.test(src) || src.split("/").some(part => part === "..")) throw new Error("Unsupported native HTML module edge");
    scripts.push("webview/" + src.replace(/^\/?(?:\.\/)?/u, ""));
  }
  if (!scripts.length || new Set(scripts).size !== scripts.length) throw new Error("Missing or duplicate native HTML script edge");
  return scripts;
}

function runtimeDependencyFacts(source) {
  const digest = require("node:crypto").createHash("sha256").update(source).digest("hex");
  if (readAloudDependencyFacts.has(digest)) return readAloudDependencyFacts.get(digest);
  const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
  const chunks = runtimeOne(runtimeMatches(source, /\bexport const __rspack_esm_ids=(\[[^\]]*\])/gu, true), "native dependency chunk registration");
  const facts = { chunks: JSON.parse(chunks[1]).map(String), modules: [...rspackModuleFactories(source)].map(factory => factory.moduleId) };
  if (readAloudDependencyFacts.size > 32) readAloudDependencyFacts.clear();
  readAloudDependencyFacts.set(digest, facts);
  return facts;
}

function applyReadAloudRuntimeToExtractedApp(extractedDir) {
  const reject = error => { warn(error.message, "read aloud webview runtime patch"); return { matched: 0, changed: 0, changedAssets: [], reason: error.message }; };
  let edits, names, hashes, written;
  const digest = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  try {
    names = runtimeAssetNames(extractedDir); hashes = new Map();
    const snapshots = new Map(), roles = [], claims = [];
    const read = name => {
      if (!snapshots.has(name)) {
        let file = extractedDir;
        const parts = name.split("/");
        for (const [index, part] of parts.entries()) {
          file = path.join(file, part);
          const stat = fs.lstatSync(file);
          if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error("Native runtime dependency path is not regular");
        }
        const source = fs.readFileSync(file, "utf8"), hash = digest(source);
        if (hashes.has(name) && hashes.get(name) !== hash) throw new Error("Native runtime dependency changed during qualification");
        snapshots.set(name, source);
        hashes.set(name, hash);
      }
      return snapshots.get(name);
    };
    for (const name of names) {
      const value = fs.readFileSync(path.join(extractedDir, name), "utf8"); hashes.set(name, digest(value));
      if (runtimeOwnClaims(value).length) claims.push(name);
    }
    for (const html of ["webview/index.html", "webview/detached-window.html"]) {
      const scripts = runtimeHtmlScripts(read(html));
      const owners = [];
      for (const name of scripts) {
        const text = read(name);
        if (RUNTIME_ENTRY_EXPORT.test(text) || runtimeOwnClaims(text).length) owners.push({ name, text, native: inspectRuntimeEntry(text), own: inspectReadAloudRuntime(text) });
      }
      const owner = runtimeOne(owners, "native window runtime entry");
      const registeredChunks = new Set(), modules = new Set(owner.native.bootstrapModules);
      for (const imported of owner.native.imports) {
        if (!/^\.\/[A-Za-z0-9_./-]+\.js$/u.test(imported) || imported.split("/").some(part => part === "..")) throw new Error("Unsupported native entry import");
        const name = path.posix.normalize(path.posix.join(path.posix.dirname(owner.name), imported));
        if (!scripts.includes(name)) throw new Error("Native startup import is outside its HTML load edge");
        const facts = runtimeDependencyFacts(read(name));
        facts.chunks.forEach(id => registeredChunks.add(id)); facts.modules.forEach(id => modules.add(id));
      }
      if (owner.native.chunks.some(id => !registeredChunks.has(id)) || !modules.has(owner.native.startupId)) throw new Error("Native startup chunks or producer are unavailable");
      roles.push(owner);
    }
    if (new Set(roles.map(row => row.name)).size !== 2) throw new Error("Native window runtime roles overlap");
    if (new Set(roles.map(row => row.own.state)).size !== 1) throw new Error("Mixed Read Aloud runtime entry cohort");
    if (claims.some(name => !roles.some(row => row.name === name))) throw new Error("Orphan Read Aloud runtime peer");
    written = new Set(roles.filter(row => row.own.state === "current").map(row => row.name));
    for (const owner of roles) {
      const patched = ensureReadAloudRuntime(owner.text);
      if (inspectReadAloudRuntime(patched).state !== "patched") throw new Error("Read Aloud runtime poststate is incomplete");
      snapshots.set(owner.name, owner.text);
    }
    edits = [...snapshots].map(([assetName, source]) => ({ assetName, source, patchedSource: written.has(assetName) ? ensureReadAloudRuntime(source) : source }));
  } catch (error) { return reject(error); }
  const verify = () => {
    const current = runtimeAssetNames(extractedDir);
    if (JSON.stringify(current) !== JSON.stringify(names)) throw new Error("Read Aloud asset inventory changed before commit");
    for (const [name, hash] of hashes) {
      if (digest(fs.readFileSync(path.join(extractedDir, name))) !== hash) throw new Error(`Read Aloud dependency changed before commit: ${name}`);
    }
  };
  verify();
  const originalByFile = new Map(edits.map(edit => [path.join(extractedDir, edit.assetName), Buffer.from(edit.source)]));
  const result = commitMainEdits(extractedDir, edits, { writeFileSync(file, bytes) {
    const restoring = originalByFile.get(file)?.equals(bytes);
    if (!restoring) verify();
    fs.writeFileSync(file, bytes);
    if (!restoring) hashes.set(path.relative(extractedDir, file).split(path.sep).join("/"), digest(bytes));
  } });
  return { matched: 1, ...result };
}

function applyRuntimeEntryPatch(source) {
  try {
    inspectRuntimeEntry(source);
    return ensureReadAloudRuntime(source);
  } catch (error) {
    warn("Could not find complete rspack webview runtime entry contract - " + error.message, "read aloud webview runtime patch");
    return source;
  }
}

function applyAssistantAssetPatch(source) {
  const patched = applyAssistantRenderPatch(source);
  if (patched === source && !source.includes(`globalThis.${HELPER_MARKER}?.(`)) {
    warn("Could not find assistant message render call", "read aloud assistant render patch");
  }
  return patched;
}

function matchesAssistantRuntimeContract(source) {
  return inspectAssistantRenderContract(source).state !== "invalid";
}

// Settings: the official General settings page wraps its content in a page
// component titled by the `general-settings` slug. Read aloud adds one host
// element between the page content and the trailing extras; the runtime owns
// that element's DOM so the injected JSX references nothing but the module's
// own JSX runtime.
const GENERAL_SETTINGS_PAGE_NEEDLES = ['slug:"general-settings"', '"settings.general.groupTitle"'];
const SETTINGS_MOUNT_CLASS = "codex-linux-read-aloud-settings-mount";
const GENERAL_SETTINGS_PAGE_TITLE =
  /\(0,([A-Za-z_$][\w$]*)\.jsx\)\([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?,\{slug:"general-settings"\}\)/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function settingsMountSource(jsxVar) {
  return `(0,${jsxVar}.jsx)("div",{className:${JSON.stringify(SETTINGS_MOUNT_CLASS)},ref:codexLinuxReadAloudSettingsRoot=>{codexLinuxReadAloudSettingsRoot&&globalThis.${SETTINGS_MOUNT_MARKER}?.(codexLinuxReadAloudSettingsRoot)}})`;
}

function inspectGeneralSettingsPage(source) {
  const pages = [];
  for (const title of source.matchAll(GENERAL_SETTINGS_PAGE_TITLE)) {
    const jsx = title[1];
    const bodyStart = title.index + title[0].length;
    const nextFunction = source.indexOf("function ", bodyStart);
    const body = source.slice(bodyStart, nextFunction === -1 ? source.length : nextFunction);
    const mount = escapeRegExp(settingsMountSource(jsx));
    // Other Linux settings features may lead the page children with their
    // own self-contained marked components, such as
    // `(0,n.jsx)(codexLinuxCommunityFeaturesInGuiSettings,{})`.
    const linuxChildren = `(?:\\(0,${escapeRegExp(jsx)}\\.jsx\\)\\(codexLinux[A-Za-z]+,\\{\\}\\),)*`;
    const pageCall = new RegExp(
      `\\(0,${escapeRegExp(jsx)}\\.jsxs\\)\\([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?,\\{title:[A-Za-z_$][\\w$]*,children:\\[(${linuxChildren})([A-Za-z_$][\\w$]*),(${mount},)?([A-Za-z_$][\\w$]*)\\]\\}\\)`,
      "g",
    );
    for (const call of body.matchAll(pageCall)) {
      const children = call[0].indexOf("children:[") + "children:[".length;
      pages.push({
        jsx,
        patched: call[3] != null,
        insertAt: bodyStart + call.index + children + call[1].length + call[2].length + 1,
      });
    }
  }
  const mountCount = countOccurrences(source, SETTINGS_MOUNT_CLASS);
  if (pages.length !== 1) return { state: "invalid", pages };
  const [page] = pages;
  if (page.patched && mountCount === 1) return { state: "patched", page };
  if (!page.patched && mountCount === 0) return { state: "unpatched", page };
  return { state: "invalid", pages };
}

function matchesGeneralSettingsPageContract(source) {
  return inspectGeneralSettingsPage(source).state !== "invalid";
}

function applyGeneralSettingsPatch(source) {
  const contract = inspectGeneralSettingsPage(source);
  if (contract.state === "patched") return source;
  if (contract.state !== "unpatched") {
    warn("Could not find unique General settings page contract", "read aloud settings patch");
    return source;
  }
  const { insertAt, jsx } = contract.page;
  return `${source.slice(0, insertAt)}${settingsMountSource(jsx)},${source.slice(insertAt)}`;
}

module.exports = {
  applyAssistantRenderPatch,
  applyGeneralSettingsPatch,
  applyIndexRuntimePatch,
  applyMainBundlePatch,
  applyMainToExtractedApp,
  applyRuntimeEntryPatch,
  matchesAssistantRuntimeContract,
  matchesGeneralSettingsPageContract,
  descriptors: [
    {
      id: "main-handler",
      phase: "extracted-app:pre-webview",
      order: 20600,
      ciPolicy: "optional",
      apply: extractedDir => applyMainToExtractedApp(extractedDir),
    },
    {
      id: "webview-runtime",
      phase: "extracted-app:pre-webview",
      order: 20610,
      ciPolicy: "optional",
      assetNeedles: RUNTIME_ENTRY_NEEDLES,
      missingDescription: "rspack webview runtime entry",
      skipDescription: "read aloud webview runtime patch",
      apply: applyReadAloudRuntimeToExtractedApp,
      status: result => result?.matched !== 1
        ? { status: "skipped-optional", reason: result?.reason ?? "missing complete runtime entry cohort" }
        : result.changed > 0 ? "applied" : "already-applied",
    },
    {
      id: "assistant-runtime",
      phase: "extracted-app:pre-webview",
      order: 20620,
      ciPolicy: "optional",
      assetNeedles: ["collapsibleUnits:", "persistentUnits:", "assistantCopyText:"],
      assetMatch: matchesAssistantRuntimeContract,
      missingDescription: "current primary thread assistant bundle",
      skipDescription: "read aloud assistant runtime patch",
      apply: applyAssistantToExtractedApp,
      status: result => result?.matched !== 1 ? { status: "skipped-optional", reason: result?.reason ?? "missing assistant cohort" } : result.changed > 0 ? "applied" : "already-applied",
    },
    {
      id: "settings-toggle",
      phase: "webview-asset",
      order: 20640,
      ciPolicy: "optional",
      assetNeedles: GENERAL_SETTINGS_PAGE_NEEDLES,
      assetMatch: matchesGeneralSettingsPageContract,
      missingDescription: "General settings page bundle",
      skipDescription: "read aloud settings patch",
      apply: applyGeneralSettingsPatch,
    },
  ],
};
