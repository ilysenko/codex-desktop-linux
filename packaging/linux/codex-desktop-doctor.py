#!/usr/bin/env python3
"""Safe installed-state doctor for Codex Desktop Linux packages."""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PACKAGE_NAME = "__PACKAGE_NAME__"
PASS = "pass"
WARN = "warn"
FAIL = "fail"
INFO = "info"


def run(args: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def check_port(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.35):
            return True
    except OSError:
        return False


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def linux_app_id(package_name: str) -> str:
    candidate = (os.environ.get("CODEX_LINUX_APP_ID") or os.environ.get("CODEX_APP_ID") or package_name or "codex-desktop").strip()
    if candidate in {"", ".", ".."}:
        return "codex-desktop"
    if any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for ch in candidate):
        return "codex-desktop"
    return candidate


def probe_node_runtime(node_path: Path) -> tuple[bool, str | None, str]:
    if not node_path.is_file() or not os.access(node_path, os.X_OK):
        return False, None, f"missing or not executable: {node_path}"

    try:
        result = run(
            [
                str(node_path),
                "-e",
                'process.stdout.write("codex-node-runtime-ok:" + process.versions.node)',
            ],
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, None, f"JS probe failed: {exc}"

    marker = "codex-node-runtime-ok:"
    output = (result.stdout or "").strip()
    if result.returncode == 0 and output.startswith(marker):
        version = output[len(marker) :]
        return True, version, f"{node_path} (node {version})"

    return False, None, f"JS probe did not return expected marker: exit={result.returncode}"


def add_check(
    checks: list[dict[str, Any]],
    check_id: str,
    label: str,
    status: str,
    detail: str,
    **data: Any,
) -> None:
    entry: dict[str, Any] = {
        "id": check_id,
        "label": label,
        "status": status,
        "detail": detail,
    }
    for key, value in data.items():
        if value is not None:
            entry[key] = value
    checks.append(entry)


def package_version(package_name: str) -> tuple[str, str]:
    if command_exists("dpkg-query"):
        result = run(["dpkg-query", "-W", "-f=${Version}", package_name], timeout=5)
        if result.returncode == 0 and result.stdout.strip():
            return "deb", result.stdout.strip()
    if command_exists("rpm"):
        result = run(["rpm", "-q", "--qf", "%{VERSION}-%{RELEASE}", package_name], timeout=5)
        if result.returncode == 0 and result.stdout.strip():
            return "rpm", result.stdout.strip()
    if command_exists("pacman"):
        result = run(["pacman", "-Q", package_name], timeout=5)
        if result.returncode == 0 and result.stdout.strip():
            parts = result.stdout.strip().split(maxsplit=1)
            return "pacman", parts[1] if len(parts) > 1 else result.stdout.strip()
    return "unknown", ""


def systemctl_user(args: list[str]) -> tuple[int, str]:
    if not command_exists("systemctl"):
        return 127, "systemctl missing"
    result = run(["systemctl", "--user", *args], timeout=5)
    output = (result.stdout or result.stderr).strip()
    return result.returncode, output


def first_existing_path(paths: list[Path]) -> Path | None:
    for path in paths:
        if path.exists():
            return path
    return None


def chrome_plugin_dir(app_root: Path) -> Path | None:
    home = Path.home()
    candidates = [
        home / ".codex/plugins/cache/openai-bundled/chrome/latest",
        app_root / "resources/plugins/openai-bundled/plugins/chrome",
    ]
    return next((candidate for candidate in candidates if candidate.exists()), None)


def chrome_metadata(plugin_dir: Path) -> tuple[str | None, str | None]:
    scripts_dir = plugin_dir / "scripts"
    config = read_json(scripts_dir / "extension-id.json") or {}
    extension_id = config.get("extensionId")
    host_name = config.get("extensionHostName")
    return (
        extension_id if isinstance(extension_id, str) else None,
        host_name if isinstance(host_name, str) else None,
    )


def run_json_script(script: Path, node: Path | None = None) -> tuple[int, dict[str, Any] | None, str]:
    if not script.is_file():
        return 127, None, f"missing script: {script}"
    node_binary = str(node) if node is not None and node.is_file() else shutil.which("node")
    if node_binary is None:
        return 127, None, "node missing"
    try:
        result = run([node_binary, str(script), "--json"], timeout=10)
    except subprocess.TimeoutExpired:
        return 124, None, f"timed out: {script.name}"
    data = None
    if result.stdout.strip():
        try:
            parsed = json.loads(result.stdout)
            if isinstance(parsed, dict):
                data = parsed
        except json.JSONDecodeError:
            data = None
    detail = (result.stderr or result.stdout).strip()
    return result.returncode, data, detail


def check_manifest_file(
    checks: list[dict[str, Any]],
    path: Path,
    extension_id: str | None,
    host_name: str | None,
    label: str,
    required: bool,
    flatpak_wrapper: bool = False,
) -> None:
    if not path.exists():
        add_check(
            checks,
            f"chrome_manifest_{label}",
            f"Chrome native host manifest ({label})",
            FAIL if required else INFO,
            f"not found: {path}",
            path=str(path),
        )
        return

    manifest = read_json(path)
    expected_origin = f"chrome-extension://{extension_id}/" if extension_id else None
    correct = (
        manifest is not None
        and (host_name is None or manifest.get("name") == host_name)
        and (
            expected_origin is None
            or expected_origin in (manifest.get("allowed_origins") or [])
        )
        and isinstance(manifest.get("path"), str)
        and Path(str(manifest.get("path"))).is_absolute()
    )
    host_path = Path(str(manifest.get("path"))) if manifest and isinstance(manifest.get("path"), str) else None
    if correct and host_path is not None and not host_path.exists():
        correct = False

    status = PASS if correct else FAIL
    detail = "manifest is correct" if correct else "manifest exists but is incomplete or points to a missing host"
    data: dict[str, Any] = {"path": str(path)}
    if host_path is not None:
        data["hostPath"] = str(host_path)

    if flatpak_wrapper and host_path is not None and host_path.exists():
        try:
            wrapper = host_path.read_text(encoding="utf-8")
        except OSError:
            wrapper = ""
        if "flatpak-spawn --host" not in wrapper:
            status = FAIL
            detail = "Flatpak wrapper does not call flatpak-spawn --host"

    add_check(
        checks,
        f"chrome_manifest_{label}",
        f"Chrome native host manifest ({label})",
        status,
        detail,
        **data,
    )


def chrome_profile_dirs(root: Path) -> list[Path]:
    try:
        entries = list(root.iterdir())
    except OSError:
        return []
    return [
        entry
        for entry in entries
        if entry.is_dir() and (entry.name == "Default" or re.fullmatch(r"Profile \d+", entry.name))
    ]


def chrome_profiles_with_extension(root: Path, extension_id: str | None) -> int:
    if not extension_id:
        return 0
    return sum(
        1
        for profile in chrome_profile_dirs(root)
        if (profile / "Local Extension Settings" / extension_id).is_dir()
    )


def browser_roots(home: Path) -> dict[str, Path]:
    return {
        "chrome": home / ".config/google-chrome",
        "brave": home / ".config/BraveSoftware/Brave-Browser",
        "chromium": home / ".config/chromium",
        "flatpak_chrome": home / ".var/app/com.google.Chrome/config/google-chrome",
    }


def proc_cmdlines() -> list[list[str]]:
    proc = Path("/proc")
    cmdlines: list[list[str]] = []
    try:
        entries = list(proc.iterdir())
    except OSError:
        return cmdlines
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        parts = [part.decode("utf-8", errors="ignore") for part in raw.split(b"\0") if part]
        if parts:
            cmdlines.append(parts)
    return cmdlines


def browser_family_from_cmdline(parts: list[str]) -> str | None:
    joined = "\0".join(parts).lower()
    exe = Path(parts[0]).name.lower() if parts else ""
    if "com.google.chrome" in joined and "flatpak" in joined:
        return "flatpak_chrome"
    if exe in {"brave", "brave-browser", "brave-browser-stable"}:
        return "brave"
    if exe in {"chromium", "chromium-browser"}:
        return "chromium"
    if exe in {"chrome", "google-chrome", "google-chrome-stable"}:
        return "chrome"
    return None


def cmdline_value(parts: list[str], name: str) -> str | None:
    prefix = f"{name}="
    for part in parts:
        if part.startswith(prefix):
            return part[len(prefix) :]
    return None


def chrome_live_profile_summary(home: Path, extension_id: str | None) -> dict[str, Any]:
    roots = browser_roots(home)
    profile_counts = {family: len(chrome_profile_dirs(root)) for family, root in roots.items()}
    extension_counts = {
        family: chrome_profiles_with_extension(root, extension_id)
        for family, root in roots.items()
    }

    running_family = "unknown"
    running_profile_detected = False
    selected_running_profile_enabled = None
    for parts in proc_cmdlines():
        family = browser_family_from_cmdline(parts)
        if family is None:
            continue
        running_family = family
        profile_directory = cmdline_value(parts, "--profile-directory")
        user_data_dir = cmdline_value(parts, "--user-data-dir")
        root = Path(user_data_dir).expanduser() if user_data_dir else roots.get(family)
        if root is not None and profile_directory:
            candidate = root / profile_directory
            running_profile_detected = candidate.is_dir()
            if extension_id:
                selected_running_profile_enabled = (
                    candidate / "Local Extension Settings" / extension_id
                ).is_dir()
        break

    total_profile_count = sum(profile_counts.values())
    total_extension_count = sum(extension_counts.values())
    return {
        "anyProfileEnabled": total_extension_count > 0,
        "browserFamily": running_family,
        "profileCount": total_profile_count,
        "profileRootCount": sum(1 for root in roots.values() if root.is_dir()),
        "profilesWithExtensionCount": total_extension_count,
        "runningBrowserDetected": running_family != "unknown",
        "runningProfileDetected": running_profile_detected,
        "selectedRunningProfileEnabled": selected_running_profile_enabled,
    }


def secret_service_canary(secret_tool: str, app_id: str) -> tuple[str, str]:
    value = f"codex-canary-{secrets.token_hex(16)}"
    attributes = [
        "application",
        "codex-desktop-linux",
        "app-id",
        app_id,
        "kind",
        "canary",
    ]
    store = subprocess.run(
        [secret_tool, "store", "--label", "Codex Desktop Linux canary", *attributes],
        check=False,
        input=value,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=8,
    )
    if store.returncode != 0:
        detail = (store.stderr or store.stdout or "secret-tool store failed").strip()
        lowered = detail.lower()
        if "locked" in lowered or "cancelled" in lowered or "canceled" in lowered:
            return WARN, "Secret Service canary unavailable: keyring locked or prompt cancelled"
        return WARN, "Secret Service canary unavailable: store failed"

    lookup = subprocess.run(
        [secret_tool, "lookup", *attributes],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=8,
    )
    try:
        subprocess.run(
            [secret_tool, "clear", *attributes],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
        )
    except (OSError, subprocess.SubprocessError):
        pass

    if lookup.returncode == 0 and lookup.stdout == value:
        return PASS, "store/lookup/clear succeeded"
    return WARN, "Secret Service canary lookup did not round-trip"


def checks_for_package(package_name: str) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    app_root = Path("/opt") / package_name
    launcher = Path("/usr/bin") / package_name
    doctor = Path("/usr/bin") / f"{package_name}-doctor"
    service_unit = Path("/usr/lib/systemd/user") / f"{package_name}.service"
    update_service = Path("/usr/lib/systemd/user/codex-update-manager.service")
    asar = app_root / "resources/app.asar"
    managed_node = app_root / "resources/node-runtime/bin/node"
    managed_node_ok, managed_node_version, managed_node_detail = probe_node_runtime(managed_node)
    build_info_paths = [
        app_root / ".codex-linux/build-info.json",
        app_root / "resources/codex-linux-build-info.json",
    ]

    manager, version = package_version(package_name)
    add_check(
        checks,
        "package",
        "Native package",
        PASS if version else WARN,
        f"{manager} {version}" if version else "not found through dpkg/rpm/pacman",
        packageManager=manager,
        version=version or None,
    )

    add_check(
        checks,
        "launcher",
        "Installed launcher",
        PASS if launcher.is_file() and os.access(launcher, os.X_OK) else FAIL,
        str(launcher),
        path=str(launcher),
    )
    add_check(
        checks,
        "doctor",
        "Installed doctor",
        PASS if doctor.is_file() and os.access(doctor, os.X_OK) else FAIL,
        str(doctor),
        path=str(doctor),
    )
    add_check(
        checks,
        "app_root",
        "Installed app root",
        PASS if (app_root / "start.sh").is_file() and os.access(app_root / "start.sh", os.X_OK) else FAIL,
        str(app_root),
        path=str(app_root),
    )
    add_check(
        checks,
        "electron_runtime",
        "Electron runtime",
        PASS if (app_root / "electron").is_file() and os.access(app_root / "electron", os.X_OK) else FAIL,
        str(app_root / "electron"),
        path=str(app_root / "electron"),
    )
    add_check(
        checks,
        "managed_node",
        "Managed Node.js runtime",
        PASS if managed_node_ok else FAIL,
        managed_node_detail,
        path=str(managed_node),
        version=managed_node_version,
    )
    build_info_path = first_existing_path(build_info_paths)
    build_info = read_json(build_info_path) if build_info_path is not None else None
    add_check(
        checks,
        "build_info",
        "Linux build metadata",
        PASS if build_info is not None else WARN,
        str(build_info_path) if build_info_path is not None else "not found",
        path=str(build_info_path) if build_info_path is not None else None,
        upstreamAppVersion=build_info.get("upstreamDmg", {}).get("appVersion") if build_info else None,
        electronVersion=build_info.get("electronVersion") if build_info else None,
        enabledFeatures=build_info.get("linuxFeatures", {}).get("enabled") if build_info else None,
    )

    if asar.is_file():
        try:
            source = asar.read_bytes()
        except OSError as exc:
            source = b""
            add_check(checks, "app_asar", "Installed app.asar", FAIL, str(exc), path=str(asar))
        else:
            add_check(checks, "app_asar", "Installed app.asar", PASS, str(asar), path=str(asar))
            has_flatpak = b".var" in source and b"com.google.Chrome" in source and b"google-chrome" in source
            add_check(
                checks,
                "asar_flatpak_chrome_status",
                "ASAR Flatpak Chrome status patch",
                PASS if has_flatpak else FAIL,
                "Flatpak Chrome profile root marker present" if has_flatpak else "Flatpak Chrome profile root marker missing",
            )
            remote_marker = app_root / ".codex-linux/remote-mobile-control-enabled"
            remote_expected = remote_marker.exists()
            has_remote = b"--remote-control" in source
            add_check(
                checks,
                "asar_remote_control",
                "ASAR remote-control launch patch",
                PASS if has_remote else (FAIL if remote_expected else INFO),
                (
                    "--remote-control marker present"
                    if has_remote
                    else "remote-mobile-control is enabled but --remote-control marker is missing"
                    if remote_expected
                    else "remote-mobile-control feature is not enabled in this build"
                ),
            )
    else:
        add_check(checks, "app_asar", "Installed app.asar", FAIL, f"missing: {asar}", path=str(asar))

    if service_unit.is_file():
        unit_text = service_unit.read_text(encoding="utf-8", errors="replace")
        expected_launcher = f"/usr/bin/{package_name}"
        status = PASS if expected_launcher in unit_text and "--remote-debugging-port" not in unit_text else FAIL
        add_check(
            checks,
            "app_service_unit",
            "Desktop app user service unit",
            status,
            f"{service_unit}",
            path=str(service_unit),
        )
    else:
        add_check(checks, "app_service_unit", "Desktop app user service unit", FAIL, f"missing: {service_unit}", path=str(service_unit))

    rc, active = systemctl_user(["is-active", f"{package_name}.service"])
    _, enabled = systemctl_user(["is-enabled", f"{package_name}.service"])
    add_check(
        checks,
        "app_service_state",
        "Desktop app user service state",
        PASS if active == "active" else INFO,
        f"active={active or rc} enabled={enabled or 'unknown'}",
        active=active or None,
        enabled=enabled or None,
    )

    add_check(
        checks,
        "updater_service_unit",
        "Updater user service unit",
        PASS if update_service.is_file() else INFO,
        str(update_service) if update_service.is_file() else "not installed in manual-update/AppImage mode",
        path=str(update_service),
    )
    update_builder = app_root / "update-builder"
    validator = update_builder / "scripts/ci/validate-patch-report.js"
    update_builder_node = update_builder / "node-runtime/bin/node"
    update_builder_node_ok, update_builder_node_version, update_builder_node_detail = probe_node_runtime(update_builder_node)
    add_check(
        checks,
        "update_builder",
        "Update-builder bundle",
        PASS if update_builder.is_dir() else INFO,
        str(update_builder) if update_builder.is_dir() else "not installed in manual-update/AppImage mode",
        path=str(update_builder),
    )
    add_check(
        checks,
        "patch_report_validator",
        "Patch-report validator in update-builder",
        PASS if validator.is_file() else (WARN if update_builder.is_dir() else INFO),
        str(validator) if validator.is_file() else "not staged",
        path=str(validator),
    )
    add_check(
        checks,
        "update_builder_managed_node",
        "Update-builder managed Node.js runtime",
        PASS if update_builder_node_ok else (WARN if update_builder.is_dir() else INFO),
        update_builder_node_detail if update_builder.is_dir() else "not installed in manual-update/AppImage mode",
        path=str(update_builder_node),
        version=update_builder_node_version,
    )
    staged_features = read_json(update_builder / "linux-features/features.json")
    if staged_features is not None:
        add_check(
            checks,
            "update_builder_features",
            "Update-builder enabled Linux features",
            INFO,
            ", ".join(staged_features.get("enabled", [])) if staged_features.get("enabled") else "none",
            enabled=staged_features.get("enabled"),
        )

    add_check(
        checks,
        "webview_port",
        "Webview server 127.0.0.1:5175",
        PASS if check_port(5175) else INFO,
        "listening" if check_port(5175) else "not listening",
        port=5175,
    )
    add_check(
        checks,
        "cdp_debug_port",
        "Optional CDP debug port 127.0.0.1:9333",
        INFO,
        "listening" if check_port(9333) else "not listening",
        port=9333,
    )

    plugin_dir = chrome_plugin_dir(app_root)
    if plugin_dir is None:
        add_check(checks, "chrome_plugin", "Chrome plugin cache/bundle", FAIL, "Chrome plugin not found")
        add_check(checks, "chrome_extension_installed", "Chrome extension install status", WARN, "Chrome plugin unavailable")
        add_check(checks, "chrome_manifest_probe", "Chrome native host manifest probe", WARN, "Chrome plugin unavailable")
        extension_id = host_name = None
    else:
        extension_id, host_name = chrome_metadata(plugin_dir)
        add_check(
            checks,
            "chrome_plugin",
            "Chrome plugin cache/bundle",
            PASS if extension_id and host_name else FAIL,
            str(plugin_dir),
            path=str(plugin_dir),
        )
        _, extension_status, extension_detail = run_json_script(plugin_dir / "scripts/check-extension-installed.js", managed_node)
        if extension_status is not None:
            installed = bool(extension_status.get("installed"))
            enabled_ext = bool(extension_status.get("enabled"))
            add_check(
                checks,
                "chrome_extension_installed",
                "Chrome extension install status",
                PASS if installed and enabled_ext else WARN,
                f"installed={installed} enabled={enabled_ext}",
                installed=installed,
                enabled=enabled_ext,
            )
        else:
            add_check(checks, "chrome_extension_installed", "Chrome extension install status", WARN, extension_detail or "unavailable")

        _, manifest_status, manifest_detail = run_json_script(plugin_dir / "scripts/check-native-host-manifest.js", managed_node)
        if manifest_status is not None:
            correct = bool(manifest_status.get("correct"))
            add_check(
                checks,
                "chrome_manifest_probe",
                "Chrome native host manifest probe",
                PASS if correct else WARN,
                manifest_status.get("problem") or "manifest probe ok",
                path=manifest_status.get("manifestPath"),
            )
        else:
            add_check(checks, "chrome_manifest_probe", "Chrome native host manifest probe", WARN, manifest_detail or "unavailable")

        if os.environ.get("CODEX_DESKTOP_LIVE_BROWSER_PROFILE_VALIDATION") == "1":
            if extension_id:
                live_summary = chrome_live_profile_summary(Path.home(), extension_id)
                observed = (
                    live_summary["profileRootCount"] > 0
                    or live_summary["profileCount"] > 0
                    or live_summary["runningBrowserDetected"]
                )
                add_check(
                    checks,
                    "chrome_live_profile_validation",
                    "Chrome live browser/profile validation",
                    PASS if observed else INFO,
                    (
                        f"profileRoots={live_summary['profileRootCount']} "
                        f"profiles={live_summary['profileCount']} "
                        f"profilesWithExtension={live_summary['profilesWithExtensionCount']}"
                    ),
                    **live_summary,
                )
            else:
                add_check(
                    checks,
                    "chrome_live_profile_validation",
                    "Chrome live browser/profile validation",
                    WARN,
                    "Chrome plugin metadata unavailable",
                    browserFamily="unknown",
                    runningBrowserDetected=False,
                    runningProfileDetected=False,
                )

    home = Path.home()
    if host_name:
        check_manifest_file(
            checks,
            home / ".config/google-chrome/NativeMessagingHosts" / f"{host_name}.json",
            extension_id,
            host_name,
            "google_chrome",
            required=False,
        )
        check_manifest_file(
            checks,
            home / ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts" / f"{host_name}.json",
            extension_id,
            host_name,
            "brave_browser",
            required=False,
        )
        check_manifest_file(
            checks,
            home / ".config/chromium/NativeMessagingHosts" / f"{host_name}.json",
            extension_id,
            host_name,
            "chromium",
            required=False,
        )
        flatpak_manifest = home / ".var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts" / f"{host_name}.json"
        flatpak_installed = command_exists("flatpak") and run(["flatpak", "info", "com.google.Chrome"], timeout=5).returncode == 0
        check_manifest_file(
            checks,
            flatpak_manifest,
            extension_id,
            host_name,
            "flatpak_chrome",
            required=flatpak_installed,
            flatpak_wrapper=True,
        )
        if flatpak_installed:
            permissions = run(["flatpak", "info", "--show-permissions", "com.google.Chrome"], timeout=5)
            has_talk = "org.freedesktop.Flatpak=talk" in permissions.stdout
            add_check(
                checks,
                "flatpak_chrome_permission",
                "Flatpak Chrome host permission",
                PASS if has_talk else FAIL,
                "org.freedesktop.Flatpak=talk present" if has_talk else "missing org.freedesktop.Flatpak=talk",
            )
        else:
            add_check(checks, "flatpak_chrome_permission", "Flatpak Chrome host permission", INFO, "Flatpak Google Chrome not installed")

    cu_doctor = app_root / "resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux"
    if cu_doctor.is_file() and os.access(cu_doctor, os.X_OK):
        try:
            result = run([str(cu_doctor), "doctor"], timeout=12)
            data = json.loads(result.stdout) if result.stdout.strip() else {}
            blockers = data.get("readiness", {}).get("blockers", []) if isinstance(data, dict) else []
            add_check(
                checks,
                "computer_use_doctor",
                "Computer Use doctor",
                PASS if result.returncode == 0 and not blockers else WARN,
                "blockers=0" if not blockers else f"blockers={len(blockers)}",
                blockersCount=len(blockers) if isinstance(blockers, list) else None,
            )
        except (subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            add_check(checks, "computer_use_doctor", "Computer Use doctor", WARN, str(exc))
    else:
        add_check(checks, "computer_use_doctor", "Computer Use doctor", WARN, "backend not installed")

    remote_marker = app_root / ".codex-linux/remote-mobile-control-enabled"
    remote_hook = app_root / ".codex-linux/cold-start.d/remote-mobile-control"
    remote_app_id = linux_app_id(package_name)
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    key_file = config_home / remote_app_id / "remote-control-device-keys-v1.json"
    legacy_key_file = config_home / "codex-desktop/remote-control-device-keys-v1.json" if remote_app_id != "codex-desktop" else None
    key_file_to_read = legacy_key_file if legacy_key_file is not None and legacy_key_file.exists() and not key_file.exists() else key_file
    if remote_marker.exists():
        add_check(checks, "remote_mobile_marker", "Remote mobile feature marker", PASS, str(remote_marker), path=str(remote_marker))
        add_check(
            checks,
            "remote_mobile_cold_start_hook",
            "Remote mobile cold-start hook",
            PASS if remote_hook.is_file() and os.access(remote_hook, os.X_OK) else FAIL,
            str(remote_hook),
            path=str(remote_hook),
        )
        secret_tool = shutil.which("secret-tool")
        add_check(
            checks,
            "remote_mobile_secret_service",
            "Remote mobile Secret Service helper",
            PASS if secret_tool else INFO,
            "secret-tool available; new keys prefer Secret Service"
            if secret_tool
            else "secret-tool missing; file fallback will be used",
            path=secret_tool,
        )
        if os.environ.get("CODEX_DESKTOP_SECRET_SERVICE_CANARY") == "1" or os.environ.get("CODEX_SECRET_SERVICE_CANARY") == "1":
            if secret_tool:
                try:
                    canary_status, canary_detail = secret_service_canary(secret_tool, remote_app_id)
                except (OSError, subprocess.SubprocessError) as exc:
                    canary_status, canary_detail = WARN, f"Secret Service canary unavailable: {type(exc).__name__}"
            else:
                canary_status, canary_detail = INFO, "secret-tool missing; canary skipped"
            add_check(
                checks,
                "remote_mobile_secret_service_canary",
                "Remote mobile Secret Service canary",
                canary_status,
                canary_detail,
                appId=remote_app_id,
            )
        key_mode = None
        key_count = None
        secret_service_key_count = None
        file_fallback_key_count = None
        if key_file_to_read.exists():
            key_mode = oct(key_file_to_read.stat().st_mode & 0o777)
            key_store = read_json(key_file_to_read) or {}
            keys = key_store.get("keys")
            if isinstance(keys, dict):
                records = [record for record in keys.values() if isinstance(record, dict)]
                key_count = len(records)
                secret_service_key_count = sum(1 for record in records if isinstance(record.get("secretService"), dict))
                file_fallback_key_count = sum(1 for record in records if isinstance(record.get("privateKeyPkcs8Pem"), str))
        add_check(
            checks,
            "remote_mobile_key_file",
            "Remote mobile key metadata/fallback file",
            PASS if key_file_to_read.exists() else INFO,
            f"{key_file_to_read} ({key_mode})" if key_mode else f"not found: {key_file}",
            path=str(key_file_to_read),
            appId=remote_app_id,
            legacyPath=str(legacy_key_file) if legacy_key_file is not None else None,
            mode=key_mode,
            keyCount=key_count,
            secretServiceKeyCount=secret_service_key_count,
            fileFallbackKeyCount=file_fallback_key_count,
        )
    else:
        add_check(checks, "remote_mobile_marker", "Remote mobile feature marker", INFO, "remote-mobile-control feature is not enabled")

    return checks


def print_text(report: dict[str, Any]) -> None:
    print(f"Codex Desktop Linux doctor ({report['packageName']})")
    for check in report["checks"]:
        print(f"[{check['status'].upper()}] {check['label']}: {check['detail']}")
    summary = report["summary"]
    print(
        "Summary: "
        f"{summary['pass']} pass, {summary['warn']} warn, "
        f"{summary['fail']} fail, {summary['info']} info"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Check an installed Codex Desktop Linux package.")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    parser.add_argument("--package-name", default=PACKAGE_NAME, help="installed package name")
    args = parser.parse_args()

    package_name = args.package_name
    checks = checks_for_package(package_name)
    summary = {
        PASS: sum(1 for check in checks if check["status"] == PASS),
        WARN: sum(1 for check in checks if check["status"] == WARN),
        FAIL: sum(1 for check in checks if check["status"] == FAIL),
        INFO: sum(1 for check in checks if check["status"] == INFO),
    }
    report = {
        "packageName": package_name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "checks": checks,
        "summary": summary,
    }

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text(report)
    return 1 if summary[FAIL] else 0


if __name__ == "__main__":
    sys.exit(main())
