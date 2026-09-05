import { describe, expect, it } from 'vitest';
import { PendingMap } from '../src/core/pending.js';

describe('等待请求的连接隔离', () => {
  it('仅原连接能完成请求;其他租户、同租户其他设备及同 ID 新连接均无权回包', async () => {
    const pending = new PendingMap();
    const owner = {};
    const { rid, promise } = pending.create({ owner, tenantId: 'a', deviceId: 'same', clientId: 42, timeoutMs: 1000 });
    for (const foreign of [{}, {}, {}]) {
      expect(pending.resolveFromDevice(foreign, rid, { result: 'forged' })).toBe(false);
      expect(pending.resolveFromDevice(foreign, rid, undefined, { code: -1, message: 'forged error' })).toBe(false);
      expect(pending.failDevice(foreign)).toBe(0);
    }
    expect(pending.size()).toBe(1);
    expect(pending.resolveFromDevice(owner, rid, { result: 'real' })).toBe(true);
    expect(await promise).toEqual({ jsonrpc: '2.0', id: 42, result: 'real' });
  });

  it('旧连接断连只清理自身请求,不误伤同 ID 的替代连接或其他租户', async () => {
    const pending = new PendingMap();
    const owners = [{}, {}, {}];
    const calls = owners.map((owner, i) => pending.create({
      owner, tenantId: i === 2 ? 'b' : 'a', deviceId: 'same', clientId: i, timeoutMs: 1000,
    }));
    expect(pending.failDevice(owners[0]!)).toBe(1);
    expect(await calls[0]!.promise).toMatchObject({ id: 0, error: { code: -32002 } });
    expect(pending.size()).toBe(2);
    for (const i of [1, 2]) {
      expect(pending.resolveFromDevice(owners[i]!, calls[i]!.rid, { result: 'ok' })).toBe(true);
      expect(await calls[i]!.promise).toMatchObject({ id: i, result: 'ok' });
    }
  });
});
