<h1 align="center">ChatGPT Community for Linux</h1>

<p align="center">
  <a href="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/ci.yml"><img src="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/upstream-build-app.yml"><img src="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/upstream-build-app.yml/badge.svg" alt="官方 Linux 软件包构建"></a>
  <a href="https://discord.gg/skCB3DXqgw"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white" alt="加入 Discord 社区"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

`codex-desktop` 是 OpenAI 官方 Linux ChatGPT 桌面应用的非官方社区发行版。
它验证并重新打包已签名的官方 Linux 软件包，提供默认关闭的 Linux 扩展，
并可构建 deb、RPM、pacman、AppImage 和 Nix 产物。

桌面菜单中的自定义应用名为 **ChatGPT Community**，图标带有蓝色 `C`。
软件包名、命令名和安装目录仍为 `codex-desktop`、`codex-desktop` 和
`/opt/codex-desktop`，因此可以与 OpenAI 的 **ChatGPT** 清楚区分。

唯一的上游来源是 OpenAI 已签名的 Linux `.deb`。官方 Electron runtime、
原生模块、内置 `codex` 和 `rg`、code-mode host、插件、库、locale 与 Owl
metadata 均被直接复用。未启用修改 ASAR 的扩展时，`resources/app.asar`
与官方软件包保持逐字节一致。

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#卸载">卸载</a> ·
  <a href="#功能矩阵">功能</a> ·
  <a href="#更新">更新</a> ·
  <a href="#构建打包与运行">构建</a> ·
  <a href="#故障排除">故障排除</a> ·
  <a href="#项目文档">文档</a> ·
  <a href="https://discord.gg/skCB3DXqgw">Discord</a>
</p>

参与贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。维护者和 coding agent
还应阅读 [AGENTS.md](AGENTS.md)。

## 安装

构建原生软件包或 AppImage 前先克隆仓库：

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
```

| 平台 | 推荐命令 | 结果 |
|---|---|---|
| Debian、Ubuntu、Pop!_OS、Mint、Elementary | `make bootstrap-native` | 构建并安装 `.deb` |
| Raspberry Pi 5（64 位系统） | `make bootstrap-native` | 构建官方 `arm64` payload；参阅 [Pi 说明](docs/raspberry-pi-5.md) |
| Fedora | `make bootstrap-native` | 构建并安装 RPM |
| openSUSE | `make bootstrap-native` | 构建并安装 RPM |
| Arch、Manjaro、EndeavourOS | `make bootstrap-native` | 构建并安装 pacman 软件包 |
| NixOS 或其他 Nix 系统 | `nix run github:ilysenko/codex-desktop-linux` | 构建并运行 flake；参阅 [Nix](docs/nix.md) |
| Atomic 桌面或其他发行版 | `make build-app && make appimage` | 生成不含原生更新器的本地 AppImage |

推荐的原生安装命令：

```bash
make bootstrap-native
```

它会安装构建依赖，通过 OpenAI 已签名的 stable APT metadata 解析当前
软件包，构建 `codex-app/`，创建适用于当前发行版的原生包，并安装 `dist/`
中的最新产物。

依赖已经安装时使用：

```bash
make install-native
```

需要先选择可选扩展时：

```bash
make setup-native
make install-native
```

`make setup-native` 只保存本地扩展选择，不会构建或安装应用。向导、
非交互配置、更新器选择和清理方式见[原生安装](docs/native-setup.md)。

### 使用已下载的官方软件包

默认构建会从签名 stable index 中选择 `amd64` 或 `arm64`。也可以提供你已
信任的本地软件包：

```bash
UPSTREAM_DEB=/path/to/chatgpt_<version>_<arch>.deb make build-app
```

本地包仍会检查 package name、architecture、control metadata、payload
完整性，并记录 SHA-256。但由于跳过了签名仓库发现，来源真实性由调用者负责。
旧 `.dmg`、`DMG=` 和 `CODEX_DMG_*` 输入已明确不再支持。

### 安装前须知

- 仅支持 OpenAI 最新的已签名 stable Linux 软件包和 `amd64` / `arm64`。
- 构建需要 Node.js 20+、npm、Python 3、curl、`gpgv`、`dpkg-deb`、tar、
  make 和 C/C++ 工具链。更新器及启用的原生扩展 helper 还需要 Rust。
  `make bootstrap-native` 会安装或提示这些依赖。
- 官方 `chatgpt` 与自定义 `codex-desktop` 可以同时安装，但两者会共享上游
  `Codex` 用户 profile。请勿同时运行；上游 single-instance lock 可能把第二次
  启动交给已经运行的进程。
- AppImage 不会自动添加 `--no-sandbox`。若发行版禁用了 unprivileged user
  namespaces，请使用原生软件包或参阅[故障排除](docs/troubleshooting.md)。

### 匿名每日使用计数

为了帮助社区判断是否值得继续维护本发行版，launcher 每个 UTC 日期最多向
[公开的 GoatCounter dashboard](https://gary.goatcounter.com/) 发送一次匿名
使用事件。事件只包含固定路径 `/app-launch`。GoatCounter 根据网络请求生成汇总
国家信息；不会发送应用内操作、账户或设备标识、版本、架构、软件包格式、语言、
屏幕尺寸或 referrer。所有安装都会发送相同且不含识别信息的固定 User-Agent，
以避免 GoatCounter 将请求当作 bot 丢弃。

请求会在后台静默执行。缺少 `curl`、请求被拦截或发生任何其他错误时，应用启动
都不会被延迟，也不会产生输出。可用唯一的环境变量关闭此计数：

```bash
CODEX_LINUX_DISABLE_USAGE_REPORTING=1 codex-desktop
```

## 卸载

先完全关闭 **ChatGPT Community** 和官方 **ChatGPT**，然后使用安装它的包
管理器卸载：

```bash
# Debian / Ubuntu
sudo apt remove codex-desktop

# Fedora
sudo dnf remove codex-desktop

# openSUSE
sudo zypper remove codex-desktop

# Arch / Manjaro
sudo pacman -R codex-desktop
```

原生包卸载时会禁用用户更新服务。若旧安装或手动安装仍留下服务：

```bash
systemctl --user disable --now codex-update-manager.service
systemctl --user daemon-reload
```

AppImage 只需删除构建出的文件。仓库内生成的应用树可在 checkout 根目录中删除：

```bash
rm -rf -- ./codex-app
```

Nix 用户应从 profile、Home Manager 配置或 NixOS module 中删除该包，然后重新
构建 profile 或系统。

卸载软件包不会删除用户数据。仅要删除 Community wrapper 与更新器状态时，
请先检查再删除以下目录：

```text
~/.config/codex-desktop
~/.local/state/codex-desktop
~/.cache/codex-desktop
~/.config/codex-update-manager
~/.local/state/codex-update-manager
~/.cache/codex-update-manager
```

若启用了 `remote-mobile-control`，删除 private device keys 前请先撤销配对设备。
除非你确实希望删除官方与 Community 共用的 Codex profile、配置、插件和项目
状态，否则不要删除 `~/.codex`。

## 功能矩阵

### 核心发行版

| 能力 | 默认状态 | 提供方式 |
|---|---|---|
| 官方 ChatGPT Linux runtime | 始终启用 | 来自已验证官方 `.deb` 的 data payload |
| 签名来源验证 | 始终启用 | 固定 repository key → `InRelease` → `Packages` SHA-256 → package SHA-256 |
| 逐字节一致的 baseline ASAR | 始终启用 | 无扩展需要 ASAR 时不进行解包 |
| deb、RPM、pacman 原生包 | 手动构建 | `make deb`、`make rpm`、`make pacman` |
| AppImage | 手动构建 | `make appimage`；不绕过 sandbox，不含原生 updater |
| Nix flake | 手动构建 | `nix run github:ilysenko/codex-desktop-linux` |
| 事务式更新管理器 | 原生包 | 除非设置 `PACKAGE_WITH_UPDATER=0` |
| 官方 Browser 和 Chrome 集成 | 上游提供 | 直接复用官方 Linux 实现，不保留旧移植层 |
| Linux 可选扩展框架 | 默认关闭 | 使用 `make setup-native` 配置 |
| 独立桌面标识 | 始终启用 | **ChatGPT Community**、蓝色 `C` 图标、`codex-desktop` package identity |

### 可选 Linux 扩展

以下扩展全部默认关闭。每个扩展目录中的 README 都包含依赖、限制、配置与测试。

| 扩展 ID | 用途 | 文档 |
|---|---|---|
| `agent-workspace` | 隐藏桌面环境中的 agent-workspace 设置和 bridge | [文档](linux-features/agent-workspace/README.md) |
| `api-key-model-visibility` | 显示 API-key compatible provider 返回的模型 | [文档](linux-features/api-key-model-visibility/README.md) |
| `api-key-service-tier` | API-key compatible provider 的 Fast/service-tier UI | [文档](linux-features/api-key-service-tier/README.md) |
| `appshots` | 从 composer 捕获并裁剪当前 Linux 窗口 | [文档](linux-features/appshots/README.md) |
| `authenticated-proxy` | 带用户名和密码的 HTTP proxy | [文档](linux-features/authenticated-proxy/README.md) |
| `automation-extensions` | 多时间调度和 eager `automation_update` | [文档](linux-features/automation-extensions/README.md) |
| `chronicle-skysight` | 可选的 Linux 桌面活动记忆与受限 Skysight MCP 工具 | [文档](linux-features/chronicle-skysight/README.md) |
| `codex-micro` | 使用上游 `node-hid` 的 Codex Micro hotplug/hidraw policy | [文档](linux-features/codex-micro/README.md) |
| `computer-use-linux` | Linux desktop-control UI 与原生 MCP backend | [文档](linux-features/computer-use-linux/README.md) |
| `copilot-reasoning-effort` | Copilot auth 的 reasoning-effort 默认值 | [文档](linux-features/copilot-reasoning-effort/README.md) |
| `directory-only-working-tree-watch` | 有界 Watchbound 工作树监听 | [文档](linux-features/directory-only-working-tree-watch/README.md) |
| `frameless-titlebar` | 隐藏官方 Linux overlay 按钮，改由 compositor 管理窗口装饰 | [文档](linux-features/frameless-titlebar/README.md) |
| `global-dictation` | X11 / XDG portal 全局听写快捷键 | [文档](linux-features/global-dictation/README.md) |
| `linux-performance-workarounds` | 针对受影响系统的 renderer workaround | [文档](linux-features/linux-performance-workarounds/README.md) |
| `mcp-helper-reaper` | 安全清理孤立 MCP helper | [文档](linux-features/mcp-helper-reaper/README.md) |
| `node-repl-reaper` | 清理 owner 退出后泄漏的 Browser Use `node_repl` | [文档](linux-features/node-repl-reaper/README.md) |
| `omarchy-theme` | 加载当前 Omarchy 主题生成的 CSS | [文档](linux-features/omarchy-theme/README.md) |
| `persistent-status-panel` | 在线程切换和重启后保留 `/status` panel | [文档](linux-features/persistent-status-panel/README.md) |
| `pet-overlay` | Linux avatar overlay 定位和 compositor hints | [文档](linux-features/pet-overlay/README.md) |
| `project-group-last-updated-sort` | 对 project group 和 task 应用 Last updated 排序 | [文档](linux-features/project-group-last-updated-sort/README.md) |
| `project-task-sort` | 恢复 alternate Projects 的 Created 排序 | [文档](linux-features/project-task-sort/README.md) |
| `read-aloud` | 为 assistant response 添加 Linux 朗读控件 | [文档](linux-features/read-aloud/README.md) |
| `read-aloud-mcp` | 让 agent 通过 Linux Read Aloud backend 发声 | [文档](linux-features/read-aloud-mcp/README.md) |
| `record-and-replay` | 将 Linux 操作演示录制为可复用 skill | [文档](linux-features/record-and-replay/README.md) |
| `remote-control-ui` | 显示实验性 remote-control 设置 | [文档](linux-features/remote-control-ui/README.md) |
| `remote-mobile-control` | 实验性 Linux remote-host / outbound-control flow | [文档](linux-features/remote-mobile-control/README.md) |
| `shallow-repository-watches` | 避免临时 repo preview 在主线程递归遍历 | [文档](linux-features/shallow-repository-watches/README.md) |
| `shared-app-server-socket` | 共享 protocol-transparent Unix app-server socket | [文档](linux-features/shared-app-server-socket/README.md) |
| `thorium-chrome-plugin` | 为官方 Chrome integration 添加 Thorium | [文档](linux-features/thorium-chrome-plugin/README.md) |
| `ui-tweaks` | 可选 UI 与交互自定义 | [文档](linux-features/ui-tweaks/README.md) |

ChatGPT account rollout 和 server-side 功能仍由 OpenAI 控制。重新构建本项目
不会解锁账号功能。

## 配置可选扩展

推荐使用向导：

```bash
make setup-native
```

也可以手动复制 gitignored 配置：

```bash
cp linux-features/features.example.json linux-features/features.json
```

```json
{
  "enabled": [
    "read-aloud",
    "ui-tweaks"
  ]
}
```

然后重新构建并安装：

```bash
make install-native
```

私有扩展可以放在 gitignored 的 `linux-features/local/<feature-id>/`，并使用相同
manifest。已知 retired ID 会被忽略以迁移旧配置；任意未知 ID 与拼写错误仍会
报错。参阅[扩展框架 README](linux-features/README.md)和
[扩展架构](docs/linux-features-architecture.md)。

## 更新

原生包默认包含 `codex-update-manager`。其 user service 使用同一签名 APT
metadata 检查更新，按 version/architecture/SHA-256 缓存官方包，使用当前启用
扩展重建原生包，并等待应用退出后再切换。上一份已管理软件包会保留用于回滚。

```bash
codex-update-manager status
codex-update-manager status --json
codex-update-manager check-now
codex-update-manager diagnose
codex-update-manager install-ready
codex-update-manager rollback
```

```bash
systemctl --user enable --now codex-update-manager.service
systemctl --user status codex-update-manager.service
journalctl --user -u codex-update-manager.service
```

构建不含 updater 的手动更新包：

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

AppImage 与仓库内生成应用不包含原生包 updater。参阅[更新器](docs/updater.md)。

## 构建、打包与运行

```bash
# 构建本地应用树并直接运行
make build-app
make run-app

# 为当前发行版构建并安装原生包
make package
make install

# 构建指定格式
make deb
make rpm
make pacman
make appimage
```

构建采用事务方式：候选版本通过验证后才会替换当前应用。启用的 ASAR 扩展
发生 drift 时会拒绝候选版本；未启用扩展不会被探测。依赖、变量、输出布局、
并行构建和 payload 检查见[构建与打包](docs/build-and-packaging.md)。

## 故障排除

| 问题 | 首先检查 |
|---|---|
| 官方与 Community 启动互相影响 | 完全退出所有 `ChatGPT` 进程；两者共享上游 profile |
| 迁移后 Browser/Chrome extension 无法连接 | 完全退出 ChatGPT 与 Chrome，再按[故障排除](docs/troubleshooting.md#browser-or-chrome-plugin-is-visible-but-cannot-connect)执行窄范围 cache repair |
| 签名或软件包验证失败 | 不要绕过；检查系统时间、网络、`gpgv`、architecture 和磁盘空间 |
| 应用无法启动 | 运行 `/opt/codex-desktop/start.sh --diagnose` |
| 应用使用 XWayland，或需要持久化 Electron 参数 | 在 `~/.config/codex-desktop/electron-flags.conf` 中每行写一个参数，例如 `--ozone-platform=wayland` |
| AppImage 报 sandbox 错误 | 启用 user namespaces 或安装原生包；不会自动添加 `--no-sandbox` |
| 上游更新后启用扩展发生 drift | 禁用该扩展确认 clean baseline，并在 issue 中附上 patch report |
| updater 等待应用退出 | 关闭官方与 Community 进程，检查 `codex-update-manager status --json` |
| 旧 `codex-app.backup-*` 出现权限错误 | 先确认精确路径，再按 root-owned backup 流程处理；不要盲删 wildcard |

完整指南：[故障排除](docs/troubleshooting.md)。

## 项目文档

- 入门：[原生安装](docs/native-setup.md)、[构建与打包](docs/build-and-packaging.md)、[Nix](docs/nix.md)、[Raspberry Pi 5](docs/raspberry-pi-5.md)
- 运行与维护：[架构](docs/architecture.md)、[更新器](docs/updater.md)、[故障排除](docs/troubleshooting.md)
- 扩展：[扩展框架](linux-features/README.md)、[扩展架构](docs/linux-features-architecture.md)、[Linux Computer Use](docs/linux-computer-use.md)、[Record and Replay](docs/record-and-replay-linux.md)、[Chronicle / Skysight](docs/linux-chronicle-skysight.md)
- 贡献：[贡献指南](CONTRIBUTING.md)、[Agent 指令](AGENTS.md)、[仓库结构](docs/agents/repository-map.md)、[验证流程](docs/agents/validation-playbook.md)、[生成与运行时说明](docs/agents/generated-and-runtime-notes.md)
- 项目运维：[GitHub CLI 认证](docs/github-cli-auth.md)、[Label 管理](docs/label-governance.md)

旧 macOS DMG 转换、下载 Electron 替换、原生模块重建、本地 webview server 和
自定义 warm-start 文档不会恢复为当前文档，因为这些 runtime 责任已由官方
Linux 软件包承担。

## 免责声明

这是一个非官方社区项目，与 OpenAI 没有隶属关系。ChatGPT、OpenAI 服务、
商标、上游应用代码、二进制文件和资产仍归 OpenAI 或各自所有者所有。

本仓库在本地下载并重新打包官方 Linux payload，不授予任何 OpenAI 软件或
服务权利。使用 ChatGPT 仍须遵守 OpenAI 的适用条款和 server-side 功能可用性。

MIT 许可证仅适用于本仓库的 wrapper source、打包、文档和社区扩展。

## 许可证

[MIT](LICENSE)
