# Read Aloud MCP

Opt-in Linux MCP plugin for reading text aloud.

This feature stages a separate `read-aloud` Codex plugin with a native Rust MCP
server. It does not enable microphone input or conversation mode. The first MCP
surface is intentionally small:

- `doctor` reports whether Kokoro, a custom command, or native fallback
  is available.
- `read_aloud` speaks text only when the user or agent explicitly asks for it.
- `stop` interrupts playback started by the MCP server.

## Enable

Add the feature to `linux-features/features.json` before rebuilding:

```json
{
  "enabled": ["read-aloud-mcp"]
}
```

After rebuilding and launching the app, the feature patches the app's bundled
plugin registry so `read-aloud` is auto-installed like Computer Use. The
launcher also syncs the bundled `Read Aloud` plugin into Codex's local plugin
cache. The Linux Feature flag is the opt-in that makes the agent-facing tool
available.

If you also want the response-level speaker button and settings UI, enable both
features:

```json
{
  "enabled": ["read-aloud", "read-aloud-mcp"]
}
```

The MCP feature reuses the same Kokoro defaults as the UI feature:

- Python runtime: `~/.local/share/chatgpt-desktop/read-aloud/kokoro-venv/bin/python`
- Model: `~/.local/share/kokoro/kokoro-v1.0.onnx`
- Voices: `~/.local/share/kokoro/voices-v1.0.bin`

Install the runtime and model files with:

```bash
bash linux-features/read-aloud/install-kokoro-runtime.sh
```

or use the Read Aloud settings page download flow when the `read-aloud` UI
feature is enabled.

## Runtime Overrides

The MCP server reads the same overrides as the UI feature:

- `CODEX_LINUX_READ_ALOUD_COMMAND`
- `CODEX_LINUX_READ_ALOUD_KOKORO_RUNNER`
- `CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON`
- `CODEX_LINUX_READ_ALOUD_KOKORO_MODEL`
- `CODEX_LINUX_READ_ALOUD_KOKORO_VOICES`
- `CODEX_LINUX_READ_ALOUD_KOKORO_VOICE`
- `CODEX_LINUX_READ_ALOUD_KOKORO_SPEED`
- `CODEX_LINUX_READ_ALOUD_KOKORO_LANG`
- `CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK=0`

Native `spd-say` / `espeak-ng` fallback is available by default after this
opt-in MCP plugin is enabled, but Kokoro remains preferred. Set
`CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK=0` to disable the machine voice
fallback.

## Validate

```bash
node linux-features/read-aloud-mcp/test.js
cargo check -p codex-read-aloud-linux
cargo test -p codex-read-aloud-linux
```
