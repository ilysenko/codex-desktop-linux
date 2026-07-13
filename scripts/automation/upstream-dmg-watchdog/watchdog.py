#!/usr/bin/env python3
"""Atomic local state and cheap upstream DMG probe for the Codex watchdog."""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


DEFAULT_URL = "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg"
DEFAULT_TTL_SECONDS = 7200
DEFAULT_REPOSITORY = "ilysenko/codex-desktop-linux"
NIX_REFRESH_BRANCH = "codex/nix-upstream-refresh"
NIX_REFRESH_WORKFLOW = "update-codex-hash.yml"
NIX_ALLOWED_PATHS = {
    "flake.nix",
    "nix/native-modules/package.json",
    "nix/native-modules/package-lock.json",
}
NIX_REQUIRED_CHECKS = {
    "Rust and Smoke Tests",
    "Build Debian Package",
    "Build RPM Package",
    "Build Pacman Package",
    "Nix Package Builds",
}
NIX_MERGE_TTL_SECONDS = 300
NIX_MAX_TRANSIENT_ATTEMPTS = 3
NIX_TRANSIENT_BACKOFF_SECONDS = (900, 1800)
REPAIR_REQUIRED_CHECKS = NIX_REQUIRED_CHECKS | {"Build App Against Upstream DMG"}
PROTECTED_CAMPAIGN_PHASES = {
    "accepted-head",
    "nix-preflight-green",
    "nix-preflight-failed",
    "awaiting-nix",
    "nix-refresh",
    "nix-repair",
    "nix-blocked",
    "completed",
}
STATE_SCHEMA = 2


def utc_iso(now: float | None = None) -> str:
    value = dt.datetime.fromtimestamp(now if now is not None else time.time(), tz=dt.timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> float:
    if not value:
        return 0.0
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def default_state() -> dict:
    return {
        "schema": STATE_SCHEMA,
        "http_identity": None,
        "last_observed_sha256": None,
        "last_accepted_sha256": None,
        "probe_failures": 0,
        "last_probe_at": None,
        "worker_lease": None,
        "active_campaign": None,
        "pending_campaign": None,
        "last_completed_campaign": None,
        "revalidation_required": False,
        "pending_notifications": [],
        "nix_runs": [],
        "nix_failure_class": None,
        "nix_refresh": {
            "expected_dmg_sha256": None,
            "expected_dmg_sri": None,
            "expected_main_sha": None,
            "dispatch_key": None,
            "workflow_status": None,
            "last_dispatch_at": None,
            "dispatch_attempts": 0,
            "pr_number": None,
            "pr_head_sha": None,
            "check_status": None,
            "merge_failures": 0,
            "blocked_reason": None,
            "blocked_count": 0,
            "blocked_notified": False,
            "workflow_run_id": None,
            "workflow_url": None,
            "workflow_head_sha": None,
            "workflow_conclusion": None,
            "last_seen_run_id": None,
            "transient_failures": 0,
            "next_retry_at": None,
            "ci_last_seen_run_id": None,
            "ci_transient_failures": 0,
            "ci_next_retry_at": None,
            "ci_retry_dispatched_for": None,
        },
        "nix_merge_lease": None,
        "last_merged_nix_pr": None,
    }


def migrate_campaign(campaign: object) -> object:
    if not isinstance(campaign, dict):
        return campaign
    migrated = dict(campaign)
    migrated.setdefault("campaign_phase", migrated.get("phase", "detected"))
    migrated.setdefault("acceptance_evidence", None)
    migrated.setdefault("feature_snapshot", migrated.get("feature_snapshot"))
    migrated.setdefault("repair_rounds", [])
    migrated.setdefault("dispatch_key", f"migrated-{migrated.get('detected_at', 'unknown')}")
    if not migrated["repair_rounds"] and any(
        migrated.get(field) for field in ("base_sha", "branch", "worktree", "pr_number", "head_sha")
    ):
        migrated["repair_rounds"] = [{
            "round": 1,
            "base_sha": migrated.get("base_sha"),
            "branch": migrated.get("branch"),
            "worktree": migrated.get("worktree"),
            "pr_number": migrated.get("pr_number"),
            "pr_url": migrated.get("pr_url"),
            "head_sha": migrated.get("head_sha"),
            "status": "completed" if migrated.get("phase") == "completed" else migrated.get("phase", "unknown"),
        }]
    return migrated


def migrate_v1_state(loaded: dict) -> dict:
    migrated = dict(loaded)
    migrated["schema"] = STATE_SCHEMA
    migrated["active_campaign"] = migrate_campaign(migrated.get("active_campaign"))
    migrated["pending_campaign"] = migrate_campaign(migrated.get("pending_campaign"))
    migrated["last_completed_campaign"] = migrate_campaign(migrated.get("last_completed_campaign"))
    migrated.setdefault("revalidation_required", False)
    if not isinstance(migrated.get("pending_notifications"), list):
        migrated["pending_notifications"] = []
    if not isinstance(migrated.get("nix_runs"), list):
        migrated["nix_runs"] = []
    migrated.setdefault("nix_failure_class", None)
    completed = migrated.get("last_completed_campaign")
    observed_sha = migrated.get("last_observed_sha256")
    merged_nix = migrated.get("last_merged_nix_pr")
    nix_finished = (
        isinstance(merged_nix, dict) and merged_nix.get("dmg_sha256") == observed_sha
    ) or (migrated.get("nix_refresh") or {}).get("workflow_status") in {"current", "merged"}
    if (
        migrated.get("active_campaign") is None
        and isinstance(completed, dict)
        and completed.get("sha256") == observed_sha
        and migrated.get("last_accepted_sha256") == observed_sha
        and not nix_finished
    ):
        resumed = dict(completed)
        resumed["phase"] = "awaiting-nix"
        resumed["campaign_phase"] = "awaiting-nix"
        resumed["updated_at"] = utc_iso()
        migrated["active_campaign"] = resumed
        migrated["worker_lease"] = None
    return migrated


class Store:
    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.state_path = self.root / "state.json"
        self.guard_path = self.root / "state.guard"
        self.downloads = self.root / "downloads"
        self.worktrees = self.root / "worktrees"
        self.snapshots = self.root / "feature-snapshots"
        self.evidence = self.root / "acceptance-evidence"
        self.preflight = self.root / "nix-preflight"

    def ensure(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.downloads.mkdir(mode=0o700, exist_ok=True)
        self.worktrees.mkdir(mode=0o700, exist_ok=True)
        self.snapshots.mkdir(mode=0o700, exist_ok=True)
        self.evidence.mkdir(mode=0o700, exist_ok=True)
        self.preflight.mkdir(mode=0o700, exist_ok=True)

    @contextlib.contextmanager
    def locked(self):
        self.ensure()
        with self.guard_path.open("a+", encoding="utf-8") as guard:
            os.chmod(self.guard_path, 0o600)
            fcntl.flock(guard.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(guard.fileno(), fcntl.LOCK_UN)

    def load(self) -> dict:
        state = default_state()
        if not self.state_path.exists():
            return state
        try:
            loaded = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"invalid watchdog state: {error}") from error
        if not isinstance(loaded, dict) or loaded.get("schema") not in {1, STATE_SCHEMA}:
            raise RuntimeError("unsupported watchdog state schema")
        if loaded.get("schema") == 1:
            loaded = migrate_v1_state(loaded)
        state.update(loaded)
        nix_refresh = default_state()["nix_refresh"]
        if isinstance(state.get("nix_refresh"), dict):
            nix_refresh.update(state["nix_refresh"])
        state["nix_refresh"] = nix_refresh
        return state

    def save(self, state: dict) -> None:
        self.ensure()
        payload = (json.dumps(state, indent=2, sort_keys=True) + "\n").encode()
        fd, temporary = tempfile.mkstemp(prefix=".state.", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.state_path)
            directory_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)


def state_root(value: str | None) -> Path:
    if value:
        return Path(value)
    xdg = os.environ.get("XDG_STATE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "state"
    return base / "codex-automations" / "upstream-dmg-watchdog"


def parse_headers(payload: str) -> dict[str, str]:
    blocks: list[dict[str, str]] = []
    current: dict[str, str] = {}
    saw_status = False
    for raw in payload.replace("\r\n", "\n").split("\n"):
        line = raw.strip("\r")
        if line.startswith("HTTP/"):
            if saw_status and current:
                blocks.append(current)
            current = {}
            saw_status = True
            continue
        if not line:
            if saw_status and current:
                blocks.append(current)
                current = {}
                saw_status = False
            continue
        if saw_status and ":" in line:
            key, value = line.split(":", 1)
            current[key.strip().lower()] = value.strip()
    if saw_status and current:
        blocks.append(current)
    if not blocks:
        raise RuntimeError("upstream response contained no HTTP headers")
    return blocks[-1]


def http_identity(headers: dict[str, str]) -> dict | None:
    def normalize(value: str | None) -> str | None:
        if value is None or value in {"", "unknown", "no-etag"}:
            return None
        return value

    etag = normalize(headers.get("etag"))
    if etag and len(etag) >= 2 and etag[0] == etag[-1] == '"':
        etag = etag[1:-1]
    last_modified = normalize(headers.get("last-modified"))
    content_length = normalize(headers.get("content-length"))
    if etag is None and (last_modified is None or content_length is None):
        return None
    key_input = f"{last_modified or ''}|{etag or ''}|{content_length or ''}"
    return {
        "etag": etag,
        "last_modified": last_modified,
        "content_length": content_length,
        "key": hashlib.sha256(key_input.encode()).hexdigest(),
    }


def curl_headers(url: str) -> str:
    result = subprocess.run(
        ["curl", "-fsSLI", "--retry", "3", "--retry-delay", "2", "--connect-timeout", "15", "--max-time", "60", url],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout


def download(url: str, destination: Path) -> None:
    subprocess.run(
        ["curl", "-fL", "--retry", "3", "--retry-delay", "2", "--connect-timeout", "15", "--max-time", "1800", "-o", str(destination), url],
        check=True,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_tree(root: Path) -> str:
    digest = hashlib.sha256()
    if not root.is_dir():
        raise RuntimeError(f"tree does not exist: {root}")
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix().encode()
        digest.update(relative + b"\0")
        if path.is_symlink():
            digest.update(b"link\0" + os.readlink(path).encode() + b"\0")
        elif path.is_dir():
            digest.update(b"dir\0")
        elif path.is_file():
            digest.update(b"file\0")
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
    return digest.hexdigest()


def queue_notification(state: dict, kind: str, payload: list[object], key: str) -> str:
    notifications = state.setdefault("pending_notifications", [])
    for item in notifications:
        if isinstance(item, dict) and item.get("key") == key:
            return str(item["id"])
    event_id = str(uuid.uuid4())
    notifications.append({
        "id": event_id,
        "key": key,
        "kind": kind,
        "payload": payload,
        "created_at": utc_iso(),
        "acked_at": None,
    })
    return event_id


def next_notification(state: dict) -> dict | None:
    for item in state.get("pending_notifications") or []:
        if isinstance(item, dict) and not item.get("acked_at"):
            return item
    return None


def acknowledge_notification(state: dict, event_id: str, now: float) -> bool:
    for item in state.get("pending_notifications") or []:
        if isinstance(item, dict) and item.get("id") == event_id:
            item["acked_at"] = item.get("acked_at") or utc_iso(now)
            return True
    return False


def acknowledge_campaign_notifications(state: dict, sha: str, now: float) -> None:
    for item in state.get("pending_notifications") or []:
        if not isinstance(item, dict) or item.get("acked_at"):
            continue
        if item.get("kind") in {"CHANGE_READY", "NIX_REPAIR_READY"} and (item.get("payload") or [None])[0] == sha:
            item["acked_at"] = utc_iso(now)


def supersede_campaign_notifications(state: dict, sha: str, now: float) -> None:
    for item in state.get("pending_notifications") or []:
        if not isinstance(item, dict) or item.get("acked_at"):
            continue
        payload = item.get("payload") or [None]
        if item.get("kind") in {"CHANGE_READY", "NIX_REPAIR_READY"} and payload[0] != sha:
            item["acked_at"] = utc_iso(now)
            item["superseded_by_sha256"] = sha


def format_notification(item: dict) -> str:
    payload = " ".join(str(value) for value in item.get("payload") or [])
    return f"{item['kind']} {payload} EVENT_ID={item['id']}".strip()


def current_round(campaign: dict, *, create: bool = False) -> dict | None:
    rounds = campaign.setdefault("repair_rounds", [])
    if rounds and rounds[-1].get("status") not in {"merged", "accepted-main", "completed", "superseded"}:
        return rounds[-1]
    if not create:
        return rounds[-1] if rounds else None
    repair_round = {
        "round": len(rounds) + 1,
        "status": "preparing",
        "created_at": utc_iso(),
        "base_sha": None,
        "branch": None,
        "worktree": None,
        "pr_number": None,
        "pr_url": None,
        "head_sha": None,
        "accepted_head_sha": None,
        "merge_sha": None,
    }
    rounds.append(repair_round)
    return repair_round


def sha256_sri(sha256_hex: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", sha256_hex):
        raise RuntimeError("invalid DMG SHA-256")
    return "sha256-" + base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")


def extract_codex_dmg_sri(flake: str) -> str:
    match = re.search(
        r"codexDmg\s*=\s*pkgs\.fetchurl\s*\{.*?\bhash\s*=\s*\"(sha256-[A-Za-z0-9+/=]{44})\"",
        flake,
        flags=re.DOTALL,
    )
    if not match:
        raise RuntimeError("could not find codexDmg SRI in flake.nix")
    return match.group(1)


def gh_binary() -> str:
    return os.environ.get("UPSTREAM_DMG_WATCHDOG_GH", "gh")


def gh_command(arguments: list[str], *, json_output: bool = False) -> object:
    result = subprocess.run(
        [gh_binary(), *arguments],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if not json_output:
        return result.stdout.strip()
    try:
        return json.loads(result.stdout or "null")
    except json.JSONDecodeError as error:
        raise RuntimeError(f"gh returned invalid JSON for {' '.join(arguments)}") from error


def github_file(repository: str, path: str, ref: str) -> str:
    value = gh_command(
        ["api", f"repos/{repository}/contents/{path}?ref={ref}"],
        json_output=True,
    )
    if not isinstance(value, dict) or not isinstance(value.get("content"), str):
        raise RuntimeError(f"GitHub did not return {path} at {ref}")
    try:
        return base64.b64decode(value["content"].replace("\n", "")).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise RuntimeError(f"GitHub returned invalid content for {path} at {ref}") from error


def github_ref_sha(repository: str, ref: str) -> str:
    value = gh_command(["api", f"repos/{repository}/commits/{ref}"], json_output=True)
    sha = value.get("sha") if isinstance(value, dict) else None
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError(f"GitHub did not return a full SHA for {ref}")
    return sha


def open_nix_prs(repository: str) -> list[dict]:
    value = gh_command(
        [
            "pr", "list", "--repo", repository, "--state", "open", "--head", NIX_REFRESH_BRANCH,
            "--json",
            "number,url,author,headRepositoryOwner,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,files,statusCheckRollup",
        ],
        json_output=True,
    )
    if not isinstance(value, list):
        raise RuntimeError("GitHub returned invalid Nix PR list")
    return value


def nix_pr_view(repository: str, number: int) -> dict:
    value = gh_command(
        [
            "pr", "view", str(number), "--repo", repository,
            "--json",
            "number,url,state,mergedAt,mergeCommit,author,headRepositoryOwner,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,files,statusCheckRollup",
        ],
        json_output=True,
    )
    if not isinstance(value, dict):
        raise RuntimeError("GitHub returned invalid Nix PR metadata")
    return value


def repair_pr_view(repository: str, number: int) -> dict:
    value = gh_command(
        [
            "pr", "view", str(number), "--repo", repository,
            "--json",
            "number,url,state,mergedAt,mergeCommit,author,headRepositoryOwner,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,statusCheckRollup,body",
        ],
        json_output=True,
    )
    if not isinstance(value, dict):
        raise RuntimeError("GitHub returned invalid repair PR metadata")
    return value


def nix_workflow_runs(repository: str) -> list[dict]:
    value = gh_command(
        [
            "run", "list", "--repo", repository, "--workflow", NIX_REFRESH_WORKFLOW,
            "--limit", "20", "--json", "databaseId,status,conclusion,event,createdAt,updatedAt,url,headSha,displayTitle",
        ],
        json_output=True,
    )
    if not isinstance(value, list):
        raise RuntimeError("GitHub returned invalid Nix workflow list")
    return [run for run in value if isinstance(run, dict)]


def nix_ci_runs(repository: str) -> list[dict]:
    value = gh_command(
        [
            "run", "list", "--repo", repository, "--workflow", "ci.yml", "--branch", NIX_REFRESH_BRANCH,
            "--limit", "20", "--json", "databaseId,status,conclusion,event,createdAt,updatedAt,url,headSha",
        ],
        json_output=True,
    )
    if not isinstance(value, list):
        raise RuntimeError("GitHub returned invalid Nix CI workflow list")
    return [run for run in value if isinstance(run, dict)]


def augment_nix_pr_checks(pr: dict, repository: str) -> tuple[dict, dict | None]:
    head = pr.get("headRefOid")
    outcomes = {
        check.get("name") or check.get("context"): check_outcome(check)
        for check in pr.get("statusCheckRollup") or []
        if isinstance(check, dict)
    }
    if all(outcomes.get(name) == "pass" for name in NIX_REQUIRED_CHECKS):
        return pr, None
    run = next((item for item in nix_ci_runs(repository) if item.get("headSha") == head), None)
    if run is None or run.get("status") != "completed":
        return pr, run
    details = nix_run_view(repository, int(run["databaseId"]))
    synthetic = []
    for job in details.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        synthetic.append({
            "name": job.get("name"),
            "status": str(job.get("status") or "").upper(),
            "conclusion": str(job.get("conclusion") or "").upper(),
            "detailsUrl": job.get("url") or details.get("url"),
        })
    return {**pr, "statusCheckRollup": synthetic}, details


def nix_run_matches_campaign(run: dict, main_sha: str, dmg_sha: str) -> bool:
    title = run.get("displayTitle")
    if isinstance(title, str):
        return title == f"Nix refresh {main_sha}:{dmg_sha}"
    return run.get("headSha") == main_sha


def active_nix_workflow(repository: str, main_sha: str | None = None, dmg_sha: str | None = None) -> dict | None:
    value = nix_workflow_runs(repository)
    for run in value:
        if (
            run.get("status") in {"queued", "in_progress", "waiting", "requested", "pending"}
            and (main_sha is None or dmg_sha is None or nix_run_matches_campaign(run, main_sha, dmg_sha))
        ):
            return run
    return None


def nix_run_view(repository: str, run_id: int) -> dict:
    value = gh_command(
        [
            "run", "view", str(run_id), "--repo", repository,
            "--json", "databaseId,status,conclusion,createdAt,updatedAt,url,headSha,jobs",
        ],
        json_output=True,
    )
    if not isinstance(value, dict):
        raise RuntimeError("GitHub returned invalid Nix workflow metadata")
    return value


def nix_failure_log(repository: str, run_id: int) -> str:
    try:
        return str(gh_command(["run", "view", str(run_id), "--repo", repository, "--log-failed"]))[-12000:]
    except (RuntimeError, subprocess.SubprocessError):
        return ""


def classify_nix_run(run: dict, failure_log: str = "") -> str:
    conclusion = str(run.get("conclusion") or "").lower()
    if conclusion in {"cancelled", "canceled", "timed_out", "startup_failure", "action_required"}:
        return "transient"
    if transient_output(failure_log):
        return "transient"
    infrastructure_steps = {
        "Set up job",
        "Run actions/checkout@v4",
        "Set up Node.js",
        "Install Nix",
        "Configure Cachix for hash refresh builds",
        "Install validation dependencies",
    }
    failed_steps = {
        step.get("name")
        for job in run.get("jobs") or [] if isinstance(job, dict)
        for step in job.get("steps") or [] if isinstance(step, dict)
        if str(step.get("conclusion") or "").lower() == "failure"
    }
    if failed_steps and failed_steps.issubset(infrastructure_steps):
        return "transient"
    return "source"


def ensure_nix_workflow(
    args: argparse.Namespace,
    refresh: dict,
    repository: str,
    now: float,
    main_sha: str,
    dmg_sha: str,
) -> None:
    dispatch_key = f"{main_sha}:{dmg_sha}"
    active_run = active_nix_workflow(repository, main_sha, dmg_sha)
    if active_run:
        refresh["workflow_status"] = active_run.get("status") or "active"
        refresh["workflow_run_id"] = active_run.get("databaseId")
        refresh["workflow_url"] = active_run.get("url")
        refresh["workflow_head_sha"] = active_run.get("headSha")
    elif active_nix_workflow(repository):
        refresh["workflow_status"] = "waiting-for-older-run"
    elif refresh.get("dispatch_key") == dispatch_key:
        refresh["workflow_status"] = "dispatch-recorded"
    elif args.dry_run:
        refresh["workflow_status"] = "dispatch-dry-run"
    else:
        gh_command([
            "workflow", "run", NIX_REFRESH_WORKFLOW, "--repo", repository, "--ref", "main",
            "-f", f"expected_main_sha={main_sha}",
            "-f", f"expected_dmg_sha256={dmg_sha}",
        ])
        refresh["workflow_status"] = "dispatched"
        refresh["last_dispatch_at"] = utc_iso(now)
        refresh["dispatch_key"] = dispatch_key
        refresh["expected_main_sha"] = main_sha
        refresh["dispatch_attempts"] = int(refresh.get("dispatch_attempts") or 0) + 1
        refresh["workflow_head_sha"] = main_sha
        refresh["workflow_run_id"] = None
        refresh["workflow_conclusion"] = None


def actor_login(value: object) -> str | None:
    return value.get("login") if isinstance(value, dict) else None


def check_outcome(check: dict) -> str:
    bucket = str(check.get("bucket") or "").lower()
    if bucket in {"pass", "fail", "pending", "skipping", "cancel"}:
        return bucket
    status = str(check.get("status") or "").upper()
    conclusion = str(check.get("conclusion") or check.get("state") or "").upper()
    if status and status != "COMPLETED":
        return "pending"
    if conclusion in {"SUCCESS", "NEUTRAL", "SKIPPED"}:
        return "pass" if conclusion == "SUCCESS" else "skipping"
    if conclusion in {"FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}:
        return "fail"
    if conclusion in {"CANCELLED", "CANCELED"}:
        return "cancel"
    if conclusion in {"PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", ""}:
        return "pending"
    return "fail"


def validate_nix_pr(pr: dict, expected_sri: str, repository: str) -> tuple[str, str]:
    if pr.get("state", "OPEN") != "OPEN":
        return "blocked", "pr-not-open"
    if actor_login(pr.get("author")) != "app/github-actions":
        return "blocked", "wrong-author"
    if actor_login(pr.get("headRepositoryOwner")) != repository.split("/", 1)[0]:
        return "blocked", "wrong-head-owner"
    if pr.get("headRefName") != NIX_REFRESH_BRANCH or pr.get("baseRefName") != "main":
        return "blocked", "wrong-branch"
    if pr.get("isDraft") is True:
        return "blocked", "draft"
    files = {item.get("path") for item in pr.get("files") or [] if isinstance(item, dict)}
    if "flake.nix" not in files or not files.issubset(NIX_ALLOWED_PATHS):
        return "blocked", "unexpected-files"
    head_sha = pr.get("headRefOid")
    if not isinstance(head_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        return "waiting", "head-unavailable"
    head_sri = extract_codex_dmg_sri(github_file(repository, "flake.nix", head_sha))
    if head_sri != expected_sri:
        return "blocked", "dmg-hash-mismatch"
    mergeable = str(pr.get("mergeable") or "UNKNOWN").upper()
    if mergeable == "CONFLICTING":
        return "blocked", "merge-conflict"
    if mergeable != "MERGEABLE":
        return "waiting", "mergeability-pending"
    checks = pr.get("statusCheckRollup") or []
    seen: dict[str, str] = {}
    for check in checks:
        if not isinstance(check, dict):
            continue
        name = check.get("name") or check.get("context")
        outcome = check_outcome(check)
        if isinstance(name, str):
            seen[name] = outcome
        if outcome in {"fail", "cancel"}:
            return "blocked", f"check-{outcome}"
        if outcome == "pending":
            return "waiting", "checks-pending"
    if any(seen.get(name) != "pass" for name in NIX_REQUIRED_CHECKS):
        return "blocked", "required-checks-missing"
    return "ready", "ready"


def reset_nix_blocker(refresh: dict) -> None:
    refresh["blocked_reason"] = None
    refresh["blocked_count"] = 0
    refresh["blocked_notified"] = False


def record_nix_blocker(refresh: dict, reason: str) -> bool:
    if refresh.get("blocked_reason") == reason:
        refresh["blocked_count"] = int(refresh.get("blocked_count") or 0) + 1
    else:
        refresh["blocked_reason"] = reason
        refresh["blocked_count"] = 1
        refresh["blocked_notified"] = False
    if refresh["blocked_count"] >= 3 and not refresh.get("blocked_notified"):
        refresh["blocked_notified"] = True
        return True
    return False


def campaign_for(sha: str, dmg_path: Path, identity: dict, now: float) -> dict:
    return {
        "sha256": sha,
        "dmg_path": str(dmg_path),
        "http_identity": identity,
        "detected_at": utc_iso(now),
        "phase": "detected",
        "campaign_phase": "drift-validation",
        "acceptance_evidence": None,
        "feature_snapshot": None,
        "repair_rounds": [],
        "dispatch_key": str(uuid.uuid4()),
        "base_sha": None,
        "branch": f"codex/upstream-dmg-{sha[:12]}",
        "worktree": None,
        "pr_number": None,
        "pr_url": None,
        "head_sha": None,
        "ci_state": None,
        "last_error": None,
        "attempts": 0,
        "updated_at": utc_iso(now),
    }


def fail_probe(store: Store, now: float, message: str) -> int:
    state = store.load()
    state["probe_failures"] = int(state.get("probe_failures") or 0) + 1
    state["last_probe_at"] = utc_iso(now)
    state["last_probe_error"] = message[:500]
    store.save(state)
    print(f"RETRY {state['probe_failures']}")
    return 3


def process_nix_refresh(
    args: argparse.Namespace,
    store: Store,
    state: dict,
    identity: dict,
    dmg_sha: str,
    now: float,
) -> None:
    if args.skip_nix:
        return
    campaign = state.get("active_campaign")
    if not isinstance(campaign, dict) or campaign.get("campaign_phase") not in {"awaiting-nix", "nix-refresh"}:
        return
    repository = args.repository
    expected_sri = sha256_sri(dmg_sha)
    refresh = state["nix_refresh"]
    if refresh.get("expected_dmg_sha256") != dmg_sha:
        refresh = default_state()["nix_refresh"]
        state["nix_refresh"] = refresh
        refresh["expected_dmg_sha256"] = dmg_sha
        refresh["expected_dmg_sri"] = expected_sri

    main_sri = extract_codex_dmg_sri(github_file(repository, "flake.nix", "main"))
    if main_sri == expected_sri:
        refresh["workflow_status"] = "current"
        refresh["pr_number"] = None
        refresh["pr_head_sha"] = None
        refresh["check_status"] = "current"
        reset_nix_blocker(refresh)
        state["nix_merge_lease"] = None
        finalize_campaign(state, "accepted_with_nix_current", now)
        store.save(state)
        return

    expected_main_sha = refresh.get("expected_main_sha")
    active_refresh = active_nix_workflow(repository)
    if active_refresh:
        refresh["workflow_status"] = (
            active_refresh.get("status")
            if isinstance(expected_main_sha, str)
            and nix_run_matches_campaign(active_refresh, expected_main_sha, dmg_sha)
            else "waiting-for-older-run"
        )
        refresh["workflow_run_id"] = active_refresh.get("databaseId")
        refresh["workflow_url"] = active_refresh.get("url")
        refresh["workflow_head_sha"] = active_refresh.get("headSha")
        store.save(state)
        return

    prs = open_nix_prs(repository)
    if len(prs) > 1:
        refresh["workflow_status"] = "blocked"
        refresh["check_status"] = "multiple-open-prs"
        notify = record_nix_blocker(refresh, "multiple-open-prs")
        if notify:
            queue_notification(state, "NIX_BLOCKED", [0, "multiple-open-prs"], f"nix-blocked:{dmg_sha}:multiple-open-prs")
        store.save(state)
        return

    if not prs:
        refresh["pr_number"] = None
        refresh["pr_head_sha"] = None
        refresh["check_status"] = "waiting-for-pr"
        runs = nix_workflow_runs(repository)
        main_sha = github_ref_sha(repository, "main")
        target_head = refresh.get("expected_main_sha") or refresh.get("workflow_head_sha") or main_sha
        active_run = next((
            run for run in runs
            if run.get("status") in {"queued", "in_progress", "waiting", "requested", "pending"}
            and nix_run_matches_campaign(run, target_head, dmg_sha)
        ), None)
        if active_run:
            refresh["workflow_status"] = active_run.get("status") or "active"
            refresh["workflow_run_id"] = active_run.get("databaseId")
            refresh["workflow_url"] = active_run.get("url")
            refresh["workflow_head_sha"] = active_run.get("headSha")
            store.save(state)
            return
        older_active = next((
            run for run in runs
            if run.get("status") in {"queued", "in_progress", "waiting", "requested", "pending"}
        ), None)
        if older_active:
            refresh["workflow_status"] = "waiting-for-older-run"
            store.save(state)
            return
        dispatched_at = parse_iso(refresh.get("last_dispatch_at"))
        completed = next(
            (
                run for run in runs
                if run.get("status") == "completed"
                and nix_run_matches_campaign(run, target_head, dmg_sha)
                and parse_iso(run.get("createdAt")) + 5 >= dispatched_at
                and run.get("databaseId") != refresh.get("last_seen_run_id")
            ),
            None,
        )
        if completed:
            run_id = int(completed["databaseId"])
            details = nix_run_view(repository, run_id)
            failure_log = "" if str(details.get("conclusion") or "").lower() == "success" else nix_failure_log(repository, run_id)
            classification = "success" if not failure_log and str(details.get("conclusion") or "").lower() == "success" else classify_nix_run(details, failure_log)
            record_nix_run(state, details, classification, failure_log)
            refresh["last_seen_run_id"] = run_id
            refresh["workflow_run_id"] = run_id
            refresh["workflow_url"] = details.get("url")
            refresh["workflow_head_sha"] = details.get("headSha")
            refresh["workflow_conclusion"] = details.get("conclusion")
            if classification == "source":
                state["nix_failure_class"] = "source"
                campaign["nix_failure_class"] = "source"
                campaign["campaign_phase"] = "nix-repair"
                campaign["phase"] = "nix-repair"
                campaign["updated_at"] = utc_iso(now)
                queue_notification(state, "NIX_REPAIR_READY", [dmg_sha, run_id], f"nix-repair:{dmg_sha}:{run_id}")
                store.save(state)
                return
            if classification == "transient":
                failures = int(refresh.get("transient_failures") or 0) + 1
                refresh["transient_failures"] = failures
                state["nix_failure_class"] = "transient"
                if failures >= NIX_MAX_TRANSIENT_ATTEMPTS:
                    refresh["workflow_status"] = "blocked"
                    campaign["campaign_phase"] = "nix-blocked"
                    queue_notification(state, "NIX_BLOCKED", [0, "transient-retries-exhausted"], f"nix-blocked:{dmg_sha}:transient")
                    store.save(state)
                    return
                refresh["next_retry_at"] = utc_iso(now + NIX_TRANSIENT_BACKOFF_SECONDS[failures - 1])
                refresh["dispatch_key"] = None
                refresh["workflow_status"] = "transient-backoff"
                store.save(state)
                return
            refresh["workflow_status"] = "waiting-for-pr"
            refresh["transient_failures"] = 0
            refresh["next_retry_at"] = utc_iso(now + 300)
            store.save(state)
            return
        if parse_iso(refresh.get("next_retry_at")) > now:
            store.save(state)
            return
        ensure_nix_workflow(args, refresh, repository, now, main_sha, dmg_sha)
        campaign["campaign_phase"] = "nix-refresh"
        campaign["phase"] = "nix-refresh"
        store.save(state)
        return

    pr, ci_run = augment_nix_pr_checks(prs[0], repository)
    number = int(pr["number"])
    refresh["pr_number"] = number
    refresh["pr_head_sha"] = pr.get("headRefOid")
    if isinstance(ci_run, dict) and ci_run.get("status") != "completed":
        refresh["check_status"] = "checks-pending"
        refresh["workflow_status"] = "pr-ci-active"
        reset_nix_blocker(refresh)
        store.save(state)
        return
    status, reason = validate_nix_pr(pr, expected_sri, repository)
    refresh["check_status"] = reason
    refresh["workflow_status"] = "pr-open"
    if status == "waiting":
        reset_nix_blocker(refresh)
        store.save(state)
        return
    if status == "blocked":
        if reason == "dmg-hash-mismatch":
            ensure_nix_workflow(
                args,
                refresh,
                repository,
                now,
                github_ref_sha(repository, "main"),
                dmg_sha,
            )
        if reason.startswith("check-fail") or reason.startswith("check-cancel"):
            run_id = (ci_run or {}).get("databaseId") or failed_check_run_id(pr) or number
            details = ci_run
            if isinstance(ci_run, dict) and ci_run.get("databaseId") and not ci_run.get("jobs"):
                details = nix_run_view(repository, int(ci_run["databaseId"]))
            failure_log = nix_failure_log(repository, int(run_id))
            classification = classify_nix_run(details, failure_log) if isinstance(details, dict) else "source"
            if classification == "transient":
                if refresh.get("ci_last_seen_run_id") != run_id:
                    failures = int(refresh.get("ci_transient_failures") or 0) + 1
                    refresh["ci_transient_failures"] = failures
                    refresh["ci_last_seen_run_id"] = run_id
                    refresh["ci_retry_dispatched_for"] = None
                    refresh["ci_next_retry_at"] = utc_iso(
                        now + NIX_TRANSIENT_BACKOFF_SECONDS[min(failures - 1, len(NIX_TRANSIENT_BACKOFF_SECONDS) - 1)]
                    )
                    if isinstance(details, dict):
                        record_nix_run(state, details, "transient", failure_log)
                failures = int(refresh.get("ci_transient_failures") or 0)
                if failures >= NIX_MAX_TRANSIENT_ATTEMPTS:
                    campaign["campaign_phase"] = "nix-blocked"
                    campaign["phase"] = "nix-blocked"
                    queue_notification(
                        state,
                        "NIX_BLOCKED",
                        [number, "ci-transient-retries-exhausted"],
                        f"nix-blocked:{dmg_sha}:{number}:ci-transient",
                    )
                elif (
                    parse_iso(refresh.get("ci_next_retry_at")) <= now
                    and refresh.get("ci_retry_dispatched_for") != run_id
                ):
                    if not args.dry_run:
                        gh_command([
                            "workflow", "run", "ci.yml", "--repo", repository,
                            "--ref", NIX_REFRESH_BRANCH,
                        ])
                    refresh["ci_retry_dispatched_for"] = run_id
                    refresh["workflow_status"] = "ci-retry-dispatched"
                else:
                    refresh["workflow_status"] = "ci-transient-backoff"
                reset_nix_blocker(refresh)
                store.save(state)
                return
            if isinstance(details, dict):
                record_nix_run(state, details, "source", failure_log)
            state["nix_failure_class"] = "source"
            campaign["nix_failure_class"] = "source"
            campaign["campaign_phase"] = "nix-repair"
            campaign["phase"] = "nix-repair"
            queue_notification(state, "NIX_REPAIR_READY", [dmg_sha, run_id], f"nix-repair:{dmg_sha}:{run_id}")
            store.save(state)
            return
        notify = record_nix_blocker(refresh, reason)
        if notify:
            queue_notification(state, "NIX_BLOCKED", [number, reason], f"nix-blocked:{dmg_sha}:{number}:{reason}")
        store.save(state)
        return

    reset_nix_blocker(refresh)
    if args.premerge_headers_file:
        premerge_headers = Path(args.premerge_headers_file).read_text(encoding="utf-8")
    elif args.headers_file:
        premerge_headers = Path(args.headers_file).read_text(encoding="utf-8")
    else:
        premerge_headers = curl_headers(args.url)
    premerge_identity = http_identity(parse_headers(premerge_headers))
    if premerge_identity is None or premerge_identity.get("key") != identity.get("key"):
        refresh["check_status"] = "upstream-changed-before-merge"
        store.save(state)
        return

    lease = state.get("nix_merge_lease")
    if lease_is_active(lease, now):
        store.save(state)
        return
    merge_run_id = str(uuid.uuid4())
    state["nix_merge_lease"] = {
        "run_id": merge_run_id,
        "pr_number": number,
        "head_sha": pr.get("headRefOid"),
        "acquired_at": utc_iso(now),
        "expires_at": utc_iso(now + NIX_MERGE_TTL_SECONDS),
    }
    store.save(state)

    try:
        current, _ = augment_nix_pr_checks(nix_pr_view(repository, number), repository)
        status, reason = validate_nix_pr(current, expected_sri, repository)
        if status != "ready" or current.get("headRefOid") != pr.get("headRefOid"):
            refresh["check_status"] = "head-or-gates-changed"
            notify = record_nix_blocker(refresh, "head-or-gates-changed") if status == "blocked" else False
            state["nix_merge_lease"] = None
            if notify:
                queue_notification(state, "NIX_BLOCKED", [number, "head-or-gates-changed"], f"nix-blocked:{dmg_sha}:{number}:head-changed")
            store.save(state)
            return
        if args.dry_run:
            refresh["check_status"] = "ready-dry-run"
            state["nix_merge_lease"] = None
            store.save(state)
            return
        gh_command(
            [
                "pr", "merge", str(number), "--repo", repository, "--squash", "--admin",
                "--delete-branch", "--match-head-commit", current["headRefOid"],
            ]
        )
        merged = nix_pr_view(repository, number)
        if merged.get("state") != "MERGED" or not merged.get("mergedAt"):
            raise RuntimeError("GitHub did not confirm the Nix PR merge")
        merge_commit = merged.get("mergeCommit")
        state["last_merged_nix_pr"] = {
            "number": number,
            "url": merged.get("url") or pr.get("url"),
            "head_sha": current["headRefOid"],
            "merge_sha": merge_commit.get("oid") if isinstance(merge_commit, dict) else None,
            "dmg_sha256": dmg_sha,
            "merged_at": merged.get("mergedAt"),
            "recorded_at": utc_iso(now),
        }
        refresh["workflow_status"] = "merged"
        refresh["check_status"] = "merged"
        refresh["merge_failures"] = 0
        state["nix_merge_lease"] = None
        queue_notification(
            state,
            "NIX_PR_MERGED",
            [number, state["last_merged_nix_pr"]["url"]],
            f"nix-merged:{dmg_sha}:{number}",
        )
        finalize_campaign(state, "accepted_with_nix_merged", now)
        store.save(state)
        return
    except (RuntimeError, subprocess.SubprocessError) as error:
        state["nix_merge_lease"] = None
        refresh["merge_failures"] = int(refresh.get("merge_failures") or 0) + 1
        refresh["check_status"] = "merge-failed"
        refresh["last_error"] = str(error)[:500]
        notify = refresh["merge_failures"] >= 3 and not refresh.get("merge_failure_notified")
        if notify:
            refresh["merge_failure_notified"] = True
            queue_notification(state, "NIX_BLOCKED", [number, "merge-failed"], f"nix-blocked:{dmg_sha}:{number}:merge-failed")
        store.save(state)
        return


def record_nix_run(state: dict, run: dict, classification: str, log_excerpt: str) -> None:
    item = {
        "run_id": run.get("databaseId"),
        "status": run.get("status"),
        "conclusion": run.get("conclusion"),
        "head_sha": run.get("headSha"),
        "url": run.get("url"),
        "created_at": run.get("createdAt"),
        "updated_at": run.get("updatedAt"),
        "classification": classification,
        "failure_log_excerpt": log_excerpt[-4000:] if log_excerpt else None,
        "recorded_at": utc_iso(),
    }
    runs = state.setdefault("nix_runs", [])
    runs[:] = [existing for existing in runs if existing.get("run_id") != item["run_id"]]
    runs.append(item)
    del runs[:-50]


def failed_check_run_id(pr: dict) -> int | None:
    for check in pr.get("statusCheckRollup") or []:
        if not isinstance(check, dict) or check_outcome(check) not in {"fail", "cancel"}:
            continue
        match = re.search(r"/actions/runs/(\d+)", str(check.get("detailsUrl") or check.get("targetUrl") or ""))
        if match:
            return int(match.group(1))
    return None


def finalize_campaign(state: dict, verdict: str, now: float) -> None:
    campaign = state.get("active_campaign")
    if not isinstance(campaign, dict):
        return
    completed = {
        **campaign,
        "phase": "completed",
        "campaign_phase": "completed",
        "verdict": verdict,
        "completed_at": utc_iso(now),
    }
    state["last_accepted_sha256"] = campaign.get("sha256")
    state["last_completed_campaign"] = completed
    state["active_campaign"] = None
    state["worker_lease"] = None
    state["revalidation_required"] = False


def ensure_campaign_notification(state: dict, now: float) -> None:
    pending = state.get("pending_campaign")
    active = state.get("active_campaign")
    if isinstance(pending, dict):
        queue_notification(state, "CHANGE_READY", [pending["sha256"]], f"campaign:{pending['sha256']}:{pending.get('dispatch_key')}")
        return
    if not isinstance(active, dict) or lease_is_active(state.get("worker_lease"), now):
        return
    if active.get("campaign_phase") == "nix-repair":
        latest = state.get("nix_runs")[-1] if state.get("nix_runs") else {}
        run_id = latest.get("run_id") or (state.get("nix_refresh") or {}).get("workflow_run_id") or 0
        queue_notification(state, "NIX_REPAIR_READY", [active["sha256"], run_id], f"nix-repair:{active['sha256']}:{run_id}")
    elif active.get("campaign_phase") in {"drift-validation", "detected"}:
        queue_notification(state, "CHANGE_READY", [active["sha256"]], f"campaign:{active['sha256']}:{active.get('dispatch_key')}")


def emit_existing_campaign(state: dict, now: float, store: Store | None = None) -> bool:
    ensure_campaign_notification(state, now)
    if store is not None:
        store.save(state)
    notification = next_notification(state)
    if notification:
        print(format_notification(notification))
        return True
    active = state.get("active_campaign")
    lease = state.get("worker_lease")
    if active and lease_is_active(lease, now):
        print("WORKER_ACTIVE")
        return True
    if active:
        print("NIX_ACTIVE" if active.get("campaign_phase") in {"awaiting-nix", "nix-refresh"} else "CAMPAIGN_WAITING")
        return True
    return False


def command_probe(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        try:
            headers_payload = Path(args.headers_file).read_text(encoding="utf-8") if args.headers_file else curl_headers(args.url)
            identity = http_identity(parse_headers(headers_payload))
            if identity is None:
                return fail_probe(store, now, "upstream response has no stable HTTP identity")
            state = store.load()
            if (state.get("http_identity") or {}).get("key") == identity["key"]:
                state["probe_failures"] = 0
                state["last_probe_at"] = utc_iso(now)
                state.pop("last_probe_error", None)
                store.save(state)
                dmg_sha = state.get("last_observed_sha256")
                if dmg_sha:
                    process_nix_refresh(args, store, state, identity, dmg_sha, now)
                if not emit_existing_campaign(state, now, store):
                    print("UNCHANGED")
                return 0

            source = Path(args.source_file).resolve() if args.source_file else None
            fd, temporary_name = tempfile.mkstemp(prefix=".download.", suffix=".dmg", dir=store.downloads)
            os.close(fd)
            temporary = Path(temporary_name)
            try:
                if source:
                    shutil.copyfile(source, temporary)
                else:
                    download(args.url, temporary)
                size = temporary.stat().st_size
                if size <= 0:
                    raise RuntimeError("downloaded DMG is empty")
                expected = identity.get("content_length")
                if expected and expected.isdigit() and size != int(expected):
                    raise RuntimeError(f"downloaded DMG size {size} does not match Content-Length {expected}")
                sha = sha256_file(temporary)
                target = store.downloads / f"{sha}.dmg"
                if target.exists():
                    temporary.unlink()
                else:
                    with temporary.open("rb") as handle:
                        os.fsync(handle.fileno())
                    os.replace(temporary, target)
                state = store.load()
                previous_sha = state.get("last_observed_sha256")
                state["http_identity"] = identity
                state["last_observed_sha256"] = sha
                state["probe_failures"] = 0
                state["last_probe_at"] = utc_iso(now)
                state.pop("last_probe_error", None)
                if previous_sha == sha:
                    for key in ("active_campaign", "pending_campaign"):
                        same_campaign = state.get(key)
                        if isinstance(same_campaign, dict) and same_campaign.get("sha256") == sha:
                            same_campaign["http_identity"] = identity
                            same_campaign["dmg_path"] = str(target)
                            same_campaign["updated_at"] = utc_iso(now)
                    store.save(state)
                    process_nix_refresh(args, store, state, identity, sha, now)
                    if not emit_existing_campaign(state, now, store):
                        print("UNCHANGED")
                    return 0

                new_campaign = campaign_for(sha, target, identity, now)
                lease = state.get("worker_lease")
                active = state.get("active_campaign")
                if active and active.get("sha256") == sha and lease and parse_iso(lease.get("expires_at")) > now:
                    store.save(state)
                    print("WORKER_ACTIVE")
                    return 0
                if active and active.get("sha256") != sha:
                    state["pending_campaign"] = new_campaign
                else:
                    state["active_campaign"] = new_campaign
                    state["pending_campaign"] = None
                supersede_campaign_notifications(state, sha, now)
                queue_notification(state, "CHANGE_READY", [sha], f"campaign:{sha}:{new_campaign.get('dispatch_key')}")
                store.save(state)
                emit_existing_campaign(state, now, store)
                return 0
            finally:
                temporary.unlink(missing_ok=True)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            return fail_probe(store, now, str(error))


def lease_is_active(lease: dict | None, now: float) -> bool:
    return bool(lease and parse_iso(lease.get("expires_at")) > now)


def require_owner(state: dict, run_id: str, now: float, allow_expired: bool = False) -> dict:
    lease = state.get("worker_lease")
    if not lease or lease.get("run_id") != run_id:
        raise RuntimeError("worker lease is owned by another run")
    if not allow_expired and not lease_is_active(lease, now):
        raise RuntimeError("worker lease has expired")
    return lease


def require_worker_phase(phase: str | None) -> None:
    if phase in PROTECTED_CAMPAIGN_PHASES:
        raise RuntimeError(f"campaign phase is controlled by a guarded transition: {phase}")


def command_worker_acquire(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        lease = state.get("worker_lease")
        if lease_is_active(lease, now):
            print("WORKER_ACTIVE")
            return 2
        pending = state.get("pending_campaign")
        active = state.get("active_campaign")
        if pending and (args.sha is None or pending.get("sha256") == args.sha):
            if active and active.get("sha256") != pending.get("sha256"):
                active = {**active, "phase": "superseded", "superseded_at": utc_iso(now)}
                state["last_completed_campaign"] = active
            active = pending
            state["active_campaign"] = active
            state["pending_campaign"] = None
        if not active or (args.sha and active.get("sha256") != args.sha):
            print("NO_CAMPAIGN")
            return 4
        run_id = str(uuid.uuid4())
        state["worker_lease"] = {
            "run_id": run_id,
            "acquired_at": utc_iso(now),
            "heartbeat_at": utc_iso(now),
            "expires_at": utc_iso(now + args.ttl),
        }
        previous_round = current_round(active)
        repair_round = current_round(active, create=True)
        if previous_round is not None and repair_round is not previous_round:
            active["acceptance_evidence"] = None
            active["feature_snapshot"] = None
            for field in ("base_sha", "branch", "worktree", "pr_number", "pr_url", "head_sha", "ci_state"):
                active[field] = None
        repair_round["status"] = "active"
        repair_round["acquired_at"] = utc_iso(now)
        acknowledge_campaign_notifications(state, active["sha256"], now)
        active["attempts"] = int(active.get("attempts") or 0) + 1
        active["updated_at"] = utc_iso(now)
        store.save(state)
        print(f"ACQUIRED {run_id} {active['sha256']} {active['dmg_path']}")
        return 0


def command_event_ack(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        if not acknowledge_notification(state, args.event_id, now):
            raise RuntimeError("notification event was not found")
        store.save(state)
        print("EVENT_ACKED")
    return 0


def command_campaign_requeue(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        if lease_is_active(state.get("worker_lease"), now):
            print("WORKER_ACTIVE")
            return 2
        if state.get("active_campaign") or state.get("pending_campaign"):
            raise RuntimeError("cannot requeue while a campaign is already queued")
        sha = args.sha or state.get("last_observed_sha256")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise RuntimeError("no valid DMG SHA-256 is available to requeue")
        if sha != state.get("last_observed_sha256"):
            raise RuntimeError("only the latest observed DMG can be requeued")
        completed = state.get("last_completed_campaign")
        if isinstance(completed, dict) and completed.get("sha256") == sha:
            dmg_path = Path(str(completed.get("dmg_path") or ""))
            identity = completed.get("http_identity") or state.get("http_identity")
        else:
            dmg_path = store.downloads / f"{sha}.dmg"
            identity = state.get("http_identity") if state.get("last_observed_sha256") == sha else None
        if not dmg_path.is_file():
            raise RuntimeError(f"downloaded DMG is missing for {sha}")
        if sha256_file(dmg_path) != sha:
            raise RuntimeError(f"downloaded DMG hash does not match {sha}")
        if not isinstance(identity, dict):
            raise RuntimeError(f"HTTP identity is missing for {sha}")
        campaign = campaign_for(sha, dmg_path, identity, now)
        campaign["requeued_at"] = utc_iso(now)
        campaign["requeue_reason"] = (args.reason or "manual-revalidation")[:500]
        state["active_campaign"] = campaign
        state["pending_campaign"] = None
        state["worker_lease"] = None
        state["revalidation_required"] = True
        if state.get("last_accepted_sha256") == sha:
            state["last_accepted_sha256"] = None
        store.save(state)
        print(f"CHANGE_READY {sha}")
        return 0


def feature_snapshot_helper(source: Path) -> dict:
    helper = Path(__file__).with_name("feature-snapshot.js")
    result = subprocess.run(
        ["node", str(helper), str(source)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Linux feature snapshot failed: {result.stderr.strip()[:1000]}")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Linux feature snapshot helper returned invalid JSON") from error
    if not isinstance(value, dict) or not isinstance(value.get("enabled"), list):
        raise RuntimeError("Linux feature snapshot helper returned an invalid contract")
    return value


def create_feature_snapshot(store: Store, campaign: dict, source: Path, now: float) -> dict:
    repair_round = current_round(campaign, create=True)
    snapshot_dir = store.snapshots / campaign["sha256"] / f"round-{repair_round['round']}"
    existing = campaign.get("feature_snapshot")
    if isinstance(existing, dict) and existing.get("snapshot_dir") == str(snapshot_dir) and snapshot_dir.is_dir():
        return existing

    description = feature_snapshot_helper(source)
    config = description.get("config") or {"enabled": []}
    enabled = description["enabled"]
    if config.get("enabled") != enabled:
        raise RuntimeError("normalized feature config does not match enabled feature manifests")

    snapshot_dir.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = Path(tempfile.mkdtemp(prefix=f".round-{repair_round['round']}.", dir=snapshot_dir.parent))
    local_hashes: dict[str, str] = {}
    try:
        if description.get("hasLocalConfig"):
            (temporary / "features.json").write_bytes(canonical_json(config))
            os.chmod(temporary / "features.json", 0o600)
        local_root = temporary / "local"
        for item in description.get("local") or []:
            if not isinstance(item, dict) or item.get("id") not in enabled:
                raise RuntimeError("Linux feature snapshot helper returned an invalid local feature")
            feature_id = item["id"]
            # Keep this lexical: the shared loader intentionally follows a
            # local feature directory symlink. copytree snapshots its resolved
            # contents while preserving supported links inside the tree.
            feature_dir = Path(os.path.abspath(str(item.get("dir") or "")))
            source_local_root = Path(os.path.abspath(source / "linux-features" / "local"))
            if not feature_dir.is_relative_to(source_local_root) or not (feature_dir / "feature.json").is_file():
                raise RuntimeError(f"enabled local feature is invalid: {feature_id}")
            local_root.mkdir(mode=0o700, exist_ok=True)
            shutil.copytree(feature_dir, local_root / feature_id, symlinks=True)
            local_hashes[feature_id] = sha256_tree(local_root / feature_id)
        if snapshot_dir.exists():
            shutil.rmtree(temporary)
        else:
            os.replace(temporary, snapshot_dir)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)

    config_path = snapshot_dir / "features.json"
    snapshot = {
        "source_checkout": str(source),
        "snapshot_dir": str(snapshot_dir),
        "enabled": enabled,
        "config": config,
        "config_sha256": sha256_file(config_path) if config_path.is_file() else hashlib.sha256(b"").hexdigest(),
        "local_feature_tree_hashes": local_hashes,
        "created_at": utc_iso(now),
        "round": repair_round["round"],
    }
    campaign["feature_snapshot"] = snapshot
    repair_round["feature_snapshot"] = snapshot
    return snapshot


def materialize_feature_snapshot(snapshot: dict, worktree: Path) -> None:
    snapshot_dir = Path(snapshot["snapshot_dir"])
    target_features = worktree / "linux-features"
    target_config = target_features / "features.json"
    target_local = target_features / "local"
    source_config = snapshot_dir / "features.json"
    source_local = snapshot_dir / "local"
    if source_config.is_file():
        temporary = target_features / f".features.{uuid.uuid4().hex}.json"
        try:
            shutil.copyfile(source_config, temporary)
            os.chmod(temporary, 0o600)
            os.replace(temporary, target_config)
        finally:
            temporary.unlink(missing_ok=True)
    else:
        target_config.unlink(missing_ok=True)
    shutil.rmtree(target_local, ignore_errors=True)
    if source_local.is_dir():
        shutil.copytree(source_local, target_local, symlinks=True)


def command_sync_features(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now)
        campaign = state.get("active_campaign")
        if not campaign or not campaign.get("worktree"):
            raise RuntimeError("campaign worktree is not recorded")
        source = Path(args.source_checkout).expanduser().resolve()
        worktree = Path(campaign["worktree"]).expanduser().resolve()
        managed_root = store.worktrees.resolve()
        if not worktree.is_relative_to(managed_root):
            raise RuntimeError("campaign worktree is outside the managed worktree root")
        if not worktree.is_dir():
            raise RuntimeError("campaign worktree does not exist")

        target_features = worktree / "linux-features"
        if not target_features.is_dir():
            raise RuntimeError("managed worktree has no linux-features directory")
        snapshot = create_feature_snapshot(store, campaign, source, now)
        materialize_feature_snapshot(snapshot, worktree)
        campaign["updated_at"] = utc_iso(now)
        store.save(state)
        print("FEATURES_SYNCED " + (",".join(snapshot["enabled"]) if snapshot["enabled"] else "none"))
        return 0


def command_refresh_feature_snapshot(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now)
        campaign = state.get("active_campaign")
        if not campaign:
            raise RuntimeError("no active campaign")
        if campaign.get("acceptance_evidence"):
            raise RuntimeError("cannot refresh features after acceptance; start a new repair round")
        snapshot = campaign.pop("feature_snapshot", None)
        if isinstance(snapshot, dict) and snapshot.get("snapshot_dir"):
            snapshot_dir = Path(snapshot["snapshot_dir"])
            if snapshot_dir.is_relative_to(store.snapshots.resolve()):
                shutil.rmtree(snapshot_dir, ignore_errors=True)
        store.save(state)
        print("FEATURE_SNAPSHOT_CLEARED")
    return 0


def git_head(worktree: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(worktree), "rev-parse", "HEAD"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


def git_tracked_clean(worktree: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(worktree), "diff", "--quiet", "HEAD", "--"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode not in {0, 1}:
        raise RuntimeError(f"could not inspect campaign worktree: {result.stderr.strip()[:500]}")
    return result.returncode == 0


def repair_scope(worktree: Path, base_sha: str | None, head_sha: str) -> dict:
    if not isinstance(base_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", base_sha):
        return {"profile": "full", "paths": [], "feature_ids": [], "reason": "base-head-unavailable"}
    result = subprocess.run(
        ["git", "-C", str(worktree), "diff", "--name-only", f"{base_sha}..{head_sha}", "--"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    paths = sorted({line.strip() for line in result.stdout.splitlines() if line.strip()})
    if not paths:
        return {"profile": "unchanged", "paths": [], "feature_ids": []}
    feature_ids: set[str] = set()
    for path in paths:
        match = re.fullmatch(r"linux-features/([^/]+)/.+", path)
        if not match or match.group(1) == "local":
            return {"profile": "full", "paths": paths, "feature_ids": []}
        feature_ids.add(match.group(1))
    return {"profile": "feature-only", "paths": paths, "feature_ids": sorted(feature_ids)}


def read_json_object(path: Path, label: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"invalid {label}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must contain a JSON object")
    return value


def command_record_acceptance(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now)
        campaign = state.get("active_campaign")
        if not campaign:
            raise RuntimeError("no active campaign")
        if campaign.get("sha256") != state.get("last_observed_sha256") or state.get("pending_campaign"):
            raise RuntimeError("campaign is not the latest observed DMG")
        if not re.fullmatch(r"[0-9a-f]{40}", args.head):
            raise RuntimeError("acceptance head must be a full git SHA")
        worktree = Path(str(campaign.get("worktree") or "")).expanduser().resolve()
        if not worktree.is_relative_to(store.worktrees.resolve()) or not worktree.is_dir():
            raise RuntimeError("campaign worktree is not a managed worktree")
        if git_head(worktree) != args.head or campaign.get("head_sha") != args.head:
            raise RuntimeError("acceptance head does not match the campaign worktree")
        if not git_tracked_clean(worktree):
            raise RuntimeError("campaign worktree has uncommitted tracked changes")
        decision_path = Path(args.decision).expanduser().resolve()
        if not decision_path.is_file() or not decision_path.is_relative_to(worktree):
            raise RuntimeError("acceptance decision must be inside the managed worktree")
        decision = read_json_object(decision_path, "acceptance decision")
        if decision.get("verdict") not in {"accepted", "accepted_with_warnings"}:
            raise RuntimeError("acceptance decision is not accepted")
        if (decision.get("dmg") or {}).get("sha256") != campaign.get("sha256"):
            raise RuntimeError("acceptance decision DMG SHA does not match the campaign")
        source = decision.get("source") or {}
        if source.get("commit") != args.head or source.get("dirty") is True:
            raise RuntimeError("acceptance decision source does not match a clean campaign head")
        snapshot = campaign.get("feature_snapshot")
        if not isinstance(snapshot, dict):
            raise RuntimeError("feature snapshot is missing")
        decision_features = (((decision.get("checks") or {}).get("patchReport") or {}).get("enabledFeatures"))
        if decision_features != snapshot.get("enabled"):
            raise RuntimeError("acceptance decision enabled features do not match the snapshot")
        snapshot_dir = Path(str(snapshot.get("snapshot_dir") or ""))
        config_path = snapshot_dir / "features.json"
        config_hash = sha256_file(config_path) if config_path.is_file() else hashlib.sha256(b"").hexdigest()
        if config_hash != snapshot.get("config_sha256"):
            raise RuntimeError("feature snapshot config changed after creation")
        for feature_id, expected_hash in (snapshot.get("local_feature_tree_hashes") or {}).items():
            if sha256_tree(snapshot_dir / "local" / feature_id) != expected_hash:
                raise RuntimeError(f"local feature snapshot changed after creation: {feature_id}")
        report_value = ((decision.get("checks") or {}).get("patchReport") or {}).get("reportPath")
        report_path = Path(str(report_value or "")).expanduser().resolve()
        if not report_path.is_file() or not report_path.is_relative_to(worktree):
            raise RuntimeError("acceptance patch report must be inside the managed worktree")
        read_json_object(report_path, "acceptance patch report")

        repair_round = current_round(campaign, create=True)
        scope = repair_scope(worktree, repair_round.get("base_sha") or campaign.get("base_sha"), args.head)
        repair_round["validation_scope"] = scope
        evidence_dir = store.evidence / campaign["sha256"] / f"round-{repair_round['round']}" / args.head
        temporary = Path(tempfile.mkdtemp(prefix=".evidence.", dir=store.evidence))
        try:
            shutil.copy2(decision_path, temporary / "decision.json")
            shutil.copy2(report_path, temporary / "patch-report.json")
            evidence_dir.parent.mkdir(parents=True, exist_ok=True)
            if evidence_dir.exists():
                shutil.rmtree(evidence_dir)
            os.replace(temporary, evidence_dir)
        finally:
            shutil.rmtree(temporary, ignore_errors=True)
        evidence = {
            "verdict": decision["verdict"],
            "dmg_sha256": campaign["sha256"],
            "head_sha": args.head,
            "decision_path": str(evidence_dir / "decision.json"),
            "decision_sha256": sha256_file(evidence_dir / "decision.json"),
            "patch_report_path": str(evidence_dir / "patch-report.json"),
            "patch_report_sha256": sha256_file(evidence_dir / "patch-report.json"),
            "feature_config_sha256": snapshot["config_sha256"],
            "local_feature_tree_hashes": snapshot.get("local_feature_tree_hashes") or {},
            "enabled_features": snapshot["enabled"],
            "validation_scope": scope,
            "recorded_at": utc_iso(now),
        }
        campaign["acceptance_evidence"] = evidence
        repair_round["acceptance_evidence"] = evidence
        campaign["campaign_phase"] = "accepted-head"
        campaign["phase"] = "accepted-head"
        repair_round["accepted_head_sha"] = args.head
        repair_round["status"] = "accepted-head"
        campaign["updated_at"] = utc_iso(now)
        store.save(state)
        print(f"ACCEPTANCE_RECORDED {args.head}")
    return 0


def transient_output(payload: str) -> bool:
    return bool(re.search(
        r"timed? out|temporary failure|could not resolve host|connection (?:reset|refused)|network is unreachable|\b50[234]\b|rate.?limit",
        payload,
        flags=re.IGNORECASE,
    ))


def changed_tracked_paths(worktree: Path) -> set[str]:
    result = subprocess.run(
        ["git", "-C", str(worktree), "diff", "--name-only", "HEAD", "--"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def command_nix_preflight(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    if args.target and not re.fullmatch(r"\.#[A-Za-z0-9._+-]+", args.target):
        raise RuntimeError("Nix preflight target must be a flake output such as .#checks.x86_64-linux.example")
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now)
        campaign = state.get("active_campaign")
        if not campaign or not isinstance(campaign.get("acceptance_evidence"), dict):
            raise RuntimeError("accepted campaign evidence is required before Nix preflight")
        evidence = dict(campaign["acceptance_evidence"])
        source_worktree = Path(str(campaign.get("worktree") or "")).resolve()
        if not source_worktree.is_relative_to(store.worktrees.resolve()) or not source_worktree.is_dir():
            raise RuntimeError("campaign worktree is not managed")
        head = evidence["head_sha"]
        if git_head(source_worktree) != head:
            raise RuntimeError("campaign head changed after acceptance")
        repair_round = current_round(campaign, create=True)
        repair_round_number = repair_round["round"]
        scope = repair_round.get("validation_scope") or evidence.get("validation_scope") or {"profile": "full"}
        if args.target and scope.get("profile") != "feature-only":
            raise RuntimeError("a focused Nix target is allowed only for a feature-only repair")
        target = args.target
        if scope.get("profile") == "feature-only" and not target:
            target = ".#checks.x86_64-linux.nix-linux-features-multi-feature"

    scratch = store.preflight / f"{campaign['sha256'][:12]}-round-{repair_round_number}-{uuid.uuid4().hex[:8]}"
    log_payload = ""
    classification = "source"
    attempts = 0
    success = False
    try:
        subprocess.run(
            ["git", "-C", str(source_worktree), "worktree", "add", "--detach", str(scratch), head],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        command = [str(scratch / "scripts" / "ci" / "update-nix-hashes.sh")]
        command_env = os.environ.copy()
        if target:
            command_env["NIX_VERIFY_OUTPUTS"] = target
        for attempt in range(1, args.max_attempts + 1):
            attempts = attempt
            result = subprocess.run(
                command,
                cwd=scratch,
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=command_env,
            )
            log_payload += f"\n===== attempt {attempt} =====\n{result.stdout}"
            if result.returncode == 0:
                changed = changed_tracked_paths(scratch)
                unexpected = changed - NIX_ALLOWED_PATHS
                if unexpected:
                    log_payload += f"\nunexpected tracked paths: {sorted(unexpected)}\n"
                    classification = "source"
                    break
                if extract_codex_dmg_sri((scratch / "flake.nix").read_text(encoding="utf-8")) != sha256_sri(campaign["sha256"]):
                    log_payload += "\nrefreshed flake hash does not match campaign DMG\n"
                    classification = "source"
                    break
                success = True
                classification = "success"
                break
            classification = "transient" if transient_output(result.stdout) else "source"
            if classification != "transient" or attempt >= args.max_attempts:
                break
            time.sleep(min(args.retry_delay * (2 ** (attempt - 1)), 60))
    finally:
        if scratch.exists():
            subprocess.run(
                ["git", "-C", str(source_worktree), "worktree", "remove", "--force", str(scratch)],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            shutil.rmtree(scratch, ignore_errors=True)

    with store.locked():
        state = store.load()
        finish_now = args.now if args.now is not None else time.time()
        require_owner(state, args.run_id, finish_now)
        campaign = state.get("active_campaign")
        if not campaign or (campaign.get("acceptance_evidence") or {}).get("head_sha") != head:
            raise RuntimeError("campaign changed during Nix preflight")
        repair_round = current_round(campaign, create=True)
        report_dir = store.evidence / campaign["sha256"] / f"round-{repair_round['round']}" / head
        report_dir.mkdir(parents=True, exist_ok=True)
        log_path = report_dir / "nix-preflight.log"
        log_path.write_text(log_payload, encoding="utf-8")
        preflight = {
            "status": "success" if success else "failed",
            "classification": classification,
            "target": target,
            "head_sha": head,
            "attempts": attempts,
            "log_path": str(log_path),
            "log_sha256": sha256_file(log_path),
            "completed_at": utc_iso(),
        }
        repair_round["nix_preflight"] = preflight
        campaign["nix_failure_class"] = None if success else classification
        campaign["phase"] = "nix-preflight-green" if success else "nix-preflight-failed"
        campaign["campaign_phase"] = campaign["phase"]
        campaign["updated_at"] = utc_iso()
        store.save(state)
        if success:
            print(f"NIX_PREFLIGHT_ACCEPTED {head}")
            return 0
        print(f"NIX_PREFLIGHT_{classification.upper()}_FAILURE {head}")
        return 6


def repair_pr_status(campaign: dict, pr: dict) -> tuple[str, str]:
    if pr.get("state", "OPEN") != "OPEN":
        return "blocked", "pr-not-open"
    if pr.get("baseRefName") != "main" or pr.get("isDraft") is True:
        return "blocked", "wrong-base-or-draft"
    if pr.get("headRefName") != campaign.get("branch") or pr.get("headRefOid") != campaign.get("head_sha"):
        return "blocked", "unexpected-head"
    marker = f"<!-- upstream-dmg-sha256:{campaign['sha256']} -->"
    if marker not in str(pr.get("body") or ""):
        return "blocked", "missing-dmg-marker"
    mergeable = str(pr.get("mergeable") or "UNKNOWN").upper()
    if mergeable == "CONFLICTING":
        return "blocked", "merge-conflict"
    if mergeable != "MERGEABLE":
        return "waiting", "mergeability-pending"
    checks = pr.get("statusCheckRollup") or []
    seen: dict[str, str] = {}
    for check in checks:
        if not isinstance(check, dict):
            continue
        name = check.get("name") or check.get("context")
        outcome = check_outcome(check)
        if isinstance(name, str):
            seen[name] = outcome
        if outcome in {"fail", "cancel"}:
            return "blocked", f"check-{outcome}:{name or 'unknown'}"
        if outcome == "pending":
            return "waiting", "checks-pending"
    missing = sorted(name for name in REPAIR_REQUIRED_CHECKS if seen.get(name) != "pass")
    if missing:
        return "waiting", "required-checks-missing:" + ",".join(missing)
    return "ready", "ready"


def command_validate_repair_pr(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now)
        campaign = state.get("active_campaign")
        if not campaign or state.get("pending_campaign") or campaign.get("sha256") != state.get("last_observed_sha256"):
            raise RuntimeError("repair campaign is no longer current")
        evidence = campaign.get("acceptance_evidence")
        if not isinstance(evidence, dict) or evidence.get("head_sha") != campaign.get("head_sha"):
            raise RuntimeError("current PR head has no acceptance evidence")
        repair_round = current_round(campaign, create=True)
        preflight = repair_round.get("nix_preflight")
        if not isinstance(preflight, dict) or preflight.get("status") != "success" or preflight.get("head_sha") != campaign.get("head_sha"):
            raise RuntimeError("current PR head has no successful Nix preflight")
        headers_payload = Path(args.headers_file).read_text(encoding="utf-8") if args.headers_file else curl_headers(args.url)
        identity = http_identity(parse_headers(headers_payload))
        if identity is None or identity.get("key") != (campaign.get("http_identity") or {}).get("key"):
            raise RuntimeError("upstream DMG changed before repair PR merge")
        pr = repair_pr_view(args.repository, args.pr_number)
        status, reason = repair_pr_status(campaign, pr)
        repair_round["pr_number"] = args.pr_number
        repair_round["pr_url"] = pr.get("url")
        repair_round["status"] = f"pr-{status}"
        campaign["pr_number"] = str(args.pr_number)
        campaign["pr_url"] = pr.get("url")
        campaign["ci_state"] = reason
        campaign["updated_at"] = utc_iso(now)
        store.save(state)
        if status != "ready":
            print(f"REPAIR_PR_{status.upper()} {reason}")
            return 7 if status == "blocked" else 8
        print(f"REPAIR_PR_READY {args.pr_number} {campaign['head_sha']}")
        return 0


def reset_nix_refresh_for_campaign(state: dict, campaign: dict) -> None:
    refresh = default_state()["nix_refresh"]
    refresh["expected_dmg_sha256"] = campaign["sha256"]
    refresh["expected_dmg_sri"] = sha256_sri(campaign["sha256"])
    refresh["workflow_status"] = "ready-to-dispatch"
    state["nix_refresh"] = refresh
    state["nix_failure_class"] = None


def command_advance_to_nix(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now)
        campaign = state.get("active_campaign")
        if not campaign or state.get("pending_campaign") or campaign.get("sha256") != state.get("last_observed_sha256"):
            raise RuntimeError("campaign is no longer current")
        evidence = campaign.get("acceptance_evidence")
        if not isinstance(evidence, dict) or evidence.get("head_sha") != campaign.get("head_sha"):
            raise RuntimeError("current campaign head has no acceptance evidence")
        repair_round = current_round(campaign, create=True)
        if args.pr_number is not None:
            preflight = repair_round.get("nix_preflight")
            if (
                not isinstance(preflight, dict)
                or preflight.get("status") != "success"
                or preflight.get("head_sha") != campaign.get("head_sha")
            ):
                raise RuntimeError("successful Nix preflight is required")
            pr = repair_pr_view(args.repository, args.pr_number)
            if pr.get("state") != "MERGED" or pr.get("headRefOid") != evidence["head_sha"] or not pr.get("mergedAt"):
                raise RuntimeError("GitHub did not confirm the accepted repair PR merge")
            merge_commit = pr.get("mergeCommit") or {}
            merge_sha = merge_commit.get("oid") if isinstance(merge_commit, dict) else None
            if not isinstance(merge_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", merge_sha):
                raise RuntimeError("repair PR merge commit is unavailable")
            repair_round["pr_number"] = args.pr_number
            repair_round["pr_url"] = pr.get("url")
            repair_round["merge_sha"] = merge_sha
            repair_round["status"] = "merged"
            campaign["accepted_main_sha"] = merge_sha
        else:
            scope = repair_round.get("validation_scope") or evidence.get("validation_scope") or {}
            if scope.get("profile") != "unchanged":
                raise RuntimeError("only an unchanged accepted main may advance without a repair PR")
            main_sha = github_ref_sha(args.repository, "main")
            if main_sha != evidence["head_sha"]:
                raise RuntimeError("accepted head is not the current main head")
            repair_round["merge_sha"] = main_sha
            repair_round["status"] = "accepted-main"
            campaign["accepted_main_sha"] = main_sha
        campaign["campaign_phase"] = "awaiting-nix"
        campaign["phase"] = "awaiting-nix"
        campaign["updated_at"] = utc_iso(now)
        state["worker_lease"] = None
        reset_nix_refresh_for_campaign(state, campaign)
        store.save(state)
        print(f"AWAITING_NIX {campaign['sha256']}")
    return 0


def command_assert_owner(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now)
        print("OWNER_OK")
    return 0


def command_heartbeat(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        lease = require_owner(state, args.run_id, now)
        lease["heartbeat_at"] = utc_iso(now)
        lease["expires_at"] = utc_iso(now + args.ttl)
        campaign = state.get("active_campaign")
        if campaign and args.phase:
            require_worker_phase(args.phase)
            campaign["phase"] = args.phase
            campaign["campaign_phase"] = args.phase
            current_round(campaign, create=True)["status"] = args.phase
            campaign["updated_at"] = utc_iso(now)
        store.save(state)
        print("RENEWED")
    return 0


CAMPAIGN_FIELDS = ("phase", "base_sha", "branch", "worktree", "pr_number", "pr_url", "head_sha", "ci_state", "last_error")


def command_campaign_update(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now)
        campaign = state.get("active_campaign")
        if not campaign:
            raise RuntimeError("no active campaign")
        require_worker_phase(args.phase)
        previous_head = campaign.get("head_sha")
        for field in CAMPAIGN_FIELDS:
            value = getattr(args, field)
            if value is not None:
                campaign[field] = value
        repair_round = current_round(campaign, create=True)
        for field in ("base_sha", "branch", "worktree", "pr_number", "pr_url", "head_sha"):
            value = getattr(args, field)
            if value is not None:
                repair_round[field] = value
        if args.phase is not None:
            repair_round["status"] = args.phase
            campaign["campaign_phase"] = args.phase
        if args.head_sha is not None and previous_head not in {None, args.head_sha}:
            campaign["acceptance_evidence"] = None
            repair_round["accepted_head_sha"] = None
            repair_round["nix_preflight"] = None
        campaign["updated_at"] = utc_iso(now)
        store.save(state)
        print("UPDATED")
    return 0


def command_release(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        require_owner(state, args.run_id, now, allow_expired=True)
        campaign = state.get("active_campaign")
        if campaign and args.error:
            campaign["last_error"] = args.error[:1000]
            campaign["updated_at"] = utc_iso(now)
        state["worker_lease"] = None
        store.save(state)
        print("RELEASED")
    return 0


def command_campaign_complete(args: argparse.Namespace, store: Store) -> int:
    now = args.now if args.now is not None else time.time()
    with store.locked():
        state = store.load()
        campaign = state.get("active_campaign")
        if not campaign:
            print("COMPLETED_ALREADY")
            return 0
        require_owner(state, args.run_id, now, allow_expired=True)
        raise RuntimeError("campaign completion is automatic after Nix synchronization; use advance-to-nix")
    return 0


def command_status(args: argparse.Namespace, store: Store) -> int:
    with store.locked():
        print(json.dumps(store.load(), indent=2, sort_keys=True))
    return 0


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--state-dir", help="Override the persistent state directory")
    parser.add_argument("--now", type=float, help=argparse.SUPPRESS)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    probe = subparsers.add_parser("probe")
    add_common(probe)
    probe.add_argument("--url", default=DEFAULT_URL)
    probe.add_argument("--repository", default=DEFAULT_REPOSITORY)
    probe.add_argument("--headers-file", help=argparse.SUPPRESS)
    probe.add_argument("--premerge-headers-file", help=argparse.SUPPRESS)
    probe.add_argument("--source-file", help=argparse.SUPPRESS)
    probe.add_argument("--skip-nix", action="store_true", help=argparse.SUPPRESS)
    probe.add_argument("--dry-run", action="store_true", help=argparse.SUPPRESS)
    probe.set_defaults(handler=command_probe)

    acquire = subparsers.add_parser("worker-acquire")
    add_common(acquire)
    acquire.add_argument("--sha")
    acquire.add_argument("--ttl", type=int, default=DEFAULT_TTL_SECONDS)
    acquire.set_defaults(handler=command_worker_acquire)

    requeue = subparsers.add_parser("campaign-requeue")
    add_common(requeue)
    requeue.add_argument("--sha")
    requeue.add_argument("--reason")
    requeue.set_defaults(handler=command_campaign_requeue)

    owner = subparsers.add_parser("assert-owner")
    add_common(owner)
    owner.add_argument("--run-id", required=True)
    owner.set_defaults(handler=command_assert_owner)

    heartbeat = subparsers.add_parser("heartbeat")
    add_common(heartbeat)
    heartbeat.add_argument("--run-id", required=True)
    heartbeat.add_argument("--phase")
    heartbeat.add_argument("--ttl", type=int, default=DEFAULT_TTL_SECONDS)
    heartbeat.set_defaults(handler=command_heartbeat)

    update = subparsers.add_parser("campaign-update")
    add_common(update)
    update.add_argument("--run-id", required=True)
    for field in CAMPAIGN_FIELDS:
        update.add_argument(f"--{field.replace('_', '-')}")
    update.set_defaults(handler=command_campaign_update)

    sync_features = subparsers.add_parser("sync-features")
    add_common(sync_features)
    sync_features.add_argument("--run-id", required=True)
    sync_features.add_argument("--source-checkout", required=True)
    sync_features.set_defaults(handler=command_sync_features)

    refresh_features = subparsers.add_parser("refresh-feature-snapshot")
    add_common(refresh_features)
    refresh_features.add_argument("--run-id", required=True)
    refresh_features.set_defaults(handler=command_refresh_feature_snapshot)

    acceptance = subparsers.add_parser("record-acceptance")
    add_common(acceptance)
    acceptance.add_argument("--run-id", required=True)
    acceptance.add_argument("--decision", required=True)
    acceptance.add_argument("--head", required=True)
    acceptance.set_defaults(handler=command_record_acceptance)

    preflight = subparsers.add_parser("nix-preflight")
    add_common(preflight)
    preflight.add_argument("--run-id", required=True)
    preflight.add_argument("--max-attempts", type=int, default=3)
    preflight.add_argument("--retry-delay", type=int, default=30)
    preflight.add_argument(
        "--target",
        help="Verify only one Nix flake output for a focused feature-only repair",
    )
    preflight.set_defaults(handler=command_nix_preflight)

    validate_pr = subparsers.add_parser("validate-repair-pr")
    add_common(validate_pr)
    validate_pr.add_argument("--run-id", required=True)
    validate_pr.add_argument("--pr-number", required=True, type=int)
    validate_pr.add_argument("--repository", default=DEFAULT_REPOSITORY)
    validate_pr.add_argument("--url", default=DEFAULT_URL)
    validate_pr.add_argument("--headers-file", help=argparse.SUPPRESS)
    validate_pr.set_defaults(handler=command_validate_repair_pr)

    advance = subparsers.add_parser("advance-to-nix")
    add_common(advance)
    advance.add_argument("--run-id", required=True)
    advance.add_argument("--pr-number", type=int)
    advance.add_argument("--repository", default=DEFAULT_REPOSITORY)
    advance.set_defaults(handler=command_advance_to_nix)

    event_ack = subparsers.add_parser("event-ack")
    add_common(event_ack)
    event_ack.add_argument("--event-id", required=True)
    event_ack.set_defaults(handler=command_event_ack)

    release = subparsers.add_parser("release")
    add_common(release)
    release.add_argument("--run-id", required=True)
    release.add_argument("--error")
    release.set_defaults(handler=command_release)

    complete = subparsers.add_parser("campaign-complete")
    add_common(complete)
    complete.add_argument("--run-id", required=True)
    complete.add_argument("--verdict", choices=("accepted", "accepted_with_warnings", "merged"))
    complete.set_defaults(handler=command_campaign_complete)

    status = subparsers.add_parser("status")
    add_common(status)
    status.set_defaults(handler=command_status)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    store = Store(state_root(args.state_dir))
    try:
        return args.handler(args, store)
    except RuntimeError as error:
        print(f"ERROR {error}", file=sys.stderr)
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
