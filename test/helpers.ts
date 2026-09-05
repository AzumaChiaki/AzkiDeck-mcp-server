import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/index.js';
import { generateCredential } from '../src/core/credentials.js';
import WebSocket from 'ws';
import type { Tool } from '../src/mcp/toolClassify.js';

/** 测试基座:内存库 + 随机端口 + 收紧的超时/心跳。 */
export async function startTestApp(overrides: Partial<Config> = {}): Promise<{
  app: App;
  baseUrl: string;
  wsUrl: string;
  config: Config;
}> {
  const config: Config = {
    ...loadConfig({}),
    host: '127.0.0.1',
    port: 0,
    dataDir: ':memory:',
    registerTimeoutMs: 2000,
    heartbeatIntervalMs: 50_000, // 测试里不希望心跳干扰;需要时单独覆盖
    ...overrides,
  };
  const app = await createApp(config);
  return {
    app,
    baseUrl: `http://127.0.0.1:${app.server.port}`,
    wsUrl: `ws://127.0.0.1:${app.server.port}/device`,
    config,
  };
}

export function mcpHeaders(credential: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${credential}`,
  };
}

export async function mcpPost(
  baseUrl: string,
  credential: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(credential),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export const SAMPLE_TOOLS = [
  { name: 'send_notification', description: '推送通知', inputSchema: { type: 'object' } },
  { name: 'report_progress', description: '上报进度', inputSchema: { type: 'object' } },
  { name: 'clear_notification', description: '清除通知', inputSchema: { type: 'object' } },
  { name: 'watch_status', description: '手表状态', inputSchema: { type: 'object' } },
];

/** 假设备:连 WS、注册、按脚本回包。 */
export class FakeDevice {
  readonly credential: string;
  readonly deviceId: string;
  readonly deploymentKey: string | undefined;
  ws: WebSocket | null = null;
  received: { rid: string; payload: unknown }[] = [];
  replayed: { rid: string; queued_at: number; payload: unknown }[] = [];
  registeredMsg: Record<string, unknown> | null = null;
  registerError: Record<string, unknown> | null = null;
  closeCode: number | null = null;
  /** 收到 mcp-request 时的回包策略;返回 null 表示不回包(测试超时) */
  responder: (payload: unknown) => { payload?: unknown; error?: { code: number; message: string } } | null = (
    payload,
  ) => ({
    payload: {
      jsonrpc: '2.0',
      id: (payload as { id?: unknown }).id ?? null,
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
    },
  });

  constructor(wsUrl: string, credential: string, deviceId = 'dev-test-1', deploymentKey?: string) {
    this.credential = credential;
    this.deviceId = deviceId;
    this.deploymentKey = deploymentKey;
    this.ws = new WebSocket(wsUrl);
    this.ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (msg['type'] === 'registered') this.registeredMsg = msg;
      if (msg['type'] === 'register_error') this.registerError = msg;
      if (msg['type'] === 'mcp-request') {
        this.received.push({ rid: msg['rid'] as string, payload: msg['payload'] });
        const r = this.responder(msg['payload']);
        if (r === null) return;
        this.ws?.send(JSON.stringify({ type: 'mcp-response', rid: msg['rid'], ...r }));
      }
      if (msg['type'] === 'replay') {
        for (const item of msg['items'] as { rid: string; queued_at: number; payload: unknown }[]) {
          this.replayed.push(item);
          this.ws?.send(
            JSON.stringify({
              type: 'mcp-response',
              rid: item.rid,
              payload: { jsonrpc: '2.0', id: null, result: { content: [], isError: false } },
            }),
          );
        }
      }
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
    });
  }

  async open(): Promise<void> {
    if (this.ws!.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', resolve);
      this.ws!.once('error', reject);
    });
  }

  register(tools: Tool[] = SAMPLE_TOOLS): void {
    this.ws!.send(
      JSON.stringify({
        type: 'register',
        protocol: 1,
        credential: this.credential,
        ...(this.deploymentKey ? { deployment_key: this.deploymentKey } : {}),
        device_id: this.deviceId,
        platform: 'android',
        app_version: '0.0.0-test',
        server_name: 'azki-watch',
        tools,
      }),
    );
  }

  async waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void {
    this.ws?.close();
  }
}

export function newCredential(): string {
  return generateCredential();
}
