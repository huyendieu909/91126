import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TelegramChatCandidate, TelegramPairingSession } from '@foldersync/shared';
import type { ConfigService } from './config-service.js';
import type { FileIndexer } from './file-indexer.js';

export interface TelegramSyncBatchItem {
  deviceName: string;
  revision: number;
  zoneName?: string;
  uploadedPaths: string[];
  deletedPaths: string[];
  conflictPaths: string[];
  downloadedPaths?: string[];
  deletedLocallyPaths?: string[];
}

export interface TelegramRemoteTriggerEvent {
  revision: number;
  updatedBy: string;
}

export interface TelegramNotificationSentEvent {
  chatId: string;
  revision: number;
  isOutboundPush: boolean;
}

export interface TelegramNotificationErrorEvent {
  chatId: string;
  error: string;
}

export interface TelegramServiceOptions {
  batchWindowMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class TelegramService extends EventEmitter {
  private batchTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private activePairCode: string | null = null;
  private readonly recentChats = new Map<string, TelegramChatCandidate>();

  private pendingUploaded = new Set<string>();
  private pendingDeleted = new Set<string>();
  private pendingConflicts = new Set<string>();
  private pendingDownloaded = new Set<string>();
  private pendingDeletedLocally = new Set<string>();
  private pendingZones = new Set<string>();
  private latestRevision = 0;
  private latestDeviceName = '';

  private readonly batchWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly configService: ConfigService,
    private readonly fileIndexer: FileIndexer,
    options: TelegramServiceOptions = {},
  ) {
    super();
    this.batchWindowMs = options.batchWindowMs ?? 2500;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.fetchFn = options.fetchImpl ?? fetch;
  }

  public start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public queueSyncNotification(item: TelegramSyncBatchItem): void {
    for (const p of item.uploadedPaths) this.pendingUploaded.add(p);
    for (const p of item.deletedPaths) this.pendingDeleted.add(p);
    for (const p of item.conflictPaths) this.pendingConflicts.add(p);
    for (const p of item.downloadedPaths ?? []) this.pendingDownloaded.add(p);
    for (const p of item.deletedLocallyPaths ?? []) this.pendingDeletedLocally.add(p);
    if (item.zoneName?.trim()) {
      this.pendingZones.add(item.zoneName.trim());
    }
    if (item.revision >= this.latestRevision || !this.latestDeviceName) {
      this.latestRevision = item.revision;
      this.latestDeviceName = item.deviceName;
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.flushNotification();
    }, this.batchWindowMs);
  }

  public async flushNotification(): Promise<boolean> {
    const uploaded = [...this.pendingUploaded];
    const deleted = [...this.pendingDeleted];
    const conflicts = [...this.pendingConflicts];
    const downloaded = [...this.pendingDownloaded];
    const deletedLocally = [...this.pendingDeletedLocally];
    const zones = [...this.pendingZones];
    const rev = this.latestRevision;
    const device = this.latestDeviceName;

    this.pendingUploaded.clear();
    this.pendingDeleted.clear();
    this.pendingConflicts.clear();
    this.pendingDownloaded.clear();
    this.pendingDeletedLocally.clear();
    this.pendingZones.clear();

    const hasOutbound = uploaded.length > 0 || deleted.length > 0 || conflicts.length > 0;
    const hasInbound = downloaded.length > 0 || deletedLocally.length > 0;

    if (!hasOutbound && !hasInbound) {
      return false;
    }

    const cfg = await this.configService.loadConfig();
    const token = this.resolveEffectiveToken(cfg.telegramBot.botToken);
    if (!cfg.telegramBot.enabled || !token || !cfg.telegramBot.chatId) {
      return false;
    }

    const formatPreview = (items: string[]) => {
      if (items.length === 0) return '0 file';
      const head = items.slice(0, 3).join(', ');
      const suffix = items.length > 3 ? ` (+${items.length - 3} file khác)` : '';
      return `${items.length} file (${head}${suffix})`;
    };

    const lines: string[] = [
      hasOutbound
        ? `🔄 [FolderSync Rev #${rev} | By: ${device}]`
        : `📥 [FolderSync Synced #${rev} | On: ${device}]`,
    ];

    if (zones.length > 0) {
      lines.push(`🌐 Vùng đồng bộ: ${zones.join(', ')}`);
    }
    if (uploaded.length > 0) {
      lines.push(`✅ Đã đẩy lên: ${formatPreview(uploaded)}`);
    }
    if (downloaded.length > 0) {
      lines.push(`📥 Đã tải về máy: ${formatPreview(downloaded)}`);
    }
    if (deleted.length > 0) {
      lines.push(`🗑️ Đã xóa: ${formatPreview(deleted)}`);
    }
    if (deletedLocally.length > 0) {
      lines.push(`🧹 Đã dọn file bị xóa từ xa: ${formatPreview(deletedLocally)}`);
    }
    if (conflicts.length > 0) {
      lines.push(`⚠️ Xung đột (đã tách bản sao an toàn): ${formatPreview(conflicts)}`);
    }
    if (hasOutbound) {
      lines.push(`📱 Các thiết bị khác có thể kiểm tra list-file.md để đồng bộ ngay!`);
    }

    try {
      await this.sendRawMessage(
        token,
        cfg.telegramBot.chatId,
        lines.join('\n'),
      );
      this.emit('notificationSent', {
        chatId: cfg.telegramBot.chatId,
        revision: rev,
        isOutboundPush: hasOutbound,
      } satisfies TelegramNotificationSentEvent);
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit('notificationError', {
        chatId: cfg.telegramBot.chatId,
        error: errorMsg,
      } satisfies TelegramNotificationErrorEvent);
      return false;
    }
  }

  public async sendTestMessage(botTokenOverride?: string, chatIdOverride?: string): Promise<void> {
    const cfg = await this.configService.loadConfig();
    const token = this.resolveEffectiveToken(cfg.telegramBot.botToken, botTokenOverride);
    const chatId = (chatIdOverride ?? cfg.telegramBot.chatId).trim();

    if (!token || !chatId) {
      throw new Error('Vui lòng nhập đầy đủ Telegram Bot Token và Chat ID.');
    }

    const msg = [
      `✅ [FolderSync] Kết nối Telegram Bot thành công!`,
      `💻 Thiết bị: ${cfg.deviceName}`,
      `📂 Thư mục đồng bộ: ${cfg.syncFolderPath ?? '(Chưa chọn)'}`,
    ].join('\n');

    await this.sendRawMessage(token, chatId, msg);
  }

  private resolveEffectiveToken(cfgToken: string, override?: string): string {
    return (override?.trim() || cfgToken.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || '');
  }

  public async getBotInfo(
    botTokenOverride?: string,
  ): Promise<{ username: string; firstName: string; token: string }> {
    const cfg = await this.configService.loadConfig();
    const token = this.resolveEffectiveToken(cfg.telegramBot.botToken, botTokenOverride);
    if (!token) {
      throw new Error(
        'Chưa có Telegram Bot Token (hãy thêm TELEGRAM_BOT_TOKEN vào .env hoặc dán Bot Token từ @BotFather).',
      );
    }

    const res = await this.fetchFn(`https://api.telegram.org/bot${token}/getMe`);
    if (!res.ok) {
      throw new Error(`Bot Token không hợp lệ: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      ok?: boolean;
      result?: { username?: string; first_name?: string };
    };
    const username = data.result?.username;
    if (!data.ok || !username) {
      throw new Error('Không lấy được username của Telegram Bot.');
    }

    await this.configService.saveConfig({
      telegramBot: {
        botToken: token,
        botUsername: username,
      },
    });

    return {
      username,
      firstName: data.result?.first_name || username,
      token,
    };
  }

  /**
   * Tạo phiên liên kết 1-Chạm (Deep-Link Pairing):
   * Trả về URL https://t.me/<BotUsername>?start=pair_xxxx để người dùng chỉ cần bấm START trên Telegram.
   */
  public async startPairingSession(botTokenOverride?: string): Promise<TelegramPairingSession> {
    const info = await this.getBotInfo(botTokenOverride);
    const pairCode = `pair_${crypto.randomBytes(4).toString('hex')}`;
    this.activePairCode = pairCode;

    return {
      pairCode,
      botUsername: info.username,
      deepLinkUrl: `https://t.me/${info.username}?start=${pairCode}`,
      groupInviteUrl: `https://t.me/${info.username}?startgroup=${pairCode}`,
    };
  }

  private extractChatCandidate(rawChat?: {
    id?: number | string;
    type?: string;
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  }): TelegramChatCandidate | null {
    if (!rawChat || rawChat.id === undefined || rawChat.id === null) return null;
    const chatId = String(rawChat.id);
    const fullName = [rawChat.first_name, rawChat.last_name].filter(Boolean).join(' ').trim();
    const baseTitle = rawChat.title || fullName || rawChat.username || `Chat ${chatId}`;
    const title =
      rawChat.username && !rawChat.title ? `${baseTitle} (@${rawChat.username})` : baseTitle;

    return {
      chatId,
      title,
      type: rawChat.type || 'private',
      username: rawChat.username,
    };
  }

  /**
   * Quét danh sách các cuộc trò chuyện / nhóm đã tương tác với Bot & kiểm tra xem người dùng đã bấm START ghép đôi chưa.
   */
  public async discoverRecentChats(botTokenOverride?: string): Promise<{
    paired: boolean;
    pairedChat?: TelegramChatCandidate;
    chats: TelegramChatCandidate[];
  }> {
    const cfg = await this.configService.loadConfig();
    const token = this.resolveEffectiveToken(cfg.telegramBot.botToken, botTokenOverride);
    if (!token) {
      return { paired: false, chats: [...this.recentChats.values()] };
    }

    const res = await this.fetchFn(`https://api.telegram.org/bot${token}/getUpdates?timeout=0`);
    if (!res.ok) {
      return { paired: false, chats: [...this.recentChats.values()] };
    }

    const data = (await res.json()) as {
      ok?: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          chat?: {
            id?: number | string;
            type?: string;
            title?: string;
            first_name?: string;
            last_name?: string;
            username?: string;
          };
          text?: string;
        };
        my_chat_member?: {
          chat?: {
            id?: number | string;
            type?: string;
            title?: string;
            username?: string;
          };
        };
      }>;
    };

    let pairedChat: TelegramChatCandidate | undefined;

    if (data.ok && Array.isArray(data.result)) {
      for (const upd of data.result) {
        const rawChat = upd.message?.chat ?? upd.my_chat_member?.chat;
        const candidate = this.extractChatCandidate(rawChat);
        if (candidate) {
          this.recentChats.set(candidate.chatId, candidate);
        }

        const text = (upd.message?.text ?? '').trim();
        if (
          candidate &&
          this.activePairCode &&
          (text.includes(this.activePairCode) || (!cfg.telegramBot.chatId && text.startsWith('/start')))
        ) {
          pairedChat = candidate;
          this.activePairCode = null;

          await this.configService.saveConfig({
            telegramBot: {
              enabled: true,
              botToken: token,
              chatId: candidate.chatId,
              chatTitle: candidate.title,
              lastUpdateId: Math.max(cfg.telegramBot.lastUpdateId, upd.update_id),
            },
          });

          await this.sendRawMessage(
            token,
            candidate.chatId,
            [
              `🎉 [FolderSync] Đã liên kết Telegram 1-Chạm thành công!`,
              `💻 Thiết bị: ${cfg.deviceName}`,
              `💬 Kênh nhận thông báo: ${candidate.title}`,
            ].join('\n'),
          ).catch(() => undefined);

          this.emit('telegramPaired', { chat: candidate });
        }
      }
    }

    return {
      paired: Boolean(pairedChat),
      pairedChat,
      chats: [...this.recentChats.values()],
    };
  }

  public async selectChat(
    chatId: string,
    chatTitle?: string,
    botTokenOverride?: string,
  ): Promise<void> {
    const info = await this.getBotInfo(botTokenOverride);
    const known = this.recentChats.get(chatId);
    const finalTitle = chatTitle || known?.title || chatId;

    await this.configService.saveConfig({
      telegramBot: {
        enabled: true,
        botToken: info.token,
        botUsername: info.username,
        chatId: chatId.trim(),
        chatTitle: finalTitle,
      },
    });
    this.activePairCode = null;

    const cfg = await this.configService.loadConfig();
    await this.sendRawMessage(
      info.token,
      chatId.trim(),
      `✅ [FolderSync] Đã chọn cuộc trò chuyện "${finalTitle}" làm kênh thông báo cho thiết bị "${cfg.deviceName}"!`,
    );
  }

  public async disconnect(): Promise<void> {
    this.activePairCode = null;
    await this.configService.saveConfig({
      telegramBot: {
        enabled: false,
        chatId: '',
        chatTitle: null,
      },
    });
  }

  public async pollOnce(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const cfg = await this.configService.loadConfig();
      const token = this.resolveEffectiveToken(cfg.telegramBot.botToken);
      const { enabled, chatId, lastUpdateId } = cfg.telegramBot;

      // If waiting for 1-click pairing, run discovery/auto-pair check even before enabled
      if (this.activePairCode && token) {
        await this.discoverRecentChats(token);
        return;
      }

      if (!enabled || !token || !chatId) {
        return;
      }

      const offset = lastUpdateId > 0 ? lastUpdateId + 1 : 0;
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=0`;
      const res = await this.fetchFn(url);
      if (!res.ok) return;

      const data = (await res.json()) as {
        ok?: boolean;
        result?: Array<{
          update_id: number;
          message?: {
            chat?: {
              id: number | string;
              type?: string;
              title?: string;
              first_name?: string;
              last_name?: string;
              username?: string;
            };
            text?: string;
          };
        }>;
      };

      if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
        return;
      }

      let maxUpdateId = lastUpdateId;

      for (const upd of data.result) {
        if (upd.update_id > maxUpdateId) {
          maxUpdateId = upd.update_id;
        }

        const candidate = this.extractChatCandidate(upd.message?.chat);
        if (candidate) {
          this.recentChats.set(candidate.chatId, candidate);
        }

        const msgChatId = String(upd.message?.chat?.id ?? '');
        const text = (upd.message?.text ?? '').trim();
        if (!text || (chatId && msgChatId !== String(chatId))) {
          continue;
        }

        await this.handleIncomingText(text, token, chatId, cfg.deviceName, cfg.syncFolderPath);
      }

      if (maxUpdateId > lastUpdateId) {
        await this.configService.saveConfig({
          telegramBot: { lastUpdateId: maxUpdateId },
        });
      }
    } catch {
      // Ignore transient network errors during background polling
    } finally {
      this.isPolling = false;
    }
  }

  private async handleIncomingText(
    text: string,
    botToken: string,
    chatId: string,
    localDeviceName: string,
    syncFolderPath: string | null,
  ): Promise<void> {
    // 1. Detect trigger header from another FolderSync device: [FolderSync Rev #15 | By: Other-PC]
    const match = text.match(/\[FolderSync Rev #(\d+)\s*\|\s*By:\s*([^\]]+)\]/);
    if (match) {
      const rev = Number.parseInt(match[1], 10);
      const senderDevice = match[2].trim();
      if (senderDevice !== localDeviceName && !Number.isNaN(rev)) {
        this.emit('remoteTrigger', {
          revision: rev,
          updatedBy: senderDevice,
        } satisfies TelegramRemoteTriggerEvent);
      }
      return;
    }

    // 2. Slash commands from user
    if (text.startsWith('/status')) {
      const cfg = await this.configService.loadConfig();
      const statusText = [
        `📊 [FolderSync Status - ${localDeviceName}]`,
        `📂 Thư mục: ${syncFolderPath ?? '(Chưa chọn)'}`,
        `🔢 Phiên bản đã đồng bộ: Rev #${cfg.lastSyncedRevision}`,
        `☁️ Google Auth: ${cfg.googleAuth.email ?? 'Chưa kết nối'}`,
      ].join('\n');
      await this.sendRawMessage(botToken, chatId, statusText);
      return;
    }

    if (text.startsWith('/list')) {
      if (!syncFolderPath) {
        await this.sendRawMessage(botToken, chatId, `⚠️ [${localDeviceName}] Chưa chọn thư mục đồng bộ.`);
        return;
      }
      const doc = await this.fileIndexer.readLocalListFile(syncFolderPath);
      const activeFiles = doc.entries.filter((e) => e.status === 'ACTIVE');
      const preview = activeFiles
        .slice(0, 15)
        .map((e) => `• ${e.relativePath} (${e.size} B)`)
        .join('\n');
      const msg = [
        `📋 [list-file.md trên ${localDeviceName} - Rev #${doc.revision}]`,
        `Tổng số file ACTIVE: ${activeFiles.length}`,
        preview || '(Trống)',
      ].join('\n');
      await this.sendRawMessage(botToken, chatId, msg);
      return;
    }

    if (text.startsWith('/sync')) {
      this.emit('remoteTrigger', {
        revision: Number.MAX_SAFE_INTEGER,
        updatedBy: 'Telegram-Command',
      } satisfies TelegramRemoteTriggerEvent);
      await this.sendRawMessage(
        botToken,
        chatId,
        `⏳ [${localDeviceName}] Đang kiểm tra list-file.md và đồng bộ ngay...`,
      );
    }
  }

  private async sendRawMessage(botToken: string, chatId: string, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gửi tin nhắn Telegram thất bại: ${errBody}`);
    }
  }
}
