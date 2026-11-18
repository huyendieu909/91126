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
- [x] **Task 10.1**: Mở rộng `@foldersync/shared` với kiểu dữ liệu `SyncZoneMetadata`, `ZonesRegistryDocument` (`zones-registry.json`) và `LocalZoneBinding`
- [x] **Task 10.2**: Nâng cấp `Desktop Agent` (`ConfigService`, `GoogleDriveProvider`, `MultiZoneSyncManager`, REST API `/api/zones/*`) hỗ trợ tạo vùng mới, khám phá các vùng có sẵn trên Google Drive, tham gia (`Join Zone`) / rời vùng (`Leave Zone`) và chạy đồng bộ độc lập từng vùng
- [x] **Task 10.3**: Nâng cấp `@foldersync/web-ui` và `@foldersync/mobile-app` cho phép xem danh sách các Vùng Sync trên mạng, bật/tắt tham gia từng vùng gắn với từng thư mục riêng trên máy, và tạo vùng đồng bộ mới
- [x] **Task 10.4**: Viết Unit & Integration Tests kiểm chứng đồng bộ đa vùng độc lập (máy chỉ tải dữ liệu của vùng mình tham gia, và cơ chế tự hủy file trên Google Drive tính riêng theo danh sách thành viên của từng vùng)

## Giai đoạn 11: Đồng Bộ Ngầm 2 Chiều Thực Thụ Đa Vùng & Liên Kết Telegram 1-Chạm
- [x] **Task 11.1**: Nâng cấp `FolderWatcher` (canh `chokidar` đồng thời tất cả các thư mục thuộc các Vùng `joined: true`) và `SyncCoordinator` (thêm bộ kiểm tra ngầm định kỳ `startBackgroundSync` tự động kéo thay đổi mới từ `list-file.md` trên Drive mà không phụ thuộc Telegram)
- [x] **Task 11.2**: Nâng cấp `ConfigService`, `TelegramService`, REST API (`/api/telegram/*`) và `SettingsModals.tsx` tự nạp `TELEGRAM_BOT_TOKEN` từ `.env`, hỗ trợ **Liên kết Telegram 1-Chạm** qua Deep-Link (`t.me/<bot>?start=pair_xxxx`) và **Dropdown chọn Chat/Group tự động** không cần gõ tay `Chat ID`
- [x] **Task 11.3**: Viết Unit & Integration Tests kiểm chứng đồng bộ ngầm 2 chiều đa vùng và luồng ghép đôi Telegram 1-Chạm

## Giai đoạn 12: Vá Lỗi File Khóa Tạm & Môi Trường Debug Trực Tiếp Trên Máy Dev (Không Cần Expo Go / APK)
- [x] **Task 12.0**: Lọc bỏ file khóa tạm trình soạn thảo (`.~lock.*#`, `~$*`, `*.swp`, `.#*`, `*.tmp`) trong `FileIndexer`, xử lý êm `ENOENT` khi file tạm tự xóa giữa lúc upload và bọc `.catch()` an toàn cho các sự kiện ngầm trong `SyncCoordinator`
- [x] **Task 12.1**: Xây dựng lớp **Platform Storage & Crypto Adapter** (`platform-fs.ts`) cho `@foldersync/mobile-app` (tự động dùng SAF + `expo-crypto` trên Android thật, và dùng Browser `showDirectoryPicker` / `IndexedDB` + `localStorage` + `Web Crypto API` khi chạy trên trình duyệt máy dev)
- [x] **Task 12.2**: Thiết lập bộ chạy **Mobile Web Simulator** bằng Vite + `react-native-web` (`pnpm dev:mobile` chạy tại `http://localhost:8390`), hiển thị khung điện thoại trực quan trên trình duyệt, hỗ trợ Hot-Reload & `F12` DevTools
- [x] **Task 12.3**: Thêm script tiện ích `pnpm dev:node2` chạy thêm 1 Desktop Agent cô lập tại `http://localhost:8385` (tự động kế thừa sẵn khóa Google OAuth từ node chính để test đồng bộ đa thiết bị ngay trên 1 máy)
- [x] **Task 12.4**: Build kiểm chứng toàn bộ workspace, viết test cho bộ lọc file tạm `.~lock` và khởi chạy kiểm tra thực tế Mobile Simulator (`:8390`) + Desktop Agent (`:8384`)

## Giai đoạn 13: Tinh Chỉnh Bố Cục Giao Diện Mobile `App.tsx` (Safe Area & Flexbox)
- [x] **Task 13.1**: Sửa vùng đệm an toàn trên Android trong `App.tsx` (tự động cộng `StatusBar.currentHeight` cho `paddingTop` và thêm `paddingBottom` tránh đè lên đồng hồ/pin và thanh điều hướng 3 nút)
- [x] **Task 13.2**: Sửa bố cục Header (`flex: 1` chống tràn nút `⚙️ Cài đặt`) và tách cụm nút Vùng đồng bộ thành **2 hàng thoáng đẹp** (nút `Đồng bộ ngay` rộng 100%, 2 nút phụ chia đôi 50%–50%)
- [x] **Task 13.3**: Đồng bộ khung hiển thị của **Mobile Web Simulator (`:8390`)** (`main.tsx` & `rn-web-shim.tsx`) chuẩn theo bề ngang màn hình điện thoại Android (`360px`) và kiểm chứng build TypeScript

## Giai đoạn 14: Khắc Phục & Minh Bạch Hóa Thông Báo Đồng Bộ Telegram 2 Chiều
- [x] **Task 14.1**: Cập nhật `ConfigService` và `SettingsModals.tsx` — hiển thị rõ kênh Telegram đã lưu (`chatId` + `hasToken`), hỗ trợ bật/tạm dừng 1-chạm và tự động kích hoạt `enabled: true` trên cấu hình hiện tại khi đủ khóa
- [x] **Task 14.2**: Nâng cấp `TelegramService` và `SyncCoordinator` — gửi thông báo cho cả chiều **Đẩy lên (`uploaded`)** lẫn **Tải về (`downloaded`)** kèm tên Vùng đồng bộ, và ghi rõ kết quả/lỗi gửi Telegram vào bảng **Nhật ký hoạt động thời gian thực**
- [x] **Task 14.3**: Đồng bộ thông báo Telegram 2 chiều trên `android-sync-engine.ts`, viết Unit/Integration Test kiểm chứng và kiểm tra gửi tin nhắn thực tế về `chatId: 8384943180`

## Giai đoạn 15: Sửa Lỗi Hiển Thị Hộp Thoại Chọn Thư Mục & Tối Ưu Tốc Độ Duyệt Thư Mục
- [x] **Task 15.1**: Dùng `createPortal(..., document.body)` cho `FolderBrowserModal.tsx` và modal tạo vùng trong `SyncZonesPanel.tsx` để thoát khỏi `backdrop-blur-md` containing block
- [x] **Task 15.2**: Tối ưu `countExistingSyncableFiles` trong `FolderService` (bỏ qua thư mục ẩn/nặng và giới hạn độ sâu/số lượng khi duyệt `/api/fs/browse`), kiểm chứng build/test & khởi động lại daemon `:8384`

## Giai đoạn 16: Sửa Lỗi Ghi Đè Thư Mục Giữa Các Vùng & Tách Biệt Bảng Chỉ Mục Theo Vùng
- [x] **Task 16.1**: Sửa `FolderService.switchSyncFolder` (`skipConfigSave`) và `SyncCoordinator.createZone` / `joinZone` không ghi đè `localFolderPath` của vùng cũ + chặn trùng thư mục giữa các vùng + viết test kiểm chứng
- [x] **Task 16.2**: Hỗ trợ `GET /api/index?zoneId=...` ở `server.ts` và thêm bộ chọn/hiển thị Vùng tách biệt ngay trên `ListFileTable.tsx`
- [x] **Task 16.3**: Build/test toàn bộ workspace, khôi phục đường dẫn `default-zone` trên cấu hình máy hiện tại về `/home/quyhx/Downloads/linhtinh/test-sync-folder` và khởi động lại daemon `:8384`

## Giai đoạn 17: Đồng Bộ An Toàn Đa Vùng Trên Mobile App
- [x] **Task 17.1**: Chặn chọn trùng thư mục SAF giữa các vùng khác nhau trong `joinOrCreateAndroidZone` (`android-sync-engine.ts`) và hiển thị tên Vùng đang xem trên tiêu đề danh sách file (`App.tsx`) + kiểm chứng typecheck `mobile-app`

## Giai đoạn 18: Sửa Lỗi Race Condition Khi Chọn Thư Mục Vùng Mới Trên Android Thật
- [x] **Task 18.1**: Khóa `APP_FOREGROUND` sync trong lúc mở Android SAF Picker / thao tác vùng (`App.tsx`), chống ghi đè config cũ cuối `runAndroidSyncNow` (`android-sync-engine.ts`), và tự đồng bộ vùng mới sau khi tham gia/tạo xong + kiểm chứng `tsc --noEmit`

## Giai đoạn 19: Nâng Cấp Toàn Diện Giao Diện Mobile App (`App.tsx`)
- [x] **Task 19.1**: Thêm helper format đường dẫn SAF thân thiện (`formatDisplayFolderPath`), format dung lượng file (`formatBytes`), icon phân loại file (`getFileEmoji`) và kiểm tra tương thích `rn-web-shim.tsx`
- [x] **Task 19.2**: Thiết kế lại Header (Badge Cloud + Rev), thanh **Zone Pills cuộn ngang** đổi vùng 1-chạm, Banner trạng thái có màu, và **Danh sách File** (Search + Pull-to-Refresh + nút `✕` đóng Modal)
- [x] **Task 19.3**: Kiểm chứng `tsc --noEmit` cho `@foldersync/mobile-app` và kiểm tra hiển thị trên Mobile Web Simulator (`:8390`)

## Giai đoạn 20: Quản Lý & Mở File Trực Tiếp Trên Mobile App
- [x] **Task 20.1**: Bổ sung `renamePlatformFile`, `openPlatformFileExternal` và hỗ trợ đọc/mở file trên `platform-fs.ts` + `rn-web-shim.tsx` (`Image` component)
- [x] **Task 20.2**: Nâng cấp `App.tsx` với In-App File Viewer (xem ảnh, đọc & sửa/lưu file text/markdown), menu thao tác `⋮` / giữ lâu (Mở / Đổi tên / Xóa), nút `+ Tạo file` mới và chế độ duyệt thư mục con (Breadcrumb)
- [x] **Task 20.3**: Kiểm chứng `tsc --noEmit` cho `@foldersync/mobile-app` và kiểm tra toàn bộ workspace build/test

## Giai đoạn 21: Vá Triệt Để Lỗi Nháy ACK `syncedDevices` Trên PC & Mobile
- [x] **Task 21.1**: Cập nhật `shouldWriteRemote` trong `SyncCoordinator.performSyncCycle` (`sync-coordinator.ts`) và `runAndroidSyncNow` (`android-sync-engine.ts`) để luôn ghi ACK `syncedDevices` lên Drive khi có thiết bị vừa nhận/xóa xong (hoặc bản local đã có sẵn nhưng `SyncedDevices` trên Drive còn thiếu), đồng thời lưu `listFileDriveId` theo từng vùng
- [x] **Task 21.2**: Viết Integration Test mới trong `sync-coordinator.test.ts` mô phỏng vùng 3 thiết bị (2 máy đồng bộ trước, máy thứ 3 offline) kiểm chứng không còn lặp `pollRemoteChangesOnce` nháy mỗi 15s + build/test & restart daemon `:8384`

## Giai đoạn 22: Sửa Mở Video Android (`Media not found.`) & Nút Tải Lên Kiểu Messenger
- [x] **Task 22.1**: Cài `expo-intent-launcher` (`~58.0.3`), `expo-image-picker` (`~58.0.10`), `expo-document-picker` (`~58.0.5`) và bổ sung stub Web Simulator (`expo-stubs.ts` + `vite.mobile.config.ts`)
- [x] **Task 22.2**: Sửa `writePlatformFile` (dùng đúng MIME type) & `openPlatformFileExternal` (`FileSystem.getContentUriAsync` + `IntentLauncher` với `flags: 1` + MIME) trong `platform-fs.ts` + thêm helper chọn Ảnh / Video / Tài liệu kiểu Messenger
- [x] **Task 22.3**: Thêm nút `📤 Tải lên` cạnh `+ Tạo file` & bảng chọn kiểu Messenger (Ảnh / Video / Ảnh & Video / Tài liệu) trong `App.tsx`, tự copy vào thư mục sync + khóa `APP_FOREGROUND` + đồng bộ ngay, và kiểm chứng toàn bộ build/test & docs (`system-architecture.md`)

## Giai đoạn 23: Hoàn Thiện Các Điểm Sau Code Review & Chia Commit
- [x] **Task 23.1**: Đồng bộ `uriMap` sau `runAndroidSyncNow`, dọn sạch cache tạm `foldersync_open/`, thu hồi `blob:` URL trên Simulator, chặn `APP_FOREGROUND` khi mở trình xem ngoài và tự động sync sau khi Tạo / Sửa / Đổi tên / Xóa file trên Mobile
- [x] **Task 23.2**: Tối ưu `SyncCoordinator.performSyncCycle` chỉ đọc/ghi `zones-registry.json` trên Google Drive khi `memberDevices` hoặc `listFileDriveId` thực sự thay đổi
- [x] **Task 23.3**: Kiểm chứng `pnpm -r build && pnpm test` + Vite Mobile Simulator, khởi động lại daemon `:8384`, cập nhật docs và chia thành 3 commit chuẩn Conventional Commits

## Giai đoạn 24: Gom Tập Trung Hằng Số & Bộ Lọc File Bỏ Qua Vào `@foldersync/shared`
- [x] **Task 24.1**: Tạo `packages/shared/src/sync-ignore.ts` (export qua `index.ts`) chứa tập trung `SYNC_TMP_DIR_NAME`, `UNSYNCED_BACKUP_DIR_NAME`, `SYSTEM_IGNORED_NAMES`, `TRANSIENT_FILE_PREFIXES`, `TRANSIENT_FILE_SUFFIXES` cùng 3 helper (`isInternalSyncArtifactName`, `shouldIgnoreSyncEntryName`, `shouldIgnoreSyncRelativePath`), viết unit test `packages/shared/test/sync-ignore.test.ts` và build `@foldersync/shared`
- [x] **Task 24.2**: Refactor toàn bộ 5 file đang lặp (`folder-service.ts`, `file-indexer.ts`, `sync-coordinator.ts`, `platform-fs.ts`, `vite.mobile.config.ts`) sang dùng hằng số & helper từ `@foldersync/shared`
- [x] **Task 24.3**: Cập nhật docs (`docs/system-architecture.md`, `docs/task.md`), kiểm chứng `pnpm -r build && pnpm test` + Vite Mobile Simulator build, và tạo 1 commit gọn riêng cho phần refactor này
