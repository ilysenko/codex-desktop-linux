# SPDX-License-Identifier: MIT
# KWin 6.6 for scripts/virtual_pen_kwin_test.py: kwin_wayland on a DRM
# device, GTK 4 for the target window, and the KDE config tools the
# virtual pen uses.
FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        kwin-wayland kwin-common kwin-style-breeze breeze-cursor-theme \
        dbus libglib2.0-bin qdbus-qt6 libkscreen-bin qt6-wayland libkf6config-bin \
        python3 python3-gi gir1.2-gtk-4.0 libgtk-4-1 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
