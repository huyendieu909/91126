import type {
  DirectoryBrowseResult,
  ExistingDataStrategy,
  ListFileDocument,
  LocalZoneBinding,
  PublicAppConfig,
  SwitchFolderMode,
  SwitchFolderResult,
  SyncLogEntry,
  SyncProgress,
  SyncRunSummary,
  SyncStatusSnapshot,
  TelegramChatCandidate,
  TelegramPairingSession,
} from '@foldersync/shared';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export interface IndexResponse {
  configured: boolean;
  document: ListFileDocument | null;
  markdown: string;
}

export const api = {
  getConfig(): Promise<PublicAppConfig> {
    return requestJson<PublicAppConfig>('/api/config');
  },

  updateConfig(payload: {
    deviceName?: string;
    googleAuth?: {
      clientId?: string | null;
      clientSecret?: string | null;
    };
    telegramBot?: {
      enabled?: boolean;
      botToken?: string;
      chatId?: string;
    };
  }): Promise<PublicAppConfig> {
    return requestJson<PublicAppConfig>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  browseDirectories(targetPath?: string): Promise<DirectoryBrowseResult> {
    const q = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    return requestJson<DirectoryBrowseResult>(`/api/fs/browse${q}`);
  },

  createDirectory(targetPath: string): Promise<{ path: string }> {
    return requestJson<{ path: string }>('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: targetPath }),
    });
  },

  switchFolder(
    newPath: string,
    mode: SwitchFolderMode,
    existingDataStrategy: ExistingDataStrategy = 'MERGE_ALL',
  ): Promise<{ result: SwitchFolderResult; config: PublicAppConfig }> {
    return requestJson<{ result: SwitchFolderResult; config: PublicAppConfig }>(
      '/api/config/switch-folder',
      {
        method: 'POST',
        body: JSON.stringify({ newPath, mode, existingDataStrategy }),
      },
    );
  },

  getIndex(): Promise<IndexResponse> {
    return requestJson<IndexResponse>('/api/index');
  },

  rescanIndex(): Promise<{ document: ListFileDocument; markdown: string }> {
    return requestJson<{ document: ListFileDocument; markdown: string }>('/api/index/rescan', {
      method: 'POST',
    });
  },

  getGoogleAuthUrl(): Promise<{ url: string; redirectUri: string }> {
    return requestJson<{ url: string; redirectUri: string }>('/api/auth/google/url');
  },

  disconnectGoogle(): Promise<PublicAppConfig> {
    return requestJson<PublicAppConfig>('/api/auth/google/disconnect', {
      method: 'POST',
    });
  },

  getSyncStatus(): Promise<SyncStatusSnapshot> {
    return requestJson<SyncStatusSnapshot>('/api/sync/status');
  },

  getSyncLogs(): Promise<{ logs: SyncLogEntry[] }> {
    return requestJson<{ logs: SyncLogEntry[] }>('/api/sync/logs');
  },

  triggerSync(): Promise<{ summary: SyncRunSummary | null; status: SyncStatusSnapshot }> {
    return requestJson<{ summary: SyncRunSummary | null; status: SyncStatusSnapshot }>(
      '/api/sync/trigger',
      { method: 'POST' },
    );
  },

  testTelegram(botToken?: string, chatId?: string): Promise<{ ok: boolean }> {
    return requestJson<{ ok: boolean }>('/api/telegram/test', {
      method: 'POST',
      body: JSON.stringify({ botToken, chatId }),
    });
  },

  startTelegramPairing(botToken?: string): Promise<{
    session: TelegramPairingSession;
    config: PublicAppConfig;
  }> {
    return requestJson<{ session: TelegramPairingSession; config: PublicAppConfig }>(
      '/api/telegram/pair/start',
      {
        method: 'POST',
        body: JSON.stringify({ botToken }),
      },
    );
  },

  discoverTelegramChats(botToken?: string): Promise<{
    paired: boolean;
    pairedChat?: TelegramChatCandidate;
    chats: TelegramChatCandidate[];
    config: PublicAppConfig;
  }> {
    const q = botToken ? `?botToken=${encodeURIComponent(botToken)}` : '';
    return requestJson<{
      paired: boolean;
      pairedChat?: TelegramChatCandidate;
      chats: TelegramChatCandidate[];
      config: PublicAppConfig;
    }>(`/api/telegram/chats${q}`);
  },

  selectTelegramChat(payload: {
    chatId: string;
    chatTitle?: string;
    botToken?: string;
  }): Promise<PublicAppConfig> {
    return requestJson<PublicAppConfig>('/api/telegram/select-chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  disconnectTelegram(): Promise<PublicAppConfig> {
    return requestJson<PublicAppConfig>('/api/telegram/disconnect', {
      method: 'POST',
    });
  },

  getZones(): Promise<{
    zones: LocalZoneBinding[];
    activeZoneId?: string | null;
    config: PublicAppConfig;
  }> {
    return requestJson<{
      zones: LocalZoneBinding[];
      activeZoneId?: string | null;
      config: PublicAppConfig;
    }>('/api/zones');
  },

  createZone(payload: {
    zoneName: string;
    description?: string;
    localFolderPath: string;
    existingDataStrategy?: ExistingDataStrategy;
  }): Promise<{ zone: LocalZoneBinding; config: PublicAppConfig }> {
    return requestJson<{ zone: LocalZoneBinding; config: PublicAppConfig }>(
      '/api/zones/create',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  },

  joinZone(payload: {
    zoneId: string;
    localFolderPath: string;
    existingDataStrategy?: ExistingDataStrategy;
  }): Promise<{ zone: LocalZoneBinding; config: PublicAppConfig }> {
    return requestJson<{ zone: LocalZoneBinding; config: PublicAppConfig }>('/api/zones/join', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  leaveZone(zoneId: string): Promise<{ zones: LocalZoneBinding[]; config: PublicAppConfig }> {
    return requestJson<{ zones: LocalZoneBinding[]; config: PublicAppConfig }>(
      '/api/zones/leave',
      {
        method: 'POST',
        body: JSON.stringify({ zoneId }),
      },
    );
  },

  activateZone(zoneId: string): Promise<{ zone: LocalZoneBinding; config: PublicAppConfig }> {
    return requestJson<{ zone: LocalZoneBinding; config: PublicAppConfig }>(
      '/api/zones/activate',
      {
        method: 'POST',
        body: JSON.stringify({ zoneId }),
      },
    );
  },

  syncZone(zoneId: string): Promise<{
    summary: SyncRunSummary | null;
    status: SyncStatusSnapshot;
    config: PublicAppConfig;
  }> {
    return requestJson<{
      summary: SyncRunSummary | null;
      status: SyncStatusSnapshot;
      config: PublicAppConfig;
    }>('/api/zones/sync', {
      method: 'POST',
      body: JSON.stringify({ zoneId }),
    });
  },
};

export interface RealtimeWsMessage {
  type:
    | 'indexUpdated'
    | 'syncStarted'
    | 'syncCompleted'
    | 'syncError'
    | 'syncProgress'
    | 'logAdded'
    | 'telegramPaired';
  payload: unknown;
}

export function subscribeAgentEvents(onMessage: (msg: RealtimeWsMessage) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryTimer: number | null = null;

  const connect = () => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);

    ws.onmessage = (evt) => {
      try {
        const parsed = JSON.parse(String(evt.data)) as RealtimeWsMessage;
        onMessage(parsed);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!closed) {
        retryTimer = window.setTimeout(connect, 2500);
      }
    };
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
    }
    if (ws) {
      ws.close();
    }
  };
}
