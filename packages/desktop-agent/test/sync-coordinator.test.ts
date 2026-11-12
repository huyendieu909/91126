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
    watcherDebounceMs = 2000,
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
      debounceMs: watcherDebounceMs, // Keep manual control in deterministic sync tests unless testing live watcher
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

    // 5. Verify that once all knownDevices (Linux-PC & Windows-PC) have deleted notes/todo.md,
    // the DELETED row is completely garbage-collected from list-file.md!
    const remoteDocAfterDelete = await sharedCloud.readRemoteListFile();
    expect(
      remoteDocAfterDelete?.entries.find((e) => e.relativePath === 'notes/todo.md'),
    ).toBeUndefined();
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

  it('acts as an Ephemeral Relay: auto-purges files from Google Drive once all devices sync, and re-uploads on demand for new devices', async () => {
    // 1. Node A creates a file and syncs -> temporarily stored on cloud relay
    await fs.writeFile(path.join(nodeA.syncDir, 'relay-doc.txt'), 'Ephemeral relay data', 'utf-8');
    await nodeA.coordinator.syncNow('A_INITIAL_UPLOAD');
    expect(sharedCloud.getStoredFileCount()).toBe(1);

    // 2. Node B syncs and downloads the file -> both knownDevices (Linux-PC & Windows-PC) now have the file!
    // The physical file must be automatically purged from Google Drive (0 files stored in cloud)!
    await nodeB.coordinator.syncNow('B_DOWNLOAD_AND_PURGE');
    expect(await fs.readFile(path.join(nodeB.syncDir, 'relay-doc.txt'), 'utf-8')).toBe(
      'Ephemeral relay data',
    );
    expect(sharedCloud.getStoredFileCount()).toBe(0);

    const remoteDocAfterPurge = await sharedCloud.readRemoteListFile();
    expect(remoteDocAfterPurge?.entries[0].driveFileId).toBe('-');
    expect(remoteDocAfterPurge?.entries[0].syncedDevices).toEqual(['Linux-PC', 'Windows-PC']);

    // 3. A brand-new 3rd device (Node C) joins later when Google Drive has 0 files stored
    const nodeC = await createNode('Android-Phone', 'node-c', async () => {
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    });

    try {
      // First sync on Node C notices driveFileId === '-' and requests re-upload (@NEED_UPLOAD)
      await nodeC.coordinator.syncNow('C_REQUEST_REUPLOAD');
      const docWithRequest = await sharedCloud.readRemoteListFile();
      expect(docWithRequest?.entries[0].requestUpload).toBe(true);

      // Node A syncs -> sees requestUpload, pushes file back to relay temporarily (1 file in cloud)
      await nodeA.coordinator.syncNow('A_FULFILL_REUPLOAD');
      expect(sharedCloud.getStoredFileCount()).toBe(1);

      // Node C syncs -> downloads the file and automatically purges the relay back to 0 files!
      await nodeC.coordinator.syncNow('C_DOWNLOAD_AND_PURGE');
      expect(await fs.readFile(path.join(nodeC.syncDir, 'relay-doc.txt'), 'utf-8')).toBe(
        'Ephemeral relay data',
      );
      expect(sharedCloud.getStoredFileCount()).toBe(0);
    } finally {
      nodeC.telegramService.stop();
      nodeC.coordinator.dispose();
      await nodeC.folderWatcher.stop();
    }
  });

  it('supports Multi-Zone Sync Network: isolates files per zone and purges relay per zone membership', async () => {
    const workDirA = path.join(tmpRoot, 'zone-work-a');
    const workDirB = path.join(tmpRoot, 'zone-work-b');
    await fs.mkdir(workDirA, { recursive: true });
    await fs.mkdir(workDirB, { recursive: true });

    // 1. Node A creates a new zone "Work Docs" and puts a file in it
    await fs.writeFile(path.join(workDirA, 'architecture.md'), '# Zone Work Only', 'utf-8');
    const createdZone = await nodeA.coordinator.createZone({
      zoneName: 'Work Docs',
      description: 'Chỉ đồng bộ giữa Linux và Windows',
      localFolderPath: workDirA,
    });
    expect(createdZone.zoneId).toBe('zone-work-docs');
    expect(createdZone.joined).toBe(true);
    expect(sharedCloud.getStoredFileCount('zone-work-docs')).toBe(1);

    // 2. Node C (Android-Phone) is only in default-zone and does NOT join zone-work-docs
    const nodeC = await createNode('Android-Phone', 'node-c-zone', async () => {
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    });

    try {
      const discoveredOnC = await nodeC.coordinator.discoverZones();
      const workZoneOnC = discoveredOnC.find((z) => z.zoneId === 'zone-work-docs');
      expect(workZoneOnC).toBeDefined();
      expect(workZoneOnC?.joined).toBe(false);

      // Node C syncs its default zone -> must NOT download architecture.md from zone-work-docs!
      await nodeC.coordinator.syncNow('C_DEFAULT_SYNC');
      await expect(fs.stat(path.join(nodeC.syncDir, 'architecture.md'))).rejects.toThrow();

      // 3. Node B (Windows-PC) discovers and joins "zone-work-docs"
      const joinedOnB = await nodeB.coordinator.joinZone({
        zoneId: 'zone-work-docs',
        localFolderPath: workDirB,
      });
      expect(joinedOnB.joined).toBe(true);
      expect(await fs.readFile(path.join(workDirB, 'architecture.md'), 'utf-8')).toBe(
        '# Zone Work Only',
      );

      // Because both members of zone-work-docs (Linux-PC & Windows-PC) have synced,
      // the temporary file in zone-work-docs is immediately purged from Drive without waiting for Android-Phone!
      expect(sharedCloud.getStoredFileCount('zone-work-docs')).toBe(0);

      // 4. Node B leaves zone-work-docs -> removed from memberDevices & knownDevices
      await nodeB.coordinator.leaveZone('zone-work-docs');
      const remoteWorkDoc = await sharedCloud.readRemoteListFile('zone-work-docs');
      expect(remoteWorkDoc?.knownDevices).toEqual(['Linux-PC']);
    } finally {
      nodeC.telegramService.stop();
      nodeC.coordinator.dispose();
      await nodeC.folderWatcher.stop();
    }
  });

  it('performs true 2-way multi-zone background sync (multi-zone FolderWatcher + pollRemoteChangesOnce) without Telegram', async () => {
    const noOpFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });

    const bgNodeA = await createNode('Desk-Linux', 'bg-node-a', noOpFetch, 80);
    const bgNodeB = await createNode('Desk-Windows', 'bg-node-b', noOpFetch, 80);

    try {
      // Completely disable Telegram on both nodes to prove background sync works independently
      await bgNodeA.configService.saveConfig({
        telegramBot: { enabled: false, botToken: '', chatId: '' },
      });
      await bgNodeB.configService.saveConfig({
        telegramBot: { enabled: false, botToken: '', chatId: '' },
      });

      const alphaDirA = path.join(tmpRoot, 'alpha-zone-a');
      const alphaDirB = path.join(tmpRoot, 'alpha-zone-b');
      await fs.mkdir(alphaDirA, { recursive: true });
      await fs.mkdir(alphaDirB, { recursive: true });

      // Establish baseline in default-zone on both nodes
      await bgNodeA.coordinator.syncNow('INIT_DEFAULT_A');
      await bgNodeB.coordinator.syncNow('INIT_DEFAULT_B');

      // Node A creates a secondary zone "Project Alpha", and Node B joins it
      await bgNodeA.coordinator.createZone({
        zoneName: 'Project Alpha',
        localFolderPath: alphaDirA,
      });
      await bgNodeB.coordinator.joinZone({
        zoneId: 'zone-project-alpha',
        localFolderPath: alphaDirB,
      });

      // Switch Node A's active zone back to default-zone so "zone-project-alpha" is a NON-ACTIVE extra watched zone!
      await bgNodeA.coordinator.activateZone('default-zone');
      await bgNodeA.folderWatcher.start();

      // Write a file inside the NON-ACTIVE secondary zone on Node A -> extraZoneWatchers must auto-detect & push to Cloud!
      const autoPushDone = new Promise<void>((resolve) => {
        bgNodeA.coordinator.once('syncCompleted', () => resolve());
      });
      await fs.writeFile(
        path.join(alphaDirA, 'auto-bg.txt'),
        'Pushed from extraZoneWatcher!',
        'utf-8',
      );
      await autoPushDone;

      expect(sharedCloud.getStoredFileCount('zone-project-alpha')).toBe(1);

      // Node B runs pollRemoteChangesOnce() (simulating the 15s background timer, zero Telegram) ->
      // automatically pulls auto-bg.txt into alphaDirB AND purges the temporary Drive relay!
      const triggered = await bgNodeB.coordinator.pollRemoteChangesOnce();
      expect(triggered).toBe(true);
      expect(await fs.readFile(path.join(alphaDirB, 'auto-bg.txt'), 'utf-8')).toBe(
        'Pushed from extraZoneWatcher!',
      );
      expect(sharedCloud.getStoredFileCount('zone-project-alpha')).toBe(0);

      // Polling again when everything is up-to-date should be a clean no-op
      const secondPoll = await bgNodeB.coordinator.pollRemoteChangesOnce();
      expect(secondPoll).toBe(false);
    } finally {
      bgNodeA.telegramService.stop();
      bgNodeB.telegramService.stop();
      bgNodeA.coordinator.dispose();
      bgNodeB.coordinator.dispose();
      await bgNodeA.folderWatcher.stop();
      await bgNodeB.folderWatcher.stop();
    }
  });

  it('pairs Telegram in 1-Click via Deep-Link (/start pair_xxxx) and supports Chat/Group auto-discovery picker', async () => {
    const sentMessages: Array<{ chat_id: string; text: string }> = [];
    let pendingUpdates: Array<Record<string, unknown>> = [];

    const mockPairFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/getMe')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { username: 'foldersync_notify_bot', first_name: 'FolderSync Bot' },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/getUpdates')) {
        return new Response(JSON.stringify({ ok: true, result: pendingUpdates }), { status: 200 });
      }
      if (url.includes('/sendMessage')) {
        const body = JSON.parse(String(init?.body || '{}')) as { chat_id: string; text: string };
        sentMessages.push(body);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const pairConfigSvc = new ConfigService(path.join(tmpRoot, 'pair-node', 'config.json'));
    await pairConfigSvc.saveConfig({
      deviceName: 'Arch-Linux',
      syncFolderPath: nodeA.syncDir,
      telegramBot: {
        enabled: false,
        botToken: '',
        chatId: '',
      },
    });
    const pairTeleSvc = new TelegramService(pairConfigSvc, new FileIndexer(), {
      fetchImpl: mockPairFetch,
    });

    // 1. User clicks "Liên kết Cá nhân 1-Chạm"
    const session = await pairTeleSvc.startPairingSession('123456:PAIR_BOT_TOKEN');
    expect(session.botUsername).toBe('foldersync_notify_bot');
    expect(session.deepLinkUrl).toBe(
      `https://t.me/foldersync_notify_bot?start=${session.pairCode}`,
    );
    expect(session.groupInviteUrl).toBe(
      `https://t.me/foldersync_notify_bot?startgroup=${session.pairCode}`,
    );

    // 2. User presses [ START ] in Telegram app (plus bot is also in a family group)
    pendingUpdates = [
      {
        update_id: 101,
        message: {
          chat: { id: 778899, type: 'private', first_name: 'Ck', username: 'ck_dev' },
          text: `/start ${session.pairCode}`,
        },
      },
      {
        update_id: 102,
        message: {
          chat: { id: -100556677, type: 'supergroup', title: 'Nhóm Đồng Bộ Gia Đình' },
          text: 'hello bot',
        },
      },
    ];

    let pairedEventChatId = '';
    pairTeleSvc.once('telegramPaired', (evt: { chat: { chatId: string } }) => {
      pairedEventChatId = evt.chat.chatId;
    });

    // Background pollOnce() automatically completes pairing without user typing any Chat ID!
    await pairTeleSvc.pollOnce();

    expect(pairedEventChatId).toBe('778899');
    const pairedCfg = await pairConfigSvc.loadConfig();
    expect(pairedCfg.telegramBot.enabled).toBe(true);
    expect(pairedCfg.telegramBot.chatId).toBe('778899');
    expect(pairedCfg.telegramBot.chatTitle).toBe('Ck (@ck_dev)');
    expect(pairedCfg.telegramBot.botUsername).toBe('foldersync_notify_bot');
    expect(sentMessages.some((m) => m.chat_id === '778899')).toBe(true);

    // 3. User opens Dropdown Picker to switch to the discovered group without typing ID
    const discovered = await pairTeleSvc.discoverRecentChats();
    expect(discovered.chats.map((c) => c.chatId)).toContain('-100556677');

    await pairTeleSvc.selectChat('-100556677', 'Nhóm Đồng Bộ Gia Đình');
    const groupCfg = await pairConfigSvc.loadConfig();
    expect(groupCfg.telegramBot.chatId).toBe('-100556677');
    expect(groupCfg.telegramBot.chatTitle).toBe('Nhóm Đồng Bộ Gia Đình');
    expect(sentMessages.some((m) => m.chat_id === '-100556677')).toBe(true);
  });

  it('auto-enables legacy saved Telegram channel, sends 2-way notifications (upload + download) without ping-pong loop, and logs TELEGRAM_SENT / TELEGRAM_ERROR', async () => {
    // 1. Legacy config on disk: has botToken + chatId, enabled: false, no pausedByUser
    const legacyConfigFile = path.join(tmpRoot, 'legacy-tele', 'config.json');
    await fs.mkdir(path.dirname(legacyConfigFile), { recursive: true });
    await fs.writeFile(
      legacyConfigFile,
      JSON.stringify(
        {
          deviceId: 'legacy-pc-1',
          deviceName: 'Legacy-PC',
          syncFolderPath: nodeA.syncDir,
          telegramBot: {
            enabled: false,
            botToken: '999888:MOCK_LEGACY_TOKEN',
            chatId: '11223344',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const legacyCfgSvc = new ConfigService(legacyConfigFile);
    const loadedLegacy = await legacyCfgSvc.loadConfig();
    expect(loadedLegacy.telegramBot.enabled).toBe(true);

    // Explicitly pausing via saveConfig sets pausedByUser: true and stays disabled on reload
    await legacyCfgSvc.saveConfig({ telegramBot: { enabled: false } });
    const pausedReloaded = await legacyCfgSvc.loadConfig();
    expect(pausedReloaded.telegramBot.enabled).toBe(false);
    expect(pausedReloaded.telegramBot.pausedByUser).toBe(true);

    // Re-enabling clears pausedByUser
    await legacyCfgSvc.saveConfig({ telegramBot: { enabled: true } });
    const reenabled = await legacyCfgSvc.loadConfig();
    expect(reenabled.telegramBot.enabled).toBe(true);
    expect(reenabled.telegramBot.pausedByUser).toBe(false);

    // 2. Verify 2-way notifications (outbound push on Node A + inbound download on Node B) & activity logs
    telegramMessages.length = 0;
    await fs.writeFile(path.join(nodeA.syncDir, 'bidirectional.txt'), 'Hello 2-way Tele!', 'utf-8');
    await nodeA.coordinator.syncNow('A_PUSH_2WAY');
    await nodeA.telegramService.flushNotification();

    expect(telegramMessages.length).toBe(1);
    expect(telegramMessages[0].text).toContain('🔄 [FolderSync Rev #');
    expect(telegramMessages[0].text).toContain('🌐 Vùng đồng bộ:');
    expect(telegramMessages[0].text).toContain('bidirectional.txt');
    expect(nodeA.coordinator.getLogs().some((l) => l.action === 'TELEGRAM_SENT')).toBe(true);

    // Node B pulls the file -> queues an INBOUND receipt notification ("📥 [FolderSync Synced #... | On: Windows-PC]")
    await nodeB.coordinator.syncNow('B_PULL_2WAY');
    await nodeB.telegramService.flushNotification();

    expect(telegramMessages.length).toBe(2);
    expect(telegramMessages[1].text).toContain('📥 [FolderSync Synced #');
    expect(telegramMessages[1].text).toContain('On: Windows-PC');
    expect(telegramMessages[1].text).toContain('📥 Đã tải về máy: 1 file (bidirectional.txt)');

    // Verify anti-loop: Node A polling the inbound receipt from Node B must NOT emit remoteTrigger!
    let remoteTriggerCount = 0;
    const onTrigger = () => {
      remoteTriggerCount += 1;
    };
    nodeA.telegramService.on('remoteTrigger', onTrigger);
    await nodeA.telegramService.pollOnce();
    nodeA.telegramService.off('remoteTrigger', onTrigger);
    expect(remoteTriggerCount).toBe(0);

    // 3. Verify Telegram HTTP error is caught safely and logged as TELEGRAM_ERROR in SyncCoordinator
    const failingFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
        status: 400,
      });
    const errNode = await createNode('Err-PC', 'err-tele-node', failingFetch);
    try {
      await fs.writeFile(path.join(errNode.syncDir, 'err-test.txt'), 'test', 'utf-8');
      await errNode.coordinator.syncNow('ERR_TEST');
      const sentOk = await errNode.telegramService.flushNotification();
      expect(sentOk).toBe(false);
      const errLog = errNode.coordinator.getLogs().find((l) => l.action === 'TELEGRAM_ERROR');
      expect(errLog).toBeDefined();
      expect(errLog?.message).toContain('chat not found');
    } finally {
      errNode.telegramService.stop();
      errNode.coordinator.dispose();
      await errNode.folderWatcher.stop();
    }
  });
});
