# Omarchy Theme

Optional integration that makes ChatGPT Community follow the active
[Omarchy](https://omarchy.org/) color palette. It is disabled by default.

The feature:

- installs an Omarchy `themed/` template in the user's configuration on first
  launch without overwriting an existing customized template;
- asks `omarchy theme refresh` to generate
  `~/.config/omarchy/current/theme/codex-desktop.css` when needed;
- publishes the generated file URI through a launcher hook, keeping the current
  theme symlink path so later theme switches remain visible;
- injects a guarded renderer stylesheet loader that refreshes the CSS every five
  seconds and when the window regains focus. The loader is appended to the
  rspack runtime entry chunk that `webview/index.html` boots (identified by its
  content and the native HTML script reference, not its numbered name); the
  detached-window entry is left unchanged.

The current upstream renderer has context isolation and no Node integration,
and runs at `app://-/index.html`. A feature-owned preload method requests only
the configured CSS text from the main process. The main handler accepts only
the native top-level app frame, follows the configured file URI to a regular
file and reads at most 4 MiB. Missing, unreadable or oversized files return no
CSS and are retried on the next refresh. No renderer-supplied path or general
process environment is exposed.

The renderer applies that text to one owned inline style element, which the
existing CSP already permits. The native protocol, CSP, sandbox and context
isolation are preserved. Main, preload and renderer changes are prepared in one
verified transaction; partial, mixed or misplaced runtime copies reject the
enabled build. Cleanup ignores stale replies and removes refresh listeners.

It never edits Omarchy source under `~/.local/share/omarchy/`.

## Enable

Add the feature to the gitignored `linux-features/features.json`:

```json
{
  "enabled": ["omarchy-theme"]
}
```

Then rebuild ChatGPT Community with `./install.sh`, `make install-native`, or the
corresponding AppImage/Nix workflow. The generated app must be rebuilt after
changing feature selection.

On first launch the prelaunch hook installs:

```text
~/.config/omarchy/themed/codex-desktop.css.tpl
```

If Omarchy cannot be refreshed automatically, run:

```bash
omarchy theme refresh
```

Subsequent `omarchy theme set ...` and `omarchy theme refresh` operations update
the generated stylesheet, and an open ChatGPT Community window picks it up within five
seconds.

## Configuration

- `CODEX_LINUX_OMARCHY_STYLESHEET=/absolute/path.css` overrides the generated
  CSS file selected by the launcher.
- `CODEX_OMARCHY_THEME_AUTO_REFRESH=0` prevents the first-launch hook from
  invoking `omarchy theme refresh`.
- `CODEX_OMARCHY_THEME_REFRESH_TIMEOUT_SECONDS=15` changes the bounded wait for
  that refresh. Values must be whole seconds between 1 and 60.

The main process reads only the configured local CSS file; the renderer receives
its text through the narrow bridge. Only select trusted user-owned CSS.

## Disable and cleanup

Remove `omarchy-theme` from `features.json` and rebuild. Declarative feature
resources and runtime hooks are removed automatically. The user-owned Omarchy
template remains so local customizations are not deleted; remove it manually if
desired, then run `omarchy theme refresh`.

## Test

```bash
node --test linux-features/omarchy-theme/test.js
```

Manual acceptance checks:

1. Launch ChatGPT Community and confirm its palette matches `omarchy theme current`.
2. Change themes or run `omarchy theme refresh`.
3. Confirm the open ChatGPT Community window updates within five seconds.
4. Rebuild with the feature disabled and confirm ChatGPT Community uses its normal theme.

## Risks

- Upstream CSS variables and utility selectors can drift with upstream webview
  releases; unsupported selectors simply stop affecting those elements.
- User CSS can obscure controls or reduce contrast. Only load trusted,
  user-owned CSS.
- Polling rereads the configured CSS through the narrow bridge every five seconds.
- Existing customized Omarchy templates are never overwritten automatically,
  so they may need manual updates when this feature's template changes.
