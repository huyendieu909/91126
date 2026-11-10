import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  DirectoryBrowseResult,
  PublicAppConfig,
  SwitchFolderResult,
} from '@foldersync/shared';
import { ConfigService } from '../src/services/config-service.js';
import { FolderService } from '../src/services/folder-service.js';
import { createAgentHttpServer } from '../src/server.js';

describe('Phase 2: ConfigService, FolderService & HTTP API', () => {
  let tmpRoot: string;
  let configFilePath: string;
  let configService: ConfigService;
  let folderService: FolderService;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foldersync-phase2-'));
    configFilePath = path.join(tmpRoot, 'config.json');
    configService = new ConfigService(configFilePath);
    folderService = new FolderService(configService);
    server = createAgentHttpServer({ configService, folderService });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('detects first-run when syncFolderPath is not configured yet', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as PublicAppConfig;

    expect(data.isFirstRun).toBe(true);
    expect(data.syncFolderPath).toBeNull();
    expect(data.deviceId).toBeTruthy();
  });

  it('allows browsing directories and creating a new folder via API', async () => {
    const newDirTarget = path.join(tmpRoot, 'my-sync-box');
    const mkdirRes = await fetch(`${baseUrl}/api/fs/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newDirTarget }),
    });
    expect(mkdirRes.status).toBe(201);

    const browseRes = await fetch(
      `${baseUrl}/api/fs/browse?path=${encodeURIComponent(tmpRoot)}`,
    );
    expect(browseRes.status).toBe(200);
    const browseData = (await browseRes.json()) as DirectoryBrowseResult;

    expect(browseData.currentPath).toBe(tmpRoot);
    expect(browseData.directories.map((d) => d.name)).toContain('my-sync-box');
  });

  it('sets initial sync folder and transitions isFirstRun to false', async () => {
    const folderA = path.join(tmpRoot, 'folder-a');
    const switchRes = await fetch(`${baseUrl}/api/config/switch-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPath: folderA, mode: 'POINT_ONLY' }),
    });

    expect(switchRes.status).toBe(200);
    const payload = (await switchRes.json()) as {
      result: SwitchFolderResult;
      config: PublicAppConfig;
    };

    expect(payload.result.newPath).toBe(folderA);
    expect(payload.config.isFirstRun).toBe(false);
    expect(payload.config.syncFolderPath).toBe(folderA);
  });

  it('switches sync folder with COPY_EXISTING mode and copies all files (excluding .sync_tmp)', async () => {
    const folderA = path.join(tmpRoot, 'folder-a');
    const folderB = path.join(tmpRoot, 'folder-b');

    await folderService.switchSyncFolder(folderA, 'POINT_ONLY');

    // Create sample files and nested directory inside folderA
    await fs.writeFile(path.join(folderA, 'hello.txt'), 'Hello ck!', 'utf-8');
    await fs.mkdir(path.join(folderA, 'docs'), { recursive: true });
    await fs.writeFile(path.join(folderA, 'docs', 'note.md'), '# Note', 'utf-8');
    // Also create a .sync_tmp file that should NOT be copied
    await fs.mkdir(path.join(folderA, '.sync_tmp'), { recursive: true });
    await fs.writeFile(path.join(folderA, '.sync_tmp', 'partial.bin'), 'temp', 'utf-8');

    const switchRes = await fetch(`${baseUrl}/api/config/switch-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPath: folderB, mode: 'COPY_EXISTING' }),
    });

    expect(switchRes.status).toBe(200);
    const payload = (await switchRes.json()) as {
      result: SwitchFolderResult;
      config: PublicAppConfig;
    };

    expect(payload.result.previousPath).toBe(folderA);
    expect(payload.result.newPath).toBe(folderB);
    expect(payload.result.mode).toBe('COPY_EXISTING');
    expect(payload.result.copiedFilesCount).toBe(2);

    const copiedHello = await fs.readFile(path.join(folderB, 'hello.txt'), 'utf-8');
    const copiedNote = await fs.readFile(path.join(folderB, 'docs', 'note.md'), 'utf-8');
    expect(copiedHello).toBe('Hello ck!');
    expect(copiedNote).toBe('# Note');

    // Verify .sync_tmp was ignored
    await expect(fs.stat(path.join(folderB, '.sync_tmp'))).rejects.toThrow();
  });

  it('switches sync folder with POINT_ONLY mode without copying old files', async () => {
    const folderA = path.join(tmpRoot, 'folder-a');
    const folderC = path.join(tmpRoot, 'folder-c');

    await folderService.switchSyncFolder(folderA, 'POINT_ONLY');
    await fs.writeFile(path.join(folderA, 'keep-in-a.txt'), 'Stay in A', 'utf-8');

    const res = await folderService.switchSyncFolder(folderC, 'POINT_ONLY');
    expect(res.copiedFilesCount).toBe(0);
    expect(res.newPath).toBe(folderC);

    // Old file remains untouched in folderA, and is not in folderC
    const oldContent = await fs.readFile(path.join(folderA, 'keep-in-a.txt'), 'utf-8');
    expect(oldContent).toBe('Stay in A');
    await expect(fs.stat(path.join(folderC, 'keep-in-a.txt'))).rejects.toThrow();
  });

  it('detects existing files in target folder and supports ISOLATE_BACKUP and CREATE_SUBFOLDER strategies', async () => {
    const prePopulatedDir = path.join(tmpRoot, 'existing-data-dir');
    await fs.mkdir(prePopulatedDir, { recursive: true });
    await fs.writeFile(path.join(prePopulatedDir, 'personal-1.txt'), 'Secret 1', 'utf-8');
    await fs.writeFile(path.join(prePopulatedDir, 'personal-2.txt'), 'Secret 2', 'utf-8');

    const browseRes = await fetch(
      `${baseUrl}/api/fs/browse?path=${encodeURIComponent(prePopulatedDir)}`,
    );
    const browseData = (await browseRes.json()) as DirectoryBrowseResult;
    expect(browseData.existingFilesCount).toBe(2);

    // Strategy 1: ISOLATE_BACKUP moves existing files into .unsynced_local_backup
    const isoRes = await fetch(`${baseUrl}/api/config/switch-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newPath: prePopulatedDir,
        mode: 'POINT_ONLY',
        existingDataStrategy: 'ISOLATE_BACKUP',
      }),
    });
    const isoPayload = (await isoRes.json()) as { result: SwitchFolderResult };
    expect(isoPayload.result.isolatedFilesCount).toBe(2);
    expect(isoPayload.result.isolatedBackupPath).toContain('.unsynced_local_backup');
    await expect(fs.stat(path.join(prePopulatedDir, 'personal-1.txt'))).rejects.toThrow();

    // Strategy 2: CREATE_SUBFOLDER creates and points to <dir>/FolderSync
    const subRes = await fetch(`${baseUrl}/api/config/switch-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newPath: prePopulatedDir,
        mode: 'POINT_ONLY',
        existingDataStrategy: 'CREATE_SUBFOLDER',
      }),
    });
    const subPayload = (await subRes.json()) as { result: SwitchFolderResult };
    expect(subPayload.result.newPath).toBe(path.join(prePopulatedDir, 'FolderSync'));
  });
});
