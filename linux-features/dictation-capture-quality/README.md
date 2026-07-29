# OpenAI Dictation Quality

Opt-in Linux dictation that uses a verified clean capture path while keeping the
user's OpenAI API key out of the renderer, source tree, package, environment,
and logs.

The feature changes only the existing Codex composer dictation path:

- requests two-channel audio;
- disables Chromium echo cancellation, noise suppression, and automatic gain
  control;
- disables Codex's built-in streaming transcription so it cannot bypass this
  feature's OpenAI batch endpoint;
- passes base64 WebM audio through Codex's trusted `vscode://codex` bridge;
- accepts bridge calls only from primary Codex windows and permits one paid
  transcription request at a time;
- retrieves a Codex-owned key from the freedesktop.org Secret Service in the
  Electron main process;
- sends the unchanged WebM/Opus recording to OpenAI with
  `model=gpt-4o-transcribe` and `language=en`.

The key is never sent to the webview. Before opening Secret Service or making a
network request, the bridge checks the caller, canonical base64 encoding,
declared WebM/Opus MIME type, 25 MiB size limit, and WebM EBML signature. The
OpenAI API performs final media validation. API errors report only their HTTP
status, not response bodies.

## Credential

Debian and pacman packages declare the host package that supplies
`/usr/bin/secret-tool`. RPM distributions use incompatible provider names
(`libsecret` on Fedora and `secret-tool` on openSUSE), so RPM, AppImage, and
other self-built installs must provide that command and an unlocked Secret
Service implementation separately.

The runtime reads this Secret Service item:

```text
service=codex-desktop-openai-transcription
label=Codex Desktop OpenAI transcription key
```

Provision the item interactively; `secret-tool` reads the key from standard
input:

```bash
secret-tool store \
  --label='Codex Desktop OpenAI transcription key' \
  service codex-desktop-openai-transcription
```

Never place the key in a command argument, environment variable, repository
file, or feature configuration.

## Privacy, billing, and support limits

Each completed dictation uploads the recorded WebM/Opus audio to the OpenAI
Audio Transcriptions API using the stored key. API usage is billed to that key
independently of a ChatGPT or Codex subscription.

This feature is English-only, batch-only, and intentionally conflicts with
`conversation-mode`, whose microphone processing and streaming behavior are
different. Text appears after recording stops and the upload completes.

## Enable

Add the feature id to `linux-features/features.json`:

```json
{
  "enabled": ["dictation-capture-quality"]
}
```

## Test

```bash
node --test linux-features/dictation-capture-quality/test.js
```

## Disable and remove

Disabling the feature affects the next rebuild and removes both bundle patches.
It intentionally leaves the Secret Service item in place. After the feature is
disabled, remove only its credential with:

```bash
secret-tool clear service codex-desktop-openai-transcription
```

OpenWhispr is not a runtime dependency.
