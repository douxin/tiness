import { test, expect } from 'bun:test';
import { Terminal, wrap } from '../src/terminal';

test('wide characters wrap by terminal columns', () => {
  expect(wrap('中文abcd', 4)).toEqual(['中文', 'abcd']);
});
test('bracketed pasted newlines do not submit messages until Enter', async () => {
  const terminal = new Terminal([], 1024), submitted: string[] = [];
  const input = terminal as any;
  input.actions = { submit: async (text: string) => { submitted.push(text); return true; }, cancel: () => {}, quit: async () => {}, newTask: async () => true };
  input.data('\x1b[200~第一行\n第二行\x1b[201~');
  expect(submitted).toEqual([]); input.data('\r'); await Promise.resolve();
  expect(submitted).toEqual(['第一行\n第二行']);
});
test('approval defaults deny, normal Enter queues input, Tab explicitly changes focus', async () => {
  const terminal = new Terminal([], 1024), submitted: string[] = [];
  const input = terminal as any;
  input.actions = { submit: async (text: string) => { submitted.push(text); return true; }, cancel: () => {}, quit: async () => {}, newTask: async () => true };
  const approval = terminal.approve({ callId: 'c', operation: 'shell', target: '/tmp', detail: 'true', scope: 'session shell' }, new AbortController().signal);
  input.data('下一条\r'); expect(submitted).toEqual(['下一条']);
  expect(input.approval).toBeDefined(); input.data('\t\r');
  expect(await approval).toBe('deny');
});
test('arrow keys do not trigger Esc cancellation; standalone Esc does', async () => {
  const terminal = new Terminal([], 1024); let cancelled = 0;
  const input = terminal as any;
  input.actions = { submit: async () => true, cancel: () => cancelled++, quit: async () => {}, newTask: async () => true };
  input.data('\x1b[D'); expect(cancelled).toBe(0);
  input.data('\x1b'); await new Promise(resolve => setTimeout(resolve, 90)); expect(cancelled).toBe(1);
});

test('approval choices stay visible at different terminal sizes, including long Unicode details', async () => {
  const terminal = new Terminal([], 4096);
  const control = new AbortController();
  const pending = terminal.approve({ callId: 'c', operation: 'shell', target: '/tmp', detail: 'cwd=/tmp\ntimeoutMs=5000\n' + '中文命令\n'.repeat(80) + '无沙箱', scope: '本请求所有命令' }, control.signal);
  for (const [width, height] of [[100, 32], [80, 24], [40, 16]]) {
    const frame = terminal.screen(width!, height!);
    const dialog = frame.lines.flatMap(line => line.dialog ? [line.dialog.text] : []).join('\n');
    expect(dialog).toContain('允许这一次');
    expect(dialog).toContain('本请求内允许同类操作');
    expect(dialog).toContain('拒绝，不执行');
    expect(frame.lines).toHaveLength(height!);
    for (const line of frame.lines) {
      expect(wrap(line.text, width! - 1)).toHaveLength(1);
      if (line.dialog) expect(line.dialog.x + Bun.stringWidth(line.dialog.text)).toBeLessThan(width!);
    }
    const lastDialog = frame.lines.findLastIndex(line => !!line.dialog);
    expect(lastDialog).toBeLessThan(height! - 5);
  }
  const input = terminal as any;
  terminal.screen(20, 8); input.key('1'); input.key('\r');
  expect(input.approval).toBeDefined();
  terminal.screen(80, 24); input.key('3'); input.key('\r');
  expect(await pending).toBe('deny');
});

test('scroll wheel freezes history while new messages arrive and End returns to latest', () => {
  const terminal = new Terminal([], 1024), input = terminal as any;
  for (let i = 0; i < 40; i++) terminal.message('assistant', `消息 ${i}`);
  terminal.screen(80, 24);
  input.data('\x1b[<64;20;10M');
  const before = terminal.screen(80, 24).lines.slice(2, 15).map(l => l.text.slice(0, -1));
  terminal.message('assistant', '新抵达的回复');
  const after = terminal.screen(80, 24).lines.slice(2, 15).map(l => l.text.slice(0, -1));
  expect(after).toEqual(before);
  expect(terminal.screen(80, 24).lines.some(l => l.text.includes('1 条新消息'))).toBe(true);
  input.data('\x1b[F');
  expect(terminal.screen(80, 24).lines.some(l => l.text.includes('新抵达的回复'))).toBe(true);
  input.data('\x1b[H');
  expect(terminal.screen(80, 24).lines.some(l => l.text.includes('消息 0'))).toBe(true);
});

test('tool output is folded by default and F2 reveals details', () => {
  const terminal = new Terminal([], 1024), input = terminal as any;
  terminal.tool({ id: 'c', name: 'read', arguments: '{"path":"notes.txt"}' }, { content: 'preview\nhidden line' });
  expect(terminal.screen(80, 24).lines.some(l => l.text.includes('hidden line'))).toBe(false);
  input.data('\x1bOQ');
  expect(terminal.screen(80, 24).lines.some(l => l.text.includes('hidden line'))).toBe(true);
});

test('a draft retains input focus when approval arrives; mouse selects explicit approval', async () => {
  const terminal = new Terminal([], 1024), input = terminal as any;
  input.data('草稿');
  const pending = terminal.approve({ callId: 'c', operation: 'write', target: '/tmp/a', detail: 'new content', scope: 'write' }, new AbortController().signal);
  const frame = terminal.screen(80, 24);
  expect(frame.cursor).toBeDefined();
  expect(frame.lines.some(l => l.dialog?.text.includes('你正在输入新消息'))).toBe(true);
  const hit = input.hitboxes.find((h: any) => h.choice === 0);
  input.data(`\x1b[<0;${hit.x + 1};${hit.y + 1}M`);
  expect(await pending).toBe('once');
  expect(input.draft).toBe('草稿');
});
