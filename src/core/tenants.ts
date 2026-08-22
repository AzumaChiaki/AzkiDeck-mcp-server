import type { Db, TenantRow } from '../store/db.js';
import { tenantIdOf } from './credentials.js';
import type { Tool } from '../mcp/toolClassify.js';

export interface Tenant {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  reauthRequiredAt: number | null;
  serverName: string;
  toolCache: Tool[];
}

function toTenant(r: TenantRow): Tenant {
  let toolCache: Tool[] = [];
  try {
    const parsed: unknown = JSON.parse(r.toolCache);
    if (Array.isArray(parsed)) toolCache = parsed as Tool[];
  } catch {
    // 缓存损坏视同无缓存
  }
  return {
    id: r.id,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    revokedAt: r.revokedAt,
    reauthRequiredAt: r.reauthRequiredAt,
    serverName: r.serverName,
    toolCache,
  };
}

export type DeviceResolveResult =
  | { ok: true; tenant: Tenant; created: boolean }
  | { ok: false; reason: 'unknown_credential' | 'credential_revoked' | 'reauth_ok' };

/**
 * 租户注册表。MCP 侧要求租户必须已存在且未撤销;
 * 设备侧在公开模式 + autoRegister 下首连自动建租户。
 */
export class TenantRegistry {
  constructor(
    private readonly db: Db,
    private readonly autoRegister: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** MCP HTTP 侧解析:不存在/已撤销 → null(401)。 */
  resolveHttp(credential: string): Tenant | null {
    const row = this.db.getTenant(tenantIdOf(credential));
    if (!row || row.revokedAt !== null) return null;
    return toTenant(row);
  }

  /** 设备 WS 侧解析:可能自动创建。 */
  resolveDevice(credential: string): DeviceResolveResult {
    const id = tenantIdOf(credential);
    const existing = this.db.getTenant(id);
    if (existing) {
      if (existing.revokedAt !== null) return { ok: false, reason: 'credential_revoked' };
      this.db.touchTenant(id, this.now());
      return { ok: true, tenant: toTenant({ ...existing, lastSeenAt: this.now() }), created: false };
    }
    if (!this.autoRegister) return { ok: false, reason: 'unknown_credential' };
    const now = this.now();
    this.db.insertTenant(id, now);
    const row = this.db.getTenant(id);
    if (!row) return { ok: false, reason: 'unknown_credential' };
    return { ok: true, tenant: toTenant(row), created: true };
  }

  /** 预置租户(CLI tenants create,autoRegister 关闭场景)。 */
  precreate(credential: string): Tenant {
    const id = tenantIdOf(credential);
    if (!this.db.getTenant(id)) this.db.insertTenant(id, this.now());
    const row = this.db.getTenant(id);
    if (!row) throw new Error('租户创建失败');
    return toTenant(row);
  }

  revoke(id: string): boolean {
    if (!this.db.getTenant(id)) return false;
    this.db.setRevoked(id, this.now());
    return true;
  }

  allow(id: string): boolean {
    if (!this.db.getTenant(id)) return false;
    this.db.setRevoked(id, null);
    return true;
  }

  clearReauthRequired(id: string): void {
    this.db.setReauthRequired(id, null);
  }

  markAllReauthRequired(): void {
    this.db.markAllReauthRequired(this.now());
  }

  /** 设备 register 成功后刷新快照(供离线期 tools/list 使用)。 */
  updateSnapshot(id: string, serverName: string, tools: Tool[]): void {
    this.db.updateTenantSnapshot(id, serverName, JSON.stringify(tools), this.now());
  }

  get(id: string): Tenant | null {
    const row = this.db.getTenant(id);
    return row ? toTenant(row) : null;
  }

  list(): Tenant[] {
    return this.db.listTenants().map(toTenant);
  }

  count(): number {
    return this.db.countTenants();
  }
}
