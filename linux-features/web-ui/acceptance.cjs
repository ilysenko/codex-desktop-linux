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
  const fixture = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "web-ui-browser-"));
  fs.mkdirSync(path.join(fixture, "subfolder"));
  fs.writeFileSync(path.join(fixture, "file.txt"), "community-web-ui-file\n");
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const destination = http.createServer((_request, response) => response.end("community-external-link-ok"));
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await fetch(origin + "/_community/bootstrap")).status, 403);
    if (process.env.CODEX_WEB_UI_TEST_PREVIOUS_LOG) {
      assert.equal((await fetch(connectionUrl(process.env.CODEX_WEB_UI_TEST_PREVIOUS_LOG), { redirect: "manual" })).status, 403);
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.electronBridge?.communityWebUi === true);
    assert.equal(await page.title(), "ChatGPT Community");
    assert.equal(new URL(page.url()).searchParams.has("cap"), false);
    const cookies = await context.cookies();
    assert.ok(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === "Strict"));
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
    const second = await context.newPage();
    await second.goto(origin);
    await second.getByRole("alert").filter({ hasText: "One browser session is already connected" }).waitFor();
    await second.close();
    await page.reload();
    await installRpc(page);
    assert.equal(typeof (await page.evaluate(() => communityTestRpc("account/read", { refreshToken: false }))).requiresOpenaiAuth, "boolean");
    if (process.env.CODEX_WEB_UI_TEST_SCREENSHOT) await page.screenshot({ path: process.env.CODEX_WEB_UI_TEST_SCREENSHOT });
    assert.deepEqual(errors, []);
    console.log("PASS: browser bootstrap, IPC/RPC, embedded-browser rejection, host file read, sandboxed command, modal folder selection, external-link popup, single-session gate, and reload");
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
