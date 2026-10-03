<h1 align="center">ChatGPT Community for Linux</h1>

<p align="center">
  <a href="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/ci.yml"><img src="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/upstream-build-app.yml"><img src="https://github.com/ilysenko/codex-desktop-linux/actions/workflows/upstream-build-app.yml/badge.svg" alt="ساخت بسته رسمی لینوکس"></a>
  <a href="https://discord.gg/skCB3DXqgw"><img src="https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white" alt="پیوستن به جامعه Discord"></a>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | فارسی
</p>

`codex-desktop` یک توزیع غیررسمی و جامعه‌محور از برنامه رسمی ChatGPT دسکتاپ برای لینوکسِ OpenAI است. این پروژه payload امضاشده رسمی لینوکس را اعتبارسنجی و دوباره بسته‌بندی می‌کند، قابلیت‌های اختیاری لینوکس را که به‌صورت پیش‌فرض غیرفعال‌اند اضافه می‌کند و خروجی‌های deb، RPM، pacman، AppImage و Nix می‌سازد.

برنامه سفارشی در منوی دسکتاپ با نام **ChatGPT Community** دیده می‌شود و آیکونی با `C` آبی دارد. نام بسته و دستور آن `codex-desktop` است و در `/opt/codex-desktop` نصب می‌شود؛ بنابراین از بسته جداگانه رسمی **ChatGPT** به‌راحتی قابل تشخیص است.

تنها منبع upstream، بسته `.deb` امضاشده رسمی OpenAI است. Electron runtime رسمی، ماژول‌های native، ابزارهای bundled مانند `codex` و `rg`، میزبان code-mode، pluginها، libraryها، localeها و metadata مربوط به Owl مستقیماً استفاده می‌شوند. یک build تمیز فقط patchهای سازگاری ضروری را روی `resources/app.asar` اعمال می‌کند و runtimeهای ELF و ابزارهای bundled رسمی را بدون تغییر باینری نگه می‌دارد. قابلیت‌های اختیاری لینوکس فقط وقتی فعال می‌شوند که صراحتاً انتخاب شده باشند.

<p align="center">
  <a href="#نصب">نصب</a> ·
  <a href="#حذف-نصب">حذف نصب</a> ·
  <a href="#ماتریس-قابلیت‌ها">قابلیت‌ها</a> ·
  <a href="#به‌روزرسانی‌ها">به‌روزرسانی‌ها</a> ·
  <a href="#ساخت-بسته‌بندی-و-اجرا">ساخت</a> ·
  <a href="#عیب‌یابی">عیب‌یابی</a> ·
  <a href="#مستندات-پروژه">مستندات</a> ·
  <a href="https://discord.gg/skCB3DXqgw">Discord</a>
</p>

پیش از مشارکت، [CONTRIBUTING.md](CONTRIBUTING.md) را بخوانید. Maintainerها و coding agentها همچنین باید [AGENTS.md](AGENTS.md) را مطالعه کنند.

## نصب

پیش از ساخت یک بسته native یا AppImage، مخزن را clone کنید:

```bash
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
```

| پلتفرم | دستور پیشنهادی | نتیجه |
|---|---|---|
| Debian، Ubuntu، Pop!_OS، Mint، Elementary | `make bootstrap-native` | ساخت و نصب `.deb` |
| Raspberry Pi 5 با سیستم‌عامل ۶۴ بیتی | `make bootstrap-native` | ساخت payload رسمی `arm64`؛ [راهنمای Pi](docs/raspberry-pi-5.md) را ببینید |
| Fedora | `make bootstrap-native` | ساخت و نصب RPM |
| openSUSE | `make bootstrap-native` | ساخت و نصب RPM |
| Arch، Manjaro، EndeavourOS | `make bootstrap-native` | ساخت و نصب بسته pacman |
| NixOS یا هر سیستم Nix دیگر | `nix run github:ilysenko/codex-desktop-linux` | ساخت و اجرای خروجی flake؛ [Nix](docs/nix.md) را ببینید |
| دسکتاپ‌های Atomic یا سایر توزیع‌ها | `make build-app && make appimage` | ساخت AppImage محلی بدون updater native |

روش پیشنهادی نصب native:

```bash
make bootstrap-native
```

این دستور وابستگی‌های build را نصب می‌کند، بسته فعلی را از metadata امضاشده stable APT مربوط به OpenAI پیدا می‌کند، `codex-app/` را می‌سازد، بسته native مناسب توزیع فعلی را تولید می‌کند و جدیدترین artifact موجود در `dist/` را نصب می‌کند.

اگر وابستگی‌ها از قبل نصب شده‌اند:

```bash
make install-native
```

برای استفاده از نصب‌کننده گرافیکی مرحله‌ای، entrypoint مستقل مخزن را اجرا کنید:

```bash
./install-community
```

`make guided-install` نیز همین entrypoint را اجرا می‌کند. این installer بخشی از روند setup مخزن است و خودش یک Linux feature محسوب نمی‌شود. روی دسکتاپ‌هایی که GTK4/PyGObject دارند، مراحل انتخاب featureها، گزینه‌های نصب، مرور نهایی و build/install را همراه با progress و log زنده نمایش می‌دهد. وابستگی‌های لازم خودکار انتخاب می‌شوند و گزینه‌های متعارض همراه با دلیل غیرفعال می‌شوند.

Graphical installer پیاده‌سازی یا settings خود featureها را تغییر نمی‌دهد. فقط فهرست featureهای فعال و تنظیمات مربوط به خود installer را در فایل gitignored یعنی `linux-features/features.json` به‌روز می‌کند و settings موجود featureها را دست‌نخورده نگه می‌دارد. خروجی native همیشه هویت بسته `codex-desktop` و مسیر نصب `/opt/codex-desktop` را حفظ می‌کند؛ چه updater خودکار داخل بسته باشد چه نباشد.

اگر فقط می‌خواهید featureها را تنظیم کنید و فعلاً نصب نکنید:

```bash
make setup-native
make install-native
```

`make setup-native` فقط انتخاب featureهای محلی را ذخیره می‌کند و برنامه را build یا install نمی‌کند. برای flow کامل، تنظیمات non-interactive، انتخاب updater و cleanup به [Native setup](docs/native-setup.md) مراجعه کنید.

### استفاده از بسته رسمی دانلودشده

به‌صورت معمول build نسخه `amd64` یا `arm64` را از stable index امضاشده پیدا می‌کند. می‌توانید به‌جای آن یک بسته محلی که خودتان به منبعش اعتماد دارید معرفی کنید:

```bash
UPSTREAM_DEB=/path/to/chatgpt_<version>_<arch>.deb make build-app
```

بسته محلی همچنان از نظر package name، architecture، control metadata، کامل‌بودن payload و ثبت SHA-256 بررسی می‌شود. چون در این حالت discovery از repository امضاشده انجام نمی‌شود، مسئولیت اطمینان از منبع فایل با کاربر است. ورودی‌های قدیمی `.dmg`، `DMG=` و `CODEX_DMG_*` عمداً پشتیبانی نمی‌شوند.

### پیش از نصب

- فقط آخرین بسته stable و امضاشده رسمی OpenAI برای لینوکس روی `amd64` و `arm64` پشتیبانی می‌شود.
- ابزارهای build به Node.js 20 یا جدیدتر، npm، Python 3، curl، `gpgv`، `dpkg-deb`، tar، make و toolchain مربوط به C/C++ نیاز دارند. Rust برای updater و helperهای native مربوط به featureهای فعال استفاده می‌شود. `make bootstrap-native` این موارد را نصب می‌کند یا برایشان راهنما می‌دهد.
- بسته رسمی `chatgpt` و بسته سفارشی `codex-desktop` می‌توانند هم‌زمان نصب باشند. به‌صورت پیش‌فرض هر دو از profile بالادستی `Codex` استفاده می‌کنند و بهتر است هم‌زمان اجرا نشوند. feature اختیاری `community-profile-isolation` برای Community state جداگانه Codex و Electron فراهم می‌کند و CLI bundled خود را pin می‌کند تا کاربرانی که runtime ایزوله می‌خواهند از مرز shared-profile عبور کنند.
- AppImage هیچ‌وقت به‌طور خودکار `--no-sandbox` اضافه نمی‌کند. اگر توزیع شما unprivileged user namespaces را غیرفعال کرده، از بسته native استفاده کنید یا راهنمای sandbox در [Troubleshooting](docs/troubleshooting.md) را ببینید.

### شمارش ناشناس روزانه استفاده

برای کمک به جامعه پروژه در تصمیم‌گیری درباره ارزش ادامه نگهداری این توزیع، launcher در هر روز UTC حداکثر یک event ناشناس به [داشبورد عمومی GoatCounter](https://gary.goatcounter.com/) می‌فرستد. event فقط شامل مسیر ثابت `/app-launch` است. GoatCounter بر اساس درخواست شبکه یک کشور کلی تخمین می‌زند؛ هیچ فعالیت درون برنامه، شناسه حساب یا ماشین، نسخه، architecture، package format، زبان، اندازه نمایشگر یا referrer ارسال نمی‌شود. همه نصب‌ها یک User-Agent ثابت و غیرقابل شناسایی می‌فرستند تا GoatCounter درخواست را به‌عنوان bot دور نریزد.

این درخواست به‌صورت بی‌صدا در پس‌زمینه اجرا می‌شود. نبودن `curl`، block شدن درخواست یا هر خطای دیگری باعث کندشدن startup برنامه نمی‌شود و خروجی‌ای تولید نمی‌کند. برای غیرفعال‌کردن شمارش استفاده:

```bash
CODEX_LINUX_DISABLE_USAGE_REPORTING=1 codex-desktop
```

## حذف نصب

ابتدا **ChatGPT Community** و برنامه رسمی **ChatGPT** را کامل ببندید. سپس بسته native را با package manager همان سیستمی که نصب را انجام داده حذف کنید:

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

حذف بسته native سرویس update کاربر را غیرفعال می‌کند. اگر سرویس مربوط به یک نصب قدیمی یا دستی باقی مانده:

```bash
systemctl --user disable --now codex-update-manager.service
systemctl --user daemon-reload
```

برای AppImage کافی است فایل AppImage ساخته‌شده را حذف کنید. برای برنامه‌ای که فقط داخل repository ساخته شده، فقط tree تولیدشده در checkout را پاک کنید:

```bash
rm -rf -- ./codex-app
```

کاربران Nix باید بسته را از profile، تنظیمات Home Manager یا NixOS module حذف کنند و profile یا سیستم را دوباره build کنند.

حذف بسته، داده‌های کاربر را پاک نمی‌کند. برای حذف فقط state مربوط به wrapper و updater نسخه Community، ابتدا این مسیرها را بررسی و سپس حذف کنید:

```text
~/.config/codex-desktop
~/.local/state/codex-desktop
~/.cache/codex-desktop
~/.config/codex-update-manager
~/.local/state/codex-update-manager
~/.cache/codex-update-manager
```

اگر `community-profile-isolation` فعال بوده، state متعلق به Community در `~/.codex-community` و Electron profile در `~/.config/Codex-Community` قرار دارد. فقط وقتی واقعاً می‌خواهید داده ایزوله Community را حذف کنید این مسیرها را پاک کنید.

اگر `remote-mobile-control` فعال بوده، پیش از حذف private device keyها دستگاه‌های pairشده را revoke کنید. `~/.codex` را حذف نکنید مگر اینکه عمداً می‌خواهید profile پیش‌فرض مشترک Codex، configuration، pluginها و state پروژه‌ها را پاک کنید.

## ماتریس قابلیت‌ها

### توزیع اصلی

| قابلیت | وضعیت پیش‌فرض | نحوه ارائه |
|---|---|---|
| runtime رسمی ChatGPT لینوکس | همیشه | کپی از payload داده بسته رسمی `.deb` پس از اعتبارسنجی |
| اعتبارسنجی منبع امضاشده | همیشه | کلید repository pinشده → `InRelease` → SHA-256 مربوط به `Packages` → SHA-256 بسته |
| بسته‌های native برای deb، RPM و pacman | build دستی | `make deb`، `make rpm` یا `make pacman` |
| AppImage | build دستی | `make appimage`؛ بدون bypass خودکار sandbox یا updater bundled |
| Nix flake | build دستی | `nix run github:ilysenko/codex-desktop-linux` |
| update manager تراکنشی | بسته‌های native | به‌جز buildهای دارای `PACKAGE_WITH_UPDATER=0` داخل بسته است |
| ادغام رسمی Browser و Chrome | Upstream | مستقیم از بسته رسمی Linux استفاده می‌شود؛ legacy port layer وجود ندارد |
| تأیید Quit با focus صحیح | همیشه | patch سازگاری ضروری، confirmation بالادستی را روی Linux به window صحیح parent می‌کند |
| framework مربوط به Linux featureهای اختیاری | غیرفعال | با `make setup-native` تنظیم می‌شود |
| هویت متمایز دسکتاپ | همیشه | **ChatGPT Community** با آیکون `C` آبی و هویت بسته `codex-desktop` |

### Linux featureهای اختیاری

همه featureهای زیر به‌صورت پیش‌فرض غیرفعال‌اند. README کنار هر feature، نیازمندی‌ها، محدودیت‌های شناخته‌شده، configuration و testهای آن را توضیح می‌دهد.

| Feature ID | کاربرد | مستندات |
|---|---|---|
| `agent-workspace` | settings و bridge مربوط به Agent Workspace برای environmentهای پنهان دسکتاپ | [Docs](linux-features/agent-workspace/README.md) |
| `api-key-model-visibility` | نمایش modelهایی که providerهای compatible با authentication مبتنی بر API key گزارش می‌کنند | [Docs](linux-features/api-key-model-visibility/README.md) |
| `api-key-service-tier` | UI مربوط به Fast/service-tier برای sessionهای API-key compatible | [Docs](linux-features/api-key-service-tier/README.md) |
| `appshots` | capture و crop کردن window فعال Linux از composer | [Docs](linux-features/appshots/README.md) |
| `authored-message-visibility` | visible نگه‌داشتن پیام‌های assistant و user پس از collapse شدن tool activity | [Docs](linux-features/authored-message-visibility/README.md) |
| `authenticated-proxy` | پشتیبانی username/password برای HTTP proxy | [Docs](linux-features/authenticated-proxy/README.md) |
| `automation-extensions` | scheduleهای چندزمانه و expose زودهنگام `automation_update` | [Docs](linux-features/automation-extensions/README.md) |
| `browser-proxy` | انتقال تنظیمات صریح proxy به network helperهای Browser Use | [Docs](linux-features/browser-proxy/README.md) |
| `chronicle-skysight` | حافظه اختیاری فعالیت دسکتاپ Linux و ابزارهای محدود Skysight MCP | [Docs](linux-features/chronicle-skysight/README.md) |
| `codex-micro` | hotplug و policy مربوط به hidraw برای Work Louder Codex Micro با استفاده از `node-hid` بالادستی | [Docs](linux-features/codex-micro/README.md) |
| `community-profile-isolation` | جداکردن state مربوط به Codex/Electron نسخه Community و child CLI از ChatGPT رسمی | [Docs](linux-features/community-profile-isolation/README.md) |
| `computer-use-linux` | UI کنترل دسکتاپ Linux و backend native مبتنی بر MCP | [Docs](linux-features/computer-use-linux/README.md) |
| `copilot-reasoning-effort` | defaultهای persistent برای reasoning effort در sessionهای Copilot-auth | [Docs](linux-features/copilot-reasoning-effort/README.md) |
| `directory-only-working-tree-watch` | پایش bounded working tree با Watchbound | [Docs](linux-features/directory-only-working-tree-watch/README.md) |
| `filesystem-root-follow-ups` | اجازه follow-up در taskهای local موجود که root آن‌ها `/` است | [Docs](linux-features/filesystem-root-follow-ups/README.md) |
| `flatpak-chrome-native-messaging` | bridge کردن extension رسمی Chrome به Google Chrome نسخه Flatpak | [Docs](linux-features/flatpak-chrome-native-messaging/README.md) |
| `frameless-titlebar` | پنهان‌کردن دکمه‌های overlay رسمی Linux برای decoration مدیریت‌شده توسط compositor | [Docs](linux-features/frameless-titlebar/README.md) |
| `global-dictation` | global hotkeyهای dictation روی X11 و XDG portal | [Docs](linux-features/global-dictation/README.md) |
| `linux-performance-workarounds` | workaroundهای renderer که برای سیستم‌های تحت‌تأثیر اندازه‌گیری شده‌اند | [Docs](linux-features/linux-performance-workarounds/README.md) |
| `mcp-helper-reaper` | جمع‌کردن MCP helperهای orphan بدون دست‌زدن به sessionهای زنده | [Docs](linux-features/mcp-helper-reaper/README.md) |
| `model-picker-default-presets` | تنظیم pairهای مرتب model/effort پشت ChatGPT Default | [Docs](linux-features/model-picker-default-presets/README.md) |
| `node-repl-reaper` | جمع‌کردن helperهای Browser Use `node_repl` که پس از خروج owner باقی مانده‌اند | [Docs](linux-features/node-repl-reaper/README.md) |
| `omarchy-theme` | بارگذاری CSS تولیدشده از theme فعلی Omarchy | [Docs](linux-features/omarchy-theme/README.md) |
| `persistent-status-panel` | نگه‌داشتن panel مربوط به `/status` بین جابه‌جایی threadها و restartها | [Docs](linux-features/persistent-status-panel/README.md) |
| `pet-overlay` | placement و compositor hint برای avatar overlay روی Linux | [Docs](linux-features/pet-overlay/README.md) |
| `preferred-editor-file-links` | بازکردن source linkها با یک click ساده در editor انتخاب‌شده | [Docs](linux-features/preferred-editor-file-links/README.md) |
| `project-group-last-updated-sort` | اعمال ترتیب Last updated روی project groupها و taskها | [Docs](linux-features/project-group-last-updated-sort/README.md) |
| `project-task-sort` | بازگرداندن ترتیب Created برای taskهای جایگزین Projects | [Docs](linux-features/project-task-sort/README.md) |
| `read-aloud` | افزودن کنترل‌های read-aloud به پاسخ‌های assistant روی Linux | [Docs](linux-features/read-aloud/README.md) |
| `read-aloud-mcp` | اجازه به agent برای پخش صدا از backend مربوط به Linux Read Aloud | [Docs](linux-features/read-aloud-mcp/README.md) |
| `record-and-replay` | ضبط demonstration روی Linux و تبدیل آن به skill قابل استفاده مجدد | [Docs](linux-features/record-and-replay/README.md) |
| `remote-control-ui` | expose کردن تنظیمات آزمایشی remote-control روی Linux | [Docs](linux-features/remote-control-ui/README.md) |
| `remote-mobile-control` | flowهای آزمایشی remote-host و outbound-control روی Linux | [Docs](linux-features/remote-mobile-control/README.md) |
| `shallow-repository-watches` | جلوگیری از recursive walk روی main thread برای repository previewهای موقت | [Docs](linux-features/shallow-repository-watches/README.md) |
| `shared-app-server-socket` | اشتراک یک Unix app-server socket شفاف نسبت به protocol | [Docs](linux-features/shared-app-server-socket/README.md) |
| `thorium-chrome-plugin` | افزودن Thorium به ادغام bundled رسمی Chrome | [Docs](linux-features/thorium-chrome-plugin/README.md) |
| `tray-usage` | نمایش میزان usage باقی‌مانده در منوی system tray لینوکس | [Docs](linux-features/tray-usage/README.md) |
| `ui-tweaks` | تغییرات اختیاری ظاهری و تعاملی | [Docs](linux-features/ui-tweaks/README.md) |

backend اختیاری Computer Use، ابزار `guard-accessibility` را برای hold-open صریح GNOME accessibility در foreground فراهم می‌کند. این ابزار هیچ‌وقت خودکار اجرا نمی‌شود؛ [Linux Computer Use](docs/linux-computer-use.md) را ببینید.

وقتی `shared-app-server-socket` فعال است و Desktop در حال اجراست، با `codex-desktop --cli` می‌توانید Codex CLI را به app-server دسکتاپ متصل کنید. [Attached CLI](linux-features/shared-app-server-socket/README.md#attached-cli) را ببینید.

rolloutهای account و featureهای server-side مربوط به ChatGPT همچنان توسط OpenAI کنترل می‌شوند. build مجدد این پروژه rollout حساب کاربری را باز نمی‌کند.

## تنظیم featureهای اختیاری

editor پیشنهادی، setup wizard است:

```bash
make setup-native
```

برای configuration دستی، فایل نمونه را به فایل local و gitignored کپی کنید:

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

سپس دوباره build و install کنید:

```bash
make install-native
```

featureهای خصوصی می‌توانند زیر tree مربوط به `linux-features/local/<feature-id>/` قرار بگیرند که gitignored است و همان contract مربوط به manifest را استفاده می‌کند. IDهای retired شناخته‌شده برای migration configهای محلی قدیمی نادیده گرفته می‌شوند، اما IDهای ناشناخته و typoها همچنان error هستند. [README مربوط به feature framework](linux-features/README.md) و [معماری featureها](docs/linux-features-architecture.md) را ببینید.

## به‌روزرسانی‌ها

بسته‌های native به‌صورت پیش‌فرض `codex-update-manager` را شامل می‌شوند. سرویس user آن همان metadata امضاشده APT را poll می‌کند، بسته‌های رسمی را بر اساس version/architecture/SHA-256 cache می‌کند، بسته native انتخاب‌شده را با featureهای فعلی دوباره می‌سازد و پیش از promotion منتظر خروج برنامه می‌ماند. بسته مدیریت‌شده قبلی برای rollback نگه داشته می‌شود.

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

برای ساخت بسته manual-update بدون سرویس:

```bash
PACKAGE_WITH_UPDATER=0 make package
make install
```

AppImage و appهایی که فقط داخل repository ساخته شده‌اند updater مربوط به native package را ندارند. رفتار کامل و روش‌های recovery در [Updater](docs/updater.md) مستند شده‌اند.

## ساخت، بسته‌بندی و اجرا

```bash
# ساخت tree محلی برنامه و اجرا بدون نصب package
make build-app
make run-app

# ساخت و نصب package format تشخیص‌داده‌شده برای این distribution
make package
make install

# ساخت خروجی مشخص
make deb
make rpm
make pacman
make appimage
```

buildها تراکنشی‌اند: ابتدا candidate اعتبارسنجی می‌شود و بعد جای tree در حال کار را می‌گیرد. drift در featureهای ASAR فعال باعث رد candidate می‌شود؛ featureهای غیرفعال probe نمی‌شوند. package scriptها tree تولیدشده `codex-app/` را مصرف می‌کنند. برای prerequisites، متغیرها، layout خروجی، parallelism و بررسی payload به [Build and packaging](docs/build-and-packaging.md) مراجعه کنید.

## عیب‌یابی

| مشکل | اولین بررسی |
|---|---|
| اجرای ChatGPT رسمی و Community با هم تداخل دارد | تمام processهای `ChatGPT` را کامل ببندید؛ هر دو app به‌طور پیش‌فرض profile بالادستی را share می‌کنند |
| AppImage از Flatpak Chrome باز می‌شود ولی extension می‌گوید `Native transport disconnected` | `flatpak-chrome-native-messaging` را فعال کنید؛ [راهنمای Flatpak Chrome](docs/troubleshooting.md#appimage-opens-from-flatpak-chrome-but-the-extension-cannot-connect) را ببینید |
| ادغام Browser/Chrome پس از migration وصل نمی‌شود | ChatGPT و Chrome را کامل ببندید و repair محدود موجود در [Troubleshooting](docs/troubleshooting.md#browser-or-chrome-plugin-is-visible-but-cannot-connect) را انجام دهید |
| signature یا package verification شکست می‌خورد | bypass نکنید؛ زمان سیستم، شبکه، `gpgv`، architecture و فضای دیسک را بررسی کنید |
| برنامه launch نمی‌شود | `/opt/codex-desktop/start.sh --diagnose` را اجرا کنید |
| برنامه از XWayland استفاده می‌کند یا به Electron flag دائمی نیاز دارد | session تأییدشده Wayland به‌صورت خودکار native backend را انتخاب می‌کند؛ با `CODEX_OZONE_PLATFORM=x11\|wayland` backend را pin کنید یا در `~/.config/codex-desktop/electron-flags.conf` هر flag را در یک خط بگذارید، مثلاً `--ozone-platform=x11` |
| AppImage خطای sandbox می‌دهد | user namespaces را فعال کنید یا بسته native نصب کنید؛ `--no-sandbox` خودکار اضافه نمی‌شود |
| feature فعال پس از release جدید upstream دچار drift می‌شود | feature را غیرفعال کنید تا baseline تمیز تأیید شود و patch report آن را به issue پیوست کنید |
| updater منتظر خروج برنامه است | processهای رسمی و Community را ببندید و `codex-update-manager status --json` را بررسی کنید |
| `codex-app.backup-*` قدیمی خطای permission می‌دهد | دقیقاً همان path را بررسی کنید و روش backup با مالکیت root در Troubleshooting را دنبال کنید؛ wildcard را کورکورانه حذف نکنید |

راهنمای کامل: [Troubleshooting](docs/troubleshooting.md).

## مستندات پروژه

- شروع کار: [Native setup](docs/native-setup.md)، [Build and packaging](docs/build-and-packaging.md)، [Nix](docs/nix.md)، [Raspberry Pi 5](docs/raspberry-pi-5.md)
- runtime و نگهداری: [Architecture](docs/architecture.md)، [Updater](docs/updater.md)، [Troubleshooting](docs/troubleshooting.md)
- extensionها: [Feature framework](linux-features/README.md)، [Feature architecture](docs/linux-features-architecture.md)، [Linux Computer Use](docs/linux-computer-use.md)، [Record and Replay](docs/record-and-replay-linux.md)، [Chronicle / Skysight](docs/linux-chronicle-skysight.md)
- مشارکت‌کنندگان: [Contributing](CONTRIBUTING.md)، [Agent instructions](AGENTS.md)، [Repository map](docs/agents/repository-map.md)، [Validation playbook](docs/agents/validation-playbook.md)، [Generated/runtime notes](docs/agents/generated-and-runtime-notes.md)
- عملیات پروژه: [GitHub CLI auth](docs/github-cli-auth.md)، [Label governance](docs/label-governance.md)

مستندات قدیمی مربوط به تبدیل DMG در macOS، جایگزینی Electron دانلودشده، rebuild ماژول native، local webview server و custom warm-start عمداً جزو مستندات فعال نیستند؛ بسته رسمی Linux اکنون مسئول این بخش‌های runtime است.

## سلب مسئولیت

این پروژه یک پروژه غیررسمی جامعه‌محور است و وابستگی سازمانی به OpenAI ندارد.

ChatGPT، سرویس‌های OpenAI، علائم تجاری، کد و باینری‌های برنامه بالادستی و assetهای مربوطه متعلق به OpenAI یا صاحبان قانونی آن‌ها هستند.

این repository payload رسمی Linux را به‌صورت محلی دانلود و دوباره بسته‌بندی می‌کند و هیچ حقی نسبت به نرم‌افزار یا سرویس‌های OpenAI اعطا نمی‌کند. استفاده از ChatGPT همچنان تابع شرایط قابل‌اعمال OpenAI و availability featureهای server-side است.

مجوز MIT فقط برای source مربوط به wrapper این repository، packaging، documentation و extensionهای متعلق به community اعمال می‌شود.

## مجوز

[MIT](LICENSE)
