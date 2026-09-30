"use strict";

const { mainBundlePatch } = require("../../scripts/patches/descriptor.js");

const PATCH_MARKER = "codex-linux-bundled-marketplace-staging-copy-permissions-v2";
const IDENT = "[A-Za-z_$][\\w$]*";

const HELPER_SOURCE = `/* ${PATCH_MARKER} */
async function codexLinuxMakeBundledPluginStageNodesWritable(fs,destination){
  let stat;
  try{stat=await fs.lstat(destination)}catch(error){if(error?.code==="ENOENT")return;throw error}
  if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))return;
  await fs.chmod(destination,stat.mode|0o200);
  if(!stat.isDirectory())return;
  for(const entry of await fs.readdir(destination)){
    await codexLinuxMakeBundledPluginStageNodesWritable(fs,\`\${destination}/\${entry}\`);
  }
}
`;

function functionContaining(source, index) {
  const prefix = source.slice(0, index);
  const starts = [...prefix.matchAll(new RegExp(`async function (${IDENT})\\(([^)]*)\\)\\{`, "g"))];
  const start = starts.at(-1);
  if (start == null) return null;
  let depth = 1;
  let cursor = start.index + start[0].length;
  for (; cursor < source.length && depth > 0; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    if (source[cursor] === "}") depth -= 1;
  }
  return depth === 0 ? {
    name: start[1],
    start: start.index,
    end: cursor,
    source: source.slice(start.index, cursor),
  } : null;
}

function stagingCopyContracts(source) {
  const cpPattern = new RegExp(
    `await (${IDENT})\\.default\\.cp\\((${IDENT}),(${IDENT}),\\{recursive:!0,verbatimSymlinks:!0\\}\\)`,
    "g",
  );
  const contracts = [];
  for (const match of source.matchAll(cpPattern)) {
    const fn = functionContaining(source, match.index);
    if (fn == null || !fn.source.includes("ditto") || !fn.source.includes("windows-file-copy")) continue;
    const callPattern = new RegExp(`await ${fn.name}\\(${IDENT},${IDENT}\\)`, "g");
    const calls = [...source.matchAll(callPattern)];
    if (calls.length !== 1 || !/staging-\$\{[^}]*randomUUID/.test(source)) continue;
    contracts.push({ match, fn });
  }
  return contracts;
}

function applyBundledMarketplaceStagingCopyPermissions(source) {
  if (source.includes(PATCH_MARKER)) return source;
  const contracts = stagingCopyContracts(source);
  if (contracts.length !== 1) {
    throw new Error(`bundled marketplace staging copy contract matched ${contracts.length} times`);
  }
  const executorCopies = [...source.matchAll(new RegExp(
    `await (${IDENT})\\.default\\.cp\\((${IDENT})\\.cwd,(${IDENT}),\\{recursive:!0\\}\\)`, "g",
  ))].filter(match => {
    const fn = functionContaining(source, match.index);
    return fn?.source.includes("executorPluginRoot:") &&
      fn.source.includes("CODEX_APP_TOOLS_CALLER_HOST_ID") &&
      fn.source.includes("`.mcp.json`");
  });
  if (executorCopies.length !== 1) {
    throw new Error(`executor plugin copy contract matched ${executorCopies.length} times`);
  }
  const { match } = contracts[0];
  const [, fsName, , destinationName] = match;
  const replacement = `try{${match[0]}}finally{await codexLinuxMakeBundledPluginStageNodesWritable(${fsName}.default,${destinationName})}`;
  const executor = executorCopies[0];
  const writable = `codexLinuxMakeBundledPluginStageNodesWritable(${executor[1]}.default,${executor[3]})`;
  // Repair an old read-only cache before cp tries to unlink its files, and
  // repair newly copied Nix modes before upstream writes .mcp.json.
  const executorReplacement = `await (async()=>{await ${writable};try{${executor[0]}}finally{await ${writable}}})()`;
  let patched = source;
  for (const edit of [
    { index: match.index, before: match[0], after: replacement },
    { index: executor.index, before: executor[0], after: executorReplacement },
  ].sort((a, b) => b.index - a.index)) {
    patched = patched.slice(0, edit.index) + edit.after + patched.slice(edit.index + edit.before.length);
  }
  return `${HELPER_SOURCE}${patched}`;
}

module.exports = {
  PATCH_MARKER,
  applyBundledMarketplaceStagingCopyPermissions,
  descriptors: [mainBundlePatch({
    id: "bundled-marketplace-staging-copy-permissions",
    ciPolicy: "optional",
    enforceWhenEnabled: false,
    order: 20_170,
    apply: applyBundledMarketplaceStagingCopyPermissions,
  })],
};
