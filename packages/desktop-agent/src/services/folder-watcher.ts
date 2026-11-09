import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ListFileDocument } from '@foldersync/shared';
import type { ConfigService } from './config-service.js';
import type { FolderChangedEvent, FolderService } from './folder-service.js';
import { FileIndexer } from './file-indexer.js';

export interface IndexUpdatedEvent {
  folderPath: string;
  document: ListFileDocument;
}

export interface FolderWatcherOptions {
  debounceMs?: number;
  lockHoldMs?: number;
}

export class FolderWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private currentWatchedFolder: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private isScanning = false;
  private pendingRescan = false;
  private switchQueue: Promise<ListFileDocument> = Promise.resolve({
    lastUpdatedAt: new Date(0).toISOString(),
    updatedByDevice: 'None',
    revision: 0,
    entries: [],
  });

  private readonly debounceMs: number;
  private readonly lockHoldMs: number;
  /** Map of normalized relativePath -> expiry timestamp (ms) for Anti-Loop */
  private readonly writeLocks = new Map<string, number>();

  private readonly onFolderChangedBound: (evt: FolderChangedEvent) => void;

  constructor(
    private readonly configService: ConfigService,
    private readonly folderService: FolderService,
    private readonly fileIndexer: FileIndexer = new FileIndexer(),
    options: FolderWatcherOptions = {},
  ) {
    super();
    this.debounceMs = options.debounceMs ?? 400;
    this.lockHoldMs = options.lockHoldMs ?? 600;

    this.onFolderChangedBound = (evt: FolderChangedEvent) => {
      void this.switchWatchedFolder(evt.newPath);
    };
    this.folderService.on('folderChanged', this.onFolderChangedBound);
  }

  public getWatchedFolder(): string | null {
    return this.currentWatchedFolder;
  }

  public async start(): Promise<void> {
    const cfg = await this.configService.loadConfig();
    if (cfg.syncFolderPath && cfg.syncFolderPath.trim()) {
      await this.switchWatchedFolder(cfg.syncFolderPath);
    }
  }

  public async stop(): Promise<void> {
    this.folderService.off('folderChanged', this.onFolderChangedBound);
    await this.switchQueue.catch(() => undefined);
    await this.closeCurrentWatcher();
  }

  public switchWatchedFolder(newFolderPath: string): Promise<ListFileDocument> {
    const nextOp = this.switchQueue
      .catch(() => undefined)
      .then(() => this.performSwitchWatchedFolder(newFolderPath));
    this.switchQueue = nextOp;
    return nextOp;
  }

  private async performSwitchWatchedFolder(newFolderPath: string): Promise<ListFileDocument> {
    const resolved = path.resolve(newFolderPath);
    await this.closeCurrentWatcher();

    this.currentWatchedFolder = resolved;
    const doc = await this.triggerScanNow();

    const watcher = chokidar.watch(resolved, {
      ignoreInitial: true,
      persistent: true,
      ignored: (targetPath: string) => {
        if (targetPath === resolved) return false;
        const rel = path.relative(resolved, targetPath).replace(/\\/g, '/');
        return this.fileIndexer.shouldIgnoreRelativePath(rel);
      },
    });

    this.watcher = watcher;

    const handleFsEvent = (affectedPath: string) => {
      if (!this.currentWatchedFolder) return;
      const rel = path.relative(this.currentWatchedFolder, affectedPath).replace(/\\/g, '/');
      if (this.fileIndexer.shouldIgnoreRelativePath(rel)) return;
      if (this.isPathLocked(rel)) return;

      this.scheduleDebouncedScan();
    };

    watcher.on('add', handleFsEvent);
    watcher.on('change', handleFsEvent);
    watcher.on('unlink', handleFsEvent);

    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });

    this.emit('watcherReady', { folderPath: resolved, document: doc });
    return doc;
  }

  /**
   * Thực thi tác vụ ghi file đồng bộ từ máy khác với cơ chế khóa Anti-Loop
   * để FolderWatcher không bắn sự kiện ngược lại.
   */
  public async withWriteLock<T>(relativePath: string, fn: () => Promise<T>): Promise<T> {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    this.writeLocks.set(normalized, Number.MAX_SAFE_INTEGER);
    try {
      return await fn();
    } finally {
      this.writeLocks.set(normalized, Date.now() + this.lockHoldMs);
    }
  }

  public isPathLocked(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const expiry = this.writeLocks.get(normalized);
    if (!expiry) return false;
    if (Date.now() <= expiry) {
      return true;
    }
    this.writeLocks.delete(normalized);
    return false;
  }

  public async triggerScanNow(): Promise<ListFileDocument> {
    if (!this.currentWatchedFolder) {
      const cfg = await this.configService.loadConfig();
      if (!cfg.syncFolderPath) {
        return {
          lastUpdatedAt: new Date(0).toISOString(),
          updatedByDevice: cfg.deviceName,
          revision: 0,
          entries: [],
        };
      }
      this.currentWatchedFolder = path.resolve(cfg.syncFolderPath);
    }

    if (this.isScanning) {
      this.pendingRescan = true;
      return this.fileIndexer.readLocalListFile(this.currentWatchedFolder);
    }

    this.isScanning = true;
    try {
      const cfg = await this.configService.loadConfig();
      const folderPath = this.currentWatchedFolder;
      const { doc, changed } = await this.fileIndexer.scanAndSyncLocalListFile(
        folderPath,
        cfg.deviceName,
      );

      if (changed) {
        this.emit('indexUpdated', {
          folderPath,
          document: doc,
        } satisfies IndexUpdatedEvent);
      }

      return doc;
    } finally {
      this.isScanning = false;
      if (this.pendingRescan) {
        this.pendingRescan = false;
        void this.triggerScanNow();
      }
    }
  }

  private scheduleDebouncedScan(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.triggerScanNow();
    }, this.debounceMs);
  }

  private async closeCurrentWatcher(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      const w = this.watcher;
      this.watcher = null;
      await w.close();
    }
  }
}
