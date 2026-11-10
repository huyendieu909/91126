# Tiến Độ Xây Dựng Ứng Dụng Đồng Bộ Thư Mục Đa Nền Tảng (Android, Linux, Windows)

## Giai đoạn 1: Phân tích & Chốt kiến trúc (Planning & `/grill-me`)
- [x] Phân tích bài toán, các thách thức kỹ thuật và lập kế hoạch triển khai ban đầu
- [x] Phỏng vấn chi tiết (`/grill-me`) và tối ưu hóa kiến trúc không cần hạ tầng mạng phức tạp:
  - **Xác thực & Lưu trữ trung gian**: Đăng nhập bằng **Google OAuth2** + sử dụng **Google Drive API** làm nơi lưu trữ trung gian tự động (không cần cấu hình mạng LAN/IP/Server/Passkey)
  - **Cơ chế chỉ mục trung tâm (`list-file.md`)**: Tự động sinh và cập nhật file `list-file.md` (chứa đường dẫn, mã `SHA-256`, dung lượng, thời gian sửa, trạng thái `ACTIVE/DELETED`, `DriveFileId`). Các máy chỉ cần đọc `list-file.md` để đối chiếu hash và tải đúng những file chưa đồng bộ
  - **Tech Stack**: Node.js / TypeScript Monorepo (`pnpm`) — PC chạy Local Agent + Web UI (`localhost:8384`), Android chạy **React Native (Expo)** (`packages/mobile-app`) dùng chung 100% logic `@foldersync/shared`
  - **Tích hợp Telegram Bot (Trigger & Thông báo)**: Bắn thông báo về Telegram ngay khi `list-file.md` cập nhật để kích hoạt các máy PC khác đồng bộ tức thì và báo cho điện thoại Android biết có thay đổi
  - **Đổi thư mục đồng bộ**: Hộp thoại 2 lựa chọn (1: Chỉ trỏ sang thư mục mới, 2: Tự động copy dữ liệu từ thư mục cũ sang thư mục mới)
  - **Xử lý xung đột**: Giữ bản mới nhất làm chính + Lưu bản kia thành `<tên_file>.conflict-<tên_máy>`
- [x] Khởi tạo Git local (`main`), cấu hình cô lập tài khoản `hd911910@gmail.com` (`--local`) và tạo SSH key riêng (`~/.ssh/id_hd911910`)
- [x] Thêm SSH Public Key lên GitHub và kết nối remote repository (`git@github.com:huyendieu909/91126.git`)

## Giai đoạn 2: Khởi tạo Monorepo & Quản lý cấu hình (`ConfigService`)
> 📄 **Tài liệu chi tiết giai đoạn này**: [docs/phase-2-setup-and-config.md](./phase-2-setup-and-config.md)

- [x] **Task 2.1**: Khởi tạo `pnpm` workspace (`packages/shared`, `packages/desktop-agent`, `packages/web-ui`, `packages/mobile-app`) và cấu hình TypeScript
- [x] **Task 2.2**: Định nghĩa kiểu dữ liệu dùng chung (`AppConfig`, `SwitchFolderMode`, `FileIndexEntry`) trong `@foldersync/shared`
- [x] **Task 2.3**: Xây dựng `ConfigService` (lưu/đọc cấu hình nguyên tử, kiểm tra trạng thái lần đầu mở app `isFirstRun`)
- [x] **Task 2.4**: Xây dựng `FolderService` (duyệt cây thư mục Linux/Windows và đổi thư mục đồng bộ với 2 chế độ `POINT_ONLY` / `COPY_EXISTING`)
- [x] **Task 2.5**: Xây dựng REST API cấu hình & viết Unit/Integration Test kiểm chứng toàn bộ Giai đoạn 2

## Giai đoạn 3: Bộ theo dõi thư mục & Bộ sinh file chỉ mục (`list-file.md`)
> 📄 **Tài liệu chi tiết giai đoạn này**: [docs/phase-3-watcher-and-list-file.md](./phase-3-watcher-and-list-file.md)

- [x] **Task 3.1**: Xây dựng `ListFileCodec` (`serializeListFile`, `parseListFile`, `diffListFiles`) trong `@foldersync/shared`
- [x] **Task 3.2**: Xây dựng `FileIndexer` (quét thư mục, tính `SHA-256` stream, cập nhật `list-file.md` và tạo file `.conflict-<tên_máy>`)
- [x] **Task 3.3**: Xây dựng `FolderWatcher` (`chokidar` + Debounce 400ms + Anti-Loop lock + tự chuyển vùng khi đổi thư mục)
- [x] **Task 3.4**: Viết bộ kiểm thử tự động `list-file-codec.test.ts` và `watcher-and-indexer.test.ts` cho Giai đoạn 3

## Giai đoạn 4: Tích hợp Google OAuth2 / Drive API & Telegram Trigger
> 📄 **Tài liệu chi tiết giai đoạn này**: [docs/phase-4-gdrive-and-telegram-sync.md](./phase-4-gdrive-and-telegram-sync.md)

- [x] **Task 4.1**: Xây dựng `CloudStorageProvider`, `GoogleOAuthService` và `GoogleDriveProvider` (đọc/ghi `list-file.md` & truyền file qua Google Drive API v3)
- [x] **Task 4.2**: Xây dựng `TelegramService` (bắn thông báo gộp, nhận tín hiệu Trigger tự động và xử lý lệnh `/status`, `/list`, `/sync`)
- [x] **Task 4.3**: Xây dựng `SyncCoordinator` (điều phối đồng bộ 2 chiều qua `list-file.md`, chống lặp `Anti-Loop`, xử lý `DELETED` và xung đột `.conflict-<tên_máy>`)
- [x] **Task 4.4**: Mở rộng REST API (Google OAuth, Sync Trigger, Telegram Test) và WebSocket (`/ws`) thời gian thực
- [x] **Task 4.5**: Viết bộ kiểm thử tích hợp đa thiết bị (`sync-coordinator.test.ts`: Thêm, Sửa, Xóa, Xung đột 2 chiều)

## Giai đoạn 5: Giao diện người dùng (Web Dashboard cho PC & React Native App cho Android)
> 📄 **Tài liệu chi tiết giai đoạn này**: [docs/phase-5-ui-web-and-mobile.md](./phase-5-ui-web-and-mobile.md)

- [x] **Task 5.1**: Khởi tạo hạ tầng giao diện `@foldersync/web-ui` (Vite + React + Tailwind CSS) & API/WebSocket Client
- [x] **Task 5.2**: Xây dựng `FolderBrowserModal` (duyệt cây thư mục + 2 chế độ đổi thư mục) & `OnboardingView` (lần đầu vào app)
- [x] **Task 5.3**: Xây dựng màn hình Dashboard chính cho PC (`ListFileTable`, Google OAuth 1-click popup qua `.env` & Telegram Settings, Real-time Sync Log)
- [x] **Task 5.4**: Xây dựng ứng dụng Android bằng React Native / Expo (`@foldersync/mobile-app`: SAF Folder Picker, Native SHA-256, Google Drive `list-file.md` sync & UI)
- [x] **Task 5.5**: Build kiểm chứng toàn bộ giao diện (`web-ui` & `mobile-app`) và kiểm thử tích hợp phục vụ Web UI + WebSocket

## Giai đoạn 6: Kiểm thử thực tế (Verification)
- [x] Kiểm thử tự động bộ đọc/ghi `list-file.md`, phát hiện lệch mã hash, xóa file, xử lý xung đột `.conflict` và đổi thư mục đồng bộ
- [x] Kiểm thử toàn diện luồng đồng bộ giữa 2 thiết bị và giao diện Web UI (`16/16 tests passed` trên toàn bộ 5 bộ test)

## Giai đoạn 7: Cơ chế Trạm Trung Chuyển Tự Hủy (Ephemeral Drive Relay)
- [x] **Task 7.1**: Mở rộng cấu trúc `ListFileDocument` & `ListFileCodec` trong `@foldersync/shared` (thêm `knownDevices`, danh sách máy đã nhận file `syncedDevices` và cờ yêu cầu đẩy lại `requestUpload`)
- [x] **Task 7.2**: Cập nhật `SyncCoordinator` (Desktop) & `android-sync-engine.ts` (Mobile) để tự động xóa file trên Google Drive (`deleteRemoteFile`) ngay khi tất cả thiết bị đã tải xong, và tự động đẩy lại nếu có thiết bị mới yêu cầu (`NEED_UPLOAD`)
- [x] **Task 7.3**: Viết Unit/Integration Test kiểm chứng cơ chế tự xóa file trung gian trên Google Drive sau khi đồng bộ và cơ chế cấp lại file cho máy mới

## Giai đoạn 8: Tự Dọn Dòng `DELETED` Trong `list-file.md` & Xử Lý Thư Mục Có Sẵn Dữ Liệu
- [x] **Task 8.1**: Tự động xóa hẳn dòng `DELETED` khỏi `list-file.md` khi tất cả thiết bị (`knownDevices`) đã đồng bộ xóa xong, và vá `diffListFiles` không xóa nhầm file có sẵn khi `!baseHash`
- [x] **Task 8.2**: Nâng cấp `FolderService` & REST API phát hiện thư mục có sẵn dữ liệu (`existingFilesCount`) và hỗ trợ 3 chế độ xử lý (`MERGE_ALL`, `ISOLATE_BACKUP`, `CREATE_SUBFOLDER`)
- [x] **Task 8.3**: Cập nhật giao diện `FolderBrowserModal` hiển thị cảnh báo và 3 lựa chọn khi người dùng chọn thư mục đã có sẵn file
- [x] **Task 8.4**: Viết Unit/Integration Test kiểm chứng tự xóa dòng `DELETED` khỏi `list-file.md` và các chế độ bảo vệ thư mục có sẵn dữ liệu
- [x] **Task 8.5**: Nâng cấp `@foldersync/mobile-app` lên **Expo SDK 58 (`58.0.23`)** tương thích với ứng dụng Expo Go mới nhất trên Android
- [x] **Task 8.6**: Khắc phục lỗi `ExponentFileSystem.readAsStringAsync` khi gặp thư mục con trên Android SAF trong `android-sync-engine.ts` và `App.tsx`
- [x] **Task 8.7**: Bổ sung API `GET /api/auth/mobile-bridge` trên Desktop Agent (`server.ts`) để chuyển giao `refreshToken` vĩnh viễn và cấu hình Telegram sang điện thoại
- [x] **Task 8.8**: Nâng cấp `mobile-config.ts`, `android-sync-engine.ts` và `App.tsx` trên Android tự động gia hạn `refreshToken` độc lập trên 4G/5G, hỗ trợ liên kết 1-chạm và đăng nhập độc lập bằng mã xác thực Google OAuth2

## Giai đoạn 9: Cập Nhật Tài Liệu Kiến Trúc (Mermaid) & Chia Commit Nhánh `feature/phase-5`
- [x] **Task 9.1**: Xây dựng tài liệu kiến trúc hệ thống toàn diện `docs/system-architecture.md` (kèm các sơ đồ Mermaid chi tiết: tổng quan hệ thống, luồng Trạm trung chuyển tự hủy Ephemeral Relay, vòng đời xóa dòng `DELETED`, 3 chế độ bảo vệ thư mục có sẵn dữ liệu, và luồng xác thực 4G/5G)
- [x] **Task 9.2**: Cập nhật `README.md` gốc và `docs/phase-5-ui-web-and-mobile.md`, `docs/task.md` để phản ánh đầy đủ toàn bộ tính năng đến hết Giai đoạn 8
- [x] **Task 9.3**: Chia các thay đổi hiện tại trên nhánh `feature/phase-5` thành 5 commit rõ ràng, mạch lạc theo từng nhóm tính năng (bỏ qua file cấu hình IDE `.idea`)

## Giai đoạn 10 (Đề xuất): Kiến Trúc Nhiều Vùng Đồng Bộ Độc Lập (Multi-Zone Sync Network)
- [ ] **Task 10.1**: Mở rộng `@foldersync/shared` với kiểu dữ liệu `SyncZoneMetadata`, `ZonesRegistryDocument` (`zones-registry.json`) và `LocalZoneBinding`
- [ ] **Task 10.2**: Nâng cấp `Desktop Agent` (`ConfigService`, `GoogleDriveProvider`, `MultiZoneSyncManager`, REST API `/api/zones/*`) hỗ trợ tạo vùng mới, khám phá các vùng có sẵn trên Google Drive, tham gia (`Join Zone`) / rời vùng (`Leave Zone`) và chạy đồng bộ độc lập từng vùng
- [ ] **Task 10.3**: Nâng cấp `@foldersync/web-ui` và `@foldersync/mobile-app` cho phép xem danh sách các Vùng Sync trên mạng, bật/tắt tham gia từng vùng gắn với từng thư mục riêng trên máy, và tạo vùng đồng bộ mới
- [ ] **Task 10.4**: Viết Unit & Integration Tests kiểm chứng đồng bộ đa vùng độc lập (máy chỉ tải dữ liệu của vùng mình tham gia, và cơ chế tự hủy file trên Google Drive tính riêng theo danh sách thành viên của từng vùng)
