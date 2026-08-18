# Stable Linux Pet Overlay

This disabled-by-default feature hardens the official Linux avatar overlay
window for Plasma Wayland/Xwayland. It keeps the upstream renderer, mascot
animation, bubble/tray layout, voice controls, placement helpers, and direct
pet interaction intact while stabilizing the main-process window lifecycle.

The feature is an alternative to `pet-overlay`; the two features declare a
conflict and must not be enabled together. The existing `pet-overlay` feature
and its compositor-specific KWin, Niri, Hyprland, and COSMIC behavior are left
unchanged.

When enabled, the Linux overlay:

- coalesces drag geometry to one latest-wins commit per 16 ms slot;
- retains a short, bounded release fling (1,400 px/s, 24 px per frame, 350 ms,
  and at most one 35% edge bounce);
- acknowledges asynchronous Xwayland/KWin notifications for programmatic
  moves before the upstream persistence path sees them;
- applies pet-size revisions atomically around dragging and move reconciliation;
- validates content bounds and clips input-shape rectangles so transparent
  regions remain click-through; and
- recovers to the last valid on-display layout if a geometry loop or malformed
  renderer update is observed.

The existing 80–224 px pet-size range and persisted profile settings are not
changed. Invalid overlay position data is discarded narrowly and replaced by
one clamped position; authentication, pet selection, pet size, and unrelated
settings are preserved.

Enable it for a local build with:

```bash
CODEX_LINUX_FEATURES='pet-overlay-stability' make setup-native
```

The committed repository default remains disabled.
