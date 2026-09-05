import type { WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { TenantRegistry } from '../core/tenants.js';
import type { DeviceRegistry, DeviceSession } from '../core/devices.js';
import type { PendingMap } from '../core/pending.js';
import { nextRid } from '../core/pending.js';
import type { ReplayBuffer } from '../core/buffer.js';
import type { ServerModeRegistry } from '../core/serverMode.js';
import type { RateLimiter } from '../core/ratelimit.js';
import { isValidCredential } from '../core/credentials.js';
import {
  parseDeviceMessage,
  type RelayEnvelope,
  type RegisterMsg,
  type RegisterErrorCode,
  CLOSE_REPLACED,
  CLOSE_AUTH_FAILED,
} from './protocol.js';

export interface DeviceSocketDeps {
  config: Config;
  tenants: TenantRegistry;
  devices: DeviceRegistry;
  pending: PendingMap;
  buffer: ReplayBuffer;
  serverMode: ServerModeRegistry;
  wsLimiter: RateLimiter;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * /device 的 WS 接入:注册状态机、心跳、踢旧线、断连清理、补发。
 * 一个 WebSocket 对应一个 DeviceConn;register 成功后才升级为 DeviceSession。
 */
export class DeviceSocketHandler {
  /** 全员断连的租户 → 补发窗口截止时刻;窗内重连则补发。 */
  private readonly reconnectDeadlines = new Map<string, number>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: DeviceSocketDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  handle(ws: WebSocket): void {
    const conn = new DeviceConn(ws, this.deps, this, this.now, this.log, (c) => {
      this.onDeviceGone(c);
    });
    conn.start();
  }

  /** 设备断连:清理 pending、移出会话表、若全员离线启动补发窗口。 */
  private onDeviceGone(conn: DeviceConn): void {
    const session = conn.session;
    if (!session) return;
    this.deps.pending.failDevice(session);
    // 只有当前会话仍是登记的那个才移除(避免误删顶替者)
    const current = this.deps.devices.get(session.tenantId, session.deviceId);
    if (current === session) {
      this.deps.devices.remove(session.tenantId, session.deviceId);
    }
    if (this.deps.devices.onlineFor(session.tenantId).length === 0) {
      this.reconnectDeadlines.set(session.tenantId, this.now() + this.deps.config.reconnectWindowMs);
      this.log(
        `租户 ${session.tenantId.slice(0, 8)} 全员离线,` +
          `补发窗口 ${Math.round(this.deps.config.reconnectWindowMs / 60000)} 分钟`,
      );
    }
  }

  /**
   * register 成功后的补发决策:只计算并取出待发条目,不发送。
   * 顺序由 DeviceConn 保证:registered → replay。
   */
  takeReplayItems(tenantId: string): { rid: string; queued_at: number; payload: unknown }[] {
    const deadline = this.reconnectDeadlines.get(tenantId);
    const withinWindow = deadline !== undefined && this.now() <= deadline;
    this.reconnectDeadlines.delete(tenantId);
    if (!withinWindow) {
      // 超窗(或本就不在窗口内):缓冲整桶丢弃
      this.deps.buffer.clear(tenantId);
      return [];
    }
    const items = this.deps.buffer.drain(tenantId);
    if (items.length === 0) return [];
    this.log(`租户 ${tenantId.slice(0, 8)} 补发 ${items.length} 条`);
    return items.map((i) => ({ rid: nextRid('replay'), queued_at: i.queuedAt, payload: i.request }));
  }

  /** 供测试与内省:某租户是否在补发窗口内。 */
  inReconnectWindow(tenantId: string): boolean {
    const d = this.reconnectDeadlines.get(tenantId);
    return d !== undefined && this.now() <= d;
  }
}

class DeviceConn {
  session: DeviceSession | null = null;
  private registered = false;
  private registerTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private cleaned = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: DeviceSocketDeps,
    private readonly handler: DeviceSocketHandler,
    private readonly now: () => number,
    private readonly log: (msg: string) => void,
    private readonly onGone: (conn: DeviceConn) => void,
  ) {}

  start(): void {
    const { config } = this.deps;
    this.registerTimer = setTimeout(() => {
      if (!this.registered) this.fail('bad_envelope', '注册超时', 1000);
    }, config.registerTimeoutMs);
    this.registerTimer.unref?.();

    this.ws.on('message', (data: Buffer) => this.onMessage(data));
    this.ws.on('pong', () => {
      this.missedPongs = 0;
    });
    this.ws.on('close', () => this.cleanup());
    this.ws.on('error', () => this.cleanup());
  }

  private onMessage(data: Buffer): void {
    const { config, wsLimiter } = this.deps;
    if (data.length > config.maxWsBytes) {
      this.send({ type: 'error', code: 'oversized', message: '消息过大' });
      return;
    }
    const limitKey = this.session ? `dev:${this.session.tenantId}:${this.session.deviceId}` : 'dev:unregistered';
    if (!wsLimiter.allow(limitKey)) {
      this.send({ type: 'error', code: 'bad_envelope', message: '消息过频' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      this.send({ type: 'error', code: 'bad_envelope', message: '不是合法 JSON' });
      return;
    }
    const msg = parseDeviceMessage(parsed);
    if (!msg) {
      this.send({ type: 'error', code: 'bad_envelope', message: '无法识别的消息' });
      return;
    }

    if (msg.type === 'register') {
      this.onRegister(msg);
      return;
    }
    if (!this.registered || !this.session) {
      this.send({ type: 'error', code: 'not_registered', message: '尚未注册' });
      return;
    }
    if (msg.type === 'mcp-response') {
      this.deps.devices.touch(this.session.tenantId, this.session.deviceId, this.now());
      this.deps.pending.resolveFromDevice(this.session, msg.rid, msg.payload, msg.error);
      return;
    }
    // pong:应用层兜底,无需处理
  }

  private onRegister(msg: RegisterMsg): void {
    if (this.registered) {
      this.send({ type: 'error', code: 'bad_envelope', message: '重复注册' });
      return;
    }
    const failReg = (code: RegisterErrorCode, message: string) => {
      this.send({ type: 'register_error', code, message });
      try {
        this.ws.close(CLOSE_AUTH_FAILED, code);
      } catch {
        /* 已关闭 */
      }
      this.cleanup();
    };

    if (!isValidCredential(msg.credential)) {
      failReg('invalid_credential', '凭证格式不合法');
      return;
    }

    // 私有模式:校验部署密钥
    const keyCheck = this.deps.serverMode.checkDeploymentKey(msg.deployment_key);
    if (keyCheck === 'missing') {
      failReg('deployment_key_required', '服务器为私有模式,注册需要提供部署密钥');
      return;
    }
    if (keyCheck === 'mismatch') {
      failReg('bad_deployment_key', '部署密钥不正确');
      return;
    }
    if (keyCheck === 'not_configured') {
      failReg('bad_deployment_key', '服务器为私有模式但尚未设置部署密钥');
      return;
    }

    const resolved = this.deps.tenants.resolveDevice(msg.credential);
    if (!resolved.ok) {
      failReg(
        resolved.reason === 'credential_revoked' ? 'credential_revoked' : 'auto_register_disabled',
        resolved.reason === 'credential_revoked' ? '凭证已被管理员撤销' : '未知凭证(服务器已关闭自动注册)',
      );
      return;
    }

    const tenant = resolved.tenant;
    const now = this.now();
    const session: DeviceSession = {
      deviceId: msg.device_id,
      tenantId: tenant.id,
      platform: msg.platform,
      appVersion: msg.app_version,
      serverName: msg.server_name,
      tools: msg.tools,
      connectedAt: now,
      lastActiveAt: now,
      send: (env: RelayEnvelope) => this.send(env),
      close: (code: number, reason: string) => {
        try {
          this.ws.close(code, reason);
        } catch {
          /* 已关闭 */
        }
      },
    };

    // 同 deviceId 重复连接:踢旧线
    const old = this.deps.devices.add(session);
    if (old && old !== session) {
      this.log(`设备 ${msg.device_id.slice(0, 8)} 重复连接,踢掉旧会话`);
      old.close(CLOSE_REPLACED, 'replaced');
    }

    // 刷新租户快照(离线期 tools/list 用);重新认证成功则清除标记
    this.deps.tenants.updateSnapshot(tenant.id, msg.server_name, msg.tools);
    if (tenant.reauthRequiredAt !== null) {
      this.deps.tenants.clearReauthRequired(tenant.id);
    }

    this.registered = true;
    this.session = session;
    if (this.registerTimer) {
      clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
    this.startHeartbeat();

    // 顺序:registered(含补发计数) → replay(逐条)
    const replayItems = this.handler.takeReplayItems(tenant.id);
    this.send({
      type: 'registered',
      protocol: 1,
      device_id: msg.device_id,
      heartbeat_interval_ms: this.deps.config.heartbeatIntervalMs,
      replayed: replayItems.length,
      server_time: now,
    });
    if (replayItems.length > 0) {
      this.send({ type: 'replay', items: replayItems });
    }
  }

  private startHeartbeat(): void {
    const { config } = this.deps;
    this.heartbeatTimer = setInterval(() => {
      this.missedPongs++;
      if (this.missedPongs > config.heartbeatMissLimit) {
        this.log(`设备 ${this.session?.deviceId.slice(0, 8) ?? '?'} 心跳超时,断开`);
        try {
          this.ws.terminate();
        } catch {
          /* 已断开 */
        }
        this.cleanup();
        return;
      }
      try {
        this.ws.ping();
      } catch {
        /* 已断开 */
      }
    }, config.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private send(env: RelayEnvelope): void {
    try {
      this.ws.send(JSON.stringify(env));
    } catch {
      /* 发送失败由 close 事件收拾 */
    }
  }

  private fail(code: string, message: string, closeCode: number): void {
    this.send({ type: 'error', code: code as never, message });
    try {
      this.ws.close(closeCode, code);
    } catch {
      /* 已关闭 */
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.registerTimer) clearTimeout(this.registerTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.onGone(this);
  }
}
