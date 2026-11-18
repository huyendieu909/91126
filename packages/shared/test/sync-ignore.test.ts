import { describe, it, expect } from 'vitest';
import {
  isInternalSyncArtifactName,
  shouldIgnoreSyncEntryName,
  shouldIgnoreSyncRelativePath,
  SYNC_TMP_DIR_NAME,
  UNSYNCED_BACKUP_DIR_NAME,
} from '../src/index.js';

describe('sync-ignore constants & helpers', () => {
  it('identifies internal FolderSync artifact directories accurately', () => {
    expect(isInternalSyncArtifactName(SYNC_TMP_DIR_NAME)).toBe(true);
    expect(isInternalSyncArtifactName(UNSYNCED_BACKUP_DIR_NAME)).toBe(true);
    expect(isInternalSyncArtifactName('notes')).toBe(false);
    expect(isInternalSyncArtifactName('.git')).toBe(false);
  });

  it('handles ignoreListFile option, OS metadata, and transient lock/temp files', () => {
    expect(shouldIgnoreSyncEntryName('list-file.md')).toBe(false);
    expect(shouldIgnoreSyncEntryName('list-file.md', { ignoreListFile: false })).toBe(false);
    expect(shouldIgnoreSyncEntryName('list-file.md', { ignoreListFile: true })).toBe(true);

    for (const ignored of [
      '',
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
      '.git',
      '.sync_tmp',
      '.unsynced_local_backup',
      '.~lock.doc.odt#',
      '~$sheet.xlsx',
      '.#note.md',
      'a.swp',
      'a.swx',
      'file~',
      'b.tmp',
      'c.part',
      'd.crdownload',
    ]) {
      expect(shouldIgnoreSyncEntryName(ignored)).toBe(true);
    }

    expect(shouldIgnoreSyncEntryName('photo.jpg')).toBe(false);
    expect(shouldIgnoreSyncEntryName('.nomedia')).toBe(false);
  });

  it('filters relative paths across parent segments while preserving valid sync files', () => {
    expect(shouldIgnoreSyncRelativePath('')).toBe(true);
    expect(shouldIgnoreSyncRelativePath('.sync_tmp/dl_1.tmp')).toBe(true);
    expect(shouldIgnoreSyncRelativePath('.unsynced_local_backup/2026/a.txt')).toBe(true);
    expect(shouldIgnoreSyncRelativePath('.git/config')).toBe(true);
    expect(shouldIgnoreSyncRelativePath('list-file.md')).toBe(true);
    expect(shouldIgnoreSyncRelativePath('docs/.~lock.a.pdf#')).toBe(true);

    expect(shouldIgnoreSyncRelativePath('docs/readme.md')).toBe(false);
    expect(shouldIgnoreSyncRelativePath('2015w/.nomedia')).toBe(false);
  });
});
