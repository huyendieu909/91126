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
- [ ] Xây dựng `GoogleDriveService`: xác thực OAuth2 bằng tài khoản Google, tạo thư mục đồng bộ trên Drive, tải lên/tải xuống `list-file.md` và các file thay đổi theo `driveFileId`
- [ ] Xây dựng `SyncCoordinator`:
  - Khi máy cục bộ thay đổi: đẩy file mới/sửa lên Drive -> cập nhật `list-file.md` -> bắn tín hiệu qua Telegram Bot
  - Khi nhận tín hiệu từ Telegram Bot (hoặc kiểm tra định kỳ / bấm nút Sync): tải `list-file.md` về -> so sánh mã `SHA-256` -> chỉ tải về các file chưa đồng bộ qua file tạm `.sync_tmp`
- [ ] Xây dựng `TelegramService`: gửi thông báo khi cập nhật `list-file.md`, lắng nghe tín hiệu trigger giữa các máy và hỗ trợ lệnh `/status`, `/list`

## Giai đoạn 5: Giao diện người dùng (Web Dashboard cho PC & React Native App cho Android)
- [ ] Thiết kế giao diện Web Dashboard (React + Tailwind CSS) cho Linux/Windows và giao diện Native (React Native / Expo) cho Android
- [ ] Màn hình Onboarding lần đầu: nút **Đăng nhập bằng Google**, đặt tên thiết bị và chọn thư mục đồng bộ
- [ ] Màn hình Dashboard:
  - Thẻ tài khoản Google & Trạng thái đồng bộ
  - Thẻ thư mục hiện tại + Modal **Đổi thư mục đồng bộ** (2 tùy chọn chuyển dữ liệu)
  - Trình xem trực tiếp nội dung bảng chỉ mục `list-file.md` và trạng thái từng file
  - Cấu hình Telegram Bot & Nhật ký đồng bộ thời gian thực (Real-time Sync Log)

## Giai đoạn 6: Kiểm thử thực tế (Verification)
- [ ] Kiểm thử tự động bộ đọc/ghi `list-file.md`, phát hiện lệch mã hash, xóa file, xử lý xung đột `.conflict` và đổi thư mục đồng bộ
- [ ] Kiểm thử toàn diện luồng đồng bộ giữa 2 thiết bị và giao diện Web UI
