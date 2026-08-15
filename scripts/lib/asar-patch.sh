#!/bin/bash
# Apply enabled feature descriptors to the official Linux app.asar.
# A clean build deliberately never extracts or repacks app.asar.
# Sourced by install.sh. Do not run directly.
# shellcheck shell=bash

print_patch_report_summary() {
    local patch_report="$1"
    [ -f "$patch_report" ] || return 0
    node - "$patch_report" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const counts = {};
for (const patch of report.patches ?? []) counts[patch.status] = (counts[patch.status] ?? 0) + 1;
const summary = Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ") || "none";
console.error(`[INFO] feature patch summary: ${summary}`);
NODE
}

patch_report_has_changes() {
    local patch_report="$1"
    node - "$patch_report" "$SCRIPT_DIR/scripts/lib/patch-report.js" <<'NODE'
const fs = require("node:fs");
const [reportPath, helperPath] = process.argv.slice(2);
const { reportHasPatchChanges } = require(helperPath);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
process.exit(reportHasPatchChanges(report) ? 0 : 1);
NODE
}

record_patch_report_asar_hashes() {
    local patch_report="$1"
    local upstream_sha="$2"
    local output_sha="$3"
    local preserved_byte_for_byte="$4"
    node - "$patch_report" "$upstream_sha" "$output_sha" "$preserved_byte_for_byte" <<'NODE'
const fs = require("node:fs");
const [reportPath, upstreamSha, outputSha, preserved] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
report.upstreamAppAsar = { sha256: upstreamSha, preservedByteForByte: preserved === "true" };
report.outputAppAsar = { sha256: outputSha };
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
NODE
}

write_empty_feature_patch_report() {
    local report_path="$1"
    local app_asar="$2"
    mkdir -p "$(dirname "$report_path")"
    node - "$report_path" "$app_asar" "$SCRIPT_DIR/scripts/lib/patch-report.js" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const [reportPath, asarPath, helperPath] = process.argv.slice(2);
const { createPatchReport } = require(helperPath);
const report = createPatchReport();
report.upstreamAppAsar = {
  sha256: crypto.createHash("sha256").update(fs.readFileSync(asarPath)).digest("hex"),
  preservedByteForByte: true,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
NODE
}

patch_asar() {
    local app_dir="$1"
    local resources_dir="$app_dir/resources"
    local app_asar="$resources_dir/app.asar"
    local patch_report_json="${CODEX_PATCH_REPORT_JSON:-$WORK_DIR/patch-report.json}"
    local descriptor_count
    local upstream_sha
    local patched_sha

    [ -f "$app_asar" ] || error "app.asar not found in $resources_dir"
    descriptor_count="$(node "$SCRIPT_DIR/scripts/lib/linux-features.js" --patch-descriptor-count)"
    if [ "$descriptor_count" -eq 0 ]; then
        info "No ASAR feature descriptors enabled; preserving official app.asar byte-for-byte"
        write_empty_feature_patch_report "$patch_report_json" "$app_asar"
        CODEX_PATCH_REPORT_RESOLVED="$patch_report_json"
        return 0
    fi

    upstream_sha="$(sha256sum "$app_asar" | awk '{print $1}')"
    info "Extracting a temporary app.asar copy for $descriptor_count enabled feature descriptor(s)"
    npx --yes @electron/asar extract "$app_asar" "$WORK_DIR/app-extracted"
    if [ -d "$resources_dir/app.asar.unpacked" ]; then
        cp -a "$resources_dir/app.asar.unpacked/." "$WORK_DIR/app-extracted/"
    fi

    mkdir -p "$(dirname "$patch_report_json")"
    node "$SCRIPT_DIR/scripts/patch-linux-window-ui.js" \
        --report-json "$patch_report_json" \
        --enforce-critical \
        "$WORK_DIR/app-extracted"
    print_patch_report_summary "$patch_report_json"

    if ! patch_report_has_changes "$patch_report_json"; then
        info "No ASAR descriptor changed the current bundle; preserving official app.asar byte-for-byte"
        record_patch_report_asar_hashes "$patch_report_json" "$upstream_sha" "$upstream_sha" true
        CODEX_PATCH_REPORT_RESOLVED="$patch_report_json"
        return 0
    fi

    (cd "$WORK_DIR/app-extracted" && find . -type f -printf '%P\n' | LC_ALL=C sort) > "$WORK_DIR/app.asar.ordering"
    npx --yes @electron/asar pack \
        "$WORK_DIR/app-extracted" \
        "$WORK_DIR/app.asar" \
        --ordering "$WORK_DIR/app.asar.ordering" \
        --unpack "{*.node,*.so,*.dylib}"
    mv "$WORK_DIR/app.asar" "$app_asar"
    if [ -d "$WORK_DIR/app.asar.unpacked" ]; then
        remove_tree_safely "$resources_dir/app.asar.unpacked"
        mv "$WORK_DIR/app.asar.unpacked" "$resources_dir/app.asar.unpacked"
    fi
    patched_sha="$(sha256sum "$app_asar" | awk '{print $1}')"
    record_patch_report_asar_hashes "$patch_report_json" "$upstream_sha" "$patched_sha" false
    CODEX_PATCH_REPORT_RESOLVED="$patch_report_json"
}

inspect_upstream_linux_package() {
    local app_dir="$1"
    local report_dir="${REPORT_DIR:-${REBUILD_REPORT_DIR:-$SCRIPT_DIR/dist-next/rebuild}}"
    local app_asar="$app_dir/resources/app.asar"
    local patch_report="$report_dir/patch-report.json"
    mkdir -p "$report_dir"
    write_empty_feature_patch_report "$patch_report" "$app_asar"
    info "Inspection report: $patch_report"
}
