**IMPORTANT: THIS PROJECT SUPPORTS ONLY THE LATEST UPSTREAM `CODEX.DMG`. WHEN FIXING UPSTREAM DRIFT, REMOVE OLD DRIFT WORKAROUNDS IN THE SAME PULL REQUEST. DO NOT KEEP LEGACY DMG SHAPES, FALLBACK PATCH PATHS, OR VERSION-SPECIFIC COMPATIBILITY ZOOS AROUND. THE CODE SHOULD TARGET THE CURRENT DMG SO REVIEW, VALIDATION, AND DIAGNOSTICS DO NOT HAVE TO GUESS WHICH UPSTREAM VERSION FAILED.**

# Contributing to Codex Desktop for Linux

Thanks for your interest in contributing to Codex Desktop for Linux. This project adapts the official macOS Codex Desktop DMG into a runnable Linux app, packages it for multiple Linux distributions, and maintains a local Rust update manager for future rebuilds.

Contributions of all sizes are welcome: bug reports, documentation improvements, packaging fixes, installer updates, tests, and new features.

## Pull Request Best Practices

- Keep each pull request focused: one bug fix, one feature, or one maintenance change.
- Touch the minimum set of files needed to solve the problem.
- Avoid mixed pull requests that combine unrelated fixes, refactors, formatting, docs, or cleanup.
- Think through the impact on every supported path: source installs, `.deb`, `.rpm`, pacman packages, Nix, updater rebuilds, and different desktop environments.
- Preserve existing platform behavior unless the pull request explicitly explains why it must change.
- If a feature is not part of the standard upstream Codex Desktop experience and is not required Linux compatibility glue, implement it as an opt-in `linux-features/` module instead of a core patch.
- Include a short summary, the user-visible behavior change, and the validation you ran.

## Before You Start

Please take a moment to understand how this repository is structured before making changes.

- `install.sh` is the top-level installer entrypoint. Build-pipeline logic lives in `scripts/lib/*.sh` (DMG handling, ASAR patching, native modules, Electron download, bundled plugins) and the runtime launcher body lives in `launcher/start.sh.template`. Edit the template for launcher behavior and a lib file for build-pipeline behavior — `install.sh` itself is just orchestration plus the prelude that bakes install-time identity into the generated launcher.
- `scripts/build-deb.sh`, `scripts/build-rpm.sh`, and `scripts/build-pacman.sh` package an already-generated `codex-app/`.
- `scripts/install-deps.sh` bootstraps local development dependencies.
- `updater/` contains the Rust update manager.
- `scripts/patch-linux-window-ui.js` is the build-facing ASAR patcher CLI. Core
  patch descriptors live under `scripts/patches/core/`, with implementation
  helpers under `scripts/patches/impl/`.
- `codex-app/` and `dist/` are generated artifacts and should not be treated as primary source unless you are intentionally validating generated output.

For repository-specific implementation details, read [`AGENTS.md`](./AGENTS.md) and the relevant sections in [`README.md`](./README.md) before starting work.

## Ways to Contribute

You can help by:

- reporting bugs or regressions
- proposing UX or packaging improvements
- improving Linux compatibility across distributions and desktop environments
- fixing installer, launcher, updater, or packaging issues
- adding or improving tests
- improving documentation

## Reporting Issues and Proposing Changes

Before opening a new issue or pull request:

- search existing issues and pull requests to avoid duplicates
- gather as much context as possible, especially distro, desktop environment, package format, and exact reproduction steps
- include logs or command output when relevant

Good issue reports usually include:

- distro and version
- package format used: `.deb`, `.rpm`, `.pkg.tar.zst`, or dev build
- whether the issue happens in `install.sh`, packaged runtime, updater, or generated launcher
- exact commands used
- expected behavior
- actual behavior

## Development Setup

The recommended local setup is:

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
bash scripts/install-deps.sh
```

This project requires:

- `python3`
- `7z` or `7zz`
- `curl`
- `unzip`
- `make`
- `g++`
- Rust toolchain with `cargo`

`install.sh` downloads a managed Node.js runtime for the build and packaged app. A system Node.js install is optional user tooling.

If you are working on apt-based systems, prefer the bootstrap path in `scripts/install-deps.sh` so you get a compatible Node.js version.

## Recommended Contribution Flow

1. Find or open an issue.
2. Comment on the issue if you plan to work on it, especially for non-trivial changes.
3. Fork the repository and create a focused branch.
4. Read the relevant source-of-truth files before editing generated output.
5. Implement the smallest correct change that solves the problem.
6. Add or update tests.
7. Run the appropriate validation commands locally.
8. Open a pull request with a clear summary, scope, and validation notes.
9. Stay engaged after opening the PR and respond to review comments promptly.

## Engineering Standards

Contributions should prioritize maintainability, clarity, and safe behavior across Linux distributions.

### Coding Standards

- Follow the existing style and conventions of the surrounding code.
- Prefer small, focused changes over broad refactors.
- Keep shell scripts readable, defensive, and explicit.
- Keep Rust code idiomatic, strongly typed, and easy to test.
- Avoid introducing hidden coupling between installer, generated launcher, packaging, and updater behavior.
- Do not patch generated artifacts when the real source of truth is elsewhere.

### Design Principles

All changes should respect these principles:

- `SOLID`: keep responsibilities separated and interfaces clear
- `Clean Code`: optimize for readability and maintainability
- `DRY`: avoid duplicated logic when a shared helper or source of truth is more appropriate
- `YAGNI`: do not add speculative features or abstractions
- `KISS`: prefer the simplest solution that correctly solves the problem

When these principles conflict, prefer the option that keeps the repository easier to maintain and reason about.

### Source-of-Truth Discipline

This repository has generated outputs, and changes must respect the real ownership boundaries.

- Prefer changing `launcher/start.sh.template` (runtime/launcher behavior) or the relevant `scripts/lib/*.sh` module (build-pipeline behavior) over editing `codex-app/start.sh` or the top-level `install.sh` directly.
- Prefer changing packaging templates and helper scripts over editing staged package output.
- Prefer changing updater source under `updater/` over working around behavior in tests or generated files.
- If behavior differs between generated artifacts and source, fix the source and regenerate or revalidate.

## Testing and Quality Requirements

Every behavioral change should be validated. Do not rely on reasoning alone.

### TDD Expectation

Use TDD for functional changes whenever practical.

- Write or update a failing test first for bug fixes and new behavior.
- Implement the smallest change necessary to make the test pass.
- Re-run the targeted test and then the broader relevant validation suite.

For bug fixes, the preferred pattern is:

1. reproduce the bug with a test
2. confirm the test fails for the right reason
3. implement the fix
4. confirm the test passes
5. run the surrounding suite to catch regressions

### Required Quality Bar

Contributors are expected to:

- test any code change
- update tests when behavior changes
- avoid merging unverified fixes
- keep CI green
- leave the codebase at least as clean as they found it

### Recommended Validation Commands

Run the subset that matches your change. For installer, packaging, or updater work, these are the baseline commands:

```bash
bash -n install.sh
bash -n scripts/lib/*.sh
bash -n launcher/start.sh.template
bash -n scripts/install-deps.sh
bash -n scripts/build-deb.sh
bash -n scripts/build-rpm.sh
bash -n scripts/build-pacman.sh
cargo check -p codex-update-manager
cargo test -p codex-update-manager
bash tests/scripts_smoke.sh
```

If your change affects packaging, also run the relevant package builds:

```bash
./scripts/build-deb.sh
./scripts/build-rpm.sh
./scripts/build-pacman.sh
```

If your change affects launcher behavior, inspect the generated launcher:

```bash
sed -n '1,160p' codex-app/start.sh
```

If your change affects updater behavior, inspect runtime state where appropriate:

```bash
systemctl --user status codex-update-manager.service
codex-update-manager status --json
sed -n '1,160p' ~/.local/state/codex-update-manager/state.json
sed -n '1,160p' ~/.local/state/codex-update-manager/service.log
```

When a command is not applicable or not available in your environment, mention that clearly in the pull request.

## Working With Agents

If you use AI coding agents or sub-agents while contributing, apply structured, reviewable workflows.

### SDD Expectation

Use SDD, meaning subagent-driven development, only in a disciplined way.

- Break work into small, well-scoped tasks.
- Delegate only bounded tasks with clear ownership.
- Do not allow multiple agents to edit the same files without coordination.
- Review agent output before considering the work complete.
- Re-run tests yourself after integrating agent-generated changes.
- Treat agent output as draft engineering work, not as verified truth.

Good uses of agents include:

- isolated documentation updates
- targeted test additions
- small, disjoint code changes
- codebase exploration for specific questions

Bad uses of agents include:

- broad unsupervised refactors
- overlapping edits to the same subsystem
- skipping local validation because the agent claims success

## Versioning Rules

This repository has explicit versioning expectations for the updater crate.

- bump `patch` for fixes, docs, and maintenance-only updates
- bump `minor` for backward-compatible feature additions
- bump `major` for incompatible CLI, persisted-state, or install-flow changes

If you change the updater crate version:

- update the relevant documentation such as `README.md` and `AGENTS.md`
- ensure the version bump matches the real user-facing impact

If you are not sure which version bump is appropriate, ask in the issue or pull request before finalizing the change.

## Pull Request Expectations

A good pull request should be easy to review and easy to validate.

### Keep PRs Focused

- Submit one logical change per PR when possible.
- Avoid mixing unrelated refactors with bug fixes or feature work.
- Call out any follow-up work that you intentionally left out of scope.

### PR Description Checklist

Include:

- what changed
- why it changed
- the source-of-truth files edited
- how it was tested
- any distro, package, or environment limitations
- any known risks or follow-up items

### Review Comments

If you open a PR, stay attentive to review comments.

- respond to reviewer feedback clearly and respectfully
- push follow-up commits promptly when changes are requested
- explain tradeoffs when you disagree
- do not ignore unresolved comments
- re-run relevant validation after applying review feedback

If a reviewer raises uncertainty about versioning, compatibility, packaging, or updater behavior, resolve that uncertainty before considering the PR ready to merge.

## Commit Quality

Make commits intentional and readable.

- prefer clear commit messages
- keep commits focused and reviewable
- avoid mixing formatting-only noise with functional changes unless necessary
- if your workflow uses conventional commits, apply them consistently

## Documentation Expectations

Update documentation when behavior, developer workflow, packaging, or versioning expectations change.

Examples:

- installer behavior changes
- packaging dependency changes
- updater behavior changes
- new required validation steps
- versioning policy updates

## What to Avoid

Please avoid:

- editing generated output instead of the real source of truth
- introducing speculative abstractions
- skipping tests for behavioral changes
- silently changing user-facing behavior without documentation
- bundling unrelated cleanups into the same PR
- leaving reviewer comments unresolved

## Thank You

Every improvement helps make Codex Desktop for Linux more reliable across distributions, desktop environments, and packaging formats. Thanks for taking the time to contribute thoughtfully.
