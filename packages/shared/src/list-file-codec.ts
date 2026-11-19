import type {
  ConflictPair,
  FileIndexEntry,
  FileSyncStatus,
  ListFileDiffResult,
  ListFileDocument,
  ZonesRegistryDocument,
} from './types.js';

export const LIST_FILE_NAME = 'list-file.md';
export const ZONES_REGISTRY_FILE_NAME = 'zones-registry.json';
export const DEFAULT_ZONE_ID = 'default-zone';
export const DEFAULT_ZONE_NAME = 'Vùng Mặc Định (Default)';

export function slugifyZoneId(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `zone-${slug}` : `zone-${Date.now()}`;
}

export function parseZonesRegistry(rawJson: string): ZonesRegistryDocument {
  if (!rawJson || !rawJson.trim()) {
    return { updatedAt: new Date(0).toISOString(), zones: [] };
  }
  try {
    const parsed = JSON.parse(rawJson) as Partial<ZonesRegistryDocument>;
    const zones = Array.isArray(parsed.zones)
      ? parsed.zones.map((z) => ({
          zoneId: String(z.zoneId ?? DEFAULT_ZONE_ID),
          zoneName: String(z.zoneName ?? DEFAULT_ZONE_NAME),
          description: z.description ? String(z.description) : undefined,
          driveFolderId: String(z.driveFolderId ?? ''),
          listFileDriveId: z.listFileDriveId ? String(z.listFileDriveId) : null,
          createdAt: String(z.createdAt ?? new Date(0).toISOString()),
          createdBy: String(z.createdBy ?? 'unknown'),
          memberDevices: Array.isArray(z.memberDevices) ? z.memberDevices.map(String) : [],
        }))
      : [];
    return {
      updatedAt: String(parsed.updatedAt ?? new Date(0).toISOString()),
      zones,
    };
  } catch {
    return { updatedAt: new Date(0).toISOString(), zones: [] };
  }
}

export function serializeZonesRegistry(doc: ZonesRegistryDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function unescapeCell(value: string): string {
  return value.replace(/\\\|/g, '|');
}

function stripBackticks(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function serializeListFile(doc: ListFileDocument): string {
  const sortedEntries = [...doc.entries].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );

  const knownDevicesList = Array.from(
    new Set((doc.knownDevices ?? []).map((d) => d.trim()).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b));

  const lines: string[] = [
    '# 📋 Danh Sách File Đồng Bộ (FolderSync Index)',
    '',
    `- **Cập nhật lần cuối**: \`${doc.lastUpdatedAt}\``,
    `- **Thiết bị cập nhật**: \`${escapeCell(doc.updatedByDevice)}\``,
    `- **Phiên bản chỉ mục (Revision)**: \`${doc.revision}\``,
    `- **Thiết bị tham gia**: \`${escapeCell(knownDevicesList.join(', ') || doc.updatedByDevice || 'None')}\``,
    '',
    '| Đường dẫn file (`Path`) | Mã băm (`SHA-256`) | Dung lượng (`Bytes`) | Thời gian sửa (`ModifiedAt`) | Trạng thái (`Status`) | Thiết bị (`UpdatedBy`) | Drive ID (`DriveFileId`) | Đã nhận (`SyncedDevices`) |',
    '| :--- | :--- | ---: | :--- | :---: | :--- | :--- | :--- |',
  ];

  for (const entry of sortedEntries) {
    const pathCell = `\`${escapeCell(entry.relativePath)}\``;
    const hashCell = `\`${escapeCell(entry.sha256 || '-')}\``;
    const sizeCell = String(entry.size ?? 0);
    const mtimeCell = `\`${escapeCell(entry.modifiedAt)}\``;
    const statusCell = `\`${entry.status}\``;
    const updatedByCell = `\`${escapeCell(entry.updatedBy || '-')}\``;
    const driveIdCell = `\`${escapeCell(entry.driveFileId || '-')}\``;
    const syncedSet = Array.from(
      new Set((entry.syncedDevices ?? []).map((d) => d.trim()).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b));
    let syncedStr = syncedSet.length > 0 ? syncedSet.join(', ') : '-';
    if (entry.requestUpload) {
      syncedStr = `${syncedStr}@NEED_UPLOAD`;
    }
    const syncedDevicesCell = `\`${escapeCell(syncedStr)}\``;

    lines.push(
      `| ${pathCell} | ${hashCell} | ${sizeCell} | ${mtimeCell} | ${statusCell} | ${updatedByCell} | ${driveIdCell} | ${syncedDevicesCell} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export function parseListFile(markdown: string): ListFileDocument {
  let lastUpdatedAt = new Date(0).toISOString();
  let updatedByDevice = 'Unknown';
  let revision = 0;
  let knownDevices: string[] = [];
  const entries: FileIndexEntry[] = [];

  const lines = markdown.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('- **Cập nhật lần cuối**:')) {
      const val = line.split(':').slice(1).join(':').trim();
      lastUpdatedAt = stripBackticks(val);
      continue;
    }

    if (line.startsWith('- **Thiết bị cập nhật**:')) {
      const val = line.split(':').slice(1).join(':').trim();
      updatedByDevice = unescapeCell(stripBackticks(val));
      continue;
    }

    if (line.startsWith('- **Phiên bản chỉ mục (Revision)**:')) {
      const val = line.split(':').slice(1).join(':').trim();
      const parsedRev = Number.parseInt(stripBackticks(val), 10);
      if (!Number.isNaN(parsedRev)) {
        revision = parsedRev;
      }
      continue;
    }

    if (line.startsWith('- **Thiết bị tham gia**:')) {
      const val = line.split(':').slice(1).join(':').trim();
      const rawDevices = unescapeCell(stripBackticks(val));
      if (rawDevices && rawDevices !== 'None' && rawDevices !== '-') {
        knownDevices = rawDevices
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean);
      }
      continue;
    }

    if (line.startsWith('|') && line.endsWith('|')) {
      // Split by unescaped pipes
      const cells = line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim());

      if (cells.length < 7) continue;

      // Skip table header and alignment separator row
      if (
        cells[0].includes('Đường dẫn file') ||
        cells[0].startsWith(':---') ||
        cells[0].startsWith('---')
      ) {
        continue;
      }

      const relativePath = unescapeCell(stripBackticks(cells[0]));
      const sha256 = unescapeCell(stripBackticks(cells[1]));
      const size = Number.parseInt(stripBackticks(cells[2]), 10) || 0;
      const modifiedAt = unescapeCell(stripBackticks(cells[3]));
      const rawStatus = stripBackticks(cells[4]);
      const status: FileSyncStatus = rawStatus === 'DELETED' ? 'DELETED' : 'ACTIVE';
      const updatedBy = unescapeCell(stripBackticks(cells[5]));
      const driveFileId = unescapeCell(stripBackticks(cells[6]));

      let syncedDevices: string[] | undefined;
      let requestUpload = false;

      if (cells.length >= 8) {
        let rawSynced = unescapeCell(stripBackticks(cells[7]));
        if (rawSynced.endsWith('@NEED_UPLOAD')) {
          requestUpload = true;
          rawSynced = rawSynced.slice(0, -'@NEED_UPLOAD'.length);
        }
        if (rawSynced && rawSynced !== '-') {
          syncedDevices = rawSynced
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean);
        }
      }

      entries.push({
        relativePath,
        sha256,
        size,
        modifiedAt,
        status,
        updatedBy,
        driveFileId,
        ...(syncedDevices ? { syncedDevices } : {}),
        ...(requestUpload ? { requestUpload: true } : {}),
      });
    }
  }

  return {
    lastUpdatedAt,
    updatedByDevice,
    revision,
    ...(knownDevices.length > 0 ? { knownDevices } : {}),
    entries,
  };
}

/**
 * So sánh danh sách file nội bộ (localEntries) với tài liệu chỉ mục từ xa (remoteDoc).
 * @param localEntries Danh sách bản ghi file ở máy hiện tại
 * @param remoteDoc Tài liệu list-file.md tải về từ Google Drive
 * @param baselineSyncedHashes Bản đồ (relativePath -> sha256) của lần đồng bộ thành công trước đó trên máy này
 */
export function diffListFiles(
  localEntries: FileIndexEntry[],
  remoteDoc: ListFileDocument,
  baselineSyncedHashes: Record<string, string> = {},
): ListFileDiffResult {
  const localMap = new Map<string, FileIndexEntry>();
  for (const entry of localEntries) {
    localMap.set(entry.relativePath, entry);
  }

  const remoteMap = new Map<string, FileIndexEntry>();
  for (const entry of remoteDoc.entries) {
    remoteMap.set(entry.relativePath, entry);
  }

  const allPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
  const sortedPaths = [...allPaths].sort((a, b) => a.localeCompare(b));

  const toDownload: FileIndexEntry[] = [];
  const toUpload: FileIndexEntry[] = [];
  const toDeleteLocally: FileIndexEntry[] = [];
  const toMarkDeletedRemotely: FileIndexEntry[] = [];
  const conflicts: ConflictPair[] = [];

  for (const relPath of sortedPaths) {
    const local = localMap.get(relPath);
    const remote = remoteMap.get(relPath);
    const baseHash = baselineSyncedHashes[relPath];

    // Case 1: Only exists on Remote
    if (!local && remote) {
      if (remote.status === 'ACTIVE') {
        toDownload.push(remote);
      }
      continue;
    }

    // Case 2: Only exists on Local
    if (local && !remote) {
      if (local.status === 'ACTIVE') {
        toUpload.push(local);
      }
      continue;
    }

    if (!local || !remote) continue;

    // Case 3: Remote marked DELETED, Local is ACTIVE
    if (remote.status === 'DELETED' && local.status === 'ACTIVE') {
      // Chỉ xóa file nội bộ nếu máy này thực sự từng đồng bộ file đó trước đây (có baseHash) và chưa sửa đổi gì thêm
      if (baseHash && local.sha256 === baseHash) {
        toDeleteLocally.push(remote);
      } else {
        // File được sửa mới hơn lệnh xóa HOẶC là file có sẵn trong thư mục mới chọn (!baseHash) -> Bảo toàn & đẩy lên
        toUpload.push(local);
      }
      continue;
    }

    // Case 4: Local marked DELETED, Remote is ACTIVE
    if (local.status === 'DELETED' && remote.status === 'ACTIVE') {
      const localTime = Date.parse(local.modifiedAt) || 0;
      const remoteTime = Date.parse(remote.modifiedAt) || 0;
      if ((baseHash && remote.sha256 === baseHash) || localTime >= remoteTime) {
        toMarkDeletedRemotely.push(local);
      } else {
        toDownload.push(remote);
      }
      continue;
    }

    // Case 5: Both ACTIVE
    if (local.status === 'ACTIVE' && remote.status === 'ACTIVE') {
      if (local.sha256 === remote.sha256) {
        // Identical content -> already in sync
        continue;
      }

      if (baseHash) {
        const localChanged = local.sha256 !== baseHash;
        const remoteChanged = remote.sha256 !== baseHash;

        if (!localChanged && remoteChanged) {
          toDownload.push(remote);
          continue;
        }
        if (localChanged && !remoteChanged) {
          toUpload.push(local);
          continue;
        }
      }

      // Both changed independently (or no baseline and hashes differ) -> Conflict!
      const localTime = Date.parse(local.modifiedAt) || 0;
      const remoteTime = Date.parse(remote.modifiedAt) || 0;
      const winner: 'LOCAL' | 'REMOTE' = localTime >= remoteTime ? 'LOCAL' : 'REMOTE';

      conflicts.push({
        relativePath: relPath,
        localEntry: local,
        remoteEntry: remote,
        winner,
      });
    }
  }

  return {
    toDownload,
    toUpload,
    toDeleteLocally,
    toMarkDeletedRemotely,
    conflicts,
  };
}
