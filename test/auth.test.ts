import { describe, it, expect, afterEach } from 'vitest';
import { request } from 'node:http';
import { SERVER_VERSION } from '../src/version.js';
import { startTestApp, mcpPost, mcpHeaders, newCredential, FakeDevice as FD } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe('鉴权', () => {
  it('initialize 协商协议并发布包版本,healthz 同步显示部署版本', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanup = () => app.close();
    const cred = newCredential();
    const dev = new FD(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);
    for (const version of ['2025-06-18', '2025-03-26', '2024-11-05', 'unknown']) {
      const res = await mcpPost(baseUrl, cred, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version },
      });
      expect(res.body).toMatchObject({ result: {
        protocolVersion: version === 'unknown' ? '2025-03-26' : version,
        serverInfo: { name: 'azki-watch', version: SERVER_VERSION }, capabilities: { tools: {} },
      } });
    }
    expect(await (await fetch(`${baseUrl}/healthz`)).json()).toMatchObject({ ok: true, version: SERVER_VERSION });
    dev.close();
  });

  it('无效 URL 返回 400,不会成为未处理 Promise rejection', async () => {
    const { app, baseUrl } = await startTestApp();
    cleanup = () => app.close();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(baseUrl, { path: 'http://[', method: 'GET' }, res => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it('失败鉴权超过 IP 配额后返回 429,同 IP 的有效凭证仍可使用', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp({ rateAuthFailPerMinute: 2 });
    cleanup = () => app.close();
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await mcpPost(baseUrl, 'bad', ping)).status).toBe(401);
    expect((await mcpPost(baseUrl, newCredential(), ping)).status).toBe(401);
    expect((await mcpPost(baseUrl, 'bad', ping)).status).toBe(429);
    const cred = newCredential();
    const dev = new FD(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);
    expect((await mcpPost(baseUrl, cred, ping)).status).toBe(200);
    dev.close();
  });

  it('无凭证 → 401 + WWW-Authenticate', async () => {
    const { app, baseUrl } = await startTestApp();
    cleanup = () => app.close();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('格式不合法的凭证 → 401', async () => {
    const { app, baseUrl } = await startTestApp();
    cleanup = () => app.close();
    const r = await mcpPost(baseUrl, 'not-hex!!', { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.status).toBe(401);
  });

  it('未注册的凭证(未配对设备)→ 401;设备注册后同一凭证 → 200', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    const cred = newCredential();
    const before = await mcpPost(baseUrl, cred, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(before.status).toBe(401);

    const dev = new FD(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const after = await mcpPost(baseUrl, cred, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(after.status).toBe(200);
    expect((after.body as { result: unknown }).result).toEqual({});
    dev.close();
    cleanup = async () => {
      dev.close();
      await app.close();
    };
  });

  it('三种凭证携带方式都可用:Bearer / X-Azki-Token / ?token=', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanup = () => app.close();
    const cred = newCredential();
    const dev = new FD(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const viaHeader = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-azki-token': cred },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(viaHeader.status).toBe(200);

    const viaQuery = await fetch(`${baseUrl}/mcp?token=${cred}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    });
    expect(viaQuery.status).toBe(200);
    dev.close();
  });

  it('GET /mcp → 405 + Allow;DELETE → 200;OPTIONS → 204', async () => {
    const { app, baseUrl } = await startTestApp();
    cleanup = () => app.close();
    const get = await fetch(`${baseUrl}/mcp`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toContain('POST');
    const del = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const opt = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
    expect(opt.status).toBe(204);
  });

  it('通知(无 id)→ 202;batch 全通知 → 202', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanup = () => app.close();
    const cred = newCredential();
    const dev = new FD(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const single = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(cred),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(single.status).toBe(202);

    const batch = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(cred),
      body: JSON.stringify([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 9, method: 'ping' },
      ]),
    });
    expect(batch.status).toBe(200);
    const arr = (await batch.json()) as unknown[];
    expect(arr).toHaveLength(1);
    expect((arr[0] as { id: number }).id).toBe(9);
    dev.close();
  });

  it('未知方法 → -32601;非法 JSON → -32700', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanup = () => app.close();
    const cred = newCredential();
    const dev = new FD(wsUrl, cred);
    await dev.open();
    dev.register();
    await dev.waitFor(() => dev.registeredMsg !== null);

    const unknown = await mcpPost(baseUrl, cred, { jsonrpc: '2.0', id: 1, method: 'nope/nope' });
    expect((unknown.body as { error: { code: number } }).error.code).toBe(-32601);

    const bad = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(cred),
      body: '{oops',
    });
    const badBody = (await bad.json()) as { error: { code: number } };
    expect(badBody.error.code).toBe(-32700);
    dev.close();
  });
});

describe('落地页', () => {
  it('GET / 返回功能介绍与开源地址', async () => {
    const { app, baseUrl } = await startTestApp();
    cleanup = () => app.close();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('AzkiDeck');
    expect(html).toContain('github.com/AzumaChiaki/AzkiDeck-mcp-server');
    expect(html).toContain('claude mcp add');
  });
});
