# Account Switcher

Experimental, disabled by default. Adds **Switch account…** to both desktop
profile menu layouts. The native account menu can remember up to 20 ChatGPT logins,
add an account using the official browser OAuth flow, switch to a saved login,
or forget an inactive saved login.

## Enable

Add `account-switcher` to `enabled` in the gitignored
`linux-features/features.json`, then build normally with `./install.sh`.
Do not promote a candidate over a running installation. Open the new build only
after you have finished work and exited the old build yourself.

The feature is incompatible with `shared-app-server-socket`: a shared CLI
session could otherwise change authentication while another client is working.
It works with `community-profile-isolation`, which gives Community its own
Codex home. Without isolation it uses the normal `CODEX_HOME` (default
`~/.codex`); shell CLI sessions use that same login. Do not run another CLI or
desktop app against that home while changing accounts.

## Behavior and storage

- Switching does not quit or relaunch Electron. It reconnects the local
  app server and reloads desktop windows so account-specific UI caches refresh.
- Pending app-server requests in this app and active loaded local/remote tasks
  block switching. Local/remote task checks use upstream's ready-checked request
  wrapper with `thread/loaded/list` and `thread/read` before starting OAuth.
  Durable cloud tasks run independently of the desktop connection and do not
  block a local account change. The switcher does not enumerate or cancel them;
  work in another app/profile can continue. Pending requests on this app's
  durable connection still block switching. Unknown local/remote statuses or
  failed local/remote checks block switching.
  New renderer requests are rejected during the credential change.
  This is not an interprocess lock for external CLI clients or automation.
- Local chats, projects, settings, and plugin configuration remain shared in
  the same profile. Cloud chats, usage, and account permissions follow the login.
  This is credential switching, not account-specific local data isolation.
- Only ChatGPT OAuth accounts are supported. API keys, Copilot, Bedrock,
  ephemeral access-token logins, and remote-host login switching are excluded.
- The local server explicitly uses `cli_auth_credentials_store="file"` and
  `features.secret_auth_storage=false` while this feature is enabled. If your
  existing login is stored only in the keyring/secret store, sign in again in
  the new build first. Existing keyring entries are not migrated or deleted.
- The active `CODEX_HOME/auth.json` remains the upstream credential file.
  Inactive credentials are encrypted with AES-256-GCM and stored in
  `CODEX_HOME/.community-account-switcher/accounts.json`. A random 256-bit key
  is stored in the system Secret Service through `secret-tool`, under attributes
  for this feature and a hash of the canonical Codex home. The key travels over
  the tool's standard input/output, never in arguments, logs, or the vault.
  The file is mode `0600`, its directory `0700`. Email, account identifiers and
  labels are local metadata; OAuth tokens are encrypted. Symlinked or public
  credential files, corrupt vaults, unavailable keyrings, lost keys, and modified
  ciphertext are rejected. An existing vault is never overwritten with a new key.
  The official Owl runtime does not ship Electron's native `safeStorage` binding;
  this feature deliberately does not access that API.
- The currently active account is remembered when the menu opens and again
  before switching, preserving refreshed tokens. A failed switch restores its
  previous credential file and reconnects. If recovery also fails, saved logins
  remain available and the dialog reports that recovery is required.
- Adding an account retains the old login until the official flow completes.
  Cancellation cancels the login and restores the old account. Forgetting a
  saved login removes only its encrypted copy, without revoking tokens or
  deleting chats. The current login cannot be forgotten through this dialog.

Disabling the feature leaves the vault and active credential file intact. The
upstream credential-store selection applies again and may select an older login
from the system keyring.

If a saved refresh token has expired or been revoked, use **Add account…** to
sign in again. An unlocked Secret Service provider (e.g. GNOME Keyring,
KeePassXC with Secret Service enabled, or a configured KDE provider) is required;
the feature never falls back to an unencrypted account vault. Native deb/RPM/
pacman packages declare the CLI dependency and Nix adds it to the runtime
path. Source builds and AppImage need `secret-tool` on the host (`libsecret-tools`
on Debian/Ubuntu; `libsecret` on Arch/Fedora). On KDE, KWallet itself must expose
Secret Service, or a separate provider must be active.
Gentoo support is not declared until native Portage validation is available.

Vault format 2 uses Secret Service encryption. Earlier experimental format-1
vaults are rejected and preserved; sign in again using a fresh profile to test
this version. This feature does not clear system keyring entries when disabled.

## Validation

```bash
test_tmp="${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop-dev/tmp"
mkdir -p "$test_tmp"
TMPDIR="$test_tmp" node --test linux-features/account-switcher/test.js
```

Set `CODEX_ACCOUNT_SWITCHER_NATIVE_APP` to an extracted official application
root and `CODEX_ACCOUNT_SWITCHER_ASAR_CLI` to `@electron/asar/bin/asar.mjs` to also
run the native Owl regression test. This requires a graphical session and an
unlocked Secret Service provider. It generates a disposable probe, uses synthetic
credentials, verifies key persistence and vault decryption in fresh switcher
instances, and exercises **Add account** with the official connection class's
request/subscription methods. An initially disconnected hosted connection must
remain untouched, and the probe rejects any attempts to query global cloud work.
The probe uses a synthetic transport and intercepts the browser launch, then
cancels OAuth; it does not log in to real accounts. It exits only its own process
and clears only its own test key.
Do not set a long build `TMPDIR` when launching a desktop app: Chromium's socket
path must fit the Unix-domain socket limit. Use `TMPDIR="$XDG_RUNTIME_DIR"` for
interactive launches instead.

Set `CODEX_ACCOUNT_SWITCHER_CLI` to the extracted official `resources/codex` to
also check credential-file decoding and the idle-check protocol in a disposable,
unauthenticated app server. This does not test OAuth with real accounts.

Set `CODEX_ACCOUNT_SWITCHER_OFFICIAL_DIR` to a directory containing the original
signed main and profile-dropdown JavaScript bundles to also run the current
bundle contract tests. Enabled feature builds fail closed on missing or
ambiguous anchors. Tests cover encryption, permissions, active-task guards,
cancellation, token refresh preservation, switching, rollback, forgetting,
storage corruption, authority mismatch, and unexpected OAuth destinations.
