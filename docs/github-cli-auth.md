# GitHub CLI auth in app-launched shells

ChatGPT Desktop can launch successfully while shell commands inside the app still
see a different desktop session environment than a normal terminal. One common
symptom is that `gh auth status` works in the user's terminal, but commands run
from ChatGPT Desktop report one of:

- `You are not logged into any GitHub hosts`
- `The token in .../hosts.yml is invalid`
- device-login prompts even though `gh` is already authenticated elsewhere

This usually means the app shell inherited an app-scoped `XDG_CONFIG_HOME`, or
cannot reach the same Linux keyring over DBus that the normal terminal uses.
`~/.config/gh/hosts.yml` may only contain account metadata while the actual
token lives in the desktop keyring.

## Verify the mismatch

Run this in a normal terminal:

```bash
gh auth status
```

Then ask ChatGPT Desktop to run the same command in a shell. If the terminal shows
a valid login but the app shell does not, compare:

```bash
env | grep -E '^(XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME|DBUS_SESSION_BUS_ADDRESS|GH_CONFIG_DIR)='
```

## Wrapper workaround

Create a small wrapper on the host and ask Codex to use it for GitHub commands:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/gh-normal <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# Prefer the user's normal GitHub CLI config/keyring instead of any
# Electron/app-scoped XDG paths inherited by ChatGPT Desktop.
unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"

exec gh "$@"
EOF
chmod +x ~/.local/bin/gh-normal
```

Validate it from the app shell:

```bash
~/.local/bin/gh-normal auth status
```

Then use the wrapper anywhere ChatGPT Desktop needs authenticated GitHub CLI
access:

```bash
~/.local/bin/gh-normal repo create my-project --private --source . --remote origin --push
~/.local/bin/gh-normal pr create --fill
```

If the wrapper still cannot authenticate, refresh the GitHub CLI login from a
normal desktop terminal:

```bash
gh auth login -h github.com
```

Then retry `~/.local/bin/gh-normal auth status` inside ChatGPT Desktop.
