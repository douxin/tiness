import { test, expect } from 'bun:test';
import { OpenAIResponsesAdapter } from '../src/model/openai-responses';

test('Responses adapter sends stateless strict tools and retains reasoning/call IDs', async () => {
  let request: any;
  const output = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-example' }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}', status: 'completed' }];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    request = await req.json();
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const adapter = new OpenAIResponsesAdapter({ model: 'test', apiKey: 'test-only-key', baseUrl: `http://127.0.0.1:${server.port}/v1` });
    const result = await adapter.generate({ purpose: 'agent', instructions: 'test', items: [{ role: 'user', content: 'test' }], tools: [], maxOutputTokens: 100 }, new AbortController().signal);
    expect(request.store).toBe(false); expect(request.previous_response_id).toBeUndefined();
    expect(result.toolCalls[0]?.id).toBe('call_1'); expect(result.protocolItems[0]?.encrypted_content).toBe('encrypted-example');
  } finally { server.stop(true); }
});
