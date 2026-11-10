import http from 'node:http';
import { URL } from 'node:url';
import { serializeListFile, type SwitchFolderMode } from '@foldersync/shared';
import { ConfigService } from './services/config-service.js';
import { FolderService } from './services/folder-service.js';
import { FileIndexer } from './services/file-indexer.js';
import { FolderWatcher } from './services/folder-watcher.js';

export interface AgentServerContext {
  configService: ConfigService;
  folderService: FolderService;
  fileIndexer?: FileIndexer;
  folderWatcher?: FolderWatcher;
}

export function createAgentHttpServer(ctx: AgentServerContext): http.Server {
  const indexer = ctx.fileIndexer ?? new FileIndexer();

  return http.createServer(async (req, res) => {
    // Enable CORS for local Web UI & Mobile
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    try {
      // GET /api/config
      if (req.method === 'GET' && pathname === '/api/config') {
        const publicConfig = await ctx.configService.getPublicConfig();
        sendJson(res, 200, publicConfig);
        return;
      }

      // PUT /api/config
      if (req.method === 'PUT' && pathname === '/api/config') {
        const body = await readJsonBody<{
          deviceName?: string;
          googleAuth?: {
            email?: string | null;
            displayName?: string | null;
            accessToken?: string | null;
            refreshToken?: string | null;
            expiryDate?: number | null;
            driveRootFolderId?: string | null;
          };
          telegramBot?: {
            enabled?: boolean;
            botToken?: string;
            chatId?: string;
          };
        }>(req);

        await ctx.configService.saveConfig({
          deviceName: body.deviceName,
          googleAuth: body.googleAuth,
          telegramBot: body.telegramBot,
        });

        const updatedPublic = await ctx.configService.getPublicConfig();
        sendJson(res, 200, updatedPublic);
        return;
      }

      // GET /api/fs/browse?path=...
      if (req.method === 'GET' && pathname === '/api/fs/browse') {
        const targetPath = reqUrl.searchParams.get('path') || undefined;
        const result = await ctx.folderService.listDirectories(targetPath);
        sendJson(res, 200, result);
        return;
      }

      // POST /api/fs/mkdir
      if (req.method === 'POST' && pathname === '/api/fs/mkdir') {
        const body = await readJsonBody<{ path: string }>(req);
        const createdPath = await ctx.folderService.createDirectory(body.path);
        sendJson(res, 201, { path: createdPath });
        return;
      }

      // POST /api/config/switch-folder
      if (req.method === 'POST' && pathname === '/api/config/switch-folder') {
        const body = await readJsonBody<{ newPath: string; mode?: SwitchFolderMode }>(req);
        const mode: SwitchFolderMode =
          body.mode === 'COPY_EXISTING' ? 'COPY_EXISTING' : 'POINT_ONLY';
        const result = await ctx.folderService.switchSyncFolder(body.newPath, mode);
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, { result, config });
        return;
      }

      // GET /api/index
      if (req.method === 'GET' && pathname === '/api/index') {
        const cfg = await ctx.configService.loadConfig();
        if (!cfg.syncFolderPath) {
          sendJson(res, 200, {
            configured: false,
            document: null,
            markdown: '',
          });
          return;
        }
        const doc = await indexer.readLocalListFile(cfg.syncFolderPath);
        sendJson(res, 200, {
          configured: true,
          document: doc,
          markdown: serializeListFile(doc),
        });
        return;
      }

      // POST /api/index/rescan
      if (req.method === 'POST' && pathname === '/api/index/rescan') {
        const cfg = await ctx.configService.loadConfig();
        if (!cfg.syncFolderPath) {
          sendJson(res, 400, { error: 'Chưa chọn thư mục đồng bộ.' });
          return;
        }
        const doc = ctx.folderWatcher
          ? await ctx.folderWatcher.triggerScanNow()
          : (await indexer.scanAndSyncLocalListFile(cfg.syncFolderPath, cfg.deviceName)).doc;

        sendJson(res, 200, {
          document: doc,
          markdown: serializeListFile(doc),
        });
        return;
      }

      sendJson(res, 404, { error: 'Endpoint not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      sendJson(res, 400, { error: message });
    }
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}
