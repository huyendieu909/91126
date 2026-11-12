import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigService } from './services/config-service.js';
import { FolderService } from './services/folder-service.js';
import { FileIndexer } from './services/file-indexer.js';
import { FolderWatcher } from './services/folder-watcher.js';
import { GoogleDriveProvider, GoogleOAuthService } from './services/google-drive-service.js';
import { TelegramService } from './services/telegram-service.js';
import { SyncCoordinator } from './services/sync-coordinator.js';
import { createAgentHttpServer } from './server.js';

export * from './services/config-service.js';
export * from './services/folder-service.js';
export * from './services/file-indexer.js';
export * from './services/folder-watcher.js';
export * from './services/cloud-storage.js';
export * from './services/google-drive-service.js';
export * from './services/telegram-service.js';
export * from './services/sync-coordinator.js';
export * from './server.js';

export function startAgentServer(options?: {
  port?: number;
  customConfigPath?: string;
}): void {
  const port = options?.port ?? Number(process.env.PORT || 8384);
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const staticWebDir = path.resolve(__dirname, '../../web-ui/dist');

  const configService = new ConfigService(options?.customConfigPath);
  const folderService = new FolderService(configService);
  const fileIndexer = new FileIndexer();
  const folderWatcher = new FolderWatcher(configService, folderService, fileIndexer);
  const googleOAuthService = new GoogleOAuthService(configService);
  const googleDriveProvider = new GoogleDriveProvider(configService, googleOAuthService);
  const telegramService = new TelegramService(configService, fileIndexer);
  const syncCoordinator = new SyncCoordinator(
    configService,
    folderService,
    fileIndexer,
    folderWatcher,
    googleDriveProvider,
    telegramService,
  );

  void folderWatcher.start().then(() => {
    void syncCoordinator.syncNow('STARTUP').catch(() => undefined);
    const bgPollMs = Number(process.env.SYNC_POLL_INTERVAL_MS || 15000);
    syncCoordinator.startBackgroundSync(bgPollMs);
  });
  telegramService.start();

  const server = createAgentHttpServer({
    configService,
    folderService,
    fileIndexer,
    folderWatcher,
    googleOAuthService,
    googleDriveProvider,
    telegramService,
    syncCoordinator,
    staticWebDir,
  });

  server.listen(port, () => {
    console.log(`[FolderSync Agent] Running on http://localhost:${port}`);
  });
}

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('desktop-agent/src/index.ts') ||
  process.argv[1]?.endsWith('desktop-agent/dist/index.js');

if (isMainModule) {
  startAgentServer();
}
