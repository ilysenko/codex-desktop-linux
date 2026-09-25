# Linux performance workarounds

Disabled-by-default renderer workarounds for machines where sidebar scrolling
or streaming Markdown animations regress. Enable only after a
measured problem on the official Linux runtime.

Enable it in `linux-features/features.json` only for a reproduced regression:

```json
{ "enabled": ["linux-performance-workarounds"] }
```

These are upstream-bundle patches, not baseline compatibility code. Retest the
measured regression and run:

```bash
node --test linux-features/linux-performance-workarounds/test.js
```
