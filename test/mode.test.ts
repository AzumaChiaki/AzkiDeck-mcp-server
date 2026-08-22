import { describe, it, expect, afterEach } from 'vitest';
import { startTestApp, mcpPost, newCredential, FakeDevice } from './helpers.js';

const ADMIN = 'admin-token-for-mode-test-000000';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function adminFetch(
  baseUrl: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: never }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as never };
}

describe('公开/私有模式', () => {
  it('默认公开模式:无需部署密钥即可注册', async () => {
    const { app, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const dev = new FakeDevice(wsUrl, newCredential());
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);
    dev.close();
  });

  it('转私有后:无密钥 → deployment_key_required;错密钥 → bad_deployment_key;正确密钥 → 注册成功', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ adminToken: ADMIN });
    cleanups.push(() => app.close());
    const key = 'ab'.repeat(16);

    const r = await adminFetch(baseUrl, '/admin/mode', 'POST', {
      mode: 'private',
      deployment_key: key,
    });
    expect(r.status).toBe(200);

    const noKey = new FakeDevice(wsUrl, newCredential());
    await noKey.open();
    noKey.register();
    await noKey.waitFor(() => noKey.registerError !== null);
    expect(noKey.registerError!['code']).toBe('deployment_key_required');

    const badKey = new FakeDevice(wsUrl, newCredential(), 'dev-bad', 'ff'.repeat(16));
    await badKey.open();
    badKey.register();
    await badKey.waitFor(() => badKey.registerError !== null);
    expect(badKey.registerError!['code']).toBe('bad_deployment_key');

    const good = new FakeDevice(wsUrl, newCredential(), 'dev-good', key);
    await good.open();
    good.register();
    await good.waitFor(() => good.registeredMsg !== null);
    noKey.close();
    badKey.close();
    good.close();
  });

  it('公开→私有 require_reauth=false:已配对设备不受影响,新设备需要密钥', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ adminToken: ADMIN });
    cleanups.push(() => app.close());
    const key = 'cd'.repeat(16);
    const credOld = newCredential();
    const devOld = new FakeDevice(wsUrl, credOld, 'dev-old');
    await devOld.open();
    devOld.register();
    await devOld.waitFor(() => devOld.registeredMsg !== null);

    await adminFetch(baseUrl, '/admin/mode', 'POST', {
      mode: 'private',
      deployment_key: key,
      require_reauth: false,
    });

    // 旧设备仍然在线可路由
    const r = await mcpPost(baseUrl, credOld, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_notification', arguments: { title: 'still works' } },
    });
    expect(r.status).toBe(200);
    expect(devOld.received).toHaveLength(1);

    // 新设备必须带密钥
    const devNew = new FakeDevice(wsUrl, newCredential(), 'dev-new');
    await devNew.open();
    devNew.register();
    await devNew.waitFor(() => devNew.registerError !== null);
    expect(devNew.registerError!['code']).toBe('deployment_key_required');
    devOld.close();
    devNew.close();
  });

  it('公开→私有 require_reauth=true:在线设备被 4003 踢掉,重新认证后恢复', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ adminToken: ADMIN });
    cleanups.push(() => app.close());
    const key = 'ef'.repeat(16);
    const cred = newCredential();
    const dev = new FakeDevice(wsUrl, cred, 'dev-reauth');
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    await adminFetch(baseUrl, '/admin/mode', 'POST', {
      mode: 'private',
      deployment_key: key,
      require_reauth: true,
    });

    // 在线设备被踢(4003)
    await dev.waitFor(() => dev.closeCode === 4003, 5000);

    // 重新认证前:MCP 侧 tools/call → -32003
    const blocked = await mcpPost(baseUrl, cred, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_notification', arguments: { title: 'x' } },
    });
    expect((blocked.body as { error: { code: number } }).error.code).toBe(-32003);

    // 带密钥重新注册 → 恢复
    const dev2 = new FakeDevice(wsUrl, cred, 'dev-reauth', key);
    await dev2.open();
    dev2.register();
    await dev2.waitFor(() => dev2.registeredMsg !== null);
    const ok = await mcpPost(baseUrl, cred, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'send_notification', arguments: { title: 'back' } },
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { result?: unknown }).result).toBeDefined();
    dev.close();
    dev2.close();
  });

  it('私有→公开:新注册免密钥', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ adminToken: ADMIN });
    cleanups.push(() => app.close());
    await adminFetch(baseUrl, '/admin/mode', 'POST', { mode: 'private', deployment_key: 'ab'.repeat(16) });
    await adminFetch(baseUrl, '/admin/mode', 'POST', { mode: 'public' });

    const dev = new FakeDevice(wsUrl, newCredential());
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);
    dev.close();
  });

  it('转私有但未提供且从未设置密钥 → 400', async () => {
    const { app, baseUrl } = await startTestApp({ adminToken: ADMIN });
    cleanups.push(() => app.close());
    const r = await adminFetch(baseUrl, '/admin/mode', 'POST', { mode: 'private' });
    expect(r.status).toBe(400);
  });

  it('ADMIN_TOKEN 未配置时 /admin/* 整体 404;配置后错令牌 401', async () => {
    const noAdmin = await startTestApp();
    cleanups.push(() => noAdmin.app.close());
    const r1 = await fetch(`${noAdmin.baseUrl}/admin/tenants`);
    expect(r1.status).toBe(404);

    const withAdmin = await startTestApp({ adminToken: ADMIN });
    cleanups.push(() => withAdmin.app.close());
    const r2 = await fetch(`${withAdmin.baseUrl}/admin/tenants`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(r2.status).toBe(401);
    const r3 = await fetch(`${withAdmin.baseUrl}/admin/tenants`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(r3.status).toBe(200);
  });

  it('/healthz 公开且不泄露标识', async () => {
    const { app, baseUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['devices_online', 'ok', 'tenants', 'uptime_s']);
  });
});
