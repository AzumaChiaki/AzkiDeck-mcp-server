import { loadConfig, type Config } from './config.js';
import { Db } from './store/db.js';
import { TenantRegistry } from './core/tenants.js';
import { DeviceRegistry } from './core/devices.js';
import { PendingMap } from './core/pending.js';
import { ReplayBuffer } from './core/buffer.js';
import { RateLimiter } from './core/ratelimit.js';
import { ServerModeRegistry } from './core/serverMode.js';
import { Router } from './core/router.js';
import { McpDispatcher } from './mcp/dispatcher.js';
import { DeviceSocketHandler } from './relay/deviceSocket.js';
import { startServer, type RunningServer } from './http/server.js';

export interface App {
  server: RunningServer;
  db: Db;
  close(): Promise<void>;
}

/** 装配全部依赖并启动。config 可整体覆盖(测试用)。 */
export async function createApp(overrides?: Partial<Config>): Promise<App> {
  const config: Config = { ...loadConfig(), ...overrides };
  const log = (msg: string) => console.log(`[relay] ${msg}`);

  const db = config.dataDir === ':memory:' ? Db.inMemory() : new Db(config.dataDir);
  const tenants = new TenantRegistry(db, config.autoRegister);
  const devices = new DeviceRegistry();
  const pending = new PendingMap();
  const buffer = new ReplayBuffer(config.bufferTtlMs, config.bufferMaxItems);
  const serverMode = new ServerModeRegistry(db);
  const mcpLimiter = new RateLimiter(config.rateMcpPerMinute);
  const wsLimiter = new RateLimiter(config.rateWsPerMinute);
  const authFailLimiter = new RateLimiter(config.rateAuthFailPerMinute);

  const router = new Router({
    devices,
    pending,
    buffer,
    callTimeoutMs: config.callTimeoutMs,
    installTimeoutMs: config.installTimeoutMs,
  });
  const dispatcher = new McpDispatcher({ router, devices });
  const deviceSocket = new DeviceSocketHandler({
    config,
    tenants,
    devices,
    pending,
    buffer,
    serverMode,
    wsLimiter,
    log,
  });

  const server = await startServer({
    config,
    mcp: { config, tenants, mcpLimiter, authFailLimiter, dispatcher },
    admin: {
      adminToken: config.adminToken,
      tenants,
      devices,
      serverMode,
      startedAt: Date.now(),
      log,
    },
    deviceSocket,
    authFailLimiter,
    log,
  });

  return {
    server,
    db,
    close: async () => {
      await server.close();
      db.close();
    },
  };
}
