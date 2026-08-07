"use strict";

const labelPolicy = require("../../.github/labels.json");

const LABEL = "area: upstream dmg";
const MANUAL_ONLY_LABEL = "workflow: manual only";
const ISSUE_LABELS = ["type: bug", LABEL, "status: ready for work"];
const LEGACY_LABELS = labelPolicy.migrations
  .filter(({ to }) => to === LABEL)
  .map(({ from }) => from);
const FINGERPRINT_PATTERN = /<!-- upstream-dmg-fingerprint:([a-f0-9]{64}) -->/i;
const TEST_REHEARSAL_PATTERN = /<!-- upstream-dmg-test-rehearsal:([a-z0-9][a-z0-9._-]{0,63}) -->/i;
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function labelDefinition(name) {
  const definition = labelPolicy.labels.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new Error(`Missing ${name} in .github/labels.json`);
  }
  return definition;
}

const ISSUE_LABEL_DEFINITIONS = ISSUE_LABELS.map(labelDefinition);

function hasLabel(issue, name) {
  return (issue.labels || []).some((label) => (
    typeof label === "string" ? label === name : label?.name === name
  ));
}

function fingerprintMarker(fingerprint) {
  return `<!-- upstream-dmg-fingerprint:${fingerprint} -->`;
}

function testRehearsalMarker(testId) {
  return `<!-- upstream-dmg-test-rehearsal:${testId} -->`;
}

function decisionTestId(decision) {
  return decision.testRehearsal?.id ?? null;
}

function issueTestId(issue) {
  return issue.body?.match(TEST_REHEARSAL_PATTERN)?.[1] ?? null;
}

function runMarker(runId) {
  return `<!-- upstream-dmg-run:${runId ?? "local"} -->`;
}

function issueFingerprint(issue) {
  return issue.body?.match(FINGERPRINT_PATTERN)?.[1]?.toLowerCase() ?? null;
}

function hasTrustedAutomationAuthor(issue) {
  return issue.user?.login === "github-actions[bot]" ||
    TRUSTED_AUTHOR_ASSOCIATIONS.has(issue.author_association);
}

function issueTitle(decision) {
  const version = decision.dmg.appVersion ?? "unknown version";
  const prefix = decisionTestId(decision) ? `[TEST ${decisionTestId(decision)}] ` : "";
  return `${prefix}Upstream DMG drift: ${version} (${decision.dmg.sha256.slice(0, 12)})`;
}

function blockerLine(item) {
  const check = item.check ?? "unknown check";
  const name = item.name ? ` / \`${item.name}\`` : "";
  const status = item.status ? ` (\`${item.status}\`)` : "";
  return `- **${check}**${name}${status}: ${item.reason}`;
}

function issueBody(decision) {
  const runUrl = decision.run.url;
  const lines = [
    fingerprintMarker(decision.dmg.sha256),
    ...(decisionTestId(decision) ? [testRehearsalMarker(decisionTestId(decision))] : []),
    runMarker(decision.run.id),
    ...(decisionTestId(decision) ? [
      "> [!CAUTION]",
      "> TEST REHEARSAL ONLY. This issue does not report a real upstream regression and must not be used for a production repair.",
      "",
    ] : []),
    "> [!IMPORTANT]",
    "> Automated repair is already in progress. Please do not open a pull request for this DMG unless the maintainer asks.",
    "",
    "The latest upstream DMG was rejected by the shared local/CI acceptance profile.",
    "",
    "## Candidate",
    "",
    `- App version: \`${decision.dmg.appVersion ?? "unknown"}\``,
    `- SHA-256: \`${decision.dmg.sha256}\``,
    `- Workflow run: ${runUrl ? `[open run](${runUrl})` : "unknown"}`,
    "",
    "## Blocking checks",
    "",
    ...decision.blockers.map(blockerLine),
    "",
    "## Maintainer checklist",
    "",
    "1. Download the exact DMG fingerprint shown above and reproduce the acceptance report locally.",
    "2. Update only current-DMG patch shapes; remove obsolete drift workarounds in the same change.",
    "3. Keep optional patches fail-soft and run the local release profile before opening a fix PR.",
  ];
  return `${lines.join("\n")}\n`;
}

async function listTrackingIssues(github, repo, { scanAll = false, testId = null } = {}) {
  const issuesByNumber = new Map();
  const queries = scanAll
    ? [{ ...repo, state: "all", per_page: 100 }]
    : [LABEL, ...LEGACY_LABELS].map((label) => ({ ...repo, state: "all", labels: label, per_page: 100 }));
  for (const params of queries) {
    let issues;
    try {
      issues = github.paginate
        ? await github.paginate(github.rest.issues.listForRepo, params)
        : (await github.rest.issues.listForRepo(params)).data;
    } catch (error) {
      if (error?.status === 404) continue;
      throw error;
    }
    for (const issue of issues) issuesByNumber.set(issue.number, issue);
  }
  // Fingerprint markers are public and can be copied into an arbitrary issue.
  // Only maintainers and this workflow's bot may create lifecycle-managed
  // trackers; labels and markers alone are not sufficient ownership proof.
  return [...issuesByNumber.values()].filter((issue) => (
    issue.pull_request == null &&
    hasTrustedAutomationAuthor(issue) &&
    issueFingerprint(issue) !== null &&
    (testId ? issueTestId(issue) === testId : issueTestId(issue) === null)
  ));
}

function issueUrl(repo, issue) {
  return issue.html_url ?? `https://github.com/${repo.owner}/${repo.repo}/issues/${issue.number}`;
}

async function ensureAssignee(github, repo, issue, assignee) {
  if (!assignee) return;
  const alreadyAssigned = (issue.assignees || []).some((candidate) => candidate?.login === assignee);
  if (alreadyAssigned) return;
  await github.rest.issues.addAssignees({
    ...repo,
    issue_number: issue.number,
    assignees: [assignee],
  });
}

async function ensureLabels(github, repo) {
  for (const definition of ISSUE_LABEL_DEFINITIONS) {
    try {
      await github.rest.issues.getLabel({ ...repo, name: definition.name });
    } catch (error) {
      if (error?.status !== 404) throw error;
      await github.rest.issues.createLabel({
        ...repo,
        name: definition.name,
        color: definition.color,
        description: definition.description,
      });
    }
  }
}

async function closeIssue(github, repo, issue, message, stateReason) {
  await github.rest.issues.createComment({ ...repo, issue_number: issue.number, body: message });
  await github.rest.issues.update({
    ...repo,
    issue_number: issue.number,
    state: "closed",
    state_reason: stateReason,
  });
}

async function consolidateMatchingIssues(github, repo, issues, fingerprint) {
  const matching = issues
    .filter((issue) => issueFingerprint(issue) === fingerprint)
    .sort((left, right) => left.number - right.number);
  if (matching.length === 0) return { primary: null, duplicateIssueNumbers: [] };

  const primary = matching.find((issue) => hasLabel(issue, MANUAL_ONLY_LABEL)) ?? matching[0];
  const duplicates = matching.filter((issue) => (
    issue.number !== primary.number &&
    issue.state === "open" &&
    !hasLabel(issue, MANUAL_ONLY_LABEL)
  ));
  for (const issue of duplicates) {
    await closeIssue(
      github,
      repo,
      issue,
      `Duplicate upstream DMG report; tracking continues in #${primary.number}.`,
      "not_planned",
    );
  }
  return {
    primary,
    duplicateIssueNumbers: duplicates.map((issue) => issue.number),
  };
}

async function normalizeMatchingIssue({
  github,
  repo,
  issue,
  title,
  body,
  decision,
  manageLabels,
  assignee,
}) {
  const wasOpen = issue.state === "open";
  const alreadyReported = issue.body?.includes(runMarker(decision.run.id));
  if (manageLabels) {
    await github.rest.issues.addLabels({
      ...repo,
      issue_number: issue.number,
      labels: ISSUE_LABELS,
    });
  }
  await github.rest.issues.update({
    ...repo,
    issue_number: issue.number,
    title,
    body,
    state: "open",
  });
  await ensureAssignee(github, repo, issue, assignee);
  if (!alreadyReported) {
    await github.rest.issues.createComment({
      ...repo,
      issue_number: issue.number,
      body: `Acceptance failed again. ${decision.run.url ?? "See the latest workflow artifacts."}`,
    });
  }
  return wasOpen ? "updated" : "reopened";
}

async function reconcileUpstreamDmgIssue({
  github,
  repo,
  decision,
  currentHttpIdentityKey,
  assignee = null,
  manageLabels = true,
  scanAll = false,
}) {
  if (decision.verdict === "inconclusive") {
    return { action: "ignored-inconclusive" };
  }
  if (typeof decision.dmg?.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(decision.dmg.sha256)) {
    return { action: "ignored-missing-fingerprint" };
  }
  const expectedIdentity = decision.dmg.httpIdentity?.key ?? null;
  if (!expectedIdentity || !currentHttpIdentityKey) {
    return { action: "ignored-missing-http-identity" };
  }
  if (currentHttpIdentityKey !== expectedIdentity) {
    return { action: "ignored-stale-candidate" };
  }

  const testId = decisionTestId(decision);
  const issues = await listTrackingIssues(github, repo, { scanAll, testId });

  if (decision.verdict === "accepted" || decision.verdict === "accepted_with_warnings") {
    const openIssues = issues.filter(
      (issue) => issue.state === "open" && !hasLabel(issue, MANUAL_ONLY_LABEL),
    );
    const manualOnlyIssueNumbers = issues
      .filter((issue) => issue.state === "open" && hasLabel(issue, MANUAL_ONLY_LABEL))
      .map((issue) => issue.number);
    for (const issue of openIssues) {
      await closeIssue(
        github,
        repo,
        issue,
        `Superseded by accepted upstream DMG \`${decision.dmg.sha256.slice(0, 12)}\`.`,
        "completed",
      );
    }
    return {
      action: "closed-resolved",
      count: openIssues.length,
      closedIssueNumbers: openIssues.map((issue) => issue.number),
      manualOnlyIssueNumbers,
    };
  }

  if (manageLabels) await ensureLabels(github, repo);
  const fingerprint = decision.dmg.sha256.toLowerCase();
  const {
    primary: matching,
    duplicateIssueNumbers,
  } = await consolidateMatchingIssues(github, repo, issues, fingerprint);
  const obsolete = issues.filter((issue) => (
    issue.state === "open" &&
    issueFingerprint(issue) !== fingerprint &&
    !hasLabel(issue, MANUAL_ONLY_LABEL)
  ));
  for (const issue of obsolete) {
    await closeIssue(
      github,
      repo,
      issue,
      `Superseded by newer rejected upstream DMG \`${fingerprint.slice(0, 12)}\`.`,
      "not_planned",
    );
  }

  const title = issueTitle(decision);
  const body = issueBody(decision);
  if (matching) {
    if (hasLabel(matching, MANUAL_ONLY_LABEL)) {
      return {
        action: "manual-only",
        issueNumber: matching.number,
        issueUrl: issueUrl(repo, matching),
        duplicateIssueNumbers,
      };
    }
    const action = await normalizeMatchingIssue({
      github,
      repo,
      issue: matching,
      title,
      body,
      decision,
      manageLabels,
      assignee,
    });
    return {
      action,
      issueNumber: matching.number,
      issueUrl: issueUrl(repo, matching),
      duplicateIssueNumbers,
    };
  }

  const createArgs = { ...repo, title, body };
  if (manageLabels) createArgs.labels = ISSUE_LABELS;
  if (assignee) createArgs.assignees = [assignee];
  const created = await github.rest.issues.create(createArgs);
  const refreshedIssues = await listTrackingIssues(github, repo, { scanAll, testId });
  if (!refreshedIssues.some((issue) => issue.number === created.data.number)) {
    refreshedIssues.push(created.data);
  }
  const consolidated = await consolidateMatchingIssues(github, repo, refreshedIssues, fingerprint);
  const primary = consolidated.primary ?? created.data;
  if (primary.number !== created.data.number) {
    if (!hasLabel(primary, MANUAL_ONLY_LABEL)) {
      await normalizeMatchingIssue({
        github,
        repo,
        issue: primary,
        title,
        body,
        decision,
        manageLabels,
        assignee,
      });
    }
    return {
      action: hasLabel(primary, MANUAL_ONLY_LABEL) ? "manual-only" : "reused-after-create-race",
      issueNumber: primary.number,
      issueUrl: issueUrl(repo, primary),
      duplicateIssueNumbers: consolidated.duplicateIssueNumbers,
    };
  }
  return {
    action: "created",
    issueNumber: created.data.number,
    issueUrl: issueUrl(repo, created.data),
    duplicateIssueNumbers: consolidated.duplicateIssueNumbers,
  };
}

module.exports = {
  LABEL,
  blockerLine,
  fingerprintMarker,
  issueBody,
  issueFingerprint,
  issueTestId,
  reconcileUpstreamDmgIssue,
  runMarker,
  testRehearsalMarker,
};
