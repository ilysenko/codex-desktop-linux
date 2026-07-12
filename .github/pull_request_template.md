**IMPORTANT: Please keep only one pull request open at a time. The default maximum is two active pull requests from the same contributor, and even that should be reserved for exceptional circumstances. Maintainers may configure a different per-contributor limit for explicit exceptions. Do not open several pull requests at once; finish or close existing work before submitting more. An automated bot will close pull requests that exceed the effective limit.**

<!-- Complete this template before requesting review or merge. -->

## Summary

<!-- What changed, why, and which issue it resolves. -->

## Validation

<!-- List the tests and checks you ran. Mention anything not tested or any known risk. -->

## Checklist

- [ ] This pull request is ready for review and is no longer a draft.
- [ ] I followed [CONTRIBUTING.md](https://github.com/ilysenko/codex-desktop-linux/blob/main/CONTRIBUTING.md), kept the change focused, edited source files rather than generated output, and removed unrelated changes.
- [ ] If this fixes upstream drift, it targets only the latest `CODEX.DMG` and removes obsolete fallback code and tests from the affected area.
- [ ] I added or updated relevant tests, ran the validation listed above, and confirmed that required CI checks pass.
- [ ] I reviewed the final diff with my coding agent using maximum reasoning effort, addressed all findings, and reran the relevant tests.
