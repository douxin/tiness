import { test, expect } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { answer, calls, deferred, FakeModel, fixture, fileRead } from './helpers';
import { ProviderError } from '../src/model/types';

test('FIFO isolates pending messages then shares preceding results', async () => {
  const f = await fixture(), started = deferred<void>(), release = deferred<void>();
  const model = new FakeModel(async (_, i) => { if (i === 0) { started.resolve(); await release.promise; } return answer(`result-${i}`); });
  const runtime = await f.runtime(model);
  try {
    expect(await runtime.submit('FIRST')).toBe(true); await started.promise;
    await runtime.submit('SECOND'); await runtime.submit('THIRD');
    expect(JSON.stringify(model.inputs[0])).not.toContain('SECOND');
    release.resolve(); await runtime.idle();
    expect(model.inputs.length).toBe(3);
    expect(JSON.stringify(model.inputs[1])).toContain('SECOND'); expect(JSON.stringify(model.inputs[1])).not.toContain('THIRD');
    expect(JSON.stringify(model.inputs[2])).toContain('result-1');
    const events = (await readFile(runtime.taskFile, 'utf8')).trim().split('\n').map(JSON.parse as any);
    expect(events.filter((e: any) => e.type === 'message_dequeued').map((e: any) => e.data.queueSeq)).toEqual([1, 2, 3]);
  } finally { release.resolve(); await runtime.quit(); await f.cleanup(); }
});
test('cancel stops current model wait, settles session, then runs queued input', async () => {
  const f = await fixture(), started = deferred<void>();
  const model = new FakeModel(async (_, i) => { if (i === 0) { started.resolve(); return await new Promise(() => {}); } return answer('next completed'); });
  const runtime = await f.runtime(model);
  try {
    await runtime.submit('cancel me'); await started.promise; await runtime.submit('next'); runtime.cancel(); runtime.cancel();
    await runtime.idle();
    expect(model.inputs.length).toBe(2); expect(f.output.some(s => s.includes('[cancelled]'))).toBe(true);
    expect(JSON.stringify(model.inputs[1])).toContain('cancelled');
  } finally { await runtime.quit(); await f.cleanup(); }
});
test('tool batch pairs results, denied writes do not run, plan remains explicit', async () => {
  const f = await fixture(); f.config.runtime.permissions.write = 'deny';
  await writeFile(join(f.cwd, 'input.txt'), 'hello');
  const model = new FakeModel((_, i) => i === 0 ? calls(
    { name: 'update_plan', args: { explanation: 'Inspect then report', steps: [{ id: 'inspect', text: 'Read the input', status: 'in_progress' }] } },
    { name: 'read', args: fileRead('input.txt') }, { name: 'write', args: { path: 'forbidden.txt', content: 'no' } },
  ) : answer('done'));
  const runtime = await f.runtime(model);
  try {
    await runtime.submit('inspect'); await runtime.idle();
    const results = model.inputs[1]!.items.filter(i => i.type === 'function_call_output');
    expect(results.length).toBe(3); expect(JSON.stringify(results)).toContain('permission_denied');
    expect(await Bun.file(join(f.cwd, 'forbidden.txt')).exists()).toBe(false);
    expect(model.inputs[1]!.instructions).toContain('Read the input');
  } finally { await runtime.quit(); await f.cleanup(); }
});
test('max rounds bounds tool loops and a later request still runs', async () => {
  const f = await fixture(); f.config.runtime.execution.maxRounds = 2;
  const model = new FakeModel((_, i) => i < 2 ? calls({ name: 'unknown', args: {} }) : answer('second'));
  const runtime = await f.runtime(model);
  try { await runtime.submit('loop'); await runtime.submit('second'); await runtime.idle(); expect(model.inputs.length).toBe(3); expect(f.output.some(s => s.includes('[limit_reached]'))).toBe(true); }
  finally { await runtime.quit(); await f.cleanup(); }
});
test('session deadline aborts model rather than wait indefinitely', async () => {
  const f = await fixture(); f.config.runtime.execution.sessionTimeoutMs = 30;
  const runtime = await f.runtime(new FakeModel(() => new Promise(() => {})));
  try { await runtime.submit('timeout'); await runtime.idle(); expect(f.output.some(s => s.includes('[limit_reached]'))).toBe(true); }
  finally { await runtime.quit(); await f.cleanup(); }
});
test('auth failure stops queue, quit records abandoned input', async () => {
  const f = await fixture(), wait = deferred<void>(), started = deferred<void>();
  const model = new FakeModel(async () => { started.resolve(); await wait.promise; throw new ProviderError('bad key', 401); });
  const runtime = await f.runtime(model);
  try {
    await runtime.submit('first'); await started.promise; await runtime.submit('must not run'); wait.resolve(); await runtime.idle(); await runtime.quit();
    expect(model.inputs.length).toBe(1); expect(runtime.fatalError).toBeDefined();
    expect(await readFile(runtime.taskFile, 'utf8')).toContain('message_abandoned');
  } finally { wait.resolve(); await runtime.quit(); await f.cleanup(); }
});
test('queue capacity rejects newest; new task cannot drop work', async () => {
  const f = await fixture(); f.config.runtime.queue.maxPendingMessages = 1;
  const gate = deferred<void>(), started = deferred<void>();
  const runtime = await f.runtime(new FakeModel(async (_, i) => { if (!i) { started.resolve(); await gate.promise; } return answer('ok'); }));
  try {
    await runtime.submit('first'); await started.promise;
    expect(await runtime.submit('second')).toBe(true); expect(await runtime.submit('third')).toBe(false); expect(await runtime.newTask()).toBe(false);
    gate.resolve(); await runtime.idle(); const old = runtime.taskFile;
    expect(await runtime.newTask()).toBe(true); expect(runtime.taskFile).not.toBe(old);
  } finally { gate.resolve(); await runtime.quit(); await f.cleanup(); }
});
test('incomplete model outputs are not executed', async () => {
  const f = await fixture(); f.config.runtime.permissions.write = 'allow';
  const model = new FakeModel(() => ({ ...calls({ name: 'write', args: { path: 'bad.txt', content: 'bad' } }), status: 'incomplete' }));
  const runtime = await f.runtime(model);
  try { await runtime.submit('test'); await runtime.idle(); expect(await Bun.file(join(f.cwd, 'bad.txt')).exists()).toBe(false); expect(f.output.some(s => s.includes('[failed]'))).toBe(true); }
  finally { await runtime.quit(); await f.cleanup(); }
});

test('cancel during approval settles all pending calls before queued message runs', async () => {
  const f = await fixture(), approvalStarted = deferred<void>();
  f.ui.approve = async () => { approvalStarted.resolve(); return await new Promise(() => {}); };
  const model = new FakeModel((_, i) => i === 0 ? calls(
    { name: 'write', args: { path: 'first.txt', content: 'must not write' } },
    { name: 'write', args: { path: 'second.txt', content: 'must not write' } },
  ) : answer('queued task completed'));
  const runtime = await f.runtime(model);
  try {
    await runtime.submit('requires approval'); await approvalStarted.promise; await runtime.submit('next'); runtime.cancel(); await runtime.idle();
    const results = model.inputs[1]!.items.filter(item => item.type === 'function_call_output');
    expect(results.length).toBe(2); expect(results.every(item => JSON.parse(item.output).code === 'not_executed')).toBe(true);
    expect(await Bun.file(join(f.cwd, 'first.txt')).exists()).toBe(false); expect(await Bun.file(join(f.cwd, 'second.txt')).exists()).toBe(false);
  } finally { await runtime.quit(); await f.cleanup(); }
});
