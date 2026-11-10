import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LIST_FILE_NAME,
  parseListFile,
  serializeListFile,
  type ListFileDocument,
} from '@foldersync/shared';
import type { ConfigService } from './config-service.js';
import type { CloudStorageProvider } from './cloud-storage.js';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

export const WORKSPACE_FOLDER_NAME = '.FolderSync_Workspace';

export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

export class GoogleOAuthService {
  constructor(private readonly configService: ConfigService) {}

  private async getCredentials(): Promise<{ clientId: string; clientSecret: string }> {
    const cfg = await this.configService.loadConfig();
    const clientId = cfg.googleAuth.clientId || process.env.GOOGLE_CLIENT_ID || '';
    const clientSecret =
      cfg.googleAuth.clientSecret || process.env.GOOGLE_CLIENT_SECRET || '';

    if (!clientId || !clientSecret) {
      throw new Error(
        'Chưa cấu hình GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET trong file .env ở thư mục gốc của dự án.',
      );
    }

    return { clientId, clientSecret };
  }

  public async getAuthorizationUrl(redirectUri: string): Promise<string> {
    const { clientId } = await this.getCredentials();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_OAUTH_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
    });

    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
  }

  public async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const { clientId, clientSecret } = await this.getCredentials();

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Lỗi xác thực Google OAuth2: ${errText}`);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const expiryDate = Date.now() + (tokenData.expires_in - 60) * 1000;

    // Fetch user profile
    let email: string | null = null;
    let displayName: string | null = null;

    const userRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (userRes.ok) {
      const profile = (await userRes.json()) as { email?: string; name?: string };
      email = profile.email ?? null;
      displayName = profile.name ?? null;
    }

    const current = await this.configService.loadConfig();

    await this.configService.saveConfig({
      googleAuth: {
        email,
        displayName,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? current.googleAuth.refreshToken,
        expiryDate,
      },
    });
  }

  public async getValidAccessToken(): Promise<string> {
    const cfg = await this.configService.loadConfig();
    const { accessToken, refreshToken, expiryDate } = cfg.googleAuth;

    if (accessToken && expiryDate && Date.now() < expiryDate) {
      return accessToken;
    }

    if (!refreshToken) {
      if (accessToken) return accessToken;
      throw new Error('Chưa đăng nhập tài khoản Google.');
    }

    const { clientId, clientSecret } = await this.getCredentials();
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Không thể làm mới phiên Google OAuth2: ${errText}`);
    }

    const refreshed = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    const nextExpiry = Date.now() + (refreshed.expires_in - 60) * 1000;
    await this.configService.saveConfig({
      googleAuth: {
        accessToken: refreshed.access_token,
        expiryDate: nextExpiry,
      },
    });

    return refreshed.access_token;
  }

  public async disconnect(): Promise<void> {
    await this.configService.saveConfig({
      googleAuth: {
        email: null,
        displayName: null,
        accessToken: null,
        refreshToken: null,
        expiryDate: null,
        driveRootFolderId: null,
        listFileDriveId: null,
      },
    });
  }
}

export class GoogleDriveProvider implements CloudStorageProvider {
  constructor(
    private readonly configService: ConfigService,
    private readonly oauthService: GoogleOAuthService,
  ) {}

  public async isReady(): Promise<boolean> {
    const cfg = await this.configService.loadConfig();
    return Boolean(cfg.googleAuth.accessToken || cfg.googleAuth.refreshToken);
  }

  public async ensureWorkspaceFolder(): Promise<string> {
    const cfg = await this.configService.loadConfig();
    if (cfg.googleAuth.driveRootFolderId) {
      return cfg.googleAuth.driveRootFolderId;
    }

    const token = await this.oauthService.getValidAccessToken();
    const query = `name = '${WORKSPACE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const searchUrl = `${DRIVE_FILES_API}?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`;

    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!searchRes.ok) {
      throw new Error(`Lỗi tìm kiếm thư mục trên Google Drive: ${await searchRes.text()}`);
    }

    const searchData = (await searchRes.json()) as { files?: Array<{ id: string }> };
    if (searchData.files && searchData.files.length > 0) {
      const folderId = searchData.files[0].id;
      await this.configService.saveConfig({
        googleAuth: { driveRootFolderId: folderId },
      });
      return folderId;
    }

    // Create workspace folder
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

    if (!createRes.ok) {
      throw new Error(`Không thể tạo thư mục trên Google Drive: ${await createRes.text()}`);
    }

    const created = (await createRes.json()) as { id: string };
    await this.configService.saveConfig({
      googleAuth: { driveRootFolderId: created.id },
    });

    return created.id;
  }

  private async findListFileId(rootFolderId: string, token: string): Promise<string | null> {
    const cfg = await this.configService.loadConfig();
    if (cfg.googleAuth.listFileDriveId) {
      return cfg.googleAuth.listFileDriveId;
    }

    const query = `name = '${LIST_FILE_NAME}' and '${rootFolderId}' in parents and trashed = false`;
    const url = `${DRIVE_FILES_API}?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Lỗi tìm kiếm ${LIST_FILE_NAME} trên Drive: ${await res.text()}`);
    }

    const data = (await res.json()) as { files?: Array<{ id: string }> };
    if (data.files && data.files.length > 0) {
      const id = data.files[0].id;
      await this.configService.saveConfig({
        googleAuth: { listFileDriveId: id },
      });
      return id;
    }

    return null;
  }

  public async readRemoteListFile(): Promise<ListFileDocument | null> {
    const token = await this.oauthService.getValidAccessToken();
    const rootFolderId = await this.ensureWorkspaceFolder();
    const listFileId = await this.findListFileId(rootFolderId, token);

    if (!listFileId) {
      return null;
    }

    const res = await fetch(`${DRIVE_FILES_API}/${listFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 404) {
      await this.configService.saveConfig({ googleAuth: { listFileDriveId: null } });
      return null;
    }

    if (!res.ok) {
      throw new Error(`Không thể đọc ${LIST_FILE_NAME} từ Drive: ${await res.text()}`);
    }

    const markdown = await res.text();
    return parseListFile(markdown);
  }

  public async writeRemoteListFile(doc: ListFileDocument): Promise<string> {
    const token = await this.oauthService.getValidAccessToken();
    const rootFolderId = await this.ensureWorkspaceFolder();
    const existingId = await this.findListFileId(rootFolderId, token);
    const markdownBuffer = Buffer.from(serializeListFile(doc), 'utf-8');

    const fileId = await this.uploadMultipartBuffer(
      token,
      LIST_FILE_NAME,
      'text/markdown',
      markdownBuffer,
      rootFolderId,
      existingId ?? undefined,
    );

    await this.configService.saveConfig({
      googleAuth: { listFileDriveId: fileId },
    });

    return fileId;
  }

  public async uploadFile(
    localFilePath: string,
    relativePath: string,
    existingDriveFileId?: string,
  ): Promise<string> {
    const token = await this.oauthService.getValidAccessToken();
    const rootFolderId = await this.ensureWorkspaceFolder();
    const fileBuffer = await fs.readFile(localFilePath);

    // Store with flat safe name inside workspace folder while keeping exact path in list-file.md
    const driveDisplayName = relativePath.replace(/\//g, '__');
    const targetExistingId =
      existingDriveFileId && existingDriveFileId !== '-' ? existingDriveFileId : undefined;

    return this.uploadMultipartBuffer(
      token,
      driveDisplayName,
      'application/octet-stream',
      fileBuffer,
      rootFolderId,
      targetExistingId,
    );
  }

  public async downloadFile(driveFileId: string, destinationPath: string): Promise<void> {
    const token = await this.oauthService.getValidAccessToken();
    const res = await fetch(`${DRIVE_FILES_API}/${driveFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Không thể tải file (${driveFileId}) từ Google Drive: ${await res.text()}`);
    }

    const arrayBuf = await res.arrayBuffer();
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, Buffer.from(arrayBuf));
  }

  public async deleteRemoteFile(driveFileId: string): Promise<void> {
    if (!driveFileId || driveFileId === '-') return;
    const token = await this.oauthService.getValidAccessToken();
    await fetch(`${DRIVE_FILES_API}/${driveFileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  private async uploadMultipartBuffer(
    token: string,
    fileName: string,
    mimeType: string,
    data: Buffer,
    parentFolderId: string,
    existingFileId?: string,
  ): Promise<string> {
    const boundary = `foldersync_boundary_${Date.now()}`;
    const metadata: Record<string, unknown> = existingFileId
      ? { name: fileName }
      : { name: fileName, parents: [parentFolderId] };

    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
        metadata,
      )}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf-8',
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--`, 'utf-8');
    const multipartBody = Buffer.concat([preamble, data, epilogue]);

    const url = existingFileId
      ? `${DRIVE_UPLOAD_API}/${existingFileId}?uploadType=multipart&fields=id`
      : `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id`;

    const method = existingFileId ? 'PATCH' : 'POST';

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    if (!res.ok) {
      throw new Error(`Lỗi tải dữ liệu lên Google Drive: ${await res.text()}`);
    }

    const result = (await res.json()) as { id: string };
    return result.id;
  }
}
