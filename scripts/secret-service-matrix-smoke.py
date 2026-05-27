#!/usr/bin/env python3
"""Redacted live Secret Service smoke probe for remote-mobile key storage."""

from __future__ import annotations

import argparse
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import secrets
from pathlib import Path
from typing import Any


PASS = "pass"
WARN = "warn"
FAIL = "fail"
INFO = "info"
SKIP = "skip"


def load_doctor_module() -> Any:
    repo_root = Path(__file__).resolve().parents[1]
    doctor_path = repo_root / "packaging/linux/codex-desktop-doctor.py"
    loader = importlib.machinery.SourceFileLoader("codex_desktop_doctor_matrix", str(doctor_path))
    spec = importlib.util.spec_from_loader("codex_desktop_doctor_matrix", loader)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load doctor helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DOCTOR = load_doctor_module()


def add_check(
    checks: list[dict[str, Any]],
    name: str,
    status: str,
    detail: str,
    **data: Any,
) -> None:
    entry: dict[str, Any] = {
        "name": name,
        "status": status,
        "detail": detail,
    }
    for key, value in data.items():
        if value is not None:
            entry[key] = value
    checks.append(entry)


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
    return "other" if raw else "unknown"


def command_running(names: tuple[str, ...]) -> bool:
    if shutil.which("pgrep") is None:
        return False
    for name in names:
        try:
            result = subprocess.run(
                ["pgrep", "-x", name],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            return True
    return False


def run_secret_tool(secret_tool: str, args: list[str], value: str | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [secret_tool, *args],
            check=False,
            input=value,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
        )
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess([secret_tool, args[0] if args else ""], 124, stdout="", stderr="timeout")
    except OSError:
        return subprocess.CompletedProcess([secret_tool, args[0] if args else ""], 127, stdout="", stderr="secret-tool unavailable")


def classify_secret_tool_failure(raw: str, fallback_kind: str, fallback_detail: str) -> tuple[str, str]:
    issue_kind, detail = DOCTOR.classify_secret_service_failure(raw)
    if issue_kind == "store_failed":
        return fallback_kind, fallback_detail
    return issue_kind, detail


def remote_key_secret_roundtrip(secret_tool: str, app_id: str, require_canary: bool) -> tuple[str, str, str | None, dict[str, Any]]:
    key_id = f"codex-matrix-{secrets.token_hex(8)}"
    value = f"codex-matrix-secret-{secrets.token_hex(32)}"
    attrs = [
        "application",
        "codex-desktop-linux",
        "app-id",
        app_id,
        "kind",
        "remote-control-device-key",
        "key-id",
        key_id,
    ]
    data: dict[str, Any] = {
        "storeAttempted": True,
        "lookupMatched": False,
        "clearAttempted": False,
        "clearSucceeded": False,
    }

    store = run_secret_tool(
        secret_tool,
        ["store", "--label", f"Codex Desktop Linux ({app_id}) Secret Service matrix canary", *attrs],
        value,
    )
    if store.returncode != 0:
        issue_kind, detail = classify_secret_tool_failure(
            (store.stderr or store.stdout or "").strip(),
            "store_failed",
            "Secret Service matrix canary unavailable: store failed",
        )
        return (FAIL if require_canary else WARN), detail, issue_kind, data

    lookup = run_secret_tool(secret_tool, ["lookup", *attrs])
    data["clearAttempted"] = True
    clear = run_secret_tool(secret_tool, ["clear", *attrs])
    data["clearSucceeded"] = clear.returncode == 0

    if lookup.returncode == 0 and lookup.stdout.rstrip("\r\n") == value:
        data["lookupMatched"] = True
        return PASS, "remote key Secret Service store/lookup/clear succeeded", None, data
    if lookup.returncode != 0:
        issue_kind, detail = classify_secret_tool_failure(
            (lookup.stderr or lookup.stdout or "").strip(),
            "lookup_failed",
            "Secret Service matrix canary unavailable: lookup failed",
        )
        return (FAIL if require_canary else WARN), detail, issue_kind, data
    return (FAIL if require_canary else WARN), "Secret Service matrix canary lookup did not round-trip", "lookup_mismatch", data


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    live_requested = args.live or os.environ.get("CODEX_DESKTOP_LIVE_SECRET_SERVICE_MATRIX") == "1"
    require_canary = args.require_canary or os.environ.get("CODEX_SECRET_SERVICE_REQUIRE_CANARY") == "1"
    secret_tool = shutil.which("secret-tool")
    checks: list[dict[str, Any]] = []

    add_check(
        checks,
        "desktop_session",
        INFO,
        "desktop session summarized",
        desktop=desktop_family(),
        sessionBus=bool(os.environ.get("DBUS_SESSION_BUS_ADDRESS")),
        waylandDisplay=bool(os.environ.get("WAYLAND_DISPLAY")),
        x11Display=bool(os.environ.get("DISPLAY")),
    )
    add_check(
        checks,
        "provider_hint",
        INFO,
        "provider process hints summarized",
        gnomeKeyring=command_running(("gnome-keyring-daemon",)),
        kwallet=command_running(("kwalletd5", "kwalletd6")),
        keepassxc=command_running(("keepassxc",)),
    )

    if not live_requested:
        add_check(
            checks,
            "live_gate",
            SKIP,
            "set CODEX_DESKTOP_LIVE_SECRET_SERVICE_MATRIX=1 or pass --live to run the canary",
        )
    else:
        add_check(checks, "live_gate", PASS, "live Secret Service canary enabled")

    if secret_tool:
        add_check(checks, "secret_tool", PASS, "secret-tool available")
    else:
        add_check(checks, "secret_tool", WARN if not require_canary else FAIL, "secret-tool unavailable", issueKind="tool_missing")

    if live_requested and secret_tool:
        status, detail, issue_kind, data = remote_key_secret_roundtrip(secret_tool, args.app_id, require_canary)
        add_check(
            checks,
            "remote_key_secret_roundtrip",
            status,
            detail,
            issueKind=issue_kind,
            **data,
        )
    elif live_requested:
        add_check(
            checks,
            "remote_key_secret_roundtrip",
            FAIL if require_canary else WARN,
            "Secret Service matrix canary skipped: secret-tool unavailable",
            issueKind="tool_missing",
            storeAttempted=False,
        )
    else:
        add_check(checks, "remote_key_secret_roundtrip", SKIP, "live canary not requested", storeAttempted=False)

    counts = {status: sum(1 for check in checks if check["status"] == status) for status in (PASS, WARN, FAIL, INFO, SKIP)}
    return {
        "ok": counts[FAIL] == 0,
        "counts": counts,
        "checks": checks,
    }


def print_text(report: dict[str, Any]) -> None:
    print("Secret Service matrix smoke")
    for check in report["checks"]:
        print(f"[{check['status'].upper()}] {check['name']}: {check['detail']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    parser.add_argument("--live", action="store_true", help="run the temporary Secret Service canary")
    parser.add_argument("--require-canary", action="store_true", help="fail when the live canary cannot pass")
    parser.add_argument("--app-id", default=os.environ.get("CODEX_LINUX_APP_ID", "codex-secret-service-matrix"))
    args = parser.parse_args()

    report = build_report(args)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text(report)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
