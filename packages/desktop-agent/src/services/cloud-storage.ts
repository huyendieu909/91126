import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULT_ZONE_ID,
  parseListFile,
  serializeListFile,
  type ListFileDocument,
  type ZonesRegistryDocument,
} from '@foldersync/shared';

export interface CloudStorageProvider {
  isReady(): Promise<boolean>;
  readRemoteListFile(zoneId?: string): Promise<ListFileDocument | null>;
  writeRemoteListFile(doc: ListFileDocument, zoneId?: string): Promise<string>;
  uploadFile(
    localFilePath: string,
    relativePath: string,
    existingDriveFileId?: string,
    zoneId?: string,
  ): Promise<string>;
  downloadFile(driveFileId: string, destinationPath: string): Promise<void>;
  deleteRemoteFile(driveFileId: string): Promise<void>;
  readZonesRegistry?(): Promise<ZonesRegistryDocument>;
  writeZonesRegistry?(doc: ZonesRegistryDocument): Promise<void>;
  ensureZoneFolder?(zoneId: string, zoneName: string): Promise<string>;
}

/**
 * Bộ lưu trữ đám mây giả lập trong bộ nhớ (tuân thủ 100% chuẩn CloudStorageProvider của Google Drive)
 * Dùng cho kiểm thử tự động đồng bộ đa thiết bị (2-Node / 3-Node / Multi-Zone Sync Tests).
 */
export class InMemoryCloudProvider implements CloudStorageProvider {
  private readonly zoneListFiles = new Map<string, string>();
  private readonly blobs = new Map<string, Buffer>();
  private readonly blobZoneMap = new Map<string, string>();
  private zonesRegistry: ZonesRegistryDocument = {
    updatedAt: new Date(0).toISOString(),
    zones: [],
  };

  public async isReady(): Promise<boolean> {
    return true;
  }

  public async readRemoteListFile(zoneId = DEFAULT_ZONE_ID): Promise<ListFileDocument | null> {
    const md = this.zoneListFiles.get(zoneId);
    if (!md) {
      return null;
    }
    return parseListFile(md);
  }

  public async writeRemoteListFile(
    doc: ListFileDocument,
    zoneId = DEFAULT_ZONE_ID,
  ): Promise<string> {
    this.zoneListFiles.set(zoneId, serializeListFile(doc));
    return `mem_list_${zoneId}`;
  }

  public async uploadFile(
    localFilePath: string,
    _relativePath: string,
    existingDriveFileId?: string,
    zoneId = DEFAULT_ZONE_ID,
  ): Promise<string> {
    const content = await fs.readFile(localFilePath);
    const id =
      existingDriveFileId && existingDriveFileId !== '-' && this.blobs.has(existingDriveFileId)
        ? existingDriveFileId
        : `drive_${zoneId}_${crypto.randomUUID()}`;
    this.blobs.set(id, Buffer.from(content));
    this.blobZoneMap.set(id, zoneId);
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
    this.blobZoneMap.delete(driveFileId);
  }

  public async readZonesRegistry(): Promise<ZonesRegistryDocument> {
    return JSON.parse(JSON.stringify(this.zonesRegistry)) as ZonesRegistryDocument;
  }

  public async writeZonesRegistry(doc: ZonesRegistryDocument): Promise<void> {
    this.zonesRegistry = JSON.parse(JSON.stringify(doc)) as ZonesRegistryDocument;
  }

  public async ensureZoneFolder(zoneId: string, _zoneName: string): Promise<string> {
    return `mem_folder_${zoneId}`;
  }

  public getStoredFileCount(zoneId?: string): number {
    if (!zoneId) {
      return this.blobs.size;
    }
    let count = 0;
    for (const z of this.blobZoneMap.values()) {
      if (z === zoneId) count += 1;
    }
    return count;
  }
}
