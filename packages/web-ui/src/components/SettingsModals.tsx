import React, { useState } from 'react';
import { Cloud, Send, CheckCircle2, LogOut, Bell } from 'lucide-react';
import type { PublicAppConfig } from '@foldersync/shared';
import { api } from '../services/api';

interface IntegrationsPanelProps {
  config: PublicAppConfig;
  onConfigUpdated: (cfg: PublicAppConfig) => void;
}

export const IntegrationsPanel: React.FC<IntegrationsPanelProps> = ({
  config,
  onConfigUpdated,
}) => {
  const [googleMsg, setGoogleMsg] = useState<string | null>(null);

  // Telegram Bot form
  const [teleEnabled, setTeleEnabled] = useState(config.telegramBot.enabled);
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState(config.telegramBot.chatId);
  const [teleStatus, setTeleStatus] = useState<string | null>(null);
  const [testingTele, setTestingTele] = useState(false);

  const handleGoogleLogin = async () => {
    setGoogleMsg(null);
    try {
      const { url } = await api.getGoogleAuthUrl();
      window.open(url, 'foldersync_google_oauth', 'width=540,height=680');
    } catch (err) {
      setGoogleMsg(err instanceof Error ? err.message : 'Không thể tạo link đăng nhập Google.');
    }
  };

  const handleGoogleDisconnect = async () => {
    const updated = await api.disconnectGoogle();
    onConfigUpdated(updated);
  };

  const handleSaveTelegram = async () => {
    setTeleStatus(null);
    try {
      const updated = await api.updateConfig({
        telegramBot: {
          enabled: teleEnabled,
          chatId: chatId.trim(),
          ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
        },
      });
      onConfigUpdated(updated);
      setBotToken('');
      setTeleStatus('✅ Đã lưu cấu hình Telegram Bot.');
    } catch (err) {
      setTeleStatus(err instanceof Error ? err.message : 'Lỗi lưu cấu hình Telegram.');
    }
  };

  const handleTestTelegram = async () => {
    setTestingTele(true);
    setTeleStatus(null);
    try {
      await api.testTelegram(botToken.trim() || undefined, chatId.trim() || undefined);
      setTeleStatus('🎉 Đã gửi tin nhắn kiểm tra về Telegram thành công!');
    } catch (err) {
      setTeleStatus(err instanceof Error ? `❌ ${err.message}` : '❌ Lỗi gửi tin nhắn Telegram.');
    } finally {
      setTestingTele(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Google Auth & Drive Card */}
      <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-sky-500/15 text-sky-400">
            <Cloud className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Tài khoản Google & Drive</h3>
            <p className="text-xs text-slate-400">
              Lưu trữ trung gian <code className="text-slate-300">list-file.md</code> và truyền file tự động
            </p>
          </div>
        </div>

        {config.googleAuth.isConnected ? (
          <div className="flex items-center justify-between p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/25">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-300">
                <CheckCircle2 className="w-4 h-4" />
                {config.googleAuth.displayName || 'Đã kết nối Google Drive'}
              </div>
              <p className="text-xs text-slate-300">{config.googleAuth.email}</p>
            </div>
            <button
              onClick={() => void handleGoogleDisconnect()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-rose-500/20 hover:text-rose-300 text-slate-300 transition"
            >
              <LogOut className="w-3.5 h-3.5" />
              Ngắt kết nối
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              Đăng nhập cùng 1 tài khoản Google trên các thiết bị để đồng bộ mà không cần cấu hình mạng LAN hay IP.
            </p>
            <button
              onClick={() => void handleGoogleLogin()}
              className="w-full py-2.5 px-4 rounded-xl bg-white hover:bg-slate-100 text-slate-900 font-semibold text-sm shadow transition flex items-center justify-center gap-2"
            >
              <span>Đăng nhập bằng Google</span>
            </button>
          </div>
        )}

        {googleMsg && <p className="text-xs text-amber-300">{googleMsg}</p>}
      </div>

      {/* Telegram Notification & Trigger Card */}
      <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/15 text-indigo-400">
              <Bell className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Telegram Thông Báo & Trigger</h3>
              <p className="text-xs text-slate-400">
                Báo về điện thoại khi có cập nhật mới & tự kích hoạt các máy PC khác đồng bộ
              </p>
            </div>
          </div>

          <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-slate-300">
            <input
              type="checkbox"
              checked={teleEnabled}
              onChange={(e) => setTeleEnabled(e.target.checked)}
              className="accent-indigo-500 w-4 h-4"
            />
            Bật
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={
              config.telegramBot.hasToken
                ? '•••••••• (Đã lưu Bot Token)'
                : 'Nhập Telegram Bot Token...'
            }
            className="rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
          />
          <input
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="Nhập Chat ID (VD: 123456789)"
            className="rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => void handleSaveTelegram()}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition"
          >
            Lưu cấu hình Telegram
          </button>
          <button
            onClick={() => void handleTestTelegram()}
            disabled={testingTele}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 border border-slate-700 transition"
          >
            <Send className="w-3.5 h-3.5 text-indigo-400" />
            {testingTele ? 'Đang gửi...' : 'Gửi tin nhắn Test'}
          </button>
        </div>

        {teleStatus && <p className="text-xs text-slate-300">{teleStatus}</p>}
      </div>
    </div>
  );
};
