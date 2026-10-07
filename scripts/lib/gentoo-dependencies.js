"use strict";

// A deliberately bounded subset of EAPI 8 atoms, not dependency expressions.
// Portage validates these again on the Gentoo host before bootstrap/packaging.
// Nothing accepted here can expand inside an ebuild's double-quoted metadata.
const NAME = /^[A-Za-z0-9_][A-Za-z0-9+_.-]*$/;
const VERSION = /^\d+(?:\.\d+)*[a-z]?(?:_(?:alpha|beta|pre|rc|p)\d*)*(?:-r\d+)?$/;
const USE = /^-?[A-Za-z0-9][A-Za-z0-9+_@-]*(?:\([+-]\))?$/;
const DEPENDENCY_PHASES = ["bootstrap", "BDEPEND", "DEPEND", "RDEPEND", "IDEPEND"];

function validateGentooAtom(value, label = "Gentoo dependency", phase = "RDEPEND") {
  const invalid = () => { throw new Error(`Invalid ${label} atom: ${JSON.stringify(value)}`); };
  if (typeof value !== "string" || !/^[A-Za-z0-9_+@.,:/<>=~*()[\]-]+$/.test(value)) invalid();
  let atom = value;
  if (atom.includes("[")) {
    const match = atom.match(/^(.*)\[([^\[\]]+)\]$/);
    if (!match || match[2].split(",").some(flag => !USE.test(flag))) invalid();
    atom = match[1];
  }
  if (atom.includes(":")) {
    const parts = atom.split(":");
    if (parts.length !== 2) invalid();
    const slot = parts[1];
    if (!/^(?:[=*]|[A-Za-z0-9_][A-Za-z0-9+_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9+_.-]*)?=?)$/.test(slot)) invalid();
    // emerge/portageq command-line atoms cannot request slot rebuild operators.
    if (phase === "bootstrap" && /[=*]/.test(slot)) invalid();
    atom = parts[0];
  }
  const operator = atom.match(/^(>=|<=|=|~|>|<)/)?.[0] ?? "";
  atom = atom.slice(operator.length);
  const parts = atom.split("/");
  if (parts.length !== 2 || !NAME.test(parts[0])) invalid();
  let pkg = parts[1];
  if (operator) {
    if (pkg.endsWith("*")) {
      if (operator !== "=") invalid();
      pkg = pkg.slice(0, -1);
    }
    const version = pkg.match(/^(.*)-(\d.*)$/);
    if (!version || !VERSION.test(version[2])) invalid();
    pkg = version[1];
  } else if (/-\d/.test(pkg)) {
    invalid();
  }
  if (!NAME.test(pkg)) invalid();
  return value;
}

function gentooFeatureDependencies(feature) {
  const dependencies = Object.fromEntries(DEPENDENCY_PHASES.map(phase => [phase, []]));
  let value = feature.manifest.gentoo?.dependencies ?? {};
  // The array shorthand declares runtime dependencies only.
  if (Array.isArray(value)) value = { RDEPEND: value };
  if (value == null || typeof value !== "object") {
    throw new Error(`Linux feature '${feature.id}' gentoo.dependencies must be an object`);
  }
  for (const [phase, atoms] of Object.entries(value)) {
    if (!DEPENDENCY_PHASES.includes(phase)) {
      throw new Error(`Linux feature '${feature.id}' has unknown Gentoo dependency phase '${phase}'`);
    }
    if (!Array.isArray(atoms)) {
      throw new Error(`Linux feature '${feature.id}' Gentoo ${phase} dependencies must be an array`);
    }
    dependencies[phase] = [...new Set(atoms.map(atom => validateGentooAtom(
      atom, `Linux feature '${feature.id}' Gentoo ${phase} dependency`, phase,
    )))].sort();
  }
  return dependencies;
}

module.exports = { DEPENDENCY_PHASES, gentooFeatureDependencies, validateGentooAtom };
