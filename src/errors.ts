export class FatalError extends Error {}
export class LimitError extends Error {}
export class CancelledError extends Error {}
export class TimeoutError extends Error {}
export class ToolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function check(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new CancelledError('已取消');
}
export function scopedSignal(parent: AbortSignal, ms: number, reason: Error = new TimeoutError('操作超时')) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(() => controller.abort(reason), Math.max(1, ms));
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new CancelledError('已取消'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
export function redact(text: string, secrets: string[] = []): string {
  for (const secret of secrets) if (secret.length) text = text.split(secret).join('[REDACTED]');
  return text;
}
// Terminal output is untrusted, including model text and filenames.
export function plain(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

export function redactValue<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)])) as T;
  return value;
}
