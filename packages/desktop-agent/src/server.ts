import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  serializeListFile,
  type ExistingDataStrategy,
  type SwitchFolderMode,
} from '@foldersync/shared';
import { ConfigService } from './services/config-service.js';
import { FolderService } from './services/folder-service.js';
import { FileIndexer } from './services/file-indexer.js';
import { FolderWatcher } from './services/folder-watcher.js';
import { GoogleDriveProvider, GoogleOAuthService } from './services/google-drive-service.js';
import { TelegramService } from './services/telegram-service.js';
import { SyncCoordinator } from './services/sync-coordinator.js';

export interface AgentServerContext {
  configService: ConfigService;
  folderService: FolderService;
  fileIndexer?: FileIndexer;
  folderWatcher?: FolderWatcher;
  googleOAuthService?: GoogleOAuthService;
  googleDriveProvider?: GoogleDriveProvider;
  telegramService?: TelegramService;
  syncCoordinator?: SyncCoordinator;
  staticWebDir?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createAgentHttpServer(ctx: AgentServerContext): http.Server {
  const indexer = ctx.fileIndexer ?? new FileIndexer();
  const oauth = ctx.googleOAuthService ?? new GoogleOAuthService(ctx.configService);
  const driveProvider =
    ctx.googleDriveProvider ?? new GoogleDriveProvider(ctx.configService, oauth);

  const server = http.createServer(async (req, res) => {
    // Enable CORS for local Web UI & Mobile
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const hostHeader = req.headers.host || 'localhost:8384';
    const reqUrl = new URL(req.url || '/', `http://${hostHeader}`);
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
            clientId?: string | null;
            clientSecret?: string | null;
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
        const body = await readJsonBody<{
          newPath: string;
          mode?: SwitchFolderMode;
          existingDataStrategy?: ExistingDataStrategy;
        }>(req);
        const mode: SwitchFolderMode =
          body.mode === 'COPY_EXISTING' ? 'COPY_EXISTING' : 'POINT_ONLY';
        const strategy: ExistingDataStrategy =
          body.existingDataStrategy === 'ISOLATE_BACKUP' ||
          body.existingDataStrategy === 'CREATE_SUBFOLDER'
            ? body.existingDataStrategy
            : 'MERGE_ALL';
        const result = await ctx.folderService.switchSyncFolder(body.newPath, mode, strategy);
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

      // GET /api/auth/google/url
      if (req.method === 'GET' && pathname === '/api/auth/google/url') {
        const redirectUri =
          reqUrl.searchParams.get('redirectUri') ||
          `http://${hostHeader}/api/auth/google/callback`;
        const url = await oauth.getAuthorizationUrl(redirectUri);
        sendJson(res, 200, { url, redirectUri });
        return;
      }

      // GET /api/auth/google/callback
      if (req.method === 'GET' && pathname === '/api/auth/google/callback') {
        const code = reqUrl.searchParams.get('code');
        if (!code) {
          sendHtml(res, 400, '<h3>Thiếu mã xác thực Google OAuth2 (code).</h3>');
          return;
        }
        const redirectUri = `http://${hostHeader}/api/auth/google/callback`;
        await oauth.exchangeCode(code, redirectUri);
        await driveProvider.ensureWorkspaceFolder();
        if (ctx.syncCoordinator) {
          void ctx.syncCoordinator.syncNow('GOOGLE_CONNECTED');
        }

        sendHtml(
          res,
          200,
          `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><title>Đăng nhập Google thành công</title></head>
<body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center;padding:32px;background:#1e293b;border-radius:16px;">
    <h2>✅ Đăng nhập Google thành công!</h2>
    <p>FolderSync đã kết nối với Google Drive của bạn. Cửa sổ này sẽ tự đóng...</p>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS' }, '*');
        setTimeout(() => window.close(), 800);
      } else {
        setTimeout(() => { window.location.href = '/'; }, 1000);
      }
    </script>
  </div>
</body>
</html>`,
        );
        return;
      }

      // POST /api/auth/google/disconnect
      if (req.method === 'POST' && pathname === '/api/auth/google/disconnect') {
        await oauth.disconnect();
        const publicConfig = await ctx.configService.getPublicConfig();
        sendJson(res, 200, publicConfig);
        return;
      }

      // GET /api/auth/mobile-bridge (One-tap sync of Google OAuth refreshToken & Telegram config to Mobile)
      if (req.method === 'GET' && pathname === '/api/auth/mobile-bridge') {
        try {
          await oauth.getValidAccessToken();
        } catch {
          // Ignore if not logged in yet
        }
        const cfg = await ctx.configService.loadConfig();
        sendJson(res, 200, {
          googleAuth: {
            clientId: cfg.googleAuth.clientId || process.env.GOOGLE_CLIENT_ID || null,
            clientSecret: cfg.googleAuth.clientSecret || process.env.GOOGLE_CLIENT_SECRET || null,
            email: cfg.googleAuth.email,
            displayName: cfg.googleAuth.displayName,
            accessToken: cfg.googleAuth.accessToken,
            refreshToken: cfg.googleAuth.refreshToken,
            expiryDate: cfg.googleAuth.expiryDate,
            driveRootFolderId: cfg.googleAuth.driveRootFolderId,
            listFileDriveId: cfg.googleAuth.listFileDriveId,
          },
          telegramBot: {
            enabled: cfg.telegramBot.enabled,
            botToken: cfg.telegramBot.botToken || process.env.TELEGRAM_BOT_TOKEN || '',
            chatId: cfg.telegramBot.chatId,
          },
          zones: cfg.zones ?? [],
        });
        return;
      }

      // GET /api/zones
      if (req.method === 'GET' && pathname === '/api/zones') {
        if (ctx.syncCoordinator) {
          const zones = await ctx.syncCoordinator.discoverZones();
          const config = await ctx.configService.getPublicConfig();
          sendJson(res, 200, { zones, activeZoneId: config.activeZoneId, config });
          return;
        }
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, {
          zones: config.zones ?? [],
          activeZoneId: config.activeZoneId,
          config,
        });
        return;
      }

      // POST /api/zones/create
      if (req.method === 'POST' && pathname === '/api/zones/create') {
        if (!ctx.syncCoordinator) {
          sendJson(res, 400, { error: 'SyncCoordinator chưa được khởi tạo.' });
          return;
        }
        const body = await readJsonBody<{
          zoneName: string;
          description?: string;
          localFolderPath: string;
          existingDataStrategy?: ExistingDataStrategy;
        }>(req);
        const zone = await ctx.syncCoordinator.createZone(body);
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 201, { zone, config });
        return;
      }

      // POST /api/zones/join
      if (req.method === 'POST' && pathname === '/api/zones/join') {
        if (!ctx.syncCoordinator) {
          sendJson(res, 400, { error: 'SyncCoordinator chưa được khởi tạo.' });
          return;
        }
        const body = await readJsonBody<{
          zoneId: string;
          localFolderPath: string;
          existingDataStrategy?: ExistingDataStrategy;
        }>(req);
        const zone = await ctx.syncCoordinator.joinZone(body);
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, { zone, config });
        return;
      }

      // POST /api/zones/leave
      if (req.method === 'POST' && pathname === '/api/zones/leave') {
        if (!ctx.syncCoordinator) {
          sendJson(res, 400, { error: 'SyncCoordinator chưa được khởi tạo.' });
          return;
        }
        const body = await readJsonBody<{ zoneId: string }>(req);
        const zones = await ctx.syncCoordinator.leaveZone(body.zoneId);
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, { zones, config });
        return;
      }

      // POST /api/zones/activate
      if (req.method === 'POST' && pathname === '/api/zones/activate') {
        if (!ctx.syncCoordinator) {
          sendJson(res, 400, { error: 'SyncCoordinator chưa được khởi tạo.' });
          return;
        }
        const body = await readJsonBody<{ zoneId: string }>(req);
        const zone = await ctx.syncCoordinator.activateZone(body.zoneId);
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, { zone, config });
        return;
      }

      // POST /api/zones/sync
      if (req.method === 'POST' && pathname === '/api/zones/sync') {
        if (!ctx.syncCoordinator) {
          sendJson(res, 400, { error: 'SyncCoordinator chưa được khởi tạo.' });
          return;
        }
        const body = await readJsonBody<{ zoneId: string }>(req);
        const summary = await ctx.syncCoordinator.syncZone(body.zoneId, 'MANUAL_ZONE_UI');
        const status = await ctx.syncCoordinator.getStatus();
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, { summary, status, config });
        return;
      }

      // GET /api/sync/status
      if (req.method === 'GET' && pathname === '/api/sync/status') {
        if (!ctx.syncCoordinator) {
          sendJson(res, 200, {
            isSyncing: false,
            cloudReady: false,
            lastSyncedAt: null,
            lastSyncedRevision: 0,
            lastError: null,
            lastSummary: null,
          });
          return;
        }
        const status = await ctx.syncCoordinator.getStatus();
        sendJson(res, 200, status);
        return;
      }

      // GET /api/sync/logs
      if (req.method === 'GET' && pathname === '/api/sync/logs') {
        const logs = ctx.syncCoordinator ? ctx.syncCoordinator.getLogs() : [];
        sendJson(res, 200, { logs });
        return;
      }

      // POST /api/sync/trigger
      if (req.method === 'POST' && pathname === '/api/sync/trigger') {
        if (!ctx.syncCoordinator) {
          sendJson(res, 400, { error: 'Bộ điều phối đồng bộ chưa được khởi tạo.' });
          return;
        }
        const summary = await ctx.syncCoordinator.syncNow('MANUAL_UI');
        const status = await ctx.syncCoordinator.getStatus();
        sendJson(res, 200, { summary, status });
        return;
      }

      // POST /api/telegram/test
      if (req.method === 'POST' && pathname === '/api/telegram/test') {
        if (!ctx.telegramService) {
          sendJson(res, 400, { error: 'TelegramService chưa được khởi tạo.' });
          return;
        }
        const body = await readJsonBody<{ botToken?: string; chatId?: string }>(req);
        await ctx.telegramService.sendTestMessage(body.botToken, body.chatId);
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /api/telegram/pair/start (1-Click Deep-Link Pairing)
      if (req.method === 'POST' && pathname === '/api/telegram/pair/start') {
        if (!ctx.telegramService) {
          sendJson(res, 400, { error: 'TelegramService chưa được khởi tạo.' });
          return;
        }
        const body = await readJsonBody<{ botToken?: string }>(req);
        const session = await ctx.telegramService.startPairingSession(body.botToken);
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, { session, config });
        return;
      }

      // GET /api/telegram/chats (Discover recent chats/groups & check auto-pair status)
      if (req.method === 'GET' && pathname === '/api/telegram/chats') {
        if (!ctx.telegramService) {
          sendJson(res, 400, { error: 'TelegramService chưa được khởi tạo.' });
          return;
        }
        const tokenParam = reqUrl.searchParams.get('botToken') || undefined;
        const result = await ctx.telegramService.discoverRecentChats(tokenParam);
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, { ...result, config });
        return;
      }

      // POST /api/telegram/select-chat
      if (req.method === 'POST' && pathname === '/api/telegram/select-chat') {
        if (!ctx.telegramService) {
          sendJson(res, 400, { error: 'TelegramService chưa được khởi tạo.' });
          return;
        }
        const body = await readJsonBody<{
          chatId: string;
          chatTitle?: string;
          botToken?: string;
        }>(req);
        await ctx.telegramService.selectChat(body.chatId, body.chatTitle, body.botToken);
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, config);
        return;
      }

      // POST /api/telegram/disconnect
      if (req.method === 'POST' && pathname === '/api/telegram/disconnect') {
        if (!ctx.telegramService) {
          sendJson(res, 400, { error: 'TelegramService chưa được khởi tạo.' });
          return;
        }
        await ctx.telegramService.disconnect();
        const config = await ctx.configService.getPublicConfig();
        sendJson(res, 200, config);
        return;
      }

      // Serve built static Web UI if available
      if (req.method === 'GET' && ctx.staticWebDir && !pathname.startsWith('/api/')) {
        const served = await tryServeStaticFile(ctx.staticWebDir, pathname, res);
        if (served) return;
      }

      sendJson(res, 404, { error: 'Endpoint not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      sendJson(res, 400, { error: message });
    }
  });

  // Real-time WebSocket stream on /ws
  const wss = new WebSocketServer({ server, path: '/ws' });
  const broadcast = (type: string, payload: unknown) => {
    const raw = JSON.stringify({ type, payload });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  };

  if (ctx.folderWatcher) {
    ctx.folderWatcher.on('indexUpdated', (evt) => broadcast('indexUpdated', evt));
  }

  if (ctx.syncCoordinator) {
    ctx.syncCoordinator.on('syncStarted', (evt) => broadcast('syncStarted', evt));
    ctx.syncCoordinator.on('syncCompleted', (evt) => broadcast('syncCompleted', evt));
    ctx.syncCoordinator.on('syncError', (evt) => broadcast('syncError', evt));
    ctx.syncCoordinator.on('syncProgress', (evt) => broadcast('syncProgress', evt));
    ctx.syncCoordinator.on('logAdded', (evt) => broadcast('logAdded', evt));
  }

  if (ctx.telegramService) {
    ctx.telegramService.on('telegramPaired', (evt) => broadcast('telegramPaired', evt));
  }

  server.on('close', () => {
    wss.close();
  });

  return server;
}

async function tryServeStaticFile(
  staticDir: string,
  pathname: string,
  res: http.ServerResponse,
): Promise<boolean> {
  try {
    const safeRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(staticDir, safeRel);
    if (!candidate.startsWith(path.resolve(staticDir))) {
      return false;
    }

    let targetFile = candidate;
    try {
      const st = await fs.stat(targetFile);
      if (!st.isFile()) {
        targetFile = path.join(staticDir, 'index.html');
      }
    } catch {
      targetFile = path.join(staticDir, 'index.html');
    }

    const content = await fs.readFile(targetFile);
    const ext = path.extname(targetFile).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
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
