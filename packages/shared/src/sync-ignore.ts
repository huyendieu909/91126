import { LIST_FILE_NAME } from './list-file-codec.js';

export const SYNC_TMP_DIR_NAME = '.sync_tmp';
export const UNSYNCED_BACKUP_DIR_NAME = '.unsynced_local_backup';
export const GIT_DIR_NAME = '.git';

export const INTERNAL_SYNC_ARTIFACT_NAMES = [
  SYNC_TMP_DIR_NAME,
  UNSYNCED_BACKUP_DIR_NAME,
] as const;

export const SYSTEM_IGNORED_NAMES = [
  GIT_DIR_NAME,
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
] as const;

export const TRANSIENT_FILE_PREFIXES = [
  SYNC_TMP_DIR_NAME,
  UNSYNCED_BACKUP_DIR_NAME,
  '.~lock.',
  '~$',
  '.#',
] as const;

export const TRANSIENT_FILE_SUFFIXES = [
  SYNC_TMP_DIR_NAME,
  '.swp',
  '.swx',
  '~',
  '.tmp',
  '.part',
  '.crdownload',
] as const;

const SYSTEM_IGNORED_SET = new Set<string>(SYSTEM_IGNORED_NAMES);
const INTERNAL_ARTIFACT_SET = new Set<string>(INTERNAL_SYNC_ARTIFACT_NAMES);

/** Kiểm tra tên file/thư mục có phải thành phần tạm nội bộ của FolderSync hay không. */
export function isInternalSyncArtifactName(name: string): boolean {
  return INTERNAL_ARTIFACT_SET.has(name);
}

/** Kiểm tra một tên file/thư mục đơn lẻ có cần bỏ qua khi quét đồng bộ hay không. */
export function shouldIgnoreSyncEntryName(
  name: string,
  options?: { ignoreListFile?: boolean },
): boolean {
  if (!name) return true;
  if (options?.ignoreListFile && name === LIST_FILE_NAME) return true;
  if (INTERNAL_ARTIFACT_SET.has(name) || SYSTEM_IGNORED_SET.has(name)) return true;

  return (
    TRANSIENT_FILE_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    TRANSIENT_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** Kiểm tra một đường dẫn tương đối đầy đủ (kể cả thư mục cha) có cần bỏ qua hay không. */
export function shouldIgnoreSyncRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return true;

  const segments = normalized.split('/');
  for (const seg of segments.slice(0, -1)) {
    if (isInternalSyncArtifactName(seg) || seg === GIT_DIR_NAME) {
      return true;
    }
  }

  const base = segments[segments.length - 1];
  return shouldIgnoreSyncEntryName(base, { ignoreListFile: true });
}
