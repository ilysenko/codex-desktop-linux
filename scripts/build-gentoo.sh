#!/bin/bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/lib/package-common.sh"
APP_DIR="${APP_DIR_OVERRIDE:-$REPO_DIR/codex-app}"
DIST_DIR="${DIST_DIR_OVERRIDE:-$REPO_DIR/dist}"
PACKAGE_NAME=codex-desktop
PACKAGE_WITH_UPDATER="${PACKAGE_WITH_UPDATER:-0}"
ICON_SOURCE="$(resolve_package_icon_source)"
DESKTOP_TEMPLATE="$REPO_DIR/packaging/linux/codex-desktop.desktop"

check_updater_mode() {
    if package_with_updater_enabled; then
        error 'Gentoo requires PACKAGE_WITH_UPDATER=0; Portage owns native updates'
    fi
}
if [ "${1:-}" = --preflight-bootstrap ]; then
    # Bootstrap must not depend on Node, which install-deps installs next.
    check_updater_mode
    exit 0
fi
preflight() {
    check_updater_mode
    node "$SCRIPT_DIR/lib/gentoo-feature-support.js" --preflight >/dev/null
}
preflight
[ "${1:-}" != --preflight ] || exit 0
ensure_app_layout
feature_plan="$(node "$SCRIPT_DIR/lib/gentoo-feature-support.js" "$APP_DIR")"
printf '%s\n' "$feature_plan" | python3 "$SCRIPT_DIR/lib/validate-gentoo-dependencies.py"
arch="$(official_payload_deb_architecture)"
case "$(uname -m):$arch" in
    x86_64:amd64|aarch64:arm64|arm64:arm64) ;;
    *) error 'Gentoo payload/host architecture mismatch' ;;
esac

export TMPDIR="${TMPDIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop-dev/tmp}"
mkdir -p "$TMPDIR"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
# Local deb arguments bypass signed discovery in install.sh. Revalidate the
# build provenance against the pinned signed index before producing an ebuild.
node "$SCRIPT_DIR/lib/upstream-linux-package.js" --metadata-only \
    --output-dir "$scratch/signed" --metadata "$scratch/signed.json" \
    --key-base64 "$REPO_DIR/assets/openai-codex-linux-repository-key.gpg.base64" \
    --arch "$arch" --repository "${CODEX_UPSTREAM_LINUX_REPOSITORY:-https://persistent.oaistatic.com/codex-app-prod/linux/deb}"
version="$(node - "$APP_DIR/.codex-linux/build-info.json" "$scratch/signed.json" <<'NODE'
const fs = require('fs');
const b = JSON.parse(fs.readFileSync(process.argv[2])).upstreamLinuxPackage;
const m = JSON.parse(fs.readFileSync(process.argv[3]));
if (b.version !== m.version || b.architecture !== m.architecture || b.sha256 !== m.sha256 || b.sizeBytes !== m.size) {
  throw new Error('Built payload does not match the latest signed stable package');
}
if (!/^\d+(?:\.\d+)*$/.test(m.version)) throw new Error('Unsupported Gentoo version');
process.stdout.write(m.version);
NODE
)"
staging="$scratch/staging"
PACKAGE_VERSION="$version"
stage_common_package_files "$staging"
write_launcher_stub "$staging"
mkdir -p "$staging/usr/share/doc/codex-desktop-$version"
cp "$REPO_DIR/LICENSE" "$staging/usr/share/doc/codex-desktop-$version/LICENSE.wrapper"
stage_linux_feature_package_resources "$staging" ebuild
run_linux_feature_package_hooks "$staging" ebuild
normalize_package_payload_permissions "$staging"
node "$SCRIPT_DIR/lib/gentoo-feature-support.js" --restore-permissions "$staging/opt/$PACKAGE_NAME"
restore_linux_feature_package_resource_permissions "$staging" ebuild
# Hooks are user-space staging operations, never Portage/root lifecycle code.
# Reject roots that src_install would otherwise silently omit.
for staged_root in "$staging"/* "$staging"/.[!.]* "$staging"/..?*; do
    [ -e "$staged_root" ] || [ -L "$staged_root" ] || continue
    case "$(basename "$staged_root")" in
        opt|usr|etc) ;;
        *) error "Unsupported Gentoo package staging root: $staged_root" ;;
    esac
done

repository="$scratch/repository"
package="$repository/app-misc/codex-desktop"
mkdir -p "$package" "$repository/profiles" "$repository/metadata"
printf 'codex-desktop-local\n' > "$repository/profiles/repo_name"
printf 'app-misc\n' > "$repository/profiles/categories"
printf 'masters = gentoo\nauto-sync = false\nthin-manifests = false\nmanifest-hashes = BLAKE2B SHA512\n' > "$repository/metadata/layout.conf"
printf 'codex-desktop-local generated repository\n' > "$repository/.codex-desktop-generated"
tar -cJf "$scratch/payload.tar.xz" -C "$staging" .
payload_sha="$(sha256sum "$scratch/payload.tar.xz" | cut -d ' ' -f 1)"
payload="codex-desktop-$version-$arch-payload-$payload_sha.tar.xz"
payload_uri="codex-desktop-\${PV}-$arch-payload-$payload_sha.tar.xz"
mv "$scratch/payload.tar.xz" "$scratch/$payload"
printf '%s\n' "$feature_plan" > "$scratch/feature-plan.json"
node - "$SCRIPT_DIR/lib/gentoo-feature-support.js" \
    "$REPO_DIR/packaging/gentoo/codex-desktop.ebuild.template" "$scratch/feature-plan.json" \
    "$arch" "$payload_uri" > "$package/codex-desktop-$version.ebuild" <<'NODE'
const fs = require('node:fs');
const [helper, template, plan, arch, payload] = process.argv.slice(2);
process.stdout.write(require(helper).renderGentooEbuild(
  fs.readFileSync(template, 'utf8'), JSON.parse(fs.readFileSync(plan)), arch, payload,
));
NODE
printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE pkgmetadata SYSTEM "https://www.gentoo.org/dtd/metadata.dtd">\n<pkgmetadata><upstream><remote-id type="github">ilysenko/codex-desktop-linux</remote-id></upstream></pkgmetadata>\n' > "$package/metadata.xml"
node - "$package" "$scratch/$payload" <<'NODE'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = process.argv[2], payload = process.argv[3];
const files = fs.readdirSync(root).filter(n => n.endsWith('.ebuild')).map(n => ['EBUILD', n, n]);
files.push(['MISC', 'metadata.xml', 'metadata.xml']);
files.push(['DIST', path.basename(payload), payload]);
const lines = files.map(([type, name, file]) => {
  const bytes = fs.readFileSync(path.isAbsolute(file) ? file : path.join(root, file));
  const hash = algorithm => crypto.createHash(algorithm).update(bytes).digest('hex');
  return `${type} ${name} ${bytes.length} BLAKE2B ${hash('blake2b512')} SHA512 ${hash('sha512')}`;
});
fs.writeFileSync(path.join(root, 'Manifest'), lines.join('\n') + '\n');
NODE
mkdir -p "$DIST_DIR/gentoo"
mv "$scratch/$payload" "$DIST_DIR/gentoo/$payload"
# This is generated output, replaced only by the builder, never patched in place.
rm -rf -- "$DIST_DIR/gentoo/repository"
mv "$repository" "$DIST_DIR/gentoo/repository"
info "Built local ebuild repository: $DIST_DIR/gentoo/repository ($version/$arch)"
