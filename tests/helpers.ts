import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRuntime, type Config } from '../src/config';
import type { ModelAdapter, ModelInput, ModelOutput } from '../src/model/types';
import type { AgentUI } from '../src/runtime/agent';
import { Runtime } from '../src/runtime/queue';
export const answer = (text: string): ModelOutput => ({ status: 'completed', text, toolCalls: [], protocolItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], status: 'completed', id: `msg_${crypto.randomUUID()}` }] });
export function calls(...items: { name: string; args: unknown }[]): ModelOutput {
  const tools = items.map(item => ({ id: `call_${crypto.randomUUID()}`, name: item.name, arguments: JSON.stringify(item.args) }));
  return { status: 'completed', text: '', toolCalls: tools, protocolItems: tools.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })) };
}
export function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export class FakeModel implements ModelAdapter {
  inputs: ModelInput[] = [];
  constructor(private respond: (input: ModelInput, index: number, signal: AbortSignal) => Promise<ModelOutput> | ModelOutput) {}
  async generate(input: ModelInput, signal: AbortSignal) { this.inputs.push(structuredClone(input)); return await this.respond(input, this.inputs.length - 1, signal); }
}
export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tiness-test-')));
  const cwd = join(root, 'workspace'), home = join(root, 'home');
  await mkdir(cwd); await mkdir(home);
  const config: Config = { cwd, home, connection: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only-not-a-real-key', model: 'test-model' }, runtime: defaultRuntime() };
  config.runtime.execution.modelMaxRetries = 0;
  config.runtime.execution.maxRounds = 8;
  config.runtime.execution.sessionTimeoutMs = 5000;
  config.runtime.execution.terminationGraceMs = 100;
  const output: string[] = [];
  const ui: AgentUI = { report: s => output.push(s), status: () => {}, plan: () => {}, approve: async () => 'once' };
  return { root, cwd, home, config, output, ui, cleanup: () => rm(root, { recursive: true, force: true }),
    runtime: async (model: ModelAdapter) => { const runtime = new Runtime(config, model, ui); await runtime.init(); return runtime; } };
}
export const fileRead = (path: string, offset: number | null = null, limit: number | null = null) => ({ path, offset, limit, artifactId: null, byteOffset: null, maxBytes: null });
