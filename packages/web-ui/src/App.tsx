import React, { useCallback, useEffect, useState } from 'react';
import {
  FolderSync,
  FolderOpen,
  RefreshCw,
  Laptop,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import type {
  ExistingDataStrategy,
  ListFileDocument,
  PublicAppConfig,
  SwitchFolderMode,
  SyncLogEntry,
  SyncStatusSnapshot,
} from '@foldersync/shared';
import { api, subscribeAgentEvents } from './services/api';
import { OnboardingView } from './components/OnboardingView';
import { FolderBrowserModal } from './components/FolderBrowserModal';
import { ListFileTable } from './components/ListFileTable';
import { IntegrationsPanel } from './components/IntegrationsPanelAdapter';
import { SyncActivityLog } from './components/SyncActivityLog';

export const App: React.FC = () => {
  const [config, setConfig] = useState<PublicAppConfig | null>(null);
  const [indexDoc, setIndexDoc] = useState<ListFileDocument | null>(null);
  const [indexMarkdown, setIndexMarkdown] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot | null>(null);
  const [logs, setLogs] = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [triggeringSync, setTriggeringSync] = useState(false);

  const refreshAll = useCallback(async () => {
    try {
      const [cfg, idx, status, logsRes] = await Promise.all([
        api.getConfig(),
        api.getIndex(),
        api.getSyncStatus(),
        api.getSyncLogs(),
      ]);
      setConfig(cfg);
      setIndexDoc(idx.document);
      setIndexMarkdown(idx.markdown);
      setSyncStatus(status);
      setLogs(logsRes.logs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const unsubscribe = subscribeAgentEvents((msg) => {
      if (msg.type === 'logAdded') {
        const entry = msg.payload as SyncLogEntry;
        setLogs((prev) => [entry, ...prev.slice(0, 149)]);
      } else if (
        msg.type === 'indexUpdated' ||
        msg.type === 'syncCompleted' ||
        msg.type === 'syncStarted' ||
        msg.type === 'syncError'
      ) {
        void refreshAll();
      }
    });

    const onWindowMessage = (event: MessageEvent) => {
      if (event.data && (event.data as { type?: string }).type === 'GOOGLE_AUTH_SUCCESS') {
        void refreshAll();
      }
    };
    window.addEventListener('message', onWindowMessage);

    return () => {
      unsubscribe();
      window.removeEventListener('message', onWindowMessage);
    };
  }, [refreshAll]);

  const handleManualSync = async () => {
    setTriggeringSync(true);
    try {
      await api.triggerSync();
      await refreshAll();
    } finally {
      setTriggeringSync(false);
    }
  };

  if (loading || !config) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400 text-sm">
        Đang kết nối tới FolderSync Agent...
      </div>
    );
  }

  if (config.isFirstRun) {
    return (
      <OnboardingView
        config={config}
        onCompleted={() => {
          void refreshAll();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-950/30 via-slate-950 to-slate-950">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="p-2.5 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 text-indigo-400">
              <FolderSync className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-lg font-bold text-white">FolderSync</h1>
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-200 border border-slate-700">
                  <Laptop className="w-3 h-3 text-indigo-400" />
                  {config.deviceName}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Đồng bộ đa thiết bị (Android · Linux · Windows) qua <code className="text-slate-300">list-file.md</code>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {syncStatus?.cloudReady ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/25">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Cloud Sẵn Sàng
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-amber-500/10 text-amber-300 border border-amber-500/25">
                <AlertCircle className="w-3.5 h-3.5" />
                Chưa kết nối Google
              </span>
            )}

            <button
              onClick={() => void handleManualSync()}
              disabled={triggeringSync || syncStatus?.isSyncing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white shadow-lg shadow-indigo-600/25 transition"
            >
              <RefreshCw
                className={`w-4 h-4 ${
                  triggeringSync || syncStatus?.isSyncing ? 'animate-spin' : ''
                }`}
              />
              {triggeringSync || syncStatus?.isSyncing ? 'Đang đồng bộ...' : 'Đồng bộ ngay'}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Current Sync Folder Card */}
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <div className="p-3 rounded-2xl bg-amber-500/15 text-amber-400 shrink-0">
              <FolderOpen className="w-6 h-6" />
            </div>
            <div className="min-w-0 space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Thư mục đồng bộ hiện tại trên máy
              </span>
              <div className="text-sm sm:text-base font-mono text-white break-all">
                {config.syncFolderPath}
              </div>
              <p className="text-xs text-slate-400">
                Lần đồng bộ gần nhất:{' '}
                <span className="text-slate-200">
                  {syncStatus?.lastSyncedAt
                    ? new Date(syncStatus.lastSyncedAt).toLocaleString('vi-VN')
                    : 'Chưa đồng bộ lên Cloud'}
                </span>
              </p>
            </div>
          </div>

          <button
            onClick={() => setFolderModalOpen(true)}
            className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-100 border border-slate-700 transition"
          >
            Đổi thư mục đồng bộ
          </button>
        </div>

        {/* Google Auth & Telegram Bot Integrations */}
        <IntegrationsPanel
          config={config}
          onConfigUpdated={(nextCfg) => {
            setConfig(nextCfg);
            void refreshAll();
          }}
        />

        {/* list-file.md Explorer */}
        <ListFileTable
          document={indexDoc}
          markdown={indexMarkdown}
          onRescan={async () => {
            const res = await api.rescanIndex();
            setIndexDoc(res.document);
            setIndexMarkdown(res.markdown);
          }}
        />

        {/* Real-time Sync Activity Log */}
        <SyncActivityLog logs={logs} />
      </main>

      <FolderBrowserModal
        isOpen={folderModalOpen}
        isSwitchingExisting={true}
        currentSyncPath={config.syncFolderPath}
        onClose={() => setFolderModalOpen(false)}
        onConfirm={async (
          newPath: string,
          mode: SwitchFolderMode,
          strategy: ExistingDataStrategy,
        ) => {
          const res = await api.switchFolder(newPath, mode, strategy);
          setConfig(res.config);
          await refreshAll();
        }}
      />
    </div>
  );
};
