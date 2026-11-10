import React from 'react';
import { Activity, AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { SyncLogEntry } from '@foldersync/shared';

interface SyncActivityLogProps {
  logs: SyncLogEntry[];
}

export const SyncActivityLog: React.FC<SyncActivityLogProps> = ({ logs }) => {
  const renderIcon = (level: SyncLogEntry['level']) => {
    switch (level) {
      case 'SUCCESS':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />;
      case 'WARN':
        return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />;
      case 'ERROR':
        return <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />;
      default:
        return <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />;
    }
  };

  return (
    <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md overflow-hidden">
      <div className="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
        <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-400">
          <Activity className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">Nhật ký đồng bộ trực tiếp</h3>
          <p className="text-xs text-slate-400">
            Tự động cập nhật theo thời gian thực khi thư mục hoặc list-file.md có thay đổi
          </p>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto divide-y divide-slate-800/50">
        {logs.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500">
            Chưa có hoạt động đồng bộ nào được ghi nhận trong phiên này.
          </div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="flex items-start gap-3 px-6 py-3 text-xs hover:bg-slate-800/20">
              {renderIcon(log.level)}
              <div className="flex-1 min-w-0">
                <span className="text-slate-200">{log.message}</span>
              </div>
              <span className="text-slate-500 font-mono shrink-0">
                {new Date(log.timestamp).toLocaleTimeString('vi-VN')}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
