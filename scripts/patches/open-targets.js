"use strict";

const {
  findBalancedBlock,
  findCallBlock,
  requireName,
} = require("./shared.js");

function findPropertyBlock(source, propertyName) {
  const propertyIndex = source.indexOf(`,${propertyName}:{`);
  if (propertyIndex === -1) {
    return null;
  }

  const block = findBalancedBlock(source, source.indexOf("{", propertyIndex));
  if (block == null) {
    return null;
  }

  return {
    start: propertyIndex,
    end: block.end,
    text: source.slice(propertyIndex, block.end),
  };
}

function insertLinuxOpenTargetHelpers(currentSource, insertionIndex, { fsVar, pathVar }) {
  if (currentSource.includes("function codexLinuxFindExecutable(")) {
    return currentSource;
  }

  const helpers =
    `function codexLinuxFindExecutable(e){if(process.platform!==\`linux\`||!e)return null;let t=process.env.PATH||\`\`;for(let n of t.split(\`:\`)){if(!n||!(0,${pathVar}.isAbsolute)(n))continue;let r=(0,${pathVar}.join)(n,e);try{if((0,${fsVar}.existsSync)(r)){let e=(0,${fsVar}.statSync)(r);if(e.isFile())try{(0,${fsVar}.accessSync)(r,${fsVar}.constants.X_OK);return r}catch{}}}catch{}}return null}` +
    `function codexLinuxResolveExistingTarget(e){if(typeof e!==\`string\`||e.length===0)return null;let t=e;for(;;){try{if((0,${fsVar}.existsSync)(t))return t}catch{}let n=(0,${pathVar}.dirname)(t);if(n===t)return null;t=n}}` +
    `function codexLinuxOpenTargetEnv(){let e={...process.env};for(let t of [\`NODE_OPTIONS\`,\`NODE_PATH\`,\`NODE_REPL_EXTERNAL_MODULE\`,\`ELECTRON_RUN_AS_NODE\`,\`ELECTRON_NO_ASAR\`,\`ELECTRON_ENABLE_LOGGING\`,\`VSCODE_NODE_OPTIONS\`,\`VSCODE_NODE_REPL_EXTERNAL_MODULE\`,\`npm_config_node_options\`,\`NPM_CONFIG_NODE_OPTIONS\`])delete e[t];return e}` +
    `function codexLinuxLaunchDetached(e,t,n={}){return new Promise((r,i)=>{let a=!1,o;try{let s=require(\`node:child_process\`).spawn(e,t,{detached:!0,stdio:\`ignore\`,windowsHide:!0,cwd:n.cwd,env:codexLinuxOpenTargetEnv()});o=setTimeout(()=>{a=!0,s.unref?.(),r()},400),o.unref?.(),s.on(\`error\`,e=>{a||(clearTimeout(o),i(e))}),s.on(\`close\`,e=>{a||(clearTimeout(o),e===0?r():i(Error(\`Linux open target launch failed\`)))})}catch(e){clearTimeout(o),i(e)}})}` +
    `function codexLinuxTryReveal(e,t){return new Promise((n,r)=>{let i=!1,a;try{let o=require(\`node:child_process\`).spawn(e,t,{stdio:\`ignore\`,windowsHide:!0,env:codexLinuxOpenTargetEnv()});a=setTimeout(()=>{i=!0,o.unref?.(),n()},400),a.unref?.(),o.on(\`error\`,e=>{i||(clearTimeout(a),r(e))}),o.on(\`close\`,e=>{i||(clearTimeout(a),e===0?n():r(Error(\`Linux file manager reveal failed\`)))})}catch(e){clearTimeout(a),r(e)}})}` +
    `async function codexLinuxOpenFileManager(e){let t=codexLinuxResolveExistingTarget(e)??e;if(typeof t!==\`string\`||t.length===0)throw Error(\`No Linux file manager target available\`);let n=!1;try{n=(0,${fsVar}.existsSync)(t)&&(0,${fsVar}.statSync)(t).isFile()}catch{}if(n)for(let e of [[\`dolphin\`,[\`--select\`,t]],[\`nautilus\`,[\`--select\`,t]]]){let t=codexLinuxFindExecutable(e[0]);if(t)try{await codexLinuxTryReveal(t,e[1]);return}catch{}}t=n?(0,${pathVar}.dirname)(t):t;for(let e of [\`nemo\`,\`thunar\`,\`pcmanfm\`,\`caja\`,\`xdg-open\`]){let n=codexLinuxFindExecutable(e);if(n)try{await codexLinuxLaunchDetached(n,[t]);return}catch{}}throw Error(\`No Linux file manager available\`)}`;

  return currentSource.slice(0, insertionIndex) + helpers + currentSource.slice(insertionIndex);
}

function applyLinuxFileManagerPatch(currentSource) {
  let block = findCallBlock(currentSource, "id:`fileManager`");
  if (block == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const electronVar = requireName(currentSource, "electron");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (electronVar == null || fsVar == null || pathVar == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  let patchedSource = insertLinuxOpenTargetHelpers(currentSource, block.start, { fsVar, pathVar });
  if (patchedSource !== currentSource) {
    block = findCallBlock(patchedSource, "id:`fileManager`");
    if (block == null) {
      console.warn("Failed to apply Linux File Manager Patch");
      return currentSource;
    }
  }

  const insertionPoint = block.text.lastIndexOf("}});");
  if (insertionPoint === -1) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const linuxFileManager =
    `,linux:{label:\`File Manager\`,icon:\`apps/file-explorer.png\`,detect:()=>codexLinuxFindExecutable(\`dolphin\`)??codexLinuxFindExecutable(\`nautilus\`)??codexLinuxFindExecutable(\`nemo\`)??codexLinuxFindExecutable(\`thunar\`)??codexLinuxFindExecutable(\`pcmanfm\`)??codexLinuxFindExecutable(\`caja\`)??codexLinuxFindExecutable(\`xdg-open\`)??\`linux-file-manager\`,args:e=>[e],open:async({path:e})=>{await codexLinuxOpenFileManager(e).catch(async()=>{let t=codexLinuxResolveExistingTarget(e)??e;try{(0,${fsVar}.existsSync)(t)&&(0,${fsVar}.statSync)(t).isFile()&&(t=(0,${pathVar}.dirname)(t))}catch{}let r=await ${electronVar}.shell.openPath(t);if(r)throw Error(r)})}}`;

  const existingLinuxBlock = findPropertyBlock(block.text, "linux");
  const patchedBlock =
    existingLinuxBlock == null
      ? block.text.slice(0, insertionPoint + 1) + linuxFileManager + block.text.slice(insertionPoint + 1)
      : block.text.slice(0, existingLinuxBlock.start) +
        linuxFileManager +
        block.text.slice(existingLinuxBlock.end);
  patchedSource = patchedSource.slice(0, block.start) + patchedBlock + patchedSource.slice(block.end);

  const patchedBlockCheck = patchedSource.slice(block.start, block.start + patchedBlock.length);
  if (
    !patchedBlockCheck.includes("linux:{label:`File Manager`") ||
    !patchedBlockCheck.includes("codexLinuxOpenFileManager(e)") ||
    !patchedBlockCheck.includes(`${electronVar}.shell.openPath(t)`)
  ) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  return patchedSource;
}

function insertLinuxTerminalOpenTargetHelpers(currentSource, { fsVar, pathVar }) {
  if (currentSource.includes("function codexLinuxTerminalCommand(")) {
    return currentSource;
  }

  const helpers =
    `function codexLinuxTerminalCommand(){for(let e of [\`x-terminal-emulator\`,\`gnome-terminal\`,\`kgx\`,\`konsole\`,\`xfce4-terminal\`,\`mate-terminal\`,\`lxterminal\`,\`tilix\`,\`alacritty\`,\`kitty\`,\`ghostty\`,\`wezterm\`,\`foot\`,\`terminology\`,\`xterm\`]){let t=codexLinuxFindExecutable(e);if(t)return t}return null}` +
    `function codexLinuxTerminalSplitDesktopExec(e){let t=[],n=\`\`,r=null,i=!1;for(let a=0;a<e.length;a++){let o=e[a];if(i){n+=o,i=!1;continue}if(o===\`\\\\\`){i=!0;continue}if(r){o===r?r=null:n+=o;continue}if(o===\`"\`||o===\`'\`){r=o;continue}if(/\\s/u.test(o)){n&&(t.push(n),n=\`\`);continue}n+=o}return n&&t.push(n),t}` +
    `function codexLinuxTerminalDesktopDirs(){if(process.platform!==\`linux\`)return[];let e=process.env.HOME||\`/nonexistent\`,t=process.env.XDG_DATA_HOME&&(0,${pathVar}.isAbsolute)(process.env.XDG_DATA_HOME)?[process.env.XDG_DATA_HOME]:[(0,${pathVar}.join)(e,\`.local/share\`)],n=(process.env.XDG_DATA_DIRS&&process.env.XDG_DATA_DIRS.length>0?process.env.XDG_DATA_DIRS:\`/usr/local/share:/usr/share\`).split(\`:\`).filter(Boolean),r=[...t,...n,(0,${pathVar}.join)(e,\`.local/share/flatpak/exports/share\`),\`/var/lib/flatpak/exports/share\`,\`/var/lib/snapd/desktop\`],a=new Set;return r.map(e=>(0,${pathVar}.join)(e,\`applications\`)).filter(e=>e&&(0,${pathVar}.isAbsolute)(e)&&!a.has(e)&&(a.add(e),!0))}` +
    `function codexLinuxTerminalDesktopEntryFiles(e,t=0){let n=[];if(t>4)return n;try{for(let r of (0,${fsVar}.readdirSync)(e,{withFileTypes:!0})){let a=(0,${pathVar}.join)(e,r.name);r.isDirectory()?n.push(...codexLinuxTerminalDesktopEntryFiles(a,t+1)):r.isFile()&&r.name.endsWith(\`.desktop\`)&&n.push(a)}}catch{}return n}` +
    `function codexLinuxParseTerminalDesktopEntry(e){let t={Id:(0,${pathVar}.basename)(e).replace(/\\.desktop$/u,\`\`)},n=\`\`;try{for(let r of (0,${fsVar}.readFileSync)(e,\`utf8\`).split(/\\r?\\n/u)){let e=r.trim();if(!e||e.startsWith(\`#\`))continue;if(e.startsWith(\`[\`)&&e.endsWith(\`]\`)){n=e.slice(1,-1);continue}if(n&&n!==\`Desktop Entry\`)continue;let i=e.indexOf(\`=\`);if(i<1)continue;let a=e.slice(0,i).replace(/\\[.*\\]$/u,\`\`),o=e.slice(i+1);t[a]??=o}}catch{return null}let r=e=>(e||\`\`).trim().toLowerCase()===\`true\`;return(t.Type&&t.Type!==\`Application\`)||r(t.NoDisplay)||r(t.Hidden)||!t.Exec||!t.Name?null:t}` +
    `function codexLinuxLooksLikeTerminal(e){let t=(e.Categories||\`\`).toLowerCase(),n=[e.Name,e.GenericName,e.Comment,e.Keywords,e.Exec,e.Id].filter(Boolean).join(\` \`).toLowerCase();return/(^|;)terminalemulator(;|$)/u.test(t)||/\\b(terminal|console|shell|pty|ghostty|wezterm|konsole|alacritty|kitty|foot|xterm)\\b/u.test(n)}` +
    `function codexLinuxTerminalExecutablePath(e){if(!e)return null;if(!(0,${pathVar}.isAbsolute)(e))return codexLinuxFindExecutable(e);try{if((0,${fsVar}.existsSync)(e)){let t=(0,${fsVar}.statSync)(e);if(t.isFile())try{(0,${fsVar}.accessSync)(e,${fsVar}.constants.X_OK);return e}catch{}}}catch{}return null}` +
    `function codexLinuxTerminalCleanDesktopArgs(e){return e.map(e=>e.replace(/%%/gu,\`%\`)).filter(e=>!/^%[fFuUdDnNickvm]$/u.test(e))}` +
    `function codexLinuxResolveTerminalDesktopExec(e){let t=codexLinuxTerminalSplitDesktopExec(e);if(t.length===0)return null;for(;;){if(t[0]===\`env\`){t.shift();continue}if(t[0]&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(t[0])){t.shift();continue}if(t[0]===\`-u\`||t[0]===\`--unset\`){t.splice(0,2);continue}break}let n=t.shift();if(!n)return null;let r=codexLinuxTerminalExecutablePath(n);return r?{command:r,args:codexLinuxTerminalCleanDesktopArgs(t),base:(0,${pathVar}.basename)(n).replace(/\\.(sh|bin)$/u,\`\`).toLowerCase()}:null}` +
    `function codexLinuxDiscoveredTerminalInfo(){for(let e of codexLinuxTerminalDesktopDirs())for(let t of codexLinuxTerminalDesktopEntryFiles(e)){let e=codexLinuxParseTerminalDesktopEntry(t);if(!e||!codexLinuxLooksLikeTerminal(e))continue;if(e.TryExec&&!codexLinuxTerminalExecutablePath(codexLinuxTerminalSplitDesktopExec(e.TryExec)[0]))continue;let n=codexLinuxResolveTerminalDesktopExec(e.Exec);if(!n)continue;return{command:n.command,args:n.args,dirArg:e[\`X-TerminalArgDir\`]||null}}return null}` +
    `function codexLinuxTerminalInfo(){let e=codexLinuxFindExecutable(\`xdg-terminal-exec\`);if(e)return{command:e,args:[],xdg:!0};let t=codexLinuxTerminalCommand();return t?{command:t,args:[]}:codexLinuxDiscoveredTerminalInfo()}` +
    `function codexLinuxTerminalCwd(e){let t=codexLinuxResolveExistingTarget(e)??e;if(typeof t!==\`string\`||t.length===0)return process.env.HOME||\`/\`;try{if((0,${fsVar}.existsSync)(t)){let e=(0,${fsVar}.statSync)(t);if(e.isDirectory())return t;if(e.isFile())return(0,${pathVar}.dirname)(t)}}catch{}return(0,${pathVar}.dirname)(t)}` +
    `function codexLinuxTerminalArgs(e,t){let n=typeof e===\`string\`?{command:e,args:[]}:e??codexLinuxTerminalInfo(),r=codexLinuxTerminalCwd(t),a=(0,${pathVar}.basename)(n?.command||\`\`).toLowerCase();if(n?.dirArg)return n.dirArg.endsWith(\`=\`)?[...n.args??[],\`\${n.dirArg}\${r}\`]:[...n.args??[],n.dirArg,r];if(n?.args?.length)return n.args;if(n?.xdg)return[];if(a===\`wezterm\`)return[\`start\`,\`--cwd\`,r];if(a===\`konsole\`)return[\`--workdir\`,r];if(a===\`kitty\`)return[\`--directory\`,r];if(a===\`terminology\`)return[\`--workdir\`,r];return[\`gnome-terminal\`,\`kgx\`,\`xfce4-terminal\`,\`mate-terminal\`,\`lxterminal\`,\`tilix\`,\`alacritty\`,\`ghostty\`,\`foot\`].includes(a)?[\`--working-directory\`,r]:[]}`;
  const helperInsertionIndex = currentSource.includes("async function codexLinuxOpenFileManager(")
    ? currentSource.indexOf("async function codexLinuxOpenFileManager(")
    : currentSource.includes("function codexLinuxFindExecutable(")
      ? currentSource.indexOf("function codexLinuxFindExecutable(")
      : 0;
  return currentSource.slice(0, helperInsertionIndex) + helpers + currentSource.slice(helperInsertionIndex);
}

function applyLinuxTerminalOpenTargetPatch(currentSource) {
  if (currentSource.includes("linux:{label:`Terminal`")) {
    return currentSource;
  }

  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (fsVar == null || pathVar == null) {
    console.warn("WARN: Could not find Linux terminal open-target dependencies — skipping Linux terminal patch");
    return currentSource;
  }

  const terminalIndex = currentSource.indexOf("id:`terminal`");
  if (terminalIndex === -1) {
    console.warn("WARN: Could not find terminal open target — skipping Linux terminal patch");
    return currentSource;
  }

  const terminalDeclarationIndex = Math.max(
    currentSource.lastIndexOf("var ", terminalIndex),
    currentSource.lastIndexOf("let ", terminalIndex),
    currentSource.lastIndexOf("const ", terminalIndex),
  );
  let patchedSource = insertLinuxOpenTargetHelpers(
    currentSource,
    terminalDeclarationIndex >= 0 ? terminalDeclarationIndex : terminalIndex,
    { fsVar, pathVar },
  );
  patchedSource = insertLinuxTerminalOpenTargetHelpers(patchedSource, { fsVar, pathVar });

  const patchedTerminalIndex = patchedSource.indexOf("id:`terminal`");
  const platformsIndex = patchedSource.indexOf("platforms:{", patchedTerminalIndex);
  const platformsBlock =
    platformsIndex === -1 ? null : findBalancedBlock(patchedSource, patchedSource.indexOf("{", platformsIndex));
  if (platformsBlock == null || platformsBlock.text.includes("linux:{")) {
    console.warn("WARN: Could not apply Linux terminal open-target patch");
    return currentSource;
  }

  const linuxTerminal =
    `,linux:{label:\`Terminal\`,icon:\`apps/terminal.png\`,kind:\`terminal\`,detect:()=>codexLinuxTerminalInfo()?.command??null,args:e=>codexLinuxTerminalArgs(codexLinuxTerminalInfo(),e),open:async({command:e,path:t})=>{await codexLinuxLaunchDetached(e,codexLinuxTerminalArgs(codexLinuxTerminalInfo()??e,t),{cwd:codexLinuxTerminalCwd(t)})}}`;
  patchedSource =
    patchedSource.slice(0, platformsBlock.end - 1) +
    linuxTerminal +
    patchedSource.slice(platformsBlock.end - 1);

  if (
    !patchedSource.includes("function codexLinuxTerminalCommand(") ||
    !patchedSource.includes("linux:{label:`Terminal`")
  ) {
    console.warn("WARN: Could not apply Linux terminal open-target patch");
    return currentSource;
  }

  return patchedSource;
}

function applyLinuxIdeOpenTargetPatch(currentSource) {
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (fsVar == null || pathVar == null) {
    console.warn("WARN: Could not find Linux IDE open-target dependencies — skipping Linux IDE open-target patch");
    return currentSource;
  }

  const editorFactoryIndex = currentSource.search(/function\s+[A-Za-z_$][\w$]*\(\{id:[A-Za-z_$][\w$]*,label:[A-Za-z_$][\w$]*,icon:[A-Za-z_$][\w$]*,darwinDetect:/u);
  const jetBrainsFactoryIndex = currentSource.search(/function\s+[A-Za-z_$][\w$]*\(\{id:[A-Za-z_$][\w$]*,label:[A-Za-z_$][\w$]*,icon:[A-Za-z_$][\w$]*,toolboxTarget:/u);
  const hasEditorFactory = editorFactoryIndex !== -1;
  const hasJetBrainsFactory = jetBrainsFactoryIndex !== -1;
  const hasZedTarget = currentSource.includes("id:`zed`");
  if (!hasEditorFactory && !hasJetBrainsFactory && !hasZedTarget) {
    console.warn("WARN: Could not find Linux IDE open-target factories — skipping Linux IDE open-target patch");
    return currentSource;
  }

  const zedIndex = currentSource.indexOf("id:`zed`");
  const zedDeclarationIndex =
    zedIndex === -1
      ? -1
      : Math.max(
          currentSource.lastIndexOf("var ", zedIndex),
          currentSource.lastIndexOf("let ", zedIndex),
          currentSource.lastIndexOf("const ", zedIndex),
        );
  const openTargetHelperInsertionIndex =
    [editorFactoryIndex, jetBrainsFactoryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ??
    (zedDeclarationIndex >= 0 ? zedDeclarationIndex : 0);
  let patchedSource = insertLinuxOpenTargetHelpers(
    currentSource,
    openTargetHelperInsertionIndex,
    { fsVar, pathVar },
  );

  const ideHelpers = patchedSource.includes("function codexLinuxIdeCommand(")
    ? ""
    : `function codexLinuxIdeCommand(e){let t={cursor:[\`cursor\`],vscode:[\`code\`,\`codium\`],vscodeInsiders:[\`code-insiders\`],windsurf:[\`windsurf\`],antigravity:[\`antigravity\`],zed:[\`zed\`],intellij:[\`idea\`],webstorm:[\`webstorm\`],pycharm:[\`pycharm\`],goland:[\`goland\`],clion:[\`clion\`],rustrover:[\`rustrover\`],rider:[\`rider\`],phpstorm:[\`phpstorm\`],androidStudio:[\`studio\`,\`studio.sh\`]}[e]??[];for(let e of t){let t=codexLinuxFindExecutable(e);if(t)return t}return null}` +
      `function codexLinuxIdePlatform(e,t,n,r,i){let a=codexLinuxIdeCommand(e);return a?{label:t,icon:n,kind:\`editor\`,hidden:r,detect:()=>a,args:i,supportsSsh:!0}:void 0}` +
      `function codexLinuxJetBrainsIdePlatform(e,t,n,r){let i=codexLinuxIdeCommand(e);return i?{label:t,icon:n,kind:\`editor\`,detect:()=>i,args:r}:void 0}`;
  if (ideHelpers.length > 0) {
    const helperInsertionIndex = patchedSource.includes("function codexLinuxFindExecutable(")
      ? patchedSource.indexOf("function codexLinuxFindExecutable(")
      : 0;
    const helperEnd =
      patchedSource.indexOf("async function codexLinuxOpenFileManager(", helperInsertionIndex);
    const ideHelperInsertionIndex = helperEnd === -1 ? helperInsertionIndex : helperEnd;
    patchedSource = patchedSource.slice(0, ideHelperInsertionIndex) + ideHelpers + patchedSource.slice(ideHelperInsertionIndex);
  }

  patchedSource = patchedSource.replace(
    /(function\s+[A-Za-z_$][\w$]*\(\{id:([A-Za-z_$][\w$]*),label:([A-Za-z_$][\w$]*),icon:([A-Za-z_$][\w$]*),darwinDetect:[^)]*?hidden:([A-Za-z_$][\w$]*)\}\)\{return\{id:\2,platforms:\{[^]*?win32:[^]*?args:([A-Za-z_$][\w$]*),supportsSsh:!0\}:void 0)(\}\}\})/u,
    "$1,linux:codexLinuxIdePlatform($2,$3,$4,$5,$6)$7",
  );

  patchedSource = patchedSource.replace(
    /(function\s+[A-Za-z_$][\w$]*\(\{id:([A-Za-z_$][\w$]*),label:([A-Za-z_$][\w$]*),icon:([A-Za-z_$][\w$]*),toolboxTarget:[^)]*?\}\)\{return\{id:\2,platforms:\{[^]*?args:([A-Za-z_$][\w$]*)\}:void 0)(\}\}\})/u,
    "$1,linux:codexLinuxJetBrainsIdePlatform($2,$3,$4,$5)$6",
  );

  const patchedZedIndex = patchedSource.indexOf("id:`zed`");
  if (patchedZedIndex !== -1) {
    const zedPlatformsIndex = patchedSource.indexOf("platforms:{", patchedZedIndex);
    const zedPlatformsBlock =
      zedPlatformsIndex === -1 ? null : findBalancedBlock(patchedSource, patchedSource.indexOf("{", zedPlatformsIndex));
    if (zedPlatformsBlock != null && !zedPlatformsBlock.text.includes("linux:{")) {
      const argsVar = zedPlatformsBlock.text.match(/win32:\{[^}]*args:([A-Za-z_$][\w$]*)/u)?.[1];
      if (argsVar != null) {
        const linuxZed = `,linux:{label:\`Zed\`,icon:\`apps/zed.png\`,kind:\`editor\`,detect:()=>codexLinuxFindExecutable(\`zed\`),args:${argsVar}}`;
        patchedSource =
          patchedSource.slice(0, zedPlatformsBlock.end - 1) +
          linuxZed +
          patchedSource.slice(zedPlatformsBlock.end - 1);
      }
    }
  }

  if (
    hasEditorFactory &&
    !patchedSource.includes("linux:codexLinuxIdePlatform(")
  ) {
    console.warn("WARN: Could not apply generic Linux IDE open-target factory patch");
  }
  if (
    hasJetBrainsFactory &&
    !patchedSource.includes("linux:codexLinuxJetBrainsIdePlatform(")
  ) {
    console.warn("WARN: Could not apply JetBrains Linux IDE open-target factory patch");
  }
  if (hasZedTarget && !patchedSource.includes("linux:{label:`Zed`")) {
    console.warn("WARN: Could not apply Zed Linux IDE open-target patch");
  }

  if (
    !patchedSource.includes("function codexLinuxIdeCommand(") ||
    (
      !patchedSource.includes("linux:codexLinuxIdePlatform(") &&
      !patchedSource.includes("linux:codexLinuxJetBrainsIdePlatform(") &&
      !patchedSource.includes("linux:{label:`Zed`")
    )
  ) {
    console.warn("WARN: Could not apply any Linux IDE open-target patch");
    return currentSource;
  }

  return patchedSource;
}

module.exports = {
  applyLinuxFileManagerPatch,
  applyLinuxIdeOpenTargetPatch,
  applyLinuxTerminalOpenTargetPatch,
};
