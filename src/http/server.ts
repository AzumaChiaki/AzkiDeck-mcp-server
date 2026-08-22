import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import type { Config } from '../config.js';
import { handleMcpRequest, mcpMethodNotAllowed, mcpDeleteOk, mcpOptions, type McpHttpDeps } from './mcpEndpoint.js';
import { handleAdmin, handleHealthz, type AdminDeps } from './admin.js';
import { landingPageHtml } from './landing.js';
import { handleFileUpload, handleFileDownload } from './files.js';
import type { DeviceSocketHandler } from '../relay/deviceSocket.js';
import type { RateLimiter } from '../core/ratelimit.js';

export interface HttpServerDeps {
  config: Config;
  mcp: McpHttpDeps;
  admin: AdminDeps;
  deviceSocket: DeviceSocketHandler;
  authFailLimiter: RateLimiter;
  log?: (msg: string) => void;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        over = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** 二进制版 readBody(/files 上传用,上限独立且更大)。超限后排空剩余数据再回 null,保证客户端能收到 413。 */
function readBodyBuffer(req: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        over = true; // 继续读但不再存,排空这条连接
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** 装配 HTTP(S) 服务器 + WS upgrade,返回运行句柄。 */
export function startServer(deps: HttpServerDeps): Promise<RunningServer> {
  const { config } = deps;
  const log = deps.log ?? ((msg: string) => console.log(msg));

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const clientIp = req.socket.remoteAddress ?? 'unknown';

    if (url.pathname === '/healthz' && req.method === 'GET') {
      handleHealthz(deps.admin, res);
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(landingPageHtml());
      return;
    }

    if (url.pathname.startsWith('/admin/') || url.pathname === '/admin') {
      const body = req.method === 'POST' ? await readBody(req, config.maxBodyBytes) : '';
      if (body === null) {
        res.writeHead(413).end(JSON.stringify({ error: '请求体过大' }));
        return;
      }
      await handleAdmin(deps.admin, req, res, url, body);
      return;
    }

    // 临时文件投递:远程安装的摆渡通道(手机用 install_resource 的 url 模式自取)
    if (url.pathname === '/files' && req.method === 'POST') {
      const body = await readBodyBuffer(req, config.fileMaxBytes + 1);
      if (body === null) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `文件超过上限 ${config.fileMaxBytes >> 20} MiB` }));
        return;
      }
      await handleFileUpload({ config, tenants: deps.mcp.tenants }, req, res, url, body);
      return;
    }
    const fileMatch = url.pathname.match(/^\/files\/([0-9a-f]{24})$/);
    if (fileMatch && req.method === 'GET') {
      handleFileDownload({ config, tenants: deps.mcp.tenants }, req, res, url, fileMatch[1]!);
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        mcpMethodNotAllowed(res);
        return;
      }
      if (req.method === 'DELETE') {
        mcpDeleteOk(res);
        return;
      }
      if (req.method === 'OPTIONS') {
        mcpOptions(res);
        return;
      }
      if (req.method !== 'POST') {
        mcpMethodNotAllowed(res);
        return;
      }
      const body = await readBody(req, config.maxBodyBytes);
      if (body === null) {
        res.writeHead(413).end(JSON.stringify({ error: '请求体过大' }));
        return;
      }
      await handleMcpRequest(deps.mcp, req, res, url, body, clientIp);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  };

  const useTls = config.tlsCert !== null && config.tlsKey !== null;
  const server = useTls
    ? https.createServer({ cert: readFileSync(config.tlsCert!), key: readFileSync(config.tlsKey!) }, handler)
    : http.createServer(handler);

  // WS 与 HTTP 共用端口,只有 /device 路径接受 upgrade
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsBytes });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/device') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      deps.deviceSocket.handle(ws);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : config.port;
      log(`azkideck-mcp-server  listening on ${useTls ? 'https' : 'http'}://${config.host}:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            // 先掐全部 WS,再关 HTTP;空闲 keep-alive 连接一并断开,保证 close 不挂起
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.closeIdleConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}
