import type { JsonRpcResponse } from './jsonrpc.js';
import { error, DEVICE_OFFLINE, INTERNAL_ERROR } from './jsonrpc.js';

interface PendingEntry {
  tenantId: string;
  deviceId: string;
  /** 客户端侧 JSON-RPC id,回包时原样带回 */
  clientId: string | number | null;
  timer: ReturnType<typeof setTimeout>;
  settle: (resp: JsonRpcResponse) => void;
}

let counter = 0;

/** 中继侧关联 id:单调递增、可排序、带前缀便于日志识别。 */
export function nextRid(prefix = 'r'): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * rid → 等待中的 Promise。设备断连时该设备全部 pending 快速失败。
 */
export class PendingMap {
  private readonly entries = new Map<string, PendingEntry>();

  create(opts: {
    tenantId: string;
    deviceId: string;
    clientId: string | number | null;
    timeoutMs: number;
  }): { rid: string; promise: Promise<JsonRpcResponse> } {
    const rid = nextRid();
    const promise = new Promise<JsonRpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.entries.delete(rid);
        resolve(error(opts.clientId, DEVICE_OFFLINE, '设备响应超时'));
      }, opts.timeoutMs);
      timer.unref?.();
      this.entries.set(rid, {
        tenantId: opts.tenantId,
        deviceId: opts.deviceId,
        clientId: opts.clientId,
        timer,
        settle: resolve,
      });
    });
    return { rid, promise };
  }

  /** 设备回包。payload 必须是带 id 的 JSON-RPC 响应;id 以客户端侧为准。 */
  resolve(rid: string, payload: unknown, err?: { code: number; message: string }): boolean {
    const entry = this.entries.get(rid);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(rid);
    if (err) {
      entry.settle(error(entry.clientId, err.code, err.message));
    } else if (
      typeof payload === 'object' &&
      payload !== null &&
      ('result' in payload || 'error' in payload)
    ) {
      // 透传设备响应,但 id 以客户端侧为准(设备应原样带回,这里兜底)
      entry.settle({ ...(payload as JsonRpcResponse), jsonrpc: '2.0', id: entry.clientId });
    } else {
      entry.settle(error(entry.clientId, INTERNAL_ERROR, '设备返回了无效的响应'));
    }
    return true;
  }

  /** 设备断连:该设备全部 pending 立即失败。 */
  failDevice(deviceId: string, message = '设备连接已断开'): number {
    let n = 0;
    for (const [rid, entry] of [...this.entries]) {
      if (entry.deviceId !== deviceId) continue;
      clearTimeout(entry.timer);
      this.entries.delete(rid);
      entry.settle(error(entry.clientId, DEVICE_OFFLINE, message));
      n++;
    }
    return n;
  }

  size(): number {
    return this.entries.size;
  }
}
