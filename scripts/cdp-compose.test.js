const assert = require("node:assert/strict");
const test = require("node:test");

const {
  chooseSendButton,
  parseArgs,
  sanitizeResult,
} = require("./cdp-compose.js");

test("parseArgs defaults to localhost CDP port and sanitized JSON output", () => {
  const parsed = parseArgs(["--text", "hello"]);

  assert.equal(parsed.port, 9333);
  assert.equal(parsed.text, "hello");
  assert.equal(parsed.checkOnly, false);
  assert.equal(parsed.json, true);
  assert.equal(parsed.timeoutMs, 20000);
});

test("parseArgs supports check-only mode without text", () => {
  const parsed = parseArgs(["--check", "--port", "9444", "--timeout-ms", "5000"]);

  assert.equal(parsed.port, 9444);
  assert.equal(parsed.text, "");
  assert.equal(parsed.checkOnly, true);
  assert.equal(parsed.timeoutMs, 5000);
});

test("parseArgs rejects invalid CDP ports", () => {
  assert.throws(
    () => parseArgs(["--port", "70000", "--text", "hello"]),
    /--port must be between 1 and 65535/,
  );
});

test("chooseSendButton prefers labelled send controls", () => {
  const button = chooseSendButton(
    [
      { index: 1, visible: true, disabled: false, x: 10, y: 10, w: 20, h: 20, label: "settings" },
      { index: 2, visible: true, disabled: false, x: 200, y: 400, w: 30, h: 30, label: "send message" },
    ],
    { width: 300, height: 500 },
  );

  assert.equal(button.index, 2);
});

test("chooseSendButton falls back to compact bottom-right composer control", () => {
  const button = chooseSendButton(
    [
      { index: 1, visible: true, disabled: false, x: 12, y: 12, w: 30, h: 30, label: "" },
      { index: 2, visible: true, disabled: false, x: 760, y: 620, w: 28, h: 28, label: "" },
    ],
    { width: 853, height: 700 },
  );

  assert.equal(button.index, 2);
});

test("chooseSendButton uses the rightmost compact composer control when icons are unlabelled", () => {
  const button = chooseSendButton(
    [
      { index: 1, visible: true, disabled: false, x: 761, y: 607, w: 28, h: 28, label: "" },
      { index: 2, visible: true, disabled: false, x: 797, y: 607, w: 28, h: 28, label: "" },
    ],
    { width: 853, height: 700 },
  );

  assert.equal(button.index, 2);
});

test("sanitizeResult never includes prompt text, websocket URLs, or DOM text", () => {
  const sanitized = sanitizeResult({
    ok: true,
    text: "private prompt",
    domText: "private DOM",
    error: "failed ws://127.0.0.1:9333/devtools/page/private with private prompt",
    webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/private",
    port: 9333,
    textLength: 14,
    composerFound: true,
    sendButtonFound: true,
    clicked: true,
    composerCleared: true,
  });

  assert.deepEqual(sanitized, {
    ok: true,
    port: 9333,
    textLength: 14,
    composerFound: true,
    sendButtonFound: true,
    clicked: true,
    composerCleared: true,
    error: "failed [redacted] with [redacted]",
  });
  assert.equal(JSON.stringify(sanitized).includes("private"), false);
  assert.equal(JSON.stringify(sanitized).includes("ws://"), false);
});
