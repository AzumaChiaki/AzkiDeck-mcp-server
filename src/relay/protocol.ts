import { isObject } from '../core/jsonrpc.js';
import type { Tool } from '../mcp/toolClassify.js';
import { annotateTool } from '../mcp/toolAnnotations.js';

/** 设备 ↔ 服务器 WS 协议 v1:信封类型与手写校验守卫。 */

export const PROTOCOL_VERSION = 1;

export const CLOSE_REPLACED = 4000;
export const CLOSE_AUTH_FAILED = 4001;
export const CLOSE_RATE_LIMITED = 4002;
export const CLOSE_REAUTH_REQUIRED = 4003;

export interface RegisterMsg {
  type: 'register';
  protocol: number;
  credential: string;
  deployment_key?: string;
  device_id: string;
  platform: 'android' | 'ios' | 'unknown';
  app_version: string;
  server_name: string;
  tools: Tool[];
}

export type RegisterErrorCode =
  | 'invalid_credential'
  | 'credential_revoked'
  | 'auto_register_disabled'
  | 'deployment_key_required'
  | 'bad_deployment_key'
  | 'reauth_required'
  | 'unsupported_protocol'
  | 'rate_limited';

export type RelayEnvelope =
  | { type: 'registered'; protocol: number; device_id: string; heartbeat_interval_ms: number; replayed: number; server_time: number }
  | { type: 'register_error'; code: RegisterErrorCode; message: string }
  | { type: 'mcp-request'; rid: string; payload: unknown }
  | { type: 'replay'; items: { rid: string; queued_at: number; payload: unknown }[] }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number }
  | { type: 'error'; code: 'bad_envelope' | 'oversized' | 'not_registered'; message: string };

export type DeviceMessage =
  | RegisterMsg
  | { type: 'mcp-response'; rid: string; payload?: unknown; error?: { code: number; message: string } }
  | { type: 'pong'; ts?: number };

export function parseRegister(v: unknown): RegisterMsg | null {
  if (!isObject(v)) return null;
  if (v['type'] !== 'register') return null;
  if (v['protocol'] !== PROTOCOL_VERSION) return null;
  if (typeof v['credential'] !== 'string') return null;
  if (typeof v['device_id'] !== 'string' || v['device_id'] === '') return null;
  const platform = v['platform'];
  const tools = v['tools'];
  return {
    type: 'register',
    protocol: PROTOCOL_VERSION,
    credential: v['credential'],
    ...(typeof v['deployment_key'] === 'string' ? { deployment_key: v['deployment_key'] } : {}),
    device_id: v['device_id'],
    platform: platform === 'android' || platform === 'ios' ? platform : 'unknown',
    app_version: typeof v['app_version'] === 'string' ? v['app_version'] : '',
    server_name: typeof v['server_name'] === 'string' && v['server_name'] !== '' ? v['server_name'] : 'azki-watch',
    tools: sanitizeTools(tools),
  };
}

function sanitizeTools(v: unknown): Tool[] {
  if (!Array.isArray(v)) return [];
  const out: Tool[] = [];
  for (const item of v) {
    if (!isObject(item)) continue;
    if (typeof item['name'] !== 'string' || item['name'] === '') continue;
    const t: Tool = { name: item['name'] };
    if (typeof item['description'] === 'string') t.description = item['description'];
    if (isObject(item['inputSchema'])) t.inputSchema = item['inputSchema'];
    if (isObject(item['annotations'])) t.annotations = item['annotations'];
    out.push(annotateTool(t));
    if (out.length >= 128) break; // 防御性上限
  }
  return out;
}

export function parseDeviceMessage(v: unknown): DeviceMessage | null {
  if (!isObject(v)) return null;
  if (v['type'] === 'register') return parseRegister(v);
  if (v['type'] === 'mcp-response' && typeof v['rid'] === 'string') {
    const msg: DeviceMessage = { type: 'mcp-response', rid: v['rid'] };
    if ('payload' in v) (msg as { payload?: unknown }).payload = v['payload'];
    if ('error' in v && isObject(v['error']) && typeof v['error']['code'] === 'number') {
      (msg as { error?: { code: number; message: string } }).error = {
        code: v['error']['code'],
        message: typeof v['error']['message'] === 'string' ? v['error']['message'] : '设备处理失败',
      };
    }
    return msg;
  }
  if (v['type'] === 'pong') {
    return { type: 'pong', ...(typeof v['ts'] === 'number' ? { ts: v['ts'] } : {}) };
  }
  return null;
}
