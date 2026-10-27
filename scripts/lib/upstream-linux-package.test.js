"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  extractClearSignedPayload,
  mapMachineArch,
  parseReleaseSha256,
  selectChatgptPackage,
  resolveOfficialPackage,
  sha256File,
  verifyIndexedFile,
  verifyInRelease,
} = require("./upstream-linux-package.js");
const { makeDeb } = require("../../tests/lib/upstream-package-fixture.js");

function run(command, args, options = {}) {
  return childProcess.execFileSync(command, args, { encoding: "utf8", ...options });
}

function createSigningFixture(root, identity) {
  const home = path.join(root, identity.replace(/\W/g, "-"));
  fs.mkdirSync(home, { mode: 0o700 });
  run("gpg", [
    "--homedir", home,
    "--batch", "--pinentry-mode", "loopback", "--passphrase", "",
    "--quick-generate-key", identity, "rsa2048", "sign", "0",
  ]);
  const listing = run("gpg", ["--homedir", home, "--batch", "--with-colons", "--list-keys"]);
  const fingerprint = listing.split(/\r?\n/).find((line) => line.startsWith("fpr:"))?.split(":")[9];
  assert.match(fingerprint, /^[0-9A-F]{40}$/);
  const keyPath = path.join(root, `${identity.replace(/\W/g, "-")}.gpg`);
  childProcess.execFileSync("gpg", ["--homedir", home, "--batch", "--output", keyPath, "--export", fingerprint]);
  return { fingerprint, home, keyPath };
}

test("architecture mapping supports only official architectures", () => {
  assert.equal(mapMachineArch("x86_64"), "amd64");
  assert.equal(mapMachineArch("aarch64"), "arm64");
  assert.throws(() => mapMachineArch("armv7l"), /Unsupported architecture/);
});

test("signed Release SHA256 and Packages metadata are parsed strictly", () => {
  const payload = [
    "Codename: stable",
    "SHA256:",
    ` ${"a".repeat(64)} 123 main/binary-amd64/Packages`,
    "SHA512:",
    ` ${"b".repeat(128)} 123 main/binary-amd64/Packages`,
  ].join("\n");
  assert.deepEqual(parseReleaseSha256(payload).get("main/binary-amd64/Packages"), {
    sha256: "a".repeat(64), size: 123,
  });

  const packages = [
    "Package: chatgpt",
    "Version: 26.803.81509",
    "Architecture: amd64",
    "Filename: pool/main/c/chatgpt/chatgpt_26.803.81509_amd64.deb",
    "Size: 42",
    `SHA256: ${"c".repeat(64)}`,
    "Depends: libgtk-3-0, libnss3",
  ].join("\n");
  assert.equal(selectChatgptPackage(packages, "amd64").version, "26.803.81509");
  assert.throws(() => selectChatgptPackage(packages, "arm64"), /found 0/);
  assert.throws(() => selectChatgptPackage(packages.replace("Package: chatgpt", "Package: other"), "amd64"), /found 0/);
  assert.throws(() => selectChatgptPackage(packages.replace("pool/main", "../escape"), "amd64"), /Unsafe/);
});

test("indexed file verification rejects size and SHA256 mismatches", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-index-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "Packages");
  fs.writeFileSync(filePath, "trusted bytes");
  assert.throws(() => verifyIndexedFile(filePath, { size: 1, sha256: "0".repeat(64) }, "Packages"), /size mismatch/);
  assert.throws(() => verifyIndexedFile(filePath, { size: 13, sha256: "0".repeat(64) }, "Packages"), /SHA256 mismatch/);
});

test("InRelease verification accepts the signing key and rejects tampering or a wrong key", { timeout: 30000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-inrelease-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signer = createSigningFixture(root, "Codex Fixture Signer");
  const wrong = createSigningFixture(root, "Wrong Fixture Signer");
  const releasePath = path.join(root, "Release");
  const inReleasePath = path.join(root, "InRelease");
  fs.writeFileSync(releasePath, `Codename: stable\nSHA256:\n ${"d".repeat(64)} 1 main/binary-amd64/Packages\n`);
  childProcess.execFileSync("gpg", [
    "--homedir", signer.home,
    "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase", "",
    "--output", inReleasePath, "--clearsign", releasePath,
  ]);

  const payload = verifyInRelease(inReleasePath, signer.keyPath, signer.fingerprint);
  assert.equal(parseReleaseSha256(payload).size, 1);
  assert.throws(() => verifyInRelease(inReleasePath, wrong.keyPath, signer.fingerprint), /expected fingerprint/);
  assert.throws(() => verifyInRelease(inReleasePath, wrong.keyPath, wrong.fingerprint), /signature verification failed/);

  const tamperedPath = path.join(root, "tampered-InRelease");
  fs.writeFileSync(tamperedPath, fs.readFileSync(inReleasePath, "utf8").replace("Codename: stable", "Codename: testing"));
  assert.throws(() => verifyInRelease(tamperedPath, signer.keyPath, signer.fingerprint), /signature verification failed/);
  assert.match(extractClearSignedPayload(fs.readFileSync(inReleasePath, "utf8")), /Codename: stable/);
});

test("signed resolution verifies local packages without downloading their bodies and fails closed", { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-signed-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signer = createSigningFixture(root, "Local Package Signer");
  const wrong = createSigningFixture(root, "Other Package Signer");
  const keyBase64Path = path.join(root, "key.base64");
  fs.writeFileSync(keyBase64Path, fs.readFileSync(signer.keyPath).toString("base64"));
  const cases = [
    { name: "local amd64" },
    { name: "local arm64", architecture: "arm64" },
    { name: "downloaded amd64", download: true },
    { name: "tampered signature", tamperSignature: true, error: /signature verification failed/ },
    { name: "wrong signer", wrongSigner: true, error: /signature verification failed/ },
    { name: "wrong pinned key", wrongKey: true, error: /expected fingerprint/ },
    { name: "unsigned index", unsigned: true, error: /signature verification failed/ },
    { name: "index hash mismatch", tamperIndex: true, error: /Packages.*SHA256 mismatch/ },
    { name: "local hash mismatch", tamperPackage: true, mismatch: true, error: /SHA256 mismatch/ },
    { name: "local size mismatch", tamperSize: true, mismatch: true, error: /size mismatch/ },
    { name: "wrong control package", packageName: "other", mismatch: true, error: /Package Package mismatch/ },
    { name: "wrong control version", version: "26.1020.1", mismatch: true, error: /Package Version mismatch/ },
    { name: "wrong control architecture", controlArchitecture: "arm64", mismatch: true, error: /Package Architecture mismatch/ },
    { name: "missing index architecture", missingArchitecture: true, error: /does not index/ },
    { name: "unsupported architecture", architecture: "armv7l", error: /Unsupported architecture/ },
    { name: "unavailable signed index", unavailable: true, error: /Download failed \(503\)/ },
    { name: "index network failure", networkFailure: true, error: /fixture network failure/ },
    { name: "remote package hash mismatch", download: true, tamperDownload: true, error: /SHA256 mismatch/ },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const current = fs.mkdtempSync(path.join(root, "case-"));
      const architecture = scenario.architecture ?? "amd64";
      const file = makeDeb(current, {
        packageName: scenario.packageName,
        version: scenario.version,
        architecture: scenario.controlArchitecture ?? architecture,
      });
      const body = fs.readFileSync(file);
      const packageRelative = "pool/main/c/chatgpt/input.deb";
      const packagesRelative = `main/binary-${architecture}/Packages`;
      const packages = Buffer.from([
        "Package: chatgpt", "Version: 26.1021.22027", `Architecture: ${architecture}`,
        `Filename: ${packageRelative}`, `Size: ${body.length}`, `SHA256: ${sha256File(file)}`, "",
      ].join("\n"));
      const packagesPath = path.join(current, "Packages");
      fs.writeFileSync(packagesPath, packages);
      const releasePath = path.join(current, "Release");
      fs.writeFileSync(releasePath, `Codename: stable\nSHA256:\n ${sha256File(packagesPath)} ${packages.length} ${scenario.missingArchitecture ? "other/Packages" : packagesRelative}\n`);
      const inReleasePath = path.join(current, "InRelease");
      childProcess.execFileSync("gpg", [
        "--homedir", scenario.wrongSigner ? wrong.home : signer.home,
        "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase", "",
        "--output", inReleasePath, "--clearsign", releasePath,
      ]);
      let inRelease = fs.readFileSync(inReleasePath, "utf8");
      if (scenario.tamperSignature) inRelease = inRelease.replace("Codename: stable", "Codename: changed");
      if (scenario.unsigned) inRelease = fs.readFileSync(releasePath, "utf8");
      if (scenario.tamperPackage) {
        const changed = Buffer.from(body); changed[changed.length - 1] ^= 1;
        fs.writeFileSync(file, changed);
      }
      if (scenario.tamperSize) fs.appendFileSync(file, "extra");
      const fixtureKey = scenario.wrongKey ? path.join(current, "wrong.base64") : keyBase64Path;
      if (scenario.wrongKey) fs.writeFileSync(fixtureKey, fs.readFileSync(wrong.keyPath).toString("base64"));
      const requested = [];
      const repository = "https://fixture.invalid";
      t.mock.method(globalThis, "fetch", async (url) => {
        requested.push(url);
        if (scenario.unavailable) return new Response("unavailable", { status: 503 });
        if (scenario.networkFailure) throw new TypeError("fixture network failure");
        if (url === `${repository}/dists/stable/InRelease`) return new Response(inRelease);
        if (url === `${repository}/dists/stable/${packagesRelative}`) {
          return new Response(scenario.tamperIndex ? packages.toString().replace("26.1021", "26.1022") : packages);
        }
        if (url === `${repository}/${packageRelative}`) {
          if (scenario.tamperDownload) {
            const changed = Buffer.from(body); changed[changed.length - 1] ^= 1;
            return new Response(changed);
          }
          return new Response(body);
        }
        throw Error(`Unexpected request: ${url}`);
      });
      const options = {
        architecture, repository, keyBase64Path: fixtureKey,
        outputDir: path.join(current, "verified"), metadataPath: path.join(current, "metadata.json"),
        ...(scenario.download ? {} : { localPackagePath: file }),
      };
      if (scenario.error) {
        await assert.rejects(resolveOfficialPackage(options, signer.fingerprint), (error) => {
          assert.match(error.message, scenario.error);
          if (scenario.download || architecture === "armv7l") {
            assert.doesNotMatch(error.message, /--skip-oai-official-sig-verification/);
          } else {
            assert.match(error.message, scenario.mismatch
              ? /Local package does not match the current signed stable release/
              : /Could not fetch or verify the signed stable index/);
            assert.match(error.message, /intentional unverified local build/);
            assert.match(error.message, /--skip-oai-official-sig-verification/);
            assert.ok(error.cause instanceof Error);
            assert.match(error.cause.message, scenario.error);
          }
          return true;
        });
        assert.equal(fs.existsSync(options.metadataPath), false);
      } else {
        const result = await resolveOfficialPackage(options, signer.fingerprint);
        assert.equal(result.signatureVerification, "verified");
        assert.equal(result.version, "26.1021.22027");
        assert.equal(result.architecture, architecture);
        assert.equal(result.sha256, sha256File(file));
        if (!scenario.download) {
          assert.equal(result.path, file);
          assert.equal(result.explicitlyProvided, true);
        }
      }
      assert.equal(requested.some(url => url.includes("/pool/")), scenario.download === true);
    });
  }
});

test("local-package CLI explains unavailable signed metadata and the explicit unverified option", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-verification-message-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = makeDeb(path.join(root, "package"));
  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    response.writeHead(503); response.end("fixture index unavailable");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const metadataPath = path.join(root, "metadata.json");
  const child = childProcess.spawn(process.execPath, [
    path.join(__dirname, "upstream-linux-package.js"),
    "--output-dir", path.join(root, "verified"), "--metadata", metadataPath,
    "--key-base64", path.resolve(__dirname, "../../assets/openai-codex-linux-repository-key.gpg.base64"),
    "--arch", "amd64", "--repository", `http://127.0.0.1:${server.address().port}`,
    "--local-package", file,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", data => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", data => { stderr += data; });
  const [status] = await once(child, "close");
  assert.equal(status, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /Could not fetch or verify the signed stable index/);
  assert.match(stderr, /Download failed \(503\)/);
  assert.match(stderr, /--skip-oai-official-sig-verification/);
  assert.match(stderr, /intentional unverified local build/);
  assert.deepEqual(requested, ["/dists/stable/InRelease"]);
  assert.equal(fs.existsSync(metadataPath), false);
});

test("local-package cannot be combined with metadata-only resolution", async () => {
  await assert.rejects(resolveOfficialPackage({
    architecture: "amd64", localPackagePath: "unused.deb", metadataOnly: true,
  }), /cannot be combined/);
});
