import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import type { Config } from '../config.js';
import { handleMcpRequest, mcpMethodNotAllowed, mcpDeleteOk, mcpOptions, type McpHttpDeps } from './mcpEndpoint.js';
import { handleAdmin, handleHealthz, type AdminDeps } from './admin.js';
import { landingPageHtml } from './landing.js';
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
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
