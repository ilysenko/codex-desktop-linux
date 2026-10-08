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
- Pending app-server requests and active loaded tasks on connected hosts block
  switching. New renderer requests are rejected during the credential change.
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
  Inactive credentials are encrypted using Electron `safeStorage` and stored
  in `CODEX_HOME/.community-account-switcher/accounts.json`. The file is mode
  `0600`, its directory `0700`. Email, account identifiers and labels are local
  metadata; OAuth tokens are encrypted. Symlinked or public credential files,
  corrupt vaults, unavailable encryption, and `basic_text` storage are rejected.
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
sign in again. An unlocked system keyring (e.g. KWallet or Secret Service) is
required; the feature never falls back to an unencrypted account vault.

## Validation

```bash
node --test linux-features/account-switcher/test.js
```

Set `CODEX_ACCOUNT_SWITCHER_CLI` to the extracted official `resources/codex` to
also check credential-file decoding and the idle-check protocol in a disposable,
unauthenticated app server. This does not test OAuth with real accounts.

Set `CODEX_ACCOUNT_SWITCHER_OFFICIAL_DIR` to a directory containing the original
signed main and profile-dropdown JavaScript bundles to also run the current
bundle contract tests. Enabled feature builds fail closed on missing or
ambiguous anchors. Tests cover encryption, permissions, active-task guards,
cancellation, token refresh preservation, switching, rollback, forgetting,
storage corruption, authority mismatch, and unexpected OAuth destinations.
