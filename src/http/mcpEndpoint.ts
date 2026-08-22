import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import type { TenantRegistry, Tenant } from '../core/tenants.js';
import type { RateLimiter } from '../core/ratelimit.js';
import { isValidCredential } from '../core/credentials.js';
import type { McpDispatcher } from '../mcp/dispatcher.js';
import {
  parseRequest,
  result,
  error,
  PARSE_ERROR,
  INVALID_REQUEST,
  type JsonRpcResponse,
} from '../core/jsonrpc.js';

export interface McpHttpDeps {
  config: Config;
  tenants: TenantRegistry;
  mcpLimiter: RateLimiter;
  authFailLimiter: RateLimiter;
  dispatcher: McpDispatcher;
}

/** 从请求中取凭证:Authorization: Bearer / X-Azki-Token / ?token=,与手机端一致。 */
export function extractCredential(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t !== '') return t;
  }
  const x = req.headers['x-azki-token'];
  if (typeof x === 'string' && x !== '') return x;
  const q = url.searchParams.get('token');
  if (q !== null && q !== '') return q;
  return null;
}

function sendUnauthorized(res: ServerResponse, message: string): void {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Bearer realm="azkideck-mcp-server"',
  });
  res.end(JSON.stringify({ error: message }));
}

export async function handleMcpRequest(
  deps: McpHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: string,
  clientIp: string,
): Promise<void> {
  // 1. 鉴权
  const credential = extractCredential(req, url);
  if (!credential || !isValidCredential(credential)) {
    deps.authFailLimiter.allow(`401:${clientIp}`); // 计数即可,阈值由外层控
    sendUnauthorized(res, '缺少或无效的凭证');
    return;
  }
  const tenant = deps.tenants.resolveHttp(credential);
  if (!tenant) {
    deps.authFailLimiter.allow(`401:${clientIp}`);
    sendUnauthorized(res, '凭证无效或已被撤销');
    return;
  }

  // 2. 限流(按租户)
  if (!deps.mcpLimiter.allow(`mcp:${tenant.id}`)) {
    res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '请求过于频繁,请稍后再试' }));
    return;
  }

  // 3. 解析:单条或 batch
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 200, error(null, PARSE_ERROR, 'JSON 解析失败'));
    return;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      sendJson(res, 200, error(null, INVALID_REQUEST, '空的 batch 请求'));
      return;
    }
    const responses = await dispatchAll(deps, tenant, parsed);
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, responses);
    return;
  }

  const responses = await dispatchAll(deps, tenant, [parsed]);
  if (responses.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, responses[0]);
}

async function dispatchAll(deps: McpHttpDeps, tenant: Tenant, items: unknown[]): Promise<JsonRpcResponse[]> {
  const out: JsonRpcResponse[] = [];
  for (const item of items) {
    const req = parseRequest(item);
    if (!req) {
      out.push(error(null, INVALID_REQUEST, '无效的 JSON-RPC 请求'));
      continue;
    }
    const resp = await deps.dispatcher.dispatch(tenant, req);
    if (resp) out.push(resp);
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

export function mcpMethodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, {
    allow: 'POST, DELETE, OPTIONS',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify({ error: '该端点仅支持 POST' }));
}

export function mcpDeleteOk(res: ServerResponse): void {
  // 无状态服务:没有会话可删,直接 200(与手机端一致)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result(null, {})));
}

export function mcpOptions(res: ServerResponse): void {
  res.writeHead(204, {
    allow: 'POST, DELETE, OPTIONS',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-azki-token',
  });
  res.end();
}
