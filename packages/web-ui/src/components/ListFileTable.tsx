import React, { useMemo, useState } from 'react';
import {
  FileText,
  Search,
  Code2,
  Table,
  Trash2,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import type { ListFileDocument } from '@foldersync/shared';

interface ListFileTableProps {
  document: ListFileDocument | null;
  markdown: string;
  onRescan: () => Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

export const ListFileTable: React.FC<ListFileTableProps> = ({
  document,
  markdown,
  onRescan,
}) => {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'DELETED'>('ALL');
  const [rawView, setRawView] = useState(false);
  const [scanning, setScanning] = useState(false);

  const filteredEntries = useMemo(() => {
    const list = document?.entries ?? [];
    return list.filter((entry) => {
      if (statusFilter !== 'ALL' && entry.status !== statusFilter) return false;
      if (query.trim() && !entry.relativePath.toLowerCase().includes(query.trim().toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [document, query, statusFilter]);

  const handleRescan = async () => {
    setScanning(true);
    try {
      await onRescan();
    } finally {
      setScanning(false);
    }
  };

  const activeCount = (document?.entries ?? []).filter((e) => e.status === 'ACTIVE').length;
  const deletedCount = (document?.entries ?? []).filter((e) => e.status === 'DELETED').length;

  return (
    <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-indigo-500/15 text-indigo-400">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base font-semibold text-white">Bảng chỉ mục list-file.md</h2>
              <span className="px-2 py-0.5 rounded-md text-xs font-mono bg-slate-800 text-indigo-300 border border-slate-700">
                Rev #{document?.revision ?? 0}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Đang hoạt động: <strong className="text-emerald-400">{activeCount}</strong> file · Đã xóa:{' '}
              <strong className="text-slate-300">{deletedCount}</strong> · Cập nhật cuối bởi:{' '}
              <span className="text-slate-200">{document?.updatedByDevice ?? '-'}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleRescan()}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            Quét lại ổ đĩa
          </button>
          <button
            onClick={() => setRawView((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            {rawView ? (
              <>
                <Table className="w-3.5 h-3.5 text-indigo-400" />
                Xem dạng Bảng
              </>
            ) : (
              <>
                <Code2 className="w-3.5 h-3.5 text-amber-400" />
                Xem Markdown gốc
              </>
            )}
          </button>
        </div>
      </div>

      {rawView ? (
        <pre className="p-5 text-xs font-mono text-slate-300 bg-slate-950/80 overflow-x-auto max-h-96">
          {markdown || '# Chưa có nội dung list-file.md'}
        </pre>
      ) : (
        <>
          {/* Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 bg-slate-950/30 border-b border-slate-800/60">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Tìm tên file hoặc đường dẫn..."
                className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex items-center gap-1.5 text-xs">
              {(['ALL', 'ACTIVE', 'DELETED'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setStatusFilter(tab)}
                  className={`px-3 py-1 rounded-lg font-medium transition ${
                    statusFilter === tab
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-800/60 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab === 'ALL' ? 'Tất cả' : tab === 'ACTIVE' ? 'Đang có (ACTIVE)' : 'Đã xóa (DELETED)'}
                </button>
              ))}
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800/80 text-[11px] uppercase tracking-wider text-slate-400 bg-slate-950/40">
                  <th className="py-3 px-6">Đường dẫn file</th>
                  <th className="py-3 px-4">Mã Hash (SHA-256)</th>
                  <th className="py-3 px-4 text-right">Dung lượng</th>
                  <th className="py-3 px-4">Trạng thái</th>
                  <th className="py-3 px-4">Thiết bị sửa cuối</th>
                  <th className="py-3 px-6 text-right">Thời gian sửa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50 text-xs">
                {filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-slate-500">
                      Chưa có file nào khớp với bộ lọc hiện tại. Hãy thử thêm file vào thư mục đồng bộ!
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map((entry) => {
                    const isConflictFile = entry.relativePath.includes('.conflict-');
                    return (
                      <tr
                        key={entry.relativePath}
                        className={`hover:bg-slate-800/30 transition ${
                          isConflictFile ? 'bg-amber-500/5' : ''
                        }`}
                      >
                        <td className="py-3 px-6 font-mono text-slate-100">
                          {entry.relativePath}
                          {isConflictFile && (
                            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              Bản sao xung đột
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-400">
                          {entry.sha256 === '-' ? '-' : `${entry.sha256.slice(0, 12)}...`}
                        </td>
                        <td className="py-3 px-4 text-right text-slate-300">
                          {entry.status === 'DELETED' ? '-' : formatBytes(entry.size)}
                        </td>
                        <td className="py-3 px-4">
                          {entry.status === 'ACTIVE' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                              <CheckCircle2 className="w-3 h-3" />
                              ACTIVE
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-500/10 text-rose-300 border border-rose-500/20">
                              <Trash2 className="w-3 h-3" />
                              DELETED
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-300">{entry.updatedBy}</td>
                        <td className="py-3 px-6 text-right text-slate-400">
                          {new Date(entry.modifiedAt).toLocaleString('vi-VN')}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
