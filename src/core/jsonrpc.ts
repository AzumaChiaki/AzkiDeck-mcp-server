/** JSON-RPC 2.0 最小实现:类型、解析、响应构造。与手机端 McpEndpoint 同构。 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** 通知没有 id */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
/** 服务器自定义:设备离线 */
export const DEVICE_OFFLINE = -32002;
/** 服务器自定义:租户待重新认证(模式切换 require_reauth) */
export const TENANT_REAUTH_REQUIRED = -32003;
/** 服务器自定义:设备处理异常透传之外的兜底 */
export const INTERNAL_ERROR = -32603;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isValidId(id: unknown): id is string | number | null {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

/** 宽松解析单条消息;不合法返回 null(由调用方构造 INVALID_REQUEST)。 */
export function parseRequest(v: unknown): JsonRpcRequest | null {
  if (!isObject(v)) return null;
  if (v['jsonrpc'] !== '2.0') return null;
  if (typeof v['method'] !== 'string' || v['method'] === '') return null;
  if ('id' in v && !isValidId(v['id'])) return null;
  const req: JsonRpcRequest = { jsonrpc: '2.0', method: v['method'] };
  if ('id' in v) req.id = v['id'] as JsonRpcId;
  if ('params' in v) req.params = v['params'];
  return req;
}

/** 判断是否为通知(无 id)。 */
export function isNotification(req: JsonRpcRequest): boolean {
  return !('id' in req);
}

export function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

export function error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  const e: JsonRpcErrorShape = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: '2.0', id, error: e };
}
