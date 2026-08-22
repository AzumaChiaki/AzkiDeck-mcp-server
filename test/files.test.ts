import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestApp, newCredential, FakeDevice } from './helpers.js';

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
  return { baseUrl, cred, dev, config };
}

describe('临时文件投递 /files', () => {
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
