# Browser Runtime Proxy

Browser Use runs its network and DOM helpers in a separate `node_repl`
process. Some desktop releases start that helper with a filtered environment,
even when the Codex app-server has explicit proxy variables. Chrome can remain
connected while navigation and DOM commands then wait on Browser Use network
checks that cannot reach their endpoint.

This opt-in feature wraps the bundled helper and copies only these variables
from its immediate app-server parent when the helper did not receive a member
of the corresponding proxy family:

- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`
- their lower-case equivalents
- `NODE_USE_ENV_PROXY`

Upper- and lower-case spellings are treated as one proxy family for HTTP,
HTTPS, ALL, and NO_PROXY. If the helper already has either spelling in a
family, neither spelling is imported from the parent. This preserves an
explicit child route and avoids exposing an unnecessary alternate-case proxy
URL that may contain credentials.

When a non-empty proxy variable is recovered and `NODE_USE_ENV_PROXY` is not
set, the wrapper sets it to `1`. The original helper is then executed without
changing Browser Use URL-policy or user-consent checks.

## Enable

Add the feature to `linux-features/features.json`:

```json
{
  "enabled": ["browser-proxy"]
}
```

Then rebuild the app/package. Launch Codex with standard proxy variables in
its environment, for example:

```bash
HTTP_PROXY='http://127.0.0.1:10809' \
HTTPS_PROXY='http://127.0.0.1:10809' \
NO_PROXY='127.0.0.1,localhost' \
NODE_USE_ENV_PROXY=1 \
./codex-app/start.sh
```

The launcher, desktop entry, or service that starts Codex must export these
variables. Desktop proxy settings alone may not add them to the process
environment.

## Scope and security

This feature affects Browser Use `node_repl` network requests. It does not
select the proxy used by Chrome page traffic; configure that separately in
Chrome, Electron, or the proxy application's routing rules.

Proxy URLs can contain credentials. Enabling this feature makes the selected
proxy variables available to the same-user Browser Use helper, just as they
are already available to its Codex app-server parent. Values are never logged.
If `/proc/<parent>/environ` cannot be read, the wrapper runs the original
helper with its existing environment.

The feature does not set `BROWSER_USE_SECURITY_MODE`, disable ambient network
controls, or bypass Browser Use site-status, URL-policy, or consent checks.

## Disable and test

Remove `browser-proxy` from `linux-features/features.json` and rebuild. Its
cleanup hook restores the original `node_repl` entrypoint when it owns the
wrapper.

Run the regression tests with:

```bash
node --test linux-features/browser-proxy/test.js
```
