#!/usr/bin/env node
/**
 * 假设备(开发/联调用具):连上中继、注册、回显收到的 tools/call。
 *
 * 用法:
 *   node scripts/fake-device.mjs --server ws://127.0.0.1:8787 --credential <hex> [--key <部署密钥>]
 *
 * 收到 mcp-request 时打印 payload,并自动回一个 "ok" 结果;replay 条目只打印。
 */
import WebSocket from 'ws';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const server = arg('server') ?? 'ws://127.0.0.1:8787';
const credential = arg('credential');
const deploymentKey = arg('key');
if (!credential) {
  console.error('缺少 --credential <hex>');
  process.exit(1);
}

const deviceId = `fake-${Math.random().toString(16).slice(2, 10)}`;
const tools = [
  { name: 'send_notification', description: '推送通知', inputSchema: { type: 'object' } },
  { name: 'report_progress', description: '上报进度', inputSchema: { type: 'object' } },
  { name: 'request_action', description: '请求操作', inputSchema: { type: 'object' } },
  { name: 'clear_notification', description: '清除通知', inputSchema: { type: 'object' } },
  { name: 'watch_status', description: '手表状态', inputSchema: { type: 'object' } },
];

let attempt = 0;
function connect() {
  const ws = new WebSocket(`${server}/device`);
  ws.on('open', () => {
    attempt = 0;
    console.log(`[fake-device] 已连接 ${server},注册中(deviceId=${deviceId})`);
    ws.send(
      JSON.stringify({
        type: 'register',
        protocol: 1,
        credential,
        ...(deploymentKey ? { deployment_key: deploymentKey } : {}),
        device_id: deviceId,
        platform: 'android',
        app_version: 'fake-0.0.0',
        server_name: 'azki-watch',
        tools,
      }),
    );
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'registered') {
      console.log(`[fake-device] 注册成功,补发 ${msg.replayed} 条`);
      return;
    }
    if (msg.type === 'register_error') {
      console.error(`[fake-device] 注册被拒: ${msg.code} — ${msg.message}`);
      return;
    }
    if (msg.type === 'mcp-request') {
      const p = msg.payload;
      console.log(`[fake-device] tools/call: ${p?.params?.name}`, JSON.stringify(p?.params?.arguments ?? {}));
      ws.send(
        JSON.stringify({
          type: 'mcp-response',
          rid: msg.rid,
          payload: {
            jsonrpc: '2.0',
            id: p?.id ?? null,
            result: { content: [{ type: 'text', text: 'ok(假设备)' }], isError: false },
          },
        }),
      );
      return;
    }
    if (msg.type === 'replay') {
      for (const item of msg.items) {
        console.log(`[fake-device] 补发(${new Date(item.queued_at).toISOString()}):`, JSON.stringify(item.payload?.params ?? {}));
        ws.send(
          JSON.stringify({
            type: 'mcp-response',
            rid: item.rid,
            payload: { jsonrpc: '2.0', id: null, result: { content: [], isError: false } },
          }),
        );
      }
      return;
    }
  });
  ws.on('close', (code, reason) => {
    const delay = Math.min(30_000, 1000 * 2 ** attempt) * (1 + Math.random() * 0.2 - 0.1);
    attempt = Math.min(attempt + 1, 5);
    console.log(`[fake-device] 连接关闭(code=${code} ${reason}),${Math.round(delay)}ms 后重连`);
    if (code === 4001) {
      console.error('[fake-device] 鉴权失败,不再重连,请检查凭证/部署密钥');
      process.exit(1);
    }
    setTimeout(connect, delay);
  });
  ws.on('error', () => {});
}
connect();
