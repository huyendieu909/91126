import { EventEmitter } from 'node:events';
import type { ConfigService } from './config-service.js';
import type { FileIndexer } from './file-indexer.js';

export interface TelegramSyncBatchItem {
  deviceName: string;
  revision: number;
  uploadedPaths: string[];
  deletedPaths: string[];
  conflictPaths: string[];
}

export interface TelegramRemoteTriggerEvent {
  revision: number;
  updatedBy: string;
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

  private pendingUploaded = new Set<string>();
  private pendingDeleted = new Set<string>();
  private pendingConflicts = new Set<string>();
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
    if (item.revision >= this.latestRevision) {
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
    const rev = this.latestRevision;
    const device = this.latestDeviceName;

    this.pendingUploaded.clear();
    this.pendingDeleted.clear();
    this.pendingConflicts.clear();

    if (uploaded.length === 0 && deleted.length === 0 && conflicts.length === 0) {
      return false;
    }

    const cfg = await this.configService.loadConfig();
    if (!cfg.telegramBot.enabled || !cfg.telegramBot.botToken || !cfg.telegramBot.chatId) {
      return false;
    }

    const formatPreview = (items: string[]) => {
      if (items.length === 0) return '0 file';
      const head = items.slice(0, 3).join(', ');
      const suffix = items.length > 3 ? ` (+${items.length - 3} file khác)` : '';
      return `${items.length} file (${head}${suffix})`;
    };

    const lines = [
      `🔄 [FolderSync Rev #${rev} | By: ${device}]`,
      `✅ Cập nhật/Thêm mới: ${formatPreview(uploaded)}`,
    ];

    if (deleted.length > 0) {
      lines.push(`🗑️ Đã xóa: ${formatPreview(deleted)}`);
    }
    if (conflicts.length > 0) {
      lines.push(`⚠️ Xung đột (đã tách bản sao an toàn): ${formatPreview(conflicts)}`);
    }
    lines.push(`📱 Các thiết bị khác có thể kiểm tra list-file.md để đồng bộ ngay!`);

    await this.sendRawMessage(
      cfg.telegramBot.botToken,
      cfg.telegramBot.chatId,
      lines.join('\n'),
    );
    return true;
  }

  public async sendTestMessage(botTokenOverride?: string, chatIdOverride?: string): Promise<void> {
    const cfg = await this.configService.loadConfig();
    const token = (botTokenOverride ?? cfg.telegramBot.botToken).trim();
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

  public async pollOnce(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const cfg = await this.configService.loadConfig();
      const { enabled, botToken, chatId, lastUpdateId } = cfg.telegramBot;
      if (!enabled || !botToken || !chatId) {
        return;
      }

      const offset = lastUpdateId > 0 ? lastUpdateId + 1 : 0;
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=0`;
      const res = await this.fetchFn(url);
      if (!res.ok) return;

      const data = (await res.json()) as {
        ok?: boolean;
        result?: Array<{
          update_id: number;
          message?: {
            chat?: { id: number | string };
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

        const msgChatId = String(upd.message?.chat?.id ?? '');
        const text = (upd.message?.text ?? '').trim();
        if (!text || (chatId && msgChatId !== String(chatId))) {
          continue;
        }

        await this.handleIncomingText(text, botToken, chatId, cfg.deviceName, cfg.syncFolderPath);
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
