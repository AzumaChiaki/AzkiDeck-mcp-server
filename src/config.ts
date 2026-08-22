/** 服务器配置：全部来自环境变量,纯函数解析,便于测试。 */
export interface Config {
  /** 监听地址,默认 0.0.0.0 */
  host: string;
  /** 监听端口,默认 8787 */
  port: number;
  /** 数据目录(SQLite 所在),默认 ./data */
  dataDir: string;
  /** 公开模式允许设备首连自动建租户,默认 true;私有模式下此开关无效(必须有部署密钥) */
  autoRegister: boolean;
  /** 管理面令牌;不设置则 /admin/* 整体关闭 */
  adminToken: string | null;
  /** 内置 TLS 证书/私钥路径;两者都设置时启用 https/wss */
  tlsCert: string | null;
  tlsKey: string | null;
  /** HTTP body 上限,默认 1 MiB */
  maxBodyBytes: number;
  /** WS 单帧上限,默认 1 MiB */
  maxWsBytes: number;
  /** tools/call 默认超时 ms,默认 30000 */
  callTimeoutMs: number;
  /** install_* 工具超时 ms,默认 60000 */
  installTimeoutMs: number;
  /** register 超时 ms,默认 10000 */
  registerTimeoutMs: number;
  /** WS 心跳间隔 ms,默认 25000 */
  heartbeatIntervalMs: number;
  /** 心跳容忍缺失次数,默认 2 */
  heartbeatMissLimit: number;
  /** 离线缓冲 TTL ms,默认 5 分钟 */
  bufferTtlMs: number;
  /** 每租户缓冲上限,默认 200 */
  bufferMaxItems: number;
  /** 断连后补发窗口 ms,默认 10 分钟 */
  reconnectWindowMs: number;
  /** 每租户 MCP 限流(req/min),默认 120 */
  rateMcpPerMinute: number;
  /** 每设备 WS 限流(msg/min),默认 600 */
  rateWsPerMinute: number;
  /** 401 按 IP 限流(次/min),默认 20 */
  rateAuthFailPerMinute: number;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`配置项 ${key} 不是正整数: ${raw}`);
  }
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function str(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  return raw === undefined || raw === '' ? null : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: str(env, 'HOST') ?? '0.0.0.0',
    port: int(env, 'PORT', 8787),
    dataDir: str(env, 'DATA_DIR') ?? './data',
    autoRegister: bool(env, 'AUTO_REGISTER', true),
    adminToken: str(env, 'ADMIN_TOKEN'),
    tlsCert: str(env, 'TLS_CERT'),
    tlsKey: str(env, 'TLS_KEY'),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 1 << 20),
    maxWsBytes: int(env, 'MAX_WS_BYTES', 1 << 20),
    callTimeoutMs: int(env, 'CALL_TIMEOUT_MS', 30_000),
    installTimeoutMs: int(env, 'INSTALL_TIMEOUT_MS', 60_000),
    registerTimeoutMs: int(env, 'REGISTER_TIMEOUT_MS', 10_000),
    heartbeatIntervalMs: int(env, 'HEARTBEAT_INTERVAL_MS', 25_000),
    heartbeatMissLimit: int(env, 'HEARTBEAT_MISS_LIMIT', 2),
    bufferTtlMs: int(env, 'BUFFER_TTL_MS', 5 * 60_000),
    bufferMaxItems: int(env, 'BUFFER_MAX_ITEMS', 200),
    reconnectWindowMs: int(env, 'RECONNECT_WINDOW_MS', 10 * 60_000),
    rateMcpPerMinute: int(env, 'RATE_MCP_PER_MINUTE', 120),
    rateWsPerMinute: int(env, 'RATE_WS_PER_MINUTE', 600),
    rateAuthFailPerMinute: int(env, 'RATE_AUTH_FAIL_PER_MINUTE', 20),
  };
}
