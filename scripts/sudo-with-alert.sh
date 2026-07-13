#!/usr/bin/env bash
set -eu

play_sudo_alert_command() {
    if command -v timeout >/dev/null 2>&1; then
        timeout 1s "$@"
    else
        "$@"
    fi
}

play_sudo_alert() {
    local sound_file

    sound_file="${CODEX_SUDO_ALERT_SOUND_FILE:-/usr/share/sounds/freedesktop/stereo/dialog-warning.oga}"
    if command -v pw-play >/dev/null 2>&1 \
        && [ -r "$sound_file" ] \
        && play_sudo_alert_command pw-play "$sound_file" >/dev/null 2>&1; then
        return 0
    fi

    if command -v paplay >/dev/null 2>&1 \
        && [ -r "$sound_file" ] \
        && play_sudo_alert_command paplay "$sound_file" >/dev/null 2>&1; then
        return 0
    fi

    if command -v canberra-gtk-play >/dev/null 2>&1 \
        && play_sudo_alert_command canberra-gtk-play -i dialog-warning >/dev/null 2>&1; then
        return 0
    fi

    for sound_file in \
        /usr/share/sounds/alsa/Front_Center.wav \
        /usr/share/sounds/sound-icons/prompt.wav; do
        if command -v aplay >/dev/null 2>&1 \
            && [ -r "$sound_file" ] \
            && play_sudo_alert_command aplay -q "$sound_file" >/dev/null 2>&1; then
            return 0
        fi
    done

    printf '\a' >&2 || true
}

if [ "${CODEX_SUDO_ALERT:-0}" != "1" ]; then
    exec sudo "$@"
fi

if sudo -n -v 2>/dev/null; then
    exec sudo "$@"
fi

play_sudo_alert || true
sudo -v
exec sudo "$@"
