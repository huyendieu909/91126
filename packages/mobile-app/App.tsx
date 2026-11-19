import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type {
  FileIndexEntry,
  ListFileDocument,
  SwitchFolderMode,
  SyncProgress,
} from '@foldersync/shared';
import {
  buildStandaloneGoogleAuthUrl,
  exchangeStandaloneGoogleCode,
  loadMobileConfig,
  saveMobileConfig,
  syncAuthFromDesktopBridge,
  type MobileAppState,
} from './src/storage/mobile-config';
import {
  activateAndroidZone,
  discoverAndroidZones,
  joinOrCreateAndroidZone,
  leaveAndroidZone,
  pickAndSwitchAndroidSyncFolder,
  runAndroidSyncNow,
  scanAndroidLocalFolder,
} from './src/services/android-sync-engine';
import {
  deletePlatformFile,
  getMimeTypeFromFileName,
  openPlatformFileExternal,
  readPlatformFileBase64,
  readPlatformFileText,
  renamePlatformFile,
  writePlatformFile,
} from './src/storage/platform-fs';

function formatDisplayFolderPath(rawUri: string | null): string {
  if (!rawUri) return 'Chưa chọn thư mục';
  const decoded = decodeURIComponent(rawUri);
  if (decoded.startsWith('dev-fs://')) {
    return decoded.replace('dev-fs://', '');
  }
  const treeIdx = decoded.indexOf('/tree/');
  if (treeIdx >= 0) {
    const afterTree = decoded.slice(treeIdx + 6);
    const colonIdx = afterTree.indexOf(':');
    if (colonIdx >= 0) {
      const storage = afterTree.slice(0, colonIdx);
      const subPath = afterTree.slice(colonIdx + 1).replace(/^\/+/, '');
      const rootLabel = storage === 'primary' ? 'Bộ nhớ máy' : `Bộ nhớ (${storage})`;
      return subPath ? `${rootLabel} / ${subPath}` : rootLabel;
    }
    return afterTree;
  }
  return decoded;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function getFileEmoji(relativePath: string): string {
  const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'svg', 'bmp'].includes(ext)) return '🖼️';
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(ext)) return '🎵';
  if (['md', 'txt', 'pdf', 'doc', 'docx', 'rtf'].includes(ext)) return '📄';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'html', 'css'].includes(ext)) return '💻';
  return '📎';
}

function isImageFilePath(relativePath: string): boolean {
  const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);
}

function isTextEditablePath(relativePath: string): boolean {
  const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
  return [
    'md',
    'txt',
    'json',
    'log',
    'csv',
    'ts',
    'tsx',
    'js',
    'jsx',
    'py',
    'html',
    'css',
    'yml',
    'yaml',
    'xml',
  ].includes(ext);
}

export default function App() {
  const [state, setState] = useState<MobileAppState | null>(null);
  const [doc, setDoc] = useState<ListFileDocument | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [switchModalVisible, setSwitchModalVisible] = useState(false);
  const [switchMode, setSwitchMode] = useState<SwitchFolderMode>('POINT_ONLY');
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [zonesModalVisible, setZonesModalVisible] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [standaloneCodeInput, setStandaloneCodeInput] = useState('');
  const [showStandaloneBox, setShowStandaloneBox] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [browseMode, setBrowseMode] = useState<'ALL' | 'FOLDER'>('ALL');
  const [currentSubDir, setCurrentSubDir] = useState('');
  const [previewFile, setPreviewFile] = useState<{
    entry: FileIndexEntry;
    kind: 'IMAGE' | 'TEXT' | 'OTHER';
    dataUri?: string;
    textContent?: string;
  } | null>(null);
  const [previewTextDraft, setPreviewTextDraft] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSaving, setPreviewSaving] = useState(false);
  const [actionFile, setActionFile] = useState<FileIndexEntry | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [confirmDeleteFile, setConfirmDeleteFile] = useState(false);
  const [createFileModalVisible, setCreateFileModalVisible] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFileContent, setNewFileContent] = useState('');

  const uriMapRef = useRef<Map<string, string>>(new Map());
  const suppressForegroundSyncRef = useRef(false);
  const syncingRef = useRef(false);
  const stateRef = useRef<MobileAppState | null>(null);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const reloadLocalState = useCallback(async () => {
    try {
      const loaded = await loadMobileConfig();
      setState(loaded);
      if (loaded.syncDirectoryUri) {
        const scanned = await scanAndroidLocalFolder(loaded.syncDirectoryUri, loaded.deviceName);
        uriMapRef.current = scanned.uriMap;
        setDoc(scanned.doc);
      }
    } catch (err) {
      setStatusMessage(
        `⚠️ Không thể đọc toàn bộ thư mục: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  useEffect(() => {
    void reloadLocalState();
  }, [reloadLocalState]);

  const handleSyncNow = useCallback(async (reason = 'MANUAL') => {
    if (syncingRef.current) {
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    setSyncProgress(null);
    setStatusMessage('⏳ Đang kiểm tra list-file.md và đồng bộ...');
    try {
      const res = await runAndroidSyncNow(reason, (progress) => {
        setSyncProgress(progress);
        if (progress?.message) {
          setStatusMessage(`⏳ ${progress.message}`);
        }
      });
      setDoc(res.document);
      const fresh = await loadMobileConfig();
      setState(fresh);
      setStatusMessage(
        `✅ Đồng bộ xong Rev #${res.summary.revision} (Tải về: ${res.summary.downloadedCount}, Đẩy lên: ${res.summary.uploadedCount}, Xung đột: ${res.summary.conflictsCount})`,
      );
    } catch (err) {
      setStatusMessage(`❌ ${err instanceof Error ? err.message : 'Lỗi đồng bộ'}`);
    } finally {
      syncingRef.current = false;
      setSyncProgress(null);
      setSyncing(false);
    }
  }, []);

  // Auto-sync when user opens app from background (e.g., after tapping Telegram notification)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextAppState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextAppState;
      const curState = stateRef.current;
      if (
        prev !== 'active' &&
        nextAppState === 'active' &&
        !suppressForegroundSyncRef.current &&
        !syncingRef.current &&
        curState?.syncDirectoryUri &&
        (curState?.googleAuth.accessToken || curState?.googleAuth.refreshToken)
      ) {
        void handleSyncNow('APP_FOREGROUND');
      }
    });
    return () => sub.remove();
  }, [handleSyncNow]);

  const handleSyncAuthFromPc = async () => {
    if (!state) return;
    setAuthLoading(true);
    try {
      const updated = await syncAuthFromDesktopBridge(state.desktopBridgeUrl, state);
      setState(updated);
      setStatusMessage(
        `✅ Đã nhận khóa Google (${updated.googleAuth.email || 'Đã kết nối'}) & Telegram! Từ giờ có thể dùng 4G/5G độc lập.`,
      );
      setSettingsModalVisible(false);
    } catch (err) {
      setStatusMessage(`❌ ${err instanceof Error ? err.message : 'Lỗi kết nối PC'}`);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleOpenStandaloneBrowserAuth = async () => {
    if (!state) return;
    setShowStandaloneBox(true);
    const url = buildStandaloneGoogleAuthUrl(state);
    await Linking.openURL(url);
  };

  const handleExchangeStandaloneCode = async () => {
    if (!state) return;
    setAuthLoading(true);
    try {
      const updated = await exchangeStandaloneGoogleCode(standaloneCodeInput, state);
      setState(updated);
      setStandaloneCodeInput('');
      setShowStandaloneBox(false);
      setStatusMessage(
        `✅ Đăng nhập Google độc lập thành công (${updated.googleAuth.email || 'Đã kết nối'})!`,
      );
      setSettingsModalVisible(false);
    } catch (err) {
      setStatusMessage(`❌ ${err instanceof Error ? err.message : 'Lỗi xác thực mã Google'}`);
    } finally {
      setAuthLoading(false);
    }
  };

  const handlePickInitialFolder = async () => {
    suppressForegroundSyncRef.current = true;
    try {
      const picked = await pickAndSwitchAndroidSyncFolder('POINT_ONLY');
      if (picked) {
        setState(picked.updatedState);
        await reloadLocalState();
      }
    } catch (err) {
      setStatusMessage(`❌ Lỗi chọn thư mục: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      suppressForegroundSyncRef.current = false;
    }
  };

  const handleConfirmSwitchFolder = async () => {
    setSwitchModalVisible(false);
    suppressForegroundSyncRef.current = true;
    try {
      const picked = await pickAndSwitchAndroidSyncFolder(switchMode);
      if (picked) {
        setState(picked.updatedState);
        setStatusMessage(
          switchMode === 'COPY_EXISTING'
            ? `✅ Đã đổi thư mục và copy ${picked.copiedCount} file sang nơi mới.`
            : '✅ Đã chuyển sang thư mục đồng bộ mới.',
        );
        await reloadLocalState();
      }
    } catch (err) {
      setStatusMessage(`❌ Lỗi đổi thư mục: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      suppressForegroundSyncRef.current = false;
    }
  };

  const handleOpenFile = async (entry: FileIndexEntry) => {
    if (!state?.syncDirectoryUri) return;
    const fileUri = uriMapRef.current.get(entry.relativePath) ?? '';

    if (isImageFilePath(entry.relativePath)) {
      setPreviewLoading(true);
      setPreviewFile({ entry, kind: 'IMAGE' });
      try {
        const b64 = await readPlatformFileBase64(state.syncDirectoryUri, fileUri, entry.relativePath);
        const mime = getMimeTypeFromFileName(entry.relativePath);
        setPreviewFile({
          entry,
          kind: 'IMAGE',
          dataUri: `data:${mime};base64,${b64}`,
        });
      } catch (err) {
        setPreviewFile(null);
        setStatusMessage(
          `❌ Không thể mở ảnh: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setPreviewLoading(false);
      }
      return;
    }

    if (isTextEditablePath(entry.relativePath)) {
      setPreviewLoading(true);
      setPreviewFile({ entry, kind: 'TEXT', textContent: '' });
      setPreviewTextDraft('');
      try {
        const txt = await readPlatformFileText(state.syncDirectoryUri, fileUri, entry.relativePath);
        setPreviewFile({ entry, kind: 'TEXT', textContent: txt });
        setPreviewTextDraft(txt);
      } catch (err) {
        setPreviewFile(null);
        setStatusMessage(
          `❌ Không thể đọc file: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setPreviewLoading(false);
      }
      return;
    }

    try {
      await openPlatformFileExternal(state.syncDirectoryUri, fileUri, entry.relativePath);
    } catch (err) {
      setStatusMessage(
        `❌ Không mở được file bằng app ngoài: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleOpenExternal = async (entry: FileIndexEntry) => {
    if (!state?.syncDirectoryUri) return;
    const fileUri = uriMapRef.current.get(entry.relativePath);
    try {
      await openPlatformFileExternal(state.syncDirectoryUri, fileUri, entry.relativePath);
    } catch (err) {
      setStatusMessage(
        `❌ Không mở được bằng app ngoài: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleSavePreviewText = async () => {
    if (!state?.syncDirectoryUri || !previewFile || previewFile.kind !== 'TEXT') return;
    setPreviewSaving(true);
    try {
      await writePlatformFile(
        state.syncDirectoryUri,
        uriMapRef.current,
        previewFile.entry.relativePath,
        previewTextDraft,
        false,
      );
      await reloadLocalState();
      setPreviewFile(null);
      setStatusMessage(`✅ Đã lưu "${previewFile.entry.relativePath}". Bấm Đồng bộ ngay để đẩy lên PC!`);
    } catch (err) {
      setStatusMessage(
        `❌ Lỗi lưu file: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPreviewSaving(false);
    }
  };

  const handleRenameActionFile = async () => {
    if (!state?.syncDirectoryUri || !actionFile) return;
    const trimmed = renameInput.trim().replace(/^\/+/, '');
    if (!trimmed || trimmed === actionFile.relativePath) {
      setActionFile(null);
      return;
    }
    try {
      await renamePlatformFile(
        state.syncDirectoryUri,
        uriMapRef.current,
        actionFile.relativePath,
        trimmed,
      );
      await reloadLocalState();
      setActionFile(null);
      setStatusMessage(`✅ Đã đổi tên thành "${trimmed}".`);
    } catch (err) {
      setStatusMessage(
        `❌ Lỗi đổi tên file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleDeleteActionFile = async () => {
    if (!state?.syncDirectoryUri || !actionFile) return;
    try {
      const fileUri = uriMapRef.current.get(actionFile.relativePath);
      await deletePlatformFile(state.syncDirectoryUri, fileUri, actionFile.relativePath);
      uriMapRef.current.delete(actionFile.relativePath);
      await reloadLocalState();
      setActionFile(null);
      setConfirmDeleteFile(false);
      setStatusMessage(`🗑️ Đã xóa "${actionFile.relativePath}" khỏi điện thoại.`);
    } catch (err) {
      setStatusMessage(
        `❌ Lỗi xóa file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleCreateNewFile = async () => {
    if (!state?.syncDirectoryUri) return;
    const rawName = newFileName.trim().replace(/^\/+/, '');
    if (!rawName) return;
    const targetRelPath =
      browseMode === 'FOLDER' && currentSubDir && !rawName.includes('/')
        ? `${currentSubDir}/${rawName}`
        : rawName;
    try {
      await writePlatformFile(
        state.syncDirectoryUri,
        uriMapRef.current,
        targetRelPath,
        newFileContent,
        false,
      );
      await reloadLocalState();
      setNewFileName('');
      setNewFileContent('');
      setCreateFileModalVisible(false);
      setStatusMessage(`✅ Đã tạo file "${targetRelPath}".`);
    } catch (err) {
      setStatusMessage(
        `❌ Lỗi tạo file mới: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (!state) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator color="#6366f1" size="large" />
      </SafeAreaView>
    );
  }

  // First-Run Onboarding Screen on Android
  if (!state.syncDirectoryUri) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.onboardingCard}>
          <Text style={styles.badge}>Thiết lập lần đầu · Android</Text>
          <Text style={styles.title}>FolderSync Mobile</Text>
          <Text style={styles.subtitle}>
            Chọn một thư mục trên điện thoại để đồng bộ tự động với Linux & Windows qua list-file.md
          </Text>

          <Text style={styles.label}>1. Tên thiết bị Android</Text>
          <TextInput
            style={styles.input}
            value={state.deviceName}
            onChangeText={(txt) => setState({ ...state, deviceName: txt })}
            onBlur={() => void saveMobileConfig(state)}
            placeholder="Android-Phone"
            placeholderTextColor="#64748b"
          />

          <Text style={styles.label}>2. Chọn thư mục đồng bộ</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => void handlePickInitialFolder()}>
            <Text style={styles.primaryBtnText}>📂 Chọn thư mục trên máy Android</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const activeEntries: FileIndexEntry[] = (doc?.entries ?? []).filter(
    (e) => e.status === 'ACTIVE',
  );
  const filteredEntries: FileIndexEntry[] = searchQuery.trim()
    ? activeEntries.filter((e) =>
        e.relativePath.toLowerCase().includes(searchQuery.trim().toLowerCase()),
      )
    : activeEntries;
  const joinedZones = (state.zones ?? []).filter((z) => z.joined && z.localFolderPath);
  const activeZoneObj = (state.zones ?? []).find((z) => z.zoneId === state.activeZoneId);
  const activeZoneTitle = activeZoneObj?.zoneName || state.activeZoneId || 'default-zone';
  const isGoogleConnected = Boolean(
    state.googleAuth.accessToken || state.googleAuth.refreshToken,
  );
  type ExplorerItem =
    | { type: 'DIR'; name: string; fullPath: string; count: number }
    | { type: 'FILE'; entry: FileIndexEntry };

  const explorerItems: ExplorerItem[] = (() => {
    if (browseMode === 'ALL' || searchQuery.trim()) {
      return filteredEntries.map((entry) => ({ type: 'FILE', entry }));
    }
    const prefix = currentSubDir ? `${currentSubDir}/` : '';
    const folderCounts = new Map<string, number>();
    const filesHere: FileIndexEntry[] = [];
    for (const e of activeEntries) {
      if (prefix && !e.relativePath.startsWith(prefix)) continue;
      const rest = prefix ? e.relativePath.slice(prefix.length) : e.relativePath;
      const slashIdx = rest.indexOf('/');
      if (slashIdx >= 0) {
        const dirName = rest.slice(0, slashIdx);
        folderCounts.set(dirName, (folderCounts.get(dirName) ?? 0) + 1);
      } else {
        filesHere.push(e);
      }
    }
    const dirItems: ExplorerItem[] = [...folderCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({
        type: 'DIR',
        name,
        fullPath: prefix ? `${prefix}${name}` : name,
        count,
      }));
    const fileItems: ExplorerItem[] = filesHere.map((entry) => ({ type: 'FILE', entry }));
    return [...dirItems, ...fileItems];
  })();

  const statusBannerStyle = statusMessage.startsWith('❌') || statusMessage.startsWith('⚠️')
    ? styles.statusBannerError
    : statusMessage.startsWith('✅')
      ? styles.statusBannerSuccess
      : styles.statusBannerInfo;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerInfo}>
          <View style={styles.headerTitleRow}>
            <Text style={styles.headerTitle}>FolderSync</Text>
            <View
              style={[
                styles.statusBadge,
                isGoogleConnected ? styles.statusBadgeOk : styles.statusBadgeWarn,
              ]}
            >
              <Text
                style={isGoogleConnected ? styles.statusBadgeTextOk : styles.statusBadgeTextWarn}
              >
                {isGoogleConnected ? '● Cloud OK' : '● Chưa kết nối'}
              </Text>
            </View>
          </View>
          <Text style={styles.headerSub} numberOfLines={1}>
            📱 {state.deviceName} · Rev #{doc?.revision ?? state.lastSyncedRevision}
            {isGoogleConnected && state.googleAuth.email ? ` · ${state.googleAuth.email}` : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.headerSettingsBtn}
          onPress={() => setSettingsModalVisible(true)}
        >
          <Text style={styles.secondaryBtnText}>⚙️</Text>
        </TouchableOpacity>
      </View>

      {/* Quick 1-Tap Horizontal Zone Pills */}
      <View style={styles.zonePillsBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.zonePillsScroll}
        >
          {joinedZones.map((z) => {
            const isSelected = z.zoneId === (state.activeZoneId || 'default-zone');
            return (
              <TouchableOpacity
                key={z.zoneId}
                style={[styles.zonePill, isSelected && styles.zonePillActive]}
                onPress={async () => {
                  if (isSelected) return;
                  try {
                    const updated = await activateAndroidZone(z.zoneId);
                    setState(updated);
                    setCurrentSubDir('');
                    await reloadLocalState();
                    setStatusMessage(`✅ Đã chuyển sang vùng "${z.zoneName}".`);
                  } catch (err) {
                    setStatusMessage(
                      `❌ ${err instanceof Error ? err.message : 'Không thể chuyển vùng'}`,
                    );
                  }
                }}
              >
                <Text style={[styles.zonePillText, isSelected && styles.zonePillTextActive]}>
                  {isSelected ? '✨ ' : '📁 '}
                  {z.zoneName}
                </Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            style={styles.zonePillAdd}
            onPress={() => setZonesModalVisible(true)}
          >
            <Text style={styles.zonePillAddText}>🌐 + Vùng</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* Current Folder & Sync Trigger Card */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.sectionLabel}>VÙNG: {activeZoneTitle.toUpperCase()}</Text>
          <Text style={styles.fileCountPill}>{activeEntries.length} file</Text>
        </View>
        <Text style={styles.folderUri} numberOfLines={2}>
          📁 {formatDisplayFolderPath(state.syncDirectoryUri)}
        </Text>

        <TouchableOpacity
          style={styles.fullWidthPrimaryBtn}
          disabled={syncing}
          onPress={() => void handleSyncNow('MANUAL')}
        >
          <Text style={styles.primaryBtnText}>
            {syncing ? '⏳ Đang đồng bộ...' : '🔄 Đồng bộ ngay'}
          </Text>
        </TouchableOpacity>

        {(syncing || syncProgress) && (
          <View style={styles.progressWrap}>
            <View style={styles.progressMetaRow}>
              <Text style={styles.progressText} numberOfLines={1}>
                {syncProgress?.message || 'Đang xử lý đồng bộ...'}
              </Text>
              <Text style={styles.progressPercent}>
                {syncProgress && syncProgress.total > 0
                  ? `${syncProgress.current}/${syncProgress.total} (${syncProgress.percent}%)`
                  : syncProgress?.phase === 'SCANNING'
                    ? 'Quét...'
                    : '...'}
              </Text>
            </View>
            {syncProgress?.currentPath ? (
              <Text style={styles.progressPath} numberOfLines={1}>
                {syncProgress.currentPath}
              </Text>
            ) : null}
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${
                      syncProgress && syncProgress.total > 0
                        ? Math.max(2, syncProgress.percent)
                        : syncing
                          ? 100
                          : 0
                    }%`,
                    opacity: syncProgress && syncProgress.total > 0 ? 1 : syncing ? 0.35 : 0,
                  },
                ]}
              />
            </View>
          </View>
        )}

        <View style={styles.rowGap}>
          <TouchableOpacity
            style={[styles.secondaryBtn, { flex: 1 }]}
            onPress={() => setZonesModalVisible(true)}
          >
            <Text style={styles.secondaryBtnText}>🌐 Quản lý vùng</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryBtn, { flex: 1 }]}
            onPress={() => setSwitchModalVisible(true)}
          >
            <Text style={styles.secondaryBtnText}>📂 Đổi thư mục</Text>
          </TouchableOpacity>
        </View>

        {statusMessage ? (
          <View style={[styles.statusBanner, statusBannerStyle]}>
            <Text style={styles.statusText}>{statusMessage}</Text>
          </View>
        ) : null}
      </View>

      {/* list-file.md File Explorer */}
      <View style={[styles.card, { flex: 1, marginBottom: 0 }]}>
        <View style={styles.explorerHeaderRow}>
          <Text style={styles.sectionLabel} numberOfLines={1}>
            TỆP · {activeZoneTitle.toUpperCase()} ({filteredEntries.length})
          </Text>
          <View style={styles.explorerActionsRow}>
            <TouchableOpacity
              style={styles.miniChipBtn}
              onPress={() => {
                setBrowseMode((prev) => (prev === 'ALL' ? 'FOLDER' : 'ALL'));
                setCurrentSubDir('');
              }}
            >
              <Text style={styles.miniChipText}>
                {browseMode === 'FOLDER' ? '📋 Tất cả' : '📁 Thư mục'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.miniChipBtn, styles.miniChipPrimary]}
              onPress={() => {
                setNewFileName('');
                setNewFileContent('');
                setCreateFileModalVisible(true);
              }}
            >
              <Text style={styles.miniChipPrimaryText}>+ Tạo file</Text>
            </TouchableOpacity>
          </View>
        </View>

        {browseMode === 'FOLDER' && !searchQuery.trim() && currentSubDir ? (
          <View style={styles.breadcrumbBar}>
            <TouchableOpacity
              style={styles.breadcrumbChip}
              onPress={() => setCurrentSubDir('')}
            >
              <Text style={styles.breadcrumbText}>🏠 Gốc</Text>
            </TouchableOpacity>
            {currentSubDir.split('/').map((seg, idx, arr) => {
              const targetPath = arr.slice(0, idx + 1).join('/');
              const isLast = idx === arr.length - 1;
              return (
                <React.Fragment key={targetPath}>
                  <Text style={styles.breadcrumbSep}>/</Text>
                  <TouchableOpacity
                    style={[styles.breadcrumbChip, isLast && styles.breadcrumbChipActive]}
                    onPress={() => setCurrentSubDir(targetPath)}
                  >
                    <Text style={styles.breadcrumbText}>{seg}</Text>
                  </TouchableOpacity>
                </React.Fragment>
              );
            })}
          </View>
        ) : null}

        {activeEntries.length > 0 && (
          <View style={styles.searchBox}>
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="🔍 Tìm nhanh tên file..."
              placeholderTextColor="#64748b"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                style={styles.searchClearBtn}
                onPress={() => setSearchQuery('')}
              >
                <Text style={styles.searchClearText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <FlatList
          data={explorerItems}
          keyExtractor={(item) =>
            item.type === 'DIR' ? `dir:${item.fullPath}` : `file:${item.entry.relativePath}`
          }
          refreshing={syncing}
          onRefresh={() => void handleSyncNow('PULL_TO_REFRESH')}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              {searchQuery.trim()
                ? 'Không tìm thấy file nào khớp từ khóa.'
                : 'Chưa có file nào trong vùng này. Kéo xuống hoặc bấm "+ Tạo file"!'}
            </Text>
          }
          renderItem={({ item }) => {
            if (item.type === 'DIR') {
              return (
                <TouchableOpacity
                  style={styles.fileRow}
                  onPress={() => setCurrentSubDir(item.fullPath)}
                >
                  <View style={[styles.fileIconBadge, styles.dirIconBadge]}>
                    <Text style={styles.fileIconText}>📁</Text>
                  </View>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={styles.fileName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.fileMeta}>{item.count} tệp bên trong</Text>
                  </View>
                  <Text style={styles.dirChevron}>›</Text>
                </TouchableOpacity>
              );
            }

            const entry = item.entry;
            const displayName =
              browseMode === 'FOLDER' && currentSubDir && !searchQuery.trim()
                ? entry.relativePath.slice(currentSubDir.length + 1)
                : entry.relativePath;

            return (
              <TouchableOpacity
                style={styles.fileRow}
                onPress={() => void handleOpenFile(entry)}
                onLongPress={() => {
                  setActionFile(entry);
                  setRenameInput(entry.relativePath);
                  setConfirmDeleteFile(false);
                }}
              >
                <View style={styles.fileIconBadge}>
                  <Text style={styles.fileIconText}>{getFileEmoji(entry.relativePath)}</Text>
                </View>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={styles.fileName} numberOfLines={2}>
                    {displayName}
                  </Text>
                  <Text style={styles.fileMeta} numberOfLines={1}>
                    {formatBytes(entry.size)} · Bởi {entry.updatedBy}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.fileMoreBtn}
                  onPress={() => {
                    setActionFile(entry);
                    setRenameInput(entry.relativePath);
                    setConfirmDeleteFile(false);
                  }}
                >
                  <Text style={styles.fileMoreText}>⋮</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {/* Multi-Zone Sync Network Modal */}
      <Modal visible={zonesModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>🌐 Mạng Lưới Vùng Đồng Bộ</Text>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setZonesModalVisible(false)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
              <Text style={styles.subtitle}>
                Mỗi vùng là 1 thư mục đồng bộ riêng. Điện thoại có thể chọn tham gia hoặc rời khỏi bất kỳ vùng nào.
              </Text>

              <TouchableOpacity
                style={[styles.secondaryBtn, { marginBottom: 12, alignItems: 'center' }]}
                onPress={async () => {
                  try {
                    const updated = await discoverAndroidZones();
                    setState(updated);
                    setStatusMessage(`✅ Đã quét thấy ${updated.zones.length} vùng đồng bộ từ Cloud.`);
                  } catch (err) {
                    setStatusMessage(`❌ ${err instanceof Error ? err.message : 'Lỗi quét vùng'}`);
                  }
                }}
              >
                <Text style={styles.secondaryBtnText}>🔍 Quét Danh Sách Vùng Từ Cloud</Text>
              </TouchableOpacity>

              {(state.zones ?? []).map((z) => {
                const isActive = z.zoneId === state.activeZoneId && z.joined;
                return (
                  <View
                    key={z.zoneId}
                    style={[
                      styles.modeOption,
                      isActive && styles.modeOptionSelected,
                      { marginBottom: 10 },
                    ]}
                  >
                    <Text style={styles.modeTitle}>
                      {z.zoneName} ({z.zoneId}){' '}
                      {isActive ? '✨ Đang chọn' : z.joined ? '✅ Đã tham gia' : '⚪ Chưa tham gia'}
                    </Text>
                    <Text style={styles.fileMeta}>
                      Thành viên: {(z.memberDevices ?? []).join(', ') || 'Chưa có'}
                    </Text>
                    {z.joined && z.localFolderPath ? (
                      <Text style={styles.fileMeta} numberOfLines={1}>
                        📂 {decodeURIComponent(z.localFolderPath)}
                      </Text>
                    ) : null}

                    <View style={[styles.rowGap, { marginTop: 8 }]}>
                      {z.joined ? (
                        <>
                          {!isActive && (
                            <TouchableOpacity
                              style={[styles.primaryBtn, { flex: 1, paddingVertical: 8 }]}
                              onPress={async () => {
                                const updated = await activateAndroidZone(z.zoneId);
                                setState(updated);
                                await reloadLocalState();
                                setZonesModalVisible(false);
                              }}
                            >
                              <Text style={styles.primaryBtnText}>Xem Vùng Này</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            style={[styles.secondaryBtn, { paddingVertical: 8 }]}
                            onPress={async () => {
                              const updated = await leaveAndroidZone(z.zoneId);
                              setState(updated);
                              await reloadLocalState();
                            }}
                          >
                            <Text style={styles.secondaryBtnText}>👋 Rời vùng</Text>
                          </TouchableOpacity>
                        </>
                      ) : (
                        <TouchableOpacity
                          style={[styles.primaryBtn, { flex: 1, paddingVertical: 8 }]}
                          onPress={async () => {
                            suppressForegroundSyncRef.current = true;
                            let joinedOk = false;
                            try {
                              const updated = await joinOrCreateAndroidZone({
                                zoneId: z.zoneId,
                                zoneName: z.zoneName,
                                description: z.description,
                              });
                              if (updated) {
                                setState(updated);
                                await reloadLocalState();
                                setZonesModalVisible(false);
                                joinedOk = true;
                              }
                            } catch (err) {
                              setZonesModalVisible(false);
                              setStatusMessage(
                                `❌ ${err instanceof Error ? err.message : 'Lỗi tham gia vùng'}`,
                              );
                            } finally {
                              suppressForegroundSyncRef.current = false;
                            }
                            if (joinedOk) {
                              void handleSyncNow('ZONE_JOINED');
                            }
                          }}
                        >
                          <Text style={styles.primaryBtnText}>
                            🤝 Tham gia vùng (Chọn thư mục Android)
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}

              <Text style={styles.label}>➕ Tạo Vùng Sync Mới Từ Điện Thoại</Text>
              <TextInput
                style={styles.input}
                value={newZoneName}
                onChangeText={setNewZoneName}
                placeholder="VD: Ảnh Điện Thoại, Ghi Chú..."
                placeholderTextColor="#64748b"
              />
              <TouchableOpacity
                style={[styles.primaryBtn, { marginTop: 8 }]}
                disabled={!newZoneName.trim()}
                onPress={async () => {
                  const name = newZoneName.trim();
                  if (!name) return;
                  suppressForegroundSyncRef.current = true;
                  let createdOk = false;
                  try {
                    const updated = await joinOrCreateAndroidZone({ zoneName: name });
                    if (updated) {
                      setNewZoneName('');
                      setState(updated);
                      await reloadLocalState();
                      setZonesModalVisible(false);
                      createdOk = true;
                    }
                  } catch (err) {
                    setZonesModalVisible(false);
                    setStatusMessage(
                      `❌ ${err instanceof Error ? err.message : 'Lỗi tạo vùng mới'}`,
                    );
                  } finally {
                    suppressForegroundSyncRef.current = false;
                  }
                  if (createdOk) {
                    void handleSyncNow('ZONE_CREATED');
                  }
                }}
              >
                <Text style={styles.primaryBtnText}>✨ Chọn thư mục & Tạo vùng mới</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryBtn, { marginTop: 14, alignItems: 'center' }]}
                onPress={() => setZonesModalVisible(false)}
              >
                <Text style={styles.secondaryBtnText}>Đóng</Text>
              </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Switch Sync Folder Modal (2 Modes) */}
      <Modal visible={switchModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Đổi Thư Mục Đồng Bộ</Text>
            <Text style={styles.subtitle}>Chọn cách xử lý dữ liệu ở thư mục cũ:</Text>

            <TouchableOpacity
              style={[
                styles.modeOption,
                switchMode === 'POINT_ONLY' && styles.modeOptionSelected,
              ]}
              onPress={() => setSwitchMode('POINT_ONLY')}
            >
              <Text style={styles.modeTitle}>1. Chỉ trỏ sang thư mục mới và đồng bộ lại</Text>
              <Text style={styles.fileMeta}>Giữ nguyên thư mục cũ không đụng tới.</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.modeOption,
                switchMode === 'COPY_EXISTING' && styles.modeOptionSelected,
              ]}
              onPress={() => setSwitchMode('COPY_EXISTING')}
            >
              <Text style={styles.modeTitle}>
                2. Tự động copy toàn bộ file từ thư mục cũ sang thư mục mới
              </Text>
              <Text style={styles.fileMeta}>Chép sẵn file sang thư mục mới để đỡ tải lại.</Text>
            </TouchableOpacity>

            <View style={styles.rowGap}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => setSwitchModalVisible(false)}
              >
                <Text style={styles.secondaryBtnText}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, { flex: 1 }]}
                onPress={() => void handleConfirmSwitchFolder()}
              >
                <Text style={styles.primaryBtnText}>Chọn thư mục mới</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Settings Modal (Google Auth & Telegram Bot) */}
      <Modal visible={settingsModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>⚙️ Cài Đặt Google & Telegram</Text>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setSettingsModalVisible(false)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            {isGoogleConnected ? (
              <View style={styles.connectedBanner}>
                <Text style={styles.connectedText}>
                  ✅ Đã kết nối Google: {state.googleAuth.email || 'Sẵn sàng đồng bộ (4G/5G/Wi-Fi)'}
                </Text>
              </View>
            ) : null}

            {/* Option 1: 1-Tap Permanent RefreshToken Sync from PC */}
            <Text style={styles.label}>
              Cách 1: Nhận khóa vĩnh viễn 1-chạm từ PC (Nhận 1 lần, dùng 4G/5G trọn đời)
            </Text>
            <TextInput
              style={styles.input}
              value={state.desktopBridgeUrl}
              onChangeText={(txt) => setState({ ...state, desktopBridgeUrl: txt })}
              placeholder="http://10.10.10.66:8384"
              placeholderTextColor="#64748b"
            />
            <TouchableOpacity
              style={[styles.googleBtn, { marginTop: 8 }]}
              disabled={authLoading}
              onPress={() => void handleSyncAuthFromPc()}
            >
              <Text style={styles.googleBtnText}>
                {authLoading
                  ? '⏳ Đang lấy khóa từ PC...'
                  : '⚡ Nhận tài khoản Google & Telegram từ PC'}
              </Text>
            </TouchableOpacity>

            {/* Option 2: 100% Standalone 4G/5G Browser Login */}
            <Text style={styles.label}>
              Cách 2: Đăng nhập độc lập trên 4G/5G (Không cần PC)
            </Text>
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => void handleOpenStandaloneBrowserAuth()}
            >
              <Text style={styles.secondaryBtnText}>
                🌐 Mở trình duyệt đăng nhập Google (4G/5G)
              </Text>
            </TouchableOpacity>

            {showStandaloneBox && (
              <View style={{ marginTop: 8 }}>
                <Text style={styles.fileMeta}>
                  Sau khi bấm Cho phép trên trình duyệt, copy toàn bộ thanh địa chỉ (chứa ?code=...) dán vào đây:
                </Text>
                <TextInput
                  style={[styles.input, { marginTop: 6 }]}
                  value={standaloneCodeInput}
                  onChangeText={setStandaloneCodeInput}
                  placeholder="Dán link http://localhost:8384/...?code=... vào đây"
                  placeholderTextColor="#64748b"
                />
                <TouchableOpacity
                  style={[styles.primaryBtn, { marginTop: 8 }]}
                  disabled={authLoading || !standaloneCodeInput.trim()}
                  onPress={() => void handleExchangeStandaloneCode()}
                >
                  <Text style={styles.primaryBtnText}>Xác nhận mã đăng nhập Google</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.switchRow}>
              <Text style={styles.label}>Bật thông báo Telegram Bot</Text>
              <Switch
                value={state.telegramBot.enabled}
                onValueChange={(val) =>
                  setState({
                    ...state,
                    telegramBot: {
                      ...state.telegramBot,
                      enabled: val,
                      pausedByUser: !val,
                    },
                  })
                }
              />
            </View>

            <TextInput
              style={styles.input}
              value={state.telegramBot.botToken}
              onChangeText={(txt) =>
                setState({
                  ...state,
                  telegramBot: { ...state.telegramBot, botToken: txt },
                })
              }
              placeholder="Telegram Bot Token"
              placeholderTextColor="#64748b"
              secureTextEntry
            />

            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              value={state.telegramBot.chatId}
              onChangeText={(txt) =>
                setState({
                  ...state,
                  telegramBot: { ...state.telegramBot, chatId: txt },
                })
              }
              placeholder="Telegram Chat ID"
              placeholderTextColor="#64748b"
            />

            <View style={styles.rowGap}>
              <TouchableOpacity
                style={[styles.secondaryBtn, { marginTop: 16 }]}
                onPress={() => setSettingsModalVisible(false)}
              >
                <Text style={styles.secondaryBtnText}>Đóng</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, { flex: 1, marginTop: 16 }]}
                onPress={async () => {
                  await saveMobileConfig(state);
                  setSettingsModalVisible(false);
                }}
              >
                <Text style={styles.primaryBtnText}>Lưu cài đặt</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* In-App File Viewer / Editor Modal */}
      <Modal visible={previewFile !== null} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { maxHeight: '88%' }]}>
            <View style={styles.modalHeaderRow}>
              <Text style={[styles.modalTitle, { flex: 1, marginRight: 8 }]} numberOfLines={1}>
                {previewFile ? `${getFileEmoji(previewFile.entry.relativePath)} ${previewFile.entry.relativePath}` : ''}
              </Text>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setPreviewFile(null)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            {previewLoading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color="#6366f1" size="large" />
                <Text style={[styles.fileMeta, { marginTop: 10 }]}>Đang mở file...</Text>
              </View>
            ) : previewFile?.kind === 'IMAGE' && previewFile.dataUri ? (
              <View style={styles.previewImageWrap}>
                <Image
                  source={{ uri: previewFile.dataUri }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              </View>
            ) : previewFile?.kind === 'TEXT' ? (
              <TextInput
                style={styles.previewTextEditor}
                value={previewTextDraft}
                onChangeText={setPreviewTextDraft}
                multiline
                numberOfLines={12}
                textAlignVertical="top"
                placeholder="(File trống)"
                placeholderTextColor="#64748b"
              />
            ) : null}

            <View style={[styles.rowGap, { marginTop: 12 }]}>
              {previewFile && (
                <TouchableOpacity
                  style={[styles.secondaryBtn, { flex: 1 }]}
                  onPress={() => void handleOpenExternal(previewFile.entry)}
                >
                  <Text style={styles.secondaryBtnText}>🚀 Mở app ngoài</Text>
                </TouchableOpacity>
              )}
              {previewFile?.kind === 'TEXT' && (
                <TouchableOpacity
                  style={[styles.primaryBtn, { flex: 1 }]}
                  disabled={previewSaving}
                  onPress={() => void handleSavePreviewText()}
                >
                  <Text style={styles.primaryBtnText}>
                    {previewSaving ? 'Đang lưu...' : '💾 Lưu thay đổi'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* File Action Menu Modal (Open / Rename / Delete) */}
      <Modal visible={actionFile !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={[styles.modalTitle, { flex: 1, marginRight: 8 }]} numberOfLines={2}>
                {actionFile ? `${getFileEmoji(actionFile.relativePath)} ${actionFile.relativePath}` : ''}
              </Text>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => {
                  setActionFile(null);
                  setConfirmDeleteFile(false);
                }}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            {actionFile && (
              <Text style={[styles.fileMeta, { marginBottom: 12 }]}>
                {formatBytes(actionFile.size)} · Cập nhật bởi {actionFile.updatedBy}
              </Text>
            )}

            <View style={styles.rowGap}>
              <TouchableOpacity
                style={[styles.primaryBtn, { flex: 1 }]}
                onPress={() => {
                  const target = actionFile;
                  setActionFile(null);
                  if (target) void handleOpenFile(target);
                }}
              >
                <Text style={styles.primaryBtnText}>👁️ Mở xem</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.secondaryBtn, { flex: 1 }]}
                onPress={() => {
                  const target = actionFile;
                  setActionFile(null);
                  if (target) void handleOpenExternal(target);
                }}
              >
                <Text style={styles.secondaryBtnText}>🚀 App ngoài</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>✏️ Đổi tên / Di chuyển đường dẫn</Text>
            <View style={styles.rowGap}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={renameInput}
                onChangeText={setRenameInput}
                placeholder="ten-file-moi.md"
                placeholderTextColor="#64748b"
              />
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => void handleRenameActionFile()}
              >
                <Text style={styles.secondaryBtnText}>Đổi tên</Text>
              </TouchableOpacity>
            </View>

            <View style={{ marginTop: 16 }}>
              {!confirmDeleteFile ? (
                <TouchableOpacity
                  style={styles.dangerOutlineBtn}
                  onPress={() => setConfirmDeleteFile(true)}
                >
                  <Text style={styles.dangerBtnText}>🗑️ Xóa file này</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.rowGap}>
                  <TouchableOpacity
                    style={[styles.secondaryBtn, { flex: 1 }]}
                    onPress={() => setConfirmDeleteFile(false)}
                  >
                    <Text style={styles.secondaryBtnText}>Hủy</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.dangerSolidBtn, { flex: 1 }]}
                    onPress={() => void handleDeleteActionFile()}
                  >
                    <Text style={styles.primaryBtnText}>Xác nhận xóa</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Create New File Modal */}
      <Modal visible={createFileModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalCard}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>📝 Tạo File Mới</Text>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setCreateFileModalVisible(false)}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.label}>Tên file (VD: ghi-chu.md hoặc notes/todo.txt)</Text>
            <TextInput
              style={styles.input}
              value={newFileName}
              onChangeText={setNewFileName}
              placeholder="ghi-chu.md"
              placeholderTextColor="#64748b"
            />
            <Text style={styles.label}>Nội dung</Text>
            <TextInput
              style={styles.previewTextEditor}
              value={newFileContent}
              onChangeText={setNewFileContent}
              multiline
              numberOfLines={8}
              textAlignVertical="top"
              placeholder="Nhập nội dung ghi chú..."
              placeholderTextColor="#64748b"
            />
            <View style={[styles.rowGap, { marginTop: 14 }]}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => setCreateFileModalVisible(false)}
              >
                <Text style={styles.secondaryBtnText}>Hủy</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.primaryBtn, { flex: 1 }]}
                disabled={!newFileName.trim()}
                onPress={() => void handleCreateNewFile()}
              >
                <Text style={styles.primaryBtnText}>💾 Tạo & Lưu file</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const ANDROID_TOP_INSET =
  Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 36) + 12 : 14;
const ANDROID_BOTTOM_INSET = Platform.OS === 'android' ? 16 : 12;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#020617',
    paddingHorizontal: 16,
    paddingTop: ANDROID_TOP_INSET,
    paddingBottom: ANDROID_BOTTOM_INSET,
  },
  centered: {
    flex: 1,
    backgroundColor: '#020617',
    alignItems: 'center',
    justifyContent: 'center',
  },
  onboardingCard: {
    marginTop: 48,
    backgroundColor: '#0f172a',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  badge: {
    color: '#818cf8',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
  },
  title: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '800',
  },
  subtitle: {
    color: '#94a3b8',
    fontSize: 13,
    marginTop: 6,
    marginBottom: 16,
  },
  label: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#f8fafc',
    fontSize: 13,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  headerInfo: {
    flex: 1,
    marginRight: 10,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusBadgeOk: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderColor: 'rgba(16,185,129,0.35)',
  },
  statusBadgeWarn: {
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderColor: 'rgba(245,158,11,0.35)',
  },
  statusBadgeTextOk: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '700',
  },
  statusBadgeTextWarn: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '700',
  },
  headerSettingsBtn: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 13,
    alignItems: 'center',
    flexShrink: 0,
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 21,
    fontWeight: '800',
  },
  headerSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 3,
  },
  zonePillsBar: {
    marginBottom: 12,
  },
  zonePillsScroll: {
    gap: 8,
    paddingVertical: 2,
  },
  zonePill: {
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  zonePillActive: {
    backgroundColor: 'rgba(99,102,241,0.2)',
    borderColor: '#6366f1',
  },
  zonePillText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
  },
  zonePillTextActive: {
    color: '#e0e7ff',
    fontWeight: '700',
  },
  zonePillAdd: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  zonePillAddText: {
    color: '#c7d2fe',
    fontSize: 12,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#0f172a',
    borderRadius: 20,
    padding: 15,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 12,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  fileCountPill: {
    color: '#a5b4fc',
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: 'rgba(99,102,241,0.14)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  sectionLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  folderUri: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
  },
  rowGap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  primaryBtn: {
    backgroundColor: '#4f46e5',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  fullWidthPrimaryBtn: {
    width: '100%',
    backgroundColor: '#4f46e5',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
  },
  secondaryBtn: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#e2e8f0',
    fontWeight: '600',
    fontSize: 13,
  },
  googleBtn: {
    backgroundColor: '#f8fafc',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  googleBtnText: {
    color: '#0f172a',
    fontWeight: '700',
    fontSize: 13,
  },
  connectedBanner: {
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderColor: 'rgba(16,185,129,0.35)',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 4,
  },
  connectedText: {
    color: '#6ee7b7',
    fontSize: 12,
    fontWeight: '600',
  },
  statusBanner: {
    marginTop: 10,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  statusBannerInfo: {
    backgroundColor: 'rgba(99,102,241,0.1)',
    borderColor: 'rgba(99,102,241,0.3)',
  },
  statusBannerSuccess: {
    backgroundColor: 'rgba(16,185,129,0.1)',
    borderColor: 'rgba(16,185,129,0.3)',
  },
  statusBannerError: {
    backgroundColor: 'rgba(244,63,94,0.12)',
    borderColor: 'rgba(244,63,94,0.35)',
  },
  statusText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '500',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginTop: 6,
    marginBottom: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 8,
    color: '#f8fafc',
    fontSize: 13,
  },
  searchClearBtn: {
    padding: 4,
  },
  searchClearText: {
    color: '#94a3b8',
    fontSize: 13,
    fontWeight: '700',
  },
  progressWrap: {
    marginTop: 10,
    marginBottom: 2,
    gap: 6,
  },
  progressMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  progressText: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  progressPercent: {
    color: '#a5b4fc',
    fontSize: 11,
    fontWeight: '700',
  },
  progressPath: {
    color: '#64748b',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  progressTrack: {
    height: 8,
    width: '100%',
    borderRadius: 999,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#6366f1',
    borderRadius: 999,
  },
  emptyText: {
    color: '#64748b',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 24,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  fileIconBadge: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  fileIconText: {
    fontSize: 17,
  },
  fileName: {
    color: '#f1f5f9',
    fontSize: 13,
    fontWeight: '600',
  },
  fileMeta: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 999,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2,6,23,0.85)',
    justifyContent: 'center',
    padding: 16,
  },
  modalScroll: {
    maxHeight: '88%',
  },
  modalCard: {
    backgroundColor: '#0f172a',
    borderRadius: 22,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  modeOption: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 10,
  },
  modeOptionSelected: {
    borderColor: '#6366f1',
    backgroundColor: 'rgba(99,102,241,0.12)',
  },
  modeTitle: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 10,
  },
  explorerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  explorerActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  miniChipBtn: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  miniChipText: {
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: '600',
  },
  miniChipPrimary: {
    backgroundColor: 'rgba(99,102,241,0.2)',
    borderColor: '#6366f1',
  },
  miniChipPrimaryText: {
    color: '#c7d2fe',
    fontSize: 11,
    fontWeight: '700',
  },
  breadcrumbBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
    marginBottom: 6,
  },
  breadcrumbChip: {
    backgroundColor: '#1e293b',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  breadcrumbChipActive: {
    backgroundColor: 'rgba(99,102,241,0.2)',
  },
  breadcrumbText: {
    color: '#cbd5e1',
    fontSize: 11,
    fontWeight: '600',
  },
  breadcrumbSep: {
    color: '#64748b',
    fontSize: 11,
  },
  dirIconBadge: {
    backgroundColor: 'rgba(245,158,11,0.15)',
  },
  dirChevron: {
    color: '#94a3b8',
    fontSize: 20,
    fontWeight: '600',
    paddingHorizontal: 6,
  },
  fileMoreBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  fileMoreText: {
    color: '#94a3b8',
    fontSize: 18,
    fontWeight: '700',
  },
  previewImageWrap: {
    backgroundColor: '#020617',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 220,
    maxHeight: 380,
  },
  previewImage: {
    width: '100%',
    height: 300,
  },
  previewTextEditor: {
    backgroundColor: '#020617',
    borderColor: '#1e293b',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    color: '#f8fafc',
    fontSize: 13,
    minHeight: 180,
    maxHeight: 320,
  },
  dangerOutlineBtn: {
    backgroundColor: 'rgba(244,63,94,0.1)',
    borderColor: 'rgba(244,63,94,0.35)',
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 11,
    alignItems: 'center',
  },
  dangerSolidBtn: {
    backgroundColor: '#e11d48',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dangerBtnText: {
    color: '#fda4af',
    fontWeight: '700',
    fontSize: 13,
  },
});
