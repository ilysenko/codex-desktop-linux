"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEB_IDS = ["debian", "ubuntu", "linuxmint", "pop", "elementary", "zorin"];
const RPM_IDS = ["fedora", "rhel", "centos", "rocky", "almalinux", "ol", "sles", "suse", "opensuse"];
const PACMAN_IDS = ["arch", "archlinux", "manjaro", "endeavouros", "artix"];

function trimOsReleaseValue(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "");
}

function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function splitTokens(value) {
  return String(value ?? "")
    .split(/\s+/u)
    .map(normalizeToken)
    .filter(Boolean);
}

function booleanOverride(value) {
  const normalized = normalizeToken(value);
  if (!normalized) {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function flattenValues(values) {
  const flattened = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      flattened.push(...flattenValues(value));
    } else {
      flattened.push(value);
    }
  }
  return flattened;
}

function parseOsRelease(content) {
  const fields = Object.create(null);
  for (const line of String(content ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator);
    const value = trimOsReleaseValue(trimmed.slice(separator + 1));
    fields[key] = value;
  }
  return fields;
}

function readFirstOsRelease(paths) {
  for (const filePath of paths) {
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }
    try {
      return { path: filePath, fields: parseOsRelease(fs.readFileSync(filePath, "utf8")) };
    } catch {
      return { path: filePath, fields: Object.create(null) };
    }
  }
  return { path: null, fields: Object.create(null) };
}

function versionMajor(versionId) {
  const match = String(versionId ?? "").match(/^(\d+)/u);
  return match == null ? null : Number(match[1]);
}

function versionParts(versionId) {
  return String(versionId ?? "")
    .match(/\d+/gu)
    ?.map((part) => Number(part)) ?? [];
}

function compareVersionParts(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function executableExists(command, env = process.env) {
  if (!command) {
    return false;
  }
  if (path.isAbsolute(command)) {
    return canExecute(command);
  }
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    if (canExecute(path.join(dir, command))) {
      return true;
    }
  }
  return false;
}

function canExecute(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function tokenMatches(tokens, expected) {
  const wanted = new Set(flattenValues(expected).map(normalizeToken).filter(Boolean));
  return tokens.some((token) => wanted.has(token));
}

function detectPackageFormat(tokens, env) {
  const override = normalizeToken(env.CODEX_LINUX_TARGET_PACKAGE_FORMAT);
  if (override) {
    return override;
  }
  if (tokenMatches(tokens, PACMAN_IDS)) {
    return "pacman";
  }
  if (tokenMatches(tokens, RPM_IDS)) {
    return "rpm";
  }
  if (tokenMatches(tokens, DEB_IDS)) {
    return "deb";
  }
  if (executableExists("pacman", env) && !executableExists("dpkg-deb", env)) {
    return "pacman";
  }
  if (executableExists("rpmbuild", env) && !executableExists("dpkg-deb", env)) {
    return "rpm";
  }
  if (executableExists("dpkg-deb", env)) {
    return "deb";
  }
  if (executableExists("rpm", env) || executableExists("rpmbuild", env)) {
    return "rpm";
  }
  if (executableExists("pacman", env)) {
    return "pacman";
  }
  return "unknown";
}

function detectPackageManager(tokens, env, versionMajorValue, atomic) {
  const override = normalizeToken(env.CODEX_LINUX_TARGET_PACKAGE_MANAGER);
  if (override) {
    return override;
  }
  if (tokenMatches(tokens, PACMAN_IDS)) {
    return "pacman";
  }
  if (tokenMatches(tokens, DEB_IDS)) {
    return "apt";
  }
  if (tokenMatches(tokens, ["opensuse", "suse", "sles"])) {
    return "zypper";
  }
  if (tokenMatches(tokens, ["fedora", "rhel", "centos", "rocky", "almalinux", "ol"])) {
    if (atomic && executableExists("rpm-ostree", env)) {
      return "rpm-ostree";
    }
    if (tokens[0] === "fedora" && versionMajorValue != null && versionMajorValue < 41) {
      return executableExists("dnf", env) ? "dnf" : "unknown";
    }
    if (executableExists("dnf5", env)) {
      return "dnf5";
    }
    if (executableExists("dnf", env)) {
      return "dnf";
    }
    return "unknown";
  }
  for (const command of ["apt", "dnf5", "dnf", "pacman", "zypper"]) {
    if (executableExists(command, env)) {
      return command;
    }
  }
  return "unknown";
}

function buildDesktopTokens(env) {
  const desktop = env.CODEX_LINUX_TARGET_DESKTOP ||
    env.XDG_CURRENT_DESKTOP ||
    env.DESKTOP_SESSION ||
    "";
  return splitTokens(desktop.replace(/[:;]/gu, " "));
}

function detectAtomicDesktop(env, options = {}) {
  if (typeof options.atomic === "boolean") {
    return options.atomic;
  }
  const override = booleanOverride(env.CODEX_LINUX_TARGET_ATOMIC);
  if (override != null) {
    return override;
  }
  const ostreeBootedPath = options.ostreeBootedPath ?? env.OSTREE_BOOTED_FILE ?? "/run/ostree-booted";
  return Boolean(ostreeBootedPath) && fs.existsSync(ostreeBootedPath);
}

function createHelpers(target) {
  return {
    matchesId: (...ids) => tokenMatches([target.distro.id, ...target.distro.idLike], ids),
    packageFormatIs: (...formats) => tokenMatches([target.packageFormat], formats),
    packageManagerIs: (...managers) => tokenMatches([target.packageManager], managers),
    desktopMatches: (...desktops) => tokenMatches(target.desktop.tokens, desktops),
    versionAtLeast: (minimum) => {
      const current = versionParts(target.distro.versionId);
      const wanted = versionParts(minimum);
      if (current.length === 0 || wanted.length === 0) {
        return false;
      }
      return compareVersionParts(current, wanted) >= 0;
    },
  };
}

function detectLinuxTargetContext(options = {}) {
  const env = options.env ?? process.env;
  const osReleasePaths = options.osReleasePaths ?? [
    env.OS_RELEASE_FILE,
    "/etc/os-release",
    "/usr/lib/os-release",
  ];
  const osRelease = options.osReleaseFields == null
    ? readFirstOsRelease(osReleasePaths)
    : { path: options.osReleasePath ?? null, fields: options.osReleaseFields };
  const id = normalizeToken(env.CODEX_LINUX_TARGET_ID || osRelease.fields.ID || "");
  const idLike = splitTokens(env.CODEX_LINUX_TARGET_ID_LIKE || osRelease.fields.ID_LIKE || "");
  const versionId = env.CODEX_LINUX_TARGET_VERSION_ID || osRelease.fields.VERSION_ID || "";
  const versionMajorValue = versionMajor(versionId);
  const distroTokens = [id, ...idLike].filter(Boolean);
  const sessionType = normalizeToken(env.CODEX_LINUX_TARGET_SESSION_TYPE || env.XDG_SESSION_TYPE || "");
  const desktopTokens = buildDesktopTokens(env);
  const atomic = detectAtomicDesktop(env, options);
  const target = {
    osReleasePath: osRelease.path,
    arch: env.CODEX_LINUX_TARGET_ARCH || process.arch,
    kernelRelease: env.CODEX_LINUX_TARGET_KERNEL_RELEASE || os.release(),
    distro: {
      id,
      idLike,
      versionId,
      versionMajor: versionMajorValue,
      prettyName: env.CODEX_LINUX_TARGET_PRETTY_NAME || osRelease.fields.PRETTY_NAME || "",
    },
    packageFormat: detectPackageFormat(distroTokens, env),
    packageManager: detectPackageManager(distroTokens, env, versionMajorValue, atomic),
    desktop: {
      raw: env.CODEX_LINUX_TARGET_DESKTOP || env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "",
      tokens: desktopTokens,
    },
    sessionType,
    wayland: sessionType === "wayland" || Boolean(env.WAYLAND_DISPLAY),
    x11: sessionType === "x11" || Boolean(env.DISPLAY),
    atomic,
  };
  target.helpers = createHelpers(target);
  Object.assign(target, target.helpers);
  return target;
}

function linuxTargetSummary(target) {
  const id = target.distro.id || "unknown";
  const version = target.distro.versionId ? `:${target.distro.versionId}` : "";
  const format = target.packageFormat || "unknown";
  const desktop = target.desktop.tokens.length > 0 ? `:${target.desktop.tokens.join("+")}` : "";
  return `${id}${version}/${format}${desktop}`;
}

module.exports = {
  DEB_IDS,
  PACMAN_IDS,
  RPM_IDS,
  detectLinuxTargetContext,
  detectAtomicDesktop,
  executableExists,
  flattenValues,
  linuxTargetSummary,
  parseOsRelease,
  splitTokens,
  tokenMatches,
  trimOsReleaseValue,
  versionMajor,
  versionParts,
};
