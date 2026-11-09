import { ConfigService } from './services/config-service.js';
import { FolderService } from './services/folder-service.js';
import { FileIndexer } from './services/file-indexer.js';
import { FolderWatcher } from './services/folder-watcher.js';
import { createAgentHttpServer } from './server.js';

export * from './services/config-service.js';
export * from './services/folder-service.js';
export * from './services/file-indexer.js';
export * from './services/folder-watcher.js';
export * from './server.js';

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('desktop-agent/src/index.ts') ||
  process.argv[1]?.endsWith('desktop-agent/dist/index.js');

if (isMainModule) {
  const port = Number(process.env.PORT || 8384);
  const configService = new ConfigService();
  const folderService = new FolderService(configService);
  const fileIndexer = new FileIndexer();
  const folderWatcher = new FolderWatcher(configService, folderService, fileIndexer);

  void folderWatcher.start();

  const server = createAgentHttpServer({
    configService,
    folderService,
    fileIndexer,
    folderWatcher,
  });

  server.listen(port, () => {
    console.log(`[FolderSync Agent] Listening on http://localhost:${port}`);
  });
}
