import type { RuntimeConfig } from '../config';
import type { TaskStore, EventContext } from '../storage/task-jsonl';
import { abortable, check, delay, FatalError, message, scopedSignal, TimeoutError } from '../errors';
import { ProviderError, type ModelAdapter, type ModelInput, type ModelOutput } from './types';

export class Requests {
  constructor(private model: ModelAdapter, private config: RuntimeConfig, private store: TaskStore, private report: (text: string) => void) {}
  async call(input: ModelInput, signal: AbortSignal, context: EventContext, onText?: (text: string) => void): Promise<ModelOutput> {
    const e = this.config.execution, summary = input.purpose === 'compaction';
    for (let attempt = 0; ; attempt++) {
      check(signal);
      await this.store.append('model_request', { purpose: input.purpose, attempt: attempt + 1, maxOutputTokens: input.maxOutputTokens }, context);
      let partialText = '';
      onText?.('');
      const operation = scopedSignal(signal, summary ? this.config.context.compactionTimeoutMs : e.modelTimeoutMs);
      try {
        const response = await abortable(this.model.generate(input, operation.signal, text => { if (!operation.signal.aborted) { partialText = Buffer.from(partialText + text).subarray(0, this.config.tools.resultMaxBytes).toString('utf8'); onText?.(text); } }), operation.signal);
        check(signal);
        await this.store.append('model_response', { purpose: input.purpose, attempt: attempt + 1, ...response }, context);
        return response;
      } catch (error) {
        check(signal);
        await this.store.append('model_error', { purpose: input.purpose, attempt: attempt + 1, error: message(error), partialText }, context);
        onText?.('');
        if (error instanceof FatalError) throw error;
        if (error instanceof ProviderError && error.authentication) throw new FatalError('模型鉴权失败，请检查用户级连接配置');
        if (error instanceof ProviderError && /invalid_function_parameters|invalid_json_schema|model_not_found/.test(error.code ?? ''))
          throw new FatalError('模型或工具 schema 配置不受端点支持，请检查连接与模型兼容性');
        const retryable = error instanceof TimeoutError || (error instanceof ProviderError && error.retryable && !error.contextOverflow);
        if (summary || !retryable || attempt >= e.modelMaxRetries) throw error;
        this.report(`模型请求暂时失败，准备第 ${attempt + 1} 次重试；此前未完整输出不会被执行。`);
        const wait = error instanceof ProviderError && error.retryAfterMs !== undefined ? error.retryAfterMs : e.retryBaseDelayMs * 2 ** attempt;
        await delay(Math.min(wait, e.retryMaxDelayMs), signal);
      } finally { operation.dispose(); }
    }
  }
}
