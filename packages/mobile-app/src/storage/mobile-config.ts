import {
  DEFAULT_ZONE_ID,
  DEFAULT_ZONE_NAME,
  type LocalZoneBinding,
} from '@foldersync/shared';
import {
  getDefaultDesktopBridgeUrl,
  getDefaultMobileDeviceName,
  readRawMobileConfigJson,
  writeRawMobileConfigJson,
} from './platform-fs';

export interface MobileAppState {
  deviceId: string;
  deviceName: string;
  /** Android SAF Directory URI (null on first launch) */
  syncDirectoryUri: string | null;
  lastSyncedRevision: number;
  lastSyncedAt: string | null;
  baselineHashes: Record<string, string>;
  activeZoneId: string;
  zones: LocalZoneBinding[];
  zoneBaselines: Record<string, Record<string, string>>;
  desktopBridgeUrl: string;
  googleAuth: {
    clientId: string;
    clientSecret: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiryDate: number | null;
    email: string | null;
    driveRootFolderId: string | null;
    listFileDriveId: string | null;
  };
  telegramBot: {
    enabled: boolean;
    pausedByUser?: boolean;
    botToken: string;
    chatId: string;
  };
}

const DEFAULT_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '';
const DEFAULT_CLIENT_SECRET = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_SECRET ?? '';
const DEFAULT_REDIRECT_URI = 'http://localhost:8384/api/auth/google/callback';

function createDefaultState(): MobileAppState {
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return {
    deviceId: `android-${Date.now()}-${randomSuffix}`,
    deviceName: getDefaultMobileDeviceName(),
    syncDirectoryUri: null,
    lastSyncedRevision: 0,
    lastSyncedAt: null,
    baselineHashes: {},
    activeZoneId: DEFAULT_ZONE_ID,
    zones: [],
    zoneBaselines: {},
    desktopBridgeUrl: getDefaultDesktopBridgeUrl(),
    googleAuth: {
      clientId: DEFAULT_CLIENT_ID,
      clientSecret: DEFAULT_CLIENT_SECRET,
      accessToken: null,
      refreshToken: null,
      expiryDate: null,
      email: null,
      driveRootFolderId: null,
      listFileDriveId: null,
    },
    telegramBot: {
      enabled: false,
      botToken: '',
      chatId: '',
    },
  };
}

export async function loadMobileConfig(): Promise<MobileAppState> {
  try {
    const raw = await readRawMobileConfigJson();
    if (!raw) {
      const fresh = createDefaultState();
      await saveMobileConfig(fresh);
      return fresh;
    }
    const parsed = JSON.parse(raw) as Partial<MobileAppState>;
    const defaults = createDefaultState();
    const merged: MobileAppState = {
      ...defaults,
      ...parsed,
      activeZoneId: parsed.activeZoneId || DEFAULT_ZONE_ID,
      zones: Array.isArray(parsed.zones) ? parsed.zones : [],
      zoneBaselines: parsed.zoneBaselines ?? {},
      desktopBridgeUrl: parsed.desktopBridgeUrl || defaults.desktopBridgeUrl,
      googleAuth: {
        ...defaults.googleAuth,
        ...(parsed.googleAuth ?? {}),
        clientId: parsed.googleAuth?.clientId || defaults.googleAuth.clientId,
        clientSecret: parsed.googleAuth?.clientSecret || defaults.googleAuth.clientSecret,
      },
      telegramBot: { ...defaults.telegramBot, ...(parsed.telegramBot ?? {}) },
    };
    if (
      merged.telegramBot.botToken &&
      merged.telegramBot.chatId &&
      !merged.telegramBot.enabled &&
      !merged.telegramBot.pausedByUser
    ) {
      merged.telegramBot.enabled = true;
    }
    if (merged.syncDirectoryUri && merged.zones.length === 0) {
      merged.zones.push({
        zoneId: DEFAULT_ZONE_ID,
        zoneName: DEFAULT_ZONE_NAME,
        joined: true,
        localFolderPath: merged.syncDirectoryUri,
        driveFolderId: merged.googleAuth.driveRootFolderId,
        listFileDriveId: merged.googleAuth.listFileDriveId,
        lastSyncedRevision: merged.lastSyncedRevision,
        lastSyncedAt: merged.lastSyncedAt,
        memberDevices: [merged.deviceName],
      });
    }
    return merged;
  } catch {
    return createDefaultState();
  }
}

export async function saveMobileConfig(nextState: MobileAppState): Promise<void> {
  await writeRawMobileConfigJson(JSON.stringify(nextState, null, 2));
}

/**
 * Tự động kiểm tra và gia hạn accessToken trực tiếp với máy chủ Google bằng refreshToken.
 * Hoạt động độc lập 100% trên 4G/5G mà không cần kết nối với máy tính PC.
 */
export async function getValidMobileAccessToken(
  state: MobileAppState,
): Promise<{ token: string; updatedState: MobileAppState }> {
  const { accessToken, refreshToken, expiryDate, clientId, clientSecret } = state.googleAuth;

  if (accessToken && (!expiryDate || Date.now() < expiryDate)) {
    return { token: accessToken, updatedState: state };
  }

  if (!refreshToken) {
    if (accessToken) {
      return { token: accessToken, updatedState: state };
    }
    throw new Error('Chưa đăng nhập tài khoản Google trên điện thoại.');
  }

  const body = new URLSearchParams({
    client_id: clientId || DEFAULT_CLIENT_ID,
    client_secret: clientSecret || DEFAULT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Không thể gia hạn phiên Google OAuth2: ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const nextExpiry = Date.now() + (data.expires_in - 60) * 1000;

  const updatedState: MobileAppState = {
    ...state,
    googleAuth: {
      ...state.googleAuth,
      accessToken: data.access_token,
      expiryDate: nextExpiry,
    },
  };

  await saveMobileConfig(updatedState);
  return { token: data.access_token, updatedState };
}

/**
 * Liên kết 1-chạm: Nhận refreshToken vĩnh viễn + cấu hình Telegram từ máy tính PC.
 * Sau khi nhận 1 lần, điện thoại có thể dùng 4G/5G độc lập trọn đời.
 */
export async function syncAuthFromDesktopBridge(
  bridgeUrlInput: string,
  currentState: MobileAppState,
): Promise<MobileAppState> {
  const baseUrl = (bridgeUrlInput.trim() || 'http://10.10.10.66:8384').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/api/auth/mobile-bridge`);
  if (!res.ok) {
    throw new Error(`Không thể kết nối tới PC tại ${baseUrl} (HTTP ${res.status})`);
  }

  const payload = (await res.json()) as {
    googleAuth: {
      clientId: string | null;
      clientSecret: string | null;
      email: string | null;
      accessToken: string | null;
      refreshToken: string | null;
      expiryDate: number | null;
      driveRootFolderId: string | null;
      listFileDriveId: string | null;
    };
    telegramBot: {
      enabled: boolean;
      botToken: string;
      chatId: string;
    };
    zones?: LocalZoneBinding[];
  };

  if (!payload.googleAuth?.accessToken && !payload.googleAuth?.refreshToken) {
    throw new Error(
      'Máy tính PC chưa đăng nhập Google. Hãy bấm "Đăng nhập bằng Google" trên Web UI của PC trước!',
    );
  }

  const localZonesMap = new Map<string, LocalZoneBinding>();
  for (const z of currentState.zones ?? []) {
    localZonesMap.set(z.zoneId, z);
  }
  for (const rz of payload.zones ?? []) {
    const existing = localZonesMap.get(rz.zoneId);
    if (existing) {
      localZonesMap.set(rz.zoneId, {
        ...existing,
        zoneName: rz.zoneName || existing.zoneName,
        description: rz.description ?? existing.description,
        driveFolderId: rz.driveFolderId || existing.driveFolderId,
        memberDevices: rz.memberDevices ?? existing.memberDevices,
      });
    } else {
      localZonesMap.set(rz.zoneId, {
        zoneId: rz.zoneId,
        zoneName: rz.zoneName,
        description: rz.description,
        joined: false,
        localFolderPath: null,
        driveFolderId: rz.driveFolderId,
        listFileDriveId: rz.listFileDriveId,
        lastSyncedRevision: 0,
        lastSyncedAt: null,
        memberDevices: rz.memberDevices ?? [],
      });
    }
  }

  const nextBotToken = payload.telegramBot.botToken || currentState.telegramBot.botToken;
  const nextChatId = payload.telegramBot.chatId || currentState.telegramBot.chatId;

  const updated: MobileAppState = {
    ...currentState,
    desktopBridgeUrl: baseUrl,
    zones: [...localZonesMap.values()],
    googleAuth: {
      clientId: payload.googleAuth.clientId || currentState.googleAuth.clientId,
      clientSecret: payload.googleAuth.clientSecret || currentState.googleAuth.clientSecret,
      email: payload.googleAuth.email,
      accessToken: payload.googleAuth.accessToken,
      refreshToken: payload.googleAuth.refreshToken,
      expiryDate: payload.googleAuth.expiryDate,
      driveRootFolderId: payload.googleAuth.driveRootFolderId,
      listFileDriveId: payload.googleAuth.listFileDriveId,
    },
    telegramBot: {
      enabled: Boolean(payload.telegramBot.enabled || (nextBotToken && nextChatId)),
      pausedByUser: false,
      botToken: nextBotToken,
      chatId: nextChatId,
    },
  };

  await saveMobileConfig(updated);
  return updated;
}

/**
 * Tạo đường dẫn đăng nhập Google độc lập (dùng khi điện thoại đang chạy 4G/5G không chung mạng với PC)
 */
export function buildStandaloneGoogleAuthUrl(state: MobileAppState): string {
  const params = new URLSearchParams({
    client_id: state.googleAuth.clientId || DEFAULT_CLIENT_ID,
    redirect_uri: DEFAULT_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Đổi mã xác thực (hoặc URL callback chứa ?code=...) lấy refreshToken vĩnh viễn trực tiếp trên 4G/5G
 */
export async function exchangeStandaloneGoogleCode(
  rawCodeOrUrl: string,
  currentState: MobileAppState,
): Promise<MobileAppState> {
  let code = rawCodeOrUrl.trim();
  if (!code) {
    throw new Error('Vui lòng dán đường dẫn callback hoặc mã code xác thực.');
  }

  if (code.includes('code=')) {
    const match = code.match(/[?&]code=([^&#]+)/);
    if (match?.[1]) {
      code = decodeURIComponent(match[1]);
    }
  }

  const body = new URLSearchParams({
    code,
    client_id: currentState.googleAuth.clientId || DEFAULT_CLIENT_ID,
    client_secret: currentState.googleAuth.clientSecret || DEFAULT_CLIENT_SECRET,
    redirect_uri: DEFAULT_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    throw new Error(`Lỗi đổi mã xác thực Google: ${await tokenRes.text()}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  let email: string | null = null;
  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (userRes.ok) {
      const profile = (await userRes.json()) as { email?: string };
      email = profile.email ?? null;
    }
  } catch {
    // Ignore profile fetch error
  }

  const updated: MobileAppState = {
    ...currentState,
    googleAuth: {
      ...currentState.googleAuth,
      email,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? currentState.googleAuth.refreshToken,
      expiryDate: Date.now() + (tokenData.expires_in - 60) * 1000,
    },
  };

  await saveMobileConfig(updated);
  return updated;
}
