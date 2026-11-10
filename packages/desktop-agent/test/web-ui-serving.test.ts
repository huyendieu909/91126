import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { ConfigService } from '../src/services/config-service.js';
import { FolderService } from '../src/services/folder-service.js';
import { FileIndexer } from '../src/services/file-indexer.js';
import { FolderWatcher } from '../src/services/folder-watcher.js';
import { InMemoryCloudProvider } from '../src/services/cloud-storage.js';
import { SyncCoordinator } from '../src/services/sync-coordinator.js';
import { createAgentHttpServer } from '../src/server.js';

describe('Phase 5: Web UI Serving & Real-time WebSocket Events', () => {
  let tmpRoot: string;
  let server: http.Server;
  let folderWatcher: FolderWatcher;
  let coordinator: SyncCoordinator;
  let port: number;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldersync-phase5-'));
    const syncDir = path.join(tmpRoot, 'sync');
    await fs.mkdir(syncDir, { recursive: true });

    const configService = new ConfigService(path.join(tmpRoot, 'config.json'));
    await configService.saveConfig({
      deviceName: 'UI-Test-Node',
      syncFolderPath: syncDir,
    });

    const folderService = new FolderService(configService);
    const fileIndexer = new FileIndexer();
    folderWatcher = new FolderWatcher(configService, folderService, fileIndexer);
    const cloud = new InMemoryCloudProvider();
    coordinator = new SyncCoordinator(
      configService,
      folderService,
      fileIndexer,
      folderWatcher,
      cloud,
    );

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const staticWebDir = path.resolve(__dirname, '../../web-ui/dist');

    server = createAgentHttpServer({
      configService,
      folderService,
      fileIndexer,
      folderWatcher,
      syncCoordinator: coordinator,
      staticWebDir,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    coordinator.dispose();
    await folderWatcher.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('serves built React Web Dashboard at GET /', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('FolderSync');
  });

  it('streams real-time syncStarted & syncCompleted events to WebSocket clients on /ws', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });

    const receivedTypes: string[] = [];
    const donePromise = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString()) as { type: string };
        receivedTypes.push(parsed.type);
        if (parsed.type === 'syncCompleted') {
          resolve();
        }
      });
    });

    const triggerRes = await fetch(`http://127.0.0.1:${port}/api/sync/trigger`, {
      method: 'POST',
    });
    expect(triggerRes.status).toBe(200);

    await donePromise;
    expect(receivedTypes).toContain('syncStarted');
    expect(receivedTypes).toContain('syncCompleted');

    ws.close();
  });
});
