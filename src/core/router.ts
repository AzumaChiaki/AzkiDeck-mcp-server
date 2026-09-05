import type { DeviceRegistry, DeviceSession } from './devices.js';
import type { PendingMap } from './pending.js';
import type { ReplayBuffer } from './buffer.js';
import type { Tenant } from './tenants.js';
import type { JsonRpcRequest, JsonRpcResponse } from './jsonrpc.js';
import { error, isObject, DEVICE_OFFLINE, METHOD_NOT_FOUND, TENANT_REAUTH_REQUIRED } from './jsonrpc.js';
import { isNotificationTool, timeoutForTool } from '../mcp/toolClassify.js';

export type RouteDecision =
  | { kind: 'relay'; device: DeviceSession }
  | { kind: 'queued' }
  | { kind: 'error'; code: number; message: string };

export interface RouterDeps {
  devices: DeviceRegistry;
  pending: PendingMap;
  buffer: ReplayBuffer;
  callTimeoutMs: number;
  installTimeoutMs: number;
  now?: () => number;
}

/**
 * tools/call 的唯一决策点:
 * 在线设备声明了该工具 → 中继下发,最近活跃优先;
 * 全员离线 + 通知类 → 入缓冲,立即成功应答("已排队");
 * 全员离线 + 非通知类 → -32002;缓存里没这个工具 → -32601;
 * 租户待重新认证 → -32003。
 */
export class Router {
  private readonly now: () => number;

  constructor(private readonly deps: RouterDeps) {
    this.now = deps.now ?? Date.now;
  }

  async callTool(
    tenant: Tenant,
    clientId: string | number | null,
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    if (tenant.reauthRequiredAt !== null) {
      return error(clientId, TENANT_REAUTH_REQUIRED, '服务器已切换为私有模式,设备需重新认证后恢复服务');
    }

    const params = isObject(request.params) ? request.params : {};
    const toolName = typeof params['name'] === 'string' ? params['name'] : '';
    if (toolName === '') {
      return error(clientId, METHOD_NOT_FOUND, '未知工具: (缺少 name)');
    }

    const device = this.deps.devices.pickForTool(tenant.id, toolName);
    if (device) {
      return this.relay(tenant, device, clientId, request, toolName);
    }

    // 无在线设备声明该工具:查租户工具缓存区分「离线」与「未知工具」
    const known = tenant.toolCache.some((t) => t.name === toolName);
    if (!known) {
      return error(clientId, METHOD_NOT_FOUND, `未知工具: ${toolName}`);
    }
    if (isNotificationTool(toolName)) {
      this.deps.buffer.enqueue(tenant.id, request);
      return {
        jsonrpc: '2.0',
        id: clientId,
        result: {
          content: [
            {
              type: 'text',
              text: '设备离线,消息已排队,将在设备重连后补发(保留 5 分钟)。',
            },
          ],
          isError: false,
        },
      };
    }
    return error(clientId, DEVICE_OFFLINE, `设备离线,无法执行 ${toolName}`);
  }

  private async relay(
    tenant: Tenant,
    device: DeviceSession,
    clientId: string | number | null,
    request: JsonRpcRequest,
    toolName: string,
  ): Promise<JsonRpcResponse> {
    const timeoutMs = timeoutForTool(toolName, this.deps.callTimeoutMs, this.deps.installTimeoutMs);
    const { rid, promise } = this.deps.pending.create({
      owner: device,
      tenantId: tenant.id,
      deviceId: device.deviceId,
      clientId,
      timeoutMs,
    });
    this.deps.devices.touch(tenant.id, device.deviceId, this.now());
    try {
      device.send({ type: 'mcp-request', rid, payload: request });
    } catch {
      this.deps.pending.resolve(rid, undefined, { code: DEVICE_OFFLINE, message: '设备连接已断开' });
    }
    return promise;
  }
}
