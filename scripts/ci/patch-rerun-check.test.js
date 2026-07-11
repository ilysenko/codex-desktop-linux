"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  hashTree,
  runPatchRerunCheck,
} = require("./patch-rerun-check.js");

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "patch-rerun-check-"));
  try {
    const appDir = path.join(root, "app");
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, "asset.js"), "const value = 1;\n");
    const firstReportPath = path.join(root, "first.json");
    fs.writeFileSync(firstReportPath, `${JSON.stringify({
      enabledFeatures: ["remote-mobile-control"],
      patches: [{
        name: "feature:remote-mobile-control:test-patch",
        status: "applied",
        sourceKind: "feature",
        featureId: "remote-mobile-control",
      }],
    })}\n`);
    return fn({ appDir, firstReportPath, root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writePatcher(root, body) {
  const patcherPath = path.join(root, "patcher.js");
  fs.writeFileSync(patcherPath, `"use strict";\n${body}\n`);
  return patcherPath;
}

function reportWriter(extra = "") {
  return `
const fs = require("node:fs");
const args = process.argv.slice(2);
const reportPath = args[args.indexOf("--report-json") + 1];
const appDir = args.at(-1);
${extra}
fs.writeFileSync(reportPath, JSON.stringify({
  enabledFeatures: ["remote-mobile-control"],
  patches: [{
    name: "feature:remote-mobile-control:test-patch",
    status: "already-applied",
    sourceKind: "feature",
    featureId: "remote-mobile-control"
  }]
}));`;
}

test("accepts a second patch pass that leaves the extracted tree unchanged", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const result = runPatchRerunCheck({
      appDir,
      firstReportPath,
      outputPath: path.join(root, "matrix.json"),
      patcherPath: writePatcher(root, reportWriter()),
      secondReportPath: path.join(root, "second.json"),
    });

    assert.equal(result.idempotent, true);
    assert.equal(result.featureSetStable, true);
    assert.equal(result.descriptorSetStable, true);
    assert.equal(result.treeHashBefore, result.treeHashAfter);
    assert.deepEqual(result.enabledFeatures, ["remote-mobile-control"]);
    assert.deepEqual(result.patches, [{
      firstStatus: "applied",
      name: "feature:remote-mobile-control:test-patch",
      secondStatus: "already-applied",
    }]);
  });
});

test("rejects a second patch pass that changes the extracted tree", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const patcherPath = writePatcher(
      root,
      reportWriter('fs.writeFileSync(require("node:path").join(appDir, "late.js"), "late\\n");'),
    );
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath,
        secondReportPath: path.join(root, "second.json"),
      }),
      /changed the extracted app tree/,
    );
  });
});

test("rejects a patcher that writes a credible report and then exits non-zero", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const patcherPath = writePatcher(root, `${reportWriter()}\nprocess.exitCode = 7;`);
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath,
        secondReportPath: path.join(root, "second.json"),
      }),
      /exited with status 7/,
    );
  });
});

test("reports when the second patch pass is terminated by a signal", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath: writePatcher(root, 'process.kill(process.pid, "SIGTERM");'),
        secondReportPath: path.join(root, "second.json"),
      }),
      /terminated by signal SIGTERM/,
    );
  });
});

test("rejects a second pass that changes the enabled feature set", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const patcherPath = writePatcher(root, reportWriter().replace(
      '["remote-mobile-control"]',
      "[]",
    ));
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath,
        secondReportPath: path.join(root, "second.json"),
      }),
      /changed the enabled feature set/,
    );
  });
});

test("rejects a second pass that omits a patch descriptor", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const patcherPath = writePatcher(root, reportWriter().replace(
      /patches: \[\{[\s\S]*?\}\]/,
      "patches: []",
    ));
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath,
        secondReportPath: path.join(root, "second.json"),
      }),
      /changed the patch descriptor set/,
    );
  });
});

test("rejects a second pass that adds a patch descriptor", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const patcherPath = writePatcher(root, reportWriter().replace(
      "patches: [{",
      'patches: [{ name: "unexpected", status: "already-applied" }, {',
    ));
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath,
        secondReportPath: path.join(root, "second.json"),
      }),
      /changed the patch descriptor set/,
    );
  });
});

test("rejects duplicate patch descriptors in the second report", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const patcherPath = writePatcher(root, reportWriter().replace(
      "patches: [{",
      'patches: [{ name: "feature:remote-mobile-control:test-patch", status: "already-applied" }, {',
    ));
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath,
        secondReportPath: path.join(root, "second.json"),
      }),
      /changed the patch descriptor set/,
    );
  });
});

test("does not accept a stale second report when the patcher writes nothing", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const secondReportPath = path.join(root, "second.json");
    fs.copyFileSync(firstReportPath, secondReportPath);
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath: writePatcher(root, "// Deliberately writes no report."),
        secondReportPath,
      }),
      /ENOENT|no such file/i,
    );
  });
});

test("hashes symlink targets without following them", () => {
  withFixture(({ appDir }) => {
    fs.symlinkSync("asset.js", path.join(appDir, "asset-link"));
    const before = hashTree(appDir);
    fs.unlinkSync(path.join(appDir, "asset-link"));
    fs.symlinkSync("missing.js", path.join(appDir, "asset-link"));
    assert.notEqual(hashTree(appDir), before);
  });
});

test("rejects report outputs stored inside the tree being hashed", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(root, "matrix.json"),
        patcherPath: writePatcher(root, reportWriter()),
        secondReportPath: path.join(appDir, "second.json"),
      }),
      /outside the extracted app directory/,
    );
  });
});

test("rejects a first report stored inside the tree being hashed", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const nestedFirstReport = path.join(appDir, "first.json");
    fs.copyFileSync(firstReportPath, nestedFirstReport);
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath: nestedFirstReport,
        outputPath: path.join(root, "matrix.json"),
        patcherPath: writePatcher(root, reportWriter()),
        secondReportPath: path.join(root, "second.json"),
      }),
      /outside the extracted app directory/,
    );
  });
});

test("rejects aliased report and matrix output paths", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const sharedPath = path.join(root, "shared.json");
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: sharedPath,
        patcherPath: writePatcher(root, reportWriter()),
        secondReportPath: sharedPath,
      }),
      /must use different paths/,
    );
  });
});

test("rejects a matrix output symlink before it can mutate the app tree", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const outputPath = path.join(root, "matrix.json");
    fs.symlinkSync(path.join(appDir, "asset.js"), outputPath);
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath,
        patcherPath: writePatcher(root, reportWriter()),
        secondReportPath: path.join(root, "second.json"),
      }),
      /must not be a symbolic link/,
    );
    assert.equal(fs.readFileSync(path.join(appDir, "asset.js"), "utf8"), "const value = 1;\n");
  });
});

test("rejects an output directory symlink that resolves inside the app tree", () => {
  withFixture(({ appDir, firstReportPath, root }) => {
    const linkedDirectory = path.join(root, "linked-output");
    fs.symlinkSync(appDir, linkedDirectory);
    assert.throws(
      () => runPatchRerunCheck({
        appDir,
        firstReportPath,
        outputPath: path.join(linkedDirectory, "matrix.json"),
        patcherPath: writePatcher(root, reportWriter()),
        secondReportPath: path.join(root, "second.json"),
      }),
      /outside the extracted app directory/,
    );
  });
});
