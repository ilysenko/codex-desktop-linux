Name:           __PACKAGE_NAME__
Version:        __RPM_VERSION__
Release:        __RPM_RELEASE__%{?dist}
Summary:        Codex Desktop for Linux
License:        Proprietary
ExclusiveArch:  __ARCH__

Requires:       python3, p7zip, polkit, curl, unzip, gcc-c++, make
Requires:       alsa-lib, at-spi2-atk, atk, glib2, gtk3, libdrm
Requires:       nspr, nss, pango, libstdc++, libX11, libxcb
Requires:       libXcomposite, libXdamage, libXext, libXfixes, libxkbcommon, libXrandr
Requires:       mesa-libgbm
Recommends:     zenity, kdialog
Recommends:     nodejs >= 22.22.0, npm

%description
Community-built Linux package for Codex Desktop generated from the macOS DMG.
Requires the Codex CLI to be available in PATH or CODEX_CLI_PATH.
Local auto-updates rebuild a Linux package from the upstream Codex.dmg and therefore
require Node.js 20+ with npm/npx from the system or a user-managed install such
as nvm, plus the local packaging toolchain listed in Requires.

%install
# Files are staged by build-rpm.sh outside of BUILDROOT and copied here.
mkdir -p %{buildroot}
cp -a "__RPM_STAGING_DIR__/." "%{buildroot}/"

%files
%defattr(-,root,root,-)
/opt/__PACKAGE_NAME__/
/usr/bin/__PACKAGE_NAME__
/usr/bin/codex-update-manager
/usr/lib/systemd/user/codex-update-manager.service
/usr/share/applications/__PACKAGE_NAME__.desktop
/usr/share/icons/hicolor/256x256/apps/__PACKAGE_NAME__.png
/usr/share/polkit-1/actions/com.github.ilysenko.codex-desktop-linux.update.policy

%post
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

SERVICE_HELPER=/opt/__PACKAGE_NAME__/update-builder/packaging/linux/codex-update-manager-user-service.sh
if [ -f "$SERVICE_HELPER" ]; then
    . "$SERVICE_HELPER"
    codex_ensure_user_service_running || true
fi

%preun
SERVICE_HELPER=/opt/__PACKAGE_NAME__/update-builder/packaging/linux/codex-update-manager-user-service.sh
[ -f "$SERVICE_HELPER" ] && . "$SERVICE_HELPER"
if [ $1 -eq 0 ] && [ -f "$SERVICE_HELPER" ]; then
    codex_cleanup_user_service stop || true
    codex_cleanup_user_service disable || true
fi

%postun
SERVICE_HELPER=/opt/__PACKAGE_NAME__/update-builder/packaging/linux/codex-update-manager-user-service.sh
if [ -f "$SERVICE_HELPER" ]; then
    . "$SERVICE_HELPER"
    codex_reload_user_managers || true
fi

%changelog
* Thu Jan 01 2026 Codex Desktop Linux Maintainers <maintainers@codex-desktop-linux>
- Initial RPM package
