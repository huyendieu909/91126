# 🏗️ Kiến Trúc Hệ Thống FolderSync (Android · Linux · Windows)

> **Cập nhật đến**: Giai đoạn 8 (Expo SDK 58 · Trạm Trung Chuyển Tự Hủy · Bảo Vệ Thư Mục Có Sẵn Dữ Liệu · Xác Thực 4G/5G Độc Lập)

Tài liệu này mô tả chi tiết kiến trúc tổng thể, cấu trúc bảng chỉ mục **`list-file.md`**, các luồng hoạt động cốt lõi và sơ đồ **Mermaid** của hệ thống **FolderSync**.

---

## 1. Triết Lý Thiết Kế Cốt Lõi

1. **Google Drive chỉ là "Trạm Trung Chuyển Tự Hủy" (Ephemeral Relay) — KHÔNG phải kho lưu trữ đám mây cố định**:
   - Dữ liệu thực sự thuộc về ổ cứng của các thiết bị (**Linux**, **Windows**, **Android**).
   - Google Drive chỉ giữ cố định duy nhất file chỉ mục văn bản **`list-file.md`** (vài KB).
   - Các file vật lý khi được đẩy lên `.FolderSync_Workspace` chỉ nằm tạm trên Google Drive để các máy khác tải về. **Ngay khi tất cả thiết bị đã biết trong mạng (`knownDevices`, tối thiểu $\ge 2$ máy) đều đã tải xong (`syncedDevices`), hệ thống tự động gọi lệnh xóa vĩnh viễn file vật lý đó trên Google Drive (`deleteRemoteFile`) và trả `driveFileId` về `'-'`**.
2. **Tự phục hồi khi có thiết bị mới tham gia (`@NEED_UPLOAD`)**:
   - Nếu một thiết bị thứ 3 tham gia vào mạng sau khi file vật lý trên Google Drive đã bị tự hủy (`driveFileId === '-'`), thiết bị mới sẽ bật cờ `@NEED_UPLOAD` (`requestUpload: true`) trên dòng file đó trong `list-file.md` và bắn thông báo Telegram.
   - Bất kỳ thiết bị cũ nào đang giữ bản file gốc trên ổ cứng sẽ tự động đẩy tạm file đó lên lại Google Drive để máy mới tải về, rồi lại tự hủy tiếp ngay sau khi máy mới nhận xong!
3. **Tự động dọn sạch dòng `DELETED` (Tombstone Garbage Collection)**:
   - Khi 1 máy xóa file, dòng đó trong `list-file.md` chuyển sang trạng thái `DELETED` để báo cho các máy khác xóa theo.
   - Ngay khi tất cả thiết bị trong `knownDevices` ($\ge 2$ máy) đều đã xác nhận xóa xong trên ổ cứng của mình, **dòng `DELETED` đó sẽ bị xóa hẳn khỏi `list-file.md`**, giúp file chỉ mục luôn gọn sạch.

---

## 2. Sơ Đồ Kiến Trúc Tổng Quan Monorepo

```mermaid
flowchart TB
    subgraph Shared["📦 @foldersync/shared (TypeScript Core)"]
        Types["types.ts\n(ListFileDocument, FileIndexEntry,\nFolderSwitchMode, ExistingDataMode)"]
        Codec["list-file-codec.ts\n(parseListFile, serializeListFile, diffListFiles)"]
    end

    subgraph Desktop["💻 @foldersync/desktop-agent (Linux & Windows - Port 8384)"]
        Cfg["ConfigService\n(config.json + Auto-load .env)"]
        Fld["FolderService\n(POINT_ONLY / COPY_EXISTING +\nMERGE_ALL / ISOLATE_BACKUP / CREATE_SUBFOLDER)"]
        Idx["FileIndexer & FolderWatcher\n(Chokidar + SHA-256 + Anti-Loop Lock)"]
        Coord["SyncCoordinator\n(3-Way Diff + Ephemeral Relay Purge +\nDELETED Cleanup + .conflict Backup)"]
        GDrive["GoogleOAuthService & GoogleDriveProvider\n(OAuth2 Loopback + Mobile Bridge API)"]
        Tele["TelegramService\n(Long-polling /status, /list, /sync + Push Alert)"]
        Srv["Fastify Server + WebSocket (/ws)"]
    end

    subgraph WebUI["🌐 @foldersync/web-ui (React 18 + Vite + Tailwind)"]
        Onboard["OnboardingView & FolderBrowserModal"]
        Dash["Dashboard & ListFileTable (Markdown Viewer)"]
        Modals["SettingsModals & SyncActivityLog (Live WS)"]
    end

    subgraph Mobile["📱 @foldersync/mobile-app (Android - React Native / Expo SDK 58)"]
        MCfg["mobile-config.ts\n(AsyncStorage + 1-Tap PC Bridge +\n4G/5G Auto RefreshToken)"]
        MEngine["android-sync-engine.ts\n(SAF Recursive Scanner + SHA-256 +\nEphemeral Relay + Telegram Push)"]
        MUI["App.tsx\n(Native Tabs: Đồng bộ, list-file.md, Cài đặt)"]
    end

    subgraph Cloud["☁️ Hạ Tầng Trung Gian (Zero-Server)"]
        GD["Google Drive API v3\n(.FolderSync_Workspace / list-file.md)"]
        TG["Telegram Bot API\n(Thông báo đẩy & Kích hoạt đồng bộ)"]
    end

    Shared --> Desktop
    Shared --> WebUI
    Shared --> Mobile
    WebUI <-->|"REST API + WebSocket (8384)"| Srv
    Mobile -.->|"Liên kết 1-Chạm lần đầu (/api/auth/mobile-bridge)"| Srv
    GDrive <--> GD
    Tele <--> TG
    MEngine <-->|"Trực tiếp qua 4G/5G/Wi-Fi"| GD
    MEngine <-->|"Trực tiếp qua 4G/5G/Wi-Fi"| TG
```

---

## 3. Cấu Trúc Bảng Chỉ Mục `list-file.md`

File `list-file.md` được lưu cả ở thư mục đồng bộ cục bộ của mỗi máy lẫn trên thư mục `.FolderSync_Workspace` của Google Drive:

```markdown
# FolderSync Index (list-file.md)

- **Last Updated**: 2026-11-10T10:00:00.000Z
- **Updated By**: Linux-PC
- **Revision**: 12
- **Known Devices**: Linux-PC, Windows-PC, Android-Phone

| Relative Path | SHA-256 | Size (Bytes) | Modified At (ISO) | Status | Updated By | Drive File ID | Synced Devices |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- |
| `docs/spec.pdf` | `a1b2c3...` | 14200 | 2026-11-10T09:55:00.000Z | ACTIVE | Linux-PC | `-` | Linux-PC, Windows-PC, Android-Phone |
| `notes/todo.txt` | `f9e8d7...` | 512 | 2026-11-10T10:00:00.000Z | ACTIVE | Android-Phone | `1AbCdEfGhIjKlMnOp` | Android-Phone |
```

- **Khi `Drive File ID` là `1AbCdEfGhIjKlMnOp`**: File đang nằm tạm trên Google Drive vì mới chỉ có `Android-Phone` trong cột `Synced Devices`.
- **Khi `Drive File ID` là `'-'`**: Cả 3 thiết bị trong `Known Devices` đều đã tải xong (`Synced Devices: Linux-PC, Windows-PC, Android-Phone`), nên bản tạm trên Google Drive đã được **tự động xóa sạch**.
- **Khi cột `Synced Devices` có hậu tố `@NEED_UPLOAD`**: Một thiết bị mới vừa tham gia chưa có file này trên ổ cứng nên bật cờ yêu cầu một máy cũ đẩy tạm lại lên Google Drive.

---

## 4. Luồng Hoạt Động Chi Tiết (Mermaid Sequence Diagrams)

### 4.1. Luồng "Trạm Trung Chuyển Tự Hủy" (Ephemeral Relay) & Cấp Lại File (`@NEED_UPLOAD`)

```mermaid
sequenceDiagram
    autonumber
    participant A as 💻 Máy A (Linux)
    participant GD as ☁️ Google Drive (.FolderSync_Workspace)
    participant TG as 🤖 Telegram Bot
    participant B as 📱 Máy B (Android)
    participant C as 🖥️ Máy C (Windows - Vào sau)

    Note over A,B: Giai đoạn 1: Máy A thêm file mới -> Máy B tải về -> Tự hủy trên Drive
    A->>A: Phát hiện file mới "report.pdf" (băm SHA-256)
    A->>GD: Upload tạm "report.pdf" (driveFileId = "drv_123")
    A->>GD: Cập nhật list-file.md (Known: A, B | Synced: A)
    A->>TG: Bắn thông báo Rev mới
    TG-->>B: Thông báo có thay đổi
    B->>GD: Đọc list-file.md -> thấy thiếu "report.pdf"
    B->>GD: Tải "report.pdf" (drv_123) về bộ nhớ máy B
    B->>B: Kiểm tra: Synced (A, B) == Known (A, B) (>= 2 máy)
    B->>GD: DELETE file vật lý "drv_123" khỏi Google Drive!
    B->>GD: Cập nhật list-file.md (driveFileId = "-", Synced: A, B)

    Note over A,C: Giai đoạn 2: Máy C mới tham gia sau khi file trên Drive đã tự hủy
    C->>GD: Đọc list-file.md -> thấy "report.pdf" có driveFileId = "-"
    C->>GD: Ghi tên C vào Known (A, B, C) + bật cờ "@NEED_UPLOAD"
    C->>TG: Bắn thông báo yêu cầu cấp lại file
    TG-->>A: Kích hoạt đồng bộ trên Máy A
    A->>GD: Đọc list-file.md -> thấy "@NEED_UPLOAD" & Máy A đang có "report.pdf"
    A->>GD: Upload tạm lại "report.pdf" (driveFileId = "drv_999")
    A->>TG: Báo đã cấp lại file lên trạm trung chuyển
    C->>GD: Tải "report.pdf" (drv_999) về Máy C
    C->>GD: DELETE "drv_999" khỏi Google Drive (vì A, B, C đều đã đủ!)
    C->>GD: Cập nhật list-file.md (driveFileId = "-", Synced: A, B, C)
```

---

### 4.2. Luồng Xóa File & Tự Động Dọn Sạch Dòng `DELETED` Khỏi `list-file.md`

```mermaid
sequenceDiagram
    autonumber
    participant A as 💻 Máy A
    participant GD as ☁️ Google Drive (list-file.md)
    participant B as 📱 Máy B

    A->>A: Người dùng xóa file "old.txt" trên ổ cứng Máy A
    A->>GD: Nếu "old.txt" còn bản tạm trên Drive -> DELETE ngay
    A->>GD: Cập nhật dòng "old.txt" thành Status = DELETED (Synced: A)
    B->>GD: Đồng bộ: đọc list-file.md thấy "old.txt" là DELETED
    B->>B: Xóa "old.txt" khỏi bộ nhớ Máy B
    B->>B: Kiểm tra: Synced (A, B) == Known (A, B) (Tất cả máy đã xóa xong!)
    B->>GD: Xóa hẳn dòng "old.txt" khỏi bảng list-file.md
```

---

### 4.3. Ba Chế Độ Bảo Vệ Khi Chọn Thư Mục Đã Có Sẵn Dữ Liệu

Khi người dùng chọn một thư mục đồng bộ (lần đầu hoặc khi đổi thư mục) mà bên trong đã có sẵn các file cá nhân (`existingFilesCount > 0`), hệ thống hiển thị cảnh báo và cung cấp 3 chiến lược xử lý an toàn trong [`FolderService`](file:///home/quyhx/Downloads/tmp/91126/packages/desktop-agent/src/services/folder-service.ts):

```mermaid
flowchart LR
    Pick["📂 Người dùng chọn thư mục đích"] --> Check{"Thư mục đã có sẵn file?\n(existingFilesCount > 0)"}
    Check -- "Không (Thư mục trống)" --> Ready["✅ Khởi tạo list-file.md ngay"]
    Check -- "Có file sẵn" --> Modal["⚠️ Hiển thị 3 lựa chọn bảo vệ dữ liệu"]

    Modal --> M1["1️⃣ MERGE_ALL (Gộp chung)\nGiữ nguyên file có sẵn tại chỗ,\nquét SHA-256 và đồng bộ hai chiều\ncùng dữ liệu từ các máy khác"]
    Modal --> M2["2️⃣ ISOLATE_BACKUP (Cô lập an toàn)\nDi chuyển toàn bộ file có sẵn vào\n.unsynced_local_backup/<timestamp>\n(FolderWatcher tự động bỏ qua)"]
    Modal --> M3["3️⃣ CREATE_SUBFOLDER (Tách thư mục con)\nTự động tạo thư mục con trống\n.../FolderSync để đồng bộ riêng,\nkhông đụng chạm file bên ngoài"]
```

---

### 4.4. Luồng Xác Thực OAuth2 & Tự Gia Hạn `refreshToken` Độc Lập Trên 4G/5G (Android)

Để giải quyết triệt để lỗi `400: invalid_request` của Google OAuth đối với `exp://` trên Expo Go và đảm bảo điện thoại hoạt động độc lập 100% khi đi ra ngoài dùng mạng **4G/5G**:

```mermaid
sequenceDiagram
    autonumber
    participant Phone as 📱 Android App (Expo SDK 58)
    participant PC as 💻 Desktop Agent (Port 8384)
    participant Google as 🔐 Google OAuth2 Token Server

    alt Cách 1: Liên kết 1-Chạm với PC (Chỉ cần làm 1 lần duy nhất)
        Phone->>PC: GET /api/auth/mobile-bridge
        PC-->>Phone: Trả về clientId, clientSecret, refreshToken (vĩnh viễn) + Telegram Config
        Phone->>Phone: Lưu refreshToken vĩnh viễn vào AsyncStorage
    else Cách 2: Đăng nhập độc lập 100% trên 4G/5G (Không cần PC)
        Phone->>Google: Mở trình duyệt lấy Authorization Code
        Phone->>Google: POST /token (đổi Code lấy refreshToken + accessToken)
        Phone->>Phone: Lưu refreshToken vĩnh viễn vào AsyncStorage
    end

    Note over Phone,Google: Mọi lần đồng bộ về sau trên 4G/5G/Wi-Fi (Hoàn toàn độc lập, không cần PC)
    Phone->>Phone: getValidMobileAccessToken() kiểm tra hạn expiryDate
    opt Khi accessToken hết hạn (sau 1 giờ)
        Phone->>Google: POST https://oauth2.googleapis.com/token (grant_type=refresh_token)
        Google-->>Phone: Cấp accessToken mới + cập nhật expiryDate
    end
```

---

## 5. Danh Mục Các Package & File Quan Trọng

| Package | File chính | Vai trò |
| :--- | :--- | :--- |
| **`@foldersync/shared`** | [`packages/shared/src/types.ts`](file:///home/quyhx/Downloads/tmp/91126/packages/shared/src/types.ts) | Định nghĩa toàn bộ kiểu dữ liệu dùng chung (`ListFileDocument`, `FileIndexEntry`, `ExistingDataMode`, `FolderSwitchMode`). |
| **`@foldersync/shared`** | [`packages/shared/src/list-file-codec.ts`](file:///home/quyhx/Downloads/tmp/91126/packages/shared/src/list-file-codec.ts) | Bộ giải mã/mã hóa bảng Markdown `list-file.md` và thuật toán so khớp 3 chiều `diffListFiles`. |
| **`@foldersync/desktop-agent`** | [`packages/desktop-agent/src/services/config-service.ts`](file:///home/quyhx/Downloads/tmp/91126/packages/desktop-agent/src/services/config-service.ts) | Quản lý `config.json` trên PC và tự động nạp biến môi trường từ `.env`. |
| **`@foldersync/desktop-agent`** | [`packages/desktop-agent/src/services/folder-service.ts`](file:///home/quyhx/Downloads/tmp/91126/packages/desktop-agent/src/services/folder-service.ts) | Chọn/đổi thư mục đồng bộ (`POINT_ONLY` / `COPY_EXISTING`) và 3 chế độ bảo vệ thư mục có sẵn dữ liệu. |
| **`@foldersync/desktop-agent`** | [`packages/desktop-agent/src/services/sync-coordinator.ts`](file:///home/quyhx/Downloads/tmp/91126/packages/desktop-agent/src/services/sync-coordinator.ts) | Bộ điều phối đồng bộ trung tâm trên PC: tải/đẩy file, tự hủy file tạm trên Drive, tự xóa dòng `DELETED`. |
| **`@foldersync/desktop-agent`** | [`packages/desktop-agent/src/server.ts`](file:///home/quyhx/Downloads/tmp/91126/packages/desktop-agent/src/server.ts) | Fastify REST API + WebSocket `/ws` + `/api/auth/mobile-bridge` + phục vụ tĩnh Web UI tại cổng `8384`. |
| **`@foldersync/web-ui`** | [`packages/web-ui/src/App.tsx`](file:///home/quyhx/Downloads/tmp/91126/packages/web-ui/src/App.tsx) | Giao diện quản trị trên trình duyệt cho Linux & Windows. |
| **`@foldersync/mobile-app`** | [`packages/mobile-app/src/services/android-sync-engine.ts`](file:///home/quyhx/Downloads/tmp/91126/packages/mobile-app/src/services/android-sync-engine.ts) | Lõi đồng bộ trên Android sử dụng SAF (quét đệ quy thư mục con), `SHA-256` và cơ chế Trạm trung chuyển tự hủy. |
| **`@foldersync/mobile-app`** | [`packages/mobile-app/src/storage/mobile-config.ts`](file:///home/quyhx/Downloads/tmp/91126/packages/mobile-app/src/storage/mobile-config.ts) | Lưu trữ cấu hình Android, liên kết 1-chạm với PC và tự động làm mới `accessToken` trên 4G/5G. |
