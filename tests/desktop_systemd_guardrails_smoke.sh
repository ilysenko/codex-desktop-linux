#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
    echo "[desktop-systemd-smoke][FAIL] $*" >&2
    exit 1
}

assert_line() {
    local path="$1"
    local expected="$2"
    grep -Fxq -- "$expected" "$path" || fail "Expected '$expected' in $path"
}

assert_absent() {
    local path="$1"
    local pattern="$2"
    ! grep -q -- "$pattern" "$path" || fail "Did not expect '$pattern' in $path"
}

assert_count() {
    local path="$1"
    local pattern="$2"
    local expected="$3"
    local actual
    actual="$(grep -c -- "$pattern" "$path" || true)"
    [ "$actual" = "$expected" ] || fail "Expected $expected matches for '$pattern' in $path, got $actual"
}

check_unit_contract() {
    local desktop="$REPO_DIR/packaging/linux/codex-desktop.service"
    local update_manager="$REPO_DIR/packaging/linux/codex-update-manager.service"
    local root_slice="$REPO_DIR/packaging/linux/codex.slice"
    local runtime_slice="$REPO_DIR/packaging/linux/codex-runtime.slice"
    local maintenance_slice="$REPO_DIR/packaging/linux/codex-maintenance.slice"
    local governor_service="$REPO_DIR/packaging/linux/codex-host-governor.service"
    local governor_socket="$REPO_DIR/packaging/linux/codex-host-governor.socket"
    local governor_helper="$REPO_DIR/packaging/linux/codex-host-governor-user-service.sh"

    assert_line "$desktop" "ExecStart=/usr/bin/codex-desktop --systemd-service-owner"
    assert_line "$desktop" "Restart=no"
    assert_line "$desktop" "KillMode=control-group"
    assert_line "$desktop" "TimeoutStopSec=20"
    assert_line "$desktop" "Slice=codex-runtime.slice"
    assert_line "$desktop" "Environment=CODEX_LINUX_SYSTEMD_SERVICE=1"

    assert_line "$root_slice" "CPUQuota=600%"
    assert_line "$root_slice" "TasksMax=896"
    assert_line "$root_slice" "MemoryHigh=6G"
    assert_line "$root_slice" "MemoryMax=8G"
    assert_line "$root_slice" "MemorySwapMax=1536M"
    assert_line "$root_slice" "CPUWeight=75"
    assert_line "$root_slice" "IOWeight=50"

    assert_line "$runtime_slice" "CPUQuota=500%"
    assert_line "$runtime_slice" "TasksMax=768"
    assert_line "$runtime_slice" "MemoryHigh=4G"
    assert_line "$runtime_slice" "MemoryMax=5500M"
    assert_line "$runtime_slice" "MemorySwapMax=1G"
    assert_line "$runtime_slice" "IOWeight=50"

    assert_line "$maintenance_slice" "CPUQuota=200%"
    assert_line "$maintenance_slice" "TasksMax=192"
    assert_line "$maintenance_slice" "MemoryHigh=3500M"
    assert_line "$maintenance_slice" "MemoryMax=4G"
    assert_line "$maintenance_slice" "MemorySwapMax=1G"
    assert_line "$maintenance_slice" "CPUWeight=25"
    assert_line "$maintenance_slice" "IOWeight=25"

    assert_line "$update_manager" "Slice=codex-maintenance.slice"
    assert_line "$update_manager" "Nice=10"
    assert_line "$update_manager" "Environment=CARGO_BUILD_JOBS=2"

    assert_line "$governor_service" "ExecStart=/usr/libexec/codex-host-governor"
    assert_line "$governor_service" "Slice=codex.slice"
    assert_line "$governor_socket" "ListenStream=%t/codex/host-governor.sock"
    assert_line "$governor_socket" "Service=codex-host-governor.service"
    # Assert literal helper source.
    # shellcheck disable=SC2016
    grep -Fq 'enable --now "$CODEX_HOST_GOVERNOR_SOCKET"' "$governor_helper" \
        || fail "Host governor socket must be enabled and started by package hooks"
    # Assert literal helper source.
    # shellcheck disable=SC2016
    grep -Fq 'target_dir="$home_dir/.local/libexec"' "$governor_helper" \
        || fail "Package hook must mirror the fixed daemon into the user-local path"

    assert_line "$REPO_DIR/packaging/linux/codex-desktop.desktop" \
        "Exec=env BAMF_DESKTOP_FILE_HINT=/usr/share/applications/codex-desktop.desktop CHROME_DESKTOP=codex-desktop.desktop /usr/bin/codex-desktop --new-window"
    assert_absent "$REPO_DIR/packaging/linux/codex-desktop.desktop" "CODEX_MULTI_LAUNCH"
    assert_count "$REPO_DIR/packaging/linux/codex-desktop.desktop" \
        "--slice=codex-maintenance.slice --nice=10 --setenv=CARGO_BUILD_JOBS=2" 2
    assert_absent "$REPO_DIR/packaging/linux/codex-systemd-launcher.sh" "systemd-run"
    # The service owner and failed-start cleanup may remove the handoff file;
    # a successful Type=exec caller must leave it for the service owner.
    assert_count "$REPO_DIR/packaging/linux/codex-systemd-launcher.sh" \
        'rm -f "$runtime_dir/service-launch-args"' 1
    assert_count "$REPO_DIR/packaging/linux/codex-systemd-launcher.sh" \
        'rm -f "$pending_args"' 1
    grep -q 'stage_desktop_systemd_units' "$REPO_DIR/scripts/lib/package-common.sh" \
        || fail "package staging must install the desktop service and slices"
    grep -q 'usr/libexec/codex-host-governor' "$REPO_DIR/scripts/lib/package-common.sh" \
        || fail "package staging must install the host governor daemon"
    assert_line "$REPO_DIR/packaging/linux/codex-desktop.spec" "/usr/libexec/codex-host-governor"
    assert_line "$REPO_DIR/packaging/linux/codex-desktop.spec" "/usr/lib/systemd/user/codex-host-governor.service"
    assert_line "$REPO_DIR/packaging/linux/codex-desktop.spec" "/usr/lib/systemd/user/codex-host-governor.socket"
}

check_host_governor_protocol() {
    local governor="$REPO_DIR/packaging/linux/codex-host-governor"
    local helper="$REPO_DIR/packaging/linux/codex-host-governor-user-service.sh"
    local mirror_root="$TMP_DIR/governor-mirror"

    [ -x "$governor" ] || fail "Host governor source must be executable"
    python3 - "$governor" "$TMP_DIR/governor-runtime" <<'PY'
import asyncio
import importlib.util
from importlib.machinery import SourceFileLoader
import os
from pathlib import Path
import sys

source = Path(sys.argv[1])
os.environ["XDG_RUNTIME_DIR"] = sys.argv[2]
compile(source.read_text(encoding="utf-8"), str(source), "exec")
spec = importlib.util.spec_from_loader(
    "codex_host_governor_smoke",
    SourceFileLoader("codex_host_governor_smoke", str(source)),
)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

valid = {
    "schemaVersion": 1,
    "op": "acquire",
    "kind": "root",
    "client": "desktop",
    "threadId": "desktop-smoke",
}
assert module.SCHEMA_VERSION == 1
assert module.validate_acquire(valid) is None
assert module.validate_acquire({**valid, "schemaVersion": 2}) == "schema-version"
assert module.validate_acquire({**valid, "op": "release"}) == "unsupported-operation"
snapshot = module.Governor().snapshot()
assert snapshot["schemaVersion"] == 1
assert snapshot["ok"] is True
assert snapshot["normalTotal"] == 8
assert snapshot["burstTotal"] == 12

def health(*, block_reasons=(), green=False, tasks=0, memory=0):
    return module.Health(
        sampled_at=0.0,
        tasks=tasks,
        memory=memory,
        mem_available=16 * 1024 * 1024 * 1024,
        cpu_psi=0.0,
        memory_psi=0.0,
        io_psi=0.0,
        temperature=40.0,
        swap_bytes_per_second=0.0,
        maintenance_active=False,
        pids_max_events=0,
        memory_max_events=0,
        block_reasons=list(block_reasons),
        green=green,
    )

def lease(lease_id, *, kind="root", resource_class="slim", granted=False):
    return module.Lease(
        lease_id=lease_id,
        writer=None,
        kind=kind,
        client="desktop" if kind == "root" else "cli",
        project="smoke",
        root_thread_id="root",
        thread_id=lease_id,
        resource_class=resource_class,
        pid=1,
        queued_at=0.0,
        granted=granted,
    )

base = module.time.monotonic()

# Reserved root slots protect capacity from children, but roots still obey
# pressure, projected resource, and heavy-GUI limits.
reserved = module.Governor()
reserved.observe_health(health(green=True), base)
for index in range(module.NORMAL_TOTAL - module.RESERVED_ROOTS):
    child = lease(f"child-{index}", kind="child", granted=True)
    reserved.leases[child.lease_id] = child
allowed, reasons = reserved.can_grant(lease("child-extra", kind="child"))
assert not allowed and "child-capacity" in reasons
allowed, reasons = reserved.can_grant(lease("reserved-root"))
assert allowed and not reasons

pressured = module.Governor()
pressured.observe_health(health(block_reasons=("cpu-pressure",)), base)
allowed, reasons = pressured.can_grant(lease("pressured-root"))
assert not allowed and "cpu-pressure" in reasons

projected = module.Governor()
projected.observe_health(
    health(tasks=module.RUNTIME_TASK_ADMISSION - 1, memory=module.RUNTIME_MEMORY_ADMISSION - 1),
    base,
)
allowed, reasons = projected.can_grant(lease("projected-root"))
assert not allowed
assert "projected-tasks" in reasons and "projected-memory" in reasons

cumulative = module.Governor()
cumulative.observe_health(health(), base)
for index in range(4):
    existing = lease(
        f"reserved-desktop-{index}",
        resource_class="desktop-root",
        granted=True,
    )
    cumulative.leases[existing.lease_id] = existing
allowed, reasons = cumulative.can_grant(
    lease("cumulative-root", resource_class="desktop-root"),
)
assert not allowed
assert "projected-tasks" in reasons and "projected-memory" in reasons

heavy = module.Governor()
heavy.observe_health(health(), base)
existing_heavy = lease("heavy-existing", resource_class="heavy-gui", granted=True)
heavy.leases[existing_heavy.lease_id] = existing_heavy
existing_heavy_2 = lease("heavy-existing-2", resource_class="heavy-gui", granted=True)
heavy.leases[existing_heavy_2.lease_id] = existing_heavy_2
allowed, reasons = heavy.can_grant(lease("heavy-root", resource_class="heavy-gui"))
assert not allowed and "heavy-gui-capacity" in reasons

# Clean startup admits the normal tier immediately. Once pressure has been
# seen, a non-green sample resets the full continuous recovery interval.
recovery = module.Governor()
recovery.observe_health(health(green=True), base)
assert recovery.can_grant(lease("startup-root"))[0]
recovery.observe_health(health(block_reasons=("memory-pressure",)), base + 1)
recovery.observe_health(health(green=True), base + 2)
allowed, reasons = recovery.can_grant(lease("recovering-root"))
assert not allowed and "recovery-window" in reasons
recovery.observe_health(health(green=False), base + 100)
recovery.observe_health(health(green=True), base + 101)
recovery.observe_health(health(green=True), base + 220)
assert not recovery.can_grant(lease("early-root"))[0]
recovery.observe_health(health(green=True), base + 221)
allowed, reasons = recovery.can_grant(lease("recovered-root"))
assert not allowed and "recovery-drain" in reasons
draining_snapshot = recovery.snapshot()
assert draining_snapshot["tier"] == "blocked"
assert "recovery-drain" in draining_snapshot["pressureReasons"]

class Writer:
    def write(self, _payload):
        pass

    async def drain(self):
        pass

for index in range(3):
    queued = lease(f"recovery-queued-{index}", kind="child")
    queued.writer = Writer()
    recovery.leases[queued.lease_id] = queued
    recovery.enqueue(queued)

asyncio.run(recovery.grant_monitor_queue())
assert len(recovery.granted()) == 1
assert len(recovery.queued()) == 2
assert recovery.recovery_draining
asyncio.run(recovery.grant_monitor_queue())
assert len(recovery.granted()) == 2
assert len(recovery.queued()) == 1
assert recovery.recovery_draining
asyncio.run(recovery.grant_monitor_queue())
assert len(recovery.granted()) == 3
assert len(recovery.queued()) == 0
assert not recovery.recovery_draining
assert recovery.can_grant(lease("post-drain-root"))[0]
PY

    if python3 "$governor" unsupported >"$TMP_DIR/governor-cli.out" 2>"$TMP_DIR/governor-cli.err"; then
        fail "Unsupported host-governor CLI command must fail"
    fi
    grep -Fq 'usage:' "$TMP_DIR/governor-cli.err" || fail "Host-governor CLI usage contract drifted"

    mkdir -p "$mirror_root/bin" "$mirror_root/home"
    cat > "$mirror_root/bin/runuser" <<'SCRIPT'
#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
    case "$1" in
        -u) shift 2 ;;
        --) shift; break ;;
        *) shift ;;
    esac
done
exec "$@"
SCRIPT
    chmod 0755 "$mirror_root/bin/runuser"
    (
        # Isolated fake-tool PATH.
        # shellcheck disable=SC2030
        PATH="$mirror_root/bin:$PATH"
        CODEX_HOST_GOVERNOR_SOURCE="$governor"
        export PATH CODEX_HOST_GOVERNOR_SOURCE
        # Helper path is resolved from this checkout.
        # shellcheck disable=SC1090
        . "$helper"
        codex_host_governor_mirror_for_user "$(id -un)" "$mirror_root/home"
    )
    cmp -s "$governor" "$mirror_root/home/.local/libexec/codex-host-governor" \
        || fail "Package hook did not mirror the exact fixed governor"
    [ "$(stat -c '%a' "$mirror_root/home/.local/libexec/codex-host-governor")" = 755 ] \
        || fail "Mirrored host governor must be executable"
}

check_singleton_dispatcher() {
    local workspace="$TMP_DIR/dispatcher"
    local bin_dir="$workspace/bin"
    local app_dir="$workspace/app"
    local runtime_dir="$workspace/run"
    local app_log="$workspace/app.log"
    local systemctl_log="$workspace/systemctl.log"
    local state_file="$workspace/service-active"
    local launcher="$REPO_DIR/packaging/linux/codex-systemd-launcher.sh"

    mkdir -p "$bin_dir" "$app_dir" "$runtime_dir"
    cat > "$app_dir/start.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf 'BEGIN service=%s handoff=%s multi=%s\n' \
    "${CODEX_LINUX_SYSTEMD_SERVICE:-0}" \
    "${CODEX_LINUX_SYSTEMD_HANDOFF_ONLY:-0}" \
    "${CODEX_MULTI_LAUNCH:-unset}" >> "$CODEX_TEST_APP_LOG"
for arg in "$@"; do
    printf 'ARG=%s\n' "$arg" >> "$CODEX_TEST_APP_LOG"
done
SCRIPT
    chmod 0755 "$app_dir/start.sh"

    cat > "$bin_dir/systemctl" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CODEX_TEST_SYSTEMCTL_LOG"
[ "${1:-}" = --user ] && shift
case "${1:-}" in
    show-environment|import-environment)
        exit 0
        ;;
    is-active)
        [ -f "$CODEX_TEST_SERVICE_STATE" ]
        ;;
    start)
        [ "${2:-}" = codex-desktop.service ] || exit 64
        touch "$CODEX_TEST_SERVICE_STATE"
        CODEX_LINUX_SYSTEMD_SERVICE=1 bash "$CODEX_TEST_DISPATCHER" --systemd-service-owner
        ;;
    *)
        exit 65
        ;;
esac
SCRIPT
    chmod 0755 "$bin_dir/systemctl"

    # Use the caller PATH, not the mirror subshell.
    # shellcheck disable=SC2031
    local -a test_env=(
        "PATH=$bin_dir:$PATH"
        "XDG_RUNTIME_DIR=$runtime_dir"
        "CODEX_PACKAGED_APP_DIR=$app_dir"
        "CODEX_PACKAGED_DESKTOP_SERVICE=codex-desktop.service"
        "CODEX_TEST_APP_LOG=$app_log"
        "CODEX_TEST_SYSTEMCTL_LOG=$systemctl_log"
        "CODEX_TEST_SERVICE_STATE=$state_file"
        "CODEX_TEST_DISPATCHER=$launcher"
        "CODEX_MULTI_LAUNCH=1"
    )

    env "${test_env[@]}" bash "$launcher" --new-instance codex://first
    env "${test_env[@]}" bash "$launcher" codex://second
    env "${test_env[@]}" bash "$launcher" --new-instance codex://third

    assert_count "$systemctl_log" "--user start codex-desktop.service" 1
    assert_absent "$systemctl_log" "systemd-run"
    assert_count "$app_log" "^BEGIN " 3
    assert_count "$app_log" "^BEGIN service=1 handoff=0 multi=unset$" 1
    assert_count "$app_log" "^BEGIN service=0 handoff=1 multi=unset$" 2
    assert_count "$app_log" "^ARG=--new-window$" 2
    assert_absent "$app_log" "--new-instance"
    assert_line "$app_log" "ARG=codex://first"
    assert_line "$app_log" "ARG=codex://second"
    assert_line "$app_log" "ARG=codex://third"
}

for script in \
    "$REPO_DIR/packaging/linux/codex-systemd-launcher.sh" \
    "$REPO_DIR/packaging/linux/codex-packaged-runtime.sh" \
    "$REPO_DIR/linux-features/codex-wrapper-updater/apply-pending.sh"
do
    bash -n "$script"
done

check_unit_contract
check_host_governor_protocol
check_singleton_dispatcher
echo "[desktop-systemd-smoke] guardrails passed"
