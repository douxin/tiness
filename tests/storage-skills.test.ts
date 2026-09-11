import { test, expect } from 'bun:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Artifacts } from '../src/storage/artifacts';
import { TaskStore } from '../src/storage/task-jsonl';
import { ActiveSkills, discoverSkills } from '../src/skills';
import { Paths } from '../src/tools/paths';
import { fixture } from './helpers';

test('JSONL writes remain ordered and secrets are redacted', async () => {
  const f = await fixture(); const store = new TaskStore(f.cwd, ['private-test-value']); await store.init({});
  try {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append('message_queued', { i, text: 'private-test-value' })));
    const raw = await readFile(store.file, 'utf8'), events = raw.trim().split('\n').map(line => JSON.parse(line));
    expect(raw).not.toContain('private-test-value'); expect(events.map(e => e.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  } finally { await store.close('test'); await f.cleanup(); }
});
test('Skill discovery validates standard metadata and resolves project paths', async () => {
  const f = await fixture();
  try {
    const directory = join(f.cwd, '.agents/skills/test-skill'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), '---\nname: test-skill\ndescription: Test things\n---\nInstructions\n');
    const found = await discoverSkills(new Paths(f.cwd, f.home)); expect(found.skills[0]?.name).toBe('test-skill');
    await writeFile(join(directory, 'SKILL.md'), '---\nname: mismatch\ndescription: nope\n---\n');
    await expect(discoverSkills(new Paths(f.cwd, f.home))).rejects.toThrow();
  } finally { await f.cleanup(); }
});
test('Skill body is pinned only after complete loading and after its original blocks leave context', () => {
  const active = new ActiveSkills([{ name: 'x', description: 'x', path: '/workspace/x/SKILL.md' }]);
  active.read('/workspace/x/SKILL.md', { text: 'part1\n', offset: 1, end: 1, eof: false, hash: 'v1' }, 'b1');
  expect(active.pinned(new Set())).toBe('');
  active.read('/workspace/x/SKILL.md', { text: 'part2', offset: 2, end: 2, eof: true, hash: 'v1' }, 'b2');
  expect(active.pinned(new Set(['b1', 'b2']))).toBe('');
  expect(active.pinned(new Set())).toContain('part1\npart2');
});

test('artifact redaction handles a known credential split across output chunks', async () => {
  const f = await fixture(); const store = new TaskStore(f.cwd); await store.init({});
  try {
    const artifacts = new Artifacts(store, 4096, ['example-secret']);
    const output = await artifacts.create();
    await output.write(Buffer.from('before example-')); await output.write(Buffer.from('secret after'));
    const info = await output.finish();
    const read = await artifacts.read(info.id, 0, 4096);
    expect(read.content).toBe('before [REDACTED] after');
  } finally { await store.close('test'); await f.cleanup(); }
});
