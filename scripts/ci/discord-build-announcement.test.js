"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  announceMergedBuild,
  buildDiscordPayload,
  buildAnnouncement,
  extractSummary,
  normalizedWebhookUrl,
} = require("./discord-build-announcement.js");

const DMG_SHA = "40e34814e74e30943c209ebd4da94cd4de3581a52c5bffbe2bcf2e488d6361c6";

function pullRequest(overrides = {}) {
  return {
    merged: true,
    merged_at: "2026-07-14T15:47:25Z",
    number: 975,
    title: "Fix upstream DMG drift for 26.707.72221",
    body: `<!-- upstream-dmg-sha256:${DMG_SHA} -->

## Summary
- repair Linux compatibility drift for the current upstream DMG
- remove obsolete compatibility paths replaced by the current DMG shape

## Validation
- exact current-DMG acceptance recorded by the watchdog`,
    html_url: "https://github.com/ilysenko/codex-desktop-linux/pull/975",
    base: { ref: "main" },
    head: {
      ref: `codex/upstream-dmg-${DMG_SHA.slice(0, 12)}`,
      repo: { full_name: "ilysenko/codex-desktop-linux" },
    },
    ...overrides,
  };
}

test("builds an announcement for a merged canonical upstream DMG repair", () => {
  assert.deepEqual(
    buildAnnouncement(pullRequest(), "ilysenko/codex-desktop-linux"),
    {
      dmgSha256: DMG_SHA,
      mergedAt: "2026-07-14T15:47:25Z",
      number: 975,
      summary: [
        "- repair Linux compatibility drift for the current upstream DMG",
        "- remove obsolete compatibility paths replaced by the current DMG shape",
      ].join("\n"),
      title: "Fix upstream DMG drift for 26.707.72221",
      url: "https://github.com/ilysenko/codex-desktop-linux/pull/975",
      version: "26.707.72221",
    },
  );
});

test("rejects events that do not prove a canonical internal build campaign", () => {
  const invalid = [
    pullRequest({ merged: false }),
    pullRequest({ base: { ref: "release" } }),
    pullRequest({ title: "Fix feature drift for current upstream DMG" }),
    pullRequest({ head: { ref: `codex/upstream-dmg-${DMG_SHA.slice(0, 12)}`, repo: { full_name: "fork/repo" } } }),
    pullRequest({ head: { ref: "fix/unrelated", repo: { full_name: "ilysenko/codex-desktop-linux" } } }),
    pullRequest({ body: "## Summary\n- no fingerprint" }),
    pullRequest({ head: { ref: "codex/upstream-dmg-aaaaaaaaaaaa", repo: { full_name: "ilysenko/codex-desktop-linux" } } }),
  ];

  for (const candidate of invalid) {
    assert.equal(buildAnnouncement(candidate, "ilysenko/codex-desktop-linux"), null);
  }
});

test("extractSummary removes automation comments and excludes later sections", () => {
  assert.equal(
    extractSummary(`<!-- hidden -->
## Summary
User-facing line.

<!-- another hidden comment -->
- Safe @everyone text.

## Tests
- private implementation detail`),
    "User-facing line.\n\n- Safe @everyone text.",
  );
});

test("buildDiscordPayload creates a bounded embed with mentions disabled", () => {
  const announcement = buildAnnouncement(pullRequest(), "ilysenko/codex-desktop-linux");
  const payload = buildDiscordPayload(announcement);

  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.content, "A new ChatGPT Desktop for Linux build is available.");
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, announcement.title);
  assert.equal(payload.embeds[0].url, announcement.url);
  assert.equal(payload.embeds[0].description, announcement.summary);
  assert.equal(payload.embeds[0].timestamp, announcement.mergedAt);
  assert.ok(payload.embeds[0].description.length <= 4096);
  assert.deepEqual(payload.embeds[0].fields, [
    { name: "Version", value: "`26.707.72221`", inline: true },
    { name: "Pull request", value: "[#975](https://github.com/ilysenko/codex-desktop-linux/pull/975)", inline: true },
    { name: "DMG SHA-256", value: "`40e34814e74e...`", inline: true },
  ]);
});

test("buildDiscordPayload truncates oversized summaries without splitting the limit", () => {
  const payload = buildDiscordPayload({
    ...buildAnnouncement(pullRequest(), "ilysenko/codex-desktop-linux"),
    summary: "x".repeat(5000),
  });

  assert.equal(payload.embeds[0].description.length, 4096);
  assert.match(payload.embeds[0].description, /\.\.\.$/);
});

test("normalizedWebhookUrl accepts only Discord HTTPS webhook URLs", () => {
  assert.equal(
    normalizedWebhookUrl("https://discord.com/api/webhooks/123/token").href,
    "https://discord.com/api/webhooks/123/token?wait=true",
  );
  assert.throws(
    () => normalizedWebhookUrl("https://example.test/api/webhooks/123/token"),
    /must be a discord\.com webhook URL/,
  );
});

test("announceMergedBuild posts the rendered payload", async () => {
  const calls = [];
  const messages = [];
  const context = {
    payload: { pull_request: pullRequest() },
    repo: { owner: "ilysenko", repo: "codex-desktop-linux" },
  };

  const result = await announceMergedBuild({
    context,
    core: { info: (message) => messages.push(message) },
    webhookUrl: "https://discord.com/api/webhooks/123/token",
    fetchImpl: async (url, options) => {
      calls.push({ url: url.href, options });
      return { ok: true, status: 200, text: async () => "" };
    },
  });

  assert.equal(result.action, "announced");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.com/api/webhooks/123/token?wait=true");
  assert.deepEqual(JSON.parse(calls[0].options.body), buildDiscordPayload(result.announcement));
  assert.match(messages[0], /26\.707\.72221/);
});

test("announceMergedBuild skips unrelated pull requests before reading the webhook", async () => {
  const result = await announceMergedBuild({
    context: {
      payload: { pull_request: pullRequest({ title: "Fix an unrelated bug" }) },
      repo: { owner: "ilysenko", repo: "codex-desktop-linux" },
    },
    core: { info: () => {} },
    webhookUrl: "",
    fetchImpl: async () => { throw new Error("unexpected request"); },
  });

  assert.deepEqual(result, { action: "skipped" });
});

test("announceMergedBuild fails when Discord rejects the message", async () => {
  await assert.rejects(
    announceMergedBuild({
      context: {
        payload: { pull_request: pullRequest() },
        repo: { owner: "ilysenko", repo: "codex-desktop-linux" },
      },
      core: { info: () => {} },
      webhookUrl: "https://discord.com/api/webhooks/123/token",
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => "rate limited" }),
    }),
    /HTTP 429: rate limited/,
  );
});

test("workflow reads only trusted default-branch code before using the webhook secret", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/discord-build-announcement.yml"),
    "utf8",
  );

  assert.match(workflow, /pull_request_target:\n\s+types: \[closed\]/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.sha/);
});
