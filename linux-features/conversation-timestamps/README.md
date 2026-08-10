# Conversation Timestamps

Optional feature that shows localized timestamps between ChatGPT conversation messages.

Feature stays disabled by default. Enable in local `linux-features/features.json`:

```json
{
  "enabled": ["conversation-timestamps"]
}
```

Patch preserves ChatGPT message `create_time` as milliseconds, keeps distinct
ChatGPT assistant items from being merged before rendering, fills missing local
Codex assistant item times from turn start metadata, and renders centered
localized timestamp separators below each assistant message and above following
user turns. User-message timestamps remain available through their existing
action rows. ChatGPT and local paths use separate markers, so one path cannot
silently alter the other. Timestamp labels stay visible without hovering
messages.

## Test

```bash
node --test linux-features/conversation-timestamps/test.js
```

## Support risk

Patch selects current ChatGPT and local Codex assets by semantic contracts
inside stable asset families, so hash renames need no edits. Missing, ambiguous,
or drifted contracts fail soft and emit warnings.
