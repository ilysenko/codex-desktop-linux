# Locked Computer Use Research

This document is research only. It does not enable locked Computer Use on Linux,
does not fake remote unlock, and does not add any lock-screen bypass.

## Boundary

The upstream locked Computer Use path is macOS-specific and uses an Apple
authorization plug-in during the macOS unlock flow. This Linux package cannot
claim the same mechanism or the same security boundary. Any Linux equivalent
would need its own design, review, and explicit opt-in before code is written.

## Threat Model Questions

- Which user is allowed to unlock or keep an agent session alive?
- How is consent captured while the screen is locked?
- What prevents remote-control pairing or a browser bridge from escalating into
  a local unlock primitive?
- How are secrets, screenshots, window titles, and conversation contents kept
  out of logs while the session is locked?
- What is the failure mode when the compositor, display manager, keyring, or
  portal refuses access?

## Linux Primitives To Research

- Display-manager and PAM extension points for explicit user-approved unlock
  flows.
- GNOME, KDE Plasma, COSMIC, Sway, Hyprland, and X11 compositor behavior while
  the session is locked.
- XDG portals and whether any portal-backed interaction is still available
  after the lock screen is active.
- Secret Service and KWallet lock behavior during session lock and unlock.
- `systemd --user` inhibitor and sleep/idle behavior when a Codex turn is
  active.
- Hardware-backed local presence signals, if available, without exposing a
  bypass path.

## Non-Goals

- No lock-screen bypass.
- No fake remote unlock.
- No persistence, stealth, or credential capture.
- No use of browser tabs, screenshots, or private conversation text as proof.
- No implementation that depends on debug-only Codex flags or a modified
  upstream server.

## Acceptance Gates Before Code

1. A written threat model covering assets, trust boundaries, attacker
   capabilities, and failure modes.
2. A compositor/display-manager matrix that identifies supported, unsupported,
   and unknown lock behavior separately.
3. A consent model that is explicit, local, revocable, and visible to the user.
4. A test plan that records only booleans, enums, and counts.
5. A code review focused on privilege boundaries and log redaction.

Until those gates are met, Linux locked Computer Use remains not implemented.
