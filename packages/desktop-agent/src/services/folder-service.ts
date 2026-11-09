import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type {
  DirectoryBrowseResult,
  DirectoryEntry,
  SwitchFolderMode,
  SwitchFolderResult,
} from '@foldersync/shared';
import type { ConfigService } from './config-service.js';

export interface FolderChangedEvent {
  previousPath: string | null;
  newPath: string;
  mode: SwitchFolderMode;
  copiedFilesCount: number;
}

export class FolderService extends EventEmitter {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  public async getSystemRoots(): Promise<string[]> {
    const roots: string[] = [];
    const home = os.homedir();

    if (process.platform === 'win32') {
      const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
      for (const ch of letters) {
        const drive = `${ch}:\\`;
        try {
          await fs.access(drive, fsConstants.R_OK);
          roots.push(drive);
        } catch {
          // Drive not mounted
        }
      }
    } else {
      roots.push('/');
      if (home && !roots.includes(home)) {
        roots.push(home);
      }
      const androidShared = '/storage/emulated/0';
      try {
        await fs.access(androidShared, fsConstants.R_OK);
        if (!roots.includes(androidShared)) {
          roots.push(androidShared);
        }
      } catch {
        // Not on Android
      }
    }

    return roots;
  }

  public async listDirectories(targetPath?: string): Promise<DirectoryBrowseResult> {
    const resolvedPath = path.resolve(targetPath && targetPath.trim() ? targetPath : os.homedir());
    await fs.access(resolvedPath, fsConstants.R_OK);

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const directories: DirectoryEntry[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.sync_tmp') continue;
      directories.push({
        name: entry.name,
        path: path.join(resolvedPath, entry.name),
      });
    }

    directories.sort((a, b) => a.name.localeCompare(b.name));

    const parsed = path.parse(resolvedPath);
    const parentPath = parsed.root === resolvedPath ? null : path.dirname(resolvedPath);
    const roots = await this.getSystemRoots();

    return {
      currentPath: resolvedPath,
      parentPath,
      roots,
      directories,
    };
  }

  public async createDirectory(targetPath: string): Promise<string> {
    if (!targetPath || !targetPath.trim()) {
      throw new Error('Đường dẫn thư mục không được để trống.');
    }
    const resolved = path.resolve(targetPath);
    await fs.mkdir(resolved, { recursive: true });
    await fs.access(resolved, fsConstants.R_OK | fsConstants.W_OK);
    return resolved;
  }

  public async switchSyncFolder(
    newPathInput: string,
    mode: SwitchFolderMode = 'POINT_ONLY',
  ): Promise<SwitchFolderResult> {
    if (!newPathInput || !newPathInput.trim()) {
      throw new Error('Đường dẫn thư mục đồng bộ không được để trống.');
    }

    const newPath = path.resolve(newPathInput);
    const currentConfig = await this.configService.loadConfig();
    const previousPath = currentConfig.syncFolderPath
      ? path.resolve(currentConfig.syncFolderPath)
      : null;

    if (
      mode === 'COPY_EXISTING' &&
      previousPath &&
      previousPath !== newPath &&
      newPath.startsWith(previousPath + path.sep)
    ) {
      throw new Error(
        'Không thể chọn thư mục mới nằm bên trong thư mục đồng bộ cũ khi ở chế độ copy dữ liệu.',
      );
    }

    await fs.mkdir(newPath, { recursive: true });
    await fs.access(newPath, fsConstants.R_OK | fsConstants.W_OK);

    let copiedFilesCount = 0;

    if (mode === 'COPY_EXISTING' && previousPath && previousPath !== newPath) {
      const prevExists = await this.directoryExists(previousPath);
      if (prevExists) {
        copiedFilesCount = await this.copyDirectoryRecursive(previousPath, newPath);
      }
    }

    await this.configService.saveConfig({ syncFolderPath: newPath });

    const result: SwitchFolderResult = {
      previousPath,
      newPath,
      mode,
      copiedFilesCount,
    };

    this.emit('folderChanged', result satisfies FolderChangedEvent);
    return result;
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async copyDirectoryRecursive(srcDir: string, destDir: string): Promise<number> {
    await fs.mkdir(destDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (entry.name === '.sync_tmp') continue;

      const srcFullPath = path.join(srcDir, entry.name);
      const destFullPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        count += await this.copyDirectoryRecursive(srcFullPath, destFullPath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcFullPath, destFullPath);
        count += 1;
      }
    }

    return count;
  }
}
