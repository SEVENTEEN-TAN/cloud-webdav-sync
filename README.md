# Cloud WebDAV Sync

[中文说明](README.zh-CN.md)

Cloud WebDAV Sync is an experimental sync plugin that stores notes and attachments in a WebDAV-backed repository. It uses content-addressed objects, validated commit snapshots, server capability checks, conflict detection, and a conflict resolution workspace to reduce accidental overwrites.

Version `0.9.9` still defaults to planning-only mode. Real sync must be explicitly enabled in settings. When enabled, the plugin does not overwrite a plain remote folder file by file. Instead, it writes immutable SHA-256 blobs, verified commits, complete file trees, and a remote HEAD update strategy selected from the WebDAV server's detected capabilities.

## Features

- Ribbon command for running a manual sync check.
- Command palette actions for checking sync, opening the sync center, and rescanning the vault.
- Automatic checks while the app is running, including startup, foreground resume, local file changes, and configurable remote polling.
- Cached WebDAV capability reports that are invalidated when the URL, remote folder, username, or password changes.
- Single-flight scheduling so full sync jobs do not overlap.
- Local change queue coalescing for create, modify, delete, and rename events.
- Desktop status bar state and a cross-platform sync center.
- Sync center sections for overview, pending changes, history, logs, and server capabilities.
- Conflict workflow for switching between files, filtering unresolved items, and choosing the local or remote version.
- Markdown conflict preview with line numbers, local/remote comparison, diff highlighting, and synchronized scrolling.
- Bounded in-memory logs with recursive credential and token redaction.
- Password storage through the app's SecretStorage API instead of plugin `data.json`.
- WebDAV capability probes for OPTIONS, conditional create, exclusive MKCOL, atomic MOVE/no-overwrite behavior, ETag reads through HEAD/PROPFIND, stale ETag rejection, and cleanup verification.
- First-device push to an empty repository and empty-device pull from an existing repository.
- Two-way planning from BASE, LOCAL, and REMOTE file trees.
- Three-way Markdown merge for non-overlapping edits without writing conflict markers into notes.
- Deterministic conflict copies for concurrently modified binary files.
- Bounded hashing, upload, and download concurrency; small files may be packed into content-addressed pack files to reduce WebDAV request counts.
- Repository identity checks, commit/blob integrity validation, and large-delete protection.
- Safe handling for file-to-folder and folder-to-file path shape changes.

## Safety Model

Real sync is disabled by default. In planning-only mode, the connection test creates a randomly named temporary collection inside the configured remote folder and removes it in a `finally` cleanup path.

When real sync is enabled, remote data is stored as immutable repository objects. Remote deletes are applied locally by moving files to `.trash`. Markdown conflicts stop the current commit and keep both sides in the repository until the user chooses a version. Binary conflicts preserve the local file and save the remote side as a deterministic `.conflict-<device>-<commit>` copy.

Remote HEAD updates are guarded by server capability checks. Servers with correct conditional ETag behavior can use compare-and-swap updates. Servers that do not support that pattern can use an actively probed atomic MOVE/no-overwrite lease strategy.

## Development

```bash
npm install
npm run check
npm run build
```

After building, copy or link `main.js`, `manifest.json`, and `styles.css` into a plugin folder named `cloud-webdav-sync` inside your test vault.

## Release

The `Build release package` GitHub Actions workflow can be triggered manually or by pushing a tag that exactly matches `manifest.json`'s version. For version `0.9.9`, use tag `0.9.9`, not `v0.9.9`.

The workflow runs `npm ci` and `npm run build`, then uploads `main.js`, `manifest.json`, and `styles.css` directly as GitHub Release assets.

## Source Layout

```text
src/core/       Sync state machine
src/sync/       Scheduling and local change queue
src/logging/    Bounded redacted diagnostics
src/webdav/     Transport and capability probing
src/settings/   Settings model and settings tab
src/ui/         Sync center and conflict UI
src/main.ts     Plugin lifecycle integration
tests/          Unit and integration tests
```

## Limitations

- Automatic checks only run while the app is running.
- The app request API returns complete responses and does not support streaming progress or `AbortSignal`.
- The status bar is desktop-only. Mobile uses ribbon actions, commands, notices, and the sync center.
- The default transfer concurrency limit is 16; mobile runtime paths reduce it further.
- First sync stops when the local vault and existing remote repository both contain unrelated files unless the user explicitly chooses an initial policy.
- The conflict workflow supports local/remote selection, but does not yet provide a full manual merge editor.
- Repository history exists as commits, but history browsing, rollback UI, garbage collection, and large-file chunking are not implemented yet.
- Compatibility has been tested against real cloud WebDAV servers and Windows filesystem integration paths, but broader WebDAV server and mobile-device coverage still needs more validation.

## License

MIT License. See [LICENSE](LICENSE).
