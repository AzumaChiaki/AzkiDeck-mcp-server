import type { JsonRpcRequest } from './jsonrpc.js';
import { isObject } from './jsonrpc.js';

export interface BufferedItem {
  /** 补发时用作 replay 条目的 payload */
  request: JsonRpcRequest;
  queuedAt: number;
}

/**
 * 每租户离线缓冲:只放通知类工具调用。
 * 压实规则(入队时执行,避免补发垃圾):
 *  - report_progress:同 task 只留最新一条
 *  - clear_notification:抵消缓冲中对应的待发通知
 *  - send_notification:不去重
 */
export class ReplayBuffer {
  private readonly buckets = new Map<string, BufferedItem[]>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxItems: number,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(tenantId: string, request: JsonRpcRequest): void {
    this.prune(tenantId);
    let items = this.buckets.get(tenantId);
    if (!items) {
      items = [];
      this.buckets.set(tenantId, items);
    }
    this.compact(items, request);
    items.push({ request, queuedAt: this.now() });
    while (items.length > this.maxItems) items.shift();
  }

  /** 取出并清空(设备重连补发时调用)。 */
  drain(tenantId: string): BufferedItem[] {
    this.prune(tenantId);
    const items = this.buckets.get(tenantId) ?? [];
    this.buckets.delete(tenantId);
    return items;
  }

  clear(tenantId: string): void {
    this.buckets.delete(tenantId);
  }

  size(tenantId: string): number {
    this.prune(tenantId);
    return this.buckets.get(tenantId)?.length ?? 0;
  }

  private prune(tenantId: string): void {
    const items = this.buckets.get(tenantId);
    if (!items) return;
    const cutoff = this.now() - this.ttlMs;
    const kept = items.filter((i) => i.queuedAt >= cutoff);
    if (kept.length === 0) this.buckets.delete(tenantId);
    else if (kept.length !== items.length) this.buckets.set(tenantId, kept);
  }

  private compact(items: BufferedItem[], incoming: JsonRpcRequest): void {
    const params = isObject(incoming.params) ? incoming.params : {};
    const args = isObject(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};

    if (incoming.method !== 'tools/call') return;
    const name = typeof params['name'] === 'string' ? params['name'] : '';

    if (name === 'report_progress') {
      const task = typeof args['task'] === 'string' ? args['task'] : null;
      if (!task) return;
      // 同 task 只留最新
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (!item) continue;
        const old = toolCallOf(item);
        if (old?.name === 'report_progress' && old.args['task'] === task) items.splice(i, 1);
      }
      return;
    }

    if (name === 'clear_notification') {
      const notifId = args['notification_id'];
      const task = typeof args['task'] === 'string' ? args['task'] : null;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (!item) continue;
        const old = toolCallOf(item);
        if (!old) continue;
        if (old.name === 'send_notification' || old.name === 'report_progress') {
          const matchId =
            notifId !== undefined && old.args['notification_id'] === notifId;
          const matchTask = task !== null && old.args['task'] === task;
          if (matchId || matchTask) items.splice(i, 1);
        }
      }
    }
  }
}

function toolCallOf(item: BufferedItem): { name: string; args: Record<string, unknown> } | null {
  const p = item.request.params;
  if (!isObject(p)) return null;
  const name = typeof p['name'] === 'string' ? p['name'] : null;
  const args = isObject(p['arguments']) ? (p['arguments'] as Record<string, unknown>) : {};
  return name ? { name, args } : null;
}
