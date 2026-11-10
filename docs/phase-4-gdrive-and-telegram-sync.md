# Chi Tiết Giai Đoạn 4: Tích Hợp Google Auth / Drive API, Đồng Bộ 2 Chiều & Telegram Bot

> **Trạng thái**: ✅ Đã hoàn thành toàn bộ Giai đoạn 4 (Task 4.1 -> Task 4.5) — Đang để trong Git Changes chờ ck review
> **Mục tiêu giai đoạn**: Kết nối toàn bộ chu trình đồng bộ thực tế giữa nhiều thiết bị thông qua tài khoản Google (OAuth2 + Google Drive API v3 lưu `list-file.md` & các file dữ liệu) và tích hợp Telegram Bot để vừa bắn thông báo thay đổi về điện thoại vừa làm kênh kích hoạt (Trigger) tức thì giữa các máy.

---

## Danh Sách Công Việc Chi Tiết (Checklist Từng Bước Nhỏ)

### Task 4.1: Xây dựng `GoogleOAuthService` & `GoogleDriveProvider` (`CloudStorageProvider`) ✅
- **Mục tiêu**: Cho phép đăng nhập bằng tài khoản Google (phạm vi an toàn `drive.file` chỉ truy cập thư mục của app) và đọc/ghi `list-file.md` cùng các file đồng bộ trên Google Drive.
- **Các file sẽ tạo**:
  - `packages/desktop-agent/src/services/cloud-storage.ts` (Interface `CloudStorageProvider` chuẩn + `InMemoryCloudProvider` phục vụ test đa thiết bị)
  - `packages/desktop-agent/src/services/google-drive-service.ts` (`GoogleOAuthService` + `GoogleDriveProvider` gọi trực tiếp Google OAuth2 & Drive REST API v3)
- **Chi tiết kỹ thuật**:
  - `GoogleOAuthService`:
    - Sinh link đăng nhập OAuth2 (`getAuthorizationUrl`), đổi `code` lấy `accessToken`/`refreshToken` (`exchangeCode`), lấy email/tên tài khoản (`fetchUserProfile`), và tự động làm mới token khi hết hạn (`getValidAccessToken`).
  - `GoogleDriveProvider`:
    - Tự động tạo/tìm thư mục gốc `.FolderSync_Workspace` trên Google Drive.
    - Đọc/ghi file `list-file.md` trên Drive (`readRemoteListFile`, `writeRemoteListFile`).
    - Upload file mới hoặc cập nhật nội dung file theo `driveFileId` (`uploadFile`), và tải file về ổ cứng (`downloadFile`).
- **Checklist thực hiện**:
  - [x] Định nghĩa `CloudStorageProvider` và `InMemoryCloudProvider` trong `cloud-storage.ts`.
  - [x] Cài đặt `GoogleOAuthService` và `GoogleDriveProvider` trong `google-drive-service.ts`.
  - [x] Mở rộng `AppConfig` hỗ trợ lưu `googleClientId` / `googleClientSecret` (hoặc đọc từ biến môi trường).

---

### Task 4.2: Xây dựng `TelegramService` (Thông báo gộp & Real-time Trigger) ✅
- **Mục tiêu**: Gửi thông báo gộp (batch) về Telegram mỗi khi vùng đồng bộ cập nhật `list-file.md` hoặc xảy ra xung đột, đồng thời lắng nghe tín hiệu từ Telegram để các máy đang mở tự động kéo file về ngay lập tức.
- **File sẽ tạo**:
  - `packages/desktop-agent/src/services/telegram-service.ts`
- **Chi tiết kỹ thuật**:
  - Gom nhóm thông báo trong 2.5 giây (`notifySyncSummary`) để không spam tin nhắn khi người dùng copy nhiều file liên tiếp.
  - Đính kèm thẻ phiên bản `[FolderSync Rev #<revision> | By: <deviceName>]` trong tin nhắn để các máy khác nhận biết có phiên bản `list-file.md` mới hơn `lastSyncedRevision` và tự động phát sự kiện `remoteTrigger`.
  - Hỗ trợ các lệnh tương tác trực tiếp trên Telegram Bot:
    - `/status`: Xem tên thiết bị, đường dẫn thư mục đồng bộ và số revision hiện tại.
    - `/list`: Xem danh sách nhanh các file đang `ACTIVE` trong `list-file.md`.
    - `/sync`: Ra lệnh đồng bộ ngay lập tức.
- **Checklist thực hiện**:
  - [x] Xây dựng `TelegramService` với hàm gửi thông báo, test kết nối (`sendTestMessage`), và vòng lặp `pollUpdates` an toàn.

---

### Task 4.3: Xây dựng Bộ điều phối trung tâm `SyncCoordinator` ✅
- **Mục tiêu**: Điều phối toàn bộ luồng đồng bộ 2 chiều giữa thư mục trên máy và `list-file.md` trên Google Drive (Tải file thiếu, Đẩy file mới/sửa, Xóa file theo `DELETED`, Tách file `.conflict-<tên_máy>` khi xung đột, Chống lặp `Anti-Loop`).
- **File sẽ tạo**:
  - `packages/desktop-agent/src/services/sync-coordinator.ts`
- **Chi tiết kỹ thuật**:
  - Lưu trữ bảng `baselineSyncedHashes` (`sync-state.json` cạnh file `config.json`) để đối chiếu chính xác thay đổi 3 chiều (biết máy nào sửa, máy nào giữ nguyên từ lần đồng bộ trước).
  - Lắng nghe sự kiện `indexUpdated` từ `FolderWatcher` -> tự động đẩy thay đổi mới lên Google Drive, cập nhật `list-file.md` và bắn thông báo Telegram.
  - Lắng nghe sự kiện `remoteTrigger` từ `TelegramService` (hoặc bộ hẹn giờ kiểm tra định kỳ / nút bấm `Sync Now`) -> tải `list-file.md` về đối chiếu `SHA-256` và tải đúng những file chưa đồng bộ qua `.sync_tmp` (bọc trong `folderWatcher.withWriteLock` để không bị lặp vô tận).
  - Quản lý danh sách nhật ký hoạt động (`SyncLogEntry[]`) để hiển thị trực tiếp lên giao diện.
- **Checklist thực hiện**:
  - [x] Cài đặt `SyncCoordinator` xử lý trọn vẹn Upload, Download (atomic `.sync_tmp`), Delete và Conflict (`.conflict-<tên_máy>`).
  - [x] Tự động làm mới `baselineSyncedHashes` khi đổi thư mục đồng bộ (`folderChanged`).

---

### Task 4.4: Mở rộng REST API & WebSocket Thời gian thực (`server.ts`) ✅
- **Mục tiêu**: Cung cấp đầy đủ các API cho Giao diện Web (PC) và React Native (Android) để đăng nhập Google, bấm đồng bộ ngay, cấu hình Telegram và nhận sự kiện thời gian thực qua WebSocket.
- **File sẽ cập nhật**:
  - `packages/shared/src/types.ts` (bổ sung `SyncLogEntry`, `SyncStatusSnapshot`)
  - `packages/desktop-agent/src/server.ts` & `packages/desktop-agent/src/index.ts`
- **Danh sách API mới**:
  - `GET /api/auth/google/url` & `GET /api/auth/google/callback` & `POST /api/auth/google/disconnect`
  - `GET /api/sync/status` & `GET /api/sync/logs` & `POST /api/sync/trigger`
  - `POST /api/telegram/test`
  - WebSocket `/ws`: Phát sự kiện trực tiếp xuống UI mỗi khi trạng thái hoặc `list-file.md` thay đổi.
- **Checklist thực hiện**:
  - [x] Bổ sung các route OAuth2, Sync, Telegram và tích hợp `WebSocketServer` (`/ws`) vào `server.ts`.

---

### Task 4.5: Kiểm thử Tích hợp Đa Thiết Bị (2-Node Sync Integration Tests) ✅
- **Mục tiêu**: Kiểm chứng tự động toàn bộ luồng đồng bộ giữa 2 thiết bị độc lập (`Linux-PC` và `Windows-PC`) dùng chung 1 kho lưu trữ `list-file.md`.
- **File sẽ tạo**:
  - `packages/desktop-agent/test/sync-coordinator.test.ts`
- **Các kịch bản kiểm thử bắt buộc**:
  - [x] **Kịch bản 1 (Thêm & Tải file)**: Máy A tạo 2 file mới -> cập nhật `list-file.md` & upload -> Máy B kiểm tra `list-file.md` và tự tải đúng 2 file về.
  - [x] **Kịch bản 2 (Sửa & Xóa file)**: Máy B sửa 1 file và xóa 1 file -> Máy A kiểm tra `list-file.md` -> tự cập nhật nội dung file sửa và xóa đúng file bị đánh dấu `DELETED`.
  - [x] **Kịch bản 3 (Xung đột / Conflict)**: Cả Máy A và Máy B cùng sửa 1 file khác nhau khi chưa kịp đồng bộ -> Khi đồng bộ lại, bản mới hơn thắng, bản cũ hơn được lưu thành `<tên_file>.conflict-<tên_máy>`, không mất bất kỳ dữ liệu nào.
  - [x] Chạy toàn bộ test suite (`pnpm test` — 14/14 tests passed) xanh 100% và để nguyên trong Git Changes chờ ck review.
