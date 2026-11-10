import React, { useEffect, useState } from 'react';
import {
  Folder,
  FolderPlus,
  HardDrive,
  ArrowUp,
  Check,
  X,
  Copy,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import type {
  DirectoryBrowseResult,
  ExistingDataStrategy,
  SwitchFolderMode,
} from '@foldersync/shared';
import { api } from '../services/api';

interface FolderBrowserModalProps {
  isOpen: boolean;
  isSwitchingExisting: boolean;
  currentSyncPath: string | null;
  onClose: () => void;
  onConfirm: (
    selectedPath: string,
    mode: SwitchFolderMode,
    existingDataStrategy: ExistingDataStrategy,
  ) => Promise<void>;
}

export const FolderBrowserModal: React.FC<FolderBrowserModalProps> = ({
  isOpen,
  isSwitchingExisting,
  currentSyncPath,
  onClose,
  onConfirm,
}) => {
  const [browseData, setBrowseData] = useState<DirectoryBrowseResult | null>(null);
  const [manualPath, setManualPath] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [mode, setMode] = useState<SwitchFolderMode>('POINT_ONLY');
  const [existingDataStrategy, setExistingDataStrategy] =
    useState<ExistingDataStrategy>('MERGE_ALL');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.browseDirectories(targetPath);
      setBrowseData(res);
      setManualPath(res.currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể đọc thư mục.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadDirectory(currentSyncPath || undefined);
    }
  }, [isOpen, currentSyncPath]);

  if (!isOpen) return null;

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !browseData) return;
    setError(null);
    try {
      const separator = browseData.currentPath.endsWith('\\') || browseData.currentPath === '/' ? '' : '/';
      const fullNewPath = `${browseData.currentPath}${separator}${newFolderName.trim()}`;
      const created = await api.createDirectory(fullNewPath);
      setNewFolderName('');
      setShowNewFolderInput(false);
      await loadDirectory(created.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể tạo thư mục mới.');
    }
  };

  const handleConfirm = async () => {
    if (!manualPath.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(manualPath.trim(), mode, existingDataStrategy);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi khi chọn thư mục.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-500/15 text-indigo-400">
              <Folder className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-100">
                {isSwitchingExisting ? 'Đổi Thư Mục Đồng Bộ' : 'Chọn Thư Mục Đồng Bộ'}
              </h3>
              <p className="text-xs text-slate-400">
                Chọn nơi lưu trữ và tự động cập nhật bảng chỉ mục list-file.md
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto">
          {/* Quick Roots */}
          {browseData && browseData.roots.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {browseData.roots.map((root) => (
                <button
                  key={root}
                  onClick={() => void loadDirectory(root)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                >
                  <HardDrive className="w-3.5 h-3.5 text-indigo-400" />
                  {root}
                </button>
              ))}
            </div>
          )}

          {/* Path Bar */}
          <div className="flex gap-2">
            <input
              type="text"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadDirectory(manualPath);
              }}
              placeholder="/home/user/FolderSync"
              className="flex-1 rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => void loadDirectory(manualPath)}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
            >
              Đi tới
            </button>
            <button
              onClick={() => setShowNewFolderInput((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 text-xs font-medium transition"
            >
              <FolderPlus className="w-4 h-4" />
              Tạo mới
            </button>
          </div>

          {/* Create New Subfolder Input */}
          {showNewFolderInput && (
            <div className="flex gap-2 p-3 rounded-xl bg-slate-950/70 border border-indigo-500/30">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateFolder();
                }}
                placeholder="Nhập tên thư mục mới..."
                className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => void handleCreateFolder()}
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition"
              >
                Tạo
              </button>
            </div>
          )}

          {/* Directory Listing */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 h-60 overflow-y-auto divide-y divide-slate-800/60">
            {browseData?.parentPath && (
              <button
                onClick={() => void loadDirectory(browseData.parentPath!)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-300 hover:bg-slate-800/60 transition"
              >
                <ArrowUp className="w-4 h-4 text-slate-400" />
                <span>.. (Thư mục cha)</span>
              </button>
            )}

            {loading ? (
              <div className="p-8 text-center text-sm text-slate-400">Đang tải danh sách thư mục...</div>
            ) : browseData?.directories.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Thư mục này chưa có thư mục con nào. Bạn có thể chọn luôn thư mục hiện tại.
              </div>
            ) : (
              browseData?.directories.map((dir) => (
                <button
                  key={dir.path}
                  onClick={() => void loadDirectory(dir.path)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-200 hover:bg-indigo-500/10 transition group"
                >
                  <Folder className="w-4 h-4 text-amber-400/90 group-hover:scale-110 transition-transform" />
                  <span className="truncate">{dir.name}</span>
                </button>
              ))
            )}
          </div>

          {/* Non-empty Target Folder Strategy Selector */}
          {(browseData?.existingFilesCount ?? 0) > 0 &&
            browseData?.currentPath !== currentSyncPath && (
              <div className="space-y-2.5 p-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                  <span>
                    Thư mục này đang có sẵn {browseData?.existingFilesCount} file dữ liệu. Bạn muốn xử lý thế nào?
                  </span>
                </div>

                <div className="space-y-2">
                  <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="radio"
                      name="existingStrategy"
                      checked={existingDataStrategy === 'MERGE_ALL'}
                      onChange={() => setExistingDataStrategy('MERGE_ALL')}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold">1. Hợp nhất 2 chiều (Merge):</span>{' '}
                      <span className="text-slate-400">
                        Giữ nguyên các file có sẵn và gộp chung vào nhóm đồng bộ (không xóa file cũ, nếu trùng tên khác nội dung sẽ tách file .conflict).
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="radio"
                      name="existingStrategy"
                      checked={existingDataStrategy === 'ISOLATE_BACKUP'}
                      onChange={() => setExistingDataStrategy('ISOLATE_BACKUP')}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold">
                        2. Cất riêng dữ liệu cũ (.unsynced_local_backup):
                      </span>{' '}
                      <span className="text-slate-400">
                        Di chuyển các file có sẵn vào thư mục con bảo lưu riêng để không đẩy nhầm lên các máy khác.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 text-xs text-slate-200 cursor-pointer">
                    <input
                      type="radio"
                      name="existingStrategy"
                      checked={existingDataStrategy === 'CREATE_SUBFOLDER'}
                      onChange={() => setExistingDataStrategy('CREATE_SUBFOLDER')}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold">
                        3. Tạo thư mục con mới (FolderSync) bên trong:
                      </span>{' '}
                      <span className="text-slate-400">
                        Tự tạo và trỏ vào thư mục con <code className="text-indigo-300">FolderSync</code> để tách biệt hoàn toàn với dữ liệu có sẵn.
                      </span>
                    </div>
                  </label>
                </div>
              </div>
            )}

          {/* 2 Options When Switching Existing Sync Folder */}
          {isSwitchingExisting && (
            <div className="space-y-2.5 pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Cách xử lý dữ liệu ở thư mục cũ:
              </p>
              <label
                className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
                  mode === 'POINT_ONLY'
                    ? 'border-indigo-500 bg-indigo-500/10'
                    : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name="switchMode"
                  checked={mode === 'POINT_ONLY'}
                  onChange={() => setMode('POINT_ONLY')}
                  className="mt-1 accent-indigo-500"
                />
                <div className="text-sm">
                  <div className="font-medium text-slate-100 flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
                    Chỉ trỏ sang thư mục mới và đồng bộ lại
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Giữ nguyên dữ liệu ở thư mục cũ không đụng tới. App sẽ kiểm tra list-file.md để đồng bộ với thư mục mới.
                  </p>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition ${
                  mode === 'COPY_EXISTING'
                    ? 'border-indigo-500 bg-indigo-500/10'
                    : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
                }`}
              >
                <input
                  type="radio"
                  name="switchMode"
                  checked={mode === 'COPY_EXISTING'}
                  onChange={() => setMode('COPY_EXISTING')}
                  className="mt-1 accent-indigo-500"
                />
                <div className="text-sm">
                  <div className="font-medium text-slate-100 flex items-center gap-1.5">
                    <Copy className="w-3.5 h-3.5 text-emerald-400" />
                    Tự động copy toàn bộ file từ thư mục cũ sang thư mục mới
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Chép sẵn toàn bộ dữ liệu hiện có sang đường dẫn mới để không phải tải lại qua mạng.
                  </p>
                </div>
              </label>
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-4 py-3 text-xs text-rose-300">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-800 px-6 py-4 bg-slate-950/40">
          <div className="text-xs text-slate-400 truncate max-w-[55%]">
            Đang chọn: <span className="text-slate-200 font-mono">{manualPath}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:bg-slate-800 transition"
            >
              Hủy
            </button>
            <button
              onClick={() => void handleConfirm()}
              disabled={submitting || !manualPath.trim()}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-lg shadow-indigo-600/20 transition"
            >
              <Check className="w-4 h-4" />
              {submitting ? 'Đang lưu...' : 'Xác nhận chọn thư mục này'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
