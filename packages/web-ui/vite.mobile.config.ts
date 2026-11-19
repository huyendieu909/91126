import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const mobileWebRoot = path.resolve(__dirname, '../mobile-app/web-sim');

function readEnvVarsFromFiles(): Record<string, string> {
  const result: Record<string, string> = {};
  const files = [
    path.join(repoRoot, '.env'),
    path.join(repoRoot, 'packages/mobile-app/.env'),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf-8');
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (k) result[k] = v;
      }
    } catch {
      // Ignore unreadable env file
    }
  }
  return result;
}

function shouldIgnoreSimFile(name: string): boolean {
  return (
    !name ||
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

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function safeJoinInside(rootDir: string, relPath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const target = path.resolve(resolvedRoot, relPath.replace(/^\/+/, ''));
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Đường dẫn tương đối không hợp lệ.');
  }
  return target;
}

async function walkSimDir(
  rootDir: string,
  currentDir: string,
  out: Array<{ relPath: string; b64: string }>,
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldIgnoreSimFile(entry.name)) continue;
    const full = path.join(currentDir, entry.name);
    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
    if (rel === 'list-file.md') continue;

    if (entry.isDirectory()) {
      await walkSimDir(rootDir, full, out);
    } else if (entry.isFile()) {
      try {
        const buf = await fs.readFile(full);
        out.push({ relPath: rel, b64: buf.toString('base64') });
      } catch {
        // Ignore transient vanished files
      }
    }
  }
}

function mobileDevFsPlugin(): Plugin {
  return {
    name: 'foldersync-mobile-dev-fs',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/__mobile_dev_fs/')) {
          next();
          return;
        }

        const parsedUrl = new URL(req.url, 'http://localhost:8390');
        const route = parsedUrl.pathname.replace('/__mobile_dev_fs/', '');

        try {
          if (req.method === 'GET' && route === 'browse') {
            const rawTarget = parsedUrl.searchParams.get('path') || os.homedir();
            const resolved = path.resolve(rawTarget);
            await fs.mkdir(resolved, { recursive: true }).catch(() => undefined);
            const items = await fs
              .readdir(resolved, { withFileTypes: true })
              .catch(() => []);
            const directories = items
              .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
              .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
              .sort((a, b) => a.name.localeCompare(b.name));
            const parentPath = path.dirname(resolved) !== resolved ? path.dirname(resolved) : null;
            sendJson(res, 200, { currentPath: resolved, parentPath, directories });
            return;
          }

          if (req.method === 'POST' && route === 'mkdir') {
            const body = JSON.parse(await readRequestBody(req)) as { dir: string };
            const resolved = path.resolve(body.dir);
            await fs.mkdir(resolved, { recursive: true });
            sendJson(res, 200, { dir: resolved });
            return;
          }

          if (req.method === 'GET' && route === 'scan') {
            const dir = path.resolve(parsedUrl.searchParams.get('dir') || '');
            await fs.mkdir(dir, { recursive: true });
            const files: Array<{ relPath: string; b64: string }> = [];
            await walkSimDir(dir, dir, files);
            let listFileMarkdown: string | null = null;
            try {
              listFileMarkdown = await fs.readFile(path.join(dir, 'list-file.md'), 'utf-8');
            } catch {
              listFileMarkdown = null;
            }
            sendJson(res, 200, { files, listFileMarkdown });
            return;
          }

          if (req.method === 'GET' && route === 'read') {
            const dir = path.resolve(parsedUrl.searchParams.get('dir') || '');
            const relPath = parsedUrl.searchParams.get('relPath') || '';
            const fullPath = safeJoinInside(dir, relPath);
            const buf = await fs.readFile(fullPath);
            sendJson(res, 200, { b64: buf.toString('base64') });
            return;
          }

          if (req.method === 'POST' && route === 'write') {
            const body = JSON.parse(await readRequestBody(req)) as {
              dir: string;
              relPath: string;
              content: string;
              isBase64: boolean;
            };
            const fullPath = safeJoinInside(body.dir, body.relPath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            if (body.isBase64) {
              await fs.writeFile(fullPath, Buffer.from(body.content, 'base64'));
            } else {
              await fs.writeFile(fullPath, body.content, 'utf-8');
            }
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === 'POST' && route === 'delete') {
            const body = JSON.parse(await readRequestBody(req)) as {
              dir: string;
              relPath: string;
            };
            const fullPath = safeJoinInside(body.dir, body.relPath);
            await fs.rm(fullPath, { force: true });
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === 'POST' && route === 'copy') {
            const body = JSON.parse(await readRequestBody(req)) as {
              fromDir: string;
              toDir: string;
            };
            const fromResolved = path.resolve(body.fromDir);
            const toResolved = path.resolve(body.toDir);
            await fs.mkdir(toResolved, { recursive: true });
            const files: Array<{ relPath: string; b64: string }> = [];
            await walkSimDir(fromResolved, fromResolved, files);
            for (const f of files) {
              const dest = safeJoinInside(toResolved, f.relPath);
              await fs.mkdir(path.dirname(dest), { recursive: true });
              await fs.writeFile(dest, Buffer.from(f.b64, 'base64'));
            }
            sendJson(res, 200, { copiedCount: files.length });
            return;
          }

          sendJson(res, 404, { error: 'Not found' });
        } catch (err) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
  };
}

const envVars = readEnvVarsFromFiles();
const googleClientId =
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ||
  envVars.EXPO_PUBLIC_GOOGLE_CLIENT_ID ||
  envVars.GOOGLE_CLIENT_ID ||
  '';
const googleClientSecret =
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_SECRET ||
  envVars.EXPO_PUBLIC_GOOGLE_CLIENT_SECRET ||
  envVars.GOOGLE_CLIENT_SECRET ||
  '';

export default defineConfig({
  root: mobileWebRoot,
  plugins: [react(), mobileDevFsPlugin()],
  define: {
    'process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID': JSON.stringify(googleClientId),
    'process.env.EXPO_PUBLIC_GOOGLE_CLIENT_SECRET': JSON.stringify(googleClientSecret),
  },
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: path.resolve(__dirname, 'node_modules/react'),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime'),
      },
      {
        find: /^react-dom$/,
        replacement: path.resolve(__dirname, 'node_modules/react-dom'),
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.resolve(__dirname, 'node_modules/react-dom/client'),
      },
      {
        find: /^react-native$/,
        replacement: path.resolve(mobileWebRoot, 'rn-web-shim.tsx'),
      },
      {
        find: /^expo-status-bar$/,
        replacement: path.resolve(mobileWebRoot, 'expo-stubs.ts'),
      },
      {
        find: /^expo-file-system\/legacy$/,
        replacement: path.resolve(mobileWebRoot, 'expo-stubs.ts'),
      },
      {
        find: /^expo-crypto$/,
        replacement: path.resolve(mobileWebRoot, 'expo-stubs.ts'),
      },
      {
        find: /^@foldersync\/shared$/,
        replacement: path.resolve(repoRoot, 'packages/shared/src/index.ts'),
      },
    ],
  },
  server: {
    port: 8390,
    host: 'localhost',
    fs: {
      allow: [repoRoot],
    },
  },
});
