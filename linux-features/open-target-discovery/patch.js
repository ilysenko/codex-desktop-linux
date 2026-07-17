"use strict";

const {
  requireName,
} = require("../../scripts/patches/lib/minified-js.js");

const PATCH_NAME = "open-target-discovery feature patch";

function warn(message) {
  console.warn(`WARN: ${message} - skipping ${PATCH_NAME}`);
}

function findBalancedBlock(source, openBraceIndex) {
  if (openBraceIndex < 0 || source[openBraceIndex] !== "{") {
    return null;
  }

  let depth = 0;
  const stack = [{ type: "code" }];
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    const top = stack[stack.length - 1];

    if (top.type === "string") {
      if (top.escaped) {
        top.escaped = false;
      } else if (char === "\\") {
        top.escaped = true;
      } else if (char === top.quote) {
        stack.pop();
      }
      continue;
    }

    if (top.type === "template") {
      if (top.escaped) {
        top.escaped = false;
      } else if (char === "\\") {
        top.escaped = true;
      } else if (char === "`") {
        stack.pop();
      } else if (char === "$" && source[index + 1] === "{") {
        stack.push({ type: "templateExpression", depth: 1 });
        index += 1;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      stack.push({ type: "string", quote: char, escaped: false });
      continue;
    }
    if (char === "`") {
      stack.push({ type: "template", escaped: false });
      continue;
    }

    if (top.type === "templateExpression") {
      if (char === "{") {
        top.depth += 1;
      } else if (char === "}") {
        top.depth -= 1;
        if (top.depth === 0) {
          stack.pop();
        }
      }
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: openBraceIndex, end: index + 1, text: source.slice(openBraceIndex, index + 1) };
      }
    }
  }

  return null;
}

function findDeclarationBlock(source, marker) {
  const markerStart = source.indexOf(marker);
  if (markerStart === -1) {
    return null;
  }

  const blockStart = Math.max(
    source.lastIndexOf("var ", markerStart),
    source.lastIndexOf("let ", markerStart),
    source.lastIndexOf("const ", markerStart),
  );
  const objectStart = source.lastIndexOf("{", markerStart);
  const objectBlock = findBalancedBlock(source, objectStart);
  if (blockStart === -1 || objectBlock == null) {
    return null;
  }
  const callEndMatch = source.slice(objectBlock.end).match(/^\s*\);/u);
  const blockEnd = callEndMatch == null ? objectBlock.end : objectBlock.end + callEndMatch[0].length;

  return {
    start: blockStart,
    end: blockEnd,
    text: source.slice(blockStart, blockEnd),
  };
}

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

function findAsyncFunctionBlockContaining(source, marker, predicate = null) {
  let markerIndex = source.indexOf(marker);
  while (markerIndex !== -1) {
    const functionStart = source.lastIndexOf("async function ", markerIndex);
    const signatureEnd = functionStart === -1 ? -1 : source.indexOf("){", functionStart);
    const blockStart = signatureEnd === -1 ? -1 : signatureEnd + 1;
    const block = findBalancedBlock(source, blockStart);
    if (block != null && block.end > markerIndex) {
      const candidate = {
        functionStart,
        header: source.slice(functionStart, blockStart),
        ...block,
      };
      if (predicate == null || predicate(candidate)) {
        return candidate;
      }
    }
    markerIndex = source.indexOf(marker, markerIndex + marker.length);
  }
  return null;
}

function findOpenTargetRegistryBindings(source) {
  const paramsMatches = [
    ...source.matchAll(
      /function [A-Za-z_$][\w$]*\(e,t\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(e\)\.find\(e=>e\.id===t\);return \1\?\.configuredCommand==null\|\|\1\.configuredIcon==null\?/gu,
    ),
  ];
  const summaryMatches = [
    ...source.matchAll(
      /function [A-Za-z_$][\w$]*\(e\)\{return [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\(e\)\)\}/gu,
    ),
  ];
  const paramsMatch = paramsMatches.find((match) =>
    summaryMatches.some((summaryMatch) => summaryMatch[1] === match[2]),
  );
  const registryName = paramsMatch?.[2] ?? null;
  const registryStart = registryName == null ? -1 : source.indexOf(`function ${registryName}(e){`);
  const registryBlock = findBalancedBlock(
    source,
    registryStart === -1 ? -1 : source.indexOf("{", registryStart),
  );
  const defaultTargetsMatch = registryBlock?.text.match(
    /if\([A-Za-z_$][\w$]*==null\)return ([A-Za-z_$][\w$]*);/u,
  );
  if (registryName == null || defaultTargetsMatch == null) {
    return null;
  }

  let detectContextMatch = null;
  const launchBlock = findAsyncFunctionBlockContaining(
    source,
    "Unknown open target",
    (candidate) => {
      const targetsMatch = candidate.header.match(
        /targets:[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)/u,
      );
      detectContextMatch = candidate.text.match(
        /let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\.find\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\.id===[A-Za-z_$][\w$]*\);if\(!\1\)throw Error\(`Unknown open target "\$\{[A-Za-z_$][\w$]*\}"`\);let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\?await \1\.detect\(([A-Za-z_$][\w$]*)\);if\(!\2\)throw Error\(`Open target "\$\{[A-Za-z_$][\w$]*\}" is not available`\)/u,
      );
      return targetsMatch?.[1] === defaultTargetsMatch[1] && detectContextMatch != null;
    },
  );
  if (
    launchBlock == null ||
    detectContextMatch == null ||
    !source.includes(`${detectContextMatch[3]}=async `)
  ) {
    return null;
  }

  return {
    registryName,
    registryExpression: `${registryName}(e)`,
    detectContext: detectContextMatch[3],
  };
}

function insertOpenTargetHelpers(currentSource, insertionIndex, { fsVar, pathVar }) {
  if (currentSource.includes("function codexLinuxFindExecutable(")) {
    return currentSource;
  }

  const helpers =
    `function codexLinuxNodeFs(){return require(\`node:fs\`)}` +
    `function codexLinuxNodePath(){return require(\`node:path\`)}` +
    `function codexLinuxExecutableSearchDirs(){if(process.platform!==\`linux\`)return[];let e=process.env.HOME||\`/nonexistent\`,t=[];for(let e of [process.env.HOMEBREW_PREFIX,process.env.LINUXBREW_PREFIX])e&&${pathVar}.isAbsolute(e)&&t.push((0,${pathVar}.join)(e,\`bin\`));let n=process.env.PATH||\`\`;for(let e of n.split(\`:\`))e&&${pathVar}.isAbsolute(e)&&t.push(e);t.push((0,${pathVar}.join)(e,\`.local/bin\`),(0,${pathVar}.join)(e,\`bin\`),(0,${pathVar}.join)(e,\`.linuxbrew/bin\`),(0,${pathVar}.join)(e,\`.local/share/JetBrains/Toolbox/scripts\`),(0,${pathVar}.join)(e,\`.local/share/flatpak/exports/bin\`),\`/home/linuxbrew/.linuxbrew/bin\`,\`/var/home/linuxbrew/.linuxbrew/bin\`);let r=new Set;return t.filter(e=>e&&${pathVar}.isAbsolute(e)&&!r.has(e)&&(r.add(e),!0))}` +
    `function codexLinuxFindExecutable(e){if(process.platform!==\`linux\`||!e)return null;for(let t of codexLinuxExecutableSearchDirs()){let n=(0,${pathVar}.join)(t,e);try{if((0,${fsVar}.existsSync)(n)){let e=(0,${fsVar}.statSync)(n);if(e.isFile())try{(0,${fsVar}.accessSync)(n,${fsVar}.constants.X_OK);return n}catch{}}}catch{}}return null}` +
    `function codexLinuxResolveExistingTarget(e){if(typeof e!==\`string\`||e.length===0)return null;let t=e;for(;;){try{if((0,${fsVar}.existsSync)(t))return t}catch{}let n=(0,${pathVar}.dirname)(t);if(n===t)return null;t=n}}` +
    `function codexLinuxShouldDropXdgConfigHome(e){let t=e.XDG_CONFIG_HOME,n=e.CODEX_ELECTRON_USER_DATA_DIR;if(typeof t!==\`string\`)return!1;if(typeof n===\`string\`&&t===(0,${pathVar}.join)((0,${pathVar}.dirname)(n),\`xdg-config\`))return!0;let r=e.CODEX_LINUX_APP_ID;return!!(r&&t.endsWith(\`/\${r}/xdg-config\`))}` +
    `function codexLinuxOpenTargetEnv(){let e={...process.env};codexLinuxShouldDropXdgConfigHome(e)&&delete e.XDG_CONFIG_HOME;for(let t of [\`LD_LIBRARY_PATH\`,\`LD_PRELOAD\`,\`NODE_OPTIONS\`,\`NODE_PATH\`,\`NODE_REPL_EXTERNAL_MODULE\`,\`ELECTRON_RUN_AS_NODE\`,\`ELECTRON_NO_ASAR\`,\`ELECTRON_ENABLE_LOGGING\`,\`VSCODE_NODE_OPTIONS\`,\`VSCODE_NODE_REPL_EXTERNAL_MODULE\`,\`npm_config_node_options\`,\`NPM_CONFIG_NODE_OPTIONS\`,\`CHROME_DESKTOP\`,\`ELECTRON_RENDERER_URL\`,\`CODEX_ELECTRON_RESOURCES_PATH\`,\`CODEX_ELECTRON_USER_DATA_DIR\`,\`CODEX_LINUX_APP_ID\`,\`CODEX_LINUX_APP_DISPLAY_NAME\`,\`CODEX_LINUX_WEBVIEW_PORT\`])delete e[t];return e}` +
    `function codexLinuxLaunchDetached(e,t,n={}){return new Promise((r,i)=>{let a=!1,o;try{let s=require(\`node:child_process\`).spawn(e,t,{detached:!0,stdio:\`ignore\`,windowsHide:!0,cwd:n.cwd,env:codexLinuxOpenTargetEnv()});o=setTimeout(()=>{a=!0,s.unref?.(),r()},400),o.unref?.(),s.on(\`error\`,e=>{a||(clearTimeout(o),i(e))}),s.on(\`close\`,e=>{a||(clearTimeout(o),e===0?r():i(Error(\`Linux open target launch failed\`)))})}catch(e){clearTimeout(o),i(e)}})}` +
    `function codexLinuxTryReveal(e,t){return new Promise((n,r)=>{let i=!1,a;try{let o=require(\`node:child_process\`).spawn(e,t,{stdio:\`ignore\`,windowsHide:!0,env:codexLinuxOpenTargetEnv()});a=setTimeout(()=>{i=!0,o.unref?.(),n()},400),a.unref?.(),o.on(\`error\`,e=>{i||(clearTimeout(a),r(e))}),o.on(\`close\`,e=>{i||(clearTimeout(a),e===0?n():r(Error(\`Linux file manager reveal failed\`)))})}catch(e){clearTimeout(a),r(e)}})}` +
    `async function codexLinuxOpenFileManager(e){let t=codexLinuxResolveExistingTarget(e)??e;if(typeof t!==\`string\`||t.length===0)throw Error(\`No Linux file manager target available\`);let n=!1;try{n=(0,${fsVar}.existsSync)(t)&&(0,${fsVar}.statSync)(t).isFile()}catch{}if(n)for(let e of [[\`dolphin\`,[\`--select\`,t]],[\`nautilus\`,[\`--select\`,t]]]){let t=codexLinuxFindExecutable(e[0]);if(t)try{await codexLinuxTryReveal(t,e[1]);return}catch{}}t=n?(0,${pathVar}.dirname)(t):t;for(let e of [\`nemo\`,\`thunar\`,\`pcmanfm\`,\`caja\`,\`xdg-open\`]){let n=codexLinuxFindExecutable(e);if(n)try{await codexLinuxLaunchDetached(n,[t]);return}catch{}}throw Error(\`No Linux file manager available\`)}`;

  return currentSource.slice(0, insertionIndex) + helpers + currentSource.slice(insertionIndex);
}

function applyFileManagerDiscoveryPatch(currentSource, deps) {
  let block = findDeclarationBlock(currentSource, "id:`fileManager`");
  if (block == null) {
    warn("Could not find file manager open target");
    return currentSource;
  }
  if (block.text.includes("codexLinuxOpenFileManager(e)")) {
    return currentSource;
  }

  let patchedSource = insertOpenTargetHelpers(currentSource, block.start, deps);
  if (patchedSource !== currentSource) {
    block = findDeclarationBlock(patchedSource, "id:`fileManager`");
    if (block == null) {
      warn("Could not re-read file manager open target");
      return currentSource;
    }
  }

  const insertionPoint = block.text.lastIndexOf("}});");
  if (insertionPoint === -1) {
    warn("Could not find file manager insertion point");
    return currentSource;
  }

  const { electronVar, fsVar, pathVar } = deps;
  const linuxFileManager =
    `,linux:{label:\`File Manager\`,icon:\`apps/file-explorer.png\`,detect:()=>codexLinuxFindExecutable(\`dolphin\`)??codexLinuxFindExecutable(\`nautilus\`)??codexLinuxFindExecutable(\`nemo\`)??codexLinuxFindExecutable(\`thunar\`)??codexLinuxFindExecutable(\`pcmanfm\`)??codexLinuxFindExecutable(\`caja\`)??codexLinuxFindExecutable(\`xdg-open\`)??\`linux-file-manager\`,args:e=>[e],open:async({path:e})=>{await codexLinuxOpenFileManager(e).catch(async()=>{let t=codexLinuxResolveExistingTarget(e)??e;try{(0,${fsVar}.existsSync)(t)&&(0,${fsVar}.statSync)(t).isFile()&&(t=(0,${pathVar}.dirname)(t))}catch{}let r=await ${electronVar}.shell.openPath(t);if(r)throw Error(r)})}}`;

  const existingLinuxBlock = findPropertyBlock(block.text, "linux");
  const patchedBlock =
    existingLinuxBlock == null
      ? block.text.slice(0, insertionPoint + 1) + linuxFileManager + block.text.slice(insertionPoint + 1)
      : block.text.slice(0, existingLinuxBlock.start) +
        linuxFileManager +
        block.text.slice(existingLinuxBlock.end);

  return patchedSource.slice(0, block.start) + patchedBlock + patchedSource.slice(block.end);
}

function insertTerminalHelpers(currentSource, { fsVar, pathVar }) {
  if (currentSource.includes("function codexLinuxTerminalCommand(")) {
    return currentSource;
  }

  const helpers =
    `function codexLinuxTerminalCommand(){for(let e of [\`x-terminal-emulator\`,\`gnome-terminal\`,\`kgx\`,\`konsole\`,\`xfce4-terminal\`,\`mate-terminal\`,\`lxterminal\`,\`tilix\`,\`alacritty\`,\`kitty\`,\`ghostty\`,\`wezterm\`,\`foot\`,\`terminology\`,\`xterm\`]){let t=codexLinuxFindExecutable(e);if(t)return t}return null}` +
    `function codexLinuxTerminalSplitDesktopExec(e){let t=[],n=\`\`,r=null,i=!1;for(let a=0;a<e.length;a++){let o=e[a];if(i){n+=o,i=!1;continue}if(o===\`\\\\\`){r&&(n+=o);i=!0;continue}if(r){o===r?r=null:n+=o;continue}if(o===\`"\`||o===\`'\`){r=o;continue}if(/\\s/u.test(o)){n&&(t.push(n),n=\`\`);continue}n+=o}return n&&t.push(n),t}` +
    `function codexLinuxTerminalDesktopDirs(){if(process.platform!==\`linux\`)return[];let e=process.env.HOME||\`/nonexistent\`,t=process.env.XDG_DATA_HOME&&${pathVar}.isAbsolute(process.env.XDG_DATA_HOME)?[process.env.XDG_DATA_HOME]:[(0,${pathVar}.join)(e,\`.local/share\`)],n=(process.env.XDG_DATA_DIRS&&process.env.XDG_DATA_DIRS.length>0?process.env.XDG_DATA_DIRS:\`/usr/local/share:/usr/share\`).split(\`:\`).filter(Boolean),r=[...t,...n,(0,${pathVar}.join)(e,\`.local/share/flatpak/exports/share\`),\`/var/lib/flatpak/exports/share\`,\`/var/lib/snapd/desktop\`],a=new Set;return r.map(e=>(0,${pathVar}.join)(e,\`applications\`)).filter(e=>e&&${pathVar}.isAbsolute(e)&&!a.has(e)&&(a.add(e),!0))}` +
    `function codexLinuxTerminalDesktopEntryFiles(e,t=0){let n=[];if(t>4)return n;try{for(let r of (0,${fsVar}.readdirSync)(e,{withFileTypes:!0})){let a=(0,${pathVar}.join)(e,r.name);r.isDirectory()?n.push(...codexLinuxTerminalDesktopEntryFiles(a,t+1)):(r.isFile()||r.isSymbolicLink())&&r.name.endsWith(\`.desktop\`)&&n.push(a)}}catch{}return n}` +
    `function codexLinuxParseTerminalDesktopEntry(e){let t={Id:(0,${pathVar}.basename)(e).replace(/\\.desktop$/u,\`\`)},n=\`\`;try{for(let r of (0,${fsVar}.readFileSync)(e,\`utf8\`).split(/\\r?\\n/u)){let e=r.trim();if(!e||e.startsWith(\`#\`))continue;if(e.startsWith(\`[\`)&&e.endsWith(\`]\`)){n=e.slice(1,-1);continue}if(n&&n!==\`Desktop Entry\`)continue;let i=e.indexOf(\`=\`);if(i<1)continue;let a=e.slice(0,i).replace(/\\[.*\\]$/u,\`\`),o=e.slice(i+1);t[a]??=o}}catch{return null}let r=e=>(e||\`\`).trim().toLowerCase()===\`true\`;return(t.Type&&t.Type!==\`Application\`)||r(t.NoDisplay)||r(t.Hidden)||!t.Exec||!t.Name?null:t}` +
    `function codexLinuxLooksLikeTerminal(e){let t=(e.Categories||\`\`).toLowerCase(),n=[e.Name,e.GenericName,e.Comment,e.Keywords,e.Exec,e.Id].filter(Boolean).join(\` \`).toLowerCase();return/(^|;)terminalemulator(;|$)/u.test(t)||/\\b(terminal|console|shell|pty|ghostty|wezterm|konsole|alacritty|kitty|foot|xterm)\\b/u.test(n)}` +
    `function codexLinuxTerminalExecutablePath(e){if(!e)return null;if(!(0,${pathVar}.isAbsolute)(e))return codexLinuxFindExecutable(e);try{if((0,${fsVar}.existsSync)(e)){let t=(0,${fsVar}.statSync)(e);if(t.isFile())try{(0,${fsVar}.accessSync)(e,${fsVar}.constants.X_OK);return e}catch{}}}catch{}return null}` +
    `function codexLinuxTerminalCleanDesktopArgs(e){return e.map(e=>e.replace(/%%/gu,\`%\`)).filter(e=>!/^%[fFuUdDnNickvm]$/u.test(e))}` +
    `function codexLinuxResolveTerminalDesktopExec(e){let t=codexLinuxTerminalSplitDesktopExec(e);if(t.length===0)return null;for(;;){if((0,${pathVar}.basename)(t[0]||\`\`)===\`env\`){t.shift();continue}if(t[0]&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(t[0])){t.shift();continue}if(t[0]===\`-u\`||t[0]===\`--unset\`){t.splice(0,2);continue}break}let n=t.shift();if(!n)return null;let r=codexLinuxTerminalExecutablePath(n);return r?{command:r,args:codexLinuxTerminalCleanDesktopArgs(t),base:(0,${pathVar}.basename)(n).replace(/\\.(sh|bin)$/u,\`\`).toLowerCase()}:null}` +
    `function codexLinuxTerminalShellArg(e){if(!e)return\`\`;let t=e[0],n=e[e.length-1],r=(t===\`"\`||t===\`'\`)&&n===t?t:null;r&&(e=e.slice(1,-1));let i=process.env.HOME||\`\`;r==null&&(e=e.replace(/^~(?=\\/|$)/u,i).replace(/\\\\([^$])/gu,\`$1\`));r!==\`'\`&&(e=e.replace(/\\$\\{HOME\\}|\\$HOME/gu,i));return e}` +
    `function codexLinuxTerminalFlatpakRoots(){let e=process.env.HOME||\`/nonexistent\`,t=[{root:(0,${pathVar}.join)(e,\`.local/share/flatpak\`),scope:\`user\`},{root:\`/var/lib/flatpak\`,scope:\`system\`}];try{for(let e of (0,${fsVar}.readdirSync)(\`/etc/flatpak/installations.d\`)){try{let n=(0,${fsVar}.readFileSync)((0,${pathVar}.join)(\`/etc/flatpak/installations.d\`,e),\`utf8\`).match(/^\\s*Path\\s*=\\s*(.+?)\\s*$/mu)?.[1]?.replace(/^["']|["']$/gu,\`\`);n&&(0,${pathVar}.isAbsolute)(n)&&t.push({root:n,scope:\`installation\`,name:e.replace(/\\.conf$/u,\`\`)})}catch{}}}catch{}return t}` +
    `function codexLinuxTerminalFlatpakAvailable(e,t){for(let n of codexLinuxTerminalFlatpakRoots())try{if(t?.scope&&n.scope!==t.scope)continue;if(t?.name&&n.name!==t.name)continue;if((0,${fsVar}.existsSync)((0,${pathVar}.join)(n.root,\`app\`,e)))return!0}catch{}return!1}` +
    `function codexLinuxTerminalShellProbeTail(e){return/^(?:\\s*(?:(?:\\d*>>?|\\d*<|&>)\\s*\\S+|\\d*>&\\d+))*\\s*$/u.test(e)}` +
    `function codexLinuxTerminalFlatpakScope(e){let t=e.match(/(?:^|\\s)--installation(?:=((?:"[^"]*"|'[^']*'|[^\\s;&|()<>]+))|\\s+((?:"[^"]*"|'[^']*'|[^\\s;&|()<>]+)))/u);return t?{scope:\`installation\`,name:codexLinuxTerminalShellArg(t[1]||t[2])}:/(?:^|\\s)--user(?:\\s|$)/u.test(e)?{scope:\`user\`}:/(?:^|\\s)--system(?:\\s|$)/u.test(e)?{scope:\`system\`}:null}` +
    `function codexLinuxTerminalFlatpakInfoAvailable(e){let t=e.match(/^\\s*((?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))\\s+(?:(?:--(?:system|user|show-location)|--installation(?:=(?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+)|\\s+(?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))?)\\s+)*info\\s+(?:(?:--(?:system|user|show-location)|--installation(?:=(?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+)|\\s+(?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))?)\\s+)*((?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))/u);if(!t)return null;let n=codexLinuxTerminalShellArg(t[1]);return(0,${pathVar}.basename)(n)!==\`flatpak\`?null:codexLinuxTerminalShellProbeTail(e.slice(t[0].length))?codexLinuxTerminalExecutablePath(n)!=null&&codexLinuxTerminalFlatpakAvailable(codexLinuxTerminalShellArg(t[2]),codexLinuxTerminalFlatpakScope(t[0])):!1}` +
    `function codexLinuxTerminalFlatpakInfoTokensAvailable(e){let t=0;for(;;){let n=e[t];if((0,${pathVar}.basename)(n||\`\`)===\`env\`){if(codexLinuxTerminalExecutablePath(n)==null)return!1;t++;continue}if(n&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(n)){t++;continue}if(n===\`-i\`||n===\`--ignore-environment\`||n?.startsWith(\`--unset=\`)){t++;continue}if(n===\`-u\`||n===\`--unset\`){t+=2;continue}break}if((0,${pathVar}.basename)(e[t]||\`\`)!==\`flatpak\`)return null;if(codexLinuxTerminalExecutablePath(e[t])==null)return!1;let n=t+1,r=null,a=e=>e===\`--user\`?{scope:\`user\`}:e===\`--system\`?{scope:\`system\`}:null;for(;;){let t=e[n];if(t===\`--user\`||t===\`--system\`){r=a(t),n++;continue}if(t?.startsWith(\`--installation=\`)){r={scope:\`installation\`,name:t.slice(15)},n++;continue}if(t===\`--installation\`){r={scope:\`installation\`,name:e[n+1]},n+=2;continue}if(t===\`--verbose\`){n++;continue}if(t?.startsWith(\`-\`))return!1;break}if(e[n]!==\`info\`)return null;n++;for(;n<e.length;n++){let t=e[n];if(t===\`--user\`||t===\`--system\`){r=a(t);continue}if(t?.startsWith(\`--installation=\`)){r={scope:\`installation\`,name:t.slice(15)};continue}if(t===\`--installation\`){r={scope:\`installation\`,name:e[++n]};continue}if(t===\`--show-location\`||t===\`--verbose\`)continue;if(t.startsWith(\`-\`))return!1;return codexLinuxTerminalFlatpakAvailable(t,r)}return!1}` +
    `function codexLinuxTerminalShellProbeCommand(e,t){let n=e.match(/^\\s*((?:command\\s+-v)|which|type|hash)\\s+((?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))/u);if(n&&codexLinuxTerminalShellProbeTail(e.slice(n[0].length)))return n[1]===\`which\`&&codexLinuxTerminalExecutablePath(\`which\`)==null||n[1]===\`hash\`&&t===\`fish\`?!1:codexLinuxTerminalExecutablePath(codexLinuxTerminalShellArg(n[2]))!=null;n=e.match(/^\\s*(test\\s+-x|\\[\\s+-x|\\[\\[\\s+-x)\\s+((?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()\\]])+))/u);if(n&&(!n[1].startsWith(\`[[\`)||[\`bash\`,\`zsh\`].includes(t))&&codexLinuxTerminalShellProbeTail(e.slice(n[0].length).replace(/^\\s*\\]{1,2}/u,\`\`)))return codexLinuxTerminalExecutablePath(codexLinuxTerminalShellArg(n[2]))!=null;return codexLinuxTerminalFlatpakInfoAvailable(e)}` +
    `function codexLinuxTerminalShellSegments(e){let t=[],n=\`\`,r=null,i=!1;for(let a=0;a<e.length;a++){let o=e[a];if(i){n+=o,i=!1;continue}if(o===\`\\\\\`){n+=o,i=!0;continue}if(r){n+=o,o===r&&(r=null);continue}if(o===\`"\`||o===\`'\`){r=o,n+=o;continue}if(o===\`&\`&&e[a+1]===\`&\`||o===\`|\`&&e[a+1]===\`|\`){t.push(n),t.push(o+e[++a]),n=\`\`;continue}n+=o}return t.push(n),t}` +
    `function codexLinuxTerminalShellStripComment(e){let t=null,n=!1;for(let r=0;r<e.length;r++){let i=e[r];if(n){n=!1;continue}if(i===\`\\\\\`){n=!0;continue}if(t){i===t&&(t=null);continue}if(i===\`"\`||i===\`'\`){t=i;continue}if(i===\`#\`&&(r===0||/\\s/u.test(e[r-1])))return e.slice(0,r)}return e}` +
    `function codexLinuxTerminalTryExecShellAvailable(e,t,n){let r=codexLinuxTerminalShellSegments(n),i=null,a=null,o=!1,h=(e||\`\`).split(\`/\`).pop();for(let n of r){if(n===\`&&\`||n===\`||\`){a=n;continue}n=codexLinuxTerminalShellStripComment(n);let r=codexLinuxTerminalShellProbeCommand(n,h),s,c=n.trim(),l=c.match(/^exec\\s+(.+?)\\s*$/u),p=i,u=a,m=p==null?!0:u===\`&&\`?!!p:u===\`||\`?!p:!0;if(r!=null)s=r;else if(c===\`true\`||c===\`:\`||c.startsWith(\`:\`)&&codexLinuxTerminalShellProbeTail(c.slice(1)))s=!0;else if(c===\`false\`)s=!1;else if(l){let e=l[1].trim();s=/\\s/u.test(e)&&!/^([\"']).*\\1$/u.test(e)?codexLinuxTerminalTryExecAvailable(e):codexLinuxTerminalExecutablePath(codexLinuxTerminalShellArg(e))!=null}else s=/[;|!]/u.test(c)?!1:codexLinuxTerminalTryExecAvailable(n);o=!0;i=i==null?s:a===\`&&\`?i&&s:a===\`||\`?i||s:s;if(l&&m)return!!i;a=null}return o?!!i:codexLinuxTerminalTryExecAvailable(n)}` +
    `function codexLinuxTerminalFlatpakTryExecShellAvailable(e){let t=codexLinuxTerminalShellSegments(e),n=null,r=null,i=!1;for(let e of t){if(e===\`&&\`||e===\`||\`){r=e;continue}let t=codexLinuxTerminalShellStripComment(e).trim(),a=t===\`true\`||t===\`exec true\`?!0:t===\`false\`||t===\`exec false\`?!1:!1;i=!0;n=n==null?a:r===\`&&\`?n&&a:r===\`||\`?n||a:a;if(/^exec\\s+/u.test(t)&&a)return!!n;r=null}return i?!!n:!1}` +
    `function codexLinuxTerminalShellCommandIndex(e){for(let t=1;t<e.length-1;t++){let n=e[t];if(n===\`-c\`||n===\`-C\`||n===\`--command\`)return t+1;if(n.startsWith(\`-\`)&&!n.startsWith(\`--\`)&&n.includes(\`c\`))return t+1}return-1}` +
    `function codexLinuxTerminalFlatpakShellAvailable(e,t){let _codexStart=0;for(;;){let _codexHead=e[_codexStart];if((0,${pathVar}.basename)(_codexHead||\`\`)===\`env\`){if(codexLinuxTerminalExecutablePath(_codexHead)==null)return!1;_codexStart++;continue}if(_codexHead&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(_codexHead)){_codexStart++;continue}if(_codexHead===\`-i\`||_codexHead===\`--ignore-environment\`||_codexHead?.startsWith(\`--unset=\`)){_codexStart++;continue}if(_codexHead===\`-u\`||_codexHead===\`--unset\`){_codexStart+=2;continue}break}if((0,${pathVar}.basename)(e[_codexStart]||\`\`)!==\`flatpak\`)return null;let _codexRun=_codexStart+1,_codexScope=null;for(;e[_codexRun]===\`--user\`||e[_codexRun]===\`--system\`||e[_codexRun]?.startsWith(\`--installation=\`)||e[_codexRun]===\`--installation\`;){let _codexOpt=e[_codexRun];_codexScope=_codexOpt===\`--user\`?{scope:\`user\`}:_codexOpt===\`--system\`?{scope:\`system\`}:_codexOpt===\`--installation\`?{scope:\`installation\`,name:e[_codexRun+1]}:{scope:\`installation\`,name:_codexOpt.slice(15)};_codexRun+=_codexOpt===\`--installation\`?2:1}if(e[_codexRun]!==\`run\`)return null;if(codexLinuxTerminalExecutablePath(e[_codexStart])==null)return!1;let _codexCommand=null,_codexApp=null,_codexIndex=_codexRun+1,_codexValueOptions=new Set([\`--branch\`,\`--arch\`,\`--env\`,\`--unset-env\`,\`--cwd\`,\`--filesystem\`,\`--socket\`,\`--device\`,\`--share\`,\`--talk-name\`,\`--own-name\`,\`--add-policy\`,\`--remove-policy\`]);for(;_codexIndex<e.length;_codexIndex++){let _codexToken=e[_codexIndex];if(_codexToken.startsWith(\`--command=\`)){_codexCommand=_codexToken.slice(10);continue}if(_codexToken===\`--command\`){_codexCommand=e[++_codexIndex];continue}if(_codexValueOptions.has(_codexToken)){_codexIndex++;continue}if(_codexToken.startsWith(\`-\`))continue;_codexApp=_codexToken,_codexIndex++;break}if(!_codexApp||!codexLinuxTerminalFlatpakAvailable(_codexApp,_codexScope))return!1;if(!_codexCommand)return!0;let _codexShell=(0,${pathVar}.basename)(_codexCommand);if(_codexShell!==\`sh\`||!t.has(_codexShell))return!1;let _codexArgs=[_codexCommand,...e.slice(_codexIndex)],_codexShellIndex=codexLinuxTerminalShellCommandIndex(_codexArgs);return _codexShellIndex>0?codexLinuxTerminalFlatpakTryExecShellAvailable(_codexArgs[_codexShellIndex]??\`\`):!1}` +
    `function codexLinuxTerminalTryExecAvailable(e){let t=codexLinuxTerminalSplitDesktopExec(e),n=!1,skipControls=new Set([\`&&\`,\`||\`,\`;\`,\`|\`,\`!\`,\`then\`,\`fi\`,\`do\`,\`done\`]),skipCommands=new Set([\`env\`,\`test\`,\`[\`,\`]\`,\`exec\`,\`command\`,\`which\`,\`type\`,\`hash\`]),shells=new Set([\`sh\`,\`bash\`,\`dash\`,\`zsh\`,\`fish\`]),q=codexLinuxTerminalFlatpakInfoAvailable(e);if(q!=null)return q;q=codexLinuxTerminalFlatpakInfoTokensAvailable(t);if(q!=null)return q;let r=codexLinuxTerminalFlatpakShellAvailable(t,shells);if(r!=null)return r;for(var f=0;;){let e=t[f];if((0,${pathVar}.basename)(e||\`\`)===\`env\`||e&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(e)||e===\`-i\`||e===\`--ignore-environment\`||e?.startsWith(\`--unset=\`)){f++;continue}if(e===\`-u\`||e===\`--unset\`){f+=2;continue}break}if((0,${pathVar}.basename)(t[f]||\`\`)===\`flatpak\`&&f===t.length-1)return codexLinuxTerminalExecutablePath(t[f])!=null;for(let e=0;e<t.length-1;e++){let n=(0,${pathVar}.basename)(t[e]);if(shells.has(n)){var a=!0;for(var o=0;o<e;o++){var s=(0,${pathVar}.basename)(t[o]);if(t[o]===\`-u\`||t[o]===\`--unset\`){o++;continue}if(t[o].includes(\`=\`)&&!(0,${pathVar}.isAbsolute)(t[o])||t[o].startsWith(\`-\`)||skipControls.has(t[o])||s===\`env\`)continue;if(s===\`flatpak\`){a=codexLinuxTerminalExecutablePath(t[o])!=null;break}if(!codexLinuxTerminalExecutablePath(t[o])){a=!1;break}}var l=codexLinuxTerminalShellCommandIndex(t.slice(e));if(l>0)return a&&codexLinuxTerminalExecutablePath(t[e])?codexLinuxTerminalTryExecShellAvailable(t[e],t[e+l-1],t[e+l]??\`\`):!1}}for(let e=0;e<t.length;e++){let r=t[e],a=(0,${pathVar}.basename)(r);if(r===\`-u\`||r===\`--unset\`){e++;continue}if(r.includes(\`=\`)&&!(0,${pathVar}.isAbsolute)(r))continue;if(a===\`flatpak\`){n=!0;continue}if(r.startsWith(\`-\`)||skipControls.has(r)||skipCommands.has(a))continue;n=!0;if(codexLinuxTerminalExecutablePath(r))return!0}return!n}` +
    `function codexLinuxDiscoveredTerminalInfo(){for(let e of codexLinuxTerminalDesktopDirs())for(let t of codexLinuxTerminalDesktopEntryFiles(e)){let e=codexLinuxParseTerminalDesktopEntry(t);if(!e||!codexLinuxLooksLikeTerminal(e))continue;if(e.TryExec&&!codexLinuxTerminalTryExecAvailable(e.TryExec))continue;let n=codexLinuxResolveTerminalDesktopExec(e.Exec);if(!n)continue;return{command:n.command,args:n.args,dirArg:e[\`X-TerminalArgDir\`]||null}}return null}` +
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

function applyTerminalDiscoveryPatch(currentSource, deps) {
  if (currentSource.includes("linux:{label:`Terminal`")) {
    return currentSource;
  }

  const terminalIndex = currentSource.indexOf("id:`terminal`");
  if (terminalIndex === -1) {
    warn("Could not find terminal open target");
    return currentSource;
  }

  const terminalDeclarationIndex = Math.max(
    currentSource.lastIndexOf("var ", terminalIndex),
    currentSource.lastIndexOf("let ", terminalIndex),
    currentSource.lastIndexOf("const ", terminalIndex),
  );
  let patchedSource = insertOpenTargetHelpers(
    currentSource,
    terminalDeclarationIndex >= 0 ? terminalDeclarationIndex : terminalIndex,
    deps,
  );
  patchedSource = insertTerminalHelpers(patchedSource, deps);

  const patchedTerminalIndex = patchedSource.indexOf("id:`terminal`");
  const platformsIndex = patchedSource.indexOf("platforms:{", patchedTerminalIndex);
  const platformsBlock =
    platformsIndex === -1 ? null : findBalancedBlock(patchedSource, patchedSource.indexOf("{", platformsIndex));
  if (platformsBlock == null || platformsBlock.text.includes("linux:{")) {
    warn("Could not apply terminal open-target patch");
    return currentSource;
  }

  const linuxTerminal =
    `,linux:{label:\`Terminal\`,icon:\`apps/terminal.png\`,kind:\`terminal\`,detect:()=>codexLinuxTerminalInfo()?.command??null,args:e=>codexLinuxTerminalArgs(codexLinuxTerminalInfo(),e),open:async({command:e,path:t})=>{await codexLinuxLaunchDetached(e,codexLinuxTerminalArgs(codexLinuxTerminalInfo()??e,t),{cwd:codexLinuxTerminalCwd(t)})}}`;
  return patchedSource.slice(0, platformsBlock.end - 1) + linuxTerminal + patchedSource.slice(platformsBlock.end - 1);
}

function applyIdeDiscoveryPatch(currentSource, deps) {
  if (currentSource.includes("...codexLinuxDiscoveredIdeTargets()")) {
    return currentSource;
  }

  const { fsVar, pathVar } = deps;
  const editorFactoryIndex = currentSource.search(/function\s+[A-Za-z_$][\w$]*\(\{id:[A-Za-z_$][\w$]*,label:[A-Za-z_$][\w$]*,icon:[A-Za-z_$][\w$]*,darwinDetect:/u);
  const jetBrainsFactoryIndex = currentSource.search(/function\s+[A-Za-z_$][\w$]*\(\{id:[A-Za-z_$][\w$]*,label:[A-Za-z_$][\w$]*,icon:[A-Za-z_$][\w$]*,toolboxTarget:/u);
  const hasEditorFactory = editorFactoryIndex !== -1;
  const hasJetBrainsFactory = jetBrainsFactoryIndex !== -1;
  const hasZedTarget = currentSource.includes("id:`zed`");
  if (!hasEditorFactory && !hasJetBrainsFactory && !hasZedTarget) {
    warn("Could not find IDE open-target factories");
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
  let patchedSource = insertOpenTargetHelpers(
    currentSource,
    openTargetHelperInsertionIndex,
    deps,
  );

  const ideCoreHelpers = patchedSource.includes("function codexLinuxIdeCommand(")
    ? ""
    : `function codexLinuxIdeCommand(e){let t={cursor:[\`cursor\`],vscode:[\`code\`,\`codium\`],vscodeInsiders:[\`code-insiders\`],windsurf:[\`windsurf\`],antigravity:[\`antigravity\`],zed:[\`zed\`,\`zeditor\`,\`zedit\`,\`zed-cli\`],intellij:[\`idea\`],webstorm:[\`webstorm\`],pycharm:[\`pycharm\`],goland:[\`goland\`],clion:[\`clion\`],rustrover:[\`rustrover\`],rider:[\`rider\`],phpstorm:[\`phpstorm\`],androidStudio:[\`studio\`,\`studio.sh\`]}[e]??[];for(let e of t){let t=codexLinuxFindExecutable(e);if(t)return t}return null}` +
      `function codexLinuxIdePlatform(e,t,n,r,i){let a=codexLinuxIdeCommand(e);return a?{label:t,icon:n,kind:\`editor\`,hidden:r,detect:()=>a,args:i,supportsSsh:!0}:void 0}` +
      `function codexLinuxJetBrainsIdePlatform(e,t,n,r){let i=codexLinuxIdeCommand(e);return i?{label:t,icon:n,kind:\`editor\`,detect:()=>i,args:r}:void 0}`;
  const dynamicDiscoveryHelpers = patchedSource.includes("function codexLinuxDiscoveredIdeTargets(")
    ? ""
    : `function codexLinuxSplitDesktopExec(e){let t=[],n=\`\`,r=null,i=!1;for(let a=0;a<e.length;a++){let o=e[a];if(i){n+=o,i=!1;continue}if(o===\`\\\\\`){r&&(n+=o);i=!0;continue}if(r){o===r?r=null:n+=o;continue}if(o===\`"\`||o===\`'\`){r=o;continue}if(/\\s/u.test(o)){n&&(t.push(n),n=\`\`);continue}n+=o}return n&&t.push(n),t}` +
    `function codexLinuxDesktopDirs(){if(process.platform!==\`linux\`)return[];let e=process.env.HOME||\`/nonexistent\`,t=process.env.XDG_DATA_HOME&&(0,${pathVar}.isAbsolute)(process.env.XDG_DATA_HOME)?[process.env.XDG_DATA_HOME]:[(0,${pathVar}.join)(e,\`.local/share\`)],n=(process.env.XDG_DATA_DIRS&&process.env.XDG_DATA_DIRS.length>0?process.env.XDG_DATA_DIRS:\`/usr/local/share:/usr/share\`).split(\`:\`).filter(Boolean),r=[...t,...n,(0,${pathVar}.join)(e,\`.local/share/flatpak/exports/share\`),\`/var/lib/flatpak/exports/share\`,\`/var/lib/snapd/desktop\`],a=new Set;return r.map(e=>(0,${pathVar}.join)(e,\`applications\`)).filter(e=>e&&(0,${pathVar}.isAbsolute)(e)&&!a.has(e)&&(a.add(e),!0))}` +
    `function codexLinuxDesktopEntryFiles(e,t=0){let n=[];if(t>4)return n;try{for(let r of (0,${fsVar}.readdirSync)(e,{withFileTypes:!0})){let a=(0,${pathVar}.join)(e,r.name);r.isDirectory()?n.push(...codexLinuxDesktopEntryFiles(a,t+1)):(r.isFile()||r.isSymbolicLink())&&r.name.endsWith(\`.desktop\`)&&n.push(a)}}catch{}return n}` +
    `function codexLinuxParseDesktopEntry(e){let t={Id:(0,${pathVar}.basename)(e).replace(/\\.desktop$/u,\`\`)},n=\`\`;try{for(let r of (0,${fsVar}.readFileSync)(e,\`utf8\`).split(/\\r?\\n/u)){let e=r.trim();if(!e||e.startsWith(\`#\`))continue;if(e.startsWith(\`[\`)&&e.endsWith(\`]\`)){n=e.slice(1,-1);continue}if(n&&n!==\`Desktop Entry\`)continue;let i=e.indexOf(\`=\`);if(i<1)continue;let a=e.slice(0,i).replace(/\\[.*\\]$/u,\`\`),o=e.slice(i+1);t[a]??=o}}catch{return null}let r=e=>(e||\`\`).trim().toLowerCase()===\`true\`;return(t.Type&&t.Type!==\`Application\`)||r(t.NoDisplay)||r(t.Terminal)||!r(t.Hidden)&&(!t.Exec||!t.Name)?null:t}` +
    `function codexLinuxLooksLikeIde(e){let t=\`;\${(e.Categories||\`\`).toLowerCase()};\`,n=[e.Name,e.GenericName,e.Comment,e.Keywords,e.Exec].filter(Boolean).join(\` \`).toLowerCase(),r=/(;)(office|wordprocessor|spreadsheet|presentation|graphics|audiovideo|audiovideoediting|building)(;)/u.test(t),i=/;ide;/u.test(t);if(r&&!i)return!1;if(i)return!0;return/(;)(development|texteditor)(;)/u.test(t)&&/\\b(code|coding|codium|cursor|zed|ide|jetbrains|sublime|emacs|vim|neovim|neovide|kate|builder|windsurf|antigravity|rstudio|positron|agent|agents|agentic|workspace|workspaces)\\b/u.test(n)}` +
    `function codexLinuxExecutablePath(e){if(!e)return null;if(!(0,${pathVar}.isAbsolute)(e))return codexLinuxFindExecutable(e);try{if((0,${fsVar}.existsSync)(e)){let t=(0,${fsVar}.statSync)(e);if(t.isFile())try{(0,${fsVar}.accessSync)(e,${fsVar}.constants.X_OK);return e}catch{}}}catch{}return null}` +
    `function codexLinuxResolveDesktopExec(e){let t=codexLinuxSplitDesktopExec(e);if(t.length===0)return null;for(;;){if((0,${pathVar}.basename)(t[0]||\`\`)===\`env\`){t.shift();continue}if(t[0]&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(t[0])){t.shift();continue}if(t[0]===\`-u\`||t[0]===\`--unset\`){t.splice(0,2);continue}break}let n=t.shift();if(!n)return null;let r=codexLinuxExecutablePath(n);return r?{command:r,args:t,base:(0,${pathVar}.basename)(n).replace(/\\.(sh|bin)$/u,\`\`).toLowerCase()}:null}` +
    `function codexLinuxDesktopShellArg(e){if(!e)return\`\`;let t=e[0],n=e[e.length-1],r=(t===\`"\`||t===\`'\`)&&n===t?t:null;r&&(e=e.slice(1,-1));let i=process.env.HOME||\`\`;r==null&&(e=e.replace(/^~(?=\\/|$)/u,i).replace(/\\\\([^$])/gu,\`$1\`));r!==\`'\`&&(e=e.replace(/\\$\\{HOME\\}|\\$HOME/gu,i));return e}` +
    `function codexLinuxDesktopFlatpakRoots(){let e=process.env.HOME||\`/nonexistent\`,t=[{root:(0,${pathVar}.join)(e,\`.local/share/flatpak\`),scope:\`user\`},{root:\`/var/lib/flatpak\`,scope:\`system\`}];try{for(let e of (0,${fsVar}.readdirSync)(\`/etc/flatpak/installations.d\`)){try{let n=(0,${fsVar}.readFileSync)((0,${pathVar}.join)(\`/etc/flatpak/installations.d\`,e),\`utf8\`).match(/^\\s*Path\\s*=\\s*(.+?)\\s*$/mu)?.[1]?.replace(/^["']|["']$/gu,\`\`);n&&(0,${pathVar}.isAbsolute)(n)&&t.push({root:n,scope:\`installation\`,name:e.replace(/\\.conf$/u,\`\`)})}catch{}}}catch{}return t}` +
    `function codexLinuxDesktopFlatpakAvailable(e,t){for(let n of codexLinuxDesktopFlatpakRoots())try{if(t?.scope&&n.scope!==t.scope)continue;if(t?.name&&n.name!==t.name)continue;if((0,${fsVar}.existsSync)((0,${pathVar}.join)(n.root,\`app\`,e)))return!0}catch{}return!1}` +
    `function codexLinuxDesktopShellProbeTail(e){return/^(?:\\s*(?:(?:\\d*>>?|\\d*<|&>)\\s*\\S+|\\d*>&\\d+))*\\s*$/u.test(e)}` +
    `function codexLinuxDesktopFlatpakScope(e){let t=e.match(/(?:^|\\s)--installation(?:=((?:"[^"]*"|'[^']*'|[^\\s;&|()<>]+))|\\s+((?:"[^"]*"|'[^']*'|[^\\s;&|()<>]+)))/u);return t?{scope:\`installation\`,name:codexLinuxDesktopShellArg(t[1]||t[2])}:/(?:^|\\s)--user(?:\\s|$)/u.test(e)?{scope:\`user\`}:/(?:^|\\s)--system(?:\\s|$)/u.test(e)?{scope:\`system\`}:null}` +
    `function codexLinuxDesktopFlatpakInfoAvailable(e){let t=e.match(/^\\s*((?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))\\s+(?:(?:--(?:system|user|show-location)|--installation(?:=(?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+)|\\s+(?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))?)\\s+)*info\\s+(?:(?:--(?:system|user|show-location)|--installation(?:=(?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+)|\\s+(?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))?)\\s+)*((?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))/u);if(!t)return null;let n=codexLinuxDesktopShellArg(t[1]);return(0,${pathVar}.basename)(n)!==\`flatpak\`?null:codexLinuxDesktopShellProbeTail(e.slice(t[0].length))?codexLinuxExecutablePath(n)!=null&&codexLinuxDesktopFlatpakAvailable(codexLinuxDesktopShellArg(t[2]),codexLinuxDesktopFlatpakScope(t[0])):!1}` +
    `function codexLinuxDesktopFlatpakInfoTokensAvailable(e){let t=0;for(;;){let n=e[t];if((0,${pathVar}.basename)(n||\`\`)===\`env\`){if(codexLinuxExecutablePath(n)==null)return!1;t++;continue}if(n&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(n)){t++;continue}if(n===\`-i\`||n===\`--ignore-environment\`||n?.startsWith(\`--unset=\`)){t++;continue}if(n===\`-u\`||n===\`--unset\`){t+=2;continue}break}if((0,${pathVar}.basename)(e[t]||\`\`)!==\`flatpak\`)return null;if(codexLinuxExecutablePath(e[t])==null)return!1;let n=t+1,r=null,a=e=>e===\`--user\`?{scope:\`user\`}:e===\`--system\`?{scope:\`system\`}:null;for(;;){let t=e[n];if(t===\`--user\`||t===\`--system\`){r=a(t),n++;continue}if(t?.startsWith(\`--installation=\`)){r={scope:\`installation\`,name:t.slice(15)},n++;continue}if(t===\`--installation\`){r={scope:\`installation\`,name:e[n+1]},n+=2;continue}if(t===\`--verbose\`){n++;continue}if(t?.startsWith(\`-\`))return!1;break}if(e[n]!==\`info\`)return null;n++;for(;n<e.length;n++){let t=e[n];if(t===\`--user\`||t===\`--system\`){r=a(t);continue}if(t?.startsWith(\`--installation=\`)){r={scope:\`installation\`,name:t.slice(15)};continue}if(t===\`--installation\`){r={scope:\`installation\`,name:e[++n]};continue}if(t===\`--show-location\`||t===\`--verbose\`)continue;if(t.startsWith(\`-\`))return!1;return codexLinuxDesktopFlatpakAvailable(t,r)}return!1}` +
    `function codexLinuxDesktopShellProbeCommand(e,t){let n=e.match(/^\\s*((?:command\\s+-v)|which|type|hash)\\s+((?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()<>])+))/u);if(n&&codexLinuxDesktopShellProbeTail(e.slice(n[0].length)))return n[1]===\`which\`&&codexLinuxExecutablePath(\`which\`)==null||n[1]===\`hash\`&&t===\`fish\`?!1:codexLinuxExecutablePath(codexLinuxDesktopShellArg(n[2]))!=null;n=e.match(/^\\s*(test\\s+-x|\\[\\s+-x|\\[\\[\\s+-x)\\s+((?:"[^"]*"|'[^']*'|(?:\\\\.|[^\\s;&|()\\]])+))/u);if(n&&(!n[1].startsWith(\`[[\`)||[\`bash\`,\`zsh\`].includes(t))&&codexLinuxDesktopShellProbeTail(e.slice(n[0].length).replace(/^\\s*\\]{1,2}/u,\`\`)))return codexLinuxExecutablePath(codexLinuxDesktopShellArg(n[2]))!=null;return codexLinuxDesktopFlatpakInfoAvailable(e)}` +
    `function codexLinuxDesktopShellSegments(e){let t=[],n=\`\`,r=null,i=!1;for(let a=0;a<e.length;a++){let o=e[a];if(i){n+=o,i=!1;continue}if(o===\`\\\\\`){n+=o,i=!0;continue}if(r){n+=o,o===r&&(r=null);continue}if(o===\`"\`||o===\`'\`){r=o,n+=o;continue}if(o===\`&\`&&e[a+1]===\`&\`||o===\`|\`&&e[a+1]===\`|\`){t.push(n),t.push(o+e[++a]),n=\`\`;continue}n+=o}return t.push(n),t}` +
    `function codexLinuxDesktopShellStripComment(e){let t=null,n=!1;for(let r=0;r<e.length;r++){let i=e[r];if(n){n=!1;continue}if(i===\`\\\\\`){n=!0;continue}if(t){i===t&&(t=null);continue}if(i===\`"\`||i===\`'\`){t=i;continue}if(i===\`#\`&&(r===0||/\\s/u.test(e[r-1])))return e.slice(0,r)}return e}` +
    `function codexLinuxDesktopTryExecShellAvailable(e,t,n){let r=codexLinuxDesktopShellSegments(n),i=null,a=null,o=!1,h=(e||\`\`).split(\`/\`).pop();for(let n of r){if(n===\`&&\`||n===\`||\`){a=n;continue}n=codexLinuxDesktopShellStripComment(n);let r=codexLinuxDesktopShellProbeCommand(n,h),s,c=n.trim(),l=c.match(/^exec\\s+(.+?)\\s*$/u),p=i,u=a,m=p==null?!0:u===\`&&\`?!!p:u===\`||\`?!p:!0;if(r!=null)s=r;else if(c===\`true\`||c===\`:\`||c.startsWith(\`:\`)&&codexLinuxDesktopShellProbeTail(c.slice(1)))s=!0;else if(c===\`false\`)s=!1;else if(l){let e=l[1].trim();s=/\\s/u.test(e)&&!/^([\"']).*\\1$/u.test(e)?codexLinuxDesktopTryExecAvailable(e):codexLinuxExecutablePath(codexLinuxDesktopShellArg(e))!=null}else s=/[;|!]/u.test(c)?!1:codexLinuxDesktopTryExecAvailable(n);o=!0;i=i==null?s:a===\`&&\`?i&&s:a===\`||\`?i||s:s;if(l&&m)return!!i;a=null}return o?!!i:codexLinuxDesktopTryExecAvailable(n)}` +
    `function codexLinuxDesktopFlatpakTryExecShellAvailable(e){let t=codexLinuxDesktopShellSegments(e),n=null,r=null,i=!1;for(let e of t){if(e===\`&&\`||e===\`||\`){r=e;continue}let t=codexLinuxDesktopShellStripComment(e).trim(),a=t===\`true\`||t===\`exec true\`?!0:t===\`false\`||t===\`exec false\`?!1:!1;i=!0;n=n==null?a:r===\`&&\`?n&&a:r===\`||\`?n||a:a;if(/^exec\\s+/u.test(t)&&a)return!!n;r=null}return i?!!n:!1}` +
    `function codexLinuxDesktopShellCommandIndex(e){for(let t=1;t<e.length-1;t++){let n=e[t];if(n===\`-c\`||n===\`-C\`||n===\`--command\`)return t+1;if(n.startsWith(\`-\`)&&!n.startsWith(\`--\`)&&n.includes(\`c\`))return t+1}return-1}` +
    `function codexLinuxDesktopFlatpakShellAvailable(e,t){let _codexStart=0;for(;;){let _codexHead=e[_codexStart];if((0,${pathVar}.basename)(_codexHead||\`\`)===\`env\`){if(codexLinuxExecutablePath(_codexHead)==null)return!1;_codexStart++;continue}if(_codexHead&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(_codexHead)){_codexStart++;continue}if(_codexHead===\`-i\`||_codexHead===\`--ignore-environment\`||_codexHead?.startsWith(\`--unset=\`)){_codexStart++;continue}if(_codexHead===\`-u\`||_codexHead===\`--unset\`){_codexStart+=2;continue}break}if((0,${pathVar}.basename)(e[_codexStart]||\`\`)!==\`flatpak\`)return null;let _codexRun=_codexStart+1,_codexScope=null;for(;e[_codexRun]===\`--user\`||e[_codexRun]===\`--system\`||e[_codexRun]?.startsWith(\`--installation=\`)||e[_codexRun]===\`--installation\`;){let _codexOpt=e[_codexRun];_codexScope=_codexOpt===\`--user\`?{scope:\`user\`}:_codexOpt===\`--system\`?{scope:\`system\`}:_codexOpt===\`--installation\`?{scope:\`installation\`,name:e[_codexRun+1]}:{scope:\`installation\`,name:_codexOpt.slice(15)};_codexRun+=_codexOpt===\`--installation\`?2:1}if(e[_codexRun]!==\`run\`)return null;if(codexLinuxExecutablePath(e[_codexStart])==null)return!1;let _codexCommand=null,_codexApp=null,_codexIndex=_codexRun+1,_codexValueOptions=new Set([\`--branch\`,\`--arch\`,\`--env\`,\`--unset-env\`,\`--cwd\`,\`--filesystem\`,\`--socket\`,\`--device\`,\`--share\`,\`--talk-name\`,\`--own-name\`,\`--add-policy\`,\`--remove-policy\`]);for(;_codexIndex<e.length;_codexIndex++){let _codexToken=e[_codexIndex];if(_codexToken.startsWith(\`--command=\`)){_codexCommand=_codexToken.slice(10);continue}if(_codexToken===\`--command\`){_codexCommand=e[++_codexIndex];continue}if(_codexValueOptions.has(_codexToken)){_codexIndex++;continue}if(_codexToken.startsWith(\`-\`))continue;_codexApp=_codexToken,_codexIndex++;break}if(!_codexApp||!codexLinuxDesktopFlatpakAvailable(_codexApp,_codexScope))return!1;if(!_codexCommand)return!0;let _codexShell=(0,${pathVar}.basename)(_codexCommand);if(_codexShell!==\`sh\`||!t.has(_codexShell))return!1;let _codexArgs=[_codexCommand,...e.slice(_codexIndex)],_codexShellIndex=codexLinuxDesktopShellCommandIndex(_codexArgs);return _codexShellIndex>0?codexLinuxDesktopFlatpakTryExecShellAvailable(_codexArgs[_codexShellIndex]??\`\`):!1}` +
    `function codexLinuxDesktopTryExecAvailable(e){let t=codexLinuxSplitDesktopExec(e),n=!1,skipControls=new Set([\`&&\`,\`||\`,\`;\`,\`|\`,\`!\`,\`then\`,\`fi\`,\`do\`,\`done\`]),skipCommands=new Set([\`env\`,\`test\`,\`[\`,\`]\`,\`exec\`,\`command\`,\`which\`,\`type\`,\`hash\`]),shells=new Set([\`sh\`,\`bash\`,\`dash\`,\`zsh\`,\`fish\`]),q=codexLinuxDesktopFlatpakInfoAvailable(e);if(q!=null)return q;q=codexLinuxDesktopFlatpakInfoTokensAvailable(t);if(q!=null)return q;let r=codexLinuxDesktopFlatpakShellAvailable(t,shells);if(r!=null)return r;for(var f=0;;){let e=t[f];if((0,${pathVar}.basename)(e||\`\`)===\`env\`||e&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(e)||e===\`-i\`||e===\`--ignore-environment\`||e?.startsWith(\`--unset=\`)){f++;continue}if(e===\`-u\`||e===\`--unset\`){f+=2;continue}break}if((0,${pathVar}.basename)(t[f]||\`\`)===\`flatpak\`&&f===t.length-1)return codexLinuxExecutablePath(t[f])!=null;for(let e=0;e<t.length-1;e++){let n=(0,${pathVar}.basename)(t[e]);if(shells.has(n)){var a=!0;for(var o=0;o<e;o++){var s=(0,${pathVar}.basename)(t[o]);if(t[o]===\`-u\`||t[o]===\`--unset\`){o++;continue}if(t[o].includes(\`=\`)&&!(0,${pathVar}.isAbsolute)(t[o])||t[o].startsWith(\`-\`)||skipControls.has(t[o])||s===\`env\`)continue;if(s===\`flatpak\`){a=codexLinuxExecutablePath(t[o])!=null;break}if(!codexLinuxExecutablePath(t[o])){a=!1;break}}var l=codexLinuxDesktopShellCommandIndex(t.slice(e));if(l>0)return a&&codexLinuxExecutablePath(t[e])?codexLinuxDesktopTryExecShellAvailable(t[e],t[e+l-1],t[e+l]??\`\`):!1}}for(let e=0;e<t.length;e++){let r=t[e],a=(0,${pathVar}.basename)(r);if(r===\`-u\`||r===\`--unset\`){e++;continue}if(r.includes(\`=\`)&&!(0,${pathVar}.isAbsolute)(r))continue;if(a===\`flatpak\`){n=!0;continue}if(r.startsWith(\`-\`)||skipControls.has(r)||skipCommands.has(a))continue;n=!0;if(codexLinuxExecutablePath(r))return!0}return!n}` +
    `function codexLinuxPathToFileUri(e){try{return require(\`node:url\`).pathToFileURL(e).toString()}catch{return e}}` +
    `function codexLinuxDesktopArgs(e,t){let n=[],r=codexLinuxPathToFileUri(t);for(let a of e){if(a===\`%%\`){n.push(\`%\`);continue}if(/^%[fF]$/u.test(a)){n.push(t);continue}if(/^%[uU]$/u.test(a)){n.push(r);continue}if(/^%[dD]$/u.test(a)){n.push((0,${pathVar}.dirname)(t));continue}if(/^%[nN]$/u.test(a)){n.push((0,${pathVar}.basename)(t));continue}if(/^%[ickvm]$/u.test(a))continue;let o=a.replace(/%[fF]/gu,t).replace(/%[uU]/gu,r).replace(/%[dD]/gu,(0,${pathVar}.dirname)(t)).replace(/%[nN]/gu,(0,${pathVar}.basename)(t)).replace(/%%/gu,\`%\`).replace(/%[A-Za-z]/gu,\`\`);o&&n.push(o)}return n}` +
    `function codexLinuxDesktopEntryLaunchId(e){return(0,${pathVar}.basename)(e).replace(/\\.desktop$/u,\`\`)}` +
    `function codexLinuxDesktopLaunchOptions(){return{cwd:process.env.HOME||void 0}}` +
    `async function codexLinuxLaunchDesktopEntry(e,t,n,r){let i=codexLinuxFindExecutable(\`gio\`),a=codexLinuxDesktopLaunchOptions();if(i)try{await codexLinuxLaunchDetached(i,[\`launch\`,e,t],a);return}catch{}let o=codexLinuxFindExecutable(\`gtk-launch\`);if(o)try{await codexLinuxLaunchDetached(o,[codexLinuxDesktopEntryLaunchId(e),codexLinuxPathToFileUri(t)],a);return}catch{}await codexLinuxLaunchDetached(n,codexLinuxDesktopArgs(r,t),a)}` +
    `function codexLinuxKnownIdeDesktopDuplicate(e){let t=new Set([\`cursor\`,\`code\`,\`codium\`,\`code-insiders\`,\`windsurf\`,\`antigravity\`,\`zed\`,\`zeditor\`,\`zedit\`,\`zed-cli\`,\`idea\`,\`webstorm\`,\`pycharm\`,\`goland\`,\`clion\`,\`rustrover\`,\`rider\`,\`phpstorm\`,\`studio\`,\`studio.sh\`]);return t.has(e.base)&&codexLinuxFindExecutable(e.base)!=null}` +
    `function codexLinuxDesktopIdeIcon(e,t){let n=\`\${e.Name||\`\`} \${e.Id||\`\`} \${t.base||\`\`}\`.toLowerCase();for(let[e,t]of [[\`cursor\`,\`apps/cursor.png\`],[\`code-insiders\`,\`apps/vscode-insiders.png\`],[\`vscode\`,\`apps/vscode.png\`],[\`visual studio code\`,\`apps/vscode.png\`],[\`codium\`,\`apps/vscode.png\`],[\`zed\`,\`apps/zed.png\`],[\`sublime\`,\`apps/sublime-text.png\`],[\`emacs\`,\`apps/emacs.png\`],[\`intellij\`,\`apps/intellij.png\`],[\`webstorm\`,\`apps/webstorm.svg\`],[\`pycharm\`,\`apps/pycharm.png\`],[\`goland\`,\`apps/goland.png\`],[\`clion\`,\`apps/clion.png\`],[\`rustrover\`,\`apps/rustrover.png\`],[\`rider\`,\`apps/rider.png\`],[\`phpstorm\`,\`apps/phpstorm.png\`],[\`android studio\`,\`apps/android-studio.png\`],[\`windsurf\`,\`apps/windsurf.png\`],[\`antigravity\`,\`apps/antigravity.png\`]])if(n.includes(e))return t;return\`apps/terminal.png\`}` +
    `function codexLinuxIconSearchRoots(){let e=process.env.HOME||\`/nonexistent\`,t=process.env.XDG_DATA_HOME&&(0,${pathVar}.isAbsolute)(process.env.XDG_DATA_HOME)?process.env.XDG_DATA_HOME:(0,${pathVar}.join)(e,\`.local/share\`),n=(process.env.XDG_DATA_DIRS&&process.env.XDG_DATA_DIRS.length>0?process.env.XDG_DATA_DIRS:\`/usr/local/share:/usr/share\`).split(\`:\`).filter(Boolean),r=[(0,${pathVar}.join)(t,\`icons\`),(0,${pathVar}.join)(e,\`.icons\`),...n.map(e=>(0,${pathVar}.join)(e,\`icons\`)),(0,${pathVar}.join)(t,\`pixmaps\`),...n.map(e=>(0,${pathVar}.join)(e,\`pixmaps\`)),(0,${pathVar}.join)(e,\`.local/share/flatpak/exports/share/icons\`),(0,${pathVar}.join)(e,\`.local/share/flatpak/exports/share/pixmaps\`),\`/var/lib/flatpak/exports/share/icons\`,\`/var/lib/flatpak/exports/share/pixmaps\`,\`/var/lib/snapd/desktop/icons\`],a=new Set;return r.filter(e=>e&&(0,${pathVar}.isAbsolute)(e)&&!a.has(e)&&(a.add(e),!0))}` +
    `function codexLinuxFindIconFile(e,t,n=0){if(n>6)return null;try{for(let r of (0,${fsVar}.readdirSync)(e,{withFileTypes:!0})){let a=(0,${pathVar}.join)(e,r.name);if(r.isDirectory()){let e=codexLinuxFindIconFile(a,t,n+1);if(e)return e}else if((r.isFile()||r.isSymbolicLink())&&r.name.replace(/\\.(png|svg|xpm)$/iu,\`\`)===t&&/\\.(png|svg|xpm)$/iu.test(r.name))return a}}catch{}return null}` +
    `function codexLinuxDesktopIconPath(e){let t=(e.Icon||\`\`).trim();if(!t)return null;if((0,${pathVar}.isAbsolute)(t)){try{if((0,${fsVar}.existsSync)(t))return t}catch{}return null}let n=t.replace(/\\.(png|svg|xpm)$/iu,\`\`),r=[\`png\`,\`svg\`,\`xpm\`];for(let e of codexLinuxIconSearchRoots())for(let t of r){let r=(0,${pathVar}.join)(e,\`\${n}.\${t}\`);try{if((0,${fsVar}.existsSync)(r))return r}catch{}}for(let e of codexLinuxIconSearchRoots()){let t=codexLinuxFindIconFile(e,n);if(t)return t}return null}` +
    `function codexLinuxDesktopIdeId(e){let t=(e.Id||e.Name||e.Exec||\`app\`).toLowerCase().replace(/\\.desktop$/u,\`\`).replace(/[^a-z0-9]+/gu,\`-\`).replace(/^-|-$/gu,\`\`).slice(0,64)||\`app\`;return\`linux-desktop-\${t}\`}` +
    `function codexLinuxUniqueDesktopIdeId(e,t){let n=codexLinuxDesktopIdeId(e),r=n,i=2;for(;t.has(r);)r=\`\${n}-\${i++}\`;return t.add(r),r}` +
    `function codexLinuxDiscoveredIdeTargets(){if(process.platform!==\`linux\`)return[];let e=[],t=new Set,n=new Set,r=new Set;for(let a of codexLinuxDesktopDirs())for(let o of codexLinuxDesktopEntryFiles(a)){let a=codexLinuxParseDesktopEntry(o),s=a?.Id?.toLowerCase();if(!a)continue;if((a.Hidden||\`\`).trim().toLowerCase()===\`true\`){s&&r.add(s);continue}if(s&&r.has(s)||!codexLinuxLooksLikeIde(a))continue;if(a.TryExec&&!codexLinuxDesktopTryExecAvailable(a.TryExec))continue;let i=codexLinuxResolveDesktopExec(a.Exec);if(!i||codexLinuxKnownIdeDesktopDuplicate(i))continue;let c=\`\${a.Name}|${"${i.command}"}|${"${i.args.join(` `)}"}\`.toLowerCase();if(t.has(c))continue;t.add(c);let l=a.Name.trim(),u=codexLinuxDesktopIdeIcon(a,i),d=codexLinuxUniqueDesktopIdeId(a,n),f=codexLinuxDesktopIconPath(a);e.push({id:d,platforms:{linux:{label:l,icon:u,iconPath:f?()=>f:void 0,kind:\`editor\`,detect:()=>i.command,args:e=>codexLinuxDesktopArgs(i.args,e),open:async({command:e,path:t})=>{await codexLinuxLaunchDesktopEntry(o,t,e,i.args)}}}})}return e}`;

  const helpers = ideCoreHelpers + dynamicDiscoveryHelpers;
  if (helpers.length > 0) {
    const helperInsertionIndex = patchedSource.includes("function codexLinuxFindExecutable(")
      ? patchedSource.indexOf("function codexLinuxFindExecutable(")
      : 0;
    const helperEnd = patchedSource.indexOf("async function codexLinuxOpenFileManager(", helperInsertionIndex);
    const ideHelperInsertionIndex = helperEnd === -1 ? helperInsertionIndex : helperEnd;
    patchedSource = patchedSource.slice(0, ideHelperInsertionIndex) + helpers + patchedSource.slice(ideHelperInsertionIndex);
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
    const zedPlatformsBlock = findBalancedBlock(patchedSource, patchedSource.indexOf("{", zedPlatformsIndex));
    if (zedPlatformsBlock != null && !zedPlatformsBlock.text.includes("linux:{")) {
      const argsVar = zedPlatformsBlock.text.match(/win32:\{[^}]*args:([A-Za-z_$][\w$]*)/u)?.[1];
      if (argsVar != null) {
        const linuxZed = `,linux:{label:\`Zed\`,icon:\`apps/zed.png\`,kind:\`editor\`,detect:()=>codexLinuxIdeCommand(\`zed\`),args:${argsVar}}`;
        patchedSource =
          patchedSource.slice(0, zedPlatformsBlock.end - 1) +
          linuxZed +
          patchedSource.slice(zedPlatformsBlock.end - 1);
      }
    }
  }

  if (!patchedSource.includes("...codexLinuxDiscoveredIdeTargets()")) {
    const targetArraySearchStart = Math.min(
      ...[editorFactoryIndex, jetBrainsFactoryIndex, zedDeclarationIndex].filter((index) => index >= 0),
    );
    const targetArrayMatch = patchedSource
      .slice(Number.isFinite(targetArraySearchStart) ? targetArraySearchStart : 0)
      .match(/var\s+[A-Za-z_$][\w$]*=\[[A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)+\](?=,|;)/u);
    if (targetArrayMatch != null) {
      const targetArrayStart =
        (Number.isFinite(targetArraySearchStart) ? targetArraySearchStart : 0) + targetArrayMatch.index;
      const targetArrayText = targetArrayMatch[0];
      const patchedTargetArray = `${targetArrayText.slice(0, -1)},...codexLinuxDiscoveredIdeTargets()]`;
      patchedSource =
        patchedSource.slice(0, targetArrayStart) +
        patchedTargetArray +
        patchedSource.slice(targetArrayStart + targetArrayText.length);
    } else {
      warn("Could not append dynamic IDE desktop discovery");
    }
  }

  if (hasEditorFactory && !patchedSource.includes("linux:codexLinuxIdePlatform(")) {
    warn("Could not apply generic IDE factory patch");
  }
  if (hasJetBrainsFactory && !patchedSource.includes("linux:codexLinuxJetBrainsIdePlatform(")) {
    warn("Could not apply JetBrains IDE factory patch");
  }
  if (hasZedTarget && !patchedSource.includes("linux:{label:`Zed`")) {
    warn("Could not apply Zed IDE target patch");
  }

  return patchedSource;
}

function applyLinuxIconPathResolutionPatch(currentSource) {
  if (!currentSource.includes("iconPath?")) {
    return currentSource;
  }

  let patchedSource = currentSource;
  if (!/return\([A-Za-z_$][\w$]*===`win32`\|\|[A-Za-z_$][\w$]*===`linux`\)\?Promise\.all/u.test(patchedSource)) {
    const gateMatch = patchedSource.match(/return ([A-Za-z_$][\w$]*)===`win32`\?Promise\.all/u);
    if (gateMatch != null) {
      patchedSource = patchedSource.replace(
        gateMatch[0],
        `return(${gateMatch[1]}===\`win32\`||${gateMatch[1]}===\`linux\`)?Promise.all`,
      );
    } else {
      warn("Could not find open target icon platform gate");
    }
  }

  if (!patchedSource.includes("codexLinuxOpenTargetIconPath(e,t)")) {
    const fallbackNeedle = "r=e.iconPath?e.iconPath(t):t";
    if (patchedSource.includes(fallbackNeedle)) {
      patchedSource = patchedSource.replace(
        fallbackNeedle,
        "r=codexLinuxOpenTargetIconPath(e,t)",
      );
    } else {
      warn("Could not find open target icon command fallback");
    }
  }

  if (!patchedSource.includes("codexLinuxOpenTargetIconImage(")) {
    const resolverMatch = patchedSource.match(
      /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.toLowerCase\(\)\.endsWith\(`\.lnk`\)\?await ([A-Za-z_$][\w$]*)\(\2\):await ([A-Za-z_$][\w$]*)\.app\.getFileIcon\(\2,\{size:`normal`\}\);return!\1\|\|\1\.isEmpty\(\)\?([A-Za-z_$][\w$]*):\1\.toDataURL\(\)/u,
    );
    if (resolverMatch != null) {
      const [resolverNeedle, imageVar, pathArg, lnkResolver, electronVar, fallbackVar] = resolverMatch;
      const emptyPathNeedle = `if(!${pathArg})return ${fallbackVar};`;
      if (patchedSource.includes(emptyPathNeedle)) {
        patchedSource = patchedSource.replace(
          emptyPathNeedle,
          `if(!${pathArg})return codexLinuxOpenTargetIconDataUrl(null,${fallbackVar});`,
        );
      } else if (!patchedSource.includes(`codexLinuxOpenTargetIconDataUrl(null,${fallbackVar})`)) {
        warn("Could not find open target icon empty-path fallback");
      }
      patchedSource = patchedSource.replace(
        resolverNeedle,
        `let ${imageVar}=await codexLinuxOpenTargetIconImage(${pathArg});${imageVar}=${imageVar}??(${pathArg}.toLowerCase().endsWith(\`.lnk\`)?await ${lnkResolver}(${pathArg}):await ${electronVar}.app.getFileIcon(${pathArg},{size:\`normal\`}));return!${imageVar}||${imageVar}.isEmpty()?${fallbackVar}:${imageVar}.toDataURL()`,
      );
      const resolverIndex = patchedSource.lastIndexOf("async function ", resolverMatch.index);
      if (resolverIndex >= 0) {
        patchedSource =
          patchedSource.slice(0, resolverIndex) +
          `function codexLinuxOpenTargetIconPath(e,t){if(process.platform===\`linux\`)return typeof e?.iconPath===\`function\`?e.iconPath(t):null;return e?.iconPath?e.iconPath(t):t}` +
          `var codexLinuxOpenTargetSvgIconCache=new Map;` +
          `function codexLinuxOpenTargetBundledIconPath(e){if(process.platform!==\`linux\`||typeof e!==\`string\`||!/\\.svg$/iu.test(e)||e.startsWith(\`data:\`)||e.startsWith(\`file:\`)||e.startsWith(\`/\`))return null;try{let t=require(\`node:path\`),n=require(\`node:fs\`),r=[t.join(process.resourcesPath,\`../content/webview\`,e),t.join(process.resourcesPath,\`app.asar/webview\`,e)];for(let e of r)if(n.existsSync(e))return e}catch{}return null}` +
          `async function codexLinuxOpenTargetRasterizeSvg(e,t){if(typeof ${electronVar}.BrowserWindow!==\`function\`)return null;let _codexWindow=new ${electronVar}.BrowserWindow({show:!1,width:64,height:64,transparent:!0,frame:!1,webPreferences:{offscreen:!0,nodeIntegration:!1,contextIsolation:!0,sandbox:!0}});try{let r=\`data:image/svg+xml;charset=utf-8,\${encodeURIComponent(e)}\`,i=\`data:text/html;charset=utf-8,\${encodeURIComponent(\`<!doctype html><html><body style="margin:0;background:transparent;width:64px;height:64px;overflow:hidden"><img src="\${r}" style="width:64px;height:64px;display:block"></body></html>\`)}\`;await _codexWindow.loadURL(i);let a=await _codexWindow.webContents.capturePage({x:0,y:0,width:64,height:64});return a.isEmpty()?null:a}catch{return null}finally{try{_codexWindow.destroy()}catch{}}}` +
          `async function codexLinuxOpenTargetIconDataUrl(e,t){let r=e??codexLinuxOpenTargetBundledIconPath(t),n=await codexLinuxOpenTargetIconImage(r);return n&&!n.isEmpty()?n.toDataURL():t}` +
          `async function codexLinuxOpenTargetIconImage(e){if(process.platform!==\`linux\`||typeof e!==\`string\`)return null;if(codexLinuxOpenTargetSvgIconCache.has(e))return codexLinuxOpenTargetSvgIconCache.get(e);let _codexExt=e.match(/\\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase(),_codexMime={png:\`image/png\`,svg:\`image/svg+xml\`,jpg:\`image/jpeg\`,jpeg:\`image/jpeg\`,bmp:\`image/bmp\`,ico:\`image/x-icon\`,xpm:\`image/x-xpixmap\`}[_codexExt];if(!_codexMime)return null;if(_codexExt===\`svg\`){let _codexPromise=(async()=>{try{let t=${electronVar}.nativeImage.createFromPath(e);if(!t.isEmpty())return t}catch{}try{let t=require(\`node:fs\`).readFileSync(e,\`utf8\`);return await codexLinuxOpenTargetRasterizeSvg(t,e)}catch{return null}})();codexLinuxOpenTargetSvgIconCache.set(e,_codexPromise);return _codexPromise}try{let _codexData=require(\`node:fs\`).readFileSync(e);return{isEmpty:()=>_codexData.length===0,toDataURL:()=>\`data:\${_codexMime};base64,\${_codexData.toString(\`base64\`)}\`}}catch{}try{let _codexImage=${electronVar}.nativeImage.createFromPath(e);return _codexImage.isEmpty()?null:_codexImage}catch{return null}}` +
          patchedSource.slice(resolverIndex);
      } else {
        warn("Could not find open target icon resolver declaration");
      }
    } else {
      warn("Could not find open target icon resolver");
    }
  }

  return applyLinuxIconSummaryResolutionPatch(patchedSource);
}

function applyLinuxIconSummaryResolutionPatch(currentSource) {
  if (!currentSource.includes("codexLinuxOpenTargetIconImage(")) {
    return currentSource;
  }
  if (currentSource.includes("codexLinuxOpenTargetSummaryIcon(")) {
    return currentSource;
  }

  const summaryMatch = currentSource.match(
    /function ([A-Za-z_$][\w$]*)\(e\)\{return e\.map\(\(\{id:e,label:t,icon:n,kind:r,hidden:i,supportsSsh:a\}\)=>\(\{id:e,label:t,icon:n,kind:r,hidden:i,supportsSsh:a\}\)\)\}/u,
  );
  if (summaryMatch == null) {
    warn("Could not find open target icon summary mapper");
    return currentSource;
  }

  const [needle, summaryFn] = summaryMatch;
  const replacement =
    `function codexLinuxOpenTargetSummaryIconDataUrl(e,t){let n=e??codexLinuxOpenTargetBundledIconPath(t);if(process.platform!==\`linux\`||typeof n!==\`string\`)return t;let r=n.match(/\\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase(),i={png:\`image/png\`,svg:\`image/svg+xml\`,jpg:\`image/jpeg\`,jpeg:\`image/jpeg\`,bmp:\`image/bmp\`,ico:\`image/x-icon\`,xpm:\`image/x-xpixmap\`}[r];if(!i)return t;try{if(r===\`svg\`){let e=require(\`node:fs\`).readFileSync(n,\`utf8\`);return \`data:image/svg+xml;charset=utf-8,\${encodeURIComponent(e)}\`}let e=require(\`node:fs\`).readFileSync(n);return \`data:\${i};base64,\${e.toString(\`base64\`)}\`}catch{return t}}` +
    `function codexLinuxOpenTargetSummaryIcon(e){if(process.platform!==\`linux\`)return e.icon;try{return codexLinuxOpenTargetSummaryIconDataUrl(codexLinuxOpenTargetIconPath(e,null),e.icon)}catch{return e.icon}}` +
    `function ${summaryFn}(e){return e.map(e=>({id:e.id,label:e.label,icon:codexLinuxOpenTargetSummaryIcon(e),kind:e.kind,hidden:e.hidden,supportsSsh:e.supportsSsh}))}`;

  return currentSource.replace(needle, replacement);
}

function applyOpenInTargetRegistryCommandPatch(currentSource, { warnOnMissing = true } = {}) {
  if (currentSource.includes("async function codexLinuxOpenTargetRegistryCommand(")) {
    return currentSource;
  }

  const bindings = findOpenTargetRegistryBindings(currentSource);
  if (bindings == null) {
    if (
      warnOnMissing &&
      (
        currentSource.includes("get-target-command") ||
        currentSource.includes("getOpenInTargetCommand") ||
        currentSource.includes("allAvailableTargets")
      )
    ) {
      warn("Could not find open target registry");
    }
    return currentSource;
  }

  const helper =
    `async function codexLinuxOpenTargetRegistryCommand(e,t){if(process.platform!==\`linux\`)return;try{let n=${bindings.registryExpression}.find(e=>e.id===t);return typeof n?.detect===\`function\`?await n.detect(${bindings.detectContext}):null}catch{return null}}`;
  const registryDeclaration = `function ${bindings.registryName}(`;
  const insertionIndex = currentSource.indexOf(registryDeclaration);
  if (insertionIndex === -1) {
    if (warnOnMissing) {
      warn("Could not find open target registry declaration");
    }
    return currentSource;
  }

  return currentSource.slice(0, insertionIndex) + helper + currentSource.slice(insertionIndex);
}

function applyOpenInTargetCommandPatch(currentSource) {
  currentSource = applyOpenInTargetRegistryCommandPatch(currentSource, { warnOnMissing: false });
  if (currentSource.includes("codexLinuxOpenTargetRegistryCommand(this.getSettingsStore(),e)")) {
    return currentSource;
  }
  if (!currentSource.includes("async function codexLinuxOpenTargetRegistryCommand(")) {
    return currentSource;
  }

  const currentShapeMatch = currentSource.match(
    /async getOpenInTargetCommand\(e\)\{let\{command:t\}=await this\.getOpenInWorker\(\)\(\{method:`get-target-command`,params:([A-Za-z_$][\w$]*)\(this\.getSettingsStore\(\),e\)\}\);if\(t==null\)throw Error\(`Open target "\$\{e\}" is not available`\);return t\}/u,
  );
  if (currentShapeMatch != null) {
    const [needle, paramsFn] = currentShapeMatch;
    return currentSource.replace(
      needle,
      `async getOpenInTargetCommand(e){if(process.platform===\`linux\`){let t=await codexLinuxOpenTargetRegistryCommand(this.getSettingsStore(),e);if(t==null)throw Error(\`Open target "\${e}" is not available\`);return t}let{command:n}=await this.getOpenInWorker()({method:\`get-target-command\`,params:${paramsFn}(this.getSettingsStore(),e)});if(n==null)throw Error(\`Open target "\${e}" is not available\`);return n}`,
    );
  }

  if (currentSource.includes("getOpenInTargetCommand")) {
    warn("Could not find getOpenInTargetCommand worker fallback");
  }
  return currentSource;
}

function applyOpenInTargetsAvailabilityPatch(currentSource) {
  currentSource = applyOpenInTargetRegistryCommandPatch(currentSource, { warnOnMissing: false });
  if (currentSource.includes("process.platform===`linux`?codexLinuxOpenTargetRegistryCommand(")) {
    return currentSource;
  }
  if (!currentSource.includes("async function codexLinuxOpenTargetRegistryCommand(")) {
    return currentSource;
  }

  const block = findAsyncFunctionBlockContaining(currentSource, "allAvailableTargets");
  const signature = block?.header.match(
    /^async function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)$/u,
  );
  const mapping = block?.text.match(
    /[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)\)\.map\(async ([A-Za-z_$][\w$]*)=>\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\1,\2\.id\),/u,
  );
  if (block == null || signature == null || mapping == null || signature[1] !== mapping[1]) {
    if (currentSource.includes("async function") && currentSource.includes("get-target-command") && currentSource.includes("allAvailableTargets")) {
      warn("Could not find open-in-targets availability detector");
    }
    return currentSource;
  }

  const [storeVar, workerVar] = signature.slice(1);
  const [, , targetVar, paramsVar] = mapping;
  const workerCall = `${workerVar}({method:\`get-target-command\`,params:${paramsVar}})`;
  if (!block.text.includes(workerCall)) {
    warn("Could not find open-in-targets availability worker call");
    return currentSource;
  }

  const patchedBlock = block.text.replace(
    workerCall,
    `process.platform===\`linux\`?codexLinuxOpenTargetRegistryCommand(${storeVar},${targetVar}.id):${workerCall}`,
  );
  return currentSource.slice(0, block.start) + patchedBlock + currentSource.slice(block.end);
}

function applyOpenInTargetsBridgeDetectionPatch(currentSource) {
  currentSource = applyOpenInTargetRegistryCommandPatch(currentSource, { warnOnMissing: false });
  if (currentSource.includes("codexLinuxOpenTargetRegistryCommand(this.settingsStore,e)")) {
    return currentSource;
  }
  if (!currentSource.includes("async function codexLinuxOpenTargetRegistryCommand(")) {
    return currentSource;
  }

  const currentClassMatch = currentSource.match(
    /async detectTarget\(\{target:([A-Za-z_$][\w$]*)\}\)\{let\{command:([A-Za-z_$][\w$]*)\}=await this\.#[A-Za-z_$][\w$]*\(\)\(\{method:`get-target-command`,params:([A-Za-z_$][\w$]*)\(this\.settingsStore,\1\)\}\);return\{available:\2!=null\}\}/u,
  );
  if (currentClassMatch != null) {
    const [needle, targetVar, commandVar, paramsFn] = currentClassMatch;
    const replacement =
      `async detectTarget({target:${targetVar}}){if(process.platform===\`linux\`){let ${commandVar}=await codexLinuxOpenTargetRegistryCommand(this.settingsStore,${targetVar});return{available:${commandVar}!=null}}let{command:_codexWorkerCommand}=await this.#n()({method:\`get-target-command\`,params:${paramsFn}(this.settingsStore,${targetVar})});return{available:_codexWorkerCommand!=null}}`;
    return currentSource.replace(needle, replacement);
  }

  if (currentSource.includes("async detectTarget({target:") && currentSource.includes("get-target-command")) {
    warn("Could not find open-in bridge target detection");
  }
  return currentSource;
}

function applyOpenInTargetsDirectoryModePatch(currentSource) {
  const helper = "function codexLinuxOpenTargetIsDirectory(";
  if (currentSource.includes(helper)) {
    return currentSource;
  }
  const propertyIndex = currentSource.indexOf('"open-in-targets":async');
  if (propertyIndex === -1) {
    return currentSource;
  }

  const arrowIndex = currentSource.indexOf("=>{", propertyIndex);
  const block = findBalancedBlock(currentSource, arrowIndex === -1 ? -1 : arrowIndex + 2);
  if (block == null) {
    warn("Could not find open-in-targets path mode expression");
    return currentSource;
  }

  const modeExpressions = [
    ...block.text.matchAll(
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)!=null&&([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\3\),/gu,
    ),
  ];
  const modeExpression = modeExpressions.find((match) =>
    block.text.includes(`mode:${match[1]}||`),
  );
  if (modeExpression == null) {
    warn("Could not find open-in-targets path mode expression");
    return currentSource;
  }

  const [needle, modeVar, remoteVar, pathVar, pathModule, pathMethod] = modeExpression;
  const directoryVar = "_codexLinuxDirectory";
  if (block.text.includes(directoryVar)) {
    warn("Could not reserve open-in-targets directory variable");
    return currentSource;
  }
  const replacement =
    `${directoryVar}=${pathVar}!=null&&codexLinuxOpenTargetIsDirectory(${pathVar}),` +
    `${modeVar}=${remoteVar}||${directoryVar}||${pathVar}!=null&&${pathModule}.${pathMethod}(${pathVar}),`;

  const helperSource =
    `function codexLinuxOpenTargetIsDirectory(e){if(process.platform!==\`linux\`||typeof e!==\`string\`)return!1;try{return(0,codexLinuxNodeFs().existsSync)(e)&&(0,codexLinuxNodeFs().statSync)(e).isDirectory()}catch{return!1}}`;
  const patchedSource = helperSource + currentSource;
  return patchedSource.replace(needle, replacement);
}

function applyNativeOpenTargetSelectionPatch(currentSource) {
  if (currentSource.includes("function codexLinuxDirectoryOpenTarget(")) {
    return currentSource;
  }

  const match = currentSource.match(
    /function ([A-Za-z_$][\w$]*)\(\{targets:e,availableTargets:t,includeHiddenTargets:n=!1,mode:r=`editor`\}\)\{let i=e\.filter\(e=>e\.appPath!=null\);if\(i\.length>0\)return i;if\(r===`native`\)return e\.filter\(e=>e\.target===`systemDefault`\|\|e\.target===`fileManager`\);let a=new Set\(t\);return e\.filter\(e=>a\.has\(e\.target\)&&\(n\|\|!e\.hidden\)\)\}/u,
  );
  if (match == null) {
    if (
      currentSource.includes("includeHiddenTargets") &&
      currentSource.includes("availableTargets") &&
      currentSource.includes("systemDefault") &&
      currentSource.includes("fileManager") &&
      currentSource.includes("mode:r=`editor`")
    ) {
      warn("Could not find native open-target selection logic");
    }
    return currentSource;
  }
  const [original, fnName] = match;
  const patched =
    `function codexLinuxDirectoryOpenTarget(e){return e?.available===!0&&(e.kind===\`editor\`||e.kind===\`terminal\`)}function ${fnName}({targets:e,availableTargets:t,includeHiddenTargets:n=!1,mode:r=\`editor\`}){if(r===\`native\`)return e.filter(e=>e.target===\`systemDefault\`||e.target===\`fileManager\`||codexLinuxDirectoryOpenTarget(e));let i=e.filter(e=>e.appPath!=null);if(i.length>0)return i;let a=new Set(t);return e.filter(e=>a.has(e.target)&&(n||!e.hidden))}`;
  return currentSource.replace(original, patched);
}

function applyMainBundlePatch(currentSource) {
  const electronVar = requireName(currentSource, "electron");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (fsVar == null || pathVar == null) {
    warn("Could not find node:fs/node:path dependencies");
    return currentSource;
  }

  const deps = {
    electronVar,
    fsVar: "codexLinuxNodeFs()",
    pathVar: "codexLinuxNodePath()",
  };
  let patchedSource = currentSource;
  if (electronVar != null) {
    patchedSource = applyFileManagerDiscoveryPatch(patchedSource, deps);
  }
  patchedSource = applyTerminalDiscoveryPatch(patchedSource, deps);
  patchedSource = applyIdeDiscoveryPatch(patchedSource, deps);
  patchedSource = applyLinuxIconPathResolutionPatch(patchedSource);
  patchedSource = applyOpenInTargetRegistryCommandPatch(patchedSource);
  patchedSource = applyOpenInTargetsAvailabilityPatch(patchedSource);
  patchedSource = applyOpenInTargetCommandPatch(patchedSource);
  patchedSource = applyOpenInTargetsBridgeDetectionPatch(patchedSource);
  patchedSource = applyOpenInTargetsDirectoryModePatch(patchedSource);
  return patchedSource;
}

module.exports = {
  applyNativeOpenTargetSelectionPatch,
  applyMainBundlePatch,
  applyOpenInTargetRegistryCommandPatch,
  applyOpenInTargetCommandPatch,
  applyOpenInTargetsAvailabilityPatch,
  applyOpenInTargetsBridgeDetectionPatch,
  applyOpenInTargetsDirectoryModePatch,
  descriptors: [
    {
      id: "main-bundle-open-target-discovery",
      phase: "main-bundle",
      order: 20500,
      ciPolicy: "optional",
      apply: applyMainBundlePatch,
    },
    {
      id: "webview-native-open-target-selection",
      phase: "webview-asset",
      order: 20520,
      ciPolicy: "optional",
      pattern: /^app-initial~artifact-tab-content\.electron~notebook-preview-panel~app-main~pull-request-rout~ns5rw1zk-[^.]+\.js$/,
      missingDescription: "open target selection webview bundle",
      skipDescription: "native open-target selection patch",
      apply: applyNativeOpenTargetSelectionPatch,
    },
  ],
};
