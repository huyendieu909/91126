import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ZONE_ID,
  DEFAULT_ZONE_NAME,
  type AppConfig,
  type LocalZoneBinding,
  type PublicAppConfig,
} from '@foldersync/shared';

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
      activeZoneId: DEFAULT_ZONE_ID,
      zones: [],
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
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        botUsername: null,
        chatId: '',
        chatTitle: null,
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

      const mergedBotToken = parsed.telegramBot?.botToken || defaults.telegramBot.botToken;
      const mergedChatId = (parsed.telegramBot?.chatId ?? '').trim();
      const autoEnableLegacyTele =
        Boolean(mergedBotToken && mergedChatId) &&
        !parsed.telegramBot?.enabled &&
        !parsed.telegramBot?.pausedByUser;

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
          botToken: mergedBotToken,
          enabled: autoEnableLegacyTele
            ? true
            : (parsed.telegramBot?.enabled ?? defaults.telegramBot.enabled),
        },
      };
      this.cachedConfig = this.normalizeZonesInConfig(this.cachedConfig);
      if (autoEnableLegacyTele) {
        await this.writeAtomically(this.cachedConfig);
      }
      return this.cachedConfig;
    } catch {
      const freshConfig = this.createDefaultConfig();
      await this.writeAtomically(freshConfig);
      this.cachedConfig = freshConfig;
      return freshConfig;
    }
  }

  private normalizeZonesInConfig(cfg: AppConfig): AppConfig {
    const zones = Array.isArray(cfg.zones) ? [...cfg.zones] : [];
    const activeZoneId = cfg.activeZoneId || DEFAULT_ZONE_ID;

    if (cfg.syncFolderPath && zones.length === 0) {
      zones.push({
        zoneId: DEFAULT_ZONE_ID,
        zoneName: DEFAULT_ZONE_NAME,
        joined: true,
        localFolderPath: cfg.syncFolderPath,
        driveFolderId: cfg.googleAuth.driveRootFolderId,
        listFileDriveId: cfg.googleAuth.listFileDriveId,
        lastSyncedRevision: cfg.lastSyncedRevision,
        lastSyncedAt: null,
        memberDevices: [cfg.deviceName],
      });
    }

    return {
      ...cfg,
      activeZoneId,
      zones,
    };
  }

  public async saveConfig(partial: {
    deviceName?: string;
    syncFolderPath?: string | null;
    lastSyncedRevision?: number;
    activeZoneId?: string | null;
    zones?: LocalZoneBinding[];
    googleAuth?: Partial<AppConfig['googleAuth']>;
    telegramBot?: Partial<AppConfig['telegramBot']>;
  }): Promise<AppConfig> {
    const current = await this.loadConfig();

    const nextDeviceName =
      partial.deviceName !== undefined ? partial.deviceName : current.deviceName;
    const nextSyncFolderPath =
      partial.syncFolderPath !== undefined ? partial.syncFolderPath : current.syncFolderPath;
    const nextRevision =
      partial.lastSyncedRevision !== undefined
        ? partial.lastSyncedRevision
        : current.lastSyncedRevision;
    const nextActiveZoneId =
      partial.activeZoneId !== undefined
        ? partial.activeZoneId
        : current.activeZoneId || DEFAULT_ZONE_ID;

    let nextZones =
      partial.zones !== undefined ? [...partial.zones] : [...(current.zones ?? [])];

    // Keep active zone synchronized when syncFolderPath or lastSyncedRevision is updated
    if (partial.zones === undefined && nextActiveZoneId) {
      const idx = nextZones.findIndex((z) => z.zoneId === nextActiveZoneId);
      if (idx >= 0) {
        nextZones[idx] = {
          ...nextZones[idx],
          localFolderPath:
            partial.syncFolderPath !== undefined
              ? partial.syncFolderPath
              : nextZones[idx].localFolderPath,
          joined:
            partial.syncFolderPath !== undefined
              ? Boolean(partial.syncFolderPath)
              : nextZones[idx].joined,
          lastSyncedRevision:
            partial.lastSyncedRevision !== undefined
              ? partial.lastSyncedRevision
              : nextZones[idx].lastSyncedRevision,
        };
      } else if (nextSyncFolderPath) {
        nextZones.push({
          zoneId: nextActiveZoneId,
          zoneName:
            nextActiveZoneId === DEFAULT_ZONE_ID ? DEFAULT_ZONE_NAME : nextActiveZoneId,
          joined: true,
          localFolderPath: nextSyncFolderPath,
          driveFolderId: current.googleAuth.driveRootFolderId,
          listFileDriveId: current.googleAuth.listFileDriveId,
          lastSyncedRevision: nextRevision,
          lastSyncedAt: null,
          memberDevices: [nextDeviceName],
        });
      }
    }

    const mergedTele: AppConfig['telegramBot'] = {
      ...current.telegramBot,
      ...(partial.telegramBot ?? {}),
    };
    if (partial.telegramBot?.enabled === false && mergedTele.chatId) {
      mergedTele.pausedByUser = true;
    } else if (partial.telegramBot?.enabled === true || !mergedTele.chatId) {
      mergedTele.pausedByUser = false;
    }

    const updated: AppConfig = {
      ...current,
      deviceName: nextDeviceName,
      syncFolderPath: nextSyncFolderPath,
      lastSyncedRevision: nextRevision,
      activeZoneId: nextActiveZoneId,
      zones: nextZones,
      googleAuth: {
        ...current.googleAuth,
        ...(partial.googleAuth ?? {}),
      },
      telegramBot: mergedTele,
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
      activeZoneId: cfg.activeZoneId || DEFAULT_ZONE_ID,
      zones: cfg.zones ?? [],
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
        hasToken: Boolean(
          (cfg.telegramBot.botToken && cfg.telegramBot.botToken.trim().length > 0) ||
            (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN.trim().length > 0),
        ),
        botUsername: cfg.telegramBot.botUsername ?? null,
        chatId: cfg.telegramBot.chatId,
        chatTitle: cfg.telegramBot.chatTitle ?? null,
      },
    };
  }

  private async writeAtomically(config: AppConfig): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.configPath);
  }
}
