# 🔄 FolderSync — Đồng Bộ Thư Mục Đa Nền Tảng Qua Trạm Trung Chuyển Tự Hủy (Android · Linux · Windows)

Ứng dụng đồng bộ một thư mục tùy chọn giữa nhiều thiết bị (**Android**, **Linux**, **Windows**) thông qua bảng chỉ mục **`list-file.md`** + **Google Drive Ephemeral Relay (Trạm trung chuyển tự hủy)** + **Telegram Bot Trigger** (không cần thiết lập mạng LAN cố định, mở port hay dựng server riêng).

> 📖 **Tài liệu Kiến trúc & Sơ đồ Mermaid chi tiết**: Xem tại [`docs/system-architecture.md`](./docs/system-architecture.md)

---

## ✨ Tính Năng Cốt Lõi

1. **Chọn & Đổi thư mục đồng bộ linh hoạt + Bảo vệ dữ liệu có sẵn**:
   - Lần đầu mở ứng dụng yêu cầu chọn thư mục đồng bộ trên máy (`isFirstRun: true`).
   - Đổi sang đường dẫn khác bất kỳ lúc nào với **2 lựa chọn chuyển đổi**:
     - `POINT_ONLY`: Chỉ trỏ sang thư mục mới và đồng bộ lại theo `list-file.md`.
     - `COPY_EXISTING`: Tự động copy toàn bộ dữ liệu từ thư mục cũ sang thư mục mới.
   - Khi chọn vào thư mục **đã có sẵn file cá nhân** (`existingFilesCount > 0`), hệ thống cảnh báo và cho phép chọn **3 chế độ bảo vệ**:
     - `MERGE_ALL`: Gộp chung toàn bộ file có sẵn vào mạng đồng bộ.
     - `ISOLATE_BACKUP`: Cô lập toàn bộ file có sẵn vào `.unsynced_local_backup/<timestamp>` để tránh đẩy nhầm lên các máy khác.
     - `CREATE_SUBFOLDER`: Tự động tạo thư mục con trống `FolderSync` bên trong để đồng bộ riêng biệt.

2. **Google Drive làm "Trạm Trung Chuyển Tự Hủy" (Ephemeral Relay)**:
   - Không biến Google Drive thành kho lưu trữ đám mây tốn dung lượng: Google Drive chỉ giữ cố định file chỉ mục văn bản **`list-file.md`**.
   - Ngay khi tất cả thiết bị đã biết trong mạng (`knownDevices`, $\ge 2$ máy) đều đã tải file vật lý về ổ cứng (`syncedDevices`), hệ thống **tự động xóa vĩnh viễn file vật lý đó trên Google Drive** (`driveFileId = '-'`).
   - Nếu có máy mới tham gia vào sau, máy mới tự bật cờ `@NEED_UPLOAD` trong `list-file.md` để một máy cũ đẩy tạm lại file lên Drive rồi lại tự hủy sau khi tải xong.

3. **Tự động dọn sạch dòng `DELETED` & Chống xung đột (`.conflict-<device>`)**:
   - Khi 1 máy xóa file, dòng file trong `list-file.md` chuyển thành `DELETED` để các máy khác xóa theo. Ngay khi tất cả máy trong `knownDevices` đã xóa xong, **dòng `DELETED` tự động được xóa hẳn khỏi `list-file.md`**.
   - Tải file qua `.sync_tmp` kèm khóa `Anti-Loop` chống lặp vô tận; tự động tách bản lưu `<tên_file>.conflict-<tên_máy>` khi 2 máy cùng sửa 1 file lúc offline.

4. **Hỗ trợ Android (Expo SDK 58) hoạt động độc lập trên cả 4G/5G**:
   - Quét đệ quy cây thư mục Android Storage Access Framework (SAF) an toàn.
   - Hỗ trợ **Liên kết 1-Chạm** nhận khóa `refreshToken` vĩnh viễn từ PC (`GET /api/auth/mobile-bridge`) hoặc **Đăng nhập độc lập trên 4G/5G** bằng mã xác thực trình duyệt, tự động gia hạn `accessToken` trực tiếp với Google mà không cần PC.

5. **Thông báo & Kích hoạt tức thì qua Telegram Bot**:
   - Tự động bắn thông báo gộp về Telegram khi vùng sync có cập nhật và kích hoạt các máy khác kéo file ngay lập tức.
   - Hỗ trợ lệnh `/status`, `/list`, `/sync` trực tiếp trên Telegram.

---

## ⚙️ Cấu Hình Biến Môi Trường (`.env`)

Sao chép file `.env.example` thành `.env` ở thư mục gốc của dự án để `desktop-agent` tự động nạp thông tin Google OAuth2:

```bash
cp .env.example .env
```

Nội dung `.env`:
```env
GOOGLE_CLIENT_ID=<client-id-của-bạn>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client-secret-của-bạn>
PORT=8384
```

---

## 🚀 Hướng Dẫn Khởi Chạy

### 1. Cài đặt & Build toàn bộ Monorepo
```bash
pnpm install
pnpm build
```

### 2. Chạy trên Linux & Windows (Desktop Agent + Web Dashboard)
```bash
pnpm start
# Hoặc: pnpm --filter @foldersync/desktop-agent start
```
Sau đó mở trình duyệt truy cập: **`http://localhost:8384`**

### 3. Debug Mobile App & Đa Thiết Bị Trực Tiếp Trên Máy Dev (Không Cần Expo Go / APK)
- **Mở trình giả lập Mobile App trên trình duyệt máy Dev (Hot-Reload + `F12` Breakpoint)**:
  ```bash
  pnpm dev:mobile
  ```
  Sau đó mở trình duyệt tại **`http://localhost:8390`** (chạy trực tiếp `packages/mobile-app/App.tsx` và `android-sync-engine.ts` gắn với thư mục thật trên ổ cứng máy Dev).
- **Chạy thêm Node PC thứ 2 độc lập ngay trên cùng máy (tự kế thừa sẵn khóa Google OAuth)**:
  ```bash
  pnpm dev:node2
  ```
  Mở **`http://localhost:8385`** để kiểm thử đồng bộ song song 2–3 thiết bị / đa vùng ngay trên 1 màn hình.

### 4. Chạy trên Điện Thoại Android Thật (React Native / Expo SDK 58)
```bash
npx --yes expo@58.0.23 start --dir packages/mobile-app --lan
```
Mở ứng dụng **Expo Go (SDK 58)** trên điện thoại Android để quét mã QR (hoặc nhập URL `exp://<IP-LAN>:8081`).

### 5. Chạy bộ kiểm thử tự động (Unit & Multi-Device Integration Tests)
```bash
pnpm test
```

---

## 📚 Danh Mục Tài Liệu Trong `docs/`

- [`docs/system-architecture.md`](./docs/system-architecture.md) — **Kiến trúc hệ thống & Sơ đồ Mermaid chi tiết (Phase 1 -> Phase 8)**.
- [`docs/task.md`](./docs/task.md) — Bảng theo dõi tiến độ từng Task.
- [`docs/implementation_plan.md`](./docs/implementation_plan.md) — Kế hoạch triển khai tổng thể.
- [`docs/phase-2-setup-and-config.md`](./docs/phase-2-setup-and-config.md) — Chi tiết Giai đoạn 2 (`ConfigService`, `FolderService`).
- [`docs/phase-3-watcher-and-list-file.md`](./docs/phase-3-watcher-and-list-file.md) — Chi tiết Giai đoạn 3 (`FileIndexer`, `FolderWatcher`, `list-file.md`).
- [`docs/phase-4-gdrive-and-telegram-sync.md`](./docs/phase-4-gdrive-and-telegram-sync.md) — Chi tiết Giai đoạn 4 (`GoogleDriveProvider`, `TelegramService`, `SyncCoordinator`).
- [`docs/phase-5-ui-web-and-mobile.md`](./docs/phase-5-ui-web-and-mobile.md) — Chi tiết Giai đoạn 5–8 (`@foldersync/web-ui`, `@foldersync/mobile-app`, Ephemeral Relay, 4G/5G Auth).
