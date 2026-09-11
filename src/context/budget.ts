import { encodingForModel, type Tiktoken, type TiktokenModel } from 'js-tiktoken';
export class TokenBudget {
  private encoder?: Tiktoken;
  readonly exactTokenizer: boolean;
  constructor(model: string) {
    try { this.encoder = encodingForModel(model as TiktokenModel); } catch { /* Unknown model: conservative byte upper estimate. */ }
    this.exactTokenizer = !!this.encoder;
  }
  count(value: unknown): number {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!this.encoder) return Buffer.byteLength(text);
    return Math.ceil(this.encoder.encode(text, [], []).length * 1.1) + 32;
  }
}
