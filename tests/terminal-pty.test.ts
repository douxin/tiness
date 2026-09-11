import { test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { fixture } from './helpers';
const python = Bun.which('python3');
test.skipIf(!python || process.platform === 'win32')('PTY: approval input, FIFO and Esc work together in the terminal', async () => {
  const f = await fixture();
  try {
    const child = Bun.spawn([python!, resolve('tests/terminal-pty.py'), f.root, process.execPath, resolve('tests/fixtures/terminal-driver.ts')], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(stdout).toContain('PTY acceptance passed');
  } finally { await f.cleanup(); }
}, 30000);
