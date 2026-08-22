import { describe, it, expect, afterEach } from 'vitest';
import { startTestApp, mcpPost, newCredential, FakeDevice, SAMPLE_TOOLS } from './helpers.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

describe('tools/call 路由', () => {
  it('在线设备收到 mcp-request,回包透传回 MCP 客户端', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const r = await mcpPost(baseUrl, cred, {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'send_notification', arguments: { title: '构建完成' } },
    });
    expect(r.status).toBe(200);
    const body = r.body as { id: number; result: { content: { text: string }[] } };
    expect(body.id).toBe(42);
    expect(body.result.content[0]!.text).toBe('ok');
    // 设备确实收到了原始 payload
    expect(dev.received).toHaveLength(1);
    expect(
      (dev.received[0]!.payload as { params: { arguments: { title: string } } }).params.arguments.title,
    ).toBe('构建完成');
    dev.close();
  });

  it('设备回 error → 透传 error', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred);
    dev.responder = () => ({
      error: { code: -32000, message: '手表未连接' },
      payload: undefined,
    });
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const r = await mcpPost(baseUrl, cred, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'send_notification', arguments: { title: 'x' } },
    });
    expect((r.body as { error: { code: number; message: string } }).error.code).toBe(-32000);
    expect((r.body as { error: { message: string } }).error.message).toBe('手表未连接');
    dev.close();
  });

  it('未知工具(缓存也没有)→ -32601', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const r = await mcpPost(baseUrl, cred, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });
    expect((r.body as { error: { code: number } }).error.code).toBe(-32601);
    dev.close();
  });

  it('设备中途断连 → pending 立即失败(-32002),不等超时', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ callTimeoutMs: 60_000 });
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred);
    dev.responder = () => {
      dev.close(); // 收到请求后立刻断线,永不回包
      return null;
    };
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const started = Date.now();
    const r = await mcpPost(baseUrl, cred, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_notification', arguments: { title: 'x' } },
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect((r.body as { error: { code: number } }).error.code).toBe(-32002);
  });

  it('请求超时 → -32002', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ callTimeoutMs: 300 });
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred);
    dev.responder = () => null; // 吞掉不回包
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const r = await mcpPost(baseUrl, cred, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_notification', arguments: { title: 'x' } },
    });
    expect((r.body as { error: { code: number } }).error.code).toBe(-32002);
    expect((r.body as { error: { message: string } }).error.message).toContain('超时');
    dev.close();
  });

  it('多设备:按最近活跃路由;工具列表聚合去重', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const cred = newCredential();
    const devA = new FakeDevice(wsUrl, cred, 'dev-A');
    const devB = new FakeDevice(wsUrl, cred, 'dev-B');
    await devA.open();
    devA.register();
    await devA.waitFor(() => devA.registeredMsg !== null);
    await devB.open();
    devB.register();
    await devB.waitFor(() => devB.registeredMsg !== null);

    // B 后注册,B 更活跃 → 调用应路由到 B
    const r = await mcpPost(baseUrl, cred, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_notification', arguments: { title: 'hi' } },
    });
    expect(r.status).toBe(200);
    expect(devB.received).toHaveLength(1);
    expect(devA.received).toHaveLength(0);

    // tools/list:两设备相同工具集,去重后等于单端数量
    const list = await mcpPost(baseUrl, cred, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list.body as { result: { tools: unknown[] } }).result.tools;
    expect(tools).toHaveLength(SAMPLE_TOOLS.length);
    devA.close();
    devB.close();
  });

  it('同 deviceId 重复连接 → 旧连接被 4000 踢掉', async () => {
    const { app, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev1 = new FakeDevice(wsUrl, cred, 'same-id');
    await dev1.open();
    dev1.register();
    await dev1.waitFor(() => dev1.registeredMsg !== null);

    const dev2 = new FakeDevice(wsUrl, cred, 'same-id');
    await dev2.open();
    dev2.register();
    await dev2.waitFor(() => dev2.registeredMsg !== null);
    await dev1.waitFor(() => dev1.closeCode === 4000);
    dev2.close();
  });
});
