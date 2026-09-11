import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { Response, ResponseInputItem, ResponseOutputItem, Tool } from 'openai/resources/responses/responses';
import type { Connection } from '../config';
import { check, redactValue } from '../errors';
import { ProviderError, validateProtocol, type ModelAdapter, type ModelInput, type ModelOutput } from './types';

export class OpenAIResponsesAdapter implements ModelAdapter {
  private client: OpenAI;
  constructor(private connection: Connection) {
    this.client = new OpenAI({ apiKey: connection.apiKey, baseURL: connection.baseUrl, maxRetries: 0 });
  }
  async generate(input: ModelInput, signal: AbortSignal, onText?: (text: string) => void): Promise<ModelOutput> {
    check(signal); input = redactValue(input, [this.connection.apiKey]); validateProtocol(input.items);
    let response: Response | undefined;
    try {
      const stream = await this.client.responses.create({
        model: this.connection.model, instructions: input.instructions,
        input: toResponseInputItems(input.items as ResponseInputItem[]),
        tools: input.tools as unknown as Tool[], max_output_tokens: input.maxOutputTokens,
        store: false, include: ['reasoning.encrypted_content'], stream: true,
      }, { signal });
      for await (const event of stream) {
        check(signal);
        if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') onText?.(event.delta);
        if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') response = event.response;
        if (event.type === 'error') throw new ProviderError(event.message, undefined, event.code ?? undefined);
      }
      check(signal);
      if (!response) throw new ProviderError('模型传输中断，未收到完整响应');
      const text = response.output.filter(x => x.type === 'message').flatMap(x => x.content)
        .map(x => x.type === 'output_text' ? x.text : x.type === 'refusal' ? x.refusal : '').join('');
      const calls = response.output.filter(x => x.type === 'function_call').map(x => ({ id: x.call_id, name: x.name, arguments: x.arguments }));
      if (new Set(calls.map(c => c.id)).size !== calls.length) throw new ProviderError('响应包含重复调用 ID', 400, 'invalid_response');
      if (response.output.some(x => !['message', 'function_call', 'reasoning'].includes(x.type)))
        throw new ProviderError('响应包含本版不支持的协议项', 400, 'invalid_response');
      const status = response.status === 'completed' ? 'completed' : response.status === 'incomplete' ? 'incomplete' : 'failed';
      return { status, text, toolCalls: calls, protocolItems: toResponseInputItems(response.output as ResponseOutputItem[]) as Record<string, any>[],
        usage: response.usage ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } : undefined,
        reason: response.error?.message ?? response.incomplete_details?.reason ?? undefined };
    } catch (e: any) {
      check(signal);
      if (e instanceof ProviderError) throw e;
      const header = e.headers?.get?.('retry-after');
      const wait = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now())) : undefined;
      throw new ProviderError(e.message ?? '模型请求失败', e.status, e.code, Number.isFinite(wait) ? wait : undefined);
    }
  }
}
