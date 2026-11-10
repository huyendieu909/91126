import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseListFile,
  serializeListFile,
  type ListFileDocument,
} from '@foldersync/shared';

export interface CloudStorageProvider {
  isReady(): Promise<boolean>;
  readRemoteListFile(): Promise<ListFileDocument | null>;
  writeRemoteListFile(doc: ListFileDocument): Promise<string>;
  uploadFile(
    localFilePath: string,
    relativePath: string,
    existingDriveFileId?: string,
  ): Promise<string>;
  downloadFile(driveFileId: string, destinationPath: string): Promise<void>;
  deleteRemoteFile(driveFileId: string): Promise<void>;
}

/**
 * Bộ lưu trữ đám mây giả lập trong bộ nhớ (tuân thủ 100% chuẩn CloudStorageProvider của Google Drive)
 * Dùng cho kiểm thử tự động đồng bộ đa thiết bị (2-Node / 3-Node Sync Tests).
 */
export class InMemoryCloudProvider implements CloudStorageProvider {
  private listFileMarkdown: string | null = null;
  private listFileId = 'mem_list_file_md';
  private readonly blobs = new Map<string, Buffer>();

  public async isReady(): Promise<boolean> {
    return true;
  }

  public async readRemoteListFile(): Promise<ListFileDocument | null> {
    if (this.listFileMarkdown === null) {
      return null;
    }
    return parseListFile(this.listFileMarkdown);
  }

  public async writeRemoteListFile(doc: ListFileDocument): Promise<string> {
    this.listFileMarkdown = serializeListFile(doc);
    return this.listFileId;
  }

  public async uploadFile(
    localFilePath: string,
    _relativePath: string,
    existingDriveFileId?: string,
  ): Promise<string> {
    const content = await fs.readFile(localFilePath);
    const id =
      existingDriveFileId && existingDriveFileId !== '-' && this.blobs.has(existingDriveFileId)
        ? existingDriveFileId
        : `drive_${crypto.randomUUID()}`;
    this.blobs.set(id, Buffer.from(content));
    return id;
  }

  public async downloadFile(driveFileId: string, destinationPath: string): Promise<void> {
    const buf = this.blobs.get(driveFileId);
    if (!buf) {
      throw new Error(`Remote file not found in cloud storage: ${driveFileId}`);
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, buf);
  }

  public async deleteRemoteFile(driveFileId: string): Promise<void> {
    this.blobs.delete(driveFileId);
  }

  public getStoredFileCount(): number {
    return this.blobs.size;
  }
}
