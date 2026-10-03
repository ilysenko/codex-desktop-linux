"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  detectLinuxTargetContext,
  linuxTargetSummary,
} = require("./linux-target-context.js");
const {
  enabledLinuxFeatureIds,
  linuxFeaturesRoot,
} = require("./linux-features.js");

function runGit(repoDir, args) {
  const result = childProcess.spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isoTimestamp(env = process.env) {
  const rawEpoch = env.SOURCE_DATE_EPOCH?.trim();
  if (rawEpoch) {
    const epochSeconds = Number(rawEpoch);
    if (Number.isFinite(epochSeconds) && epochSeconds >= 0) {
      return new Date(Math.trunc(epochSeconds) * 1000).toISOString();
    }
  }
  return new Date().toISOString();
}

function sanitizeGitRemoteUrl(remote) {
  if (remote == null) {
    return null;
  }
  const value = String(remote).trim();
  if (value.length === 0 || path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return null;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      return url.toString();
    }
  } catch {
    return value;
  }
  return value;
}

function sanitizeSourceInfo(info) {
  const { sourceInfoPath, ...sanitized } = info;
  void sourceInfoPath;
  sanitized.remote = sanitizeGitRemoteUrl(sanitized.remote);
  sanitized.commitUrl = githubCommitUrl(sanitized.remote, sanitized.commit);
  return sanitized;
}

function githubCommitUrl(remote, commit) {
  const sha = typeof commit === "string" ? commit.trim() : "";
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return null;
  }
  const value = sanitizeGitRemoteUrl(remote);
  if (value == null) {
    return null;
  }

  let ownerAndRepo = null;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    ownerAndRepo = url.pathname.replace(/^\/+/, "");
  } catch {
    const scpMatch = value.match(/^(?:[^@]+@)?github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (scpMatch) {
      ownerAndRepo = scpMatch[1];
    }
  }

  if (ownerAndRepo == null) {
    return null;
  }
  ownerAndRepo = ownerAndRepo.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(ownerAndRepo)) {
    return null;
  }
  return `https://github.com/${ownerAndRepo}/commit/${sha}`;
}

function parseWrapperVersion(content) {
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^version\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function readWrapperVersion(repoDir) {
  try {
    return parseWrapperVersion(fs.readFileSync(path.join(repoDir, "updater", "Cargo.toml"), "utf8"));
  } catch {
    return null;
  }
}

function sourceInfoFromGit(repoDir, env = process.env) {
  const overrideCommit = env.CODEX_LINUX_SOURCE_COMMIT?.trim();
  const insideWorkTree = runGit(repoDir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!insideWorkTree && !overrideCommit) {
    return null;
  }

  const commit = overrideCommit || runGit(repoDir, ["rev-parse", "HEAD"]);
  const status = runGit(repoDir, ["status", "--porcelain"]);
  const remote = sanitizeGitRemoteUrl(env.CODEX_LINUX_SOURCE_REMOTE?.trim() || runGit(repoDir, ["remote", "get-url", "origin"]));
  return {
    commit,
    shortCommit: commit == null ? null : commit.slice(0, 12),
    version: readWrapperVersion(repoDir),
    branch: env.CODEX_LINUX_SOURCE_BRANCH?.trim() || runGit(repoDir, ["branch", "--show-current"]),
    remote,
    commitUrl: githubCommitUrl(remote, commit),
    describe: env.CODEX_LINUX_SOURCE_DESCRIBE?.trim() || runGit(repoDir, ["describe", "--always", "--dirty", "--tags"]),
    dirty: status != null && status.length > 0,
  };
}

function sourceInfo(repoDir, env = process.env) {
  const sourceInfoPath = path.join(repoDir, ".codex-linux", "source-info.json");
  const staged = readJsonFile(sourceInfoPath);
  if (staged != null && typeof staged === "object" && !Array.isArray(staged)) {
    return {
      ...sanitizeSourceInfo(staged),
      version: staged.version ?? readWrapperVersion(repoDir),
      provenance: staged.provenance ?? "packaged-update-builder",
    };
  }
  const gitInfo = sourceInfoFromGit(repoDir, env);
  if (gitInfo != null) {
    return { ...gitInfo, provenance: "git" };
  }
  return {
    commit: env.CODEX_LINUX_SOURCE_COMMIT?.trim() || null,
    shortCommit: env.CODEX_LINUX_SOURCE_COMMIT?.trim()?.slice(0, 12) || null,
    version: readWrapperVersion(repoDir),
    branch: env.CODEX_LINUX_SOURCE_BRANCH?.trim() || null,
    remote: sanitizeGitRemoteUrl(env.CODEX_LINUX_SOURCE_REMOTE?.trim() || null),
    commitUrl: githubCommitUrl(env.CODEX_LINUX_SOURCE_REMOTE?.trim() || null, env.CODEX_LINUX_SOURCE_COMMIT?.trim() || null),
    describe: env.CODEX_LINUX_SOURCE_DESCRIBE?.trim() || null,
    dirty: null,
    provenance: "unknown",
  };
}

function packageProfile(target) {
  const id = target.distro.id;
  const ids = new Set([id, ...target.distro.idLike]);
  const versionMajor = target.distro.versionMajor;

  if (ids.has("gentoo")) {
    return {
      id: "gentoo",
      label: "Gentoo / Portage",
      packageManager: "emerge",
      format: "local ebuild",
      notes: "Portage-managed prebuilt payload; manual updates with make bootstrap-native",
    };
  }

  if (ids.has("nixos") || ids.has("nix")) {
    return {
      id: "nix",
      label: "NixOS / Nix",
      packageManager: "flake",
      format: "runnable directly",
      notes: "nix run github:ilysenko/codex-desktop-linux",
    };
  }
  if (["debian", "ubuntu", "pop", "linuxmint", "elementary"].some((value) => ids.has(value))) {
    return {
      id: "debian-family",
      label: "Debian / Ubuntu / Pop!_OS / Mint / Elementary",
      packageManager: "apt",
      format: ".deb",
      notes: "The official Linux runtime and Codex CLI are bundled; no external Electron or CLI package is required",
    };
  }
  if (target.atomic && ids.has("fedora")) {
    return {
      id: "fedora-atomic",
      label: "Fedora Atomic Desktop",
      packageManager: "rpm-ostree",
      format: ".rpm",
      notes: "Native packages are layered with rpm-ostree instead of installed with dnf",
    };
  }
  if (id === "fedora") {
    return {
      id: versionMajor != null && versionMajor < 41 ? "fedora-pre-41" : "fedora-41-plus",
      label: versionMajor != null && versionMajor < 41 ? "Fedora < 41" : "Fedora 41+",
      packageManager: versionMajor != null && versionMajor < 41 ? "dnf" : "dnf5",
      format: ".rpm",
      notes: "",
    };
  }
  if (["opensuse", "suse", "sles"].some((value) => ids.has(value))) {
    return {
      id: "opensuse-family",
      label: "openSUSE Tumbleweed / Leap",
      packageManager: "zypper",
      format: ".rpm",
      notes: "Uses zypper --no-gpg-checks install for the local rebuild",
    };
  }
  if (["arch", "archlinux", "manjaro", "endeavouros"].some((value) => ids.has(value))) {
    return {
      id: "arch-family",
      label: "Arch / Manjaro / EndeavourOS",
      packageManager: "pacman",
      format: ".pkg.tar.zst",
      notes: "",
    };
  }
  return {
    id: "other-linux",
    label: "Atomic desktops / other Linux distros",
    packageManager: "none",
    format: ".AppImage",
    notes: "Local self-build only; no bundled auto-updater",
  };
}

function sha256File(filePath) {
  const crypto = require("node:crypto");
  const hasher = crypto.createHash("sha256");
  hasher.update(fs.readFileSync(filePath));
  return hasher.digest("hex");
}

function linuxTargetInfo(target) {
  return {
    summary: linuxTargetSummary(target),
    distro: target.distro,
    packageFormat: target.packageFormat,
    packageManager: target.packageManager,
    arch: target.arch,
    desktop: target.desktop,
    sessionType: target.sessionType,
    wayland: target.wayland,
    x11: target.x11,
    atomic: target.atomic,
  };
}

function buildInfo(options) {
  const repoDir = path.resolve(options.repoDir);
  const packagePath = path.resolve(options.upstreamPackagePath);
  const featuresRoot = linuxFeaturesRoot({ featuresRoot: options.featuresRoot });
  const env = options.env ?? process.env;
  const target = options.linuxTarget ?? detectLinuxTargetContext();
  const metadata = options.upstreamMetadata ?? {};
  return {
    schemaVersion: 2,
    generatedAt: isoTimestamp(env),
    appIdentity: {
      id: options.appId,
      displayName: options.appDisplayName,
    },
    upstreamLinuxPackage: {
      package: metadata.package ?? "chatgpt",
      version: metadata.version ?? null,
      architecture: metadata.architecture ?? null,
      repository: metadata.repository ?? null,
      repositoryPath: metadata.repositoryPath ?? null,
      fileName: path.basename(packagePath),
      sizeBytes: fs.statSync(packagePath).size,
      sha256: sha256File(packagePath),
    },
    source: sourceInfo(repoDir, env),
    linuxTarget: linuxTargetInfo(target),
    packageProfile: packageProfile(target),
    linuxFeatures: {
      enabled: enabledLinuxFeatureIds({ featuresRoot }),
    },
  };
}

function writeBuildInfo(options) {
  const info = buildInfo(options);
  for (const outputPath of options.outputPaths) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  }
  return info;
}

function main() {
  const [
    repoDir,
    installDir,
    packagePath,
    metadataPath,
    appId,
    appDisplayName,
  ] = process.argv.slice(2);
  if ([repoDir, installDir, packagePath, metadataPath, appId, appDisplayName].some((value) => !value)) {
    console.error("Usage: build-info.js <repo-dir> <install-dir> <package-path> <metadata-path> <app-id> <app-display-name>");
    process.exit(1);
  }
  writeBuildInfo({
    repoDir,
    upstreamPackagePath: packagePath,
    upstreamMetadata: readJsonFile(metadataPath) ?? {},
    appId,
    appDisplayName,
    outputPaths: [
      path.join(installDir, "resources", "codex-linux-build-info.json"),
      path.join(installDir, ".codex-linux", "build-info.json"),
    ],
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildInfo,
  githubCommitUrl,
  isoTimestamp,
  packageProfile,
  sanitizeGitRemoteUrl,
  sourceInfo,
  sourceInfoFromGit,
  writeBuildInfo,
};
