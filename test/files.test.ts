import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApp, newCredential, FakeDevice } from './helpers.js';
import { handleFileUpload } from '../src/http/files.js';
import { TenantRegistry } from '../src/core/tenants.js';
import { tenantIdOf } from '../src/core/credentials.js';

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function startWithDevice() {
  const dir = await mkdtemp(join(tmpdir(), 'azkideck-test-'));
  const { app, baseUrl, wsUrl, config } = await startTestApp({ dataDir: dir });
  const cred = newCredential();
  const dev = new FakeDevice(wsUrl, cred);
  await dev.open();
  dev.register();
  await dev.waitFor(() => dev.registeredMsg !== null);
  cleanups.push(async () => {
    dev.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, baseUrl, cred, dev, config };
}

describe('临时文件投递 /files', () => {
  it('文件系统写入失败只返回 500,服务继续响应且不暴露内部路径', async () => {
    const { baseUrl, cred, config } = await startWithDevice();
    await writeFile(join(config.dataDir, 'files'), 'not a directory');
    const res = await fetch(`${baseUrl}/files`, {
      method: 'POST', headers: { authorization: `Bearer ${cred}` }, body: 'file',
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: '服务器处理失败' });
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it('stat 成功后读取失败不会造成未处理 stream error 或终止服务', async () => {
    const { baseUrl, cred, config } = await startWithDevice();
    const id = '1'.repeat(24);
    await mkdir(join(config.dataDir, 'files', tenantIdOf(cred), id), { recursive: true });
    const download = fetch(`${baseUrl}/files/${id}`, { headers: { authorization: `Bearer ${cred}` } })
      .then(res => res.arrayBuffer());
    await expect(download).rejects.toThrow();
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });

  it('内置 TLS 的下载地址保持 HTTPS,即使没有反代头或头被设为 http', async () => {
    const { app, cred, config } = await startWithDevice();
    const socket = new TLSSocket(new Socket());
    const req = new IncomingMessage(socket);
    req.headers = { host: 'relay.example.test', authorization: `Bearer ${cred}`, 'x-forwarded-proto': 'http' };
    const res = new ServerResponse(req);
    const end = vi.spyOn(res, 'end').mockImplementation(() => res);
    try {
      await handleFileUpload({ config, tenants: new TenantRegistry(app.db, true) }, req, res,
        new URL('http://localhost/files'), Buffer.from('payload'));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(String(end.mock.calls[0]![0]));
      expect(body.url).toMatch(/^https:\/\/relay\.example\.test\/files\/[0-9a-f]{24}$/);
    } finally {
      socket.destroy();
      end.mockRestore();
    }
  });

  it('上传 → 拿到 URL → 同租户可下载,内容一致', async () => {
    const { baseUrl, cred } = await startWithDevice();
    const payload = Buffer.from('fake-watchface-binary-\x00\x01\x02'.repeat(100), 'binary');

    const up = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cred}`, 'content-type': 'application/octet-stream' },
      body: payload,
    });
    expect(up.status).toBe(200);
    const meta = (await up.json()) as { url: string; size: number; sha256: string };
    expect(meta.size).toBe(payload.length);
    expect(meta.url).toContain('/files/');

    const down = await fetch(meta.url, { headers: { authorization: `Bearer ${cred}` } });
    expect(down.status).toBe(200);
    const buf = Buffer.from(await down.arrayBuffer());
    expect(buf.equals(payload)).toBe(true);
  });

  it('无凭证/错凭证 → 401;他人凭证下载 → 404(租户隔离)', async () => {
    const { baseUrl, cred } = await startWithDevice();
    const payload = Buffer.alloc(1024, 7);

    const noAuth = await fetch(`${baseUrl}/files`, { method: 'POST', body: payload });
    expect(noAuth.status).toBe(401);

    const up = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cred}` },
      body: payload,
    });
    const meta = (await up.json()) as { url: string };

    // 另一个租户的凭证(先在服务器上配对出第二个租户)
    const otherCred = newCredential();
    const otherDev = new FakeDevice(`${baseUrl.replace('http', 'ws')}/device`, otherCred, 'dev-other');
    await otherDev.open();
    otherDev.register();
    await otherDev.waitFor(() => otherDev.registeredMsg !== null);
    cleanups.push(() => otherDev.close());

    const stolen = await fetch(meta.url, { headers: { authorization: `Bearer ${otherCred}` } });
    expect(stolen.status).toBe(404);
  });

  it('超限 → 413;GET 不存在的 id → 404', async () => {
    const { baseUrl, cred, config } = await startWithDevice();
    const tooBig = Buffer.alloc(config.fileMaxBytes + 16, 1);
    const up = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cred}` },
      body: tooBig,
    });
    expect(up.status).toBe(413);

    const missing = await fetch(`${baseUrl}/files/${'0'.repeat(24)}`, {
      headers: { authorization: `Bearer ${cred}` },
    });
    expect(missing.status).toBe(404);
  });
});
