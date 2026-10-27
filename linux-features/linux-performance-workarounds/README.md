# Linux performance workarounds

Disabled-by-default renderer workarounds for machines where sidebar scrolling,
app-shell tab layout, or streaming Markdown animations regress. Enable only after a
measured problem on the official Linux runtime.

The current tab workaround follows the redesigned app-shell tab owner and
disables only its layout animation by replacing the owner's `animateLayout`
expression with `false`. Its semantic matcher requires exactly one coherent
owner correlating `animateLayout` and `animateExit` with the tab's
workspace-home state, `closeButtonTabIndex: -1`, its controller,
`dragActivator: "tab"`, and the same tab object. Missing, duplicate, mixed,
partial, or drifted owners fail closed and remain byte-identical.

Enable it in `linux-features/features.json` only for a reproduced regression:

```json
{ "enabled": ["linux-performance-workarounds"] }
```

These are upstream-bundle patches, not baseline compatibility code. Retest the
measured regression and run:

```bash
node --test linux-features/linux-performance-workarounds/test.js
```

## Catalog subfeatures

The community feature catalog lists these user-facing capabilities separately:

- **Sidebar scrolling workaround** (`sidebar-scrolling`): Apply the measured Linux sidebar scrolling workaround.
- **Tab layout workaround** (`tab-layout`): Disable the affected app-shell tab layout animation.
- **Streaming Markdown workaround** (`streaming-markdown`): Reduce the affected streaming Markdown animation overhead.

These declarations use `enabledWhen: "parent"`: all are included whenever this
feature is built. They add no independent configuration switches and do not
report runtime activation, permissions, external dependencies or backend health.
