"use strict";

const { mainBundlePatch } = require("../../scripts/patches/descriptor.js");

const STAGING_PATCH_MARKER = "codex-linux-bundled-marketplace-staging-copy-permissions-v3";
const EXECUTOR_PATCH_MARKER = "codex-linux-executor-plugin-copy-permissions-v1";
const HELPER_MARKER = "codex-linux-bundled-plugin-copy-permissions-helper-v1";
const IDENT = "[A-Za-z_$][\\w$]*";

const HELPER_SOURCE = `/* ${HELPER_MARKER} */
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
  if (source.includes(STAGING_PATCH_MARKER)) return source;
  const contracts = stagingCopyContracts(source);
  if (contracts.length !== 1) {
    throw new Error(`bundled marketplace staging copy contract matched ${contracts.length} times`);
  }
  const { match } = contracts[0];
  const [, fsName, , destinationName] = match;
  const replacement = `/* ${STAGING_PATCH_MARKER} */try{${match[0]}}finally{await codexLinuxMakeBundledPluginStageNodesWritable(${fsName}.default,${destinationName})}`;
  return replaceCopyWithWritableRepair(source, match, replacement);
}

function applyExecutorPluginCopyPermissions(source) {
  if (source.includes(EXECUTOR_PATCH_MARKER)) return source;
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
  const executor = executorCopies[0];
  const writable = `codexLinuxMakeBundledPluginStageNodesWritable(${executor[1]}.default,${executor[3]})`;
  // Repair an old read-only cache before cp tries to unlink its files, and
  // repair newly copied Nix modes before upstream writes .mcp.json.
  const replacement = `/* ${EXECUTOR_PATCH_MARKER} */await (async()=>{await ${writable};try{${executor[0]}}finally{await ${writable}}})()`;
  return replaceCopyWithWritableRepair(source, executor, replacement);
}

function replaceCopyWithWritableRepair(source, match, replacement) {
  const patched = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
  return source.includes(HELPER_MARKER) ? patched : `${HELPER_SOURCE}${patched}`;
}

module.exports = {
  STAGING_PATCH_MARKER,
  EXECUTOR_PATCH_MARKER,
  HELPER_MARKER,
  applyBundledMarketplaceStagingCopyPermissions,
  applyExecutorPluginCopyPermissions,
  descriptors: [mainBundlePatch({
    id: "bundled-marketplace-staging-copy-permissions",
    ciPolicy: "optional",
    enforceWhenEnabled: false,
    order: 20_170,
    apply: applyBundledMarketplaceStagingCopyPermissions,
  }), mainBundlePatch({
    id: "executor-plugin-copy-permissions",
    ciPolicy: "optional",
    enforceWhenEnabled: false,
    order: 20_171,
    apply: applyExecutorPluginCopyPermissions,
  })],
};
