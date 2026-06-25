# Authenticated Proxy

Opt-in support for HTTP proxies that require username/password authentication.
Chromium does not accept `user:password@` credentials inside the proxy list
passed through `--proxy-server`, so this feature keeps the proxy endpoint and
credentials separate.

Enable the feature by adding it to `linux-features/features.json`:

```json
{
  "enabled": ["authenticated-proxy"]
}
```

Then rebuild the app/package.

## Environment

Preferred explicit configuration:

```bash
CODEX_LINUX_PROXY_SERVER='http://proxy.example:8080' \
CODEX_LINUX_PROXY_USERNAME='user' \
CODEX_LINUX_PROXY_PASSWORD='p@ss' \
./codex-app/start.sh
```

`CODEX_LINUX_PROXY_USERNAME` and `CODEX_LINUX_PROXY_PASSWORD` are raw strings;
do not URL encode them. Optional bypass rules can be passed with
`CODEX_LINUX_PROXY_BYPASS_LIST`, which becomes Electron's
`--proxy-bypass-list` argument.

If `CODEX_LINUX_PROXY_SERVER` is unset, the feature falls back to common proxy
environment variables in this order: `https_proxy`, `HTTPS_PROXY`,
`http_proxy`, `HTTP_PROXY`, `all_proxy`, then `ALL_PROXY`. Credentials embedded
in those URLs are split into `CODEX_LINUX_PROXY_USERNAME` and
`CODEX_LINUX_PROXY_PASSWORD`; percent-encoded characters are decoded. If
`CODEX_LINUX_PROXY_BYPASS_LIST` is unset, `no_proxy` or `NO_PROXY` is converted
to Electron bypass-list syntax.

Common proxy environment variables are still URLs, so reserved characters in
embedded credentials should be percent-encoded. Use
`CODEX_LINUX_PROXY_USERNAME` and `CODEX_LINUX_PROXY_PASSWORD` when you want to
pass credentials as raw strings.

For Flatpak builds, use Flatpak overrides after enabling and rebuilding with
this feature:

```bash
flatpak override --user \
  --env=CODEX_LINUX_PROXY_SERVER='http://proxy.example:8080' \
  --env=CODEX_LINUX_PROXY_USERNAME='user' \
  --env=CODEX_LINUX_PROXY_PASSWORD='p@ss' \
  io.github.ilysenko.codex_desktop_linux
```

If a `--proxy-server` flag is already present in the merged Electron argument
list, this feature does not add another proxy server or authentication target.
There is no special parser for `electron-flags.conf`; persistent launch flags,
feature-provided Electron args, and command-line passthrough arguments are all
loaded into the same Electron argument list before this feature hook runs.
