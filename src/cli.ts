#!/usr/bin/env node
import { createApp } from './index.js';
import { loadConfig } from './config.js';
import { Db } from './store/db.js';
import { TenantRegistry } from './core/tenants.js';
import { ServerModeRegistry } from './core/serverMode.js';
import { generateCredential, isValidCredential } from './core/credentials.js';

const USAGE = `azkideck-mcp-server — AzkiDeck 多租户 MCP 中继服务器

用法:
  azkideck-mcp-server [serve]                 启动服务器(默认)
  azkideck-mcp-server tenants list            列出租户
  azkideck-mcp-server tenants create [hex]    预置租户(不给 hex 则生成并打印一次)
  azkideck-mcp-server tenants revoke <id前缀> 撤销租户
  azkideck-mcp-server tenants allow <id前缀>  恢复租户
  azkideck-mcp-server mode get                查看公开/私有模式
  azkideck-mcp-server mode set public         切到公开模式
  azkideck-mcp-server mode set private --key <hex> [--reauth]
                                              切到私有模式;--reauth 要求已配对设备重新认证

环境变量(serve):
  PORT(默认 8787) HOST DATA_DIR AUTO_REGISTER ADMIN_TOKEN
  TLS_CERT TLS_KEY(两者都设置则启用内置 TLS)
  CALL_TIMEOUT_MS HEARTBEAT_INTERVAL_MS BUFFER_TTL_MS RECONNECT_WINDOW_MS …
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'serve';

  if (cmd === 'serve' || cmd === undefined) {
    const app = await createApp();
    const shutdown = () => {
      app.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  const config = loadConfig();
  const db = new Db(config.dataDir);

  try {
    if (cmd === 'tenants') {
      tenantsCommand(db, args.slice(1));
      return;
    }
    if (cmd === 'mode') {
      modeCommand(db, args.slice(1));
      return;
    }
    process.stderr.write(`未知命令: ${cmd}\n\n${USAGE}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

function tenantsCommand(db: Db, args: string[]): void {
  const sub = args[0];
  const tenants = new TenantRegistry(db, false);

  if (sub === 'list') {
    const list = tenants.list();
    if (list.length === 0) {
      process.stdout.write('(暂无租户)\n');
      return;
    }
    for (const t of list) {
      const flags = [
        t.revokedAt !== null ? 'revoked' : null,
        t.reauthRequiredAt !== null ? 'reauth-required' : null,
      ]
        .filter(Boolean)
        .join(' ');
      process.stdout.write(
        `${t.id.slice(0, 8)}  ${t.serverName}  创建于 ${new Date(t.createdAt).toISOString()}  ` +
          `最近活跃 ${new Date(t.lastSeenAt).toISOString()}${flags ? `  [${flags}]` : ''}\n`,
      );
    }
    return;
  }

  if (sub === 'create') {
    let credential = args[1];
    if (credential !== undefined && !isValidCredential(credential)) {
      process.stderr.write('凭证必须是 20~64 位小写 hex\n');
      process.exitCode = 1;
      return;
    }
    credential ??= generateCredential();
    const t = tenants.precreate(credential);
    process.stdout.write(`租户已创建: ${t.id.slice(0, 8)}\n凭证(仅此一次显示): ${credential}\n`);
    return;
  }

  if (sub === 'revoke' || sub === 'allow') {
    const prefix = args[1];
    if (!prefix) {
      process.stderr.write(`用法: tenants ${sub} <id前缀>\n`);
      process.exitCode = 1;
      return;
    }
    const t = tenants.list().find((x) => x.id.startsWith(prefix));
    if (!t) {
      process.stderr.write('租户不存在\n');
      process.exitCode = 1;
      return;
    }
    const ok = sub === 'revoke' ? tenants.revoke(t.id) : tenants.allow(t.id);
    process.stdout.write(ok ? '完成\n' : '操作失败\n');
    if (!ok) process.exitCode = 1;
    return;
  }

  process.stderr.write('用法: tenants list|create|revoke|allow\n');
  process.exitCode = 1;
}

function modeCommand(db: Db, args: string[]): void {
  const serverMode = new ServerModeRegistry(db);
  const sub = args[0];

  if (sub === 'get' || sub === undefined) {
    const s = serverMode.state();
    process.stdout.write(
      `模式: ${s.mode}${s.mode === 'private' ? (s.hasDeploymentKey ? '(已设部署密钥)' : '(未设部署密钥!)') : ''}\n`,
    );
    return;
  }

  if (sub === 'set') {
    const mode = args[1];
    if (mode !== 'public' && mode !== 'private') {
      process.stderr.write('用法: mode set public|private --key <hex> [--reauth]\n');
      process.exitCode = 1;
      return;
    }
    const keyIdx = args.indexOf('--key');
    const key = keyIdx >= 0 ? args[keyIdx + 1] : undefined;
    const reauth = args.includes('--reauth');
    if (mode === 'private' && key !== undefined && !isValidCredential(key)) {
      process.stderr.write('部署密钥必须是 20~64 位小写 hex\n');
      process.exitCode = 1;
      return;
    }
    const after = serverMode.setMode(mode, key);
    if (mode === 'private' && !after.hasDeploymentKey) {
      process.stderr.write('切换到私有模式必须用 --key 提供部署密钥\n');
      process.exitCode = 1;
      return;
    }
    if (mode === 'private' && reauth) {
      const tenants = new TenantRegistry(db, false);
      tenants.markAllReauthRequired();
      process.stdout.write('已切换为私有模式,全部租户标记为待重新认证(在线设备将在下次注册时补验)\n');
      return;
    }
    process.stdout.write(`已切换为 ${mode} 模式\n`);
    return;
  }

  process.stderr.write('用法: mode get|set\n');
  process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`启动失败: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
