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

export const CryptoDigestAlgorithm = {
  SHA256: 'SHA-256',
} as const;

export async function digest(
  _algorithm: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  return globalThis.crypto.subtle.digest('SHA-256', data);
}
