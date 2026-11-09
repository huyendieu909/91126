import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LIST_FILE_NAME,
  parseListFile,
  serializeListFile,
  type FileIndexEntry,
  type ListFileDocument,
} from '@foldersync/shared';

const IGNORED_BASENAMES = new Set([
  LIST_FILE_NAME,
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

export class FileIndexer {
  public shouldIgnoreRelativePath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return true;

    const segments = normalized.split('/');
    if (segments.includes('.sync_tmp') || segments.includes('.git')) {
      return true;
    }

    const base = segments[segments.length - 1];
    if (IGNORED_BASENAMES.has(base)) {
      return true;
    }

    if (base.startsWith('.sync_tmp') || base.endsWith('.sync_tmp')) {
      return true;
    }

    return false;
  }

  public async computeFileSha256(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => reject(err));
    });
  }

  public async readLocalListFile(syncFolderPath: string): Promise<ListFileDocument> {
    const listFilePath = path.join(syncFolderPath, LIST_FILE_NAME);
    try {
      const content = await fs.readFile(listFilePath, 'utf-8');
      return parseListFile(content);
    } catch {
      return {
        lastUpdatedAt: new Date(0).toISOString(),
        updatedByDevice: 'None',
        revision: 0,
        entries: [],
      };
    }
  }

  public async writeLocalListFile(
    syncFolderPath: string,
    doc: ListFileDocument,
  ): Promise<void> {
    const tmpDir = path.join(syncFolderPath, '.sync_tmp');
    await fs.mkdir(tmpDir, { recursive: true });

    const tmpFile = path.join(tmpDir, `list-file.${process.pid}.${Date.now()}.tmp`);
    const targetFile = path.join(syncFolderPath, LIST_FILE_NAME);
    const markdown = serializeListFile(doc);

    await fs.writeFile(tmpFile, markdown, 'utf-8');
    await fs.rename(tmpFile, targetFile);
  }

  public async scanAndSyncLocalListFile(
    syncFolderPath: string,
    deviceName: string,
  ): Promise<{ doc: ListFileDocument; changed: boolean }> {
    await fs.mkdir(syncFolderPath, { recursive: true });
    const listFilePath = path.join(syncFolderPath, LIST_FILE_NAME);
    const listFileExisted = await this.fileExists(listFilePath);

    const existingDoc = await this.readLocalListFile(syncFolderPath);
    const existingMap = new Map<string, FileIndexEntry>();
    for (const entry of existingDoc.entries) {
      existingMap.set(entry.relativePath, entry);
    }

    const diskRelativePaths = await this.walkDirectory(syncFolderPath, syncFolderPath);
    const seenOnDisk = new Set<string>(diskRelativePaths);

    const nextEntries: FileIndexEntry[] = [];
    let changed = false;

    for (const relPath of diskRelativePaths) {
      const fullPath = path.join(syncFolderPath, ...relPath.split('/'));
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        // File disappeared during scan
        continue;
      }
      if (!stat.isFile()) continue;

      const size = stat.size;
      const modifiedAt = new Date(Math.floor(stat.mtimeMs)).toISOString();
      const prev = existingMap.get(relPath);

      // Fast path: unchanged size & mtime for an ACTIVE file
      if (
        prev &&
        prev.status === 'ACTIVE' &&
        prev.size === size &&
        prev.modifiedAt === modifiedAt &&
        prev.sha256 &&
        prev.sha256 !== '-'
      ) {
        nextEntries.push(prev);
        continue;
      }

      const sha256 = await this.computeFileSha256(fullPath);

      if (prev && prev.status === 'ACTIVE' && prev.sha256 === sha256) {
        // Content hash is identical even if mtime touched
        nextEntries.push({
          ...prev,
          size,
          modifiedAt,
        });
        continue;
      }

      // New file or modified content
      changed = true;
      nextEntries.push({
        relativePath: relPath,
        sha256,
        size,
        modifiedAt,
        status: 'ACTIVE',
        updatedBy: deviceName,
        driveFileId: '-',
      });
    }

    // Handle deletions (Tombstones)
    const nowIso = new Date().toISOString();
    for (const [relPath, prev] of existingMap.entries()) {
      if (seenOnDisk.has(relPath)) continue;

      if (prev.status === 'ACTIVE') {
        changed = true;
        nextEntries.push({
          relativePath: relPath,
          sha256: '-',
          size: 0,
          modifiedAt: nowIso,
          status: 'DELETED',
          updatedBy: deviceName,
          driveFileId: '-',
        });
      } else {
        // Already DELETED tombstone -> keep it
        nextEntries.push(prev);
      }
    }

    nextEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const nextDoc: ListFileDocument = {
      lastUpdatedAt: changed ? nowIso : existingDoc.lastUpdatedAt,
      updatedByDevice: changed ? deviceName : existingDoc.updatedByDevice,
      revision: changed ? existingDoc.revision + 1 : existingDoc.revision,
      entries: nextEntries,
    };

    if (changed || !listFileExisted) {
      await this.writeLocalListFile(syncFolderPath, nextDoc);
    }

    return { doc: nextDoc, changed };
  }

  /**
   * Đổi tên bản bị xung đột thành <tên_file>.conflict-<tên_máy><ext> để bảo toàn dữ liệu 100%
   */
  public async createConflictBackup(
    syncFolderPath: string,
    relativePath: string,
    sourceDeviceName: string,
  ): Promise<string> {
    const normalizedRel = relativePath.replace(/\\/g, '/');
    const fullPath = path.join(syncFolderPath, ...normalizedRel.split('/'));
    const parsed = path.parse(fullPath);
    const safeDevice = sourceDeviceName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'device';

    let conflictFileName = `${parsed.name}.conflict-${safeDevice}${parsed.ext}`;
    let conflictFullPath = path.join(parsed.dir, conflictFileName);

    if (await this.fileExists(conflictFullPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      conflictFileName = `${parsed.name}.conflict-${safeDevice}-${stamp}${parsed.ext}`;
      conflictFullPath = path.join(parsed.dir, conflictFileName);
    }

    await fs.copyFile(fullPath, conflictFullPath);
    const conflictRelPath = path
      .relative(syncFolderPath, conflictFullPath)
      .replace(/\\/g, '/');
    return conflictRelPath;
  }

  private async walkDirectory(rootDir: string, currentDir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

      if (this.shouldIgnoreRelativePath(relPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        const subResults = await this.walkDirectory(rootDir, fullPath);
        results.push(...subResults);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }

    return results;
  }

  private async fileExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
