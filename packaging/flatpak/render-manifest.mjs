#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const scriptDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const repoRoot = path.resolve(scriptDir, '..', '..');
const defaultOutput = path.join(scriptDir, 'io.github.ilysenko.codex_desktop_linux.json');

function usage() {
  console.error('Usage: render-manifest.mjs [--output path]');
  process.exit(1);
}

let outputPath = defaultOutput;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--output') {
    outputPath = process.argv[++i];
    if (!outputPath) usage();
    continue;
  }
  usage();
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

const upstream = readJson('packaging/flatpak/upstream.json');
const asarSources = readJson('packaging/flatpak/asar-sources.json');
const cliSources = readJson('packaging/flatpak/codex-cli-sources.json');
const nativeSources = readJson('packaging/flatpak/native-modules-sources.json');
const toolsSources = readJson('packaging/flatpak/tools-sources.json');
const dugiteNativeSources = readJson('packaging/flatpak/dugite-native-sources.json');

function localArchivePath() {
  const value = process.env.CODEX_FLATPAK_SOURCE_ARCHIVE_PATH?.trim();
  return value ? path.resolve(value) : null;
}

function sourceSpec() {
  const kind = process.env.CODEX_FLATPAK_SOURCE_KIND?.trim() || '';
  const archivePath = localArchivePath();
  const dirPath = process.env.CODEX_FLATPAK_SOURCE_DIR?.trim();
  const sourceUrl = process.env.CODEX_FLATPAK_SOURCE_URL?.trim();
  const sourceSha256 = process.env.CODEX_FLATPAK_SOURCE_SHA256?.trim();
  const sourceCommit = process.env.CODEX_FLATPAK_SOURCE_COMMIT?.trim();

  if (kind === 'git' || sourceCommit) {
    if (!sourceUrl || !sourceCommit) {
      throw new Error('Git source mode requires CODEX_FLATPAK_SOURCE_URL and CODEX_FLATPAK_SOURCE_COMMIT');
    }
    return { type: 'git', url: sourceUrl, commit: sourceCommit };
  }

  if (kind === 'archive' || archivePath || sourceSha256) {
    if (archivePath) {
      return { type: 'archive', path: archivePath };
    }
    if (!sourceUrl || !sourceSha256) {
      throw new Error('Archive source mode requires either CODEX_FLATPAK_SOURCE_ARCHIVE_PATH or CODEX_FLATPAK_SOURCE_URL + CODEX_FLATPAK_SOURCE_SHA256');
    }
    return { type: 'archive', url: sourceUrl, sha256: sourceSha256 };
  }

  const resolvedDir = path.resolve(dirPath || repoRoot);
  const relativeDir = path.relative(path.dirname(outputPath), resolvedDir) || '.';
  return {
    type: 'dir',
    path: relativeDir,
  };
}

function fileSource({ url, sha256 }, dest, destFilename, onlyArches) {
  const source = { type: 'file', url, sha256, dest, 'dest-filename': destFilename };
  if (onlyArches?.length) {
    source['only-arches'] = onlyArches;
  }
  return source;
}

function localFileSource(filePath, dest, destFilename, onlyArches) {
  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(path.dirname(outputPath), resolvedPath) || '.';
  const source = { type: 'file', path: relativePath, dest, 'dest-filename': destFilename };
  if (onlyArches?.length) {
    source['only-arches'] = onlyArches;
  }
  return source;
}

function codexDmgSource() {
  const localPath = process.env.CODEX_FLATPAK_LOCAL_DMG_PATH?.trim();
  if (localPath && fs.existsSync(localPath)) {
    return localFileSource(localPath, '.', 'Codex.dmg');
  }
  return fileSource(upstream.codexDmg, '.', 'Codex.dmg');
}

function mergeSources(...sourceGroups) {
  const merged = [];
  const seen = new Set();
  for (const group of sourceGroups) {
    for (const source of group) {
      const key = JSON.stringify(source);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
    }
  }
  return merged;
}

const manifest = {
  'app-id': upstream.appId,
  runtime: 'org.freedesktop.Platform',
  'runtime-version': upstream.runtimeVersion,
  sdk: 'org.freedesktop.Sdk',
  base: 'org.electronjs.Electron2.BaseApp',
  'base-version': upstream.runtimeVersion,
  command: 'codex-desktop-flatpak',
  'separate-locales': false,
  tags: ['proprietary'],
  'finish-args': [
    '--share=network',
    '--share=ipc',
    '--socket=wayland',
    '--socket=fallback-x11',
    '--socket=pulseaudio',
    '--socket=ssh-auth',
    '--device=dri',
    '--talk-name=org.freedesktop.secrets',
    '--env=ELECTRON_TRASH=gio',
  ],
  modules: [
    {
      name: 'codex-desktop-linux',
      buildsystem: 'simple',
      'build-options': {
        env: {
          XDG_CACHE_HOME: '/run/build/codex-desktop-linux/cache',
          npm_config_loglevel: 'warn',
        },
      },
      'build-commands': [
        'bash packaging/flatpak/build-flatpak-app.sh',
      ],
      sources: mergeSources(
        [sourceSpec()],
        [
          codexDmgSource(),
          fileSource(upstream.electronHeaders, '.flatpak-sources', 'electron-headers.tar.gz'),
          fileSource(upstream.managedNode.x86_64, '.flatpak-sources', 'node.tar.xz', ['x86_64']),
          fileSource(upstream.managedNode.aarch64, '.flatpak-sources', 'node.tar.xz', ['aarch64']),
          fileSource(upstream.pythonStandalone.x86_64, '.flatpak-sources', 'python.tar.gz', ['x86_64']),
          fileSource(upstream.pythonStandalone.aarch64, '.flatpak-sources', 'python.tar.gz', ['aarch64']),
          fileSource(upstream.sevenZip.x86_64, '.flatpak-sources', '7zip.tar.xz', ['x86_64']),
          fileSource(upstream.sevenZip.aarch64, '.flatpak-sources', '7zip.tar.xz', ['aarch64']),
          fileSource(upstream.electronZip.x86_64, '.flatpak-sources', 'electron.zip', ['x86_64']),
          fileSource(upstream.electronZip.aarch64, '.flatpak-sources', 'electron.zip', ['aarch64']),
        ],
        asarSources,
        cliSources,
        nativeSources,
        toolsSources,
        dugiteNativeSources,
      ),
    },
  ],
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
