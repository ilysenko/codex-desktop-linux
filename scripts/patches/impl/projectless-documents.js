"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  readDirectoryNames,
} = require("../lib/assets.js");

const PROJECTLESS_DOCUMENTS_MARKER = "function codexLinuxProjectlessDocumentsDir(";

function xdgDocumentsHelperSource() {
  return [
    "function codexLinuxProjectlessDocumentsDir({homeDirectory:e,path:t}){try{",
    "if(process.platform!==`linux`)return t.join(e,`Documents`,`Codex`);",
    "let n=process.env.XDG_CONFIG_HOME?.trim(),r=n&&t.isAbsolute(n)?t.join(n,`user-dirs.dirs`):t.join(e,`.config`,`user-dirs.dirs`);",
    "if(!require(`node:fs`).existsSync(r))return t.join(e,`Documents`,`Codex`);",
    "let i=require(`node:fs`).readFileSync(r,`utf8`).match(/^XDG_DOCUMENTS_DIR=([\"'])(.*)\\1/m);",
    "if(i==null)return t.join(e,`Documents`,`Codex`);",
    "let a=i[2].replace(/\\\\(.)/g,`$1`),o=a===`$HOME`?e:a.startsWith(`$HOME/`)?t.join(e,a.slice(6)):a.startsWith(`~/`)?t.join(e,a.slice(2)):t.isAbsolute(a)?a:t.join(e,a);",
    "return t.join(o,`Codex`)",
    "}catch{return t.join(e,`Documents`,`Codex`)}}",
  ].join("");
}

function applyLinuxProjectlessXdgDocumentsDirPatch(source) {
  if (source.includes(PROJECTLESS_DOCUMENTS_MARKER)) {
    return source;
  }

  const resolverRegex =
    /function ([A-Za-z_$][\w$]*)\(\{homeDirectory:([A-Za-z_$][\w$]*),path:([A-Za-z_$][\w$]*)\}\)\{return \3\.join\(\2,`Documents`,`Codex`\)\}/u;
  const match = source.match(resolverRegex);
  if (match == null) {
    if (
      source.includes("`Documents`,`Codex`") &&
      source.includes("Projectless thread directory")
    ) {
      console.warn(
        "WARN: Could not find projectless documents directory resolver — skipping Linux projectless XDG documents patch",
      );
    }
    return source;
  }

  const [, fnName, homeDirectoryVar, pathVar] = match;
  const patchedResolver =
    `${xdgDocumentsHelperSource()}function ${fnName}({homeDirectory:${homeDirectoryVar},path:${pathVar}}){return codexLinuxProjectlessDocumentsDir({homeDirectory:${homeDirectoryVar},path:${pathVar}})}`;
  return source.replace(resolverRegex, () => patchedResolver);
}

function findProjectlessBundles(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  return readDirectoryNames(buildDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(buildDir, name))
    .filter((candidate) => {
      try {
        const source = fs.readFileSync(candidate, "utf8");
        return source.includes(PROJECTLESS_DOCUMENTS_MARKER) ||
          (
            source.includes("`Documents`,`Codex`") &&
            source.includes("Projectless thread directory")
          );
      } catch {
        return false;
      }
    });
}

function patchProjectlessDocumentsAssets(extractedDir) {
  const candidates = findProjectlessBundles(extractedDir);
  if (candidates.length === 0) {
    const reason = `Could not find projectless documents bundle in ${path.join(extractedDir, ".vite", "build")}`;
    console.warn(`WARN: ${reason} — skipping Linux projectless XDG documents patch`);
    return { matched: 0, changed: 0, reason };
  }

  let changed = 0;
  for (const candidate of candidates) {
    const source = fs.readFileSync(candidate, "utf8");
    const patched = applyLinuxProjectlessXdgDocumentsDirPatch(source);
    if (patched !== source) {
      fs.writeFileSync(candidate, patched, "utf8");
      changed += 1;
    }
  }

  return { matched: candidates.length, changed };
}

module.exports = {
  applyLinuxProjectlessXdgDocumentsDirPatch,
  patchProjectlessDocumentsAssets,
};
