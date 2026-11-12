export type SwitchFolderMode = 'POINT_ONLY' | 'COPY_EXISTING';

export type ExistingDataStrategy = 'MERGE_ALL' | 'ISOLATE_BACKUP' | 'CREATE_SUBFOLDER';

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
  /** ID của file trên Google Drive để tải trực tiếp (hoặc '-' nếu đã tự hủy sau khi đồng bộ xong) */
  driveFileId: string;
  /** Danh sách các thiết bị đã có bản sao mã SHA-256 này trên ổ cứng nội bộ */
  syncedDevices?: string[];
  /** Cờ báo có thiết bị mới/thiếu file yêu cầu máy đang giữ file đẩy tạm lại lên trạm trung chuyển */
  requestUpload?: boolean;
}

export interface ListFileDocument {
  /** Thời điểm cập nhật bảng chỉ mục lần cuối (ISO 8601) */
  lastUpdatedAt: string;
  /** Tên thiết bị thực hiện cập nhật lần cuối */
  updatedByDevice: string;
  /** Số thứ tự phiên bản của list-file.md */
  revision: number;
  /** Danh sách các thiết bị đã tham gia đồng bộ trong nhóm */
  knownDevices?: string[];
  /** Danh sách các bản ghi file */
  entries: FileIndexEntry[];
}

export interface GoogleAuthInfo {
  clientId: string | null;
  clientSecret: string | null;
  email: string | null;
  displayName: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  driveRootFolderId: string | null;
  listFileDriveId: string | null;
}

export interface TelegramBotConfig {
  enabled: boolean;
  pausedByUser?: boolean;
  botToken: string;
  botUsername?: string | null;
  chatId: string;
  chatTitle?: string | null;
  lastUpdateId: number;
}

export interface TelegramChatCandidate {
  chatId: string;
  title: string;
  type: string;
  username?: string;
}

export interface TelegramPairingSession {
  pairCode: string;
  botUsername: string;
  deepLinkUrl: string;
  groupInviteUrl: string;
}

/**
 * Thông tin một Vùng Đồng Bộ (Sync Zone) lưu trên Google Drive (zones-registry.json)
 */
export interface SyncZoneMetadata {
  zoneId: string;
  zoneName: string;
  description?: string;
  /** ID thư mục riêng của Vùng này trên Google Drive */
  driveFolderId: string;
  /** ID file list-file.md riêng của Vùng này trên Google Drive */
  listFileDriveId: string | null;
  createdAt: string;
  createdBy: string;
  /** Danh sách tên các thiết bị đang tham gia (joined) vào Vùng đồng bộ này */
  memberDevices: string[];
}

export interface ZonesRegistryDocument {
  updatedAt: string;
  zones: SyncZoneMetadata[];
}

/**
 * Trạng thái liên kết Vùng Đồng Bộ trên từng thiết bị cụ thể (PC hoặc Android)
 */
export interface LocalZoneBinding {
  zoneId: string;
  zoneName: string;
  description?: string;
  /** Thiết bị hiện tại có đang bật tham gia đồng bộ Vùng này hay không */
  joined: boolean;
  /** Đường dẫn thư mục cục bộ trên PC hoặc SAF Directory URI trên Android */
  localFolderPath: string | null;
  driveFolderId: string | null;
  listFileDriveId: string | null;
  lastSyncedRevision: number;
  lastSyncedAt: string | null;
  memberDevices: string[];
}

export interface AppConfig {
  deviceId: string;
  deviceName: string;
  /** Đường dẫn thư mục đồng bộ đang chọn (tương ứng với Vùng đang active) */
  syncFolderPath: string | null;
  lastSyncedRevision: number;
  /** ID của Vùng đồng bộ đang được chọn hiển thị/active trên thiết bị */
  activeZoneId?: string | null;
  /** Danh sách các Vùng đồng bộ mà thiết bị biết hoặc đang tham gia */
  zones?: LocalZoneBinding[];
  googleAuth: GoogleAuthInfo;
  telegramBot: TelegramBotConfig;
}

export interface PublicAppConfig extends Omit<AppConfig, 'googleAuth' | 'telegramBot'> {
  isFirstRun: boolean;
  googleAuth: {
    isConnected: boolean;
    hasClientCredentials: boolean;
    clientId: string | null;
    email: string | null;
    displayName: string | null;
    driveRootFolderId: string | null;
  };
  telegramBot: {
    enabled: boolean;
    hasToken: boolean;
    botUsername?: string | null;
    chatId: string;
    chatTitle?: string | null;
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
  /** Số lượng file dữ liệu đang có sẵn trong thư mục currentPath */
  existingFilesCount?: number;
}

export interface SwitchFolderRequest {
  newPath: string;
  mode: SwitchFolderMode;
  existingDataStrategy?: ExistingDataStrategy;
}

export interface SwitchFolderResult {
  previousPath: string | null;
  newPath: string;
  mode: SwitchFolderMode;
  copiedFilesCount: number;
  existingDataStrategy?: ExistingDataStrategy;
  isolatedFilesCount?: number;
  isolatedBackupPath?: string | null;
}

export interface ConflictPair {
  relativePath: string;
  localEntry: FileIndexEntry;
  remoteEntry: FileIndexEntry;
  /** Bản có modifiedAt mới hơn được giữ làm file chính */
  winner: 'LOCAL' | 'REMOTE';
}

export interface ListFileDiffResult {
  toDownload: FileIndexEntry[];
  toUpload: FileIndexEntry[];
  toDeleteLocally: FileIndexEntry[];
  toMarkDeletedRemotely: FileIndexEntry[];
  conflicts: ConflictPair[];
}

export type SyncLogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';

export interface SyncLogEntry {
  id: string;
  timestamp: string;
  level: SyncLogLevel;
  action: string;
  message: string;
}

export interface SyncRunSummary {
  reason: string;
  uploadedCount: number;
  downloadedCount: number;
  deletedLocallyCount: number;
  markedDeletedRemotelyCount: number;
  conflictsCount: number;
  revision: number;
  completedAt: string;
}

export type SyncProgressPhase =
  | 'IDLE'
  | 'SCANNING'
  | 'PREPARING'
  | 'UPLOADING'
  | 'DOWNLOADING'
  | 'DELETING'
  | 'FINALIZING';

export interface SyncProgress {
  phase: SyncProgressPhase;
  current: number;
  total: number;
  currentPath?: string | null;
  message?: string;
  /** 0-100 when total > 0 */
  percent: number;
}

export interface SyncStatusSnapshot {
  isSyncing: boolean;
  cloudReady: boolean;
  lastSyncedAt: string | null;
  lastSyncedRevision: number;
  lastError: string | null;
  lastSummary: SyncRunSummary | null;
  progress: SyncProgress | null;
}
