#!/usr/bin/env python3

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


SCRIPT = Path(__file__).with_name("watchdog.py")


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.dmg_a = self.root / "a.dmg"
        self.dmg_b = self.root / "b.dmg"
        self.dmg_a.write_bytes(b"first-dmg")
        self.dmg_b.write_bytes(b"second-dmg")
        self.fake_gh = self.root / "fake-gh"
        self.fake_gh.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import base64
                import json
                import os
                from pathlib import Path
                import sys

                scenario_path = Path(os.environ["FAKE_GH_SCENARIO"])
                scenario = json.loads(scenario_path.read_text())
                runtime_path = scenario_path.with_suffix(".runtime.json")
                runtime = json.loads(runtime_path.read_text()) if runtime_path.exists() else {}
                args = sys.argv[1:]
                with scenario_path.with_suffix(".calls.jsonl").open("a") as log:
                    log.write(json.dumps(args) + "\\n")

                def save():
                    runtime_path.write_text(json.dumps(runtime))

                if args[:1] == ["api"]:
                    if "/commits/" in args[1]:
                        print(json.dumps({"sha": scenario.get("main_sha", "f" * 40)}))
                    else:
                        ref = args[1].split("?ref=", 1)[1]
                        if ref == "main":
                            content = scenario["main_flake"]
                        else:
                            content = scenario.get("head_flakes", {}).get(ref)
                        if content is None:
                            raise SystemExit(1)
                        print(json.dumps({"content": base64.b64encode(content.encode()).decode()}))
                elif args[:2] == ["pr", "list"]:
                    print(json.dumps(scenario.get("prs", [])))
                elif args[:2] == ["run", "list"]:
                    key = "ci_runs" if "ci.yml" in args else "runs"
                    print(json.dumps(scenario.get(key, [])))
                elif args[:2] == ["run", "view"]:
                    run_id = args[2]
                    if "--log-failed" in args:
                        print(scenario.get("run_logs", {}).get(run_id, ""))
                    else:
                        print(json.dumps(scenario.get("run_views", {}).get(run_id, {})))
                elif args[:2] == ["workflow", "run"]:
                    runtime["dispatches"] = runtime.get("dispatches", 0) + 1
                    save()
                elif args[:2] == ["pr", "merge"]:
                    if scenario.get("merge_fails"):
                        raise SystemExit(1)
                    runtime["merged"] = True
                    runtime["merge_args"] = args
                    save()
                elif args[:2] == ["pr", "view"]:
                    if runtime.get("merged"):
                        value = scenario["merged_pr"]
                    else:
                        views = scenario.get("pr_views") or scenario.get("prs", [])
                        index = runtime.get("view_index", 0)
                        value = views[min(index, len(views) - 1)]
                        runtime["view_index"] = index + 1
                        save()
                    print(json.dumps(value))
                else:
                    raise SystemExit(f"unsupported fake gh command: {args}")
                """
            ),
            encoding="utf-8",
        )
        self.fake_gh.chmod(0o755)

    def tearDown(self):
        self.temporary.cleanup()

    def headers(self, name: str, etag: str, source: Path) -> Path:
        target = self.root / name
        target.write_text(
            "HTTP/1.1 200 OK\r\n"
            f"ETag: \"{etag}\"\r\n"
            f"Content-Length: {source.stat().st_size}\r\n\r\n",
            encoding="utf-8",
        )
        return target

    def run_cli(self, *args: str, check: bool = True, env: dict | None = None):
        return subprocess.run(
            ["python3", str(SCRIPT), *args, "--state-dir", str(self.state)],
            check=check,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, **(env or {})},
        )

    def probe(self, headers: Path, source: Path, now: float = 1000, check: bool = True):
        return self.run_cli(
            "probe", "--headers-file", str(headers), "--source-file", str(source), "--now", str(now),
            "--skip-nix", check=check
        )

    def load_state(self):
        return json.loads((self.state / "state.json").read_text(encoding="utf-8"))

    def sri(self, source: Path) -> str:
        digest = hashlib.sha256(source.read_bytes()).digest()
        return "sha256-" + base64.b64encode(digest).decode()

    def flake(self, sri: str) -> str:
        return f'''{{ pkgs }}: let\n  codexDmg = pkgs.fetchurl {{\n    url = "https://example.test/Codex.dmg";\n    hash = "{sri}";\n  }};\nin codexDmg\n'''

    def checks(self, outcome: str = "SUCCESS") -> list[dict]:
        names = [
            "Rust and Smoke Tests",
            "Build Debian Package",
            "Build RPM Package",
            "Build Pacman Package",
            "Nix Package Builds",
        ]
        return [{"name": name, "status": "COMPLETED", "conclusion": outcome} for name in names]

    def repair_checks(self, outcome: str = "SUCCESS") -> list[dict]:
        return self.checks(outcome) + [{
            "name": "Build App Against Upstream DMG", "status": "COMPLETED", "conclusion": outcome,
        }]

    def nix_pr(self, sri: str, *, head: str = "a" * 40, **overrides) -> dict:
        value = {
            "number": 99,
            "url": "https://github.com/ilysenko/codex-desktop-linux/pull/99",
            "state": "OPEN",
            "author": {"login": "app/github-actions"},
            "headRepositoryOwner": {"login": "ilysenko"},
            "headRefName": "codex/nix-upstream-refresh",
            "headRefOid": head,
            "baseRefName": "main",
            "isDraft": False,
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "BLOCKED",
            "files": [{"path": "flake.nix"}],
            "statusCheckRollup": self.checks(),
        }
        value.update(overrides)
        return value

    def write_scenario(self, value: dict) -> tuple[Path, dict]:
        path = self.root / "scenario.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        env = {"UPSTREAM_DMG_WATCHDOG_GH": str(self.fake_gh), "FAKE_GH_SCENARIO": str(path)}
        return path, env

    def fake_calls(self, scenario: Path) -> list[list[str]]:
        path = scenario.with_suffix(".calls.jsonl")
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def complete_baseline(self, headers: Path) -> str:
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(headers, self.dmg_a)
        self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        state = self.load_state()
        state["active_campaign"]["phase"] = "awaiting-nix"
        state["active_campaign"]["campaign_phase"] = "awaiting-nix"
        state["worker_lease"] = None
        state["pending_notifications"] = []
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        return sha

    def finish_baseline(self, headers: Path) -> str:
        sha = self.complete_baseline(headers)
        state = self.load_state()
        campaign = state["active_campaign"]
        state["last_completed_campaign"] = {**campaign, "phase": "completed", "campaign_phase": "completed"}
        state["last_accepted_sha256"] = sha
        state["active_campaign"] = None
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        return sha

    def prepare_acceptance_fixture(self, headers: Path):
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(headers, self.dmg_a)
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        run_id = acquired.stdout.split()[1]
        worktree = self.state / "worktrees" / sha[:12]
        feature = worktree / "linux-features" / "ui-tweaks"
        feature.mkdir(parents=True)
        (feature / "README.md").write_text("ui\n", encoding="utf-8")
        (feature / "feature.json").write_text('{"id":"ui-tweaks"}\n', encoding="utf-8")
        (worktree / ".gitignore").write_text("linux-features/features.json\n", encoding="utf-8")
        subprocess.run(["git", "init", "-b", "main", str(worktree)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "-C", str(worktree), "config", "user.name", "Test"], check=True)
        subprocess.run(["git", "-C", str(worktree), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(worktree), "add", "."], check=True)
        subprocess.run(["git", "-C", str(worktree), "commit", "-m", "fixture"], check=True, stdout=subprocess.DEVNULL)
        head = subprocess.check_output(["git", "-C", str(worktree), "rev-parse", "HEAD"], text=True).strip()
        (worktree / "linux-features" / "features.json").write_text('{"enabled":["ui-tweaks"]}\n', encoding="utf-8")
        self.run_cli(
            "campaign-update", "--run-id", run_id, "--worktree", str(worktree), "--head-sha", head,
            "--base-sha", head, "--now", "1001",
        )
        self.run_cli(
            "sync-features", "--run-id", run_id, "--source-checkout", str(worktree), "--now", "1002"
        )
        report = worktree / "patch-report.json"
        report.write_text('{"enabledFeatures":["ui-tweaks"],"patches":[]}\n', encoding="utf-8")
        decision = worktree / "decision.json"
        decision.write_text(json.dumps({
            "verdict": "accepted",
            "dmg": {"sha256": sha},
            "source": {"commit": head, "dirty": False},
            "checks": {"patchReport": {"enabledFeatures": ["ui-tweaks"], "reportPath": str(report)}},
        }), encoding="utf-8")
        return sha, run_id, worktree, head, decision

    def nix_probe(self, headers: Path, env: dict, now: float = 1100, *extra: str, check: bool = True):
        return self.run_cli(
            "probe", "--headers-file", str(headers), "--source-file", str(self.dmg_a), "--now", str(now),
            *extra, check=check, env=env
        )

    def test_unfinished_campaign_is_redispatched_when_identity_is_unchanged(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        first = self.probe(headers, self.dmg_a)
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.assertTrue(first.stdout.strip().startswith(f"CHANGE_READY {sha} EVENT_ID="))
        second = self.probe(headers, self.dmg_a, now=1100)
        self.assertEqual(second.stdout.strip(), first.stdout.strip())
        self.assertEqual(self.load_state()["active_campaign"]["sha256"], sha)

    def test_changed_headers_with_same_sha_are_unchanged(self):
        self.probe(self.headers("a.headers", "etag-a", self.dmg_a), self.dmg_a)
        result = self.probe(self.headers("b.headers", "etag-b", self.dmg_a), self.dmg_a, now=1100)
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.assertTrue(result.stdout.strip().startswith(f"CHANGE_READY {sha} EVENT_ID="))
        state = self.load_state()
        self.assertEqual(state["http_identity"]["etag"], "etag-b")
        self.assertEqual(state["active_campaign"]["http_identity"]["etag"], "etag-b")

    def test_new_sha_supersedes_an_undelivered_old_campaign_event(self):
        sha_b = hashlib.sha256(self.dmg_b.read_bytes()).hexdigest()
        self.probe(self.headers("a.headers", "etag-a", self.dmg_a), self.dmg_a)

        changed = self.probe(self.headers("b.headers", "etag-b", self.dmg_b), self.dmg_b, now=1100)

        self.assertTrue(changed.stdout.strip().startswith(f"CHANGE_READY {sha_b} EVENT_ID="))
        notifications = self.load_state()["pending_notifications"]
        old_event, new_event = notifications[-2:]
        self.assertEqual(old_event["superseded_by_sha256"], sha_b)
        self.assertIsNotNone(old_event["acked_at"])
        self.assertIsNone(new_event["acked_at"])

    def test_completed_campaign_with_same_identity_is_unchanged(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.finish_baseline(headers)
        result = self.probe(headers, self.dmg_a, now=1100)
        self.assertEqual(result.stdout.strip(), "UNCHANGED")

    def test_active_worker_is_reported_for_unchanged_identity(self):
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.probe(headers, self.dmg_a)
        self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        result = self.probe(headers, self.dmg_a, now=1001)
        self.assertEqual(result.stdout.strip(), "WORKER_ACTIVE")

    def test_acknowledged_campaign_event_is_not_requeued(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        first = self.probe(headers, self.dmg_a)
        event_id = first.stdout.strip().split("EVENT_ID=", 1)[1]
        self.run_cli("event-ack", "--event-id", event_id, "--now", "1001")
        second = self.probe(headers, self.dmg_a, now=1002)
        self.assertEqual(second.stdout.strip(), "CAMPAIGN_WAITING")

    def test_worker_and_nix_notifications_are_delivered_in_order(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        first = self.probe(headers, self.dmg_a)
        first_event = first.stdout.strip().split("EVENT_ID=", 1)[1]
        state = self.load_state()
        state["pending_notifications"].append({
            "id": "nix-event",
            "key": "nix-blocked:test",
            "kind": "NIX_BLOCKED",
            "payload": [925, "required-checks-missing"],
            "created_at": "1970-01-01T00:16:41Z",
            "acked_at": None,
        })
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")

        self.run_cli("event-ack", "--event-id", first_event, "--now", "1001")
        second = self.probe(headers, self.dmg_a, now=1002)

        self.assertEqual(
            second.stdout.strip(),
            "NIX_BLOCKED 925 required-checks-missing EVENT_ID=nix-event",
        )

    def test_schema_v1_is_migrated_without_losing_campaign(self):
        self.state.mkdir(parents=True)
        (self.state / "state.json").write_text(json.dumps({
            "schema": 1,
            "last_observed_sha256": "a" * 64,
            "active_campaign": {"sha256": "a" * 64, "phase": "building", "detected_at": "old"},
            "nix_refresh": {"workflow_status": "waiting-for-pr", "pr_number": 925},
        }), encoding="utf-8")
        result = self.run_cli("status")
        state = json.loads(result.stdout)
        self.assertEqual(state["schema"], 2)
        self.assertEqual(state["active_campaign"]["sha256"], "a" * 64)
        self.assertEqual(state["active_campaign"]["campaign_phase"], "building")
        self.assertEqual(state["nix_refresh"]["pr_number"], 925)

    def test_schema_v1_completed_drift_campaign_resumes_unfinished_nix_phase(self):
        sha = "a" * 64
        completed = {
            "sha256": sha,
            "phase": "completed",
            "verdict": "accepted",
            "detected_at": "2026-01-01T00:00:00Z",
            "head_sha": "b" * 40,
        }
        self.state.mkdir(parents=True)
        (self.state / "state.json").write_text(json.dumps({
            "schema": 1,
            "last_observed_sha256": sha,
            "last_accepted_sha256": sha,
            "active_campaign": None,
            "last_completed_campaign": completed,
            "pending_notifications": None,
            "nix_runs": None,
            "nix_refresh": {
                "expected_dmg_sha256": sha,
                "workflow_status": "waiting-for-pr",
                "pr_number": 925,
            },
            "last_merged_nix_pr": None,
        }), encoding="utf-8")

        state = json.loads(self.run_cli("status").stdout)

        self.assertEqual(state["active_campaign"]["sha256"], sha)
        self.assertEqual(state["active_campaign"]["campaign_phase"], "awaiting-nix")
        self.assertEqual(state["active_campaign"]["phase"], "awaiting-nix")
        self.assertEqual(state["nix_refresh"]["pr_number"], 925)
        self.assertEqual(state["pending_notifications"], [])
        self.assertEqual(state["nix_runs"], [])

    def test_missing_stable_identity_retries_without_campaign(self):
        headers = self.root / "bad.headers"
        headers.write_text("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n", encoding="utf-8")
        result = self.probe(headers, self.dmg_a, check=False)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout.strip(), "RETRY 1")
        self.assertIsNone(self.load_state()["active_campaign"])

    def test_worker_lease_conflict_and_crash_recovery(self):
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(self.headers("a.headers", "etag-a", self.dmg_a), self.dmg_a)
        first = self.run_cli("worker-acquire", "--sha", sha, "--now", "1000", "--ttl", "10")
        run_id = first.stdout.split()[1]
        busy = self.run_cli("worker-acquire", "--sha", sha, "--now", "1005", check=False)
        self.assertEqual(busy.returncode, 2)
        self.assertEqual(busy.stdout.strip(), "WORKER_ACTIVE")
        recovered = self.run_cli("worker-acquire", "--sha", sha, "--now", "1011")
        self.assertEqual(recovered.stdout.split()[0], "ACQUIRED")
        self.assertNotEqual(recovered.stdout.split()[1], run_id)

    def test_new_sha_is_pending_and_supersedes_after_release(self):
        sha_a = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        sha_b = hashlib.sha256(self.dmg_b.read_bytes()).hexdigest()
        self.probe(self.headers("a.headers", "etag-a", self.dmg_a), self.dmg_a)
        acquired = self.run_cli("worker-acquire", "--sha", sha_a, "--now", "1000")
        run_id = acquired.stdout.split()[1]
        changed = self.probe(self.headers("b.headers", "etag-b", self.dmg_b), self.dmg_b, now=1100)
        self.assertTrue(changed.stdout.strip().startswith(f"CHANGE_READY {sha_b} EVENT_ID="))
        self.assertEqual(self.load_state()["pending_campaign"]["sha256"], sha_b)
        self.run_cli("release", "--run-id", run_id, "--now", "1101")
        next_run = self.run_cli("worker-acquire", "--sha", sha_b, "--now", "1102")
        self.assertEqual(next_run.stdout.split()[2], sha_b)
        self.assertEqual(self.load_state()["last_completed_campaign"]["phase"], "superseded")

    def test_non_owner_cannot_update_campaign(self):
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(self.headers("a.headers", "etag-a", self.dmg_a), self.dmg_a)
        self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        result = self.run_cli(
            "campaign-update", "--run-id", "not-owner", "--phase", "building", "--now", "1001", check=False
        )
        self.assertEqual(result.returncode, 5)
        self.assertIn("owned by another run", result.stderr)

    def test_worker_cannot_bypass_guarded_acceptance_and_nix_phases(self):
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(self.headers("a.headers", "etag-a", self.dmg_a), self.dmg_a)
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        run_id = acquired.stdout.split()[1]

        for command in ("campaign-update", "heartbeat"):
            result = self.run_cli(
                command, "--run-id", run_id, "--phase", "awaiting-nix", "--now", "1001", check=False
            )
            self.assertEqual(result.returncode, 5)
            self.assertIn("guarded transition", result.stderr)

        self.assertEqual(self.load_state()["active_campaign"]["campaign_phase"], "drift-validation")

    def test_completed_campaign_can_be_requeued_and_acquired_again(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = self.finish_baseline(headers)
        result = self.run_cli(
            "campaign-requeue", "--sha", sha, "--reason", "feature drift revalidation", "--now", "1100"
        )
        self.assertEqual(result.stdout.strip(), f"CHANGE_READY {sha}")
        state = self.load_state()
        self.assertEqual(state["active_campaign"]["sha256"], sha)
        self.assertEqual(state["active_campaign"]["requeue_reason"], "feature drift revalidation")
        self.assertIsNone(state["last_accepted_sha256"])
        self.assertTrue(state["revalidation_required"])
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1101")
        self.assertEqual(acquired.stdout.split()[0], "ACQUIRED")

    def test_requeue_refuses_to_replace_active_worker(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(headers, self.dmg_a)
        self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        result = self.run_cli("campaign-requeue", "--sha", sha, "--now", "1001", check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout.strip(), "WORKER_ACTIVE")

    def test_requeue_rejects_a_stale_dmg_sha(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha_a = self.finish_baseline(headers)
        sha_b = hashlib.sha256(self.dmg_b.read_bytes()).hexdigest()
        state = self.load_state()
        state["last_observed_sha256"] = sha_b
        (self.state / "downloads" / f"{sha_b}.dmg").write_bytes(self.dmg_b.read_bytes())
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        result = self.run_cli("campaign-requeue", "--sha", sha_a, "--now", "1100", check=False)
        self.assertEqual(result.returncode, 5)
        self.assertIn("only the latest observed DMG", result.stderr)

    def test_nix_repair_acquire_creates_a_new_round(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = self.complete_baseline(headers)
        state = self.load_state()
        state["active_campaign"]["repair_rounds"][-1]["status"] = "merged"
        state["active_campaign"]["acceptance_evidence"] = {"head_sha": "a" * 40}
        state["active_campaign"]["feature_snapshot"] = {"round": 1}
        state["active_campaign"]["head_sha"] = "a" * 40
        state["active_campaign"]["worktree"] = "/old/worktree"
        state["active_campaign"]["campaign_phase"] = "nix-repair"
        state["active_campaign"]["phase"] = "nix-repair"
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1100")
        self.assertEqual(acquired.stdout.split()[0], "ACQUIRED")
        rounds = self.load_state()["active_campaign"]["repair_rounds"]
        self.assertEqual([item["round"] for item in rounds], [1, 2])
        self.assertEqual(rounds[-1]["status"], "active")
        self.assertIsNone(self.load_state()["active_campaign"]["acceptance_evidence"])
        self.assertIsNone(self.load_state()["active_campaign"]["feature_snapshot"])
        self.assertIsNone(self.load_state()["active_campaign"]["head_sha"])
        self.assertIsNone(self.load_state()["active_campaign"]["worktree"])

    def test_nix_repair_after_accepted_main_also_creates_a_new_round(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = self.complete_baseline(headers)
        state = self.load_state()
        state["active_campaign"]["repair_rounds"][-1]["status"] = "accepted-main"
        state["active_campaign"]["campaign_phase"] = "nix-repair"
        state["active_campaign"]["phase"] = "nix-repair"
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")

        self.run_cli("worker-acquire", "--sha", sha, "--now", "1100")

        rounds = self.load_state()["active_campaign"]["repair_rounds"]
        self.assertEqual([item["round"] for item in rounds], [1, 2])

    def test_sync_features_copies_config_and_enabled_local_feature(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(headers, self.dmg_a)
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        run_id = acquired.stdout.split()[1]

        source = self.root / "source"
        source_features = source / "linux-features"
        tracked_feature = source_features / "ui-tweaks"
        tracked_feature.mkdir(parents=True)
        (tracked_feature / "README.md").write_text("tracked\n", encoding="utf-8")
        (tracked_feature / "feature.json").write_text('{"id":"ui-tweaks"}\n', encoding="utf-8")
        local_feature = source_features / "local" / "private-feature"
        local_feature.mkdir(parents=True)
        (local_feature / "README.md").write_text("private\n", encoding="utf-8")
        (local_feature / "feature.json").write_text('{"id":"private-feature"}\n', encoding="utf-8")
        (local_feature / "payload.txt").write_text("payload\n", encoding="utf-8")
        (local_feature / "payload-link").symlink_to("payload.txt")
        config = {
            "enabled": ["ui-tweaks", "private-feature"],
            "settings": {"ui-tweaks": {"example": True}},
        }
        source_features.mkdir(exist_ok=True)
        (source_features / "features.json").write_text(json.dumps(config), encoding="utf-8")

        worktree = self.state / "worktrees" / sha[:12]
        target_features = worktree / "linux-features"
        (target_features / "ui-tweaks").mkdir(parents=True)
        self.run_cli(
            "campaign-update", "--run-id", run_id, "--worktree", str(worktree), "--now", "1001"
        )
        result = self.run_cli(
            "sync-features", "--run-id", run_id, "--source-checkout", str(source), "--now", "1002"
        )
        self.assertEqual(result.stdout.strip(), "FEATURES_SYNCED ui-tweaks,private-feature")
        copied = json.loads((target_features / "features.json").read_text(encoding="utf-8"))
        self.assertEqual(copied, config)
        self.assertEqual(
            (target_features / "local" / "private-feature" / "README.md").read_text(encoding="utf-8"),
            "private\n",
        )
        snapshot = self.load_state()["active_campaign"]["feature_snapshot"]
        self.assertEqual(snapshot["enabled"], ["ui-tweaks", "private-feature"])
        self.assertTrue((target_features / "local" / "private-feature" / "payload-link").is_symlink())
        self.assertIn("private-feature", snapshot["local_feature_tree_hashes"])
        (source_features / "features.json").write_text('{"enabled":[]}\n', encoding="utf-8")
        (local_feature / "payload.txt").write_text("changed\n", encoding="utf-8")
        self.run_cli(
            "sync-features", "--run-id", run_id, "--source-checkout", str(source), "--now", "1003"
        )
        self.assertEqual(json.loads((target_features / "features.json").read_text()), config)
        self.assertEqual((target_features / "local" / "private-feature" / "payload.txt").read_text(), "payload\n")

    def test_sync_features_normalizes_legacy_alias_and_rejects_missing_manifest(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(headers, self.dmg_a)
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        run_id = acquired.stdout.split()[1]
        source = self.root / "source-alias"
        feature = source / "linux-features" / "open-target-discovery"
        feature.mkdir(parents=True)
        (feature / "README.md").write_text("feature\n", encoding="utf-8")
        (feature / "feature.json").write_text('{"id":"open-target-discovery"}\n', encoding="utf-8")
        (source / "linux-features" / "features.json").write_text(
            '{"enabled":["zed-opener"],"settings":{"zed-opener":{"value":1}}}\n', encoding="utf-8"
        )
        worktree = self.state / "worktrees" / sha[:12]
        target = worktree / "linux-features"
        (target / "open-target-discovery").mkdir(parents=True)
        self.run_cli("campaign-update", "--run-id", run_id, "--worktree", str(worktree), "--now", "1001")
        self.run_cli("sync-features", "--run-id", run_id, "--source-checkout", str(source), "--now", "1002")
        copied = json.loads((target / "features.json").read_text())
        self.assertEqual(copied["enabled"], ["open-target-discovery"])
        self.assertEqual(copied["settings"]["open-target-discovery"], {"value": 1})

        self.run_cli("refresh-feature-snapshot", "--run-id", run_id, "--now", "1003")
        missing = source / "linux-features" / "local" / "private-missing"
        missing.mkdir(parents=True)
        (missing / "README.md").write_text("missing\n", encoding="utf-8")
        (source / "linux-features" / "features.json").write_text('{"enabled":["private-missing"]}\n', encoding="utf-8")
        result = self.run_cli(
            "sync-features", "--run-id", run_id, "--source-checkout", str(source), "--now", "1004", check=False
        )
        self.assertEqual(result.returncode, 5)
        self.assertIn("Enabled Linux feature ids not found", result.stderr)

    def test_sync_features_snapshots_a_symlinked_local_feature_directory(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(headers, self.dmg_a)
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        run_id = acquired.stdout.split()[1]

        source = self.root / "source-symlink"
        local_root = source / "linux-features" / "local"
        local_root.mkdir(parents=True)
        external = self.root / "external-private-feature"
        external.mkdir()
        (external / "README.md").write_text("private\n", encoding="utf-8")
        (external / "feature.json").write_text('{"id":"private-feature"}\n', encoding="utf-8")
        (external / "payload.txt").write_text("immutable\n", encoding="utf-8")
        (local_root / "private-feature").symlink_to(external, target_is_directory=True)
        (source / "linux-features" / "features.json").write_text(
            '{"enabled":["private-feature"]}\n', encoding="utf-8"
        )

        worktree = self.state / "worktrees" / sha[:12]
        (worktree / "linux-features").mkdir(parents=True)
        self.run_cli("campaign-update", "--run-id", run_id, "--worktree", str(worktree), "--now", "1001")

        result = self.run_cli(
            "sync-features", "--run-id", run_id, "--source-checkout", str(source), "--now", "1002"
        )

        self.assertEqual(result.stdout.strip(), "FEATURES_SYNCED private-feature")
        copied = worktree / "linux-features" / "local" / "private-feature"
        self.assertTrue(copied.is_dir())
        self.assertFalse(copied.is_symlink())
        self.assertEqual((copied / "payload.txt").read_text(), "immutable\n")

    def test_sync_features_rejects_unmanaged_worktree(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = hashlib.sha256(self.dmg_a.read_bytes()).hexdigest()
        self.probe(headers, self.dmg_a)
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1000")
        run_id = acquired.stdout.split()[1]
        outside = self.root / "outside"
        (outside / "linux-features").mkdir(parents=True)
        self.run_cli(
            "campaign-update", "--run-id", run_id, "--worktree", str(outside), "--now", "1001"
        )
        result = self.run_cli(
            "sync-features", "--run-id", run_id, "--source-checkout", str(self.root),
            "--now", "1002", check=False,
        )
        self.assertEqual(result.returncode, 5)
        self.assertIn("outside the managed worktree root", result.stderr)

    def test_record_acceptance_binds_dmg_features_and_git_head(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha, run_id, _, head, decision = self.prepare_acceptance_fixture(headers)
        result = self.run_cli(
            "record-acceptance", "--run-id", run_id, "--decision", str(decision), "--head", head,
            "--now", "1003",
        )
        self.assertEqual(result.stdout.strip(), f"ACCEPTANCE_RECORDED {head}")
        evidence = self.load_state()["active_campaign"]["acceptance_evidence"]
        self.assertEqual(evidence["dmg_sha256"], sha)
        self.assertEqual(evidence["head_sha"], head)
        self.assertEqual(evidence["enabled_features"], ["ui-tweaks"])
        self.assertEqual(evidence["validation_scope"]["profile"], "unchanged")
        self.assertTrue(Path(evidence["patch_report_path"]).is_file())

    def test_record_acceptance_classifies_feature_only_repair_scope(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        _, run_id, worktree, base, decision = self.prepare_acceptance_fixture(headers)
        (worktree / "linux-features" / "ui-tweaks" / "README.md").write_text("updated ui\n", encoding="utf-8")
        subprocess.run([
            "git", "-C", str(worktree), "add", "linux-features/ui-tweaks/README.md",
        ], check=True)
        subprocess.run(["git", "-C", str(worktree), "commit", "-m", "feature repair"], check=True, stdout=subprocess.DEVNULL)
        head = subprocess.check_output(["git", "-C", str(worktree), "rev-parse", "HEAD"], text=True).strip()
        payload = json.loads(decision.read_text())
        payload["source"]["commit"] = head
        decision.write_text(json.dumps(payload), encoding="utf-8")
        self.run_cli(
            "campaign-update", "--run-id", run_id, "--base-sha", base, "--head-sha", head,
            "--now", "1003",
        )

        recorded = self.run_cli(
            "record-acceptance", "--run-id", run_id, "--decision", str(decision), "--head", head,
            "--now", "1004", check=False,
        )
        self.assertEqual(recorded.returncode, 0, recorded.stderr)

        scope = self.load_state()["active_campaign"]["repair_rounds"][-1]["validation_scope"]
        self.assertEqual(scope["profile"], "feature-only")
        self.assertEqual(scope["feature_ids"], ["ui-tweaks"])
        self.assertEqual(scope["paths"], ["linux-features/ui-tweaks/README.md"])

    def test_unchanged_accepted_main_advances_without_nix_preflight(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha, run_id, _, head, decision = self.prepare_acceptance_fixture(headers)
        self.run_cli(
            "record-acceptance", "--run-id", run_id, "--decision", str(decision), "--head", head,
            "--now", "1003",
        )
        _, env = self.write_scenario({"main_sha": head})

        result = self.run_cli(
            "advance-to-nix", "--run-id", run_id, "--now", "1004", env=env,
        )

        self.assertEqual(result.stdout.strip(), f"AWAITING_NIX {sha}")
        self.assertEqual(self.load_state()["active_campaign"]["campaign_phase"], "awaiting-nix")

    def test_record_acceptance_rejects_head_or_dmg_mismatch_and_new_head_invalidates_evidence(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        _, run_id, _, head, decision = self.prepare_acceptance_fixture(headers)
        wrong_head = self.run_cli(
            "record-acceptance", "--run-id", run_id, "--decision", str(decision), "--head", "b" * 40,
            "--now", "1003", check=False,
        )
        self.assertEqual(wrong_head.returncode, 5)
        self.assertIn("does not match the campaign worktree", wrong_head.stderr)
        self.run_cli(
            "record-acceptance", "--run-id", run_id, "--decision", str(decision), "--head", head,
            "--now", "1004",
        )
        self.run_cli("campaign-update", "--run-id", run_id, "--head-sha", "c" * 40, "--now", "1005")
        self.assertIsNone(self.load_state()["active_campaign"]["acceptance_evidence"])

        payload = json.loads(decision.read_text())
        payload["dmg"]["sha256"] = "d" * 64
        decision.write_text(json.dumps(payload), encoding="utf-8")
        self.run_cli("campaign-update", "--run-id", run_id, "--head-sha", head, "--now", "1006")
        wrong_dmg = self.run_cli(
            "record-acceptance", "--run-id", run_id, "--decision", str(decision), "--head", head,
            "--now", "1007", check=False,
        )
        self.assertEqual(wrong_dmg.returncode, 5)
        self.assertIn("DMG SHA does not match", wrong_dmg.stderr)

    def test_repair_pr_requires_all_six_gates_and_advances_only_after_confirmed_merge(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha, run_id, _, head, decision = self.prepare_acceptance_fixture(headers)
        self.run_cli(
            "record-acceptance", "--run-id", run_id, "--decision", str(decision), "--head", head,
            "--now", "1003",
        )
        state = self.load_state()
        campaign = state["active_campaign"]
        campaign["repair_rounds"][-1]["nix_preflight"] = {"status": "success", "head_sha": head}
        campaign["branch"] = f"codex/upstream-dmg-{sha[:12]}"
        campaign["repair_rounds"][-1]["branch"] = campaign["branch"]
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        pr = {
            "number": 123,
            "url": "https://github.com/example/repo/pull/123",
            "state": "OPEN",
            "headRefName": campaign["branch"],
            "headRefOid": head,
            "baseRefName": "main",
            "isDraft": False,
            "mergeable": "MERGEABLE",
            "body": f"<!-- upstream-dmg-sha256:{sha} -->",
            "statusCheckRollup": self.repair_checks(),
        }
        scenario, env = self.write_scenario({"prs": [pr], "pr_views": [pr]})
        ready = self.run_cli(
            "validate-repair-pr", "--run-id", run_id, "--pr-number", "123",
            "--headers-file", str(headers), "--now", "1004", env=env,
        )
        self.assertEqual(ready.stdout.strip(), f"REPAIR_PR_READY 123 {head}")

        missing = {**pr, "statusCheckRollup": self.checks()}
        scenario.write_text(json.dumps({"prs": [missing], "pr_views": [missing]}), encoding="utf-8")
        waiting = self.run_cli(
            "validate-repair-pr", "--run-id", run_id, "--pr-number", "123",
            "--headers-file", str(headers), "--now", "1005", env=env, check=False,
        )
        self.assertEqual(waiting.returncode, 8)
        self.assertIn("Build App Against Upstream DMG", waiting.stdout)

        merged = {
            **pr,
            "state": "MERGED",
            "mergedAt": "2026-01-01T00:00:00Z",
            "mergeCommit": {"oid": "e" * 40},
        }
        scenario.write_text(json.dumps({"prs": [merged], "pr_views": [merged]}), encoding="utf-8")
        advanced = self.run_cli(
            "advance-to-nix", "--run-id", run_id, "--pr-number", "123", "--now", "1006", env=env,
        )
        self.assertEqual(advanced.stdout.strip(), f"AWAITING_NIX {sha}")
        state = self.load_state()
        self.assertEqual(state["active_campaign"]["campaign_phase"], "awaiting-nix")
        self.assertIsNone(state["worker_lease"])
        self.assertEqual(state["active_campaign"]["repair_rounds"][-1]["merge_sha"], "e" * 40)

    def test_sha256_is_converted_to_nix_sri(self):
        expected = "sha256-" + base64.b64encode(hashlib.sha256(self.dmg_a.read_bytes()).digest()).decode()
        self.assertEqual(self.sri(self.dmg_a), expected)

    def test_current_main_hash_skips_pr_and_workflow_queries(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        scenario, env = self.write_scenario({"main_flake": self.flake(self.sri(self.dmg_a))})
        result = self.nix_probe(headers, env)
        self.assertEqual(result.stdout.strip(), "UNCHANGED")
        calls = self.fake_calls(scenario)
        self.assertEqual([call[0] for call in calls], ["api"])

    def test_new_dmg_does_not_dispatch_nix_before_drift_acceptance(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [],
        })
        result = self.run_cli(
            "probe", "--headers-file", str(headers), "--source-file", str(self.dmg_a), "--now", "1000",
            env=env,
        )
        self.assertTrue(result.stdout.strip().startswith("CHANGE_READY "))
        self.assertFalse(any(call[:2] == ["workflow", "run"] for call in self.fake_calls(scenario)))

    def test_completed_source_failure_returns_same_campaign_to_worker(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = self.complete_baseline(headers)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [{
                "databaseId": 55, "status": "completed", "conclusion": "failure",
                "createdAt": "1970-01-01T00:18:20Z", "headSha": "f" * 40, "url": "https://run/55",
            }],
            "run_views": {"55": {
                "databaseId": 55, "status": "completed", "conclusion": "failure",
                "headSha": "f" * 40, "url": "https://run/55",
                "jobs": [{"steps": [{"name": "Refresh Nix upstream hash", "conclusion": "failure"}]}],
            }},
            "run_logs": {"55": "enabled-feature-drift"},
        })
        result = self.nix_probe(headers, env, now=1100)
        self.assertTrue(result.stdout.strip().startswith(f"NIX_REPAIR_READY {sha} 55 EVENT_ID="))
        state = self.load_state()
        self.assertEqual(state["active_campaign"]["campaign_phase"], "nix-repair")
        self.assertEqual(state["nix_runs"][-1]["classification"], "source")

    def test_network_log_overrides_a_build_step_as_transient(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [{
                "databaseId": 56, "status": "completed", "conclusion": "failure",
                "createdAt": "1970-01-01T00:18:20Z", "headSha": "f" * 40, "url": "https://run/56",
            }],
            "run_views": {"56": {
                "databaseId": 56, "status": "completed", "conclusion": "failure",
                "headSha": "f" * 40, "url": "https://run/56",
                "jobs": [{"steps": [{"name": "Refresh Nix upstream hash", "conclusion": "failure"}]}],
            }},
            "run_logs": {"56": "curl: (6) Could not resolve host: persistent.oaistatic.com"},
        })

        result = self.nix_probe(headers, env, now=1100)

        self.assertEqual(result.stdout.strip(), "NIX_ACTIVE")
        state = self.load_state()
        self.assertEqual(state["nix_runs"][-1]["classification"], "transient")
        self.assertNotEqual(state["active_campaign"]["campaign_phase"], "nix-repair")

    def test_empty_pr_rollup_uses_dispatched_ci_run_and_returns_failure_to_worker(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = self.complete_baseline(headers)
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head, statusCheckRollup=[])
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
            "ci_runs": [{"databaseId": 77, "status": "completed", "conclusion": "failure", "headSha": head}],
            "run_views": {"77": {
                "databaseId": 77, "status": "completed", "conclusion": "failure", "headSha": head,
                "url": "https://run/77", "jobs": [
                    {"name": "Rust and Smoke Tests", "status": "completed", "conclusion": "success"},
                    {"name": "Nix Package Builds", "status": "completed", "conclusion": "failure", "url": "https://run/77"},
                ],
            }},
            "run_logs": {"77": "frameless-titlebar enabled-feature-drift"},
        })
        result = self.nix_probe(headers, env, now=1100)
        self.assertTrue(result.stdout.strip().startswith(f"NIX_REPAIR_READY {sha} 77 EVENT_ID="))
        self.assertEqual(self.load_state()["nix_runs"][-1]["run_id"], 77)

    def test_empty_pr_rollup_with_active_exact_head_ci_stays_pending(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head, statusCheckRollup=[])
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
            "ci_runs": [{
                "databaseId": 76,
                "status": "in_progress",
                "conclusion": None,
                "headSha": head,
                "url": "https://run/76",
            }],
        })

        result = self.nix_probe(headers, env, now=1100)

        self.assertEqual(result.stdout.strip(), "NIX_ACTIVE")
        state = self.load_state()
        self.assertEqual(state["nix_refresh"]["check_status"], "checks-pending")
        self.assertEqual(state["pending_notifications"], [])

    def test_transient_exact_head_ci_failure_retries_without_starting_source_repair(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head, statusCheckRollup=[])
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
            "ci_runs": [{
                "databaseId": 78,
                "status": "completed",
                "conclusion": "cancelled",
                "headSha": head,
                "url": "https://run/78",
            }],
            "run_views": {"78": {
                "databaseId": 78,
                "status": "completed",
                "conclusion": "cancelled",
                "headSha": head,
                "url": "https://run/78",
                "jobs": [{
                    "name": "Nix Package Builds",
                    "status": "completed",
                    "conclusion": "cancelled",
                    "url": "https://run/78",
                }],
            }},
        })

        first = self.nix_probe(headers, env, now=1100)
        second = self.nix_probe(headers, env, now=2001)

        self.assertEqual(first.stdout.strip(), "NIX_ACTIVE")
        self.assertEqual(second.stdout.strip(), "NIX_ACTIVE")
        state = self.load_state()
        self.assertNotEqual(state["active_campaign"]["campaign_phase"], "nix-repair")
        self.assertEqual(state["nix_runs"][-1]["classification"], "transient")
        dispatches = [call for call in self.fake_calls(scenario) if call[:2] == ["workflow", "run"]]
        self.assertEqual(len(dispatches), 1)
        self.assertIn("ci.yml", dispatches[0])

    def test_hash_mismatch_dispatches_once_during_visibility_cooldown(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [],
        })
        self.assertEqual(self.nix_probe(headers, env, now=1100).stdout.strip(), "NIX_ACTIVE")
        self.assertEqual(self.nix_probe(headers, env, now=1200).stdout.strip(), "NIX_ACTIVE")
        calls = self.fake_calls(scenario)
        dispatches = [call for call in calls if call[:2] == ["workflow", "run"]]
        self.assertEqual(len(dispatches), 1)
        self.assertIn("--ref", dispatches[0])
        self.assertIn("expected_main_sha=" + "f" * 40, dispatches[0])
        self.assertIn("expected_dmg_sha256=" + hashlib.sha256(self.dmg_a.read_bytes()).hexdigest(), dispatches[0])

    def test_persisted_dispatch_key_prevents_duplicate_after_cooldown(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [],
        })

        self.nix_probe(headers, env, now=1100)
        self.nix_probe(headers, env, now=4000)

        dispatches = [call for call in self.fake_calls(scenario) if call[:2] == ["workflow", "run"]]
        self.assertEqual(len(dispatches), 1)
        state = self.load_state()
        self.assertEqual(
            state["nix_refresh"]["dispatch_key"],
            "f" * 40 + ":" + hashlib.sha256(self.dmg_a.read_bytes()).hexdigest(),
        )

    def test_active_workflow_is_adopted_without_dispatch(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [{
                "databaseId": 7, "status": "in_progress", "conclusion": None,
                "headSha": "f" * 40, "url": "https://run/7",
            }],
        })
        self.nix_probe(headers, env)
        calls = self.fake_calls(scenario)
        self.assertFalse(any(call[:2] == ["workflow", "run"] for call in calls))
        self.assertEqual(self.load_state()["nix_refresh"]["workflow_run_id"], 7)

    def test_transient_workflow_failure_is_redispatched_after_backoff(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [{
                "databaseId": 8, "status": "completed", "conclusion": "failure",
                "createdAt": "1970-01-01T00:18:20Z", "url": "https://run/8",
            }],
            "run_views": {"8": {
                "databaseId": 8, "status": "completed", "conclusion": "failure",
                "headSha": "f" * 40, "url": "https://run/8",
                "jobs": [{"steps": [{"name": "Install validation dependencies", "conclusion": "failure"}]}],
            }},
        })
        self.nix_probe(headers, env, now=1100)
        self.nix_probe(headers, env, now=2001)
        dispatches = [call for call in self.fake_calls(scenario) if call[:2] == ["workflow", "run"]]
        self.assertEqual(len(dispatches), 1)

    def test_three_transient_failures_stop_and_notify(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [], "runs": [], "run_views": {},
        })
        for run_id, now in ((1, 1100), (2, 2001), (3, 3802)):
            value = json.loads(scenario.read_text())
            value["runs"] = [{
                "databaseId": run_id, "status": "completed", "conclusion": "failure",
                "createdAt": "1970-01-01T00:18:20Z", "headSha": "f" * 40, "url": f"https://run/{run_id}",
            }]
            value["run_views"][str(run_id)] = {
                "databaseId": run_id, "status": "completed", "conclusion": "failure",
                "headSha": "f" * 40, "url": f"https://run/{run_id}",
                "jobs": [{"steps": [{"name": "Install validation dependencies", "conclusion": "failure"}]}],
            }
            scenario.write_text(json.dumps(value), encoding="utf-8")
            result = self.nix_probe(headers, env, now=now)
        self.assertTrue(result.stdout.strip().startswith("NIX_BLOCKED 0 transient-retries-exhausted EVENT_ID="))
        state = self.load_state()
        self.assertEqual(state["nix_refresh"]["transient_failures"], 3)
        self.assertEqual(state["active_campaign"]["campaign_phase"], "nix-blocked")

    def test_green_matching_bot_pr_is_guarded_and_merged(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = self.complete_baseline(headers)
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head)
        merged = {**pr, "state": "MERGED", "mergedAt": "2026-01-01T00:00:00Z", "mergeCommit": {"oid": "b" * 40}}
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
            "pr_views": [pr],
            "merged_pr": merged,
        })
        result = self.nix_probe(headers, env)
        self.assertTrue(result.stdout.strip().startswith(f"NIX_PR_MERGED 99 {pr['url']} EVENT_ID="))
        calls = self.fake_calls(scenario)
        merge = next(call for call in calls if call[:2] == ["pr", "merge"])
        self.assertIn("--admin", merge)
        self.assertEqual(merge[merge.index("--match-head-commit") + 1], head)
        recorded = self.load_state()["last_merged_nix_pr"]
        self.assertEqual(recorded["dmg_sha256"], sha)
        self.assertEqual(recorded["merge_sha"], "b" * 40)

    def test_active_refresh_prevents_merging_an_old_green_bot_head(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
            "runs": [{
                "databaseId": 101,
                "status": "in_progress",
                "conclusion": None,
                "headSha": "f" * 40,
                "url": "https://run/101",
            }],
        })

        result = self.nix_probe(headers, env, now=1100)

        self.assertEqual(result.stdout.strip(), "NIX_ACTIVE")
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.fake_calls(scenario)))
        self.assertEqual(self.load_state()["nix_refresh"]["workflow_run_id"], 101)

    def test_refresh_run_is_adopted_by_campaign_key_when_main_moves(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha = self.complete_baseline(headers)
        accepted_main = "a" * 40
        newer_main = "b" * 40
        state = self.load_state()
        state["nix_refresh"].update({
            "expected_dmg_sha256": sha,
            "expected_dmg_sri": self.sri(self.dmg_a),
            "expected_main_sha": accepted_main,
            "dispatch_key": f"{accepted_main}:{sha}",
            "last_dispatch_at": "1970-01-01T00:18:00Z",
            "workflow_head_sha": accepted_main,
        })
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        scenario, env = self.write_scenario({
            "main_sha": newer_main,
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [{
                "databaseId": 102,
                "status": "in_progress",
                "conclusion": None,
                "headSha": newer_main,
                "displayTitle": f"Nix refresh {accepted_main}:{sha}",
                "url": "https://run/102",
            }],
        })

        result = self.nix_probe(headers, env, now=1100)

        self.assertEqual(result.stdout.strip(), "NIX_ACTIVE")
        self.assertEqual(self.load_state()["nix_refresh"]["workflow_run_id"], 102)
        self.assertFalse(any(call[:2] == ["workflow", "run"] for call in self.fake_calls(scenario)))

    def test_wrong_author_is_blocked_and_never_merged(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head, author={"login": "someone"})
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
        })
        self.nix_probe(headers, env, now=1100)
        self.nix_probe(headers, env, now=1200)
        result = self.nix_probe(headers, env, now=1300)
        self.assertTrue(result.stdout.strip().startswith("NIX_BLOCKED 99 wrong-author EVENT_ID="))
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.fake_calls(scenario)))

    def test_dry_run_nix_source_failure_second_round_and_successful_campaign_completion(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        sha, run_id, _, main_head, decision = self.prepare_acceptance_fixture(headers)
        self.run_cli(
            "record-acceptance", "--run-id", run_id, "--decision", str(decision), "--head", main_head,
            "--now", "1003",
        )
        _, main_env = self.write_scenario({"main_sha": main_head})
        self.run_cli("advance-to-nix", "--run-id", run_id, "--now", "1004", env=main_env)

        failure_scenario, failure_env = self.write_scenario({
            "main_sha": main_head,
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "prs": [],
            "runs": [{
                "databaseId": 501,
                "status": "completed",
                "conclusion": "failure",
                "createdAt": "1970-01-01T00:18:20Z",
                "headSha": main_head,
                "url": "https://run/501",
            }],
            "run_views": {"501": {
                "databaseId": 501,
                "status": "completed",
                "conclusion": "failure",
                "headSha": main_head,
                "url": "https://run/501",
                "jobs": [{"steps": [{"name": "Refresh Nix upstream hash", "conclusion": "failure"}]}],
            }},
            "run_logs": {"501": "enabled-feature-drift"},
        })
        repair_event = self.nix_probe(headers, failure_env, now=1100)
        self.assertTrue(repair_event.stdout.startswith(f"NIX_REPAIR_READY {sha} 501 "))
        acquired = self.run_cli("worker-acquire", "--sha", sha, "--now", "1101")
        self.assertEqual(acquired.stdout.split()[0], "ACQUIRED")

        state = self.load_state()
        campaign = state["active_campaign"]
        self.assertEqual([item["round"] for item in campaign["repair_rounds"]], [1, 2])
        repaired_main = "c" * 40
        campaign["repair_rounds"][-1].update({
            "status": "merged",
            "branch": f"codex/upstream-dmg-{sha[:12]}-nix-repair-2",
            "head_sha": "d" * 40,
            "merge_sha": repaired_main,
        })
        campaign["campaign_phase"] = "awaiting-nix"
        campaign["phase"] = "awaiting-nix"
        campaign["accepted_main_sha"] = repaired_main
        state["worker_lease"] = None
        state["nix_refresh"] = {
            **state["nix_refresh"],
            "expected_dmg_sha256": sha,
            "expected_dmg_sri": self.sri(self.dmg_a),
            "workflow_head_sha": repaired_main,
            "workflow_status": "waiting-for-pr",
        }
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")

        nix_head = "e" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=nix_head)
        merged = {**pr, "state": "MERGED", "mergedAt": "2026-01-01T00:00:00Z", "mergeCommit": {"oid": "f" * 40}}
        success_scenario, success_env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {nix_head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
            "pr_views": [pr],
            "merged_pr": merged,
        })
        completed = self.nix_probe(headers, success_env, now=1200)

        self.assertTrue(completed.stdout.startswith(f"NIX_PR_MERGED 99 {pr['url']} "))
        final = self.load_state()
        self.assertIsNone(final["active_campaign"])
        self.assertEqual(final["last_completed_campaign"]["verdict"], "accepted_with_nix_merged")
        self.assertTrue(any(call[:2] == ["pr", "merge"] for call in self.fake_calls(success_scenario)))

    def test_failed_or_missing_checks_never_merge(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        head = "a" * 40
        checks = self.checks()
        checks[-1]["conclusion"] = "FAILURE"
        pr = self.nix_pr(self.sri(self.dmg_a), head=head, statusCheckRollup=checks)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
        })
        for now in (1100, 1200, 1300):
            result = self.nix_probe(headers, env, now=now)
        self.assertTrue(result.stdout.strip().startswith(f"NIX_REPAIR_READY {self.load_state()['last_observed_sha256']} 99 EVENT_ID="))
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.fake_calls(scenario)))

    def test_force_push_between_checks_prevents_merge(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        first_head = "a" * 40
        second_head = "b" * 40
        listed = self.nix_pr(self.sri(self.dmg_a), head=first_head)
        changed = self.nix_pr(self.sri(self.dmg_a), head=second_head)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {
                first_head: self.flake(self.sri(self.dmg_a)),
                second_head: self.flake(self.sri(self.dmg_a)),
            },
            "prs": [listed],
            "pr_views": [changed],
        })
        result = self.nix_probe(headers, env)
        self.assertEqual(result.stdout.strip(), "NIX_ACTIVE")
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.fake_calls(scenario)))

    def test_upstream_change_before_merge_prevents_merge(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        changed_headers = self.headers("b.headers", "etag-b", self.dmg_b)
        self.complete_baseline(headers)
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
        })
        result = self.nix_probe(headers, env, 1100, "--premerge-headers-file", str(changed_headers))
        self.assertEqual(result.stdout.strip(), "NIX_ACTIVE")
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.fake_calls(scenario)))

    def test_stale_nix_pr_hash_dispatches_refresh_and_does_not_merge(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        head = "a" * 40
        stale_sri = "sha256-" + "A" * 43 + "="
        pr = self.nix_pr(stale_sri, head=head)
        scenario, env = self.write_scenario({
            "main_flake": self.flake(stale_sri),
            "head_flakes": {head: self.flake(stale_sri)},
            "prs": [pr],
            "runs": [],
        })
        self.nix_probe(headers, env)
        calls = self.fake_calls(scenario)
        self.assertTrue(any(call[:2] == ["workflow", "run"] for call in calls))
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in calls))

    def test_unexpected_file_and_missing_required_check_are_blockers(self):
        for label, overrides, reason in (
            ("extra", {"files": [{"path": "flake.nix"}, {"path": "README.md"}]}, "unexpected-files"),
            ("missing", {"statusCheckRollup": self.checks()[:-1]}, "required-checks-missing"),
        ):
            with self.subTest(label=label):
                self.state = self.root / f"state-{label}"
                headers = self.headers(f"{label}.headers", f"etag-{label}", self.dmg_a)
                self.complete_baseline(headers)
                head = "a" * 40
                pr = self.nix_pr(self.sri(self.dmg_a), head=head, **overrides)
                scenario_path = self.root / f"scenario-{label}.json"
                scenario_path.write_text(json.dumps({
                    "main_flake": self.flake("sha256-" + "A" * 43 + "="),
                    "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
                    "prs": [pr],
                }), encoding="utf-8")
                env = {"UPSTREAM_DMG_WATCHDOG_GH": str(self.fake_gh), "FAKE_GH_SCENARIO": str(scenario_path)}
                for now in (1100, 1200, 1300):
                    result = self.nix_probe(headers, env, now=now)
                self.assertTrue(result.stdout.strip().startswith(f"NIX_BLOCKED 99 {reason} EVENT_ID="))
                self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.fake_calls(scenario_path)))

    def test_existing_nix_merge_lease_prevents_second_merge(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        state = self.load_state()
        state["nix_merge_lease"] = {
            "run_id": "other",
            "pr_number": 99,
            "head_sha": "a" * 40,
            "acquired_at": "1970-01-01T00:16:40Z",
            "expires_at": "1970-01-01T00:33:20Z",
        }
        (self.state / "state.json").write_text(json.dumps(state), encoding="utf-8")
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
        })
        result = self.nix_probe(headers, env, now=1100)
        self.assertEqual(result.stdout.strip(), "NIX_ACTIVE")
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.fake_calls(scenario)))

    def test_merge_failure_notifies_once_after_three_attempts(self):
        headers = self.headers("a.headers", "etag-a", self.dmg_a)
        self.complete_baseline(headers)
        head = "a" * 40
        pr = self.nix_pr(self.sri(self.dmg_a), head=head)
        scenario, env = self.write_scenario({
            "main_flake": self.flake("sha256-" + "A" * 43 + "="),
            "head_flakes": {head: self.flake(self.sri(self.dmg_a))},
            "prs": [pr],
            "pr_views": [pr],
            "merge_fails": True,
        })
        for now in (1100, 1200, 1300):
            result = self.nix_probe(headers, env, now=now)
        self.assertTrue(result.stdout.strip().startswith("NIX_BLOCKED 99 merge-failed EVENT_ID="))
        fourth = self.nix_probe(headers, env, now=1400)
        self.assertEqual(fourth.stdout.strip(), result.stdout.strip())
        self.assertEqual(len([call for call in self.fake_calls(scenario) if call[:2] == ["pr", "merge"]]), 4)


if __name__ == "__main__":
    unittest.main()
