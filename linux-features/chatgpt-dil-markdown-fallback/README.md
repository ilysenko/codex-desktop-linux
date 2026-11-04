# ChatGPT reply Markdown fallback

ChatGPT replies created on mobile can include an interactive DIL presentation
alongside a saved Markdown answer. The DIL presentation uses a separate sandbox
at `cdn.platform.openai.com`. A blocked or unavailable runner can otherwise hide
the entire answer behind “This response couldn’t load”.

This feature displays the server-provided, version 1 `fallbackMarkdown` through
the existing ChatGPT Markdown renderer when the interactive renderer fails.
Working interactive replies keep their normal behavior. The fallback preserves
text, tables, code and ordinary links; interactive controls are unavailable in
the fallback. Replies without valid, nonempty fallback Markdown retain the
upstream error message. The original conversation and security policies are
unchanged. The feature does not execute the DIL program as Markdown.

The saved-content fallback disables streaming presentation, including for old
interrupted or partial replies. New saved text can still update normally.

The feature is disabled by default. Add `chatgpt-dil-markdown-fallback` to
`linux-features/features.json` and rebuild. Remove the ID and rebuild to disable.
The build fails if the unique upstream renderer contracts have changed.
The Markdown view is resolved from the unique rspack module exporting the
named `ChatGptMarkdown` component; minified export letters are not used. The
registration must target the factory's own exports parameter, with the named
component in the direct getter record or optional value record. Nested calls,
unrelated objects and same-named properties outside that record do not count.
The reply chunk must already require that module from a sibling renderer, so it is
loaded together with the reply. The module is required only when a failure is
rendered; if it cannot be resolved, the upstream error message is kept.

An existing patch is accepted only when the complete version 1 helper is at the
reply factory's own scope and its injected reference, JSX and original failure
flow match. Nested helpers, orphan calls and damaged helper bodies are rejected.
Every physical copy of the reply module is validated before writing; mixed
pristine/applied copies are rejected, and an interrupted write restores the
original bytes.

## Validation

```sh
node --test linux-features/chatgpt-dil-markdown-fallback/test.js
# Include the current official module, executable failure seam and descriptor checks:
CODEX_SIGNED_EXTRACTED_APP=/path/to/extracted/app.asar \
  node --test linux-features/chatgpt-dil-markdown-fallback/test.js
```

The signed-source checks use independent copies of the relevant official
assets. They execute the actual injected helper and failure expression with
the current factory require and native JSX bindings; they do not launch the app.

Build against the signed official package with this feature alone. Open a mobile
conversation, block the DIL runner and verify that the saved answer renders as
Markdown. With the runner available, verify interactive rendering still works.
