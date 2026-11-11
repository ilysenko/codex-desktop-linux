#!/usr/bin/env bash
set -Eeo pipefail

if [ -z "${CODEX_ELECTRON_DISABLE_GPU_COMPOSITING+x}" ]; then
    printf '%s\n' 'env CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=0'
fi


# Modern Hyprland exposes compositor-side Lua dispatchers only when its Lua
# configuration provider is active. Probe once in the launcher, not on the
# renderer's pointer or layout hot paths. Older/hyprlang sessions keep the
# existing non-Lua fallback instead of consuming a drag with no compositor.
hyprland_session=0
case "${XDG_CURRENT_DESKTOP:-}:${DESKTOP_SESSION:-}" in
    *Hyprland*|*hyprland*) hyprland_session=1 ;;
esac
[ -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] || hyprland_session=1
if [ "$hyprland_session" = 1 ] &&
   [ -z "${CODEX_PET_HYPRLAND_LUA_SUPPORTED+x}" ]; then
    hyprland_status=""
    if command -v hyprctl >/dev/null 2>&1 &&
       command -v timeout >/dev/null 2>&1; then
        hyprland_status="$(timeout 2s hyprctl status -j 2>/dev/null || true)"
    fi
    if printf '%s\n' "$hyprland_status" |
       grep -Eq '"configProvider"[[:space:]]*:[[:space:]]*"lua"'; then
        printf '%s\n' 'env CODEX_PET_HYPRLAND_LUA_SUPPORTED=1'
    else
        printf '%s\n' 'env CODEX_PET_HYPRLAND_LUA_SUPPORTED=0'
    fi
fi
