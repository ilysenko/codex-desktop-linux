# Codex Micro

Disabled-by-default Work Louder Codex Micro support for the official Linux
runtime. The official package already includes the Linux `node-hid` binding,
so this feature only supplies the gate, watcher, and udev policy.

It retains only the locally useful feature-gate override, the narrow Linux
hot-plug watcher, and the udev policy. The gate override finds every renderer
chunk that reads the Codex Micro gate by content (rspack may duplicate a module
into several lazily loaded chunks) and fails closed when any reader is not one
of the known app-shell, sidebar, dictation, composer, or settings owners. Native packages install
`/usr/lib/udev/rules.d/70-codex-micro.rules`; source and AppImage users can
install the staged copy from
`.codex-linux/features/codex-micro/70-codex-micro.rules` and then reload udev.

Enable `codex-micro` in the gitignored `linux-features/features.json`, rebuild,
reconnect the device, and verify Settings → Codex Micro.

```bash
node --test linux-features/codex-micro/test.js
```
