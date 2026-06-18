# Codex Workflow Harness

## Status

Design proposal only. This document does not enable autonomous continuation,
email control, model switching, or background mutation.

The harness is a local policy layer for bounded engineering work. It may learn
from G-CODEX and Grok/MD practices, but this repository owns every adoption and
implementation decision.

## Goals

- keep useful work moving without consuming quota through avoidable repetition
- prepare and review documentation before changing important runtime behavior
- continue only through bounded, explicit work slices
- stop for approvals, ambiguity, failures, uncertain state, or policy limits
- keep continuation policy independent from any one terminal, app, or API
- produce one polished human-facing report for each completed bounded slice

The harness is not intended to create an unattended general-purpose agent loop.

## Verified And Unverified Capabilities

Verified in this repository:

- the Linux webview can display upstream rate-limit information
- local scripts can inspect repository, build, test, package, and updater state
- the Linux desktop settings page can expose a workspace-status card with repo
  location, Git remote, branch, dirty/clean state, root-certificate status, and
  workflow-harness status
- optional workflow-specific integrations belong in `linux-features/` and stay
  disabled by default
- launcher runtime hooks provide bounded extension points, but are not a
  general Codex turn-control API
- GitHub CI and local commands can provide completion evidence for engineering
  slices

Unverified / future adapter possibilities:

- starting or resuming a Codex turn through `thread/resume`, `turn/start`, or an
  app-server endpoint
- programmatically pressing a Codex Desktop Continue control
- selecting an `auto` or lower-cost model through a stable supported interface
- reading authoritative quota/reset state through a supported local API
- controlling a Grok terminal session without a harness-owned session protocol

No implementation may depend on an unverified capability. Verification requires
an official documented interface or a stable installed tool with an inspectable
contract, authentication model, error behavior, and tests.

## State Machine

```text
RUNNING
  -> COMPLETED
  -> WAITING_QUOTA
  -> WAITING_APPROVAL
  -> WAITING_USER
  -> WAITING_CONTEXT
  -> WAITING_TOOL_PERMISSION
  -> WAITING_REMOTE
  -> PAUSED_BY_POLICY
  -> FAILED
```

`COMPLETED` means the current bounded slice ended cleanly. It does not mean the
larger goal is complete. A new slice may start only after the continuation
policy evaluates the recorded result and proposed next action.

Terminal states are recorded as events, not inferred from silence or a terminal
prompt. Unknown or contradictory evidence becomes `WAITING_CONTEXT` or
`FAILED`, never an automatic continuation.

## Continuation Policy

Another bounded slice may start only when all of these are true:

- the prior slice completed cleanly with evidence
- the larger goal declares remaining work
- quota is available, or a known reset time has passed and availability is
  checked again
- no approval, user decision, missing context, or tool permission is pending
- no safety rule blocks the next action
- the next action has a specific objective, file or system scope, validation,
  and stopping condition
- recent history does not indicate repetition or a no-progress loop

The harness must stop when any of these are true:

- an approval or user decision is required
- quota is exhausted or quota state is uncertain after a limit response
- the requested outcome or next action is ambiguous
- the prior slice failed or its completion state is uncertain
- the same action, error, or report is repeating without new evidence
- the action could mutate important files, branches, releases, installations,
  credentials, or external systems without the required approval

## Quota-Wise Scheduling

Quota efficiency is a scheduling concern, not permission to weaken safety.

Each proposed slice receives a workload class:

| Class | Typical work | Preferred treatment |
| --- | --- | --- |
| `LOCAL_DETERMINISTIC` | status checks, searches, formatting, syntax checks | run locally with strict bounds |
| `LOW_REASONING` | inventory, mechanical summaries, known test commands | batch related reads and avoid repeated interpretation |
| `STANDARD_REASONING` | scoped implementation, review, test diagnosis | one bounded engineering slice |
| `HIGH_REASONING` | architecture, risky integration, unclear failures | documentation and decision record first |
| `HUMAN_DECISION` | approval, product choice, destructive or external action | stop and ask Trevor |

An adapter may select a model or an `auto` mode only when that control is
verified and the user has enabled the policy. Until then, workload classes are
advisory: they reduce duplicate reads, favor local deterministic tools, group
independent checks, and reserve deeper reasoning for decisions that need it.

Quota backoff must:

1. record the limit evidence and any trustworthy reset time
2. enter `WAITING_QUOTA`
3. avoid repeated polling or repeated reports
4. recheck once at or after the reset boundary
5. resume only through the normal continuation gates

## Slice Contract

Every slice declares:

- objective
- repository or external-system boundary
- allowed mutations
- prohibited operations
- expected evidence
- validation command or review method
- stop conditions
- next-action proposal

Documentation comes first when the slice changes architecture, continuation
policy, approvals, quota behavior, packaging, updates, or another cross-cutting
contract. Small fixes with an established local pattern may proceed directly,
but still require bounded scope and matching tests.

## Adapter Model

### `CODEX_DESKTOP_LOCAL_ADAPTER`

Available now for repo-local work. It may inspect files, prepare documentation,
run bounded tests, build review artifacts, and report blockers. It must not
assume an external turn-control API. Runtime integration should begin as an
opt-in `linux-features/` experiment unless it becomes necessary for baseline
Linux compatibility.

### `GROK_TERMINAL_ADAPTER`

Future adapter for a harness-owned Grok task. It must identify the exact working
directory, task id, process, terminal/session, expected command, and current
state. It must never send blind Enter or Continue keystrokes to whichever
terminal is focused. A session needs a machine-readable continuation request
and acknowledgement protocol before this adapter is safe.

### `EMAIL_CONTROL_ADAPTER`

Future adapter for summaries and deliberate control. It may accept authenticated
commands to approve a named pending action, pause, stop, redirect, request
status, or request the latest report. Email does not bypass the continuation
policy or create an open-ended loop.

### `CODEX_APP_SERVER_ADAPTER`

`UNVERIFIED / FUTURE ADAPTER POSSIBILITY`.

Implementation requires evidence for endpoint availability, supported methods,
authentication, thread identity, idempotency, approval propagation, quota and
error semantics, compatibility policy, and a non-destructive test fixture.

## Email-First Grok/MD Mode

Allowed by authenticated email:

- request current status or the latest completed-slice report
- pause or stop a named task
- redirect remaining work to a bounded, non-destructive objective
- approve a precisely described pending action when the approval request has a
  stable id, expiry, scope, and expected effect

Always require explicit approval for:

- file mutation outside the previously approved slice
- commits, branch changes, publication, installation, or external writes
- actions involving credentials, private data, releases, or destructive tools
- changing continuation limits or enabling a new adapter

Never trigger by email alone:

- blind terminal input
- broad filesystem searches
- broad Git staging
- pull, reset, clean, delete, move, force-push, or release publication
- automatic import of MD, CIA, Brain Template, or seed-packet code
- indefinite continuation or self-expanding goals

Each outbound message uses a task id and report revision. The harness sends one
polished report when a slice completes or first becomes blocked. Repeated polls,
unchanged blockers, and adapter retries update the audit log but do not send
duplicate reports. A new report requires new evidence, a state transition, or a
user request.

Runaway prevention requires a maximum slice count, wall-clock budget, retry
budget, duplicate-action detector, explicit remaining-work list, and immediate
human stop command. Reaching any limit enters `PAUSED_BY_POLICY`.

## Safety Gates

- verify the root certificate, path, remotes, branch, and working tree first
- fetch the intended remote before declaring push readiness
- stage only explicit paths; never use `git add .` or `git add -A`
- do not pull, reset, clean, delete, move, install, or release without the
  required explicit approval
- do not push unrelated ahead history
- constrain filesystem inspection to declared roots
- require tests appropriate to launcher, updater, packaging, feature, or UI
  changes
- allow one active mutating slice per repository
- preserve a human override that immediately pauses future work
- append state transitions, commands, approvals, evidence, and reports to an
  audit log without storing secrets

## Local Organ Registry

Certificates should become a read-only discovery layer for the personal system
map.

Keep identity and live state separate:

- `G-CODEX_ROOT_CERTIFICATE.md`: human-readable stable identity
- future `.gcodex/root-certificate.json`: machine-readable stable identity
- organ registry observation: current path, Git state, duplicate warnings, and
  other read-only observations
- harness task state: active work, approvals, and continuation status

The first registry implementation should:

- search only explicit parent roots or explicit paths
- avoid broad filesystem scans
- parse existing Markdown certificates so the current system is usable now
- emit JSON to stdout or another explicit destination
- warn on absolute-path mismatch, duplicate organ names, and duplicate remotes
- avoid mutating repositories or user-home state

## Audit Record

The implementation should persist append-only records with:

- task and slice ids
- timestamps and state transitions
- workload class and quota evidence
- requested and approved scope
- adapter used
- command or action summary
- validation result
- report revision and delivery status
- next-action proposal

Raw prompts, credentials, email bodies, and private model reasoning should not
be copied into the audit log by default.

## Adoption Path

1. Review and accept this policy document.
2. Define a small, versioned state/event schema with deterministic policy tests.
3. Build a read-only local organ registry generator with fixture-driven tests.
4. Build a read-only local evaluator that consumes fixture events and proposes
   `CONTINUE`, `WAIT`, or `STOP`; it performs no actions.
5. Add an append-only local audit log and duplicate-report guard.
6. Prototype the Grok/MD session protocol outside core app behavior.
7. Add authenticated email summaries and pause/status commands before approval
   commands.
8. Consider an opt-in local Linux feature only after the policy and adapter
   contracts are proven.
9. Keep the app-server adapter disabled until its interface is verified.

## First Implementation Slice

Create a standalone, deterministic local organ registry generator with
fixture-driven tests. It accepts explicit roots, discovers only bounded
certificate locations, parses the root certificates already in use, adds
read-only Git observations, and returns JSON with warnings for duplicate or
stale roots.

The next slice after that is the policy evaluator. It accepts the prior state,
declared remaining work, quota evidence, pending gates, retry history, and a
bounded next-action description. It returns one of:

- `CONTINUE` with the approved next slice description
- `WAIT` with a specific waiting state and recheck condition
- `STOP` with the blocking policy reason

This first slice must not control a terminal, send email, change models, mutate
application state, or start another Codex turn.
