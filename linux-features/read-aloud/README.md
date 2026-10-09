# Read aloud

Opt-in Linux read-aloud support for assistant responses.

This feature stays thin. It does not bundle a voice model and it does not speak
automatically. It adds an explicit icon button under assistant messages. A click
is the only app-rendering path that starts speech.

## Enable the feature

Add the feature to `linux-features/features.json`:

```json
{
  "enabled": ["read-aloud"]
}
```

Then rebuild/package the app. The installed app remains silent until the user
explicitly clicks a message's speech icon, uses conversation mode, or calls the
Read Aloud MCP tool. For scripted launches that need to force-enable direct
runtime calls, set the runtime opt-in:

```bash
mkdir -p ~/.config/codex-desktop
node -e 'const fs=require("fs"),p=process.env.HOME+"/.config/codex-desktop/settings.json";let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}s["codex-linux-read-aloud-enabled"]=true;fs.writeFileSync(p,JSON.stringify(s,null,2)+"\n")'
```

or:

```bash
CODEX_LINUX_READ_ALOUD_ENABLED=1 codex-desktop
```

The generated Read Aloud settings page also gets setup controls for machines
where the default Kokoro paths are not ready:

- `Choose folder` stores a folder that already contains `kokoro-v1.0.onnx` and
  `voices-v1.0.bin`.
- `Download voice` creates the default Python runtime and downloads the Kokoro
  model files into the default data directory.
- `Speech pace` controls Kokoro playback speed from `0.70x` to `1.40x`
  and stores the value in `codex-linux-read-aloud-kokoro-speed`.

Nothing is downloaded during app install or on first launch.

## Conversation mode direction

The current feature intentionally stops at an explicit output button. A
higher-level conversation mode should be layered on top of this instead of
hidden inside message rendering:

- enter an explicit voice/conversation mode from the UI or by user instruction;
- stream microphone audio through a separate opt-in STT component;
- after a short quiet period, submit the transcribed user turn to Codex;
- stream the assistant response into the voice backend as chunks become stable;
- when the user starts talking again, call `stop` and steer the active response.

That keeps the safe primitive small while leaving room for a real back-and-forth
voice experience.

For the first agent-facing primitive, enable `linux-features/read-aloud-mcp`.
That stages a separate `read-aloud` MCP plugin with `doctor`, `read_aloud`, and
`stop` tools. It reuses the same Kokoro paths and runtime overrides documented
below.

## Voice model

Default speech uses an opt-in Kokoro ONNX runtime, similar in shape to `readd`
but not dependent on a local `readd` checkout. The app stages only a tiny runner.
The app selects a Kokoro voice and language code from the detected language;
the first validation target is Chinese with `zf_xiaobei` and `cmn` using the
existing v1.0 model/voice files.
Automatic detection counts Unicode letters in the cleaned response and switches
from English only when a supported script accounts for more than 60% of them.
Digits, punctuation, whitespace and combining marks do not affect the count.
Japanese combines Han and kana letters only when kana make up at least 20%
of those letters; otherwise Han contributes to Chinese. This conservative
guard keeps short kana examples from switching a Chinese response to Japanese.
Kanji-heavy Japanese may need an explicit language override. Short non-Latin examples in a mostly English response
therefore keep the English voice. Ties and other ambiguous text default to
English; this is a character-count heuristic, not a general language detector.
It chooses one voice for the whole response rather than switching voices
between fragments, so occasional foreign words may be pronounced imperfectly.
Set `CODEX_LINUX_READ_ALOUD_LANGUAGE` to an explicit language code (such as `es`,
`fr`, `de`, `it`, or `pt`) to override automatic detection. Existing explicit Kokoro voice/language
overrides also bypass automatic unsupported-language fallback; when no automatic
Kokoro mapping exists, unspecified Kokoro values retain the English defaults.
Users provide or download the model files and Python runtime outside the Electron
bundle.

Default paths:

- Python runtime: `~/.local/share/codex-desktop/read-aloud/kokoro-venv/bin/python`
- Model: `~/.local/share/kokoro/kokoro-v1.0.onnx`
- Voices: `~/.local/share/kokoro/voices-v1.0.bin`

Install the Python runtime and model files from the command line:

```bash
bash linux-features/read-aloud/install-kokoro-runtime.sh
```

Set `CODEX_LINUX_READ_ALOUD_SKIP_MODEL_DOWNLOAD=1` to install only the Python
runtime.

Runtime overrides:

- `CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON`
- `CODEX_LINUX_READ_ALOUD_KOKORO_MODEL`
- `CODEX_LINUX_READ_ALOUD_KOKORO_VOICES`
- `CODEX_LINUX_READ_ALOUD_KOKORO_VOICE`, overrides the automatic language voice; English defaults to `bm_george`
- `CODEX_LINUX_READ_ALOUD_KOKORO_LANGUAGE_VOICE`, optional voice override with precedence over `CODEX_LINUX_READ_ALOUD_KOKORO_VOICE`
- `CODEX_LINUX_READ_ALOUD_KOKORO_SPEED`, default `1.05`, clamped to `0.70`-`1.40`
- `CODEX_LINUX_READ_ALOUD_KOKORO_LANG`, overrides the automatic language; English defaults to `en-us`
- `CODEX_LINUX_READ_ALOUD_KOKORO_THREADS`, default `4`
- `CODEX_LINUX_READ_ALOUD_KOKORO_FIRST_CHARS`, default `90`
- `CODEX_LINUX_READ_ALOUD_KOKORO_CHUNK_CHARS`, default `180`
- `CODEX_LINUX_READ_ALOUD_KOKORO_MODEL_URL`
- `CODEX_LINUX_READ_ALOUD_KOKORO_VOICES_URL`

Kokoro speech is chunk-streamed: the runner synthesizes a short first chunk and
starts writing PCM to `aplay`, then prepares the next chunks while audio is
already playing. It does not synthesize the whole assistant response before
playback starts.

The default downloads use Hugging Face-hosted Kokoro files that match the
`kokoro-onnx` runtime shape:

- `https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/kokoro-v1.0.onnx`
- `https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/voices-v1.0.bin`

The settings page has a `?` help affordance beside the setup actions. It
summarizes the two supported setup paths: choose a local folder containing
`kokoro-v1.0.onnx` and `voices-v1.0.bin`, or let Codex create the managed Python
runtime and download those files into the default data directory.

For private/local setups, a custom command can still be used. Codex writes the
cleaned response text to stdin:

```bash
CODEX_LINUX_READ_ALOUD_COMMAND="/path/to/tts-stdin-command" codex-desktop
```

When Kokoro is not ready, Read Aloud can fall back to system TTS through
`spd-say` or `espeak-ng`. This fallback is enabled by default only after the
user has opted into the Read Aloud feature/runtime; Kokoro remains the preferred
backend when it is available. Disable the native fallback if the machine voice
is not acceptable:

```bash
CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK=0 codex-desktop
```

The handler never invokes a shell for response text.

Validate the UI, Electron bridge, and Kokoro staging behavior with:

```bash
node --test linux-features/read-aloud/test.js
```
