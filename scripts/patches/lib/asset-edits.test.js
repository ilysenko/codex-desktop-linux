"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { commitAssetEdits } = require("./asset-edits.js");
const { PatchIntegrityError } = require("../integrity-error.js");
const { createPatchReport } = require("../../lib/patch-report.js");
const { extractedAppPatch, PHASE_EXTRACTED_APP_POST_WEBVIEW } = require("../descriptor.js");
const { applyExtractedAppPatchDescriptors } = require("../engine.js");
function withAssets(files, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-assets-test-"));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(assets, name)), { recursive: true });
    fs.writeFileSync(path.join(assets, name), source);
  }
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return callback({
      root,
      assets,
      read: (name) => fs.readFileSync(path.join(assets, name), "utf8"),
      warnings,
    });
  } finally {
    console.warn = originalWarn;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const MODULE = "function Pan(){return 1}export{Pan};";
const RSPACK_CHUNK = 'export const __rspack_esm_id=1;export const __webpack_modules__={owner(e,t,n){let p={available:!1,label:"Linux"};n.d(t,{},{default:p})}};';
test("multi-asset commit validates every source and rejects stale partial state", () => {
  withAssets({ "async/1.js": RSPACK_CHUNK, "worker.js": MODULE }, ({ assets, read }) => {
    const edits = [
      { assetName: "async/1.js", source: RSPACK_CHUNK, patchedSource: RSPACK_CHUNK.replace("!1", "!0") },
      { assetName: "worker.js", source: "stale", patchedSource: MODULE.replace("1", "2") },
    ];
    assert.throws(() => commitAssetEdits(assets, edits), /changed before patch commit: worker\.js/);
    assert.equal(read("async/1.js"), RSPACK_CHUNK);
    assert.equal(read("worker.js"), MODULE);
    edits[1].source = MODULE;
    assert.deepEqual(commitAssetEdits(assets, edits), { changed: 2, changedAssets: ["async/1.js", "worker.js"] });
    assert.equal(read("worker.js"), MODULE.replace("1", "2"));
    assert.deepEqual(commitAssetEdits(assets, edits.map(({ assetName, patchedSource }) => ({
      assetName, source: patchedSource, patchedSource,
    }))), { changed: 0, changedAssets: [] });
  });
});

test("multi-asset commit rolls back bytes when a later write fails", () => {
  withAssets({ "async/1.js": RSPACK_CHUNK, "worker.js": MODULE }, ({ assets, read }) => {
    let failed = false;
    assert.throws(() => commitAssetEdits(assets, [
      { assetName: "async/1.js", source: RSPACK_CHUNK, patchedSource: RSPACK_CHUNK.replace("!1", "!0") },
      { assetName: "worker.js", source: MODULE, patchedSource: MODULE.replace("1", "2") },
    ], { writeFileSync(filePath, bytes) {
      if (filePath === path.join(assets, "worker.js") && !failed) {
        failed = true;
        // A write can truncate the destination before failing.
        fs.writeFileSync(filePath, "truncated");
        throw new Error("write failed");
      }
      fs.writeFileSync(filePath, bytes);
    } }), /write failed/);
    assert.equal(read("async/1.js"), RSPACK_CHUNK);
    assert.equal(read("worker.js"), MODULE);
  });
});

test("multi-asset commit rechecks each original immediately before mutating it", () => {
  withAssets({ "a.js": MODULE, "b.js": MODULE }, ({ assets, read }) => {
    const edits = ["a.js", "b.js"].map((assetName) => ({
      assetName, source: MODULE, patchedSource: MODULE.replace("1", "2"),
    }));
    let writes = 0;
    assert.throws(() => commitAssetEdits(assets, edits, {
      writeFileSync(filePath, bytes) {
        if (writes++ === 0) fs.writeFileSync(path.join(assets, "b.js"), "external change");
        fs.writeFileSync(filePath, bytes);
      },
    }), /changed before patch write: b\.js/);
    assert.equal(writes, 2); // a.js write and a.js rollback only.
    assert.equal(read("a.js"), MODULE);
    assert.equal(read("b.js"), "external change");
  });
});

test("multi-asset commit detects silent writes and verifies a completed rollback", () => {
  withAssets({ "a.js": MODULE }, ({ assets, read }) => {
    let writes = 0;
    assert.throws(() => commitAssetEdits(assets, [{
      assetName: "a.js", source: MODULE, patchedSource: MODULE.replace("1", "2"),
    }], { writeFileSync(filePath, bytes) {
      fs.writeFileSync(filePath, writes++ === 0 ? "truncated" : bytes);
    } }), (error) => {
      assert.equal(error instanceof PatchIntegrityError, false);
      assert.match(error.message, /write byte verification failed/);
      return true;
    });
    assert.equal(read("a.js"), MODULE);
  });
});

test("unproven rollback aborts even an optional descriptor with failed-integrity", () => {
  withAssets({ "a.js": MODULE }, ({ root, assets, read }) => {
    let writes = 0;
    const descriptor = extractedAppPatch({
      id: "optional-transaction", phase: PHASE_EXTRACTED_APP_POST_WEBVIEW,
      ciPolicy: "optional", enforceWhenEnabled: false,
      apply() {
        return commitAssetEdits(assets, [{
          assetName: "a.js", source: MODULE, patchedSource: MODULE.replace("1", "2"),
        }], { writeFileSync(filePath) {
          if (writes++ === 0) {
            fs.writeFileSync(filePath, "truncated");
            throw new Error("injected write failure");
          }
          // A rollback that silently writes nothing must not count as success.
        } });
      },
    });
    const report = createPatchReport();
    assert.throws(() => applyExtractedAppPatchDescriptors(
      root, [descriptor], {}, report, PHASE_EXTRACTED_APP_POST_WEBVIEW,
    ), (error) => {
      assert.equal(error instanceof PatchIntegrityError, true);
      assert.equal(error.code, "PATCH_INTEGRITY_FAILURE");
      assert.match(error.message, /rollback could not restore original bytes/);
      assert.match(error.cause.message, /injected write failure/);
      return true;
    });
    assert.equal(read("a.js"), "truncated");
    assert.equal(report.patches[0].status, "failed-integrity");
  });
});

test("rollback errors preserve integrity status unless original bytes are proved restored", () => {
  for (const restoresBeforeThrow of [false, true]) {
    withAssets({ "a.js": MODULE }, ({ assets, read }) => {
      let writes = 0;
      assert.throws(() => commitAssetEdits(assets, [{
        assetName: "a.js", source: MODULE, patchedSource: MODULE.replace("1", "2"),
      }], { writeFileSync(filePath, bytes) {
        if (writes++ === 0) {
          fs.writeFileSync(filePath, "truncated");
          throw new Error("initial write failed");
        }
        if (restoresBeforeThrow) fs.writeFileSync(filePath, bytes);
        throw new Error("rollback write failed");
      } }), (error) => {
        assert.equal(error instanceof PatchIntegrityError, !restoresBeforeThrow);
        assert.match(error.message, restoresBeforeThrow ? /initial write failed/ : /rollback write also failed/);
        return true;
      });
      assert.equal(read("a.js"), restoresBeforeThrow ? MODULE : "truncated");
    });
  }
});

test("asset edits reject symlink files, symlink parents, and a symlink assets root", () => {
  withAssets({ "real/a.js": MODULE }, ({ root, assets, read }) => {
    fs.symlinkSync(path.join(assets, "real/a.js"), path.join(assets, "link.js"));
    fs.symlinkSync(path.join(assets, "real"), path.join(assets, "link-directory"), "dir");
    fs.symlinkSync(assets, path.join(root, "assets-link"), "dir");
    const edit = { source: MODULE, patchedSource: MODULE.replace("1", "2") };
    assert.throws(() => commitAssetEdits(assets, [{ ...edit, assetName: "link.js" }]), /must not contain symlinks/);
    assert.throws(() => commitAssetEdits(assets, [{ ...edit, assetName: "link-directory/a.js" }]), /must not contain symlinks/);
    assert.throws(() => commitAssetEdits(path.join(root, "assets-link"), [{ ...edit, assetName: "real/a.js" }]), /directory must not be a symlink/);
    assert.equal(read("real/a.js"), MODULE);
  });
});

test("multi-asset commit rejects duplicate and escaping paths before writing", () => {
  withAssets({ "a.js": MODULE }, ({ assets, read }) => {
    const edit = { assetName: "a.js", source: MODULE, patchedSource: MODULE.replace("1", "2") };
    assert.throws(() => commitAssetEdits(assets, [edit, edit]), /Invalid or duplicate/);
    assert.throws(() => commitAssetEdits(assets, [{ ...edit, assetName: "../a.js" }]), /Invalid or duplicate/);
    assert.equal(read("a.js"), MODULE);
  });
});

