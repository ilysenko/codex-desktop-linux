# Project Source Filter

Adds a visible source selector to the **Projects** heading in ChatGPT mode:
**All**, **ChatGPT**, or **Work**. Work includes local and connected Codex
projects. The choice is saved across app launches. All is the default and
matches upstream behavior.

The filter changes only the Projects list and its keyboard navigation. Pinned
projects, custom sections, chats, project records, and saved project order are
unchanged. The selector appears when the sidebar is organized by project; the
connection and single-list views retain their existing behavior.

This optional feature is disabled by default. Enable `project-source-filter`
through `make setup-native` or add it to `linux-features/features.json` before
building:

```json
{
  "enabled": ["project-source-filter"]
}
```

Run `node --test linux-features/project-source-filter/test.js` to test the
patch. The patch targets the current official app sidebar bundle and leaves it
unchanged if its expected UI structure drifts. The selector's saved choice is
stored in the app's existing local settings; disabling the feature leaves that
setting unused.
