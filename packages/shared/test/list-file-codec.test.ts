import { describe, it, expect } from 'vitest';
import {
  diffListFiles,
  parseListFile,
  serializeListFile,
  type FileIndexEntry,
  type ListFileDocument,
} from '../src/index.js';

describe('ListFileCodec (serialize, parse & diff)', () => {
  it('serializes and parses list-file.md accurately (round-trip)', () => {
    const doc: ListFileDocument = {
      lastUpdatedAt: '2026-11-09T17:20:00.000Z',
      updatedByDevice: 'Linux-PC',
      revision: 7,
      entries: [
        {
          relativePath: 'notes/todo.txt',
          sha256: '8f434346648f6b96df89dda901c5176b',
          size: 1024,
          modifiedAt: '2026-11-09T17:19:00.000Z',
          status: 'ACTIVE',
          updatedBy: 'Android-Phone',
          driveFileId: 'drive_123',
        },
        {
          relativePath: 'docs/ke-hoach.pdf',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb924',
          size: 245120,
          modifiedAt: '2026-11-09T17:15:00.000Z',
          status: 'ACTIVE',
          updatedBy: 'Linux-PC',
          driveFileId: 'drive_456',
        },
        {
          relativePath: 'old/deleted-file.docx',
          sha256: '-',
          size: 0,
          modifiedAt: '2026-11-09T17:10:00.000Z',
          status: 'DELETED',
          updatedBy: 'Windows-PC',
          driveFileId: '-',
        },
      ],
    };

    const markdown = serializeListFile(doc);
    expect(markdown).toContain('# 📋 Danh Sách File Đồng Bộ (FolderSync Index)');
    expect(markdown).toContain('`docs/ke-hoach.pdf`');

    const parsed = parseListFile(markdown);
    expect(parsed.lastUpdatedAt).toBe(doc.lastUpdatedAt);
    expect(parsed.updatedByDevice).toBe('Linux-PC');
    expect(parsed.revision).toBe(7);
    expect(parsed.entries).toHaveLength(3);
    // Sorted alphabetically by relativePath
    expect(parsed.entries[0].relativePath).toBe('docs/ke-hoach.pdf');
    expect(parsed.entries[1].relativePath).toBe('notes/todo.txt');
    expect(parsed.entries[2].status).toBe('DELETED');
  });

  it('diffs local entries against remote list-file.md accurately (download, upload, delete, conflict)', () => {
    const baseline = {
      'same.txt': 'hash_same',
      'remote_edited.txt': 'hash_v1',
      'local_edited.txt': 'hash_v1',
      'conflict.txt': 'hash_v1',
      'deleted_on_remote.txt': 'hash_del',
    };

    const localEntries: FileIndexEntry[] = [
      {
        relativePath: 'same.txt',
        sha256: 'hash_same',
        size: 10,
        modifiedAt: '2026-11-09T10:00:00.000Z',
        status: 'ACTIVE',
        updatedBy: 'Linux-PC',
        driveFileId: 'id_same',
      },
      {
        relativePath: 'remote_edited.txt',
        sha256: 'hash_v1',
        size: 10,
        modifiedAt: '2026-11-09T10:00:00.000Z',
        status: 'ACTIVE',
        updatedBy: 'Linux-PC',
        driveFileId: 'id_rem',
      },
      {
        relativePath: 'local_edited.txt',
        sha256: 'hash_v2_local',
        size: 20,
        modifiedAt: '2026-11-09T12:00:00.000Z',
        status: 'ACTIVE',
        updatedBy: 'Linux-PC',
        driveFileId: 'id_loc',
      },
      {
        relativePath: 'new_local.txt',
        sha256: 'hash_new_local',
        size: 15,
        modifiedAt: '2026-11-09T12:05:00.000Z',
        status: 'ACTIVE',
        updatedBy: 'Linux-PC',
        driveFileId: '-',
      },
      {
        relativePath: 'conflict.txt',
        sha256: 'hash_local_conflict',
        size: 30,
        modifiedAt: '2026-11-09T13:00:00.000Z',
        status: 'ACTIVE',
        updatedBy: 'Linux-PC',
        driveFileId: 'id_conf',
      },
      {
        relativePath: 'deleted_on_remote.txt',
        sha256: 'hash_del',
        size: 12,
        modifiedAt: '2026-11-09T09:00:00.000Z',
        status: 'ACTIVE',
        updatedBy: 'Linux-PC',
        driveFileId: 'id_del',
      },
    ];

    const remoteDoc: ListFileDocument = {
      lastUpdatedAt: '2026-11-09T14:00:00.000Z',
      updatedByDevice: 'Windows-PC',
      revision: 3,
      entries: [
        {
          relativePath: 'same.txt',
          sha256: 'hash_same',
          size: 10,
          modifiedAt: '2026-11-09T10:00:00.000Z',
          status: 'ACTIVE',
          updatedBy: 'Linux-PC',
          driveFileId: 'id_same',
        },
        {
          relativePath: 'remote_edited.txt',
          sha256: 'hash_v2_remote',
          size: 25,
          modifiedAt: '2026-11-09T12:30:00.000Z',
          status: 'ACTIVE',
          updatedBy: 'Windows-PC',
          driveFileId: 'id_rem_v2',
        },
        {
          relativePath: 'local_edited.txt',
          sha256: 'hash_v1',
          size: 10,
          modifiedAt: '2026-11-09T10:00:00.000Z',
          status: 'ACTIVE',
          updatedBy: 'Linux-PC',
          driveFileId: 'id_loc',
        },
        {
          relativePath: 'new_remote.txt',
          sha256: 'hash_new_remote',
          size: 50,
          modifiedAt: '2026-11-09T12:40:00.000Z',
          status: 'ACTIVE',
          updatedBy: 'Windows-PC',
          driveFileId: 'id_new_rem',
        },
        {
          relativePath: 'conflict.txt',
          sha256: 'hash_remote_conflict',
          size: 35,
          modifiedAt: '2026-11-09T14:00:00.000Z', // Newer than local
          status: 'ACTIVE',
          updatedBy: 'Windows-PC',
          driveFileId: 'id_conf_rem',
        },
        {
          relativePath: 'deleted_on_remote.txt',
          sha256: '-',
          size: 0,
          modifiedAt: '2026-11-09T13:30:00.000Z',
          status: 'DELETED',
          updatedBy: 'Windows-PC',
          driveFileId: '-',
        },
      ],
    };

    const diff = diffListFiles(localEntries, remoteDoc, baseline);

    expect(diff.toDownload.map((e) => e.relativePath)).toEqual([
      'new_remote.txt',
      'remote_edited.txt',
    ]);
    expect(diff.toUpload.map((e) => e.relativePath)).toEqual([
      'local_edited.txt',
      'new_local.txt',
    ]);
    expect(diff.toDeleteLocally.map((e) => e.relativePath)).toEqual(['deleted_on_remote.txt']);
    expect(diff.conflicts).toHaveLength(1);
    expect(diff.conflicts[0].relativePath).toBe('conflict.txt');
    expect(diff.conflicts[0].winner).toBe('REMOTE');
  });
});
