const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function findEnvHook(root) {
  const found = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (
        entry.isFile() &&
        (entry.name.endsWith(".env") || entry.name.endsWith(".sh")) &&
        fs.readFileSync(p, "utf8").includes('CODEX_HOME="$HOME/.codex-community"')
      ) found.push(p);
    }
  }
  walk(root);
  assert.equal(found.length, 1);
  return found[0];
}

test("community environment keeps bare codex inside the Community distribution", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-community-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, "home");
  const app = path.join(root, "community");
  const officialBin = path.join(root, "official-bin");
  const communityCodex = path.join(app, "resources", "codex");
  const officialCodex = path.join(officialBin, "codex");

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.dirname(communityCodex), { recursive: true });
  fs.mkdirSync(officialBin, { recursive: true });

  fs.writeFileSync(communityCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(officialCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const hook = findEnvHook(__dirname);
  const output = childProcess.execFileSync(
    "/bin/bash",
    [
      "-c",
      '. "$1"; command -v codex; printf "%s\\n" "$CODEX_HOME"; printf "%s\\n" "$PATH"',
      "_",
      hook,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: home,
        CODEX_LINUX_APP_DIR: app,
        PATH: `${officialBin}:/usr/bin:/bin`,
      },
    },
  ).trim().split("\n");

  assert.equal(output[0], communityCodex);
  assert.equal(output[1], path.join(home, ".codex-community"));
  assert.equal(output[2].split(":")[0], path.join(app, "resources"));
});
