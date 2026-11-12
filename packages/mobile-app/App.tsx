import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
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
import type { FileIndexEntry, ListFileDocument, SwitchFolderMode } from '@foldersync/shared';
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

export default function App() {
  const [state, setState] = useState<MobileAppState | null>(null);
  const [doc, setDoc] = useState<ListFileDocument | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [switchModalVisible, setSwitchModalVisible] = useState(false);
  const [switchMode, setSwitchMode] = useState<SwitchFolderMode>('POINT_ONLY');
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [zonesModalVisible, setZonesModalVisible] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [standaloneCodeInput, setStandaloneCodeInput] = useState('');
  const [showStandaloneBox, setShowStandaloneBox] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);

  const reloadLocalState = useCallback(async () => {
    try {
      const loaded = await loadMobileConfig();
      setState(loaded);
      if (loaded.syncDirectoryUri) {
        const scanned = await scanAndroidLocalFolder(loaded.syncDirectoryUri, loaded.deviceName);
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

  // Auto-sync when user opens app from background (e.g., after tapping Telegram notification)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextAppState) => {
      if (
        nextAppState === 'active' &&
        state?.syncDirectoryUri &&
        (state?.googleAuth.accessToken || state?.googleAuth.refreshToken)
      ) {
        void handleSyncNow('APP_FOREGROUND');
      }
    });
    return () => sub.remove();
  });

  const handleSyncNow = async (reason = 'MANUAL') => {
    setSyncing(true);
    setStatusMessage('⏳ Đang kiểm tra list-file.md và đồng bộ...');
    try {
      const res = await runAndroidSyncNow(reason);
      setDoc(res.document);
      const fresh = await loadMobileConfig();
      setState(fresh);
      setStatusMessage(
        `✅ Đồng bộ xong Rev #${res.summary.revision} (Tải về: ${res.summary.downloadedCount}, Đẩy lên: ${res.summary.uploadedCount}, Xung đột: ${res.summary.conflictsCount})`,
      );
    } catch (err) {
      setStatusMessage(`❌ ${err instanceof Error ? err.message : 'Lỗi đồng bộ'}`);
    } finally {
      setSyncing(false);
    }
  };

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
    try {
      const picked = await pickAndSwitchAndroidSyncFolder('POINT_ONLY');
      if (picked) {
        setState(picked.updatedState);
        await reloadLocalState();
      }
    } catch (err) {
      setStatusMessage(`❌ Lỗi chọn thư mục: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleConfirmSwitchFolder = async () => {
    setSwitchModalVisible(false);
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
  const isGoogleConnected = Boolean(
    state.googleAuth.accessToken || state.googleAuth.refreshToken,
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerInfo}>
          <Text style={styles.headerTitle}>FolderSync</Text>
          <Text style={styles.headerSub} numberOfLines={2}>
            📱 {state.deviceName} · Rev #{doc?.revision ?? state.lastSyncedRevision} ·{' '}
            {isGoogleConnected ? `☁️ ${state.googleAuth.email || 'Đã kết nối'}` : '⚠️ Chưa kết nối'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.headerSettingsBtn}
          onPress={() => setSettingsModalVisible(true)}
        >
          <Text style={styles.secondaryBtnText}>⚙️ Cài đặt</Text>
        </TouchableOpacity>
      </View>

      {/* Current Folder & Sync Trigger Card */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>
          VÙNG ĐỒNG BỘ HIỆN TẠI: {state.activeZoneId || 'default-zone'}
        </Text>
        <Text style={styles.folderUri} numberOfLines={2}>
          {decodeURIComponent(state.syncDirectoryUri)}
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

        <View style={styles.rowGap}>
          <TouchableOpacity
            style={[styles.secondaryBtn, { flex: 1 }]}
            onPress={() => setZonesModalVisible(true)}
          >
            <Text style={styles.secondaryBtnText}>🌐 Vùng Sync</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryBtn, { flex: 1 }]}
            onPress={() => setSwitchModalVisible(true)}
          >
            <Text style={styles.secondaryBtnText}>📂 Đổi thư mục</Text>
          </TouchableOpacity>
        </View>

        {statusMessage ? <Text style={styles.statusText}>{statusMessage}</Text> : null}
      </View>

      {/* list-file.md FlatList */}
      <View style={[styles.card, { flex: 1 }]}>
        <Text style={styles.sectionLabel}>
          DANH SÁCH FILE TRONG LIST-FILE.MD ({activeEntries.length} FILE)
        </Text>
        <FlatList
          data={activeEntries}
          keyExtractor={(item) => item.relativePath}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              Chưa có file nào trong thư mục. Hãy bấm "Đồng bộ ngay" để kéo file từ trạm trung chuyển về!
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.fileRow}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={styles.fileName}>{item.relativePath}</Text>
                <Text style={styles.fileMeta}>
                  Hash: {item.sha256.slice(0, 10)}... · Bởi: {item.updatedBy}
                </Text>
              </View>
              <Text style={styles.fileSize}>{item.size} B</Text>
            </View>
          )}
        />
      </View>

      {/* Multi-Zone Sync Network Modal */}
      <Modal visible={zonesModalVisible} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalCard}>
            <Text style={styles.modalTitle}>🌐 Mạng Lưới Vùng Đồng Bộ</Text>
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
                            const updated = await joinOrCreateAndroidZone({
                              zoneId: z.zoneId,
                              zoneName: z.zoneName,
                              description: z.description,
                            });
                            if (updated) {
                              setState(updated);
                              await reloadLocalState();
                              setZonesModalVisible(false);
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
                  const updated = await joinOrCreateAndroidZone({ zoneName: name });
                  if (updated) {
                    setNewZoneName('');
                    setState(updated);
                    await reloadLocalState();
                    setZonesModalVisible(false);
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
            <Text style={styles.modalTitle}>Cài Đặt Google & Telegram</Text>

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
    marginBottom: 14,
  },
  headerInfo: {
    flex: 1,
    marginRight: 10,
  },
  headerSettingsBtn: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    flexShrink: 0,
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '800',
  },
  headerSub: {
    color: '#94a3b8',
    fontSize: 11,
    marginTop: 2,
  },
  card: {
    backgroundColor: '#0f172a',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1e293b',
    marginBottom: 14,
  },
  sectionLabel: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  folderUri: {
    color: '#f8fafc',
    fontSize: 13,
    fontFamily: 'monospace',
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
  statusText: {
    color: '#a5b4fc',
    fontSize: 12,
    marginTop: 10,
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
  fileName: {
    color: '#f1f5f9',
    fontSize: 13,
    fontWeight: '600',
  },
  fileMeta: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 2,
  },
  fileSize: {
    color: '#94a3b8',
    fontSize: 12,
    marginLeft: 8,
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
});
