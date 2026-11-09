# Reasoning Visibility Setting

The optional build feature `reasoning-visibility` adds **Settings → General →
Show reasoning summaries**. Both the build feature and the in-app switch default
to off. Selecting the feature during package setup includes the implementation
and setting in the package; it does not enable the switch automatically.

With the switch enabled, available model reasoning summaries appear as standalone
activity items in Codex local conversations. They stay visible when completed
tool activity collapses and start expanded, including when reopening history.
The native Thinking / Thought disclosure still supports manual folding.
The transcript projection also keeps reasoning separate from tool groups.

When active, the feature requests `detailed` reasoning summaries through the existing
turn-start option. Explicit `model_reasoning_summary` configuration and explicit
per-turn summary settings retain precedence, including `none`. If
`remote-mobile-control` is also selected, an active **Show reasoning summaries**
session preference takes precedence over its extra `none` default for local Linux
Remote durable turns. With the switch off, Remote Mobile Control keeps its own
default; saved latest-thread settings, available model configuration, and
per-turn choices continue through the native resolution order. A failed or
unavailable configuration read preserves the native result. This feature does
not modify `config.toml`, models, reasoning effort, or stored conversations.
Models/providers may supply no summary. Only summaries actually sent by the
backend can be displayed; unavailable internal reasoning cannot be recovered.
Existing history without summary content cannot be filled retroactively.
ChatGPT web conversation reasoning groups use a separate upstream renderer and
are outside this feature's scope.

## Enable

Add `reasoning-visibility` to `enabled` in the gitignored
`linux-features/features.json`, preserving your other selected features, then
rebuild and install. For example, from the repository root:

```bash
export TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop-dev/tmp"
mkdir -p "$TMPDIR"
CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
CODEX_LINUX_FEATURES=reasoning-visibility make setup-native
make install-native
```

Then enable **Show reasoning summaries** under **Settings → General**, completely
quit the app (including the tray), and start it again. The Polish label is
**Pokaż podsumowania myślenia**. The label, description, accessible switch label,
and save error follow the app language: English plus all 65 shipped translation
catalogs, including `es-419` and `hi-Latn`.

The switch is saved in the current Electron profile's local storage under
`codex-linux-reasoning-visibility`, consistent with other renderer preferences.
It is independent of package selection and persists across launches. The active
value is captured once per renderer session, so lazy-loaded chunks cannot mix
on/off behavior. Turning it off and restarting restores the behavior of the
other selected features and upstream, including their summary-request defaults,
without rebuilding. Stored
conversation content is not removed. Other open windows reflect the saved
switch value; their active behavior changes after restart as well.

Native packages include the selected feature in their update-builder so updates
keep the selection. Removing the ID and rebuilding restores upstream behavior.
The feature is disabled in committed defaults.

## Validation

```bash
node --test linux-features/reasoning-visibility/test.js linux-features/reasoning-visibility/*.test.js
# Also check the contracts against an extracted signed app.asar:
CODEX_SIGNED_EXTRACTED_APP=/path/to/extracted/app.asar \
  node --test linux-features/reasoning-visibility/test.js linux-features/reasoning-visibility/*.test.js
```

Run the shared summary-request composition and placement suites with

```bash
node --test linux-features/remote-mobile-control/summary-contract.test.js \
  linux-features/remote-mobile-control/summary-contract-placement.test.js
```

Set `CODEX_SIGNED_EXTRACTED_APP` to a retained extraction of the currently
verified official ASAR to include real-owner and complete patch-runner checks.
They use independent disk-cache copies and do not launch the app or send a model
request. Scope regressions verify that helpers in unrelated modules cannot make
an incomplete patch appear applied. Summary-request checks use bounded native
source carriers and selected statements under mocks; they cover both feature
orders, independent removal, complete physical copies, rollback, and priority
behavior without executing an upstream turn, manager class, or module factory.

Six semantic ASAR contracts cover activity classification, collapsed-turn
persistence, transcript projection, summary requests, the native disclosure,
and the General setting with translations.
The official webview is an rspack build, so chunks are found by distinctive
content, never by file name, chunk id, or module id. When rspack copies a module
into several lazily loaded chunks, every copy is patched. The General setting
row is declared inside the module factory that owns the native menu-bar setting
and reuses only that factory's imports. Translations are added to the 65 locale
JSON modules named by the upstream locale loader map.
Contracts capture local identifiers. Missing, ambiguous, or incomplete
contracts are left untouched and reported; the build gate refuses promotion
when an enabled feature cannot apply completely.
The native markdown renderer, streaming/resume rules, scrolling behavior, and
manual toggle are reused. Empty completed bodies stay hidden while the switch is
on; unavailable summary content is never created.

After rebuilding, enable the setting and restart the application.
Send a task that produces a reasoning summary, followed by tool activity and a
final response. Verify the summary appears between steps, remains expanded after
completion and after reopening the conversation, and can be folded manually.
Check a second turn and a conversation without reasoning summaries as well.

Inspired by the intent of [Andrew Kramer's earlier macOS ASAR patch](https://gist.github.com/andrew-kramer-inno/3fa1063b967cfad2bc6f7cd9af1249fd).
This implementation targets the current signed stable Linux bundle and uses the
repository's feature engine.
