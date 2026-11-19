# AGENTS.md

## Rule quan trọng.
1. Always address the user as "ck" and refer to yourself as "vk".
2. Always explain the issue first, and only make any changes after receiving explicit approval (Exception: if ck's prompt contains "llrs" — "làm luôn review sau" — execute the changes immediately without waiting for approval).
3. Luôn cập nhật docs và code song song.  

## Repo overview
- pnpm monorepo (`pnpm-workspace.yaml`), Node/TS (ESM). Main packages:
  - `packages/shared` (`@foldersync/shared`): sync domain types + `list-file.md`/zones registry codec (`list-file-codec.ts`) and diff logic. Built to `dist/` and consumed by other packages.
  - `packages/desktop-agent` (`@foldersync/desktop-agent`): core PC agent/server (HTTP+WS), Google Drive/Telegram integration, folder watching/indexing, and sync orchestration. Serves static Web UI from `packages/web-ui/dist` when present.
  - `packages/web-ui` (`@foldersync/web-ui`): React/Vite dashboard (port 8384 via agent). Also hosts **Android dev simulator** via `vite.mobile.config.ts` + mobile dev-fs middleware on port 8390.
  - `packages/mobile-app` (`@foldersync/mobile-app`): Expo/React Native (SDK 58) app with separate Android sync engine (`src/services/android-sync-engine.ts`) and platform storage adapters (`src/storage/platform-fs.ts`, SAF on native, `/__mobile_dev_fs/*` shim in web-sim).
- Canonical architecture/behavior docs: `docs/system-architecture.md`, `docs/implementation_plan.md`, phase docs in `docs/`.

## Commands (verified)
- Install: `pnpm install`
- Build all (order matters): `pnpm build` → builds `shared`, then `web-ui`, then `desktop-agent`, then `mobile-app` (`mobile-app` build = `tsc --noEmit`).
- Run desktop agent (serves API + built Web UI): `pnpm start` (or `pnpm --filter @foldersync/desktop-agent start` after build). Dev: `pnpm dev`.
- Second local PC node for multi-device testing: `pnpm dev:node2` (default port 8385, separate config at `~/.foldersync/desktop-agent-node2/config.json`, sync dir `/tmp/foldersync-pc-node2` unless env overridden).
- Mobile web simulator (runs `packages/mobile-app/App.tsx` in browser, uses local FS shim): `pnpm dev:mobile` → http://localhost:8390. Real Android dev client: `npx --yes expo@58.0.23 start --dir packages/mobile-app --lan`.
- Tests (all): `pnpm test` (`pnpm -r test`; `web-ui`/`mobile-app` scripts are placeholders that echo, so real tests are in `shared` and `desktop-agent`).
- Focused tests: `pnpm --filter @foldersync/shared test`, `pnpm --filter @foldersync/desktop-agent test`, or run a single file with Vitest from package dir, e.g. `pnpm --filter @foldersync/desktop-agent exec vitest run test/sync-coordinator.test.ts`.

## Important quirks / gotchas
- **Shared is a built dependency** (`exports` point to `dist/`). After changing `packages/shared/src/*`, rebuild shared (`pnpm --filter @foldersync/shared build`) so other packages’ typechecks/builds/tests see updates.
- **Web UI served from `packages/web-ui/dist`** by desktop-agent. Source changes in `packages/web-ui/src` require `pnpm --filter @foldersync/web-ui build` to take effect in the agent-hosted UI (dev servers are separate).
- **`list-file.md` is the sync contract** (parsed/serialized in `packages/shared/src/list-file-codec.ts`); keep codec, diff semantics, and coordinator/indexer behavior consistent across desktop and mobile engines.
- **Core sync behavior lives in desktop-agent**: `services/sync-coordinator.ts` (sync cycles, Drive/relay/tombstone/conflict/progress), `services/file-indexer.ts` (scan/hash/local list-file), `services/folder-watcher.ts` (chokidar + debounce + anti-loop write locks), `services/cloud-storage.ts`/`google-drive-service.ts`, `services/telegram-service.ts`. Mobile has its **own** sync implementation in `packages/mobile-app/src/services/android-sync-engine.ts` mirroring protocol rules—fixes to sync semantics may need to be applied in both places.
- **Subdirectory/relative paths matter**: desktop uses normalized `/` relative paths; native Android SAF must preserve folder structure when scanning/writing (do not flatten to root except where explicitly intended, e.g. flat Drive blob names are fine as long as index paths are correct). Web mobile simulator FS endpoints are implemented in `packages/web-ui/vite.mobile.config.ts` (`/__mobile_dev_fs/*`).
- **Env/config**: copy `.env.example` → `.env` at repo root for `GOOGLE_CLIENT_ID/SECRET`, `PORT` (default 8384), optional `TELEGRAM_BOT_TOKEN`, `SYNC_POLL_INTERVAL_MS`. `dev-node2` copies Google auth from main config `~/.foldersync/desktop-agent/config.json` if present; use env vars (`PORT`, `NODE_NAME`, `NODE2_SYNC_DIR`, `FOLDERSYNC_CONFIG_PATH`) to isolate nodes.
- There are no CI workflows, pre-commit hooks, or turbo/nx config in this repo; `docs/task.md` tracks implementation phases/status.
