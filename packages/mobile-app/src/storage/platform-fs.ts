import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
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

  const existingUri = uriMap.get(normalizedRelPath);
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
