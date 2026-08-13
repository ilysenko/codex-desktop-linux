# Hover Scrollbars

Official Linux Chromium uses classic scrollbars. The same
`overflow-y-auto` surfaces overlay-hide on macOS, including the project
sidebar and chat thread. After the official Linux package migration those
scrollers stay visible because official CSS sets `scrollbar-color` on every
overflow class.

This feature restores the previous hover-hide behaviour. It injects official
`scrollbar-on-hover` rules onto all `overflow-auto` / `overflow-y-auto` /
`overflow-x-auto` scrollers and drops reserved `scrollbar-gutter: stable`
space so Linux does not keep an empty track.

The repository leaves it disabled by default so a clean build still preserves
`resources/app.asar`. Enable it to restore the pre-migration look:

```json
{
  "enabled": ["hover-scrollbars"]
}
```

Then rebuild with `./install.sh` or `make install-native`. A reload is not
enough.

If the official app-initial bundle drifts, the contracts fail closed and the
candidate is left unchanged.

```bash
node --test linux-features/hover-scrollbars/test.js
```
