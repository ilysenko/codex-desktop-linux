# Community Profile Isolation

This optional Linux feature keeps ChatGPT Community runtime state separate from
the official ChatGPT installation while preserving the normal `codex-desktop`
package and installation identity.

## What it does

At Community launch time the feature pins:

- `CODEX_HOME=$HOME/.codex-community`
- Electron `--user-data-dir=$HOME/.config/Codex-Community`
- `CODEX_CLI_PATH` to a Community-owned wrapper staged inside
  `/opt/codex-desktop/.codex-linux/`

The wrapper executes `/opt/codex-desktop/resources/codex`, repairs a runtime
`PATH` that may have been reconstructed with `~/.local/bin` ahead of Community
resources, and passes the resulting dynamic path through
`shell_environment_policy.set.PATH`. That keeps later bare `codex` commands
spawned by the Community runtime on the Community CLI without changing the
user's normal shell.

The official application, normal shell `codex`, and the official `codex://`
handler are not modified by this feature.

## Launch and failure boundaries

The environment hook owns Codex state and initial process-local `PATH`. The
launcher hook owns the Electron profile and selects the Community CLI wrapper.
This also covers direct package and updater relaunches that do not pass through
a user's shell wrapper.

The feature fails closed when:

- a conflicting `--user-data-dir` is supplied;
- the Community CLI wrapper is missing or not executable;
- the wrapper receives a `CODEX_HOME` other than the Community state directory;
- the bundled Community `codex` executable is missing or not executable.

It does not migrate, merge, clear, or delete either profile.

## Resulting ownership

With the feature enabled:

- Official state remains `~/.codex`.
- Official Electron profile remains `~/.config/Codex`.
- Community state is `~/.codex-community`.
- Community Electron profile is `~/.config/Codex-Community`.
- Community app-server and child bare `codex` resolution use
  `/opt/codex-desktop/resources/codex`.

The package remains `codex-desktop` under `/opt/codex-desktop`.

## Test

Run the adjacent regression coverage:

```bash
node --test   linux-features/community-profile-isolation/test.js   linux-features/community-profile-isolation/path-isolation.test.js
```

The tests cover manifest resource staging, state ownership, Electron-profile
selection, conflicting-profile rejection, missing-wrapper failure, reordered
runtime `PATH`, child-command path pinning, and rejection of a non-Community
`CODEX_HOME`.

A package-level validation should also confirm that the wrapper and both runtime
hooks are staged under `/opt/codex-desktop/.codex-linux/`, and that a running
Community app-server resolves bare `codex` to
`/opt/codex-desktop/resources/codex`.
