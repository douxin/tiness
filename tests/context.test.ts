import { test, expect } from 'bun:test';
import { fixture, FakeModel, answer } from './helpers';
import { TaskStore } from '../src/storage/task-jsonl';
import { Requests } from '../src/model/requests';
import { ContextBuilder } from '../src/context/builder';
import { ActiveSkills } from '../src/skills';
import { validateProtocol, ProviderError } from '../src/model/types';

test('compaction preserves the current request and complete recent call pairs', async () => {
  const f = await fixture(); const c = f.config.runtime.context;
  c.windowTokens = 14000; c.maxOutputTokens = 1000; c.safetyMarginTokens = 256; c.summaryMaxTokens = 1000;
  const store = new TaskStore(f.cwd); await store.init({});
  const model = new FakeModel(input => { expect(input.tools).toEqual([]); return answer('Earlier work: inspected files; tests not yet run.'); });
  const requests = new Requests(model, f.config.runtime, store, () => {});
  const context = new ContextBuilder(f.config.runtime, 'unknown-model', '', [], store, requests, () => {});
  try {
    for (let i = 0; i < 10; i++) context.add({ id: `old-${i}`, kind: 'round', sessionId: 'old', items: [{ role: 'assistant', content: 'observation '.repeat(100) }] });
    context.start('current', 'MUST KEEP THIS REQUEST', new ActiveSkills([]));
    context.add({ id: 'latest', kind: 'round', sessionId: 'current', items: [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'latest evidence' }] });
    const plan = { explanation: 'Keep plan', steps: [{ id: 'a', text: 'MUST KEEP PLAN', status: 'in_progress' as const }] };
    const input = await context.build(plan, new AbortController().signal, { sessionId: 'current' });
    expect(model.inputs.length).toBeGreaterThan(0); expect(context.summary).toContain('Earlier work');
    expect(JSON.stringify(input.items)).toContain('MUST KEEP THIS REQUEST'); expect(input.instructions).toContain('MUST KEEP PLAN');
    expect(JSON.stringify(input.items)).toContain('latest evidence'); expect(() => validateProtocol(input.items)).not.toThrow();
  } finally { await store.close('test'); await f.cleanup(); }
});
test('failed compression never overwrites the original history projection', async () => {
  const f = await fixture(); f.config.runtime.context.windowTokens = 14000; f.config.runtime.context.maxOutputTokens = 1000; f.config.runtime.context.safetyMarginTokens = 256;
  const store = new TaskStore(f.cwd); await store.init({});
  const requests = new Requests(new FakeModel(() => { throw new Error('summary failure'); }), f.config.runtime, store, () => {});
  const context = new ContextBuilder(f.config.runtime, 'unknown-model', '', [], store, requests, () => {});
  try {
    for (let i = 0; i < 15; i++) context.add({ id: `${i}`, kind: 'round', sessionId: 'old', items: [{ role: 'assistant', content: 'x'.repeat(1000) }] });
    context.start('current', 'protected request', new ActiveSkills([]));
    const ids = context.blocks.map(b => b.id);
    await expect(context.build(undefined, new AbortController().signal, {})).rejects.toThrow();
    expect(context.blocks.map(b => b.id)).toEqual(ids); expect(context.summary).toBe('');
  } finally { await store.close('test'); await f.cleanup(); }
});
test('orphan calls and duplicate results cannot be sent back to the provider', () => {
  expect(() => validateProtocol([{ type: 'function_call', call_id: 'a' }])).toThrow();
  expect(() => validateProtocol([{ type: 'function_call_output', call_id: 'a' }])).toThrow();
  expect(() => validateProtocol([{ type: 'function_call', call_id: 'a' }, { type: 'function_call_output', call_id: 'a' }])).not.toThrow();
});
test('retry is bounded and belongs to one logical request', async () => {
  const f = await fixture(); f.config.runtime.execution.modelMaxRetries = 1; f.config.runtime.execution.retryBaseDelayMs = 1;
  const store = new TaskStore(f.cwd); await store.init({});
  const model = new FakeModel((_, i) => { if (i === 0) throw new ProviderError('rate limit', 429); return answer('ok'); });
  try {
    const requests = new Requests(model, f.config.runtime, store, () => {});
    const result = await requests.call({ purpose: 'agent', instructions: '', items: [], tools: [], maxOutputTokens: 100 }, new AbortController().signal, { round: 1 });
    expect(result.text).toBe('ok'); expect(model.inputs.length).toBe(2);
  } finally { await store.close('test'); await f.cleanup(); }
});

test('cancel during compaction preserves the prior context and aborts promptly', async () => {
  const { deferred } = await import('./helpers');
  const { CancelledError } = await import('../src/errors');
  const f = await fixture(); f.config.runtime.context.windowTokens = 14000; f.config.runtime.context.maxOutputTokens = 1000; f.config.runtime.context.safetyMarginTokens = 256;
  const store = new TaskStore(f.cwd); await store.init({}); const started = deferred<void>();
  const requests = new Requests(new FakeModel(() => { started.resolve(); return new Promise(() => {}); }), f.config.runtime, store, () => {});
  const context = new ContextBuilder(f.config.runtime, 'unknown-model', '', [], store, requests, () => {});
  const controller = new AbortController();
  try {
    for (let i = 0; i < 15; i++) context.add({ id: `${i}`, kind: 'round', sessionId: 'old', items: [{ role: 'assistant', content: 'x'.repeat(1000) }] });
    context.start('current', 'protected request', new ActiveSkills([])); const ids = context.blocks.map(b => b.id);
    const work = context.build(undefined, controller.signal, {});
    await started.promise; controller.abort(new CancelledError('cancel summary'));
    await expect(work).rejects.toThrow('cancel summary'); expect(context.summary).toBe(''); expect(context.blocks.map(b => b.id)).toEqual(ids);
  } finally { await store.close('test'); await f.cleanup(); }
});

test('summary length limit does not starve the model reasoning budget', async () => {
  const f = await fixture(); const c = f.config.runtime.context;
  c.windowTokens = 18000; c.maxOutputTokens = 4096; c.safetyMarginTokens = 512; c.summaryMaxTokens = 1024;
  const store = new TaskStore(f.cwd); await store.init({});
  const model = new FakeModel(input => input.maxOutputTokens < 2048
    ? { status: 'incomplete', reason: 'max_output_tokens', text: '', toolCalls: [], protocolItems: [] }
    : answer('Verified historical observation. Pending work remains.'));
  const requests = new Requests(model, f.config.runtime, store, () => {});
  const context = new ContextBuilder(f.config.runtime, 'unknown-model', '', [], store, requests, () => {});
  try {
    for (let i = 0; i < 20; i++) context.add({ id: `${i}`, kind: 'round', sessionId: 'old', items: [{ role: 'assistant', content: 'x'.repeat(1000) }] });
    context.start('current', 'protected request', new ActiveSkills([]));
    const input = await context.build(undefined, new AbortController().signal, {});
    expect(context.summary).toContain('Pending work'); expect(context.tokens.count(context.summary)).toBeLessThanOrEqual(c.summaryMaxTokens);
    expect(JSON.stringify(input.items)).toContain('protected request');
  } finally { await store.close('test'); await f.cleanup(); }
});
