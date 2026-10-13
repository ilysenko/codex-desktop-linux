"use strict";

// Opt-in authenticated acceptance test. Supply a generated speech WAV, never a
// personal recording. It uses Chromium's fake microphone and only fills drafts;
// no agent/chat message is sent. Run against an isolated signed Web UI install.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require(process.env.CODEX_WEB_UI_PLAYWRIGHT_PATH || "playwright");

async function run() {
  const audio = process.env.CODEX_WEB_UI_TEST_AUDIO;
  if (!audio || !fs.existsSync(audio)) throw Error("Set CODEX_WEB_UI_TEST_AUDIO to a generated speech WAV");
  const log = process.env.CODEX_WEB_UI_TEST_LOG;
  if (!log) throw Error("Set CODEX_WEB_UI_TEST_LOG to the private host log");
  const url = [...fs.readFileSync(log, "utf8").matchAll(/ChatGPT Community Web UI: (http:\/\/[^\s]+)/g)].at(-1)?.[1];
  if (!url) throw Error("Host readiness URL is unavailable");
  const expected = process.env.CODEX_WEB_UI_TEST_TRANSCRIPT || "purple robot";
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: [
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audio}`,
  ] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["microphone"] });
    await context.addInitScript(() => {
      const Recorder = window.MediaRecorder;
      window.communityTestRecordings = 0;
      window.MediaRecorder = class extends Recorder {
        start(...args) { window.communityTestRecordings++; return super.start(...args); }
      };
    });
    const page = await context.newPage();
    // Inject one local upload failure at the browser-header boundary, without
    // changing package files or sending invalid requests to the cloud service.
    await page.route("**/assets/chatgpt-request-*.js", async route => {
      const response = await route.fetch();
      let source = await response.text();
      const match = source.match(/([\w$]+) as getChatGPTRequestHeaders/);
      assert.ok(match, "upstream request-header export");
      source = source.replace(match[0], "communityTestHeaders as getChatGPTRequestHeaders") +
        `\nfunction communityTestHeaders(...args){if(args[0]==='/transcribe'&&window.communityTestFailUpload){window.communityTestFailUpload=false;throw Error('Injected dictation upload failure')}return ${match[1]}(...args)}\n`;
      await route.fulfill({ response, body: source });
    });
    await page.goto(url);
    await page.getByRole("button", { name: /Switch mode, current mode:/ }).waitFor({ timeout: 45_000 });
    async function mode(name) {
      const other = name === "Codex" ? "ChatGPT" : "Codex";
      const button = page.getByRole("button", { name: `Switch mode, current mode: ${other}` });
      if (await button.count()) {
        await button.click();
        await page.getByRole("menuitem", { name: name === "Codex" ? "Codex Build, debug, and ship" : "ChatGPT Create, learn, and explore" }).click();
      }
      if (name === "Codex") await page.getByRole("button", { name: "Dictate", exact: true }).waitFor({ timeout: 45_000 });
    }
    const draft = () => page.locator('[contenteditable="true"]:visible,textarea:visible').first();
    const text = () => draft().evaluate(element => element.value ?? element.innerText);
    async function clearDraft() { await draft().fill(""); assert.equal((await text()).trim(), ""); }
    async function record() {
      await page.getByRole("button", { name: "Dictate", exact: true }).click();
      await page.getByRole("button", { name: "Stop dictation", exact: true }).waitFor();
      await page.waitForTimeout(8_000); // Allow the generated speech to play.
      await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
    }
    async function transcript() {
      await page.waitForFunction(expected => [...document.querySelectorAll('[contenteditable="true"],textarea')]
        .some(element => (element.value ?? element.innerText).toLowerCase().includes(expected.toLowerCase())), expected, { timeout: 90_000 });
      assert.ok((await text()).toLowerCase().includes(expected.toLowerCase()), "generated speech appears in draft");
      assert.equal(await page.getByText("Dictation stopped", { exact: true }).count(), 0);
    }
    await mode("Codex");
    await clearDraft();
    await record();
    await transcript();
    console.log("PASS: Codex recording transcribed into the draft");
    await clearDraft();
    await page.evaluate(() => { window.communityTestFailUpload = true; });
    await record();
    await page.getByText("Dictation stopped", { exact: true }).waitFor({ timeout: 45_000 });
    assert.equal(await page.evaluate(() => window.communityTestFailUpload), false, "failure injection was exercised");
    assert.equal((await text()).trim(), "", "failed upload did not insert text");
    const captures = await page.evaluate(() => window.communityTestRecordings);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await transcript();
    assert.equal(await page.evaluate(() => window.communityTestRecordings), captures, "Retry reuses recorded audio");
    if (process.env.CODEX_WEB_UI_TEST_SCREENSHOT) await draft().locator("..").screenshot({ path: process.env.CODEX_WEB_UI_TEST_SCREENSHOT });
    console.log("PASS: retained-audio Retry transcribed without another capture");
    await clearDraft();
    if (process.env.CODEX_WEB_UI_TEST_WORK === "1") {
      await mode("ChatGPT");
      await page.getByRole("button", { name: "New chat", exact: true }).first().click();
      await clearDraft();
      await page.getByRole("button", { name: "Dictate", exact: true }).waitFor({ timeout: 45_000 });
      await record();
      await transcript();
      console.log("PASS: Work recording transcribed into the draft");
      await clearDraft();
    }
    console.log("PASS: authenticated dictation acceptance (no messages sent)");
  } finally { await browser.close(); }
}
// Playwright errors embed the navigated URL; never print the live capability.
run().catch(error => { console.error(String(error?.message ?? error).replace(/([?&#]cap=)[\w-]+/g, "$1REDACTED")); process.exitCode = 1; });
