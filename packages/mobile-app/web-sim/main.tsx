import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import MobileApp from '../App';

interface PickerRequest {
  label?: string;
  resolve: (chosen: string | null) => void;
}

const SimulatorShell: React.FC = () => {
  const [pickerReq, setPickerReq] = useState<PickerRequest | null>(null);
  const [folderInput, setFolderInput] = useState('/tmp/foldersync-android-sim');
  const [subDirs, setSubDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [parentDir, setParentDir] = useState<string | null>(null);

  const loadBrowse = async (targetPath: string) => {
    try {
      const res = await fetch(
        `/__mobile_dev_fs/browse?path=${encodeURIComponent(targetPath)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        currentPath: string;
        parentPath: string | null;
        directories: Array<{ name: string; path: string }>;
      };
      setFolderInput(data.currentPath);
      setParentDir(data.parentPath);
      setSubDirs(data.directories);
    } catch {
      // Ignore browse errors for non-existent path (mkdir will create it on confirm)
    }
  };

  useEffect(() => {
    (
      window as unknown as {
        __pickMobileSimFolder?: (label?: string) => Promise<string | null>;
      }
    ).__pickMobileSimFolder = (label?: string) => {
      const suffix = label
        ? `-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        : '';
      const suggested = `/tmp/foldersync-android-sim${suffix}`;
      setFolderInput(suggested);
      void loadBrowse('/tmp');
      return new Promise<string | null>((resolve) => {
        setPickerReq({ label, resolve });
      });
    };
  }, []);

  const handleResetApp = () => {
    window.localStorage.removeItem('foldersync_mobile_config_v1');
    window.location.reload();
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '18px 16px 32px',
        gap: 16,
      }}
    >
      {/* Top Dev Bar */}
      <div
        style={{
          width: '100%',
          maxWidth: 940,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 16px',
          borderRadius: 16,
          background: 'rgba(15, 23, 42, 0.85)',
          border: '1px solid rgba(99, 102, 241, 0.35)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              background: 'rgba(99, 102, 241, 0.2)',
              color: '#a5b4fc',
              border: '1px solid rgba(99, 102, 241, 0.4)',
            }}
          >
            📱 ANDROID DEV SIMULATOR
          </span>
          <span style={{ fontSize: 12, color: '#cbd5e1' }}>
            Chạy trực tiếp <code style={{ color: '#93c5fd' }}>packages/mobile-app/App.tsx</code> · Bấm{' '}
            <strong>F12</strong> để đặt Breakpoint &amp; soi Network
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <a
            href="http://localhost:8384"
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 12,
              color: '#93c5fd',
              textDecoration: 'none',
              padding: '6px 12px',
              borderRadius: 10,
              background: '#1e293b',
              border: '1px solid #334155',
            }}
          >
            💻 Mở PC Dashboard (:8384) ↗
          </a>
          <button
            type="button"
            onClick={handleResetApp}
            style={{
              fontSize: 12,
              color: '#fda4af',
              padding: '6px 12px',
              borderRadius: 10,
              background: 'rgba(244, 63, 94, 0.12)',
              border: '1px solid rgba(244, 63, 94, 0.3)',
              cursor: 'pointer',
            }}
          >
            🧹 Reset dữ liệu Mobile
          </button>
        </div>
      </div>

      {/* Simulated Android Phone Bezel (360px inner viewport) */}
      <div
        style={{
          width: 384,
          maxWidth: '100%',
          height: 800,
          borderRadius: 38,
          padding: 12,
          background: 'linear-gradient(145deg, #334155, #0f172a)',
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.65)',
          border: '1px solid rgba(148, 163, 184, 0.25)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Phone Top Speaker / Camera Notch */}
        <div
          style={{
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 4,
          }}
        >
          <div
            style={{
              width: 76,
              height: 6,
              borderRadius: 999,
              background: '#020617',
            }}
          />
        </div>

        {/* Phone Screen Viewport */}
        <div
          style={{
            position: 'relative',
            flex: 1,
            borderRadius: 28,
            overflow: 'hidden',
            background: '#020617',
            border: '1px solid #1e293b',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <MobileApp />
        </div>
      </div>

      {/* Simulated SAF Folder Picker Modal */}
      {pickerReq && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            background: 'rgba(2, 6, 23, 0.8)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 520,
              background: '#0f172a',
              borderRadius: 20,
              border: '1px solid #334155',
              padding: 22,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
            }}
          >
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc' }}>
                📂 Chọn thư mục trên máy Dev (Giả lập SAF Android)
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
                Thư mục này sẽ đóng vai bộ nhớ của điện thoại Android ngay trên ổ cứng máy Linux (nếu chưa có sẽ tự tạo mới).
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                style={{
                  flex: 1,
                  background: '#020617',
                  border: '1px solid #334155',
                  borderRadius: 10,
                  padding: '9px 12px',
                  color: '#f8fafc',
                  fontSize: 13,
                  fontFamily: 'monospace',
                }}
              />
              <button
                type="button"
                onClick={() => void loadBrowse(folderInput)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 10,
                  background: '#1e293b',
                  border: '1px solid #334155',
                  color: '#e2e8f0',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Duyệt
              </button>
            </div>

            {/* Quick Directory Browser */}
            <div
              style={{
                maxHeight: 200,
                overflowY: 'auto',
                borderRadius: 12,
                background: '#020617',
                border: '1px solid #1e293b',
                padding: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {parentDir && (
                <button
                  type="button"
                  onClick={() => void loadBrowse(parentDir)}
                  style={{
                    textAlign: 'left',
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: 'transparent',
                    border: 'none',
                    color: '#93c5fd',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  ⬆️ .. ({parentDir})
                </button>
              )}
              {subDirs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onClick={() => void loadBrowse(d.path)}
                  style={{
                    textAlign: 'left',
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: 'rgba(30, 41, 59, 0.5)',
                    border: 'none',
                    color: '#e2e8f0',
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                  }}
                >
                  📁 {d.name}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={() => {
                  pickerReq.resolve(null);
                  setPickerReq(null);
                }}
                style={{
                  padding: '9px 16px',
                  borderRadius: 12,
                  background: '#1e293b',
                  border: '1px solid #334155',
                  color: '#cbd5e1',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => {
                  pickerReq.resolve(folderInput.trim() || null);
                  setPickerReq(null);
                }}
                style={{
                  padding: '9px 18px',
                  borderRadius: 12,
                  background: '#4f46e5',
                  border: 'none',
                  color: '#ffffff',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                ✅ Dùng thư mục này
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')!).render(<SimulatorShell />);
