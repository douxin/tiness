import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultRuntime, type Config } from '../../src/config';
import { Runtime } from '../../src/runtime/queue';
import { Terminal } from '../../src/terminal';
import { FakeModel, answer, calls } from '../helpers';
const root = await realpath(process.argv[2]!);
const config: Config = { cwd: join(root, 'workspace'), home: join(root, 'home'), connection: { apiKey: 'pty-test-key', model: 'test-model', baseUrl: 'http://unused.invalid' }, runtime: defaultRuntime() };
config.runtime.execution.terminationGraceMs = 100;
const seen = new Set<string>();
const model = new FakeModel(input => {
  const request = input.items.filter(item => item.role === 'user' && typeof item.content === 'string' && !item.content.startsWith('[')).at(-1)?.content;
  if (request === 'LONG_A' && !seen.has(request)) { seen.add(request); return calls({ name: 'shell', args: { command: 'sleep 30', timeoutMs: null } }); }
  if (request === 'HISTORY') return answer(Array.from({ length: 80 }, (_, i) => `HISTORY_LINE_${i}`).join('\n'));
  return answer(request === 'QUEUED_B' ? 'DONE_B' : 'DONE');
});
const terminal = new Terminal([], config.runtime.queue.maxMessageBytes, config.cwd);
let quitting: Promise<void> | undefined;
const quit = () => quitting ??= (async () => { await runtime.quit(); terminal.stop(); process.exitCode = runtime.fatalError ? 1 : 0; })();
const runtime = new Runtime(config, model, terminal, n => terminal.setQueue(n), () => { void quit(); });
await runtime.init();
terminal.start({ submit: text => runtime.submit(text), cancel: () => runtime.cancel(), newTask: () => runtime.newTask(), quit });
process.once('SIGTERM', () => { void quit(); });
