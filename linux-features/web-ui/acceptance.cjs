"use strict";

// Optional Linux browser acceptance driver. Playwright is a development tool,
// never a feature resource or an application/package runtime dependency.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require(process.env.CODEX_WEB_UI_PLAYWRIGHT_PATH || "playwright");

function connectionUrl(logPath) {
  if (!logPath) throw Error("Set CODEX_WEB_UI_TEST_LOG to the private host log path");
  const url = [...fs.readFileSync(logPath, "utf8").matchAll(/ChatGPT Community Web UI: (http:\/\/[^\s]+)/g)].at(-1)?.[1];
  if (!url) throw Error("Host has not printed its readiness URL");
  return url;
}

// page.waitForFunction re-evaluates its predicate in the page with eval while
// polling, which upstream's CSP blocks; page.evaluate goes through the
// DevTools protocol instead.
async function poll(page, predicate, timeoutMs = 30_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 100))) {
    // A navigation (e.g. the fragment-triggered reload) destroys the context
    // mid-evaluation; keep polling the new document.
    if (await page.evaluate(predicate).catch(() => false)) return;
  }
  throw Error("Timed out waiting for the page");
}

async function installRpc(page) {
  await page.evaluate(() => {
    window.communityTestRpc = (method, params) => new Promise((resolve, reject) => {
      const id = "community-acceptance-" + crypto.randomUUID();
      const finish = () => { clearTimeout(timer); window.removeEventListener("message", listener); };
      const timer = setTimeout(() => { finish(); reject(Error("RPC timed out: " + method)); }, 20_000);
      const listener = event => {
        if (event.data?.type !== "mcp-response" || event.data.message?.id !== id) return;
        finish();
        if (event.data.message.error) reject(Error("Upstream RPC failed: " + method));
        else resolve(event.data.message.result);
      };
      window.addEventListener("message", listener);
      electronBridge.sendMessageFromView({ type: "mcp-request", hostId: "local", request: { id, method, params } }).catch(error => { finish(); reject(error); });
    });
  });
}

async function run() {
  const url = connectionUrl(process.env.CODEX_WEB_UI_TEST_LOG), origin = new URL(url).origin;
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get("cap");
  assert.ok(token, "connection URL carries the capability in its fragment");
  const fixture = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "web-ui-browser-"));
  fs.mkdirSync(path.join(fixture, "subfolder"));
  fs.writeFileSync(path.join(fixture, "file.txt"), "community-web-ui-file\n");
  // One second of 8 kHz 8-bit silence.
  const samples = Buffer.alloc(8000, 128), header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write("data", 36); header.writeUInt32LE(samples.length, 40);
  fs.writeFileSync(path.join(fixture, "tone.wav"), Buffer.concat([header, samples]));
  fs.writeFileSync(path.join(fixture, "pixel #1.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const destination = http.createServer((_request, response) => response.end("community-external-link-ok"));
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await fetch(origin + "/_community/bootstrap")).status, 403);
    if (process.env.CODEX_WEB_UI_TEST_PREVIOUS_LOG) {
      const previous = new URLSearchParams(new URL(connectionUrl(process.env.CODEX_WEB_UI_TEST_PREVIOUS_LOG)).hash.slice(1)).get("cap");
      assert.equal((await fetch(origin + "/_community/bootstrap", { headers: { Authorization: `Bearer ${previous}` } })).status, 403);
    }
    // Without the fragment (or with a stale one) the adapter stops the page
    // before upstream loads and explains what to open.
    const anonymous = await browser.newContext();
    const blocked = await anonymous.newPage();
    await blocked.goto(origin, { waitUntil: "commit" }); // window.stop() ends loading before "load"
    await blocked.getByRole("alert").filter({ hasText: "Open the complete connection URL" }).waitFor();
    assert.equal(await blocked.evaluate(() => typeof window.electronBridge), "undefined");
    // A fresh page: a fragment-only change would not reload the document.
    const stale = await anonymous.newPage();
    await stale.goto(origin + "/#cap=stale-capability", { waitUntil: "commit" });
    await stale.getByRole("alert").filter({ hasText: "no longer valid" }).waitFor();
    await anonymous.close();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await poll(page, () => window.electronBridge?.communityWebUi === true);
    assert.equal(await page.title(), "ChatGPT Community");
    assert.equal(new URL(page.url()).hash, "", "the fragment is removed from the address bar and history");
    assert.deepEqual(await context.cookies(), [], "no cookie: browsers never attach the capability on their own");
    // Cross-port isolation: an untrusted service on another port of the same
    // hostname gets nothing it can replay, and its page cannot read the token.
    const leaked = [];
    const attacker = http.createServer((request, response) => {
      leaked.push(request.headers);
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>other service</title>");
    });
    await new Promise(resolve => attacker.listen(0, "127.0.0.1", resolve));
    try {
      const other = await context.newPage();
      await other.goto(`http://${new URL(origin).hostname}:${attacker.address().port}/`);
      const seen = await other.evaluate(async bridge => {
        const stored = Object.keys(localStorage).map(key => localStorage.getItem(key));
        const socket = await new Promise(resolve => {
          const ws = new WebSocket(bridge);
          ws.onopen = () => { ws.close(); resolve("open"); };
          ws.onerror = () => resolve("refused");
        });
        return { stored, cookie: document.cookie, socket };
      }, origin.replace(/^http/, "ws") + "/_community/bridge");
      await other.close();
      assert.deepEqual(seen.stored, []);
      assert.equal(seen.cookie, "");
      assert.equal(seen.socket, "refused");
      assert.ok(leaked.length > 0 && !JSON.stringify(leaked).includes(token), "the capability never reaches another port");
      for (const headers of leaked) {
        const replay = { ...headers, host: new URL(origin).host, origin };
        delete replay.connection;
        assert.equal((await fetch(origin + "/_community/bootstrap", { headers: replay })).status, 403);
      }
    } finally {
      await new Promise(resolve => attacker.close(resolve));
    }
    await installRpc(page);
    const account = await page.evaluate(() => communityTestRpc("account/read", { refreshToken: false }));
    assert.equal(typeof account.requiresOpenaiAuth, "boolean");
    const browserError = await page.evaluate(() => electronBridge.sendMessageFromView({ type: "browser-sidebar-command", command: { type: "navigate", url: "about:blank" } }).then(() => null, error => error.message));
    assert.equal(browserError, "The embedded browser is disabled in Web UI.");
    const file = await page.evaluate(filePath => communityTestRpc("fs/readFile", { path: filePath }), path.join(fixture, "file.txt"));
    assert.equal(Buffer.from(file.dataBase64, "base64").toString(), "community-web-ui-file\n");
    const command = await page.evaluate(cwd => communityTestRpc("command/exec", { command: ["/bin/echo", "community-web-ui-command"], cwd, timeoutMs: 5000 }), fixture);
    assert.equal(command.exitCode, 0);
    assert.equal(command.stdout.trim(), "community-web-ui-command");
    // Reproduce the upstream project modal's pointer-event restriction. A
    // chooser appended outside it silently ignores real pointer clicks.
    await page.evaluate(() => {
      const modal = document.createElement("div");
      modal.id = "community-test-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("data-state", "open");
      modal.style.cssText = "position:fixed;inset:100px;pointer-events:auto";
      document.body.style.pointerEvents = "none";
      document.body.append(modal);
    });
    const selection = page.evaluate(() => new Promise(resolve => {
      const listener = event => {
        if (event.data?.type === "workspace-root-option-picked") { window.removeEventListener("message", listener); resolve(event.data.root); }
      };
      window.addEventListener("message", listener);
      electronBridge.sendMessageFromView({ type: "electron-pick-workspace-root-option", allowMultiple: false });
    }));
    await page.getByRole("textbox", { name: "Host folder path" }).fill(fixture);
    assert.equal(await page.getByRole("dialog", { name: "Choose a folder on the host computer" }).evaluate(dialog => dialog.parentElement.id), "community-test-modal");
    await page.getByRole("button", { name: "Open path", exact: true }).click();
    await page.getByRole("button", { name: "subfolder", exact: true }).click();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    assert.equal(await selection, path.join(fixture, "subfolder"));
    // Upstream's modal can unmount the chooser (Escape) without a cancel event;
    // the next pick must still open a chooser.
    page.evaluate(() => electronBridge.sendMessageFromView({ type: "electron-pick-workspace-root-option", allowMultiple: false }));
    const chooser = page.getByRole("dialog", { name: "Choose a folder on the host computer" });
    await chooser.waitFor();
    await chooser.evaluate(dialog => dialog.remove());
    // Open Folder… / Ctrl+O uses the browser chooser, not a native host dialog.
    const added = page.evaluate(() => electronBridge.sendMessageFromView({ type: "electron-add-new-workspace-root-option" }).then(() => "settled"));
    await chooser.waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await added, "settled");
    // Use native link navigation during the gesture, without the desktop
    // opener/dialog round trip. Exercise upstream-style delegated interception
    // as well as buttons that invoke the bridge synchronously.
    const externalUrl = `http://127.0.0.1:${destination.address().port}/`;
    await page.evaluate(url => {
      const parent = document.getElementById("community-test-modal");
      const link = document.createElement("a"); link.href = url; link.textContent = "Direct external test";
      const button = document.createElement("button"); button.textContent = "Bridge external test";
      button.onclick = () => electronBridge.sendMessageFromView({ type: "open-in-browser", url, openTarget: "external-browser" });
      parent.append(link, button);
      window.communityExternalIntercepts = 0;
      document.addEventListener("click", event => {
        if (event.target.closest?.("a") === link) { event.preventDefault(); window.communityExternalIntercepts++; }
      });
    }, externalUrl);
    const externalLink = page.getByRole("link", { name: "Direct external test", exact: true });
    for (const action of [() => externalLink.click(), () => externalLink.press("Enter"), () => page.getByRole("button", { name: "Bridge external test", exact: true }).click()]) {
      const popupReady = page.waitForEvent("popup");
      await action();
      const popup = await popupReady;
      await popup.waitForURL(externalUrl);
      assert.equal(await popup.locator("body").innerText(), "community-external-link-ok");
      assert.equal(await popup.evaluate(() => window.opener), null);
      await popup.close();
      assert.equal(await page.locator("#community-external-link").count(), 0);
    }
    assert.equal(await externalLink.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await page.evaluate(() => window.communityExternalIntercepts), 0);
    await page.evaluate(() => { document.getElementById("community-test-modal").remove(); document.body.style.pointerEvents = ""; });
    // Host-local previews in upstream's two URL forms render through the adapter.
    const imagePath = encodeURI(path.join(fixture, "pixel #1.png")).replaceAll("#", "%23").replaceAll("?", "%3F");
    await page.evaluate(encoded => {
      for (const [id, src] of [["community-app-fs", `app://fs/@fs${encoded}`], ["community-fs", `/@fs${encoded}`]]) {
        const image = document.createElement("img"); image.id = id; image.src = src; document.body.append(image);
      }
    }, imagePath);
    await poll(page, () => ["community-app-fs", "community-fs"].every(id => {
      const image = document.getElementById(id);
      return image.src.startsWith("blob:") && image.complete && image.naturalWidth === 1;
    }));
    await page.evaluate(() => { document.getElementById("community-app-fs").remove(); document.getElementById("community-fs").remove(); });
    // A renderer source change during a pending load wins over the stale load.
    await page.evaluate(async encoded => {
      const image = document.createElement("img"); image.id = "community-replaced"; image.src = `app://fs/@fs${encoded}`;
      document.body.append(image);
      await Promise.resolve(); // let the adapter start its fetch
      image.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==#renderer";
    }, imagePath);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.ok((await page.evaluate(() => document.getElementById("community-replaced").getAttribute("src"))).endsWith("#renderer"));
    // Host-local audio/video (direct src and <source> children) play from
    // retained blob URLs.
    const audioPath = encodeURI(path.join(fixture, "tone.wav"));
    await page.evaluate(encoded => {
      const video = document.createElement("video"); video.id = "community-video"; video.src = `app://fs/@fs${encoded}`;
      const audio = document.createElement("audio"); audio.id = "community-audio";
      const source = document.createElement("source"); source.src = `/@fs${encoded}`; audio.append(source);
      document.body.append(video, audio);
    }, audioPath);
    await poll(page, () => ["community-video", "community-audio"].every(id => {
      const media = document.getElementById(id);
      return media.currentSrc.startsWith("blob:") && media.readyState >= 1 && Math.abs(media.duration - 1) < 0.1;
    }));
    await page.evaluate(() => { document.getElementById("community-video").remove(); document.getElementById("community-audio").remove(); });
    // An overwritten host file shows its new content when previewed again.
    fs.writeFileSync(path.join(fixture, "pixel #1.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64"));
    await page.evaluate(encoded => {
      const image = document.createElement("img"); image.id = "community-updated"; image.src = `/@fs${encoded}`; document.body.append(image);
    }, imagePath);
    await poll(page, () => { const image = document.getElementById("community-updated"); return image.complete && image.naturalWidth === 2; });
    await page.evaluate(() => { document.getElementById("community-replaced").remove(); document.getElementById("community-updated").remove(); });
    const second = await context.newPage();
    await second.goto(origin);
    await second.getByRole("alert").filter({ hasText: "One browser session is already connected" }).waitFor();
    await second.close();
    await page.reload();
    await installRpc(page);
    assert.equal(typeof (await page.evaluate(() => communityTestRpc("account/read", { refreshToken: false }))).requiresOpenaiAuth, "boolean");
    if (process.env.CODEX_WEB_UI_TEST_SCREENSHOT) await page.screenshot({ path: process.env.CODEX_WEB_UI_TEST_SCREENSHOT });
    assert.deepEqual(errors, []);
    // Last, because it takes the single browser session: opening the current
    // URL in a tab blocked by a stale link (a fragment-only change) recovers.
    const recovery = await browser.newContext();
    const reopened = await recovery.newPage();
    await reopened.goto(origin + "/#cap=stale-capability", { waitUntil: "commit" });
    await reopened.getByRole("alert").filter({ hasText: "no longer valid" }).waitFor();
    await reopened.evaluate(next => { location.hash = next; }, new URL(url).hash);
    await poll(reopened, () => window.electronBridge?.communityWebUi === true);
    assert.equal(new URL(reopened.url()).hash, "");
    await recovery.close();
    console.log("PASS: fragment capability, cross-port isolation, unauthenticated stop page, host-local image/audio/video previews, browser bootstrap, IPC/RPC, embedded-browser rejection, host file read, sandboxed command, modal folder selection, external-link popup, single-session gate, and reload");
  } finally {
    await browser.close();
    await new Promise(resolve => destination.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

run().catch(() => {
  // Do not include capability URLs, account responses, or private paths in logs.
  console.error("Web UI browser acceptance failed. Inspect the private host log and rerun the failing workflow.");
  process.exitCode = 1;
});
