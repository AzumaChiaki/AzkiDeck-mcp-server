import type { Db, ServerMode } from '../store/db.js';
import { createHash } from 'node:crypto';
import { safeEqual } from './credentials.js';

const KEY_MODE = 'mode';
const KEY_DEPLOY_HASH = 'deployment_key_hash';

export interface ModeState {
  mode: ServerMode;
  /** 是否已设置部署密钥(仅私有模式有意义) */
  hasDeploymentKey: boolean;
}

export type DeploymentKeyCheck =
  | 'not_required' // 公开模式
  | 'ok'
  | 'missing' // 私有模式但未提供
  | 'mismatch' // 提供了但不正确
  | 'not_configured'; // 私有模式但服务器还没设密钥

/**
 * 公开/私有模式状态机。
 * - public:设备 register 只需凭证
 * - private:register 必须额外携带正确的 deployment_key
 * 模式与密钥哈希持久化在 server_settings 表,重启不丢。
 */
export class ServerModeRegistry {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  state(): ModeState {
    const mode = this.db.getSetting(KEY_MODE);
    return {
      mode: mode === 'private' ? 'private' : 'public',
      hasDeploymentKey: this.db.getSetting(KEY_DEPLOY_HASH) !== null,
    };
  }

  isPrivate(): boolean {
    return this.state().mode === 'private';
  }

  checkDeploymentKey(provided: string | undefined): DeploymentKeyCheck {
    const s = this.state();
    if (s.mode === 'public') return 'not_required';
    const expected = this.db.getSetting(KEY_DEPLOY_HASH);
    if (expected === null) return 'not_configured';
    if (provided === undefined || provided === '') return 'missing';
    const hash = createHash('sha256').update(provided, 'utf8').digest('hex');
    return safeEqual(hash, expected) ? 'ok' : 'mismatch';
  }

  /**
   * 切换模式。转私有必须给 deploymentKey;转公开时保留密钥哈希(再转回私有可复用,
   * 也可传 deploymentKey 覆盖)。
   */
  setMode(mode: ServerMode, deploymentKey?: string): ModeState {
    const now = this.now();
    this.db.setSetting(KEY_MODE, mode, now);
    if (deploymentKey !== undefined && deploymentKey !== '') {
      const hash = createHash('sha256').update(deploymentKey, 'utf8').digest('hex');
      this.db.setSetting(KEY_DEPLOY_HASH, hash, now);
    }
    return this.state();
  }
}
