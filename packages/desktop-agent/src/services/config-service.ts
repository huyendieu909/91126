import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AppConfig, PublicAppConfig } from '@foldersync/shared';

function loadWorkspaceEnv(): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../../.env'),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let value = line.slice(eqIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
      break;
    } catch {
      // Ignore env read errors
    }
  }
}

loadWorkspaceEnv();

export class ConfigService {
  private readonly configPath: string;
  private cachedConfig: AppConfig | null = null;

  constructor(customConfigPath?: string) {
    this.configPath =
      customConfigPath ||
      process.env.FOLDERSYNC_CONFIG_PATH ||
      path.join(os.homedir(), '.config', 'foldersync', 'config.json');
  }

  public getConfigFilePath(): string {
    return this.configPath;
  }

  private createDefaultConfig(): AppConfig {
    return {
      deviceId: crypto.randomUUID(),
      deviceName: os.hostname() || 'FolderSync-Device',
      syncFolderPath: null,
      lastSyncedRevision: 0,
      googleAuth: {
        clientId: process.env.GOOGLE_CLIENT_ID || null,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
        email: null,
        displayName: null,
        accessToken: null,
        refreshToken: null,
        expiryDate: null,
        driveRootFolderId: null,
        listFileDriveId: null,
      },
      telegramBot: {
        enabled: false,
        botToken: '',
        chatId: '',
        lastUpdateId: 0,
      },
    };
  }

  public async loadConfig(): Promise<AppConfig> {
    if (this.cachedConfig) {
      return this.cachedConfig;
    }

    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const defaults = this.createDefaultConfig();

      this.cachedConfig = {
        ...defaults,
        ...parsed,
        googleAuth: {
          ...defaults.googleAuth,
          ...(parsed.googleAuth ?? {}),
          clientId: parsed.googleAuth?.clientId || defaults.googleAuth.clientId,
          clientSecret: parsed.googleAuth?.clientSecret || defaults.googleAuth.clientSecret,
        },
        telegramBot: {
          ...defaults.telegramBot,
          ...(parsed.telegramBot ?? {}),
        },
      };
      return this.cachedConfig;
    } catch {
      const freshConfig = this.createDefaultConfig();
      await this.writeAtomically(freshConfig);
      this.cachedConfig = freshConfig;
      return freshConfig;
    }
  }

  public async saveConfig(partial: {
    deviceName?: string;
    syncFolderPath?: string | null;
    lastSyncedRevision?: number;
    googleAuth?: Partial<AppConfig['googleAuth']>;
    telegramBot?: Partial<AppConfig['telegramBot']>;
  }): Promise<AppConfig> {
    const current = await this.loadConfig();

    const updated: AppConfig = {
      ...current,
      deviceName: partial.deviceName !== undefined ? partial.deviceName : current.deviceName,
      syncFolderPath:
        partial.syncFolderPath !== undefined ? partial.syncFolderPath : current.syncFolderPath,
      lastSyncedRevision:
        partial.lastSyncedRevision !== undefined
          ? partial.lastSyncedRevision
          : current.lastSyncedRevision,
      googleAuth: {
        ...current.googleAuth,
        ...(partial.googleAuth ?? {}),
      },
      telegramBot: {
        ...current.telegramBot,
        ...(partial.telegramBot ?? {}),
      },
    };

    await this.writeAtomically(updated);
    this.cachedConfig = updated;
    return updated;
  }

  public async isConfigured(): Promise<boolean> {
    const cfg = await this.loadConfig();
    return Boolean(cfg.syncFolderPath && cfg.syncFolderPath.trim().length > 0);
  }

  public async getPublicConfig(): Promise<PublicAppConfig> {
    const cfg = await this.loadConfig();
    const isConfigured = Boolean(cfg.syncFolderPath && cfg.syncFolderPath.trim().length > 0);
    const effectiveClientId = cfg.googleAuth.clientId || process.env.GOOGLE_CLIENT_ID || null;
    const effectiveClientSecret =
      cfg.googleAuth.clientSecret || process.env.GOOGLE_CLIENT_SECRET || null;

    return {
      deviceId: cfg.deviceId,
      deviceName: cfg.deviceName,
      syncFolderPath: cfg.syncFolderPath,
      lastSyncedRevision: cfg.lastSyncedRevision,
      isFirstRun: !isConfigured,
      googleAuth: {
        isConnected: Boolean(cfg.googleAuth.accessToken || cfg.googleAuth.refreshToken),
        hasClientCredentials: Boolean(effectiveClientId && effectiveClientSecret),
        clientId: effectiveClientId,
        email: cfg.googleAuth.email,
        displayName: cfg.googleAuth.displayName,
        driveRootFolderId: cfg.googleAuth.driveRootFolderId,
      },
      telegramBot: {
        enabled: cfg.telegramBot.enabled,
        hasToken: Boolean(cfg.telegramBot.botToken && cfg.telegramBot.botToken.trim().length > 0),
        chatId: cfg.telegramBot.chatId,
      },
    };
  }

  private async writeAtomically(config: AppConfig): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.configPath);
  }
}
