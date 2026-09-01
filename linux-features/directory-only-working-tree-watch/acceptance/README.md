# Signed Owl runtime acceptance

This consumer-owned fixture validates the exact published Watchbound `2.1.2`
packages inside OpenAI's signed Linux x64 executable. It preserves the official
ASAR main entrypoint, adds only the pinned packages and validation hook, and
executes the byte-identical signed ELF as a normal Owl application.
It does not use system Node, stock Electron, or `ELECTRON_RUN_AS_NODE`.

The checked-in JSON is a historical acceptance record for OpenAI Desktop
`26.814.41957`. Its signed deb identity is bound to the Nix pin recorded when
the evidence was created; it does not track the repository's rolling current
Nix pin. Reproducing this exact record therefore requires the corresponding
historical checkout, whose `nix/upstream-linux-packages.json` still contains
that recorded pin, plus the matching signed application extracted into
`codex-app/`.

From that historical checkout, run the following command at the repository
root after installing Watchbound's development dependencies. The artifact
manifest pins all four supported npm artifacts; the package stager fetches and
byte-verifies the three selected for x64. The usual
`CODEX_WATCHBOUND*_ARCHIVE` variables can supply already-downloaded archives.

```bash
node linux-features/directory-only-working-tree-watch/acceptance/run-signed-runtime.mjs \
  --watchbound-source /path/to/watchbound \
  --signed-deb /path/to/chatgpt_26.814.41957_amd64.deb \
  --raw-dir reports/watchbound-signed-runtime/2.1.2-x64 \
  --evidence linux-features/directory-only-working-tree-watch/acceptance/evidence/signed-runtime-2.1.2-x64.json
```

The runner fails before constructing a fixture unless Watchbound is clean and
checked out at `fa188992ef2cc800f9e65b9395139f85ef945c45`, its report-free
runtime parent is `4996ff1d027a95d6ffb677e41236399eae400a16`, and the signed
26.814.41957 deb, executable, and official ASAR have their recorded SHA-256
values. The deb must match that historical checkout's signed-stable APT pin,
and the runner compares the complete application file/symlink inventory against
the deb data payload before using the supplied extraction. Three
fresh-profile lifecycle processes and one tampered native process are then run.
Every process first calls the exact injected production adapter with no module
override, resolves the bare `watchbound` specifier, and proves Parcel was not
selected. The tampered native must fail through that adapter without falling
back. A timeout or output overflow terminates only the isolated child process
group and makes the acceptance fail; successful evidence requires normal,
unforced exits.

The tracked JSON is sanitized and contains no temporary or private absolute
paths. It binds the recorded manifest, adapter, runner, harness, helper sources,
npm archive identities, and historical signed deb pin by SHA-256. The durable
test checks those record-bound inputs while deliberately excluding the rolling
Nix pin from current-pin comparison. Path-bearing stdout, stderr, per-process
JSON, and construction metadata are stored under ignored
`reports/watchbound-signed-runtime/`; their recorded hashes are supplemental
local diagnostics, while the tracked inputs and reproduction command are the
portable evidence. The temporary hybrid application is deleted after the run.

A new acceptance run is a new record: use the package selected by the current
verified signed-stable pin, establish the corresponding runtime expectations,
and produce new evidence. Do not treat the `26.814.41957` command or its
recorded pin hash as validation of a newer rolling pin.

No `process.report` shim is installed or referenced. Watchbound's unmodified
2.1.2 loader derives libc admission from the runtime ELF interpreter and the
tracked evidence records the loader's immutable admission snapshot. This also
exercises the published `>=18.15.0` Node admission directly, without the
retired Nix-only metadata rewrite.

ARM64 remains a separate unavailable result until both a signed ARM64
executable and a real ARM64 execution environment are present.
