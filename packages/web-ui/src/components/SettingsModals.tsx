import React, { useEffect, useState } from 'react';
import {
  Cloud,
  Send,
  CheckCircle2,
  LogOut,
  Bell,
  Users,
  RefreshCw,
  KeyRound,
  ExternalLink,
  MessageSquare,
} from 'lucide-react';
import type {
  PublicAppConfig,
  TelegramChatCandidate,
  TelegramPairingSession,
} from '@foldersync/shared';
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

  // Telegram 1-Click Pairing & Auto-Discovery states
  const hasSavedToken = config.telegramBot.hasToken;
  const hasLinkedChat = Boolean(hasSavedToken && config.telegramBot.chatId);
  const isTeleConnected = Boolean(hasLinkedChat && config.telegramBot.enabled);

  const [showTokenInput, setShowTokenInput] = useState(!hasSavedToken);
  const [botToken, setBotToken] = useState('');
  const [pairingSession, setPairingSession] = useState<TelegramPairingSession | null>(null);
  const [chats, setChats] = useState<TelegramChatCandidate[]>([]);
  const [selectedChatId, setSelectedChatId] = useState('');
  const [loadingPair, setLoadingPair] = useState(false);
  const [scanningChats, setScanningChats] = useState(false);
  const [selectingChat, setSelectingChat] = useState(false);
  const [testingTele, setTestingTele] = useState(false);
  const [teleStatus, setTeleStatus] = useState<string | null>(null);

  useEffect(() => {
    if (hasSavedToken && !botToken) {
      setShowTokenInput(false);
    }
  }, [hasSavedToken, botToken]);

  useEffect(() => {
    if (isTeleConnected && pairingSession) {
      setPairingSession(null);
      setTeleStatus(
        `🎉 Đã tự động liên kết với "${config.telegramBot.chatTitle || config.telegramBot.chatId}"!`,
      );
    }
  }, [isTeleConnected, pairingSession, config.telegramBot.chatTitle, config.telegramBot.chatId]);

  // Poll /api/telegram/chats while waiting for user to click START in Telegram
  useEffect(() => {
    if (!pairingSession) return;

    const timer = window.setInterval(async () => {
      try {
        const res = await api.discoverTelegramChats(botToken.trim() || undefined);
        if (res.chats.length > 0) {
          setChats(res.chats);
        }
        if (res.paired || (res.config.telegramBot.enabled && res.config.telegramBot.chatId)) {
          setPairingSession(null);
          setBotToken('');
          setShowTokenInput(false);
          onConfigUpdated(res.config);
          setTeleStatus(
            `🎉 Đã tự động liên kết 1-Chạm với "${
              res.pairedChat?.title ||
              res.config.telegramBot.chatTitle ||
              res.config.telegramBot.chatId
            }"!`,
          );
        }
      } catch {
        // Ignore transient network errors while polling
      }
    }, 2500);

    return () => {
      window.clearInterval(timer);
    };
  }, [pairingSession, botToken, onConfigUpdated]);

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

  const handleStartPairing = async (target: 'private' | 'group') => {
    setLoadingPair(true);
    setTeleStatus(null);
    try {
      const res = await api.startTelegramPairing(botToken.trim() || undefined);
      setPairingSession(res.session);
      onConfigUpdated(res.config);
      const urlToOpen =
        target === 'group' ? res.session.groupInviteUrl : res.session.deepLinkUrl;
      window.open(urlToOpen, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setTeleStatus(
        err instanceof Error ? `❌ ${err.message}` : '❌ Không thể khởi tạo liên kết Telegram.',
      );
    } finally {
      setLoadingPair(false);
    }
  };

  const handleDiscoverChats = async () => {
    setScanningChats(true);
    setTeleStatus(null);
    try {
      const res = await api.discoverTelegramChats(botToken.trim() || undefined);
      setChats(res.chats);
      onConfigUpdated(res.config);
      if (res.paired && res.pairedChat) {
        setPairingSession(null);
        setBotToken('');
        setTeleStatus(`🎉 Đã tự động liên kết với "${res.pairedChat.title}"!`);
        return;
      }
      if (res.chats.length > 0) {
        setSelectedChatId((prev) => prev || res.chats[0].chatId);
        setTeleStatus(
          `✅ Tìm thấy ${res.chats.length} cuộc trò chuyện/nhóm gần đây. Hãy chọn bên dưới!`,
        );
      } else {
        setTeleStatus(
          'ℹ️ Chưa thấy cuộc trò chuyện mới. Hãy bấm "Liên kết Cá nhân 1-Chạm" và nhấn START trên Telegram!',
        );
      }
    } catch (err) {
      setTeleStatus(err instanceof Error ? `❌ ${err.message}` : '❌ Không thể quét danh sách chat.');
    } finally {
      setScanningChats(false);
    }
  };

  const handleSelectChat = async () => {
    if (!selectedChatId) return;
    setSelectingChat(true);
    setTeleStatus(null);
    try {
      const chosen = chats.find((c) => c.chatId === selectedChatId);
      const updated = await api.selectTelegramChat({
        chatId: selectedChatId,
        chatTitle: chosen?.title,
        botToken: botToken.trim() || undefined,
      });
      setBotToken('');
      setShowTokenInput(false);
      setPairingSession(null);
      onConfigUpdated(updated);
      setTeleStatus(
        `✅ Đã chọn "${chosen?.title || selectedChatId}" làm kênh nhận thông báo Telegram!`,
      );
    } catch (err) {
      setTeleStatus(err instanceof Error ? `❌ ${err.message}` : '❌ Không thể chọn cuộc trò chuyện.');
    } finally {
      setSelectingChat(false);
    }
  };

  const handleToggleTelegramEnabled = async (nextEnabled: boolean) => {
    setTeleStatus(null);
    try {
      const updated = await api.updateConfig({
        telegramBot: { enabled: nextEnabled },
      });
      onConfigUpdated(updated);
      setTeleStatus(
        nextEnabled
          ? '✅ Đã bật nhận thông báo đồng bộ qua Telegram!'
          : '⏸️ Đã tạm dừng gửi thông báo Telegram.',
      );
    } catch (err) {
      setTeleStatus(err instanceof Error ? `❌ ${err.message}` : '❌ Không thể cập nhật trạng thái.');
    }
  };

  const handleTelegramDisconnect = async () => {
    setTeleStatus(null);
    const updated = await api.disconnectTelegram();
    setPairingSession(null);
    onConfigUpdated(updated);
    setTeleStatus('ℹ️ Đã ngắt liên kết kênh thông báo Telegram.');
  };

  const handleTestTelegram = async () => {
    setTestingTele(true);
    setTeleStatus(null);
    try {
      await api.testTelegram(botToken.trim() || undefined);
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
              Trạm trung chuyển tự hủy <code className="text-slate-300">list-file.md</code> & đồng bộ ngầm 2 chiều
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
              Đăng nhập cùng 1 tài khoản Google trên các thiết bị để đồng bộ ngầm tự động mà không cần cấu hình mạng LAN hay IP.
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

      {/* Telegram 1-Click Pairing & Notification Card */}
      <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md p-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/15 text-indigo-400">
              <Bell className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Telegram Thông Báo 1-Chạm</h3>
              <p className="text-xs text-slate-400">
                Tự động nhận diện cuộc trò chuyện hoặc nhóm mà không cần gõ tay Chat ID
              </p>
            </div>
          </div>

          {hasLinkedChat && (
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                isTeleConnected
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
              }`}
            >
              {isTeleConnected ? 'Đang bật' : 'Đang tạm dừng'}
            </span>
          )}
        </div>

        {hasLinkedChat ? (
          <div className="space-y-3">
            <div
              className={`flex items-center justify-between gap-3 p-4 rounded-xl border ${
                isTeleConnected
                  ? 'bg-emerald-500/10 border-emerald-500/25'
                  : 'bg-amber-500/10 border-amber-500/25'
              }`}
            >
              <div className="space-y-0.5 min-w-0">
                <div
                  className={`flex items-center gap-1.5 text-sm font-medium truncate ${
                    isTeleConnected ? 'text-emerald-300' : 'text-amber-300'
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span className="truncate">
                    {config.telegramBot.chatTitle || `Chat ID: ${config.telegramBot.chatId}`}
                  </span>
                </div>
                <p className="text-xs text-slate-300 truncate">
                  {config.telegramBot.botUsername
                    ? `Bot: @${config.telegramBot.botUsername} · `
                    : ''}
                  ID: <code className="text-slate-200">{config.telegramBot.chatId}</code>
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => void handleToggleTelegramEnabled(!isTeleConnected)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                    isTeleConnected
                      ? 'bg-slate-800 hover:bg-amber-500/20 hover:text-amber-200 text-slate-200'
                      : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow'
                  }`}
                >
                  {isTeleConnected ? 'Tạm dừng' : 'Bật ngay'}
                </button>
                <button
                  onClick={() => void handleTelegramDisconnect()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-slate-800 hover:bg-rose-500/20 hover:text-rose-300 text-slate-300 transition"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Ngắt
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                onClick={() => void handleTestTelegram()}
                disabled={testingTele}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 border border-slate-700 transition"
              >
                <Send className="w-3.5 h-3.5 text-indigo-400" />
                {testingTele ? 'Đang gửi...' : 'Gửi tin nhắn Test'}
              </button>

              <button
                onClick={() => void handleDiscoverChats()}
                disabled={scanningChats}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-800/70 hover:bg-slate-800 text-xs font-medium text-slate-300 border border-slate-800 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${scanningChats ? 'animate-spin' : ''}`} />
                Đổi kênh / Nhóm khác
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3.5">
            {/* Bot Token status or optional input */}
            {hasSavedToken && !showTokenInput ? (
              <div className="flex items-center justify-between px-3.5 py-2 rounded-xl bg-slate-950/70 border border-slate-800 text-xs">
                <span className="inline-flex items-center gap-1.5 text-slate-300">
                  <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
                  Đã nạp sẵn Bot Token
                  {config.telegramBot.botUsername ? (
                    <strong className="text-indigo-300">@{config.telegramBot.botUsername}</strong>
                  ) : (
                    <span className="text-slate-400">(từ .env / cấu hình)</span>
                  )}
                </span>
                <button
                  onClick={() => setShowTokenInput(true)}
                  className="text-indigo-400 hover:text-indigo-300 font-medium"
                >
                  Đổi Bot khác
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300 font-medium">
                    Bot Token (hoặc đặt <code className="text-indigo-300">TELEGRAM_BOT_TOKEN</code> trong <code className="text-slate-300">.env</code>)
                  </span>
                  <div className="flex items-center gap-3">
                    <a
                      href="https://t.me/BotFather"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
                    >
                      Mở @BotFather
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    {hasSavedToken && (
                      <button
                        onClick={() => {
                          setBotToken('');
                          setShowTokenInput(false);
                        }}
                        className="text-slate-400 hover:text-slate-200"
                      >
                        Ẩn
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder="Dán Bot Token 1 lần (VD: 123456:ABC-DEF...) để liên kết tự động"
                  className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3.5 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}

            {/* 1-Click Pairing Buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                onClick={() => void handleStartPairing('private')}
                disabled={loadingPair}
                className="inline-flex items-center justify-center gap-2 py-2.5 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white shadow shadow-indigo-600/20 transition"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Liên kết Cá nhân 1-Chạm</span>
              </button>

              <button
                onClick={() => void handleStartPairing('group')}
                disabled={loadingPair}
                className="inline-flex items-center justify-center gap-2 py-2.5 px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-semibold text-slate-100 border border-slate-700 transition"
              >
                <Users className="w-3.5 h-3.5 text-indigo-400" />
                <span>Thêm Bot vào Nhóm</span>
              </button>
            </div>

            {/* Active Pairing Waiting Banner */}
            {pairingSession && (
              <div className="p-3.5 rounded-xl bg-indigo-500/10 border border-indigo-500/30 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-indigo-200">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400 shrink-0" />
                    <span>
                      Đang chờ bấm nút <strong>START</strong> trong Telegram (
                      <code className="text-indigo-300">@{pairingSession.botUsername}</code>)...
                    </span>
                  </div>
                  <button
                    onClick={() => setPairingSession(null)}
                    className="text-[11px] text-slate-400 hover:text-slate-200 shrink-0"
                  >
                    Hủy
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-300">
                  <a
                    href={pairingSession.deepLinkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-indigo-300 hover:underline"
                  >
                    Mở lại link Telegram ↗
                  </a>
                </div>
              </div>
            )}

            {/* Scan existing chats button */}
            <div className="flex items-center justify-between pt-0.5">
              <button
                onClick={() => void handleDiscoverChats()}
                disabled={scanningChats}
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-indigo-300 transition"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>
                  {scanningChats
                    ? 'Đang quét danh sách chat...'
                    : 'Hoặc quét & chọn từ cuộc trò chuyện có sẵn'}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Discovered Chats / Groups Dropdown Picker */}
        {chats.length > 0 && (
          <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
            <label className="block text-[11px] font-medium text-slate-400">
              Chọn cuộc trò chuyện / nhóm nhận thông báo:
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={selectedChatId}
                onChange={(e) => setSelectedChatId(e.target.value)}
                className="flex-1 rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
              >
                {chats.map((c) => (
                  <option key={c.chatId} value={c.chatId}>
                    {c.type === 'private' ? '👤' : '👥'} {c.title} (ID: {c.chatId})
                  </option>
                ))}
              </select>
              <button
                onClick={() => void handleSelectChat()}
                disabled={selectingChat || !selectedChatId}
                className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white transition shrink-0"
              >
                {selectingChat ? 'Đang lưu...' : 'Chọn kênh này'}
              </button>
            </div>
          </div>
        )}

        {teleStatus && <p className="text-xs text-slate-300">{teleStatus}</p>}
      </div>
    </div>
  );
};
