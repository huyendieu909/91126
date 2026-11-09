export type SwitchFolderMode = 'POINT_ONLY' | 'COPY_EXISTING';

export type FileSyncStatus = 'ACTIVE' | 'DELETED';

export interface FileIndexEntry {
  /** Đường dẫn tương đối bên trong thư mục đồng bộ (chuẩn hóa dấu /) */
  relativePath: string;
  /** Mã băm SHA-256 nội dung file (hoặc '-' nếu status === 'DELETED') */
  sha256: string;
  /** Dung lượng file tính theo byte */
  size: number;
  /** Thời gian chỉnh sửa cuối cùng (ISO 8601) */
  modifiedAt: string;
  /** Trạng thái tồn tại hoặc đã xóa (Tombstone) */
  status: FileSyncStatus;
  /** Tên thiết bị cập nhật cuối cùng */
  updatedBy: string;
  /** ID của file trên Google Drive để tải trực tiếp (hoặc '-' nếu chưa có / đã xóa) */
  driveFileId: string;
}

export interface ListFileDocument {
  /** Thời điểm cập nhật bảng chỉ mục lần cuối (ISO 8601) */
  lastUpdatedAt: string;
  /** Tên thiết bị thực hiện cập nhật lần cuối */
  updatedByDevice: string;
  /** Số thứ tự phiên bản của list-file.md */
  revision: number;
  /** Danh sách các bản ghi file */
  entries: FileIndexEntry[];
}

export interface GoogleAuthInfo {
  email: string | null;
  displayName: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  driveRootFolderId: string | null;
}

export interface TelegramBotConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  lastUpdateId: number;
}

export interface AppConfig {
  deviceId: string;
  deviceName: string;
  /** Đường dẫn thư mục đồng bộ trên máy (null khi mở app lần đầu) */
  syncFolderPath: string | null;
  lastSyncedRevision: number;
  googleAuth: GoogleAuthInfo;
  telegramBot: TelegramBotConfig;
}

export interface PublicAppConfig extends Omit<AppConfig, 'googleAuth' | 'telegramBot'> {
  isFirstRun: boolean;
  googleAuth: {
    isConnected: boolean;
    email: string | null;
    displayName: string | null;
    driveRootFolderId: string | null;
  };
  telegramBot: {
    enabled: boolean;
    hasToken: boolean;
    chatId: string;
  };
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryBrowseResult {
  currentPath: string;
  parentPath: string | null;
  roots: string[];
  directories: DirectoryEntry[];
}

export interface SwitchFolderRequest {
  newPath: string;
  mode: SwitchFolderMode;
}

export interface SwitchFolderResult {
  previousPath: string | null;
  newPath: string;
  mode: SwitchFolderMode;
  copiedFilesCount: number;
}
