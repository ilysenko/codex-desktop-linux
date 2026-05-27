#!/usr/bin/env python3
"""Safe installed-state doctor for Codex Desktop Linux packages."""

from __future__ import annotations

import argparse
import json
import os
import re
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


def nested_bool(data: dict[str, Any], *keys: str) -> bool | None:
    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current if isinstance(current, bool) else None


def status_word(value: bool | None) -> str:
    if value is True:
        return "pass"
    if value is False:
        return "fail"
    return "unknown"


def computer_use_doctor_summary(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    readiness = data.get("readiness") if isinstance(data.get("readiness"), dict) else {}
    blockers = readiness.get("blockers") if isinstance(readiness.get("blockers"), list) else []
    session_bus = nested_bool(data, "platform", "session_bus", "ok")
    accessibility_tree = nested_bool(data, "readiness", "can_build_accessibility_tree")
    windowing = nested_bool(data, "readiness", "can_query_windows")
    input_ready = nested_bool(data, "readiness", "can_send_development_input")

    detail = " ".join(
        [
            f"sessionBus={status_word(session_bus)}",
            f"accessibilityTree={status_word(accessibility_tree)}",
            f"windowing={status_word(windowing)}",
            f"input={status_word(input_ready)}",
            f"blockers={len(blockers)}",
        ]
    )
    return detail, {
        "blockersCount": len(blockers),
        "sessionBusOk": session_bus,
        "accessibilityTreeOk": accessibility_tree,
        "windowingOk": windowing,
        "inputOk": input_ready,
    }


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


def first_existing_path(paths: list[Path]) -> Path | None:
    for path in paths:
        if path.exists():
            return path
    return None


def chrome_plugin_dir(app_root: Path) -> Path | None:
    home = Path.home()
    candidates = [
        app_root / "resources/plugins/openai-bundled/plugins/chrome",
        home / ".codex/plugins/cache/openai-bundled/chrome/latest",
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
    if result.returncode == 0 and data is None:
        detail = f"{script.name} did not return JSON"
    elif result.returncode != 0:
        detail = f"{script.name} exited with status {result.returncode}"
    else:
        detail = f"{script.name} returned JSON"
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


def checks_for_package(package_name: str) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    app_root = Path("/opt") / package_name
    launcher = Path("/usr/bin") / package_name
    doctor = Path("/usr/bin") / f"{package_name}-doctor"
    app_service = Path("/usr/lib/systemd/user") / f"{package_name}.service"
    update_service = Path("/usr/lib/systemd/user/codex-update-manager.service")
    asar = app_root / "resources/app.asar"
    managed_node = app_root / "resources/node-runtime/bin/node"
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
    app_service_status = FAIL if version else INFO
    app_service_detail = "not installed in native-package service directory"
    if app_service.is_file():
        try:
            service_text = app_service.read_text(encoding="utf-8")
        except OSError as exc:
            app_service_status = FAIL
            app_service_detail = str(exc)
        else:
            expected_exec = f"/usr/bin/{package_name}"
            exec_token = re.compile(rf"(^|[\s'\";]){re.escape(expected_exec)}([\s;'\"$]|$)")
            service_lines = [line.strip() for line in service_text.splitlines()]
            has_expected_exec = any(
                line.startswith("ExecStart=") and exec_token.search(line)
                for line in service_lines
            )
            has_install_target = any(
                line == "WantedBy=graphical-session.target"
                for line in service_lines
            )
            has_debug_port = "--remote-debugging-port" in service_text
            app_service_status = PASS if has_expected_exec and has_install_target and not has_debug_port else FAIL
            if app_service_status == PASS:
                app_service_detail = "unit is installed and targets the packaged launcher"
            else:
                app_service_detail = "unit exists but does not match the packaged launcher contract"
    add_check(
        checks,
        "app_service_unit",
        "App user service unit",
        app_service_status,
        app_service_detail,
        path=str(app_service),
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
        PASS if managed_node.is_file() and os.access(managed_node, os.X_OK) else FAIL,
        str(managed_node),
        path=str(managed_node),
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
        enabledFeatureCount=len(build_info.get("linuxFeatures", {}).get("enabled", [])) if build_info else None,
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
                PASS if has_flatpak else INFO,
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
                    else "remote mobile feature is enabled but --remote-control marker is missing"
                    if remote_expected
                    else "remote mobile feature is not enabled in this build"
                ),
            )
    else:
        add_check(checks, "app_asar", "Installed app.asar", FAIL, f"missing: {asar}", path=str(asar))

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
        PASS if validator.is_file() else INFO,
        str(validator) if validator.is_file() else "not staged",
        path=str(validator),
    )
    staged_features = read_json(update_builder / "linux-features/features.json")
    if staged_features is not None:
        add_check(
            checks,
            "update_builder_features",
            "Update-builder enabled Linux features",
            INFO,
            "feature config staged" if staged_features.get("enabled") else "none",
            enabledCount=len(staged_features.get("enabled", [])),
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
                "manifest probe ok" if correct else "manifest probe reported a problem",
            )
        else:
            add_check(checks, "chrome_manifest_probe", "Chrome native host manifest probe", WARN, manifest_detail or "unavailable")

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
        flatpak_manifest = home / ".var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts" / f"{host_name}.json"
        flatpak_installed = command_exists("flatpak") and run(["flatpak", "info", "com.google.Chrome"], timeout=5).returncode == 0
        check_manifest_file(
            checks,
            flatpak_manifest,
            extension_id,
            host_name,
            "flatpak_chrome",
            required=False,
            flatpak_wrapper=True,
        )
        if flatpak_installed:
            permissions = run(["flatpak", "info", "--show-permissions", "com.google.Chrome"], timeout=5)
            has_talk = "org.freedesktop.Flatpak=talk" in permissions.stdout
            add_check(
                checks,
                "flatpak_chrome_permission",
                "Flatpak Chrome host permission",
                PASS if has_talk else INFO,
                "required host permission present" if has_talk else "required host permission missing",
            )
        else:
            add_check(checks, "flatpak_chrome_permission", "Flatpak Chrome host permission", INFO, "Flatpak Google Chrome not installed")

    cu_doctor = app_root / "resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux"
    if cu_doctor.is_file() and os.access(cu_doctor, os.X_OK):
        try:
            result = run([str(cu_doctor), "doctor"], timeout=12)
            data = json.loads(result.stdout) if result.stdout.strip() else {}
            raw_blockers = data.get("readiness", {}).get("blockers", []) if isinstance(data, dict) else []
            blockers = raw_blockers if isinstance(raw_blockers, list) else []
            detail, summary = computer_use_doctor_summary(data if isinstance(data, dict) else {})
            add_check(
                checks,
                "computer_use_doctor",
                "Computer Use doctor",
                PASS if result.returncode == 0 and not blockers else WARN,
                detail,
                **summary,
            )
        except (subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            add_check(checks, "computer_use_doctor", "Computer Use doctor", WARN, str(exc))
    else:
        add_check(checks, "computer_use_doctor", "Computer Use doctor", WARN, "backend not installed")

    remote_marker = app_root / ".codex-linux/remote-mobile-control-enabled"
    remote_hook = app_root / ".codex-linux/cold-start.d/remote-mobile-control"
    key_file = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "codex-desktop/remote-control-device-keys-v1.json"
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
        key_permissions_ok = None
        if key_file.exists():
            key_permissions_ok = (key_file.stat().st_mode & 0o077) == 0
        add_check(
            checks,
            "remote_mobile_key_file",
            "Remote mobile key file presence",
            PASS if key_file.exists() else INFO,
            "present" if key_file.exists() else "not found",
            present=key_file.exists(),
            permissionsOk=key_permissions_ok,
        )
    else:
        add_check(checks, "remote_mobile_marker", "Remote mobile feature marker", INFO, "remote mobile feature is not enabled")

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
