import { describe, it, expect, afterEach } from 'vitest';
import { startTestApp, mcpPost, newCredential, FakeDevice } from './helpers.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function callTool(baseUrl: string, cred: string, name: string, args: Record<string, unknown>) {
  return mcpPost(baseUrl, cred, {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e6),
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

describe('离线补发', () => {
  it('设备离线:通知类排队成功应答;非通知类 -32002;tools/list 走缓存', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);
    dev.close();
    await dev.waitFor(() => dev.closeCode !== null);

    // tools/list 走缓存
    const list = await mcpPost(baseUrl, cred, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((list.body as { result: { tools: unknown[] } }).result.tools.length).toBe(4);

    // 通知类 → 排队
    const queued = await callTool(baseUrl, cred, 'send_notification', { title: '离线消息' });
    expect((queued.body as { result: { isError: boolean } }).result.isError).toBe(false);
    expect(
      (queued.body as { result: { content: { text: string }[] } }).result.content[0]!.text,
    ).toContain('排队');

    // 非通知类 → -32002
    const offline = await callTool(baseUrl, cred, 'watch_status', {});
    expect((offline.body as { error: { code: number } }).error.code).toBe(-32002);
  });

  it('10 分钟内重连 → 按序补发;压实规则生效(进度合并 + clear 抵消)', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ reconnectWindowMs: 60_000 });
    cleanups.push(() => app.close());
    const cred = newCredential();

    const dev1 = new FakeDevice(wsUrl, cred);
    await dev1.open();
    dev1.register();
    await dev1.waitFor(() => dev1.registeredMsg !== null);
    dev1.close();
    await dev1.waitFor(() => dev1.closeCode !== null);

    // 离线期间:进度×2(压实为 1)+ 通知×1 + clear 抵消通知 + 另 1 条通知
    await callTool(baseUrl, cred, 'report_progress', { task: 'build', percent: 10 });
    await callTool(baseUrl, cred, 'report_progress', { task: 'build', percent: 80 });
    await callTool(baseUrl, cred, 'send_notification', { title: '会被清掉', notification_id: 5 });
    await callTool(baseUrl, cred, 'clear_notification', { notification_id: 5 });
    await callTool(baseUrl, cred, 'send_notification', { title: '保留' });

    const dev2 = new FakeDevice(wsUrl, cred);
    await dev2.open();
    dev2.register();
    await dev2.waitFor(() => dev2.replayed.length > 0, 5000);

    const kinds = dev2.replayed.map(
      (i) => (i.payload as { params: { name: string; arguments: Record<string, unknown> } }).params,
    );
    const progresses = kinds.filter((p) => p.name === 'report_progress');
    const notifs = kinds.filter((p) => p.name === 'send_notification');
    const clears = kinds.filter((p) => p.name === 'clear_notification');
    expect(progresses).toHaveLength(1);
    expect(progresses[0]!.arguments['percent']).toBe(80);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.arguments['title']).toBe('保留');
    expect(clears).toHaveLength(1);
    dev2.close();
  });

  it('超过重连窗口后注册 → 不补发', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ reconnectWindowMs: 200 });
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev1 = new FakeDevice(wsUrl, cred);
    await dev1.open();
    dev1.register();
    await dev1.waitFor(() => dev1.registeredMsg !== null);
    dev1.close();
    await dev1.waitFor(() => dev1.closeCode !== null);

    await callTool(baseUrl, cred, 'send_notification', { title: '过期消息' });
    await new Promise((r) => setTimeout(r, 400)); // 等窗口过期

    const dev2 = new FakeDevice(wsUrl, cred);
    await dev2.open();
    dev2.register();
    await dev2.waitFor(() => dev2.registeredMsg !== null);
    expect(dev2.registeredMsg!['replayed']).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(dev2.replayed).toHaveLength(0);
    dev2.close();
  });
});
