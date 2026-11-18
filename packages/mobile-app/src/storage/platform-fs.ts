import { Linking, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import * as IntentLauncher from 'expo-intent-launcher';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { LIST_FILE_NAME } from '@foldersync/shared';

const { StorageAccessFramework } = FileSystem;

const WEB_CONFIG_STORAGE_KEY = 'foldersync_mobile_config_v1';
const DEV_FS_PREFIX = 'devfs://';

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

export function isWebSimulator(): boolean {
  return Platform.OS === 'web';
}

export function getDefaultDesktopBridgeUrl(): string {
  return isWebSimulator() ? 'http://localhost:8384' : 'http://10.10.10.66:8384';
}

export function getDefaultMobileDeviceName(): string {
  return isWebSimulator() ? 'Android-Sim' : 'Android-Phone';
}

export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.replace(/[\r\n\s]/g, '');
  if (!clean) {
    return new Uint8Array(new ArrayBuffer(0));
  }
  let padding = 0;
  if (clean.endsWith('==')) padding = 2;
  else if (clean.endsWith('=')) padding = 1;

  const byteLength = Math.floor((clean.length * 3) / 4) - padding;
  const buffer = new ArrayBuffer(Math.max(0, byteLength));
  const bytes = new Uint8Array(buffer);

  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const encoded1 = B64_LOOKUP[clean.charCodeAt(i)];
    const encoded2 = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const encoded3 = B64_LOOKUP[clean.charCodeAt(i + 2)];
    const encoded4 = B64_LOOKUP[clean.charCodeAt(i + 3)];

    if (p < byteLength) bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (p < byteLength) bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    if (p < byteLength) bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let result = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;

    result += B64_CHARS[b1 >> 2];
    result += B64_CHARS[((b1 & 3) << 4) | (b2 >> 4)];
    result += i + 1 < len ? B64_CHARS[((b2 & 15) << 2) | (b3 >> 6)] : '=';
    result += i + 2 < len ? B64_CHARS[b3 & 63] : '=';
  }
  return result;
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export async function computeSha256HexFromBase64(base64Content: string): Promise<string> {
  const bytes = base64ToUint8Array(base64Content);
  if (isWebSimulator() && globalThis.crypto?.subtle) {
    const digestBuf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return arrayBufferToHex(digestBuf);
  }
  const digestBuf = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return arrayBufferToHex(digestBuf);
}

export function shouldIgnoreSyncFileName(name: string): boolean {
  if (!name) return true;
  return (
    name === '.git' ||
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name.startsWith('.sync_tmp') ||
    name.endsWith('.sync_tmp') ||
    name.startsWith('.unsynced_local_backup') ||
    name.startsWith('.~lock.') ||
    name.startsWith('~$') ||
    name.startsWith('.#') ||
    name.endsWith('.swp') ||
    name.endsWith('.swx') ||
    name.endsWith('~') ||
    name.endsWith('.tmp') ||
    name.endsWith('.part') ||
    name.endsWith('.crdownload')
  );
}

const NATIVE_CONFIG_FILE_URI = `${
  FileSystem.documentDirectory ?? 'file:///data/local/tmp/'
}foldersync-mobile-config.json`;

export async function readRawMobileConfigJson(): Promise<string | null> {
  if (isWebSimulator()) {
    try {
      return globalThis.localStorage?.getItem(WEB_CONFIG_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }
  const info = await FileSystem.getInfoAsync(NATIVE_CONFIG_FILE_URI);
  if (!info.exists) {
    return null;
  }
  return FileSystem.readAsStringAsync(NATIVE_CONFIG_FILE_URI);
}

export async function writeRawMobileConfigJson(json: string): Promise<void> {
  if (isWebSimulator()) {
    globalThis.localStorage?.setItem(WEB_CONFIG_STORAGE_KEY, json);
    return;
  }
  await FileSystem.writeAsStringAsync(NATIVE_CONFIG_FILE_URI, json);
}

function extractLinuxPathFromDevUri(uri: string): string {
  return uri.startsWith(DEV_FS_PREFIX) ? uri.slice(DEV_FS_PREFIX.length) : uri;
}

function extractFileNameFromSafUri(uri: string): string {
  const decoded = decodeURIComponent(uri);
  const parts = decoded.split(/[/:]/);
  return parts[parts.length - 1] || 'unknown';
}

export async function requestSyncDirectoryUri(suggestedLabel?: string): Promise<string | null> {
  if (isWebSimulator()) {
    const customPicker = (
      globalThis as unknown as {
        __pickMobileSimFolder?: (label?: string) => Promise<string | null>;
      }
    ).__pickMobileSimFolder;

    let chosenPath: string | null = null;
    if (customPicker) {
      chosenPath = await customPicker(suggestedLabel);
    } else if (typeof globalThis.prompt === 'function') {
      const suffix = suggestedLabel
        ? `-${suggestedLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        : '';
      chosenPath = globalThis.prompt(
        'Nhập đường dẫn thư mục trên máy Dev để giả lập bộ nhớ Điện thoại Android:',
        `/tmp/foldersync-android-sim${suffix}`,
      );
    }

    if (!chosenPath || !chosenPath.trim()) {
      return null;
    }

    const res = await fetch('/__mobile_dev_fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: chosenPath.trim() }),
    });
    if (!res.ok) {
      const errData = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errData.error || `Không thể tạo thư mục giả lập: ${chosenPath}`);
    }
    const data = (await res.json()) as { dir: string };
    return `${DEV_FS_PREFIX}${data.dir}`;
  }

  const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!perm.granted) {
    return null;
  }
  return perm.directoryUri;
}

export async function copyDirectoryFilesFlat(
  fromDirUri: string,
  toDirUri: string,
): Promise<number> {
  if (isWebSimulator()) {
    const res = await fetch('/__mobile_dev_fs/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromDir: extractLinuxPathFromDevUri(fromDirUri),
        toDir: extractLinuxPathFromDevUri(toDirUri),
      }),
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as { copiedCount?: number };
    return data.copiedCount ?? 0;
  }

  let copiedCount = 0;
  const childUris = await StorageAccessFramework.readDirectoryAsync(fromDirUri);
  for (const fileUri of childUris) {
    const name = extractFileNameFromSafUri(fileUri);
    if (shouldIgnoreSyncFileName(name)) continue;
    try {
      const base64Data = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const destUri = await StorageAccessFramework.createFileAsync(
        toDirUri,
        name,
        'application/octet-stream',
      );
      await FileSystem.writeAsStringAsync(destUri, base64Data, {
        encoding: FileSystem.EncodingType.Base64,
      });
      copiedCount += 1;
    } catch {
      // Skip subdirectories or unreadable entries in flat SAF copy
    }
  }
  return copiedCount;
}

async function scanNativeSafRecursive(
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
    if (shouldIgnoreSyncFileName(name)) {
      continue;
    }

    const relPath = prefix ? `${prefix}/${name}` : name;
    if (relPath === LIST_FILE_NAME) {
      uriMap.set(relPath, uri);
      continue;
    }

    // Prefer directory detection first to preserve folder structure correctly.
    try {
      await StorageAccessFramework.readDirectoryAsync(uri);
      await scanNativeSafRecursive(uri, relPath, uriMap, fileContentsB64);
      continue;
    } catch {
      // Not a directory, try as file below.
    }

    try {
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      uriMap.set(relPath, uri);
      fileContentsB64.set(relPath, b64);
    } catch {
      // Unreadable entry; skip.
    }
  }
}

async function ensureNativeSafSubdirectory(
  parentDirUri: string,
  dirName: string,
): Promise<string> {
  const children = await StorageAccessFramework.readDirectoryAsync(parentDirUri);
  for (const childUri of children) {
    const childName = extractFileNameFromSafUri(childUri);
    if (childName === dirName) {
      try {
        await StorageAccessFramework.readDirectoryAsync(childUri);
        return childUri;
      } catch {
        // Name collision with file; fall through to create a uniquely named dir? unlikely.
      }
    }
  }
  return StorageAccessFramework.makeDirectoryAsync(parentDirUri, dirName);
}

export async function scanPlatformDirectory(directoryUri: string): Promise<{
  uriMap: Map<string, string>;
  fileContentsB64: Map<string, string>;
  listFileMarkdown: string | null;
}> {
  const uriMap = new Map<string, string>();
  const fileContentsB64 = new Map<string, string>();

  if (isWebSimulator()) {
    const dir = extractLinuxPathFromDevUri(directoryUri);
    const res = await fetch(`/__mobile_dev_fs/scan?dir=${encodeURIComponent(dir)}`);
    if (!res.ok) {
      return { uriMap, fileContentsB64, listFileMarkdown: null };
    }
    const data = (await res.json()) as {
      files: Array<{ relPath: string; b64: string }>;
      listFileMarkdown: string | null;
    };
    for (const item of data.files) {
      uriMap.set(item.relPath, `${DEV_FS_PREFIX}${dir}/${item.relPath}`);
      fileContentsB64.set(item.relPath, item.b64);
    }
    if (data.listFileMarkdown !== null) {
      uriMap.set(LIST_FILE_NAME, `${DEV_FS_PREFIX}${dir}/${LIST_FILE_NAME}`);
    }
    return {
      uriMap,
      fileContentsB64,
      listFileMarkdown: data.listFileMarkdown,
    };
  }

  await scanNativeSafRecursive(directoryUri, '', uriMap, fileContentsB64);
  let listFileMarkdown: string | null = null;
  const listFileUri = uriMap.get(LIST_FILE_NAME);
  if (listFileUri) {
    try {
      listFileMarkdown = await FileSystem.readAsStringAsync(listFileUri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
    } catch {
      listFileMarkdown = null;
    }
  }

  return { uriMap, fileContentsB64, listFileMarkdown };
}

export async function writePlatformFile(
  directoryUri: string,
  uriMap: Map<string, string>,
  relativePath: string,
  content: string,
  isBase64: boolean,
): Promise<string> {
  const normalizedRelPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');

  if (isWebSimulator()) {
    const dir = extractLinuxPathFromDevUri(directoryUri);
    const res = await fetch('/__mobile_dev_fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dir,
        relPath: normalizedRelPath,
        content,
        isBase64,
      }),
    });
    if (!res.ok) {
      throw new Error(`Không thể ghi file giả lập "${normalizedRelPath}".`);
    }
    const uri = `${DEV_FS_PREFIX}${dir}/${normalizedRelPath}`;
    uriMap.set(normalizedRelPath, uri);
    return uri;
  }

  let existingUri = uriMap.get(normalizedRelPath);
  if (!existingUri) {
    // Try to resolve parent path and find an existing child with the same name
    // to avoid creating duplicate files (e.g. "file (1).jpg") on SAF providers.
    try {
      let parentUri = directoryUri;
      const parts = normalizedRelPath.split('/').filter(Boolean);
      const fileName = parts.pop() || normalizedRelPath;
      if (normalizedRelPath !== LIST_FILE_NAME) {
        for (const dirName of parts) {
          parentUri = await ensureNativeSafSubdirectory(parentUri, dirName);
        }
      }
      const safKey = normalizedRelPath === LIST_FILE_NAME ? LIST_FILE_NAME : fileName;
      const children = await StorageAccessFramework.readDirectoryAsync(parentUri);
      for (const childUri of children) {
        if (extractFileNameFromSafUri(childUri) === safKey) {
          existingUri = childUri;
          uriMap.set(normalizedRelPath, childUri);
          break;
        }
      }
    } catch {
      // Fall through to create path below.
    }
  }

  if (existingUri) {
    await FileSystem.writeAsStringAsync(existingUri, content, {
      encoding: isBase64 ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8,
    });
    return existingUri;
  }

  let parentUri = directoryUri;
  const parts = normalizedRelPath.split('/').filter(Boolean);
  const fileName = parts.pop() || normalizedRelPath;
  if (normalizedRelPath !== LIST_FILE_NAME) {
    for (const dirName of parts) {
      parentUri = await ensureNativeSafSubdirectory(parentUri, dirName);
    }
  }

  const safKey = normalizedRelPath === LIST_FILE_NAME ? LIST_FILE_NAME : fileName;
  const fileUri = await StorageAccessFramework.createFileAsync(
    parentUri,
    safKey,
    'application/octet-stream',
  );
  uriMap.set(normalizedRelPath, fileUri);
  await FileSystem.writeAsStringAsync(fileUri, content, {
    encoding: isBase64 ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8,
  });
  return fileUri;
}

export async function readPlatformFileBase64(
  directoryUri: string,
  fileUri: string,
  relativePath: string,
): Promise<string> {
  if (isWebSimulator()) {
    const dir = extractLinuxPathFromDevUri(directoryUri);
    const res = await fetch(
      `/__mobile_dev_fs/read?dir=${encodeURIComponent(dir)}&relPath=${encodeURIComponent(
        relativePath,
      )}`,
    );
    if (!res.ok) {
      throw new Error(`Không thể đọc file giả lập "${relativePath}".`);
    }
    const data = (await res.json()) as { b64: string };
    return data.b64;
  }

  return FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

export async function deletePlatformFile(
  directoryUri: string,
  fileUri: string | undefined,
  relativePath: string,
): Promise<void> {
  if (isWebSimulator()) {
    const dir = extractLinuxPathFromDevUri(directoryUri);
    await fetch('/__mobile_dev_fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, relPath: relativePath }),
    }).catch(() => undefined);
    return;
  }

  if (fileUri) {
    await StorageAccessFramework.deleteAsync(fileUri, { idempotent: true });
  }
}

export async function downloadUrlAsBase64(
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  if (isWebSimulator()) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Tải file từ Google Drive thất bại (HTTP ${res.status}).`);
    }
    const buf = await res.arrayBuffer();
    return uint8ArrayToBase64(new Uint8Array(buf));
  }

  const tmpLocal = `${FileSystem.cacheDirectory ?? ''}dl_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const dlRes = await FileSystem.downloadAsync(url, tmpLocal, { headers });
  try {
    return await FileSystem.readAsStringAsync(dlRes.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } finally {
    await FileSystem.deleteAsync(dlRes.uri, { idempotent: true });
  }
}

export function getMimeTypeFromFileName(relativePath: string): string {
  const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'pdf':
      return 'application/pdf';
    case 'md':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'txt':
    case 'log':
    case 'csv':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

export async function readPlatformFileText(
  directoryUri: string,
  fileUri: string,
  relativePath: string,
): Promise<string> {
  if (!isWebSimulator() && fileUri) {
    return FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  }
  const b64 = await readPlatformFileBase64(directoryUri, fileUri, relativePath);
  const bytes = base64ToUint8Array(b64);
  return new TextDecoder('utf-8').decode(bytes);
}

export async function renamePlatformFile(
  directoryUri: string,
  uriMap: Map<string, string>,
  oldRelPath: string,
  newRelPath: string,
): Promise<string> {
  const oldUri = uriMap.get(oldRelPath) ?? '';
  const b64 = await readPlatformFileBase64(directoryUri, oldUri, oldRelPath);
  const newUri = await writePlatformFile(directoryUri, uriMap, newRelPath, b64, true);
  await deletePlatformFile(directoryUri, oldUri || undefined, oldRelPath);
  uriMap.delete(oldRelPath);
  return newUri;
}

export async function openPlatformFileExternal(
  directoryUri: string,
  fileUri: string | undefined,
  relativePath: string,
): Promise<void> {
  const mimeType = getMimeTypeFromFileName(relativePath);
  if (isWebSimulator()) {
    const b64 = await readPlatformFileBase64(directoryUri, fileUri ?? '', relativePath);
    const bytes = base64ToUint8Array(b64);
    const blob = new Blob([bytes], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    return;
  }

  if (!fileUri) {
    throw new Error('Không tìm thấy URI của file trên thiết bị.');
  }

  // Copy SAF document to cache first so external players get a valid FileProvider URI
  // with FLAG_GRANT_READ_URI_PERMISSION and explicit MIME type.
  const rawBaseName = relativePath.split('/').pop() || 'file';
  const safeBaseName = rawBaseName.replace(/[^\p{L}\p{N}._-]/gu, '_');
  const cacheDir = `${FileSystem.cacheDirectory ?? ''}foldersync_open/`;
  await FileSystem.deleteAsync(cacheDir, { idempotent: true }).catch(() => undefined);
  await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true }).catch(() => undefined);
  const localCacheUri = `${cacheDir}${Date.now()}_${safeBaseName}`;

  try {
    await FileSystem.copyAsync({ from: fileUri, to: localCacheUri });
  } catch {
    const b64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    await FileSystem.writeAsStringAsync(localCacheUri, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }

  const contentUri = await FileSystem.getContentUriAsync(localCacheUri);
  if (Platform.OS === 'android') {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: 1, // Intent.FLAG_GRANT_READ_URI_PERMISSION
      type: mimeType,
    });
    return;
  }

  await Linking.openURL(contentUri);
}

export type MessengerUploadKind = 'IMAGE' | 'VIDEO' | 'MEDIA' | 'DOCUMENT';

function inferExtensionFromMime(mimeType?: string | null, fallbackKind?: MessengerUploadKind): string {
  if (mimeType) {
    const sub = mimeType.split('/')[1]?.split(';')[0]?.toLowerCase();
    if (sub === 'jpeg') return 'jpg';
    if (sub === 'quicktime') return 'mov';
    if (sub === 'x-matroska') return 'mkv';
    if (sub && /^[a-z0-9]{2,6}$/.test(sub)) return sub;
  }
  if (fallbackKind === 'VIDEO') return 'mp4';
  if (fallbackKind === 'IMAGE') return 'jpg';
  return 'bin';
}

export async function pickAndCopyFilesToSyncFolder(options: {
  directoryUri: string;
  uriMap: Map<string, string>;
  targetSubDir?: string;
  kind: MessengerUploadKind;
}): Promise<string[]> {
  const { directoryUri, uriMap, targetSubDir, kind } = options;

  interface PickedAsset {
    uri: string;
    name: string;
    mimeType?: string | null;
  }
  const assets: PickedAsset[] = [];

  if (kind === 'DOCUMENT') {
    const docRes = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (docRes.canceled || !docRes.assets || docRes.assets.length === 0) {
      return [];
    }
    for (const a of docRes.assets) {
      assets.push({
        uri: a.uri,
        name: a.name || a.uri.split('/').pop() || `doc_${Date.now()}.bin`,
        mimeType: a.mimeType,
      });
    }
  } else {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      throw new Error('Vui lòng cấp quyền truy cập Thư viện ảnh & video cho ứng dụng.');
    }
    const mediaTypes: ImagePicker.MediaType[] =
      kind === 'IMAGE'
        ? ['images']
        : kind === 'VIDEO'
          ? ['videos']
          : ['images', 'videos'];
    const imgRes = await ImagePicker.launchImageLibraryAsync({
      mediaTypes,
      allowsMultipleSelection: true,
      quality: 1,
    });
    if (imgRes.canceled || !imgRes.assets || imgRes.assets.length === 0) {
      return [];
    }
    for (let i = 0; i < imgRes.assets.length; i++) {
      const a = imgRes.assets[i];
      const ext = inferExtensionFromMime(a.mimeType, a.type === 'video' ? 'VIDEO' : 'IMAGE');
      const rawName = a.fileName || decodeURIComponent(a.uri.split('/').pop() || '');
      const fallbackName = `${a.type === 'video' ? 'video' : 'image'}_${Date.now()}_${i + 1}.${ext}`;
      const chosenName =
        rawName && rawName.includes('.') ? rawName : fallbackName;
      assets.push({
        uri: a.uri,
        name: chosenName,
        mimeType: a.mimeType,
      });
    }
  }

  const copiedPaths: string[] = [];
  const cleanPrefix = targetSubDir ? targetSubDir.replace(/^\/+|\/+$/g, '') : '';

  for (const asset of assets) {
    const safeFileName = asset.name.replace(/[\\/]+/g, '_').trim() || `file_${Date.now()}`;
    const relPath = cleanPrefix ? `${cleanPrefix}/${safeFileName}` : safeFileName;

    let b64 = '';
    if (isWebSimulator()) {
      try {
        const res = await fetch(asset.uri);
        const buf = await res.arrayBuffer();
        b64 = uint8ArrayToBase64(new Uint8Array(buf));
      } finally {
        if (asset.uri.startsWith('blob:')) {
          URL.revokeObjectURL(asset.uri);
        }
      }
    } else {
      try {
        b64 = await FileSystem.readAsStringAsync(asset.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } catch {
        const tmpUri = `${FileSystem.cacheDirectory ?? ''}pick_${Date.now()}_${safeFileName}`;
        await FileSystem.copyAsync({ from: asset.uri, to: tmpUri });
        try {
          b64 = await FileSystem.readAsStringAsync(tmpUri, {
            encoding: FileSystem.EncodingType.Base64,
          });
        } finally {
          await FileSystem.deleteAsync(tmpUri, { idempotent: true });
        }
      }
    }

    await writePlatformFile(directoryUri, uriMap, relPath, b64, true);
    copiedPaths.push(relPath);
  }

  return copiedPaths;
}
