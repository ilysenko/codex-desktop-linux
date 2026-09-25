# Linux performance workarounds

Disabled-by-default renderer workarounds for machines where sidebar scrolling,
app-shell tab layout, or streaming Markdown animations regress. Enable only after a
measured problem on the official Linux runtime.

The current tab workaround follows the redesigned app-shell owner: it disables
the collapsed mount animation and schedules the tab-label overflow read on the
next animation frame. Its semantic matcher requires exactly one coherent mount
and measurement contract and skips duplicate, mixed, partial, or drifted owners.

Enable it in `linux-features/features.json` only for a reproduced regression:

```json
{ "enabled": ["linux-performance-workarounds"] }
```

These are upstream-bundle patches, not baseline compatibility code. Retest the
measured regression and run:

```bash
node --test linux-features/linux-performance-workarounds/test.js
```
