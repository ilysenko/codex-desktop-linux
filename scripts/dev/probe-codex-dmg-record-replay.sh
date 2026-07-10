#!/usr/bin/env bash
set -euo pipefail
user_supplied_work_dir=0

usage() {
  cat <<'USAGE'
Usage: scripts/dev/probe-codex-dmg-record-replay.sh [--dmg Codex.dmg] [--work-dir /tmp/probe] [--keep]

Extracts the smallest useful Codex.dmg surfaces for Record & Replay/Sky/Chronicle
reverse-engineering and prints a compact contract-search report.

The script is read-only against the repository and writes scratch output under
/tmp by default. Run it inside the repo devcontainer when possible.
USAGE
}

status_line() {
  local label=$1
  local status=$2
  local details=${3:-}
  printf "%-48s %s" "$label" "$status"
  [[ -n "$details" ]] && printf "  %s" "$details"
  printf "\n"
}

dmg_path="Codex.dmg"
work_dir=""
keep=0

while (($#)); do
  case "$1" in
    --dmg)
      dmg_path="${2:?missing --dmg value}"
      shift 2
      ;;
    --work-dir)
      work_dir="${2:?missing --work-dir value}"
      user_supplied_work_dir=1
      shift 2
      ;;
    --keep)
      keep=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$dmg_path" ]]; then
  echo "DMG not found: $dmg_path" >&2
  exit 1
fi

command -v 7z >/dev/null || {
  echo "7z is required; run inside the repo devcontainer or install it there." >&2
  exit 1
}
command -v node >/dev/null || {
  echo "node is required; run inside the repo devcontainer." >&2
  exit 1
}
command -v strings >/dev/null || {
  echo "strings is required; run inside the repo devcontainer." >&2
  exit 1
}

if [[ -z "$work_dir" ]]; then
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-record-replay-probe.XXXXXX")"
else
  mkdir -p "$work_dir"
fi

cleanup() {
  if [[ "$keep" -eq 0 && "$user_supplied_work_dir" -eq 0 && -n "${work_dir:-}" && -d "$work_dir" ]]; then
    rm -rf "$work_dir"
  fi
}
trap cleanup EXIT

app_resources="ChatGPT Installer/ChatGPT.app/Contents/Resources"
record_plugin="$app_resources/plugins/openai-bundled/plugins/record-and-replay"
sky_client="$record_plugin/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"

echo "== DMG resources =="
7z l "$dmg_path" \
  | grep -E 'Contents/Resources/(app\.asar|native/sky\.node|codex_chronicle)$|plugins/openai-bundled/plugins/(browser|chrome|computer-use|record-and-replay)(/(\.mcp\.json|\.codex-plugin/plugin\.json|skills/.*/SKILL\.md|Codex Computer Use\.app/Contents/SharedSupport/SkyComputerUseClient\.app/Contents/MacOS/SkyComputerUseClient)|$)' \
  | sed -n '1,140p'

echo
echo "== Extracting probe files to $work_dir =="
7z x -o"$work_dir" "$dmg_path" \
  "$app_resources/app.asar" \
  "$app_resources/native/sky.node" \
  "$app_resources/codex_chronicle" \
  "$record_plugin/.mcp.json" \
  "$record_plugin/.codex-plugin/plugin.json" \
  "$record_plugin/skills/*" \
  "$sky_client" \
  >/dev/null

extracted_resources="$work_dir/$app_resources"
asar_path="$extracted_resources/app.asar"
plugin_root="$work_dir/$record_plugin"
sky_client_path="$work_dir/$sky_client"
sky_strings_file="$work_dir/skyclient.strings.txt"
asar_contract_json="$work_dir/record-replay-asar-contract.json"
missing_required=0

require_file() {
  local label=$1
  local path=$2
  if [[ -f "$path" ]]; then
    status_line "$label" "PASS" "$path"
  else
    status_line "$label" "FAIL" "missing: $path"
    missing_required=1
  fi
}

echo
echo "== Contract pre-checks =="
status_line "DMG found" "PASS" "$dmg_path"
require_file "app.asar extracted" "$asar_path"
require_file "native/sky.node extracted" "$extracted_resources/native/sky.node"
require_file "codex_chronicle extracted" "$extracted_resources/codex_chronicle"
require_file "record-and-replay .mcp.json" "$plugin_root/.mcp.json"
require_file "record-and-replay plugin.json" "$plugin_root/.codex-plugin/plugin.json"
require_file "SkyComputerUseClient extracted" "$sky_client_path"

if (( missing_required )); then
  echo "Required probe artifacts are missing; aborting." >&2
  exit 1
fi

echo
echo "== Plugin contract files =="
find "$plugin_root" -maxdepth 4 -type f \
  | sed "s#^$plugin_root/##" \
  | sort

echo
echo "-- .mcp.json --"
sed -n '1,160p' "$plugin_root/.mcp.json"

echo
echo "-- plugin.json summary --"
node - "$plugin_root/.codex-plugin/plugin.json" <<'NODE'
const fs = require("node:fs");
const plugin = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const mcpServers = plugin?.mcpServers;
console.log(JSON.stringify({
  name: plugin.name,
  version: plugin.version,
  displayName: plugin.interface?.displayName,
  shortDescription: plugin.interface?.shortDescription,
  defaultPrompt: plugin.interface?.defaultPrompt,
  mcpServers: mcpServers,
  skills: plugin.skills,
  mcpServerCount: Array.isArray(mcpServers) ? mcpServers.length : (mcpServers ? Object.keys(mcpServers).length : 0),
  skillCount: Array.isArray(plugin.skills) ? plugin.skills.length : 0,
}, null, 2));
NODE

echo
echo "== Native resource file types =="
file "$extracted_resources/native/sky.node" "$extracted_resources/codex_chronicle" "$sky_client_path"

strings "$sky_client_path" > "$sky_strings_file"

echo
echo "== SkyComputerUseClient contract strings =="
sky_match_patterns='event_stream|skysight_|recording_controls|metadataPath|eventsPath|session\.json|events\.jsonl|Start recording|Stop the active|Start the replay|Stop recording'
if ! grep -E "$sky_match_patterns" "$sky_strings_file" | sort -u | sed -n '1,200p'; then
  echo "no contract strings matched"
fi

echo
echo "== ASAR contract search =="
node - "$asar_path" "$asar_contract_json" "$sky_strings_file" <<'NODE'
const fs = require("node:fs");

const asarPath = process.argv[2];
const reportPath = process.argv[3];
const skyStringsPath = process.argv[4];

const archive = fs.readFileSync(asarPath);
const headerSize = archive.readUInt32LE(4);
const jsonSize = archive.readUInt32LE(12);
const header = JSON.parse(archive.subarray(16, 16 + jsonSize).toString("utf8"));
const dataStart = 8 + headerSize;
const entries = [];

function walk(prefix, files) {
  for (const [name, entry] of Object.entries(files)) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(full, entry.files);
    else entries.push({ path: full, size: entry.size || 0, offset: Number(entry.offset || 0) });
  }
}

function readEntry(entry) {
  return archive.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size).toString("utf8");
}

function scanText(entry) {
  return (/.+\.(js|json|html|css|mjs|cjs|md|txt|map|ts|tsx|jsx)$/i.test(entry.path) || entry.path.includes("webview")) && entry.size <= 2_500_000;
}

function top(list, n = 10) {
  return list.slice(0, n);
}

walk("", header.files);

const pathNeedles = {
  record_and_replay_path: /record-and-replay/i,
  sky_client_path: /SkyComputerUseClient\.app\/Contents\/SharedSupport\/SkyComputerUseClient/i,
  chronicle_path: /codex_chronicle/i,
  computer_use_path: /computer.?use/i,
  event_stream_path: /event[_-]?stream/i,
};

const contentNeedles = [
  "record-and-replay",
  "SkyComputerUseClient",
  "codex_chronicle",
  "event_stream",
  "event.stream",
  "recording_controls",
  "metadataPath",
  "eventsPath",
  "session.json",
  "events.jsonl",
  "SKILL.md",
  "Chronicle",
];

const pathContract = {};
for (const [name, pattern] of Object.entries(pathNeedles)) {
  const hits = entries.filter((entry) => pattern.test(entry.path)).map((entry) => entry.path);
  pathContract[name] = {
    count: hits.length,
    hits: top(hits, 20),
  };
  console.log(`path ${name}: ${hits.length}`);
  for (const hit of top(hits, 20)) console.log(`  ${hit}`);
}

const contentContract = {};
for (const needle of contentNeedles) {
  const rawHits = [];
  for (const entry of entries) {
    if (!scanText(entry)) continue;
    const text = readEntry(entry);
    if (text.includes(needle)) rawHits.push(entry.path);
  }
  const hits = [...new Set(rawHits)];
  contentContract[needle] = {
    count: hits.length,
    hits: top(hits, 20),
  };
  console.log(`content ${needle}: ${hits.length}`);
  for (const hit of top(hits, 10)) console.log(`  ${hit}`);
}

const driftContract = {
  event_stream: {
    pathHits: pathContract.event_stream_path.count > 0,
    contentHits: contentContract.event_stream.count > 0 || contentContract["event.stream"].count > 0,
  },
  sky_computer_use: {
    pathHits: pathContract.sky_client_path.count > 0 || pathContract.computer_use_path.count > 0,
    contentHits: contentContract.SkyComputerUseClient.count > 0 || contentContract.recording_controls.count > 0,
  },
  chronicle: {
    pathHits: pathContract.chronicle_path.count > 0,
    contentHits: contentContract.codex_chronicle.count > 0 || contentContract["session.json"].count > 0 || contentContract["events.jsonl"].count > 0,
  },
  record_and_replay: {
    pathHits: pathContract.record_and_replay_path.count > 0,
    contentHits: contentContract["record-and-replay"].count > 0,
  },
};

console.log("== ASAR contract status ==");
const status = {};
for (const [name, c] of Object.entries(driftContract)) {
  const state = c.pathHits || c.contentHits;
  status[name] = state ? "PASS" : "MISSING";
  console.log(`  ${name}: ${status[name]} (path=${c.pathHits ? "yes" : "no"}, content=${c.contentHits ? "yes" : "no"})`);
}

const skyStrings = fs.existsSync(skyStringsPath) ? fs.readFileSync(skyStringsPath, "utf8") : "";
const skyStringHits = {
  event_stream: /event_stream/i.test(skyStrings),
  skysight: /skysight_/i.test(skyStrings),
  recording_controls: /recording_controls/i.test(skyStrings),
  metadata_events: /metadataPath|eventsPath|events\.jsonl|session\.json/i.test(skyStrings),
};

const contract = {
  totalFiles: entries.length,
  pathContract,
  contentContract,
  driftContract,
  asarStatus: status,
  skyClientStringState: skyStringHits,
};

console.log("== ASAR contract JSON ==");
console.log(JSON.stringify(contract, null, 2));
fs.writeFileSync(reportPath, JSON.stringify(contract, null, 2));
NODE

echo
echo "== Drift matrix =="
node - "$asar_contract_json" <<'NODE'
const fs = require("node:fs");
const contract = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(`event_stream: ${contract.asarStatus.event_stream}`);
console.log(`sky_computer_use: ${contract.asarStatus.sky_computer_use}`);
console.log(`chronicle: ${contract.asarStatus.chronicle}`);
console.log(`record_and_replay: ${contract.asarStatus.record_and_replay}`);
console.log(`sky_client_strings_event_stream: ${contract.skyClientStringState.event_stream ? "PASS" : "MISSING"}`);
console.log(`sky_client_strings_skysight: ${contract.skyClientStringState.skysight ? "PASS" : "MISSING"}`);
console.log(`sky_client_strings_recording_controls: ${contract.skyClientStringState.recording_controls ? "PASS" : "MISSING"}`);
console.log(`sky_client_strings_metadata_events: ${contract.skyClientStringState.metadata_events ? "PASS" : "MISSING"}`);
NODE

if [[ "$keep" -eq 1 ]]; then
  echo
  echo "contract json: $asar_contract_json"
  echo "kept work dir: $work_dir"
else
  rm -f "$sky_strings_file"
fi
