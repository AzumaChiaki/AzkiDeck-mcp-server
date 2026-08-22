import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { TenantRegistry } from '../core/tenants.js';
import { isValidCredential } from '../core/credentials.js';
import { extractCredential } from './mcpEndpoint.js';

/**
 * 临时文件投递:远程安装的摆渡通道。
 *
 * 场景:MCP 的 install_resource 大文件走 base64 会撞报文上限,
 * 正道是 url 模式让手机自己下载——本端点提供那个 URL:
 *   POST /files   (Bearer 令牌,body 为原始二进制)→ { url, expires_at }
 *   GET  /files/:id (Bearer 同一令牌)→ 文件流
 * 文件按租户哈希分目录存放,FILE_TTL_MS 后由清扫器删除。
 */

interface FileDeps {
  config: Config;
  tenants: TenantRegistry;
  now?: () => number;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function resolveTenant(deps: FileDeps, req: IncomingMessage, url: URL) {
  const credential = extractCredential(req, url);
  if (!credential || !isValidCredential(credential)) return null;
  return deps.tenants.resolveHttp(credential);
}

function filesRoot(config: Config): string {
  return join(config.dataDir, 'files');
}

export async function handleFileUpload(
  deps: FileDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
): Promise<void> {
  const tenant = resolveTenant(deps, req, url);
  if (!tenant) {
    sendJson(res, 401, { error: '凭证无效' });
    return;
  }
  if (body.length === 0) {
    sendJson(res, 400, { error: '空文件' });
    return;
  }
  if (body.length > deps.config.fileMaxBytes) {
    sendJson(res, 413, { error: `文件超过上限 ${deps.config.fileMaxBytes >> 20} MiB` });
    return;
  }
  const now = (deps.now ?? Date.now)();
  const id = randomBytes(12).toString('hex');
  const dir = join(filesRoot(deps.config), tenant.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), body);
  // 反代后面要以 Host / X-Forwarded-Proto 还原公网地址
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.headers['host'] ?? url.host;
  const base = `${proto}://${host}`;
  sendJson(res, 200, {
    url: `${base}/files/${id}`,
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    expires_at: now + deps.config.fileTtlMs,
  });
}

export function handleFileDownload(
  deps: FileDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  fileId: string,
): void {
  const tenant = resolveTenant(deps, req, url);
  if (!tenant) {
    sendJson(res, 401, { error: '凭证无效' });
    return;
  }
  if (!/^[0-9a-f]{24}$/.test(fileId)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const path = join(filesRoot(deps.config), tenant.id, fileId);
  stat(path)
    .then((st) => {
      const age = (deps.now ?? Date.now)() - st.mtimeMs;
      if (age > deps.config.fileTtlMs) {
        void unlink(path).catch(() => {});
        sendJson(res, 410, { error: '文件已过期' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': st.size,
      });
      createReadStream(path).pipe(res);
    })
    .catch(() => sendJson(res, 404, { error: 'not found' }));
}

/** 周期性清扫过期文件。返回定时器句柄(便于测试关停)。 */
export function startFileSweeper(config: Config, log: (msg: string) => void): ReturnType<typeof setInterval> {
  const sweep = async () => {
    const root = filesRoot(config);
    const cutoff = Date.now() - config.fileTtlMs;
    let tenants: string[];
    try {
      tenants = await readdir(root);
    } catch {
      return;
    }
    for (const t of tenants) {
      const dir = join(root, t);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const p = join(dir, f);
        try {
          const st = await stat(p);
          if (st.mtimeMs < cutoff) {
            await unlink(p);
            log(`清理过期投递文件 ${f}`);
          }
        } catch {
          /* 文件可能刚被并发删除 */
        }
      }
    }
  };
  const timer = setInterval(() => void sweep(), 60_000);
  timer.unref?.();
  return timer;
}
