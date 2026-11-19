# Chi Tiết Giai Đoạn 5: Giao Diện Người Dùng (Web Dashboard cho PC & React Native App cho Android)

> **Trạng thái**: ✅ Đã hoàn thành toàn bộ Giai đoạn 5 (Task 5.1 -> Task 5.5) — Đang để trong Git Changes chờ ck review
> **Mục tiêu giai đoạn**: Xây dựng hoàn chỉnh giao diện quản trị hiện đại (Dark Mode / Glassmorphism) cho Linux & Windows tại `http://localhost:8384` (`@foldersync/web-ui`) và ứng dụng di động Native cho Android bằng React Native / Expo (`@foldersync/mobile-app`) dùng chung lõi xử lý `list-file.md` từ `@foldersync/shared`.

---

## Danh Sách Công Việc Chi Tiết (Checklist Từng Bước Nhỏ)

### Task 5.1: Khởi tạo hạ tầng giao diện `@foldersync/web-ui` & API/WebSocket Client ✅
- **Mục tiêu**: Cấu hình Vite + React + Tailwind CSS và lớp kết nối REST API + WebSocket thời gian thực tới `desktop-agent`.
- **Các file sẽ tạo**:
  - `packages/web-ui/index.html`
  - `packages/web-ui/tailwind.config.js` & `packages/web-ui/postcss.config.js`
  - `packages/web-ui/src/index.css`
  - `packages/web-ui/src/services/api.ts`
- **Checklist thực hiện**:
  - [x] Cấu hình Tailwind CSS (giao diện tối hiện đại Slate/Indigo/Emerald) và `index.html`.
  - [x] Xây dựng `api.ts` bọc toàn bộ REST endpoints và kết nối tự động lại WebSocket `/ws`.

---

### Task 5.2: Xây dựng Trình duyệt chọn thư mục (`FolderBrowserModal`) & Màn hình lần đầu vào App (`OnboardingView`) ✅
- **Mục tiêu**: Đáp ứng yêu cầu cốt lõi: lần đầu vào app chọn thư mục đồng bộ, và sau này có thể đổi đường dẫn bất kỳ lúc nào với 2 lựa chọn xử lý dữ liệu.
- **Các file sẽ tạo**:
  - `packages/web-ui/src/components/FolderBrowserModal.tsx`
  - `packages/web-ui/src/components/OnboardingView.tsx`
- **Checklist thực hiện**:
  - [x] Xây dựng `FolderBrowserModal`: duyệt cây thư mục ổ đĩa, tạo thư mục mới tại chỗ, và hiển thị hộp chọn 2 chế độ khi đổi thư mục (`POINT_ONLY` vs `COPY_EXISTING`).
  - [x] Xây dựng `OnboardingView`: thiết lập tên thiết bị, chọn thư mục đồng bộ lần đầu và hướng dẫn kết nối Google Drive.

---

### Task 5.3: Xây dựng Màn hình Dashboard Chính cho PC (`@foldersync/web-ui`) ✅
- **Mục tiêu**: Quản lý trực quan toàn bộ hoạt động đồng bộ, xem nội dung `list-file.md`, kết nối Google OAuth2, cấu hình Telegram Bot và theo dõi nhật ký trực tiếp.
- **Các file sẽ tạo**:
  - `packages/web-ui/src/components/ListFileTable.tsx` (xem bảng file & xem trực tiếp mã Markdown `list-file.md`)
  - `packages/web-ui/src/components/SettingsModals.tsx` (kết nối Google OAuth & cài đặt Telegram Bot + nút Test)
  - `packages/web-ui/src/components/SyncActivityLog.tsx` (nhật ký thời gian thực qua WebSocket)
  - `packages/web-ui/src/App.tsx` & `packages/web-ui/src/main.tsx`
- **Checklist thực hiện**:
  - [x] Xây dựng `ListFileTable` hỗ trợ tìm kiếm, lọc trạng thái `ACTIVE`/`DELETED` và bật xem nội dung gốc `list-file.md`.
  - [x] Xây dựng bảng cấu hình Google Drive OAuth2 & Telegram Bot (kèm nút gửi tin nhắn test).
  - [x] Hoàn thiện `App.tsx` kết nối WebSocket tự động cập nhật UI ngay khi có file thay đổi trong thư mục.

---

### Task 5.4: Xây dựng Ứng dụng Android Native bằng React Native / Expo (`@foldersync/mobile-app`) ✅
- **Mục tiêu**: Xây dựng ứng dụng Android mượt mà sử dụng `expo-file-system` (Storage Access Framework), `expo-crypto` (`SHA-256`), `expo-auth-session` (Google Login) và dùng chung 100% logic `list-file.md` từ `@foldersync/shared`.
- **Các file sẽ tạo**:
  - `packages/mobile-app/src/storage/mobile-config.ts` (lưu cấu hình thiết bị Android & đường dẫn SAF URI)
  - `packages/mobile-app/src/services/android-sync-engine.ts` (chọn/đổi thư mục Android với 2 chế độ, băm `SHA-256` native, đọc/ghi `list-file.md` trên Google Drive, tải file thiếu, tách file `.conflict` và bắn thông báo Telegram)
  - `packages/mobile-app/App.tsx` & `packages/mobile-app/index.ts` (Giao diện Native Android: Onboarding lần đầu chọn thư mục, Dashboard đồng bộ, Đổi thư mục 2 chế độ, Cài đặt Google & Telegram, Danh sách `list-file.md` bằng `FlatList`)
- **Checklist thực hiện**:
  - [x] Xây dựng `mobile-config.ts` và `android-sync-engine.ts`.
  - [x] Xây dựng giao diện React Native hoàn chỉnh trong `packages/mobile-app/App.tsx` & `index.ts`.

---

### Task 5.5: Build Kiểm Chứng Toàn Bộ Giao Diện & Kiểm Thử Phục Vụ UI ✅
- **Mục tiêu**: Đảm bảo cả `@foldersync/web-ui` và `@foldersync/mobile-app` đều biên dịch không có lỗi TypeScript, và `desktop-agent` phục vụ thành công giao diện Web tại `localhost:8384`.
- **File kiểm thử sẽ tạo**:
  - `packages/desktop-agent/test/web-ui-serving.test.ts`
- **Checklist thực hiện**:
  - [x] Chạy `pnpm --filter @foldersync/web-ui build` thành công.
  - [x] Kiểm tra TypeScript cho `@foldersync/mobile-app` (`pnpm --filter @foldersync/mobile-app build`).
  - [x] Viết và chạy pass bài test phục vụ Web UI + WebSocket (`web-ui-serving.test.ts`) cùng toàn bộ test suite dự án (`18/18 tests passed`).

---

## Mở Rộng Giai Đoạn 7 & 8: Trạm Trung Chuyển Tự Hủy, Bảo Vệ Thư Mục Có Sẵn File & Xác Thực 4G/5G (Expo SDK 58)

- **Trạm Trung Chuyển Tự Hủy (Ephemeral Relay)**:
  - Mở rộng `ListFileDocument` (`knownDevices`) và `FileIndexEntry` (`syncedDevices`, `requestUpload` / `@NEED_UPLOAD`).
  - Tự động gọi `deleteRemoteFile` xóa file vật lý trên Google Drive ngay khi tất cả thiết bị trong `knownDevices` ($\ge 2$) đã đồng bộ xong.
  - Tự động xóa hẳn dòng `DELETED` khỏi `list-file.md` khi tất cả thiết bị đã xóa file cục bộ.
- **Bảo Vệ Thư Mục Đã Có Sẵn Dữ Liệu (`existingFilesCount > 0`)**:
  - Hỗ trợ 3 chế độ khi chọn thư mục không trống: `MERGE_ALL` (gộp chung), `ISOLATE_BACKUP` (di chuyển vào `.unsynced_local_backup/<timestamp>`), và `CREATE_SUBFOLDER` (tạo thư mục con `FolderSync`).
- **Nâng Cấp Mobile App (Expo SDK 58 & Hoạt Động Độc Lập Trên 4G/5G)**:
  - Nâng cấp lên `expo@~58.0.23`, quét đệ quy cây thư mục SAF (`scanSafDirectoryEntriesRecursive`).
  - Bổ sung `GET /api/auth/mobile-bridge` để chuyển giao `refreshToken` vĩnh viễn 1-chạm từ PC sang điện thoại và tự động gia hạn `accessToken` trực tiếp với Google trên mạng 4G/5G.
