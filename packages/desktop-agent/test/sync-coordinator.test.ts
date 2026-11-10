import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigService } from '../src/services/config-service.js';
import { FolderService } from '../src/services/folder-service.js';
import { FileIndexer } from '../src/services/file-indexer.js';
import { FolderWatcher } from '../src/services/folder-watcher.js';
import { InMemoryCloudProvider } from '../src/services/cloud-storage.js';
import { TelegramService } from '../src/services/telegram-service.js';
import { SyncCoordinator } from '../src/services/sync-coordinator.js';

interface TestNode {
  name: string;
  syncDir: string;
  configService: ConfigService;
  folderService: FolderService;
  fileIndexer: FileIndexer;
  folderWatcher: FolderWatcher;
  telegramService: TelegramService;
  coordinator: SyncCoordinator;
}

describe('Phase 4: Multi-Device SyncCoordinator (list-file.md + Cloud + Telegram Trigger)', () => {
  let tmpRoot: string;
  let sharedCloud: InMemoryCloudProvider;
  let telegramMessages: Array<{ text: string; updateId: number }>;
  let nextUpdateId: number;
  let nodeA: TestNode;
  let nodeB: TestNode;

  async function createNode(
    name: string,
    subDirName: string,
    mockFetch: typeof fetch,
  ): Promise<TestNode> {
    const nodeRoot = path.join(tmpRoot, subDirName);
    const syncDir = path.join(nodeRoot, 'sync-folder');
    await fs.mkdir(syncDir, { recursive: true });

    const configService = new ConfigService(path.join(nodeRoot, 'config.json'));
    await configService.saveConfig({
      deviceName: name,
      syncFolderPath: syncDir,
      telegramBot: {
        enabled: true,
        botToken: 'test_bot_token',
        chatId: '999888',
        lastUpdateId: 0,
      },
    });

    const folderService = new FolderService(configService);
    const fileIndexer = new FileIndexer();
    const folderWatcher = new FolderWatcher(configService, folderService, fileIndexer, {
      debounceMs: 2000, // Keep manual control in deterministic sync tests
      lockHoldMs: 500,
    });
    const telegramService = new TelegramService(configService, fileIndexer, {
      batchWindowMs: 20,
      pollIntervalMs: 60000,
      fetchImpl: mockFetch,
    });
    const coordinator = new SyncCoordinator(
      configService,
      folderService,
      fileIndexer,
      folderWatcher,
      sharedCloud,
      telegramService,
    );

    return {
      name,
      syncDir,
      configService,
      folderService,
      fileIndexer,
      folderWatcher,
      telegramService,
      coordinator,
    };
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldersync-phase4-'));
    sharedCloud = new InMemoryCloudProvider();
    telegramMessages = [];
    nextUpdateId = 1;

    // Mock Telegram Bot HTTP API (sendMessage & getUpdates) shared across nodes
    const mockTelegramFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/sendMessage')) {
        const body = JSON.parse(String(init?.body || '{}')) as { text: string };
        telegramMessages.push({
          updateId: nextUpdateId++,
          text: body.text,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (url.includes('/getUpdates')) {
        const parsedUrl = new URL(url);
        const offset = Number(parsedUrl.searchParams.get('offset') || '0');
        const updates = telegramMessages
          .filter((m) => m.updateId >= offset)
          .map((m) => ({
            update_id: m.updateId,
            message: {
              chat: { id: '999888' },
              text: m.text,
            },
          }));
        return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 });
      }

      return new Response('Not found', { status: 404 });
    };

    nodeA = await createNode('Linux-PC', 'node-a', mockTelegramFetch);
    nodeB = await createNode('Windows-PC', 'node-b', mockTelegramFetch);
  });

  afterEach(async () => {
    nodeA.telegramService.stop();
    nodeB.telegramService.stop();
    nodeA.coordinator.dispose();
    nodeB.coordinator.dispose();
    await nodeA.folderWatcher.stop();
    await nodeB.folderWatcher.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('syncs new files, edits, and deletions (DELETED tombstone) across two devices via list-file.md', async () => {
    // 1. Node A creates 2 files (including nested directory)
    await fs.mkdir(path.join(nodeA.syncDir, 'notes'), { recursive: true });
    await fs.writeFile(path.join(nodeA.syncDir, 'hello.txt'), 'Hello v1 from Linux', 'utf-8');
    await fs.writeFile(path.join(nodeA.syncDir, 'notes', 'todo.md'), '- Buy milk', 'utf-8');

    const sumA1 = await nodeA.coordinator.syncNow('TEST_INIT');
    expect(sumA1?.uploadedCount).toBe(2);
    expect(sumA1?.revision).toBe(1);

    // 2. Node B checks list-file.md and downloads the 2 missing files
    const sumB1 = await nodeB.coordinator.syncNow('TEST_PULL');
    expect(sumB1?.downloadedCount).toBe(2);
    expect(sumB1?.uploadedCount).toBe(0);

    expect(await fs.readFile(path.join(nodeB.syncDir, 'hello.txt'), 'utf-8')).toBe(
      'Hello v1 from Linux',
    );
    expect(await fs.readFile(path.join(nodeB.syncDir, 'notes', 'todo.md'), 'utf-8')).toBe(
      '- Buy milk',
    );

    // 3. Node B modifies hello.txt and deletes notes/todo.md
    const newerDate = new Date(Date.now() + 5000);
    await fs.writeFile(path.join(nodeB.syncDir, 'hello.txt'), 'Hello v2 from Windows', 'utf-8');
    await fs.utimes(path.join(nodeB.syncDir, 'hello.txt'), newerDate, newerDate);
    await fs.unlink(path.join(nodeB.syncDir, 'notes', 'todo.md'));

    const sumB2 = await nodeB.coordinator.syncNow('TEST_EDIT_AND_DELETE');
    expect(sumB2?.uploadedCount).toBe(1);
    expect(sumB2?.markedDeletedRemotelyCount).toBe(1);

    // 4. Node A syncs -> receives updated hello.txt and deletes notes/todo.md locally
    const sumA2 = await nodeA.coordinator.syncNow('TEST_PULL_UPDATES');
    expect(sumA2?.downloadedCount).toBe(1);
    expect(sumA2?.deletedLocallyCount).toBe(1);

    expect(await fs.readFile(path.join(nodeA.syncDir, 'hello.txt'), 'utf-8')).toBe(
      'Hello v2 from Windows',
    );
    await expect(fs.stat(path.join(nodeA.syncDir, 'notes', 'todo.md'))).rejects.toThrow();
  });

  it('resolves simultaneous edits safely by keeping newest file and saving .conflict-<device> backup', async () => {
    // Establish shared baseline on both Node A and Node B
    await fs.writeFile(path.join(nodeA.syncDir, 'shared.txt'), 'Base Content', 'utf-8');
    await nodeA.coordinator.syncNow('BASE');
    await nodeB.coordinator.syncNow('BASE_PULL');

    // Now BOTH Node A and Node B edit shared.txt independently while offline!
    const tOlder = new Date('2026-11-10T10:00:00.000Z');
    const tNewer = new Date('2026-11-10T11:00:00.000Z');

    await fs.writeFile(path.join(nodeA.syncDir, 'shared.txt'), 'Linux Older Edit', 'utf-8');
    await fs.utimes(path.join(nodeA.syncDir, 'shared.txt'), tOlder, tOlder);

    await fs.writeFile(path.join(nodeB.syncDir, 'shared.txt'), 'Windows Newer Edit', 'utf-8');
    await fs.utimes(path.join(nodeB.syncDir, 'shared.txt'), tNewer, tNewer);

    // Node A syncs first (pushes Linux Older Edit)
    await nodeA.coordinator.syncNow('A_PUSH');

    // Node B syncs next -> detects 3-way conflict! Windows Newer Edit wins, Linux Older Edit saved as .conflict-Linux-PC
    const conflictSummary = await nodeB.coordinator.syncNow('B_CONFLICT_SYNC');
    expect(conflictSummary?.conflictsCount).toBe(1);

    // Node A syncs once more so both machines converge to the exact same state
    await nodeA.coordinator.syncNow('A_CONVERGE');

    // Verify both Node A and Node B have the winning main file AND the conflict backup!
    expect(await fs.readFile(path.join(nodeA.syncDir, 'shared.txt'), 'utf-8')).toBe(
      'Windows Newer Edit',
    );
    expect(await fs.readFile(path.join(nodeB.syncDir, 'shared.txt'), 'utf-8')).toBe(
      'Windows Newer Edit',
    );

    expect(
      await fs.readFile(path.join(nodeA.syncDir, 'shared.conflict-Linux-PC.txt'), 'utf-8'),
    ).toBe('Linux Older Edit');
    expect(
      await fs.readFile(path.join(nodeB.syncDir, 'shared.conflict-Linux-PC.txt'), 'utf-8'),
    ).toBe('Linux Older Edit');
  });

  it('automatically triggers sync on Node B when Node A broadcasts an update via Telegram Bot', async () => {
    await fs.writeFile(path.join(nodeA.syncDir, 'tele-triggered.txt'), 'Triggered via Telegram!', 'utf-8');
    await nodeA.coordinator.syncNow('A_UPLOAD');
    await nodeA.telegramService.flushNotification();

    expect(telegramMessages.length).toBeGreaterThanOrEqual(1);
    expect(telegramMessages[0].text).toContain('[FolderSync Rev #');

    // Node B polls Telegram updates -> detects new revision from Linux-PC -> triggers sync automatically!
    const syncDonePromise = new Promise<void>((resolve) => {
      nodeB.coordinator.once('syncCompleted', () => resolve());
    });

    await nodeB.telegramService.pollOnce();
    await syncDonePromise;

    const syncedContent = await fs.readFile(
      path.join(nodeB.syncDir, 'tele-triggered.txt'),
      'utf-8',
    );
    expect(syncedContent).toBe('Triggered via Telegram!');
  });
});
