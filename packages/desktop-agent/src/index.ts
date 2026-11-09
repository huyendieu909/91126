import { ConfigService } from './services/config-service.js';
import { FolderService } from './services/folder-service.js';
import { createAgentHttpServer } from './server.js';

export * from './services/config-service.js';
export * from './services/folder-service.js';
export * from './server.js';

const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('desktop-agent/src/index.ts') ||
  process.argv[1]?.endsWith('desktop-agent/dist/index.js');

if (isMainModule) {
  const port = Number(process.env.PORT || 8384);
  const configService = new ConfigService();
  const folderService = new FolderService(configService);
  const server = createAgentHttpServer({ configService, folderService });

  server.listen(port, () => {
    console.log(`[FolderSync Agent] Listening on http://localhost:${port}`);
  });
}
