# Chi Tiết Giai Đoạn 3: Bộ Theo Dõi Thư Mục & Bộ Sinh File Chỉ Mục (`list-file.md`)

> **Trạng thái**: ⏳ Chờ ck duyệt để thực hiện
> **Mục tiêu giai đoạn**: Xây dựng bộ đọc/ghi file chỉ mục `list-file.md` chuẩn Markdown Table, bộ quét thư mục tính mã băm `SHA-256`, bộ theo dõi sự kiện thay đổi file theo thời gian thực (`FolderWatcher` + Debounce 400ms + Anti-Loop), và cơ chế xử lý xóa file (`DELETED`) cũng như xung đột phiên bản (`.conflict-<tên_máy>`).

---

## Danh Sách Công Việc Chi Tiết (Checklist Từng Bước Nhỏ)

### Task 3.1: Xây dựng Bộ đọc & Sinh file `list-file.md` (`ListFileCodec` trong `@foldersync/shared`)
- **Mục tiêu**: Chuyển đổi qua lại chính xác 100% giữa đối tượng `ListFileDocument` trong code và nội dung văn bản bảng Markdown của file `list-file.md`.
- **File sẽ tạo**:
  - `packages/shared/src/list-file-codec.ts`
  - `packages/shared/test/list-file-codec.test.ts`
- **Chi tiết kỹ thuật**:
  - Hàm `serializeListFile(doc: ListFileDocument): string`:
    - Xuất tiêu đề, thông tin `lastUpdatedAt`, `updatedByDevice`, `revision` và bảng Markdown gồm 7 cột: `Path`, `SHA-256`, `Bytes`, `ModifiedAt`, `Status`, `UpdatedBy`, `DriveFileId`.
    - Sắp xếp các dòng theo `relativePath` (A-Z) để file `list-file.md` luôn gọn gàng, dễ đối chiếu.
  - Hàm `parseListFile(markdown: string): ListFileDocument`:
    - Đọc ngược nội dung Markdown thành `ListFileDocument` (bỏ qua dòng tiêu đề bảng và dòng phân cách `| :--- |`).
  - Hàm `diffListFiles(localEntries, remoteDoc)`:
    - So sánh trạng thái file nội bộ với `list-file.md` tải về để trả ra:
      - Danh sách file cần tải về (`toDownload`)
      - Danh sách file cần đẩy lên (`toUpload`)
      - Danh sách file cần xóa nội bộ (`toDeleteLocally`)
      - Danh sách file bị xung đột cần tách bản `.conflict` (`conflicts`)
- **Checklist thực hiện**:
  - [ ] Viết `serializeListFile` và `parseListFile` trong `packages/shared/src/list-file-codec.ts`.
  - [ ] Viết hàm `diffListFiles` tính toán chính xác chênh lệch dựa trên `sha256`, `modifiedAt` và `status`.
  - [ ] Viết unit test `packages/shared/test/list-file-codec.test.ts` kiểm tra serialize/parse và diff.

---

### Task 3.2: Xây dựng `FileIndexer` (Quét thư mục, tính `SHA-256` & Cập nhật `list-file.md`)
- **Mục tiêu**: Quét thư mục đồng bộ trên máy, tính mã băm `SHA-256` cho các file và tự động ghi/cập nhật file `list-file.md` ngay trong vùng đồng bộ.
- **File sẽ tạo**:
  - `packages/desktop-agent/src/services/file-indexer.ts`
- **Chi tiết kỹ thuật**:
  - Tự động bỏ qua chính file `list-file.md`, thư mục tạm `.sync_tmp/`, và các file rác hệ điều hành (`.DS_Store`, `Thumbs.db`).
  - Tối ưu tốc độ quét: Nếu một file có `size` và `modifiedAt` không đổi so với bản ghi đang lưu trong `list-file.md`, tái sử dụng luôn mã `sha256` cũ mà không cần đọc lại toàn bộ file.
  - Khi phát hiện một file trước đó có trạng thái `ACTIVE` trong `list-file.md` nhưng nay không còn trên ổ đĩa -> tự động chuyển trạng thái dòng đó thành `status: 'DELETED'`, `sha256: '-'`, cập nhật `modifiedAt` và tăng `revision` của `list-file.md`.
- **Checklist thực hiện**:
  - [ ] Viết hàm băm `computeFileSha256(filePath)` theo dạng stream (không tốn RAM với file lớn).
  - [ ] Viết hàm `scanAndSyncLocalListFile()` để quét thư mục và cập nhật `list-file.md` nội bộ.
  - [ ] Hỗ trợ xử lý xung đột bằng hàm `createConflictBackup(filePath, deviceName)` đổi tên bản cũ thành `<tên_file>.conflict-<tên_máy>-<timestamp>.<ext>`.

---

### Task 3.3: Xây dựng `FolderWatcher` (`chokidar` + Debounce 400ms + Anti-Loop Lock)
- **Mục tiêu**: Theo dõi mọi thay đổi trong thư mục đồng bộ theo thời gian thực, tự động cập nhật `list-file.md` khi có file mới/sửa/xóa, và tự động chuyển vùng theo dõi khi người dùng bấm "Đổi thư mục đồng bộ".
- **File sẽ tạo**:
  - `packages/desktop-agent/src/services/folder-watcher.ts`
- **Chi tiết kỹ thuật**:
  - Dùng `chokidar` theo dõi `syncFolderPath` hiện tại.
  - **Cơ chế Debounce (400ms)**: Gom nhiều sự kiện liên tiếp thành 1 lần cập nhật `list-file.md` duy nhất sau khi ngừng ghi file 400ms.
  - **Cơ chế Anti-Loop (`withWriteLock(relativePath, fn)`)**:
    - Khi hệ thống đang tải file từ máy khác về ghi vào thư mục đồng bộ, đường dẫn đó được đưa vào `ignoredPaths` tạm thời để `FolderWatcher` không coi đó là thay đổi mới của người dùng (chống vòng lặp vô tận).
  - **Lắng nghe sự kiện `folderChanged` từ `FolderService`**:
    - Khi người dùng đổi thư mục đồng bộ, `FolderWatcher` tự động đóng watcher ở thư mục cũ, khởi tạo watcher ở thư mục mới và quét tạo `list-file.md` ngay lập tức.
- **Checklist thực hiện**:
  - [ ] Cài đặt `FolderWatcher` tích hợp `chokidar`, `Debounce` và `Anti-Loop`.
  - [ ] Kết nối tự động với sự kiện `folderChanged` của `FolderService`.
  - [ ] Bổ sung API `GET /api/index` vào `server.ts` để UI xem trực tiếp nội dung `list-file.md`.

---

### Task 3.4: Kiểm thử tự động toàn diện Giai đoạn 3
- **Mục tiêu**: Đảm bảo mọi thay đổi trong thư mục đều tự động cập nhật `list-file.md` chính xác (Thêm, Sửa, Xóa, Đổi thư mục, Chống lặp Anti-Loop, Tạo bản sao `.conflict`).
- **File sẽ tạo**:
  - `packages/desktop-agent/test/watcher-and-indexer.test.ts`
- **Checklist thực hiện**:
  - [ ] Test thêm/sửa/xóa file trong thư mục -> kiểm tra `list-file.md` tự động cập nhật đúng mã `SHA-256` và trạng thái `ACTIVE` / `DELETED`.
  - [ ] Test cơ chế `Anti-Loop` (ghi file qua `withWriteLock` không làm tăng `revision` ngoài ý muốn).
  - [ ] Test đổi thư mục đồng bộ khi Watcher đang chạy -> Watcher tự chuyển sang thư mục mới và cập nhật `list-file.md`.
  - [ ] Chạy `pnpm test` xanh 100% trên cả 2 gói và commit/push lên GitHub.
