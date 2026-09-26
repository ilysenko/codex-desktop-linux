#!/bin/bash
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

fail() { echo "[smoke][ERROR] $*" >&2; exit 1; }
assert_file() { [ -f "$1" ] || fail "missing file: $1"; }
assert_executable() { [ -x "$1" ] || fail "not executable: $1"; }
assert_contains() { rg -q -- "$2" "$1" || fail "$1 does not contain $2"; }
assert_absent() { ! rg -q -- "$2" "$1" || fail "$1 unexpectedly contains $2"; }

assert_executable install.sh
assert_executable scripts/rebuild-candidate.sh
assert_executable scripts/select-latest-package.sh
assert_executable scripts/ci/update-nix-hashes.sh
assert_executable scripts/ci/validate-nix-pins.sh
assert_file assets/openai-codex-linux-repository-key.gpg.base64
assert_file nix/upstream-linux-packages.json

bash -n install.sh launcher/start.sh.template scripts/install-deps.sh \
  scripts/rebuild-candidate.sh scripts/select-latest-package.sh \
  tests/install_deps_pacman_rust_matrix.sh
bash -n scripts/lib/*.sh scripts/build-deb.sh scripts/build-rpm.sh scripts/build-pacman.sh scripts/build-appimage.sh

assert_contains packaging/linux/codex-desktop.desktop '^Name=ChatGPT Community$'
assert_contains packaging/linux/codex-desktop.desktop '^Comment=Community Linux distribution based on OpenAI ChatGPT$'
assert_contains install.sh 'CODEX_APP_DISPLAY_NAME:-ChatGPT Community'
assert_contains install.sh 'cp .*ICON_SOURCE.*CODEX_APP_ID'
assert_contains install.sh 'cp .*ICON_SOURCE.*resources/icon-chatgpt.png'
assert_contains scripts/lib/package-common.sh 'PACKAGE_DISPLAY_NAME:-ChatGPT Community'
assert_contains scripts/build-appimage.sh 'PACKAGE_DISPLAY_NAME:-ChatGPT Community'
assert_contains install.sh 'upstream-linux-package.sh'
assert_contains install.sh 'CODEX_TARGET_ARCH'
assert_contains launcher/start.sh.template '/ChatGPT'
assert_contains launcher/start.sh.template 'refresh_legacy_bundled_plugin_caches'
assert_contains launcher/start.sh.template 'https://gary.goatcounter.com/count'
assert_contains launcher/start.sh.template 'CODEX_LINUX_DISABLE_USAGE_REPORTING'
assert_contains launcher/start.sh.template 'codexLinuxPerUserBrowserSocketDir|codexLinuxIabSocketScope'
assert_contains launcher/start.sh.template '.plugin-appserver'
assert_contains Makefile 'scripts/select-latest-package.sh'
assert_contains Makefile 'build-native-feature-helpers'
assert_contains Makefile 'global-dictation-linux/Cargo.toml --target-dir global-dictation-linux/target'
assert_absent Makefile "compgen -G \"\$\$1\" | sort -V"

# A positional .deb argument equal to the UPSTREAM_DEB environment value must be
# accepted as one input: the Makefile forwards UPSTREAM_DEB both through the
# recipe environment and as the positional $(UPSTREAM_ARG), and install.sh used
# to reject that documented combination as a duplicate input.
smoke_parse_args_fixture() {
    # $1 = UPSTREAM_DEB value, $2 = positional argument, $3 = output path
    {
        echo 'error() { echo "error: $*" >&2; exit 1; }'
        echo "PROVIDED_UPSTREAM_DEB_PATH=\"$1\""
        sed -n '/^parse_args()/,/^}/p' scripts/lib/install-helpers.sh
        printf 'parse_args "%s"\n' "$2"
    } > "$3"
}
smoke_parse_args_accepts_matching_env_positional() {
    local fixture
    fixture="$(mktemp)"
    smoke_parse_args_fixture \
        /tmp/chatgpt_26.915.31945_amd64.deb \
        /tmp/chatgpt_26.915.31945_amd64.deb \
        "$fixture"
    if ! bash "$fixture"; then
        rm -f "$fixture"
        fail "parse_args rejected a positional .deb identical to UPSTREAM_DEB"
    fi
    rm -f "$fixture"
}
smoke_parse_args_rejects_conflicting_paths() {
    local fixture
    fixture="$(mktemp)"
    smoke_parse_args_fixture \
        /tmp/chatgpt_26.915.31945_amd64.deb \
        /tmp/chatgpt_26.915.31029_amd64.deb \
        "$fixture"
    if bash "$fixture" 2>/dev/null; then
        rm -f "$fixture"
        fail "parse_args accepted conflicting upstream .deb paths"
    fi
    rm -f "$fixture"
}
smoke_parse_args_accepts_matching_env_positional
smoke_parse_args_rejects_conflicting_paths
assert_absent launcher/start.sh.template 'local content server'
assert_contains packaging/linux/control 'official Linux runtime'
assert_contains packaging/linux/codex-desktop.spec 'official runtime'
assert_contains flake.nix 'systemd util-linux xdg-utils'
assert_contains packaging/linux/codex-packaged-runtime.sh 'codex-update-manager check-now'
assert_absent packaging/linux/codex-packaged-runtime.sh '--if-stale'
assert_contains scripts/lib/install-helpers.sh 'sudo apt install nodejs npm curl dpkg-dev gnupg'
# Anchored guards: assert executable code lines, not comment prose, so a
# removed guard actually fails the smoke run even when the explanatory
# comment keeps the words. (rg patterns: avoid unescaped regex metachars.)
assert_contains scripts/lib/asar-patch.sh '^        command -v npx >/dev/null 2>&1 \|\| error'
assert_contains scripts/lib/install-helpers.sh '^    if \[ -z "\$\{CODEX_ASAR_BIN:-\}" \] && ! command -v npx &>/dev/null; then$'
assert_contains scripts/lib/asar-patch.sh 'list --is-pack "\$app_asar" > "\$WORK_DIR/app.asar.upstream-layout"'
assert_contains scripts/lib/asar-patch.sh 'scripts/patches/lib/asar-layout.js'
assert_contains scripts/lib/asar-patch.sh 'scripts/patches/lib/asar-layout.js" verify'
assert_absent scripts/lib/asar-patch.sh 'cmp -s "\$WORK_DIR/app.asar.upstream-layout" "\$WORK_DIR/app.asar.output-layout"'
assert_absent scripts/lib/asar-patch.sh "find . -type f -printf '%P\\n' | LC_ALL=C sort"

selector_fixture="$(mktemp -d)"
trap 'rm -rf -- "$selector_fixture"' EXIT
touch -t 202608120900 "$selector_fixture/codex-desktop_2026.08.12.community_amd64.deb"
touch -t 202608121000 "$selector_fixture/codex-desktop_2026.08.12.100000_amd64.deb"
selected_package="$(scripts/select-latest-package.sh "$selector_fixture/codex-desktop_*.deb")"
[ "$selected_package" = "$selector_fixture/codex-desktop_2026.08.12.100000_amd64.deb" ] ||
    fail "package selector did not choose the newest artifact: $selected_package"

SCRIPT_DIR="$REPO_DIR"
. scripts/lib/asar-patch.sh
asar_report="$selector_fixture/patch-report.json"
node - "$asar_report" <<'NODE'
const fs = require("node:fs");
const reportPath = process.argv[2];
fs.writeFileSync(reportPath, `${JSON.stringify({
  patches: [{ status: "skipped-optional" }],
}, null, 2)}\n`);
NODE
if patch_report_has_changes "$asar_report"; then
    fail "skipped optional ASAR descriptors must preserve the official archive"
fi
node - "$asar_report" <<'NODE'
const fs = require("node:fs");
const reportPath = process.argv[2];
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
report.patches[0].status = "applied";
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
NODE
patch_report_has_changes "$asar_report" || fail "applied ASAR descriptors must be packed"
record_patch_report_asar_hashes "$asar_report" upstream-sha output-sha true
node - "$asar_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!report.upstreamAppAsar.preservedByteForByte) throw new Error("missing byte-preserved report state");
if (report.upstreamAppAsar.sha256 !== "upstream-sha") throw new Error("bad upstream hash");
if (report.outputAppAsar.sha256 !== "output-sha") throw new Error("bad output hash");
NODE

node - <<'NODE'
const { corePatchDescriptors } = require("./scripts/patches/runner.js");
const descriptors = corePatchDescriptors();
if (descriptors.length !== 1 ||
    descriptors[0].id !== "quit-confirmation-focus" ||
    descriptors[0].ciPolicy !== "required-upstream" ||
    descriptors[0].phase !== "extracted-app:pre-webview") {
  throw new Error(`Unexpected default core patch registry: ${descriptors.map(({ id }) => id).join(", ")}`);
}
NODE

node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = "linux-features";
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "local") continue;
  const feature = path.join(root, entry.name, "feature.json");
  if (!fs.existsSync(feature)) continue;
  const manifest = JSON.parse(fs.readFileSync(feature, "utf8"));
  if (!fs.existsSync(path.join(root, entry.name, "README.md"))) {
    throw new Error(`${manifest.id} has no README`);
  }
}
const pins = JSON.parse(fs.readFileSync("nix/upstream-linux-packages.json", "utf8"));
for (const architecture of ["amd64", "arm64"]) {
  if (!pins[architecture].repositoryPath.endsWith(`_${architecture}.deb`)) {
    throw new Error(`bad ${architecture} pin`);
  }
}
NODE

node --test launcher/start.test.js tests/deb-prerm.test.js scripts/lib/upstream-linux-package.test.js \
  scripts/automation/upstream-linux-package-watchdog/test.js \
  scripts/patch-linux-window-ui.test.js scripts/patches/runner.test.js \
  scripts/patches/lib/asar-layout.test.js \
  scripts/patches/core/*/test.js \
  scripts/lib/linux-features.test.js

echo "[smoke] official Linux-package source, launcher, feature registry, packages, and pins are coherent"
