const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const workflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "build-artifacts.yml",
);

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("artifact workflow covers triggers, packages, and distro smoke", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /^      - main\s*$/m);
  assert.match(workflow, /^      - 'v\*'\s*$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /runs-on: ubuntu-22\.04/);
  assert.match(workflow, /\.\/scripts\/build-deb\.sh/);
  assert.match(workflow, /\.\/scripts\/build-rpm\.sh/);
  assert.match(workflow, /\.\/scripts\/build-tarball\.sh/);
  assert.match(workflow, /dist\/\*\.deb/);
  assert.match(workflow, /dist\/\*\.rpm/);
  assert.match(workflow, /dist\/\*\.tar\.gz/);
  assert.match(workflow, /uses:\s+actions\/upload-artifact@/);
  assert.match(workflow, /uses:\s+actions\/download-artifact@/);
  assert.match(workflow, /path: \./);

  for (const distro of [
    "Ubuntu 22.04",
    "Ubuntu 24.04",
    "Debian 12",
    "Fedora 42",
    "openSUSE Tumbleweed",
    "Arch Linux",
  ]) {
    assert.match(workflow, new RegExp(`distro: ${escapeRegExp(distro)}`));
  }
});
