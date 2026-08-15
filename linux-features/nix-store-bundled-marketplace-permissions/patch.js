"use strict";

const { mainBundlePatch } = require("../../scripts/patches/descriptor.js");

const PATCH_MARKER = "codex-linux-bundled-marketplace-staging-copy-permissions-v1";
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
  const { match } = contracts[0];
  const [, fsName, , destinationName] = match;
  const replacement = `try{${match[0]}}finally{await codexLinuxMakeBundledPluginStageNodesWritable(${fsName}.default,${destinationName})}`;
  const patched = `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`;
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
