import type { Tool } from '../mcp/toolClassify.js';
import { annotateTool, mergeToolAnnotations } from '../mcp/toolAnnotations.js';
import type { RelayEnvelope } from '../relay/protocol.js';

export interface DeviceSession {
  deviceId: string;
  tenantId: string;
  platform: 'android' | 'ios' | 'unknown';
  appVersion: string;
  serverName: string;
  tools: Tool[];
  connectedAt: number;
  lastActiveAt: number;
  send(envelope: RelayEnvelope): void;
  close(code: number, reason: string): void;
}

/**
 * 在线设备会话表。键为 tenantId → deviceId。
 * 归属表按设备粒度保留,tools/call 由 Router 用 pickForTool 决策。
 */
export class DeviceRegistry {
  private readonly sessions = new Map<string, Map<string, DeviceSession>>();

  /** 加入会话;同 deviceId 已有旧会话时返回旧会话(调用方负责踢掉)。 */
  add(session: DeviceSession): DeviceSession | null {
    let bucket = this.sessions.get(session.tenantId);
    if (!bucket) {
      bucket = new Map();
      this.sessions.set(session.tenantId, bucket);
    }
    const old = bucket.get(session.deviceId) ?? null;
    bucket.set(session.deviceId, session);
    return old;
  }

  remove(tenantId: string, deviceId: string): void {
    const bucket = this.sessions.get(tenantId);
    if (!bucket) return;
    bucket.delete(deviceId);
    if (bucket.size === 0) this.sessions.delete(tenantId);
  }

  get(tenantId: string, deviceId: string): DeviceSession | null {
    return this.sessions.get(tenantId)?.get(deviceId) ?? null;
  }

  onlineFor(tenantId: string): DeviceSession[] {
    return [...(this.sessions.get(tenantId)?.values() ?? [])];
  }

  onlineCount(): number {
    let n = 0;
    for (const bucket of this.sessions.values()) n += bucket.size;
    return n;
  }

  /** 声明了该工具的在线设备中,取最近活跃者。 */
  pickForTool(tenantId: string, toolName: string): DeviceSession | null {
    let best: DeviceSession | null = null;
    for (const s of this.onlineFor(tenantId)) {
      if (!s.tools.some((t) => t.name === toolName)) continue;
      if (!best || s.lastActiveAt > best.lastActiveAt) best = s;
    }
    return best;
  }

  touch(tenantId: string, deviceId: string, now: number): void {
    const s = this.get(tenantId, deviceId);
    if (s) s.lastActiveAt = now;
  }

  /** 按 name 去重,描述/参数先到先得,行为提示取所有候选设备的风险并集。 */
  toolsFor(tenantId: string): Tool[] {
    const out = new Map<string, ReturnType<typeof annotateTool>>();
    for (const s of this.onlineFor(tenantId)) {
      for (const t of s.tools) {
        const tool = annotateTool(t);
        const previous = out.get(t.name);
        out.set(t.name, previous
          ? { ...previous, annotations: mergeToolAnnotations(previous.annotations, tool.annotations) }
          : tool);
      }
    }
    return [...out.values()];
  }

  /** 踢掉某租户全部在线设备(模式切换 require_reauth 用),返回被踢的会话。 */
  evictTenant(tenantId: string, code: number, reason: string): DeviceSession[] {
    const sessions = this.onlineFor(tenantId);
    for (const s of sessions) {
      try {
        s.close(code, reason);
      } catch {
        // close 失败不影响其他设备
      }
    }
    return sessions;
  }

  evictAll(code: number, reason: string): void {
    for (const tenantId of [...this.sessions.keys()]) {
      this.evictTenant(tenantId, code, reason);
    }
  }
}
