"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { findMainProcessChunks, patchWebviewAssets: commitAssetEdits } = require("../../scripts/patches/lib/assets.js");
const { mainProcessFactories } = require("../../scripts/patches/lib/main-process-factories.js");
const { inspectMainRequestSites, hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const { findMatchingBrace, createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxRemoteControlDeviceKeyClient";
const ADDON = "codexLinuxRemoteControlDeviceKeyAddon";
const MAX_OWNER_BYTES = 256 * 1024;
const MAX_PROVIDER_BYTES = 16 * 1024;
const MAX_RUNTIME_BYTES = 64 * 1024;
const R = text => new RegExp(text, "gu");
const q = escapeRegExp;
function fail(reason) { throw new Error(`Unsupported current Remote device-key contract: ${reason}`); }
function one(rows, reason) { if (rows.length !== 1) fail(reason); return rows[0]; }
function parses(text) { try { new Script(text); return true; } catch { return false; } }
function frame(text, offset = 0) { return { text, offset, lexical: createJavaScriptLexicalIndex(text) }; }
function matches(owner, pattern, root = false) {
  return [...owner.text.matchAll(pattern)].filter(row => owner.lexical.isCode(row.index) && (!root || owner.lexical.isRoot(row.index)));
}
function rootStatement(factory, at) {
  const prefix = factory.body.slice(0, at);
  return findMatchingBrace("{" + prefix + "}", 0) === prefix.length + 1 &&
    parses(`function nativeDeviceRoot(${factory.parameters.join(",")}){${prefix}\nconst __nativeDeviceStatement=0;}`);
}
function classRange(factory, start, header) {
  const open = factory.body.indexOf("{", start), end = findMatchingBrace(factory.body, open);
  if (end < open || !rootStatement(factory, start)) fail("provider class is not a factory-root declaration");
  const text = factory.body.slice(start, end + 1);
  if (Buffer.byteLength(text) > MAX_PROVIDER_BYTES) fail("provider class exceeds its bounded inspection cap");
  return { start, end: end + 1, text };
}
function constructorOf(source, graph) {
  const host = source.slice(graph.scope.hostStart, graph.scope.hostEnd);
  if (Buffer.byteLength(host) > MAX_OWNER_BYTES) fail("live main owner exceeds the bounded owner cap");
  const owner = frame(host), found = one(matches(owner, /\bconstructor\((?<parameters>[^{};]*?)\)\{/gu), "missing or ambiguous live owner constructor");
  const open = found.index + found[0].length - 1, end = owner.lexical.matchingBrace(open);
  if (end < open) fail("incomplete live owner constructor");
  const body = host.slice(open + 1, end);
  if (Buffer.byteLength(body) > MAX_OWNER_BYTES) fail("live constructor exceeds the bounded inspection cap");
  return { host, start: graph.scope.hostStart + open + 1, end: graph.scope.hostStart + end,
    open, close: end, parameters: found.groups.parameters, body: frame(body) };
}
function noConstructorCapture(ctor, names) {
  const inserted = ctor.host.slice(0, ctor.close) + `\n;let ${names.join(",")};\n` + ctor.host.slice(ctor.close);
  if (!parses(ctor.host) || !parses(inserted)) fail("live constructor captures a provider/schema role");
  for (const name of names) if (!hasStableEagerMainBinding(ctor.body.text, name)) fail(`live constructor writes the ${name} role`);
}
function verifyModuleRoles(factory, roles) {
  const byName = new Map(), lexical = createJavaScriptLexicalIndex(factory.body);
  for (const role of roles) {
    if (factory.parameters.includes(role.name)) fail(`factory parameter captures ${role.name}`);
    if (byName.has(role.name)) fail("native role bindings alias each other");
    if (role.initializer != null && factory.body.slice(role.initializer, role.initializer + role.name.length) !== role.name) fail("initializer projection is not the qualified token");
    byName.set(role.name, { ...role, candidate: false });
  }
  // Conservative single-pass prefilter using the authority reader's own token
  // spelling policy. Only a possible write/escaped reference invokes its full
  // eager-scope analysis; ordinary member reads need no repeated factory scan.
  const tokens = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  const operator = /^(?:\+\+|--|(?:\?\?|\|\||&&|\*\*|<<|>>>|>>|[+*/%&|^\-])?=(?!=|>))/u;
  for (const token of factory.body.matchAll(tokens)) {
    const name = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, a, b) => String.fromCodePoint(parseInt(a || b, 16)));
    const role = byName.get(name); if (!role || role.initializer === token.index || !lexical.isCode(token.index)) continue;
    const tail = factory.body.slice(token.index + token[0].length).replace(/^(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n\u2028\u2029]*(?:\r?\n|[\u2028\u2029]|$)))*/u, "");
    let beforeAt = token.index - 1;
    while (beforeAt >= 0 && (!lexical.isCode(beforeAt) || /\s/u.test(factory.body[beforeAt]))) beforeAt--;
    const before = factory.body.slice(Math.max(0, beforeAt - 1), beforeAt + 1);
    if (token[0].includes("\\u") || operator.test(tail) || ["++", "--"].includes(before) || ",}])".includes(tail[0] || " ")) role.candidate = true;
  }
  for (const role of byName.values()) {
    if (!role.candidate) continue;
    let projected = factory.body;
    if (role.initializer != null) {
      let replacement = "__nativeDeviceAllowedInitializer";
      while (projected.includes(replacement)) replacement += "$";
      projected = projected.slice(0, role.initializer) + replacement + projected.slice(role.initializer + role.name.length);
    }
    if (!hasStableEagerMainBinding(projected, role.name)) fail(`factory eagerly writes the ${role.name} role`);
  }
}
function importedNamespace(factory, name) {
  const expression = R(`(?<![\\w$.])${q(name)}=${q(factory.parameters[2])}\\((?<module>\\d+)\\)`);
  // A root syntax prefix plus a root declaration probe establishes the actual
  // binding. The generic authority checks only remaining eager writes.
  const rows = [...factory.body.matchAll(expression)].filter(row => {
    const prefix = factory.body.slice(0, row.index);
    return findMatchingBrace("{" + prefix + "}", 0) === prefix.length + 1 &&
      parses(`function nativeDeviceImport(${factory.parameters.join(",")}){${prefix}${row[0]};}`);
  });
  const found = one(rows, `missing or ambiguous native import ${name}`);
  if (parses(`function nativeDeviceBinding(${factory.parameters.join(",")}){${factory.body}\n;let ${name};}`)) fail("native namespace has no root declaration");
  return { local: name, moduleId: found.groups.module, start: factory.start + found.index, initializer: found.index };
}
function nativeProvider(factory) {
  const bases = [...factory.body.matchAll(R(`\\bclass (?<base>${ID})\\{resourcesPath;addon=null;`))]
    .filter(row => rootStatement(factory, row.index));
  const baseHead = one(bases, "missing or ambiguous native signing base class"), base = classRange(factory, baseHead.index, baseHead[0]);
  const basePattern = new RegExp(`^class ${q(baseHead.groups.base)}\\{resourcesPath;addon=null;constructor\\((?<arg>${ID})\\)\\{this\\.resourcesPath=\\k<arg>\\}` +
    `createDeviceKey\\((?<create>${ID})\\)\\{return this\\.getAddon\\(\\)\\.createDeviceKey\\(\\k<create>\\?\\?"hardware_only"\\)\\}` +
    `deleteDeviceKey\\((?<remove>${ID})\\)\\{return this\\.getAddon\\(\\)\\.deleteDeviceKey\\(\\k<remove>\\)\\}` +
    `getDeviceKeyPublic\\((?<public>${ID})\\)\\{return this\\.getAddon\\(\\)\\.getDeviceKeyPublic\\(\\k<public>\\)\\}` +
    `signBytes\\((?<key>${ID}),(?<bytes>${ID})\\)\\{return this\\.getAddon\\(\\)\\.signDeviceKey\\(\\k<key>,\\k<bytes>\\)\\}` +
    `getAddon\\(\\)\\{if\\(null==this\\.resourcesPath\\)throw Error\\("Device keys require resourcesPath"\\);return null==this\\.addon&&\\(this\\.addon=(?<schema>${ID})\\.parse\\((?<load>${ID})\\(\\(0,(?<path>${ID})\\.join\\)\\(this\\.resourcesPath,"native","remote-control-device-key\\.node"\\)\\)\\)\\),this\\.addon\\}\\}$`, "u");
  const b = basePattern.exec(base.text)?.groups;
  if (!b) fail("signing base no longer routes through the native addon interface");
  const remoteHead = one([...factory.body.matchAll(R(`\\bclass (?<remote>${ID}) extends ${q(baseHead.groups.base)}\\{`))]
    .filter(row => rootStatement(factory, row.index)), "missing or ambiguous native Remote subclass");
  const remote = classRange(factory, remoteHead.index, remoteHead[0]);
  const r = new RegExp(`^class ${q(remoteHead.groups.remote)} extends ${q(baseHead.groups.base)}\\{async signDeviceKey\\((?<key>${ID}),(?<payload>${ID})\\)\\{var (?<carrier>${ID});let (?<bytes>${ID})=\\(\\k<carrier>=\\k<payload>,Buffer\\.from\\(JSON\\.stringify\\(\\{domain:"codex-device-key-sign-payload/v1",payload:function\\((?<item>${ID})\\)\\{switch\\(\\k<item>\\.type\\)\\{` +
    `case"remoteControlClientConnection":if\\((?<nonce>${ID})\\(\\k<item>\\.nonce\\),"remote_control_client_websocket"!==\\k<item>\\.audience\\)throw Error\\("Invalid remote-control device-key connection audience"\\);if\\(1!==\\k<item>\\.scopes\\.length\\|\\|"remote_control_controller_websocket"!==\\k<item>\\.scopes\\[0\\]\\)throw Error\\("Invalid remote-control device-key connection scopes"\\);return (?<digest>${ID})\\(\\k<item>\\.tokenSha256Base64url\\),\\{` +
    ["accountUserId","audience","clientId","nonce","scopes","sessionId","targetOrigin","targetPath","tokenExpiresAt","tokenSha256Base64url","type"].map(key => `${key}:\\k<item>\\.${key}`).join(",") + `\\};` +
    `case"remoteControlClientEnrollment":if\\(\\k<nonce>\\(\\k<item>\\.nonce\\),"remote_control_client_enrollment"!==\\k<item>\\.audience\\)throw Error\\("Invalid remote-control device-key enrollment audience"\\);return \\k<digest>\\(\\k<item>\\.deviceIdentitySha256Base64url\\),\\{` +
    ["accountUserId","audience","challengeExpiresAt","challengeId","clientId","deviceIdentitySha256Base64url","nonce","targetOrigin","targetPath","type"].map(key => `${key}:\\k<item>\\.${key}`).join(",") + `\\}\\}\\}\\(\\k<carrier>\\)\\}\\),"utf8"\\)\\);return\\{\\.\\.\\.await this\\.signBytes\\(\\k<key>,\\k<bytes>\\),signedPayloadBase64:\\k<bytes>\\.toString\\("base64"\\)\\}\\}\\}$`, "u").exec(remote.text)?.groups;
  if (!r) fail("Remote serialization, domain, audience, scopes or payload fields drifted");
  const nonce = one([...factory.body.matchAll(R(`function ${q(r.nonce)}\\((?<arg>${ID})\\)\\{if\\(!(?<pattern>${ID})\\.test\\(\\k<arg>\\)\\|\\|Buffer\\.from\\(\\k<arg>,"base64url"\\)\\.length<32\\)throw Error\\("Invalid remote-control device-key nonce"\\)\\}`))]
    .filter(row => rootStatement(factory, row.index)), "native nonce validator is missing or ambiguous");
  const digest = one([...factory.body.matchAll(R(`function ${q(r.digest)}\\((?<arg>${ID})\\)\\{if\\(!${q(nonce.groups.pattern)}\\.test\\(\\k<arg>\\)\\|\\|32!==Buffer\\.from\\(\\k<arg>,"base64url"\\)\\.length\\)throw Error\\("Invalid remote-control device-key SHA-256 digest"\\)\\}`))]
    .filter(row => rootStatement(factory, row.index)), "native SHA-256 validator is missing or ambiguous");
  const pattern = `let ${nonce.groups.pattern}=/^[A-Za-z0-9_-]+$/u;`;
  if (factory.body.slice(base.end, remote.start) !== pattern) fail("native nonce grammar no longer connects the two classes");
  const roles = [baseHead.groups.base, remoteHead.groups.remote, r.nonce, r.digest].map(name => ({ name, initializer: null }));
  roles.push({ name: nonce.groups.pattern, initializer: base.end + 4 });
  return { roles, base, remote, baseName: baseHead.groups.base, providerName: remoteHead.groups.remote, schemaName: b.schema, addonLoader: b.load, pathNamespace: b.path, nonce: r.nonce, digest: r.digest };
}
function nativeSchema(factory, provider) {
  const body = factory.body, schemaName = provider.schemaName;
  const nearby = Math.max(0, provider.base.start - MAX_PROVIDER_BYTES), prefix = body.slice(nearby, provider.base.start);
  const start = prefix.lastIndexOf("let ");
  if (start < 0) fail("native addon schema declaration is absent");
  const at = nearby + start, beforeBase = body.slice(at, provider.base.start);
  const loaderTail = one([...beforeBase.matchAll(R(`${q(provider.addonLoader)}=\\(0,${ID}\\.createRequire\\)\\(__filename\\);`))], "native addon loader initialization is missing or ambiguous");
  const source = beforeBase.slice(0, loaderTail.index + loaderTail[0].length);
  if (!rootStatement(factory, at) || Buffer.byteLength(source) > MAX_PROVIDER_BYTES) fail("addon schema is not a bounded root declaration");
  const ns = one([...source.matchAll(R(`(?<ns>${ID})\\.object\\(\\{keyId:`))], "native public-key schema is absent").groups.ns;
  const n=q(ns), field=`${n}\\.string\\(\\)\\.min\\(1\\)`, algorithm=`${n}\\.literal\\("ecdsa_p256_sha256"\\)`;
  const p = new RegExp(`^let (?<public>${ID})=${n}\\.object\\(\\{keyId:${field},publicKeySpkiDerBase64:${field},algorithm:${algorithm},protectionClass:${n}\\.enum\\(\\["hardware_secure_enclave","hardware_tpm","os_protected_nonextractable"\\]\\)\\}\\),(?<signature>${ID})=${n}\\.object\\(\\{signatureDerBase64:${field},algorithm:${algorithm}\\}\\),${q(schemaName)}=${n}\\.object\\(\\{` +
    `createDeviceKey:${n}\\.function\\(\\{input:\\[${n}\\.enum\\(\\["hardware_only","allow_os_protected_nonextractable"\\]\\)\\],output:${n}\\.promise\\(\\k<public>\\)\\}\\),` +
    `deleteDeviceKey:${n}\\.function\\(\\{input:\\[${field}\\],output:${n}\\.promise\\(${n}\\.void\\(\\)\\)\\}\\),` +
    `getDeviceKeyPublic:${n}\\.function\\(\\{input:\\[${field}\\],output:${n}\\.promise\\(\\k<public>\\)\\}\\),` +
    `signDeviceKey:${n}\\.function\\(\\{input:\\[${field},${n}\\.instanceof\\(Buffer\\)\\],output:${n}\\.promise\\(\\k<signature>\\)\\}\\)\\}\\),${q(provider.addonLoader)}=\\(0,(?<module>${ID})\\.createRequire\\)\\(__filename\\);$`, "u").exec(source)?.groups;
  if (!p) fail("native addon interface/schema or createRequire relation drifted");
  const initializer = at + source.indexOf(`${schemaName}=`), loaderInitializer = at + source.indexOf(`${provider.addonLoader}=`);
  const imports = [importedNamespace(factory, ns), importedNamespace(factory, p.module), importedNamespace(factory, provider.pathNamespace)];
  return { start: at, end: at + source.length, source, schemaName, namespace: ns, imports, roles: [{ name: schemaName, initializer }, { name: provider.addonLoader, initializer: loaderInitializer }, ...imports.map(row => ({ name: row.local, initializer: row.initializer }))] };
}
function inspectNative(source) {
  const graph = inspectMainRequestSites(source);
  if (!graph.ok) fail("no unique live main startup/owner graph");
  const factory = one(mainProcessFactories(source).filter(row => row.identity === graph.scope.factoryId), "live main factory is ambiguous");
  if (factory.start !== graph.scope.factoryStart || factory.end !== graph.scope.factoryEnd) fail("main owner graph has stale ranges");
  const reserved = ["require","process","Buffer","JSON","Object","Error","Date","Promise","Set","Array","Number","String","console","setTimeout","clearTimeout"];
  if (factory.parameters.some(name => reserved.includes(name)) || !parses(`function nativeDeviceGlobals(${factory.parameters.join(",")}){${factory.body}\n;let ${reserved.join(",")};}`)) fail("injected runtime would capture a native global");
  const provider = nativeProvider(factory), schema = nativeSchema(factory, provider), ctor = constructorOf(source, graph);
  const pattern = R(`this\\.remoteControlDeviceKeyClient=new ${q(provider.providerName)}\\((?<args>[\\s\\S]{1,1000}?)\\),this\\.executionHostRegistry`);
  const construction = one(matches(ctor.body, pattern, true), "missing or ambiguous device-key construction in the live owner");
  for (const exit of matches(ctor.body, /\b(?:return|throw)\b/gu, true)) {
    if (exit.index >= construction.index) break;
    const beforeExit = ctor.body.text.slice(0, exit.index).replace(/,$/u, ";");
    const completed = ctor.host.slice(0, ctor.open + 1) + beforeExit + "\nconst __nativeDeviceExitProbe=0;" + ctor.host.slice(ctor.close);
    if (parses(completed)) fail("device-key construction follows a root constructor exit");
  }
  const prefix = ctor.body.text.slice(0, construction.index).replace(/,$/u, ";");
  if (!parses(`function nativeDeviceConstructor(${ctor.parameters}){${prefix}\nconst __nativeDeviceConstruction=0;}`)) fail("device-key construction is not a native constructor assignment");
  noConstructorCapture(ctor, [provider.providerName, provider.schemaName]);
  verifyModuleRoles(factory, [...provider.roles, ...schema.roles]);
  const host = frame(ctor.host);
  if (matches(host, /this\.remoteControlDeviceKeyClient\s*=/gu).length !== 1) fail("live owner rewrites the device-key field");
  return { graph, factory, provider, schema, ctor, construction: { start: ctor.start + construction.index, end: ctor.start + construction.index + construction[0].length, source: construction[0], args: construction.groups.args } };
}
function emit(nativeSource, native, runtimeSource) {
  const {provider, construction}=native, insert=native.factory.start+provider.base.start;
  const replacement=`this.remoteControlDeviceKeyClient=process.platform===\`linux\`?${MARKER}(${provider.providerName},${provider.schemaName}):new ${provider.providerName}(${construction.args}),this.executionHostRegistry`;
  if (construction.start <= insert) fail("construction precedes the native provider");
  return nativeSource.slice(0,insert)+runtimeSource+nativeSource.slice(insert,construction.start)+replacement+nativeSource.slice(construction.end);
}
function decode(source,runtimeSource){
  const marker=source.includes(MARKER)||source.includes(ADDON);
  if(!marker)return {state:"current",nativeSource:source};
  const first=source.indexOf(runtimeSource);
  if(first<0||source.indexOf(runtimeSource,first+1)>=0)fail("partial or duplicated own runtime");
  const without=source.slice(0,first)+source.slice(first+runtimeSource.length);
  const conditional=R(`this\\.remoteControlDeviceKeyClient=process\\.platform===\`linux\`\\?${MARKER}\\((?<provider>${ID}),(?<schema>${ID})\\):new \\k<provider>\\((?<args>[\\s\\S]{1,1000}?)\\),this\\.executionHostRegistry`);
  const found=one([...without.matchAll(conditional)],"partial or ambiguous own Linux construction");
  const replacement=`this.remoteControlDeviceKeyClient=new ${found.groups.provider}(${found.groups.args}),this.executionHostRegistry`;
  const nativeSource=without.slice(0,found.index)+replacement+without.slice(found.index+found[0].length);
  if(nativeSource.includes(MARKER)||nativeSource.includes(ADDON))fail("orphan own marker outside canonical runtime");
  return {state:"patched",nativeSource};
}
function prepareDeviceKeySource(source,runtimeSource){
  if(typeof source!=="string"||typeof runtimeSource!=="string"||!runtimeSource||Buffer.byteLength(runtimeSource)>MAX_RUNTIME_BYTES)fail("invalid source/runtime input");
  if(!parses(source))fail("main source does not parse");
  const decoded=decode(source,runtimeSource),native=inspectNative(decoded.nativeSource),patchedSource=emit(decoded.nativeSource,native,runtimeSource);
  if(!parses(patchedSource))fail("prepared device-key output does not parse");
  if(decoded.state==="patched"&&patchedSource!==source)fail("own output is not canonical replay of its native inverse");
  const proof=Object.freeze({factoryId:native.factory.identity,hostStart:native.graph.scope.hostStart,hostEnd:native.graph.scope.hostEnd,provider:native.provider.providerName,base:native.provider.baseName,schema:native.provider.schemaName,constructorStart:native.ctor.start,constructorEnd:native.ctor.end});
  return Object.freeze({state:decoded.state,nativeSource:decoded.nativeSource,patchedSource,proof});
}
function applyDeviceKeyToExtractedApp(extractedDir,runtimeSource,options={}){
  const inventory=findMainProcessChunks(extractedDir);if(!inventory)fail("missing main-process inventory");
  const rows=inventory.chunks.map(assetName=>({assetName,source:fs.readFileSync(path.join(inventory.buildDir,assetName),"utf8")}));
  const candidates=rows.filter(row=>row.source.includes("remote-control-device-key.node")||row.source.includes("codex-device-key-sign-payload/v1")||row.source.includes(MARKER)||row.source.includes(ADDON));
  const candidate=one(candidates,"missing or ambiguous device-key carrier"),prepared=prepareDeviceKeySource(candidate.source,runtimeSource);
  // Inspect every physical registry for the selected identity, even a copy
  // whose semantic discovery text has been damaged or removed.
  const cohort=rows.filter(row=>mainProcessFactories(row.source).some(factory=>factory.identity===prepared.proof.factoryId));
  if(cohort.length!==1||cohort[0]!==candidate)fail("duplicate or damaged live factory cohort");
  if(prepared.state==="patched")return {matched:1,changed:0,changedAssets:[]};
  return {matched:1,...commitAssetEdits(inventory.buildDir,[{assetName:candidate.assetName,source:candidate.source,patchedSource:prepared.patchedSource}],options)};
}
module.exports={prepareDeviceKeySource,applyDeviceKeyToExtractedApp};
