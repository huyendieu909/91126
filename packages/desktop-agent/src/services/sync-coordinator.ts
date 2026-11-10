import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  diffListFiles,
  type FileIndexEntry,
  type ListFileDocument,
  type SyncLogEntry,
  type SyncLogLevel,
  type SyncRunSummary,
  type SyncStatusSnapshot,
} from '@foldersync/shared';
import type { ConfigService } from './config-service.js';
import type { FolderChangedEvent, FolderService } from './folder-service.js';
import type { FileIndexer } from './file-indexer.js';
import type { FolderWatcher, IndexUpdatedEvent } from './folder-watcher.js';
import type { CloudStorageProvider } from './cloud-storage.js';
import type { TelegramRemoteTriggerEvent, TelegramService } from './telegram-service.js';

interface PersistedSyncState {
  folderPath: string | null;
  baselineHashes: Record<string, string>;
  lastSyncedAt: string | null;
}

export class SyncCoordinator extends EventEmitter {
  private isSyncing = false;
  private pendingSyncReason: string | null = null;
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private lastSummary: SyncRunSummary | null = null;
  private readonly logs: SyncLogEntry[] = [];
  private readonly maxLogs = 150;
  private readonly stateFilePath: string;

  private readonly onIndexUpdatedBound: (evt: IndexUpdatedEvent) => void;
  private readonly onFolderChangedBound: (evt: FolderChangedEvent) => void;
  private readonly onTelegramTriggerBound: (evt: TelegramRemoteTriggerEvent) => void;

  constructor(
    private readonly configService: ConfigService,
    private readonly folderService: FolderService,
    private readonly fileIndexer: FileIndexer,
    private readonly folderWatcher: FolderWatcher,
    private readonly cloudProvider: CloudStorageProvider,
    private readonly telegramService?: TelegramService,
  ) {
    super();

    const cfgFile = this.configService.getConfigFilePath();
    this.stateFilePath = path.join(path.dirname(cfgFile), 'sync-state.json');

    this.onIndexUpdatedBound = () => {
      void this.syncNow('LOCAL_WATCHER');
    };

    this.onFolderChangedBound = (evt: FolderChangedEvent) => {
      void this.handleFolderSwitched(evt);
    };

    this.onTelegramTriggerBound = (evt: TelegramRemoteTriggerEvent) => {
      void this.handleTelegramTrigger(evt);
    };

    this.folderWatcher.on('indexUpdated', this.onIndexUpdatedBound);
    this.folderService.on('folderChanged', this.onFolderChangedBound);
    if (this.telegramService) {
      this.telegramService.on('remoteTrigger', this.onTelegramTriggerBound);
    }
  }

  public dispose(): void {
    this.folderWatcher.off('indexUpdated', this.onIndexUpdatedBound);
    this.folderService.off('folderChanged', this.onFolderChangedBound);
    if (this.telegramService) {
      this.telegramService.off('remoteTrigger', this.onTelegramTriggerBound);
    }
  }

  public getLogs(): SyncLogEntry[] {
    return [...this.logs];
  }

  public async getStatus(): Promise<SyncStatusSnapshot> {
    const cfg = await this.configService.loadConfig();
    const cloudReady = await this.cloudProvider.isReady();
    return {
      isSyncing: this.isSyncing,
      cloudReady,
      lastSyncedAt: this.lastSyncedAt,
      lastSyncedRevision: cfg.lastSyncedRevision,
      lastError: this.lastError,
      lastSummary: this.lastSummary,
    };
  }

  private async handleFolderSwitched(evt: FolderChangedEvent): Promise<void> {
    if (evt.mode === 'POINT_ONLY') {
      await this.saveSyncState({
        folderPath: evt.newPath,
        baselineHashes: {},
        lastSyncedAt: this.lastSyncedAt,
      });
      await this.configService.saveConfig({ lastSyncedRevision: 0 });
    } else {
      const prevState = await this.loadSyncState();
      await this.saveSyncState({
        folderPath: evt.newPath,
        baselineHashes: prevState.baselineHashes,
        lastSyncedAt: prevState.lastSyncedAt,
      });
    }

    this.appendLog(
      'INFO',
      'FOLDER_SWITCH',
      `Đã chuyển thư mục đồng bộ sang "${evt.newPath}" (Chế độ: ${evt.mode}).`,
    );

    await this.syncNow('FOLDER_SWITCH');
  }

  private async handleTelegramTrigger(evt: TelegramRemoteTriggerEvent): Promise<void> {
    const cfg = await this.configService.loadConfig();
    if (evt.revision > cfg.lastSyncedRevision) {
      this.appendLog(
        'INFO',
        'TELEGRAM_TRIGGER',
        `Nhận tín hiệu thay đổi từ "${evt.updatedBy}" (Rev #${evt.revision}). Bắt đầu đồng bộ...`,
      );
      await this.syncNow(`TELEGRAM_FROM_${evt.updatedBy}`);
    }
  }

  public async syncNow(reason = 'MANUAL'): Promise<SyncRunSummary | null> {
    if (this.isSyncing) {
      this.pendingSyncReason = reason;
      return this.lastSummary;
    }

    const cfg = await this.configService.loadConfig();
    if (!cfg.syncFolderPath) {
      return null;
    }

    const cloudReady = await this.cloudProvider.isReady();
    if (!cloudReady) {
      return null;
    }

    this.isSyncing = true;
    this.lastError = null;
    this.emit('syncStarted', { reason });

    try {
      const summary = await this.performSyncCycle(cfg.syncFolderPath, cfg.deviceName, reason);
      this.lastSummary = summary;
      this.lastSyncedAt = summary.completedAt;
      this.emit('syncCompleted', summary);
      return summary;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.appendLog('ERROR', 'SYNC_FAILED', `Lỗi đồng bộ (${reason}): ${msg}`);
      this.emit('syncError', { reason, error: msg });
      throw err;
    } finally {
      this.isSyncing = false;
      if (this.pendingSyncReason) {
        const nextReason = this.pendingSyncReason;
        this.pendingSyncReason = null;
        void this.syncNow(nextReason);
      }
    }
  }

  private async performSyncCycle(
    syncFolderPath: string,
    deviceName: string,
    reason: string,
  ): Promise<SyncRunSummary> {
    const persistedState = await this.loadSyncState();
    const baselineHashes =
      persistedState.folderPath === syncFolderPath ? persistedState.baselineHashes : {};

    // 1. Scan local folder to make sure local list-file.md is completely fresh
    const { doc: localDoc } = await this.fileIndexer.scanAndSyncLocalListFile(
      syncFolderPath,
      deviceName,
    );

    // 2. Read remote list-file.md from Google Drive / Cloud
    const remoteExisting = await this.cloudProvider.readRemoteListFile();
    const remoteDoc: ListFileDocument = remoteExisting ?? {
      lastUpdatedAt: new Date(0).toISOString(),
      updatedByDevice: 'None',
      revision: 0,
      knownDevices: [],
      entries: [],
    };

    const knownDevicesSet = new Set<string>(remoteDoc.knownDevices ?? []);
    if (
      remoteDoc.updatedByDevice &&
      remoteDoc.updatedByDevice !== 'None' &&
      remoteDoc.updatedByDevice !== 'Unknown'
    ) {
      knownDevicesSet.add(remoteDoc.updatedByDevice);
    }
    const newDeviceJoined = !knownDevicesSet.has(deviceName);
    knownDevicesSet.add(deviceName);
    const knownDevices = [...knownDevicesSet].sort((a, b) => a.localeCompare(b));

    const localActiveMap = new Map<string, FileIndexEntry>();
    for (const entry of localDoc.entries) {
      if (entry.status === 'ACTIVE') {
        localActiveMap.set(entry.relativePath, entry);
      }
    }

    // 3. Diff local entries vs remote list-file.md using 3-way baselineHashes
    const diff = diffListFiles(localDoc.entries, remoteDoc, baselineHashes);

    const finalEntriesMap = new Map<string, FileIndexEntry>();
    for (const entry of remoteDoc.entries) {
      const localMatch = localActiveMap.get(entry.relativePath);
      if (entry.status === 'ACTIVE' && localMatch && localMatch.sha256 === entry.sha256) {
        const mergedSynced = Array.from(
          new Set([...(entry.syncedDevices ?? [entry.updatedBy]), deviceName]),
        );
        finalEntriesMap.set(entry.relativePath, {
          ...entry,
          syncedDevices: mergedSynced,
        });
      } else if (entry.status === 'DELETED' && !localMatch) {
        const mergedDelSynced = Array.from(
          new Set([...(entry.syncedDevices ?? [entry.updatedBy]), deviceName]),
        );
        finalEntriesMap.set(entry.relativePath, {
          ...entry,
          syncedDevices: mergedDelSynced,
        });
      } else {
        finalEntriesMap.set(entry.relativePath, entry);
      }
    }

    const uploadedPaths: string[] = [];
    const downloadedPaths: string[] = [];
    const deletedLocallyPaths: string[] = [];
    const markedDeletedRemotelyPaths: string[] = [];
    const conflictPaths: string[] = [];
    let requestedReuploadCount = 0;
    let relayPurgedCount = 0;

    // 4A. Resolve Conflicts safely (.conflict-<deviceName>)
    for (const conflict of diff.conflicts) {
      const { relativePath, localEntry, remoteEntry, winner } = conflict;
      conflictPaths.push(relativePath);

      if (winner === 'REMOTE') {
        // Backup local version -> <name>.conflict-<localDevice>.<ext>
        let conflictRelPath = '';
        await this.folderWatcher.withWriteLock(relativePath, async () => {
          conflictRelPath = await this.fileIndexer.createConflictBackup(
            syncFolderPath,
            relativePath,
            deviceName,
          );
          await this.downloadEntryAtomically(syncFolderPath, remoteEntry);
        });

        // Upload the conflict backup file so no device loses it
        const conflictFullPath = path.join(syncFolderPath, ...conflictRelPath.split('/'));
        const conflictStat = await fs.stat(conflictFullPath);
        const conflictHash = await this.fileIndexer.computeFileSha256(conflictFullPath);
        const conflictDriveId = await this.cloudProvider.uploadFile(
          conflictFullPath,
          conflictRelPath,
        );

        finalEntriesMap.set(conflictRelPath, {
          relativePath: conflictRelPath,
          sha256: conflictHash,
          size: conflictStat.size,
          modifiedAt: new Date(Math.floor(conflictStat.mtimeMs)).toISOString(),
          status: 'ACTIVE',
          updatedBy: deviceName,
          driveFileId: conflictDriveId,
          syncedDevices: [deviceName],
          requestUpload: false,
        });
        finalEntriesMap.set(relativePath, {
          ...remoteEntry,
          syncedDevices: Array.from(
            new Set([...(remoteEntry.syncedDevices ?? [remoteEntry.updatedBy]), deviceName]),
          ),
          requestUpload: false,
        });
        downloadedPaths.push(relativePath);
        uploadedPaths.push(conflictRelPath);

        this.appendLog(
          'WARN',
          'CONFLICT_RESOLVED',
          `Xung đột tại "${relativePath}": Giữ bản mới hơn từ ${remoteEntry.updatedBy}, lưu bản máy này thành "${conflictRelPath}".`,
        );
      } else {
        // LOCAL wins! Download remote's version into <name>.conflict-<remoteDevice>.<ext>
        const parsedRel = path.posix.parse(relativePath);
        const safeRemoteDev =
          remoteEntry.updatedBy.replace(/[^a-zA-Z0-9_-]/g, '_') || 'remote';
        const conflictBaseName = `${parsedRel.name}.conflict-${safeRemoteDev}${parsedRel.ext}`;
        const conflictRelPath = parsedRel.dir
          ? `${parsedRel.dir}/${conflictBaseName}`
          : conflictBaseName;

        const remoteConflictEntry: FileIndexEntry = {
          ...remoteEntry,
          relativePath: conflictRelPath,
        };

        await this.folderWatcher.withWriteLock(conflictRelPath, async () => {
          await this.downloadEntryAtomically(syncFolderPath, remoteConflictEntry);
        });

        // Upload remote conflict backup under its new conflictRelPath
        const conflictFullPath = path.join(syncFolderPath, ...conflictRelPath.split('/'));
        const conflictDriveId = await this.cloudProvider.uploadFile(
          conflictFullPath,
          conflictRelPath,
        );
        finalEntriesMap.set(conflictRelPath, {
          ...remoteConflictEntry,
          driveFileId: conflictDriveId,
          syncedDevices: [deviceName],
          requestUpload: false,
        });

        // Upload winning local version as main file
        const localFullPath = path.join(syncFolderPath, ...relativePath.split('/'));
        const mainDriveId = await this.cloudProvider.uploadFile(
          localFullPath,
          relativePath,
          remoteEntry.driveFileId,
        );
        finalEntriesMap.set(relativePath, {
          ...localEntry,
          updatedBy: deviceName,
          driveFileId: mainDriveId,
          syncedDevices: [deviceName],
          requestUpload: false,
        });

        uploadedPaths.push(relativePath, conflictRelPath);

        this.appendLog(
          'WARN',
          'CONFLICT_RESOLVED',
          `Xung đột tại "${relativePath}": Giữ bản mới hơn của máy này, lưu bản của ${remoteEntry.updatedBy} thành "${conflictRelPath}".`,
        );
      }
    }

    // 4B. Download files missing or updated on remote (or request re-upload if relay already purged)
    for (const remoteEntry of diff.toDownload) {
      if (!remoteEntry.driveFileId || remoteEntry.driveFileId === '-') {
        const filteredSynced = (remoteEntry.syncedDevices ?? [remoteEntry.updatedBy]).filter(
          (d) => d !== deviceName,
        );
        finalEntriesMap.set(remoteEntry.relativePath, {
          ...remoteEntry,
          syncedDevices: filteredSynced,
          requestUpload: true,
        });
        requestedReuploadCount += 1;
        this.appendLog(
          'INFO',
          'RELAY_REQUEST_UPLOAD',
          `File "${remoteEntry.relativePath}" đã tự hủy trên trạm trung chuyển. Đã gửi yêu cầu máy gốc đẩy lại tạm thời.`,
        );
        continue;
      }

      await this.folderWatcher.withWriteLock(remoteEntry.relativePath, async () => {
        await this.downloadEntryAtomically(syncFolderPath, remoteEntry);
      });
      const nextSynced = Array.from(
        new Set([...(remoteEntry.syncedDevices ?? [remoteEntry.updatedBy]), deviceName]),
      );
      finalEntriesMap.set(remoteEntry.relativePath, {
        ...remoteEntry,
        syncedDevices: nextSynced,
        requestUpload: false,
      });
      downloadedPaths.push(remoteEntry.relativePath);
      this.appendLog(
        'SUCCESS',
        'DOWNLOAD',
        `Đã tải về "${remoteEntry.relativePath}" (từ ${remoteEntry.updatedBy}).`,
      );
    }

    // 4C. Delete local files marked DELETED on remote
    for (const remoteDel of diff.toDeleteLocally) {
      const targetFullPath = path.join(syncFolderPath, ...remoteDel.relativePath.split('/'));
      await this.folderWatcher.withWriteLock(remoteDel.relativePath, async () => {
        await fs.rm(targetFullPath, { force: true });
      });
      const nextDelSynced = Array.from(
        new Set([...(remoteDel.syncedDevices ?? [remoteDel.updatedBy]), deviceName]),
      );
      finalEntriesMap.set(remoteDel.relativePath, {
        ...remoteDel,
        syncedDevices: nextDelSynced,
      });
      deletedLocallyPaths.push(remoteDel.relativePath);
      this.appendLog(
        'INFO',
        'DELETE_LOCAL',
        `Đã xóa file nội bộ "${remoteDel.relativePath}" (theo lệnh xóa từ ${remoteDel.updatedBy}).`,
      );
    }

    // 4D. Upload newly added or modified local files
    for (const localEntry of diff.toUpload) {
      const localFullPath = path.join(syncFolderPath, ...localEntry.relativePath.split('/'));
      const prevRemote = finalEntriesMap.get(localEntry.relativePath);
      const driveFileId = await this.cloudProvider.uploadFile(
        localFullPath,
        localEntry.relativePath,
        prevRemote?.driveFileId,
      );

      const updatedEntry: FileIndexEntry = {
        ...localEntry,
        updatedBy: deviceName,
        driveFileId,
        syncedDevices: [deviceName],
        requestUpload: false,
      };
      finalEntriesMap.set(localEntry.relativePath, updatedEntry);
      uploadedPaths.push(localEntry.relativePath);
      this.appendLog('SUCCESS', 'UPLOAD', `Đã đẩy lên "${localEntry.relativePath}".`);
    }

    // 4E. Fulfill any relay re-upload requests from new/switched devices if this device holds the file locally
    for (const entry of finalEntriesMap.values()) {
      if (
        entry.status === 'ACTIVE' &&
        (!entry.driveFileId || entry.driveFileId === '-') &&
        entry.requestUpload
      ) {
        const localMatch = localActiveMap.get(entry.relativePath);
        if (localMatch && localMatch.sha256 === entry.sha256) {
          const localFullPath = path.join(syncFolderPath, ...entry.relativePath.split('/'));
          const reuploadedDriveId = await this.cloudProvider.uploadFile(
            localFullPath,
            entry.relativePath,
          );
          const mergedSynced = Array.from(
            new Set([...(entry.syncedDevices ?? []), deviceName]),
          );
          finalEntriesMap.set(entry.relativePath, {
            ...entry,
            driveFileId: reuploadedDriveId,
            syncedDevices: mergedSynced,
            requestUpload: false,
          });
          uploadedPaths.push(entry.relativePath);
          this.appendLog(
            'INFO',
            'RELAY_REUPLOAD',
            `Đã đẩy tạm lại "${entry.relativePath}" lên trạm trung chuyển cho thiết bị mới.`,
          );
        }
      }
    }

    // 4F. Propagate local deletions to remote list-file.md
    for (const localDel of diff.toMarkDeletedRemotely) {
      const prevRemote = finalEntriesMap.get(localDel.relativePath);
      if (prevRemote?.driveFileId && prevRemote.driveFileId !== '-') {
        await this.cloudProvider.deleteRemoteFile(prevRemote.driveFileId);
      }

      const tombstone: FileIndexEntry = {
        relativePath: localDel.relativePath,
        sha256: '-',
        size: 0,
        modifiedAt: localDel.modifiedAt,
        status: 'DELETED',
        updatedBy: deviceName,
        driveFileId: '-',
        syncedDevices: [deviceName],
        requestUpload: false,
      };
      finalEntriesMap.set(localDel.relativePath, tombstone);
      markedDeletedRemotelyPaths.push(localDel.relativePath);
      this.appendLog(
        'INFO',
        'MARK_DELETED_REMOTE',
        `Đã đánh dấu xóa "${localDel.relativePath}" trên list-file.md.`,
      );
    }

    // 4G. Ephemeral Relay Auto-Purge & DELETED Tombstone Cleanup once all knownDevices (>= 2) have synced!
    if (knownDevices.length >= 2) {
      for (const entry of [...finalEntriesMap.values()]) {
        const syncedList = entry.syncedDevices ?? [entry.updatedBy];
        const allKnownSynced = knownDevices.every((dev) => syncedList.includes(dev));

        if (!allKnownSynced) {
          continue;
        }

        if (entry.status === 'DELETED') {
          finalEntriesMap.delete(entry.relativePath);
          relayPurgedCount += 1;
          this.appendLog(
            'INFO',
            'TOMBSTONE_PURGED',
            `🧹 Đã xóa hẳn dòng DELETED của "${entry.relativePath}" khỏi list-file.md (tất cả ${knownDevices.length} thiết bị đã xóa xong).`,
          );
          continue;
        }

        if (
          entry.status === 'ACTIVE' &&
          entry.driveFileId &&
          entry.driveFileId !== '-' &&
          !entry.requestUpload
        ) {
          await this.cloudProvider.deleteRemoteFile(entry.driveFileId);
          finalEntriesMap.set(entry.relativePath, {
            ...entry,
            driveFileId: '-',
            syncedDevices: syncedList,
            requestUpload: false,
          });
          relayPurgedCount += 1;
          this.appendLog(
            'INFO',
            'RELAY_PURGED',
            `🧹 Trạm trung chuyển: Đã tự hủy bản tạm "${entry.relativePath}" trên Google Drive (tất cả ${knownDevices.length} thiết bị đã nhận đủ).`,
          );
        }
      }
    }

    // 5. Finalize list-file.md & baseline hashes
    const pushedChanges =
      uploadedPaths.length > 0 ||
      markedDeletedRemotelyPaths.length > 0 ||
      conflictPaths.length > 0 ||
      requestedReuploadCount > 0;

    const shouldWriteRemote =
      pushedChanges ||
      relayPurgedCount > 0 ||
      newDeviceJoined ||
      (!remoteExisting && finalEntriesMap.size > 0);

    const nowIso = new Date().toISOString();
    const nextRevision = pushedChanges ? remoteDoc.revision + 1 : remoteDoc.revision;

    const sortedEntries = [...finalEntriesMap.values()].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );

    const finalDoc: ListFileDocument = {
      lastUpdatedAt: pushedChanges || relayPurgedCount > 0 ? nowIso : remoteDoc.lastUpdatedAt,
      updatedByDevice: pushedChanges ? deviceName : remoteDoc.updatedByDevice,
      revision: nextRevision,
      knownDevices,
      entries: sortedEntries,
    };

    if (shouldWriteRemote) {
      await this.cloudProvider.writeRemoteListFile(finalDoc);

      if (this.telegramService && pushedChanges) {
        this.telegramService.queueSyncNotification({
          deviceName,
          revision: nextRevision,
          uploadedPaths,
          deletedPaths: markedDeletedRemotelyPaths,
          conflictPaths,
        });
      }
    }

    await this.fileIndexer.writeLocalListFile(syncFolderPath, finalDoc);

    const nextBaseline: Record<string, string> = {};
    for (const entry of finalDoc.entries) {
      const hasFileLocally = !entry.syncedDevices || entry.syncedDevices.includes(deviceName);
      if (
        entry.status === 'ACTIVE' &&
        entry.sha256 &&
        entry.sha256 !== '-' &&
        hasFileLocally
      ) {
        nextBaseline[entry.relativePath] = entry.sha256;
      }
    }

    await this.saveSyncState({
      folderPath: syncFolderPath,
      baselineHashes: nextBaseline,
      lastSyncedAt: nowIso,
    });

    await this.configService.saveConfig({ lastSyncedRevision: nextRevision });

    return {
      reason,
      uploadedCount: uploadedPaths.length,
      downloadedCount: downloadedPaths.length,
      deletedLocallyCount: deletedLocallyPaths.length,
      markedDeletedRemotelyCount: markedDeletedRemotelyPaths.length,
      conflictsCount: conflictPaths.length,
      revision: nextRevision,
      completedAt: nowIso,
    };
  }

  private async downloadEntryAtomically(
    syncFolderPath: string,
    entry: FileIndexEntry,
  ): Promise<void> {
    const tmpDir = path.join(syncFolderPath, '.sync_tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFilePath = path.join(tmpDir, `dl_${crypto.randomUUID()}.tmp`);
    const finalFilePath = path.join(syncFolderPath, ...entry.relativePath.split('/'));

    await this.cloudProvider.downloadFile(entry.driveFileId, tmpFilePath);
    await fs.mkdir(path.dirname(finalFilePath), { recursive: true });
    await fs.rename(tmpFilePath, finalFilePath);

    const mtimeDate = new Date(entry.modifiedAt);
    if (!Number.isNaN(mtimeDate.getTime())) {
      await fs.utimes(finalFilePath, mtimeDate, mtimeDate);
    }
  }

  private appendLog(level: SyncLogLevel, action: string, message: string): void {
    const entry: SyncLogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      action,
      message,
    };
    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.length = this.maxLogs;
    }
    this.emit('logAdded', entry);
  }

  private async loadSyncState(): Promise<PersistedSyncState> {
    try {
      const raw = await fs.readFile(this.stateFilePath, 'utf-8');
      return JSON.parse(raw) as PersistedSyncState;
    } catch {
      return {
        folderPath: null,
        baselineHashes: {},
        lastSyncedAt: null,
      };
    }
  }

  private async saveSyncState(state: PersistedSyncState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const tmp = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmp, this.stateFilePath);
  }
}
