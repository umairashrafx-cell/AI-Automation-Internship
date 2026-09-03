/**
 * Google Drive connector - the source document repository for RAG.
 *
 * Business staff maintain policies in Drive exactly as they do today. The
 * pipeline polls a folder, notices new or modified files, downloads them and
 * hands them to the same ingestion code that the local knowledge base uses.
 * "We don't want developers changing the system every time we update a PDF."
 *
 * Authentication is a Google service account using a signed JWT assertion
 * (OAuth 2.0 two-legged flow). Implemented here with node:crypto rather than
 * pulling in googleapis: we need exactly two endpoints, and a service-account
 * JWT is a signed string, so a ~40 line implementation avoids a large
 * dependency and the token cache is explicit.
 *
 * Requires:
 *   GOOGLE_SERVICE_ACCOUNT_KEY_FILE - path to the downloaded JSON key
 *   GOOGLE_DRIVE_FOLDER_ID          - the "UrbanCart Knowledge Base" folder,
 *                                     shared with the service-account email
 */

import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { env, integrationReadiness } from '../config/env.ts';
import { errors } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { withTimeout } from '../utils/misc.ts';
import { SUPPORTED_EXTENSIONS } from '../rag/extractors.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TIMEOUT_MS = 30_000;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  /** Path relative to the knowledge-base root, e.g. "Returns/policy.pdf". */
  relativePath: string;
}

/**
 * Google Workspace formats have no bytes to download; they must be exported.
 * A Google Doc is exported as .docx and a Sheet as .xlsx, which our existing
 * extractors already handle.
 */
const EXPORT_MAP: Record<string, { mime: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/pdf',
    extension: '.pdf',
  },
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

class GoogleDriveClient {
  private key: ServiceAccountKey | null = null;
  private token: { value: string; expiresAt: number } | null = null;

  private async loadKey(): Promise<ServiceAccountKey> {
    if (this.key) return this.key;
    if (!env.googleDrive.serviceAccountKeyFile) {
      throw errors.configuration('GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set.');
    }
    const raw = await readFile(env.googleDrive.serviceAccountKeyFile, 'utf8');
    const parsed = JSON.parse(raw) as ServiceAccountKey;
    if (!parsed.client_email || !parsed.private_key) {
      throw errors.configuration('Service account key is missing client_email or private_key.');
    }
    this.key = parsed;
    return parsed;
  }

  /** Mint (and cache) an access token via the signed-JWT grant. */
  private async getAccessToken(): Promise<string> {
    // 60s safety margin so a token cannot expire mid-download.
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const key = await this.loadKey();
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: key.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    );

    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = base64url(signer.sign(key.private_key));
    const assertion = `${header}.${claims}.${signature}`;

    const response = await withTimeout(
      fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      }),
      TIMEOUT_MS,
      () => errors.upstreamTimeout('google-oauth', TIMEOUT_MS),
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw errors.upstream('google-oauth', `HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return this.token.value;
  }

  private async apiGet(url: string): Promise<Response> {
    const token = await this.getAccessToken();
    return withTimeout(
      fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
      TIMEOUT_MS,
      () => errors.upstreamTimeout('google-drive', TIMEOUT_MS),
    );
  }

  /** Recursively list every supported file under a folder. */
  async listFolder(folderId: string, prefix = ''): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
        pageSize: '200',
        // Required to see files in a Shared Drive.
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const response = await this.apiGet(`${DRIVE_API}/files?${params.toString()}`);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw errors.upstream('google-drive', `list failed HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      const json = (await response.json()) as {
        nextPageToken?: string;
        files: Array<{
          id: string;
          name: string;
          mimeType: string;
          modifiedTime: string;
          size?: string;
        }>;
      };

      for (const file of json.files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          // Sub-folder name becomes the document-type classifier.
          files.push(...(await this.listFolder(file.id, prefix ? `${prefix}/${file.name}` : file.name)));
          continue;
        }
        const exported = EXPORT_MAP[file.mimeType];
        const effectiveName = exported ? `${file.name}${exported.extension}` : file.name;
        const ext = effectiveName.slice(effectiveName.lastIndexOf('.')).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.includes(ext)) {
          logger.debug('drive: skipping unsupported file', { name: file.name, mimeType: file.mimeType });
          continue;
        }
        files.push({
          id: file.id,
          name: effectiveName,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          size: file.size,
          relativePath: prefix ? `${prefix}/${effectiveName}` : effectiveName,
        });
      }

      pageToken = json.nextPageToken;
    } while (pageToken);

    return files;
  }

  /** Download a binary file, or export a Google-native document. */
  async download(file: DriveFile): Promise<Buffer> {
    const exported = EXPORT_MAP[file.mimeType];
    const url = exported
      ? `${DRIVE_API}/files/${file.id}/export?mimeType=${encodeURIComponent(exported.mime)}`
      : `${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`;

    const response = await this.apiGet(url);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw errors.upstream(
        'google-drive',
        `download of ${file.name} failed HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

let client: GoogleDriveClient | null = null;

export const googleDriveConnector = {
  get ready(): boolean {
    return integrationReadiness.googleDrive;
  },

  getClient(): GoogleDriveClient {
    if (!client) client = new GoogleDriveClient();
    return client;
  },

  async listKnowledgeBase(): Promise<DriveFile[]> {
    if (!integrationReadiness.googleDrive) {
      throw errors.configuration(
        'Google Drive is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE and GOOGLE_DRIVE_FOLDER_ID.',
      );
    }
    return this.getClient().listFolder(env.googleDrive.folderId);
  },

  async downloadFile(file: DriveFile): Promise<Buffer> {
    return this.getClient().download(file);
  },
};
