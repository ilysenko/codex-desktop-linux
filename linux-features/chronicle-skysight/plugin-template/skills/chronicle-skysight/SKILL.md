---
name: chronicle-skysight
description: Use when recent Linux desktop activity memory would help answer a question or when the user asks to inspect or control Chronicle or Skysight.
---

# Chronicle / Skysight

Call `skysight_status` first. Status and doctor calls are passive and must not
start capture. Call `skysight_snapshot` for one bounded activity snapshot.
Start continuous capture with `skysight_start` only after the user explicitly
requests it. Honor exclusions and use `skysight_pause`, `skysight_resume`, or
`skysight_stop` as requested. Chronicle-compatible resources stay local under
`${CODEX_HOME:-$HOME/.codex}/memories/extensions/chronicle/resources`.
