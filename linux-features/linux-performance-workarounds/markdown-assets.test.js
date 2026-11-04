"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyLinuxMarkdownAnimationPerformancePatch: apply,
  applyLinuxMarkdownAnimationStylesheetPatch: patch,
} = require("./implementation.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings } = require("../../scripts/lib/patch-report.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { PatchIntegrityError } = require("../../scripts/patches/integrity-error.js");
const descriptors = require("./patch.js").filter(({ id }) => id === "markdown-animation");
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/streaming-markdown.css"), "utf8");
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-stylesheets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "webview/assets/async"), { recursive: true });
  return dir;
}
function write(dir, name, source) {
  const file = path.join(dir, "webview/assets", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}
function runTwice(dir) {
  for (const expected of ["applied", "already-applied"]) {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(dir, descriptors, {}, report, descriptors[0].phase);
    assert.equal(report.patches[0].status, expected);
  }
}

test("streaming fades change while adaptive timing, images and unrelated animations stay byte-identical", () => {
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(apply(patched), patched);
  const tail = fixture.slice(fixture.indexOf(".MarkdownRoot-rZKhxa.AdaptiveStreaming"));
  assert.ok(patched.endsWith(tail));
  assert.equal((patched.match(/animation:none/g) ?? []).length, 2);
  assert.ok(patched.includes("animation:.18s ease-out both image-enter-VfEUgK"));
});

test("every recursively nested copy commits together through the production descriptor", t => {
  const dir = workspace(t);
  const one = write(dir, "async/one.css", fixture);
  const two = write(dir, "async/nested/two.css", fixture + ".extra{color:red}");
  const unrelated = ".MarkdownRoot-rZKhxa[data-markdown-animated]{color:red}";
  const other = write(dir, "other.css", unrelated);
  runTwice(dir);
  assert.equal(fs.readFileSync(one, "utf8"), apply(fixture));
  assert.equal(fs.readFileSync(two, "utf8"), apply(fixture) + ".extra{color:red}");
  assert.equal(fs.readFileSync(other, "utf8"), unrelated);
});

test("missing, differently identified, mixed, partial and damaged copies preserve all bytes", t => {
  const dir = workspace(t);
  assert.deepEqual(captureWarnings(() => patch(dir)).value, { changed: false, assetNames: [] });
  for (const bad of [
    apply(fixture),
    fixture.replaceAll("MarkdownRoot-rZKhxa", "MarkdownRoot-other"),
    fixture.replace("forwards;", "both;"),
    apply(fixture).replace("::marker{animation:none}", "::marker{animation:other}"),
    fixture.replace(/\.MarkdownRoot-rZKhxa\[data-markdown-animated\] \.ImageEnter-[^}]+}/, ""),
    fixture + fixture,
  ]) {
    const one = write(dir, "async/one.css", fixture);
    const two = write(dir, "async/two.css", bad);
    assert.deepEqual(captureWarnings(() => patch(dir)).value, { changed: false, assetNames: [] });
    assert.equal(fs.readFileSync(one, "utf8"), fixture);
    assert.equal(fs.readFileSync(two, "utf8"), bad);
  }
});

test("a failed second write restores both copies, and an unverifiable rollback is fatal", t => {
  for (const breakRollback of [false, true]) {
    const dir = workspace(t);
    const one = write(dir, "async/one.css", fixture);
    const two = write(dir, "async/two.css", fixture);
    const originalWrite = fs.writeFileSync;
    let calls = 0;
    const mock = t.mock.method(fs, "writeFileSync", (...args) => {
      calls += 1;
      if (calls === 2) {
        originalWrite(args[0], "partial");
        throw new Error("injected second write failure");
      }
      if (breakRollback && calls === 3) throw new Error("injected rollback failure");
      return originalWrite(...args);
    });
    try {
      assert.throws(() => patch(dir), breakRollback ? PatchIntegrityError : /injected second write failure/);
    } finally { mock.mock.restore(); }
    assert.equal(fs.readFileSync(one, "utf8"), fixture);
    assert.equal(fs.readFileSync(two, "utf8"), breakRollback ? "partial" : fixture);
  }
});

test("all current official CSS copies pass the production descriptor twice", { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, t => {
  const dir = workspace(t);
  const sourceDir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview/assets");
  const originals = [];
  for (const name of listWebviewAssetFiles(sourceDir, /\.css$/)) {
    const source = fs.readFileSync(path.join(sourceDir, name), "utf8");
    if (!source.includes("data-markdown-animated") || !source.includes("MarkdownRoot-")) continue;
    write(dir, name, source);
    originals.push({ name, source });
  }
  assert.ok(originals.length > 1);
  runTwice(dir);
  for (const { name, source } of originals) {
    assert.equal(fs.readFileSync(path.join(sourceDir, name), "utf8"), source);
    assert.equal(fs.readFileSync(path.join(dir, "webview/assets", name), "utf8"), apply(source));
  }
});
