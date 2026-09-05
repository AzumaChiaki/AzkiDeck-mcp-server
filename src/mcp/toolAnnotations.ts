import { isObject } from '../core/jsonrpc.js';
import type { Tool, ToolAnnotations } from './toolClassify.js';

/** Reviewed against Android/iOS McpEndpoint and their notifier/install/icon services.
 * These describe the relay endpoint, including device routing and offline replay.
 * See docs/tool-annotations.md for the per-tool reasoning.
 */
const KNOWN: Readonly<Record<string, ToolAnnotations>> = {
  send_notification: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  report_progress: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  request_action: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  clear_notification: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  install_resource: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  install_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  list_installed: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  set_watch_face: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  set_notification_icon: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  list_notification_icons: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  sender_info: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  watch_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

const DEFAULTS: ToolAnnotations = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
};

/** Keep valid device hints, fill omissions, and never weaken a reviewed risk.
 * Unknown tools use MCP's conservative defaults for missing/non-boolean fields.
 * Every relay call crosses into a user-controlled phone, even phone-local reads.
 */
export function annotateTool(tool: Tool): Tool & { annotations: ToolAnnotations } {
  const known = Object.hasOwn(KNOWN, tool.name) ? KNOWN[tool.name] : undefined;
  const fallback = known ?? DEFAULTS;
  const input = isObject(tool.annotations) ? tool.annotations : {};
  const bool = (key: keyof typeof DEFAULTS): boolean =>
    typeof input[key] === 'boolean' ? input[key] as boolean : fallback[key] as boolean;
  const annotations: ToolAnnotations = {
    readOnlyHint: bool('readOnlyHint') && (known?.readOnlyHint ?? true),
    destructiveHint: bool('destructiveHint') || (known?.destructiveHint ?? false),
    idempotentHint: bool('idempotentHint') && (known?.idempotentHint ?? true),
    openWorldHint: true,
  };
  if (typeof input['title'] === 'string') annotations.title = input['title'];
  return { ...tool, annotations };
}

/** A tool name may route to any advertising device: publish the combined risk. */
export function mergeToolAnnotations(a: ToolAnnotations, b: ToolAnnotations): ToolAnnotations {
  return {
    ...a,
    readOnlyHint: a.readOnlyHint && b.readOnlyHint,
    destructiveHint: a.destructiveHint || b.destructiveHint,
    idempotentHint: a.idempotentHint && b.idempotentHint,
    openWorldHint: a.openWorldHint || b.openWorldHint,
  };
}
