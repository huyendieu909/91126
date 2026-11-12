import {
  DEFAULT_ZONE_ID,
  DEFAULT_ZONE_NAME,
  LIST_FILE_NAME,
  ZONES_REGISTRY_FILE_NAME,
  diffListFiles,
  parseListFile,
  parseZonesRegistry,
  serializeListFile,
  serializeZonesRegistry,
  slugifyZoneId,
  type FileIndexEntry,
  type ListFileDocument,
  type LocalZoneBinding,
  type SwitchFolderMode,
  type SyncRunSummary,
  type ZonesRegistryDocument,
} from '@foldersync/shared';
import {
  getValidMobileAccessToken,
  loadMobileConfig,
  saveMobileConfig,
  type MobileAppState,
} from '../storage/mobile-config';
import {
  base64ToUint8Array,
  computeSha256HexFromBase64,
  copyDirectoryFilesFlat,
  deletePlatformFile,
  downloadUrlAsBase64,
  readPlatformFileBase64,
  requestSyncDirectoryUri,
  scanPlatformDirectory,
  writePlatformFile,
} from '../storage/platform-fs';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const WORKSPACE_FOLDER_NAME = '.FolderSync_Workspace';

export async function pickAndSwitchAndroidSyncFolder(
  mode: SwitchFolderMode,
): Promise<{ updatedState: MobileAppState; copiedCount: number } | null> {
  const newDirUri = await requestSyncDirectoryUri();
  if (!newDirUri) {
    return null;
  }

  const current = await loadMobileConfig();
  const prevDirUri = current.syncDirectoryUri;
  let copiedCount = 0;

  if (mode === 'COPY_EXISTING' && prevDirUri && prevDirUri !== newDirUri) {
    copiedCount = await copyDirectoryFilesFlat(prevDirUri, newDirUri);
  }

  const activeZoneId = current.activeZoneId || DEFAULT_ZONE_ID;
  const nextZones = [...(current.zones ?? [])];
  const zIdx = nextZones.findIndex((z) => z.zoneId === activeZoneId);
  if (zIdx >= 0) {
    nextZones[zIdx] = {
      ...nextZones[zIdx],
      joined: true,
      localFolderPath: newDirUri,
      lastSyncedRevision: mode === 'POINT_ONLY' ? 0 : nextZones[zIdx].lastSyncedRevision,
    };
  } else {
    nextZones.push({
      zoneId: activeZoneId,
      zoneName: activeZoneId === DEFAULT_ZONE_ID ? DEFAULT_ZONE_NAME : activeZoneId,
      joined: true,
      localFolderPath: newDirUri,
      driveFolderId: current.googleAuth.driveRootFolderId,
      listFileDriveId: current.googleAuth.listFileDriveId,
      lastSyncedRevision: 0,
      lastSyncedAt: null,
      memberDevices: [current.deviceName],
    });
  }

  const updatedState: MobileAppState = {
    ...current,
    syncDirectoryUri: newDirUri,
    zones: nextZones,
    baselineHashes: mode === 'POINT_ONLY' ? {} : current.baselineHashes,
    lastSyncedRevision: mode === 'POINT_ONLY' ? 0 : current.lastSyncedRevision,
  };

  await saveMobileConfig(updatedState);
  return { updatedState, copiedCount };
}

export async function scanAndroidLocalFolder(
  directoryUri: string,
  deviceName: string,
): Promise<{ doc: ListFileDocument; uriMap: Map<string, string> }> {
  const { uriMap, fileContentsB64, listFileMarkdown } =
    await scanPlatformDirectory(directoryUri);

  let existingDoc: ListFileDocument = {
    lastUpdatedAt: new Date(0).toISOString(),
    updatedByDevice: deviceName,
    revision: 0,
    entries: [],
  };

  if (listFileMarkdown) {
    try {
      existingDoc = parseListFile(listFileMarkdown);
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
    const sha256 = await computeSha256HexFromBase64(base64Content);
    const exactSize = base64ToUint8Array(base64Content).byteLength;
    const prev = prevMap.get(name);

    if (prev && prev.status === 'ACTIVE' && prev.sha256 === sha256) {
      nextEntries.push(prev);
    } else {
      nextEntries.push({
        relativePath: name,
        sha256,
        size: exactSize,
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

async function ensureZoneDriveFolder(
  token: string,
  rootFolderId: string,
  zoneId: string,
  zoneName: string,
): Promise<string> {
  if (!zoneId || zoneId === DEFAULT_ZONE_ID) {
    return rootFolderId;
  }
  const folderDisplayName = `Zone_${zoneId}`;
  const q = `name = '${folderDisplayName}' and '${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
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
      name: folderDisplayName,
      description: zoneName,
      parents: [rootFolderId],
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const created = (await createRes.json()) as { id: string };
  return created.id;
}

async function readDriveZonesRegistry(
  token: string,
  rootFolderId: string,
): Promise<{ doc: ZonesRegistryDocument; fileId: string | null }> {
  const q = `name = '${ZONES_REGISTRY_FILE_NAME}' and '${rootFolderId}' in parents and trashed = false`;
  const searchRes = await fetch(
    `${DRIVE_FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const searchData = (await searchRes.json()) as { files?: Array<{ id: string }> };
  const fileId = searchData.files?.[0]?.id ?? null;
  if (!fileId) {
    return { doc: { updatedAt: new Date(0).toISOString(), zones: [] }, fileId: null };
  }
  const res = await fetch(`${DRIVE_FILES_API}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { doc: { updatedAt: new Date(0).toISOString(), zones: [] }, fileId };
  }
  return { doc: parseZonesRegistry(await res.text()), fileId };
}

export async function discoverAndroidZones(): Promise<MobileAppState> {
  const initialState = await loadMobileConfig();
  const { token, updatedState: state } = await getValidMobileAccessToken(initialState);
  const rootFolderId = await ensureDriveWorkspace(state);
  const { doc: reg } = await readDriveZonesRegistry(token, rootFolderId);

  const localMap = new Map<string, LocalZoneBinding>();
  for (const z of state.zones ?? []) {
    localMap.set(z.zoneId, { ...z });
  }

  for (const rz of reg.zones) {
    const existing = localMap.get(rz.zoneId);
    if (existing) {
      localMap.set(rz.zoneId, {
        ...existing,
        zoneName: rz.zoneName || existing.zoneName,
        description: rz.description ?? existing.description,
        driveFolderId: rz.driveFolderId || existing.driveFolderId,
        listFileDriveId: rz.listFileDriveId ?? existing.listFileDriveId,
        memberDevices: rz.memberDevices,
      });
    } else {
      localMap.set(rz.zoneId, {
        zoneId: rz.zoneId,
        zoneName: rz.zoneName,
        description: rz.description,
        joined: false,
        localFolderPath: null,
        driveFolderId: rz.driveFolderId,
        listFileDriveId: rz.listFileDriveId,
        lastSyncedRevision: 0,
        lastSyncedAt: null,
        memberDevices: rz.memberDevices,
      });
    }
  }

  const nextState: MobileAppState = {
    ...state,
    zones: [...localMap.values()],
  };
  await saveMobileConfig(nextState);
  return nextState;
}

export async function joinOrCreateAndroidZone(params: {
  zoneId?: string;
  zoneName: string;
  description?: string;
}): Promise<MobileAppState | null> {
  const folderUri = await requestSyncDirectoryUri(params.zoneName);
  if (!folderUri) {
    return null;
  }
  const initialState = await loadMobileConfig();
  const zoneId = params.zoneId || slugifyZoneId(params.zoneName);
  let driveFolderId: string | null = null;

  try {
    const { token, updatedState: state } = await getValidMobileAccessToken(initialState);
    const rootFolderId = await ensureDriveWorkspace(state);
    driveFolderId = await ensureZoneDriveFolder(token, rootFolderId, zoneId, params.zoneName);
    const { doc: reg, fileId: regFileId } = await readDriveZonesRegistry(token, rootFolderId);
    const idx = reg.zones.findIndex((z) => z.zoneId === zoneId);
    if (idx >= 0) {
      reg.zones[idx].memberDevices = Array.from(
        new Set([...reg.zones[idx].memberDevices, state.deviceName]),
      );
    } else {
      reg.zones.push({
        zoneId,
        zoneName: params.zoneName,
        description: params.description,
        driveFolderId,
        listFileDriveId: null,
        createdAt: new Date().toISOString(),
        createdBy: state.deviceName,
        memberDevices: [state.deviceName],
      });
    }
    reg.updatedAt = new Date().toISOString();
    await uploadTextOrBase64ToDrive(
      token,
      ZONES_REGISTRY_FILE_NAME,
      'application/json',
      serializeZonesRegistry(reg),
      false,
      rootFolderId,
      regFileId ?? undefined,
    );
  } catch {
    // Allow local zone binding even if offline
  }

  const latest = await loadMobileConfig();
  const existing = (latest.zones ?? []).find((z) => z.zoneId === zoneId);
  const binding: LocalZoneBinding = {
    zoneId,
    zoneName: params.zoneName,
    description: params.description ?? existing?.description,
    joined: true,
    localFolderPath: folderUri,
    driveFolderId: driveFolderId ?? existing?.driveFolderId ?? null,
    listFileDriveId: existing?.listFileDriveId ?? null,
    lastSyncedRevision: 0,
    lastSyncedAt: null,
    memberDevices: Array.from(new Set([...(existing?.memberDevices ?? []), latest.deviceName])),
  };

  const nextZones = [...(latest.zones ?? []).filter((z) => z.zoneId !== zoneId), binding];
  const updatedState: MobileAppState = {
    ...latest,
    activeZoneId: zoneId,
    syncDirectoryUri: folderUri,
    lastSyncedRevision: 0,
    zones: nextZones,
  };
  await saveMobileConfig(updatedState);
  return updatedState;
}

export async function activateAndroidZone(zoneId: string): Promise<MobileAppState> {
  const current = await loadMobileConfig();
  const target = (current.zones ?? []).find((z) => z.zoneId === zoneId && z.joined);
  if (!target || !target.localFolderPath) {
    throw new Error('Vùng này chưa được chọn thư mục trên điện thoại.');
  }
  const updated: MobileAppState = {
    ...current,
    activeZoneId: zoneId,
    syncDirectoryUri: target.localFolderPath,
    lastSyncedRevision: target.lastSyncedRevision,
    lastSyncedAt: target.lastSyncedAt,
  };
  await saveMobileConfig(updated);
  return updated;
}

export async function leaveAndroidZone(zoneId: string): Promise<MobileAppState> {
  const current = await loadMobileConfig();
  const nextZones = (current.zones ?? []).map((z) =>
    z.zoneId === zoneId
      ? {
          ...z,
          joined: false,
          memberDevices: (z.memberDevices ?? []).filter((d) => d !== current.deviceName),
        }
      : z,
  );
  const fallback = nextZones.find((z) => z.joined && z.localFolderPath);
  const updated: MobileAppState = {
    ...current,
    activeZoneId:
      current.activeZoneId === zoneId
        ? (fallback?.zoneId ?? DEFAULT_ZONE_ID)
        : current.activeZoneId,
    syncDirectoryUri:
      current.activeZoneId === zoneId
        ? (fallback?.localFolderPath ?? null)
        : current.syncDirectoryUri,
    zones: nextZones,
  };
  await saveMobileConfig(updated);
  return updated;
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
  const activeZoneId = initialState.activeZoneId || DEFAULT_ZONE_ID;
  const { token, updatedState: state } = await getValidMobileAccessToken(initialState);

  const rootFolderId = await ensureDriveWorkspace(state);
  const activeZoneObj = (state.zones ?? []).find((z) => z.zoneId === activeZoneId);
  const targetZoneFolderId = await ensureZoneDriveFolder(
    token,
    rootFolderId,
    activeZoneId,
    activeZoneObj?.zoneName || DEFAULT_ZONE_NAME,
  );
  const { doc: localDoc, uriMap } = await scanAndroidLocalFolder(
    syncDirectoryUri,
    state.deviceName,
  );

  // Locate list-file.md on Google Drive for the active zone
  let listFileId =
    activeZoneId === DEFAULT_ZONE_ID
      ? state.googleAuth.listFileDriveId
      : (activeZoneObj?.listFileDriveId ?? null);
  if (!listFileId) {
    const q = `name = '${LIST_FILE_NAME}' and '${targetZoneFolderId}' in parents and trashed = false`;
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

  const zoneBaseline = state.zoneBaselines?.[activeZoneId] ?? state.baselineHashes;
  const diff = diffListFiles(localDoc.entries, remoteDoc, zoneBaseline);
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

    const b64 = await downloadUrlAsBase64(
      `${DRIVE_FILES_API}/${rem.driveFileId}?alt=media`,
      { Authorization: `Bearer ${token}` },
    );
    await writePlatformFile(syncDirectoryUri, uriMap, rem.relativePath, b64, true);
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
      await deletePlatformFile(syncDirectoryUri, existingUri, remDel.relativePath);
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
    const b64 = await readPlatformFileBase64(syncDirectoryUri, fileUri, loc.relativePath);
    const prevRemote = finalMap.get(loc.relativePath);
    const driveId = await uploadTextOrBase64ToDrive(
      token,
      loc.relativePath.replace(/\//g, '__'),
      'application/octet-stream',
      b64,
      true,
      targetZoneFolderId,
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
        const b64 = await readPlatformFileBase64(syncDirectoryUri, fileUri, entry.relativePath);
        const driveId = await uploadTextOrBase64ToDrive(
          token,
          entry.relativePath.replace(/\//g, '__'),
          'application/octet-stream',
          b64,
          true,
          targetZoneFolderId,
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
      const b64 = await readPlatformFileBase64(syncDirectoryUri, fileUri, conf.relativePath);
      const backupName = `${conf.relativePath}.conflict-${state.deviceName}`;
      await writePlatformFile(syncDirectoryUri, uriMap, backupName, b64, true);
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
      targetZoneFolderId,
      listFileId ?? undefined,
    );
  }

  const hasOutbound =
    uploadedCount > 0 || markedDeletedRemotelyCount > 0 || conflictsCount > 0;
  const hasInbound = downloadedCount > 0 || deletedLocallyCount > 0;

  if (
    (hasOutbound || hasInbound) &&
    state.telegramBot.enabled &&
    state.telegramBot.botToken &&
    state.telegramBot.chatId
  ) {
    const zoneLabel = activeZoneObj?.zoneName || activeZoneId;
    const lines: string[] = [
      hasOutbound
        ? `🔄 [FolderSync Rev #${nextRev} | By: ${state.deviceName}]`
        : `📥 [FolderSync Synced #${nextRev} | On: ${state.deviceName}]`,
      `🌐 Vùng đồng bộ: ${zoneLabel}`,
    ];
    if (uploadedCount > 0) {
      lines.push(`✅ Đã đẩy lên: ${uploadedCount} file`);
    }
    if (downloadedCount > 0) {
      lines.push(`📥 Đã tải về điện thoại: ${downloadedCount} file`);
    }
    if (markedDeletedRemotelyCount > 0) {
      lines.push(`🗑️ Đã xóa: ${markedDeletedRemotelyCount} file`);
    }
    if (deletedLocallyCount > 0) {
      lines.push(`🧹 Đã dọn file bị xóa từ xa: ${deletedLocallyCount} file`);
    }
    if (conflictsCount > 0) {
      lines.push(`⚠️ Xung đột (đã tách bản sao): ${conflictsCount} file`);
    }
    if (hasOutbound) {
      lines.push(`📱 Các thiết bị khác có thể kiểm tra list-file.md để đồng bộ ngay!`);
    }

    try {
      const teleRes = await fetch(
        `https://api.telegram.org/bot${state.telegramBot.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: state.telegramBot.chatId,
            text: lines.join('\n'),
          }),
        },
      );
      if (!teleRes.ok) {
        console.warn('[FolderSync][Telegram] Gửi thông báo thất bại:', await teleRes.text());
      }
    } catch (teleErr) {
      console.warn('[FolderSync][Telegram] Lỗi kết nối Telegram:', teleErr);
    }
  }

  await writePlatformFile(syncDirectoryUri, uriMap, LIST_FILE_NAME, serializedMd, false);

  const nextBaseline: Record<string, string> = {};
  for (const e of finalDoc.entries) {
    const hasFileLocally = !e.syncedDevices || e.syncedDevices.includes(state.deviceName);
    if (e.status === 'ACTIVE' && e.sha256 !== '-' && hasFileLocally) {
      nextBaseline[e.relativePath] = e.sha256;
    }
  }

  const updatedZones = (state.zones ?? []).map((z) =>
    z.zoneId === activeZoneId
      ? {
          ...z,
          driveFolderId: targetZoneFolderId,
          listFileDriveId: listFileId,
          lastSyncedRevision: nextRev,
          lastSyncedAt: nowIso,
          memberDevices: knownDevices,
        }
      : z,
  );

  await saveMobileConfig({
    ...state,
    lastSyncedRevision: nextRev,
    lastSyncedAt: nowIso,
    baselineHashes: nextBaseline,
    zoneBaselines: {
      ...(state.zoneBaselines ?? {}),
      [activeZoneId]: nextBaseline,
    },
    zones: updatedZones,
    googleAuth: {
      ...state.googleAuth,
      driveRootFolderId: rootFolderId,
      listFileDriveId:
        activeZoneId === DEFAULT_ZONE_ID ? listFileId : state.googleAuth.listFileDriveId,
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
