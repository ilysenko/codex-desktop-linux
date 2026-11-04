"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { patchBreaksJavaScriptSyntax } = require("./javascript-syntax.js");
const { PatchIntegrityError } = require("../integrity-error.js");
const JAVASCRIPT_ASSET_PATTERN = /\.(?:c|m)?js$/;

function commitAssetEdits(webviewAssetsDir, edits, options = {}) {
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  function requireAssetFile(assetName) {
    let currentPath = webviewAssetsDir;
    const parts = assetName.split("/");
    if (!fs.lstatSync(currentPath).isDirectory()) {
      throw new Error(`Webview assets directory must not be a symlink: ${currentPath}`);
    }
    for (const [index, part] of parts.entries()) {
      currentPath = path.join(currentPath, part);
      const stat = fs.lstatSync(currentPath);
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
        throw new Error(`Webview asset path must not contain symlinks or special files: ${assetName}`);
      }
    }
    return currentPath;
  }
  function readBytes(assetName) {
    const bytes = readFileSync(requireAssetFile(assetName));
    return Buffer.isBuffer(bytes) ? Buffer.from(bytes) : null;
  }
  function bytesEqual(expected, actual) {
    return actual != null && Buffer.prototype.equals.call(expected, actual);
  }
  const seen = new Set();
  const pendingWrites = [];
  for (const { assetName, source, patchedSource } of edits) {
    if (typeof assetName !== "string" || assetName === "" || path.isAbsolute(assetName) ||
        assetName.includes("\\") ||
        assetName.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "") ||
        seen.has(assetName)) {
      throw new Error(`Invalid or duplicate webview asset edit: ${assetName}`);
    }
    seen.add(assetName);
    if (typeof source !== "string" || typeof patchedSource !== "string") {
      throw new TypeError(`Webview asset edit must contain source and patchedSource: ${assetName}`);
    }
    const filePath = requireAssetFile(assetName);
    const originalBytes = Buffer.from(source, "utf8");
    if (!bytesEqual(originalBytes, readBytes(assetName))) {
      throw new Error(`Webview asset changed before patch commit: ${assetName}`);
    }
    if (patchedSource === source) continue;
    if (rejectsSyntaxBreak(assetName, source, patchedSource)) return { changed: 0, changedAssets: [] };
    pendingWrites.push({ assetName, filePath, originalBytes, patchedBytes: Buffer.from(patchedSource, "utf8") });
  }
  const attemptedWrites = [];
  try {
    for (const edit of pendingWrites) {
      if (!bytesEqual(edit.originalBytes, readBytes(edit.assetName))) {
        throw new Error(`Webview asset changed before patch write: ${edit.assetName}`);
      }
      attemptedWrites.push(edit);
      writeFileSync(edit.filePath, Buffer.from(edit.patchedBytes));
      if (!bytesEqual(edit.patchedBytes, readBytes(edit.assetName))) {
        throw new Error(`Webview asset write byte verification failed: ${edit.assetName}`);
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const { assetName, filePath, originalBytes } of [...attemptedWrites].reverse()) {
      try {
        requireAssetFile(assetName);
        writeFileSync(filePath, Buffer.from(originalBytes));
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const { assetName, originalBytes } of attemptedWrites) {
      try {
        if (!bytesEqual(originalBytes, readBytes(assetName))) {
          throw new Error(`Webview asset rollback byte verification failed: ${assetName}`);
        }
      } catch (verificationError) {
        throw new PatchIntegrityError(
          `Webview asset patch rollback could not restore original bytes: ${verificationError.message}` +
            (rollbackErrors.length === 0 ? "" : `; rollback write also failed: ${rollbackErrors[0].message}`),
          { cause: error },
        );
      }
    }
    throw error;
  }
  return { changed: pendingWrites.length, changedAssets: pendingWrites.map(edit => edit.assetName) };
}

function rejectsSyntaxBreak(assetName, original, patched) {
  if (!JAVASCRIPT_ASSET_PATTERN.test(assetName) || !patchBreaksJavaScriptSyntax(original, patched)) {
    return false;
  }
  console.warn(
    `WARN: Patched webview asset ${assetName} no longer parses as JavaScript — keeping the original asset`,
  );
  return true;
}

module.exports = { commitAssetEdits };
