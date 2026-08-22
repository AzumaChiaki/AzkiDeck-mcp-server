import { describe, it, expect } from 'vitest';
import { ReplayBuffer } from '../src/core/buffer.js';
import type { JsonRpcRequest } from '../src/core/jsonrpc.js';

function notif(method: string, args: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: method, arguments: args },
  };
}

describe('离线缓冲', () => {
  it('入队/取出清空;TTL 过期剔除', () => {
    let now = 1000;
    const buf = new ReplayBuffer(5 * 60_000, 200, () => now);
    buf.enqueue('t1', notif('send_notification', { title: 'a' }));
    buf.enqueue('t1', notif('send_notification', { title: 'b' }));
    expect(buf.size('t1')).toBe(2);

    now += 6 * 60_000; // 超过 TTL
    expect(buf.size('t1')).toBe(0);
    expect(buf.drain('t1')).toHaveLength(0);
  });

  it('report_progress 同 task 压实为最新一条', () => {
    const buf = new ReplayBuffer(5 * 60_000, 200);
    buf.enqueue('t1', notif('report_progress', { task: 'build', percent: 10 }));
    buf.enqueue('t1', notif('report_progress', { task: 'build', percent: 50 }));
    buf.enqueue('t1', notif('report_progress', { task: 'build', percent: 90 }));
    buf.enqueue('t1', notif('report_progress', { task: 'other', percent: 1 }));
    const items = buf.drain('t1');
    expect(items).toHaveLength(2);
    const build = items.find(
      (i) => (i.request.params as { arguments: { task: string } }).arguments.task === 'build',
    );
    expect(
      (build!.request.params as { arguments: { percent: number } }).arguments.percent,
    ).toBe(90);
  });

  it('clear_notification 抵消缓冲中的待发通知(按 notification_id 与 task)', () => {
    const buf = new ReplayBuffer(5 * 60_000, 200);
    buf.enqueue('t1', notif('send_notification', { title: 'x', notification_id: 7 }));
    buf.enqueue('t1', notif('send_notification', { title: 'y', notification_id: 8 }));
    buf.enqueue('t1', notif('report_progress', { task: 'job', percent: 1 }));
    buf.enqueue('t1', notif('clear_notification', { notification_id: 7 }));
    buf.enqueue('t1', notif('clear_notification', { task: 'job' }));
    const items = buf.drain('t1');
    // notification_id=7 与 task=job 的待发项被抵消;剩 id=8 的通知 + 两条 clear 本身
    const notifs = items.filter(
      (i) => (i.request.params as { name: string }).name === 'send_notification',
    );
    expect(notifs).toHaveLength(1);
    expect(
      (notifs[0]!.request.params as { arguments: { notification_id: number } }).arguments
        .notification_id,
    ).toBe(8);
    const progress = items.filter(
      (i) => (i.request.params as { name: string }).name === 'report_progress',
    );
    expect(progress).toHaveLength(0);
    expect(
      items.filter((i) => (i.request.params as { name: string }).name === 'clear_notification'),
    ).toHaveLength(2);
  });

  it('超出容量丢最旧', () => {
    const buf = new ReplayBuffer(5 * 60_000, 3);
    for (let i = 0; i < 5; i++) buf.enqueue('t1', notif('send_notification', { title: `n${i}` }));
    const items = buf.drain('t1');
    expect(items).toHaveLength(3);
    expect((items[0]!.request.params as { arguments: { title: string } }).arguments.title).toBe('n2');
  });

  it('租户之间互不可见', () => {
    const buf = new ReplayBuffer(5 * 60_000, 200);
    buf.enqueue('t1', notif('send_notification', { title: 'a' }));
    expect(buf.size('t2')).toBe(0);
    expect(buf.drain('t2')).toHaveLength(0);
    expect(buf.size('t1')).toBe(1);
  });
});
