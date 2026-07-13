# Conversation Mode

Opt-in Linux voice-in/voice-out conversation mode for normal Codex turns.

This feature does not add a new model provider or a new agent tool. It reuses the
existing composer dictation path for speech-to-text and the Linux Read Aloud
backend for text-to-speech. After the user clicks the composer voice control,
the webview listens for speech, waits for trailing quiet, submits the transcript
as a normal Codex message, and speaks each completed assistant turn through Read
Aloud as Codex produces it.

## Enable

Add the feature id to `linux-features/features.json` before installing or
rebuilding:

```json
{
  "enabled": ["read-aloud", "conversation-mode"]
}
```

The feature is disabled by default. A session starts only after the user clicks
the composer voice control. Enable `read-aloud` explicitly alongside
`conversation-mode`; it is required because conversation mode speaks through
the local Read Aloud backend. The Read Aloud settings toggle can remain off
because Conversation Mode invokes the backend for its own responses.

## Scope

- Uses Codex's existing dictation hook and its `send` transcript path.
- Submits the final speech transcript through Codex's normal message flow, so
  the user's spoken turn appears in the conversation like a typed message.
- Detects trailing quiet in the webview with a lightweight Web Audio RMS VAD.
  By default it submits after roughly 1.8 seconds of quiet, capped at 2 seconds,
  and a softer continuation threshold keeps low-energy words from being mistaken
  for silence.
- Speaks assistant output through the opt-in Linux Read Aloud Kokoro backend as
  each assistant turn completes. Multi-turn Codex responses queue later spoken
  turns instead of dropping them after the first spoken item.
- Keeps a lightweight interrupt monitor active while Codex is speaking or still
  working silently. If the user starts talking, it stops current speech, asks
  Codex to stop the old response, returns to dictation, and ignores old assistant
  output until the new spoken transcript is submitted.
- Starts automatic speech only from the active in-progress Codex turn. Completed
  history items and virtualized rerenders cannot begin a new spoken stream.
- Keeps a stable browser-side fallback identity for the current assistant stream
  because Codex may not expose the final turn id on the assistant message until
  the in-progress turn collapses into its final rendered answer.
- Advances a speech cursor whenever a spoken user transcript is accepted. Any
  queued, silent, or historical assistant output before that cursor is discarded
  instead of being completed later after the user has already moved the
  conversation forward.
- Ignores completed assistant messages that were already on screen, rejects
  transcripts that look like recent spoken output, and gates scheduled
  speech/listening work with a runtime epoch so stale timers cannot restart old
  output after an interrupt.
- Scopes the active voice loop to the conversation id that started it. Switching
  chats or rendering assistant output from another conversation stops the loop
  instead of carrying voice state across tabs.
- Keeps the composer voice control visible while conversation mode is active.
  Clicking it again exits conversation mode and leaves the user in normal typed
  chat. Pending dictation is discarded on explicit exit so a partial transcript
  does not get inserted into the composer and hide the voice control behind the
  send arrow.
- Adds a lightweight active-state aura around the composer/input surface plus
  stop and microphone mute controls anchored near the composer while
  conversation mode is active.
- Leaves typing available; typed turns still work normally while the feature is
  enabled.

This is intentionally separate from upstream realtime voice. It keeps the Linux
feature thin and local while still giving the user one conversational channel:
user speech becomes a normal Codex turn and assistant final text becomes spoken
output.

## Test

```bash
node --test linux-features/conversation-mode/test.js
```
