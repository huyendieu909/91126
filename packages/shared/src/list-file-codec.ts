import type {
  ConflictPair,
  FileIndexEntry,
  FileSyncStatus,
  ListFileDiffResult,
  ListFileDocument,
} from './types.js';

export const LIST_FILE_NAME = 'list-file.md';

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

  const lines: string[] = [
    '# 📋 Danh Sách File Đồng Bộ (FolderSync Index)',
    '',
    `- **Cập nhật lần cuối**: \`${doc.lastUpdatedAt}\``,
    `- **Thiết bị cập nhật**: \`${escapeCell(doc.updatedByDevice)}\``,
    `- **Phiên bản chỉ mục (Revision)**: \`${doc.revision}\``,
    '',
    '| Đường dẫn file (`Path`) | Mã băm (`SHA-256`) | Dung lượng (`Bytes`) | Thời gian sửa (`ModifiedAt`) | Trạng thái (`Status`) | Thiết bị (`UpdatedBy`) | Drive ID (`DriveFileId`) |',
    '| :--- | :--- | ---: | :--- | :---: | :--- | :--- |',
  ];

  for (const entry of sortedEntries) {
    const pathCell = `\`${escapeCell(entry.relativePath)}\``;
    const hashCell = `\`${escapeCell(entry.sha256 || '-')}\``;
    const sizeCell = String(entry.size ?? 0);
    const mtimeCell = `\`${escapeCell(entry.modifiedAt)}\``;
    const statusCell = `\`${entry.status}\``;
    const updatedByCell = `\`${escapeCell(entry.updatedBy || '-')}\``;
    const driveIdCell = `\`${escapeCell(entry.driveFileId || '-')}\``;

    lines.push(
      `| ${pathCell} | ${hashCell} | ${sizeCell} | ${mtimeCell} | ${statusCell} | ${updatedByCell} | ${driveIdCell} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export function parseListFile(markdown: string): ListFileDocument {
  let lastUpdatedAt = new Date(0).toISOString();
  let updatedByDevice = 'Unknown';
  let revision = 0;
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

      entries.push({
        relativePath,
        sha256,
        size,
        modifiedAt,
        status,
        updatedBy,
        driveFileId,
      });
    }
  }

  return {
    lastUpdatedAt,
    updatedByDevice,
    revision,
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
      const remoteTime = Date.parse(remote.modifiedAt) || 0;
      const localTime = Date.parse(local.modifiedAt) || 0;
      // If local wasn't modified after the deletion (or matches baseHash), delete locally
      if ((baseHash && local.sha256 === baseHash) || remoteTime >= localTime) {
        toDeleteLocally.push(remote);
      } else {
        // Local was modified more recently than the remote deletion -> re-upload local
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
