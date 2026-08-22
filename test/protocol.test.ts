import { describe, it, expect } from 'vitest';
import { parseRegister, parseDeviceMessage, PROTOCOL_VERSION } from '../src/relay/protocol.js';
import { isValidCredential, tenantIdOf, safeEqual, generateCredential } from '../src/core/credentials.js';

describe('WS 协议守卫', () => {
  const base = {
    type: 'register',
    protocol: PROTOCOL_VERSION,
    credential: generateCredential(),
    device_id: 'dev-1',
    platform: 'android',
    app_version: '1.0.0',
    server_name: 'azki-watch',
    tools: [{ name: 'send_notification', description: 'x', inputSchema: { type: 'object' } }],
  };

  it('合法 register 通过', () => {
    const msg = parseRegister(base);
    expect(msg).not.toBeNull();
    expect(msg!.platform).toBe('android');
    expect(msg!.tools).toHaveLength(1);
  });

  it('协议版本不符 → null', () => {
    expect(parseRegister({ ...base, protocol: 99 })).toBeNull();
  });

  it('缺 device_id / credential → null', () => {
    expect(parseRegister({ ...base, device_id: '' })).toBeNull();
    expect(parseRegister({ ...base, credential: 123 })).toBeNull();
  });

  it('platform 非 android/ios → unknown;server_name 缺失 → 默认 azki-watch', () => {
    const msg = parseRegister({ ...base, platform: ' toaster ', server_name: undefined });
    expect(msg!.platform).toBe('unknown');
    expect(msg!.server_name).toBe('azki-watch');
  });

  it('tools 清洗:无名丢弃、超量截断', () => {
    const tools = [
      { name: 'a' },
      { description: 'no name' },
      ...Array.from({ length: 200 }, (_, i) => ({ name: `t${i}` })),
    ];
    const msg = parseRegister({ ...base, tools });
    expect(msg!.tools.length).toBeLessThanOrEqual(128);
    expect(msg!.tools.some((t) => t.name === 'a')).toBe(true);
  });

  it('mcp-response 解析:rid 必填,error 可带', () => {
    expect(parseDeviceMessage({ type: 'mcp-response', rid: 'r_1', payload: {} })).toMatchObject({
      type: 'mcp-response',
      rid: 'r_1',
    });
    expect(parseDeviceMessage({ type: 'mcp-response' })).toBeNull();
    expect(
      parseDeviceMessage({ type: 'mcp-response', rid: 'x', error: { code: -32000, message: 'm' } }),
    ).toMatchObject({ error: { code: -32000 } });
  });

  it('垃圾输入 → null', () => {
    expect(parseDeviceMessage(null)).toBeNull();
    expect(parseDeviceMessage('register')).toBeNull();
    expect(parseDeviceMessage({ type: 'nope' })).toBeNull();
  });
});

describe('凭证', () => {
  it('格式校验:20~64 位小写 hex', () => {
    expect(isValidCredential('a'.repeat(20))).toBe(true);
    expect(isValidCredential('a'.repeat(64))).toBe(true);
    expect(isValidCredential('a'.repeat(19))).toBe(false);
    expect(isValidCredential('A'.repeat(20))).toBe(false);
    expect(isValidCredential('zz'.repeat(10))).toBe(false);
    expect(isValidCredential(123)).toBe(false);
  });

  it('tenantIdOf 是稳定 SHA-256;safeEqual 常量时间', () => {
    const c = generateCredential();
    expect(tenantIdOf(c)).toBe(tenantIdOf(c));
    expect(tenantIdOf(c)).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
