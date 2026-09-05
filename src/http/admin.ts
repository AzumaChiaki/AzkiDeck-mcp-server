import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TenantRegistry } from '../core/tenants.js';
import type { DeviceRegistry } from '../core/devices.js';
import type { ServerModeRegistry } from '../core/serverMode.js';
import { safeEqual, isValidCredential } from '../core/credentials.js';
import { isObject } from '../core/jsonrpc.js';
import { CLOSE_REAUTH_REQUIRED } from '../relay/protocol.js';
import type { ServerMode } from '../store/db.js';
import { SERVER_VERSION } from '../version.js';

export interface AdminDeps {
  adminToken: string | null;
  tenants: TenantRegistry;
  devices: DeviceRegistry;
  serverMode: ServerModeRegistry;
  startedAt: number;
  now?: () => number;
  log?: (msg: string) => void;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

/** /healthz:公开,含软件版本及计数,不含租户/设备标识信息。 */
export function handleHealthz(deps: AdminDeps, res: ServerResponse): void {
  const now = (deps.now ?? Date.now)();
  sendJson(res, 200, {
    ok: true,
    version: SERVER_VERSION,
    uptime_s: Math.floor((now - deps.startedAt) / 1000),
    tenants: deps.tenants.count(),
    devices_online: deps.devices.onlineCount(),
  });
}

function authorized(deps: AdminDeps, req: IncomingMessage): boolean {
  if (deps.adminToken === null) return false;
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  return safeEqual(auth.slice('Bearer '.length).trim(), deps.adminToken);
}

/**
 * /admin/*:独立 ADMIN_TOKEN 鉴权;未配置 ADMIN_TOKEN 时整体关闭。
 * 路径:
 *   GET  /admin/tenants
 *   GET  /admin/tenants/:id/devices
 *   POST /admin/tenants/:id/revoke
 *   POST /admin/tenants/:id/allow
 *   GET  /admin/mode
 *   POST /admin/mode           { mode, deployment_key?, require_reauth? }
 */
export async function handleAdmin(
  deps: AdminDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: string,
): Promise<void> {
  if (deps.adminToken === null) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (!authorized(deps, req)) {
    res.writeHead(401, { 'www-authenticate': 'Bearer realm="azkideck-admin"' });
    res.end(JSON.stringify({ error: '管理凭证无效' }));
    return;
  }

  const parts = url.pathname.split('/').filter(Boolean); // ['admin', ...]

  // GET /admin/mode
  if (parts.length === 2 && parts[1] === 'mode' && req.method === 'GET') {
    sendJson(res, 200, deps.serverMode.state());
    return;
  }

  // POST /admin/mode
  if (parts.length === 2 && parts[1] === 'mode' && req.method === 'POST') {
    await handleModeSwitch(deps, res, body);
    return;
  }

  if (parts.length >= 2 && parts[1] === 'tenants') {
    // GET /admin/tenants
    if (parts.length === 2 && req.method === 'GET') {
      sendJson(res, 200, {
        tenants: deps.tenants.list().map((t) => ({
          id_prefix: t.id.slice(0, 8),
          created_at: t.createdAt,
          last_seen_at: t.lastSeenAt,
          revoked: t.revokedAt !== null,
          reauth_required: t.reauthRequiredAt !== null,
          server_name: t.serverName,
          devices_online: deps.devices.onlineFor(t.id).length,
        })),
      });
      return;
    }
    // /admin/tenants/:idprefix[/devices|/revoke|/allow]
    const idPrefix = parts[2] ?? '';
    const tenant = deps.tenants.list().find((t) => t.id.startsWith(idPrefix));
    if (!tenant) {
      sendJson(res, 404, { error: '租户不存在' });
      return;
    }
    if (parts.length === 4 && parts[3] === 'devices' && req.method === 'GET') {
      sendJson(res, 200, {
        devices: deps.devices.onlineFor(tenant.id).map((d) => ({
          device_id: d.deviceId,
          platform: d.platform,
          app_version: d.appVersion,
          server_name: d.serverName,
          connected_at: d.connectedAt,
          last_active_at: d.lastActiveAt,
          tools: d.tools.map((t) => t.name),
        })),
      });
      return;
    }
    if (parts.length === 4 && parts[3] === 'revoke' && req.method === 'POST') {
      deps.tenants.revoke(tenant.id);
      deps.devices.evictTenant(tenant.id, CLOSE_REAUTH_REQUIRED, 'credential_revoked');
      deps.log?.(`租户 ${tenant.id.slice(0, 8)} 已撤销`);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (parts.length === 4 && parts[3] === 'allow' && req.method === 'POST') {
      deps.tenants.allow(tenant.id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

/**
 * 模式切换:public ↔ private。
 * 转私有必须提供 deployment_key(或沿用已设置的密钥);
 * require_reauth=true 时踢掉全部在线设备并把所有租戶标记为待重新认证。
 */
async function handleModeSwitch(deps: AdminDeps, res: ServerResponse, body: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'JSON 解析失败' });
    return;
  }
  if (!isObject(parsed)) {
    sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
    return;
  }
  const mode = parsed['mode'];
  if (mode !== 'public' && mode !== 'private') {
    sendJson(res, 400, { error: 'mode 必须是 public 或 private' });
    return;
  }
  const deploymentKey = typeof parsed['deployment_key'] === 'string' ? parsed['deployment_key'] : undefined;
  if (deploymentKey !== undefined && !isValidCredential(deploymentKey)) {
    sendJson(res, 400, { error: 'deployment_key 必须是 20~64 位小写 hex' });
    return;
  }
  const requireReauth = parsed['require_reauth'] === true;

  const before = deps.serverMode.state();
  const after = deps.serverMode.setMode(mode as ServerMode, deploymentKey);

  if (mode === 'private' && !after.hasDeploymentKey) {
    sendJson(res, 400, { error: '切换到私有模式必须提供 deployment_key' });
    return;
  }

  if (before.mode === 'public' && mode === 'private' && requireReauth) {
    // 先踢设备(4003),再统一标记待重新认证;在途 pending 由断连清理快速失败
    deps.tenants.markAllReauthRequired();
    deps.devices.evictAll(CLOSE_REAUTH_REQUIRED, 'reauth_required');
    deps.log?.('服务器转为私有模式,全部租户已标记待重新认证');
  }

  sendJson(res, 200, { ok: true, ...deps.serverMode.state() });
}
