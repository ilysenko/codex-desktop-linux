<h1 align="center"> ChatGPT Desktop for Linux</h1>

<p align="center">
  <a href="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/ci.yml"><img src="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/upstream-build-app.yml"><img src="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/upstream-build-app.yml/badge.svg" alt="上游应用构建"></a>
  <a href="https://discord.gg/skCB3DXqgw"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white" alt="加入 Discord 社区"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

这是 [OpenAI ChatGPT Desktop](https://chatgpt.com/features/desktop/) 的非官方 Linux 构建封装。官方 ChatGPT 应用提供 macOS 和 Windows 版本；本仓库通过将上游 macOS `Codex.dmg` 转换为可运行的 Linux Electron 应用，为 Linux 提供支持。

本项目可构建原生 `.deb`、`.rpm` 和 `.pkg.tar.zst` 软件包，支持本地自行构建 AppImage 和 Nix，并可安装本地更新管理器，以便在新版上游 DMG 发布后重新构建 Linux 软件包。

<p align="center">
  <a href="#如何安装">安装</a> ·
  <a href="#卸载">卸载</a> ·
  <a href="#功能矩阵">功能</a> ·
  <a href="#更新">更新</a> ·
  <a href="#构建打包与运行">构建</a> ·
  <a href="#故障排除">故障排除</a> ·
  <a href="#项目文档">文档</a> ·
  <a href="https://discord.gg/skCB3DXqgw">Discord</a>
</p>

发起 Pull Request 前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。有关实现细节，请参阅 [AGENTS.md](AGENTS.md)。

## 如何安装

ChatGPT Desktop for Linux 基于上游 `Codex.dmg` 在本地构建：安装程序会下载或复用 DMG，提取 Electron 应用，应用 Linux 兼容性补丁，重新构建原生模块，准备 Linux 运行环境，并将其打包。可选的 Linux 专属集成功能位于 `linux-features/`，除非你在构建前启用，否则默认保持禁用。

要构建原生软件包或 AppImage，请先克隆仓库：

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
```

| 支持平台 | 构建命令 | 说明 |
|---|---|---|
| Debian、Ubuntu、Pop!_OS、Mint、Elementary | `make bootstrap-native` | 构建并安装 `.deb` |
| Raspberry Pi 5（64 位） | `make bootstrap-native` | 已在 16 GB Pi 5 上验证；参阅 [Raspberry Pi 5](docs/raspberry-pi-5.md) |
| Fedora | `make bootstrap-native` | 构建并安装 `.rpm` |
| openSUSE | `make bootstrap-native` | 构建并安装 `.rpm` |
| Arch、Manjaro、EndeavourOS | `make bootstrap-native` | 构建并安装 pacman 软件包 |
| NixOS / Nix | `nix run github:ilysenko/codex-desktop-linux` | 参阅 [Nix 文档](docs/nix.md) |
| 不可变桌面 / 其他发行版 | `make build-app && make appimage` | 本地自行构建；不含内置更新器 |

推荐的安装方式：

```bash
make bootstrap-native
```

如果依赖已安装可直接执行以下命令：

```bash
make install-native
```

`make bootstrap-native` 会安装构建依赖，验证缓存的上游 `Codex.dmg`，仅在文件缺失或过期时下载，构建 `codex-app/`，为你的发行版打包，并从 `dist/` 安装最新产物。

如果你要在 Fedora 上手动安装依赖：

```bash
# Fedora 41+
sudo dnf install python3 7zip curl unzip rpm-build make gcc-c++ @development-tools

# Fedora < 41
sudo dnf install python3 p7zip p7zip-plugins curl unzip rpm-build make gcc-c++
sudo dnf groupinstall 'Development Tools'
```

如需引导式的首次运行清单和可选功能选择器：

```bash
make setup-native
```

有关向导、非交互式功能选择、清理流程和 `PACKAGE_WITH_UPDATER=0`，请参阅[原生安装](docs/native-setup.md)。

## 卸载

先关闭 ChatGPT Desktop，再使用对应发行版的包管理器卸载软件包：

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

软件包卸载时，如安装了 `codex-update-manager.service`，会自动停止并禁用它。若旧版软件包或手动安装遗留了该服务，请使用以下命令显式禁用：

```bash
systemctl --user disable --now codex-update-manager.service
```

AppImage 构建不会被本仓库安装到系统范围；请删除你创建的 AppImage 文件。仅在仓库中生成的应用可以在工作副本中通过以下命令删除：

```bash
rm -rf codex-app
```

`nix run github:ilysenko/codex-desktop-linux` 是临时运行方式。若你通过 Nix profile、Home Manager 或 NixOS 模块安装了 flake，请删除相应的 profile 或配置，并重新构建你的 profile / 系统。

重新安装会保留用户数据。若只想移除此封装的本地应用状态、日志、启动器标志和更新器状态，请删除以下路径。

如果启用了远程移动控制，`~/.config/codex-desktop` 可能包含私有目录 `remote-control-device-keys/`。删除它或整个 `codex-desktop` 目录前，请在 Codex 设置/连接或 ChatGPT 中撤销已配对设备。对于由功能拥有的数据，优先使用[原生安装](docs/native-setup.md#feature-cleanup)中的清理流程。

```bash
rm -rf \
  ~/.config/codex-desktop \
  ~/.local/state/codex-desktop \
  ~/.cache/codex-desktop \
  ~/.config/codex-update-manager \
  ~/.local/state/codex-update-manager \
  ~/.cache/codex-update-manager
```

除非你还希望删除 Codex CLI 配置和项目状态，否则不要移除 `~/.codex`。

## 安装前须知

生成的应用和原生软件包内置受管理的 Linux Node.js 运行环境。对于普通安装、Browser Use、Codex CLI 的安装/更新或本地自动更新重建，不需要发行版提供的 `nodejs` / `npm` 软件包。

运行时仍需要 Codex CLI。首次启动可使用内置的 `npm` 安装或更新 `@openai/codex`，你也可以自行管理 CLI。若通过 npm 手动安装 CLI，请使用 `npm i -g --include=optional @openai/codex` 包含可选依赖，从而安装 Linux 平台二进制文件。启动器不会按版本选择已安装的 CLI；它会先使用显式的 `CODEX_CLI_PATH`，再按常规查找顺序搜索，并记录解析出的 CLI 路径和尽力获取的版本，便于发现 GUI 的 PATH 问题。希望固定特定二进制文件时，请设置 `CODEX_CLI_PATH=/path/to/codex`。

本地 AppImage 构建可选择性内嵌该 CLI 及对应的 Linux 平台软件包。运行 `make appimage` 时，将 `CODEX_CLI_BUNDLE_SOURCE` 设置为已安装的 `node_modules/@openai/codex` 目录；显式的 `CODEX_CLI_PATH` 在运行时仍然优先。请参阅[构建与打包](docs/build-and-packaging.md#appimage-local-self-build)。

支持 X11 和 Wayland 会话。启动器在 Wayland 上会优先使用 XWayland（若可用），以获得更好的 Electron 弹出窗口定位；否则回退至 Electron 的自动 Wayland 处理。GPU、Vulkan 和 `/tmp noexec` 的解决方法请参阅[故障排除](docs/troubleshooting.md)。

## 功能矩阵

### 核心与平台支持

| 功能 | 默认状态 | 启用 / 使用方式 | 文档 |
|---|---|---|---|
| 标准 ChatGPT Desktop UI | 始终启用 | 安装或运行生成的应用 | 本 README |
| 受管理的 Linux Node.js 运行环境 | 始终启用 | 构建/安装时内置 | [构建与打包](docs/build-and-packaging.md) |
| 原生软件包 | 始终启用 | `make package && make install` | [构建与打包](docs/build-and-packaging.md) |
| 自动更新管理器 | 原生软件包 | 除非 `PACKAGE_WITH_UPDATER=0`，否则随包提供 | [更新器](docs/updater.md) |
| AppImage 自行构建 | 手动 | `make build-app && make appimage` | [构建与打包](docs/build-and-packaging.md#appimage-local-self-build) |
| Nix flake | 手动 | `nix run github:ilysenko/codex-desktop-linux` | [Nix](docs/nix.md) |
| GUI 安装提示 | 若已安装 | 使用 `kdialog` / `zenity`，随后回退至终端 | [原生安装](docs/native-setup.md) |
| Linux 文件管理器集成 | 始终启用 | 内置于核心 Linux 补丁 | [架构](docs/architecture.md) |
| Chrome 插件原生宿主 | 始终启用 | 随内置插件安装 | [架构](docs/architecture.md) |
| 可移植的上游插件 | 上游提供时 | 自动准备 Sites、Deep Research 和 Visualize；上游分批发布仍然适用 | [架构](docs/architecture.md#bundled-plugins) |
| 浏览器标注 | 始终启用 | 内置于已修补的 webview | [架构](docs/architecture.md) |
| 托盘与热启动交接 | 始终启用 | 正常启动应用 | [架构](docs/architecture.md) |
| 多应用实例 | 可选 | `./codex-app/start.sh --new-instance` | [构建与打包](docs/build-and-packaging.md#running-the-generated-app) |
| Linux Computer Use 后端 | 内置 | 默认注册 MCP 后端，包括合成器原生和通用 X11/EWMH 窗口控制 | [Linux Computer Use](docs/linux-computer-use.md) |
| Linux Computer Use UI | 可选 | `CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1` 或设置标志 | [Linux Computer Use](docs/linux-computer-use.md#enable-the-in-app-ui) |
| Linux 功能框架 | 可选 | 编辑 `linux-features/features.json` | [Linux 功能](linux-features/README.md) |

### 可选 Linux 功能

| 功能 | 默认状态 / 状态 | 启用 / 使用方式 | 文档 |
|---|---|---|---|
| 录制与回放（alpha） | 可选 alpha | `record-and-replay` | [文档](linux-features/record-and-replay/README.md) |
| Agent 工作区 | 可选 | `agent-workspace` | [文档](linux-features/agent-workspace/README.md) |
| API 密钥模型可见性 | 可选 | `api-key-model-visibility` | [文档](linux-features/api-key-model-visibility/README.md) |
| API 密钥服务层级 | 可选 | `api-key-service-tier` | [文档](linux-features/api-key-service-tier/README.md) |
| Linux AppShots | 可选 | `appshots` | [文档](linux-features/appshots/README.md) |
| 已认证代理 | 可选 | `authenticated-proxy` | [文档](linux-features/authenticated-proxy/README.md) |
| 封装更新器按钮 | 可选 | `codex-wrapper-updater` | [文档](linux-features/codex-wrapper-updater/README.md) |
| Codex Micro（USB-C / 蓝牙） | 可选 | `codex-micro` | [文档](linux-features/codex-micro/README.md) |
| 对话模式 | 可选 | `conversation-mode` | [文档](linux-features/conversation-mode/README.md) |
| Copilot 推理强度默认值 | 可选 | `copilot-reasoning-effort` | [文档](linux-features/copilot-reasoning-effort/README.md) |
| 仅目录的工作树监测 | 可选 | `directory-only-working-tree-watch` | [文档](linux-features/directory-only-working-tree-watch/README.md) |
| Linux 功能示例 | 开发者示例 | `example-feature` | [文档](linux-features/example-feature/README.md) |
| 无边框标题栏 | 可选 | `frameless-titlebar` | [文档](linux-features/frameless-titlebar/README.md) |
| 全局听写 | 可选 | `global-dictation` | [文档](linux-features/global-dictation/README.md) |
| MCP 辅助进程回收器 | 可选 | `mcp-helper-reaper` | [文档](linux-features/mcp-helper-reaper/README.md) |
| Browser Use node_repl 回收器 | 可选 | `node-repl-reaper` | [文档](linux-features/node-repl-reaper/README.md) |
| Omarchy 主题 | 可选 | `omarchy-theme` | [文档](linux-features/omarchy-theme/README.md) |
| 打开目标发现 | 可选 | `open-target-discovery` | [文档](linux-features/open-target-discovery/README.md) |
| 持久状态面板 | 可选 | `persistent-status-panel` | [文档](linux-features/persistent-status-panel/README.md) |
| 宠物叠加层 | 可选 | `pet-overlay` | [文档](linux-features/pet-overlay/README.md) |
| 项目组“最近更新”排序 | 可选 | `project-group-last-updated-sort` | [文档](linux-features/project-group-last-updated-sort/README.md) |
| 项目任务“创建时间”排序 | 可选 | `project-task-sort` | [文档](linux-features/project-task-sort/README.md) |
| 朗读按钮 | 可选 | `read-aloud` | [文档](linux-features/read-aloud/README.md) |
| 朗读 MCP | 可选 | `read-aloud-mcp` | [文档](linux-features/read-aloud-mcp/README.md) |
| 远程控制 UI 开关 | 可选 | `remote-control-ui` | [文档](linux-features/remote-control-ui/README.md) |
| 实验性远程移动控制 | 可选 | `remote-mobile-control` | [文档](linux-features/remote-mobile-control/README.md) |
| SSH 命令封装器 | 可选 | `ssh-command-wrapper` | [文档](linux-features/ssh-command-wrapper/README.md) |
| Thorium Chrome 插件支持 | 可选 | `thorium-chrome-plugin` | [文档](linux-features/thorium-chrome-plugin/README.md) |
| UI 微调 | 可选 | `ui-tweaks` | [文档](linux-features/ui-tweaks/README.md) |
| 可替代的带命名空间 X11/EWMH Computer Use 工具 | 可选 | `x11-ewmh-computer-use` | [文档](linux-features/x11-ewmh-computer-use/README.md) |

ChatGPT 账户模型的分批开放仍由 OpenAI 按账户控制。重新构建此封装不会解锁这些功能。使用 API 密钥认证的自定义提供商可通过 `api-key-model-visibility` 选择显示其 CLI 模型目录。

## 可选 Linux 功能

可选的 Linux 专属集成功能位于 `linux-features/`，默认处于禁用状态。它们可以添加 ASAR 补丁、准备资源、运行时钩子、打包钩子或旧版构建/安装钩子，而无需改变核心构建流程。

在构建前启用受跟踪或本地功能：

```bash
cp linux-features/features.example.json linux-features/features.json
```

```json
{
  "enabled": [
    "read-aloud",
    "open-target-discovery"
  ]
}
```

私有的用户本地功能可以放在被 git 忽略的 `linux-features/local/<feature-id>/` 目录中，并使用相同的 `feature.json` 约定。修改功能选择后请重新构建：

```bash
make install-native
```

完整约定请参阅 [linux-features/README.md](linux-features/README.md) 和[Linux 功能架构](docs/linux-features-architecture.md)。

## 更新

默认的原生软件包会安装 `codex-update-manager`，这是一个 `systemd --user` 服务，用于检查更新的上游 DMG，重新构建本地原生软件包，并在 ChatGPT Desktop 退出后安装。最终安装使用 `pkexec`。精简的窗口管理器会话需要图形化 polkit 认证代理才能使用应用内安装按钮；否则更新器会保留已准备好的软件包，并报告终端命令 `sudo /usr/bin/codex-update-manager ... --path ...`。

手动更新软件包：

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

从受信任的工作副本手动重建：

```bash
PACKAGE_WITH_UPDATER=0 make update-native
```

AppImage 构建和仅在仓库中生成的应用不包含原生软件包更新器。请参阅[更新器](docs/updater.md)。

## 构建、打包与运行

生成本地 Electron 应用：

```bash
make build-app-fresh
make run-app
```

使用本地 DMG：

```bash
make build-app DMG=/path/to/Codex.dmg
```

本地构建采用事务方式：候选应用必须通过与定时 GitHub 工作流相同的[上游 DMG 验收配置](docs/upstream-dmg-acceptance.md)，才会替换工作中的 `codex-app/`。只检查已配置的 Linux 功能；已启用功能发生漂移时，当前应用会保持安装状态，直到该功能被禁用或修复。

构建并安装软件包：

```bash
make package
make install
```

构建特定产物：

```bash
make deb
make rpm
make pacman
make appimage
```

打包脚本只会重新打包已生成的 `codex-app/`，它们不会自行下载或提取 DMG。请参阅[构建与打包](docs/build-and-packaging.md)。

## 故障排除

| 问题 | 首先尝试 |
|---|---|
| `/tmp` 挂载为 `noexec` | 将 `TMPDIR` 和 `XDG_CACHE_HOME` 设置为 `$HOME` 下可执行的目录 |
| 空白窗口或启动画面卡住 | 检查 `~/.cache/codex-desktop/launcher.log`，以及端口 `5175` 是否已被使用 |
| `CODEX_CLI_PATH` 或 CLI 安装错误 | 检查 `~/.cache/codex-desktop/launcher.log`，设置 `CODEX_CLI_PATH=/path/to/codex` 固定二进制文件，或使用可选依赖手动安装 `@openai/codex` |
| Wayland / GPU / Vulkan 卡住 | 尝试 `CODEX_LINUX_RENDERING_MODE=wayland-gpu ./codex-app/start.sh` 或持久化启动标志 |
| UI 过大或模糊（HiDPI / 分数缩放） | 尝试 `CODEX_FORCE_DEVICE_SCALE_FACTOR=1 ./codex-app/start.sh` 或 `CODEX_OZONE_PLATFORM=x11 ./codex-app/start.sh`；参阅 `./codex-app/start.sh --diagnose-scaling` |
| 调整尺寸时出现残影或陈旧帧 | 尝试 `CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=1 ./codex-app/start.sh` 或 `--disable-gpu-compositing` |
| Computer Use UI 被隐藏 | 启用 UI 可选功能；账户/服务器端的分批开放仍可能隐藏上游控制的部分 |
| Computer Use 没有输入后端 | 检查 `/dev/uinput`、portal 支持，或 `ydotoold` / `ydotool.service` |
| 更新器似乎卡住 | 检查 `codex-update-manager status --json` 和服务日志 |

完整列表：[故障排除](docs/troubleshooting.md)。

## 项目文档

- [原生安装](docs/native-setup.md)
- [Raspberry Pi 5](docs/raspberry-pi-5.md)
- [Nix](docs/nix.md)
- [Linux Computer Use](docs/linux-computer-use.md)
- [Linux 上的录制与回放](docs/record-and-replay-linux.md)
- [更新器](docs/updater.md)
- [构建与打包](docs/build-and-packaging.md)
- [故障排除](docs/troubleshooting.md)
- [架构](docs/architecture.md)
- [应用启动 Shell 中的 GitHub CLI 认证](docs/github-cli-auth.md)
- [Linux 功能架构](docs/linux-features-architecture.md)
- [Wayland 输入焦点调查](docs/wayland-input-focus-investigation.md)
- [Webview 服务器评估](docs/webview-server-evaluation.md)
- [启动器性能说明](docs/launcher-performance.md)

## 免责声明

这是一个非官方社区项目，与 OpenAI 没有隶属关系。ChatGPT Desktop、OpenAI 服务、商标、上游应用代码、二进制文件和资产仍归 OpenAI 或其各自所有者所有。

本仓库中的 MIT 许可证仅适用于此封装的源代码、打包脚本、文档和 Linux 兼容层代码。它不授予对 OpenAI 软件或服务的任何权利。

本仓库不分发 OpenAI 软件或修改后的 OpenAI 应用二进制文件。用户必须通过 OpenAI 官方渠道获得自己已获授权的 Codex Desktop 副本。构建过程会在用户自己的副本上进行本地 Linux 兼容性转换，使其可以在 Linux 上运行。实际上，它自动化了用户在自己副本上执行的转换过程。

使用 ChatGPT Desktop 仍须遵守 OpenAI 的适用条款和服务器端功能可用性。

## 许可证

MIT
