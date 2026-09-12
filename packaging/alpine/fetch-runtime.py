#!/usr/bin/env python3
"""Extract a verified Debian library closure for a direct Alpine host launch.

No package scripts are run, and no chroot/container is created. This is an
experimental library provider for packaging/alpine/build.cjs, not an OS install.
"""

import argparse
import concurrent.futures
import datetime
import email.utils
import hashlib
import json
import lzma
import pathlib
import re
import subprocess
import urllib.request


KEYS = {
    "archive-key-12": "B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8",
    "archive-key-12-security": "05AB90340C0C5E797F44A8C8254CF3B5AEC0A8F0",
    "archive-key-13": "04B54C3CDCA79751B16BC6B5225629DF75B188BD",
    "archive-key-13-security": "5E04A1E3223A19A20706E20F9904613D4CCE68C6",
    "release-13": "41587F7DB8C774BCCF131416762F67A0B2C39DE4",
}
SOURCES = [
    ("https://deb.debian.org/debian", "trixie"),
    ("https://deb.debian.org/debian", "trixie-updates"),
    ("https://deb.debian.org/debian-security", "trixie-security"),
]
ROOT_PACKAGES = """
libc6 libgtk-3-0t64 libnotify4 libnss3 libatspi2.0-0t64 libdrm2 libgbm1
libxcb-dri3-0 libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcairo2
libcups2t64 libdbus-1-3 libexpat1 libgcc-s1 libgdk-pixbuf-2.0-0 libgl1
libglib2.0-0t64 libnspr4 libpango-1.0-0 libstdc++6 libudev1 libusb-1.0-0
libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3
libxkbcommon0 libxrandr2 libwayland-client0 libwayland-cursor0 libwayland-egl1
libsecret-1-0 libssl3t64 libpipewire-0.3-0t64 libxss1 libxtst6 libxcursor1
libxi6 libzstd1 liblzma5 zlib1g libfontconfig1 libcurl3t64-gnutls
mesa-libgallium mesa-vulkan-drivers libgl1-mesa-dri libasound2-plugins
""".split()


def run(*args, **kwargs):
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def fetch(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        if not response.url.startswith("https://"):
            raise ValueError("download redirected outside HTTPS")
        return response.read()


def checked_bytes(url, sha256, size):
    data = fetch(url)
    if len(data) != int(size) or hashlib.sha256(data).hexdigest() != sha256:
        raise ValueError(f"size/SHA256 mismatch: {url}")
    return data


def paragraphs(text):
    for paragraph in text.split("\n\n"):
        fields = {}
        key = None
        for line in paragraph.splitlines():
            if line.startswith(" ") and key:
                fields[key] += "\n" + line[1:]
            elif ": " in line:
                key, value = line.split(": ", 1)
                fields[key] = value
            elif line.endswith(":"):
                key = line[:-1]
                fields[key] = ""
        if fields:
            yield fields


def safe_repository_path(value):
    if not value or value.startswith("/") or ".." in value.split("/"):
        raise ValueError(f"unsafe repository path: {value}")
    if not re.fullmatch(r"[A-Za-z0-9_+./~%-]+", value):
        raise ValueError(f"invalid repository path: {value}")
    return value


def keyring(cache):
    binary_keys = []
    for name, expected in KEYS.items():
        data = fetch(f"https://ftp-master.debian.org/keys/{name}.asc")
        info = run("gpg", "--batch", "--with-colons", "--show-keys", input=data).decode()
        actual = next(line.split(":")[9] for line in info.splitlines() if line.startswith("fpr:"))
        if actual != expected:
            raise ValueError(f"unexpected Debian key fingerprint: {actual}")
        binary_keys.append(run("gpg", "--batch", "--dearmor", input=data))
    result = cache / "debian-archive.gpg"
    result.write_bytes(b"".join(binary_keys))
    return result


def package_index(base, suite, arch, cache, keys):
    release_path = cache / f"{suite}.InRelease"
    release_path.write_bytes(fetch(f"{base}/dists/{suite}/InRelease"))
    release = run("gpgv", "--keyring", str(keys), "--output", "-", str(release_path)).decode()
    fields = next(paragraphs(release))
    now = datetime.datetime.now(datetime.timezone.utc)
    if email.utils.parsedate_to_datetime(fields["Date"]) > now + datetime.timedelta(days=1):
        raise ValueError(f"future repository metadata: {suite}")
    if "Valid-Until" in fields and email.utils.parsedate_to_datetime(fields["Valid-Until"]) < now:
        raise ValueError(f"expired repository metadata: {suite}")
    target = f"main/binary-{arch}/Packages.xz"
    entries = [line.split() for line in fields["SHA256"].splitlines() if line.strip()]
    sha, size, _ = next(entry for entry in entries if entry[2] == target)
    data = checked_bytes(f"{base}/dists/{suite}/{target}", sha, size)
    packages = list(paragraphs(lzma.decompress(data).decode()))
    for package in packages:
        package["Repository"] = base
    return packages


def newer(left, right):
    return subprocess.run(["dpkg", "--compare-versions", left, "gt", right], check=False).returncode == 0


def dependency_closure(packages, roots):
    # Every provider choice comes from the same verified Debian architecture.
    # Version predicates are checked by dpkg; unsupported syntax fails closed.
    providers = {}
    for name, package in packages.items():
        for item in package.get("Provides", "").split(","):
            if item.strip():
                providers.setdefault(item.strip().split()[0], []).append(name)
    selected = {}

    def resolve(group):
        for alternative in group.split("|"):
            match = re.fullmatch(r"\s*([a-z0-9][a-z0-9+.-]*)(?::(?:any|native))?\s*(?:\((<<|<=|=|>=|>>)\s*([^ )]+)\))?\s*", alternative)
            if not match:
                raise ValueError(f"unsupported dependency: {alternative}")
            name, op, version = match.groups()
            if name in packages:
                if op and subprocess.run(["dpkg", "--compare-versions", packages[name]["Version"], op, version], check=False).returncode:
                    continue
                return name
            if not op and name in providers:
                return sorted(providers[name])[0]
        raise ValueError(f"unresolved dependency: {group}")

    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        package = packages[name]
        selected[name] = package
        for field in ("Pre-Depends", "Depends"):
            for group in package.get(field, "").split(","):
                if group.strip():
                    pending.append(resolve(group))
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--cache", type=pathlib.Path)
    parser.add_argument("--arch", choices=["amd64"], default="amd64")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    cache = args.cache.resolve() if args.cache else output / "packages"
    cache.mkdir(parents=True, exist_ok=True)
    keys = keyring(cache)
    packages = {}
    for base, suite in SOURCES:
        print(f"Verifying {suite}/{args.arch}", flush=True)
        for package in package_index(base, suite, args.arch, cache, keys):
            name = package["Package"]
            if name not in packages or newer(package["Version"], packages[name]["Version"]):
                packages[name] = package
    selected = dependency_closure(packages, ROOT_PACKAGES)
    print(f"Downloading {len(selected)} verified packages", flush=True)

    def download(item):
        name, package = item
        filename = safe_repository_path(package["Filename"])
        target = cache / pathlib.PurePosixPath(filename).name
        if not target.is_file() or target.stat().st_size != int(package["Size"]) or hashlib.sha256(target.read_bytes()).hexdigest() != package["SHA256"]:
            target.write_bytes(checked_bytes(package["Repository"] + "/" + filename, package["SHA256"], package["Size"]))
        return name, package, target

    library_root = output / "root"
    library_root.mkdir()
    manifest = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for name, package, target in executor.map(download, sorted(selected.items())):
            # dpkg-deb only extracts data; postinst and triggers are never run.
            run("dpkg-deb", "--extract", str(target), str(library_root))
            manifest.append({key: package[key] for key in ("Package", "Version", "Architecture", "SHA256", "Filename", "Repository")})
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Library root: {library_root}", flush=True)


if __name__ == "__main__":
    main()
