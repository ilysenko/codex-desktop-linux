Name:           __PACKAGE_NAME__
Version:        __RPM_VERSION__
Release:        __RPM_RELEASE__%{?dist}
Summary:        ChatGPT Community for Linux
License:        Proprietary
ExclusiveArch:  __ARCH__
%global __requires_exclude_from ^/opt/__PACKAGE_NAME__/.*$
%global __provides_exclude_from ^/opt/__PACKAGE_NAME__/.*$
%global codex_elf_suffix %{nil}
%ifarch x86_64 aarch64
%global codex_elf_suffix ()(64bit)
%endif

%if __PACKAGE_WITH_UPDATER__
Requires:       polkit, curl, dpkg, nodejs, xdg-utils
%if 0%{?suse_version}
Requires:       gpg2
%else
Requires:       gnupg2
%endif
%else
Requires:       xdg-utils
%endif
Requires:       libasound.so.2%{codex_elf_suffix}, libatk-bridge-2.0.so.0%{codex_elf_suffix}
Requires:       libatk-1.0.so.0%{codex_elf_suffix}, libatspi.so.0%{codex_elf_suffix}, libcairo.so.2%{codex_elf_suffix}, libcups.so.2%{codex_elf_suffix}
Requires:       libdbus-1.so.3%{codex_elf_suffix}, libexpat.so.1%{codex_elf_suffix}, libgdk_pixbuf-2.0.so.0%{codex_elf_suffix}
Requires:       libglib-2.0.so.0%{codex_elf_suffix}, libgtk-3.so.0%{codex_elf_suffix}, libnotify.so.4%{codex_elf_suffix}
Requires:       libdrm.so.2%{codex_elf_suffix}, libnspr4.so%{codex_elf_suffix}, libnss3.so%{codex_elf_suffix}
Requires:       libpango-1.0.so.0%{codex_elf_suffix}, libssl.so.3%{codex_elf_suffix}, libstdc++.so.6%{codex_elf_suffix}
Requires:       libudev.so.1%{codex_elf_suffix}, libusb-1.0.so.0%{codex_elf_suffix}, libX11.so.6%{codex_elf_suffix}
Requires:       libX11-xcb.so.1%{codex_elf_suffix}, libxcb.so.1%{codex_elf_suffix}, libxcb-dri3.so.0%{codex_elf_suffix}
Requires:       libXcomposite.so.1%{codex_elf_suffix}, libXdamage.so.1%{codex_elf_suffix}
Requires:       libXext.so.6%{codex_elf_suffix}, libXfixes.so.3%{codex_elf_suffix}, libxkbcommon.so.0%{codex_elf_suffix}
Requires:       libXrandr.so.2%{codex_elf_suffix}, libgbm.so.1%{codex_elf_suffix}, libGL.so.1%{codex_elf_suffix}
Requires:       libgraphite2.so.3%{codex_elf_suffix}, xz, __LINUX_FEATURE_DEPENDENCIES__
Recommends:     zenity, kdialog

%description
Custom codex-desktop distribution built from OpenAI's signed official Linux package.
The complete official runtime, Codex CLI, rg, and code-mode host are bundled.
%if __PACKAGE_WITH_UPDATER__
Local updates verify OpenAI's signed APT metadata and rebuild from the indexed Linux package.
%else
This package was built without codex-update-manager. Update manually from a trusted checkout.
%endif

%install
# Files are staged by build-rpm.sh outside of BUILDROOT and copied here.
mkdir -p %{buildroot}
cp -a "__RPM_STAGING_DIR__/." "%{buildroot}/"

%files
%defattr(-,root,root,-)
/opt/__PACKAGE_NAME__/
/etc/apparmor.d/__PACKAGE_NAME__
/usr/bin/__PACKAGE_NAME__
%if __PACKAGE_WITH_UPDATER__
/usr/bin/codex-update-manager
/usr/lib/systemd/user/codex-update-manager.service
%endif
/usr/share/applications/__PACKAGE_NAME__.desktop
/usr/share/icons/hicolor/256x256/apps/__PACKAGE_NAME__.png
__LINUX_FEATURE_FILES__
%if __PACKAGE_WITH_UPDATER__
/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy
%endif

%post
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
if command -v aa-enabled >/dev/null 2>&1 && command -v apparmor_parser >/dev/null 2>&1 &&
   aa-enabled --quiet && [ -f /etc/apparmor.d/__PACKAGE_NAME__ ]; then
    apparmor_parser -r -W -T /etc/apparmor.d/__PACKAGE_NAME__ >/dev/null 2>&1 || true
fi
DESKTOP_ENTRY_DOCTOR=/opt/__PACKAGE_NAME__/.codex-linux/codex-desktop-entry-doctor.sh
if [ -f "$DESKTOP_ENTRY_DOCTOR" ]; then
    . "$DESKTOP_ENTRY_DOCTOR"
    codex_desktop_repair_system_package_shadow_entries __PACKAGE_NAME__ || true
fi

%if __PACKAGE_WITH_UPDATER__
SERVICE_HELPER=/opt/__PACKAGE_NAME__/update-builder/packaging/linux/codex-update-manager-user-service.sh
if [ -f "$SERVICE_HELPER" ]; then
    . "$SERVICE_HELPER"
    if [ "${1:-0}" -eq 1 ]; then
        codex_ensure_user_service_running || true
    else
        codex_start_enabled_user_service || true
    fi
fi
%else
CLEANUP_HELPER=/opt/__PACKAGE_NAME__/.codex-linux/codex-no-updater-transition-cleanup.sh
if [ -f "$CLEANUP_HELPER" ]; then
    . "$CLEANUP_HELPER"
    codex_no_updater_cleanup_update_manager_service || true
fi
%endif

%if __PACKAGE_WITH_UPDATER__
%preun
SERVICE_HELPER=/opt/__PACKAGE_NAME__/update-builder/packaging/linux/codex-update-manager-user-service.sh
[ -f "$SERVICE_HELPER" ] && . "$SERVICE_HELPER"
if [ $1 -eq 0 ] && [ -f "$SERVICE_HELPER" ]; then
    codex_cleanup_user_service stop || true
    codex_cleanup_user_service disable || true
fi
%else
%preun
CLEANUP_HELPER=/opt/__PACKAGE_NAME__/.codex-linux/codex-no-updater-transition-cleanup.sh
if [ -f "$CLEANUP_HELPER" ]; then
    . "$CLEANUP_HELPER"
    codex_no_updater_cleanup_update_manager_service || true
fi
%endif

%if __PACKAGE_WITH_UPDATER__
%postun
SERVICE_HELPER=/opt/__PACKAGE_NAME__/update-builder/packaging/linux/codex-update-manager-user-service.sh
if [ -f "$SERVICE_HELPER" ]; then
    . "$SERVICE_HELPER"
    codex_reload_user_managers || true
fi
%endif

%changelog
* Thu Jan 01 2026 ChatGPT Community for Linux Maintainers <maintainers@codex-desktop-linux>
- Initial RPM package
