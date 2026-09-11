import { test, expect } from 'bun:test';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, mergeRuntime } from '../src/config';
import { fixture } from './helpers';

test('workspace can tighten permissions but cannot grant itself allow', () => {
  const c = mergeRuntime({ permissions: { shell: 'ask', read: 'allow' } }, { permissions: { shell: 'allow', read: 'deny' }, execution: { maxRounds: 12 } });
  expect(c.permissions.shell).toBe('ask'); expect(c.permissions.read).toBe('deny'); expect(c.execution.maxRounds).toBe(12);
  expect(mergeRuntime({ permissions: { shell: 'allow' } }).permissions.shell).toBe('allow');
});
test('unknown, nonfinite, negative and inconsistent budgets fail', () => {
  for (const value of [{ missing: {} }, { execution: { typo: 1 } }, { execution: { maxRounds: 0 } }, { execution: { maxRounds: Infinity } }, { context: { compactAtRatio: 0.2 } }, { tools: { artifactMaxBytes: 1 } }, { context: { windowTokens: 1 } }])
    expect(() => mergeRuntime(value)).toThrow();
  expect(mergeRuntime({ execution: { modelMaxRetries: 0 } }).execution.modelMaxRetries).toBe(0);
});
test('credentials only come from global config or explicit environment, config frozen', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, '.tiness'));
    await writeFile(join(f.home, '.tiness/config.json'), JSON.stringify({ model: 'test', apiKey: 'file-key' }));
    const config = await loadConfig(f.cwd, f.home, { OPENAI_API_KEY: 'env-key' });
    expect(config.connection.apiKey).toBe('env-key'); expect(Object.isFrozen(config.runtime.execution)).toBe(true);
    await mkdir(join(f.cwd, '.tiness'));
    await writeFile(join(f.cwd, '.tiness/runtime.json'), JSON.stringify({ model: 'untrusted' }));
    await expect(loadConfig(f.cwd, f.home, {})).rejects.toThrow();
  } finally { await f.cleanup(); }
});
test('symlinked private configuration is rejected', async () => {
  const f = await fixture();
  try { await symlink(f.home, join(f.cwd, '.tiness')); await expect(loadConfig(f.cwd, f.home, {})).rejects.toThrow(); }
  finally { await f.cleanup(); }
});
