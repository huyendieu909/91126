import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LIST_FILE_NAME, type ListFileDocument } from '@foldersync/shared';
import { ConfigService } from '../src/services/config-service.js';
import { FolderService } from '../src/services/folder-service.js';
import { FileIndexer } from '../src/services/file-indexer.js';
import { FolderWatcher, type IndexUpdatedEvent } from '../src/services/folder-watcher.js';

function waitForEvent<T>(
  emitter: FolderWatcher,
  eventName: 'indexUpdated' | 'watcherReady',
  timeoutMs = 4000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName} event`));
    }, timeoutMs);

    const onEvent = (evt: T) => {
      clearTimeout(timer);
      emitter.off(eventName, onEvent);
      resolve(evt);
    };

    emitter.on(eventName, onEvent);
  });
}

describe('Phase 3: FileIndexer, list-file.md & FolderWatcher', () => {
  let tmpRoot: string;
  let configService: ConfigService;
  let folderService: FolderService;
  let fileIndexer: FileIndexer;
  let folderWatcher: FolderWatcher;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldersync-phase3-'));
    configService = new ConfigService(path.join(tmpRoot, 'config.json'));
    await configService.saveConfig({ deviceName: 'Test-Linux-PC' });
    folderService = new FolderService(configService);
    fileIndexer = new FileIndexer();
    folderWatcher = new FolderWatcher(configService, folderService, fileIndexer, {
      debounceMs: 120,
      lockHoldMs: 500,
    });
  });

  afterEach(async () => {
    await folderWatcher.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('automatically updates list-file.md on file add, modify and delete', async () => {
    const syncDir = path.join(tmpRoot, 'sync-box');
    const readyPromise = waitForEvent(folderWatcher, 'watcherReady');
    await folderService.switchSyncFolder(syncDir, 'POINT_ONLY');
    await readyPromise;

    // 1. Add file
    const addPromise = waitForEvent<IndexUpdatedEvent>(folderWatcher, 'indexUpdated');
    await fs.writeFile(path.join(syncDir, 'readme.txt'), 'Version 1', 'utf-8');
    const addEvent = await addPromise;

    expect(addEvent.document.revision).toBe(1);
    const entryV1 = addEvent.document.entries.find((e) => e.relativePath === 'readme.txt');
    expect(entryV1).toBeDefined();
    expect(entryV1?.status).toBe('ACTIVE');
    expect(entryV1?.updatedBy).toBe('Test-Linux-PC');
    const hashV1 = entryV1?.sha256;
    expect(hashV1).toMatch(/^[a-f0-9]{64}$/);

    // Verify list-file.md exists on disk
    const rawMd = await fs.readFile(path.join(syncDir, LIST_FILE_NAME), 'utf-8');
    expect(rawMd).toContain('`readme.txt`');

    // 2. Modify file
    const modPromise = waitForEvent<IndexUpdatedEvent>(folderWatcher, 'indexUpdated');
    await fs.writeFile(path.join(syncDir, 'readme.txt'), 'Version 2 - Updated!', 'utf-8');
    const modEvent = await modPromise;

    expect(modEvent.document.revision).toBe(2);
    const entryV2 = modEvent.document.entries.find((e) => e.relativePath === 'readme.txt');
    expect(entryV2?.status).toBe('ACTIVE');
    expect(entryV2?.sha256).not.toBe(hashV1);

    // 3. Delete file -> Tombstone DELETED in list-file.md
    const delPromise = waitForEvent<IndexUpdatedEvent>(folderWatcher, 'indexUpdated');
    await fs.unlink(path.join(syncDir, 'readme.txt'));
    const delEvent = await delPromise;

    expect(delEvent.document.revision).toBe(3);
    const entryDel = delEvent.document.entries.find((e) => e.relativePath === 'readme.txt');
    expect(entryDel?.status).toBe('DELETED');
    expect(entryDel?.sha256).toBe('-');
  });

  it('suppresses watcher events during withWriteLock (Anti-Loop protection)', async () => {
    const syncDir = path.join(tmpRoot, 'sync-anti-loop');
    const readyPromise = waitForEvent(folderWatcher, 'watcherReady');
    await folderService.switchSyncFolder(syncDir, 'POINT_ONLY');
    await readyPromise;

    let unexpectedEvents = 0;
    folderWatcher.on('indexUpdated', () => {
      unexpectedEvents += 1;
    });

    await folderWatcher.withWriteLock('incoming.txt', async () => {
      await fs.writeFile(path.join(syncDir, 'incoming.txt'), 'From Remote Peer', 'utf-8');
    });

    // Wait longer than debounceMs to ensure no event was triggered
    await new Promise((r) => setTimeout(r, 250));
    expect(unexpectedEvents).toBe(0);
  });

  it('creates conflict backup file (<name>.conflict-<device>.<ext>) without losing data', async () => {
    const syncDir = path.join(tmpRoot, 'sync-conflict');
    await fs.mkdir(path.join(syncDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(syncDir, 'docs', 'report.md'), 'Local Version', 'utf-8');

    const conflictRelPath = await fileIndexer.createConflictBackup(
      syncDir,
      'docs/report.md',
      'Android-Phone',
    );

    expect(conflictRelPath).toBe('docs/report.conflict-Android-Phone.md');
    const backupContent = await fs.readFile(path.join(syncDir, conflictRelPath), 'utf-8');
    expect(backupContent).toBe('Local Version');
  });

  it('automatically switches watched directory when folderService switches sync folder', async () => {
    const dirA = path.join(tmpRoot, 'dir-a');
    const dirB = path.join(tmpRoot, 'dir-b');

    const readyA = waitForEvent(folderWatcher, 'watcherReady');
    await folderService.switchSyncFolder(dirA, 'POINT_ONLY');
    await readyA;
    expect(folderWatcher.getWatchedFolder()).toBe(dirA);

    const addInA = waitForEvent<IndexUpdatedEvent>(folderWatcher, 'indexUpdated');
    await fs.writeFile(path.join(dirA, 'only-a.txt'), 'File A', 'utf-8');
    await addInA;

    // Now switch sync folder to dirB with COPY_EXISTING
    const readyB = waitForEvent(folderWatcher, 'watcherReady');
    await folderService.switchSyncFolder(dirB, 'COPY_EXISTING');
    await readyB;

    expect(folderWatcher.getWatchedFolder()).toBe(dirB);

    // Add a new file in dirB and verify FolderWatcher picks it up
    const addInB = waitForEvent<IndexUpdatedEvent>(folderWatcher, 'indexUpdated');
    await fs.writeFile(path.join(dirB, 'added-in-b.txt'), 'File B', 'utf-8');
    const evtB = await addInB;

    const docB: ListFileDocument = evtB.document;
    expect(docB.entries.map((e) => e.relativePath)).toContain('only-a.txt');
    expect(docB.entries.map((e) => e.relativePath)).toContain('added-in-b.txt');
  });

  it('ignores transient editor lock/swap/temp files (.lock, ~$, .swp, .tmp, .part)', async () => {
    const syncDir = path.join(tmpRoot, 'sync-editor-locks');
    await fs.mkdir(syncDir, { recursive: true });
    await fs.writeFile(path.join(syncDir, 'real-note.md'), '# Real Note', 'utf-8');
    await fs.writeFile(path.join(syncDir, '.~lock.list-file.md#'), 'libreoffice-lock', 'utf-8');
    await fs.writeFile(path.join(syncDir, '~$budget.xlsx'), 'office-lock', 'utf-8');
    await fs.writeFile(path.join(syncDir, '.real-note.md.swp'), 'vim-swap', 'utf-8');
    await fs.writeFile(path.join(syncDir, 'video.mp4.part'), 'partial-dl', 'utf-8');
    await fs.writeFile(path.join(syncDir, 'scratch.tmp'), 'tmp', 'utf-8');

    const { doc } = await fileIndexer.scanAndSyncLocalListFile(syncDir, 'Test-Linux-PC');
    expect(doc.entries.map((e) => e.relativePath)).toEqual(['real-note.md']);
  });
});
