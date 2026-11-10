import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import {
  LIST_FILE_NAME,
  diffListFiles,
  parseListFile,
  serializeListFile,
  type FileIndexEntry,
  type ListFileDocument,
  type SwitchFolderMode,
  type SyncRunSummary,
} from '@foldersync/shared';
import {
  getValidMobileAccessToken,
  loadMobileConfig,
  saveMobileConfig,
  type MobileAppState,
} from '../storage/mobile-config';

const { StorageAccessFramework } = FileSystem;
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const WORKSPACE_FOLDER_NAME = '.FolderSync_Workspace';

function extractFileNameFromSafUri(uri: string): string {
  const decoded = decodeURIComponent(uri);
  const parts = decoded.split(/[/:]/);
  return parts[parts.length - 1] || 'unknown';
}

export async function pickAndSwitchAndroidSyncFolder(
  mode: SwitchFolderMode,
): Promise<{ updatedState: MobileAppState; copiedCount: number } | null> {
  const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!perm.granted) {
    return null;
  }

  const newDirUri = perm.directoryUri;
  const current = await loadMobileConfig();
  const prevDirUri = current.syncDirectoryUri;
  let copiedCount = 0;

  if (mode === 'COPY_EXISTING' && prevDirUri && prevDirUri !== newDirUri) {
    const childUris = await StorageAccessFramework.readDirectoryAsync(prevDirUri);
    for (const fileUri of childUris) {
      const name = extractFileNameFromSafUri(fileUri);
      if (name.startsWith('.sync_tmp')) continue;
      try {
        const base64Data = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const destUri = await StorageAccessFramework.createFileAsync(
          newDirUri,
          name,
          'application/octet-stream',
        );
        await FileSystem.writeAsStringAsync(destUri, base64Data, {
          encoding: FileSystem.EncodingType.Base64,
        });
        copiedCount += 1;
      } catch {
        // Skip subfolders/unreadable items if unsupported by flat SAF copy
      }
    }
  }

  const updatedState: MobileAppState = {
    ...current,
    syncDirectoryUri: newDirUri,
    baselineHashes: mode === 'POINT_ONLY' ? {} : current.baselineHashes,
    lastSyncedRevision: mode === 'POINT_ONLY' ? 0 : current.lastSyncedRevision,
  };

  await saveMobileConfig(updatedState);
  return { updatedState, copiedCount };
}

async function scanSafDirectoryEntriesRecursive(
  dirUri: string,
  prefix: string,
  uriMap: Map<string, string>,
  fileContentsB64: Map<string, string>,
): Promise<void> {
  let childUris: string[] = [];
  try {
    childUris = await StorageAccessFramework.readDirectoryAsync(dirUri);
  } catch {
    return;
  }

  for (const uri of childUris) {
    const name = extractFileNameFromSafUri(uri);
    if (
      !name ||
      name.startsWith('.sync_tmp') ||
      name.startsWith('.unsynced_local_backup') ||
      name === '.git'
    ) {
      continue;
    }

    const relPath = prefix ? `${prefix}/${name}` : name;

    if (relPath === LIST_FILE_NAME) {
      uriMap.set(relPath, uri);
      continue;
    }

    try {
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      uriMap.set(relPath, uri);
      fileContentsB64.set(relPath, b64);
    } catch {
      // On Android SAF, calling readAsStringAsync on a directory URI throws
      // "java.io.IOException: Function not implemented". Recurse into the subdirectory!
      await scanSafDirectoryEntriesRecursive(uri, relPath, uriMap, fileContentsB64);
    }
  }
}

export async function scanAndroidLocalFolder(
  directoryUri: string,
  deviceName: string,
): Promise<{ doc: ListFileDocument; uriMap: Map<string, string> }> {
  const uriMap = new Map<string, string>();
  const fileContentsB64 = new Map<string, string>();
  await scanSafDirectoryEntriesRecursive(directoryUri, '', uriMap, fileContentsB64);

  let existingDoc: ListFileDocument = {
    lastUpdatedAt: new Date(0).toISOString(),
    updatedByDevice: deviceName,
    revision: 0,
    entries: [],
  };

  const listFileUri = uriMap.get(LIST_FILE_NAME);
  if (listFileUri) {
    try {
      const md = await FileSystem.readAsStringAsync(listFileUri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      existingDoc = parseListFile(md);
    } catch {
      // Ignore parse error or unreadable list-file.md
    }
  }

  const prevMap = new Map<string, FileIndexEntry>();
  for (const e of existingDoc.entries) {
    prevMap.set(e.relativePath, e);
  }

  const nextEntries: FileIndexEntry[] = [];
  const seen = new Set<string>();

  for (const [name, base64Content] of fileContentsB64.entries()) {
    seen.add(name);
    const sha256 = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      base64Content,
    );
    const approxSize = Math.floor((base64Content.length * 3) / 4);
    const prev = prevMap.get(name);

    if (prev && prev.status === 'ACTIVE' && prev.sha256 === sha256) {
      nextEntries.push(prev);
    } else {
      nextEntries.push({
        relativePath: name,
        sha256,
        size: approxSize,
        modifiedAt: new Date().toISOString(),
        status: 'ACTIVE',
        updatedBy: deviceName,
        driveFileId: '-',
        syncedDevices: [deviceName],
      });
    }
  }

  const nowIso = new Date().toISOString();
  for (const [relPath, prev] of prevMap.entries()) {
    if (!seen.has(relPath)) {
      if (prev.status === 'ACTIVE') {
        if (prev.syncedDevices && !prev.syncedDevices.includes(deviceName)) {
          continue;
        }
        nextEntries.push({
          relativePath: relPath,
          sha256: '-',
          size: 0,
          modifiedAt: nowIso,
          status: 'DELETED',
          updatedBy: deviceName,
          driveFileId: '-',
        });
      } else {
        nextEntries.push(prev);
      }
    }
  }

  return {
    doc: {
      lastUpdatedAt: nowIso,
      updatedByDevice: deviceName,
      revision: existingDoc.revision,
      entries: nextEntries,
    },
    uriMap,
  };
}

async function ensureDriveWorkspace(state: MobileAppState): Promise<string> {
  if (state.googleAuth.driveRootFolderId) {
    return state.googleAuth.driveRootFolderId;
  }
  const token = state.googleAuth.accessToken;
  if (!token) throw new Error('Chưa đăng nhập tài khoản Google.');

  const q = `name = '${WORKSPACE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const searchRes = await fetch(
    `${DRIVE_FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const searchData = (await searchRes.json()) as { files?: Array<{ id: string }> };
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  const createRes = await fetch(DRIVE_FILES_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: WORKSPACE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const created = (await createRes.json()) as { id: string };
  return created.id;
}

async function uploadTextOrBase64ToDrive(
  token: string,
  fileName: string,
  mimeType: string,
  content: string,
  isBase64: boolean,
  parentFolderId: string,
  existingFileId?: string,
): Promise<string> {
  const boundary = `foldersync_rn_${Date.now()}`;
  const metadata = existingFileId ? { name: fileName } : { name: fileName, parents: [parentFolderId] };
  const transferHeader = isBase64 ? 'Content-Transfer-Encoding: base64\r\n' : '';
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
      metadata,
    )}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n${transferHeader}\r\n${content}\r\n--${boundary}--`;

  const url = existingFileId
    ? `${DRIVE_UPLOAD_API}/${existingFileId}?uploadType=multipart&fields=id`
    : `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id`;

  const res = await fetch(url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Upload Google Drive thất bại: ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function writeSafFile(
  directoryUri: string,
  uriMap: Map<string, string>,
  fileName: string,
  content: string,
  encoding: FileSystem.EncodingType,
): Promise<string> {
  let fileUri = uriMap.get(fileName);
  if (!fileUri) {
    fileUri = await StorageAccessFramework.createFileAsync(
      directoryUri,
      fileName,
      'application/octet-stream',
    );
    uriMap.set(fileName, fileUri);
  }
  await FileSystem.writeAsStringAsync(fileUri, content, { encoding });
  return fileUri;
}

export async function runAndroidSyncNow(reason = 'MANUAL'): Promise<{
  summary: SyncRunSummary;
  document: ListFileDocument;
}> {
  const initialState = await loadMobileConfig();
  if (!initialState.syncDirectoryUri) {
    throw new Error('Chưa chọn thư mục đồng bộ trên điện thoại.');
  }
  const syncDirectoryUri = initialState.syncDirectoryUri;
  const { token, updatedState: state } = await getValidMobileAccessToken(initialState);

  const rootFolderId = await ensureDriveWorkspace(state);
  const { doc: localDoc, uriMap } = await scanAndroidLocalFolder(
    syncDirectoryUri,
    state.deviceName,
  );

  // Locate list-file.md on Google Drive
  let listFileId = state.googleAuth.listFileDriveId;
  if (!listFileId) {
    const q = `name = '${LIST_FILE_NAME}' and '${rootFolderId}' in parents and trashed = false`;
    const searchRes = await fetch(
      `${DRIVE_FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const searchData = (await searchRes.json()) as { files?: Array<{ id: string }> };
    listFileId = searchData.files?.[0]?.id ?? null;
  }

  let remoteDoc: ListFileDocument = {
    lastUpdatedAt: new Date(0).toISOString(),
    updatedByDevice: 'None',
    revision: 0,
    entries: [],
  };

  if (listFileId) {
    const res = await fetch(`${DRIVE_FILES_API}/${listFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      remoteDoc = parseListFile(await res.text());
    }
  }

  const knownDevicesSet = new Set<string>(remoteDoc.knownDevices ?? []);
  if (
    remoteDoc.updatedByDevice &&
    remoteDoc.updatedByDevice !== 'None' &&
    remoteDoc.updatedByDevice !== 'Unknown'
  ) {
    knownDevicesSet.add(remoteDoc.updatedByDevice);
  }
  const newDeviceJoined = !knownDevicesSet.has(state.deviceName);
  knownDevicesSet.add(state.deviceName);
  const knownDevices = [...knownDevicesSet].sort((a, b) => a.localeCompare(b));

  const localActiveMap = new Map<string, FileIndexEntry>();
  for (const e of localDoc.entries) {
    if (e.status === 'ACTIVE') localActiveMap.set(e.relativePath, e);
  }

  const diff = diffListFiles(localDoc.entries, remoteDoc, state.baselineHashes);
  const finalMap = new Map<string, FileIndexEntry>();
  for (const e of remoteDoc.entries) {
    const localMatch = localActiveMap.get(e.relativePath);
    if (e.status === 'ACTIVE' && localMatch && localMatch.sha256 === e.sha256) {
      finalMap.set(e.relativePath, {
        ...e,
        syncedDevices: Array.from(
          new Set([...(e.syncedDevices ?? [e.updatedBy]), state.deviceName]),
        ),
      });
    } else if (e.status === 'DELETED' && !localMatch) {
      finalMap.set(e.relativePath, {
        ...e,
        syncedDevices: Array.from(
          new Set([...(e.syncedDevices ?? [e.updatedBy]), state.deviceName]),
        ),
      });
    } else {
      finalMap.set(e.relativePath, e);
    }
  }

  let uploadedCount = 0;
  let downloadedCount = 0;
  let deletedLocallyCount = 0;
  let markedDeletedRemotelyCount = 0;
  let conflictsCount = 0;
  let requestedReuploadCount = 0;
  let relayPurgedCount = 0;

  // Download missing/updated files to Android folder (or request re-upload if relay already purged)
  for (const rem of diff.toDownload) {
    if (!rem.driveFileId || rem.driveFileId === '-') {
      finalMap.set(rem.relativePath, {
        ...rem,
        syncedDevices: (rem.syncedDevices ?? [rem.updatedBy]).filter((d) => d !== state.deviceName),
        requestUpload: true,
      });
      requestedReuploadCount += 1;
      continue;
    }

    const tmpLocal = `${FileSystem.cacheDirectory ?? ''}dl_${Date.now()}`;
    const dlRes = await FileSystem.downloadAsync(
      `${DRIVE_FILES_API}/${rem.driveFileId}?alt=media`,
      tmpLocal,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const b64 = await FileSystem.readAsStringAsync(dlRes.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const flatName = rem.relativePath.replace(/\//g, '__');
    await writeSafFile(
      syncDirectoryUri,
      uriMap,
      flatName,
      b64,
      FileSystem.EncodingType.Base64,
    );
    await FileSystem.deleteAsync(dlRes.uri, { idempotent: true });
    finalMap.set(rem.relativePath, {
      ...rem,
      syncedDevices: Array.from(
        new Set([...(rem.syncedDevices ?? [rem.updatedBy]), state.deviceName]),
      ),
      requestUpload: false,
    });
    downloadedCount += 1;
  }

  // Delete locally when marked DELETED in list-file.md
  for (const remDel of diff.toDeleteLocally) {
    const existingUri = uriMap.get(remDel.relativePath);
    if (existingUri) {
      await StorageAccessFramework.deleteAsync(existingUri, { idempotent: true });
      uriMap.delete(remDel.relativePath);
    }
    finalMap.set(remDel.relativePath, {
      ...remDel,
      syncedDevices: Array.from(
        new Set([...(remDel.syncedDevices ?? [remDel.updatedBy]), state.deviceName]),
      ),
    });
    deletedLocallyCount += 1;
  }

  // Upload new/edited files from Android to Google Drive
  for (const loc of diff.toUpload) {
    const fileUri = uriMap.get(loc.relativePath);
    if (!fileUri) continue;
    const b64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const prevRemote = finalMap.get(loc.relativePath);
    const driveId = await uploadTextOrBase64ToDrive(
      token,
      loc.relativePath.replace(/\//g, '__'),
      'application/octet-stream',
      b64,
      true,
      rootFolderId,
      prevRemote?.driveFileId !== '-' ? prevRemote?.driveFileId : undefined,
    );
    finalMap.set(loc.relativePath, {
      ...loc,
      updatedBy: state.deviceName,
      driveFileId: driveId,
      syncedDevices: [state.deviceName],
      requestUpload: false,
    });
    uploadedCount += 1;
  }

  // Fulfill relay re-upload requests if Android holds the file locally
  for (const entry of finalMap.values()) {
    if (
      entry.status === 'ACTIVE' &&
      (!entry.driveFileId || entry.driveFileId === '-') &&
      entry.requestUpload
    ) {
      const localMatch = localActiveMap.get(entry.relativePath);
      const fileUri = uriMap.get(entry.relativePath);
      if (localMatch && localMatch.sha256 === entry.sha256 && fileUri) {
        const b64 = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const driveId = await uploadTextOrBase64ToDrive(
          token,
          entry.relativePath.replace(/\//g, '__'),
          'application/octet-stream',
          b64,
          true,
          rootFolderId,
        );
        finalMap.set(entry.relativePath, {
          ...entry,
          driveFileId: driveId,
          syncedDevices: Array.from(new Set([...(entry.syncedDevices ?? []), state.deviceName])),
          requestUpload: false,
        });
        uploadedCount += 1;
      }
    }
  }

  // Handle conflicts safely (.conflict-<device>)
  for (const conf of diff.conflicts) {
    conflictsCount += 1;
    const fileUri = uriMap.get(conf.relativePath);
    if (fileUri) {
      const b64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const backupName = `${conf.relativePath}.conflict-${state.deviceName}`;
      await writeSafFile(
        syncDirectoryUri,
        uriMap,
        backupName,
        b64,
        FileSystem.EncodingType.Base64,
      );
    }
  }

  // Propagate local deletions
  for (const locDel of diff.toMarkDeletedRemotely) {
    const prevRemote = finalMap.get(locDel.relativePath);
    if (prevRemote?.driveFileId && prevRemote.driveFileId !== '-') {
      await fetch(`${DRIVE_FILES_API}/${prevRemote.driveFileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    finalMap.set(locDel.relativePath, {
      ...locDel,
      status: 'DELETED',
      sha256: '-',
      size: 0,
      driveFileId: '-',
      syncedDevices: [state.deviceName],
      requestUpload: false,
      updatedBy: state.deviceName,
    });
    markedDeletedRemotelyCount += 1;
  }

  // Ephemeral Relay Auto-Purge & DELETED Tombstone Cleanup once all knownDevices (>= 2) have synced
  if (knownDevices.length >= 2) {
    for (const entry of [...finalMap.values()]) {
      const syncedList = entry.syncedDevices ?? [entry.updatedBy];
      const allKnownSynced = knownDevices.every((dev) => syncedList.includes(dev));
      if (!allKnownSynced) {
        continue;
      }

      if (entry.status === 'DELETED') {
        finalMap.delete(entry.relativePath);
        relayPurgedCount += 1;
        continue;
      }

      if (
        entry.status === 'ACTIVE' &&
        entry.driveFileId &&
        entry.driveFileId !== '-' &&
        !entry.requestUpload
      ) {
        await fetch(`${DRIVE_FILES_API}/${entry.driveFileId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => undefined);
        finalMap.set(entry.relativePath, {
          ...entry,
          driveFileId: '-',
          syncedDevices: syncedList,
          requestUpload: false,
        });
        relayPurgedCount += 1;
      }
    }
  }

  const pushed =
    uploadedCount > 0 ||
    markedDeletedRemotelyCount > 0 ||
    conflictsCount > 0 ||
    requestedReuploadCount > 0;
  const shouldWriteRemote =
    pushed || relayPurgedCount > 0 || newDeviceJoined || (!listFileId && finalMap.size > 0);
  const nowIso = new Date().toISOString();
  const nextRev = pushed ? remoteDoc.revision + 1 : remoteDoc.revision;

  const finalDoc: ListFileDocument = {
    lastUpdatedAt: pushed || relayPurgedCount > 0 ? nowIso : remoteDoc.lastUpdatedAt,
    updatedByDevice: pushed ? state.deviceName : remoteDoc.updatedByDevice,
    revision: nextRev,
    knownDevices,
    entries: [...finalMap.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };

  const serializedMd = serializeListFile(finalDoc);

  if (shouldWriteRemote) {
    listFileId = await uploadTextOrBase64ToDrive(
      token,
      LIST_FILE_NAME,
      'text/markdown',
      serializedMd,
      false,
      rootFolderId,
      listFileId ?? undefined,
    );

    if (state.telegramBot.enabled && state.telegramBot.botToken && state.telegramBot.chatId) {
      await fetch(`https://api.telegram.org/bot${state.telegramBot.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: state.telegramBot.chatId,
          text: `🔄 [FolderSync Rev #${nextRev} | By: ${state.deviceName}]\n✅ Điện thoại Android vừa đẩy lên ${uploadedCount} file, xóa ${markedDeletedRemotelyCount} file.`,
        }),
      }).catch(() => undefined);
    }
  }

  await writeSafFile(
    syncDirectoryUri,
    uriMap,
    LIST_FILE_NAME,
    serializedMd,
    FileSystem.EncodingType.UTF8,
  );

  const nextBaseline: Record<string, string> = {};
  for (const e of finalDoc.entries) {
    const hasFileLocally = !e.syncedDevices || e.syncedDevices.includes(state.deviceName);
    if (e.status === 'ACTIVE' && e.sha256 !== '-' && hasFileLocally) {
      nextBaseline[e.relativePath] = e.sha256;
    }
  }

  await saveMobileConfig({
    ...state,
    lastSyncedRevision: nextRev,
    lastSyncedAt: nowIso,
    baselineHashes: nextBaseline,
    googleAuth: {
      ...state.googleAuth,
      driveRootFolderId: rootFolderId,
      listFileDriveId: listFileId,
    },
  });

  return {
    summary: {
      reason,
      uploadedCount,
      downloadedCount,
      deletedLocallyCount,
      markedDeletedRemotelyCount,
      conflictsCount,
      revision: nextRev,
      completedAt: nowIso,
    },
    document: finalDoc,
  };
}
