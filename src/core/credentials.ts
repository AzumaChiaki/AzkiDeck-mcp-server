import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

/** 租户/设备凭证 = 手机 App 的局域网桥接令牌(10~32 字节随机 hex)。 */
const CREDENTIAL_RE = /^[0-9a-f]{20,64}$/;

export function isValidCredential(s: unknown): s is string {
  return typeof s === 'string' && CREDENTIAL_RE.test(s);
}

/** 凭证 → tenantId(SHA-256 hex)。服务器只存哈希,永不落地明文。 */
export function tenantIdOf(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

/** 常量时间比较;长度不同直接 false。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 生成新凭证(CLI tenants create / 文档示例用),32 hex。 */
export function generateCredential(): string {
  return randomBytes(16).toString('hex');
}
