# Browser Runtime Proxy

Browser Use 会在独立的 `node_repl` 进程中执行网络和 DOM 辅助操作。
某些桌面版本启动该进程时会过滤环境变量：即使 Codex app-server
已经获得明确的代理配置，`node_repl` 也可能没有。这会造成 Chrome
连接和标签页列表正常，但导航或 DOM 命令在 Browser Use 网络检查上超时。

这个默认关闭的功能仅会在子进程未显式设置对应代理族时，
从直接父进程继承：

- `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY`
- 上述变量的小写形式
- `NODE_USE_ENV_PROXY`

对于 HTTP、HTTPS、ALL 和 NO_PROXY，大小写名称按同一个代理族处理。
只要子进程已经设置该族中的任意一种写法，wrapper 就不会从父进程
导入该族的任何变量。这会保留子进程明确指定的路由，也避免暴露
可能包含凭据的多余代理 URL。

如果继承到了非空代理变量，且没有设置 `NODE_USE_ENV_PROXY`，wrapper
会将它设为 `1`，然后原样执行官方 `node_repl`。

## 启用

在 `linux-features/features.json` 中加入：

```json
{
  "enabled": ["browser-proxy"]
}
```

重新构建后，请让启动 Codex 的桌面图标、脚本或服务导出标准代理变量，
例如 v2rayN 的 HTTP 代理：

```bash
HTTP_PROXY='http://127.0.0.1:10809' \
HTTPS_PROXY='http://127.0.0.1:10809' \
NO_PROXY='127.0.0.1,localhost' \
NODE_USE_ENV_PROXY=1 \
./codex-app/start.sh
```

只设置 GNOME 等桌面环境的系统代理，不一定会把这些变量加入 Codex
进程环境。

## 影响范围与安全性

该功能只影响 Browser Use `node_repl` 的网络请求，不会决定 Chrome 网页流量
走哪条路由；Chrome、Electron 或 v2rayN 的分流规则仍需单独配置。

代理 URL 可能包含凭据。启用后，同一用户下的 Browser Use 辅助进程会获得
父 app-server 已经拥有的这些变量，wrapper 不会记录变量值。如果无法
读取 `/proc/<parent>/environ`，将直接使用子进程原有环境运行官方程序。

该功能不会设置 `BROWSER_USE_SECURITY_MODE`，也不会关闭或绕过 site-status、
URL policy 和用户授权检查。

## 关闭与测试

从 `linux-features/features.json` 中移除 `browser-proxy` 后重新构建。如果
wrapper 确实属于该功能，cleanup hook 会恢复原始 `node_repl`。

```bash
node --test linux-features/browser-proxy/test.js
```
