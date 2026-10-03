#!/usr/bin/env python3
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("feature-picker.py")
REPO_ROOT = MODULE_PATH.parent.parent
SPEC = importlib.util.spec_from_file_location("feature_picker", MODULE_PATH)
feature_picker = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
import sys
sys.modules[SPEC.name] = feature_picker
SPEC.loader.exec_module(feature_picker)


class FeaturePickerModelTests(unittest.TestCase):
    def feature(self, feature_id, *, requires=(), conflicts=()):
        return feature_picker.Feature(
            id=feature_id,
            title=feature_id.upper(),
            description="",
            requires=tuple(requires),
            conflicts=tuple(conflicts),
        )

    def test_last_selection_wins_and_blocks_conflict(self):
        features = {
            "isolation": self.feature("isolation", conflicts=("socket",)),
            "socket": self.feature("socket"),
        }
        model = feature_picker.SelectionModel(features, ["socket"])
        changes = model.enable("isolation")

        self.assertEqual(model.ordered_selected(), ["isolation"])
        self.assertEqual(changes["disabled"], ["socket"])
        self.assertEqual(model.blocked_by("socket"), ["isolation"])

    def test_dependency_is_automatic_and_locked(self):
        features = {
            "base": self.feature("base"),
            "consumer": self.feature("consumer", requires=("base",)),
        }
        model = feature_picker.SelectionModel(features)
        changes = model.enable("consumer")

        self.assertEqual(model.ordered_selected(), ["base", "consumer"])
        self.assertEqual(changes["required"], ["base"])
        self.assertEqual(model.required_by("base"), ["consumer"])
        self.assertNotIn("base", model.requested)

    def test_disabling_dependency_disables_dependents(self):
        features = {
            "base": self.feature("base"),
            "consumer": self.feature("consumer", requires=("base",)),
        }
        model = feature_picker.SelectionModel(features, ["consumer"])
        changes = model.disable("base")

        self.assertEqual(model.ordered_selected(), [])
        self.assertEqual(changes["disabled"], ["consumer"])

    def test_conflict_with_dependency_disables_requesting_root(self):
        features = {
            "base": self.feature("base"),
            "consumer": self.feature("consumer", requires=("base",)),
            "exclusive": self.feature("exclusive", conflicts=("base",)),
        }
        model = feature_picker.SelectionModel(features, ["consumer"])
        changes = model.enable("exclusive")

        self.assertEqual(model.ordered_selected(), ["exclusive"])
        self.assertEqual(changes["disabled"], ["consumer"])

    def test_conflicts_are_symmetric_for_ui(self):
        features = {
            "a": self.feature("a", conflicts=("b",)),
            "b": self.feature("b"),
        }
        model = feature_picker.SelectionModel(features, ["a"])
        self.assertEqual(model.blocked_by("b"), ["a"])

    def test_dependency_conflict_blocks_feature_row(self):
        features = {
            "a": self.feature("a", conflicts=("base",)),
            "base": self.feature("base"),
            "consumer": self.feature("consumer", requires=("base",)),
        }
        model = feature_picker.SelectionModel(features, ["a"])
        self.assertEqual(model.blocked_by("consumer"), ["a"])

    def test_feature_display_order_is_case_insensitive_by_title_then_id(self):
        features = {
            "z-id": feature_picker.Feature(
                id="z-id",
                title="alpha",
                description="",
                requires=(),
                conflicts=(),
            ),
            "a-id": feature_picker.Feature(
                id="a-id",
                title="Alpha",
                description="",
                requires=(),
                conflicts=(),
            ),
            "beta": feature_picker.Feature(
                id="beta",
                title="Beta",
                description="",
                requires=(),
                conflicts=(),
            ),
        }
        model = feature_picker.SelectionModel(features)
        self.assertEqual(
            feature_picker.sorted_feature_ids(model),
            ["a-id", "z-id", "beta"],
        )

    def test_feature_search_matches_title_id_description_and_multiple_terms(self):
        feature = feature_picker.Feature(
            id="community-profile-isolation",
            title="Community Profile Isolation",
            description="Separate Electron and Codex state",
            requires=(),
            conflicts=(),
        )
        self.assertTrue(feature_picker.feature_matches_query(feature, "profile"))
        self.assertTrue(feature_picker.feature_matches_query(feature, "COMMUNITY isolation"))
        self.assertTrue(feature_picker.feature_matches_query(feature, "electron state"))
        self.assertTrue(
            feature_picker.feature_matches_query(feature, "community-profile-isolation")
        )
        self.assertFalse(feature_picker.feature_matches_query(feature, "shared socket"))

    def test_feature_config_writer_preserves_unrelated_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            config = pathlib.Path(temp) / "features.json"
            config.write_text(json.dumps({
                "enabled": ["old"],
                "settings": {
                    "ui-tweaks": {"keep": True},
                    "community-profile-isolation": {"codexHome": "~/.old"},
                },
                "installer": {
                    "packageName": "legacy-custom-name",
                    "withUpdater": True,
                    "installDependencies": False,
                },
            }))
            feature_picker.write_feature_config(
                config,
                ["community-profile-isolation"],
                {
                    "withUpdater": False,
                    "installDependencies": True,
                },
            )
            data = json.loads(config.read_text())
            self.assertEqual(data["enabled"], ["community-profile-isolation"])
            self.assertEqual(data["settings"]["ui-tweaks"], {"keep": True})
            self.assertEqual(
                data["settings"]["community-profile-isolation"],
                {"codexHome": "~/.old"},
            )
            self.assertEqual(
                data["installer"],
                {"withUpdater": False, "installDependencies": True},
            )

    def test_install_plan_keeps_fixed_package_identity_with_updater(self):
        stages = feature_picker.build_install_stages({
            "withUpdater": True,
            "installDependencies": False,
            "packageFormat": "deb",
        })
        self.assertEqual(
            stages[-1][1],
            ["make", "deb", "PACKAGE_WITH_UPDATER=1"],
        )

    def test_install_plan_keeps_fixed_package_identity_without_updater(self):
        stages = feature_picker.build_install_stages({
            "withUpdater": False,
            "installDependencies": True,
            "packageFormat": "pacman",
        })
        self.assertEqual(stages[0][1], ["bash", "scripts/install-deps.sh"])
        self.assertEqual(
            stages[-1][1],
            ["make", "pacman", "PACKAGE_WITH_UPDATER=0"],
        )
        self.assertEqual(feature_picker.PACKAGE_NAME, "codex-desktop")
        self.assertEqual(feature_picker.INSTALL_ROOT, "/opt/codex-desktop")

    def test_latest_package_ignores_noncanonical_package_names(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            dist = root / "dist"
            dist.mkdir()
            canonical = dist / "codex-desktop_2026.10.02_amd64.deb"
            custom = dist / "codex-team_2026.10.02_amd64.deb"
            canonical.write_bytes(b"canonical")
            custom.write_bytes(b"custom")

            self.assertEqual(
                feature_picker.latest_package(root, "deb"),
                canonical,
            )

    def test_package_format_uses_repository_detector(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            helper = root / "scripts" / "lib" / "detect-package-format.sh"
            helper.parent.mkdir(parents=True)
            helper.write_text('#!/bin/sh\nprintf "%s\\n" rpm\n')
            helper.chmod(0o755)
            self.assertEqual(feature_picker.detect_package_format(root), "rpm")

            helper.write_text('#!/bin/sh\nprintf "%s\\n" unknown\n')
            helper.chmod(0o755)
            with self.assertRaises(feature_picker.SelectionError):
                feature_picker.detect_package_format(root)

    def test_make_package_matches_shared_detector_on_mixed_toolchains(self):
        cases = [
            ("artix", "arch", "pacman"),
            ("sles", "suse opensuse", "rpm"),
            ("ubuntu", "debian", "deb"),
        ]
        detector = REPO_ROOT / "scripts" / "lib" / "detect-package-format.sh"

        with tempfile.TemporaryDirectory() as temp:
            temp_root = pathlib.Path(temp)
            fake_make = temp_root / "capture-make"
            capture = temp_root / "capture.txt"
            fake_bin = temp_root / "bin"
            fake_bin.mkdir()
            fake_dpkg = fake_bin / "dpkg-deb"
            fake_dpkg.write_text("#!/bin/sh\nexit 0\n")
            fake_dpkg.chmod(0o755)
            fake_make.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$@" > "$PACKAGE_FORMAT_CAPTURE"\n'
            )
            fake_make.chmod(0o755)

            for distro_id, id_like, expected in cases:
                with self.subTest(distro=distro_id):
                    release = temp_root / f"os-release-{distro_id}"
                    release.write_text(
                        f'ID={distro_id}\nID_LIKE="{id_like}"\nVERSION_ID=1\n'
                    )
                    env = os.environ.copy()
                    env["OS_RELEASE_FILE"] = str(release)
                    env["PATH"] = f"{fake_bin}:{env.get('PATH', '')}"
                    env["PACKAGE_FORMAT_CAPTURE"] = str(capture)

                    detected = subprocess.run(
                        [str(detector)],
                        cwd=REPO_ROOT,
                        env=env,
                        capture_output=True,
                        text=True,
                        check=True,
                    ).stdout.strip()
                    self.assertEqual(detected, expected)

                    capture.unlink(missing_ok=True)
                    subprocess.run(
                        [
                            "make",
                            "--no-print-directory",
                            f"MAKE={fake_make}",
                            "package",
                        ],
                        cwd=REPO_ROOT,
                        env=env,
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    recursive_args = capture.read_text().splitlines()
                    self.assertIn(expected, recursive_args)
                    self.assertNotIn(
                        {"pacman": "deb", "rpm": "deb", "deb": "rpm"}[expected],
                        recursive_args,
                    )

    def test_impossible_dependency_conflict_is_rejected(self):
        features = {
            "a": self.feature("a", requires=("b",), conflicts=("b",)),
            "b": self.feature("b"),
        }
        with self.assertRaises(feature_picker.SelectionError):
            feature_picker.SelectionModel(features)

    def test_manifest_discovery_rejects_invalid_public_contracts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            directory = root / "bad"
            directory.mkdir()
            (directory / "README.md").write_text("# bad\n")
            manifest = directory / "feature.json"

            manifest.write_text(json.dumps({
                "id": "bad",
                "title": "Bad",
                "description": "",
                "defaultEnabled": True,
            }))
            with self.assertRaises(feature_picker.SelectionError):
                feature_picker.discover_features(root)

            manifest.write_text(json.dumps({
                "id": "bad",
                "title": "Bad",
                "description": "",
                "defaultEnabled": False,
                "internal": "yes",
            }))
            with self.assertRaises(feature_picker.SelectionError):
                feature_picker.discover_features(root)

    def test_current_config_ignores_retired_aliases_and_rejects_unknown_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            feature_dir = root / "live-feature"
            feature_dir.mkdir()
            (feature_dir / "README.md").write_text("# live\n")
            (feature_dir / "feature.json").write_text(json.dumps({
                "id": "live-feature",
                "title": "Live Feature",
                "description": "",
                "defaultEnabled": False,
            }))
            (root / "compatibility.json").write_text(json.dumps({
                "aliases": {"legacy-alias": "retired-feature"},
                "retired": ["retired-feature"],
            }))

            features = feature_picker.discover_features(root)
            config = root / "features.json"
            config.write_text(json.dumps({
                "enabled": ["legacy-alias", "live-feature"],
            }))
            self.assertEqual(
                feature_picker.read_current_selection(
                    config,
                    features,
                    features_root=root,
                ),
                ["live-feature"],
            )

            config.write_text(json.dumps({
                "enabled": ["live-feature", "typo-feature"],
            }))
            with self.assertRaises(feature_picker.SelectionError):
                feature_picker.read_current_selection(
                    config,
                    features,
                    features_root=root,
                )

    def test_manifest_discovery_and_current_config(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            for feature_id in ("a", "b"):
                directory = root / feature_id
                directory.mkdir()
                (directory / "README.md").write_text("# feature\n")
                manifest = {
                    "id": feature_id,
                    "title": feature_id.upper(),
                    "description": f"{feature_id} description",
                    "defaultEnabled": False,
                }
                if feature_id == "a":
                    manifest["conflicts"] = ["b"]
                (directory / "feature.json").write_text(json.dumps(manifest))

            config = root / "features.json"
            config.write_text(json.dumps({"enabled": ["b"]}))

            features = feature_picker.discover_features(root)
            current = feature_picker.read_current_selection(config, features)

            self.assertEqual(list(features), ["a", "b"])
            self.assertEqual(current, ["b"])


if __name__ == "__main__":
    unittest.main()
