export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
  title?: string;
}

/** MCP Tool 类型(协议子集,与手机端 tools/list 形状一致)。 */
export interface Tool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Partial<ToolAnnotations>;
  [key: string]: unknown;
}

/** 通知类工具:设备离线时可入缓冲、重连后补发。其余工具离线即报错。 */
export const NOTIFICATION_TOOLS: ReadonlySet<string> = new Set([
  'send_notification',
  'report_progress',
  'request_action',
  'clear_notification',
]);

/** install 类工具:手机端自身 25s 内返回 job_id,中继给足 60s。 */
export const INSTALL_TOOL_PREFIX = 'install_';

export function isNotificationTool(name: string): boolean {
  return NOTIFICATION_TOOLS.has(name);
}

export function timeoutForTool(name: string, callMs: number, installMs: number): number {
  return name.startsWith(INSTALL_TOOL_PREFIX) ? installMs : callMs;
}
