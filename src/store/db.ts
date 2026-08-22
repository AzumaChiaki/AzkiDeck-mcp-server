import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SQLite 持久化。整个项目唯一直接接触 SQL 的文件。
 * 租户表只存凭证哈希,明文永不落盘。server_settings 存公开/私有模式与部署密钥哈希。
 */

export interface TenantRow {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  reauthRequiredAt: number | null;
  serverName: string;
  toolCache: string; // JSON
}

export type ServerMode = 'public' | 'private';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants(
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  reauth_required_at INTEGER,
  server_name TEXT NOT NULL DEFAULT 'azki-watch',
  tool_cache TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS server_settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class Db {
  private readonly db: DatabaseSync;

  constructor(dataDir: string, memory = false) {
    if (memory) {
      this.db = new DatabaseSync(':memory:');
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(join(dataDir, 'azkideck-mcp.db'));
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec(SCHEMA);
  }

  /** 仅测试用:内存库。 */
  static inMemory(): Db {
    return new Db('', true);
  }

  close(): void {
    this.db.close();
  }

  // ---- tenants ----

  getTenant(id: string): TenantRow | null {
    const r = this.db
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return r ? rowToTenant(r) : null;
  }

  insertTenant(id: string, now: number): void {
    this.db
      .prepare('INSERT INTO tenants(id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run(id, now, now);
  }

  touchTenant(id: string, now: number): void {
    this.db.prepare('UPDATE tenants SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  updateTenantSnapshot(id: string, serverName: string, toolCacheJson: string, now: number): void {
    this.db
      .prepare('UPDATE tenants SET server_name = ?, tool_cache = ?, last_seen_at = ? WHERE id = ?')
      .run(serverName, toolCacheJson, now, id);
  }

  setRevoked(id: string, revokedAt: number | null): void {
    this.db.prepare('UPDATE tenants SET revoked_at = ? WHERE id = ?').run(revokedAt, id);
  }

  setReauthRequired(id: string, at: number | null): void {
    this.db.prepare('UPDATE tenants SET reauth_required_at = ? WHERE id = ?').run(at, id);
  }

  /** 把所有租户标记为待重新认证(模式切换 require_reauth=true 用)。 */
  markAllReauthRequired(now: number): void {
    this.db.prepare('UPDATE tenants SET reauth_required_at = ? WHERE revoked_at IS NULL').run(now);
  }

  listTenants(): TenantRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tenants ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToTenant);
  }

  countTenants(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM tenants').get() as { c: number };
    return r.c;
  }

  // ---- server_settings ----

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string, now: number): void {
    this.db
      .prepare(
        'INSERT INTO server_settings(key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, now);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM server_settings WHERE key = ?').run(key);
  }
}

function rowToTenant(r: Record<string, unknown>): TenantRow {
  return {
    id: String(r['id']),
    createdAt: Number(r['created_at']),
    lastSeenAt: Number(r['last_seen_at']),
    revokedAt: r['revoked_at'] === null || r['revoked_at'] === undefined ? null : Number(r['revoked_at']),
    reauthRequiredAt:
      r['reauth_required_at'] === null || r['reauth_required_at'] === undefined
        ? null
        : Number(r['reauth_required_at']),
    serverName: String(r['server_name'] ?? 'azki-watch'),
    toolCache: String(r['tool_cache'] ?? '[]'),
  };
}
