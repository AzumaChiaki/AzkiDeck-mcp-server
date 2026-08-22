import type { JsonRpcRequest, JsonRpcResponse } from '../core/jsonrpc.js';
import { result, error, isNotification, isObject, METHOD_NOT_FOUND } from '../core/jsonrpc.js';
import type { Tenant } from '../core/tenants.js';
import type { Router } from '../core/router.js';
import type { DeviceRegistry } from '../core/devices.js';
import type { Tool } from './toolClassify.js';

/** 与手机端 McpEndpoint 一致的协议版本协商集。 */
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_VERSION = '2025-03-26';

const SERVER_VERSION = '0.1.0';

export interface DispatcherDeps {
  router: Router;
  devices: DeviceRegistry;
}

/**
 * 无状态 MCP 分发:initialize/ping/tools/list 本地应答,
 * tools/call 交给 Router 下穿到设备。行为与手机端 McpEndpoint 同构。
 */
export class McpDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  /** 返回 null 表示这是通知,无响应(HTTP 层据此可能回 202)。 */
  async dispatch(tenant: Tenant, req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = 'id' in req ? (req.id ?? null) : null;

    // 通知类:吞掉
    if (isNotification(req)) return null;

    switch (req.method) {
      case 'initialize':
        return result(id, this.initializeResult(tenant, req));
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: this.toolsFor(tenant) });
      case 'tools/call':
        return this.deps.router.callTool(tenant, id, req);
      case 'resources/list':
        return result(id, { resources: [] });
      case 'resources/templates/list':
        return result(id, { resourceTemplates: [] });
      case 'prompts/list':
        return result(id, { prompts: [] });
      case 'logging/setLevel':
        return result(id, {});
      default:
        return error(id, METHOD_NOT_FOUND, `未知方法: ${req.method}`);
    }
  }

  private initializeResult(tenant: Tenant, req: JsonRpcRequest): Record<string, unknown> {
    const params = isObject(req.params) ? req.params : {};
    const clientVersion = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
    const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(clientVersion)
      ? clientVersion
      : DEFAULT_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: tenant.serverName, version: SERVER_VERSION },
      instructions:
        '该服务由 AzkiDeck 中继,工具实际在用户的手机 App 上执行(通知推送到手表、资源安装等)。' +
        '设备离线时通知类调用会排队,设备重连后补发;其他调用会立即失败。',
    };
  }

  /** 有在线设备 → 实时聚合;全员离线 → 租户缓存快照。 */
  private toolsFor(tenant: Tenant): Tool[] {
    const live = this.deps.devices.toolsFor(tenant.id);
    if (live.length > 0) return live;
    return tenant.toolCache;
  }
}
