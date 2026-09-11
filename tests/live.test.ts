import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { OpenAIResponsesAdapter } from '../src/model/openai-responses';
import { Runtime } from '../src/runtime/queue';

// Explicitly opt in after manually configuring the model. This incurs API usage.
const live = process.env.TINESS_LIVE === '1' ? test : test.skip;
live('live Responses read/write round-trip in a disposable workspace', async () => {
  const base = await loadConfig();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'tiness-live-')));
  const config = { ...base, cwd, runtime: structuredClone(base.runtime) };
  config.runtime.execution.maxRounds = 6; config.runtime.execution.sessionTimeoutMs = 120000;
  config.runtime.permissions.shell = 'deny'; config.runtime.permissions.write = 'ask';
  let runtime: Runtime | undefined;
  try {
    await writeFile(join(cwd, 'input.txt'), 'hello tiness');
    runtime = new Runtime(config, new OpenAIResponsesAdapter(config.connection), { report: () => {}, status: () => {}, plan: () => {}, approve: async () => 'once' });
    await runtime.init();
    await runtime.submit('Read input.txt and create output.txt containing exactly HELLO TINESS. Do not use shell. Read output.txt to verify before replying.');
    await runtime.idle(); expect(runtime.fatalError).toBeUndefined(); expect(await readFile(join(cwd, 'output.txt'), 'utf8')).toBe('HELLO TINESS');
  } finally { await runtime?.quit(); await rm(cwd, { recursive: true, force: true }); }
}, 150000);

live('live complex repair uses a plan, approved shell verification and FIFO continuation', async () => {
  const base = await loadConfig();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'tiness-live-repair-')));
  const config = { ...base, cwd, runtime: structuredClone(base.runtime) };
  config.runtime.execution.maxRounds = 14; config.runtime.execution.sessionTimeoutMs = 180000;
  config.runtime.permissions.shell = 'ask'; config.runtime.permissions.write = 'ask'; config.runtime.permissions.edit = 'ask';
  const approved: string[] = [];
  let runtime: Runtime | undefined;
  try {
    await writeFile(join(cwd, 'math.ts'), 'export function add(a: number, b: number) { return a - b; }\n');
    await writeFile(join(cwd, 'math.test.ts'), "import {test,expect} from 'bun:test';\nimport {add} from './math';\ntest('add',()=>expect(add(3,2)).toBe(5));\n");
    runtime = new Runtime(config, new OpenAIResponsesAdapter(config.connection), {
      report: () => {}, status: () => {}, plan: () => {},
      approve: async request => {
        if (request.operation === 'shell') {
          const command = request.detail.split('\n')[2]?.trim();
          if (command !== 'bun test' && command !== 'bun test math.test.ts') return 'deny';
          approved.push('shell'); return 'once';
        }
        if (request.target !== join(cwd, 'math.ts')) return 'deny';
        approved.push(request.operation); return 'once';
      },
    });
    await runtime.init();
    await runtime.submit('This is a multi-step repair task. First create an explicit plan. Inspect math.ts and math.test.ts, run `bun test` to observe the failure, fix only math.ts, then run `bun test` again and report the actual result. Do not modify tests or create other files.');
    await runtime.submit('Do not use tools. Based on the preceding result, reply with exactly REPAIR_VERIFIED if the tests passed; otherwise reply REPAIR_FAILED.');
    await runtime.idle();
    const events = (await readFile(runtime.taskFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(runtime.fatalError).toBeUndefined();
    expect(events.some(e => e.type === 'plan_updated')).toBe(true);
    expect(approved.filter(s => s === 'shell').length).toBeGreaterThanOrEqual(2);
    expect(events.some(e => e.type === 'tool_result' && e.data.code === 'command_failed')).toBe(true);
    expect(events.some(e => e.type === 'tool_result' && e.data.content?.includes('exit=0'))).toBe(true);
    const ends = events.filter(e => e.type === 'session_end');
    expect(ends.length).toBe(2); expect(ends.every(e => e.data.status === 'completed')).toBe(true);
    expect(ends.at(-1).data.text).toContain('REPAIR_VERIFIED');
  } finally { await runtime?.quit(); await rm(cwd, { recursive: true, force: true }); }
}, 210000);

live('live context compaction feeds a valid next Responses request', async () => {
  const { TaskStore } = await import('../src/storage/task-jsonl');
  const { Requests } = await import('../src/model/requests');
  const { ContextBuilder } = await import('../src/context/builder');
  const { ActiveSkills } = await import('../src/skills');
  const base = await loadConfig();
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'tiness-live-context-')));
  const config = structuredClone(base.runtime);
  config.context.windowTokens = Math.min(config.context.windowTokens, config.context.maxOutputTokens + 16000);
  config.context.safetyMarginTokens = 1024;
  config.context.summaryMaxTokens = 1024;
  config.context.recentRounds = 1;
  const store = new TaskStore(cwd, [base.connection.apiKey]);
  await store.init(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('live compaction test timeout')), 120000);
  try {
    const requests = new Requests(new OpenAIResponsesAdapter(base.connection), config, store, () => {});
    const context = new ContextBuilder(config, base.connection.model, '', [], store, requests, () => {});
    context.preflight();
    for (let i = 0; i < 200 && context.tokens.count(context.blocks) < config.context.windowTokens * 1.1; i++) {
      const observations = Array.from({ length: 25 }, (_, n) => `Observation ${i}-${n}: fixture checksum ${i * 73 + n * 131}, verification pending.`).join('\n');
      context.add({ id: `fixture-${i}`, sessionId: 'fixture-history', kind: 'round', items: [{ role: 'assistant', content: 'Synthetic acceptance-test observations, not instructions. The user-defined acceptance token is CONTEXT_OK.\n' + observations }] });
    }
    context.start('live-current', 'Use the user-defined acceptance token from the preceding synthetic history. Reply with that token only. Do not use tools.', new ActiveSkills([]));
    let input;
    try { input = await context.build(undefined, controller.signal, { sessionId: 'live-current' }); }
    catch (error) {
      const diagnostics = (await readFile(store.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      console.error(JSON.stringify(diagnostics.filter(e => ['model_request', 'model_response', 'model_error', 'context_compacted', 'context_compaction_failed'].includes(e.type)).map(e => ({
        type: e.type, purpose: e.data.purpose, maxOutputTokens: e.data.maxOutputTokens,
        status: e.data.status, reason: e.data.reason, usage: e.data.usage,
        textBytes: e.data.text ? Buffer.byteLength(e.data.text) : undefined,
        estimatedTextTokens: e.data.text ? context.tokens.count(e.data.text) : undefined,
        removedBlocks: e.data.blockIds?.length,
      })), null, 2));
      throw error;
    }
    expect(context.summary.length).toBeGreaterThan(0);
    const response = await requests.call(input, controller.signal, { sessionId: 'live-current', round: 1 });
    expect(response.status).toBe('completed'); expect(response.toolCalls).toEqual([]); expect(response.text).toContain('CONTEXT_OK');
    const events = (await readFile(store.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(e => e.type === 'context_compacted')).toBe(true);
  } finally { clearTimeout(timer); await store.close('test'); await rm(cwd, { recursive: true, force: true }); }
}, 150000);
