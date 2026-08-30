# AGENTS.md

Obsidian plugin (`cloud-webdav-sync`, `isDesktopOnly: false`) that syncs notes/attachments through WebDAV using content-addressed storage: immutable SHA-256 blobs, validated commits, file trees, and a capability-gated remote HEAD update. Version 0.9.9 defaults to **planning-only mode**; real sync must be enabled in settings.

## Commands

```bash
npm install
npm run check      # test + typecheck + node --check esbuild.config.mjs — run before finishing any change
npm run test       # tsx --test tests/**/*.test.ts (node:test, NOT Jest/Vitest)
npm run typecheck  # tsc --noEmit
npm run build      # esbuild production bundle -> main.js at repo root
npm run dev        # esbuild watch with inline sourcemaps
```

Real-server scripts (require `WEBDAV_URL`, `WEBDAV_USERNAME`, `WEBDAV_PASSWORD` env vars, optionally a `.env`):

```bash
npm run smoke:webdav           # end-to-end sync against a real server
npm run probe:webdav-primitives # raw capability probes (OPTIONS, ETag CAS, MOVE locking)
```

There is no ESLint/Prettier; `tsc --strict` is the lint. Test files mirror `src/`: `tests/<module>/<file>.test.ts`.

## Architecture

One directory per module, each exporting through an `index.ts` barrel. Imports are relative and go through barrels (e.g. `../repository`), no path aliases.

- `src/core/` — sync state machine (`SyncStateMachine`)
- `src/sync/` — `RepositorySyncEngine`, `ChangeQueue` (coalesces vault events), `SingleFlightSyncScheduler` (no overlapping syncs)
- `src/repository/` — `ContentAddressedRepository`: blobs/commits/trees, HEAD lock (`refs/head.lock`), CAS (`If-Match`/`If-None-Match`) vs. MOVE-lock strategy chosen by server capabilities
- `src/planning/` — three-way tree planner (BASE/LOCAL/REMOTE); `src/merge/` — Markdown diff3 merge
- `src/webdav/` — `WebDavClient`, transport interface, capability probing, URL/auth parsing
- `src/logging/` — bounded memory log, history, redaction
- `src/settings/` — settings model, persisted session data, settings tab
- `src/ui/` — sync center + conflict resolver modals; decision logic lives in `*-model.ts` (obsidian-free) so it stays testable
- `src/vault/` — `ObsidianWorkspace` adapter bridging the vault to sync interfaces
- `src/main.ts` — plugin lifecycle; wires all modules together (~870 lines, the composition root)

**Hard boundary:** only these files may `import "obsidian"` — `main.ts`, `settings/settings-tab.ts`, `ui/sync-center-modal.ts`, `ui/conflict-resolver-modal.ts`, `vault/obsidian-workspace.ts`, `webdav/obsidian-transport.ts`. Everything else must stay pure TypeScript so it runs under node:test. Keep Obsidian-specific logic in adapters and pass interfaces (`WebDavTransport`, `LocalWorkspace`) instead.

## Conventions & gotchas

- Strict TS with `verbatimModuleSyntax` (use `import type` for type-only imports) and `noUncheckedIndexedAccess` (array/object index access yields `T | undefined`).
- Never log credentials, tokens, or note contents. Logging goes through `src/logging/` helpers that redact recursively; conflict bodies are kept in memory only and excluded from diagnostics.
- The WebDAV password is stored via Obsidian `SecretStorage` (`PASSWORD_SECRET_ID`), never in plugin `data.json`.
- Force recovery (`RepositorySyncEngine.forceSync(state, "push-local" | "pull-remote")`) intentionally bypasses mass-delete protection and history-divergence checks; it is only reachable through the sync center's confirmation-guarded buttons (`forcePushLocal`/`forcePullRemote` on the plugin). Keep that gate.
- Mobile is supported: no desktop-only APIs outside the status bar; mobile reduces transfer concurrency (`Platform.isMobile` checks in `main.ts`). Styles use Obsidian CSS variables (`--background-secondary`, etc.) for dark/light theming, not hardcoded colors.
- Remote behavior depends on probed server capabilities, not assumptions — the client picks CAS or MOVE-lock HEAD updates and conditional creates based on the probe. Don't bypass capability checks; see recent HEAD-lock work in `repository.ts`.
- Deletes move files to `.trash`; binary conflicts become deterministic `.conflict-<device>-<commit>` copies; Markdown conflicts block the commit until resolved.
- Version bumps touch three files together: `manifest.json`, `package.json`, and `versions.json` (maps version → min Obsidian version). Releases are triggered by a tag that must exactly match `manifest.json`'s version with no `v` prefix (e.g. `0.9.9`); CI enforces this.
- `main.js` is a gitignored build artifact. To test manually, copy/link `main.js`, `manifest.json`, `styles.css` into a `cloud-webdav-sync` plugin folder in a test vault.
- Read `docs/conflict-resolver-and-sync-center-plan.md` (in Chinese) before touching the conflict/sync-center UI — it records the UX decisions and known-unverified items.
