#!/usr/bin/env python3
"""Build a redacted live desktop/keyring validation matrix."""

from __future__ import annotations

import argparse
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PASS = "pass"
WARN = "warn"
FAIL = "fail"
SKIP = "skip"
PENDING = "pending"


def load_secret_service_matrix_module() -> Any:
    script_path = Path(__file__).resolve().with_name("secret-service-matrix-smoke.py")
    loader = importlib.machinery.SourceFileLoader("codex_secret_service_matrix_smoke", str(script_path))
    spec = importlib.util.spec_from_loader("codex_secret_service_matrix_smoke", loader)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load Secret Service matrix helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SECRET_MATRIX = load_secret_service_matrix_module()


def parse_os_release() -> dict[str, str]:
    for path in (Path("/etc/os-release"), Path("/usr/lib/os-release")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        fields: dict[str, str] = {}
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            fields[key] = value
        return fields
    return {}


def distro_family() -> str:
    fields = parse_os_release()
    tokens = {
        token.lower()
        for token in re.split(r"[\s,]+", " ".join((fields.get("ID", ""), fields.get("ID_LIKE", ""))))
        if token
    }
    if tokens & {"debian", "ubuntu", "linuxmint", "pop", "elementary", "zorin"}:
        return "debian"
    if tokens & {"fedora", "rhel", "centos", "rocky", "almalinux", "ol"}:
        return "fedora"
    if tokens & {"arch", "archlinux", "manjaro", "endeavouros", "artix"}:
        return "arch"
    if "nixos" in tokens:
        return "nixos"
    if tokens & {"opensuse", "suse", "sles"}:
        return "opensuse"
    return "other" if tokens else "unknown"


def desktop_family() -> str:
    raw = " ".join(
        value.lower()
        for value in (
            os.environ.get("XDG_CURRENT_DESKTOP", ""),
            os.environ.get("DESKTOP_SESSION", ""),
            os.environ.get("XDG_SESSION_DESKTOP", ""),
        )
        if value
    )
    if "gnome" in raw:
        return "gnome"
    if "kde" in raw or "plasma" in raw:
        return "kde"
    if "cosmic" in raw:
        return "cosmic"
    if "hyprland" in raw:
        return "hyprland"
    if "sway" in raw:
        return "sway"
    if "i3" in raw:
        return "i3"
    if raw == "x11":
        return "x11"
    return "other" if raw else "unknown"


def session_type() -> str:
    raw = os.environ.get("XDG_SESSION_TYPE", "").strip().lower()
    if raw in {"wayland", "x11"}:
        return raw
    if os.environ.get("WAYLAND_DISPLAY"):
        return "wayland"
    if os.environ.get("DISPLAY"):
        return "x11"
    return "unknown"


def safe_package_name(package_name: str) -> str | None:
    return package_name if re.fullmatch(r"[A-Za-z0-9_.+-]+", package_name) else None


def resolve_computer_use_doctor(args: argparse.Namespace) -> str | None:
    if args.no_computer_use_doctor:
        return None
    if args.computer_use_doctor:
        return args.computer_use_doctor

    package_name = safe_package_name(args.package_name)
    candidates: list[Path] = []
    if package_name is not None:
        candidates.append(
            Path("/opt")
            / package_name
            / "resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux"
        )
    which = shutil.which("codex-computer-use-linux")
    if which:
        candidates.append(Path(which))

    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def run_computer_use_doctor(command: str) -> dict[str, Any] | None:
    try:
        result = subprocess.run(
            [command, "doctor"],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=12,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    if not result.stdout.strip():
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def list_value(data: Any, key: str) -> list[str]:
    if not isinstance(data, dict):
        return []
    value = data.get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def map_window_backend(name: str | None, fallback_session_type: str, input_backends: dict[str, bool]) -> str:
    if name in {"gnome_shell_extension", "gnome_introspect"}:
        return "gnome"
    if name == "kwin":
        return "kwin"
    if name == "cosmic":
        return "cosmic"
    if name == "hyprland":
        return "hyprland"
    if name == "sway":
        return "sway"
    if name == "i3":
        return "i3"
    if fallback_session_type == "x11" and input_backends.get("ydotool"):
        return "global-input-only"
    return "unknown"


def build_desktop_report(args: argparse.Namespace) -> dict[str, Any]:
    family = desktop_family()
    current_session_type = session_type()
    report: dict[str, Any] = {
        "distroFamily": distro_family(),
        "desktopFamily": family,
        "sessionType": current_session_type,
        "windowBackend": "unknown",
        "exactFocusSupported": False,
        "screenshotPathAvailable": False,
        "inputBackends": {
            "absPointer": False,
            "portal": False,
            "ydotool": False,
        },
        "blockerCount": 0,
        "status": SKIP,
        "notes": "Computer Use doctor was not run; no private app, window, browser, file, or session content was collected.",
    }

    doctor = resolve_computer_use_doctor(args)
    if doctor is None:
        return report

    data = run_computer_use_doctor(doctor)
    if data is None:
        report["status"] = WARN
        report["notes"] = "Computer Use doctor output was unavailable or unreadable; no raw output was recorded."
        return report

    capabilities = data.get("capabilities") if isinstance(data.get("capabilities"), dict) else {}
    readiness = data.get("readiness") if isinstance(data.get("readiness"), dict) else {}
    input_names = set(list_value(capabilities, "input"))
    screenshot_names = list_value(capabilities, "screenshot")
    window_names = list_value(capabilities, "window_control")
    preferred = capabilities.get("preferred") if isinstance(capabilities.get("preferred"), dict) else {}
    preferred_window = preferred.get("window_control") if isinstance(preferred.get("window_control"), str) else None
    window_name = preferred_window or (window_names[0] if window_names else None)

    input_backends = {
        "absPointer": "abs_pointer" in input_names,
        "portal": "portal" in input_names,
        "ydotool": "ydotool" in input_names,
    }
    blockers = readiness.get("blockers")
    blocker_count = len(blockers) if isinstance(blockers, list) else 0

    report.update(
        {
            "windowBackend": map_window_backend(window_name, current_session_type, input_backends),
            "exactFocusSupported": bool(readiness.get("can_focus_windows")),
            "screenshotPathAvailable": len(screenshot_names) > 0,
            "inputBackends": input_backends,
            "blockerCount": blocker_count,
            "status": PASS if blocker_count == 0 else WARN,
            "notes": "Computer Use doctor summarized with redacted booleans only; no private app, window, browser, file, or session content.",
        }
    )
    return report


def normalize_issue_kind(issue_kind: Any) -> str:
    if issue_kind in (None, "", "none"):
        return "none"
    mapping = {
        "headless_session": "headless",
        "provider_timeout": "timeout",
        "store_failed": "unknown",
    }
    normalized = mapping.get(str(issue_kind), str(issue_kind))
    allowed = {
        "none",
        "tool_missing",
        "provider_unavailable",
        "locked_or_cancelled",
        "headless",
        "timeout",
        "lookup_mismatch",
        "unknown",
    }
    return normalized if normalized in allowed else "unknown"


def check_by_name(report: dict[str, Any], name: str) -> dict[str, Any]:
    for check in report.get("checks", []):
        if isinstance(check, dict) and check.get("name") == name:
            return check
    return {}


def secret_service_status(canary_status: str) -> str:
    if canary_status in {PASS, WARN, FAIL, SKIP, PENDING}:
        return canary_status
    return WARN


def build_secret_service_report(args: argparse.Namespace) -> dict[str, Any]:
    app_id = args.app_id or SECRET_MATRIX.DOCTOR.linux_app_id(args.package_name)
    secret_args = argparse.Namespace(
        live=args.live_secret_service,
        require_canary=args.require_secret_service_canary,
        app_id=app_id,
    )
    matrix = SECRET_MATRIX.build_report(secret_args)
    desktop_check = check_by_name(matrix, "desktop_session")
    provider_check = check_by_name(matrix, "provider_hint")
    tool_check = check_by_name(matrix, "secret_tool")
    roundtrip_check = check_by_name(matrix, "remote_key_secret_roundtrip")

    canary_status = str(roundtrip_check.get("status", PENDING))
    return {
        "desktopFamily": str(desktop_check.get("desktop") or desktop_family()),
        "sessionBus": bool(desktop_check.get("sessionBus")),
        "providerHints": {
            "gnomeKeyring": bool(provider_check.get("gnomeKeyring")),
            "kwallet": bool(provider_check.get("kwallet")),
            "keepassxc": bool(provider_check.get("keepassxc")),
        },
        "secretToolAvailable": tool_check.get("status") == PASS,
        "canaryStatus": canary_status if canary_status in {PASS, WARN, FAIL, SKIP} else PENDING,
        "issueKind": normalize_issue_kind(roundtrip_check.get("issueKind")),
        "storeAttempted": bool(roundtrip_check.get("storeAttempted")),
        "lookupMatched": bool(roundtrip_check.get("lookupMatched")),
        "clearAttempted": bool(roundtrip_check.get("clearAttempted")),
        "clearSucceeded": bool(roundtrip_check.get("clearSucceeded")),
        "status": secret_service_status(canary_status),
    }


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    desktop = build_desktop_report(args)
    secret_service = build_secret_service_report(args)
    statuses = [desktop["status"], secret_service["status"]]
    return {
        "ok": FAIL not in statuses,
        "date": datetime.now(timezone.utc).date().isoformat(),
        "desktop": desktop,
        "secretService": secret_service,
    }


def print_text(report: dict[str, Any]) -> None:
    desktop = report["desktop"]
    secret_service = report["secretService"]
    inputs = desktop["inputBackends"]
    print("Live validation matrix (redacted)")
    print(
        "Desktop: "
        f"status={desktop['status']} "
        f"distro={desktop['distroFamily']} "
        f"desktop={desktop['desktopFamily']} "
        f"session={desktop['sessionType']} "
        f"backend={desktop['windowBackend']} "
        f"exactFocus={str(desktop['exactFocusSupported']).lower()} "
        f"screenshot={str(desktop['screenshotPathAvailable']).lower()} "
        f"input=absPointer:{str(inputs['absPointer']).lower()},portal:{str(inputs['portal']).lower()},ydotool:{str(inputs['ydotool']).lower()} "
        f"blockers={desktop['blockerCount']}"
    )
    print(
        "Secret Service: "
        f"status={secret_service['status']} "
        f"desktop={secret_service['desktopFamily']} "
        f"sessionBus={str(secret_service['sessionBus']).lower()} "
        f"secretTool={str(secret_service['secretToolAvailable']).lower()} "
        f"canary={secret_service['canaryStatus']} "
        f"issue={secret_service['issueKind']}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    parser.add_argument("--live", "--live-secret-service", dest="live_secret_service", action="store_true", help="run the temporary Secret Service canary")
    parser.add_argument(
        "--require-canary",
        "--require-secret-service-canary",
        dest="require_secret_service_canary",
        action="store_true",
        help="fail when the live Secret Service canary cannot pass",
    )
    parser.add_argument("--computer-use-doctor", help="path to codex-computer-use-linux")
    parser.add_argument("--no-computer-use-doctor", action="store_true", help="skip the Computer Use doctor even if installed")
    parser.add_argument("--package-name", default=os.environ.get("CODEX_DESKTOP_PACKAGE_NAME", "codex-desktop"))
    parser.add_argument("--app-id", default=None)
    args = parser.parse_args()

    report = build_report(args)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text(report)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
