import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, FakeDevice, mcpPost, newCredential } from './helpers.js';
import { parseRegister } from '../src/relay/protocol.js';
import { annotateTool } from '../src/mcp/toolAnnotations.js';
import { tenantIdOf } from '../src/core/credentials.js';
import type { Tool, ToolAnnotations } from '../src/mcp/toolClassify.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

const readTools = ['install_status', 'list_installed', 'list_notification_icons', 'sender_info', 'watch_status'];
const overwritingTools = ['send_notification', 'report_progress', 'clear_notification', 'install_resource', 'set_watch_face', 'set_notification_icon'];
const names = [...readTools, ...overwritingTools, 'request_action'];
const reads: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const writes: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

describe('工具行为元数据', () => {
  it('设备注册保留有效提示和 title;无效值不被强制转换为布尔', () => {
    const msg = parseRegister({
      type: 'register', protocol: 1, credential: newCredential(), device_id: 'a',
      tools: [
        { name: 'custom_read', annotations: { ...reads, title: 'Read', openWorldHint: false } },
        { name: 'custom_invalid', annotations: { readOnlyHint: 'true', destructiveHint: 0, idempotentHint: null, openWorldHint: 'false', title: 5 } },
        { name: 'custom_partial', annotations: { readOnlyHint: true } },
        { name: 'watch_status', annotations: { ...writes, title: 'More conservative device' } },
        { name: 'send_notification', annotations: reads },
      ],
    });
    expect(msg!.tools.map(t => t.annotations)).toEqual([
      { ...reads, title: 'Read' }, writes,
      { ...writes, readOnlyHint: true },
      { ...writes, title: 'More conservative device' }, writes,
    ]);
    expect(annotateTool({ name: 'toString' }).annotations).toEqual(writes);
    expect(annotateTool({ name: 'custom', annotations: {} }).annotations).toEqual(writes);
  });

  it('12 个真实工具在在线、离线及未迁移的旧数据库快照中均发布完整标注', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const credential = newCredential();
    const dev = new FakeDevice(wsUrl, credential);
    const legacyTools = names.map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
    await dev.open();
    dev.register(legacyTools);
    await dev.waitFor(() => dev.registeredMsg !== null);
    const check = async () => {
      const res = await mcpPost(baseUrl, credential, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).toBe(200);
      const tools = (res.body as { result: { tools: Tool[] } }).result.tools;
      expect(tools.map(t => t.name).sort()).toEqual([...names].sort());
      for (const t of tools) {
        expect(t.inputSchema).toEqual({ type: 'object' });
        expect(t.annotations).toEqual(readTools.includes(t.name) ? reads
          : t.name === 'request_action' ? { ...writes, destructiveHint: false } : writes);
      }
    };
    await check();
    dev.close();
    await dev.waitFor(() => dev.closeCode !== null);
    await check();
    // Simulate a persisted pre-upgrade snapshot without annotations.
    app.db.updateTenantSnapshot(tenantIdOf(credential), 'azki-watch', JSON.stringify(legacyTools), Date.now());
    await check();
  });

  it('同名工具聚合覆盖较危险的后注册设备,避免列表与实际路由风险不一致', async () => {
    const { app, baseUrl, wsUrl } = await startTestApp();
    cleanups.push(() => app.close());
    const credential = newCredential();
    const a = new FakeDevice(wsUrl, credential, 'a');
    const b = new FakeDevice(wsUrl, credential, 'b');
    await a.open();
    a.register([{ name: 'custom', description: 'read device', inputSchema: { type: 'object' }, annotations: reads }]);
    await a.waitFor(() => a.registeredMsg !== null);
    await b.open();
    b.register([{ name: 'custom', description: 'write device', inputSchema: { type: 'object' }, annotations: writes }]);
    await b.waitFor(() => b.registeredMsg !== null);
    const res = await mcpPost(baseUrl, credential, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((res.body as { result: { tools: Tool[] } }).result.tools).toEqual([
      { name: 'custom', description: 'read device', inputSchema: { type: 'object' }, annotations: writes },
    ]);
  });
});
