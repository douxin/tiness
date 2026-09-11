import type { Config } from '../config';
import type { ModelAdapter } from '../model/types';
import { ProviderError } from '../model/types';
import { Requests } from '../model/requests';
import type { TaskStore } from '../storage/task-jsonl';
import { Artifacts } from '../storage/artifacts';
import { ContextBuilder, type Block } from '../context/builder';
import { ActiveSkills, type Skill } from '../skills';
import { Permissions, type Approver } from '../permissions';
import { ToolExecutor } from '../tools/registry';
import type { Plan, ToolCall, ToolResult } from '../tools/types';
import { CancelledError, check, FatalError, LimitError, message } from '../errors';

export interface AgentUI { message?(role: 'user' | 'assistant', text: string, requestNumber?: number): void; tool?(call: ToolCall, result: ToolResult): void; complete?(status: string, text: string): void; report(text: string): void; status(text: string): void; plan(plan?: Plan): void; stream?(text: string, reset?: boolean): void; approve: Approver }
export interface QueuedMessage { id: string; seq: number; text: string }
export type SessionResult = { status: 'completed' | 'cancelled' | 'failed' | 'limit_reached'; text: string };
export class Agent {
  readonly context: ContextBuilder;
  private artifacts: Artifacts;
  private requests: Requests;
  private sessionCounter = 0;
  constructor(private config: Config, model: ModelAdapter, private store: TaskStore, private catalog: Skill[], agents: string, private ui: AgentUI) {
    this.requests = new Requests(model, config.runtime, store, text => ui.report(text));
    this.artifacts = new Artifacts(store, config.runtime.tools.artifactMaxBytes, [config.connection.apiKey]);
    this.context = new ContextBuilder(config.runtime, config.connection.model, agents, catalog, store, this.requests, text => ui.report(text));
    this.context.preflight();
  }
  async run(input: QueuedMessage, controller: AbortController): Promise<SessionResult> {
    const sessionId = `${this.store.id}/${++this.sessionCounter}`, c = this.config.runtime;
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(new LimitError('Session 总时间已达到上限')), c.execution.sessionTimeoutMs);
    const event = { sessionId, messageId: input.id };
    const active = new ActiveSkills(this.catalog);
    let plan: Plan | undefined, round = 0;
    let result: SessionResult = { status: 'failed', text: '请求未完成' };
    let fatal: unknown;
    let pending: ToolCall[] = [], block: Block | undefined;
    let currentCallStarted = false;
    const permission = new Permissions(c, async (request, approvalSignal) => {
      this.ui.status('等待权限审批');
      try { return await this.ui.approve(request, approvalSignal); }
      finally { this.ui.status(`Session ${this.sessionCounter} · Round ${round}/${c.execution.maxRounds}`); }
    });
    const executor = new ToolExecutor(this.config, this.store, this.artifacts, permission, active, value => { plan = value; this.ui.plan(value); });
    this.context.start(sessionId, input.text, active);
    this.ui.plan();
    const settle = async (call: ToolCall, output: ToolResult) => {
      let sent = output;
      if (Buffer.byteLength(output.content) > c.tools.resultMaxBytes) {
        const artifactId = output.artifactId ?? await this.artifacts.save(output.content);
        sent = { ...output, content: Buffer.from(output.content).subarray(0, Math.max(0, c.tools.resultMaxBytes - 200)).toString('utf8') + `\n[截断；产物 ${artifactId}]`, truncated: true, artifactId };
      }
      await this.store.append('tool_result', sent, { ...event, round, callId: call.id });
      block?.items.push({ type: 'function_call_output', call_id: call.id, output: JSON.stringify(sent) });
      pending.shift(); currentCallStarted = false;
    };
    try {
      await this.store.append('session_start', { queueSeq: input.seq }, event);
      if (this.ui.message) this.ui.message('user', input.text, this.sessionCounter);
      else this.ui.report(`\n请求 ${this.sessionCounter}：${input.text}`);
      for (round = 1; round <= c.execution.maxRounds; round++) {
        check(signal);
        this.ui.status(`Session ${this.sessionCounter} · Round ${round}/${c.execution.maxRounds}`);
        await this.store.append('round_start', {}, { ...event, round });
        let modelInput = await this.context.build(plan, signal, { ...event, round });
        let response;
        for (let repairs = 0; ; repairs++) {
          try { response = await this.requests.call(modelInput, signal, { ...event, round }, text => this.ui.stream?.(text, text === '')); break; }
          catch (e) {
            if (!(e instanceof ProviderError && e.contextOverflow) || repairs >= c.context.maxInputRepairsPerRound) throw e;
            modelInput = await this.context.build(plan, signal, { ...event, round }, true);
          }
        }
        this.ui.stream?.('', true);
        if (response.status !== 'completed') throw new Error(`模型响应${response.status === 'incomplete' ? '不完整' : '失败'}：${response.reason ?? ''}\n${response.text}`);
        if (!response.toolCalls.length && !response.text.trim()) throw new Error('模型返回空响应');
        block = { id: crypto.randomUUID(), kind: 'round', sessionId, items: [...response.protocolItems] };
        this.context.add(block);
        pending = [...response.toolCalls];
        check(signal);
        if (response.text) { if (this.ui.message) this.ui.message('assistant', response.text); else this.ui.report(response.text); }
        for (const call of response.toolCalls) {
          check(signal);
          this.ui.status(`Session ${this.sessionCounter} · Round ${round}/${c.execution.maxRounds} · ${call.name}`);
          await this.store.append('tool_call', { name: call.name, arguments: call.arguments }, { ...event, round, callId: call.id });
          currentCallStarted = false;
          const output = await executor.execute(call, { ...event, round, callId: call.id }, block.id, signal, () => { currentCallStarted = true; });
          await settle(call, output);
          if (this.ui.tool) this.ui.tool(call, output);
          else this.ui.report(`${call.name}${output.isError ? ' [错误]' : ''}：${output.content}`);
          check(signal);
        }
        await this.store.append('round_end', {}, { ...event, round });
        block = undefined;
        if (!response.toolCalls.length) { result = { status: 'completed', text: response.text }; break; }
        if (round === c.execution.maxRounds) throw new LimitError('已达到最大 Round 数；当前工具批次已结算，不再调用模型');
      }
    } catch (e) {
      if (e instanceof FatalError) fatal = e;
      const cause = signal.aborted ? signal.reason : e;
      result = { status: cause instanceof CancelledError ? 'cancelled' : cause instanceof LimitError ? 'limit_reached' : 'failed', text: message(cause) };
    } finally {
      clearTimeout(timer); this.ui.stream?.('', true);
      try {
        while (pending.length) {
          const call = pending[0]!;
          await settle(call, { content: currentCallStarted ? '调用已进入执行处理但结果无法确认，请检查实际状态；不会自动重试。' : 'Session 已结束，此调用未执行。', isError: true, code: currentCallStarted ? 'unknown' : 'not_executed' });
        }
        if (block) await this.store.append('round_end', { interrupted: true }, { ...event, round });
        this.context.add({ id: crypto.randomUUID(), kind: 'status', sessionId, items: [{ role: 'user', content: `[Harness execution status for previous request: ${result.status}] ${result.status === 'completed' ? '' : result.text}` }] });
        await this.store.append('session_end', { ...result, plan: plan ?? null }, event);
      } catch (e) { fatal = e; }
      if (this.ui.complete) this.ui.complete(result.status, result.text);
      else this.ui.report(`\n[${result.status}]${result.status === 'completed' ? ' 当前请求结束' : ` ${result.text}`}`);
      this.ui.status('空闲');
    }
    if (fatal) throw fatal;
    return result;
  }
}
