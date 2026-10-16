# Separate ChatGPT Sidebar History

The upstream ChatGPT sidebar starts with the **All** source filter. When an
account has access to local or cloud Work, this combines ChatGPT conversations
and Codex tasks. Business workspaces with Work enabled can therefore show the
same local tasks and projects in both product modes. Consumer accounts can
appear different because their Work availability also depends on rollout rules.

The filter is available beside the **Recents** heading on hover: choose
**Chat** to show ChatGPT conversations. The upstream selection lives only in
memory and returns to **All** when the renderer restarts.

This opt-in feature changes the initial filter to **Chat** and stores later
**Chat / Work / All** selections using the existing preference helper. Invalid
stored values fall back to **Chat**. The preference is local to the app profile
and shared across accounts in that profile. The Codex product sidebar keeps
its upstream behavior. Account permissions, feature flags, authentication,
conversation requests, and server-side access checks are unchanged. This is a
history filter, not a separate account or a migration of conversations.

## Enable

Add `chatgpt-sidebar-separate-history` to the `enabled` array in your local,
gitignored `linux-features/features.json`, then rebuild and restart ChatGPT
Community. It is disabled by default.

```json
{
  "enabled": ["chatgpt-sidebar-separate-history"]
}
```

No rebuild is needed to select **Chat** in an already running app; persistence
requires this feature in the built bundle. Disable the feature and rebuild to
restore the upstream in-memory filter. Its unused preference can remain safely
in the profile.

## Validation

```bash
node --test linux-features/chatgpt-sidebar-separate-history/test.js
```

Matching follows the semantic source-selector and preference declarations,
independently of chunk hashes and minified aliases. Missing, duplicate, or
partially patched contracts are preserved without changes.
