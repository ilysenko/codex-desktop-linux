"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  appBundleVersion,
  recordAppVersionMetadata,
} = require("./build-info.js");

function writeInfoPlist(appDir, version) {
  const contentsDir = path.join(appDir, "Contents");
  fs.mkdirSync(contentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(contentsDir, "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "<key>CFBundleShortVersionString</key>",
      `<string>${version}</string>`,
      "</dict></plist>",
    ].join("\n"),
  );
}

test("records the extracted app version without discarding downloaded DMG metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-build-info-"));
  try {
    const appDir = path.join(tempDir, "Codex.app");
    const metadataPath = path.join(tempDir, "reports", "upstream-dmg-metadata.json");
    writeInfoPlist(appDir, "26.803.41515");
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, `${JSON.stringify({ etag: "current", path: "/tmp/Codex.dmg" })}\n`);

    assert.equal(appBundleVersion(appDir), "26.803.41515");
    assert.equal(recordAppVersionMetadata(metadataPath, appDir), "26.803.41515");
    assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, "utf8")), {
      etag: "current",
      path: "/tmp/Codex.dmg",
      appVersion: "26.803.41515",
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("leaves metadata untouched when the extracted app has no readable version", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-build-info-missing-"));
  try {
    const appDir = path.join(tempDir, "Codex.app");
    const metadataPath = path.join(tempDir, "upstream-dmg-metadata.json");
    const original = '{"etag":"current"}\n';
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(metadataPath, original);

    assert.equal(appBundleVersion(appDir), null);
    assert.equal(recordAppVersionMetadata(metadataPath, appDir), null);
    assert.equal(fs.readFileSync(metadataPath, "utf8"), original);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("leaves malformed metadata untouched instead of publishing a partial replacement", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-build-info-malformed-"));
  try {
    const appDir = path.join(tempDir, "Codex.app");
    const metadataPath = path.join(tempDir, "upstream-dmg-metadata.json");
    const original = '{"etag":';
    writeInfoPlist(appDir, "26.803.41515");
    fs.writeFileSync(metadataPath, original);

    assert.throws(() => recordAppVersionMetadata(metadataPath, appDir), SyntaxError);
    assert.equal(fs.readFileSync(metadataPath, "utf8"), original);
    assert.deepEqual(
      fs.readdirSync(tempDir).filter((entry) => entry.startsWith(".upstream-dmg-metadata-")),
      [],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
