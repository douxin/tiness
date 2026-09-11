import type { ToolCall } from '../tools/types';
export type ProtocolItem = Record<string, any>;
export interface ModelInput { instructions: string; items: ProtocolItem[]; tools: Record<string, unknown>[]; maxOutputTokens: number; purpose: 'agent' | 'compaction' }
export interface ModelOutput { status: 'completed' | 'incomplete' | 'failed'; text: string; toolCalls: ToolCall[]; protocolItems: ProtocolItem[]; usage?: { inputTokens: number; outputTokens: number }; reason?: string }
export interface ModelAdapter { generate(input: ModelInput, signal: AbortSignal, onText?: (text: string) => void): Promise<ModelOutput> }
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string, readonly retryAfterMs?: number) { super(message); }
  get authentication() { return this.status === 401 || this.status === 403; }
  get contextOverflow() { return /context_length|context_window|input_too_long/.test(this.code ?? '') || /context (length|window)|maximum context/i.test(this.message); }
  get retryable() { return this.status === undefined || this.status === 408 || this.status === 429 || (this.status >= 500); }
}
export function validateProtocol(items: ProtocolItem[]): void {
  const calls = new Set<string>();
  const allCalls = new Set<string>();
  for (const item of items) {
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || allCalls.has(item.call_id)) throw new Error('协议中工具调用 ID 无效或重复');
      calls.add(item.call_id); allCalls.add(item.call_id);
    } else if (item.type === 'function_call_output') {
      if (!calls.delete(item.call_id)) throw new Error('协议中存在孤立或重复的工具结果');
    }
  }
  if (calls.size) throw new Error('协议中工具调用尚未结算');
}
