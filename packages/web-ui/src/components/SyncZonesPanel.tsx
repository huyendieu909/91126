import React, { useState } from 'react';
import {
  Globe,
  Plus,
  RefreshCw,
  FolderCheck,
  FolderPlus,
  LogOut,
  Users,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import type {
  ExistingDataStrategy,
  LocalZoneBinding,
  PublicAppConfig,
  SwitchFolderMode,
} from '@foldersync/shared';
import { api } from '../services/api';
import { FolderBrowserModal } from './FolderBrowserModal';

interface SyncZonesPanelProps {
  config: PublicAppConfig;
  onZonesUpdated: () => Promise<void> | void;
}

export const SyncZonesPanel: React.FC<SyncZonesPanelProps> = ({ config, onZonesUpdated }) => {
  const [discovering, setDiscovering] = useState(false);
  const [busyZoneId, setBusyZoneId] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [newZoneDesc, setNewZoneDesc] = useState('');
  const [folderPickerTarget, setFolderPickerTarget] = useState<
    | { type: 'CREATE'; zoneName: string; description?: string }
    | { type: 'JOIN'; zoneId: string; zoneName: string }
    | null
  >(null);

  const zones: LocalZoneBinding[] = config.zones ?? [];
  const activeZoneId = config.activeZoneId || 'default-zone';

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      await api.getZones();
      await onZonesUpdated();
    } finally {
      setDiscovering(false);
    }
  };

  const handleActivate = async (zoneId: string) => {
    setBusyZoneId(zoneId);
    try {
      await api.activateZone(zoneId);
      await onZonesUpdated();
    } finally {
      setBusyZoneId(null);
    }
  };

  const handleSyncZone = async (zoneId: string) => {
    setBusyZoneId(zoneId);
    try {
      await api.syncZone(zoneId);
      await onZonesUpdated();
    } finally {
      setBusyZoneId(null);
    }
  };

  const handleLeaveZone = async (zone: LocalZoneBinding) => {
    const ok = window.confirm(
      `Bạn có chắc muốn rời khỏi vùng "${zone.zoneName}"?\n(Các file trên ổ cứng máy này vẫn được giữ nguyên, nhưng máy sẽ ngừng đồng bộ vùng này và rút tên khỏi danh sách chờ tự hủy của vùng).`,
    );
    if (!ok) return;

    setBusyZoneId(zone.zoneId);
    try {
      await api.leaveZone(zone.zoneId);
      await onZonesUpdated();
    } finally {
      setBusyZoneId(null);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/15 text-indigo-400">
            <Globe className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">
              Mạng Lưới Vùng Đồng Bộ (Multi-Zone Sync)
            </h2>
            <p className="text-xs text-slate-400">
              Mỗi vùng là 1 thư mục đồng bộ độc lập. Máy nào tham gia vùng nào chỉ đồng bộ và tính chu trình tự hủy trong vùng đó.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => void handleDiscover()}
            disabled={discovering}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${discovering ? 'animate-spin' : ''}`} />
            {discovering ? 'Đang quét...' : 'Quét Vùng Từ Cloud'}
          </button>

          <button
            onClick={() => {
              setNewZoneName('');
              setNewZoneDesc('');
              setCreateModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white shadow-lg shadow-indigo-600/20 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            Tạo Vùng Sync Mới
          </button>
        </div>
      </div>

      {zones.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-xs text-slate-400">
          Chưa có vùng đồng bộ nào được đăng ký. Bấm <b>Quét Vùng Từ Cloud</b> hoặc <b>Tạo Vùng Sync Mới</b> để bắt đầu.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {zones.map((zone) => {
            const isActive = zone.zoneId === activeZoneId && zone.joined;
            const isBusy = busyZoneId === zone.zoneId;

            return (
              <div
                key={zone.zoneId}
                className={`rounded-xl border p-4 transition flex flex-col justify-between gap-3 ${
                  isActive
                    ? 'border-indigo-500/60 bg-indigo-950/25 shadow-lg shadow-indigo-950/30'
                    : zone.joined
                      ? 'border-emerald-500/30 bg-slate-950/60'
                      : 'border-slate-800 bg-slate-950/40'
                }`}
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white">{zone.zoneName}</span>
                        <span className="text-[11px] font-mono text-slate-400">
                          ({zone.zoneId})
                        </span>
                      </div>
                      {zone.description && (
                        <p className="text-xs text-slate-400 mt-0.5">{zone.description}</p>
                      )}
                    </div>

                    {isActive ? (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 shrink-0">
                        <Sparkles className="w-3 h-3" />
                        Đang hiển thị
                      </span>
                    ) : zone.joined ? (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">
                        <CheckCircle2 className="w-3 h-3" />
                        Đã tham gia
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-slate-800 text-slate-400 border border-slate-700 shrink-0">
                        Chưa tham gia
                      </span>
                    )}
                  </div>

                  {zone.joined && zone.localFolderPath && (
                    <div className="rounded-lg bg-slate-900/90 border border-slate-800 px-3 py-2 text-xs font-mono text-slate-200 break-all">
                      📂 {zone.localFolderPath}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 pt-1">
                    <span className="inline-flex items-center gap-1">
                      <Users className="w-3.5 h-3.5 text-indigo-400" />
                      Thành viên ({zone.memberDevices?.length || 0}):{' '}
                      <strong className="text-slate-200">
                        {zone.memberDevices && zone.memberDevices.length > 0
                          ? zone.memberDevices.join(', ')
                          : 'Chưa có'}
                      </strong>
                    </span>
                    {zone.joined && (
                      <span>Rev #{zone.lastSyncedRevision ?? 0}</span>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                  {zone.joined ? (
                    <>
                      {!isActive && (
                        <button
                          onClick={() => void handleActivate(zone.zoneId)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-semibold transition"
                        >
                          <FolderCheck className="w-3.5 h-3.5" />
                          Xem Vùng Này
                        </button>
                      )}

                      <button
                        onClick={() => void handleSyncZone(zone.zoneId)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                        Đồng bộ vùng
                      </button>

                      <button
                        onClick={() => void handleLeaveZone(zone)}
                        disabled={isBusy}
                        className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/25 text-xs font-medium transition"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Rời vùng
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() =>
                        setFolderPickerTarget({
                          type: 'JOIN',
                          zoneId: zone.zoneId,
                          zoneName: zone.zoneName,
                        })
                      }
                      disabled={isBusy}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      Tham gia vùng này (Chọn thư mục trên máy)
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Zone Modal */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-4 shadow-2xl">
            <h3 className="text-base font-bold text-white">➕ Tạo Vùng Đồng Bộ Mới</h3>
            <p className="text-xs text-slate-400">
              Tạo một vùng đồng bộ độc lập trên Google Drive. Các thiết bị khác sẽ nhìn thấy vùng này và có thể tự chọn tham gia.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Tên Vùng Đồng Bộ *
                </label>
                <input
                  type="text"
                  value={newZoneName}
                  onChange={(e) => setNewZoneName(e.target.value)}
                  placeholder="VD: Tài liệu Công việc, Ảnh Điện thoại..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Mô tả ngắn (tùy chọn)
                </label>
                <input
                  type="text"
                  value={newZoneDesc}
                  onChange={(e) => setNewZoneDesc(e.target.value)}
                  placeholder="VD: Chỉ đồng bộ giữa Laptop Linux và PC Windows"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setCreateModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300"
              >
                Hủy
              </button>
              <button
                disabled={!newZoneName.trim()}
                onClick={() => {
                  const name = newZoneName.trim();
                  const desc = newZoneDesc.trim() || undefined;
                  setCreateModalOpen(false);
                  setFolderPickerTarget({
                    type: 'CREATE',
                    zoneName: name,
                    description: desc,
                  });
                }}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white"
              >
                Tiếp tục: Chọn thư mục trên máy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Folder Picker for Creating or Joining a Zone */}
      <FolderBrowserModal
        isOpen={folderPickerTarget !== null}
        isSwitchingExisting={false}
        currentSyncPath={null}
        onClose={() => setFolderPickerTarget(null)}
        onConfirm={async (
          selectedPath: string,
          _mode: SwitchFolderMode,
          strategy: ExistingDataStrategy,
        ) => {
          if (!folderPickerTarget) return;
          if (folderPickerTarget.type === 'CREATE') {
            await api.createZone({
              zoneName: folderPickerTarget.zoneName,
              description: folderPickerTarget.description,
              localFolderPath: selectedPath,
              existingDataStrategy: strategy,
            });
          } else {
            await api.joinZone({
              zoneId: folderPickerTarget.zoneId,
              localFolderPath: selectedPath,
              existingDataStrategy: strategy,
            });
          }
          setFolderPickerTarget(null);
          await onZonesUpdated();
        }}
      />
    </div>
  );
};
