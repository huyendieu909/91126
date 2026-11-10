import React, { useState } from 'react';
import { FolderSync, FolderOpen, Laptop, CheckCircle2, ArrowRight } from 'lucide-react';
import type {
  ExistingDataStrategy,
  PublicAppConfig,
  SwitchFolderMode,
} from '@foldersync/shared';
import { FolderBrowserModal } from './FolderBrowserModal';
import { api } from '../services/api';

interface OnboardingViewProps {
  config: PublicAppConfig;
  onCompleted: (updatedConfig: PublicAppConfig) => void;
}

export const OnboardingView: React.FC<OnboardingViewProps> = ({ config, onCompleted }) => {
  const [deviceName, setDeviceName] = useState(config.deviceName);
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [existingStrategy, setExistingStrategy] = useState<ExistingDataStrategy>('MERGE_ALL');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFinishOnboarding = async () => {
    if (!selectedFolder.trim()) {
      setError('Vui lòng chọn một thư mục để làm nơi đồng bộ trước khi bắt đầu.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (deviceName.trim() && deviceName.trim() !== config.deviceName) {
        await api.updateConfig({ deviceName: deviceName.trim() });
      }
      const res = await api.switchFolder(
        selectedFolder.trim(),
        'POINT_ONLY',
        existingStrategy,
      );
      onCompleted(res.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể hoàn tất thiết lập.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-950/40 via-slate-950 to-slate-950">
      <div className="w-full max-w-xl rounded-3xl border border-slate-800/80 bg-slate-900/80 backdrop-blur-xl p-8 shadow-2xl space-y-7">
        {/* Hero */}
        <div className="flex items-center gap-4">
          <div className="p-3.5 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 text-indigo-400">
            <FolderSync className="w-8 h-8" />
          </div>
          <div>
            <span className="inline-block px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 mb-1">
              Thiết lập lần đầu
            </span>
            <h1 className="text-2xl font-bold text-white">Chào mừng tới FolderSync</h1>
            <p className="text-sm text-slate-400">
              Đồng bộ thư mục tự động giữa Android, Linux & Windows qua list-file.md
            </p>
          </div>
        </div>

        {/* Step 1: Device Name */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <Laptop className="w-4 h-4 text-indigo-400" />
            1. Đặt tên cho thiết bị này
          </label>
          <input
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Ví dụ: Linux-PC, Windows-Work..."
            className="w-full rounded-xl bg-slate-950 border border-slate-800 px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          />
          <p className="text-xs text-slate-500">
            Tên này sẽ xuất hiện trong bảng chỉ mục <code className="text-slate-300">list-file.md</code> và thông báo Telegram.
          </p>
        </div>

        {/* Step 2: Pick Sync Folder */}
        <div className="space-y-2.5">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <FolderOpen className="w-4 h-4 text-amber-400" />
            2. Chọn thư mục dùng để đồng bộ trên máy
          </label>

          <div className="flex items-center gap-3 p-4 rounded-2xl bg-slate-950/80 border border-slate-800">
            <div className="flex-1 min-w-0">
              {selectedFolder ? (
                <div className="flex items-center gap-2 text-sm text-emerald-300 font-mono truncate">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span className="truncate">{selectedFolder}</span>
                </div>
              ) : (
                <span className="text-sm text-slate-500">Chưa chọn thư mục nào...</span>
              )}
            </div>
            <button
              onClick={() => setPickerOpen(true)}
              className="shrink-0 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-100 border border-slate-700 transition"
            >
              {selectedFolder ? 'Chọn lại' : 'Duyệt chọn thư mục'}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Bạn có thể đổi sang đường dẫn thư mục khác bất kỳ lúc nào ngay trong màn hình chính sau này.
          </p>
        </div>

        {error && (
          <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-4 py-3 text-xs text-rose-300">
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={() => void handleFinishOnboarding()}
          disabled={saving || !selectedFolder}
          className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-sm font-semibold text-white shadow-xl shadow-indigo-600/25 transition"
        >
          <span>{saving ? 'Đang khởi tạo vùng đồng bộ...' : 'Bắt đầu đồng bộ ngay'}</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <FolderBrowserModal
        isOpen={pickerOpen}
        isSwitchingExisting={false}
        currentSyncPath={selectedFolder || null}
        onClose={() => setPickerOpen(false)}
        onConfirm={async (
          chosenPath: string,
          _mode: SwitchFolderMode,
          strategy: ExistingDataStrategy,
        ) => {
          setSelectedFolder(chosenPath);
          setExistingStrategy(strategy);
        }}
      />
    </div>
  );
};
