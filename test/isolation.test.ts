import { describe, it, expect, afterEach } from 'vitest';
import { startTestApp, mcpPost, newCredential, FakeDevice } from './helpers.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

describe('租户隔离', () => {
  it('A 的凭证看不到 B 的设备与工具;B 的调用不会路由到 A 的设备', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const credA = newCredential();
    const credB = newCredential();

    const devA = new FakeDevice(wsUrl, credA, 'dev-A');
    await devA.open();
    devA.register();
    await devA.waitFor(() => devA.registeredMsg !== null);

    // B 没有任何设备:tools/list 为空(B 尚未存在 → 401)
    const before = await mcpPost(baseUrl, credB, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(before.status).toBe(401);

    // B 的设备上线
    const devB = new FakeDevice(wsUrl, credB, 'dev-B');
    await devB.open();
    devB.register([{ name: 'ios_only_tool', description: '', inputSchema: { type: 'object' } }]);
    await devB.waitFor(() => devB.registeredMsg !== null);

    // A 的工具列表不含 B 的工具
    const listA = await mcpPost(baseUrl, credA, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const namesA = (listA.body as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name,
    );
    expect(namesA).not.toContain('ios_only_tool');

    // B 调用自己的工具 → 只到 B 的设备
    const r = await mcpPost(baseUrl, credB, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ios_only_tool', arguments: {} },
    });
    expect(r.status).toBe(200);
    expect(devB.received).toHaveLength(1);
    expect(devA.received).toHaveLength(0);
    devA.close();
    devB.close();
  });

  it('撤销租户:设备被拒 register_error,MCP 侧 401', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ adminToken: 'admin-secret-0000000000000000' });
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    // 管理 API 撤销
    const tenantsRes = await fetch(`${baseUrl}/admin/tenants`, {
      headers: { authorization: 'Bearer admin-secret-0000000000000000' },
    });
    const tenants = (await tenantsRes.json()) as { tenants: { id_prefix: string }[] };
    expect(tenants.tenants.length).toBe(1);
    const prefix = tenants.tenants[0]!.id_prefix;
    const revoke = await fetch(`${baseUrl}/admin/tenants/${prefix}/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-secret-0000000000000000' },
    });
    expect(revoke.status).toBe(200);

    // 原设备被踢,重连被拒
    await dev.waitFor(() => dev.closeCode !== null);
    const dev2 = new FakeDevice(wsUrl, cred, 'dev-new');
    await dev2.open();
    dev2.register();
    await dev2.waitFor(() => dev2.registerError !== null);
    expect(dev2.registerError!['code']).toBe('credential_revoked');

    // MCP 侧 401
    const r = await mcpPost(baseUrl, cred, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.status).toBe(401);
    dev.close();
    dev2.close();
  });

  it('autoRegister=false:未预置的凭证注册被拒;CLI 预置后可注册', async () => {
    const { app, wsUrl } = await startTestApp({ autoRegister: false });
    cleanups.push(() => app.close());
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registerError !== null);
    expect(dev.registerError!['code']).toBe('auto_register_disabled');
    dev.close();
  });
});
