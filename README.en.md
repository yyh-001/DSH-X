<p align="center">
  <img src="docs/hero-en.png" alt="DSH-X" width="880" />
</p>

<p align="center">
  A <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> launcher —<br />
  launch entries and multiple instances, version, plugin, instance, remote & mobile access, MCP and skill management.
</p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/-Windows-0078D6?style=flat-square" />
  <img alt="macOS" src="https://img.shields.io/badge/-macOS-000000?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Linux" src="https://img.shields.io/badge/-Linux-FCC624?style=flat-square&logo=linux&logoColor=black" />
</p>

<p align="center">
  <a href="https://github.com/yyh-001/DSH-X/releases">
    <img src="https://img.shields.io/github/v/release/yyh-001/DSH-X?label=Release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/badge/license-MIT-4D6BFE" alt="License" />
  <br>
  <img src="https://img.shields.io/github/downloads/yyh-001/DSH-X/total?label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/yyh-001/DSH-X?label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/contributors/yyh-001/DSH-X?label=contributors&color=4D6BFE" alt="Contributors" />
</p>

<p align="center">
  <samp><a href="https://yyh-001.github.io/DSH-X/">Website</a> · <a href="https://github.com/yyh-001/DSH-X/releases/latest">Download</a> · <a href="docs/releases">Changelog</a> · <a href="CONTRIBUTING.en.md">Contributing</a> · <strong>English</strong> · <a href="README.md">中文</a></samp>
</p>

> [!IMPORTANT]
> **DSH-X starts DeepSeek Harness's own web page.**
> It only handles version installation, launching and plugin management and never modifies or rewrites DSH's web UI. DSH-X is a community project, not an official DeepSeek product.

## Features

- 🚀 **Launch entries and multiple instances** — choose a user directory, profile, version and port per entry; start concurrently and add entries while DSH runs.
- 📦 **Version management** — detect, install, remove and clean up dsh versions; pin a version per entry and inspect disk usage.
- 🧩 **Plugins and instances** — instances lock a DSH version and plugins, import/export `.dspack`, follow upstream updates, and support one-click market install.
- 🌐 **WSL and SSH remotes** — launch entries can run on WSL or SSH hosts with `dsh-x-core` auto-installed and pages opened through a local tunnel.
- 📱 **Mobile remote access** — QR pairing and device management with built-in Cloudflare Tunnel to view logs, start/stop, and open DSH instances from your phone.
- 🔍 **Startup troubleshooting** — raw log / time breakdown / disk usage tabs, startup time and dependencies grouped per plugin, and a red log icon on plugin errors.
- 🔄 **Updates and recovery** — self-update, recovery, profile backups and rollback.
- 🛠️ **MCP, skills and desktop enhancements** — built-in MCP and Skills markets, `dsh-x-computer-use` enabled by default, plus first-party native notifications and sidebar browser plugins.

## Getting Started

Download the installer for your OS from [Releases](https://github.com/yyh-001/DSH-X/releases/latest):

| Platform | Installer | Notes & First Launch |
| --- | --- | --- |
| **Windows** (10+ x64) | `DSH-X-<version>-win-x64.exe` | Install and launch **DSH-X**. Not Authenticode-signed yet; if SmartScreen prompts, verify SHA256 or report false positives to [Microsoft](https://www.microsoft.com/en-us/wdsi/filesubmission). |
| **macOS** (13+) | `DSH-X-<version>-mac-arm64.dmg`<br>`DSH-X-<version>-mac-x64.dmg` | Drag into Applications. Ad-hoc signed and unnotarized; right-click Open or run:<br>`xattr -dr com.apple.quarantine /Applications/DSH-X.app`. Shell auto-update is currently disabled (home page prompts on new builds); core updates still come from npm. |
| **Linux** (x64 / arm64) | `DSH-X-<version>-linux-<arch>.AppImage`<br>`DSH-X-<version>-linux-<arch>.deb` | Make AppImage executable and run (pass `--appimage-extract-and-run` without FUSE), or install deb via `sudo apt install ./DSH-X-<version>-linux-<arch>.deb` (no shell auto-update; home page prompts on new builds). Settings live in `~/.config/DSH`. |

> [!NOTE]
> The installer bundles **only the Electron shell**, not the core. On first launch it fetches `dsh-x-core` for your channel from npm with live progress. Core and shell update independently so UI/backend updates avoid re-downloading 100MB+ installers.

<details>
<summary>Verify downloaded SHA256 checksum</summary>

```sh
certutil -hashfile DSH-X-<version>-win-x64.exe SHA256     # Windows
shasum -a 256 DSH-X-<version>-mac-arm64.dmg              # macOS
sha256sum DSH-X-<version>-linux-x64.AppImage             # Linux
```

</details>

## Screenshots

<p align="center">
  <img src="docs/screenshots/screenshot-launches.png" alt="DSH-X Multiple Launch Entries (Dark)" width="820" />
</p>

<p align="center">
  <img src="docs/screenshots/screenshot-tabs.png" alt="DSH-X Multi-Tab View (Dark)" width="820" />
</p>

<details>
<summary>Management Pages · Dark Theme (expand to view)</summary>

<p align="center"><img src="docs/screenshots/screenshot-profiles-dark-en.jpg" alt="Dark Profiles" width="820" /></p>
<p align="center"><img src="docs/screenshots/screenshot-plugins-dark-en.jpg" alt="Dark Plugin Management" width="820" /></p>
<p align="center"><img src="docs/screenshots/screenshot-settings-dark-en.jpg" alt="Dark General Settings" width="820" /></p>
<p align="center"><img src="docs/screenshots/screenshot-remote-dark-en.jpg" alt="Dark Remote & Mobile Access" width="820" /></p>

</details>

<details>
<summary>Management Pages · Light Theme (expand to view)</summary>

<p align="center"><img src="docs/screenshots/screenshot-home-en.jpg" alt="Light Home" width="820" /></p>
<p align="center"><img src="docs/screenshots/screenshot-profiles-en.jpg" alt="Light Profiles" width="820" /></p>
<p align="center"><img src="docs/screenshots/screenshot-plugins-en.jpg" alt="Light Plugin Management" width="820" /></p>
<p align="center"><img src="docs/screenshots/screenshot-settings-en.jpg" alt="Light General Settings" width="820" /></p>
<p align="center"><img src="docs/screenshots/screenshot-remote-en.jpg" alt="Light Remote & Mobile Access" width="820" /></p>

</details>

<details>
<summary>Mobile Web Console (expand to view)</summary>

<p align="center">
  <img src="docs/screenshots/screenshot-mobile-dark-en.jpg" alt="Mobile Web Console (Dark)" width="280" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/screenshot-mobile-en.jpg" alt="Mobile Web Console (Light)" width="280" />
</p>

</details>

## Usage Overview

### Isolation Modes

Choose an isolation level when adding a launch entry (user and version directories are prevented from living inside the launcher installation folder):

| Mode | Created In | Scope |
| --- | --- | --- |
| **Plugin isolation (default)** | A new profile in the global `dsh` directory | Shares sessions, memories & skills; plugins and config separate |
| **Session isolation** | Isolated home under `homes/<name>` in data dir | Everything isolated: sessions, memories, skills & plugins |
| **Custom** | Custom user directory, profile & port | Pick local paths, WSL/SSH targets, or toggle `DSH_HOME` env var |

### Key Workflows

- **Instances & Built-in Recipes**: Manage plugins per instance using the [DSH-PackForge](https://github.com/DSH-PackForge/DSH-PackForge) `.dspack` v5 format; includes built-in [Recommended](src/packs/dsh-x-recommended/manifest.json) and [Desktop Workbench](src/packs/dsh-x-workbench/README.md) recipes (`node scripts/make-pack.mjs` builds `.dspack` archives).
- **Opening Modes & Mobile Access**: Switch between internal tabs, standalone windows, or system browser; the manager defaults to port `3780`, with one-click QR pairing and Cloudflare Tunnel in **Remote → Mobile Access** (PWA install on permanent HTTPS domains) or LAN binding under Settings → Advanced.
- **Backups & Rollback**: Automatic config-layer snapshots are saved before every launch so you can roll back and reinstall dependencies in one click.

## Wallpaper

Companion Wallpaper Engine project — [DSH-X · 大肥鱼桌面终端](https://steamcommunity.com/sharedfiles/filedetails/?id=3814706575): brand intro, mascot animation, clock, and audio spectrum with automatic light/dark palette switching. Sources live in [`wallpaper/`](wallpaper/); run `node scripts/export-wallpaper.mjs` to export.

<details>
<summary>Preview wallpaper</summary>

<p align="center">
  <img src="wallpaper/preview.jpg" alt="DSH-X Wallpaper" width="820" />
</p>

</details>

## Development & Packaging

Requires **Node.js 22.18+**. The backend and web UI have **zero third-party runtime dependencies**; install dev dependencies (`npm install`) before running the Electron shell or building installers.

| Command | Purpose |
| --- | --- |
| `npm start` | Launch manager server and UI |
| `npm test` | Run offline test suite (`node --test`) |
| `npm run electron` | Run Electron desktop shell from source |
| `npm run dist` | Build `electron-builder` installer for current OS |

See [CONTRIBUTING.en.md](CONTRIBUTING.en.md) for development, commit, and release conventions; verify release manifests with `node scripts/release-manifest.mjs verify` (keep `release/release-key.pem` backed up locally).

## Community & Related Projects

- **QQ Groups**: Main [993579665](https://qm.qq.com/q/7AD2g70HqS) · Plugins #2 [Join](https://qm.qq.com/q/hCjdOJOjSw)
- **Changelog & Security**: [Release Notes](docs/releases) · [Security Policy](SECURITY.md)
- **Ecosystem**: [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (upstream agent platform) · [DSH-PackForge](https://github.com/DSH-PackForge/DSH-PackForge) (`.dspack` tooling) · [deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) (Tauri desktop app)

> [!NOTE]
> Upstream dsh and its plugin ecosystem iterate rapidly; check plugin compatibility before upgrading, and run dsh only in trusted environments since it can execute local code.

<p align="center">
  <a href="LICENSE">MIT License</a> © 2026 yyh
</p>
