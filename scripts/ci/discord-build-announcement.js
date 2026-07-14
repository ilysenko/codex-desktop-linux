"use strict";

const DISCORD_DESCRIPTION_LIMIT = 4096;
const DMG_MARKER_PATTERN = /<!--\s*upstream-dmg-sha256:([a-f0-9]{64})\s*-->/i;
const BUILD_TITLE_PATTERN = /^Fix upstream DMG drift for (\d+(?:\.\d+)+)$/;

function stripHtmlComments(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n(?:[ \t]*\n){2,}/g, "\n\n")
    .trim();
}

function extractSummary(body) {
  const content = String(body || "");
  const summaryHeading = /^##\s+Summary\s*$/im.exec(content);
  if (!summaryHeading) return stripHtmlComments(content);

  const afterHeading = content.slice(summaryHeading.index + summaryHeading[0].length);
  const nextHeading = /^##\s+/m.exec(afterHeading);
  return stripHtmlComments(nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading);
}

function buildAnnouncement(pullRequest, repository) {
  if (!pullRequest || pullRequest.merged !== true || pullRequest.base?.ref !== "main") return null;
  if (pullRequest.head?.repo?.full_name !== repository) return null;

  const titleMatch = BUILD_TITLE_PATTERN.exec(String(pullRequest.title || ""));
  const markerMatch = DMG_MARKER_PATTERN.exec(String(pullRequest.body || ""));
  if (!titleMatch || !markerMatch) return null;

  const dmgSha256 = markerMatch[1].toLowerCase();
  if (pullRequest.head?.ref !== `codex/upstream-dmg-${dmgSha256.slice(0, 12)}`) return null;

  return {
    dmgSha256,
    mergedAt: pullRequest.merged_at,
    number: pullRequest.number,
    summary: extractSummary(pullRequest.body) || "Linux compatibility has been updated for the latest upstream build.",
    title: pullRequest.title,
    url: pullRequest.html_url,
    version: titleMatch[1],
  };
}

function truncate(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function buildDiscordPayload(announcement) {
  return {
    content: "A new ChatGPT Desktop for Linux build is available.",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: announcement.title,
      url: announcement.url,
      description: truncate(announcement.summary, DISCORD_DESCRIPTION_LIMIT),
      color: 0x57f287,
      fields: [
        { name: "Version", value: `\`${announcement.version}\``, inline: true },
        { name: "Pull request", value: `[#${announcement.number}](${announcement.url})`, inline: true },
        { name: "DMG SHA-256", value: `\`${announcement.dmgSha256.slice(0, 12)}...\``, inline: true },
      ],
      footer: { text: "ChatGPT Desktop for Linux" },
      timestamp: announcement.mergedAt,
    }],
  };
}

function normalizedWebhookUrl(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  if (url.protocol !== "https:" || url.hostname !== "discord.com" || !url.pathname.startsWith("/api/webhooks/")) {
    throw new Error("DISCORD_BUILD_ANNOUNCEMENTS_WEBHOOK_URL must be a discord.com webhook URL");
  }
  url.searchParams.set("wait", "true");
  return url;
}

async function announceMergedBuild({ context, core, webhookUrl, fetchImpl = globalThis.fetch }) {
  const announcement = buildAnnouncement(context.payload.pull_request, `${context.repo.owner}/${context.repo.repo}`);
  if (!announcement) {
    core.info("Pull request is not a canonical upstream DMG build campaign; skipping Discord announcement.");
    return { action: "skipped" };
  }

  const response = await fetchImpl(normalizedWebhookUrl(webhookUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildDiscordPayload(announcement)),
  });
  if (!response.ok) {
    const responseBody = truncate(await response.text(), 500);
    throw new Error(`Discord webhook returned HTTP ${response.status}: ${responseBody}`);
  }

  core.info(`Announced upstream build ${announcement.version} from PR #${announcement.number}.`);
  return { action: "announced", announcement };
}

module.exports = {
  announceMergedBuild,
  buildAnnouncement,
  buildDiscordPayload,
  extractSummary,
  normalizedWebhookUrl,
};
