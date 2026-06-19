"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Codex 26.616.x+ reads an internal "Owl" feature-flag set through a native
// binding that only exists in OpenAI's private Electron build:
//   function Q(){let e=process._linkedBinding;...;return G.parse(e.call(process,`electron_common_owl_features`))}
// On stock upstream Electron (what this wrapper rebuilds against) that binding
// is absent, so the call throws "No such binding was linked:
// electron_common_owl_features" the moment the main bundle imports — the app
// dies at bootstrap-import-main with a "Codex failed to start" dialog.
//
// The accessor is the sole consumer of the binding; its only used member is
// isOwlFeatureEnabled(name). Rewrite the function body to return a stub that
// reports every Owl feature as disabled, dropping the binding call entirely.
// Owl-gated features default off; everything else is untouched. The file-based
// owl-feature-bootstrap-cache path is independent and keeps working.
//
// Minified identifiers (the function name and the schema-parser name) change
// every build, so anchor on the stable string literals and structural shape,
// and preserve the captured function name so existing callers still resolve.
const OWL_BINDING_REGEX =
  /function (\w+)\(\)\{let \w+=process\._linkedBinding;if\(typeof \w+!=`function`\)throw [\w.]*Error\(`Owl feature binding is unavailable`\);return \w+\.parse\(\w+\.call\(process,`electron_common_owl_features`\)\)\}/;

const OWL_BINDING_LITERAL = "electron_common_owl_features";

function stubOwlAccessor(source) {
  return source.replace(
    OWL_BINDING_REGEX,
    (_match, fnName) => `function ${fnName}(){return{isOwlFeatureEnabled:()=>!1}}`,
  );
}

function patchLinuxOwlFeatureBinding(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    return { changed: false, reason: ".vite/build not found" };
  }

  let changedFiles = 0;
  let sawLiteral = false;
  for (const name of fs.readdirSync(buildDir).sort()) {
    if (!name.endsWith(".js")) {
      continue;
    }
    const target = path.join(buildDir, name);
    const source = fs.readFileSync(target, "utf8");
    if (!source.includes(OWL_BINDING_LITERAL)) {
      continue;
    }
    sawLiteral = true;
    const patched = stubOwlAccessor(source);
    if (patched !== source) {
      fs.writeFileSync(target, patched, "utf8");
      changedFiles += 1;
    }
  }

  if (changedFiles === 0) {
    if (sawLiteral) {
      console.warn(
        "WARN: Owl feature binding accessor shape changed — owl stub NOT applied; " +
          "app will crash with 'No such binding was linked: electron_common_owl_features'",
      );
    }
    // No literal anywhere: upstream dropped the Owl binding — nothing to do.
    return { changed: false };
  }

  return { changed: true };
}

module.exports = {
  id: "linux-owl-feature-binding-stub",
  phase: "extracted-app",
  order: 130,
  // Optional so a future shape drift warns instead of hard-failing the whole
  // build; the post-install verification step is the real safety net.
  ciPolicy: "optional",
  apply: patchLinuxOwlFeatureBinding,
};
