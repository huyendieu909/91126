import React from 'react';

export const StatusBar: React.FC<{ style?: string }> = () => null;

export const EncodingType = {
  UTF8: 'utf8',
  Base64: 'base64',
} as const;

export const documentDirectory = 'file:///sim/';
export const cacheDirectory = 'file:///sim/cache/';

export const StorageAccessFramework = {
  async requestDirectoryPermissionsAsync() {
    return { granted: false, directoryUri: '' };
  },
  async readDirectoryAsync(): Promise<string[]> {
    return [];
  },
  async createFileAsync(): Promise<string> {
    return '';
  },
  async deleteAsync(): Promise<void> {},
};

export async function getInfoAsync() {
  return { exists: false };
}

export async function readAsStringAsync(): Promise<string> {
  return '';
}

export async function writeAsStringAsync(): Promise<void> {}

export async function downloadAsync() {
  return { uri: '' };
}

export async function deleteAsync(): Promise<void> {}

export async function makeDirectoryAsync(): Promise<void> {}

export async function copyAsync(): Promise<void> {}

export async function getContentUriAsync(uri: string): Promise<string> {
  return uri;
}

export const CryptoDigestAlgorithm = {
  SHA256: 'SHA-256',
} as const;

export async function digest(
  _algorithm: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest('SHA-256', data);
}

export async function startActivityAsync(): Promise<{ resultCode: number }> {
  return { resultCode: 0 };
}

export const MediaTypeOptions = {
  All: 'All',
  Images: 'Images',
  Videos: 'Videos',
} as const;

export async function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }> {
  return { granted: true };
}

function pickBrowserFiles(
  accept: string,
  multiple = true,
): Promise<Array<{ uri: string; fileName: string; name: string; mimeType: string; size: number }>> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    let settled = false;
    const finish = (files: FileList | null) => {
      if (settled) return;
      settled = true;
      if (!files || files.length === 0) {
        resolve([]);
        return;
      }
      const list = Array.from(files).map((f) => ({
        uri: URL.createObjectURL(f),
        fileName: f.name,
        name: f.name,
        mimeType: f.type || 'application/octet-stream',
        size: f.size,
      }));
      resolve(list);
    };
    input.onchange = () => finish(input.files);
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!settled) finish(input.files);
        }, 500);
      },
      { once: true },
    );
    input.click();
  });
}

export async function launchImageLibraryAsync(options?: {
  mediaTypes?: string | string[];
  allowsMultipleSelection?: boolean;
}) {
  const mt = Array.isArray(options?.mediaTypes)
    ? options.mediaTypes.join(',')
    : String(options?.mediaTypes ?? '');
  const hasImg = mt.includes('images') || mt === MediaTypeOptions.Images || mt === MediaTypeOptions.All;
  const hasVid = mt.includes('videos') || mt === MediaTypeOptions.Videos || mt === MediaTypeOptions.All;
  const accept =
    hasImg && !hasVid
      ? 'image/*'
      : hasVid && !hasImg
        ? 'video/*'
        : 'image/*,video/*';
  const picked = await pickBrowserFiles(accept, options?.allowsMultipleSelection ?? true);
  if (picked.length === 0) {
    return { canceled: true, assets: null };
  }
  return {
    canceled: false,
    assets: picked,
  };
}

export async function getDocumentAsync(options?: {
  multiple?: boolean;
}) {
  const picked = await pickBrowserFiles('*/*', options?.multiple ?? true);
  if (picked.length === 0) {
    return { canceled: true, assets: null };
  }
  return {
    canceled: false,
    assets: picked,
  };
}
