"use strict";

const DEFAULT_MAX_OPEN_PRS = 2;
const LIMIT_COMMENT_MARKER = "<!-- contributor-pr-limit -->";

function parsePositiveInteger(rawValue) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";

  if (/^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseMaxOpenPullRequests(rawValue, warn = () => {}) {
  const parsed = parsePositiveInteger(rawValue);
  if (parsed !== null) {
    return parsed;
  }

  warn(
    `MAX_OPEN_PRS_PER_CONTRIBUTOR must be a positive integer; using ${DEFAULT_MAX_OPEN_PRS}.`,
  );
  return DEFAULT_MAX_OPEN_PRS;
}

function parsePullRequestLimitOverrides(rawValue, warn = () => {}) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (value === "") {
    return new Map();
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    warn(`MAX_OPEN_PRS_PER_CONTRIBUTOR_OVERRIDES is not valid JSON; ignoring all overrides.`);
    return new Map();
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    warn(`MAX_OPEN_PRS_PER_CONTRIBUTOR_OVERRIDES must be a JSON object; ignoring all overrides.`);
    return new Map();
  }

  const overrides = new Map();
  for (const [username, configuredLimit] of Object.entries(parsed)) {
    const normalizedUsername = username.toLowerCase();
    const validUsername = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username);
    const validLimit = Number.isSafeInteger(configuredLimit) && configuredLimit >= 1;

    if (!validUsername || !validLimit) {
      warn(`Ignoring invalid pull request limit override for ${JSON.stringify(username)}.`);
      continue;
    }

    if (overrides.has(normalizedUsername)) {
      warn(`Ignoring duplicate pull request limit override for ${JSON.stringify(username)}.`);
      continue;
    }

    overrides.set(normalizedUsername, configuredLimit);
  }

  return overrides;
}

function resolvePullRequestLimit({ author, rawLimit, rawOverrides, warn = () => {} }) {
  const configuredGlobalLimit = parsePositiveInteger(rawLimit);
  const globalLimit = parseMaxOpenPullRequests(rawLimit, warn);
  const overrides = parsePullRequestLimitOverrides(rawOverrides, warn);
  const override = overrides.get(author.toLowerCase());

  if (override !== undefined) {
    return { limit: override, source: "personal override" };
  }

  return {
    limit: globalLimit,
    source: configuredGlobalLimit === null ? "fallback" : "global variable",
  };
}

function buildLimitComment(limit, count) {
  const activePullRequests = `${limit} active pull request${limit === 1 ? "" : "s"} per contributor`;
  const openPullRequests = `${count} open pull request${count === 1 ? "" : "s"}`;
  return `Thanks for contributing. This repository allows a maximum of **${activePullRequests}**. You currently have **${openPullRequests}**, so this pull request is being closed automatically. Please finish or close one of your existing pull requests before opening another.\n\n${LIMIT_COMMENT_MARKER}`;
}

async function ensureLimitComment({ body, context, github, pullNumber }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const alreadyCommented = comments.some(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      comment.body?.includes(LIMIT_COMMENT_MARKER),
  );

  if (!alreadyCommented) {
    await github.rest.issues.createComment({
      ...context.repo,
      issue_number: pullNumber,
      body,
    });
  }
}

function selectPullRequestsToClose({ action, currentNumber, limit, openPullRequests }) {
  if (openPullRequests.length <= limit) {
    return [];
  }

  const sortedPullRequests = [...openPullRequests].sort(
    (left, right) => left.number - right.number,
  );

  if (action === "reopened") {
    const retainedNumbers = sortedPullRequests
      .filter((pullRequest) => pullRequest.number !== currentNumber)
      .slice(0, limit)
      .map((pullRequest) => pullRequest.number);

    return sortedPullRequests.filter(
      (pullRequest) =>
        pullRequest.number === currentNumber || !retainedNumbers.includes(pullRequest.number),
    );
  }

  return sortedPullRequests.slice(limit);
}

async function enforcePullRequestLimit({ context, core, github, rawLimit, rawOverrides }) {
  const pullRequest = context.payload.pull_request;
  if (!pullRequest) {
    throw new Error("The workflow event does not contain a pull request.");
  }

  if (pullRequest.user?.type === "Bot") {
    core.info(`Skipping pull request #${pullRequest.number} from a bot account.`);
    return { action: "skipped-bot" };
  }

  const author = pullRequest.user.login;
  const resolvedLimit = resolvePullRequestLimit({
    author,
    rawLimit,
    rawOverrides,
    warn: (message) => core.warning(message),
  });
  const { limit } = resolvedLimit;
  core.info(`${author}: effective pull request limit is ${limit} (${resolvedLimit.source}).`);
  const authorLogin = author.toLowerCase();
  const allOpenPullRequests = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: "open",
    per_page: 100,
  });
  const authorOpenPullRequests = allOpenPullRequests.filter(
    (candidate) => candidate.user?.login?.toLowerCase() === authorLogin,
  );

  const currentPullRequestIsOpen = authorOpenPullRequests.some(
    (candidate) => candidate.number === pullRequest.number,
  );
  if (!currentPullRequestIsOpen) {
    core.warning(
      `Pull request #${pullRequest.number} was not present in the open pull request list; reconciling the remaining open pull requests.`,
    );
  }

  const pullRequestsToClose = selectPullRequestsToClose({
    action: currentPullRequestIsOpen ? context.payload.action : "opened",
    currentNumber: pullRequest.number,
    limit,
    openPullRequests: authorOpenPullRequests,
  });

  if (pullRequestsToClose.length === 0) {
    core.info(
      `${author} has ${authorOpenPullRequests.length} open pull request(s); the configured limit is ${limit}.`,
    );
    return { action: "allowed", count: authorOpenPullRequests.length, limit };
  }

  const body = buildLimitComment(limit, authorOpenPullRequests.length);
  for (const excessPullRequest of pullRequestsToClose) {
    await ensureLimitComment({
      body,
      context,
      github,
      pullNumber: excessPullRequest.number,
    });
    await github.rest.pulls.update({
      ...context.repo,
      pull_number: excessPullRequest.number,
      state: "closed",
    });
    core.notice(
      `Closed pull request #${excessPullRequest.number} because ${author} exceeded the limit.`,
    );
  }

  return {
    action: "closed",
    closedPullRequests: pullRequestsToClose.map((candidate) => candidate.number),
    count: authorOpenPullRequests.length,
    limit,
  };
}

module.exports = {
  DEFAULT_MAX_OPEN_PRS,
  LIMIT_COMMENT_MARKER,
  buildLimitComment,
  enforcePullRequestLimit,
  parseMaxOpenPullRequests,
  parsePullRequestLimitOverrides,
  resolvePullRequestLimit,
  selectPullRequestsToClose,
};
