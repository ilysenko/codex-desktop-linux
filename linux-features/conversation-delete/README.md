# Conversation Delete

Optional Linux feature that adds **Delete chat** to ChatGPT conversations in
Codex Desktop's sidebar.

Feature is disabled by default because deletion is permanent. Enable it in
`linux-features/features.json`:

```json
{
  "enabled": ["conversation-delete"]
}
```

Action asks for confirmation, then uses upstream's authenticated ChatGPT
request client. It sends:

```text
DELETE /backend-api/conversation/id/<conversation_id>
```

Request has no body. Existing upstream client sends session authentication,
handles `204 No Content`, removes conversation from sidebar cache, suppresses
stale refetched list entries during backend propagation, and returns to home
when deleting active chat.

## Scope

Feature targets ChatGPT server conversations shown in ChatGPT mode. It does not
add deletion for local Codex threads or archived-chat bulk actions.

## Test

```bash
node --test linux-features/conversation-delete/test.js
```

Known risk: endpoint and minified sidebar markers are private upstream
contracts. Current-DMG drift leaves asset unchanged and emits warning; rebuild
with feature enabled after upstream refresh.
