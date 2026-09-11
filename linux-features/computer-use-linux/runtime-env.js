"use strict";

function applyNativeRuntimeEnvironmentPatch(source) {
  const cachePattern = /(?<path>[\w$]+\.default)\.join\((?<cache>[\w$]+),`\.mcp\.json`\)/g;
  const commandPattern = /(?<options>[\w$]+)\.nodeRepl!=null&&\((?<config>[\w$]+)\.command=\k<options>\.nodeRepl\.env\[[\w$]+\.[\w$]+\],\k<config>\.args=\[(?<path>[\w$]+\.default)\.join\(\k<options>\.nodeRepl\.env\[(?<root>[\w$]+\.[\w$]+)\],`@oai\/cua-repl\/bin\/cua-repl\.mjs`\)\]\)/g;
  const caches = [...source.matchAll(cachePattern)];
  const commands = [...source.matchAll(commandPattern)];
  if (caches.length !== 1 || commands.length !== 1 || caches[0].groups.path !== commands[0].groups.path) {
    throw new Error("Linux unified Computer Use contract drift: expected one app-managed CUA launcher");
  }
  const { options: o, config: c, path: p, root } = commands[0].groups;
  const { cache } = caches[0].groups;
  const envPattern = /(?<config>[\w$]+)\.env=\{\.\.\.(?<options>[\w$]+)\.nodeRepl\?\.env,CUA_REPL_NODE_REPL_PATH:\k<options>\.nodeRepl\?\.command,CUA_REPL_ENABLED_SURFACES:\k<options>\.surfaces\.join\(`,`\),\[(?<services>[\w$]+\.[\w$]+)\]:JSON\.stringify\((?<map>[\w$]+)\),/g;
  const envs = [...source.matchAll(envPattern)];
  if (envs.length !== 1 || envs[0].groups.config !== c || envs[0].groups.options !== o) {
    throw new Error("Linux unified Computer Use contract drift: changed CUA environment");
  }
  const { services, map } = envs[0].groups;
  const bootstrap = `${p}.join(${cache},\`scripts/native-launch.mjs\`)`;
  const factory = `${p}.join(${o}.nodeRepl.env[${root}],\`@oai/cua/dist/lib/js/oai_js_cua/src/tinysky_alt/create_tinysky_alt.js\`)`;
  const injection = `,/*linux-native-cua*/process.platform===\`linux\`&&${o}.nodeRepl!=null&&${o}.surfaces.includes(\`computer\`)&&Object.assign(${c}.env,{NODE_REPL_TRUSTED_RPC_ENABLED:\`1\`,[${services}]:JSON.stringify({...${map},sky:${p}.join(${cache},\`scripts/native-service.mjs\`)}),NODE_REPL_JS_BANNER:\`await (await import(\`+JSON.stringify((await import(\`node:url\`)).pathToFileURL(${bootstrap}).href)+\`)).setupLinuxComputerUse(\`+JSON.stringify({browser:${o}.surfaces.includes(\`browser\`),factoryPath:${factory}})+\`);\`})`;
  const anchor = commands[0][0];
  if (source.includes("/*linux-native-cua*/")) {
    if (source.split("/*linux-native-cua*/").length !== 2 || !source.includes(anchor + injection)) {
      throw new Error("Linux unified Computer Use contract drift: partial CUA environment patch");
    }
    return source;
  }
  return source.replace(anchor, anchor + injection);
}
module.exports = { applyNativeRuntimeEnvironmentPatch };
