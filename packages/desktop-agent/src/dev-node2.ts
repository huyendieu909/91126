import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_ZONE_ID, DEFAULT_ZONE_NAME } from '@foldersync/shared';
import { ConfigService } from './services/config-service.js';
import { startAgentServer } from './index.js';

async function bootstrapSecondDevNode(): Promise<void> {
  const port = Number(process.env.PORT || 8385);
  const nodeLabel = process.env.NODE_NAME || 'Dev-PC-2';
  const defaultSyncDir =
    process.env.NODE2_SYNC_DIR || path.join(os.tmpdir(), 'foldersync-pc-node2');
  const node2ConfigPath =
    process.env.FOLDERSYNC_CONFIG_PATH ||
    path.join(os.homedir(), '.config', 'foldersync-node2', 'config.json');

  await fs.mkdir(defaultSyncDir, { recursive: true });

  const primaryCfgSvc = new ConfigService(
    path.join(os.homedir(), '.config', 'foldersync', 'config.json'),
  );
  const node2CfgSvc = new ConfigService(node2ConfigPath);

  const primaryCfg = await primaryCfgSvc.loadConfig();
  const node2Cfg = await node2CfgSvc.loadConfig();

  // Inherit Google OAuth & Telegram tokens from primary PC node automatically if not yet connected
  const needsAuthSeed =
    !node2Cfg.googleAuth.refreshToken && Boolean(primaryCfg.googleAuth.refreshToken);
  const needsFolderSeed = !node2Cfg.syncFolderPath;

  if (needsAuthSeed || needsFolderSeed) {
    const syncPath = node2Cfg.syncFolderPath || defaultSyncDir;
    await node2CfgSvc.saveConfig({
      deviceName: node2Cfg.syncFolderPath ? node2Cfg.deviceName : nodeLabel,
      syncFolderPath: syncPath,
      activeZoneId: node2Cfg.activeZoneId || DEFAULT_ZONE_ID,
      zones:
        node2Cfg.zones && node2Cfg.zones.length > 0
          ? node2Cfg.zones
          : [
              {
                zoneId: DEFAULT_ZONE_ID,
                zoneName: DEFAULT_ZONE_NAME,
                joined: true,
                localFolderPath: syncPath,
                driveFolderId: primaryCfg.googleAuth.driveRootFolderId,
                listFileDriveId: null,
                lastSyncedRevision: 0,
                lastSyncedAt: null,
                memberDevices: [nodeLabel],
              },
            ],
      ...(needsAuthSeed
        ? {
            googleAuth: {
              clientId: primaryCfg.googleAuth.clientId,
              clientSecret: primaryCfg.googleAuth.clientSecret,
              email: primaryCfg.googleAuth.email,
              displayName: primaryCfg.googleAuth.displayName,
              accessToken: primaryCfg.googleAuth.accessToken,
              refreshToken: primaryCfg.googleAuth.refreshToken,
              expiryDate: primaryCfg.googleAuth.expiryDate,
              driveRootFolderId: primaryCfg.googleAuth.driveRootFolderId,
            },
            telegramBot: {
              ...primaryCfg.telegramBot,
            },
          }
        : {}),
    });
  }

  const finalCfg = await node2CfgSvc.loadConfig();
  console.log(
    `[FolderSync Dev Node #2] Device="${finalCfg.deviceName}" | SyncDir="${finalCfg.syncFolderPath}" | Config="${node2ConfigPath}"`,
  );

  startAgentServer({ port, customConfigPath: node2ConfigPath });
}

void bootstrapSecondDevNode();
