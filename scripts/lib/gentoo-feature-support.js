"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  loadEnabledLinuxFeatures, enabledLinuxFeatureInstallPlan,
  enabledLinuxFeaturePackagePlan, enabledLinuxFeaturePackageHooks,
} = require("./linux-features.js");
const { enabledFeatureFailuresFromReport } = require("./patch-report.js");
const { DEPENDENCY_PHASES, gentooFeatureDependencies } = require("./gentoo-dependencies.js");

function gentooFeaturePlan(options = {}) {
  const selected = { ...options, strictConfig: true };
  const features = loadEnabledLinuxFeatures(selected);
  const unsupported = features.filter(feature => feature.manifest.gentoo?.supported !== true);
  if (unsupported.length) {
    throw new Error(`Gentoo does not support these enabled Linux features: ${unsupported.map(f => f.id).join(", ")}`);
  }
  const dependencies = Object.fromEntries(DEPENDENCY_PHASES.map(phase => [phase, []]));
  for (const feature of features) {
    const declared = gentooFeatureDependencies(feature);
    for (const phase of DEPENDENCY_PHASES) dependencies[phase].push(...declared[phase]);
  }
  const packagePlan = enabledLinuxFeaturePackagePlan({ ...selected, packageFormat: "ebuild" });
  dependencies.RDEPEND.push(...packagePlan.dependencies);
  for (const phase of DEPENDENCY_PHASES) dependencies[phase] = [...new Set(dependencies[phase])].sort();
  // Validate hooks at preflight too, before installing dependencies or building.
  for (const hook of enabledLinuxFeaturePackageHooks({ ...selected, packageFormat: "ebuild" })) {
    safePath(hook.path, features.find(feature => feature.id === hook.id).dir);
    if (!fs.statSync(hook.path).isFile()) throw new Error(`Gentoo package hook must be a regular file: ${hook.path}`);
  }
  for (const resource of packagePlan.resources) {
    // src_install copies only these roots; fail closed instead of silently losing
    // a rule/configuration or allowing feature files into Portage's WORKDIR.
    if (!/^(?:usr|etc)\/.+/.test(resource.target)) {
      throw new Error(`Gentoo package resource must be below usr/ or etc/: ${resource.target}`);
    }
  }
  return { enabled: features.map(feature => feature.id), dependencies };
}

function safePath(target, root, recursive = true) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Gentoo feature snapshot path: ${target}`);
  }
  let current = root;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`Gentoo feature snapshot must not contain links or special files: ${current}`);
    }
  }
  if (recursive && fs.statSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) safePath(path.join(target, name), target);
  }
}

function artifactMode(mode, stat) {
  // Match linux-features.js chmodRecursive(): readable directories also need
  // traversal bits, while regular files retain the literal declared mode.
  return stat.isDirectory() ? mode | ((mode & 0o444) >> 2) : mode;
}

function walkArtifact(target, visit) {
  const stat = fs.lstatSync(target);
  visit(target, stat);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) walkArtifact(path.join(target, name), visit);
  }
}

function validateGentooFeatureSnapshot(appDir, options = {}, checkModes = true) {
  const root = path.resolve(appDir), plan = gentooFeaturePlan({ ...options, appDir: root });
  const read = name => {
    const file = path.join(root, ".codex-linux", name);
    safePath(file, root, false);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  const staged = read("linux-features-staged.json"), report = read("patch-report.json");
  if (!Array.isArray(report.enabledFeatures) || JSON.stringify(report.enabledFeatures) !== JSON.stringify(plan.enabled)) {
    throw new Error("Gentoo patch report does not match the current feature config; rebuild the app");
  }
  if (staged.version !== 1 || !Array.isArray(staged.resources) || !Array.isArray(staged.runtimeHooks) || !Array.isArray(report.patches)) {
    throw new Error("Invalid Gentoo staged feature snapshot; rebuild the app");
  }
  const installPlan = enabledLinuxFeatureInstallPlan({ ...options, strictConfig: true });
  for (const kind of ["resources", "runtimeHooks"]) {
    const expected = installPlan[kind].map(entry => ({
      id: entry.id, target: entry.target, mode: entry.mode == null ? null : entry.mode.toString(8).padStart(4, "0"),
    }));
    const actual = staged[kind].map(entry => ({ id: entry?.id, target: entry?.target, mode: entry?.mode }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Gentoo staged feature snapshot does not match enabled resources/hooks; rebuild the app");
    }
    for (const entry of actual) {
      const target = path.resolve(root, entry.target);
      safePath(target, root);
      if (checkModes && entry.mode != null) {
        const mode = parseInt(entry.mode, 8);
        walkArtifact(target, (file, stat) => {
          if ((stat.mode & 0o7777) !== artifactMode(mode, stat)) {
            throw new Error(`Gentoo staged feature mode mismatch: ${path.relative(root, file)}`);
          }
        });
      }
    }
  }
  if (report.patches.some(patch => patch == null || (patch.sourceKind === "feature" && !plan.enabled.includes(patch.featureId)))) {
    throw new Error("Gentoo patch report contains a disabled feature; rebuild the app");
  }
  if (enabledFeatureFailuresFromReport(report).length) {
    throw new Error("Gentoo patch report contains failed enabled features; rebuild the app");
  }
  return plan;
}

function restoreGentooFeaturePayloadPermissions(appDir, options = {}) {
  // Normalization intentionally changed modes, but all snapshot ownership,
  // path, config and patch-success checks still apply before chmod.
  validateGentooFeatureSnapshot(appDir, options, false);
  const root = path.resolve(appDir);
  const plan = enabledLinuxFeatureInstallPlan({ ...options, strictConfig: true });
  for (const entry of [...plan.resources, ...plan.runtimeHooks]) {
    if (entry.mode == null) continue;
    const target = path.resolve(root, entry.target);
    safePath(target, root);
    walkArtifact(target, (file, stat) => fs.chmodSync(file, artifactMode(entry.mode, stat)));
  }
}

function renderGentooEbuild(template, plan, architecture, payload) {
  const replacements = {
    __ARCH__: architecture, __PAYLOAD__: payload,
    __FEATURE_DEPEND_BLOCK__: plan.dependencies.DEPEND.length
      ? `DEPEND="\n${plan.dependencies.DEPEND.map(atom => `\t${atom}`).join("\n")}\n"` : "",
    ...Object.fromEntries(["BDEPEND", "RDEPEND", "IDEPEND"].map(phase => [
      `__FEATURE_${phase}__`, plan.dependencies[phase].map(atom => `\t${atom}`).join("\n"),
    ])),
  };
  for (const [token, value] of Object.entries(replacements)) {
    if (!template.includes(token)) throw new Error(`Missing Gentoo template token: ${token}`);
    template = template.split(token).join(value);
  }
  return template;
}

if (require.main === module) {
  try {
    const argument = process.argv[2];
    if (argument === "--restore-permissions") {
      restoreGentooFeaturePayloadPermissions(process.argv[3]);
      return;
    }
    const plan = argument === "--preflight" || argument === "--bootstrap-dependencies"
      ? gentooFeaturePlan() : validateGentooFeatureSnapshot(argument);
    process.stdout.write(argument === "--bootstrap-dependencies"
      ? plan.dependencies.bootstrap.map(atom => `${atom}\n`).join("") : `${JSON.stringify(plan)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { gentooFeaturePlan, validateGentooFeatureSnapshot, restoreGentooFeaturePayloadPermissions, renderGentooEbuild };
