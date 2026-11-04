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
reply chunk must already require that module from a sibling renderer, so it is
loaded together with the reply. The module is required only when a failure is
rendered; if it cannot be resolved, the upstream error message is kept.

## Validation

```sh
node --test linux-features/chatgpt-dil-markdown-fallback/test.js
```

Build against the signed official package with this feature alone. Open a mobile
conversation, block the DIL runner and verify that the saved answer renders as
Markdown. With the runner available, verify interactive rendering still works.
