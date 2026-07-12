"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  linuxSettingsKeys,
} = require("../../scripts/patches/lib/settings-keys.js");
const {
  findMatchingBrace,
  requireName,
} = require("../../scripts/patches/lib/minified-js.js");

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
const HANDLER_NAME = "linux-read-aloud";
const RUNTIME_VERSION = "kokoro-explicit-v5";
const READ_ALOUD_SETTINGS_SLUG = "read-aloud-settings";
const CURRENT_SETTINGS_BLOCK_MARKER = "codexLinuxReadAloudSettingsAliasesV2";
const GENERAL_SETTINGS_ROW_CALL = "(0,$.jsx)(codexLinuxReadAloudSettingsRow,{})";
const GENERAL_SETTINGS_CHILDREN = "children:[S,C,w,T,D,O,k,A,j,M,N,P,L]";
const GENERAL_SETTINGS_CHILDREN_WITH_ROW =
  `children:[S,C,w,T,${GENERAL_SETTINGS_ROW_CALL},D,O,k,A,j,M,N,P,L]`;
const GENERAL_SETTINGS_CHILDREN_WITH_OLD_ROW =
  `children:[S,C,w,T,D,O,k,${GENERAL_SETTINGS_ROW_CALL},A,j,M,N,P,L]`;
const ASSISTANT_RENDER_CANDIDATE_PATTERN =
  /\.(?:jsx|jsxs)\)\([A-Za-z_$][\w$]*,\{(?=[^{}]{0,2000}\bitem:)(?=[^{}]{0,2000}\bassistantCopyText:)(?=[^{}]{0,2000}\bconversationId:)/u;

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyMainBundlePatch(source) {
  if (source.includes(`"${HANDLER_NAME}":async`)) {
    return source;
  }

  const childProcessVar = "require(`node:child_process`)";
  const fsVar = requireName(source, "node:fs");
  const pathVar = requireName(source, "node:path");
  const osVar = requireName(source, "node:os") ?? requireName(source, "os");
  if (fsVar == null || pathVar == null || osVar == null) {
    warn("Could not find node:fs/node:path/node:os dependencies", "read aloud main-bundle patch");
    return source;
  }

  const helper = [
    `function codexLinuxReadAloudCleanText(e){return typeof e!==\`string\`?\`\`:e.replace(/\\r\\n/g,\`\\n\`).replace(new RegExp(\`\\\`\\\`\\\`[\\\\s\\\\S]*?\\\`\\\`\\\`\`,\`gu\`),\` code block. \`).replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/gu,\`$1\`).replace(/[*_#>~]/gu,\`\`).replace(/\\n{3,}/gu,\`\\n\\n\`).trim().slice(0,8e3)}`,
    `function codexLinuxReadAloudHasHebrew(e){return /[\\u0590-\\u05ff]/u.test(e)}`,
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
    `function codexLinuxReadAloudRun(command,args,timeoutMs=3e5){return new Promise((resolve,reject)=>{let child,timer;try{child=${childProcessVar}.spawn(command,args,{stdio:\`ignore\`,windowsHide:!0,env:{...process.env,...codexLinuxReadAloudAudioEnv()}}),timer=setTimeout(()=>{try{child.kill(\`SIGTERM\`)}catch{}reject(Error(\`command timed out\`))},timeoutMs),timer.unref?.(),child.on(\`error\`,error=>{clearTimeout(timer),reject(error)}),child.on(\`close\`,code=>{clearTimeout(timer),code===0?resolve():reject(Error(\`command failed\`))})}catch(error){clearTimeout(timer),reject(error)}})}`,
    `function codexLinuxReadAloudPythonOk(pythonBin){try{return ${childProcessVar}.spawnSync(pythonBin,[\`-c\`,\`import sys; raise SystemExit(0 if (3,10) <= sys.version_info < (3,14) else 1)\`],{stdio:\`ignore\`,env:{...process.env,...codexLinuxReadAloudAudioEnv()}}).status===0}catch{return!1}}`,
    `function codexLinuxReadAloudFindPython(){for(let e of [process.env.PYTHON?.trim(),\`python3.12\`,\`python3.13\`,\`python3.11\`,\`python3.10\`,\`python3\`])if(e&&codexLinuxReadAloudCommandExists(e)&&codexLinuxReadAloudPythonOk(e))return e;return null}`,
    `async function codexLinuxReadAloudInstallRuntime(){let e=codexLinuxReadAloudKokoroPython();if(codexLinuxReadAloudCommandExists(e))return;let t=${pathVar}.dirname(${pathVar}.dirname(e)),n=codexLinuxReadAloudFindPython();if(!n)throw Error(\`Python 3.10-3.13 is required for Kokoro\`);${fsVar}.mkdirSync(${pathVar}.dirname(t),{recursive:!0});if(codexLinuxReadAloudCommandExists(\`uv\`)){await codexLinuxReadAloudRun(\`uv\`,[\`venv\`,\`--python\`,n,t]);await codexLinuxReadAloudRun(\`uv\`,[\`pip\`,\`install\`,\`--python\`,e,\`kokoro-onnx>=0.5.0\`,\`numpy>=2.0.2\`],6e5);return}await codexLinuxReadAloudRun(n,[\`-m\`,\`venv\`,t]);await codexLinuxReadAloudRun(e,[\`-m\`,\`ensurepip\`,\`--upgrade\`]);await codexLinuxReadAloudRun(e,[\`-m\`,\`pip\`,\`install\`,\`--upgrade\`,\`pip\`],6e5);await codexLinuxReadAloudRun(e,[\`-m\`,\`pip\`,\`install\`,\`kokoro-onnx>=0.5.0\`,\`numpy>=2.0.2\`],6e5)}`,
    `function codexLinuxReadAloudDownloadFile(url,target,minBytes,redirects=0){return new Promise((resolve,reject)=>{if(redirects>5){reject(Error(\`too many redirects\`));return}let parsed;try{parsed=new URL(url)}catch{reject(Error(\`invalid download URL\`));return}let get=parsed.protocol===\`https:\`?require(\`node:https\`).get:parsed.protocol===\`http:\`?require(\`node:http\`).get:null;if(!get){reject(Error(\`unsupported download URL\`));return}${fsVar}.mkdirSync(${pathVar}.dirname(target),{recursive:!0});let partial=\`\${target}.part\`,bytes=0,done=!1;try{${fsVar}.rmSync(partial,{force:!0})}catch{}let cleanup=()=>{try{${fsVar}.rmSync(partial,{force:!0})}catch{}};let fail=e=>{if(done)return;done=!0;cleanup();reject(e instanceof Error?e:Error(String(e)))};let fileStream=${fsVar}.createWriteStream(partial),request=get(parsed,{headers:{"User-Agent":\`codex-desktop-read-aloud\`}},response=>{if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume?.();fileStream.close(()=>{});cleanup();codexLinuxReadAloudDownloadFile(new URL(response.headers.location,parsed).toString(),target,minBytes,redirects+1).then(resolve,reject);return}if(response.statusCode!==200){response.resume?.();fileStream.close(()=>{});fail(Error(\`download failed with status \${response.statusCode}\`));return}response.on(\`data\`,chunk=>{bytes+=chunk.length}),response.pipe(fileStream),fileStream.on(\`finish\`,()=>fileStream.close(()=>{if(done)return;if(bytes<minBytes){fail(Error(\`download too small\`));return}try{${fsVar}.renameSync(partial,target),done=!0,resolve()}catch(error){fail(error)}}))});request.on(\`error\`,fail),fileStream.on(\`error\`,fail)})}`,
    `async function codexLinuxReadAloudDownloadKokoro(){let e=codexLinuxReadAloudKokoroModel(),t=codexLinuxReadAloudKokoroVoices();codexLinuxReadAloudFileExists(e)||await codexLinuxReadAloudDownloadFile(codexLinuxReadAloudKokoroModelUrl(),e,5e7);codexLinuxReadAloudFileExists(t)||await codexLinuxReadAloudDownloadFile(codexLinuxReadAloudKokoroVoicesUrl(),t,1e6);let n=codexLinuxReadAloudSettings();n[${JSON.stringify(KOKORO_PYTHON_KEY)}]=codexLinuxReadAloudKokoroPython(),n[${JSON.stringify(KOKORO_MODEL_KEY)}]=e,n[${JSON.stringify(KOKORO_VOICES_KEY)}]=t,codexLinuxReadAloudWriteSettings(n)}`,
    `async function codexLinuxReadAloudChooseModelDir(){let electronApi;try{let loadElectron=()=>require(\`electron\`),electronModule=loadElectron();electronApi=typeof codexLinuxPatchExternalOpen===\`function\`?codexLinuxPatchExternalOpen(electronModule):electronModule}catch{return{ok:!1,reason:\`dialog-unavailable\`}}let result=await electronApi.dialog.showOpenDialog({title:\`Choose Kokoro model folder\`,properties:[\`openDirectory\`]});if(result.canceled||!result.filePaths?.[0])return{ok:!1,reason:\`cancelled\`};let dir=result.filePaths[0],modelPath=${pathVar}.join(dir,\`kokoro-v1.0.onnx\`),voicesPath=${pathVar}.join(dir,\`voices-v1.0.bin\`);if(!codexLinuxReadAloudFileExists(modelPath)||!codexLinuxReadAloudFileExists(voicesPath))return{ok:!1,reason:\`missing-files\`,path:dir};let settings=codexLinuxReadAloudSettings();settings[${JSON.stringify(KOKORO_MODEL_KEY)}]=modelPath,settings[${JSON.stringify(KOKORO_VOICES_KEY)}]=voicesPath,codexLinuxReadAloudWriteSettings(settings);return codexLinuxReadAloudSetupResult()}`,
    `async function codexLinuxReadAloudSetup(e={}){if(process.platform!==\`linux\`)return{ok:!1,reason:\`not-linux\`};try{if(e.mode===\`choose-folder\`)return await codexLinuxReadAloudChooseModelDir();if(e.mode===\`download\`){await codexLinuxReadAloudInstallRuntime();await codexLinuxReadAloudDownloadKokoro();return codexLinuxReadAloudSetupResult()}return{ok:!1,reason:\`unknown-mode\`}}catch(t){let n=t?.message??String(t);return{ok:!1,reason:n.includes(\`Python 3.10-3.13\`)?\`python-unavailable\`:\`setup-failed\`,message:n}}}`,
    `function codexLinuxReadAloudReport(e){try{console.info(\`[linux-read-aloud] \${JSON.stringify(e)}\`)}catch{}return e}`,
    `let codexLinuxReadAloudProc=null;function codexLinuxReadAloudStop(){let e=codexLinuxReadAloudProc;codexLinuxReadAloudProc=null;if(!e)return codexLinuxReadAloudReport({stopped:!1,reason:\`idle\`});try{e.pid&&process.kill(-e.pid,\`SIGTERM\`)}catch{try{e.kill?.(\`SIGTERM\`)}catch{}}return codexLinuxReadAloudReport({stopped:!0})}`,
    `function codexLinuxReadAloudSpawn(command,args,options={}){if(!codexLinuxReadAloudCommandExists(command))return!1;try{codexLinuxReadAloudStop();let child=${childProcessVar}.spawn(command,args,{...options,stdio:options.stdio??\`ignore\`,windowsHide:!0,detached:!0,env:{...process.env,...codexLinuxReadAloudAudioEnv(),...(options.env||{})}});codexLinuxReadAloudProc=child,child.on?.(\`exit\`,()=>{codexLinuxReadAloudProc===child&&(codexLinuxReadAloudProc=null)}),child.unref?.();return!0}catch{return!1}}`,
    `function codexLinuxReadAloudSpawnStdin(command,args,text,extraEnv={}){if(!codexLinuxReadAloudCommandExists(command))return!1;try{codexLinuxReadAloudStop();let child=${childProcessVar}.spawn(command,args,{stdio:[\`pipe\`,\`ignore\`,\`ignore\`],windowsHide:!0,detached:!0,env:{...process.env,...codexLinuxReadAloudAudioEnv(),...extraEnv}});codexLinuxReadAloudProc=child,child.on?.(\`exit\`,()=>{codexLinuxReadAloudProc===child&&(codexLinuxReadAloudProc=null)}),child.stdin?.end(text),child.unref?.();return!0}catch{return!1}}`,
    `function codexLinuxReadAloudKokoro(e){let t=codexLinuxReadAloudKokoroMissing();if(t.length)return{spoken:!1,reason:\`kokoro-unavailable\`,missing:t};let n=codexLinuxReadAloudKokoroSpeed(),r={CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON:codexLinuxReadAloudKokoroPython(),CODEX_LINUX_READ_ALOUD_KOKORO_MODEL:codexLinuxReadAloudKokoroModel(),CODEX_LINUX_READ_ALOUD_KOKORO_VOICES:codexLinuxReadAloudKokoroVoices(),CODEX_LINUX_READ_ALOUD_KOKORO_VOICE:codexLinuxReadAloudKokoroVoice(),CODEX_LINUX_READ_ALOUD_KOKORO_SPEED:String(n)};return codexLinuxReadAloudSpawnStdin(codexLinuxReadAloudKokoroRunner(),[],e,r)?{spoken:!0,engine:\`kokoro\`,voice:codexLinuxReadAloudKokoroVoice(),speed:n}:{spoken:!1,reason:\`kokoro-spawn-failed\`}}`,
    `function codexLinuxReadAloudPiper(text,modelPath){let piperBin=process.env.CODEX_LINUX_READ_ALOUD_PIPER_BIN?.trim()||\`piper\`;if(!modelPath||!${fsVar}.existsSync(modelPath)||!codexLinuxReadAloudCommandExists(piperBin)||!codexLinuxReadAloudCommandExists(\`aplay\`))return!1;try{codexLinuxReadAloudStop();let piperOptions={stdio:[\`pipe\`,\`pipe\`,\`ignore\`],windowsHide:!0,detached:!0,env:{...process.env,...codexLinuxReadAloudAudioEnv()}},piper=${childProcessVar}.spawn(piperBin,[\`--model\`,modelPath,\`--output-raw\`],piperOptions),aplay=${childProcessVar}.spawn(\`aplay\`,[\`-q\`,\`-r\`,\`22050\`,\`-c\`,\`1\`,\`-f\`,\`S16_LE\`,\`-t\`,\`raw\`],{stdio:[\`pipe\`,\`ignore\`,\`ignore\`],windowsHide:!0,detached:!0,env:{...process.env,...codexLinuxReadAloudAudioEnv()}});codexLinuxReadAloudProc=piper,piper.on?.(\`exit\`,()=>{codexLinuxReadAloudProc===piper&&(codexLinuxReadAloudProc=null)}),piper.stdout?.pipe(aplay.stdin),piper.stdin?.end(text),piper.unref?.(),aplay.unref?.();return!0}catch{return!1}}`,
    `function codexLinuxReadAloudSpeak(input,options={}){if(process.platform!==\`linux\`)return codexLinuxReadAloudReport({spoken:!1,reason:\`not-linux\`});if(options?.requireEnabled!==!1&&!codexLinuxReadAloudEnabled())return codexLinuxReadAloudReport({spoken:!1,reason:\`disabled\`});let text=codexLinuxReadAloudCleanText(input);if(!text)return codexLinuxReadAloudReport({spoken:!1,reason:\`empty\`});let customCommand=process.env.CODEX_LINUX_READ_ALOUD_COMMAND?.trim();if(customCommand&&codexLinuxReadAloudSpawnStdin(customCommand,[],text))return codexLinuxReadAloudReport({spoken:!0,engine:\`custom\`});let engine=(process.env.CODEX_LINUX_READ_ALOUD_ENGINE?.trim()||\`kokoro\`).toLowerCase(),hasHebrew=codexLinuxReadAloudHasHebrew(text),piperModel=process.env.CODEX_LINUX_READ_ALOUD_PIPER_MODEL?.trim();if(engine===\`piper\`)return codexLinuxReadAloudReport(codexLinuxReadAloudPiper(text,piperModel)?{spoken:!0,engine:\`piper\`}:{spoken:!1,reason:\`piper-unavailable\`});let kokoroResult=codexLinuxReadAloudKokoro(text);if(kokoroResult.spoken)return codexLinuxReadAloudReport(kokoroResult);if(!codexLinuxReadAloudNativeFallbackEnabled())return codexLinuxReadAloudReport(kokoroResult);if(codexLinuxReadAloudPiper(text,piperModel))return codexLinuxReadAloudReport({spoken:!0,engine:\`piper\`});let voice=process.env.CODEX_LINUX_READ_ALOUD_VOICE?.trim(),rate=process.env.CODEX_LINUX_READ_ALOUD_RATE?.trim()||\`-10\`,voiceType=process.env.CODEX_LINUX_READ_ALOUD_VOICE_TYPE?.trim();try{codexLinuxReadAloudCommandExists(\`spd-say\`)&&${childProcessVar}.spawn(\`spd-say\`,[\`-C\`],{stdio:\`ignore\`,windowsHide:!0,env:{...process.env,...codexLinuxReadAloudAudioEnv()}}).unref?.()}catch{}let spdArgs=[\`-r\`,rate,...(voiceType?[\`-t\`,voiceType]:[]),...(voice?[\`-y\`,voice]:[]),\`-l\`,hasHebrew?\`he\`:\`en\`,\`--\`,text];if(codexLinuxReadAloudSpawn(\`spd-say\`,spdArgs))return codexLinuxReadAloudReport({spoken:!0,engine:\`spd-say\`});let espeakVoice=voice||(hasHebrew?\`he\`:\`en-us\`);return codexLinuxReadAloudReport(codexLinuxReadAloudSpawn(\`espeak-ng\`,[\`-v\`,espeakVoice,\`-s\`,process.env.CODEX_LINUX_READ_ALOUD_ESPEAK_RATE?.trim()||\`165\`,\`--\`,text])?{spoken:!0,engine:\`espeak-ng\`}:kokoroResult)}`,
    `function codexLinuxReadAloudHandle(e={}){return e.action===\`config\`?codexLinuxReadAloudConfig():e.action===\`setup\`?codexLinuxReadAloudSetup(e):e.action===\`stop\`?codexLinuxReadAloudStop():e.action===\`speak\`&&e.source===\`button\`?codexLinuxReadAloudSpeak(e.text,{requireEnabled:!1}):codexLinuxReadAloudReport({spoken:!1,reason:\`not-explicit\`})}`,
  ].join("");

  const handler = `"${HANDLER_NAME}":async(e)=>codexLinuxReadAloudHandle(e),`;
  const needle = `"native-desktop-apps":`;
  const handlerIndex = source.indexOf(needle);
  if (handlerIndex === -1) {
    warn("Could not find native-desktop-apps handler", "read aloud main-bundle patch");
    return source;
  }

  const withHandler = source.slice(0, handlerIndex) + handler + source.slice(handlerIndex);
  const helperInsertAt = withHandler.startsWith(`"use strict";`)
    ? `"use strict";`.length
    : withHandler.startsWith(`'use strict';`)
      ? `'use strict';`.length
      : 0;
  return withHandler.slice(0, helperInsertAt) + helper + withHandler.slice(helperInsertAt);
}

function readAloudRuntimeSource() {
  return [
    `;(()=>{const VERSION=${JSON.stringify(RUNTIME_VERSION)};if(globalThis.codexLinuxReadAloudVersion===VERSION)return;globalThis.codexLinuxReadAloudVersion=VERSION;try{globalThis.speechSynthesis?.cancel?.()}catch{}`,
    `const METHOD=${JSON.stringify(HANDLER_NAME)};let seq=0,pending=new Map,currentButton=null,currentSpeakTimer=null;`,
    `function onMessage(e){let t=e?.data;if(!t||typeof t!="object"||t.type!=="fetch-response")return;let n=pending.get(t.requestId);if(!n)return;pending.delete(t.requestId);if(t.responseType==="success"){let e=null;try{e=t.bodyJsonString?JSON.parse(t.bodyJsonString):null}catch{}n.resolve({status:t.status,body:e})}else n.reject(Error(t.error||"fetch failed"))}`,
    `window.addEventListener("message",onMessage);`,
    `function dispatch(payload){let bridge=window.electronBridge,event=new CustomEvent("codex-message-from-view",{detail:payload});if(bridge?.sendMessageFromView){event.__codexForwardedViaBridge=!0;bridge.sendMessageFromView(payload).catch(()=>{})}window.dispatchEvent(event)}`,
    `function log(message,tags={}){dispatch({type:"log-message",level:"info",message,tags:{safe:tags,sensitive:{}}})}`,
    `function post(params,timeoutMs=4000){let requestId="codex-linux-read-aloud-"+ ++seq;let payload={type:"fetch",hostId:"local",requestId,method:"POST",url:"vscode://codex/"+METHOD,body:JSON.stringify(params??{})};return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});setTimeout(()=>{pending.delete(requestId);reject(Error("timeout"))},timeoutMs);dispatch(payload)})}`,
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
    `function installStyle(){if(document.getElementById("codex-linux-read-aloud-style"))return;let e=document.createElement("style");e.id="codex-linux-read-aloud-style";e.textContent=".codex-linux-read-aloud-row{display:flex;align-items:center;margin-top:4px}.codex-linux-read-aloud-button{width:28px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--token-border);background:transparent;color:var(--text-secondary,var(--token-description-foreground));border-radius:6px;padding:0;cursor:pointer}.codex-linux-read-aloud-icon{width:15px;height:15px}.codex-linux-read-aloud-button:hover{background:var(--token-list-hover-background,rgba(127,127,127,.12));color:var(--text-primary,var(--token-foreground))}.codex-linux-read-aloud-button:disabled{opacity:.65;cursor:default}.codex-linux-read-aloud-button[data-codex-linux-read-aloud-state=speaking]{background:var(--token-list-hover-background,rgba(127,127,127,.14));color:var(--text-primary,var(--token-foreground))}.codex-linux-read-aloud-button[data-codex-linux-read-aloud-state=error]{color:var(--token-error-foreground,#c00);border-color:currentColor}";document.head.appendChild(e)}`,
    `installStyle();globalThis.${HELPER_MARKER}=click;globalThis.${SETUP_MARKER}=setup;})();`,
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

function applyAssistantRenderPatch(source) {
  if (source.includes(`globalThis.${HELPER_MARKER}?.(`)) {
    return source;
  }
  const jsxCallPattern =
    /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{(?=[^{}]*\bitem:)(?=[^{}]*\bassistantCopyText:)(?=[^{}]*\bconversationId:)(?=[^{}]*\brenderCodeBlocksAsWritingBlocks:)([^{}]*)\}\)/g;
  const readProp = (props, name) =>
    new RegExp(`(?:^|,)${name}:([A-Za-z_$][\\w$]*)`).exec(props)?.[1] ?? null;
  const patched = source.replace(
    jsxCallPattern,
    (match, jsxVar, _component, props) => {
      const itemVar = readProp(props, "item");
      const copyVar = readProp(props, "assistantCopyText");
      const conversationVar = readProp(props, "conversationId");
      if (itemVar == null || copyVar == null || conversationVar == null) {
        return match;
      }
      return `(0,${jsxVar}.jsxs)(${jsxVar}.Fragment,{children:[${match},${readAloudButtonRowSource(jsxVar, itemVar, copyVar, conversationVar, "e")}]})`;
    },
  );
  if (patched !== source) {
    return patched;
  }

  if (ASSISTANT_RENDER_CANDIDATE_PATTERN.test(source)) {
    warn("Could not find assistant message render call", "read aloud assistant render patch");
  }
  return source;
}

function applySettingsPatch(source) {
  return source
    .replace(`,readAloud:${JSON.stringify(SETTINGS_KEY)}`, "")
    .replace(
      ',$.jsx(LinuxToggle,{settingKey:KEYS.readAloud,label:"Read aloud responses",description:"Show a Read aloud button on assistant responses.",defaultValue:!1})',
      "",
    );
}

function linuxDesktopReadAloudSettingsSource() {
  return [
    `function codexLinuxReadAloudPaceValue(e){let t=Number(e);return Number.isFinite(t)?Math.min(1.4,Math.max(.7,Math.round(t*20)/20)):1.05}`,
    `class LinuxReadAloudSettings extends React.Component{`,
    `constructor(e){super(e),this._alive=!1,this._enabledWrite=0,this._speedWrite=0,this._enabledConfirmed=!1,this._speedConfirmed=1.05,this._enabledQueue=Promise.resolve(),this._speedQueue=Promise.resolve(),this.state={enabled:!1,speed:1.05,isLoading:!0,error:null},this.load=this.load.bind(this),this.updateEnabled=this.updateEnabled.bind(this),this.updateSpeed=this.updateSpeed.bind(this)}`,
    `componentDidMount(){this._alive=!0,this.load()}`,
    `componentWillUnmount(){this._alive=!1}`,
    `load(){this.setState({isLoading:!0}),Promise.allSettled([__post("get-global-state",{params:{key:KEYS.readAloud}}),__post("get-global-state",{params:{key:KEYS.readAloudSpeed}})]).then(([e,t])=>{if(!this._alive)return;let n=e.status==="fulfilled",r=t.status==="fulfilled",i=n?e.value?.value===!0:this.state.enabled,a=r?codexLinuxReadAloudPaceValue(t.value?.value??1.05):this.state.speed,o=e.status==="rejected"?e.reason:t.status==="rejected"?t.reason:null;n&&(this._enabledConfirmed=i),r&&(this._speedConfirmed=a),this.setState({enabled:i,speed:a,error:o==null?null:o instanceof Error?o.message:String(o)})}).finally(()=>{this._alive&&this.setState({isLoading:!1})})}`,
    `updateEnabled(e){let t=codexLinuxChecked(e),n=++this._enabledWrite,r=()=>__post("set-global-state",{params:{key:KEYS.readAloud,value:t}});this.setState({enabled:t,error:null}),this._enabledQueue=this._enabledQueue.then(r,r),this._enabledQueue.then(()=>{this._enabledConfirmed=t,this._alive&&n===this._enabledWrite&&this.setState({enabled:t,error:null})},e=>{this._alive&&n===this._enabledWrite&&this.setState({enabled:this._enabledConfirmed,error:e instanceof Error?e.message:String(e)})})}`,
    `updateSpeed(e){let t=codexLinuxReadAloudPaceValue(e?.currentTarget?.value??e),n=++this._speedWrite,r=()=>__post("set-global-state",{params:{key:KEYS.readAloudSpeed,value:t}});this.setState({speed:t,error:null}),this._speedQueue=this._speedQueue.then(r,r),this._speedQueue.then(()=>{this._speedConfirmed=t,this._alive&&n===this._speedWrite&&this.setState({speed:t,error:null})},e=>{this._alive&&n===this._speedWrite&&this.setState({speed:this._speedConfirmed,error:e instanceof Error?e.message:String(e)})})}`,
    `render(){let{enabled:e,speed:t,isLoading:n,error:r}=this.state,i="rounded-md border border-token-border px-2 py-1 text-sm text-token-text-primary hover:bg-token-surface-secondary disabled:opacity-60",a=r?$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("span",{children:"Show a read aloud button under assistant responses."}),$.jsx("span",{className:"text-token-error-foreground",children:r})]}):"Show a read aloud button under assistant responses.",o=r?$.jsxs("div",{className:"flex flex-col gap-1",children:[$.jsx("span",{children:"Adjust the read aloud speed."}),$.jsx("span",{className:"text-token-error-foreground",children:r})]}):"Adjust the read aloud speed.";return $.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Read Aloud"}),$.jsx(SettingsSection.Content,{children:$.jsxs(SettingsGroup,{children:[$.jsx(SettingsRow,{label:"Read aloud responses",description:a,control:$.jsxs("div",{className:"flex flex-wrap items-center justify-end gap-2",children:[$.jsx(Toggle,{checked:e,disabled:n,onChange:this.updateEnabled,ariaLabel:"Read aloud responses"}),e?$.jsxs("div",{className:"flex flex-wrap items-center justify-end gap-2",children:[$.jsx("button",{type:"button",className:i,onClick:e=>globalThis.${SETUP_MARKER}?.("choose-folder",e.currentTarget),children:"Choose folder"}),$.jsx("button",{type:"button",className:i,onClick:e=>globalThis.${SETUP_MARKER}?.("download",e.currentTarget),children:"Download voice"}),$.jsx("span",{className:"inline-flex h-7 w-7 select-none items-center justify-center rounded-full border border-token-border text-sm text-token-text-secondary",title:"Choose folder expects kokoro-v1.0.onnx and voices-v1.0.bin. Download voice creates a managed Python runtime and downloads the Kokoro files from Hugging Face.","aria-label":"Choose folder expects kokoro-v1.0.onnx and voices-v1.0.bin. Download voice creates a managed Python runtime and downloads the Kokoro files from Hugging Face.",children:"?"})]}):null]})}),e?$.jsx(SettingsRow,{label:"Speech pace",description:o,control:$.jsxs("div",{className:"flex items-center justify-end gap-2",children:[$.jsx("input",{type:"range",min:.7,max:1.4,step:.05,value:t,disabled:n,onChange:this.updateSpeed,"aria-label":"Speech pace",className:"h-2 w-36 accent-token-text-primary"}),$.jsx("span",{className:"w-12 text-right text-sm text-token-text-secondary",children:\`\${t.toFixed(2)}x\`})]})}):null]})})]})}}`,
  ].join("");
}

function replaceLinuxDesktopReadAloudSettings(source) {
  const classMarker = "class LinuxReadAloudSettings extends React.Component";
  const classStart = source.indexOf(classMarker);
  const paceStart = source.lastIndexOf("function codexLinuxReadAloudPaceValue(", classStart);
  const classOpen = source.indexOf("{", classStart + classMarker.length);
  if (classStart === -1 || paceStart === -1 || classOpen === -1) {
    return null;
  }
  const classEnd = findMatchingBrace(source, classOpen);
  if (classEnd === -1 || !source.startsWith("function LinuxDesktopSettings(){", classEnd + 1)) {
    return null;
  }
  return `${source.slice(0, paceStart)}${linuxDesktopReadAloudSettingsSource()}${source.slice(classEnd + 1)}`;
}

function applyLinuxDesktopSettingsPatch(source) {
  if (!source.includes("function LinuxDesktopSettings(){")) {
    return source;
  }

  const buildSectionNeedle =
    '$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Build"}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxBuildInfoPanel,{})})})]})';
  if (!source.includes("$.jsx(LinuxReadAloudSettings,{})") && !source.includes(buildSectionNeedle)) {
    warn("Could not find Linux desktop Build section", "read aloud Linux desktop settings patch");
    return source;
  }

  let patched = source;
  const hasReadAloudSettings = patched.includes(
    "class LinuxReadAloudSettings extends React.Component",
  );
  if (hasReadAloudSettings) {
    const refreshed = replaceLinuxDesktopReadAloudSettings(patched);
    if (refreshed == null) {
      warn("Could not refresh existing Linux read aloud settings", "read aloud Linux desktop settings patch");
      return source;
    }
    patched = refreshed;
  }
  if (!patched.includes(`readAloud:${JSON.stringify(SETTINGS_KEY)}`)) {
    const keyNeedle = `autoUpdateOnExit:${JSON.stringify(linuxSettingsKeys.autoUpdateOnExit)}`;
    const keyBoundary = `${keyNeedle}};function codexLinuxChecked`;
    if (!patched.includes(keyBoundary)) {
      warn("Could not find current Linux desktop settings key boundary", "read aloud Linux desktop settings patch");
      return source;
    }
    patched = patched.replace(
      keyBoundary,
      `${keyNeedle},readAloud:${JSON.stringify(SETTINGS_KEY)},readAloudSpeed:${JSON.stringify(KOKORO_SPEED_KEY)}};function codexLinuxChecked`,
    );
  }

  if (!hasReadAloudSettings) {
    patched = patched.replace(
      "function LinuxDesktopSettings(){",
      `${linuxDesktopReadAloudSettingsSource()}function LinuxDesktopSettings(){`,
    );
  }

  if (!patched.includes("$.jsx(LinuxReadAloudSettings,{})")) {
    patched = patched.replace(buildSectionNeedle, `$.jsx(LinuxReadAloudSettings,{}),${buildSectionNeedle}`);
  }

  return patched;
}

function generalSettingsReadAloudRowSource() {
  return `function codexLinuxReadAloudPaceValue(e){let t=Number(e);return Number.isFinite(t)?Math.min(1.4,Math.max(.7,Math.round(t*20)/20)):1.05}function codexLinuxReadAloudSettingsRow(){let e=w(C),t=N(),{data:n,isLoading:r}=L(${JSON.stringify(SETTINGS_KEY)}),{data:i,isLoading:a}=L(${JSON.stringify(KOKORO_SPEED_KEY)}),o=n===!0,s=codexLinuxReadAloudPaceValue(i),c=(0,$.jsx)(F,{id:\`settings.general.readAloud.label\`,defaultMessage:\`Read aloud responses\`,description:\`Label for Linux read aloud setting\`}),l=(0,$.jsx)(F,{id:\`settings.general.readAloud.description\`,defaultMessage:\`Show a read aloud button under assistant responses. If the Kokoro voice files are missing, choose a local folder or download them.\`,description:\`Description for Linux read aloud setting\`}),u=(0,$.jsx)(F,{id:\`settings.general.readAloud.pace.label\`,defaultMessage:\`Speech pace\`,description:\`Label for Linux read aloud pace setting\`}),d=(0,$.jsx)(F,{id:\`settings.general.readAloud.pace.description\`,defaultMessage:\`Adjust the read aloud speed\`,description:\`Description for Linux read aloud pace setting\`}),f=n=>{P(e,${JSON.stringify(SETTINGS_KEY)},n)},p=t.formatMessage({id:\`settings.general.readAloud.label\`,defaultMessage:\`Read aloud responses\`,description:\`Label for Linux read aloud setting\`}),m=t.formatMessage({id:\`settings.general.readAloud.chooseFolder\`,defaultMessage:\`Choose folder\`,description:\`Button label for choosing an existing Kokoro model folder\`}),h=t.formatMessage({id:\`settings.general.readAloud.downloadVoice\`,defaultMessage:\`Download voice\`,description:\`Button label for downloading the Kokoro voice model\`}),g=t.formatMessage({id:\`settings.general.readAloud.pace.label\`,defaultMessage:\`Speech pace\`,description:\`Label for Linux read aloud pace setting\`}),x=t.formatMessage({id:\`settings.general.readAloud.help\`,defaultMessage:\`Choose folder expects kokoro-v1.0.onnx and voices-v1.0.bin. Download voice creates a managed Python runtime and downloads the Kokoro files from Hugging Face.\`,description:\`Help text for Linux read aloud setup actions\`}),_=n=>{P(e,${JSON.stringify(KOKORO_SPEED_KEY)},codexLinuxReadAloudPaceValue(n.currentTarget.value))},v=\`rounded-md border border-token-border px-2 py-1 text-sm text-token-text-primary hover:bg-token-surface-secondary disabled:opacity-60\`,y=\`h-2 w-36 accent-token-text-primary\`,b=(0,$.jsxs)(\`div\`,{className:\`flex items-center justify-end gap-2\`,children:[(0,$.jsx)(\`input\`,{type:\`range\`,min:.7,max:1.4,step:.05,value:s,disabled:a,onChange:_,"aria-label":g,className:y}),(0,$.jsx)(\`span\`,{className:\`w-12 text-right text-sm text-token-text-secondary\`,children:\`\${s.toFixed(2)}x\`})]});return(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(J,{label:c,description:l,control:(0,$.jsxs)(\`div\`,{className:\`flex flex-wrap items-center justify-end gap-2\`,children:[(0,$.jsx)(q,{checked:o,disabled:r,onChange:f,ariaLabel:p}),o?(0,$.jsxs)(\`div\`,{className:\`flex flex-wrap items-center justify-end gap-2\`,children:[(0,$.jsx)(\`button\`,{type:\`button\`,className:v,onClick:e=>globalThis.${SETUP_MARKER}?.(\`choose-folder\`,e.currentTarget),children:m}),(0,$.jsx)(\`button\`,{type:\`button\`,className:v,onClick:e=>globalThis.${SETUP_MARKER}?.(\`download\`,e.currentTarget),children:h}),(0,$.jsx)(\`span\`,{className:\`inline-flex h-7 w-7 select-none items-center justify-center rounded-full border border-token-border text-sm text-token-text-secondary\`,title:x,"aria-label":x,children:\`?\`})]}):null]})}),o?(0,$.jsx)(J,{label:u,description:d,control:b}):null]})}`;
}

function generalSettingsReadAloudPageSource() {
  return `function codexLinuxReadAloudSettingsPage(){return(0,$.jsx)(pt,{title:(0,$.jsx)(F,{id:\`settings.readAloud.title\`,defaultMessage:\`Read Aloud\`,description:\`Title for Linux read aloud settings section\`}),subtitle:(0,$.jsx)(F,{id:\`settings.readAloud.subtitle\`,defaultMessage:\`Listen to assistant responses with a local Kokoro voice.\`,description:\`Subtitle for Linux read aloud settings section\`}),children:(0,$.jsx)(K,{electron:!0,children:(0,$.jsxs)(Y,{children:[(0,$.jsx)(Y.Header,{title:(0,$.jsx)(F,{id:\`settings.readAloud.voice.title\`,defaultMessage:\`Voice\`,description:\`Title for Linux read aloud voice settings group\`})}),(0,$.jsx)(Y.Content,{children:(0,$.jsx)(ht,{children:(0,$.jsx)(codexLinuxReadAloudSettingsRow,{})})})]})})})}`;
}

function generalSettingsReadAloudBlockSource() {
  return `${generalSettingsReadAloudRowSource()}${generalSettingsReadAloudPageSource()}`;
}

function importAlias(source, assetPrefix, exportName) {
  const escapedPrefix = assetPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`import\\{([^}]*)\\}from"\\.\\/${escapedPrefix}-[^"]+\\.js";`));
  if (match == null) {
    return null;
  }
  for (const part of match[1].split(",")) {
    const trimmed = part.trim();
    const aliased = trimmed.match(/^([A-Za-z_$][\w$]*) as ([A-Za-z_$][\w$]*)$/);
    if (aliased != null && aliased[1] === exportName) {
      return aliased[2];
    }
    if (trimmed === exportName) {
      return exportName;
    }
  }
  return null;
}

function detectJsxAlias(source) {
  const jsxFactory = importAlias(source, "jsx-runtime", "t");
  if (jsxFactory != null) {
    const match = source.match(new RegExp(`\\b([A-Za-z_$][\\w$]*)=${jsxFactory}\\(\\)`));
    if (match != null) {
      return match[1];
    }
  }
  return "$";
}

function detectReactAlias(source) {
  const reactFactory = importAlias(source, "jsx-runtime", "n");
  if (reactFactory != null) {
    const match = source.match(new RegExp(`\\b([A-Za-z_$][\\w$]*)=[A-Za-z_$][\\w$]*\\(${reactFactory}\\(\\),1\\)`));
    if (match != null) {
      return match[1];
    }
  }
  return "X";
}

function settingsRowAlias(source) {
  return importAlias(source, "settings-row", "r") ?? importAlias(source, "settings-row", "n") ?? "J";
}

function formatHookAlias(source) {
  return importAlias(source, "lib", "l") ?? importAlias(source, "lib", "c") ?? "N";
}

function formattedMessageAlias(source) {
  return importAlias(source, "lib", "s") ?? importAlias(source, "lib", "o") ?? "P";
}

function currentSettingsAliasesNeedRefresh(source) {
  const jsx = detectJsxAlias(source);
  const settingsRow = settingsRowAlias(source);
  const formatHook = formatHookAlias(source);
  const formattedMessage = formattedMessageAlias(source);
  return !(
    source.includes(`(0,${jsx}.jsx)(${settingsRow},{label:l,`) &&
    source.includes(`c=${formatHook}();`) &&
    source.includes("codexLinuxReadAloudChooseFolderLabel=c.formatMessage") &&
    source.includes(`(0,${jsx}.jsx)(${formattedMessage},{id:\`settings.general.readAloud.label\``) &&
    source.includes(`(0,${jsx}.jsx)(${formattedMessage},{id:\`settings.readAloud.title\``)
  );
}

function currentGeneralSettingsReadAloudBlockSource(source) {
  const jsx = detectJsxAlias(source);
  const react = detectReactAlias(source);
  const settingsPage = importAlias(source, "settings-content-layout", "t") ?? "St";
  const settingsRow = settingsRowAlias(source);
  const toggle = importAlias(source, "toggle", "t") ?? "G";
  const formatHook = formatHookAlias(source);
  const formattedMessage = formattedMessageAlias(source);
  const postGlobalState = importAlias(source, "vscode-api", "n") ?? "k";

  return `/*${CURRENT_SETTINGS_BLOCK_MARKER}*/function codexLinuxReadAloudPaceValue(e){let t=Number(e);return Number.isFinite(t)?Math.min(1.4,Math.max(.7,Math.round(t*20)/20)):1.05}function codexLinuxReadAloudSettingsRow(){let[e,t]=(0,${react}.useState)(!1),[n,r]=(0,${react}.useState)(1.05),[i,a]=(0,${react}.useState)(!0),[o,s]=(0,${react}.useState)(null),c=${formatHook}();(0,${react}.useEffect)(()=>{let e=!0;return a(!0),Promise.all([${postGlobalState}(\`get-global-state\`,{params:{key:${JSON.stringify(SETTINGS_KEY)}}}),${postGlobalState}(\`get-global-state\`,{params:{key:${JSON.stringify(KOKORO_SPEED_KEY)}}})]).then(([n,i])=>{e&&(t(n?.value===!0),r(codexLinuxReadAloudPaceValue(i?.value??1.05)),s(null))}).catch(t=>{e&&s(t instanceof Error?t.message:String(t))}).finally(()=>{e&&a(!1)}),()=>{e=!1}},[]);let l=(0,${jsx}.jsx)(${formattedMessage},{id:\`settings.general.readAloud.label\`,defaultMessage:\`Read aloud responses\`,description:\`Label for Linux read aloud setting\`}),u=(0,${jsx}.jsx)(${formattedMessage},{id:\`settings.general.readAloud.description\`,defaultMessage:\`Show a read aloud button under assistant responses. If the Kokoro voice files are missing, choose a local folder or download them.\`,description:\`Description for Linux read aloud setting\`}),d=(0,${jsx}.jsx)(${formattedMessage},{id:\`settings.general.readAloud.pace.label\`,defaultMessage:\`Speech pace\`,description:\`Label for Linux read aloud pace setting\`}),f=(0,${jsx}.jsx)(${formattedMessage},{id:\`settings.general.readAloud.pace.description\`,defaultMessage:\`Adjust the read aloud speed\`,description:\`Description for Linux read aloud pace setting\`}),codexLinuxReadAloudToggleLabel=c.formatMessage({id:\`settings.general.readAloud.label\`,defaultMessage:\`Read aloud responses\`,description:\`Label for Linux read aloud setting\`}),codexLinuxReadAloudChooseFolderLabel=c.formatMessage({id:\`settings.general.readAloud.chooseFolder\`,defaultMessage:\`Choose folder\`,description:\`Button label for choosing an existing Kokoro model folder\`}),codexLinuxReadAloudDownloadVoiceLabel=c.formatMessage({id:\`settings.general.readAloud.downloadVoice\`,defaultMessage:\`Download voice\`,description:\`Button label for downloading the Kokoro voice model\`}),codexLinuxReadAloudPaceLabel=c.formatMessage({id:\`settings.general.readAloud.pace.label\`,defaultMessage:\`Speech pace\`,description:\`Label for Linux read aloud pace setting\`}),codexLinuxReadAloudHelpLabel=c.formatMessage({id:\`settings.general.readAloud.help\`,defaultMessage:\`Choose folder expects kokoro-v1.0.onnx and voices-v1.0.bin. Download voice creates a managed Python runtime and downloads the Kokoro files from Hugging Face.\`,description:\`Help text for Linux read aloud setup actions\`}),v=e=>{let n=e;t(n),s(null),${postGlobalState}(\`set-global-state\`,{params:{key:${JSON.stringify(SETTINGS_KEY)},value:n}}).catch(e=>{t(!n),s(e instanceof Error?e.message:String(e))})},y=e=>{let t=codexLinuxReadAloudPaceValue(e.currentTarget.value);r(t),s(null),${postGlobalState}(\`set-global-state\`,{params:{key:${JSON.stringify(KOKORO_SPEED_KEY)},value:t}}).catch(e=>{s(e instanceof Error?e.message:String(e))})},b=\`rounded-md border border-token-border px-2 py-1 text-sm text-token-text-primary hover:bg-token-surface-secondary disabled:opacity-60\`,x=(0,${jsx}.jsxs)(\`div\`,{className:\`flex items-center justify-end gap-2\`,children:[(0,${jsx}.jsx)(\`input\`,{type:\`range\`,min:.7,max:1.4,step:.05,value:n,disabled:i,onChange:y,"aria-label":codexLinuxReadAloudPaceLabel,className:\`h-2 w-36 accent-token-text-primary\`}),(0,${jsx}.jsx)(\`span\`,{className:\`w-12 text-right text-sm text-token-text-secondary\`,children:\`\${n.toFixed(2)}x\`})]}),C=o?(0,${jsx}.jsx)(\`div\`,{className:\`text-sm text-token-text-secondary\`,children:o}):null;return(0,${jsx}.jsxs)(${jsx}.Fragment,{children:[(0,${jsx}.jsx)(${settingsRow},{label:l,description:(0,${jsx}.jsxs)(${jsx}.Fragment,{children:[u,C]}),control:(0,${jsx}.jsxs)(\`div\`,{className:\`flex flex-wrap items-center justify-end gap-2\`,children:[(0,${jsx}.jsx)(${toggle},{checked:e===!0,disabled:i,onChange:v,ariaLabel:codexLinuxReadAloudToggleLabel}),e?(0,${jsx}.jsxs)(\`div\`,{className:\`flex flex-wrap items-center justify-end gap-2\`,children:[(0,${jsx}.jsx)(\`button\`,{type:\`button\`,className:b,onClick:e=>globalThis.${SETUP_MARKER}?.(\`choose-folder\`,e.currentTarget),children:codexLinuxReadAloudChooseFolderLabel}),(0,${jsx}.jsx)(\`button\`,{type:\`button\`,className:b,onClick:e=>globalThis.${SETUP_MARKER}?.(\`download\`,e.currentTarget),children:codexLinuxReadAloudDownloadVoiceLabel}),(0,${jsx}.jsx)(\`span\`,{className:\`inline-flex h-7 w-7 select-none items-center justify-center rounded-full border border-token-border text-sm text-token-text-secondary\`,title:codexLinuxReadAloudHelpLabel,"aria-label":codexLinuxReadAloudHelpLabel,children:\`?\`})]}):null]})}),e?(0,${jsx}.jsx)(${settingsRow},{label:d,description:f,control:x}):null]})}function codexLinuxReadAloudSettingsPage(){return(0,${jsx}.jsx)(${settingsPage},{title:(0,${jsx}.jsx)(${formattedMessage},{id:\`settings.readAloud.title\`,defaultMessage:\`Read Aloud\`,description:\`Title for Linux read aloud settings section\`}),subtitle:(0,${jsx}.jsx)(${formattedMessage},{id:\`settings.readAloud.subtitle\`,defaultMessage:\`Listen to assistant responses with a local Kokoro voice.\`,description:\`Subtitle for Linux read aloud settings section\`}),children:(0,${jsx}.jsx)(\`div\`,{className:\`max-w-3xl\`,children:(0,${jsx}.jsx)(codexLinuxReadAloudSettingsRow,{})})})}`;
}

function exportedGeneralSettingsFunctionName(source) {
  const exportMatch = source.match(/export\{([^}]*)\};/);
  if (exportMatch == null) {
    return null;
  }
  for (const exportEntry of exportMatch[1].split(",")) {
    const match = exportEntry.trim().match(/^([A-Za-z_$][\w$]*) as r$/);
    if (match != null) {
      return match[1];
    }
  }
  return null;
}

function replaceExistingGeneralSettingsReadAloudRow(source, functionName, blockSource) {
  const rowStart = source.indexOf("function codexLinuxReadAloudSettingsRow(){");
  if (rowStart === -1) {
    return source;
  }
  const paceStart = source.indexOf("function codexLinuxReadAloudPaceValue(");
  let start = paceStart !== -1 && paceStart < rowStart ? paceStart : rowStart;
  const end = source.indexOf(`function ${functionName}(){`, rowStart);
  if (end === -1) {
    return source;
  }
  const marker = `/*${CURRENT_SETTINGS_BLOCK_MARKER}*/`;
  const markerStart = source.lastIndexOf(marker, start);
  if (markerStart !== -1 && source.slice(markerStart + marker.length, start).trim() === "") {
    start = markerStart;
  }
  return `${source.slice(0, start)}${blockSource}${source.slice(end)}`;
}

function removeGeneralSettingsRowPlacement(source) {
  return source
    .replace(GENERAL_SETTINGS_CHILDREN_WITH_ROW, GENERAL_SETTINGS_CHILDREN)
    .replace(GENERAL_SETTINGS_CHILDREN_WITH_OLD_ROW, GENERAL_SETTINGS_CHILDREN);
}

function applyGeneralSettingsPatch(source) {
  const functionName = exportedGeneralSettingsFunctionName(source) ?? (source.includes("function Gn(){") ? "Gn" : null);
  if (functionName == null) {
    return source;
  }
  const functionNeedle = `function ${functionName}(){`;
  if (!source.includes(functionNeedle)) {
    return source;
  }
  const blockSource = functionName === "Gn"
    ? generalSettingsReadAloudBlockSource()
    : currentGeneralSettingsReadAloudBlockSource(source);
  let patched = source;
  if (patched.includes(SETTINGS_KEY)) {
    const needsCurrentAliasRefresh =
      functionName !== "Gn" &&
      patched.includes("function codexLinuxReadAloudSettingsPage") &&
      !patched.includes(CURRENT_SETTINGS_BLOCK_MARKER);
    const needsCurrentSettingsAliasRefresh =
      functionName !== "Gn" &&
      patched.includes(CURRENT_SETTINGS_BLOCK_MARKER) &&
      currentSettingsAliasesNeedRefresh(patched);
    if (
      needsCurrentAliasRefresh ||
      needsCurrentSettingsAliasRefresh ||
      !patched.includes(KOKORO_SPEED_KEY) ||
      !patched.includes("settings.general.readAloud.chooseFolder") ||
      !patched.includes("settings.general.readAloud.help") ||
      !patched.includes("function codexLinuxReadAloudSettingsPage")
    ) {
      patched = replaceExistingGeneralSettingsReadAloudRow(patched, functionName, blockSource);
    }
  } else {
    patched = patched.replace(functionNeedle, `${blockSource}${functionNeedle}`);
  }
  return ensureReadAloudRuntime(applyGeneralSettingsExportPatch(removeGeneralSettingsRowPlacement(patched)));
}

function applyGeneralSettingsExportPatch(source) {
  if (source.includes("codexLinuxReadAloudSettingsPage as ReadAloudSettings")) {
    return source;
  }
  const currentExport = "export{Yn as i,Jn as n,Gn as r,fr as t};";
  const patchedExport = "export{Yn as i,Jn as n,Gn as r,fr as t,codexLinuxReadAloudSettingsPage as ReadAloudSettings};";
  if (source.includes(currentExport)) {
    return source.replace(currentExport, patchedExport);
  }
  const exportPattern = /export\{([^}]*)\};/;
  if (exportPattern.test(source)) {
    return source.replace(exportPattern, (_match, exports) =>
      exports.includes("codexLinuxReadAloudSettingsPage as ReadAloudSettings")
        ? _match
        : `export{${exports},codexLinuxReadAloudSettingsPage as ReadAloudSettings};`,
    );
  }
  return source;
}

function applyGeneralSettingsWrapperPatch(source) {
  if (!source.includes("GeneralSettings") || !source.includes("general-settings-")) {
    return source;
  }
  const wrapperSource = (generalAlias, readAloudAlias, innerAsset) =>
    `import{r as ${generalAlias},ReadAloudSettings as ${readAloudAlias}}from"${innerAsset}";export{${generalAlias} as GeneralSettings,${readAloudAlias} as ReadAloudSettings};`;
  const correctWrapperPattern =
    /import\{r as ([A-Za-z_$][\w$]*),ReadAloudSettings as ([A-Za-z_$][\w$]*)\}from"(\.\/general-settings-[^"]+\.js)";export\{\1 as GeneralSettings,\2 as ReadAloudSettings\};/;
  if (correctWrapperPattern.test(source)) {
    return source;
  }
  const wrapperRegex =
    /import\{r as ([A-Za-z_$][\w$]*)\}from"(\.\/general-settings-[^"]+\.js)";/;
  const wrapperMatch = source.match(wrapperRegex);
  if (wrapperMatch == null) {
    return source;
  }
  const [, generalAlias, innerAsset] = wrapperMatch;
  const readAloudAlias = "codexLinuxReadAloudSettings";
  const exportRegex = new RegExp(
    `export\\{${generalAlias} as GeneralSettings(?:,${generalAlias} as ReadAloudSettings)?\\};`,
  );
  if (!exportRegex.test(source)) {
    return source;
  }
  return source
    .replace(wrapperRegex, `import{r as ${generalAlias},ReadAloudSettings as ${readAloudAlias}}from"${innerAsset}";`)
    .replace(exportRegex, `export{${generalAlias} as GeneralSettings,${readAloudAlias} as ReadAloudSettings};`);
}

function applySettingsSectionsNavPatch(source) {
  if (source.includes(`slug:\`${READ_ALOUD_SETTINGS_SLUG}\``)) {
    return source;
  }
  const slugNeedle = "{slug:`computer-use`},{slug:`mcp-settings`}";
  if (source.includes(slugNeedle)) {
    return source.replace(
      slugNeedle,
      `{slug:\`computer-use\`},{slug:\`${READ_ALOUD_SETTINGS_SLUG}\`},{slug:\`mcp-settings\`}`,
    );
  }
  return source;
}

function applySettingsSharedNavPatch(source) {
  let patched = source;
  if (!patched.includes("settings.nav.read-aloud-settings")) {
    const navNeedle =
      '"computer-use":{id:`settings.nav.computer-use`,defaultMessage:`Computer use`,description:`Title for computer use settings section`},';
    const navPatch =
      `${navNeedle}"read-aloud-settings":{id:\`settings.nav.read-aloud-settings\`,defaultMessage:\`Read Aloud\`,description:\`Title for Read Aloud settings section\`},`;
    patched = patched.replace(navNeedle, navPatch);
  }
  if (!patched.includes("settings.section.read-aloud-settings")) {
    const sectionNeedle = "case`browser-use`:{";
    const sectionPatch =
      "case`read-aloud-settings`:{return (0,d.jsx)(r,{id:`settings.section.read-aloud-settings`,defaultMessage:`Read Aloud`,description:`Title for Read Aloud settings section`})}case`browser-use`:{";
    patched = patched.replace(sectionNeedle, sectionPatch);
  }
  return patched;
}

function detectSettingsPageJsxRuntime(source) {
  const iconMatch = source.match(
    /(?:var |let |const |[,;(])([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*=>\(0,([A-Za-z_$][\w$]*)\.jsxs\)\(\`svg\`,/,
  );
  return iconMatch?.[2] ?? "Z";
}

function readAloudSettingsNavIconExpression(jsxVar = "Z", fallbackIcon = null) {
  const customIcon = `(0,${jsxVar}.jsxs)(\`svg\`,{width:16,height:16,viewBox:\`0 0 16 16\`,fill:\`none\`,xmlns:\`http://www.w3.org/2000/svg\`,...e,children:[(0,${jsxVar}.jsx)(\`path\`,{d:\`M7.25 3.25 4.35 5.7H2.75A1.25 1.25 0 0 0 1.5 6.95v2.1c0 .69.56 1.25 1.25 1.25h1.6l2.9 2.45c.5.42 1.25.06 1.25-.59V3.84c0-.65-.75-1.01-1.25-.59Z\`,fill:\`currentColor\`}),(0,${jsxVar}.jsx)(\`path\`,{d:\`M10.25 6.1a2.7 2.7 0 0 1 0 3.8\`,stroke:\`currentColor\`,strokeWidth:1.2,strokeLinecap:\`round\`}),(0,${jsxVar}.jsx)(\`path\`,{d:\`M12.25 4.45a5.05 5.05 0 0 1 0 7.1\`,stroke:\`currentColor\`,strokeWidth:1.2,strokeLinecap:\`round\`})]})`;
  if (fallbackIcon == null) {
    return `(e=>${customIcon})`;
  }
  return `(e=>{try{return ${customIcon}}catch(t){return ${fallbackIcon}(e)}})`;
}

function hasReadAloudSettingsIconDeclaration(source) {
  return /(?:^|[;\n])\s*(?:var|let|const)\s+codexLinuxReadAloudSettingsIcon(?:[=,;])/.test(source);
}

function declareLegacyReadAloudSettingsIconIfNeeded(source) {
  if (
    !source.includes("codexLinuxReadAloudSettingsIcon=e=>") ||
    hasReadAloudSettingsIconDeclaration(source)
  ) {
    return source;
  }
  let insertionIndex = 0;
  while (source.startsWith("import", insertionIndex)) {
    const statementEnd = source.indexOf(";", insertionIndex);
    if (statementEnd === -1) {
      break;
    }
    insertionIndex = statementEnd + 1;
  }
  return `${source.slice(0, insertionIndex)}var codexLinuxReadAloudSettingsIcon;${source.slice(insertionIndex)}`;
}

function applySettingsPageNavPatch(source) {
  let patched = declareLegacyReadAloudSettingsIconIfNeeded(source);
  const jsxVar = detectSettingsPageJsxRuntime(patched);
  const staleReadAloudIconRegex =
    /("computer-use":([A-Za-z_$][\w$]*),"read-aloud-settings":)(codexLinuxReadAloudSettingsIcon|[A-Za-z_$][\w$]*)(,"local-environments")/;
  if (staleReadAloudIconRegex.test(patched)) {
    patched = patched.replace(
      staleReadAloudIconRegex,
      (_match, prefix, computerUseIcon, _staleIcon, suffix) =>
        `${prefix}${readAloudSettingsNavIconExpression(jsxVar, computerUseIcon)}${suffix}`,
    );
  } else if (!patched.includes(`"read-aloud-settings":`)) {
    const iconMapRegex =
      /("browser-use":[A-Za-z_$][\w$]*,"computer-use":([A-Za-z_$][\w$]*),)(?!"read-aloud-settings":)/;
    if (iconMapRegex.test(patched)) {
      patched = patched.replace(
        iconMapRegex,
        (_match, prefix, computerUseIcon) =>
          `${prefix}"read-aloud-settings":${readAloudSettingsNavIconExpression(
            jsxVar,
            computerUseIcon,
          )},`,
      );
    } else {
      patched = patched.replace(
        `"computer-use":oe,"local-environments"`,
        `"computer-use":oe,"read-aloud-settings":${readAloudSettingsNavIconExpression(
          jsxVar,
          "oe",
        )},"local-environments"`,
      );
      patched = patched.replace(
        `"computer-use":oe,"read-aloud-settings":G,"local-environments"`,
        `"computer-use":oe,"read-aloud-settings":${readAloudSettingsNavIconExpression(
          jsxVar,
          "oe",
        )},"local-environments"`,
      );
    }
  }
  if (!patched.includes("`computer-use`,`read-aloud-settings`,`data-controls`")) {
    patched = patched.replace(
      "`browser-use`,`computer-use`,`data-controls`",
      "`browser-use`,`computer-use`,`read-aloud-settings`,`data-controls`",
    );
  }
  if (!patched.includes("`computer-use`,`read-aloud-settings`,`local-environments`")) {
    patched = patched.replace(
      "`browser-use`,`computer-use`,`local-environments`",
      "`browser-use`,`computer-use`,`read-aloud-settings`,`local-environments`",
    );
  }
  if (!patched.includes("case`read-aloud-settings`:return!0;case`computer-use`")) {
    const staleVisibilityRegex =
      /case`read-aloud-settings`:return[^;]+;(case`computer-use`:return\s*[A-Za-z_$][\w$]*;)/;
    const currentVisibilityRegex = /(case`computer-use`:return\s*[A-Za-z_$][\w$]*;)/;
    if (staleVisibilityRegex.test(patched)) {
      patched = patched.replace(staleVisibilityRegex, "case`read-aloud-settings`:return!0;$1");
    } else {
      patched = patched.replace(
        currentVisibilityRegex,
        "case`read-aloud-settings`:return!0;$1",
      );
    }
  }
  if (!/case`read-aloud-settings`:[A-Za-z_$][\w$]*=!1;break bb0;case`computer-use`/.test(patched)) {
    const currentLoadingCaseRegex =
      /case`computer-use`:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.isLoading\|\|([A-Za-z_$][\w$]*)\.isLoading;break bb0;/;
    if (currentLoadingCaseRegex.test(patched)) {
      patched = patched.replace(
        currentLoadingCaseRegex,
        "case`read-aloud-settings`:$1=!1;break bb0;case`computer-use`:$1=$2.isLoading||$3.isLoading;break bb0;",
      );
    } else {
      patched = patched.replace(
        "case`computer-use`:z=k.isLoading||m.isLoading;break bb0;",
        "case`read-aloud-settings`:z=!1;break bb0;case`computer-use`:z=k.isLoading||m.isLoading;break bb0;",
      );
    }
  }
  return patched;
}

function applyAppMainRoutePatch(source) {
  if (source.includes(`"${READ_ALOUD_SETTINGS_SLUG}":`)) {
    return source;
  }
  const generalRouteStart = source.indexOf('"general-settings":');
  if (generalRouteStart === -1) {
    return source;
  }
  const nextRouteStart = source.indexOf(',"keyboard-shortcuts":', generalRouteStart);
  if (nextRouteStart === -1) {
    return source;
  }
  const generalRoute = source.slice(generalRouteStart, nextRouteStart);
  const readAloudRoute = generalRoute
    .replace('"general-settings":', `"${READ_ALOUD_SETTINGS_SLUG}":`)
    .replace(/e=>\(\{default:e\.GeneralSettings\}\)/, "e=>({default:e.ReadAloudSettings})");
  if (readAloudRoute === generalRoute || !readAloudRoute.includes("ReadAloudSettings")) {
    return source;
  }
  return `${source.slice(0, generalRouteStart)}${readAloudRoute},${source.slice(generalRouteStart)}`;
}

function patchMatchingAssets(assetsDir, pattern, apply) {
  let matched = false;
  let changed = 0;
  for (const candidate of fs.readdirSync(assetsDir).filter((name) => pattern.test(name)).sort()) {
    const assetPath = path.join(assetsDir, candidate);
    const source = fs.readFileSync(assetPath, "utf8");
    const patched = apply(source);
    if (patched === source) {
      continue;
    }
    fs.writeFileSync(assetPath, patched, "utf8");
    matched = true;
    changed += 1;
  }
  return { matched, changed };
}

function applySettingsAssetPatch(extractedDir) {
  let matched = false;
  let changed = 0;
  const keybindsAssetPath = path.join(extractedDir, "webview", "assets", "keybinds-settings-linux.js");
  if (fs.existsSync(keybindsAssetPath)) {
    const source = fs.readFileSync(keybindsAssetPath, "utf8");
    const patched = applySettingsPatch(source);
    matched = true;
    if (patched !== source) {
      fs.writeFileSync(keybindsAssetPath, patched, "utf8");
      changed += 1;
    }
  }

  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    return { matched, changed, reason: "webview assets directory not found" };
  }

  const linuxDesktopAssetPath = path.join(assetsDir, "linux-desktop-settings-linux.js");
  if (fs.existsSync(linuxDesktopAssetPath)) {
    const source = fs.readFileSync(linuxDesktopAssetPath, "utf8");
    const patched = applyLinuxDesktopSettingsPatch(source);
    if (patched !== source) {
      fs.writeFileSync(linuxDesktopAssetPath, patched, "utf8");
      changed += 1;
      matched = true;
    } else if (source.includes(SETTINGS_KEY) || source.includes("LinuxReadAloudSettings")) {
      matched = true;
    }
  }

  const generalCandidates = fs
    .readdirSync(assetsDir)
    .filter((name) => /^general-settings-.*\.js$/.test(name))
    .sort();
  for (const candidate of generalCandidates) {
    const assetPath = path.join(assetsDir, candidate);
    const source = fs.readFileSync(assetPath, "utf8");
    let patched = applyGeneralSettingsPatch(source);
    patched = applyGeneralSettingsWrapperPatch(patched);
    if (patched !== source) {
      fs.writeFileSync(assetPath, patched, "utf8");
      changed += 1;
      matched = true;
    } else if (source.includes(SETTINGS_KEY) || source.includes("ReadAloudSettings")) {
      matched = true;
    }
  }

  for (const assetPatch of [
    [/^settings-sections-.*\.js$/, applySettingsSectionsNavPatch],
    [/^settings-shared-.*\.js$/, applySettingsSharedNavPatch],
    [/^settings-page-.*\.js$/, applySettingsPageNavPatch],
    [/^app-main-.*\.js$/, applyAppMainRoutePatch],
  ]) {
    const result = patchMatchingAssets(assetsDir, assetPatch[0], assetPatch[1]);
    matched = matched || result.matched;
    changed += result.changed;
  }

  return matched
    ? { matched: true, changed }
    : { matched: false, changed: 0, reason: "settings asset insertion point not found" };
}

function applyWebviewPatch(source) {
  const assistantPatched = applyAssistantRenderPatch(source);
  const alreadyHasButton = source.includes(`globalThis.${HELPER_MARKER}?.(`);
  if (assistantPatched === source && !alreadyHasButton) {
    if (!ASSISTANT_RENDER_CANDIDATE_PATTERN.test(source)) {
      warn("Could not find assistant message render call", "read aloud assistant render patch");
    }
    return source;
  }
  return applyIndexRuntimePatch(assistantPatched);
}

module.exports = {
  applyAppMainRoutePatch,
  applyGeneralSettingsPatch,
  applyGeneralSettingsWrapperPatch,
  applyAssistantRenderPatch,
  applyIndexRuntimePatch,
  applyMainBundlePatch,
  applySettingsAssetPatch,
  applySettingsPageNavPatch,
  applyLinuxDesktopSettingsPatch,
  applySettingsPatch,
  applySettingsSectionsNavPatch,
  applySettingsSharedNavPatch,
  descriptors: [
    {
      id: "main-handler",
      phase: "main-bundle",
      order: 20600,
      ciPolicy: "optional",
      apply: applyMainBundlePatch,
    },
    {
      id: "assistant-runtime",
      phase: "webview-asset",
      order: 20620,
      ciPolicy: "optional",
      pattern: /^app-initial~app-main~onboarding-page-[A-Za-z0-9_-]+\.js$/,
      missingDescription: "current primary thread assistant bundle",
      skipDescription: "read aloud assistant runtime patch",
      apply: applyWebviewPatch,
    },
    {
      id: "settings-toggle",
      phase: "extracted-app:post-webview",
      order: 20640,
      ciPolicy: "optional",
      apply: applySettingsAssetPatch,
      status: (result, warnings) => ({
        status: result?.changed
          ? "applied"
          : result?.matched
            ? "already-applied"
            : "skipped-optional",
        reason: result?.reason ?? warnings[0] ?? null,
      }),
    },
  ],
};
