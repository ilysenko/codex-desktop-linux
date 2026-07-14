# Issue and pull request label governance

Repository labels are a maintainer-owned triage layer. They give people a
quick view of what an item is, where it belongs, what is holding it up, and how
carefully a pull request must be reviewed. They also give repository
automation a small, deterministic vocabulary without exposing internal job
states in the issue and pull request lists.

[`.github/labels.json`](../.github/labels.json) is the machine-readable source
of truth for names, colors, descriptions, groups, migrations, and retirements.
This document defines how those labels are selected and who may change them.

## Authority

Label decisions belong to the repository owner and collaborators who have the
GitHub permission required to manage labels. Contributors without that
permission provide evidence; they do not choose, apply, remove, or rename
labels for their own work.

The same boundary applies to coding agents and automation:

| Actor | Allowed behavior |
| --- | --- |
| Reporter or pull request author without label permission | Supply reproduction details, scope, affected paths, and validation results. Do not self-classify. |
| Maintainer or authorized collaborator | Make the final classification and apply or remove labels. |
| Agent without delegated label authority | Read labels and native GitHub state. It may propose a classification to authorized staff, but must not mutate labels. |
| Authorized repository workflow or agent operation | Apply a reviewed deterministic plan from the trusted default branch, with the permissions and confirmation required by the manual workflow. |

A proposal from an agent is not a repository decision. The label changes only
when authorized staff accepts it or explicitly runs the staff-controlled
workflow. Authors must never be asked to add a label themselves. An unlabeled
new item is awaiting triage, not rejected.

## Classification contract

New issues and pull requests can be unlabeled while they wait for authorized
triage. Once classification starts, use the following cardinality rules.

### Issues

- exactly one `type:` label
- one or more `area:` labels
- exactly one active `status:` label
- zero or one `impact:` label; use it for confirmed bugs and public security
  work when impact can be supported by evidence
- optional community, workflow, resolution, and sync labels when their stated
  conditions are met

### Pull requests

- exactly one `type:` label
- one or more `area:` labels
- exactly one `risk:` label
- optional `workflow: manual only` or `resolution: duplicate` when applicable

Multiple area labels are expected when a change crosses a real ownership
boundary. Do not add extra areas for files that are only incidentally touched.
For example, a shared updater change that affects native packages may need
both `area: updater` and `area: native packaging`; a test fixture changed only
to support that updater fix does not automatically add `area: ci and tooling`.

## Taxonomy

### Type

Type answers one question: what kind of work is this?

| Label | Use and justification |
| --- | --- |
| `type: bug` | A reproducible defect or regression. Keeping defects separate from requests makes reliability work visible. |
| `type: feature` | New user-facing behavior, including an opt-in Linux feature. This keeps product additions distinct from repairs. |
| `type: documentation` | A documentation-only correction or addition. Use another type if code behavior changes too. |
| `type: maintenance` | Tests, refactoring, dependencies, CI, or repository upkeep without a new user-facing capability. |
| `type: question` | A usage or contribution question that needs an answer rather than a code change. |
| `type: security` | Public hardening or an already disclosed security concern. Undisclosed vulnerabilities do not belong in a public issue. |

### Area

Area identifies the source-of-truth surface a reviewer must inspect.

| Label | Use and justification |
| --- | --- |
| `area: build and install` | DMG extraction, dependencies, native modules, installer orchestration, or initial setup. |
| `area: launcher and runtime` | Process lifecycle, the generated launcher source, webview serving, or packaged runtime behavior. |
| `area: updater` | Update detection, rebuilds, installation, rollback, or persisted updater state. |
| `area: native packaging` | Shared or format-specific `.deb`, RPM, or pacman package behavior. |
| `area: appimage` | AppImage construction, runtime behavior, or desktop integration. |
| `area: nix` | Flake outputs, Nix modules, fixed-output hashes, or Nix-only packaging. |
| `area: upstream dmg` | Compatibility with, or drift in, the latest supported upstream DMG. |
| `area: linux features` | The opt-in feature framework or one of its modules. |
| `area: computer use` | Linux Computer Use backends, helpers, capture, input, or desktop control. |
| `area: integrations` | Browser, desktop environment, portal, or other external integration boundaries. |
| `area: ci and tooling` | GitHub Actions, validation scripts, developer tooling, fixtures, or repository governance. |

The list deliberately avoids one label per distribution, desktop, package
version, or feature module. Those details belong in the issue body until the
volume proves that a stable routing label is useful.

### Issue status

Status records the single next condition needed to move an issue forward.

| Label | Use and justification |
| --- | --- |
| `status: needs triage` | Staff has not yet validated and classified the report. This is the intake state. |
| `status: needs information` | The reporter must provide named missing details, such as logs, versions, or commands. |
| `status: needs reproduction` | The report is understandable but still needs a reliable reproduction or failing test. |
| `status: ready for work` | The problem is confirmed, scoped, and has enough acceptance criteria to implement. |
| `status: awaiting upstream` | Progress depends on an upstream DMG, dependency, or external project. Name that dependency in the thread. |
| `status: needs maintainer decision` | Product direction, architecture, scope, or policy must be decided by a maintainer. |
| `status: blocked` | A documented non-upstream blocker prevents progress. Replace it when the blocker clears. |

Do not combine status labels. Choose the immediate gating condition. A broad
request that still lacks scope is `status: needs maintainer decision`, not
`status: ready for work` plus a warning in a comment.

### Issue impact

Impact measures observed user harm. It is not scheduling priority.

| Label | Use and justification |
| --- | --- |
| `impact: critical` | Security exposure, data loss, privilege failure, or widespread breakage. Evidence must support the consequence. |
| `impact: high` | A major supported workflow is broken and no reasonable workaround exists. |
| `impact: medium` | Supported behavior is impaired, but the scope is limited or a workable workaround exists. |
| `impact: low` | Minor, cosmetic, or narrowly scoped harm. |

There are no `priority:` labels. Priority is an owner decision that can change
without the technical impact changing; milestones or GitHub Projects are a
better place to schedule work.

### Pull request risk

Risk tells reviewers how widely to validate a change. It never grants merge
permission and never replaces required review or checks.

| Label | Use and justification |
| --- | --- |
| `risk: low` | A small isolated change with straightforward validation and rollback. |
| `risk: medium` | A behavioral change with bounded compatibility or cross-surface risk. |
| `risk: high` | Security, privileges, updates, persistence, lifecycle, or several package paths are involved. |

Documentation-only work can be low risk. A small diff can still be high risk
when it changes an authorization, update, or rollback boundary.

### Community, control, resolution, and synchronization

| Label | Use and justification |
| --- | --- |
| `good first issue` | Staff has confirmed small scope, `status: ready for work`, and explicit acceptance criteria suitable for a first contribution. |
| `help wanted` | Staff wants a contributor to take ownership of confirmed and scoped work. |
| `feedback wanted` | Community input is requested before a decision or implementation. This is not a substitute for a maintainer decision. |
| `workflow: manual only` | Item-specific automation may inspect the item but must not comment, edit, classify, close, or merge it. This is a hard stop until staff removes it. |
| `resolution: duplicate` | Staff has verified that another issue or pull request tracks the same work and links the canonical item. A similarity score is not enough. |
| `sync: computer use` | A merged change under the vendored Computer Use crate still needs assessment or propagation to `agent-sh/computer-use-linux`. |

## Native GitHub state stays authoritative

Labels must add repository meaning, not copy state GitHub already exposes.

| Do not create a label for | Authoritative source |
| --- | --- |
| queued, running, passed, or failed tests | GitHub Checks |
| draft or ready for review | Pull request draft state |
| merge conflicts or fork origin | Pull request metadata |
| requested changes or approvals | Review state |
| merged or closed | Native issue and pull request state |
| stale activity | Timeline and timestamps |
| an automation error or dry-run result | Check, run summary, or log |

Potential secret detection must be a blocking private security signal, never a
public label. `resolution: duplicate` is applied only after an authorized human
or explicitly authorized staff operation verifies and links the canonical
item.

## Agent and automation rules

An agent classifying an item must read the body, linked discussion, changed
files, checks, review state, and the current label policy. A title alone is not
enough. When evidence is missing, preserve that uncertainty with
`status: needs triage`, `status: needs information`, or
`status: needs reproduction`; do not guess a stronger state.

Without explicit delegated staff authority, the output is a proposal only.
With delegated authority, the operation must still use the trusted manual
workflow or the repository script, show its plan first, and keep the typed
confirmation boundary. A fork pull request never receives a write token for
label governance.

The `workflow: manual only` label overrides every item-specific automation
path. The only exception is an owner-approved catalog migration declared in
`.github/labels.json`; it may rename a label or transfer the same existing
classification, but it may not infer a new classification or change the item
itself. A low-risk classification does not authorize automatic merge. Branch
protection, review requirements, and the contributor workflow in
`CONTRIBUTING.md` remain in force.

Repository-owned issue producers must read their labels from the policy and
apply a complete deterministic classification. The Computer Use sync reminder
and upstream DMG drift reconciler follow this rule. Existing item automation,
including the contributor pull request limit, must inspect
`workflow: manual only` before any comment, edit, classification, close, or
merge operation and leave that item for staff.

## Color system

Colors are consistent by purpose so the issue and pull request lists remain
scannable:

- established GitHub colors are retained for bug, feature, documentation,
  question, newcomer, and help labels
- pale blue identifies ownership areas without competing with urgency
- green, yellow, orange, and red carry increasing impact or review risk
- gray marks intake or manual workflow control
- purple marks maintenance and maintainer decisions

Color never carries meaning by itself. Every label has an English name and a
short description for accessibility, search, and API consumers.

## Safe synchronization and migration

The manual [Manage repository labels](../.github/workflows/manage-labels.yml)
workflow is the only repository-supplied bulk mutation path. It checks out the
trusted default branch even if another ref is selected in the dispatch UI.
Only a user with the repository permission required to run the workflow can
start it.

The migration is intentionally split:

1. Merge the reviewed policy, documentation, script, tests, and workflow.
2. Update or disable any external automation that still writes retired names.
   The committed Computer Use and upstream DMG issue producers read their
   classifications from the policy.
3. Run `plan`. It is read-only and needs no confirmation text.
   It also reports open items whose migrated labels still need a required
   staff classification; these are triage notices, not inferred labels.
4. Run `apply` with confirmation `APPLY`. This creates or updates desired
   labels, renames the primary legacy labels, and transfers associations from
   secondary legacy labels. It does not delete labels outside the explicit
   retirement list.
5. Resolve every open-item retirement blocker. An old label can be removed
   from an open item only when its governed replacement is already attached;
   labels without a direct replacement must be reviewed by staff first.
6. Run `retire` with confirmation `RETIRE`. The workflow captures and uploads
   a pre-change snapshot before deletion. It aborts if the live labels or their
   associations change after that snapshot.

The script is idempotent. A failed apply can be rerun: completed renames are
recognized, existing desired labels are updated in place, and already migrated
associations are skipped. Convergence stops before its first write if projected
labels would violate an exclusive group or apply to the wrong item type.
Open migrated items with an incomplete required classification are listed for
staff triage instead of being guessed by the migration.
Retirement is fail-closed; it checks every blocker before deleting the first
label. An interrupted retirement can resume from the same snapshot: already
absent retired labels count as completed, while every remaining source and
migration target must still match the snapshot. Unknown labels are never
pruned.

For a local read-only plan:

```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/ci/manage-labels.js \
  --repo ilysenko/codex-desktop-linux
```

Keep tokens in the environment, not in command arguments. For an emergency
non-destructive restore, download a workflow snapshot and run:

```bash
GITHUB_TOKEN="$(gh auth token)" node scripts/ci/manage-labels.js \
  --repo ilysenko/codex-desktop-linux \
  --restore /path/to/repository-labels-before.json \
  --confirm RESTORE
```

Restore recreates only labels in the policy's explicit retirement list and
reapplies their saved issue and pull request associations. It does not remove
the new taxonomy or alter native GitHub state.

## Examples

A confirmed latest-DMG regression in an opt-in feature could be classified as
`type: bug`, `area: upstream dmg`, `area: linux features`,
`status: ready for work`, and an evidence-based impact.

A pull request that changes this label policy is `type: maintenance`,
`area: ci and tooling`, and normally `risk: medium` because it changes a
write-capable repository workflow even though it does not change application
runtime behavior.

A setup question missing the distribution and exact command is
`type: question`, `area: build and install`, and
`status: needs information`. Staff should name the missing facts in the issue
thread; the reporter is not asked to choose the labels.
