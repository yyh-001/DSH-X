# dsh-x-sync

Sync dsh data to S3-compatible storage / WebDAV / a local folder / a single ZIP — **sharing the same bucket and layout as the DSH-X launcher**.

[中文](README.md) · [DSH-X launcher](https://github.com/yyh-001/DSH-X)

## What it does

- **Syncs**: chat sessions, attachments, plugin config (this profile's manifest and patch layer), skills and memory — each with its own toggle.
- **Four remotes**: S3-compatible object storage (AWS / R2 / MinIO / Aliyun OSS / Tencent COS…), WebDAV (Jianguo Cloud / Nextcloud / Synology / Alist…), a local folder (export / import), or a single ZIP file (export / import).
- **Merges instead of overwriting**: only adds and updates, never propagates deletions; the plugin manifest is merged as a **union in both directions** (higher version wins), so neither machine loses a plugin — and dependencies are reinstalled after a pull.
- **Two ways to drive it**: a panel inside dsh's settings, or just tell the agent to “sync now” — the `sync_status` / `sync_now` tools.

It **shares one bucket with the DSH-X launcher**: the layout is fixed at `dsh-x/v1/…`, so the launcher (the tool that still works when dsh refuses to start) and this plugin can be used interchangeably against the same data.

## Install

```sh
dsh plugin --profile web add dsh-x-sync     # or a local path: dsh plugin add file:D:\path\to\dsh-x-sync
```

Restart dsh; a “Sync” section appears in settings.

## Configuration

Fill it in from the panel, or edit `dsh-x-sync.json` in the current profile directory (secrets are stored in plain text there, like other plugins; they never reach session logs, and the agent tools deliberately **refuse** to take secrets as arguments):

```json
{
  "store": "s3",
  "s3": { "endpoint": "https://s3.us-east-1.amazonaws.com", "region": "us-east-1", "bucket": "my-bucket", "accessKeyId": "…", "secretAccessKey": "…" },
  "scopes": ["sessions", "attachments", "plugins"],
  "policy": "skip"
}
```

`store` can also be `webdav` / `folder` / `zip`, each with its own settings block, kept side by side so switching back and forth loses nothing. `policy` decides what happens when both sides have a file with different content: `skip` (keep local, the default) / `overwrite` (take the remote copy) / `duplicate` (keep both, saving the remote one as `.remote-date`).

## How it splits work with the launcher

| | Plugin (this) | DSH-X launcher |
|---|---|---|
| Runs in | the dsh process | outside it |
| When dsh won't start | unusable | **works** — that is what it is for |
| Driven by | settings panel / agent tools | the manager page |
| Data | same bucket, same layout, same merge rules | same |

## Development

```sh
npm test              # host side: config, tools, a real run against a fake S3, client bundle registration
npm run sync-engine   # re-copy the engine from the DSH-X repo (default ../strategies; override with DSH_X_REPO)
```

The engine (`lib/engine/`) is three zero-dependency files copied from the DSH-X repo — **do not edit them here**: change them there and re-run `npm run sync-engine`.

## License

MIT
