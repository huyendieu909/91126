# Chi Tiết Giai Đoạn 2: Khởi Tạo Monorepo & Quản Lý Cấu Hình (`ConfigService`)

> **Trạng thái**: ✅ Đã hoàn thành toàn bộ Giai đoạn 2 (Task 2.1 -> Task 2.5)
> **Mục tiêu giai đoạn**: Dựng bộ khung dự án Monorepo (`pnpm`) cho cả 3 gói (`shared`, `desktop-agent`, `web-ui`), xây dựng hệ thống lưu trữ cấu hình thiết bị, trình duyệt chọn thư mục trực quan trên máy và luồng đổi đường dẫn thư mục đồng bộ (với 2 chế độ xử lý dữ liệu cũ).

---

## Danh Sách Công Việc Chi Tiết (Checklist Từng Bước Nhỏ)

### Task 2.1: Khởi tạo cấu trúc `pnpm` Monorepo & Cấu hình TypeScript chung ✅
- **Mục tiêu**: Thiết lập workspace để các gói dùng chung code TypeScript mượt mà, hỗ trợ build và kiểm thử tự động.
- **Các file sẽ tạo**:
  - `package.json` (root): khai báo scripts `build`, `dev`, `test`, `lint`.
  - `pnpm-workspace.yaml`: khai báo `packages/*`.
  - `tsconfig.base.json`: cấu hình TypeScript chuẩn (`ES2022`, `strict: true`, `moduleResolution: bundler/node`).
  - `packages/shared/package.json` & `packages/shared/tsconfig.json`.
  - `packages/desktop-agent/package.json` & `packages/desktop-agent/tsconfig.json`.
  - `packages/web-ui/package.json`, `packages/web-ui/tsconfig.json`, `packages/web-ui/vite.config.ts`, `packages/web-ui/capacitor.config.ts`.
- **Checklist thực hiện**:
  - [x] Tạo `pnpm-workspace.yaml` và `package.json` ở thư mục gốc.
  - [x] Tạo `tsconfig.base.json` dùng chung cho toàn dự án.
  - [x] Khởi tạo gói `@foldersync/shared` (chứa types và bộ xử lý `list-file.md`).
  - [x] Khởi tạo gói `@foldersync/desktop-agent` (Node.js service cho Linux/Windows).
  - [x] Khởi tạo gói `@foldersync/web-ui` (React + Vite + Tailwind CSS + cấu hình Capacitor cho Android).
  - [x] Chạy `pnpm install` và kiểm tra liên kết workspace thành công.

---

### Task 2.2: Định nghĩa Kiểu dữ liệu dùng chung (`@foldersync/shared`) ✅
- **Mục tiêu**: Thống nhất toàn bộ cấu trúc dữ liệu giữa Backend Agent, Giao diện Web/Android và file `list-file.md`.
- **File sẽ tạo**:
  - `packages/shared/src/types.ts`
  - `packages/shared/src/index.ts`
- **Chi tiết các kiểu dữ liệu cần định nghĩa**:
  1. `AppConfig`:
     - `deviceId`: mã định danh duy nhất của máy (UUID).
     - `deviceName`: tên hiển thị của thiết bị (ví dụ: `Linux-PC`, `Windows-Laptop`, `Pixel-Android`).
     - `syncFolderPath`: đường dẫn tuyệt đối tới thư mục đang đồng bộ trên máy (`string | null` khi mở app lần đầu).
     - `lastSyncedRevision`: số phiên bản của `list-file.md` ở lần đồng bộ gần nhất.
     - `googleAuth`: trạng thái đăng nhập Google (`email`, `displayName`, `accessToken`, `refreshToken`, `expiryDate`, `driveRootFolderId`).
     - `telegramBot`: cấu hình Telegram (`enabled`, `botToken`, `chatId`, `lastUpdateId`).
  2. `SwitchFolderMode` (2 chế độ khi đổi thư mục đồng bộ):
     - `'POINT_ONLY'`: Chỉ trỏ đường dẫn sang thư mục mới (giữ nguyên thư mục cũ không đụng tới) và đồng bộ lại từ đầu theo `list-file.md`.
     - `'COPY_EXISTING'`: Tự động copy toàn bộ dữ liệu đang có từ thư mục cũ sang thư mục mới rồi tiếp tục đồng bộ.
  3. `FileIndexEntry` (mỗi dòng trong `list-file.md`):
     - `relativePath`: đường dẫn tương đối trong thư mục sync (chuẩn hóa dấu `/`).
     - `sha256`: mã băm nội dung file (`-` nếu đã xóa).
     - `size`: dung lượng byte.
     - `modifiedAt`: thời gian sửa đổi (`ISO 8601`).
     - `status`: `'ACTIVE' | 'DELETED'`.
     - `updatedBy`: tên thiết bị cập nhật cuối cùng.
     - `driveFileId`: ID file trên Google Drive để tải trực tiếp.
- **Checklist thực hiện**:
  - [x] Viết đầy đủ các interface trong `packages/shared/src/types.ts`.
  - [x] Xuất (export) qua `packages/shared/src/index.ts` và build thử gói `@foldersync/shared`.

---

### Task 2.3: Xây dựng `ConfigService` (Lưu/Đọc cấu hình & Trạng thái lần đầu vào App) ✅
- **Mục tiêu**: Quản lý file cấu hình của máy, phát hiện xem đây có phải là **lần đầu mở app** (`isFirstRun: syncFolderPath === null`) hay không, và cập nhật cấu hình an toàn.
- **File sẽ tạo**:
  - `packages/desktop-agent/src/services/config-service.ts`
- **Chi tiết kỹ thuật**:
  - Mặc định lưu cấu hình tại `~/.config/foldersync/config.json` (hoặc truyền đường dẫn tùy chỉnh khi chạy test).
  - Tự động sinh `deviceId` (UUID v4) và lấy `os.hostname()` làm `deviceName` mặc định khi chạy lần đầu.
  - Cung cấp các hàm:
    - `loadConfig(): Promise<AppConfig>`
    - `saveConfig(partial: Partial<AppConfig>): Promise<AppConfig>`
    - `isConfigured(): boolean` (kiểm tra đã chọn `syncFolderPath` chưa)
    - `getPublicConfig()`: trả về cấu hình cho UI (ẩn các token nhạy cảm nếu cần).
- **Checklist thực hiện**:
  - [x] Cài đặt `ConfigService` với cơ chế ghi file nguyên tử (atomic write qua file tạm để không hỏng `config.json` khi mất điện).
  - [x] Hỗ trợ biến môi trường `FOLDERSYNC_CONFIG_PATH` để dễ dàng chạy nhiều instance độc lập khi test trên cùng 1 máy.

---

### Task 2.4: Xây dựng dịch vụ Duyệt chọn thư mục & Đổi thư mục đồng bộ (`FolderService`) ✅
- **Mục tiêu**: Cho phép người dùng chọn thư mục đồng bộ ngay trên giao diện lần đầu vào app, và đổi sang thư mục khác bất kỳ lúc nào với 2 chế độ xử lý dữ liệu.
- **File sẽ tạo**:
  - `packages/desktop-agent/src/services/folder-service.ts`
- **Chi tiết kỹ thuật**:
  1. **Duyệt cây thư mục trên máy (`listDirectories(parentPath)`)**:
     - Trả về danh sách các thư mục con trong `parentPath`, đường dẫn cha (`..`), và danh sách ổ đĩa/thư mục gốc (`/` trên Linux, `C:\`, `D:\` trên Windows, `/storage/emulated/0` trên Android).
     - Hỗ trợ tạo thư mục mới ngay tại đường dẫn đang chọn (`createDirectory(targetPath)`).
  2. **Đổi thư mục đồng bộ (`switchSyncFolder(newPath, mode)`)**:
     - Kiểm tra `newPath` có tồn tại và có quyền đọc/ghi (`fs.access`) hay không (nếu chưa tồn tại thì tự tạo).
     - Chặn trường hợp chọn `newPath` nằm bên trong `oldPath` khi đang ở chế độ copy (tránh đệ quy vô tận).
     - Nếu `mode === 'COPY_EXISTING'` và `oldPath` đã tồn tại:
       - Copy toàn bộ file và thư mục con từ `oldPath` sang `newPath` (bỏ qua thư mục tạm `.sync_tmp`).
     - Nếu `mode === 'POINT_ONLY'`:
       - Giữ nguyên `oldPath`, chỉ cập nhật `syncFolderPath = newPath` trong `ConfigService`.
     - Phát sự kiện `folderChanged(oldPath, newPath, mode)` để `FolderWatcher` (ở Giai đoạn 3) tự động ngắt theo dõi thư mục cũ và chuyển sang theo dõi thư mục mới.
- **Checklist thực hiện**:
  - [x] Viết hàm `listDirectories` hỗ trợ đa hệ điều hành (Linux & Windows).
  - [x] Viết hàm `createDirectory` và kiểm tra quyền đọc/ghi.
  - [x] Viết hàm `switchSyncFolder` xử lý trọn vẹn cả 2 chế độ `'POINT_ONLY'` và `'COPY_EXISTING'`.

---

### Task 2.5: Xây dựng REST API Cấu hình & Kiểm thử tự động Giai đoạn 2 ✅
- **Mục tiêu**: Cung cấp các endpoint HTTP cho giao diện gọi và viết Unit/Integration Test kiểm chứng toàn bộ Giai đoạn 2.
- **File sẽ tạo**:
  - `packages/desktop-agent/src/server.ts` (khung HTTP server cơ bản)
  - `packages/desktop-agent/test/config-and-folder.test.ts`
- **Danh sách API trong Giai đoạn 2**:
  - `GET /api/config`: Lấy trạng thái cấu hình hiện tại (bao gồm cờ `isFirstRun`).
  - `PUT /api/config`: Cập nhật tên thiết bị, cấu hình Telegram Bot, hoặc thông tin Google Auth.
  - `GET /api/fs/browse?path=...`: Duyệt danh sách thư mục trên máy để người dùng click chọn.
  - `POST /api/fs/mkdir`: Tạo thư mục mới khi đang chọn đường dẫn.
  - `POST /api/config/switch-folder`: Chọn thư mục lần đầu hoặc đổi thư mục đồng bộ (nhận `{ newPath, mode: 'POINT_ONLY' | 'COPY_EXISTING' }`).
- **Checklist thực hiện**:
  - [x] Xây dựng các route API trên trong `server.ts`.
  - [x] Viết bộ test tự động `config-and-folder.test.ts` kiểm tra:
    - Lần đầu mở app (`syncFolderPath` là `null` -> `isFirstRun: true`).
    - Chọn thư mục đồng bộ lần đầu thành công.
    - Đổi thư mục sang đường dẫn mới với chế độ `'COPY_EXISTING'` -> kiểm tra toàn bộ file từ thư mục cũ được copy sang thư mục mới.
    - Đổi thư mục sang đường dẫn mới với chế độ `'POINT_ONLY'` -> kiểm tra đường dẫn cập nhật đúng và thư mục cũ vẫn giữ nguyên.
  - [x] Chạy `pnpm test` xanh 100% và commit/push lên GitHub.
