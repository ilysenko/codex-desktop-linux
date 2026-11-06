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
    `const METHOD=${JSON.stringify(HANDLER_NAME)};let seq=0,pending=new Map,currentButton=null,currentSpeakTimer=null;`,
    `function onMessage(e){let t=e?.data;if(!t||typeof t!="object"||t.type!=="fetch-response")return;let n=pending.get(t.requestId);if(!n)return;pending.delete(t.requestId);if(t.responseType==="success"){let e=null;try{e=t.bodyJsonString?JSON.parse(t.bodyJsonString):null}catch{}n.resolve({status:t.status,body:e})}else n.reject(Error(t.error||"fetch failed"))}`,
    `window.addEventListener("message",onMessage);`,
    `function dispatch(payload){let bridge=window.electronBridge,event=new CustomEvent("codex-message-from-view",{detail:payload});if(bridge?.sendMessageFromView){event.__codexForwardedViaBridge=!0;bridge.sendMessageFromView(payload).catch(()=>{})}window.dispatchEvent(event)}`,
    `function log(message,tags={}){dispatch({type:"log-message",level:"info",message,tags:{safe:tags,sensitive:{}}})}`,
    `function hostPost(method,body,timeoutMs=4000){let requestId="codex-linux-read-aloud-"+ ++seq;let payload={type:"fetch",hostId:"local",requestId,method:"POST",url:"vscode://codex/"+method,body:JSON.stringify(body??{})};return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});setTimeout(()=>{pending.delete(requestId);reject(Error("timeout"))},timeoutMs);dispatch(payload)})}`,
    `function post(params,timeoutMs=4000){return hostPost(METHOD,params,timeoutMs)}`,
    `function clean(text){return String(text||"").replace(/\\r\\n/g,"\\n").replace(/\`\`\`[\\s\\S]*?\`\`\`/g," code block. ").replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,"$1").replace(/[*_#>~]/g,"").replace(/\\n{3,}/g,"\\n\\n").trim().slice(0,8e3)}`,
    `function buttonLabel(state,label){return label??(state==="speaking"?"Stop read aloud":state==="loading"?"Loading voice":state==="error"?"No voice available":"Read assistant response aloud")}`,
    `function setButton(button,state,label){if(!button)return;let title=buttonLabel(state,label);button.dataset.codexLinuxReadAloudState=state;button.title=title;button.setAttribute("aria-label",title);button.disabled=state==="loading"}`,
    `function flash(button,label){setButton(button,"error",label);setTimeout(()=>setButton(button,"ready"),1500)}`,
    `function resetButton(button=currentButton){if(currentSpeakTimer!=null){clearTimeout(currentSpeakTimer);currentSpeakTimer=null}if(button)setButton(button,"ready");if(button===currentButton)currentButton=null}`,
    `function stopSpeech(){resetButton();post({action:"stop"}).catch(()=>{})}`,
    `function estimateMs(text){let words=text.split(/\\s+/).filter(Boolean).length;return Math.max(3000,Math.min(120000,words*360))}`,
    `function failureLabel(result){let reason=result?.reason;if(reason==="disabled")return"Enable Read aloud in settings";if(reason==="kokoro-unavailable")return"Install Read aloud voice model";if(reason==="empty")return"Nothing to read";return"No voice available"}`,
    `async function click(item,copyText,conversationId,button){try{button?.blur?.();if(globalThis.codexLinuxConversationIsSpeaking?.()){globalThis.codexLinuxConversationStopSpeaking?.();resetButton(button);return}if(button?.dataset.codexLinuxReadAloudState==="speaking"){stopSpeech();return}let text=clean(copyText||item?.content||"");if(text.length<2)return;setButton(button,"loading","Starting voice");let result=await post({action:"speak",source:"button",text}).then(e=>e.body).catch(()=>({spoken:!1,reason:"request-failed"}));log("[linux-read-aloud] click",{conversationId:conversationId||null,textLength:text.length,spoken:result?.spoken===!0,engine:result?.engine||null,reason:result?.reason||null,missing:Array.isArray(result?.missing)?result.missing.join(","):null});if(result?.spoken){currentButton=button;setButton(button,"speaking");currentSpeakTimer=setTimeout(()=>resetButton(button),estimateMs(text));return}flash(button,failureLabel(result))}catch{flash(button,"No voice available")}}`,
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
    `root.replaceChildren(node("section",{className:"codex-linux-read-aloud-settings","aria-label":"Read Aloud"},[node("div",{className:"codex-linux-read-aloud-settings-title",text:"Read Aloud"}),node("div",{className:"codex-linux-read-aloud-settings-group"},[settingsRow("Read aloud responses",node("div",{className:"codex-linux-read-aloud-settings-description"},[node("span",{text:"Show a read aloud button under assistant responses. If the Kokoro voice files are missing, choose a local folder or download them."}),error]),[toggle,setupControls]),paceRow])]));render();`,
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
  if (source.includes(RUNTIME_VERSION)) {
    return source;
  }
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
  const jsxCallPattern =
    /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?),\{(?=[^{}]*\bitem:)(?=[^{}]*\bassistantCopyText:)(?=[^{}]*\bconversationId:)([^{}]*)\}\)/g;
  const readProp = (props, name) =>
    new RegExp(`(?:^|,)${name}:([A-Za-z_$][\\w$]*)`).exec(props)?.[1] ?? null;
  const candidates = Array.from(source.matchAll(jsxCallPattern), (match) => {
    const props = match[3];
    const propNames = new Set(
      Array.from(props.matchAll(/(?:^|,)([A-Za-z_$][\w$]*):/g), (prop) => prop[1]),
    );
    let role = null;
    if (ASSISTANT_RENDER_SHARED_PROPS.every((name) => propNames.has(name))) {
      if (propNames.has("sourceTurnId") && !propNames.has("turnId")) {
        role = "source-turn";
      } else if (
        !propNames.has("sourceTurnId") &&
        ASSISTANT_RENDER_LIVE_PROPS.every((name) => propNames.has(name))
      ) {
        role = "live-turn";
      }
    }
    const itemVar = readProp(props, "item");
    const copyVar = readProp(props, "assistantCopyText");
    const conversationVar = readProp(props, "conversationId");
    const replacement =
      itemVar == null || copyVar == null || conversationVar == null
        ? null
        : `(0,${match[1]}.jsxs)(${match[1]}.Fragment,{children:[${match[0]},${readAloudButtonRowSource(match[1], itemVar, copyVar, conversationVar, "e")}]})`;
    return {
      component: match[2],
      end: match.index + match[0].length,
      jsxVar: match[1],
      match: match[0],
      replacement,
      role,
      start: match.index,
    };
  });
  const roles = new Map(candidates.map((candidate) => [candidate.role, candidate]));
  const completeSet =
    candidates.length === 2 &&
    roles.size === 2 &&
    roles.has("source-turn") &&
    roles.has("live-turn") &&
    candidates.every(
      (candidate) =>
        candidate.replacement != null &&
        candidate.jsxVar === candidates[0].jsxVar &&
        candidate.component === candidates[0].component,
    );
  if (!completeSet) {
    return { candidates, state: "invalid" };
  }

  const wrapped = candidates.map((candidate) => source.includes(candidate.replacement));
  const helperCount = countOccurrences(source, `globalThis.${HELPER_MARKER}?.(`);
  if (wrapped.every((value) => !value) && helperCount === 0) {
    return { candidates, state: "unpatched" };
  }
  if (wrapped.every(Boolean) && helperCount === candidates.length) {
    return { candidates, state: "patched" };
  }
  return { candidates, state: "invalid" };
}

function applyAssistantRenderPatch(source) {
  const contract = inspectAssistantRenderContract(source);
  if (contract.state === "patched") {
    return source;
  }
  if (contract.state !== "unpatched") {
    if (
      contract.candidates.length > 0 ||
      source.includes(`globalThis.${HELPER_MARKER}?.(`)
    ) {
      warn("Could not find complete assistant message render call set", "read aloud assistant render patch");
    }
    return source;
  }

  let patched = source;
  for (const candidate of [...contract.candidates].reverse()) {
    patched = `${patched.slice(0, candidate.start)}${candidate.replacement}${patched.slice(candidate.end)}`;
  }
  return patched;
}

// The webview runtime is appended to the rspack runtime entry chunks: the
// chunks that own the chunked host-message decoder and export the webpack
// require function. The main window and detached windows each load one.
const RUNTIME_ENTRY_NEEDLES = ["codex-host-chunked-message-v1", "as __webpack_require__}"];
const RUNTIME_ENTRY_EXPORT = /export\{[A-Za-z_$][\w$]* as __webpack_require__\}/;

function applyRuntimeEntryPatch(source) {
  if (!RUNTIME_ENTRY_EXPORT.test(source) || !source.includes(RUNTIME_ENTRY_NEEDLES[0])) {
    console.warn("WARN: Could not find rspack webview runtime entry contract - skipping read aloud webview runtime patch");
    return source;
  }
  return ensureReadAloudRuntime(source);
}

function applyAssistantAssetPatch(source) {
  const patched = applyAssistantRenderPatch(source);
  if (patched === source && !source.includes(`globalThis.${HELPER_MARKER}?.(`)) {
    warn("Could not find assistant message render call", "read aloud assistant render patch");
  }
  return patched;
}

function matchesAssistantRuntimeContract(source) {
  const primaryThreadPartition =
    source.includes("collapsibleUnits:") && source.includes("persistentUnits:");
  return primaryThreadPartition && inspectAssistantRenderContract(source).state !== "invalid";
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
      phase: "webview-asset",
      order: 20610,
      ciPolicy: "optional",
      assetNeedles: RUNTIME_ENTRY_NEEDLES,
      missingDescription: "rspack webview runtime entry",
      skipDescription: "read aloud webview runtime patch",
      apply: applyRuntimeEntryPatch,
    },
    {
      id: "assistant-runtime",
      phase: "webview-asset",
      order: 20620,
      ciPolicy: "optional",
      assetNeedles: ["collapsibleUnits:", "persistentUnits:", "assistantCopyText:"],
      assetMatch: matchesAssistantRuntimeContract,
      missingDescription: "current primary thread assistant bundle",
      skipDescription: "read aloud assistant runtime patch",
      apply: applyAssistantAssetPatch,
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
