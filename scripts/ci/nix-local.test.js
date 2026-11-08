"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.resolve(__dirname, "../nix-local.sh");
const hasNix = spawnSync("nix", ["--version"]).status === 0;

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 30_000, ...options });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  return result.stdout;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nix-local-"));
  t.after(() => {
    // Nix canonicalizes imported store directories as read-only.
    command("chmod", ["-R", "u+w", root]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, "checkout with spaces #?% 中文");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(script, path.join(repo, "scripts/nix-local.sh"));
  fs.writeFileSync(path.join(repo, "flake.nix"), `{
    outputs = { self }: { trackedText = builtins.readFile ./tracked.txt; };
  }\n`);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\ntarget/\ncustom-cache/\n");
  const git = (...args) => command("git", ["-C", repo, ...args]);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Nix fixture", "-c", "user.email=nix-fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { root, repo, git };
}

function fakeNix(app) {
  const bin = path.join(app.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "nix"), '#!/bin/bash\nprintf "%s\\0" "$@"\nexit "${FAKE_NIX_STATUS:-0}"\n', { mode: 0o755 });
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

function run(app, args, env = process.env, repo = app.repo) {
  return spawnSync("bash", [path.join(repo, "scripts/nix-local.sh"), ...args], {
    cwd: app.root, env, encoding: "utf8", timeout: 30_000,
  });
}

test("local Nix commands always select the script's Git checkout and preserve arguments and status", t => {
  const app = fixture(t);
  const env = fakeNix(app);
  for (const args of [
    ["build", "#codex-desktop", "--no-link"],
    ["run", ".#installer", "--", "/directory with spaces"],
    ["develop", "--command", "bash"],
    ["eval", "#trackedText", "--raw"],
    ...["check", "show", "metadata", "archive", "lock"].map(subcommand => ["flake", subcommand, "--offline"]),
  ]) {
    const result = run(app, args, env);
    assert.equal(result.status, 0, result.stderr);
    const actual = result.stdout.split("\0").slice(0, -1);
    const commandLength = args[0] === "flake" ? 2 : 1;
    assert.deepEqual(actual.slice(0, commandLength), args.slice(0, commandLength));
    const rest = args.slice(commandLength);
    const output = /^[.#]/.test(rest[0]) ? rest.shift().replace(/^\./, "") : "";
    assert.equal(decodeURIComponent(actual[commandLength]), `git+file://${app.repo}${output}`);
    assert.deepEqual(actual.slice(commandLength + 1), rest);
  }
  assert.equal(run(app, ["build"], { ...env, FAKE_NIX_STATUS: "42" }).status, 42);
});

test("source archives and copies nested in another Git repository fail before invoking Nix", t => {
  const app = fixture(t);
  const env = fakeNix(app);
  for (const directory of [path.join(app.root, "archive"), path.join(app.repo, "nested-copy")]) {
    fs.mkdirSync(path.join(directory, "scripts"), { recursive: true });
    fs.copyFileSync(script, path.join(directory, "scripts/nix-local.sh"));
    const result = run(app, ["flake", "check"], env, directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Git (checkout|repository root)/);
    assert.equal(result.stdout, "", "Nix must not run or import the directory");
  }
  app.git("rm", "--cached", "flake.nix");
  const result = run(app, ["build"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /flake.nix must be tracked/);
  assert.equal(result.stdout, "");
});

test("unsupported commands and explicit path operands fail before invoking Nix", t => {
  const app = fixture(t);
  const env = fakeNix(app);
  for (const args of [["store", "add-path", app.repo], ["build", "path:."], ["flake", "check", "path:."]]) {
    const result = run(app, args, env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});

test("Nix imports only Git files before evaluation, including dirty edits and linked worktrees", { skip: !hasNix }, t => {
  const app = fixture(t);
  // Keep this test's Nix store and cache disposable. No nixpkgs download, app
  // build, global store garbage, or multi-gigabyte fixture is needed.
  const store = path.join(app.root, "store");
  const env = { ...process.env, XDG_CACHE_HOME: path.join(app.root, "cache") };
  const options = ["--offline", "--no-write-lock-file", "--store", store,
    "--extra-experimental-features", "nix-command flakes"];
  const worktree = path.join(app.root, "linked worktree #?% 中文");
  app.git("worktree", "add", "-q", "--detach", worktree, "HEAD");
  for (const repo of [app.repo, worktree]) {
    fs.writeFileSync(path.join(repo, "tracked.txt"), `working tree: ${repo}\n`);
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked source\n");
    for (const ignored of ["dist", "target", "custom-cache"]) {
      fs.mkdirSync(path.join(repo, ignored));
      fs.writeFileSync(path.join(repo, ignored, "must-not-be-imported"), "ignored payload\n");
    }
    const metadataResult = run(app, ["flake", "metadata", "--json", ...options], env, repo);
    assert.equal(metadataResult.status, 0, metadataResult.stderr);
    const metadata = JSON.parse(metadataResult.stdout);
    assert.equal(metadata.resolved.type, "git");
    // Recent Nix versions fetch Git trees lazily for metadata/evaluation;
    // archive also materializes the initial snapshot for an on-disk audit.
    const archive = run(app, ["flake", "archive", "--json", ...options], env, repo);
    assert.equal(archive.status, 0, archive.stderr);
    const imported = path.join(store, JSON.parse(archive.stdout).path);
    assert.equal(fs.readFileSync(path.join(imported, "tracked.txt"), "utf8"), `working tree: ${repo}\n`);
    for (const excluded of [".git", "dist", "target", "custom-cache", "untracked.txt"]) {
      assert.equal(fs.existsSync(path.join(imported, excluded)), false, `${excluded} entered the initial flake snapshot`);
    }
    const evaluation = run(app, ["eval", "#trackedText", "--raw", ...options], env, repo);
    assert.equal(evaluation.status, 0, evaluation.stderr);
    assert.equal(evaluation.stdout, `working tree: ${repo}\n`);
  }
});
