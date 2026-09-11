import { test, expect } from 'bun:test';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers';
import { Paths, snapshot, commit } from '../src/tools/paths';
import { Permissions } from '../src/permissions';
import { TaskStore } from '../src/storage/task-jsonl';
import { Artifacts } from '../src/storage/artifacts';
import { readText } from '../src/tools/read';
import { shell } from '../src/tools/shell';
import { validatePlan } from '../src/plan';
import { argumentsFor } from '../src/tools/schemas';

test('real paths reject escapes, dangling links, private directories and home workspace', async () => {
  const f = await fixture(); const paths = new Paths(f.cwd, f.home);
  try {
    await symlink(f.home, join(f.cwd, 'escape')); await symlink(join(f.home, 'missing'), join(f.cwd, 'dangling'));
    for (const path of ['../other/file', 'escape/file', 'dangling', '.tiness/tasks/test', join(f.home, 'secret')]) await expect(paths.target(path)).rejects.toThrow();
    expect(await paths.target('new/deep/file.txt')).toBe(join(f.cwd, 'new/deep/file.txt'));
    await expect(new Paths(f.home, f.home).target('.tiness/config.json')).rejects.toThrow();
  } finally { await f.cleanup(); }
});
test('atomic edit refuses a file changed after approval', async () => {
  const f = await fixture();
  try {
    const path = join(f.cwd, 'file.txt'); await writeFile(path, 'old'); const before = await snapshot(path, 1024);
    await writeFile(path, 'external change');
    await expect(commit(new Paths(f.cwd, f.home), 'file.txt', path, before, 'replacement', 1024, new AbortController().signal)).rejects.toThrow('变化');
    expect(await readFile(path, 'utf8')).toBe('external change');
  } finally { await f.cleanup(); }
});
test('permissions expire per session and approval abort never allows execution', async () => {
  const f = await fixture(); let approvals = 0;
  try {
    const ask = async () => { approvals++; return 'session' as const; };
    const p = new Permissions(f.config.runtime, ask), signal = new AbortController().signal;
    const request = { callId: 'one', operation: 'write' as const, target: join(f.cwd, 'a.txt'), detail: 'change' };
    expect((await p.decide(request, signal)).allowed).toBe(true);
    expect((await p.decide({ ...request, callId: 'two' }, signal)).allowed).toBe(true); expect(approvals).toBe(1);
    await new Permissions(f.config.runtime, ask).decide(request, signal); expect(approvals).toBe(2);
    f.config.runtime.execution.approvalTimeoutMs = 10;
    expect((await new Permissions(f.config.runtime, () => new Promise(() => {})).decide(request, signal)).allowed).toBe(false);
  } finally { await f.cleanup(); }
});
test('line reads preserve continuation and long lines have paginated artifacts', async () => {
  const f = await fixture(); const store = new TaskStore(f.cwd); await store.init({}); const artifacts = new Artifacts(store, 65536);
  try {
    const path = join(f.cwd, 'text'); await writeFile(path, '一\n二\n三\n');
    const first = await readText(path, 1, 2, f.config.runtime, artifacts, new AbortController().signal);
    expect(first.content).toContain('下次 offset=3'); expect(first.truncated).toBe(true);
    const last = await readText(path, 3, 2, f.config.runtime, artifacts, new AbortController().signal); expect(last.content).toContain('三'); expect(last.truncated).toBe(false);
    await writeFile(path, '中'.repeat(20000));
    const long = await readText(path, 1, 200, f.config.runtime, artifacts, new AbortController().signal);
    expect(long.artifactId).toBeDefined();
    const part = await artifacts.read(long.artifactId!, 0, 101); expect(part.content).not.toContain('�');
    const next = await artifacts.read(long.artifactId!, part.nextByteOffset, 101); expect(next.content).not.toContain('�');
    await expect(artifacts.read('unregistered', 0, 100)).rejects.toThrow();
  } finally { await store.close('test'); await f.cleanup(); }
});
test('shell drains excessive output to a bounded artifact', async () => {
  const f = await fixture(); const store = new TaskStore(f.cwd); await store.init({}); const artifacts = new Artifacts(store, 4096);
  try {
    const output = await shell("for i in {1..1000}; do printf '0123456789'; done", f.cwd, f.config.runtime, artifacts, new AbortController().signal);
    expect(output.isError).toBe(false); expect(output.truncated).toBe(true);
    const data = await artifacts.read(output.artifactId!, 0, 8192); expect(data.size).toBe(4096);
  } finally { await store.close('test'); await f.cleanup(); }
});
test('shell cancellation cleans its process group before returning', async () => {
  const f = await fixture(); const store = new TaskStore(f.cwd); await store.init({}); const artifacts = new Artifacts(store, 4096);
  const controller = new AbortController();
  try {
    const execution = shell('sleep 30 & wait', f.cwd, f.config.runtime, artifacts, controller.signal);
    const timer = setTimeout(() => controller.abort(new Error('cancel')), 50);
    const result = await execution; clearTimeout(timer); expect(result.isError).toBe(true);
  } finally { await store.close('test'); await f.cleanup(); }
}, 5000);
test('plan uniqueness and strict schemas are enforced', () => {
  expect(() => validatePlan({ explanation: 'x', steps: [{ id: 'a', text: 'x', status: 'in_progress' }, { id: 'a', text: 'y', status: 'in_progress' }] }, 10)).toThrow();
  expect(() => argumentsFor('edit', JSON.stringify({ path: 'a', oldText: '', newText: 'b' }))).toThrow();
  expect(() => argumentsFor('shell', JSON.stringify({ command: 'true', timeoutMs: null, surprise: true }))).toThrow();
});
