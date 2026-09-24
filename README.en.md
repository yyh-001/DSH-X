<p align="center">
  <img src="docs/hero.png" alt="DSH-X" width="880" />
</p>

<p align="center">
  <a href="https://yyh-001.github.io/DSH-X/">Website</a>
  ·
  <a href="https://github.com/yyh-001/DSH-X/releases/latest/download/DSH-Setup.exe">Download</a>
  ·
  <a href="https://github.com/yyh-001/DSH-X">Star</a>
  ·
  <a href="README.md">中文</a>
</p>

A lightweight launcher for DeepSeek Harness. Pick a version, start DSH Web in your system browser.

> [!IMPORTANT]
> **DSH-X starts DeepSeek Harness's own web page, not a desktop app.**  
> It only handles version installation, launching and plugin management: no embedded WebView, and no changes to DSH's web UI. DSH-X is a community project, not an official DeepSeek product.

## Features

- **Pick a version and go**: start / stop / restart / update / uninstall
- **macOS support**: a native `.app` and dmg installers (one for Apple Silicon, one for Intel); self-update, launch at login and the folder picker all use the system's own mechanisms
- **Plugins page**: list installed plugins and toggle each with one click, check for and install updates (one or all), and switch profiles
- **Compatibility mode**: on a failed start, disable the plugins named in the error (one click to restore); after boot it checks the client plugin bundles the page references and reports the verdict, telling a broken install apart from a stale tab
- **Dark appearance**: follow the system or pick a theme, plus floating-panel transparency and mascot switches
- **Faster startup**: equivalent fast implementations at the bundle composition point (saves about 1–2 s), skipped automatically once dsh changes underneath
- **Plugins stay where dsh puts them**: data lives in `~/.dsh`, so switching versions needs no plugin reinstall
- **Keeps one older version**: only the newest and the most recently installed are kept (enough to roll back); older ones are pruned after install
- **Resident in the background**: closing the page does not quit (Windows tray / macOS menu bar icon); the UI uses your system browser
- **Bundled Node / npm / pnpm**: a portable runtime ships inside the package, packages come from the npmmirror registry, and plugin installs need nothing from the host
- **One version at a time**: no two versions fighting over ports and data
- **Optional marketplace**: can install `dshmarket` on first launch

Feedback: **QQ group [993579665](https://qm.qq.com/q/7AD2g70HqS)**

## Screenshots

<p align="center">
  <img src="docs/screenshot-home.png" alt="DSH-X control page" width="820" />
</p>

<p align="center">
  <img src="docs/screenshot-plugins.png" alt="DSH-X plugins page" width="820" />
</p>

<p align="center">
  <img src="docs/screenshot-settings.png" alt="DSH-X settings page" width="820" />
</p>

## Antivirus false positives

The launcher is not code signed, and some of what it does looks like a downloader to heuristics: it spawns `cmd` / `powershell` to open links, can write an autostart entry, ships its own Node runtime, and downloads an installer when updating itself. That occasionally gets it flagged by Windows Defender or another antivirus.

If that happens:

- Check the antivirus history to see exactly what was blocked;
- Add the install directory (default `%LOCALAPPDATA%\Programs\DSH`) to its exclusions to get running again;
- Report the false positive to Microsoft at <https://www.microsoft.com/en-us/wdsi/filesubmission> (choose "software developer", upload `DSH-Setup.exe`); such reports are usually reverted within a day or two;
- Other vendors (360, Huorong, …) have their own false-positive forms;
- A SmartScreen "unknown publisher" prompt after downloading is expected without code signing — click "Run anyway".

## Usage

Install [DSH-Setup.exe](https://github.com/yyh-001/DSH-X/releases/latest) on Windows, then open **DSH-X** from the desktop.

On macOS, open `DSH-X-mac-arm64.dmg` (Apple Silicon) or `DSH-X-mac-x64.dmg` (Intel) and drag **DSH-X** into Applications. The app is not notarized, so the first launch is blocked: right-click it and choose **Open**, or allow it under System Settings → Privacy & Security. Settings and logs live in `~/Library/Application Support/DSH`. Self-update only works when the app is in a folder you can write to (e.g. Applications).

Both the manager page and DSH's own web page open in your default browser. The manager defaults to `http://127.0.0.1:3780/` (the port can be changed on the settings page; restart the launcher to apply it).

dsh's web UI binds to this machine only (`127.0.0.1`) by default. To let a phone or another computer reach it: settings page → Advanced → **Web binding** → pick "LAN (0.0.0.0)"; it applies the next time dsh starts. When the remote-access plugin's LAN switch is on, the launcher treats it as LAN too (it stops injecting `--host`).

**Verifying a download (optional)**: put every file from that release (the installer, `dsh-x-<version>.spdx.json`, `release-manifest.json`, `release-manifest.sig`) in one directory and run `node scripts/release-manifest.mjs verify <that-directory>` (the script ships in this repository). It checks the signature and every sha256 and size; a missing file or a mismatch is reported. The public key fingerprint (SPKI/DER SHA-256) is `0699e51d0a98acaa5d1942afb7510010cb7864754f05746f5038cc35c9b42d99`; recompute it with `openssl pkey -pubin -in scripts/release-pubkey.pem -outform DER | openssl dgst -sha256`. (The manifest covers the Windows installer only so far — the dmg can't be checked yet.)

## Development

Needs Node.js 22.18+ locally (official DSH: `^22.19.0 || >=24`).

```sh
npm install
npm start
```

Web page only: `npm run server`.

## Packaging

Needs Rust and Inno Setup 6 (it will try to download them).

```sh
npm run dist
```

- `release/DSH/`: portable directory
- `release/DSH-Setup.exe`: installer (defaults to `%LOCALAPPDATA%\Programs\DSH`)

On macOS the same command needs only Rust and the Xcode command line tools, and produces:

- `release/DSH-X.app`: the app bundle (ad-hoc signed)
- `release/DSH-X-mac-<arch>.dmg`: the release asset self-update downloads; upload one per architecture (`DSH_MAC_ARCH=x64 npm run dist` for Intel, after `rustup target add x86_64-apple-darwin`)

On Windows the build also emits three files for self-checking (**none of them are uploaded to the release** — the release page carries the installers and the dmgs): `release/dsh-x-<version>.spdx.json` (an SBOM, SPDX 2.3), `release/release-manifest.json` (the release manifest: version, commit, whether the build is tagged, artifact hashes) and, when a private key is present, `release/release-manifest.sig` (Ed25519).

Before publishing, run the consistency gate and upload the installer and the dmgs:

```sh
node scripts/release-manifest.mjs check-tag v0.1.14   # tag must match the version in package.json
node scripts/release-manifest.mjs verify              # signature valid + every artifact hash matches
gh release create v0.1.14 release/DSH-Setup.exe \
  release/mac/DSH-X-mac-arm64.dmg release/mac/DSH-X-mac-x64.dmg --latest
```

Signing needs a key once: `node scripts/release-manifest.mjs keygen` writes the private key to `release/release-key.pem` (git-ignored, **back it up**), and the public key ships in this repository as `scripts/release-pubkey.pem`. When you have a manifest and signature in hand (your own build, or a set from elsewhere), put the installer, `release-manifest.json` and `release-manifest.sig` in one directory and run:

```sh
node scripts/release-manifest.mjs verify <that-directory>
```
