import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_ZONE_ID,
  DEFAULT_ZONE_NAME,
  diffListFiles,
  slugifyZoneId,
  type ExistingDataStrategy,
  type FileIndexEntry,
  type ListFileDocument,
  type LocalZoneBinding,
  type SyncLogEntry,
  type SyncLogLevel,
  type SyncProgress,
  type SyncProgressPhase,
  type SyncRunSummary,
  type SyncStatusSnapshot,
  type SyncZoneMetadata,
} from '@foldersync/shared';
import type { ConfigService } from './config-service.js';
import type { FolderChangedEvent, FolderService } from './folder-service.js';
import type { FileIndexer } from './file-indexer.js';
import type { FolderWatcher, IndexUpdatedEvent } from './folder-watcher.js';
import type { CloudStorageProvider } from './cloud-storage.js';
import type {
  TelegramNotificationErrorEvent,
  TelegramNotificationSentEvent,
  TelegramRemoteTriggerEvent,
  TelegramService,
} from './telegram-service.js';

interface ZoneBaselineRecord {
  folderPath: string | null;
  baselineHashes: Record<string, string>;
  lastSyncedAt: string | null;
}

interface PersistedSyncState {
  folderPath: string | null;
  baselineHashes: Record<string, string>;
  lastSyncedAt: string | null;
  zoneBaselines?: Record<string, ZoneBaselineRecord>;
}

export class SyncCoordinator extends EventEmitter {
  private isSyncing = false;
  private isPollingBg = false;
  private bgTimer: NodeJS.Timeout | null = null;
  private suppressFolderSwitchEvent = false;
  private pendingSyncReason: string | null = null;
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private lastSummary: SyncRunSummary | null = null;
  private currentProgress: SyncProgress | null = null;
  private readonly logs: SyncLogEntry[] = [];
  private readonly maxLogs = 150;
  private readonly stateFilePath: string;
  private readonly transferConcurrency = 3;

  private readonly onIndexUpdatedBound: (evt: IndexUpdatedEvent) => void;
  private readonly onFolderChangedBound: (evt: FolderChangedEvent) => void;
  private readonly onTelegramTriggerBound: (evt: TelegramRemoteTriggerEvent) => void;
  private readonly onTelegramSentBound: (evt: TelegramNotificationSentEvent) => void;
  private readonly onTelegramErrorBound: (evt: TelegramNotificationErrorEvent) => void;

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

    this.onIndexUpdatedBound = (evt: IndexUpdatedEvent) => {
      if (this.suppressFolderSwitchEvent) {
        return;
      }
      if (evt.zoneId) {
        void this.syncZone(evt.zoneId, 'LOCAL_WATCHER').catch(() => undefined);
      } else {
        void this.syncNow('LOCAL_WATCHER').catch(() => undefined);
      }
    };

    this.onFolderChangedBound = (evt: FolderChangedEvent) => {
      void this.handleFolderSwitched(evt).catch(() => undefined);
    };

    this.onTelegramTriggerBound = (evt: TelegramRemoteTriggerEvent) => {
      void this.handleTelegramTrigger(evt).catch(() => undefined);
    };

    this.onTelegramSentBound = (evt: TelegramNotificationSentEvent) => {
      this.appendLog(
        'SUCCESS',
        'TELEGRAM_SENT',
        `📨 Đã gửi thông báo đồng bộ Rev #${evt.revision} về Telegram (Chat ID: ${evt.chatId}).`,
      );
    };

    this.onTelegramErrorBound = (evt: TelegramNotificationErrorEvent) => {
      this.appendLog(
        'WARN',
        'TELEGRAM_ERROR',
        `⚠️ Không gửi được thông báo Telegram (Chat ID: ${evt.chatId}): ${evt.error}`,
      );
    };

    this.folderWatcher.on('indexUpdated', this.onIndexUpdatedBound);
    this.folderService.on('folderChanged', this.onFolderChangedBound);
    if (this.telegramService) {
      this.telegramService.on('remoteTrigger', this.onTelegramTriggerBound);
      this.telegramService.on('notificationSent', this.onTelegramSentBound);
      this.telegramService.on('notificationError', this.onTelegramErrorBound);
    }
  }

  public dispose(): void {
    this.stopBackgroundSync();
    this.folderWatcher.off('indexUpdated', this.onIndexUpdatedBound);
    this.folderService.off('folderChanged', this.onFolderChangedBound);
    if (this.telegramService) {
      this.telegramService.off('remoteTrigger', this.onTelegramTriggerBound);
      this.telegramService.off('notificationSent', this.onTelegramSentBound);
      this.telegramService.off('notificationError', this.onTelegramErrorBound);
    }
  }

  /**
   * Khởi chạy bộ kiểm tra đồng bộ ngầm 2 chiều định kỳ cho tất cả các Vùng đang tham gia (joined: true),
   * hoạt động độc lập kể cả khi người dùng chưa bật Telegram Bot.
   */
  public startBackgroundSync(intervalMs = 15000): void {
    if (this.bgTimer) return;
    this.bgTimer = setInterval(() => {
      void this.pollRemoteChangesOnce();
    }, intervalMs);
  }

  public stopBackgroundSync(): void {
    if (this.bgTimer) {
      clearInterval(this.bgTimer);
      this.bgTimer = null;
    }
  }

  public async pollRemoteChangesOnce(): Promise<boolean> {
    if (this.isSyncing || this.isPollingBg) return false;
    this.isPollingBg = true;
    let triggered = false;

    try {
      await this.folderWatcher.syncWatchedZones();
      const cloudReady = await this.cloudProvider.isReady();
      if (!cloudReady) return false;

      const cfg = await this.configService.loadConfig();
      const targets: Array<{ zoneId: string; localFolderPath: string; lastRev: number }> = [];

      const joinedZones = (cfg.zones ?? []).filter((z) => z.joined && z.localFolderPath);
      if (joinedZones.length > 0) {
        for (const z of joinedZones) {
          targets.push({
            zoneId: z.zoneId,
            localFolderPath: z.localFolderPath!,
            lastRev: z.lastSyncedRevision ?? 0,
          });
        }
      } else if (cfg.syncFolderPath) {
        targets.push({
          zoneId: cfg.activeZoneId || DEFAULT_ZONE_ID,
          localFolderPath: cfg.syncFolderPath,
          lastRev: cfg.lastSyncedRevision ?? 0,
        });
      }

      for (const target of targets) {
        const remoteDoc = await this.cloudProvider.readRemoteListFile(target.zoneId);
        if (!remoteDoc) continue;

        const knownList = remoteDoc.knownDevices ?? [];
        const missingSelfInKnown = !knownList.includes(cfg.deviceName);
        const revChanged = remoteDoc.revision > target.lastRev;
        const hasPendingForSelf = remoteDoc.entries.some((e) => {
          const synced = e.syncedDevices ?? [e.updatedBy];
          if (!synced.includes(cfg.deviceName)) return true;
          if (e.requestUpload) return true;
          if (
            knownList.length >= 2 &&
            knownList.every((d) => synced.includes(d)) &&
            (e.status === 'DELETED' || (e.driveFileId && e.driveFileId !== '-'))
          ) {
            return true;
          }
          return false;
        });

        if (revChanged || missingSelfInKnown || hasPendingForSelf) {
          await this.syncZone(target.zoneId, 'BACKGROUND_POLL');
          triggered = true;
        }
      }

      return triggered;
    } catch {
      return false;
    } finally {
      this.isPollingBg = false;
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
      progress: this.currentProgress,
    };
  }

  private setProgress(
    phase: SyncProgressPhase,
    current = 0,
    total = 0,
    currentPath?: string | null,
    message?: string,
  ): void {
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    this.currentProgress = { phase, current, total, currentPath, message, percent };
    this.emit('syncProgress', this.currentProgress);
  }

  private clearProgress(): void {
    if (this.currentProgress) {
      this.currentProgress = null;
      this.emit('syncProgress', null);
    }
  }

  private async runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    const limit = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;
    const runners = Array.from({ length: limit }, async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        await worker(items[idx], idx);
      }
    });
    await Promise.all(runners);
  }

  private async handleFolderSwitched(evt: FolderChangedEvent): Promise<void> {
    if (this.suppressFolderSwitchEvent) {
      return;
    }
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
    const activeZoneId = cfg.activeZoneId || DEFAULT_ZONE_ID;
    const joinedZones = (cfg.zones ?? []).filter((z) => z.joined && z.localFolderPath);

    if (!cfg.syncFolderPath && joinedZones.length === 0) {
      return null;
    }

    const cloudReady = await this.cloudProvider.isReady();
    if (!cloudReady) {
      return null;
    }

    this.isSyncing = true;
    this.lastError = null;
    this.setProgress('PREPARING', 0, 0, null, 'Chuẩn bị đồng bộ...');
    this.emit('syncStarted', { reason });

    try {
      let primarySummary: SyncRunSummary | null = null;
      if (cfg.syncFolderPath) {
        primarySummary = await this.performSyncCycle(
          cfg.syncFolderPath,
          cfg.deviceName,
          reason,
          activeZoneId,
        );
      }

      // Sync any other joined zones
      for (const z of joinedZones) {
        if (z.zoneId !== activeZoneId && z.localFolderPath) {
          const zSummary = await this.performSyncCycle(
            z.localFolderPath,
            cfg.deviceName,
            `${reason}_ZONE_${z.zoneId}`,
            z.zoneId,
          );
          if (!primarySummary) {
            primarySummary = zSummary;
          }
        }
      }

      if (primarySummary) {
        this.lastSummary = primarySummary;
        this.lastSyncedAt = primarySummary.completedAt;
        this.emit('syncCompleted', primarySummary);
      }
      return primarySummary;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.appendLog('ERROR', 'SYNC_FAILED', `Lỗi đồng bộ (${reason}): ${msg}`);
      this.emit('syncError', { reason, error: msg });
      throw err;
    } finally {
      this.isSyncing = false;
      this.clearProgress();
      if (this.pendingSyncReason) {
        const nextReason = this.pendingSyncReason;
        this.pendingSyncReason = null;
        void this.syncNow(nextReason).catch(() => undefined);
      }
    }
  }

  public async discoverZones(): Promise<LocalZoneBinding[]> {
    const cfg = await this.configService.loadConfig();
    const localMap = new Map<string, LocalZoneBinding>();
    for (const z of cfg.zones ?? []) {
      localMap.set(z.zoneId, { ...z });
    }

    const cloudReady = await this.cloudProvider.isReady();
    if (cloudReady && this.cloudProvider.readZonesRegistry) {
      try {
        const reg = await this.cloudProvider.readZonesRegistry();
        let registryChanged = false;

        // If default zone is locally configured but not yet in remote registry, register it
        if (
          localMap.has(DEFAULT_ZONE_ID) &&
          !reg.zones.some((rz) => rz.zoneId === DEFAULT_ZONE_ID)
        ) {
          const defLocal = localMap.get(DEFAULT_ZONE_ID)!;
          const folderId = this.cloudProvider.ensureZoneFolder
            ? await this.cloudProvider.ensureZoneFolder(DEFAULT_ZONE_ID, DEFAULT_ZONE_NAME)
            : defLocal.driveFolderId || 'default';
          reg.zones.push({
            zoneId: DEFAULT_ZONE_ID,
            zoneName: defLocal.zoneName || DEFAULT_ZONE_NAME,
            driveFolderId: folderId,
            listFileDriveId: defLocal.listFileDriveId,
            createdAt: new Date().toISOString(),
            createdBy: cfg.deviceName,
            memberDevices: Array.from(new Set([...(defLocal.memberDevices ?? []), cfg.deviceName])),
          });
          registryChanged = true;
        }

        for (const rz of reg.zones) {
          const existingLocal = localMap.get(rz.zoneId);
          if (existingLocal) {
            localMap.set(rz.zoneId, {
              ...existingLocal,
              zoneName: rz.zoneName || existingLocal.zoneName,
              description: rz.description ?? existingLocal.description,
              driveFolderId: rz.driveFolderId || existingLocal.driveFolderId,
              listFileDriveId: rz.listFileDriveId ?? existingLocal.listFileDriveId,
              memberDevices: rz.memberDevices,
            });
          } else {
            localMap.set(rz.zoneId, {
              zoneId: rz.zoneId,
              zoneName: rz.zoneName,
              description: rz.description,
              joined: false,
              localFolderPath: null,
              driveFolderId: rz.driveFolderId,
              listFileDriveId: rz.listFileDriveId,
              lastSyncedRevision: 0,
              lastSyncedAt: null,
              memberDevices: rz.memberDevices,
            });
          }
        }

        if (registryChanged && this.cloudProvider.writeZonesRegistry) {
          reg.updatedAt = new Date().toISOString();
          await this.cloudProvider.writeZonesRegistry(reg);
        }
      } catch {
        // Ignore cloud discovery errors when offline
      }
    }

    const mergedZones = [...localMap.values()];
    await this.configService.saveConfig({ zones: mergedZones });
    return mergedZones;
  }

  public async createZone(params: {
    zoneName: string;
    description?: string;
    localFolderPath: string;
    existingDataStrategy?: ExistingDataStrategy;
  }): Promise<LocalZoneBinding> {
    const cfg = await this.configService.loadConfig();
    const baseSlug = slugifyZoneId(params.zoneName);
    const existingIds = new Set((cfg.zones ?? []).map((z) => z.zoneId));
    const zoneId = existingIds.has(baseSlug) ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;

    // Switch/prepare local folder with existing data protection strategy
    this.suppressFolderSwitchEvent = true;
    let finalLocalPath = params.localFolderPath;
    let newBinding: LocalZoneBinding;
    let cloudReady = false;
    try {
      const switchRes = await this.folderService.switchSyncFolder(
        params.localFolderPath,
        'POINT_ONLY',
        params.existingDataStrategy ?? 'MERGE_ALL',
      );
      finalLocalPath = switchRes.newPath;

      let driveFolderId = `folder_${zoneId}`;
      cloudReady = await this.cloudProvider.isReady();
      if (cloudReady && this.cloudProvider.ensureZoneFolder) {
        driveFolderId = await this.cloudProvider.ensureZoneFolder(zoneId, params.zoneName);
      }

      newBinding = {
        zoneId,
        zoneName: params.zoneName.trim() || zoneId,
        description: params.description?.trim() || undefined,
        joined: true,
        localFolderPath: finalLocalPath,
        driveFolderId,
        listFileDriveId: null,
        lastSyncedRevision: 0,
        lastSyncedAt: null,
        memberDevices: [cfg.deviceName],
      };

      const refreshedCfg = await this.configService.loadConfig();
      const nextZones = [
        ...(refreshedCfg.zones ?? []).filter((z) => z.zoneId !== zoneId),
        newBinding,
      ];
      await this.configService.saveConfig({
        activeZoneId: zoneId,
        syncFolderPath: finalLocalPath,
        lastSyncedRevision: 0,
        zones: nextZones,
      });

      if (
        cloudReady &&
        this.cloudProvider.readZonesRegistry &&
        this.cloudProvider.writeZonesRegistry
      ) {
        const reg = await this.cloudProvider.readZonesRegistry();
        const filtered = reg.zones.filter((z) => z.zoneId !== zoneId);
        const meta: SyncZoneMetadata = {
          zoneId,
          zoneName: newBinding.zoneName,
          description: newBinding.description,
          driveFolderId,
          listFileDriveId: null,
          createdAt: new Date().toISOString(),
          createdBy: cfg.deviceName,
          memberDevices: [cfg.deviceName],
        };
        await this.cloudProvider.writeZonesRegistry({
          updatedAt: new Date().toISOString(),
          zones: [...filtered, meta],
        });
      }

      this.appendLog(
        'SUCCESS',
        'ZONE_CREATED',
        `✨ Đã tạo vùng đồng bộ mới "${newBinding.zoneName}" (${zoneId}) tại "${finalLocalPath}".`,
      );

      await this.folderWatcher.syncWatchedZones();
    } finally {
      this.suppressFolderSwitchEvent = false;
    }

    if (cloudReady) {
      await this.syncZone(zoneId, 'ZONE_CREATED');
    }

    const latestCfg = await this.configService.loadConfig();
    return latestCfg.zones?.find((z) => z.zoneId === zoneId) ?? newBinding;
  }

  public async joinZone(params: {
    zoneId: string;
    localFolderPath: string;
    existingDataStrategy?: ExistingDataStrategy;
  }): Promise<LocalZoneBinding> {
    await this.discoverZones();
    const cfg = await this.configService.loadConfig();
    const existing = (cfg.zones ?? []).find((z) => z.zoneId === params.zoneId);

    this.suppressFolderSwitchEvent = true;
    let joinedBinding: LocalZoneBinding;
    let cloudReady = false;
    try {
      const switchRes = await this.folderService.switchSyncFolder(
        params.localFolderPath,
        'POINT_ONLY',
        params.existingDataStrategy ?? 'MERGE_ALL',
      );
      const finalLocalPath = switchRes.newPath;

      const updatedMembers = Array.from(
        new Set([...(existing?.memberDevices ?? []), cfg.deviceName]),
      );

      joinedBinding = {
        zoneId: params.zoneId,
        zoneName: existing?.zoneName || params.zoneId,
        description: existing?.description,
        joined: true,
        localFolderPath: finalLocalPath,
        driveFolderId: existing?.driveFolderId ?? null,
        listFileDriveId: existing?.listFileDriveId ?? null,
        lastSyncedRevision: 0,
        lastSyncedAt: null,
        memberDevices: updatedMembers,
      };

      const nextZones = [
        ...(cfg.zones ?? []).filter((z) => z.zoneId !== params.zoneId),
        joinedBinding,
      ];
      await this.configService.saveConfig({
        activeZoneId: params.zoneId,
        syncFolderPath: finalLocalPath,
        lastSyncedRevision: 0,
        zones: nextZones,
      });

      cloudReady = await this.cloudProvider.isReady();
      if (
        cloudReady &&
        this.cloudProvider.readZonesRegistry &&
        this.cloudProvider.writeZonesRegistry
      ) {
        const reg = await this.cloudProvider.readZonesRegistry();
        const idx = reg.zones.findIndex((z) => z.zoneId === params.zoneId);
        if (idx >= 0) {
          reg.zones[idx].memberDevices = Array.from(
            new Set([...reg.zones[idx].memberDevices, cfg.deviceName]),
          );
          reg.updatedAt = new Date().toISOString();
          await this.cloudProvider.writeZonesRegistry(reg);
        }
      }

      this.appendLog(
        'SUCCESS',
        'ZONE_JOINED',
        `🤝 Đã tham gia vùng đồng bộ "${joinedBinding.zoneName}" (${params.zoneId}) -> "${finalLocalPath}".`,
      );

      await this.folderWatcher.syncWatchedZones();
    } finally {
      this.suppressFolderSwitchEvent = false;
    }

    if (cloudReady) {
      await this.syncZone(params.zoneId, 'ZONE_JOINED');
    }

    const latestCfg = await this.configService.loadConfig();
    return latestCfg.zones?.find((z) => z.zoneId === params.zoneId) ?? joinedBinding;
  }

  public async leaveZone(zoneId: string): Promise<LocalZoneBinding[]> {
    const cfg = await this.configService.loadConfig();
    const zones = [...(cfg.zones ?? [])];
    const idx = zones.findIndex((z) => z.zoneId === zoneId);
    if (idx >= 0) {
      zones[idx] = {
        ...zones[idx],
        joined: false,
        memberDevices: (zones[idx].memberDevices ?? []).filter((d) => d !== cfg.deviceName),
      };
    }

    // Remove this device from remote zones-registry.json and remote list-file.md knownDevices
    const cloudReady = await this.cloudProvider.isReady();
    if (cloudReady) {
      if (this.cloudProvider.readZonesRegistry && this.cloudProvider.writeZonesRegistry) {
        const reg = await this.cloudProvider.readZonesRegistry();
        const rIdx = reg.zones.findIndex((z) => z.zoneId === zoneId);
        if (rIdx >= 0) {
          reg.zones[rIdx].memberDevices = reg.zones[rIdx].memberDevices.filter(
            (d) => d !== cfg.deviceName,
          );
          reg.updatedAt = new Date().toISOString();
          await this.cloudProvider.writeZonesRegistry(reg);
        }
      }

      const remoteDoc = await this.cloudProvider.readRemoteListFile(zoneId);
      if (remoteDoc) {
        const nextKnown = (remoteDoc.knownDevices ?? []).filter((d) => d !== cfg.deviceName);
        const nextEntries = remoteDoc.entries.map((e) => ({
          ...e,
          syncedDevices: (e.syncedDevices ?? []).filter((d) => d !== cfg.deviceName),
        }));
        await this.cloudProvider.writeRemoteListFile(
          {
            ...remoteDoc,
            knownDevices: nextKnown,
            entries: nextEntries,
          },
          zoneId,
        );
      }
    }

    const anotherJoined = zones.find((z) => z.joined && z.localFolderPath);
    const nextActiveId =
      cfg.activeZoneId === zoneId ? (anotherJoined?.zoneId ?? DEFAULT_ZONE_ID) : cfg.activeZoneId;
    const nextFolderPath =
      cfg.activeZoneId === zoneId ? (anotherJoined?.localFolderPath ?? null) : cfg.syncFolderPath;

    await this.configService.saveConfig({
      activeZoneId: nextActiveId,
      syncFolderPath: nextFolderPath,
      zones,
    });
    await this.folderWatcher.syncWatchedZones();

    this.appendLog('INFO', 'ZONE_LEFT', `👋 Đã rời khỏi vùng đồng bộ "${zoneId}".`);
    return zones;
  }

  public async activateZone(zoneId: string): Promise<LocalZoneBinding> {
    const cfg = await this.configService.loadConfig();
    const target = (cfg.zones ?? []).find((z) => z.zoneId === zoneId);
    if (!target || !target.joined || !target.localFolderPath) {
      throw new Error(`Chưa tham gia hoặc chưa chọn thư mục cho vùng "${zoneId}".`);
    }

    await this.configService.saveConfig({
      activeZoneId: zoneId,
      syncFolderPath: target.localFolderPath,
      lastSyncedRevision: target.lastSyncedRevision,
    });
    await this.folderWatcher.switchWatchedFolder(target.localFolderPath);
    await this.folderWatcher.syncWatchedZones();

    return target;
  }

  public async syncZone(zoneId: string, reason = 'MANUAL_ZONE'): Promise<SyncRunSummary | null> {
    if (this.isSyncing) {
      this.pendingSyncReason = `${reason}_${zoneId}`;
      return this.lastSummary;
    }

    const cfg = await this.configService.loadConfig();
    const zone = (cfg.zones ?? []).find((z) => z.zoneId === zoneId);
    if (!zone || !zone.joined || !zone.localFolderPath) {
      return null;
    }

    const cloudReady = await this.cloudProvider.isReady();
    if (!cloudReady) {
      return null;
    }

    this.isSyncing = true;
    this.lastError = null;
    this.setProgress('PREPARING', 0, 0, null, `Chuẩn bị đồng bộ vùng ${zone.zoneName || zoneId}...`);
    this.emit('syncStarted', { reason });
    try {
      const summary = await this.performSyncCycle(
        zone.localFolderPath,
        cfg.deviceName,
        reason,
        zoneId,
      );
      this.lastSummary = summary;
      this.lastSyncedAt = summary.completedAt;
      this.emit('syncCompleted', summary);
      return summary;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.appendLog('ERROR', 'SYNC_FAILED', `Lỗi đồng bộ vùng "${zoneId}" (${reason}): ${msg}`);
      this.emit('syncError', { reason, error: msg });
      throw err;
    } finally {
      this.isSyncing = false;
      this.clearProgress();
      if (this.pendingSyncReason) {
        const nextReason = this.pendingSyncReason;
        this.pendingSyncReason = null;
        void this.syncNow(nextReason).catch(() => undefined);
      }
    }
  }

  private async performSyncCycle(
    syncFolderPath: string,
    deviceName: string,
    reason: string,
    zoneId = DEFAULT_ZONE_ID,
  ): Promise<SyncRunSummary> {
    const persistedState = await this.loadSyncState();
    const zoneRecord = persistedState.zoneBaselines?.[zoneId];
    const baselineHashes =
      zoneRecord && zoneRecord.folderPath === syncFolderPath
        ? zoneRecord.baselineHashes
        : persistedState.folderPath === syncFolderPath
          ? persistedState.baselineHashes
          : {};

    this.setProgress('SCANNING', 0, 0, syncFolderPath, 'Đang quét thư mục cục bộ...');
    // 1. Scan local folder to make sure local list-file.md is completely fresh
    const { doc: localDoc } = await this.fileIndexer.scanAndSyncLocalListFile(
      syncFolderPath,
      deviceName,
    );

    this.setProgress('PREPARING', 0, 0, null, 'Đang đọc chỉ mục từ Google Drive...');
    // 2. Read remote list-file.md from Google Drive / Cloud for this zone
    const remoteExisting = await this.cloudProvider.readRemoteListFile(zoneId);
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
    this.setProgress('PREPARING', 0, 0, null, 'Đang tính toán thay đổi cần đồng bộ...');

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
          undefined,
          zoneId,
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
          undefined,
          zoneId,
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
          zoneId,
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
    let downloadDone = 0;
    const downloadTotal = diff.toDownload.length;
    await this.runWithConcurrency(diff.toDownload, this.transferConcurrency, async (remoteEntry) => {
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
        downloadDone += 1;
        this.setProgress(
          'DOWNLOADING',
          downloadDone,
          downloadTotal,
          remoteEntry.relativePath,
          `Đang xử lý tải về (${downloadDone}/${downloadTotal})`,
        );
        this.appendLog(
          'INFO',
          'RELAY_REQUEST_UPLOAD',
          `File "${remoteEntry.relativePath}" đã tự hủy trên trạm trung chuyển. Đã gửi yêu cầu máy gốc đẩy lại tạm thời.`,
        );
        return;
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
      downloadDone += 1;
      this.setProgress(
        'DOWNLOADING',
        downloadDone,
        downloadTotal,
        remoteEntry.relativePath,
        `Đang tải về (${downloadDone}/${downloadTotal})`,
      );
      this.appendLog(
        'SUCCESS',
        'DOWNLOAD',
        `Đã tải về "${remoteEntry.relativePath}" (từ ${remoteEntry.updatedBy}).`,
      );
    });

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
    let uploadDone = 0;
    const uploadTotal = diff.toUpload.length;
    await this.runWithConcurrency(diff.toUpload, this.transferConcurrency, async (localEntry) => {
      const localFullPath = path.join(syncFolderPath, ...localEntry.relativePath.split('/'));
      const prevRemote = finalEntriesMap.get(localEntry.relativePath);
      let driveFileId: string;
      try {
        driveFileId = await this.cloudProvider.uploadFile(
          localFullPath,
          localEntry.relativePath,
          prevRemote?.driveFileId,
          zoneId,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          uploadDone += 1;
          this.setProgress(
            'UPLOADING',
            uploadDone,
            uploadTotal,
            localEntry.relativePath,
            `Đang đẩy lên (${uploadDone}/${uploadTotal})`,
          );
          this.appendLog(
            'INFO',
            'SKIPPED_VANISHED',
            `Bỏ qua "${localEntry.relativePath}" vì file tạm đã tự đóng/xóa trước khi đẩy lên.`,
          );
          return;
        }
        throw err;
      }

      const updatedEntry: FileIndexEntry = {
        ...localEntry,
        updatedBy: deviceName,
        driveFileId,
        syncedDevices: [deviceName],
        requestUpload: false,
      };
      finalEntriesMap.set(localEntry.relativePath, updatedEntry);
      uploadedPaths.push(localEntry.relativePath);
      uploadDone += 1;
      this.setProgress(
        'UPLOADING',
        uploadDone,
        uploadTotal,
        localEntry.relativePath,
        `Đang đẩy lên (${uploadDone}/${uploadTotal})`,
      );
      this.appendLog('SUCCESS', 'UPLOAD', `Đã đẩy lên "${localEntry.relativePath}".`);
    });

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
            undefined,
            zoneId,
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

    this.setProgress('FINALIZING', 0, 0, null, 'Đang hoàn tất và cập nhật list-file.md...');
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
      const listFileDriveId = await this.cloudProvider.writeRemoteListFile(finalDoc, zoneId);

      // Update zone registry if available
      if (this.cloudProvider.readZonesRegistry && this.cloudProvider.writeZonesRegistry) {
        try {
          const reg = await this.cloudProvider.readZonesRegistry();
          const zIdx = reg.zones.findIndex((z) => z.zoneId === zoneId);
          if (zIdx >= 0) {
            reg.zones[zIdx].memberDevices = knownDevices;
            reg.zones[zIdx].listFileDriveId = listFileDriveId;
            reg.updatedAt = nowIso;
            await this.cloudProvider.writeZonesRegistry(reg);
          }
        } catch {
          // Ignore registry sync error
        }
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

    const nextZoneBaselines = {
      ...(persistedState.zoneBaselines ?? {}),
      [zoneId]: {
        folderPath: syncFolderPath,
        baselineHashes: nextBaseline,
        lastSyncedAt: nowIso,
      },
    };

    await this.saveSyncState({
      folderPath: syncFolderPath,
      baselineHashes: nextBaseline,
      lastSyncedAt: nowIso,
      zoneBaselines: nextZoneBaselines,
    });

    const curCfg = await this.configService.loadConfig();
    const zoneLabel =
      (curCfg.zones ?? []).find((z) => z.zoneId === zoneId)?.zoneName ?? zoneId;

    const hasNotifiableChanges =
      uploadedPaths.length > 0 ||
      markedDeletedRemotelyPaths.length > 0 ||
      conflictPaths.length > 0 ||
      downloadedPaths.length > 0 ||
      deletedLocallyPaths.length > 0;

    if (this.telegramService && hasNotifiableChanges) {
      this.telegramService.queueSyncNotification({
        deviceName,
        revision: nextRevision,
        zoneName: zoneLabel,
        uploadedPaths,
        deletedPaths: markedDeletedRemotelyPaths,
        conflictPaths,
        downloadedPaths,
        deletedLocallyPaths,
      });
    }
    const updatedZones = (curCfg.zones ?? []).map((z) =>
      z.zoneId === zoneId
        ? {
            ...z,
            lastSyncedRevision: nextRevision,
            lastSyncedAt: nowIso,
            memberDevices: knownDevices,
          }
        : z,
    );

    await this.configService.saveConfig({
      lastSyncedRevision:
        (curCfg.activeZoneId || DEFAULT_ZONE_ID) === zoneId
          ? nextRevision
          : curCfg.lastSyncedRevision,
      zones: updatedZones,
    });

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
    const normalizedRelPath = entry.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const tmpDir = path.join(syncFolderPath, '.sync_tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFilePath = path.join(tmpDir, `dl_${crypto.randomUUID()}.tmp`);
    const finalFilePath = path.join(syncFolderPath, ...normalizedRelPath.split('/'));

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
    const tmp = `${this.stateFilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmp, this.stateFilePath);
  }
}
