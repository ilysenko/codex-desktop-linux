import hashlib
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runtime", pathlib.Path(__file__).with_name("fetch-runtime.py"))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def test_download_rejects_wrong_hash_or_length(self):
        with patch.object(runtime, "fetch", return_value=b"payload"):
            sha = hashlib.sha256(b"payload").hexdigest()
            self.assertEqual(runtime.checked_bytes("https://example.test/file", sha, 7), b"payload")
            for digest, size in [("0" * 64, 7), (sha, 8)]:
                with self.assertRaises(ValueError):
                    runtime.checked_bytes("https://example.test/file", digest, size)

    def test_repository_path_rejects_escape_and_urls(self):
        for value in ["/etc/passwd", "pool/../../etc/passwd", "https://other.test/file", "pool/file?x=1"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime.safe_repository_path(value)
        self.assertEqual(runtime.safe_repository_path("pool/a/liba_1.2+deb13u1_amd64.deb"), "pool/a/liba_1.2+deb13u1_amd64.deb")

    def test_deb822_continuation_and_checksums(self):
        parsed = list(runtime.paragraphs("Package: a\nDepends: b,\n c\nSHA256:\n abc 4 file\n\nPackage: b\n"))
        self.assertEqual(parsed[0]["Depends"], "b,\nc")
        self.assertEqual(parsed[0]["SHA256"].strip(), "abc 4 file")
        self.assertEqual(parsed[1]["Package"], "b")

    def test_closure_resolves_alternatives_cycles_and_virtual_providers(self):
        packages = {
            "app": {"Depends": "missing | liba, virtual"},
            "liba": {"Pre-Depends": "app"},
            "provider": {"Provides": "virtual"},
        }
        self.assertEqual(set(runtime.dependency_closure(packages, ["app"])), set(packages))

    def test_missing_or_unsupported_dependency_fails(self):
        for depends in ["not-present", "liba [amd64]"]:
            with self.subTest(depends=depends), self.assertRaises(ValueError):
                runtime.dependency_closure({"app": {"Depends": depends}}, ["app"])

    def test_version_predicate_cannot_select_unsuitable_package(self):
        packages = {"app": {"Depends": "liba (>= 2) | libb"}, "liba": {"Version": "1"}, "libb": {}}
        with patch.object(runtime.subprocess, "run") as run:
            run.return_value.returncode = 1
            self.assertEqual(set(runtime.dependency_closure(packages, ["app"])), {"app", "libb"})
            self.assertEqual(run.call_args.args[0], ["dpkg", "--compare-versions", "1", ">=", "2"])

    def test_wrong_signing_key_is_rejected_before_import(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runtime, "fetch", return_value=b"key"), patch.object(runtime, "run", return_value=b"fpr:::::::::WRONG:\n"):
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                runtime.keyring(pathlib.Path(directory))
            self.assertFalse((pathlib.Path(directory) / "debian-archive.gpg").exists())

    def test_invalid_signature_stops_index_download(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runtime, "fetch", return_value=b"bad-signature") as fetch, patch.object(runtime, "run", side_effect=RuntimeError("bad signature")):
            with self.assertRaisesRegex(RuntimeError, "bad signature"):
                runtime.package_index("https://example.test", "trixie", "amd64", pathlib.Path(directory), pathlib.Path(directory) / "key.gpg")
            self.assertEqual(fetch.call_count, 1)


if __name__ == "__main__":
    unittest.main()
